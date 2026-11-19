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
