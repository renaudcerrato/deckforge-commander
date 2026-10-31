param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Node,
  [Parameter(Mandatory=$true)][string]$Supervisor
)
$ErrorActionPreference = 'Stop'
$kitFiles = @('windows-tests.mjs','windows-native-producer.mjs','native/win32-x64/transport.node')
# R12 practical prelaunch guards only. Run the six positive native cases separately.
# Keep every new fixture and receipt. Never execute a fake driver or scan processes.
function Assert([bool]$Condition) { if (-not $Condition) { throw 'Supervisor test assertion failed.' } }
function Absolute([string]$Value) {
  Assert ($Value -match '^[a-zA-Z]:[\\/]' -and -not $Value.Contains('"') -and -not $Value.Contains([char]0) -and -not $Value.Contains("`r") -and -not $Value.Contains("`n"))
  return [IO.Path]::GetFullPath($Value)
}
function File([string]$Value) {
  $item = Get-Item -LiteralPath (Absolute $Value) -Force
  Assert (-not $item.PSIsContainer -and $item.Length -gt 0)
  return $item
}
function NewDirectory([string]$Value) {
  Assert (-not (Test-Path -LiteralPath $Value))
  $null = New-Item -ItemType Directory -Path $Value
}
function WriteNew([string]$Value,[byte[]]$Bytes) {
  $stream = [IO.File]::Open($Value,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() }
}
function Quote([string]$Value) { return '"' + $Value + '"' }
try {
  $Root = Absolute $Root; $Node = Absolute $Node; $Supervisor = Absolute $Supervisor
  Assert ((Get-Item -LiteralPath $Root -Force).PSIsContainer)
  $null = File $Node; $null = File $Supervisor
  Assert ([IO.Path]::GetExtension($Node) -ieq '.exe')
  foreach ($name in $kitFiles) { $null = File (Join-Path $Root $name) }
  $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  $null = File $powershell
  $suiteRoot = Join-Path $Root ('supervisor-negative-' + [Guid]::NewGuid().ToString('N'))
  NewDirectory $suiteRoot
  $suite = [Diagnostics.Stopwatch]::StartNew()
  foreach ($case in @('missing-driver','missing-producer','missing-transport','invalid-architecture','invalid-case','existing-receipt','relative-root','relative-node')) {
    # Arrange: fresh child and copies; absence cases omit creation, never delete.
    Assert ($suite.ElapsedMilliseconds -lt 115000)
    $directory = Join-Path $suiteRoot $case; NewDirectory $directory
    NewDirectory (Join-Path $directory 'native'); NewDirectory (Join-Path $directory 'native/win32-x64')
    foreach ($name in $kitFiles) {
      if (($case -eq 'missing-driver' -and $name -eq 'windows-tests.mjs') -or
        ($case -eq 'missing-producer' -and $name -eq 'windows-native-producer.mjs') -or
        ($case -eq 'missing-transport' -and $name -eq 'native/win32-x64/transport.node')) { continue }
      $bytes = [IO.File]::ReadAllBytes((Join-Path $Root $name))
      if ($case -eq 'invalid-architecture' -and $name -eq 'native/win32-x64/transport.node') {
        $offset = [BitConverter]::ToUInt32($bytes,0x3c)
        Assert ($offset -le ($bytes.Length - 6))
        $bytes[$offset + 4] = 0x64; $bytes[$offset + 5] = 0xaa
      }
      WriteNew (Join-Path $directory $name) $bytes
    }
    $receipt = Join-Path $directory 'reject-launch.stdout.txt'
    if ($case -eq 'existing-receipt') { WriteNew $receipt ([Text.Encoding]::UTF8.GetBytes('RETAINED_SYNTHETIC_RECEIPT')) }
    $before = @(Get-ChildItem -LiteralPath $directory -Force | Select-Object -ExpandProperty Name | Sort-Object)
    $submittedRoot = $directory; if ($case -eq 'relative-root') { $submittedRoot = 'relative-root' }
    $submittedNode = $Node; if ($case -eq 'relative-node') { $submittedNode = 'relative-node.exe' }
    $selected = 'launch'; if ($case -eq 'invalid-case') { $selected = 'invalid-case' }
    $out = Join-Path $suiteRoot ($case + '.stdout.txt'); $err = Join-Path $suiteRoot ($case + '.stderr.txt')
    WriteNew $out ([byte[]]@()); WriteNew $err ([byte[]]@())
    $process = $null
    # Act: exactly one Cases argument avoids PowerShell 5.1 array CLI ambiguity.
    try {
      $remaining = 120000 - [int]$suite.ElapsedMilliseconds - 5000
      Assert ($remaining -gt 0)
      $process = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-File',(Quote $Supervisor),
        '-Root',(Quote $submittedRoot),'-Node',(Quote $submittedNode),'-ReceiptPrefix','reject','-Cases',$selected) -WorkingDirectory $directory -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
      $handle = $process.Handle
      if (-not $process.WaitForExit([Math]::Min(30000,$remaining))) {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { throw 'Dedicated supervisor exit unconfirmed.' }
        throw 'Supervisor timeout; cleanup not independently proven.'
      }
      $process.WaitForExit()
      # Assert: rejection precedes driver launch and reservation; inspect fixed diagnostics only.
      Assert ($process.ExitCode -eq 1)
      Assert ((Get-Item -LiteralPath $out).Length -eq 0 -and (Get-Item -LiteralPath $err).Length -le 1024)
      $diagnostic = [IO.File]::ReadAllText($err)
      $failure = 'WINDOWS_NATIVE_SUITE_FAILED; preserve receipts and stop.'
      Assert ($diagnostic -ceq ($failure + "`r`n") -or $diagnostic -ceq ($failure + "`n"))
      Assert (-not (Test-Path -LiteralPath (Join-Path $directory 'reject-launch.stderr.txt')))
      if ($case -eq 'existing-receipt') { Assert ([IO.File]::ReadAllText($receipt) -ceq 'RETAINED_SYNTHETIC_RECEIPT') }
      else { Assert (-not (Test-Path -LiteralPath $receipt)) }
      $after = @(Get-ChildItem -LiteralPath $directory -Force | Select-Object -ExpandProperty Name | Sort-Object)
      Assert (($before -join '|') -ceq ($after -join '|'))
      Write-Output ('PASS supervisor-negative-' + $case)
    } finally { if ($null -ne $process) { $process.Dispose() } }
  }
  Write-Output 'WINDOWS_SUPERVISOR_TESTS_OK'
} catch {
  [Console]::Error.WriteLine('WINDOWS_SUPERVISOR_TESTS_FAILED; preserve fixtures and stop.')
  exit 1
}
