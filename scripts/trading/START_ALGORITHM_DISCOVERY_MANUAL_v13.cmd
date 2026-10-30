@echo off
setlocal EnableExtensions
title Algorithm Discovery - Manual Session (Research Only)
set "SOURCE_ROOT=%USERPROFILE%\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures"
set "STUDY=%SOURCE_ROOT%\multiday-v12-20261030"
cd /d "%~dp0\..\.."
echo.
echo ==========================================================
echo Algorithm Discovery - MANUAL, BOUNDED RESEARCH SESSION
echo No continuous monitoring. No orders or PAPER/real trading.
echo Maximum: 5 source records for the CURRENT UTC DAY only.
echo ==========================================================
echo.
where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python is not available on PATH.
  echo Research session NOT started.
  pause
  exit /b 1
)
if not exist "%STUDY%\plan.json" (
  echo ERROR: Frozen multiday research study not found:
  echo "%STUDY%\plan.json"
  pause
  exit /b 1
)
python "scripts\trading\algorithm_manual_runner_v13.py" --study "%STUDY%" run --max-captures 5
set "STATUS=%ERRORLEVEL%"
echo.
if not "%STATUS%"=="0" (
  echo Research session failed. Original source files were not overwritten.
  echo Please preserve console output for investigation.
) else (
  echo Session completed. All activity stopped. You may close this window.
)
echo.
pause
exit /b %STATUS%
