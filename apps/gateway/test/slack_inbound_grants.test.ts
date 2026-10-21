import { describe, expect, it } from "vitest";
import { parseSlackInboundGrants } from "../src/slack_inbound_grants.js";

describe("Slack inbound owner grants", () => {
  it("defaults to deny-all and parses exact root and thread scopes", () => {
    expect(parseSlackInboundGrants(undefined)).toEqual([]);
    expect(parseSlackInboundGrants("  ")).toEqual([]);
    expect(parseSlackInboundGrants(JSON.stringify([
      { team_id: "T1", channel_id: "D123", user_id: "U7", thread_ts: null },
      { team_id: "T1", channel_id: "C9", user_id: "W8", thread_ts: "111.222" },
    ]))).toEqual([
      { team_id: "T1", channel_id: "D123", user_id: "U7", thread_ts: null },
      { team_id: "T1", channel_id: "C9", user_id: "W8", thread_ts: "111.222" },
    ]);
  });

  it("rejects malformed, ambiguous, oversized, or duplicate grants without echoing values", () => {
    const invalid = [
      { team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: "root" },
      { team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: null, extra: true },
      { team_id: "*", channel_id: "C1", user_id: "U1", thread_ts: null },
      { team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: "01.2" },
    ];
    for (const entry of invalid) {
      expect(() => parseSlackInboundGrants(JSON.stringify([entry])))
        .toThrow("slack_inbound_grants_config_invalid_entry");
    }
    const duplicate = { team_id: "T1", channel_id: "C1", user_id: "U1", thread_ts: null };
    expect(() => parseSlackInboundGrants(JSON.stringify([duplicate, duplicate])))
      .toThrow("slack_inbound_grants_config_duplicate_entry");
    expect(() => parseSlackInboundGrants("{")).toThrow("slack_inbound_grants_config_invalid_json");
    expect(() => parseSlackInboundGrants("x".repeat(30_001)))
      .toThrow("slack_inbound_grants_config_too_large");
  });
});
