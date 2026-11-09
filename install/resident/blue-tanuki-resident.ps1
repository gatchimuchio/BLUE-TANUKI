[CmdletBinding()]
param(
  [string]$Command = "status",
  [string]$InstallRoot = (Get-Location).Path,
  [string]$EnvFile = $env:BLUE_TANUKI_ENV_FILE,
  [string]$DataRoot = "$env:APPDATA\BlueTanuki",
  [string]$Launcher = "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail($Message) {
  Write-Error $Message
  exit 2
}

function Require-Path($Path, $Label) {
  if (-not $Path) {
    Fail "$Label is required."
  }
  return [System.IO.Path]::GetFullPath($Path)
}

$installRootResolved = Require-Path $InstallRoot "InstallRoot"
$envFileResolved = Require-Path $EnvFile "EnvFile"
$dataRootResolved = Require-Path $DataRoot "DataRoot"
$launcherResolved = Require-Path $Launcher "Launcher"
$pidFile = Join-Path $dataRootResolved "blue-tanuki.pid"
$logDir = Join-Path $dataRootResolved "logs"
$stdoutLog = Join-Path $logDir "blue-tanuki.out.log"
$stderrLog = Join-Path $logDir "blue-tanuki.err.log"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "BlueTanuki"

function Read-ResidentPid {
  if (-not (Test-Path -LiteralPath $pidFile)) {
    return $null
  }
  $raw = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
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

function Quote-ProcessArgument($Value) {
  if ($Value -match "\s") {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Start-Resident {
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
    return
  }
  New-Item -ItemType Directory -Force -Path $dataRootResolved, $logDir | Out-Null
  $extraArgs = @($RemainingArgs | Where-Object { $_ -ne $null })
  $processArgsRaw = @("apps/gateway/dist/main.js", "--serve", "--env-file", $envFileResolved) + $extraArgs
  $processArgs = @($processArgsRaw | ForEach-Object { Quote-ProcessArgument $_ })
  $process = Start-Process -FilePath "node" -ArgumentList $processArgs -WorkingDirectory $installRootResolved -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  Write-Host "resident_status=started pid=$($process.Id)"
  Write-Host "control_center=http://127.0.0.1:8787/"
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

function Show-ResidentStatus {
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
  } else {
    Write-Host "resident_status=stopped"
  }
  Write-Host "control_center=http://127.0.0.1:8787/"
  Write-Host "env_file=$envFileResolved"
  Write-Host "logs=$logDir"
}

function Open-ControlCenter {
  Start-Process "http://127.0.0.1:8787/"
  Write-Host "opened=http://127.0.0.1:8787/"
}

function Show-ResidentLogs {
  Write-Host "stdout=$stdoutLog"
  Write-Host "stderr=$stderrLog"
  if (Test-Path -LiteralPath $stdoutLog) {
    Write-Host "--- stdout tail ---"
    Get-Content -LiteralPath $stdoutLog -Tail 80
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Write-Host "--- stderr tail ---"
    Get-Content -LiteralPath $stderrLog -Tail 80
  }
}

function Enable-Autostart {
  New-Item -Path $runKey -Force | Out-Null
  $value = "powershell -NoProfile -File `"$launcherResolved`" resident-start"
  New-ItemProperty -Path $runKey -Name $runName -Value $value -PropertyType String -Force | Out-Null
  Write-Host "autostart_status=enabled"
  Write-Host "autostart_entry=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\$runName"
}

function Disable-Autostart {
  Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
  Write-Host "autostart_status=disabled"
}

function Show-AutostartStatus {
  $entry = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
  if ($entry) {
    Write-Host "autostart_status=enabled"
  } else {
    Write-Host "autostart_status=disabled"
  }
}

switch ($Command.ToLowerInvariant()) {
  "start" { Start-Resident }
  "resident-start" { Start-Resident }
  "stop" { Stop-Resident }
  "resident-stop" { Stop-Resident }
  "status" { Show-ResidentStatus }
  "resident-status" { Show-ResidentStatus }
  "open" { Open-ControlCenter }
  "resident-open" { Open-ControlCenter }
  "logs" { Show-ResidentLogs }
  "resident-logs" { Show-ResidentLogs }
  "autostart-enable" { Enable-Autostart }
  "resident-autostart-enable" { Enable-Autostart }
  "autostart-disable" { Disable-Autostart }
  "resident-autostart-disable" { Disable-Autostart }
  "autostart-status" { Show-AutostartStatus }
  "resident-autostart-status" { Show-AutostartStatus }
  default {
    Fail "unknown resident command: $Command"
  }
}
