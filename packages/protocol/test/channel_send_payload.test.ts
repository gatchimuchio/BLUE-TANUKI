import { describe, expect, it } from "vitest";
import { ChannelSendPayloadSchema } from "../src/index.js";

describe("ChannelSendPayloadSchema", () => {
  it("preserves an optional provider-native message reply reference", () => {
    expect(ChannelSendPayloadSchema.parse({
      channel: "discord",
      target: "123456789",
      content: "synthetic reply",
      reply_to_message_id: "987654321",
    })).toMatchObject({ reply_to_message_id: "987654321" });
    expect(ChannelSendPayloadSchema.parse({ channel: "webchat", target: "owner", content: "reply" }))
      .not.toHaveProperty("reply_to_message_id");
  });
});
