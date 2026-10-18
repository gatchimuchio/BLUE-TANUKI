import { describe, expect, it } from "vitest";
import { FailureMemoryStore, HDSUpperController } from "@blue-tanuki/hds-brain";
import { createGatewayInternalInboundRequest, isGatewayInternalInboundRequest, type InboundRequest } from "@blue-tanuki/protocol";
import { prepareFailureReviewInbound } from "../src/failure_review_runtime.js";

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
