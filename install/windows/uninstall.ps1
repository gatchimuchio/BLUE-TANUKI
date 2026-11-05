[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\BlueTanuki\app",
  [string]$DataRoot = "$env:APPDATA\BlueTanuki",
  [switch]$Purge,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "safe-target.ps1")

function Fail($Message) {
  Write-Error -Message $Message -ErrorAction Continue
  exit 1
}

function Normalize-Path($Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-SafeTarget($Target, $Label) {
  try {
    return Resolve-SafeDirectoryTarget -Path $Target -Label $Label
  } catch {
    Fail $_.Exception.Message
  }
}

function Remove-Target($Target, $Label) {
  $safe = Assert-SafeTarget $Target $Label
  if (-not (Test-Path -LiteralPath $safe)) {
    Write-Host "Skip missing ${Label}: $safe"
    return
  }
  if ($DryRun) {
    Write-Host "Would remove ${Label}: $safe"
    return
  }
  try { Assert-NoReparsePointsInTree -Path $safe -Label $Label } catch {
    Fail "Refusing recursive removal of ${Label}. $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $safe -Recurse -Force
  Write-Host "Removed ${Label}: $safe"
}

function Remove-FileIfPresent($Path, $Label) {
  $safe = Normalize-Path $Path
  if (-not (Test-Path -LiteralPath $safe)) {
    Write-Host "Skip missing ${Label}: $safe"
    return
  }
  if ($DryRun) {
    Write-Host "Would remove ${Label}: $safe"
    return
  }
  $item = Get-Item -Force -LiteralPath $safe
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "Refusing to remove ${Label} because it is not a regular file: $safe"
  }
  Remove-Item -LiteralPath $safe -Force
  Write-Host "Removed ${Label}: $safe"
}

$safeTargets = Assert-SafeInstallTargets -InstallRoot $InstallRoot -DataRoot $DataRoot -SourceRoot $null
$installRootResolved = $safeTargets.InstallRoot
$dataRootResolved = $safeTargets.DataRoot
try {
  [void](Assert-ManagedWindowsDevelopmentInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved -AllowLegacy)
  if ($Purge) {
    [void](Assert-ManagedWindowsDevelopmentData -DataRoot $dataRootResolved -InstallRoot $installRootResolved)
    Assert-NoReparsePointsInTree -Path $dataRootResolved -Label 'DevelopmentDataRoot'
  } else {
    [void](Assert-ManagedWindowsDevelopmentData -DataRoot $dataRootResolved -InstallRoot $installRootResolved -AllowEmpty)
  }
} catch {
  Fail "Refusing to uninstall because development install ownership and structure could not be verified. No files were removed. $($_.Exception.Message)"
}
$binRoot = Join-Path $dataRootResolved "bin"
$launcher = Join-Path $binRoot "blue-tanuki.ps1"
$cmdLauncher = Join-Path $binRoot "blue-tanuki.cmd"
$residentScript = Join-Path $installRootResolved "install\resident\blue-tanuki-resident.ps1"

if (Test-Path -LiteralPath $residentScript) {
  if ($DryRun) {
    Write-Host "Would stop resident gateway and disable resident autostart."
  }
  else {
    try { [void](Assert-ManagedWindowsDevelopmentInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved -AllowLegacy) } catch {
      Fail "Refusing to run the development resident helper because the installed inventory changed. No files were removed. $($_.Exception.Message)"
    }
    & powershell -ExecutionPolicy Bypass -File $residentScript -Command "resident-stop" -InstallRoot $installRootResolved -EnvFile (Join-Path $dataRootResolved "blue-tanuki.env") -DataRoot $dataRootResolved -Launcher $launcher
    & powershell -ExecutionPolicy Bypass -File $residentScript -Command "resident-autostart-disable" -InstallRoot $installRootResolved -EnvFile (Join-Path $dataRootResolved "blue-tanuki.env") -DataRoot $dataRootResolved -Launcher $launcher
  }
}

try { [void](Assert-ManagedWindowsDevelopmentInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved -AllowLegacy) } catch {
  Fail "Refusing to remove the development app because its installed inventory changed. No files were removed. $($_.Exception.Message)"
}
Remove-Target $installRootResolved "app"

if ($Purge) {
  Remove-Target $dataRootResolved "data root"
  Write-Host "BLUE-TANUKI uninstalled with data purge."
}
else {
  [void](Assert-ManagedWindowsDevelopmentData -DataRoot $dataRootResolved -InstallRoot $installRootResolved -AllowEmpty)
  Remove-FileIfPresent $launcher "PowerShell launcher"
  Remove-FileIfPresent $cmdLauncher "cmd launcher"
  Remove-FileIfPresent (Join-Path $dataRootResolved "blue-tanuki-development-data.json") "development launcher ownership marker"
  if ((Test-Path -LiteralPath $binRoot) -and -not $Purge) {
    $remaining = @(Get-ChildItem -Force -LiteralPath $binRoot -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Remove-Target $binRoot "empty bin directory"
    }
  }
  Write-Host "BLUE-TANUKI app removed. Data retained at: $dataRootResolved"
  Write-Host "Re-run with -Purge to remove env, audit, session, and local data."
}
