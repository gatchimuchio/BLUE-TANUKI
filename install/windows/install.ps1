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
  if ((Test-Path -LiteralPath $TargetRoot) -and -not $Force) {
    Fail "$TargetRoot already exists. Re-run with -Force to replace the app. Add -ResetConfig only if you also want to regenerate the env file."
  }
  if (Test-Path -LiteralPath $TargetRoot) {
    Remove-Item -LiteralPath $TargetRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
  $exclude = @("node_modules", ".git", ".codex-tmp", ".blue-tanuki", "release")
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

if ((Test-Path -LiteralPath $installRootResolved) -and -not $Force) {
  Fail "$installRootResolved already exists. Re-run with -Force to replace the app. Add -ResetConfig only if you also want to regenerate the env file."
}

Write-Host "Install plan:"
Write-Host "  App target: $installRootResolved"
Write-Host "  User data:  $dataRootResolved"
Write-Host "  Replace existing app: $([bool]$Force)"
if (-not $PSCmdlet.ShouldProcess($installRootResolved, "Install BLUE-TANUKI and preserve user data at $dataRootResolved")) {
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
