[CmdletBinding()]
param(
    [ValidateSet('Check','Apply')][string]$Action = 'Check',
    [string]$Repo = '',
    [string]$ExpectedTarget = '',
    [int]$ControllerPid = 0,
    [string]$ControllerStarted = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Repo) { $Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) }
$Repo = [IO.Path]::GetFullPath($Repo)
$state = Join-Path $env:LOCALAPPDATA 'Rakazo\manual-launcher'
function Invoke-Git([string[]]$GitArgs) {
    $output = @(& git -C $Repo @GitArgs 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Git operation failed; no update was applied.' }
    return $output
}
function Get-Plan {
    if (-not (Test-Path -LiteralPath (Join-Path $Repo 'pnpm-lock.yaml'))) { throw 'Not a Rakazo checkout.' }
    $remote = [string](Invoke-Git -GitArgs @('remote','get-url','origin') | Select-Object -First 1)
    if ($remote -notmatch '^https://github[.]com/BogdanAIP/rakazo(?:[.]git)?$') { throw 'Unexpected origin; update refused.' }
    $branch = [string](Invoke-Git -GitArgs @('branch','--show-current') | Select-Object -First 1)
    if (-not $branch -or $branch -match '[^a-zA-Z0-9/_-]') { throw 'Detached or unsupported branch.' }
    $upstream = [string](Invoke-Git -GitArgs @('rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}') | Select-Object -First 1)
    if ($upstream -cne ('origin/'+$branch)) { throw 'Unexpected upstream; update refused.' }
    [void](Invoke-Git -GitArgs @('fetch','--quiet','origin',$branch))
    $head = [string](Invoke-Git -GitArgs @('rev-parse','HEAD') | Select-Object -First 1)
    $target = [string](Invoke-Git -GitArgs @('rev-parse',$upstream) | Select-Object -First 1)
    $dirty = @(Invoke-Git -GitArgs @('status','--porcelain','--untracked-files=normal'))
    $changes = if ($head -ne $target) { @(Invoke-Git -GitArgs @('diff','--name-only',$head,$target)) } else { @() }
    $ancestor = $true
    if ($head -ne $target) {
        & git -C $Repo merge-base --is-ancestor $head $target
        $ancestor = $LASTEXITCODE -eq 0
    }
    $migration = @($changes | Where-Object { $_ -match '^(packages/db/prisma/migrations/|apps/api/prisma/|scripts/windows/manual-rakazo/Tunnel[.]Control[.]ps1$)' }).Count -gt 0
    $reason = if ($dirty.Count) { 'Working tree contains local changes. Commit or review them before updating.' }
      elseif (-not $ancestor) { 'History diverged. A manual review is required.' }
      elseif ($migration) { 'Database migration or tunnel control changed. Manual backup/review required.' }
      else { '' }
    return [pscustomobject]@{
        status = if ($reason) { 'blocked' } elseif ($head -eq $target) { 'current' } else { 'available' }
        reason = $reason; head = $head; target = $target; branch = $branch
        changedFiles = @($changes); localChanges = @($dirty)
    }
}
if ($Action -eq 'Check') {
    Get-Plan | ConvertTo-Json -Depth 5 -Compress
    return
}
if ($ExpectedTarget -notmatch '^[a-f0-9]{40}$' -or $ControllerPid -le 0 -or -not $ControllerStarted) { throw 'Missing validated update handoff.' }
$plan = Get-Plan
if ($plan.status -ne 'available' -or $plan.target -cne $ExpectedTarget) { throw 'Update plan changed; apply refused.' }
New-Item -ItemType Directory -Path $state -Force | Out-Null
$log = Join-Path $state 'native-update-stage.log'
function Mark([string]$stage) { Add-Content -LiteralPath $log -Encoding UTF8 -Value ("{0:u} {1}" -f [DateTime]::UtcNow,$stage) }
Mark 'PRECHECK_PASS'
$deadline = [DateTime]::UtcNow.AddSeconds(120)
do {
    $controller = Get-Process -Id $ControllerPid -ErrorAction SilentlyContinue
    if ($controller -and $controller.StartTime.ToUniversalTime().ToString('o') -cne $ControllerStarted) { throw 'Controller PID changed identity.' }
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3100,5173) })
    if (-not $controller -and $ports.Count -eq 0) { break }
    Start-Sleep -Seconds 1
} while ([DateTime]::UtcNow -lt $deadline)
if ($controller -or $ports.Count) { throw 'Controller or native ports are still active; no files changed.' }
$mutex = [Threading.Mutex]::new($false,'Local\RakazoNativeManualController')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another native controller started; update cancelled.' }
    $plan = Get-Plan
    if ($plan.status -ne 'available' -or $plan.target -cne $ExpectedTarget) { throw 'Update plan changed while waiting.' }
    Mark 'CONTROLLER_STOPPED_AND_RECHECKED'
    [void](Invoke-Git -GitArgs @('merge','--ff-only',$ExpectedTarget))
    Mark 'FAST_FORWARD_APPLIED'
    Push-Location $Repo
    try {
        & corepack pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; inspect local checkout.' }
        & corepack pnpm --filter @rakazo/adapters check
        if ($LASTEXITCODE -ne 0) { throw 'Adapter validation failed; inspect local checkout.' }
    } finally { Pop-Location }
    Mark 'DEPENDENCIES_AND_ADAPTERS_PASS'
} catch {
    Mark 'UPDATE_FAILED_REVIEW_REQUIRED'
    throw
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
$launcher = Join-Path $PSScriptRoot 'Launch-Rakazo.vbs'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Existing Rakazo GUI launcher was not found.' }
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"'+$launcher+'"')
Mark 'RESTART_LAUNCHED_VERIFY_TRAY_AND_HOST'
