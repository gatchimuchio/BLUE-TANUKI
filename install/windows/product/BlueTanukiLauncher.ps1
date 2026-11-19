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
$runName = if ([string]::IsNullOrWhiteSpace($env:BLUE_TANUKI_AUTOSTART_RUN_NAME)) { "BLUE-TANUKI" } else { ([string]$env:BLUE_TANUKI_AUTOSTART_RUN_NAME).Trim() }
$script:autostartRunNameValid = $runName -match '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'
$script:autostartCommand = "powershell.exe -NoProfile -File `"$PSCommandPath`" resident-start"

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
      if ($record.Name -and -not [string]::Equals([string]$record.Name, "node.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $absoluteEntryMatches = Test-CommandLineArgument $commandLine $expectedEntry
      $relativeEntryMatches = (Test-CommandLineArgument $commandLine "apps/gateway/dist/main.js") -or
        (Test-CommandLineArgument $commandLine "apps\gateway\dist\main.js")
      $entryMatches = $absoluteEntryMatches -or $relativeEntryMatches
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
        $expectedImageMatches = $false
        try {
          if ($record.ExecutablePath) {
            $recordImage = Normalize-ProcessImagePath ([string]$record.ExecutablePath)
            $expectedImageMatches = [string]::Equals($recordImage, $expectedImage, [System.StringComparison]::OrdinalIgnoreCase)
          }
        } catch {
          return @{ state = "unknown"; processes = @(); reason = "a Gateway process executable path could not be inspected" }
        }
        if ($absoluteEntryMatches -or $expectedImageMatches -or [string]::IsNullOrWhiteSpace([string]$record.ExecutablePath)) {
          return @{ state = "unknown"; processes = @(); reason = "a process uses this Gateway entry but its DataRoot could not be verified" }
        }
        # Relative Gateway arguments are common in source and other install roots.
        # Without this install's runtime or env-file, they do not identify this installation.
        continue
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

$script:installedWebChatConfiguration = $null

function Invoke-InstalledWebChatHelper($Action, $TargetAddress = "", $ExpectedDigest = "", $ResidentPid = "", $ResidentStart = "") {
  $nodeExe = Find-NodeExe
  $helper = @'
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as connectTcp, isIP } from "node:net";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import { loadEnvFile } from "./apps/gateway/dist/env_file.js";

async function verifyResidentPeer(socket, residentPid, residentStart) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[1-9][0-9]*$/.test(residentPid) || !/^[1-9][0-9]*$/.test(residentStart) ||
      !socket.localAddress || !socket.localPort || !socket.remoteAddress || !socket.remotePort) {
    throw new Error("launch_resident_peer_unverified");
  }
  const powershellRoot = join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const verifyScript = [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules/NetTCPIP/NetTCPIP.psd1')",
    "function Normalize-Address($Address) {",
    "  $ip = [Net.IPAddress]::Parse($Address)",
    "  if ($ip.IsIPv4MappedToIPv6) { return $ip.MapToIPv4().ToString() }",
    "  return $ip.ToString()",
    "}",
    "$server = Normalize-Address $env:BT_HANDOFF_SERVER_ADDRESS",
    "$client = Normalize-Address $env:BT_HANDOFF_CLIENT_ADDRESS",
    "$rows = @(Get-NetTCPConnection -State Established -LocalPort ([int]$env:BT_HANDOFF_SERVER_PORT) -RemotePort ([int]$env:BT_HANDOFF_CLIENT_PORT) | Where-Object {",
    "  (Normalize-Address $_.LocalAddress) -eq $server -and (Normalize-Address $_.RemoteAddress) -eq $client",
    "})",
    "if ($rows.Count -ne 1 -or $rows[0].OwningProcess -ne [int]$env:BT_HANDOFF_RESIDENT_PID) { exit 2 }",
    "$resident = Get-Process -Id ([int]$env:BT_HANDOFF_RESIDENT_PID)",
    "if ([string]$resident.StartTime.ToUniversalTime().Ticks -cne $env:BT_HANDOFF_RESIDENT_START) { exit 2 }",
  ].join("\n");
  await promisify(execFile)(join(powershellRoot, "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", verifyScript], {
      windowsHide: true, timeout: 5000, maxBuffer: 4096,
      env: {
        SystemRoot: systemRoot,
        BT_HANDOFF_SERVER_ADDRESS: socket.remoteAddress,
        BT_HANDOFF_SERVER_PORT: String(socket.remotePort),
        BT_HANDOFF_CLIENT_ADDRESS: socket.localAddress,
        BT_HANDOFF_CLIENT_PORT: String(socket.localPort),
        BT_HANDOFF_RESIDENT_PID: residentPid,
        BT_HANDOFF_RESIDENT_START: residentStart,
      },
    });
}

try {
  const [, , envFile, action, targetAddress, expectedDigest, residentPid, residentStart] = process.argv;
  await loadEnvFile(envFile);
  const env = process.env;
  const host = env.WEBCHAT_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(env.WEBCHAT_PORT ?? "8787", 10);
  const cert = env.WEBCHAT_TLS_CERT_FILE?.trim() || "";
  const key = env.WEBCHAT_TLS_KEY_FILE?.trim() || "";
  if ((!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.?$/i.test(host)) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || Boolean(cert) !== Boolean(key)) {
    throw new Error("installed_webchat_configuration_invalid");
  }
  const scheme = cert ? "https" : "http";
  const normalizedHost = host.toLowerCase();
  const listenAddress = isIP(host) ? host : (await lookup(host)).address;
  let loopbackAddresses = [];
  let openHost = host;
  if (normalizedHost === "localhost" || normalizedHost === "localhost.") {
    if (listenAddress === "::1" || listenAddress.startsWith("127.")) loopbackAddresses = [listenAddress];
  } else if (normalizedHost === "0.0.0.0") {
    openHost = "127.0.0.1";
    loopbackAddresses = [openHost];
  } else if (normalizedHost === "::") {
    openHost = "::1";
    loopbackAddresses = [openHost];
  } else if (normalizedHost === "::1" || (isIP(host) === 4 && host.startsWith("127."))) {
    loopbackAddresses = [host];
  }
  const credentials = [
    env.WEBCHAT_TOKEN, env.WEBCHAT_RESUME_TOKEN, env.BLUE_TANUKI_OWNER_TOKEN,
    env.BLUE_TANUKI_SETTINGS_TOKEN, env.BLUE_TANUKI_MAINTENANCE_TOKEN,
  ];
  const digest = createHash("sha256").update(JSON.stringify([
    host, listenAddress, port, env.WEBCHAT_PUBLIC_HOST, scheme, cert, key,
  ])).digest("hex");
  if (action === "describe") {
    process.stdout.write(JSON.stringify({ host, listenAddress, port, scheme, openHost, loopbackAddresses, digest }));
  } else if ((action === "ticket" || action === "resident-mode") && digest === expectedDigest &&
             loopbackAddresses.includes(targetAddress) && credentials[0]) {
    const issueTicket = action === "ticket";
    const [chat, resume, owner, settings, maintenance] = credentials;
    const headers = { authorization: "Bearer " + chat };
    if (issueTicket) {
      headers["content-type"] = "application/json";
      headers["content-length"] = 2;
      if (resume) headers["x-blue-tanuki-launch-resume"] = resume;
      if (owner) headers["x-blue-tanuki-launch-owner"] = owner;
      if (settings) headers["x-blue-tanuki-launch-settings"] = settings;
      if (maintenance) headers["x-blue-tanuki-launch-maintenance"] = maintenance;
    }
    const maxResponseBytes = issueTicket ? 4096 : 256 * 1024;
    const secure = scheme === "https";
    const socket = secure
      ? connectTls({ host: targetAddress, port, rejectUnauthorized: true })
      : connectTcp({ host: targetAddress, port });
    socket.on("error", () => {});
    const agent = secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
    try {
      await once(socket, secure ? "secureConnect" : "connect", { signal: AbortSignal.timeout(2500) });
      await verifyResidentPeer(socket, residentPid, residentStart);
      if (socket.destroyed || !socket.writable || socket.readableEnded) throw new Error("launch_resident_peer_closed");

      // Send only through the exact connected socket whose reverse tuple was verified.
      agent.createConnection = () => socket;
      const request = secure ? httpsRequest : httpRequest;
      const body = await new Promise((resolve, reject) => {
        const client = request({
          hostname: targetAddress, port,
          path: issueTicket ? "/control-center/launch-handoff" : "/runtime/snapshot",
          method: issueTicket ? "POST" : "GET", headers, agent, signal: AbortSignal.timeout(5000),
        }, (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            resolve(null);
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("error", reject);
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) response.destroy(new Error("launch_resident_response_too_large"));
            else chunks.push(chunk);
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        client.on("error", reject);
        client.end(issueTicket ? "{}" : undefined);
      });
      if (body) {
        const response = JSON.parse(body);
        if (issueTicket && typeof response.ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(response.ticket)) {
          process.stdout.write(response.ticket);
        } else if (!issueTicket && typeof response.safe_mode === "boolean") {
          process.stdout.write(response.safe_mode ? "safe" : "normal");
        }
      }
    } finally {
      agent.destroy();
      socket.destroy();
    }
  }
} catch {
  process.exitCode = 2;
}
'@
  $previousErrorActionPreference = $ErrorActionPreference
  Push-Location $installRoot
  try {
    $ErrorActionPreference = "Continue"
    $output = $helper | & $nodeExe "--input-type=module" "-" $envFile $Action $TargetAddress $ExpectedDigest $ResidentPid $ResidentStart 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $output
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
}

function Get-InstalledWebChatConfiguration {
  if ($null -eq $script:installedWebChatConfiguration) {
    $description = Invoke-InstalledWebChatHelper "describe"
    if (-not $description) { Fail "The installed WebChat configuration could not be read by the bundled Gateway." }
    try { $script:installedWebChatConfiguration = $description | ConvertFrom-Json }
    catch { Fail "The bundled Gateway returned invalid WebChat routing metadata." }
  }
  return $script:installedWebChatConfiguration
}

function Format-ControlCenterHost($HostValue) {
  if ($HostValue.Contains(":")) { return "[$HostValue]" }
  return $HostValue
}

function Get-ControlCenterUrl($TargetAddress = "") {
  $config = Get-InstalledWebChatConfiguration
  if (-not $TargetAddress) { $TargetAddress = $config.openHost }
  return "$($config.scheme)://$(Format-ControlCenterHost $TargetAddress):$($config.port)/app"
}

function Get-VerifiedControlCenterListener($Config) {
  try {
    $residentPid = Read-ResidentPid
    if (-not $residentPid) { return $null }
    $resident = Get-ManagedProcessSnapshot $residentPid "resident"
    if ($resident.state -ne "running") { return $null }
    $startTime = [string]$resident.process.StartTime.ToUniversalTime().Ticks
    $listeners = @(Get-NetTCPConnection -LocalPort $Config.port -State Listen -ErrorAction Stop)
    foreach ($address in $Config.loopbackAddresses) {
      $wildcard = if ($address.Contains(":")) { "::" } else { "0.0.0.0" }
      $bound = @($listeners | Where-Object { $_.LocalAddress -in @($address, $wildcard) })
      if ($bound.Count -eq 1 -and $bound[0].OwningProcess -eq $residentPid) {
        return [pscustomobject]@{ address = $address; processId = [string]$residentPid; startTime = $startTime }
      }
    }
  } catch { return $null }
  return $null
}

function Test-ControlCenterHealth($HealthUrl, $TimeoutMs) {
  $request = $null
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($HealthUrl)
    $request.Method = "GET"
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMs
    $request.ReadWriteTimeout = $TimeoutMs
    $response = $request.GetResponse()
    return [int]$response.StatusCode -eq 200
  } catch {
    return $false
  } finally {
    if ($response) { $response.Dispose() }
  }
}

function Get-HealthUrl {
  $config = Get-InstalledWebChatConfiguration
  return "$($config.scheme)://$(Format-ControlCenterHost $config.openHost):$($config.port)/healthz"
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

function Test-PortBindable($ListenAddress, $Port) {
  $listener = $null
  try {
    $address = [System.Net.IPAddress]::Parse($ListenAddress)
    $listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
    if ($address.Equals([System.Net.IPAddress]::IPv6Any)) { $listener.Server.DualMode = $true }
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
  $config = Get-InstalledWebChatConfiguration
  $hostName = $config.host
  $port = $config.port
  if (-not (Test-PortBindable $config.listenAddress $port)) {
    Fail "port_conflict=${hostName}:$port. Stop the process using this port, change WEBCHAT_PORT in $envFile, or launch BLUE-TANUKI Safe Mode after repair. Logs: $logDir"
  }
}

function Wait-Health($TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $healthUrl = Get-HealthUrl
  while ((Get-Date) -lt $deadline) {
    if (Test-ControlCenterHealth $healthUrl 2000) { return $true }
    Start-Sleep -Milliseconds 250
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
  if ($Reason -eq "watchdog") { $script:installedWebChatConfiguration = $null }
  Assert-PortAvailable
  if ($SafeMode) {
    Set-SafeModeEnvironment
    Write-Host "safe_mode=enabled"
  }
  New-Item -ItemType Directory -Force -Path $dataRoot, $dataDir, $logDir | Out-Null
  $nodeExe = Find-NodeExe
  $env:BLUE_TANUKI_ENV_FILE = $envFile
  $env:BLUE_TANUKI_INSTALL_ROOT = $installRoot
  $env:BLUE_TANUKI_DATA_ROOT = $dataRoot
  $rawArgs = @("--", "apps/gateway/dist/main.js", "--serve", "--env-file", $envFile)
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

function Get-RunningResidentSafeMode {
  $config = Get-InstalledWebChatConfiguration
  $listener = Get-VerifiedControlCenterListener $config
  if (-not $listener) { return $null }
  $mode = Invoke-InstalledWebChatHelper "resident-mode" $listener.address $config.digest $listener.processId $listener.startTime
  if ($mode -cnotin @("safe", "normal")) { return $null }
  $current = Get-VerifiedControlCenterListener $config
  if (-not $current -or $current.processId -cne $listener.processId -or
      $current.startTime -cne $listener.startTime -or $current.address -cne $listener.address) { return $null }
  return $mode -ceq "safe"
}

function Start-Resident($SafeMode = $false) {
  Ensure-EnvFile
  $alreadyRunning = Test-ResidentRunning
  $process = $null
  if ($alreadyRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
  } else {
    $process = Start-ResidentProcess $SafeMode "manual"
    Start-Watchdog $SafeMode
  }

  if (Wait-Health 15000) {
    if ($alreadyRunning) {
      Write-Host "resident_health=ready pid=$(Read-ResidentPid)"
      if (Test-WatchdogRunning) {
        Write-Host "watchdog_status=running pid=$(Read-WatchdogPid)"
      } else {
        $runningMode = Get-RunningResidentSafeMode
        if ($null -eq $runningMode) {
          Write-Warning "Automatic recovery was not restored because the current Gateway mode could not be verified. Use BLUE-TANUKI Restart or BLUE-TANUKI Safe Mode."
        } else {
          Start-Watchdog $runningMode
        }
      }
    } else {
      Write-Host "resident_status=started pid=$($process.Id)"
    }
    Write-Host "control_center=$(Get-ControlCenterUrl)"
    Write-Host "logs=$logDir"
    return $true
  }

  if ($alreadyRunning) {
    Write-Warning "resident_health=not_ready; the existing managed process was left running. Logs: $logDir"
  } else {
    Write-Warning "resident_health=not_ready; the launched process was left running. Logs: $logDir"
  }
  Write-Host "next_action=Run BlueTanukiDoctor.cmd and review its log before retrying."
  Write-Host "logs=$logDir"
  return $false
}

function Start-ResidentCommand($SafeMode = $false) {
  if (-not (Start-Resident $SafeMode)) {
    Fail "Gateway health did not become ready. The Control Center was not opened. Run BlueTanukiDoctor.cmd and review $logDir."
  }
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
  $residentRunning = Test-ResidentRunning
  if ($residentRunning) {
    Write-Host "resident_status=running pid=$(Read-ResidentPid)"
    $config = Get-InstalledWebChatConfiguration
    if ($config.loopbackAddresses.Count -eq 0) {
      Write-Host "resident_health=unobserved_non_loopback_binding"
    } elseif (Test-ControlCenterHealth (Get-HealthUrl) 1000) {
      Write-Host "resident_health=ready"
    } else {
      Write-Host "resident_health=not_ready"
      Write-Host "resident_health_next_action=Run BlueTanukiDoctor.cmd and review logs before retrying."
    }
  } else {
    Write-Host "resident_status=stopped"
    Write-Host "resident_health=not_running"
  }
  if (Test-WatchdogRunning) {
    Write-Host "watchdog_status=running pid=$(Read-WatchdogPid)"
  } else {
    Write-Host "watchdog_status=stopped"
    if ($residentRunning) { Write-Host "watchdog_next_action=Use BLUE-TANUKI Restart or BLUE-TANUKI Safe Mode to restore automatic recovery." }
  }
  if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    Write-Host "control_center=$(Get-ControlCenterUrl)"
  }
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
  if (-not (Start-Resident $false)) {
    Fail "The Control Center was not opened because Gateway health is not ready. Run BlueTanukiDoctor.cmd and review $logDir."
  }
  $config = Get-InstalledWebChatConfiguration
  $listener = Get-VerifiedControlCenterListener $config
  $url = Get-ControlCenterUrl
  $ticket = if ($listener) {
    Invoke-InstalledWebChatHelper "ticket" $listener.address $config.digest $listener.processId $listener.startTime
  } else { $null }
  if ($ticket -and $ticket -cmatch '^[A-Za-z0-9_-]{43}$') {
    $url = "$(Get-ControlCenterUrl $listener.address)#bt-launch-handoff=$ticket"
  } elseif ($config.loopbackAddresses.Count -gt 0) {
    Write-Warning "The local Control Center session could not be connected automatically. No credential was added to the browser URL."
  }
  Start-Process $url
}

function Start-SafeMode {
  Stop-Resident
  Start-ResidentCommand $true
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

function Run-RecoveryDiagnostic($Operation) {
  $nodeExe = Find-NodeExe
  $previousErrorActionPreference = $ErrorActionPreference
  $previousEnvFile = $env:BLUE_TANUKI_ENV_FILE
  Push-Location $installRoot
  try {
    $ErrorActionPreference = "Continue"
    $env:BLUE_TANUKI_ENV_FILE = $envFile
    # Keep --env-file in Gateway's argv so Node does not preload it.
    & $nodeExe "--" "apps/gateway/dist/main.js" $Operation "--env-file" $envFile @RemainingArgs
    $code = $LASTEXITCODE
  } finally {
    $env:BLUE_TANUKI_ENV_FILE = $previousEnvFile
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  exit $code
}

function Open-Logs {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process $logDir
}

function Read-AutostartEntry {
  if (-not $script:autostartRunNameValid) {
    Fail "BLUE_TANUKI_AUTOSTART_RUN_NAME must be 1-64 safe registry-name characters; no autostart action was performed."
  }
  if (-not (Test-Path -LiteralPath $runKey)) {
    return [pscustomobject]@{ exists = $false; value = $null; kind = $null }
  }
  try {
    $key = Get-Item -LiteralPath $runKey -ErrorAction Stop
    if ($key.GetValueNames() -notcontains $runName) {
      return [pscustomobject]@{ exists = $false; value = $null; kind = $null }
    }
    return [pscustomobject]@{
      exists = $true
      value = $key.GetValue($runName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      kind = $key.GetValueKind($runName)
    }
  } catch {
    Fail "Could not inspect the per-user autostart entry. No registry value was changed. $($_.Exception.Message)"
  }
}

function Test-ManagedAutostartEntry($Entry) {
  return $Entry.exists -and $Entry.kind -eq [Microsoft.Win32.RegistryValueKind]::String -and
    $Entry.value -is [string] -and
    [string]::Equals([string]$Entry.value, [string]$script:autostartCommand, [System.StringComparison]::OrdinalIgnoreCase)
}

function Enable-Autostart {
  $current = Read-AutostartEntry
  if ($current.exists) {
    if (Test-ManagedAutostartEntry $current) {
      Write-Host "autostart_status=enabled"
      Write-Host "autostart_entry=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\$runName"
      return
    }
    Fail "Refusing to replace an existing per-user autostart value not owned by this BLUE-TANUKI install. Preserved: HKCU\Software\Microsoft\Windows\CurrentVersion\Run\$runName"
  }
  New-Item -Path $runKey -Force | Out-Null
  try {
    New-ItemProperty -Path $runKey -Name $runName -Value $script:autostartCommand -PropertyType String -ErrorAction Stop | Out-Null
  } catch {
    Fail "Could not create the per-user autostart entry without replacing an existing value. No existing entry was overwritten. $($_.Exception.Message)"
  }
  $created = Read-AutostartEntry
  if (-not (Test-ManagedAutostartEntry $created)) {
    Fail "The per-user autostart entry did not read back as the exact managed command. No existing value was overwritten."
  }
  Write-Host "autostart_status=enabled"
  Write-Host "autostart_entry=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\$runName"
}

function Disable-Autostart {
  $current = Read-AutostartEntry
  if (-not $current.exists) {
    Write-Host "autostart_status=disabled"
    return
  }
  if (-not (Test-ManagedAutostartEntry $current)) {
    Fail "Refusing to remove a per-user autostart value not owned by this BLUE-TANUKI install. Preserved: HKCU\Software\Microsoft\Windows\CurrentVersion\Run\$runName"
  }
  try {
    Remove-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction Stop
  } catch {
    Fail "Could not remove the managed per-user autostart entry. $($_.Exception.Message)"
  }
  if ((Read-AutostartEntry).exists) {
    Fail "The managed per-user autostart entry remains after removal."
  }
  Write-Host "autostart_status=disabled"
}

function Show-AutostartStatus {
  $entry = Read-AutostartEntry
  if (Test-ManagedAutostartEntry $entry) {
    Write-Host "autostart_status=enabled"
  } elseif ($entry.exists) {
    Write-Host "autostart_status=conflict"
    Write-Host "autostart_next_action=Preserve and inspect the existing per-user Run value before changing it."
  } else {
    Write-Host "autostart_status=disabled"
  }
}

switch ($Command.ToLowerInvariant()) {
  "open" { Open-ControlCenter }
  "start" { Start-ResidentCommand $false }
  "resident-start" { Start-ResidentCommand $false }
  "safe-mode" { Start-SafeMode }
  "resident-safe-mode" { Start-SafeMode }
  "watchdog" { Run-Watchdog $false }
  "watchdog-safe-mode" { Run-Watchdog $true }
  "stop" { Stop-Resident }
  "resident-stop" { Stop-Resident }
  "restart" { Stop-Resident; Start-ResidentCommand $false }
  "status" { Show-Status }
  "resident-status" { Show-Status }
  "doctor" { Run-Doctor $false }
  "doctor-open" { Run-Doctor $true }
  "recovery-inspect" { Run-RecoveryDiagnostic "--recovery-inspect" }
  "recovery-reconcile" { Run-RecoveryDiagnostic "--recovery-reconcile" }
  "recovery-apply-goal-purpose" { Run-RecoveryDiagnostic "--recovery-apply-goal-purpose" }
  "logs" { Open-Logs }
  "resident-logs" { Open-Logs }
  "autostart-enable" { Enable-Autostart }
  "resident-autostart-enable" { Enable-Autostart }
  "autostart-disable" { Disable-Autostart }
  "resident-autostart-disable" { Disable-Autostart }
  "autostart-status" { Show-AutostartStatus }
  "resident-autostart-status" { Show-AutostartStatus }
  "help" {
    Write-Host "Usage: BlueTanukiLauncher.ps1 [open|start|safe-mode|stop|restart|status|doctor|doctor-open|recovery-inspect|recovery-reconcile|recovery-apply-goal-purpose|logs|autostart-enable|autostart-disable|autostart-status|help]"
    Write-Host "Autostart is opt-in only and is not enabled by install/setup."
  }
  default { Fail "unknown command: $Command" }
}
