# Stream clock: tap the key to start or stop.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$culture = [System.Globalization.CultureInfo]::CurrentCulture
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
# Ignore quoted literals and escaped characters when locating the date fields.
$pattern = [regex]::Replace($culture.DateTimeFormat.ShortDatePattern, '(''[^'']*''|"[^"]*"|\\.)', '')
$dateFormat = if ($pattern.IndexOf('d') -lt $pattern.IndexOf('M')) { "dd'/'MM'/'yyyy" } else { "MM'/'dd'/'yyyy" }

function Escape-Field([string] $Value) {
    $Value.Replace('\', '\\').Replace('|', '\|').Replace(';', '\;')
}

function Get-FooterSize([string] $Value) {
    # Renderer normal sans estimates; UTF-16 counting conservatively overestimates
    # combining characters and surrogate pairs without a grapheme framework.
    $width = 0.0
    foreach ($character in $Value.ToCharArray()) {
        $units = 0.56
        if ([int] $character -gt 0xff) { $units = 1.2 }
        elseif ($character -cmatch '\s') { $units = 0.28 }
        elseif ($character -cmatch '[ilI.,''`!:;|]') { $units = 0.25 }
        elseif ($character -cmatch '[frt]') { $units = 0.33 }
        elseif ($character -cmatch '[mwMW@%&]') { $units = 1.0 }
        elseif ($character -cmatch '[A-Z]') { $units = 0.7 }
        $width += $units * 1.04
    }
    if ($width -eq 0) { return 20 }
    [Math]::Min(20, [Math]::Floor(112 / $width * 100) / 100)
}

$colonVisible = $true
while ($true) {
    $now = [DateTime]::Now
    $separator = if ($colonVisible) { ':' } else { ' ' }
    $main = $now.ToString("HH':'mm", $invariant).Replace(':', $separator)
    $header = $now.ToString($dateFormat, $invariant)
    $footer = [regex]::Replace($culture.DateTimeFormat.GetDayName($now.DayOfWeek).Normalize(), '\s+', ' ').Trim()
    $size = (Get-FooterSize $footer).ToString('0.##', $invariant)
    $record = 'card:' + (Escape-Field $main) + '|header:' + (Escape-Field $header) + ';footer:' + (Escape-Field $footer) +
        ';font:mono;font-size:36;padding-x:0;header-font:sans;footer-font:sans;header-size:18;footer-size:' + $size
    [Console]::Out.WriteLine($record)
    [Console]::Out.Flush()
    $colonVisible = -not $colonVisible
    Start-Sleep -Milliseconds 500
}
