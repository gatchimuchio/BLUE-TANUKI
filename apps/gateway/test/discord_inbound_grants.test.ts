import { describe, expect, it } from "vitest";
import { parseDiscordInboundGrants } from "../src/discord_inbound_grants.js";

describe("parseDiscordInboundGrants", () => {
  it("treats missing grants as deny-all and preserves only exact guild/channel/user tuples", () => {
    expect(parseDiscordInboundGrants(undefined)).toEqual([]);
    expect(parseDiscordInboundGrants("  ")).toEqual([]);
    expect(parseDiscordInboundGrants(JSON.stringify([
      { guild_id: "444", channel_id: "777", user_id: "888" },
      { guild_id: null, channel_id: "779", user_id: "889" },
    ]))).toEqual([
      { guild_id: "444", channel_id: "777", user_id: "888" },
      { guild_id: null, channel_id: "779", user_id: "889" },
    ]);
  });

  it("rejects malformed, duplicate, oversized, and extra-field grants", () => {
    expect(() => parseDiscordInboundGrants("[]{}")).toThrow("discord_inbound_grants_config_invalid_json");
    expect(() => parseDiscordInboundGrants(JSON.stringify({ guild_id: "444" })))
      .toThrow("discord_inbound_grants_config_invalid_shape");
    const grant = { guild_id: "444", channel_id: "777", user_id: "888" };
    expect(() => parseDiscordInboundGrants(JSON.stringify([grant, grant])))
      .toThrow("discord_inbound_grants_config_duplicate_entry");
    expect(() => parseDiscordInboundGrants(JSON.stringify([{ ...grant, user_display: "owner" }])))
      .toThrow("discord_inbound_grants_config_invalid_entry");
    expect(() => parseDiscordInboundGrants(JSON.stringify([{ ...grant, channel_id: "99999999999999999999" }])))
      .toThrow("discord_inbound_grants_config_invalid_entry");
    expect(() => parseDiscordInboundGrants("x".repeat(30_001)))
      .toThrow("discord_inbound_grants_config_too_large");
  });
});
