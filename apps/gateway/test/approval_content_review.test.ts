import { describe, expect, it } from "vitest";
import { gmailWriteRequestPayloadDigest } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  isGmailWriteContentReviewCommand,
  projectGmailWriteContentReview,
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
  it("projects the effective message fields and binds both digests", () => {
    const args = {
      operation: "message.send",
      to: " owner@example.test ",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      from: "sender@example.test",
      subject: "  Review this  ",
      body_text: "  exact body\nline two  ",
    };
    const input = command(args);
    const digest = "b".repeat(64);

    expect(isGmailWriteContentReviewCommand(input)).toBe(true);
    expect(projectGmailWriteContentReview(input, digest)).toEqual({
      command_id: "cmd-content-review",
      command_digest: digest,
      request_payload_digest: gmailWriteRequestPayloadDigest(args),
      operation: "gmail.write.message.send",
      to: "owner@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      from: "sender@example.test",
      subject: "Review this",
      body_text: "exact body\nline two",
      used_for_authority: false,
    });
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

  it("reviews the exact draft.create payload while keeping draft.send outside this route", () => {
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
  });
});
