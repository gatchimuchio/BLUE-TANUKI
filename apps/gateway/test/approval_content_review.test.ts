import { describe, expect, it } from "vitest";
import { gmailWriteRequestPayloadDigest } from "@blue-tanuki/core";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import {
  isGmailMessageSendCommand,
  projectGmailMessageSendContentReview,
  validateGmailMessageSendContentReview,
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

    expect(isGmailMessageSendCommand(input)).toBe(true);
    expect(projectGmailMessageSendContentReview(input, digest)).toEqual({
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

    expect(projectGmailMessageSendContentReview(unsupported, "b".repeat(64))).toBeNull();
    expect(projectGmailMessageSendContentReview(ambiguousBody, "b".repeat(64))).toBeNull();
    expect(projectGmailMessageSendContentReview(valid, "not-a-digest")).toBeNull();
    expect(isGmailMessageSendCommand(command({
      operation: "draft.create",
      to: "owner@example.test",
      subject: "hello",
    }))).toBe(false);
  });

  it("requires a successful explicit reveal before accepting the matching digest", () => {
    const input = command({
      operation: "message.send",
      to: "owner@example.test",
      subject: "hello",
      body_text: "body",
    });
    const digest = "d".repeat(64);

    expect(validateGmailMessageSendContentReview(input, digest, true, undefined, digest)).toBe("required");
    expect(validateGmailMessageSendContentReview(input, digest, true, digest, digest)).toBe("valid");
    expect(validateGmailMessageSendContentReview(input, digest, true, digest, "e".repeat(64))).toBe("stale");
    expect(validateGmailMessageSendContentReview(input, digest, false, digest, digest)).toBe("stale");
  });
});
