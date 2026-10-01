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
function Test-TunnelReady {
    if (-not (Test-Path -LiteralPath $client)) { return $false }
    $configPath = Join-Path $launcherRoot 'config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return $false }
    try {
        $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($cfg.Alias -ne 'rakazo' -or [string]::IsNullOrWhiteSpace([string]$cfg.TunnelId)) { return $false }
        $output = & $client runtimes status rakazo 2>$null
        $line = [string]($output -join ' ')
        if ($LASTEXITCODE -ne 0 -or $line -notmatch '^\s*rakazo\s+ready\s+(\S+)') { return $false }
        return $Matches[1] -ceq [string]$cfg.TunnelId
    } catch { return $false }
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
        $identityMatches = ($cfg.Version -eq 4 -and $cfg.Alias -eq 'rakazo' -and ([string]$cfg.TunnelId) -match '^tunnel_[A-Za-z0-9_-]+
        $mcp = ([string]$cfg.McpCommand).Replace('\', '/')
        $normalizedRepo = $repo.Replace('\', '/') + '/'
        $mcpPointsNew = $mcp.IndexOf($normalizedRepo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    $correctDatabase = $false
    $hostFlag = $false
    $workerDispatchConfigured = $false
    if (Test-Path -LiteralPath $envPath) {
        # Never print .env contents or private connection strings.
        $lines = @(Get-Content -LiteralPath $envPath)
        $db = @($lines | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' })
        $correctDatabase = $db.Count -eq 1 -and $db[0] -match '/rakazo_next(?:[?''"]|$)'
        $flag = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_ENABLED\s*=' })
        $hostFlag = $flag.Count -eq 1 -and $flag[0] -match '=\s*["'']?true["'']?\s*
    }
    return [pscustomobject]@{
        NativeCheckoutExists = $hasRepo
        ExistingAliasMatches = $identityMatches
        ExistingMcpUsesNewCheckout = $mcpPointsNew
        DatabaseIsCloned = $correctDatabase
        HostFeatureInEnv = $hostFlag
        WorkerDispatchConfigured = $workerDispatchConfigured
        ProtectedHostCredentialExists = Test-Path -LiteralPath $credential
        CorepackAvailable = [bool](Get-Command corepack -ErrorAction SilentlyContinue)
        ApiHealthy = Test-Http "$origin/health"
        WebHealthy = Test-Http $webUrl
        ApiPortOccupied = Test-Port 3100
        WebPortOccupied = Test-Port 5173
        ExistingTunnelReady = Test-TunnelReady
        OldTrayRunning = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -in @('powershell.exe', 'pwsh.exe') -and
            ([string]$_.CommandLine).Contains('Rakazo.Tray.ps1')
        }).Count)
        ExternalWorkerDetected = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and
            ([string]$_.CommandLine) -match '@rakazo[/\]worker|apps[/\]worker'
        }).Count)
        ExternalHostDetected = [bool](@(Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and
            ([string]$_.CommandLine) -match '@rakazo[/\]windows-host|apps[/\]windows-host'
        }).Count)
    }
}
function Wait-Http([string]$url, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http $url) { return $true }
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
    # Never stop an adopted process or another alias. Guard against reused PIDs.
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        $entry = $owned[$i]
        $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
        if (-not $p -or $p.StartTime.ToUniversalTime() -ne $entry.StartTime) { continue }
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        try {
            & $taskkill /PID $entry.Pid /T 2>$null | Out-Null
            Start-Sleep -Milliseconds 500
            $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
            if ($p -and $p.StartTime.ToUniversalTime() -eq $entry.StartTime) {
                & $taskkill /PID $entry.Pid /T /F 2>$null | Out-Null
            }
        } catch {
            # Only the originally created PID is eligible for termination.
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
        $env:RAKAZO_WINDOWS_PROCESS_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_GUI_ENABLED = 'false'
        $env:RAKAZO_OPENCLI_PROFILE = ''
        $env:RAKAZO_OPENCLI_ENTRY = ''
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
    exit 0
}
$mutex = [Threading.Mutex]::new($false, 'Local\RakazoNativeManualController')
$acquired = $false
$tray = $null
$timer = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        if ($before.WebHealthy) { Start-Process $webUrl }
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ($before.NativeCheckoutExists -and $before.ExistingAliasMatches -and
        $before.ExistingMcpUsesNewCheckout -and $before.DatabaseIsCloned -and
        $before.HostFeatureInEnv -and $before.WorkerDispatchConfigured -and
        $before.ProtectedHostCredentialExists -and
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
    if (-not $before.ExistingTunnelReady) {
        throw 'Existing R tunnel not ready. This pilot does not create a replacement tunnel or profile.'
    }
    # Only reuse the already existing shared PostgreSQL container.
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker CLI unavailable: shared PostgreSQL prerequisite.' }
    $postgres = & $docker.Source inspect --format '{{.State.Running}}' compose-postgres-1 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$postgres).Trim() -ne 'true') {
        throw 'Existing PostgreSQL container is not running. No new stack was created.'
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $api = Start-OwnedRole 'api'
    if (-not (Wait-Http "$origin/health" 60)) { throw 'Native API startup failed; inspect manual-launcher logs.' }
    $worker = Start-OwnedRole 'worker'
    Start-Sleep -Seconds 3
    if ($worker.HasExited) { throw 'Worker exited early; inspect manual-launcher logs.' }
    $web = Start-OwnedRole 'web'
    if (-not (Wait-Http $webUrl 60)) { throw 'Native Web startup failed; inspect manual-launcher logs.' }
    $host = Start-OwnedRole 'host'
    Start-Sleep -Seconds 3
    if ($host.HasExited) { throw 'Previously paired Windows Host exited early; inspect manual-launcher logs.' }
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
    $quit.add_Click({ $ctx.ExitThread() })
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
    Start-Process $webUrl
    [System.Windows.Forms.Application]::Run($ctx)
} catch {
    if ($Action -eq 'Run') {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Rakazo launcher') | Out-Null
        } catch { }
    }
    throw
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    Stop-Owned
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
)
        $mcp = ([string]$cfg.McpCommand).Replace('\', '/')
        $normalizedRepo = $repo.Replace('\', '/') + '/'
        $mcpPointsNew = $mcp.IndexOf($normalizedRepo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    $correctDatabase = $false
    $hostFlag = $false
    if (Test-Path -LiteralPath $envPath) {
        # Never print .env contents or private connection strings.
        $lines = @(Get-Content -LiteralPath $envPath)
        $db = @($lines | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' })
        $correctDatabase = $db.Count -eq 1 -and $db[0] -match '/rakazo_next(?:[?''"]|$)'
        $flag = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_ENABLED\s*=' })
        $hostFlag = $flag.Count -eq 1 -and $flag[0] -match '=\s*["'']?true["'']?\s*$'
    }
    return [pscustomobject]@{
        NativeCheckoutExists = $hasRepo
        ExistingAliasMatches = $identityMatches
        ExistingMcpUsesNewCheckout = $mcpPointsNew
        DatabaseIsCloned = $correctDatabase
        HostFeatureInEnv = $hostFlag
        ProtectedHostCredentialExists = Test-Path -LiteralPath $credential
        CorepackAvailable = [bool](Get-Command corepack -ErrorAction SilentlyContinue)
        ApiHealthy = Test-Http "$origin/health"
        WebHealthy = Test-Http $webUrl
        ApiPortOccupied = Test-Port 3100
        WebPortOccupied = Test-Port 5173
        ExistingTunnelReady = Test-TunnelReady
    }
}
function Wait-Http([string]$url, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http $url) { return $true }
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
    # Never stop an adopted process or another alias. Guard against reused PIDs.
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        $entry = $owned[$i]
        $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
        if (-not $p -or $p.StartTime.ToUniversalTime() -ne $entry.StartTime) { continue }
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        try {
            & $taskkill /PID $entry.Pid /T 2>$null | Out-Null
            Start-Sleep -Milliseconds 500
            $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
            if ($p -and $p.StartTime.ToUniversalTime() -eq $entry.StartTime) {
                & $taskkill /PID $entry.Pid /T /F 2>$null | Out-Null
            }
        } catch {
            # Only the originally created PID is eligible for termination.
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
        $env:RAKAZO_WINDOWS_PROCESS_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_GUI_ENABLED = 'false'
        $env:RAKAZO_OPENCLI_PROFILE = ''
        $env:RAKAZO_OPENCLI_ENTRY = ''
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
    exit 0
}
$mutex = [Threading.Mutex]::new($false, 'Local\RakazoNativeManualController')
$acquired = $false
$tray = $null
$timer = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        if ($before.WebHealthy) { Start-Process $webUrl }
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ($before.NativeCheckoutExists -and $before.ExistingAliasMatches -and
        $before.ExistingMcpUsesNewCheckout -and $before.DatabaseIsCloned -and
        $before.HostFeatureInEnv -and $before.ProtectedHostCredentialExists -and
        $before.CorepackAvailable)) {
        throw 'Preflight failed. Run Rakazo.ps1 -Action Preflight before activating.'
    }
    if ($before.ApiPortOccupied -or $before.WebPortOccupied) {
        throw 'API/Web is already running outside this controller. Close the pilot windows during a planned handoff; never duplicate them.'
    }
    if (-not $before.ExistingTunnelReady) {
        throw 'Existing R tunnel not ready. This pilot does not create a replacement tunnel or profile.'
    }
    # Only reuse the already existing shared PostgreSQL container.
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker CLI unavailable: shared PostgreSQL prerequisite.' }
    $postgres = & $docker.Source inspect --format '{{.State.Running}}' compose-postgres-1 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$postgres).Trim() -ne 'true') {
        throw 'Existing PostgreSQL container is not running. No new stack was created.'
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $api = Start-OwnedRole 'api'
    if (-not (Wait-Http "$origin/health" 60)) { throw 'Native API startup failed; inspect manual-launcher logs.' }
    $worker = Start-OwnedRole 'worker'
    Start-Sleep -Seconds 3
    if ($worker.HasExited) { throw 'Worker exited early; inspect manual-launcher logs.' }
    $web = Start-OwnedRole 'web'
    if (-not (Wait-Http $webUrl 60)) { throw 'Native Web startup failed; inspect manual-launcher logs.' }
    $host = Start-OwnedRole 'host'
    Start-Sleep -Seconds 3
    if ($host.HasExited) { throw 'Previously paired Windows Host exited early; inspect manual-launcher logs.' }
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
    $quit.add_Click({ $ctx.ExitThread() })
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
    Start-Process $webUrl
    [System.Windows.Forms.Application]::Run($ctx)
} catch {
    if ($Action -eq 'Run') {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Rakazo launcher') | Out-Null
        } catch { }
    }
    throw
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    Stop-Owned
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

        $internal = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN\s*=' })
        $internalUrl = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_API_INTERNAL_URL\s*=' })
        $workerDispatchConfigured = $internal.Count -eq 1 -and $internalUrl.Count -eq 1 -and
            (($internal[0] -replace '^\s*RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN\s*=\s*', '').Trim('"', "'").Length -ge 32) -and
            ($internalUrl[0] -match '127[.]0[.]0[.]1:3100|localhost:3100')
    }
    return [pscustomobject]@{
        NativeCheckoutExists = $hasRepo
        ExistingAliasMatches = $identityMatches
        ExistingMcpUsesNewCheckout = $mcpPointsNew
        DatabaseIsCloned = $correctDatabase
        HostFeatureInEnv = $hostFlag
        ProtectedHostCredentialExists = Test-Path -LiteralPath $credential
        CorepackAvailable = [bool](Get-Command corepack -ErrorAction SilentlyContinue)
        ApiHealthy = Test-Http "$origin/health"
        WebHealthy = Test-Http $webUrl
        ApiPortOccupied = Test-Port 3100
        WebPortOccupied = Test-Port 5173
        ExistingTunnelReady = Test-TunnelReady
    }
}
function Wait-Http([string]$url, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http $url) { return $true }
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
    # Never stop an adopted process or another alias. Guard against reused PIDs.
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        $entry = $owned[$i]
        $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
        if (-not $p -or $p.StartTime.ToUniversalTime() -ne $entry.StartTime) { continue }
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        try {
            & $taskkill /PID $entry.Pid /T 2>$null | Out-Null
            Start-Sleep -Milliseconds 500
            $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
            if ($p -and $p.StartTime.ToUniversalTime() -eq $entry.StartTime) {
                & $taskkill /PID $entry.Pid /T /F 2>$null | Out-Null
            }
        } catch {
            # Only the originally created PID is eligible for termination.
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
        $env:RAKAZO_WINDOWS_PROCESS_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_GUI_ENABLED = 'false'
        $env:RAKAZO_OPENCLI_PROFILE = ''
        $env:RAKAZO_OPENCLI_ENTRY = ''
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
    exit 0
}
$mutex = [Threading.Mutex]::new($false, 'Local\RakazoNativeManualController')
$acquired = $false
$tray = $null
$timer = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        if ($before.WebHealthy) { Start-Process $webUrl }
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ($before.NativeCheckoutExists -and $before.ExistingAliasMatches -and
        $before.ExistingMcpUsesNewCheckout -and $before.DatabaseIsCloned -and
        $before.HostFeatureInEnv -and $before.ProtectedHostCredentialExists -and
        $before.CorepackAvailable)) {
        throw 'Preflight failed. Run Rakazo.ps1 -Action Preflight before activating.'
    }
    if ($before.ApiPortOccupied -or $before.WebPortOccupied) {
        throw 'API/Web is already running outside this controller. Close the pilot windows during a planned handoff; never duplicate them.'
    }
    if (-not $before.ExistingTunnelReady) {
        throw 'Existing R tunnel not ready. This pilot does not create a replacement tunnel or profile.'
    }
    # Only reuse the already existing shared PostgreSQL container.
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker CLI unavailable: shared PostgreSQL prerequisite.' }
    $postgres = & $docker.Source inspect --format '{{.State.Running}}' compose-postgres-1 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$postgres).Trim() -ne 'true') {
        throw 'Existing PostgreSQL container is not running. No new stack was created.'
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $api = Start-OwnedRole 'api'
    if (-not (Wait-Http "$origin/health" 60)) { throw 'Native API startup failed; inspect manual-launcher logs.' }
    $worker = Start-OwnedRole 'worker'
    Start-Sleep -Seconds 3
    if ($worker.HasExited) { throw 'Worker exited early; inspect manual-launcher logs.' }
    $web = Start-OwnedRole 'web'
    if (-not (Wait-Http $webUrl 60)) { throw 'Native Web startup failed; inspect manual-launcher logs.' }
    $host = Start-OwnedRole 'host'
    Start-Sleep -Seconds 3
    if ($host.HasExited) { throw 'Previously paired Windows Host exited early; inspect manual-launcher logs.' }
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
    $quit.add_Click({ $ctx.ExitThread() })
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
    Start-Process $webUrl
    [System.Windows.Forms.Application]::Run($ctx)
} catch {
    if ($Action -eq 'Run') {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Rakazo launcher') | Out-Null
        } catch { }
    }
    throw
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    Stop-Owned
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
)
        $mcp = ([string]$cfg.McpCommand).Replace('\', '/')
        $normalizedRepo = $repo.Replace('\', '/') + '/'
        $mcpPointsNew = $mcp.IndexOf($normalizedRepo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    $correctDatabase = $false
    $hostFlag = $false
    if (Test-Path -LiteralPath $envPath) {
        # Never print .env contents or private connection strings.
        $lines = @(Get-Content -LiteralPath $envPath)
        $db = @($lines | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' })
        $correctDatabase = $db.Count -eq 1 -and $db[0] -match '/rakazo_next(?:[?''"]|$)'
        $flag = @($lines | Where-Object { $_ -match '^\s*RAKAZO_WINDOWS_HOST_ENABLED\s*=' })
        $hostFlag = $flag.Count -eq 1 -and $flag[0] -match '=\s*["'']?true["'']?\s*$'
    }
    return [pscustomobject]@{
        NativeCheckoutExists = $hasRepo
        ExistingAliasMatches = $identityMatches
        ExistingMcpUsesNewCheckout = $mcpPointsNew
        DatabaseIsCloned = $correctDatabase
        HostFeatureInEnv = $hostFlag
        ProtectedHostCredentialExists = Test-Path -LiteralPath $credential
        CorepackAvailable = [bool](Get-Command corepack -ErrorAction SilentlyContinue)
        ApiHealthy = Test-Http "$origin/health"
        WebHealthy = Test-Http $webUrl
        ApiPortOccupied = Test-Port 3100
        WebPortOccupied = Test-Port 5173
        ExistingTunnelReady = Test-TunnelReady
    }
}
function Wait-Http([string]$url, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Http $url) { return $true }
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
    # Never stop an adopted process or another alias. Guard against reused PIDs.
    for ($i = $owned.Count - 1; $i -ge 0; $i--) {
        $entry = $owned[$i]
        $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
        if (-not $p -or $p.StartTime.ToUniversalTime() -ne $entry.StartTime) { continue }
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        try {
            & $taskkill /PID $entry.Pid /T 2>$null | Out-Null
            Start-Sleep -Milliseconds 500
            $p = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
            if ($p -and $p.StartTime.ToUniversalTime() -eq $entry.StartTime) {
                & $taskkill /PID $entry.Pid /T /F 2>$null | Out-Null
            }
        } catch {
            # Only the originally created PID is eligible for termination.
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
        $env:RAKAZO_WINDOWS_PROCESS_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = 'false'
        $env:RAKAZO_WINDOWS_GUI_ENABLED = 'false'
        $env:RAKAZO_OPENCLI_PROFILE = ''
        $env:RAKAZO_OPENCLI_ENTRY = ''
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
    exit 0
}
$mutex = [Threading.Mutex]::new($false, 'Local\RakazoNativeManualController')
$acquired = $false
$tray = $null
$timer = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        if ($before.WebHealthy) { Start-Process $webUrl }
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ($before.NativeCheckoutExists -and $before.ExistingAliasMatches -and
        $before.ExistingMcpUsesNewCheckout -and $before.DatabaseIsCloned -and
        $before.HostFeatureInEnv -and $before.ProtectedHostCredentialExists -and
        $before.CorepackAvailable)) {
        throw 'Preflight failed. Run Rakazo.ps1 -Action Preflight before activating.'
    }
    if ($before.ApiPortOccupied -or $before.WebPortOccupied) {
        throw 'API/Web is already running outside this controller. Close the pilot windows during a planned handoff; never duplicate them.'
    }
    if (-not $before.ExistingTunnelReady) {
        throw 'Existing R tunnel not ready. This pilot does not create a replacement tunnel or profile.'
    }
    # Only reuse the already existing shared PostgreSQL container.
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker CLI unavailable: shared PostgreSQL prerequisite.' }
    $postgres = & $docker.Source inspect --format '{{.State.Running}}' compose-postgres-1 2>$null
    if ($LASTEXITCODE -ne 0 -or ([string]$postgres).Trim() -ne 'true') {
        throw 'Existing PostgreSQL container is not running. No new stack was created.'
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $api = Start-OwnedRole 'api'
    if (-not (Wait-Http "$origin/health" 60)) { throw 'Native API startup failed; inspect manual-launcher logs.' }
    $worker = Start-OwnedRole 'worker'
    Start-Sleep -Seconds 3
    if ($worker.HasExited) { throw 'Worker exited early; inspect manual-launcher logs.' }
    $web = Start-OwnedRole 'web'
    if (-not (Wait-Http $webUrl 60)) { throw 'Native Web startup failed; inspect manual-launcher logs.' }
    $host = Start-OwnedRole 'host'
    Start-Sleep -Seconds 3
    if ($host.HasExited) { throw 'Previously paired Windows Host exited early; inspect manual-launcher logs.' }
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
    $quit.add_Click({ $ctx.ExitThread() })
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
    Start-Process $webUrl
    [System.Windows.Forms.Application]::Run($ctx)
} catch {
    if ($Action -eq 'Run') {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Rakazo launcher') | Out-Null
        } catch { }
    }
    throw
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    Stop-Owned
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
