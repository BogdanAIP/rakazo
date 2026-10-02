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
    'windowsHosts/createPairing', 'compose-postgres-1',
    'Docker Desktop', 'Ensure-ExistingPostgres'
)) {
    if ($text.Contains($forbidden)) { throw "Forbidden action present: $forbidden" }
}
if ($text -match '(?i)\$host\b') {
    throw 'Reserved PowerShell automatic variable $Host must not be used as a launcher process variable.'
}
foreach ($needed in @('$windowsHostProcess = Start-OwnedRole', '$windowsHostProcess.Refresh()')) {
    if (-not $text.Contains($needed)) { throw "Windows Host process tracking guard absent: $needed" }
}
foreach ($needed in @(
    'rakazo_next', 'ExistingTunnelReady', 'Owned', 'RAKAZO_WINDOWS_PROCESS_ENABLED',
    'Write-RakazoLaunchStage', 'launcher-stage.log', 'native postgres ready',
    'api child started; waiting for health'
)) {
    if (-not $text.Contains($needed)) { throw "Required pilot guard absent: $needed" }
}
if ($text.Contains('[System.Windows.Forms.MessageBox]::Show($_.Exception.Message')) {
    throw 'A blocking error dialog must not retain the controller mutex.'
}
if ($text -match '(?m)^\s*&\s*\$pgCtl\b.*\|\s*Out-Null') {
    throw 'Do not pipe pg_ctl start through PowerShell: the server may retain the native output handle.'
}
foreach ($needed in @('$ctlProcess.WaitForExit(70000)', 'pg_ctl returned; verifying native postgres identity')) {
    if (-not $text.Contains($needed)) {
        throw "Bounded native PostgreSQL process startup guard absent: $needed"
    }
}
# Regression gate: tunnel-client reports an unzoned UTC start timestamp.
# The ownership check must preserve the existing PID/path/20s guards.
$diagnostics = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Tunnel.Diagnostics.ps1'))
foreach ($needed in @(
    '[Globalization.DateTimeStyles]::AssumeUniversal',
    '[Globalization.CultureInfo]::InvariantCulture',
    '[IO.Path]::GetFullPath($ClientPath)',
    'TotalSeconds) -le 20'
)) {
    if (-not $diagnostics.Contains($needed)) {
        throw "Tunnel identity or UTC timestamp guard absent: $needed"
    }
}
$timestampStyle = [Globalization.DateTimeStyles]::AssumeUniversal
$culture = [Globalization.CultureInfo]::InvariantCulture
$sampleUtc = [DateTimeOffset]::Parse('2026-10-02T19:24:58+00:00', $culture)
$sampleUnzoned = [DateTimeOffset]::Parse('2026-10-02T19:24:58', $culture, $timestampStyle)
$sampleOffset = [DateTimeOffset]::Parse('2026-10-02T22:24:58+03:00', $culture, $timestampStyle)
if ($sampleUtc.UtcDateTime.Ticks -ne $sampleUnzoned.UtcDateTime.Ticks -or
    $sampleUtc.UtcDateTime.Ticks -ne $sampleOffset.UtcDateTime.Ticks) {
    throw 'Tunnel start timestamp UTC regression failed.'
}
# A healthy previously running R is borrowed, never reconnected or given stop ownership.
foreach ($needed in @(
    'ExistingTunnelAttachAllowed = $tunnelAttachAllowed',
    '$borrowedTunnel = Get-VerifiedRunningTunnelIdentity',
    'Assert-SameBorrowedTunnel $borrowedTunnel',
    'existing R reused read-only; creating tray (R unowned)',
    'if ($null -eq $script:tunnelOwnership) { return }',
    'Get-VerifiedRunningTunnelIdentity',
    'ProcessRunning -and $tunnel.VerifiedLocalProcess'
)) {
    if (-not $text.Contains($needed)) { throw "Read-only R reuse guard absent: $needed" }
}
if ($text -notmatch '(?s)if \(\$null -ne \$borrowedTunnel\) \{\s*Assert-SameBorrowedTunnel \$borrowedTunnel.*?\}\s*else\s*\{.*?Start-ControllerTunnel') {
    throw 'Existing live R and cold-start R paths must remain distinct; never connect the borrowed R.'
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
    'Ensure-NativePostgres', 'Get-NativePostgresDiagnostic',
    'DatabaseEndpointMatches', 'NativePostgresProcessVerified',
    'ExternalWorkerDetected',
    'ExternalHostDetected', 'ExistingTunnelLiveHealth',
    'ExpectedStopPid', 'ExpectedStopStart', 'Local\RakazoTunnelControl',
    'Get-RakazoAuthenticatedTunnelStatus', 'Test-RakazoExistingTunnelProcessEvidence',
    'NativePostgresClusterVerified'
)) {
    if (-not $combined.Contains($required)) { throw "Required ownership or cold-start guard absent: $required" }
}
Write-Host 'STATIC MANUAL LAUNCHER GATE PASSED'
Write-Host 'No files, processes, tunnels, tasks or startup entries were changed.'
