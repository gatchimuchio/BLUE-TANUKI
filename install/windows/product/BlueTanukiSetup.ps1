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
  exit 1
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
  Write-Host "  Run INSTALL_WINDOWS.cmd from the repository root."
  Write-Host ""
  Write-Host "Or build the installer:"
  Write-Host "  corepack enable"
  Write-Host "  corepack prepare pnpm@9.12.0 --activate"
  Write-Host "  pnpm install --frozen-lockfile"
  Write-Host "  pnpm build"
  Write-Host "  pnpm package:windows"
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
    "windows-installer-manifest.json"
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
}

function Normalize-Path($Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-SafeTarget($Target, $Label) {
  $normalized = Normalize-Path $Target
  $root = [System.IO.Path]::GetPathRoot($normalized)
  $trimmed = $normalized.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $rootTrimmed = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $denied = @(
    (Normalize-Path $env:USERPROFILE),
    (Normalize-Path $env:LOCALAPPDATA),
    (Normalize-Path $env:APPDATA),
    (Normalize-Path (Join-Path $env:LOCALAPPDATA "Programs"))
  )
  if ($trimmed -eq $rootTrimmed) {
    Fail "$Label points to a filesystem root: $normalized"
  }
  foreach ($path in $denied) {
    $deniedTrimmed = $path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($trimmed -eq $deniedTrimmed) {
      Fail "$Label points to a broad user directory: $normalized"
    }
  }
  return $normalized
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
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher stop | Out-Null
    } catch {
      Write-Warning "existing resident stop failed; continuing install: $($_.Exception.Message)"
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
  $programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI"
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $launcher = Join-Path $InstallRootResolved "BlueTanukiLauncher.ps1"
  $uninstaller = Join-Path $InstallRootResolved "UninstallBlueTanuki.cmd"
  $icon = "$(Find-NodeExe $InstallRootResolved),0"
  New-Shortcut (Join-Path $programs "BLUE-TANUKI.lnk") $ps "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" open" $InstallRootResolved "Open BLUE-TANUKI Control Center" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Doctor.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" doctor-open" $InstallRootResolved "Run BLUE-TANUKI Doctor" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Logs.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" logs" $InstallRootResolved "Open BLUE-TANUKI logs" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Safe Mode.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" safe-mode" $InstallRootResolved "Start BLUE-TANUKI with external providers and connectors disabled" $icon
  New-Shortcut (Join-Path $programs "BLUE-TANUKI Stop.lnk") $ps "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" stop" $InstallRootResolved "Stop BLUE-TANUKI resident runtime" $icon
  New-Shortcut (Join-Path $programs "Uninstall BLUE-TANUKI.lnk") $uninstaller "" $InstallRootResolved "Uninstall BLUE-TANUKI" $icon
  if ($DesktopShortcutEnabled) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    New-Shortcut (Join-Path $desktop "BLUE-TANUKI.lnk") $ps "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" open" $InstallRootResolved "Open BLUE-TANUKI Control Center" $icon
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

function Write-InstallMetadata($InstallRootResolved, $DataRootResolved, $Version) {
  $metadata = [ordered]@{
    schema_version = 1
    install_root = $InstallRootResolved
    data_root = $DataRootResolved
    version = $Version
  }
  $metadataPath = Join-Path $InstallRootResolved "blue-tanuki-install.json"
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

$packageRoot = Split-Path -Parent $PSCommandPath
$sourceApp = Join-Path $packageRoot "app"
$sourceLaunchers = Join-Path $packageRoot "launcher"
$manifestPath = Join-Path $packageRoot "windows-installer-manifest.json"
Assert-PackagedInstallerRoot $packageRoot
$installRootResolved = Assert-SafeTarget $InstallRoot "InstallRoot"
$dataRootResolved = Assert-SafeTarget $DataRoot "DataRoot"
$envFile = Join-Path $dataRootResolved "blue-tanuki.env"
$dataDir = Join-Path $dataRootResolved "data"
$logDir = Join-Path $dataRootResolved "logs"
$version = "unknown"
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $version = [string]$manifest.version
}

Write-Host "Installing BLUE-TANUKI to $installRootResolved"
Write-Host "User data root: $dataRootResolved"
Write-Host "Autostart: not enabled by installer"

Stop-ExistingResident $installRootResolved
if (Test-Path -LiteralPath $installRootResolved) {
  Remove-Item -LiteralPath $installRootResolved -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $installRootResolved, $dataRootResolved, $dataDir, $logDir | Out-Null

Copy-DirectoryContents $sourceApp $installRootResolved
Expand-BundledNode $packageRoot $installRootResolved
Copy-DirectoryContents $sourceLaunchers $installRootResolved
Write-InstallMetadata $installRootResolved $dataRootResolved $version

$nodeExe = Find-NodeExe $installRootResolved
Invoke-BundledSetup $nodeExe $installRootResolved $envFile $dataDir
if (-not $SkipDoctor) {
  Invoke-PostInstallDoctor $nodeExe $installRootResolved $envFile $logDir
}
Install-Shortcuts $installRootResolved $DesktopShortcut
Register-Uninstaller $installRootResolved $dataRootResolved $version

Write-Host ""
Write-Host "BLUE-TANUKI installed."
Write-Host "Start Menu: BLUE-TANUKI"
Write-Host "Install root: $installRootResolved"
Write-Host "Env file: $envFile"
Write-Host "Logs: $logDir"
Write-Host "Control Center: http://127.0.0.1:8787/app"
Write-Host "Uninstall: Windows Apps / Control Panel or $installRootResolved\UninstallBlueTanuki.cmd"

if (-not $NoLaunch) {
  Start-Process -FilePath (Join-Path $installRootResolved "BlueTanuki.cmd")
}
