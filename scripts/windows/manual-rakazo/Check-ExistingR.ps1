# Read-only live proof of the previously registered Plugin R tunnel.
# Outputs no keys, raw JSON, IDs, profile paths, process paths, URLs or session material.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Tunnel.Diagnostics.ps1')

$configFile = Join-Path $HOME 'Desktop\Rakazo Tunnel\config.json'
$secretFile = Join-Path $env:LOCALAPPDATA 'RakazoTunnel\secrets\runtime-key.dpapi'
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw 'Original tunnel config is missing.' }
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ($config.Version -ne 4 -or $config.Alias -cne 'rakazo' -or
    ([string]$config.TunnelId) -notmatch '^tunnel_[A-Za-z0-9_-]+$') {
    throw 'Existing tunnel identity did not pass read-only validation.'
}
$client = [string]$config.TunnelClient
if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'Original tunnel client is missing.' }
$data = Get-RakazoAuthenticatedTunnelStatus -ClientPath $client -Alias 'rakazo' -EncryptedKeyPath $secretFile
$idMatches = [string]::Equals([string]$data.tunnel_id, [string]$config.TunnelId, [StringComparison]::Ordinal)
$liveHealth = $false
$verifiedProcess = $false
if ($idMatches) {
    $liveHealth = Test-RakazoExistingTunnelHealthEndpoint -Url ([string]$data.health_url)
    $verifiedProcess = Test-RakazoExistingTunnelProcessEvidence -Runtime $data -ClientPath $client
}
[pscustomobject]@{
    AuthenticatedQuerySucceeded = $true
    SameRegisteredTunnel = $idMatches
    CliProcessRunning = $data.process_running -eq $true
    LocalProcessIdentityVerified = $verifiedProcess
    RuntimeLiveHealth = $liveHealth
    RemoteReady = $data.ready -eq $true
    RemoteHealthy = $data.healthy -eq $true
} | Format-List
Write-Host 'READ-ONLY EXISTING R CHECK FINISHED. No runtime was started, stopped or re-paired.'
