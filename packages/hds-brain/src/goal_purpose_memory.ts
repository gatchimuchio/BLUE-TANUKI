import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION,
  memoryCommitContentDigest,
  type GoalGovernanceEvent,
  type MemoryCommitJsonValue,
  type MemoryCommitV2,
} from "@blue-tanuki/protocol";
import type { OperationPlanMemoryStorage } from "./operation_plan.js";
import { JMemoryCommitCoordinator } from "./制御状態.js";
import type { JMemoryApprovalReference, JMemoryApprovalReader } from "./保存取引.js";
import { goalGovernanceEventDigest } from "./goal_governance.js";

type GoalPurposeChangeEvent = Extract<GoalGovernanceEvent, { event_kind: "purpose_change" }>;

interface GoalPurposeMemoryRecord {
  readonly schema_version: "blue-tanuki.goal-purpose-memory.v1";
  readonly record_type: "goal_purpose_content";
  readonly record_id: string;
  readonly goal_ref: string;
  readonly purpose_version: number;
  readonly purpose_digest: string;
  readonly purpose_text: string;
  readonly event_ref: string;
  readonly event_digest: string;
  readonly authorization_ref: string;
  readonly used_for_authority: false;
}

export interface GoalPurposeMemoryApprovalContext extends JMemoryApprovalReference {
  readonly request_id: string;
  readonly command_id: string;
  readonly proposal_actor: string;
  readonly actor: string;
  readonly target: string;
  readonly evaluation: unknown;
}

export class GoalPurposeMemoryConsumer {
  private readonly coordinator: JMemoryCommitCoordinator;

  constructor(storage: OperationPlanMemoryStorage, approvalReader: JMemoryApprovalReader) {
    this.coordinator = new JMemoryCommitCoordinator({ ...storage, j_approval_reader: approvalReader });
  }

  /**
   * Store purpose text only after the supplied J/L3 approval reader accepts the
   * exact MemoryCommitV2 content. The M value is evidence/content, never authority.
   */
  commit(
    event: GoalPurposeChangeEvent,
    purposeText: string,
    authorize: (reference: JMemoryApprovalReference) => void,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const recordId = recordIdForReference(event.purpose_memory_ref);
    if (!recordId || Buffer.byteLength(purposeText, "utf8") < 1 ||
        Buffer.byteLength(purposeText, "utf8") > 16 * 1024 || digestText(purposeText) !== event.new_purpose_digest) {
      return { ok: false, reason: "purpose_memory_content_invalid" };
    }
    const record: GoalPurposeMemoryRecord = {
      schema_version: "blue-tanuki.goal-purpose-memory.v1",
      record_type: "goal_purpose_content",
      record_id: recordId,
      goal_ref: event.goal_ref,
      purpose_version: event.new_version,
      purpose_digest: event.new_purpose_digest,
      purpose_text: purposeText,
      event_ref: event.event_ref,
      event_digest: digestEvent(event),
      authorization_ref: event.authorization_ref,
      used_for_authority: false,
    };
    const updateId = `goal-purpose:${recordId}`;
    const jEventId = `goal-purpose-memory:${recordId}`;
    const existing = this.coordinator.readMemoryRecord(recordId);
    if (!existing) return { ok: false, reason: "purpose_memory_store_unavailable" };
    if (existing.exists) {
      if (!matchesPurposeRecord(existing.value, record, event)) {
        return { ok: false, reason: "purpose_memory_record_conflict" };
      }
      const snapshot = this.coordinator.snapshot();
      const pending = snapshot?.pending.find((item) => item.update_id === updateId);
      if (!pending || pending.j_event_id !== jEventId) {
        return { ok: false, reason: "purpose_memory_receipt_missing" };
      }
      const reconciled = this.coordinator.reconcile(updateId);
      return reconciled.ok && reconciled.status === "ready"
        ? { ok: true }
        : { ok: false, reason: "purpose_memory_reconciliation_failed" };
    }

    const commitContent = {
      schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
      expected_version: existing.revision,
      update_id: updateId,
      j_event_id: jEventId,
      changes: [{ operation: "upsert" as const, record_id: recordId, value: record as unknown as MemoryCommitJsonValue }],
    };
    let commit: MemoryCommitV2;
    try {
      commit = { ...commitContent, content_digest: memoryCommitContentDigest(commitContent) };
    } catch {
      return { ok: false, reason: "purpose_memory_commit_invalid" };
    }
    const snapshot = this.coordinator.snapshot();
    if (!snapshot) return { ok: false, reason: "purpose_memory_store_unavailable" };
    if (snapshot.active_update_id !== null) {
      const active = snapshot.pending.find((item) => item.update_id === snapshot.active_update_id);
      const samePending = active?.update_id === updateId && active.j_event_id === jEventId &&
        active.content_digest === commit.content_digest && active.expected_version === commit.expected_version;
      if (!samePending) {
        const recovered = active ? this.coordinator.reconcile(active.update_id) : null;
        if (!recovered?.ok || recovered.status !== "ready") {
          return { ok: false, reason: "purpose_memory_update_pending" };
        }
      }
    }

    const approvalReference: JMemoryApprovalReference = {
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      content_digest: commit.content_digest,
    };
    authorize(approvalReference);
    const staged = this.coordinator.stage(commit);
    if (!staged.ok) return { ok: false, reason: "purpose_memory_stage_failed" };
    const applied = this.coordinator.apply(commit);
    if (!applied.ok) return { ok: false, reason: "purpose_memory_apply_failed" };
    const reconciled = this.coordinator.reconcile(updateId);
    if (!reconciled.ok || reconciled.status !== "ready") {
      return { ok: false, reason: "purpose_memory_reconciliation_failed" };
    }
    return { ok: true };
  }

  /** Resolve an audit event's opaque M reference and verify the exact content binding. */
  read(event: GoalPurposeChangeEvent): GoalPurposeMemoryRecord | null {
    const recordId = recordIdForReference(event.purpose_memory_ref);
    if (!recordId) return null;
    const stored = this.coordinator.readMemoryRecord(recordId);
    if (!stored) throw new Error("persisted goal purpose memory is unavailable");
    if (!stored.exists) throw new Error("persisted goal purpose memory record is missing");
    const expected: GoalPurposeMemoryRecord = {
      schema_version: "blue-tanuki.goal-purpose-memory.v1",
      record_type: "goal_purpose_content",
      record_id: recordId,
      goal_ref: event.goal_ref,
      purpose_version: event.new_version,
      purpose_digest: event.new_purpose_digest,
      purpose_text: typeof (stored.value as { purpose_text?: unknown } | null)?.purpose_text === "string"
        ? (stored.value as { purpose_text: string }).purpose_text : "",
      event_ref: event.event_ref,
      event_digest: digestEvent(event),
      authorization_ref: event.authorization_ref,
      used_for_authority: false,
    };
    const mismatchFields = purposeRecordMismatchFields(stored.value, expected, event);
    if (mismatchFields.length > 0) {
      throw new Error(`persisted goal purpose memory binding is invalid: ${mismatchFields.join(",")}`);
    }
    const parsed = parsePurposeMemoryRecord(stored.value);
    if (!parsed) throw new Error("persisted goal purpose memory record is malformed");
    return parsed;
  }

  recoverPending(): boolean {
    const snapshot = this.coordinator.snapshot();
    if (!snapshot) return false;
    for (const item of snapshot.pending) {
      const reconciled = this.coordinator.reconcile(item.update_id);
      if (!reconciled.ok || reconciled.status !== "ready") return false;
    }
    const recovered = this.coordinator.snapshot();
    return recovered !== null && recovered.status === "ready" && recovered.active_update_id === null;
  }

  verify(): boolean {
    return this.coordinator.verify();
  }

  close(): void {
    this.coordinator.close();
  }
}

function recordIdForReference(reference: string | undefined): string | null {
  const match = reference?.match(/^F:([a-f0-9]{32})$/);
  return match?.[1] ?? null;
}

function matchesPurposeRecord(
  value: unknown,
  expected: GoalPurposeMemoryRecord,
  event: GoalPurposeChangeEvent,
): boolean {
  return purposeRecordMismatchFields(value, expected, event).length === 0;
}

function purposeRecordMismatchFields(
  value: unknown,
  expected: GoalPurposeMemoryRecord,
  event: GoalPurposeChangeEvent,
): string[] {
  const parsed = parsePurposeMemoryRecord(value);
  if (!parsed) return ["record_schema"];
  const mismatches: string[] = [];
  if (parsed.schema_version !== expected.schema_version) mismatches.push("schema_version");
  if (parsed.record_type !== expected.record_type) mismatches.push("record_type");
  if (parsed.record_id !== expected.record_id) mismatches.push("record_id");
  if (parsed.goal_ref !== expected.goal_ref) mismatches.push("goal_ref");
  if (parsed.purpose_version !== expected.purpose_version) mismatches.push("purpose_version");
  if (parsed.purpose_digest !== expected.purpose_digest) mismatches.push("purpose_digest");
  if (parsed.purpose_text !== expected.purpose_text) mismatches.push("purpose_text");
  if (parsed.event_ref !== expected.event_ref) mismatches.push("event_ref");
  if (parsed.event_digest !== expected.event_digest) mismatches.push("event_digest");
  if (parsed.authorization_ref !== expected.authorization_ref) mismatches.push("authorization_ref");
  if (parsed.used_for_authority !== false) mismatches.push("authority_flag");
  if (parsed.purpose_digest !== event.new_purpose_digest || digestText(parsed.purpose_text) !== event.new_purpose_digest) {
    mismatches.push("event_content_digest");
  }
  return mismatches;
}

function digestText(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function digestEvent(event: GoalPurposeChangeEvent): string {
  return goalGovernanceEventDigest(event);
}

function parsePurposeMemoryRecord(value: unknown): GoalPurposeMemoryRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "record_type", "record_id", "goal_ref", "purpose_version", "purpose_digest",
    "purpose_text", "event_ref", "event_digest", "authorization_ref", "used_for_authority",
  ])) return null;
  if (value.schema_version !== "blue-tanuki.goal-purpose-memory.v1" || value.record_type !== "goal_purpose_content" ||
      typeof value.record_id !== "string" || !/^[a-f0-9]{32}$/.test(value.record_id) ||
      typeof value.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(value.goal_ref) ||
      typeof value.purpose_version !== "number" || !Number.isSafeInteger(value.purpose_version) || value.purpose_version < 1 ||
      typeof value.purpose_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.purpose_digest) ||
      typeof value.purpose_text !== "string" || Buffer.byteLength(value.purpose_text, "utf8") < 1 ||
      Buffer.byteLength(value.purpose_text, "utf8") > 16 * 1024 || digestText(value.purpose_text) !== value.purpose_digest ||
      typeof value.event_ref !== "string" || !/^ge_[a-f0-9]{16,64}$/.test(value.event_ref) ||
      typeof value.event_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.event_digest) ||
      typeof value.authorization_ref !== "string" || !/^ga_[a-f0-9]{16,64}$/.test(value.authorization_ref) ||
      value.used_for_authority !== false) return null;
  return Object.freeze(value as unknown as GoalPurposeMemoryRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
