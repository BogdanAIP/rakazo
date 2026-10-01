# Local static gate. No application or host is launched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script = Join-Path $PSScriptRoot 'Rakazo.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $script, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    foreach ($problem in $parseErrors) {
        Write-Host ("Parser error at line {0}: {1}" -f $problem.Extent.StartLineNumber, $problem.Message)
    }
    throw 'Manual launcher PowerShell parsing failed.'
}
$text = [IO.File]::ReadAllText($script)
foreach ($forbidden in @(
    'Register-ScheduledTask',
    'New-ScheduledTask',
    'Set-ItemProperty',
    'compose down',
    'down -v',
    'runtimes create',
    'runtimes rm',
    'windowsHosts/createPairing'
)) {
    if ($text.Contains($forbidden)) { throw "Forbidden action present: $forbidden" }
}
foreach ($needed in @('rakazo_next', 'ExistingTunnelReady', 'Owned', 'RAKAZO_WINDOWS_PROCESS_ENABLED')) {
    if (-not $text.Contains($needed)) { throw "Required pilot guard absent: $needed" }
}
Write-Host 'STATIC MANUAL LAUNCHER GATE PASSED'
Write-Host 'No files, processes, tunnels, tasks or startup entries were changed.'
