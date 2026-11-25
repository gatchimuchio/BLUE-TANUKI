import { randomUUID } from "node:crypto";
import type { ExecuteCommand, ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import { isGatewayInternalD4RuntimeIntentRequest, normalizeInboundRequestForAuthority } from "@blue-tanuki/protocol";
import {
  DocumentOrganizationCoordinator,
  HDSUpperController,
  renderDocumentOrganizationProjection,
  type DecisionLog,
  type DocumentOrganizationMemoryVersion,
  type DocumentOrganizationProjection,
  type ProjectionOutputAuditLog,
  type OutputTargetSurface,
} from "@blue-tanuki/hds-brain";
import {
  Executor,
  captureExecutorCommandForApproval,
  type ExecutorApprovalAuthority,
} from "@blue-tanuki/core";
import type { FailureMemoryStore } from "@blue-tanuki/hds-brain";
import type { ApprovalRuntime } from "./approval_runtime.js";
import { approvalDeniedFeedback } from "./approval_runtime.js";
import {
  DocumentOrganizationCheckpointCapacityError,
  DocumentOrganizationCheckpointIntegrityError,
  type DocumentOrganizationCheckpointIdentity,
  type DocumentOrganizationCheckpointStore,
} from "./document_organization_checkpoint_store.js";

export interface DocumentOrganizationTaskInput {
  readonly coordinator: DocumentOrganizationCoordinator;
  readonly origin: InboundRequest;
  readonly hds: HDSUpperController;
  readonly executor: Executor;
  readonly executorApproval: ExecutorApprovalAuthority;
  readonly approval: ApprovalRuntime;
  readonly failureMemory: FailureMemoryStore;
  readonly target_surface: OutputTargetSurface;
  readonly first_decision: { readonly log: DecisionLog; readonly command: ExecuteCommand | null };
  readonly persist_checkpoint: () => void;
  readonly current_memory_version: () => DocumentOrganizationMemoryVersion;
  readonly emergency_stop_active?: boolean | (() => boolean);
  readonly execution?: {
    readonly signal: AbortSignal;
    readonly onCycleStart: (command: ExecuteCommand) => void;
    readonly onCycleTask?: (task: Promise<ExecuteFeedback>) => void;
    readonly onCycleSettled: (command: ExecuteCommand, status: ExecuteFeedback["status"] | "unknown") => void;
    readonly retainCheckpointOnAbort?: () => boolean;
  };
  readonly transient_content?: "document_organization" | "google_drive_document_organization";
}

export interface DocumentOrganizationTaskResult {
  readonly projection: DocumentOrganizationProjection;
  readonly rendered_output: string;
  readonly output_audit: ReturnType<HDSUpperController["onOutputAudit"]> | ProjectionOutputAuditLog;
  readonly command_id: string | null;
  readonly upstream_commit_hash: string;
  readonly status: "completed" | "held" | "pending";
  readonly restored_from_checkpoint: boolean;
}

export interface DocumentOrganizationSession {
  readonly coordinator: DocumentOrganizationCoordinator;
  readonly restored_terminal_state: boolean;
  persist_checkpoint(): void;
}

/** A task is explicitly selected by an owner-facing local entry. */
export function documentOrganizationSourceFromRequest(request: InboundRequest): string | null {
  if (request.channel !== "cli" && request.channel !== "webchat") return null;
  const match = /^\/organize(?:\r?\n|[ \t]+)([\s\S]*)$/u.exec(request.content);
  if (!match) return null;
  return match[1] ?? "";
}

export function createDocumentOrganizationCoordinator(
  request: Pick<InboundRequest, "id">,
  source_text: string,
  memory_version?: DocumentOrganizationMemoryVersion,
): DocumentOrganizationCoordinator {
  return new DocumentOrganizationCoordinator({
    task_id: `document-organization:${request.id}`,
    request_id: request.id,
    source_text,
    ...(memory_version ? { memory_version } : {}),
  });
}

/** ローカルはactorと原文、D4 Runtimeは検証済み受付IDも照合してJ checkpointを開く。 */
export function prepareDocumentOrganizationSession(input: {
  readonly request: InboundRequest;
  readonly source_text: string;
  readonly hds: HDSUpperController;
  readonly store: DocumentOrganizationCheckpointStore;
}): DocumentOrganizationSession {
  const currentMemoryVersion = input.hds.documentOrganizationMemoryVersion();
  const initial = createDocumentOrganizationCoordinator(input.request, input.source_text, currentMemoryVersion);
  const initialCheckpoint = initial.checkpoint();
  const identity: DocumentOrganizationCheckpointIdentity = {
    channel: input.request.channel as "cli" | "webchat",
    actor: input.request.user,
    source_sha256: initialCheckpoint.source_sha256,
    ...(isGatewayInternalD4RuntimeIntentRequest(input.request) ? { d4_runtime_request_id: input.request.id } : {}),
  };
  let stored: ReturnType<DocumentOrganizationCheckpointStore["getOrCreate"]>;
  try {
    stored = input.store.getOrCreate(identity, initialCheckpoint);
  } catch (error) {
    const issue: "checkpoint_capacity" | "checkpoint_integrity_failed" = error instanceof DocumentOrganizationCheckpointCapacityError
      ? "checkpoint_capacity"
      : error instanceof DocumentOrganizationCheckpointIntegrityError
        ? "checkpoint_integrity_failed"
        : "checkpoint_integrity_failed";
    initial.holdForRecovery(issue);
    return { coordinator: initial, restored_terminal_state: true, persist_checkpoint: () => undefined };
  }

  let coordinator = initial;
  if (!stored.created) {
    try {
      coordinator = DocumentOrganizationCoordinator.restore({ source_text: input.source_text }, stored.checkpoint);
    } catch {
      initial.holdForRecovery("checkpoint_integrity_failed");
      return { coordinator: initial, restored_terminal_state: true, persist_checkpoint: () => undefined };
    }
  }

  let expectedDigest = stored.digest;
  const persist_checkpoint = (): void => {
    stored = input.store.compareAndSet(identity, expectedDigest, coordinator.checkpoint());
    expectedDigest = stored.digest;
  };

  let projection = coordinator.snapshot();
  let terminal = projection.status === "completed" || projection.status === "held";
  if (projection.status === "memory_pending") {
    const checkpoint = coordinator.checkpoint();
    const commandId = checkpoint.pending_memory_command_id;
    const commandRequestId = checkpoint.pending_memory_command_request_id;
    if (!commandId || !commandRequestId) {
      projection = coordinator.holdForRecovery("memory_receipt_unverified");
      try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
      terminal = true;
    } else {
      let resolved = input.hds.completeDocumentOrganizationMemoryReceipt({
        projection,
        prior_receipts: checkpoint.memory_receipts,
        command_id: commandId,
        command_request_id: commandRequestId,
        allow_new_commit: false,
      });
      if (resolved.status === "ready") {
        projection = coordinator.confirmMemoryReceipt(resolved.binding);
        try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
      } else if (resolved.status === "missing") {
        const current = input.hds.documentOrganizationMemoryVersion();
        const samePinnedMemory = current.status === "verified" &&
          sameMemoryVersion(checkpoint.memory_version, current);
        if (samePinnedMemory) {
          resolved = input.hds.completeDocumentOrganizationMemoryReceipt({
            projection,
            prior_receipts: checkpoint.memory_receipts,
            command_id: commandId,
            command_request_id: commandRequestId,
            allow_new_commit: true,
          });
        }
        if (resolved.status === "ready") {
          projection = coordinator.confirmMemoryReceipt(resolved.binding);
          try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
        } else if (resolved.status === "pending") {
          terminal = true;
        } else {
          projection = coordinator.holdForRecovery(samePinnedMemory ? "memory_receipt_unverified"
            : current.status === "verified" ? "memory_state_changed" : "memory_state_unverified");
          try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
          terminal = true;
        }
      } else if (resolved.status === "pending") {
        terminal = true;
      } else {
        projection = coordinator.holdForRecovery("memory_receipt_unverified");
        try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
        terminal = true;
      }
      projection = coordinator.snapshot();
      terminal ||= projection.status !== "continuing";
    }
  }

  if (projection.revision > 0 && projection.status !== "memory_pending" && projection.status !== "held" &&
      !input.hds.verifyDocumentOrganizationMemoryReceipts({
        projection,
        receipts: coordinator.checkpoint().memory_receipts,
      })) {
    if (projection.status === "completed") {
      initial.holdForRecovery("memory_receipt_unverified");
      return { coordinator: initial, restored_terminal_state: true, persist_checkpoint: () => undefined };
    }
    projection = coordinator.holdForRecovery("memory_receipt_unverified");
    try { persist_checkpoint(); } catch { projection = coordinator.holdForRecovery("checkpoint_integrity_failed"); }
    terminal = true;
  }

  if (!terminal && projection.status === "continuing") {
    const checkpointMemoryVersion = coordinator.checkpoint().memory_version;
    const current = input.hds.documentOrganizationMemoryVersion();
    const validCurrentMemory = current.status === "verified";
    if (!validCurrentMemory || !sameMemoryVersion(checkpointMemoryVersion, current)) {
      coordinator.holdForRecovery(validCurrentMemory ? "memory_state_changed" : "memory_state_unverified");
      try { persist_checkpoint(); } catch { coordinator.holdForRecovery("checkpoint_integrity_failed"); }
      terminal = true;
    }
  }

  return { coordinator, restored_terminal_state: terminal, persist_checkpoint };
}

export function presentRestoredDocumentOrganizationProjection(input: {
  readonly coordinator: DocumentOrganizationCoordinator;
  readonly request_id: string;
  readonly upstream_commit_hash: string;
  readonly hds: HDSUpperController;
  readonly target_surface: OutputTargetSurface;
}): DocumentOrganizationTaskResult {
  const projection = input.coordinator.snapshot();
  if (projection.status !== "completed" && projection.status !== "held" && projection.status !== "memory_pending") {
    throw new Error("document organization recovery projection is not displayable");
  }
  const rendered_output = renderDocumentOrganizationProjection(projection);
  const output_audit = input.hds.onDocumentOrganizationProjectionOutputAudit({
    request_id: input.request_id,
    upstream_commit_hash: input.upstream_commit_hash,
    projection,
    rendered_output,
    target_surface: input.target_surface,
  });
  return {
    projection,
    rendered_output,
    output_audit,
    command_id: null,
    upstream_commit_hash: input.upstream_commit_hash,
    status: projection.status === "completed" ? "completed" : projection.status === "memory_pending" ? "pending" : "held",
    restored_from_checkpoint: true,
  };
}

/**
 * Run each C call as a fresh HDS decision and only execute an LLM command.
 * J validates the provider content before it can update the display projection.
 */
export async function runDocumentOrganizationTask(
  input: DocumentOrganizationTaskInput,
): Promise<DocumentOrganizationTaskResult | null> {
  const { execution } = input;
  let decision = input.first_decision;
  let lastCommand: ExecuteCommand | null = null;
  let lastFeedback: ExecuteFeedback | null = null;
  let projection = input.coordinator.snapshot();

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const { log, command } = decision;
    if (execution?.signal.aborted) {
      if (command) input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: "document_organization_task_cancelled_before_executor",
      });
      return cancelDocumentOrganizationTask(input);
    }
    if (!command) {
      if (!lastCommand || !lastFeedback) return null;
      projection = input.coordinator.rejectCycle("j_decision_no_command");
      input.persist_checkpoint();
      break;
    }
    lastCommand = command;

    const currentMemoryVersion = input.current_memory_version();
    const pinnedMemoryVersion = input.coordinator.checkpoint().memory_version;
    if (currentMemoryVersion.status !== "verified" || !sameMemoryVersion(pinnedMemoryVersion, currentMemoryVersion)) {
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: currentMemoryVersion.status === "verified" ? "document_organization_memory_state_changed" : "document_organization_memory_state_unverified",
      });
      projection = input.coordinator.holdForRecovery(
        currentMemoryVersion.status === "verified" ? "memory_state_changed" : "memory_state_unverified",
      );
      try {
        input.persist_checkpoint();
      } catch {
        projection = input.coordinator.holdForRecovery("checkpoint_integrity_failed");
      }
      return projectionOutputResult({
        coordinator: input.coordinator,
        request_id: input.origin.id,
        upstream_commit_hash: log.commit.hash,
        hds: input.hds,
        target_surface: input.target_surface,
      });
    }

    const emergencyStopActive = typeof input.emergency_stop_active === "function"
      ? input.emergency_stop_active() : input.emergency_stop_active;
    if (emergencyStopActive) {
      input.hds.onAuthorityEvent("emergency_stop_blocked", {
        request_id: log.request_id,
        command_id: command.id,
        actor: input.origin.user,
        reason: "document_organization_cycle_emergency_stop_active",
      });
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: "emergency_stop_active",
      });
      lastFeedback = approvalDeniedFeedback(command, "emergency_stop_active");
      projection = input.coordinator.rejectCycle("emergency_stop_active");
      input.persist_checkpoint();
      break;
    }

    if (command.type !== "llm_call") {
      input.hds.onCommandLifecycle(command.id, "approval_rejected", {
        actor: input.origin.user,
        reason: "document_organization_allows_llm_call_only",
      });
      lastFeedback = approvalDeniedFeedback(command, "document_organization_allows_llm_call_only");
      projection = input.coordinator.rejectCycle("unsupported_command_type");
      input.persist_checkpoint();
      break;
    }

    const failureGate = input.failureMemory.evaluateCommandGate(command, {
      actor: input.origin.user,
      channel: input.origin.channel,
      request_id: log.request_id,
      surface: input.target_surface === "cli" ? "cli" : "webchat",
    });
    if (failureGate.decision !== "allow") {
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: `failure_memory:${failureGate.reason}`,
      });
      lastFeedback = approvalDeniedFeedback(command, `failure_memory:${failureGate.reason}`);
      projection = input.coordinator.rejectCycle(
        failureGate.decision === "block" ? "failure_memory_blocked" : "failure_memory_requires_approval",
      );
      input.persist_checkpoint();
      break;
    }

    const reviewed = captureExecutorCommandForApproval(command);
    const evaluation = input.approval.evaluate(command, input.origin.user);
    input.hds.onApprovalEvaluation(evaluation, { request_id: log.request_id });
    if (evaluation.decision !== "allow") {
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: evaluation.decision === "deny" ? evaluation.reason : "human_approval_required",
      });
      lastFeedback = approvalDeniedFeedback(command, evaluation.reason);
      projection = input.coordinator.rejectCycle(
        evaluation.decision === "deny" ? "approval_denied" : "approval_required",
      );
      input.persist_checkpoint();
      break;
    }

    input.hds.onCommandLifecycle(command.id, "approval_approved", {
      actor: input.origin.user,
      reason: evaluation.reason,
    });
    const approvedCommand = input.executorApproval.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: input.origin.user,
      approved_at_ms: Date.now(),
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: evaluation.context.operation,
      risk: evaluation.risk,
      final_review_required: evaluation.final_review_required,
      reason: evaluation.reason,
    }, reviewed.command_digest, input.hds.createExecutionAuthorityBinding(command));
    execution?.onCycleStart(command);
    let feedback: ExecuteFeedback | undefined;
    try {
      const task = input.executor.execute(approvedCommand, execution ? { signal: execution.signal } : undefined);
      execution?.onCycleTask?.(task);
      feedback = await task;
    } catch (error) {
      if (!execution?.signal.aborted) throw error;
    } finally {
      execution?.onCycleSettled(command, feedback?.status ?? "unknown");
    }
    if (!feedback || execution?.signal.aborted) {
      // Executorの実状態はsettlementに残し、Jには取消後の結果本文や提案を渡さない。
      input.hds.onFeedback({
        command_id: command.id,
        status: feedback?.status === "failed" ? "failed" : "suspended",
        error: "document_organization_result_discarded_after_task_cancel",
        metrics: { duration_ms: feedback?.metrics.duration_ms ?? 0 },
      });
      return cancelDocumentOrganizationTask(input);
    }
    lastFeedback = feedback;
    const reviewedFeedback = input.hds.reviewMemoryCitations(command, feedback);
    input.hds.onFeedback(feedback);

    if (feedback.status !== "success") {
      projection = input.coordinator.rejectCycle("c_compute_failed");
      input.persist_checkpoint();
      break;
    }
    const content = resultContent(reviewedFeedback.result);
    const memoryVersionAfterCompute = input.current_memory_version();
    if (memoryVersionAfterCompute.status !== "verified" || !sameMemoryVersion(pinnedMemoryVersion, memoryVersionAfterCompute)) {
      projection = input.coordinator.holdForRecovery(
        memoryVersionAfterCompute.status === "verified" ? "memory_state_changed" : "memory_state_unverified",
      );
    } else {
      projection = content === null
        ? input.coordinator.rejectCycle("c_output_missing")
        : input.coordinator.applyComputeOutput(content);
    }
    if (projection.status === "memory_pending") {
      projection = input.coordinator.beginMemoryCommit(command.id, log.request_id);
      input.persist_checkpoint();
      const checkpoint = input.coordinator.checkpoint();
      const receipt = input.hds.completeDocumentOrganizationMemoryReceipt({
        projection,
        prior_receipts: checkpoint.memory_receipts,
        command_id: command.id,
        command_request_id: log.request_id,
        allow_new_commit: true,
      });
      if (receipt.status === "ready") {
        projection = input.coordinator.confirmMemoryReceipt(receipt.binding);
        input.persist_checkpoint();
      } else if (receipt.status === "blocked") {
        projection = input.coordinator.holdForRecovery("memory_receipt_unverified");
        input.persist_checkpoint();
      }
    } else {
      input.persist_checkpoint();
    }
    if (projection.status !== "continuing") break;

    const nextRequest = normalizeInboundRequestForAuthority({
      id: randomUUID(),
      channel: input.origin.channel,
      user: input.origin.user,
      content: input.coordinator.buildComputePrompt(),
      timestamp: Date.now(),
      ...(input.origin.goal_criteria ? { goal_criteria: input.origin.goal_criteria } : {}),
    });
    decision = input.hds.decide(nextRequest, {
      transient_content: input.transient_content ?? "document_organization",
    });
  }

  if (!lastCommand || !lastFeedback) return null;
  projection = input.coordinator.snapshot();
  const rendered_output = renderDocumentOrganizationProjection(projection);
  const output_audit = input.hds.onOutputAudit({
    command: lastCommand,
    feedback: lastFeedback,
    rendered_output,
    target_surface: input.target_surface,
    request_id: input.origin.id,
  });
  return {
    projection,
    rendered_output,
    output_audit,
    command_id: lastCommand.id,
    upstream_commit_hash: lastCommand.upstream_decision.commit_hash,
    status: projection.status === "completed" ? "completed" : projection.status === "memory_pending" ? "pending" : "held",
    restored_from_checkpoint: false,
  };
}

function cancelDocumentOrganizationTask(input: DocumentOrganizationTaskInput): DocumentOrganizationTaskResult | null {
  if (input.execution?.retainCheckpointOnAbort?.()) return null;
  input.coordinator.cancel();
  input.persist_checkpoint();
  return projectionOutputResult({
    coordinator: input.coordinator,
    request_id: input.origin.id,
    upstream_commit_hash: input.first_decision.log.commit.hash,
    hds: input.hds,
    target_surface: input.target_surface,
    rendered_output: "資料整理を取り消しました。確認済みの引用範囲は保持しています。",
  });
}

function projectionOutputResult(input: {
  readonly coordinator: DocumentOrganizationCoordinator;
  readonly request_id: string;
  readonly upstream_commit_hash: string;
  readonly hds: HDSUpperController;
  readonly target_surface: OutputTargetSurface;
  readonly rendered_output?: string;
}): DocumentOrganizationTaskResult {
  const projection = input.coordinator.snapshot();
  if (projection.status !== "completed" && projection.status !== "held") {
    throw new Error("document organization projection output is not terminal");
  }
  const rendered_output = input.rendered_output ?? renderDocumentOrganizationProjection(projection);
  const output_audit = input.hds.onDocumentOrganizationProjectionOutputAudit({
    request_id: input.request_id,
    upstream_commit_hash: input.upstream_commit_hash,
    projection,
    rendered_output,
    target_surface: input.target_surface,
  });
  return {
    projection,
    rendered_output,
    output_audit,
    command_id: null,
    upstream_commit_hash: input.upstream_commit_hash,
    status: projection.status === "completed" ? "completed" : "held",
    restored_from_checkpoint: false,
  };
}

function sameMemoryVersion(
  expected: DocumentOrganizationMemoryVersion,
  actual: DocumentOrganizationMemoryVersion,
): boolean {
  return expected.schema_version === actual.schema_version &&
    expected.status === "verified" && actual.status === "verified" &&
    expected.revision_digest !== null && expected.revision_digest === actual.revision_digest &&
    expected.entry_count !== null && expected.entry_count === actual.entry_count;
}

function resultContent(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}
