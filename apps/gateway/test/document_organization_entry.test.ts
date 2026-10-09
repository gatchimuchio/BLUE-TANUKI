import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";

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

  it("BT-U-C08.02-P-E2E: resumes after a process kill from confirmed J spans and stops after completion", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-c0802-positive-"));
    const auditDir = join(tempRoot, "audit");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const restartSource = "C08_PRIVATE_RESTART_SOURCE:決定事項は青。未確認は期限。";
    const firstQuote = "C08_PRIVATE_RESTART_SOURCE:決定事項は青。";
    const secondQuote = "未確認は期限。";
    const providerOnePrompts: string[] = [];
    let providerOneCalls = 0;
    let signalSecondCall!: () => void;
    const secondCallSeen = new Promise<void>((resolve) => { signalSecondCall = resolve; });
    const providerOne = createServer((request, response) => {
      void readPrompt(request).then(async (prompt) => {
        providerOnePrompts.push(prompt);
        providerOneCalls += 1;
        if (providerOneCalls === 1) {
          respondWithExcerpt(response, restartSource, 0, firstQuote.length, "C08_PRIVATE_PROVIDER_LABEL");
          return;
        }
        signalSecondCall();
        await new Promise<void>((resolve) => {
          request.once("aborted", resolve);
          response.once("close", () => resolve());
        });
      });
    });
    const providerOnePort = await listenOnLoopback(providerOne);
    const runtimePort = await reserveLoopbackPort();
    const firstEnv = isolatedRuntimeEnvironment(providerOnePort, runtimePort, auditDir, historyFile, sessionDir);
    firstEnv.BLUE_TANUKI_MEMORY_FILE = memoryFile;
    seedPersistentMemory(memoryFile, "c0802-memory-seed-1");
    const memoryBeforeRestart = readFileSync(memoryFile, "utf8");
    const childOne = spawnCaptured([tsxCli, "apps/gateway/src/main.ts", "--organize", restartSource], firstEnv);

    try {
      await waitForSignal(secondCallSeen, childOne, "second synthetic C call was not reached");
      expect(providerOneCalls).toBe(2);
      expect(providerOnePrompts[1]).toContain(`"start":0,"end":${firstQuote.length}`);
      await forceStopChild(childOne.child);
      await closeServer(providerOne);

      const providerTwoPrompts: string[] = [];
      let providerTwoCalls = 0;
      const providerTwo = createServer((request, response) => {
        void readPrompt(request).then((prompt) => {
          providerTwoPrompts.push(prompt);
          providerTwoCalls += 1;
          respondWithExcerpt(response, restartSource, firstQuote.length, restartSource.length, "C08_PRIVATE_PROVIDER_LABEL_2");
        });
      });
      const providerTwoPort = await listenOnLoopback(providerTwo);
      const resumedEnv = isolatedRuntimeEnvironment(providerTwoPort, runtimePort, auditDir, historyFile, sessionDir);
      resumedEnv.BLUE_TANUKI_MEMORY_FILE = memoryFile;

      try {
        const resumed = await runChild([tsxCli, "apps/gateway/src/main.ts", "--organize", restartSource], resumedEnv);
        const resumedOutput = extractProjection(resumed.stdout.join(""));
        expect(resumedOutput).toContain("状態: completed");
        expect(resumedOutput).toContain("C08_PRIVATE_RESTART_SOURCE:決定事項は青。");
        expect(resumedOutput).toContain(secondQuote);
        expect(resumedOutput).toContain("再起動復旧済み範囲");
        expect(providerTwoCalls).toBe(1);
        expect(providerTwoPrompts[0]).toContain(`"start":0,"end":${firstQuote.length}`);

        const repeated = await runChild([tsxCli, "apps/gateway/src/main.ts", "--organize", restartSource], resumedEnv);
        expect(extractProjection(repeated.stdout.join(""))).toContain("状態: completed");
        expect(providerTwoCalls).toBe(1);
        expect(readFileSync(memoryFile, "utf8")).toBe(memoryBeforeRestart);

        const checkpointBytes = readFileSync(join(auditDir, "file-root", "document-organization", "j-checkpoints.sqlite"));
        expect(checkpointBytes.includes(Buffer.from("C08_PRIVATE_RESTART_SOURCE"))).toBe(false);
        expect(checkpointBytes.includes(Buffer.from("C08_PRIVATE_PROVIDER_LABEL"))).toBe(false);
        const durableText = [
          readFileSync(join(auditDir, "audit.jsonl"), "utf8"),
          existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "",
          existsSync(sessionDir) ? readdirSync(sessionDir).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n") : "",
        ].join("\n");
        expect(durableText).not.toContain("C08_PRIVATE_RESTART_SOURCE");
        expect(durableText).not.toContain("C08_PRIVATE_PROVIDER_LABEL");
      } finally {
        await closeServer(providerTwo);
      }
    } finally {
      await stopChild(childOne.child);
      if (providerOne.listening) await closeServer(providerOne);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("BT-U-C08.02-N-E2E: returns a valid hold without calling C when M changed across restart", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-c0802-negative-"));
    const auditDir = join(tempRoot, "audit");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const changedSource = "C08_PRIVATE_M_REVISION_SOURCE:目的を維持。未確認を残す。";
    const acceptedQuote = "C08_PRIVATE_M_REVISION_SOURCE:目的を維持。";
    let providerOneCalls = 0;
    let signalSecondCall!: () => void;
    const secondCallSeen = new Promise<void>((resolve) => { signalSecondCall = resolve; });
    const providerOne = createServer((request, response) => {
      void readPrompt(request).then(async () => {
        providerOneCalls += 1;
        if (providerOneCalls === 1) {
          respondWithExcerpt(response, changedSource, 0, acceptedQuote.length, "C08_PRIVATE_M_PROVIDER_LABEL");
          return;
        }
        signalSecondCall();
        await new Promise<void>((resolve) => {
          request.once("aborted", resolve);
          response.once("close", () => resolve());
        });
      });
    });
    const providerOnePort = await listenOnLoopback(providerOne);
    const runtimePort = await reserveLoopbackPort();
    const firstEnv = isolatedRuntimeEnvironment(providerOnePort, runtimePort, auditDir, historyFile, sessionDir);
    firstEnv.BLUE_TANUKI_MEMORY_FILE = memoryFile;
    seedPersistentMemory(memoryFile, "c0802-memory-seed-negative");
    const childOne = spawnCaptured([tsxCli, "apps/gateway/src/main.ts", "--organize", changedSource], firstEnv);

    try {
      await waitForSignal(secondCallSeen, childOne, "second synthetic C call was not reached");
      await forceStopChild(childOne.child);
      await closeServer(providerOne);

      seedPersistentMemory(memoryFile, "c0802-memory-revision-change");
      const providerTwoPrompts: string[] = [];
      let providerTwoCalls = 0;
      const providerTwo = createServer((request, response) => {
        void readPrompt(request).then((prompt) => {
          providerTwoPrompts.push(prompt);
          providerTwoCalls += 1;
          respondWithExcerpt(response, changedSource, acceptedQuote.length, changedSource.length, "C08_PRIVATE_UNEXPECTED_C_LABEL");
        });
      });
      const providerTwoPort = await listenOnLoopback(providerTwo);
      const resumedEnv = isolatedRuntimeEnvironment(providerTwoPort, runtimePort, auditDir, historyFile, sessionDir);
      resumedEnv.BLUE_TANUKI_MEMORY_FILE = memoryFile;

      try {
        const held = await runChild([tsxCli, "apps/gateway/src/main.ts", "--organize", changedSource], resumedEnv);
        const heldOutput = extractProjection(held.stdout.join(""));
        expect(heldOutput).toContain("状態: held");
        expect(heldOutput).toContain("memory_state_changed");
        expect(heldOutput).toContain("再起動復旧済み範囲");
        expect(providerTwoCalls).toBe(0);

        const repeated = await runChild([tsxCli, "apps/gateway/src/main.ts", "--organize", changedSource], resumedEnv);
        expect(extractProjection(repeated.stdout.join(""))).toContain("memory_state_changed");
        expect(providerTwoCalls).toBe(0);
        const checkpointBytes = readFileSync(join(auditDir, "file-root", "document-organization", "j-checkpoints.sqlite"));
        expect(checkpointBytes.includes(Buffer.from("C08_PRIVATE_M_REVISION_SOURCE"))).toBe(false);
        expect(checkpointBytes.includes(Buffer.from("C08_PRIVATE_M_PROVIDER_LABEL"))).toBe(false);
      } finally {
        await closeServer(providerTwo);
      }
    } finally {
      await stopChild(childOne.child);
      if (providerOne.listening) await closeServer(providerOne);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
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
    BLUE_TANUKI_FILE_ROOT: join(auditDir, "file-root"),
    BLUE_TANUKI_MEMORY_FILE: join(auditDir, "memory.jsonl"),
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

async function readPrompt(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
  return (body.messages ?? []).map((message) => typeof message.content === "string" ? message.content : "").join("\n");
}

function respondWithExcerpt(
  response: import("node:http").ServerResponse,
  sourceText: string,
  start: number,
  end: number,
  label: string,
): void {
  const quote = sourceText.slice(start, end);
  const candidateContent = JSON.stringify({
    schema_version: "blue-tanuki.document-organization.candidate.v1",
    sections: [{ label, excerpts: [{ start, end, quote }] }],
  });
  const content = JSON.stringify({
    schema_version: "blue-tanuki.memory-citation-response.v1",
    answer: candidateContent,
    citations: [],
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "c0802-local-completion",
    object: "chat.completion",
    created: 2,
    model: "c0802-local",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function seedPersistentMemory(filepath: string, requestId: string): void {
  const memory = new LongTermMemoryStore({ filepath });
  const hds = new HDSUpperController({ memory });
  hds.decide({
    id: requestId,
    channel: "cli",
    user: "c0802-test-owner",
    content: "please organize this ordinary request",
    timestamp: Date.now(),
  });
  if (memory.size() === 0 || !memory.verify()) throw new Error("synthetic M seed was not confirmed");
}

async function waitForSignal(signal: Promise<void>, processRun: CapturedProcess, message: string): Promise<void> {
  await Promise.race([
    signal,
    once(processRun.child, "close").then(() => { throw new Error(`${message}\n${processRun.stderr.join("")}`); }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(message)), 15_000)),
  ]);
}

async function forceStopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (!child.kill("SIGKILL")) throw new Error("test-owned Gateway child could not be terminated");
  await closed;
  children.delete(child);
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
