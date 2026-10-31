import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const MANIFEST = 'git.renaudcerrato.deckforge.sdPlugin/manifest.json';
export const INSTALLER = 'git.renaudcerrato.deckforge.streamDeckPlugin';

export function parseVersion(version) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
        throw new Error('Manifest Version must have four numeric components.');
    }
    return version.split('.').map(BigInt);
}

export function compareVersions(current, baseline) {
    const left = parseVersion(current), right = parseVersion(baseline);
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

function requireSha(sha) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) {
        throw new Error('A usable full commit SHA is required.');
    }
    return sha;
}

function manifestVersion(text) {
    const version = JSON.parse(text).Version;
    parseVersion(version);
    return version;
}

// git(args) returns stdout; missing commits/manifests must reject, not guess a baseline.
export async function planRelease({ eventName, ref, event, sha, git }) {
    requireSha(sha);
    if (eventName === 'workflow_dispatch' && ref === 'refs/heads/main') {
        const version = manifestVersion(await git(['show', `${sha}:${MANIFEST}`]));
        return { version, sha, release: true };
    }
    let base, head;
    if (eventName === 'pull_request') {
        base = event.pull_request?.base?.sha;
        head = event.pull_request?.head?.sha;
    } else if (eventName === 'push' && ref === 'refs/heads/main' && event.ref === ref && !event.deleted) {
        base = event.before;
        head = sha;
        if (event.after !== sha) throw new Error('Push head does not match the tested SHA.');
    } else {
        throw new Error('Only pull requests, pushes to main and manual dispatches on main are supported.');
    }
    requireSha(base);
    requireSha(head);
    const baseline = manifestVersion(await git(['show', `${base}:${MANIFEST}`]));
    const version = manifestVersion(await git(['show', `${head}:${MANIFEST}`]));
    const comparison = compareVersions(version, baseline);
    if (comparison < 0) throw new Error('Manifest Version must not decrease.');
    return { version, sha, release: eventName === 'push' && comparison > 0 };
}

export function validateDraftContext({ eventName, ref, sha, checkoutSha }) {
    requireSha(sha);
    if (!['push', 'workflow_dispatch'].includes(eventName) || ref !== 'refs/heads/main') {
        throw new Error('Draft preparation requires a push or manual dispatch on main.');
    }
    if (checkoutSha !== sha) throw new Error('Checkout is not the tested SHA.');
}

// The request boundary rejects all API errors except an explicitly allowed missing ref.
export function createGitHub({ repository, token, fetchImpl = fetch }) {
    if (!/^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(repository ?? '') || !token) {
        throw new Error('GitHub repository and GH_TOKEN are required.');
    }
    return async function request(method, endpoint, { body, missing = false, binary = false } = {}) {
        const url = endpoint.startsWith('https://')
            ? new URL(endpoint) : new URL(`https://api.github.com/repos/${repository}/${endpoint}`);
        if (url.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(url.host)) {
            throw new Error('Unexpected GitHub API destination.');
        }
        const response = await fetchImpl(url, {
            method,
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2026-03-10',
                ...(body === undefined ? {} : {
                    'Content-Type': binary ? 'application/octet-stream' : 'application/json',
                }),
            },
            body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
        });
        if (missing && response.status === 404) return null;
        if (!response.ok) throw new Error(`GitHub ${method} request failed (HTTP ${response.status}).`);
        return response.json();
    };
}

async function findRelease(github, tag) {
    // Unlike the published-release-by-tag endpoint, this also finds incomplete drafts.
    for (let page = 1; ; page++) {
        const releases = await github('GET', `releases?per_page=100&page=${page}`);
        const existing = releases.find(release => release.tag_name === tag);
        if (existing) return existing;
        if (releases.length < 100) return null;
    }
}

async function verifyTag(github, tag, sha) {
    const reference = await github('GET', `git/ref/tags/${tag}`, { missing: true });
    if (!reference) return false;
    let object = reference.object;
    for (let depth = 0; object.type === 'tag' && depth < 16; depth++) {
        requireSha(object.sha);
        object = (await github('GET', `git/tags/${object.sha}`)).object;
    }
    if (object.type !== 'commit' || object.sha !== sha) {
        throw new Error(`Existing tag ${tag} does not resolve to the tested SHA.`);
    }
    return true;
}

function isCompleteAsset(asset) {
    return asset?.name === INSTALLER && asset.state === 'uploaded'
        && Number.isSafeInteger(asset.size) && asset.size > 0;
}

async function hasInstaller(github, release) {
    let installer;
    for (let page = 1; ; page++) {
        const assets = await github('GET', `releases/${release.id}/assets?per_page=100&page=${page}`);
        for (const asset of assets) {
            if (asset?.name !== INSTALLER) continue;
            if (installer || !isCompleteAsset(asset)) {
                throw new Error('Draft installer assets are duplicate or incomplete; left unchanged.');
            }
            installer = asset;
        }
        if (assets.length < 100) return Boolean(installer);
    }
}

function validateDraft(release, tag, id = release?.id) {
    if (!Number.isSafeInteger(id) || id <= 0 || release?.id !== id
        || release.tag_name !== tag || release.draft !== true) {
        throw new Error('Release is no longer the matching unpublished draft.');
    }
}

async function uploadInstaller(github, release, asset) {
    const upload = new URL(release.upload_url.replace(/\{.*\}$/, ''));
    upload.searchParams.set('name', INSTALLER);
    const receipt = await github('POST', upload.href, { body: asset, binary: true });
    if (!isCompleteAsset(receipt) || receipt.size !== asset.length) {
        throw new Error('Installer upload did not return a complete matching receipt.');
    }
}

async function recoverDraft({ existing, tag, sha, assetPath, github, readAsset }) {
    if (existing.draft === false) return { status: 'exists', tag };
    validateDraft(existing, tag);
    if (await hasInstaller(github, existing)) return { status: 'exists', tag };
    const asset = await readAsset(assetPath);
    if (!asset.length) throw new Error('The tested installer is empty.');
    const fresh = await github('GET', `releases/${existing.id}`);
    validateDraft(fresh, tag, existing.id);
    if (!await verifyTag(github, tag, sha)) throw new Error('Release tag is missing.');
    await uploadInstaller(github, fresh, asset);
    return { status: 'recovered', tag };
}

// github(method, endpoint, options) and readAsset(path) are injectable I/O boundaries.
export async function prepareDraft({ version, sha, assetPath, github, readAsset = readFile }) {
    parseVersion(version);
    requireSha(sha);
    const tag = `v${version}`;
    // A failed list request (including auth/permission errors) cannot mean "not found".
    const existing = await findRelease(github, tag);
    const tagExists = await verifyTag(github, tag, sha);
    if (existing) {
        if (!tagExists) throw new Error('Release tag is missing.');
        return recoverDraft({ existing, tag, sha, assetPath, github, readAsset });
    }
    const asset = await readAsset(assetPath);
    if (!asset.length) throw new Error('The tested installer is empty.');
    if (!tagExists) {
        await github('POST', 'git/refs', { body: { ref: `refs/tags/${tag}`, sha } });
    }
    if (!await verifyTag(github, tag, sha)) throw new Error('Release tag is missing.');
    const release = await github('POST', 'releases', {
        body: { tag_name: tag, target_commitish: sha, name: tag, draft: true, generate_release_notes: true },
    });
    validateDraft(release, tag);
    if (!await verifyTag(github, tag, sha)) throw new Error('Release tag is missing.');
    await uploadInstaller(github, release, asset);
    return { status: 'created', tag };
}

async function main() {
    const execute = promisify(execFile);
    const git = async args => (await execute('git', args)).stdout.trim();
    const eventName = process.env.GITHUB_EVENT_NAME;
    const ref = process.env.GITHUB_REF;
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const sha = requireSha(process.env.GITHUB_SHA);
    const checkoutSha = await git(['rev-parse', 'HEAD']);
    if (checkoutSha !== sha) throw new Error('Checkout is not the tested SHA.');
    if (process.argv[2] === 'check') {
        const plan = await planRelease({ eventName, ref, event, sha, git });
        await appendFile(process.env.GITHUB_OUTPUT,
            `version=${plan.version}\nsha=${plan.sha}\nrelease=${plan.release}\n`);
        console.log(`Version ${plan.version}: ${plan.release ? 'draft eligible after checks' : 'validation only'}.`);
        return;
    }
    if (process.argv[2] !== 'draft') throw new Error('Expected check or draft command.');
    validateDraftContext({ eventName, ref, sha, checkoutSha });
    const version = manifestVersion(await readFile(MANIFEST, 'utf8'));
    if (version !== process.env.RELEASE_VERSION) throw new Error('Version differs from the successful check.');
    const result = await prepareDraft({
        version, sha, assetPath: `dist/${INSTALLER}`,
        github: createGitHub({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN }),
    });
    const messages = {
        exists: 'release already complete or published; left unchanged',
        created: 'unpublished draft created',
        recovered: 'unpublished draft recovered with the missing installer',
    };
    console.log(`${result.tag}: ${messages[result.status]}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
