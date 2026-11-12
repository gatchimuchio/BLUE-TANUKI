import { createHash } from "node:crypto";
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

const draftArgs = { operation: "draft.send", draft_id: "fixture-draft" };
const draftRaw = Buffer.from([
  "From: owner@example.invalid",
  "To: recipient@example.invalid",
  "Cc: copy@example.invalid",
  "Bcc: blind@example.invalid",
  "Reply-To: replies@example.invalid",
  "Subject: =?UTF-8?B?5pel5pys6Kqe?=",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: 8bit",
  "",
  "合成本文だけを使う。",
].join("\r\n")).toString("base64url");

function draftReadResponse(path: string, raw = draftRaw, messageId = "fixture-message-v1"): GoogleWriteResponse {
  if (path.endsWith("/profile")) return { ...response, body: JSON.stringify({ emailAddress: "owner@example.invalid" }) };
  return { ...response, body: JSON.stringify({ id: "fixture-draft", message: { id: messageId, raw } }) };
}

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

  it("draft.sendは認証account・可変draft version・MIME全体をresume内容確認とtarget observationへ結ぶ", async () => {
    const request = vi.fn(async (target: GoogleWriteTarget) =>
      draftReadResponse(target.path));
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const review = await tool.inspect_content_review!(draftArgs);
    expect(review).toMatchObject({ account_email: "owner@example.invalid", from: "owner@example.invalid",
      to: "recipient@example.invalid", cc: "copy@example.invalid", bcc: "blind@example.invalid",
      reply_to: "replies@example.invalid", subject: "日本語", body_text: "合成本文だけを使う。" });
    expect(review.provider_state_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.provider_raw_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review).not.toHaveProperty("raw");

    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    expect(observation).toMatchObject({ provider_state_digest: review.provider_state_digest,
      provider_raw_digest: review.provider_raw_digest, command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64), used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain("recipient@example.invalid");
    expect(JSON.stringify(observation)).not.toContain("合成本文だけ");

    const result = await tool.invoke(draftArgs, { command_id: "fixture-draft-send-command",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation });
    expect(result).toMatchObject({ service: "gmail", operation: "draft.send", mutation_sent: true });
    const sendTarget = request.mock.calls.at(-1)?.[0];
    expect(sendTarget).toMatchObject({ method: "POST", path: "/gmail/v1/users/me/drafts/send" });
    expect(JSON.parse(sendTarget?.body ?? "{}")).toEqual({ id: "fixture-draft", message: { raw: draftRaw } });
  });

  it("添付付きdraft.sendは実MIMEの添付名・種類・size・hashを表示し、確認した同じrawだけを送る", async () => {
    const attachmentBytes = Buffer.from("synthetic attachment bytes", "utf8");
    const attachmentFilename = "報告書.pdf";
    const attachmentFilenameExtended = encodeURIComponent(attachmentFilename).replace(/[!'()*]/g,
      (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
    const attachmentBase64 = attachmentBytes.toString("base64");
    const attachmentBase64Lines = attachmentBase64.match(/.{1,76}/g)?.join("\r\n") ?? "";
    const bodyBase64 = Buffer.from("Exact attached draft body", "utf8").toString("base64");
    const boundary = "=_blue_tanuki_" + "f".repeat(40);
    const raw = Buffer.from([
      "From: owner@example.invalid",
      "To: recipient@example.invalid",
      "Cc: copy@example.invalid",
      "Bcc: blind@example.invalid",
      "Reply-To: replies@example.invalid",
      "Subject: Attached draft",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=\"" + boundary + "\"",
      "",
      "--" + boundary,
      "Content-Type: text/plain; charset=\"UTF-8\"",
      "Content-Transfer-Encoding: base64",
      "",
      bodyBase64,
      "--" + boundary,
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=\"report-__.pdf\"; filename*=UTF-8''" + attachmentFilenameExtended,
      "",
      attachmentBase64Lines,
      "--" + boundary + "--",
    ].join("\r\n"), "utf8").toString("base64url");
    const request = vi.fn(async (target: GoogleWriteTarget) =>
      draftReadResponse(target.path, raw));
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const review = await tool.inspect_content_review!(draftArgs);
    expect(review).toMatchObject({
      account_email: "owner@example.invalid",
      to: "recipient@example.invalid",
      cc: "copy@example.invalid",
      bcc: "blind@example.invalid",
      reply_to: "replies@example.invalid",
      subject: "Attached draft",
      body_text: "Exact attached draft body",
      attachments: [{
        filename: attachmentFilename,
        mime_type: "application/pdf",
        size_bytes: attachmentBytes.length,
        content_sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
        used_for_authority: false,
      }],
    });
    expect(JSON.stringify(review)).not.toContain(attachmentBytes.toString("utf8"));
    expect(JSON.stringify(review)).not.toContain(attachmentBase64);

    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    const draftReadTarget = request.mock.calls.find(([target]) => target.path.endsWith("?format=raw"))?.[0];
    expect(draftReadTarget?.maxBytes).toBeGreaterThan(512_000);
    expect(JSON.stringify(observation)).not.toContain(attachmentFilename);
    expect(JSON.stringify(observation)).not.toContain(attachmentBase64);

    const result = await tool.invoke(draftArgs, { command_id: "fixture-attached-draft-send",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation });
    expect(result).toMatchObject({ service: "gmail", operation: "draft.send", mutation_sent: true });
    const sendTarget = request.mock.calls.find(([target]) => target.method === "POST")?.[0];
    expect(JSON.parse(sendTarget?.body ?? "{}")).toEqual({ id: "fixture-draft", message: { raw } });
  });

  it("同じdraftへの並列sendを直列化し、先行送信後の古い期待版を二重送信しない", async () => {
    let draftSent = false;
    const request = vi.fn(async (target: GoogleWriteTarget) => {
      if (target.path.endsWith("/profile")) return draftReadResponse(target.path);
      if (target.path.endsWith("?format=raw")) {
        return draftSent
          ? { ...response, status: 404, ok: false, body: JSON.stringify({ error: "draft no longer exists" }) }
          : draftReadResponse(target.path);
      }
      if (target.method === "POST" && target.path.endsWith("/drafts/send")) {
        draftSent = true;
        return response;
      }
      return response;
    });
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const tools = new ToolRegistry();
    tools.register(tool);
    const authority = createExecutorApprovalAuthority();
    const executor = new Executor({ approval_authority: authority, tools, llm: new StubBackend() });
    const commands: ExecuteCommand[] = ["fixture-draft-send-1", "fixture-draft-send-2"].map((id) => ({
      id,
      type: "tool_call",
      payload: { tool_name: "gmail.write", arguments: draftArgs },
      constraints: { allowed_tools: ["gmail.write"],
        allowed_capabilities: [...(tool.required_capabilities ?? [])] },
      upstream_decision: { frame_goal: "fixture", model_abstraction: "fixture",
        commit_hash: "c".repeat(64), commit_decision: "ASSERT" },
    }));
    const approvals = await Promise.all(commands.map(async (command) => {
      const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
        command_digest: operationPlanDigest(command),
      }));
      const context = approvalContextFromCommand(command, { actor: "fixture-owner" });
      const finalReview = finalReviewRequired(context);
      return authority.approve(command, {
        source: finalReview ? "human_final_review" : "approval_gate",
        decision: finalReview ? "approve" : "allow",
        approved_by: "fixture-owner",
        approved_at_ms: 1,
        upstream_commit_hash: command.upstream_decision.commit_hash,
        operation: context.operation,
        risk: context.risk,
        final_review_required: finalReview,
        reason: "isolated synthetic draft target concurrency fixture",
      }, executorCommandDigest(command), undefined, observation);
    }));

    const feedback = await Promise.all(approvals.map((approval) => executor.execute(approval)));

    expect(feedback.filter((entry) => entry.status === "success")).toHaveLength(1);
    expect(feedback.filter((entry) => entry.status === "failed")).toHaveLength(1);
    expect(request.mock.calls.filter(([target]) => target.method === "POST" && target.path.endsWith("/drafts/send")))
      .toHaveLength(1);
  });

  it("承認済み内容・内側Message IDが変わるとdraft.sendをHTTP mutation前に停止する", async () => {
    let draftReadCount = 0;
    const changedRaw = Buffer.from("From: owner@example.invalid\r\nTo: changed@example.invalid\r\n\r\nchanged")
      .toString("base64url");
    const request = vi.fn(async (target: GoogleWriteTarget) => {
      if (target.path.endsWith("/profile")) return draftReadResponse(target.path);
      if (target.path.endsWith("?format=raw")) {
        draftReadCount += 1;
        return draftReadResponse(target.path, draftReadCount <= 1 ? draftRaw : changedRaw,
          draftReadCount <= 1 ? "fixture-message-v1" : "fixture-message-v2");
      }
      return response;
    });
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(draftArgs, {
      command_digest: "a".repeat(64),
    }));
    await expect(tool.invoke(draftArgs, { command_id: "fixture-draft-send-command",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation })).rejects
      .toThrow(/content or provider version changed.*mutation_sent=false/);
    expect(request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(0);
  });

  it("HTML、未対応multipart、制御文字入りheader、送信元不明のdraftは審査不能にする", async () => {
    for (const rawText of [
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\nContent-Type: text/html\r\n\r\n<b>hidden</b>",
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x",
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\rBcc: hidden@example.invalid\r\n\r\nbody",
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\n =?UTF-8?B?DQpCY2M6IGhpZGRlbkBleGFtcGxlLmludmFsaWQ=?=\r\n\r\nbody",
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\nX-Unreviewed-Action: enabled\r\nContent-Type: text/plain\r\n\r\nbody",
      "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\nContent-Type: text/plain; format=flowed\r\n\r\nbody",
      "To: recipient@example.invalid\r\nContent-Type: text/plain\r\n\r\nno sender",
    ]) {
      const encoded = Buffer.from(rawText).toString("base64url");
      const request = vi.fn(async (target: GoogleWriteTarget) => draftReadResponse(target.path, encoded));
      const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request });
      await expect(tool.inspect_content_review!(draftArgs)).rejects.toThrow();
      expect(request.mock.calls.some(([target]) => target.method === "POST")).toBe(false);
    }
  });
});
