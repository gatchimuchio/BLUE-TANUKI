import type { CompleteHistoryAppendInput, CompleteHistoryEntry, CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import { GatewayExecutionIntentStore, type PendingTaskExecutionCancellationEvidence } from "./execution_intent_store.js";

export interface TaskCancellationHistoryRecoveryIssue {
  cancellation_event_id: string;
  event: PendingTaskExecutionCancellationEvidence["event"];
  reason: "identity_conflict" | "append_failed" | "acknowledgement_failed" | "ledger_backfill_failed";
}

export interface TaskCancellationHistoryRecoveryResult {
  recovered: number;
  still_pending: number;
  issues: TaskCancellationHistoryRecoveryIssue[];
}

export function taskCancellationHistoryInput(event: PendingTaskExecutionCancellationEvidence): CompleteHistoryAppendInput {
  return {
    kind: "audit_history",
    command_id: event.command_id,
    actor: event.actor,
    source: "gateway_task_cancellation",
    timestamp: event.observed_at_ms,
    payload: {
      cancellation_event_id: event.cancellation_event_id,
      event: event.event,
      token_kind: event.token_kind,
      observed_at_ms: event.observed_at_ms,
      cancel_requested_at_ms: event.cancel_requested_at_ms,
      cancel_request_accepted: event.cancel_request_accepted,
      executor_settled: event.executor_settled,
      executor_status: event.executor_status,
      local_worker_stop: event.local_worker_stop,
      external_processing_stop: event.external_processing_stop,
      used_for_authority: event.used_for_authority,
      may_execute: event.may_execute,
    },
  };
}

/** Recover non-authority cancellation observations and acknowledge only durable CompleteHistory entries. */
export function recoverPendingTaskCancellationHistory(input: {
  execution_store: GatewayExecutionIntentStore;
  complete_history: CompleteHistoryStore;
  complete_history_persistent: boolean;
  append_history(entry: CompleteHistoryAppendInput): CompleteHistoryEntry | null;
  now_ms?: () => number;
}): TaskCancellationHistoryRecoveryResult {
  const existingEntries = new Map<string, CompleteHistoryEntry>();
  const issues: TaskCancellationHistoryRecoveryIssue[] = [];
  let ledgerBackfillFailures = 0;
  const ledgerEventIds = new Set(input.execution_store.taskExecutionCancellationEvidenceIds());
  for (const entry of input.complete_history.all()) {
    if (entry.kind !== "audit_history" || typeof entry.payload !== "object" || entry.payload === null || Array.isArray(entry.payload)) continue;
    const payload = entry.payload as Record<string, unknown>;
    const eventId = payload.cancellation_event_id;
    if (typeof eventId === "string" && !existingEntries.has(eventId)) existingEntries.set(eventId, entry);
    if (entry.source !== "gateway_task_cancellation" || typeof eventId !== "string" || ledgerEventIds.has(eventId)) continue;
    const eventName = payload.event === "execution_cancel_observed" ? "execution_cancel_observed" : "execution_cancel_requested";
    const fallback: PendingTaskExecutionCancellationEvidence = {
      cancellation_event_id: eventId,
      command_id: entry.command_id ?? "",
      event: eventName,
      actor: entry.actor ?? "",
      token_kind: payload.token_kind as "resume",
      observed_at_ms: payload.observed_at_ms as number,
      cancel_requested_at_ms: payload.cancel_requested_at_ms as number,
      cancel_request_accepted: payload.cancel_request_accepted as true,
      executor_settled: payload.executor_settled as boolean,
      executor_status: payload.executor_status as PendingTaskExecutionCancellationEvidence["executor_status"],
      local_worker_stop: payload.local_worker_stop as PendingTaskExecutionCancellationEvidence["local_worker_stop"],
      external_processing_stop: payload.external_processing_stop as "unknown",
      used_for_authority: payload.used_for_authority as false,
      may_execute: payload.may_execute as false,
    };
    try {
      input.execution_store.recordTaskExecutionCancellationEvidence(fallback);
      ledgerEventIds.add(eventId);
    }
    catch {
      issues.push({ cancellation_event_id: eventId, event: eventName, reason: "ledger_backfill_failed" });
      ledgerBackfillFailures++;
    }
  }
  const pending = input.execution_store.pendingTaskExecutionCancellationEvidence();

  let recovered = 0;
  let stillPending = ledgerBackfillFailures;
  for (let index = 0; index < pending.length; index++) {
    const event = pending[index]!;
    const appendInput = taskCancellationHistoryInput(event);
    const existing = existingEntries.get(event.cancellation_event_id);
    let entry: CompleteHistoryEntry | null = existing ?? null;
    if (existing && (existing.command_id !== appendInput.command_id || existing.actor !== appendInput.actor ||
        existing.source !== appendInput.source || existing.timestamp !== appendInput.timestamp ||
        JSON.stringify(existing.payload) !== JSON.stringify(appendInput.payload))) {
      issues.push({ cancellation_event_id: event.cancellation_event_id, event: event.event, reason: "identity_conflict" });
      stillPending += 1;
      continue;
    }
    if (!entry) {
      try { entry = input.append_history(appendInput); }
      catch { entry = null; }
    }
    if (!entry) {
      issues.push({ cancellation_event_id: event.cancellation_event_id, event: event.event, reason: "append_failed" });
      stillPending += pending.length - index;
      break;
    }
    existingEntries.set(event.cancellation_event_id, entry);
    if (!input.complete_history_persistent) {
      stillPending++;
      continue;
    }
    try {
      input.execution_store.acknowledgeTaskExecutionCancellationHistory(
        event.cancellation_event_id, entry.id, (input.now_ms ?? Date.now)(),
      );
      recovered++;
    } catch {
      issues.push({ cancellation_event_id: event.cancellation_event_id, event: event.event,
        reason: "acknowledgement_failed" });
      stillPending += pending.length - index;
      break;
    }
  }
  return { recovered, still_pending: stillPending, issues };
}
