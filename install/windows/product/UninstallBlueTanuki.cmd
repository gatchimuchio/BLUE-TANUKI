@echo off
setlocal
if /I "%~f0"=="%BLUE_TANUKI_UNINSTALL_WRAPPER_TEMP%" goto :staged-wrapper
set "BLUE_TANUKI_UNINSTALL_WRAPPER_TEMP="
set "BLUE_TANUKI_UNINSTALL_STAGED_ROOT="
set "BLUE_TANUKI_UNINSTALL_STAGED_ROOT=%~dp0."
:stage-wrapper
set "BT_UNINSTALL_WRAPPER_TEMP=%TEMP%\BlueTanukiUninstallWrapper-%RANDOM%-%RANDOM%-%RANDOM%.cmd"
if exist "%BT_UNINSTALL_WRAPPER_TEMP%" goto :wrapper-temp-collision
copy /Y "%~f0" "%BT_UNINSTALL_WRAPPER_TEMP%" >nul
if errorlevel 1 (
  echo.
  echo BLUE-TANUKI uninstall failed. Could not stage uninstall wrapper.
  if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
  exit /b 1
)
set "BLUE_TANUKI_UNINSTALL_WRAPPER_TEMP=%BT_UNINSTALL_WRAPPER_TEMP%"
start "" /wait /b "%BT_UNINSTALL_WRAPPER_TEMP%" %* & call set "BT_UNINSTALL_WRAPPER_EXIT=%%errorlevel%%" & del /Q "%BT_UNINSTALL_WRAPPER_TEMP%" >nul 2>nul & call exit /b %%BT_UNINSTALL_WRAPPER_EXIT%%

:wrapper-temp-collision
goto :stage-wrapper

:staged-wrapper
set "BT_UNINSTALL_ROOT=%BLUE_TANUKI_UNINSTALL_STAGED_ROOT%"
set "BT_UNINSTALL_SOURCE=%BT_UNINSTALL_ROOT%\BlueTanukiUninstall.ps1"
set "BT_UNINSTALL_TEMP=%TEMP%\BlueTanukiUninstall-%RANDOM%-%RANDOM%.ps1"
set "BT_UNINSTALL_HELPER_SOURCE=%BT_UNINSTALL_ROOT%\install\windows\safe-target.ps1"
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
powershell.exe -NoProfile -File "%BT_UNINSTALL_TEMP%" %* && findstr /x /c:"exit_code=0" "%BLUE_TANUKI_UNINSTALL_STATUS_FILE%" >nul && echo BLUE-TANUKI uninstall completed. && echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE% && exit /b 0 || (del /Q "%BT_UNINSTALL_TEMP%" "%BT_UNINSTALL_HELPER_TEMP%" >nul 2>nul & echo. & echo BLUE-TANUKI uninstall did not complete successfully. Check the output and status file before retrying. & echo status_file=%BLUE_TANUKI_UNINSTALL_STATUS_FILE% & if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause & exit /b 1)
