import { describe, expect, it } from "vitest";
import { parseTelegramInboundGrants } from "../src/telegram_inbound_grants.js";

describe("Telegram inbound owner grants", () => {
  it("defaults to deny-all and parses exact private-chat and topic grants", () => {
    expect(parseTelegramInboundGrants(undefined)).toEqual([]);
    expect(parseTelegramInboundGrants("  ")).toEqual([]);
    expect(parseTelegramInboundGrants(JSON.stringify([
      { user_id: "12345", chat_id: "12345", message_thread_id: null },
      { user_id: "12345", chat_id: "-100123", message_thread_id: 41 },
    ]))).toEqual([
      { user_id: "12345", chat_id: "12345", message_thread_id: null },
      { user_id: "12345", chat_id: "-100123", message_thread_id: 41 },
    ]);
  });

  it("rejects malformed, ambiguous, oversized, or duplicate grants without echoing values", () => {
    const invalid = [
      ["telegram-user", "12345", null],
      ["012345", "12345", null],
      ["12345", "-0", null],
      ["12345", "12345", 0],
      ["12345", "12345", null, "extra-field"],
    ];
    for (const [user_id, chat_id, message_thread_id, extra] of invalid) {
      const entry = extra === undefined
        ? { user_id, chat_id, message_thread_id }
        : { user_id, chat_id, message_thread_id, extra };
      expect(() => parseTelegramInboundGrants(JSON.stringify([entry]))).toThrow("telegram_inbound_grants_config_invalid_entry");
    }

    const duplicate = { user_id: "12345", chat_id: "-100123", message_thread_id: 41 };
    expect(() => parseTelegramInboundGrants(JSON.stringify([duplicate, duplicate])))
      .toThrow("telegram_inbound_grants_config_duplicate_entry");
    expect(() => parseTelegramInboundGrants("{"))
      .toThrow("telegram_inbound_grants_config_invalid_json");
    expect(() => parseTelegramInboundGrants("x".repeat(30_001)))
      .toThrow("telegram_inbound_grants_config_too_large");
  });
});
