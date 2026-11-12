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

const trashArgs = { operation: "message.trash", message_id: "fixture-message_123" };
function gmailTrashFixture(options: { initialLabels?: string[]; confirmTrash?: boolean } = {}) {
  let labels = [...(options.initialLabels ?? ["INBOX"])];
  const request = vi.fn(async (target: GoogleWriteTarget): Promise<GoogleWriteResponse> => {
    if (target.path === "/gmail/v1/users/me/profile" && target.method === "GET") {
      return { ...response, body: JSON.stringify({ emailAddress: "owner@example.invalid" }) };
    }
    if (target.path.includes("?format=metadata&") && target.method === "GET") {
      return { ...response, body: JSON.stringify({ id: trashArgs.message_id, threadId: "fixture-thread_1",
        labelIds: labels, internalDate: "1760000000000", sizeEstimate: 128,
        payload: { mimeType: "text/plain", headers: [
          { name: "From", value: "sender@example.invalid" },
          { name: "To", value: "owner@example.invalid" },
          { name: "Subject", value: "Synthetic review subject" },
          { name: "Date", value: "Mon, 12 Nov 2026 00:00:00 +0000" },
        ] } }) };
    }
    if (target.path.endsWith("/trash") && target.method === "POST") {
      if (options.confirmTrash !== false) labels = [...labels, "TRASH"];
      return { ...response, body: JSON.stringify({ id: trashArgs.message_id, threadId: "fixture-thread_1", labelIds: labels }) };
    }
    throw new Error(`unexpected fixture request: ${target.method} ${target.path}`);
  });
  return { request, getLabels: () => [...labels] };
}

const modifyArgs = { operation: "message.modify", message_id: "fixture-message_123",
  add_label_ids: ["Label_2"], remove_label_ids: ["Label_1"] };
function gmailModifyFixture(options: { initialLabels?: string[]; confirmModify?: boolean } = {}) {
  let labels = [...(options.initialLabels ?? ["INBOX", "Label_1"] )];
  const labelCatalog = [
    { id: "INBOX", name: "Inbox", type: "system" },
    { id: "Label_1", name: "Old project", type: "user" },
    { id: "Label_2", name: "Current project", type: "user" },
    { id: "STARRED", name: "Starred", type: "system" },
  ];
  const request = vi.fn(async (target: GoogleWriteTarget): Promise<GoogleWriteResponse> => {
    if (target.path === "/gmail/v1/users/me/profile" && target.method === "GET") {
      return { ...response, body: JSON.stringify({ emailAddress: "owner@example.invalid" }) };
    }
    if (target.path === "/gmail/v1/users/me/labels" && target.method === "GET") {
      return { ...response, body: JSON.stringify({ labels: labelCatalog }) };
    }
    if (target.path.includes("?format=metadata&") && target.method === "GET") {
      return { ...response, body: JSON.stringify({ id: modifyArgs.message_id, threadId: "fixture-thread_1",
        labelIds: labels, internalDate: "1760000000000", sizeEstimate: 128,
        payload: { mimeType: "text/plain", headers: [
          { name: "From", value: "sender@example.invalid" },
          { name: "To", value: "owner@example.invalid" },
          { name: "Subject", value: "Synthetic label review subject" },
          { name: "Date", value: "Mon, 12 Nov 2026 00:00:00 +0000" },
        ] } }) };
    }
    if (target.path.endsWith("/modify") && target.method === "POST") {
      if (options.confirmModify !== false) {
        const body = JSON.parse(target.body ?? "{}") as { addLabelIds?: string[]; removeLabelIds?: string[] };
        labels = [...new Set([...labels.filter((id) => !body.removeLabelIds?.includes(id)), ...(body.addLabelIds ?? [])])].sort();
      }
      return { ...response, body: JSON.stringify({ id: modifyArgs.message_id, threadId: "fixture-thread_1", labelIds: labels }) };
    }
    throw new Error(`unexpected fixture request: ${target.method} ${target.path}`);
  });
  return { request, getLabels: () => [...labels], setLabels: (next: string[]) => { labels = [...next]; } };
}

describe("Gmail write target observation", () => {
  it("message.modifyは既存ユーザーラベルだけをL3確認用snapshotへ結び、単一messageをreadbackする", async () => {
    const fixture = gmailModifyFixture();
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: fixture.request });
    const commandDigest = "a".repeat(64);
    const planDigest = "b".repeat(64);
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(modifyArgs, {
      command_digest: commandDigest, operation_plan_binding_digest: planDigest,
    }));
    const review = await tool.inspect_content_review!(modifyArgs, {
      command_digest: commandDigest, operation_plan_binding_digest: planDigest,
    });
    expect(review).toMatchObject({ kind: "gmail_message_modify", operation: "gmail.write.message.modify",
      message_id: modifyArgs.message_id, subject: "Synthetic label review subject",
      current_labels: [{ id: "INBOX", name: "Inbox", type: "system" }, { id: "Label_1", name: "Old project", type: "user" }],
      add_labels: [{ id: "Label_2", name: "Current project", type: "user" }],
      remove_labels: [{ id: "Label_1", name: "Old project", type: "user" }],
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain(modifyArgs.message_id);
    expect(JSON.stringify(observation)).not.toContain("Current project");
    expect(JSON.stringify(review)).not.toContain("raw");

    const result = await tool.invoke(modifyArgs, { command_id: "fixture-message-modify-command",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation });

    const mutations = fixture.request.mock.calls.filter(([target]) => target.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.[0]).toMatchObject({ service: "gmail", hostname: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/fixture-message_123/modify", method: "POST", token: "fixture-token" });
    expect(JSON.parse(mutations[0]?.[0].body ?? "{}")).toEqual({ addLabelIds: ["Label_2"], removeLabelIds: ["Label_1"] });
    expect(fixture.getLabels()).toEqual(["INBOX", "Label_2"]);
    expect(result).toMatchObject({ service: "gmail", operation: "message.modify", mutation_sent: true,
      mutation_status: "confirmed", result: { labels_confirmed: true, used_for_authority: false, may_execute: false } });
    expect(JSON.stringify(result)).not.toContain(modifyArgs.message_id);
    expect(JSON.stringify(result)).not.toContain("Current project");
    expect(JSON.stringify(result)).not.toContain("Label_2");
  });

  it("message.modifyは承認後の状態変化、no-op、system labelをmutation前に拒否する", async () => {
    const fixture = gmailModifyFixture();
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: fixture.request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(modifyArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    fixture.setLabels(["INBOX", "Label_1", "STARRED"]);
    await expect(tool.invoke(modifyArgs, { command_id: "fixture-message-modify-command",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation }))
      .rejects.toThrow(/target state changed after review.*mutation_sent=false/);
    expect(fixture.request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(0);

    const noopFixture = gmailModifyFixture({ initialLabels: ["INBOX", "Label_1", "Label_2"] });
    const noopTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: noopFixture.request });
    await expect(noopTool.inspect_target_version!(modifyArgs, { command_digest: "f".repeat(64) }))
      .rejects.toThrow(/already has the requested label state/);

    const systemArgs = { ...modifyArgs, add_label_ids: ["STARRED"], remove_label_ids: undefined };
    const systemTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: noopFixture.request });
    await expect(systemTool.inspect_target_version!(systemArgs, { command_digest: "f".repeat(64) }))
      .rejects.toThrow(/only supports existing user labels/);
    expect(noopFixture.request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(0);
  });

  it("message.modifyのreadback不一致をoutcome_unknownとして閉じ、自動再送しない", async () => {
    const fixture = gmailModifyFixture({ confirmModify: false });
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: fixture.request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(modifyArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    await expect(tool.invoke(modifyArgs, { command_id: "fixture-message-modify-command",
      upstream_commit_hash: "c".repeat(64), idempotency_key: "d".repeat(64),
      command_digest: "e".repeat(64), target_version_observation: observation }))
      .rejects.toThrow(/outcome_unknown; do not retry automatically/);
    expect(fixture.request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(1);
  });

  it("message.trashはmetadataと明示対象を結び、1回のPOST後にTRASHを再読込確認する", async () => {
    const fixture = gmailTrashFixture();
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: fixture.request });
    const commandDigest = "a".repeat(64);
    const planDigest = "b".repeat(64);
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(trashArgs, {
      command_digest: commandDigest, operation_plan_binding_digest: planDigest,
    }));
    const review = await tool.inspect_content_review!(trashArgs, {
      command_digest: commandDigest, operation_plan_binding_digest: planDigest,
    });
    expect(review).toMatchObject({ kind: "gmail_message_trash", operation: "gmail.write.message.trash",
      message_id: trashArgs.message_id, subject: "Synthetic review subject", label_ids: ["INBOX"],
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain(trashArgs.message_id);
    expect(JSON.stringify(review)).not.toContain("raw");

    const result = await tool.invoke(trashArgs, { command_id: "fixture-trash-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64), target_version_observation: observation });

    expect(fixture.request).toHaveBeenCalledTimes(9);
    const mutations = fixture.request.mock.calls.filter(([target]) => target.method === "POST");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.[0]).toMatchObject({ service: "gmail", hostname: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/fixture-message_123/trash", method: "POST", token: "fixture-token" });
    expect(mutations[0]?.[0]).not.toHaveProperty("body");
    expect(fixture.getLabels()).toContain("TRASH");
    expect(result).toMatchObject({ service: "gmail", operation: "message.trash", mutation_sent: true,
      mutation_status: "confirmed", result: { trash_confirmed: true, used_for_authority: false, may_execute: false } });
    expect(JSON.stringify(result)).not.toContain(trashArgs.message_id);
    expect(JSON.stringify(result)).not.toContain("Synthetic review subject");
  });

  it("message.trashは観測後の状態変化と既存TrashをPOST前に拒否する", async () => {
    // The fixture state is intentionally changed through its backing API on a subsequent target read.
    const changedFixture = gmailTrashFixture();
    const changedTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: changedFixture.request });
    const changedObservation = GmailWriteTargetVersionObservationSchema.parse(await changedTool.inspect_target_version!(trashArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    const staleRequest = vi.fn(async (target: GoogleWriteTarget) => {
      if (target.path.includes("?format=metadata&") && target.method === "GET") {
        return { ...response, body: JSON.stringify({ id: trashArgs.message_id, threadId: "fixture-thread_1",
          labelIds: ["INBOX", "STARRED"], internalDate: "1760000000000", sizeEstimate: 128,
          payload: { mimeType: "text/plain", headers: [] } }) };
      }
      return changedFixture.request(target);
    });
    const staleTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: staleRequest });
    await expect(staleTool.invoke(trashArgs, { command_id: "fixture-trash-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64), target_version_observation: changedObservation }))
      .rejects.toThrow(/target state changed.*mutation_sent=false/);
    expect(staleRequest.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(0);

    const trashedFixture = gmailTrashFixture({ initialLabels: ["INBOX", "TRASH"] });
    const trashedTool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: trashedFixture.request });
    await expect(trashedTool.inspect_target_version!(trashArgs, { command_digest: "f".repeat(64) }))
      .rejects.toThrow(/already in Trash/);
    expect(trashedFixture.request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(0);
  });

  it("message.trashのpost-read不一致をunknownとして閉じ、自動再送しない", async () => {
    const fixture = gmailTrashFixture({ confirmTrash: false });
    const tool = createGmailWriteTool({ env: { GMAIL_ACCESS_TOKEN: "fixture-token" }, request: fixture.request });
    const observation = GmailWriteTargetVersionObservationSchema.parse(await tool.inspect_target_version!(trashArgs, {
      command_digest: "a".repeat(64), operation_plan_binding_digest: "b".repeat(64),
    }));
    await expect(tool.invoke(trashArgs, { command_id: "fixture-trash-command", upstream_commit_hash: "c".repeat(64),
      idempotency_key: "d".repeat(64), command_digest: "e".repeat(64), target_version_observation: observation }))
      .rejects.toThrow(/outcome_unknown; do not retry automatically/);
    expect(fixture.request.mock.calls.filter(([target]) => target.method === "POST")).toHaveLength(1);
  });

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
