@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BlueTanukiSetup.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI setup failed. Review the output above.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
