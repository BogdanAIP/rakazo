# Isolated test of real PID-scoped process stop. Never target installed PAPER.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$live=(Join-Path (Split-Path -Parent $PSScriptRoot) 'Paper.Lifecycle.ps1')
$root=Join-Path $env:TEMP ('paper-process-qa-'+[guid]::NewGuid().ToString('N'))
$run=Join-Path $root 'runtime'
$repo=Join-Path $root 'repo'
$script:started=[System.Collections.Generic.List[int]]::new()
$node=(Get-Command node.exe -ErrorAction Stop).Source
foreach($d in @($root,$run,(Join-Path $repo 'apps\api\src'),(Join-Path $repo 'apps\worker\src'),(Join-Path $repo 'scripts\gateway'))) {
 New-Item -ItemType Directory -Path $d -Force | Out-Null
}
foreach($name in @('apps\api\src\index.ts','apps\worker\src\index.ts','scripts\gateway\server.mjs')){
 [IO.File]::WriteAllText((Join-Path $repo $name),'setInterval(() => {}, 60000);',[Text.UTF8Encoding]::new($false))
}
function New-Dummy([string]$file){
 $proc=Start-Process -FilePath $node -ArgumentList ('"'+$file+'"') -WindowStyle Hidden -PassThru
 [void]$script:started.Add($proc.Id)
 Start-Sleep -Milliseconds 250
 $obs=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$proc.Id)
 if(!$obs -or !$obs.CommandLine.Replace('\','/').Contains($file.Replace('\','/'))){
  throw 'Isolated PID identity failed'
 }
 return [ordered]@{pid=$proc.Id;startedAt=$obs.CreationDate.ToUniversalTime().ToString('o')}
}
function Start-Dummies {
 $a=New-Dummy (Join-Path $repo 'apps\api\src\index.ts')
 $w=New-Dummy (Join-Path $repo 'apps\worker\src\index.ts')
 $g=New-Dummy (Join-Path $repo 'scripts\gateway\server.mjs')
 @{api=$a;worker=$w}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $run 'paper-runtime-pids.json')
 @{pid=$g.pid;startedAt=$g.startedAt;server=(Join-Path $repo 'scripts\gateway\server.mjs')}|
 ConvertTo-Json|Set-Content (Join-Path $run 'linked-journal-gateway-pid.json')
 return [pscustomobject]@{api=$a.pid;worker=$w.pid;gateway=$g.pid}
}
function Check([bool]$ok,[string]$msg){if(!$ok){throw ('ISOLATED PROCESS QA FAILED: '+$msg)};Write-Output ('PASS '+$msg)}
$raw=[IO.File]::ReadAllText($live)
$old='$root=Join-Path $env:USERPROFILE ''RakazoRuntime\trading-live-data-20261011'''
if(!$raw.Contains($old)){throw 'QA source root not found'}
$raw=$raw.Replace($old,'$root='+"'"+$run+"'")
$raw=$raw.Replace('Assert-ListeningIdentity 3008','Assert-ListeningIdentity 13008')
$raw=$raw.Replace('Assert-ListeningIdentity 5190','Assert-ListeningIdentity 15190')
if($raw.Contains('Assert-ListeningIdentity 3008') -or $raw.Contains('Assert-ListeningIdentity 5190')){
 throw 'QA must not inspect live ports'
}
# PostgreSQL must stay simulated: no real database or pg_ctl is accessed.
$replaceDb=@(
 '(?ms)^\$pgCtl=Join-Path[\s\S]*?^if\(\$Action -eq ''Probe'' -or \$Action -eq ''Plan''\)\{',
 '(?ms)^if\(\$pgRunning\)\{\s*& \$pgCtl[\s\S]*?^\}'
)
$replaceWith=@(
 '$pgRunning=((Get-Content (Join-Path $root ''database.state'') -Raw).Trim() -eq ''running'');$workerDrainReady=$true;if($Action -eq ''Probe'' -or $Action -eq ''Plan''){',
 'if($pgRunning){Set-Content (Join-Path $root ''database.state'') ''stopped''}'
)
for($i=0;$i -lt 2;$i++){
 $rx=[regex]::new($replaceDb[$i])
 if($rx.Matches($raw).Count -ne 1){throw ('Real DB boundary replacement failed '+$i)}
 $raw=$rx.Replace($raw,[string]$replaceWith[$i],1)
}
if($raw.Contains('pg_ctl.exe') -or $raw.Contains('pg_ctl.ps1')){
 throw 'QA copy must not call any PostgreSQL control binary'
}
# This legacy suite only tests disposable PID ordering; use the dedicated
# graceful-process QA for the real request/ack handshake and job drain.
$workerBoundary='(?ms)^if\(\$worker\)\{\s*\$drainScript=Join-Path[\s\S]*?^\}'
if(([regex]::Matches($raw,$workerBoundary)).Count -ne 1){throw 'QA worker block ambiguous'}
$raw=[regex]::Replace($raw,$workerBoundary,
 'if($worker){Stop-Registered $pids.worker $entries.worker ''worker''}',1)
# QA-only Stop-Process for verified disposable Node PIDs. No taskkill process trees.
$stopBoundary='(?ms)^function Stop-Registered\([\s\S]*?^\}'
if(([regex]::Matches($raw,$stopBoundary)).Count -ne 1){throw 'QA process-stop boundary ambiguous'}
$raw=[regex]::Replace($raw,$stopBoundary,
 'function Stop-Registered($item,[string]$entry,[string]$role){if(!(Test-RegisteredProcess $item $entry $role)){return};Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop}',1)
$qaScript=Join-Path $root 'QA-process-lifecycle.ps1'
[IO.File]::WriteAllText($qaScript,$raw,[Text.UTF8Encoding]::new($false))
$e=$null;$t=$null
[Management.Automation.Language.Parser]::ParseFile($qaScript,[ref]$t,[ref]$e)|Out-Null
if(@($e).Count){throw 'QA script parser errors'}
@{repo=$repo;pgBin='SIMULATED_NOT_REAL';pgData='SIMULATED_NOT_REAL';pgPort=15548}|
 ConvertTo-Json|Set-Content (Join-Path $run 'paper-runtime-config.json')
Set-Content (Join-Path $run 'database.state') 'running'
$journal=Join-Path $run 'journal.json'
[IO.File]::WriteAllText($journal,(@{mode='PAPER_ONLY';positions=@(@{symbol='SOL-USDT-SWAP';side='short';qty='2'});
 orders=@(@{id='queued';state='pending'});events=@(@{seq=1;kind='position_opened'})}|ConvertTo-Json -Depth 6),
 [Text.UTF8Encoding]::new($false))
$hash=[Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([IO.File]::ReadAllBytes($journal)))
try{
 $ids=Start-Dummies
 $plan=(& $qaScript -Action Plan|Select-Object -Last 1|ConvertFrom-Json)
 Check ($plan.api -and $plan.worker -and $plan.gateway -and $plan.database) 'PLAN sees 3 real dummy processes'
 $reject=$false
 try{& $qaScript -Action Stop -ErrorAction Stop|Out-Null}catch{$reject=$true}
 Check $reject 'Unconfirmed Stop rejected before kill'
 Check ((Get-Process -Id $ids.worker -ErrorAction SilentlyContinue) -ne $null) 'Worker dummy remains alive'
 & $qaScript -Action Stop -ConfirmedOwnerQuit|Out-Null
 foreach($name in 'api','worker','gateway'){
  Check (!(Get-Process -Id $ids.$name -ErrorAction SilentlyContinue)) ('Owned '+$name+' PID stopped')
 }
 Check (((Get-Content (Join-Path $run 'database.state') -Raw).Trim()) -eq 'stopped') 'Simulated DB stop recorded'
 $marker=Get-Content (Join-Path $run 'paper-offline-lifecycle.json') -Raw|ConvertFrom-Json
 Check ($marker.state -eq 'offline' -and $marker.reviewRequired) 'Offline review marker persisted'
 Check ($hash -eq [Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([IO.File]::ReadAllBytes($journal)))) 'Position and pending order unchanged'
 $markerFile=Join-Path $run 'paper-offline-lifecycle.json'
 $last=(Get-Item $markerFile).LastWriteTimeUtc
 & $qaScript -Action Stop -ConfirmedOwnerQuit|Out-Null
 Check ((Get-Item $markerFile).LastWriteTimeUtc -eq $last) 'Repeated Stop idempotent'
 Set-Content (Join-Path $run 'database.state') 'running'
 $newIds=Start-Dummies
 $probe=& $qaScript -Action Probe|Select-Object -Last 1|ConvertFrom-Json
 Check ($probe.api -and $probe.worker -and $probe.gateway -and $probe.database) 'New dummy PIDs discovered after restart'
 Check ($hash -eq [Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([IO.File]::ReadAllBytes($journal)))) 'Journal hash stable after restart'
 $review=Get-Content $markerFile -Raw|ConvertFrom-Json
 Check $review.reviewRequired 'Pending offline review never silently cleared'
 # A PID reused by a different owned process must fail BEFORE any shutdown marker or termination.
 $registry=Join-Path $run 'paper-runtime-pids.json'
 $reg=Get-Content $registry -Raw|ConvertFrom-Json
 $correctWorkerPid=$reg.worker.pid
 $reg.worker.pid=$reg.api.pid
 $reg|ConvertTo-Json -Depth 5|Set-Content $registry
 $markerStamp=(Get-Item $markerFile).LastWriteTimeUtc
 $mismatchRejected=$false
 try{& $qaScript -Action Stop -ConfirmedOwnerQuit -ErrorAction Stop|Out-Null}catch{$mismatchRejected=$true}
 Check $mismatchRejected 'PID identity mismatch fails closed'
 Check ((Get-Item $markerFile).LastWriteTimeUtc -eq $markerStamp) 'PID mismatch does not mutate offline marker'
 Check ((Get-Process -Id $newIds.api -ErrorAction SilentlyContinue) -ne $null) 'PID mismatch does not terminate API'
 $reg.worker.pid=$correctWorkerPid
 $reg|ConvertTo-Json -Depth 5|Set-Content $registry
 [pscustomobject]@{result='PASS';type='ISOLATED_REAL_PROCESS_QA';
  processShutdown='QA-only process cleanup; real graceful protocol verified in dedicated test';
  database='simulated, no real PostgreSQL touched';positions=1;pendingOrders=1;
  originalTradingUntouched=$true;fixture=$root}|ConvertTo-Json -Compress
}finally{
 foreach($id in $script:started){
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$id) -ErrorAction SilentlyContinue
  if($proc -and ([string]$proc.CommandLine).Replace('\','/').Contains($root.Replace('\','/'))){
   Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
 }
}
