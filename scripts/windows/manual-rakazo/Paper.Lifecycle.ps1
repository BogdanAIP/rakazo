# PAPER ONLY. This module never changes positions or original session permissions.
[CmdletBinding()]
param(
 [ValidateSet('Probe','Plan','Stop')][string]$Action='Probe',
 [switch]$ConfirmedOwnerQuit
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=Join-Path $env:USERPROFILE 'RakazoRuntime\trading-live-data-20261011'
$configPath=Join-Path $root 'paper-runtime-config.json'
$pidsPath=Join-Path $root 'paper-runtime-pids.json'
$gatewayPath=Join-Path $root 'linked-journal-gateway-pid.json'
if(!(Test-Path $configPath) -or !(Test-Path $pidsPath)){throw 'PAPER runtime registry missing'}
$cfg=Get-Content $configPath -Raw|ConvertFrom-Json
$pids=Get-Content $pidsPath -Raw|ConvertFrom-Json
$gateway=if(Test-Path $gatewayPath){Get-Content $gatewayPath -Raw|ConvertFrom-Json}else{$null}
function Test-RegisteredProcess($item,[string]$entry,[string]$role){
 if($null -eq $item -or !$item.pid){return $false}
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$item.pid)
 if($null -eq $p){return $false}
 if(!([string]$p.CommandLine).Replace('\','/').Contains($entry.Replace('\','/'))){
  throw ('Unverified process for PAPER '+$role)
 }
 if(!$item.startedAt){throw ('Missing start identity '+$role)}
 $stamp=$item.startedAt
 $recorded=if($stamp -is [DateTime]){$stamp.ToUniversalTime()}else{
  [DateTimeOffset]::Parse([string]$stamp,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
 }
 if([Math]::Abs(($p.CreationDate.ToUniversalTime()-$recorded).TotalSeconds) -gt 25){
  throw ('Process identity changed '+$role)
 }
 return $true
}
$repo=[IO.Path]::GetFullPath([string]$cfg.repo)
$entries=@{
 api=[IO.Path]::Combine($repo,'apps','api','src','index.ts')
 worker=[IO.Path]::Combine($repo,'apps','worker','src','index.ts')
}
$api=Test-RegisteredProcess $pids.api $entries.api 'api'
$worker=Test-RegisteredProcess $pids.worker $entries.worker 'worker'
$gatewayOk=if($null -eq $gateway){$false}else{
 Test-RegisteredProcess $gateway ([string]$gateway.server) 'journal'
}
# Refuse unfamiliar listeners; no port-scoped killing.
function Assert-ListeningIdentity([int]$port, [int]$expectedPid, [string]$role){
 $listeners=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
     Where-Object {$_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::')})
 foreach($item in $listeners){
  if($expectedPid -eq 0 -or [int]$item.OwningProcess -ne $expectedPid){
   throw ('Foreign service on PAPER '+$role+' port '+$port)
  }
 }
}
Assert-ListeningIdentity 3008 $(if($api){[int]$pids.api.pid}else{0}) 'API'
Assert-ListeningIdentity 5190 $(if($gatewayOk){[int]$gateway.pid}else{0}) 'gateway'
$pgCtl=Join-Path ([string]$cfg.pgBin) 'pg_ctl.exe'
$pgData=[IO.Path]::GetFullPath([string]$cfg.pgData)
if(!(Test-Path $pgCtl) -or !(Test-Path $pgData)){throw 'PAPER postgres registration unavailable'}
& $pgCtl -D $pgData status 2>$null | Out-Null
$pgRunning=($LASTEXITCODE -eq 0)
if($pgRunning){
 $pidFile=Join-Path $pgData 'postmaster.pid'
 if(!(Test-Path $pidFile)){throw 'PAPER postgres PID missing'}
 $lines=@(Get-Content $pidFile)
 if($lines.Count -lt 4 -or $lines[0] -notmatch '^\d+$'){throw 'Invalid postgres PID evidence'}
 $pgPid=[int]$lines[0]
 if([IO.Path]::GetFullPath($lines[1]).TrimEnd('\') -ine $pgData.TrimEnd('\')){
  throw 'Unexpected PAPER data directory'
 }
 if([int]$lines[3] -ne [int]$cfg.pgPort){throw 'Unexpected PAPER database port'}
 $listeners=@(Get-NetTCPConnection -LocalPort ([int]$cfg.pgPort) -State Listen -ErrorAction SilentlyContinue|
   Where-Object {$_.OwningProcess -eq $pgPid})
 if(!$listeners.Count){throw 'Unverified PAPER database listener'}
}
if($Action -eq 'Probe' -or $Action -eq 'Plan'){
 [pscustomobject]@{mode='PAPER_ONLY';api=$api;worker=$worker;gateway=$gatewayOk;
  database=$pgRunning;wouldChange=$false;stopEligible=$true;stopWouldRequireGapReview=$true}|ConvertTo-Json -Compress
 return
}
# Defense in depth: Plan/Probe can NEVER reach a destructive branch.
if($Action -ne 'Stop' -or -not $ConfirmedOwnerQuit) {
 throw 'PAPER stop requires explicit Stop action and confirmed owner Quit'
}
if(-not $api -and -not $worker -and -not $gatewayOk -and -not $pgRunning) {
 'PAPER already offline; previously recorded interval preserved.'
 return
}
# Record downtime before terminating services. Restart must reconcile gaps before new entries.
$marker=Join-Path $root 'paper-offline-lifecycle.json'
$record=[ordered]@{version=1;mode='PAPER_ONLY';reason='owner_requested_quit';
 requestedAtUtc=[DateTime]::UtcNow.ToString('o');state='stopping';
 reviewRequired=$true;offlineExecutionsNotVerified=$true}
$record|ConvertTo-Json|Set-Content -LiteralPath $marker -Encoding UTF8
function Stop-Registered($item,[string]$entry,[string]$role){
 if(!(Test-RegisteredProcess $item $entry $role)){return}
 # Exact registered process tree only; no broad node.exe killing.
 $taskkill=Join-Path $env:SystemRoot 'System32\taskkill.exe'
 & $taskkill '/PID' ([string]$item.pid) '/T' '/F' | Out-Null
 if($LASTEXITCODE -ne 0){throw ('Cannot stop PAPER '+$role)}
}
if($null -ne $gateway){Stop-Registered $gateway ([string]$gateway.server) 'gateway'}
Stop-Registered $pids.worker $entries.worker 'worker'
Stop-Registered $pids.api $entries.api 'api'
if($pgRunning){
 & $pgCtl '-D' $pgData '-m' 'fast' '-w' '-t' '45' 'stop' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'PAPER database stop failed'}
}
$record.state='offline'
$record.stoppedAtUtc=[DateTime]::UtcNow.ToString('o')
$record|ConvertTo-Json|Set-Content -LiteralPath $marker -Encoding UTF8
'PAPER services stopped; journals preserved; offline gap review required.'
