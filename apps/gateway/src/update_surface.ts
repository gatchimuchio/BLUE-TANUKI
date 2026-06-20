import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PRODUCT_SCOPE_CORE_RELEASE_PATHS } from "@blue-tanuki/protocol";
import { createRecoveryBackup } from "./recovery_surface.js";

export type UpdateEvidenceSource = readonly ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"];

export interface UpdateAuthorityBoundary {
  ui_used_for_authority: false;
  update_metadata_used_for_authority: false;
  rollback_plan_used_for_authority: false;
  recovery_backup_used_for_authority: false;
  used_for_authority: false;
}

export interface UpdateCandidateStatus {
  configured: boolean;
  archive_path: string | null;
  exists: boolean;
  sha256_path: string | null;
  sha256_exists: boolean;
  manifest_path: string | null;
  manifest_exists: boolean;
  archive_sha256: string | null;
  sha256_matches: boolean;
  manifest_matches: boolean;
  version: string | null;
  verification_status: "pass" | "fail" | "missing" | "not_configured";
  failure_reason: string | null;
  secret_material: false;
}

export interface UpdateSnapshot {
  schema_version: 1;
  surface: "update";
  mode: "manual_control";
  package: {
    current_version: string;
    current_git_head: string | null;
  };
  candidate: UpdateCandidateStatus;
  compatibility: {
    current_data_schema_version: 1;
    minimum_supported_data_schema_version: 1;
    candidate_manifest_schema_version: number | null;
    migration_required: boolean;
    migration_supported: boolean;
    status: "pass" | "blocked" | "unknown";
  };
  rollback: {
    pre_update_backup_available: boolean;
    latest_plan_path: string | null;
    latest_plan_id: string | null;
    rollback_requires_manual_app_restore: true;
  };
  distribution_boundary: {
    signed_native_installer_shipped: false;
    automatic_updater_shipped: false;
    runtime_auto_apply_available: false;
    manual_update_only: true;
  };
  authority_boundary: UpdateAuthorityBoundary;
  next_safe_action: string;
  evidence_source: UpdateEvidenceSource;
}

export interface UpdateActionResult {
  schema_version: 1;
  surface: "update";
  action: "verify_candidate" | "prepare_update";
  status: "completed";
  candidate: UpdateCandidateStatus;
  rollback_plan_id?: string;
  rollback_plan_path?: string;
  pre_update_backup_id?: string;
  pre_update_backup_manifest_path?: string;
  authority_boundary: UpdateAuthorityBoundary;
  used_for_authority: false;
  hds_brain_remains_authority: true;
  evidence_source: UpdateEvidenceSource;
  next_safe_action: string;
}

export interface PrepareUpdateOptions {
  confirm?: string;
}

interface PackageJson {
  version?: unknown;
}

interface ReleaseManifest {
  schema_version?: unknown;
  name?: unknown;
  version?: unknown;
  archive?: {
    file?: unknown;
    size_bytes?: unknown;
    sha256?: unknown;
  };
  sha256_file?: unknown;
  core_release_paths?: unknown;
  boundaries?: {
    unsigned_source_bundle?: unknown;
    secrets_included?: unknown;
    external_dynamic_imports_included?: unknown;
  };
}

interface CandidateVerification {
  status: UpdateCandidateStatus;
  manifest: ReleaseManifest | null;
}

interface RollbackPlan {
  schema_version: 1;
  surface: "update";
  plan_id: string;
  created_at: string;
  current_version: string;
  current_git_head: string | null;
  candidate_version: string | null;
  candidate_archive_path: string | null;
  candidate_sha256: string | null;
  candidate_verified: boolean;
  pre_update_backup_id: string;
  pre_update_backup_manifest_path: string | null;
  rollback_requires_manual_app_restore: true;
  steps: readonly string[];
  authority_boundary: UpdateAuthorityBoundary;
  used_for_authority: false;
  hds_brain_remains_authority: true;
  evidence_source: UpdateEvidenceSource;
}

const AUTHORITY_BOUNDARY: UpdateAuthorityBoundary = {
  ui_used_for_authority: false,
  update_metadata_used_for_authority: false,
  rollback_plan_used_for_authority: false,
  recovery_backup_used_for_authority: false,
  used_for_authority: false,
};

const REQUIRED_CORE_PATHS = PRODUCT_SCOPE_CORE_RELEASE_PATHS;

function updateRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    env.BLUE_TANUKI_UPDATE_DIR ??
      path.join(env.BLUE_TANUKI_FILE_ROOT ?? ".blue-tanuki", "update"),
  );
}

async function readPackageVersion(root: string): Promise<string> {
  const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as PackageJson;
  return typeof parsed.version === "string" && parsed.version.length > 0
    ? parsed.version
    : "unknown";
}

async function readGitHead(root: string): Promise<string | null> {
  const gitDir = path.join(root, ".git");
  const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "");
  const trimmed = head.trim();
  if (/^[a-f0-9]{40}$/i.test(trimmed)) return trimmed;
  const match = /^ref:\s+(.+)$/.exec(trimmed);
  if (!match) return null;
  const ref = match[1];
  if (!ref || ref.includes("..") || path.isAbsolute(ref)) return null;
  const refValue = await fs.readFile(path.join(gitDir, ref), "utf8").catch(() => "");
  const commit = refValue.trim();
  return /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
}

function defaultArchivePath(root: string, version: string): string {
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return path.join(root, "release", `blue-tanuki-${version}-source-bundle.${ext}`);
}

function candidateArchivePath(
  root: string,
  env: NodeJS.ProcessEnv,
  version: string,
): string {
  return path.resolve(env.BLUE_TANUKI_UPDATE_BUNDLE ?? defaultArchivePath(root, version));
}

function artifactBase(archivePath: string): string {
  if (archivePath.endsWith(".tar.gz")) return archivePath.slice(0, -".tar.gz".length);
  return archivePath.slice(0, -path.extname(archivePath).length);
}

function integrityPaths(archivePath: string): { sha256Path: string; manifestPath: string } {
  const base = artifactBase(archivePath);
  return {
    sha256Path: `${base}.sha256`,
    manifestPath: `${base}.manifest.json`,
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath)
    .then((stat) => stat.isFile() || stat.isDirectory())
    .catch(() => false);
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function readSha256File(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8");
  const token = raw.trim().split(/\s+/)[0];
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error("invalid sha256 sidecar");
  }
  return token.toLowerCase();
}

async function readManifest(filePath: string): Promise<ReleaseManifest> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as ReleaseManifest
    : {};
}

function manifestCorePaths(manifest: ReleaseManifest): readonly string[] {
  return Array.isArray(manifest.core_release_paths)
    ? manifest.core_release_paths.filter((item): item is string => typeof item === "string")
    : [];
}

function manifestFailure(
  manifest: ReleaseManifest,
  archivePath: string,
  sha256Path: string,
  actualSha: string,
  archiveSize: number,
): string | null {
  if (manifest.schema_version !== 1) return "manifest schema_version must be 1";
  if (manifest.name !== "blue-tanuki") return "manifest name must be blue-tanuki";
  if (manifest.archive?.file !== path.basename(archivePath)) return "manifest archive file mismatch";
  if (manifest.archive?.size_bytes !== archiveSize) return "manifest archive size mismatch";
  if (typeof manifest.archive?.sha256 !== "string" || manifest.archive.sha256.toLowerCase() !== actualSha) {
    return "manifest archive sha256 mismatch";
  }
  if (manifest.sha256_file !== path.basename(sha256Path)) return "manifest sha256_file mismatch";
  if (manifest.boundaries?.unsigned_source_bundle !== true) return "manifest unsigned_source_bundle boundary missing";
  if (manifest.boundaries?.secrets_included !== false) return "manifest secrets_included boundary mismatch";
  if (manifest.boundaries?.external_dynamic_imports_included !== false) {
    return "manifest external_dynamic_imports_included boundary mismatch";
  }
  const corePaths = manifestCorePaths(manifest);
  const missing = REQUIRED_CORE_PATHS.find((required) => !corePaths.includes(required));
  return missing ? `manifest core_release_paths missing ${missing}` : null;
}

async function verifyCandidate(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<CandidateVerification> {
  const currentVersion = await readPackageVersion(root);
  const archivePath = candidateArchivePath(root, env, currentVersion);
  const { sha256Path, manifestPath } = integrityPaths(archivePath);
  const archiveExists = await exists(archivePath);
  const shaExists = await exists(sha256Path);
  const manifestExists = await exists(manifestPath);

  const base: Omit<
    UpdateCandidateStatus,
    "archive_sha256" | "sha256_matches" | "manifest_matches" | "version" | "verification_status" | "failure_reason"
  > = {
    configured: true,
    archive_path: archivePath,
    exists: archiveExists,
    sha256_path: sha256Path,
    sha256_exists: shaExists,
    manifest_path: manifestPath,
    manifest_exists: manifestExists,
    secret_material: false,
  };

  if (!archiveExists || !shaExists || !manifestExists) {
    return {
      status: {
        ...base,
        archive_sha256: null,
        sha256_matches: false,
        manifest_matches: false,
        version: null,
        verification_status: "missing",
        failure_reason: !archiveExists
          ? "release archive missing"
          : !shaExists
            ? "sha256 sidecar missing"
            : "manifest sidecar missing",
      },
      manifest: null,
    };
  }

  try {
    const [actualSha, expectedSha, archiveStat, manifest] = await Promise.all([
      sha256File(archivePath),
      readSha256File(sha256Path),
      fs.stat(archivePath),
      readManifest(manifestPath),
    ]);
    const shaMatches = actualSha === expectedSha;
    const manifestReason = manifestFailure(manifest, archivePath, sha256Path, actualSha, archiveStat.size);
    const manifestMatches = manifestReason === null;
    const failureReason = !shaMatches ? "release archive sha256 does not match checksum file" : manifestReason;
    return {
      status: {
        ...base,
        archive_sha256: actualSha,
        sha256_matches: shaMatches,
        manifest_matches: manifestMatches,
        version: typeof manifest.version === "string" ? manifest.version : null,
        verification_status: shaMatches && manifestMatches ? "pass" : "fail",
        failure_reason: failureReason,
      },
      manifest,
    };
  } catch (error) {
    return {
      status: {
        ...base,
        archive_sha256: null,
        sha256_matches: false,
        manifest_matches: false,
        version: null,
        verification_status: "fail",
        failure_reason: error instanceof Error ? error.message : "candidate verification failed",
      },
      manifest: null,
    };
  }
}

async function latestRollbackPlan(env: NodeJS.ProcessEnv): Promise<{ id: string; path: string } | null> {
  const root = updateRoot(env);
  const entries = await fs.readdir(root)
    .then((items) => items.filter((item) => item.endsWith(".rollback-plan.json")).sort())
    .catch(() => []);
  const latest = entries[entries.length - 1];
  if (!latest) return null;
  return { id: latest.slice(0, -".rollback-plan.json".length), path: path.join(root, latest) };
}

function assertConfirmation(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(`confirmation_required:${expected}`);
  }
}

function planId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}.update.${randomUUID()}`;
}

async function writeRollbackPlan(
  root: string,
  env: NodeJS.ProcessEnv,
  candidate: UpdateCandidateStatus,
  preUpdateBackupId: string,
  preUpdateBackupManifestPath: string | null,
): Promise<{ id: string; path: string }> {
  const id = planId();
  const outDir = updateRoot(env);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const outPath = path.join(outDir, `${id}.rollback-plan.json`);
  const plan: RollbackPlan = {
    schema_version: 1,
    surface: "update",
    plan_id: id,
    created_at: new Date().toISOString(),
    current_version: await readPackageVersion(root),
    current_git_head: await readGitHead(root),
    candidate_version: candidate.version,
    candidate_archive_path: candidate.archive_path,
    candidate_sha256: candidate.archive_sha256,
    candidate_verified: candidate.verification_status === "pass",
    pre_update_backup_id: preUpdateBackupId,
    pre_update_backup_manifest_path: preUpdateBackupManifestPath,
    rollback_requires_manual_app_restore: true,
    steps: [
      "Stop BLUE-TANUKI before replacing app files.",
      "Keep the current app directory or source checkout available until post-update validation passes.",
      "Apply the release bundle manually according to docs/UPDATE_ROLLBACK_RUNBOOK.md.",
      "Restart BLUE-TANUKI, then run doctor, audit verification, and release verification.",
      "If validation fails, restore the previous app directory or source commit and restore the recorded recovery backup.",
    ],
    authority_boundary: AUTHORITY_BOUNDARY,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
  await fs.writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { id, path: outPath };
}

function actionResult(
  action: UpdateActionResult["action"],
  candidate: UpdateCandidateStatus,
  values: Omit<
    UpdateActionResult,
    "schema_version" | "surface" | "action" | "status" | "candidate" | "authority_boundary" | "used_for_authority" | "hds_brain_remains_authority" | "evidence_source"
  >,
): UpdateActionResult {
  return {
    schema_version: 1,
    surface: "update",
    action,
    status: "completed",
    candidate,
    ...values,
    authority_boundary: AUTHORITY_BOUNDARY,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
}

export async function buildUpdateSnapshot(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateSnapshot> {
  const [currentVersion, currentGitHead, candidate, latestPlan] = await Promise.all([
    readPackageVersion(root),
    readGitHead(root),
    verifyCandidate(root, env),
    latestRollbackPlan(env),
  ]);
  const candidateSchema =
    typeof candidate.manifest?.schema_version === "number"
      ? candidate.manifest.schema_version
      : null;
  const compatibilityStatus =
    candidate.status.verification_status === "pass"
      ? "pass"
      : candidate.status.verification_status === "missing"
        ? "unknown"
        : "blocked";

  return {
    schema_version: 1,
    surface: "update",
    mode: "manual_control",
    package: {
      current_version: currentVersion,
      current_git_head: currentGitHead,
    },
    candidate: candidate.status,
    compatibility: {
      current_data_schema_version: 1,
      minimum_supported_data_schema_version: 1,
      candidate_manifest_schema_version: candidateSchema,
      migration_required: false,
      migration_supported: true,
      status: compatibilityStatus,
    },
    rollback: {
      pre_update_backup_available: true,
      latest_plan_path: latestPlan?.path ?? null,
      latest_plan_id: latestPlan?.id ?? null,
      rollback_requires_manual_app_restore: true,
    },
    distribution_boundary: {
      signed_native_installer_shipped: false,
      automatic_updater_shipped: false,
      runtime_auto_apply_available: false,
      manual_update_only: true,
    },
    authority_boundary: AUTHORITY_BOUNDARY,
    next_safe_action:
      candidate.status.verification_status === "pass"
        ? "Create a pre-update backup, then apply the release bundle manually and rerun validation."
        : "Generate or configure a release bundle with matching sha256 and manifest sidecars before update.",
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
}

export async function verifyUpdateCandidate(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateActionResult> {
  const candidate = await verifyCandidate(root, env);
  return actionResult("verify_candidate", candidate.status, {
    next_safe_action:
      candidate.status.verification_status === "pass"
        ? "Create a pre-update backup before applying the verified bundle manually."
        : "Fix the release archive, sha256 sidecar, or manifest before update.",
  });
}

export async function prepareManualUpdate(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareUpdateOptions = {},
): Promise<UpdateActionResult> {
  assertConfirmation(options.confirm, "PRE_UPDATE_BACKUP");
  const candidate = await verifyCandidate(root, env);
  const backup = await createRecoveryBackup(env);
  if (!backup.backup_id) {
    throw new Error("pre_update_backup_failed");
  }
  const plan = await writeRollbackPlan(
    root,
    env,
    candidate.status,
    backup.backup_id,
    backup.backup_manifest_path ?? null,
  );
  return actionResult("prepare_update", candidate.status, {
    pre_update_backup_id: backup.backup_id,
    pre_update_backup_manifest_path: backup.backup_manifest_path,
    rollback_plan_id: plan.id,
    rollback_plan_path: plan.path,
    next_safe_action:
      candidate.status.verification_status === "pass"
        ? "Stop BLUE-TANUKI, apply the verified bundle manually, then rerun doctor/audit/release validation."
        : "Backup and rollback plan are recorded; fix candidate verification before applying any update.",
  });
}
