import { operationPlanDigest, type OperationPlanRecoveryEvidence } from "@blue-tanuki/hds-brain";
import type { OperationPlanCheckpoint } from "@blue-tanuki/protocol";
import type { RecoveryPostActionObservation } from "./recovery_surface.js";

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
      restore_backup_id_digest: observation?.restore_backup_id_digest ?? null,
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
  if (observation.store_key !== "operation_plans") return observation.store_key === null
    ? unverifiedHistoryEvidence(checkpointDigest, observation) : undefined;

  const evidencePlans = plans.map((planState) => {
    const planIdDigest = operationPlanDigest(planState.revisions[0]!.plan.plan_id);
    const currentMatches = observation.plan_residuals?.filter((entry) => entry.plan_id_digest === planIdDigest) ?? [];
    const backupMatches = observation.plan_restore_points?.filter((entry) => entry.plan_id_digest === planIdDigest) ?? [];
    const currentPlan = currentMatches.length === 1 ? currentMatches[0] : undefined;
    const backupPlan = backupMatches.length === 1 ? backupMatches[0] : undefined;
    const restoreMembership: OperationPlanRecoveryEvidence["plans"][number]["restore_membership"] =
      observation.status === "changed" && currentPlan && backupPlan?.backup_plan_record_status === "not_found"
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
      dependencyStatus = "observed";
    }

    return { plan_id_digest: planIdDigest, restore_membership: restoreMembership, integrity, dependency_status: dependencyStatus };
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
      restore_backup_id_digest: observation.restore_backup_id_digest,
      restored_state_digest: observation.restored_state_digest,
    },
    plans: evidencePlans,
    used_for_authority: false,
    may_execute: false,
  };
}
