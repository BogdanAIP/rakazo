# One manually clicked desktop shortcut. No logon task, Run key, service or Startup entry.
# The GUI wscript.exe entry prevents Windows Terminal from opening a console for Rakazo.
[CmdletBinding()]
param([switch]$Install)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scriptPath = Join-Path $PSScriptRoot 'Rakazo.ps1'
$guiLauncher = Join-Path $PSScriptRoot 'Launch-Rakazo.vbs'
$iconPath = Join-Path $repo 'apps\desktop\assets\icon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Rakazo.lnk'
$legacyTarget = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$legacyArgs = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Action Run'
$guiTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
$guiArgs = '"' + $guiLauncher + '"'
foreach ($needed in @($scriptPath, $guiLauncher, $iconPath, $legacyTarget, $guiTarget)) {
    if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) {
        throw 'The manual Rakazo application or its Windows GUI launcher is missing.'
    }
}
$shell = New-Object -ComObject WScript.Shell
try {
    $oldCanonical = $false
    if (Test-Path -LiteralPath $shortcut) {
        $existing = $shell.CreateShortcut($shortcut)
        $newCanonical = [string]::Equals($existing.TargetPath, $guiTarget, [StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($existing.Arguments, $guiArgs, [StringComparison]::Ordinal)
        if ($newCanonical) {
            Write-Host 'Canonical console-free manual Rakazo shortcut already exists.'
            return
        }
        # Upgrade only the exact legacy shortcut created by our previous installer.
        # Never overwrite an unrelated shortcut that happens to share the same name.
        $oldCanonical = [string]::Equals($existing.TargetPath, $legacyTarget, [StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($existing.Arguments, $legacyArgs, [StringComparison]::Ordinal)
        if (-not $oldCanonical) {
            throw 'Rakazo.lnk already exists but is not our canonical shortcut. It was not overwritten.'
        }
    }
    if (-not $Install) {
        if ($oldCanonical) {
            Write-Host 'PREVIEW ONLY: canonical manual shortcut can be upgraded to console-free launch.'
        } else {
            Write-Host 'PREVIEW ONLY: one console-free manual Rakazo shortcut can be installed.'
        }
        return
    }
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $guiTarget
    $link.Arguments = $guiArgs
    $link.WorkingDirectory = $repo
    $link.IconLocation = $iconPath + ',0'
    $link.Description = 'Manually launch native Rakazo without a terminal window'
    $link.Save()
    if ($oldCanonical) {
        Write-Host 'Existing manual Rakazo shortcut upgraded to console-free GUI entry.'
    } else {
        Write-Host 'One console-free manual Rakazo desktop shortcut created.'
    }
    Write-Host 'Windows autostart was not modified.'
} finally {
    $shell = $null
}
