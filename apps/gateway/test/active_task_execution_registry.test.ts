import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ActiveTaskExecutionRegistry } from "../src/active_task_execution_registry.js";

describe("ActiveTaskExecutionRegistry", () => {
  it("matches only executing commands from the exact D4 receipt and runtime/session scope", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const scope = { request_id: "e5348667-4150-49c6-b011-2b2942090f1a",
      runtime_ref_digest: "a".repeat(64), session_ref_digest: "b".repeat(64) };
    const target = new AbortController();
    const other = new AbortController();
    registry.register("scoped", target, 100, scope);
    registry.register("unrelated-session", other, 200, { ...scope, session_ref_digest: "c".repeat(64) });
    registry.register("internal-unscoped", new AbortController(), 300);

    expect(registry.d4RuntimeCommands(scope)).toEqual(["scoped"]);
    expect(registry.d4RuntimeCommands({ ...scope, runtime_ref_digest: "d".repeat(64) })).toEqual([]);
    expect(registry.d4RuntimeCommands({ ...scope, request_id: "748d3a75-eb9d-46c6-8892-e73cc6d15da4" })).toEqual([]);
    expect(registry.snapshot()[0]).not.toHaveProperty("d4_runtime");
    registry.markExecutorSettled("scoped", "success");
    expect(registry.d4RuntimeCommands(scope)).toEqual([]);
    expect(target.signal.aborted || other.signal.aborted).toBe(false);
  });

  it("retains the authenticated token kind for cancellation settlement evidence", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const controller = new AbortController();
    registry.register("command-d4", controller, 100);
    expect(registry.requestCancel("command-d4", "d4-runtime-adapter-token-holder", 200, "d4_runtime"))
      .toMatchObject({ status: "cancel_requested", executor_settled: false });
    expect(registry.finish("command-d4")).toMatchObject({
      cancel_requested_by: "d4-runtime-adapter-token-holder",
      token_kind: "d4_runtime",
      executor_settled: false,
    });
  });

  it("does not accept a cancellation after the executor has settled", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const controller = new AbortController();
    registry.register("command-settled", controller, 100);
    registry.markExecutorSettled("command-settled", "success");
    expect(registry.requestCancel("command-settled", "d4-runtime-adapter-token-holder", 200, "d4_runtime"))
      .toBeNull();
    expect(controller.signal.aborted).toBe(false);
  });

  it("binds cancellation to the exact active command and keeps stop claims distinct", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const target = new AbortController();
    const other = new AbortController();
    registry.register("command-target", target, 100);
    registry.register("command-other", other, 200);
    const workerInstanceId = "04ab3d71-ffad-40d3-8b93-29111fb52fe1";

    expect(registry.requestCancel("unknown-command", "owner", 300)).toBeNull();
    expect(target.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);

    registry.observeToolLifecycle("command-target", {
      schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
      source: "native_shell_process_provider",
      state: "worker_started",
      observed_at_ms: 350,
      worker_instance_id: workerInstanceId,
      used_for_authority: false,
      may_execute: false,
    });
    expect(registry.requestCancel("command-target", "webchat-resume-token-holder", 400)).toMatchObject({
      command_id: "command-target",
      status: "cancel_requested",
      cancel_request_accepted: true,
      cancel_requested_at_ms: 400,
      execution_signal_aborted: true,
      executor_state: "cancel_requested",
      executor_settled: false,
      local_worker_stop: "not_observed",
      external_processing_stop: "unknown",
      used_for_authority: false,
    });
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(registry.requestCancel("command-target", "webchat-resume-token-holder", 500)?.status)
      .toBe("already_requested");

    registry.observeToolLifecycle("command-target", {
      schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
      source: "native_shell_process_provider",
      state: "process_tree_empty_confirmed",
      observed_at_ms: 600,
      worker_instance_id: workerInstanceId,
      used_for_authority: false,
      may_execute: false,
    });
    registry.markExecutorSettled("command-target", "failed");
    expect(registry.snapshot()[0]).toMatchObject({
      command_id: "command-target",
      local_worker_stop: "process_tree_empty_confirmed",
      external_processing_stop: "unknown",
      used_for_authority: false,
    });
    expect(registry.finish("command-target")).toMatchObject({
      command_id: "command-target",
      cancel_requested_by: "webchat-resume-token-holder",
      executor_settled: true,
      executor_status: "failed",
      local_worker_stop: "process_tree_empty_confirmed",
      external_processing_stop: "unknown",
    });
    expect(registry.snapshot().map((execution) => execution.command_id)).toEqual(["command-other"]);
  });

  it("does not reuse a completed process tree as evidence for a later cancellation", () => {
    const registry = new ActiveTaskExecutionRegistry();
    registry.register("command-stale-worker", new AbortController(), 100);
    const workerInstanceId = "0b48417f-42d3-4b19-8a7e-4da98e251273";
    const observe = (state: "worker_started" | "process_tree_empty_confirmed", observed_at_ms: number) =>
      registry.observeToolLifecycle("command-stale-worker", {
        schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
        source: "native_shell_process_provider",
        state,
        observed_at_ms,
        worker_instance_id: workerInstanceId,
        used_for_authority: false,
        may_execute: false,
      });

    observe("worker_started", 200);
    observe("process_tree_empty_confirmed", 250);
    expect(registry.requestCancel("command-stale-worker", "webchat-resume-token-holder", 300))
      .toMatchObject({ local_worker_stop: "not_observed" });
    expect(registry.finish("command-stale-worker")).toMatchObject({ local_worker_stop: "not_observed" });
  });

  it("confirms a cancelled task's process trees only after every observed worker is empty", () => {
    const registry = new ActiveTaskExecutionRegistry();
    registry.register("command-multiple-workers", new AbortController(), 100);
    const firstWorker = "59471c50-d0a2-4212-bd8d-775b1032650a";
    const secondWorker = "9fb421b8-52b9-45ea-b529-5ce286288d5f";
    const observe = (workerInstanceId: string, state: "worker_started" | "worker_exit_observed" |
      "provider_state_unknown" | "process_tree_empty_confirmed", observed_at_ms: number) => registry.observeToolLifecycle("command-multiple-workers", {
      schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
      source: "native_shell_process_provider",
      state,
      observed_at_ms,
      worker_instance_id: workerInstanceId,
      used_for_authority: false,
      may_execute: false,
    });

    observe(firstWorker, "worker_started", 200);
    observe(secondWorker, "worker_started", 201);
    expect(registry.requestCancel("command-multiple-workers", "webchat-resume-token-holder", 300))
      .toMatchObject({ local_worker_stop: "not_observed" });
    observe(firstWorker, "process_tree_empty_confirmed", 400);
    expect(registry.snapshot()[0]).toMatchObject({ local_worker_stop: "not_observed" });
    observe(secondWorker, "worker_exit_observed", 500);
    expect(registry.snapshot()[0]).toMatchObject({ local_worker_stop: "worker_exit_observed" });
    observe(secondWorker, "provider_state_unknown", 550);
    expect(registry.snapshot()[0]).toMatchObject({ local_worker_stop: "provider_state_unknown" });
    observe(secondWorker, "worker_exit_observed", 560);
    expect(registry.snapshot()[0]).toMatchObject({ local_worker_stop: "provider_state_unknown" });
    observe(secondWorker, "process_tree_empty_confirmed", 600);
    expect(registry.snapshot()[0]).toMatchObject({ local_worker_stop: "process_tree_empty_confirmed" });
    expect(registry.finish("command-multiple-workers")).toMatchObject({
      local_worker_stop: "process_tree_empty_confirmed",
      external_processing_stop: "unknown",
    });
  });

  it("keeps process stop unknown when provider observations cannot be correlated", () => {
    const registry = new ActiveTaskExecutionRegistry();
    registry.register("command-unbound-worker", new AbortController(), 100);
    registry.observeToolLifecycle("command-unbound-worker", {
      schema_version: "blue-tanuki.tool-execution-lifecycle.v1",
      source: "native_shell_process_provider",
      state: "worker_started",
      observed_at_ms: 200,
      used_for_authority: false,
      may_execute: false,
    });
    expect(registry.requestCancel("command-unbound-worker", "webchat-resume-token-holder", 300))
      .toMatchObject({ local_worker_stop: "provider_state_unknown" });
  });

  it("projects correlated Agent child states without treating them as process-tree evidence", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const commandId = "command-agent-parent";
    const parentCommandDigest = createHash("sha256")
      .update("blue-tanuki.agent.parent-command.v1\0").update(commandId).digest("hex");
    const childTaskDigest = "a".repeat(64);
    const controller = new AbortController();
    registry.register(commandId, controller, 100);
    const observe = (state: "started" | "cancel_requested" | "residual_worker_observed", observed_at_ms: number) =>
      registry.observeAgentWorkerLifecycle({
        schema_version: "blue-tanuki.agent-worker-lifecycle.v1",
        parent_command_id: commandId,
        parent_command_digest: parentCommandDigest,
        child_task_digest: childTaskDigest,
        role: "audit",
        state,
        observed_at_ms,
        used_for_authority: false,
        may_execute: false,
      });

    observe("started", 200);
    registry.requestCancel(commandId, "webchat-resume-token-holder", 300);
    observe("cancel_requested", 301);
    observe("residual_worker_observed", 1_301);
    observe("started", 250);

    expect(controller.signal.aborted).toBe(true);
    expect(registry.snapshot()[0]).toMatchObject({
      command_id: commandId,
      executor_state: "cancel_requested",
      local_worker_stop: "not_observed",
      external_processing_stop: "unknown",
      agent_workers: [{
        child_task_digest: childTaskDigest,
        role: "audit",
        state: "residual_worker_observed",
        observed_at_ms: 1_301,
        used_for_authority: false,
        may_execute: false,
      }],
    });
  });

  it("keeps a settled parent visible while a child remains and closes it after a terminal child observation", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const commandId = "command-agent-residual";
    const parentCommandDigest = createHash("sha256")
      .update("blue-tanuki.agent.parent-command.v1\0").update(commandId).digest("hex");
    const childTaskDigest = "b".repeat(64);
    registry.register(commandId, new AbortController(), 100);
    const observe = (state: "started" | "cancel_requested" | "residual_worker_observed" | "late_result_discarded",
      observed_at_ms: number) => registry.observeAgentWorkerLifecycle({
      schema_version: "blue-tanuki.agent-worker-lifecycle.v1",
      parent_command_id: commandId,
      parent_command_digest: parentCommandDigest,
      child_task_digest: childTaskDigest,
      role: "audit",
      state,
      observed_at_ms,
      used_for_authority: false,
      may_execute: false,
    });

    observe("started", 200);
    registry.requestCancel(commandId, "webchat-resume-token-holder", 300);
    observe("cancel_requested", 301);
    registry.markExecutorSettled(commandId, "failed");
    expect(registry.finish(commandId)).toMatchObject({
      command_id: commandId,
      executor_settled: true,
      executor_status: "failed",
      external_processing_stop: "unknown",
    });
    expect(registry.finish(commandId)).toBeNull();
    expect(registry.requestCancel(commandId, "webchat-resume-token-holder", 400)).toBeNull();
    expect(registry.snapshot()[0]).toMatchObject({
      command_id: commandId,
      parent_execution_finished: true,
      executor_settled: true,
      executor_status: "failed",
      executor_state: "cancel_requested",
      agent_workers: [{ child_task_digest: childTaskDigest, state: "cancel_requested" }],
      external_processing_stop: "unknown",
    });

    observe("residual_worker_observed", 1_301);
    expect(registry.snapshot()[0]?.agent_workers[0]).toMatchObject({ state: "residual_worker_observed" });
    observe("late_result_discarded", 1_500);
    expect(registry.snapshot()).toEqual([]);
  });

  it("does not infer executor settlement when only parent finalization is observed", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const commandId = "command-agent-unknown-settlement";
    const parentCommandDigest = createHash("sha256")
      .update("blue-tanuki.agent.parent-command.v1\0").update(commandId).digest("hex");
    const childTaskDigest = "c".repeat(64);
    registry.register(commandId, new AbortController(), 100);
    const observe = (state: "started" | "late_result_discarded", observed_at_ms: number) =>
      registry.observeAgentWorkerLifecycle({
        schema_version: "blue-tanuki.agent-worker-lifecycle.v1",
        parent_command_id: commandId,
        parent_command_digest: parentCommandDigest,
        child_task_digest: childTaskDigest,
        role: "audit",
        state,
        observed_at_ms,
        used_for_authority: false,
        may_execute: false,
      });

    observe("started", 200);
    registry.requestCancel(commandId, "webchat-resume-token-holder", 300);
    const cancellation = registry.finish(commandId);
    expect(cancellation).toMatchObject({ executor_settled: false, executor_status: "unknown" });
    expect(registry.snapshot()[0]).toMatchObject({
      parent_execution_finished: true,
      executor_settled: false,
      executor_status: "unknown",
    });
    observe("late_result_discarded", 400);
    expect(registry.snapshot()).toEqual([]);
  });
});
