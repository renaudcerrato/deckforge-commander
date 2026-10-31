# Stream clock: tap the key to start or stop the cyan local time display.
while ($true) {
    Write-Output ('text:' + (Get-Date -Format 'HH:mm:ss') + '|color:cyan')
    Start-Sleep -Seconds 1
}
