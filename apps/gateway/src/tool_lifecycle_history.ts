import type { CompleteHistoryAppendInput, CompleteHistoryEntry, CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import { GatewayExecutionIntentStore, type PendingToolLifecycleEvidence } from "./execution_intent_store.js";

export interface ToolLifecycleHistoryRecoveryIssue {
  lifecycle_event_id: string;
  state: string;
  reason: "identity_conflict" | "append_failed" | "acknowledgement_failed";
}

export interface ToolLifecycleHistoryRecoveryResult {
  recovered: number;
  still_pending: number;
  issues: ToolLifecycleHistoryRecoveryIssue[];
}

export function toolLifecycleHistoryInput(event: PendingToolLifecycleEvidence): CompleteHistoryAppendInput {
  return {
    kind: "audit_history",
    command_id: event.command_id,
    actor: "executor",
    source: "executor_tool_process",
    timestamp: event.observation.observed_at_ms,
    payload: { lifecycle_event_id: event.lifecycle_event_id, ...event.observation },
  };
}

/** Project pending non-authority lifecycle evidence and acknowledge only durable CompleteHistory entries. */
export function recoverPendingToolLifecycleHistory(input: {
  execution_store: GatewayExecutionIntentStore;
  complete_history: CompleteHistoryStore;
  complete_history_persistent: boolean;
  append_history(entry: CompleteHistoryAppendInput): CompleteHistoryEntry | null;
  now_ms?: () => number;
}): ToolLifecycleHistoryRecoveryResult {
  const pending = input.execution_store.pendingToolLifecycleEvidence();
  const existingEntries = new Map<string, CompleteHistoryEntry>();
  for (const entry of input.complete_history.all()) {
    if (entry.kind !== "audit_history" || typeof entry.payload !== "object" || entry.payload === null || Array.isArray(entry.payload)) continue;
    const eventId = (entry.payload as Record<string, unknown>).lifecycle_event_id;
    if (typeof eventId === "string" && !existingEntries.has(eventId)) existingEntries.set(eventId, entry);
  }

  let recovered = 0;
  let stillPending = 0;
  const issues: ToolLifecycleHistoryRecoveryIssue[] = [];
  for (let index = 0; index < pending.length; index++) {
    const event = pending[index]!;
    const appendInput = toolLifecycleHistoryInput(event);
    const existing = existingEntries.get(event.lifecycle_event_id);
    let entry: CompleteHistoryEntry | null = existing ?? null;
    if (existing && (existing.command_id !== appendInput.command_id || existing.actor !== appendInput.actor ||
        existing.source !== appendInput.source || existing.timestamp !== appendInput.timestamp ||
        JSON.stringify(existing.payload) !== JSON.stringify(appendInput.payload))) {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.observation.state, reason: "identity_conflict" });
      stillPending += 1;
      continue;
    }
    if (!entry) {
      try { entry = input.append_history(appendInput); }
      catch { entry = null; }
    }
    if (!entry) {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.observation.state, reason: "append_failed" });
      stillPending += pending.length - index;
      break;
    }
    existingEntries.set(event.lifecycle_event_id, entry);
    if (!input.complete_history_persistent) {
      stillPending++;
      continue;
    }
    try {
      input.execution_store.acknowledgeToolLifecycleHistory(event.lifecycle_event_id, entry.id, (input.now_ms ?? Date.now)());
      recovered++;
    } catch {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.observation.state,
        reason: "acknowledgement_failed" });
      stillPending += pending.length - index;
      break;
    }
  }
  return { recovered, still_pending: stillPending, issues };
}
