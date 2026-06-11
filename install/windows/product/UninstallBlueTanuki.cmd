@echo off
setlocal EnableDelayedExpansion
set "BT_UNINSTALL_ROOT=%~dp0."
set "BT_UNINSTALL_SOURCE=%~dp0BlueTanukiUninstall.ps1"
set "BT_UNINSTALL_TEMP=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.ps1"
set "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT=%BT_UNINSTALL_ROOT%"
set "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT=%BT_UNINSTALL_TEMP%"
set "BLUE_TANUKI_UNINSTALL_PRESERVE_WRAPPER=1"
set "BLUE_TANUKI_UNINSTALL_WRAPPER_PATH=%~f0"
copy /Y "%BT_UNINSTALL_SOURCE%" "%BT_UNINSTALL_TEMP%" >nul
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage uninstall script.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
cd /d "%TEMP%" >nul 2>nul
if errorlevel 1 cd /d "%USERPROFILE%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BT_UNINSTALL_TEMP%" %*
set "BT_UNINSTALL_EXIT=%ERRORLEVEL%"
del "%BT_UNINSTALL_TEMP%" >nul 2>nul
if not "%BT_UNINSTALL_EXIT%"=="0" (
  echo.
  echo BLUE-TANUKI uninstall failed. Review the output above.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b %BT_UNINSTALL_EXIT%
)
del "%~f0" >nul 2>nul & rd "%BT_UNINSTALL_ROOT%" >nul 2>nul & exit /b !ERRORLEVEL!
