import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_COMPUTE_BUDGET_POLICY, SYNTHETIC_FILE_WRITE_PLAN_TASK } from "@blue-tanuki/core";
import { HDSUpperController, LongTermMemoryStore, operationPlanDigest } from "@blue-tanuki/hds-brain";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const tsxArgs = ["--import", "tsx"];
const source = "決定事項:青\n未確認:期限";
const firstExcerpt = "決定事項:青";
const secondExcerpt = "未確認:期限";
const token = "c0801-webchat-token";
const resumeToken = "c0801-webchat-resume-token";
const ownerToken = "c0801-webchat-owner-token";
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
        [...tsxArgs, "apps/gateway/src/main.ts", "--organize", source],
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
      const ownerInboundResponse = await fetch(`http://127.0.0.1:${gatewayPort}/owner/inbound`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          user: "c0801-owner",
          content: `/organize\n${source}`,
          actor: "system",
          metadata: { trust_level: "owner", authority: "bypass" },
        }),
      });
      expect(ownerInboundResponse.status).toBe(202);
      const ownerReceived = waitForWebChatSend(webSocket);
      const ownerOutput = await ownerReceived;
      expect(ownerOutput).toContain("状態: completed");
      expect(ownerOutput).toContain("決定事項:青");
      expect(ownerOutput).toContain("未確認:期限");
      expect(ownerOutput).toContain("権限利用: false / 実行可能: false / 永続記憶反映: false");
      expect(upstreamCallCount).toBe(6);
      expect(upstreamPrompts[1]).toContain(`"start":0,"end":${firstExcerpt.length}`);
      expect(upstreamPrompts[3]).toContain(`"start":0,"end":${firstExcerpt.length}`);
      expect(upstreamPrompts[5]).toContain(`"start":0,"end":${firstExcerpt.length}`);
      const persistedAudit = readFileSync(join(auditDir, "audit.jsonl"), "utf8");
      const persistedHistory = readFileSync(historyFile, "utf8");
      const persistedSessions = existsSync(sessionDir)
        ? readdirSync(sessionDir).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n")
        : "";
      expect(persistedAudit).not.toContain(firstExcerpt);
      expect(persistedAudit).not.toContain(secondExcerpt);
      expect(persistedHistory).toContain('"actor":"webchat-inbound-token-holder"');
      expect(persistedHistory).toContain('"actor":"webchat-owner-token-holder"');
      expect(persistedHistory).not.toContain('"actor":"c0801-owner"');
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
    const childOne = spawnCaptured([...tsxArgs, "apps/gateway/src/main.ts", "--organize", restartSource], firstEnv);

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
        const resumed = await runChild([...tsxArgs, "apps/gateway/src/main.ts", "--organize", restartSource], resumedEnv);
        const resumedOutput = extractProjection(resumed.stdout.join(""));
        expect(resumedOutput).toContain("状態: completed");
        expect(resumedOutput).toContain("C08_PRIVATE_RESTART_SOURCE:決定事項は青。");
        expect(resumedOutput).toContain(secondQuote);
        expect(resumedOutput).toContain("再起動復旧済み範囲");
        expect(providerTwoCalls).toBe(1);
        expect(providerTwoPrompts[0]).toContain(`"start":0,"end":${firstQuote.length}`);

        const repeated = await runChild([...tsxArgs, "apps/gateway/src/main.ts", "--organize", restartSource], resumedEnv);
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
    const childOne = spawnCaptured([...tsxArgs, "apps/gateway/src/main.ts", "--organize", changedSource], firstEnv);

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
        const held = await runChild([...tsxArgs, "apps/gateway/src/main.ts", "--organize", changedSource], resumedEnv);
        const heldOutput = extractProjection(held.stdout.join(""));
        expect(heldOutput).toContain("状態: held");
        expect(heldOutput).toContain("memory_state_changed");
        expect(heldOutput).toContain("再起動復旧済み範囲");
        expect(providerTwoCalls).toBe(0);

        const repeated = await runChild([...tsxArgs, "apps/gateway/src/main.ts", "--organize", changedSource], resumedEnv);
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

describe("delegated goal purpose owner review", () => {
  it("holds exact proposal text in memory, requires reviewed L3 approval, commits to J, and replays the new version", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-goal-purpose-change-"));
    const auditDir = join(tempRoot, "audit");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const stateRoot = join(tempRoot, "state");
    const fileRoot = join(auditDir, "file-root");
    const privateState = join(stateRoot, "private-state");
    mkdirSync(fileRoot, { recursive: true });
    mkdirSync(privateState, { recursive: true });
    const goalRef = "goal_0000000000000042";
    const initialPurpose = "Initial delegated purpose";
    const initialDigest = createHash("sha256").update(Buffer.from(initialPurpose, "utf8")).digest("hex");
    writeFileSync(join(privateState, "goal-governance.json"), JSON.stringify({
      schema_version: "blue-tanuki.goal-governance.v1",
      goals: [{
        goal_ref: goalRef,
        goal_kind: "delegated",
        source_ref: "F:0000000000000042",
        initial_purpose_digest: initialDigest,
        initial_interpretation_digest: "c".repeat(64),
        adopted_at: Date.now() - 10_000,
      }],
      authorizations: [],
      events: [],
    }), "utf8");

    let providerCalls = 0;
    let providerFailure: unknown;
    const providerRequestIds: string[] = [];
    const plannerPrompts: string[] = [];
    const taskText = "Prepare one bounded read-only search plan.";
    const provider = createServer((request, response) => {
      providerCalls += 1;
      void readPrompt(request).then((prompt) => {
        const childRole = /C child role=([a-z_]+)/.exec(prompt)?.[1];
        if (childRole) {
          const content = JSON.stringify({ role: childRole, candidate: "bounded read-only planning observation",
            used_for_authority: false, may_execute: false });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: `c0802-${childRole}-fixture`, object: "chat.completion", created: 1,
            model: "c0802-local-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
          return;
        }
        const isPlanPrompt = prompt.includes("候補だけをJSON wrapperで返してください。形は{plan: operation-core.v1のOperationPlan");
        if (!isPlanPrompt && prompt.includes("blue-tanuki.memory-citation-response.v1")) {
          const content = JSON.stringify({ schema_version: "blue-tanuki.memory-citation-response.v1",
            answer: "", citations: [] });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "c0802-memory-citation-fixture", object: "chat.completion", created: 1,
            model: "c0802-local-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
          return;
        }
        if (!prompt.includes(taskText)) throw new Error("owner task intent was not passed to the local C fixture");
        const requestId = /固定request_id=([^\s。]+)/.exec(prompt)?.[1];
        if (!requestId) throw new Error("J operation request id was not bound into the planner prompt");
        providerRequestIds.push(requestId);
        plannerPrompts.push(prompt);
        const target = { kind: "directory", id: fileRoot };
        const expected = { root: fileRoot, sandbox_root: fileRoot, query: "fixture", visited_files: 0, matches: [] };
        const content = JSON.stringify({
          plan: {
            version: "operation-core.v1",
            plan_id: `owner-task-plan:${requestId}`,
            request_id: requestId,
            state: "planned",
            steps: [{
              step_id: "synthetic-search",
              operation: "file.search",
              target,
              state: "planned",
              effects: ["read"],
              permission: { risk: "low", approval_level: "L1_observe", final_review_required: false,
                hds_brain_authority_required: true, approval_gate_required: true },
              adapter: "internal_runtime",
              adapter_is_authority: false,
              command_generated_by_adapter_only: false,
              parameters: { root: fileRoot, query: "fixture", max_results: 1 },
              preparation: { depends_on: [], bindings: [], preconditions: [],
                validation: [{ check_id: "synthetic-search-observed", method: "result_equals", target, expected }],
                compensation: { available: false, reason: "read-only" } },
            }],
            rollback: { available: false },
            raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
            planner_output_used_for_authority: false,
            hds_brain_authority_required: true,
          },
          goal_purpose_relation: { outcome: "supports", evidence: [{ task_quote: taskText, purpose_quote: proposedPurpose }] },
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "c0802-owner-task-fixture", object: "chat.completion", created: 1,
          model: "c0802-local-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }).catch((error: unknown) => {
        providerFailure = error;
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_owner_task_fixture_failed" }));
      });
    });
    const providerPort = await listenOnLoopback(provider);
    const gatewayPort = await reserveLoopbackPort();
    const runtimeEnv = isolatedRuntimeEnvironment(providerPort, gatewayPort, auditDir, historyFile, sessionDir);
    runtimeEnv.BLUE_TANUKI_STATE_ROOT = stateRoot;
    let gateway: CapturedProcess | undefined;
    let taskWebSocket: WebSocket | undefined;
    const proposedPurpose = "新しい委任目的\n未確定条件を保持する。";
    const proposedDigest = createHash("sha256").update(Buffer.from(proposedPurpose, "utf8")).digest("hex");

    try {
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);
      const unauthorizedCandidates = await fetch(
        `http://127.0.0.1:${gatewayPort}/owner/goal-purpose-change-candidates`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(unauthorizedCandidates.status).toBe(401);
      const ownerCandidates = await fetch(
        `http://127.0.0.1:${gatewayPort}/owner/goal-purpose-change-candidates`,
        { headers: { authorization: `Bearer ${ownerToken}` } },
      );
      expect(ownerCandidates.status).toBe(200);
      expect(ownerCandidates.headers.get("cache-control")).toBe("no-store");
      expect(await ownerCandidates.json()).toEqual({ candidates: [] });
      const proposalResponse = await fetch(`http://127.0.0.1:${gatewayPort}/owner/goal-purpose-change`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ goal_ref: goalRef, purpose_text: proposedPurpose }),
      });
      expect(proposalResponse.status).toBe(202);
      const proposal = await proposalResponse.json() as Record<string, unknown>;
      expect(proposal).toMatchObject({
        accepted: true,
        status: "approval_required",
        goal_ref: goalRef,
        prior_version: 1,
        prior_purpose_digest: initialDigest,
        new_purpose_digest: proposedDigest,
      });
      expect(JSON.stringify(proposal)).not.toContain(proposedPurpose);
      expect(providerCalls).toBe(0);

      const loadQueue = async () => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/approval`, {
          headers: { authorization: `Bearer ${resumeToken}` },
        });
        expect(response.status).toBe(200);
        return await response.json() as { pending_approvals: Array<Record<string, unknown>> };
      };
      const queue = await loadQueue();
      const pending = queue.pending_approvals.find((item) => item.command_id === proposal.command_id);
      expect(pending).toMatchObject({
        content_review_required: true,
        approval_level: "L3_final_review",
        final_review_required: true,
        goal_purpose_change_review: {
          kind: "goal_purpose_change",
          goal_ref: goalRef,
          prior_version: 1,
          prior_purpose_digest: initialDigest,
          new_purpose_digest: proposedDigest,
          review_status: "required",
          used_for_authority: false,
        },
      });
      expect(JSON.stringify(queue)).not.toContain(proposedPurpose);
      const approvalToken = pending?.approval_token;
      expect(typeof approvalToken).toBe("string");

      const approvePath = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(proposal.command_id))}`;
      const blockedBeforeReview = await fetch(approvePath, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: approvalToken }),
      });
      expect(blockedBeforeReview.status).toBe(409);
      expect(await blockedBeforeReview.json()).toMatchObject({ error: "approval_content_review_required" });
      expect((await loadQueue()).pending_approvals.some((item) => item.command_id === proposal.command_id)).toBe(true);

      const reviewResponse = await fetch(`${approvePath}/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}` },
      });
      expect(reviewResponse.status).toBe(200);
      expect(reviewResponse.headers.get("cache-control")).toContain("no-store");
      const review = await reviewResponse.json() as Record<string, unknown>;
      expect(review).toMatchObject({
        kind: "goal_purpose_change",
        command_id: proposal.command_id,
        operation: "goal.governance.change",
        goal_ref: goalRef,
        prior_version: 1,
        prior_purpose_digest: initialDigest,
        new_purpose_digest: proposedDigest,
        request_payload_digest: proposedDigest,
        purpose_text: proposedPurpose,
        used_for_authority: false,
      });

      const approved = await fetch(approvePath, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          verdict: "approve",
          approval_token: approvalToken,
          content_review_digest: review.command_digest,
        }),
      });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({
        ok: true,
        result: {
          approval: "approve",
          executed: false,
          status: "goal_purpose_change_committed",
          goal_ref: goalRef,
          version: 2,
          purpose_digest: proposedDigest,
        },
      });
      expect(providerCalls).toBe(0);

      const durableBeforeRestart = [
        readFileSync(join(auditDir, "audit.jsonl"), "utf8"),
        existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "",
        existsSync(sessionDir) ? readdirSync(sessionDir).map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n") : "",
      ].join("\n");
      expect(durableBeforeRestart).not.toContain(proposedPurpose);
      expect(durableBeforeRestart).toContain(proposedDigest);
      await stopChild(gateway.child);
      gateway = undefined;
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);
      const taskGoals = await fetch(`http://127.0.0.1:${gatewayPort}/owner/task-goals`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(taskGoals.status).toBe(200);
      expect(taskGoals.headers.get("cache-control")).toBe("no-store");
      const taskGoalBody = await taskGoals.json() as { goals?: Array<Record<string, unknown>> };
      expect(taskGoalBody.goals).toEqual([{ goal_ref: goalRef, purpose_version: 2,
        purpose_preview: proposedPurpose }]);
      expect(JSON.stringify(taskGoalBody)).not.toContain(proposedDigest);
      const unauthorizedTask = await fetch(`http://127.0.0.1:${gatewayPort}/owner/task-compute`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", task: taskText, goal_ref: goalRef }),
      });
      expect(unauthorizedTask.status).toBe(401);
      const wsTicketResponse = await fetch(`http://127.0.0.1:${gatewayPort}/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner" }),
      });
      expect(wsTicketResponse.status).toBe(200);
      const { ticket } = await wsTicketResponse.json() as { ticket: string };
      taskWebSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?ticket=${encodeURIComponent(ticket)}`);
      await once(taskWebSocket, "open");
      const taskReply = waitForWebChatSend(taskWebSocket, "owner task compute");
      const taskSubmission = await fetch(`http://127.0.0.1:${gatewayPort}/owner/task-compute`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", task: taskText, goal_ref: goalRef,
          actor: "system", metadata: { "blue_tanuki.actor_kind": "system" } }),
      });
      expect(taskSubmission.status).toBe(202);
      const taskAccepted = await taskSubmission.json() as { accepted?: boolean; request_id?: string; status?: string };
      expect(taskAccepted).toMatchObject({ accepted: true, status: "queued_for_hds_decision" });
      expect(taskAccepted.request_id).toBeTruthy();
      const taskReplyText = await taskReply;
      expect(taskReplyText.length).toBeGreaterThan(0);
      const initialComputeRequestId = `operation-request:${taskAccepted.request_id}`;
      expect(providerRequestIds.length).toBeGreaterThan(0);
      expect(providerRequestIds.every((requestId) => requestId === initialComputeRequestId)).toBe(true);
      const runtimeSnapshotResponse = await fetch(`http://127.0.0.1:${gatewayPort}/runtime/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(runtimeSnapshotResponse.status).toBe(200);
      const runtimeSnapshot = await runtimeSnapshotResponse.json() as {
        operation_plan_status?: { status?: string; used_for_authority?: boolean; plans?: Array<Record<string, unknown>> };
      };
      expect(runtimeSnapshot.operation_plan_status).toMatchObject({ status: "available", used_for_authority: false });
      expect(runtimeSnapshot.operation_plan_status?.plans).toHaveLength(1);
      const selectedPlan = runtimeSnapshot.operation_plan_status?.plans?.[0] as {
        plan_id?: string;
        revision_digest?: string;
        owner_authentication_required?: boolean;
        goal_purpose_binding_status?: string;
        goal_purpose_binding?: { goal_ref: string; purpose_version: number; purpose_digest: string };
        goal_purpose_relation?: { status?: string; candidate_outcome?: string };
        task_identity_digest?: string;
        steps?: Array<{ step_id?: string; status?: string }>;
      } | undefined;
      expect(selectedPlan).toMatchObject({ owner_authentication_required: true, goal_purpose_binding_status: "current",
        goal_purpose_relation: { status: "unverified", candidate_outcome: "supports" } });
      expect(selectedPlan?.task_identity_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(providerCalls).toBeGreaterThan(0);
      expect(providerFailure).toBeUndefined();

      const relationReviewProposalResponse = await fetch(`http://127.0.0.1:${gatewayPort}/owner/goal-purpose-relation-review`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ plan_id_digest: selectedPlan?.plan_id, revision_digest: selectedPlan?.revision_digest,
          outcome: "supports" }),
      });
      expect(relationReviewProposalResponse.status).toBe(202);
      const relationReviewProposal = await relationReviewProposalResponse.json() as {
        accepted?: boolean; status?: string; command_id?: string;
      };
      expect(relationReviewProposal).toMatchObject({ accepted: true, status: "approval_required" });
      const relationQueue = await loadQueue();
      const relationPending = relationQueue.pending_approvals.find((item) => item.command_id === relationReviewProposal.command_id);
      expect(relationPending).toMatchObject({ content_review_required: true, approval_level: "L3_final_review",
        final_review_required: true, goal_purpose_relation_review: { outcome: "supports", review_status: "required",
          used_for_authority: false, may_execute: false } });
      const relationContentResponse = await fetch(`http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(relationReviewProposal.command_id))}/content`, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}` },
      });
      expect(relationContentResponse.status).toBe(200);
      const relationContent = await relationContentResponse.json() as Record<string, unknown>;
      expect(relationContent).toMatchObject({ kind: "goal_purpose_relation", task: taskText,
        purpose_text: proposedPurpose, candidate_outcome: "supports", used_for_authority: false, may_execute: false });
      const relationApprovalResponse = await fetch(`http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(relationReviewProposal.command_id))}`, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: relationPending?.approval_token,
          content_review_digest: relationContent.command_digest }),
      });
      expect(relationApprovalResponse.status).toBe(200);
      expect(await relationApprovalResponse.json()).toMatchObject({ ok: true, result: {
        approval: "approve", executed: false, status: "goal_purpose_relation_review_committed", outcome: "supports",
      } });

      const step = selectedPlan?.steps?.[0];
      expect(step?.step_id).toMatch(/^[a-f0-9]{64}$/);
      const stepReviewReply = waitForWebChatSend(taskWebSocket, "plan step review");
      const stepReviewResponse = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", content: `plan:review ${JSON.stringify({
          plan_id: selectedPlan?.plan_id, revision_digest: selectedPlan?.revision_digest, step_id: step?.step_id,
          goal_purpose_binding: selectedPlan?.goal_purpose_binding,
        })}` }),
      });
      expect(stepReviewResponse.status).toBe(202);
      const stepReviewReplyText = await stepReviewReply;
      expect(stepReviewReplyText.length).toBeGreaterThan(0);
      const completedSnapshotResponse = await fetch(`http://127.0.0.1:${gatewayPort}/runtime/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(completedSnapshotResponse.status).toBe(200);
      const completedSnapshot = await completedSnapshotResponse.json() as {
        operation_plan_status?: { plans?: Array<Record<string, unknown>> };
      };
      expect(completedSnapshot.operation_plan_status?.plans).toMatchObject([{
        plan_id: selectedPlan?.plan_id,
        task_identity_digest: selectedPlan?.task_identity_digest,
        revision_digest: selectedPlan?.revision_digest,
        status: "results_verified",
        goal_purpose_relation: { status: "owner_reviewed_supports", owner_review_outcome: "supports" },
        steps: [expect.objectContaining({ operation: "file.search", status: "verified",
          binding: expect.objectContaining({ memory_status: "receipt_confirmed" }) })],
      }]);

      const waitControl = { plan_id: selectedPlan?.plan_id, revision_digest: selectedPlan?.revision_digest,
        deadline_at_ms: Date.now() + 10 * 60_000 };
      const waitRegisteredReply = waitForWebChatSend(taskWebSocket, "wait registration");
      const waitRegistration = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", content: `plan:wait ${JSON.stringify(waitControl)}` }),
      });
      expect(waitRegistration.status).toBe(202);
      expect((await waitRegisteredReply).length).toBeGreaterThan(0);
      const registeredWaitSnapshot = await fetch(`http://127.0.0.1:${gatewayPort}/runtime/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(registeredWaitSnapshot.status).toBe(200);
      const registeredWaitBody = await registeredWaitSnapshot.json() as {
        operation_plan_status?: { waits?: Array<Record<string, unknown>> };
      };
      const registeredWait = registeredWaitBody.operation_plan_status?.waits?.find((wait) =>
        wait.plan_id === selectedPlan?.plan_id && wait.revision_digest === selectedPlan?.revision_digest && wait.state === "waiting");
      expect(registeredWait).toMatchObject({ task_identity_digest: selectedPlan?.task_identity_digest,
        used_for_authority: false, may_execute: false });

      const replanReply = waitForWebChatSend(taskWebSocket, "wait reply replan");
      const ownerReply = await fetch(`http://127.0.0.1:${gatewayPort}/owner/inbound`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: selectedPlan?.plan_id,
          revision_digest: selectedPlan?.revision_digest, content: "The first result is received; keep the same task and propose the next safe observation." }),
      });
      expect(ownerReply.status).toBe(202);
      const ownerReplyBody = await ownerReply.json() as { request_id?: string };
      expect(ownerReplyBody.request_id).toBeTruthy();
      const replanReplyText = await replanReply;
      expect(replanReplyText.length).toBeGreaterThan(0);

      const replanned = await waitFor(async () => {
        if (providerFailure) throw providerFailure;
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/runtime/snapshot`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return null;
        const body = await response.json() as { operation_plan_status?: {
          waits?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>>;
        } };
        const resumedWait = body.operation_plan_status?.waits?.find((wait) =>
          wait.plan_id === selectedPlan?.plan_id && wait.revision_digest === selectedPlan?.revision_digest &&
          wait.state === "resumed" && wait.wake_reason === "reply" && wait.compute_outcome === "candidate_retained");
        const candidate = resumedWait && body.operation_plan_status?.plans?.find((plan) =>
          plan.plan_id === resumedWait.candidate_plan_id);
        return resumedWait && candidate ? { wait: resumedWait, candidate } : null;
      }, gateway, "same-task reply did not retain a new J candidate");
      expect(providerRequestIds).toHaveLength(2);
      expect(providerRequestIds).toEqual([initialComputeRequestId, ownerReplyBody.request_id]);
      expect(plannerPrompts[1]).toContain(JSON.stringify(proposedPurpose).slice(1, -1));
      expect(replanned.wait).toMatchObject({ task_identity_digest: selectedPlan?.task_identity_digest,
        used_for_authority: false, may_execute: false });
      expect(replanned.candidate).toMatchObject({
        task_identity_digest: selectedPlan?.task_identity_digest,
        goal_purpose_binding: selectedPlan?.goal_purpose_binding,
        goal_purpose_binding_status: "current",
        goal_purpose_relation: { status: "unverified", candidate_outcome: "supports" },
      });
      expect(replanned.candidate.plan_id).not.toBe(selectedPlan?.plan_id);
      expect(replanned.candidate.revision).toBe(1);
      expect(replanned.candidate.revision_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(new Set(providerRequestIds)).toEqual(new Set([initialComputeRequestId,
        ownerReplyBody.request_id]));
      expect(plannerPrompts[providerRequestIds.indexOf(ownerReplyBody.request_id)])
        .toContain(JSON.stringify(proposedPurpose).slice(1, -1));

      taskWebSocket.close();
      taskWebSocket = undefined;
      const providerCallsBeforeRejectedReview = providerCalls;
      const secondPurpose = "目的変更後の再起動時に確認する次の提案。";
      const secondDigest = createHash("sha256").update(Buffer.from(secondPurpose, "utf8")).digest("hex");
      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/owner/goal-purpose-change`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ goal_ref: goalRef, purpose_text: secondPurpose }),
      });
      expect(secondResponse.status).toBe(202);
      const secondProposal = await secondResponse.json() as Record<string, unknown>;
      expect(secondProposal).toMatchObject({
        accepted: true,
        prior_version: 2,
        prior_purpose_digest: proposedDigest,
        new_purpose_digest: secondDigest,
      });
      const secondQueue = await loadQueue();
      const secondPending = secondQueue.pending_approvals.find((item) => item.command_id === secondProposal.command_id);
      const rejected = await fetch(`http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(secondProposal.command_id))}`, {
        method: "POST",
        headers: { authorization: `Bearer ${resumeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "reject", approval_token: secondPending?.approval_token }),
      });
      expect(rejected.status).toBe(200);
      expect(providerCalls).toBe(providerCallsBeforeRejectedReview);

      const providerCallsBeforeSyntheticTask = providerCalls;
      await stopChild(gateway.child);
      runtimeEnv.BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND = "true";
      runtimeEnv.LLM_BACKEND = "synthetic-file-write-plan";
      runtimeEnv.BLUE_TANUKI_LLM_BACKEND_HINT = "synthetic-file-write-plan";
      runtimeEnv.BLUE_TANUKI_FILE_ROOT = fileRoot;
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);

      const syntheticTicketResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/ws-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner" }),
      });
      expect(syntheticTicketResponse.status).toBe(200);
      const { ticket: syntheticTicket } = await syntheticTicketResponse.json() as { ticket: string };
      taskWebSocket = new WebSocket("ws://127.0.0.1:" + gatewayPort + "/ws?ticket=" + encodeURIComponent(syntheticTicket));
      await once(taskWebSocket, "open");

      const syntheticTaskReply = waitForWebChatSend(taskWebSocket, "synthetic create-only task");
      const syntheticTaskSubmission = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/task-compute", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", task: SYNTHETIC_FILE_WRITE_PLAN_TASK,
          goal_ref: goalRef, purpose_version: 2 }),
      });
      expect(syntheticTaskSubmission.status).toBe(202);
      const syntheticTaskOutput = await syntheticTaskReply;
      expect(syntheticTaskOutput.length).toBeGreaterThan(0);

      const writePlan = await waitFor(async () => {
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
          headers: { authorization: "Bearer " + token },
        });
        if (!response.ok) return null;
        const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
        return body.operation_plan_status?.plans?.find((plan) => Array.isArray(plan.steps) &&
          (plan.steps as Array<Record<string, unknown>>).some((step) => step.operation === "file.write")) ?? null;
      }, gateway, `synthetic task did not reach the file.write plan consumer; WebChat reply=${syntheticTaskOutput}`);
      expect(writePlan).toMatchObject({ owner_authentication_required: true,
        goal_purpose_relation: { status: "unverified", candidate_outcome: "unknown" } });
      const writePlanId = String(writePlan.plan_id);
      const writeRevision = String(writePlan.revision_digest);
      const goalPurposeBinding = writePlan.goal_purpose_binding as {
        goal_ref: string; purpose_version: number; purpose_digest: string;
      };
      const writeStep = (writePlan.steps as Array<Record<string, unknown>>)
        .find((step) => step.operation === "file.write");
      expect(writeStep?.step_id).toMatch(/^[a-f0-9]{64}$/);
      const writeStepId = String(writeStep?.step_id);

      const syntheticRelationProposalResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/goal-purpose-relation-review", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ plan_id_digest: writePlanId, revision_digest: writeRevision, outcome: "supports" }),
      });
      expect(syntheticRelationProposalResponse.status).toBe(202);
      const syntheticRelationProposal = await syntheticRelationProposalResponse.json() as { command_id?: string; status?: string };
      expect(syntheticRelationProposal).toMatchObject({ status: "approval_required" });
      const syntheticRelationQueue = await loadQueue();
      const syntheticRelationPending = syntheticRelationQueue.pending_approvals.find((item) => item.command_id === syntheticRelationProposal.command_id);
      expect(syntheticRelationPending).toMatchObject({ approval_level: "L3_final_review", final_review_required: true,
        goal_purpose_relation_review: { outcome: "supports", review_status: "required", may_execute: false } });
      const syntheticRelationContentResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(syntheticRelationProposal.command_id)) + "/content",
        { method: "POST", headers: { authorization: "Bearer " + resumeToken } },
      );
      expect(syntheticRelationContentResponse.status).toBe(200);
      const syntheticRelationContent = await syntheticRelationContentResponse.json() as Record<string, unknown>;
      expect(syntheticRelationContent).toMatchObject({ kind: "goal_purpose_relation", task: SYNTHETIC_FILE_WRITE_PLAN_TASK,
        purpose_text: proposedPurpose, candidate_outcome: "unknown", may_execute: false });
      const syntheticRelationApprovalResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(syntheticRelationProposal.command_id)),
        { method: "POST", headers: { authorization: "Bearer " + resumeToken, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: syntheticRelationPending?.approval_token,
          content_review_digest: syntheticRelationContent.command_digest }) },
      );
      expect(syntheticRelationApprovalResponse.status).toBe(200);
      expect(await syntheticRelationApprovalResponse.json()).toMatchObject({ ok: true, result: {
        approval: "approve", executed: false, status: "goal_purpose_relation_review_committed", outcome: "supports",
      } });

      const writeReviewReply = waitForWebChatSend(taskWebSocket, "synthetic file.write review");
      const writeReviewResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: writePlanId, revision_digest: writeRevision,
          content: "plan:review " + JSON.stringify({ plan_id: writePlanId, revision_digest: writeRevision,
            step_id: writeStepId, goal_purpose_binding: goalPurposeBinding }) }),
      });
      expect(writeReviewResponse.status).toBe(202);
      const writeReviewOutput = await writeReviewReply;
      expect(writeReviewOutput.length).toBeGreaterThan(0);

      let completedWritePlan: Record<string, unknown>;
      try {
        completedWritePlan = await waitFor(async () => {
          const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
            headers: { authorization: "Bearer " + token },
          });
          if (!response.ok) return null;
          const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
          const plan = body.operation_plan_status?.plans?.find((candidate) => candidate.plan_id === writePlanId);
          return plan?.status === "results_verified" ? plan : null;
        }, gateway, "synthetic file.write did not return a verified M receipt");
      } catch (error) {
        const [snapshotResponse, approvalQueue] = await Promise.all([
          fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", { headers: { authorization: "Bearer " + token } }),
          loadQueue(),
        ]);
        const snapshot = snapshotResponse.ok
          ? await snapshotResponse.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } }
          : undefined;
        const current = snapshot?.operation_plan_status?.plans?.find((plan) => plan.plan_id === writePlanId);
        const steps = Array.isArray(current?.steps) ? current.steps as Array<Record<string, unknown>> : [];
        throw new Error(`${error instanceof Error ? error.message : String(error)}; review_reply=${writeReviewOutput}; ` +
          `plan_status=${String(current?.status ?? "missing")}; steps=${JSON.stringify(steps.map((step) => ({
            operation: step.operation, status: step.status, binding: step.binding,
          })))}; approvals=${JSON.stringify(approvalQueue.pending_approvals.map((item) => ({
            command_id: item.command_id, approval_level: item.approval_level,
            final_review_required: item.final_review_required, content_review_required: item.content_review_required,
          })))}`);
      }
      const completedWriteStep = (completedWritePlan.steps as Array<Record<string, unknown>>)
        .find((step) => step.step_id === writeStepId);
      expect(completedWriteStep).toMatchObject({ operation: "file.write", status: "verified",
        binding: { memory_status: "receipt_confirmed" } });
      const createdFiles = readdirSync(fileRoot).filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name));
      expect(createdFiles).toHaveLength(1);
      expect(readFileSync(join(fileRoot, createdFiles[0]!), "utf8"))
        .toBe("BLUE-TANUKI synthetic create-only operation completed.\n");

      const previousTaskWebSocket = taskWebSocket;
      taskWebSocket = undefined;
      previousTaskWebSocket.close();
      await stopChild(gateway.child);
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);

      const resumedTicketResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/ws-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner" }),
      });
      expect(resumedTicketResponse.status).toBe(200);
      const { ticket: resumedTicket } = await resumedTicketResponse.json() as { ticket: string };
      taskWebSocket = new WebSocket("ws://127.0.0.1:" + gatewayPort + "/ws?ticket=" + encodeURIComponent(resumedTicket));
      await once(taskWebSocket, "open");

      const restoredWritePlan = await waitFor(async () => {
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
          headers: { authorization: "Bearer " + token },
        });
        if (!response.ok) return null;
        const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
        const plan = body.operation_plan_status?.plans?.find((candidate) => candidate.plan_id === writePlanId);
        const step = (plan?.steps as Array<Record<string, unknown>> | undefined)?.find((candidate) =>
          candidate.step_id === writeStepId);
        return plan?.status === "results_verified" && step?.status === "verified" &&
          (step.binding as Record<string, unknown> | undefined)?.memory_status === "receipt_confirmed" ? plan : null;
      }, gateway, "Gateway restart did not restore the verified synthetic file.write receipt");
      expect(restoredWritePlan).toMatchObject({ plan_id: writePlanId,
        task_identity_digest: writePlan.task_identity_digest, revision_digest: writeRevision });
      expect(readdirSync(fileRoot).filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name)))
        .toEqual(createdFiles);

      const syntheticReplanReply = waitForWebChatSend(taskWebSocket, "synthetic same-task replan");
      const replanControl = {
        task: "同じtaskの検証済み結果を踏まえて、次の未実行候補計画を作成してください。",
        goal_purpose_binding: goalPurposeBinding,
        parent_plan: { plan_id_digest: writePlanId, revision_digest: writeRevision },
        source_observation_refs: [{ plan_id_digest: writePlanId, revision_digest: writeRevision,
          step_id_digest: writeStepId }],
      };
      const replanResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: writePlanId, revision_digest: writeRevision,
          content: "plan:compute " + JSON.stringify(replanControl) }),
      });
      expect(replanResponse.status).toBe(202);
      expect((await syntheticReplanReply).length).toBeGreaterThan(0);
      const verificationPlan = await waitFor(async () => {
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
          headers: { authorization: "Bearer " + token },
        });
        if (!response.ok) return null;
        const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
        return body.operation_plan_status?.plans?.find((plan) => plan.plan_id !== writePlanId &&
          plan.task_identity_digest === writePlan.task_identity_digest && Array.isArray(plan.steps) &&
          (plan.steps as Array<Record<string, unknown>>).some((step) => step.operation === "file.search")) ?? null;
      }, gateway, "file.write M receipt did not reach the same-task file.search planner");
      expect(verificationPlan).toMatchObject({ task_identity_digest: writePlan.task_identity_digest,
        goal_purpose_binding_status: "current", goal_purpose_relation: { candidate_outcome: "unknown" } });
      const verificationStep = (verificationPlan.steps as Array<Record<string, unknown>>)
        .find((step) => step.operation === "file.search");
      expect(verificationStep).toMatchObject({ status: "not_selected" });

      const verificationPlanId = String(verificationPlan.plan_id);
      const verificationRevision = String(verificationPlan.revision_digest);
      const verificationStepId = String(verificationStep?.step_id);
      const verificationRelationResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/goal-purpose-relation-review", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ plan_id_digest: verificationPlanId, revision_digest: verificationRevision, outcome: "supports" }),
      });
      expect(verificationRelationResponse.status).toBe(202);
      const verificationRelation = await verificationRelationResponse.json() as { command_id?: string; status?: string };
      expect(verificationRelation.status).toBe("approval_required");
      const verificationQueue = await loadQueue();
      const verificationPending = verificationQueue.pending_approvals
        .find((item) => item.command_id === verificationRelation.command_id);
      expect(verificationPending).toMatchObject({ approval_level: "L3_final_review", final_review_required: true,
        goal_purpose_relation_review: { outcome: "supports", review_status: "required", may_execute: false } });
      const verificationRelationContentResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(verificationRelation.command_id)) + "/content",
        { method: "POST", headers: { authorization: "Bearer " + resumeToken } },
      );
      expect(verificationRelationContentResponse.status).toBe(200);
      const verificationRelationContent = await verificationRelationContentResponse.json() as Record<string, unknown>;
      expect(verificationRelationContent).toMatchObject({ kind: "goal_purpose_relation",
        task: SYNTHETIC_FILE_WRITE_PLAN_TASK,
        purpose_text: proposedPurpose, candidate_outcome: "unknown", may_execute: false });
      const verificationRelationApprovalResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(verificationRelation.command_id)),
        { method: "POST", headers: { authorization: "Bearer " + resumeToken, "content-type": "application/json" },
          body: JSON.stringify({ verdict: "approve", approval_token: verificationPending?.approval_token,
            content_review_digest: verificationRelationContent.command_digest }) },
      );
      expect(verificationRelationApprovalResponse.status).toBe(200);
      expect(await verificationRelationApprovalResponse.json()).toMatchObject({ ok: true, result: {
        approval: "approve", executed: false, status: "goal_purpose_relation_review_committed", outcome: "supports",
      } });

      const verificationReviewReply = waitForWebChatSend(taskWebSocket, "synthetic file.search review");
      const verificationReview = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: verificationPlanId, revision_digest: verificationRevision,
          content: "plan:review " + JSON.stringify({ plan_id: verificationPlanId, revision_digest: verificationRevision,
            step_id: verificationStepId, goal_purpose_binding: verificationPlan.goal_purpose_binding }) }),
      });
      expect(verificationReview.status).toBe(202);
      const verificationReviewOutput = await verificationReviewReply;
      expect(verificationReviewOutput.length).toBeGreaterThan(0);
      let completedVerificationPlan: { plan: Record<string, unknown>; step: Record<string, unknown> };
      try {
        completedVerificationPlan = await waitFor(async () => {
          const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
            headers: { authorization: "Bearer " + token },
          });
          if (!response.ok) return null;
          const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
          const plan = body.operation_plan_status?.plans?.find((candidate) => candidate.plan_id === verificationPlanId);
          const step = (plan?.steps as Array<Record<string, unknown>> | undefined)?.find((candidate) =>
            candidate.step_id === verificationStepId);
          return plan?.status === "results_verified" && step?.status === "verified" &&
            (step.binding as Record<string, unknown> | undefined)?.memory_status === "receipt_confirmed"
            ? { plan, step } : null;
        }, gateway, "synthetic same-task file.search did not reach a saved-result receipt");
      } catch (error) {
        const [snapshotResponse, approvalQueue] = await Promise.all([
          fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", { headers: { authorization: "Bearer " + token } }),
          loadQueue(),
        ]);
        const snapshot = snapshotResponse.ok
          ? await snapshotResponse.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } }
          : undefined;
        const current = snapshot?.operation_plan_status?.plans?.find((plan) => plan.plan_id === verificationPlanId);
        const steps = Array.isArray(current?.steps) ? current.steps as Array<Record<string, unknown>> : [];
        throw new Error(`${error instanceof Error ? error.message : String(error)}; review_reply=${verificationReviewOutput.slice(0, 2_000)}; ` +
          `plan_status=${String(current?.status ?? "missing")}; relation=${JSON.stringify(current?.goal_purpose_relation)}; ` +
          `steps=${JSON.stringify(steps.map((step) => ({ operation: step.operation, status: step.status, binding: step.binding })))}; ` +
          `approvals=${JSON.stringify(approvalQueue.pending_approvals.map((item) => ({ command_id: item.command_id,
            approval_level: item.approval_level, final_review_required: item.final_review_required,
            content_review_required: item.content_review_required })))}`);
      }
      expect(completedVerificationPlan.plan).toMatchObject({ status: "results_verified",
        goal_purpose_relation: { status: "owner_reviewed_supports", owner_review_outcome: "supports" } });
      expect(completedVerificationPlan.step).toMatchObject({ operation: "file.search", status: "verified",
        binding: { memory_status: "receipt_confirmed" } });

      const savedResultReply = waitForWebChatSend(taskWebSocket, "synthetic saved file.search result return");
      const savedResultResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: verificationPlanId, revision_digest: verificationRevision,
          content: "plan:result " + JSON.stringify({ plan_id: verificationPlanId, revision_digest: verificationRevision,
            step_id: verificationStepId }) }),
      });
      expect(savedResultResponse.status).toBe(202);
      const savedResultOutput = await savedResultReply;
      expect(savedResultOutput).toContain("保存時点のfile.search結果");
      expect(savedResultOutput).toContain(createdFiles[0]!);
      expect(savedResultOutput).toContain("現在のファイル状態は再検索していません");
      expect(savedResultOutput).toContain("検索完全性は不明です");
      expect(readdirSync(fileRoot).filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name)))
        .toEqual(createdFiles);
      expect(providerCalls).toBe(providerCallsBeforeSyntheticTask);

      // The unknown-result continuation asserts one exact search result. The
      // earlier synthetic note has already been reviewed and returned above;
      // remove only that fixture-owned temp file so it cannot change the
      // continuation search result cardinality.
      for (const name of createdFiles) rmSync(join(fileRoot, name));
      const filesBeforeUnknownWrite: string[] = [];
      expect(readdirSync(fileRoot).filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name)))
        .toHaveLength(0);
      const crashWindowExecutionDb = new DatabaseSync(join(stateRoot, "private-state", "execution-intents", "executor.sqlite"));
      const crashWindowPlanDb = new DatabaseSync(join(stateRoot, "private-state", "operation-plans", "j-state.sqlite"));
      let crashBarrierInstalled = false;
      let uncertainPlanId = "";
      let uncertainTaskIdentity = "";
      let crashedTicketId = "";
      let crashedExecutionEpoch = "";
      let crashedDeliveryDigest = "";
      try {
        const uncertainTaskReply = waitForWebChatSend(taskWebSocket, "synthetic unknown-result task");
        const uncertainTaskSubmission = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/task-compute", {
          method: "POST",
          headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
          body: JSON.stringify({ user: "c0802-owner", task: SYNTHETIC_FILE_WRITE_PLAN_TASK,
            goal_ref: goalRef, purpose_version: 2 }),
        });
        expect(uncertainTaskSubmission.status).toBe(202);
        expect((await uncertainTaskReply).length).toBeGreaterThan(0);
        const uncertainWritePlan = await waitFor(async () => {
          const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
            headers: { authorization: "Bearer " + token },
          });
          if (!response.ok) return null;
          const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
          return body.operation_plan_status?.plans?.find((plan) => plan.plan_id !== writePlanId &&
            Array.isArray(plan.steps) && (plan.steps as Array<Record<string, unknown>>)
              .some((step) => step.operation === "file.write")) ?? null;
        }, gateway, "second synthetic task did not reach its file.write plan");
        uncertainPlanId = String(uncertainWritePlan.plan_id);
        uncertainTaskIdentity = String(uncertainWritePlan.task_identity_digest);
        const uncertainRevision = String(uncertainWritePlan.revision_digest);
        const uncertainGoalBinding = uncertainWritePlan.goal_purpose_binding as {
          goal_ref: string; purpose_version: number; purpose_digest: string;
        };

        const uncertainRelationResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/goal-purpose-relation-review", {
          method: "POST",
          headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
          body: JSON.stringify({ plan_id_digest: uncertainPlanId, revision_digest: uncertainRevision, outcome: "supports" }),
        });
        expect(uncertainRelationResponse.status).toBe(202);
        const uncertainRelation = await uncertainRelationResponse.json() as { command_id?: string };
        const uncertainQueue = await loadQueue();
        const uncertainPending = uncertainQueue.pending_approvals.find((item) => item.command_id === uncertainRelation.command_id);
        const uncertainContentResponse = await fetch(
          "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(uncertainRelation.command_id)) + "/content",
          { method: "POST", headers: { authorization: "Bearer " + resumeToken } },
        );
        expect(uncertainContentResponse.status).toBe(200);
        const uncertainContent = await uncertainContentResponse.json() as Record<string, unknown>;
        const uncertainApprovalResponse = await fetch(
          "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(uncertainRelation.command_id)),
          { method: "POST", headers: { authorization: "Bearer " + resumeToken, "content-type": "application/json" },
            body: JSON.stringify({ verdict: "approve", approval_token: uncertainPending?.approval_token,
              content_review_digest: uncertainContent.command_digest }) },
        );
        expect(uncertainApprovalResponse.status).toBe(200);

        const currentPlanCheckpointRow = crashWindowPlanDb.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1")
          .get() as { checkpoint_json: string };
        const currentPlanCheckpoint = JSON.parse(currentPlanCheckpointRow.checkpoint_json) as {
          plans: Array<{ revisions: Array<{ plan: { plan_id: string } }> }>;
        };
        const targetPlanCheckpoint = currentPlanCheckpoint.plans.find((plan) =>
          operationPlanDigest(plan.revisions[0]!.plan.plan_id) === uncertainPlanId);
        expect(targetPlanCheckpoint).toBeDefined();
        const internalPlanId = targetPlanCheckpoint!.revisions[0]!.plan.plan_id.replace(/'/g, "''");
        // Restrict the delay to this task's command result; prior plans already have acknowledged receipts.
        // The completed Broker result is durable before this J write starts.
        crashWindowPlanDb.exec(`CREATE TRIGGER fixture_process_result_crash_barrier BEFORE UPDATE ON operation_plan_state
          WHEN EXISTS(SELECT 1 FROM json_each(NEW.checkpoint_json,'$.plans') AS p
            JOIN json_each(p.value,'$.bindings') AS b
            WHERE json_extract(p.value,'$.revisions[0].plan.plan_id')='${internalPlanId}'
              AND json_type(b.value,'$.delivery_digest')='text')
          BEGIN SELECT length(randomblob(134217728)); END;`);
        crashBarrierInstalled = true;

        const uncertainWriteStep = (uncertainWritePlan.steps as Array<Record<string, unknown>>)
          .find((step) => step.operation === "file.write");
        const uncertainWriteStepId = String(uncertainWriteStep?.step_id);
        const uncertainReviewResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
          method: "POST",
          headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
          body: JSON.stringify({ user: "c0802-owner", plan_id: uncertainPlanId, revision_digest: uncertainRevision,
            content: "plan:review " + JSON.stringify({ plan_id: uncertainPlanId, revision_digest: uncertainRevision,
              step_id: uncertainWriteStepId, goal_purpose_binding: uncertainGoalBinding }) }),
        });
        expect(uncertainReviewResponse.status).toBe(202);
        const effectDeadline = Date.now() + 15_000;
        let filesAtCrash: string[] = [];
        while (Date.now() < effectDeadline && filesAtCrash.length === filesBeforeUnknownWrite.length) {
          if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
            throw new Error(`Gateway exited before crash-window capture: ${gateway.stderr.join("")}`);
          }
          filesAtCrash = readdirSync(fileRoot)
            .filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name));
          if (filesAtCrash.length === filesBeforeUnknownWrite.length) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(filesAtCrash).toHaveLength(filesBeforeUnknownWrite.length + 1);
        const receiptDeadline = Date.now() + 20_000;
        let unsettledIntent: {
          ticket_id?: string; execution_epoch?: string; state?: string; task_identity_digest?: string; result_delivery_digest?: string;
          result_delivery_acknowledged?: boolean;
        } | undefined;
        let outboxRow: { delivery_digest: string; delivery_json: string } | undefined;
        while (Date.now() < receiptDeadline) {
          if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
            throw new Error(`Gateway exited before durable result capture: ${gateway.stderr.join("")}`);
          }
          const receiptRow = crashWindowExecutionDb.prepare(`SELECT receipt_json FROM execution_intents
            WHERE json_extract(receipt_json,'$.task_identity_digest')=? ORDER BY rowid DESC LIMIT 1`)
            .get(uncertainTaskIdentity) as { receipt_json: string } | undefined;
          if (receiptRow) {
            const receipt = JSON.parse(receiptRow.receipt_json) as typeof unsettledIntent;
            if (receipt?.state === "adapter_returned" && receipt.result_delivery_digest) {
              const delivery = crashWindowExecutionDb.prepare("SELECT delivery_digest,delivery_json FROM execution_result_outbox WHERE ticket_id=?")
                .get(receipt.ticket_id) as typeof outboxRow;
              if (delivery?.delivery_digest === receipt.result_delivery_digest) {
                unsettledIntent = receipt;
                outboxRow = delivery;
                break;
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(unsettledIntent).toBeDefined();
        expect(outboxRow).toBeDefined();
        expect(unsettledIntent).toMatchObject({ state: "adapter_returned", task_identity_digest: uncertainTaskIdentity,
          result_delivery_acknowledged: false });
        expect(unsettledIntent.result_delivery_digest).toMatch(/^[a-f0-9]{64}$/);
        crashedTicketId = String(unsettledIntent.ticket_id);
        crashedExecutionEpoch = String(unsettledIntent.execution_epoch);
        crashedDeliveryDigest = String(unsettledIntent.result_delivery_digest);
        expect(outboxRow?.delivery_digest).toBe(unsettledIntent.result_delivery_digest);
        const savedDelivery = JSON.parse(outboxRow!.delivery_json) as { feedback?: { command_id?: string } };
        expect(savedDelivery.feedback?.command_id).toBeTruthy();
        const planCheckpointRow = crashWindowPlanDb.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id=1")
          .get() as { checkpoint_json: string };
        const planCheckpoint = JSON.parse(planCheckpointRow.checkpoint_json) as {
          plans: Array<{ bindings: Array<Record<string, unknown>> }>;
        };
        const unadoptedBinding = planCheckpoint.plans.flatMap((plan) => plan.bindings)
          .find((binding) => binding.command_id === savedDelivery.feedback?.command_id);
        expect(unadoptedBinding).toBeDefined();
        expect(unadoptedBinding).not.toHaveProperty("delivery_digest");
        expect(unadoptedBinding).not.toHaveProperty("result_digest");
        expect(unadoptedBinding).not.toHaveProperty("memory_commit");
        expect(readFileSync(join(fileRoot, filesAtCrash.find((name) => !filesBeforeUnknownWrite.includes(name))!), "utf8"))
          .toBe("BLUE-TANUKI synthetic create-only operation completed.\n");
        expect(providerCalls).toBe(providerCallsBeforeSyntheticTask);
        await forceStopChild(gateway.child);
      } finally {
        if (gateway && gateway.child.exitCode === null && gateway.child.signalCode === null) {
          await forceStopChild(gateway.child);
        }
        if (crashBarrierInstalled) crashWindowPlanDb.exec("DROP TRIGGER fixture_process_result_crash_barrier");
        crashWindowPlanDb.close();
        crashWindowExecutionDb.close();
      }

      const uncertainTaskWebSocket = taskWebSocket;
      taskWebSocket = undefined;
      uncertainTaskWebSocket.close();
      await forceStopChild(gateway.child);
      gateway = spawnGateway(runtimeEnv);
      await waitForHealth(gatewayPort, gateway);

      const recoveredExecutionDb = new DatabaseSync(join(stateRoot, "private-state", "execution-intents", "executor.sqlite"));
      const recoveredOwnerDb = new DatabaseSync(join(stateRoot, "private-state", "gateway-runtime", "owner-state.sqlite"));
      try {
        const recoveredReceiptRow = recoveredExecutionDb.prepare("SELECT receipt_json FROM execution_intents WHERE ticket_id=?")
          .get(crashedTicketId) as { receipt_json: string } | undefined;
        expect(recoveredReceiptRow).toBeDefined();
        const recoveredReceipt = JSON.parse(recoveredReceiptRow!.receipt_json) as {
          state?: string; execution_epoch?: string; result_delivery_digest?: string; result_delivery_acknowledged?: boolean;
          result_delivery_disposition?: string; result_archived_by_epoch_digest?: string;
        };
        const currentOwner = recoveredOwnerDb.prepare("SELECT execution_epoch FROM gateway_owner_state WHERE singleton=1")
          .get() as { execution_epoch: string };
        expect(currentOwner.execution_epoch).not.toBe(crashedExecutionEpoch);
        expect(recoveredReceipt).toMatchObject({ state: "adapter_returned", execution_epoch: crashedExecutionEpoch,
          result_delivery_digest: crashedDeliveryDigest,
          result_delivery_acknowledged: true, result_delivery_disposition: "stale_generation_evidence",
          result_archived_by_epoch_digest: createHash("sha256").update(currentOwner.execution_epoch).digest("hex") });
        expect(Number((recoveredExecutionDb.prepare("SELECT COUNT(*) AS count FROM execution_result_outbox WHERE ticket_id=?")
          .get(crashedTicketId) as { count: number }).count)).toBe(1);
      } finally {
        recoveredExecutionDb.close();
        recoveredOwnerDb.close();
      }

      const uncertainResumeTicketResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/ws-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner" }),
      });
      expect(uncertainResumeTicketResponse.status).toBe(200);
      const { ticket: uncertainResumeTicket } = await uncertainResumeTicketResponse.json() as { ticket: string };
      taskWebSocket = new WebSocket("ws://127.0.0.1:" + gatewayPort + "/ws?ticket=" + encodeURIComponent(uncertainResumeTicket));
      await once(taskWebSocket, "open");

      const restoredUnknownPlan = await waitFor(async () => {
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
          headers: { authorization: "Bearer " + token },
        });
        if (!response.ok) return null;
        const body = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
        const plan = body.operation_plan_status?.plans?.find((candidate) => candidate.plan_id === uncertainPlanId);
        const step = (plan?.steps as Array<Record<string, unknown>> | undefined)?.find((candidate) =>
          candidate.operation === "file.write");
        return step?.status === "outcome_unknown" ? { plan, step, plans: body.operation_plan_status?.plans ?? [] } : null;
      }, gateway, "Gateway restart did not restore the unknown file.write outcome");
      expect(restoredUnknownPlan.plan).toMatchObject({ plan_id: uncertainPlanId,
        task_identity_digest: uncertainTaskIdentity, status: "awaiting_step_review" });
      expect(restoredUnknownPlan.step).toMatchObject({ status: "outcome_unknown",
        external_receipt_observation: "not_recorded", binding: { memory_status: "not_recorded" } });
      expect(restoredUnknownPlan.plans.filter((plan) => plan.task_identity_digest === uncertainTaskIdentity &&
        Array.isArray(plan.steps) && (plan.steps as Array<Record<string, unknown>>)
          .some((step) => step.operation === "file.search"))).toHaveLength(0);

      const recoveryInspectionResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/recovery/inspection", {
        headers: { authorization: "Bearer " + maintenanceToken },
      });
      expect(recoveryInspectionResponse.status).toBe(200);
      const recoveryInspection = await recoveryInspectionResponse.json() as {
        boundary_valid?: boolean;
        execution_archive_evidence?: { records?: Array<Record<string, unknown>> };
        operation_plan_correlations?: Array<Record<string, unknown>>;
      };
      expect(recoveryInspection.boundary_valid).toBe(true);
      const archivedReceipt = recoveryInspection.execution_archive_evidence?.records?.filter((record) =>
        record.ticket_digest === createHash("sha256").update(crashedTicketId, "utf8").digest("hex"));
      expect(archivedReceipt).toHaveLength(1);
      const relatedBindings = recoveryInspection.operation_plan_correlations?.filter((binding) =>
        binding.command_key_digest === archivedReceipt![0]!.command_key_digest);
      expect(relatedBindings).toHaveLength(1);
      expect(relatedBindings![0]).toMatchObject({
        plan_id_digest: uncertainPlanId,
        status: "outcome_unknown",
        binding_integrity: "verified",
        broker_correlation: "matched",
        delivery_correlation: "j_not_recorded",
      });
      expect(JSON.stringify(recoveryInspection)).not.toContain("BLUE-TANUKI synthetic create-only operation completed.");

      const filesAfterRestart = readdirSync(fileRoot)
        .filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name));
      expect(filesAfterRestart).toHaveLength(filesBeforeUnknownWrite.length + 1);
      expect(filesAfterRestart).toEqual(expect.arrayContaining([...filesBeforeUnknownWrite]));
      expect(readFileSync(join(fileRoot, filesAfterRestart.find((name) => !filesBeforeUnknownWrite.includes(name))!), "utf8"))
        .toBe("BLUE-TANUKI synthetic create-only operation completed.\n");

      const uncertainFile = filesAfterRestart.find((name) => !filesBeforeUnknownWrite.includes(name));
      expect(uncertainFile).toBeDefined();
      const unknownPlan = restoredUnknownPlan.plan as Record<string, unknown>;
      const unknownRevision = String(unknownPlan.revision_digest);
      const unknownStepId = String((restoredUnknownPlan.step as Record<string, unknown>).step_id);
      const unknownGoalBinding = unknownPlan.goal_purpose_binding as {
        goal_ref: string; purpose_version: number; purpose_digest: string;
      };

      const localObservationReply = waitForWebChatSend(taskWebSocket, "unknown file.write local state observation");
      const localObservationResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: uncertainPlanId, revision_digest: unknownRevision,
          content: "plan:reconcile " + JSON.stringify({ plan_id: uncertainPlanId, revision_digest: unknownRevision,
            step_id: unknownStepId }) }),
      });
      expect(localObservationResponse.status).toBe(202);
      const localObservationOutput = await localObservationReply;
      expect(localObservationOutput).toContain("sandbox内file.write対象の状態観測");
      expect(localObservationOutput).toContain("digest-onlyの非権威観測をMへ保存しました");
      expect(localObservationOutput).toContain("outcome_unknownのままです");
      expect(localObservationOutput).not.toContain(uncertainFile!);

      const ownerObservationReplanReply = waitForWebChatSend(taskWebSocket, "owner-selected local state same-task replan");
      const ownerObservationReplanControl = {
        task: "ownerが現在状態のdigest-only observationを候補計算の文脈として明示選択しました。元のfile.write実行は結果不明のまま維持し、その実行成功や目的達成を推定せず、次の未実行候補だけを作成してください。",
        goal_purpose_binding: unknownGoalBinding,
        parent_plan: { plan_id_digest: uncertainPlanId, revision_digest: unknownRevision },
        source_observation_refs: [{ plan_id_digest: uncertainPlanId, revision_digest: unknownRevision,
          step_id_digest: unknownStepId, owner_selected_observation: "local_file_state" }],
      };
      const ownerObservationReplanResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: uncertainPlanId, revision_digest: unknownRevision,
          content: "plan:compute " + JSON.stringify(ownerObservationReplanControl) }),
      });
      expect(ownerObservationReplanResponse.status).toBe(202);
      const ownerObservationReplanOutput = await ownerObservationReplanReply;
      expect(ownerObservationReplanOutput.length).toBeGreaterThan(0);
      const ownerObservationReplanResponseSummary = ownerObservationReplanOutput.includes("\"plan\"")
        ? "raw_plan_candidate_returned"
        : ownerObservationReplanOutput.includes("記憶引用を検証できなかったため")
          ? "generic_memory_citation_gate_rejected"
          : "other_webchat_response";

      let ownerObservationPlanDiagnostics: Record<string, unknown> = {};
      let ownerObservationPlan: Record<string, unknown>;
      try {
        ownerObservationPlan = await waitFor(async () => {
        const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
          headers: { authorization: "Bearer " + token },
        });
        if (!response.ok) {
          ownerObservationPlanDiagnostics = { snapshot_http_status: response.status };
          return null;
        }
        const body = await response.json() as { operation_plan_status?: {
          status?: string; used_for_authority?: boolean; plans?: Array<Record<string, unknown>>;
        }; hds?: Record<string, unknown> };
        const operationPlanStatus = body.operation_plan_status;
        const plans = operationPlanStatus?.plans ?? [];
        const hdsOperationPlans = body.hds?.operation_plans as {
          schema_version?: string; plans?: Array<Record<string, unknown>>;
        } | undefined;
        ownerObservationPlanDiagnostics = { snapshot_keys: Object.keys(body),
          hds_keys: Object.keys(body.hds ?? {}), status: operationPlanStatus?.status,
          hds_plan_schema_version: hdsOperationPlans?.schema_version,
          hds_plan_count: hdsOperationPlans?.plans?.length,
          hds_plan_statuses: hdsOperationPlans?.plans?.map((candidate) => ({ status: candidate.status,
            step_operations: (candidate.steps as Array<Record<string, unknown>> | undefined)
              ?.map((step) => ({ operation: step.operation, status: step.status })) })),
          used_for_authority: operationPlanStatus?.used_for_authority, plan_count: plans.length,
          plans: plans.map((candidate) => ({
          plan_id: candidate.plan_id,
          task_identity_digest: candidate.task_identity_digest,
          status: candidate.status,
          source_observations: (candidate.compute_source_observations as Array<Record<string, unknown>> | undefined)
            ?.map((observation) => ({ source: observation.source, plan_id_digest: observation.plan_id_digest,
              plan_binding_status: observation.plan_binding_status })),
          step_operations: (candidate.steps as Array<Record<string, unknown>> | undefined)
            ?.map((step) => ({ operation: step.operation, status: step.status })),
          })) };
        return plans.find((candidate) => {
          const steps = candidate.steps as Array<Record<string, unknown>> | undefined;
          return candidate.plan_id !== uncertainPlanId && candidate.task_identity_digest === uncertainTaskIdentity &&
            steps?.some((step) => step.operation === "file.search");
        }) ?? null;
        }, gateway, `owner-selected file.write state did not reach a same-task read-only search candidate; ` +
          `WebChat response=${ownerObservationReplanResponseSummary}; ` +
          `operation_plan_status=${JSON.stringify(ownerObservationPlanDiagnostics)}`, 30_000);
      } catch (error) {
        const candidateEvents = existsSync(join(auditDir, "audit.jsonl"))
          ? readFileSync(join(auditDir, "audit.jsonl"), "utf8").split("\n").flatMap((line) => {
            try {
              const entry = JSON.parse(line) as { log?: { kind?: string; event?: string; reason?: string } };
              return entry.log?.kind === "operation_plan" &&
                ["candidate_retained", "candidate_rejected"].includes(entry.log.event ?? "")
                ? [{ event: entry.log.event, reason: entry.log.reason ?? null }] : [];
            } catch { return []; }
          })
          : [];
        throw new Error(`${error instanceof Error ? error.message : "candidate wait failed"}; ` +
          `candidate_events=${JSON.stringify(candidateEvents)}; ` +
          `operation_plan_status=${JSON.stringify(ownerObservationPlanDiagnostics)}`);
      }
      expect(ownerObservationPlan).toMatchObject({ task_identity_digest: uncertainTaskIdentity,
        goal_purpose_binding_status: "current", goal_purpose_relation: { candidate_outcome: "unknown" } });
      const ownerSelectedObservation = (ownerObservationPlan.compute_source_observations as Array<Record<string, unknown>>)
        .find((observation) => observation.source === "owner_selected_local_file_state");
      expect(ownerSelectedObservation).toBeDefined();
      expect(ownerSelectedObservation).toMatchObject({ operation: "file.write", plan_id_digest: uncertainPlanId,
        task_identity_digest: uncertainTaskIdentity, plan_binding_status: "outcome_unknown",
        plan_validation_status: "owner_selected_observation", effect_observation: "observed_target_state",
        adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
      const ownerObservationPlanId = String(ownerObservationPlan.plan_id);
      const ownerObservationRevision = String(ownerObservationPlan.revision_digest);
      const ownerObservationStep = (ownerObservationPlan.steps as Array<Record<string, unknown>>)
        .find((step) => step.operation === "file.search");
      expect(ownerObservationStep).toMatchObject({ status: "not_selected" });
      const ownerObservationStepId = String(ownerObservationStep?.step_id);

      const ownerObservationRelation = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/goal-purpose-relation-review", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ plan_id_digest: ownerObservationPlanId, revision_digest: ownerObservationRevision,
          outcome: "supports" }),
      });
      expect(ownerObservationRelation.status).toBe(202);
      const ownerObservationRelationProposal = await ownerObservationRelation.json() as { command_id?: string; status?: string };
      expect(ownerObservationRelationProposal.status).toBe("approval_required");
      const ownerObservationQueue = await loadQueue();
      const ownerObservationPending = ownerObservationQueue.pending_approvals
        .find((item) => item.command_id === ownerObservationRelationProposal.command_id);
      expect(ownerObservationPending).toMatchObject({ approval_level: "L3_final_review", final_review_required: true,
        content_review_required: true, goal_purpose_relation_review: { outcome: "supports", review_status: "required",
          used_for_authority: false, may_execute: false } });
      const ownerObservationContentResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(ownerObservationRelationProposal.command_id)) + "/content",
        { method: "POST", headers: { authorization: "Bearer " + resumeToken } },
      );
      expect(ownerObservationContentResponse.status).toBe(200);
      const ownerObservationContent = await ownerObservationContentResponse.json() as Record<string, unknown>;
      expect(ownerObservationContent).toMatchObject({ kind: "goal_purpose_relation",
        task: SYNTHETIC_FILE_WRITE_PLAN_TASK, candidate_outcome: "unknown", may_execute: false });
      const ownerObservationApprovalResponse = await fetch(
        "http://127.0.0.1:" + gatewayPort + "/approval/" + encodeURIComponent(String(ownerObservationRelationProposal.command_id)),
        { method: "POST", headers: { authorization: "Bearer " + resumeToken, "content-type": "application/json" },
          body: JSON.stringify({ verdict: "approve", approval_token: ownerObservationPending?.approval_token,
            content_review_digest: ownerObservationContent.command_digest }) },
      );
      expect(ownerObservationApprovalResponse.status).toBe(200);
      expect(await ownerObservationApprovalResponse.json()).toMatchObject({ ok: true, result: {
        approval: "approve", executed: false, status: "goal_purpose_relation_review_committed", outcome: "supports",
      } });

      const ownerObservationSearchReview = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: ownerObservationPlanId,
          revision_digest: ownerObservationRevision,
          content: "plan:review " + JSON.stringify({ plan_id: ownerObservationPlanId,
            revision_digest: ownerObservationRevision, step_id: ownerObservationStepId,
            goal_purpose_binding: ownerObservationPlan.goal_purpose_binding }) }),
      });
      expect(ownerObservationSearchReview.status).toBe(202);
      let completedOwnerObservationSearch: { plan: Record<string, unknown>; step: Record<string, unknown> };
      try {
        completedOwnerObservationSearch = await waitFor(async () => {
          const response = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
            headers: { authorization: "Bearer " + token },
          });
          if (!response.ok) return null;
          const body = await response.json() as { operation_plan_status?: {
            status?: string; plans?: Array<Record<string, unknown>>;
          } };
          const plan = body.operation_plan_status?.plans?.find((candidate) => candidate.plan_id === ownerObservationPlanId);
          const step = (plan?.steps as Array<Record<string, unknown>> | undefined)?.find((candidate) =>
            candidate.step_id === ownerObservationStepId);
          return plan?.status === "results_verified" && step?.status === "verified" &&
            (step.binding as Record<string, unknown> | undefined)?.memory_status === "receipt_confirmed"
            ? { plan, step } : null;
        }, gateway, "owner-selected same-task file.search did not persist its J/M receipt");
      } catch (error) {
        const [snapshotResponse, approvalQueue] = await Promise.all([
          fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", { headers: { authorization: "Bearer " + token } }),
          loadQueue(),
        ]);
        const snapshot = snapshotResponse.ok ? await snapshotResponse.json() as {
          operation_plan_status?: { status?: string; plans?: Array<Record<string, unknown>> };
        } : undefined;
        const current = snapshot?.operation_plan_status?.plans?.find((plan) => plan.plan_id === ownerObservationPlanId);
        const steps = Array.isArray(current?.steps) ? current.steps as Array<Record<string, unknown>> : [];
        throw new Error(`${error instanceof Error ? error.message : "search result wait failed"}; ` +
          `plan_status=${String(current?.status ?? snapshot?.operation_plan_status?.status ?? "missing")}; ` +
          `relation=${JSON.stringify(current?.goal_purpose_relation)}; ` +
          `steps=${JSON.stringify(steps.map((step) => ({ operation: step.operation, status: step.status, binding: step.binding })))}; ` +
          `approvals=${JSON.stringify(approvalQueue.pending_approvals.map((item) => ({ approval_level: item.approval_level,
            final_review_required: item.final_review_required, content_review_required: item.content_review_required })))}; ` +
          `gateway_stderr=${JSON.stringify(gateway?.stderr.slice(-4) ?? [])}`);
      }
      expect(completedOwnerObservationSearch.plan).toMatchObject({ status: "results_verified",
        goal_purpose_relation: { status: "owner_reviewed_supports", owner_review_outcome: "supports" } });
      expect(completedOwnerObservationSearch.step).toMatchObject({ operation: "file.search", status: "verified",
        binding: { memory_status: "receipt_confirmed" } });

      const ownerObservationSavedResultReply = waitForWebChatSend(taskWebSocket, "owner-selected saved file.search result return");
      const ownerObservationSavedResultResponse = await fetch("http://127.0.0.1:" + gatewayPort + "/owner/inbound", {
        method: "POST",
        headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0802-owner", plan_id: ownerObservationPlanId,
          revision_digest: ownerObservationRevision,
          content: "plan:result " + JSON.stringify({ plan_id: ownerObservationPlanId,
            revision_digest: ownerObservationRevision, step_id: ownerObservationStepId }) }),
      });
      expect(ownerObservationSavedResultResponse.status).toBe(202);
      const ownerObservationSavedResult = await ownerObservationSavedResultReply;
      expect(ownerObservationSavedResult).toContain("保存時点のfile.search結果");
      expect(ownerObservationSavedResult).toContain(uncertainFile!);
      expect(ownerObservationSavedResult).toContain("現在のファイル状態は再検索していません");
      expect(ownerObservationSavedResult).toContain("検索完全性は不明です");

      const finalUnknownParent = await fetch("http://127.0.0.1:" + gatewayPort + "/runtime/snapshot", {
        headers: { authorization: "Bearer " + token },
      });
      expect(finalUnknownParent.status).toBe(200);
      const finalUnknownParentSnapshot = await finalUnknownParent.json() as {
        operation_plan_status?: { plans?: Array<Record<string, unknown>> };
      };
      const finalUncertainWritePlan = finalUnknownParentSnapshot.operation_plan_status?.plans
        ?.find((candidate) => candidate.plan_id === uncertainPlanId);
      const finalUncertainWriteStep = (finalUncertainWritePlan?.steps as Array<Record<string, unknown>> | undefined)
        ?.find((candidate) => candidate.operation === "file.write");
      expect(finalUncertainWriteStep).toMatchObject({ status: "outcome_unknown",
        binding: { memory_status: "not_recorded" } });
      expect(readdirSync(fileRoot).filter((name) => /^blue-tanuki-synthetic-[a-f0-9]{20}\.txt$/.test(name)))
        .toEqual(filesAfterRestart);
      expect(providerCalls).toBe(providerCallsBeforeSyntheticTask);
    } finally {
      taskWebSocket?.close();
      if (gateway) await stopChild(gateway.child);
      await closeServer(provider);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
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
    BLUE_TANUKI_OWNER_TOKEN: ownerToken,
    BLUE_TANUKI_MAINTENANCE_TOKEN: maintenanceToken,
    BLUE_TANUKI_FILE_ROOT: join(auditDir, "file-root"),
    BLUE_TANUKI_STATE_ROOT: join(auditDir, "state"),
    BLUE_TANUKI_MEMORY_FILE: join(auditDir, "memory.jsonl"),
    BLUE_TANUKI_AUDIT_DIR: auditDir,
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: historyFile,
    BLUE_TANUKI_SESSION_DIR: sessionDir,
    BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
    BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({
      "c0801-local": { capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0, currency: "USD" } },
    }),
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

async function waitFor<T>(probe: () => Promise<T | null> | T | null, gateway: CapturedProcess,
  failureMessage: string, timeout_ms = 8_000): Promise<T> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${failureMessage}\nGateway stderr:\n${gateway.stderr.join("")}`);
}

async function forceStopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  const closed = once(child, "close");
  if (child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL")) {
    throw new Error("test-owned Gateway child could not be terminated");
  }
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
  return spawnCaptured([...tsxArgs, "apps/gateway/src/main.ts", "--serve"], env);
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
  const child = spawn(process.execPath, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.add(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("close", () => children.delete(child));
  return { child, stdout, stderr };
}

async function waitForHealth(port: number, gateway: CapturedProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
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
  throw new Error(`gateway health timed out\nstdout:\n${gateway.stdout.join("")}\nstderr:\n${gateway.stderr.join("")}`);
}

function waitForWebChatSend(webSocket: WebSocket, label = "operator request"): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WebChat ${label} result timed out`)), 15_000);
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
  if (!children.has(child)) return;
  const closed = once(child, "close");
  if (child.exitCode !== null || child.signalCode !== null) { await closed; children.delete(child); return; }
  child.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!ended) {
    if (child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL")) {
      throw new Error("test-owned Gateway child could not be terminated");
    }
    await closed;
  }
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
