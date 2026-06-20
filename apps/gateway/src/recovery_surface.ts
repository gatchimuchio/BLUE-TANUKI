import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnvFile, writeEnvFileAtomic } from "./env_file.js";

export type RecoveryPathKind = "file" | "directory" | "missing" | "unset" | "unknown";
export type RecoveryAction =
  | "backup"
  | "restore"
  | "provider_reset"
  | "connector_reset"
  | "factory_reset";

export interface RecoveryPathStatus {
  configured: boolean;
  path: string | null;
  exists: boolean;
  kind: RecoveryPathKind;
  backup_required: boolean;
}

export interface RecoveryBackupInventory {
  configured: boolean;
  path: string | null;
  exists: boolean;
  backup_count: number;
  latest_backup_id: string | null;
  latest_manifest_path: string | null;
  backup_pattern: string | null;
  secret_material: true;
}

export interface RecoverySnapshot {
  schema_version: 1;
  surface: "recovery";
  mode: "control_available";
  env_file: {
    configured: boolean;
    path: string | null;
    exists: boolean;
    backup_count: number;
    latest_backup_path: string | null;
    backup_pattern: string | null;
    secret_material: true;
  };
  recovery_backups: RecoveryBackupInventory;
  runtime_paths: {
    file_root: RecoveryPathStatus;
    recovery_root: RecoveryPathStatus;
    session_dir: RecoveryPathStatus;
    audit_dir: RecoveryPathStatus;
    memory_file: RecoveryPathStatus;
    memory_dir: RecoveryPathStatus;
    failure_memory_file: RecoveryPathStatus;
    failure_memory_dir: RecoveryPathStatus;
    schedules_dir: RecoveryPathStatus;
    log_dir: RecoveryPathStatus;
  };
  restore: {
    execution_available: boolean;
    backup_available: boolean;
    latest_backup_id: string | null;
    factory_reset_available: boolean;
    provider_reset_available: boolean;
    connector_reset_available: boolean;
    destructive_repair_available: false;
    confirmation_required: true;
  };
  authority_boundary: RecoveryAuthorityBoundary;
  next_safe_action: string;
  evidence_source: readonly ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"];
}

export interface RecoveryActionResult {
  schema_version: 1;
  surface: "recovery";
  action: RecoveryAction;
  status: "completed";
  backup_id?: string;
  backup_manifest_path?: string;
  restored_backup_id?: string;
  restored_items_count?: number;
  removed_paths_count?: number;
  reset_keys?: readonly string[];
  preserved_paths?: readonly string[];
  pre_action_backup_id?: string;
  pre_action_backup_manifest_path?: string;
  authority_boundary: RecoveryAuthorityBoundary;
  secret_material: true;
  used_for_authority: false;
  hds_brain_remains_authority: true;
  evidence_source: readonly ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"];
  next_safe_action: string;
}

export interface RestoreRecoveryOptions {
  backup_id?: string;
  confirm?: string;
}

export interface RecoveryResetOptions {
  confirm?: string;
}

interface RecoveryAuthorityBoundary {
  ui_used_for_authority: false;
  recovery_metadata_used_for_authority: false;
  recovery_action_used_for_authority: false;
  used_for_authority: false;
}

interface RecoverySourceSpec {
  key: string;
  env_key: string;
  source_path: string | undefined;
  backup_required: boolean;
}

interface RecoveryBackupManifestItem {
  key: string;
  env_key: string;
  source_path: string | null;
  archive_path: string | null;
  archive_rel_path: string | null;
  exists: boolean;
  kind: RecoveryPathKind;
  copied: boolean;
  backup_required: boolean;
  bytes: number;
  sha256: string | null;
  skipped_reason?: string;
}

interface RecoveryBackupManifest {
  schema_version: 1;
  surface: "recovery";
  backup_id: string;
  action: "backup" | "pre_restore" | "pre_factory_reset";
  created_at: string;
  recovery_root: string;
  manifest_path: string;
  secret_material: true;
  items: RecoveryBackupManifestItem[];
  authority_boundary: RecoveryAuthorityBoundary;
  used_for_authority: false;
  hds_brain_remains_authority: true;
  evidence_source: readonly ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"];
}

interface SafeRuntimeTarget {
  path: string;
  purpose: string;
}

const AUTHORITY_BOUNDARY: RecoveryAuthorityBoundary = {
  ui_used_for_authority: false,
  recovery_metadata_used_for_authority: false,
  recovery_action_used_for_authority: false,
  used_for_authority: false,
};

const PROVIDER_RESET_KEYS = [
  "LLM_DEFAULT_BACKEND",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_REF",
  "OPENAI_MODEL",
  "OPENAI_ENDPOINT",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_REF",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_ENDPOINT",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_API_KEY_REF",
  "LLM_ENDPOINT",
  "LLM_MODEL",
  "LLM_API_KEY",
  "LLM_API_KEY_REF",
  "LLM_HEADERS_JSON",
  "LLM_PROVIDERS_JSON",
  "OPENROUTER_MODEL",
  "OPENROUTER_ENDPOINT",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY_REF",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_TITLE",
  "BLUE_TANUKI_LLM_BACKEND_HINT",
  "BLUE_TANUKI_LLM_MODEL",
  "BLUE_TANUKI_LLM_TEMPERATURE",
  "BLUE_TANUKI_LLM_MAX_TOKENS",
  "BLUE_TANUKI_LLM_TIMEOUT_MS",
] as const;

const CONNECTOR_RESET_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_ALLOWED_TOOLKITS",
  "COMPOSIO_ALLOWED_ACTIONS",
  "COMPOSIO_REVOKED_ACTIONS",
  "COMPOSIO_USER_ID",
  "COMPOSIO_API_BASE_URL",
] as const;

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
    .then((entries) =>
      entries
        .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".bak"))
        .sort(),
    )
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

function recoveryRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    env.BLUE_TANUKI_RECOVERY_DIR ??
      path.join(env.BLUE_TANUKI_FILE_ROOT ?? ".blue-tanuki", "recovery"),
  );
}

async function recoveryBackupInventory(env: NodeJS.ProcessEnv): Promise<RecoveryBackupInventory> {
  const root = recoveryRoot(env);
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .then((items) => items.filter((item) => item.isDirectory()).map((item) => item.name).sort())
    .catch(() => []);
  const manifestPaths: Array<{ id: string; path: string }> = [];
  for (const entry of entries) {
    const manifestPath = path.join(root, entry, "manifest.json");
    const exists = await fs
      .stat(manifestPath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (exists) manifestPaths.push({ id: entry, path: manifestPath });
  }
  const latest = manifestPaths[manifestPaths.length - 1] ?? null;
  return {
    configured: true,
    path: root,
    exists: await fs
      .stat(root)
      .then((stat) => stat.isDirectory())
      .catch(() => false),
    backup_count: manifestPaths.length,
    latest_backup_id: latest?.id ?? null,
    latest_manifest_path: latest?.path ?? null,
    backup_pattern: path.join(root, "*", "manifest.json"),
    secret_material: true,
  };
}

function sourceSpecs(env: NodeJS.ProcessEnv): RecoverySourceSpec[] {
  return [
    {
      key: "env_file",
      env_key: "BLUE_TANUKI_ENV_FILE",
      source_path: env.BLUE_TANUKI_ENV_FILE,
      backup_required: true,
    },
    {
      key: "audit_dir",
      env_key: "BLUE_TANUKI_AUDIT_DIR",
      source_path: env.BLUE_TANUKI_AUDIT_DIR,
      backup_required: true,
    },
    {
      key: "session_dir",
      env_key: "BLUE_TANUKI_SESSION_DIR",
      source_path: env.BLUE_TANUKI_SESSION_DIR,
      backup_required: true,
    },
    {
      key: "memory_file",
      env_key: "BLUE_TANUKI_MEMORY_FILE",
      source_path: env.BLUE_TANUKI_MEMORY_FILE,
      backup_required: true,
    },
    {
      key: "memory_dir",
      env_key: "BLUE_TANUKI_MEMORY_DIR",
      source_path: env.BLUE_TANUKI_MEMORY_DIR,
      backup_required: true,
    },
    {
      key: "failure_memory_file",
      env_key: "BLUE_TANUKI_FAILURE_MEMORY_FILE",
      source_path: env.BLUE_TANUKI_FAILURE_MEMORY_FILE,
      backup_required: true,
    },
    {
      key: "failure_memory_dir",
      env_key: "BLUE_TANUKI_FAILURE_MEMORY_DIR",
      source_path: env.BLUE_TANUKI_FAILURE_MEMORY_DIR,
      backup_required: true,
    },
    {
      key: "schedules_dir",
      env_key: "BLUE_TANUKI_SCHEDULES_DIR",
      source_path: env.BLUE_TANUKI_SCHEDULES_DIR ??
        (env.BLUE_TANUKI_FILE_ROOT ? path.join(env.BLUE_TANUKI_FILE_ROOT, "schedules") : undefined),
      backup_required: true,
    },
    {
      key: "log_dir",
      env_key: "BLUE_TANUKI_LOG_DIR",
      source_path: env.BLUE_TANUKI_LOG_DIR,
      backup_required: true,
    },
    {
      key: "approval_grants_file",
      env_key: "BLUE_TANUKI_APPROVALS_FILE",
      source_path: env.BLUE_TANUKI_APPROVALS_FILE,
      backup_required: true,
    },
  ];
}

function trimTrailingSeparators(value: string): string {
  let out = path.resolve(value);
  while (out.length > path.parse(out).root.length && /[\\/]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function broadRuntimePathReason(resolved: string): string | null {
  const home = trimTrailingSeparators(os.homedir());
  const tmp = trimTrailingSeparators(os.tmpdir());
  const denied = [
    path.parse(resolved).root,
    home,
    path.join(home, ".config"),
    path.join(home, ".local"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "bin"),
    path.join(home, "Library"),
    path.join(home, "Library", "Application Support"),
    tmp,
  ].map(trimTrailingSeparators);
  return denied.includes(trimTrailingSeparators(resolved)) ? "broad_path" : null;
}

function configuredRuntimeTargets(env: NodeJS.ProcessEnv): Map<string, string> {
  const targets = new Map<string, string>();
  for (const spec of sourceSpecs(env)) {
    if (spec.source_path) {
      targets.set(`${spec.key}:${spec.env_key}`, trimTrailingSeparators(spec.source_path));
    }
  }
  return targets;
}

function managedRuntimeRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.BLUE_TANUKI_FILE_ROOT,
    env.BLUE_TANUKI_ENV_FILE ? path.dirname(env.BLUE_TANUKI_ENV_FILE) : undefined,
    env.BLUE_TANUKI_AUDIT_DIR,
    env.BLUE_TANUKI_SESSION_DIR,
    env.BLUE_TANUKI_MEMORY_DIR,
    env.BLUE_TANUKI_MEMORY_FILE ? path.dirname(env.BLUE_TANUKI_MEMORY_FILE) : undefined,
    env.BLUE_TANUKI_FAILURE_MEMORY_DIR,
    env.BLUE_TANUKI_FAILURE_MEMORY_FILE ? path.dirname(env.BLUE_TANUKI_FAILURE_MEMORY_FILE) : undefined,
    env.BLUE_TANUKI_SCHEDULES_DIR,
    env.BLUE_TANUKI_LOG_DIR,
    env.BLUE_TANUKI_APPROVALS_FILE ? path.dirname(env.BLUE_TANUKI_APPROVALS_FILE) : undefined,
    recoveryRoot(env),
  ]
    .filter((item): item is string => Boolean(item && item.trim().length > 0))
    .map(trimTrailingSeparators)
    .filter((item) => broadRuntimePathReason(item) === null);
  return Array.from(new Set(roots));
}

async function assertNoSymlinkTarget(resolved: string, purpose: string): Promise<void> {
  const stat = await fs.lstat(resolved).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    throw new Error(`unsafe_runtime_target:${purpose}:symlink:${resolved}`);
  }
  const parent = path.dirname(resolved);
  const parentStat = await fs.lstat(parent).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
  });
  if (parentStat?.isSymbolicLink()) {
    throw new Error(`unsafe_runtime_target:${purpose}:symlink_parent:${parent}`);
  }
}

async function runtimeSafeTarget(
  env: NodeJS.ProcessEnv,
  target: string,
  purpose: string,
  opts: { allow_exact?: readonly string[]; allow_under_recovery_root?: boolean } = {},
): Promise<SafeRuntimeTarget> {
  if (!target || target.trim().length === 0) {
    throw new Error(`unsafe_runtime_target:${purpose}:empty`);
  }
  if (!path.isAbsolute(target)) {
    throw new Error(`unsafe_runtime_target:${purpose}:relative:${target}`);
  }
  const resolved = trimTrailingSeparators(target);
  const broad = broadRuntimePathReason(resolved);
  if (broad) {
    throw new Error(`unsafe_runtime_target:${purpose}:${broad}:${resolved}`);
  }
  await assertNoSymlinkTarget(resolved, purpose);

  const exact = (opts.allow_exact ?? []).map(trimTrailingSeparators);
  if (exact.includes(resolved)) return { path: resolved, purpose };

  const roots = managedRuntimeRoots(env);
  if (opts.allow_under_recovery_root) roots.push(recoveryRoot(env));
  if (roots.some((root) => isSameOrInside(resolved, root))) {
    return { path: resolved, purpose };
  }
  throw new Error(`unsafe_runtime_target:${purpose}:outside_managed_roots:${resolved}`);
}

async function assertArchivePath(packDir: string, archivePathValue: string, purpose: string): Promise<string> {
  if (!path.isAbsolute(archivePathValue)) {
    throw new Error(`invalid_backup_manifest_archive_path:${purpose}:relative`);
  }
  const resolved = trimTrailingSeparators(archivePathValue);
  if (!isSameOrInside(resolved, trimTrailingSeparators(packDir))) {
    throw new Error(`invalid_backup_manifest_archive_path:${purpose}:escape`);
  }
  await assertNoSymlinkTarget(resolved, purpose);
  return resolved;
}

function backupId(action: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}.${action}.${randomUUID()}`;
}

function assertConfirmation(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error(`confirmation_required:${expected}`);
  }
}

function assertBackupId(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("invalid_backup_id");
  }
}

async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const data = await fs.readFile(filePath);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
}

async function sha256Path(itemPath: string, kind: RecoveryPathKind): Promise<{ sha256: string; bytes: number }> {
  if (kind === "file") return sha256File(itemPath);
  if (kind !== "directory") return { sha256: "", bytes: 0 };

  const hash = createHash("sha256");
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(itemPath, fullPath);
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        await walk(fullPath);
      } else if (entry.isFile()) {
        const file = await sha256File(fullPath);
        hash.update(`file:${rel}:${file.sha256}:${file.bytes}\n`);
        bytes += file.bytes;
      }
    }
  };
  await walk(itemPath);
  return { sha256: hash.digest("hex"), bytes };
}

async function copyPath(source: string, dest: string, kind: RecoveryPathKind): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (kind === "directory") {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(source, dest, { recursive: true, preserveTimestamps: true });
    return;
  }
  if (kind === "file") {
    await fs.copyFile(source, dest);
  }
}

function archivePath(packDir: string, spec: RecoverySourceSpec, kind: RecoveryPathKind): string {
  const suffix = kind === "directory" ? "dir" : "file";
  return path.join(packDir, "items", `${spec.key}.${suffix}`);
}

async function createBackupManifest(
  env: NodeJS.ProcessEnv,
  action: "backup" | "pre_restore" | "pre_factory_reset",
): Promise<RecoveryBackupManifest> {
  const root = (await runtimeSafeTarget(env, recoveryRoot(env), "recovery_root", {
    allow_under_recovery_root: true,
  })).path;
  const id = backupId(action);
  const packDir = path.join(root, id);
  const manifestPath = path.join(packDir, "manifest.json");
  await fs.mkdir(path.join(packDir, "items"), { recursive: true, mode: 0o700 });

  const items: RecoveryBackupManifestItem[] = [];
  for (const spec of sourceSpecs(env)) {
    const source = spec.source_path
      ? (await runtimeSafeTarget(env, path.resolve(spec.source_path), `backup_source:${spec.key}`, {
          allow_exact: [path.resolve(spec.source_path)],
        })).path
      : undefined;
    if (!source) {
      items.push({
        key: spec.key,
        env_key: spec.env_key,
        source_path: null,
        archive_path: null,
        archive_rel_path: null,
        exists: false,
        kind: "unset",
        copied: false,
        backup_required: spec.backup_required,
        bytes: 0,
        sha256: null,
        skipped_reason: "source_unset",
      });
      continue;
    }

    const status = await pathStatus(source, spec.backup_required);
    if (!status.exists || status.kind === "missing" || status.kind === "unknown" || status.kind === "unset") {
      items.push({
        key: spec.key,
        env_key: spec.env_key,
        source_path: source,
        archive_path: null,
        archive_rel_path: null,
        exists: false,
        kind: status.kind,
        copied: false,
        backup_required: spec.backup_required,
        bytes: 0,
        sha256: null,
        skipped_reason: status.kind,
      });
      continue;
    }

    const dest = await assertArchivePath(packDir, archivePath(packDir, spec, status.kind), `backup_archive:${spec.key}`);
    await copyPath(source, dest, status.kind);
    const digest = await sha256Path(dest, status.kind);
    items.push({
      key: spec.key,
      env_key: spec.env_key,
      source_path: source,
      archive_path: dest,
      archive_rel_path: path.relative(packDir, dest),
      exists: true,
      kind: status.kind,
      copied: true,
      backup_required: spec.backup_required,
      bytes: digest.bytes,
      sha256: digest.sha256 || null,
    });
  }

  const manifest: RecoveryBackupManifest = {
    schema_version: 1,
    surface: "recovery",
    backup_id: id,
    action,
    created_at: new Date().toISOString(),
    recovery_root: root,
    manifest_path: manifestPath,
    secret_material: true,
    items,
    authority_boundary: AUTHORITY_BOUNDARY,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const manifestDigest = await sha256File(manifestPath);
  await fs.writeFile(
    `${manifestPath}.sha256`,
    `${manifestDigest.sha256}  manifest.json\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return manifest;
}

function actionResult(
  action: RecoveryAction,
  values: Omit<RecoveryActionResult, "schema_version" | "surface" | "action" | "status" | "authority_boundary" | "secret_material" | "used_for_authority" | "hds_brain_remains_authority" | "evidence_source">,
): RecoveryActionResult {
  return {
    schema_version: 1,
    surface: "recovery",
    action,
    status: "completed",
    ...values,
    authority_boundary: AUTHORITY_BOUNDARY,
    secret_material: true,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
}

async function readManifest(env: NodeJS.ProcessEnv, backupIdValue: string): Promise<RecoveryBackupManifest> {
  assertBackupId(backupIdValue);
  const root = (await runtimeSafeTarget(env, recoveryRoot(env), "recovery_root", {
    allow_under_recovery_root: true,
  })).path;
  const manifestPath = await assertArchivePath(root, path.join(root, backupIdValue, "manifest.json"), "manifest");
  const rel = path.relative(root, manifestPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("invalid_backup_id");
  }
  const raw = await fs.readFile(manifestPath, "utf8");
  const digest = createHash("sha256").update(raw).digest("hex");
  const sidecar = await fs.readFile(`${manifestPath}.sha256`, "utf8").catch(() => "");
  const expectedDigest = sidecar.trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest) || expectedDigest.toLowerCase() !== digest) {
    throw new Error("invalid_backup_manifest_digest");
  }
  const parsed = JSON.parse(raw) as RecoveryBackupManifest;
  if (parsed.schema_version !== 1 || parsed.surface !== "recovery" || parsed.backup_id !== backupIdValue) {
    throw new Error("invalid_backup_manifest");
  }
  if (trimTrailingSeparators(parsed.recovery_root) !== root) {
    throw new Error("invalid_backup_manifest_recovery_root");
  }
  return {
    ...parsed,
    recovery_root: root,
    manifest_path: manifestPath,
  };
}

async function latestBackupId(env: NodeJS.ProcessEnv): Promise<string | null> {
  const inventory = await recoveryBackupInventory(env);
  return inventory.latest_backup_id;
}

async function restoreManifest(
  env: NodeJS.ProcessEnv,
  manifest: RecoveryBackupManifest,
): Promise<{ restored: number; removed: number }> {
  let restored = 0;
  let removed = 0;
  const packDir = path.dirname(manifest.manifest_path);
  const expectedTargets = configuredRuntimeTargets(env);
  for (const item of manifest.items) {
    if (!item.source_path) continue;
    const expected = expectedTargets.get(`${item.key}:${item.env_key}`);
    if (!expected) {
      throw new Error(`invalid_backup_manifest_target:${item.key}:not_configured`);
    }
    const sourcePath = trimTrailingSeparators(item.source_path);
    if (sourcePath !== expected) {
      throw new Error(`invalid_backup_manifest_target:${item.key}:source_path_mismatch`);
    }
    const target = (await runtimeSafeTarget(env, sourcePath, `restore_target:${item.key}`, {
      allow_exact: [expected],
    })).path;
    if (!item.copied || !item.archive_rel_path) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
      continue;
    }
    if (item.kind !== "file" && item.kind !== "directory") {
      throw new Error(`invalid_backup_manifest_kind:${item.key}`);
    }
    const archive = await assertArchivePath(packDir, path.resolve(packDir, item.archive_rel_path), `restore_archive:${item.key}`);
    const rel = path.relative(packDir, archive);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("invalid_backup_manifest_archive_path");
    }
    const digest = await sha256Path(archive, item.kind);
    if (!item.sha256 || digest.sha256 !== item.sha256) {
      throw new Error(`invalid_backup_manifest_archive_digest:${item.key}`);
    }
    await copyPath(archive, target, item.kind);
    restored += 1;
  }
  return { restored, removed };
}

async function readEnvValues(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  if (!env.BLUE_TANUKI_ENV_FILE) {
    throw new Error("env_file_required");
  }
  const envFile = (await runtimeSafeTarget(env, path.resolve(env.BLUE_TANUKI_ENV_FILE), "env_file_read", {
    allow_exact: [path.resolve(env.BLUE_TANUKI_ENV_FILE)],
  })).path;
  const raw = await fs
    .readFile(envFile, "utf8")
    .catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return "";
      throw error;
    });
  return parseEnvFile(raw).values;
}

function renderEnvValues(values: Record<string, string>): string {
  const lines = [
    "# BLUE-TANUKI local env",
    "# Updated by recovery control path. Keep this file private.",
    "",
  ];
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value === undefined) continue;
    const safeValue = /^[A-Za-z0-9_./:@,+-]*$/.test(value)
      ? value
      : JSON.stringify(value);
    lines.push(`${key}=${safeValue}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeEnvValues(
  env: NodeJS.ProcessEnv,
  values: Record<string, string>,
  label: string,
): Promise<string | undefined> {
  if (!env.BLUE_TANUKI_ENV_FILE) {
    throw new Error("env_file_required");
  }
  const envFile = (await runtimeSafeTarget(env, path.resolve(env.BLUE_TANUKI_ENV_FILE), "env_file_write", {
    allow_exact: [path.resolve(env.BLUE_TANUKI_ENV_FILE)],
  })).path;
  const result = await writeEnvFileAtomic(envFile, renderEnvValues(values), {
    backup: true,
    backup_label: label,
  });
  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
  }
  return result.backup_path;
}

function deleteEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): void {
  for (const key of keys) {
    delete env[key];
  }
}

export async function buildRecoverySnapshot(env: NodeJS.ProcessEnv = process.env): Promise<RecoverySnapshot> {
  const schedulesDir = env.BLUE_TANUKI_SCHEDULES_DIR ??
    (env.BLUE_TANUKI_FILE_ROOT ? path.join(env.BLUE_TANUKI_FILE_ROOT, "schedules") : undefined);
  const backups = await recoveryBackupInventory(env);
  const envFile = await envBackups(env.BLUE_TANUKI_ENV_FILE);
  const envConfigured = Boolean(env.BLUE_TANUKI_ENV_FILE);
  const canWriteEnv = envConfigured;

  return {
    schema_version: 1,
    surface: "recovery",
    mode: "control_available",
    env_file: envFile,
    recovery_backups: backups,
    runtime_paths: {
      file_root: await pathStatus(env.BLUE_TANUKI_FILE_ROOT, true),
      recovery_root: await pathStatus(recoveryRoot(env), true),
      session_dir: await pathStatus(env.BLUE_TANUKI_SESSION_DIR, true),
      audit_dir: await pathStatus(env.BLUE_TANUKI_AUDIT_DIR, true),
      memory_file: await pathStatus(env.BLUE_TANUKI_MEMORY_FILE, true),
      memory_dir: await pathStatus(env.BLUE_TANUKI_MEMORY_DIR, true),
      failure_memory_file: await pathStatus(env.BLUE_TANUKI_FAILURE_MEMORY_FILE, true),
      failure_memory_dir: await pathStatus(env.BLUE_TANUKI_FAILURE_MEMORY_DIR, true),
      schedules_dir: await pathStatus(schedulesDir, true),
      log_dir: await pathStatus(env.BLUE_TANUKI_LOG_DIR, true),
    },
    restore: {
      execution_available: backups.backup_count > 0,
      backup_available: true,
      latest_backup_id: backups.latest_backup_id,
      factory_reset_available: canWriteEnv,
      provider_reset_available: canWriteEnv,
      connector_reset_available: canWriteEnv,
      destructive_repair_available: false,
      confirmation_required: true,
    },
    authority_boundary: AUTHORITY_BOUNDARY,
    next_safe_action:
      backups.backup_count > 0
        ? "Use Backup Now before reset, or Restore Latest after confirming the selected recovery pack."
        : "Create a recovery backup before reset or restore operations.",
    evidence_source: ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"],
  };
}

export async function createRecoveryBackup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecoveryActionResult> {
  const manifest = await createBackupManifest(env, "backup");
  return actionResult("backup", {
    backup_id: manifest.backup_id,
    backup_manifest_path: manifest.manifest_path,
    next_safe_action: "Backup completed. Keep the recovery root private because copied env material may contain secrets.",
  });
}

export async function restoreRecoveryBackup(
  env: NodeJS.ProcessEnv = process.env,
  options: RestoreRecoveryOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "RESTORE");
  const id = options.backup_id ?? (await latestBackupId(env));
  if (!id) throw new Error("backup_not_found");
  const preRestore = await createBackupManifest(env, "pre_restore");
  const manifest = await readManifest(env, id);
  const result = await restoreManifest(env, manifest);
  return actionResult("restore", {
    restored_backup_id: id,
    restored_items_count: result.restored,
    removed_paths_count: result.removed,
    pre_action_backup_id: preRestore.backup_id,
    pre_action_backup_manifest_path: preRestore.manifest_path,
    next_safe_action: "Restart BLUE-TANUKI and run doctor/audit verification after restore.",
  });
}

export async function resetRecoveryProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: RecoveryResetOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "RESET_PROVIDER");
  const preReset = await createBackupManifest(env, "backup");
  const values = await readEnvValues(env);
  for (const key of PROVIDER_RESET_KEYS) {
    delete values[key];
  }
  values.LLM_BACKEND = "stub";
  await writeEnvValues(env, values, "provider-reset");
  deleteEnvKeys(env, PROVIDER_RESET_KEYS);
  env.LLM_BACKEND = "stub";
  return actionResult("provider_reset", {
    backup_id: preReset.backup_id,
    backup_manifest_path: preReset.manifest_path,
    reset_keys: [...PROVIDER_RESET_KEYS, "LLM_BACKEND"],
    next_safe_action: "Restart BLUE-TANUKI. Provider is reset to stub until a new provider is configured.",
  });
}

export async function resetRecoveryConnector(
  env: NodeJS.ProcessEnv = process.env,
  options: RecoveryResetOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "RESET_CONNECTOR");
  const preReset = await createBackupManifest(env, "backup");
  const values = await readEnvValues(env);
  for (const key of CONNECTOR_RESET_KEYS) {
    delete values[key];
  }
  values.COMPOSIO_DRY_RUN = "true";
  values.COMPOSIO_LIVE_EXECUTION = "false";
  await writeEnvValues(env, values, "connector-reset");
  deleteEnvKeys(env, CONNECTOR_RESET_KEYS);
  env.COMPOSIO_DRY_RUN = "true";
  env.COMPOSIO_LIVE_EXECUTION = "false";
  return actionResult("connector_reset", {
    backup_id: preReset.backup_id,
    backup_manifest_path: preReset.manifest_path,
    reset_keys: [...CONNECTOR_RESET_KEYS, "COMPOSIO_DRY_RUN", "COMPOSIO_LIVE_EXECUTION"],
    next_safe_action: "Restart BLUE-TANUKI. Composio remains dry-run until explicitly reconfigured.",
  });
}

export async function factoryResetRecovery(
  env: NodeJS.ProcessEnv = process.env,
  options: RecoveryResetOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "FACTORY_RESET");
  const preFactory = await createBackupManifest(env, "pre_factory_reset");
  const values = await readEnvValues(env);
  for (const key of [...PROVIDER_RESET_KEYS, ...CONNECTOR_RESET_KEYS]) {
    delete values[key];
  }
  values.LLM_BACKEND = "stub";
  values.COMPOSIO_DRY_RUN = "true";
  values.COMPOSIO_LIVE_EXECUTION = "false";
  await writeEnvValues(env, values, "factory-reset");
  deleteEnvKeys(env, [...PROVIDER_RESET_KEYS, ...CONNECTOR_RESET_KEYS]);
  env.LLM_BACKEND = "stub";
  env.COMPOSIO_DRY_RUN = "true";
  env.COMPOSIO_LIVE_EXECUTION = "false";

  const removedPaths: string[] = [];
  const resetTargets = [
    env.BLUE_TANUKI_SESSION_DIR,
    env.BLUE_TANUKI_MEMORY_FILE,
    env.BLUE_TANUKI_MEMORY_DIR,
    env.BLUE_TANUKI_FAILURE_MEMORY_FILE,
    env.BLUE_TANUKI_FAILURE_MEMORY_DIR,
    env.BLUE_TANUKI_SCHEDULES_DIR ??
      (env.BLUE_TANUKI_FILE_ROOT ? path.join(env.BLUE_TANUKI_FILE_ROOT, "schedules") : undefined),
    env.BLUE_TANUKI_LOG_DIR,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  for (const value of resetTargets) {
    if (!value) continue;
    const resolved = (await runtimeSafeTarget(env, path.resolve(value), "factory_reset_remove", {
      allow_exact: resetTargets,
    })).path;
    await fs.rm(resolved, { recursive: true, force: true }).catch(() => undefined);
    removedPaths.push(resolved);
  }

  const preserved = [
    env.BLUE_TANUKI_AUDIT_DIR ? path.resolve(env.BLUE_TANUKI_AUDIT_DIR) : null,
    recoveryRoot(env),
  ].filter((value): value is string => Boolean(value));

  return actionResult("factory_reset", {
    backup_id: preFactory.backup_id,
    backup_manifest_path: preFactory.manifest_path,
    removed_paths_count: removedPaths.length,
    reset_keys: [
      ...PROVIDER_RESET_KEYS,
      ...CONNECTOR_RESET_KEYS,
      "LLM_BACKEND",
      "COMPOSIO_DRY_RUN",
      "COMPOSIO_LIVE_EXECUTION",
    ],
    preserved_paths: preserved,
    next_safe_action: "Restart BLUE-TANUKI. Audit and recovery backup roots were preserved for rollback evidence.",
  });
}
