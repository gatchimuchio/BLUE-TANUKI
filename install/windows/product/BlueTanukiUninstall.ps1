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
$script:ValidatedTemporaryHelperPath = $null

function Get-FileSha256($Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Normalize-Path($Path) {
  return [System.IO.Path]::GetFullPath([string]$Path)
}

function Write-UninstallStatus($ExitCode) {
  if ($env:BLUE_TANUKI_UNINSTALL_STATUS_FILE) {
    try {
      $statusPath = [System.IO.Path]::GetFullPath($env:BLUE_TANUKI_UNINSTALL_STATUS_FILE)
      $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
      if ($statusPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
          [System.IO.Path]::GetFileName($statusPath) -match '^BlueTanukiUninstall-[A-Za-z0-9-]+\.status$') {
        "exit_code=$ExitCode" | Set-Content -LiteralPath $statusPath -Encoding ASCII
      }
    } catch {
      # Status files are diagnostic evidence only; uninstall behavior remains authoritative.
    }
  }
  Remove-TemporaryArtifacts
}

function Remove-TemporaryArtifacts {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $scriptCandidate = $null
  try {
    $currentScript = [System.IO.Path]::GetFullPath($PSCommandPath)
    $prefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if ($currentScript.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($currentScript) -match '^BlueTanukiUninstall-[A-Za-z0-9-]+\.ps1$') {
      $scriptCandidate = $currentScript
    }
  } catch { }
  foreach ($candidate in @($script:ValidatedTemporaryHelperPath, $scriptCandidate)) {
    if (-not $candidate) { continue }
    try { $full = [System.IO.Path]::GetFullPath($candidate) } catch { continue }
    $prefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($full -notmatch '\\BlueTanuki(Uninstall|SafeTarget)-[A-Za-z0-9-]+\.(ps1)$') { continue }
    if (Test-Path -LiteralPath $full -PathType Leaf) {
      try { Remove-Item -LiteralPath $full -Force -ErrorAction Stop } catch { }
    }
  }
}

function Fail($Message) {
  Write-UninstallStatus 1
  Write-Error -Message $Message -ErrorAction Continue
  exit 1
}

trap {
  Write-UninstallStatus 1
  throw
}

function Read-InstallMetadata($Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "Product install metadata is missing: $Path" }
  $item = Get-Item -Force -LiteralPath $Path
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536) {
    Fail "Product install metadata is not a bounded regular file: $Path"
  }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch {
    Fail "Product install metadata is invalid: $Path"
  }
}

function Assert-InstallHelper($InstallRootResolved) {
  $installedHelper = Normalize-Path (Join-Path $InstallRootResolved 'install\windows\safe-target.ps1')
  $sourceHelper = Normalize-Path (Join-Path $PSScriptRoot '..\safe-target.ps1')
  $trustedHelper = if (Test-Path -LiteralPath $sourceHelper -PathType Leaf) { $sourceHelper } else { $installedHelper }
  if ((Test-Path -LiteralPath $sourceHelper -PathType Leaf) -and (Test-Path -LiteralPath $installedHelper -PathType Leaf)) {
    if (-not [string]::Equals((Get-FileSha256 $sourceHelper), (Get-FileSha256 $installedHelper), [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail "Installed shared target safety guard differs from the packaged guard. No files were changed."
    }
  }
  $helperPath = $trustedHelper
  if ($env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET) {
    $candidateHelper = Normalize-Path $env:BLUE_TANUKI_UNINSTALL_SAFE_TARGET
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidateHelper.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($candidateHelper) -notmatch '^BlueTanukiSafeTarget-[A-Za-z0-9-]+\.ps1$') {
      Fail "Staged shared target safety guard path is outside the expected temporary area. No files were changed."
    }
    if (-not (Test-Path -LiteralPath $candidateHelper -PathType Leaf)) { Fail "Staged shared target safety guard is missing: $candidateHelper" }
    $candidateItem = Get-Item -Force -LiteralPath $candidateHelper
    if (($candidateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $candidateItem.Length -gt 262144) {
      Fail "Staged shared target safety guard is not a bounded regular file: $candidateHelper"
    }
    if (-not (Test-Path -LiteralPath $trustedHelper -PathType Leaf) -or
        -not [string]::Equals((Get-FileSha256 $candidateHelper), (Get-FileSha256 $trustedHelper), [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail "Staged shared target safety guard does not match the installation's guard. No files were changed."
    }
    $helperPath = $candidateHelper
    $script:ValidatedTemporaryHelperPath = $candidateHelper
  }
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { Fail "Shared install safety guard is missing: $helperPath" }
  $helper = Get-Item -Force -LiteralPath $helperPath
  if (($helper.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $helper.Length -gt 262144) {
    Fail "Shared install safety guard is not a bounded regular file: $helperPath"
  }
  return $helperPath
}

function Remove-Target($Target, $Label, $ProductDataInstallRoot = $null) {
  if (-not (Test-Path -LiteralPath $Target)) {
    if (-not $Quiet) { Write-Host "Skip missing ${Label}: $Target" }
    return
  }
  if ($DryRun) {
    Write-Host "Would remove ${Label}: $Target"
    return
  }
  if ($ProductDataInstallRoot) {
    try { [void](Assert-ManagedWindowsProductData -DataRoot $Target -InstallRoot $ProductDataInstallRoot) } catch {
      Fail "Refusing to remove user data because its ownership and structure could not be verified. The app has already been removed; user data is retained. $($_.Exception.Message)"
    }
  } else {
    try { Assert-NoReparsePointsInTree -Path $Target -Label $Label } catch {
      Fail "Refusing recursive removal of ${Label}. $($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $Target -Recurse -Force
  if (-not $Quiet) { Write-Host "Removed ${Label}: $Target" }
}

function Remove-RegularFile($Path, $Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -Force -LiteralPath $Path
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    if (-not $Quiet) { Write-Warning "Preserved ${Label}; it is not a regular file: $Path" }
    return
  }
  if ($DryRun) {
    Write-Host "Would remove ${Label}: $Path"
    return
  }
  Remove-Item -LiteralPath $Path -Force
}

function Test-ShortcutOwnedByInstall($Path, $InstallRootResolved) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -Force -LiteralPath $Path
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Extension -ne '.lnk') { return $false }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $launcher = Normalize-Path (Join-Path $InstallRootResolved 'BlueTanukiLauncher.ps1')
    $uninstaller = Normalize-Path (Join-Path $InstallRootResolved 'UninstallBlueTanuki.cmd')
    $target = if ($shortcut.TargetPath) { Normalize-Path $shortcut.TargetPath } else { '' }
    if ([string]::Equals($target, $uninstaller, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ([string]::Equals($target, $launcher, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return ([string]$shortcut.Arguments).IndexOf($launcher, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch {
    return $false
  }
}

function Remove-ManagedShortcuts($InstallRootResolved) {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI'
  if (Test-Path -LiteralPath $programs) {
    $folder = Get-Item -Force -LiteralPath $programs
    if ($folder.PSIsContainer -and ($folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      foreach ($entry in @(Get-ChildItem -Force -LiteralPath $programs -ErrorAction Stop)) {
        if (Test-ShortcutOwnedByInstall $entry.FullName $InstallRootResolved) {
          Remove-RegularFile $entry.FullName 'managed Start Menu shortcut'
        }
      }
      if (-not $DryRun -and @(Get-ChildItem -Force -LiteralPath $programs -ErrorAction Stop).Count -eq 0) {
        Remove-Item -LiteralPath $programs -Force
      }
    } elseif (-not $Quiet) {
      Write-Warning "Preserved Start Menu path because it is not a regular directory: $programs"
    }
  }

  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'BLUE-TANUKI.lnk'
  if (Test-ShortcutOwnedByInstall $desktopShortcut $InstallRootResolved) {
    Remove-RegularFile $desktopShortcut 'managed desktop shortcut'
  } elseif ((Test-Path -LiteralPath $desktopShortcut) -and -not $Quiet) {
    Write-Warning "Preserved an unrelated desktop item: $desktopShortcut"
  }
}

function Remove-ManagedUninstallRegistration($InstallRootResolved) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki'
  if (-not (Test-Path -LiteralPath $key)) { return }
  try { $entry = Get-ItemProperty -LiteralPath $key -ErrorAction Stop } catch {
    if (-not $Quiet) { Write-Warning "Preserved unreadable uninstall registration: $key" }
    return
  }
  $expectedLocation = Normalize-Path $InstallRootResolved
  $expectedCommand = Normalize-Path (Join-Path $InstallRootResolved 'UninstallBlueTanuki.cmd')
  $registeredLocation = ''
  $registeredCommand = ''
  try { if ($entry.InstallLocation) { $registeredLocation = Normalize-Path ([string]$entry.InstallLocation) } } catch { }
  try {
    if ($entry.UninstallString) {
      $raw = [string]$entry.UninstallString
      if ($raw -match '^\s*"(?<path>[^"]+)"') { $registeredCommand = Normalize-Path $Matches.path }
      elseif ($raw -match '^\s*(?<path>.+?\.cmd)(?:\s|$)') { $registeredCommand = Normalize-Path $Matches.path }
    }
  } catch { }
  if (-not [string]::Equals($registeredLocation, $expectedLocation, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($registeredCommand, $expectedCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (-not $Quiet) { Write-Warning "Preserved uninstall registration because it does not identify this installation: $key" }
    return
  }
  if ($DryRun) { Write-Host "Would remove managed uninstall registry key: $key"; return }
  Remove-Item -LiteralPath $key -Recurse -Force
}

$installRootInput = if ($InstallRoot) {
  $InstallRoot
} elseif ($env:BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT) {
  $env:BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT
} else {
  Split-Path -Parent $PSCommandPath
}
$installRootInput = Normalize-Path $installRootInput
$installHelperPath = Assert-InstallHelper $installRootInput
try { . $installHelperPath } catch { Fail "Shared install safety guard could not be loaded. No files were changed. $($_.Exception.Message)" }

$metadataPath = Join-Path $installRootInput 'blue-tanuki-install.json'
$metadata = Read-InstallMetadata $metadataPath
$dataRootInput = if ($DataRoot) { $DataRoot } else { [string]$metadata.data_root }
if ([string]::IsNullOrWhiteSpace($dataRootInput)) { Fail 'Product install metadata does not identify its data root.' }

try {
  $safeTargets = Assert-SafeInstallTargets -InstallRoot $installRootInput -DataRoot $dataRootInput -SourceRoot $null
  $installRootResolved = $safeTargets.InstallRoot
  $dataRootResolved = $safeTargets.DataRoot
  [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved)
  if ($PurgeData) { [void](Assert-ManagedWindowsProductData -DataRoot $dataRootResolved -InstallRoot $installRootResolved) }
} catch {
  Fail "Refusing to uninstall because product ownership and structure could not be verified. No files were changed. $($_.Exception.Message)"
}

$launcher = Join-Path $installRootResolved 'BlueTanukiLauncher.ps1'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  if ($DryRun) {
    Write-Host 'Would stop resident runtime.'
  } else {
    try { [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved) } catch {
      Fail "Refusing to run the product launcher because the installed inventory changed. No files were removed. $($_.Exception.Message)"
    }
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
      Fail "Refusing to remove the installation because resident shutdown was not confirmed. No installed files or user data were removed. $reason"
    }
  }
}

try { [void](Assert-ManagedWindowsProductInstall -InstallRoot $installRootResolved -DataRoot $dataRootResolved) } catch {
  Fail "Refusing to remove product files because the installed inventory changed. No files were removed. $($_.Exception.Message)"
}
Remove-Target $installRootResolved 'installed app'
Remove-ManagedShortcuts $installRootResolved
Remove-ManagedUninstallRegistration $installRootResolved

if ($PurgeData) {
  Remove-Target $dataRootResolved 'user data' $installRootResolved
  if (-not $Quiet) { Write-Host 'BLUE-TANUKI uninstalled with data purge.' }
} elseif (-not $Quiet) {
  Write-Host "BLUE-TANUKI app removed. User data retained at: $dataRootResolved"
  Write-Host 'Run UninstallBlueTanuki.cmd -PurgeData to remove env, logs, audit, session, and local data.'
}

Write-UninstallStatus 0
