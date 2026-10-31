# Agent handoff

## Documentation discipline

- The plugin is not published yet. Describe the current product; do not add migration notices, breaking-change warnings, historical UUID mappings, or instructions to recreate keys for pre-release changes.
- User-facing Markdown is a practical guide, not a devlog or agent handoff. Prefer short descriptions, copyable examples, requirements, and actionable limitations.
- Do not append implementation reports, internal algorithms, locking/ACL mechanics, validation receipts, source-review history, or unrun manual-test checklists to READMEs and setup guides. Report verification and remaining uncertainty in the session instead; never imply unverified behavior was tested.
- Keep essential safety warnings and public protocol contracts, but state them concisely. Do not turn every internal safeguard or hypothetical failure into documentation.
- Update the relevant section in place, remove superseded prose, and link to existing guidance instead of repeating it. Do not create extra reference files or expandable detail dumps merely to retain unnecessary commentary.

## Project

DeckForge Commander is an open-source macOS and Windows 11 x64 Stream Deck plugin that runs user-selected programs and displays their stdout as text, progress, or images. The [README](README.md) is the product and protocol reference; [launch-environment.md](docs/launch-environment.md) documents child-process metadata.

Keep the existing action identities:

| Action | UUID | Behavior |
|---|---|---|
| Stream | `git.renaudcerrato.deckforge.stream` | Toggle a live program. |
| Loop | `git.renaudcerrato.deckforge.loop` | Repeat after completion and the configured delay. |
| Run | `git.renaudcerrato.deckforge.run` | Execute once and retain successful output. |

Do not add migration aliases or rewrite profiles/settings. Internal class/file names retain their historical meanings. Preserve plugin identity, third-party license notices, and manifest description `Script to canvas` unless a change is explicitly requested.

The project is licensed under the [Apache License 2.0](LICENSE), which permits commercial use and redistribution under its terms. Preserve copyright and attribution notices. Do not relicense third-party components.

The display name is DeckForge Commander; plugin UUID is `git.renaudcerrato.deckforge` and bundle is `git.renaudcerrato.deckforge.sdPlugin`. Keep these identities stable unless explicitly requested; do not migrate profiles or storage namespaces implicitly.

## Layout and tools

- Work from the repository root. Use Node.js 24, Stream Deck SDK 3, and the standalone SDPI 4 inspector components. Pin SDK assumptions to the installed version (3.0.1 / schema 0.5.1); recheck them when changing dependencies.
- `src/core/`: settings, lifecycle, process ownership, protocol, and rendering. Loop and Run share `cycle-session`; their facades select trusted policies.
- `src/actions/`: SDK adapters and shared process/display boundary. `src/native/windows-process-transport.c` is the Windows x64 Node-API 8 transport.
- `src/inspector/`: shared inspector bridge and controller. Authored markup is `git.renaudcerrato.deckforge.sdPlugin/ui/run.html`.
- `tests/`: production behavior tests. `demos/`: standalone examples. `assets/`: README previews and generator.
- Rollup generates plugin and inspector bundles. Edit source, not generated JavaScript or source maps.
- Keep `.opencode/` local and ignored. Do not force-add it.

## Checks

Run relevant checks when source changes or the user requests them. Reuse results for unchanged code; report exactly what was checked.

```sh
npm run build
node --test tests/*.test.mjs
streamdeck validate --no-update-check git.renaudcerrato.deckforge.sdPlugin
```

Use Node.js 24: `npm install`, then `npm run build` on macOS arm64/x64, Linux x64 (build-only), or Windows x64. Bootstrap downloads pinned Zig 0.17.0 and Node 24.13.1 Windows headers/`node.lib`, verifies download sizes/SHA-256, and safely extracts into a versioned `.task/toolchains/` cache. Later builds reuse those tools and compile fresh source. No manual tool setup, prebuilt native pair, or separate native command. Preserve basic path/file/version checks and failed download stages; do not add build profiles, inventories, provenance sidecars, state ledgers, or source snapshots. See [Windows build and setup](docs/windows-support.md).

`npm run build` uses Task 3.54.0 to invoke Zig directly for the Windows x64 Node-API 8 transport, then generates minified plugin/inspector bundles only. `npm run pack` builds fresh, stages `.task/package/git.renaudcerrato.deckforge.sdPlugin`, and creates `dist/git.renaudcerrato.deckforge.streamDeckPlugin`; neither command needs Stream Deck or a device. Repeat packaging replaces that regular output only; leave unrelated files untouched. npm scripts invoke Task directly; Task owns compilation, staging, and CLI packaging without Node orchestration wrappers. Keep bootstrap and test-kit/supervisor responsibilities separate; do not reinstate the removed native metadata helper or ZIP-content verification.

The standalone Windows suite is six controlled cases (launch, streams, backpressure, ownership, concurrency, lifecycle), not host, arbitrary-program, metadata-receipt, or crash/restart proof. Its kit contains the driver, producer, and transport only—no hashes or provenance manifest. The supervisor checks required files, x64 PE architecture, fixed cases, and receipts; on expiry it may terminate only its retained driver Node process. Preserve receipts and never infer child-tree cleanup from Node exit alone.

Utility-script tests are excluded unless explicitly requested. Do not recreate or run the removed demo test suite. Builds/tests do not prove hardware appearance, settings durability, environment receipt, or crash cleanup.

`npm run link`, `npm run unlink`, and `npm run stop` affect the installed plugin; unlink has no `--delete`. `npm run watch` uses Task to run the full native/minified-JavaScript build on startup and changes to authored sources/configuration, then restarts the plugin only after success. Failed builds skip restart and leave the watcher available for the next edit; generated outputs are not watched. Do not run these host-affecting commands, restart, install dependencies, or perform Git publication without authorization. Stop and report failed checks; do not weaken tests to obtain a pass.

## Lifecycle contracts

- Never overlap owned processes. Uncertain cleanup blocks replacement and recovery; never kill unrelated processes.
- Stream intent is session-local: fresh plugin sessions always start stopped, ignoring valid legacy `runRequested` values while preserving them unchanged in settings. Successful exit drains accepted output, stops local intent, and displays `exited`; it does not retry automatically. Hiding/disconnect stops execution while preserving eligible same-session intent for show/reconnect.
- Loop's enabled state and deadline are session-local. Delays start after completion, certain cleanup, and final-frame drain; no catch-up. Ordinary nonzero/signal failures retry; fatal launch/configuration/protocol/display errors suspend automation.
- Loop defaults to `refresh` press mode; `stop` is the alternative. Press-mode edits preserve execution and deadline. Interval edits preserve a current run and apply the latest confirmed delay after completion.
- Run has no timer, automatic retry, or persisted attempt intent. Short release starts once; busy gestures are consumed. Successful output stays visible; no-output success displays `success`.
- Loop and Run use a 1-second hold to stop without first launching. Setup presses are no-ops. Hiding may let an active child finish locally but starts no background work; Run consumes pending starts. Disconnect stops execution, and reconnect never enables Loop or launches Run.
- Preserve final-frame drain, ownership, current-display checks, error priority, and stale-callback rejection across every asynchronous boundary.

## Settings and inspector

- Execute an absolute path with ordered literal argv and optional cwd. No shell, implicit interpreter, `PATH` expansion, or sandbox. macOS scripts use their shebang; on Windows, select an interpreter executable and pass the script path as an argument.
- Settings authority adopts the first host snapshot without hydration writes. Later host restores must not overwrite local edits or confirm unrelated writes. Matching readback is confirmation, not durability proof.
- Narrow ownership exception (explicitly approved for settings-move-integrity): only a genuine disappearance followed by an appearance with changed complete detached JSON (or a different action facade) replaces the context's runtime owner with a fresh stopped coordinator/session. Unchanged hide/show retains local authority and eligible Stream intent; visible restores, PI traffic, settings events, and late reads never replace ownership. Fence retired generations, drain certain cleanup before execution, and carry dispatched-unconfirmed-write quarantine across owners without hydration writes. Cleanup-only uncertainty still permits Loop/Run configuration saves.
- Save complete snapshots while preserving legacy/unknown JSON. `argsText` wins when present, including an empty string; project legacy argv read-only. Reject unmatched quotes, NUL, and invalid types. macOS retains POSIX-style backslash escapes and rejects dangling escapes. Windows argument text keeps backslashes literal outside and inside ordinary single/double quotes, including trailing backslashes; quotes group spaces (for example, `'C:\My Scripts\showcase.py'`). Only explicit ANSI-C `$'...'` segments interpret escapes on Windows. Do not migrate or automatically rewrite saved argument text.
- Execution edits stop/cancel and recover only after safe cleanup and latest matching configuration confirmation. Do not auto-launch after editing. Theme-only edits preserve intent, output, and errors.
- Persistence uncertainty blocks further saves. Loop/Run cleanup uncertainty blocks execution/recovery but does not independently block configuration saves.
- The plugin is the sole settings writer. Keep the single inspector WebSocket, request/session correlation, 200-ms text debounce, immediate file saves, and existing markup/styles. No Apply button or `setting=` autosave bindings.
- Only Loop exposes Interval and Action on press. Run rejects Stream intent and Loop controls. Empty executable edits remain invalid, while otherwise-valid missing/empty configuration displays `setup required`.
- For SDPI 4 placeholders, set the `placeholder` HTML attribute (not the localized `.placeholder` property); request an update when a changed attribute does not repaint.

## Rendering and environment

- Treat the README Protocol section as the public contract. Use current per-kind allowlists and skip the complete reserved record for invalid, unknown, duplicate, or inapplicable options. Text uses `font-size`, `align:left/center/right`, `valign:top/center/bottom`, and `label-position:above/below` (default below); progress `scale` is geometry. Defaults reset per record; `label` and `display` are record content, not inherited defaults. Do not add persistent output styles, JSON image/title envelopes, `max-lines`, or new DTO flags.
- Cards are a separate `card:` kind: main defaults to one-line `overflow:ellipsis`; `wrap` soft-wraps only main at fixed 1.2 line spacing, preferring fewest complete lines then largest auto size, ellipsizing the last available line on overflow and retaining one clipped line if none fits in the middle area. Header/footer are empty record-only fields, do not inherit caller defaults, and have literal single-line content (`\n` stays literal in all fields); blank sides reserve no space. Auto main size tries 48 down to 16, falling back to 16; fixed sizes never shrink. Header/footer align independently (center by default), inherit main color/font/weight, and auto-size to half the fitted main clamped to 14–18 (18 without main). `header-gap` and `footer-gap` default to 8 and apply only to nonblank sides. Preserve overlap/clipping; impossible geometry still skips.
- Preserve the README's text caption, hard-break, color, ratio, and annotation behavior. Text's single centered caption may sit above or below its headline; main `align` affects the headline only and `valign` places the whole visible block. Caption-only text uses auto size 18; if a fixed headline and caption exceed the height, drop only the caption and gap. Only explicit text-main wire `\n` decodes (escaped backslash-n stays literal); ordinary stdout, captions, and progress content do not decode it. Progress fill retains full ratio precision while default annotations round to tenths; progress annotation `accent` keeps symbolic provenance for theme-only re-resolution.
- Keep the 144-unit logical canvas, 262,144-byte framing, grapheme/XML/byte/NUL bounds, escaping, corner-safe clipping, geometry/annotation fit guards, and fixed diagnostics. Preserve skip-versus-fatal behavior; producer images remain opaque and are never tinted, composited, or given built-in badges.
- Ordinary built-in cards use the optional literal title, falling back dynamically to the safe extensionless executable basename; the eligible lowercase extension badge always comes from the executable. Title-only edits preserve execution, output, errors, and deadlines without producer redraws. Setup cards show a centered yellow warning icon instead of a caption; Setup/Error cards have no badge. Preserve fixed Error artwork and static Setup asset parity.
- Keep frame queuing bounded: one active send, one newest pending frame, and the existing bounded producer fallback. Cosmetic redraws must not displace eligible final producer output or replay opaque images.
- Capture a fresh immutable environment at each confirmed launch. Preserve the documented 16 owned names, unrelated inherited variables, and stale-owned-name removal; never mutate `process.env` or add exported names without approval. `ELGATO_ACTION_THEME_COLOR` is the effective lowercase six-digit color, default `#969696`; edits affect later launches only.

## Safety and SDK boundaries

- Do not access unrelated personal scripts, credentials, profiles, proprietary integrations, or private assets. Do not run a user's configured executable merely to test the plugin.
- Production logs are restricted to fixed process lifecycle/event/reason codes and fixed settings-validation codes. Never log executable/cwd, argv, environment or identity values, stdout/stderr payloads or excerpts, PIDs, full settings, or raw OS exceptions. Keep runner stderr-excerpt and launch-error callbacks in memory; do not wire them to production logging. Never insert producer output into inspector HTML; keep SDK trace/debug disabled for real programs.
- PI transport uses its registration UUID; action-instance identity comes from `actionInfo.context`. Preserve action/request/session correlation and stale-reply rejection.
- SDK settings reads may be cached; a sent settings write is not a host-save acknowledgment. Keep existing authority gates instead of adding polling or weakening confirmation.
- Wake/disconnect/appearance ordering is unspecified. There is no guaranteed pre-sleep or graceful-host-shutdown callback. User-native titles may overlay artwork; do not invent a title getter/hide guarantee.
- Keep work scoped. Neo, new action modes, marketplace operations, and additional inspector styling require separate approval.

## Windows platform and safety

- Product scope is Windows 11 x64 only; Windows 10 and ARM are not claimed. The main manifest's Windows `MinimumVersion: 10` follows the host's Windows version format (Windows 11 reports kernel version 10.0); it is not a Windows 10 support claim. Preserve macOS 13+ behavior and the stable identities above.
- Each run is enrolled in its own Windows Job. Stop or root exit force-terminates the owned Job; there is no generic graceful interrupt, so in-progress work may be lost. Services, WMI work, and processes launched outside the Job may continue. Uncertain in-session cleanup blocks replacement; abrupt plugin/host crash and immediate-restart cleanup ordering have no guarantee. Never target unrelated processes or mutate plugin-wide console state to signal a child.
- Keep Windows path checks to fully qualified local drive paths. Reject UNC/device namespaces, relative paths, implicit interpreter dispatch, and custom shelling. Preserve argv and saved path spellings; normalize only temporary Win32 executable/cwd copies.
- Build/QA guards cover generated destinations and required files, not whole input ancestry or hardlink policing. Accept normal tool aliases, linked read-only inputs, and `tar` on PATH; retain pinned download integrity and generated-destination link/type checks. Neutralize only `ZIG_LIB_DIR` and `ZIG_IS_DETECTING_LIBC_PATHS` in child builds, without changing global settings. The test supervisor uses an explicit Node executable and kit root, fixed cases, and unique bounded receipts; it never scans or broadly kills processes. Runtime executable-path and Job safety rules above remain unchanged.
- Do not claim actual host metadata receipt, progress/image hardware rendering, Windows 10/ARM behavior, service/WMI cleanup, or abrupt-crash/immediate-restart safety without separate evidence. Record standalone and host evidence separately; a manifest validator or candidate package check is not a hardware test.
