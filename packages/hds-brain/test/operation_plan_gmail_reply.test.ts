import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest, type OperationPlan, type OperationStep } from "@blue-tanuki/protocol";
import { operationPlanDigest, operationPlanResultValidationMatches, OperationPlanLedger } from "../src/operation_plan.js";

const sourceMessageId = "fixture-source-message_1";

function replyCandidate(requestId: string): OperationPlan {
  const target = { kind: "external_service" as const, id: "gmail" };
  return {
    version: "operation-core.v1",
    plan_id: `reply-plan-${requestId}`,
    request_id: requestId,
    state: "planned",
    steps: [{
      step_id: "create-reply-draft",
      operation: "gmail.write",
      target,
      state: "planned",
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api",
      adapter_is_authority: false,
      command_generated_by_adapter_only: false,
      parameters: { operation: "draft.create", reply_to_message_id: sourceMessageId,
        to: "owner-selected@example.invalid", subject: "Synthetic source subject", body_text: "Fixture reply" },
      preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: "created-in-thread",
        method: "gmail_reply_draft_result_matches", target,
        expected: { schema_version: "blue-tanuki.gmail-reply-draft-result-validation.v1", operation: "draft.create" } }],
        compensation: { available: false, reason: "A created draft remains a user-owned provider object." } },
    }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  };
}

function request(requestId: string, content: string) {
  return createGatewayInternalInboundRequest({ id: requestId, channel: "webchat", user: "fixture-owner", content,
    timestamp: 1, metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.operator_surface": "developer" } });
}

describe("Operation Plan Gmail reply source binding", () => {
  it("retains a reply draft only when the exact source message ID is in the owner task", () => {
    const exact = request("reply-owner-task-exact", `Create a reply draft for Gmail message ${sourceMessageId}.`);
    expect(() => new OperationPlanLedger().retainCandidate(replyCandidate(exact.id), exact)).not.toThrow();

    const implicit = request("reply-owner-task-implicit", "Reply to the latest message in this conversation.");
    expect(() => new OperationPlanLedger().retainCandidate(replyCandidate(implicit.id), implicit))
      .toThrow("plan_gmail_reply_source_message_id_must_be_explicit_in_owner_task");
  });

  it("accepts only a digest-only reply draft result confirmed in the exact source thread", () => {
    const target = { kind: "external_service" as const, id: "gmail" };
    const parameters = { operation: "draft.create", reply_to_message_id: sourceMessageId,
      to: "owner-selected@example.invalid", subject: "Synthetic source subject", body_text: "Fixture reply" };
    const messageIdentityDigest = createHash("sha256").update(sourceMessageId, "utf8").digest("hex");
    const targetIdentityDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v4",
      service: "gmail", operation: "draft.create", recipients: { to: parameters.to },
      reply_source_message_identity_digest: messageIdentityDigest });
    const requestPayloadDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-write-intent.v2",
      operation: "draft.create", to: parameters.to, cc: null, bcc: null, reply_to: null, from: null,
      subject: parameters.subject, body_text: parameters.body_text, attachments: [],
      reply_source_message_identity_digest: messageIdentityDigest });
    const result = {
      created_draft_identity_digest: "1".repeat(64),
      created_message_identity_digest: "2".repeat(64),
      may_execute: false,
      provider_state_digest: "3".repeat(64),
      request_payload_digest: requestPayloadDigest,
      source_message_identity_digest: messageIdentityDigest,
      source_thread_identity_digest: "4".repeat(64),
      target_identity_digest: targetIdentityDigest,
      thread_confirmed: true,
      used_for_authority: false,
    };
    const output = {
      service: "gmail", mode: "write", operation: "draft.create", api_host: "www.googleapis.com",
      path_digest: operationPlanDigest("/gmail/v1/users/me/drafts"), method: "POST", status: 200,
      content_type: "application/json", truncated: false, google_request_id: "fixture-request",
      request_status: "ok", mutation_sent: true, mutation_status: "confirmed",
      result_digest: operationPlanDigest(result), result,
    };
    const step: OperationStep = {
      step_id: "create-reply-draft", operation: "gmail.write", target, state: "planned" as const,
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high" as const, approval_level: "L3_final_review" as const, final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api" as const, adapter_is_authority: false as const, command_generated_by_adapter_only: false,
      parameters,
      preparation: { depends_on: [], bindings: [], preconditions: [], validation: [{ check_id: "created-in-thread",
        method: "gmail_reply_draft_result_matches" as const, target,
        expected: { schema_version: "blue-tanuki.gmail-reply-draft-result-validation.v1", operation: "draft.create" } }],
        compensation: { available: false as const, reason: "A created draft remains a user-owned provider object." } },
    };
    const validation = step.preparation.validation[0]!;
    expect(operationPlanResultValidationMatches(validation, step, output)).toBe(true);
    expect(operationPlanResultValidationMatches(validation, step,
      { ...output, result: { ...result, thread_confirmed: false } })).toBe(false);
    expect(operationPlanResultValidationMatches(validation, step,
      { ...output, result: { ...result, source_message_identity_digest: "5".repeat(64) } })).toBe(false);
    expect(operationPlanResultValidationMatches(validation, step,
      { ...output, result: { ...result, message_id: "raw-provider-id" } })).toBe(false);
  });
});
