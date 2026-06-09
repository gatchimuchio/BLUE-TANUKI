@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BlueTanukiSetup.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI setup failed. Review the output above.
  pause
)
