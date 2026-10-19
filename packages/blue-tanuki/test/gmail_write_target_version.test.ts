import { describe, expect, it, vi } from "vitest";
import { approvalContextFromCommand, finalReviewRequired, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { GmailWriteTargetVersionObservationSchema, type ExecuteCommand } from "@blue-tanuki/protocol";
import { Executor, createExecutorApprovalAuthority, executorCommandDigest } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createGmailWriteTool, type GoogleWriteResponse, type GoogleWriteTarget } from "../src/tools/google_write.js";

const args = {
  operation: "message.send",
  to: "inspection@example.invalid",
  subject: "Synthetic fixture",
  body_text: "This message must not leave the test process.",
};

const response: GoogleWriteResponse = {
  status: 200,
  ok: true,
  content_type: "application/json",
  body: JSON.stringify({ id: "fixture-message" }),
  truncated: false,
  request_id: "fixture-request",
};

describe("Gmail write target observation", () => {
  it("credentialを読まずexact plan sourceと送信payloadのdigestを作り、同じpayloadだけstubへ渡す", async () => {
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(args, {
      command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64),
    }));

    expect(observation).toMatchObject({ schema_version: "blue-tanuki.gmail-write-target-version.v1",
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
      used_for_authority: false, may_execute: false });
    expect(observation).not.toHaveProperty("to");
    expect(observation).not.toHaveProperty("subject");
    expect(observation).not.toHaveProperty("body_text");

    const result = await tool.invoke(args, {
      command_id: "fixture-command",
      upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64),
      target_version_observation: observation,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ service: "gmail", operation: "message.send", mutation_sent: true });
  });

  it("本文・宛先の変更や観測欠落は資格情報確認・request送信より前に拒否する", async () => {
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(args, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    const context = { command_id: "fixture-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64),
      target_version_observation: observation };

    await expect(tool.invoke({ ...args, body_text: "changed" }, context)).rejects.toThrow(/target version changed.*request_sent=false/);
    await expect(tool.invoke(args, { ...context, target_version_observation: undefined })).rejects
      .toThrow(/target version evidence is required.*request_sent=false/);
    expect(request).not.toHaveBeenCalled();
  });

  it("標準Executor dispatchはticket内の観測をGmail adapterへ渡してからstub transportを呼ぶ", async () => {
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const tools = new ToolRegistry();
    tools.register(tool);
    const command: ExecuteCommand = {
      id: "fixture-gmail-dispatch-command",
      type: "tool_call",
      payload: { tool_name: "gmail.write", arguments: args },
      constraints: { allowed_tools: ["gmail.write"],
        allowed_capabilities: [...(tool.required_capabilities ?? [])] },
      upstream_decision: { frame_goal: "fixture", model_abstraction: "fixture",
        commit_hash: "c".repeat(64), commit_decision: "ASSERT" },
    };
    const observation = await tool.inspect_target_version!(args, {
      command_digest: operationPlanDigest(command),
    });
    const context = approvalContextFromCommand(command);
    const finalReviewRequiredForCommand = finalReviewRequired(context);
    const authority = createExecutorApprovalAuthority();
    const approved = authority.approve(command, {
      source: finalReviewRequiredForCommand ? "human_final_review" : "approval_gate",
      decision: finalReviewRequiredForCommand ? "approve" : "allow",
      approved_by: "fixture-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: context.operation,
      risk: context.risk,
      final_review_required: finalReviewRequiredForCommand,
      reason: "fixture-only dispatch check",
    }, executorCommandDigest(command), undefined, observation);
    const executor = new Executor({ approval_authority: authority, tools, llm: new StubBackend() });

    const feedback = await executor.execute(approved);

    expect(feedback.status).toBe("success");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ service: "gmail",
      path: "/gmail/v1/users/me/messages/send", token: "fixture-token" });
  });

  it("標準Executor dispatchはdraft.createの承認ticket観測をstub transportまで保つ", async () => {
    const draftArgs = { operation: "draft.create", to: "inspection@example.invalid", subject: "Synthetic draft",
      body_text: "This draft must stay in the test process." };
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const tools = new ToolRegistry();
    tools.register(tool);
    const command: ExecuteCommand = {
      id: "fixture-gmail-draft-dispatch-command",
      type: "tool_call",
      payload: { tool_name: "gmail.write", arguments: draftArgs },
      constraints: { allowed_tools: ["gmail.write"],
        allowed_capabilities: [...(tool.required_capabilities ?? [])] },
      upstream_decision: { frame_goal: "fixture", model_abstraction: "fixture",
        commit_hash: "c".repeat(64), commit_decision: "ASSERT" },
    };
    const observation = await tool.inspect_target_version!(draftArgs, {
      command_digest: operationPlanDigest(command), operation_plan_binding_digest: "b".repeat(64),
    });
    const context = approvalContextFromCommand(command);
    const finalReviewRequiredForCommand = finalReviewRequired(context);
    const authority = createExecutorApprovalAuthority();
    const approved = authority.approve(command, {
      source: finalReviewRequiredForCommand ? "human_final_review" : "approval_gate",
      decision: finalReviewRequiredForCommand ? "approve" : "allow",
      approved_by: "fixture-owner",
      approved_at_ms: 1,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: context.operation,
      risk: context.risk,
      final_review_required: finalReviewRequiredForCommand,
      reason: "fixture-only draft dispatch check",
    }, executorCommandDigest(command), undefined, observation);
    const executor = new Executor({ approval_authority: authority, tools, llm: new StubBackend() });

    const feedback = await executor.execute(approved);

    expect(feedback.status).toBe("success");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ service: "gmail",
      path: "/gmail/v1/users/me/drafts", token: "fixture-token" });
  });

  it("draft.createは宛先・厳密な作成payloadを観測に結び、同じ本文だけstubへ渡す", async () => {
    const draftArgs = { operation: "draft.create", to: "inspection@example.invalid", cc: "copy@example.invalid",
      bcc: "blind@example.invalid", subject: "Synthetic draft", body_text: "This draft must stay in the test process." };
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    const context = { command_id: "fixture-draft-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64), target_version_observation: observation };

    expect(observation).toMatchObject({ schema_version: "blue-tanuki.gmail-write-target-version.v1",
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain("inspection@example.invalid");
    expect(JSON.stringify(observation)).not.toContain("copy@example.invalid");
    expect(JSON.stringify(observation)).not.toContain("blind@example.invalid");
    expect(JSON.stringify(observation)).not.toContain(draftArgs.body_text);

    const result = await tool.invoke(draftArgs, context);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ path: "/gmail/v1/users/me/drafts", token: "fixture-token" });
    expect(result).toMatchObject({ service: "gmail", operation: "draft.create", mutation_sent: true });
  });

  it("draft.createの宛先・本文変更や観測欠落をcredential・requestの前に拒否する", async () => {
    const draftArgs = { operation: "draft.create", to: "inspection@example.invalid", subject: "Synthetic draft",
      body_text: "Original draft body" };
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    const context = { command_id: "fixture-draft-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64), target_version_observation: observation };

    await expect(tool.invoke({ ...draftArgs, to: "changed@example.invalid" }, context)).rejects
      .toThrow(/target version changed.*request_sent=false/);
    await expect(tool.invoke({ ...draftArgs, body_text: "Changed draft body" }, context)).rejects
      .toThrow(/target version changed.*request_sent=false/);
    await expect(tool.invoke(draftArgs, { ...context, target_version_observation: undefined })).rejects
      .toThrow(/target version evidence is required.*request_sent=false/);
    expect(request).not.toHaveBeenCalled();
  });

  it("draft.sendは既存draft内容の照合がないためtarget observationを発行しない", async () => {
    const request = vi.fn(async (_target: GoogleWriteTarget) => response);
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    await expect(tool.inspect_target_version!({ operation: "draft.send", draft_id: "fixture-draft" }, {
      command_digest: "a".repeat(64),
    })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
