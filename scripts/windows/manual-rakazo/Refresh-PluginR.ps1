[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Tunnel.Diagnostics.ps1')
. (Join-Path $PSScriptRoot 'Tunnel.Control.ps1')
$cfgPath = Join-Path $HOME 'Desktop\Rakazo Tunnel\config.json'
$cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
$client = [string]$cfg.TunnelClient
$key = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\runtime-key.dpapi'
$session = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\session-token.dpapi'
$state = Join-Path $env:LOCALAPPDATA 'Rakazo\manual-launcher'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$log = Join-Path $state 'plugin-r-refresh.log'
function Mark([string]$stage) {
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:u} {1}' -f [DateTime]::UtcNow,$stage)
}
try {
    if ($cfg.Version -ne 4 -or $cfg.Alias -cne 'rakazo' -or
        ([string]$cfg.TunnelId) -cnotmatch '^tunnel_[A-Za-z0-9_-]+$' -or
        -not ([string]$cfg.McpCommand).Contains('rakazo-upstream-integration') -or
        -not ([string]$cfg.McpCommand).Contains('chatgpt-mcp.ts')) {
        throw 'Existing R identity or source path differs; refresh refused.'
    }
    if (-not (Test-Path -LiteralPath $client -PathType Leaf) -or
        -not (Test-Path -LiteralPath $key -PathType Leaf) -or
        -not (Test-Path -LiteralPath $session -PathType Leaf)) { throw 'Original protected file missing.' }
    $before = Get-RakazoAuthenticatedTunnelStatus -ClientPath $client -Alias 'rakazo' -EncryptedKeyPath $key
    if ([string]$before.tunnel_id -cne [string]$cfg.TunnelId -or $before.process_running -ne $true -or
        $before.ready -ne $true -or $before.healthy -ne $true -or
        -not (Test-RakazoExistingTunnelProcessEvidence -Runtime $before -ClientPath $client) -or
        -not (Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$before.health_url))) {
        throw 'Existing R is not uniquely verified; refresh refused.'
    }
    $oldPid = [int]$before.process.pid
    $oldStart = [string]$before.process.started_at
    Mark 'PRECHECK_PASS'
    [void](Invoke-RakazoRegisteredRuntimeOperation -Operation stop -ClientPath $client -TunnelId ([string]$cfg.TunnelId) -McpCommand ([string]$cfg.McpCommand) -KeyPath $key -SessionPath $session -ExpectedStopPid $oldPid -ExpectedStopStart $oldStart)
    Mark 'STOP_ACCEPTED'
    $stopped = $false
    for ($i=0;$i -lt 25;$i++) {
        Start-Sleep -Seconds 1
        $now = Get-RakazoAuthenticatedTunnelStatus -ClientPath $client -Alias 'rakazo' -EncryptedKeyPath $key
        if ($now.process_running -ne $true -and $now.ready -ne $true -and $now.healthy -ne $true -and
            -not (Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$now.health_url))) { $stopped=$true; break }
    }
    if (-not $stopped) { throw 'Original R not fully stopped. No duplicate connect.' }
    Mark 'STOP_VERIFIED'
    [void](Invoke-RakazoRegisteredRuntimeOperation -Operation connect -ClientPath $client -TunnelId ([string]$cfg.TunnelId) -McpCommand ([string]$cfg.McpCommand) -KeyPath $key -SessionPath $session)
    Mark 'CONNECT_ACCEPTED'
    $ready = $false
    for($i=0;$i -lt 40;$i++) {
        Start-Sleep -Seconds 1
        $now = Get-RakazoAuthenticatedTunnelStatus -ClientPath $client -Alias 'rakazo' -EncryptedKeyPath $key
        if ([string]$now.tunnel_id -ceq [string]$cfg.TunnelId -and $now.ready -eq $true -and
            $now.healthy -eq $true -and [int]$now.process.pid -ne $oldPid -and
            (Test-RakazoExistingTunnelProcessEvidence -Runtime $now -ClientPath $client) -and
            (Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$now.health_url))) { $ready=$true; break }
    }
    if (-not $ready) { throw 'Original R did not return healthy with its new process.' }
    Mark 'PASS_SAME_REGISTERED_TUNNEL_NEW_PROCESS'
} catch {
    Mark 'REFRESH_FAILED_REVIEW_REQUIRED'
    throw
}
