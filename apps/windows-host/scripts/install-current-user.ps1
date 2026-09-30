param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$Origin,
  [string]$PairingToken = "",
  [string]$OpenCliProfile = "",
  [string]$OpenCliEntry = "",
  [switch]$EnableProcess,
  [switch]$EnableFileWrite,
  [switch]$EnableGui,
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "This installer must run in an interactive Windows user session."
}

if (-not $RepoRoot) {
  $RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
}
if (-not (Test-Path (Join-Path $RepoRoot "pnpm-workspace.yaml"))) {
  throw "RepoRoot does not point to a Rakazo checkout: $RepoRoot"
}

$pnpmCommand = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
  $pnpmCommand = Get-Command "pnpm" -ErrorAction SilentlyContinue
}
if (-not $pnpmCommand) {
  throw "pnpm is required. Install the repository's documented Node/pnpm toolchain first."
}

$stateDir = if ($env:RAKAZO_WINDOWS_HOST_STATE_DIR) {
  $env:RAKAZO_WINDOWS_HOST_STATE_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Rakazo\windows-host"
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$credentialFile = Join-Path $stateDir "host-credential.dpapi"

function Set-ScopedEnvironment {
  param([hashtable]$Values)
  $previous = @{}
  foreach ($entry in $Values.GetEnumerator()) {
    $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
  }
  return $previous
}

function Restore-ScopedEnvironment {
  param([hashtable]$Previous)
  foreach ($entry in $Previous.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
  }
}

Push-Location $RepoRoot
try {
  & $pnpmCommand.Source install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed"
  }

  if ($PairingToken) {
    $pairEnvironment = @{
      RAKAZO_WINDOWS_HOST_ORIGIN = $Origin
      RAKAZO_WINDOWS_HOST_STATE_DIR = $stateDir
      RAKAZO_WINDOWS_HOST_PAIRING_TOKEN = $PairingToken
      RAKAZO_WINDOWS_PROCESS_ENABLED = "false"
      RAKAZO_WINDOWS_FILE_WRITE_ENABLED = "false"
      RAKAZO_WINDOWS_GUI_ENABLED = "false"
      RAKAZO_OPENCLI_PROFILE = ""
    }
    $previous = Set-ScopedEnvironment $pairEnvironment
    $pairProcess = $null
    try {
      $pairProcess = Start-Process -FilePath $pnpmCommand.Source -ArgumentList @("--filter", "@rakazo/windows-host", "start") -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru

      $deadline = [DateTime]::UtcNow.AddSeconds(45)
      while (-not (Test-Path $credentialFile)) {
        if ($pairProcess.HasExited) {
          throw "Windows Host exited before storing its paired DPAPI credential."
        }
        if ([DateTime]::UtcNow -ge $deadline) {
          throw "Timed out waiting for Windows Host pairing."
        }
        Start-Sleep -Milliseconds 500
      }
    }
    finally {
      if ($pairProcess -and -not $pairProcess.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $pairProcess.Id /T /F 2>$null | Out-Null
        try { $pairProcess.WaitForExit(5000) | Out-Null } catch {}
      }
      Restore-ScopedEnvironment $previous
    }
  }

  if (-not (Test-Path $credentialFile)) {
    throw "No DPAPI host credential exists. Pass a fresh -PairingToken for the first installation."
  }

  $launcher = Join-Path $stateDir "start-current-user.ps1"
  $escapedRepo = $RepoRoot.Replace("'", "''")
  $escapedOrigin = $Origin.Replace("'", "''")
  $escapedState = $stateDir.Replace("'", "''")
  $escapedProfile = $OpenCliProfile.Replace("'", "''")
  $escapedEntry = $OpenCliEntry.Replace("'", "''")
  $pnpmPath = $pnpmCommand.Source.Replace("'", "''")

  $launcherTemplate = @'
$ErrorActionPreference = 'Stop'
$env:RAKAZO_WINDOWS_HOST_ORIGIN = '{0}'
$env:RAKAZO_WINDOWS_HOST_STATE_DIR = '{1}'
$env:RAKAZO_WINDOWS_PROCESS_ENABLED = '{2}'
$env:RAKAZO_WINDOWS_FILE_WRITE_ENABLED = '{3}'
$env:RAKAZO_WINDOWS_GUI_ENABLED = '{4}'
$env:RAKAZO_OPENCLI_PROFILE = '{5}'
$env:RAKAZO_OPENCLI_ENTRY = '{6}'
Set-Location '{7}'
& '{8}' --filter '@rakazo/windows-host' start
exit $LASTEXITCODE
'@
  $launcherContent = $launcherTemplate -f @(
    $escapedOrigin,
    $escapedState,
    $EnableProcess.IsPresent.ToString().ToLowerInvariant(),
    $EnableFileWrite.IsPresent.ToString().ToLowerInvariant(),
    $EnableGui.IsPresent.ToString().ToLowerInvariant(),
    $escapedProfile,
    $escapedEntry,
    $escapedRepo,
    $pnpmPath
  )
  [System.IO.File]::WriteAllText($launcher, $launcherContent, [System.Text.UTF8Encoding]::new($false))

  $taskName = "Rakazo Windows Host"
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '"'
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 2

  $task = Get-ScheduledTask -TaskName $taskName
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  [pscustomobject]@{
    task = $task.TaskName
    state = [string]$task.State
    lastTaskResult = $info.LastTaskResult
    stateDir = $stateDir
    credentialProtectedByDpapi = $true
    processEnabled = $EnableProcess.IsPresent
    fileWriteEnabled = $EnableFileWrite.IsPresent
    guiEnabled = $EnableGui.IsPresent
    openCliProfile = $OpenCliProfile
  } | ConvertTo-Json -Compress
}
finally {
  Pop-Location
}
