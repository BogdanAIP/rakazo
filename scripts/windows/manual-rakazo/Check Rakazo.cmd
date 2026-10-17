@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Rakazo.ps1" -Action Preflight
echo.
pause
