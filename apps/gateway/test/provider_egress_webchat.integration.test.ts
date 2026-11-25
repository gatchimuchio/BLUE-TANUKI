import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gatewayEntry = resolve(repositoryRoot, "apps/gateway/dist/main.js");
const webchatToken = "test-webchat-token";
const ownerToken = "test-owner-token";
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all([...children].map(stopGateway));
});

describe("Gateway WebChat one-shot OpenAI egress", () => {
  it("denies egress and reports not-sent when the protected credential route is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-tanuki-provider-egress-"));
    const auditDir = join(root, "audit");
    const historyPath = join(root, "complete-history.jsonl");
    const sessionDir = join(root, "sessions");
    const port = await reservePort();
    const env = isolatedEnvironment(port, auditDir, historyPath, sessionDir);
    const gateway = spawnGateway(env);
    const sockets: WebSocket[] = [];

    try {
      await waitForHealth(port, gateway);
      const ticketResponse = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${webchatToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "one-shot-owner" }),
      });
      expect(ticketResponse.status).toBe(200);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
      sockets.push(socket);
      await once(socket, "open");

      let expectedRequestId: string | undefined;
      const sendPromise = waitForChannelSend(socket, () => expectedRequestId);
      const inboundResponse = await fetch(`http://127.0.0.1:${port}/owner/inbound`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          user: "one-shot-owner",
          content: "決定事項:青／未確認:期限",
          provider_egress: "openai_text_once",
        }),
      });
      expect(inboundResponse.status).toBe(202);
      expect(inboundResponse.headers.get("cache-control")).toContain("no-store");
      const accepted = await inboundResponse.json() as { request_id: string };
      expectedRequestId = accepted.request_id;

      const reply = await sendPromise;
      expect(reply).toContain("OpenAIへは送信されませんでした");
      const history = readFileSync(historyPath, "utf8").split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          kind?: string;
          request_id?: string;
          source?: string;
          payload?: Record<string, unknown>;
        });
      expect(history.find((record) => record.kind === "audit_history" &&
        record.request_id === accepted.request_id && record.source === "one_shot_openai_text_egress"))
        .toMatchObject({
          payload: {
            status: "not_sent",
            reason: "configured_route_unavailable",
            external_call_performed: false,
            used_for_authority: false,
          },
        });
    } finally {
      for (const socket of sockets) socket.close();
      await stopGateway(gateway);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function isolatedEnvironment(port: number, auditDir: string, historyPath: string, sessionDir: string): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(port),
    WEBCHAT_TOKEN: webchatToken,
    WEBCHAT_RESUME_TOKEN: "test-webchat-resume-token",
    BLUE_TANUKI_OWNER_TOKEN: ownerToken,
    BLUE_TANUKI_MAINTENANCE_TOKEN: "test-maintenance-token",
    BLUE_TANUKI_FILE_ROOT: join(auditDir, "file-root"),
    BLUE_TANUKI_STATE_ROOT: join(auditDir, "state"),
    BLUE_TANUKI_MEMORY_FILE: join(auditDir, "memory.jsonl"),
    BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyPath,
    BLUE_TANUKI_SESSION_DIR: sessionDir,
    BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
    BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({
      "openai-compatible": { capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.02, currency: "USD" } },
    }),
    LLM_BACKEND: "openai",
    OPENAI_MODEL: "local-contract-fixture-model",
    // Deliberately no OPENAI_API_KEY_REF: startup and request-time egress must fail closed.
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway test port was not allocated");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function spawnGateway(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [gatewayEntry, "--serve"], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

async function waitForHealth(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited before health check (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // The local Gateway has not opened its listener yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Gateway health check timed out");
}

async function waitForChannelSend(socket: WebSocket, expectedRequestId: () => string | undefined): Promise<string> {
  return new Promise((resolveMessage, reject) => {
    const buffered: Array<{ requestId: unknown; content: string }> = [];
    let poll: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => finish(new Error("Gateway WebChat response timed out")), 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const finish = (errorOrContent: Error | string) => {
      cleanup();
      if (errorOrContent instanceof Error) reject(errorOrContent);
      else resolveMessage(errorOrContent);
    };
    const onMessage = (data: unknown) => {
      let value: unknown;
      try { value = JSON.parse(String(data)); } catch { return; }
      if (!value || typeof value !== "object") return;
      const frame = value as { kind?: unknown; request_id?: unknown; content?: unknown };
      if (frame.kind !== "channel_send") return;
      const candidate = { requestId: frame.request_id, content: typeof frame.content === "string" ? frame.content : "" };
      const expected = expectedRequestId();
      if (expected && candidate.requestId === expected) finish(candidate.content);
      else buffered.push(candidate);
    };
    const onError = (error: Error) => finish(error);
    socket.on("message", onMessage);
    socket.once("error", onError);
    poll = setInterval(() => {
      const expected = expectedRequestId();
      if (!expected) return;
      const match = buffered.find((item) => item.requestId === expected);
      if (match) finish(match.content);
    }, 10);
  });
}

async function stopGateway(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  const closed = once(child, "close");
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([closed, new Promise<void>((resolveClose) => setTimeout(resolveClose, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    const forceClosed = once(child, "close");
    child.kill("SIGKILL");
    await forceClosed;
  }
  children.delete(child);
}
