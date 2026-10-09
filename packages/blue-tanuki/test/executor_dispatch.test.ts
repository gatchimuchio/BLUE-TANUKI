import { describe, it, expect } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority, type ChannelDispatcher } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import type { LLMBackend, LLMRequest, LLMResponse } from "../src/llm/base.js";
import { ToolRegistry, echoTool, type Tool } from "../src/tools/registry.js";

const stubUpstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "hash-123",
  commit_decision: "ASSERT" as const,
};

const executorApproval = createExecutorApprovalAuthority();

function channelSendCmd(channel: string, content = "hi"): ExecuteCommand {
  return {
    id: "cmd-cs-1",
    type: "channel_send",
    payload: { channel, target: "u1", content },
    upstream_decision: stubUpstream,
  };
}

function toolCmd(
  constraints?: ExecuteCommand["constraints"],
): ExecuteCommand {
  return {
    id: "cmd-tool-1",
    type: "tool_call",
    payload: { tool_name: "echo", arguments: { text: "hi" } },
    ...(constraints ? { constraints } : {}),
    upstream_decision: stubUpstream,
  };
}

function shellExecCmd(): ExecuteCommand {
  return {
    id: "cmd-shell-1",
    type: "tool_call",
    payload: { tool_name: "shell.exec", arguments: { cmd: "pwd", args: [] } },
    constraints: {
      allowed_tools: ["shell.exec"],
      allowed_capabilities: ["tool:shell.exec", "shell:exec"],
    },
    upstream_decision: stubUpstream,
  };
}

function llmCallCmd(): ExecuteCommand {
  return {
    id: "cmd-llm-c07-01",
    type: "llm_call",
    payload: { messages: [{ role: "user", content: "review this synthetic input" }] },
    upstream_decision: stubUpstream,
  };
}

function approved(command: ExecuteCommand, risk: "low" | "medium" | "high" = "low") {
  return executorApproval.approve(command, {
    source: risk === "high" ? "human_final_review" : "approval_gate",
    decision: risk === "high" ? "approve" : "allow",
    approved_by: "test-owner",
    approved_at_ms: 1,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: command.type === "tool_call" ? `tool.${command.payload.tool_name}` : command.type,
    risk,
    final_review_required: risk === "high",
    reason: "test approval",
  });
}

describe("Executor.executeChannelSend — dispatcher path", () => {
  it("routes channel_send through dispatcher when provided", async () => {
    const calls: Array<{ channel: string; meta_hash: string }> = [];
    const dispatcher: ChannelDispatcher = {
      async dispatch(payload, meta) {
        calls.push({ channel: payload.channel, meta_hash: meta.upstream_commit_hash });
        return { delivered: true, external_id: "ext-1" };
      },
    };
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools: new ToolRegistry(),
      dispatcher,
    });
    const fb = await exec.execute(approved(channelSendCmd("webchat"), "medium"));
    expect(fb.status).toBe("success");
    expect(calls).toEqual([{ channel: "webchat", meta_hash: "hash-123" }]);
    const result = fb.result as { sent: boolean; external_id: string };
    expect(result.sent).toBe(true);
    expect(result.external_id).toBe("ext-1");
  });

  it("returns failed when dispatcher reports undelivered", async () => {
    const dispatcher: ChannelDispatcher = {
      async dispatch() {
        return {
          delivered: false,
          error: "no_channel_registered:slack",
          error_kind: "non_recoverable",
          error_code: "no_channel_registered",
          next_action: "Register Slack before retrying.",
        };
      },
    };
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools: new ToolRegistry(),
      dispatcher,
    });
    const fb = await exec.execute(approved(channelSendCmd("slack"), "medium"));
    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/no_channel_registered:slack/);
    expect(fb.result).toMatchObject({
      sent: false,
      channel: "slack",
      error_kind: "non_recoverable",
      error_code: "no_channel_registered",
      next_action: "Register Slack before retrying.",
    });
  });

  it("falls back to console.log when no dispatcher (backward compat)", async () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const exec = new Executor({
        approval_authority: executorApproval,
        llm: new StubBackend(),
        tools: new ToolRegistry(),
      });
      const fb = await exec.execute(approved(channelSendCmd("legacy"), "medium"));
      expect(fb.status).toBe("success");
      expect(lines.some((l) => l.includes("[channel:legacy]"))).toBe(true);
    } finally {
      console.log = original;
    }
  });
});

describe("Executor.executeToolCall - permission envelope", () => {
  it("fails closed when a tool capability is not explicitly allowed", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools,
    });

    const fb = await exec.execute(approved(toolCmd({ allowed_tools: ["echo"] })));

    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/capability not allowed/i);
    expect(fb.error).toContain("tool:echo");
  });

  it("runs a tool when name and required capabilities are allowed", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools,
    });

    const fb = await exec.execute(
      approved(toolCmd({
        allowed_tools: ["echo"],
        allowed_capabilities: ["tool:echo"],
      })),
    );

    expect(fb.status).toBe("success");
    expect(fb.metrics.tool_calls).toBe(1);
    expect(fb.result).toEqual({ echoed: { text: "hi" } });
    expect(fb.operation_core).toMatchObject({
      role: "execution_adapter_trace",
      adapter: "internal_runtime",
      runtime_boundary: "internal_runtime_adapter",
      adapter_is_authority: false,
      adapter_result_used_for_authority: false,
      executor_trace_used_for_authority: false,
      permission: {
        risk: "low",
        approval_level: "L1_observe",
        hds_brain_authority_required: true,
      },
    });
  });

  it("still rejects tools outside allowed_tools before capability checks", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools,
    });

    const fb = await exec.execute(
      approved(toolCmd({
        allowed_tools: ["different"],
        allowed_capabilities: ["tool:echo"],
      })),
    );

    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/not in allowed_tools/);
  });

  it("aborts cooperative tools when executor timeout fires", async () => {
    let signalSeen = false;
    let aborted = false;
    const slowTool: Tool = {
      name: "slow",
      description: "never completes unless aborted",
      required_capabilities: ["tool:slow"],
      async invoke(_args, ctx) {
        signalSeen = ctx.signal instanceof AbortSignal;
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return { aborted };
      },
    };
    const tools = new ToolRegistry();
    tools.register(slowTool);
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools,
    });
    const command: ExecuteCommand = {
      id: "cmd-slow-timeout",
      type: "tool_call",
      payload: { tool_name: "slow", arguments: {} },
      constraints: {
        allowed_tools: ["slow"],
        allowed_capabilities: ["tool:slow"],
        timeout_ms: 10,
      },
      upstream_decision: stubUpstream,
    };

    const fb = await exec.execute(approved(command));

    expect(signalSeen).toBe(true);
    expect(aborted).toBe(true);
    expect(fb.status).toBe("failed");
    expect(fb.error).toContain("timeout after 10ms");
  });

  it("fails closed when raw ExecuteCommand is passed without an approval proof", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools,
    });

    const fb = await exec.execute(toolCmd({
      allowed_tools: ["echo"],
      allowed_capabilities: ["tool:echo"],
    }) as never);

    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/ApprovedCommand proof is required/);
  });

  it("fails closed when approval proof was minted by a different authority", async () => {
    const otherApproval = createExecutorApprovalAuthority();
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools: new ToolRegistry(),
    });
    const command = channelSendCmd("legacy-authority-mismatch");
    const foreignApproved = otherApproval.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "test-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: "channel_send",
      risk: "medium",
      final_review_required: false,
      reason: "foreign authority",
    });

    const fb = await exec.execute(foreignApproved);

    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/approval authority mismatch/);
  });

  it("rejects approval proof with a forged upstream commit hash before execution branding", () => {
    const command = channelSendCmd("legacy-commit-mismatch");

    expect(() =>
      executorApproval.approve(command, {
        source: "approval_gate",
        decision: "allow",
        approved_by: "test-owner",
        approved_at_ms: 1,
        upstream_commit_hash: "forged-hash",
        operation: "channel_send",
        risk: "medium",
        final_review_required: false,
        reason: "forged commit hash",
      }),
    ).toThrow(/commit hash does not match/);
  });

  it("re-verifies human final-review proof for high-risk tools", async () => {
    const exec = new Executor({
      approval_authority: executorApproval,
      llm: new StubBackend(),
      tools: new ToolRegistry(),
    });
    const command = shellExecCmd();
    const brandedButNotHumanReviewed = executorApproval.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: "test-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: "tool.shell.exec",
      risk: "high",
      final_review_required: true,
      reason: "bad test approval",
    });

    const fb = await exec.execute(brandedButNotHumanReviewed);

    expect(fb.status).toBe("failed");
    expect(fb.error).toMatch(/human final-review proof is required/);
  });
});

describe("Executor meaning-update proposal transport", () => {
  it("forwards an untrusted structured proposal to HDS while removing it from the visible result", async () => {
    const proposal = {
      schema_version: "blue-tanuki.meaning-update-proposal.v1",
      record_type: "meaning_update_proposal",
      proposal_ref: "proposal-executor-001",
      candidate_ref: "candidate:executor-001",
      candidate_digest: "c".repeat(64),
      target_ref: "memory:fact-001",
      prior_version_ref: "version:4",
      supporting_evidence: [{ reference: "evidence:support-001", digest: "d".repeat(64) }],
      counterevidence_review: {
        status: "reviewed_none_found",
        review_scope: { reference: "scope:counterevidence-001", digest: "e".repeat(64) },
        references: [],
      },
      applicability_scope: { reference: "scope:applicability-001", digest: "1".repeat(64) },
      reflection_target_ref: "reflection:goal-001",
      proposal_status: "unverified",
      adoption_status: "not_adopted",
      may_apply: false,
      used_for_authority: false,
    };
    const llm: LLMBackend = {
      name: "proposal-fixture",
      async call(_request: LLMRequest): Promise<LLMResponse> {
        return {
          content: "synthetic answer",
          tokens_used: 1,
          model: "fixture-model",
          meaning_update_proposal: proposal,
        };
      },
    };
    const exec = new Executor({
      approval_authority: executorApproval,
      llm,
      tools: new ToolRegistry(),
    });

    const feedback = await exec.execute(approved(llmCallCmd()));
    expect(feedback.status).toBe("success");
    expect(feedback.meaning_update_proposal).toEqual(proposal);
    expect(feedback.result).toMatchObject({ content: "synthetic answer" });
    expect(feedback.result).not.toHaveProperty("meaning_update_proposal");
    expect(JSON.stringify(feedback.result)).not.toContain("candidate:executor-001");
  });
});
