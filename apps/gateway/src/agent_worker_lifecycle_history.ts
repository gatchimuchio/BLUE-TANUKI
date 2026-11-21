import type { CompleteHistoryAppendInput, CompleteHistoryEntry, CompleteHistoryStore } from "@blue-tanuki/hds-brain";
import { GatewayExecutionIntentStore, type AgentWorkerLifecycleEvidence } from "./execution_intent_store.js";

export interface AgentWorkerLifecycleHistoryRecoveryIssue {
  lifecycle_event_id: string;
  state: AgentWorkerLifecycleEvidence["event"]["state"];
  reason: "identity_conflict" | "append_failed" | "acknowledgement_failed";
}

export interface AgentWorkerLifecycleHistoryRecoveryResult {
  recovered: number;
  still_pending: number;
  issues: AgentWorkerLifecycleHistoryRecoveryIssue[];
}

export function agentWorkerLifecycleHistoryInput(event: AgentWorkerLifecycleEvidence): CompleteHistoryAppendInput {
  const observation = event.event;
  return {
    kind: "audit_history",
    command_id: observation.parent_command_id,
    actor: "executor",
    source: "executor_agent_worker",
    timestamp: observation.observed_at_ms,
    payload: {
      lifecycle_event_id: event.lifecycle_event_id,
      schema_version: observation.schema_version,
      parent_command_digest: observation.parent_command_digest,
      child_task_digest: observation.child_task_digest,
      role: observation.role,
      state: observation.state,
      observed_at_ms: observation.observed_at_ms,
      ...(observation.output_observed ? { output_observed: true } : {}),
      ...(observation.output_characters !== undefined ? { output_characters: observation.output_characters } : {}),
      ...(observation.resource_use_digest ? { resource_use_digest: observation.resource_use_digest } : {}),
      used_for_authority: false,
      may_execute: false,
    },
  };
}

/** Recover non-authority child-worker observations and acknowledge only durable CompleteHistory entries. */
export function recoverPendingAgentWorkerLifecycleHistory(input: {
  execution_store: GatewayExecutionIntentStore;
  complete_history: CompleteHistoryStore;
  complete_history_persistent: boolean;
  append_history(entry: CompleteHistoryAppendInput): CompleteHistoryEntry | null;
  now_ms?: () => number;
}): AgentWorkerLifecycleHistoryRecoveryResult {
  const pending = input.execution_store.pendingAgentWorkerLifecycleEvidence();
  const existingEntries = new Map<string, CompleteHistoryEntry>();
  for (const entry of input.complete_history.all()) {
    if (entry.kind !== "audit_history" || typeof entry.payload !== "object" || entry.payload === null || Array.isArray(entry.payload)) continue;
    const eventId = (entry.payload as Record<string, unknown>).lifecycle_event_id;
    if (typeof eventId === "string" && !existingEntries.has(eventId)) existingEntries.set(eventId, entry);
  }

  let recovered = 0;
  let stillPending = 0;
  const issues: AgentWorkerLifecycleHistoryRecoveryIssue[] = [];
  for (let index = 0; index < pending.length; index++) {
    const event = pending[index]!;
    const appendInput = agentWorkerLifecycleHistoryInput(event);
    const existing = existingEntries.get(event.lifecycle_event_id);
    let entry: CompleteHistoryEntry | null = existing ?? null;
    if (existing && (existing.command_id !== appendInput.command_id || existing.actor !== appendInput.actor ||
        existing.source !== appendInput.source || existing.timestamp !== appendInput.timestamp ||
        JSON.stringify(existing.payload) !== JSON.stringify(appendInput.payload))) {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.event.state, reason: "identity_conflict" });
      stillPending++;
      continue;
    }
    if (!entry) {
      try { entry = input.append_history(appendInput); }
      catch { entry = null; }
    }
    if (!entry) {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.event.state, reason: "append_failed" });
      stillPending += pending.length - index;
      break;
    }
    existingEntries.set(event.lifecycle_event_id, entry);
    if (!input.complete_history_persistent) {
      stillPending++;
      continue;
    }
    try {
      input.execution_store.acknowledgeAgentWorkerLifecycleHistory(
        event.lifecycle_event_id, entry.id, (input.now_ms ?? Date.now)(),
      );
      recovered++;
    } catch {
      issues.push({ lifecycle_event_id: event.lifecycle_event_id, state: event.event.state,
        reason: "acknowledgement_failed" });
      stillPending += pending.length - index;
      break;
    }
  }
  return { recovered, still_pending: stillPending, issues };
}
