import { z } from "zod";

export const COMMON_RECORD_SCHEMA_VERSION = "blue-tanuki.common-record.v1" as const;

const OpaqueReferenceSchema = z.string().min(1).max(512);
const TimestampSchema = z.number().finite().nonnegative();

export const CommonRecordOriginKindSchema = z.enum([
  "user_instruction",
  "environment_observation",
  "c_output",
  "inferred",
  "configuration",
  "test_fixture",
  "legacy_history",
  "unknown",
]);

export const CommonRecordOriginSchema = z.object({
  kind: CommonRecordOriginKindSchema,
  source_ref: OpaqueReferenceSchema.optional(),
}).strict();

export const CommonRecordAssertionStateSchema = z.enum([
  "local_assertion",
  "assertion_pending",
  "failed",
  "out_of_scope",
  "unknown",
]);

export const CommonRecordAdoptionStateSchema = z.enum([
  "proposed",
  "trial_adopted",
  "effective",
  "default_disabled",
  "isolated",
  "rejected",
  "migrated_to_new_version",
  "archived",
  "unknown",
]);

export const CommonRecordOperationStateSchema = z.enum([
  "continue",
  "request_observation",
  "hold",
  "adoption_confirmed",
  "execute",
  "restore",
  "stop",
  "cancel",
  "unknown",
]);

export const CommonRecordWorkStateSchema = z.enum([
  "received",
  "identifying",
  "ready",
  "computing",
  "deciding",
  "awaiting_approval",
  "executing",
  "reconciling",
  "memory_commit_pending",
  "waiting_event",
  "waiting_input",
  "waiting_observation",
  "blocked",
  "stopping",
  "completed",
  "stopped",
  "failed",
  "rejected",
  "unknown",
]);

export const CommonRecordEffectStateSchema = z.enum([
  "proposed",
  "prepared",
  "admitted",
  "intent_committed",
  "running",
  "externally_accepted",
  "outcome_unknown",
  "verified_success",
  "verified_failure",
  "cancel_requested",
  "stopped_local",
  "compensated",
  "unknown",
]);

export const CommonRecordEvidenceStateSchema = z.enum([
  "observed",
  "reproduced",
  "local_conformance",
  "structural_repetition",
  "generalization_candidate",
  "unobserved_extrapolation",
  "refuted",
  "undecided",
  "unknown",
]);

export const CommonRecordMeaningStateSchema = z.object({
  assertion: CommonRecordAssertionStateSchema,
  adoption: CommonRecordAdoptionStateSchema,
}).strict();

export const CommonRecordExecutionStateSchema = z.object({
  operation: CommonRecordOperationStateSchema,
  work: CommonRecordWorkStateSchema,
  effect: CommonRecordEffectStateSchema,
}).strict();

export const CommonRecordEvidenceStateRecordSchema = z.object({
  status: CommonRecordEvidenceStateSchema,
}).strict();

export const CommonRecordStateSchema = z.object({
  meaning: CommonRecordMeaningStateSchema,
  execution: CommonRecordExecutionStateSchema,
  evidence: CommonRecordEvidenceStateRecordSchema,
}).strict();

export const CommonRecordSchema = z.object({
  record_id: z.string().min(1).max(200),
  record_kind: z.string().min(1).max(80),
  schema_version: z.literal(COMMON_RECORD_SCHEMA_VERSION),
  task_id: OpaqueReferenceSchema.optional(),
  run_id: OpaqueReferenceSchema.optional(),
  owner_id: OpaqueReferenceSchema,
  origin: CommonRecordOriginSchema,
  observed_at: TimestampSchema.optional(),
  recorded_at: TimestampSchema,
  effective_from: TimestampSchema.optional(),
  source_refs: z.array(OpaqueReferenceSchema).max(256),
  previous_refs: z.array(OpaqueReferenceSchema).max(256),
  state: CommonRecordStateSchema,
  unknowns: z.array(z.string().min(1).max(1024)).max(256),
  residual_refs: z.array(OpaqueReferenceSchema).max(256),
  classification: z.string().min(1).max(80),
  content_ref: OpaqueReferenceSchema.optional(),
  content_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((record, context) => {
  if ((record.content_ref === undefined) !== (record.content_digest === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "content_ref and content_digest must be present together",
      path: [record.content_ref === undefined ? "content_ref" : "content_digest"],
    });
  }
});

export type CommonRecord = z.infer<typeof CommonRecordSchema>;
export type CommonRecordOriginKind = z.infer<typeof CommonRecordOriginKindSchema>;
export type CommonRecordState = z.infer<typeof CommonRecordStateSchema>;

export type JsonTextBoundaryFailureReason =
  | "invalid_json"
  | "duplicate_key"
  | "non_finite_number";

export type JsonTextBoundaryResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: JsonTextBoundaryFailureReason };

export type CommonRecordBoundaryResult =
  | { ok: true; record: CommonRecord }
  | { ok: false; reason: JsonTextBoundaryFailureReason | "schema_validation_failed"; issue_codes?: string[] };

/**
 * JSONテキストの重複keyと有限数値を確認してから値を返す。
 * 入力本文や不正keyを失敗理由へ含めない。
 */
export function parseJsonTextAtBoundary(text: string): JsonTextBoundaryResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (hasDuplicateObjectKeys(text)) {
    return { ok: false, reason: "duplicate_key" };
  }
  if (containsNonFiniteNumber(value)) {
    return { ok: false, reason: "non_finite_number" };
  }
  return { ok: true, value };
}

/** 共通recordを実際のJSON文字列境界で解析・検証する。 */
export function parseCommonRecordAtBoundary(text: string): CommonRecordBoundaryResult {
  const json = parseJsonTextAtBoundary(text);
  if (!json.ok) return json;

  const parsed = CommonRecordSchema.safeParse(json.value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_validation_failed",
      issue_codes: [...new Set(parsed.error.issues.map((issue) => issue.code))],
    };
  }
  return { ok: true, record: parsed.data };
}

function containsNonFiniteNumber(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number" && !Number.isFinite(current)) return true;
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current && typeof current === "object") {
      for (const nested of Object.values(current as Record<string, unknown>)) pending.push(nested);
    }
  }
  return false;
}

type JsonContainerFrame =
  | { kind: "object"; keys: Set<string>; expectingKey: boolean }
  | { kind: "array" };

function hasDuplicateObjectKeys(text: string): boolean {
  const stack: JsonContainerFrame[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index]!;
    if (character === " " || character === "\n" || character === "\r" || character === "\t") {
      index += 1;
      continue;
    }

    if (character === "{") {
      stack.push({ kind: "object", keys: new Set<string>(), expectingKey: true });
      index += 1;
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (character === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.kind === "object") frame.expectingKey = true;
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < text.length) {
      const stringCharacter = text[index]!;
      if (stringCharacter === "\\") {
        index += 2;
      } else if (stringCharacter === '"') {
        index += 1;
        break;
      } else {
        index += 1;
      }
    }

    const frame = stack[stack.length - 1];
    if (frame?.kind === "object" && frame.expectingKey) {
      const key = JSON.parse(text.slice(start, index)) as string;
      if (frame.keys.has(key)) return true;
      frame.keys.add(key);
      frame.expectingKey = false;
    }
  }

  return false;
}
