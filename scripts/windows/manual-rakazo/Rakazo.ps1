# Pilot: one manually launched Rakazo native controller. No Windows autostart.
[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Run', 'Child')]
    [string]$Action = 'Preflight',
    [ValidateSet('api', 'worker', 'web', 'host')]
    [string]$Role = 'api'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$origin = 'http://127.0.0.1:3100'
$webUrl = 'http://127.0.0.1:5173'
$launcherRoot = Join-Path $HOME 'Desktop\Rakazo Tunnel'
$client = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\bin\tunnel-client.exe'
$credential = Join-Path $env:LOCALAPPDATA 'Rakazo\windows-host\host-credential.dpapi'
$stateDir = Join-Path $env:LOCALAPPDATA 'Rakazo\manual-launcher'
$owned = [System.Collections.Generic.List[object]]::new()
$script:tunnelOwnership = $null
$script:launchStage = 'initial'
function Write-RakazoLaunchStage([string]$stage) {
    $script:launchStage = $stage
    # Log only a fixed startup stage; never write environment values or CLI output.
    Write-Host ('[Rakazo] ' + $stage)
    try {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $stateDir 'launcher-stage.log') -Encoding UTF8 -Value (
            '{0:u} {1}' -f [DateTime]::UtcNow, $stage
        )
    } catch {
        Write-Warning 'Could not write the stage log; console status remains available.'
    }
}
. (Join-Path $PSScriptRoot 'Tunnel.Diagnostics.ps1')
. (Join-Path $PSScriptRoot 'Tunnel.Control.ps1')
. (Join-Path $PSScriptRoot 'Native.TrayUpdates.ps1')
. (Join-Path $PSScriptRoot 'Native.PostgresEvidence.ps1')

function Test-Http([string]$url) {
    try {
        $result = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
        return $result.StatusCode -eq 200
    } catch { return $false }
}
function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
        Select-Object -First 1)
}
function Get-TunnelState {
    # The CLI returns JSON properties ready/healthy/process_running/runtime_state/tunnel_id.
    # Keep the complete payload private: it also contains connection/profile metadata.
    $state = [ordered]@{
        CliOk = $false
        IdentityMatches = $false
        ProcessRunning = $false
        VerifiedLocalProcess = $false
        LiveHealth = $false
        Ready = $false
        Healthy = $false
        RuntimeState = 'unknown'
    }
    if (-not (Test-Path -LiteralPath $client)) { return [pscustomobject]$state }
    $configPath = Join-Path $launcherRoot 'config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return [pscustomobject]$state }
    try {
        $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($cfg.Version -ne 4 -or $cfg.Alias -cne 'rakazo' -or
            ([string]$cfg.TunnelId) -notmatch '^tunnel_[A-Za-z0-9_-]+$') {
            return [pscustomobject]$state
        }
        $protectedKey = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\runtime-key.dpapi'
        $data = Get-RakazoAuthenticatedTunnelStatus -ClientPath $client -Alias 'rakazo' -EncryptedKeyPath $protectedKey
        $state.CliOk = $true
        $state.IdentityMatches = [string]::Equals(
            [string]$data.tunnel_id, [string]$cfg.TunnelId, [StringComparison]::Ordinal
        )
        $state.ProcessRunning = $data.process_running -eq $true
        $state.VerifiedLocalProcess = Test-RakazoExistingTunnelProcessEvidence -Runtime $data -ClientPath $client
        $state.LiveHealth = Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$data.health_url)
        $state.Ready = $data.ready -eq $true
        $state.Healthy = $data.healthy -eq $true
        $runtime = [string]$data.runtime_state
        if ($runtime -cmatch '^[A-Za-z_-]{1,32}$') { $state.RuntimeState = $runtime }
    } catch {
        # Fail closed; never print raw JSON, profile paths or credentials.
    }
    return [pscustomobject]$state
}
function Test-TunnelReady {
    $state = Get-TunnelState
    return ($state.CliOk -and $state.IdentityMatches -and $state.Ready -and
        $state.Healthy -and ($state.LiveHealth -or $state.VerifiedLocalProcess))
}
function Get-NativePostgresSpec {
    return [pscustomobject]@{
        Bin = Join-Path $HOME 'RakazoRuntime\postgresql\bin'
        Data = Join-Path $HOME 'RakazoData\postgres17'
        Log = Join-Path $HOME 'RakazoData\postgres17.log'
        Port = 5434
    }
}
function Get-NativePostgresDiagnostic {
    # Read-only. The specific cluster, server executable and listening PID must agree.
    $state = [ordered]@{
        NativePostgresRuntimePresent = $false
        NativePostgresClusterVerified = $false
        NativePostgresProcessVerified = $false
        NativePostgresReady = $false
    }
    $spec = Get-NativePostgresSpec
    $pgCtl = Join-Path $spec.Bin 'pg_ctl.exe'
    $pgIsReady = Join-Path $spec.Bin 'pg_isready.exe'
    $pgExe = Join-Path $spec.Bin 'postgres.exe'
    if (-not (Test-Path -LiteralPath $pgCtl -PathType Leaf) -or
        -not (Test-Path -LiteralPath $pgIsReady -PathType Leaf) -or
        -not (Test-Path -LiteralPath $pgExe -PathType Leaf)) {
        return [pscustomobject]$state
    }
    $state.NativePostgresRuntimePresent = $true
    try {
        $versionFile = Join-Path $spec.Data 'PG_VERSION'
        if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf) -or
            (Get-Content -LiteralPath $versionFile -Raw).Trim() -cne '17') {
            return [pscustomobject]$state
        }
        $state.NativePostgresClusterVerified = $true
        $pidFile = Join-Path $spec.Data 'postmaster.pid'
        if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
            return [pscustomobject]$state
        }
        $pidLines = @(Get-Content -LiteralPath $pidFile)
        # On Windows PostgreSQL may leave postmaster.pid line 5 (listen addresses)
        # empty even when -h 127.0.0.1 was used. Validate the actual bound TCP
        # listener below instead of treating this advisory line as authoritative.
        if ($pidLines.Count -lt 4) { return [pscustomobject]$state }
        $serverPid = [int]$pidLines[0].Trim()
        if ($serverPid -le 0 -or $pidLines[3].Trim() -cne '5434') {
            return [pscustomobject]$state
        }
        $expectedData = [IO.Path]::GetFullPath($spec.Data).TrimEnd('\', '/')
        $reportedData = [IO.Path]::GetFullPath($pidLines[1].Trim()).TrimEnd('\', '/')
        if (-not [string]::Equals($expectedData, $reportedData,
            [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]$state
        }
        $serverProcess = Get-Process -Id $serverPid -ErrorAction Stop
        if (-not $serverProcess.Path -or -not [string]::Equals(
            [IO.Path]::GetFullPath($serverProcess.Path),
            [IO.Path]::GetFullPath($pgExe),
            [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]$state
        }
        $expectedStart = [DateTimeOffset]::FromUnixTimeSeconds([long]$pidLines[2].Trim()).UtcDateTime
        if ([Math]::Abs(($serverProcess.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -gt 20) {
            return [pscustomobject]$state
        }
        $listeners = @(Get-NetTCPConnection -LocalPort $spec.Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $serverPid -and $_.LocalAddress -eq '127.0.0.1' })
        if ($listeners.Count -eq 0) { return [pscustomobject]$state }
        $state.NativePostgresProcessVerified = $true
        # pg_isready tests availability, not authentication. App health checks credentials later.
        $null = & $pgIsReady -h 127.0.0.1 -p $spec.Port -t 3 2>$null
        $state.NativePostgresReady = $LASTEXITCODE -eq 0
    } catch {
        # No raw environment, private data or process command line in diagnostics.
    }
    return [pscustomobject]$state
}
function Get-Preflight {
    $envPath = Join-Path $repo '.env'
    $launcherConfig = Join-Path $launcherRoot 'config.json'
    $hasRepo = (Test-Path -LiteralPath (Join-Path $repo 'pnpm-workspace.yaml')) -and
        (Test-Path -LiteralPath (Join-Path $repo 'packages\adapters\src\chatgpt-mcp.ts'))
    $identityMatches = $false
    $mcpPointsNew = $false
    if (Test-Path -LiteralPath $launcherConfig) {
        $cfg = Get-Content -LiteralPath $launcherConfig -Raw | ConvertFrom-Json
        $identityMatches = ($cfg.Version -eq 4 -and $cfg.Alias -eq 'rakazo' -and ([string]$cfg.TunnelId) -match '^tunnel_[A-Za-z0-9_-]+$')
        $mcp = ([string]$cfg.McpCommand).Replace('\', '/')
        $normalizedRepo = $repo.Replace('\', '/') + '/'
        $mcpPointsNew = $mcp.IndexOf($normalizedRepo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    $correctDatabase = $false
    $databaseEndpointMatches = $false
    $hostFlag = $false
    $workerDispatchConfigured = $false
    if (Test-Path -LiteralPath $envPath) {
        # Never print .env contents or private connection strings.
        $lines = @(Get-Content -LiteralPath $envPath)
        $db = @($lines | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' })
        if ($db.Count -eq 1) {
            try {
                $databaseUrl = ($db[0] -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"', "'")
                $uri = [Uri]$databaseUrl
                $username = [Uri]::UnescapeDataString(([string]$uri.UserInfo -split ':', 2)[0])
                $correctDatabase = $uri.AbsolutePath.TrimStart('/') -ceq 'rakazo_next'
                $databaseEndpointMatches = $correctDatabase -and
                    $uri.Scheme -in @('postgresql', 'postgres') -and
                    $uri.Host -ceq '127.0.0.1' -and $uri.Port -eq 5434 -and
                    $username -ceq 'rakazo'
            } catch {
                # Fail closed; never display DATABASE_URL or its credentials.
            }
        }
        $flag = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_ENABLED\s*=' })
        $hostFlag = $flag.Count -eq 1 -and $flag[0] -match '=\s*["'']?true["'']?\s*$'
        $internal = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN\s*=' })
        $internalUrl = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_API_INTERNAL_URL\s*=' })
        if ($internal.Count -eq 1 -and $internalUrl.Count -eq 1) {
            $tokenText = $internal[0] -replace '^\s*RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN\s*=\s*', ''
            $tokenLength = ($tokenText.Trim([char[]]@('"', "'"))).Length
            $workerDispatchConfigured = $tokenLength -ge 32 -and
                ($internalUrl[0] -match '127[.]0[.]0[.]1:3100|localhost:3100')
        }
    }
    $database = Get-NativePostgresDiagnostic
    $tunnel = Get-TunnelState
    $tunnelColdStartAllowed = $tunnel.CliOk -and $tunnel.IdentityMatches -and
        -not ($tunnel.ProcessRunning -or $tunnel.VerifiedLocalProcess -or $tunnel.LiveHealth -or
            $tunnel.Ready -or $tunnel.Healthy)
    # A fully verified running R may be reused, but is always BORROWED:
    # this controller must not connect it again or stop it on Quit.
    $tunnelAttachAllowed = $tunnel.CliOk -and $tunnel.IdentityMatches -and
        $tunnel.ProcessRunning -and $tunnel.VerifiedLocalProcess -and
        $tunnel.LiveHealth -and $tunnel.Ready -and $tunnel.Healthy -and
        $tunnel.RuntimeState -ceq 'ready'
    return [pscustomobject]@{
        NativePostgresRuntimePresent = $database.NativePostgresRuntimePresent
        NativePostgresClusterVerified = $database.NativePostgresClusterVerified
        NativePostgresProcessVerified = $database.NativePostgresProcessVerified
        NativePostgresReady = $database.NativePostgresReady
        DatabaseEndpointMatches = $databaseEndpointMatches
        NativeCheckoutExists = $hasRepo
        ExistingAliasMatches = $identityMatches
        ExistingMcpUsesNewCheckout = $mcpPointsNew
        DatabaseIsCloned = $correctDatabase
        HostFeatureInEnv = $hostFlag
        WorkerDispatchConfigured = $workerDispatchConfigured
        ProtectedHostCredentialExists = Test-Path -LiteralPath $credential
        ProtectedTunnelSessionExists = Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\session-token.dpapi')
        CorepackAvailable = [bool](Get-Command corepack -ErrorAction SilentlyContinue)
        ApiHealthy = Test-Http "$origin/health"
        WebHealthy = Test-Http $webUrl
        ApiPortOccupied = Test-Port 3100
        WebPortOccupied = Test-Port 5173
        ExistingTunnelCliOk = $tunnel.CliOk
        ExistingTunnelIdMatches = $tunnel.IdentityMatches
        ExistingTunnelProcessRunning = $tunnel.ProcessRunning
        ExistingTunnelProcessVerified = $tunnel.VerifiedLocalProcess
        ExistingTunnelLiveHealth = $tunnel.LiveHealth
        ExistingTunnelReady = $tunnel.Ready -and $tunnel.IdentityMatches -and $tunnel.CliOk
        ExistingTunnelHealthy = $tunnel.Healthy
        ExistingTunnelRuntimeState = $tunnel.RuntimeState
        ExistingTunnelColdStartAllowed = $tunnelColdStartAllowed
        ExistingTunnelAttachAllowed = $tunnelAttachAllowed
        OldTrayRunning = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -in @('powershell.exe', 'pwsh.exe') -and
            ([string]$_.CommandLine).Contains('Rakazo.Tray.ps1')
        }).Count)
        ExternalWorkerDetected = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $cmd = ([string]$_.CommandLine).Replace('\', '/')
            $_.Name -eq 'node.exe' -and ($cmd.Contains('/apps/worker/') -or $cmd.Contains('@rakazo/worker'))
        }).Count)
        ExternalHostDetected = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $cmd = ([string]$_.CommandLine).Replace('\', '/')
            $_.Name -eq 'node.exe' -and ($cmd.Contains('/apps/windows-host/') -or $cmd.Contains('@rakazo/windows-host'))
        }).Count)
    }
}
function Get-ExistingTunnelSpec {
    $configPath = Join-Path $launcherRoot 'config.json'
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($cfg.Version -ne 4 -or $cfg.Alias -cne 'rakazo' -or
        ([string]$cfg.TunnelId) -notmatch '^tunnel_[A-Za-z0-9_-]+$' -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$cfg.TunnelClient),
            [IO.Path]::GetFullPath($client), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Original R identity or client path changed; refusing lifecycle operation.'
    }
    $mcp = ([string]$cfg.McpCommand).Replace('\', '/')
    if ($mcp.IndexOf(($repo.Replace('\', '/') + '/'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Original R MCP no longer points at the canonical native checkout.'
    }
    return [pscustomobject]@{
        ClientPath = $client
        TunnelId = [string]$cfg.TunnelId
        McpCommand = [string]$cfg.McpCommand
        KeyPath = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\runtime-key.dpapi'
        SessionPath = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\session-token.dpapi'
    }
}
function Get-VerifiedRunningTunnelIdentity {
    # Returns only identity for the original, live registered R. Does not connect,
    # create, adopt or grant ownership. The raw authenticated CLI payload stays private.
    $spec = Get-ExistingTunnelSpec
    $result = Get-RakazoAuthenticatedTunnelStatus -ClientPath $spec.ClientPath -Alias 'rakazo' -EncryptedKeyPath $spec.KeyPath
    if (-not [string]::Equals([string]$result.tunnel_id, $spec.TunnelId, [StringComparison]::Ordinal) -or
        $result.process_running -ne $true -or $result.ready -ne $true -or $result.healthy -ne $true -or
        [string]$result.runtime_state -cne 'ready' -or
        -not (Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$result.health_url)) -or
        -not (Test-RakazoExistingTunnelProcessEvidence -Runtime $result -ClientPath $spec.ClientPath)) {
        throw 'Existing R is not fully verified for read-only reuse. No connect or takeover.'
    }
    return [pscustomobject]@{
        Pid = [int]$result.process.pid
        StartedAt = [string]$result.process.started_at
        TunnelId = $spec.TunnelId
    }
}
function Assert-SameBorrowedTunnel($previous) {
    if ($null -eq $previous) { throw 'Missing borrowed tunnel identity.' }
    $current = Get-VerifiedRunningTunnelIdentity
    if ($current.Pid -ne $previous.Pid -or
        $current.StartedAt -cne $previous.StartedAt -or
        $current.TunnelId -cne $previous.TunnelId) {
        throw 'The existing R identity changed while native services started. Leave its lifecycle untouched.'
    }
}
function Start-ControllerTunnel {
    $spec = Get-ExistingTunnelSpec
    $before = Get-TunnelState
    if (-not ($before.CliOk -and $before.IdentityMatches) -or
        $before.ProcessRunning -or $before.VerifiedLocalProcess -or
        $before.LiveHealth -or $before.Ready -or $before.Healthy) {
        throw 'The existing R is already live or cannot be proved stopped. No duplicate runtime will start.'
    }
    [void](Invoke-RakazoRegisteredRuntimeOperation -Operation connect -ClientPath $spec.ClientPath -TunnelId $spec.TunnelId -McpCommand $spec.McpCommand -KeyPath $spec.KeyPath -SessionPath $spec.SessionPath)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $result = Get-RakazoAuthenticatedTunnelStatus -ClientPath $spec.ClientPath -Alias 'rakazo' -EncryptedKeyPath $spec.KeyPath
            if ([string]::Equals([string]$result.tunnel_id, $spec.TunnelId, [StringComparison]::Ordinal) -and
                $result.ready -eq $true -and $result.healthy -eq $true -and
                (Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$result.health_url)) -and
                (Test-RakazoExistingTunnelProcessEvidence -Runtime $result -ClientPath $client)) {
                $script:tunnelOwnership = [pscustomobject]@{
                    Pid = [int]$result.process.pid
                    StartedAt = [string]$result.process.started_at
                    TunnelId = $spec.TunnelId
                }
                return
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'Existing R connect succeeded but exact local process ownership could not be verified. Leave tunnel untouched for manual recovery.'
}
function Stop-ControllerTunnel {
    if ($null -eq $script:tunnelOwnership) { return }
    try {
        $spec = Get-ExistingTunnelSpec
        if (-not [string]::Equals($spec.TunnelId, $script:tunnelOwnership.TunnelId, [StringComparison]::Ordinal)) {
            throw 'Registered tunnel identity changed since controller start.'
        }
        [void](Invoke-RakazoRegisteredRuntimeOperation -Operation stop -ClientPath $spec.ClientPath -TunnelId $spec.TunnelId -McpCommand $spec.McpCommand -KeyPath $spec.KeyPath -SessionPath $spec.SessionPath -ExpectedStopPid $script:tunnelOwnership.Pid -ExpectedStopStart $script:tunnelOwnership.StartedAt)
    } catch {
        Write-Warning 'Could not verify exclusive R ownership at exit. Existing tunnel was left untouched.'
    } finally {
        $script:tunnelOwnership = $null
    }
}
function Ensure-NativePostgres {
    # Start/reuse only the already-initialized native Rakazo cluster. Never create or reset it.
    $spec = Get-NativePostgresSpec
    $before = Get-NativePostgresDiagnostic
    if (-not ($before.NativePostgresRuntimePresent -and $before.NativePostgresClusterVerified)) {
        throw 'Expected native PostgreSQL 17 Rakazo runtime or prepared cluster was not found.'
    }
    if ($before.NativePostgresProcessVerified) {
        if ($before.NativePostgresReady) { return }
        throw 'The identified native PostgreSQL is running but not ready. No duplicate start.'
    }
    $pidEvidence = Get-NativePostgresPidFileEvidence -Spec $spec
    if ($pidEvidence.Present) {
        if (-not $pidEvidence.SafeToDelegateRecovery) {
            throw ('The native PostgreSQL PID file exists but safe recovery is not proven: ' +
                $pidEvidence.Reason + '. Manual recovery required.')
        }
        Write-RakazoLaunchStage 'stale postgres pidfile verified; delegating recovery to pg_ctl'
    }
    if (Test-Port $spec.Port) {
        throw 'The target PostgreSQL port is occupied by an unverified process.'
    }
    $pgCtl = Join-Path $spec.Bin 'pg_ctl.exe'
    # PostgreSQL can inherit an open native pipeline handle on Windows. Running
    # pg_ctl through PowerShell's "| Out-Null" may then wait on the *server*
    # long after pg_ctl has started it. Wait only for the pg_ctl process itself.
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pgCtl
    $psi.Arguments = '-D "' + $spec.Data + '" -l "' + $spec.Log +
        '" -o "-h 127.0.0.1 -p 5434" -w -t 60 start'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    # Do not redirect stdout/stderr into a pipe inherited by a long-lived server.
    $ctlProcess = [Diagnostics.Process]::new()
    $ctlProcess.StartInfo = $psi
    try {
        if (-not $ctlProcess.Start()) { throw 'Could not start native PostgreSQL control process.' }
        if (-not $ctlProcess.WaitForExit(70000)) {
            try { $ctlProcess.Kill() } catch { }
            throw 'Native pg_ctl exceeded its bounded 70-second startup wait. Check cluster state before retrying.'
        }
        if ($ctlProcess.ExitCode -ne 0) {
            throw 'Native pg_ctl reported startup failure. Inspect the dedicated postgres17.log; do not reset data.'
        }
    } finally {
        $ctlProcess.Dispose()
    }
    Write-RakazoLaunchStage 'pg_ctl returned; verifying native postgres identity'
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $after = Get-NativePostgresDiagnostic
        if ($after.NativePostgresProcessVerified -and $after.NativePostgresReady) { return }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Native PostgreSQL started but exact process identity/readiness could not be verified.'
    # Intentionally keep this durable database running on Quit; never stop shared processes.
}
function Wait-Http([string]$url, [int]$seconds, [Diagnostics.Process]$ownedProcess = $null) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http $url) { return $true }
        if ($null -ne $ownedProcess) {
            $ownedProcess.Refresh()
            if ($ownedProcess.HasExited) { return $false }
        }
        Start-Sleep -Seconds 1
    }
    return $false
}
function Start-OwnedRole([string]$role) {
    $powershell = (Get-Process -Id $PID).Path
    $argument = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
        $PSCommandPath + '" -Action Child -Role ' + $role
    $stdout = Join-Path $stateDir ($role + '.stdout.log')
    $stderr = Join-Path $stateDir ($role + '.stderr.log')
    $args = @{
        FilePath = $powershell
        ArgumentList = $argument
        WorkingDirectory = $repo
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        PassThru = $true
    }
    $p = Start-Process @args
    $owned.Add([pscustomobject]@{
        Role = $role
        Pid = $p.Id
        StartTime = $p.StartTime.ToUniversalTime()
    })
    return $p
}
function Stop-Owned {
    # Stop only controller-created launchers with the exact recorded PID/start-time.
    # Force the VERIFIED launcher tree in one operation: a two-step graceful
    # taskkill can terminate the launcher first and strand its Node descendants.
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        $entry = $owned[$i]
        $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
        if (-not $p) {
            Write-RakazoLaunchStage ('owned ' + $entry.Role + ' launcher missing; descendants require separate verification')
            continue
        }
        try {
            if ($p.StartTime.ToUniversalTime() -ne $entry.StartTime) {
                Write-Warning ('The recorded ' + $entry.Role + ' launcher PID changed identity. No process was stopped.')
                continue
            }
            Write-RakazoLaunchStage ('stopping verified owned ' + $entry.Role + ' process tree')
            # /T /F targets descendants of this ONE identity-verified owned
            # launcher, not all node.exe, Docker, PostgreSQL or the borrowed R.
            & $taskkill /PID $entry.Pid /T /F 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Warning ('The verified ' + $entry.Role + ' launcher tree reported incomplete shutdown.')
            }
        } catch {
            Write-Warning ('Unable to clean up the verified ' + $entry.Role + ' launcher tree. Inspect its PID before recovery.')
        }
    }
}
if ($Action -eq 'Child') {
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'pnpm-workspace.yaml'))) {
        throw 'Rakazo checkout missing'
    }
    Set-Location -LiteralPath $repo
    if ($Role -eq 'host') {
        if (-not (Test-Path -LiteralPath $credential)) {
            throw 'No previously paired Windows Host credential. Never auto-pair.'
        }
        $env:RAKAZO_WINDOWS_HOST_ORIGIN = $origin
        $env:RAKAZO_WINDOWS_HOST_PAIRING_TOKEN = ''
        $env:RAKAZO_WINDOWS_HOST_ID = ''
        $env:RAKAZO_WINDOWS_HOST_CREDENTIAL = ''
        # Owner-requested full existing Windows Host capabilities. Keep built-in
        # bounded command/file/GUI contracts; this does NOT create another pairing.
        $env:RAKAZO_WINDOWS_PROCESS_ENABLED = 'true'
        $env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = 'true'
        $env:RAKAZO_WINDOWS_GUI_ENABLED = 'true'
        # The native PowerShell child does not automatically load root .env for
        # Windows Host. Import ONLY the chosen OpenCLI profile, never the other
        # private settings. A configured profile has precedence over inheritance.
        $openCliProfileLines = @(Get-Content -LiteralPath (Join-Path $repo '.env') -ErrorAction Stop |
            Where-Object { $_ -match '^\s*RAKAZO_OPENCLI_PROFILE\s*=' })
        if ($openCliProfileLines.Count -gt 1) {
            throw 'Duplicate private OpenCLI profile settings; refusing ambiguous browser selection.'
        }
        if ($openCliProfileLines.Count -eq 1) {
            $rawProfile = ($openCliProfileLines[0] -replace '^\s*RAKAZO_OPENCLI_PROFILE\s*=\s*', '').Trim()
            if ($rawProfile.Length -ge 2 -and
                (($rawProfile.StartsWith('"') -and $rawProfile.EndsWith('"')) -or
                 ($rawProfile.StartsWith("'") -and $rawProfile.EndsWith("'")))) {
                $rawProfile = $rawProfile.Substring(1, $rawProfile.Length - 2)
            }
            if ($rawProfile -cnotmatch '^[A-Za-z0-9_-]{1,100}$') {
                throw 'Private OpenCLI profile is invalid; refusing browser selection.'
            }
            $env:RAKAZO_OPENCLI_PROFILE = $rawProfile
        }
        # Never print the profile ID, full .env, browser state or credentials.
    }
    $packages = @{
        api = '@rakazo/api'
        worker = '@rakazo/worker'
        web = '@rakazo/web'
        host = '@rakazo/windows-host'
    }
    $package = $packages[$Role]
    $verb = if ($Role -eq 'web') { 'dev' } else { 'start' }
    & corepack pnpm --filter $package $verb
    exit $LASTEXITCODE
}
$before = Get-Preflight
if ($Action -eq 'Preflight') {
    $before | Format-List
    Write-Host 'READ-ONLY PREFLIGHT COMPLETE. No services started, stopped or installed.'
    return
}
$mutex = [Threading.Mutex]::new($false, 'Local\RakazoNativeManualController')
$acquired = $false
$tray = $null
$timer = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        Write-Warning 'Rakazo controller mutex is busy. Another Run is active or awaiting an error dialog; no duplicate was started.'
        if ($before.WebHealthy) { Start-Process $webUrl }
        return
    }
    Write-RakazoLaunchStage 'controller acquired'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ($before.NativeCheckoutExists -and $before.ExistingAliasMatches -and
        $before.ExistingMcpUsesNewCheckout -and $before.DatabaseIsCloned -and
        $before.DatabaseEndpointMatches -and $before.NativePostgresRuntimePresent -and
        $before.NativePostgresClusterVerified -and
        $before.HostFeatureInEnv -and $before.WorkerDispatchConfigured -and
        $before.ProtectedHostCredentialExists -and
        $before.ProtectedTunnelSessionExists -and
        $before.CorepackAvailable)) {
        throw 'Preflight failed. Run Rakazo.ps1 -Action Preflight before activating.'
    }
    if ($before.OldTrayRunning) {
        throw 'Old Rakazo tray is still open. Close only the old indicator before cutover; do not stop its existing tunnel.'
    }
    if ($before.ExternalWorkerDetected -or $before.ExternalHostDetected) {
        throw 'A manually launched Worker or Windows Host was detected. Do not launch a duplicate.'
    }
    if ($before.ApiPortOccupied -or $before.WebPortOccupied) {
        throw 'API/Web is already running outside this controller. Close the pilot windows during a planned handoff; never duplicate them.'
    }
    if (-not ($before.ExistingTunnelColdStartAllowed -or $before.ExistingTunnelAttachAllowed)) {
        throw 'Existing R is neither conclusively stopped nor fully verified for read-only reuse. No duplicate connect.'
    }
    $borrowedTunnel = $null
    if ($before.ExistingTunnelAttachAllowed) {
        # Recheck under the controller mutex and pin exact identity before other startup work.
        $borrowedTunnel = Get-VerifiedRunningTunnelIdentity
        Write-RakazoLaunchStage 'existing R verified for read-only reuse (unowned)'
    }
    Write-RakazoLaunchStage 'native postgres check/start'
    Ensure-NativePostgres
    Write-RakazoLaunchStage 'native postgres ready'
    $api = Start-OwnedRole 'api'
    Write-RakazoLaunchStage 'api child started; waiting for health'
    # Bounded cold start; fail early if the directly owned launcher process exits.
    if (-not (Wait-Http "$origin/health" 360 $api)) { throw 'Native API startup failed or timed out; inspect manual-launcher logs.' }
    Write-RakazoLaunchStage 'api ready'
    $worker = Start-OwnedRole 'worker'
    Write-RakazoLaunchStage 'worker child started'
    Start-Sleep -Seconds 3
    $worker.Refresh()
    if ($worker.HasExited) { throw 'Worker exited early; inspect manual-launcher logs.' }
    $web = Start-OwnedRole 'web'
    Write-RakazoLaunchStage 'web child started; waiting for health'
    if (-not (Wait-Http $webUrl 60 $web)) { throw 'Native Web startup failed or timed out; inspect manual-launcher logs.' }
    Write-RakazoLaunchStage 'web ready'
    $windowsHostProcess = Start-OwnedRole 'host'
    Write-RakazoLaunchStage 'host child started'
    Start-Sleep -Seconds 3
    $windowsHostProcess.Refresh()
    if ($windowsHostProcess.HasExited) { throw 'Previously paired Windows Host exited early; inspect manual-launcher logs.' }
    if ($null -ne $borrowedTunnel) {
        Assert-SameBorrowedTunnel $borrowedTunnel
        Write-RakazoLaunchStage 'existing R reused read-only; creating tray (R unowned)'
    } else {
        Write-RakazoLaunchStage 'connecting existing registered R'
        Start-ControllerTunnel
        Write-RakazoLaunchStage 'existing R connected; creating tray (R owned)'
    }
    $tray = [System.Windows.Forms.NotifyIcon]::new()
    $iconFile = Join-Path $repo 'apps\desktop\assets\icon.ico'
    $tray.Icon = if (Test-Path -LiteralPath $iconFile) {
        [System.Drawing.Icon]::new($iconFile)
    } else { [System.Drawing.SystemIcons]::Application }
    $tray.Text = 'Rakazo - checking local services'
    $menu = [System.Windows.Forms.ContextMenuStrip]::new()
    $open = $menu.Items.Add('Open Rakazo')
    $status = $menu.Items.Add('Status')
    $quit = $menu.Items.Add('Quit Rakazo')
    $open.add_Click({ Start-Process $webUrl })
    $status.add_Click({
        $s = Get-Preflight
        $message = 'API: {0}; Web: {1}; R: {2}; host credential: {3}. Verify host heartbeat through R.' -f
            $s.ApiHealthy, $s.WebHealthy, $s.ExistingTunnelReady, $s.ProtectedHostCredentialExists
        [System.Windows.Forms.MessageBox]::Show($message, 'Rakazo status') | Out-Null
    })
    $ctx = [System.Windows.Forms.ApplicationContext]::new()
    Add-RakazoNativeUpdateMenu -Menu $menu -Context $ctx -Repo $repo -Updater (Join-Path $PSScriptRoot 'Native.Update.ps1')
    $quit.add_Click({ Write-RakazoLaunchStage 'tray quit requested'; $ctx.ExitThread() })
    $tray.ContextMenuStrip = $menu
    $tray.Visible = $true
    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = 10000
    $timer.add_Tick({
        $healthy = (Test-Http "$origin/health") -and (Test-Http $webUrl) -and (Test-TunnelReady)
        $tray.Icon = if ($healthy) { [System.Drawing.SystemIcons]::Information } else { [System.Drawing.SystemIcons]::Warning }
        # This local indicator does not claim end-to-end Host verification.
        $tray.Text = if ($healthy) {
            'Rakazo locally ready; verify physical host via R'
        } else { 'Rakazo - local service or tunnel needs attention' }
    })
    $timer.Start()
    Write-RakazoLaunchStage 'tray active'
    Start-Process $webUrl
    [System.Windows.Forms.Application]::Run($ctx)
} catch {
    # An indefinite modal MessageBox hid the startup error and held the controller mutex.
    # Report the stage in console and local stage log; never log secrets from exception text.
    Write-RakazoLaunchStage ('FAILED at ' + $script:launchStage)
    throw
} finally {
    if ($acquired) { Write-RakazoLaunchStage 'controller shutdown cleanup started' }
    try {
        if ($timer) { $timer.Stop(); $timer.Dispose() }
        if ($tray) { $tray.Visible = $false; $tray.Dispose() }
        Stop-ControllerTunnel
        Stop-Owned
        if ($acquired) {
            # These ports belonged to this controller at startup; do not kill
            # anything new that might subsequently bind them.
            $portsFree = $false
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            do {
                $portsFree = -not (Test-Port 3100) -and -not (Test-Port 5173)
                if ($portsFree) { break }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $portsFree) {
                Write-Warning 'Native API/Web ports remain occupied after owned-tree cleanup. No unverified process will be stopped.'
                Write-RakazoLaunchStage 'controller cleanup incomplete; native ports still occupied'
            } else {
                Write-RakazoLaunchStage 'controller shutdown completed; native ports free'
            }
        }
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
