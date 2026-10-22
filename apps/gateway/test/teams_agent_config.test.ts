import { describe, expect, it } from "vitest";
import { teamsAgentCredentialsFromEnvironment } from "../src/teams_agent_config.js";

describe("Teams agent listener configuration", () => {
  it("keeps ingress disabled when all credentials are absent", () => {
    expect(teamsAgentCredentialsFromEnvironment({})).toBeNull();
  });

  it("requires a complete single-tenant credential tuple", () => {
    expect(teamsAgentCredentialsFromEnvironment({
      TEAMS_AGENT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
      TEAMS_AGENT_CLIENT_SECRET: "synthetic-secret",
      TEAMS_AGENT_TENANT_ID: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    })).toEqual({
      client_id: "11111111-2222-4333-8444-555555555555",
      client_secret: "synthetic-secret",
      tenant_id: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    });
    expect(() => teamsAgentCredentialsFromEnvironment({ TEAMS_AGENT_CLIENT_ID: "11111111-2222-4333-8444-555555555555" }))
      .toThrow("teams_agent_auth_configuration_incomplete");
    expect(() => teamsAgentCredentialsFromEnvironment({
      TEAMS_AGENT_CLIENT_ID: "invalid",
      TEAMS_AGENT_CLIENT_SECRET: "synthetic-secret",
      TEAMS_AGENT_TENANT_ID: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    })).toThrow("teams_agent_auth_configuration_invalid");
  });
});
