@echo off
rem Manual launch only. Never register Windows startup or a scheduled task.
start "" powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Rakazo.ps1" -Action Run
