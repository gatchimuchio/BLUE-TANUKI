@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0BlueTanukiLauncher.ps1" doctor-open %*
set "BT_CODE=%ERRORLEVEL%"
if not "%BT_CODE%"=="0" goto doctor_failed
if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
exit /b 0

:doctor_failed
echo BLUE-TANUKI Doctor did not complete. The current PowerShell execution policy was respected.
if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
exit /b %BT_CODE%
