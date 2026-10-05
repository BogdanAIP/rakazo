# Read-only evidence for deciding whether PostgreSQL itself may handle a stale
# postmaster.pid. This helper never deletes the PID file, stops a process, or
# starts PostgreSQL. The caller must still verify the target port before pg_ctl.
function Get-NativePostgresPidFileEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Spec
    )

    $state = [ordered]@{
        Present = $false
        MetadataVerified = $false
        RecordedPid = $null
        ProcessExists = $false
        ProcessMatches = $false
        SafeToDelegateRecovery = $false
        Reason = 'absent'
    }

    $pidFile = Join-Path ([string]$Spec.Data) 'postmaster.pid'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return [pscustomobject]$state
    }
    $state.Present = $true

    try {
        $pidLines = @(Get-Content -LiteralPath $pidFile -ErrorAction Stop)
        if ($pidLines.Count -lt 4) {
            $state.Reason = 'malformed-pidfile'
            return [pscustomobject]$state
        }

        [int]$serverPid = 0
        if (-not [int]::TryParse($pidLines[0].Trim(), [ref]$serverPid) -or $serverPid -le 0) {
            $state.Reason = 'invalid-pid'
            return [pscustomobject]$state
        }

        [long]$expectedStartSeconds = 0
        if (-not [long]::TryParse($pidLines[2].Trim(), [ref]$expectedStartSeconds) -or
            $expectedStartSeconds -le 0) {
            $state.Reason = 'invalid-start-time'
            return [pscustomobject]$state
        }

        [int]$recordedPort = 0
        if (-not [int]::TryParse($pidLines[3].Trim(), [ref]$recordedPort) -or
            $recordedPort -ne [int]$Spec.Port) {
            $state.Reason = 'unexpected-port'
            return [pscustomobject]$state
        }

        $expectedData = [IO.Path]::GetFullPath([string]$Spec.Data).TrimEnd('\', '/')
        $reportedData = [IO.Path]::GetFullPath($pidLines[1].Trim()).TrimEnd('\', '/')
        if (-not [string]::Equals(
            $expectedData, $reportedData, [StringComparison]::OrdinalIgnoreCase
        )) {
            $state.Reason = 'unexpected-data-directory'
            return [pscustomobject]$state
        }

        $state.MetadataVerified = $true
        $state.RecordedPid = $serverPid

        $serverProcess = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if ($null -eq $serverProcess) {
            # PostgreSQL owns stale-pid cleanup/recovery semantics. Once the
            # metadata is exact and the recorded PID is absent, the launcher
            # may ask pg_ctl to start the same prepared cluster. Never delete
            # postmaster.pid in launcher code.
            $state.SafeToDelegateRecovery = $true
            $state.Reason = 'stale-no-process'
            return [pscustomobject]$state
        }

        $state.ProcessExists = $true
        $pgExe = Join-Path ([string]$Spec.Bin) 'postgres.exe'
        $processPath = $null
        try { $processPath = $serverProcess.Path } catch { }
        if (-not $processPath -or -not [string]::Equals(
            [IO.Path]::GetFullPath($processPath),
            [IO.Path]::GetFullPath($pgExe),
            [StringComparison]::OrdinalIgnoreCase
        )) {
            $state.Reason = 'pid-reused-by-other-process'
            return [pscustomobject]$state
        }

        $expectedStart = [DateTimeOffset]::FromUnixTimeSeconds($expectedStartSeconds).UtcDateTime
        $actualStart = $serverProcess.StartTime.ToUniversalTime()
        if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 20) {
            $state.Reason = 'postgres-pid-start-mismatch'
            return [pscustomobject]$state
        }

        $state.ProcessMatches = $true
        $state.Reason = 'matching-postgres-process-still-running'
    } catch {
        # Fail closed. Never expose raw PID-file contents or process command lines.
        $state.Reason = 'unreadable-or-invalid-pidfile'
    }

    return [pscustomobject]$state
}
