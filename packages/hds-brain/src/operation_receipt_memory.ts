import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION, memoryCommitContentDigest, parseMemoryCommitV2, parseMemoryUpdateReceipt,
  type MemoryCommitJsonValue, type MemoryCommitV2, type MemoryUpdateReceiptV1,
  type OperationPlanExternalReceiptObservation, type OperationPlanReceiptMemoryDelivery,
} from "@blue-tanuki/protocol";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable per-observation identity; raw receipt identifiers never enter M. */
export function receiptMemoryIdentity(observation: OperationPlanExternalReceiptObservation) {
  const id = sha256(JSON.stringify(["operation-plan-receipt-memory.v1", observation.plan_id_digest,
    observation.revision_digest, observation.command_digest, observation.evidence_digest]));
  return { update_id: `receipt-update:${id}`, j_event_id: `receipt-observation:${id}`,
    record_id: `receipt-observation:${id}` };
}

/** Persist only the bounded, digest-only local-inspection observation. It is not truth or authority. */
export function receiptMemoryObservation(observation: OperationPlanExternalReceiptObservation) {
  return {
    schema_version: "operation-receipt-observation.v1",
    record_type: observation.source === "local_file_state" ? "local_file_state_observation" : "external_receipt_observation",
    source: observation.source,
    plan_id_digest: observation.plan_id_digest,
    plan_revision_digest: observation.revision_digest,
    step_id_digest: observation.step_id_digest,
    command_digest: observation.command_digest,
    executor_command_digest: observation.executor_command_digest,
    command_key_digest: observation.command_key_digest,
    ...(observation.observed_command_digest ? { observed_command_digest: observation.observed_command_digest } : {}),
    ...(observation.observed_command_key_digest ? { observed_command_key_digest: observation.observed_command_key_digest } : {}),
    request_payload_digest: observation.request_payload_digest,
    ...(observation.target_identity_digest ? { target_identity_digest: observation.target_identity_digest } : {}),
    ...(observation.observed_payload_digest ? { observed_payload_digest: observation.observed_payload_digest } : {}),
    candidate_set_digest: observation.candidate_set_digest,
    status: observation.status,
    match_count: observation.match_count,
    ...(observation.receipt_digest ? { receipt_digest: observation.receipt_digest } : {}),
    evidence_digest: observation.evidence_digest,
    observed_at_ms: observation.observed_at_ms,
    adoption_status: "observation_only",
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  } as const;
}

export function buildReceiptMemoryCommit(
  observation: OperationPlanExternalReceiptObservation,
  expected_version: number,
): MemoryCommitV2 {
  const id = receiptMemoryIdentity(observation);
  const content = {
    schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
    expected_version,
    update_id: id.update_id,
    j_event_id: id.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: id.record_id,
      value: receiptMemoryObservation(observation) as unknown as MemoryCommitJsonValue }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

export function verifyReceiptMemoryCommit(
  observation: OperationPlanExternalReceiptObservation,
  delivery: OperationPlanReceiptMemoryDelivery,
): boolean {
  if (!delivery.memory_commit) return false;
  const parsed = parseMemoryCommitV2(delivery.memory_commit);
  return parsed.ok && parsed.content_digest ===
    buildReceiptMemoryCommit(observation, parsed.commit.expected_version).content_digest;
}

export function receiptForReceiptMemoryCommit(receipt: MemoryUpdateReceiptV1, commit: MemoryCommitV2): boolean {
  const parsed = parseMemoryUpdateReceipt(receipt);
  return parsed.ok && parsed.receipt.update_id === commit.update_id &&
    parsed.receipt.content_digest === commit.content_digest && parsed.receipt.previous_revision === commit.expected_version;
}
