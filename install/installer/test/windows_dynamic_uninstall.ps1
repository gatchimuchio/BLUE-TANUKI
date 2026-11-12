$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$safeTargetSource = Join-Path $repoRoot 'install/windows/safe-target.ps1'
$installedUninstaller = Join-Path $repoRoot 'install/windows/product/BlueTanukiUninstall.ps1'
$installedWrapper = Join-Path $repoRoot 'install/windows/product/UninstallBlueTanuki.cmd'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('blue-tanuki-dynamic-uninstall-' + [Guid]::NewGuid().ToString('N'))
$generatedStatusFiles = [System.Collections.Generic.List[string]]::new()
$environmentNames = @(
  'BLUE_TANUKI_UNINSTALL_STATUS_FILE',
  'BLUE_TANUKI_UNINSTALL_SAFE_TARGET',
  'BLUE_TANUKI_UNINSTALL_TEMP_HELPER',
  'BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT',
  'BLUE_TANUKI_NO_PAUSE',
  'BT_DYNAMIC_UNINSTALL_MODE',
  'BT_DYNAMIC_UNINSTALL_INSTALL_ROOT',
  'BT_DYNAMIC_UNINSTALL_DATA_ROOT',
  'BT_DYNAMIC_UNINSTALL_ADDED_FILE',
  'BT_DYNAMIC_UNINSTALL_JUNCTION',
  'BT_DYNAMIC_UNINSTALL_OUTSIDE_ROOT'
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

. $safeTargetSource

function New-ManagedProductFixture {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot
  )

  New-Item -ItemType Directory -Path $InstallRoot, $DataRoot -Force | Out-Null
  foreach ($relativePath in @(
    'apps\gateway\dist\main.js',
    'package.json',
    'BlueTanuki.cmd',
    'BlueTanukiUninstall.ps1',
    'UninstallBlueTanuki.cmd',
    'runtime\node-v-test\node.exe'
  )) {
    $path = Join-Path $InstallRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    Set-Content -LiteralPath $path -Value 'isolated dynamic uninstall fixture' -Encoding UTF8
  }

  $installedGuard = Join-Path $InstallRoot 'install\windows\safe-target.ps1'
  New-Item -ItemType Directory -Path (Split-Path -Parent $installedGuard) -Force | Out-Null
  Copy-Item -LiteralPath $safeTargetSource -Destination $installedGuard
  Copy-Item -LiteralPath $installedUninstaller -Destination (Join-Path $InstallRoot 'BlueTanukiUninstall.ps1') -Force
  Copy-Item -LiteralPath $installedWrapper -Destination (Join-Path $InstallRoot 'UninstallBlueTanuki.cmd') -Force

  $launcher = Join-Path $InstallRoot 'BlueTanukiLauncher.ps1'
  @'
param([string]$Command)
if ($Command -eq 'stop') {
  if ($env:BT_DYNAMIC_UNINSTALL_MODE -eq 'install-addition') {
    [System.IO.File]::WriteAllText($env:BT_DYNAMIC_UNINSTALL_ADDED_FILE, 'owner data added while stopping')
  }
  if ($env:BT_DYNAMIC_UNINSTALL_MODE -eq 'data-junction') {
    New-Item -ItemType Junction -Path $env:BT_DYNAMIC_UNINSTALL_JUNCTION -Target $env:BT_DYNAMIC_UNINSTALL_OUTSIDE_ROOT | Out-Null
  }
}
exit 0
'@ | Set-Content -LiteralPath $launcher -Encoding UTF8

  $manifestPath = Join-Path $InstallRoot 'blue-tanuki-package-manifest.json'
  [ordered]@{
    schema_version = 1
    name = 'blue-tanuki'
    package_type = 'windows-x64-zip-installer'
    version = '1.0.0-test'
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifestHash = Get-Sha256HexFromFile -Path $manifestPath
  $managedFilesHash = Write-ManagedTreeInventory -Root $InstallRoot `
    -MetadataFileName 'blue-tanuki-install.json' -InventoryFileName 'blue-tanuki-managed-files.json' `
    -ProductId 'blue-tanuki-product-install'
  [ordered]@{
    schema_version = 3
    product_id = 'blue-tanuki-product-install'
    install_root = $InstallRoot
    data_root = $DataRoot
    package_manifest_sha256 = $manifestHash
    managed_files_sha256 = $managedFilesHash
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $InstallRoot 'blue-tanuki-install.json') -Encoding UTF8

  [ordered]@{
    schema_version = 1
    product_id = 'blue-tanuki-product-data'
    install_root = $InstallRoot
    data_root = $DataRoot
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $DataRoot 'blue-tanuki-product-data.json') -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $DataRoot 'owner-data.txt') -Value 'retain this isolated data' -Encoding UTF8
}

function Invoke-IsolatedUninstall {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$Mode,
    [switch]$PurgeData
  )

  $statusPath = Join-Path ([IO.Path]::GetTempPath()) ('BlueTanukiUninstall-' + [Guid]::NewGuid().ToString('N') + '.status')
  $generatedStatusFiles.Add($statusPath)
  $env:BLUE_TANUKI_UNINSTALL_STATUS_FILE = $statusPath
  $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET = ''
  $env:BLUE_TANUKI_UNINSTALL_TEMP_HELPER = ''
  $env:BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT = ''
  $env:BLUE_TANUKI_NO_PAUSE = '1'
  $env:BT_DYNAMIC_UNINSTALL_MODE = $Mode
  $env:BT_DYNAMIC_UNINSTALL_INSTALL_ROOT = $InstallRoot
  $env:BT_DYNAMIC_UNINSTALL_DATA_ROOT = $DataRoot
  $env:BT_DYNAMIC_UNINSTALL_ADDED_FILE = Join-Path $InstallRoot 'owner-added-during-stop.txt'
  $env:BT_DYNAMIC_UNINSTALL_JUNCTION = Join-Path $DataRoot 'external-data-link'
  $env:BT_DYNAMIC_UNINSTALL_OUTSIDE_ROOT = Join-Path (Split-Path -Parent $DataRoot) 'outside-data'

  $wrapper = Join-Path $InstallRoot 'UninstallBlueTanuki.cmd'
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if ($PurgeData) {
      & $wrapper '-PurgeData' *> $null
    } else {
      & $wrapper *> $null
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $statusText = if (Test-Path -LiteralPath $statusPath -PathType Leaf) { Get-Content -LiteralPath $statusPath -Raw } else { '' }
  if (Test-Path -LiteralPath $statusPath -PathType Leaf) { Remove-Item -LiteralPath $statusPath -Force }
  return [pscustomobject]@{ exitCode = $exitCode; statusText = $statusText }
}

$temporaryJunction = $null
try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

  $installChangeRoot = Join-Path $temporaryRoot 'install-change'
  $installChangeInstall = Join-Path $installChangeRoot 'app'
  $installChangeData = Join-Path $installChangeRoot 'data'
  New-ManagedProductFixture -InstallRoot $installChangeInstall -DataRoot $installChangeData
  $installAddition = Join-Path $installChangeInstall 'owner-added-during-stop.txt'
  $installChange = Invoke-IsolatedUninstall -InstallRoot $installChangeInstall -DataRoot $installChangeData -Mode 'install-addition'
  if ($installChange.statusText.Trim() -ne 'exit_code=1' -or
      -not (Test-Path -LiteralPath $installChangeInstall -PathType Container) -or
      -not (Test-Path -LiteralPath $installAddition -PathType Leaf) -or
      -not (Test-Path -LiteralPath $installChangeData -PathType Container)) {
    throw ('A product-install change during resident shutdown was not rejected with all install/data files preserved. exit={0}; status={1}; install={2}; added={3}; data={4}' -f `
      $installChange.exitCode, $installChange.statusText.Trim(),
      (Test-Path -LiteralPath $installChangeInstall -PathType Container),
      (Test-Path -LiteralPath $installAddition -PathType Leaf),
      (Test-Path -LiteralPath $installChangeData -PathType Container))
  }
  Write-Output 'dynamic_install_change_result=pass'

  $purgeRoot = Join-Path $temporaryRoot 'purge-change'
  $purgeInstall = Join-Path $purgeRoot 'app'
  $purgeData = Join-Path $purgeRoot 'data'
  $outsideRoot = Join-Path $purgeRoot 'outside-data'
  New-ManagedProductFixture -InstallRoot $purgeInstall -DataRoot $purgeData
  New-Item -ItemType Directory -Path $outsideRoot | Out-Null
  $outsideSentinel = Join-Path $outsideRoot 'must-remain.txt'
  Set-Content -LiteralPath $outsideSentinel -Value 'outside the product data root' -Encoding UTF8
  $purgeChange = Invoke-IsolatedUninstall -InstallRoot $purgeInstall -DataRoot $purgeData -Mode 'data-junction' -PurgeData
  $temporaryJunction = Join-Path $purgeData 'external-data-link'
  $junctionItem = if (Test-Path -LiteralPath $temporaryJunction) { Get-Item -Force -LiteralPath $temporaryJunction } else { $null }
  if ($purgeChange.statusText.Trim() -ne 'exit_code=1' -or
      -not (Test-Path -LiteralPath $purgeInstall -PathType Container) -or
      -not (Test-Path -LiteralPath $purgeData -PathType Container) -or
      -not (Test-Path -LiteralPath (Join-Path $purgeData 'owner-data.txt') -PathType Leaf) -or
      -not (Test-Path -LiteralPath $outsideSentinel -PathType Leaf) -or
      -not $junctionItem -or (($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
    throw 'A DataRoot junction created during resident shutdown was not rejected before removing any product/data files.'
  }
  Write-Output 'dynamic_data_reparse_result=pass'
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
  }
  if ($temporaryJunction -and (Test-Path -LiteralPath $temporaryJunction)) {
    $item = Get-Item -Force -LiteralPath $temporaryJunction
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      [System.IO.Directory]::Delete($temporaryJunction, $false)
    }
  }
  foreach ($statusPath in $generatedStatusFiles) {
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) { Remove-Item -LiteralPath $statusPath -Force }
  }
  if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -Confirm:$false
  }
}

if (Test-Path -LiteralPath $temporaryRoot) { throw 'The isolated dynamic uninstall fixture was not cleaned up.' }
Write-Output 'dynamic_fixture_cleanup=pass'
