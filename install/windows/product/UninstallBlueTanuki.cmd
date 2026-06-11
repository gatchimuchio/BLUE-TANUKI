@echo off
setlocal
set "BT_UNINSTALL_ROOT=%~dp0."
set "BT_UNINSTALL_SOURCE=%~dp0BlueTanukiUninstall.ps1"
set "BT_UNINSTALL_TEMP=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.ps1"
if "%BLUE_TANUKI_UNINSTALL_STATUS_FILE%"=="" set "BLUE_TANUKI_UNINSTALL_STATUS_FILE=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.status"
set "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT=%BT_UNINSTALL_ROOT%"
set "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT=%BT_UNINSTALL_TEMP%"
copy /Y "%BT_UNINSTALL_SOURCE%" "%BT_UNINSTALL_TEMP%" >nul
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage uninstall script.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BT_UNINSTALL_TEMP%" %*
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not start staged uninstall script.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
echo BLUE-TANUKI uninstall started.
echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE%
exit /b 0
