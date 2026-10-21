import { describe, expect, it } from "vitest";
import { CompleteHistoryStore, FailureMemoryStore, HDSUpperController, extractFailureSignatures, failureReviewProjectionDigest } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, FailureReviewProjectionSchema, isGatewayInternalInboundRequest, type ExecuteFeedback, type InboundRequest } from "@blue-tanuki/protocol";
import { prepareFailureReviewInbound } from "../src/failure_review_runtime.js";
import { DevelopmentHandoffStore } from "../src/development_handoff_store.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";

function developerRequest(content: string): InboundRequest {
  return createGatewayInternalInboundRequest({
    id: "failure-review-request",
    channel: "webchat",
    user: "owner",
    content,
    timestamp: 1,
    metadata: {
      "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.operator_surface": "developer",
    },
  });
}

describe("prepareFailureReviewInbound", () => {
  it("attaches only the digest projection for an explicit Developer request", () => {
    const store = new FailureMemoryStore();
    const signature = store.addSignature({
      scope: "repo",
      failure_type: "logic_drift",
      input_pattern: "RAW_GOAL_SENTINEL",
      action_pattern: "RAW_COMMAND_SENTINEL",
      context_pattern: "RAW_CONTEXT_SENTINEL",
      result_pattern: "RAW_RESULT_SENTINEL",
      notes: "RAW_NOTES_SENTINEL",
      state: "draft",
    });

    const result = prepareFailureReviewInbound(developerRequest(`failure:review ${signature.id}`), store) as InboundRequest;
    expect(isGatewayInternalInboundRequest(result)).toBe(true);
    expect(result.content).toBe(`failure:review ${signature.id}`);
    expect(result.metadata?.["blue_tanuki.failure_review.version"]).toBe("blue-tanuki.failure-review.v1");
    expect(result.metadata?.["blue_tanuki.failure_review.signature_id"]).toBe(signature.id);
    const projection = String(result.metadata?.["blue_tanuki.failure_review.projection_json"]);
    for (const sentinel of ["RAW_GOAL_SENTINEL", "RAW_COMMAND_SENTINEL", "RAW_CONTEXT_SENTINEL", "RAW_RESULT_SENTINEL", "RAW_NOTES_SENTINEL"]) {
      expect(projection).not.toContain(sentinel);
    }
    expect(projection).toContain("input_pattern_digest");
  });

  it("selects the most recently updated signature for latest", () => {
    const store = new FailureMemoryStore();
    const earlier = store.addSignature({
      scope: "repo", failure_type: "logic_drift", input_pattern: "a", action_pattern: "a", context_pattern: "a",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const latest = store.addSignature({
      scope: "repo", failure_type: "logic_drift", input_pattern: "b", action_pattern: "b", context_pattern: "b",
      created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    });

    const result = prepareFailureReviewInbound(developerRequest("failure:review latest"), store) as InboundRequest;
    expect(result.metadata?.["blue_tanuki.failure_review.signature_id"]).toBe(latest.id);
    expect(result.metadata?.["blue_tanuki.failure_review.signature_id"]).not.toBe(earlier.id);
  });

  it("binds a digest-only independent observation from the referenced verified history entry", () => {
    const history = new CompleteHistoryStore();
    const entry = history.append({
      kind: "execution_history",
      request_id: "private-request",
      command_id: "private-command",
      actor: "owner",
      source: "executor",
      timestamp: 1,
      payload: {
        status: "failed",
        command: { type: "tool_call", operation: "file.search" },
        origin_channel: "webchat",
        error: "PRIVATE_FAILURE_REVIEW_ERROR",
      },
    })!;
    const signatureInput = extractFailureSignatures({ kind: "complete_history", entry })[0]!;
    const store = new FailureMemoryStore();
    const signature = store.addSignature(signatureInput);

    const result = prepareFailureReviewInbound(
      developerRequest("failure:review " + signature.id),
      store,
      history,
    ) as InboundRequest;
    const projection = JSON.parse(String(result.metadata?.["blue_tanuki.failure_review.projection_json"])) as {
      signature_id: string;
      signature_digest: string;
      evidence_log_id_digests: string[];
      independent_observation_source_status: string;
      independent_observations: Array<{
        entry_hash: string;
        payload_digest: string;
        observed_failures: Array<{ scope: string; failure_type: string }>;
      }>;
    };

    expect(projection.independent_observation_source_status).toBe("verified");
    expect(projection.evidence_log_id_digests).toHaveLength(1);
    expect(projection.independent_observations).toHaveLength(1);
    expect(projection.independent_observations[0]).toMatchObject({
      entry_hash: entry.entry_hash,
      payload_digest: entry.payload_digest,
      observed_failures: [{ scope: signature.scope, failure_type: signature.failure_type }],
    });
    expect(JSON.stringify(projection)).not.toContain("PRIVATE_FAILURE_REVIEW_ERROR");
    expect(JSON.stringify(projection)).not.toContain("private-request");

    const hds = new HDSUpperController({ failure_memory_store: store });
    const { command } = hds.decide(result);
    expect(command?.type).toBe("llm_call");
    if (!command || command.type !== "llm_call") return;
    expect(command.payload.compute_context?.data_exposure.input_sources).toContain(
      "complete_history_digest_observations",
    );
    const candidate = {
      schema_version: "blue-tanuki.failure-review-candidate.v1",
      signature_id: projection.signature_id,
      signature_digest: projection.signature_digest,
      projection_digest: command.payload.compute_context.projection_digest,
      cause_hypotheses: [{ category: signature.failure_type, rationale: "unverified cause" }],
      alternative_hypotheses: ["alternative"],
      observation_error_hypotheses: ["observation error"],
      scope_assessment: "same_scope",
      counterexamples: ["candidate counterexample"],
      resume_conditions: ["candidate resume condition"],
      additional_observations: ["additional observation"],
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    };
    const rawFeedback = {
      command_id: command.id,
      status: "success" as const,
      result: { content: JSON.stringify(candidate) },
      metrics: { duration_ms: 1 },
    };
    const reviewed = hds.reviewMemoryCitations(command, rawFeedback);
    const reviewedResult = reviewed.result as { content?: string };
    const reviewedContent = JSON.parse(String(reviewedResult.content)) as {
      review: Record<string, unknown>;
      review_targets: { counterexamples: string; resume_conditions: string };
      counterexamples_adopted_as_facts: boolean;
      resume_conditions_adopted_as_permissions: boolean;
    };
    expect(reviewedContent.review).toMatchObject({
      scope_disposition: "bound_to_independent_observation",
      counterexample_review_target_status: "retained_for_future_observation",
      resume_condition_review_target_status: "retained_for_future_observation",
      cause_adoption: "not_adopted",
      may_execute: false,
      used_for_authority: false,
    });
    expect(reviewedContent.review_targets).toEqual({
      counterexamples: "retained_for_future_observation",
      resume_conditions: "retained_for_future_observation",
    });
    expect(reviewedContent.counterexamples_adopted_as_facts).toBe(false);
    expect(reviewedContent.resume_conditions_adopted_as_permissions).toBe(false);
    hds.onFeedback(rawFeedback);
    const next = prepareFailureReviewInbound(developerRequest("failure:review " + signature.id), store) as InboundRequest;
    const nextProjection = JSON.parse(String(next.metadata?.["blue_tanuki.failure_review.projection_json"])) as {
      prior_learning_lineages: Array<{ derivation_digest: string; adoption_status: string; may_execute: boolean;
        validity_status: string; improvement_status: string; generalization_status: string;
        external_change_contribution_status: string; teacher_input_contribution_status: string }>;
    };
    expect(nextProjection.prior_learning_lineages).toHaveLength(1);
    expect(nextProjection.prior_learning_lineages[0]).toMatchObject({
      adoption_status: "not_adopted",
      may_execute: false,
      validity_status: "not_assessed",
      improvement_status: "not_measured",
      generalization_status: "not_assessed",
      external_change_contribution_status: "not_assessed",
      teacher_input_contribution_status: "excluded_from_c_projection",
    });
  });

  it("connects an explicit projection to an HDS-issued compute command without executing it", () => {
    const store = new FailureMemoryStore();
    const signature = store.addSignature({
      scope: "repo",
      failure_type: "logic_drift",
      input_pattern: "INTEGRATION_RAW_GOAL",
      action_pattern: "INTEGRATION_RAW_ACTION",
      context_pattern: "INTEGRATION_RAW_CONTEXT",
    });
    const prepared = prepareFailureReviewInbound(developerRequest(`failure:review ${signature.id}`), store);
    const hds = new HDSUpperController();
    const { log, command } = hds.decide(prepared);

    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
    expect(JSON.stringify(command)).not.toContain("INTEGRATION_RAW_");
    expect(hds.getAudit().list().some((entry) => "kind" in entry.log && entry.log.kind === "executor_feedback")).toBe(false);
  });

  it("delivers a request-bound learning candidate to the separate Developer inbox without promoting it", () => {
    const failureMemory = new FailureMemoryStore();
    const signature = failureMemory.addSignature({
      scope: "repo", failure_type: "logic_drift", input_pattern: "a", action_pattern: "b", context_pattern: "c",
    });
    const prepared = prepareFailureReviewInbound(developerRequest(`failure:review ${signature.id}`), failureMemory) as InboundRequest;
    const projection = FailureReviewProjectionSchema.parse(
      JSON.parse(String(prepared.metadata?.["blue_tanuki.failure_review.projection_json"])),
    );
    const hds = new HDSUpperController({ failure_memory_store: failureMemory });
    const { log, command } = hds.decide(prepared);
    expect(log.commit.decision).toBe("ASSERT");
    expect(command?.type).toBe("llm_call");
    if (!command || command.type !== "llm_call") return;

    const candidate = {
      schema_version: "blue-tanuki.failure-review-candidate.v1",
      signature_id: projection.signature_id,
      signature_digest: projection.signature_digest,
      projection_digest: failureReviewProjectionDigest(projection),
      cause_hypotheses: [{ category: "logic_drift", rationale: "unverified development candidate" }],
      alternative_hypotheses: ["unverified alternative"],
      observation_error_hypotheses: ["observation may be incomplete"],
      scope_assessment: "uncertain",
      counterexamples: ["candidate counterexample"],
      resume_conditions: ["collect an independent observation"],
      additional_observations: ["inspect another case"],
      authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
    };
    const feedback: ExecuteFeedback = {
      command_id: command.id,
      status: "success",
      result: { content: JSON.stringify(candidate) },
      metrics: { duration_ms: 1 },
    };
    const developmentInbox = new DevelopmentHandoffStore();
    const finalized = finalizeCommandOutput({
      hds,
      command,
      feedback,
      target_surface: "channel",
      request_id: log.request_id,
      development_handoff_store: developmentInbox,
    });

    expect(finalized.rendered_output).toContain("unverified development candidate");
    expect(developmentInbox.snapshot()).toMatchObject({
      status: "memory_only",
      count: 1,
      items: [{
        candidate_kind: "runtime_learning_signal",
        development_status: "awaiting_development_review",
        source_state: {
          validity_status: "not_assessed",
          improvement_status: "not_measured",
          generalization_status: "not_assessed",
          external_change_contribution_status: "not_assessed",
        },
        may_promote_version: false,
        used_for_authority: false,
        may_execute: false,
      }],
    });
    expect(developmentInbox.snapshot().items[0]?.candidate).toEqual(candidate);
    expect(failureMemory.listLearningLineageForSignature(signature.id)).toHaveLength(1);
    expect(hds.getAudit().verify()).toBe(true);
  });

  it("does not manufacture internal review metadata for external or non-Developer input", () => {
    const store = new FailureMemoryStore();
    store.addSignature({
      scope: "repo", failure_type: "logic_drift", input_pattern: "a", action_pattern: "b", context_pattern: "c",
    });
    const external: InboundRequest = {
      ...developerRequest("failure:review latest"),
      metadata: {
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.failure_review.version": "blue-tanuki.failure-review.v1",
      },
    };
    const nonDeveloper = createGatewayInternalInboundRequest({
      ...developerRequest("failure:review latest"),
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "daily",
      },
    });

    expect(prepareFailureReviewInbound(external, store)).toBe(external);
    expect(prepareFailureReviewInbound(nonDeveloper, store)).toBe(nonDeveloper);
  });

  it("leaves missing signatures without a C projection so HDS can fail closed", () => {
    const request = developerRequest("failure:review 00000000-0000-4000-8000-000000000000");
    const result = prepareFailureReviewInbound(request, new FailureMemoryStore());
    expect(result).toBe(request);
  });
});
