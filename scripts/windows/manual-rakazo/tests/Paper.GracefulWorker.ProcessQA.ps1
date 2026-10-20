[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$WorkerSourceRepo)
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ('paper-drain-process-qa-'+[guid]::NewGuid().ToString('N'))
$repo=Join-Path $root 'repo'
$entryDir=Join-Path $repo 'apps\worker\src'
New-Item -ItemType Directory -Path $entryDir -Force|Out-Null
$src=(Join-Path $WorkerSourceRepo 'apps\worker\src\paper-graceful-stop.ts')
Copy-Item $src (Join-Path $entryDir 'paper-graceful-stop.ts') -ErrorAction Stop
$entry=Join-Path $entryDir 'index.ts'
$nodeScript=@"
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPaperStopControl } from "./paper-graceful-stop.ts";
const folder = process.argv[2];
const drain = async () => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (process.env.QA_FAIL_DRAIN === "1") throw new Error("simulated drain failure");
  await writeFile(path.join(folder, "drain-finished.txt"), "done");
};
void createPaperStopControl({
  directory: folder, drain,
  exit: (code) => process.exit(code),
  onError: (err) => writeFile(path.join(folder,"drain-error.txt"),String(err)).catch(() => {}),
});
setInterval(() => {}, 60000);
"@
[IO.File]::WriteAllText($entry,$nodeScript,[Text.UTF8Encoding]::new($false))
$loader=(Join-Path $WorkerSourceRepo 'node_modules\tsx\dist\loader.mjs')
if(!(Test-Path $loader)){throw 'tsx loader unavailable'}
$drainScript=Join-Path (Split-Path -Parent $PSScriptRoot) 'Paper.GracefulWorker.ps1'
$node='C:\Program Files\nodejs\node.exe'
$script:qaPids=@()
function Check([bool]$condition,[string]$description){
 if(!$condition){throw ('FAILED: '+$description)}
 Write-Output ('PASS: '+$description)
}
try {
 $stdout=Join-Path $root 'worker.out'
 $stderr=Join-Path $root 'worker.err'
 $loaderUrl=([uri]$loader).AbsoluteUri
 $process=Start-Process -FilePath $node -ArgumentList @('--import',$loaderUrl,$entry,$root) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
 $script:qaPids+= $process.Id
 $readyFile=Join-Path $root 'paper-worker-stop.ready.json'
 for($i=0;$i -lt 70 -and !(Test-Path $readyFile);$i++){Start-Sleep -Milliseconds 100}
 if(!(Test-Path $readyFile)){
  throw ('QA worker failed to start: '+(Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
 }
 $observed=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id)
 if(!$observed -or !([string]$observed.CommandLine).Replace('\','/').Contains($entry.Replace('\','/'))){
  throw 'QA process identity could not be proven'
 }
 @{repo=$repo} | ConvertTo-Json | Set-Content (Join-Path $root 'paper-runtime-config.json')
 @{worker=@{pid=$process.Id;startedAt=$observed.CreationDate.ToUniversalTime().ToString('o')}} |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'paper-runtime-pids.json')
 $probe=& $drainScript -Action Probe -RuntimeRoot $root | Select-Object -Last 1 | ConvertFrom-Json
 Check ($probe.ready -and $probe.pid -eq $process.Id -and !$probe.wouldChange) 'Real isolated PID and token verified'
 $denied=$false
 try { & $drainScript -Action Request -RuntimeRoot $root -TimeoutSeconds 8 -ErrorAction Stop|Out-Null }
 catch {$denied=$true}
 Check $denied 'Unconfirmed stop denied'
 Check ([bool](Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) 'Unconfirmed stop leaves worker running'
 $result=& $drainScript -Action Request -ConfirmedOwnerQuit -RuntimeRoot $root -TimeoutSeconds 15 |Select-Object -Last 1|ConvertFrom-Json
 Check ($result.state -eq 'drained' -and $result.exited -and $result.pid -eq $process.Id) 'Worker drain acknowledged and PID exited'
 Check (Test-Path (Join-Path $root 'drain-finished.txt')) 'Pending work finished before exit'
 # A failed drain must never kill the worker or assert that the DB can stop.
 Remove-Item -LiteralPath $readyFile -Force
 $env:QA_FAIL_DRAIN='1'
 try {
  $failedProc=Start-Process -FilePath $node -ArgumentList @('--import',$loaderUrl,$entry,$root) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'failed.out') -RedirectStandardError (Join-Path $root 'failed.err') -PassThru
 } finally {
  Remove-Item Env:QA_FAIL_DRAIN -ErrorAction SilentlyContinue
 }
 $script:qaPids+= $failedProc.Id
 for($i=0;$i -lt 70 -and !(Test-Path $readyFile);$i++){Start-Sleep -Milliseconds 100}
 Check (Test-Path $readyFile) 'Failed-drain fixture worker registered'
 $observed=Get-CimInstance Win32_Process -Filter ('ProcessId='+$failedProc.Id)
 if(!$observed){throw 'Failed-drain fixture PID missing'}
 @{worker=@{pid=$failedProc.Id;startedAt=$observed.CreationDate.ToUniversalTime().ToString('o')}} |
   ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'paper-runtime-pids.json')
 $failed=$false
 try {
  & $drainScript -Action Request -ConfirmedOwnerQuit -RuntimeRoot $root -TimeoutSeconds 12 -ErrorAction Stop |Out-Null
 } catch {$failed=$true}
 Check $failed 'Failed drain rejected by Windows controller'
 Check ([bool](Get-Process -Id $failedProc.Id -ErrorAction SilentlyContinue)) 'Failed drain did not terminate worker'
 $ack=Get-Content -LiteralPath (Join-Path $root 'paper-worker-stop.ack.json') -Raw|ConvertFrom-Json
 Check ($ack.state -eq 'failed' -and $ack.pid -eq $failedProc.Id) 'Failed acknowledgment never claims drained'
 Write-Output 'ISOLATED_WINDOWS_GRACEFUL_PROCESS_QA_PASSED'
} finally {
 foreach($pidNum in $script:qaPids){
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidNum) -ErrorAction SilentlyContinue
  if($p -and [string]$p.CommandLine -like ('*'+$repo+'*')){
   Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
  }
 }
}
