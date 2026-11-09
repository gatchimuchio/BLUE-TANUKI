@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0BlueTanukiSetup.ps1" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI setup failed. Review the output above.
  echo The existing PowerShell execution policy was respected and was not changed.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
