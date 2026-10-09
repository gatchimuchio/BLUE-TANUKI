import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const repositoryRoot = process.cwd();
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const source = "決定事項:青\n未確認:期限";
const firstExcerpt = "決定事項:青";
const secondExcerpt = "未確認:期限";
const token = "c0801-webchat-token";
const resumeToken = "c0801-webchat-resume-token";
const maintenanceToken = "c0801-maintenance-token";

interface CapturedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
});

describe("document organization ordinary entries", () => {
  it("BT-U-C08.01-P-E2E: uses the same bounded J projection through CLI and live WebChat routes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-c0801-"));
    const auditDir = join(tempRoot, "audit");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    let upstreamCallCount = 0;
    const upstreamPrompts: string[] = [];
    const upstream = createServer((request, response) => {
      const cycleIndex = upstreamCallCount++;
      void respondWithCandidate(request, response, cycleIndex, upstreamPrompts);
    });
    const upstreamPort = await listenOnLoopback(upstream);
    const gatewayPort = await reserveLoopbackPort();
    const runtimeEnv = isolatedRuntimeEnvironment(upstreamPort, gatewayPort, auditDir, historyFile, sessionDir);
    let gateway: CapturedProcess | undefined;
    let webSocket: WebSocket | undefined;

    try {
      const cli = await runChild(
        [tsxCli, "apps/gateway/src/main.ts", "--organize", source],
        runtimeEnv,
      );
      const cliOutput = extractProjection(cli.stdout.join(""));
      expect(cliOutput, JSON.stringify({ upstreamCallCount, upstreamPrompts })).toContain("状態: completed");
      expect(cliOutput).toContain("決定事項:青");
      expect(cliOutput).toContain("未確認:期限");
      expect(cliOutput).toContain("分類意味:未検証");
      expect(cliOutput).toContain("権限利用: false / 実行可能: false / 永続記憶反映: false");

      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);
      const wsTicketResponse = await fetch(`http://127.0.0.1:${gatewayPort}/ws-ticket`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ user: "c0801-owner" }),
      });
      expect(wsTicketResponse.status).toBe(200);
      const { ticket } = await wsTicketResponse.json() as { ticket: string };
      webSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticket)}`);
      await once(webSocket, "open");

      const received = waitForWebChatSend(webSocket);
      const inboundResponse = await fetch(`http://127.0.0.1:${gatewayPort}/inbound`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ user: "c0801-owner", content: `/organize\n${source}` }),
      });
      expect(inboundResponse.ok).toBe(true);
      const webchatOutput = await received;

      expect(webchatOutput).toContain("状態: completed");
      expect(webchatOutput).toContain("決定事項:青");
      expect(webchatOutput).toContain("未確認:期限");
      expect(webchatOutput).toContain("分類意味:未検証");
      expect(webchatOutput).toContain("権限利用: false / 実行可能: false / 永続記憶反映: false");
      expect(cliOutput).toBe(webchatOutput);
      expect(upstreamCallCount).toBe(4);
      expect(upstreamPrompts[1]).toContain(`"start":0,"end":${firstExcerpt.length}`);
      expect(upstreamPrompts[3]).toContain(`"start":0,"end":${firstExcerpt.length}`);
      const persistedAudit = readFileSync(join(auditDir, "audit.jsonl"), "utf8");
      const persistedHistory = readFileSync(historyFile, "utf8");
      const persistedSessions = existsSync(sessionDir)
        ? readdirSync(sessionDir).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n")
        : "";
      expect(persistedAudit).not.toContain(firstExcerpt);
      expect(persistedAudit).not.toContain(secondExcerpt);
      expect(persistedHistory).not.toContain(firstExcerpt);
      expect(persistedHistory).not.toContain(secondExcerpt);
      expect(persistedSessions).not.toContain(firstExcerpt);
      expect(persistedSessions).not.toContain(secondExcerpt);
    } finally {
      webSocket?.close();
      if (gateway) await stopChild(gateway.child);
      await closeServer(upstream);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

async function respondWithCandidate(request: IncomingMessage, response: import("node:http").ServerResponse, cycleIndex: number, prompts: string[]): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  let prompt = "";
  try {
    const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
    prompt = (body.messages ?? []).map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  } catch {
    response.writeHead(400).end();
    return;
  }
  prompts.push(prompt);

  const excerpt = cycleIndex % 2 === 1 ? secondExcerpt : firstExcerpt;
  const start = source.indexOf(excerpt);
  const candidateContent = JSON.stringify({
    schema_version: "blue-tanuki.document-organization.candidate.v1",
    sections: [{
      label: excerpt === firstExcerpt ? "決定事項" : "未確認事項",
      excerpts: [{ start, end: start + excerpt.length, quote: excerpt }],
    }],
  });
  const content = JSON.stringify({
    schema_version: "blue-tanuki.memory-citation-response.v1",
    answer: candidateContent,
    citations: [],
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "c0801-local-completion",
    object: "chat.completion",
    created: 1,
    model: "c0801-local",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function isolatedRuntimeEnvironment(upstreamPort: number, gatewayPort: number, auditDir: string, historyFile: string, sessionDir: string): NodeJS.ProcessEnv {
  const inheritedKeys = [
    "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(gatewayPort),
    WEBCHAT_TOKEN: token,
    WEBCHAT_RESUME_TOKEN: resumeToken,
    BLUE_TANUKI_MAINTENANCE_TOKEN: maintenanceToken,
    BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
    BLUE_TANUKI_SESSION_DIR: sessionDir,
    LLM_BACKEND: "c0801-local",
    LLM_PROVIDERS_JSON: JSON.stringify([{
      name: "c0801-local",
      type: "openai-compatible",
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "c0801-local",
      aliases: [],
      headers: {},
    }]),
    BLUE_TANUKI_LLM_BACKEND_HINT: "c0801-local",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    TELEGRAM_BOT_TOKEN: "",
    LINE_CHANNEL_ACCESS_TOKEN: "",
    LINE_CHANNEL_SECRET: "",
  };
}

async function listenOnLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind a TCP port");
  return address.port;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listenOnLoopback(server);
  await closeServer(server);
  return port;
}

function spawnGateway(env: NodeJS.ProcessEnv): CapturedProcess {
  return spawnCaptured([tsxCli, "apps/gateway/src/main.ts", "--serve"], env);
}

async function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<CapturedProcess> {
  const processRun = spawnCaptured(args, env);
  const [code] = await once(processRun.child, "close");
  if (code !== 0) {
    throw new Error(`local CLI exited ${String(code)}\nstdout:\n${processRun.stdout.join("")}\nstderr:\n${processRun.stderr.join("")}`);
  }
  return processRun;
}

function spawnCaptured(args: string[], env: NodeJS.ProcessEnv): CapturedProcess {
  const child = spawn(process.execPath, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("close", () => children.delete(child));
  return { child, stdout, stderr };
}

async function waitForHealth(port: number, gateway: CapturedProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) {
      throw new Error(`gateway exited ${gateway.child.exitCode}\n${gateway.stderr.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // The gateway has not opened its loopback listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gateway health timed out\n${gateway.stderr.join("")}`);
}

function waitForWebChatSend(webSocket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebChat organization result timed out")), 15_000);
    webSocket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || (message as { kind?: unknown }).kind !== "channel_send") return;
      clearTimeout(timeout);
      resolve((message as { content?: string }).content ?? "");
    });
    webSocket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "close").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  children.delete(child);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
}

function extractProjection(output: string): string {
  const start = output.indexOf("資料整理結果\n");
  if (start < 0) throw new Error(`CLI did not print a canonical projection:\n${output}`);
  const terminal = "権限利用: false / 実行可能: false / 永続記憶反映: false";
  const end = output.indexOf(terminal, start);
  if (end < 0) throw new Error(`CLI projection had no non-authority footer:\n${output}`);
  return output.slice(start, end + terminal.length);
}
