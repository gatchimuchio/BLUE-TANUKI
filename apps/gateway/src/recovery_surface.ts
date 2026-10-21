import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnvFile, writeEnvFileAtomic } from "./env_file.js";
import {
  CANONICAL_STATE_STORE_PATHS,
  captureCanonicalStateSnapshots,
  inspectCanonicalStateStoreTarget,
  inspectCanonicalStateSnapshots,
  restoreCanonicalStateSnapshotStore,
  resolveCanonicalStateStoreTargetPath,
  type CanonicalStateSnapshotEntryStatus,
  type CanonicalStateSnapshotInspection,
  type CanonicalStateSnapshotManifest,
  type CanonicalStateStoreKey,
} from "./canonical_state_backup.js";
import {
  inspectOperationPlanRecoveryLedger,
  readOperationPlanRecoveryCheckpointSnapshot,
  type OperationPlanRecoveryInspection,
} from "./operation_plan_recovery_inspection.js";
import { OperationPlanStateStore } from "./operation_plan_store.js";
import {
  inspectCanonicalStateStoreLedger,
  inspectGatewayRecoveryCanonicalArchive,
  type RecoveryPlanDependencyCategory,
  type RecoverySelectedPlanResidualObservation,
  type RecoverySelectedStoreLedgerStatus,
} from "./recovery_inspection.js";
import { GatewayExecutionIntentStore } from "./execution_intent_store.js";

export type RecoveryPathKind = "file" | "directory" | "missing" | "unset" | "unknown";
export type RecoveryAction =
  | "backup"
  | "restore"
  | "provider_reset"
  | "connector_reset"
  | "factory_reset";
type RecoveryMutationAction = Exclude<RecoveryAction, "backup">;

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
    restore_review_request_available: boolean;
    backup_available: boolean;
    latest_backup_id: string | null;
    factory_reset_review_request_available: boolean;
    provider_reset_review_request_available: boolean;
    connector_reset_review_request_available: boolean;
    factory_reset_available: boolean;
    provider_reset_available: boolean;
    connector_reset_available: boolean;
    blocked_reason: "owner_l3_review_required";
    destructive_repair_available: false;
    confirmation_required: true;
  };
  authority_boundary: RecoveryAuthorityBoundary;
  post_action_observation: Omit<RecoveryPostActionObservation, "command_id_digest" | "restored_state_digest">;
  next_safe_action: string;
  evidence_source: readonly ["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"];
}

export interface RecoveryPostActionObservation {
  status: "changed" | "failed" | "mismatch" | "matched" | "unverified" | "no_record";
  operation: RecoveryMutationAction | null;
  store_key: CanonicalStateStoreKey | null;
  operation_digest: string | null;
  result_digest: string | null;
  /** Internal correlation only; omitted from the Recovery UI projection. */
  command_id_digest: string | null;
  /** Expected digest of the restored canonical store, not the current checkpoint. */
  restored_state_digest: string | null;
  store_ledger_status: RecoverySelectedStoreLedgerStatus | null;
  store_ledger_residual_count: number | null;
  plan_residuals: readonly RecoverySelectedPlanResidualObservation[] | null;
  restore_backup_id_digest: string | null;
  /** Digest of the operation plan requested by L3. */
  restore_scope_plan_digest: string | null;
  readonly restore_scope_mode?: "plan_scoped_merge_v1";
  plan_restore_points: readonly RecoveryPlanRestorePointObservation[] | null;
  configuration_state:
    | "provider_stub"
    | "connector_dry_run"
    | "provider_connector_dry_run"
    | "not_observed";
  evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME" | "COMPLETE_HISTORY" | "NONE";
  used_for_authority: false;
  may_execute: false;
}

export interface RecoveryPlanRestorePointObservation {
  readonly plan_id_digest: string;
  readonly backup_plan_record_status: "matched" | "not_found" | "ambiguous" | "unverified";
  readonly backup_plan_integrity: "verified" | "residuals_present" | null;
  readonly backup_plan_record_count: number | null;
  readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
}

export interface RecoveryHistoryEvidenceEntry {
  kind: "execution_history" | "final_output";
  command_id: string | null;
  index: number;
  timestamp: number;
  used_for_authority: false;
  payload: unknown;
}

export interface RecoveryHistoryEvidence {
  entries: readonly RecoveryHistoryEvidenceEntry[];
  chain_valid: boolean;
  skipped_count: number;
  not_before_timestamp_ms?: number;
}

export interface RecoveryPostActionObservationOptions {
  /** Startup observations require the mutation to predate this process. In-process restore checks are explicit and command-bound. */
  readonly mode?: "after_restart" | "in_process_restore" | "startup_operation_plan_hold" | "startup_canonical_store_hold";
  readonly expected_command_id?: string;
}

export interface RecoveryStoreRestoreAttemptEvidence {
  readonly schema_version: 1;
  readonly store_key: CanonicalStateStoreKey;
  readonly backup_id_digest: string;
}

export interface RecoveryStoreRestoreHistoryEvidence {
  readonly schema_version: 1;
  readonly store_key: CanonicalStateStoreKey;
  readonly restored_store_state_digest: string;
  readonly restored_backup_id_digest?: string;
  readonly restore_scope_plan_digest?: string;
  readonly restore_scope_mode?: "plan_scoped_merge_v1";
}

export interface RecoveryActionResult {
  schema_version: 1;
  surface: "recovery";
  action: RecoveryAction;
  status: "completed";
  backup_id?: string;
  backup_manifest_path?: string;
  restored_backup_id?: string;
  restored_store_key?: CanonicalStateStoreKey;
  restored_store_archive_digest?: string;
  restored_store_state_digest?: string;
  restore_scope_kind?: "operation_plan";
  restore_scope_digest?: string;
  restore_scope_mode?: "plan_scoped_merge_v1";
  canonical_state_cross_store_atomic?: false;
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

export interface RecoveryBackupInspection {
  schema_version: 1;
  surface: "recovery_backup_inspection";
  mode: "read_only";
  status: "verified" | "not_found" | "invalid";
  backup_id_digest: string | null;
  coverage: "complete_for_configured_targets" | "partial" | "none_configured" | "unknown";
  configured_required_item_count: number | null;
  copied_required_item_count: number | null;
  missing_required_item_count: number | null;
  canonical_state_coverage: "not_included" | "unknown" | CanonicalStateSnapshotInspection["coverage"];
  canonical_state_expected_store_count: number | null;
  canonical_state_snapshot_count: number | null;
  canonical_state_verified_store_count: number | null;
  canonical_state_missing_store_count: number | null;
  canonical_state_unverified_store_count: number | null;
  canonical_state_store_consistency: CanonicalStateSnapshotInspection["store_consistency"] | "not_included";
  canonical_state_cross_store_atomic: false | null;
  canonical_state_stores: readonly {
    readonly store_key: CanonicalStateStoreKey;
    readonly status: CanonicalStateSnapshotEntryStatus;
  }[];
  operation_plan_archive_inventory: RecoveryBackupOperationPlanInventory;
  operation_plan_archive_dependencies: RecoveryBackupOperationPlanDependencyInventory;
  used_for_authority: false;
  may_execute: false;
}

export interface RecoveryScopeApplicabilityRequest {
  readonly backup_id_digest: string;
  readonly scope_kind: "request_scope" | "operation_plan";
  readonly scope_digest: string;
  readonly store_candidates: readonly CanonicalStateStoreKey[];
}

export interface RecoveryScopeApplicabilityInspection {
  readonly schema_version: 1;
  readonly surface: "recovery_scope_applicability";
  readonly mode: "read_only";
  readonly status: "matched" | "unverified";
  readonly reason:
    | "invalid_request"
    | "backup_not_found"
    | "backup_unverified"
    | "scope_not_found"
    | "scope_ambiguous"
    | "dependency_unverified"
    | "dependency_not_mapped"
    | "store_unverified"
    | null;
  readonly scope_kind: RecoveryScopeApplicabilityRequest["scope_kind"] | null;
  readonly scope_digest: string | null;
  readonly backup_id_digest: string | null;
  readonly matched_plan_id_digest: string | null;
  readonly matched_plan_scope_count: number | null;
  readonly store_candidate_count: number | null;
  readonly verified_store_candidate_count: number | null;
  readonly dependency_scope_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly store_candidates: readonly {
    readonly store_key: CanonicalStateStoreKey;
    readonly snapshot_status: CanonicalStateSnapshotEntryStatus | "unknown";
    readonly dependency_status: "residuals_present" | "unobserved" | "no_residual_recorded" | "not_mapped" | "unknown";
    readonly related_dependencies: readonly RecoveryPlanDependencyCategory[];
  }[];
  readonly cross_store_atomic: false | null;
  readonly external_backup_restore_point: "not_examined";
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface RecoveryBackupOperationPlanDependencyInventory {
  readonly status:
    | "not_included"
    | "not_present"
    | "snapshot_unverified"
    | "unavailable"
    | "no_plan_scopes"
    | "correlated"
    | "residuals_present"
    | "unobserved";
  readonly reason: "snapshot_unverified" | "operation_plan_unavailable" | null;
  readonly plan_scope_count: number | null;
  readonly residual_plan_scope_count: number | null;
  readonly unobserved_plan_scope_count: number | null;
  readonly omitted_plan_scope_count: number | null;
  readonly plan_scopes: readonly {
    readonly plan_id_digest: string;
    readonly status: "observed" | "residuals_present" | "unobserved";
    readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
    readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
  }[];
  readonly cross_store_consistency: "independent_sqlite_online_snapshots" | "not_included";
  readonly cross_store_atomic: false | null;
  readonly external_backup_restore_point: "not_examined";
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface RecoveryBackupOperationPlanInventory {
  readonly status: "not_included" | "not_present" | "snapshot_unverified" | OperationPlanRecoveryInspection["status"];
  readonly reason: OperationPlanRecoveryInspection["reason"] | "snapshot_unverified";
  readonly plan_scope_count: number | null;
  readonly plan_count: number | null;
  readonly plan_integrity_residual_count: number | null;
  readonly binding_count: number | null;
  readonly verified_binding_count: number | null;
  readonly residual_binding_count: number | null;
  readonly unverified_memory_link_count: number | null;
  readonly omitted_binding_count: number | null;
  readonly omitted_plan_scope_count: number | null;
  readonly plan_scopes: readonly {
    readonly plan_id_digest: string;
    readonly request_scope_digest: string | null;
    readonly integrity: "verified" | "residuals_present";
    readonly plan_record_count: number;
    readonly binding_count: number;
    readonly residual_binding_count: number;
    readonly omitted_binding_count: number;
  }[];
  readonly cross_ledger_correlation: "not_performed";
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface RestoreRecoveryOptions {
  backup_id?: string;
  store_key?: CanonicalStateStoreKey;
  scope_kind?: "operation_plan";
  scope_digest?: string;
  /** Private Executor context; never accepted from recovery tool arguments. */
  executor_command_key?: string;
  /** Existing Gateway owner connection; Broker restore must not open a second writer. */
  broker_execution_store?: GatewayExecutionIntentStore;
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
  canonical_state_snapshot?: CanonicalStateSnapshotManifest;
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
  "BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON",
  "BLUE_TANUKI_RESOURCE_BACKPRESSURE_POLICY_JSON",
  "BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON",
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

  const canonicalStateSnapshot = await captureCanonicalStateSnapshots(
    env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
    packDir,
  );

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
    canonical_state_snapshot: canonicalStateSnapshot,
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

function isRecoveryBackupManifestItem(value: unknown): value is RecoveryBackupManifestItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key === "string" &&
    typeof item.env_key === "string" &&
    (typeof item.source_path === "string" || item.source_path === null) &&
    (typeof item.archive_path === "string" || item.archive_path === null) &&
    (typeof item.archive_rel_path === "string" || item.archive_rel_path === null) &&
    typeof item.exists === "boolean" &&
    ["file", "directory", "missing", "unset", "unknown"].includes(String(item.kind)) &&
    typeof item.copied === "boolean" &&
    typeof item.backup_required === "boolean" &&
    typeof item.bytes === "number" &&
    (typeof item.sha256 === "string" || item.sha256 === null) &&
    (item.skipped_reason === undefined || typeof item.skipped_reason === "string")
  );
}

async function assertArchiveTreeHasNoSymlinks(archivePath: string, kind: "file" | "directory"): Promise<void> {
  const rootStat = await fs.lstat(archivePath);
  if (rootStat.isSymbolicLink()) throw new Error("invalid_backup_manifest_archive_symlink");
  if (kind === "file") {
    if (!rootStat.isFile()) throw new Error("invalid_backup_manifest_archive_kind");
    return;
  }
  if (!rootStat.isDirectory()) throw new Error("invalid_backup_manifest_archive_kind");

  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("invalid_backup_manifest_archive_symlink");
      if (entry.isDirectory()) await walk(child);
      else if (!entry.isFile()) throw new Error("invalid_backup_manifest_archive_kind");
    }
  };
  await walk(archivePath);
}

async function preflightRestoreManifest(env: NodeJS.ProcessEnv, manifest: RecoveryBackupManifest): Promise<void> {
  const rawItems: unknown = manifest.items;
  const expectedSpecs = sourceSpecs(env);
  if (!Array.isArray(rawItems) || rawItems.length !== expectedSpecs.length) {
    throw new Error("invalid_backup_manifest_items");
  }
  const expectedByPair = new Map<string, RecoverySourceSpec>(
    expectedSpecs.map((spec) => [`${spec.key}:${spec.env_key}`, spec]),
  );
  const seen = new Set<string>();
  const expectedTargets = configuredRuntimeTargets(env);
  const packDir = path.dirname(manifest.manifest_path);

  for (const value of rawItems as unknown[]) {
    if (!isRecoveryBackupManifestItem(value)) throw new Error("invalid_backup_manifest_item");
    const item = value;
    const pair = `${item.key}:${item.env_key}`;
    const spec = expectedByPair.get(pair);
    if (!spec || seen.has(pair) || item.backup_required !== spec.backup_required) {
      throw new Error("invalid_backup_manifest_item_identity");
    }
    seen.add(pair);

    if (item.source_path === null) {
      if (
        item.copied || item.exists || item.archive_path !== null || item.archive_rel_path !== null ||
        item.sha256 !== null || item.bytes !== 0
      ) {
        throw new Error(`invalid_backup_manifest_item_state:${item.key}`);
      }
      continue;
    }

    const expected = expectedTargets.get(pair);
    if (!expected) throw new Error(`invalid_backup_manifest_target:${item.key}:not_configured`);
    const sourcePath = trimTrailingSeparators(item.source_path);
    if (sourcePath !== expected) {
      throw new Error(`invalid_backup_manifest_target:${item.key}:source_path_mismatch`);
    }
    await runtimeSafeTarget(env, sourcePath, `restore_target:${item.key}`, { allow_exact: [expected] });

    if (!item.copied) {
      if (
        item.exists || item.archive_path !== null || item.archive_rel_path !== null ||
        item.sha256 !== null || item.bytes !== 0 || !["missing", "unknown"].includes(item.kind)
      ) {
        throw new Error(`invalid_backup_manifest_item_state:${item.key}`);
      }
      continue;
    }

    if (
      !item.exists || (item.kind !== "file" && item.kind !== "directory") ||
      typeof item.archive_rel_path !== "string" || item.archive_rel_path.length === 0 ||
      typeof item.archive_path !== "string" || !path.isAbsolute(item.archive_path) ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0
    ) {
      throw new Error(`invalid_backup_manifest_item_state:${item.key}`);
    }
    const archive = await assertArchivePath(
      packDir,
      path.resolve(packDir, item.archive_rel_path),
      `restore_archive:${item.key}`,
    );
    if (trimTrailingSeparators(item.archive_path) !== archive) {
      throw new Error(`invalid_backup_manifest_archive_path:${item.key}`);
    }
    const relative = path.relative(packDir, archive);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("invalid_backup_manifest_archive_path");
    }
    await assertArchiveTreeHasNoSymlinks(archive, item.kind);
    const digest = await sha256Path(archive, item.kind);
    if (digest.sha256 !== item.sha256 || digest.bytes !== item.bytes) {
      throw new Error(`invalid_backup_manifest_archive_digest:${item.key}`);
    }
  }

  if (seen.size !== expectedByPair.size) throw new Error("invalid_backup_manifest_items");
}

async function latestBackupId(env: NodeJS.ProcessEnv): Promise<string | null> {
  const inventory = await recoveryBackupInventory(env);
  return inventory.latest_backup_id;
}

function emptyBackupOperationPlanInventory(
  status: RecoveryBackupOperationPlanInventory["status"],
  reason: RecoveryBackupOperationPlanInventory["reason"] = null,
): RecoveryBackupOperationPlanInventory {
  return {
    status, reason, plan_scope_count: null, plan_count: null, plan_integrity_residual_count: null,
    binding_count: null, verified_binding_count: null, residual_binding_count: null,
    unverified_memory_link_count: null, omitted_binding_count: null,
    omitted_plan_scope_count: null, plan_scopes: [], cross_ledger_correlation: "not_performed",
    used_for_authority: false, may_execute: false,
  };
}

function emptyBackupOperationPlanDependencyInventory(
  status: RecoveryBackupOperationPlanDependencyInventory["status"],
  options: {
    readonly reason?: RecoveryBackupOperationPlanDependencyInventory["reason"];
    readonly included?: boolean;
  } = {},
): RecoveryBackupOperationPlanDependencyInventory {
  const included = options.included ?? status !== "not_included";
  return {
    status,
    reason: options.reason ?? null,
    plan_scope_count: null,
    residual_plan_scope_count: null,
    unobserved_plan_scope_count: null,
    omitted_plan_scope_count: null,
    plan_scopes: [],
    cross_store_consistency: included ? "independent_sqlite_online_snapshots" : "not_included",
    cross_store_atomic: included ? false : null,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
  };
}

/** Correlate only per-store verified canonical archives, then confirm every inspected archive stayed byte-identical. */
async function inspectBackupOperationPlanDependencies(
  packDirectory: string,
  snapshot: CanonicalStateSnapshotManifest | undefined,
): Promise<RecoveryBackupOperationPlanDependencyInventory> {
  if (!snapshot) return emptyBackupOperationPlanDependencyInventory("not_included", { included: false });
  const planEntry = snapshot.entries.find((entry) => entry.store_key === "operation_plans");
  if (!planEntry) {
    return emptyBackupOperationPlanDependencyInventory("snapshot_unverified", { reason: "snapshot_unverified" });
  }
  if (planEntry.status === "not_present") {
    return emptyBackupOperationPlanDependencyInventory("not_present");
  }
  if (planEntry.status !== "verified" || !planEntry.archive_rel_path || !planEntry.sha256) {
    return emptyBackupOperationPlanDependencyInventory("snapshot_unverified", { reason: "snapshot_unverified" });
  }

  const report = inspectGatewayRecoveryCanonicalArchive(packDirectory, snapshot);
  const verifiedEntries = snapshot.entries.filter((entry) => entry.status === "verified");
  const afterInspection = await Promise.all(verifiedEntries.map(async (entry) => {
    if (!entry.archive_rel_path || !entry.sha256) return null;
    const archivePath = path.resolve(packDirectory, entry.archive_rel_path);
    const digest = await sha256Path(archivePath, "file").catch(() => null);
    return digest && digest.bytes === entry.bytes && digest.sha256 === entry.sha256 ? digest : null;
  }));
  if (afterInspection.some((digest) => digest === null)) {
    return emptyBackupOperationPlanDependencyInventory("snapshot_unverified", { reason: "snapshot_unverified" });
  }

  if (report.ledgers.operation_plans.status !== "verified" && report.ledgers.operation_plans.status !== "residuals_present") {
    return emptyBackupOperationPlanDependencyInventory("unavailable", { reason: "operation_plan_unavailable" });
  }

  const allScopes = report.plan_dependency_scopes;
  const planScopes = allScopes.slice(0, 64).map((scope) => ({
    plan_id_digest: scope.plan_id_digest,
    status: scope.status,
    residual_dependencies: [...scope.residual_dependencies],
    unobserved_dependencies: [...scope.unobserved_dependencies],
  }));
  const residualPlanScopeCount = allScopes.filter((scope) => scope.status === "residuals_present").length;
  const unobservedPlanScopeCount = allScopes.filter((scope) => scope.status === "unobserved").length;
  const status: RecoveryBackupOperationPlanDependencyInventory["status"] = allScopes.length === 0
    ? "no_plan_scopes"
    : residualPlanScopeCount > 0 ? "residuals_present"
      : unobservedPlanScopeCount > 0 ? "unobserved" : "correlated";
  return {
    status,
    reason: null,
    plan_scope_count: allScopes.length,
    residual_plan_scope_count: residualPlanScopeCount,
    unobserved_plan_scope_count: unobservedPlanScopeCount,
    omitted_plan_scope_count: allScopes.length - planScopes.length,
    plan_scopes: planScopes,
    cross_store_consistency: "independent_sqlite_online_snapshots",
    cross_store_atomic: false,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
  };
}

/** Inspect only J's archived plan checkpoint after its enclosing snapshot digest passed. */
async function inspectBackupOperationPlanInventory(
  packDirectory: string,
  snapshot: CanonicalStateSnapshotManifest | undefined,
): Promise<RecoveryBackupOperationPlanInventory> {
  if (!snapshot) return emptyBackupOperationPlanInventory("not_included");
  const entry = snapshot.entries.find((item) => item.store_key === "operation_plans");
  if (!entry) return emptyBackupOperationPlanInventory("snapshot_unverified", "snapshot_unverified");
  if (entry.status === "not_present") return emptyBackupOperationPlanInventory("not_present");
  if (entry.status !== "verified" || !entry.archive_rel_path || !entry.sha256) {
    return emptyBackupOperationPlanInventory("snapshot_unverified", "snapshot_unverified");
  }

  const archivePath = path.resolve(packDirectory, entry.archive_rel_path);
  const inspected = inspectOperationPlanRecoveryLedger({ private_state_root: packDirectory, database_path: archivePath });
  const afterInspection = await sha256Path(archivePath, "file").catch(() => null);
  if (!afterInspection || afterInspection.bytes !== entry.bytes || afterInspection.sha256 !== entry.sha256) {
    return emptyBackupOperationPlanInventory("snapshot_unverified", "snapshot_unverified");
  }
  if (inspected.status !== "verified" && inspected.status !== "residuals_present") {
    return emptyBackupOperationPlanInventory(inspected.status, inspected.reason);
  }

  const planScopes = inspected.plans.slice(0, 64).map((plan) => ({
    plan_id_digest: plan.plan_id_digest,
    request_scope_digest: plan.request_scope_digest,
    integrity: plan.integrity,
    plan_record_count: plan.plan_record_count,
    binding_count: plan.binding_count,
    residual_binding_count: plan.residual_binding_count,
    omitted_binding_count: plan.omitted_binding_count,
  }));
  return {
    status: inspected.status,
    reason: inspected.reason,
    plan_scope_count: inspected.plans.length,
    plan_count: inspected.plan_count,
    plan_integrity_residual_count: inspected.plan_integrity_residual_count,
    binding_count: inspected.binding_count,
    verified_binding_count: inspected.verified_binding_count,
    residual_binding_count: inspected.residual_binding_count,
    unverified_memory_link_count: inspected.unverified_memory_link_count,
    omitted_binding_count: inspected.omitted_binding_count,
    omitted_plan_scope_count: Math.max(0, inspected.plans.length - planScopes.length),
    plan_scopes: planScopes,
    cross_ledger_correlation: "not_performed",
    used_for_authority: false,
    may_execute: false,
  };
}

const RECOVERY_SCOPE_DIGEST = /^[a-f0-9]{64}$/i;
const RECOVERY_SCOPE_DEPENDENCIES: Readonly<Record<CanonicalStateStoreKey, readonly RecoveryPlanDependencyCategory[]>> = {
  j_control: [],
  m_state: ["memory"],
  broker: ["broker", "delivery"],
  operation_plans: ["operation_plan"],
  cron_events: ["cron_approval"],
};

async function backupIdForDigest(env: NodeJS.ProcessEnv, requestedDigest: string): Promise<string | null> {
  const root = (await runtimeSafeTarget(env, recoveryRoot(env), "recovery_root", {
    allow_under_recovery_root: true,
  })).path;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const matches = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => {
      if (!/^[A-Za-z0-9_.-]+$/u.test(id)) return false;
      return createHash("sha256").update(id).digest("hex") === requestedDigest;
    });
  return matches.length === 1 ? matches[0]! : null;
}

/** Verify one selected recovery pack's manifest and archived item digests without restoring or writing. */
async function inspectRecoveryBackup(
  env: NodeJS.ProcessEnv,
  selectBackupId: () => Promise<string | null>,
): Promise<RecoveryBackupInspection> {
  const base = {
    schema_version: 1 as const,
    surface: "recovery_backup_inspection" as const,
    mode: "read_only" as const,
    canonical_state_coverage: "not_included" as const,
    canonical_state_expected_store_count: null,
    canonical_state_snapshot_count: null,
    canonical_state_verified_store_count: null,
    canonical_state_missing_store_count: null,
    canonical_state_unverified_store_count: null,
    canonical_state_store_consistency: "not_included" as const,
    canonical_state_cross_store_atomic: null,
    canonical_state_stores: [],
    operation_plan_archive_inventory: emptyBackupOperationPlanInventory("not_included"),
    operation_plan_archive_dependencies: emptyBackupOperationPlanDependencyInventory("not_included", { included: false }),
    used_for_authority: false as const,
    may_execute: false as const,
  };
  let backupId: string | null = null;
  try {
    backupId = await selectBackupId();
    if (!backupId) {
      return {
        ...base,
        status: "not_found",
        backup_id_digest: null,
        coverage: "unknown",
        configured_required_item_count: null,
        copied_required_item_count: null,
        missing_required_item_count: null,
      };
    }
    const manifest = await readManifest(env, backupId);
    if (manifest.action !== "backup" && manifest.action !== "pre_restore" && manifest.action !== "pre_factory_reset") {
      throw new Error("invalid_backup_manifest_action");
    }
    if (manifest.secret_material !== true || manifest.used_for_authority !== false ||
        manifest.hds_brain_remains_authority !== true ||
        JSON.stringify(manifest.authority_boundary) !== JSON.stringify(AUTHORITY_BOUNDARY) ||
        JSON.stringify(manifest.evidence_source) !== JSON.stringify(["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"])) {
      throw new Error("invalid_backup_manifest_boundary");
    }
    await preflightRestoreManifest(env, manifest);
    const canonicalState = manifest.canonical_state_snapshot
      ? await inspectCanonicalStateSnapshots(path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot)
      : null;
    const canonicalStateStores = manifest.canonical_state_snapshot
      ? manifest.canonical_state_snapshot.entries.map(({ store_key, status }) => ({ store_key, status }))
      : [];
    const operationPlanArchiveInventory = await inspectBackupOperationPlanInventory(
      path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot,
    );
    const operationPlanArchiveDependencies = await inspectBackupOperationPlanDependencies(
      path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot,
    );
    const configuredRequiredItems = manifest.items.filter((item) => item.backup_required && item.source_path !== null);
    const copiedRequiredItems = configuredRequiredItems.filter((item) => item.copied);
    const missingRequiredItemCount = configuredRequiredItems.length - copiedRequiredItems.length;
    return {
      ...base,
      status: "verified",
      backup_id_digest: createHash("sha256").update(backupId).digest("hex"),
      coverage: configuredRequiredItems.length === 0
        ? "none_configured"
        : missingRequiredItemCount === 0 ? "complete_for_configured_targets" : "partial",
      configured_required_item_count: configuredRequiredItems.length,
      copied_required_item_count: copiedRequiredItems.length,
      missing_required_item_count: missingRequiredItemCount,
      canonical_state_coverage: canonicalState?.coverage ?? "not_included",
      canonical_state_expected_store_count: canonicalState?.expected_store_count ?? null,
      canonical_state_snapshot_count: canonicalState?.captured_store_count ?? null,
      canonical_state_verified_store_count: canonicalState?.verified_store_count ?? null,
      canonical_state_missing_store_count: canonicalState?.missing_store_count ?? null,
      canonical_state_unverified_store_count: canonicalState?.unverified_store_count ?? null,
      canonical_state_store_consistency: canonicalState?.store_consistency ?? "not_included",
      canonical_state_cross_store_atomic: canonicalState?.cross_store_atomic ?? null,
      canonical_state_stores: canonicalStateStores,
      operation_plan_archive_inventory: operationPlanArchiveInventory,
      operation_plan_archive_dependencies: operationPlanArchiveDependencies,
    };
  } catch {
    return {
      ...base,
      status: "invalid",
      backup_id_digest: backupId ? createHash("sha256").update(backupId).digest("hex") : null,
      coverage: "unknown",
      configured_required_item_count: null,
      copied_required_item_count: null,
      missing_required_item_count: null,
      canonical_state_coverage: "unknown",
      canonical_state_stores: [],
      operation_plan_archive_dependencies: emptyBackupOperationPlanDependencyInventory("snapshot_unverified", {
        reason: "snapshot_unverified",
      }),
    };
  }
}

/** Verify the newest recovery pack's manifest and archived item digests without restoring or writing. */
export async function inspectLatestRecoveryBackup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecoveryBackupInspection> {
  return inspectRecoveryBackup(env, () => latestBackupId(env));
}

function emptyRecoveryScopeApplicability(
  reason: RecoveryScopeApplicabilityInspection["reason"],
  request: Partial<RecoveryScopeApplicabilityRequest> = {},
): RecoveryScopeApplicabilityInspection {
  return {
    schema_version: 1,
    surface: "recovery_scope_applicability",
    mode: "read_only",
    status: "unverified",
    reason,
    scope_kind: request.scope_kind === "request_scope" || request.scope_kind === "operation_plan" ? request.scope_kind : null,
    scope_digest: typeof request.scope_digest === "string" && RECOVERY_SCOPE_DIGEST.test(request.scope_digest)
      ? request.scope_digest.toLowerCase() : null,
    backup_id_digest: typeof request.backup_id_digest === "string" && RECOVERY_SCOPE_DIGEST.test(request.backup_id_digest)
      ? request.backup_id_digest.toLowerCase() : null,
    matched_plan_id_digest: null,
    matched_plan_scope_count: null,
    store_candidate_count: null,
    verified_store_candidate_count: null,
    dependency_scope_status: "unknown",
    residual_dependencies: [],
    unobserved_dependencies: [],
    store_candidates: [],
    cross_store_atomic: null,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
  };
}

function normalizeRecoveryScopeApplicabilityRequest(value: unknown): RecoveryScopeApplicabilityRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.backup_id_digest !== "string" || !RECOVERY_SCOPE_DIGEST.test(input.backup_id_digest) ||
      (input.scope_kind !== "request_scope" && input.scope_kind !== "operation_plan") ||
      typeof input.scope_digest !== "string" || !RECOVERY_SCOPE_DIGEST.test(input.scope_digest) ||
      !Array.isArray(input.store_candidates) || input.store_candidates.length < 1 || input.store_candidates.length > 5) return null;
  const allowedStores = new Set<CanonicalStateStoreKey>(CANONICAL_STATE_STORE_PATHS.map((item) => item.key));
  if (!input.store_candidates.every((item) => typeof item === "string" && allowedStores.has(item as CanonicalStateStoreKey))) return null;
  const storeCandidates = input.store_candidates as CanonicalStateStoreKey[];
  if (new Set(storeCandidates).size !== storeCandidates.length) return null;
  return {
    backup_id_digest: input.backup_id_digest.toLowerCase(),
    scope_kind: input.scope_kind,
    scope_digest: input.scope_digest.toLowerCase(),
    store_candidates: storeCandidates,
  };
}

function recoveryScopeDependencyStatus(
  related: readonly RecoveryPlanDependencyCategory[],
  residual: readonly RecoveryPlanDependencyCategory[],
  unobserved: readonly RecoveryPlanDependencyCategory[],
): RecoveryScopeApplicabilityInspection["store_candidates"][number]["dependency_status"] {
  if (related.length === 0) return "not_mapped";
  if (related.some((category) => unobserved.includes(category))) return "unobserved";
  if (related.some((category) => residual.includes(category))) return "residuals_present";
  return "no_residual_recorded";
}

/** Read-only exact-scope correlation against one digest-selected backup and fixed canonical stores. */
export async function inspectRecoveryScopeApplicability(
  env: NodeJS.ProcessEnv,
  requestValue: unknown,
): Promise<RecoveryScopeApplicabilityInspection> {
  const request = normalizeRecoveryScopeApplicabilityRequest(requestValue);
  if (!request) return emptyRecoveryScopeApplicability("invalid_request");

  const backup = await inspectRecoveryBackup(env, () => backupIdForDigest(env, request.backup_id_digest));
  const baseRequest = request;
  if (backup.status === "not_found") return emptyRecoveryScopeApplicability("backup_not_found", baseRequest);
  if (backup.status !== "verified" || backup.backup_id_digest !== request.backup_id_digest) {
    return emptyRecoveryScopeApplicability("backup_unverified", baseRequest);
  }

  const inventory = backup.operation_plan_archive_inventory;
  const dependencies = backup.operation_plan_archive_dependencies;
  if ((inventory.status !== "verified" && inventory.status !== "residuals_present") ||
      (dependencies.status !== "correlated" && dependencies.status !== "residuals_present" && dependencies.status !== "unobserved") ||
      inventory.omitted_plan_scope_count !== 0 || dependencies.omitted_plan_scope_count !== 0 ||
      inventory.plan_scope_count === null || dependencies.plan_scope_count === null ||
      inventory.plan_scopes.length !== inventory.plan_scope_count || dependencies.plan_scopes.length !== dependencies.plan_scope_count) {
    return emptyRecoveryScopeApplicability("dependency_unverified", baseRequest);
  }

  const matchingPlans = inventory.plan_scopes.filter((plan) => request.scope_kind === "operation_plan"
    ? plan.plan_id_digest === request.scope_digest
    : plan.request_scope_digest === request.scope_digest);
  if (matchingPlans.length === 0) return emptyRecoveryScopeApplicability("scope_not_found", baseRequest);
  if (matchingPlans.length !== 1) {
    return {
      ...emptyRecoveryScopeApplicability("scope_ambiguous", baseRequest),
      matched_plan_scope_count: matchingPlans.length,
    };
  }

  const matchedPlan = matchingPlans[0]!;
  if (matchedPlan.integrity !== "verified") {
    return emptyRecoveryScopeApplicability("dependency_unverified", baseRequest);
  }
  const matchingDependencyScopes = dependencies.plan_scopes.filter((scope) => scope.plan_id_digest === matchedPlan.plan_id_digest);
  if (matchingDependencyScopes.length !== 1) {
    return {
      ...emptyRecoveryScopeApplicability("dependency_unverified", baseRequest),
      matched_plan_id_digest: matchedPlan.plan_id_digest,
      matched_plan_scope_count: 1,
    };
  }
  const dependencyScope = matchingDependencyScopes[0]!;
  const snapshotStatuses = new Map(backup.canonical_state_stores.map((entry) => [entry.store_key, entry.status]));
  if (snapshotStatuses.size !== 5 || backup.canonical_state_cross_store_atomic !== false) {
    return emptyRecoveryScopeApplicability("store_unverified", baseRequest);
  }

  const storeCandidates = request.store_candidates.map((storeKey) => {
    const relatedDependencies = RECOVERY_SCOPE_DEPENDENCIES[storeKey];
    const snapshotStatus: CanonicalStateSnapshotEntryStatus | "unknown" = snapshotStatuses.get(storeKey) ?? "unknown";
    return {
      store_key: storeKey,
      snapshot_status: snapshotStatus,
      dependency_status: recoveryScopeDependencyStatus(
        relatedDependencies,
        dependencyScope.residual_dependencies,
        dependencyScope.unobserved_dependencies,
      ),
      related_dependencies: [...relatedDependencies],
    };
  });
  const verifiedStoreCandidateCount = storeCandidates.filter((item) => item.snapshot_status === "verified").length;
  const unverifiedDependency = storeCandidates.some((item) =>
    item.dependency_status === "unobserved" || item.dependency_status === "not_mapped" || item.dependency_status === "unknown");
  const unverifiedStore = verifiedStoreCandidateCount !== storeCandidates.length;
  const reason = unverifiedStore ? "store_unverified"
    : unverifiedDependency ? (storeCandidates.some((item) => item.dependency_status === "not_mapped")
      ? "dependency_not_mapped" : "dependency_unverified")
      : null;
  return {
    schema_version: 1,
    surface: "recovery_scope_applicability",
    mode: "read_only",
    status: reason === null ? "matched" : "unverified",
    reason,
    scope_kind: request.scope_kind,
    scope_digest: request.scope_digest,
    backup_id_digest: request.backup_id_digest,
    matched_plan_id_digest: matchedPlan.plan_id_digest,
    matched_plan_scope_count: 1,
    store_candidate_count: storeCandidates.length,
    verified_store_candidate_count: verifiedStoreCandidateCount,
    dependency_scope_status: dependencyScope.status,
    residual_dependencies: [...dependencyScope.residual_dependencies],
    unobserved_dependencies: [...dependencyScope.unobserved_dependencies],
    store_candidates: storeCandidates,
    cross_store_atomic: false,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
  };
}

/** Bind an Operation Plan digest to one exact backup without exposing the backup ID. */
export async function inspectRecoveryPlanRestoreScopeApplicability(
  env: NodeJS.ProcessEnv,
  backupId: string,
  planIdDigest: string,
): Promise<RecoveryScopeApplicabilityInspection> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(backupId) || backupId === "latest" ||
      !RECOVERY_SCOPE_DIGEST.test(planIdDigest)) {
    return emptyRecoveryScopeApplicability("invalid_request", {
      ...( /^[A-Za-z0-9_.-]{1,128}$/u.test(backupId) && backupId !== "latest"
        ? { backup_id_digest: createHash("sha256").update(backupId).digest("hex") }
        : {}),
      scope_kind: "operation_plan",
      scope_digest: planIdDigest,
    });
  }
  return inspectRecoveryScopeApplicability(env, {
    backup_id_digest: createHash("sha256").update(backupId).digest("hex"),
    scope_kind: "operation_plan",
    scope_digest: planIdDigest.toLowerCase(),
    store_candidates: ["operation_plans"],
  });
}

export function isVerifiedRecoveryPlanRestoreScope(
  inspection: RecoveryScopeApplicabilityInspection,
  backupId: string,
  planIdDigest: string,
): boolean {
  const store = inspection.store_candidates[0];
  return inspection.status === "matched" && inspection.reason === null &&
    inspection.scope_kind === "operation_plan" && inspection.scope_digest === planIdDigest.toLowerCase() &&
    inspection.backup_id_digest === createHash("sha256").update(backupId).digest("hex") &&
    inspection.matched_plan_id_digest === planIdDigest.toLowerCase() && inspection.matched_plan_scope_count === 1 &&
    inspection.store_candidate_count === 1 && inspection.verified_store_candidate_count === 1 &&
    inspection.cross_store_atomic === false && inspection.used_for_authority === false && inspection.may_execute === false &&
    store?.store_key === "operation_plans" && store.snapshot_status === "verified" &&
    (store.dependency_status === "no_residual_recorded" || store.dependency_status === "residuals_present") &&
    store.related_dependencies.length === 1 && store.related_dependencies[0] === "operation_plan";
}

async function requireVerifiedRecoveryPlanRestoreScope(
  env: NodeJS.ProcessEnv,
  backupId: string,
  scopeKind: string | undefined,
  scopeDigest: string | undefined,
): Promise<RecoveryScopeApplicabilityInspection> {
  if (scopeKind !== "operation_plan" || typeof scopeDigest !== "string" || !RECOVERY_SCOPE_DIGEST.test(scopeDigest)) {
    throw new Error("operation_plan_scope_required");
  }
  const inspection = await inspectRecoveryPlanRestoreScopeApplicability(env, backupId, scopeDigest);
  if (!isVerifiedRecoveryPlanRestoreScope(inspection, backupId, scopeDigest)) {
    throw new Error("operation_plan_scope_unverified");
  }
  return inspection;
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

const RECOVERY_OBSERVATION_OPERATIONS = {
  "recovery.restore": "restore",
  "recovery.reset_provider": "provider_reset",
  "recovery.reset_connector": "connector_reset",
  "recovery.factory_reset": "factory_reset",
} as const;

function isRecoveryObservationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoveryObservationDigest(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function recoveryBackupIdDigest(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value)
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

/** Keep only fixed store identity and digests needed for a non-authoritative post-restart observation. */
export function recoveryStoreRestoreHistoryEvidence(value: unknown): RecoveryStoreRestoreHistoryEvidence | undefined {
  if (!isRecoveryObservationRecord(value) || value.action !== "restore" || value.status !== "completed" ||
      value.used_for_authority !== false || value.canonical_state_cross_store_atomic !== false) return undefined;
  const storeKey = value.restored_store_key;
  if (typeof storeKey !== "string" || !CANONICAL_STATE_STORE_PATHS.some((store) => store.key === storeKey)) return undefined;
  const archiveDigest = recoveryObservationDigest(value.restored_store_archive_digest);
  const stateDigest = recoveryObservationDigest(value.restored_store_state_digest);
  const backupIdDigest = recoveryBackupIdDigest(value.restored_backup_id);
  if (!archiveDigest || !stateDigest || !backupIdDigest) return undefined;
  const scopeKind = value.restore_scope_kind;
  const scopeDigest = recoveryObservationDigest(value.restore_scope_digest);
  const scopeMode = value.restore_scope_mode;
  if (storeKey === "operation_plans") {
    if (scopeKind !== "operation_plan" || !scopeDigest ||
        (scopeMode !== undefined && scopeMode !== "plan_scoped_merge_v1")) return undefined;
  } else if (scopeKind !== undefined || value.restore_scope_digest !== undefined || scopeMode !== undefined) {
    return undefined;
  }
  return {
    schema_version: 1,
    store_key: storeKey as CanonicalStateStoreKey,
    restored_store_state_digest: stateDigest,
    restored_backup_id_digest: backupIdDigest,
    ...(storeKey === "operation_plans" ? { restore_scope_plan_digest: scopeDigest! } : {}),
    ...(scopeMode === "plan_scoped_merge_v1" ? { restore_scope_mode: scopeMode } : {}),
  };
}

/** Preserve only the selected store and backup digest so a failed restore can be held after restart. */
export function recoveryStoreRestoreAttemptHistoryEvidence(command: unknown): RecoveryStoreRestoreAttemptEvidence | undefined {
  if (!isRecoveryObservationRecord(command) || command.type !== "tool_call" ||
      !isRecoveryObservationRecord(command.payload) || command.payload.tool_name !== "recovery.restore" ||
      !isRecoveryObservationRecord(command.payload.arguments)) return undefined;
  const args = command.payload.arguments;
  if (typeof args.store_key !== "string" ||
      !CANONICAL_STATE_STORE_PATHS.some((store) => store.key === args.store_key)) return undefined;
  const backupIdDigest = recoveryBackupIdDigest(args.backup_id);
  if (!backupIdDigest) return undefined;
  return { schema_version: 1, store_key: args.store_key as CanonicalStateStoreKey, backup_id_digest: backupIdDigest };
}

function recoveryStoreRestoreAttemptFromHistory(value: unknown): RecoveryStoreRestoreAttemptEvidence | null {
  if (!isRecoveryObservationRecord(value) || value.schema_version !== 1 ||
      typeof value.store_key !== "string" ||
      !CANONICAL_STATE_STORE_PATHS.some((store) => store.key === value.store_key)) return null;
  const backupIdDigest = recoveryObservationDigest(value.backup_id_digest);
  if (!backupIdDigest) return null;
  return { schema_version: 1, store_key: value.store_key as CanonicalStateStoreKey, backup_id_digest: backupIdDigest };
}

function recoveryStoreRestoreEvidenceFromHistory(value: unknown): RecoveryStoreRestoreHistoryEvidence | null {
  if (!isRecoveryObservationRecord(value) || value.schema_version !== 1) return null;
  const storeKey = value.store_key;
  const stateDigest = recoveryObservationDigest(value.restored_store_state_digest);
  const backupIdDigest = recoveryObservationDigest(value.restored_backup_id_digest);
  const hasScopeDigest = value.restore_scope_plan_digest !== undefined;
  const scopeDigest = recoveryObservationDigest(value.restore_scope_plan_digest);
  const hasScopeMode = value.restore_scope_mode !== undefined;
  const scopeMode = value.restore_scope_mode;
  if (typeof storeKey !== "string" || !CANONICAL_STATE_STORE_PATHS.some((store) => store.key === storeKey) ||
      !stateDigest || (value.restored_backup_id_digest !== undefined && !backupIdDigest) ||
      (hasScopeDigest && !scopeDigest) ||
      (storeKey !== "operation_plans" && (hasScopeDigest || hasScopeMode)) ||
      (hasScopeMode && (scopeMode !== "plan_scoped_merge_v1" || !scopeDigest))) return null;
  return {
    schema_version: 1,
    store_key: storeKey as CanonicalStateStoreKey,
    restored_store_state_digest: stateDigest,
    ...(backupIdDigest ? { restored_backup_id_digest: backupIdDigest } : {}),
    ...(scopeDigest ? { restore_scope_plan_digest: scopeDigest } : {}),
    ...(scopeMode === "plan_scoped_merge_v1" ? { restore_scope_mode: scopeMode } : {}),
  };
}

function unverifiedPlanRestorePoint(planIdDigest: string): RecoveryPlanRestorePointObservation {
  return {
    plan_id_digest: planIdDigest,
    backup_plan_record_status: "unverified",
    backup_plan_integrity: null,
    backup_plan_record_count: null,
    dependency_status: "unknown",
    residual_dependencies: [],
    unobserved_dependencies: [],
  };
}

async function inspectRecoveryPlanRestorePoints(
  env: NodeJS.ProcessEnv,
  backupIdDigest: string,
  plans: readonly RecoverySelectedPlanResidualObservation[],
): Promise<readonly RecoveryPlanRestorePointObservation[]> {
  const backup = await inspectRecoveryBackup(env, () => backupIdForDigest(env, backupIdDigest));
  if (backup.status !== "verified" || backup.backup_id_digest !== backupIdDigest) {
    return plans.map((plan) => unverifiedPlanRestorePoint(plan.plan_id_digest));
  }

  const inventory = backup.operation_plan_archive_inventory;
  const inventoryComplete = (inventory.status === "verified" || inventory.status === "residuals_present") &&
    inventory.omitted_plan_scope_count === 0 && inventory.plan_scope_count !== null &&
    inventory.plan_scopes.length === inventory.plan_scope_count;
  const dependencies = backup.operation_plan_archive_dependencies;
  const dependencyInventoryComplete = (dependencies.status === "correlated" ||
    dependencies.status === "residuals_present" || dependencies.status === "unobserved" ||
    dependencies.status === "no_plan_scopes") && dependencies.omitted_plan_scope_count === 0 &&
    dependencies.plan_scope_count !== null && dependencies.plan_scopes.length === dependencies.plan_scope_count;

  return plans.map((plan): RecoveryPlanRestorePointObservation => {
    if (!inventoryComplete) return unverifiedPlanRestorePoint(plan.plan_id_digest);
    const matches = inventory.plan_scopes.filter((scope) => scope.plan_id_digest === plan.plan_id_digest);
    if (matches.length === 0) {
      return {
        plan_id_digest: plan.plan_id_digest,
        backup_plan_record_status: "not_found",
        backup_plan_integrity: null,
        backup_plan_record_count: null,
        dependency_status: "unknown",
        residual_dependencies: [],
        unobserved_dependencies: [],
      };
    }
    if (matches.length !== 1) {
      return {
        plan_id_digest: plan.plan_id_digest,
        backup_plan_record_status: "ambiguous",
        backup_plan_integrity: null,
        backup_plan_record_count: null,
        dependency_status: "unknown",
        residual_dependencies: [],
        unobserved_dependencies: [],
      };
    }

    const match = matches[0]!;
    const uniqueRecord = match.plan_record_count === 1;
    const dependencyMatches = dependencyInventoryComplete
      ? dependencies.plan_scopes.filter((scope) => scope.plan_id_digest === plan.plan_id_digest)
      : [];
    const dependency = uniqueRecord && dependencyMatches.length === 1 ? dependencyMatches[0] : undefined;
    return {
      plan_id_digest: plan.plan_id_digest,
      backup_plan_record_status: uniqueRecord ? "matched" : "ambiguous",
      backup_plan_integrity: match.integrity,
      backup_plan_record_count: match.plan_record_count,
      dependency_status: dependency?.status ?? "unknown",
      residual_dependencies: dependency ? [...dependency.residual_dependencies] : [],
      unobserved_dependencies: dependency ? [...dependency.unobserved_dependencies] : [],
    };
  });
}

function noRecoveryActionObservation(
  status: RecoveryPostActionObservation["status"],
): RecoveryPostActionObservation {
  return {
    status,
    operation: null,
    store_key: null,
    operation_digest: null,
    result_digest: null,
    command_id_digest: null,
    restored_state_digest: null,
    store_ledger_status: null,
    store_ledger_residual_count: null,
    plan_residuals: null,
    restore_backup_id_digest: null,
    restore_scope_plan_digest: null,
    plan_restore_points: null,
    configuration_state: "not_observed",
    evidence_source: "NONE",
    used_for_authority: false,
    may_execute: false,
  };
}

/** An invalid history can only restrict the identified store; it can never confirm restore or authorize work. */
function unverifiedRecoveryStoreHoldCandidate(history: RecoveryHistoryEvidence): RecoveryPostActionObservation {
  let latest: { index: number; storeKey: CanonicalStateStoreKey | null; backupIdDigest: string | null } | undefined;
  for (const entry of history.entries) {
    if (entry.kind !== "execution_history" || entry.used_for_authority !== false ||
        !isRecoveryObservationRecord(entry.payload)) continue;
    const command = entry.payload.command;
    if (!isRecoveryObservationRecord(command) || command.operation !== "recovery.restore" ||
        !isRecoveryObservationRecord(command.payload) || command.payload.tool_name !== "recovery.restore") continue;
    const attempt = recoveryStoreRestoreAttemptFromHistory(entry.payload.recovery_store_restore_attempt);
    const completed = recoveryStoreRestoreEvidenceFromHistory(entry.payload.recovery_store_restore);
    const commandArguments = isRecoveryObservationRecord(command.payload.arguments) ? command.payload.arguments : null;
    const commandStoreKey = typeof commandArguments?.store_key === "string" &&
      CANONICAL_STATE_STORE_PATHS.some((store) => store.key === commandArguments.store_key)
      ? commandArguments.store_key as CanonicalStateStoreKey
      : null;
    const candidateStoreKeys = [attempt?.store_key, completed?.store_key, commandStoreKey]
      .filter((value): value is CanonicalStateStoreKey => value !== undefined && value !== null);
    const distinctStoreKeys = [...new Set(candidateStoreKeys)];
    const storeKey = distinctStoreKeys.length === 1 ? distinctStoreKeys[0]! : null;
    const candidateBackupDigests = [attempt?.backup_id_digest, completed?.restored_backup_id_digest]
      .filter((value): value is string => value !== undefined && value !== null);
    const distinctBackupDigests = [...new Set(candidateBackupDigests)];
    const backupIdDigest = distinctBackupDigests.length === 1 ? distinctBackupDigests[0]! : null;
    if (latest && entry.index < latest.index) continue;
    latest = {
      index: entry.index,
      storeKey,
      backupIdDigest,
    };
  }
  if (!latest) return noRecoveryActionObservation("unverified");
  return {
    ...noRecoveryActionObservation("unverified"),
    operation: "restore",
    store_key: latest.storeKey,
    restore_backup_id_digest: latest.backupIdDigest,
  };
}

/** Re-observe the latest Recovery mutation from non-authoritative history and the current local environment. */
export async function buildRecoveryPostActionObservation(
  history: RecoveryHistoryEvidence,
  env: NodeJS.ProcessEnv = process.env,
  options: RecoveryPostActionObservationOptions = {},
): Promise<RecoveryPostActionObservation> {
  if (!history.chain_valid || history.skipped_count !== 0) {
    return options.mode === "startup_canonical_store_hold"
      ? unverifiedRecoveryStoreHoldCandidate(history)
      : noRecoveryActionObservation("unverified");
  }

  let latest: {
    entry: RecoveryHistoryEvidenceEntry;
    operation: keyof typeof RECOVERY_OBSERVATION_OPERATIONS;
    action: RecoveryMutationAction;
    argumentsDigest: string;
    executionStatus: unknown;
    resultDigest: string | null;
    commandIdDigest: string;
    restoreEvidence: RecoveryStoreRestoreHistoryEvidence | null;
    restoreAttempt: RecoveryStoreRestoreAttemptEvidence | null;
  } | undefined;
  for (const entry of history.entries) {
    if (entry.kind !== "execution_history" || entry.used_for_authority !== false || !entry.command_id ||
        !isRecoveryObservationRecord(entry.payload)) continue;
    const command = entry.payload.command;
    if (!isRecoveryObservationRecord(command) || !isRecoveryObservationRecord(command.payload)) continue;
    const toolName = command.payload.tool_name;
    if (typeof toolName !== "string" ||
        !Object.prototype.hasOwnProperty.call(RECOVERY_OBSERVATION_OPERATIONS, toolName) ||
        command.operation !== toolName) continue;
    const operation = toolName as keyof typeof RECOVERY_OBSERVATION_OPERATIONS;
    const restoreEvidence = operation === "recovery.restore" && isRecoveryObservationRecord(entry.payload)
      ? recoveryStoreRestoreEvidenceFromHistory(entry.payload.recovery_store_restore) : null;
    const restoreAttempt = operation === "recovery.restore" && isRecoveryObservationRecord(entry.payload)
      ? recoveryStoreRestoreAttemptFromHistory(entry.payload.recovery_store_restore_attempt) : null;
    if (options.mode === "startup_operation_plan_hold" && operation !== "recovery.restore") continue;
    if (options.mode === "startup_operation_plan_hold" && restoreEvidence && restoreEvidence.store_key !== "operation_plans") continue;
    if (options.mode === "startup_operation_plan_hold" && !restoreEvidence && restoreAttempt?.store_key !== "operation_plans") continue;
    if (options.mode === "startup_canonical_store_hold" && operation !== "recovery.restore") continue;
    const argumentsDigest = recoveryObservationDigest(command.payload.arguments_digest);
    if (!argumentsDigest) {
      if (!latest || entry.index >= latest.entry.index) {
        latest = {
          entry,
          operation,
          action: RECOVERY_OBSERVATION_OPERATIONS[operation],
          argumentsDigest: "",
          executionStatus: entry.payload.status,
          resultDigest: recoveryObservationDigest(entry.payload.result_digest),
          commandIdDigest: createHash("sha256").update(entry.command_id).digest("hex"),
          restoreEvidence,
          restoreAttempt,
        };
      }
      continue;
    }
    if (!latest || entry.index >= latest.entry.index) {
      latest = {
        entry,
        operation,
        action: RECOVERY_OBSERVATION_OPERATIONS[operation],
        argumentsDigest,
        executionStatus: entry.payload.status,
        resultDigest: recoveryObservationDigest(entry.payload.result_digest),
        commandIdDigest: createHash("sha256").update(entry.command_id).digest("hex"),
        restoreEvidence,
        restoreAttempt,
      };
    }
  }
  if (!latest) return noRecoveryActionObservation("no_record");

  const operationDigest = latest.argumentsDigest
    ? createHash("sha256").update(`${latest.operation}\n${latest.argumentsDigest}`).digest("hex")
    : null;
  const unverified: RecoveryPostActionObservation = {
    status: "unverified",
    operation: latest.action,
    store_key: null,
    operation_digest: operationDigest,
    result_digest: latest.resultDigest,
    command_id_digest: latest.commandIdDigest,
    restored_state_digest: latest.restoreEvidence?.restored_store_state_digest ?? null,
    store_ledger_status: null,
    store_ledger_residual_count: null,
    plan_residuals: null,
    restore_backup_id_digest: null,
    restore_scope_plan_digest: latest.restoreEvidence?.restore_scope_plan_digest ?? null,
    ...(latest.restoreEvidence?.restore_scope_mode === "plan_scoped_merge_v1"
      ? { restore_scope_mode: latest.restoreEvidence.restore_scope_mode }
      : {}),
    plan_restore_points: null,
    configuration_state: "not_observed",
    evidence_source: "COMPLETE_HISTORY",
    used_for_authority: false,
    may_execute: false,
  };
  if (!operationDigest) return unverified;
  if (options.mode === "in_process_restore" &&
      (latest.action !== "restore" || !options.expected_command_id || latest.entry.command_id !== options.expected_command_id)) {
    return unverified;
  }
  if (options.mode !== "in_process_restore" && options.expected_command_id !== undefined) return unverified;
  if ((options.mode === "startup_operation_plan_hold" || options.mode === "startup_canonical_store_hold") &&
      (latest.action !== "restore" || latest.entry.timestamp >= (history.not_before_timestamp_ms ?? Number.POSITIVE_INFINITY))) {
    return unverified;
  }
  if (latest.action !== "restore" && history.not_before_timestamp_ms !== undefined &&
      latest.entry.timestamp < history.not_before_timestamp_ms) return unverified;

  const finalOutput = history.entries
    .filter((entry) => entry.kind === "final_output" && entry.command_id === latest!.entry.command_id &&
      entry.used_for_authority === false && isRecoveryObservationRecord(entry.payload))
    .sort((left, right) => right.index - left.index)[0];
  const finalPayload = finalOutput && isRecoveryObservationRecord(finalOutput.payload) ? finalOutput.payload : null;
  if (!finalPayload || finalPayload.used_for_authority !== false || finalPayload.status !== latest.executionStatus) {
    return unverified;
  }
  if (latest.executionStatus === "failed") {
    const finalResultDigest = recoveryObservationDigest(finalPayload.result_digest);
    if (latest.resultDigest !== finalResultDigest) return unverified;
    if (latest.restoreAttempt && latest.restoreEvidence &&
        (latest.restoreAttempt.store_key !== latest.restoreEvidence.store_key ||
          latest.restoreAttempt.backup_id_digest !== latest.restoreEvidence.restored_backup_id_digest)) {
      return { ...unverified, store_key: null, restore_backup_id_digest: null };
    }
    return {
      ...unverified,
      status: "failed",
      store_key: latest.restoreEvidence?.store_key ?? latest.restoreAttempt?.store_key ?? null,
      restore_backup_id_digest: latest.restoreEvidence?.restored_backup_id_digest ?? latest.restoreAttempt?.backup_id_digest ?? null,
    };
  }
  if (latest.executionStatus !== "success" || !latest.resultDigest ||
      recoveryObservationDigest(finalPayload.result_digest) !== latest.resultDigest || finalPayload.result_present !== true) {
    return unverified;
  }

  if (latest.action === "restore") {
    const payload = isRecoveryObservationRecord(latest.entry.payload) ? latest.entry.payload : null;
    const restoreEvidence = latest.restoreEvidence ?? (payload
      ? recoveryStoreRestoreEvidenceFromHistory(payload.recovery_store_restore)
      : null);
    if (!restoreEvidence) {
      return {
        ...unverified,
        store_key: latest.restoreAttempt?.store_key ?? null,
        restore_backup_id_digest: latest.restoreAttempt?.backup_id_digest ?? null,
      };
    }
    if (latest.restoreAttempt &&
        (latest.restoreAttempt.store_key !== restoreEvidence.store_key ||
          latest.restoreAttempt.backup_id_digest !== restoreEvidence.restored_backup_id_digest)) {
      return { ...unverified, store_key: null, restore_backup_id_digest: null };
    }
    const predatesCurrentProcess = history.not_before_timestamp_ms !== undefined &&
      latest.entry.timestamp < history.not_before_timestamp_ms;
    if (options.mode === "in_process_restore") {
      if ((restoreEvidence.store_key !== "operation_plans" && restoreEvidence.store_key !== "cron_events" &&
          restoreEvidence.store_key !== "j_control" && restoreEvidence.store_key !== "m_state") ||
          history.not_before_timestamp_ms === undefined || predatesCurrentProcess) {
        return { ...unverified, store_key: restoreEvidence.store_key,
          restore_backup_id_digest: restoreEvidence.restored_backup_id_digest ?? null };
      }
    } else if (options.mode !== "startup_operation_plan_hold" && !predatesCurrentProcess) {
      return {
        ...unverified,
        store_key: restoreEvidence.store_key,
        restore_backup_id_digest: restoreEvidence.restored_backup_id_digest ?? null,
      };
    }
    if (restoreEvidence.store_key === "operation_plans" && !restoreEvidence.restore_scope_plan_digest) {
      return {
        ...unverified,
        store_key: restoreEvidence.store_key,
        restore_backup_id_digest: restoreEvidence.restored_backup_id_digest ?? null,
      };
    }
    const target = await inspectCanonicalStateStoreTarget(
      env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
      restoreEvidence.store_key,
    );
    if (target.status === "not_present" || target.status === "mismatch") {
      return {
        ...unverified,
        status: "mismatch",
        store_key: restoreEvidence.store_key,
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
      };
    }
    if (target.status !== "verified" || !target.sha256) {
      return {
        ...unverified,
        store_key: restoreEvidence.store_key,
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
      };
    }
    const storeLedger = inspectCanonicalStateStoreLedger(
      env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
      restoreEvidence.store_key,
    );
    // Keep backup membership correlation after later plan-store writes so newly created plans can be distinguished from restored plans.
    const planRestorePoints = restoreEvidence.store_key === "operation_plans" &&
      restoreEvidence.restored_backup_id_digest && storeLedger.plan_residuals
      ? await inspectRecoveryPlanRestorePoints(
          env,
          restoreEvidence.restored_backup_id_digest,
          storeLedger.plan_residuals,
        )
      : null;
    const afterLedgerInspection = await inspectCanonicalStateStoreTarget(
      env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
      restoreEvidence.store_key,
    );
    if (afterLedgerInspection.status !== "verified" || afterLedgerInspection.sha256 !== target.sha256 ||
        afterLedgerInspection.bytes !== target.bytes) {
      return {
        ...unverified,
        store_key: restoreEvidence.store_key,
        store_ledger_status: "unverified",
        evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
      };
    }
    return {
      ...unverified,
      status: target.sha256 === restoreEvidence.restored_store_state_digest ? "matched" : "changed",
      store_key: restoreEvidence.store_key,
      store_ledger_status: storeLedger.status,
      store_ledger_residual_count: storeLedger.residual_count,
      plan_residuals: restoreEvidence.store_key === "operation_plans" ? storeLedger.plan_residuals : null,
      restore_backup_id_digest: restoreEvidence.restored_backup_id_digest ?? null,
      restore_scope_plan_digest: restoreEvidence.restore_scope_plan_digest ?? null,
      ...(restoreEvidence.restore_scope_mode === "plan_scoped_merge_v1"
        ? { restore_scope_mode: restoreEvidence.restore_scope_mode }
        : {}),
      plan_restore_points: planRestorePoints,
      evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
    };
  }
  let values: Record<string, string>;
  try {
    values = await readEnvValues(env);
  } catch {
    return unverified;
  }
  const processKeysAbsent = (keys: readonly string[]) => keys.every((key) => env[key] === undefined);
  const fileKeysAbsent = (keys: readonly string[]) => keys.every((key) => !Object.prototype.hasOwnProperty.call(values, key));
  const providerResetObserved =
    values.LLM_BACKEND === "stub" && env.LLM_BACKEND === "stub" &&
    fileKeysAbsent(PROVIDER_RESET_KEYS) && processKeysAbsent(PROVIDER_RESET_KEYS);
  const connectorResetObserved =
    values.COMPOSIO_DRY_RUN === "true" && env.COMPOSIO_DRY_RUN === "true" &&
    values.COMPOSIO_LIVE_EXECUTION === "false" && env.COMPOSIO_LIVE_EXECUTION === "false" &&
    fileKeysAbsent(CONNECTOR_RESET_KEYS) && processKeysAbsent(CONNECTOR_RESET_KEYS);
  const observed = latest.action === "provider_reset"
    ? providerResetObserved
    : latest.action === "connector_reset"
      ? connectorResetObserved
      : providerResetObserved && connectorResetObserved;
  const configurationState = latest.action === "provider_reset" && providerResetObserved
    ? "provider_stub"
    : latest.action === "connector_reset" && connectorResetObserved
      ? "connector_dry_run"
      : latest.action === "factory_reset" && observed
        ? "provider_connector_dry_run"
        : "not_observed";
  return {
    ...unverified,
    status: observed && latest.action !== "factory_reset" ? "changed" : "unverified",
    configuration_state: configurationState,
    evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
  };
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

export async function buildRecoverySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  postActionObservation: RecoveryPostActionObservation = noRecoveryActionObservation("no_record"),
): Promise<RecoverySnapshot> {
  const schedulesDir = env.BLUE_TANUKI_SCHEDULES_DIR ??
    (env.BLUE_TANUKI_FILE_ROOT ? path.join(env.BLUE_TANUKI_FILE_ROOT, "schedules") : undefined);
  const backups = await recoveryBackupInventory(env);
  const envFile = await envBackups(env.BLUE_TANUKI_ENV_FILE);
  const { command_id_digest: _commandIdDigest, restored_state_digest: _restoredStateDigest,
    ...publicPostActionObservation } = postActionObservation;
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
      execution_available: false,
      restore_review_request_available: backups.latest_backup_id !== null,
      backup_available: true,
      latest_backup_id: backups.latest_backup_id,
      factory_reset_review_request_available: envFile.configured,
      provider_reset_review_request_available: envFile.configured,
      connector_reset_review_request_available: envFile.configured,
      factory_reset_available: false,
      provider_reset_available: false,
      connector_reset_available: false,
      blocked_reason: "owner_l3_review_required",
      destructive_repair_available: false,
      confirmation_required: true,
    },
    authority_boundary: AUTHORITY_BOUNDARY,
    post_action_observation: publicPostActionObservation,
    next_safe_action: "Submit an available recovery change for HDS L3 owner review. Maintenance access only queues the exact operation; it does not execute it. Canonical SQLite snapshots are not applied by generic Restore.",
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
    next_safe_action: "Inspect the pack to verify generic files and each canonical SQLite snapshot. Database snapshots are not atomically aligned across stores and are not applied by generic Restore; keep the recovery root private.",
  });
}

export async function restoreRecoveryBackup(
  env: NodeJS.ProcessEnv = process.env,
  options: RestoreRecoveryOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "RESTORE");
  const id = options.backup_id ?? (await latestBackupId(env));
  if (!id) throw new Error("backup_not_found");
  let planScopeInspection: RecoveryScopeApplicabilityInspection | undefined;
  if (options.store_key === "operation_plans") {
    planScopeInspection = await requireVerifiedRecoveryPlanRestoreScope(env, id, options.scope_kind, options.scope_digest);
  }
  const manifest = await readManifest(env, id);
  if (options.store_key) {
    const packDir = path.dirname(manifest.manifest_path);
    const snapshot = manifest.canonical_state_snapshot;
    if (!snapshot) throw new Error("canonical_state_snapshot_missing");
    await inspectCanonicalStateSnapshots(packDir, snapshot);
    const selected = snapshot.entries.find((entry) => entry.store_key === options.store_key);
    if (!selected || selected.status !== "verified" || !selected.archive_rel_path || !selected.sha256) {
      throw new Error("canonical_state_store_unverified");
    }
    if (options.store_key === "broker" && !/^[a-f0-9]{64}$/.test(options.executor_command_key ?? "")) {
      throw new Error("broker_restore_execution_context_missing");
    }
    if (options.store_key === "broker" && !options.broker_execution_store) {
      throw new Error("broker_restore_execution_store_unavailable");
    }

    const targetPath = resolveCanonicalStateStoreTargetPath(
      env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
      options.store_key,
    );
    await runtimeSafeTarget(env, targetPath, "canonical_restore_target", { allow_exact: [targetPath] });
    const targetExists = await fs.lstat(targetPath).then((stat) => {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("canonical_state_restore_target_unavailable");
      return true;
    }).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return false;
      throw error;
    });

    const preRestore = await createBackupManifest(env, "pre_restore");
    const preSnapshot = preRestore.canonical_state_snapshot;
    if (!preSnapshot) throw new Error("pre_restore_canonical_snapshot_missing");
    const preRestorePackDir = path.dirname(preRestore.manifest_path);
    await inspectCanonicalStateSnapshots(preRestorePackDir, preSnapshot);
    const preEntry = preSnapshot.entries.find((entry) => entry.store_key === options.store_key);
    let preRestorePlanCheckpoint: ReturnType<typeof readOperationPlanRecoveryCheckpointSnapshot> | null = null;
    if (options.store_key === "operation_plans" && targetExists) {
      if (preEntry?.status !== "verified" || !preEntry.archive_rel_path || !preEntry.sha256) {
        throw new Error("pre_restore_store_unverified");
      }
      const preArchivePath = path.resolve(preRestorePackDir, preEntry.archive_rel_path);
      const preArchiveBefore = await sha256Path(preArchivePath, "file").catch(() => null);
      if (!preArchiveBefore || preArchiveBefore.bytes !== preEntry.bytes || preArchiveBefore.sha256 !== preEntry.sha256) {
        throw new Error("pre_restore_store_unverified");
      }
      preRestorePlanCheckpoint = readOperationPlanRecoveryCheckpointSnapshot({
        private_state_root: preRestorePackDir,
        database_path: preArchivePath,
      });
      const preArchiveAfter = await sha256Path(preArchivePath, "file").catch(() => null);
      if (!preArchiveAfter || preArchiveAfter.bytes !== preEntry.bytes || preArchiveAfter.sha256 !== preEntry.sha256) {
        throw new Error("pre_restore_store_unverified");
      }
    }
    const acceptableBefore = options.store_key === "operation_plans"
      ? targetExists ? preEntry?.status === "verified" : preEntry?.status === "not_present"
      : targetExists
        ? preEntry?.status === "verified" || preEntry?.status === "captured_unverified"
        : preEntry?.status === "not_present";
    if (!acceptableBefore) throw new Error("pre_restore_store_unverified");
    if (targetExists) {
      if (!preEntry?.archive_rel_path || !preEntry.sha256) throw new Error("pre_restore_store_unverified");
      const beforeRestore = await sha256Path(targetPath, "file").catch(() => null);
      if (!beforeRestore || beforeRestore.sha256 !== preEntry.sha256 || beforeRestore.bytes !== preEntry.bytes) {
        throw new Error("canonical_state_restore_target_changed");
      }
    }

    if (options.store_key === "operation_plans") {
      planScopeInspection = await requireVerifiedRecoveryPlanRestoreScope(env, id, options.scope_kind, options.scope_digest);
    }
    let restored: { readonly bytes: number; readonly sha256: string; readonly restoredStateSha256: string };
    if (options.store_key === "broker") {
      const archivePath = path.resolve(packDir, selected.archive_rel_path);
      const archiveBefore = await sha256Path(archivePath, "file").catch(() => null);
      if (!archiveBefore || archiveBefore.bytes !== selected.bytes || archiveBefore.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      options.broker_execution_store!.restoreFromCanonicalSnapshot(archivePath, options.executor_command_key!);
      const archiveAfter = await sha256Path(archivePath, "file").catch(() => null);
      if (!archiveAfter || archiveAfter.bytes !== selected.bytes || archiveAfter.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      const target = await inspectCanonicalStateStoreTarget(
        env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
        options.store_key,
      );
      if (target.status !== "verified" || target.sha256 === null || target.bytes === null) {
        throw new Error("canonical_state_restore_target_unverified");
      }
      restored = { bytes: selected.bytes, sha256: selected.sha256, restoredStateSha256: target.sha256 };
    } else if (options.store_key === "operation_plans") {
      const archivePath = path.resolve(packDir, selected.archive_rel_path);
      const archiveBefore = await sha256Path(archivePath, "file").catch(() => null);
      if (!archiveBefore || archiveBefore.bytes !== selected.bytes || archiveBefore.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      const archivedCheckpoint = readOperationPlanRecoveryCheckpointSnapshot({
        private_state_root: packDir,
        database_path: archivePath,
      });
      const archiveAfterRead = await sha256Path(archivePath, "file").catch(() => null);
      if (!archiveAfterRead || archiveAfterRead.bytes !== selected.bytes || archiveAfterRead.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      const targetExistsNow = await fs.lstat(targetPath).then((stat) => {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("canonical_state_restore_target_unavailable");
        return true;
      }).catch((error: unknown) => {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (code === "ENOENT") return false;
        throw error;
      });
      if (targetExistsNow !== targetExists) throw new Error("canonical_state_restore_target_changed");
      if (targetExists) {
        const latestTargetDigest = await sha256Path(targetPath, "file").catch(() => null);
        if (!preEntry?.sha256 || !latestTargetDigest || latestTargetDigest.bytes !== preEntry.bytes ||
            latestTargetDigest.sha256 !== preEntry.sha256) {
          throw new Error("canonical_state_restore_target_changed");
        }
      }
      const operationPlanStore = new OperationPlanStateStore(targetPath);
      try {
        operationPlanStore.restorePlanScope(
          archivedCheckpoint,
          planScopeInspection!.scope_digest!,
          preRestorePlanCheckpoint,
        );
      } finally {
        operationPlanStore.close();
      }
      const archiveAfterWrite = await sha256Path(archivePath, "file").catch(() => null);
      if (!archiveAfterWrite || archiveAfterWrite.bytes !== selected.bytes || archiveAfterWrite.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      const target = await inspectCanonicalStateStoreTarget(
        env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
        options.store_key,
      );
      if (target.status !== "verified" || target.sha256 === null || target.bytes === null) {
        throw new Error("canonical_state_restore_target_unverified");
      }
      restored = { bytes: selected.bytes, sha256: selected.sha256, restoredStateSha256: target.sha256 };
    } else {
      restored = await restoreCanonicalStateSnapshotStore(
        env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki",
        packDir,
        snapshot,
        options.store_key,
      );
    }
    return actionResult("restore", {
      restored_backup_id: id,
      restored_store_key: options.store_key,
      restored_store_archive_digest: restored.sha256,
      restored_store_state_digest: restored.restoredStateSha256,
      ...(planScopeInspection ? {
        restore_scope_kind: "operation_plan" as const,
        restore_scope_digest: planScopeInspection.scope_digest!,
        restore_scope_mode: "plan_scoped_merge_v1" as const,
      } : {}),
      canonical_state_cross_store_atomic: false,
      pre_action_backup_id: preRestore.backup_id,
      pre_action_backup_manifest_path: preRestore.manifest_path,
      next_safe_action: options.store_key === "broker"
        ? "The restored-state digest marks the atomic import boundary while this restore's Executor receipt is still in progress; Executor then finalizes that receipt in Broker. Inspect cross-store residuals before resuming affected work. Only this selected SQLite store was restored; cross-store atomicity is false, and job recovery or automatic resume is not implied."
        : "Restart BLUE-TANUKI, then inspect the restored store and all cross-store residuals. Only this selected SQLite store was restored; snapshots are independent, cross-store atomicity is false, and job recovery or automatic resume is not implied.",
    });
  }

  await preflightRestoreManifest(env, manifest);
  const preRestore = await createBackupManifest(env, "pre_restore");
  const result = await restoreManifest(env, manifest);
  return actionResult("restore", {
    restored_backup_id: id,
    restored_items_count: result.restored,
    removed_paths_count: result.removed,
    pre_action_backup_id: preRestore.backup_id,
    pre_action_backup_manifest_path: preRestore.manifest_path,
    next_safe_action: "Restart BLUE-TANUKI and run doctor/audit verification after restore. Generic Restore does not apply the canonical SQLite snapshots; do not treat the per-store snapshot set as a job-level restore point.",
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
