import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HDSUpperController, evaluateApproval, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { createGmailWriteTool, Executor, createExecutorApprovalAuthority, gmailWriteTool, LLMComputeAdapter,
  ToolRegistry, type LLMRequest, type LLMResponse } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, type InboundRequest, type OperationPlan } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { operationResultMemoryStorage } from "../src/operation_result_memory_config.js";
import { ingestLocalInspectionReceipt } from "../src/external_receipt_observation.js";
import { localInspectionReconciliationMessage, runLocalInspectionReconciliation } from "../src/local_inspection_runtime.js";
import { executionAdmissionForCommand, reconcileExecutionResults } from "../src/reconcile_execution_results.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const commandKey = (commandId: string): string => digest(JSON.stringify(["gateway-executor-command.v1", commandId]));
const FIXTURE_TOKEN = "local-inspection-only-token";

interface AcceptedMutation {
  idempotency_key: string;
  command_digest: string;
  payload_digest: string;
  receipt_id: string;
}

function inspectionServer(): {
  server: Server;
  url: Promise<string>;
  status: () => { effects: number; read_queries: number; accepted: AcceptedMutation[] };
} {
  const accepted: AcceptedMutation[] = [];
  let effects = 0;
  let readQueries = 0;
  let dropNextResponse = true;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && /^\/reconcile\/[a-f0-9]{64}$/.test(url.pathname)) {
        readQueries += 1;
        const key = decodeURIComponent(url.pathname.slice("/reconcile/".length));
        const matches = accepted.filter((record) => record.idempotency_key === key);
        const status = matches.length === 0 ? "not_found" : matches.length === 1 ? "accepted" : "ambiguous";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status, matches }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/send" ||
          request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}` ||
          request.headers["x-google-path"] !== "/gmail/v1/users/me/messages/send") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as IncomingMessage) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const key = request.headers["idempotency-key"];
      const commandDigest = request.headers["x-command-digest"];
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) ||
          typeof commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(commandDigest) || !body) {
        response.writeHead(400).end();
        return;
      }
      // Deliberately non-idempotent: every POST creates another effect, even when its key repeats.
      effects += 1;
      const record = {
        idempotency_key: key,
        command_digest: commandDigest,
        payload_digest: digest(body),
        receipt_id: `inspection-receipt-${effects}`,
      };
      accepted.push(record);
      if (dropNextResponse) {
        dropNextResponse = false;
        response.destroy();
        return;
      }
      response.writeHead(202, { "content-type": "application/json", "x-request-id": record.receipt_id });
      response.end(JSON.stringify({ id: record.receipt_id, status: "accepted" }));
    })().catch(() => { if (!response.destroyed) response.destroy(); });
  });
  const url = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, url, status: () => ({ effects, read_queries: readQueries, accepted: [...accepted] }) };
}

function request(content: string, user = "fixture-owner", operatorSurface = "developer", channel = "webchat"): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel, user, timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": operatorSurface } });
}

function candidate(planRequestId: string): OperationPlan {
  const target = { kind: "external_service" as const, id: "gmail" };
  const parameters = { operation: "message.send", to: "inspection@example.invalid", subject: "synthetic D08.01",
    body_text: "local inspection fixture only" };
  return {
    version: "operation-core.v1", plan_id: `inspection-plan-${planRequestId}`, request_id: planRequestId,
    state: "planned", steps: [{ step_id: "send-one", operation: "gmail.write", target, state: "planned",
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false, parameters,
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "synthetic-accepted", method: "result_equals", target,
          expected: { mutation_status: "confirmed" } }],
        compensation: { available: false, reason: "an external send cannot be recalled" } } }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true,
  };
}

function approvedByFixture(command: Parameters<ReturnType<typeof createExecutorApprovalAuthority>["approve"]>[0],
  authority: ReturnType<typeof createExecutorApprovalAuthority>) {
  const evaluation = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
  return authority.approve(command, {
    source: evaluation.final_review_required ? "human_final_review" : "approval_gate",
    decision: evaluation.final_review_required ? "approve" : "allow",
    approved_by: "fixture-owner", approved_at_ms: Date.now(), upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: evaluation.context.operation, risk: evaluation.risk,
    final_review_required: evaluation.final_review_required, reason: "synthetic local inspection confirmation",
  });
}

function reviewedSend(hds: HDSUpperController, plan: OperationPlan) {
  const saved = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: saved.plan_id,
    revision_digest: saved.revision_digest, step_id: operationPlanDigest("send-one") })}`));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("C候補→J選択→単回Broker作用→結果不明の読取照合", () => {
  it("非冪等検査APIの受理応答を失っても、再起動・J再配送・照合で二重作用しない", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-external-action-reconcile-"));
    const executionPath = join(root, "executor.sqlite");
    const planPath = join(root, "j.sqlite");
    const memory = operationResultMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") });
    const inspection = inspectionServer();
    let executionStore: GatewayExecutionIntentStore | undefined;
    let planStore: OperationPlanStateStore | undefined;
    let closeMemory: (() => void) | undefined;
    let hds: HDSUpperController;
    try {
      const endpoint = await inspection.url;
      executionStore = new GatewayExecutionIntentStore(executionPath);
      planStore = new OperationPlanStateStore(planPath);
      const createHds = (state: OperationPlanStateStore) => {
        const controller = new HDSUpperController({ operation_plan_state: state, operation_plan_memory: memory });
        closeMemory = () => controller.closeOperationPlanMemory();
        return controller;
      };
      hds = createHds(planStore);
      const tools = new ToolRegistry();
      const observedRequests: Array<{ idempotency_key?: string; command_digest?: string; request_payload_digest?: string }> = [];
      vi.stubEnv("GMAIL_ACCESS_TOKEN", FIXTURE_TOKEN);
      const fixtureGmailTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: FIXTURE_TOKEN }, request: async (target) => {
        const requestPayload = target.body ?? "";
        observedRequests.push({ idempotency_key: target.idempotency_key, command_digest: target.command_digest,
          request_payload_digest: digest(requestPayload) });
        const response = await fetch(new URL("/send", endpoint), { method: target.method,
          headers: { authorization: `Bearer ${target.token}`, "content-type": target.contentType ?? "application/json",
            "idempotency-key": target.idempotency_key!, "x-command-digest": target.command_digest!,
            "x-google-path": target.path }, body: requestPayload });
        return { status: response.status, ok: response.ok, content_type: response.headers.get("content-type"),
          body: await response.text(), truncated: false, request_id: response.headers.get("x-request-id") };
      } });
      vi.spyOn(gmailWriteTool, "invoke").mockImplementation(fixtureGmailTool.invoke);
      tools.register(gmailWriteTool);
      const authority = createExecutorApprovalAuthority({ execution_store: executionStore });
      const source = request("plan:compute 合成宛先へ一件送信し、受理状態を読取照合する");
      const plan = candidate(source.id);
      const executor = new Executor({ approval_authority: authority, tools,
        llm: { name: "fixture-candidate-only", call: async () => ({ content: JSON.stringify(plan), model: "fixture", tokens_used: 0 }) } });

      const computeCommand = hds.decide(source).command;
      if (!computeCommand || computeCommand.type !== "llm_call") throw new Error("C candidate request was not issued");
      const computeFeedback = await executor.execute(approvedByFixture(computeCommand, authority));
      expect(computeFeedback.result).toMatchObject({ operation_core: { status: "valid_plan" } });
      finalizeCommandOutput({ hds, command: computeCommand, feedback: computeFeedback, request_id: source.id, target_surface: "channel" });
      expect(hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.operation).toBe("gmail.write");

      const review = reviewedSend(hds, plan);
      const command = review.command;
      if (!command || command.type !== "tool_call") throw new Error("J did not bind the selected Gmail adapter step");
      const approvalEvaluation = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
      expect(approvalEvaluation.context.operation).toBe("google.write");
      expect(approvalEvaluation.final_review_required).toBe(true);
      const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
      const targetVersion = await executor.inspectCommandTargetVersion(command, undefined, operationPlanBindingDigest);
      const hdsBinding = hds.createExecutionAuthorityBinding(command, targetVersion);
      const approved = authority.approve(command, {
        source: approvalEvaluation.final_review_required ? "human_final_review" : "approval_gate",
        decision: "approve", approved_by: "fixture-owner", approved_at_ms: Date.now(),
        upstream_commit_hash: command.upstream_decision.commit_hash, operation: approvalEvaluation.context.operation,
        risk: approvalEvaluation.risk, final_review_required: approvalEvaluation.final_review_required,
        reason: "synthetic local inspection confirmation",
      }, undefined, hdsBinding, targetVersion);
      const admission = executionAdmissionForCommand(command, authority.receipt(approved));
      expect(hds.beginOperationPlanAttempt(command, admission)).toBe(true);
      const feedback = await executor.execute(approved, { save_result_delivery: true });
      expect(feedback.status).toBe("failed");
      expect(feedback.operation_core_result).toMatchObject({ execution_boundary: "tool_adapter", action_outcome: "unknown", used_for_authority: false });
      expect(observedRequests).toHaveLength(1);
      const command_key = commandKey(command.id);
      expect(observedRequests[0]).toMatchObject({ idempotency_key: command_key,
        command_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(authority.receipt(approved)?.state).toBe("outcome_unknown");
      finalizeCommandOutput({ hds, command, feedback, target_surface: "channel", request_id: review.log.request_id });
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
      expect(hds.getAudit().verify()).toBe(true);
      expect(inspection.status().effects).toBe(1);

      const originalReceiptId = inspection.status().accepted[0]?.receipt_id;
      const currentEpoch = randomUUID();
      for (let restart = 0; restart < 3; restart += 1) {
        hds.closeOperationPlanMemory();
        planStore.close();
        executionStore.close();
        planStore = new OperationPlanStateStore(planPath);
        executionStore = new GatewayExecutionIntentStore(executionPath);
        hds = createHds(planStore);
        const jState = hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status;
        expect(jState).toBe("outcome_unknown");
        expect(reconcileExecutionResults(hds, executionStore, currentEpoch)).toEqual({
          adopted: 0, deferred: 0, stale_generation_archived: restart === 0 ? 1 : 0,
        });
        expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
        const staleReview = reviewedSend(hds, plan);
        expect(staleReview.command).toBeNull();

        const receipt = executionStore.lookupCommand(command_key);
        expect(receipt).toMatchObject({ state: "outcome_unknown", command_key,
          command_digest: observedRequests[0]!.command_digest, used_for_authority: false });
        const currentPlan = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
        if (restart === 0) {
          const control = { plan_id: currentPlan.plan_id, revision_digest: currentPlan.revision_digest,
            step_id: currentPlan.steps[0]!.step_id };
          const unauthorizedRequest = request(`plan:reconcile ${JSON.stringify(control)}`, "other-owner");
          expect(hds.decide(unauthorizedRequest).command).toBeNull();
          const wrongSurfaceRequest = request(`plan:reconcile ${JSON.stringify(control)}`, "fixture-owner", "daily");
          expect(hds.decide(wrongSurfaceRequest).command).toBeNull();
          const wrongChannelRequest = request(`plan:reconcile ${JSON.stringify(control)}`, "fixture-owner", "developer", "telegram");
          expect(hds.decide(wrongChannelRequest).command).toBeNull();
          const staleRequest = request(`plan:reconcile ${JSON.stringify({ ...control, revision_digest: "0".repeat(64) })}`);
          expect(hds.decide(staleRequest).command).toBeNull();

          const missingEndpointRequest = request(`plan:reconcile ${JSON.stringify(control)}`);
          const missingEndpointCommand = hds.decide(missingEndpointRequest).command;
          if (!missingEndpointCommand) throw new Error("J did not issue the explicit reconciliation control");
          expect(await runLocalInspectionReconciliation({ hds, command: missingEndpointCommand,
            caller: missingEndpointRequest })).toMatchObject({ status: "not_run", reason: "local_inspection_endpoint_not_configured" });
          expect(inspection.status().read_queries).toBe(0);

          const expiredRequest = request(`plan:reconcile ${JSON.stringify(control)}`);
          const expiredCommand = hds.decide(expiredRequest).command;
          if (!expiredCommand) throw new Error("J did not issue the expiring reconciliation control");
          const expiredResult = await runLocalInspectionReconciliation({ hds, command: expiredCommand, caller: expiredRequest,
            endpoint, now_ms: Date.now() + 30_001 });
          expect(expiredResult).toMatchObject({ status: "rejected" });
          expect(localInspectionReconciliationMessage(expiredResult)).toContain("期限切れまたは古くなったため未実施");
          expect(localInspectionReconciliationMessage(expiredResult)).toContain("outcome_unknownのままです");
          expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
          expect(inspection.status().read_queries).toBe(0);
        }
        const reconciliationRequest = request(`plan:reconcile ${JSON.stringify({ plan_id: currentPlan.plan_id,
          revision_digest: currentPlan.revision_digest, step_id: currentPlan.steps[0]!.step_id })}`);
        const reconciliationDecision = hds.decide(reconciliationRequest);
        const reconciliationCommand = reconciliationDecision.command;
        expect(reconciliationDecision.log.commit.decision).toBe("ASSERT");
        expect(reconciliationCommand).toMatchObject({ type: "noop", payload: { control_event: "operation_plan_receipt_reconciliation" } });
        if (!reconciliationCommand) throw new Error("J did not issue the read-only reconciliation control");
        const reconciliation = await runLocalInspectionReconciliation({ hds, command: reconciliationCommand,
          caller: reconciliationRequest, endpoint });
        expect(reconciliation.status).toBe("observed");
        if (reconciliation.status !== "observed") throw new Error("local read-only reconciliation did not record an observation");
        expect(reconciliation.memory_status).toBe("committed");
        const observation = reconciliation.observation;
        if (restart === 0) {
          expect(await runLocalInspectionReconciliation({ hds, command: reconciliationCommand,
            caller: reconciliationRequest, endpoint })).toMatchObject({ status: "rejected" });
          expect(inspection.status().read_queries).toBe(1);
        }
        finalizeCommandOutput({ hds, command: reconciliationCommand,
          feedback: { command_id: reconciliationCommand.id, status: "success", result: { content: "digest-only receipt observed; outcome_unknown retained" },
            metrics: { duration_ms: 1 } }, request_id: reconciliationRequest.id, target_surface: "channel" });
        const receiptObservationInput = {
          caller: reconciliationRequest,
          command_id: command.id,
          command_digest: currentPlan.bindings[0]!.command_digest,
          executor_command_digest: receipt!.command_digest,
          plan_id_digest: currentPlan.plan_id,
          revision_digest: currentPlan.revision_digest,
          step_id_digest: currentPlan.steps[0]!.step_id,
          request_payload_digest: observedRequests[0]!.request_payload_digest!,
          response: { status: "accepted", matches: [{ idempotency_key: command_key,
            command_digest: receipt!.command_digest, payload_digest: observedRequests[0]!.request_payload_digest!,
            receipt_id: originalReceiptId }] },
        };
        expect(observation).toMatchObject({ status: "matched", match_count: 1, source: "local_inspection",
          used_for_authority: false, raw_receipt_exposed: false });
        expect(() => ingestLocalInspectionReceipt(hds, { ...receiptObservationInput,
          caller: request("unauthorized receipt observation", "another-owner") })).toThrow(/owner_mismatch/);
        expect(() => ingestLocalInspectionReceipt(hds, { ...receiptObservationInput,
          command_digest: "9".repeat(64) })).toThrow(/command_mismatch/);
        const observedStep = hds.getRuntimeSnapshot().operation_plans.plans[0]!.steps[0]!;
        expect(observedStep).toMatchObject({ status: "outcome_unknown", external_receipt_observation: "matched",
          external_receipt: { source: "local_inspection", match_count: 1, used_for_authority: false, raw_receipt_exposed: false } });
        expect(JSON.stringify(hds.getRuntimeSnapshot().operation_plans)).not.toContain(originalReceiptId);
        expect(JSON.stringify(planStore.load())).not.toContain(originalReceiptId);
        expect(planStore.load()?.plans[0]?.receipt_observations).toHaveLength(1);
        expect(planStore.load()?.plans[0]?.receipt_memory).toHaveLength(1);
        expect(planStore.load()?.plans[0]?.receipt_memory?.[0]?.memory_receipt).toBeDefined();
        expect(hds.operationPlanReceiptObservationMemoryIsDurable(observation.evidence_digest)).toBe(true);
        const reflectionRequest = request(`plan:reflect ${JSON.stringify({ plan_id: currentPlan.plan_id,
          revision_digest: currentPlan.revision_digest, step_ids: [currentPlan.steps[0]!.step_id],
          question: "外部照合が示すことと、結果不明のまま残ること" })}`);
        const reflectionDecision = hds.decide(reflectionRequest);
        const reflectionCommand = reflectionDecision.command;
        if (!reflectionCommand || reflectionCommand.type !== "llm_call") throw new Error("J did not issue the receipt reflection Compute command");
        const reflectionProvider = {
          name: "fixture-receipt-reflection",
          call: vi.fn(async (input: LLMRequest): Promise<LLMResponse> => {
            const prompt = input.messages.find((message) => message.role === "system")?.content;
            if (!prompt) throw new Error("reflection projection prompt missing");
            const projection = JSON.parse(prompt.split("\n").at(-1)!) as {
              citations?: Array<{ record_id: string; record_digest: string }>;
            };
            return { content: JSON.stringify({ schema_version: "operation-result-reflection-candidate.v1",
              projection_digest: operationPlanDigest(projection),
              citations: projection.citations?.map((citation) => ({ record_id: citation.record_id, record_digest: citation.record_digest,
                interpretation: "ローカル照合ではdigestが1件一致したと報告された。",
                uncertainty: "外部作用の結果はoutcome_unknownのままで、成功や完了は未確認。" })) ?? [] }),
              model: "fixture", tokens_used: 0 };
          }),
        };
        const reflectionAuthority = createExecutorApprovalAuthority();
        const reflectionExecutor = new Executor({ tools: new ToolRegistry(), approval_authority: reflectionAuthority,
          llm: reflectionProvider, compute: new LLMComputeAdapter(reflectionProvider) });
        const systemPrompt = reflectionCommand.payload.messages.find((message) => message.role === "system")?.content;
        if (!systemPrompt) throw new Error("receipt reflection system prompt missing");
        const projection = JSON.parse(systemPrompt.split("\n").at(-1)!);
        const projectionText = JSON.stringify(projection);
        expect(reflectionCommand.payload.session_id).toBeUndefined();
        expect(projectionText).toContain('"evidence_type":"external_receipt"');
        expect(projectionText).toContain('"reconciliation_status":"matched"');
        expect(projectionText).toContain('"action_outcome":"outcome_unknown"');
        expect(projectionText).toContain('"used_for_authority":false');
        expect(projectionText).toContain('"may_execute":false');
        for (const raw of [originalReceiptId!, FIXTURE_TOKEN, "local inspection fixture only", "inspection@example.invalid"]) {
          expect(projectionText).not.toContain(raw);
        }
        expect(hds.operationPlanCommandIsCurrent(reflectionCommand)).toBe(true);
        const reflectionFeedback = await reflectionExecutor.execute(approvedByFixture(reflectionCommand, reflectionAuthority));
        expect(reflectionFeedback.status).toBe("success");
        const reflectionOutput = finalizeCommandOutput({ hds, command: reflectionCommand, feedback: reflectionFeedback,
          request_id: reflectionDecision.log.request_id, target_surface: "channel" });
        expect(reflectionOutput.reviewed_feedback.status).toBe("success");
        expect(reflectionOutput.rendered_output).toContain("references_verified_interpretation_unverified");
        expect(reflectionOutput.rendered_output).toContain("candidate_only");
        expect(reflectionOutput.rendered_output).not.toContain(originalReceiptId!);
        expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
        expect(hds.operationPlanReceiptObservationMemoryIsDurable(observation.evidence_digest)).toBe(true);
        expect(inspection.status().effects).toBe(1);
        const memoryDb = new DatabaseSync(memory.memory_database_path);
        try {
          const records = memoryDb.prepare("SELECT value_json FROM m_records").all()
            .map((row) => JSON.parse(String(row.value_json)) as Record<string, unknown>);
          const receiptRecord = records.find((record) => record.record_type === "external_receipt_observation");
          expect(records).toHaveLength(1);
          expect(receiptRecord).toMatchObject({ schema_version: "operation-receipt-observation.v1",
            record_type: "external_receipt_observation", source: "local_inspection",
            plan_id_digest: currentPlan.plan_id, plan_revision_digest: currentPlan.revision_digest,
            status: "matched", adoption_status: "observation_only", used_as_world_truth: false,
            used_for_authority: false, may_execute: false });
          expect(JSON.stringify(receiptRecord)).not.toContain(originalReceiptId);
        } finally { memoryDb.close(); }
        expect((await executor.execute(approved)).error).toMatch(/already consumed/);
        expect(inspection.status().effects).toBe(1);
      }
      expect(inspection.status().effects).toBe(1);
      expect(inspection.status().read_queries).toBe(3);
      expect(JSON.stringify(executionStore.snapshot())).not.toContain(FIXTURE_TOKEN);
      expect(JSON.stringify(hds.getAudit().list())).not.toContain(FIXTURE_TOKEN);
      expect(executionStore.verifyEvents()).toBe(true);
    } finally {
      closeMemory?.();
      executionStore?.close();
      planStore?.close();
      await closeServer(inspection.server);
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
