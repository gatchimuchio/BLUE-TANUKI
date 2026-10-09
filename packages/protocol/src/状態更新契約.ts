import { createHash } from "node:crypto";
import { z } from "zod";

export const MEMORY_COMMIT_V1_SCHEMA_VERSION = "blue-tanuki.memory-commit.v1" as const;
export const MEMORY_COMMIT_V2_SCHEMA_VERSION = "blue-tanuki.memory-commit.v2" as const;
export const MEMORY_COMMIT_SCHEMA_VERSION = MEMORY_COMMIT_V2_SCHEMA_VERSION;
export const MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION = "blue-tanuki.memory-update-receipt.v1" as const;
export const MEMORY_COMMIT_MAX_BYTES = 1_048_576;
export const MEMORY_COMMIT_MAX_DEPTH = 32;
export const MEMORY_COMMIT_MAX_CHANGES = 256;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ReferenceSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/);

export const OBSERVATION_ACQUISITION_SCHEMA_VERSION = "blue-tanuki.observation-acquisition.v1" as const;
export const MEANING_UPDATE_PROPOSAL_SCHEMA_VERSION = "blue-tanuki.meaning-update-proposal.v1" as const;

/** 正規化済み入力を取得した記録。内容の真実性・採用・権限利用を主張しない。 */
export const ObservationAcquisitionRecordSchema = z.object({
  schema_version: z.literal(OBSERVATION_ACQUISITION_SCHEMA_VERSION),
  record_type: z.literal("observation_acquisition"),
  record_id: IdentifierSchema,
  request_id: z.string().min(1).max(200),
  source_channel: z.string().min(1).max(80),
  actor_digest: DigestSchema,
  acquired_at: z.number().finite().nonnegative(),
  content_digest: DigestSchema,
  content_chars: z.number().int().nonnegative().safe(),
  metadata_key_count: z.number().int().nonnegative().safe(),
  reply_to_present: z.boolean(),
  webhook_source_digest: DigestSchema.optional(),
  boundary_status: z.literal("canonical"),
  semantic_status: z.literal("unassessed"),
  adoption_status: z.literal("not_adopted"),
  used_as_world_truth: z.literal(false),
  used_for_authority: z.literal(false),
}).strict();

export type ObservationAcquisitionRecord = z.infer<typeof ObservationAcquisitionRecordSchema>;

const EvidenceReferenceSchema = z.object({
  reference: ReferenceSchema,
  digest: DigestSchema,
}).strict();

const CounterevidenceReviewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reviewed_with_references"),
    review_scope: EvidenceReferenceSchema,
    references: z.array(EvidenceReferenceSchema).min(1).max(32),
  }).strict(),
  z.object({
    status: z.literal("reviewed_none_found"),
    review_scope: EvidenceReferenceSchema,
    references: z.array(EvidenceReferenceSchema).length(0),
  }).strict(),
]);

/** digestと参照だけを持つCの提案。解析は形状だけを検査し、真実性・承認・採用・記憶更新・実行適格性を決めない。 */
export const MeaningUpdateProposalSchema = z.object({
  schema_version: z.literal(MEANING_UPDATE_PROPOSAL_SCHEMA_VERSION),
  record_type: z.literal("meaning_update_proposal"),
  proposal_ref: IdentifierSchema,
  candidate_ref: ReferenceSchema,
  candidate_digest: DigestSchema,
  target_ref: ReferenceSchema,
  prior_version_ref: ReferenceSchema,
  supporting_evidence: z.array(EvidenceReferenceSchema).min(1).max(32),
  counterevidence_review: CounterevidenceReviewSchema,
  applicability_scope: EvidenceReferenceSchema,
  reflection_target_ref: ReferenceSchema,
  proposal_status: z.literal("unverified"),
  adoption_status: z.literal("not_adopted"),
  may_apply: z.literal(false),
  used_for_authority: z.literal(false),
}).strict();

export type MeaningUpdateProposal = z.infer<typeof MeaningUpdateProposalSchema>;

export type SemanticRecordParseResult<T> =
  | { ok: true; record: T }
  | { ok: false; reason: "schema_validation_failed" };

export function parseObservationAcquisitionRecord(value: unknown): SemanticRecordParseResult<ObservationAcquisitionRecord> {
  try {
    const parsed = ObservationAcquisitionRecordSchema.safeParse(value);
    return parsed.success
      ? { ok: true, record: parsed.data }
      : { ok: false, reason: "schema_validation_failed" };
  } catch {
    return { ok: false, reason: "schema_validation_failed" };
  }
}

export function parseMeaningUpdateProposal(value: unknown): SemanticRecordParseResult<MeaningUpdateProposal> {
  try {
    const parsed = MeaningUpdateProposalSchema.safeParse(value);
    return parsed.success
      ? { ok: true, record: parsed.data }
      : { ok: false, reason: "schema_validation_failed" };
  } catch {
    return { ok: false, reason: "schema_validation_failed" };
  }
}

export type MemoryCommitJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly MemoryCommitJsonValue[]
  | { readonly [key: string]: MemoryCommitJsonValue };

const MemoryCommitJsonValueSchema: z.ZodType<MemoryCommitJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(MemoryCommitJsonValueSchema),
    z.record(MemoryCommitJsonValueSchema),
  ]),
);

const MemoryCommitChangeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("upsert"),
    record_id: IdentifierSchema,
    value: MemoryCommitJsonValueSchema,
  }).strict(),
  z.object({
    operation: z.literal("delete"),
    record_id: IdentifierSchema,
  }).strict(),
]);

const MemoryCommitSharedFields = {
  update_id: IdentifierSchema,
  j_event_id: IdentifierSchema,
  changes: z.array(MemoryCommitChangeSchema).min(1).max(MEMORY_COMMIT_MAX_CHANGES),
  content_digest: DigestSchema,
};

export const MemoryCommitV1Schema = z.object({
  schema_version: z.literal(MEMORY_COMMIT_V1_SCHEMA_VERSION),
  ...MemoryCommitSharedFields,
}).strict();

export const MemoryCommitV2Schema = z.object({
  schema_version: z.literal(MEMORY_COMMIT_V2_SCHEMA_VERSION),
  expected_version: z.number().int().nonnegative().safe(),
  ...MemoryCommitSharedFields,
}).strict();

const MemoryCommitSchema = z.discriminatedUnion("schema_version", [
  MemoryCommitV1Schema,
  MemoryCommitV2Schema,
]);

const MemoryCommitContentSchema = z.discriminatedUnion("schema_version", [
  MemoryCommitV1Schema.omit({ content_digest: true }),
  MemoryCommitV2Schema.omit({ content_digest: true }),
]);

export type MemoryCommitChangeV1 = z.infer<typeof MemoryCommitChangeSchema>;
export type MemoryCommitV1 = z.infer<typeof MemoryCommitV1Schema>;
export type MemoryCommitV2 = z.infer<typeof MemoryCommitV2Schema>;
export type MemoryCommitContentV1 = Omit<MemoryCommitV1, "content_digest">;
export type MemoryCommitContentV2 = Omit<MemoryCommitV2, "content_digest">;
export type MemoryCommitContent = MemoryCommitContentV1 | MemoryCommitContentV2;

const MemoryUpdateReceiptV1BaseSchema = z.object({
  schema_version: z.literal(MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION),
  update_id: IdentifierSchema,
  event_id: IdentifierSchema,
  previous_revision: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(),
  content_digest: DigestSchema,
  event_digest: DigestSchema,
  committed_at_utc: z.string().datetime({ offset: false }),
  receipt_digest: DigestSchema,
}).strict();

export const MemoryUpdateReceiptV1Schema = MemoryUpdateReceiptV1BaseSchema.superRefine(
  (receipt, context) => {
    if (receipt.revision !== receipt.previous_revision + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revision must advance exactly once",
        path: ["revision"],
      });
    }
  },
);

export type MemoryUpdateReceiptV1 = z.infer<typeof MemoryUpdateReceiptV1Schema>;

export type MemoryCommitFailureReason =
  | "schema_validation_failed"
  | "invalid_json_value"
  | "duplicate_record_id"
  | "payload_too_large"
  | "payload_too_deep"
  | "content_digest_mismatch";

export type MemoryCommitParseResult =
  | {
      ok: true;
      commit: MemoryCommitV1 | MemoryCommitV2;
      canonical_content_json: string;
      content_digest: string;
    }
  | { ok: false; reason: MemoryCommitFailureReason };

export type MemoryCommitV2ParseResult =
  | {
      ok: true;
      commit: MemoryCommitV2;
      canonical_content_json: string;
      content_digest: string;
    }
  | { ok: false; reason: MemoryCommitFailureReason };

export type MemoryReceiptParseResult =
  | { ok: true; receipt: MemoryUpdateReceiptV1 }
  | { ok: false; reason: "schema_validation_failed" | "receipt_digest_mismatch" };

/**
 * Compute the content digest bound to a J-owned approval reference.
 * This function validates shape only; it does not create or verify approval.
 */
export function memoryCommitContentDigest(
  input: MemoryCommitContent,
): string {
  const rawFailure = safelyInspectJsonValue(input);
  if (rawFailure || canonicalByteLength(input) > MEMORY_COMMIT_MAX_BYTES) {
    throw new Error("invalid memory commit content");
  }
  const parsed = MemoryCommitContentSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("invalid memory commit content");
  }
  const seenRecordIds = new Set<string>();
  for (const change of parsed.data.changes) {
    if (seenRecordIds.has(change.record_id)) {
      throw new Error("invalid memory commit content");
    }
    seenRecordIds.add(change.record_id);
  }
  const jsonFailure = inspectJsonValue(parsed.data.changes);
  if (jsonFailure) throw new Error("invalid memory commit content");
  const canonicalContent = canonicalJson(parsed.data);
  if (Buffer.byteLength(canonicalContent, "utf8") > MEMORY_COMMIT_MAX_BYTES) {
    throw new Error("invalid memory commit content");
  }
  return sha256(canonicalContent);
}

/** Parse a commit without echoing input values through validation errors. */
export function parseMemoryCommit(value: unknown): MemoryCommitParseResult {
  const rawFailure = safelyInspectJsonValue(value);
  if (rawFailure) return { ok: false, reason: rawFailure };
  if (canonicalByteLength(value) > MEMORY_COMMIT_MAX_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  const parsed = MemoryCommitSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "schema_validation_failed" };

  const seenRecordIds = new Set<string>();
  for (const change of parsed.data.changes) {
    if (seenRecordIds.has(change.record_id)) {
      return { ok: false, reason: "duplicate_record_id" };
    }
    seenRecordIds.add(change.record_id);
  }

  const jsonFailure = inspectJsonValue(parsed.data.changes);
  if (jsonFailure) return { ok: false, reason: jsonFailure };

  const content = commitContent(parsed.data);
  const canonicalContentJson = canonicalJson(content);
  if (Buffer.byteLength(canonicalContentJson, "utf8") > MEMORY_COMMIT_MAX_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }

  const digest = sha256(canonicalContentJson);
  if (digest !== parsed.data.content_digest) {
    return { ok: false, reason: "content_digest_mismatch" };
  }

  return {
    ok: true,
    commit: parsed.data,
    canonical_content_json: canonicalContentJson,
    content_digest: digest,
  };
}

/** Parse a current write request. V1 remains readable for persisted history but cannot omit expected_version on new writes. */
export function parseMemoryCommitV2(value: unknown): MemoryCommitV2ParseResult {
  const parsed = parseMemoryCommit(value);
  if (!parsed.ok) return parsed;
  if (parsed.commit.schema_version !== MEMORY_COMMIT_V2_SCHEMA_VERSION) {
    return { ok: false, reason: "schema_validation_failed" };
  }
  return { ...parsed, commit: parsed.commit };
}

/** Build an immutable receipt body with a digest over all other fields. */
export function createMemoryUpdateReceipt(
  input: Omit<MemoryUpdateReceiptV1, "receipt_digest">,
): MemoryUpdateReceiptV1 {
  if (safelyInspectJsonValue(input)) throw new Error("invalid memory update receipt");
  const parsed = MemoryUpdateReceiptV1BaseSchema.omit({ receipt_digest: true }).safeParse(input);
  if (!parsed.success || parsed.data.revision !== parsed.data.previous_revision + 1) {
    throw new Error("invalid memory update receipt");
  }
  return Object.freeze({
    ...parsed.data,
    receipt_digest: sha256(canonicalJson(parsed.data)),
  });
}

/** Validate receipt fields and recompute the digest without trusting callers. */
export function parseMemoryUpdateReceipt(value: unknown): MemoryReceiptParseResult {
  if (safelyInspectJsonValue(value)) return { ok: false, reason: "schema_validation_failed" };
  const parsed = MemoryUpdateReceiptV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "schema_validation_failed" };

  const { receipt_digest: _receiptDigest, ...body } = parsed.data;
  if (sha256(canonicalJson(body)) !== parsed.data.receipt_digest) {
    return { ok: false, reason: "receipt_digest_mismatch" };
  }
  return { ok: true, receipt: Object.freeze(parsed.data) };
}

function commitContent(commit: MemoryCommitV1 | MemoryCommitV2): MemoryCommitContent {
  if (commit.schema_version === MEMORY_COMMIT_V2_SCHEMA_VERSION) {
    return {
      schema_version: commit.schema_version,
      expected_version: commit.expected_version,
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      changes: commit.changes,
    };
  }
  return {
    schema_version: commit.schema_version,
    update_id: commit.update_id,
    j_event_id: commit.j_event_id,
    changes: commit.changes,
  };
}

function inspectJsonValue(
  value: unknown,
  depth = 0,
  ancestors: Set<object> = new Set(),
): MemoryCommitFailureReason | null {
  if (depth > MEMORY_COMMIT_MAX_DEPTH) return "payload_too_deep";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      return "invalid_json_value";
    }
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
      return "invalid_json_value";
    }
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) return "invalid_json_value";
    if (ancestors.has(value)) return "invalid_json_value";
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        ancestors.delete(value);
        return "invalid_json_value";
      }
      const failure = inspectJsonValue(descriptor.value, depth + 1, ancestors);
      if (failure) {
        ancestors.delete(value);
        return failure;
      }
    }
    if (Object.keys(value).length !== value.length) {
      ancestors.delete(value);
      return "invalid_json_value";
    }
    ancestors.delete(value);
    return null;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      return "invalid_json_value";
    }
    if (ancestors.has(value)) return "invalid_json_value";
    ancestors.add(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        ancestors.delete(value);
        return "invalid_json_value";
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        ancestors.delete(value);
        return "invalid_json_value";
      }
      const failure = inspectJsonValue(descriptor.value, depth + 1, ancestors);
      if (failure) {
        ancestors.delete(value);
        return failure;
      }
    }
    ancestors.delete(value);
    return null;
  }
  return "invalid_json_value";
}

function safelyInspectJsonValue(value: unknown): MemoryCommitFailureReason | null {
  try {
    return inspectJsonValue(value);
  } catch {
    return "invalid_json_value";
  }
}

function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid canonical JSON value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
