# One registered Rakazo runtime only. Never creates an alias or pairing.
# Operations are opt-in; the manual controller uses them only after verified cold-start gates.
Set-StrictMode -Version Latest

function Get-RakazoProtectedRuntimeValue {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Required protected local credential is missing.'
    }
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $encoded = [IO.File]::ReadAllText($Path).Trim()
    if ($encoded.Length -lt 8 -or $encoded.Length -gt 16384) {
        throw 'Protected local credential has an invalid size.'
    }
    $cipher = [Convert]::FromBase64String($encoded)
    $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect(
            $cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $value = [Text.Encoding]::UTF8.GetString($plain)
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Protected local credential is empty.' }
        return $value
    } finally {
        if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
        [Array]::Clear($cipher, 0, $cipher.Length)
    }
}

function Invoke-RakazoRegisteredRuntimeOperation {
    param(
        [Parameter(Mandatory=$true)][ValidateSet('connect', 'stop')][string]$Operation,
        [Parameter(Mandatory=$true)][string]$ClientPath,
        [Parameter(Mandatory=$true)][string]$TunnelId,
        [Parameter(Mandatory=$true)][string]$McpCommand,
        [Parameter(Mandatory=$true)][string]$KeyPath,
        [Parameter(Mandatory=$true)][string]$SessionPath
    )
    if ($TunnelId -cnotmatch '^tunnel_[A-Za-z0-9_-]+$') { throw 'Existing tunnel identity is invalid.' }
    if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw 'Existing client is missing.' }
    if ([string]::IsNullOrWhiteSpace($McpCommand)) { throw 'Existing MCP command is empty.' }
    $mutex = [Threading.Mutex]::new($false, 'Local\RakazoTunnelControl')
    $taken = $false
    $process = $null
    $key = $null
    $session = $null
    try {
        try { $taken = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) }
        catch [Threading.AbandonedMutexException] { $taken = $true }
        if (-not $taken) { throw 'Tunnel control is busy.' }

        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $ClientPath
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        if ($Operation -eq 'connect') {
            $key = Get-RakazoProtectedRuntimeValue -Path $KeyPath
            $session = Get-RakazoProtectedRuntimeValue -Path $SessionPath
            # Only attach to the existing identity. No admin CRUD or new alias.
            $escapedMcp = '"' + $McpCommand.Replace('"', '\"') + '"'
            $psi.Arguments = 'runtimes connect --alias rakazo --tunnel-id ' + $TunnelId +
                ' --runtime-api-key env:RAKAZO_TUNNEL_KEY --mcp-command ' + $escapedMcp + ' --json'
            $psi.EnvironmentVariables['RAKAZO_TUNNEL_KEY'] = $key
            $psi.EnvironmentVariables['RAKAZO_SESSION_TOKEN'] = $session
        } else {
            $psi.Arguments = 'runtimes stop rakazo'
        }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $psi
        if (-not $process.Start()) { throw 'Existing runtime operation could not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timeout = if ($Operation -eq 'connect') { 45000 } else { 20000 }
        if (-not $process.WaitForExit($timeout)) {
            try { $process.Kill() } catch {}
            throw 'Existing runtime operation timed out.'
        }
        # Consume without logging the CLI JSON, profile paths or stderr contents.
        [void]$stdoutTask.Result
        [void]$stderrTask.Result
        if ($process.ExitCode -ne 0) { throw 'Existing runtime operation was rejected.' }
        return $true
    } finally {
        $key = $null
        $session = $null
        if ($null -ne $process) { $process.Dispose() }
        if ($taken) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
