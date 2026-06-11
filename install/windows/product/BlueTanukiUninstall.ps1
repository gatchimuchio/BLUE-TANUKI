[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$DataRoot = "",
  [switch]$PurgeData,
  [switch]$Quiet,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-Path($Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Fail($Message) {
  Write-Error $Message
  exit 1
}

function Assert-SafeTarget($Target, $Label) {
  $normalized = Normalize-Path $Target
  $root = [System.IO.Path]::GetPathRoot($normalized)
  $trimmed = $normalized.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $rootTrimmed = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $denied = @(
    (Normalize-Path $env:USERPROFILE),
    (Normalize-Path $env:LOCALAPPDATA),
    (Normalize-Path $env:APPDATA),
    (Normalize-Path (Join-Path $env:LOCALAPPDATA "Programs"))
  )
  if ($trimmed -eq $rootTrimmed) {
    Fail "$Label points to a filesystem root: $normalized"
  }
  foreach ($path in $denied) {
    $deniedTrimmed = $path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($trimmed -eq $deniedTrimmed) {
      Fail "$Label points to a broad user directory: $normalized"
    }
  }
  return $normalized
}

function Remove-Target($Target, $Label) {
  if (-not (Test-Path -LiteralPath $Target)) {
    if (-not $Quiet) { Write-Host "Skip missing ${Label}: $Target" }
    return
  }
  if ($DryRun) {
    Write-Host "Would remove ${Label}: $Target"
    return
  }
  Remove-Item -LiteralPath $Target -Recurse -Force
  if (-not $Quiet) { Write-Host "Removed ${Label}: $Target" }
}

function Remove-Shortcut($Path) {
  if (Test-Path -LiteralPath $Path) {
    if ($DryRun) {
      Write-Host "Would remove shortcut: $Path"
    } else {
      Remove-Item -LiteralPath $Path -Force
    }
  }
}

function Resolve-DataRoot($InstallRootResolved, $DataRootArg) {
  if ($DataRootArg) {
    return $DataRootArg
  }
  $metadataPath = Join-Path $InstallRootResolved "blue-tanuki-install.json"
  if (Test-Path -LiteralPath $metadataPath) {
    try {
      $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
      if ($metadata.PSObject.Properties.Name -contains "data_root") {
        $value = [string]$metadata.data_root
        if ($value) {
          return $value
        }
      }
    } catch {
      if (-not $Quiet) { Write-Warning "install metadata could not be read; falling back to default data root: $($_.Exception.Message)" }
    }
  }
  return "$env:APPDATA\BlueTanuki"
}

$installRootInput = if ($InstallRoot) { $InstallRoot } else { Split-Path -Parent $PSCommandPath }
$installRootResolved = Assert-SafeTarget $installRootInput "InstallRoot"
$dataRootResolved = Assert-SafeTarget (Resolve-DataRoot $installRootResolved $DataRoot) "DataRoot"
$launcher = Join-Path $installRootResolved "BlueTanukiLauncher.ps1"

if (Test-Path -LiteralPath $launcher) {
  if ($DryRun) {
    Write-Host "Would stop resident runtime."
  } else {
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher stop | Out-Null
    } catch {
      if (-not $Quiet) { Write-Warning "resident stop failed during uninstall: $($_.Exception.Message)" }
    }
  }
}

$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI"
Remove-Shortcut (Join-Path ([Environment]::GetFolderPath("Desktop")) "BLUE-TANUKI.lnk")
Remove-Target $programs "Start Menu shortcuts"

$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki"
if ($DryRun) {
  Write-Host "Would remove uninstall registry key: $key"
} else {
  Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
}

Remove-Target $installRootResolved "installed app"

if ($PurgeData) {
  Remove-Target $dataRootResolved "user data"
  if (-not $Quiet) { Write-Host "BLUE-TANUKI uninstalled with data purge." }
} else {
  if (-not $Quiet) {
    Write-Host "BLUE-TANUKI app removed. User data retained at: $dataRootResolved"
    Write-Host "Run UninstallBlueTanuki.cmd -PurgeData to remove env, logs, audit, session, and local data."
  }
}
