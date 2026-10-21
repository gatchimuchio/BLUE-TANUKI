import { operationPlanDigest, operationPlanTaskIdentityDigest, type OperationPlanBrokerRestoreDependencyEvidence,
  type OperationPlanBrokerRestoreDependencyStatus, type OperationPlanRecoveryEvidence } from "@blue-tanuki/hds-brain";
import type { OperationPlanCheckpoint } from "@blue-tanuki/protocol";
import type { GatewayRecoveryOperatorProjection } from "./recovery_inspection.js";
import type { RecoveryPostActionObservation } from "./recovery_surface.js";

const DIGEST = /^[a-f0-9]{64}$/;

function brokerRestorePlanStatus(
  projection: GatewayRecoveryOperatorProjection | null | undefined,
  planIdDigest: string,
): OperationPlanBrokerRestoreDependencyStatus {
  if (!projection || projection.schema_version !== 12 || projection.surface !== "recovery_inspection_operator" ||
      projection.mode !== "read_only" || projection.boundary_valid !== true ||
      projection.used_for_authority !== false || projection.may_execute !== false ||
      !Array.isArray(projection.operation_plan_correlations) || !Array.isArray(projection.plan_dependency_scopes) ||
      projection.omitted_plan_dependency_scope_count !== 0) return "unverified";
  const scopes = projection.plan_dependency_scopes.filter((scope) => scope.plan_id_digest === planIdDigest);
  if (scopes.length !== 1) return "unverified";
  const scope = scopes[0]!;
  const rows = projection.operation_plan_correlations.filter((row) => row.plan_id_digest === planIdDigest);
  if (scope.omitted_binding_count > 0 || scope.inspected_binding_count !== scope.binding_count ||
      rows.length !== scope.binding_count) return "unobserved";
  if (scope.status === "residuals_present" || scope.residual_dependencies.length > 0) return "residuals_present";
  if (scope.status === "unobserved" || scope.unobserved_dependencies.length > 0) return "unobserved";
  if (scope.binding_count === 0 || rows.every((row) => row.broker_correlation === "not_admitted")) return "unaffected";
  if (rows.some((row) => !["matched", "not_admitted"].includes(row.broker_correlation))) {
    return "unverified";
  }
  if (scope.status !== "observed") return "unverified";
  return "observed";
}

/** Re-observe the current J/M/Broker dependency scope. A positive result only permits a fresh J review. */
export function brokerRestorePlanDependencyIsCurrent(
  projection: GatewayRecoveryOperatorProjection | null | undefined,
  planIdDigest: string,
): boolean {
  return DIGEST.test(planIdDigest) && ["observed", "unaffected"].includes(brokerRestorePlanStatus(projection, planIdDigest));
}

/** Build plan-scoped holds from a matched Broker restore and a read-only cross-ledger inspection. */
export function operationPlanBrokerRestoreDependencyEvidenceFromObservation(input: {
  readonly observation: RecoveryPostActionObservation;
  readonly checkpoint: OperationPlanCheckpoint | null;
  readonly history_complete: boolean;
  readonly recovery_projection?: GatewayRecoveryOperatorProjection | null;
}): OperationPlanBrokerRestoreDependencyEvidence | undefined {
  const observation = input.observation;
  if (observation.operation !== "restore" || observation.store_key !== "broker" || !input.checkpoint) return undefined;
  const taskScopedRestore = observation.restore_scope_mode === "task_scoped_merge_v1" &&
    observation.restore_scope_task_digest !== null && DIGEST.test(observation.restore_scope_task_digest ?? "");
  const taskIdentityDigest = taskScopedRestore ? observation.restore_scope_task_digest! : null;
  const restoreObservationVerified = input.history_complete && observation.status === "matched" &&
    observation.store_ledger_status === "verified" && observation.store_ledger_residual_count === 0 &&
    observation.command_id_digest !== null && DIGEST.test(observation.command_id_digest) &&
    observation.operation_digest !== null && DIGEST.test(observation.operation_digest) &&
    observation.result_digest !== null && DIGEST.test(observation.result_digest) &&
    observation.restore_backup_id_digest !== null && DIGEST.test(observation.restore_backup_id_digest) &&
    observation.restored_state_digest !== null && DIGEST.test(observation.restored_state_digest);
  const recoveryProjection = input.recovery_projection;
  const plans = input.checkpoint.plans.map((planState) => {
    const planIdDigest = operationPlanDigest(planState.revisions[0]!.plan.plan_id);
    return {
      plan_id_digest: planIdDigest,
      status: taskScopedRestore
        ? operationPlanTaskIdentityDigest(planState) !== taskIdentityDigest
          ? "unaffected" as const
          : restoreObservationVerified ? "unobserved" as const : "unverified" as const
        : restoreObservationVerified ? brokerRestorePlanStatus(recoveryProjection, planIdDigest) : "unverified" as const,
    };
  });
  return {
    schema_version: "operation-plan-broker-restore-dependency-evidence.v1",
    checkpoint_digest: operationPlanDigest(input.checkpoint),
    restore_observation: restoreObservationVerified ? "verified" : "unverified",
    provenance: {
      source: "recovery_restore",
      command_id_digest: observation.command_id_digest,
      operation_digest: observation.operation_digest,
      result_digest: observation.result_digest,
      restore_store_key: "broker",
      restore_backup_id_digest: observation.restore_backup_id_digest,
      restore_scope_plan_digest: null,
      restore_scope_task_digest: taskIdentityDigest,
      ...(taskScopedRestore ? { restore_scope_mode: "task_scoped_merge_v1" as const } : {}),
      restored_state_digest: observation.restored_state_digest,
    },
    plans,
    used_for_authority: false,
    may_execute: false,
  };
}

function unverifiedHistoryEvidence(
  checkpointDigest: string,
  observation?: RecoveryPostActionObservation,
): OperationPlanRecoveryEvidence {
  return {
    schema_version: "operation-plan-recovery-evidence.v1",
    scope: "unverified_history",
    checkpoint_digest: checkpointDigest,
    provenance: {
      source: observation?.operation === "restore" ? "recovery_restore" : "unverified_history",
      command_id_digest: observation?.command_id_digest ?? null,
      operation_digest: observation?.operation_digest ?? null,
      result_digest: observation?.result_digest ?? null,
      restore_store_key: observation?.store_key ?? null,
      restore_backup_id_digest: observation?.restore_backup_id_digest ?? null,
      restore_scope_plan_digest: observation?.restore_scope_plan_digest ?? null,
      restore_scope_task_digest: observation?.restore_scope_task_digest ?? null,
      ...(observation?.restore_scope_mode ? { restore_scope_mode: observation.restore_scope_mode } : {}),
      restored_state_digest: observation?.restored_state_digest ?? null,
    },
    plans: [],
    used_for_authority: false,
    may_execute: false,
  };
}

/** Convert recovery observations into checkpoint-bound HDS evidence that can only hold existing plan selection. */
export function operationPlanRecoveryEvidenceFromObservation(input: {
  readonly observation: RecoveryPostActionObservation;
  readonly checkpoint: OperationPlanCheckpoint | null;
  readonly history_complete: boolean;
}): OperationPlanRecoveryEvidence | undefined {
  const plans = input.checkpoint?.plans ?? [];
  if (plans.length === 0) return undefined;
  const checkpointDigest = operationPlanDigest(input.checkpoint);
  if (!input.history_complete || (input.observation.status === "unverified" && input.observation.operation === null)) {
    return unverifiedHistoryEvidence(checkpointDigest, input.observation);
  }
  const observation = input.observation;
  if (observation.operation !== "restore") return undefined;
  if (observation.store_key !== "operation_plans") {
    if (observation.store_key === "j_control" || observation.store_key === "m_state") {
      // J/M store integrity does not prove that each existing OperationPlan still
      // has the exact cross-store memory dependencies it was created against.
      return unverifiedHistoryEvidence(checkpointDigest, observation);
    }
    if (observation.store_key === "cron_events") {
      if (observation.status === "matched" && observation.store_ledger_status === "verified" &&
          observation.store_ledger_residual_count === 0) return undefined;
      return unverifiedHistoryEvidence(checkpointDigest, observation);
    }
    return observation.store_key === null ? unverifiedHistoryEvidence(checkpointDigest, observation) : undefined;
  }
  const taskScopedRestore = observation.restore_scope_mode === "task_scoped_merge_v1";
  const scopeDigest = taskScopedRestore ? observation.restore_scope_task_digest : observation.restore_scope_plan_digest;
  if (!scopeDigest || !/^[a-f0-9]{64}$/.test(scopeDigest)) {
    return unverifiedHistoryEvidence(checkpointDigest, observation);
  }
  const selectivelyRestored = observation.restore_scope_mode === "plan_scoped_merge_v1" || taskScopedRestore;

  const evidencePlans = plans.map((planState) => {
    const planIdDigest = operationPlanDigest(planState.revisions[0]!.plan.plan_id);
    const taskIdentityDigest = operationPlanTaskIdentityDigest(planState);
    const selectedByScope = taskScopedRestore ? taskIdentityDigest === scopeDigest : planIdDigest === scopeDigest;
    const currentMatches = observation.plan_residuals?.filter((entry) => entry.plan_id_digest === planIdDigest) ?? [];
    const backupMatches = observation.plan_restore_points?.filter((entry) => entry.plan_id_digest === planIdDigest) ?? [];
    const currentPlan = currentMatches.length === 1 ? currentMatches[0] : undefined;
    const backupPlan = backupMatches.length === 1 ? backupMatches[0] : undefined;
    const restoreMembership: OperationPlanRecoveryEvidence["plans"][number]["restore_membership"] =
      selectivelyRestored && !selectedByScope ? "not_restored"
        : taskScopedRestore && selectedByScope && backupPlan?.backup_task_identity_digest !== scopeDigest ? "unknown"
        : observation.status === "changed" && currentPlan && backupPlan?.backup_plan_record_status === "not_found"
        ? "not_restored"
        : ["matched", "changed"].includes(observation.status) && currentPlan &&
          backupPlan?.backup_plan_record_status === "matched" ? "restored" : "unknown";

    let integrity: OperationPlanRecoveryEvidence["plans"][number]["integrity"] = "unverified";
    if (currentPlan?.status === "residuals_present" || (currentPlan?.residual_binding_count ?? 0) > 0 ||
        (currentPlan?.omitted_binding_count ?? 0) > 0 || backupPlan?.backup_plan_integrity === "residuals_present") {
      integrity = "residuals_present";
    } else if (observation.status === "matched" && currentPlan?.status === "verified" &&
        currentPlan.residual_binding_count === 0 && currentPlan.omitted_binding_count === 0 &&
        backupPlan?.backup_plan_record_status === "matched" && backupPlan.backup_plan_integrity === "verified") {
      integrity = "verified";
    }

    let dependencyStatus: OperationPlanRecoveryEvidence["plans"][number]["dependency_status"] = "unknown";
    if (backupPlan?.dependency_status === "residuals_present" || backupPlan?.residual_dependencies.length) {
      dependencyStatus = "residuals_present";
    } else if (backupPlan?.dependency_status === "unobserved" || backupPlan?.unobserved_dependencies.length) {
      dependencyStatus = "unobserved";
    } else if (backupPlan?.dependency_status === "observed" && backupPlan.residual_dependencies.length === 0 &&
        backupPlan.unobserved_dependencies.length === 0 && observation.status === "matched") {
      dependencyStatus = taskScopedRestore && selectedByScope ? "unobserved" : "observed";
    } else if (taskScopedRestore && selectedByScope && backupPlan?.backup_plan_record_status === "matched") {
      dependencyStatus = "unobserved";
    }

    return {
      plan_id_digest: planIdDigest,
      task_identity_digest: taskIdentityDigest,
      restore_scope_relation: selectedByScope ? "requested" as const : "collateral" as const,
      restore_membership: restoreMembership,
      integrity,
      dependency_status: dependencyStatus,
    };
  });
  return {
    schema_version: "operation-plan-recovery-evidence.v1",
    scope: "restored_operation_plans",
    checkpoint_digest: checkpointDigest,
    provenance: {
      source: "recovery_restore",
      command_id_digest: observation.command_id_digest,
      operation_digest: observation.operation_digest,
      result_digest: observation.result_digest,
      restore_store_key: observation.store_key,
      restore_backup_id_digest: observation.restore_backup_id_digest,
      restore_scope_plan_digest: taskScopedRestore ? null : observation.restore_scope_plan_digest,
      restore_scope_task_digest: taskScopedRestore ? observation.restore_scope_task_digest ?? null : null,
      ...(selectivelyRestored ? { restore_scope_mode: taskScopedRestore
        ? "task_scoped_merge_v1" as const : "plan_scoped_merge_v1" as const } : {}),
      restored_state_digest: observation.restored_state_digest,
    },
    plans: evidencePlans,
    used_for_authority: false,
    may_execute: false,
  };
}
