# Only a manually clicked desktop shortcut. No logon task, Run key or Startup entry.
[CmdletBinding()]
param([switch]$Install)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scriptPath = Join-Path $PSScriptRoot 'Rakazo.ps1'
$iconPath = Join-Path $repo 'apps\desktop\assets\icon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Rakazo.lnk'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $iconPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $powershell -PathType Leaf)) {
    throw 'The manual native Rakazo application is not installed in the expected checkout.'
}
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Action Run'
$shell = New-Object -ComObject WScript.Shell
try {
    if (Test-Path -LiteralPath $shortcut) {
        $existing = $shell.CreateShortcut($shortcut)
        if (-not [string]::Equals($existing.TargetPath, $powershell, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($existing.Arguments, $arguments, [StringComparison]::Ordinal)) {
            throw 'Rakazo.lnk already exists and points somewhere else. It was not overwritten.'
        }
        Write-Host 'Canonical manual Rakazo shortcut already exists.'
        return
    }
    if (-not $Install) {
        Write-Host 'PREVIEW ONLY: a manual Rakazo desktop shortcut can be installed after physical handoff.'
        return
    }
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $powershell
    $link.Arguments = $arguments
    $link.WorkingDirectory = $repo
    $link.IconLocation = $iconPath + ',0'
    $link.Description = 'Manually start the native Rakazo application and its existing R connection'
    $link.Save()
    Write-Host 'One manual desktop shortcut created. Windows autostart was not modified.'
} finally {
    $shell = $null
}
