import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRecoverySnapshot,
  createRecoveryBackup,
  factoryResetRecovery,
  inspectLatestRecoveryBackup,
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

      const inspection = await inspectLatestRecoveryBackup(env);
      expect(inspection).toMatchObject({
        surface: "recovery_backup_inspection",
        mode: "read_only",
        status: "verified",
        backup_id_digest: createHash("sha256").update(backup.backup_id!).digest("hex"),
        coverage: "complete_for_configured_targets",
        canonical_state_coverage: "not_included",
        used_for_authority: false,
        may_execute: false,
      });
      expect(inspection.copied_required_item_count).toBe(inspection.configured_required_item_count);
      expect(JSON.stringify(inspection)).not.toContain("provider-secret-value");
      expect(JSON.stringify(inspection)).not.toContain("connector-secret-value");

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
  }, 15_000);

  it("inspects recovery pack integrity without changing the pack and reports tampering without details", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-inspection-"));
    try {
      const envFile = path.join(root, "product.env");
      const recoveryDir = path.join(root, "recovery");
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      const env = { BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_RECOVERY_DIR: recoveryDir };
      const missing = await inspectLatestRecoveryBackup(env);
      expect(missing).toMatchObject({
        status: "not_found",
        backup_id_digest: null,
        canonical_state_coverage: "not_included",
        used_for_authority: false,
        may_execute: false,
      });

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifestBefore = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestBefore) as { items: Array<{ copied: boolean; archive_path: string | null; kind: string }> };
      const archive = manifest.items.find((item) => item.copied && item.kind === "file" && item.archive_path);
      expect(archive?.archive_path).toBeTruthy();
      const originalArchive = await readFile(archive!.archive_path!, "utf8");

      const verified = await inspectLatestRecoveryBackup(env);
      expect(verified.status).toBe("verified");
      expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
      expect(await readFile(archive!.archive_path!, "utf8")).toBe(originalArchive);

      await writeFile(manifestPath, `${manifestBefore}\n`, "utf8");
      const invalidManifest = await inspectLatestRecoveryBackup(env);
      expect(invalidManifest.status).toBe("invalid");
      expect(JSON.stringify(invalidManifest)).not.toContain(manifestPath);
      await writeFile(manifestPath, manifestBefore, "utf8");

      await writeFile(archive!.archive_path!, `${originalArchive}tampered\n`, "utf8");
      const invalid = await inspectLatestRecoveryBackup(env);
      expect(invalid).toMatchObject({
        status: "invalid",
        coverage: "unknown",
        configured_required_item_count: null,
        copied_required_item_count: null,
        missing_required_item_count: null,
        canonical_state_coverage: "not_included",
        used_for_authority: false,
        may_execute: false,
      });
      expect(JSON.stringify(invalid)).not.toContain("tampered");
      expect(JSON.stringify(invalid)).not.toContain(archive!.archive_path!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe recovery env paths before destructive reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-unsafe-"));
    try {
      const envFile = path.join(root, "product.env");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");

      await expect(
        factoryResetRecovery({
          BLUE_TANUKI_ENV_FILE: envFile,
          BLUE_TANUKI_FILE_ROOT: fileRoot,
          BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
          BLUE_TANUKI_SESSION_DIR: os.homedir(),
          BLUE_TANUKI_MEMORY_DIR: path.join(os.homedir(), ".config"),
        }, { confirm: "FACTORY_RESET" }),
      ).rejects.toThrow(/unsafe_runtime_target/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore manifests that rewrite source_path outside configured runtime targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-manifest-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await writeFile(path.join(sessionDir, "session.jsonl"), "session\n", "utf8");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
      };

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.items[0].source_path = os.homedir();
      const tampered = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, tampered, "utf8");
      const digest = createHash("sha256").update(tampered).digest("hex");
      await writeFile(`${manifestPath}.sha256`, `${digest}  manifest.json\n`, "utf8");

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/source_path_mismatch|unsafe_runtime_target/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative restore manifest paths and symlink runtime targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-symlink-"));
    try {
      const envFile = path.join(root, "product.env");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const outside = path.join(root, "outside");
      const link = path.join(root, "session-link");
      await mkdir(fileRoot);
      await mkdir(outside);
      await writeFile(envFile, "LLM_BACKEND=stub\n", "utf8");
      await symlink(outside, link, "dir");

      await expect(
        createRecoveryBackup({
          BLUE_TANUKI_ENV_FILE: envFile,
          BLUE_TANUKI_FILE_ROOT: fileRoot,
          BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
          BLUE_TANUKI_SESSION_DIR: link,
        }),
      ).rejects.toThrow(/symlink/);

      const sessionDir = path.join(root, "sessions");
      await mkdir(sessionDir);
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
      };
      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.items[0].source_path = "../escape";
      const tampered = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, tampered, "utf8");
      const digest = createHash("sha256").update(tampered).digest("hex");
      await writeFile(`${manifestPath}.sha256`, `${digest}  manifest.json\n`, "utf8");

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/source_path_mismatch|relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights every archive before creating a pre-restore pack or changing targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-preflight-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=before\n", "utf8");
      await writeFile(sessionFile, "session-before\n", "utf8");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
      };

      const backup = await createRecoveryBackup(env);
      const manifestPath = backup.backup_manifest_path!;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const sessionItem = manifest.items.find((item: { key: string }) => item.key === "session_dir");
      const packDir = path.dirname(manifestPath);
      const sessionArchive = path.join(packDir, sessionItem.archive_rel_path, "session.jsonl");
      await writeFile(sessionArchive, "corrupted-archive\n", "utf8");

      await writeFile(envFile, "LLM_BACKEND=after\n", "utf8");
      await writeFile(sessionFile, "session-after\n", "utf8");
      const packsBeforeRestore = await readdir(recoveryDir);

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow(/invalid_backup_manifest_archive_digest:session_dir/);

      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=after\n");
      expect(await readFile(sessionFile, "utf8")).toBe("session-after\n");
      expect(await readdir(recoveryDir)).toEqual(packsBeforeRestore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks inside directory archives before restoring any target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-archive-link-"));
    try {
      const envFile = path.join(root, "product.env");
      const sessionDir = path.join(root, "sessions");
      const fileRoot = path.join(root, "files");
      const recoveryDir = path.join(root, "recovery");
      const outsideFile = path.join(root, "outside.json");
      await mkdir(sessionDir);
      await mkdir(fileRoot);
      await writeFile(envFile, "LLM_BACKEND=before\n", "utf8");
      await writeFile(outsideFile, "outside\n", "utf8");
      await symlink(outsideFile, path.join(sessionDir, "linked.json"), "file");
      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_FILE_ROOT: fileRoot,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
      };

      const backup = await createRecoveryBackup(env);
      await writeFile(envFile, "LLM_BACKEND=after\n", "utf8");
      const packsBeforeRestore = await readdir(recoveryDir);

      await expect(
        restoreRecoveryBackup(env, { backup_id: backup.backup_id, confirm: "RESTORE" }),
      ).rejects.toThrow("invalid_backup_manifest_archive_symlink");

      expect(await readFile(envFile, "utf8")).toBe("LLM_BACKEND=after\n");
      expect(await readdir(recoveryDir)).toEqual(packsBeforeRestore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
