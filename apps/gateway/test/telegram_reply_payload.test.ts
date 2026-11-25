import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import { replyPayload } from "../src/serve.js";

function telegramRequest(messageId: unknown): InboundRequest {
  return {
    id: "telegram-81",
    channel: "telegram",
    user: "telegram:52:chat:-1001:thread:41",
    content: "synthetic inbound message",
    timestamp: 1,
    metadata: {
      reply_to: "-1001|41",
      telegram_chat_id: "-1001",
      telegram_user_id: "52",
      telegram_message_thread_id: 41,
      telegram_message_id: messageId,
    },
  };
}

describe("Telegram reply payload binding", () => {
  it("binds a positive native message id to the same chat topic", () => {
    expect(replyPayload(telegramRequest(81), "synthetic reply")).toEqual({
      channel: "telegram",
      target: "-1001|41",
      content: "synthetic reply",
      reply_to_message_id: "81",
    });
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, "81"]) (
    "does not create a native reply reference for an invalid message id (%s)", (messageId) => {
      expect(replyPayload(telegramRequest(messageId), "synthetic reply")).toEqual({
        channel: "telegram",
        target: "-1001|41",
        content: "synthetic reply",
      });
    },
  );
});
