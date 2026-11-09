[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\BlueTanuki",
  [string]$DataRoot = "$env:APPDATA\BlueTanuki",
  [switch]$DesktopShortcut,
  [switch]$NoLaunch,
  [switch]$ResetConfig,
  [switch]$SkipDoctor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail($Message) {
  Write-Host ""
  Write-Host "BLUE-TANUKI setup failed." -ForegroundColor Red
  Write-Host $Message
  throw [System.InvalidOperationException]::new([string]$Message)
}

function Fail-SourceTreeSetup($MissingEntries) {
  Write-Host ""
  Write-Host "This setup script must be run from the packaged Windows installer zip."
  Write-Host "You appear to be running it from the source tree or an incomplete package."
  Write-Host ""
  if ($MissingEntries.Count -gt 0) {
    Write-Host "Missing packaged installer entries:"
    foreach ($entry in $MissingEntries) {
      Write-Host "  - $entry"
    }
    Write-Host ""
  }
  Write-Host "Recommended:"
  Write-Host "  Download blue-tanuki-<version>-windows-x64-installer.zip, extract it, and run BlueTanukiSetup.cmd."
  Write-Host ""
  Write-Host "If you are in a source tree/source zip, root INSTALL_WINDOWS.cmd will use a verified packaged installer when available."
  Write-Host "If no packaged installer is available, it fails closed with wrong-asset guidance."
  Write-Host ""
  Write-Host "Developer build only:"
  Write-Host "  INSTALL_WINDOWS.cmd -BuildFromSource"
  Write-Host ""
  Write-Host "Then extract:"
  Write-Host "  release/windows/blue-tanuki-*-windows-x64-installer.zip"
  Write-Host ""
  Write-Host "and run:"
  Write-Host "  BlueTanukiSetup.cmd"
  exit 1
}

function Assert-PackagedInstallerRoot($PackageRoot) {
  $requiredEntries = @(
    "app",
    "runtime",
    "launcher",
    "windows-installer-manifest.json",
    "app\install\windows\safe-target.ps1"
  )
  $missing = @()
  foreach ($entry in $requiredEntries) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $entry))) {
      $missing += $entry
    }
  }
  if ($missing.Count -gt 0) {
    Fail-SourceTreeSetup $missing
  }
  foreach ($directory in @('app', 'runtime', 'launcher')) {
    $item = Get-Item -Force -LiteralPath (Join-Path $PackageRoot $directory)
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "Packaged installer entry is not a real directory: $directory"
    }
  }
}

function Normalize-Path($Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Find-NodeExe($Root) {
  $runtimeRoot = Join-Path $Root "runtime"
  $node = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $node) {
    Fail "bundled node.exe was not found under $runtimeRoot"
  }
  return $node.FullName
}

function Stop-ExistingResident($Root) {
  $launcher = Join-Path $Root "BlueTanukiLauncher.ps1"
  if (Test-Path -LiteralPath $launcher) {
    $stopExitCode = $null
    $stopFailure = $null
    try {
      & powershell.exe -NoProfile -File $launcher stop | Out-Null
      $stopExitCode = $LASTEXITCODE
    } catch {
      $stopFailure = $_.Exception.Message
    }
    if ($stopFailure -or $stopExitCode -ne 0) {
      $reason = if ($stopFailure) { $stopFailure } else { "launcher stop returned exit code $stopExitCode" }
      Fail "Refusing to continue setup because resident shutdown was not confirmed. No update swap or configuration reset was started. $reason"
    }
  }
}

function Copy-DirectoryContents($Source, $Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    Fail "Packaged installer content is incomplete. Missing directory: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -Force -LiteralPath $Source | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Expand-BundledNode($PackageRoot, $InstallRootResolved) {
  $runtimePackageRoot = Join-Path $PackageRoot "runtime"
  $nodeZip = Get-ChildItem -LiteralPath $runtimePackageRoot -Filter "node-v*-win-x64.zip" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $nodeZip) {
    Fail "bundled Windows Node runtime zip not found under $runtimePackageRoot"
  }
  $runtimeInstallRoot = Join-Path $InstallRootResolved "runtime"
  New-Item -ItemType Directory -Force -Path $runtimeInstallRoot | Out-Null
  Expand-Archive -LiteralPath $nodeZip.FullName -DestinationPath $runtimeInstallRoot -Force
}

function Invoke-BundledSetup($NodeExe, $InstallRootResolved, $EnvFile, $DataDir) {
  if ((Test-Path -LiteralPath $EnvFile) -and -not $ResetConfig) {
    Write-Host "Existing env file retained: $EnvFile"
    return
  }
  $args = @(
    "apps/gateway/dist/main.js",
    "--setup",
    "--yes",
    "--output",
    $EnvFile,
    "--base-dir",
    $DataDir,
    "--no-doctor"
  )
  if ((Test-Path -LiteralPath $EnvFile) -and $ResetConfig) {
    Write-Warning "ResetConfig is enabled. Existing env file will be regenerated: $EnvFile"
    $args += "--force"
  }
  Push-Location $InstallRootResolved
  try {
    & $NodeExe @args
    if ($LASTEXITCODE -ne 0) {
      Fail "first-run setup failed"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-PostInstallDoctor($NodeExe, $InstallRootResolved, $EnvFile, $LogDir) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $doctorLog = Join-Path $LogDir "post-install-doctor.json"
  Push-Location $InstallRootResolved
  try {
    & $NodeExe "apps/gateway/dist/main.js" "--doctor" "--env-file" $EnvFile "--json" *> $doctorLog
    $doctorCode = $LASTEXITCODE
    if ($doctorCode -eq 2) {
      Fail "post-install doctor found blocking errors. Log: $doctorLog"
    }
    if ($doctorCode -ne 0 -and $doctorCode -ne 1) {
      Fail "post-install doctor failed with exit code $doctorCode. Log: $doctorLog"
    }
    if ($doctorCode -eq 1) {
      Write-Warning "post-install doctor completed with warnings. Log: $doctorLog"
    } else {
      Write-Host "post-install doctor passed. Log: $doctorLog"
    }
  } finally {
    Pop-Location
  }
}

function New-Shortcut($Path, $TargetPath, $Arguments, $WorkingDirectory, $Description, $IconLocation) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  if ($IconLocation) {
    $shortcut.IconLocation = $IconLocation
  }
  $shortcut.Save()
}

function Install-Shortcuts($InstallRootResolved, $DesktopShortcutEnabled) {
  Assert-ShortcutTargetsCompatible $InstallRootResolved $DesktopShortcutEnabled
  $programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI"
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $launcher = Join-Path $InstallRootResolved "BlueTanukiLauncher.ps1"
  $uninstaller = Join-Path $InstallRootResolved "UninstallBlueTanuki.cmd"
  $icon = "$(Find-NodeExe $InstallRootResolved),0"
  New-Shortcut (Join-Path $programs "BLUE-TANUKI.lnk") $ps "-NoProfile -WindowStyle Hidden -File `"$launcher`" open" $InstallRootResolved "Open BLUE-TANUKI Control Center" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Doctor.lnk") $ps "-NoProfile -File `"$launcher`" doctor-open" $InstallRootResolved "Run BLUE-TANUKI Doctor" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Logs.lnk") $ps "-NoProfile -File `"$launcher`" logs" $InstallRootResolved "Open BLUE-TANUKI logs" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Safe Mode.lnk") $ps "-NoProfile -File `"$launcher`" safe-mode" $InstallRootResolved "Start BLUE-TANUKI with external providers and connectors disabled" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Stop.lnk") $ps "-NoProfile -File `"$launcher`" stop" $InstallRootResolved "Stop BLUE-TANUKI resident runtime" $icon
  New-Shortcut (Join-Path $programs "Uninstall BLUE-TANUKI.lnk") $uninstaller "" $InstallRootResolved "Uninstall BLUE-TANUKI" $icon
  if ($DesktopShortcutEnabled) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    New-Shortcut (Join-Path $desktop "BLUE-TANUKI.lnk") $ps "-NoProfile -WindowStyle Hidden -File `"$launcher`" open" $InstallRootResolved "Open BLUE-TANUKI Control Center" $icon
  }
}

function Test-ShortcutTargetBelongsToInstall($Path, $InstallRootResolved) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -Force -LiteralPath $Path
  if ($item.Extension -ne '.lnk' -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $launcher = Get-InstallPathIdentity (Join-Path $InstallRootResolved 'BlueTanukiLauncher.ps1')
    $uninstaller = Get-InstallPathIdentity (Join-Path $InstallRootResolved 'UninstallBlueTanuki.cmd')
    $target = if ($shortcut.TargetPath) { Get-InstallPathIdentity $shortcut.TargetPath } else { '' }
    if ([string]::Equals($target, $launcher, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($target, $uninstaller, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return ([string]$shortcut.Arguments).IndexOf($launcher, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch {
    return $false
  }
}

function Assert-ShortcutTargetsCompatible($InstallRootResolved, $DesktopShortcutEnabled) {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI'
  if (Test-Path -LiteralPath $programs) {
    $folder = Get-Item -Force -LiteralPath $programs
    if (-not $folder.PSIsContainer -or ($folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "Start Menu target is not a regular directory: $programs"
    }
    foreach ($name in @('BLUE-TANUKI.lnk','BLUE-TANUKI Doctor.lnk','BLUE-TANUKI Logs.lnk','BLUE-TANUKI Safe Mode.lnk','BLUE-TANUKI Stop.lnk','Uninstall BLUE-TANUKI.lnk')) {
      $path = Join-Path $programs $name
      if ((Test-Path -LiteralPath $path) -and -not (Test-ShortcutTargetBelongsToInstall $path $InstallRootResolved)) {
        Fail "Refusing to replace an unrelated Start Menu item: $path"
      }
    }
  }
  if ($DesktopShortcutEnabled) {
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'BLUE-TANUKI.lnk'
    if ((Test-Path -LiteralPath $desktopShortcut) -and -not (Test-ShortcutTargetBelongsToInstall $desktopShortcut $InstallRootResolved)) {
      Fail "Refusing to replace an unrelated desktop item: $desktopShortcut"
    }
  }
}

function Register-Uninstaller($InstallRootResolved, $DataRootResolved, $Version) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki"
  $uninstallCmd = Join-Path $InstallRootResolved "UninstallBlueTanuki.cmd"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "DisplayName" -Value "BLUE-TANUKI"
  Set-ItemProperty -Path $key -Name "DisplayVersion" -Value $Version
  Set-ItemProperty -Path $key -Name "Publisher" -Value "BLUE-TANUKI"
  Set-ItemProperty -Path $key -Name "InstallLocation" -Value $InstallRootResolved
  Set-ItemProperty -Path $key -Name "UninstallString" -Value "`"$uninstallCmd`""
  Set-ItemProperty -Path $key -Name "QuietUninstallString" -Value "`"$uninstallCmd`" -Quiet"
  Set-ItemProperty -Path $key -Name "URLInfoAbout" -Value "https://github.com/gatchimuchio/BLUE-TANUKI"
  New-ItemProperty -Path $key -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name "BlueTanukiDataRoot" -Value $DataRootResolved -PropertyType String -Force | Out-Null
}

function Write-InstallMetadata($InstallRootResolved, $DataRootResolved, $Version, $PackageManifestSha256) {
  $managedFilesSha256 = Write-ManagedTreeInventory -Root $InstallRootResolved `
    -MetadataFileName 'blue-tanuki-install.json' -InventoryFileName 'blue-tanuki-managed-files.json' `
    -ProductId 'blue-tanuki-product-install'
  $metadata = [ordered]@{
    schema_version = 3
    product_id = "blue-tanuki-product-install"
    install_root = $InstallRootResolved
    data_root = $DataRootResolved
    version = $Version
    package_manifest_sha256 = $PackageManifestSha256
    managed_files_sha256 = $managedFilesSha256
  }
  $metadataPath = Join-Path $InstallRootResolved "blue-tanuki-install.json"
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

function Write-DataInstallMetadata($DataRootResolved, $InstallRootResolved, $Version) {
  $metadata = [ordered]@{
    schema_version = 1
    product_id = "blue-tanuki-product-data"
    install_root = $InstallRootResolved
    data_root = $DataRootResolved
    version = $Version
  }
  $metadataPath = Join-Path $DataRootResolved "blue-tanuki-product-data.json"
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

function Assert-RegistryTargetCompatible($InstallRootResolved) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki'
  if (-not (Test-Path -LiteralPath $key)) { return }
  try { $entry = Get-ItemProperty -LiteralPath $key -ErrorAction Stop } catch {
    Fail "Existing BLUE-TANUKI uninstall registration could not be read safely: $key"
  }
  $expectedLocation = Get-InstallPathIdentity $InstallRootResolved
  $expectedCommand = Get-InstallPathIdentity (Join-Path $InstallRootResolved 'UninstallBlueTanuki.cmd')
  $registeredLocation = ''
  $registeredCommand = ''
  try { if ($entry.InstallLocation) { $registeredLocation = Get-InstallPathIdentity ([string]$entry.InstallLocation) } } catch { }
  try {
    if ($entry.UninstallString -match '^\s*"(?<path>[^"]+)"') { $registeredCommand = Get-InstallPathIdentity $Matches.path }
    elseif ($entry.UninstallString -match '^\s*(?<path>.+?\.cmd)(?:\s|$)') { $registeredCommand = Get-InstallPathIdentity $Matches.path }
  } catch { }
  if (-not [string]::Equals($registeredLocation, $expectedLocation, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($registeredCommand, $expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "Existing uninstall registration does not identify this installation. No files were changed: $key"
  }
}

function Assert-DataRootAdoptable($DataRootResolved, $InstallRootResolved, $ExistingProductInstall) {
  if (-not (Test-Path -LiteralPath $DataRootResolved -PathType Container)) { return }
  Assert-NoReparsePointsInTree -Path $DataRootResolved -Label 'ProductDataRoot'
  $markerPath = Join-Path $DataRootResolved 'blue-tanuki-product-data.json'
  if (Test-Path -LiteralPath $markerPath) {
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { Fail "Product data ownership marker is not a regular file: $markerPath" }
    $markerItem = Get-Item -Force -LiteralPath $markerPath
    if (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.Length -gt 65536) {
      Fail "Product data ownership marker is not a bounded regular file: $markerPath"
    }
    try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch {
      Fail "Product data ownership marker is invalid: $markerPath"
    }
    if ($marker.schema_version -ne 1 -or $marker.product_id -ne 'blue-tanuki-product-data' -or
        -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $DataRootResolved), [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity $InstallRootResolved), [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail "Product data ownership marker points to a different install or data root. No data was changed."
    }
    return
  }
  $existing = @(Get-ChildItem -Force -LiteralPath $DataRootResolved -ErrorAction Stop)
  if ($existing.Count -gt 0 -and -not $ExistingProductInstall) {
    Fail "Data root already contains unowned files and cannot be adopted safely: $DataRootResolved. Preserve or relocate them before setup."
  }
}

$stageRoot = $null
$rollbackRoot = $null
$envBackup = $null
$oldMoved = $false
$newMoved = $false
$existingProductInstall = $false
$installRootResolved = $null
$dataRootResolved = $null
$envFile = $null
try {
  $packageRoot = Split-Path -Parent $PSCommandPath
  $sourceApp = Join-Path $packageRoot "app"
  $sourceLaunchers = Join-Path $packageRoot "launcher"
  $manifestPath = Join-Path $packageRoot "windows-installer-manifest.json"
  Assert-PackagedInstallerRoot $packageRoot
  . (Join-Path $sourceApp "install\windows\safe-target.ps1")
  Assert-NoReparsePointsInTree -Path $packageRoot -Label 'PackagedInstallerRoot'
  $packageManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($packageManifest.schema_version -ne 1 -or $packageManifest.name -ne 'blue-tanuki' -or $packageManifest.package_type -ne 'windows-x64-zip-installer') {
    Fail "Packaged installer manifest does not identify a BLUE-TANUKI Windows installer."
  }
  $manifestSha256 = Get-Sha256HexFromFile -Path $manifestPath
  $version = [string]$packageManifest.version
  $safeTargets = Assert-SafeInstallTargets -InstallRoot $InstallRoot -DataRoot $DataRoot -SourceRoot $packageRoot
  $installRootResolved = $safeTargets.InstallRoot
  $dataRootResolved = $safeTargets.DataRoot
  $envFile = Join-Path $dataRootResolved "blue-tanuki.env"
  $dataDir = Join-Path $dataRootResolved "data"
  $logDir = Join-Path $dataRootResolved "logs"
  try {
    if (Restore-InterruptedWindowsProductUpdate -InstallRoot $installRootResolved -DataRoot $dataRootResolved) {
      Write-Warning "Restored one verified previous BLUE-TANUKI install after an interrupted update. Setup will continue using the packaged version."
    }
  } catch {
    Fail "Refusing to continue because interrupted-update recovery was ambiguous or could not be verified. Existing paths were preserved. $($_.Exception.Message)"
  }
  $existingProductInstall = Test-Path -LiteralPath $installRootResolved -PathType Container
  if (Test-Path -LiteralPath $installRootResolved) {
    if (-not $existingProductInstall) { Fail "Install target exists but is not a directory. No files were changed: $installRootResolved" }
    try { [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved) } catch {
      Fail "Refusing to replace $installRootResolved because ownership and installed structure could not be verified. No files were changed. $($_.Exception.Message)"
    }
  }
  Assert-DataRootAdoptable $dataRootResolved $installRootResolved $existingProductInstall
  Assert-RegistryTargetCompatible $installRootResolved
  Assert-ShortcutTargetsCompatible $installRootResolved $DesktopShortcut

  Write-Host "Installing BLUE-TANUKI to $installRootResolved"
  Write-Host "User data root: $dataRootResolved"
  Write-Host "Autostart: not enabled by installer"

  $installParent = Split-Path -Parent $installRootResolved
  $installName = Split-Path -Leaf $installRootResolved
  $installParent = Resolve-SafeDirectoryTarget -Path $installParent -Label 'InstallParent'
  if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $installParent | Out-Null
    $installParent = Resolve-SafeDirectoryTarget -Path $installParent -Label 'InstallParent'
  }
  $suffix = [Guid]::NewGuid().ToString('N')
  $stageRoot = Join-Path $installParent ("." + $installName + ".blue-tanuki-stage-" + $suffix)
  $rollbackRoot = Join-Path $installParent ("." + $installName + ".blue-tanuki-rollback-" + $suffix)
  if ((Test-Path -LiteralPath $stageRoot) -or (Test-Path -LiteralPath $rollbackRoot)) { Fail "Could not allocate unique installer staging paths." }
  New-Item -ItemType Directory -Path $stageRoot | Out-Null

  Copy-DirectoryContents $sourceApp $stageRoot
  Expand-BundledNode $packageRoot $stageRoot
  Copy-DirectoryContents $sourceLaunchers $stageRoot
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stageRoot 'blue-tanuki-package-manifest.json')
  Write-InstallMetadata $stageRoot $dataRootResolved $version $manifestSha256
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $stageRoot -DataRoot $dataRootResolved -MetadataInstallRoot $installRootResolved)
  Assert-NoReparsePointsInTree -Path $stageRoot -Label 'StagedProductInstall'

  if ($existingProductInstall) {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
    Stop-ExistingResident $installRootResolved
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
  }

  New-Item -ItemType Directory -Force -Path $dataRootResolved, $dataDir, $logDir | Out-Null
  if ($ResetConfig -and (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $envBackup = Join-Path $dataRootResolved ('.blue-tanuki-env-rollback-' + $suffix)
    Copy-Item -LiteralPath $envFile -Destination $envBackup
  }
  $nodeExe = Find-NodeExe $stageRoot
  Invoke-BundledSetup $nodeExe $stageRoot $envFile $dataDir
  if (-not $SkipDoctor) { Invoke-PostInstallDoctor $nodeExe $stageRoot $envFile $logDir }

  if ($existingProductInstall) {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
    Assert-NoReparsePointsInTree -Path $installRootResolved -Label 'ExistingProductInstall'
    Move-Item -LiteralPath $installRootResolved -Destination $rollbackRoot
    $oldMoved = $true
  }
  try {
    Move-Item -LiteralPath $stageRoot -Destination $installRootResolved
    $newMoved = $true
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
    Write-DataInstallMetadata $dataRootResolved $installRootResolved $version
    Install-Shortcuts $installRootResolved $DesktopShortcut
    Register-Uninstaller $installRootResolved $dataRootResolved $version
    if (-not $NoLaunch) {
      try { Start-Process -FilePath (Join-Path $installRootResolved "BlueTanuki.cmd") } catch {
        Write-Warning "BLUE-TANUKI is installed, but the Control Center did not launch. Start it from the Start Menu or $installRootResolved\BlueTanuki.cmd. $($_.Exception.Message)"
      }
    }
  } catch {
    if ($newMoved -and (Test-Path -LiteralPath $installRootResolved -PathType Container)) {
      try {
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
        Assert-NoReparsePointsInTree -Path $installRootResolved -Label 'FailedNewProductInstall'
        Remove-Item -LiteralPath $installRootResolved -Recurse -Force
        $newMoved = $false
      } catch {
        throw "New install failed and could not be safely removed for rollback. Both paths were preserved where possible. install=$installRootResolved; rollback=$rollbackRoot; reason=$($_.Exception.Message)"
      }
    }
    if ($oldMoved -and (Test-Path -LiteralPath $rollbackRoot -PathType Container) -and -not (Test-Path -LiteralPath $installRootResolved)) {
      [void](Assert-ManagedWindowsProductInstall -InstallRoot $rollbackRoot -DataRoot $dataRootResolved `
        -MetadataInstallRoot $installRootResolved)
      Move-Item -LiteralPath $rollbackRoot -Destination $installRootResolved
      $oldMoved = $false
    }
    throw
  }

  if ($envBackup -and (Test-Path -LiteralPath $envBackup -PathType Leaf)) {
    Remove-Item -LiteralPath $envBackup -Force
  }
  if ($oldMoved -and (Test-Path -LiteralPath $rollbackRoot -PathType Container)) {
    try {
      [void](Assert-ManagedWindowsProductInstall -InstallRoot $rollbackRoot -DataRoot $dataRootResolved `
        -MetadataInstallRoot $installRootResolved)
      Assert-NoReparsePointsInTree -Path $rollbackRoot -Label 'PreviousProductInstall'
      Remove-Item -LiteralPath $rollbackRoot -Recurse -Force
      $oldMoved = $false
    } catch {
      Write-Warning "The new install is active; the previous managed app was retained for recovery at $rollbackRoot. $($_.Exception.Message)"
    }
  }

  Write-Host ""
  Write-Host "BLUE-TANUKI installed."
  Write-Host "Start Menu: BLUE-TANUKI"
  Write-Host "Install root: $installRootResolved"
  Write-Host "Env file: $envFile"
  Write-Host "Logs: $logDir"
  Write-Host "Control Center: http://127.0.0.1:8787/app"
  Write-Host "Uninstall: Windows Apps / Control Panel or $installRootResolved\UninstallBlueTanuki.cmd"
} catch {
  if ($stageRoot -and (Test-Path -LiteralPath $stageRoot -PathType Container)) {
    try {
      [void](Assert-ManagedWindowsProductInstall -InstallRoot $stageRoot -DataRoot $dataRootResolved `
        -MetadataInstallRoot $installRootResolved)
      Remove-Item -LiteralPath $stageRoot -Recurse -Force
    } catch { Write-Warning "Staging directory was preserved for inspection: $stageRoot" }
  }
  if ($envBackup -and (Test-Path -LiteralPath $envBackup -PathType Leaf) -and $envFile) {
    try { Copy-Item -LiteralPath $envBackup -Destination $envFile -Force; Remove-Item -LiteralPath $envBackup -Force } catch {
      Write-Warning "The prior configuration could not be restored automatically; backup retained at $envBackup"
    }
  }
  Write-Host "BLUE-TANUKI setup failed. $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
