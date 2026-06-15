[CmdletBinding()]
param(
  [string]$InstallerZip,
  [string]$ReleaseDir = (Join-Path $PSScriptRoot "release\windows"),
  [string]$WorkRoot = (Join-Path $PSScriptRoot ".codex-tmp\windows-install-entrypoint"),
  [string]$InstallRoot,
  [string]$DataRoot,
  [switch]$DesktopShortcut,
  [switch]$NoLaunch,
  [switch]$ResetConfig,
  [switch]$SkipDoctor,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:PnpmVersion = "9.12.0"
$script:LogPath = Join-Path $WorkRoot "install.log"

function Write-Info($Message) {
  Write-Host "[BLUE-TANUKI] $Message"
}

function Write-RunbookFailure($Reason) {
  Write-Host ""
  Write-Host "BLUE-TANUKI Windows install did not complete." -ForegroundColor Red
  Write-Host "Reason: $Reason"
  Write-Host "Log: $script:LogPath"
  Write-Host ""
  Write-Host "Recommended:"
  Write-Host "  1. Re-run INSTALL_WINDOWS.cmd from the repository root."
  Write-Host "  2. If the build failed, open the log above and fix the first failed command."
  Write-Host "  3. If you already have the installer zip, extract release/windows/blue-tanuki-*-windows-x64-installer.zip and run BlueTanukiSetup.cmd."
}

function Test-WindowsHost {
  return $env:OS -eq "Windows_NT"
}

function Initialize-Log {
  New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
  Set-Content -LiteralPath $script:LogPath -Value "BLUE-TANUKI Windows install log`nstarted=$((Get-Date).ToString("o"))`n" -Encoding UTF8
}

function Invoke-LoggedCommand($File, [string[]]$Arguments, $Label) {
  $line = "$File $($Arguments -join ' ')"
  Write-Info $Label
  Add-Content -LiteralPath $script:LogPath -Value "`n> $line" -Encoding UTF8
  & $File @Arguments *>&1 | Tee-Object -FilePath $script:LogPath -Append
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }
}

function Find-InstallerZip {
  if ($InstallerZip) {
    $resolved = [System.IO.Path]::GetFullPath($InstallerZip)
    if (-not (Test-Path -LiteralPath $resolved)) {
      throw "Installer zip not found: $resolved"
    }
    return $resolved
  }

  if (-not (Test-Path -LiteralPath $ReleaseDir)) {
    return $null
  }
  $candidate = Get-ChildItem -LiteralPath $ReleaseDir -Filter "blue-tanuki-*-windows-x64-installer.zip" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc, Name -Descending |
    Select-Object -First 1
  if ($candidate) {
    return $candidate.FullName
  }
  return $null
}

function Build-InstallerZip {
  if ($DryRun) {
    Write-Host "would_build_installer=true"
    Write-Host "would_run=corepack enable"
    Write-Host "would_run=corepack prepare pnpm@$script:PnpmVersion --activate"
    Write-Host "would_run=pnpm install --frozen-lockfile"
    Write-Host "would_run=pnpm build"
    Write-Host "would_run=pnpm package:windows"
    Write-Host "would_run=pnpm package:windows:verify"
    Write-Host "would_install_after_build=true"
    Write-Host "root_source_entrypoint_dry_run=pass"
    return $null
  }

  Invoke-LoggedCommand "corepack" @("enable") "Enable Corepack"
  Invoke-LoggedCommand "corepack" @("prepare", "pnpm@$script:PnpmVersion", "--activate") "Activate pnpm $script:PnpmVersion"
  Invoke-LoggedCommand "pnpm" @("install", "--frozen-lockfile") "Install workspace dependencies"
  Invoke-LoggedCommand "pnpm" @("build") "Build workspace"
  Invoke-LoggedCommand "pnpm" @("package:windows") "Build Windows installer package"
  Invoke-LoggedCommand "pnpm" @("package:windows:verify") "Verify Windows installer package"

  $built = Find-InstallerZip
  if (-not $built) {
    throw "package:windows completed, but release/windows/blue-tanuki-*-windows-x64-installer.zip was not found"
  }
  return $built
}

function Get-SetupArguments {
  $args = @()
  if ($InstallRoot) {
    $args += @("-InstallRoot", $InstallRoot)
  }
  if ($DataRoot) {
    $args += @("-DataRoot", $DataRoot)
  }
  if ($DesktopShortcut) {
    $args += "-DesktopShortcut"
  }
  if ($NoLaunch) {
    $args += "-NoLaunch"
  }
  if ($ResetConfig) {
    $args += "-ResetConfig"
  }
  if ($SkipDoctor) {
    $args += "-SkipDoctor"
  }
  return $args
}

function Expand-And-RunInstaller($ZipPath) {
  $extractRoot = Join-Path $WorkRoot "installer"
  $setupArgs = Get-SetupArguments
  if ($DryRun) {
    Write-Host "would_extract=$ZipPath"
    Write-Host "would_run_setup=BlueTanukiSetup.cmd $($setupArgs -join ' ')"
    Write-Host "root_source_entrypoint_dry_run=pass"
    return
  }

  if (-not (Test-WindowsHost)) {
    throw "INSTALL_WINDOWS.cmd must be run on Windows to execute BlueTanukiSetup.cmd"
  }

  Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Write-Info "Extracting installer zip: $ZipPath"
  Add-Content -LiteralPath $script:LogPath -Value "`n> Expand-Archive $ZipPath" -Encoding UTF8
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractRoot -Force

  $setupCmd = Join-Path $extractRoot "BlueTanukiSetup.cmd"
  if (-not (Test-Path -LiteralPath $setupCmd)) {
    throw "Extracted installer is missing BlueTanukiSetup.cmd"
  }
  Invoke-LoggedCommand $setupCmd $setupArgs "Run packaged Windows setup"
}

try {
  Initialize-Log
  Write-Info "Windows install entrypoint"
  Write-Info "Repository root: $PSScriptRoot"
  Write-Info "Log: $script:LogPath"

  $zip = Find-InstallerZip
  if ($zip) {
    Write-Info "Using existing installer zip: $zip"
  } else {
    Write-Info "No installer zip found under $ReleaseDir; building one from source."
    $zip = Build-InstallerZip
  }

  if ($zip) {
    Expand-And-RunInstaller $zip
  }

  if (-not $DryRun) {
    Write-Host ""
    Write-Host "BLUE-TANUKI Windows install entrypoint completed."
  }
} catch {
  $reason = if ($_.Exception) { $_.Exception.Message } else { [string]$_ }
  Write-RunbookFailure $reason
  exit 1
}
