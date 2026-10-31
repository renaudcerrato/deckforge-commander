import test from 'node:test';
import assert from 'node:assert/strict';
import * as releaseScript from '../scripts/release.mjs';
import { MANIFEST, INSTALLER, parseVersion, compareVersions, planRelease, createGitHub, prepareDraft } from '../scripts/release.mjs';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const VERSION = '0.1.1.0';
const TAG = `v${VERSION}`;
const ASSET_PATH = `dist/${INSTALLER}`;

function planning({ baseline = '0.1.0.0', current = VERSION } = {}) {
  const calls = [];
  const snapshots = new Map([
    [`${BASE}:${MANIFEST}`, JSON.stringify({ Version: baseline })],
    [`${SHA}:${MANIFEST}`, JSON.stringify({ Version: current })],
    [`${HEAD}:${MANIFEST}`, JSON.stringify({ Version: current })],
  ]);
  return {
    calls, snapshots,
    input: {
      eventName: 'push', ref: 'refs/heads/main', event: { ref: 'refs/heads/main', before: BASE, after: SHA }, sha: SHA,
      git: async args => {
        calls.push(args);
        assert.equal(args[0], 'show');
        if (!snapshots.has(args[1])) throw new Error('Snapshot unavailable');
        return snapshots.get(args[1]);
      },
    },
  };
}

// RELEASE-1: exact four-part numeric versions, without lexical or Number precision loss.
test('four numeric components retain arbitrary integer precision', () => {
  // Arrange
  const version = '000.1.9007199254740993.0';
  // Act
  const result = parseVersion(version);
  // Assert
  assert.deepEqual(result, [0n, 1n, 9007199254740993n, 0n]);
});

for (const version of [undefined, null, 1234, {}, '', '1.2.3', '1.2.3.4.5', 'v1.2.3.4', '1.-2.3.4', '1.2.3.4-beta', '1.2.3.4\n', ' 1.2.3.4', '1.2.3.x']) {
  test(`invalid manifest version is rejected: ${JSON.stringify(version)}`, () => {
    // Arrange
    const input = version;
    // Act / Assert
    assert.throws(() => parseVersion(input), /four numeric components/);
  });
}

for (const [current, baseline, expected] of [
  ['0.10.0.0', '0.9.99.99', 1], ['1.0.0.0', '0.99.99.99', 1],
  ['0.1.10.0', '0.1.9.99', 1], ['0.1.1.10', '0.1.1.9', 1],
  ['0.1.1.9', '0.1.1.10', -1], ['0.1.1.0', '0.1.1.0', 0],
  ['00.01.01.00', '0.1.1.0', 0],
  ['0.0.0.9007199254740993', '0.0.0.9007199254740992', 1],
]) {
  test(`version comparison ${current} against ${baseline} is ${expected}`, () => {
    // Arrange
    const versions = [current, baseline];
    // Act
    const result = compareVersions(...versions);
    // Assert
    assert.equal(result, expected);
  });
}

for (const versions of [['invalid', VERSION], [VERSION, 'invalid']]) {
  test(`comparison rejects invalid ${versions[0] === 'invalid' ? 'current' : 'baseline'} version`, () => {
    // Arrange
    const input = versions;
    // Act / Assert
    assert.throws(() => compareVersions(...input), /four numeric components/);
  });
}

// RELEASE-1: validate PR snapshots, but only an increased main push is release eligible.
for (const current of [VERSION, '0.1.0.0']) {
  test(`main push ${current} uses before and the exact tested SHA`, async () => {
    // Arrange
    const { input, calls } = planning({ current });
    // Act
    const result = await planRelease(input);
    // Assert
    assert.deepEqual(result, { version: current, sha: SHA, release: current === VERSION });
    assert.deepEqual(calls, [['show', `${BASE}:${MANIFEST}`], ['show', `${SHA}:${MANIFEST}`]]);
  });
  test(`PR ${current} validates base/head without permitting release`, async () => {
    // Arrange
    const { input, calls } = planning({ current });
    input.eventName = 'pull_request';
    input.event = { pull_request: { base: { sha: BASE }, head: { sha: HEAD } } };
    // Act
    const result = await planRelease(input);
    // Assert
    assert.deepEqual(result, { version: current, sha: SHA, release: false });
    assert.deepEqual(calls, [['show', `${BASE}:${MANIFEST}`], ['show', `${HEAD}:${MANIFEST}`]]);
  });
}

for (const eventName of ['push', 'pull_request']) {
  test(`${eventName} rejects a decreased version`, async () => {
    // Arrange
    const { input } = planning({ current: '0.0.99.99' });
    input.eventName = eventName;
    if (eventName === 'pull_request') input.event = { pull_request: { base: { sha: BASE }, head: { sha: HEAD } } };
    // Act / Assert
    await assert.rejects(() => planRelease(input), /must not decrease/);
  });
}

for (const [name, change, error] of [
  ['non-main push', input => { input.event.ref = 'refs/heads/feature'; }, /Only pull requests/],
  ['deleted main', input => { input.event.deleted = true; }, /Only pull requests/],
  ['other event', input => { input.eventName = 'schedule'; }, /supported|Only pull requests/],
  ['mismatched push', input => { input.event.after = OTHER; }, /tested SHA/],
  ['missing baseline', input => { delete input.event.before; }, /full commit SHA/],
  ['zero baseline', input => { input.event.before = '0'.repeat(40); }, /full commit SHA/],
  ['abbreviated baseline', input => { input.event.before = BASE.slice(0, 7); }, /full commit SHA/],
  ['unusable tested SHA', input => { input.sha = '0'.repeat(40); }, /full commit SHA/],
  ['missing PR head', input => { input.eventName = 'pull_request'; input.event = { pull_request: { base: { sha: BASE } } }; }, /full commit SHA/],
  ['missing PR base', input => { input.eventName = 'pull_request'; input.event = { pull_request: { head: { sha: HEAD } } }; }, /full commit SHA/],
]) {
  test(`${name} fails closed before reading snapshots`, async () => {
    // Arrange
    const { input, calls } = planning();
    change(input);
    // Act / Assert
    await assert.rejects(() => planRelease(input), error);
    assert.deepEqual(calls, []);
  });
}

for (const ref of [BASE, SHA]) {
  for (const content of [undefined, '{', '{}', '{"Version":"0.1.0"}']) {
    test(`unavailable or invalid ${ref === BASE ? 'baseline' : 'current'} snapshot fails safe (${String(content)})`, async () => {
      // Arrange
      const { input, snapshots } = planning();
      snapshots.delete(`${ref}:${MANIFEST}`);
      if (content !== undefined) snapshots.set(`${ref}:${MANIFEST}`, content);
      // Act / Assert
      await assert.rejects(() => planRelease(input));
    });
  }
}

function httpFixture(status = 200, data = { id: 7 }) {
  const calls = [];
  const request = createGitHub({ repository: 'example/plugin', token: 'test-only-token', fetchImpl: async (url, options) => {
    calls.push({ url: url.href, ...options });
    return { status, ok: status >= 200 && status < 300, json: async () => data };
  } });
  return { request, calls, data };
}

// RELEASE-1: authenticated API errors are not evidence of an absent release/tag.
test('GitHub requests authenticate, reject redirects, and send JSON to the repository endpoint', async () => {
  // Arrange
  const { request, calls, data } = httpFixture();
  // Act
  const result = await request('POST', 'releases', { body: { draft: true } });
  // Assert
  assert.equal(result, data);
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/plugin/releases');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-only-token');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { draft: true });
});

test('binary installer uploads preserve bytes at the allowed upload boundary', async () => {
  // Arrange
  const { request, calls } = httpFixture();
  const bytes = Buffer.from([0, 255, 42]);
  // Act
  await request('POST', 'https://uploads.github.com/repos/example/plugin/releases/7/assets?name=installer', { body: bytes, binary: true });
  // Assert
  assert.equal(calls[0].body, bytes);
  assert.equal(calls[0].headers['Content-Type'], 'application/octet-stream');
});

test('only explicitly allowed missing references return absence', async () => {
  // Arrange
  const { request } = httpFixture(404);
  // Act
  const result = await request('GET', `git/ref/tags/${TAG}`, { missing: true });
  // Assert
  assert.equal(result, null);
});

for (const [status, missing] of [[401, true], [403, true], [429, true], [500, true], [404, false], [302, true]]) {
  test(`GitHub HTTP ${status} (missing=${missing}) remains a failure`, async () => {
    // Arrange
    const { request } = httpFixture(status);
    // Act / Assert
    await assert.rejects(() => request('GET', 'releases', { missing }), new RegExp(`HTTP ${status}`));
  });
}

for (const failure of ['transport', 'response decoding']) {
  test(`GitHub ${failure} failures propagate unchanged`, async () => {
    // Arrange
    const error = new Error(failure);
    const request = createGitHub({ repository: 'example/plugin', token: 'test-only-token', fetchImpl: async () => {
      if (failure === 'transport') throw error;
      return { ok: true, status: 200, json: async () => { throw error; } };
    } });
    // Act / Assert
    await assert.rejects(() => request('GET', 'releases', { missing: true }), actual => actual === error);
  });
}

for (const config of [{ repository: '../plugin', token: 'test' }, { repository: 'example/plugin' }, { token: 'test' }]) {
  test(`missing or invalid API configuration is rejected (${JSON.stringify(config)})`, () => {
    // Arrange
    const options = { ...config, fetchImpl: async () => { assert.fail('Must not make a request'); } };
    // Act / Assert
    assert.throws(() => createGitHub(options), /repository and GH_TOKEN/);
  });
}

for (const destination of ['https://untrusted.example/upload', 'https://api.github.com.untrusted.example/upload', 'https://api.github.com:444/upload']) {
  test(`credentials are not sent to an unexpected destination ${destination}`, async () => {
    // Arrange
    const { request, calls } = httpFixture();
    // Act / Assert
    await assert.rejects(() => request('POST', destination), /Unexpected GitHub API destination/);
    assert.deepEqual(calls, []);
  });
}

function draftFixture({ existing = null, tag = null, pages, assetPages = [[]], freshRelease,
  uploadResponse = { id: 8, name: INSTALLER, state: 'uploaded', size: 19 },
  failureAt, assetError, asset = Buffer.from('synthetic installer') } = {}) {
  const calls = [], reads = [];
  const failure = new Error('Synthetic boundary failure');
  let reference = tag;
  const github = async (method, endpoint, options) => {
    calls.push({ method, endpoint, options });
    if (failureAt === endpoint) throw failure;
    if (endpoint.startsWith('releases?')) {
      const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
      return pages?.[page - 1] ?? (existing ? [existing] : []);
    }
    if (endpoint.startsWith('releases/7/assets?')) {
      const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
      return assetPages[page - 1] ?? [];
    }
    if (endpoint === 'releases/7' && method === 'GET') return freshRelease ?? existing;
    if (endpoint === `git/ref/tags/${TAG}`) return reference;
    if (endpoint === `git/tags/${OTHER}`) return { object: { type: 'commit', sha: SHA } };
    if (endpoint === 'git/refs' && method === 'POST') {
      reference = { object: { type: 'commit', sha: options.body.sha } };
      return {};
    }
    if (endpoint === 'releases' && method === 'POST') return { id: 7, draft: true, tag_name: TAG, upload_url: 'https://uploads.github.com/repos/example/plugin/releases/7/assets{?name,label}' };
    if (endpoint.startsWith('https://uploads.github.com/')) return uploadResponse;
    assert.fail(`Unexpected synthetic API request: ${method} ${endpoint}`);
  };
  return {
    calls, reads, failure, asset,
    input: { version: VERSION, sha: SHA, assetPath: ASSET_PATH, github, readAsset: async path => {
      reads.push(path);
      if (assetError) throw assetError;
      return asset;
    } },
  };
}

// RELEASE-1: create only an unpublished draft pinned to tested code, with the installer.
test('new draft uses full version tag, tested SHA, generated notes and exact installer bytes', async () => {
  // Arrange
  const { input, calls, reads, asset } = draftFixture();
  // Act
  const result = await prepareDraft(input);
  // Assert
  assert.deepEqual(result, { status: 'created', tag: TAG });
  assert.deepEqual(reads, [ASSET_PATH]);
  const writes = calls.filter(call => call.method === 'POST');
  assert.deepEqual(writes[0], { method: 'POST', endpoint: 'git/refs', options: { body: { ref: `refs/tags/${TAG}`, sha: SHA } } });
  assert.deepEqual(writes[1], { method: 'POST', endpoint: 'releases', options: { body: {
    tag_name: TAG, target_commitish: SHA, name: TAG, draft: true, generate_release_notes: true,
  } } });
  const upload = new URL(writes[2].endpoint);
  assert.equal(upload.origin, 'https://uploads.github.com');
  assert.equal(upload.searchParams.get('name'), INSTALLER);
  assert.equal(writes[2].options.body, asset);
  assert.equal(writes[2].options.binary, true);
  assert.equal(writes.length, 3);
});

for (const draft of [true, false]) {
  test(`existing ${draft ? 'complete draft' : 'published release'} is reported without writes or local asset reads`, async () => {
    // Arrange
    const complete = { name: INSTALLER, state: 'uploaded', size: 42 };
    const { input, calls, reads } = draftFixture({ existing: existingRelease({ draft }), assetPages: [[complete]], tag: { object: { type: 'commit', sha: SHA } } });
    // Act
    const result = await prepareDraft(input);
    // Assert
    assert.deepEqual(result, { status: 'exists', tag: TAG });
    assert.deepEqual(reads, []);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

test('existing complete draft is found beyond the first release page', async () => {
  // Arrange
  const existing = existingRelease();
  const { input, calls } = draftFixture({ existing, tag: { object: { type: 'commit', sha: SHA } }, assetPages: [[{ name: INSTALLER, state: 'uploaded', size: 42 }]], pages: [Array.from({ length: 100 }, (_, index) => ({ tag_name: `other-${index}` })), [existing]] });
  // Act
  const result = await prepareDraft(input);
  // Assert
  assert.equal(result.status, 'exists');
  assert.equal(calls.some(call => call.endpoint === 'releases?per_page=100&page=2'), true);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

for (const type of ['commit', 'tag']) {
  test(`existing ${type === 'commit' ? 'lightweight' : 'annotated'} tag at tested SHA is reused, not moved`, async () => {
    // Arrange
    const { input, calls } = draftFixture({ tag: { object: { type, sha: type === 'commit' ? SHA : OTHER } } });
    // Act
    const result = await prepareDraft(input);
    // Assert
    assert.equal(result.status, 'created');
    assert.equal(calls.some(call => call.endpoint === 'git/refs' && call.method === 'POST'), false);
    assert.equal(calls.some(call => ['PATCH', 'DELETE'].includes(call.method)), false);
  });
}

for (const existing of [null, { tag_name: TAG, draft: true }]) {
  test(`conflicting lightweight tag fails without mutation (${existing ? 'existing draft' : 'new draft'})`, async () => {
    // Arrange
    const { input, calls, reads } = draftFixture({ existing, tag: { object: { type: 'commit', sha: OTHER } } });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input), /does not resolve to the tested SHA/);
    assert.deepEqual(reads, []);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

test('annotated tag resolving to another commit is rejected without mutation', async () => {
  // Arrange
  const { input, calls } = draftFixture({ tag: { object: { type: 'tag', sha: OTHER } } });
  const github = input.github;
  input.github = async (...args) => args[1] === `git/tags/${OTHER}` ? { object: { type: 'commit', sha: HEAD } } : github(...args);
  // Act / Assert
  await assert.rejects(() => prepareDraft(input), /does not resolve to the tested SHA/);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

test('cyclic annotated tags fail in bounded requests without mutation', async () => {
  // Arrange
  const { input, calls } = draftFixture({ tag: { object: { type: 'tag', sha: OTHER } } });
  const github = input.github;
  let resolutions = 0;
  input.github = async (...args) => {
    if (args[1] === `git/tags/${OTHER}`) { resolutions++; return { object: { type: 'tag', sha: OTHER } }; }
    return github(...args);
  };
  // Act / Assert
  await assert.rejects(() => prepareDraft(input), /does not resolve to the tested SHA/);
  assert.ok(resolutions > 0 && resolutions <= 16);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

for (const asset of [Buffer.alloc(0), null]) {
  test(`${asset === null ? 'missing' : 'empty'} installer prevents tag and draft creation`, async () => {
    // Arrange
    const missing = new Error('Synthetic missing installer');
    const { input, calls } = draftFixture(asset === null ? { assetError: missing } : { asset });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input), asset === null ? actual => actual === missing : /installer is empty/);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

for (const endpoint of ['releases?per_page=100&page=1', `git/ref/tags/${TAG}`, 'git/refs', 'releases', `https://uploads.github.com/repos/example/plugin/releases/7/assets?name=${INSTALLER}`]) {
  test(`failure at ${endpoint} propagates instead of reporting success`, async () => {
    // Arrange
    const { input, calls, failure } = draftFixture({ failureAt: endpoint });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input), actual => actual === failure);
    assert.equal(calls.at(-1).endpoint, endpoint);
  });
}

test('tag lost after creation prevents draft creation', async () => {
  // Arrange
  const { input, calls } = draftFixture();
  const github = input.github;
  input.github = async (...args) => {
    const result = await github(...args);
    return args[1] === `git/ref/tags/${TAG}` ? null : result;
  };
  // Act / Assert
  await assert.rejects(() => prepareDraft(input), /Release tag is missing/);
  assert.equal(calls.some(call => call.endpoint === 'releases' && call.method === 'POST'), false);
});

for (const override of [{ version: '0.1.1' }, { sha: SHA.slice(0, 7) }]) {
  test(`invalid draft input fails before external boundaries (${JSON.stringify(override)})`, async () => {
    // Arrange
    const { input, calls, reads } = draftFixture();
    Object.assign(input, override);
    // Act / Assert
    await assert.rejects(() => prepareDraft(input));
    assert.deepEqual(calls, []);
    assert.deepEqual(reads, []);
  });
}

// DRAFT-RECOVERY: manual main runs use the tested snapshot, not an invented baseline.
test('main dispatch is release eligible using only the tested manifest', async () => {
  // Arrange
  const { input, calls } = planning();
  input.eventName = 'workflow_dispatch';
  input.event = {};
  // Act
  const result = await planRelease(input);
  // Assert
  assert.deepEqual(result, { version: VERSION, sha: SHA, release: true });
  assert.deepEqual(calls, [['show', `${SHA}:${MANIFEST}`]]);
});

for (const ref of [undefined, 'refs/heads/feature', `refs/tags/${TAG}`]) {
  test(`dispatch rejects explicit non-main or missing ref (${ref}) before reading Git`, async () => {
    // Arrange
    const { input, calls } = planning();
    Object.assign(input, { eventName: 'workflow_dispatch', ref, event: { ref: 'refs/heads/main' } });
    // Act / Assert
    await assert.rejects(() => planRelease(input));
    assert.deepEqual(calls, []);
  });
}

for (const content of [undefined, '{', '{}', '{"Version":"1.2.3"}']) {
  test(`dispatch rejects unavailable or invalid tested manifest (${content})`, async () => {
    // Arrange
    const { input, snapshots } = planning();
    Object.assign(input, { eventName: 'workflow_dispatch', event: {} });
    snapshots.delete(`${SHA}:${MANIFEST}`);
    if (content !== undefined) snapshots.set(`${SHA}:${MANIFEST}`, content);
    // Act / Assert
    await assert.rejects(() => planRelease(input));
  });
}

// DRAFT-RECOVERY: the command guard must enforce identity independently of the workflow.
for (const eventName of ['push', 'workflow_dispatch']) {
  test(`draft context accepts ${eventName} on main at the tested checkout`, () => {
    // Arrange
    const input = { eventName, ref: 'refs/heads/main', sha: SHA, checkoutSha: SHA };
    // Act / Assert
    assert.doesNotThrow(() => releaseScript.validateDraftContext(input));
  });
}

for (const override of [
  { eventName: 'pull_request' }, { eventName: 'schedule' },
  { ref: 'refs/heads/feature' }, { ref: `refs/tags/${TAG}` }, { ref: undefined },
  { checkoutSha: OTHER }, { sha: '0'.repeat(40) },
]) {
  test(`draft context rejects unauthorized event/ref or checkout (${JSON.stringify(override)})`, () => {
    // Arrange
    const input = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', sha: SHA, checkoutSha: SHA, ...override };
    // Act / Assert
    assert.equal(typeof releaseScript.validateDraftContext, 'function');
    assert.throws(() => releaseScript.validateDraftContext(input));
  });
}

function existingRelease(overrides = {}) {
  return { id: 7, tag_name: TAG, draft: true,
    upload_url: 'https://uploads.github.com/repos/example/plugin/releases/7/assets{?name,label}', ...overrides };
}

function recoveryFixture(options = {}) {
  return draftFixture({ existing: existingRelease(), tag: { object: { type: 'commit', sha: SHA } }, ...options });
}

test('missing installer recovery paginates assets and rechecks release and tag before exact-byte upload', async () => {
  // Arrange
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}`, state: 'uploaded', size: 1 }));
  const { input, calls, reads, asset } = recoveryFixture({ assetPages: [unrelated, []] });
  // Act
  const result = await prepareDraft(input);
  // Assert
  assert.equal(result.tag, TAG);
  assert.deepEqual(reads, [ASSET_PATH]);
  const writes = calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(new URL(writes[0].endpoint).searchParams.get('name'), INSTALLER);
  assert.equal(writes[0].options.body, asset);
  assert.equal(writes[0].options.binary, true);
  const page = calls.findIndex(call => call.endpoint === 'releases/7/assets?per_page=100&page=2');
  const fresh = calls.findIndex(call => call.endpoint === 'releases/7');
  const upload = calls.indexOf(writes[0]);
  assert.ok(page >= 0 && fresh > page && upload > fresh);
  assert.ok(calls.slice(fresh + 1, upload).some(call => call.endpoint === `git/ref/tags/${TAG}`));
});

test('complete installer on a later asset page is retained without local reads or writes', async () => {
  // Arrange
  const { input, calls, reads } = recoveryFixture({ assetPages: [
    Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}` })),
    [{ name: INSTALLER, state: 'uploaded', size: 1 }],
  ] });
  // Act
  await prepareDraft(input);
  // Assert
  assert.ok(calls.some(call => call.endpoint === 'releases/7/assets?per_page=100&page=2'));
  assert.deepEqual(reads, []);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

for (const draft of [true, false]) {
  test(`existing ${draft ? 'draft' : 'published release'} with missing tag fails without recreating it`, async () => {
    // Arrange
    const { input, calls } = recoveryFixture({ existing: existingRelease({ draft }), tag: null });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input));
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

for (const assets of [
  [{ name: INSTALLER, state: 'starter', size: 1 }],
  [{ name: INSTALLER, state: 'uploaded', size: 0 }],
  [{ name: INSTALLER, state: 'uploaded' }],
  [{ name: INSTALLER, state: 'uploaded', size: 1 }, { name: INSTALLER, state: 'uploaded', size: 2 }],
]) {
  test(`incomplete or duplicate installer assets fail without mutation (${JSON.stringify(assets)})`, async () => {
    // Arrange
    const { input, calls, reads } = recoveryFixture({ assetPages: [assets] });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input));
    assert.deepEqual(reads, []);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

test('duplicate installer across asset pages is not mistaken for a complete draft', async () => {
  // Arrange
  const complete = { name: INSTALLER, state: 'uploaded', size: 1 };
  const { input, calls } = recoveryFixture({ assetPages: [
    [complete, ...Array.from({ length: 99 }, (_, index) => ({ name: `other-${index}` }))], [complete],
  ] });
  // Act / Assert
  await assert.rejects(() => prepareDraft(input));
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

for (const change of ['published', 'retagged', 'tag missing', 'tag moved']) {
  test(`observed ${change} during recovery prevents upload`, async () => {
    // Arrange
    const { input, calls } = recoveryFixture({ freshRelease: existingRelease(
      change === 'published' ? { draft: false } : change === 'retagged' ? { tag_name: 'v9.9.9.9' } : {},
    ) });
    const github = input.github;
    let freshRead = false;
    input.github = async (...args) => {
      const result = await github(...args);
      if (args[1] === 'releases/7') freshRead = true;
      if (freshRead && args[1] === `git/ref/tags/${TAG}`) {
        if (change === 'tag missing') return null;
        if (change === 'tag moved') return { object: { type: 'commit', sha: OTHER } };
      }
      return result;
    };
    // Act / Assert
    await assert.rejects(() => prepareDraft(input));
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

for (const endpoint of ['releases/7/assets?per_page=100&page=1', 'releases/7',
  `https://uploads.github.com/repos/example/plugin/releases/7/assets?name=${INSTALLER}`]) {
  test(`recovery boundary failure at ${endpoint} is not success`, async () => {
    // Arrange
    const { input, failure } = recoveryFixture({ failureAt: endpoint });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input), actual => actual === failure);
  });
}

for (const asset of [Buffer.alloc(0), null]) {
  test(`recovery rejects ${asset === null ? 'missing' : 'empty'} local installer without remote mutation`, async () => {
    // Arrange
    const missing = new Error('Synthetic missing recovery installer');
    const { input, calls } = recoveryFixture(asset === null ? { assetError: missing } : { asset });
    // Act / Assert
    await assert.rejects(() => prepareDraft(input));
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

for (const existing of [null, existingRelease()]) {
  for (const uploadResponse of [undefined, {}, { name: 'wrong', state: 'uploaded', size: 1 },
    { name: INSTALLER, state: 'starter', size: 1 }, { name: INSTALLER, state: 'uploaded', size: 0 },
    { name: INSTALLER, state: 'uploaded' }]) {
    test(`${existing ? 'recovered' : 'new'} draft rejects incomplete upload receipt (${JSON.stringify(uploadResponse)})`, async () => {
      // Arrange
      const { input } = draftFixture({ existing, tag: { object: { type: 'commit', sha: SHA } }, uploadResponse: uploadResponse ?? null });
      // Act / Assert
      await assert.rejects(() => prepareDraft(input));
    });
  }
}
