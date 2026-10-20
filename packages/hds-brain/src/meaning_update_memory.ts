import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION,
  memoryCommitContentDigest,
  parseMeaningUpdateProposal,
  type MeaningUpdateProposalV3,
  type MemoryCommitJsonValue,
  type MemoryCommitV2,
} from "@blue-tanuki/protocol";
import type { OperationPlanMemoryStorage } from "./operation_plan.js";
import { JMemoryCommitCoordinator, type JMemoryCommitReconciliationResult } from "./制御状態.js";
import type { JMemoryApprovalReference, JMemoryApprovalReader } from "./保存取引.js";
import { buildInitialMemoryInterpretationCommit, buildMemoryInterpretationCommit, interpretationContentDigest,
  buildMemoryInterpretationReassessmentCommit, MemoryInterpretationConsumer, type MemoryInterpretation,
  type MemoryInterpretationEvidenceReference, type MemoryInterpretationRecord } from "./記憶再解釈.js";

export const MEANING_UPDATE_MEMORY_SCHEMA_VERSION = "blue-tanuki.meaning-update-memory.v1" as const;

export interface MeaningUpdateMemoryRecord {
  readonly schema_version: typeof MEANING_UPDATE_MEMORY_SCHEMA_VERSION;
  readonly record_type: "meaning_update_memory";
  readonly record_id: string;
  readonly proposal_digest: string;
  readonly candidate_digest: string;
  readonly proposal: MeaningUpdateProposalV3;
  readonly approval_status: "approved";
  readonly memory_application_status: "applied";
  readonly follow_up_action_status: "unconfirmed";
  readonly semantic_relation_status: "not_assessed";
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export type MeaningUpdateMemoryCommitResult =
  | { readonly ok: true; readonly record: MeaningUpdateMemoryRecord;
      readonly reconciliation: Extract<JMemoryCommitReconciliationResult, { readonly ok: true; readonly status: "ready" }> }
  | { readonly ok: false; readonly reason: string };

export interface MemoryJudgmentReassessmentTransaction {
  readonly lineage_id: string;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly event_id: string;
  readonly reason_digest: string;
  readonly evidence_refs: readonly MemoryInterpretationEvidenceReference[];
  readonly affected_judgment_refs: readonly string[];
  readonly reassessment_judgment_ref: string;
}

export type MemoryJudgmentReassessmentResult =
  | { readonly ok: true; readonly record: MemoryInterpretationRecord;
      readonly reconciliation: Extract<JMemoryCommitReconciliationResult, { readonly ok: true; readonly status: "ready" }> }
  | { readonly ok: false; readonly reason: string };

/** The approved candidate is persisted only through the J-approved M transaction path. */
export class MeaningUpdateMemoryConsumer {
  private readonly coordinator: JMemoryCommitCoordinator;
  private readonly interpretations: MemoryInterpretationConsumer;

  constructor(storage: OperationPlanMemoryStorage, approvalReader: JMemoryApprovalReader) {
    this.coordinator = new JMemoryCommitCoordinator({ ...storage, j_approval_reader: approvalReader });
    this.interpretations = new MemoryInterpretationConsumer(this.coordinator);
  }

  commit(
    record: MeaningUpdateMemoryRecord,
    authorize: (reference: JMemoryApprovalReference) => void,
    affectedJudgmentRefs: readonly string[] = [],
  ): MeaningUpdateMemoryCommitResult {
    if (!isMeaningUpdateMemoryRecord(record)) return { ok: false, reason: "meaning_update_record_invalid" };
    const updateId = `meaning-update:${record.proposal_digest}`;
    const eventId = `meaning-update-approval:${record.proposal_digest}`;
    const existing = this.coordinator.readMemoryRecord(record.record_id);
    if (!existing) return { ok: false, reason: "meaning_update_store_unavailable" };
    if (existing.exists) {
      if (canonicalJson(existing.value) !== canonicalJson(record)) {
        return { ok: false, reason: "meaning_update_record_conflict" };
      }
      const snapshot = this.interpretations.read(record.proposal.target_reference.record_id);
      if (!snapshot) return { ok: false, reason: "meaning_update_interpretation_unavailable" };
      const linked = snapshot.record?.dependent_judgments.some((judgment) => judgment.judgment_ref === eventId) === true;
      if (linked && !snapshot.record?.interpretations.some((item) => item.interpretation_id === meaningUpdateInterpretationId(record) &&
          item.content_digest === meaningUpdateInterpretationForRecord(record).content_digest)) {
        return { ok: false, reason: "meaning_update_interpretation_conflict" };
      }
      const pending = this.coordinator.snapshot()?.pending.find((item) => item.update_id === updateId);
      if (!pending || pending.j_event_id !== eventId) return { ok: false, reason: "meaning_update_receipt_missing" };
      const reconciliation = this.coordinator.reconcile(updateId);
      return reconciliation.ok && reconciliation.status === "ready"
        ? { ok: true, record, reconciliation }
        : { ok: false, reason: "meaning_update_reconciliation_failed" };
    }

    const interpretationSnapshot = this.interpretations.read(record.proposal.target_reference.record_id);
    if (!interpretationSnapshot) return { ok: false, reason: "meaning_update_interpretation_unavailable" };
    if (interpretationSnapshot.revision !== existing.revision) {
      return { ok: false, reason: "meaning_update_version_changed" };
    }
    const interpretation = meaningUpdateInterpretationForRecord(record);
    const judgmentRef = eventId;
    let interpretationBuild: ReturnType<typeof buildInitialMemoryInterpretationCommit>;
    if (!interpretationSnapshot.record) {
      interpretationBuild = buildInitialMemoryInterpretationCommit({
        current: interpretationSnapshot,
        lineage_id: record.proposal.target_reference.record_id,
        update_id: updateId,
        j_event_id: eventId,
        interpretation,
        dependent_judgment_refs: [judgmentRef],
      });
    } else if (interpretationSnapshot.record.application_state === "active") {
      const currentId = interpretationSnapshot.record.current_interpretation_id;
      const affected = interpretationSnapshot.record.dependent_judgments
        .filter((judgment) => judgment.basis_interpretation_id === currentId && !judgment.reassessment_required)
        .map((judgment) => judgment.judgment_ref);
      for (const judgmentRef of affectedJudgmentRefs) {
        if (!affected.includes(judgmentRef)) affected.push(judgmentRef);
      }
      if (affected.length === 0) return { ok: false, reason: "meaning_update_reassessment_pending" };
      interpretationBuild = buildMemoryInterpretationCommit({
        current: interpretationSnapshot,
        lineage_id: record.proposal.target_reference.record_id,
        update_id: updateId,
        j_event_id: eventId,
        transition: {
          kind: "replace",
          quarantine_event_id: "meaning-update-quarantine:" + record.proposal_digest,
          restoration_event_id: "meaning-update-restore:" + record.proposal_digest,
          reason_digest: meaningUpdateInterpretationReasonDigest(record.proposal_digest),
          evidence_refs: meaningUpdateInterpretationEvidence(record),
          affected_judgment_refs: affected,
          interpretation,
          reassessment_judgment_ref: judgmentRef,
        },
      });
    } else {
      interpretationBuild = buildMemoryInterpretationCommit({
        current: interpretationSnapshot,
        lineage_id: record.proposal.target_reference.record_id,
        update_id: updateId,
        j_event_id: eventId,
        transition: {
          kind: "restore",
          event_id: "meaning-update-restore:" + record.proposal_digest,
          reason_digest: meaningUpdateInterpretationReasonDigest(record.proposal_digest),
          evidence_refs: meaningUpdateInterpretationEvidence(record),
          interpretation,
          reassessment_judgment_ref: judgmentRef,
        },
      });
    }
    if (!interpretationBuild.ok) return { ok: false, reason: "meaning_update_interpretation_invalid" };
    const interpretationChange = interpretationBuild.commit.changes[0];
    if (!interpretationChange) return { ok: false, reason: "meaning_update_interpretation_invalid" };

    const content = {
      schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
      expected_version: existing.revision,
      update_id: updateId,
      j_event_id: eventId,
      changes: [{ operation: "upsert" as const, record_id: record.record_id,
        value: record as unknown as MemoryCommitJsonValue }, interpretationChange],
    };
    let commit: MemoryCommitV2;
    try { commit = { ...content, content_digest: memoryCommitContentDigest(content) }; }
    catch { return { ok: false, reason: "meaning_update_commit_invalid" }; }

    const lifecycle = this.coordinator.snapshot();
    if (!lifecycle) return { ok: false, reason: "meaning_update_store_unavailable" };
    if (lifecycle.active_update_id !== null) {
      const active = lifecycle.pending.find((item) => item.update_id === lifecycle.active_update_id);
      const same = active?.update_id === updateId && active.j_event_id === eventId &&
        active.content_digest === commit.content_digest && active.expected_version === commit.expected_version;
      if (!same) {
        const recovered = active ? this.coordinator.reconcile(active.update_id) : null;
        if (!recovered?.ok || recovered.status !== "ready") return { ok: false, reason: "meaning_update_update_pending" };
      }
    }
    authorize({ update_id: commit.update_id, j_event_id: commit.j_event_id, content_digest: commit.content_digest });
    const staged = this.coordinator.stage(commit);
    if (!staged.ok) return { ok: false, reason: "meaning_update_stage_failed" };
    const applied = this.coordinator.apply(commit);
    if (!applied.ok) return { ok: false, reason: "meaning_update_apply_failed" };
    const reconciliation = this.coordinator.reconcile(updateId);
    return reconciliation.ok && reconciliation.status === "ready"
      ? { ok: true, record, reconciliation }
      : { ok: false, reason: "meaning_update_reconciliation_failed" };
  }

  /** Persist a fresh, explicitly reviewed J judgment and resolve only its named prior M dependencies. */
  reassessJudgments(
    transaction: MemoryJudgmentReassessmentTransaction,
    authorize: (reference: JMemoryApprovalReference) => void,
  ): MemoryJudgmentReassessmentResult {
    if (!isMemoryJudgmentReassessmentTransaction(transaction)) {
      return { ok: false, reason: "memory_judgment_reassessment_invalid" };
    }
    const refs = transaction.affected_judgment_refs;
    const current = this.interpretations.read(transaction.lineage_id);
    if (!current?.record || current.record.application_state !== "active" || !current.record.current_interpretation_id) {
      return { ok: false, reason: "memory_judgment_reassessment_state_unavailable" };
    }
    const rows = new Map(current.record.dependent_judgments.map((judgment) => [judgment.judgment_ref, judgment]));
    if (new Set(refs).size !== refs.length || refs.some((reference) => {
      const row = rows.get(reference);
      return !row || !row.reassessment_required || row.basis_interpretation_id === current.record!.current_interpretation_id;
    }) || rows.has(transaction.reassessment_judgment_ref)) {
      return { ok: false, reason: "memory_judgment_reassessment_stale" };
    }
    const built = buildMemoryInterpretationReassessmentCommit({
      current, lineage_id: transaction.lineage_id, update_id: transaction.update_id,
      j_event_id: transaction.j_event_id, event_id: transaction.event_id,
      reason_digest: transaction.reason_digest, evidence_refs: transaction.evidence_refs,
      affected_judgment_refs: refs, reassessment_judgment_ref: transaction.reassessment_judgment_ref,
    });
    if (!built.ok) return { ok: false, reason: "memory_judgment_reassessment_invalid" };
    const commit = built.commit;
    authorize({ update_id: commit.update_id, j_event_id: commit.j_event_id, content_digest: commit.content_digest });
    const applied = this.interpretations.apply(commit);
    return applied.ok && applied.reconciliation.status === "ready"
      ? { ok: true, record: applied.record, reconciliation: applied.reconciliation }
      : { ok: false, reason: applied.ok ? "memory_judgment_reassessment_pending" : applied.reason };
  }

  read(recordId: string): MeaningUpdateMemoryRecord | null {
    const stored = this.coordinator.readMemoryRecord(recordId);
    if (!stored?.exists || !isMeaningUpdateMemoryRecord(stored.value)) return null;
    return stored.value;
  }

  readInterpretation(lineageId: string) {
    return this.interpretations.read(lineageId);
  }

  recoverPending(): boolean {
    const snapshot = this.coordinator.snapshot();
    if (!snapshot) return false;
    for (const item of snapshot.pending) {
      const result = this.coordinator.reconcile(item.update_id);
      if (!result.ok || result.status !== "ready") return false;
    }
    const recovered = this.coordinator.snapshot();
    return recovered !== null && recovered.status === "ready" && recovered.active_update_id === null;
  }

  verify(): boolean { return this.coordinator.verify(); }
  close(): void { this.coordinator.close(); }
}

function isMemoryJudgmentReassessmentTransaction(value: unknown): value is MemoryJudgmentReassessmentTransaction {
  if (!isRecord(value) || !hasExactKeys(value, ["lineage_id", "update_id", "j_event_id", "event_id", "reason_digest",
      "evidence_refs", "affected_judgment_refs", "reassessment_judgment_ref"]) ||
      typeof value.lineage_id !== "string" || typeof value.update_id !== "string" ||
      typeof value.j_event_id !== "string" || typeof value.event_id !== "string" ||
      typeof value.reason_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.reason_digest) ||
      typeof value.reassessment_judgment_ref !== "string" || !Array.isArray(value.evidence_refs) ||
      !Array.isArray(value.affected_judgment_refs) || value.affected_judgment_refs.length < 1 ||
      value.affected_judgment_refs.length > 256 || value.evidence_refs.length < 1 || value.evidence_refs.length > 32) return false;
  const isRef = (item: unknown): item is string => typeof item === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(item);
  if (![value.lineage_id, value.update_id, value.j_event_id, value.event_id, value.reassessment_judgment_ref].every(isRef) ||
      !value.affected_judgment_refs.every(isRef) || new Set(value.affected_judgment_refs).size !== value.affected_judgment_refs.length ||
      !value.evidence_refs.every((item) => isRecord(item) && hasExactKeys(item, ["reference", "digest"]) &&
        isRef(item.reference) && typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest))) return false;
  return true;
}

export function meaningUpdateMemoryRecordId(proposalDigest: string): string {
  return `meaning-update:${proposalDigest}`;
}

export function meaningUpdateProposalDigest(proposal: MeaningUpdateProposalV3): string {
  return createHash("sha256").update(canonicalJson(proposal), "utf8").digest("hex");
}

export function isMeaningUpdateMemoryRecord(value: unknown): value is MeaningUpdateMemoryRecord {
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "record_type", "record_id", "proposal_digest",
      "candidate_digest", "proposal", "approval_status", "memory_application_status", "follow_up_action_status",
      "semantic_relation_status", "used_for_authority", "may_execute"])) return false;
  const parsed = parseMeaningUpdateProposal(value.proposal);
  if (!parsed.ok || parsed.record.schema_version !== "blue-tanuki.meaning-update-proposal.v3") return false;
  const proposalDigest = meaningUpdateProposalDigest(parsed.record);
  return value.schema_version === MEANING_UPDATE_MEMORY_SCHEMA_VERSION && value.record_type === "meaning_update_memory" &&
    value.record_id === meaningUpdateMemoryRecordId(proposalDigest) && value.proposal_digest === proposalDigest &&
    value.candidate_digest === parsed.record.candidate_digest && value.approval_status === "approved" &&
    value.memory_application_status === "applied" && value.follow_up_action_status === "unconfirmed" &&
    value.semantic_relation_status === "not_assessed" && value.used_for_authority === false && value.may_execute === false;
}

export function buildMeaningUpdateMemoryRecord(proposal: MeaningUpdateProposalV3): MeaningUpdateMemoryRecord {
  const proposal_digest = meaningUpdateProposalDigest(proposal);
  return Object.freeze({ schema_version: MEANING_UPDATE_MEMORY_SCHEMA_VERSION, record_type: "meaning_update_memory",
    record_id: meaningUpdateMemoryRecordId(proposal_digest), proposal_digest, candidate_digest: proposal.candidate_digest,
    proposal: structuredClone(proposal), approval_status: "approved", memory_application_status: "applied",
    follow_up_action_status: "unconfirmed", semantic_relation_status: "not_assessed", used_for_authority: false,
    may_execute: false });
}

export function meaningUpdateInterpretationId(record: MeaningUpdateMemoryRecord): string {
  return "meaning-update-interpretation:" + record.proposal_digest;
}

export function meaningUpdateInterpretationForRecord(record: MeaningUpdateMemoryRecord): MemoryInterpretation {
  const proposal = record.proposal;
  const meaning = Object.freeze({
    proposal_digest: record.proposal_digest,
    candidate_ref: proposal.candidate_ref,
    candidate_digest: proposal.candidate_digest,
    candidate_meaning: proposal.candidate_meaning,
    target_reference: proposal.target_reference,
    prior_version_ref: proposal.prior_version_ref,
    supporting_evidence: proposal.supporting_evidence,
    counterevidence_review: proposal.counterevidence_review,
  });
  return Object.freeze({
    interpretation_id: meaningUpdateInterpretationId(record),
    basis_ref: proposal.target_reference.record_id + "#" + proposal.target_reference.version,
    meaning,
    content_digest: interpretationContentDigest(meaning),
  });
}

function meaningUpdateInterpretationEvidence(record: MeaningUpdateMemoryRecord) {
  const references = record.proposal.counterevidence_review.status === "reviewed_with_references"
    ? record.proposal.counterevidence_review.references
    : record.proposal.supporting_evidence;
  return references.map((reference) => ({ reference: reference.reference, digest: reference.digest }));
}

function meaningUpdateInterpretationReasonDigest(proposalDigest: string): string {
  return createHash("sha256").update("approved-meaning-update-reinterpretation:" + proposalDigest, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
