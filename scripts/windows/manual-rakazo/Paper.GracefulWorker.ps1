# PAPER_ONLY: fail-closed local request/ack protocol, no taskkill and no SQL writes.
[CmdletBinding()]
param(
 [ValidateSet('Probe','Request')][string]$Action='Probe',
 [ValidateSet('worker','api','gateway')][string]$Service='worker',
 [switch]$ConfirmedOwnerQuit,
 [string]$RuntimeRoot = (Join-Path $HOME 'RakazoRuntime\trading-live-data-20261011'),
 [ValidateRange(2,180)][int]$TimeoutSeconds=90
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=[IO.Path]::GetFullPath($RuntimeRoot)
$config=Get-Content -LiteralPath (Join-Path $root 'paper-runtime-config.json') -Raw|ConvertFrom-Json
$registered=Get-Content -LiteralPath (Join-Path $root 'paper-runtime-pids.json') -Raw|ConvertFrom-Json
$component=if($Service -eq 'gateway'){
 Get-Content -LiteralPath (Join-Path $root 'linked-journal-gateway-pid.json') -Raw|ConvertFrom-Json
}else{
 $registered.$Service
}
if($null -eq $component -or !$component.pid -or !$component.startedAt){throw ('No verified PAPER '+$Service+' registration')}
$pidNum=[int]$component.pid
$proc=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$pidNum)
if(!$proc){throw ('Registered PAPER '+$Service+' no longer runs')}
$command=[string]$proc.CommandLine
$entry=if($Service -eq 'gateway'){$component.server}else{
 [IO.Path]::Combine([string]$config.repo,'apps',$Service,'src','index.ts')
}
$entry=[string]$entry
if(!$command.Replace('\','/').Contains($entry.Replace('\','/'))){throw ('PAPER '+$Service+' process identity mismatch')}
$recorded=if($component.startedAt -is [DateTime]){
 $component.startedAt.ToUniversalTime()
}else{
 [DateTimeOffset]::Parse([string]$component.startedAt).UtcDateTime
}
if([Math]::Abs(($proc.CreationDate.ToUniversalTime()-$recorded).TotalSeconds) -gt 25){
 throw ('PAPER '+$Service+' PID was reused')
}
$readyFile=Join-Path $root ('paper-'+$Service+'-stop.ready.json')
if(!(Test-Path -LiteralPath $readyFile -PathType Leaf)){
 if($Action -eq 'Probe'){
  [pscustomobject]@{mode='PAPER_ONLY';ready=$false;wouldChange=$false}|ConvertTo-Json -Compress
  return
 }
 throw ('PAPER '+$Service+' did not register graceful shutdown; no processes stopped')
}
$ready=Get-Content -LiteralPath $readyFile -Raw|ConvertFrom-Json
if($ready.mode -ne 'PAPER_ONLY' -or $ready.version -ne 1 -or $ready.pid -ne $pidNum -or
 [string]$ready.instanceId -notmatch '^[0-9a-f-]{36}$' -or
 [string]$ready.token -notmatch '^[0-9a-f]{64}$'){
 throw 'Invalid PAPER worker control identity'
}
$readyAt=if($ready.readyAtUtc -is [DateTime]){$ready.readyAtUtc.ToUniversalTime()}else{
 [DateTimeOffset]::Parse([string]$ready.readyAtUtc).UtcDateTime
}
if($readyAt -lt $proc.CreationDate.ToUniversalTime().AddSeconds(-5) -or
 $readyAt -gt [DateTime]::UtcNow.AddSeconds(10)){
 throw 'Stale or future PAPER worker control file'
}
if($Action -eq 'Probe'){
 [pscustomobject]@{mode='PAPER_ONLY';ready=$true;wouldChange=$false;
   pid=$pidNum;instanceId=$ready.instanceId}|ConvertTo-Json -Compress
 return
}
if(!$ConfirmedOwnerQuit){throw 'Worker drain requires an explicitly confirmed owner Quit'}
$requestFile=Join-Path $root ('paper-'+$Service+'-stop.request.json')
$ackFile=Join-Path $root ('paper-'+$Service+'-stop.ack.json')
if(Test-Path $requestFile){
 $previous=Get-Content -LiteralPath $requestFile -Raw|ConvertFrom-Json
 if($previous.pid -eq $pidNum -and $previous.instanceId -eq $ready.instanceId -and
   $previous.token -eq $ready.token){
  throw 'An existing PAPER drain request is still pending; manual review required'
 }
}
$requestId=[guid]::NewGuid().ToString()
$body=[ordered]@{pid=$pidNum;instanceId=$ready.instanceId;token=$ready.token;requestId=$requestId;
 requestedAtUtc=[DateTime]::UtcNow.ToString('o')}
$temp=$requestFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
try {
 [IO.File]::WriteAllText($temp,($body|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $temp -Destination $requestFile -Force -ErrorAction Stop
} finally {
 if(Test-Path $temp){Remove-Item -LiteralPath $temp -Force}
}
$until=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$ackReceived=$false
while([DateTime]::UtcNow -lt $until){
 if(Test-Path $ackFile){
  try {
   $ack=Get-Content -LiteralPath $ackFile -Raw|ConvertFrom-Json
   if($ack.pid -eq $pidNum -and $ack.instanceId -eq $ready.instanceId -and
      $ack.requestId -eq $requestId){
    if($ack.state -eq 'failed'){throw 'PAPER worker reported failed drain; retaining services'}
    if($ack.state -ne 'drained'){throw 'Unknown PAPER drain acknowledgement'}
    $ackReceived=$true
    break
   }
  } catch {
   if($_.Exception.Message -match 'reported failed drain|Unknown PAPER drain'){throw}
   # Writer may be in the middle of its atomic replacement. Try again.
  }
 }
 Start-Sleep -Milliseconds 200
}
if(!$ackReceived){throw 'PAPER worker drain acknowledgement timed out; no forced termination'}
while([DateTime]::UtcNow -lt $until){
 if(!(Get-Process -Id $pidNum -ErrorAction SilentlyContinue)){
  [pscustomobject]@{mode='PAPER_ONLY';state='drained';service=$Service;pid=$pidNum;
    requestId=$requestId;exited=$true}|ConvertTo-Json -Compress
  return
 }
 Start-Sleep -Milliseconds 200
}
throw 'PAPER worker reported drain but has not exited; database must remain online'
