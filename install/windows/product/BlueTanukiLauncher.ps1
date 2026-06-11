[CmdletBinding()]
param(
  [string]$Command = "open",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail($Message) {
  Write-Error $Message
  exit 2
}

$installRoot = Split-Path -Parent $PSCommandPath
$installMetadataPath = Join-Path $installRoot "blue-tanuki-install.json"

function Resolve-DataRoot {
  if (Test-Path -LiteralPath $installMetadataPath) {
    try {
      $metadata = Get-Content -LiteralPath $installMetadataPath -Raw | ConvertFrom-Json
      if ($metadata.PSObject.Properties.Name -contains "data_root") {
        $value = [string]$metadata.data_root
        if ($value) {
          return [System.IO.Path]::GetFullPath($value)
        }
      }
    } catch {
      Write-Warning "install metadata could not be read; falling back to default data root: $($_.Exception.Message)"
    }
  }
  return [System.IO.Path]::GetFullPath("$env:APPDATA\BlueTanuki")
}

$dataRoot = Resolve-DataRoot
$envFile = Join-Path $dataRoot "blue-tanuki.env"
$dataDir = Join-Path $dataRoot "data"
$logDir = Join-Path $dataRoot "logs"
$pidFile = Join-Path $dataRoot "blue-tanuki.pid"
$stdoutLog = Join-Path $logDir "blue-tanuki.out.log"
$stderrLog = Join-Path $logDir "blue-tanuki.err.log"
$doctorLog = Join-Path $logDir "doctor.json"
$controlCenterUrl = "http://127.0.0.1:8787/app"
$healthUrl = "http://127.0.0.1:8787/healthz"

function Find-NodeExe {
  $runtimeRoot = Join-Path $installRoot "runtime"
  $node = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $node) {
    Fail "bundled node.exe was not found under $runtimeRoot"
  }
  return $node.FullName
}

function Read-ResidentPid {
  if (-not (Test-Path -LiteralPath $pidFile)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $raw) {
    return $null
  }
  $pidValue = 0
  if ([int]::TryParse($raw.Trim(), [ref]$pidValue)) {
    return $pidValue
  }
  return $null
}

function Test-ResidentRunning {
  $pidValue = Read-ResidentPid
  if (-not $pidValue) {
    return $false
  }
  return [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Quote-Arg($Value) {
  if ($Value -match "\s") {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Wait-Health($TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  return $false
}

function Ensure-EnvFile {
  if (Test-Path -LiteralPath $envFile) {
    return
  }
  New-Item -ItemType Directory -Force -Path $dataRoot, $dataDir, $logDir | Out-Null
  $nodeExe = Find-NodeExe
  Push-Location $installRoot
  try {
    & $nodeExe "apps/gateway/dist/main.js" "--setup" "--yes" "--output" $envFile "--base-dir" $dataDir "--no-doctor"
    if ($LASTEXITCODE -ne 0) {
      Fail "first-run setup failed"
    }
  } finally {
    Pop-Location
  }
}

function Start-Resident {
  Ensure-EnvFile
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
    return
  }
  New-Item -ItemType Directory -Force -Path $dataRoot, $dataDir, $logDir | Out-Null
  $nodeExe = Find-NodeExe
  $env:BLUE_TANUKI_ENV_FILE = $envFile
  $rawArgs = @("apps/gateway/dist/main.js", "--serve", "--env-file", $envFile) + $RemainingArgs
  $processArgs = @($rawArgs | ForEach-Object { Quote-Arg $_ })
  $process = Start-Process -FilePath $nodeExe -ArgumentList $processArgs -WorkingDirectory $installRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  if (Wait-Health 15000) {
    Write-Host "resident_status=started pid=$($process.Id)"
  } else {
    Write-Warning "resident started but health did not become ready within timeout. Logs: $logDir"
  }
  Write-Host "control_center=$controlCenterUrl"
  Write-Host "logs=$logDir"
}

function Stop-Resident {
  $pidValue = Read-ResidentPid
  if (-not $pidValue) {
    Write-Host "resident_status=stopped"
    return
  }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $pidValue -ErrorAction SilentlyContinue
    Write-Host "resident_status=stopped pid=$pidValue"
  } else {
    Write-Host "resident_status=stale pid=$pidValue"
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Show-Status {
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
  } else {
    Write-Host "resident_status=stopped"
  }
  Write-Host "control_center=$controlCenterUrl"
  Write-Host "env_file=$envFile"
  Write-Host "logs=$logDir"
}

function Open-ControlCenter {
  Start-Resident
  Start-Process $controlCenterUrl
}

function Run-Doctor($OpenLog) {
  Ensure-EnvFile
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $nodeExe = Find-NodeExe
  Push-Location $installRoot
  try {
    & $nodeExe "apps/gateway/dist/main.js" "--doctor" "--env-file" $envFile "--json" *> $doctorLog
    $code = $LASTEXITCODE
    Write-Host "doctor_exit_code=$code"
    Write-Host "doctor_log=$doctorLog"
    if ($OpenLog) {
      Start-Process $doctorLog
    } else {
      Get-Content -LiteralPath $doctorLog -Tail 120
    }
    exit $code
  } finally {
    Pop-Location
  }
}

function Open-Logs {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process $logDir
}

switch ($Command.ToLowerInvariant()) {
  "open" { Open-ControlCenter }
  "start" { Start-Resident }
  "resident-start" { Start-Resident }
  "stop" { Stop-Resident }
  "resident-stop" { Stop-Resident }
  "restart" { Stop-Resident; Start-Resident }
  "status" { Show-Status }
  "resident-status" { Show-Status }
  "doctor" { Run-Doctor $false }
  "doctor-open" { Run-Doctor $true }
  "logs" { Open-Logs }
  "resident-logs" { Open-Logs }
  "help" {
    Write-Host "Usage: BlueTanukiLauncher.ps1 [open|start|stop|restart|status|doctor|doctor-open|logs|help]"
    Write-Host "Autostart is opt-in only and is not enabled by this Windows installer package."
  }
  default { Fail "unknown command: $Command" }
}
