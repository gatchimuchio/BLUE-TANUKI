@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BlueTanukiLauncher.ps1" doctor-open %*
if not "%BLUE_TANUKI_NO_PAUSE%"=="1" pause
