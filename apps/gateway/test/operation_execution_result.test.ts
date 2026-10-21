import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompleteHistoryStore,
  FailureMemoryStore,
  HDSUpperController,
  evaluateApproval,
  extractFailureSignatures,
} from "@blue-tanuki/hds-brain";
import { Executor, createExecutorApprovalAuthority, fileSearchTool, ToolRegistry } from "@blue-tanuki/core";
import { ExecuteFeedbackSchema, type ExecuteCommand } from "@blue-tanuki/protocol";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";
import {
  commandHistoryDescriptor, operationCoreResultHistoryProjection, projectOperationCoreExecutionHistory,
} from "../src/serve_projection.js";

const noCompute = { name: "not-used", call: async () => { throw new Error("C is not used in this work"); } };

function toolDecision(
  hds: HDSUpperController,
  args: Record<string, unknown> = { text: "blue" },
  request: { id?: string; channel?: string; user?: string } = {},
) {
  const tool = "root" in args ? "file.search" : "echo";
  const decision = hds.decide({ id: request.id ?? "result-request", channel: request.channel ?? "test", user: request.user ?? "fixture-owner",
    timestamp: Date.now(), content: `tool:${tool} ${JSON.stringify(args)}` });
  if (!decision.command || decision.command.type !== "tool_call") throw new Error("expected governed tool command");
  return { ...decision, command: decision.command };
}

function executor(tools: ToolRegistry, dispatcher?: ConstructorParameters<typeof Executor>[0]["dispatcher"]) {
  const authority = createExecutorApprovalAuthority();
  const instance = new Executor({ llm: noCompute, tools, approval_authority: authority, dispatcher });
  const approve = (command: ExecuteCommand) => {
    const evaluation = evaluateApproval(command, [], { actor: "fixture-owner", default_mode: "full_access" });
    return authority.approve(command, {
      source: evaluation.final_review_required ? "human_final_review" : "approval_gate",
      decision: evaluation.final_review_required ? "approve" : "allow",
      approved_by: "fixture-owner", approved_at_ms: Date.now(),
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: evaluation.context.operation, risk: evaluation.risk,
      final_review_required: evaluation.final_review_required, reason: "isolated fixture approval",
    });
  };
  return { instance, approve };
}

describe("実Executor結果から既存監査・履歴projectionへの接続", () => {
  it("実file.searchの結果をrequest/commandへ結び、raw内容を追加せず履歴に渡す", async () => {
    const root = await mkdtemp(join(tmpdir(), "blue-operation-result-"));
    const secret = "PRIVATE_SYNTHETIC_SEARCH_LINE";
    try {
      await writeFile(join(root, "blue.txt"), `${secret}\n`, "utf8");
      vi.stubEnv("BLUE_TANUKI_FILE_ROOT", root);
      const hds = new HDSUpperController();
      const { command, log } = toolDecision(hds, { root, query: secret });
      expect(command.upstream_decision.request_id).toBe(log.request_id);
      const tools = new ToolRegistry(); tools.register(fileSearchTool);
      const exec = executor(tools);
      const feedback = ExecuteFeedbackSchema.parse(await exec.instance.execute(exec.approve(command)));
      expect(feedback.status).toBe("success");
      expect((feedback.result as { matches: unknown[] }).matches).toHaveLength(1);
      expect(feedback.operation_core_result).toMatchObject({
        request_id: log.request_id, command_id: command.id, upstream_commit_hash: log.commit.hash,
        state: "succeeded", execution_boundary: "tool_adapter", action_outcome: "reported_success",
        plan_step_binding: "unbound", used_for_authority: false,
      });
      expect(JSON.stringify(feedback.operation_core_result)).not.toContain(secret);
      expect(JSON.stringify(feedback.operation_core_result)).not.toContain(root);

      finalizeCommandOutput({ hds, command, feedback, target_surface: "channel", request_id: log.request_id });
      const audit = hds.getAudit().list().find((entry) => "kind" in entry.log && entry.log.kind === "executor_feedback")!.log;
      if (!("kind" in audit) || audit.kind !== "executor_feedback") throw new Error("missing feedback audit");
      expect(audit.feedback.operation_result_contract_status).toBe("passed");
      expect(audit.feedback.operation_result_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(hds.getAudit().verify()).toBe(true);

      const history = new CompleteHistoryStore();
      const historyCommand = commandHistoryDescriptor(command);
      expect(JSON.stringify(historyCommand)).not.toContain(secret);
      expect(JSON.stringify(historyCommand)).not.toContain(root);
      expect(historyCommand).toHaveProperty("failure_patterns.version", "failure-conditioned-patterns-v1");
      history.append({ kind: "execution_history", request_id: log.request_id, command_id: command.id,
        actor: "fixture-owner", source: "executor", timestamp: Date.now(), payload: {
          command: historyCommand, origin_channel: "test", status: feedback.status,
          operation_core_result: operationCoreResultHistoryProjection(command, feedback),
        } });
      const projection = projectOperationCoreExecutionHistory(history.replay({ kind: "execution_history" }), {
        chain_valid: history.verify(), skipped_count: history.skippedCount(),
      });
      expect(projection.latest_results[0]?.command_execution_result).toEqual(feedback.operation_core_result);
      expect(JSON.stringify(projection)).not.toContain(secret);
      expect(JSON.stringify(projection)).not.toContain(root);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("connects digest-only complete-history failure observations to the next conditioned command gate", () => {
    const secretTarget = "PRIVATE_FAILURE_TARGET_SENTINEL";
    const secretGoal = "PRIVATE_FAILURE_GOAL_SENTINEL";
    const secretError = "PRIVATE_FAILURE_ERROR_SENTINEL";
    const command = toolDecision(new HDSUpperController(), { root: secretTarget, query: "blue" }).command;
    command.upstream_decision.frame_goal = secretGoal;
    const descriptor = commandHistoryDescriptor(command);
    const history = new CompleteHistoryStore();
    const failedEntry = history.append({
      kind: "execution_history",
      request_id: "failure-request",
      command_id: command.id,
      actor: "fixture-owner",
      source: "executor",
      timestamp: Date.now(),
      payload: {
        command: descriptor,
        origin_channel: "test",
        status: "failed",
        error: secretError,
      },
    });
    expect(failedEntry).not.toBeNull();
    const signatures = extractFailureSignatures({ kind: "complete_history", entry: failedEntry! });
    expect(signatures).toHaveLength(1);
    const serializedSignatures = JSON.stringify(signatures);
    for (const sentinel of [secretTarget, secretGoal, secretError, "blue"]) {
      expect(serializedSignatures).not.toContain(sentinel);
    }
    expect(signatures[0]?.result_pattern).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signatures[0]?.unknowns).toContain("predicted_difference_not_observed");

    const store = new FailureMemoryStore();
    const savedSignature = store.addSignature({
      ...signatures[0]!,
      state: "active",
      suppression_policy: "require_approval",
      severity: "high",
      confidence: 0.9,
      match_level: 1,
    });
    const retry = toolDecision(new HDSUpperController(), { root: secretTarget, query: "blue" }).command;
    retry.upstream_decision.frame_goal = secretGoal;
    const sameCondition = store.evaluateCommandGate(retry, {
      actor: "fixture-owner", channel: "test", request_id: "retry-request",
    });
    const changedContext = toolDecision(new HDSUpperController(), { root: secretTarget, query: "blue" }, {
      id: "changed-condition-request", channel: "webchat",
    }).command;
    expect(changedContext.upstream_decision.commit_decision).toBe("ASSERT");
    expect(changedContext.id).not.toBe(command.id);
    expect(changedContext.upstream_decision.request_id).not.toBe(command.upstream_decision.request_id);
    const changedConditions = store.evaluateCommandGate(changedContext, {
      actor: "fixture-owner", channel: "webchat", request_id: "changed-condition-request",
    });
    const otherTarget = toolDecision(new HDSUpperController(), { root: "different-target", query: "blue" }).command;
    const differentCondition = store.evaluateCommandGate(otherTarget, {
      actor: "fixture-owner", channel: "test", request_id: "other-request",
    });
    expect(sameCondition.decision).toBe("require_approval");
    expect(changedConditions.decision).toBe("require_approval");
    expect(changedConditions.condition_change_matches).toMatchObject([{
      signature_id: savedSignature.id,
      changed_conditions: ["goal", "channel"],
      decision: "require_approval",
    }]);
    expect(store.get(savedSignature.id)?.evidence_log_ids).toEqual(signatures[0]!.evidence_log_ids);
    expect(differentCondition.decision).toBe("allow");
    expect(differentCondition.condition_change_matches).toEqual([]);
  });

  it("能力拒否は未呼出し、呼出し後の失敗は作用結果不明として記録する", async () => {
    let invocations = 0;
    const tools = new ToolRegistry(); tools.register({ name: "echo", description: "isolated failure",
      required_capabilities: ["tool:echo"], invoke: async () => { invocations++; throw new Error("PRIVATE_FAILURE"); } });
    const hds = new HDSUpperController();
    const blocked = toolDecision(hds).command;
    blocked.constraints = { ...blocked.constraints, allowed_capabilities: [] };
    const exec = executor(tools);
    const notInvoked = await exec.instance.execute(exec.approve(blocked));
    expect(invocations).toBe(0);
    expect(notInvoked.operation_core_result).toMatchObject({ state: "failed", execution_boundary: "not_invoked", action_outcome: "not_attempted" });
    const invoked = await exec.instance.execute(exec.approve(toolDecision(new HDSUpperController()).command));
    expect(invocations).toBe(1);
    expect(invoked.operation_core_result).toMatchObject({ state: "failed", execution_boundary: "tool_adapter", action_outcome: "unknown" });
    expect(JSON.stringify(invoked.operation_core_result)).not.toContain("PRIVATE_FAILURE");
  });

  it("未承認commandに実行結果を発行しない", async () => {
    let invocations = 0;
    const tools = new ToolRegistry(); tools.register({ name: "echo", description: "isolated", invoke: async () => { invocations++; } });
    const { instance } = executor(tools);
    const command = toolDecision(new HDSUpperController()).command;
    const result = await instance.execute(command as Parameters<Executor["execute"]>[0]);
    expect(result.status).toBe("failed"); expect(invocations).toBe(0);
    expect(result.operation_core_result).toBeUndefined();
  });

  it("timeoutをworker停止や作用なしの証拠にしない", async () => {
    let finish: ((value: unknown) => void) | undefined;
    let invocations = 0;
    const tools = new ToolRegistry(); tools.register({ name: "echo", description: "held fixture worker",
      invoke: async () => { invocations++; return new Promise((resolve) => { finish = resolve; }); } });
    const command = toolDecision(new HDSUpperController()).command;
    command.constraints = { ...command.constraints, timeout_ms: 1 };
    const exec = executor(tools);
    const feedback = await exec.instance.execute(exec.approve(command));
    expect(feedback.operation_core_result).toMatchObject({ state: "failed", action_outcome: "unknown", execution_boundary: "tool_adapter" });
    expect(invocations).toBe(1);
    finish?.({ completed_after_timeout: true });
  });

  it("console fallbackは配送成功の証拠にしない", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const command: ExecuteCommand = { id: "channel-command", type: "channel_send",
        payload: { channel: "test", target: "synthetic", content: "blue" },
        upstream_decision: { frame_goal: "fixture", model_abstraction: "fixture", commit_decision: "ASSERT",
          request_id: "channel-request", commit_hash: "fixture-hash" } };
      const exec = executor(new ToolRegistry());
      const feedback = await exec.instance.execute(exec.approve(command));
      expect(feedback.operation_core_result).toMatchObject({ execution_boundary: "console_preview", action_outcome: "preview_only" });
      expect(operationCoreResultHistoryProjection(command, feedback)?.action_outcome).toBe("preview_only");
    } finally { spy.mockRestore(); }
  });

  it("異なるrequest/command/commit/stateや未知commandの結果はconsumerへ採用しない", async () => {
    const hds = new HDSUpperController(); const { command } = toolDecision(hds);
    const tools = new ToolRegistry(); tools.register({ name: "echo", description: "isolated", invoke: async () => ({ blue: true }) });
    const exec = executor(tools); const feedback = await exec.instance.execute(exec.approve(command));
    for (const change of [{ request_id: "other" }, { command_id: "other" }, { upstream_commit_hash: "other" }, { state: "failed" as const }]) {
      const changed = { ...feedback, operation_core_result: { ...feedback.operation_core_result!, ...change } };
      expect(operationCoreResultHistoryProjection(command, changed)).toBeUndefined();
    }
    expect(operationCoreResultHistoryProjection(command, { ...feedback,
      operation_core_result: { ...feedback.operation_core_result!, plan_id: "self-claimed" } as typeof feedback.operation_core_result,
    })).toBeUndefined();
    hds.onFeedback({ ...feedback, operation_core_result: { ...feedback.operation_core_result!, request_id: "other" } });
    hds.onFeedback(feedback); // 既に終端化したcommandは再び既知commandへ復活しない。
    const logs = hds.getAudit().list().map((entry) => entry.log).filter((log) => "kind" in log && log.kind === "executor_feedback");
    for (const log of logs) {
      if (!("kind" in log) || log.kind !== "executor_feedback") throw new Error("missing feedback audit");
      expect(log.feedback.operation_result_contract_status).toBe("failed");
      expect(log.feedback.operation_result_digest).toBeUndefined();
    }
  });
});
