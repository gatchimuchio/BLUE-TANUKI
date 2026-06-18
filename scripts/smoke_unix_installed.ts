import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { verifyUnixPackage } from "./verify_unix_package.ts";

type UnixPlatform = "linux" | "macos";
type UnixArch = "x64" | "arm64";

const COMMAND_TIMEOUT_MS = 120_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
const FIRST_MESSAGE_TIMEOUT_MS = 10_000;
const CRASH_RECOVERY_TIMEOUT_MS = 60_000;
const UNINSTALL_TIMEOUT_MS = 30_000;
const INSTALLED_SMOKE_MARKERS: Record<UnixPlatform, string> = {
  linux: "linux_installed_smoke=pass",
  macos: "macos_installed_smoke=pass",
};

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function currentPlatform(): UnixPlatform {
  return process.platform === "darwin" ? "macos" : "linux";
}

function currentArch(): UnixArch {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function targetPlatform(): UnixPlatform {
  const value = argValue("--platform");
  if (!value) return currentPlatform();
  if (value === "linux" || value === "macos") return value;
  if (value === "darwin") return "macos";
  throw new Error(`unsupported Unix smoke platform: ${value}`);
}

function targetArch(platform: UnixPlatform): UnixArch {
  if (platform === "linux") return "x64";
  const value = argValue("--arch");
  if (!value) return currentArch();
  if (value === "x64" || value === "arm64") return value;
  if (value === "x86_64" || value === "amd64") return "x64";
  throw new Error(`unsupported Unix smoke arch: ${value}`);
}

function defaultArtifact(platform: UnixPlatform, arch: UnixArch): string {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
  return path.join(process.cwd(), "release", platform, `blue-tanuki-${pkg.version}-${platform}-${arch}-installer.tar.gz`);
}

function logStep(message: string): void {
  console.log(`[unix-smoke] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandLog(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
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
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
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
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
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
    env: { ...process.env, ...extraEnv },
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const output = commandLog(result);
  if (output.trim()) process.stdout.write(output);
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== expectedStatus) {
    throw new Error(`${label} expected exit ${expectedStatus} but got ${result.status} signal=${result.signal ?? "none"}`);
  }
  logStep(`done ${label} status=${result.status}`);
  return output;
}

function extractArchive(artifact: string, destination: string): void {
  run("tar", ["-xzf", artifact, "-C", destination], process.cwd(), "extract installer archive");
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

function findBundledNode(runtimeRoot: string): string {
  const stack = [runtimeRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry === "node") {
        return full;
      }
    }
  }
  throw new Error(`bundled node not found under ${runtimeRoot}`);
}

function writeTamperedAuditEnv(sourceEnvFile: string, sourceAuditDir: string, targetRoot: string): string {
  const tamperAuditDir = path.join(targetRoot, "tampered-audit");
  const sourceAuditFile = path.join(sourceAuditDir, "audit.jsonl");
  const targetAuditFile = path.join(tamperAuditDir, "audit.jsonl");
  if (!existsSync(sourceAuditFile)) throw new Error(`audit file missing before tamper probe: ${sourceAuditFile}`);
  run("mkdir", ["-p", tamperAuditDir], targetRoot, "create tamper audit dir", 10_000);
  writeFileSync(targetAuditFile, `${readFileSync(sourceAuditFile, "utf8")}\n{"tampered":true}\n`, "utf8");
  const tamperEnvFile = path.join(targetRoot, "tampered-audit.env");
  const source = readFileSync(sourceEnvFile, "utf8");
  const next = source.replace(/^BLUE_TANUKI_AUDIT_DIR=.*$/m, `BLUE_TANUKI_AUDIT_DIR="${tamperAuditDir}"`);
  if (next === source) throw new Error("BLUE_TANUKI_AUDIT_DIR missing from installed env file");
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
    ws.once("open", () => finish());
    ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
  await sleep(250);
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ user: "unix-smoke", content: "Hello BLUE-TANUKI Unix installer smoke" }),
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
  const platform = targetPlatform();
  const arch = targetArch(platform);
  const artifact = path.resolve(argValue("--artifact") ?? defaultArtifact(platform, arch));
  logStep("verify installer package");
  verifyUnixPackage(artifact, platform, arch);
  logStep("done verify installer package");
  if (process.platform === "win32" || currentPlatform() !== platform || (platform === "macos" && currentArch() !== arch)) {
    console.log(`${platform}_runtime_smoke=skipped platform=${process.platform} arch=${process.arch}`);
    console.log("artifact_structure_smoke=pass");
    return;
  }

  const work = mkdtempSync(path.join(tmpdir(), `blue-tanuki-${platform}-installed-`));
  const packageDir = path.join(work, "package");
  const homeDir = path.join(work, "home");
  const installRoot = path.join(work, "InstallRoot");
  const dataRoot = path.join(work, "DataRoot");
  const configRoot = path.join(work, "ConfigRoot");
  const runtimeRoot = path.join(work, "RuntimeRoot");
  const binRoot = path.join(work, "BinRoot");
  const env: Record<string, string> = {
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    NO_LAUNCH: "1",
  };
  let stopped = true;
  try {
    run("mkdir", ["-p", packageDir, homeDir, binRoot], work, "create smoke dirs", 10_000, env);
    extractArchive(artifact, packageDir);

    const entrypoint = path.join(process.cwd(), platform === "macos" ? "INSTALL_MACOS.sh" : "INSTALL_LINUX.sh");
    const emptyReleaseDir = path.join(work, "empty-release");
    run("mkdir", ["-p", emptyReleaseDir], work, "create empty release dir", 10_000, env);
    const rootDryRun = runExpectingStatus("sh", [
      entrypoint,
      "--dry-run",
      "--release-dir",
      emptyReleaseDir,
      "--work-root",
      path.join(work, "entrypoint-dry-run"),
      "--no-launch",
    ], work, 0, `${platform} root source entrypoint dry-run`, 60_000, env);
    if (!rootDryRun.includes("wrong_asset=source_zip")) {
      throw new Error(`${platform} root entrypoint did not identify source zip/source tree when installer archive was absent`);
    }
    if (!rootDryRun.includes("would_download_release_installer=")) {
      throw new Error(`${platform} root entrypoint did not choose verified release download path`);
    }
    if (rootDryRun.includes("would_run=pnpm")) {
      throw new Error(`${platform} root entrypoint default dry-run must not run pnpm`);
    }
    if (!rootDryRun.includes(`${platform}_source_entrypoint_dry_run=pass`)) {
      throw new Error(`${platform} root entrypoint dry-run marker missing`);
    }
    console.log(`${platform}_source_entrypoint_result=pass`);

    const developerDryRun = runExpectingStatus("sh", [
      entrypoint,
      "--dry-run",
      "--build-from-source",
      "--release-dir",
      emptyReleaseDir,
      "--work-root",
      path.join(work, "developer-dry-run"),
      "--no-launch",
    ], work, 0, `${platform} explicit developer build dry-run`, 60_000, env);
    if (!developerDryRun.includes("developer_build_from_source=true")) {
      throw new Error(`${platform} explicit --build-from-source did not mark developer path`);
    }
    if (!developerDryRun.includes(`would_run=sh ./install/${platform === "macos" ? "macos" : "linux"}/install.sh`)) {
      throw new Error(`${platform} explicit --build-from-source did not call source install script`);
    }
    console.log(`${platform}_source_entrypoint_build_from_source_result=pass`);

    const setup = path.join(packageDir, platform === "macos" ? "BlueTanukiSetup.command" : "BlueTanukiSetup.sh");
    run("sh", [
      setup,
      "--install-root",
      installRoot,
      "--data-root",
      dataRoot,
      "--config-root",
      configRoot,
      "--runtime-root",
      runtimeRoot,
      "--bin-root",
      binRoot,
      "--no-launch",
    ], packageDir, "installer setup", 180_000, env);
    console.log("installer_archive_setup_result=pass");

    const launcher = path.join(installRoot, "BlueTanukiLauncher.sh");
    const envFile = path.join(configRoot, "blue-tanuki.env");
    const envBeforeRepair = parseEnvFile(envFile);
    run("sh", [
      setup,
      "--install-root",
      installRoot,
      "--data-root",
      dataRoot,
      "--config-root",
      configRoot,
      "--runtime-root",
      runtimeRoot,
      "--bin-root",
      binRoot,
      "--no-launch",
    ], packageDir, "installer repair install", 180_000, env);
    const installedEnv = parseEnvFile(envFile);
    assertEnvValuesRetained(envBeforeRepair, installedEnv, [
      "WEBCHAT_TOKEN",
      "WEBCHAT_RESUME_TOKEN",
      "BLUE_TANUKI_SETTINGS_TOKEN",
    ]);
    console.log("repair_install_result=pass");

    const autostartInitial = runExpectingStatus("sh", [launcher, "resident-autostart-status"], installRoot, 0, "launcher autostart status initial", 60_000, env);
    if (!autostartInitial.includes("autostart_status=disabled")) {
      throw new Error("autostart should be disabled before explicit owner opt-in");
    }
    try {
      const autostartEnabled = runExpectingStatus("sh", [launcher, "resident-autostart-enable"], installRoot, 0, "launcher autostart enable", 60_000, env);
      if (!autostartEnabled.includes("autostart_status=enabled")) {
        throw new Error("autostart enable output did not confirm enabled status");
      }
      const autostartStatus = runExpectingStatus("sh", [launcher, "resident-autostart-status"], installRoot, 0, "launcher autostart status enabled", 60_000, env);
      if (!autostartStatus.includes("autostart_status=enabled")) {
        throw new Error("autostart status did not observe user autostart entry");
      }
    } finally {
      runExpectingStatus("sh", [launcher, "resident-autostart-disable"], installRoot, 0, "launcher autostart disable", 60_000, env);
    }
    console.log("reboot_persistence_result=pass");

    const port = installedEnv.WEBCHAT_PORT ?? "8787";
    const portNumber = Number.parseInt(port, 10);
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      throw new Error(`WEBCHAT_PORT is invalid in installed env file: ${port}`);
    }
    const blocker = await holdLoopbackPort(portNumber);
    try {
      const conflictOutput = runExpectingStatus("sh", [launcher, "launch"], installRoot, 2, "launcher port conflict", 60_000, env);
      if (!conflictOutput.includes(`port_conflict=127.0.0.1:${port}`)) {
        throw new Error("launcher port conflict output did not include expected marker");
      }
      console.log("port_conflict_result=pass");
    } finally {
      await closeServer(blocker);
    }

    run("sh", [launcher, "launch"], installRoot, "launcher launch", 120_000, env);
    stopped = false;
    const healthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!healthReady) throw new Error("installed gateway healthz did not become ready");
    console.log("launch_result=pass");

    const guiResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/app`, undefined, FETCH_TIMEOUT_MS, "app GET");
    if (!guiResponse.ok) throw new Error(`/app failed: ${guiResponse.status} ${await guiResponse.text()}`);
    console.log("gui_result=pass");

    const token = installedEnv.WEBCHAT_TOKEN;
    if (!token) throw new Error("WEBCHAT_TOKEN missing from installed env file");
    const ticketResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/ws-ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user: "unix-smoke" }),
    }, FETCH_TIMEOUT_MS, "ws-ticket POST");
    if (!ticketResponse.ok) throw new Error(`ws-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
    const firstMessage = await receiveFirstMessage(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
      token,
      port,
    );
    if (!firstMessage.hello || !firstMessage.channelSend) {
      throw new Error(`first message smoke failed hello=${firstMessage.hello} channel_send=${firstMessage.channelSend}`);
    }
    console.log("first_message_result=pass");

    const resumeToken = installedEnv.WEBCHAT_RESUME_TOKEN;
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

    const nodeExe = findBundledNode(runtimeRoot);
    run(nodeExe, [
      "apps/gateway/dist/main.js",
      "--audit-verify",
      "--env-file",
      envFile,
    ], installRoot, "installed audit verify", 60_000, env);
    const auditDir = installedEnv.BLUE_TANUKI_AUDIT_DIR;
    if (!auditDir) throw new Error("BLUE_TANUKI_AUDIT_DIR missing from installed env file");
    const tamperEnvFile = writeTamperedAuditEnv(envFile, auditDir, work);
    const tamperOutput = runExpectingStatus(nodeExe, [
      "apps/gateway/dist/main.js",
      "--audit-verify",
      "--env-file",
      tamperEnvFile,
    ], installRoot, 1, "installed audit tamper verify", 60_000, env);
    if (!tamperOutput.includes("BROKEN") && !tamperOutput.includes("chain_valid: false") && !tamperOutput.includes("invalid_entry_shape")) {
      throw new Error("audit tamper verification did not report a broken chain");
    }
    console.log("audit_tamper_result=pass");

    const pidFile = path.join(dataRoot, "blue-tanuki.pid");
    const originalPid = readPidFile(pidFile);
    if (!originalPid) throw new Error("resident pid file was not written before crash recovery probe");
    process.kill(originalPid, "SIGKILL");
    const recoveredPid = await waitForPidChange(pidFile, originalPid, CRASH_RECOVERY_TIMEOUT_MS);
    if (!recoveredPid) throw new Error("resident watchdog did not write a recovered pid after simulated crash");
    const recoveredHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!recoveredHealthReady) throw new Error("installed gateway healthz did not recover after simulated resident crash");
    console.log("crash_recovery_result=pass");

    run("sh", [launcher, "status"], installRoot, "launcher status running", 60_000, env);
    run("sh", [launcher, "stop"], installRoot, "launcher stop", 60_000, env);
    stopped = true;
    const stoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!stoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher stop");
    console.log("stop_result=pass");

    runAllowing("sh", [launcher, "doctor"], installRoot, [0, 1], "launcher doctor", 120_000, env);
    console.log("doctor_result=pass");

    run("sh", [launcher, "restart"], installRoot, "launcher restart", 120_000, env);
    stopped = false;
    const restartHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!restartHealthReady) throw new Error("installed gateway healthz did not become ready after restart");
    console.log("restart_result=pass");
    run("sh", [launcher, "stop"], installRoot, "launcher final stop", 60_000, env);
    stopped = true;
    const finalStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!finalStoppedReady) throw new Error("installed gateway healthz stayed reachable after launcher final stop");

    run("sh", [launcher, "safe-mode"], installRoot, "launcher safe mode", 120_000, env);
    stopped = false;
    const safeModeHealthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS);
    if (!safeModeHealthReady) throw new Error("installed gateway healthz did not become ready in safe mode");
    console.log("safe_mode_result=pass");
    run("sh", [launcher, "stop"], installRoot, "launcher safe mode stop", 60_000, env);
    stopped = true;

    run("sh", [path.join(installRoot, "BlueTanukiUninstall.sh"), "--purge", "--quiet"], work, "installer uninstall", 120_000, env);
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("install root still exists after uninstall");
    if (!(await waitForAbsent(dataRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("data root still exists after purge uninstall");

    console.log(INSTALLED_SMOKE_MARKERS[platform]);
    console.log("installer_archive_setup_result=pass");
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
    console.log("uninstall_result=pass");
  } finally {
    const launcher = path.join(installRoot, "BlueTanukiLauncher.sh");
    if (!stopped && existsSync(launcher)) {
      try {
        runAllowing("sh", [launcher, "stop"], installRoot, [0, 1, 2], "cleanup launcher stop", 60_000, env);
      } catch (error) {
        console.error(`[unix-smoke] cleanup launcher stop failed: ${errorMessage(error)}`);
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
