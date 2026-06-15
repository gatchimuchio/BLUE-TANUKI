import { describe, it, expect } from "vitest";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority, type ChannelDispatcher } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry, echoTool } from "../src/tools/registry.js";

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
