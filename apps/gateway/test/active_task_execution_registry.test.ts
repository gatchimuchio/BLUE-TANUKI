import { describe, expect, it } from "vitest";
import { ActiveTaskExecutionRegistry } from "../src/active_task_execution_registry.js";

describe("ActiveTaskExecutionRegistry", () => {
  it("binds cancellation to the exact active command and keeps stop claims distinct", () => {
    const registry = new ActiveTaskExecutionRegistry();
    const target = new AbortController();
    const other = new AbortController();
    registry.register("command-target", target, 100);
    registry.register("command-other", other, 200);

    expect(registry.requestCancel("unknown-command", "owner", 300)).toBeNull();
    expect(target.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);

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
});
