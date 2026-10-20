import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION, memoryCommitContentDigest, parseMemoryCommitV2,
  parseMemoryUpdateReceipt, type MemoryCommitV2, type MemoryCommitJsonValue,
  type MemoryUpdateReceiptV1, type OperationPlanCheckpoint,
} from "@blue-tanuki/protocol";

type Plan = OperationPlanCheckpoint["plans"][number];
type Binding = Plan["bindings"][number];
type ShellExecObservation = NonNullable<OperationPlanCheckpoint["shell_exec_result_observations"]>[number];

/** 実作用の結果記録はMを非権威に保ち、記録だけで権限や成功判定を発行しない。 */
export function resultMemoryEligible(b: Binding): boolean {
  if (b.status === "verified") return b.operation === "file.search" || b.operation === "file.write" ||
    b.operation === "file.delete" || b.operation === "file.edit";
  return b.status === "outcome_unknown" && !!b.execution_admission && !!b.delivery_digest && !!b.result_digest;
}

/** Jが受領済みの実結果を非権威観測として固定する。意味採用・任意記憶変更の入口ではない。 */
export function resultObservation(p: Plan, b: Binding) {
  const result = p.results.find((r) => r.step_id === b.step_id);
  if (b.status === "outcome_unknown" && b.execution_admission && b.delivery_digest && b.result_digest) {
    return {
      schema_version: "operation-action-outcome.v1", record_type: "action_outcome_observation",
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: b.operation,
      delivery_digest: b.delivery_digest, result_digest: b.result_digest,
      plan_binding_status: "outcome_unknown", effect_observation: "unknown",
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.status !== "verified" || !b.execution_admission || !b.delivery_digest || !b.result_digest ||
      !result) throw new Error("plan_memory_observation_not_eligible");
  if (b.operation === "file.write" || b.operation === "file.delete" || b.operation === "file.edit") {
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: b.operation,
      delivery_digest: b.delivery_digest, result_digest: b.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched",
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation !== "file.search") throw new Error("plan_memory_observation_not_eligible");
  return {
    schema_version: "operation-result-observation.v1", record_type: "action_observation",
    plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
    command_id: b.command_id, upstream_commit_hash: b.commit_hash,
    delivery_digest: b.delivery_digest, result_digest: b.result_digest,
    output_digest: createHash("sha256").update(JSON.stringify(result.output)).digest("hex"),
    result, adoption_status: "observation_only", used_as_world_truth: false,
    used_for_authority: false, may_execute: false,
  };
}

export function resultMemoryIdentity(b: Binding) {
  const id = createHash("sha256").update(JSON.stringify(["plan-result-memory.v1", b.command_id, b.delivery_digest])).digest("hex");
  return { update_id: `result-update:${id}`, j_event_id: `result-observation:${id}`, record_id: `result-observation:${id}` };
}

export function buildResultMemoryCommit(p: Plan, b: Binding, expected_version: number): MemoryCommitV2 {
  const id = resultMemoryIdentity(b);
  const content = { schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION, expected_version,
    update_id: id.update_id, j_event_id: id.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: id.record_id,
      value: resultObservation(p, b) as unknown as MemoryCommitJsonValue }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

export function verifyResultMemoryCommit(p: Plan, b: Binding): boolean {
  if (!b.memory_commit) return false;
  const parsed = parseMemoryCommitV2(b.memory_commit);
  if (!parsed.ok) return false;
  return parsed.content_digest === buildResultMemoryCommit(p, b, parsed.commit.expected_version).content_digest;
}

export function receiptForResultCommit(receipt: MemoryUpdateReceiptV1, commit: MemoryCommitV2): boolean {
  const parsed = parseMemoryUpdateReceipt(receipt);
  return parsed.ok && parsed.receipt.update_id === commit.update_id &&
    parsed.receipt.content_digest === commit.content_digest && parsed.receipt.previous_revision === commit.expected_version;
}

/** A direct shell result is retained as a digest-only report, never as authority or world truth. */
export function shellExecResultMemoryObservation(observation: ShellExecObservation) {
  return {
    schema_version: "shell-exec-result-observation.v1",
    record_type: "shell_exec_result_observation",
    command_id_digest: observation.command_id_digest,
    request_id_digest: observation.request_id_digest,
    upstream_commit_hash_digest: observation.upstream_commit_hash_digest,
    command_payload_digest: observation.command_payload_digest,
    result_id_digest: observation.result_id_digest,
    result_contract_digest: observation.result_contract_digest,
    result_digest: observation.result_digest,
    execution_status: observation.execution_status,
    execution_boundary: observation.execution_boundary,
    action_outcome: observation.action_outcome,
    plan_step_binding: observation.plan_step_binding,
    observed_at_ms: observation.observed_at_ms,
    adoption_status: "observation_only",
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  } as const;
}

export function shellExecResultMemoryIdentity(observation: ShellExecObservation) {
  const id = createHash("sha256").update(JSON.stringify([
    "shell-exec-result-memory.v1", observation.command_id_digest, observation.result_contract_digest,
  ])).digest("hex");
  return { update_id: `shell-result-update:${id}`, j_event_id: `shell-result-observation:${id}`,
    record_id: `shell-result-observation:${id}` };
}

export function buildShellExecResultMemoryCommit(observation: ShellExecObservation, expected_version: number): MemoryCommitV2 {
  const id = shellExecResultMemoryIdentity(observation);
  const content = { schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION, expected_version,
    update_id: id.update_id, j_event_id: id.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: id.record_id,
      value: shellExecResultMemoryObservation(observation) as unknown as MemoryCommitJsonValue }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

export function verifyShellExecResultMemoryCommit(observation: ShellExecObservation): boolean {
  if (!observation.memory_commit) return false;
  const parsed = parseMemoryCommitV2(observation.memory_commit);
  if (!parsed.ok) return false;
  return parsed.content_digest === buildShellExecResultMemoryCommit(observation,
    parsed.commit.expected_version).content_digest;
}
