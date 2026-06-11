[CmdletBinding()]
param(
  [string]$Command = "open",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail($Message) {
  Write-Error $Message -ErrorAction Continue
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

function Parse-EnvValue($RawValue) {
  $trimmed = $RawValue.Trim()
  if ($trimmed.StartsWith('"')) {
    try {
      return [string]($trimmed | ConvertFrom-Json)
    } catch {
      return $trimmed.Trim('"')
    }
  }
  if ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'") -and $trimmed.Length -ge 2) {
    return $trimmed.Substring(1, $trimmed.Length - 2)
  }
  return $trimmed
}

function Get-EnvFileValue($Name, $DefaultValue) {
  if (-not (Test-Path -LiteralPath $envFile)) {
    return $DefaultValue
  }
  foreach ($line in Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $idx = $trimmed.IndexOf("=")
    if ($idx -le 0) {
      continue
    }
    $key = $trimmed.Substring(0, $idx).Trim()
    if ($key -eq $Name) {
      return Parse-EnvValue $trimmed.Substring($idx + 1)
    }
  }
  return $DefaultValue
}

function Get-WebHost {
  return Get-EnvFileValue "WEBCHAT_HOST" "127.0.0.1"
}

function Get-WebPort {
  $rawPort = Get-EnvFileValue "WEBCHAT_PORT" "8787"
  $port = 8787
  if ([int]::TryParse($rawPort, [ref]$port) -and $port -gt 0 -and $port -lt 65536) {
    return $port
  }
  return 8787
}

function Get-ControlCenterUrl {
  return "http://$(Get-WebHost):$(Get-WebPort)/app"
}

function Get-HealthUrl {
  return "http://$(Get-WebHost):$(Get-WebPort)/healthz"
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

function Resolve-ListenAddress($HostName) {
  $address = [System.Net.IPAddress]::Loopback
  if ([System.Net.IPAddress]::TryParse($HostName, [ref]$address)) {
    return $address
  }
  if ($HostName -eq "localhost") {
    return [System.Net.IPAddress]::Loopback
  }
  return [System.Net.IPAddress]::Loopback
}

function Test-PortBindable($HostName, $Port) {
  $listener = $null
  try {
    $address = Resolve-ListenAddress $HostName
    $listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) {
      $listener.Stop()
    }
  }
}

function Assert-PortAvailable {
  $hostName = Get-WebHost
  $port = Get-WebPort
  if (-not (Test-PortBindable $hostName $port)) {
    Fail "port_conflict=${hostName}:$port. Stop the process using this port, change WEBCHAT_PORT in $envFile, or launch BLUE-TANUKI Safe Mode after repair. Logs: $logDir"
  }
}

function Wait-Health($TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri (Get-HealthUrl) -TimeoutSec 2
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

function Set-SafeModeEnvironment {
  $env:BLUE_TANUKI_SAFE_MODE = "1"
  $env:LLM_BACKEND = "stub"
  $env:ANTHROPIC_API_KEY = ""
  $env:OPENAI_API_KEY = ""
  $env:OPENAI_COMPAT_API_KEY = ""
  $env:OPENROUTER_API_KEY = ""
  $env:TELEGRAM_BOT_TOKEN = ""
  $env:SLACK_BOT_TOKEN = ""
  $env:SLACK_APP_TOKEN = ""
  $env:DISCORD_BOT_TOKEN = ""
  $env:MICROSOFT_GRAPH_ACCESS_TOKEN = ""
  $env:LINE_CHANNEL_ACCESS_TOKEN = ""
  $env:COMPOSIO_API_KEY = ""
  $env:COMPOSIO_DRY_RUN = "true"
  $env:BLUE_TANUKI_DAILY_BRIEF_ENABLED = "0"
  $env:BLUE_TANUKI_SCHEDULES_JSON = ""
}

function Start-Resident($SafeMode = $false) {
  Ensure-EnvFile
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
    return
  }
  Assert-PortAvailable
  if ($SafeMode) {
    Set-SafeModeEnvironment
    Write-Host "safe_mode=enabled"
  }
  New-Item -ItemType Directory -Force -Path $dataRoot, $dataDir, $logDir | Out-Null
  $nodeExe = Find-NodeExe
  $env:BLUE_TANUKI_ENV_FILE = $envFile
  $rawArgs = @("apps/gateway/dist/main.js", "--serve", "--env-file", $envFile)
  if ($RemainingArgs) {
    $rawArgs += $RemainingArgs
  }
  $processArgs = @($rawArgs | ForEach-Object { Quote-Arg $_ })
  $process = Start-Process -FilePath $nodeExe -ArgumentList $processArgs -WorkingDirectory $installRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  if (Wait-Health 15000) {
    Write-Host "resident_status=started pid=$($process.Id)"
  } else {
    Write-Warning "resident started but health did not become ready within timeout. Logs: $logDir"
  }
  Write-Host "control_center=$(Get-ControlCenterUrl)"
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
  Write-Host "control_center=$(Get-ControlCenterUrl)"
  Write-Host "env_file=$envFile"
  Write-Host "logs=$logDir"
}

function Open-ControlCenter {
  Start-Resident $false
  Start-Process (Get-ControlCenterUrl)
}

function Start-SafeMode {
  Stop-Resident
  Start-Resident $true
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
  "start" { Start-Resident $false }
  "resident-start" { Start-Resident $false }
  "safe-mode" { Start-SafeMode }
  "resident-safe-mode" { Start-SafeMode }
  "stop" { Stop-Resident }
  "resident-stop" { Stop-Resident }
  "restart" { Stop-Resident; Start-Resident $false }
  "status" { Show-Status }
  "resident-status" { Show-Status }
  "doctor" { Run-Doctor $false }
  "doctor-open" { Run-Doctor $true }
  "logs" { Open-Logs }
  "resident-logs" { Open-Logs }
  "help" {
    Write-Host "Usage: BlueTanukiLauncher.ps1 [open|start|safe-mode|stop|restart|status|doctor|doctor-open|logs|help]"
    Write-Host "Autostart is opt-in only and is not enabled by this Windows installer package."
  }
  default { Fail "unknown command: $Command" }
}
