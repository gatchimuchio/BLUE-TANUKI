import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION,
  memoryCommitContentDigest,
  parseMemoryUpdateReceipt,
  type MemoryCommitJsonValue,
  type MemoryCommitV2,
  type MemoryUpdateReceiptV1,
} from "@blue-tanuki/protocol";
import type {
  DocumentOrganizationMemoryReceiptBinding,
  DocumentOrganizationProjection,
} from "./document_organization.js";
import { documentOrganizationMemoryIdentity } from "./document_organization.js";
import type { OperationPlanMemoryStorage } from "./operation_plan.js";
import { JMemoryCommitCoordinator } from "./制御状態.js";
import type { JMemoryApprovalReader, JMemoryApprovalReference } from "./保存取引.js";

interface DocumentOrganizationMemoryRecord {
  readonly schema_version: "blue-tanuki.document-organization-memory.v1";
  readonly record_type: "document_organization_receipt";
  readonly record_id: string;
  readonly task_id: string;
  readonly request_id: string;
  readonly source_sha256: string;
  readonly task_revision: number;
  readonly update_id: string;
  readonly j_event_id: string;
  readonly state_digest: string;
  readonly accepted_excerpt_count: number;
  readonly accepted_excerpt_ids_digest: string;
  readonly uncovered_ranges_digest: string;
  readonly next_status: "continuing" | "completed" | "held";
  readonly command_id_digest: string;
  readonly command_request_id_digest: string;
  readonly previous_receipt_digest: string | null;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export type DocumentOrganizationMemoryResolution =
  | { readonly status: "ready"; readonly binding: DocumentOrganizationMemoryReceiptBinding }
  | { readonly status: "missing" }
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: string };

/** Persist only J-approved operation metadata; source and quote text never enter M. */
export class DocumentOrganizationMemoryConsumer {
  private readonly coordinator: JMemoryCommitCoordinator;

  constructor(storage: OperationPlanMemoryStorage, approvalReader: JMemoryApprovalReader) {
    this.coordinator = new JMemoryCommitCoordinator({ ...storage, j_approval_reader: approvalReader });
  }

  resolve(input: {
    readonly projection: DocumentOrganizationProjection;
    readonly prior_receipts: readonly DocumentOrganizationMemoryReceiptBinding[];
    readonly command_id: string;
    readonly command_request_id: string;
  }): DocumentOrganizationMemoryResolution {
    const { projection } = input;
    if (projection.status !== "memory_pending" || projection.revision < 1 ||
        projection.task_id !== `document-organization:${projection.source_ref.request_id}` ||
        !/^[a-f0-9]{64}$/u.test(projection.source_ref.content_sha256) ||
        input.prior_receipts.length !== projection.revision - 1 || !safeIdentifier(input.command_id) ||
        !safeIdentifier(input.command_request_id)) {
      return { status: "blocked", reason: "document_organization_memory_binding_invalid" };
    }
    if (!this.verifyReceiptChain({
      task_id: projection.task_id,
      request_id: projection.source_ref.request_id,
      source_sha256: projection.source_ref.content_sha256,
      revision: projection.revision - 1,
      receipts: input.prior_receipts,
    })) {
      return { status: "blocked", reason: "document_organization_prior_m_receipt_unverified" };
    }

    const identity = documentOrganizationMemoryIdentity(projection.task_id, projection.revision);
    const memory = this.coordinator.readMemoryRecord(identity.record_id);
    if (!memory) return { status: "blocked", reason: "document_organization_m_unavailable" };
    const snapshot = this.coordinator.snapshot();
    if (!snapshot) return { status: "blocked", reason: "document_organization_j_unavailable" };
    if (snapshot.active_update_id !== null) {
      if (snapshot.active_update_id !== identity.update_id) {
        return { status: "pending", reason: "document_organization_other_m_update_pending" };
      }
      const recovered = this.coordinator.recoverPending(identity.update_id);
      if (!recovered.ok) return { status: "pending", reason: recovered.reason };
      if (recovered.status === "memory_commit_pending") {
        return { status: "pending", reason: "document_organization_m_receipt_pending" };
      }
    }

    if (!memory.exists) {
      const reconciliation = this.coordinator.reconcile(identity.update_id);
      if (reconciliation.ok && reconciliation.status === "ready") {
        return this.resolveStoredRecord(projection, identity.record_id, identity.update_id, identity.j_event_id,
          input.command_id, input.command_request_id, input.prior_receipts);
      }
      if (reconciliation.ok && reconciliation.status === "memory_commit_pending") {
        return { status: "pending", reason: "document_organization_m_receipt_pending" };
      }
      return reconciliation.status === "blocked" && reconciliation.reason !== "pending_not_found"
        ? { status: "blocked", reason: reconciliation.reason }
        : { status: "missing" };
    }
    return this.resolveStoredRecord(projection, identity.record_id, identity.update_id, identity.j_event_id,
      input.command_id, input.command_request_id, input.prior_receipts);
  }

  commit(input: {
    readonly projection: DocumentOrganizationProjection;
    readonly prior_receipts: readonly DocumentOrganizationMemoryReceiptBinding[];
    readonly command_id: string;
    readonly command_request_id: string;
    readonly authorize: (reference: JMemoryApprovalReference) => void;
  }): DocumentOrganizationMemoryResolution {
    const resolved = this.resolve(input);
    if (resolved.status !== "missing") return resolved;

    const { projection } = input;
    const identity = documentOrganizationMemoryIdentity(projection.task_id, projection.revision);
    const memory = this.coordinator.readMemoryRecord(identity.record_id);
    const lifecycle = this.coordinator.snapshot();
    if (!memory || !lifecycle) return { status: "blocked", reason: "document_organization_m_unavailable" };
    if (lifecycle.active_update_id !== null) {
      return { status: "pending", reason: "document_organization_other_m_update_pending" };
    }

    const previousReceipt = input.prior_receipts.at(-1)?.receipt ?? null;
    const record = buildRecord(projection, input.command_id, input.command_request_id,
      previousReceipt?.receipt_digest ?? null, identity);
    let commit: MemoryCommitV2;
    try {
      const content = {
        schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
        expected_version: memory.revision,
        update_id: identity.update_id,
        j_event_id: identity.j_event_id,
        changes: [{ operation: "upsert" as const, record_id: identity.record_id,
          value: record as unknown as MemoryCommitJsonValue }],
      };
      commit = { ...content, content_digest: memoryCommitContentDigest(content) };
    } catch {
      return { status: "blocked", reason: "document_organization_m_commit_invalid" };
    }

    input.authorize({ update_id: commit.update_id, j_event_id: commit.j_event_id, content_digest: commit.content_digest });
    const staged = this.coordinator.stage(commit);
    if (!staged.ok) {
      const afterStage = this.resolve(input);
      if (afterStage.status === "ready" || afterStage.status === "pending") return afterStage;
      return staged.reason === "commit_outcome_unknown"
        ? { status: "pending", reason: staged.reason }
        : { status: "blocked", reason: staged.reason };
    }

    const applied = this.coordinator.apply(commit);
    if (!applied.ok) {
      const afterApply = this.resolve(input);
      if (afterApply.status === "ready" || afterApply.status === "pending") return afterApply;
      return { status: "blocked", reason: applied.reason };
    }
    const reconciled = this.coordinator.reconcile(identity.update_id);
    if (!reconciled.ok) {
      return reconciled.reason === "commit_outcome_unknown"
        ? { status: "pending", reason: reconciled.reason }
        : { status: "blocked", reason: reconciled.reason };
    }
    if (reconciled.status === "memory_commit_pending") {
      return { status: "pending", reason: "document_organization_m_receipt_pending" };
    }
    return this.resolveStoredRecord(projection, identity.record_id, identity.update_id, identity.j_event_id,
      input.command_id, input.command_request_id, input.prior_receipts);
  }

  verifyReceiptChain(input: {
    readonly task_id: string;
    readonly request_id: string;
    readonly source_sha256: string;
    readonly revision: number;
    readonly receipts: readonly DocumentOrganizationMemoryReceiptBinding[];
    readonly projection?: DocumentOrganizationProjection;
  }): boolean {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
        input.receipts.length !== input.revision ||
        (input.revision === 0 && input.projection !== undefined && input.projection.revision !== 0)) return false;
    if (input.revision === 0) return true;
    if (!this.coordinator.verify()) return false;
    let previousReceiptDigest: string | null = null;
    let priorAcceptedCount = 0;
    let lastRecord: DocumentOrganizationMemoryRecord | null = null;
    for (let revision = 1; revision <= input.revision; revision += 1) {
      const binding = input.receipts[revision - 1];
      const identity = documentOrganizationMemoryIdentity(input.task_id, revision);
      if (!binding || binding.task_revision !== revision || binding.update_id !== identity.update_id ||
          binding.j_event_id !== identity.j_event_id) return false;
      const parsedReceipt = parseMemoryUpdateReceipt(binding.receipt);
      if (!parsedReceipt.ok || parsedReceipt.receipt.update_id !== identity.update_id ||
          parsedReceipt.receipt.content_digest !== binding.content_digest ||
          parsedReceipt.receipt.receipt_digest !== binding.receipt.receipt_digest) return false;
      const reconciliation = this.coordinator.reconcile(identity.update_id);
      if (!reconciliation.ok || reconciliation.status !== "ready" ||
          JSON.stringify(reconciliation.receipt) !== JSON.stringify(parsedReceipt.receipt)) return false;
      const memory = this.coordinator.readMemoryRecord(identity.record_id);
      const record = memory?.value;
      if (!memory?.exists || memory.used_for_authority || !isDocumentOrganizationMemoryRecord(record) ||
          record.record_id !== identity.record_id || record.task_id !== input.task_id ||
          record.request_id !== input.request_id || record.source_sha256 !== input.source_sha256 ||
          record.task_revision !== revision || record.update_id !== identity.update_id ||
          record.j_event_id !== identity.j_event_id || record.previous_receipt_digest !== previousReceiptDigest ||
          record.accepted_excerpt_count < priorAcceptedCount) return false;
      previousReceiptDigest = parsedReceipt.receipt.receipt_digest;
      priorAcceptedCount = record.accepted_excerpt_count;
      lastRecord = record;
    }
    return input.projection === undefined || (lastRecord !== null &&
      lastRecord.state_digest === documentOrganizationMemoryStateDigest(input.projection));
  }

  verify(): boolean {
    return this.coordinator.verify();
  }

  close(): void {
    this.coordinator.close();
  }

  private resolveStoredRecord(
    projection: DocumentOrganizationProjection,
    recordId: string,
    updateId: string,
    jEventId: string,
    commandId: string,
    commandRequestId: string,
    priorReceipts: readonly DocumentOrganizationMemoryReceiptBinding[],
  ): DocumentOrganizationMemoryResolution {
    const identity = documentOrganizationMemoryIdentity(projection.task_id, projection.revision);
    const memory = this.coordinator.readMemoryRecord(recordId);
    if (!memory?.exists || !isDocumentOrganizationMemoryRecord(memory.value)) {
      return { status: "blocked", reason: "document_organization_m_record_invalid" };
    }
    const record = memory.value;
    const previousReceipt = priorReceipts.at(-1)?.receipt ?? null;
    if (record.record_id !== identity.record_id || record.task_id !== projection.task_id ||
        record.request_id !== projection.source_ref.request_id || record.source_sha256 !== projection.source_ref.content_sha256 ||
        record.task_revision !== projection.revision || record.update_id !== updateId || record.j_event_id !== jEventId ||
        record.command_id_digest !== digestText(commandId) ||
        record.command_request_id_digest !== digestText(commandRequestId) ||
        record.state_digest !== documentOrganizationMemoryStateDigest(projection) ||
        record.previous_receipt_digest !== (previousReceipt?.receipt_digest ?? null)) {
      return { status: "blocked", reason: "document_organization_m_record_conflict" };
    }
    const reconciliation = this.coordinator.reconcile(updateId);
    if (!reconciliation.ok) return { status: "blocked", reason: reconciliation.reason };
    if (reconciliation.status === "memory_commit_pending") {
      return { status: "pending", reason: "document_organization_m_receipt_pending" };
    }
    const binding: DocumentOrganizationMemoryReceiptBinding = Object.freeze({
      task_revision: projection.revision,
      update_id: updateId,
      j_event_id: jEventId,
      content_digest: reconciliation.receipt.content_digest,
      receipt: reconciliation.receipt,
    });
    return { status: "ready", binding };
  }
}

export function documentOrganizationMemoryStateDigest(projection: DocumentOrganizationProjection): string {
  const acceptedIds = projection.accepted_excerpts.map((excerpt) => excerpt.excerpt_id);
  return digestJson({
    task_id: projection.task_id,
    request_id: projection.source_ref.request_id,
    source_sha256: projection.source_ref.content_sha256,
    revision: projection.revision,
    completed_cycles: projection.completed_cycles,
    accepted_excerpt_count: acceptedIds.length,
    accepted_excerpt_ids_digest: digestJson(acceptedIds),
    uncovered_ranges_digest: digestJson(projection.uncovered_ranges),
  });
}

function buildRecord(
  projection: DocumentOrganizationProjection,
  commandId: string,
  commandRequestId: string,
  previousReceiptDigest: string | null,
  identity: ReturnType<typeof documentOrganizationMemoryIdentity>,
): DocumentOrganizationMemoryRecord {
  const acceptedIds = projection.accepted_excerpts.map((excerpt) => excerpt.excerpt_id);
  const nextStatus = projection.uncovered_ranges.length === 0 ? "completed"
    : projection.completed_cycles >= 3 ? "held" : "continuing";
  return Object.freeze({
    schema_version: "blue-tanuki.document-organization-memory.v1",
    record_type: "document_organization_receipt",
    record_id: identity.record_id,
    task_id: projection.task_id,
    request_id: projection.source_ref.request_id,
    source_sha256: projection.source_ref.content_sha256,
    task_revision: projection.revision,
    update_id: identity.update_id,
    j_event_id: identity.j_event_id,
    state_digest: documentOrganizationMemoryStateDigest(projection),
    accepted_excerpt_count: acceptedIds.length,
    accepted_excerpt_ids_digest: digestJson(acceptedIds),
    uncovered_ranges_digest: digestJson(projection.uncovered_ranges),
    next_status: nextStatus,
    command_id_digest: digestText(commandId),
    command_request_id_digest: digestText(commandRequestId),
    previous_receipt_digest: previousReceiptDigest,
    used_for_authority: false,
    may_execute: false,
  });
}

function isDocumentOrganizationMemoryRecord(value: unknown): value is DocumentOrganizationMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["schema_version", "record_type", "record_id", "task_id", "request_id", "source_sha256",
    "task_revision", "update_id", "j_event_id", "state_digest", "accepted_excerpt_count",
    "accepted_excerpt_ids_digest", "uncovered_ranges_digest", "next_status", "command_id_digest", "command_request_id_digest",
    "previous_receipt_digest", "used_for_authority", "may_execute"];
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)) &&
    record.schema_version === "blue-tanuki.document-organization-memory.v1" &&
    record.record_type === "document_organization_receipt" &&
    typeof record.record_id === "string" && safeIdentifier(record.record_id) &&
    typeof record.task_id === "string" && safeIdentifier(record.task_id) &&
    typeof record.request_id === "string" && safeIdentifier(record.request_id) &&
    typeof record.source_sha256 === "string" && /^[a-f0-9]{64}$/u.test(record.source_sha256) &&
    Number.isSafeInteger(record.task_revision) && (record.task_revision as number) > 0 &&
    typeof record.update_id === "string" && safeIdentifier(record.update_id) &&
    typeof record.j_event_id === "string" && safeIdentifier(record.j_event_id) &&
    typeof record.state_digest === "string" && /^[a-f0-9]{64}$/u.test(record.state_digest) &&
    Number.isSafeInteger(record.accepted_excerpt_count) && (record.accepted_excerpt_count as number) > 0 &&
    typeof record.accepted_excerpt_ids_digest === "string" && /^[a-f0-9]{64}$/u.test(record.accepted_excerpt_ids_digest) &&
    typeof record.uncovered_ranges_digest === "string" && /^[a-f0-9]{64}$/u.test(record.uncovered_ranges_digest) &&
    ["continuing", "completed", "held"].includes(String(record.next_status)) &&
    typeof record.command_id_digest === "string" && /^[a-f0-9]{64}$/u.test(record.command_id_digest) &&
    typeof record.command_request_id_digest === "string" && /^[a-f0-9]{64}$/u.test(record.command_request_id_digest) &&
    (record.previous_receipt_digest === null ||
      (typeof record.previous_receipt_digest === "string" && /^[a-f0-9]{64}$/u.test(record.previous_receipt_digest))) &&
    record.used_for_authority === false && record.may_execute === false;
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(value);
}
