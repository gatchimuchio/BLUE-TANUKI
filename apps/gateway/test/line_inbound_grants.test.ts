import { describe, expect, it } from "vitest";
import { parseLineInboundGrants } from "../src/line_inbound_grants.js";

describe("LINE inbound grants", () => {
  it("defaults to deny-all and accepts only exact user/group/room identities", () => {
    expect(parseLineInboundGrants(undefined)).toEqual([]);
    expect(parseLineInboundGrants(" ")).toEqual([]);
    expect(parseLineInboundGrants(JSON.stringify([
      { destination: "Ubot", source_type: "user", source_id: "U123", user_id: "U123" },
      { destination: "Ubot", source_type: "group", source_id: "Cgroup", user_id: "U456" },
      { destination: "Ubot", source_type: "room", source_id: "Rroom", user_id: "U789" },
    ]))).toEqual([
      { destination: "Ubot", source_type: "user", source_id: "U123", user_id: "U123" },
      { destination: "Ubot", source_type: "group", source_id: "Cgroup", user_id: "U456" },
      { destination: "Ubot", source_type: "room", source_id: "Rroom", user_id: "U789" },
    ]);
  });

  it("rejects wildcards, role labels, mismatched direct identities, and duplicate grants", () => {
    const invalidEntries: unknown[] = [
      { destination: "*", source_type: "user", source_id: "U123", user_id: "U123" },
      { destination: "Ubot", source_type: "group", source_id: "*", user_id: "U123" },
      { destination: "Ubot", source_type: "user", source_id: "U123", user_id: "U456" },
      { destination: "Ubot", source_type: "user", source_id: "U123", user_id: "U123", role: "owner" },
    ];
    for (const entry of invalidEntries) {
      expect(() => parseLineInboundGrants(JSON.stringify([entry]))).toThrow("line_inbound_grants_config_invalid_entry");
    }
    const grant = { destination: "Ubot", source_type: "room", source_id: "Rroom", user_id: "U123" };
    expect(() => parseLineInboundGrants(JSON.stringify([grant, grant]))).toThrow("line_inbound_grants_config_duplicate_entry");
  });
});
