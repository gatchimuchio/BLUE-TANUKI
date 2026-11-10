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
$installGuardPath = Join-Path $installRoot "install\windows\safe-target.ps1"
if (-not (Test-Path -LiteralPath $installGuardPath -PathType Leaf)) {
  Fail "Product path safety guard is missing; runtime was not started: $installGuardPath"
}
$installGuardItem = Get-Item -Force -LiteralPath $installGuardPath
if (($installGuardItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $installGuardItem.Length -gt 262144) {
  Fail "Product path safety guard is not a bounded regular file; runtime was not started: $installGuardPath"
}
try { . $installGuardPath } catch {
  Fail "Product path safety guard could not be loaded; runtime was not started. $($_.Exception.Message)"
}

function Resolve-DataRoot {
  if (-not (Test-Path -LiteralPath $installMetadataPath -PathType Leaf)) {
    Fail "Product install metadata is missing; the runtime will not select a fallback data root: $installMetadataPath"
  }
  $metadataItem = Get-Item -Force -LiteralPath $installMetadataPath
  if (($metadataItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $metadataItem.Length -gt 65536) {
    Fail "Product install metadata is not a bounded regular file; runtime was not started: $installMetadataPath"
  }
  try {
    $metadata = Get-Content -LiteralPath $installMetadataPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $metadata -or $metadata.schema_version -ne 3 -or $metadata.product_id -ne "blue-tanuki-product-install" -or
        [string]::IsNullOrWhiteSpace([string]$metadata.install_root) -or
        [string]::IsNullOrWhiteSpace([string]$metadata.data_root) -or
        -not [string]::Equals((Get-InstallPathIdentity ([string]$metadata.install_root)), (Get-InstallPathIdentity $installRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Product install metadata does not identify this installation and its data root."
    }
    $targets = Assert-SafeInstallTargets -InstallRoot $installRoot -DataRoot ([string]$metadata.data_root) -SourceRoot $null
    return Assert-ManagedWindowsProductDataMarker -DataRoot $targets.DataRoot -InstallRoot $targets.InstallRoot
  } catch {
    Fail "Product DataRoot could not be verified; runtime was not started and no default was substituted. $($_.Exception.Message)"
  }
}

$dataRoot = Resolve-DataRoot
$envFile = Join-Path $dataRoot "blue-tanuki.env"
$dataDir = Join-Path $dataRoot "data"
$logDir = Join-Path $dataRoot "logs"
$pidFile = Join-Path $dataRoot "blue-tanuki.pid"
$watchdogPidFile = Join-Path $dataRoot "blue-tanuki-watchdog.pid"
$stdoutLog = Join-Path $logDir "blue-tanuki.out.log"
$stderrLog = Join-Path $logDir "blue-tanuki.err.log"
$watchdogLog = Join-Path $logDir "blue-tanuki-watchdog.out.log"
$watchdogErrLog = Join-Path $logDir "blue-tanuki-watchdog.err.log"
$doctorLog = Join-Path $logDir "doctor.json"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = if ($env:BLUE_TANUKI_AUTOSTART_RUN_NAME) { $env:BLUE_TANUKI_AUTOSTART_RUN_NAME } else { "BLUE-TANUKI" }

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

function Get-ProcessSnapshot($PidValue) {
  $process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if (-not $process) { return @{ state = "stopped"; process = $null } }
  try {
    $record = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction Stop
  } catch {
    return @{ state = "unknown"; process = $process; reason = "process identity could not be inspected: $($_.Exception.Message)" }
  }
  if (-not $record) {
    try { $process.Refresh() } catch { }
    if ($process.HasExited) { return @{ state = "stopped"; process = $null } }
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

function Get-ManagedProcessSnapshot($PidValue, $Kind) {
  $snapshot = Get-ProcessSnapshot $PidValue
  if ($snapshot.state -ne "running") { return $snapshot }

  try {
    if ($Kind -eq "resident") {
      $expectedImage = Normalize-ProcessImagePath (Find-NodeExe)
      $expectedEntry = Normalize-ProcessImagePath (Join-Path $installRoot "apps\gateway\dist\main.js")
      $expectedEnv = Normalize-ProcessImagePath $envFile
      $entryMatches = (Test-CommandLineArgument $snapshot.command_line $expectedEntry) -or
        (Test-CommandLineArgument $snapshot.command_line "apps/gateway/dist/main.js") -or
        (Test-CommandLineArgument $snapshot.command_line "apps\gateway\dist\main.js")
      $commandMatches = $entryMatches -and
        (Test-CommandLineArgument $snapshot.command_line "--serve") -and
        (Test-CommandLineArgument $snapshot.command_line "--env-file") -and
        (Test-CommandLineArgument $snapshot.command_line $expectedEnv)
    } elseif ($Kind -eq "watchdog") {
      $powerShell = Get-Command powershell.exe -CommandType Application -ErrorAction Stop
      $expectedImage = Normalize-ProcessImagePath $powerShell.Source
      $expectedEntry = Normalize-ProcessImagePath (Join-Path $installRoot "BlueTanukiLauncher.ps1")
      $commandMatches = (Test-CommandLineArgument $snapshot.command_line "-File") -and
        (Test-CommandLineArgument $snapshot.command_line $expectedEntry) -and
        ((Test-CommandLineArgument $snapshot.command_line "watchdog") -or
          (Test-CommandLineArgument $snapshot.command_line "watchdog-safe-mode"))
    } else {
      return @{ state = "unknown"; process = $snapshot.process; reason = "unknown managed process kind" }
    }
    $recordImage = Normalize-ProcessImagePath $snapshot.executable_path
    $handleImage = Normalize-ProcessImagePath $snapshot.process_path
    if ([string]::Equals($recordImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($handleImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase) -and
        $commandMatches) {
      return $snapshot
    }
    return @{ state = "unowned"; process = $snapshot.process; reason = "PID does not identify this installation's $Kind process" }
  } catch {
    return @{ state = "unknown"; process = $snapshot.process; reason = "managed process identity could not be verified: $($_.Exception.Message)" }
  }
}

function Get-ManagedProcessSet($Kind) {
  try {
    if ($Kind -eq "resident") {
      $expectedImage = Normalize-ProcessImagePath (Find-NodeExe)
      $expectedEntry = Normalize-ProcessImagePath (Join-Path $installRoot "apps\gateway\dist\main.js")
      $expectedEnv = Normalize-ProcessImagePath $envFile
    } elseif ($Kind -eq "watchdog") {
      $powerShell = Get-Command powershell.exe -CommandType Application -ErrorAction Stop
      $expectedImage = Normalize-ProcessImagePath $powerShell.Source
      $expectedEntry = Normalize-ProcessImagePath (Join-Path $installRoot "BlueTanukiLauncher.ps1")
      $expectedEnv = $null
    } else {
      return @{ state = "unknown"; processes = @(); reason = "unknown managed process kind" }
    }
    $records = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    return @{ state = "unknown"; processes = @(); reason = "process inventory could not be inspected: $($_.Exception.Message)" }
  }

  $matches = @()
  foreach ($record in $records) {
    $commandLine = [string]$record.CommandLine
    if ($Kind -eq "resident") {
      $entryMatches = (Test-CommandLineArgument $commandLine $expectedEntry) -or
        (Test-CommandLineArgument $commandLine "apps/gateway/dist/main.js") -or
        (Test-CommandLineArgument $commandLine "apps\gateway\dist\main.js")
      if (-not $entryMatches -or -not (Test-CommandLineArgument $commandLine "--serve")) {
        if ([string]::IsNullOrWhiteSpace($commandLine) -and $record.ExecutablePath) {
          try {
            if ([string]::Equals((Normalize-ProcessImagePath $record.ExecutablePath), $expectedImage, [System.StringComparison]::OrdinalIgnoreCase)) {
              return @{ state = "unknown"; processes = @(); reason = "a bundled runtime process has no inspectable command line" }
            }
          } catch { }
        }
        continue
      }
      if (-not (Test-CommandLineArgument $commandLine "--env-file") -or
          -not (Test-CommandLineArgument $commandLine $expectedEnv)) {
        return @{ state = "unknown"; processes = @(); reason = "a process uses this Gateway entry but its DataRoot could not be verified" }
      }
    } else {
      $entryMatches = (Test-CommandLineArgument $commandLine "-File") -and
        (Test-CommandLineArgument $commandLine $expectedEntry)
      if (-not $entryMatches) {
        if ([string]::IsNullOrWhiteSpace($commandLine) -and $record.ExecutablePath) {
          try {
            if ([string]::Equals((Normalize-ProcessImagePath $record.ExecutablePath), $expectedImage, [System.StringComparison]::OrdinalIgnoreCase)) {
              return @{ state = "unknown"; processes = @(); reason = "a PowerShell process has no inspectable command line" }
            }
          } catch { }
        }
        continue
      }
      if (-not ((Test-CommandLineArgument $commandLine "watchdog") -or
          (Test-CommandLineArgument $commandLine "watchdog-safe-mode"))) {
        continue
      }
    }

    try {
      $recordImage = Normalize-ProcessImagePath ([string]$record.ExecutablePath)
      if (-not [string]::Equals($recordImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase)) {
        return @{ state = "unknown"; processes = @(); reason = "a process uses this product entry from an unexpected executable" }
      }
      $process = Get-Process -Id ([int]$record.ProcessId) -ErrorAction SilentlyContinue
      if (-not $process) { continue }
      $process.Refresh()
      if ($process.HasExited) { continue }
      $handleImage = Normalize-ProcessImagePath $process.Path
      if (-not [string]::Equals($handleImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase)) {
        return @{ state = "unknown"; processes = @(); reason = "process identity changed while it was inspected" }
      }
      $matches += $process
    } catch {
      return @{ state = "unknown"; processes = @(); reason = "a matching process could not be verified: $($_.Exception.Message)" }
    }
  }

  if ($matches.Count -gt 1) {
    return @{ state = "ambiguous"; processes = @(); reason = "multiple matching product processes were found" }
  }
  if ($matches.Count -eq 1) {
    return @{ state = "running"; processes = $matches; process = $matches[0] }
  }
  return @{ state = "stopped"; processes = @() }
}

function Stop-VerifiedProcess($Process, $Label) {
  try {
    $Process.Refresh()
    if ($Process.HasExited) { return }
    Stop-Process -InputObject $Process -Force -ErrorAction Stop
    if (-not $Process.WaitForExit(10000)) {
      Fail "$Label did not exit after the stop request; its PID record was preserved."
    }
    $Process.Refresh()
    if (-not $Process.HasExited) {
      Fail "$Label is still running after the stop request; its PID record was preserved."
    }
  } catch {
    Fail "Could not confirm that $Label exited; its PID record was preserved. $($_.Exception.Message)"
  }
}

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
  try { $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop } catch {
    Fail "The resident PID record could not be read, so process ownership cannot be verified. $($_.Exception.Message)"
  }
  $pidValue = 0
  if ([int]::TryParse(([string]$raw).Trim(), [ref]$pidValue) -and $pidValue -gt 0) {
    return $pidValue
  }
  Fail "The resident PID record is invalid, so process ownership cannot be verified."
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
    $processSet = Get-ManagedProcessSet "resident"
    if ($processSet.state -eq "running") {
      Set-Content -LiteralPath $pidFile -Value $processSet.process.Id -Encoding ASCII
      return $true
    }
    if ($processSet.state -eq "stopped") { return $false }
    Fail "Cannot safely replace resident process state because ownership could not be verified. $($processSet.reason)"
  }
  $snapshot = Get-ManagedProcessSnapshot $pidValue "resident"
  if ($snapshot.state -eq "running") { return $true }
  if ($snapshot.state -eq "unowned" -or $snapshot.state -eq "unknown") {
    Fail "Cannot safely replace resident PID $pidValue because ownership could not be verified. $($snapshot.reason)"
  }
  $processSet = Get-ManagedProcessSet "resident"
  if ($processSet.state -eq "running") {
    Set-Content -LiteralPath $pidFile -Value $processSet.process.Id -Encoding ASCII
    return $true
  }
  if ($processSet.state -ne "stopped") {
    Fail "Cannot safely replace resident PID $pidValue because process ownership could not be verified. $($processSet.reason)"
  }
  return $false
}

function Read-WatchdogPid {
  if (-not (Test-Path -LiteralPath $watchdogPidFile)) {
    return $null
  }
  try { $raw = Get-Content -LiteralPath $watchdogPidFile -Raw -ErrorAction Stop } catch {
    Fail "The watchdog PID record could not be read, so process ownership cannot be verified. $($_.Exception.Message)"
  }
  $pidValue = 0
  if ([int]::TryParse(([string]$raw).Trim(), [ref]$pidValue) -and $pidValue -gt 0) {
    return $pidValue
  }
  Fail "The watchdog PID record is invalid, so process ownership cannot be verified."
}

function Test-WatchdogRunning {
  $pidValue = Read-WatchdogPid
  if (-not $pidValue) {
    $processSet = Get-ManagedProcessSet "watchdog"
    if ($processSet.state -eq "running") {
      Set-Content -LiteralPath $watchdogPidFile -Value $processSet.process.Id -Encoding ASCII
      return $true
    }
    if ($processSet.state -eq "stopped") { return $false }
    Fail "Cannot safely replace watchdog process state because ownership could not be verified. $($processSet.reason)"
  }
  $snapshot = Get-ManagedProcessSnapshot $pidValue "watchdog"
  if ($snapshot.state -eq "running") { return $true }
  if ($snapshot.state -eq "unowned" -or $snapshot.state -eq "unknown") {
    Fail "Cannot safely replace watchdog PID $pidValue because ownership could not be verified. $($snapshot.reason)"
  }
  $processSet = Get-ManagedProcessSet "watchdog"
  if ($processSet.state -eq "running") {
    Set-Content -LiteralPath $watchdogPidFile -Value $processSet.process.Id -Encoding ASCII
    return $true
  }
  if ($processSet.state -ne "stopped") {
    Fail "Cannot safely replace watchdog PID $pidValue because process ownership could not be verified. $($processSet.reason)"
  }
  return $false
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

function Start-ResidentProcess($SafeMode = $false, $Reason = "manual") {
  Ensure-EnvFile
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
  Write-Host "resident_launch_reason=$Reason pid=$($process.Id)"
  return $process
}

function Start-Watchdog($SafeMode = $false) {
  if (Test-WatchdogRunning) {
    Write-Host "watchdog_status=running pid=$(Read-WatchdogPid)"
    return
  }
  New-Item -ItemType Directory -Force -Path $dataRoot, $logDir | Out-Null
  $watchdogCommand = "watchdog"
  if ($SafeMode) {
    $watchdogCommand = "watchdog-safe-mode"
  }
  $watchdogArgs = @(
    "-NoProfile",
    "-File",
    (Quote-Arg $PSCommandPath),
    $watchdogCommand
  )
  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $watchdogArgs -WorkingDirectory $installRoot -WindowStyle Hidden -RedirectStandardOutput $watchdogLog -RedirectStandardError $watchdogErrLog -PassThru
  $watchdogStillRunning = $false
  try {
    $watchdogStillRunning = -not $process.WaitForExit(750)
    $process.Refresh()
    $watchdogStillRunning = $watchdogStillRunning -and -not $process.HasExited
  } catch {
    try {
      $process.Refresh()
      $watchdogStillRunning = -not $process.HasExited
    } catch {
      $watchdogStillRunning = $false
    }
  }
  if (-not $watchdogStillRunning) {
    $exitCode = "unknown"
    try { $exitCode = [string]$process.ExitCode } catch { }
    Fail "Watchdog exited before becoming active (exit code $exitCode). The Gateway may still be running without automatic recovery; inspect status before retrying. The existing PowerShell execution policy was not overridden; review $watchdogErrLog."
  }
  Set-Content -LiteralPath $watchdogPidFile -Value $process.Id -Encoding ASCII
  Write-Host "watchdog_status=started pid=$($process.Id)"
}

function Start-Resident($SafeMode = $false) {
  Ensure-EnvFile
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
    Start-Watchdog $SafeMode
    return
  }
  $process = Start-ResidentProcess $SafeMode "manual"
  Start-Watchdog $SafeMode
  if (Wait-Health 15000) {
    Write-Host "resident_status=started pid=$($process.Id)"
  } else {
    Write-Warning "resident started but health did not become ready within timeout. Logs: $logDir"
  }
  Write-Host "control_center=$(Get-ControlCenterUrl)"
  Write-Host "logs=$logDir"
}

function Stop-Watchdog {
  $pidValue = Read-WatchdogPid
  $processes = @()
  if ($pidValue -ne $PID) {
    if ($pidValue) {
      $snapshot = Get-ManagedProcessSnapshot $pidValue "watchdog"
      if ($snapshot.state -eq "running") { $processes += $snapshot.process }
      elseif ($snapshot.state -ne "stopped") {
        Fail "Refusing to stop watchdog PID $pidValue because ownership could not be verified. $($snapshot.reason)"
      } else {
        Write-Host "watchdog_status=stale pid=$pidValue"
      }
    }
    $processSet = Get-ManagedProcessSet "watchdog"
    if ($processSet.state -eq "running") {
      foreach ($process in $processSet.processes) {
        if (-not ($processes | Where-Object { $_.Id -eq $process.Id })) { $processes += $process }
      }
    } elseif ($processSet.state -ne "stopped") {
      Fail "Refusing to stop watchdog processes because ownership could not be verified. $($processSet.reason)"
    }
    foreach ($process in $processes) {
      Stop-VerifiedProcess $process "watchdog"
      Write-Host "watchdog_status=stopped pid=$($process.Id)"
    }
    $remaining = Get-ManagedProcessSet "watchdog"
    if ($remaining.state -ne "stopped") {
      Fail "Refusing to clear watchdog PID record because shutdown could not be confirmed. $($remaining.reason)"
    }
  } else {
    $remaining = Get-ManagedProcessSet "watchdog"
    if ($remaining.state -ne "stopped") {
      Fail "Refusing to stop watchdog PID $pidValue because ownership could not be verified. $($remaining.reason)"
    }
  }
  if ($pidValue) { Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction Stop }
}

function Stop-Resident {
  Stop-Watchdog
  $pidValue = Read-ResidentPid
  $processes = @()
  if ($pidValue) {
    $snapshot = Get-ManagedProcessSnapshot $pidValue "resident"
    if ($snapshot.state -eq "running") { $processes += $snapshot.process }
    elseif ($snapshot.state -ne "stopped") {
      Fail "Refusing to stop resident PID $pidValue because ownership could not be verified. $($snapshot.reason)"
    } else {
      Write-Host "resident_status=stale pid=$pidValue"
    }
  }
  $processSet = Get-ManagedProcessSet "resident"
  if ($processSet.state -eq "running") {
    foreach ($process in $processSet.processes) {
      if (-not ($processes | Where-Object { $_.Id -eq $process.Id })) { $processes += $process }
    }
  } elseif ($processSet.state -ne "stopped") {
    Fail "Refusing to stop resident processes because ownership could not be verified. $($processSet.reason)"
  }
  foreach ($process in $processes) {
    Stop-VerifiedProcess $process "resident runtime"
    Write-Host "resident_status=stopped pid=$($process.Id)"
  }
  $remaining = Get-ManagedProcessSet "resident"
  if ($remaining.state -ne "stopped") {
    Fail "Refusing to clear resident PID record because shutdown could not be confirmed. $($remaining.reason)"
  }
  if ($pidValue) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop }
  if (-not $processes.Count) { Write-Host "resident_status=stopped" }
}

function Show-Status {
  if (Test-ResidentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
  } else {
    Write-Host "resident_status=stopped"
  }
  if (Test-WatchdogRunning) {
    Write-Host "watchdog_status=running pid=$(Read-WatchdogPid)"
  } else {
    Write-Host "watchdog_status=stopped"
  }
  Write-Host "control_center=$(Get-ControlCenterUrl)"
  Write-Host "env_file=$envFile"
  Write-Host "logs=$logDir"
}

function Run-Watchdog($SafeMode = $false) {
  Ensure-EnvFile
  New-Item -ItemType Directory -Force -Path $dataRoot, $dataDir, $logDir | Out-Null
  Set-Content -LiteralPath $watchdogPidFile -Value $PID -Encoding ASCII
  Write-Host "watchdog_status=running pid=$PID safe_mode=$SafeMode"
  while ($true) {
    if (-not (Test-ResidentRunning)) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      try {
        $process = Start-ResidentProcess $SafeMode "watchdog"
        Write-Host "watchdog_restarted=pass pid=$($process.Id)"
      } catch {
        Write-Warning "watchdog restart deferred: $($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 5
  }
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
  $doctorErrorLog = Join-Path $logDir "doctor.stderr.log"
  Push-Location $installRoot
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5.1 promotes native stderr to an error record. Keep
      # a warning on stderr from aborting Doctor while still checking Node's exit code.
      $ErrorActionPreference = "Continue"
      & $nodeExe "apps/gateway/dist/main.js" "--doctor" "--env-file" $envFile "--json" > $doctorLog 2> $doctorErrorLog
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    Write-Host "doctor_exit_code=$code"
    Write-Host "doctor_log=$doctorLog"
    Write-Host "doctor_stderr_log=$doctorErrorLog"
    if ($OpenLog) {
      Start-Process $doctorLog
    } else {
      Get-Content -LiteralPath $doctorLog -Tail 120
      if ((Test-Path -LiteralPath $doctorErrorLog -PathType Leaf) -and (Get-Item -LiteralPath $doctorErrorLog).Length -gt 0) {
        Get-Content -LiteralPath $doctorErrorLog -Tail 120
      }
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

function Enable-Autostart {
  New-Item -Path $runKey -Force | Out-Null
  $value = "powershell.exe -NoProfile -File `"$PSCommandPath`" resident-start"
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
  "open" { Open-ControlCenter }
  "start" { Start-Resident $false }
  "resident-start" { Start-Resident $false }
  "safe-mode" { Start-SafeMode }
  "resident-safe-mode" { Start-SafeMode }
  "watchdog" { Run-Watchdog $false }
  "watchdog-safe-mode" { Run-Watchdog $true }
  "stop" { Stop-Resident }
  "resident-stop" { Stop-Resident }
  "restart" { Stop-Resident; Start-Resident $false }
  "status" { Show-Status }
  "resident-status" { Show-Status }
  "doctor" { Run-Doctor $false }
  "doctor-open" { Run-Doctor $true }
  "logs" { Open-Logs }
  "resident-logs" { Open-Logs }
  "autostart-enable" { Enable-Autostart }
  "resident-autostart-enable" { Enable-Autostart }
  "autostart-disable" { Disable-Autostart }
  "resident-autostart-disable" { Disable-Autostart }
  "autostart-status" { Show-AutostartStatus }
  "resident-autostart-status" { Show-AutostartStatus }
  "help" {
    Write-Host "Usage: BlueTanukiLauncher.ps1 [open|start|safe-mode|stop|restart|status|doctor|doctor-open|logs|autostart-enable|autostart-disable|autostart-status|help]"
    Write-Host "Autostart is opt-in only and is not enabled by install/setup."
  }
  default { Fail "unknown command: $Command" }
}
