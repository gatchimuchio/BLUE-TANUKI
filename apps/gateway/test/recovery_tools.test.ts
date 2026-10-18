import { describe, expect, it } from "vitest";
import { createRecoveryMutationTools, normalizeRecoveryMutationArguments } from "../src/recovery_tools.js";

describe("Recovery mutation tool boundary", () => {
  it("registers only the four catalogued mutations with their exact capabilities", () => {
    const tools = createRecoveryMutationTools({});
    expect(tools.map((tool) => tool.name)).toEqual([
      "recovery.restore",
      "recovery.reset_provider",
      "recovery.reset_connector",
      "recovery.factory_reset",
    ]);
    expect(tools.find((tool) => tool.name === "recovery.restore")?.required_capabilities).toEqual([
      "tool:recovery.restore",
      "recovery:restore",
      "fs:write",
      "fs:delete",
    ]);
  });

  it("binds restore approval to one resolved backup identity and rejects extra arguments", () => {
    expect(normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "latest",
      confirm: "RESTORE",
    }, { latestBackupId: "2026-10-18.backup.abc" })).toEqual({
      backup_id: "2026-10-18.backup.abc",
      confirm: "RESTORE",
    });
    expect(normalizeRecoveryMutationArguments("recovery.restore", {
      confirm: "RESTORE",
    }, { latestBackupId: "2026-10-18.backup.abc" }).backup_id).toBe("2026-10-18.backup.abc");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "latest",
      confirm: "RESTORE",
    })).toThrow("backup_not_found");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      confirm: "RESTORE",
      force: true,
    })).toThrow("invalid_recovery_request");
    expect(() => normalizeRecoveryMutationArguments("recovery.reset_provider", {
      confirm: "RESET_PROVIDER",
      target: "another-provider",
    })).toThrow("invalid_recovery_request");
  });
});
