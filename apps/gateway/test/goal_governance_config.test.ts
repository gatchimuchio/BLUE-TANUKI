import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HDSUpperController } from "@blue-tanuki/hds-brain";
import { goalGovernanceConfigFromEnvironment } from "../src/goal_governance_config.js";

const DIGEST = "a".repeat(64);

function validConfig() {
  return {
    schema_version: "blue-tanuki.goal-governance.v1",
    goals: [{
      goal_ref: "goal_0123456789abcdef",
      goal_kind: "delegated",
      source_ref: "F:0123456789abcdef",
      initial_purpose_digest: DIGEST,
      initial_interpretation_digest: DIGEST,
      adopted_at: 100,
    }],
    authorizations: [],
    events: [],
  };
}

describe("goalGovernanceConfigFromEnvironment", () => {
  let temporaryRoot: string | undefined;

  afterEach(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  function createStateRoot(): { stateRoot: string; configPath: string } {
    temporaryRoot = mkdtempSync(join(tmpdir(), "blue-tanuki-goal-governance-"));
    const stateRoot = join(temporaryRoot, "state");
    const privateState = join(stateRoot, "private-state");
    mkdirSync(privateState, { recursive: true });
    return { stateRoot, configPath: join(privateState, "goal-governance.json") };
  }

  it("returns undefined when no configured projection source exists", () => {
    const { stateRoot } = createStateRoot();
    expect(goalGovernanceConfigFromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot })).toBeUndefined();
  });

  it("loads a validated projection from private state", () => {
    const { stateRoot, configPath } = createStateRoot();
    const config = validConfig();
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    expect(goalGovernanceConfigFromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot })).toEqual(config);
  });

  it("feeds the configured projection into HDS as non-authority context", () => {
    const { stateRoot, configPath } = createStateRoot();
    writeFileSync(configPath, JSON.stringify(validConfig()), "utf8");
    const config = goalGovernanceConfigFromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot });
    expect(config).toBeDefined();
    const hds = new HDSUpperController({ goal_governance: config });
    const { log } = hds.decide({
      id: "goal-governance-config-smoke",
      channel: "webchat",
      user: "owner-token-holder",
      content: "整理する対象を確認する",
      timestamp: 200,
    });

    expect(log.frame.goal_governance?.goals[0]?.current_version).toBe(1);
    expect(log.frame.goal_governance?.used_for_authority).toBe(false);
  });

  it("rejects raw purpose content and other fields outside the protocol contract", () => {
    const { stateRoot, configPath } = createStateRoot();
    const config = { ...validConfig(), purpose_text: "raw owner purpose" };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    expect(() => goalGovernanceConfigFromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot }))
      .toThrow("goal_governance_config_invalid");
  });

  it("rejects an oversized source before parsing it", () => {
    const { stateRoot, configPath } = createStateRoot();
    writeFileSync(configPath, " ".repeat(1024 * 1024 + 1), "utf8");

    expect(() => goalGovernanceConfigFromEnvironment({ BLUE_TANUKI_STATE_ROOT: stateRoot }))
      .toThrow("goal_governance_config_too_large");
  });
});
