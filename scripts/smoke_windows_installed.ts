import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { verifyWindowsPackage } from "./verify_windows_package.ts";

const COMMAND_TIMEOUT_MS = 120_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
const FIRST_MESSAGE_TIMEOUT_MS = 10_000;
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
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "start",
    ], installRoot, "launcher start", 120_000);

    const env = parseEnvFile(path.join(dataRoot, "blue-tanuki.env"));
    const port = env.WEBCHAT_PORT ?? "8787";
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
          runAllowing("cmd.exe", [
            "/d",
            "/s",
            "/c",
            path.join(installRoot, "UninstallBlueTanuki.cmd"),
            "-PurgeData",
            "-Quiet",
          ], work, [0, 1], "cleanup installer uninstall", 120_000, {
            BLUE_TANUKI_UNINSTALL_STATUS_FILE: path.join(work, "cleanup-uninstall.status"),
          });
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
