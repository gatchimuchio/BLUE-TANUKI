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
  try {
    $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop
  } catch {
    Fail "The resident PID record could not be read, so process ownership cannot be verified. $($_.Exception.Message)"
  }
  $pidValue = 0
  if ([int]::TryParse(([string]$raw).Trim(), [ref]$pidValue) -and $pidValue -gt 0) {
    return $pidValue
  }
  Fail "The resident PID record is invalid, so process ownership cannot be verified."
}

function Normalize-ProcessImagePath($Path) {
  return [System.IO.Path]::GetFullPath([string]$Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Test-CommandLineArgument($CommandLine, $Argument) {
  if ([string]::IsNullOrWhiteSpace([string]$CommandLine) -or [string]::IsNullOrWhiteSpace([string]$Argument)) {
    return $false
  }
  $escaped = [regex]::Escape([string]$Argument)
  $pattern = '(?i)(?:^|\s)(?:"' + $escaped + '"|' + $escaped + ')(?:\s|$)'
  return [regex]::IsMatch([string]$CommandLine, $pattern)
}

function Get-ResidentProcessSnapshot($PidValue) {
  $process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if (-not $process) {
    return @{ state = "stopped"; process = $null }
  }
  try {
    $record = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction Stop
  } catch {
    return @{ state = "unknown"; process = $process; reason = "process identity could not be inspected: $($_.Exception.Message)" }
  }
  if (-not $record) {
    try { $process.Refresh() } catch { }
    if ($process.HasExited) {
      return @{ state = "stopped"; process = $null }
    }
    return @{ state = "unknown"; process = $process; reason = "process identity record is unavailable" }
  }
  return @{
    state = "running"
    process = $process
    executable_path = [string]$record.ExecutablePath
    process_path = [string]$process.Path
    command_line = [string]$record.CommandLine
  }
}

function Get-ManagedResidentSnapshot($PidValue) {
  $snapshot = Get-ResidentProcessSnapshot $PidValue
  if ($snapshot.state -ne "running") {
    return $snapshot
  }
  try {
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $expectedImage = Normalize-ProcessImagePath $node.Source
    $expectedEntry = Normalize-ProcessImagePath (Join-Path $installRootResolved "apps\gateway\dist\main.js")
    $expectedEnv = Normalize-ProcessImagePath $envFileResolved
    $entryMatches = (Test-CommandLineArgument $snapshot.command_line $expectedEntry) -or
      (Test-CommandLineArgument $snapshot.command_line "apps/gateway/dist/main.js") -or
      (Test-CommandLineArgument $snapshot.command_line "apps\gateway\dist\main.js")
    $commandMatches = $entryMatches -and
      (Test-CommandLineArgument $snapshot.command_line "--serve") -and
      (Test-CommandLineArgument $snapshot.command_line "--env-file") -and
      (Test-CommandLineArgument $snapshot.command_line $expectedEnv)
    $recordImage = Normalize-ProcessImagePath $snapshot.executable_path
    $handleImage = Normalize-ProcessImagePath $snapshot.process_path
    if ([string]::Equals($recordImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($handleImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase) -and
        $commandMatches) {
      return $snapshot
    }
    return @{ state = "unowned"; process = $snapshot.process; reason = "PID does not identify this installation's resident Gateway" }
  } catch {
    return @{ state = "unknown"; process = $snapshot.process; reason = "resident process identity could not be verified: $($_.Exception.Message)" }
  }
}

function Quote-ProcessArgument($Value) {
  if ($Value -match "\s") {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Start-Resident {
  $existingPid = Read-ResidentPid
  if ($existingPid) {
    $existing = Get-ManagedResidentSnapshot $existingPid
    if ($existing.state -eq "running") {
      Write-Host "resident_status=running pid=$existingPid"
      return
    }
    if ($existing.state -ne "stopped") {
      Fail "Cannot safely replace resident PID $existingPid because ownership could not be verified. $($existing.reason)"
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
  }
  New-Item -ItemType Directory -Force -Path $dataRootResolved, $logDir | Out-Null
  $extraArgs = @($RemainingArgs | Where-Object { $_ -ne $null })
  $processArgsRaw = @("apps/gateway/dist/main.js", "--serve", "--env-file", $envFileResolved) + $extraArgs
  $processArgs = @($processArgsRaw | ForEach-Object { Quote-ProcessArgument $_ })
  $process = Start-Process -FilePath "node" -ArgumentList $processArgs -WorkingDirectory $installRootResolved -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  $started = Get-ManagedResidentSnapshot $process.Id
  if ($started.state -ne "running") {
    Fail "Resident Gateway was started but its process identity could not be confirmed; the PID record was preserved. $($started.reason)"
  }
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
  $snapshot = Get-ManagedResidentSnapshot $pidValue
  if ($snapshot.state -eq "stopped") {
    Write-Host "resident_status=stale pid=$pidValue"
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
    return
  }
  if ($snapshot.state -ne "running") {
    Fail "Refusing to stop resident PID $pidValue because ownership could not be verified. $($snapshot.reason)"
  }
  $process = $snapshot.process
  try {
    $initialStartTime = $process.StartTime.ToUniversalTime().Ticks
    $process.Refresh()
    if ($process.HasExited) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
      Write-Host "resident_status=stale pid=$pidValue"
      return
    }
    $rechecked = Get-ManagedResidentSnapshot $pidValue
    if ($rechecked.state -ne "running" -or $rechecked.process.StartTime.ToUniversalTime().Ticks -ne $initialStartTime) {
      Fail "Refusing to stop resident PID $pidValue because process identity changed during verification."
    }
    $process = $rechecked.process
    Stop-Process -InputObject $process -Force -ErrorAction Stop
    if (-not $process.WaitForExit(10000)) {
      Fail "Resident PID $pidValue did not exit within 10 seconds; its PID record was preserved."
    }
    $process.Refresh()
    if (-not $process.HasExited) {
      Fail "Resident PID $pidValue is still running; its PID record was preserved."
    }
  } catch {
    Fail "Could not confirm resident PID $pidValue exited; its PID record was preserved. $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
  Write-Host "resident_status=stopped pid=$pidValue"
}

function Show-ResidentStatus {
  $pidValue = Read-ResidentPid
  if (-not $pidValue) {
    Write-Host "resident_status=stopped"
  } else {
    $snapshot = Get-ManagedResidentSnapshot $pidValue
    if ($snapshot.state -eq "running") {
      Write-Host "resident_status=running pid=$pidValue"
    } elseif ($snapshot.state -eq "stopped") {
      Write-Host "resident_status=stale pid=$pidValue"
    } else {
      Fail "Cannot safely report resident PID $pidValue because ownership could not be verified. $($snapshot.reason)"
    }
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
