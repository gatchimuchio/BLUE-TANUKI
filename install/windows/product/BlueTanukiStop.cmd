@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0BlueTanukiLauncher.ps1" stop %*
