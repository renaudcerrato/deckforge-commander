param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Node,
  [Parameter(Mandatory=$true)][string]$ReceiptPrefix,
  [string[]]$Cases = @('launch','streams','backpressure','ownership','concurrency','lifecycle')
)
$ErrorActionPreference = 'Stop'
$allowed = @('launch','streams','backpressure','ownership','concurrency','lifecycle')
$kitFiles = @('windows-tests.mjs','windows-native-producer.mjs','native/win32-x64/transport.node')
function Absolute([string]$Value) {
  if ($Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value.Contains([char]0) -or $Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw 'Invalid explicit supervisor path.'
  }
  return [IO.Path]::GetFullPath($Value)
}
function Guard([string]$File, [bool]$Directory = $false) {
  $absolute = Absolute $File
  $item = Get-Item -LiteralPath $absolute -Force
  if (($Directory -and -not $item.PSIsContainer) -or (-not $Directory -and $item.PSIsContainer)) {
    throw 'Invalid supervisor input.'
  }
  return $item
}
function Regular([string]$File) {
  return Guard $File
}
function VerifyKit([string]$Directory) {
  foreach ($name in $kitFiles) {
    if ((Regular (Join-Path $Directory $name)).Length -eq 0) { throw 'Empty test kit input.' }
  }
  $addon = Join-Path $Directory 'native/win32-x64/transport.node'
  $stream = [IO.File]::OpenRead($addon)
  $reader = $null
  try {
    $reader = New-Object IO.BinaryReader($stream)
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'Invalid native PE binary.' }
    $stream.Position = 0x3c
    $offset = $reader.ReadUInt32()
    if ($offset -gt ($stream.Length - 24)) { throw 'Invalid native PE offset.' }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Invalid native PE architecture.' }
  } finally {
    if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
  }
}
function Quote([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Invalid supervisor path.' }
  return '"' + $Value + '"'
}
try {
  $Root = Absolute $Root
  $Node = Absolute $Node
  $null = Guard $Root $true
  $null = Regular $Node
  if ([IO.Path]::GetExtension($Node) -ine '.exe') { throw 'Invalid driver executable.' }
  if ($ReceiptPrefix -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$') { throw 'Invalid receipt prefix.' }
  if ($Cases.Count -lt 1 -or $Cases.Count -gt 6 -or (@($Cases | Select-Object -Unique).Count -ne $Cases.Count)) { throw 'Invalid test cases.' }
  foreach ($case in $Cases) { if ($allowed -cnotcontains $case) { throw 'Invalid test case.' } }
  VerifyKit $Root
  $Driver = Join-Path $Root 'windows-tests.mjs'
  foreach ($target in @('definitely-absent.exe','definitely-absent-cwd')) {
    if (Get-Item -LiteralPath (Join-Path $Root $target) -Force -ErrorAction SilentlyContinue) { throw 'Negative target already exists.' }
  }
  # No overwrite or deletion of any prior result; preflight the entire batch.
  foreach ($case in $Cases) {
    foreach ($suffix in @('stdout.txt','stderr.txt')) {
      if (Get-Item -LiteralPath (Join-Path $Root ($ReceiptPrefix + '-' + $case + '.' + $suffix)) -Force -ErrorAction SilentlyContinue) { throw 'Receipt already exists.' }
    }
  }
  $suite = [Diagnostics.Stopwatch]::StartNew()
  foreach ($case in $Cases) {
    $remaining = 120000 - [int]$suite.ElapsedMilliseconds - 5000
    if ($remaining -le 0) { throw 'Suite deadline before launch.' }
    $wait = [Math]::Min(30000,$remaining)
    $out = Join-Path $Root ($ReceiptPrefix + '-' + $case + '.stdout.txt')
    $err = Join-Path $Root ($ReceiptPrefix + '-' + $case + '.stderr.txt')
    $process = $null
    try {
      # Reserve only our new receipt files; CreateNew cannot overwrite a concurrent/existing target.
      foreach ($receipt in @($out,$err)) {
        $null = Guard $Root $true
        $reserved = [IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $reserved.Dispose()
      }
      $process = Start-Process -FilePath $Node -ArgumentList @((Quote $Driver),$case) -WorkingDirectory $Root -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
      # Retain the dedicated process handle now, before waiting or timeout action.
      $handle = $process.Handle
      if (-not $process.WaitForExit($wait)) {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { throw 'Dedicated driver exit unconfirmed; tree cleanup uncertain.' }
        throw 'Driver timeout; tree cleanup not independently proven.'
      }
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw ('Driver failed: ' + $case) }
      $outInfo = Regular $out
      $errInfo = Regular $err
      if ($outInfo.Length -gt 1024 -or $errInfo.Length -ne 0) { throw 'Invalid receipt size.' }
      $stdout = [IO.File]::ReadAllText($out)
      if ($stdout -cne ('PASS ' + $case + "`n") -and $stdout -cne ('PASS ' + $case + "`r`n")) { throw ('Invalid fixed receipt: ' + $case) }
      Write-Output ('PASS ' + $case)
    } finally { if ($null -ne $process) { $process.Dispose() } }
  }
  Write-Output 'WINDOWS_NATIVE_SUITE_OK'
} catch {
  # Never relay a raw exception, command line, path, PID or producer output.
  [Console]::Error.WriteLine('WINDOWS_NATIVE_SUITE_FAILED; preserve receipts and stop.')
  exit 1
}
