import type { ToolExecutionLifecycleObservation } from "@blue-tanuki/core";
import type { ExecuteFeedback } from "@blue-tanuki/protocol";

export type LocalWorkerStopObservation =
  | "not_observed"
  | "worker_exit_observed"
  | "process_tree_empty_confirmed"
  | "provider_state_unknown";

export interface ActiveTaskExecutionSnapshot {
  command_id: string;
  started_at_ms: number;
  cancel_requested_at_ms: number | null;
  execution_signal_aborted: boolean;
  executor_state: "running" | "cancel_requested";
  local_worker_stop: LocalWorkerStopObservation;
  external_processing_stop: "unknown";
  used_for_authority: false;
}

export interface TaskExecutionCancellationResult extends ActiveTaskExecutionSnapshot {
  status: "cancel_requested" | "already_requested";
  cancel_request_accepted: true;
  executor_settled: false;
}

export interface FinishedTaskExecutionCancellation {
  command_id: string;
  cancel_requested_by: string;
  executor_settled: boolean;
  executor_status: ExecuteFeedback["status"] | "unknown";
  local_worker_stop: LocalWorkerStopObservation;
  external_processing_stop: "unknown";
}

interface ActiveTaskExecution {
  command_id: string;
  controller: AbortController;
  started_at_ms: number;
  cancel_requested_at_ms: number | null;
  cancel_requested_by: string | null;
  executor_settled: boolean;
  executor_status: ExecuteFeedback["status"] | "unknown";
  local_worker_state: LocalWorkerStopObservation;
  local_worker_observed_at_ms: number;
}

/** Owns the command-id to AbortController binding used by task cancellation. */
export class ActiveTaskExecutionRegistry {
  private readonly active = new Map<string, ActiveTaskExecution>();

  register(command_id: string, controller: AbortController, started_at_ms = Date.now()): void {
    if (!command_id || command_id.length > 200 || !Number.isSafeInteger(started_at_ms) || started_at_ms <= 0) {
      throw new Error("active_task_execution_identity_invalid");
    }
    if (this.active.has(command_id)) throw new Error("active_task_execution_identity_conflict");
    this.active.set(command_id, {
      command_id,
      controller,
      started_at_ms,
      cancel_requested_at_ms: null,
      cancel_requested_by: null,
      executor_settled: false,
      executor_status: "unknown",
      local_worker_state: "not_observed",
      local_worker_observed_at_ms: 0,
    });
  }

  snapshot(): ActiveTaskExecutionSnapshot[] {
    return [...this.active.values()]
      .sort((left, right) => left.started_at_ms - right.started_at_ms || left.command_id.localeCompare(right.command_id))
      .map((execution) => this.project(execution));
  }

  requestCancel(command_id: string, actor: string, requested_at_ms = Date.now()): TaskExecutionCancellationResult | null {
    const execution = this.active.get(command_id);
    if (!execution) return null;
    if (!actor || !Number.isSafeInteger(requested_at_ms) || requested_at_ms <= 0) {
      throw new Error("active_task_execution_cancel_context_invalid");
    }
    const alreadyRequested = execution.cancel_requested_at_ms !== null;
    if (!alreadyRequested) {
      execution.cancel_requested_at_ms = requested_at_ms;
      execution.cancel_requested_by = actor;
    }
    execution.controller.abort();
    return {
      ...this.project(execution),
      status: alreadyRequested ? "already_requested" : "cancel_requested",
      cancel_request_accepted: true,
      executor_settled: false,
    };
  }

  observeToolLifecycle(command_id: string, observation: ToolExecutionLifecycleObservation): void {
    const execution = this.active.get(command_id);
    if (!execution || observation.source !== "native_shell_process_provider" ||
        observation.observed_at_ms < execution.local_worker_observed_at_ms) return;
    execution.local_worker_observed_at_ms = observation.observed_at_ms;
    execution.local_worker_state = observation.state === "process_tree_empty_confirmed"
      ? "process_tree_empty_confirmed"
      : observation.state === "worker_exit_observed"
        ? "worker_exit_observed"
        : observation.state === "provider_state_unknown"
          ? "provider_state_unknown"
          : "not_observed";
  }

  markExecutorSettled(command_id: string, status: ExecuteFeedback["status"] | "unknown"): void {
    const execution = this.active.get(command_id);
    if (!execution) return;
    execution.executor_settled = true;
    execution.executor_status = status;
  }

  finish(command_id: string): FinishedTaskExecutionCancellation | null {
    const execution = this.active.get(command_id);
    if (!execution) return null;
    this.active.delete(command_id);
    if (!execution.cancel_requested_by) return null;
    return {
      command_id,
      cancel_requested_by: execution.cancel_requested_by,
      executor_settled: execution.executor_settled,
      executor_status: execution.executor_status,
      local_worker_stop: execution.local_worker_state,
      external_processing_stop: "unknown",
    };
  }

  abortAll(): void {
    for (const execution of this.active.values()) execution.controller.abort();
  }

  private project(execution: ActiveTaskExecution): ActiveTaskExecutionSnapshot {
    return {
      command_id: execution.command_id,
      started_at_ms: execution.started_at_ms,
      cancel_requested_at_ms: execution.cancel_requested_at_ms,
      execution_signal_aborted: execution.controller.signal.aborted,
      executor_state: execution.cancel_requested_at_ms === null ? "running" : "cancel_requested",
      local_worker_stop: execution.local_worker_state,
      external_processing_stop: "unknown",
      used_for_authority: false,
    };
  }
}
