# Read-only PAPER runtime verification followed by a durable lifecycle marker update.
# No positions, orders, sessions or trading grants are changed.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = Join-Path $HOME 'RakazoRuntime\trading-live-data-20261011'
$marker = Join-Path $root 'paper-offline-lifecycle.json'
if (!(Test-Path -LiteralPath $marker -PathType Leaf)) {
  [pscustomobject]@{state="no_record";changed=$false}|ConvertTo-Json -Compress
  return
}
$raw=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json
if ($raw.mode -ne "PAPER_ONLY" -or $raw.state -notin @("stopping","offline","resumed_review_pending")) {
  throw "PAPER lifecycle marker requires manual review"
}
if ($raw.state -eq "resumed_review_pending") {
  [pscustomobject]@{state="resumed_review_pending";changed=$false;reviewRequired=$true}|ConvertTo-Json -Compress
  return
}
$probeScript = Join-Path $PSScriptRoot 'Paper.Lifecycle.ps1'
$probeText = & $probeScript -Action Probe | Select-Object -Last 1
$probe = $probeText | ConvertFrom-Json
if ($probe.mode -ne "PAPER_ONLY" -or !$probe.api -or !$probe.worker -or !$probe.database -or !$probe.gateway -or $probe.wouldChange) {
  throw "PAPER services are not all verified; no lifecycle resume recorded"
}
try {
  $health=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3008/health' -TimeoutSec 4
  if ($health.StatusCode -ne 200) { throw 'PAPER API unavailable' }
} catch { throw "PAPER API health not verified; no lifecycle resume recorded" }
if ($CheckOnly) {
  [pscustomobject]@{state=$raw.state;changed=$false;readyToRecord=$true}|ConvertTo-Json -Compress
  return
}
$now=[DateTime]::UtcNow.ToString("o")
if ($raw.state -eq "stopping" -and !($raw.PSObject.Properties.Name -contains "stoppedAtUtc")) {
  # Shutdown did not complete. Use the earliest known interruption boundary,
  # and require manual historical reconciliation rather than inventing fills.
  try {
    $interruptedAt = if ($raw.requestedAtUtc -is [DateTime]) {
      $raw.requestedAtUtc.ToUniversalTime().ToString("o")
    } else {
      [DateTimeOffset]::Parse([string]$raw.requestedAtUtc,
        [Globalization.CultureInfo]::InvariantCulture).UtcDateTime.ToString("o")
    }
  } catch { throw "PAPER incomplete shutdown time missing" }
  $raw | Add-Member -NotePropertyName stoppedAtUtc -NotePropertyValue $interruptedAt -Force
  $raw | Add-Member -NotePropertyName shutdownIncomplete -NotePropertyValue $true -Force
}
$raw.state="resumed_review_pending"
$raw | Add-Member -NotePropertyName resumedAtUtc -NotePropertyValue $now -Force
$raw | Add-Member -NotePropertyName reviewRequired -NotePropertyValue $true -Force
$raw | Add-Member -NotePropertyName offlineExecutionsNotVerified -NotePropertyValue $true -Force
$raw | Add-Member -NotePropertyName fundingReviewRequired -NotePropertyValue $true -Force
$raw | Add-Member -NotePropertyName historicalStopReviewRequired -NotePropertyValue $true -Force
$temp=$marker+'.resuming-'+[guid]::NewGuid().ToString('N')
try {
 [IO.File]::WriteAllText($temp,($raw|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 [IO.File]::Replace($temp,$marker,($marker+'.before-resume.bak'),$true)
} finally {
 if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}
}
[pscustomobject]@{state="resumed_review_pending";changed=$true;
  reviewRequired=$true;noHistoricalFillsCreated=$true}|ConvertTo-Json -Compress
