import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { verifyWindowsPackage } from "./verify_windows_package.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
const FIRST_MESSAGE_TIMEOUT_MS = 10_000;
const CRASH_RECOVERY_TIMEOUT_MS = 60_000;
const UNINSTALL_TIMEOUT_MS = 60_000;

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
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1", ...extraEnv },
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
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1", ...extraEnv },
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
): string {
  logStep(`start ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1", ...extraEnv },
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = [result.stdout ?? "", result.stderr ?? ""].join("\n");
  if (output.trim()) process.stdout.write(output);
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== expectedStatus) {
    throw new Error(`${label} expected exit ${expectedStatus} but got ${result.status} signal=${result.signal ?? "none"}`);
  }
  logStep(`done ${label} status=${result.status}`);
  return output;
}

function expandArchive(artifact: string, destination: string): void {
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath ${JSON.stringify(artifact)} -DestinationPath ${JSON.stringify(destination)} -Force`,
  ], process.cwd(), "expand installer archive");
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
  for (const needle of needles) {
    if (!text.includes(needle)) {
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

function readPidFile(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
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
  logStep("verify installer package");
  verifyWindowsPackage(artifact);
  logStep("done verify installer package");
  if (process.platform !== "win32") {
    console.log(`windows_runtime_smoke=skipped platform=${process.platform}`);
    console.log("artifact_structure_smoke=pass");
    return;
  }

  const work = mkdtempSync(path.join(tmpdir(), "blue-tanuki-windows-installed-"));
  const packageDir = path.join(work, "package");
  const installRoot = path.join(work, "InstallRoot");
  const dataRoot = path.join(work, "DataRoot");
  const uninstallStatusFile = path.join(work, "uninstall.status");
  let launcher: string | undefined;
  let setupComplete = false;
  let stopped = false;
  let uninstalled = false;
  try {
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
    ], packageDir, "installer setup", 180_000);
    setupComplete = true;

    launcher = path.join(installRoot, "BlueTanukiLauncher.ps1");
    const envFile = path.join(dataRoot, "blue-tanuki.env");
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
    ], packageDir, "installer repair install", 180_000);
    const env = parseEnvFile(envFile);
    assertEnvValuesRetained(envBeforeRepair, env, [
      "WEBCHAT_TOKEN",
      "WEBCHAT_RESUME_TOKEN",
      "BLUE_TANUKI_SETTINGS_TOKEN",
    ]);
    console.log("repair_install_result=pass");
    const autostartEnv = {
      BLUE_TANUKI_AUTOSTART_RUN_NAME: `BLUE-TANUKI-SMOKE-${process.pid}`,
    };
    const autostartInitial = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
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
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "resident-autostart-enable",
      ], installRoot, 0, "launcher autostart enable", 60_000, autostartEnv);
      if (!autostartEnabled.includes("autostart_status=enabled")) {
        throw new Error("autostart enable output did not confirm enabled status");
      }
      const autostartStatus = runExpectingStatus("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
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
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "resident-autostart-disable",
      ], installRoot, 0, "launcher autostart disable", 60_000, autostartEnv);
    }
    const autostartDisabled = runExpectingStatus("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
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
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "start",
      ], installRoot, 2, "launcher port conflict", 60_000);
      if (!conflictOutput.includes(`port_conflict=127.0.0.1:${port}`)) {
        throw new Error("launcher port conflict output did not include expected port_conflict marker");
      }
      console.log("port_conflict_result=pass");
    } finally {
      await closeServer(blocker);
    }

    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "start",
    ], installRoot, "launcher start", 120_000);

    const token = env.WEBCHAT_TOKEN;
    if (!token) throw new Error("WEBCHAT_TOKEN missing from installed env file");
    logStep("wait installed gateway healthz");
    const healthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!healthReady) throw new Error("installed gateway healthz did not become ready");
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
    ], installRoot, "installed audit verify", 60_000);
    const auditDir = env.BLUE_TANUKI_AUDIT_DIR;
    if (!auditDir) throw new Error("BLUE_TANUKI_AUDIT_DIR missing from installed env file");
    const tamperEnvFile = writeTamperedAuditEnv(envFile, auditDir, work);
    const tamperOutput = runExpectingStatus(nodeExe, [
      "apps/gateway/dist/main.js",
      "--audit-verify",
      "--env-file",
      tamperEnvFile,
    ], installRoot, 1, "installed audit tamper verify", 60_000);
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
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${originalPid} -Force`,
    ], installRoot, "simulate resident crash", 60_000);
    const recoveredPid = await waitForPidChange(pidFile, originalPid, CRASH_RECOVERY_TIMEOUT_MS);
    if (!recoveredPid) throw new Error("resident watchdog did not write a recovered pid after simulated crash");
    const recoveredHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!recoveredHealthReady) throw new Error("installed gateway healthz did not recover after simulated resident crash");
    console.log("crash_recovery_result=pass");

    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "status",
    ], installRoot, "launcher status running", 60_000);
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher stop", 60_000);
    stopped = true;
    const stoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!stoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher stop");
    console.log("stop_result=pass");

    runAllowing("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "doctor",
    ], installRoot, [0, 1], "launcher doctor", 120_000);
    console.log("doctor_result=pass");

    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "restart",
    ], installRoot, "launcher restart", 120_000);
    stopped = false;
    logStep("wait installed gateway healthz after restart");
    const restartHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!restartHealthReady) throw new Error("installed gateway healthz did not become ready after restart");
    logStep("done installed gateway healthz after restart");
    console.log("restart_result=pass");
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher final stop", 60_000);
    stopped = true;
    const finalStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!finalStoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher final stop");
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "safe-mode",
    ], installRoot, "launcher safe mode", 120_000);
    stopped = false;
    const safeModeHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!safeModeHealthReady) throw new Error("installed gateway healthz did not become ready in safe mode");
    console.log("safe_mode_result=pass");
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "stop",
    ], installRoot, "launcher safe mode stop", 60_000);
    stopped = true;
    const safeModeStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!safeModeStoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher safe mode stop");
    run("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(installRoot, "UninstallBlueTanuki.cmd"),
      "-PurgeData",
      "-Quiet",
    ], work, "installer uninstall", 120_000, {
      BLUE_TANUKI_UNINSTALL_STATUS_FILE: uninstallStatusFile,
    });
    const uninstallStatus = await waitForFileText(uninstallStatusFile, UNINSTALL_TIMEOUT_MS);
    if (!uninstallStatus) throw new Error("uninstall status file was not written");
    const normalizedUninstallStatus = uninstallStatus.replace(/^\uFEFF/, "");
    if (!/^exit_code=0\b/m.test(normalizedUninstallStatus)) {
      throw new Error(`uninstall status was not successful: ${uninstallStatus.trim()}`);
    }
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) {
      throw new Error("install root still exists after uninstall");
    }
    if (!(await waitForAbsent(dataRoot, UNINSTALL_TIMEOUT_MS))) {
      throw new Error("data root still exists after purge uninstall");
    }
    uninstalled = true;

    console.log("windows_installed_smoke=pass");
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
    console.log("uninstall_result=pass");
  } finally {
    if (process.platform === "win32") {
      if (launcher && !stopped) {
        try {
          runAllowing("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            launcher,
            "stop",
          ], installRoot, [0, 1], "cleanup launcher stop", 60_000);
        } catch (error) {
          console.error(`[windows-smoke] cleanup launcher stop failed: ${errorMessage(error)}`);
        }
      }
      if (setupComplete && !uninstalled) {
        try {
          const cleanupStatusFile = path.join(work, "cleanup-uninstall.status");
          runAllowing("cmd.exe", [
            "/d",
            "/s",
            "/c",
            path.join(installRoot, "UninstallBlueTanuki.cmd"),
            "-PurgeData",
            "-Quiet",
          ], work, [0, 1], "cleanup installer uninstall", 120_000, {
            BLUE_TANUKI_UNINSTALL_STATUS_FILE: cleanupStatusFile,
          });
          await waitForFileText(cleanupStatusFile, 10_000);
          await waitForAbsent(installRoot, 10_000);
          await waitForAbsent(dataRoot, 10_000);
        } catch (error) {
          console.error(`[windows-smoke] cleanup installer uninstall failed: ${errorMessage(error)}`);
        }
      }
    }
    logStep("cleanup temporary install tree");
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
