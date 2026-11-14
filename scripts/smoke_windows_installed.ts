import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { resolveSecretMaterial, storeLlmApiKeySecret } from "../apps/gateway/src/secret_store.ts";
import { verifyWindowsPackage } from "./verify_windows_package.ts";
import { verifyAndExtractWindowsIExpressCommand } from "./windows_iexpress.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const INSTALLER_TRANSACTION_TIMEOUT_MS = 600_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
const FIRST_MESSAGE_TIMEOUT_MS = 10_000;
const CRASH_RECOVERY_TIMEOUT_MS = 60_000;
const UNINSTALL_TIMEOUT_MS = 60_000;
let isolatedChildEnv: Record<string, string> = {};

function smokeChildEnvironment(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const system32 = path.win32.join(systemRoot, "System32");
  const profile = isolatedChildEnv.USERPROFILE;
  if (!profile) throw new Error("isolated Windows smoke profile is not initialized");
  const systemDrive = process.env.SystemDrive ?? path.win32.parse(systemRoot).root.replace(/[\\/]+$/, "");

  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemDrive || "C:",
    ComSpec: path.win32.join(system32, "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [
      system32,
      path.win32.join(system32, "Wbem"),
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter),
    OS: "Windows_NT",
    ...isolatedChildEnv,
    BLUE_TANUKI_NO_PAUSE: "1",
    ...extraEnv,
  };
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function defaultArtifact(): string {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
  return path.join(process.cwd(), "release/windows", `blue-tanuki-${pkg.version}-windows-x64-installer.zip`);
}

function logStep(message: string): void {
  console.log(`[windows-smoke] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  extraEnv: Record<string, string> = {},
): void {
  logStep(`start ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    env: smokeChildEnvironment(extraEnv),
    stdio: "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status} signal=${result.signal ?? "none"}`);
  }
  logStep(`done ${label}`);
}

function runAllowing(
  command: string,
  args: readonly string[],
  cwd: string,
  allowedStatuses: readonly number[],
  label: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  extraEnv: Record<string, string> = {},
): void {
  logStep(`start ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    env: smokeChildEnvironment(extraEnv),
    stdio: "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (!allowedStatuses.includes(result.status ?? -1)) {
    throw new Error(`${label} failed with exit ${result.status} signal=${result.signal ?? "none"}`);
  }
  logStep(`done ${label} status=${result.status ?? "null"}`);
}

function runExpectingStatus(
  command: string,
  args: readonly string[],
  cwd: string,
  expectedStatus: number,
  label: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  extraEnv: Record<string, string> = {},
  redactedValues: readonly string[] = [],
): string {
  logStep(`start ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    env: smokeChildEnvironment(extraEnv),
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = [result.stdout ?? "", result.stderr ?? ""].join("\n");
  let safeOutput = output;
  for (const value of redactedValues) {
    if (value) safeOutput = safeOutput.split(value).join("[redacted]");
  }
  if (safeOutput.trim()) process.stdout.write(safeOutput);
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== expectedStatus) {
    throw new Error(`${label} expected exit ${expectedStatus} but got ${result.status} signal=${result.signal ?? "none"}`);
  }
  logStep(`done ${label} status=${result.status}`);
  return output;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function expandArchive(artifact: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  logStep("start expand installer archive with PowerShell");
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${powershellLiteral(artifact)} -DestinationPath ${powershellLiteral(destination)} -Force`,
  ], process.cwd(), "expand installer archive with PowerShell", 600_000);
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx);
    const raw = trimmed.slice(idx + 1);
    if (raw.startsWith("\"")) {
      out[key] = JSON.parse(raw) as string;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function setEnvFileValue(file: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid isolated env key");
  const original = readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator > 0 && trimmed.slice(0, separator).trim() === key) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`isolated env file must contain exactly one ${key} entry`);
  }
  lines[matches[0]!] = `${key}=${JSON.stringify(value)}`;
  const tempFile = `${file}.smoke-${process.pid}-${randomUUID()}.tmp`;
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const updated = lines.join(newline) + (original.endsWith("\n") ? newline : "");
  try {
    writeFileSync(tempFile, updated, { encoding: "utf8", mode: 0o600 });
    renameSync(tempFile, file);
  } catch (error) {
    rmSync(tempFile, { force: true });
    throw error;
  }
}

function appendEnvFileValue(file: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid isolated env key");
  const original = readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const matches = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    const separator = trimmed.indexOf("=");
    return separator > 0 && trimmed.slice(0, separator).trim() === key;
  });
  if (matches.length !== 0) throw new Error(`isolated env file already contains ${key}`);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const base = original.endsWith("\n") ? original : `${original}${newline}`;
  const tempFile = `${file}.smoke-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tempFile, `${base}${key}=${JSON.stringify(value)}${newline}`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempFile, file);
  } catch (error) {
    rmSync(tempFile, { force: true });
    throw error;
  }
}

function assertEnvValuesRetained(
  before: Record<string, string>,
  after: Record<string, string>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!before[key]) throw new Error(`repair install baseline is missing ${key}`);
    if (after[key] !== before[key]) {
      throw new Error(`repair install did not retain ${key}`);
    }
  }
}

function assertTextIncludes(file: string, needles: readonly string[]): void {
  const text = readFileSync(file, "utf8");
  const normalizedText = text.replace(/\s+/g, " ");
  for (const needle of needles) {
    const normalizedNeedle = needle.replace(/\s+/g, " ");
    if (!text.includes(needle) && !normalizedText.includes(normalizedNeedle)) {
      throw new Error(`${file} missing required text: ${needle}`);
    }
  }
}

function findBundledNode(installRoot: string): string {
  const runtimeRoot = path.join(installRoot, "runtime");
  const stack = [runtimeRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry.toLowerCase() === "node.exe") {
        return full;
      }
    }
  }
  throw new Error(`bundled node.exe not found under ${runtimeRoot}`);
}

function writeTamperedAuditEnv(
  sourceEnvFile: string,
  sourceAuditDir: string,
  targetRoot: string,
): string {
  const tamperAuditDir = path.join(targetRoot, "TamperedAudit");
  mkdirSync(tamperAuditDir, { recursive: true });
  const sourceAuditFile = path.join(sourceAuditDir, "audit.jsonl");
  const targetAuditFile = path.join(tamperAuditDir, "audit.jsonl");
  if (!existsSync(sourceAuditFile)) {
    throw new Error(`audit file missing before tamper probe: ${sourceAuditFile}`);
  }
  copyFileSync(sourceAuditFile, targetAuditFile);
  writeFileSync(targetAuditFile, `${readFileSync(targetAuditFile, "utf8")}\n{"tampered":true}\n`, "utf8");
  const tamperEnvFile = path.join(targetRoot, "tampered-audit.env");
  const escapedAuditDir = tamperAuditDir.replace(/\\/g, "\\\\");
  const source = readFileSync(sourceEnvFile, "utf8");
  const next = source.replace(
    /^BLUE_TANUKI_AUDIT_DIR=.*$/m,
    `BLUE_TANUKI_AUDIT_DIR="${escapedAuditDir}"`,
  );
  if (next === source) {
    throw new Error("BLUE_TANUKI_AUDIT_DIR missing from installed env file");
  }
  writeFileSync(tamperEnvFile, next, "utf8");
  return tamperEnvFile;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const started = Date.now();
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${label} failed after ${Date.now() - started}ms: ${errorMessage(error)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowsSetupMoveHookScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
function Move-Item {
  [CmdletBinding()]
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  $target = [System.IO.Path]::GetFullPath($env:BT_TEST_INSTALL_ROOT)
  $source = [System.IO.Path]::GetFullPath($LiteralPath)
  $destination = [System.IO.Path]::GetFullPath($Destination)
  $parent = [System.IO.Path]::GetDirectoryName($target)
  $installName = [System.IO.Path]::GetFileName($target)
  $rollbackPattern = '^\.' + [System.Text.RegularExpressions.Regex]::Escape($installName) + '\.blue-tanuki-rollback-(?:[0-9a-f]{16}|[0-9a-f]{32})$'
  $stagePattern = '^\.' + [System.Text.RegularExpressions.Regex]::Escape($installName) + '\.blue-tanuki-stage-(?:[0-9a-f]{16}|[0-9a-f]{32})$'

  if ($destination -ieq $target -and $env:BT_TEST_MOVE_MODE -eq 'fail-stage' -and
      [System.Text.RegularExpressions.Regex]::IsMatch([System.IO.Path]::GetFileName($source), $stagePattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    $rollbackCandidates = @(Get-ChildItem -Force -LiteralPath $parent | Where-Object {
      [System.Text.RegularExpressions.Regex]::IsMatch([string]$_.Name, $rollbackPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    })
    if ((Test-Path -LiteralPath $target) -or $rollbackCandidates.Count -ne 1) {
      throw 'Controlled update failure hook did not observe the expected post-backup swap state.'
    }
    [System.IO.File]::WriteAllText($env:BT_TEST_MOVE_MARKER, [string]$PID, [System.Text.Encoding]::ASCII)
    throw 'blue-tanuki injected installed update failure after verified backup move'
  }

  if ($source -ieq $target -and $env:BT_TEST_MOVE_MODE -eq 'interrupt-rollback' -and
      [System.Text.RegularExpressions.Regex]::IsMatch([System.IO.Path]::GetFileName($destination), $rollbackPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    if (Test-Path -LiteralPath $destination) {
      throw 'Controlled interruption hook found an unexpected rollback destination.'
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force | Out-Null
    [System.IO.File]::WriteAllText($env:BT_TEST_MOVE_MARKER, [string]$PID, [System.Text.Encoding]::ASCII)
    while ($true) { Start-Sleep -Milliseconds 250 }
  }

  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force | Out-Null
}

& $env:BT_TEST_SETUP_SCRIPT -InstallRoot $env:BT_TEST_INSTALL_ROOT -DataRoot $env:BT_TEST_DATA_ROOT -NoLaunch
`;
}

async function interruptWindowsInstallerAfterRollbackMove(
  setupHook: string,
  cwd: string,
  markerFile: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<void> {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", setupHook], {
    cwd,
    env: smokeChildEnvironment(extraEnv),
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  let resolveExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void = () => undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  child.once("exit", (code, signal) => resolveExit({ code, signal }));

  const deadline = Date.now() + timeoutMs;
  while (!existsSync(markerFile) && Date.now() < deadline) {
    if (spawnError) throw new Error(`interrupted Windows update process could not start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = await exited;
      throw new Error(`interrupted Windows update exited before the backup move: code=${result.code} signal=${result.signal}`);
    }
    await sleep(50);
  }
  if (!existsSync(markerFile)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw new Error("interrupted Windows update did not reach the controlled backup-move point");
  }

  const markerPid = Number(readFileSync(markerFile, "utf8").trim());
  if (!Number.isInteger(markerPid) || markerPid <= 0 || child.pid === undefined || markerPid !== child.pid) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw new Error("interrupted Windows update process identity could not be verified");
  }
  child.kill("SIGKILL");
  const result = await exited;
  if (result.code === 0) {
    throw new Error("interrupted Windows update unexpectedly exited successfully before termination");
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, undefined, 2_000, "healthz probe");
      if (response.ok) return true;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function waitForStopped(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, undefined, 1_000, "stopped healthz probe");
      if (!response.ok) return true;
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForAbsent(target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(target)) return true;
    await sleep(250);
  }
  return !existsSync(target);
}

async function waitForFileText(file: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    await sleep(250);
  }
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

async function removeTreeBestEffort(target: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(target)) throw new Error("temporary tree remains after removal");
      return;
    } catch (error) {
      if (attempt < 6) {
        await sleep(500);
        continue;
      }
      console.error(`[windows-smoke] cleanup temporary install tree failed: ${errorMessage(error)}`);
      throw new Error(`cleanup temporary install tree failed: ${errorMessage(error)}`);
    }
  }
}

function readPidFile(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function readSmokeRegistryState(runName: string, label: string): { uninstallPresent: boolean; autostartPresent: boolean } {
  const script = [
    "$uninstallKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BlueTanuki'",
    "$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    "$uninstallPresent = Test-Path -LiteralPath $uninstallKey",
    "$runKeyPresent = Test-Path -LiteralPath $runKey",
    "$runProperties = if ($runKeyPresent) { Get-ItemProperty -LiteralPath $runKey -ErrorAction Stop } else { $null }",
    "$autostartProperty = if ($runProperties) { $runProperties.PSObject.Properties[$env:BLUE_TANUKI_AUTOSTART_RUN_NAME] } else { $null }",
    "$autostartPresent = $null -ne $autostartProperty",
    'Write-Output "uninstall_present=$($uninstallPresent.ToString().ToLowerInvariant())"',
    'Write-Output "autostart_present=$($autostartPresent.ToString().ToLowerInvariant())"',
  ].join("; ");
  const output = runExpectingStatus("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], process.cwd(), 0, label, 60_000, { BLUE_TANUKI_AUTOSTART_RUN_NAME: runName });
  const uninstall = output.match(/(?:^|\r?\n)uninstall_present=(true|false)(?:\r?\n|$)/i)?.[1]?.toLowerCase();
  const autostart = output.match(/(?:^|\r?\n)autostart_present=(true|false)(?:\r?\n|$)/i)?.[1]?.toLowerCase();
  if (!uninstall || !autostart) {
    throw new Error(`${label} did not report both registry states`);
  }
  return { uninstallPresent: uninstall === "true", autostartPresent: autostart === "true" };
}

function assertSmokeRegistryAbsent(runName: string, label: string): void {
  const state = readSmokeRegistryState(runName, label);
  if (state.uninstallPresent || state.autostartPresent) {
    throw new Error(`${label} found unexpected BLUE-TANUKI registry state uninstall=${state.uninstallPresent} autostart=${state.autostartPresent}`);
  }
}

function assertNoActiveGatewayProcesses(label: string): void {
  const script = [
    "$matches = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf('apps/gateway/dist/main.js', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf('--serve', [StringComparison]::OrdinalIgnoreCase) -ge 0 })",
    "if ($matches.Count -gt 0) { $ids = @($matches | ForEach-Object { $_.ProcessId }); throw ('active Gateway process prevents isolated Setup/Launcher/Uninstall smoke; no process was stopped; pid=' + ($ids -join ',')) }",
    "Write-Output 'active_gateway_processes=none'",
  ].join("; ");
  const output = runExpectingStatus("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], process.cwd(), 0, label, 60_000);
  if (!output.includes("active_gateway_processes=none")) {
    throw new Error(`${label} did not confirm an empty active Gateway process set`);
  }
}

function stopVerifiedResidentProcess(
  pid: number,
  nodeExe: string,
  envFile: string,
  cwd: string,
  productEnv: Record<string, string>,
): void {
  const script = [
    "$targetPid = [int]$env:BLUE_TANUKI_SMOKE_PID",
    "$cim = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetPid) -ErrorAction Stop",
    "if ($null -eq $cim) { throw 'resident process was not found' }",
    "$expectedNode = [IO.Path]::GetFullPath($env:BLUE_TANUKI_SMOKE_NODE_EXE)",
    "$actualNode = [IO.Path]::GetFullPath([string]$cim.ExecutablePath)",
    "if (-not [string]::Equals($actualNode, $expectedNode, [StringComparison]::OrdinalIgnoreCase)) { throw 'resident executable path does not match the smoke installation' }",
    "$expectedEnvFile = [IO.Path]::GetFullPath($env:BLUE_TANUKI_SMOKE_ENV_FILE)",
    "if ([string]::IsNullOrWhiteSpace($cim.CommandLine) -or $cim.CommandLine.IndexOf($expectedEnvFile, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $cim.CommandLine.IndexOf('apps/gateway/dist/main.js', [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $cim.CommandLine.IndexOf('--serve', [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'resident command line does not match the smoke gateway and environment' }",
    "$process = Get-Process -Id $targetPid -ErrorAction Stop",
    "if (-not [string]::Equals([IO.Path]::GetFullPath($process.Path), $expectedNode, [StringComparison]::OrdinalIgnoreCase)) { throw 'resident process identity changed during verification' }",
    "$created = ([datetime]$cim.CreationDate).ToUniversalTime()",
    "$started = $process.StartTime.ToUniversalTime()",
    "if ([Math]::Abs(($created - $started).TotalSeconds) -gt 3) { throw 'resident process start time changed during verification' }",
    "Stop-Process -InputObject $process -Force -ErrorAction Stop",
    "Write-Output 'verified_smoke_resident_stopped=true'",
  ].join("; ");
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], cwd, "simulate resident crash", 60_000, {
    ...productEnv,
    BLUE_TANUKI_SMOKE_PID: String(pid),
    BLUE_TANUKI_SMOKE_NODE_EXE: nodeExe,
    BLUE_TANUKI_SMOKE_ENV_FILE: envFile,
  });
}

async function waitForPidChange(file: string, previousPid: number, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidFile(file);
    if (pid && pid !== previousPid) return pid;
    await sleep(500);
  }
  const pid = readPidFile(file);
  return pid && pid !== previousPid ? pid : undefined;
}

async function holdLoopbackPort(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function findAvailableLoopbackPort(): Promise<number> {
  const server = await holdLoopbackPort(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("could not read an ephemeral loopback port for the installed smoke");
  }
  await closeServer(server);
  return address.port;
}

async function probeLoopbackTcp(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readFileTail(file: string, maxBytes = 16 * 1024): {
  readonly bytes: number | null;
  readonly state: "readable" | "missing" | "unreadable";
  readonly text: string;
} {
  if (!existsSync(file)) return { bytes: 0, state: "missing", text: "" };
  let fd: number | undefined;
  try {
    const bytes = statSync(file).size;
    const count = Math.min(bytes, maxBytes);
    const buffer = Buffer.alloc(count);
    fd = openSync(file, "r");
    const start = Math.max(0, bytes - count);
    let offset = 0;
    while (offset < count) {
      const read = readSync(fd, buffer, offset, count - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    return { bytes, state: "readable", text: buffer.subarray(0, offset).toString("utf8") };
  } catch {
    return { bytes: null, state: "unreadable", text: "" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readInstalledGatewayProcessAndListeners(
  pid: number | undefined,
  port: number,
  expectedNodePath: string,
  expectedEnvFile: string,
): {
  readonly process_state: "present" | "missing" | "unknown";
  readonly process_name: string | null;
  readonly installed_node_matches: boolean | null;
  readonly gateway_serve_args_match: boolean | null;
  readonly env_file_arg_matches: boolean | null;
  readonly tcp_query_state: "readable" | "unavailable";
  readonly tcp_listeners: readonly { readonly address: string; readonly process_id: number }[];
} {
  const empty = {
    process_state: "unknown" as const,
    process_name: null,
    installed_node_matches: null,
    gateway_serve_args_match: null,
    env_file_arg_matches: null,
    tcp_query_state: "unavailable" as const,
    tcp_listeners: [] as const,
  };
  if (process.platform !== "win32") return empty;

  const script = [
    "$targetPid = [int]$env:BLUE_TANUKI_DIAG_PID",
    "$targetPort = [int]$env:BLUE_TANUKI_DIAG_PORT",
    "$expectedNode = [IO.Path]::GetFullPath($env:BLUE_TANUKI_DIAG_NODE)",
    "$expectedEnvFile = [IO.Path]::GetFullPath($env:BLUE_TANUKI_DIAG_ENV_FILE)",
    "$process = if ($targetPid -gt 0) { Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetPid) -ErrorAction SilentlyContinue } else { $null }",
    "$processName = if ($process) { [string]$process.Name } else { $null }",
    "$installedNodeMatches = if ($process -and $process.ExecutablePath) { [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath), $expectedNode, [StringComparison]::OrdinalIgnoreCase) } else { $null }",
    "$commandLine = if ($process) { [string]$process.CommandLine } else { '' }",
    "$gatewayServeArgsMatch = if ($process) { $commandLine.IndexOf('apps/gateway/dist/main.js', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $commandLine.IndexOf('--serve', [StringComparison]::OrdinalIgnoreCase) -ge 0 } else { $null }",
    "$envFileArgMatches = if ($process) { $commandLine.IndexOf($expectedEnvFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 } else { $null }",
    "$queryState = 'readable'",
    "$listeners = @()",
    "$netstat = Join-Path $env:SystemRoot 'System32\\netstat.exe'",
    "if (-not (Test-Path -LiteralPath $netstat -PathType Leaf)) { $queryState = 'unavailable' } else { $rows = @(& $netstat -ano -p tcp 2>$null); if ($LASTEXITCODE -ne 0) { $queryState = 'unavailable' } else { $listeners = @($rows | ForEach-Object { $parts = ([string]$_).Trim() -split '\\s+'; if ($parts.Count -ge 5 -and $parts[0] -eq 'TCP' -and $parts[1] -match (':' + [regex]::Escape([string]$targetPort) + '$') -and $parts[3] -eq 'LISTENING' -and $parts[4] -match '^\\d+$') { [ordered]@{ address = [string]$parts[1]; process_id = [int]$parts[4] } } }) } }",
    "$result = [ordered]@{ process_state = if ($process) { 'present' } else { 'missing' }; process_name = $processName; installed_node_matches = $installedNodeMatches; gateway_serve_args_match = $gatewayServeArgsMatch; env_file_arg_matches = $envFileArgMatches; tcp_query_state = $queryState; tcp_listeners = @($listeners) }",
    "$result | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: process.cwd(),
    env: smokeChildEnvironment({
      BLUE_TANUKI_DIAG_PID: String(pid ?? 0),
      BLUE_TANUKI_DIAG_PORT: String(port),
      BLUE_TANUKI_DIAG_NODE: expectedNodePath,
      BLUE_TANUKI_DIAG_ENV_FILE: expectedEnvFile,
    }),
    encoding: "utf8",
    stdio: "pipe",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return empty;
  try {
    const parsed = JSON.parse((result.stdout ?? "").trim()) as {
      process_state?: unknown;
      process_name?: unknown;
      installed_node_matches?: unknown;
      gateway_serve_args_match?: unknown;
      env_file_arg_matches?: unknown;
      tcp_query_state?: unknown;
      tcp_listeners?: unknown;
    };
    const listeners = Array.isArray(parsed.tcp_listeners)
      ? parsed.tcp_listeners.slice(0, 8).flatMap((listener) => {
        if (!listener || typeof listener !== "object") return [];
        const row = listener as { address?: unknown; process_id?: unknown };
        if (typeof row.address !== "string" || typeof row.process_id !== "number") return [];
        return [{ address: row.address.slice(0, 64), process_id: row.process_id }];
      })
      : [];
    return {
      process_state: parsed.process_state === "present" ? "present" : parsed.process_state === "missing" ? "missing" : "unknown",
      process_name: typeof parsed.process_name === "string" ? parsed.process_name.slice(0, 64) : null,
      installed_node_matches: typeof parsed.installed_node_matches === "boolean" ? parsed.installed_node_matches : null,
      gateway_serve_args_match: typeof parsed.gateway_serve_args_match === "boolean" ? parsed.gateway_serve_args_match : null,
      env_file_arg_matches: typeof parsed.env_file_arg_matches === "boolean" ? parsed.env_file_arg_matches : null,
      tcp_query_state: parsed.tcp_query_state === "readable" ? "readable" : "unavailable",
      tcp_listeners: listeners,
    };
  } catch {
    return empty;
  }
}

function redactStartupDiagnostic(
  value: string,
  secretValues: readonly string[],
  privatePaths: readonly string[],
): string {
  let redacted = value;
  for (const secret of secretValues) {
    if (secret.length >= 4) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  for (const privatePath of [...privatePaths].sort((left, right) => right.length - left.length)) {
    if (privatePath) redacted = redacted.replaceAll(privatePath, "<smoke-path>");
  }
  return redacted
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi, "<redacted-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .slice(0, 600);
}

async function reportInstalledGatewayStartupFailure(
  installRoot: string,
  dataRoot: string,
  port: number,
  env: Record<string, string>,
  privatePaths: readonly string[],
): Promise<void> {
  const logDir = path.join(dataRoot, "logs");
  const stdout = readFileTail(path.join(logDir, "blue-tanuki.out.log"));
  const stderr = readFileTail(path.join(logDir, "blue-tanuki.err.log"));
  const pid = readPidFile(path.join(dataRoot, "blue-tanuki.pid"));
  let pidProcessPresence = pid ? "unverified" : "pid_record_missing";
  if (pid) {
    try {
      process.kill(pid, 0);
      pidProcessPresence = "present";
    } catch (error) {
      pidProcessPresence = (error as NodeJS.ErrnoException).code === "ESRCH" ? "not_present" : "unverified";
    }
  }
  const secretValues = [
    ...Object.entries(env)
      .filter(([key, value]) => value && /TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY/i.test(key))
      .map(([, value]) => value),
    ...Object.entries(process.env)
      .filter(([key, value]) => value && /TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY/i.test(key))
      .map(([, value]) => value!),
  ];
  const errorLines = stderr.text.split(/\r?\n/)
    .filter((line) => /\b(?:Error|Exception|FATAL|ERR_[A-Z0-9_]+|EADDRINUSE|ENOENT|EACCES|EPERM|TypeError|SyntaxError|ReferenceError|uncaught|missing|required)\b/i.test(line))
    .slice(-8)
    .map((line) => redactStartupDiagnostic(line, secretValues, privatePaths));
  const startupEventMarkers = [
    ["env_file_loaded", /env file loaded/i],
    ["gateway_starting", /BLUE-TANUKI starting/i],
    ["complete_history_initialized", /complete history/i],
    ["startup_saved_result_reconciliation", /startup saved-result reconciliation/i],
    ["failure_memory_verification", /failure memory verification/i],
    ["inbound_channels_started", /inbound channels/i],
    ["outbound_channels_started", /outbound channels/i],
    ["webchat_listening", /webchat listening/i],
  ] as const;
  const startupEvents = startupEventMarkers
    .filter(([, marker]) => marker.test(stdout.text))
    .map(([name]) => name);
  const startupLogLines = stdout.text.split(/\r?\n/)
    .filter((line) => /webchat listening|Gateway startup blocked|received signal|shutting down|\bfatal\b/i.test(line))
    .slice(-8)
    .map((line) => redactStartupDiagnostic(line, secretValues, privatePaths));
  const startupBlocked = /Gateway startup blocked before inbound channels/i.test(`${stdout.text}\n${stderr.text}`);
  const tcpListening = await probeLoopbackTcp(port);
  const processAndListeners = readInstalledGatewayProcessAndListeners(
    pid,
    port,
    findBundledNode(installRoot),
    path.join(dataRoot, "blue-tanuki.env"),
  );
  console.error(`[windows-smoke] installed_gateway_diagnostics ${JSON.stringify({
    resident_pid: pid ?? null,
    pid_process_presence: pidProcessPresence,
    process_state: processAndListeners.process_state,
    process_name: processAndListeners.process_name,
    installed_node_matches: processAndListeners.installed_node_matches,
    gateway_serve_args_match: processAndListeners.gateway_serve_args_match,
    env_file_arg_matches: processAndListeners.env_file_arg_matches,
    loopback_tcp_listener: tcpListening ? "accepting" : "not_accepting",
    tested_host: "127.0.0.1",
    tested_port: port,
    tcp_query_state: processAndListeners.tcp_query_state,
    tcp_listeners: processAndListeners.tcp_listeners,
    stdout_bytes: stdout.bytes,
    stdout_log_state: stdout.state,
    stderr_bytes: stderr.bytes,
    stderr_log_state: stderr.state,
    startup_events: startupEvents,
    startup_log_lines: startupLogLines,
    startup_blocked_marker: startupBlocked,
    stderr_error_lines: errorLines.length,
  })}`);
  for (const line of errorLines) {
    console.error(`[windows-smoke] installed_gateway_stderr ${line}`);
  }
}

async function receiveFirstMessage(
  wsUrl: string,
  token: string,
  port: string,
): Promise<{ hello: boolean; channelSend: boolean }> {
  const messages: Array<Record<string, unknown>> = [];
  logStep("start websocket first-message probe");
  const ws = new WebSocket(wsUrl);
  ws.on("message", (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore non-json frames
    }
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      ws.terminate();
      finish(new Error("websocket open timeout"));
    }, WEBSOCKET_OPEN_TIMEOUT_MS);
    ws.once("open", () => {
      finish();
    });
    ws.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await sleep(250);
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ user: "windows-smoke", content: "Hello BLUE-TANUKI Windows installer smoke" }),
  }, FETCH_TIMEOUT_MS, "first message POST");
  if (!response.ok) {
    throw new Error(`first message POST failed: ${response.status} ${await response.text()}`);
  }
  const deadline = Date.now() + FIRST_MESSAGE_TIMEOUT_MS;
  while (!messages.some((message) => message.kind === "channel_send") && Date.now() < deadline) {
    await sleep(250);
  }
  ws.close();
  logStep("done websocket first-message probe");
  return {
    hello: messages.some((message) => message.kind === "hello"),
    channelSend: messages.some((message) => message.kind === "channel_send"),
  };
}

async function main(): Promise<void> {
  const artifact = path.resolve(argValue("--artifact") ?? defaultArtifact());
  const iexpressExeArg = argValue("--iexpress-exe");
  const directIExpressLaunch = process.argv.includes("--launch-iexpress");
  if (process.argv.includes("--iexpress-exe") && !iexpressExeArg) {
    throw new Error("--iexpress-exe requires a Windows IExpress installer path");
  }
  if (directIExpressLaunch && !iexpressExeArg) {
    throw new Error("--launch-iexpress requires --iexpress-exe");
  }
  if (directIExpressLaunch && !process.argv.includes("--startup-only")) {
    throw new Error("--launch-iexpress is limited to --startup-only");
  }
  if (iexpressExeArg && process.platform !== "win32") {
    throw new Error("--iexpress-exe installed smoke must run on Windows");
  }
  const iexpressExe = iexpressExeArg ? path.resolve(iexpressExeArg) : undefined;
  logStep("verify installer package");
  verifyWindowsPackage(artifact);
  logStep("done verify installer package");
  if (process.platform !== "win32") {
    console.log(`windows_runtime_smoke=skipped platform=${process.platform}`);
    console.log("artifact_structure_smoke=pass");
    return;
  }

  const smokeTempBase = path.join(process.env.LOCALAPPDATA ?? tmpdir(), "BTsmoke");
  mkdirSync(smokeTempBase, { recursive: true });
  const work = mkdtempSync(path.join(smokeTempBase, "w-"));
  const packageDir = path.join(work, "package");
  const autostartRunName = `BLUE-TANUKI-SMOKE-${randomUUID()}`;
  const isolatedProfile = path.join(work, "profile");
  const isolatedAppData = path.join(isolatedProfile, "AppData", "Roaming");
  const isolatedLocalAppData = path.join(isolatedProfile, "AppData", "Local");
  const installRoot = directIExpressLaunch
    ? path.join(isolatedLocalAppData, "Programs", "BlueTanuki")
    : path.join(work, "i");
  const dataRoot = directIExpressLaunch
    ? path.join(isolatedAppData, "BlueTanuki")
    : path.join(work, "d");
  const startMenuRoot = path.join(isolatedAppData, "Microsoft", "Windows", "Start Menu", "Programs", "BLUE-TANUKI");
  const isolatedTemp = path.join(work, "Temp");
  const retentionUninstallStatusFile = path.join(isolatedTemp, `BlueTanukiUninstall-retain-${randomUUID()}.status`);
  const uninstallStatusFile = path.join(isolatedTemp, `BlueTanukiUninstall-${randomUUID()}.status`);
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  // The no-argument IExpress entrypoint runs Setup's normal --yes defaults,
  // which intentionally use 127.0.0.1:8787. Other smoke modes can set a free
  // ephemeral endpoint in their generated env file.
  const smokePort = directIExpressLaunch ? 8787 : await findAvailableLoopbackPort();
  mkdirSync(isolatedAppData, { recursive: true });
  mkdirSync(isolatedLocalAppData, { recursive: true });
  mkdirSync(isolatedTemp, { recursive: true });
  isolatedChildEnv = {
    APPDATA: isolatedAppData,
    LOCALAPPDATA: isolatedLocalAppData,
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
    USERPROFILE: isolatedProfile,
    HOME: isolatedProfile,
    HOMEDRIVE: path.win32.parse(isolatedProfile).root.replace(/[\\/]+$/, ""),
    HOMEPATH: isolatedProfile.slice(path.win32.parse(isolatedProfile).root.replace(/[\\/]+$/, "").length),
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(smokePort),
  };
  const isolatedProductEnv = {
    ...isolatedChildEnv,
    PATH: [
      path.join(windowsRoot, "System32"),
      path.join(windowsRoot, "System32", "Wbem"),
      path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter),
  };
  let launcher: string | undefined;
  let setupAttempted = false;
  let stopped = false;
  let uninstalled = false;
  let allowWorkCleanup = false;
  let smokeFailure: unknown;
  let cleanupFailure: Error | undefined;
  let startupOnlySmokePassed = false;
  smoke: try {
    assertNoActiveGatewayProcesses("installed smoke active Gateway preflight");
    logStep("installed smoke active Gateway preflight passed");
    if (directIExpressLaunch && await probeLoopbackTcp(smokePort)) {
      throw new Error(`default direct IExpress smoke endpoint is already occupied: 127.0.0.1:${smokePort}`);
    }
    assertSmokeRegistryAbsent(autostartRunName, "installed smoke registry preflight");
    logStep("installed smoke registry preflight passed");

    const sourceTreeGuidance = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(process.cwd(), "install/windows/product/BlueTanukiSetup.ps1"),
      "-InstallRoot",
      path.join(work, "BadSourceInstallRoot"),
      "-DataRoot",
      path.join(work, "BadSourceDataRoot"),
      "-NoLaunch",
    ], process.cwd(), 1, "source-tree product setup guidance", 60_000);
    if (!sourceTreeGuidance.includes("This setup script must be run from the packaged Windows installer zip.")) {
      throw new Error("source-tree product setup did not explain packaged-installer requirement");
    }
    if (!sourceTreeGuidance.includes("INSTALL_WINDOWS.cmd")) {
      throw new Error("source-tree product setup did not point to root INSTALL_WINDOWS.cmd");
    }
    if (sourceTreeGuidance.includes("required package directory missing")) {
      throw new Error("source-tree product setup exposed raw missing package directory error");
    }
    console.log("source_tree_setup_guidance_result=pass");

    const rootEntrypointDefaultDryRun = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(process.cwd(), "INSTALL_WINDOWS.ps1"),
      "-DryRun",
      "-WorkRoot",
      path.join(work, "root-entrypoint-default-dry-run"),
      "-NoLaunch",
    ], work, 0, "root source entrypoint default dry-run", 60_000);
    if (!rootEntrypointDefaultDryRun.includes("Repository root:")) {
      throw new Error("root source entrypoint default dry-run did not print repository root");
    }
    if (!rootEntrypointDefaultDryRun.includes("root_source_entrypoint_dry_run=pass")) {
      throw new Error("root source entrypoint default dry-run marker missing");
    }
    if (rootEntrypointDefaultDryRun.includes("Cannot bind argument to parameter 'Path'")) {
      throw new Error("root source entrypoint default dry-run failed during parameter binding");
    }

    const emptyReleaseDir = path.join(work, "empty-release");
    mkdirSync(emptyReleaseDir, { recursive: true });
    const rootEntrypointDryRun = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(process.cwd(), "INSTALL_WINDOWS.ps1"),
      "-DryRun",
      "-ReleaseDir",
      emptyReleaseDir,
      "-WorkRoot",
      path.join(work, "entrypoint-dry-run"),
      "-NoLaunch",
    ], process.cwd(), 0, "root source entrypoint dry-run", 60_000);
    if (!rootEntrypointDryRun.includes("wrong_asset=source_zip")) {
      throw new Error("root source entrypoint did not identify source zip/source tree when installer zip was absent");
    }
    if (!rootEntrypointDryRun.includes("would_download_release_installer=")) {
      throw new Error("root source entrypoint did not choose verified release download path when installer zip was absent");
    }
    if (rootEntrypointDryRun.includes("would_build_installer=true")) {
      throw new Error("root source entrypoint default dry-run must not build from source");
    }
    if (rootEntrypointDryRun.includes("would_run=pnpm package:windows")) {
      throw new Error("root source entrypoint default dry-run must not run package:windows");
    }
    if (!rootEntrypointDryRun.includes("root_source_entrypoint_dry_run=pass")) {
      throw new Error("root source entrypoint dry-run marker missing");
    }
    console.log("root_source_entrypoint_result=pass");

    const developerBuildDryRun = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(process.cwd(), "INSTALL_WINDOWS.ps1"),
      "-DryRun",
      "-BuildFromSource",
      "-ReleaseDir",
      emptyReleaseDir,
      "-WorkRoot",
      path.join(work, "developer-build-dry-run"),
      "-NoLaunch",
    ], process.cwd(), 0, "root source entrypoint explicit developer build dry-run", 60_000);
    if (!developerBuildDryRun.includes("developer_build_from_source=true")) {
      throw new Error("explicit -BuildFromSource dry-run did not mark developer build path");
    }
    if (!developerBuildDryRun.includes("would_run=pnpm package:windows")) {
      throw new Error("explicit -BuildFromSource dry-run did not include package:windows");
    }
    if (developerBuildDryRun.includes("would_run=corepack enable")) {
      throw new Error("explicit -BuildFromSource dry-run must not use corepack enable");
    }
    console.log("root_source_entrypoint_build_from_source_result=pass");

    const rootEntrypointCmdDryRun = runExpectingStatus("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(process.cwd(), "INSTALL_WINDOWS.cmd"),
      "-DryRun",
      "-ReleaseDir",
      emptyReleaseDir,
      "-WorkRoot",
      path.join(work, "cmd-entrypoint-dry-run"),
      "-NoLaunch",
    ], work, 0, "root source cmd entrypoint dry-run", 60_000);
    if (!rootEntrypointCmdDryRun.includes("Repository root:")) {
      throw new Error("root source cmd entrypoint dry-run did not print repository root");
    }
    if (!rootEntrypointCmdDryRun.includes("wrong_asset=source_zip")) {
      throw new Error("root source cmd entrypoint did not identify source zip/source tree when installer zip was absent");
    }
    if (!rootEntrypointCmdDryRun.includes("would_download_release_installer=")) {
      throw new Error("root source cmd entrypoint did not choose verified release download path when installer zip was absent");
    }
    if (rootEntrypointCmdDryRun.includes("would_build_installer=true")) {
      throw new Error("root source cmd entrypoint default dry-run must not build from source");
    }
    if (!rootEntrypointCmdDryRun.includes("root_source_entrypoint_dry_run=pass")) {
      throw new Error("root source cmd entrypoint dry-run marker missing");
    }
    if (rootEntrypointCmdDryRun.includes("Cannot bind argument to parameter 'Path'")) {
      throw new Error("root source cmd entrypoint failed during parameter binding");
    }
    console.log("root_source_entrypoint_cmd_result=pass");

    expandArchive(artifact, packageDir);
    assertTextIncludes(path.join(packageDir, "app", "docs", "WINDOWS_INSTALLER_GUIDE.md"), [
      "Microsoft Defender SmartScreen",
      "SHA-256",
      "Run anyway",
      "Do not bypass a hash mismatch",
    ]);
    assertTextIncludes(path.join(packageDir, "app", "docs", "WINDOWS_PACKAGING_AUDIT.md"), [
      "The package is unsigned",
      "SmartScreen continuation requires operator-side SHA-256 verification",
    ]);
    console.log("defender_smartscreen_guidance_result=pass");

    let setupCommand = path.join(packageDir, "BlueTanukiSetup.cmd");
    if (iexpressExe) {
      const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
      if (!pkg.version) throw new Error("package.json version is missing for IExpress smoke");
      logStep("verify and extract IExpress command payload");
      const iexpress = verifyAndExtractWindowsIExpressCommand(
        iexpressExe,
        artifact,
        path.join(work, "iexpress"),
        pkg.version,
      );
      setupCommand = iexpress.commandPath;
      console.log(`iexpress_installer_sha256=${iexpress.installerSha256}`);
      console.log(`iexpress_bootstrapper_sha256=${iexpress.bootstrapperSha256}`);
      console.log("iexpress_extraction_result=pass");
    }

    launcher = path.join(installRoot, "BlueTanukiLauncher.ps1");
    setupAttempted = true;
    if (directIExpressLaunch) {
      if (!iexpressExe) throw new Error("--launch-iexpress requires a verified IExpress executable");
      run(iexpressExe, [], work, "IExpress direct user entrypoint", 600_000, isolatedProductEnv);
      console.log("iexpress_direct_user_launch_result=pass");
    } else {
      run("cmd.exe", [
        "/d",
        "/s",
        "/c",
        setupCommand,
        "-InstallRoot",
        installRoot,
        "-DataRoot",
        dataRoot,
        "-NoLaunch",
      ], packageDir, iexpressExe ? "IExpress embedded Setup" : "installer setup", 600_000, isolatedProductEnv);
      console.log(iexpressExe ? "iexpress_embedded_setup_result=pass" : "installer_zip_setup_result=pass");
    }

    const envFile = path.join(dataRoot, "blue-tanuki.env");
    if (process.argv.includes("--startup-only")) {
      if (!directIExpressLaunch) {
        setEnvFileValue(envFile, "WEBCHAT_HOST", isolatedChildEnv.WEBCHAT_HOST!);
        setEnvFileValue(envFile, "WEBCHAT_PORT", isolatedChildEnv.WEBCHAT_PORT!);
      }
      const env = parseEnvFile(envFile);
      const port = env.WEBCHAT_PORT ?? "8787";
      const portNumber = Number.parseInt(port, 10);
      if (!Number.isInteger(portNumber) || portNumber <= 0) {
        throw new Error(`WEBCHAT_PORT is invalid in installed smoke env file: ${port}`);
      }
      if (directIExpressLaunch) {
        if (env.WEBCHAT_HOST !== isolatedChildEnv.WEBCHAT_HOST ||
            env.WEBCHAT_PORT !== isolatedChildEnv.WEBCHAT_PORT) {
          throw new Error("direct IExpress first-run config did not retain the isolated WebChat endpoint");
        }
        if (!existsSync(path.join(startMenuRoot, "BLUE-TANUKI.lnk"))) {
          throw new Error("direct IExpress Setup did not create the isolated Start Menu product entry");
        }
        console.log("iexpress_start_menu_entry_result=pass");
      } else {
        run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          launcher,
          "start",
        ], installRoot, "startup-only launcher start", 120_000, isolatedProductEnv);
      }
      stopped = false;
      const healthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
      if (!healthReady) {
        await reportInstalledGatewayStartupFailure(installRoot, dataRoot, portNumber, env, [work, installRoot, dataRoot, isolatedTemp]);
        throw new Error("installed gateway healthz did not become ready in startup-only smoke");
      }
      console.log("installed_gateway_startup_result=pass");
      run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "stop",
      ], installRoot, "startup-only launcher stop", 60_000, isolatedProductEnv);
      stopped = true;
      if (!(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
        throw new Error("installed gateway remained reachable after startup-only smoke stop");
      }
      startupOnlySmokePassed = true;
      break smoke;
    }
    const envBeforeRepair = parseEnvFile(envFile);
    run("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(packageDir, "BlueTanukiSetup.cmd"),
      "-InstallRoot",
      installRoot,
      "-DataRoot",
      dataRoot,
      "-NoLaunch",
    ], packageDir, "installer repair install", 600_000, isolatedProductEnv);
    setEnvFileValue(envFile, "WEBCHAT_HOST", isolatedChildEnv.WEBCHAT_HOST!);
    setEnvFileValue(envFile, "WEBCHAT_PORT", isolatedChildEnv.WEBCHAT_PORT!);
    const env = parseEnvFile(envFile);
    if (env.WEBCHAT_HOST !== isolatedChildEnv.WEBCHAT_HOST || env.WEBCHAT_PORT !== isolatedChildEnv.WEBCHAT_PORT) {
      throw new Error("installed smoke WebChat endpoint does not match its isolated env file");
    }
    console.log(`installed_smoke_webchat_endpoint=${env.WEBCHAT_HOST}:${env.WEBCHAT_PORT}`);
    assertEnvValuesRetained(envBeforeRepair, env, [
      "WEBCHAT_TOKEN",
      "WEBCHAT_RESUME_TOKEN",
      "BLUE_TANUKI_MAINTENANCE_TOKEN",
      "BLUE_TANUKI_SETTINGS_TOKEN",
    ]);
    console.log("repair_install_result=pass");
    const autostartEnv = { ...isolatedProductEnv, BLUE_TANUKI_AUTOSTART_RUN_NAME: autostartRunName };
    const autostartInitial = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "resident-autostart-status",
    ], installRoot, 0, "launcher autostart status initial", 60_000, autostartEnv);
    if (!autostartInitial.includes("autostart_status=disabled")) {
      throw new Error("autostart should be disabled before explicit owner opt-in");
    }
    try {
      const autostartEnabled = runExpectingStatus("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "resident-autostart-enable",
      ], installRoot, 0, "launcher autostart enable", 60_000, autostartEnv);
      if (!autostartEnabled.includes("autostart_status=enabled")) {
        throw new Error("autostart enable output did not confirm enabled status");
      }
      const autostartStatus = runExpectingStatus("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "resident-autostart-status",
      ], installRoot, 0, "launcher autostart status enabled", 60_000, autostartEnv);
      if (!autostartStatus.includes("autostart_status=enabled")) {
        throw new Error("autostart status did not observe HKCU Run entry");
      }
    } finally {
      runExpectingStatus("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "resident-autostart-disable",
      ], installRoot, 0, "launcher autostart disable", 60_000, autostartEnv);
    }
    const autostartDisabled = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "resident-autostart-status",
    ], installRoot, 0, "launcher autostart status disabled", 60_000, autostartEnv);
    if (!autostartDisabled.includes("autostart_status=disabled")) {
      throw new Error("autostart disable did not remove HKCU Run entry");
    }
    console.log("reboot_persistence_result=pass");

    const port = env.WEBCHAT_PORT ?? "8787";
    const portNumber = Number.parseInt(port, 10);
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      throw new Error(`WEBCHAT_PORT is invalid in installed env file: ${port}`);
    }
    const blocker = await holdLoopbackPort(portNumber);
    try {
      const conflictOutput = runExpectingStatus("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        launcher,
        "start",
      ], installRoot, 2, "launcher port conflict", 60_000, isolatedProductEnv);
      if (!conflictOutput.includes(`port_conflict=127.0.0.1:${port}`)) {
        throw new Error("launcher port conflict output did not include expected port_conflict marker");
      }
      console.log("port_conflict_result=pass");
    } finally {
      await closeServer(blocker);
    }

    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "start",
    ], installRoot, "launcher start", 120_000, isolatedProductEnv);

    const token = env.WEBCHAT_TOKEN;
    if (!token) throw new Error("WEBCHAT_TOKEN missing from installed env file");
    logStep("wait installed gateway healthz");
    const healthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!healthReady) {
      await reportInstalledGatewayStartupFailure(installRoot, dataRoot, portNumber, env, [work, installRoot, dataRoot, isolatedTemp]);
      throw new Error("installed gateway healthz did not become ready");
    }
    logStep("done installed gateway healthz");

    logStep("request websocket ticket");
    const ticketResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/ws-ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user: "windows-smoke" }),
    }, FETCH_TIMEOUT_MS, "ws-ticket POST");
    if (!ticketResponse.ok) {
      throw new Error(`ws-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
    }
    logStep("done websocket ticket");
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
    const firstMessage = await receiveFirstMessage(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
      token,
      port,
    );
    if (!firstMessage.hello || !firstMessage.channelSend) {
      throw new Error(`first message smoke failed hello=${firstMessage.hello} channel_send=${firstMessage.channelSend}`);
    }
    const resumeToken = env.WEBCHAT_RESUME_TOKEN;
    if (!resumeToken) throw new Error("WEBCHAT_RESUME_TOKEN missing from installed env file");
    const approvalWrongToken = await fetchWithTimeout(`http://127.0.0.1:${port}/approval`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }, FETCH_TIMEOUT_MS, "approval wrong-token GET");
    if (approvalWrongToken.status !== 401) {
      throw new Error(`/approval accepted inbound token: ${approvalWrongToken.status}`);
    }
    const approvalOk = await fetchWithTimeout(`http://127.0.0.1:${port}/approval`, {
      method: "GET",
      headers: { authorization: `Bearer ${resumeToken}` },
    }, FETCH_TIMEOUT_MS, "approval resume-token GET");
    if (!approvalOk.ok) {
      throw new Error(`/approval rejected resume token: ${approvalOk.status} ${await approvalOk.text()}`);
    }
    const approvalBody = await approvalOk.json() as { pending_approvals?: unknown };
    if (!Array.isArray(approvalBody.pending_approvals)) {
      throw new Error("/approval response did not include pending_approvals array");
    }
    console.log("approval_flow_result=pass");

    const nodeExe = findBundledNode(installRoot);
    run(nodeExe, [
      "apps/gateway/dist/main.js",
      "--audit-verify",
      "--env-file",
      envFile,
    ], installRoot, "installed audit verify", 60_000, isolatedProductEnv);
    const auditDir = env.BLUE_TANUKI_AUDIT_DIR;
    if (!auditDir) throw new Error("BLUE_TANUKI_AUDIT_DIR missing from installed env file");
    const tamperEnvFile = writeTamperedAuditEnv(envFile, auditDir, work);
    const tamperOutput = runExpectingStatus(nodeExe, [
      "apps/gateway/dist/main.js",
      "--audit-verify",
      "--env-file",
      tamperEnvFile,
    ], installRoot, 1, "installed audit tamper verify", 60_000, isolatedProductEnv);
    if (
      !tamperOutput.includes("BROKEN") &&
      !tamperOutput.includes("chain_valid: false") &&
      !tamperOutput.includes("invalid_entry_shape")
    ) {
      throw new Error("audit tamper verification did not report a broken chain");
    }
    console.log("audit_tamper_result=pass");

    const pidFile = path.join(dataRoot, "blue-tanuki.pid");
    const originalPid = readPidFile(pidFile);
    if (!originalPid) throw new Error("resident pid file was not written before crash recovery probe");
    stopVerifiedResidentProcess(originalPid, nodeExe, envFile, installRoot, isolatedProductEnv);
    const recoveredPid = await waitForPidChange(pidFile, originalPid, CRASH_RECOVERY_TIMEOUT_MS);
    if (!recoveredPid) throw new Error("resident watchdog did not write a recovered pid after simulated crash");
    const recoveredHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!recoveredHealthReady) throw new Error("installed gateway healthz did not recover after simulated resident crash");
    console.log("crash_recovery_result=pass");

    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "status",
    ], installRoot, "launcher status running", 60_000, isolatedProductEnv);
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher stop", 60_000, isolatedProductEnv);
    stopped = true;
    const stoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!stoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher stop");
    console.log("stop_result=pass");

    runAllowing("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "doctor",
    ], installRoot, [0, 1], "launcher doctor", 120_000, isolatedProductEnv);
    console.log("doctor_result=pass");

    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "restart",
    ], installRoot, "launcher restart", 120_000, isolatedProductEnv);
    stopped = false;
    logStep("wait installed gateway healthz after restart");
    const restartHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!restartHealthReady) throw new Error("installed gateway healthz did not become ready after restart");
    logStep("done installed gateway healthz after restart");
    console.log("restart_result=pass");
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher final stop", 60_000, isolatedProductEnv);
    stopped = true;
    const finalStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!finalStoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher final stop");
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "safe-mode",
    ], installRoot, "launcher safe mode", 120_000, isolatedProductEnv);
    stopped = false;
    const safeModeHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!safeModeHealthReady) throw new Error("installed gateway healthz did not become ready in safe mode");
    console.log("safe_mode_result=pass");
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher safe mode stop", 60_000, isolatedProductEnv);
    stopped = true;
    const safeModeStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!safeModeStoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher safe mode stop");

    logStep("prepare an isolated Windows update package and retention evidence");
    const updateRetentionFile = path.join(dataRoot, "windows-update-retention-sentinel.txt");
    const updateRetentionValue = "G02.03 isolated state survives update failure and recovery\n";
    writeFileSync(updateRetentionFile, updateRetentionValue, { encoding: "utf8", flag: "wx" });
    const updateEnvBefore = Buffer.from(readFileSync(envFile));
    const updateInventoryBefore = Buffer.from(readFileSync(path.join(installRoot, "blue-tanuki-managed-files.json")));
    const installedNodeRelative = path.relative(installRoot, findBundledNode(installRoot));
    const updatePackageParent = path.join(work, "update-package");
    const updatePackageDir = path.join(updatePackageParent, path.basename(packageDir));
    mkdirSync(updatePackageParent, { recursive: true });
    cpSync(packageDir, updatePackageDir, { recursive: true });
    if (!existsSync(path.join(updatePackageDir, "app")) || !existsSync(path.join(updatePackageDir, "BlueTanukiSetup.ps1"))) {
      throw new Error("isolated Windows update package copy is incomplete");
    }
    const updateMarkerValue = "G02.03 verified Windows package update marker\n";
    const updateMarkerInPackage = path.join(updatePackageDir, "app", "g02-update-marker.txt");
    writeFileSync(updateMarkerInPackage, updateMarkerValue, { encoding: "utf8", flag: "wx" });
    const setupHook = windowsSetupMoveHookScript();
    const updateSetupEnv = {
      ...isolatedProductEnv,
      BT_TEST_SETUP_SCRIPT: path.join(updatePackageDir, "BlueTanukiSetup.ps1"),
      BT_TEST_INSTALL_ROOT: installRoot,
      BT_TEST_DATA_ROOT: dataRoot,
    };

    logStep("inject a Windows update failure after the verified backup move");
    const failedUpdateMarker = path.join(isolatedTemp, `BlueTanukiUpdateFailure-${randomUUID()}.marker`);
    const failedUpdateOutput = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      setupHook,
    ], updatePackageDir, 1, "installed Windows update failure rollback", INSTALLER_TRANSACTION_TIMEOUT_MS, {
      ...updateSetupEnv,
      BT_TEST_MOVE_MODE: "fail-stage",
      BT_TEST_MOVE_MARKER: failedUpdateMarker,
    });
    if (!existsSync(failedUpdateMarker) || !/^\d+$/.test(readFileSync(failedUpdateMarker, "utf8").trim()) ||
        !failedUpdateOutput.includes("blue-tanuki injected installed update failure after verified backup move")) {
      throw new Error("Windows update failure did not reach the controlled post-backup transaction point");
    }
    const transactionPrefix = `.${path.basename(installRoot)}.blue-tanuki-`;
    const transactionSiblingsAfterFailure = readdirSync(work).filter((entry) =>
      entry.startsWith(transactionPrefix) && /\.(?:stage|rollback)-(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(entry));
    const failedUpdateRegistry = readSmokeRegistryState(autostartRunName, "post update-failure registry check");
    if (!existsSync(installRoot) || existsSync(path.join(installRoot, "g02-update-marker.txt")) ||
        !readFileSync(path.join(installRoot, "blue-tanuki-managed-files.json")).equals(updateInventoryBefore) ||
        !existsSync(path.join(installRoot, installedNodeRelative)) ||
        !readFileSync(envFile).equals(updateEnvBefore) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue ||
        transactionSiblingsAfterFailure.length !== 0 || !failedUpdateRegistry.uninstallPresent || failedUpdateRegistry.autostartPresent ||
        !(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
      throw new Error("failed Windows update did not restore the previous app/runtime while retaining settings/data and stopping the resident");
    }
    console.log("update_failure_rollback_result=pass");

    logStep("interrupt an isolated Windows update after moving the old install to rollback");
    const interruptedUpdateMarker = path.join(isolatedTemp, `BlueTanukiUpdateInterrupted-${randomUUID()}.marker`);
    await interruptWindowsInstallerAfterRollbackMove(setupHook, updatePackageDir, interruptedUpdateMarker, INSTALLER_TRANSACTION_TIMEOUT_MS, {
      ...updateSetupEnv,
      BT_TEST_MOVE_MODE: "interrupt-rollback",
      BT_TEST_MOVE_MARKER: interruptedUpdateMarker,
    });
    const rollbackPrefix = `${transactionPrefix}rollback-`;
    const stagePrefix = `${transactionPrefix}stage-`;
    const rollbackSiblings = readdirSync(work).filter((entry) => entry.startsWith(rollbackPrefix) && /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(entry.slice(rollbackPrefix.length)));
    const stageSiblings = readdirSync(work).filter((entry) => entry.startsWith(stagePrefix) && /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(entry.slice(stagePrefix.length)));
    if (existsSync(installRoot) || rollbackSiblings.length !== 1 || stageSiblings.length !== 1) {
      throw new Error("interrupted Windows update did not leave one exact old-install rollback and its paired staging directory");
    }
    const interruptedRollbackRoot = path.join(work, rollbackSiblings[0]!);
    if (!readFileSync(path.join(interruptedRollbackRoot, "blue-tanuki-managed-files.json")).equals(updateInventoryBefore) ||
        !existsSync(path.join(interruptedRollbackRoot, installedNodeRelative)) ||
        !readFileSync(envFile).equals(updateEnvBefore) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue ||
        !(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
      throw new Error("interrupted Windows update changed the verified old app/runtime, retained settings/data, or left a resident process");
    }
    const recoveryOutput = runExpectingStatus("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(updatePackageDir, "BlueTanukiSetup.cmd"),
      "-InstallRoot",
      installRoot,
      "-DataRoot",
      dataRoot,
      "-NoLaunch",
    ], updatePackageDir, 0, "installed Windows interrupted-update recovery and resumed update", INSTALLER_TRANSACTION_TIMEOUT_MS, isolatedProductEnv);
    const transactionSiblingsAfterRecovery = readdirSync(work).filter((entry) =>
      entry.startsWith(transactionPrefix) && /\.(?:stage|rollback)-(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(entry));
    const recoveredUpdateRegistry = readSmokeRegistryState(autostartRunName, "post interrupted-update recovery registry check");
    if (!recoveryOutput.includes("Restored one verified previous BLUE-TANUKI install after an interrupted update") ||
        readFileSync(path.join(installRoot, "g02-update-marker.txt"), "utf8") !== updateMarkerValue ||
        readFileSync(path.join(installRoot, "blue-tanuki-managed-files.json")).equals(updateInventoryBefore) ||
        !existsSync(path.join(installRoot, installedNodeRelative)) ||
        !readFileSync(envFile).equals(updateEnvBefore) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue ||
        transactionSiblingsAfterRecovery.length !== 0 || !recoveredUpdateRegistry.uninstallPresent || recoveredUpdateRegistry.autostartPresent ||
        !(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
      throw new Error("Windows interrupted-update recovery did not resume the new package while retaining settings/data and stopping the resident");
    }
    console.log("interrupted_update_recovery_result=pass");
    console.log("interrupted_update_staging_cleanup_result=pass");

    const retainedEnvFile = path.join(dataRoot, "blue-tanuki.env");
    const syntheticSecret = `synthetic-uninstall-secret-${randomUUID()}`;
    const storedSecret = storeLlmApiKeySecret("OPENROUTER_API_KEY", syntheticSecret, {
      envFilePath: retainedEnvFile,
      platform: "win32",
    });
    if (storedSecret.storage !== "win32_dpapi_current_user" || !storedSecret.os_protected) {
      throw new Error("isolated uninstall secret was not stored with Windows DPAPI CurrentUser protection");
    }
    appendEnvFileValue(retainedEnvFile, storedSecret.ref_key, storedSecret.ref);
    const secretFile = path.join(dataRoot, "secrets", "openrouter_api_key.dpapi");
    if (!existsSync(secretFile)) throw new Error("isolated DPAPI secret file was not created under the DataRoot");
    const secretBytesBeforeUninstall = readFileSync(secretFile);
    if (secretBytesBeforeUninstall.toString("utf8").includes(syntheticSecret) ||
        resolveSecretMaterial(parseEnvFile(retainedEnvFile), "OPENROUTER_API_KEY", { platform: "win32" }) !== syntheticSecret) {
      throw new Error("isolated DPAPI secret was not protected and readable through its stored reference");
    }
    const retainedEnvBeforeUninstall = readFileSync(retainedEnvFile);
    const retainedSentinel = path.join(dataRoot, "user-data-retention-sentinel.txt");
    const retainedSentinelContents = `BLUE-TANUKI isolated installed smoke ${randomUUID()}\n`;
    writeFileSync(retainedSentinel, retainedSentinelContents, { encoding: "utf8", flag: "wx" });
    logStep("uninstall without purge and verify registered user data is retained");
    const defaultUninstallOutput = runExpectingStatus("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(installRoot, "UninstallBlueTanuki.cmd"),
    ], work, 0, "installer uninstall with retained data", 300_000, {
      ...isolatedProductEnv,
      BLUE_TANUKI_UNINSTALL_STATUS_FILE: retentionUninstallStatusFile,
    }, [syntheticSecret]);
    if (!defaultUninstallOutput.includes("Will retain all contents under the registered product data root:") ||
        !defaultUninstallOutput.includes("DPAPI-protected provider credentials") ||
        defaultUninstallOutput.includes(syntheticSecret)) {
      throw new Error("default uninstall did not clearly disclose retained DPAPI credentials without exposing their value");
    }
    const retentionUninstallStatus = await waitForFileText(retentionUninstallStatusFile, UNINSTALL_TIMEOUT_MS);
    if (!retentionUninstallStatus || !/^exit_code=0\b/m.test(retentionUninstallStatus.replace(/^\uFEFF/, ""))) {
      throw new Error("default uninstall status did not confirm success");
    }
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) {
      throw new Error("install root still exists after default uninstall");
    }
    const retainedSentinelAfterUninstall = readFileSync(retainedSentinel, "utf8");
    const retainedEnvAfterUninstall = readFileSync(retainedEnvFile);
    const retainedSecretAfterUninstall = resolveSecretMaterial(parseEnvFile(retainedEnvFile), "OPENROUTER_API_KEY", { platform: "win32" });
    if (!existsSync(dataRoot) || retainedSentinelAfterUninstall !== retainedSentinelContents ||
        !retainedEnvAfterUninstall.equals(retainedEnvBeforeUninstall) ||
        !readFileSync(secretFile).equals(secretBytesBeforeUninstall) || retainedSecretAfterUninstall !== syntheticSecret) {
      throw new Error("default uninstall did not preserve isolated content, settings, and the decryptable DPAPI credential");
    }
    assertSmokeRegistryAbsent(autostartRunName, "post retention uninstall registry check");
    console.log("uninstall_data_retention_result=pass");
    console.log("uninstall_secret_retention_result=pass");

    logStep("reinstall into the same roots and verify retained data remains usable");
    run("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(packageDir, "BlueTanukiSetup.cmd"),
      "-InstallRoot",
      installRoot,
      "-DataRoot",
      dataRoot,
      "-NoLaunch",
    ], packageDir, "installer reinstall with retained data", 600_000, isolatedProductEnv);
    const retainedSentinelAfterReinstall = readFileSync(retainedSentinel, "utf8");
    const retainedEnvAfterReinstall = readFileSync(retainedEnvFile);
    const retainedSecretAfterReinstall = resolveSecretMaterial(parseEnvFile(retainedEnvFile), "OPENROUTER_API_KEY", { platform: "win32" });
    if (!existsSync(path.join(installRoot, "BlueTanukiLauncher.ps1")) ||
        retainedSentinelAfterReinstall !== retainedSentinelContents ||
        !retainedEnvAfterReinstall.equals(retainedEnvBeforeUninstall) ||
        !readFileSync(secretFile).equals(secretBytesBeforeUninstall) || retainedSecretAfterReinstall !== syntheticSecret) {
      throw new Error("reinstall did not retain isolated content, settings, and the decryptable DPAPI credential");
    }
    const reinstalledRegistry = readSmokeRegistryState(autostartRunName, "post retention reinstall registry check");
    if (!reinstalledRegistry.uninstallPresent || reinstalledRegistry.autostartPresent) {
      throw new Error(`reinstall registry state was unexpected uninstall=${reinstalledRegistry.uninstallPresent} autostart=${reinstalledRegistry.autostartPresent}`);
    }
    console.log("reinstall_retained_data_result=pass");

    logStep("explicitly purge only the isolated smoke DataRoot");
    const purgeUninstallOutput = runExpectingStatus("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(installRoot, "UninstallBlueTanuki.cmd"),
      "-PurgeData",
    ], work, 0, "installer uninstall with explicit data purge", 300_000, {
      ...isolatedProductEnv,
      BLUE_TANUKI_UNINSTALL_STATUS_FILE: uninstallStatusFile,
    }, [syntheticSecret]);
    if (!purgeUninstallOutput.includes("Will permanently remove the full product data root and every file under it:") ||
        !purgeUninstallOutput.includes("DPAPI-protected provider credentials") || purgeUninstallOutput.includes(syntheticSecret)) {
      throw new Error("explicit purge did not clearly disclose DPAPI credential removal without exposing its value");
    }
    const uninstallStatus = await waitForFileText(uninstallStatusFile, UNINSTALL_TIMEOUT_MS);
    if (!uninstallStatus) throw new Error("uninstall status file was not written");
    const normalizedUninstallStatus = uninstallStatus.replace(/^\uFEFF/, "");
    if (!/^exit_code=0\b/m.test(normalizedUninstallStatus)) {
      throw new Error(`uninstall status was not successful: ${uninstallStatus.trim()}`);
    }
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) {
      throw new Error("install root still exists after explicit purge uninstall");
    }
    if (!(await waitForAbsent(dataRoot, UNINSTALL_TIMEOUT_MS))) {
      throw new Error("isolated data root still exists after explicit purge uninstall");
    }
    if (existsSync(secretFile)) throw new Error("explicit purge left the isolated DPAPI secret file behind");
    assertSmokeRegistryAbsent(autostartRunName, "post uninstall registry check");
    uninstalled = true;
    allowWorkCleanup = true;

    console.log("windows_installed_smoke=pass");
    console.log("source_tree_setup_guidance_result=pass");
    console.log("root_source_entrypoint_result=pass");
    console.log("root_source_entrypoint_build_from_source_result=pass");
    console.log("root_source_entrypoint_cmd_result=pass");
    console.log("installer_zip_setup_result=pass");
    console.log("install_result=pass");
    console.log("launch_result=pass");
    console.log("gui_result=pass");
    console.log("first_message_result=pass");
    console.log("repair_install_result=pass");
    console.log("reboot_persistence_result=pass");
    console.log("port_conflict_result=pass");
    console.log("approval_flow_result=pass");
    console.log("audit_tamper_result=pass");
    console.log("crash_recovery_result=pass");
    console.log("safe_mode_result=pass");
    console.log("defender_smartscreen_guidance_result=pass");
    console.log("uninstall_data_purge_result=pass");
    console.log("uninstall_result=pass");
  } catch (error) {
    smokeFailure = error;
  } finally {
    if (process.platform === "win32") {
      if (launcher && existsSync(launcher)) {
        try {
          runExpectingStatus("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            launcher,
            "resident-autostart-disable",
          ], installRoot, 0, "cleanup launcher autostart disable", 60_000, {
            ...isolatedProductEnv,
            BLUE_TANUKI_AUTOSTART_RUN_NAME: autostartRunName,
          });
        } catch (error) {
          console.error(`[windows-smoke] cleanup autostart disable failed: ${errorMessage(error)}`);
        }
      }
      if (launcher && existsSync(launcher) && !stopped) {
        try {
          runAllowing("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            launcher,
            "stop",
          ], installRoot, [0, 1], "cleanup launcher stop", 60_000, {
            ...isolatedProductEnv,
            BLUE_TANUKI_AUTOSTART_RUN_NAME: autostartRunName,
          });
        } catch (error) {
          console.error(`[windows-smoke] cleanup launcher stop failed: ${errorMessage(error)}`);
        }
      }
      if (setupAttempted && !uninstalled) {
        const cleanupStatusFile = path.join(isolatedTemp, `BlueTanukiUninstall-${randomUUID()}.status`);
        try {
          const installWasPresent = existsSync(installRoot);
          if (installWasPresent) {
            const uninstaller = path.join(installRoot, "UninstallBlueTanuki.cmd");
            if (!existsSync(uninstaller)) throw new Error("installed uninstaller is unavailable for safe cleanup");
            run("cmd.exe", [
              "/d",
              "/s",
              "/c",
              uninstaller,
              "-PurgeData",
              "-Quiet",
            ], work, "cleanup installer uninstall", 300_000, {
              ...isolatedProductEnv,
              BLUE_TANUKI_UNINSTALL_STATUS_FILE: cleanupStatusFile,
            });
            const cleanupStatus = await waitForFileText(cleanupStatusFile, UNINSTALL_TIMEOUT_MS);
            if (!cleanupStatus || !/^exit_code=0\b/m.test(cleanupStatus.replace(/^\uFEFF/, ""))) {
              throw new Error("cleanup uninstall status did not confirm success");
            }
          }
          const installAbsent = await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS);
          const dataAbsent = await waitForAbsent(dataRoot, UNINSTALL_TIMEOUT_MS);
          const registryState = readSmokeRegistryState(autostartRunName, "cleanup registry verification");
          const startMenuAbsent = !existsSync(startMenuRoot);
          const stagePrefix = `.${path.basename(installRoot)}.blue-tanuki-stage-`;
          const preservedStages = readdirSync(work).filter((entry) => entry.startsWith(stagePrefix));
          if (!installAbsent || (installWasPresent && !dataAbsent) || !startMenuAbsent || preservedStages.length > 0 || registryState.uninstallPresent || registryState.autostartPresent) {
            throw new Error(`cleanup left product state installAbsent=${installAbsent} dataAbsent=${dataAbsent} startMenuAbsent=${startMenuAbsent} installWasPresent=${installWasPresent} preservedStages=${preservedStages.join(",")} uninstallKey=${registryState.uninstallPresent} autostart=${registryState.autostartPresent}`);
          }
          assertNoActiveGatewayProcesses("post-uninstall installed smoke process check");
          // work is created uniquely for this run; when Setup never committed an
          // install, any DataRoot contents beneath it are test-generated only.
          allowWorkCleanup = true;
        } catch (error) {
          console.error(`[windows-smoke] cleanup installer uninstall failed: ${errorMessage(error)}`);
          cleanupFailure = error instanceof Error ? error : new Error(String(error));
          const cleanupStatus = existsSync(cleanupStatusFile)
            ? readFileSync(cleanupStatusFile, "utf8").trim().replace(/^exit_code=/m, "")
            : "absent";
          const stagedHelperCount = existsSync(isolatedTemp)
            ? readdirSync(isolatedTemp).filter((entry) => /^BlueTanuki(?:Uninstall|SafeTarget)-.*\.ps1$/i.test(entry)).length
            : 0;
          console.error(`[windows-smoke] cleanup_uninstall_state ${JSON.stringify({
            install_root_present: existsSync(installRoot),
            data_root_present: existsSync(dataRoot),
            status_file: cleanupStatus,
            staged_script_count: stagedHelperCount,
          })}`);
        }
      } else if (!setupAttempted || uninstalled) {
        allowWorkCleanup = true;
      }
    } else {
      allowWorkCleanup = true;
    }
    if (allowWorkCleanup) {
      logStep("cleanup temporary install tree after product-state verification");
      await removeTreeBestEffort(work);
    } else {
      console.error(`[windows-smoke] preserving temporary install tree because product cleanup is unconfirmed: ${work}`);
    }
  }
  if (smokeFailure && cleanupFailure) {
    throw new Error(`installed smoke failed: ${errorMessage(smokeFailure)}; cleanup also failed: ${errorMessage(cleanupFailure)}`);
  }
  if (smokeFailure) throw smokeFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (startupOnlySmokePassed) console.log("windows_installed_startup_smoke=pass");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
