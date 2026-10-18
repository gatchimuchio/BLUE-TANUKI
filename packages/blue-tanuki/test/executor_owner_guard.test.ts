import { describe, expect, it } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority, type ExecutorApprovalProof } from "../src/executor.js";
import type { ExecutionIntentStore, ExecutionIntentTicket, ExecutionIntentReceipt } from "../src/execution_intent.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry } from "../src/tools/registry.js";

const epoch = "12345678-1234-4234-8234-123456789abc";
function command(): Extract<ExecuteCommand, { type: "tool_call" }> {
  return {
    id: "owner-guard-command",
    type: "tool_call",
    payload: { tool_name: "synthetic.read", arguments: { value: "fixture" } },
    constraints: { allowed_tools: ["synthetic.read"], allowed_capabilities: ["fs:read"] },
    upstream_decision: { frame_goal: "合成owner lease拒否", model_abstraction: "fixture",
      commit_hash: "synthetic-owner-commit", commit_decision: "ASSERT" },
  };
}
const proof: ExecutorApprovalProof = {
  source: "approval_gate", decision: "allow", approved_by: "fixture-owner", approved_at_ms: 1,
  upstream_commit_hash: "synthetic-owner-commit", operation: "tool.file.read", risk: "low",
  final_review_required: false, reason: "synthetic owner lease fixture",
};

function intentStore(issued: ExecutionIntentTicket[], counters: { consumed: number; invoked: number; completed: number }): ExecutionIntentStore {
  return {
    issue(ticket) { issued.push({ ...ticket }); },
    consume() { counters.consumed++; },
    markInvocation() { counters.invoked++; },
    complete() { counters.completed++; },
    lookup(_ticket_id): ExecutionIntentReceipt | null { return null; },
  };
}

describe("Executor owner-generation fence", () => {
  it("uses the persisted epoch and blocks dispatch if the owner lease is lost after approval", async () => {
    const issued: ExecutionIntentTicket[] = [];
    const counters = { consumed: 0, invoked: 0, completed: 0 };
    let ownerChecks = 0;
    let toolCalls = 0;
    const approval = createExecutorApprovalAuthority({
      execution_store: intentStore(issued, counters),
      execution_epoch: epoch,
      assert_execution_owner: () => {
        ownerChecks++;
        if (ownerChecks >= 3) throw new Error("gateway_runtime_owner_lease_lost");
      },
    });
    const tools = new ToolRegistry();
    tools.register({ name: "synthetic.read", description: "synthetic owner guard", required_capabilities: ["fs:read"],
      async invoke() { toolCalls++; return { ok: true }; } });
    const executor = new Executor({ approval_authority: approval, tools, llm: new StubBackend() });
    const approved = approval.approve(command(), proof);
    expect(issued[0]?.execution_epoch).toBe(epoch);

    const feedback = await executor.execute(approved);
    expect(feedback.status).toBe("failed");
    expect(toolCalls).toBe(0);
    expect(counters.consumed).toBe(1);
    expect(counters.invoked).toBe(0);
    expect(counters.completed).toBe(0);
  });
});
