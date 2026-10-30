[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\BlueTanuki\app",
  [string]$DataRoot = "$env:APPDATA\BlueTanuki",
  [switch]$Force,
  [switch]$ResetConfig,
  [switch]$SkipDoctor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "safe-target.ps1")

function Fail($Message) {
  Write-Error $Message
  exit 1
}

function Get-InstallPathIdentity($Path) {
  $normalized = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($normalized)
  if ($normalized.Length -gt $root.Length) {
    $normalized = $normalized.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  }
  return $normalized
}

function Test-LegacyDevelopmentInstall($TargetRoot) {
  try {
    $defaultInstallRoot = Get-InstallPathIdentity "$env:LOCALAPPDATA\BlueTanuki\app"
    $defaultDataRoot = Get-InstallPathIdentity "$env:APPDATA\BlueTanuki"
    $targetInstallRoot = Get-InstallPathIdentity $TargetRoot
    $targetDataRoot = Get-InstallPathIdentity $dataRootResolved
  } catch {
    return $false
  }

  if (-not [System.String]::Equals($targetInstallRoot, $defaultInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [System.String]::Equals($targetDataRoot, $defaultDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $packagePath = Join-Path $targetInstallRoot "package.json"
  $runtimeEntry = Join-Path $targetInstallRoot "apps\gateway\dist\main.js"
  $installerEntry = Join-Path $targetInstallRoot "install\windows\install.ps1"
  $envPath = Join-Path $targetDataRoot "blue-tanuki.env"
  $launcherPath = Join-Path $targetDataRoot "bin\blue-tanuki.ps1"
  $cmdLauncherPath = Join-Path $targetDataRoot "bin\blue-tanuki.cmd"
  foreach ($path in @($packagePath, $runtimeEntry, $installerEntry, $envPath, $launcherPath, $cmdLauncherPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    try {
      $parentPath = Split-Path -Parent $path
      $resolvedParent = Resolve-SafeDirectoryTarget -Path $parentPath -Label "Legacy development install path"
      if (-not [System.String]::Equals(
        (Get-InstallPathIdentity $resolvedParent),
        (Get-InstallPathIdentity $parentPath),
        [System.StringComparison]::OrdinalIgnoreCase
      )) { return $false }
    } catch {
      return $false
    }
    $item = Get-Item -Force -LiteralPath $path
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  }

  try {
    $manifestItem = Get-Item -Force -LiteralPath $packagePath
    $launcherItem = Get-Item -Force -LiteralPath $launcherPath
    $cmdLauncherItem = Get-Item -Force -LiteralPath $cmdLauncherPath
    if ($manifestItem.Length -gt 65536 -or $launcherItem.Length -gt 65536 -or $cmdLauncherItem.Length -gt 8192) { return $false }
    $manifest = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if ($manifest.name -ne "blue-tanuki-workspace" -or $manifest.private -ne $true) { return $false }
    $launcherContent = Get-Content -LiteralPath $launcherPath -Raw
    $cmdLauncherContent = Get-Content -LiteralPath $cmdLauncherPath -Raw
  } catch {
    return $false
  }

  $expectedBindings = @(
    ('$env:BLUE_TANUKI_ENV_FILE = "' + $envPath + '"'),
    ('Set-Location "' + $targetInstallRoot + '"'),
    ('$residentScript = Join-Path "' + $targetInstallRoot + '" "install\resident\blue-tanuki-resident.ps1"'),
    ('-InstallRoot "' + $targetInstallRoot + '" -EnvFile "' + $envPath + '" -DataRoot "' + $targetDataRoot + '" -Launcher "' + $launcherPath + '"')
  )
  foreach ($binding in $expectedBindings) {
    if ($launcherContent.IndexOf($binding, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  $expectedCommand = 'powershell -ExecutionPolicy Bypass -File "' + $launcherPath + '" %*'
  return $cmdLauncherContent.IndexOf($expectedCommand, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-ReplaceableInstallRoot($TargetRoot) {
  if (-not (Test-Path -LiteralPath $TargetRoot)) { return }
  if (-not $Force) {
    Fail "$TargetRoot already exists. Re-run with -Force to replace the app. Add -ResetConfig only if you also want to regenerate the env file."
  }
  if ($WhatIfPreference) {
    Write-Host "WhatIf preview only: an existing target is replaceable only when its development-install marker matches both current targets or the exact default legacy install signature matches."
    return
  }

  $rootItem = Get-Item -Force -LiteralPath $TargetRoot
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "Refusing to replace an install target that is not a real directory: $TargetRoot"
  }

  $markerPath = Join-Path $TargetRoot "blue-tanuki-development-install.json"
  if (-not (Test-Path -LiteralPath $markerPath)) {
    if (Test-LegacyDevelopmentInstall $TargetRoot) {
      return
    }
    Fail "Refusing to replace $TargetRoot because it is not a recognized BLUE-TANUKI development install. No files were removed."
  }
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker is not a regular file. No files were removed."
  }
  $markerItem = Get-Item -Force -LiteralPath $markerPath
  if (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "Refusing to replace an install target with a redirected ownership marker: $markerPath"
  }

  $marker = $null
  try {
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  } catch {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker is invalid. No files were removed."
  }

  if ($null -eq $marker) {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker is empty. No files were removed."
  }
  $properties = @($marker.PSObject.Properties.Name)
  if ($properties -notcontains "schema_version" -or $properties -notcontains "product_id" -or
      $properties -notcontains "install_root" -or $properties -notcontains "data_root" -or
      $marker.schema_version -ne 1 -or $marker.product_id -ne "blue-tanuki-development-install") {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker is not recognized. No files were removed."
  }

  try {
    $markerInstallRoot = Get-InstallPathIdentity ([string]$marker.install_root)
    $markerDataRoot = Get-InstallPathIdentity ([string]$marker.data_root)
    $targetInstallRoot = Get-InstallPathIdentity $TargetRoot
    $targetDataRoot = Get-InstallPathIdentity $dataRootResolved
  } catch {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker contains invalid paths. No files were removed."
  }
  if (-not [System.String]::Equals($markerInstallRoot, $targetInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [System.String]::Equals($markerDataRoot, $targetDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "Refusing to replace $TargetRoot because its BLUE-TANUKI install marker does not match the current targets. No files were removed."
  }
}

function Write-DevelopmentInstallMarker($TargetRoot) {
  $marker = [ordered]@{
    schema_version = 1
    product_id = "blue-tanuki-development-install"
    install_root = $TargetRoot
    data_root = $dataRootResolved
  }
  $marker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $TargetRoot "blue-tanuki-development-install.json") -Encoding UTF8
}

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "$Name is required. $Hint"
  }
}

function Test-NodeVersion {
  Require-Command "node" "Install Node.js 22.14.0 or newer."
  node -e "const v=process.versions.node.split('.').map(Number); const ok=v[0]>22 || (v[0]===22 && (v[1]>14 || (v[1]===14 && v[2]>=0))); process.exit(ok?0:1)"
  if ($LASTEXITCODE -ne 0) {
    Fail "Node.js 22.14.0 or newer is required."
  }
}

function Invoke-Pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  if (Get-Command "pnpm" -ErrorAction SilentlyContinue) {
    & pnpm @Args
    if ($LASTEXITCODE -ne 0) { Fail "pnpm $Args failed" }
    return
  }
  if (Get-Command "corepack" -ErrorAction SilentlyContinue) {
    & corepack pnpm @Args
    if ($LASTEXITCODE -ne 0) { Fail "corepack pnpm $Args failed" }
    return
  }
  Fail "pnpm or corepack is required."
}

function Copy-App {
  param([string]$SourceRoot, [string]$TargetRoot)
  $safeTargets = Assert-SafeInstallTargets -InstallRoot $TargetRoot -DataRoot $dataRootResolved -SourceRoot $SourceRoot
  $TargetRoot = $safeTargets.InstallRoot
  $SourceRoot = $safeTargets.SourceRoot
  Assert-ReplaceableInstallRoot $TargetRoot
  if (Test-Path -LiteralPath $TargetRoot) {
    Remove-Item -LiteralPath $TargetRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
  Write-DevelopmentInstallMarker $TargetRoot
  $exclude = @("node_modules", ".git", ".codex-tmp", ".blue-tanuki", "blue-tanuki-development-install.json", "release")
  Get-ChildItem -Force -LiteralPath $SourceRoot |
    Where-Object { $exclude -notcontains $_.Name } |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
    }
}

function Invoke-SetupIfNeeded {
  Push-Location $installRootResolved
  try {
    if ((Test-Path -LiteralPath $envFile) -and -not $ResetConfig) {
      Write-Host "Existing env file retained: $envFile"
      return
    }

    $setupArgs = @(
      "apps/gateway/dist/main.js",
      "--setup",
      "--yes",
      "--output",
      $envFile,
      "--base-dir",
      $dataDir,
      "--no-doctor"
    )
    if ((Test-Path -LiteralPath $envFile) -and $ResetConfig) {
      Write-Warning "ResetConfig is enabled. Existing env file will be regenerated: $envFile"
      $setupArgs += "--force"
    }

    & node @setupArgs
    if ($LASTEXITCODE -ne 0) { Fail "setup failed" }
  }
  finally {
    Pop-Location
  }
}

function Invoke-PostInstallDoctor {
  Push-Location $installRootResolved
  try {
    & node apps/gateway/dist/main.js --doctor --env-file $envFile --json
    $doctorCode = $LASTEXITCODE
    if ($doctorCode -eq 2) {
      Fail "post-install doctor found blocking errors."
    }
    if ($doctorCode -ne 0 -and $doctorCode -ne 1) {
      Fail "post-install doctor failed with exit code $doctorCode."
    }
    if ($doctorCode -eq 1) {
      Write-Warning "post-install doctor completed with warnings. Review the JSON output above."
    }
  }
  finally {
    Pop-Location
  }
}

$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$safeTargets = Assert-SafeInstallTargets -InstallRoot $InstallRoot -DataRoot $DataRoot -SourceRoot $sourceRoot
$sourceRoot = $safeTargets.SourceRoot
$installRootResolved = $safeTargets.InstallRoot
$dataRootResolved = $safeTargets.DataRoot
$envFile = Join-Path $dataRootResolved "blue-tanuki.env"
$dataDir = Join-Path $dataRootResolved "data"
$binRoot = Join-Path $dataRootResolved "bin"
$launcher = Join-Path $binRoot "blue-tanuki.ps1"
$cmdLauncher = Join-Path $binRoot "blue-tanuki.cmd"

Assert-ReplaceableInstallRoot $installRootResolved

Write-Host "Install plan:"
Write-Host "  App target: $installRootResolved"
Write-Host "  User data:  $dataRootResolved"
Write-Host "  Force replacement requested: $([bool]$Force)"
if (-not $PSCmdlet.ShouldProcess($installRootResolved, "Install BLUE-TANUKI; replace only a matching marked or narrowly recognized legacy app and preserve user data at $dataRootResolved")) {
  Write-Host "No changes made."
  exit 0
}

Test-NodeVersion
if (Get-Command "corepack" -ErrorAction SilentlyContinue) {
  corepack prepare pnpm@9.12.0 --activate | Out-Null
}

Copy-App -SourceRoot $sourceRoot -TargetRoot $installRootResolved
New-Item -ItemType Directory -Force -Path $dataRootResolved, $binRoot | Out-Null

Push-Location $installRootResolved
try {
  Invoke-Pnpm install --frozen-lockfile
  Invoke-Pnpm build
}
finally {
  Pop-Location
}

Invoke-SetupIfNeeded

if (-not $SkipDoctor) {
  Invoke-PostInstallDoctor
}

@"
param(
  [string]`$Command = "start",
  [Parameter(ValueFromRemainingArguments = `$true)]
  [string[]]`$RemainingArgs
)
`$ErrorActionPreference = "Stop"
`$env:BLUE_TANUKI_ENV_FILE = "$envFile"
Set-Location "$installRootResolved"
`$residentScript = Join-Path "$installRootResolved" "install\resident\blue-tanuki-resident.ps1"
function Invoke-ResidentCommand {
  param([string]`$ResidentCommand)
  & powershell -ExecutionPolicy Bypass -File `$residentScript -Command `$ResidentCommand -InstallRoot "$installRootResolved" -EnvFile "$envFile" -DataRoot "$dataRootResolved" -Launcher "$launcher" @RemainingArgs
  exit `$LASTEXITCODE
}
`$cmd = `$Command.ToLowerInvariant()
switch (`$cmd) {
  "start" {
    & node "apps/gateway/dist/main.js" --serve --env-file "$envFile" @RemainingArgs
    exit `$LASTEXITCODE
  }
  "serve" {
    & node "apps/gateway/dist/main.js" --serve --env-file "$envFile" @RemainingArgs
    exit `$LASTEXITCODE
  }
  "doctor" {
    & node "apps/gateway/dist/main.js" --doctor --env-file "$envFile" @RemainingArgs
    exit `$LASTEXITCODE
  }
  "setup" {
    & node "apps/gateway/dist/main.js" --setup --output "$envFile" --base-dir "$dataDir" --force @RemainingArgs
    exit `$LASTEXITCODE
  }
  "settings" {
    Write-Host "Settings: http://127.0.0.1:8787/settings"
    & node "apps/gateway/dist/main.js" --serve --env-file "$envFile" @RemainingArgs
    exit `$LASTEXITCODE
  }
  "env" {
    Write-Output "$envFile"
    exit 0
  }
  "resident-start" {
    Invoke-ResidentCommand "resident-start"
  }
  "resident-stop" {
    Invoke-ResidentCommand "resident-stop"
  }
  "resident-status" {
    Invoke-ResidentCommand "resident-status"
  }
  "resident-open" {
    Invoke-ResidentCommand "resident-open"
  }
  "resident-logs" {
    Invoke-ResidentCommand "resident-logs"
  }
  "resident-autostart-enable" {
    Invoke-ResidentCommand "resident-autostart-enable"
  }
  "resident-autostart-disable" {
    Invoke-ResidentCommand "resident-autostart-disable"
  }
  "resident-autostart-status" {
    Invoke-ResidentCommand "resident-autostart-status"
  }
  "help" {
    Write-Host "Usage: blue-tanuki.ps1 [start|doctor|setup|settings|env|resident-start|resident-status|resident-stop|resident-open|resident-logs|resident-autostart-enable|resident-autostart-disable|resident-autostart-status|help]"
    Write-Host "  start/settings  Start gateway serve mode. Open /settings after boot."
    Write-Host "  doctor          Check local configuration."
    Write-Host "  setup           Re-run setup against the installed env file."
    Write-Host "  env             Print the env-file path."
    Write-Host "  resident-*      Manage background resident gateway lifecycle and explicit autostart."
    exit 0
  }
  default {
    Write-Error "unknown command: `$Command"
    exit 2
  }
}
"@ | Set-Content -LiteralPath $launcher -Encoding UTF8

@"
@echo off
powershell -ExecutionPolicy Bypass -File "$launcher" %*
"@ | Set-Content -LiteralPath $cmdLauncher -Encoding ASCII

Write-Host ""
Write-Host "BLUE-TANUKI installed."
Write-Host "Launcher: $launcher"
Write-Host "Env file:  $envFile"
Write-Host "Settings:  http://127.0.0.1:8787/settings"
Write-Host "Run:       powershell -ExecutionPolicy Bypass -File `"$launcher`" start"
Write-Host "Doctor:    powershell -ExecutionPolicy Bypass -File `"$launcher`" doctor"
Write-Host "Settings:  powershell -ExecutionPolicy Bypass -File `"$launcher`" settings"
Write-Host "Reset cfg: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Force -ResetConfig"
