@echo off
setlocal
set "BT_UNINSTALL_ROOT=%~dp0."
set "BT_UNINSTALL_SOURCE=%~dp0BlueTanukiUninstall.ps1"
set "BT_UNINSTALL_TEMP=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.ps1"
set "BT_UNINSTALL_HELPER_SOURCE=%~dp0install\windows\safe-target.ps1"
set "BT_UNINSTALL_HELPER_TEMP=%TEMP%\BlueTanukiSafeTarget-%RANDOM%-%RANDOM%.ps1"
if "%BLUE_TANUKI_UNINSTALL_STATUS_FILE%"=="" set "BLUE_TANUKI_UNINSTALL_STATUS_FILE=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.status"
set "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT=%BT_UNINSTALL_ROOT%"
set "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT=%BT_UNINSTALL_TEMP%"
set "BLUE_TANUKI_UNINSTALL_TEMP_HELPER=%BT_UNINSTALL_HELPER_TEMP%"
set "BLUE_TANUKI_UNINSTALL_SAFE_TARGET=%BT_UNINSTALL_HELPER_TEMP%"
if not exist "%BT_UNINSTALL_HELPER_SOURCE%" (
  echo.
  echo BLUE-TANUKI uninstall failed. Shared target safety guard is missing.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
copy /Y "%BT_UNINSTALL_HELPER_SOURCE%" "%BT_UNINSTALL_HELPER_TEMP%" >nul
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage shared target safety guard.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
copy /Y "%BT_UNINSTALL_SOURCE%" "%BT_UNINSTALL_TEMP%" >nul
if errorlevel 1 (
  del /Q "%BT_UNINSTALL_HELPER_TEMP%" >nul 2>nul
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage uninstall script.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
powershell.exe -NoProfile -File "%BT_UNINSTALL_TEMP%" %*
set "BT_CODE=%ERRORLEVEL%"
if not "%BT_CODE%"=="0" goto uninstall_failed
if not exist "%BLUE_TANUKI_UNINSTALL_STATUS_FILE%" goto uninstall_unknown
findstr /x /c:"exit_code=0" "%BLUE_TANUKI_UNINSTALL_STATUS_FILE%" >nul
if errorlevel 1 goto uninstall_failed
echo BLUE-TANUKI uninstall completed.
echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE%
del /Q "%BT_UNINSTALL_TEMP%" "%BT_UNINSTALL_HELPER_TEMP%" >nul 2>nul
exit /b 0

:uninstall_failed
if "%BT_CODE%"=="0" set "BT_CODE=1"
echo.
echo BLUE-TANUKI uninstall did not complete successfully. Check the output and status file before retrying.
echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE%
del /Q "%BT_UNINSTALL_TEMP%" "%BT_UNINSTALL_HELPER_TEMP%" >nul 2>nul
if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
exit /b %BT_CODE%

:uninstall_unknown
set "BT_CODE=1"
echo.
echo BLUE-TANUKI uninstall returned without a successful completion record. Treat the result as unknown and inspect before retrying.
echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE%
del /Q "%BT_UNINSTALL_TEMP%" "%BT_UNINSTALL_HELPER_TEMP%" >nul 2>nul
if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
exit /b 1
