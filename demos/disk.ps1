# One snapshot per invocation; Loop owns the refresh interval.
if ($env:ELGATO_ACTION_UUID -cne 'git.renaudcerrato.deckforge.loop') {
    Write-Output 'Use a Loop key'
    exit 0
}

try {
    if ($args.Count -gt 1) { throw 'Invalid target' }
    $drive = $env:SystemDrive
    if ($args.Count -eq 1) { $drive = [string]$args[0] }
    if ($drive -notmatch '^[A-Za-z]:?$') { throw 'Invalid target' }
    $drive = $drive.Substring(0, 1).ToUpperInvariant() + ':'

    $disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive' AND DriveType=3" -ErrorAction Stop)
    if ($disks.Count -ne 1) { throw 'Missing disk' }
    $disk = $disks[0]
    if ($null -eq $disk.FreeSpace -or $null -eq $disk.Size -or
        $disk.Size -le 0 -or $disk.FreeSpace -lt 0 -or $disk.FreeSpace -gt $disk.Size) {
        throw 'Invalid metrics'
    }
    $freeGiB = ([double]$disk.FreeSpace / 1GB).ToString('F1', [Globalization.CultureInfo]::InvariantCulture)
    Write-Output ('text:' + $freeGiB + '|label:GiB free')
    exit 0
} catch {
    [Console]::Error.WriteLine('Disk metrics unavailable.')
    exit 1
}
