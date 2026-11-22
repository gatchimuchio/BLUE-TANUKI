import { createHash } from "node:crypto";
import type { AgentWorkerLifecycleEvent, ToolExecutionLifecycleObservation } from "@blue-tanuki/core";
import type { ExecuteFeedback } from "@blue-tanuki/protocol";

export type LocalWorkerStopObservation =
  | "not_observed"
  | "worker_exit_observed"
  | "process_tree_empty_confirmed"
  | "provider_state_unknown";

type LocalWorkerLifecycleState = "running" | Exclude<LocalWorkerStopObservation, "not_observed">;

interface LocalWorkerLifecycleSnapshot {
  state: LocalWorkerLifecycleState;
  observed_at_ms: number;
}

export type TaskExecutionCancellationTokenKind = "resume" | "d4_runtime" | "owner_task";

export interface ActiveAgentWorkerSnapshot {
  child_task_digest: string;
  role: AgentWorkerLifecycleEvent["role"];
  state: AgentWorkerLifecycleEvent["state"];
  observed_at_ms: number;
  used_for_authority: false;
  may_execute: false;
}

export interface D4RuntimeExecutionBinding {
  readonly request_id: string;
  readonly runtime_ref_digest: string;
  readonly session_ref_digest: string;
}

export interface ActiveTaskExecutionSnapshot {
  command_id: string;
  started_at_ms: number;
  cancel_requested_at_ms: number | null;
  execution_signal_aborted: boolean;
  executor_state: "running" | "cancel_requested";
  parent_execution_finished: boolean;
  executor_settled: boolean;
  executor_status: ExecuteFeedback["status"] | "unknown";
  local_worker_stop: LocalWorkerStopObservation;
  agent_workers: readonly ActiveAgentWorkerSnapshot[];
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
  token_kind: TaskExecutionCancellationTokenKind;
  cancel_requested_at_ms: number;
  executor_settled: boolean;
  executor_status: ExecuteFeedback["status"] | "unknown";
  local_worker_stop: LocalWorkerStopObservation;
  external_processing_stop: "unknown";
}

interface ActiveTaskExecution {
  command_id: string;
  d4_runtime?: D4RuntimeExecutionBinding;
  controller: AbortController;
  started_at_ms: number;
  cancel_requested_at_ms: number | null;
  cancel_requested_by: string | null;
  cancel_token_kind: TaskExecutionCancellationTokenKind | null;
  executor_settled: boolean;
  executor_status: ExecuteFeedback["status"] | "unknown";
  parent_execution_finished: boolean;
  cancellation_settlement_recorded: boolean;
  local_workers: Map<string, LocalWorkerLifecycleSnapshot>;
  cancellation_worker_instances: Set<string> | null;
  cancellation_worker_seen: boolean;
  cancellation_worker_unknown: boolean;
  local_worker_unbound_active: boolean;
  local_worker_state: LocalWorkerStopObservation;
  agent_workers: Map<string, ActiveAgentWorkerSnapshot>;
}

/** Owns the command-id to AbortController binding used by task cancellation. */
export class ActiveTaskExecutionRegistry {
  private readonly active = new Map<string, ActiveTaskExecution>();

  register(
    command_id: string, controller: AbortController, started_at_ms = Date.now(), d4_runtime?: D4RuntimeExecutionBinding,
  ): void {
    if (!command_id || command_id.length > 200 || !Number.isSafeInteger(started_at_ms) || started_at_ms <= 0) {
      throw new Error("active_task_execution_identity_invalid");
    }
    if (d4_runtime && (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(d4_runtime.request_id) ||
        !/^[0-9a-f]{64}$/u.test(d4_runtime.runtime_ref_digest) || !/^[0-9a-f]{64}$/u.test(d4_runtime.session_ref_digest))) {
      throw new Error("active_task_execution_runtime_binding_invalid");
    }
    if (this.active.has(command_id)) throw new Error("active_task_execution_identity_conflict");
    this.active.set(command_id, {
      command_id,
      ...(d4_runtime ? { d4_runtime: { ...d4_runtime } } : {}),
      controller,
      started_at_ms,
      cancel_requested_at_ms: null,
      cancel_requested_by: null,
      cancel_token_kind: null,
      executor_settled: false,
      executor_status: "unknown",
      parent_execution_finished: false,
      cancellation_settlement_recorded: false,
      local_workers: new Map(),
      cancellation_worker_instances: null,
      cancellation_worker_seen: false,
      cancellation_worker_unknown: false,
      local_worker_unbound_active: false,
      local_worker_state: "not_observed",
      agent_workers: new Map(),
    });
  }

  d4RuntimeCommands(binding: D4RuntimeExecutionBinding): string[] {
    return [...this.active.values()].flatMap((execution) => {
      const scope = execution.d4_runtime;
      return scope && !execution.executor_settled && scope.request_id === binding.request_id &&
        scope.runtime_ref_digest === binding.runtime_ref_digest && scope.session_ref_digest === binding.session_ref_digest
        ? [execution.command_id] : [];
    });
  }

  snapshot(): ActiveTaskExecutionSnapshot[] {
    return [...this.active.values()]
      .sort((left, right) => left.started_at_ms - right.started_at_ms || left.command_id.localeCompare(right.command_id))
      .map((execution) => this.project(execution));
  }

  requestCancel(
    command_id: string,
    actor: string,
    requested_at_ms = Date.now(),
    token_kind: TaskExecutionCancellationTokenKind = "resume",
  ): TaskExecutionCancellationResult | null {
    const execution = this.active.get(command_id);
    if (!execution || execution.executor_settled || execution.parent_execution_finished) return null;
    if (!actor || !Number.isSafeInteger(requested_at_ms) || requested_at_ms <= 0) {
      throw new Error("active_task_execution_cancel_context_invalid");
    }
    const alreadyRequested = execution.cancel_requested_at_ms !== null;
    if (!alreadyRequested) {
      execution.cancel_requested_at_ms = requested_at_ms;
      execution.cancel_requested_by = actor;
      execution.cancel_token_kind = token_kind;
      execution.cancellation_worker_instances = new Set(
        [...execution.local_workers.entries()]
          .filter(([, worker]) => worker.state !== "process_tree_empty_confirmed")
          .map(([workerInstanceId]) => workerInstanceId),
      );
      execution.cancellation_worker_seen = execution.cancellation_worker_instances.size > 0;
      execution.cancellation_worker_unknown = execution.local_worker_unbound_active;
      this.refreshLocalWorkerStop(execution);
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
        !Number.isSafeInteger(observation.observed_at_ms) || observation.observed_at_ms <= 0) return;
    const workerInstanceId = observation.worker_instance_id;
    if (!isWorkerInstanceId(workerInstanceId)) {
      if (["worker_started", "cancel_requested", "worker_exit_observed", "provider_state_unknown"]
        .includes(observation.state)) {
        execution.local_worker_unbound_active = true;
        if (execution.cancel_requested_at_ms !== null) execution.cancellation_worker_unknown = true;
      }
      if (observation.state === "process_tree_empty_confirmed" && execution.cancel_requested_at_ms !== null) {
        execution.cancellation_worker_unknown = true;
      }
      this.refreshLocalWorkerStop(execution);
      return;
    }

    const current = execution.local_workers.get(workerInstanceId);
    if (current && observation.observed_at_ms < current.observed_at_ms) return;
    switch (observation.state) {
      case "worker_started":
        if (!current) {
          execution.local_workers.set(workerInstanceId, {
            state: "running", observed_at_ms: observation.observed_at_ms,
          });
          this.includeCancellationWorker(execution, workerInstanceId);
        }
        break;
      case "cancel_requested":
        if (current?.state !== "process_tree_empty_confirmed") {
          execution.local_workers.set(workerInstanceId, {
            state: current?.state === "provider_state_unknown" ? "provider_state_unknown" : "running",
            observed_at_ms: observation.observed_at_ms,
          });
          this.includeCancellationWorker(execution, workerInstanceId);
        }
        break;
      case "worker_exit_observed":
        if (current?.state !== "process_tree_empty_confirmed") {
          execution.local_workers.set(workerInstanceId, {
            state: current?.state === "provider_state_unknown" ? "provider_state_unknown" : "worker_exit_observed",
            observed_at_ms: observation.observed_at_ms,
          });
          this.includeCancellationWorker(execution, workerInstanceId);
        }
        break;
      case "provider_state_unknown":
        if (current?.state !== "process_tree_empty_confirmed") {
          execution.local_workers.set(workerInstanceId, {
            state: "provider_state_unknown", observed_at_ms: observation.observed_at_ms,
          });
          this.includeCancellationWorker(execution, workerInstanceId);
        }
        break;
      case "process_tree_empty_confirmed":
        execution.local_workers.set(workerInstanceId, {
          state: "process_tree_empty_confirmed", observed_at_ms: observation.observed_at_ms,
        });
        if (execution.cancellation_worker_instances?.has(workerInstanceId)) {
          execution.cancellation_worker_instances.delete(workerInstanceId);
          execution.cancellation_worker_seen = true;
        }
        break;
      case "late_result_discarded":
        break;
    }
    this.refreshLocalWorkerStop(execution);
  }

  observeAgentWorkerLifecycle(event: AgentWorkerLifecycleEvent): void {
    const execution = this.active.get(event.parent_command_id);
    if (!execution || (event.schema_version !== "blue-tanuki.agent-worker-lifecycle.v1" &&
        event.schema_version !== "blue-tanuki.agent-worker-lifecycle.v2") ||
        event.used_for_authority !== false || event.may_execute !== false ||
        event.parent_command_digest !== createHash("sha256")
          .update("blue-tanuki.agent.parent-command.v1\0").update(event.parent_command_id).digest("hex") ||
        !/^[a-f0-9]{64}$/u.test(event.child_task_digest) ||
        !Number.isSafeInteger(event.observed_at_ms) || event.observed_at_ms <= 0 ||
        !["division", "independent_comparison", "audit", "redundancy"].includes(event.role) ||
        !["started", "cancel_requested", "cancelled_before_dispatch", "settled", "settled_after_abort",
          "late_result_discarded", "residual_worker_observed"].includes(event.state)) return;
    const current = execution.agent_workers.get(event.child_task_digest);
    if (current && (event.observed_at_ms < current.observed_at_ms || current.role !== event.role)) return;
    execution.agent_workers.set(event.child_task_digest, {
      child_task_digest: event.child_task_digest,
      role: event.role,
      state: event.state,
      observed_at_ms: event.observed_at_ms,
      used_for_authority: false,
      may_execute: false,
    });
    if (execution.parent_execution_finished && !hasPendingAgentWorker(execution)) {
      this.active.delete(event.parent_command_id);
    }
  }

  markExecutorSettled(command_id: string, status: ExecuteFeedback["status"] | "unknown"): void {
    const execution = this.active.get(command_id);
    if (!execution) return;
    execution.executor_settled = true;
    execution.executor_status = status;
    if (execution.parent_execution_finished && !hasPendingAgentWorker(execution)) this.active.delete(command_id);
  }

  finish(command_id: string): FinishedTaskExecutionCancellation | null {
    const execution = this.active.get(command_id);
    if (!execution) return null;
    execution.parent_execution_finished = true;
    if (!hasPendingAgentWorker(execution)) this.active.delete(command_id);
    if (!execution.cancel_requested_by || execution.cancel_requested_at_ms === null ||
        execution.cancellation_settlement_recorded) return null;
    execution.cancellation_settlement_recorded = true;
    return {
      command_id,
      cancel_requested_by: execution.cancel_requested_by,
      token_kind: execution.cancel_token_kind ?? "resume",
      cancel_requested_at_ms: execution.cancel_requested_at_ms,
      executor_settled: execution.executor_settled,
      executor_status: execution.executor_status,
      local_worker_stop: execution.cancel_requested_at_ms === null ? "not_observed" : execution.local_worker_state,
      external_processing_stop: "unknown",
    };
  }

  abortAll(): void {
    for (const execution of this.active.values()) execution.controller.abort();
  }

  private includeCancellationWorker(execution: ActiveTaskExecution, workerInstanceId: string): void {
    if (execution.cancel_requested_at_ms === null) return;
    execution.cancellation_worker_instances ??= new Set();
    execution.cancellation_worker_instances.add(workerInstanceId);
    execution.cancellation_worker_seen = true;
  }

  private refreshLocalWorkerStop(execution: ActiveTaskExecution): void {
    if (execution.cancel_requested_at_ms === null || execution.cancellation_worker_instances === null) return;
    const pending = [...execution.cancellation_worker_instances]
      .map((workerInstanceId) => execution.local_workers.get(workerInstanceId)?.state ?? "running");
    if (execution.cancellation_worker_unknown || pending.includes("provider_state_unknown")) {
      execution.local_worker_state = "provider_state_unknown";
    } else if (pending.includes("worker_exit_observed")) {
      execution.local_worker_state = "worker_exit_observed";
    } else if (pending.length > 0) {
      execution.local_worker_state = "not_observed";
    } else {
      execution.local_worker_state = execution.cancellation_worker_seen
        ? "process_tree_empty_confirmed"
        : "not_observed";
    }
  }

  private project(execution: ActiveTaskExecution): ActiveTaskExecutionSnapshot {
    return {
      command_id: execution.command_id,
      started_at_ms: execution.started_at_ms,
      cancel_requested_at_ms: execution.cancel_requested_at_ms,
      execution_signal_aborted: execution.controller.signal.aborted,
      executor_state: execution.cancel_requested_at_ms === null ? "running" : "cancel_requested",
      parent_execution_finished: execution.parent_execution_finished,
      executor_settled: execution.executor_settled,
      executor_status: execution.executor_status,
      local_worker_stop: execution.cancel_requested_at_ms === null ? "not_observed" : execution.local_worker_state,
      agent_workers: [...execution.agent_workers.values()]
        .sort((left, right) => left.role.localeCompare(right.role) || left.child_task_digest.localeCompare(right.child_task_digest))
        .map((worker) => ({ ...worker })),
      external_processing_stop: "unknown",
      used_for_authority: false,
    };
  }
}

function isWorkerInstanceId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function hasPendingAgentWorker(execution: ActiveTaskExecution): boolean {
  return [...execution.agent_workers.values()].some((worker) =>
    !["cancelled_before_dispatch", "settled", "settled_after_abort", "late_result_discarded"].includes(worker.state));
}
