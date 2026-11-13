# Disposable 3-service PAPER shutdown QA. No live ports/data or trades.
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ("rakazo-three-stop-"+[guid]::NewGuid().ToString("N"))
$repo=Join-Path $root "repo"
$pgBin="C:\Users\eahra\RakazoRuntime\postgresql\bin"
$node="C:\Program Files\nodejs\node.exe"
$tsx="C:\Users\eahra\rakazo-paper-journal-risk-20261019\node_modules\tsx\dist\loader.mjs"
$bundle=Join-Path $HOME "rakazo-paper-offline-gateway-20261019\scripts\local-paper-journal\paper-graceful-stop-runtime.mjs"
$controller=Join-Path (Split-Path -Parent $PSScriptRoot) "Paper.GracefulWorker.ps1"
$lifecycle=Join-Path (Split-Path -Parent $PSScriptRoot) "Paper.Lifecycle.ps1"
$started=@()
$pgStarted=$false
New-Item -ItemType Directory -Path $repo -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $repo "package.json"),'{"type":"module"}')
foreach($role in @("worker","api","gateway")){
 $relative=if($role -eq "gateway"){"scripts\gateway"}else{"apps\"+$role+"\src"}
 New-Item -ItemType Directory -Path (Join-Path $repo $relative) -Force|Out-Null
}
function Check($condition,[string]$name){
 if(!$condition){throw ("FAILED: "+$name)}
 Write-Output ("PASS "+$name)
}
function Owned($id){
 $proc=Get-CimInstance Win32_Process -Filter ("ProcessId="+$id)
 return ($proc -and $proc.Name -ieq "node.exe" -and ([string]$proc.CommandLine).Contains($repo))
}
$paths=@{worker="apps\worker\src\index.ts";api="apps\api\src\index.ts";gateway="scripts\gateway\server.mjs"}
$fixture=Join-Path $PSScriptRoot "Paper.ThreeService.fixture.mjs"
foreach($file in $paths.Values){Copy-Item -LiteralPath $fixture -Destination (Join-Path $repo $file)}
function StartRole([string]$role,[int]$port){
 $old=@{}
 foreach($name in @("QA_RUNTIME","QA_ROLE","QA_PORT","QA_STOP_BUNDLE")){
  $old[$name]=[Environment]::GetEnvironmentVariable($name,"Process")
 }
 try{
  $env:QA_RUNTIME=$root;$env:QA_ROLE=$role;$env:QA_PORT=[string]$port;$env:QA_STOP_BUNDLE=$bundle
  $file=Join-Path $repo $paths[$role]
  $args=if($role -eq "gateway"){@($file)}else{@("--import",([uri]$tsx).AbsoluteUri,$file)}
  $child=Start-Process $node -ArgumentList $args -WindowStyle Hidden -PassThru -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $root ($role+".out")) -RedirectStandardError (Join-Path $root ($role+".err"))
  $script:started+=@($child.Id)
  $ready=Join-Path $root ("paper-"+$role+"-stop.ready.json")
  for($i=0;$i -lt 80 -and !(Test-Path $ready);$i++){Start-Sleep -Milliseconds 100}
  if(!(Test-Path $ready)){throw ("QA "+$role+" startup failed: "+(Get-Content (Join-Path $root ($role+".err")) -Raw))}
  if(!(Owned $child.Id)){throw ("Unverified QA process: "+$role)}
  $proc=Get-CimInstance Win32_Process -Filter ("ProcessId="+$child.Id)
  return @{pid=$child.Id;startedAt=$proc.CreationDate.ToUniversalTime().ToString("o")}
 }finally{
  foreach($name in $old.Keys){[Environment]::SetEnvironmentVariable($name,$old[$name],"Process")}
 }
}
try{
 foreach($port in @(15549,15651,15652)){
  if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){
   throw ("QA port in use: "+$port)
  }
 }
 $cfg=@{repo=$repo;pgBin=$pgBin;pgData=(Join-Path $root "pgdata");pgPort=15549}
 $cfg|ConvertTo-Json|Set-Content (Join-Path $root "paper-runtime-config.json")
 $ledger=Join-Path $root "paper-ledger.json"
 [IO.File]::WriteAllText($ledger,'{"position":{"asset":"SOL","quantity":"2","side":"short"},"orders":[{"type":"stop","price":"106.8"}]}')
 $ledgerHash=(Get-FileHash $ledger -Algorithm SHA256).Hash
 & (Join-Path $pgBin "initdb.exe") -D $cfg.pgData -U "qa_user" -E UTF8 --auth=trust --no-instructions *> (Join-Path $root "initdb.log")
 if($LASTEXITCODE -ne 0){throw "QA initdb failed"}
 & (Join-Path $pgBin "pg_ctl.exe") -D $cfg.pgData -o '-h 127.0.0.1 -p 15549' -l (Join-Path $root "pg.log") -w -t 25 start
 if($LASTEXITCODE -ne 0){throw "QA PostgreSQL start failed"}
 $script:pgStarted=$true
 Check ([bool](Get-NetTCPConnection -LocalPort 15549 -State Listen -ErrorAction SilentlyContinue)) "disposable PostgreSQL started"
 $worker=StartRole "worker" 0
 $api=StartRole "api" 15651
 $gateway=StartRole "gateway" 15652
 @{api=$api;worker=$worker}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $root "paper-runtime-pids.json")
 @{pid=$gateway.pid;server=(Join-Path $repo $paths.gateway);startedAt=$gateway.startedAt}|ConvertTo-Json|Set-Content (Join-Path $root "linked-journal-gateway-pid.json")
 $raw=[IO.File]::ReadAllText($lifecycle)
 $old="$"+'root=Join-Path $env:USERPROFILE '+[char]39+'RakazoRuntime\trading-live-data-20261011'+[char]39
 $new='$root='+[char]39+$root+[char]39
 if(!$raw.Contains($old)){throw "Lifecycle root anchor missing"}
 $raw=$raw.Replace($old,$new)
 $raw=$raw.Replace("Assert-ListeningIdentity 3008","Assert-ListeningIdentity 15651")
 $raw=$raw.Replace("Assert-ListeningIdentity 5190","Assert-ListeningIdentity 15652")
 $qaLife=Join-Path $root "Paper.Lifecycle.ps1"
 [IO.File]::WriteAllText($qaLife,$raw,[Text.UTF8Encoding]::new($false))
 Copy-Item -LiteralPath $controller -Destination (Join-Path $root "Paper.GracefulWorker.ps1")
 $plan=(& $qaLife -Action Plan |Select-Object -Last 1|ConvertFrom-Json)
 Check ($plan.stopEligible -and $plan.workerDrainReady -and $plan.apiDrainReady -and $plan.gatewayDrainReady) "three-role ready, exact PIDs"
 Check (!(Test-Path (Join-Path $root "paper-offline-lifecycle.json"))) "read-only plan unchanged state"
 $roleFile=Join-Path $root "paper-api-stop.ready.json"
 $cleanRole=[IO.File]::ReadAllText($roleFile)
 try{
  $wrong=($cleanRole|ConvertFrom-Json)
  $wrong.service="worker"
  [IO.File]::WriteAllText($roleFile,($wrong|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $badPlan=(& $qaLife -Action Plan|Select-Object -Last 1|ConvertFrom-Json)
  Check (!$badPlan.stopEligible -and !$badPlan.apiDrainReady) "mismatched role fails closed"
 }finally{
  [IO.File]::WriteAllText($roleFile,$cleanRole,[Text.UTF8Encoding]::new($false))
 }
 $denied=$false
 try{& $qaLife -Action Stop -ErrorAction Stop|Out-Null}catch{$denied=$true}
 Check $denied "unconfirmed Quit denied"
 Check ((Get-FileHash $ledger -Algorithm SHA256).Hash -eq $ledgerHash) "denied Quit preserved ledger"
 $stopResult=& $qaLife -Action Stop -ConfirmedOwnerQuit
 Check ((Get-Content (Join-Path $root "paper-offline-lifecycle.json") -Raw|ConvertFrom-Json).state -eq "offline") "offline state recorded"
 foreach($role in @("worker","gateway","api")){
  Check (Test-Path (Join-Path $root ($role+".done"))) ($role+" acknowledged drain")
  $ack=Get-Content (Join-Path $root ("paper-"+$role+"-stop.ack.json")) -Raw|ConvertFrom-Json
  Check ($ack.state -eq "drained" -and $ack.service -eq $role) ($role+" role-correct receipt")
 }
 foreach($pidNum in @($worker.pid,$api.pid,$gateway.pid)){
  Check (!(Get-Process -Id $pidNum -ErrorAction SilentlyContinue)) ("QA Node exited "+$pidNum)
 }
 Check (![bool](Get-NetTCPConnection -LocalPort 15549 -State Listen -ErrorAction SilentlyContinue)) "temporary PostgreSQL stopped"
 Check ((Get-FileHash $ledger -Algorithm SHA256).Hash -eq $ledgerHash) "ledger hash preserved after Quit"
 & (Join-Path $pgBin "pg_ctl.exe") -D $cfg.pgData -o '-h 127.0.0.1 -p 15549' -l (Join-Path $root "pg2.log") -w -t 25 start
 if($LASTEXITCODE -ne 0){throw "QA PostgreSQL restart failed"}
 foreach($role in @("worker","api","gateway")){Remove-Item -LiteralPath (Join-Path $root ("paper-"+$role+"-stop.ready.json")) -Force}
 $worker=StartRole "worker" 0
 $api=StartRole "api" 15651
 $gateway=StartRole "gateway" 15652
 @{api=$api;worker=$worker}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $root "paper-runtime-pids.json")
 @{pid=$gateway.pid;server=(Join-Path $repo $paths.gateway);startedAt=$gateway.startedAt}|ConvertTo-Json|Set-Content (Join-Path $root "linked-journal-gateway-pid.json")
 Check ((Get-FileHash $ledger -Algorithm SHA256).Hash -eq $ledgerHash) "journal unchanged after restart"
 $marker=Get-Content (Join-Path $root "paper-offline-lifecycle.json") -Raw|ConvertFrom-Json
 Check ($marker.reviewRequired -and $marker.offlineExecutionsNotVerified) "gap review still mandatory; no synthetic fills"
 $plan2=& $qaLife -Action Plan|Select-Object -Last 1|ConvertFrom-Json
 Check ($plan2.stopEligible -and $plan2.api -and $plan2.gateway -and $plan2.worker) "all temporary processes rediscovered after restart"
 Write-Output "PASS ISOLATED_THREE_SERVICE_QUIT_RESTART"
} finally {
 foreach($pidNum in $started){
  if(Owned $pidNum){Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue}
 }
 $data=Join-Path $root "pgdata"
 if($pgStarted -and (Test-Path (Join-Path $data "PG_VERSION"))){
  $pidfile=Join-Path $data "postmaster.pid"
  $control=Join-Path $pgBin "pg_ctl.exe"
  if(Test-Path $pidfile){
   $lines=@(Get-Content $pidfile)
   if($lines.Count -lt 4 -or $lines[3] -ne "15549" -or
      ([string]$lines[1]).Replace("\","/") -ine $data.Replace("\","/")){
    throw "QA postgres identity mismatch; refusing cleanup"
   }
   & $control -D $data -m fast -w -t 20 stop 2>$null |Out-Null
  }
 }
 Write-Output ("QA_ROOT="+$root)
}
