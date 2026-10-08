# One manually clicked desktop shortcut. No logon task, Run key, service or Startup entry.
# The shortcut stays console-free but now shows a small startup-status GUI.
[CmdletBinding()]
param([switch]$Install)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scriptPath = Join-Path $PSScriptRoot 'Rakazo.ps1'
$guiLauncher = Join-Path $PSScriptRoot 'Launch-Rakazo.vbs'
$guiStatus = Join-Path $PSScriptRoot 'Launch-Rakazo-Gui.ps1'
$iconPath = Join-Path $repo 'apps\desktop\assets\icon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Rakazo.lnk'

$legacyTarget = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$guiTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
$guiArgs = '"' + $guiLauncher + '"'

$legacyConsoleArgs = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Action Run'
$interactiveConsoleArgs = '-NoLogo -NoProfile -Sta -NoExit -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Action Run'

$oldCheckout = Join-Path $HOME 'rakazo-upstream-integration'
$oldScriptPath = Join-Path $oldCheckout 'scripts\windows\manual-rakazo\Rakazo.ps1'
$oldGuiLauncher = Join-Path $oldCheckout 'scripts\windows\manual-rakazo\Launch-Rakazo.vbs'
$oldGuiArgs = '"' + $oldGuiLauncher + '"'
$oldConsoleArgs = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $oldScriptPath + '" -Action Run'
$oldInteractiveConsoleArgs = '-NoLogo -NoProfile -Sta -NoExit -ExecutionPolicy Bypass -File "' + $oldScriptPath + '" -Action Run'

foreach ($needed in @($scriptPath, $guiLauncher, $guiStatus, $iconPath, $legacyTarget, $guiTarget)) {
    if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) {
        throw 'The manual Rakazo application or its Windows GUI launcher is missing.'
    }
}

$shell = New-Object -ComObject WScript.Shell
try {
    $migratable = $false
    $migrationKind = ''

    if (Test-Path -LiteralPath $shortcut) {
        $existing = $shell.CreateShortcut($shortcut)

        $newCanonical = [string]::Equals($existing.TargetPath, $guiTarget, [StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($existing.Arguments, $guiArgs, [StringComparison]::Ordinal)
        if ($newCanonical) {
            Write-Host 'Canonical Rakazo shortcut already points at this checkout.'
            return
        }

        $oldGuiCanonical = [string]::Equals($existing.TargetPath, $guiTarget, [StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($existing.Arguments, $oldGuiArgs, [StringComparison]::Ordinal)
        $oldConsoleCanonical = [string]::Equals($existing.TargetPath, $legacyTarget, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]::Equals($existing.Arguments, $legacyConsoleArgs, [StringComparison]::Ordinal) -or
             [string]::Equals($existing.Arguments, $oldConsoleArgs, [StringComparison]::Ordinal))
        $interactiveCanonical = [string]::Equals($existing.TargetPath, $legacyTarget, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]::Equals($existing.Arguments, $interactiveConsoleArgs, [StringComparison]::Ordinal) -or
             [string]::Equals($existing.Arguments, $oldInteractiveConsoleArgs, [StringComparison]::Ordinal))

        if ($oldGuiCanonical) {
            $migratable = $true
            $migrationKind = 'previous-checkout GUI shortcut'
        } elseif ($oldConsoleCanonical) {
            $migratable = $true
            $migrationKind = 'legacy hidden PowerShell shortcut'
        } elseif ($interactiveCanonical) {
            $migratable = $true
            $migrationKind = 'temporary visible-console shortcut'
        } else {
            throw 'Rakazo.lnk already exists but is not a recognized Rakazo shortcut. It was not overwritten.'
        }
    }

    if (-not $Install) {
        if ($migratable) {
            Write-Host ('PREVIEW ONLY: recognized ' + $migrationKind + ' can be upgraded to the startup-status GUI.')
        } else {
            Write-Host 'PREVIEW ONLY: one Rakazo startup-status shortcut can be installed.'
        }
        return
    }

    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $guiTarget
    $link.Arguments = $guiArgs
    $link.WorkingDirectory = $repo
    $link.IconLocation = $iconPath + ',0'
    $link.Description = 'Launch Rakazo with startup status and tray'
    $link.Save()

    if ($migratable) {
        Write-Host ('Existing Rakazo shortcut upgraded from ' + $migrationKind + '.')
    } else {
        Write-Host 'One Rakazo startup-status desktop shortcut created.'
    }
    Write-Host 'Windows autostart was not modified.'
}
finally {
    $shell = $null
}
