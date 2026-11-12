import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gmailWriteRequestPayloadDigest, gmailWriteTargetIdentityDigest } from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  isGmailDraftSendReviewCommand,
  isGmailMessageSendReviewCommand,
  isGmailMessageTrashReviewCommand,
  isGmailMessageModifyReviewCommand,
  isGmailWriteContentReviewCommand,
  projectGmailDraftSendContentReview,
  projectGmailMessageTrashContentReview,
  projectGmailMessageModifyContentReview,
  projectGmailWriteContentReview,
  validateGmailDraftSendContentReview,
  validateGmailMessageTrashContentReview,
  validateGmailMessageModifyContentReview,
  validateGmailWriteContentReview,
} from "../src/approval_content_review.js";

function command(arguments_: Record<string, unknown>): ExecuteCommand {
  return {
    id: "cmd-content-review",
    type: "tool_call",
    payload: { tool_name: "gmail.write", arguments: arguments_ },
    upstream_decision: {
      frame_goal: "synthetic approval review",
      model_abstraction: "fixture",
      commit_hash: "a".repeat(64),
      commit_decision: "ASSERT",
    },
  };
}

describe("Gmail approval content review projection", () => {
  it("message.trash review is exact-target, state, and command bound", () => {
    const args = { operation: "message.trash", message_id: "fixture-message_1" };
    const input = command(args);
    const commandDigest = "a".repeat(64);
    const providerStateDigest = "b".repeat(64);
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const targetIdentityDigest = gmailWriteTargetIdentityDigest(args);
    const reviewDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-message-trash-review.v1",
      command_digest: commandDigest, target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest, provider_state_digest: providerStateDigest });
    const snapshot = {
      kind: "gmail_message_trash" as const, operation: "gmail.write.message.trash" as const,
      account_email: "owner@example.test", message_id: args.message_id, thread_id: "fixture-thread_1",
      from: "sender@example.test", to: "owner@example.test", subject: "Synthetic subject",
      internal_date: "1760000000000", size_estimate: 128, label_ids: ["INBOX"],
      target_identity_digest: targetIdentityDigest, request_payload_digest: requestPayloadDigest,
      provider_state_digest: providerStateDigest, command_digest: commandDigest, review_digest: reviewDigest,
      used_for_authority: false as const, may_execute: false as const,
    };
    const projection = projectGmailMessageTrashContentReview(input, commandDigest, snapshot);

    expect(isGmailMessageTrashReviewCommand(input)).toBe(true);
    expect(projection).toMatchObject({ kind: "gmail_message_trash", operation: "gmail.write.message.trash",
      command_digest: commandDigest, review_digest: reviewDigest, message_id: args.message_id, subject: "Synthetic subject",
      label_ids: ["INBOX"], used_for_authority: false, may_execute: false });
    expect(validateGmailMessageTrashContentReview(input, commandDigest, true, undefined, undefined, snapshot)).toBe("required");
    expect(validateGmailMessageTrashContentReview(input, commandDigest, true, reviewDigest, reviewDigest, snapshot)).toBe("valid");
    expect(validateGmailMessageTrashContentReview(input, commandDigest, false, reviewDigest, reviewDigest, snapshot)).toBe("stale");
    expect(projectGmailMessageTrashContentReview(input, commandDigest, { ...snapshot, message_id: "other-message" })).toBeNull();
    expect(projectGmailMessageTrashContentReview(command({ ...args, extra: "unexpected" }), commandDigest, snapshot)).toBeNull();
    expect(isGmailMessageTrashReviewCommand(command({ operation: "message.send", message_id: args.message_id }))).toBe(false);
  });

  it("message.modify review binds one message and the exact add/remove user-label set", () => {
    const args = { operation: "message.modify", message_id: "fixture-message_2",
      add_label_ids: ["Label_2"], remove_label_ids: ["Label_1"] };
    const input = command(args);
    const commandDigest = "a".repeat(64);
    const providerStateDigest = "b".repeat(64);
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const targetIdentityDigest = gmailWriteTargetIdentityDigest(args);
    const reviewDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-message-modify-review.v1",
      command_digest: commandDigest, target_identity_digest: targetIdentityDigest,
      request_payload_digest: requestPayloadDigest, provider_state_digest: providerStateDigest });
    const snapshot = {
      kind: "gmail_message_modify" as const, operation: "gmail.write.message.modify" as const,
      account_email: "owner@example.test", message_id: args.message_id, thread_id: "fixture-thread_2",
      from: "sender@example.test", to: "owner@example.test", subject: "Synthetic label subject",
      current_labels: [{ id: "INBOX", name: "Inbox", type: "system" as const },
        { id: "Label_1", name: "Old project", type: "user" as const }],
      add_labels: [{ id: "Label_2", name: "Current project", type: "user" as const }],
      remove_labels: [{ id: "Label_1", name: "Old project", type: "user" as const }],
      target_identity_digest: targetIdentityDigest, request_payload_digest: requestPayloadDigest,
      provider_state_digest: providerStateDigest, command_digest: commandDigest, review_digest: reviewDigest,
      used_for_authority: false as const, may_execute: false as const,
    };
    const projection = projectGmailMessageModifyContentReview(input, commandDigest, snapshot);

    expect(isGmailMessageModifyReviewCommand(input)).toBe(true);
    expect(projection).toMatchObject({ kind: "gmail_message_modify", operation: "gmail.write.message.modify",
      command_digest: commandDigest, review_digest: reviewDigest, message_id: args.message_id,
      add_labels: [{ id: "Label_2", name: "Current project" }],
      remove_labels: [{ id: "Label_1", name: "Old project" }], used_for_authority: false, may_execute: false });
    expect(validateGmailMessageModifyContentReview(input, commandDigest, true, undefined, undefined, snapshot)).toBe("required");
    expect(validateGmailMessageModifyContentReview(input, commandDigest, true, reviewDigest, reviewDigest, snapshot)).toBe("valid");
    expect(validateGmailMessageModifyContentReview(input, commandDigest, false, reviewDigest, reviewDigest, snapshot)).toBe("stale");
    expect(projectGmailMessageModifyContentReview(input, commandDigest,
      { ...snapshot, add_labels: [{ id: "OtherLabel", name: "Other", type: "user" }] })).toBeNull();
    expect(projectGmailMessageModifyContentReview(command({ ...args, extra: "unexpected" }), commandDigest, snapshot)).toBeNull();
    expect(isGmailMessageModifyReviewCommand(command({ operation: "message.trash", message_id: args.message_id }))).toBe(false);
  });

  it("message.send review requires the exact authenticated account and payload snapshot", () => {
    const args = {
      operation: "message.send",
      to: " owner@example.test ",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      subject: "  Review this  ",
      body_text: "  exact body\nline two  ",
    };
    const input = command(args);
    const digest = "b".repeat(64);
    const accountEmail = "owner@example.test";
    const accountIdentityDigest = createHash("sha256").update(accountEmail.toLowerCase(), "utf8").digest("hex");
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const reviewDigest = operationPlanDigest({ schema_version: "blue-tanuki.gmail-message-send-content-review.v1",
      command_digest: digest, target_identity_digest: gmailWriteTargetIdentityDigest(args), request_payload_digest: requestPayloadDigest,
      account_identity_digest: accountIdentityDigest, provider_state_digest: accountIdentityDigest,
      attachment_content_digests: [] });
    const snapshot = { kind: "gmail_write_content" as const, command_digest: digest, request_payload_digest: requestPayloadDigest,
      review_digest: reviewDigest, account_email: accountEmail, account_identity_digest: accountIdentityDigest,
      provider_state_digest: accountIdentityDigest, used_for_authority: false as const, may_execute: false as const };

    expect(isGmailWriteContentReviewCommand(input)).toBe(true);
    expect(isGmailMessageSendReviewCommand(input)).toBe(true);
    expect(projectGmailWriteContentReview(input, digest)).toBeNull();
    expect(projectGmailWriteContentReview(input, digest, snapshot)).toEqual({
      command_id: "cmd-content-review",
      command_digest: digest,
      kind: "gmail_write_content",
      review_digest: reviewDigest,
      account_email: accountEmail,
      account_identity_digest: accountIdentityDigest,
      provider_state_digest: accountIdentityDigest,
      request_payload_digest: requestPayloadDigest,
      operation: "gmail.write.message.send",
      to: "owner@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      subject: "Review this",
      body_text: "exact body\nline two",
      used_for_authority: false,
    });
    expect(projectGmailWriteContentReview(input, digest,
      { ...snapshot, account_email: "other@example.test" })).toBeNull();
    expect(validateGmailWriteContentReview(input, digest, true, reviewDigest, reviewDigest, snapshot)).toBe("valid");
  });

  it("fails closed for unsupported payload fields and invalid binding digests", () => {
    const unsupported = command({
      operation: "message.send",
      to: "owner@example.test",
      subject: "hello",
      body_text: "body",
      attachments: [{ name: "not supported" }],
    });
    const valid = command({
      operation: "message.send",
      to: "owner@example.test",
      subject: "hello",
      body_text: "body",
    });
    const ambiguousBody = command({
      operation: "message.send",
      to: "owner@example.test",
      subject: "hello",
      body_text: "preferred body",
      body: "alternate body",
    });

    expect(projectGmailWriteContentReview(unsupported, "b".repeat(64))).toBeNull();
    expect(projectGmailWriteContentReview(ambiguousBody, "b".repeat(64))).toBeNull();
    expect(projectGmailWriteContentReview(valid, "not-a-digest")).toBeNull();
    expect(isGmailWriteContentReviewCommand(command({
      operation: "draft.create",
      to: "owner@example.test",
      subject: "hello",
    }))).toBe(true);
  });

  it("requires a successful explicit reveal before accepting the matching digest", () => {
    const input = command({
      operation: "message.send",
      to: "owner@example.test",
      subject: "hello",
      body_text: "body",
    });
    const digest = "d".repeat(64);

    expect(validateGmailWriteContentReview(input, digest, true, undefined, digest)).toBe("required");
    expect(validateGmailWriteContentReview(input, digest, true, digest, digest)).toBe("valid");
    expect(validateGmailWriteContentReview(input, digest, true, digest, "e".repeat(64))).toBe("stale");
    expect(validateGmailWriteContentReview(input, digest, false, digest, digest)).toBe("stale");
  });

  it("reviews draft.create command content and projects existing draft.send provider content separately", () => {
    const args = {
      operation: "draft.create",
      to: " recipient@example.test ",
      subject: "  Draft subject  ",
      body_text: "  exact draft body\nline two  ",
    };
    const draft = command(args);
    const digest = "f".repeat(64);
    const review = projectGmailWriteContentReview(draft, digest);
    expect(isGmailWriteContentReviewCommand(draft)).toBe(true);
    expect(review).toMatchObject({
      operation: "gmail.write.draft.create",
      command_digest: digest,
      request_payload_digest: gmailWriteRequestPayloadDigest(args),
      to: "recipient@example.test",
      subject: "Draft subject",
      body_text: "exact draft body\nline two",
      used_for_authority: false,
    });
    expect(validateGmailWriteContentReview(draft, digest, true, undefined, digest)).toBe("required");
    expect(validateGmailWriteContentReview(draft, digest, true, digest, digest)).toBe("valid");

    const unsupported = command({ operation: "draft.send", draft_id: "draft-fixture" });
    expect(isGmailWriteContentReviewCommand(unsupported)).toBe(false);
    expect(projectGmailWriteContentReview(unsupported, digest)).toBeNull();
    expect(isGmailDraftSendReviewCommand(unsupported)).toBe(true);

    const providerReview = projectGmailDraftSendContentReview(unsupported, digest, {
      account_email: "owner@example.test",
      from: "sender@example.test",
      to: "recipient@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      reply_to: "replies@example.test",
      subject: "Existing subject",
      body_text: "Existing exact body",
      attachments: [{
        filename: "report.txt",
        mime_type: "text/plain",
        size_bytes: 12,
        content_sha256: "5".repeat(64),
        used_for_authority: false,
      }],
      provider_state_digest: "1".repeat(64),
      provider_raw_digest: "2".repeat(64),
      request_payload_digest: "3".repeat(64),
    });
    expect(providerReview).toMatchObject({
      kind: "gmail_write_content",
      operation: "gmail.write.draft.send",
      account_email: "owner@example.test",
      from: "sender@example.test",
      to: "recipient@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      reply_to: "replies@example.test",
      subject: "Existing subject",
      body_text: "Existing exact body",
      provider_state_digest: "1".repeat(64),
      provider_raw_digest: "2".repeat(64),
      request_payload_digest: "3".repeat(64),
      attachments: [{
        filename: "report.txt",
        mime_type: "text/plain",
        size_bytes: 12,
        content_sha256: "5".repeat(64),
        used_for_authority: false,
      }],
      used_for_authority: false,
    });
    expect(providerReview?.review_digest).toMatch(/^[a-f0-9]{64}$/);
    const reviewDigest = providerReview?.review_digest;
    const changedAttachmentReview = projectGmailDraftSendContentReview(unsupported, digest, {
      account_email: "owner@example.test",
      from: "sender@example.test",
      to: "recipient@example.test",
      subject: "Existing subject",
      body_text: "Existing exact body",
      provider_state_digest: "1".repeat(64),
      provider_raw_digest: "2".repeat(64),
      request_payload_digest: "3".repeat(64),
      attachments: [{
        filename: "report.txt",
        mime_type: "text/plain",
        size_bytes: 12,
        content_sha256: "6".repeat(64),
        used_for_authority: false,
      }],
    });
    expect(changedAttachmentReview?.review_digest).not.toBe(reviewDigest);
    expect(validateGmailDraftSendContentReview(unsupported, digest, true, reviewDigest, reviewDigest)).toBe("valid");
    expect(validateGmailDraftSendContentReview(unsupported, digest, true, reviewDigest, "4".repeat(64))).toBe("stale");
    expect(validateGmailDraftSendContentReview(unsupported, digest, true, undefined, reviewDigest)).toBe("required");
  });

  it("reply draft projection requires the verified source message, exact thread, and provider state", () => {
    const args = { operation: "draft.create", reply_to_message_id: "fixture-source-message_1",
      to: "owner-selected@example.test", subject: "Selected thread subject", body_text: "Synthetic reply body" };
    const input = command(args);
    const commandDigest = "a".repeat(64);
    const providerStateDigest = "b".repeat(64);
    const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
    const identityDigest = (value: string) => createHash("sha256").update(value).digest("hex");
    const reviewDigest = operationPlanDigest({
      schema_version: "blue-tanuki.gmail-write-content-review.v2",
      command_digest: commandDigest,
      request_payload_digest: requestPayloadDigest,
      attachment_content_digests: [],
      reply_source_message_identity_digest: identityDigest(args.reply_to_message_id),
      reply_source_thread_identity_digest: identityDigest("fixture-thread_1"),
      provider_state_digest: providerStateDigest,
    });
    const snapshot = {
      kind: "gmail_write_content" as const,
      command_digest: commandDigest,
      request_payload_digest: requestPayloadDigest,
      review_digest: reviewDigest,
      reply_source: { message_id: args.reply_to_message_id, thread_id: "fixture-thread_1",
        from: "sender@example.test", subject: args.subject, provider_state_digest: providerStateDigest,
        used_for_authority: false as const },
      provider_state_digest: providerStateDigest,
      used_for_authority: false as const,
      may_execute: false as const,
    };

    const projection = projectGmailWriteContentReview(input, commandDigest, snapshot);
    expect(projection).toMatchObject({ operation: "gmail.write.draft.create", reply_source: {
      message_id: args.reply_to_message_id, thread_id: "fixture-thread_1", subject: args.subject,
      provider_state_digest: providerStateDigest, used_for_authority: false,
    }, provider_state_digest: providerStateDigest, used_for_authority: false });
    expect(projectGmailWriteContentReview(input, commandDigest)).toBeNull();
    expect(projectGmailWriteContentReview(input, commandDigest,
      { ...snapshot, reply_source: { ...snapshot.reply_source, message_id: "another-message" } })).toBeNull();
    expect(projectGmailWriteContentReview(input, commandDigest,
      { ...snapshot, reply_source: { ...snapshot.reply_source, subject: "another thread" } })).toBeNull();
  });
});
