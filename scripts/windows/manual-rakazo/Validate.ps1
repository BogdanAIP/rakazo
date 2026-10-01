# Local static gate. No application or host is launched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script = Join-Path $PSScriptRoot 'Rakazo.ps1'
foreach ($name in @('Rakazo.ps1', 'Tunnel.Diagnostics.ps1', 'Tunnel.Control.ps1', 'Check-ExistingR.ps1', 'Install-Shortcut.ps1')) {
    $file = Join-Path $PSScriptRoot $name
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file, [ref]$tokens, [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        foreach ($problem in $parseErrors) {
            Write-Host ("{0}: parse error at line {1}: {2}" -f $name, $problem.Extent.StartLineNumber, $problem.Message)
        }
        throw 'Manual launcher PowerShell parsing failed.'
    }
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
$lifecycle = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Tunnel.Control.ps1'))
$combined = $text + [Environment]::NewLine + $lifecycle
foreach ($forbidden in @(
    'Register-ScheduledTask', 'New-ScheduledTask', 'compose down',
    'down -v', 'runtimes create', 'runtimes rm', 'windowsHosts/createPairing'
)) {
    if ($combined.Contains($forbidden)) { throw "Forbidden launcher action present: $forbidden" }
}
foreach ($required in @(
    'Start-ControllerTunnel', 'Stop-ControllerTunnel',
    'Ensure-ExistingPostgres', 'ExternalWorkerDetected',
    'ExternalHostDetected', 'ExistingTunnelLiveHealth',
    'ExpectedStopPid', 'ExpectedStopStart', 'Local\RakazoTunnelControl',
    'Get-RakazoAuthenticatedTunnelStatus', 'Test-RakazoExistingTunnelProcessEvidence'
)) {
    if (-not $combined.Contains($required)) { throw "Required ownership or cold-start guard absent: $required" }
}
Write-Host 'STATIC MANUAL LAUNCHER GATE PASSED'
Write-Host 'No files, processes, tunnels, tasks or startup entries were changed.'
