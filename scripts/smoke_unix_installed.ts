import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
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
const INSTALLER_TRANSACTION_TIMEOUT_MS = 600_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 5_000;
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

const INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "USERNAME",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
];

function childEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extraEnv };
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
    env: childEnv(extraEnv),
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
    env: childEnv(extraEnv),
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
    env: childEnv(extraEnv),
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

function runExpectingFailure(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  extraEnv: Record<string, string> = {},
): string {
  logStep(`start ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    env: childEnv(extraEnv),
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const output = commandLog(result);
  if (output.trim()) process.stdout.write(output);
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded`);
  logStep(`done ${label} status=${result.status} signal=${result.signal ?? "none"}`);
  return output;
}

async function interruptInstallerAfterAppMove(
  args: readonly string[],
  cwd: string,
  extraEnv: Record<string, string>,
  markerFile: string,
  timeoutMs: number,
): Promise<void> {
  const child = spawn("sh", [...args], {
    cwd,
    env: childEnv(extraEnv),
    stdio: "ignore",
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
    if (spawnError) throw new Error(`interrupted update process could not start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = await exited;
      throw new Error(`interrupted update exited before the transaction point: code=${result.code} signal=${result.signal}`);
    }
    await sleep(50);
  }
  if (!existsSync(markerFile)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw new Error("interrupted update did not reach the controlled app-move point");
  }

  const wrapperPid = Number(readFileSync(markerFile, "utf8").trim());
  if (!Number.isInteger(wrapperPid) || wrapperPid <= 0 || child.pid === undefined) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw new Error("interrupted update process identity could not be verified");
  }
  child.kill("SIGKILL");
  const result = await exited;
  try {
    process.kill(wrapperPid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  if (result.signal !== "SIGKILL") {
    throw new Error(`interrupted update shell was not terminated as requested: ${result.signal ?? result.code}`);
  }
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

function listDirectoryTreeForSmoke(root: string, limit = 80): string[] {
  const result: string[] = [];
  const pending = [{ directory: root, relative: "" }];
  while (pending.length > 0 && result.length < limit) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      const relative = path.join(current.relative, entry.name);
      result.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push({ directory: path.join(current.directory, entry.name), relative });
      }
      if (result.length >= limit) break;
    }
  }
  if (pending.length > 0) result.push("…");
  return result.sort();
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
  try {
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
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.terminate();
          resolve();
        }, WEBSOCKET_CLOSE_TIMEOUT_MS);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        ws.close();
      });
    }
  }
  logStep("done websocket first-message probe");
  return {
    hello: messages.some((message) => message.kind === "hello"),
    channelSend: messages.some((message) => message.kind === "channel_send"),
  };
}

async function main(): Promise<void> {
  const platform = targetPlatform();
  const arch = targetArch(platform);
  const installerTransactionTimeoutMs = platform === "macos" && arch === "x64"
    ? 900_000
    : INSTALLER_TRANSACTION_TIMEOUT_MS;
  const systemMoveCommand = platform === "macos" ? "/bin/mv" : "/usr/bin/mv";
  const artifact = path.resolve(argValue("--artifact") ?? defaultArtifact(platform, arch));
  logStep("verify installer package");
  verifyUnixPackage(artifact, platform, arch);
  logStep("done verify installer package");
  if (process.platform === "win32" || currentPlatform() !== platform || (platform === "macos" && currentArch() !== arch)) {
    console.log(`${platform}_runtime_smoke=skipped platform=${process.platform} arch=${process.arch}`);
    console.log("artifact_structure_smoke=pass");
    return;
  }

  const work = realpathSync(mkdtempSync(path.join(tmpdir(), `blue-tanuki-${platform}-installed-`)));
  const packageDir = path.join(work, "package");
  const homeDir = path.join(work, "home");
  const installRoot = path.join(work, "InstallRoot");
  const dataRoot = path.join(work, "DataRoot");
  const configRoot = path.join(work, "ConfigRoot");
  const runtimeRoot = path.join(work, "RuntimeRoot");
  const binRoot = path.join(work, "BinRoot");
  const productLogPaths = [
    path.join(dataRoot, "logs", "blue-tanuki.out.log"),
    path.join(dataRoot, "logs", "blue-tanuki.err.log"),
  ];
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
      "--skip-doctor",
    ], packageDir, "installer setup", installerTransactionTimeoutMs, env);
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
      "--force",
      "--no-launch",
      "--skip-doctor",
    ], packageDir, "installer repair install", installerTransactionTimeoutMs, env);
    const installedEnv = parseEnvFile(envFile);
    const expectedStateRoot = realpathSync(path.join(dataRoot, "data"));
    if (installedEnv.BLUE_TANUKI_STATE_ROOT !== expectedStateRoot) {
      throw new Error("installed environment state root does not match retained data root");
    }
    assertEnvValuesRetained(envBeforeRepair, installedEnv, [
      "WEBCHAT_TOKEN",
      "WEBCHAT_RESUME_TOKEN",
      "BLUE_TANUKI_MAINTENANCE_TOKEN",
      "BLUE_TANUKI_SETTINGS_TOKEN",
    ]);
    console.log("repair_install_result=pass");

    const autostartInitial = runExpectingStatus("sh", [launcher, "resident-autostart-status"], installRoot, 0, "launcher autostart status initial", 60_000, env);
    if (!autostartInitial.includes("autostart_status=disabled")) {
      throw new Error("autostart should be disabled before explicit owner opt-in");
    }
    const autostartEnabled = runExpectingStatus("sh", [launcher, "resident-autostart-enable"], installRoot, 0, "launcher autostart enable", 60_000, env);
    if (!autostartEnabled.includes("autostart_status=enabled")) {
      throw new Error("autostart enable output did not confirm enabled status");
    }
    const autostartStatus = runExpectingStatus("sh", [launcher, "resident-autostart-status"], installRoot, 0, "launcher autostart status enabled", 60_000, env);
    if (!autostartStatus.includes("autostart_status=enabled")) {
      throw new Error("autostart status did not observe user autostart entry");
    }

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
    for (const logPath of productLogPaths) {
      if (!existsSync(logPath) || !statSync(logPath).isFile()) {
        throw new Error("installed resident did not create its isolated stdout and stderr logs");
      }
    }
    const logsCommand = spawnSync("sh", [launcher, "logs"], {
      cwd: installRoot,
      env: childEnv(env),
      stdio: "pipe",
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (logsCommand.error || logsCommand.status !== 0) {
      throw new Error(`installed logs command failed with exit ${logsCommand.status ?? "null"}`);
    }
    const logsProjection = commandLog(logsCommand);
    if (!logsProjection.includes(`stdout=${productLogPaths[0]}`) ||
        !logsProjection.includes(`stderr=${productLogPaths[1]}`)) {
      throw new Error("installed logs command did not identify the isolated stdout and stderr log paths");
    }
    const logContents = productLogPaths.map((logPath) => readFileSync(logPath, "utf8"));
    const syntheticSecrets = Object.entries(installedEnv)
      .filter(([key, value]) => value.length > 0 && /TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY/i.test(key))
      .map(([, value]) => value);
    if (syntheticSecrets.some((secret) => logsProjection.includes(secret) || logContents.some((content) => content.includes(secret)))) {
      throw new Error("installed log projection or files exposed an isolated credential value");
    }
    console.log("installed_logs_result=pass");
    const installerMetadata = readFileSync(path.join(installRoot, "blue-tanuki-install.env"), "utf8");
    if (!installerMetadata.split(/\r?\n/u).includes(`STATE_ROOT='${expectedStateRoot}'`)) {
      throw new Error("launcher metadata state root does not match retained data root");
    }
    if (platform === "linux") {
      const gatewayPid = readPidFile(path.join(dataRoot, "blue-tanuki.pid"));
      if (!gatewayPid) throw new Error("installed Gateway PID is unavailable for state-root environment check");
      const processEnvironment = readFileSync(`/proc/${gatewayPid}/environ`, "utf8").split("\0");
      if (!processEnvironment.includes(`BLUE_TANUKI_STATE_ROOT=${expectedStateRoot}`)) {
        throw new Error("installed Gateway process did not inherit the retained data state root");
      }
    }
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

    const runtimeOwnerState = path.join(
      dataRoot,
      "data",
      "private-state",
      "gateway-runtime",
      "owner-state.sqlite",
    );
    if (!existsSync(runtimeOwnerState)) {
      throw new Error("installed runtime owner state was not created under the retained data root");
    }
    const leakedStateRoot = path.join(installRoot, ".blue-tanuki");
    if (existsSync(leakedStateRoot)) {
      const leakedEntries = listDirectoryTreeForSmoke(leakedStateRoot);
      throw new Error(`installed runtime state leaked into the managed install root: ${leakedEntries.join(",")}`);
    }

    const residentPidFile = path.join(dataRoot, "blue-tanuki.pid");
    const pidBeforeUpdate = readPidFile(residentPidFile);
    if (!pidBeforeUpdate) throw new Error("resident PID was unavailable before installed update lifecycle checks");
    run("sh", [launcher, "stop"], installRoot, "launcher stop before update lifecycle checks", 60_000, env);
    stopped = true;
    if (!(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
      throw new Error("installed gateway healthz stayed reachable before update lifecycle checks");
    }

    const updateRetentionFile = path.join(dataRoot, "data", "g04-03-update-retention-sentinel.txt");
    const updateRetentionValue = "G04.03 isolated state survives update failure and recovery\n";
    writeFileSync(updateRetentionFile, updateRetentionValue, "utf8");
    const ownerStateBeforeUpdate = Buffer.from(readFileSync(runtimeOwnerState));
    const envBeforeUpdate = Buffer.from(readFileSync(envFile));
    const installInventoryBeforeUpdate = Buffer.from(readFileSync(path.join(installRoot, "blue-tanuki-managed-files.txt")));
    const runtimeInventoryBeforeUpdate = Buffer.from(readFileSync(path.join(runtimeRoot, "blue-tanuki-runtime-files.txt")));

    {
      const updatePackageParent = path.join(work, "update-package");
      const updatePackageDir = path.join(updatePackageParent, path.basename(packageDir));
      const updateToolDir = path.join(work, "update-test-tools");
      run("mkdir", ["-p", updatePackageParent, updateToolDir], work, "create isolated update test package", 10_000, env);
      run("cp", ["-R", packageDir, updatePackageParent], work, "copy isolated update test package", 60_000, env);
      if (!existsSync(path.join(updatePackageDir, "app")) || !existsSync(path.join(updatePackageDir, "BlueTanukiSetup.sh"))) {
        throw new Error("isolated update package copy is missing the app or setup entrypoint");
      }
      const updateMarkerInPackage = path.join(updatePackageDir, "app", "g04-03-update-marker.txt");
      writeFileSync(updateMarkerInPackage, "G04.03 isolated package update marker\n", "utf8");
      const updateSetup = path.join(updatePackageDir, "BlueTanukiSetup.sh");
      const updateSetupArgs = [
        updateSetup,
        "--install-root", installRoot,
        "--data-root", dataRoot,
        "--config-root", configRoot,
        "--runtime-root", runtimeRoot,
        "--bin-root", binRoot,
        "--force",
        "--no-launch",
        "--skip-doctor",
      ];
      const testPath = `${updateToolDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
      const moveFailureMarker = path.join(work, "update-runtime-move-failure-triggered");
      const moveFailureShim = [
        "#!/bin/sh",
        'if [ "$#" -eq 3 ] && [ "$1" = "--" ] && [ "$2" = "$BT_TEST_RUNTIME_ROOT" ] && [ ! -e "$BT_TEST_FAILURE_MARKER" ]; then',
        '  case "$3" in "$BT_TEST_RUNTIME_ROLLBACK_PREFIX"*)',
        '    : > "$BT_TEST_FAILURE_MARKER"',
        '    echo "blue-tanuki injected runtime move failure" >&2',
        "    exit 73",
        "    ;;",
        "  esac",
        "fi",
        `exec ${systemMoveCommand} \"$@\"`,
        "",
      ].join("\n");
      writeFileSync(path.join(updateToolDir, "mv"), moveFailureShim, "utf8");
      run("chmod", ["+x", path.join(updateToolDir, "mv")], work, "enable isolated update failure shim", 10_000, env);
      const failedUpdateOutput = runExpectingFailure("sh", updateSetupArgs, updatePackageDir, "installed update transaction failure rollback", installerTransactionTimeoutMs, {
        ...env,
        PATH: testPath,
        BT_TEST_RUNTIME_ROOT: runtimeRoot,
        BT_TEST_RUNTIME_ROLLBACK_PREFIX: path.join(work, ".RuntimeRoot.blue-tanuki-rollback-"),
        BT_TEST_FAILURE_MARKER: moveFailureMarker,
      });
      if (!existsSync(moveFailureMarker) || !failedUpdateOutput.includes("blue-tanuki injected runtime move failure")) {
        throw new Error("installed update did not hit the isolated runtime-move failure point");
      }
      if (!existsSync(installRoot) || !existsSync(runtimeRoot) || existsSync(path.join(installRoot, "g04-03-update-marker.txt"))) {
        throw new Error("failed update did not restore the previous app and runtime pair");
      }
      if (!readFileSync(path.join(installRoot, "blue-tanuki-managed-files.txt")).equals(installInventoryBeforeUpdate) ||
          !readFileSync(path.join(runtimeRoot, "blue-tanuki-runtime-files.txt")).equals(runtimeInventoryBeforeUpdate)) {
        throw new Error("failed update changed the previous managed app or runtime inventory");
      }
      if (!existsSync(runtimeOwnerState) || !readFileSync(runtimeOwnerState).equals(ownerStateBeforeUpdate) ||
          !readFileSync(envFile).equals(envBeforeUpdate) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue) {
        throw new Error("failed update changed retained owner state, config, or user data");
      }
      if (!(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
        throw new Error("resident process remained after failed update rollback");
      }
      console.log("update_failure_rollback_result=pass");

      const interruptedMoveMarker = path.join(work, "interrupted-update-app-move.pid");
      const interruptedMoveShim = [
        "#!/bin/sh",
        'if [ "$#" -eq 3 ] && [ "$1" = "--" ] && [ "$2" = "$BT_TEST_INSTALL_ROOT" ]; then',
        '  case "$3" in "$BT_TEST_INSTALL_ROLLBACK_PREFIX"*)',
        `    ${systemMoveCommand} "$@" || exit $?`,
        '    printf "%s\\n" "$$" > "$BT_TEST_HOLD_PID_FILE"',
        "    while :; do :; done",
        "    ;;",
        "  esac",
        "fi",
        `exec ${systemMoveCommand} \"$@\"`,
        "",
      ].join("\n");
      writeFileSync(path.join(updateToolDir, "mv"), interruptedMoveShim, "utf8");
      run("chmod", ["+x", path.join(updateToolDir, "mv")], work, "enable isolated interrupted-update shim", 10_000, env);
      await interruptInstallerAfterAppMove(updateSetupArgs, updatePackageDir, {
        ...env,
        PATH: testPath,
        BT_TEST_INSTALL_ROOT: installRoot,
        BT_TEST_INSTALL_ROLLBACK_PREFIX: path.join(work, ".InstallRoot.blue-tanuki-rollback-"),
        BT_TEST_HOLD_PID_FILE: interruptedMoveMarker,
      }, interruptedMoveMarker, installerTransactionTimeoutMs);

      const rollbackPrefix = `.${path.basename(installRoot)}.blue-tanuki-rollback-`;
      const rollbackCandidates = readdirSync(path.dirname(installRoot)).filter((name) => name.startsWith(rollbackPrefix));
      if (rollbackCandidates.length !== 1 || existsSync(installRoot) || !existsSync(runtimeRoot)) {
        throw new Error("interrupted update did not leave the exact expected old-app rollback and active-runtime state");
      }
      if (!(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
        throw new Error("resident process remained after interrupted update terminated");
      }
      const recoveryOutput = runExpectingStatus("sh", updateSetupArgs, updatePackageDir, 0, "installed interrupted-update recovery and resumed update", installerTransactionTimeoutMs, env);
      if (!recoveryOutput.includes("restored the verified previous product after an interrupted update") ||
          !existsSync(path.join(installRoot, "g04-03-update-marker.txt"))) {
        throw new Error("installer did not restore the prior app and then complete the isolated update");
      }
      if (!existsSync(runtimeOwnerState) || !readFileSync(runtimeOwnerState).equals(ownerStateBeforeUpdate) ||
          !readFileSync(envFile).equals(envBeforeUpdate) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue) {
        throw new Error("interrupted-update recovery changed retained owner state, config, or user data");
      }
      if (!(await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000))) {
        throw new Error("resident process remained after interrupted-update recovery");
      }
      console.log("interrupted_update_recovery_result=pass");
      const installInventoryAfterRecovery = Buffer.from(readFileSync(path.join(installRoot, "blue-tanuki-managed-files.txt")));
      const runtimeInventoryAfterRecovery = Buffer.from(readFileSync(path.join(runtimeRoot, "blue-tanuki-runtime-files.txt")));

      if (platform === "macos") {
        if (typeof process.getuid !== "function" || process.getuid() === 0) {
          throw new Error("macOS permission-denial smoke requires a non-root runner account");
        }
        const permissionCaseRoot = path.join(work, "permission-denial");
        const permissionInstallParent = path.join(permissionCaseRoot, "readonly-install-parent");
        const permissionHome = path.join(permissionCaseRoot, "home");
        const permissionHomeApplications = path.join(permissionHome, "Applications");
        const permissionEnv = {
          ...env,
          HOME: permissionHome,
          XDG_CONFIG_HOME: path.join(permissionHome, ".config"),
          XDG_DATA_HOME: path.join(permissionHome, ".local", "share"),
        };
        run("mkdir", ["-p", permissionInstallParent, permissionHomeApplications], work, "create isolated permission-denial parent", 10_000, env);
        const permissionInstallRoot = path.join(permissionInstallParent, "InstallRoot");
        const permissionMode = statSync(permissionInstallParent).mode & 0o777;
        if ((permissionMode & 0o200) === 0) {
          throw new Error("isolated permission-denial parent was not writable before the test");
        }
        let permissionDeniedOutput = "";
        chmodSync(permissionInstallParent, permissionMode & ~0o222);
        try {
          permissionDeniedOutput = runExpectingFailure("sh", [
            updateSetup,
            "--install-root", permissionInstallRoot,
            "--data-root", path.join(permissionCaseRoot, "DataRoot"),
            "--config-root", path.join(permissionCaseRoot, "ConfigRoot"),
            "--runtime-root", path.join(permissionCaseRoot, "RuntimeRoot"),
            "--bin-root", path.join(permissionCaseRoot, "BinRoot"),
            "--no-launch",
            "--skip-doctor",
          ], updatePackageDir, "macOS packaged setup permission denial", installerTransactionTimeoutMs, permissionEnv);
        } finally {
          chmodSync(permissionInstallParent, permissionMode);
        }
        if (!/permission denied|operation not permitted/i.test(permissionDeniedOutput)) {
          throw new Error("macOS packaged setup did not report the expected permission denial");
        }
        if (existsSync(permissionInstallRoot) || readdirSync(permissionInstallParent).length !== 0) {
          throw new Error("permission-denied setup created an install or staging path");
        }
        if (!existsSync(installRoot) || !existsSync(runtimeRoot) ||
            !readFileSync(path.join(installRoot, "blue-tanuki-managed-files.txt")).equals(installInventoryAfterRecovery) ||
            !readFileSync(path.join(runtimeRoot, "blue-tanuki-runtime-files.txt")).equals(runtimeInventoryAfterRecovery) ||
            !existsSync(runtimeOwnerState) || !readFileSync(runtimeOwnerState).equals(ownerStateBeforeUpdate) ||
            !readFileSync(envFile).equals(envBeforeUpdate) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue) {
          throw new Error("permission-denied setup changed the existing isolated installation or retained state");
        }
        console.log("permission_denied_update_result=pass");
      }
    }

    const autostartEntry = platform === "linux"
      ? path.join(env.XDG_CONFIG_HOME!, "autostart", "blue-tanuki.desktop")
      : path.join(homeDir, "Library", "LaunchAgents", "com.blue-tanuki.gateway.plist");
    const autostartText = readFileSync(autostartEntry, "utf8");
    stopped = false;
    if (platform === "linux") {
      const execLine = autostartText.split(/\r?\n/u).find((line) => line.startsWith("Exec="));
      const execCommand = execLine?.slice("Exec=".length);
      if (execCommand !== `${launcher} resident-start`) {
        throw new Error("managed Linux autostart Exec does not target the installed resident launcher");
      }
      run(launcher, ["resident-start"], installRoot, "execute managed Linux autostart target after clean stop", 60_000, env);
    } else {
      if (!autostartText.includes(`<string>${launcher}</string>`) || !autostartText.includes("<string>resident-start</string>")) {
        throw new Error("managed macOS LaunchAgent does not target the installed resident launcher");
      }
      run(launcher, ["resident-start"], installRoot, "execute managed macOS autostart target after clean stop", 60_000, env);
    }
    const autostartPid = await waitForPidChange(residentPidFile, pidBeforeUpdate, GATEWAY_READY_TIMEOUT_MS);
    if (!autostartPid || !(await waitFor(`http://127.0.0.1:${port}/healthz`, GATEWAY_READY_TIMEOUT_MS))) {
      throw new Error("managed autostart command did not start a fresh healthy resident after update recovery");
    }
    if (!existsSync(runtimeOwnerState) || !readFileSync(envFile).equals(envBeforeUpdate) || readFileSync(updateRetentionFile, "utf8") !== updateRetentionValue) {
      throw new Error("autostart command restart did not preserve installed owner state, config, and user data");
    }
    runExpectingStatus("sh", [launcher, "resident-autostart-disable"], installRoot, 0, "launcher autostart disable", 60_000, env);
    const autostartDisabled = runExpectingStatus("sh", [launcher, "resident-autostart-status"], installRoot, 0, "launcher autostart status disabled", 60_000, env);
    if (!autostartDisabled.includes("autostart_status=disabled")) {
      throw new Error("autostart disable did not remove the isolated managed entry");
    }
    console.log("autostart_exec_restart_result=pass");

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

    const safeModeStoppedReady = await waitForStopped(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!safeModeStoppedReady) throw new Error("installed gateway healthz stayed reachable after safe mode stop");

    const retainedUserFile = path.join(dataRoot, "data", "g04-03-retention-sentinel.txt");
    const retainedUserData = "G04.03 isolated user data survives normal uninstall\n";
    run("mkdir", ["-p", path.dirname(retainedUserFile)], work, "create isolated retained data", 10_000, env);
    writeFileSync(retainedUserFile, retainedUserData, "utf8");
    const envBeforeUninstall = parseEnvFile(envFile);
    const productLogsBeforeUninstall = productLogPaths.map((logPath) => Buffer.from(readFileSync(logPath)));
    const uninstaller = path.join(installRoot, "BlueTanukiUninstall.sh");
    run("sh", [uninstaller, "--quiet"], work, "installer normal uninstall", installerTransactionTimeoutMs, env);
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("install root still exists after normal uninstall");
    if (!(await waitForAbsent(runtimeRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("runtime root still exists after normal uninstall");
    if (!(await waitForAbsent(path.join(binRoot, "blue-tanuki"), UNINSTALL_TIMEOUT_MS))) {
      throw new Error("managed launcher still exists after normal uninstall");
    }
    if (readFileSync(retainedUserFile, "utf8") !== retainedUserData) {
      throw new Error("normal uninstall changed or removed isolated user data");
    }
    if (!existsSync(runtimeOwnerState)) {
      throw new Error("normal uninstall changed or removed runtime owner state under the retained data root");
    }
    if (productLogPaths.some((logPath, index) => !existsSync(logPath) || !readFileSync(logPath).equals(productLogsBeforeUninstall[index]))) {
      throw new Error("normal uninstall changed or removed isolated resident logs");
    }
    if (JSON.stringify(parseEnvFile(envFile)) !== JSON.stringify(envBeforeUninstall)) {
      throw new Error("normal uninstall changed or removed the isolated env file");
    }
    console.log("normal_uninstall_retention_result=pass");

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
      "--skip-doctor",
    ], packageDir, "installer reinstall after retained uninstall", installerTransactionTimeoutMs, env);
    if (readFileSync(retainedUserFile, "utf8") !== retainedUserData) {
      throw new Error("reinstall after normal uninstall changed or removed isolated user data");
    }
    assertEnvValuesRetained(envBeforeUninstall, parseEnvFile(envFile), [
      "WEBCHAT_TOKEN",
      "WEBCHAT_RESUME_TOKEN",
      "BLUE_TANUKI_MAINTENANCE_TOKEN",
      "BLUE_TANUKI_SETTINGS_TOKEN",
    ]);
    console.log("reinstall_after_retention_result=pass");

    run("sh", [path.join(installRoot, "BlueTanukiUninstall.sh"), "--purge", "--quiet"], work, "installer purge uninstall", installerTransactionTimeoutMs, env);
    if (!(await waitForAbsent(installRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("install root still exists after uninstall");
    if (!(await waitForAbsent(runtimeRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("runtime root still exists after purge uninstall");
    if (!(await waitForAbsent(dataRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("data root still exists after purge uninstall");
    if (!(await waitForAbsent(configRoot, UNINSTALL_TIMEOUT_MS))) throw new Error("config root still exists after purge uninstall");
    if (productLogPaths.some((logPath) => existsSync(logPath))) throw new Error("purge uninstall retained isolated resident logs");

    console.log(INSTALLED_SMOKE_MARKERS[platform]);
    console.log("installer_archive_setup_result=pass");
    console.log("install_result=pass");
    console.log("launch_result=pass");
    console.log("gui_result=pass");
    console.log("first_message_result=pass");
    console.log("repair_install_result=pass");
    console.log("port_conflict_result=pass");
    console.log("approval_flow_result=pass");
    console.log("audit_tamper_result=pass");
    console.log("crash_recovery_result=pass");
    console.log("safe_mode_result=pass");
    console.log("runtime_state_root_result=pass");
    console.log("normal_uninstall_retention_result=pass");
    console.log("purge_removed_logs_result=pass");
    console.log("reinstall_after_retention_result=pass");
    console.log("uninstall_result=pass");
    if (platform === "macos") {
      console.log("macos_host_reboot=NOT_RUN");
      console.log("macos_owner_device_qa=NOT_RUN");
    }
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
