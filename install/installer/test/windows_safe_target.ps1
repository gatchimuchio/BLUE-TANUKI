$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../windows/safe-target.ps1")

$tempRoot = Join-Path $env:TEMP ("blue-tanuki-safe-target-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  $safeTarget = Resolve-SafeDirectoryTarget (Join-Path $tempRoot "not-created\app") "fixture"
  if ($safeTarget -ne [System.IO.Path]::GetFullPath((Join-Path $tempRoot "not-created\app"))) {
    throw "nonexistent target parent was not normalized consistently"
  }

  $rejected = $false
  try {
    Assert-SafeInstallTargets -InstallRoot $env:USERPROFILE -DataRoot (Join-Path $tempRoot "data") -SourceRoot $tempRoot | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "user-profile install target was accepted" }

  foreach ($broadTarget in @(
    [System.Environment]::GetFolderPath('ProgramFiles'),
    [System.Environment]::GetFolderPath('ProgramFilesX86'),
    [System.Environment]::GetFolderPath('CommonApplicationData'),
    $env:SystemRoot,
    (Join-Path $env:USERPROFILE "Public")
  ) | Where-Object { $_ }) {
    $rejected = $false
    try {
      Assert-SafeInstallTargets -InstallRoot $broadTarget -DataRoot (Join-Path $tempRoot ("data-" + [Guid]::NewGuid().ToString("N"))) -SourceRoot $tempRoot | Out-Null
    } catch { $rejected = $true }
    if (-not $rejected) { throw "broad install target was accepted: $broadTarget" }
  }

  $rejected = $false
  try {
    Resolve-SafeDirectoryTarget -Path "\\?\$($env:SystemDrive)\temp\blue-tanuki" -Label "device-path" | Out-Null
  } catch { $rejected = $true }
  if (-not $rejected) { throw "Windows device path was accepted" }

  $rejected = $false
  try {
    Assert-SafeInstallTargets -InstallRoot (Join-Path $tempRoot "shared") -DataRoot (Join-Path $tempRoot "shared\data") -SourceRoot (Join-Path $tempRoot "source") | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "overlapping install/data targets were accepted" }

  $actual = Join-Path $tempRoot "actual"
  New-Item -ItemType Directory -Path $actual | Out-Null
  $junction = Join-Path $tempRoot "alias"
  New-Item -ItemType Junction -Path $junction -Target $actual | Out-Null
  $rejected = $false
  try {
    Resolve-SafeDirectoryTarget (Join-Path $junction "install") "reparse fixture" | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "reparse-point target was accepted" }

  $productInstall = Join-Path $tempRoot "product-app"
  $productData = Join-Path $tempRoot "product-data"
  $requiredFiles = @(
    "apps\gateway\dist\main.js",
    "package.json",
    "BlueTanuki.cmd",
    "BlueTanukiLauncher.ps1",
    "BlueTanukiUninstall.ps1",
    "UninstallBlueTanuki.cmd"
  )
  foreach ($relative in $requiredFiles) {
    $path = Join-Path $productInstall $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    Set-Content -LiteralPath $path -Value "fixture" -Encoding UTF8
  }
  $installedGuard = Join-Path $productInstall "install\windows\safe-target.ps1"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installedGuard) | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../../windows/safe-target.ps1") -Destination $installedGuard
  Set-Content -LiteralPath (Join-Path $productInstall "BlueTanukiLauncher.ps1") -Value 'param([string]$Command)' -Encoding UTF8
  $runtimeExe = Join-Path $productInstall "runtime\node-v-test\node.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeExe) | Out-Null
  Set-Content -LiteralPath $runtimeExe -Value "fixture" -Encoding ASCII
  $manifestPath = Join-Path $productInstall "blue-tanuki-package-manifest.json"
  $manifest = [ordered]@{ schema_version = 1; name = "blue-tanuki"; package_type = "windows-x64-zip-installer" }
  $manifest | ConvertTo-Json -Compress | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifestHash = Get-Sha256HexFromFile -Path $manifestPath
  $managedFilesHash = Write-ManagedTreeInventory -Root $productInstall `
    -MetadataFileName "blue-tanuki-install.json" -InventoryFileName "blue-tanuki-managed-files.json" `
    -ProductId "blue-tanuki-product-install"
  $metadata = [ordered]@{
    schema_version = 3
    product_id = "blue-tanuki-product-install"
    install_root = $productInstall
    data_root = $productData
    package_manifest_sha256 = $manifestHash
    managed_files_sha256 = $managedFilesHash
  }
  $metadata | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $productInstall "blue-tanuki-install.json") -Encoding UTF8
  $dataMarker = [ordered]@{
    schema_version = 1
    product_id = "blue-tanuki-product-data"
    install_root = $productInstall
    data_root = $productData
  }
  New-Item -ItemType Directory -Path $productData | Out-Null
  $dataMarker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $productData "blue-tanuki-product-data.json") -Encoding UTF8
  $userData = Join-Path $productData "owner-data.txt"
  Set-Content -LiteralPath $userData -Value "preserve through ordinary uninstall" -Encoding UTF8

  $rollbackOne = Join-Path $tempRoot (".product-app.blue-tanuki-rollback-" + [Guid]::NewGuid().ToString("N"))
  $rollbackTwo = Join-Path $tempRoot (".product-app.blue-tanuki-rollback-" + [Guid]::NewGuid().ToString("N"))
  Copy-Item -LiteralPath $productInstall -Destination $rollbackOne -Recurse
  Copy-Item -LiteralPath $productInstall -Destination $rollbackTwo -Recurse
  Remove-Item -LiteralPath $productInstall -Recurse -Force
  $recoveryRejected = $false
  try {
    [void](Restore-InterruptedWindowsProductUpdate -InstallRoot $productInstall -DataRoot $productData)
  } catch {
    $recoveryRejected = $_.Exception.Message -match 'Multiple interrupted product-update rollback candidates'
  }
  if (-not $recoveryRejected -or (Test-Path -LiteralPath $productInstall) -or
      -not (Test-Path -LiteralPath $rollbackOne -PathType Container) -or
      -not (Test-Path -LiteralPath $rollbackTwo -PathType Container) -or
      (Get-Content -LiteralPath $userData -Raw).Trim() -ne 'preserve through ordinary uninstall') {
    throw 'Ambiguous interrupted-update recovery moved a candidate or changed user data.'
  }
  Remove-Item -LiteralPath $rollbackTwo -Recurse -Force
  $recovered = Restore-InterruptedWindowsProductUpdate -InstallRoot $productInstall -DataRoot $productData
  if (-not $recovered -or -not (Test-Path -LiteralPath $productInstall -PathType Container) -or
      (Test-Path -LiteralPath $rollbackOne) -or
      (Assert-ManagedWindowsProductInstall -InstallRoot $productInstall -DataRoot $productData) -ne 'managed-v3' -or
      (Get-Content -LiteralPath $userData -Raw).Trim() -ne 'preserve through ordinary uninstall') {
    throw 'A single verified interrupted-update rollback candidate was not restored safely.'
  }

  $managed = Assert-ManagedWindowsProductInstall -InstallRoot $productInstall -DataRoot $productData
  if ($managed -ne "managed-v3") { throw "managed Windows product install classification was unexpected: $managed" }
  $managedData = Assert-ManagedWindowsProductData -DataRoot $productData -InstallRoot $productInstall
  if ($managedData -ne "managed-v1") { throw "managed Windows product data classification was unexpected: $managedData" }
  Set-Content -LiteralPath (Join-Path $productInstall "unrelated-user-file.txt") -Value "preserve" -Encoding UTF8
  $rejected = $false
  try { Assert-ManagedWindowsProductInstall -InstallRoot $productInstall -DataRoot $productData | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw "product install with an unlisted user file was accepted" }
  Remove-Item -LiteralPath (Join-Path $productInstall "unrelated-user-file.txt") -Force
  $managedFile = Join-Path $productInstall "apps\gateway\dist\main.js"
  $managedFileBackup = [System.IO.File]::ReadAllBytes($managedFile)
  try {
    [System.IO.File]::AppendAllText($managedFile, "tampered")
    $rejected = $false
    try { Assert-ManagedWindowsProductInstall -InstallRoot $productInstall -DataRoot $productData | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "product install with a changed managed file was accepted" }
  } finally {
    [System.IO.File]::WriteAllBytes($managedFile, $managedFileBackup)
  }
  $metadata.install_root = Join-Path $tempRoot "different-install"
  $metadata | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $productInstall "blue-tanuki-install.json") -Encoding UTF8
  $rejected = $false
  try { Assert-ManagedWindowsProductInstall -InstallRoot $productInstall -DataRoot $productData | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw "mismatched product install owner marker was accepted" }

  $developmentInstall = Join-Path $tempRoot "development-app"
  $developmentData = Join-Path $tempRoot "development-data"
  foreach ($relative in @("package.json", "apps\gateway\dist\main.js", "install\windows\install.ps1")) {
    $path = Join-Path $developmentInstall $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    Set-Content -LiteralPath $path -Value "fixture" -Encoding UTF8
  }
  foreach ($relative in @("blue-tanuki.env", "bin\blue-tanuki.ps1", "bin\blue-tanuki.cmd")) {
    $path = Join-Path $developmentData $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    Set-Content -LiteralPath $path -Value "fixture" -Encoding UTF8
  }
  $developmentUserData = Join-Path $developmentData "state\owner-data.txt"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $developmentUserData) | Out-Null
  Set-Content -LiteralPath $developmentUserData -Value "preserve through ordinary uninstall" -Encoding UTF8
  $developmentDataMarker = [ordered]@{
    schema_version = 1
    product_id = "blue-tanuki-development-data"
    install_root = $developmentInstall
    data_root = $developmentData
    launcher_path = Join-Path $developmentData "bin\blue-tanuki.ps1"
    launcher_sha256 = Get-Sha256HexFromFile -Path (Join-Path $developmentData "bin\blue-tanuki.ps1")
    cmd_launcher_path = Join-Path $developmentData "bin\blue-tanuki.cmd"
    cmd_launcher_sha256 = Get-Sha256HexFromFile -Path (Join-Path $developmentData "bin\blue-tanuki.cmd")
  }
  $developmentDataMarker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $developmentData "blue-tanuki-development-data.json") -Encoding UTF8
  $launcherPath = Join-Path $developmentData "bin\blue-tanuki.ps1"
  $launcherBackup = [System.IO.File]::ReadAllBytes($launcherPath)
  try {
    [System.IO.File]::AppendAllText($launcherPath, "tampered")
    $rejected = $false
    try { Assert-ManagedWindowsDevelopmentData -DataRoot $developmentData -InstallRoot $developmentInstall | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "development uninstall accepted a changed data-root launcher" }
  } finally {
    [System.IO.File]::WriteAllBytes($launcherPath, $launcherBackup)
  }
  $developmentMarker = [ordered]@{
    schema_version = 2
    product_id = "blue-tanuki-development-install"
    install_root = $developmentInstall
    data_root = $developmentData
    managed_files_sha256 = Write-ManagedTreeInventory -Root $developmentInstall `
      -MetadataFileName "blue-tanuki-development-install.json" -InventoryFileName "blue-tanuki-managed-files.json" `
      -ProductId "blue-tanuki-development-install"
  }
  $developmentMarker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $developmentInstall "blue-tanuki-development-install.json") -Encoding UTF8
  $devClass = Assert-ManagedWindowsDevelopmentInstall -InstallRoot $developmentInstall -DataRoot $developmentData
  if ($devClass -ne "managed-v2") { throw "managed Windows development install classification was unexpected: $devClass" }
  Set-Content -LiteralPath (Join-Path $developmentInstall "unrelated-user-file.txt") -Value "preserve" -Encoding UTF8
  $rejected = $false
  try { Assert-ManagedWindowsDevelopmentInstall -InstallRoot $developmentInstall -DataRoot $developmentData | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw "development install with an unlisted user file was accepted" }
  Remove-Item -LiteralPath (Join-Path $developmentInstall "unrelated-user-file.txt") -Force
  $developmentMarker.data_root = Join-Path $tempRoot "different-data"
  $developmentMarker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $developmentInstall "blue-tanuki-development-install.json") -Encoding UTF8
  $rejected = $false
  try { Assert-ManagedWindowsDevelopmentInstall -InstallRoot $developmentInstall -DataRoot $developmentData | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw "mismatched development uninstall target was accepted" }
  $developmentMarker.data_root = $developmentData
  $developmentMarker | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $developmentInstall "blue-tanuki-development-install.json") -Encoding UTF8

  $developmentUninstall = Join-Path $PSScriptRoot "../../windows/uninstall.ps1"
  $dryRunOutput = (& powershell.exe -NoProfile -NonInteractive -File $developmentUninstall -InstallRoot $developmentInstall -DataRoot $developmentData -DryRun 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $dryRunOutput -notmatch "Would remove app:") {
    throw "owned Windows development uninstall dry-run failed: $dryRunOutput"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $developmentInstall "apps\gateway\dist\main.js")) -or
      -not (Test-Path -LiteralPath (Join-Path $developmentData "blue-tanuki.env"))) {
    throw "Windows development uninstall dry-run changed fixture contents"
  }

  $launcherBytes = [System.IO.File]::ReadAllBytes($launcherPath)
  try {
    [System.IO.File]::AppendAllText($launcherPath, "tampered after install")
    $rejectedPurgeStdout = Join-Path $tempRoot "development-purge-rejected.stdout.txt"
    $rejectedPurgeStderr = Join-Path $tempRoot "development-purge-rejected.stderr.txt"
    $rejectedPurgeProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-File", $developmentUninstall,
      "-InstallRoot", $developmentInstall, "-DataRoot", $developmentData, "-Purge") -PassThru -Wait -NoNewWindow `
        -RedirectStandardOutput $rejectedPurgeStdout -RedirectStandardError $rejectedPurgeStderr
    $rejectedPurgeOutput = (Get-Content -LiteralPath $rejectedPurgeStdout -Raw) + (Get-Content -LiteralPath $rejectedPurgeStderr -Raw)
    if ($rejectedPurgeProcess.ExitCode -eq 0 -or $rejectedPurgeOutput -notmatch "No files were changed" -or
        -not (Test-Path -LiteralPath (Join-Path $developmentInstall "apps\gateway\dist\main.js")) -or
        -not (Test-Path -LiteralPath (Join-Path $developmentData "blue-tanuki.env")) -or
        -not (Test-Path -LiteralPath $developmentUserData)) {
      throw "Windows development purge did not fail closed before changing app or user data: $rejectedPurgeOutput"
    }
  } finally {
    [System.IO.File]::WriteAllBytes($launcherPath, $launcherBytes)
  }

  $developmentUninstallStdout = Join-Path $tempRoot "development-uninstall.stdout.txt"
  $developmentUninstallStderr = Join-Path $tempRoot "development-uninstall.stderr.txt"
  $developmentUninstallProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-File", $developmentUninstall,
    "-InstallRoot", $developmentInstall, "-DataRoot", $developmentData) -PassThru -Wait -NoNewWindow `
      -RedirectStandardOutput $developmentUninstallStdout -RedirectStandardError $developmentUninstallStderr
  $uninstallOutput = (Get-Content -LiteralPath $developmentUninstallStdout -Raw) + (Get-Content -LiteralPath $developmentUninstallStderr -Raw)
  if ($developmentUninstallProcess.ExitCode -ne 0 -or (Test-Path -LiteralPath $developmentInstall) -or
      -not (Test-Path -LiteralPath (Join-Path $developmentData "blue-tanuki.env")) -or
      (Get-Content -LiteralPath $developmentUserData -Raw).Trim() -ne "preserve through ordinary uninstall" -or
      (Test-Path -LiteralPath $launcherPath) -or
      (Test-Path -LiteralPath (Join-Path $developmentData "bin\blue-tanuki.cmd")) -or
      (Test-Path -LiteralPath (Join-Path $developmentData "blue-tanuki-development-data.json"))) {
    throw "Windows development uninstall did not remove only the owned app and launchers while retaining user data: $uninstallOutput"
  }

  $productUninstaller = Join-Path $PSScriptRoot "../../windows/product/BlueTanukiUninstall.ps1"
  $testAppData = Join-Path $tempRoot "isolated-appdata"
  New-Item -ItemType Directory -Path $testAppData | Out-Null
  $previousAppData = $env:APPDATA
  $previousUninstallStatus = $env:BLUE_TANUKI_UNINSTALL_STATUS_FILE
  $previousStagedGuard = $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET
  $env:APPDATA = $testAppData
  $env:BLUE_TANUKI_UNINSTALL_STATUS_FILE = ""
  try {
    $unlistedFile = Join-Path $productInstall "owner-added-file.txt"
    Set-Content -LiteralPath $unlistedFile -Value "preserve" -Encoding UTF8
    $rejectedStagedGuard = Join-Path $env:TEMP ("BlueTanukiSafeTarget-" + [Guid]::NewGuid().ToString("N") + ".ps1")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../../windows/safe-target.ps1") -Destination $rejectedStagedGuard
    $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET = $rejectedStagedGuard
    $rejectedStdout = Join-Path $tempRoot "product-uninstall-rejected.stdout.txt"
    $rejectedStderr = Join-Path $tempRoot "product-uninstall-rejected.stderr.txt"
    $rejectedProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-File", $productUninstaller,
      "-InstallRoot", $productInstall, "-DataRoot", $productData, "-Quiet") -PassThru -Wait -NoNewWindow `
        -RedirectStandardOutput $rejectedStdout -RedirectStandardError $rejectedStderr
    $rejectedOutput = (Get-Content -LiteralPath $rejectedStdout -Raw) + (Get-Content -LiteralPath $rejectedStderr -Raw)
    if ($rejectedProcess.ExitCode -eq 0 -or $rejectedOutput -notmatch "No files were changed" -or
        -not (Test-Path -LiteralPath $productInstall -PathType Container) -or
        -not (Test-Path -LiteralPath $unlistedFile -PathType Leaf) -or
        -not (Test-Path -LiteralPath $userData -PathType Leaf)) {
      throw "Windows product uninstall did not fail closed with an unlisted app file: $rejectedOutput"
    }

    Remove-Item -LiteralPath $unlistedFile -Force
    $metadata.install_root = $productInstall
    $metadata | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $productInstall "blue-tanuki-install.json") -Encoding UTF8
    $successStagedGuard = Join-Path $env:TEMP ("BlueTanukiSafeTarget-" + [Guid]::NewGuid().ToString("N") + ".ps1")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../../windows/safe-target.ps1") -Destination $successStagedGuard
    $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET = $successStagedGuard
    $successStdout = Join-Path $tempRoot "product-uninstall-success.stdout.txt"
    $successStderr = Join-Path $tempRoot "product-uninstall-success.stderr.txt"
    $successProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-File", $productUninstaller,
      "-InstallRoot", $productInstall, "-DataRoot", $productData, "-Quiet") -PassThru -Wait -NoNewWindow `
        -RedirectStandardOutput $successStdout -RedirectStandardError $successStderr
    if ($successProcess.ExitCode -ne 0) {
      $successOutput = (Get-Content -LiteralPath $successStdout -Raw) + (Get-Content -LiteralPath $successStderr -Raw)
      throw "Windows product uninstall failed for the owned fixture: exit=$($successProcess.ExitCode) $successOutput"
    }
    if (Test-Path -LiteralPath $productInstall) {
      throw "Windows product uninstall left the owned app fixture behind"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $productData "blue-tanuki-product-data.json") -PathType Leaf) -or
        -not (Test-Path -LiteralPath $userData -PathType Leaf) -or
        (Get-Content -LiteralPath $userData -Raw).Trim() -ne "preserve through ordinary uninstall") {
      throw "Windows product uninstall did not preserve user data without explicit purge"
    }
  } finally {
    $env:APPDATA = $previousAppData
    $env:BLUE_TANUKI_UNINSTALL_STATUS_FILE = $previousUninstallStatus
    $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET = $previousStagedGuard
  }

  Write-Output "windows_target_guard=pass"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
