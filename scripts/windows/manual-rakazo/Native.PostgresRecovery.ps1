# Fail-closed, same-directory archiving of a proven stale PostgreSQL PID lock.
# This is never an alternative to checking the database process/port. Do not
# remove or overwrite any database files; preserve the original lock for audit.
function Move-VerifiedReusedPostgresPidAside {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Spec
    )

    $pidFile = Join-Path ([string]$Spec.Data) 'postmaster.pid'
    $versionFile = Join-Path ([string]$Spec.Data) 'PG_VERSION'

    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf) -or
        (Get-Content -LiteralPath $versionFile -Raw -ErrorAction Stop).Trim() -cne '17') {
        throw 'Refusing PID recovery: expected PostgreSQL 17 data directory is not verified.'
    }

    # Require exact matching metadata before touching the lock. A PID whose
    # executable differs can be reused; it is NOT, by itself, proof of staleness.
    $initial = Get-NativePostgresPidFileEvidence -Spec $Spec
    if (-not ($initial.Present -and $initial.MetadataVerified -and
        $initial.Reason -ceq 'pid-reused-by-other-process' -and
        $initial.RecordedPid -gt 0)) {
        throw 'Refusing PID recovery: exact reused-PID evidence is missing.'
    }

    $lines = @(Get-Content -LiteralPath $pidFile -ErrorAction Stop)
    $recordedStart = [DateTimeOffset]::FromUnixTimeSeconds([long]$lines[2].Trim()).UtcDateTime
    $fileBefore = Get-Item -LiteralPath $pidFile -ErrorAction Stop
    if (([DateTime]::UtcNow - $fileBefore.LastWriteTimeUtc).TotalSeconds -lt 30) {
        throw 'Refusing PID recovery: postmaster.pid is too recent to classify as stale.'
    }
    $contentsBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pidFile))

    $assertInactive = {
        # Block if any PostgreSQL process exists, even for another database:
        # deliberately conservative when ownership of a cluster is uncertain.
        $postgres = @(Get-CimInstance Win32_Process -Filter "Name = 'postgres.exe'" -ErrorAction Stop)
        if ($postgres.Count -gt 0) {
            throw 'Refusing PID recovery: a PostgreSQL process is running.'
        }
        # Include every binding, not only 127.0.0.1.
        $tcpListeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -eq [int]$Spec.Port })
        if ($tcpListeners.Count -gt 0) {
            throw 'Refusing PID recovery: target PostgreSQL port is occupied.'
        }

        # CIM creation time is accessible for SYSTEM-owned svchost.exe even
        # when Get-Process.StartTime/Path is restricted to elevated users.
        $owner = @(Get-CimInstance Win32_Process -Filter (
            'ProcessId = ' + [string]$initial.RecordedPid
        ) -ErrorAction Stop)
        if ($owner.Count -ne 1 -or -not $owner[0].CreationDate) {
            throw 'Refusing PID recovery: recorded process identity is unavailable.'
        }
        if ([string]$owner[0].Name -ieq 'postgres.exe') {
            throw 'Refusing PID recovery: recorded PID belongs to PostgreSQL.'
        }
        $ownerStartUtc = ([DateTime]$owner[0].CreationDate).ToUniversalTime()
        # Reused PID must have started well AFTER the timestamp in the old lock.
        # If timestamps are missing/ambiguous, fail closed.
        if (($ownerStartUtc - $recordedStart).TotalSeconds -le 30) {
            throw 'Refusing PID recovery: reused PID start time is not safely newer.'
        }
        return [pscustomobject]@{
            Id = [int]$owner[0].ProcessId
            StartedUtcTicks = $ownerStartUtc.Ticks
        }
    }

    $ownerBefore = & $assertInactive
    Start-Sleep -Milliseconds 300
    $ownerAfter = & $assertInactive
    if ($ownerBefore.Id -ne $ownerAfter.Id -or
        $ownerBefore.StartedUtcTicks -ne $ownerAfter.StartedUtcTicks) {
        throw 'Refusing PID recovery: recorded process identity changed.'
    }

    $current = Get-NativePostgresPidFileEvidence -Spec $Spec
    $fileAfter = Get-Item -LiteralPath $pidFile -ErrorAction Stop
    if (-not ($current.Present -and $current.MetadataVerified -and
        $current.Reason -ceq 'pid-reused-by-other-process' -and
        $current.RecordedPid -eq $initial.RecordedPid) -or
        $fileAfter.Length -ne $fileBefore.Length -or
        $fileAfter.LastWriteTimeUtc.Ticks -ne $fileBefore.LastWriteTimeUtc.Ticks -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($pidFile)) -cne $contentsBefore) {
        throw 'Refusing PID recovery: postmaster.pid changed during verification.'
    }

    # Atomic move within the SAME directory, with a unique backup name.
    # Windows will reject the move if the original is held exclusively open.
    $suffix = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '-' +
        [Guid]::NewGuid().ToString('N')
    $archive = Join-Path ([string]$Spec.Data) ('postmaster.pid.stale-' + $suffix + '.bak')
    [IO.File]::Move($pidFile, $archive)
    return $archive
}
