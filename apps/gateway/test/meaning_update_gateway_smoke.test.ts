import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";
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

describe("C07.02 and C07.03 Gateway owner L3 and private-M consumers", () => {
  it("persists a meaning candidate, then explicitly reassesses prior citation judgments", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bt-c0702-gateway-"));
    const auditDir = join(tempRoot, "audit");
    const stateRoot = join(tempRoot, "state");
    const memoryFile = join(tempRoot, "memory.jsonl");
    const historyFile = join(tempRoot, "complete-history.jsonl");
    const sessionDir = join(tempRoot, "sessions");
    const fileRoot = join(auditDir, "file-root");
    mkdirSync(fileRoot, { recursive: true });
    writeFileSync(join(fileRoot, "delete-target.txt"), "synthetic pending-delete target\n", "utf8");
    const candidateMeaning = "Synthetic owner-reviewed meaning; no external effect.";
    const revisedMeaning = "Synthetic revised meaning after fresh evidence; no external effect.";
    let providerCalls = 0;
    let providerFailure: unknown;
    let planComputeRequestId: string | undefined;
    let currentInterpretationId: string | undefined;

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
        const contexts = (body.messages ?? []).flatMap((message) => {
          if (typeof message.content !== "string" || !message.content.includes("blue-tanuki.memory-candidates.v1")) return [];
          const jsonStart = message.content.indexOf("\n") + 1;
          try { return [JSON.parse(message.content.slice(jsonStart)) as {
          search_plan?: { plan_id?: string; application_scope_id?: string };
          records?: Array<{ record_id: string; version: string }>;
          }]; } catch { return []; }
        }).filter((context) => context.records?.some((item) => item.record_id === support.f_reference &&
          item.version === support.entry_hash) && context.records?.some((item) => item.record_id === counter.f_reference &&
          item.version === counter.entry_hash));
        const context = contexts.at(-1);
        if (!context) throw new Error("current-M projection with both synthetic references was not sent to C");
        const planId = context.search_plan?.plan_id;
        const applicationScopeId = context.search_plan?.application_scope_id;
        const records = context.records ?? [];
        if (!planId || !applicationScopeId || records.length < 2) {
          throw new Error("two current-M references and the HDS scope were not available to C");
        }
        const currentSupport = records.find((item) => item.record_id === support.f_reference && item.version === support.entry_hash);
        const currentCounter = records.find((item) => item.record_id === counter.f_reference && item.version === counter.entry_hash);
        if (!currentSupport || !currentCounter) throw new Error("requested synthetic M references were not projected");
        const candidateForCall = providerCalls === 1 ? candidateMeaning : revisedMeaning;
        const proposal = providerCalls <= 2 ? {
          schema_version: "blue-tanuki.meaning-update-proposal.v3",
          record_type: "meaning_update_proposal",
          proposal_ref: `proposal:c0702-gateway-smoke:${providerCalls}`,
          candidate_ref: `candidate:c0702-gateway-smoke:${providerCalls}`,
          candidate_digest: meaningUpdateCandidateDigest(candidateForCall),
          candidate_meaning: candidateForCall,
          target_reference: { record_id: currentSupport.record_id, version: currentSupport.version },
          prior_version_ref: `version:c0702-synthetic-prior:${providerCalls}`,
          supporting_evidence: [{ reference: currentSupport.record_id, digest: currentSupport.version }],
          counterevidence_review: { status: "reviewed_with_references" as const,
            review_scope: { reference: applicationScopeId, digest: planId },
            references: [{ reference: currentCounter.record_id, digest: currentCounter.version }] },
          applicability_scope: { reference: applicationScopeId, digest: planId },
          reflection_target_ref: `reflection:c0702-gateway-smoke:${providerCalls}`,
          proposal_status: "unverified" as const,
          adoption_status: "not_adopted" as const,
          may_apply: false as const,
          used_for_authority: false as const,
        } : undefined;
        const plan = providerCalls === 9 ? {
          version: "operation-core.v1",
          plan_id: `c0702-post-reassessment-plan:${planComputeRequestId ?? "missing"}`,
          request_id: planComputeRequestId,
          state: "planned",
          steps: [{ step_id: "delete-synthetic-target", operation: "file.delete",
            target: { kind: "file", id: "delete-target.txt" }, state: "planned", effects: ["delete"],
            permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
              hds_brain_authority_required: true, approval_gate_required: true },
            adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
            parameters: { path: "delete-target.txt", max_bytes: 128 },
            preparation: { depends_on: [], bindings: [], preconditions: [],
              validation: [{ check_id: "deleted-synthetic-target", method: "result_equals",
                target: { kind: "file", id: "delete-target.txt" }, expected: { deleted: true } }],
              compensation: { available: false,
                reason: "deletion requires a separate owner-reviewed create operation to recover" } } }],
          rollback: { available: false },
          raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
          planner_output_used_for_authority: false,
          hds_brain_authority_required: true,
        } : undefined;
        if (providerCalls === 9 && (!planComputeRequestId || !context)) {
          throw new Error("post-reassessment plan compute context was not available");
        }
        const content = plan ? JSON.stringify({ plan }) : JSON.stringify({ schema_version: "blue-tanuki.memory-citation-response.v1",
          answer: "Synthetic C response with current references.", citations: [{
            claim: "Synthetic candidate statement.",
            supporting: { record_id: currentSupport.record_id, version: currentSupport.version },
            counterevidence: { record_id: currentCounter.record_id, version: currentCounter.version },
            application_scope_id: applicationScopeId,
          }] });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "c0702-local-fixture", object: "chat.completion", created: 1,
          model: "c0702-local-fixture", choices: [{ index: 0, message: { role: "assistant", content,
            ...(proposal ? { meaning_update_proposal: proposal } : {}) }, finish_reason: "stop" }],
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

      const secondInvocation = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content:
          "Review the same synthetic references again and propose a revised candidate after the first adoption." }),
      });
      expect(secondInvocation.status).toBe(202);
      const secondPending = await waitForMeaningUpdateApproval(gatewayPort, gateway, () => providerFailure,
        () => providerCalls, auditDir);
      expect(secondPending.meaning_update_review).toMatchObject({ kind: "meaning_update_adoption", review_status: "required" });
      const secondApprovalPath = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(secondPending.command_id))}`;
      const secondReviewResponse = await fetch(`${secondApprovalPath}/content`, {
        method: "POST", headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(secondReviewResponse.status).toBe(200);
      const secondReview = await secondReviewResponse.json() as Record<string, unknown>;
      expect(secondReview).toMatchObject({ kind: "meaning_update_adoption", candidate_meaning: revisedMeaning,
        used_for_authority: false, may_execute: false });
      const secondApproved = await fetch(secondApprovalPath, { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: secondPending.approval_token,
          content_review_digest: secondReview.command_digest }) });
      expect(secondApproved.status).toBe(200);
      expect(await secondApproved.json()).toMatchObject({ ok: true, result: { executed: false,
        status: "meaning_update_adoption_committed", memory_application_status: "applied" } });

      const thirdInvocation = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content:
          "Use the current interpretation of F:c0702-support and F:c0702-counter to reassess the prior synthetic citation decision." }),
      });
      expect(thirdInvocation.status).toBe(202);
      const reassessmentPending = await waitForMemoryJudgmentReassessmentApproval(gatewayPort, gateway,
        () => providerFailure, () => providerCalls, auditDir);
      expect(reassessmentPending).toMatchObject({ operation: "tool.call", approval_level: "L3_final_review",
        final_review_required: true, content_review_required: true,
        memory_judgment_reassessment_review: { kind: "memory_judgment_reassessment", review_status: "required",
          used_for_authority: false, may_execute: false } });
      expect(String(reassessmentPending.target)).toMatch(/^memory\.citation\.reassess:/);
      const reassessmentPath = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(reassessmentPending.command_id))}`;
      const reassessmentRequest = { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: reassessmentPending.approval_token }) };
      const reassessmentBlocked = await fetchRespectingRetryAfter(reassessmentPath, reassessmentRequest);
      expect(reassessmentBlocked.status).toBe(409);
      expect(await reassessmentBlocked.json()).toMatchObject({ error: "approval_content_review_required" });
      const reassessmentReviewResponse = await fetchRespectingRetryAfter(`${reassessmentPath}/content`, {
        method: "POST", headers: { authorization: `Bearer ${RESUME_TOKEN}` },
      });
      expect(reassessmentReviewResponse.status).toBe(200);
      const reassessmentReview = await reassessmentReviewResponse.json() as Record<string, unknown>;
      expect(reassessmentReview).toMatchObject({ kind: "memory_judgment_reassessment",
        operation: "memory.citation.reassess", used_for_authority: false, may_execute: false });
      const reviewPriorRefs = reassessmentReview.reassesses_judgment_refs as string[];
      const freshJudgmentRef = String(reassessmentReview.judgment_ref);
      expect(reviewPriorRefs.length).toBeGreaterThan(0);
      const beforeReassessment = new DatabaseSync(memoryDatabase, { readOnly: true });
      try {
        const row = beforeReassessment.prepare("SELECT value_json FROM m_records WHERE record_id = ?")
          .get(`memory-interpretation:${support.f_reference}`) as { value_json?: string } | undefined;
        const interpretation = JSON.parse(row?.value_json ?? "null") as {
          dependent_judgments?: Array<{ judgment_ref: string; reassessment_required: boolean }>;
        };
        expect(interpretation.dependent_judgments?.find((item) => item.judgment_ref === freshJudgmentRef)).toBeUndefined();
        for (const oldRef of reviewPriorRefs) {
          expect(interpretation.dependent_judgments?.find((item) => item.judgment_ref === oldRef)?.reassessment_required).toBe(true);
        }
      } finally { beforeReassessment.close(); }
      const reassessmentApproved = await fetchRespectingRetryAfter(reassessmentPath, { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: reassessmentPending.approval_token,
          content_review_digest: reassessmentReview.command_digest }) });
      expect(reassessmentApproved.status).toBe(200);
      expect(await reassessmentApproved.json()).toMatchObject({ ok: true, result: { approval: "approve",
        executed: false, status: "memory_judgment_reassessment_committed", judgment_ref: freshJudgmentRef,
        used_for_authority: false, may_execute: false } });
      const afterReassessment = new DatabaseSync(memoryDatabase, { readOnly: true });
      try {
        const row = afterReassessment.prepare("SELECT value_json FROM m_records WHERE record_id = ?")
          .get(`memory-interpretation:${support.f_reference}`) as { value_json?: string } | undefined;
        const interpretation = JSON.parse(row?.value_json ?? "null") as {
          current_interpretation_id?: string;
          events?: Array<{ kind?: string; reassessment_judgment_ref?: string }>;
          dependent_judgments?: Array<{ judgment_ref: string; reassessment_required: boolean }>;
        };
        currentInterpretationId = interpretation.current_interpretation_id;
        expect(currentInterpretationId).toBeTruthy();
        expect(interpretation.events?.at(-1)).toMatchObject({ kind: "reassessed", reassessment_judgment_ref: freshJudgmentRef });
        expect(interpretation.dependent_judgments?.find((item) => item.judgment_ref === freshJudgmentRef)?.reassessment_required)
          .toBe(false);
        for (const oldRef of reviewPriorRefs) {
          expect(interpretation.dependent_judgments?.find((item) => item.judgment_ref === oldRef)?.reassessment_required)
            .toBe(false);
        }
      } finally { afterReassessment.close(); }

      const freshCitationInvocation = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content:
          "Make a fresh J citation judgment under the current M interpretation for F:c0702-support and F:c0702-counter." }),
      });
      expect(freshCitationInvocation.status).toBe(202);
      const freshCitationAccepted = await freshCitationInvocation.json() as { request_id?: string };
      expect(freshCitationAccepted.request_id).toBeTruthy();
      const freshCitationRequestId = String(freshCitationAccepted.request_id);
      const freshCitationReview = await waitForMemoryCitationReview(auditDir, freshCitationRequestId,
        gateway, () => providerFailure, () => providerCalls);
      const currentDependencies = freshCitationReview.interpretation_dependencies as Array<Record<string, unknown>>;
      expect(currentDependencies).toHaveLength(1);
      expect(currentDependencies[0]).toMatchObject({
        reference: { record_id: support.f_reference, version: support.entry_hash },
        interpretation_id: currentInterpretationId,
      });
      expect(currentDependencies[0]?.reassesses_judgment_refs ?? []).toEqual([]);

      const sourceCitationPlanTask =
        "Create one bounded plan to remove the synthetic delete target after a separate owner final review. F:c0702-support F:c0702-counter";
      const rejectedPlanCompute = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-other", content: `plan:compute ${JSON.stringify({
          task: sourceCitationPlanTask, source_citation_request_id: freshCitationRequestId,
        })}` }),
      });
      expect(rejectedPlanCompute.status).toBe(202);
      const rejectedPlanComputeAccepted = await rejectedPlanCompute.json() as { request_id?: string };
      const rejectedPlanDecision = await waitForDecision(auditDir, String(rejectedPlanComputeAccepted.request_id),
        gateway, () => providerFailure);
      expect(rejectedPlanDecision).toMatchObject({
        commit: { decision: "FAIL", reason: "plan_control_denied:plan_compute_source_citation_actor_mismatch" },
      });
      expect(providerCalls).toBe(4);

      const planCompute = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content: `plan:compute ${JSON.stringify({
          task: sourceCitationPlanTask, source_citation_request_id: freshCitationRequestId,
        })}` }),
      });
      expect(planCompute.status).toBe(202);
      const planComputeAccepted = await planCompute.json() as { request_id?: string };
      planComputeRequestId = `operation-request:${String(planComputeAccepted.request_id)}`;
      const planComputeDecision = await waitForDecision(auditDir, String(planComputeAccepted.request_id),
        gateway, () => providerFailure);
      expect(planComputeDecision.commit, JSON.stringify(planComputeDecision)).toMatchObject({ decision: "ASSERT" });
      const currentPlan = await waitForOperationPlan(gatewayPort, gateway, () => providerFailure, () => providerCalls);
      expect(currentPlan).toMatchObject({ status: "awaiting_step_review", goal_purpose_binding_status: "not_configured",
        steps: [expect.objectContaining({ operation: "file.delete", status: "not_selected" })] });
      const planIdDigest = String(currentPlan.plan_id);
      const revisionDigest = String(currentPlan.revision_digest);
      const step = (currentPlan.steps as Array<Record<string, unknown>>)[0];
      expect(step?.step_id).toBeTruthy();

      const planStateDatabase = new DatabaseSync(join(stateRoot, "private-state", "operation-plans", "j-state.sqlite"),
        { readOnly: true });
      try {
        const row = planStateDatabase.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id = 1")
          .get() as { checkpoint_json?: string } | undefined;
        const checkpoint = JSON.parse(row?.checkpoint_json ?? "null") as {
          plans?: Array<{ memory_interpretation_dependencies?: Array<Record<string, unknown>> }>;
        };
        expect(checkpoint.plans?.at(-1)?.memory_interpretation_dependencies).toEqual([
          expect.objectContaining({
            reference: { record_id: support.f_reference, version: support.entry_hash },
            interpretation_id: currentInterpretationId,
            judgment_ref: currentDependencies[0]?.judgment_ref,
          }),
        ]);
      } finally { planStateDatabase.close(); }

      const planReview = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST", headers: { authorization: `Bearer ${WEBCHAT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ user: "c0702-owner", content: `plan:review ${JSON.stringify({
          plan_id: planIdDigest, revision_digest: revisionDigest, step_id: step?.step_id,
        })}` }),
      });
      expect(planReview.status).toBe(202);
      const pendingDeleteApproval = await waitForPendingFileDeleteApproval(gatewayPort, gateway,
        () => providerFailure, auditDir);
      expect(pendingDeleteApproval).toMatchObject({ operation: "tool.file.delete", risk: "high",
        approval_level: "L3_final_review", final_review_required: true, content_review_required: false });
      expect(existsSync(join(fileRoot, "delete-target.txt"))).toBe(true);
      expect(readFileSync(join(fileRoot, "delete-target.txt"), "utf8")).toBe("synthetic pending-delete target\n");
      expect(providerCalls).toBe(9);

      const deleteApprovalPath = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(pendingDeleteApproval.command_id))}`;
      const deleteApproved = await fetchRespectingRetryAfter(deleteApprovalPath, { method: "POST",
        headers: { authorization: `Bearer ${RESUME_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: pendingDeleteApproval.approval_token }) });
      expect(deleteApproved.status).toBe(200);
      expect(await deleteApproved.json()).toMatchObject({ ok: true, result: {
        approval: "approve", executed: true, status: "success",
      } });
      expect(existsSync(join(fileRoot, "delete-target.txt"))).toBe(false);

      const completedRuntime = await waitForOperationPlanExecution(gatewayPort, gateway, () => providerFailure);
      expect(completedRuntime.plans).toMatchObject([{
        plan_id: planIdDigest, status: "results_verified",
        steps: [expect.objectContaining({ operation: "file.delete", status: "verified",
          binding: expect.objectContaining({ memory_status: "receipt_confirmed" }) })],
      }]);

      const resultMemoryDatabase = join(stateRoot, "private-state", "result-memory", "m-state.sqlite");
      expect(existsSync(resultMemoryDatabase)).toBe(true);
      const resultMemoryDb: DatabaseSyncType = new DatabaseSync(resultMemoryDatabase, { readOnly: true });
      try {
        const observations = resultMemoryDb.prepare("SELECT value_json FROM m_records").all() as Array<{ value_json?: string }>;
        const observation = observations.map((row) => JSON.parse(row.value_json ?? "null") as Record<string, unknown>)
          .find((record) => record.record_type === "action_result_observation" && record.operation === "file.delete");
        expect(observation).toMatchObject({ schema_version: "operation-action-result.v1",
          plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
          adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
        expect(JSON.stringify(observation)).not.toContain("delete-target.txt");
        expect(JSON.stringify(observation)).not.toContain("synthetic pending-delete target");
      } finally { resultMemoryDb.close(); }

      for (const persistedFile of [join(auditDir, "audit.jsonl"), historyFile]) {
        expect(readFileSync(persistedFile, "utf8")).not.toContain(candidateMeaning);
        expect(readFileSync(persistedFile, "utf8")).not.toContain(revisedMeaning);
      }
      expect(providerCalls).toBe(9);
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

async function waitForMemoryJudgmentReassessmentApproval(port: number, gateway: CapturedProcess,
  providerFailure: () => unknown, providerCalls: () => number, auditDir: string): Promise<Record<string, unknown>> {
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
        typeof item.target === "string" && item.target.startsWith("memory.citation.reassess:"));
      if (pending) return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const auditText = existsSync(join(auditDir, "audit.jsonl")) ? readFileSync(join(auditDir, "audit.jsonl"), "utf8") : "";
  throw new Error(`memory judgment reassessment did not reach the owner L3 queue; provider_calls=${providerCalls()}; ` +
    `audit_tail=${auditText.slice(-2500)}; ` +
    `gateway_stdout=${gateway.stdout.join("")}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function waitForMemoryCitationReview(auditDir: string, requestId: string, gateway: CapturedProcess,
  providerFailure: () => unknown, providerCalls: () => number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const failure = providerFailure();
    if (failure) throw failure;
    const auditText = existsSync(join(auditDir, "audit.jsonl")) ? readFileSync(join(auditDir, "audit.jsonl"), "utf8") : "";
    const review = auditText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      log?: Record<string, unknown>;
    }).map((entry) => entry.log).find((log) => log?.kind === "memory_citation_review" && log.request_id === requestId);
    if (review) {
      if (!["accepted", "accepted_with_rejections"].includes(String(review.status))) {
        throw new Error(`fresh current-M citation review was not accepted: ${JSON.stringify(review)}`);
      }
      return review;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fresh current-M citation review did not finish; provider_calls=${providerCalls()}; ` +
    `gateway_stdout=${gateway.stdout.join("")}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function waitForDecision(auditDir: string, requestId: string, gateway: CapturedProcess,
  providerFailure: () => unknown): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const failure = providerFailure();
    if (failure) throw failure;
    const auditText = existsSync(join(auditDir, "audit.jsonl")) ? readFileSync(join(auditDir, "audit.jsonl"), "utf8") : "";
    const decision = auditText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      log?: Record<string, unknown>;
    }).map((entry) => entry.log).find((log) => log?.request_id === requestId && log.commit !== undefined);
    if (decision) return decision;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HDS decision did not finish for ${requestId}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function waitForOperationPlan(port: number, gateway: CapturedProcess, providerFailure: () => unknown,
  providerCalls: () => number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const failure = providerFailure();
    if (failure) throw failure;
    const response = await fetch(`http://127.0.0.1:${port}/runtime/snapshot`, {
      headers: { authorization: `Bearer ${WEBCHAT_TOKEN}` },
    });
    if (response.ok) {
      const snapshot = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
      const plan = snapshot.operation_plan_status?.plans?.[0];
      if (providerCalls() >= 9 && plan?.status === "awaiting_step_review" && Array.isArray(plan.steps) && plan.steps.length > 0) {
        return plan;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`post-reassessment plan candidate was not retained; provider_calls=${providerCalls()}; ` +
    `gateway_stdout=${gateway.stdout.join("")}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function waitForOperationPlanExecution(port: number, gateway: CapturedProcess,
  providerFailure: () => unknown): Promise<{ plans?: Array<Record<string, unknown>> }> {
  const deadline = Date.now() + 15_000;
  let lastSnapshot = "unavailable";
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited: ${gateway.stderr.join("")}`);
    const failure = providerFailure();
    if (failure) throw failure;
    const response = await fetch(`http://127.0.0.1:${port}/runtime/snapshot`, {
      headers: { authorization: `Bearer ${WEBCHAT_TOKEN}` },
    });
    if (response.ok) {
      const snapshot = await response.json() as { operation_plan_status?: { plans?: Array<Record<string, unknown>> } };
      lastSnapshot = JSON.stringify(snapshot.operation_plan_status ?? null);
      const operationPlans = snapshot.operation_plan_status;
      if (operationPlans?.plans?.some((plan) => plan.status === "results_verified" &&
          Array.isArray(plan.steps) && plan.steps.some((step) => typeof step === "object" && step !== null &&
            "binding" in step && typeof step.binding === "object" && step.binding !== null &&
            (step.binding as Record<string, unknown>).memory_status === "receipt_confirmed"))) return operationPlans;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`approved plan execution and J/M receipt did not complete: gateway_stdout=${gateway.stdout.join("")}; ` +
    `last_snapshot=${lastSnapshot}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function waitForPendingFileDeleteApproval(port: number, gateway: CapturedProcess,
  providerFailure: () => unknown, auditDir: string): Promise<Record<string, unknown>> {
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
      const pending = queue.pending_approvals?.find((item) => item.operation === "tool.file.delete");
      if (pending) return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const auditText = existsSync(join(auditDir, "audit.jsonl")) ? readFileSync(join(auditDir, "audit.jsonl"), "utf8") : "";
  throw new Error(`current-M/J plan did not reach its L3 approval gate; audit_tail=${auditText.slice(-2500)}; ` +
    `gateway_stdout=${gateway.stdout.join("")}; gateway_stderr=${gateway.stderr.join("")}`);
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchRespectingRetryAfter(input: string | URL, init: RequestInit, maxRetries = 4): Promise<Response> {
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || retry >= maxRetries) return response;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delayMs = Math.max(1000, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 + 100 : 1000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
    BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify(DEFAULT_COMPUTE_BUDGET_POLICY),
    BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: JSON.stringify({
      "c0702-local-fixture": { capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0, currency: "USD" } },
    }),
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
