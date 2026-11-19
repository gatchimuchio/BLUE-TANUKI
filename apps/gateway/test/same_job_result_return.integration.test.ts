import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";
import { candidateFromCommand, CompleteHistoryStore, FailureMemoryStore, HDSUpperController,
  operationPlanDigest, operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, OperationPlanCheckpointSchema,
  type OperationPlan, type OperationPlanCheckpointPlan } from "@blue-tanuki/protocol";
import { parseEnvFile } from "../src/env_file.js";
import { buildLLMCommandRouteFromEnv } from "../src/llm_config.js";
import { dpapiSecretPathFromReference } from "../src/runtime_path_config.js";
import { storeBlueTanukiSecret } from "../src/secret_store.js";
import { createDefaultSetupConfig, renderSetupEnvFile } from "../src/setup_config.js";
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

describe("served Telegram result return and request-bound media ingress", () => {
  it("treats only an absent capture as not yet received and keeps read or data failures visible", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-telegram-capture-read-"));
    const captureFile = join(tempRoot, "capture.jsonl");
    const gateway = { child: { exitCode: null } } as unknown as CapturedProcess;
    try {
      expect(readCaptureEvents(captureFile)).toEqual([]);
      expect(captureDeliveryDiagnostic(captureFile, gateway, 0))
        .toContain("capture=missing; delivery=unreceived; gateway=running; provider_requests=0");
      expect(() => readCaptureEvents(tempRoot)).toThrow();

      writeFileSync(captureFile, "{invalid json\n", "utf8");
      expect(() => readCaptureEvents(captureFile)).toThrow(SyntaxError);
      writeFileSync(captureFile, "null\n", "utf8");
      expect(() => readCaptureEvents(captureFile)).toThrow(/non-object event/u);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates a Telegram text attachment and returns the same saved job result after WebChat reconnect", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-f1003-same-job-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const fileRoot = join(auditDir, "file-root");
    const captureFile = join(tempRoot, "telegram-fixture.jsonl");
    const preloadFile = join(tempRoot, "telegram-fetch-fixture.cjs");
    const attachmentText = "SYNTHETIC_WAIT_ATTACHMENT_SENTINEL: 青い帳面の対象を一件だけ確認してください。";
    const attachmentBytes = Buffer.from(attachmentText, "utf8");
    const update = {
      update_id: TELEGRAM_UPDATE_ID,
      message: {
        message_id: 9001,
        message_thread_id: TELEGRAM_THREAD_ID,
        caption: "添付文書の依頼に沿って、同じ仕事を続けてください。",
        document: {
          file_id: "synthetic-wait-text-file-id",
          file_name: "owner-private-wait-filename.txt",
          mime_type: "text/plain; charset=utf-8",
          file_size: attachmentBytes.byteLength,
        },
        chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" },
        from: { id: Number(TELEGRAM_USER_ID), first_name: "Synthetic", is_bot: false },
      },
    };
    const telegramFiles = {
      "synthetic-wait-text-file-id": {
        file_path: "documents/f1003-wait-fixture.txt",
        bytes_base64: attachmentBytes.toString("base64"),
      },
    };
    mkdirSync(fileRoot, { recursive: true });
    writeFileSync(join(fileRoot, "blue.txt"), "synthetic blue result for the same Telegram task\n", "utf8");
    const seededWait = seedTelegramWait(stateRoot, historyFile, fileRoot);
    writeFileSync(preloadFile, telegramFetchPreload(), "utf8");

    let providerCalls = 0;
    let providerFailure: unknown;
    const providerRequestIds: string[] = [];
    const providerRequestBodies: string[] = [];
    const provider = createServer((request, response) => {
      void (async () => {
        providerCalls += 1;
        const body = JSON.parse(await readRequest(request)) as { messages?: Array<{ content?: unknown }> };
        providerRequestBodies.push(JSON.stringify(body));
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
      captureFile, JSON.stringify([update, update]));
    const envFile = join(tempRoot, "blue-tanuki.env");
    env.BLUE_TANUKI_ENV_FILE = envFile;
    delete env.LLM_BACKEND;
    delete env.LLM_PROVIDERS_JSON;
    delete env.BLUE_TANUKI_LLM_BACKEND_HINT;
    delete env.BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON;
    delete env.BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON;
    const computeBudgetPolicy = JSON.stringify({
      window_ms: 86_400_000,
      currency: "USD",
      system: { max_tokens: 1_000_000, max_compute_ms: 86_400_000, max_cost: { amount: 10, currency: "USD" } },
      parent: { max_tokens: 100_000, max_compute_ms: 3_600_000, max_cost: { amount: 1, currency: "USD" } },
      task: { max_tokens: 10_000, max_compute_ms: 300_000, max_cost: { amount: 0.1, currency: "USD" } },
    });
    const providerCostProfiles = JSON.stringify({ "openai-compatible": {
      capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.02, currency: "USD" },
    } });
    const setupConfig = createDefaultSetupConfig({ base_dir: tempRoot });
    setupConfig.llm = {
      ...setupConfig.llm,
      provider: "openai-compatible",
      endpoint: `http://127.0.0.1:${providerPort}/v1`,
      model: "f1003-local-fixture",
      max_tokens: 1024,
      timeout_ms: 30_000,
      provider_cost_profiles_json: providerCostProfiles,
      compute_budget_policy_json: computeBudgetPolicy,
    };
    env.BT_F1003_TELEGRAM_FILES = JSON.stringify(telegramFiles);
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    let reconnectedSocket: WebSocket | undefined;
    const socketFrames: WebSocketFrame[] = [];

    try {
      writeFileSync(envFile, renderSetupEnvFile(setupConfig), "utf8");
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
        const resumedWait = waits.find((wait) => wait.wait_id === seededWait.waitId &&
          wait.plan_id === seededWait.planIdDigest && wait.task_identity_digest === seededWait.taskIdentityDigest &&
          wait.state === "resumed" && wait.wake_reason === "reply" && wait.compute_outcome === "candidate_retained");
        const candidate = resumedWait && plans.find((plan) => plan.plan_id === resumedWait.candidate_plan_id);
        return resumedWait && candidate ? { snapshot, resumedWait, candidate } : null;
      }, gateway, () => `Telegram wait reply was not reconciled into the shared HDS plan ledger; providerCalls=${providerCalls}; ` +
        `lastOperationPlanSnapshot=${JSON.stringify({ waits: lastSnapshot?.operation_plan_status?.waits,
          plans: lastSnapshot?.operation_plan_status?.plans })}; ` +
        `${captureDeliveryDiagnostic(captureFile, gateway, providerCalls)}; ` +
        `gatewayStdout=${gateway.stdout.join("")}`);

      expect(providerCalls).toBeGreaterThan(0);
      expect(providerRequestIds).toEqual(Array.from({ length: providerCalls }, () => `telegram-${TELEGRAM_UPDATE_ID}`));
      const providerRequests = providerRequestBodies.join("\n");
      expect(providerRequests).toContain("添付文書の依頼に沿って、同じ仕事を続けてください。");
      expect(providerRequests).toContain("未信頼データ");
      expect(providerRequests).toContain(attachmentText);
      expect(providerRequests).not.toContain("synthetic-wait-text-file-id");
      expect(providerRequests).not.toContain("owner-private-wait-filename.txt");
      expect(afterReply.resumedWait).toMatchObject({ wait_id: seededWait.waitId, plan_id: seededWait.planIdDigest,
        task_identity_digest: seededWait.taskIdentityDigest, wake_reason: "reply", used_for_authority: false,
        may_execute: false });
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

      const disconnectedSocket = socket;
      const disconnected = once(disconnectedSocket, "close");
      disconnectedSocket.close();
      await disconnected;
      expect(disconnectedSocket.readyState).toBe(WebSocket.CLOSED);
      socket = undefined;

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
      const reconnectedFrames: WebSocketFrame[] = [];
      reconnectedSocket = await connectWebChat(gatewayPort, reconnectedFrames);
      await waitFor(() => reconnectedFrames.some((frame) => frame.kind === "hello" &&
        frame.user === "served-f1003-owner-session") ? true : null, gateway,
      "WebChat did not reauthenticate the same owner identity after reconnect");
      const resultReturn = await invokeOwnerControl(gatewayPort, "served-f1003-owner-session", OWNER_TOKEN,
        "result", { plan_id: planId, revision_digest: revisionDigest, step_id: stepId,
          owner_reauthentication: sourceBinding });
      expect(resultReturn.status).toBe(202);
      const returnedFrame = await waitFor(() => {
        const frame = reconnectedFrames.find((item) => item.kind === "channel_send" &&
          typeof item.content === "string" && item.content.includes("保存時点のfile.search結果"));
        return frame ? frame : null;
      }, gateway, () => `reconnected WebChat did not receive the saved-result return; frames=${JSON.stringify(reconnectedFrames)}; ` +
        `gatewayStdout=${gateway.stdout.join("")}`);
      expect(returnedFrame.content).toContain('"blue.txt":1');
      expect(returnedFrame.content).toContain("synthetic blue result for the same Telegram task");
      expect(returnedFrame.content).toContain("現在のファイル状態は再検索していません");
      expect(returnedFrame.content).toContain("検索完全性は不明です");
      expect(providerCalls).toBe(providerCallsBeforeResultRead);
      expect(providerCalls).toBeGreaterThan(0);
      const telegramCapture = readFileSync(captureFile, "utf8");
      expect(telegramCapture).toContain('"method":"getUpdates"');
      expect(telegramCapture).toContain('"method":"getFile"');
      expect(telegramCapture).toContain('"method":"getFileBinary"');
      expect(telegramCapture).toContain(`"byte_count":${attachmentBytes.byteLength}`);
      expect(telegramCapture).not.toContain(TELEGRAM_TOKEN);
      const telegramEvents = telegramCapture.split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; update_ids?: number[];
          chat_id?: number | string; message_thread_id?: number });
      expect(telegramEvents.some((event) => event.method === "getUpdates" &&
        event.update_ids?.join(",") === `${TELEGRAM_UPDATE_ID},${TELEGRAM_UPDATE_ID}`)).toBe(true);
      expect(telegramEvents.filter((event) => event.method === "getFile")).toHaveLength(1);
      expect(telegramEvents.filter((event) => event.method === "getFileBinary")).toHaveLength(1);
      const telegramReplies = telegramEvents.filter((event) => event.method === "sendMessage");
      expect(telegramReplies).toHaveLength(1);
      expect(String(telegramReplies[0]?.chat_id)).toBe(TELEGRAM_CHAT_ID);
      expect(telegramReplies[0]?.message_thread_id).toBe(TELEGRAM_THREAD_ID);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      if (reconnectedSocket?.readyState === WebSocket.OPEN) reconnectedSocket.close();
      if (gateway) await stopChild(gateway);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("serves Telegram image and voice media through the shared C consumer and returns both responses", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-telegram-media-served-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const captureFile = join(tempRoot, "telegram-media-fixture.jsonl");
    const preloadFile = join(tempRoot, "telegram-media-fetch-fixture.cjs");
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
    const audioBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x01, 0x02]);
    const telegramFiles = {
      "synthetic-image-file-id": { file_path: "photos/synthetic.jpg", bytes_base64: imageBytes.toString("base64") },
      "synthetic-voice-file-id": { file_path: "voice/synthetic.oga", bytes_base64: audioBytes.toString("base64") },
    };
    const updates = [
      { update_id: 761, message: { message_id: 761, message_thread_id: TELEGRAM_THREAD_ID,
        caption: "この画像について要点を一つ教えてください。", photo: [{ file_id: "synthetic-image-file-id",
          file_size: imageBytes.byteLength }], chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" },
        from: { id: Number(TELEGRAM_USER_ID), first_name: "Synthetic", is_bot: false } } },
      { update_id: 762, message: { message_id: 762, message_thread_id: TELEGRAM_THREAD_ID,
        text: "この音声を文字起こししてください。", voice: { file_id: "synthetic-voice-file-id",
          file_size: audioBytes.byteLength, mime_type: "audio/ogg" },
        chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" },
        from: { id: Number(TELEGRAM_USER_ID), first_name: "Synthetic", is_bot: false } } },
    ];
    writeFileSync(preloadFile, telegramFetchPreload(), "utf8");
    const providerRequests: Array<{ readonly path: string; readonly content_type: string; readonly body: Buffer }> = [];
    let providerFailure: unknown;
    const provider = createServer((request, response) => {
      void (async () => {
        const body = await readRequestBytes(request);
        const path = request.url ?? "";
        providerRequests.push({ path, content_type: request.headers["content-type"] ?? "", body });
        response.writeHead(200, { "content-type": "application/json" });
        if (path.endsWith("/audio/transcriptions")) {
          response.end(JSON.stringify({ text: "synthetic spoken words", model: "f1003-local-fixture" }));
        } else if (path.endsWith("/chat/completions")) {
          response.end(JSON.stringify({ id: "f1003-media-fixture", object: "chat.completion", created: 1,
            model: "f1003-local-fixture", choices: [{ index: 0, message: { role: "assistant",
              content: "synthetic image description" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
        } else {
          throw new Error(`unexpected local provider endpoint: ${path}`);
        }
      })().catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_media_provider_fixture_failed" }));
      });
    });
    const providerPort = await listen(provider);
    const gatewayPort = await reservePort();
    const env = isolatedEnvironment(providerPort, gatewayPort, auditDir, stateRoot, memoryFile, historyFile,
      sessionDir, captureFile, JSON.stringify(updates));
    env.BT_F1003_TELEGRAM_FILES = JSON.stringify(telegramFiles);
    env.BLUE_TANUKI_LLM_IMAGE_CAPABLE_MODELS_JSON = JSON.stringify({ "f1003-local-fixture": ["f1003-local-fixture"] });
    env.BLUE_TANUKI_LLM_AUDIO_TRANSCRIPTION_CAPABLE_MODELS_JSON = JSON.stringify({
      "f1003-local-fixture": ["f1003-local-fixture"],
    });
    let gateway: CapturedProcess | undefined;
    try {
      gateway = spawnGateway(env, preloadFile);
      await waitForHealth(gatewayPort, gateway);
      const delivered = await waitFor(() => {
        if (providerFailure) throw providerFailure;
        const events = readCaptureEvents<{ method?: string; text?: string }>(captureFile);
        const replies = events.filter((event) => event.method === "sendMessage");
        return replies.length >= 2 && providerRequests.length === 2 ? { events, replies } : null;
      }, gateway, () => `served Telegram media did not reach C and return; providerRequests=${providerRequests.map(({ path }) => path)}; ` +
        `${captureDeliveryDiagnostic(captureFile, gateway, providerRequests.length)}; stderr=${gateway?.stderr.join("")}`);

      const imageRequest = providerRequests.find((item) => item.path.endsWith("/chat/completions"));
      const audioRequest = providerRequests.find((item) => item.path.endsWith("/audio/transcriptions"));
      expect(imageRequest).toBeDefined();
      expect(audioRequest).toBeDefined();
      expect(imageRequest?.content_type).toContain("application/json");
      expect(imageRequest?.body.toString("utf8")).toContain("data:image/jpeg;base64," + imageBytes.toString("base64"));
      expect(imageRequest?.body.toString("utf8")).toContain("この画像について要点を一つ教えてください。");
      expect(audioRequest?.content_type).toContain("multipart/form-data");
      expect(audioRequest?.body.indexOf(audioBytes)).toBeGreaterThanOrEqual(0);
      expect(audioRequest?.body.toString("utf8")).toContain("name=\"model\"");
      expect(delivered.replies.map((event) => event.text ?? "").join("\n")).toContain("synthetic image description");
      expect(delivered.replies.map((event) => event.text ?? "").join("\n")).toContain("synthetic spoken words");
      expect(delivered.replies).toHaveLength(2);

      const persisted = readTreeBytes(tempRoot);
      expect(persisted.toString("utf8")).toContain('"memory_retrieval_suppressed_for":"transient_audio_transcription"');
      expect(persisted.includes(Buffer.from(TELEGRAM_TOKEN, "utf8"))).toBe(false);
      expect(persisted.includes(Buffer.from("synthetic-image-file-id", "utf8"))).toBe(false);
      expect(persisted.includes(Buffer.from("synthetic-voice-file-id", "utf8"))).toBe(false);
      expect(persisted.includes(Buffer.from(telegramFiles["synthetic-image-file-id"].bytes_base64, "utf8"))).toBe(false);
      expect(persisted.includes(imageBytes)).toBe(false);
      expect(persisted.includes(audioBytes)).toBe(false);
    } finally {
      if (gateway) await stopChild(gateway);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("serves Telegram UTF-8 text attachment through the shared C consumer and returns its response", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-telegram-text-served-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const captureFile = join(tempRoot, "telegram-text-fixture.jsonl");
    const preloadFile = join(tempRoot, "telegram-text-fetch-fixture.cjs");
    const attachmentText = "SYNTHETIC_TEXT_ATTACHMENT_SENTINEL: 青い帳面には数字の42が記載されています。";
    const attachmentBytes = Buffer.from(attachmentText, "utf8");
    const update = {
      update_id: 763,
      message: {
        message_id: 763,
        message_thread_id: TELEGRAM_THREAD_ID,
        caption: "添付文書の内容を要約してください。",
        document: {
          file_id: "synthetic-text-file-id",
          file_name: "owner-private-filename.txt",
          mime_type: "text/plain; charset=utf-8",
          file_size: attachmentBytes.byteLength,
        },
        chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" },
        from: { id: Number(TELEGRAM_USER_ID), first_name: "Synthetic", is_bot: false },
      },
    };
    const telegramFiles = {
      "synthetic-text-file-id": {
        file_path: "documents/f1003-text-fixture.txt",
        bytes_base64: attachmentBytes.toString("base64"),
      },
    };
    writeFileSync(preloadFile, telegramFetchPreload(), "utf8");

    const providerRequests: Array<{ readonly path: string; readonly content_type: string; readonly body: Buffer }> = [];
    let providerFailure: unknown;
    const provider = createServer((request, response) => {
      void (async () => {
        const body = await readRequestBytes(request);
        const path = request.url ?? "";
        providerRequests.push({ path, content_type: request.headers["content-type"] ?? "", body });
        if (!path.endsWith("/chat/completions")) throw new Error(`unexpected text attachment provider endpoint: ${path}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "f1003-text-fixture", object: "chat.completion", created: 1,
          model: "f1003-local-fixture", choices: [{ index: 0, message: { role: "assistant",
            content: "合成添付文書の要約: 青い帳面には42と記載されています。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      })().catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_text_attachment_provider_fixture_failed" }));
      });
    });
    const providerPort = await listen(provider);
    const gatewayPort = await reservePort();
    const env = isolatedEnvironment(providerPort, gatewayPort, auditDir, stateRoot, memoryFile, historyFile,
      sessionDir, captureFile, JSON.stringify([update]));
    env.BT_F1003_TELEGRAM_FILES = JSON.stringify(telegramFiles);
    let gateway: CapturedProcess | undefined;

    try {
      gateway = spawnGateway(env, preloadFile);
      await waitForHealth(gatewayPort, gateway);
      const delivered = await waitFor(() => {
        if (providerFailure) throw providerFailure;
        const events = readCaptureEvents<{ method?: string; text?: string; path?: string; byte_count?: number }>(captureFile);
        const replies = events.filter((event) => event.method === "sendMessage");
        const fetched = events.some((event) => event.method === "getFile") &&
          events.some((event) => event.method === "getFileBinary" && event.byte_count === attachmentBytes.byteLength);
        return replies.length >= 1 && fetched && providerRequests.length === 1 ? { events, replies } : null;
      }, gateway, () => `served Telegram text attachment did not reach C and return; providerRequests=${providerRequests.map(({ path }) => path)}; ` +
        `${captureDeliveryDiagnostic(captureFile, gateway, providerRequests.length)}; stderr=${gateway?.stderr.join("")}`);

      const providerRequest = providerRequests[0];
      expect(providerRequest?.path).toMatch(/\/chat\/completions$/u);
      expect(providerRequest?.content_type).toContain("application/json");
      expect(providerRequest?.body.toString("utf8")).toContain("添付文書の内容を要約してください。");
      expect(providerRequest?.body.toString("utf8")).toContain("未信頼データ");
      expect(providerRequest?.body.toString("utf8")).toContain(attachmentText);
      expect(providerRequest?.body.toString("utf8")).not.toContain("synthetic-text-file-id");
      expect(providerRequest?.body.toString("utf8")).not.toContain("owner-private-filename.txt");
      expect(delivered.replies).toHaveLength(1);
      expect(delivered.replies[0]?.text).toContain("合成添付文書の要約");
      expect(readFileSync(captureFile, "utf8")).not.toContain(TELEGRAM_TOKEN);

      const persisted = readTreeBytes(tempRoot);
      const persistedText = persisted.toString("utf8");
      expect(persistedText).toContain('"source":"output_audit"');
      expect(persistedText).toContain('"used_for_authority":false');
      expect(persisted.includes(Buffer.from(TELEGRAM_TOKEN, "utf8"))).toBe(false);
      expect(persisted.includes(Buffer.from("synthetic-text-file-id", "utf8"))).toBe(false);
      expect(persisted.includes(Buffer.from("owner-private-filename.txt", "utf8"))).toBe(false);
    } finally {
      if (gateway) await stopChild(gateway);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it.runIf(process.platform === "win32")("初回Telegram受信許可と保護参照を同じ承認で保存し、再起動後に許可した相手にだけ返信する", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-telegram-protected-registration-"));
    const runtimeRoot = join(root, "runtime");
    const envFile = join(runtimeRoot, "blue-tanuki.env");
    const capture = join(runtimeRoot, "telegram.jsonl");
    const promptLog = join(runtimeRoot, "prompt.txt");
    const networkPreload = join(root, "telegram-fetch-fixture.cjs");
    const nativePreload = join(root, "telegram-native-fixture.cjs");
    const token = "123456:synthetic_telegram_token_for_protected_fixture";
    const foreignToken = "987654:synthetic_foreign_secret_for_telegram_fixture";
    const resumeToken = "synthetic-telegram-native-resume-token";
    const settingsToken = "synthetic-telegram-native-settings-token";
    const grant = { user_id: "804192715", chat_id: "-9984048831", message_thread_id: 20414197 };
    const grants = JSON.stringify([grant]);
    const baseConfig = "# Telegram隔離試験\r\nUNRELATED_FIXTURE_SETTING=preserved\r\n";
    const grantLine = `TELEGRAM_INBOUND_GRANTS_JSON=${JSON.stringify(grants)}\r\n`;
    const requestText = "合成試験用の青い花について一行で説明してください。";
    const wrongUserText = "許可範囲外の送信者の合成依頼";
    const wrongChatText = "許可範囲外のチャットの合成依頼";
    const wrongThreadText = "許可範囲外のスレッドの合成依頼";
    const replyText = "合成試験の回答は青い花です。";
    const message = { message_thread_id: grant.message_thread_id,
      chat: { id: Number(grant.chat_id), type: "supergroup" },
      from: { id: Number(grant.user_id), first_name: "Synthetic", is_bot: false } };
    const updates = [
      { update_id: 770, message: { ...message, message_id: 770,
        from: { ...message.from, id: Number(grant.user_id) + 1 }, text: wrongUserText } },
      { update_id: 771, message: { ...message, message_id: 771,
        chat: { ...message.chat, id: Number(grant.chat_id) - 1 }, text: wrongChatText } },
      { update_id: 772, message: { ...message, message_id: 772, message_thread_id: grant.message_thread_id + 1, text: wrongThreadText } },
      { update_id: 773, message: { ...message, message_id: 773, text: requestText } },
    ];
    const providerBodies: string[] = [];
    const provider = createServer((request, response) => {
      void readRequest(request).then(body => {
        providerBodies.push(body);
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const content = body.includes("blue-tanuki.memory-citation-response.v1") ? JSON.stringify({
          schema_version: "blue-tanuki.memory-citation-response.v1", answer: replyText, citations: [],
        }) : replyText;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "telegram-protected-fixture", object: "chat.completion", created: 1,
          model: "f1003-local-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      }).catch(() => response.writeHead(500).end());
    });
    let gateway: CapturedProcess | undefined;
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const env = isolatedEnvironment(providerPort, gatewayPort, join(runtimeRoot, "audit"), join(runtimeRoot, "state"),
        join(runtimeRoot, "memory.jsonl"), join(runtimeRoot, "history.jsonl"), join(runtimeRoot, "sessions"), capture, "[]");
      delete env.TELEGRAM_BOT_TOKEN;
      delete env.TELEGRAM_INBOUND_GRANTS_JSON;
      env.BLUE_TANUKI_LOG_DIR = join(runtimeRoot, "logs");
      env.BLUE_TANUKI_SETTINGS_TOKEN = settingsToken;
      env.WEBCHAT_RESUME_TOKEN = resumeToken;
      env.BT_F1003_TELEGRAM_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
      mkdirSync(runtimeRoot);
      writeFileSync(envFile, baseConfig, "utf8");
      writeFileSync(networkPreload, telegramFetchPreload(), "utf8");
      writeFileSync(nativePreload, `
require("./telegram-fetch-fixture.cjs");
const childProcess = require("node:child_process");
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const script = args?.at(-2) === "-EncodedCommand" ? Buffer.from(args.at(-1), "base64").toString("utf16le") : "";
  if (!script.includes("UseSystemPasswordChar")) return spawn(command, args, options);
  require("node:fs").appendFileSync(${JSON.stringify(promptLog)}, "native-prompt\\n");
  const child = new (require("node:events").EventEmitter)();
  child.stdout = new (require("node:stream").PassThrough)();
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.end(Buffer.from(${JSON.stringify(token)}));
    child.emit("close", 0);
  });
  return child;
};
require("node:module").syncBuiltinESMExports();
`, "utf8");

      const origin = `http://127.0.0.1:${gatewayPort}`;
      const protectedValues = [token, foreignToken];
      const assertHidden = (text: string) => {
        for (const value of protectedValues) expect(text.includes(value)).toBe(false);
      };
      const assertGrantHidden = (data: unknown) => {
        const text = JSON.stringify(data) ?? "";
        for (const id of [grant.user_id, grant.chat_id, String(grant.message_thread_id)]) expect(text.includes(id)).toBe(false);
      };
      const request = async (route: string, authorization: string, body?: object, requestOrigin = origin) => {
        const response = await fetch(origin + route, { method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${authorization}`, origin: requestOrigin,
            ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
        const text = await response.text();
        assertHidden(text);
        return { response, data: JSON.parse(text) as Record<string, unknown> };
      };
      gateway = spawnGateway(env, nativePreload, envFile);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const app = await fetch(origin + "/app", { signal: AbortSignal.timeout(8_000) });
      expect(app.status).toBe(200);
      expect(app.headers.get("cache-control")).toBe("no-store");
      const html = await app.text();
      expect(html).toContain('id="prepare-telegram-bot-credential"');
      expect(html).toContain('id="telegram-inbound-user-id"');
      expect(html).toContain('id="telegram-inbound-chat-id"');
      expect(html).toContain('id="telegram-inbound-thread-id"');
      assertHidden(html);
      assertGrantHidden(html);
      expect((await request("/settings/config", WEBCHAT_TOKEN)).response.status).toBe(401);
      const settings = await request("/settings/config", settingsToken);
      expect(settings.response.status).toBe(200);
      expect(settings.data.telegram_bot_initial_grant_registration_available).toBe(true);
      expect(settings.data.telegram_bot_credential_registration_available).not.toBe(true);
      const proposalRoute = "/owner/telegram-bot-credential-proposal";
      const proposalBody = { initial_inbound_grant: grant };
      expect((await request(proposalRoute, resumeToken, proposalBody)).response.status).toBe(401);
      expect((await request(proposalRoute, OWNER_TOKEN, proposalBody, "http://untrusted.invalid")).response.status).toBe(403);
      expect((await request(proposalRoute, OWNER_TOKEN, { token: "fixture-invalid-body-token" })).response.status).toBe(400);
      const wildcard = await request(proposalRoute, OWNER_TOKEN, { initial_inbound_grant: { ...grant, chat_id: "*" } });
      expect(wildcard.response.status).toBe(400);
      assertGrantHidden(wildcard.data);
      const unscoped = await request(proposalRoute, OWNER_TOKEN, {});
      expect(unscoped.response.status).toBe(409);
      expect(unscoped.data).toMatchObject({ accepted: false, status: "settings_proposal_unavailable" });

      // A preconfigured grant still supports the existing token-only registration, but cannot be replaced by first use.
      const configured = baseConfig + grantLine;
      writeFileSync(envFile, configured, "utf8");
      const manualSettings = await request("/settings/config", settingsToken);
      expect(manualSettings.response.status).toBe(200);
      expect(manualSettings.data.telegram_bot_credential_registration_available).toBe(true);
      expect(manualSettings.data.telegram_bot_initial_grant_registration_available).not.toBe(true);
      assertGrantHidden(manualSettings.data);
      const occupied = await request(proposalRoute, OWNER_TOKEN, proposalBody);
      expect(occupied.response.status).toBe(409);
      expect(occupied.data).toMatchObject({ accepted: false, status: "settings_proposal_unavailable" });
      assertGrantHidden(occupied.data);
      expect(readFileSync(envFile, "utf8")).toBe(configured);
      writeFileSync(envFile, baseConfig, "utf8");

      const prepare = async () => {
        const proposed = await request(proposalRoute, OWNER_TOKEN, proposalBody);
        expect(proposed.response.status, JSON.stringify(proposed.data)).toBe(202);
        expect(proposed.data).toMatchObject({ accepted: true, status: "approval_required", command_id: expect.any(String) });
        assertGrantHidden(proposed.data);
        const queue = await request("/approval", resumeToken);
        expect(queue.response.status).toBe(200);
        assertGrantHidden(queue.data);
        const pending = (queue.data.pending_approvals as Record<string, unknown>[])
          .find(item => item.command_id === proposed.data.command_id);
        expect(pending).toMatchObject({ operation: "settings.write", approval_level: "L3_final_review", approval_token: expect.any(String) });
        const approval = `/approval/${encodeURIComponent(requiredString(proposed.data.command_id, "command_id"))}`;
        const review = await request(`${approval}/content`, resumeToken, {});
        expect(review.response.status, JSON.stringify(review.data)).toBe(200);
        expect(review.response.headers.get("cache-control")).toBe("no-store");
        expect(review.data).toMatchObject({ kind: "settings_write", operation: "settings.write", no_store: true,
          changes: [
            { key: "telegram.credential_reference", before: "unconfigured", after: "register_on_restart" },
            { key: "telegram.inbound_grants", before: "unconfigured", after: "one_exact_grant_on_restart" },
          ],
          review_digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
        expect(review.data.telegram_bot_registration).toEqual({
          api_host: "api.telegram.org", protected_reference_configured: false,
          initial_inbound_grant_digest: expect.stringMatching(/^[a-f0-9]{64}$/u), initial_inbound_grant: grant,
        });
        return { approval, nativeApproval: `${approval}/native-credential`,
          verdict: { verdict: "approve", approval_token: pending?.approval_token, content_review_digest: review.data.review_digest } };
      };
      const first = await prepare();
      expect((await request(first.approval, resumeToken, first.verdict)).response.status).toBe(409);
      expect((await request(first.nativeApproval, resumeToken, first.verdict, "http://untrusted.invalid")).response.status).toBe(403);
      expect((await request(first.nativeApproval, resumeToken,
        { ...first.verdict, content_review_digest: "0".repeat(64) })).response.status).toBe(409);
      expect(readCaptureText(promptLog)).toBeUndefined();
      expect(readFileSync(envFile, "utf8")).toBe(baseConfig);
      expect(readCaptureEvents(capture)).toEqual([]);

      const changedConfig = baseConfig + "# review対象の変更\r\n";
      writeFileSync(envFile, changedConfig, "utf8");
      const stale = await request(first.nativeApproval, resumeToken, first.verdict);
      expect(stale.response.status, JSON.stringify(stale.data)).toBe(409);
      assertGrantHidden(stale.data);
      expect(readCaptureText(promptLog)).toBeUndefined();
      expect(readdirSync(runtimeRoot)).not.toContain("secrets");
      expect(readFileSync(envFile, "utf8")).toBe(changedConfig);

      writeFileSync(envFile, baseConfig, "utf8");
      const { nativeApproval, verdict } = await prepare();
      let saved = await request(nativeApproval, resumeToken, verdict);
      if (saved.response.status === 429 && saved.data.error === "rate_limited" &&
          typeof saved.data.retry_after_ms === "number" && saved.data.retry_after_ms > 0 && saved.data.retry_after_ms <= 5_000) {
        expect(readCaptureText(promptLog)).toBeUndefined();
        expect(readFileSync(envFile, "utf8")).toBe(baseConfig);
        await delay(saved.data.retry_after_ms + 25);
        saved = await request(nativeApproval, resumeToken, verdict);
      }
      expect(saved.response.status, JSON.stringify(saved.data)).toBe(200);
      expect(saved.data).toMatchObject({ ok: true, result: { approval: "approve", executed: true, status: "success" } });
      const config = readFileSync(envFile, "utf8");
      const values = parseEnvFile(config).values;
      const reference = requiredString(values.TELEGRAM_BOT_TOKEN_REF, "Telegram protected reference");
      expect(values.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(values.TELEGRAM_INBOUND_GRANTS_JSON).toBe(grants);
      expect(config.slice(0, baseConfig.length)).toBe(baseConfig);
      expect(config.slice(baseConfig.length).split("\r\n").filter(Boolean).sort()).toEqual([
        `TELEGRAM_BOT_TOKEN_REF=${JSON.stringify(reference)}`, grantLine.trimEnd(),
      ].sort());
      const secretPath = dpapiSecretPathFromReference(reference);
      expect(dirname(secretPath)).toBe(join(runtimeRoot, "secrets"));
      expect(readdirSync(dirname(secretPath))).toEqual([basename(secretPath)]);
      const ciphertext = readFileSync(secretPath, "utf8").trim();
      expect(ciphertext.length).toBeGreaterThan(0);
      assertHidden(ciphertext);
      protectedValues.push(reference, secretPath, ciphertext);
      for (const item of [settings, saved]) {
        assertHidden(JSON.stringify(item.data));
        assertGrantHidden(item.data);
      }
      expect((await request(nativeApproval, resumeToken, verdict)).response.status).toBe(409);
      expect(readCaptureText(promptLog)).toBe("native-prompt\n");
      expect(providerBodies).toEqual([]);
      expect(readCaptureEvents(capture)).toEqual([]);

      await stopChild(gateway);
      const setupOutput = gateway.stdout.concat(gateway.stderr).join("");
      assertHidden(setupOutput);
      assertGrantHidden(setupOutput);
      assertGrantHidden(readTreeBytes(runtimeRoot, envFile).toString("utf8"));
      env.BT_F1003_TELEGRAM_UPDATES = JSON.stringify(updates);
      gateway = spawnGateway(env, networkPreload, envFile);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const snapshot = await request("/runtime/snapshot", WEBCHAT_TOKEN);
      expect(snapshot.response.status).toBe(200);
      expect(snapshot.data.telegram_configured).toBe(true);
      assertGrantHidden(snapshot.data);
      const sent = await waitFor(() => readCaptureEvents<{ method: string; text?: string }>(capture)
        .find(event => event.method === "sendMessage") ?? null, gateway, "保護参照だけで起動したTelegramから返信されなかった");
      expect(sent).toMatchObject({ method: "sendMessage", chat_id: grant.chat_id,
        message_thread_id: grant.message_thread_id, text: expect.stringContaining(replyText) });
      const events = readCaptureEvents(capture);
      expect(events).toContainEqual(expect.objectContaining({ method: "getUpdates", update_ids: [770, 771, 772, 773] }));
      expect(events.filter(event => event.method === "sendMessage")).toHaveLength(1);
      expect(providerBodies).toHaveLength(1);
      expect(providerBodies[0]).toContain(requestText);
      for (const denied of [wrongUserText, wrongChatText, wrongThreadText]) expect(providerBodies[0]).not.toContain(denied);
      providerBodies.forEach(assertHidden);
      await stopChild(gateway);
      assertHidden(gateway.stdout.concat(gateway.stderr).join(""));
      gateway = undefined;
      expect(readCaptureText(promptLog)).toBe("native-prompt\n");
      const persisted = readTreeBytes(runtimeRoot);
      for (const plaintext of [token, foreignToken]) expect(persisted.includes(Buffer.from(plaintext))).toBe(false);

      const rejectStartup = async (label: string, failure: string, extra: NodeJS.ProcessEnv = {}) => {
        const rejectedCapture = join(runtimeRoot, `${label}-telegram.jsonl`);
        const rejected = spawnGateway({ ...env, ...extra, BT_F1003_TELEGRAM_CAPTURE: rejectedCapture }, networkPreload, envFile);
        gateway = rejected;
        const [exitCode, signal] = await once(rejected.child, "close", { signal: AbortSignal.timeout(40_000) });
        expect(exitCode).toBe(1);
        expect(signal).toBeNull();
        expect(readCaptureEvents(rejectedCapture)).toEqual([]);
        expect(providerBodies).toHaveLength(1);
        const diagnostic = rejected.stdout.concat(rejected.stderr).join("");
        expect(diagnostic).toContain(failure);
        assertHidden(diagnostic);
        gateway = undefined;
      };

      const alternateEnvFile = join(runtimeRoot, "alternate.env");
      protectedValues.push(alternateEnvFile);
      await rejectStartup("configuration-mismatch", "gateway_env_file_target_mismatch", { BLUE_TANUKI_ENV_FILE: alternateEnvFile });

      const foreign = storeBlueTanukiSecret("OPENAI_API_KEY", foreignToken, { envFilePath: envFile, env: {} });
      protectedValues.push(foreign.ref, dpapiSecretPathFromReference(foreign.ref));
      writeFileSync(envFile, configured + `TELEGRAM_BOT_TOKEN_REF=${JSON.stringify(foreign.ref)}\r\n`, "utf8");
      await rejectStartup("foreign", "telegram_bot_token_reference_unavailable");

      renameSync(secretPath, `${secretPath}.held`);
      writeFileSync(envFile, config, "utf8");
      await rejectStartup("missing", "telegram_bot_token_reference_unavailable", { TELEGRAM_BOT_TOKEN: token });
    } finally {
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 240_000);

  it("preserves Telegram admission as outcome unknown when Gateway stops during getFile", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-telegram-shutdown-"));
    const stateRoot = join(tempRoot, "state");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const captureFile = join(tempRoot, "telegram-capture.jsonl");
    const restartedCaptureFile = join(tempRoot, "restarted-capture.jsonl");
    const preloadFile = join(tempRoot, "telegram-fetch-fixture.cjs");
    const shutdownFile = join(tempRoot, "request-shutdown");
    const envFile = join(tempRoot, "blue-tanuki.env");
    const attachment = Buffer.from("synthetic attachment for interrupted Telegram intake", "utf8");
    const fileId = "synthetic-shutdown-text-file-id";
    const update = { update_id: 764, message: { message_id: 764, message_thread_id: TELEGRAM_THREAD_ID,
      caption: "合成添付を読んでください。", document: { file_id: fileId, mime_type: "text/plain", file_size: attachment.length },
      chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" }, from: { id: Number(TELEGRAM_USER_ID), is_bot: false } } };
    const updateDigest = createHash("sha256").update(JSON.stringify(update)).digest("hex");
    let providerRequests = 0;
    const provider = createServer((_request, response) => {
      providerRequests += 1;
      response.writeHead(500).end();
    });
    let gateway: CapturedProcess | undefined;
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const env = isolatedEnvironment(providerPort, gatewayPort, join(tempRoot, "audit"), stateRoot,
        join(tempRoot, "memory.jsonl"), historyFile, join(tempRoot, "sessions"), captureFile, JSON.stringify([update]));
      env.BLUE_TANUKI_ENV_FILE = envFile;
      env.BT_F1003_TELEGRAM_SHUTDOWN_FILE = shutdownFile;
      env.BT_F1003_TELEGRAM_FILES = JSON.stringify({ [fileId]: {
        file_path: "documents/synthetic-shutdown.txt", bytes_base64: attachment.toString("base64"),
      } });
      writeFileSync(envFile, "# 隔離済みの合成試験\n", "utf8");
      writeFileSync(preloadFile, telegramFetchPreload(), "utf8");
      gateway = spawnGateway(env, preloadFile);
      await waitForHealth(gatewayPort, gateway, 40_000);
      await waitFor(() => readCaptureEvents(captureFile).find((event) => event.method === "getFile") ?? null,
        gateway, "Telegramの添付照会が永続受付後に開始されなかった");
      expect(readTelegramInboxCursor(stateRoot)).toEqual([
        { update_id: update.update_id, payload_digest: updateDigest, delivery_state: "dispatching" },
      ]);

      const stopped = once(gateway.child, "close", { signal: AbortSignal.timeout(10_000) });
      writeFileSync(shutdownFile, "stop\n", "utf8");
      expect(await stopped).toEqual([0, null]);
      gateway = undefined;
      expect(readCaptureEvents(captureFile).map((event) => event.method))
        .toEqual(["getUpdates", "getFile", "getFileAborted"]);
      expect(readTelegramInboxCursor(stateRoot)).toEqual([
        { update_id: update.update_id, payload_digest: updateDigest, delivery_state: "outcome_unknown" },
      ]);

      delete env.BT_F1003_TELEGRAM_SHUTDOWN_FILE;
      env.BT_F1003_TELEGRAM_CAPTURE = restartedCaptureFile;
      gateway = spawnGateway(env, preloadFile);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const firstPoll = await waitFor(() => readCaptureEvents(restartedCaptureFile)
        .find((event) => event.method === "getUpdates") ?? null, gateway, "再起動後のTelegram照会を観測できなかった");
      expect(firstPoll).toMatchObject({ offset: update.update_id + 1, update_ids: [] });
      expect(readCaptureEvents(restartedCaptureFile).every((event) => event.method === "getUpdates")).toBe(true);
      expect(providerRequests).toBe(0);
      expect(readCaptureText(historyFile) ?? "").not.toContain(`telegram-${update.update_id}`);
    } finally {
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(["shutdown", "andon", "interrupted"] as const)("closes Telegram reply admission and retains in-flight ambiguity during %s", async (stopMode) => {
    const root = mkdtempSync(join(tmpdir(), "bt-telegram-reply-stop-"));
    const stateRoot = join(root, "state");
    const historyFile = join(root, "history.jsonl");
    const capture = join(root, "telegram.jsonl");
    const restartCapture = join(root, "restart.jsonl");
    const networkPreload = join(root, "telegram-fetch-fixture.cjs");
    const observerPreload = join(root, "observe-telegram-stop.mjs");
    const shutdownFile = join(root, "request-shutdown");
    const probeFile = join(root, "attempt-late-send");
    const reopenedProbeFile = join(root, "attempt-send-after-clear");
    const replayFixture = join(root, "synthetic-replay.json");
    const envFile = join(root, "fixture.env");
    const resumeToken = "synthetic-telegram-stop-resume-token";
    const d4Token = "synthetic-telegram-stop-d4-token";
    const requestText = "合成試験用の青い花について一行で説明してください。";
    const replyText = "合成試験で青い花について回答します。";
    const update = { update_id: 774, message: { message_id: 774, message_thread_id: TELEGRAM_THREAD_ID, text: requestText,
      chat: { id: Number(TELEGRAM_CHAT_ID), type: "supergroup" }, from: { id: Number(TELEGRAM_USER_ID), is_bot: false } } };
    const eventIdentity = { update_id: update.update_id, payload_digest: createHash("sha256").update(JSON.stringify(update)).digest("hex") };
    const providerBodies: string[] = [];
    const provider = createServer((request, response) => {
      void readRequest(request).then(body => {
        providerBodies.push(body);
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        const content = body.includes("blue-tanuki.memory-citation-response.v1") ? JSON.stringify({
          schema_version: "blue-tanuki.memory-citation-response.v1", answer: replyText, citations: [],
        }) : replyText;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "telegram-stop-fixture", object: "chat.completion", created: 1,
          model: "f1003-local-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      }).catch(() => response.writeHead(500).end());
    });
    let gateway: CapturedProcess | undefined;
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const env = isolatedEnvironment(providerPort, gatewayPort, join(root, "audit"), stateRoot,
        join(root, "memory.jsonl"), historyFile, join(root, "sessions"), capture, JSON.stringify([update]));
      env.WEBCHAT_RESUME_TOKEN = resumeToken;
      env.BLUE_TANUKI_D4_RUNTIME_ID = "blue_tanuki";
      env.BLUE_TANUKI_D4_RUNTIME_TOKEN = d4Token;
      env.BT_F1003_TELEGRAM_SHUTDOWN_FILE = shutdownFile;
      env.BT_F1003_TELEGRAM_HOLD_SEND = "1";
      writeFileSync(envFile, "# 隔離済みの合成試験\n", "utf8");
      writeFileSync(networkPreload, telegramFetchPreload(), "utf8");
      const adapter = pathToFileURL(join(ROOT, "packages/channel-telegram/dist/index.js")).href;
      writeFileSync(observerPreload, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { TelegramChannel } from ${JSON.stringify(adapter)};
createRequire(import.meta.url)(${JSON.stringify(networkPreload)});

const stopMode = ${JSON.stringify(stopMode)};
const probeFile = ${JSON.stringify(probeFile)};
const reopenedProbeFile = ${JSON.stringify(reopenedProbeFile)};
const replayFixture = ${JSON.stringify(replayFixture)};
const lateCommandId = "synthetic-telegram-after-stop-probe";
const reopenedCommandId = "synthetic-telegram-after-clear-probe";
const send = TelegramChannel.prototype.send;
let observedChannel;
function record(event) {
  appendFileSync(process.env.BT_F1003_TELEGRAM_CAPTURE, JSON.stringify(event) + "\\n");
}
TelegramChannel.prototype.send = async function (payload, meta, context) {
  const late = meta.command_id === lateCommandId;
  const reopened = meta.command_id === reopenedCommandId;
  if (!late && !reopened) {
    observedChannel = this;
    record({ method: "telegramReplyEntered", caller_signal: Boolean(context?.signal) });
    if (stopMode === "interrupted") writeFileSync(replayFixture, JSON.stringify({ payload, meta }), { flag: "wx" });
  }
  const result = await send.call(this, payload, meta, context);
  record({ method: late ? "telegramLateSendResult" : reopened ? "telegramClearedSendResult" : "telegramReplyResult", delivered: result.delivered,
    delivery_status: result.delivery_status, error_code: result.error_code });
  return result;
};
async function attemptProbe(channel, commandId, content) {
  await channel.send({ channel: "telegram", target: ${JSON.stringify(TELEGRAM_CHAT_ID)}, content },
    { command_id: commandId, upstream_commit_hash: "a".repeat(64) });
}
if (stopMode === "shutdown") {
  const stop = TelegramChannel.prototype.stop;
  TelegramChannel.prototype.stop = async function () {
    await stop.call(this);
    if (this === observedChannel) await attemptProbe(this, lateCommandId, "合成停止後送信");
  };
} else if (stopMode === "andon") {
  let lateAttempted = false;
  const timer = setInterval(() => {
    if (!observedChannel) return;
    if (!lateAttempted && existsSync(probeFile)) {
      lateAttempted = true;
      void attemptProbe(observedChannel, lateCommandId, "合成停止後送信").catch(() => record({ method: "telegramLateSendProbeFailed" }));
    }
    if (existsSync(reopenedProbeFile)) {
      clearInterval(timer);
      void attemptProbe(observedChannel, reopenedCommandId, "合成解除後送信").catch(() => record({ method: "telegramClearedSendProbeFailed" }));
    }
  }, 20);
  timer.unref();
} else if (process.env.BT_F1003_TELEGRAM_REPLAY_PROBE === "1") {
  const start = TelegramChannel.prototype.start;
  TelegramChannel.prototype.start = async function (handler) {
    await start.call(this, handler);
    const fixture = JSON.parse(readFileSync(replayFixture, "utf8"));
    const result = await send.call(this, fixture.payload, fixture.meta);
    record({ method: "telegramSameDeliveryProbe", delivered: result.delivered, delivery_status: result.delivery_status });
  };
}
`, "utf8");

      gateway = spawnGateway(env, observerPreload, envFile);
      await waitForHealth(gatewayPort, gateway, 40_000);
      await waitFor(() => readCaptureEvents(capture).find(event => event.method === "sendMessage") ?? null,
        gateway, "許可されたTelegram依頼の返信が実送信境界に到達しなかった");
      expect(providerBodies).toHaveLength(1);
      expect(providerBodies[0]).toContain(requestText);
      expect(readCaptureEvents(capture)).toContainEqual({ method: "telegramReplyEntered", caller_signal: false });
      expect(readTelegramInboxCursor(stateRoot)).toEqual([{ ...eventIdentity, delivery_state: "dispatching" }]);
      const issued = readTelegramOutboundDeliveries(stateRoot);
      expect(issued).toEqual([{ delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        delivery_state: "dispatching", updated_at_ms: expect.any(Number) }]);
      const deliveryDigest = requiredString(issued[0]?.delivery_digest, "Telegram delivery digest");

      if (stopMode === "andon") {
        const changeStop = (action: "activate" | "clear") => fetch(`http://127.0.0.1:${gatewayPort}/approval/emergency-stop`, {
          method: "POST", headers: { authorization: `Bearer ${resumeToken}`, "content-type": "application/json" },
          body: JSON.stringify({ action, reason: "合成Telegram停止試験" }), signal: AbortSignal.timeout(8_000),
        });
        const response = await changeStop("activate");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, result: { active: true } });
        writeFileSync(probeFile, "late send\n", "utf8");
        await waitFor(() => {
          const events = readCaptureEvents(capture);
          return events.some(event => event.method === "telegramReplyResult") &&
            events.some(event => event.method === "telegramLateSendResult") ? true : null;
        }, gateway, "Andonが発行済み返信を中断し、追加送信を遮断する結果を観測できなかった");
        expect(readCaptureEvents(capture).filter(event => event.method === "sendMessage")).toHaveLength(1);
        const cleared = await changeStop("clear");
        expect(cleared.status, await cleared.clone().text()).toBe(200);
        expect(await cleared.json()).toMatchObject({ ok: true, result: { active: false } });
        writeFileSync(reopenedProbeFile, "new send after clear\n", "utf8");
        const fresh = await waitFor(() => readCaptureEvents(capture).find(event => event.method === "telegramClearedSendResult") ?? null,
          gateway, "Andon解除後に新しい送信の結果を観測できなかった");
        expect(fresh).toMatchObject({ delivered: true, delivery_status: "delivered" });
      }
      const stopped = once(gateway.child, "close", { signal: AbortSignal.timeout(10_000) });
      if (stopMode === "interrupted") {
        expect(gateway.child.kill("SIGKILL")).toBe(true);
        const [code, signal] = await stopped;
        expect(code !== 0 || signal !== null).toBe(true);
        expect(readTelegramOutboundDeliveries(stateRoot)).toEqual(issued);
      } else {
        writeFileSync(shutdownFile, "stop\n", "utf8");
        expect(await stopped).toEqual([0, null]);
      }
      gateway = undefined;

      const events = readCaptureEvents(capture);
      expect(events.filter(event => event.method === "sendMessage")).toEqual([
        { method: "sendMessage", chat_id: TELEGRAM_CHAT_ID, message_thread_id: TELEGRAM_THREAD_ID, text: expect.stringContaining(replyText) },
        ...(stopMode === "andon" ? [{ method: "sendMessage", chat_id: TELEGRAM_CHAT_ID, text: "合成解除後送信" }] : []),
      ]);
      if (stopMode === "interrupted") {
        expect(events.some(event => event.method === "sendMessageResponseAfterAbort" || event.method === "telegramReplyResult")).toBe(false);
      } else {
        expect(events.filter(event => event.method === "sendMessageResponseAfterAbort")).toHaveLength(1);
        expect(events).toContainEqual({ method: "telegramReplyResult", delivered: false,
          delivery_status: "unknown", error_code: "delivery_outcome_unknown" });
        expect(events).toContainEqual(expect.objectContaining({ method: "telegramLateSendResult", delivered: false,
          delivery_status: "not_delivered" }));
        expect(readTelegramOutboundDeliveries(stateRoot)).toContainEqual(expect.objectContaining({
          delivery_digest: deliveryDigest, delivery_state: "outcome_unknown",
        }));
      }
      expect(readCaptureText(capture) ?? "").not.toContain(TELEGRAM_TOKEN);

      if (stopMode !== "andon") {
        const interrupted = [{ ...eventIdentity, delivery_state: "outcome_unknown" }];
        if (stopMode === "shutdown") expect(readTelegramInboxCursor(stateRoot)).toEqual(interrupted);
        delete env.BT_F1003_TELEGRAM_SHUTDOWN_FILE;
        delete env.BT_F1003_TELEGRAM_HOLD_SEND;
        env.BT_F1003_TELEGRAM_CAPTURE = restartCapture;
        if (stopMode === "interrupted") env.BT_F1003_TELEGRAM_REPLAY_PROBE = "1";
        gateway = spawnGateway(env, stopMode === "interrupted" ? observerPreload : networkPreload, envFile);
        await waitForHealth(gatewayPort, gateway, 40_000);
        const firstPoll = await waitFor(() => readCaptureEvents(restartCapture)
          .find(event => event.method === "getUpdates") ?? null, gateway, "再起動後のTelegram照会を観測できなかった");
        expect(firstPoll).toMatchObject({ offset: update.update_id + 1, update_ids: [] });
        expect(readTelegramInboxCursor(stateRoot)).toEqual(interrupted);
        if (stopMode === "interrupted") {
          const duplicate = await waitFor(() => readCaptureEvents(restartCapture)
            .find(event => event.method === "telegramSameDeliveryProbe") ?? null, gateway, "同じ配送の再投入結果が観測されなかった");
          expect(duplicate).toEqual({ method: "telegramSameDeliveryProbe", delivered: false, delivery_status: "unknown" });
        }
        const restored = readTelegramOutboundDeliveries(stateRoot);
        expect(restored).toEqual([{ delivery_digest: deliveryDigest, delivery_state: "outcome_unknown", updated_at_ms: expect.any(Number) }]);
        const inboxFile = join(stateRoot, "private-state", "telegram-inbox", "telegram-inbox.sqlite");
        const persisted = readFileSync(inboxFile);
        const sensitive = [TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, requestText, replyText, `telegram-${update.update_id}`];
        for (const raw of sensitive) expect(persisted.includes(Buffer.from(raw))).toBe(false);

        const notifications = async (token?: string) => fetch(`http://127.0.0.1:${gatewayPort}/notifications`, {
          headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8_000),
        });
        expect((await notifications()).status).toBe(401);
        for (const token of [WEBCHAT_TOKEN, d4Token]) {
          const response = await notifications(token);
          expect(response.status).toBe(200);
          expect(await response.json()).not.toHaveProperty("telegram_delivery");
        }
        const owner = await notifications(OWNER_TOKEN);
        expect(owner.status).toBe(200);
        expect(owner.headers.get("cache-control")).toBe("no-store");
        const ownerView = await owner.json() as { scope?: string; telegram_delivery?: unknown };
        expect(ownerView.scope).toBe("owner");
        expect(ownerView.telegram_delivery).toEqual({ status: "available", unknown_count: 1,
          recent_unknown: [{ delivery_digest: deliveryDigest, updated_at_ms: restored[0]?.updated_at_ms }] });
        for (const raw of sensitive) expect(JSON.stringify(ownerView).includes(raw)).toBe(false);
        expect(readCaptureEvents(restartCapture).every(event =>
          event.method === "getUpdates" || event.method === "telegramSameDeliveryProbe")).toBe(true);
        expect(readTelegramOutboundDeliveries(stateRoot)).toEqual(restored);
        expect(providerBodies).toHaveLength(1);
      }
    } finally {
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);
});

describe("Webhookの永続受付", () => {
  it("Webhookの重複と順序逆転を拒み、中断した仕事を再起動後に再実行しない", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-webhook-durable-"));
    const webhookToken = "synthetic-durable-webhook-token";
    const backend = "durable-webhook-fixture";
    const source = "fixture-stream";
    const replyTarget = "ordinary-target";
    const expiresAt = Date.now() + 300_000;
    const first = { source, event_id: "fixture-event", sequence: 1, expires_at_ms: expiresAt,
      content: "合成試験で青を使う短い題名を提案してください。", reply_to: replyTarget };
    const interrupted = { ...first, event_id: "fixture-interrupted", sequence: 3,
      content: "合成試験で緑を使う短い題名を提案してください。" };
    const flags = { used_for_authority: false, may_execute: false };
    const answer = "青と緑の合成タイトル";
    const citationSchema = "blue-tanuki.memory-citation-response.v1";
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        providerRequests += 1;
        if (providerRequests === 2) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"choices":');
          return;
        }
        let prompt: { messages?: { role: string; content?: unknown }[] };
        try {
          prompt = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof prompt;
        } catch {
          response.writeHead(400).end();
          return;
        }
        const requestsCitationEnvelope = prompt.messages?.some(message => message.role === "system" &&
          typeof message.content === "string" && message.content.includes(citationSchema));
        const content = requestsCitationEnvelope ? JSON.stringify({ schema_version: citationSchema, answer, citations: [] }) : answer;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: backend, object: "chat.completion", created: 1, model: backend,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    const frames: WebSocketFrame[] = [];
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const envFile = join(root, "fixture.env");
      const fileRoot = join(root, "files");
      const historyFile = join(root, "history.jsonl");
      writeFileSync(envFile, "# 隔離した試験設定\n", "utf8");
      mkdirSync(fileRoot);
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN, WEBHOOK_TOKEN: webhookToken,
        WEBCHAT_RESUME_TOKEN: "synthetic-durable-webhook-resume",
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-durable-webhook-maintenance",
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: fileRoot, BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"), BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_BACKEND_HINT: backend,
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ [backend]: {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: backend, LLM_PROVIDERS_JSON: JSON.stringify([{
          name: backend, type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: backend, aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      const submit = async (body: typeof first, status: number, bearer = webhookToken) => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/webhook`, {
          method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
        });
        const result = await response.json() as { request_id: string; state?: string };
        expect(response.status, JSON.stringify(result)).toBe(status);
        if (status === 202) expect(response.headers.get("cache-control")).toBe("no-store");
        return result;
      };
      const waitForResult = (requestId: string, activeGateway: CapturedProcess) => waitFor(() =>
        frames.find(frame => frame.kind === "channel_send" && frame.request_id === requestId && frame.content?.includes(answer))
          ?? null, activeGateway, () =>
        `受付に対応する計算結果が届かなかった。providerRequests=${providerRequests} frames=${JSON.stringify(frames)}`);

      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      socket = await connectWebChat(gatewayPort, frames, replyTarget);
      await submit(first, 401, WEBCHAT_TOKEN);
      const accepted = await submit(first, 202);
      expect(accepted).toEqual({ accepted: true, duplicate: false, request_id: expect.any(String), state: "dispatching", ...flags });
      await waitForResult(accepted.request_id, gateway);
      const complete = await waitFor(async () => {
        const repeated = await submit(first, 202);
        expect(repeated).toMatchObject({ accepted: true, duplicate: true, request_id: accepted.request_id, ...flags });
        return repeated.state === "handler_returned" ? repeated : null;
      }, gateway, "Webhookの処理終了が受付に保存されなかった");
      expect(providerRequests).toBe(1);
      await submit({ ...first, content: "同じイベントIDに異なる合成内容" }, 409);

      const started = await submit(interrupted, 202);
      expect(started).toMatchObject({ accepted: true, duplicate: false, state: "dispatching", ...flags });
      expect(started.request_id).not.toBe(accepted.request_id);
      await waitFor(() => providerRequests === 2 ? true : null, gateway, "中断対象の受付が計算先に届かなかった");
      await submit({ ...first, event_id: "fixture-older", sequence: 2 }, 409);
      await submit({ ...first, event_id: "fixture-expired", sequence: 4, expires_at_ms: Date.now() - 1000 }, 410);

      socket.terminate();
      socket = undefined;
      const stopped = once(gateway.child, "close");
      expect(gateway.child.kill("SIGKILL")).toBe(true);
      await stopped;
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      socket = await connectWebChat(gatewayPort, frames, replyTarget);
      expect(await submit(first, 202)).toEqual(complete);
      expect(await submit(interrupted, 202)).toMatchObject({ accepted: true, duplicate: true,
        request_id: started.request_id, state: "outcome_unknown", ...flags });
      await submit({ ...first, event_id: "fixture-restarted-older", sequence: 2 }, 409);
      expect(providerRequests).toBe(2);

      const other = await submit({ ...first, source: "fixture-other-stream" }, 202);
      expect(other).toMatchObject({ accepted: true, duplicate: false, state: "dispatching", ...flags });
      expect(other.request_id).not.toBe(accepted.request_id);
      await waitForResult(other.request_id, gateway);
      expect(providerRequests).toBe(3);
      expect(frames.filter(frame => frame.kind === "channel_send").map(frame => frame.request_id))
        .toEqual([accepted.request_id, other.request_id]);
      const history = new CompleteHistoryStore({ filepath: historyFile });
      expect(history.verify()).toBe(true);
      const webhookEntries = history.all().filter(entry => entry.kind === "user_input" && entry.source === "webchat");
      expect(webhookEntries.map(entry => entry.request_id)).toEqual([accepted.request_id, started.request_id, other.request_id]);
      expect(webhookEntries.map(entry => entry.actor)).toEqual(Array(3).fill("webchat-webhook-token-holder"));
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);
});

describe("served owner Work approval withdrawal", () => {
  it("withdraws the same Work while its approval token is being issued and restores the withdrawal after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-owner-work-approval-issuance-"));
    const resumeToken = "synthetic-owner-work-resume-token";
    const submission = { submission_id: "810edbf0-0569-484f-8447-3226631a9ade" };
    const task = "合成試験用の青い花を探すための読取計画を作成してください。";
    const markers = { reached: join(root, "issuance-held"), release: join(root, "release"),
      discarded: join(root, "token-discarded"), executed: join(root, "executor-entered") };
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      providerRequests += 1;
      request.resume();
      response.writeHead(500).end();
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const fileRoot = join(root, "files");
      const envFile = join(root, "fixture.env");
      const historyFile = join(root, "history.jsonl");
      const preload = join(root, "hold-owner-work-approval-issuance.mjs");
      mkdirSync(fileRoot);
      writeFileSync(envFile, "# isolated test configuration\n");
      const webchatModule = pathToFileURL(join(ROOT, "packages/channel-webchat/dist/index.js")).href;
      const coreModule = pathToFileURL(join(ROOT, "packages/blue-tanuki/dist/index.js")).href;
      const hdsModule = pathToFileURL(join(ROOT, "packages/hds-brain/dist/index.js")).href;
      writeFileSync(preload, `
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { MemoryResumeApprovalTokenStore, WebChatChannel } from ${JSON.stringify(webchatModule)};
import { Executor } from ${JSON.stringify(coreModule)};
import { candidateFromCommand, FailureMemoryStore } from ${JSON.stringify(hdsModule)};
const task = ${JSON.stringify(task)};
const markers = ${JSON.stringify(markers)};
const scope = new AsyncLocalStorage();
let heldCommandId;
let heldToken;
const start = WebChatChannel.prototype.start;
WebChatChannel.prototype.start = function (handler) {
  return start.call(this, (request, context) =>
    request.user === "webchat-owner-token-holder" && request.content.includes(task)
      ? scope.run(request.id, () => handler(request, context))
      : handler(request, context));
};
const evaluate = FailureMemoryStore.prototype.evaluateCommandGate;
FailureMemoryStore.prototype.evaluateCommandGate = function (command, context) {
  if (scope.getStore() === context.request_id && command.type === "llm_call") {
    const candidate = candidateFromCommand(command, context);
    this.addSignature({ scope: candidate.scope, failure_type: "logic_drift", input_pattern: candidate.input_pattern,
      action_pattern: candidate.action_pattern, context_pattern: candidate.context_pattern,
      state: "active", suppression_policy: "require_approval", match_level: 1 });
  }
  return evaluate.call(this, command, context);
};
const issue = WebChatChannel.prototype.issueResumeApprovalToken;
WebChatChannel.prototype.issueResumeApprovalToken = async function (commandId, ttl) {
  const issued = await issue.call(this, commandId, ttl);
  const requestId = scope.getStore();
  if (!requestId) return issued;
  if (!issued?.token) throw new Error("synthetic owner Work approval issuance did not return a token");
  heldCommandId = commandId;
  heldToken = issued.token;
  writeFileSync(markers.reached, JSON.stringify({ requestId, commandId }) + "\\n", { flag: "wx" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(markers.release) && Date.now() < deadline) await setTimeout(20);
  if (!existsSync(markers.release)) throw new Error("synthetic owner Work approval issuance hold expired");
  return issued;
};
const consume = MemoryResumeApprovalTokenStore.prototype.consume;
MemoryResumeApprovalTokenStore.prototype.consume = async function (requestId, token) {
  const consumed = await consume.call(this, requestId, token);
  if (consumed && requestId === heldCommandId && token === heldToken) {
    writeFileSync(markers.discarded, requestId, { flag: "wx" });
  }
  return consumed;
};
const execute = Executor.prototype.execute;
Executor.prototype.execute = function (command, context) {
  if (command.id === heldCommandId) writeFileSync(markers.executed, command.id);
  return execute.call(this, command, context);
};
`, "utf8");
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: resumeToken, BLUE_TANUKI_OWNER_TOKEN: OWNER_TOKEN,
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-owner-work-maintenance",
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"),
        BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_FILE_ROOT: fileRoot, BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"), BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
        BLUE_TANUKI_APPROVAL_MODE: "full_access",
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_BACKEND_HINT: "owner-work-approval-fixture",
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "owner-work-approval-fixture": {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: "owner-work-approval-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "owner-work-approval-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: "owner-work-approval-fixture", aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      const request = (route: string, authorization: string, body?: object) =>
        fetch(`http://127.0.0.1:${gatewayPort}${route}`, { method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8_000) });
      const listApprovals = async () => {
        const response = await request("/approval", resumeToken);
        expect(response.status).toBe(200);
        return (await response.json() as { pending_approvals: { command_id: string; approval_token?: string }[] }).pending_approvals;
      };
      const cancelRoute = "/owner/task-submission-cancel";
      const statusRoute = "/owner/task-submission-status";
      gateway = spawnGateway(env, preload);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const proposed = await request("/owner/goal-purpose-adoption", OWNER_TOKEN, {
        purpose_text: "合成試験として花の情報を読取専用で整理する。",
      });
      expect(proposed.status).toBe(202);
      const adoption = await proposed.json() as { command_id: string };
      const adoptionApproval = (await listApprovals()).find(item => item.command_id === adoption.command_id);
      expect(adoptionApproval?.approval_token).toEqual(expect.any(String));
      const adoptionRoute = `/approval/${encodeURIComponent(adoption.command_id)}`;
      const review = await request(`${adoptionRoute}/content`, resumeToken, {});
      expect(review.status).toBe(200);
      const reviewed = await review.json() as { review_digest?: string; command_digest: string };
      const adopted = await request(adoptionRoute, resumeToken, { verdict: "approve",
        approval_token: adoptionApproval?.approval_token, content_review_digest: reviewed.review_digest ?? reviewed.command_digest });
      expect(adopted.status).toBe(200);
      const goals = await request("/owner/task-goals", OWNER_TOKEN);
      expect(goals.status).toBe(200);
      const { goals: [goal] } = await goals.json() as { goals: { goal_ref: string; purpose_version: number }[] };
      expect(goal).toMatchObject({ goal_ref: expect.any(String), purpose_version: 1 });

      const frames: WebSocketFrame[] = [];
      const user = "synthetic-owner-work-reply";
      socket = await connectWebChat(gatewayPort, frames, user);
      const accepted = await request("/owner/task-compute", OWNER_TOKEN, {
        ...submission, user, task, goal_ref: goal!.goal_ref, purpose_version: goal!.purpose_version,
      });
      expect(accepted.status).toBe(202);
      const receipt = await accepted.json() as { request_id: string };
      const held = await waitFor(() => {
        const raw = readCaptureText(markers.reached);
        return raw?.endsWith("\n") ? JSON.parse(raw) as { requestId: string; commandId: string } : null;
      }, gateway, "the exact owner Work did not reach approval token issuance");
      expect(held.requestId).toBe(receipt.request_id);
      expect(await listApprovals()).not.toContainEqual(expect.objectContaining({ command_id: held.commandId }));
      expect((await request(cancelRoute, WEBCHAT_TOKEN, submission)).status).toBe(401);
      expect((await request(cancelRoute, OWNER_TOKEN, { submission_id: "5aae1129-a49f-4bff-8e56-0a73ba18a593" })).status).toBe(404);
      const cancelled = await request(cancelRoute, OWNER_TOKEN, submission);
      expect(cancelled.status, await cancelled.clone().text()).toBe(202);
      expect(cancelled.headers.get("cache-control")).toBe("no-store");
      const withdrawal = await cancelled.json() as { cancellation: Record<string, unknown> };
      expect(withdrawal).toEqual({ found: true, accepted: true, cancellation: {
        status: "approval_withdrawn", cancel_request_accepted: true, executor_started: false,
        external_processing_stop: "unknown", cancel_requested_at_ms: expect.any(Number),
        used_for_authority: false, may_execute: false,
      } });
      writeFileSync(markers.release, "", { flag: "wx" });
      const status = () => request(statusRoute, OWNER_TOKEN, submission);
      await waitFor(async () => {
        const response = await status();
        expect(response.status).toBe(200);
        const payload = await response.json() as { state?: string };
        return payload.state === "handler_returned" ? payload : null;
      }, gateway, "the withdrawn owner Work handler did not finish");
      expect(readCaptureText(markers.discarded)).toBe(held.commandId);
      expect(readCaptureText(markers.executed)).toBeUndefined();
      expect(await listApprovals()).not.toContainEqual(expect.objectContaining({ command_id: held.commandId }));
      const stale = await request(`/approval/${encodeURIComponent(held.commandId)}`, resumeToken, {
        verdict: "approve", approval_token: "synthetic-stale-approval-input",
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "approval_content_review_stale" });
      expect(JSON.stringify(frames)).not.toContain(held.commandId);
      expect(providerRequests).toBe(0);
      const history = new CompleteHistoryStore({ filepath: historyFile });
      expect(history.verify()).toBe(true);
      const workHistory = history.replay({ kind: "approval_history", request_id: receipt.request_id });
      expect(workHistory).toContainEqual(expect.objectContaining({ command_id: held.commandId,
        payload: expect.objectContaining({ event: "policy_evaluation" }) }));
      expect(workHistory).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ event: "approval_pending" }) }));

      socket.terminate();
      socket = undefined;
      await stopChild(gateway);
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const restored = await status();
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ found: true, request_id: receipt.request_id, cancellation: withdrawal.cancellation });
      const repeated = await request(cancelRoute, OWNER_TOKEN, submission);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(withdrawal);
      expect(providerRequests).toBe(0);
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 90_000);
});

describe("served D4 Runtime work observation", () => {
  it("returns a scoped execution observation after restart without replay or retained reply content", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-d4-runtime-observation-"));
    const runtime = "blue_tanuki";
    const token = "synthetic-d4-runtime-observation-token-only";
    const input = { runtime_id: runtime, session_id: "synthetic-runtime-first-session",
      submission_id: "f4510a36-9f40-4dc7-a002-32bf5001197e" };
    const otherInput = { ...input, session_id: "synthetic-runtime-second-session" };
    const intent = "合成テストで短い文章を要約してください。";
    const failedIntent = "合成試験でGatewayの受付後に処理を中断してください。";
    const failedInput = { ...input, submission_id: "4bc6054f-54bd-48e5-a664-e609f94b91a1" };
    const privateException = "synthetic private exception must not reach the D4 audience";
    const privateResult = "合成の応答本文。この結果は揮発の同一セッションだけで表示する。";
    const flags = { used_for_authority: false, may_execute: false };
    const execution = { status: "adapter_returned", feedback_status: "success", ...flags };
    let providerRequests = 0;
    let completeCompute: (() => void) | undefined;
    const provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once("end", () => {
        providerRequests += 1;
        if (providerRequests !== 1) {
          response.writeHead(409).end();
          return;
        }
        completeCompute = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "d4-observation-fixture", object: "chat.completion", created: 1,
            model: "d4-observation-fixture", choices: [{ index: 0,
              message: { role: "assistant", content: privateResult }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
        };
      });
    });
    let gateway: CapturedProcess | undefined;
    const sockets = new Set<WebSocket>();
    const frames: string[] = [];
    const otherFrames: string[] = [];
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const envFile = join(root, "fixture.env");
      writeFileSync(envFile, "# isolated test configuration\n", "utf8");
      const handlerFailurePreload = join(root, "runtime-handler-failure.mjs");
      const hdsModule = pathToFileURL(join(ROOT, "packages/hds-brain/dist/index.js")).href;
      writeFileSync(handlerFailurePreload, `
import { HDSUpperController } from ${JSON.stringify(hdsModule)};
const decide = HDSUpperController.prototype.decide;
HDSUpperController.prototype.decide = function (request, options) {
  if (request.user === "d4-runtime-adapter-token-holder" && request.content === ${JSON.stringify(failedIntent)}) {
    throw new Error(${JSON.stringify(privateException)});
  }
  return decide.call(this, request, options);
};
`, "utf8");
      mkdirSync(join(root, "files"));
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: "synthetic-d4-observation-resume",
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-d4-observation-maintenance",
        BLUE_TANUKI_D4_RUNTIME_ID: runtime, BLUE_TANUKI_D4_RUNTIME_TOKEN: token,
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: join(root, "files"), BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl"),
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "d4-observation-fixture": {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: "d4-observation-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "d4-observation-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: "d4-observation-fixture", aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      const post = (route: string, body: object) => fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      const connectSession = async (sessionId: string, observedFrames: string[]) => {
        const response = await post("/runtime/ws-ticket", { runtime_id: runtime, session_id: sessionId });
        expect(response.status).toBe(200);
        const { ticket } = await response.json() as { ticket: string };
        const sessionSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticket)}`);
        sockets.add(sessionSocket);
        sessionSocket.on("message", data => observedFrames.push(String(data)));
        await once(sessionSocket, "open");
      };
      const disconnectSessions = () => {
        for (const sessionSocket of sockets) sessionSocket.terminate();
        sockets.clear();
      };
      gateway = spawnGateway(env, handlerFailurePreload);
      await waitForHealth(gatewayPort, gateway, 40_000);
      await connectSession(input.session_id, frames);
      await connectSession(otherInput.session_id, otherFrames);
      const protectedAudience = `d4-runtime:${createHmac("sha256", token)
        .update("blue-tanuki.d4-runtime.session.v1\0").update(input.session_id).digest("hex")}`;
      const genericTicket = await fetch(`http://127.0.0.1:${gatewayPort}/ws-ticket`, { method: "POST",
        headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: protectedAudience }), signal: AbortSignal.timeout(8_000) });
      expect(genericTicket.status).toBe(403);
      expect(await genericTicket.json()).toEqual({ error: "reserved_runtime_audience" });
      const accepted = await post("/runtime/intent", { ...input, intent });
      expect(accepted.status).toBe(202);
      const { request_id } = await accepted.json() as { request_id: string };
      const returnCompute = await waitFor(() => completeCompute ?? null, gateway, "the D4 job did not reach the loopback provider");
      expect(await (await post("/runtime/intent/status", input)).json()).toMatchObject({ found: true, request_id,
        execution_observation: { status: "active", ...flags }, task_outcome: { status: "unknown", ...flags },
        result: { status: "not_ready", ...flags } });
      const conflict = await post("/runtime/intent", { ...otherInput, intent });
      expect(conflict.status).toBe(409);
      expect(JSON.stringify(await conflict.json())).not.toContain(request_id);
      expect(await (await post("/runtime/intent/status", otherInput)).json()).toEqual({ found: false });
      expect(providerRequests).toBe(1);
      returnCompute();
      const completed = await waitFor(async () => {
        const response = await post("/runtime/intent/status", input);
        if (response.status === 429) return null;
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const payload = await response.json() as { state: string; execution_observation?: { status: string };
          result?: { status: string } };
        return payload.state === "handler_returned" && payload.execution_observation?.status === "adapter_returned" &&
          payload.result?.status === "available" ? payload : null;
      }, gateway, "the final D4 reply and execution observation were not linked to the same request");
      expect(completed).toMatchObject({ found: true, request_id,
        task_outcome: { status: "unknown", ...flags }, result: { content: expect.stringContaining(privateResult), ...flags } });
      expect(completed.execution_observation).toEqual(execution);
      await waitFor(() => frames.some(frame => frame.includes(privateResult)) ? true : null, gateway,
        "the owning D4 response session did not receive the reply");
      expect(otherFrames.join("")).not.toContain(privateResult);
      const failed = await post("/runtime/intent", { ...failedInput, intent: failedIntent });
      expect(failed.status).toBe(202);
      const { request_id: failedRequestId } = await failed.json() as { request_id: string };
      await waitFor(() => frames.some(frame => {
        const event = JSON.parse(frame) as WebSocketFrame;
        return event.kind === "error" && event.request_id === failedRequestId;
      }) ? true : null, gateway, "the D4 submission did not receive a scoped failure notice");
      const failedStatus = await post("/runtime/intent/status", failedInput);
      expect(failedStatus.status).toBe(200);
      expect(await failedStatus.json()).toMatchObject({ found: true, request_id: failedRequestId, state: "outcome_unknown",
        execution_observation: { status: "unknown", ...flags }, result: { status: "unavailable", ...flags } });
      expect(frames.concat(otherFrames).join("")).not.toContain(privateException);
      expect(otherFrames.join("")).not.toContain(failedRequestId);
      await waitFor(() => gateway?.stderr.join("").includes("details redacted") ? true : null, gateway,
        "the D4 handler failure diagnostic was not redacted");
      expect(gateway.stdout.concat(gateway.stderr).join("")).not.toContain(privateException);
      disconnectSessions();
      await stopChild(gateway);
      frames.length = 0;
      otherFrames.length = 0;
      // Disable file-backed conversation sessions in this fixture. Durable receipt stores retain evidence without a private reply.
      expect(readTreeBytes(root).includes(Buffer.from(privateResult, "utf8"))).toBe(false);
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const restored = await post("/runtime/intent/status", input);
      expect(restored.status).toBe(200);
      const restoredStatus = await restored.json() as { execution_observation?: unknown; result?: unknown };
      expect(restoredStatus).toMatchObject({ found: true, request_id, state: "handler_returned",
        task_outcome: { status: "unknown", ...flags }, result: { status: "unavailable", reason_code: "not_retained", ...flags } });
      expect(restoredStatus.execution_observation).toEqual(execution);
      expect(JSON.stringify(restoredStatus)).not.toContain(privateResult);
      expect(await (await post("/runtime/intent/status", failedInput)).json()).toMatchObject({ found: true,
        request_id: failedRequestId, state: "outcome_unknown", result: { status: "unavailable", ...flags } });
      await connectSession(input.session_id, frames);
      await connectSession(otherInput.session_id, otherFrames);
      const sameScope = await post("/runtime/intent", { ...input, intent });
      expect(await sameScope.json()).toMatchObject({ accepted: true, duplicate: true, request_id });
      const failedDuplicate = await post("/runtime/intent", { ...failedInput, intent: failedIntent });
      expect(failedDuplicate.status).toBe(202);
      expect(await failedDuplicate.json()).toMatchObject({ accepted: true, duplicate: true, request_id: failedRequestId, state: "outcome_unknown" });
      const otherScope = await post("/runtime/intent", { ...otherInput, intent });
      expect(otherScope.status).toBe(409);
      expect(JSON.stringify(await otherScope.json())).not.toContain(request_id);
      expect(await (await post("/runtime/intent/status", otherInput)).json()).toEqual({ found: false });
      expect(providerRequests).toBe(1);
      expect(frames.concat(otherFrames).join("")).not.toContain(privateResult);
    } finally {
      for (const sessionSocket of sockets) sessionSocket.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);

  it("cancels an authenticated D4 submission before HDS dispatch and preserves its receipt after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-d4-runtime-before-dispatch-"));
    const runtime = "blue_tanuki";
    const token = "synthetic-d4-before-dispatch-token";
    const resumeToken = "synthetic-d4-before-dispatch-resume";
    const input = { runtime_id: runtime, session_id: "synthetic-held-runtime-session",
      submission_id: "817ba185-1ffa-474c-868c-853976a20ebf" };
    const intent = "SYNTHETIC_HELD_RUNTIME_INTENT: 色の名前をひとつ提案してください。";
    const markers = { reached: join(root, "held"), release: join(root, "release"),
      finished: join(root, "finished"), decided: join(root, "decided") };
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      providerRequests += 1;
      request.resume();
      response.writeHead(500).end();
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    const frames: string[] = [];
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const envFile = join(root, "fixture.env");
      writeFileSync(envFile, "# isolated test configuration\n", "utf8");
      mkdirSync(join(root, "files"));
      const preload = join(root, "hold-d4-handler.mjs");
      const webchatModule = pathToFileURL(join(ROOT, "packages/channel-webchat/dist/index.js")).href;
      const hdsModule = pathToFileURL(join(ROOT, "packages/hds-brain/dist/index.js")).href;
      writeFileSync(preload, `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { WebChatChannel } from ${JSON.stringify(webchatModule)};
import { HDSUpperController } from ${JSON.stringify(hdsModule)};
const intent = ${JSON.stringify(intent)};
const markers = ${JSON.stringify(markers)};
const start = WebChatChannel.prototype.start;
WebChatChannel.prototype.start = function (handler) {
  return start.call(this, async (request, context) => {
    if (request.content !== intent) return handler(request, context);
    writeFileSync(markers.reached, request.id, { flag: "wx" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(markers.release) && Date.now() < deadline) await setTimeout(20);
    if (!existsSync(markers.release)) throw new Error("synthetic handler gate expired");
    await handler(request, context);
    writeFileSync(markers.finished, request.id, { flag: "wx" });
  });
};
const decide = HDSUpperController.prototype.decide;
HDSUpperController.prototype.decide = function (request, options) {
  if (request.content === intent) writeFileSync(markers.decided, request.id);
  return decide.call(this, request, options);
};
`, "utf8");
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: resumeToken,
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-d4-before-dispatch-maintenance",
        BLUE_TANUKI_D4_RUNTIME_ID: runtime, BLUE_TANUKI_D4_RUNTIME_TOKEN: token,
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: join(root, "files"), BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl"),
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "d4-held-fixture": {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: "d4-held-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "d4-held-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: "d4-held-fixture", aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      const post = (route: string, body: object, authorization = token) => fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      gateway = spawnGateway(env, preload);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const ticketResponse = await post("/runtime/ws-ticket", { runtime_id: runtime, session_id: input.session_id });
      expect(ticketResponse.status).toBe(200);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticket)}`);
      socket.on("message", data => frames.push(String(data)));
      await once(socket, "open");

      const submitted = await post("/runtime/intent", { ...input, intent });
      expect(submitted.status).toBe(202);
      const receipt = await submitted.json() as { request_id: string };
      expect(receipt).toMatchObject({ accepted: true, duplicate: false, state: "dispatching" });
      await waitFor(() => readCaptureText(markers.reached) === receipt.request_id ? true : null, gateway,
        "the authenticated submission did not reach the held Gateway handler");
      expect((await post("/runtime/intent/cancel", input, WEBCHAT_TOKEN)).status).toBe(401);
      const foreign = await post("/runtime/intent/cancel", { ...input, session_id: "unrelated-d4-session" });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ found: false });
      expect(await (await post("/runtime/intent/status", input)).json()).toMatchObject({
        found: true, request_id: receipt.request_id, state: "dispatching", cancellation: { status: "unknown" },
      });
      const cancelled = await post("/runtime/intent/cancel", input);
      expect(cancelled.status).toBe(202);
      expect(cancelled.headers.get("cache-control")).toBe("no-store");
      const acknowledgement = await cancelled.json() as { cancellation: Record<string, unknown> };
      expect(acknowledgement).toEqual({ found: true, accepted: true, cancellation: {
        status: "cancelled_before_dispatch", cancel_request_accepted: true, executor_started: false,
        external_processing_stop: "unknown", cancel_requested_at_ms: expect.any(Number),
        used_for_authority: false, may_execute: false,
      } });
      writeFileSync(markers.release, "release", { flag: "wx" });
      await waitFor(() => readCaptureText(markers.finished) === receipt.request_id ? true : null, gateway,
        "the held work did not return from the actual Gateway handler after release");
      expect(readCaptureText(markers.decided)).toBeUndefined();
      const approvals = await fetch(`http://127.0.0.1:${gatewayPort}/approval`, {
        headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(8_000),
      });
      expect(approvals.status).toBe(200);
      expect(await approvals.json()).toMatchObject({ pending_approvals: [] });

      const expectCancelled = async () => {
        const status = await post("/runtime/intent/status", input);
        expect(status.status).toBe(200);
        expect(status.headers.get("cache-control")).toBe("no-store");
        const observed = await status.json();
        expect(observed).toMatchObject({ found: true, request_id: receipt.request_id, state: "rejected",
          cancellation: acknowledgement.cancellation,
          result: { status: "unavailable", used_for_authority: false, may_execute: false } });
        expect(JSON.stringify(observed)).not.toContain(intent);
        expect(JSON.stringify(observed)).not.toContain(token);
      };
      const expectNoReplay = async () => {
        const duplicate = await post("/runtime/intent", { ...input, intent });
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toMatchObject({ accepted: false, request_id: receipt.request_id, state: "rejected" });
      };
      await expectCancelled();
      await expectNoReplay();
      expect(providerRequests).toBe(0);
      expect(frames.join("")).not.toContain(intent);
      expect(frames.join("")).not.toContain(token);

      socket.terminate();
      socket = undefined;
      await stopChild(gateway);
      const capturedLogs = gateway.stdout.concat(gateway.stderr).join("");
      expect(capturedLogs).not.toContain(intent);
      expect(capturedLogs).not.toContain(token);
      expect(capturedLogs).not.toContain("[webchat] D4 Runtime intent handler error");
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      await expectCancelled();
      const repeated = await post("/runtime/intent/cancel", input);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(acknowledgement);
      await expectNoReplay();
      expect(providerRequests).toBe(0);
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);

  it("withdraws the scoped D4 approval while its token is being issued", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-d4-runtime-approval-issuance-"));
    const token = "synthetic-d4-issuance-runtime-token-only";
    const resumeToken = "synthetic-d4-issuance-resume-token";
    const input = { runtime_id: "blue_tanuki", session_id: "synthetic-runtime-approval-issuance",
      submission_id: "c724b78e-05a6-4e54-b0e6-c2258c1d7f8e" };
    const intent = "合成試験の承認処理として、青い花の題名を提案してください。";
    const suspendedIntent = "合成試験の保留として、緑の花の題名を提案してください。";
    const markers = { reached: join(root, "issuance-held"), release: join(root, "release"),
      finished: join(root, "handler-finished"), discarded: join(root, "discarded"), executed: join(root, "executed"),
      suspended: join(root, "suspended-handler-finished"), suspendedIssue: join(root, "suspended-issue-attempted") };
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      providerRequests += 1;
      request.resume();
      response.writeHead(500).end();
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    const frames: string[] = [];
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const envFile = join(root, "fixture.env");
      writeFileSync(envFile, "# isolated test configuration\n", "utf8");
      mkdirSync(join(root, "files"));
      const preload = join(root, "hold-d4-approval-issuance.mjs");
      const webchatModule = pathToFileURL(join(ROOT, "packages/channel-webchat/dist/index.js")).href;
      const coreModule = pathToFileURL(join(ROOT, "packages/blue-tanuki/dist/index.js")).href;
      const hdsModule = pathToFileURL(join(ROOT, "packages/hds-brain/dist/index.js")).href;
      writeFileSync(preload, `
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { MemoryResumeApprovalTokenStore, WebChatChannel } from ${JSON.stringify(webchatModule)};
import { Executor } from ${JSON.stringify(coreModule)};
import { HDSUpperController } from ${JSON.stringify(hdsModule)};
const intent = ${JSON.stringify(intent)};
const suspendedIntent = ${JSON.stringify(suspendedIntent)};
const markers = ${JSON.stringify(markers)};
const scope = new AsyncLocalStorage();
let heldCommandId;
let heldToken;
const start = WebChatChannel.prototype.start;
WebChatChannel.prototype.start = function (handler) {
  return start.call(this, (request, context) => {
    const suspended = request.content === suspendedIntent;
    if (request.content !== intent && !suspended) return handler(request, context);
    return scope.run({ requestId: request.id, suspended }, async () => {
      await handler(request, context);
      writeFileSync(suspended ? markers.suspended : markers.finished, request.id, { flag: "wx" });
    });
  });
};
const selfHealth = HDSUpperController.prototype.evaluateSelfHealth;
HDSUpperController.prototype.evaluateSelfHealth = function (...args) {
  const health = selfHealth.apply(this, args);
  return scope.getStore()?.suspended ? { ...health, status: "fail_safe", hds_available: false, fail_safe: true,
    fail_safe_reason: "hds_fail_safe:fixture", failed_preconditions: ["hds_available"], command_execution_allowed: false,
    downstream_execution_allowed: false } : health;
};
const issue = WebChatChannel.prototype.issueResumeApprovalToken;
WebChatChannel.prototype.issueResumeApprovalToken = async function (commandId, ttl) {
  const scoped = scope.getStore();
  if (scoped?.suspended) writeFileSync(markers.suspendedIssue, scoped.requestId);
  const issued = await issue.call(this, commandId, ttl);
  if (!scoped || scoped.suspended) return issued;
  if (!issued?.token) throw new Error("synthetic approval issuance did not return a token");
  heldCommandId = commandId;
  heldToken = issued.token;
  writeFileSync(markers.reached, JSON.stringify({ requestId: scoped.requestId, commandId }) + "\\n", { flag: "wx" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(markers.release) && Date.now() < deadline) await setTimeout(20);
  if (!existsSync(markers.release)) throw new Error("synthetic approval issuance hold expired");
  return issued;
};
const consume = MemoryResumeApprovalTokenStore.prototype.consume;
MemoryResumeApprovalTokenStore.prototype.consume = async function (requestId, token) {
  const consumed = await consume.call(this, requestId, token);
  if (consumed && requestId === heldCommandId && token === heldToken) {
    writeFileSync(markers.discarded, requestId, { flag: "wx" });
  }
  return consumed;
};
const execute = Executor.prototype.execute;
Executor.prototype.execute = function (command, context) {
  if (command.id === heldCommandId) writeFileSync(markers.executed, command.id);
  return execute.call(this, command, context);
};
`, "utf8");
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: resumeToken, BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-d4-issuance-maintenance",
        BLUE_TANUKI_D4_RUNTIME_ID: input.runtime_id, BLUE_TANUKI_D4_RUNTIME_TOKEN: token,
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: join(root, "files"), BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"),
        BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl"),
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_BACKEND_HINT: "d4-issuance-fixture",
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "d4-issuance-fixture": {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: "d4-issuance-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "d4-issuance-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: "d4-issuance-fixture", aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      seedD4ApprovalFixture(env, token, input.runtime_id, input.session_id, intent);
      gateway = spawnGateway(env, preload);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const post = (route: string, body: object, authorization = token) => fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      const ticketResponse = await post("/runtime/ws-ticket", { runtime_id: input.runtime_id, session_id: input.session_id });
      expect(ticketResponse.status).toBe(200);
      const { ticket } = await ticketResponse.json() as { ticket: string };
      socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticket)}`);
      socket.on("message", data => frames.push(String(data)));
      await once(socket, "open");
      const submitted = await post("/runtime/intent", { ...input, intent });
      expect(submitted.status).toBe(202);
      const receipt = await submitted.json() as { request_id: string };
      const held = await waitFor(() => {
        const raw = readCaptureText(markers.reached);
        return raw?.endsWith("\n") ? JSON.parse(raw) as { requestId: string; commandId: string } : null;
      }, gateway, "the scoped D4 work did not reach genuine approval token issuance");
      expect(held.requestId).toBe(receipt.request_id);
      const listApprovals = async () => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/approval`, {
          headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(8_000),
        });
        expect(response.status).toBe(200);
        return (await response.json() as { pending_approvals: { command_id: string }[] }).pending_approvals;
      };
      expect(await listApprovals()).not.toContainEqual(expect.objectContaining({ command_id: held.commandId }));
      expect((await post("/runtime/intent/cancel", input, WEBCHAT_TOKEN)).status).toBe(401);
      expect((await post("/runtime/intent/cancel", { ...input, session_id: "unrelated-d4-session" })).status).toBe(404);
      const response = await post("/runtime/intent/cancel", input);
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const withdrawn = await response.json() as { cancellation: Record<string, unknown> };
      expect(withdrawn).toEqual({ found: true, accepted: true, cancellation: {
        status: "approval_withdrawn", cancel_request_accepted: true, executor_started: false,
        external_processing_stop: "unknown", cancel_requested_at_ms: expect.any(Number),
        used_for_authority: false, may_execute: false,
      } });
      writeFileSync(markers.release, "release", { flag: "wx" });
      await waitFor(() => readCaptureText(markers.finished) === receipt.request_id ? true : null, gateway,
        "the cancelled D4 handler did not finish after token issuance returned");
      expect(readCaptureText(markers.discarded)).toBe(held.commandId);
      expect(readCaptureText(markers.executed)).toBeUndefined();
      expect(await listApprovals()).not.toContainEqual(expect.objectContaining({ command_id: held.commandId }));
      const staleApproval = await post(`/approval/${encodeURIComponent(held.commandId)}`, {
        verdict: "approve", approval_token: "synthetic-stale-approval-input",
      }, resumeToken);
      expect(staleApproval.status).toBe(409);
      expect(await staleApproval.json()).toEqual({ error: "approval_content_review_stale" });
      expect(providerRequests).toBe(0);
      expect(frames.join("")).not.toContain("承認待ちです。");
      expect(frames.join("")).not.toContain(held.commandId);
      const expectWithdrawn = async () => {
        const status = await post("/runtime/intent/status", input);
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ found: true, request_id: receipt.request_id, cancellation: withdrawn.cancellation });
      };
      await expectWithdrawn();

      const paused = await post("/runtime/intent", { ...input, submission_id: "31a3c5ba-1287-4f18-8c43-282c9cd9bf25",
        intent: suspendedIntent });
      expect(paused.status).toBe(202);
      const pausedReceipt = await paused.json() as { request_id: string };
      await waitFor(() => readCaptureText(markers.suspended) === pausedReceipt.request_id &&
        frames.some(frame => (JSON.parse(frame) as WebSocketFrame).content ===
          "この依頼は保留されています。状態は認証済みの画面で確認してください。") ? true : null,
      gateway, "the no-command D4 suspension did not return its generic notice");
      expect(readCaptureText(markers.suspendedIssue)).toBeUndefined();
      expect(providerRequests).toBe(0);

      socket.terminate();
      socket = undefined;
      await stopChild(gateway);
      expect(gateway.stdout.concat(gateway.stderr).join("")).not.toContain("[webchat] D4 Runtime intent handler error");
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      await expectWithdrawn();
      const repeated = await post("/runtime/intent/cancel", input);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(withdrawn);
      expect(providerRequests).toBe(0);
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 90_000);

  it("資料整理の第2周期を対応するD4受付から取り消し、Jのチェックポイントを保持する", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-d4-organize-cancel-"));
    const token = "synthetic-d4-organize-cancellation-token";
    const backend = "d4-organize-cancel-fixture";
    const scope = { runtime_id: "blue_tanuki", session_id: "synthetic-d4-organize-cancellation" };
    const input = { ...scope, submission_id: "96147c5d-73e6-4cd7-b4fd-c834c5439057" };
    const newInput = { ...scope, submission_id: "e12dfc04-266d-49b7-b110-e490c3df75aa" };
    const firstExcerpt = "決定事項:青";
    const secondExcerpt = "未確認:期限";
    const source = `${firstExcerpt}\n${secondExcerpt}`;
    const intent = `/organize ${source}`;
    const firstSpan = { start: 0, end: firstExcerpt.length };
    const secondSpan = { start: firstExcerpt.length + 1, end: source.length };
    const firstSection = { label: "決定事項", excerpts: [{ ...firstSpan, quote: firstExcerpt }] };
    const secondSection = { label: "未確認事項", excerpts: [{ ...secondSpan, quote: secondExcerpt }] };
    const flags = { used_for_authority: false, may_execute: false };
    let providerRequests = 0;
    let secondCycleDisconnected = false;
    const provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once("end", () => {
        providerRequests += 1;
        if (providerRequests === 2) {
          response.once("close", () => { secondCycleDisconnected = !response.writableFinished; });
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"choices":');
          return;
        }
        const sections = providerRequests === 1 ? [firstSection] : [firstSection, secondSection];
        const content = JSON.stringify({
          schema_version: "blue-tanuki.memory-citation-response.v1", citations: [],
          answer: JSON.stringify({ schema_version: "blue-tanuki.document-organization.candidate.v1", sections }),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: backend, object: "chat.completion", created: 1, model: backend,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    const frames: WebSocketFrame[] = [];
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      const envFile = join(root, "fixture.env");
      const fileRoot = join(root, "files");
      const memoryFile = join(root, "memory.jsonl");
      writeFileSync(envFile, "# 隔離した試験設定\n", "utf8");
      mkdirSync(fileRoot);
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: "synthetic-d4-organize-cancellation-resume",
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-d4-organize-cancellation-maintenance",
        BLUE_TANUKI_D4_RUNTIME_ID: scope.runtime_id, BLUE_TANUKI_D4_RUNTIME_TOKEN: token,
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: fileRoot, BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: memoryFile, BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"),
        BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl"),
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_BACKEND_HINT: backend,
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ [backend]: {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: backend, LLM_PROVIDERS_JSON: JSON.stringify([{
          name: backend, type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: backend, aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      const post = (route: string, body: object, authorization = token) => fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      const connect = async (): Promise<WebSocket> => {
        const ticket = await post("/runtime/ws-ticket", scope);
        expect(ticket.status).toBe(200);
        const { ticket: ticketValue } = await ticket.json() as { ticket: string };
        const connected = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticketValue)}`);
        socket = connected;
        connected.on("message", data => frames.push(JSON.parse(String(data)) as WebSocketFrame));
        await once(connected, "open");
        return connected;
      };

      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      expect(statSync(memoryFile, { throwIfNoEntry: false })).toBeUndefined();
      socket = await connect();
      const accepted = await post("/runtime/intent", { ...input, intent });
      expect(accepted.status).toBe(202);
      const { request_id: requestId } = await accepted.json() as { request_id: string };
      await waitFor(() => providerRequests === 2 ? true : null, gateway, () =>
        `資料整理の第2周期が計算先に届かなかった。providerRequests=${providerRequests} frames=${JSON.stringify(frames)}`);

      expect((await post("/runtime/intent/cancel", input, WEBCHAT_TOKEN)).status).toBe(401);
      expect((await post("/runtime/intent/cancel", { ...input, runtime_id: "other_runtime" })).status).toBe(403);
      expect((await post("/runtime/intent/cancel", { ...input, session_id: "other-d4-session" })).status).toBe(404);
      expect(secondCycleDisconnected).toBe(false);
      const cancellation = await post("/runtime/intent/cancel", input);
      expect(cancellation.status, await cancellation.clone().text()).toBe(202);
      expect(await cancellation.json()).toMatchObject({ found: true, accepted: true, cancellation: {
        status: "cancel_requested", cancel_request_accepted: true, execution_signal_aborted: true,
        executor_settled: false, external_processing_stop: "unknown", ...flags,
      } });
      await waitFor(() => secondCycleDisconnected ? true : null, gateway, "実行中の計算接続が中断されなかった");
      const settled = await waitFor(async () => {
        const response = await post("/runtime/intent/status", input);
        if (response.status === 429) return null;
        expect(response.status).toBe(200);
        const status = await response.json() as { state: string; cancellation?: { status: string } };
        return status.state === "handler_returned" && status.cancellation?.status === "execution_observed" ? status : null;
      }, gateway, "受付の状態に実行終了を伴う取消が記録されなかった");
      expect(settled).toMatchObject({ found: true, request_id: requestId, cancellation: {
        cancel_request_accepted: true, executor_settled: true, external_processing_stop: "unknown", ...flags,
      }, result: { status: "unavailable", ...flags } });
      expect(providerRequests).toBe(2);
      expect(frames.filter(frame => frame.kind === "channel_send")).toEqual([]);

      socket?.terminate();
      socket = undefined;
      await stopChild(gateway);
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      socket = await connect();
      const afterRestart = await post("/runtime/intent/status", input);
      expect(afterRestart.status).toBe(200);
      expect(await afterRestart.json()).toMatchObject({ found: true, request_id: requestId,
        cancellation: settled.cancellation, result: { status: "unavailable", ...flags },
      });
      const replay = await post("/runtime/intent", { ...input, intent });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ accepted: true, duplicate: true, request_id: requestId });
      expect(providerRequests).toBe(2);

      const fresh = await post("/runtime/intent", { ...newInput, intent });
      expect(fresh.status).toBe(202);
      const { request_id: newRequestId } = await fresh.json() as { request_id: string };
      expect(newRequestId).not.toBe(requestId);
      const freshReply = await waitFor(() => frames.find(frame => frame.kind === "channel_send" &&
        frame.request_id === newRequestId) ?? null, gateway, "同じ原文を持つ別の受付が独立して完了しなかった");
      expect(freshReply.content).toContain(firstExcerpt);
      expect(freshReply.content).toContain(secondExcerpt);
      expect(providerRequests).toBe(3);
      expect(frames.filter(frame => frame.kind === "channel_send")).toEqual([freshReply]);

      socket?.terminate();
      socket = undefined;
      await stopChild(gateway);
      gateway = undefined;
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const database = new DatabaseSync(join(fileRoot, "document-organization", "j-checkpoints.sqlite"), { readOnly: true });
      try {
        const rows = database.prepare("SELECT checkpoint_json FROM document_organization_checkpoints").all();
        const checkpoints = rows.map(row => JSON.parse(String(row.checkpoint_json)) as { request_id: string });
        expect(checkpoints).toHaveLength(2);
        expect(checkpoints.find(checkpoint => checkpoint.request_id === requestId)).toMatchObject({
          status: "held", terminal_reason: "task_cancelled", completed_cycles: 1, accepted_spans: [firstSpan],
        });
        expect(checkpoints.find(checkpoint => checkpoint.request_id === newRequestId)).toMatchObject({
          status: "completed", completed_cycles: 1, accepted_spans: [firstSpan, secondSpan],
        });
      } finally {
        database.close();
      }
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);

  it("interrupts scoped compute and withdraws pending approval, retaining both observations after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "bt-d4-runtime-cancel-"));
    const token = "synthetic-d4-runtime-cancellation-token-only";
    const runtime = "blue_tanuki";
    const session = "synthetic-runtime-cancel-session";
    const submission = "e5348667-4150-49c6-b011-2b2942090f1a";
    const pendingSubmission = "7daa81fa-c471-4d40-848e-0baa689272c7";
    const pendingIntent = "合成試験で青と緑を使う題名を提案してください。";
    const resumeToken = "synthetic-d4-runtime-tests-resume";
    let providerRequests = 0;
    let disconnected = false;
    const providerPaths: string[] = [];
    const frames: string[] = [];
    const provider = createServer((request, response) => {
      providerPaths.push(request.url ?? "");
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      response.once("close", () => { disconnected = !response.writableFinished; });
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"choices":');
        providerRequests += 1;
      });
    });
    let gateway: CapturedProcess | undefined;
    let socket: WebSocket | undefined;
    try {
      const providerPort = await listen(provider);
      const gatewayPort = await reservePort();
      mkdirSync(join(root, "files"));
      const envFile = join(root, "fixture.env");
      writeFileSync(envFile, "# isolated test configuration\n", "utf8");
      const env = {
        ...fixtureOsEnvironment(),
        WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort), WEBCHAT_TOKEN,
        WEBCHAT_RESUME_TOKEN: resumeToken,
        BLUE_TANUKI_MAINTENANCE_TOKEN: "synthetic-d4-runtime-tests-maintenance",
        BLUE_TANUKI_D4_RUNTIME_ID: runtime, BLUE_TANUKI_D4_RUNTIME_TOKEN: token,
        BLUE_TANUKI_STATE_ROOT: join(root, "state"), BLUE_TANUKI_AUDIT_DIR: join(root, "audit"), BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: join(root, "files"), BLUE_TANUKI_LOG_DIR: join(root, "logs"),
        BLUE_TANUKI_RECOVERY_DIR: join(root, "recovery"), BLUE_TANUKI_APPROVALS_FILE: join(root, "approvals.json"),
        BLUE_TANUKI_MEMORY_FILE: join(root, "memory.jsonl"), BLUE_TANUKI_SESSION_DIR: join(root, "sessions"),
        BLUE_TANUKI_FAILURE_MEMORY_FILE: join(root, "failure-memory.json"),
        BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(root, "history.jsonl"),
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
        BLUE_TANUKI_LLM_BACKEND_HINT: "d4-cancel-fixture",
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({ "d4-cancel-fixture": {
          capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" },
        } }),
        LLM_BACKEND: "d4-cancel-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
          name: "d4-cancel-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
          model: "d4-cancel-fixture", aliases: [], headers: {}, timeout_ms: 20_000,
        }]),
      };
      seedD4ApprovalFixture(env, token, runtime, session, pendingIntent);
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const post = (route: string, body: object, authorization = token) => fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      const input = { runtime_id: runtime, session_id: session, submission_id: submission };
      const ticket = await post("/runtime/ws-ticket", { runtime_id: runtime, session_id: session });
      expect(ticket.status).toBe(200);
      const { ticket: ticketValue } = await ticket.json() as { ticket: string };
      socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticketValue)}`);
      socket.on("message", (data) => frames.push(String(data)));
      await once(socket, "open");
      const pendingInput = { ...input, submission_id: pendingSubmission };
      const pendingResponse = await post("/runtime/intent", { ...pendingInput, intent: pendingIntent });
      expect(pendingResponse.status).toBe(202);
      const pendingRequest = await pendingResponse.json() as { request_id: string };
      const loadPending = async () => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/approval`, {
          headers: { authorization: `Bearer ${resumeToken}` }, signal: AbortSignal.timeout(8_000),
        });
        expect(response.status).toBe(200);
        const queue = await response.json() as { pending_approvals: {
          request_id: string; command_id: string; approval_token?: string;
        }[] };
        return queue.pending_approvals.find(item => item.request_id === pendingRequest.request_id) ?? null;
      };
      const pending = await waitFor(loadPending, gateway, "the exact D4 request did not reach genuine approval wait");
      expect(pending.approval_token).toEqual(expect.any(String));
      const pendingStatus = await post("/runtime/intent/status", pendingInput);
      expect(pendingStatus.status).toBe(200);
      expect(await pendingStatus.json()).toMatchObject({ found: true, request_id: pendingRequest.request_id,
        execution_observation: { status: "awaiting_approval", used_for_authority: false, may_execute: false },
        task_outcome: { status: "unknown", used_for_authority: false, may_execute: false } });
      await waitFor(() => frames.some(frame => frame.includes("承認待ちです。")) ? true : null, gateway,
        "the D4 session did not receive the approval waiting notice");
      expect(frames.join("")).not.toContain(pending.approval_token);
      expect(frames.join("")).not.toContain(pending.command_id);
      expect((await post("/runtime/intent/cancel", { ...pendingInput, session_id: "unrelated-d4-session" })).status).toBe(404);
      expect((await loadPending())?.command_id).toBe(pending.command_id);
      const pendingCancel = await post("/runtime/intent/cancel", pendingInput);
      expect(pendingCancel.status).toBe(202);
      const withdrawn = await pendingCancel.json() as { cancellation: Record<string, unknown> };
      expect(withdrawn).toMatchObject({ found: true, accepted: true, cancellation: {
        status: "approval_withdrawn", cancel_request_accepted: true, executor_started: false,
        external_processing_stop: "unknown", used_for_authority: false, may_execute: false,
      } });
      expect(await loadPending()).toBeNull();
      const staleApprove = await post(`/approval/${encodeURIComponent(pending.command_id)}`, {
        verdict: "approve", approval_token: pending.approval_token,
      }, resumeToken);
      expect(staleApprove.status).toBe(409);
      expect(await staleApprove.json()).toEqual({ error: "approval_content_review_stale" });
      expect(providerRequests).toBe(0);

      const submitted = await post("/runtime/intent", { ...input, intent: "合成テストで短い文章を要約してください。" });
      expect(submitted.status, await submitted.text()).toBe(202);
      await waitFor(() => providerRequests === 1 ? true : null, gateway, () =>
        `the exact D4 intent did not reach compute; paths=${JSON.stringify(providerPaths)}` +
        ` frames=${JSON.stringify(frames)} stdout=${gateway?.stdout.join("") ?? ""}`);
      const wrongToken = await post("/runtime/intent/cancel", input, WEBCHAT_TOKEN);
      expect(wrongToken.status).toBe(401);
      const wrongSession = await post("/runtime/intent/cancel", { ...input, session_id: "unrelated-d4-session" });
      expect(wrongSession.status).toBe(404);
      expect(disconnected).toBe(false);
      const before = await post("/runtime/intent/status", input);
      expect(await before.json()).toMatchObject({ found: true, cancellation: { status: "unknown", may_execute: false } });
      const cancelled = await post("/runtime/intent/cancel", input);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ found: true, accepted: true, cancellation: {
        status: "cancel_requested", cancel_request_accepted: true, executor_settled: false,
        execution_signal_aborted: true, executor_state: "cancel_requested", local_worker_stop: "not_observed",
        external_processing_stop: "unknown", used_for_authority: false, may_execute: false,
      } });
      await waitFor(() => disconnected ? true : null, gateway, "compute connection did not receive the abort");
      expect(providerRequests).toBe(1);
      const observed = await waitFor(async () => {
        const status = await post("/runtime/intent/status", input);
        expect(status.status).toBe(200);
        const payload = await status.json() as { found: boolean; cancellation?: { status: string }; execution_observation?: unknown };
        return payload.cancellation?.status === "execution_observed" ? payload : null;
      }, gateway, "the cancellation observation was not projected");
      expect(observed).toMatchObject({ found: true, cancellation: {
        status: "execution_observed", cancel_request_accepted: true, executor_settled: true,
        external_processing_stop: "unknown", used_for_authority: false, may_execute: false,
      }, execution_observation: { status: "outcome_unknown", used_for_authority: false, may_execute: false } });

      socket.terminate();
      socket = undefined;
      await stopChild(gateway);
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway, 40_000);
      const after = await post("/runtime/intent/status", input);
      expect(after.status).toBe(200);
      expect(await after.json()).toMatchObject({ found: true, cancellation: observed.cancellation,
        execution_observation: observed.execution_observation });
      expect(await (await post("/runtime/intent/status", pendingInput)).json()).toMatchObject({
        found: true, cancellation: withdrawn.cancellation,
      });
      const repeatedWithdrawal = await post("/runtime/intent/cancel", pendingInput);
      expect(repeatedWithdrawal.status).toBe(202);
      expect(await repeatedWithdrawal.json()).toEqual(withdrawn);
      const otherAfter = await post("/runtime/intent/status", { ...input, session_id: "unrelated-d4-session" });
      expect(otherAfter.status).toBe(200);
      expect(await otherAfter.json()).toEqual({ found: false });
      const duplicate = await post("/runtime/intent", { ...input, intent: "合成テストで短い文章を要約してください。" });
      expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
      expect(providerRequests).toBe(1);
    } finally {
      socket?.terminate();
      if (gateway) await stopChild(gateway);
      provider.closeAllConnections();
      await closeServer(provider);
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    }
  }, 120_000);
});

function seedD4ApprovalFixture(env: NodeJS.ProcessEnv & { BLUE_TANUKI_FAILURE_MEMORY_FILE: string },
  token: string, runtime: string, session: string, intent: string): void {
  const actor = "d4-runtime-adapter-token-holder";
  const ref = (kind: "runtime" | "session", value: string) =>
    createHmac("sha256", token).update(`blue-tanuki.d4-runtime.${kind}.v1\0`).update(value).digest("hex");
  const sessionRef = ref("session", session);
  const sessionTarget = `d4-runtime:${sessionRef}`;
  const seedRequest = createGatewayInternalInboundRequest({
    id: "da37e92e-3358-4bdc-9a36-959263871b20", user: actor, channel: "webchat",
    content: intent, timestamp: Date.now(), session_id: sessionTarget,
    metadata: {
      reply_to: sessionTarget, "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.actor_kind": "user", "blue_tanuki.trust_level": "limited", "blue_tanuki.process_kind": "chat",
      "blue_tanuki.runtime_ingress.version": "d4-runtime-intent.v1",
      "blue_tanuki.runtime_ingress.runtime_id_digest": ref("runtime", runtime),
      "blue_tanuki.runtime_ingress.session_id_digest": sessionRef,
      "blue_tanuki.runtime_ingress.used_for_authority": false,
    },
  });
  const seedCommand = new HDSUpperController({ llm_route: buildLLMCommandRouteFromEnv(env) }).decide(seedRequest).command;
  if (!seedCommand || seedCommand.type !== "llm_call") throw new Error("the pending fixture did not produce a compute decision");
  const context = { actor, channel: "webchat", origin_user: actor };
  const candidate = candidateFromCommand(seedCommand, context);
  const failureMemory = new FailureMemoryStore({ filepath: env.BLUE_TANUKI_FAILURE_MEMORY_FILE });
  failureMemory.addSignature({
    scope: candidate.scope, failure_type: "logic_drift", input_pattern: candidate.input_pattern,
    action_pattern: candidate.action_pattern, context_pattern: candidate.context_pattern,
    state: "active", suppression_policy: "require_approval", match_level: 1,
  });
  expect(failureMemory.evaluateCommandGate(seedCommand, context).decision).toBe("require_approval");
}

function seedTelegramWait(stateRoot: string, historyFile: string, fileRoot: string): {
  readonly waitId: string;
  readonly planIdDigest: string;
  readonly taskIdentityDigest: string;
} {
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
  return { waitId, planIdDigest, taskIdentityDigest };
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

function readTelegramInboxCursor(stateRoot: string) {
  return readTelegramDatabaseRows(stateRoot, "SELECT update_id, payload_digest, delivery_state FROM telegram_update_cursor");
}

function readTelegramOutboundDeliveries(stateRoot: string) {
  return readTelegramDatabaseRows(stateRoot, "SELECT delivery_digest, delivery_state, updated_at_ms FROM telegram_outbound_delivery");
}

function readTelegramDatabaseRows(stateRoot: string, query: string) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(join(stateRoot, "private-state", "telegram-inbox", "telegram-inbox.sqlite"),
    { readOnly: true });
  try {
    return database.prepare(query).all();
  } finally {
    database.close();
  }
}

function telegramFetchPreload(): string {
  return `
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const originalFetch = globalThis.fetch.bind(globalThis);
let heldReply = false;
function append(event) { fs.appendFileSync(process.env.BT_F1003_TELEGRAM_CAPTURE, JSON.stringify(event) + "\\n", "utf8"); }
const shutdownFile = process.env.BT_F1003_TELEGRAM_SHUTDOWN_FILE;
if (shutdownFile) {
  const timer = setInterval(() => {
    if (process.listenerCount("SIGTERM") === 0 || !fs.existsSync(shutdownFile)) return;
    clearInterval(timer);
    process.emit("SIGTERM");
  }, 20);
  timer.unref();
}
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(rawUrl);
  if (url.hostname !== "api.telegram.org") append({ method: "fetch_attempt", hostname: url.hostname, port: url.port, path: url.pathname });
  if (url.hostname === "api.telegram.org") {
    const method = url.pathname.split("/").at(-1);
    const expectedTokenDigest = process.env.BT_F1003_TELEGRAM_TOKEN_SHA256;
    if (expectedTokenDigest) {
      const segments = url.pathname.split("/");
      if (segments.length !== 3 || !segments[1].startsWith("bot") || !["getUpdates", "sendMessage"].includes(method) ||
          url.protocol !== "https:" || url.port || url.search ||
          createHash("sha256").update(segments[1].slice(3)).digest("hex") !== expectedTokenDigest) {
        append({ method: "telegram_credential_rejected" });
        throw new Error("synthetic Telegram fixture rejected the configured credential");
      }
    }
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const filePrefix = "/file/bot" + process.env.TELEGRAM_BOT_TOKEN + "/";
    if (url.pathname.startsWith(filePrefix)) {
      const requestedPath = decodeURIComponent(url.pathname.slice(filePrefix.length));
      const files = JSON.parse(process.env.BT_F1003_TELEGRAM_FILES || "{}" );
      const file = Object.values(files).find((entry) => entry.file_path === requestedPath);
      if (!file) throw new Error("synthetic Telegram fixture rejected an unconfigured media file");
      const bytes = Buffer.from(file.bytes_base64, "base64");
      append({ method: "getFileBinary", path: requestedPath, byte_count: bytes.byteLength });
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
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
      append({ method, chat_id: body.chat_id, message_thread_id: body.message_thread_id, text: body.text });
      if (process.env.BT_F1003_TELEGRAM_HOLD_SEND === "1" && !heldReply) {
        heldReply = true;
        await new Promise(resolve => {
          const lateSuccess = () => {
            append({ method: "sendMessageResponseAfterAbort" });
            resolve();
          };
          if (init?.signal?.aborted) lateSuccess();
          else init?.signal?.addEventListener("abort", lateSuccess, { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9002 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "getFile") {
      const files = JSON.parse(process.env.BT_F1003_TELEGRAM_FILES || "{}");
      const file = typeof body.file_id === "string" ? files[body.file_id] : undefined;
      if (!file) throw new Error("synthetic Telegram fixture rejected an unconfigured getFile request");
      const byteLength = Buffer.from(file.bytes_base64, "base64").byteLength;
      append({ method, byte_count: byteLength });
      if (shutdownFile) {
        await new Promise((_resolve, reject) => {
          const abort = () => {
            append({ method: "getFileAborted" });
            reject(new DOMException("synthetic Telegram getFile interrupted", "AbortError"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { file_path: file.file_path, file_size: byteLength } }),
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

function fixtureOsEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isolatedEnvironment(providerPort: number, gatewayPort: number, auditDir: string, stateRoot: string,
  memoryFile: string, historyFile: string, sessionDir: string, captureFile: string, updates: string): NodeJS.ProcessEnv {
  return { ...fixtureOsEnvironment(), WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort),
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

function spawnGateway(env: NodeJS.ProcessEnv, preloadFile?: string, envFile?: string): CapturedProcess {
  const args = [...(preloadFile ? ["--import", pathToFileURL(preloadFile).href] : []),
    "apps/gateway/dist/main.js", "--serve", ...(envFile ? ["--env-file", envFile] : [])];
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  childProcesses.add(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("close", () => childProcesses.delete(child));
  return { child, stdout, stderr };
}

async function connectWebChat(port: number, frames: WebSocketFrame[], user = "served-f1003-owner-session"): Promise<WebSocket> {
  const ticket = await fetch(`http://127.0.0.1:${port}/ws-ticket`, { method: "POST",
    headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ user }) });
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

function readCaptureText(captureFile: string): string | undefined {
  try {
    return readFileSync(captureFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseCaptureEvents<T extends Record<string, unknown>>(raw: string | undefined): T[] {
  if (raw === undefined) return [];
  return raw.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`capture file contains a non-object event at line ${index + 1}`);
    }
    return value as T;
  });
}

function readCaptureEvents<T extends Record<string, unknown>>(captureFile: string): T[] {
  return parseCaptureEvents<T>(readCaptureText(captureFile));
}

function captureDeliveryDiagnostic(captureFile: string, gateway: CapturedProcess, providerRequestCount: number): string {
  const raw = readCaptureText(captureFile);
  const gatewayStatus = gateway.child.exitCode === null ? "running" : `exited(${gateway.child.exitCode})`;
  if (raw === undefined) {
    return `capture=missing; delivery=unreceived; gateway=${gatewayStatus}; provider_requests=${providerRequestCount}`;
  }
  const events = parseCaptureEvents<{ method?: string }>(raw);
  const sendMessageCount = events.filter((event) => event.method === "sendMessage").length;
  const delivery = sendMessageCount > 0
    ? `delivery=partial; sendMessage_events=${sendMessageCount}`
    : "delivery=unreceived";
  return `capture=present; event_count=${events.length}; ${delivery}; gateway=${gatewayStatus}; provider_requests=${providerRequestCount}`;
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

async function waitForHealth(port: number, gateway: CapturedProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
  return (await readRequestBytes(request)).toString("utf8");
}

async function readRequestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function readTreeBytes(root: string, excludedFile?: string): Buffer {
  const contents: Buffer[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (path === excludedFile) continue;
    if (statSync(path).isDirectory()) contents.push(readTreeBytes(path, excludedFile));
    else contents.push(readFileSync(path));
  }
  return Buffer.concat(contents);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is unavailable`);
  return value;
}
