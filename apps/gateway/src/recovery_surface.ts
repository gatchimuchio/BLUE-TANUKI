import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recoveryRootPath as recoveryRoot } from "@blue-tanuki/core";
import { AuditLog, inspectGoalPurposeRecovery } from "@blue-tanuki/hds-brain";
import { AUDIT_FILENAME } from "./audit_config.js";
import { parseEnvFile, writeEnvFileAtomic } from "./env_file.js";
import { goalGovernanceConfigFromEnvironment } from "./goal_governance_config.js";
import {
  CANONICAL_STATE_STORE_PATHS,
  RESTORABLE_CANONICAL_STATE_STORES,
  captureCanonicalStateSnapshots,
  inspectCanonicalStateStoreTarget,
  inspectCanonicalStateSnapshots,
  isRestorableCanonicalStateStore,
  restoreCanonicalStateSnapshotStore,
  resolveCanonicalStateStoreInspectionPath,
  resolveCanonicalStateStoreTargetPath,
  type CanonicalStateSnapshotEntryStatus,
  type CanonicalStateSnapshotInspection,
  type CanonicalStateSnapshotManifest,
  type CanonicalStateStoreKey,
  type CanonicalStateStoreTargetInspection,
  type RestorableCanonicalStateStoreKey,
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
  inspectGatewayRecoveryState,
  type RecoveryPlanDependencyCategory,
  type RecoverySelectedPlanResidualObservation,
  type RecoverySelectedStoreLedgerStatus,
} from "./recovery_inspection.js";
import { GatewayExecutionIntentStore } from "./execution_intent_store.js";
import { resolveFailureMemoryFilePath } from "./failure_memory_paths.js";
import { resolveRuntimeSchedulesDirectory } from "./runtime_path_config.js";
import type { RuntimeRecoveryFenceEvidence } from "./runtime_owner_lease.js";

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
    full_restore_review_request_available: boolean;
    full_restore_blocked_reason: "blocked_runtime_restore_requires_offline_gateway";
    store_restore_review_request_available: boolean;
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
  store_key: RestorableCanonicalStateStoreKey | null;
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
  /** Digest of the HDS-J task lineage requested by L3. */
  restore_scope_task_digest?: string | null;
  readonly restore_scope_mode?: "plan_scoped_merge_v1" | "task_scoped_merge_v1";
  plan_restore_points: readonly RecoveryPlanRestorePointObservation[] | null;
  task_memory_restore_points: readonly RecoveryTaskMemoryRestorePointObservation[] | null;
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
  readonly backup_task_identity_digest?: string | null;
  readonly backup_task_lineage_plan_scope_count?: number | null;
  readonly backup_plan_record_status: "matched" | "not_found" | "ambiguous" | "unverified";
  readonly backup_plan_integrity: "verified" | "residuals_present" | null;
  readonly backup_plan_record_count: number | null;
  readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
}

/** Digest-only task lineage membership and M dependency status at the selected backup. */
export interface RecoveryTaskMemoryRestorePointObservation {
  readonly task_identity_digest: string;
  readonly plan_id_digests: readonly string[];
  readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
}

export function correlateTaskMemoryRestorePoints(
  currentPlans: readonly { readonly plan_id_digest: string; readonly task_identity_digest?: string | null }[],
  inventory: RecoveryBackupOperationPlanInventory,
  dependencies: RecoveryBackupOperationPlanDependencyInventory,
): readonly RecoveryTaskMemoryRestorePointObservation[] | null {
  if ((inventory.status !== "verified" && inventory.status !== "residuals_present") ||
      inventory.omitted_plan_scope_count !== 0 || inventory.plan_scope_count === null ||
      inventory.plan_scopes.length !== inventory.plan_scope_count ||
      !["correlated", "residuals_present", "unobserved", "no_plan_scopes"].includes(dependencies.status) ||
      dependencies.omitted_plan_scope_count !== 0 || dependencies.plan_scope_count === null ||
      dependencies.plan_scopes.length !== dependencies.plan_scope_count ||
      currentPlans.some((plan) => !plan.task_identity_digest)) return null;

  const dependencyByPlan = new Map(dependencies.plan_scopes.map((scope) => [scope.plan_id_digest, scope]));
  const archivedByTask = new Map<string, typeof inventory.plan_scopes>();
  for (const plan of inventory.plan_scopes) {
    if (!plan.task_identity_digest) continue;
    archivedByTask.set(plan.task_identity_digest, [
      ...(archivedByTask.get(plan.task_identity_digest) ?? []), plan,
    ]);
  }
  const currentByTask = new Map<string, typeof currentPlans>();
  for (const plan of currentPlans) {
    const taskDigest = plan.task_identity_digest;
    if (!taskDigest) continue;
    currentByTask.set(taskDigest, [...(currentByTask.get(taskDigest) ?? []), plan]);
  }

  return [...currentByTask.entries()].map(([taskDigest, taskPlans]): RecoveryTaskMemoryRestorePointObservation => {
    const currentPlanIds = taskPlans.map((plan) => plan.plan_id_digest).sort();
    const archivedPlans = archivedByTask.get(taskDigest) ?? [];
    const archivedPlanIds = archivedPlans.map((plan) => plan.plan_id_digest).sort();
    let dependencyStatus: RecoveryTaskMemoryRestorePointObservation["dependency_status"] = "unobserved";
    if (currentPlanIds.length === archivedPlanIds.length &&
        currentPlanIds.every((planId, index) => planId === archivedPlanIds[index])) {
      const taskDependencies = archivedPlanIds.map((planId) => dependencyByPlan.get(planId));
      if (taskDependencies.some((scope) => !scope)) dependencyStatus = "unknown";
      else if (archivedPlans.some((plan) => plan.integrity !== "verified") ||
          taskDependencies.some((scope) => scope!.residual_dependencies.includes("memory"))) {
        dependencyStatus = "residuals_present";
      } else if (taskDependencies.some((scope) => scope!.unobserved_dependencies.includes("memory"))) {
        dependencyStatus = "unobserved";
      } else {
        dependencyStatus = "observed";
      }
    }
    return {
      task_identity_digest: taskDigest,
      plan_id_digests: currentPlanIds,
      dependency_status: dependencyStatus,
    };
  });
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
  readonly mode?: "after_restart" | "in_process_restore" | "startup_operation_plan_hold" | "startup_canonical_store_hold" |
    "startup_broker_restore_hold";
  readonly expected_command_id?: string;
}

export interface RecoveryStoreRestoreAttemptEvidence {
  readonly schema_version: 1;
  readonly store_key: RestorableCanonicalStateStoreKey;
  readonly backup_id_digest: string;
}

export interface RecoveryStoreRestoreHistoryEvidence {
  readonly schema_version: 1;
  readonly store_key: RestorableCanonicalStateStoreKey;
  readonly restored_store_state_digest: string;
  readonly restored_backup_id_digest?: string;
  readonly restore_scope_plan_digest?: string;
  readonly restore_scope_task_digest?: string;
  readonly restore_scope_mode?: "plan_scoped_merge_v1" | "task_scoped_merge_v1";
}

export interface RecoveryActionResult {
  schema_version: 1;
  surface: "recovery";
  action: RecoveryAction;
  status: "completed";
  backup_id?: string;
  backup_manifest_path?: string;
  restored_backup_id?: string;
  restored_store_key?: RestorableCanonicalStateStoreKey;
  restored_store_archive_digest?: string;
  restored_store_state_digest?: string;
  restore_scope_kind?: "operation_plan" | "task_identity";
  restore_scope_digest?: string;
  restore_scope_mode?: "plan_scoped_merge_v1" | "task_scoped_merge_v1";
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
  manifest_sha256: string | null;
  backup_action: "backup" | "pre_restore" | "pre_factory_reset" | null;
  backup_created_at: string | null;
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

export interface PreUpdateRecoveryBackupInspection {
  readonly inspection: RecoveryBackupInspection;
  readonly manifest_path_matches: boolean;
}

type RecoveryPlanTargetDisposition = "not_configured" | "preserve_current" | "overlapping_targets" |
  "not_captured" | "requires_domain_review" | "candidate_only" | "unverified_target";
type RecoveryPlanPathTargetStatus = "verified" | "not_present" | "unverified";

interface GoalPurposeReplayObservation {
  status: "matched" | "no_current_purpose" | "not_included" | "unverified";
  verified_purpose_count: number;
}

const GOAL_PURPOSE_STORES = ["goal_purpose_j_control", "goal_purpose_m_state"] as const;
type GoalPurposeStoreKey = typeof GOAL_PURPOSE_STORES[number];

export interface OfflineGoalPurposeRepairPlan {
  readonly backup_id: string;
  readonly manifest_sha256: string;
  readonly repair_sha256: string;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly stores: readonly { readonly store_key: GoalPurposeStoreKey;
    readonly target_state: "missing" | "different" | "matched" }[];
}

export interface OfflineRecoveryRestorePlan {
  surface: "offline_recovery_restore_plan";
  schema_version: 1;
  status: "planned" | "manifest_changed" | "target_changed" | "invalid";
  manifest_sha256: string | null;
  plan_sha256: string | null;
  target_state_sha256?: string;
  items: readonly { role: string; disposition: RecoveryPlanTargetDisposition; target_status?: RecoveryPlanPathTargetStatus }[];
  canonical_stores: readonly { store_key: CanonicalStateStoreKey; archive_status: CanonicalStateSnapshotEntryStatus | "not_included";
    disposition: "requires_store_reconciliation" | "preserve_current";
    target_status?: CanonicalStateStoreTargetInspection["status"] }[];
  goal_purpose_replay?: GoalPurposeReplayObservation;
  goal_purpose_repair?: Pick<OfflineGoalPurposeRepairPlan, "repair_sha256" | "stores">;
  offline_lease_verified: false;
  cross_store_atomic: false;
  used_for_authority: false;
  may_execute: false;
}

type RecoveryRestoreAdvisoryPlan = Omit<OfflineRecoveryRestorePlan, "status"> & {
  status: Exclude<OfflineRecoveryRestorePlan["status"], "target_changed">;
};

export interface RecoveryScopeApplicabilityRequest {
  readonly backup_id_digest: string;
  readonly scope_kind: "request_scope" | "operation_plan" | "task_identity";
  readonly scope_digest: string;
  readonly store_candidates: readonly RestorableCanonicalStateStoreKey[];
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
  readonly matched_plan_id_digests: readonly string[];
  /** HDS-J task lineage; correlation only, never authority. */
  readonly backup_task_identity_digest: string | null;
  readonly backup_task_lineage_plan_scope_count: number | null;
  readonly backup_task_lineage_integrity: "verified" | "residuals_present" | "unverified" | "unknown";
  readonly backup_task_lineage_dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  readonly store_candidate_count: number | null;
  readonly verified_store_candidate_count: number | null;
  readonly dependency_scope_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly store_candidates: readonly {
    readonly store_key: RestorableCanonicalStateStoreKey;
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
    readonly task_identity_digest: string | null;
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
  expected_archive_sha256?: string;
  scope_kind?: "operation_plan" | "task_identity";
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

type FactoryResetVerification = NonNullable<RuntimeRecoveryFenceEvidence["verification"]>;

export interface FactoryResetRecoveryFence {
  begin(backupId: string, manifestSha256: string, verification: FactoryResetVerification): void;
  finish(backupId: string, manifestSha256: string, verification: FactoryResetVerification): void;
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
  const failureMemoryEnvKey = env.BLUE_TANUKI_FAILURE_MEMORY_FILE?.trim()
    ? "BLUE_TANUKI_FAILURE_MEMORY_FILE"
    : env.BLUE_TANUKI_FAILURE_MEMORY_DIR?.trim()
      ? "BLUE_TANUKI_FAILURE_MEMORY_DIR"
      : "BLUE_TANUKI_SESSION_DIR";
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
      env_key: failureMemoryEnvKey,
      source_path: resolveFailureMemoryFilePath(env),
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
      source_path: resolveRuntimeSchedulesDirectory(env),
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
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
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
  const failureMemoryFile = resolveFailureMemoryFilePath(env);
  const roots = [
    env.BLUE_TANUKI_FILE_ROOT,
    env.BLUE_TANUKI_ENV_FILE ? path.dirname(env.BLUE_TANUKI_ENV_FILE) : undefined,
    env.BLUE_TANUKI_AUDIT_DIR,
    env.BLUE_TANUKI_SESSION_DIR,
    env.BLUE_TANUKI_MEMORY_DIR,
    env.BLUE_TANUKI_MEMORY_FILE ? path.dirname(env.BLUE_TANUKI_MEMORY_FILE) : undefined,
    env.BLUE_TANUKI_FAILURE_MEMORY_DIR,
    env.BLUE_TANUKI_FAILURE_MEMORY_FILE ? path.dirname(env.BLUE_TANUKI_FAILURE_MEMORY_FILE) : undefined,
    failureMemoryFile ? path.dirname(failureMemoryFile) : undefined,
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

async function sha256Path(
  itemPath: string,
  kind: RecoveryPathKind,
  format: "backup" | "state" | "plan" = "backup",
): Promise<{ sha256: string; bytes: number; structured_sha256?: string }> {
  if (kind === "file") return sha256File(itemPath);
  if (kind !== "directory") return { sha256: "", bytes: 0 };

  const hash = createHash("sha256");
  // Bind the plan to the same directory traversal that checked the legacy manifest digest.
  const structured = format === "plan" ? createHash("sha256") : undefined;
  const archiveFormat = format !== "state";
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => archiveFormat ? a.name.localeCompare(b.name)
      : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of sorted) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(itemPath, fullPath);
      if (entry.isDirectory()) {
        const record = JSON.stringify(["directory", rel]) + "\n";
        hash.update(archiveFormat ? `dir:${rel}\n` : record);
        structured?.update(record);
        await walk(fullPath);
      } else if (entry.isFile()) {
        const file = await sha256File(fullPath);
        const record = JSON.stringify(["file", rel, file.sha256, file.bytes]) + "\n";
        hash.update(archiveFormat ? `file:${rel}:${file.sha256}:${file.bytes}\n` : record);
        structured?.update(record);
        bytes += file.bytes;
      } else if (format !== "backup") {
        throw new Error("factory_reset_target_unverified");
      }
    }
  };
  await walk(itemPath);
  return { sha256: hash.digest("hex"), bytes, ...(structured ? { structured_sha256: structured.digest("hex") } : {}) };
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

async function readManifest(
  env: NodeJS.ProcessEnv,
  backupIdValue: string,
): Promise<RecoveryBackupManifest & { manifest_sha256: string }> {
  assertBackupId(backupIdValue);
  const root = (await runtimeSafeTarget(env, recoveryRoot(env), "recovery_root", {
    allow_under_recovery_root: true,
  })).path;
  const manifestPath = await assertArchivePath(root, path.join(root, backupIdValue, "manifest.json"), "manifest");
  const rel = path.relative(root, manifestPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("invalid_backup_id");
  }
  const raw = await fs.readFile(manifestPath);
  const digest = createHash("sha256").update(raw).digest("hex");
  const sidecar = await fs.readFile(`${manifestPath}.sha256`, "utf8").catch(() => "");
  const expectedDigest = sidecar.trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest) || expectedDigest.toLowerCase() !== digest) {
    throw new Error("invalid_backup_manifest_digest");
  }
  const parsed = JSON.parse(raw.toString("utf8")) as RecoveryBackupManifest;
  if (parsed.schema_version !== 1 || parsed.surface !== "recovery" || parsed.backup_id !== backupIdValue) {
    throw new Error("invalid_backup_manifest");
  }
  if (typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at))) {
    throw new Error("invalid_backup_manifest_created_at");
  }
  if (trimTrailingSeparators(parsed.recovery_root) !== root) {
    throw new Error("invalid_backup_manifest_recovery_root");
  }
  return {
    ...parsed,
    recovery_root: root,
    manifest_path: manifestPath,
    manifest_sha256: digest,
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

async function assertArchiveTreeHasNoSymlinks(
  archivePath: string, kind: "file" | "directory", rejectHardLinks = false,
): Promise<void> {
  const rootStat = await fs.lstat(archivePath);
  if (rootStat.isSymbolicLink()) throw new Error("invalid_backup_manifest_archive_symlink");
  if (kind === "file") {
    if (!rootStat.isFile() || (rejectHardLinks && rootStat.nlink !== 1)) throw new Error("invalid_backup_manifest_archive_kind");
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
      else if (rejectHardLinks) {
        const stat = await fs.lstat(child);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("invalid_backup_manifest_archive_kind");
      }
    }
  };
  await walk(archivePath);
}

async function preflightRestoreManifest(
  env: NodeJS.ProcessEnv,
  manifest: RecoveryBackupManifest,
  planArchiveProofs?: Map<string, NonNullable<RecoveryPathProof>>,
): Promise<void> {
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
    if (planArchiveProofs && (archive !== archivePath(packDir, spec, item.kind) ||
        await recoveryPathKind(archive) !== item.kind)) {
      throw new Error("invalid_backup_manifest_archive_path");
    }
    await assertArchiveTreeHasNoSymlinks(archive, item.kind);
    const digest = await sha256Path(archive, item.kind, planArchiveProofs ? "plan" : "backup");
    if (digest.sha256 !== item.sha256 || digest.bytes !== item.bytes) {
      throw new Error(`invalid_backup_manifest_archive_digest:${item.key}`);
    }
    planArchiveProofs?.set(pair, { kind: item.kind, bytes: digest.bytes, sha256: digest.structured_sha256 ?? digest.sha256 });
  }

  if (seen.size !== expectedByPair.size) throw new Error("invalid_backup_manifest_items");
}

function assertRecoveryManifestBoundary(manifest: RecoveryBackupManifest): void {
  if (manifest.action !== "backup" && manifest.action !== "pre_restore" && manifest.action !== "pre_factory_reset") {
    throw new Error("invalid_backup_manifest_action");
  }
  if (manifest.secret_material !== true || manifest.used_for_authority !== false ||
      manifest.hds_brain_remains_authority !== true ||
      JSON.stringify(manifest.authority_boundary) !== JSON.stringify(AUTHORITY_BOUNDARY) ||
      JSON.stringify(manifest.evidence_source) !== JSON.stringify(["CONFIG", "LIVE_RUNTIME", "EXTERNAL_EVIDENCE"])) {
    throw new Error("invalid_backup_manifest_boundary");
  }
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
    task_identity_digest: plan.task_identity_digest ?? null,
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
const RECOVERY_SCOPE_DEPENDENCIES: Readonly<Record<RestorableCanonicalStateStoreKey, readonly RecoveryPlanDependencyCategory[]>> = {
  j_control: [],
  m_state: ["memory"],
  broker: ["broker", "delivery"],
  operation_plans: ["operation_plan"],
  cron_events: ["cron_approval"],
  meaning_update_j_control: ["memory"],
  meaning_update_m_state: ["memory"],
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
    manifest_sha256: null,
    backup_action: null,
    backup_created_at: null,
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
        backup_action: null,
        backup_created_at: null,
        coverage: "unknown",
        configured_required_item_count: null,
        copied_required_item_count: null,
        missing_required_item_count: null,
      };
    }
    const manifest = await readManifest(env, backupId);
    assertRecoveryManifestBoundary(manifest);
    await preflightRestoreManifest(env, manifest);
    const canonicalState = manifest.canonical_state_snapshot
      ? await inspectCanonicalStateSnapshots(path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot)
      : null;
    const canonicalEntries = new Map(manifest.canonical_state_snapshot?.entries.map((entry) => [entry.store_key, entry]));
    const canonicalStateStores = CANONICAL_STATE_STORE_PATHS.flatMap(({ key }) => {
      const entry = canonicalEntries.get(key);
      return entry ? [{ store_key: key, status: entry.status }] : [];
    });
    const operationPlanArchiveInventory = await inspectBackupOperationPlanInventory(
      path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot,
    );
    const operationPlanArchiveDependencies = await inspectBackupOperationPlanDependencies(
      path.dirname(manifest.manifest_path), manifest.canonical_state_snapshot,
    );
    const configuredRequiredItems = sourceSpecs(env).filter((item) => item.backup_required && item.source_path);
    const copiedRequiredItems = manifest.items.filter((item) => item.backup_required && item.copied);
    const missingRequiredItemCount = configuredRequiredItems.length - copiedRequiredItems.length;
    return {
      ...base,
      status: "verified",
      backup_id_digest: createHash("sha256").update(backupId).digest("hex"),
      manifest_sha256: manifest.manifest_sha256,
      backup_action: manifest.action,
      backup_created_at: manifest.created_at,
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
      backup_action: null,
      backup_created_at: null,
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

/** Verify only the explicitly selected pack against the current configured targets. */
export async function inspectRecoveryBackupById(
  env: NodeJS.ProcessEnv,
  backupId: string,
): Promise<RecoveryBackupInspection> {
  return inspectRecoveryBackup(env, async () => {
    assertBackupId(backupId);
    return backupIdForDigest(env, createHash("sha256").update(backupId).digest("hex"));
  });
}

function readGoalPurposeReplayContext(env: NodeJS.ProcessEnv) {
  if (!env.BLUE_TANUKI_AUDIT_DIR) throw new Error("offline_goal_purpose_audit_unavailable");
  const filepath = path.resolve(env.BLUE_TANUKI_AUDIT_DIR, AUDIT_FILENAME);
  const audit = new AuditLog({ filepath, read_only: true });
  const config = goalGovernanceConfigFromEnvironment(env, { read_only: true });
  const entries = audit.list();
  const markers = entries.filter(({ log }) => "kind" in log && log.kind === "authority_event" &&
    (log.event === "goal_purpose_adoption_committed" || log.event === "goal_purpose_change_committed"));
  // Commit hashes already bind their approval evidence in the verified chain prefix. Later unrelated appends
  // must leave a reviewed repair usable, including the append that records its own approval.
  const purpose_binding = recoveryDigest(["offline-goal-purpose-current.v1", filepath, config ?? null,
    markers.map(({ entry_hash }) => entry_hash)]);
  return { audit, config, purpose_binding, tail: entries.at(-1)?.entry_hash ?? null };
}

type GoalPurposeReplayContext = ReturnType<typeof readGoalPurposeReplayContext>;

export function hasOfflineGoalPurposeRepairAuditReceipt(env: NodeJS.ProcessEnv,
  binding: { readonly command_digest: string; readonly repair_sha256: string }): boolean {
  if (!/^[a-f0-9]{64}$/.test(binding.command_digest) || !/^[a-f0-9]{64}$/.test(binding.repair_sha256)) return false;
  try {
    const entries = readGoalPurposeReplayContext(env).audit.list();
    const authorizations = entries.filter(({ log }) => "kind" in log && log.kind === "authority_event" &&
      log.event === "offline_goal_purpose_repair_authorized" &&
      log.offline_goal_purpose_repair_review?.command_digest === binding.command_digest &&
      log.offline_goal_purpose_repair_review.repair_sha256 === binding.repair_sha256);
    if (authorizations.length !== 1) return false;
    const authorization = authorizations[0]!;
    if (entries.some(({ index, log }) => index > authorization.index && "kind" in log &&
        log.kind === "authority_event" && log.event === "emergency_stop_activated")) return false;
    const log = authorization.log;
    const actor = "webchat-resume-token-holder";
    if (!("kind" in log) || log.kind !== "authority_event" || log.actor !== actor || log.operation !== "recovery.restore" ||
        !log.request_id || !log.command_id || !log.offline_goal_purpose_repair_review ||
        !/^[a-f0-9]{64}$/.test(log.offline_goal_purpose_repair_review.review_digest)) return false;
    const reviewDigest = log.offline_goal_purpose_repair_review.review_digest;
    const reviews = entries.filter(({ log: entry }) => "kind" in entry && entry.kind === "authority_event" &&
      entry.event === "offline_goal_purpose_repair_content_reviewed" && entry.request_id === log.request_id &&
      entry.command_id === log.command_id);
    if (reviews.length !== 1 || reviews[0]!.index >= authorization.index) return false;
    const review = reviews[0]!;
    const evidence = review.log;
    if (!("kind" in evidence) || evidence.kind !== "authority_event" || evidence.actor !== actor ||
        evidence.operation !== "recovery.restore" || evidence.offline_goal_purpose_repair_review?.review_digest !== reviewDigest ||
        evidence.offline_goal_purpose_repair_review.command_digest !== binding.command_digest ||
        evidence.offline_goal_purpose_repair_review.repair_sha256 !== binding.repair_sha256) return false;
    const approvals = entries.filter(({ index, log: entry }) => index > review.index && "kind" in entry &&
      entry.kind === "command_lifecycle" && entry.request_id === log.request_id && entry.command_id === log.command_id &&
      ["approval_approved", "approval_rejected", "approval_cancelled"].includes(entry.phase));
    if (approvals.length !== 1 || approvals[0]!.index >= authorization.index) return false;
    const approval = approvals[0]!.log;
    return "kind" in approval && approval.kind === "command_lifecycle" && approval.phase === "approval_approved" &&
      approval.actor === actor && approval.reason === "human_approval:approve";
  } catch {
    return false;
  }
}

function inspectGoalPurposePair(context: GoalPurposeReplayContext, paths: readonly [string, string]) {
  return inspectGoalPurposeRecovery({ audit: context.audit, goal_governance: context.config,
    j_database_path: paths[0], m_database_path: paths[1] });
}

function recoveryDigest(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

type GoalPurposeFileProof = { bytes: number; sha256: string };
type GoalPurposeArchiveFile = { filepath: string; proof: GoalPurposeFileProof };
type GoalPurposeArchive = {
  files: readonly [GoalPurposeArchiveFile, GoalPurposeArchiveFile];
  context: GoalPurposeReplayContext;
};

/** Compare the archived pair to the preserved, current installation's audit and configuration. */
async function observeArchivedGoalPurpose(
  env: NodeJS.ProcessEnv,
  packDir: string,
  snapshot: CanonicalStateSnapshotManifest | undefined,
): Promise<{ observation: GoalPurposeReplayObservation; binding: string | null; archive?: GoalPurposeArchive }> {
  const j = snapshot?.entries.find(({ store_key }) => store_key === "goal_purpose_j_control");
  const m = snapshot?.entries.find(({ store_key }) => store_key === "goal_purpose_m_state");
  if (!j && !m) return { observation: { status: "not_included", verified_purpose_count: 0 }, binding: null };
  const unverified = { observation: { status: "unverified", verified_purpose_count: 0 }, binding: null } as const;
  if (j?.status !== "verified" || !j.archive_rel_path || !j.sha256 ||
      m?.status !== "verified" || !m.archive_rel_path || !m.sha256) return unverified;
  try {
    const context = readGoalPurposeReplayContext(env);
    const jPath = await assertArchivePath(packDir, path.join(packDir, j.archive_rel_path), "goal_purpose_replay_j");
    const mPath = await assertArchivePath(packDir, path.join(packDir, m.archive_rel_path), "goal_purpose_replay_m");
    const files = [
      { filepath: jPath, proof: { bytes: j.bytes, sha256: j.sha256 } },
      { filepath: mPath, proof: { bytes: m.bytes, sha256: m.sha256 } },
    ] as const;
    for (const file of files) await assertGoalPurposeFileProof(file.filepath, file.proof);
    const observation = inspectGoalPurposePair(context, [jPath, mPath]);
    if (observation.status === "unverified") return unverified;
    for (const file of files) await assertGoalPurposeFileProof(file.filepath, file.proof);
    const after = readGoalPurposeReplayContext(env);
    if (after.tail !== context.tail || after.purpose_binding !== context.purpose_binding) return unverified;
    const binding = recoveryDigest(["offline-goal-purpose-replay.v2", context.tail, context.purpose_binding,
      j.sha256, m.sha256, observation]);
    return { observation, binding, ...(observation.status === "matched" && { archive: { files, context } }) };
  } catch {
    return unverified;
  }
}

type GoalPurposeRepairSelector = Pick<OfflineGoalPurposeRepairPlan, "backup_id" | "manifest_sha256">;
type GoalPurposeTarget = { filepath: string; proof: GoalPurposeFileProof | null };

function sameGoalPurposeProof(left: GoalPurposeFileProof | null, right: GoalPurposeFileProof | null): boolean {
  return left === null || right === null ? left === right : left.bytes === right.bytes && left.sha256 === right.sha256;
}

async function readGoalPurposeFileProof(filepath: string): Promise<GoalPurposeFileProof | null> {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (await recoveryPathKind(filepath + suffix)) throw new Error("offline_goal_purpose_target_busy");
  }
  const kind = await recoveryPathKind(filepath);
  if (!kind) return null;
  if (kind !== "file") throw new Error("offline_goal_purpose_path_unverified");
  const handle = await fs.open(filepath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("offline_goal_purpose_path_unverified");
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead === header.length && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) &&
        (header[18] === 2 || header[19] === 2)) throw new Error("offline_goal_purpose_target_busy");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await fs.lstat(filepath);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        before.size !== bytes || after.size !== bytes || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) throw new Error("offline_goal_purpose_file_changed");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function assertGoalPurposeFileProof(filepath: string, expected: GoalPurposeFileProof | null): Promise<void> {
  if (!sameGoalPurposeProof(await readGoalPurposeFileProof(filepath), expected)) {
    throw new Error("offline_goal_purpose_file_changed");
  }
}

async function realPathFromExistingAncestor(filepath: string): Promise<string> {
  try {
    return await fs.realpath(filepath);
  } catch (error) {
    const parent = path.dirname(filepath);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === filepath) throw error;
    if (await fs.lstat(filepath).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") return null;
      throw failure;
    })) throw new Error("offline_goal_purpose_path_unverified");
    return path.join(await realPathFromExistingAncestor(parent), path.basename(filepath));
  }
}

async function assertGoalPurposeTargetsIsolated(env: NodeJS.ProcessEnv, directory: string): Promise<void> {
  const protectedPaths = [recoveryRoot(env), env.BLUE_TANUKI_COMPLETE_HISTORY_FILE, env.BLUE_TANUKI_INSTALL_ROOT,
    ...sourceSpecs(env).map(({ source_path }) => source_path)];
  for (const candidate of protectedPaths) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    for (const location of [resolved, await realPathFromExistingAncestor(resolved)]) {
      if (isSameOrInside(location, directory) || isSameOrInside(directory, location)) {
        throw new Error("offline_goal_purpose_protected_path_overlap");
      }
    }
  }
  if (env.BLUE_TANUKI_FILE_ROOT) {
    const fileRoot = await realPathFromExistingAncestor(path.resolve(env.BLUE_TANUKI_FILE_ROOT));
    // File tools already exclude private-state below a larger workspace root.
    if (isSameOrInside(fileRoot, directory)) throw new Error("offline_goal_purpose_protected_path_overlap");
  }
}

function goalPurposeStateSha256(selector: GoalPurposeRepairSelector, context: GoalPurposeReplayContext,
  pair: readonly [GoalPurposeTarget, GoalPurposeTarget]): string {
  return recoveryDigest(["offline-goal-purpose-state.v1", selector.backup_id, selector.manifest_sha256,
    context.purpose_binding, pair.map(({ filepath, proof }, index) => [GOAL_PURPOSE_STORES[index], filepath, proof])]);
}

async function readOfflineGoalPurposeRepairState(env: NodeJS.ProcessEnv, selector: GoalPurposeRepairSelector,
  archive: GoalPurposeArchive) {
  const stateRoot = path.resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
  const j = resolveCanonicalStateStoreInspectionPath(stateRoot, GOAL_PURPOSE_STORES[0]);
  const m = resolveCanonicalStateStoreInspectionPath(stateRoot, GOAL_PURPOSE_STORES[1]);
  const directory = path.dirname(j);
  if (path.dirname(m) !== directory || path.relative(path.join(stateRoot, "private-state", "goal-purpose-memory"), directory)) {
    throw new Error("offline_goal_purpose_path_unverified");
  }
  await assertGoalPurposeTargetsIsolated(env, directory);
  const before = [{ filepath: j, proof: await readGoalPurposeFileProof(j) },
    { filepath: m, proof: await readGoalPurposeFileProof(m) }] as const;
  const after = [{ filepath: j, proof: archive.files[0].proof }, { filepath: m, proof: archive.files[1].proof }] as const;
  const context = readGoalPurposeReplayContext(env);
  if (context.purpose_binding !== archive.context.purpose_binding) throw new Error("offline_goal_purpose_context_changed");
  const before_sha256 = goalPurposeStateSha256(selector, context, before);
  const after_sha256 = goalPurposeStateSha256(selector, context, after);
  const plan: OfflineGoalPurposeRepairPlan = {
    backup_id: selector.backup_id, manifest_sha256: selector.manifest_sha256, before_sha256, after_sha256,
    repair_sha256: recoveryDigest(["offline-goal-purpose-repair.v1", before_sha256, after_sha256]),
    stores: before.map(({ proof }, index) => ({ store_key: GOAL_PURPOSE_STORES[index]!,
      target_state: !proof ? "missing" : sameGoalPurposeProof(proof, after[index]!.proof) ? "matched" : "different" })),
  };
  return { plan, directory, before, after, archive };
}

type GoalPurposeRepairState = Awaited<ReturnType<typeof readOfflineGoalPurposeRepairState>>;

async function loadOfflineGoalPurposeRepairState(env: NodeJS.ProcessEnv, selector: GoalPurposeRepairSelector) {
  assertBackupId(selector.backup_id);
  if (!/^[a-f0-9]{64}$/.test(selector.manifest_sha256)) return null;
  const manifestPath = path.join(recoveryRoot(env), selector.backup_id, "manifest.json");
  if (await recoveryPathKind(manifestPath) !== "file" || await recoveryPathKind(`${manifestPath}.sha256`) !== "file") return null;
  const manifest = await readManifest(env, selector.backup_id);
  if (manifest.manifest_sha256 !== selector.manifest_sha256 || !manifest.canonical_state_snapshot) return null;
  assertRecoveryManifestBoundary(manifest);
  await preflightRestoreManifest(env, manifest);
  const packDir = path.dirname(manifest.manifest_path);
  await inspectCanonicalStateSnapshots(packDir, manifest.canonical_state_snapshot);
  const { archive } = await observeArchivedGoalPurpose(env, packDir, manifest.canonical_state_snapshot);
  if (!archive || (await readManifest(env, selector.backup_id)).manifest_sha256 !== selector.manifest_sha256) return null;
  return await readOfflineGoalPurposeRepairState(env, selector, archive);
}

async function isGoalPurposeRepairCandidate(env: NodeJS.ProcessEnv, state: GoalPurposeRepairState): Promise<boolean> {
  if (state.plan.before_sha256 === state.plan.after_sha256) return false;
  const stateRoot = env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki";
  const [j, m] = state.before;
  for (const [index, target] of state.before.entries()) {
    if (!target.proof || sameGoalPurposeProof(target.proof, state.after[index]!.proof)) continue;
    const current = await inspectCanonicalStateStoreTarget(stateRoot, GOAL_PURPOSE_STORES[index]!);
    if (current.status === "verified") {
      const other = state.archive.files;
      const pair = index === 0 ? [j.filepath, other[1].filepath] as const : [other[0].filepath, m.filepath] as const;
      // Refuse to discard a structurally readable store containing unreconciled or extra records.
      if (inspectGoalPurposePair(state.archive.context, pair).status !== "matched") return false;
    } else if (current.status !== "mismatch") return false;
    await assertGoalPurposeFileProof(target.filepath, target.proof);
  }
  return readGoalPurposeReplayContext(env).purpose_binding === state.archive.context.purpose_binding;
}

export async function planOfflineGoalPurposeRepair(env: NodeJS.ProcessEnv, selector: GoalPurposeRepairSelector):
  Promise<OfflineGoalPurposeRepairPlan | null> {
  try {
    const state = await loadOfflineGoalPurposeRepairState(env, selector);
    return state && await isGoalPurposeRepairCandidate(env, state) ? state.plan : null;
  } catch {
    return null;
  }
}

export async function observeOfflineGoalPurposeRepair(env: NodeJS.ProcessEnv,
  evidence: GoalPurposeRepairSelector): Promise<string | null> {
  try {
    const state = await loadOfflineGoalPurposeRepairState(env, evidence);
    if (!state) return null;
    if (state.plan.before_sha256 === state.plan.after_sha256 && inspectGoalPurposePair(state.archive.context,
      [state.before[0].filepath, state.before[1].filepath]).status !== "matched") return null;
    for (const target of state.before) await assertGoalPurposeFileProof(target.filepath, target.proof);
    return readGoalPurposeReplayContext(env).purpose_binding === state.archive.context.purpose_binding
      ? state.plan.before_sha256 : null;
  } catch {
    return null;
  }
}

async function syncGoalPurposePath(filepath: string, directory = false): Promise<void> {
  // Node cannot open Windows directories for fsync. The runtime fence remains pending until readback.
  if (directory && process.platform === "win32") return;
  const handle = await fs.open(filepath, directory ? "r" : "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyGoalPurposeRepairFile(source: string, destination: string, proof: GoalPurposeFileProof): Promise<void> {
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  await syncGoalPurposePath(destination);
  await assertGoalPurposeFileProof(destination, proof);
}

/** Called only with the installation lease held and a durable prepared fence for this exact plan. */
export async function applyOfflineGoalPurposeRepair(env: NodeJS.ProcessEnv, plan: OfflineGoalPurposeRepairPlan): Promise<void> {
  const state = await loadOfflineGoalPurposeRepairState(env, plan);
  if (!state || state.plan.repair_sha256 !== plan.repair_sha256 || state.plan.before_sha256 !== plan.before_sha256 ||
      state.plan.after_sha256 !== plan.after_sha256 || !await isGoalPurposeRepairCandidate(env, state)) {
    throw new Error("offline_goal_purpose_plan_changed");
  }
  const directoryKind = await recoveryPathKind(state.directory);
  if (directoryKind === null) {
    await fs.mkdir(state.directory, { mode: 0o700 });
    await syncGoalPurposePath(path.dirname(state.directory), true);
  } else if (directoryKind !== "directory") throw new Error("offline_goal_purpose_path_unverified");

  const preserveDirectory = await fs.mkdtemp(path.join(state.directory, ".offline-goal-repair-"));
  if (process.platform !== "win32") await fs.chmod(preserveDirectory, 0o700);
  const staged = [path.join(preserveDirectory, "new-j-control.sqlite"), path.join(preserveDirectory, "new-m-state.sqlite")] as const;
  try {
    const preserved = [];
    for (const [index, target] of state.before.entries()) {
      const file = state.archive.files[index]!;
      await copyGoalPurposeRepairFile(file.filepath, staged[index]!, file.proof);
      const name = `before-${path.basename(target.filepath)}`;
      if (target.proof) await copyGoalPurposeRepairFile(target.filepath, path.join(preserveDirectory, name), target.proof);
      preserved.push({ store_key: GOAL_PURPOSE_STORES[index], file: target.proof ? name : null, proof: target.proof });
    }
    const evidence = await fs.open(path.join(preserveDirectory, "before-state.json"), "wx", 0o600);
    try {
      await evidence.writeFile(JSON.stringify({ schema_version: 1, ...state.plan, preserved }) + "\n", "utf8");
      await evidence.sync();
    } finally {
      await evidence.close();
    }
    await syncGoalPurposePath(preserveDirectory, true);
    await syncGoalPurposePath(state.directory, true);

    const current = await readOfflineGoalPurposeRepairState(env, plan, state.archive);
    if (current.plan.repair_sha256 !== plan.repair_sha256 ||
        (await readManifest(env, plan.backup_id)).manifest_sha256 !== plan.manifest_sha256 ||
        inspectGoalPurposePair(state.archive.context, staged).status !== "matched") {
      throw new Error("offline_goal_purpose_plan_changed");
    }
    for (const [index, target] of state.before.entries()) {
      if (sameGoalPurposeProof(target.proof, state.after[index]!.proof)) continue;
      for (const [position, member] of state.before.entries()) {
        await assertGoalPurposeFileProof(member.filepath, position < index ? state.after[position]!.proof : member.proof);
      }
      await assertGoalPurposeFileProof(staged[index]!, state.after[index]!.proof);
      await fs.rename(staged[index]!, target.filepath);
      await syncGoalPurposePath(target.filepath);
      await syncGoalPurposePath(state.directory, true);
      await syncGoalPurposePath(preserveDirectory, true);
    }
    if (await observeOfflineGoalPurposeRepair(env, plan) !== plan.after_sha256) {
      throw new Error("offline_goal_purpose_postcondition_unverified");
    }
  } finally {
    for (const file of staged) {
      await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

/** Plan against one exact pack. The installed CLI also requires the caller's previously observed manifest digest. */
export function planOfflineRecoveryRestore(
  env: NodeJS.ProcessEnv, backupId: string, expectedManifestSha256?: string,
): Promise<RecoveryRestoreAdvisoryPlan>;
export function planOfflineRecoveryRestore(
  env: NodeJS.ProcessEnv, backupId: string, expectedManifestSha256: string | undefined,
  options?: { readonly offline_owner_scope_sha256: string },
): Promise<OfflineRecoveryRestorePlan>;
export async function planOfflineRecoveryRestore(
  env: NodeJS.ProcessEnv,
  backupId: string,
  expectedManifestSha256?: string,
  options?: { readonly offline_owner_scope_sha256: string },
): Promise<OfflineRecoveryRestorePlan> {
  const base = {
    surface: "offline_recovery_restore_plan",
    schema_version: 1,
    status: "invalid",
    manifest_sha256: null,
    plan_sha256: null,
    items: [],
    canonical_stores: [],
    offline_lease_verified: false,
    cross_store_atomic: false,
    used_for_authority: false,
    may_execute: false,
  } as const;
  try {
    assertBackupId(backupId);
    if ((expectedManifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) ||
        (options && !/^[a-f0-9]{64}$/.test(options.offline_owner_scope_sha256))) return base;
    const manifestPath = path.join(recoveryRoot(env), backupId, "manifest.json");
    if (await recoveryPathKind(manifestPath) !== "file" ||
        await recoveryPathKind(`${manifestPath}.sha256`) !== "file") return base;
    const manifest = await readManifest(env, backupId);
    const manifestSha256 = manifest.manifest_sha256;
    if (expectedManifestSha256 !== undefined && expectedManifestSha256 !== manifestSha256) {
      return { ...base, status: "manifest_changed" };
    }
    assertRecoveryManifestBoundary(manifest);
    const archiveProofs = new Map<string, NonNullable<RecoveryPathProof>>();
    await preflightRestoreManifest(env, manifest, archiveProofs);
    const packDir = path.dirname(manifest.manifest_path);
    if (manifest.canonical_state_snapshot) {
      await inspectCanonicalStateSnapshots(packDir, manifest.canonical_state_snapshot);
    }

    const stateRoot = env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki";
    const privateRoot = path.resolve(stateRoot, "private-state");
    const specs = sourceSpecs(env);
    const currentTargets = configuredRuntimeTargets(env);
    const protectedRoles = new Set(["env_file", "audit_dir", "log_dir", "approval_grants_file"]);
    const protectedPaths = [
      recoveryRoot(env), env.BLUE_TANUKI_COMPLETE_HISTORY_FILE, env.BLUE_TANUKI_FILE_ROOT, env.BLUE_TANUKI_INSTALL_ROOT,
      path.join(privateRoot, "gateway-runtime"),
      ...CANONICAL_STATE_STORE_PATHS.map(({ relative_path }) => path.join(privateRoot, relative_path)),
      ...specs.filter(({ key }) => protectedRoles.has(key)).map(({ source_path }) => source_path),
    ].filter((value): value is string => Boolean(value)).map(trimTrailingSeparators);
    const overlaps = (left: string, right: string): boolean =>
      isSameOrInside(left, right) || isSameOrInside(right, left);

    const roles = specs.map((spec) => {
      const identity = `${spec.key}:${spec.env_key}`;
      const target = currentTargets.get(identity);
      const archiveProof = archiveProofs.get(identity) ?? null;
      const protectedTarget = protectedRoles.has(spec.key) || !!target && protectedPaths.some(protectedPath => overlaps(target, protectedPath));
      const overlappingTarget = !!target && [...currentTargets].some(([other, otherTarget]) => other !== identity && overlaps(target, otherTarget));
      return { spec, identity, target, archiveProof, protectedTarget, overlappingTarget };
    });
    const observeRole = async ({ spec, identity, target, archiveProof, protectedTarget, overlappingTarget }: typeof roles[number]) => {
      let disposition: RecoveryPlanTargetDisposition;
      let observedTarget: RecoveryPathProof = null;
      let targetStatus: RecoveryPlanPathTargetStatus | undefined;
      if (!target) disposition = "not_configured";
      else if (protectedTarget) disposition = "preserve_current";
      else if (!archiveProof) disposition = "not_captured";
      else if (overlappingTarget) disposition = "overlapping_targets";
      else disposition = "requires_domain_review";

      const offlineEligible = !!options && !protectedTarget && !overlappingTarget;
      const advisoryRead = disposition === "requires_domain_review" && spec.key !== "session_dir" && spec.key !== "schedules_dir";
      if (target && (offlineEligible || advisoryRead)) {
        const expectedKind = archiveProof?.kind ?? (spec.key.endsWith("_dir") ? "directory" : "file");
        try {
          if (offlineEligible) await runtimeSafeTarget(env, target, "restore_plan_target", { allow_exact: [target] });
          observedTarget = await readRecoveryPathProof(target, offlineEligible);
        } catch { targetStatus = "unverified"; }
        if (observedTarget && observedTarget.kind !== expectedKind) targetStatus = "unverified";
        if (targetStatus === "unverified" && archiveProof) disposition = "unverified_target";
        if (offlineEligible && targetStatus === undefined) targetStatus = observedTarget ? "verified" : "not_present";
      }
      const item = { role: spec.key, disposition, ...(options && targetStatus ? { target_status: targetStatus } : {}) };
      return {
        item,
        planBinding: [identity, target ?? null, disposition, archiveProof, observedTarget],
        targetBinding: [identity, target ?? null, disposition, protectedTarget, overlappingTarget, targetStatus ?? null, observedTarget],
        complete: targetStatus !== "unverified" && !(archiveProof && disposition === "overlapping_targets"),
      };
    };
    const observeRoles = async () => {
      const observations = [];
      for (const role of roles) observations.push(await observeRole(role));
      return observations;
    };
    const observeOfflineTargets = async () => ({
      roles: await observeRoles(),
      stores: await Promise.all(CANONICAL_STATE_STORE_PATHS.map(async ({ key }) =>
        [key, await inspectCanonicalStateStoreTarget(stateRoot, key)] as const)),
    });
    const offlineTargets = options ? await observeOfflineTargets() : undefined;
    const observedRoles = offlineTargets?.roles ?? await observeRoles();

    const canonical_stores = CANONICAL_STATE_STORE_PATHS.map(({ key }, index) => {
      const entry = manifest.canonical_state_snapshot?.entries.find(({ store_key }) => store_key === key);
      const target = offlineTargets?.stores[index]?.[1];
      return { store_key: key, archive_status: entry?.status ?? "not_included",
        disposition: entry?.status === "verified" ? "requires_store_reconciliation" : "preserve_current",
        ...(target ? { target_status: target.status } : {}) } as const;
    });
    const goalPurpose = await observeArchivedGoalPurpose(env, packDir, manifest.canonical_state_snapshot);
    let goalPurposeRepair: OfflineRecoveryRestorePlan["goal_purpose_repair"];
    if (goalPurpose.archive) {
      try {
        const state = await readOfflineGoalPurposeRepairState(env,
          { backup_id: backupId, manifest_sha256: manifestSha256 }, goalPurpose.archive);
        if (await isGoalPurposeRepairCandidate(env, state)) {
          goalPurposeRepair = { repair_sha256: state.plan.repair_sha256, stores: state.plan.stores };
        }
      } catch { /* Keep pack observations usable when the local pair is unavailable for repair. */ }
    }
    const latestManifest = await readManifest(env, backupId);
    if (latestManifest.manifest_sha256 !== manifestSha256) {
      return { ...base, status: "manifest_changed" };
    }
    const targetBinding = options && offlineTargets
      ? [options.offline_owner_scope_sha256, observedRoles.map(role => role.targetBinding), offlineTargets.stores] : undefined;
    let targetStateSha256: string | undefined;
    if (targetBinding && offlineTargets) {
      const repeatedArchiveProofs = new Map<string, NonNullable<RecoveryPathProof>>();
      await preflightRestoreManifest(env, latestManifest, repeatedArchiveProofs);
      if (latestManifest.canonical_state_snapshot) await inspectCanonicalStateSnapshots(packDir, latestManifest.canonical_state_snapshot);
      if (JSON.stringify([...repeatedArchiveProofs]) !== JSON.stringify([...archiveProofs])) return base;
      if (JSON.stringify(await observeOfflineTargets()) !== JSON.stringify(offlineTargets)) {
        return { ...base, status: "target_changed" };
      }
      if ((await readManifest(env, backupId)).manifest_sha256 !== manifestSha256) return { ...base, status: "manifest_changed" };
      if (observedRoles.every(role => role.complete) && offlineTargets.stores.every(([, target]) =>
        target.status === "verified" || target.status === "not_present")) {
        targetStateSha256 = recoveryDigest(["offline-recovery-target-state.v1", manifestSha256, privateRoot, targetBinding]);
      }
    }
    const planSha256 = recoveryDigest([
      targetBinding ? "offline-recovery-restore-plan.v4" : "offline-recovery-restore-plan.v3",
      manifestSha256, privateRoot, observedRoles.map(role => role.planBinding), canonical_stores,
      goalPurpose.observation, goalPurpose.binding, goalPurposeRepair ?? null,
      ...(targetBinding ? [targetBinding] : []),
    ]);
    return { ...base, status: "planned", manifest_sha256: manifestSha256, plan_sha256: planSha256,
      items: observedRoles.map(role => role.item), canonical_stores,
      ...(targetStateSha256 ? { target_state_sha256: targetStateSha256 } : {}),
      goal_purpose_replay: goalPurpose.observation, ...(goalPurposeRepair && { goal_purpose_repair: goalPurposeRepair }) };
  } catch {
    return base;
  }
}

/** Verify the exact recovery pack and manifest path recorded by an update rollback plan. */
export async function inspectPreUpdateRecoveryBackup(
  env: NodeJS.ProcessEnv,
  backupId: string,
  manifestPath: string,
): Promise<PreUpdateRecoveryBackupInspection> {
  let manifestPathMatches = false;
  try {
    assertBackupId(backupId);
    const root = (await runtimeSafeTarget(env, recoveryRoot(env), "recovery_root", {
      allow_under_recovery_root: true,
    })).path;
    const expectedManifestPath = path.join(root, backupId, "manifest.json");
    manifestPathMatches = path.isAbsolute(manifestPath) && path.resolve(manifestPath) === expectedManifestPath;
  } catch {
    manifestPathMatches = false;
  }

  const inspection = await inspectRecoveryBackupById(env, backupId);
  return { inspection, manifest_path_matches: manifestPathMatches };
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
    scope_kind: request.scope_kind === "request_scope" || request.scope_kind === "operation_plan" ||
      request.scope_kind === "task_identity" ? request.scope_kind : null,
    scope_digest: typeof request.scope_digest === "string" && RECOVERY_SCOPE_DIGEST.test(request.scope_digest)
      ? request.scope_digest.toLowerCase() : null,
    backup_id_digest: typeof request.backup_id_digest === "string" && RECOVERY_SCOPE_DIGEST.test(request.backup_id_digest)
      ? request.backup_id_digest.toLowerCase() : null,
    matched_plan_id_digest: null,
    matched_plan_scope_count: null,
    matched_plan_id_digests: [],
    backup_task_identity_digest: null,
    backup_task_lineage_plan_scope_count: null,
    backup_task_lineage_integrity: "unknown",
    backup_task_lineage_dependency_status: "unknown",
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
      (input.scope_kind !== "request_scope" && input.scope_kind !== "operation_plan" && input.scope_kind !== "task_identity") ||
      typeof input.scope_digest !== "string" || !RECOVERY_SCOPE_DIGEST.test(input.scope_digest) ||
      !Array.isArray(input.store_candidates) || input.store_candidates.length < 1 || input.store_candidates.length > 5) return null;
  if (!input.store_candidates.every(isRestorableCanonicalStateStore)) return null;
  const storeCandidates = input.store_candidates;
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
    : request.scope_kind === "task_identity"
      ? plan.task_identity_digest === request.scope_digest
      : plan.request_scope_digest === request.scope_digest);
  if (matchingPlans.length === 0) return emptyRecoveryScopeApplicability("scope_not_found", baseRequest);
  if ((request.scope_kind !== "task_identity" && matchingPlans.length !== 1) ||
      new Set(matchingPlans.map((plan) => plan.plan_id_digest)).size !== matchingPlans.length) {
    return {
      ...emptyRecoveryScopeApplicability("scope_ambiguous", baseRequest),
      matched_plan_scope_count: matchingPlans.length,
      matched_plan_id_digests: matchingPlans.map((plan) => plan.plan_id_digest).sort(),
    };
  }

  const matchedPlan = matchingPlans[0]!;
  const scopedPlans = request.scope_kind === "task_identity" ? matchingPlans : [matchedPlan];
  if (scopedPlans.some((plan) => plan.integrity !== "verified" || plan.plan_record_count !== 1)) {
    return emptyRecoveryScopeApplicability("dependency_unverified", baseRequest);
  }
  const scopedPlanIds = new Set(scopedPlans.map((plan) => plan.plan_id_digest));
  const matchingDependencyScopes = dependencies.plan_scopes.filter((scope) => scopedPlanIds.has(scope.plan_id_digest));
  if (matchingDependencyScopes.length !== scopedPlans.length ||
      new Set(matchingDependencyScopes.map((scope) => scope.plan_id_digest)).size !== scopedPlans.length) {
    return {
      ...emptyRecoveryScopeApplicability("dependency_unverified", baseRequest),
      matched_plan_id_digest: request.scope_kind === "task_identity" ? null : matchedPlan.plan_id_digest,
      matched_plan_scope_count: scopedPlans.length,
      matched_plan_id_digests: scopedPlans.map((plan) => plan.plan_id_digest).sort(),
    };
  }
  const dependencyScope = matchingDependencyScopes.find((scope) => scope.plan_id_digest === matchedPlan.plan_id_digest)!;
  const taskIdentityDigest = request.scope_kind === "task_identity"
    ? request.scope_digest
    : matchedPlan.task_identity_digest ?? null;
  const taskLineagePlans = taskIdentityDigest
    ? inventory.plan_scopes.filter((plan) => plan.task_identity_digest === taskIdentityDigest)
    : [];
  const taskLineagePlanIds = new Set(taskLineagePlans.map((plan) => plan.plan_id_digest));
  const taskLineageDependencies = dependencies.plan_scopes.filter((scope) => taskLineagePlanIds.has(scope.plan_id_digest));
  const taskLineageIntegrity = !taskIdentityDigest || taskLineagePlans.length === 0
    ? "unknown"
    : taskLineagePlans.some((plan) => plan.integrity !== "verified" || plan.plan_record_count !== 1)
      ? "residuals_present" : "verified";
  const taskLineageDependencyStatus = !taskIdentityDigest || taskLineagePlans.length === 0 ||
      taskLineageDependencies.length !== taskLineagePlans.length
    ? "unknown"
    : taskLineageDependencies.some((scope) => scope.status === "residuals_present")
      ? "residuals_present"
      : taskLineageDependencies.some((scope) => scope.status === "unobserved") ? "unobserved" : "observed";
  if (request.scope_kind === "task_identity" &&
      (taskLineagePlans.length !== scopedPlans.length || taskLineageIntegrity !== "verified" ||
        taskLineageDependencyStatus === "unknown")) {
    return {
      ...emptyRecoveryScopeApplicability("dependency_unverified", baseRequest),
      backup_task_identity_digest: taskIdentityDigest,
      backup_task_lineage_plan_scope_count: taskLineagePlans.length,
      backup_task_lineage_integrity: taskLineageIntegrity,
      backup_task_lineage_dependency_status: taskLineageDependencyStatus,
      matched_plan_scope_count: scopedPlans.length,
      matched_plan_id_digests: scopedPlans.map((plan) => plan.plan_id_digest).sort(),
    };
  }
  const snapshotStatuses = new Map(backup.canonical_state_stores.map((entry) => [entry.store_key, entry.status]));
  if (!RESTORABLE_CANONICAL_STATE_STORES.every(({ key }) => snapshotStatuses.has(key)) ||
      backup.canonical_state_cross_store_atomic !== false) {
    return emptyRecoveryScopeApplicability("store_unverified", baseRequest);
  }

  const scopeResidualDependencies = request.scope_kind === "task_identity"
    ? [...new Set(matchingDependencyScopes.flatMap((scope) => scope.residual_dependencies))]
    : dependencyScope.residual_dependencies;
  const scopeUnobservedDependencies = request.scope_kind === "task_identity"
    ? [...new Set(matchingDependencyScopes.flatMap((scope) => scope.unobserved_dependencies))]
    : dependencyScope.unobserved_dependencies;
  const storeCandidates = request.store_candidates.map((storeKey) => {
    const relatedDependencies = RECOVERY_SCOPE_DEPENDENCIES[storeKey];
    const snapshotStatus: CanonicalStateSnapshotEntryStatus | "unknown" = snapshotStatuses.get(storeKey) ?? "unknown";
    return {
      store_key: storeKey,
      snapshot_status: snapshotStatus,
      dependency_status: recoveryScopeDependencyStatus(
        relatedDependencies,
        scopeResidualDependencies,
        scopeUnobservedDependencies,
      ),
      related_dependencies: [...relatedDependencies],
    };
  });
  const verifiedStoreCandidateCount = storeCandidates.filter((item) => item.snapshot_status === "verified").length;
  const unverifiedDependency = request.scope_kind === "task_identity"
    ? storeCandidates.some((item) => item.dependency_status === "not_mapped" || item.dependency_status === "unknown")
    : storeCandidates.some((item) =>
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
    matched_plan_id_digest: request.scope_kind === "task_identity" ? null : matchedPlan.plan_id_digest,
    matched_plan_scope_count: scopedPlans.length,
    matched_plan_id_digests: scopedPlans.map((plan) => plan.plan_id_digest).sort(),
    backup_task_identity_digest: taskIdentityDigest,
    backup_task_lineage_plan_scope_count: taskIdentityDigest ? taskLineagePlans.length : null,
    backup_task_lineage_integrity: taskLineageIntegrity,
    backup_task_lineage_dependency_status: taskLineageDependencyStatus,
    store_candidate_count: storeCandidates.length,
    verified_store_candidate_count: verifiedStoreCandidateCount,
    dependency_scope_status: request.scope_kind === "task_identity" ? taskLineageDependencyStatus : dependencyScope.status,
    residual_dependencies: [...scopeResidualDependencies],
    unobserved_dependencies: [...scopeUnobservedDependencies],
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

/** Bind one complete, verified task lineage to one exact backup without exposing its backup ID. */
export async function inspectRecoveryTaskRestoreScopeApplicability(
  env: NodeJS.ProcessEnv,
  backupId: string,
  taskIdentityDigest: string,
  storeKey: RestorableCanonicalStateStoreKey = "operation_plans",
): Promise<RecoveryScopeApplicabilityInspection> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(backupId) || backupId === "latest" ||
      !RECOVERY_SCOPE_DIGEST.test(taskIdentityDigest)) {
    return emptyRecoveryScopeApplicability("invalid_request", {
      ...( /^[A-Za-z0-9_.-]{1,128}$/u.test(backupId) && backupId !== "latest"
        ? { backup_id_digest: createHash("sha256").update(backupId).digest("hex") }
        : {}),
      scope_kind: "task_identity",
      scope_digest: taskIdentityDigest,
    });
  }
  return inspectRecoveryScopeApplicability(env, {
    backup_id_digest: createHash("sha256").update(backupId).digest("hex"),
    scope_kind: "task_identity",
    scope_digest: taskIdentityDigest.toLowerCase(),
    store_candidates: [storeKey],
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

export function isVerifiedRecoveryTaskRestoreScope(
  inspection: RecoveryScopeApplicabilityInspection,
  backupId: string,
  taskIdentityDigest: string,
  storeKey: RestorableCanonicalStateStoreKey = "operation_plans",
): boolean {
  const store = inspection.store_candidates[0];
  return inspection.status === "matched" && inspection.reason === null &&
    inspection.scope_kind === "task_identity" && inspection.scope_digest === taskIdentityDigest.toLowerCase() &&
    inspection.backup_id_digest === createHash("sha256").update(backupId).digest("hex") &&
    inspection.matched_plan_id_digest === null && inspection.matched_plan_scope_count !== null &&
    inspection.matched_plan_scope_count > 0 && inspection.matched_plan_id_digests.length === inspection.matched_plan_scope_count &&
    new Set(inspection.matched_plan_id_digests).size === inspection.matched_plan_scope_count &&
    inspection.backup_task_identity_digest === taskIdentityDigest.toLowerCase() &&
    inspection.backup_task_lineage_plan_scope_count === inspection.matched_plan_scope_count &&
    inspection.backup_task_lineage_integrity === "verified" &&
    inspection.backup_task_lineage_dependency_status !== "unknown" &&
    inspection.store_candidate_count === 1 && inspection.verified_store_candidate_count === 1 &&
    inspection.cross_store_atomic === false && inspection.used_for_authority === false && inspection.may_execute === false &&
    store?.store_key === storeKey && store.snapshot_status === "verified" &&
    ["no_residual_recorded", "residuals_present", "unobserved"].includes(store.dependency_status) &&
    store.related_dependencies.length === RECOVERY_SCOPE_DEPENDENCIES[storeKey].length &&
    store.related_dependencies.every((dependency, index) => dependency === RECOVERY_SCOPE_DEPENDENCIES[storeKey][index]);
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

async function requireVerifiedRecoveryTaskRestoreScope(
  env: NodeJS.ProcessEnv,
  backupId: string,
  scopeDigest: string | undefined,
  storeKey: RestorableCanonicalStateStoreKey = "operation_plans",
): Promise<RecoveryScopeApplicabilityInspection> {
  if (typeof scopeDigest !== "string" || !RECOVERY_SCOPE_DIGEST.test(scopeDigest)) {
    throw new Error("operation_plan_task_scope_required");
  }
  const inspection = await inspectRecoveryTaskRestoreScopeApplicability(env, backupId, scopeDigest, storeKey);
  if (!isVerifiedRecoveryTaskRestoreScope(inspection, backupId, scopeDigest, storeKey)) {
    throw new Error("operation_plan_task_scope_unverified");
  }
  return inspection;
}

async function requireVerifiedRecoveryRestoreScope(
  env: NodeJS.ProcessEnv,
  backupId: string,
  scopeKind: string | undefined,
  scopeDigest: string | undefined,
  storeKey: RestorableCanonicalStateStoreKey = "operation_plans",
): Promise<RecoveryScopeApplicabilityInspection> {
  if (scopeKind === "operation_plan") {
    return requireVerifiedRecoveryPlanRestoreScope(env, backupId, scopeKind, scopeDigest);
  }
  if (scopeKind === "task_identity") {
    return requireVerifiedRecoveryTaskRestoreScope(env, backupId, scopeDigest, storeKey);
  }
  throw new Error("operation_plan_scope_required");
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
  if (!isRestorableCanonicalStateStore(storeKey)) return undefined;
  const archiveDigest = recoveryObservationDigest(value.restored_store_archive_digest);
  const stateDigest = recoveryObservationDigest(value.restored_store_state_digest);
  const backupIdDigest = recoveryBackupIdDigest(value.restored_backup_id);
  if (!archiveDigest || !stateDigest || !backupIdDigest) return undefined;
  const scopeKind = value.restore_scope_kind;
  const scopeDigest = recoveryObservationDigest(value.restore_scope_digest);
  const scopeMode = value.restore_scope_mode;
  if (storeKey === "operation_plans") {
    if ((scopeKind !== "operation_plan" && scopeKind !== "task_identity") || !scopeDigest ||
        (scopeKind === "operation_plan" && scopeMode !== "plan_scoped_merge_v1") ||
        (scopeKind === "task_identity" && scopeMode !== "task_scoped_merge_v1")) return undefined;
  } else if (storeKey === "broker" &&
      (scopeKind !== undefined || value.restore_scope_digest !== undefined || scopeMode !== undefined)) {
    if (scopeKind !== "task_identity" || !scopeDigest || scopeMode !== "task_scoped_merge_v1") return undefined;
  } else if (scopeKind !== undefined || value.restore_scope_digest !== undefined || scopeMode !== undefined) {
    return undefined;
  }
  return {
    schema_version: 1,
    store_key: storeKey,
    restored_store_state_digest: stateDigest,
    restored_backup_id_digest: backupIdDigest,
    ...(storeKey === "operation_plans" && scopeKind === "operation_plan" ? { restore_scope_plan_digest: scopeDigest! } : {}),
    ...((storeKey === "operation_plans" || storeKey === "broker") && scopeKind === "task_identity"
      ? { restore_scope_task_digest: scopeDigest! } : {}),
    ...(scopeMode === "plan_scoped_merge_v1" || scopeMode === "task_scoped_merge_v1" ? { restore_scope_mode: scopeMode } : {}),
  };
}

/** Preserve only the selected store and backup digest so a failed restore can be held after restart. */
export function recoveryStoreRestoreAttemptHistoryEvidence(command: unknown): RecoveryStoreRestoreAttemptEvidence | undefined {
  if (!isRecoveryObservationRecord(command) || command.type !== "tool_call" ||
      !isRecoveryObservationRecord(command.payload) || command.payload.tool_name !== "recovery.restore" ||
      !isRecoveryObservationRecord(command.payload.arguments)) return undefined;
  const args = command.payload.arguments;
  if (!isRestorableCanonicalStateStore(args.store_key)) return undefined;
  const backupIdDigest = recoveryBackupIdDigest(args.backup_id);
  if (!backupIdDigest) return undefined;
  return { schema_version: 1, store_key: args.store_key, backup_id_digest: backupIdDigest };
}

function recoveryStoreRestoreAttemptFromHistory(value: unknown): RecoveryStoreRestoreAttemptEvidence | null {
  if (!isRecoveryObservationRecord(value) || value.schema_version !== 1 ||
      !isRestorableCanonicalStateStore(value.store_key)) return null;
  const backupIdDigest = recoveryObservationDigest(value.backup_id_digest);
  if (!backupIdDigest) return null;
  return { schema_version: 1, store_key: value.store_key, backup_id_digest: backupIdDigest };
}

function recoveryStoreRestoreEvidenceFromHistory(value: unknown): RecoveryStoreRestoreHistoryEvidence | null {
  if (!isRecoveryObservationRecord(value) || value.schema_version !== 1) return null;
  const storeKey = value.store_key;
  const stateDigest = recoveryObservationDigest(value.restored_store_state_digest);
  const backupIdDigest = recoveryObservationDigest(value.restored_backup_id_digest);
  const hasScopeDigest = value.restore_scope_plan_digest !== undefined;
  const scopeDigest = recoveryObservationDigest(value.restore_scope_plan_digest);
  const hasTaskScopeDigest = value.restore_scope_task_digest !== undefined;
  const taskScopeDigest = recoveryObservationDigest(value.restore_scope_task_digest);
  const hasScopeMode = value.restore_scope_mode !== undefined;
  const scopeMode = value.restore_scope_mode;
  if (!isRestorableCanonicalStateStore(storeKey) ||
      !stateDigest || (value.restored_backup_id_digest !== undefined && !backupIdDigest) ||
      (hasScopeDigest && !scopeDigest) || (hasTaskScopeDigest && !taskScopeDigest) ||
      (hasScopeDigest && hasTaskScopeDigest) ||
      (hasScopeDigest && scopeMode !== "plan_scoped_merge_v1") ||
      (hasTaskScopeDigest && scopeMode !== "task_scoped_merge_v1") ||
      (storeKey !== "operation_plans" && storeKey !== "broker" && (hasScopeDigest || hasTaskScopeDigest || hasScopeMode)) ||
      (storeKey === "broker" && (hasScopeDigest ||
        (hasTaskScopeDigest && scopeMode !== "task_scoped_merge_v1") ||
        (hasScopeMode && (scopeMode !== "task_scoped_merge_v1" || !taskScopeDigest)))) ||
      (hasScopeMode && (scopeMode === "plan_scoped_merge_v1" ? !scopeDigest || hasTaskScopeDigest
        : scopeMode === "task_scoped_merge_v1" ? !taskScopeDigest || hasScopeDigest : true))) return null;
  return {
    schema_version: 1,
    store_key: storeKey,
    restored_store_state_digest: stateDigest,
    ...(backupIdDigest ? { restored_backup_id_digest: backupIdDigest } : {}),
    ...(scopeDigest ? { restore_scope_plan_digest: scopeDigest } : {}),
    ...(taskScopeDigest ? { restore_scope_task_digest: taskScopeDigest } : {}),
    ...(scopeMode === "plan_scoped_merge_v1" || scopeMode === "task_scoped_merge_v1" ? { restore_scope_mode: scopeMode } : {}),
  };
}

function unverifiedPlanRestorePoint(planIdDigest: string): RecoveryPlanRestorePointObservation {
  return {
    plan_id_digest: planIdDigest,
    backup_task_identity_digest: null,
    backup_task_lineage_plan_scope_count: null,
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
        backup_task_identity_digest: null,
        backup_task_lineage_plan_scope_count: null,
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
        backup_task_identity_digest: null,
        backup_task_lineage_plan_scope_count: null,
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
    const taskLineagePlanScopeCount = match.task_identity_digest
      ? inventory.plan_scopes.filter((scope) => scope.task_identity_digest === match.task_identity_digest).length
      : null;
    const dependencyMatches = dependencyInventoryComplete
      ? dependencies.plan_scopes.filter((scope) => scope.plan_id_digest === plan.plan_id_digest)
      : [];
    const dependency = uniqueRecord && dependencyMatches.length === 1 ? dependencyMatches[0] : undefined;
    return {
      plan_id_digest: plan.plan_id_digest,
      backup_task_identity_digest: match.task_identity_digest,
      backup_task_lineage_plan_scope_count: taskLineagePlanScopeCount,
      backup_plan_record_status: uniqueRecord ? "matched" : "ambiguous",
      backup_plan_integrity: match.integrity,
      backup_plan_record_count: match.plan_record_count,
      dependency_status: dependency?.status ?? "unknown",
      residual_dependencies: dependency ? [...dependency.residual_dependencies] : [],
      unobserved_dependencies: dependency ? [...dependency.unobserved_dependencies] : [],
    };
  });
}

async function inspectRecoveryTaskMemoryRestorePoints(
  env: NodeJS.ProcessEnv,
  backupIdDigest: string,
): Promise<readonly RecoveryTaskMemoryRestorePointObservation[] | null> {
  const backup = await inspectRecoveryBackup(env, () => backupIdForDigest(env, backupIdDigest));
  if (backup.status !== "verified" || backup.backup_id_digest !== backupIdDigest ||
      backup.canonical_state_stores.find((store) => store.store_key === "m_state")?.status !== "verified") return null;
  const stateRoot = env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki";
  const before = await Promise.all([
    inspectCanonicalStateStoreTarget(stateRoot, "j_control"),
    inspectCanonicalStateStoreTarget(stateRoot, "operation_plans"),
  ]);
  if (before.some((target) => target.status !== "verified" || !target.sha256)) return null;
  const current = inspectGatewayRecoveryState(env);
  const plans = current.ledgers.operation_plans;
  const after = await Promise.all([
    inspectCanonicalStateStoreTarget(stateRoot, "j_control"),
    inspectCanonicalStateStoreTarget(stateRoot, "operation_plans"),
  ]);
  if (after.some((target, index) => target.status !== "verified" ||
      target.sha256 !== before[index]?.sha256 || target.bytes !== before[index]?.bytes) ||
      current.ledgers.j.status !== "verified" || plans.status !== "verified" || plans.omitted_binding_count !== 0 ||
      plans.plans.some((plan) => !plan.task_identity_digest)) return null;
  return correlateTaskMemoryRestorePoints(plans.plans, backup.operation_plan_archive_inventory,
    backup.operation_plan_archive_dependencies);
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
    restore_scope_task_digest: null,
    plan_restore_points: null,
    task_memory_restore_points: null,
    configuration_state: "not_observed",
    evidence_source: "NONE",
    used_for_authority: false,
    may_execute: false,
  };
}

/** An invalid history can only restrict the identified store; it can never confirm restore or authorize work. */
function unverifiedRecoveryStoreHoldCandidate(
  history: RecoveryHistoryEvidence,
  storeKeyFilter?: CanonicalStateStoreKey,
): RecoveryPostActionObservation {
  let latest: { index: number; storeKey: RestorableCanonicalStateStoreKey | null; backupIdDigest: string | null } | undefined;
  for (const entry of history.entries) {
    if (entry.kind !== "execution_history" || entry.used_for_authority !== false ||
        !isRecoveryObservationRecord(entry.payload)) continue;
    const command = entry.payload.command;
    if (!isRecoveryObservationRecord(command) || command.operation !== "recovery.restore" ||
        !isRecoveryObservationRecord(command.payload) || command.payload.tool_name !== "recovery.restore") continue;
    const attempt = recoveryStoreRestoreAttemptFromHistory(entry.payload.recovery_store_restore_attempt);
    const completed = recoveryStoreRestoreEvidenceFromHistory(entry.payload.recovery_store_restore);
    const commandArguments = isRecoveryObservationRecord(command.payload.arguments) ? command.payload.arguments : null;
    const commandStoreKey = isRestorableCanonicalStateStore(commandArguments?.store_key)
      ? commandArguments.store_key
      : null;
    if (entry.payload.offline_goal_purpose_repair_preparation === true && !attempt && !completed && !commandStoreKey) continue;
    const candidateStoreKeys = [attempt?.store_key, completed?.store_key, commandStoreKey]
      .filter((value): value is RestorableCanonicalStateStoreKey => value !== undefined && value !== null);
    const distinctStoreKeys = [...new Set(candidateStoreKeys)];
    const storeKey = distinctStoreKeys.length === 1 ? distinctStoreKeys[0]! : null;
    if (storeKeyFilter && storeKey !== storeKeyFilter) continue;
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
    return options.mode === "startup_canonical_store_hold" || options.mode === "startup_broker_restore_hold"
      ? unverifiedRecoveryStoreHoldCandidate(history,
        options.mode === "startup_broker_restore_hold" ? "broker" : undefined)
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
    if (operation === "recovery.restore" && entry.payload.offline_goal_purpose_repair_preparation === true &&
        !restoreEvidence && !restoreAttempt) continue;
    if (options.mode === "startup_operation_plan_hold" && operation !== "recovery.restore") continue;
    if (options.mode === "startup_operation_plan_hold" && restoreEvidence && restoreEvidence.store_key !== "operation_plans") continue;
    if (options.mode === "startup_operation_plan_hold" && !restoreEvidence && restoreAttempt?.store_key !== "operation_plans") continue;
    if (options.mode === "startup_broker_restore_hold" && operation !== "recovery.restore") continue;
    if (options.mode === "startup_broker_restore_hold" && restoreEvidence && restoreEvidence.store_key !== "broker") continue;
    if (options.mode === "startup_broker_restore_hold" && !restoreEvidence && restoreAttempt?.store_key !== "broker") continue;
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
    store_key: latest.restoreEvidence?.store_key ?? latest.restoreAttempt?.store_key ?? null,
    operation_digest: operationDigest,
    result_digest: latest.resultDigest,
    command_id_digest: latest.commandIdDigest,
    restored_state_digest: latest.restoreEvidence?.restored_store_state_digest ?? null,
    store_ledger_status: null,
    store_ledger_residual_count: null,
    plan_residuals: null,
    restore_backup_id_digest: latest.restoreEvidence?.restored_backup_id_digest ?? latest.restoreAttempt?.backup_id_digest ?? null,
    restore_scope_plan_digest: latest.restoreEvidence?.restore_scope_plan_digest ?? null,
    restore_scope_task_digest: latest.restoreEvidence?.restore_scope_task_digest ?? null,
    ...(latest.restoreEvidence?.restore_scope_mode === "plan_scoped_merge_v1" ||
        latest.restoreEvidence?.restore_scope_mode === "task_scoped_merge_v1"
      ? { restore_scope_mode: latest.restoreEvidence.restore_scope_mode }
      : {}),
    plan_restore_points: null,
    task_memory_restore_points: null,
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
  if ((options.mode === "startup_operation_plan_hold" || options.mode === "startup_canonical_store_hold" ||
      options.mode === "startup_broker_restore_hold") &&
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
      if ((restoreEvidence.store_key !== "operation_plans" && restoreEvidence.store_key !== "broker" &&
          restoreEvidence.store_key !== "cron_events" && restoreEvidence.store_key !== "j_control" &&
          restoreEvidence.store_key !== "m_state" && restoreEvidence.store_key !== "meaning_update_j_control" &&
          restoreEvidence.store_key !== "meaning_update_m_state") ||
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
    if (restoreEvidence.store_key === "operation_plans" &&
        !(restoreEvidence.restore_scope_plan_digest || restoreEvidence.restore_scope_task_digest)) {
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
    const taskMemoryRestorePoints = restoreEvidence.store_key === "m_state" &&
      target.sha256 === restoreEvidence.restored_store_state_digest && storeLedger.status === "verified" &&
      storeLedger.residual_count === 0 && restoreEvidence.restored_backup_id_digest
      ? await inspectRecoveryTaskMemoryRestorePoints(env, restoreEvidence.restored_backup_id_digest)
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
      restore_scope_task_digest: restoreEvidence.restore_scope_task_digest ?? null,
      ...(restoreEvidence.restore_scope_mode === "plan_scoped_merge_v1" ||
          restoreEvidence.restore_scope_mode === "task_scoped_merge_v1"
        ? { restore_scope_mode: restoreEvidence.restore_scope_mode }
        : {}),
      plan_restore_points: planRestorePoints,
      task_memory_restore_points: taskMemoryRestorePoints,
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
  const failureMemoryFile = resolveFailureMemoryFilePath(env);
  const schedulesDir = resolveRuntimeSchedulesDirectory(env);
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
      failure_memory_file: await pathStatus(failureMemoryFile, true),
      failure_memory_dir: await pathStatus(failureMemoryFile ? path.dirname(failureMemoryFile) : undefined, true),
      schedules_dir: await pathStatus(schedulesDir, true),
      log_dir: await pathStatus(env.BLUE_TANUKI_LOG_DIR, true),
    },
    restore: {
      execution_available: false,
      restore_review_request_available: false,
      full_restore_review_request_available: false,
      full_restore_blocked_reason: "blocked_runtime_restore_requires_offline_gateway",
      store_restore_review_request_available: backups.latest_backup_id !== null,
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
    next_safe_action: "Full-package restore is unavailable from this Gateway. If a canonical store is eligible, request its separately scoped restore for HDS L3 owner review. Store snapshots are independent, are not an atomic job-level restore point, and require restart plus cross-store residual inspection before affected work resumes.",
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

async function readSelectedRecoveryArchive(env: NodeJS.ProcessEnv, backupId: string, storeKey: CanonicalStateStoreKey) {
  if (!isRestorableCanonicalStateStore(storeKey)) throw new Error("goal_purpose_restore_requires_offline_reconciliation");
  const manifest = await readManifest(env, backupId);
  const packDir = path.dirname(manifest.manifest_path);
  const snapshot = manifest.canonical_state_snapshot;
  if (!snapshot) throw new Error("canonical_state_snapshot_missing");
  await inspectCanonicalStateSnapshots(packDir, snapshot);
  const entry = snapshot.entries.find(item => item.store_key === storeKey);
  if (!entry || entry.status !== "verified" || !entry.archive_rel_path || !entry.sha256 || entry.bytes === null ||
      ((storeKey !== "broker" && storeKey !== "operation_plans") &&
       snapshot.expected_store_count < RESTORABLE_CANONICAL_STATE_STORES.length)) {
    throw new Error("canonical_state_store_unverified");
  }
  return { packDir, snapshot, selected: { ...entry, archive_rel_path: entry.archive_rel_path, sha256: entry.sha256 } };
}

export async function inspectSelectedRecoveryArchiveDigest(
  env: NodeJS.ProcessEnv, backupId: string, storeKey: CanonicalStateStoreKey,
): Promise<string> {
  return (await readSelectedRecoveryArchive(env, backupId, storeKey)).selected.sha256;
}

export async function restoreRecoveryBackup(
  env: NodeJS.ProcessEnv = process.env,
  options: RestoreRecoveryOptions = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "RESTORE");
  if (options.store_key !== undefined && !isRestorableCanonicalStateStore(options.store_key)) {
    throw new Error("goal_purpose_restore_requires_offline_reconciliation");
  }
  const id = options.backup_id ?? (await latestBackupId(env));
  if (!id) throw new Error("backup_not_found");
  if (options.expected_archive_sha256 !== undefined &&
      (!options.store_key || !/^[a-f0-9]{64}$/.test(options.expected_archive_sha256))) {
    throw new Error("canonical_state_restore_archive_binding_invalid");
  }
  if (options.store_key === "broker" &&
      (options.scope_kind !== undefined || options.scope_digest !== undefined) && options.scope_kind !== "task_identity") {
    throw new Error("broker_restore_task_scope_required");
  }
  let scopeApplicabilityInspection: RecoveryScopeApplicabilityInspection | undefined;
  if (options.store_key === "operation_plans" ||
      (options.store_key === "broker" && (options.scope_kind !== undefined || options.scope_digest !== undefined))) {
    scopeApplicabilityInspection = await requireVerifiedRecoveryRestoreScope(
      env, id, options.scope_kind, options.scope_digest, options.store_key,
    );
  }
  if (options.store_key) {
    const { packDir, snapshot, selected } = await readSelectedRecoveryArchive(env, id, options.store_key);
    if (options.expected_archive_sha256 !== undefined && selected.sha256 !== options.expected_archive_sha256) {
      throw new Error("canonical_state_restore_archive_changed");
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

    if (options.store_key === "operation_plans" ||
        (options.store_key === "broker" && (options.scope_kind !== undefined || options.scope_digest !== undefined))) {
      scopeApplicabilityInspection = await requireVerifiedRecoveryRestoreScope(
        env, id, options.scope_kind, options.scope_digest, options.store_key,
      );
    }
    const sourcePath = await assertArchivePath(packDir, path.resolve(packDir, selected.archive_rel_path), "restore_selected_archive");
    const stagedDirectory = await fs.mkdtemp(path.join(await fs.realpath(preRestorePackDir), ".restore-source-"));
    const archivePath = path.join(stagedDirectory, selected.archive_rel_path);
    try {
      // SQLite and the merge readers must consume the exact bytes checked against the reviewed digest.
      await fs.mkdir(path.dirname(archivePath), { mode: 0o700 });
      await fs.copyFile(sourcePath, archivePath, fsConstants.COPYFILE_EXCL);
      if (process.platform !== "win32") await fs.chmod(archivePath, 0o600);
      const copy = await sha256Path(archivePath, "file");
      if (copy.bytes !== selected.bytes || copy.sha256 !== selected.sha256) {
        throw new Error("canonical_state_restore_archive_changed");
      }
      let restored: { readonly bytes: number; readonly sha256: string; readonly restoredStateSha256: string };
      let restoredItemsCount: number | undefined;
      if (options.store_key === "broker") {
        const archiveBefore = await sha256Path(archivePath, "file").catch(() => null);
        if (!archiveBefore || archiveBefore.bytes !== selected.bytes || archiveBefore.sha256 !== selected.sha256) {
          throw new Error("canonical_state_restore_archive_changed");
        }
        if (scopeApplicabilityInspection?.scope_kind === "task_identity") {
          restoredItemsCount = options.broker_execution_store!.restoreTaskScopeFromCanonicalSnapshot(
            archivePath, options.executor_command_key!, scopeApplicabilityInspection.scope_digest!,
          );
        } else {
          options.broker_execution_store!.restoreFromCanonicalSnapshot(archivePath, options.executor_command_key!);
        }
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
        const archiveBefore = await sha256Path(archivePath, "file").catch(() => null);
        if (!archiveBefore || archiveBefore.bytes !== selected.bytes || archiveBefore.sha256 !== selected.sha256) {
          throw new Error("canonical_state_restore_archive_changed");
        }
        const archivedCheckpoint = readOperationPlanRecoveryCheckpointSnapshot({
          private_state_root: stagedDirectory,
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
          if (scopeApplicabilityInspection!.scope_kind === "task_identity") {
            operationPlanStore.restoreTaskScope(archivedCheckpoint, scopeApplicabilityInspection!.scope_digest!, preRestorePlanCheckpoint);
          } else {
            operationPlanStore.restorePlanScope(archivedCheckpoint, scopeApplicabilityInspection!.scope_digest!, preRestorePlanCheckpoint);
          }
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
          archivePath,
        );
      }
      return actionResult("restore", {
        restored_backup_id: id,
        restored_store_key: options.store_key,
        restored_store_archive_digest: restored.sha256,
        restored_store_state_digest: restored.restoredStateSha256,
        ...(restoredItemsCount === undefined ? {} : { restored_items_count: restoredItemsCount }),
        ...(scopeApplicabilityInspection ? {
          restore_scope_kind: scopeApplicabilityInspection.scope_kind === "task_identity" ? "task_identity" as const : "operation_plan" as const,
          restore_scope_digest: scopeApplicabilityInspection.scope_digest!,
          restore_scope_mode: scopeApplicabilityInspection.scope_kind === "task_identity"
            ? "task_scoped_merge_v1" as const : "plan_scoped_merge_v1" as const,
        } : {}),
        canonical_state_cross_store_atomic: false,
        pre_action_backup_id: preRestore.backup_id,
        pre_action_backup_manifest_path: preRestore.manifest_path,
        next_safe_action: options.store_key === "broker"
          ? scopeApplicabilityInspection?.scope_kind === "task_identity"
            ? "This task-scoped Broker merge appended only missing receipts for the selected task to the current ledger; current Broker history and unrelated tasks were preserved. The restored-state digest marks the import boundary while Executor finalizes this restore receipt. Re-observe J/M/Broker dependencies and require a fresh J review before any continuation; cross-store atomicity and automatic resume are false."
            : "The restored-state digest marks the atomic import boundary while this restore's Executor receipt is still in progress; Executor then finalizes that receipt in Broker. Inspect cross-store residuals before resuming affected work. Only this selected SQLite store was restored; cross-store atomicity is false, and job recovery or automatic resume is not implied."
          : "Restart BLUE-TANUKI, then inspect the restored store and all cross-store residuals. Only this selected SQLite store was restored; snapshots are independent, cross-store atomicity is false, and job recovery or automatic resume is not implied.",
      });
    } finally {
      try {
        await fs.rm(archivePath, { force: true });
        await fs.rmdir(path.dirname(archivePath)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        await fs.rmdir(stagedDirectory);
      } catch {
        // The recovery pack remains private. Do not convert a recorded restore into a retry on cleanup failure.
        console.warn("Recovery restore temporary archive cleanup incomplete in the private recovery pack");
      }
    }
  }

  const manifest = await readManifest(env, id);
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

type FactoryResetTarget = {
  path: string;
  kind: "file" | "directory" | null;
};

async function recoveryPathKind(filepath: string): Promise<FactoryResetTarget["kind"]> {
  let current = filepath;
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
          path.relative(current, await fs.realpath(current)) !== "") {
        throw new Error("factory_reset_target_unverified");
      }
      if (current !== filepath) return null;
      return stat.isDirectory() ? "directory" : "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function preflightFactoryReset(env: NodeJS.ProcessEnv): Promise<FactoryResetTarget[]> {
  if (!env.BLUE_TANUKI_ENV_FILE) throw new Error("env_file_required");
  const stateRoot = trimTrailingSeparators(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
  const privateRoot = path.join(stateRoot, "private-state");
  const resettablePrivateRoots = [
    path.join(privateRoot, "long-term-memory"),
    path.join(privateRoot, "failure-memory"),
  ];
  const installDataRoot = env.BLUE_TANUKI_DATA_ROOT?.trim();
  const protectedPaths = [
    env.BLUE_TANUKI_ENV_FILE,
    env.BLUE_TANUKI_AUDIT_DIR,
    env.BLUE_TANUKI_COMPLETE_HISTORY_FILE?.trim(),
    env.BLUE_TANUKI_APPROVALS_FILE,
    env.BLUE_TANUKI_FILE_ROOT,
    env.BLUE_TANUKI_INSTALL_ROOT?.trim(),
    recoveryRoot(env),
    ...(installDataRoot ? [
      path.join(installDataRoot, "blue-tanuki.env"),
      path.join(installDataRoot, "blue-tanuki-product-data.json"),
      path.join(installDataRoot, "blue-tanuki.pid"),
      path.join(installDataRoot, "blue-tanuki-watchdog.pid"),
      path.join(installDataRoot, "blue-tanuki.stop"),
    ] : []),
  ].filter((value): value is string => Boolean(value)).map(trimTrailingSeparators);
  const configuredTargets: ReadonlyArray<readonly [string | undefined, "file" | "directory"]> = [
    [env.BLUE_TANUKI_SESSION_DIR, "directory"],
    [env.BLUE_TANUKI_MEMORY_FILE, "file"],
    [env.BLUE_TANUKI_MEMORY_DIR, "directory"],
    [env.BLUE_TANUKI_FAILURE_MEMORY_FILE, "file"],
    [env.BLUE_TANUKI_FAILURE_MEMORY_DIR, "directory"],
    [resolveRuntimeSchedulesDirectory(env), "directory"],
    [env.BLUE_TANUKI_LOG_DIR, "directory"],
  ];
  const resetTargets = configuredTargets.flatMap(([value, kind]) =>
    value ? [{ path: trimTrailingSeparators(value), kind }] : []);

  for (const { path: target } of resetTargets) {
    await runtimeSafeTarget(env, target, "factory_reset_remove", { allow_exact: [target] });
    if (protectedPaths.some(protectedPath => isSameOrInside(target, protectedPath) || isSameOrInside(protectedPath, target)) ||
        isSameOrInside(stateRoot, target) || (installDataRoot && isSameOrInside(path.resolve(installDataRoot), target)) ||
        (isSameOrInside(target, privateRoot) && !resettablePrivateRoots.some(root => isSameOrInside(target, root)))) {
      throw new Error("factory_reset_target_protected");
    }
  }
  for (const spec of sourceSpecs(env)) {
    if (spec.source_path && isSameOrInside(recoveryRoot(env), path.resolve(spec.source_path))) {
      throw new Error("factory_reset_backup_target_overlap");
    }
  }
  for (const protectedPath of protectedPaths) await recoveryPathKind(protectedPath);

  const targets: FactoryResetTarget[] = [];
  for (const { path: target, kind: expected } of resetTargets.sort((a, b) => a.path.length - b.path.length)) {
    const kind = await recoveryPathKind(target);
    if (kind && kind !== expected) throw new Error("factory_reset_target_unverified");
    if (targets.some(existing => isSameOrInside(target, existing.path))) continue;
    if (kind) await assertArchiveTreeHasNoSymlinks(target, kind);
    targets.push({ path: target, kind });
  }
  return targets;
}

async function verifyFactoryResetTarget(
  target: FactoryResetTarget,
  snapshot: RecoveryBackupManifest,
): Promise<void> {
  if (await recoveryPathKind(target.path) !== target.kind) throw new Error("factory_reset_target_changed");
  if (!target.kind) return;
  const entry = snapshot.items.find(item => item.source_path && path.relative(item.source_path, target.path) === "");
  if (!entry?.copied || entry.kind !== target.kind || !entry.sha256 || !entry.archive_rel_path) {
    throw new Error("factory_reset_backup_unverified");
  }
  const pack = path.dirname(snapshot.manifest_path);
  const archive = await assertArchivePath(pack, path.resolve(pack, entry.archive_rel_path), "factory_reset_backup");
  if (await recoveryPathKind(archive) !== target.kind) throw new Error("factory_reset_backup_unverified");
  await assertArchiveTreeHasNoSymlinks(archive, target.kind);
  const backedUp = await sha256Path(archive, target.kind);
  if (backedUp.sha256 !== entry.sha256 || backedUp.bytes !== entry.bytes) throw new Error("factory_reset_backup_unverified");
  await assertArchiveTreeHasNoSymlinks(target.path, target.kind);
  const current = await sha256Path(target.path, target.kind);
  if (current.sha256 !== entry.sha256 || current.bytes !== entry.bytes) throw new Error("factory_reset_target_changed");
}

type RecoveryPathProof = { kind: "file" | "directory"; sha256: string; bytes: number } | null;

async function readRecoveryPathProof(filepath: string, rejectHardLinks = false): Promise<RecoveryPathProof> {
  const kind = await recoveryPathKind(filepath);
  if (!kind) return null;
  await assertArchiveTreeHasNoSymlinks(filepath, kind, rejectHardLinks);
  return { kind, ...await sha256Path(filepath, kind, "state") };
}

function factoryResetStateDigest(
  envFile: string,
  envProof: RecoveryPathProof,
  targetProofs: readonly (readonly [string, RecoveryPathProof])[],
): string {
  const sorted = [...targetProofs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(["factory-reset-state.v1", envFile, envProof, sorted])).digest("hex");
}

async function readFactoryResetStateDigest(envFile: string, targets: readonly FactoryResetTarget[]): Promise<string> {
  const envProof = await readRecoveryPathProof(envFile);
  const targetProofs: Array<[string, RecoveryPathProof]> = [];
  for (const target of targets) targetProofs.push([target.path, await readRecoveryPathProof(target.path)]);
  return factoryResetStateDigest(envFile, envProof, targetProofs);
}

async function factoryResetBackupItem(snapshot: RecoveryBackupManifest, source: string): Promise<{
  archive: string | null;
  proof: RecoveryPathProof;
}> {
  const item = snapshot.items.find(entry => entry.source_path && path.relative(entry.source_path, source) === "");
  if (item?.kind === "missing" && !item.copied) return { archive: null, proof: null };
  if (!item?.copied || !item.archive_rel_path || (item.kind !== "file" && item.kind !== "directory")) {
    throw new Error("factory_reset_backup_unverified");
  }
  const pack = path.dirname(snapshot.manifest_path);
  const archive = await assertArchivePath(pack, path.resolve(pack, item.archive_rel_path), "factory_reset_backup");
  const proof = await readRecoveryPathProof(archive);
  if (!proof || proof.kind !== item.kind || proof.bytes !== item.bytes ||
      (proof.kind === "file" && proof.sha256 !== item.sha256)) {
    throw new Error("factory_reset_backup_unverified");
  }
  return { archive, proof };
}

function factoryResetValues(values: Record<string, string>): Record<string, string> {
  for (const key of [...PROVIDER_RESET_KEYS, ...CONNECTOR_RESET_KEYS]) delete values[key];
  return Object.assign(values, { LLM_BACKEND: "stub", COMPOSIO_DRY_RUN: "true", COMPOSIO_LIVE_EXECUTION: "false" });
}

async function prepareFactoryResetVerification(
  envFile: string,
  targets: readonly FactoryResetTarget[],
  snapshot: RecoveryBackupManifest,
): Promise<{ values: Record<string, string>; verification: FactoryResetVerification }> {
  const savedEnv = await factoryResetBackupItem(snapshot, envFile);
  if (savedEnv.proof?.kind === "directory") throw new Error("factory_reset_backup_unverified");
  const envBytes = savedEnv.archive === null ? Buffer.alloc(0) : await fs.readFile(savedEnv.archive);
  if (savedEnv.proof && (envBytes.length !== savedEnv.proof.bytes ||
      createHash("sha256").update(envBytes).digest("hex") !== savedEnv.proof.sha256)) {
    throw new Error("factory_reset_backup_unverified");
  }
  const beforeTargets: Array<[string, RecoveryPathProof]> = [];
  for (const target of targets) beforeTargets.push([target.path, (await factoryResetBackupItem(snapshot, target.path)).proof]);
  const beforeSha256 = factoryResetStateDigest(envFile, savedEnv.proof, beforeTargets);
  if (await readFactoryResetStateDigest(envFile, targets) !== beforeSha256) {
    throw new Error("factory_reset_target_changed");
  }
  const values = factoryResetValues(parseEnvFile(envBytes.toString("utf8")).values);
  const rendered = Buffer.from(renderEnvValues(values), "utf8");
  const afterSha256 = factoryResetStateDigest(
    envFile,
    { kind: "file", sha256: createHash("sha256").update(rendered).digest("hex"), bytes: rendered.length },
    targets.map(target => [target.path, null]),
  );
  return { values, verification: { before_sha256: beforeSha256, after_sha256: afterSha256 } };
}

/** Read current local effects only, for settlement under the existing exclusive owner lock. */
export async function observeFactoryResetRecoveryState(
  env: NodeJS.ProcessEnv,
  evidence: RuntimeRecoveryFenceEvidence,
): Promise<string> {
  const targets = await preflightFactoryReset(env);
  const snapshot = await readManifest(env, evidence.backup_id);
  if (snapshot.action !== "pre_factory_reset" || snapshot.manifest_sha256 !== evidence.manifest_sha256) {
    throw new Error("factory_reset_backup_unverified");
  }
  await preflightRestoreManifest(env, snapshot);
  return readFactoryResetStateDigest(path.resolve(env.BLUE_TANUKI_ENV_FILE!), targets);
}

export async function factoryResetRecovery(
  env: NodeJS.ProcessEnv = process.env,
  options: RecoveryResetOptions & { fence?: FactoryResetRecoveryFence } = {},
): Promise<RecoveryActionResult> {
  assertConfirmation(options.confirm, "FACTORY_RESET");
  const config = { ...env };
  const targets = await preflightFactoryReset(config);
  const envFile = path.resolve(config.BLUE_TANUKI_ENV_FILE!);
  const preFactory = await createBackupManifest(config, "pre_factory_reset");
  const manifestDigest = createHash("sha256").update(`${JSON.stringify(preFactory, null, 2)}\n`).digest("hex");
  if ((await readManifest(config, preFactory.backup_id)).manifest_sha256 !== manifestDigest) {
    throw new Error("factory_reset_backup_unverified");
  }
  await preflightRestoreManifest(config, preFactory);
  for (const target of targets) await verifyFactoryResetTarget(target, preFactory);

  const fence = options.fence;
  const prepared = fence ? await prepareFactoryResetVerification(envFile, targets, preFactory) : undefined;
  const values = prepared?.values ?? factoryResetValues(await readEnvValues(config));
  let removed = 0;
  if (fence && prepared) fence.begin(preFactory.backup_id, manifestDigest, prepared.verification);
  try {
    await writeEnvValues({ ...config }, values, "factory-reset");
    Object.assign(env, values);
    deleteEnvKeys(env, [...PROVIDER_RESET_KEYS, ...CONNECTOR_RESET_KEYS]);
    for (const target of targets) {
      await verifyFactoryResetTarget(target, preFactory);
      if (!target.kind) continue;
      await fs.rm(target.path, { recursive: target.kind === "directory" });
      if (await recoveryPathKind(target.path) !== null) throw new Error("factory_reset_target_remains");
      removed += 1;
    }
    if (fence && prepared) {
      if (await readFactoryResetStateDigest(envFile, targets) !== prepared.verification.after_sha256) {
        throw new Error("factory_reset_postconditions_unverified");
      }
      fence.finish(preFactory.backup_id, manifestDigest, prepared.verification);
    }
  } catch {
    // Earlier effects may have committed. Leave the pre-action backup and let the
    // Executor record this failed invocation as an unknown outcome.
    throw new Error("factory_reset_outcome_unknown");
  }

  const preserved = [
    config.BLUE_TANUKI_AUDIT_DIR ? path.resolve(config.BLUE_TANUKI_AUDIT_DIR) : null,
    recoveryRoot(config),
  ].filter((value): value is string => Boolean(value));

  return actionResult("factory_reset", {
    backup_id: preFactory.backup_id,
    backup_manifest_path: preFactory.manifest_path,
    removed_paths_count: removed,
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
