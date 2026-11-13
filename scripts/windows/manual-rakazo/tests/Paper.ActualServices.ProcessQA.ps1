# Actual Rakazo API/worker and gateway against a disposable PostgreSQL cluster.
# NEVER use production DATABASE_URL, running worker PID or live ledger files.
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$repo=Join-Path $HOME "rakazo-paper-graceful-worker-20261020"
$gatewayRepo=Join-Path $HOME "rakazo-paper-offline-gateway-20261019"
$dir=Join-Path $env:TEMP ("paper-actual-services-"+[guid]::NewGuid().ToString("N"))
$data=Join-Path $dir "postgres"
$bin=Join-Path $HOME "RakazoRuntime\postgresql\bin"
$node="C:\Program Files\nodejs\node.exe"
$tsx=Join-Path $repo "node_modules\tsx\dist\loader.mjs"
$qaPorts=@(15549,15651,15652)
$started=@()
$pgStarted=$false
$oldEnv=@{}
function Assert-QA([bool]$condition,[string]$label){
 if(!$condition){throw ("QA failed: "+$label)}
 Write-Output ("PASS "+$label)
}
function Is-QANode([int]$pidNumber){
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$pidNumber)
 return ($p -and $p.Name -ieq "node.exe" -and
  ([string]$p.CommandLine).Replace("\","/").Contains($repo.Replace("\","/")) -or
  ($p -and $p.Name -ieq "node.exe" -and ([string]$p.CommandLine).Replace("\","/").Contains($gatewayRepo.Replace("\","/"))))
}
function Register-Service([string]$role,$process,[string]$entry){
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$process.Id)
 if(!$p -or !([string]$p.CommandLine).Replace("\","/").Contains($entry.Replace("\","/"))){
  throw ("Unregistered QA "+$role+" PID")
 }
 return @{pid=$process.Id;startedAt=$p.CreationDate.ToUniversalTime().ToString("o")}
}
function Set-QAEnv($values){
 foreach($k in $values.Keys){
  if(!$oldEnv.ContainsKey($k)){$oldEnv[$k]=[Environment]::GetEnvironmentVariable($k,"Process")}
  [Environment]::SetEnvironmentVariable($k,[string]$values[$k],"Process")
 }
}
function Restore-QAEnv(){
 foreach($k in $oldEnv.Keys){[Environment]::SetEnvironmentVariable($k,$oldEnv[$k],"Process")}
}
function Listen([int]$port){
 return [bool]@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
try{
 foreach($port in $qaPorts){
  if(Listen $port){throw ("Actual-services test port occupied: "+$port)}
 }
 New-Item -ItemType Directory -Path $dir -Force|Out-Null
 New-Item -ItemType Directory -Path (Join-Path $dir "app-data"),(Join-Path $dir "assets") -Force|Out-Null
 & (Join-Path $bin "initdb.exe") -D $data -U "qa_actual" -E UTF8 --auth=trust --no-instructions *> (Join-Path $dir "initdb.log")
 if($LASTEXITCODE -ne 0){throw "Disposable PostgreSQL initdb failed"}
 & (Join-Path $bin "pg_ctl.exe") -D $data -o '-h 127.0.0.1 -p 15549' -l (Join-Path $dir "postgres.log") -w -t 30 start
 if($LASTEXITCODE -ne 0){throw "Disposable PostgreSQL failed to start"}
 $pgStarted=$true
 Assert-QA (Listen 15549) "Real disposable PostgreSQL started on 15549"
 $url="postgresql://qa_actual@127.0.0.1:15549/postgres"
 $crypto=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
 $secret=[Convert]::ToBase64String($crypto)
 $key=([BitConverter]::ToString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))).Replace("-","").ToLowerInvariant()
 $proxySecret=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 $httpOrigin="http://127.0.0.1:15651"
 $qaEnv=@{
  NODE_ENV="development";TZ="UTC";DATABASE_URL=$url;REALTIME_DATABASE_URL=$url;
  BETTER_AUTH_SECRET=$secret;ENCRYPTION_KEY=$key;SCREEN_PROXY_SECRET=$proxySecret;
  API_HOST="127.0.0.1";API_PORT="15651";API_URL=$httpOrigin;API_PROXY_TARGET=$httpOrigin;
  WEB_PORT="15653";WEB_ORIGIN="http://127.0.0.1:15653";BETTER_AUTH_URL="http://127.0.0.1:15653";
  SIGNUPS_ENABLED="true";EMAIL_EMULATOR="true";WAKEUP_DRIVER="graphile";
  AGENT_RUNTIME="pi";SANDBOX_PROVIDER="none";CLOUD_AGENT_PROVIDER="none";
  DATA_DIR=(Join-Path $dir "app-data");DB_POOL_MAX="3";GRAPHILE_WORKER_CONCURRENCY="1";
  RAKAZO_PAPER_STOP_DIR=$dir;GIT_SHA="qa-actual-disposable";
 }
 Set-QAEnv $qaEnv
 # Prisma must run only against the disposable test port.
 $prisma=Join-Path $repo "packages\db\node_modules\.bin\prisma.cmd"
 $generate=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',('""'+$prisma+'" generate"')) -WorkingDirectory (Join-Path $repo "packages\db") -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $dir "prisma-generate.out") -RedirectStandardError (Join-Path $dir "prisma-generate.err")
 if($generate.ExitCode -ne 0){throw "Disposable checkout Prisma generate failed"}
 Assert-QA (Test-Path (Join-Path $repo "packages\db\src\generated\prisma\client.ts")) "Isolated Prisma Client generated"
 $migration=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',('""'+$prisma+'" migrate deploy"')) -WorkingDirectory (Join-Path $repo "packages\db") -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $dir "migration.out") -RedirectStandardError (Join-Path $dir "migration.err")
 if($migration.ExitCode -ne 0){
  throw ("Disposable migrations failed; see "+(Join-Path $dir "migration.err"))
 }
 Assert-QA $true "Real Prisma migrations completed on disposable database"
 $argsApi=@("--import",([uri]$tsx).AbsoluteUri,(Join-Path $repo "apps\api\src\index.ts"))
 $api=Start-Process -FilePath $node -ArgumentList $argsApi -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "api.out") -RedirectStandardError (Join-Path $dir "api.err")
 $started+=@($api.Id)
 for($i=0;$i -lt 160 -and !(Listen 15651);$i++){Start-Sleep -Milliseconds 200}
 if(!(Listen 15651)){throw "Actual API never listened; inspect api.err"}
 $health=Invoke-WebRequest -Uri "http://127.0.0.1:15651/health" -TimeoutSec 8 -UseBasicParsing
 Assert-QA ($health.StatusCode -eq 200) "Actual Rakazo API /health returned 200"
 $worker=Start-Process -FilePath $node -ArgumentList @("--import",([uri]$tsx).AbsoluteUri,(Join-Path $repo "apps\worker\src\index.ts")) -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "worker.out") -RedirectStandardError (Join-Path $dir "worker.err")
 $started+=@($worker.Id)
 for($i=0;$i -lt 150 -and !(Test-Path (Join-Path $dir "paper-worker-stop.ready.json"));$i++){Start-Sleep -Milliseconds 200}
 if(!(Test-Path (Join-Path $dir "paper-worker-stop.ready.json"))){throw "Actual worker never registered stop protocol"}
 Assert-QA ([bool](Get-Process -Id $worker.Id -ErrorAction SilentlyContinue)) "Actual Rakazo worker registered control"
 $tokenBytes=[Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
 $qaToken="rkg_"+[Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+","-").Replace("/","_")
 $gatewayConfig=@{
  publicOrigin="http://127.0.0.1:15652";authOrigin="http://127.0.0.1:15652";
  authApi="http://127.0.0.1:15651";allowedUserId="qa-only-user";
  paperApi="http://127.0.0.1:15651";paperOrigin="http://127.0.0.1:15652";
  paperSpaceId="qa-only-space";procedures=@("trading/perpetualJournalRead");
  expiresAt=[DateTime]::UtcNow.AddHours(1).ToString("o");
  credentialEnv="RAKAZO_ACTUAL_QA_GRANT";assetsDir=(Join-Path $dir "assets");
  port=15652;
 }
 $gatewayJson=Join-Path $dir "gateway-config.json"
 $gatewayConfig|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $gatewayJson
 Set-QAEnv @{RAKAZO_ACTUAL_QA_GRANT=$qaToken}
 $gatewayEntry=Join-Path $gatewayRepo "scripts\local-paper-journal\server.mjs"
 $gateway=Start-Process -FilePath $node -ArgumentList @($gatewayEntry,$gatewayJson) -WorkingDirectory $gatewayRepo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "gateway.out") -RedirectStandardError (Join-Path $dir "gateway.err")
 $started+=@($gateway.Id)
 for($i=0;$i -lt 110 -and !(Listen 15652);$i++){Start-Sleep -Milliseconds 200}
 Assert-QA (Listen 15652) "Actual journal gateway listened on isolated port"
 $probe=Invoke-WebRequest -Uri "http://127.0.0.1:15652/linked-paper/status" -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 8
 Assert-QA ($probe.StatusCode -ge 400 -and $probe.StatusCode -lt 600) "Unauthenticated journal status did not expose trading data"
 $cfg=@{repo=$repo;pgBin=$bin;pgData=$data;pgPort=15549}
 $cfg|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dir "paper-runtime-config.json")
 $pids=@{api=(Register-Service "api" $api (Join-Path $repo "apps\api\src\index.ts"));
  worker=(Register-Service "worker" $worker (Join-Path $repo "apps\worker\src\index.ts"))}
 $pids|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $dir "paper-runtime-pids.json")
 $gw=(Register-Service "gateway" $gateway $gatewayEntry)
 @{pid=$gw.pid;server=$gatewayEntry;startedAt=$gw.startedAt}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dir "linked-journal-gateway-pid.json")
 $lcFile=Join-Path $PSScriptRoot "..\Paper.Lifecycle.ps1"
 $ctrlFile=Join-Path $PSScriptRoot "..\Paper.GracefulWorker.ps1"
 $source=[IO.File]::ReadAllText($lcFile)
 $old='$root=Join-Path $env:USERPROFILE ''RakazoRuntime\trading-live-data-20261011'''
 if(!$source.Contains($old)){throw "Lifecycle root injection anchor missing"}
 $source=$source.Replace($old,'$root='+"'"+$dir+"'")
 $source=$source.Replace("Assert-ListeningIdentity 3008","Assert-ListeningIdentity 15651")
 $source=$source.Replace("Assert-ListeningIdentity 5190","Assert-ListeningIdentity 15652")
 [IO.File]::WriteAllText((Join-Path $dir "Paper.Lifecycle.ps1"),$source,[Text.UTF8Encoding]::new($false))
 Copy-Item -LiteralPath $ctrlFile -Destination (Join-Path $dir "Paper.GracefulWorker.ps1")
 $qaLc=Join-Path $dir "Paper.Lifecycle.ps1"
 $plan=(& $qaLc -Action Plan|Select-Object -Last 1|ConvertFrom-Json)
 Assert-QA ($plan.stopEligible -and $plan.workerDrainReady -and $plan.apiDrainReady -and $plan.gatewayDrainReady) "Actual three services all support coordinated stop"
 $snapshot=Join-Path $dir "qa-snapshot.txt"
 [IO.File]::WriteAllText($snapshot,"PAPER ONLY: no live positions and no synthetic fills")
 $digest=(Get-FileHash $snapshot -Algorithm SHA256).Hash
 $denied=$false
 try{& $qaLc -Action Stop -ErrorAction Stop|Out-Null}catch{$denied=$true}
 Assert-QA $denied "Actual-services Quit without owner confirmation denied"
 $stopReceipt=& $qaLc -Action Stop -ConfirmedOwnerQuit
 foreach($role in @("worker","gateway","api")){
  $ackFile=Join-Path $dir ("paper-"+$role+"-stop.ack.json")
  $ack=Get-Content -LiteralPath $ackFile -Raw|ConvertFrom-Json
  Assert-QA ($ack.service -eq $role -and $ack.state -eq "drained") ($role+" actual role confirmed drained")
 }
 Assert-QA (!(Listen 15549)) "Disposable database offline after all service acknowledgments"
 Assert-QA ((Get-FileHash $snapshot -Algorithm SHA256).Hash -eq $digest) "Actual-services QA snapshot preserved"
 $record=Get-Content (Join-Path $dir "paper-offline-lifecycle.json") -Raw|ConvertFrom-Json
 Assert-QA ($record.state -eq "offline" -and $record.reviewRequired -and $record.offlineExecutionsNotVerified) "Actual-services offline interval preserves mandatory review"
 # Restart only disposable PostgreSQL and processes after confirmed exits.
 foreach($id in @($worker.Id,$api.Id,$gateway.Id)){
  Assert-QA (!(Get-Process -Id $id -ErrorAction SilentlyContinue)) ("Old QA PID exited "+$id)
 }
 foreach($role in @("worker","api","gateway")){
  foreach($kind in @("ready","request","ack")){
   $stale=Join-Path $dir ("paper-"+$role+"-stop."+$kind+".json")
   if(Test-Path $stale){Remove-Item -LiteralPath $stale -Force}
  }
 }
 & (Join-Path $bin "pg_ctl.exe") -D $data -o '-h 127.0.0.1 -p 15549' -l (Join-Path $dir "postgres-restart.log") -w -t 25 start
 if($LASTEXITCODE -ne 0){throw "QA PostgreSQL restart failed"}
 Assert-QA (Listen 15549) "Disposable PostgreSQL restarted"
 $apiAgain=Start-Process -FilePath $node -ArgumentList $argsApi -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "api-restart.out") -RedirectStandardError (Join-Path $dir "api-restart.err")
 $started+=@($apiAgain.Id)
 for($i=0;$i -lt 160 -and !(Listen 15651);$i++){Start-Sleep -Milliseconds 200}
 if(!(Listen 15651)){throw "Actual API did not restart"}
 $healthAgain=Invoke-WebRequest -Uri "http://127.0.0.1:15651/health" -TimeoutSec 8 -UseBasicParsing
 Assert-QA ($healthAgain.StatusCode -eq 200) "Actual API healthy after restart"
 $workerAgain=Start-Process -FilePath $node -ArgumentList @("--import",([uri]$tsx).AbsoluteUri,(Join-Path $repo "apps\worker\src\index.ts")) -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "worker-restart.out") -RedirectStandardError (Join-Path $dir "worker-restart.err")
 $started+=@($workerAgain.Id)
 for($i=0;$i -lt 150 -and !(Test-Path (Join-Path $dir "paper-worker-stop.ready.json"));$i++){Start-Sleep -Milliseconds 200}
 Assert-QA (Test-Path (Join-Path $dir "paper-worker-stop.ready.json")) "Actual worker registered new shutdown instance"
 $gatewayAgain=Start-Process -FilePath $node -ArgumentList @($gatewayEntry,$gatewayJson) -WorkingDirectory $gatewayRepo -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir "gateway-restart.out") -RedirectStandardError (Join-Path $dir "gateway-restart.err")
 $started+=@($gatewayAgain.Id)
 for($i=0;$i -lt 110 -and !(Listen 15652);$i++){Start-Sleep -Milliseconds 200}
 Assert-QA (Listen 15652) "Actual gateway listening after restart"
 $newPids=@{
  api=(Register-Service "api" $apiAgain (Join-Path $repo "apps\api\src\index.ts"));
  worker=(Register-Service "worker" $workerAgain (Join-Path $repo "apps\worker\src\index.ts"))
 }
 $newPids|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $dir "paper-runtime-pids.json")
 $newGw=(Register-Service "gateway" $gatewayAgain $gatewayEntry)
 @{pid=$newGw.pid;server=$gatewayEntry;startedAt=$newGw.startedAt}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dir "linked-journal-gateway-pid.json")
 $planAgain=(& $qaLc -Action Plan|Select-Object -Last 1|ConvertFrom-Json)
 Assert-QA ($planAgain.stopEligible -and $planAgain.workerDrainReady -and $planAgain.apiDrainReady -and $planAgain.gatewayDrainReady) "New actual service identities verified after restart"
 $resumeSrc=Join-Path $PSScriptRoot "..\Paper.ResumeReview.ps1"
 $resume=[IO.File]::ReadAllText($resumeSrc)
 $resumeRoot='$root = Join-Path $HOME ''RakazoRuntime\trading-live-data-20261011'''
 if(!$resume.Contains($resumeRoot)){throw "Resume root injection anchor missing"}
 $resume=$resume.Replace($resumeRoot,'$root = '+"'"+$dir+"'")
 $resume=$resume.Replace("http://127.0.0.1:3008/health","http://127.0.0.1:15651/health")
 $qaResume=Join-Path $dir "Paper.ResumeReview.ps1"
 [IO.File]::WriteAllText($qaResume,$resume,[Text.UTF8Encoding]::new($false))
 $resumeProof=(& $qaResume|Select-Object -Last 1|ConvertFrom-Json)
 Assert-QA ($resumeProof.changed -and $resumeProof.state -eq "resumed_review_pending") "Actual restart recorded mandatory offline review"
 $resumeTwice=(& $qaResume|Select-Object -Last 1|ConvertFrom-Json)
 Assert-QA (!$resumeTwice.changed) "Repeated resume is idempotent"
 $review=Get-Content (Join-Path $dir "paper-offline-lifecycle.json") -Raw|ConvertFrom-Json
 Assert-QA ($review.reviewRequired -and $review.fundingReviewRequired -and $review.historicalStopReviewRequired -and $review.offlineExecutionsNotVerified) "Funding and historical-stop execution remain unverified"
 Assert-QA ((Get-FileHash $snapshot -Algorithm SHA256).Hash -eq $digest) "PAPER QA snapshot preserved after full restart"
 Write-Output "ACTUAL_RAKAZO_BACKEND_QUIT_RESTART_PASS"
 Write-Output "ACTUAL_RAKAZO_BACKEND_GRACEFUL_STOP_PASS"
}finally{
 Restore-QAEnv
 foreach($pidNum in $started){
  if(Is-QANode $pidNum){Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue}
 }
 $pgctl=Join-Path $bin "pg_ctl.exe"
 if($pgStarted -and (Test-Path (Join-Path $data "PG_VERSION"))){
  $pidfile=Join-Path $data "postmaster.pid"
  if(Test-Path $pidfile){
   $lines=@(Get-Content $pidfile)
   if($lines.Count -lt 4 -or $lines[3] -ne "15549" -or
      ([string]$lines[1]).Replace("\","/") -ine $data.Replace("\","/")){
    throw "QA PostgreSQL identity mismatch; refuse stop"
   }
   & $pgctl -D $data -m fast -w -t 25 stop |Out-Null
  }
 }
 Write-Output ("ACTUAL_QA_ROOT="+$dir)
}
