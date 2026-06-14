import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRecoverySnapshot,
  createRecoveryBackup,
  factoryResetRecovery,
  resetRecoveryConnector,
  resetRecoveryProvider,
  restoreRecoveryBackup,
} from "../src/recovery_surface.js";

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

describe("buildRecoverySnapshot", () => {
  it("reports env backup inventory and recovery control boundaries without exposing env contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const memoryDir = path.join(root, "memory");
      const memoryFile = path.join(memoryDir, "memory.jsonl");
      const failureMemoryDir = path.join(root, "failure-memory");
      const schedulesDir = path.join(root, "schedules");
      const fileRoot = path.join(root, "files");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await mkdir(memoryDir);
      await mkdir(failureMemoryDir);
      await mkdir(schedulesDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_API_KEY=secret-value\n", "utf8");
      await writeFile(memoryFile, "{}\n", "utf8");
      await writeFile(`${envFile}.2026-06-13T01-00-00-000Z.101.settings.bak`, "older\n", "utf8");
      await writeFile(`${envFile}.2026-06-13T02-00-00-000Z.101.setup.bak`, "newer\n", "utf8");

      const snapshot = await buildRecoverySnapshot({
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_MEMORY_FILE: memoryFile,
        BLUE_TANUKI_MEMORY_DIR: memoryDir,
        BLUE_TANUKI_FAILURE_MEMORY_DIR: failureMemoryDir,
        BLUE_TANUKI_SCHEDULES_DIR: schedulesDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
      });

      expect(snapshot.surface).toBe("recovery");
      expect(snapshot.mode).toBe("control_available");
      expect(snapshot.env_file).toMatchObject({
        configured: true,
        path: envFile,
        exists: true,
        backup_count: 2,
        secret_material: true,
      });
      expect(snapshot.env_file.latest_backup_path).toContain("setup.bak");
      expect(JSON.stringify(snapshot)).not.toContain("secret-value");
      expect(snapshot.runtime_paths.audit_dir).toMatchObject({
        configured: true,
        path: auditDir,
        exists: true,
        kind: "directory",
      });
      expect(snapshot.runtime_paths.memory_file).toMatchObject({
        configured: true,
        path: memoryFile,
        exists: true,
        kind: "file",
      });
      expect(snapshot.restore).toMatchObject({
        execution_available: false,
        backup_available: true,
        latest_backup_id: null,
        factory_reset_available: true,
        provider_reset_available: true,
        connector_reset_available: true,
        destructive_repair_available: false,
        confirmation_required: true,
      });
      expect(snapshot.authority_boundary).toEqual({
        ui_used_for_authority: false,
        recovery_metadata_used_for_authority: false,
        recovery_action_used_for_authority: false,
        used_for_authority: false,
      });
      expect(snapshot.evidence_source).toEqual(["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up, restores, resets providers/connectors, and preserves audit on factory reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-actions-"));
    try {
      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const memoryDir = path.join(root, "memory");
      const memoryFile = path.join(memoryDir, "memory.jsonl");
      const failureMemoryDir = path.join(root, "failure-memory");
      const schedulesDir = path.join(root, "schedules");
      const logsDir = path.join(root, "logs");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await mkdir(memoryDir);
      await mkdir(failureMemoryDir);
      await mkdir(schedulesDir);
      await mkdir(logsDir);
      await mkdir(fileRoot);
      await writeFile(path.join(auditDir, "audit.jsonl"), "{}\n", "utf8");
      await writeFile(sessionFile, "session-before\n", "utf8");
      await writeFile(memoryFile, "memory-before\n", "utf8");
      await writeFile(path.join(failureMemoryDir, "failure.jsonl"), "failure-before\n", "utf8");
      await writeFile(path.join(schedulesDir, "jobs.json"), "[]\n", "utf8");
      await writeFile(path.join(logsDir, "gateway.log"), "log-before\n", "utf8");
      await writeFile(
        envFile,
        [
          "LLM_BACKEND=openrouter",
          "OPENROUTER_API_KEY=provider-secret-value",
          "OPENROUTER_MODEL=openrouter/model",
          "COMPOSIO_API_KEY=connector-secret-value",
          "COMPOSIO_ALLOWED_TOOLKITS=github",
          "COMPOSIO_ALLOWED_ACTIONS=github:GITHUB_CREATE_AN_ISSUE",
          "COMPOSIO_DRY_RUN=false",
          "COMPOSIO_LIVE_EXECUTION=true",
          "",
        ].join("\n"),
        "utf8",
      );

      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_MEMORY_FILE: memoryFile,
        BLUE_TANUKI_MEMORY_DIR: memoryDir,
        BLUE_TANUKI_FAILURE_MEMORY_DIR: failureMemoryDir,
        BLUE_TANUKI_SCHEDULES_DIR: schedulesDir,
        BLUE_TANUKI_LOG_DIR: logsDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        LLM_BACKEND: "openrouter",
        OPENROUTER_API_KEY: "provider-secret-value",
        COMPOSIO_API_KEY: "connector-secret-value",
        COMPOSIO_DRY_RUN: "false",
        COMPOSIO_LIVE_EXECUTION: "true",
      };

      const backup = await createRecoveryBackup(env);
      expect(backup.action).toBe("backup");
      expect(backup.backup_id).toBeTruthy();
      expect(JSON.stringify(backup)).not.toContain("provider-secret-value");
      expect(JSON.stringify(backup)).not.toContain("connector-secret-value");

      await writeFile(envFile, "LLM_BACKEND=broken\n", "utf8");
      await writeFile(sessionFile, "session-after\n", "utf8");
      const restored = await restoreRecoveryBackup(env, {
        backup_id: backup.backup_id,
        confirm: "RESTORE",
      });
      expect(restored.restored_items_count).toBeGreaterThan(0);
      expect(await readFile(envFile, "utf8")).toContain("OPENROUTER_API_KEY=provider-secret-value");
      expect(await readFile(sessionFile, "utf8")).toBe("session-before\n");
      expect(JSON.stringify(restored)).not.toContain("provider-secret-value");

      const providerReset = await resetRecoveryProvider(env, { confirm: "RESET_PROVIDER" });
      const providerEnv = await readFile(envFile, "utf8");
      expect(providerEnv).toContain("LLM_BACKEND=stub");
      expect(providerEnv).not.toContain("OPENROUTER_API_KEY=");
      expect(providerEnv).not.toContain("provider-secret-value");
      expect(providerReset.reset_keys).toContain("OPENROUTER_API_KEY");
      expect(JSON.stringify(providerReset)).not.toContain("provider-secret-value");

      const connectorReset = await resetRecoveryConnector(env, { confirm: "RESET_CONNECTOR" });
      const connectorEnv = await readFile(envFile, "utf8");
      expect(connectorEnv).toContain("COMPOSIO_DRY_RUN=true");
      expect(connectorEnv).toContain("COMPOSIO_LIVE_EXECUTION=false");
      expect(connectorEnv).not.toContain("COMPOSIO_API_KEY=");
      expect(connectorEnv).not.toContain("connector-secret-value");
      expect(connectorReset.reset_keys).toContain("COMPOSIO_API_KEY");

      await mkdir(sessionDir, { recursive: true });
      await mkdir(memoryDir, { recursive: true });
      await mkdir(failureMemoryDir, { recursive: true });
      await mkdir(schedulesDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeFile(sessionFile, "session-reset\n", "utf8");
      await writeFile(memoryFile, "memory-reset\n", "utf8");
      await writeFile(path.join(schedulesDir, "jobs.json"), "[]\n", "utf8");
      await writeFile(path.join(logsDir, "gateway.log"), "log-reset\n", "utf8");

      const factory = await factoryResetRecovery(env, { confirm: "FACTORY_RESET" });
      expect(factory.action).toBe("factory_reset");
      expect(await exists(sessionDir)).toBe(false);
      expect(await exists(memoryDir)).toBe(false);
      expect(await exists(schedulesDir)).toBe(false);
      expect(await exists(logsDir)).toBe(false);
      expect(await exists(auditDir)).toBe(true);
      expect(await exists(recoveryDir)).toBe(true);
      expect(JSON.stringify(factory)).not.toContain("provider-secret-value");
      expect(JSON.stringify(factory)).not.toContain("connector-secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
