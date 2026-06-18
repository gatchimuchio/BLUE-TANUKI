[CmdletBinding()]
param(
  [string]$InstallerZip,
  [string]$ReleaseDir,
  [string]$WorkRoot,
  [string]$InstallRoot,
  [string]$DataRoot,
  [switch]$DesktopShortcut,
  [switch]$NoLaunch,
  [switch]$ResetConfig,
  [switch]$SkipDoctor,
  [switch]$BuildFromSource,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptRoot = if ($PSScriptRoot) {
  $PSScriptRoot
} elseif ($PSCommandPath) {
  Split-Path -Parent $PSCommandPath
} else {
  (Get-Location).Path
}

if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path $ScriptRoot "release\windows"
}

if (-not $WorkRoot) {
  $WorkRoot = Join-Path $ScriptRoot ".codex-tmp\windows-install-entrypoint"
}

$script:PnpmVersion = "9.12.0"
$script:LogPath = Join-Path $WorkRoot "install.log"
$script:GitHubRepository = "gatchimuchio/blue-tanuki"

function Write-Info($Message) {
  Write-Host "[BLUE-TANUKI] $Message"
}

function Write-WrongAssetGuidance($Reason) {
  Write-Host ""
  Write-Host "BLUE-TANUKI Windows install did not complete." -ForegroundColor Red
  Write-Host "Reason: $Reason"
  Write-Host "Log: $script:LogPath"
  Write-Host ""
  Write-Host "missing_installer_artifact=fail"
  Write-Host "wrong_asset=source_zip"
  Write-Host ""
  Write-Host "This is a source tree/source zip, not the Windows one-click installer artifact."
  Write-Host "For normal Windows install, download blue-tanuki-<version>-windows-x64-installer.zip from the release page."
  Write-Host "Developer build only: run INSTALL_WINDOWS.cmd -BuildFromSource."
}

function Write-DeveloperBuildFailure($Reason) {
  Write-Host ""
  Write-Host "BLUE-TANUKI developer Windows source build did not complete." -ForegroundColor Red
  Write-Host "Reason: $Reason"
  Write-Host "Log: $script:LogPath"
  Write-Host ""
  Write-Host "Developer prerequisites:"
  Write-Host "  - pnpm available on PATH; or"
  Write-Host "  - Node.js with Corepack; or"
  Write-Host "  - Node.js with npm so npm exec can run pnpm@$script:PnpmVersion."
  Write-Host ""
  Write-Host "Normal Windows users should not run source builds."
  Write-Host "Download blue-tanuki-<version>-windows-x64-installer.zip, extract it, and run BlueTanukiSetup.cmd."
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

function Test-Command($Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-PackageVersion {
  $packageJson = Join-Path $ScriptRoot "package.json"
  if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "package.json not found under repository root: $ScriptRoot"
  }
  $package = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
  if (-not $package.version) {
    throw "package.json does not declare version"
  }
  return [string]$package.version
}

function Get-ExpectedInstallerFileName {
  $version = Get-PackageVersion
  return "blue-tanuki-$version-windows-x64-installer.zip"
}

function Get-ReleaseDownloadUrls {
  $version = Get-PackageVersion
  $asset = Get-ExpectedInstallerFileName
  $tag = "v$version"
  $base = "https://github.com/$script:GitHubRepository/releases/download/$tag"
  return [pscustomobject]@{
    Installer = "$base/$asset"
    Sha256 = "$base/$asset.sha256"
    Manifest = "$base/$asset.manifest.json"
    FileName = $asset
  }
}

function Read-Sha256Sidecar($ShaFile) {
  if (-not (Test-Path -LiteralPath $ShaFile)) {
    throw "missing sha256 sidecar: $ShaFile"
  }
  $firstToken = ((Get-Content -LiteralPath $ShaFile -Raw).Trim() -split "\s+")[0]
  if (-not ($firstToken -match "^[a-fA-F0-9]{64}$")) {
    throw "invalid sha256 sidecar: $ShaFile"
  }
  return $firstToken.ToLowerInvariant()
}

function Assert-InstallerManifest($ManifestFile, $ZipPath, $ActualSha) {
  if (-not (Test-Path -LiteralPath $ManifestFile)) {
    throw "missing manifest sidecar: $ManifestFile"
  }
  $manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
  if ($manifest.name -ne "blue-tanuki") {
    throw "manifest name must be blue-tanuki"
  }
  if ($manifest.package_type -ne "windows-x64-zip-installer") {
    throw "manifest package_type must be windows-x64-zip-installer"
  }
  if ($manifest.node_runtime.bundled -ne $true) {
    throw "manifest must declare node_runtime.bundled=true"
  }
  if ($manifest.user_experience.requires_node_pnpm_git_from_user -ne $false) {
    throw "manifest must declare user_experience.requires_node_pnpm_git_from_user=false"
  }
  if ($manifest.archive) {
    if ($manifest.archive.file -and $manifest.archive.file -ne (Split-Path -Leaf $ZipPath)) {
      throw "manifest archive.file does not match installer zip"
    }
    if ($manifest.archive.sha256 -and ([string]$manifest.archive.sha256).ToLowerInvariant() -ne $ActualSha) {
      throw "manifest archive.sha256 does not match installer zip"
    }
  }
}

function Assert-InstallerIntegrity($ZipPath) {
  if (-not (Test-Path -LiteralPath $ZipPath)) {
    throw "Installer zip not found: $ZipPath"
  }
  $shaFile = "$ZipPath.sha256"
  $manifestFile = "$ZipPath.manifest.json"
  $expectedSha = Read-Sha256Sidecar $shaFile
  $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    throw "installer zip SHA-256 does not match sidecar: $ZipPath"
  }
  Assert-InstallerManifest $manifestFile $ZipPath $actualSha
  Write-Info "Verified installer artifact SHA-256 and manifest."
  return $actualSha
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

function Invoke-DownloadFile($Url, $Destination, $Label) {
  if ($DryRun) {
    Write-Host "would_download_$Label=$Url"
    return
  }
  Write-Info "Download $Label"
  Add-Content -LiteralPath $script:LogPath -Value "`n> Invoke-WebRequest $Url" -Encoding UTF8
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Download-ReleaseInstallerZip {
  $urls = Get-ReleaseDownloadUrls
  if ($DryRun) {
    Write-Host "missing_installer_artifact=download"
    Write-Host "wrong_asset=source_zip"
    Write-Host "would_download_release_installer=$($urls.Installer)"
    Write-Host "would_download_release_sha256=$($urls.Sha256)"
    Write-Host "would_download_release_manifest=$($urls.Manifest)"
    Write-Host "would_verify_release_installer=true"
    Write-Host "root_source_entrypoint_dry_run=pass"
    return $null
  }

  $downloadDir = Join-Path $WorkRoot "release-download"
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  $zipPath = Join-Path $downloadDir $urls.FileName
  Invoke-DownloadFile $urls.Installer $zipPath "release_installer"
  Invoke-DownloadFile $urls.Sha256 "$zipPath.sha256" "release_sha256"
  Invoke-DownloadFile $urls.Manifest "$zipPath.manifest.json" "release_manifest"
  Assert-InstallerIntegrity $zipPath | Out-Null
  return $zipPath
}

function Resolve-PnpmRunner {
  if (Test-Command "pnpm") {
    return [pscustomobject]@{
      File = "pnpm"
      PrefixArgs = @()
      Source = "pnpm"
    }
  }

  if (Test-Command "corepack") {
    try {
      Write-Info "Trying corepack prepare pnpm@$script:PnpmVersion --activate."
      Invoke-LoggedCommand "corepack" @("prepare", "pnpm@$script:PnpmVersion", "--activate") "Activate pnpm $script:PnpmVersion with Corepack"
      if (Test-Command "pnpm") {
        return [pscustomobject]@{
          File = "pnpm"
          PrefixArgs = @()
          Source = "corepack"
        }
      }
    } catch {
      $message = if ($_.Exception) { $_.Exception.Message } else { [string]$_ }
      Write-Info "Corepack pnpm activation failed; trying npm exec fallback. $message"
    }
  }

  if (Test-Command "npm") {
    return [pscustomobject]@{
      File = "npm"
      PrefixArgs = @("exec", "--yes", "--package", "pnpm@$script:PnpmVersion", "--", "pnpm")
      Source = "npm exec"
    }
  }

  throw "Developer build requires pnpm, Corepack, or npm. Install Node.js 22.14.0+ with npm or install pnpm $script:PnpmVersion."
}

function Invoke-PnpmLogged($Runner, [string[]]$Arguments, $Label) {
  $allArgs = @()
  $allArgs += [string[]]$Runner.PrefixArgs
  $allArgs += $Arguments
  Invoke-LoggedCommand $Runner.File $allArgs $Label
}

function Build-InstallerZip {
  if ($DryRun) {
    Write-Host "developer_build_from_source=true"
    Write-Host "would_resolve_pnpm_runner=true"
    Write-Host "would_run=pnpm install --frozen-lockfile"
    Write-Host "would_run=pnpm build"
    Write-Host "would_run=pnpm package:windows"
    Write-Host "would_run=pnpm package:windows:verify"
    Write-Host "would_install_after_build=true"
    Write-Host "root_source_entrypoint_build_from_source_dry_run=pass"
    Write-Host "root_source_entrypoint_dry_run=pass"
    return $null
  }

  Push-Location $ScriptRoot
  try {
    $pnpm = Resolve-PnpmRunner
    Write-Info "Using $($pnpm.Source) for developer build."
    Invoke-PnpmLogged $pnpm @("install", "--frozen-lockfile") "Install workspace dependencies"
    Invoke-PnpmLogged $pnpm @("build") "Build workspace"
    Invoke-PnpmLogged $pnpm @("package:windows") "Build Windows installer package"
    Invoke-PnpmLogged $pnpm @("package:windows:verify") "Verify Windows installer package"

    $built = Find-InstallerZip
    if (-not $built) {
      throw "package:windows completed, but release/windows/blue-tanuki-*-windows-x64-installer.zip was not found"
    }
    Assert-InstallerIntegrity $built | Out-Null
    return $built
  } finally {
    Pop-Location
  }
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
  Write-Info "Repository root: $ScriptRoot"
  Write-Info "Log: $script:LogPath"

  $zip = Find-InstallerZip
  if ($zip) {
    Write-Info "Using existing installer zip: $zip"
    Assert-InstallerIntegrity $zip | Out-Null
  } elseif ($BuildFromSource) {
    Write-Info "No installer zip found under $ReleaseDir; explicit -BuildFromSource requested."
    $zip = Build-InstallerZip
  } else {
    Write-Info "No installer zip found under $ReleaseDir; attempting verified GitHub Release download."
    $zip = Download-ReleaseInstallerZip
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
  if ($BuildFromSource) {
    Write-DeveloperBuildFailure $reason
  } else {
    Write-WrongAssetGuidance $reason
  }
  exit 1
}
