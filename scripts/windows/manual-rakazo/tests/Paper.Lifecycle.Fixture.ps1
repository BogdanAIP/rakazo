# Disposable lifecycle fixture: absolutely no real process or database termination.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$src=(Join-Path (Split-Path -Parent $PSScriptRoot) 'Paper.Lifecycle.ps1')
$base=Join-Path $env:TEMP ('paper-lifecycle-qa-'+[guid]::NewGuid().ToString('N'))
$runtime=Join-Path $base 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$paper=@{mode='PAPER_ONLY';positions=@(@{id='sol';side='short';qty='2'});
 pendingOrders=@(@{id='order-1';side='buy';qty='0.1'});events=@(@{seq=1;kind='open'},@{seq=2;kind='pending'})}|ConvertTo-Json -Depth 6
$journal=Join-Path $runtime 'paper-ledger.json'
[IO.File]::WriteAllText($journal,$paper,[Text.UTF8Encoding]::new($false))
function Hash-Journal {
 return [Convert]::ToBase64String(([Security.Cryptography.SHA256]::Create()).ComputeHash([IO.File]::ReadAllBytes($journal)))
}
$beforeHash=Hash-Journal
foreach($n in 'api','worker','gateway','database') {Set-Content (Join-Path $runtime ($n+'.state')) 'running'}
@{repo=(Join-Path $base 'repo');pgBin=(Join-Path $base 'bin');pgData=(Join-Path $base 'pgdata');pgPort=15548} |
 ConvertTo-Json|Set-Content (Join-Path $runtime 'paper-runtime-config.json')
@{api=@{pid=80001;startedAt='2026-10-19T00:00:00Z'};worker=@{pid=80002;startedAt='2026-10-19T00:00:00Z'}}|
 ConvertTo-Json -Depth 5|Set-Content (Join-Path $runtime 'paper-runtime-pids.json')
@{pid=80003;server='fixture-gateway';startedAt='2026-10-19T00:00:00Z'}|
 ConvertTo-Json|Set-Content (Join-Path $runtime 'linked-journal-gateway-pid.json')
$sim=[IO.File]::ReadAllText($src)
$old='$root=Join-Path $env:USERPROFILE ''RakazoRuntime\trading-live-data-20261011'''
if(!$sim.Contains($old)){throw 'Cannot relocate lifecycle to isolated root'}
$sim=$sim.Replace($old,'$root='+"'"+$runtime+"'")
# Test-specific I/O stubs affect ONLY disposable QA copy, not production.
$patterns=@(
 '(?ms)^function Test-RegisteredProcess\([\s\S]*?^\}',
 '(?ms)^function Assert-ListeningIdentity\([\s\S]*?^\}',
 '(?ms)^\$pgCtl=Join-Path[\s\S]*?^if\(\$Action -eq ''Probe'' -or \$Action -eq ''Plan''\)\{',
 '(?ms)^function Stop-Registered\([\s\S]*?^\}',
 '(?ms)^if\(\$pgRunning\)\{\s*& \$pgCtl[\s\S]*?^\}'
)
$replacements=@(
 'function Test-RegisteredProcess($item,[string]$entry,[string]$role){$name=if($role -eq ''journal''){''gateway''}else{$role};return ((Get-Content (Join-Path $runtime ($name+''.state'')) -Raw).Trim() -eq ''running'')}',
 'function Assert-ListeningIdentity([int]$port,[int]$expectedPid,[string]$role){return}',
 '$pgRunning=((Get-Content (Join-Path $runtime ''database.state'') -Raw).Trim() -eq ''running'');$workerDrainReady=$true;$apiDrainReady=$true;$gatewayDrainReady=$true;if($Action -eq ''Probe'' -or $Action -eq ''Plan''){',
 'function Stop-Registered($item,[string]$entry,[string]$role){$name=if($role -eq ''journal''){''gateway''}else{$role};Set-Content (Join-Path $runtime ($name+''.state'')) ''stopped''}',
 'if($pgRunning){Set-Content (Join-Path $runtime ''database.state'') ''stopped''}'
)
for($i=0;$i -lt $patterns.Count;$i++){
 $rg=[regex]::new($patterns[$i])
 if($rg.Matches($sim).Count -ne 1){throw ('QA boundary mismatch #'+$i+' count='+$rg.Matches($sim).Count)}
 $sim=$rg.Replace($sim,[string]$replacements[$i],1)
}
# Production worker drain is validated separately with a genuine Node child.
$mockWorkerBlock='(?ms)^if\(\$worker\)\{\s*\$drainScript=Join-Path[\s\S]*?^\}'
if(([regex]::Matches($sim,$mockWorkerBlock)).Count -ne 1){throw 'Fixture worker boundary ambiguous'}
$sim=[regex]::Replace($sim,$mockWorkerBlock,'if($worker){Set-Content (Join-Path $runtime ''worker.state'') ''stopped''}',1)
# Only in the disposable fixture: mark API and gateway stopped in state files.
$serviceBlock='(?ms)^if\(\$gatewayOk\)\{\s*\$receipt=& \$drainPath -Action Request -Service gateway[\s\S]*?^if\(\$api\)\{[\s\S]*?^\}'
if(([regex]::Matches($sim,$serviceBlock)).Count -ne 1){throw 'Disposable service block not uniquely located'}
$sim=[regex]::Replace($sim,$serviceBlock,'if($gatewayOk){Set-Content (Join-Path $runtime ''gateway.state'') ''stopped''};if($api){Set-Content (Join-Path $runtime ''api.state'') ''stopped''}',1)
$qaScript=Join-Path $runtime 'QA-lifecycle.ps1'
[IO.File]::WriteAllText($qaScript,$sim,[Text.UTF8Encoding]::new($false))
$err=$null;$tok=$null
[Management.Automation.Language.Parser]::ParseFile($qaScript,[ref]$tok,[ref]$err)|Out-Null
if(@($err).Count){throw 'QA fixture parse failed'}
$counts=[ordered]@{}
function Check([bool]$ok,[string]$key){if(!$ok){throw ('FAIL '+$key)};$counts[$key]='PASS'}
$mark=Join-Path $runtime 'paper-offline-lifecycle.json'
$plan=(& $qaScript -Action Plan|Select-Object -Last 1|ConvertFrom-Json)
Check ($plan.api -and $plan.worker -and $plan.gateway -and $plan.database -and !$plan.wouldChange) 'PLAN_READ_ONLY'
Check (!(Test-Path $mark)) 'PLAN_NO_MARKER'
$denied=$false
try{& $qaScript -Action Stop -ErrorAction Stop|Out-Null}catch{$denied=$true}
Check $denied 'UNCONFIRMED_STOP_DENIED'
Check (!(Test-Path $mark)) 'DENIED_STOP_NO_MUTATION'
& $qaScript -Action Stop -ConfirmedOwnerQuit | Out-Null
foreach($n in 'api','worker','gateway','database'){
 Check (((Get-Content (Join-Path $runtime ($n+'.state')) -Raw).Trim()) -eq 'stopped') ('STOP_'+$n.ToUpperInvariant())
}
$offline=Get-Content $mark -Raw|ConvertFrom-Json
Check ($offline.state -eq 'offline' -and $offline.reviewRequired -and $offline.offlineExecutionsNotVerified) 'OFFLINE_REVIEW_REQUIRED'
Check ((Hash-Journal) -eq $beforeHash) 'JOURNAL_POSITION_AND_ORDER_UNCHANGED'
$stamp=(Get-Item $mark).LastWriteTimeUtc
& $qaScript -Action Stop -ConfirmedOwnerQuit | Out-Null
Check ((Get-Item $mark).LastWriteTimeUtc -eq $stamp) 'STOP_IDEMPOTENT'
foreach($n in 'api','worker','gateway','database'){Set-Content (Join-Path $runtime ($n+'.state')) 'running'}
$again=& $qaScript -Action Probe|Select-Object -Last 1|ConvertFrom-Json
Check ($again.api -and $again.worker -and $again.gateway -and $again.database) 'RESTART_REDISCOVERS_ALL_SERVICES'
Check ((Hash-Journal) -eq $beforeHash) 'RESTART_JOURNAL_HASH_IDENTICAL'
$offline2=Get-Content $mark -Raw|ConvertFrom-Json
Check $offline2.reviewRequired 'RESTART_DOES_NOT_FABRICATE_MISSED_EXECUTIONS'
$result=[ordered]@{status='PASS';total=$counts.Count;checks=$counts;
 fixture=$base;mode='isolated fixture / simulated process and PostgreSQL boundary';
 mainPaperTouched=$false;realFullShutdownTested=$false;
 positions=1;pendingOrders=1;journalHash=$beforeHash}
$result|ConvertTo-Json -Depth 7
$result|ConvertTo-Json -Depth 7|Set-Content (Join-Path $base 'QA-result.json') -Encoding UTF8
