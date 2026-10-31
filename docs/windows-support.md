# Windows Build and Setup Guide

For Windows 11 x64. Windows 10 and ARM are not supported.

## Requirements

- **Runtime:** Windows 11 x64 and Stream Deck 7.1+.
- **Build:** Node.js 24 and npm on macOS arm64/x64, Linux x64 (build-only), or Windows x64. The first build needs internet access.

## Build and package

From the repository root:

```sh
npm install
npm run build
npm run pack
```

`build` compiles the Windows transport and minified plugin/inspector JavaScript without packaging. `pack` performs a fresh build, stages the package, and creates `dist/git.renaudcerrato.deckforge.streamDeckPlugin`. Neither requires Stream Deck or a device.

First build automatically downloads the compiler and Windows target files; later builds reuse the cache. No manual compiler/SDK setup or prebuilt transport is needed.

## Choose an executable

Select an absolute local executable path. Programs run directly with your permissions, without a shell or `PATH` lookup. For scripts, select the interpreter and pass the script path in **Arguments**.

```text
Executable: C:\Tools\python.exe
Arguments:  'C:\My Scripts\status.py'
```

Quote arguments containing spaces; backslashes stay literal. An optional working directory must also be an absolute local path. See [Launch Environment](launch-environment.md) for available metadata.

<details>
<summary>Developer checks: standalone Windows suite</summary>

The six-case standalone suite must run on Windows x64. After `npm run build` on Windows, build the self-contained test kit and run its supervisor with the actual Node 24.13.1 executable and a new receipt prefix:

```powershell
node scripts/build-windows-tests.mjs
$root = (Resolve-Path '.task\windows-tests').Path
& '.\scripts\supervise-windows-tests.ps1' `
  -Root $root `
  -Node 'C:\Tools\node-v24.13.1-win-x64\node.exe' `
  -ReceiptPrefix 'qa-20261014'
```

The six cases cover launch, streams, backpressure, ownership, concurrency, and lifecycle. Use a new receipt prefix for each run. Timeout termination targets only the test driver and does not prove child-tree cleanup.

</details>

## Stopping programs

Each Windows run has an owned Job. Stop or root-program exit force-terminates its remaining processes; there is no generic graceful interrupt, so in-progress work may be lost. Services, WMI work, or processes launched outside the Job may continue. Uncertain cleanup blocks replacement; abrupt plugin/host crashes and immediate-restart cleanup ordering have no guarantee.

See the [license](../LICENSE) for self-build and redistribution terms.
