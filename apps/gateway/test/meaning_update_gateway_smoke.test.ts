import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HDSUpperController, LongTermMemoryStore } from "@blue-tanuki/hds-brain";
import { meaningUpdateCandidateDigest } from "@blue-tanuki/protocol";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const ROOT = process.cwd();
const WEBCHAT_TOKEN = "c0702-developer-token";
const RESUME_TOKEN = "c0702-review-token";
const OWNER_TOKEN = "c0702-owner-token";
const MAINTENANCE_TOKEN = "c0702-maintenance-token";
const childProcesses = new Set<ChildProcessWithoutNullStreams>();

interface CapturedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

afterEach(async () => {
  await Promise.all([...childProcesses].map(stopChild));
});

describe("C07.02 Gateway producer-to-private-M consumer", () => {
  it("routes a C candidate through explicit owner L3 review into private M", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-c0702-gateway-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const candidateMeaning = "Synthetic owner-reviewed meaning; no external effect.";
    let providerCalls = 0;
    let providerFailure: unknown;

    const memory = new LongTermMemoryStore({ filepath: memoryFile });
    const seedHds = new HDSUpperController({ memory });
    seedHds.decide({ id: "c0702-support", channel: "test", user: "fixture-owner",
      content: "Synthetic supporting observation for the C07.02 route.", timestamp: 1 });
    seedHds.decide({ id: "c0702-counter", channel: "test", user: "fixture-owner",
      content: "Synthetic counterevidence for the C07.02 route.", timestamp: 2 });
    const support = memory.findByRequestId("c0702-support");
    const counter = memory.findByRequestId("c0702-counter");
    if (!support || !counter || !memory.verify()) throw new Error("synthetic current-M fixture was not verified");
    seedHds.closeOperationPlanMemory();

    const provider = createServer((request, response) => {
      void (async () => {
        providerCalls += 1;
        const raw = await readRequest(request);
        const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
        const contextMessage = body.messages?.find((message) => typeof message.content === "string" &&
          message.content.includes("blue-tanuki.memory-candidates.v1"));
        if (typeof contextMessage?.content !== "string") throw new Error("current-M projection was not sent to C");
        const jsonStart = contextMessage.content.indexOf("\n") + 1;
        const context = JSON.parse(contextMessage.content.slice(jsonStart)) as {
          search_plan?: { plan_id?: string; application_scope_id?: string };
          records?: Array<{ record_id: string; version: string }>;
        };
        const planId = context.search_plan?.plan_id;
        const applicationScopeId = context.search_plan?.application_scope_id;
        const records = context.records ?? [];
        if (!planId || !applicationScopeId || records.length < 2) {
          throw new Error("two current-M references and the HDS scope were not available to C");
        }
        const currentSupport = records.find((item) => item.record_id === support.f_reference && item.version === support.entry_hash);
        const currentCounter = records.find((item) => item.record_id === counter.f_reference && item.version === counter.entry_hash);
        if (!currentSupport || !currentCounter) throw new Error("requested synthetic M references were not projected");
        const proposal = {
          schema_version: "blue-tanuki.meaning-update-proposal.v3",
          record_type: "meaning_update_proposal",
          proposal_ref: "proposal:c0702-gateway-smoke",
          candidate_ref: "candidate:c0702-gateway-smoke",
          candidate_digest: meaningUpdateCandidateDigest(candidateMeaning),
          candidate_meaning: candidateMeaning,
          target_reference: { record_id: currentSupport.record_id, version: currentSupport.version },
          prior_version_ref: "version:c0702-synthetic-prior",
          supporting_evidence: [{ reference: currentSupport.record_id, digest: currentSupport.version }],
          counterevidence_review: { status: "reviewed_with_references" as const,
            review_scope: { reference: applicationScopeId, digest: planId },
            references: [{ reference: currentCounter.record_id, digest: currentCounter.version }] },
          applicability_scope: { reference: applicationScopeId, digest: planId },
          reflection_target_ref: "reflection:c0702-gateway-smoke",
          proposal_status: "unverified" as const,
          adoption_status: "not_adopted" as const,
          may_apply: false as const,
          used_for_authority: false as const,
        };
        const content = JSON.stringify({ schema_version: "blue-tanuki.memory-citation-response.v1",
          answer: "Synthetic C response with current references.", citations: [{
            claim: "Synthetic candidate statement.",
            supporting: { record_id: currentSupport.record_id, version: currentSupport.version },
            counterevidence: { record_id: currentCounter.record_id, version: currentCounter.version },
            application_scope_id: applicationScopeId,
          }] });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "c0702-local-fixture", object: "chat.completion", created: 1,
          model: "c0702-local-fixture", choices: [{ index: 0, message: { role: "assistant", content,
            meaning_update_proposal: proposal }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      })().catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_provider_fixture_failed" }));
      });
    });
    const providerPort = await listen(provider);
    const gatewayPort = await reservePort();
    const env = isolatedEnvironment(providerPort, gatewayPort, auditDir, stateRoot, memoryFile, historyFile, sessionDir);
    let gateway: CapturedProcess | undefined;

    try {
      gateway = spawnGateway(env);
      await waitForHealth(gatewayPort, gateway);
      const invocation = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content:
          `Compare the synthetic evidence F:c0702-support and F:c0702-counter. Propose an unverified meaning candidate.` }),
      });
      expect(invocation.status).toBe(202);

      const pending = await waitForMeaningUpdateApproval(gatewayPort, gateway, () => providerFailure,
        () => providerCalls, auditDir);
      expect(pending).toMatchObject({ operation: "tool.call", approval_level: "L3_final_review",
        final_review_required: true, content_review_required: true,
        meaning_update_review: { kind: "meaning_update_adoption", review_status: "required",
          semantic_relation_status: "not_assessed", adoption_status: "not_adopted",
          may_execute: false, used_for_authority: false } });
      expect(pending.target).toMatch(/^memory\.meaning\.adopt:/);
      expect(JSON.stringify(pending)).not.toContain(candidateMeaning);
      expect(providerCalls).toBe(1);
      if (providerFailure) throw providerFailure;

      const approvalPath = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(pending.command_id))}`;
      const blocked = await fetch(approvalPath, { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: pending.approval_token }) });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: "approval_content_review_required" });

      const reviewResponse = await fetch(`${approvalPath}/content`, {
        method: "POST", headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(reviewResponse.status).toBe(200);
      expect(reviewResponse.headers.get("cache-control")).toContain("no-store");
      const review = await reviewResponse.json() as Record<string, unknown>;
      expect(review).toMatchObject({ kind: "meaning_update_adoption", command_id: pending.command_id,
        operation: "memory.meaning.adopt", candidate_meaning: candidateMeaning,
        reference_review_status: "prior_version_unverified", semantic_relation_status: "not_assessed",
        may_execute: false, used_for_authority: false });

      const approved = await fetch(approvalPath, { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: pending.approval_token,
          content_review_digest: review.command_digest }) });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ ok: true, result: { approval: "approve", executed: false,
        status: "meaning_update_adoption_committed", approval_status: "approved",
        memory_application_status: "applied", follow_up_action_status: "unconfirmed" } });

      const memoryDatabase = join(stateRoot, "private-state", "meaning-update-memory", "m-state.sqlite");
      expect(existsSync(memoryDatabase)).toBe(true);
      const db: DatabaseSyncType = new DatabaseSync(memoryDatabase, { readOnly: true });
      try {
        const row = db.prepare("SELECT value_json FROM m_records WHERE record_id = ?")
          .get(`meaning-update:${String(review.proposal_digest)}`) as { value_json?: string } | undefined;
        expect(row?.value_json).toBeDefined();
        const record = JSON.parse(row!.value_json!) as Record<string, unknown>;
        expect(record).toMatchObject({ approval_status: "approved", memory_application_status: "applied",
          follow_up_action_status: "unconfirmed", semantic_relation_status: "not_assessed",
          used_for_authority: false, may_execute: false,
          proposal: { candidate_meaning: candidateMeaning, candidate_digest: review.candidate_digest } });
      } finally {
        db.close();
      }
      for (const persistedFile of [join(auditDir, "audit.jsonl"), historyFile]) {
        expect(readFileSync(persistedFile, "utf8")).not.toContain(candidateMeaning);
      }
      expect(providerCalls).toBe(1);
    } finally {
      if (gateway) await stopChild(gateway.child);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

async function waitForMeaningUpdateApproval(port: number, gateway: CapturedProcess,
  providerFailure: () => unknown, providerCalls: () => number, auditDir: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const failure = providerFailure();
    if (failure) throw failure;
    const response = await fetch(`http://127.0.0.1:${port}/approval`, {
      headers: { authorization: `Bearer ${RESUME_TOKEN}` },
    });
    if (response.ok) {
      const queue = await response.json() as { pending_approvals?: Array<Record<string, unknown>> };
      const pending = queue.pending_approvals?.find((item) => item.operation === "tool.call" &&
        typeof item.target === "string" && item.target.startsWith("memory.meaning.adopt:"));
      if (pending) return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const auditText = existsSync(join(auditDir, "audit.jsonl")) ? readFileSync(join(auditDir, "audit.jsonl"), "utf8") : "";
  const feedback = auditText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    log?: { kind?: string; feedback?: unknown };
  }).reverse().find((entry) => entry.log?.kind === "executor_feedback")?.log?.feedback;
  const auditEvents = auditText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    log?: { kind?: string; event?: string; request_id?: string; command_id?: string; reason?: string;
      evaluation?: { decision?: string; context?: { operation?: string; target?: string } } };
  }).slice(-12).map((entry) => ({ kind: entry.log?.kind, event: entry.log?.event,
    request_id: entry.log?.request_id, command_id: entry.log?.command_id, reason: entry.log?.reason,
    decision: entry.log?.evaluation?.decision, operation: entry.log?.evaluation?.context?.operation,
    target: entry.log?.evaluation?.context?.target }));
  throw new Error(`meaning-update owner approval did not reach the queue; provider_calls=${providerCalls()}; ` +
    `executor_feedback=${JSON.stringify(feedback)}; audit_events=${JSON.stringify(auditEvents)}; ` +
    `gateway_stdout=${gateway.stdout.join("")}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function isolatedEnvironment(providerPort: number, gatewayPort: number, auditDir: string, stateRoot: string,
  memoryFile: string, historyFile: string, sessionDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, WEBCHAT_HOST: "127.0.0.1", WEBCHAT_PORT: String(gatewayPort),
    WEBCHAT_TOKEN, WEBCHAT_RESUME_TOKEN: RESUME_TOKEN, BLUE_TANUKI_OWNER_TOKEN: OWNER_TOKEN,
    BLUE_TANUKI_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
    BLUE_TANUKI_FILE_ROOT: join(auditDir, "file-root"), BLUE_TANUKI_STATE_ROOT: stateRoot,
    BLUE_TANUKI_MEMORY_FILE: memoryFile, BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile, BLUE_TANUKI_SESSION_DIR: sessionDir,
    LLM_BACKEND: "c0702-local-fixture", LLM_PROVIDERS_JSON: JSON.stringify([{
      name: "c0702-local-fixture", type: "openai-compatible", endpoint: `http://127.0.0.1:${providerPort}/v1`,
      model: "c0702-local-fixture", aliases: [], headers: {},
    }]), BLUE_TANUKI_LLM_BACKEND_HINT: "c0702-local-fixture",
    SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", DISCORD_BOT_TOKEN: "", TELEGRAM_BOT_TOKEN: "",
    LINE_CHANNEL_ACCESS_TOKEN: "", LINE_CHANNEL_SECRET: "" };
}

function spawnGateway(env: NodeJS.ProcessEnv): CapturedProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/gateway/src/main.ts", "--serve"], {
    cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  childProcesses.add(child);
  const stdout: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("close", () => childProcesses.delete(child));
  return { child, stdout, stderr };
}

async function waitForHealth(port: number, gateway: CapturedProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* Gateway is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway health did not become ready: ${gateway.stderr.join("")}`);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listener did not bind");
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

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!childProcesses.has(child)) return;
  const closed = once(child, "close");
  if (child.exitCode === null && child.signalCode === null && !child.kill("SIGTERM")) {
    throw new Error("test-owned Gateway process could not be stopped");
  }
  await closed;
  childProcesses.delete(child);
}
