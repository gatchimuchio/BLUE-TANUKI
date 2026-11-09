Set-StrictMode -Version Latest

function Resolve-SafeDirectoryTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$AllowReparse
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label is empty."
  }
  if ($Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\')) {
    throw "$Label uses a Windows device path, which is not allowed: $Path"
  }
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^\\\\[^\\]+\\[^\\]+(?:\\|$)') {
    throw "$Label must be a fully qualified drive or UNC path: $Path"
  }

  $normalized = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($normalized)
  if (-not $root) {
    throw "$Label has no filesystem root: $Path"
  }

  $tail = $normalized.Substring($root.Length).Trim([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $segments = @()
  if ($tail) {
    $segments = @($tail -split '[\\/]')
  }
  $current = $root
  for ($index = 0; $index -lt $segments.Count; $index++) {
    $candidate = Join-Path $current $segments[$index]
    if (-not (Test-Path -LiteralPath $candidate)) {
      for ($rest = $index + 1; $rest -lt $segments.Count; $rest++) {
        $candidate = Join-Path $candidate $segments[$rest]
      }
      $current = $candidate
      break
    }

    $item = Get-Item -Force -LiteralPath $candidate
    if (-not $AllowReparse -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label traverses a reparse point: $candidate"
    }
    if (-not $item.PSIsContainer) {
      throw "$Label traverses a file instead of a directory: $candidate"
    }
    $current = $item.FullName
  }

  $resolved = [System.IO.Path]::GetFullPath($current)
  $resolvedRoot = [System.IO.Path]::GetPathRoot($resolved)
  if ($resolved.Length -gt $resolvedRoot.Length) {
    $resolved = $resolved.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  }
  return $resolved
}

function Test-SameOrDescendantPath {
  param([string]$Candidate, [string]$Parent)
  $candidatePath = $Candidate.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $parentPath = $Parent.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ([string]::Equals($candidatePath, $parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
  return $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-InstallPathIdentity {
  param([Parameter(Mandatory = $true)][string]$Path)
  $normalized = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($normalized)
  if ($normalized.Length -gt $root.Length) {
    $normalized = $normalized.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  }
  return $normalized
}

function Get-Sha256HexFromFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Assert-NoReparsePointsInTree {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $root = Resolve-SafeDirectoryTarget -Path $Path -Label $Label
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
  try {
    $items = @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
  } catch {
    throw "$Label could not be inspected without following uncertain contents: $root"
  }
  foreach ($item in $items) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point; refusing recursive operation: $($item.FullName)"
    }
  }
}

function Assert-ExpectedRegularFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths,
    [Parameter(Mandatory = $true)][string]$Label
  )
  foreach ($relativePath in $RelativePaths) {
    $candidate = Join-Path $Root $relativePath
    $parent = Split-Path -Parent $candidate
    [void](Resolve-SafeDirectoryTarget -Path $parent -Label "$Label path parent")
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "$Label is missing required file: $relativePath"
    }
    $item = Get-Item -Force -LiteralPath $candidate
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label required file is not a regular file: $relativePath"
    }
  }
}

function Get-ManagedTreeInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$MetadataFileName,
    [Parameter(Mandatory = $true)][string]$InventoryFileName
  )
  $resolvedRoot = Resolve-SafeDirectoryTarget -Path $Root -Label 'ManagedTreeRoot'
  Assert-NoReparsePointsInTree -Path $resolvedRoot -Label 'ManagedTreeRoot'
  $metadataKey = $MetadataFileName.ToLowerInvariant()
  $inventoryKey = $InventoryFileName.ToLowerInvariant()
  $entries = @()
  foreach ($item in @(Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse -ErrorAction Stop)) {
    $relativePath = $item.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    $pathKey = $relativePath.ToLowerInvariant()
    if ($pathKey -eq $metadataKey -or $pathKey -eq $inventoryKey) { continue }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Managed tree contains a reparse point: $($item.FullName)"
    }
    if ($item.PSIsContainer) {
      $entries += [ordered]@{ path = $pathKey; kind = 'directory'; length = 0; sha256 = '' }
    } else {
      $entries += [ordered]@{ path = $pathKey; kind = 'file'; length = [Int64]$item.Length; sha256 = Get-Sha256HexFromFile -Path $item.FullName }
    }
  }
  return ,@($entries | Sort-Object -Property path)
}

function Write-ManagedTreeInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$MetadataFileName,
    [Parameter(Mandatory = $true)][string]$InventoryFileName,
    [Parameter(Mandatory = $true)][string]$ProductId
  )
  $resolvedRoot = Resolve-SafeDirectoryTarget -Path $Root -Label 'ManagedTreeRoot'
  $inventoryPath = Join-Path $resolvedRoot $InventoryFileName
  $entries = Get-ManagedTreeInventory -Root $resolvedRoot -MetadataFileName $MetadataFileName -InventoryFileName $InventoryFileName
  $document = [ordered]@{ schema_version = 1; product_id = $ProductId; entries = @($entries) }
  $document | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
  return Get-Sha256HexFromFile -Path $inventoryPath
}

function Assert-ManagedTreeInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$MetadataFileName,
    [Parameter(Mandatory = $true)][string]$InventoryFileName,
    [Parameter(Mandatory = $true)][string]$ProductId,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )
  if ($ExpectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'Managed tree inventory digest is missing or invalid.'
  }
  $resolvedRoot = Resolve-SafeDirectoryTarget -Path $Root -Label 'ManagedTreeRoot'
  $inventoryPath = Join-Path $resolvedRoot $InventoryFileName
  if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) {
    throw "Managed tree inventory is missing: $inventoryPath"
  }
  $inventoryItem = Get-Item -Force -LiteralPath $inventoryPath
  if (($inventoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $inventoryItem.Length -gt 67108864) {
    throw "Managed tree inventory is not a bounded regular file: $inventoryPath"
  }
  if (-not [string]::Equals((Get-Sha256HexFromFile -Path $inventoryPath), $ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Managed tree inventory digest does not match install metadata.'
  }
  try { $document = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json } catch {
    throw "Managed tree inventory is invalid: $inventoryPath"
  }
  if ($null -eq $document -or $document.schema_version -ne 1 -or $document.product_id -ne $ProductId -or
      $null -eq $document.entries -or $document.entries -is [string]) {
    throw "Managed tree inventory does not identify $ProductId."
  }
  $expected = @($document.entries | ForEach-Object {
    $path = [string]$_.path
    $segments = @($path -split '/')
    if ([string]$_.kind -notin @('directory', 'file') -or [string]::IsNullOrWhiteSpace($path) -or
        $path.StartsWith('/') -or $path.Contains('\') -or $path.Contains(':') -or
        $segments.Count -eq 0 -or @($segments | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
        $path -cne $path.ToLowerInvariant()) {
      throw 'Managed tree inventory contains an invalid entry.'
    }
    if ($_.kind -eq 'file') {
      if ([Int64]$_.length -lt 0 -or [string]$_.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Managed tree inventory contains an invalid file entry.'
      }
      'file|' + [string]$_.path + '|' + [string]$_.length + '|' + ([string]$_.sha256).ToLowerInvariant()
    } else {
      'directory|' + [string]$_.path
    }
  } | Sort-Object)
  if (($expected | Select-Object -Unique).Count -ne $expected.Count) {
    throw 'Managed tree inventory contains duplicate paths.'
  }
  $actualEntries = Get-ManagedTreeInventory -Root $resolvedRoot -MetadataFileName $MetadataFileName -InventoryFileName $InventoryFileName
  $actual = @($actualEntries | ForEach-Object {
    if ($_.kind -eq 'file') { 'file|' + $_.path + '|' + [string]$_.length + '|' + ([string]$_.sha256).ToLowerInvariant() }
    else { 'directory|' + $_.path }
  } | Sort-Object)
  if ($actual.Count -ne $expected.Count) { throw 'Managed tree contents differ from the installed-file inventory.' }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    if (-not [string]::Equals($actual[$index], $expected[$index], [System.StringComparison]::Ordinal)) {
      throw 'Managed tree contents differ from the installed-file inventory.'
    }
  }
}

function Assert-ManagedWindowsProductInstall {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$MetadataInstallRoot
  )
  $install = Resolve-SafeDirectoryTarget -Path $InstallRoot -Label 'ProductInstallRoot'
  $data = Resolve-SafeDirectoryTarget -Path $DataRoot -Label 'ProductDataRoot'
  if ([string]::IsNullOrWhiteSpace($MetadataInstallRoot)) { $MetadataInstallRoot = $install }
  if (-not (Test-Path -LiteralPath $install -PathType Container)) {
    throw "Product install root is missing: $install"
  }
  Assert-NoReparsePointsInTree -Path $install -Label 'ProductInstallRoot'

  $metadataPath = Join-Path $install 'blue-tanuki-install.json'
  if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Product install ownership metadata is missing: $metadataPath"
  }
  $metadataItem = Get-Item -Force -LiteralPath $metadataPath
  if (($metadataItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $metadataItem.Length -gt 65536) {
    throw "Product install ownership metadata is not a bounded regular file: $metadataPath"
  }
  try { $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json } catch {
    throw "Product install ownership metadata is invalid: $metadataPath"
  }
  if ($null -eq $metadata -or
      [string]::IsNullOrWhiteSpace([string]$metadata.install_root) -or
      [string]::IsNullOrWhiteSpace([string]$metadata.data_root)) {
    throw "Product install ownership metadata is incomplete: $metadataPath"
  }
  if (-not [string]::Equals((Get-InstallPathIdentity ([string]$metadata.install_root)), (Get-InstallPathIdentity $MetadataInstallRoot), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$metadata.data_root)), (Get-InstallPathIdentity $data), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Product install ownership metadata does not match the requested install/data roots."
  }

  Assert-ExpectedRegularFiles -Root $install -Label 'ProductInstall' -RelativePaths @(
    'apps\gateway\dist\main.js',
    'package.json',
    'blue-tanuki-managed-files.json',
    'BlueTanuki.cmd',
    'BlueTanukiLauncher.ps1',
    'BlueTanukiUninstall.ps1',
    'UninstallBlueTanuki.cmd'
  )
  $runtimeNode = Get-ChildItem -LiteralPath (Join-Path $install 'runtime') -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $runtimeNode -or ($runtimeNode.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Product install is missing its regular bundled runtime executable."
  }

  $schemaVersion = 0
  if (-not [int]::TryParse([string]$metadata.schema_version, [ref]$schemaVersion)) {
    throw "Product install ownership metadata has an unsupported schema."
  }
  if ($schemaVersion -ne 3 -or $metadata.product_id -ne 'blue-tanuki-product-install') {
    throw "Product install ownership metadata is not recognized."
  }

  $manifestPath = Join-Path $install 'blue-tanuki-package-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Product package manifest is missing: $manifestPath"
  }
  $manifestItem = Get-Item -Force -LiteralPath $manifestPath
  if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $manifestItem.Length -gt 1048576) {
    throw "Product package manifest is not a bounded regular file: $manifestPath"
  }
  $manifestHash = Get-Sha256HexFromFile -Path $manifestPath
  if (-not [string]::Equals($manifestHash, [string]$metadata.package_manifest_sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Product package manifest digest does not match install metadata."
  }
  try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch {
    throw "Product package manifest is invalid: $manifestPath"
  }
  if ($manifest.schema_version -ne 1 -or $manifest.name -ne 'blue-tanuki' -or $manifest.package_type -ne 'windows-x64-zip-installer') {
    throw "Product package manifest does not identify a BLUE-TANUKI Windows installer."
  }
  Assert-ManagedTreeInventory -Root $install -MetadataFileName 'blue-tanuki-install.json' `
    -InventoryFileName 'blue-tanuki-managed-files.json' -ProductId 'blue-tanuki-product-install' `
    -ExpectedSha256 ([string]$metadata.managed_files_sha256)
  return 'managed-v3'
}

function Restore-InterruptedWindowsProductUpdate {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot
  )

  $install = Resolve-SafeDirectoryTarget -Path $InstallRoot -Label 'ProductInstallRoot'
  $data = Resolve-SafeDirectoryTarget -Path $DataRoot -Label 'ProductDataRoot'
  $parent = Resolve-SafeDirectoryTarget -Path (Split-Path -Parent $install) -Label 'ProductInstallParent'
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return $false }

  $installName = Split-Path -Leaf $install
  $siblings = @(Get-ChildItem -Force -LiteralPath $parent -ErrorAction Stop)
  $activeEntries = @($siblings | Where-Object {
    [string]::Equals([string]$_.Name, $installName, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($activeEntries.Count -gt 1) {
    throw 'Multiple filesystem entries match the product install root; no recovery was attempted.'
  }
  if ($activeEntries.Count -eq 1) {
    $activeEntry = $activeEntries[0]
    if (-not $activeEntry.PSIsContainer -or
        ($activeEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Product install root is occupied by a non-regular entry; no recovery was attempted.'
    }
    return $false
  }

  $candidatePattern = '^\.' + [System.Text.RegularExpressions.Regex]::Escape($installName) +
    '\.blue-tanuki-rollback-[0-9a-f]{32}$'
  $candidates = @($siblings | Where-Object {
    [System.Text.RegularExpressions.Regex]::IsMatch(
      [string]$_.Name,
      $candidatePattern,
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  })
  if ($candidates.Count -eq 0) { return $false }
  if ($candidates.Count -ne 1) {
    throw 'Multiple interrupted product-update rollback candidates exist; no files were moved.'
  }

  $candidate = $candidates[0]
  if (-not $candidate.PSIsContainer -or
      ($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Interrupted product-update rollback candidate is not a regular directory; no files were moved.'
  }
  $candidatePath = Resolve-SafeDirectoryTarget -Path $candidate.FullName -Label 'ProductUpdateRollbackCandidate'
  if (-not [string]::Equals(
      (Split-Path -Parent $candidatePath), $parent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Interrupted product-update rollback candidate is not a direct child of the install parent.'
  }
  try {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $candidatePath -DataRoot $data -MetadataInstallRoot $install)
  } catch {
    throw "Interrupted product-update rollback candidate is not a verified managed install; it was preserved. $($_.Exception.Message)"
  }

  if (Test-Path -LiteralPath $install) {
    throw 'Product install root appeared during interrupted-update recovery; no candidate was moved.'
  }
  [System.IO.Directory]::Move($candidatePath, $install)
  try {
    [void](Assert-ManagedWindowsProductInstall -InstallRoot $install -DataRoot $data -MetadataInstallRoot $install)
  } catch {
    throw "Restored product install could not be reverified; it remains at the requested install root for inspection. $($_.Exception.Message)"
  }
  return $true
}

function Assert-ManagedWindowsProductData {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )
  $data = Resolve-SafeDirectoryTarget -Path $DataRoot -Label 'ProductDataRoot'
  $install = Resolve-SafeDirectoryTarget -Path $InstallRoot -Label 'ProductInstallRoot'
  if (-not (Test-Path -LiteralPath $data -PathType Container)) {
    throw "Product data root is missing: $data"
  }
  Assert-NoReparsePointsInTree -Path $data -Label 'ProductDataRoot'
  $markerPath = Join-Path $data 'blue-tanuki-product-data.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Product data ownership marker is missing: $markerPath"
  }
  $item = Get-Item -Force -LiteralPath $markerPath
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536) {
    throw "Product data ownership marker is not a bounded regular file: $markerPath"
  }
  try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch {
    throw "Product data ownership marker is invalid: $markerPath"
  }
  if ($null -eq $marker -or $marker.schema_version -ne 1 -or $marker.product_id -ne 'blue-tanuki-product-data' -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $data), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity $install), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Product data ownership marker does not match the requested install and data roots.'
  }
  return 'managed-v1'
}

function Assert-ManagedWindowsDevelopmentData {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [switch]$AllowEmpty
  )
  $data = Resolve-SafeDirectoryTarget -Path $DataRoot -Label 'DevelopmentDataRoot'
  $install = Resolve-SafeDirectoryTarget -Path $InstallRoot -Label 'DevelopmentInstallRoot'
  $launcher = Join-Path $data 'bin\blue-tanuki.ps1'
  $cmdLauncher = Join-Path $data 'bin\blue-tanuki.cmd'
  $markerPath = Join-Path $data 'blue-tanuki-development-data.json'
  $hasLauncher = (Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath $cmdLauncher)
  if (-not (Test-Path -LiteralPath $markerPath)) {
    if (-not $hasLauncher -and $AllowEmpty) { return 'unmanaged-empty' }
    throw 'Development launcher ownership marker is missing; no launcher or data was changed.'
  }
  $markerItem = Get-Item -Force -LiteralPath $markerPath
  if (-not $markerItem -or $markerItem.PSIsContainer -or
      ($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.Length -gt 65536) {
    throw "Development data ownership marker is not a bounded regular file: $markerPath"
  }
  try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch {
    throw "Development data ownership marker is invalid: $markerPath"
  }
  if ($null -eq $marker -or $marker.schema_version -ne 1 -or $marker.product_id -ne 'blue-tanuki-development-data' -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity $install), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $data), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.launcher_path)), (Get-InstallPathIdentity $launcher), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.cmd_launcher_path)), (Get-InstallPathIdentity $cmdLauncher), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Development data ownership marker does not match the requested launcher targets.'
  }
  Assert-ExpectedRegularFiles -Root $data -Label 'DevelopmentData' -RelativePaths @(
    'blue-tanuki.env',
    'blue-tanuki-development-data.json',
    'bin\blue-tanuki.ps1',
    'bin\blue-tanuki.cmd'
  )
  if (-not [string]::Equals((Get-Sha256HexFromFile -Path $launcher), [string]$marker.launcher_sha256, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-Sha256HexFromFile -Path $cmdLauncher), [string]$marker.cmd_launcher_sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Development launcher files differ from their ownership record; no files were changed.'
  }
  return 'managed-v1'
}

function Assert-ManagedWindowsDevelopmentInstall {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [switch]$AllowLegacy
  )
  $install = Resolve-SafeDirectoryTarget -Path $InstallRoot -Label 'DevelopmentInstallRoot'
  $data = Resolve-SafeDirectoryTarget -Path $DataRoot -Label 'DevelopmentDataRoot'
  if (-not (Test-Path -LiteralPath $install -PathType Container)) {
    throw "Development install root is missing: $install"
  }
  Assert-NoReparsePointsInTree -Path $install -Label 'DevelopmentInstallRoot'
  Assert-ExpectedRegularFiles -Root $install -Label 'DevelopmentInstall' -RelativePaths @(
    'package.json',
    'apps\gateway\dist\main.js',
    'install\windows\install.ps1'
  )
  Assert-ExpectedRegularFiles -Root $data -Label 'DevelopmentData' -RelativePaths @(
    'blue-tanuki.env',
    'bin\blue-tanuki.ps1',
    'bin\blue-tanuki.cmd'
  )
  [void](Assert-ManagedWindowsDevelopmentData -DataRoot $data -InstallRoot $install)

  $markerPath = Join-Path $install 'blue-tanuki-development-install.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    if ($AllowLegacy) {
      $defaultInstall = Get-InstallPathIdentity "$env:LOCALAPPDATA\BlueTanuki\app"
      $defaultData = Get-InstallPathIdentity "$env:APPDATA\BlueTanuki"
      if ([string]::Equals((Get-InstallPathIdentity $install), $defaultInstall, [System.StringComparison]::OrdinalIgnoreCase) -and
          [string]::Equals((Get-InstallPathIdentity $data), $defaultData, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Legacy development install has no installed-file inventory. No files were removed; preserve or move it before migrating.'
      }
    }
    throw "Development install ownership marker is missing: $markerPath"
  }
  $markerItem = Get-Item -Force -LiteralPath $markerPath
  if (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $markerItem.Length -gt 65536) {
    throw "Development install ownership marker is not a bounded regular file: $markerPath"
  }
  try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch {
    throw "Development install ownership marker is invalid: $markerPath"
  }
  if ($null -eq $marker -or $marker.schema_version -ne 2 -or $marker.product_id -ne 'blue-tanuki-development-install' -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.install_root)), (Get-InstallPathIdentity $install), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals((Get-InstallPathIdentity ([string]$marker.data_root)), (Get-InstallPathIdentity $data), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Development install ownership marker does not match the requested targets."
  }
  Assert-ManagedTreeInventory -Root $install -MetadataFileName 'blue-tanuki-development-install.json' `
    -InventoryFileName 'blue-tanuki-managed-files.json' -ProductId 'blue-tanuki-development-install' `
    -ExpectedSha256 ([string]$marker.managed_files_sha256)
  return 'managed-v2'
}

function Assert-SafeInstallTargets {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$SourceRoot
  )

  $install = Resolve-SafeDirectoryTarget $InstallRoot 'InstallRoot'
  $data = Resolve-SafeDirectoryTarget $DataRoot 'DataRoot'
  $source = $null
  if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
    $source = Resolve-SafeDirectoryTarget -Path $SourceRoot -Label 'SourceRoot' -AllowReparse
  }
  $userProfile = Resolve-SafeDirectoryTarget $env:USERPROFILE 'USERPROFILE'
  $denied = @(
    [System.IO.Path]::GetFullPath($userProfile),
    [System.IO.Path]::GetFullPath($env:LOCALAPPDATA),
    [System.IO.Path]::GetFullPath($env:APPDATA),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')),
    [System.Environment]::GetFolderPath('ProgramFiles'),
    [System.Environment]::GetFolderPath('ProgramFilesX86'),
    [System.Environment]::GetFolderPath('CommonApplicationData'),
    $env:SystemRoot,
    (Join-Path $env:USERPROFILE 'Public')
  ) | Where-Object { $_ }
  $filesystemRoots = @(
    [System.IO.Path]::GetPathRoot($install),
    [System.IO.Path]::GetPathRoot($data)
  ) | Where-Object { $_ }

  foreach ($target in @(@{ Label = 'InstallRoot'; Path = $install }, @{ Label = 'DataRoot'; Path = $data })) {
    foreach ($filesystemRoot in $filesystemRoots) {
      if ([System.String]::Equals(
        $target.Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        $filesystemRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        throw "$($target.Label) points to a filesystem root: $($target.Path)"
      }
    }
    if (Test-SameOrDescendantPath $userProfile $target.Path) {
      throw "$($target.Label) points to or contains the current user profile: $($target.Path)"
    }
    foreach ($broad in $denied) {
      $normalizedBroad = [System.IO.Path]::GetFullPath($broad).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
      if ([System.String]::Equals(
        $target.Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        $normalizedBroad,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        throw "$($target.Label) points to a broad user directory: $($target.Path)"
      }
    }
    if ($source -and (Test-SameOrDescendantPath $source $target.Path)) {
      throw "$($target.Label) would contain the source tree: $($target.Path)"
    }
    if ($source -and (Test-SameOrDescendantPath $target.Path $source)) {
      throw "$($target.Label) overlaps the source tree: $($target.Path)"
    }
  }

  if ((Test-SameOrDescendantPath $install $data) -or (Test-SameOrDescendantPath $data $install)) {
    throw "InstallRoot and DataRoot must not overlap: $install ; $data"
  }

  return @{ InstallRoot = $install; DataRoot = $data; SourceRoot = $source }
}
