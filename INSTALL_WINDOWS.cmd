@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL_WINDOWS.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI Windows installer entrypoint failed. Review the guidance above.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
