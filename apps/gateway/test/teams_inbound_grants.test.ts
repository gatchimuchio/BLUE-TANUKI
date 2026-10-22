import { describe, expect, it } from "vitest";
import { parseTeamsInboundGrants } from "../src/teams_inbound_grants.js";

const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";

describe("Teams inbound admission grants", () => {
  it("treats missing grants as deny-all and keeps exact tenant, conversation, and user scope", () => {
    expect(parseTeamsInboundGrants(undefined)).toEqual([]);
    expect(parseTeamsInboundGrants("  ")).toEqual([]);
    expect(parseTeamsInboundGrants(JSON.stringify([
      {
        tenant_id: tenant.toUpperCase(), conversation_id: "19:personal@thread.v2",
        conversation_type: "personal", user_id: "29:owner", team_id: null, channel_id: null,
      },
      {
        tenant_id: tenant, conversation_id: "19:channel@thread.v2",
        conversation_type: "channel", user_id: "29:owner", team_id: "team-id", channel_id: "channel-id",
      },
    ]))).toEqual([
      {
        tenant_id: tenant, conversation_id: "19:personal@thread.v2",
        conversation_type: "personal", user_id: "29:owner", team_id: null, channel_id: null,
      },
      {
        tenant_id: tenant, conversation_id: "19:channel@thread.v2",
        conversation_type: "channel", user_id: "29:owner", team_id: "team-id", channel_id: "channel-id",
      },
    ]);
  });

  it("rejects malformed, duplicate, shared-space-incomplete, and oversized entries", () => {
    const valid = {
      tenant_id: tenant, conversation_id: "19:conversation@thread.v2",
      conversation_type: "channel", user_id: "29:owner", team_id: "team-id", channel_id: "channel-id",
    };
    expect(() => parseTeamsInboundGrants("[]{}" )).toThrow("teams_inbound_grants_config_invalid_json");
    expect(() => parseTeamsInboundGrants(JSON.stringify({ tenant_id: tenant })))
      .toThrow("teams_inbound_grants_config_invalid_shape");
    expect(() => parseTeamsInboundGrants(JSON.stringify([valid, valid])))
      .toThrow("teams_inbound_grants_config_duplicate_entry");
    expect(() => parseTeamsInboundGrants(JSON.stringify([{ ...valid, display_name: "mutable" }])))
      .toThrow("teams_inbound_grants_config_invalid_entry");
    expect(() => parseTeamsInboundGrants(JSON.stringify([{ ...valid, channel_id: null }])))
      .toThrow("teams_inbound_grants_config_invalid_entry");
    expect(() => parseTeamsInboundGrants(JSON.stringify([{ ...valid, tenant_id: "not-a-tenant" }])))
      .toThrow("teams_inbound_grants_config_invalid_entry");
    expect(() => parseTeamsInboundGrants("x".repeat(60_001)))
      .toThrow("teams_inbound_grants_config_too_large");
  });
});
