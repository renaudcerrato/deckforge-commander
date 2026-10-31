# Stream CPU: whole-machine busy percentage, not a per-process/core total.
$ErrorActionPreference = 'Stop'

function Get-CpuSample {
    $samples = @(Get-WmiObject -Namespace 'root\cimv2' `
        -Class Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'")
    if ($samples.Count -ne 1 -or
        $null -eq $samples[0].PercentProcessorTime -or
        $null -eq $samples[0].Timestamp_Sys100NS) {
        throw 'CPU metrics unavailable.'
    }
    return $samples[0]
}

try {
    $previous = Get-CpuSample
    while ($true) {
        Start-Sleep -Seconds 1
        $current = Get-CpuSample
        # PERF_100NSEC_TIMER_INV: raw PercentProcessorTime counts idle time.
        # Decimal subtraction preserves the integer counters before division.
        $idle = [decimal]$current.PercentProcessorTime - [decimal]$previous.PercentProcessorTime
        $elapsed = [decimal]$current.Timestamp_Sys100NS - [decimal]$previous.Timestamp_Sys100NS
        if ($elapsed -le 0 -or $idle -lt 0 -or $idle -gt $elapsed) {
            throw 'CPU metrics unavailable.'
        }
        $busy = [Math]::Round((100 * (1 - $idle / $elapsed)), 0, [MidpointRounding]::AwayFromZero)
        $value = $busy.ToString('0', [Globalization.CultureInfo]::InvariantCulture)
        Write-Output ('progress:' + $value + '|label:CPU;value-size:28;label-size:20;thickness:12')
        $previous = $current
    }
} catch {
    [Console]::Error.WriteLine('CPU metrics unavailable.')
    exit 1
}
