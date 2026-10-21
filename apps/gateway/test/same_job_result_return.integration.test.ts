import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";
import { CompleteHistoryStore, operationPlanDigest, operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema, type OperationPlan, type OperationPlanCheckpointPlan } from "@blue-tanuki/protocol";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
const ROOT = process.cwd();
const WEBCHAT_TOKEN = "f1003-synthetic-inbound-token";
const OWNER_TOKEN = "f1003-synthetic-owner-token";
const TELEGRAM_TOKEN = "f1003-synthetic-telegram-token";
const TELEGRAM_USER_ID = "12345";
const TELEGRAM_CHAT_ID = "-1001";
const TELEGRAM_THREAD_ID = 41;
const TELEGRAM_UPDATE_ID = 751;
const TELEGRAM_OWNER = `telegram:${TELEGRAM_USER_ID}:chat:${TELEGRAM_CHAT_ID}:thread:${TELEGRAM_THREAD_ID}`;
const telegramSessionScope = `telegram:${TELEGRAM_OWNER}`;
const childProcesses = new Set<ChildProcessWithoutNullStreams>();

interface CapturedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

interface GatewaySnapshot {
  readonly operation_plan_status?: {
    readonly plans?: readonly Record<string, unknown>[];
    readonly waits?: readonly Record<string, unknown>[];
  };
}

interface WebSocketFrame {
  readonly kind?: string;
  readonly content?: string;
  readonly [key: string]: unknown;
}

afterEach(async () => {
  await Promise.all([...childProcesses].map(stopChild));
});

describe("F10.03 served Telegram same-job result return", () => {
  it("admitted Telegram wait reply reaches the shared HDS plan and WebChat returns its saved result", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-f1003-same-job-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const fileRoot = join(auditDir, "file-root");
    const captureFile = join(tempRoot, "telegram-fixture.jsonl");
    const preloadFile = join(tempRoot, "telegram-fetch-fixture.cjs");
    mkdirSync(fileRoot, { recursive: true });
    writeFileSync(join(fileRoot, "blue.txt"), "synthetic blue result for the same Telegram task\n", "utf8");
    seedTelegramWait(stateRoot, historyFile, fileRoot);
    writeFileSync(preloadFile, telegramFetchPreload(), "utf8");

    let providerCalls = 0;
    let providerFailure: unknown;
    const providerRequestIds: string[] = [];
    const provider = createServer((request, response) => {
      void (async () => {
        providerCalls += 1;
        const body = JSON.parse(await readRequest(request)) as { messages?: Array<{ content?: unknown }> };
        const prompt = (body.messages ?? []).flatMap((message) => typeof message.content === "string"
          ? [message.content] : []).find((content) => content.includes("固定request_id="));
        const requestId = prompt?.match(/固定request_id=([^\s。]+)/)?.[1];
        if (!requestId) throw new Error("wait-resume candidate prompt did not carry its fixed request id");
        providerRequestIds.push(requestId);
        const candidate = operationPlanCandidate(requestId, fileRoot);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "f1003-local-fixture", object: "chat.completion", created: 1,
          model: "f1003-local-fixture", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ plan: candidate }) },
            finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      })().catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_provider_fixture_failed" }));
      });
    });

    const providerPort = await listen(provider);
    const gatewayPort = await reservePort();
    const env = isolatedEnvironment(providerPort, gatewayPort, auditDir, stateRoot, memoryFile, historyFile, sessionDir,
      captureFile, JSON.stringify([telegramUpdate()]));
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    const socketFrames: WebSocketFrame[] = [];

    try {
      gateway = spawnGateway(env, preloadFile);
      await waitForHealth(gatewayPort, gateway);
      socket = await connectWebChat(gatewayPort, socketFrames);

      let lastSnapshot: GatewaySnapshot | undefined;
      const afterReply = await waitFor(async () => {
        if (providerFailure) throw providerFailure;
        const snapshot = await getSnapshot(gatewayPort, gateway);
        lastSnapshot = snapshot;
        if (providerCalls < 1) return null;
        const plans = snapshot.operation_plan_status?.plans ?? [];
        const waits = snapshot.operation_plan_status?.waits ?? [];
        const resumed = waits.some((wait) => wait.state === "resumed" && wait.compute_outcome === "candidate_retained");
        const candidate = plans.at(-1);
        return resumed && candidate ? { snapshot, candidate } : null;
      }, gateway, () => `Telegram wait reply was not reconciled into the shared HDS plan ledger; providerCalls=${providerCalls}; ` +
        `lastOperationPlanSnapshot=${JSON.stringify({ waits: lastSnapshot?.operation_plan_status?.waits,
          plans: lastSnapshot?.operation_plan_status?.plans })}; ` +
        `telegramCaptureTail=${readFileSync(captureFile, "utf8").trim().split(/\r?\n/u).slice(-8).join("\n")}; ` +
        `gatewayStdout=${gateway.stdout.join("")}`);

      expect(providerCalls).toBeGreaterThan(0);
      expect(providerRequestIds).toEqual(Array.from({ length: providerCalls }, () => `telegram-${TELEGRAM_UPDATE_ID}`));
      expect(JSON.stringify(afterReply.snapshot.operation_plan_status)).not.toContain(TELEGRAM_OWNER);
      const candidate = afterReply.candidate;
      expect(candidate).toMatchObject({ owner_authentication_required: true,
        owner_reauthentication_binding: {
          owner_identity_digest: operationPlanDigest(TELEGRAM_OWNER),
          channel_identity_digest: operationPlanDigest("telegram"),
        } });
      const planId = requiredString(candidate.plan_id, "candidate plan digest");
      const revisionDigest = requiredString(candidate.revision_digest, "candidate revision digest");
      const sourceBinding = candidate.owner_reauthentication_binding as Record<string, unknown>;
      const steps = candidate.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(1);
      const stepId = requiredString(steps[0]?.step_id, "candidate step digest");

      const review = await invokeOwnerControl(gatewayPort, "served-f1003-owner-session", OWNER_TOKEN,
        "review", { plan_id: planId, revision_digest: revisionDigest, step_id: stepId,
          owner_reauthentication: sourceBinding });
      expect(review.status).toBe(202);
      const resultReady = await waitFor(async () => {
        if (providerFailure) throw providerFailure;
        const snapshot = await getSnapshot(gatewayPort, gateway);
        const plan = snapshot.operation_plan_status?.plans?.find((entry) => entry.plan_id === planId);
        const planStep = (plan?.steps as Array<Record<string, unknown>> | undefined)?.[0];
        return planStep?.status === "verified" &&
          (planStep.binding as Record<string, unknown> | undefined)?.memory_status === "receipt_confirmed"
          ? { snapshot, planStep } : null;
      }, gateway, "read-only search did not reach a durable saved-result receipt");
      expect(resultReady.planStep).toMatchObject({ operation: "file.search", status: "verified" });

      const providerCallsBeforeResultRead = providerCalls;
      const resultReturn = await invokeOwnerControl(gatewayPort, "served-f1003-owner-session", OWNER_TOKEN,
        "result", { plan_id: planId, revision_digest: revisionDigest, step_id: stepId,
          owner_reauthentication: sourceBinding });
      expect(resultReturn.status).toBe(202);
      const returnedFrame = await waitFor(() => {
        const frame = socketFrames.find((item) => item.kind === "channel_send" &&
          typeof item.content === "string" && item.content.includes("保存時点のfile.search結果"));
        return frame ? frame : null;
      }, gateway, () => `WebChat did not receive the saved-result return; frames=${JSON.stringify(socketFrames)}; ` +
        `gatewayStdout=${gateway.stdout.join("")}`);
      expect(returnedFrame.content).toContain('"blue.txt":1');
      expect(returnedFrame.content).toContain("synthetic blue result for the same Telegram task");
      expect(returnedFrame.content).toContain("現在のファイル状態は再検索していません");
      expect(returnedFrame.content).toContain("検索完全性は不明です");
      expect(providerCalls).toBe(providerCallsBeforeResultRead);
      expect(providerCalls).toBeGreaterThan(0);
      expect(readFileSync(captureFile, "utf8")).toContain('"method":"getUpdates"');
      expect(readFileSync(captureFile, "utf8")).not.toContain(TELEGRAM_TOKEN);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      if (gateway) await stopChild(gateway);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

function seedTelegramWait(stateRoot: string, historyFile: string, fileRoot: string): void {
  const plan = operationPlanCandidate("telegram-prior-750", fileRoot);
  const owner = TELEGRAM_OWNER;
  const goal = "Continue the same synthetic Telegram task and inspect one blue line.";
  const planState: OperationPlanCheckpointPlan = { owner, channel: "telegram", goal,
    request_goal_criteria: { status: "not_provided", request_id: plan.request_id,
      content_sha256: createHash("sha256").update(goal, "utf8").digest("hex"), criteria: [], used_for_authority: false },
    revisions: [{ digest: operationPlanDigest(plan), plan }], receipt_observations: [], bindings: [], results: [] };
  const taskIdentityDigest = operationPlanTaskIdentityDigest(planState);
  const planIdDigest = operationPlanDigest(plan.plan_id);
  const revisionDigest = operationPlanDigest(plan);
  const sessionIdDigest = operationPlanDigest({ schema_version: "operation-plan-wait-session.v1", session_scope: telegramSessionScope });
  const deadlineAtMs = Date.now() + 5 * 60_000;
  const waitId = operationPlanDigest({ schema_version: "operation-plan-wait.v1", plan_id_digest: planIdDigest,
    task_identity_digest: taskIdentityDigest, revision_digest: revisionDigest, owner_digest: operationPlanDigest(owner),
    channel_digest: operationPlanDigest("telegram"), session_id_digest: sessionIdDigest, deadline_at_ms: deadlineAtMs });
  const checkpoint = OperationPlanCheckpointSchema.parse({ schema_version: "operation-plan-state.v1",
    waits: [{ wait_id: waitId, plan_id_digest: planIdDigest, task_identity_digest: taskIdentityDigest,
      revision_digest: revisionDigest, owner_digest: operationPlanDigest(owner), channel_digest: operationPlanDigest("telegram"),
      session_id_digest: sessionIdDigest, deadline_at_ms: deadlineAtMs, created_at_ms: Date.now(), state: "waiting",
      used_for_authority: false, may_execute: false }],
    plans: [planState] });
  const store = OperationPlanStateStore.fromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot });
  try { store.compareAndSet(null, checkpoint); } finally { store.close(); }
  const history = new CompleteHistoryStore({ filepath: historyFile });
  history.append({ kind: "audit_history", actor: "synthetic-fixture", source: "f1003-initial-state",
    timestamp: Date.now(), payload: { synthetic: true, used_for_authority: false } });
  if (!history.verify()) throw new Error("synthetic complete-history seed did not verify");
}

function operationPlanCandidate(requestId: string, fileRoot: string): OperationPlan {
  return {
    version: "operation-core.v1",
    plan_id: `f1003-plan-${requestId}`,
    request_id: requestId,
    state: "planned",
    steps: [{
      step_id: "f1003-search-blue",
      operation: "file.search",
      target: { kind: "directory", id: fileRoot },
      state: "planned",
      effects: ["read"],
      permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime",
      adapter_is_authority: false,
      command_generated_by_adapter_only: false,
      parameters: { root: fileRoot, query: "synthetic blue result", max_results: 1 },
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "f1003-search-observed", method: "result_equals",
          target: { kind: "directory", id: fileRoot }, expected: { root: fileRoot, sandbox_root: fileRoot,
            query: "synthetic blue result", visited_files: 1,
            matches: [{ path: "blue.txt", line_number: 1, line: "synthetic blue result for the same Telegram task" }] } }],
        compensation: { available: false, reason: "read-only synthetic search" } },
    }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  };
}

function telegramUpdate() {
  return { update_id: TELEGRAM_UPDATE_ID, message: { message_id: 9001, message_thread_id: TELEGRAM_THREAD_ID,
    text: "同じ仕事の続きです。synthetic blue result を1件だけ読み取り確認してください。",
    chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" },
    from: { id: Number(TELEGRAM_USER_ID), first_name: "Synthetic", is_bot: false } } };
}

function telegramFetchPreload(): string {
  return `
const fs = require("node:fs");
const originalFetch = globalThis.fetch.bind(globalThis);
function append(event) { fs.appendFileSync(process.env.BT_F1003_TELEGRAM_CAPTURE, JSON.stringify(event) + "\\n", "utf8"); }
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(rawUrl);
  if (url.hostname !== "api.telegram.org") append({ method: "fetch_attempt", hostname: url.hostname, port: url.port, path: url.pathname });
  if (url.hostname === "api.telegram.org") {
    const method = url.pathname.split("/").at(-1);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const configuredUpdates = JSON.parse(process.env.BT_F1003_TELEGRAM_UPDATES || "[]");
      const updates = configuredUpdates;
      const offset = Number.isSafeInteger(body.offset) ? body.offset : 0;
      const result = updates.filter((update) => update.update_id >= offset);
      append({ method, configured_update_count: configuredUpdates.length, offset, update_ids: result.map((update) => update.update_id) });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "sendMessage") {
      append({ method, chat_id: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9002 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("synthetic Telegram fixture rejected an unconfigured API method");
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    append({ method: "local_fetch", hostname: url.hostname, port: url.port, path: url.pathname });
    try { return await originalFetch(input, init); }
    catch (error) {
      append({ method: "local_fetch_error", hostname: url.hostname, port: url.port, path: url.pathname,
        error: String(error), cause: error && typeof error === "object" && "cause" in error ? String(error.cause) : "" });
      throw error;
    }
  }
  throw new Error("synthetic Gateway test blocked an unexpected network destination");
};
`;
}

function isolatedEnvironment(providerPort: number, gatewayPort: number, auditDir: string, stateRoot: string,
  memoryFile: string, historyFile: string, sessionDir: string, captureFile: string, updates: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort),
    WEBCHAT_TOKEN, WEBCHAT_RESUME_TOKEN: "f1003-synthetic-resume-token", BLUE_TANUKI_OWNER_TOKEN: OWNER_TOKEN,
    BLUE_TANUKI_MAINTENANCE_TOKEN: "f1003-synthetic-maintenance-token",
    BLUE_TANUKI_FILE_ROOT: join(auditDir, "file-root"), BLUE_TANUKI_STATE_ROOT: stateRoot,
    BLUE_TANUKI_MEMORY_FILE: memoryFile, BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile, BLUE_TANUKI_SESSION_DIR: sessionDir,
    BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
    BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "f1003-local-fixture": {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
    } }),
    BLUE_TANUKI_APPROVAL_MODE: "full_access", TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    TELEGRAM_INBOUND_GRANTS_JSON: JSON.stringify([{ user_id: TELEGRAM_USER_ID, chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: TELEGRAM_THREAD_ID }]), TELEGRAM_POLL_INTERVAL_MS: "50", TELEGRAM_POLL_TIMEOUT_SEC: "1",
    BT_F1003_TELEGRAM_UPDATES: updates, BT_F1003_TELEGRAM_CAPTURE: captureFile,
    LLM_BACKEND: "f1003-local-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
      name: "f1003-local-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
      model: "f1003-local-fixture", aliases: [], headers: {},
    }]), BLUE_TANUKI_LLM_BACKEND_HINT: "f1003-local-fixture",
    SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", DISCORD_BOT_TOKEN: "", LINE_CHANNEL_ACCESS_TOKEN: "",
    LINE_CHANNEL_SECRET: "" };
}

function spawnGateway(env: NodeJS.ProcessEnv, preloadFile: string): CapturedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preloadFile).href,
    "apps/gateway/src/main.ts", "--serve"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  childProcesses.add(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("close", () => childProcesses.delete(child));
  return { child, stdout, stderr };
}

async function connectWebChat(port: number, frames: WebSocketFrame[]): Promise<WebSocket> {
  const ticket = await fetch(`http://127.0.0.1:${port}/ws-ticket`, { method: "POST",
    headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ user: "served-f1003-owner-session" }) });
  if (!ticket.ok) throw new Error(`WebChat ticket request failed: ${ticket.status} ${await ticket.text()}`);
  const ticketValue = (await ticket.json() as { ticket?: string }).ticket;
  if (!ticketValue) throw new Error("WebChat ticket response did not include a ticket");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticketValue)}`);
  socket.on("message", (data) => {
    try { frames.push(JSON.parse(data.toString("utf8")) as WebSocketFrame); } catch { /* ignore malformed fixture frames */ }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function getSnapshot(port: number, gateway: CapturedProcess): Promise<GatewaySnapshot> {
  if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
  const response = await fetch(`http://127.0.0.1:${port}/runtime/snapshot`, {
    headers: { authorization: `Bearer ${WEBCHAT_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Gateway snapshot failed: ${response.status} ${await response.text()}`);
  return await response.json() as GatewaySnapshot;
}

async function invokeOwnerControl(port: number, user: string, token: string, action: "review" | "result",
  control: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/operators/developer/invoke`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ user, content: `plan:${action} ${JSON.stringify(control)}` }) });
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, gateway: CapturedProcess,
  failureMessage: string | (() => string)): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (providerErrorText(gateway)) throw new Error(providerErrorText(gateway));
  const detail = typeof failureMessage === "function" ? failureMessage() : failureMessage;
  throw new Error(`${detail}\nGateway stderr:\n${gateway.stderr.join("")}`);
}

function providerErrorText(gateway: CapturedProcess): string {
  const failure = gateway.stderr.join("");
  return failure.includes("synthetic_provider_fixture_failed") ? failure : "";
}

async function waitForHealth(port: number, gateway: CapturedProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastConnectionError = "not attempted";
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (error) { lastConnectionError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway health did not become ready on ${port}; last connection error: ${lastConnectionError}. ` +
    `stdout:\n${gateway.stdout.join("")}\nstderr:\n${gateway.stderr.join("")}`);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not allocate a port");
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function stopChild(gateway: CapturedProcess): Promise<void> {
  if (!childProcesses.has(gateway.child)) return;
  const closed = once(gateway.child, "close");
  if (gateway.child.exitCode === null && gateway.child.signalCode === null && !gateway.child.kill("SIGTERM")) {
    throw new Error("test-owned Gateway process could not be stopped");
  }
  await closed;
  childProcesses.delete(gateway.child);
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is unavailable`);
  return value;
}
