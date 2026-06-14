import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildUpdateSnapshot,
  prepareManualUpdate,
  verifyUpdateCandidate,
} from "../src/update_surface.js";

const CORE_PATHS = [
  "packages/hds-brain",
  "packages/protocol",
  "packages/blue-tanuki",
  "packages/channel-base",
  "packages/channel-webchat",
  "packages/channel-telegram",
  "packages/operator-writing",
  "packages/operator-daily",
  "packages/operator-developer",
  "apps/gateway",
] as const;

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function writeReleaseCandidate(root: string, version: string, content = "bundle-data"): Promise<string> {
  const releaseDir = path.join(root, "release");
  await mkdir(releaseDir, { recursive: true });
  const archivePath = path.join(releaseDir, `blue-tanuki-${version}-source-bundle.tar.gz`);
  await writeFile(archivePath, content, "utf8");
  const bytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = archivePath.slice(0, -".tar.gz".length);
  const shaPath = `${base}.sha256`;
  const manifestPath = `${base}.manifest.json`;
  await writeFile(shaPath, `${sha256}  ${path.basename(archivePath)}\n`, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schema_version: 1,
      name: "blue-tanuki",
      version,
      archive: {
        file: path.basename(archivePath),
        size_bytes: bytes.length,
        sha256,
      },
      sha256_file: path.basename(shaPath),
      core_release_paths: CORE_PATHS,
      boundaries: {
        unsigned_source_bundle: true,
        secrets_included: false,
        external_dynamic_imports_included: false,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return archivePath;
}

describe("update surface", () => {
  it("verifies release sidecars, creates pre-update backup, and records a non-authority rollback plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-update-"));
    try {
      const version = "1.0.0-rc.1";
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version }), "utf8");
      await mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
      await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      await writeFile(path.join(root, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`, "utf8");
      const archivePath = await writeReleaseCandidate(root, version);

      const envFile = path.join(root, "product.env");
      const auditDir = path.join(root, "audit");
      const sessionDir = path.join(root, "sessions");
      const updateDir = path.join(root, "update");
      const recoveryDir = path.join(root, "recovery");
      await mkdir(auditDir);
      await mkdir(sessionDir);
      await writeFile(path.join(auditDir, "audit.jsonl"), "{}\n", "utf8");
      await writeFile(path.join(sessionDir, "session.jsonl"), "session-before\n", "utf8");
      await writeFile(envFile, "LLM_BACKEND=stub\nLLM_API_KEY=update-secret-value\n", "utf8");

      const env = {
        BLUE_TANUKI_ENV_FILE: envFile,
        BLUE_TANUKI_AUDIT_DIR: auditDir,
        BLUE_TANUKI_SESSION_DIR: sessionDir,
        BLUE_TANUKI_UPDATE_DIR: updateDir,
        BLUE_TANUKI_RECOVERY_DIR: recoveryDir,
        BLUE_TANUKI_UPDATE_BUNDLE: archivePath,
      };

      const snapshot = await buildUpdateSnapshot(root, env);
      expect(snapshot.surface).toBe("update");
      expect(snapshot.mode).toBe("manual_control");
      expect(snapshot.candidate).toMatchObject({
        exists: true,
        sha256_matches: true,
        manifest_matches: true,
        version,
        verification_status: "pass",
        secret_material: false,
      });
      expect(snapshot.distribution_boundary).toMatchObject({
        signed_native_installer_shipped: false,
        automatic_updater_shipped: false,
        runtime_auto_apply_available: false,
        manual_update_only: true,
      });
      expect(snapshot.authority_boundary.used_for_authority).toBe(false);

      const verify = await verifyUpdateCandidate(root, env);
      expect(verify.candidate.verification_status).toBe("pass");
      expect(JSON.stringify(verify)).not.toContain("update-secret-value");

      const prepared = await prepareManualUpdate(root, env, { confirm: "PRE_UPDATE_BACKUP" });
      expect(prepared.action).toBe("prepare_update");
      expect(prepared.pre_update_backup_id).toBeTruthy();
      expect(prepared.rollback_plan_id).toBeTruthy();
      expect(prepared.rollback_plan_path).toBeTruthy();
      expect(prepared.used_for_authority).toBe(false);
      expect(JSON.stringify(prepared)).not.toContain("update-secret-value");
      expect(await exists(prepared.rollback_plan_path!)).toBe(true);

      const plan = JSON.parse(await readFile(prepared.rollback_plan_path!, "utf8")) as {
        pre_update_backup_id?: string;
        current_git_head?: string;
        candidate_verified?: boolean;
        authority_boundary?: { used_for_authority?: boolean };
      };
      expect(plan.pre_update_backup_id).toBe(prepared.pre_update_backup_id);
      expect(plan.current_git_head).toBe("1".repeat(40));
      expect(plan.candidate_verified).toBe(true);
      expect(plan.authority_boundary?.used_for_authority).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the release checksum sidecar does not match", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-update-bad-sha-"));
    try {
      const version = "1.0.0-rc.1";
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version }), "utf8");
      const archivePath = await writeReleaseCandidate(root, version);
      await writeFile(archivePath.slice(0, -".tar.gz".length) + ".sha256", `${"0".repeat(64)}  bad\n`, "utf8");

      const env = { BLUE_TANUKI_UPDATE_BUNDLE: archivePath };
      const verify = await verifyUpdateCandidate(root, env);
      expect(verify.candidate.verification_status).toBe("fail");
      expect(verify.candidate.sha256_matches).toBe(false);
      expect(verify.candidate.failure_reason).toContain("sha256");
      expect(verify.used_for_authority).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
