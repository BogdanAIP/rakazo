# Read-only bridge for the existing tunnel-client status.
# Reuses the original CurrentUser DPAPI ciphertext without exporting or re-enrolling secrets.
# Does not install, connect, start, stop or restart any runtime.
Set-StrictMode -Version Latest

function Get-RakazoAuthenticatedTunnelStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$ClientPath,
        [Parameter(Mandatory=$true)][string]$Alias,
        [Parameter(Mandatory=$true)][string]$EncryptedKeyPath
    )
    if ($Alias -cne 'rakazo') { throw 'Unexpected tunnel alias.' }
    if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw 'Existing tunnel client is missing.' }
    if (-not (Test-Path -LiteralPath $EncryptedKeyPath -PathType Leaf)) { throw 'Protected runtime key is missing.' }

    $encrypted = $null
    $plaintext = $null
    $key = $null
    $process = $null
    try {
        # Compatible with the old CryptProtectData/CryptUnprotectData CurrentUser format:
        # no optional entropy; the binary ciphertext is stored as Base64 in the existing file.
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $encoded = [IO.File]::ReadAllText($EncryptedKeyPath).Trim()
        if ([string]::IsNullOrWhiteSpace($encoded) -or $encoded.Length -gt 16384) {
            throw 'Protected runtime key is empty or invalid.'
        }
        $encrypted = [Convert]::FromBase64String($encoded)
        $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $key = [Text.Encoding]::UTF8.GetString($plaintext)
        if ([string]::IsNullOrWhiteSpace($key)) { throw 'Protected runtime key is empty.' }

        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $ClientPath
        $psi.Arguments = 'runtimes status rakazo --json'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.EnvironmentVariables['RAKAZO_TUNNEL_KEY'] = $key
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $psi
        if (-not $process.Start()) { throw 'Cannot query existing tunnel client.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch {}
            throw 'Existing tunnel status query timed out.'
        }
        $raw = $stdoutTask.Result
        # Consume stderr, but never display its potentially sensitive content.
        [void]$stderrTask.Result
        if ($process.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($raw) -or
            $raw.Length -gt 65536) {
            throw 'Existing tunnel status query failed.'
        }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } finally {
        if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
        if ($null -ne $encrypted) { [Array]::Clear($encrypted, 0, $encrypted.Length) }
        $key = $null
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Test-RakazoExistingTunnelHealthEndpoint {
    [CmdletBinding()]
    param([AllowNull()][string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $false }
    # Only probe this user's loopback runtime health URL, never an arbitrary remote URL.
    if ($uri.Scheme -ne 'http' -or -not $uri.IsLoopback -or $uri.UserInfo) { return $false }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $uri.AbsoluteUri -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Test-RakazoExistingTunnelProcessEvidence {
    [CmdletBinding()]
    param(
        $Runtime,
        [Parameter(Mandatory=$true)][string]$ClientPath
    )
    if ($null -eq $Runtime -or $null -eq $Runtime.process) { return $false }
    $record = $Runtime.process
    $recordedPid = 0
    try { $recordedPid = [int]$record.pid } catch { return $false }
    if ($recordedPid -le 0 -or -not $record.started_at) { return $false }
    try {
        $p = Get-Process -Id $recordedPid -ErrorAction Stop
        if (-not $p.Path) { return $false }
        $pathMatches = [string]::Equals(
            [IO.Path]::GetFullPath([string]$p.Path),
            [IO.Path]::GetFullPath($ClientPath),
            [StringComparison]::OrdinalIgnoreCase
        )
        if (-not $pathMatches) { return $false }
        # The existing CLI emits UTC started_at without a timezone suffix on Windows.
        # AssumeUniversal for an unzoned value; preserve any explicit offset if present.
        # Do not widen the 20-second PID/path/start-time ownership tolerance.
        $expected = [DateTimeOffset]::Parse(
            [string]$record.started_at,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal
        )
        $actual = [DateTimeOffset]$p.StartTime
        return [Math]::Abs(($actual - $expected).TotalSeconds) -le 20
    } catch { return $false }
}
