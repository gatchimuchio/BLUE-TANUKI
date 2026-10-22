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

function Assert-SafeInstallTargets {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$SourceRoot
  )

  $install = Resolve-SafeDirectoryTarget $InstallRoot 'InstallRoot'
  $data = Resolve-SafeDirectoryTarget $DataRoot 'DataRoot'
  $source = Resolve-SafeDirectoryTarget -Path $SourceRoot -Label 'SourceRoot' -AllowReparse
  $userProfile = Resolve-SafeDirectoryTarget $env:USERPROFILE 'USERPROFILE'
  $denied = @(
    [System.IO.Path]::GetFullPath($userProfile),
    [System.IO.Path]::GetFullPath($env:LOCALAPPDATA),
    [System.IO.Path]::GetFullPath($env:APPDATA),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
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
    if (Test-SameOrDescendantPath $source $target.Path) {
      throw "$($target.Label) would contain the source tree: $($target.Path)"
    }
    if (Test-SameOrDescendantPath $target.Path $source) {
      throw "$($target.Label) overlaps the source tree: $($target.Path)"
    }
  }

  if ((Test-SameOrDescendantPath $install $data) -or (Test-SameOrDescendantPath $data $install)) {
    throw "InstallRoot and DataRoot must not overlap: $install ; $data"
  }

  return @{ InstallRoot = $install; DataRoot = $data; SourceRoot = $source }
}
