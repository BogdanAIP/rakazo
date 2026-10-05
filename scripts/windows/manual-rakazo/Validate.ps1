# Local static gate. No application or host is launched.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script = Join-Path $PSScriptRoot 'Rakazo.ps1'
foreach ($name in @('Rakazo.ps1', 'Tunnel.Diagnostics.ps1', 'Tunnel.Control.ps1', 'Check-ExistingR.ps1', 'Install-Shortcut.ps1', 'Native.Update.ps1', 'Native.TrayUpdates.ps1', 'Native.PostgresEvidence.ps1', 'Refresh-PluginR.ps1')) {
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
# The desktop shortcut must launch through the GUI Windows Script Host. Its only
# action is a hidden, nonblocking invocation of this same guarded Rakazo.ps1.
$guiPath = Join-Path $PSScriptRoot 'Launch-Rakazo.vbs'
if (-not (Test-Path -LiteralPath $guiPath -PathType Leaf)) {
    throw 'Console-free manual GUI launcher is missing.'
}
$guiText = [IO.File]::ReadAllText($guiPath)
foreach ($needed in @(
    'Option Explicit',
    'WScript.ScriptFullName',
    'fs.BuildPath(root, "Rakazo.ps1")',
    'controllerExit = shell.Run(commandLine, 0, True)',
    ' -WindowStyle Hidden',
    ' -Action Run'
)) {
    if (-not $guiText.Contains($needed)) {
        throw "Console-free GUI entry guard absent: $needed"
    }
}
foreach ($forbidden in @('runtimes connect', 'runtimes stop', 'schtasks', 'Register-ScheduledTask', 'powershell -EncodedCommand')) {
    if ($guiText.Contains($forbidden)) { throw "Forbidden GUI entry action present: $forbidden" }
}
$installerText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Install-Shortcut.ps1'))
foreach ($needed in @(
    'System32\wscript.exe', 'Launch-Rakazo.vbs', '$oldCanonical',
    '$legacyArgs', 'if (-not $oldCanonical)', '$link.TargetPath = $guiTarget'
)) {
    if (-not $installerText.Contains($needed)) {
        throw "Canonical shortcut migration guard absent: $needed"
    }
}
$nativeUpdateText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Native.Update.ps1'))
foreach ($required in @('--ff-only', 'Working tree contains local changes', 'Unexpected upstream',
    'ExpectedTarget', 'RakazoNativeManualController')) {
    if (-not $nativeUpdateText.Contains($required)) { throw "Native updater guard missing: $required" }
}
$refreshText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Refresh-PluginR.ps1'))
foreach ($required in @('ExpectedStopPid', 'ExpectedStopStart', 'PASS_SAME_REGISTERED_TUNNEL_NEW_PROCESS')) {
    if (-not $refreshText.Contains($required)) { throw "Plugin R refresh guard missing: $required" }
}
foreach ($fileText in @($nativeUpdateText, $refreshText)) {
    foreach ($forbidden in @('git reset --hard', 'runtimes create', 'windowsHosts/createPairing')) {
        if ($fileText.Contains($forbidden)) { throw "Forbidden update operation present: $forbidden" }
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
# Physical Host capability regression: the owner enabled the existing host's
# process, file write and GUI backends; OpenCLI must read PRIVATE configuration.
foreach ($needed in @(
    '$env:RAKAZO_WINDOWS_PROCESS_ENABLED = ''true''',
    '$env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = ''true''',
    '$env:RAKAZO_WINDOWS_GUI_ENABLED = ''true'''
)) {
    if (-not $text.Contains($needed)) { throw "Windows Host capability flag missing: $needed" }
}
foreach ($forbidden in @(
    '$env:RAKAZO_WINDOWS_PROCESS_ENABLED = ''false''',
    '$env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = ''false''',
    '$env:RAKAZO_WINDOWS_GUI_ENABLED = ''false''',
    '$env:RAKAZO_OPENCLI_PROFILE = ''''',
    '$env:RAKAZO_OPENCLI_ENTRY = '''''
)) {
    if ($text.Contains($forbidden)) { throw "Windows Host capability disabled by launcher: $forbidden" }
}
# Windows Host is launched by PowerShell, which does not implicitly import
# the private root .env. Pin the explicit profile into that owned host child.
foreach ($needed in @(
    '$openCliProfileLines = @(Get-Content -LiteralPath (Join-Path $repo ''.env'')',
    'Duplicate private OpenCLI profile settings;',
    'Private OpenCLI profile is invalid;',
    '$env:RAKAZO_OPENCLI_PROFILE = $rawProfile',
    '^\s*RAKAZO_OPENCLI_PROFILE\s*=\s*'
)) {
    if (-not $text.Contains($needed)) { throw "Windows Host profile import guard missing: $needed" }
}
if ([regex]::Matches($text, '\$env:RAKAZO_OPENCLI_PROFILE\s*=').Count -ne 1) {
    throw 'OpenCLI profile must be assigned exactly once within the owned host child.'
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
foreach ($needed in @(
    "Native.PostgresEvidence.ps1",
    "Get-NativePostgresPidFileEvidence -Spec $spec",
    "stale postgres pidfile verified; delegating recovery to pg_ctl",
    "safe recovery is not proven:"
)) {
    if (-not $text.Contains($needed)) {
        throw "Native PostgreSQL stale-PID recovery guard absent: $needed"
    }
}
if ($text.Contains("The native PostgreSQL PID file exists but ownership cannot be verified. Manual recovery required.")) {
    throw 'Old unconditional stale postmaster.pid failure path is still present.'
}
$postgresEvidencePath = Join-Path $PSScriptRoot 'Native.PostgresEvidence.ps1'
$postgresEvidenceText = [IO.File]::ReadAllText($postgresEvidencePath)
foreach ($needed in @(
    'SafeToDelegateRecovery',
    'stale-no-process',
    'pid-reused-by-other-process',
    'unexpected-data-directory',
    'matching-postgres-process-still-running'
)) {
    if (-not $postgresEvidenceText.Contains($needed)) {
        throw "PostgreSQL PID evidence guard absent: $needed"
    }
}

# Deterministic regression tests for stale postmaster.pid classification.
# They use only a temporary directory and the current PowerShell PID; no
# PostgreSQL service, port, database, or external process is changed.
. $postgresEvidencePath
$evidenceRoot = Join-Path ([IO.Path]::GetTempPath()) ('rakazo-pg-evidence-' + [guid]::NewGuid().ToString('N'))
try {
    $testData = Join-Path $evidenceRoot 'data'
    $testBin = Join-Path $evidenceRoot 'bin'
    New-Item -ItemType Directory -Path $testData, $testBin -Force | Out-Null
    $testSpec = [pscustomobject]@{ Data = $testData; Bin = $testBin; Port = 5434 }
    $pidFile = Join-Path $testData 'postmaster.pid'
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

    [int]$stalePid = [int]::MaxValue
    while ($null -ne (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) { $stalePid-- }
    Set-Content -LiteralPath $pidFile -Encoding ASCII -Value @(
        [string]$stalePid, $testData, [string]$epoch, '5434', '', ''
    )
    $stale = Get-NativePostgresPidFileEvidence -Spec $testSpec
    if (-not ($stale.Present -and $stale.MetadataVerified -and
        $stale.SafeToDelegateRecovery -and $stale.Reason -ceq 'stale-no-process')) {
        throw 'Stale postmaster.pid with an absent PID was not classified as delegated recovery.'
    }

    $current = Get-Process -Id $PID -ErrorAction Stop
    $currentEpoch = [DateTimeOffset]::new($current.StartTime.ToUniversalTime()).ToUnixTimeSeconds()
    Set-Content -LiteralPath $pidFile -Encoding ASCII -Value @(
        [string]$PID, $testData, [string]$currentEpoch, '5434', '', ''
    )
    $reused = Get-NativePostgresPidFileEvidence -Spec $testSpec
    if (-not $reused.ProcessExists -or $reused.SafeToDelegateRecovery -or
        $reused.Reason -cne 'pid-reused-by-other-process') {
        throw 'A reused PID owned by another executable did not fail closed.'
    }

    $otherData = Join-Path $evidenceRoot 'other-data'
    Set-Content -LiteralPath $pidFile -Encoding ASCII -Value @(
        [string]$stalePid, $otherData, [string]$epoch, '5434', '', ''
    )
    $wrongData = Get-NativePostgresPidFileEvidence -Spec $testSpec
    if ($wrongData.MetadataVerified -or $wrongData.SafeToDelegateRecovery -or
        $wrongData.Reason -cne 'unexpected-data-directory') {
        throw 'A PID file for another data directory did not fail closed.'
    }
} finally {
    Remove-Item -LiteralPath $evidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
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
# Verify bounded, identity-scoped cleanup instead of the old graceful
# taskkill sequence that could strand descendants when the parent exits first.
foreach ($needed in @(
    "tray quit requested",
    "controller shutdown cleanup started",
    "controller shutdown completed; native ports free",
    "controller cleanup incomplete; native ports still occupied",
    '& $taskkill /PID $entry.Pid /T /F',
    '$p.StartTime.ToUniversalTime() -ne $entry.StartTime'
)) {
    if (-not $text.Contains($needed)) { throw "Owned-tree cleanup guard absent: $needed" }
}
if ($text.Contains('& $taskkill /PID $entry.Pid /T 2>$null')) {
    throw 'The old two-phase graceful taskkill can strand descendant Node processes.'
}
if (-not $guiText.Contains('gui-exit.log')) {
    throw 'Invisible launcher must record an exit status for troubleshooting.'
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
