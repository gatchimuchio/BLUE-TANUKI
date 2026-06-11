@echo off
setlocal EnableDelayedExpansion
set "BT_UNINSTALL_SOURCE=%~dp0BlueTanukiUninstall.ps1"
set "BT_UNINSTALL_TEMP=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.ps1"
set "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT=%~dp0."
set "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT=%BT_UNINSTALL_TEMP%"
copy /Y "%BT_UNINSTALL_SOURCE%" "%BT_UNINSTALL_TEMP%" >nul
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage uninstall script.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
cd /d "%TEMP%" >nul 2>nul
if errorlevel 1 cd /d "%USERPROFILE%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BT_UNINSTALL_TEMP%" %* & exit /b !ERRORLEVEL!
