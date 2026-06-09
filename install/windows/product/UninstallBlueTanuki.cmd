@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BlueTanukiUninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Review the output above.
  pause
)
