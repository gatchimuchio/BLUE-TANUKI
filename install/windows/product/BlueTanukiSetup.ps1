[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\BlueTanuki",
  [string]$DataRoot = "$env:APPDATA\BlueTanuki",
  [switch]$DesktopShortcut,
  [switch]$NoLaunch,
  [switch]$Update,
  [switch]$Rollback,
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

if ($Update -and $Rollback) { Fail 'Use only one of -Update or -Rollback.' }
if ($Rollback -and ($ResetConfig -or $SkipDoctor -or $DesktopShortcut)) {
  Fail 'Rollback does not accept config-reset, doctor-skip, or shortcut-change options.'
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
  Write-Host "  For same-schema manual update use BlueTanukiSetup.cmd -Update; use -Rollback to restore the retained previous app."
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

function Copy-DirectoryContents($Source, $Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    Fail "Packaged installer content is incomplete. Missing directory: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -Force -LiteralPath $Source | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Expand-BundledNode($PackageRoot, $InstallRootResolved, $PackageManifest) {
  $runtimePackageRoot = Join-Path $PackageRoot "runtime"
  $nodeRuntime = $PackageManifest.node_runtime
  $version = [string]$nodeRuntime.version
  $archiveName = [string]$nodeRuntime.archive
  $expectedSha256 = [string]$nodeRuntime.sha256
  if ($nodeRuntime.bundled -ne $true -or $version -notmatch '^\d+\.\d+\.\d+$' -or
      $archiveName -cne "node-v$version-win-x64.zip" -or $expectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      [string]$nodeRuntime.source -cne "https://nodejs.org/dist/v$version/$archiveName" -or
      [string]$nodeRuntime.shasums_source -cne "https://nodejs.org/dist/v$version/SHASUMS256.txt") {
    Fail "Packaged Node runtime manifest is invalid. No installed files were changed."
  }
  $nodeArchives = @(Get-ChildItem -LiteralPath $runtimePackageRoot -File -Filter "node-v*-win-x64.zip" -ErrorAction SilentlyContinue)
  if ($nodeArchives.Count -ne 1 -or $nodeArchives[0].Name -cne $archiveName) {
    Fail "Packaged Windows Node runtime archive does not match its manifest. No installed files were changed."
  }
  $nodeZip = $nodeArchives[0]
  $actualSha256 = Get-Sha256HexFromFile -Path $nodeZip.FullName
  if (-not [string]::Equals($actualSha256, $expectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "Packaged Windows Node runtime SHA-256 does not match its manifest. No installed files were changed."
  }
  $runtimeInstallRoot = Join-Path $InstallRootResolved "runtime"
  New-Item -ItemType Directory -Force -Path $runtimeInstallRoot | Out-Null
  Expand-Archive -LiteralPath $nodeZip.FullName -DestinationPath $runtimeInstallRoot -Force

  $expectedNodePath = Join-Path (Join-Path $runtimeInstallRoot "node-v$version-win-x64") "node.exe"
  $nodeExecutables = @(Get-ChildItem -LiteralPath $runtimeInstallRoot -Recurse -File -Filter "node.exe" -ErrorAction SilentlyContinue)
  $nodeItem = Get-Item -Force -LiteralPath $expectedNodePath -ErrorAction SilentlyContinue
  if ($nodeExecutables.Count -ne 1 -or -not $nodeItem -or
      ($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not [string]::Equals([System.IO.Path]::GetFullPath($nodeExecutables[0].FullName),
        [System.IO.Path]::GetFullPath($expectedNodePath), [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "Packaged Windows Node runtime did not extract one regular executable at its versioned path. No installed files were changed."
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $nodeVersionOutput = @()
  $nodeVersionExitCode = $null
  try {
    $ErrorActionPreference = "Continue"
    $nodeVersionOutput = @(& $expectedNodePath --version 2>&1)
    $nodeVersionExitCode = $LASTEXITCODE
  } catch {
    Fail "Packaged Windows Node runtime could not be started for version verification. No installed files were changed."
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $actualNodeVersion = ((@($nodeVersionOutput) | ForEach-Object { [string]$_ }) -join "`n").Trim()
  if ($nodeVersionExitCode -ne 0 -or $actualNodeVersion -cne "v$version") {
    Fail "Packaged Windows Node runtime version does not match its manifest. No installed files were changed."
  }
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
  $doctorErrorLog = Join-Path $LogDir "post-install-doctor.stderr.log"
  Push-Location $InstallRootResolved
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5.1 promotes native stderr to an error record. Keep
      # a warning on stderr from aborting Setup while still checking Node's exit code.
      $ErrorActionPreference = "Continue"
      & $NodeExe "apps/gateway/dist/main.js" "--doctor" "--env-file" $EnvFile "--json" > $doctorLog 2> $doctorErrorLog
      $doctorCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($doctorCode -eq 2) {
      Fail "post-install doctor found blocking errors. Log: $doctorLog; stderr: $doctorErrorLog"
    }
    if ($doctorCode -ne 0 -and $doctorCode -ne 1) {
      Fail "post-install doctor failed with exit code $doctorCode. Log: $doctorLog; stderr: $doctorErrorLog"
    }
    if ($doctorCode -eq 1) {
      Write-Warning "post-install doctor completed with warnings. Log: $doctorLog; stderr: $doctorErrorLog"
    } else {
      Write-Host "post-install doctor passed. Log: $doctorLog; stderr: $doctorErrorLog"
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
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Status.lnk") $ps "-NoProfile -File `"$launcher`" resident-status" $InstallRootResolved "Show BLUE-TANUKI runtime status without changing it" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Doctor.lnk") $ps "-NoProfile -File `"$launcher`" doctor-open" $InstallRootResolved "Run BLUE-TANUKI Doctor" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Logs.lnk") $ps "-NoProfile -File `"$launcher`" logs" $InstallRootResolved "Open BLUE-TANUKI logs" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Safe Mode.lnk") $ps "-NoProfile -File `"$launcher`" safe-mode" $InstallRootResolved "Start BLUE-TANUKI with external providers and connectors disabled" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Restart.lnk") $ps "-NoProfile -File `"$launcher`" restart" $InstallRootResolved "Restart BLUE-TANUKI in normal mode using saved settings" $icon
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
    return Test-ManagedWindowsProductLauncherShortcut -TargetPath ([string]$shortcut.TargetPath) `
      -Arguments ([string]$shortcut.Arguments) -InstallRoot $InstallRootResolved
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
    foreach ($name in @('BLUE-TANUKI.lnk','BLUE-TANUKI Status.lnk','BLUE-TANUKI Doctor.lnk','BLUE-TANUKI Logs.lnk','BLUE-TANUKI Safe Mode.lnk','BLUE-TANUKI Restart.lnk','BLUE-TANUKI Stop.lnk','Uninstall BLUE-TANUKI.lnk')) {
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

function Write-InstallMetadata($InventoryRoot, $InstallRootResolved, $DataRootResolved, $Version, $PackageManifestSha256, $DataSchemaVersion) {
  $managedFilesSha256 = Write-ManagedTreeInventory -Root $InventoryRoot `
    -MetadataFileName 'blue-tanuki-install.json' -InventoryFileName 'blue-tanuki-managed-files.json' `
    -ProductId 'blue-tanuki-product-install'
  $metadata = [ordered]@{
    schema_version = 3
    product_id = "blue-tanuki-product-install"
    install_root = $InstallRootResolved
    data_root = $DataRootResolved
    version = $Version
    data_schema_version = $DataSchemaVersion
    package_manifest_sha256 = $PackageManifestSha256
    managed_files_sha256 = $managedFilesSha256
  }
  $metadataPath = Join-Path $InventoryRoot "blue-tanuki-install.json"
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

function Write-DataInstallMetadata($DataRootResolved, $InstallRootResolved, $Version, $ManagedFilesSha256, $DataSchemaVersion) {
  if ($ManagedFilesSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    Fail 'The staged product file inventory could not be bound to retained user data.'
  }
  if ($DataSchemaVersion -lt 1) {
    Fail 'The packaged product data-schema version is invalid.'
  }
  $metadata = [ordered]@{
    schema_version = 3
    product_id = "blue-tanuki-product-data"
    install_root = $InstallRootResolved
    data_root = $DataRootResolved
    version = $Version
    data_schema_version = $DataSchemaVersion
    managed_files_sha256 = $ManagedFilesSha256.ToLowerInvariant()
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
    if ($marker.schema_version -notin @(1, 2, 3) -or $marker.product_id -ne 'blue-tanuki-product-data' -or
        -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $DataRootResolved), [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity $InstallRootResolved), [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail "Product data ownership marker points to a different install or data root. No data was changed."
    }
    if ($marker.schema_version -eq 3 -and ([long]$marker.data_schema_version -lt 1 -or [long]$marker.data_schema_version -gt 2147483647)) {
      Fail "Product data compatibility marker has an invalid data_schema_version. No data was changed."
    }
    return
  }
  $existing = @(Get-ChildItem -Force -LiteralPath $DataRootResolved -ErrorAction Stop)
  if ($existing.Count -gt 0 -and -not $ExistingProductInstall) {
    Fail "Data root already contains unowned files and cannot be adopted safely: $DataRootResolved. Preserve or relocate them before setup."
  }
}

function Assert-DataPackageCompatibility($DataRootResolved, $StagedInstallRoot) {
  $markerPath = Join-Path $DataRootResolved 'blue-tanuki-product-data.json'
  if (-not (Test-Path -LiteralPath $markerPath)) { return }
  try {
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $stagedMetadata = Get-Content -LiteralPath (Join-Path $StagedInstallRoot 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
  } catch {
    Fail "Retained product data compatibility could not be verified. No product files or user data were changed: $($_.Exception.Message)"
  }
  if ($marker.schema_version -ne 3 -or $marker.product_id -ne 'blue-tanuki-product-data' -or
      [long]$marker.data_schema_version -lt 1 -or [long]$marker.data_schema_version -gt 2147483647 -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $DataRootResolved), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity ([string]$stagedMetadata.install_root)), [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail 'Retained product data compatibility is unknown. The data root has no recognized product data-schema version, so setup is blocked.'
  }
  if ([long]$marker.data_schema_version -ne [long]$stagedMetadata.data_schema_version) {
    Fail 'The package product data-schema version differs from the retained data marker. Migration is unsupported; setup is blocked and all existing data is preserved.'
  }
}

function ConvertTo-ProductSemVer($Version) {
  $match = [System.Text.RegularExpressions.Regex]::Match(
    [string]$Version,
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
  )
  if (-not $match.Success) { Fail "Product version is not a supported semantic version: $Version" }
  $prerelease = @()
  if ($match.Groups[4].Success) {
    $prerelease = @($match.Groups[4].Value.Split('.'))
    foreach ($identifier in $prerelease) {
      if ([System.Text.RegularExpressions.Regex]::IsMatch($identifier, '^[0-9]+$') -and $identifier.Length -gt 1 -and $identifier.StartsWith('0')) {
        Fail "Product version contains an invalid zero-padded numeric prerelease identifier: $Version"
      }
    }
  }
  return [pscustomobject]@{
    Core = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value)
    Prerelease = $prerelease
  }
}

function Compare-SemVerIdentifier([string]$Left, [string]$Right) {
  $leftNumeric = [System.Text.RegularExpressions.Regex]::IsMatch($Left, '^(0|[1-9][0-9]*)$')
  $rightNumeric = [System.Text.RegularExpressions.Regex]::IsMatch($Right, '^(0|[1-9][0-9]*)$')
  if ($leftNumeric -and $rightNumeric) {
    if ($Left.Length -lt $Right.Length) { return -1 }
    if ($Left.Length -gt $Right.Length) { return 1 }
    return [string]::CompareOrdinal($Left, $Right)
  }
  if ($leftNumeric -and -not $rightNumeric) { return -1 }
  if (-not $leftNumeric -and $rightNumeric) { return 1 }
  return [string]::CompareOrdinal($Left, $Right)
}

function Compare-ProductSemVer([string]$Left, [string]$Right) {
  $leftVersion = ConvertTo-ProductSemVer $Left
  $rightVersion = ConvertTo-ProductSemVer $Right
  for ($index = 0; $index -lt 3; $index++) {
    $comparison = Compare-SemVerIdentifier $leftVersion.Core[$index] $rightVersion.Core[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  if ($leftVersion.Prerelease.Count -eq 0 -and $rightVersion.Prerelease.Count -gt 0) { return 1 }
  if ($leftVersion.Prerelease.Count -gt 0 -and $rightVersion.Prerelease.Count -eq 0) { return -1 }
  $sharedCount = [Math]::Min($leftVersion.Prerelease.Count, $rightVersion.Prerelease.Count)
  for ($index = 0; $index -lt $sharedCount; $index++) {
    $comparison = Compare-SemVerIdentifier $leftVersion.Prerelease[$index] $rightVersion.Prerelease[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  if ($leftVersion.Prerelease.Count -lt $rightVersion.Prerelease.Count) { return -1 }
  if ($leftVersion.Prerelease.Count -gt $rightVersion.Prerelease.Count) { return 1 }
  return 0
}

function Get-PreviousProductInstallPath($InstallRootResolved) {
  $parent = Split-Path -Parent $InstallRootResolved
  $name = Split-Path -Leaf $InstallRootResolved
  return Join-Path $parent ('.' + $name + '.blue-tanuki-previous')
}

function Assert-ManagedPreviousProductInstall($PreviousRoot, $InstallRootResolved, $DataRootResolved) {
  if (-not (Test-Path -LiteralPath $PreviousRoot)) { return $null }
  $item = Get-Item -Force -LiteralPath $PreviousRoot -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "Previous product rollback path is not a regular directory and was preserved: $PreviousRoot"
  }
  $resolved = Resolve-SafeDirectoryTarget -Path $PreviousRoot -Label 'PreviousProductRollbackRoot'
  if (-not [string]::Equals(
      (Split-Path -Parent $resolved), (Split-Path -Parent $InstallRootResolved),
      [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "Previous product rollback path is not a sibling of the installed product and was preserved: $PreviousRoot"
  }
  try {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $resolved -DataRoot $DataRootResolved `
      -MetadataInstallRoot $InstallRootResolved)
    Assert-NoReparsePointsInTree -Path $resolved -Label 'PreviousProductRollbackRoot'
    return (Get-Content -LiteralPath (Join-Path $resolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json)
  } catch {
    Fail "Previous product rollback path is not a verified managed install and was preserved: $($_.Exception.Message)"
  }
}

function Stop-ManagedProductResident($InstallRootResolved, $DataRootResolved) {
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $InstallRootResolved -DataRoot $DataRootResolved)
  $launcher = Join-Path $InstallRootResolved 'BlueTanukiLauncher.ps1'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    Fail 'The installed resident launcher is missing; update was stopped without replacing the product.'
  }
  $powerShellExe = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
    $powerShellExe = Join-Path $PSHOME 'pwsh.exe'
  }
  if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
    Fail 'A PowerShell host for the installed resident-stop command could not be found.'
  }
  $arguments = @('-NoProfile', '-File', ('"{0}"' -f $launcher), 'resident-stop')
  $stopProcess = Start-Process -FilePath $powerShellExe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($stopProcess.ExitCode -ne 0) {
    Fail "The installed resident did not confirm shutdown (exit code $($stopProcess.ExitCode)); update was stopped and installed files were preserved."
  }
}

function Invoke-ProductRollback($InstallRootResolved, $DataRootResolved, $PackageDataSchemaVersion, $NoLaunch) {
  $previousRoot = Get-PreviousProductInstallPath $InstallRootResolved
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $InstallRootResolved -DataRoot $DataRootResolved)
  $currentMetadata = Get-Content -LiteralPath (Join-Path $InstallRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
  $previousMetadata = Assert-ManagedPreviousProductInstall $previousRoot $InstallRootResolved $DataRootResolved
  if (-not $previousMetadata) { Fail "No verified previous BLUE-TANUKI application is available to roll back: $previousRoot" }

  $currentSchema = 0L
  $previousSchema = 0L
  if (-not [long]::TryParse([string]$currentMetadata.data_schema_version, [ref]$currentSchema) -or
      -not [long]::TryParse([string]$previousMetadata.data_schema_version, [ref]$previousSchema) -or
      $currentSchema -ne $PackageDataSchemaVersion -or $previousSchema -ne $PackageDataSchemaVersion) {
    Fail 'Rollback requires the installed application, retained previous application, and selected installer to declare the same product data schema. No files were changed.'
  }
  $dataMarker = Assert-ManagedWindowsProductDataMarker -DataRoot $DataRootResolved -InstallRoot $InstallRootResolved -IncludeMarker
  if ($dataMarker.marker.schema_version -ne 3 -or
      [long]$dataMarker.marker.data_schema_version -ne $PackageDataSchemaVersion) {
    Fail 'Rollback is blocked because the retained user-data schema cannot be verified against both application versions. No files were changed.'
  }

  $suffix = [Guid]::NewGuid().ToString('N').Substring(0,16)
  $parent = Split-Path -Parent $InstallRootResolved
  $name = Split-Path -Leaf $InstallRootResolved
  $pendingRoot = Join-Path $parent ('.' + $name + '.blue-tanuki-rollback-' + $suffix)
  $replacedInstallRoot = Join-Path $parent ('.' + $name + '.blue-tanuki-interrupted-' + $suffix)
  if (Test-Path -LiteralPath $pendingRoot) { Fail 'Could not allocate a unique rollback transaction path. No files were changed.' }
  if (Test-Path -LiteralPath $replacedInstallRoot) { Fail 'Could not allocate a unique rollback inspection path. No files were changed.' }

  Stop-ManagedProductResident $InstallRootResolved $DataRootResolved
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $InstallRootResolved -DataRoot $DataRootResolved)
  [void](Assert-ManagedPreviousProductInstall $previousRoot $InstallRootResolved $DataRootResolved)
  [System.IO.Directory]::Move($InstallRootResolved, $pendingRoot)
  try {
    [System.IO.Directory]::Move($previousRoot, $InstallRootResolved)
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $InstallRootResolved -DataRoot $DataRootResolved)
    $restoredMetadata = Get-Content -LiteralPath (Join-Path $InstallRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
    Register-Uninstaller $InstallRootResolved $DataRootResolved ([string]$restoredMetadata.version)
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $pendingRoot -DataRoot $DataRootResolved `
      -MetadataInstallRoot $InstallRootResolved)
    Assert-NoReparsePointsInTree -Path $pendingRoot -Label 'ReplacedProductInstall'
    [System.IO.Directory]::Move($pendingRoot, $replacedInstallRoot)
  } catch {
    $rollbackFailure = $_.Exception.Message
    try {
      if ((Test-Path -LiteralPath $InstallRootResolved -PathType Container) -and
          -not (Test-Path -LiteralPath $previousRoot)) {
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $InstallRootResolved -DataRoot $DataRootResolved)
        Assert-NoReparsePointsInTree -Path $InstallRootResolved -Label 'RollbackCandidateInstall'
        [System.IO.Directory]::Move($InstallRootResolved, $previousRoot)
      }
      if ((Test-Path -LiteralPath $pendingRoot -PathType Container) -and
          -not (Test-Path -LiteralPath $InstallRootResolved)) {
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $pendingRoot -DataRoot $DataRootResolved `
          -MetadataInstallRoot $InstallRootResolved)
        [System.IO.Directory]::Move($pendingRoot, $InstallRootResolved)
        $currentAfterRestore = Get-Content -LiteralPath (Join-Path $InstallRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
        Register-Uninstaller $InstallRootResolved $DataRootResolved ([string]$currentAfterRestore.version)
      }
    } catch {
      Fail "Rollback did not complete and automatic restoration could not be confirmed. All remaining paths were preserved for inspection. install=$InstallRootResolved; previous=$previousRoot; pending=$pendingRoot; reason=$($_.Exception.Message)"
    }
    Fail "Rollback did not complete. The previously running application was restored and the retained data was not changed. reason=$rollbackFailure"
  }

  try {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $replacedInstallRoot -DataRoot $DataRootResolved `
      -MetadataInstallRoot $InstallRootResolved)
    Assert-NoReparsePointsInTree -Path $replacedInstallRoot -Label 'ReplacedProductInstall'
    Remove-Item -LiteralPath $replacedInstallRoot -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $replacedInstallRoot) { throw 'The replaced application remained after rollback cleanup.' }
  } catch {
    Write-Warning "Rollback completed, but the replaced application could not be retired and was preserved for inspection: $replacedInstallRoot. $($_.Exception.Message)"
  }

  Write-Host "Rolled BLUE-TANUKI back to version $($restoredMetadata.version)."
  Write-Host 'The product data and configuration were retained.'
  if (-not $NoLaunch) {
    try { Start-Process -FilePath (Join-Path $InstallRootResolved 'BlueTanuki.cmd') } catch {
      Write-Warning "Rollback completed, but BLUE-TANUKI did not launch. Start it from the Start Menu or $InstallRootResolved\BlueTanuki.cmd. $($_.Exception.Message)"
    }
  }
}

$stageRoot = $null
$envBackup = $null
$newMoved = $false
$updateRollbackRoot = $null
$updateMode = [bool]$Update
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
  $packageDataSchemaVersion = 0L
  if (-not [long]::TryParse([string]$packageManifest.data_schema_version, [ref]$packageDataSchemaVersion) -or
      $packageDataSchemaVersion -lt 1 -or $packageDataSchemaVersion -gt 2147483647) {
    Fail "Packaged installer manifest has no supported product data-schema version."
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
      $restoredMetadata = Get-Content -LiteralPath (Join-Path $installRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
      Register-Uninstaller $installRootResolved $dataRootResolved ([string]$restoredMetadata.version)
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
    Assert-RegistryTargetCompatible $installRootResolved
    if ($Rollback) {
      Assert-ShortcutTargetsCompatible $installRootResolved $false
      Invoke-ProductRollback $installRootResolved $dataRootResolved $packageDataSchemaVersion $NoLaunch
      exit 0
    }
    if (-not $Update) {
      Fail 'In-place product replacement requires the explicit -Update option. A matching product data-schema declaration alone does not authorize replacement; the existing application and data were preserved.'
    }
    if ($ResetConfig -or $SkipDoctor) {
      Fail 'A product update cannot reset configuration or skip the packaged doctor. No files were changed.'
    }
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
      Fail 'The installed user configuration is missing. Update is blocked to avoid generating or replacing configuration.'
    }
    $envFileItem = Get-Item -Force -LiteralPath $envFile -ErrorAction Stop
    if (($envFileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail 'The installed user configuration is a reparse point. Update is blocked without changing it.'
    }
    $currentMetadata = Get-Content -LiteralPath (Join-Path $installRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
    if ((Compare-ProductSemVer ([string]$packageManifest.version) ([string]$currentMetadata.version)) -le 0) {
      Fail "Update version must be newer than the installed version. installed=$($currentMetadata.version); candidate=$($packageManifest.version). Use -Rollback for the retained previous version."
    }
    Assert-DataPackageCompatibility $dataRootResolved $installRootResolved
    $previousInstallRoot = Get-PreviousProductInstallPath $installRootResolved
    $priorRollbackMetadata = Assert-ManagedPreviousProductInstall $previousInstallRoot $installRootResolved $dataRootResolved
    if ($priorRollbackMetadata -and [long]$priorRollbackMetadata.data_schema_version -ne $packageDataSchemaVersion) {
      Fail 'The retained rollback application has a different product data schema. No application or user data was changed.'
    }
  } elseif ($Update -or $Rollback) {
    Fail 'The requested update or rollback requires an existing verified BLUE-TANUKI installation. No files were changed.'
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
  $transactionSuffix = $suffix.Substring(0,16)
  $stageRoot = Join-Path $installParent ("." + $installName + ".blue-tanuki-stage-" + $transactionSuffix)
  if (Test-Path -LiteralPath $stageRoot) { Fail "Could not allocate unique installer staging path." }
  New-Item -ItemType Directory -Path $stageRoot | Out-Null

  Copy-DirectoryContents $sourceApp $stageRoot
  Expand-BundledNode $packageRoot $stageRoot $packageManifest
  Copy-DirectoryContents $sourceLaunchers $stageRoot
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stageRoot 'blue-tanuki-package-manifest.json')
  Write-InstallMetadata $stageRoot $installRootResolved $dataRootResolved $version $manifestSha256 $packageDataSchemaVersion
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $stageRoot -DataRoot $dataRootResolved -MetadataInstallRoot $installRootResolved)
  Assert-NoReparsePointsInTree -Path $stageRoot -Label 'StagedProductInstall'
  Assert-DataPackageCompatibility $dataRootResolved $stageRoot

  New-Item -ItemType Directory -Force -Path $dataRootResolved, $dataDir, $logDir | Out-Null
  if ($ResetConfig -and (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $envBackup = Join-Path $dataRootResolved ('.blue-tanuki-env-rollback-' + $suffix)
    Copy-Item -LiteralPath $envFile -Destination $envBackup
  }
  $nodeExe = Find-NodeExe $stageRoot
  Invoke-BundledSetup $nodeExe $stageRoot $envFile $dataDir
  $doctorLogDir = $logDir
  if ($updateMode) {
    Stop-ManagedProductResident $installRootResolved $dataRootResolved
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
    $activeAfterStop = Get-Content -LiteralPath (Join-Path $installRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
    if (-not [string]::Equals([string]$activeAfterStop.version, [string]$currentMetadata.version, [System.StringComparison]::Ordinal) -or
        [long]$activeAfterStop.data_schema_version -ne $packageDataSchemaVersion) {
      Fail 'The installed product changed during update preparation. The candidate was not applied and existing paths were preserved.'
    }
    $doctorLogDir = Join-Path $logDir ('update-' + $version + '-' + $transactionSuffix)
    [void](Resolve-SafeDirectoryTarget -Path $doctorLogDir -Label 'UpdateDoctorLogRoot')
    if (Test-Path -LiteralPath $doctorLogDir) {
      Fail 'The update doctor log path already exists. The active installation and user data were preserved.'
    }
  }
  if (-not $SkipDoctor) { Invoke-PostInstallDoctor $nodeExe $stageRoot $envFile $doctorLogDir }

  if ($updateMode -and (Test-Path -LiteralPath $previousInstallRoot)) {
    $priorRollbackMetadata = Assert-ManagedPreviousProductInstall $previousInstallRoot $installRootResolved $dataRootResolved
    if ([long]$priorRollbackMetadata.data_schema_version -ne $packageDataSchemaVersion) {
      Fail 'The retained rollback application changed or has an incompatible product data schema. No files were changed.'
    }
    Assert-NoReparsePointsInTree -Path $previousInstallRoot -Label 'PreviousProductRollbackRoot'
    Remove-Item -LiteralPath $previousInstallRoot -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $previousInstallRoot) {
      Fail 'The prior rollback application could not be retired safely. The active installation and user data were preserved.'
    }
  }

  try {
    if ($updateMode) {
      $updateRollbackRoot = Join-Path $installParent ('.' + $installName + '.blue-tanuki-rollback-' + $transactionSuffix)
      if (Test-Path -LiteralPath $updateRollbackRoot) { Fail 'Could not allocate a unique update rollback path. No files were changed.' }
      [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
      [System.IO.Directory]::Move($installRootResolved, $updateRollbackRoot)
    }
    [System.IO.Directory]::Move($stageRoot, $installRootResolved)
    $stageRoot = $null
    $newMoved = $true
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
    $installedMetadata = Get-Content -LiteralPath (Join-Path $installRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath (Join-Path $dataRootResolved 'blue-tanuki-product-data.json'))) {
      Write-DataInstallMetadata $dataRootResolved $installRootResolved $version ([string]$installedMetadata.managed_files_sha256) $packageDataSchemaVersion
    }
    Install-Shortcuts $installRootResolved $DesktopShortcut
    Register-Uninstaller $installRootResolved $dataRootResolved $version
    if ($updateMode) {
      [void](Assert-ManagedWindowsProductInstall -InstallRoot $updateRollbackRoot -DataRoot $dataRootResolved `
        -MetadataInstallRoot $installRootResolved)
      [System.IO.Directory]::Move($updateRollbackRoot, $previousInstallRoot)
      $updateRollbackRoot = $previousInstallRoot
      [void](Assert-ManagedPreviousProductInstall $previousInstallRoot $installRootResolved $dataRootResolved)
      $updateRollbackRoot = $null
    }
    if (-not $NoLaunch) {
      try { Start-Process -FilePath (Join-Path $installRootResolved "BlueTanuki.cmd") } catch {
        Write-Warning "BLUE-TANUKI is installed, but the Control Center did not launch. Start it from the Start Menu or $installRootResolved\BlueTanuki.cmd. $($_.Exception.Message)"
      }
    }
  } catch {
    $installFailure = $_.Exception.Message
    if ($updateMode -and $updateRollbackRoot -and (Test-Path -LiteralPath $updateRollbackRoot -PathType Container)) {
      try {
        if (Test-Path -LiteralPath $installRootResolved) {
          [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
          Assert-NoReparsePointsInTree -Path $installRootResolved -Label 'FailedUpdatedProductInstall'
          $failedUpdateRoot = Join-Path $installParent ('.' + $installName + '.blue-tanuki-interrupted-' + $transactionSuffix)
          if (Test-Path -LiteralPath $failedUpdateRoot) { throw 'The update inspection path already exists.' }
          [System.IO.Directory]::Move($installRootResolved, $failedUpdateRoot)
        }
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $updateRollbackRoot -DataRoot $dataRootResolved `
          -MetadataInstallRoot $installRootResolved)
        [System.IO.Directory]::Move($updateRollbackRoot, $installRootResolved)
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
        $restoredMetadata = Get-Content -LiteralPath (Join-Path $installRootResolved 'blue-tanuki-install.json') -Raw | ConvertFrom-Json
        Register-Uninstaller $installRootResolved $dataRootResolved ([string]$restoredMetadata.version)
        $newMoved = $false
        $updateRollbackRoot = $null
      } catch {
        throw "Update failed and automatic rollback could not be confirmed. All remaining paths were preserved. install=$installRootResolved; rollback=$updateRollbackRoot; reason=$($_.Exception.Message)"
      }
      throw "Update failed. The previous application and existing configuration/state were restored; the update doctor record, if created, remains in $doctorLogDir. reason=$installFailure"
    }
    if ($newMoved -and (Test-Path -LiteralPath $installRootResolved -PathType Container)) {
      try {
        [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
        Assert-NoReparsePointsInTree -Path $installRootResolved -Label 'FailedNewProductInstall'
        Remove-Item -LiteralPath $installRootResolved -Recurse -Force
        $newMoved = $false
      } catch {
        throw "New install failed and could not be safely removed. The install path was preserved where possible. install=$installRootResolved; reason=$($_.Exception.Message)"
      }
    }
    throw
  }

  if ($envBackup -and (Test-Path -LiteralPath $envBackup -PathType Leaf)) {
    Remove-Item -LiteralPath $envBackup -Force
  }
  Write-Host ""
  if ($updateMode) {
    Write-Host "BLUE-TANUKI updated to $version."
    Write-Host "Rollback version retained at: $previousInstallRoot"
  } else {
    Write-Host "BLUE-TANUKI installed."
  }
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
