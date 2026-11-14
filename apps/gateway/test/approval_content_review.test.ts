import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gmailWriteRequestPayloadDigest, gmailWriteTargetIdentityDigest } from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  isBrowserFormGetReviewCommand,
  projectBrowserFormGetContentReview,
  isBrowserLinkNavigationReviewCommand,
  projectBrowserLinkNavigationContentReview,
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

function browserFormCommand(arguments_: Record<string, unknown>): ExecuteCommand {
  return {
    id: "cmd-browser-form-review",
    type: "tool_call",
    payload: { tool_name: "browser.automation", arguments: arguments_ },
    upstream_decision: {
      frame_goal: "synthetic browser form review",
      model_abstraction: "fixture",
      commit_hash: "a".repeat(64),
      commit_decision: "ASSERT",
    },
  };
}

function browserLinkCommand(arguments_: Record<string, unknown>): ExecuteCommand {
  return {
    id: "cmd-browser-link-review",
    type: "tool_call",
    payload: { tool_name: "browser.automation", arguments: arguments_ },
    upstream_decision: {
      frame_goal: "synthetic browser link review",
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

describe("browser form GET approval content review projection", () => {
  const args = {
    action: "form_submit",
    url: "https://example.test/search",
    action_url: "https://example.test/search/results",
    form_name: "Site search",
    fields: [{ name: "q", value: "synthetic blue" }],
  };

  it("shows and digests the exact same-origin page, destination, and fields", () => {
    const input = browserFormCommand(args);
    const projection = projectBrowserFormGetContentReview(input, "a".repeat(64), "b".repeat(64));

    expect(isBrowserFormGetReviewCommand(input)).toBe(true);
    expect(projection).toMatchObject({
      kind: "browser_form_get",
      url: "https://example.test/search",
      action_url: "https://example.test/search/results",
      origin: "https://example.test",
      form_name: "Site search",
      fields: [{ name: "q", value: "synthetic blue" }],
      method: "GET",
      external_effect_class: "form_submission_unclassified",
      same_origin_only: true,
      javascript_enabled: false,
      credentials_reused: false,
      downloads_enabled: false,
      no_store: true,
      used_for_authority: false,
      may_execute: false,
    });
    expect(projectBrowserFormGetContentReview(browserFormCommand({ ...args,
      fields: [{ name: "q", value: "changed" }] }), "a".repeat(64), "b".repeat(64))?.review_digest)
      .not.toBe(projection?.review_digest);
    expect(projectBrowserFormGetContentReview(browserFormCommand({ ...args,
      action_url: "https://example.test/other" }), "a".repeat(64), "b".repeat(64))?.review_digest)
      .not.toBe(projection?.review_digest);
  });

  it("fails closed for malformed or cross-origin form requests", () => {
    expect(projectBrowserFormGetContentReview(browserFormCommand({ ...args,
      action_url: "https://other.test/search" }), "a".repeat(64), "b".repeat(64))).toBeNull();
    expect(projectBrowserFormGetContentReview(browserFormCommand({ ...args, extra: true }),
      "a".repeat(64), "b".repeat(64))).toBeNull();
    expect(isBrowserFormGetReviewCommand(browserFormCommand({ ...args, action: "navigate" }))).toBe(false);
  });
});

describe("browser text attachment approval content review projection", () => {
  const args = {
    action: "download",
    url: "https://example.test/page",
    link_name: "Download report",
    target_url: "https://example.test/report.csv",
    max_bytes: 32_000,
    max_chars: 8_000,
  };

  it("binds the exact same-origin link and bounded in-memory text retrieval", () => {
    const input = browserLinkCommand(args);
    const projection = projectBrowserLinkNavigationContentReview(input, "a".repeat(64), "b".repeat(64));
    expect(isBrowserLinkNavigationReviewCommand(input)).toBe(true);
    expect(projection).toMatchObject({
      kind: "browser_link_navigation",
      operation: "browser.automation.download",
      action: "download_text_attachment",
      page_url: args.url,
      target_url: args.target_url,
      link_name: args.link_name,
      method: "GET",
      external_effect_class: "download_read_unclassified",
      same_origin_only: true,
      javascript_enabled: false,
      credentials_reused: false,
      downloads_enabled: false,
      no_store: true,
      download_mode: {
        content_types: "text/plain, text/csv, JSON, XML",
        max_bytes: 32_000,
        max_chars: 8_000,
        same_origin_only: true,
        redirects_allowed: false,
        content_returned_to_agent: true,
        saved_locally: false,
        used_for_authority: false,
        may_execute: false,
      },
      used_for_authority: false,
      may_execute: false,
    });
    expect(projectBrowserLinkNavigationContentReview(browserLinkCommand({ ...args, max_bytes: 31_999 }),
      "a".repeat(64), "b".repeat(64))?.review_digest).not.toBe(projection?.review_digest);
    expect(projectBrowserLinkNavigationContentReview(browserLinkCommand({ ...args,
      target_url: "https://example.test/changed.csv" }), "a".repeat(64), "b".repeat(64))?.review_digest)
      .not.toBe(projection?.review_digest);
  });

  it("fails closed for cross-origin or unrecognized download requests", () => {
    expect(projectBrowserLinkNavigationContentReview(browserLinkCommand({ ...args,
      target_url: "https://other.test/report.csv" }), "a".repeat(64), "b".repeat(64))).toBeNull();
    expect(projectBrowserLinkNavigationContentReview(browserLinkCommand({ ...args, extra: true }),
      "a".repeat(64), "b".repeat(64))).toBeNull();
    expect(isBrowserLinkNavigationReviewCommand(browserLinkCommand({ ...args, action: "navigate" }))).toBe(false);
  });
});
