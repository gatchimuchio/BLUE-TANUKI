import { describe, expect, it } from "vitest";
import {
  canonicalStoreRestoreConsumersNotQuiesced,
  createRecoveryMutationTools,
  normalizeRecoveryMutationArguments,
} from "../src/recovery_tools.js";

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
    expect(normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "operation_plan",
      scope_digest: "a".repeat(64),
      confirm: "RESTORE",
    })).toEqual({
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "operation_plan",
      scope_digest: "a".repeat(64),
      confirm: "RESTORE",
    });
    expect(normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "task_identity",
      scope_digest: "b".repeat(64),
      confirm: "RESTORE",
    })).toEqual({
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "task_identity",
      scope_digest: "b".repeat(64),
      confirm: "RESTORE",
    });
    expect(normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "broker",
      scope_kind: "task_identity",
      scope_digest: "c".repeat(64),
      confirm: "RESTORE",
    })).toEqual({
      backup_id: "2026-10-18.backup.abc",
      store_key: "broker",
      scope_kind: "task_identity",
      scope_digest: "c".repeat(64),
      confirm: "RESTORE",
    });
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "broker",
      scope_kind: "operation_plan",
      scope_digest: "c".repeat(64),
      confirm: "RESTORE",
    })).toThrow("broker_restore_task_scope_required");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "broker",
      scope_kind: "task_identity",
      scope_digest: "not-a-digest",
      confirm: "RESTORE",
    })).toThrow("broker_restore_task_scope_invalid");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      confirm: "RESTORE",
    })).toThrow("operation_plan_scope_required");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "operation_plan",
      scope_digest: "not-a-digest",
      confirm: "RESTORE",
    })).toThrow("operation_plan_scope_invalid");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "operation_plans",
      scope_kind: "task_identity",
      scope_digest: "not-a-digest",
      confirm: "RESTORE",
    })).toThrow("operation_plan_task_scope_invalid");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "j_control",
      scope_kind: "operation_plan",
      scope_digest: "a".repeat(64),
      confirm: "RESTORE",
    })).toThrow("invalid_recovery_request");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "unknown_store",
      confirm: "RESTORE",
    })).toThrow("invalid_store_key");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "latest",
      confirm: "RESTORE",
    })).toThrow("backup_not_found");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      confirm: "RESTORE",
      force: true,
    })).toThrow("invalid_recovery_request");
    expect(() => normalizeRecoveryMutationArguments("recovery.restore", {
      backup_id: "2026-10-18.backup.abc",
      store_key: "broker",
      executor_command_key: "a".repeat(64),
      confirm: "RESTORE",
    })).toThrow("invalid_recovery_request");
    expect(() => normalizeRecoveryMutationArguments("recovery.reset_provider", {
      confirm: "RESET_PROVIDER",
      target: "another-provider",
    })).toThrow("invalid_recovery_request");
  });

  it("requires a live quiesce receipt for J/M and Cron selected-store restore", async () => {
    expect(canonicalStoreRestoreConsumersNotQuiesced("j_control")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("m_state")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("broker")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("cron_events")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("operation_plans")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("meaning_update_j_control")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced("meaning_update_m_state")).toEqual([]);
    expect(canonicalStoreRestoreConsumersNotQuiesced(undefined)).toEqual([]);

    const restore = createRecoveryMutationTools({}, undefined, { canonicalStoreRestoreQuiesced: () => false })
      .find((tool) => tool.name === "recovery.restore");
    const arguments_ = { backup_id: "fixture", store_key: "broker", confirm: "RESTORE" };
    await expect(restore?.invoke(arguments_))
      .rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    await expect(restore?.invoke(arguments_, {
      command_id: "fixture-restore",
      upstream_commit_hash: "fixture-commit",
      idempotency_key: "a".repeat(64),
    })).rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    const quiescedRestore = createRecoveryMutationTools({}, undefined, {
      canonicalStoreRestoreQuiesced: (storeKey) => storeKey === "broker",
    }).find((tool) => tool.name === "recovery.restore");
    await expect(quiescedRestore?.invoke(arguments_, {
      command_id: "fixture-restore",
      upstream_commit_hash: "fixture-commit",
      idempotency_key: "a".repeat(64),
    })).rejects.toThrow("broker_restore_execution_store_unavailable");
    await expect(restore?.invoke({ backup_id: "fixture", store_key: "cron_events", confirm: "RESTORE" }))
      .rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    await expect(restore?.invoke({ backup_id: "fixture", store_key: "j_control", confirm: "RESTORE" }))
      .rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    await expect(restore?.invoke({ backup_id: "fixture", store_key: "m_state", confirm: "RESTORE" }))
      .rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    await expect(restore?.invoke({ backup_id: "fixture", store_key: "meaning_update_j_control", confirm: "RESTORE" }))
      .rejects.toThrow("canonical_state_restore_consumers_not_quiesced");
    const meaningRestore = createRecoveryMutationTools({}, undefined, {
      canonicalStoreRestoreQuiesced: (storeKey) => storeKey === "meaning_update_j_control",
    }).find((tool) => tool.name === "recovery.restore");
    await expect(meaningRestore?.invoke({ backup_id: "fixture", store_key: "meaning_update_j_control", confirm: "RESTORE" }))
      .rejects.toThrow("recovery_mutation_failed");
  });
});
