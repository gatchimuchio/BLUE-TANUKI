import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION, memoryCommitContentDigest, parseMemoryCommitV2,
  parseMemoryUpdateReceipt, type MemoryCommitV2, type MemoryCommitJsonValue,
  type MemoryUpdateReceiptV1, type OperationPlanCheckpoint,
} from "@blue-tanuki/protocol";

type Plan = OperationPlanCheckpoint["plans"][number];
type Binding = Plan["bindings"][number];
type ShellExecObservation = NonNullable<OperationPlanCheckpoint["shell_exec_result_observations"]>[number];
const BROWSER_READ_CONTEXT_MAX_CHARS = 8_000;

interface BrowserReadResultObservation {
  readonly schema_version: "browser-read-result-observation.v1";
  readonly record_type: "browser_read_observation";
  readonly plan_id_digest: string;
  readonly plan_revision_digest: string;
  readonly step_id_digest: string;
  readonly step_digest: string;
  readonly operation: "browser.read";
  readonly command_digest: string;
  readonly delivery_digest: string;
  readonly result_digest: string;
  readonly requested_origin: string;
  readonly final_origin: string;
  readonly navigation: "http_get";
  readonly tab_scope: "not_applicable";
  readonly frame_scope: "not_applicable";
  readonly credential_context: "no_tool_supplied_credentials";
  readonly evidence_source: "EXTERNAL_EVIDENCE" | "FIXTURE";
  readonly observed_at_ms: number;
  readonly page_text_excerpt: string;
  readonly page_text_excerpt_chars: number;
  readonly page_text_sha256: string;
  readonly page_text_excerpt_sha256: string;
  readonly source_truncated: boolean;
  readonly page_content_is_untrusted: true;
  readonly adoption_status: "observation_only";
  readonly used_as_world_truth: false;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export function browserReadResultObservation(
  p: Plan,
  b: Binding,
  result: Plan["results"][number],
): BrowserReadResultObservation {
  if (!b.delivery_digest || !b.result_digest) throw new Error("plan_memory_browser_read_binding_invalid");
  const output = result.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("plan_memory_browser_read_result_invalid");
  }
  const value = output as Record<string, unknown>;
  const observation = value.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("plan_memory_browser_read_observation_invalid");
  }
  const metadata = observation as Record<string, unknown>;
  if (typeof value.text !== "string" || value.text.length > 50_000 || typeof value.url !== "string" ||
      typeof value.truncated !== "boolean" || metadata.schema_version !== "blue-tanuki.browser-observation.v1" ||
      metadata.navigation !== "http_get" || metadata.tab_scope !== "not_applicable" ||
      metadata.frame_scope !== "not_applicable" || metadata.credential_context !== "no_tool_supplied_credentials" ||
      (metadata.evidence_source !== "EXTERNAL_EVIDENCE" && metadata.evidence_source !== "FIXTURE") ||
      metadata.page_content_is_untrusted !== true || metadata.used_for_authority !== false || metadata.may_execute !== false ||
      typeof metadata.observed_at !== "string" || typeof metadata.requested_origin !== "string" ||
      typeof metadata.final_origin !== "string") {
    throw new Error("plan_memory_browser_read_observation_invalid");
  }
  const observedAtMs = Date.parse(metadata.observed_at);
  const requestedOrigin = new URL(metadata.requested_origin);
  const finalOrigin = new URL(metadata.final_origin);
  const finalUrl = new URL(value.url);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || new Date(observedAtMs).toISOString() !== metadata.observed_at ||
      result.observed_at_ms < observedAtMs ||
      requestedOrigin.origin !== metadata.requested_origin || finalOrigin.origin !== metadata.final_origin ||
      !["http:", "https:"].includes(requestedOrigin.protocol) || !["http:", "https:"].includes(finalUrl.protocol) ||
      finalUrl.origin !== finalOrigin.origin || finalUrl.username || finalUrl.password) {
    throw new Error("plan_memory_browser_read_origin_or_time_invalid");
  }
  const text = value.text;
  const evidenceSource = metadata.evidence_source as "EXTERNAL_EVIDENCE" | "FIXTURE";
  const excerpt = text.slice(0, BROWSER_READ_CONTEXT_MAX_CHARS);
  const sha256 = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
  return {
    schema_version: "browser-read-result-observation.v1",
    record_type: "browser_read_observation",
    plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
    plan_revision_digest: b.revision_digest,
    step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
    step_digest: b.step_digest,
    operation: "browser.read",
    command_digest: b.command_digest,
    delivery_digest: b.delivery_digest,
    result_digest: b.result_digest,
    requested_origin: requestedOrigin.origin,
    final_origin: finalOrigin.origin,
    navigation: "http_get",
    tab_scope: "not_applicable",
    frame_scope: "not_applicable",
    credential_context: "no_tool_supplied_credentials",
    evidence_source: evidenceSource,
    observed_at_ms: observedAtMs,
    page_text_excerpt: excerpt,
    page_text_excerpt_chars: excerpt.length,
    page_text_sha256: sha256(text),
    page_text_excerpt_sha256: sha256(excerpt),
    source_truncated: value.truncated || text.length > BROWSER_READ_CONTEXT_MAX_CHARS,
    page_content_is_untrusted: true,
    adoption_status: "observation_only",
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  };
}

/** 実作用の結果記録はMを非権威に保ち、記録だけで権限や成功判定を発行しない。 */
export function resultMemoryEligible(b: Binding): boolean {
  if (b.operation === "github.write") {
    if (!b.execution_admission || !b.execution_admission.task_identity_digest ||
        !b.delivery_digest || !b.result_digest || !b.operation_plan_binding_digest ||
        b.result_observed_at_ms === undefined) return false;
    if (b.status === "verified") return b.github_write_result?.mutation_status === "provider_accepted";
    if (b.status === "provider_rejected") return b.github_write_result?.mutation_status === "provider_rejected";
    return (b.status === "outcome_unknown" || b.status === "verification_failed") && !b.github_write_result;
  }
  if (b.status === "verified") return b.operation === "file.search" || b.operation === "file.write" ||
    b.operation === "file.delete" || b.operation === "file.edit" || b.operation === "browser.read";
  return b.status === "outcome_unknown" && !!b.execution_admission && !!b.delivery_digest && !!b.result_digest;
}

/** Jが受領済みの実結果を非権威観測として固定する。意味採用・任意記憶変更の入口ではない。 */
export function resultObservation(p: Plan, b: Binding) {
  const result = p.results.find((r) => r.step_id === b.step_id);
  if (b.operation === "github.write" && resultMemoryEligible(b)) {
    const summary = b.github_write_result;
    const effectObservation = b.status === "verified" ? "reported_success"
      : b.status === "provider_rejected" ? "reported_rejection" : "unknown";
    return {
      schema_version: "github-write-outcome-observation.v1", record_type: "github_write_outcome_observation",
      task_identity_digest: b.execution_admission!.task_identity_digest!,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest,
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest,
      operation: b.operation,
      plan_binding_status: b.status,
      command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest ?? null,
      target_identity_digest: summary?.target_identity_digest ?? null,
      request_payload_digest: summary?.request_payload_digest ?? null,
      provider_result_digest: summary?.provider_result_digest ?? null,
      provider_mutation_status: summary?.mutation_status ?? null,
      provider_http_status: summary?.http_status ?? null,
      delivery_digest: b.delivery_digest!,
      result_digest: b.result_digest!,
      observed_at_ms: b.result_observed_at_ms ?? null,
      effect_observation: effectObservation,
      adoption_status: "observation_only",
      used_as_world_truth: false,
      used_for_authority: false,
      may_execute: false,
    };
  }
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
  if (b.operation === "browser.read") {
    if (!result) throw new Error("plan_memory_observation_not_eligible");
    return browserReadResultObservation(p, b, result);
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
