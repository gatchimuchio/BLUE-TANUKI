import { createHash } from "node:crypto";

const DIGEST = /^[a-f0-9]{64}$/;
const EVENT_ID = /^cron-[a-f0-9]{64}$/;

export type CronTaskOutcomeObservationStatus = "achieved" | "in_progress" | "held" | "unobserved" | "unverified";
export type CronFinalOutputObservationStatus = "observed" | "not_observed" | "not_observed_due_to_limit" | "unverified";
export type CronResultMemoryObservationStatus = "receipts_observed" | "no_receipt_observed" | "not_observed" | "unverified";

export interface CronEventResultReceipt {
  readonly schema_version: "blue-tanuki.cron-event-result-receipt.v1";
  readonly event_id_digest: string;
  readonly request_id_digest: string;
  readonly source_digest: string;
  readonly sequence: number;
  readonly payload_digest: string;
  readonly plan_match_status: "matched" | "not_found" | "ambiguous" | "unverified";
  readonly plan_id_digest: string | null;
  readonly plan_revision_digest: string | null;
  readonly task_outcome_status: CronTaskOutcomeObservationStatus;
  readonly task_outcome_reason_digest: string | null;
  readonly result_memory_status: CronResultMemoryObservationStatus;
  readonly result_memory_receipt_count: number;
  readonly result_memory_receipt_set_digest: string | null;
  readonly final_output_status: CronFinalOutputObservationStatus;
  readonly final_output_count: number;
  readonly latest_final_output_digest: string | null;
  readonly observed_at_ms: number;
  readonly used_for_authority: false;
  readonly may_execute: false;
  readonly receipt_digest: string;
}

export interface CronResultEventIdentity {
  readonly source: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly payload_digest: string;
}

export interface CronFinalOutputHistorySnapshot {
  readonly entries: readonly unknown[];
  readonly chain_valid: boolean;
  readonly skipped_count: number;
}

/** Build a digest-only observation from J's persisted plan projection and output-audit history. */
export function createCronEventResultReceipt(
  event: CronResultEventIdentity,
  operationPlans: unknown,
  finalOutputHistory: CronFinalOutputHistorySnapshot,
  observedAtMs = Date.now(),
): CronEventResultReceipt {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) throw new Error("invalid_cron_result_receipt_time");
  validateEventIdentity(event);
  const identity = {
    event_id_digest: sha256(event.event_id),
    request_id_digest: sha256(event.event_id),
    source_digest: sha256(event.source.normalize("NFKC").trim()),
    sequence: event.sequence,
    payload_digest: event.payload_digest,
  };
  const plan = observePlan(operationPlans, event.event_id);
  const output = observeFinalOutput(finalOutputHistory, event.event_id);
  const base = {
    schema_version: "blue-tanuki.cron-event-result-receipt.v1" as const,
    ...identity,
    ...plan,
    ...output,
    observed_at_ms: observedAtMs,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return Object.freeze({ ...base, receipt_digest: sha256(JSON.stringify(base)) });
}

/** Validate a stored receipt and its own content digest before it enters recovery projections. */
export function parseCronEventResultReceipt(value: unknown): CronEventResultReceipt | null {
  if (!isRecord(value)) return null;
  const allowed = [
    "schema_version", "event_id_digest", "request_id_digest", "source_digest", "sequence", "payload_digest",
    "plan_match_status", "plan_id_digest", "plan_revision_digest", "task_outcome_status", "task_outcome_reason_digest",
    "result_memory_status", "result_memory_receipt_count", "result_memory_receipt_set_digest", "final_output_status",
    "final_output_count", "latest_final_output_digest", "observed_at_ms", "used_for_authority", "may_execute", "receipt_digest",
  ];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key)) ||
      value.schema_version !== "blue-tanuki.cron-event-result-receipt.v1" ||
      !isDigest(value.event_id_digest) || !isDigest(value.request_id_digest) || !isDigest(value.source_digest) ||
      value.event_id_digest !== value.request_id_digest || !nonnegativeSafeInteger(value.sequence) ||
      !isDigest(value.payload_digest) || !isOneOf(value.plan_match_status, ["matched", "not_found", "ambiguous", "unverified"]) ||
      !nullableDigest(value.plan_id_digest) || !nullableDigest(value.plan_revision_digest) ||
      !isOneOf(value.task_outcome_status, ["achieved", "in_progress", "held", "unobserved", "unverified"]) ||
      !nullableDigest(value.task_outcome_reason_digest) ||
      !isOneOf(value.result_memory_status, ["receipts_observed", "no_receipt_observed", "not_observed", "unverified"]) ||
      !nonnegativeSafeInteger(value.result_memory_receipt_count) || !nullableDigest(value.result_memory_receipt_set_digest) ||
      !isOneOf(value.final_output_status, ["observed", "not_observed", "not_observed_due_to_limit", "unverified"]) ||
      !nonnegativeSafeInteger(value.final_output_count) || !nullableDigest(value.latest_final_output_digest) ||
      !nonnegativeSafeInteger(value.observed_at_ms) || value.used_for_authority !== false || value.may_execute !== false ||
      !isDigest(value.receipt_digest) || !receiptFieldsConsistent(value)) return null;
  const receipt = value as unknown as CronEventResultReceipt;
  const { receipt_digest, ...base } = receipt;
  return sha256(JSON.stringify(base)) === receipt_digest ? receipt : null;
}

function receiptFieldsConsistent(value: Record<string, unknown>): boolean {
  const planMatched = value.plan_match_status === "matched";
  if (planMatched !== (value.plan_id_digest !== null && value.plan_revision_digest !== null) ||
      (!planMatched && (value.plan_id_digest !== null || value.plan_revision_digest !== null))) return false;
  if ((value.plan_match_status === "not_found") !== (value.task_outcome_status === "unobserved")) return false;
  const taskHasReason = ["achieved", "in_progress", "held"].includes(String(value.task_outcome_status));
  if (taskHasReason !== (value.task_outcome_reason_digest !== null) ||
      (planMatched && !taskHasReason) ||
      (["ambiguous", "unverified"].includes(String(value.plan_match_status)) && value.task_outcome_status !== "unverified")) return false;
  if (value.plan_match_status === "not_found" && value.result_memory_status !== "not_observed" ||
      ["ambiguous", "unverified"].includes(String(value.plan_match_status)) && value.result_memory_status !== "unverified") return false;
  const memoryCount = value.result_memory_receipt_count as number;
  if ((memoryCount === 0) !== (value.result_memory_receipt_set_digest === null)) return false;
  if (value.result_memory_status === "receipts_observed" ? memoryCount === 0
      : value.result_memory_status === "no_receipt_observed" ? memoryCount !== 0
        : memoryCount !== 0 || value.result_memory_receipt_set_digest !== null) return false;
  const outputCount = value.final_output_count as number;
  if (value.final_output_status === "observed") {
    if (outputCount < 1 || !isDigest(value.latest_final_output_digest)) return false;
  } else if (outputCount !== 0 || value.latest_final_output_digest !== null) return false;
  return true;
}

function observePlan(operationPlans: unknown, eventId: string): Pick<CronEventResultReceipt,
  "plan_match_status" | "plan_id_digest" | "plan_revision_digest" | "task_outcome_status" |
  "task_outcome_reason_digest" | "result_memory_status" | "result_memory_receipt_count" | "result_memory_receipt_set_digest"> {
  const invalid = {
    plan_match_status: "unverified" as const, plan_id_digest: null, plan_revision_digest: null,
    task_outcome_status: "unverified" as const, task_outcome_reason_digest: null,
    result_memory_status: "unverified" as const, result_memory_receipt_count: 0, result_memory_receipt_set_digest: null,
  };
  if (!isRecord(operationPlans) || operationPlans.schema_version !== "operation-plan-projection.v1" ||
      operationPlans.used_for_authority !== false || operationPlans.raw_payload_exposed !== false ||
      operationPlans.recovery_refresh_status !== "ready" || !Array.isArray(operationPlans.plans) ||
      !isRecord(operationPlans.result_memory) || operationPlans.result_memory.used_for_authority !== false ||
      typeof operationPlans.result_memory.configured !== "boolean" ||
      !isOneOf(operationPlans.result_memory.status, ["not_configured", "receipt_confirmed", "pending_or_unavailable"]) ||
      (operationPlans.result_memory.configured === false && operationPlans.result_memory.status !== "not_configured") ||
      (operationPlans.result_memory.configured === true && operationPlans.result_memory.status === "not_configured")) return invalid;
  const matches = operationPlans.plans.filter((plan) => isRecord(plan) && plan.request_id === eventId);
  if (matches.length === 0) {
    return { ...invalid, plan_match_status: "not_found", task_outcome_status: "unobserved", result_memory_status: "not_observed" };
  }
  if (matches.length !== 1 || !isRecord(matches[0])) {
    return { ...invalid, plan_match_status: "ambiguous" };
  }
  const plan = matches[0];
  const task = plan.task_outcome;
  if (!isDigest(plan.plan_id) || !isDigest(plan.revision_digest) || !isRecord(task) ||
      task.used_for_authority !== false || task.may_execute !== false ||
      !isOneOf(task.status, ["achieved", "in_progress", "held"]) ||
      typeof task.reason_code !== "string" || !/^[a-z0-9_]{1,80}$/i.test(task.reason_code) || !Array.isArray(plan.bindings) ||
      !plan.bindings.every((binding) => isRecord(binding) && isDigest(binding.revision_digest) &&
        isOneOf(binding.memory_status, ["receipt_confirmed", "memory_commit_pending", "not_recorded"]))) {
    return invalid;
  }
  const currentBindings = plan.bindings.filter((binding) => isRecord(binding) && binding.revision_digest === plan.revision_digest);
  if (operationPlans.result_memory.status !== "receipt_confirmed") {
    return {
      plan_match_status: "matched",
      plan_id_digest: plan.plan_id,
      plan_revision_digest: plan.revision_digest,
      task_outcome_status: task.status,
      task_outcome_reason_digest: sha256(task.reason_code),
      result_memory_status: operationPlans.result_memory.status === "pending_or_unavailable" ? "unverified" : "not_observed",
      result_memory_receipt_count: 0,
      result_memory_receipt_set_digest: null,
    };
  }
  const receiptDigests: string[] = [];
  let pendingReceipt = false;
  for (const binding of currentBindings) {
    if (binding.memory_status === "receipt_confirmed") {
      if (!isDigest(binding.memory_receipt_digest)) return invalid;
      receiptDigests.push(binding.memory_receipt_digest);
    } else if (binding.memory_status === "memory_commit_pending") {
      pendingReceipt = true;
    }
  }
  const sortedReceiptDigests = receiptDigests.sort();
  return {
    plan_match_status: "matched",
    plan_id_digest: plan.plan_id,
    plan_revision_digest: plan.revision_digest,
    task_outcome_status: task.status,
    task_outcome_reason_digest: sha256(task.reason_code),
    result_memory_status: sortedReceiptDigests.length > 0 ? "receipts_observed" : pendingReceipt ? "not_observed" : "no_receipt_observed",
    result_memory_receipt_count: sortedReceiptDigests.length,
    result_memory_receipt_set_digest: sortedReceiptDigests.length > 0 ? sha256(JSON.stringify(sortedReceiptDigests)) : null,
  };
}

function observeFinalOutput(snapshot: CronFinalOutputHistorySnapshot, eventId: string): Pick<CronEventResultReceipt,
  "final_output_status" | "final_output_count" | "latest_final_output_digest"> {
  const invalid = { final_output_status: "unverified" as const, final_output_count: 0, latest_final_output_digest: null };
  if (!isRecord(snapshot) || snapshot.chain_valid !== true || !Array.isArray(snapshot.entries) ||
      !nonnegativeSafeInteger(snapshot.skipped_count)) return invalid;
  const matches = snapshot.entries.filter((entry) => isRecord(entry) && entry.kind === "final_output" && entry.request_id === eventId);
  if (matches.length === 0) {
    return snapshot.skipped_count > 0
      ? { final_output_status: "not_observed_due_to_limit", final_output_count: 0, latest_final_output_digest: null }
      : { final_output_status: "not_observed", final_output_count: 0, latest_final_output_digest: null };
  }
  const digests: string[] = [];
  for (const entry of matches) {
    if (!isRecord(entry) || !isRecord(entry.payload) || !isDigest(entry.payload.rendered_output_digest)) return invalid;
    digests.push(entry.payload.rendered_output_digest);
  }
  return { final_output_status: "observed", final_output_count: digests.length, latest_final_output_digest: digests.at(-1)! };
}

function validateEventIdentity(event: CronResultEventIdentity): void {
  if (typeof event.source !== "string" || event.source !== event.source.normalize("NFKC").trim() || event.source.length === 0 ||
      !EVENT_ID.test(event.event_id) || !nonnegativeSafeInteger(event.sequence) || !isDigest(event.payload_digest) ||
      event.event_id !== `cron-${sha256(`${sha256(event.source)}\0${event.sequence}`)}`) {
    throw new Error("invalid_cron_result_receipt_event_identity");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}
