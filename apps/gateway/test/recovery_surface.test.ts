import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRecoverySnapshot } from "../src/recovery_surface.js";

describe("buildRecoverySnapshot", () => {
  it("reports env backup inventory and read-only recovery boundaries without exposing env contents", async () => {
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
      expect(snapshot.mode).toBe("read_only");
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
      expect(snapshot.restore).toEqual({
        execution_available: false,
        factory_reset_available: false,
        provider_reset_available: false,
        connector_reset_available: false,
        destructive_repair_available: false,
      });
      expect(snapshot.authority_boundary).toEqual({
        ui_used_for_authority: false,
        recovery_metadata_used_for_authority: false,
        used_for_authority: false,
      });
      expect(snapshot.evidence_source).toEqual(["CONFIG", "EXTERNAL_EVIDENCE"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
