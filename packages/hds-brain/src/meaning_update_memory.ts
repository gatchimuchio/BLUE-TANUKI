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

/** The approved candidate is persisted only through the J-approved M transaction path. */
export class MeaningUpdateMemoryConsumer {
  private readonly coordinator: JMemoryCommitCoordinator;

  constructor(storage: OperationPlanMemoryStorage, approvalReader: JMemoryApprovalReader) {
    this.coordinator = new JMemoryCommitCoordinator({ ...storage, j_approval_reader: approvalReader });
  }

  commit(
    record: MeaningUpdateMemoryRecord,
    authorize: (reference: JMemoryApprovalReference) => void,
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
      const pending = this.coordinator.snapshot()?.pending.find((item) => item.update_id === updateId);
      if (!pending || pending.j_event_id !== eventId) return { ok: false, reason: "meaning_update_receipt_missing" };
      const reconciliation = this.coordinator.reconcile(updateId);
      return reconciliation.ok && reconciliation.status === "ready"
        ? { ok: true, record, reconciliation }
        : { ok: false, reason: "meaning_update_reconciliation_failed" };
    }

    const content = {
      schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
      expected_version: existing.revision,
      update_id: updateId,
      j_event_id: eventId,
      changes: [{ operation: "upsert" as const, record_id: record.record_id,
        value: record as unknown as MemoryCommitJsonValue }],
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

  read(recordId: string): MeaningUpdateMemoryRecord | null {
    const stored = this.coordinator.readMemoryRecord(recordId);
    if (!stored?.exists || !isMeaningUpdateMemoryRecord(stored.value)) return null;
    return stored.value;
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
