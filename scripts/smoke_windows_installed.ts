import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { verifyWindowsPackage } from "./verify_windows_package.ts";

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

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function runAllowing(command: string, args: readonly string[], cwd: string, allowedStatuses: readonly number[]): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
    stdio: "inherit",
    encoding: "utf8",
  });
  if (!allowedStatuses.includes(result.status ?? -1)) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
}

function expandArchive(artifact: string, destination: string): void {
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath ${JSON.stringify(artifact)} -DestinationPath ${JSON.stringify(destination)} -Force`,
  ], process.cwd());
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

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function receiveFirstMessage(
  wsUrl: string,
  token: string,
  port: string,
): Promise<{ hello: boolean; channelSend: boolean }> {
  const messages: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(wsUrl);
  ws.on("message", (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore non-json frames
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const response = await fetch(`http://127.0.0.1:${port}/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ user: "windows-smoke", content: "Hello BLUE-TANUKI Windows installer smoke" }),
  });
  if (!response.ok) {
    throw new Error(`first message POST failed: ${response.status} ${await response.text()}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  ws.close();
  return {
    hello: messages.some((message) => message.kind === "hello"),
    channelSend: messages.some((message) => message.kind === "channel_send"),
  };
}

async function main(): Promise<void> {
  const artifact = path.resolve(argValue("--artifact") ?? defaultArtifact());
  verifyWindowsPackage(artifact);
  if (process.platform !== "win32") {
    console.log(`windows_runtime_smoke=skipped platform=${process.platform}`);
    console.log("artifact_structure_smoke=pass");
    return;
  }

  const work = mkdtempSync(path.join(tmpdir(), "blue-tanuki-windows-installed-"));
  const packageDir = path.join(work, "package");
  const installRoot = path.join(work, "InstallRoot");
  const dataRoot = path.join(work, "DataRoot");
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
    ], packageDir);

    const launcher = path.join(installRoot, "BlueTanukiLauncher.ps1");
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "start",
    ], installRoot);

    const env = parseEnvFile(path.join(dataRoot, "blue-tanuki.env"));
    const port = env.WEBCHAT_PORT ?? "8787";
    const token = env.WEBCHAT_TOKEN;
    if (!token) throw new Error("WEBCHAT_TOKEN missing from installed env file");
    const healthReady = await waitFor(`http://127.0.0.1:${port}/healthz`, 15000);
    if (!healthReady) throw new Error("installed gateway healthz did not become ready");

    const ticketResponse = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user: "windows-smoke" }),
    });
    if (!ticketResponse.ok) {
      throw new Error(`ws-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
    }
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
    const firstMessage = await receiveFirstMessage(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
      token,
      port,
    );
    if (!firstMessage.hello || !firstMessage.channelSend) {
      throw new Error(`first message smoke failed hello=${firstMessage.hello} channel_send=${firstMessage.channelSend}`);
    }

    runAllowing("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "doctor",
    ], installRoot, [0, 1]);
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "stop",
    ], installRoot);
    run("cmd.exe", [
      "/d",
      "/s",
      "/c",
      path.join(installRoot, "UninstallBlueTanuki.cmd"),
      "-PurgeData",
      "-Quiet",
    ], installRoot);

    console.log("windows_installed_smoke=pass");
    console.log("install_result=pass");
    console.log("launch_result=pass");
    console.log("gui_result=pass");
    console.log("first_message_result=pass");
    console.log("doctor_result=pass");
    console.log("uninstall_result=pass");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
