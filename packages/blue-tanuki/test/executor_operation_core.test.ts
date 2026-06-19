import { describe, expect, it } from "vitest";
import type { ExecuteCommand, OperationPlan } from "@blue-tanuki/protocol";
import {
  Executor,
  createExecutorApprovalAuthority,
} from "../src/executor.js";
import { MemorySessionStore } from "../src/sessions/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LLMBackend, LLMRequest, LLMResponse } from "../src/llm/base.js";

const stubUpstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "operation-core-hash",
  commit_decision: "ASSERT" as const,
};

const executorApproval = createExecutorApprovalAuthority();

function llmCmd(content: string, session_id?: string): ExecuteCommand {
  return {
    id: `cmd-${content}`,
    type: "llm_call",
    payload: {
      messages: [{ role: "user", content }],
      ...(session_id ? { session_id } : {}),
    },
    upstream_decision: stubUpstream,
  };
}

function approved(command: ExecuteCommand) {
  return executorApproval.approve(command, {
    source: "approval_gate",
    decision: "allow",
    approved_by: "test-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: "llm.call",
    risk: "low",
    final_review_required: false,
    reason: "test approval",
  });
}

class FixedBackend implements LLMBackend {
  readonly name = "fixed";
  constructor(private readonly response: string) {}

  async call(_req: LLMRequest): Promise<LLMResponse> {
    return {
      content: this.response,
      tokens_used: 1,
      model: "fixed",
    };
  }
}

function operationPlan(): OperationPlan {
  return {
    version: "operation-core.v1",
    plan_id: "plan-1",
    request_id: "operation-request:req-1",
    state: "planned",
    steps: [
      {
        step_id: "step-1",
        operation: "draft_text",
        target: {
          kind: "runtime",
          id: "operator:writing",
          scope: "operator_surface",
        },
        state: "planned",
        effects: ["write"],
        permission: {
          risk: "medium",
          approval_level: "L2_operate",
          final_review_required: false,
          hds_brain_authority_required: true,
          approval_gate_required: true,
        },
        adapter: "internal_runtime",
        adapter_is_authority: false,
        command_generated_by_adapter_only: false,
      },
    ],
    rollback: {
      available: false,
    },
    raw_command_policy: {
      raw_command_is_core_operation: false,
      command_generation_location: "not_applicable",
    },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  };
}

describe("Executor Operation Core planner output boundary", () => {
  it("attaches valid OperationPlan output as non-authority evidence", async () => {
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new FixedBackend(JSON.stringify(operationPlan())),
      tools: new ToolRegistry(),
    });

    const feedback = await exec.execute(approved(llmCmd("plan this")));
    const result = feedback.result as {
      operation_core?: {
        status: string;
        planner_output_used_for_authority: boolean;
        hds_brain_authority_required: boolean;
        plan?: OperationPlan;
      };
    };

    expect(feedback.status).toBe("success");
    expect(result.operation_core).toMatchObject({
      role: "planner_output",
      status: "valid_plan",
      planner_output_used_for_authority: false,
      hds_brain_authority_required: true,
      plan: {
        plan_id: "plan-1",
        raw_command_policy: {
          raw_command_is_core_operation: false,
        },
      },
    });
  });

  it("fails closed when LLM planner output contains raw command keys", async () => {
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new FixedBackend(JSON.stringify({ cmd: "npm", args: ["install"] })),
      tools: new ToolRegistry(),
    });

    const feedback = await exec.execute(approved(llmCmd("install dependencies")));
    const result = feedback.result as {
      operation_core?: { status: string; planner_output_used_for_authority: boolean };
    };

    expect(feedback.status).toBe("failed");
    expect(feedback.error).toContain("Operation Core planner output rejected");
    expect(feedback.error).toContain("raw command field");
    expect(result.operation_core).toMatchObject({
      status: "rejected",
      planner_output_used_for_authority: false,
    });
  });

  it("fails closed when Operation Core planner JSON does not match OperationPlanSchema", async () => {
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new FixedBackend(JSON.stringify({
        version: "operation-core.v1",
        plan_id: "bad-plan",
        steps: [],
      })),
      tools: new ToolRegistry(),
    });

    const feedback = await exec.execute(approved(llmCmd("plan badly")));

    expect(feedback.status).toBe("failed");
    expect(feedback.error).toContain("OperationPlanSchema rejected");
  });

  it("does not append rejected planner output to session history", async () => {
    const store = new MemorySessionStore();
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new FixedBackend(JSON.stringify({ command: "git status" })),
      tools: new ToolRegistry(),
      session_store: store,
    });

    const feedback = await exec.execute(approved(llmCmd("status", "webchat:owner")));

    expect(feedback.status).toBe("failed");
    expect(await store.getMessages("webchat:owner")).toEqual([]);
  });
});
