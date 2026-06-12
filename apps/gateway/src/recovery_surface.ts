import { promises as fs } from "node:fs";
import * as path from "node:path";

export type RecoveryPathKind = "file" | "directory" | "missing" | "unset" | "unknown";

export interface RecoveryPathStatus {
  configured: boolean;
  path: string | null;
  exists: boolean;
  kind: RecoveryPathKind;
  backup_required: boolean;
}

export interface RecoverySnapshot {
  schema_version: 1;
  surface: "recovery";
  mode: "read_only";
  env_file: {
    configured: boolean;
    path: string | null;
    exists: boolean;
    backup_count: number;
    latest_backup_path: string | null;
    backup_pattern: string | null;
    secret_material: true;
  };
  runtime_paths: {
    file_root: RecoveryPathStatus;
    session_dir: RecoveryPathStatus;
    audit_dir: RecoveryPathStatus;
    memory_file: RecoveryPathStatus;
    memory_dir: RecoveryPathStatus;
    failure_memory_file: RecoveryPathStatus;
    failure_memory_dir: RecoveryPathStatus;
    schedules_dir: RecoveryPathStatus;
  };
  restore: {
    execution_available: false;
    factory_reset_available: false;
    provider_reset_available: false;
    connector_reset_available: false;
    destructive_repair_available: false;
  };
  authority_boundary: {
    ui_used_for_authority: false;
    recovery_metadata_used_for_authority: false;
    used_for_authority: false;
  };
  next_safe_action: string;
  evidence_source: readonly ["CONFIG", "EXTERNAL_EVIDENCE"];
}

async function pathStatus(value: string | undefined, backupRequired: boolean): Promise<RecoveryPathStatus> {
  if (!value) {
    return {
      configured: false,
      path: null,
      exists: false,
      kind: "unset",
      backup_required: backupRequired,
    };
  }
  const resolved = path.resolve(value);
  try {
    const stat = await fs.stat(resolved);
    return {
      configured: true,
      path: resolved,
      exists: true,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "unknown",
      backup_required: backupRequired,
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return {
      configured: true,
      path: resolved,
      exists: false,
      kind: code === "ENOENT" ? "missing" : "unknown",
      backup_required: backupRequired,
    };
  }
}

async function envBackups(envFile: string | undefined): Promise<{
  configured: boolean;
  path: string | null;
  exists: boolean;
  backup_count: number;
  latest_backup_path: string | null;
  backup_pattern: string | null;
  secret_material: true;
}> {
  if (!envFile) {
    return {
      configured: false,
      path: null,
      exists: false,
      backup_count: 0,
      latest_backup_path: null,
      backup_pattern: null,
      secret_material: true,
    };
  }

  const resolved = path.resolve(envFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const backupPattern = `${base}.*.bak`;
  const exists = await fs
    .stat(resolved)
    .then((stat) => stat.isFile())
    .catch(() => false);
  const backups = await fs
    .readdir(dir)
    .then((entries) => entries
      .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".bak"))
      .sort())
    .catch(() => []);
  const latest = backups.length > 0 ? path.join(dir, backups[backups.length - 1] ?? "") : null;

  return {
    configured: true,
    path: resolved,
    exists,
    backup_count: backups.length,
    latest_backup_path: latest,
    backup_pattern: path.join(dir, backupPattern),
    secret_material: true,
  };
}

export async function buildRecoverySnapshot(env: NodeJS.ProcessEnv = process.env): Promise<RecoverySnapshot> {
  const schedulesDir = env.BLUE_TANUKI_SCHEDULES_DIR ?? path.join(".blue-tanuki", "schedules");

  return {
    schema_version: 1,
    surface: "recovery",
    mode: "read_only",
    env_file: await envBackups(env.BLUE_TANUKI_ENV_FILE),
    runtime_paths: {
      file_root: await pathStatus(env.BLUE_TANUKI_FILE_ROOT, true),
      session_dir: await pathStatus(env.BLUE_TANUKI_SESSION_DIR, true),
      audit_dir: await pathStatus(env.BLUE_TANUKI_AUDIT_DIR, true),
      memory_file: await pathStatus(env.BLUE_TANUKI_MEMORY_FILE, true),
      memory_dir: await pathStatus(env.BLUE_TANUKI_MEMORY_DIR, true),
      failure_memory_file: await pathStatus(env.BLUE_TANUKI_FAILURE_MEMORY_FILE, true),
      failure_memory_dir: await pathStatus(env.BLUE_TANUKI_FAILURE_MEMORY_DIR, true),
      schedules_dir: await pathStatus(schedulesDir, true),
    },
    restore: {
      execution_available: false,
      factory_reset_available: false,
      provider_reset_available: false,
      connector_reset_available: false,
      destructive_repair_available: false,
    },
    authority_boundary: {
      ui_used_for_authority: false,
      recovery_metadata_used_for_authority: false,
      used_for_authority: false,
    },
    next_safe_action: "Review configured paths and backup inventory before using later P10 restore actions.",
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
  };
}
