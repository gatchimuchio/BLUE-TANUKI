@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BlueTanukiUninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Review the output above.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
