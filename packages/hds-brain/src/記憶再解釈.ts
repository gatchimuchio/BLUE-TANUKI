import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION,
  memoryCommitContentDigest,
  parseMemoryCommitV2,
  type MemoryCommitJsonValue,
  type MemoryCommitV2,
} from "@blue-tanuki/protocol";
import {
  JMemoryCommitCoordinator,
  type JMemoryCommitReconciliationResult,
} from "./制御状態.js";
import {
  canonicalJson,
  interpretationContentDigest,
  isJsonValue,
  isPlainRecord,
  type MemoryInterpretation,
  type MemoryInterpretationEvidenceReference,
} from "./memory_interpretation_semantics.js";
export { interpretationContentDigest };
export type { MemoryInterpretation, MemoryInterpretationEvidenceReference } from "./memory_interpretation_semantics.js";

export const MEMORY_INTERPRETATION_SCHEMA_VERSION = "blue-tanuki.memory-interpretation.v1" as const;
const RECORD_ID_PREFIX = "memory-interpretation:";
const MAX_INTERPRETATIONS = 256;
const MAX_EVENTS = 512;
const MAX_JUDGMENTS = 256;
export interface MemoryInterpretationEvent {
  readonly event_id: string;
  readonly kind: "quarantined" | "restored" | "reassessed";
  readonly prior_interpretation_id: string;
  readonly resulting_interpretation_id: string | null;
  readonly reason_digest: string;
  readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
  readonly affected_judgment_refs: readonly string[];
  /** The fresh J judgment that explicitly resolves the affected older judgments. */
  readonly reassessment_judgment_ref?: string;
}

export interface MemoryInterpretationJudgment {
  readonly judgment_ref: string;
  readonly basis_interpretation_id: string;
  readonly reassessment_required: boolean;
}

export interface MemoryInterpretationRecord {
  readonly schema_version: typeof MEMORY_INTERPRETATION_SCHEMA_VERSION;
  readonly record_type: "memory_interpretation";
  readonly lineage_id: string;
  readonly application_state: "active" | "quarantined";
  readonly current_interpretation_id: string | null;
  readonly interpretations: readonly MemoryInterpretation[];
  readonly events: readonly MemoryInterpretationEvent[];
  readonly dependent_judgments: readonly MemoryInterpretationJudgment[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface MemoryInterpretationSnapshot {
  readonly revision: number;
  readonly event_digest: string;
  readonly record: MemoryInterpretationRecord | null;
  readonly used_for_authority: false;
}

export type MemoryInterpretationTransition =
  | {
      readonly kind: "quarantine";
      readonly event_id: string;
      readonly reason_digest: string;
      readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
      readonly affected_judgment_refs: readonly string[];
    }
  | {
      readonly kind: "restore";
      readonly event_id: string;
      readonly reason_digest: string;
      readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
      readonly interpretation: MemoryInterpretation;
      readonly reassessment_judgment_ref?: string;
    }
  | {
      readonly kind: "replace";
      readonly quarantine_event_id: string;
      readonly restoration_event_id: string;
      readonly reason_digest: string;
      readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
      readonly affected_judgment_refs: readonly string[];
      readonly interpretation: MemoryInterpretation;
      readonly reassessment_judgment_ref: string;
    }
  | {
      readonly kind: "reassess";
      readonly event_id: string;
      readonly reason_digest: string;
      readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
      readonly affected_judgment_refs: readonly string[];
      readonly reassessment_judgment_ref: string;
    };

export type MemoryInterpretationBuildResult =
  | { readonly ok: true; readonly record_id: string; readonly record: MemoryInterpretationRecord; readonly commit: MemoryCommitV2 }
  | { readonly ok: false; readonly reason: "invalid_current_record" | "invalid_transition" | "invalid_commit_reference" };

export type MemoryInterpretationApplyResult =
  | {
      readonly ok: true;
      readonly record: MemoryInterpretationRecord;
      readonly reconciliation: Extract<JMemoryCommitReconciliationResult, { readonly ok: true; readonly status: "ready" }>;
    }
  | {
      readonly ok: false;
      readonly stage: "validation" | "read" | "j_stage" | "m_apply" | "j_reconcile";
      readonly reason: string;
    };

/** Build a first accepted interpretation record for an existing J-approved M commit. */
export function createInitialMemoryInterpretationRecord(input: {
  readonly lineage_id: string;
  readonly interpretation: MemoryInterpretation;
  readonly dependent_judgment_refs: readonly string[];
}): MemoryInterpretationRecord | null {
  if (!isLineageId(input.lineage_id) || !isInterpretation(input.interpretation) ||
      !isReferenceArray(input.dependent_judgment_refs, MAX_JUDGMENTS, 1) ||
      new Set(input.dependent_judgment_refs).size !== input.dependent_judgment_refs.length ||
      input.dependent_judgment_refs.some((reference) => !isReference(reference))) return null;

  return Object.freeze({
    schema_version: MEMORY_INTERPRETATION_SCHEMA_VERSION,
    record_type: "memory_interpretation",
    lineage_id: input.lineage_id,
    application_state: "active",
    current_interpretation_id: input.interpretation.interpretation_id,
    interpretations: Object.freeze([Object.freeze({ ...input.interpretation })]),
    events: Object.freeze([]),
    dependent_judgments: Object.freeze(input.dependent_judgment_refs.map((judgment_ref) => Object.freeze({
      judgment_ref,
      basis_interpretation_id: input.interpretation.interpretation_id,
      reassessment_required: false,
    }))),
    used_for_authority: false,
    may_execute: false,
  });
}

/** Build an initial interpretation record into the same J-approved M transaction as its meaning. */
export function buildInitialMemoryInterpretationCommit(input: {
  readonly current: MemoryInterpretationSnapshot;
  readonly lineage_id: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly interpretation: MemoryInterpretation;
  readonly dependent_judgment_refs: readonly string[];
}): MemoryInterpretationBuildResult {
  if (!Number.isSafeInteger(input.current.revision) || input.current.revision < 0 || input.current.record !== null) {
    return { ok: false, reason: "invalid_current_record" };
  }
  if (!isIdentifier(input.update_id) || !isIdentifier(input.j_event_id)) {
    return { ok: false, reason: "invalid_commit_reference" };
  }
  const record = createInitialMemoryInterpretationRecord({
    lineage_id: input.lineage_id,
    interpretation: input.interpretation,
    dependent_judgment_refs: input.dependent_judgment_refs,
  });
  if (!record) return { ok: false, reason: "invalid_transition" };
  const content = {
    schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
    expected_version: input.current.revision,
    update_id: input.update_id,
    j_event_id: input.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: memoryInterpretationRecordId(input.lineage_id),
      value: toCommitJsonValue(record) }],
  };
  try {
    const commit: MemoryCommitV2 = { ...content, content_digest: memoryCommitContentDigest(content) };
    return { ok: true, record_id: memoryInterpretationRecordId(input.lineage_id), record, commit };
  } catch {
    return { ok: false, reason: "invalid_commit_reference" };
  }
}

/** Build the exact content candidate that a J approval producer must bind. */
export function buildMemoryInterpretationCommit(input: {
  readonly current: MemoryInterpretationSnapshot;
  readonly lineage_id: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly transition: MemoryInterpretationTransition;
}): MemoryInterpretationBuildResult {
  if (!isLineageId(input.lineage_id) || !isIdentifier(input.update_id) || !isIdentifier(input.j_event_id)) {
    return { ok: false, reason: "invalid_commit_reference" };
  }
  const recordId = memoryInterpretationRecordId(input.lineage_id);
  if (!input.current.record) {
    return { ok: false, reason: "invalid_current_record" };
  }
  const current = parseMemoryInterpretationRecord(input.current.record);
  if (!current || current.lineage_id !== input.lineage_id || !Number.isSafeInteger(input.current.revision) ||
      input.current.revision < 0) {
    return { ok: false, reason: "invalid_current_record" };
  }
  const next = applyTransition(current, input.transition);
  if (!next) return { ok: false, reason: "invalid_transition" };

  const content = {
    schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
    expected_version: input.current.revision,
    update_id: input.update_id,
    j_event_id: input.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: recordId, value: toCommitJsonValue(next) }],
  };
  try {
    const commit: MemoryCommitV2 = {
      ...content,
      content_digest: memoryCommitContentDigest(content),
    };
    return { ok: true, record_id: recordId, record: next, commit };
  } catch {
    return { ok: false, reason: "invalid_commit_reference" };
  }
}

/** Build one append-only M transaction from a fresh J judgment to explicit prior-judgment reassessment. */
export function buildMemoryInterpretationReassessmentCommit(input: {
  readonly current: MemoryInterpretationSnapshot;
  readonly lineage_id: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly event_id: string;
  readonly reason_digest: string;
  readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
  readonly affected_judgment_refs: readonly string[];
  readonly reassessment_judgment_ref: string;
}): MemoryInterpretationBuildResult {
  const record = input.current.record;
  if (!record || record.application_state !== "active" || !record.current_interpretation_id) {
    return { ok: false, reason: "invalid_current_record" };
  }
  return buildMemoryInterpretationCommit({
    current: input.current,
    lineage_id: input.lineage_id,
    update_id: input.update_id,
    j_event_id: input.j_event_id,
    transition: {
      kind: "reassess",
      event_id: input.event_id,
      reason_digest: input.reason_digest,
      evidence_refs: input.evidence_refs,
      affected_judgment_refs: input.affected_judgment_refs,
      reassessment_judgment_ref: input.reassessment_judgment_ref,
    },
  });
}

/**
 * Package-internal persistence consumer. It validates an append-only semantic transition before
 * staging the exact commit through J approval, M persistence, and receipt reconciliation.
 */
export class MemoryInterpretationConsumer {
  constructor(private readonly coordinator: JMemoryCommitCoordinator) {}

  read(lineageId: string): {
    readonly revision: number;
    readonly event_digest: string;
    readonly record: MemoryInterpretationRecord | null;
    readonly used_for_authority: false;
  } | null {
    if (!isLineageId(lineageId)) return null;
    const stored = this.coordinator.readMemoryRecord(memoryInterpretationRecordId(lineageId));
    if (!stored) return null;
    if (!stored.exists) {
      return Object.freeze({
        revision: stored.revision,
        event_digest: stored.event_digest,
        record: null,
        used_for_authority: false,
      });
    }
    const record = parseMemoryInterpretationRecord(stored.value);
    if (!record || record.lineage_id !== lineageId) return null;
    return Object.freeze({
      revision: stored.revision,
      event_digest: stored.event_digest,
      record,
      used_for_authority: false,
    });
  }

  apply(input: unknown): MemoryInterpretationApplyResult {
    const parsed = parseMemoryCommitV2(input);
    if (!parsed.ok) return { ok: false, stage: "validation", reason: "schema_validation_failed" };
    const commit = parsed.commit;
    if (commit.changes.length !== 1 || commit.changes[0]?.operation !== "upsert") {
      return { ok: false, stage: "validation", reason: "invalid_transition" };
    }

    const change = commit.changes[0];
    const proposed = parseMemoryInterpretationRecord(change.value);
    if (!proposed || change.record_id !== memoryInterpretationRecordId(proposed.lineage_id)) {
      return { ok: false, stage: "validation", reason: "invalid_transition" };
    }
    const stored = this.coordinator.readMemoryRecord(change.record_id);
    if (!stored) return { ok: false, stage: "read", reason: "store_unavailable" };
    if (!stored.exists || !isPlainRecord(stored.value)) {
      return { ok: false, stage: "validation", reason: "memory_record_missing" };
    }
    const current = parseMemoryInterpretationRecord(stored.value);
    if (!current || current.lineage_id !== proposed.lineage_id) {
      return { ok: false, stage: "validation", reason: "invalid_current_record" };
    }
    const lifecycle = this.coordinator.snapshot();
    const persistedRetry = lifecycle?.pending.some((pending) =>
      pending.update_id === commit.update_id && pending.j_event_id === commit.j_event_id &&
      pending.content_digest === parsed.content_digest && pending.expected_version === commit.expected_version &&
      (pending.lifecycle_state === "applied" || pending.lifecycle_state === "effect_confirmed")) === true;
    if (persistedRetry) {
      const reconciliation = this.coordinator.reconcile(commit.update_id);
      if (!reconciliation.ok) return { ok: false, stage: "j_reconcile", reason: reconciliation.reason };
      if (reconciliation.status !== "ready") {
        return { ok: false, stage: "j_reconcile", reason: "m_receipt_pending" };
      }
      return { ok: true, record: proposed, reconciliation };
    }
    if (commit.expected_version !== stored.revision) {
      return { ok: false, stage: "validation", reason: "expected_version_conflict" };
    }
    const transition = transitionFromRecord(current, proposed);
    const expected = transition ? applyTransition(current, transition) : null;
    if (!expected || canonicalJson(expected) !== canonicalJson(proposed)) {
      return { ok: false, stage: "validation", reason: "invalid_transition" };
    }

    const staged = this.coordinator.stage(commit);
    if (!staged.ok) return { ok: false, stage: "j_stage", reason: staged.reason };
    const applied = this.coordinator.apply(commit);
    if (!applied.ok) return { ok: false, stage: "m_apply", reason: applied.reason };
    const reconciliation = this.coordinator.reconcile(commit.update_id);
    if (!reconciliation.ok) return { ok: false, stage: "j_reconcile", reason: reconciliation.reason };
    if (reconciliation.status !== "ready") {
      return { ok: false, stage: "j_reconcile", reason: "m_receipt_pending" };
    }
    return { ok: true, record: proposed, reconciliation };
  }
}

export function memoryInterpretationRecordId(lineageId: string): string {
  return `${RECORD_ID_PREFIX}${lineageId}`;
}

export function parseMemoryInterpretationRecord(value: unknown): MemoryInterpretationRecord | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "schema_version", "record_type", "lineage_id", "application_state", "current_interpretation_id",
    "interpretations", "events", "dependent_judgments", "used_for_authority", "may_execute",
  ])) return null;
  if (value.schema_version !== MEMORY_INTERPRETATION_SCHEMA_VERSION || value.record_type !== "memory_interpretation" ||
      !isLineageId(value.lineage_id) || (value.application_state !== "active" && value.application_state !== "quarantined") ||
      !(value.current_interpretation_id === null || isIdentifier(value.current_interpretation_id)) ||
      value.used_for_authority !== false || value.may_execute !== false ||
      !Array.isArray(value.interpretations) || value.interpretations.length < 1 ||
      value.interpretations.length > MAX_INTERPRETATIONS || !Array.isArray(value.events) ||
      value.events.length > MAX_EVENTS || !Array.isArray(value.dependent_judgments) ||
      value.dependent_judgments.length < 1 || value.dependent_judgments.length > MAX_JUDGMENTS) return null;

  const interpretations: MemoryInterpretation[] = [];
  for (const item of value.interpretations) {
    if (!isInterpretation(item)) return null;
    interpretations.push(item as unknown as MemoryInterpretation);
  }
  const interpretationIds = new Set(interpretations.map((item) => item.interpretation_id));
  if (interpretationIds.size !== interpretations.length) return null;

  const judgments: MemoryInterpretationJudgment[] = [];
  for (const item of value.dependent_judgments) {
    if (!isPlainRecord(item) || !hasExactKeys(item, ["judgment_ref", "basis_interpretation_id", "reassessment_required"]) ||
        !isReference(item.judgment_ref) || !isIdentifier(item.basis_interpretation_id) ||
        typeof item.reassessment_required !== "boolean" || !interpretationIds.has(item.basis_interpretation_id)) return null;
    judgments.push(item as unknown as MemoryInterpretationJudgment);
  }
  if (new Set(judgments.map((item) => item.judgment_ref)).size !== judgments.length) return null;

  const events: MemoryInterpretationEvent[] = [];
  for (const item of value.events) {
    const reassessment = isPlainRecord(item) && item.kind === "reassessed";
    if (!isPlainRecord(item) || !hasExactKeys(item, [
      "event_id", "kind", "prior_interpretation_id", "resulting_interpretation_id", "reason_digest",
      "evidence_refs", "affected_judgment_refs", ...(reassessment ? ["reassessment_judgment_ref"] : []),
    ]) || !isIdentifier(item.event_id) ||
        (item.kind !== "quarantined" && item.kind !== "restored" && item.kind !== "reassessed") ||
        !isIdentifier(item.prior_interpretation_id) ||
        !(item.resulting_interpretation_id === null || isIdentifier(item.resulting_interpretation_id)) ||
        !isDigest(item.reason_digest) || !Array.isArray(item.evidence_refs) || item.evidence_refs.length < 1 ||
        item.evidence_refs.length > 32 || !Array.isArray(item.affected_judgment_refs) ||
        item.affected_judgment_refs.length < 1 || item.affected_judgment_refs.length > MAX_JUDGMENTS) return null;
    const evidence: MemoryInterpretationEvidenceReference[] = [];
    for (const reference of item.evidence_refs) {
      if (!isPlainRecord(reference) || !hasExactKeys(reference, ["reference", "digest"]) ||
          !isReference(reference.reference) || !isDigest(reference.digest)) return null;
      evidence.push(reference as unknown as MemoryInterpretationEvidenceReference);
    }
    if (new Set(evidence.map((reference) => reference.reference)).size !== evidence.length ||
        new Set(item.affected_judgment_refs).size !== item.affected_judgment_refs.length ||
        item.affected_judgment_refs.some((reference) => !isReference(reference))) return null;
    const priorExists = interpretationIds.has(item.prior_interpretation_id);
    const resultingExists = item.resulting_interpretation_id === null || interpretationIds.has(item.resulting_interpretation_id);
    if (!priorExists || !resultingExists ||
        (item.kind === "quarantined" && item.resulting_interpretation_id !== null) ||
        (item.kind === "restored" && item.resulting_interpretation_id === null) ||
        (item.kind === "reassessed" && (!item.resulting_interpretation_id ||
          item.resulting_interpretation_id !== item.prior_interpretation_id ||
          !isReference(item.reassessment_judgment_ref) ||
          !judgments.some((judgment) => judgment.judgment_ref === item.reassessment_judgment_ref &&
            judgment.basis_interpretation_id === item.resulting_interpretation_id && !judgment.reassessment_required))) ||
        item.affected_judgment_refs.some((reference) => !judgments.some((judgment) => judgment.judgment_ref === reference))) return null;
    events.push(item as unknown as MemoryInterpretationEvent);
  }
  if (new Set(events.map((item) => item.event_id)).size !== events.length) return null;

  const currentId = value.current_interpretation_id as string | null;
  if (value.application_state === "quarantined" && (currentId !== null || events.at(-1)?.kind !== "quarantined")) return null;
  if (value.application_state === "active" && (currentId === null || !interpretationIds.has(currentId) ||
      (events.length > 0 && ((events.at(-1)?.kind !== "restored" && events.at(-1)?.kind !== "reassessed") ||
        events.at(-1)?.resulting_interpretation_id !== currentId)))) return null;
  for (const judgment of judgments) {
    const lastDisposition = [...events].reverse().find((event) => event.affected_judgment_refs.includes(judgment.judgment_ref));
    const reassessmentRequired = lastDisposition !== undefined && lastDisposition.kind !== "reassessed";
    if (judgment.reassessment_required !== reassessmentRequired) return null;
  }

  return value as unknown as MemoryInterpretationRecord;
}

function transitionFromRecord(
  current: MemoryInterpretationRecord,
  candidate: MemoryInterpretationRecord,
): MemoryInterpretationTransition | null {
  if (candidate.events.length !== current.events.length + 1 && candidate.events.length !== current.events.length + 2) return null;
  if (
      candidate.events.slice(0, current.events.length).some((event, index) =>
        canonicalJson(event) !== canonicalJson(current.events[index]))) return null;
  const addedJudgments = candidate.dependent_judgments.filter((judgment) =>
    !current.dependent_judgments.some((existing) => existing.judgment_ref === judgment.judgment_ref));
  if (candidate.events.length === current.events.length + 2) {
    const quarantine = candidate.events.at(-2);
    const restoration = candidate.events.at(-1);
    const interpretation = restoration?.resulting_interpretation_id
      ? candidate.interpretations.find((item) => item.interpretation_id === restoration.resulting_interpretation_id)
      : undefined;
    if (!quarantine || quarantine.kind !== "quarantined" || !restoration || restoration.kind !== "restored" ||
        !interpretation || addedJudgments.length !== 1) return null;
    return {
      kind: "replace",
      quarantine_event_id: quarantine.event_id,
      restoration_event_id: restoration.event_id,
      reason_digest: quarantine.reason_digest,
      evidence_refs: quarantine.evidence_refs,
      affected_judgment_refs: quarantine.affected_judgment_refs,
      interpretation,
      reassessment_judgment_ref: addedJudgments[0]!.judgment_ref,
    };
  }
  const event = candidate.events.at(-1);
  if (!event) return null;
  if (event.kind === "reassessed") {
    if (!isReference(event.reassessment_judgment_ref) || addedJudgments.length !== 1 ||
        addedJudgments[0]!.judgment_ref !== event.reassessment_judgment_ref) return null;
    return {
      kind: "reassess",
      event_id: event.event_id,
      reason_digest: event.reason_digest,
      evidence_refs: event.evidence_refs,
      affected_judgment_refs: event.affected_judgment_refs,
      reassessment_judgment_ref: event.reassessment_judgment_ref,
    };
  }
  if (event.kind === "quarantined") {
    if (addedJudgments.length !== 0) return null;
    return {
      kind: "quarantine",
      event_id: event.event_id,
      reason_digest: event.reason_digest,
      evidence_refs: event.evidence_refs,
      affected_judgment_refs: event.affected_judgment_refs,
    };
  }
  const interpretation = candidate.interpretations.find((item) => item.interpretation_id === event.resulting_interpretation_id);
  if (!interpretation || addedJudgments.length > 1) return null;
  return {
    kind: "restore",
    event_id: event.event_id,
    reason_digest: event.reason_digest,
    evidence_refs: event.evidence_refs,
    interpretation,
    ...(addedJudgments[0] ? { reassessment_judgment_ref: addedJudgments[0].judgment_ref } : {}),
  };
}

function applyTransition(
  current: MemoryInterpretationRecord,
  transition: MemoryInterpretationTransition,
): MemoryInterpretationRecord | null {
  if (!isPlainRecord(transition)) return null;
  const eventId = transition.kind === "replace" ? transition.quarantine_event_id : transition.event_id;
  if (!isIdentifier(eventId) || !isDigest(transition.reason_digest) || !Array.isArray(transition.evidence_refs) ||
      transition.evidence_refs.length < 1 || transition.evidence_refs.length > 32 ||
      !validateEvidence(transition.evidence_refs) || current.events.length >= MAX_EVENTS ||
      current.events.some((event) => event.event_id === eventId)) return null;

  if (transition.kind === "replace") {
    if (!hasExactKeys(transition as unknown as Record<string, unknown>, [
      "kind", "quarantine_event_id", "restoration_event_id", "reason_digest", "evidence_refs",
      "affected_judgment_refs", "interpretation", "reassessment_judgment_ref",
    ]) || !isIdentifier(transition.quarantine_event_id) || !isIdentifier(transition.restoration_event_id) ||
        transition.quarantine_event_id === transition.restoration_event_id || !isReference(transition.reassessment_judgment_ref) ||
        transition.reassessment_judgment_ref === undefined || current.application_state !== "active" ||
        current.current_interpretation_id === null || !isInterpretation(transition.interpretation) ||
        current.interpretations.length >= MAX_INTERPRETATIONS ||
        current.interpretations.some((item) => item.interpretation_id === transition.interpretation.interpretation_id) ||
        current.dependent_judgments.length >= MAX_JUDGMENTS ||
        current.dependent_judgments.some((judgment) => judgment.judgment_ref === transition.reassessment_judgment_ref)) return null;
    const existingJudgments = new Set(current.dependent_judgments.map((judgment) => judgment.judgment_ref));
    const additionalJudgments = transition.affected_judgment_refs.filter((reference) => !existingJudgments.has(reference));
    if (current.dependent_judgments.length + additionalJudgments.length > MAX_JUDGMENTS) return null;
    const withCurrentDependents = additionalJudgments.length === 0 ? current : Object.freeze({
      ...current,
      dependent_judgments: Object.freeze([...current.dependent_judgments, ...additionalJudgments.map((judgment_ref) =>
        Object.freeze({ judgment_ref, basis_interpretation_id: current.current_interpretation_id!, reassessment_required: false }))]),
    });
    const quarantined = applyTransition(withCurrentDependents, {
      kind: "quarantine",
      event_id: transition.quarantine_event_id,
      reason_digest: transition.reason_digest,
      evidence_refs: transition.evidence_refs,
      affected_judgment_refs: transition.affected_judgment_refs,
    });
    if (!quarantined) return null;
    return applyTransition(quarantined, {
      kind: "restore",
      event_id: transition.restoration_event_id,
      reason_digest: transition.reason_digest,
      evidence_refs: transition.evidence_refs,
      interpretation: transition.interpretation,
      reassessment_judgment_ref: transition.reassessment_judgment_ref,
    });
  }

  if (transition.kind === "quarantine") {
    if (!hasExactKeys(transition as unknown as Record<string, unknown>, [
      "kind", "event_id", "reason_digest", "evidence_refs", "affected_judgment_refs",
    ]) || current.application_state !== "active" || current.current_interpretation_id === null ||
        !isReferenceArray(transition.affected_judgment_refs, MAX_JUDGMENTS, 1) ||
        new Set(transition.affected_judgment_refs).size !== transition.affected_judgment_refs.length ||
        transition.affected_judgment_refs.some((reference) => !isReference(reference))) return null;
    const affected = new Set(transition.affected_judgment_refs);
    if (current.dependent_judgments.some((judgment) => affected.has(judgment.judgment_ref) &&
        (judgment.basis_interpretation_id !== current.current_interpretation_id || judgment.reassessment_required)) ||
        [...affected].some((reference) => !current.dependent_judgments.some((judgment) => judgment.judgment_ref === reference))) return null;
    const event: MemoryInterpretationEvent = Object.freeze({
      event_id: transition.event_id,
      kind: "quarantined",
      prior_interpretation_id: current.current_interpretation_id,
      resulting_interpretation_id: null,
      reason_digest: transition.reason_digest,
      evidence_refs: Object.freeze(transition.evidence_refs.map((reference) => Object.freeze({ ...reference }))),
      affected_judgment_refs: Object.freeze([...transition.affected_judgment_refs]),
    });
    return Object.freeze({
      ...current,
      application_state: "quarantined",
      current_interpretation_id: null,
      events: Object.freeze([...current.events, event]),
      dependent_judgments: Object.freeze(current.dependent_judgments.map((judgment) => affected.has(judgment.judgment_ref)
        ? Object.freeze({ ...judgment, reassessment_required: true })
        : judgment)),
    });
  }

  if (transition.kind === "reassess") {
    if (!hasExactKeys(transition as unknown as Record<string, unknown>, [
      "kind", "event_id", "reason_digest", "evidence_refs", "affected_judgment_refs", "reassessment_judgment_ref",
    ]) || current.application_state !== "active" || current.current_interpretation_id === null ||
        !isReference(transition.reassessment_judgment_ref) ||
        current.dependent_judgments.length >= MAX_JUDGMENTS ||
        current.dependent_judgments.some((judgment) => judgment.judgment_ref === transition.reassessment_judgment_ref) ||
        !isReferenceArray(transition.affected_judgment_refs, MAX_JUDGMENTS, 1) ||
        new Set(transition.affected_judgment_refs).size !== transition.affected_judgment_refs.length) return null;
    const affected = new Set(transition.affected_judgment_refs);
    if (current.dependent_judgments.some((judgment) => affected.has(judgment.judgment_ref) &&
        (!judgment.reassessment_required || judgment.basis_interpretation_id === current.current_interpretation_id)) ||
        [...affected].some((reference) => !current.dependent_judgments.some((judgment) => judgment.judgment_ref === reference))) return null;
    const event: MemoryInterpretationEvent = Object.freeze({
      event_id: transition.event_id,
      kind: "reassessed",
      prior_interpretation_id: current.current_interpretation_id,
      resulting_interpretation_id: current.current_interpretation_id,
      reason_digest: transition.reason_digest,
      evidence_refs: Object.freeze(transition.evidence_refs.map((reference) => Object.freeze({ ...reference }))),
      affected_judgment_refs: Object.freeze([...transition.affected_judgment_refs]),
      reassessment_judgment_ref: transition.reassessment_judgment_ref,
    });
    return Object.freeze({
      ...current,
      events: Object.freeze([...current.events, event]),
      dependent_judgments: Object.freeze([
        ...current.dependent_judgments.map((judgment) => affected.has(judgment.judgment_ref)
          ? Object.freeze({ ...judgment, reassessment_required: false })
          : judgment),
        Object.freeze({ judgment_ref: transition.reassessment_judgment_ref,
          basis_interpretation_id: current.current_interpretation_id, reassessment_required: false }),
      ]),
    });
  }

  const restoreKeys = ["kind", "event_id", "reason_digest", "evidence_refs", "interpretation"];
  const hasReassessmentRef = Object.prototype.hasOwnProperty.call(transition, "reassessment_judgment_ref");
  if (transition.kind !== "restore" || !hasExactKeys(transition as unknown as Record<string, unknown>,
    hasReassessmentRef ? [...restoreKeys, "reassessment_judgment_ref"] : restoreKeys) ||
      current.application_state !== "quarantined" || current.current_interpretation_id !== null ||
      !isInterpretation(transition.interpretation) || current.interpretations.length >= MAX_INTERPRETATIONS ||
      current.interpretations.some((item) => item.interpretation_id === transition.interpretation.interpretation_id) ||
      (hasReassessmentRef && (!isReference(transition.reassessment_judgment_ref) ||
        current.dependent_judgments.length >= MAX_JUDGMENTS ||
        current.dependent_judgments.some((judgment) => judgment.judgment_ref === transition.reassessment_judgment_ref)))) return null;
  const quarantine = current.events.at(-1);
  if (!quarantine || quarantine.kind !== "quarantined") return null;
  const event: MemoryInterpretationEvent = Object.freeze({
    event_id: transition.event_id,
    kind: "restored",
    prior_interpretation_id: quarantine.prior_interpretation_id,
    resulting_interpretation_id: transition.interpretation.interpretation_id,
    reason_digest: transition.reason_digest,
    evidence_refs: Object.freeze(transition.evidence_refs.map((reference) => Object.freeze({ ...reference }))),
    affected_judgment_refs: Object.freeze([...quarantine.affected_judgment_refs]),
  });
  return Object.freeze({
    ...current,
    application_state: "active",
    current_interpretation_id: transition.interpretation.interpretation_id,
    interpretations: Object.freeze([...current.interpretations, Object.freeze({ ...transition.interpretation })]),
    events: Object.freeze([...current.events, event]),
    dependent_judgments: hasReassessmentRef
      ? Object.freeze([...current.dependent_judgments, Object.freeze({
        judgment_ref: transition.reassessment_judgment_ref!,
        basis_interpretation_id: transition.interpretation.interpretation_id,
        reassessment_required: false,
      })])
      : current.dependent_judgments,
  });
}

function validateEvidence(value: readonly MemoryInterpretationEvidenceReference[]): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
      Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  const references: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        !isPlainRecord(descriptor.value) || !hasExactKeys(descriptor.value, ["reference", "digest"]) ||
        !isReference(descriptor.value.reference) || !isDigest(descriptor.value.digest)) return false;
    references.push(descriptor.value.reference);
  }
  return new Set(references).size === references.length;
}

function isReferenceArray(value: unknown, maximum: number, minimum: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
      Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isReference(descriptor.value)) return false;
  }
  return true;
}

function isInterpretation(value: unknown): value is MemoryInterpretation {
  try {
    return isPlainRecord(value) && hasExactKeys(value, ["interpretation_id", "basis_ref", "meaning", "content_digest"]) &&
      isIdentifier(value.interpretation_id) && isReference(value.basis_ref) && isPlainRecord(value.meaning) &&
      isJsonValue(value.meaning) && isDigest(value.content_digest) &&
      interpretationContentDigest(value.meaning as Readonly<Record<string, MemoryCommitJsonValue>>) === value.content_digest;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isLineageId(value: unknown): value is string {
  return isIdentifier(value) && value.length <= 100;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function toCommitJsonValue(value: MemoryInterpretationRecord): MemoryCommitJsonValue {
  return JSON.parse(JSON.stringify(value)) as MemoryCommitJsonValue;
}
