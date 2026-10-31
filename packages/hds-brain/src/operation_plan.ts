import { createHash, randomUUID } from "node:crypto";
import {
  getOperationDescriptor, inspectOperationCommandExecutionResult,
  GoalCriteriaProjectionSchema, OperationJsonValueSchema, OperationPlanCheckpointEnvelopeSchema,
  OperationPlanCheckpointPlanSchema, OperationPlanCheckpointSchema, OperationPlanSchema, prepareOperationPlan,
  type ExecuteCommand, type ExecuteFeedback, type InboundRequest, type OperationPlan,
  type OperationPlanCheckpoint, type OperationPlanControl, type OperationPlanGoalPurposeBinding,
  type OperationPlanResultReturnControl, type OperationPlanWaitResumeControl, type OperationPlanWaitState,
  type OperationPlanComputeParent,
  type OperationPlanComputeSourceObservation, type OperationPlanComputeSourceObservationReference,
  type OperationPlanGatewayReceiptRecheckEvidence, OperationPlanGatewayReceiptRecheckEvidenceSchema,
  OperationPlanShellExecResultObservationSchema, type OperationPlanShellExecResultObservation,
  type OperationCommandExecutionResult,
  type GatewayInternalInboundRequestInput,
  type OperationPlanGoalPurposeRelationCandidate, type OperationPlanGoalPurposeRelationOwnerReview,
  type OperationPlanGoalPurposeRelationRecord, type OperationPlanGoalPurposeRelationReviewArguments, type OperationStep,
  type OperationPlanGoalRelationAdoptionAssessment,
  type MemoryCommitV2, type MemoryUpdateReceiptV1,
  ExecutionAdmissionSchema, inspectExecutionResultDelivery, type ExecutionAdmission, type ExecutionResultDelivery,
  OperationPlanExternalReceiptObservationSchema, type OperationPlanExternalReceiptObservation,
  fileWritePayloadDigest,
  fileWriteTargetIdentityDigest,
  OperationPlanComputeSourceObservationSchema,
  OperationPlanComputeSourceObservationReferenceSchema,
  OperationPlanGoalPurposeBindingSchema,
  OperationPlanGoalPurposeRelationCandidateSchema,
  OperationPlanGoalPurposeRelationOwnerReviewSchema,
  OperationPlanGoalPurposeRelationRecordSchema,
  OperationPlanGoalRelationAdoptionAssessmentSchema,
  OperationPlanGoalPurposeRelationReviewArgumentsSchema,
  OperationPlanMemoryInterpretationDependencySchema,
  OperationPlanWaitStateSchema,
  OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION, type OperationPlanReflectionControl,
  type OperationPlanMemoryInterpretationDependency,
  type OperationPlanReceiptReconciliationControl,
  type ComputeResourceUse,
  canonicalExecutorCommandBytes,
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator } from "./制御状態.js";
import type { JMemoryApprovalReference } from "./保存取引.js";
import { assessCandidateGoalCriteria, digestGoalCriteriaValue, projectRequestGoalCriteria } from "./candidate_criteria.js";
import { buildResultMemoryCommit, resultMemoryEligible, resultMemoryIdentity, verifyResultMemoryCommit, receiptForResultCommit,
  buildShellExecResultMemoryCommit, shellExecResultMemoryIdentity, shellExecResultMemoryObservation,
  verifyShellExecResultMemoryCommit } from "./operation_result_memory.js";
import { buildReceiptMemoryCommit, receiptForReceiptMemoryCommit, receiptMemoryIdentity, receiptMemoryObservation,
  verifyReceiptMemoryCommit } from "./operation_receipt_memory.js";
import type { ResultObservationCitation, ResultObservationProjection } from "./operation_result_reflection.js";
import type { ReadonlyGoalGovernanceProjection } from "./goal_governance.js";
import type { RuntimeKernelJPlanStepAdoptionProjection } from "./runtime_kernel_j_projection.js";

type PlanState = OperationPlanCheckpoint["plans"][number];
type Binding = PlanState["bindings"][number];

export interface OperationPlanSavedResultReturnProjection {
  readonly schema_version: "operation-plan-saved-result-return.v1";
  readonly plan_id_digest: string;
  readonly revision_digest: string;
  readonly step_id_digest: string;
  readonly command_digest: string;
  readonly result_digest: string;
  readonly record_digest: string;
  readonly memory_revision: number;
  readonly memory_receipt_digest: string;
  readonly observed_at_ms: number;
  readonly visited_files: number;
  readonly search_completeness: "unknown";
  readonly matches: readonly { readonly path: string; readonly line_number: number; readonly line: string }[];
  readonly used_as_world_truth: false;
  readonly used_for_authority: false;
  readonly may_execute: false;
};

type MemoryInterpretationReviewSnapshot = {
  readonly record: {
    readonly application_state: "active" | "quarantined";
    readonly current_interpretation_id: string | null;
    readonly interpretations: readonly { readonly interpretation_id: string; readonly basis_ref: string }[];
    readonly dependent_judgments: readonly {
      readonly judgment_ref: string;
      readonly basis_interpretation_id: string;
      readonly reassessment_required: boolean;
    }[];
    readonly used_for_authority: false;
    readonly may_execute: false;
  } | null;
  readonly used_for_authority: false;
};

/** Stable across plan revisions; the digest correlates a task but confers no authority. */
export function operationPlanTaskIdentityDigest(plan: PlanState): string {
  if (plan.task_identity_digest) return plan.task_identity_digest;
  const first = plan.revisions[0]!.plan;
  return operationPlanDigest({
    schema_version: "blue-tanuki.operation-plan-task-identity.v1",
    owner_digest: operationPlanDigest(plan.owner),
    channel_digest: operationPlanDigest(plan.channel),
    task_digest: operationPlanDigest(plan.goal),
    plan_id_digest: operationPlanDigest(first.plan_id),
    request_id_digest: operationPlanDigest(first.request_id),
  });
}

function operationPlanTaskPlanSetDigest(planIdDigests: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...planIdDigests].sort())).digest("hex");
}

export interface OperationPlanGoalPurposeRelationReviewContent {
  readonly task: string;
  readonly purpose_text: string;
  readonly plan: OperationPlan;
  readonly goal_purpose_binding: OperationPlanGoalPurposeBinding;
  readonly candidate_outcome: OperationPlanGoalPurposeRelationRecord["candidate_outcome"];
  readonly candidate_status: OperationPlanGoalPurposeRelationRecord["candidate_status"];
  readonly evidence_status: OperationPlanGoalPurposeRelationRecord["evidence_status"];
  readonly evidence_count: number;
}

type OperationPlanGoalPurposeRelationReviewVerifier = (input: {
  readonly request_id: string;
  readonly command_id: string;
  readonly audit_event_digest: string;
}) => boolean;
/** 私有の回復状態。保存内容は現在の承認・実行権限ではない。 */
export interface OperationPlanStatePort {
  load(memory_available?: boolean): unknown | null;
  compareAndSet(expected_digest: string | null, checkpoint: OperationPlanCheckpoint, memory_available?: boolean): void;
  loadRecoveryHoldState(): unknown | null;
  compareAndSetRecoveryHoldState(expected_digest: string | null, state: OperationPlanRecoveryHoldState): void;
}
export interface OperationPlanMemoryStorage {
  readonly private_state_root: string;
  readonly database_path: string;
  readonly memory_database_path: string;
}

export interface OperationPlanGoalPurposeContent {
  readonly goal_ref: string;
  readonly version: number;
  readonly purpose_digest: string;
  readonly purpose_text: string;
  readonly used_for_authority: false;
}

export type OperationPlanRecoveryHoldReason = "held_residual" | "held_unobserved" | "held_unverified";
export type OperationPlanRecoveryScopeRelation = "requested" | "collateral" | "unknown";

export interface OperationPlanRecoveryEvidenceProvenance {
  readonly source: "recovery_restore" | "unverified_history";
  readonly command_id_digest: string | null;
  readonly operation_digest: string | null;
  readonly result_digest: string | null;
  readonly restore_store_key?: "j_control" | "m_state" | "meaning_update_j_control" | "meaning_update_m_state" |
    "broker" | "operation_plans" | "cron_events" | null;
  readonly restore_backup_id_digest: string | null;
  readonly restore_scope_plan_digest: string | null;
  readonly restore_scope_task_digest?: string | null;
  readonly restore_scope_mode?: "plan_scoped_merge_v1" | "task_scoped_merge_v1";
  readonly restore_task_identity_digest?: string | null;
  readonly restore_task_plan_set_digest?: string | null;
  readonly restore_task_dependency_status?: "observed" | "residuals_present" | "unobserved" | "unknown" | null;
  readonly restored_state_digest: string | null;
}

export interface OperationPlanRecoveryHoldProvenance extends OperationPlanRecoveryEvidenceProvenance {
  readonly checkpoint_digest: string;
}

export interface OperationPlanRecoveryHoldState {
  readonly schema_version: "operation-plan-recovery-holds.v1";
  readonly holds: readonly {
    readonly plan_id_digest: string;
    readonly reason: OperationPlanRecoveryHoldReason;
    readonly restore_scope_relation: OperationPlanRecoveryScopeRelation;
    readonly provenance: OperationPlanRecoveryHoldProvenance;
  }[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

/** A verified post-action observation is recorded as evidence only, never as authority. */
export interface OperationPlanCanonicalMemoryRestoreObservation {
  readonly status: "matched";
  readonly operation: "restore";
  readonly store_key: "j_control" | "m_state" | "meaning_update_j_control" | "meaning_update_m_state";
  readonly command_id_digest: string;
  readonly operation_digest: string;
  readonly result_digest: string;
  readonly restore_backup_id_digest: string;
  readonly restored_state_digest: string;
  readonly store_ledger_status: "verified";
  readonly store_ledger_residual_count: 0;
  readonly task_memory_restore_points?: readonly {
    readonly task_identity_digest: string;
    readonly plan_id_digests: readonly string[];
    readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  }[] | null;
}

export interface OperationPlanRecoveryEvidence {
  readonly schema_version: "operation-plan-recovery-evidence.v1";
  readonly scope: "restored_operation_plans" | "unverified_history";
  readonly checkpoint_digest: string;
  readonly provenance?: OperationPlanRecoveryEvidenceProvenance;
  readonly plans: readonly {
    readonly plan_id_digest: string;
    readonly task_identity_digest?: string;
    readonly restore_scope_relation: OperationPlanRecoveryScopeRelation;
    readonly restore_membership: "restored" | "not_restored" | "unknown";
    readonly integrity: "verified" | "residuals_present" | "unverified";
    readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  }[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export type OperationPlanBrokerRestoreDependencyStatus =
  | "unaffected"
  | "observed"
  | "residuals_present"
  | "unobserved"
  | "unverified";

/** Per-plan, digest-only J/M/Broker re-observation after a Broker-store restore. */
export interface OperationPlanBrokerRestoreDependencyEvidence {
  readonly schema_version: "operation-plan-broker-restore-dependency-evidence.v1";
  readonly checkpoint_digest: string;
  readonly restore_observation: "verified" | "unverified";
  readonly provenance: OperationPlanRecoveryEvidenceProvenance;
  readonly plans: readonly {
    readonly plan_id_digest: string;
    readonly status: OperationPlanBrokerRestoreDependencyStatus;
  }[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

/** Re-observation is evidence for a fresh J review and can never itself admit or execute a plan. */
export type OperationPlanBrokerRestoreDependencyVerifier = (
  planIdDigest: string,
  provenance: OperationPlanRecoveryHoldProvenance,
) => boolean;

function recoveryEvidenceProvenance(value: unknown): OperationPlanRecoveryEvidenceProvenance {
  const raw = value as Record<string, unknown> | undefined;
  if (raw === undefined) return {
    source: "unverified_history", command_id_digest: null, operation_digest: null, result_digest: null,
    restore_store_key: null, restore_backup_id_digest: null, restore_scope_plan_digest: null,
    restore_scope_task_digest: null, restore_task_identity_digest: null, restore_task_plan_set_digest: null,
    restore_task_dependency_status: null, restored_state_digest: null,
  };
  const digestOrNull = (digest: unknown): digest is string | null => digest === null ||
    (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
        "restore_store_key", "restore_backup_id_digest", "restore_scope_plan_digest", "restore_scope_task_digest",
        "restore_scope_mode", "restore_task_identity_digest", "restore_task_plan_set_digest",
        "restore_task_dependency_status", "restored_state_digest"].includes(key)) ||
      !["recovery_restore", "unverified_history"].includes(String(raw.source)) ||
      !digestOrNull(raw.command_id_digest) || !digestOrNull(raw.operation_digest) ||
      !digestOrNull(raw.result_digest) || !digestOrNull(raw.restore_backup_id_digest) ||
      (raw.restore_store_key !== undefined && raw.restore_store_key !== null &&
        !["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state", "broker", "operation_plans", "cron_events"]
          .includes(String(raw.restore_store_key))) ||
      (raw.restore_scope_plan_digest !== undefined && !digestOrNull(raw.restore_scope_plan_digest)) ||
      (raw.restore_scope_task_digest !== undefined && !digestOrNull(raw.restore_scope_task_digest)) ||
      (raw.restore_scope_mode !== undefined && !["plan_scoped_merge_v1", "task_scoped_merge_v1"].includes(String(raw.restore_scope_mode))) ||
      (raw.restore_scope_mode === "plan_scoped_merge_v1" && (!raw.restore_scope_plan_digest || raw.restore_scope_task_digest)) ||
      (raw.restore_scope_mode === "task_scoped_merge_v1" && (!raw.restore_scope_task_digest || raw.restore_scope_plan_digest)) ||
      (raw.restore_task_identity_digest !== undefined && !digestOrNull(raw.restore_task_identity_digest)) ||
      (raw.restore_task_plan_set_digest !== undefined && !digestOrNull(raw.restore_task_plan_set_digest)) ||
      (raw.restore_task_dependency_status !== undefined && raw.restore_task_dependency_status !== null &&
        !["observed", "residuals_present", "unobserved", "unknown"].includes(String(raw.restore_task_dependency_status))) ||
      ((raw.restore_task_identity_digest !== undefined && raw.restore_task_identity_digest !== null ||
        raw.restore_task_plan_set_digest !== undefined && raw.restore_task_plan_set_digest !== null ||
        raw.restore_task_dependency_status !== undefined && raw.restore_task_dependency_status !== null) &&
        (raw.restore_store_key !== "m_state" || !raw.restore_task_identity_digest || !raw.restore_task_plan_set_digest ||
          !["observed", "residuals_present", "unobserved", "unknown"].includes(String(raw.restore_task_dependency_status)))) ||
      !digestOrNull(raw.restored_state_digest)) throw new Error("plan_recovery_evidence_invalid");
  return {
    source: raw.source as OperationPlanRecoveryEvidenceProvenance["source"],
    command_id_digest: raw.command_id_digest,
    operation_digest: raw.operation_digest,
    result_digest: raw.result_digest,
    restore_store_key: raw.restore_store_key === undefined || raw.restore_store_key === null
      ? null : raw.restore_store_key as NonNullable<OperationPlanRecoveryEvidenceProvenance["restore_store_key"]>,
    restore_backup_id_digest: raw.restore_backup_id_digest,
    restore_scope_plan_digest: raw.restore_scope_plan_digest ?? null,
    restore_scope_task_digest: raw.restore_scope_task_digest ?? null,
    ...(raw.restore_scope_mode === "plan_scoped_merge_v1" || raw.restore_scope_mode === "task_scoped_merge_v1"
      ? { restore_scope_mode: raw.restore_scope_mode } : {}),
    restore_task_identity_digest: raw.restore_task_identity_digest ?? null,
    restore_task_plan_set_digest: raw.restore_task_plan_set_digest ?? null,
    restore_task_dependency_status: raw.restore_task_dependency_status === "observed" ||
        raw.restore_task_dependency_status === "residuals_present" || raw.restore_task_dependency_status === "unobserved" ||
        raw.restore_task_dependency_status === "unknown"
      ? raw.restore_task_dependency_status : null,
    restored_state_digest: raw.restored_state_digest,
  };
}

function recoveryScopeRelation(
  planIdDigest: string,
  requestedPlanDigest: string | null,
): OperationPlanRecoveryScopeRelation {
  if (!requestedPlanDigest) return "unknown";
  return planIdDigest === requestedPlanDigest ? "requested" : "collateral";
}

function parseOperationPlanRecoveryHoldState(value: unknown): OperationPlanRecoveryHoldState {
  const raw = value as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["schema_version", "holds", "used_for_authority", "may_execute"].includes(key)) ||
      raw.schema_version !== "operation-plan-recovery-holds.v1" || raw.used_for_authority !== false ||
      raw.may_execute !== false || !Array.isArray(raw.holds) || raw.holds.length > 64) {
    throw new Error("plan_recovery_hold_state_invalid");
  }
  const seen = new Set<string>();
  const holds = raw.holds.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plan_recovery_hold_state_invalid");
    const hold = entry as Record<string, unknown>;
    const provenance = hold.provenance as Record<string, unknown> | undefined;
    if (Object.keys(hold).some((key) => !["plan_id_digest", "reason", "restore_scope_relation", "provenance"].includes(key)) ||
        typeof hold.plan_id_digest !== "string" || !/^[a-f0-9]{64}$/.test(hold.plan_id_digest) ||
        seen.has(hold.plan_id_digest) || !["held_residual", "held_unobserved", "held_unverified"].includes(String(hold.reason)) ||
        !provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
      throw new Error("plan_recovery_hold_state_invalid");
    }
    const evidenceProvenance = recoveryEvidenceProvenance({
      source: provenance.source,
      command_id_digest: provenance.command_id_digest,
      operation_digest: provenance.operation_digest,
      result_digest: provenance.result_digest,
      restore_store_key: provenance.restore_store_key,
      restore_backup_id_digest: provenance.restore_backup_id_digest,
      restore_scope_plan_digest: provenance.restore_scope_plan_digest,
      restore_scope_task_digest: provenance.restore_scope_task_digest,
      restore_scope_mode: provenance.restore_scope_mode,
      restore_task_identity_digest: provenance.restore_task_identity_digest,
      restore_task_plan_set_digest: provenance.restore_task_plan_set_digest,
      restore_task_dependency_status: provenance.restore_task_dependency_status,
      restored_state_digest: provenance.restored_state_digest,
    });
    if (Object.keys(provenance).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
      "restore_store_key", "restore_backup_id_digest", "restore_scope_plan_digest", "restore_scope_task_digest",
      "restore_scope_mode", "restore_task_identity_digest", "restore_task_plan_set_digest",
      "restore_task_dependency_status", "restored_state_digest", "checkpoint_digest"].includes(key)) ||
        typeof provenance.checkpoint_digest !== "string" || !/^[a-f0-9]{64}$/.test(provenance.checkpoint_digest)) {
      throw new Error("plan_recovery_hold_state_invalid");
    }
    const inferredRelation = recoveryScopeRelation(hold.plan_id_digest, evidenceProvenance.restore_scope_plan_digest);
    const relation = hold.restore_scope_relation === undefined ? inferredRelation : hold.restore_scope_relation;
    if (!["requested", "collateral", "unknown"].includes(String(relation)) ||
        (relation !== "unknown" && relation !== inferredRelation)) {
      throw new Error("plan_recovery_hold_state_invalid");
    }
    seen.add(hold.plan_id_digest);
    return { plan_id_digest: hold.plan_id_digest, reason: hold.reason as OperationPlanRecoveryHoldReason,
      restore_scope_relation: relation as OperationPlanRecoveryScopeRelation,
      provenance: { ...evidenceProvenance, checkpoint_digest: provenance.checkpoint_digest } };
  });
  return { schema_version: "operation-plan-recovery-holds.v1", holds,
    used_for_authority: false, may_execute: false };
}

function parseOperationPlanRecoveryEvidence(value: OperationPlanRecoveryEvidence): OperationPlanRecoveryEvidence {
  const raw = value as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["schema_version", "scope", "checkpoint_digest", "provenance", "plans", "used_for_authority", "may_execute"].includes(key)) ||
      raw.schema_version !== "operation-plan-recovery-evidence.v1" ||
      !["restored_operation_plans", "unverified_history"].includes(String(raw.scope)) ||
      typeof raw.checkpoint_digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.checkpoint_digest) ||
      raw.used_for_authority !== false || raw.may_execute !== false || !Array.isArray(raw.plans) || raw.plans.length > 256) {
    throw new Error("plan_recovery_evidence_invalid");
  }
  const provenance = raw.provenance === undefined ? undefined : recoveryEvidenceProvenance(raw.provenance);
  if (raw.scope === "restored_operation_plans" &&
       (provenance?.source !== "recovery_restore" ||
         (!provenance.restore_scope_plan_digest && !provenance.restore_scope_task_digest))) {
    throw new Error("plan_recovery_evidence_invalid");
  }
  const seen = new Set<string>();
  const plans = raw.plans.map((entry): OperationPlanRecoveryEvidence["plans"][number] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plan_recovery_evidence_invalid");
    const plan = entry as Record<string, unknown>;
    if (Object.keys(plan).some((key) => !["plan_id_digest", "task_identity_digest", "restore_scope_relation", "restore_membership", "integrity", "dependency_status"].includes(key)) ||
        typeof plan.plan_id_digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.plan_id_digest) || seen.has(plan.plan_id_digest) ||
        (plan.task_identity_digest !== undefined && (typeof plan.task_identity_digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.task_identity_digest))) ||
        (plan.restore_scope_relation !== undefined && !["requested", "collateral", "unknown"].includes(String(plan.restore_scope_relation))) ||
        !["restored", "not_restored", "unknown"].includes(String(plan.restore_membership)) ||
        !["verified", "residuals_present", "unverified"].includes(String(plan.integrity)) ||
        !["observed", "residuals_present", "unobserved", "unknown"].includes(String(plan.dependency_status))) {
      throw new Error("plan_recovery_evidence_invalid");
    }
    seen.add(plan.plan_id_digest);
    const inferredRelation = provenance?.restore_scope_mode === "task_scoped_merge_v1"
      ? plan.task_identity_digest === provenance.restore_scope_task_digest ? "requested" : "collateral"
      : recoveryScopeRelation(plan.plan_id_digest, provenance?.restore_scope_plan_digest ?? null);
    const relation = plan.restore_scope_relation === undefined ? inferredRelation : plan.restore_scope_relation;
    if (relation !== inferredRelation) throw new Error("plan_recovery_evidence_invalid");
    return { plan_id_digest: plan.plan_id_digest,
      ...(typeof plan.task_identity_digest === "string" ? { task_identity_digest: plan.task_identity_digest } : {}),
      restore_scope_relation: relation as OperationPlanRecoveryScopeRelation,
      restore_membership: plan.restore_membership as OperationPlanRecoveryEvidence["plans"][number]["restore_membership"],
      integrity: plan.integrity as OperationPlanRecoveryEvidence["plans"][number]["integrity"],
      dependency_status: plan.dependency_status as OperationPlanRecoveryEvidence["plans"][number]["dependency_status"] };
  });
  if (raw.scope === "unverified_history" && plans.length !== 0) throw new Error("plan_recovery_evidence_invalid");
  if (provenance?.restore_scope_mode === "plan_scoped_merge_v1") {
    const scopeDigest = provenance.restore_scope_plan_digest;
    const requested = plans.filter((plan) => plan.plan_id_digest === scopeDigest);
    if (raw.scope !== "restored_operation_plans" || provenance.restore_store_key !== "operation_plans" ||
        !scopeDigest || requested.length !== 1 ||
        plans.some((plan) => plan.plan_id_digest !== scopeDigest && plan.restore_membership !== "not_restored")) {
      throw new Error("plan_recovery_evidence_invalid");
    }
  }
  if (provenance?.restore_scope_mode === "task_scoped_merge_v1") {
    const taskDigest = provenance.restore_scope_task_digest;
    const requested = plans.filter((plan) => plan.task_identity_digest === taskDigest);
    if (raw.scope !== "restored_operation_plans" || provenance.restore_store_key !== "operation_plans" ||
        provenance.restore_scope_plan_digest !== null || !taskDigest || requested.length === 0 ||
        plans.some((plan) => plan.task_identity_digest !== taskDigest && plan.restore_membership !== "not_restored") ||
        requested.some((plan) => plan.restore_membership === "not_restored")) {
      throw new Error("plan_recovery_evidence_invalid");
    }
  }
  return { schema_version: "operation-plan-recovery-evidence.v1", scope: raw.scope as OperationPlanRecoveryEvidence["scope"],
    checkpoint_digest: raw.checkpoint_digest,
    ...(provenance === undefined ? {} : { provenance }),
    plans, used_for_authority: false, may_execute: false };
}

function parseOperationPlanBrokerRestoreDependencyEvidence(
  value: OperationPlanBrokerRestoreDependencyEvidence,
): OperationPlanBrokerRestoreDependencyEvidence {
  const raw = value as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["schema_version", "checkpoint_digest", "restore_observation", "provenance", "plans",
        "used_for_authority", "may_execute"].includes(key)) ||
      raw.schema_version !== "operation-plan-broker-restore-dependency-evidence.v1" ||
      typeof raw.checkpoint_digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.checkpoint_digest) ||
      !["verified", "unverified"].includes(String(raw.restore_observation)) ||
      raw.used_for_authority !== false || raw.may_execute !== false || !Array.isArray(raw.plans) || raw.plans.length > 256) {
    throw new Error("plan_broker_restore_evidence_invalid");
  }
  const provenance = recoveryEvidenceProvenance(raw.provenance);
  const taskScopedRestore = provenance.restore_scope_mode === "task_scoped_merge_v1" &&
    !!provenance.restore_scope_task_digest;
  if (provenance.source !== "recovery_restore" || provenance.restore_store_key !== "broker" ||
        provenance.restore_scope_plan_digest !== null ||
        (taskScopedRestore ? !provenance.restore_scope_task_digest :
          provenance.restore_scope_task_digest !== null || provenance.restore_scope_mode !== undefined) ||
      (raw.restore_observation === "verified" &&
        (!provenance.command_id_digest || !provenance.operation_digest || !provenance.result_digest ||
          !provenance.restore_backup_id_digest || !provenance.restored_state_digest))) {
    throw new Error("plan_broker_restore_evidence_invalid");
  }
  const seen = new Set<string>();
  const plans = raw.plans.map((entry): OperationPlanBrokerRestoreDependencyEvidence["plans"][number] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plan_broker_restore_evidence_invalid");
    const plan = entry as Record<string, unknown>;
    if (Object.keys(plan).some((key) => !["plan_id_digest", "status"].includes(key)) ||
        typeof plan.plan_id_digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.plan_id_digest) ||
        seen.has(plan.plan_id_digest) ||
        !["unaffected", "observed", "residuals_present", "unobserved", "unverified"].includes(String(plan.status))) {
      throw new Error("plan_broker_restore_evidence_invalid");
    }
    seen.add(plan.plan_id_digest);
    return { plan_id_digest: plan.plan_id_digest,
      status: plan.status as OperationPlanBrokerRestoreDependencyStatus };
  });
  if (raw.restore_observation === "unverified" && plans.some((plan) =>
      plan.status !== "unverified" && !(taskScopedRestore && plan.status === "unaffected"))) {
    throw new Error("plan_broker_restore_evidence_invalid");
  }
  return {
    schema_version: "operation-plan-broker-restore-dependency-evidence.v1",
    checkpoint_digest: raw.checkpoint_digest,
    restore_observation: raw.restore_observation as OperationPlanBrokerRestoreDependencyEvidence["restore_observation"],
    provenance,
    plans,
    used_for_authority: false,
    may_execute: false,
  };
}

export interface OperationPlanReceiptReconciliationAuthorization {
  readonly authorization_id: string;
  readonly caller_user: string;
  readonly caller_channel: string;
  readonly plan_id_digest: string;
  readonly revision_digest: string;
  readonly step_id_digest: string;
  readonly command_id: string;
  readonly command_digest: string;
  readonly executor_command_digest: string;
  readonly command_key: string;
  readonly execution_epoch: string;
  readonly task_identity_digest?: string;
  readonly operation: string;
  readonly parameters: Record<string, unknown>;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

export interface OperationPlanOwnerSelectedFileStateObservationAuthorization {
  readonly authorization_id: string;
  readonly caller_user: string;
  readonly caller_channel: string;
  readonly plan_id_digest: string;
  readonly revision_digest: string;
  readonly step_id_digest: string;
  readonly command_id: string;
  readonly command_digest: string;
  readonly executor_command_digest: string;
  readonly command_key: string;
  readonly execution_epoch: string;
  readonly task_identity_digest?: string;
  readonly parameters: Record<string, unknown>;
  readonly expected_gateway_receipt_evidence: OperationPlanGatewayReceiptRecheckEvidence;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

export type OperationPlanGatewayReceiptRechecker = (
  command_key: string,
  expected_evidence: OperationPlanGatewayReceiptRecheckEvidence,
) => OperationPlanGatewayReceiptRecheckEvidence | null;

export interface OperationPlanOwnerLocalFileStateReceiptRecheckLookup {
  readonly command_key: string;
  readonly expected_evidence: OperationPlanGatewayReceiptRecheckEvidence;
}

export function operationPlanDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function gatewayExecutionReceiptEvidenceDigest(observation: OperationPlanExternalReceiptObservation): string {
  return operationPlanDigest({
    schema_version: "gateway-execution-receipt-evidence.v1",
    command_key_digest: observation.command_key_digest,
    command_digest: observation.executor_command_digest,
    execution_epoch_digest: observation.gateway_execution_epoch_digest,
    task_identity_digest: observation.gateway_task_identity_digest ?? null,
    state: observation.gateway_execution_receipt_state,
    feedback_status: observation.gateway_execution_feedback_status ?? null,
    result_delivery_digest: observation.gateway_result_delivery_digest ?? null,
    result_delivery_acknowledged: observation.gateway_result_delivery_acknowledged ?? null,
    used_for_authority: false,
  });
}

function canonicalExecutorCommandDigest(command: ExecuteCommand): string {
  return createHash("sha256").update(canonicalExecutorCommandBytes(command)).digest("hex");
}

function matchesCanonicalExecutorCommandDigest(command: ExecuteCommand, expected: string | undefined): boolean {
  if (!expected) return false;
  try { return canonicalExecutorCommandDigest(command) === expected; }
  catch { return false; }
}

export type OperationPlanGoalPurposeRelationOwnerReviewDraft = Omit<OperationPlanGoalPurposeRelationOwnerReview, "audit_event_digest">;

export function operationPlanGoalPurposeRelationReviewAuditDigest(
  args: OperationPlanGoalPurposeRelationReviewArguments,
  review: OperationPlanGoalPurposeRelationOwnerReviewDraft,
): string {
  return operationPlanDigest({
    schema_version: "operation-plan-goal-purpose-relation-review.v1",
    ...args,
    ...review,
  });
}
function recoveryCommandIdDigest(commandId: string): string {
  // Match Recovery history and Cron handoff identity: hash the raw command ID bytes.
  return createHash("sha256").update(commandId).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function stepDigest(step: OperationStep): string {
  const { state: _state, result_digest: _result, ...definition } = step;
  return operationPlanDigest(definition);
}
function commandPayloadDigest(command: ExecuteCommand): string {
  return createHash("sha256").update(JSON.stringify(command.payload)).digest("hex");
}
function freezeCommand(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeCommand((value as Record<PropertyKey, unknown>)[key], seen);
  if (!Object.isFrozen(value)) Object.freeze(value);
}
function candidatePlan(value: unknown): OperationPlan {
  const plan = OperationPlanSchema.parse(value);
  if (!["planned", "draft"].includes(plan.state) || plan.steps.some((s) =>
    !["planned", "draft"].includes(s.state) || s.result_digest !== undefined)) throw new Error("plan_claimed_execution_state");
  const inspected = prepareOperationPlan(plan, { now_ms: Date.now(), results: [], observations: [] });
  if (inspected.kind === "rejected") throw new Error(`plan_${inspected.code}`);
  return plan;
}

function validateOperationPlanCheckpoint(value: unknown, memoryAvailable: boolean): OperationPlanCheckpoint {
  const state = OperationPlanCheckpointSchema.parse(value);
  const ids = new Set<string>();
  const commands = new Set<string>();
  const tickets = new Set<string>();
  for (const p of state.plans) {
    const first = p.revisions[0]!.plan;
    if (ids.has(first.plan_id)) throw new Error("plan_checkpoint_duplicate_identity");
    ids.add(first.plan_id);
    if (p.request_goal_criteria && (p.request_goal_criteria.request_id !== first.request_id ||
        p.request_goal_criteria.content_sha256 !== createHash("sha256").update(p.goal, "utf8").digest("hex"))) {
      throw new Error("plan_checkpoint_goal_criteria_source_mismatch");
    }
    for (const revision of p.revisions) {
      candidatePlan(revision.plan);
      if (revision.digest !== operationPlanDigest(revision.plan) || revision.plan.plan_id !== first.plan_id ||
          revision.plan.request_id !== first.request_id) throw new Error("plan_checkpoint_revision_mismatch");
    }
    for (const b of p.bindings) {
      const revision = p.revisions.find((r) => r.digest === b.revision_digest);
      const step = revision?.plan.steps.find((s) => s.step_id === b.step_id);
      if (!step || stepDigest(step) !== b.step_digest || commands.has(b.command_id) ||
          b.prepared_step.step_id !== b.step_id || b.prepared_step.operation !== b.operation ||
          b.prepared_step.operation !== step.operation) throw new Error("plan_checkpoint_binding_mismatch");
      commands.add(b.command_id);
      if (b.execution_admission) {
        if (tickets.has(b.execution_admission.ticket_id) || b.execution_admission.command_key !==
            createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", b.command_id])).digest("hex") ||
            (b.executor_command_digest !== undefined && b.execution_admission.command_digest !== b.executor_command_digest) ||
            b.status === "selected" || b.status === "invalidated") throw new Error("plan_checkpoint_admission_mismatch");
        tickets.add(b.execution_admission.ticket_id);
      }
      if (b.delivery_digest && (!b.execution_admission || !b.result_digest)) throw new Error("plan_checkpoint_delivery_mismatch");
      if (b.memory_commit && (!memoryAvailable || !verifyResultMemoryCommit(p, b))) throw new Error("plan_checkpoint_memory_mismatch");
      if (b.memory_receipt && (!b.memory_commit || !receiptForResultCommit(b.memory_receipt, b.memory_commit))) {
        throw new Error("plan_checkpoint_memory_receipt_mismatch");
      }
    }
    const receiptObservationDigests = new Set<string>();
    for (const observation of p.receipt_observations) {
      const { evidence_digest, observed_at_ms, ...evidence } = observation;
      if (receiptObservationDigests.has(evidence_digest) || operationPlanDigest(evidence) !== evidence_digest ||
          observation.plan_id_digest !== operationPlanDigest(first.plan_id)) {
        throw new Error("plan_checkpoint_receipt_observation_integrity_mismatch");
      }
      receiptObservationDigests.add(evidence_digest);
      const revision = p.revisions.find((entry) => entry.digest === observation.revision_digest);
      const step = revision?.plan.steps.find((entry) => operationPlanDigest(entry.step_id) === observation.step_id_digest);
      const binding = step ? p.bindings.filter((entry) => entry.step_id === step.step_id &&
        entry.revision_digest === observation.revision_digest).at(-1) : undefined;
      if (!revision || !step || !binding || stepDigest(step) !== binding.step_digest ||
          binding.status !== "outcome_unknown" || !binding.execution_admission ||
          binding.command_digest !== observation.command_digest ||
          binding.execution_admission.command_digest !== observation.executor_command_digest ||
          observation.command_key_digest !== createHash("sha256").update(binding.execution_admission.command_key, "utf8").digest("hex") ||
          observed_at_ms < binding.execution_admission.issued_at_ms) {
        throw new Error("plan_checkpoint_receipt_observation_binding_mismatch");
      }
      if (observation.source === "local_file_state" && (step.operation !== "file.write" || step.parameters?.mode !== "create" ||
          typeof step.parameters.path !== "string" || typeof step.parameters.content !== "string" ||
          observation.target_identity_digest !== fileWriteTargetIdentityDigest(step.parameters.path) ||
          observation.request_payload_digest !== fileWritePayloadDigest(step.parameters.content))) {
        throw new Error("plan_checkpoint_file_state_observation_binding_mismatch");
      }
      if (observation.source === "local_inspection" && (step.operation !== "gmail.write" || step.parameters?.operation !== "message.send")) {
        throw new Error("plan_checkpoint_external_receipt_observation_operation_mismatch");
      }
    }
    const receiptMemoryDigests = new Set<string>();
    for (const delivery of p.receipt_memory ?? []) {
      const observations = p.receipt_observations.filter((entry) => entry.evidence_digest === delivery.evidence_digest);
      if (receiptMemoryDigests.has(delivery.evidence_digest) || observations.length !== 1 ||
          (delivery.memory_commit && (!memoryAvailable || !verifyReceiptMemoryCommit(observations[0]!, delivery))) ||
          (delivery.memory_receipt && (!delivery.memory_commit ||
            !receiptForReceiptMemoryCommit(delivery.memory_receipt, delivery.memory_commit)))) {
        throw new Error("plan_checkpoint_receipt_memory_mismatch");
      }
      receiptMemoryDigests.add(delivery.evidence_digest);
    }
    for (const result of p.results) {
      const binding = p.bindings.find((b) => b.step_id === result.step_id && b.status === "verified");
      if (!binding || result.plan_id !== first.plan_id || result.request_id !== first.request_id ||
          result.operation !== binding.operation || result.expires_at_ms !== result.observed_at_ms + 600_000 ||
          operationPlanDigest(result.target) !== operationPlanDigest(binding.prepared_step.target) ||
          !binding.prepared_step.preparation?.validation.length ||
          !binding.prepared_step.preparation.validation.every((v) => v.method === "result_equals" &&
            operationPlanDigest(v.target) === operationPlanDigest(result.target) &&
            operationPlanDigest(v.expected) === operationPlanDigest(result.output))) throw new Error("plan_checkpoint_result_mismatch");
    }
  }
  const shellResultCommands = new Set<string>();
  for (const observation of state.shell_exec_result_observations ?? []) {
    if (shellResultCommands.has(observation.command_id_digest) ||
        (observation.memory_commit && (!memoryAvailable || !verifyShellExecResultMemoryCommit(observation))) ||
        (observation.memory_receipt && (!observation.memory_commit ||
          !receiptForResultCommit(observation.memory_receipt, observation.memory_commit)))) {
      throw new Error("plan_checkpoint_shell_result_observation_mismatch");
    }
    shellResultCommands.add(observation.command_id_digest);
  }
  return state;
}

export interface OperationPlanCheckpointRuntimePartition {
  readonly checkpoint: OperationPlanCheckpoint;
  readonly quarantined_plan_indices: readonly number[];
  readonly quarantined_wait_indices: readonly number[];
  readonly quarantined_plans: readonly {
    readonly index: number;
    readonly plan_id_digest: string | null;
    readonly record_digest: string;
    readonly schema_valid: boolean;
  }[];
}

function isCheckpointRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkpointPlanId(value: unknown): string | null {
  if (!isCheckpointRecord(value) || !Array.isArray(value.revisions)) return null;
  const firstRevision = value.revisions[0];
  if (!isCheckpointRecord(firstRevision) || !isCheckpointRecord(firstRevision.plan)) return null;
  const planId = firstRevision.plan.plan_id;
  return typeof planId === "string" && planId.length > 0 && planId.length <= 200 ? planId : null;
}

/** Schema-invalid plan identities are exposed only as digests, never as raw plan content. */
export function operationPlanCheckpointPlanIdDigest(value: unknown): string | null {
  const planId = checkpointPlanId(value);
  return planId === null ? null : operationPlanDigest(planId);
}

function recordRawPlanIdentityOwners(
  value: unknown,
  index: number,
  planOwners: Map<string, number[]>,
  commandOwners: Map<string, number[]>,
  ticketOwners: Map<string, number[]>,
): void {
  const recordOwner = (owners: Map<string, number[]>, id: string) => {
    owners.set(id, [...(owners.get(id) ?? []), index]);
  };
  const planId = checkpointPlanId(value);
  if (planId !== null) recordOwner(planOwners, planId);
  if (!isCheckpointRecord(value) || !Array.isArray(value.bindings)) return;
  for (const binding of value.bindings) {
    if (!isCheckpointRecord(binding)) continue;
    if (typeof binding.command_id === "string" && binding.command_id.length > 0 && binding.command_id.length <= 200) {
      recordOwner(commandOwners, binding.command_id);
    }
    const admission = binding.execution_admission;
    if (isCheckpointRecord(admission) && typeof admission.ticket_id === "string" &&
        admission.ticket_id.length > 0 && admission.ticket_id.length <= 200) {
      recordOwner(ticketOwners, admission.ticket_id);
    }
  }
}

/** Isolate an invalid plan record after envelope integrity and shared-state schema checks. */
export function partitionOperationPlanCheckpointForRuntime(
  value: unknown,
  memoryAvailable: boolean,
): OperationPlanCheckpointRuntimePartition {
  const envelope = OperationPlanCheckpointEnvelopeSchema.parse(value);
  const state = OperationPlanCheckpointSchema.parse({ ...envelope, plans: [] });
  const rawPlans = envelope.plans;
  const validPlans: { readonly index: number; readonly plan: OperationPlanCheckpoint["plans"][number] }[] = [];
  const schemaInvalidPlanIndices = new Set<number>();
  for (const [index, rawPlan] of rawPlans.entries()) {
    const parsed = OperationPlanCheckpointPlanSchema.safeParse(rawPlan);
    if (parsed.success) validPlans.push({ index, plan: parsed.data });
    else schemaInvalidPlanIndices.add(index);
  }

  const quarantinedPlans = new Set<number>();
  const planOwners = new Map<string, number[]>();
  const commandOwners = new Map<string, number[]>();
  const ticketOwners = new Map<string, number[]>();
  const waitOwners = new Map<string, number[]>();
  const waitCounts = new Map<string, number>();

  const quarantineDuplicateOwners = (owners: Map<string, number[]>) => {
    for (const indexes of owners.values()) {
      if (indexes.length > 1) for (const index of indexes) quarantinedPlans.add(index);
    }
  };

  for (const index of schemaInvalidPlanIndices) quarantinedPlans.add(index);
  rawPlans.forEach((plan, index) => recordRawPlanIdentityOwners(
    plan, index, planOwners, commandOwners, ticketOwners,
  ));
  quarantineDuplicateOwners(planOwners);
  quarantineDuplicateOwners(commandOwners);
  quarantineDuplicateOwners(ticketOwners);

  for (const { index, plan } of validPlans) {
    if (quarantinedPlans.has(index)) continue;
    try {
      const planIdDigest = operationPlanDigest(plan.revisions[0]!.plan.plan_id);
      validateOperationPlanCheckpoint({ ...state, plans: [plan],
        ...(state.waits === undefined ? {} : { waits: state.waits.filter((wait) => wait.plan_id_digest === planIdDigest) }),
      }, memoryAvailable);
    } catch {
      quarantinedPlans.add(index);
    }
  }

  const planIndexesByDigest = new Map<string, number[]>();
  for (const [index, plan] of rawPlans.entries()) {
    const planId = checkpointPlanId(plan);
    if (planId === null) continue;
    const digest = operationPlanDigest(planId);
    planIndexesByDigest.set(digest, [...(planIndexesByDigest.get(digest) ?? []), index]);
  }
  if (state.waits) {
    for (const wait of state.waits) {
      waitCounts.set(wait.wait_id, (waitCounts.get(wait.wait_id) ?? 0) + 1);
      const planIndexes = planIndexesByDigest.get(wait.plan_id_digest) ?? [];
      if (planIndexes.length === 1) {
        waitOwners.set(wait.wait_id, [...(waitOwners.get(wait.wait_id) ?? []), planIndexes[0]!]);
      }
      else if (planIndexes.length > 1) for (const planIndex of planIndexes) quarantinedPlans.add(planIndex);
    }
    for (const [waitId, count] of waitCounts) {
      if (count > 1) for (const index of waitOwners.get(waitId) ?? []) quarantinedPlans.add(index);
    }
  }

  const validPlansByIndex = new Map(validPlans.map(({ index, plan }) => [index, plan] as const));
  const cleanPlanIndices = validPlans.map(({ index }) => index).filter((index) => !quarantinedPlans.has(index));
  const cleanPlanDigests = new Set(cleanPlanIndices.map((index) =>
    operationPlanDigest(validPlansByIndex.get(index)!.revisions[0]!.plan.plan_id)));
  const cleanWaitIndices = (state.waits ?? []).map((_wait, index) => index).filter((index) => {
    const wait = state.waits![index]!;
    const owners = planIndexesByDigest.get(wait.plan_id_digest) ?? [];
    return owners.length === 1 && !quarantinedPlans.has(owners[0]!) && cleanPlanDigests.has(wait.plan_id_digest) &&
      waitCounts.get(wait.wait_id) === 1;
  });
  const cleanWaitSet = new Set(cleanWaitIndices);
  const cleanCheckpoint = OperationPlanCheckpointSchema.parse({
    ...state,
    plans: cleanPlanIndices.map((index) => validPlansByIndex.get(index)!),
    ...(state.waits === undefined ? {} : { waits: state.waits.filter((_wait, index) => cleanWaitSet.has(index)) }),
  });

  // plan別残差の隔離後にcheckpoint共有状態を再検査し、共有破損は全体fail-closedにする。
  const checked = validateOperationPlanCheckpoint(cleanCheckpoint, memoryAvailable);
  const quarantinedPlanIndices = [...quarantinedPlans].sort((a, b) => a - b);
  return {
    checkpoint: checked,
    quarantined_plan_indices: quarantinedPlanIndices,
    quarantined_wait_indices: (state.waits ?? []).map((_wait, index) => index).filter((index) => !cleanWaitSet.has(index)),
    quarantined_plans: quarantinedPlanIndices.map((index) => ({
      index,
      plan_id_digest: operationPlanCheckpointPlanIdDigest(rawPlans[index]),
      record_digest: operationPlanDigest(rawPlans[index]),
      schema_valid: !schemaInvalidPlanIndices.has(index),
    })),
  };
}

/** A plan step may bind only when its declared target and bounded arguments match a wired adapter. */
function hasConnectedPlanTarget(step: OperationStep): boolean {
  const parameters = step.parameters;
  if (step.operation === "file.search") {
    return step.target.kind === "directory" && step.target.id.length > 0 &&
      parameters?.root === step.target.id;
  }
  if (step.operation === "file.write") {
    if (step.adapter !== "internal_runtime" || step.target.kind !== "file" || !parameters ||
        typeof parameters.path !== "string" || parameters.path.length === 0 || parameters.path.length > 512 ||
        parameters.path !== step.target.id || parameters.path.startsWith("/") || parameters.path.includes("\\") ||
        parameters.path.includes(":") || parameters.path.includes("\0") ||
        parameters.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        typeof parameters.content !== "string" || Buffer.byteLength(parameters.content, "utf8") > 1_000_000 ||
        parameters.mode !== "create") return false;
    const maxBytes = parameters.max_bytes ?? 256_000;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000 ||
        Buffer.byteLength(parameters.content, "utf8") > maxBytes) return false;
    return Object.keys(parameters).every((key) => ["path", "content", "mode", "max_bytes"].includes(key));
  }
  if (step.operation === "file.delete") {
    if (step.adapter !== "internal_runtime" || step.target.kind !== "file" || !parameters ||
        typeof parameters.path !== "string" || parameters.path.length === 0 || parameters.path.length > 512 ||
        parameters.path !== step.target.id || parameters.path.startsWith("/") || parameters.path.includes("\\") ||
        parameters.path.includes(":") || parameters.path.includes("\0") ||
        parameters.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        step.effects.length !== 1 || step.effects[0] !== "delete" ||
        step.permission.risk !== "high" || step.permission.approval_level !== "L3_final_review" ||
        !step.permission.final_review_required || !step.permission.approval_gate_required ||
        !step.permission.hds_brain_authority_required) return false;
    const maxBytes = parameters.max_bytes ?? 256_000;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) return false;
    return Object.keys(parameters).every((key) => ["path", "max_bytes"].includes(key));
  }
  if (step.operation === "file.edit") {
    if (step.adapter !== "internal_runtime" || step.target.kind !== "file" || !parameters ||
        typeof parameters.path !== "string" || parameters.path.length === 0 || parameters.path.length > 512 ||
        parameters.path !== step.target.id || parameters.path.startsWith("/") || parameters.path.includes("\\") ||
        parameters.path.includes(":") || parameters.path.includes("\0") ||
        parameters.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        typeof parameters.search !== "string" || parameters.search.length === 0 ||
        typeof parameters.replace !== "string" || parameters.search === parameters.replace ||
        Buffer.byteLength(parameters.search, "utf8") > 1_000_000 || Buffer.byteLength(parameters.replace, "utf8") > 1_000_000 ||
        step.effects.length !== 2 || step.effects[0] !== "read" || step.effects[1] !== "write" ||
        step.permission.risk !== "medium" || step.permission.approval_level !== "L3_final_review" ||
        !step.permission.final_review_required || !step.permission.approval_gate_required ||
        !step.permission.hds_brain_authority_required) return false;
    const expectedReplacements = parameters.expected_replacements ?? 1;
    const maxBytes = parameters.max_bytes ?? 512_000;
    if (typeof expectedReplacements !== "number" || !Number.isInteger(expectedReplacements) ||
        expectedReplacements < 1 || expectedReplacements > 100 || typeof maxBytes !== "number" ||
        !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) return false;
    return Object.keys(parameters).every((key) =>
      ["path", "search", "replace", "expected_replacements", "max_bytes"].includes(key));
  }
  if (step.operation !== "gmail.write" || step.adapter !== "external_api" ||
      step.target.kind !== "external_service" || step.target.id !== "gmail" || !parameters) return false;
  if (parameters.operation === "draft.send") {
    return typeof parameters.draft_id === "string" && parameters.draft_id.trim().length > 0 &&
      parameters.draft_id.trim() === parameters.draft_id &&
      parameters.draft_id.length <= 256 && !/[\r\n]/.test(parameters.draft_id) &&
      Object.keys(parameters).every((key) => ["operation", "draft_id"].includes(key));
  }
  if ((parameters.operation !== "message.send" && parameters.operation !== "draft.create") || typeof parameters.to !== "string" ||
      parameters.to.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(parameters.to) ||
      typeof parameters.subject !== "string" || parameters.subject.trim().length === 0 ||
      parameters.subject.length > 200 || /[\r\n]/.test(parameters.subject) ||
      typeof parameters.body_text !== "string" || parameters.body_text.length > 64_000) return false;
  return Object.keys(parameters).every((key) => ["operation", "to", "subject", "body_text"].includes(key));
}

/** J所有の計画・版・単回試行。LLM、I/O作用、Approvalの代行は行わない。 */
export class OperationPlanLedger {
  private state: OperationPlanCheckpoint = { schema_version: "operation-plan-state.v1", plans: [], shell_exec_result_observations: [] };
  private savedDigest: string | null = null;
  private readonly issuedBindings = new WeakMap<ExecuteCommand, string>();
  private readonly issuedBindingIds = new Set<string>();
  private readonly activePlanAttempts = new Set<string>();
  private readonly memoryStorage?: OperationPlanMemoryStorage;
  private resultMemory?: JMemoryCommitCoordinator;
  private gatewayReceiptRechecker?: OperationPlanGatewayReceiptRechecker;
  private memoryQuiesced = false;
  private memoryReady = true;
  private readonly reflections = new Map<string, { command_digest: string; control: OperationPlanReflectionControl;
    caller: InboundRequest; projection_digest: string }>();
  private readonly savedResultReturns = new Map<string, { command_digest: string; control: OperationPlanResultReturnControl;
    caller: InboundRequest; projection_digest: string }>();
  private readonly receiptReconciliations = new Map<string, {
    command_digest: string;
    caller_user: string;
    caller_channel: string;
    control: OperationPlanReceiptReconciliationControl;
    authorization: OperationPlanReceiptReconciliationAuthorization;
  }>();
  private readonly ownerSelectedFileStateObservations = new Map<string, OperationPlanOwnerSelectedFileStateObservationAuthorization>();
  private readonly recoveryHolds = new Map<string, {
    reason: OperationPlanRecoveryHoldReason;
    restore_scope_relation: OperationPlanRecoveryScopeRelation;
    provenance: OperationPlanRecoveryHoldProvenance;
  }>();
  private recoveryRefreshPending = false;
  constructor(private readonly port?: OperationPlanStatePort, memoryStorage?: OperationPlanMemoryStorage,
    recoveryEvidence?: OperationPlanRecoveryEvidence,
    private readonly goalGovernanceReader?: () => ReadonlyGoalGovernanceProjection | undefined,
    private readonly goalPurposeContentReader?: (goalRef: string, version: number) => OperationPlanGoalPurposeContent | null | undefined,
    private readonly goalPurposeRelationReviewVerifier?: OperationPlanGoalPurposeRelationReviewVerifier,
    private readonly memoryInterpretationReader?: (lineageId: string) => MemoryInterpretationReviewSnapshot | null | undefined,
    private readonly memoryCitationJudgmentVerifier?: (dependency: OperationPlanMemoryInterpretationDependency) => boolean,
    brokerRestoreEvidence?: OperationPlanBrokerRestoreDependencyEvidence,
    private readonly brokerRestoreDependencyVerifier?: OperationPlanBrokerRestoreDependencyVerifier,
    private readonly meaningUpdateMemoryRestoreVerifier?: () => boolean) {
    if (memoryStorage && !port) throw new Error("plan_memory_requires_durable_j_state");
    this.memoryStorage = memoryStorage;
    const checkedRecoveryEvidence = recoveryEvidence ? parseOperationPlanRecoveryEvidence(recoveryEvidence) : undefined;
    const checkedBrokerRestoreEvidence = brokerRestoreEvidence
      ? parseOperationPlanBrokerRestoreDependencyEvidence(brokerRestoreEvidence) : undefined;
    let loadedCheckpointDigest: string | null = null;
    const saved = port?.load(Boolean(memoryStorage));
    if (saved != null) {
    this.state = validateOperationPlanCheckpoint(saved, Boolean(memoryStorage));
    this.savedDigest = operationPlanDigest(this.state);
    loadedCheckpointDigest = this.savedDigest;
    // 過去の承認は復活させない。開始意思があれば未起動と断定しない。
    this.change((state) => {
      for (const p of state.plans) for (const b of p.bindings) {
        if (b.status === "selected") b.status = "invalidated";
        if (b.status === "intent_committed") b.status = "outcome_unknown";
      }
    });
    }
    if (memoryStorage) this.resultMemory = new JMemoryCommitCoordinator({ ...memoryStorage,
      j_approval_reader: { readVerifiedMemoryApproval: (ref) => this.readResultMemoryApproval(ref) } });
    let persistedRecoveryHoldState: OperationPlanRecoveryHoldState | null = null;
    const persistedRecoveryHoldStateRaw = port?.loadRecoveryHoldState();
    if (persistedRecoveryHoldStateRaw !== null && persistedRecoveryHoldStateRaw !== undefined) {
      persistedRecoveryHoldState = parseOperationPlanRecoveryHoldState(persistedRecoveryHoldStateRaw);
      for (const hold of persistedRecoveryHoldState.holds) this.recoveryHolds.set(hold.plan_id_digest,
        { reason: hold.reason, restore_scope_relation: hold.restore_scope_relation, provenance: hold.provenance });
    }
    if (checkedRecoveryEvidence) {
      if (!persistedRecoveryHoldState && this.state.plans.length > 0) {
        // Legacy volatile holds have no durable record. On upgrade, preserve the
        // possibility that an earlier restore created one rather than trusting a
        // startup observation to release it.
        const provenance = this.provenanceForEvidence(checkedRecoveryEvidence);
        for (const plan of this.state.plans) this.addRecoveryHold(
          operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", provenance);
      } else {
        this.applyRecoveryEvidence(checkedRecoveryEvidence,
          checkedRecoveryEvidence.checkpoint_digest === loadedCheckpointDigest);
      }
      if (this.recoveryHolds.size > 0) this.persistRecoveryHoldState();
    }
    if (checkedBrokerRestoreEvidence) {
      this.applyBrokerRestoreDependencyEvidence(checkedBrokerRestoreEvidence,
        checkedBrokerRestoreEvidence.checkpoint_digest === loadedCheckpointDigest);
      if (this.recoveryHolds.size > 0) this.persistRecoveryHoldState();
    }
    const holdStateBeforeTaskPropagation = operationPlanDigest([...this.recoveryHolds.entries()]);
    this.propagateBrokerRestoreHoldsAcrossTaskLineage();
    if (operationPlanDigest([...this.recoveryHolds.entries()]) !== holdStateBeforeTaskPropagation) {
      this.persistRecoveryHoldState();
    }
  }

  setGatewayReceiptRechecker(rechecker: OperationPlanGatewayReceiptRechecker): void {
    if (this.gatewayReceiptRechecker) throw new Error("gateway_execution_receipt_rechecker_already_configured");
    this.gatewayReceiptRechecker = rechecker;
  }

  beginRecoveryRefresh(): boolean {
    if (!this.port || this.recoveryRefreshPending || this.activePlanAttempts.size > 0) return false;
    this.recoveryRefreshPending = true;
    return true;
  }

  /** Validate a bounded, explicit J wait request without changing plan or execution authority. */
  inspectWait(control: Extract<OperationPlanControl, { action: "wait" }>, caller: InboundRequest, nowMs = Date.now()): {
    readonly wait_id: string;
    readonly plan_id_digest: string;
    readonly task_identity_digest: string;
    readonly revision_digest: string;
    readonly deadline_at_ms: number;
    readonly goal: string;
  } {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    if (!this.port) throw new Error("plan_wait_state_not_durable");
    const plan = this.ownedPlan(control.plan_id, caller);
    const current = plan.revisions.at(-1)!;
    if (control.revision_digest !== current.digest) throw new Error("plan_revision_changed");
    if (!Number.isSafeInteger(control.deadline_at_ms) || control.deadline_at_ms <= nowMs) {
      throw new Error("plan_wait_deadline_invalid");
    }
    if (plan.bindings.some((binding) => ["selected", "intent_committed", "outcome_unknown"].includes(binding.status))) {
      throw new Error("plan_wait_execution_unresolved");
    }
    const planIdDigest = operationPlanDigest(current.plan.plan_id);
    const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
    const sessionScope = caller.session_id ?? `${caller.channel}:${caller.user}`;
    const sessionIdDigest = operationPlanDigest({ schema_version: "operation-plan-wait-session.v1", session_scope: sessionScope });
    const waitId = operationPlanDigest({ schema_version: "operation-plan-wait.v1", plan_id_digest: planIdDigest,
      task_identity_digest: taskIdentityDigest, revision_digest: current.digest, owner_digest: operationPlanDigest(plan.owner),
      channel_digest: operationPlanDigest(plan.channel), session_id_digest: sessionIdDigest,
      deadline_at_ms: control.deadline_at_ms });
    if ((this.state.waits ?? []).some((wait) => wait.state === "waiting" &&
        (wait.wait_id === waitId || wait.task_identity_digest === taskIdentityDigest))) {
      throw new Error("plan_wait_already_active");
    }
    return { wait_id: waitId, plan_id_digest: planIdDigest, task_identity_digest: taskIdentityDigest,
      revision_digest: current.digest, deadline_at_ms: control.deadline_at_ms, goal: plan.goal };
  }

  /** Persist one J-owned wait state against the exact current plan revision. */
  registerWait(control: Extract<OperationPlanControl, { action: "wait" }>, caller: InboundRequest,
    nowMs = Date.now()): OperationPlanWaitState {
    const inspected = this.inspectWait(control, caller, nowMs);
    const plan = this.ownedPlan(control.plan_id, caller);
    const sessionScope = caller.session_id ?? `${caller.channel}:${caller.user}`;
    const wait = OperationPlanWaitStateSchema.parse({
      wait_id: inspected.wait_id,
      plan_id_digest: inspected.plan_id_digest,
      task_identity_digest: inspected.task_identity_digest,
      revision_digest: inspected.revision_digest,
      owner_digest: operationPlanDigest(plan.owner),
      channel_digest: operationPlanDigest(plan.channel),
      session_id_digest: operationPlanDigest({ schema_version: "operation-plan-wait-session.v1", session_scope: sessionScope }),
      deadline_at_ms: inspected.deadline_at_ms,
      created_at_ms: nowMs,
      state: "waiting",
      used_for_authority: false,
      may_execute: false,
    });
    this.change((state) => { state.waits = [...(state.waits ?? []), wait]; });
    return structuredClone(wait);
  }

  /** One unambiguous inbound event can wake a wait in its owner/channel session. */
  matchWaitForInbound(caller: InboundRequest, nowMs = Date.now()): OperationPlanWaitState | null {
    const sessionScope = caller.session_id ?? `${caller.channel}:${caller.user}`;
    const ownerDigest = operationPlanDigest(caller.user);
    const channelDigest = operationPlanDigest(caller.channel);
    const sessionIdDigest = operationPlanDigest({ schema_version: "operation-plan-wait-session.v1", session_scope: sessionScope });
    const matches = (this.state.waits ?? []).filter((wait) => wait.state === "waiting" &&
      nowMs < wait.deadline_at_ms &&
      wait.owner_digest === ownerDigest && wait.channel_digest === channelDigest && wait.session_id_digest === sessionIdDigest &&
      wait.revision_digest === this.currentRevisionDigest(wait.plan_id_digest));
    return matches.length === 1 ? structuredClone(matches[0]!) : null;
  }

  activeWait(waitId: string): OperationPlanWaitState | null {
    if (!/^[a-f0-9]{64}$/.test(waitId)) return null;
    const wait = (this.state.waits ?? []).find((candidate) => candidate.wait_id === waitId &&
      candidate.state === "waiting" && candidate.revision_digest === this.currentRevisionDigest(candidate.plan_id_digest));
    return wait ? structuredClone(wait) : null;
  }

  /** Consume a canonical reply or due-deadline event once; the event ID is correlation only. */
  resumeWait(waitId: string, eventId: string, commandId: string, reason: "reply" | "deadline",
    nowMs = Date.now()): OperationPlanWaitState | null {
    if (!/^[a-f0-9]{64}$/.test(waitId) || !eventId.trim() || !commandId.trim()) return null;
    const current = (this.state.waits ?? []).find((wait) => wait.wait_id === waitId);
    if (!current || current.state !== "waiting" || current.revision_digest !== this.currentRevisionDigest(current.plan_id_digest)) return null;
    if ((reason === "deadline" && nowMs < current.deadline_at_ms) || (reason === "reply" && nowMs >= current.deadline_at_ms)) return null;
    const eventDigest = operationPlanDigest({ schema_version: "operation-plan-wait-event.v1", event_id: eventId });
    const resumed = OperationPlanWaitStateSchema.parse({ ...current, state: "resumed", resumed_at_ms: nowMs,
      wake_reason: reason, wake_event_id_digest: eventDigest,
      resume_command_id_digest: operationPlanDigest(commandId), compute_outcome: "pending" });
    this.change((state) => {
      const waits = state.waits ?? [];
      const index = waits.findIndex((wait) => wait.wait_id === waitId && wait.state === "waiting");
      if (index < 0) throw new Error("plan_wait_state_changed");
      waits[index] = resumed;
      state.waits = waits;
    });
    return structuredClone(resumed);
  }

  /** Bind the returned C candidate or failure to the exact resumed wait in J's durable state. */
  recordWaitComputeOutcome(waitId: string, commandId: string,
    outcome: "candidate_retained" | "candidate_rejected" | "failed", resultDigest?: string,
    candidatePlanIdDigest?: string, computeResourceUse?: ComputeResourceUse, nowMs = Date.now()): OperationPlanWaitState {
    if (!/^[a-f0-9]{64}$/.test(waitId) || !commandId.trim() ||
        (resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(resultDigest)) ||
        (candidatePlanIdDigest !== undefined && !/^[a-f0-9]{64}$/.test(candidatePlanIdDigest)) ||
        !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("plan_wait_compute_outcome_invalid");
    const current = (this.state.waits ?? []).find((wait) => wait.wait_id === waitId);
    if (!current || current.state !== "resumed" || current.resume_command_id_digest !== operationPlanDigest(commandId)) {
      throw new Error("plan_wait_compute_binding_mismatch");
    }
    if (computeResourceUse && computeResourceUse.request_digest !== createHash("sha256")
        .update("blue-tanuki.compute-resource-use.request.v1\0").update(commandId).digest("hex")) {
      throw new Error("plan_wait_compute_resource_binding_mismatch");
    }
    if (current.compute_outcome !== "pending") {
      if (current.compute_outcome === outcome && current.compute_result_digest === resultDigest &&
          current.candidate_plan_id_digest === candidatePlanIdDigest &&
          (computeResourceUse === undefined ||
            operationPlanDigest(current.compute_resource_use ?? null) === operationPlanDigest(computeResourceUse))) {
        return structuredClone(current);
      }
      throw new Error("plan_wait_compute_state_changed");
    }
    if ((outcome === "candidate_retained") !== (candidatePlanIdDigest !== undefined)) {
      throw new Error("plan_wait_candidate_binding_invalid");
    }
    if (candidatePlanIdDigest) {
      const candidate = this.state.plans.find((plan) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id) === candidatePlanIdDigest);
      if (!candidate || operationPlanTaskIdentityDigest(candidate) !== current.task_identity_digest ||
          operationPlanDigest(candidate.owner) !== current.owner_digest ||
          operationPlanDigest(candidate.channel) !== current.channel_digest ||
          operationPlanDigest({ schema_version: "operation-plan-wait-event.v1",
            event_id: candidate.revisions[0]!.plan.request_id }) !== current.wake_event_id_digest) {
        throw new Error("plan_wait_candidate_binding_invalid");
      }
    }
    const updated = OperationPlanWaitStateSchema.parse({ ...current, compute_outcome: outcome,
      ...(resultDigest ? { compute_result_digest: resultDigest } : {}),
      ...(candidatePlanIdDigest ? { candidate_plan_id_digest: candidatePlanIdDigest } : {}),
      ...(computeResourceUse ? { compute_resource_use: structuredClone(computeResourceUse) } : {}),
      compute_completed_at_ms: nowMs });
    this.change((state) => {
      const waits = state.waits ?? [];
      const index = waits.findIndex((wait) => wait.wait_id === waitId && wait.compute_outcome === "pending" &&
        wait.resume_command_id_digest === current.resume_command_id_digest);
      if (index < 0) throw new Error("plan_wait_compute_state_changed");
      waits[index] = updated;
      state.waits = waits;
    });
    return structuredClone(updated);
  }

  /** Startup reconciliation: bind an already-retained exact candidate or expose an interrupted C computation. */
  reconcilePendingWaitComputations(nowMs = Date.now()): readonly {
    readonly disposition: "candidate_reconciled" | "interrupted";
    readonly wait: OperationPlanWaitState;
  }[] {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("plan_wait_compute_recovery_time_invalid");
    if (!this.port || !(this.state.waits ?? []).some((wait) => wait.state === "resumed" && wait.compute_outcome === "pending")) {
      return [];
    }
    if (this.recoveryRefreshPending || this.activePlanAttempts.size > 0 || !this.savedDigest ||
        operationPlanDigest(this.port.load()) !== this.savedDigest) throw new Error("plan_wait_compute_recovery_state_unavailable");
    const updates = (this.state.waits ?? []).filter((wait) => wait.state === "resumed" && wait.compute_outcome === "pending")
      .map((wait) => {
        const candidates = this.state.plans.filter((candidate) => {
          const first = candidate.revisions[0]?.plan;
          return first !== undefined &&
            operationPlanDigest({ schema_version: "operation-plan-wait-event.v1", event_id: first.request_id }) === wait.wake_event_id_digest &&
            operationPlanTaskIdentityDigest(candidate) === wait.task_identity_digest &&
            operationPlanDigest(candidate.owner) === wait.owner_digest &&
            operationPlanDigest(candidate.channel) === wait.channel_digest;
        });
        const updated = structuredClone(wait);
        const terminalAt = Math.max(nowMs, wait.resumed_at_ms!);
        if (candidates.length === 1) {
          updated.compute_outcome = "candidate_retained";
          updated.candidate_plan_id_digest = operationPlanDigest(candidates[0]!.revisions[0]!.plan.plan_id);
          updated.compute_completed_at_ms = terminalAt;
          return { disposition: "candidate_reconciled" as const, wait: OperationPlanWaitStateSchema.parse(updated) };
        }
        updated.compute_outcome = "interrupted";
        updated.compute_interrupted_at_ms = terminalAt;
        return { disposition: "interrupted" as const, wait: OperationPlanWaitStateSchema.parse(updated) };
      });
    this.change((state) => {
      for (const update of updates) {
        const index = (state.waits ?? []).findIndex((wait) => wait.wait_id === update.wait.wait_id &&
          wait.state === "resumed" && wait.compute_outcome === "pending" &&
          wait.resume_command_id_digest === update.wait.resume_command_id_digest);
        if (index < 0) throw new Error("plan_wait_compute_recovery_state_changed");
        state.waits![index] = update.wait;
      }
    });
    return updates.map((update) => ({ disposition: update.disposition, wait: structuredClone(update.wait) }));
  }

  inspectInterruptedWaitForResume(control: OperationPlanWaitResumeControl, caller: InboundRequest): {
    readonly wait_id: string;
    readonly task_identity_digest: string;
    readonly goal: string;
    readonly goal_purpose_binding?: OperationPlanGoalPurposeBinding;
  } {
    if (this.recoveryRefreshPending || !this.port) throw new Error("plan_wait_state_not_durable");
    const wait = (this.state.waits ?? []).find((candidate) => candidate.wait_id === control.wait_id &&
      candidate.state === "resumed" && candidate.compute_outcome === "interrupted");
    if (!wait) throw new Error("plan_wait_resume_stale");
    const plan = this.state.plans.find((candidate) =>
      operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === wait.plan_id_digest);
    if (!plan || plan.revisions.at(-1)?.digest !== wait.revision_digest ||
        operationPlanTaskIdentityDigest(plan) !== wait.task_identity_digest ||
        operationPlanDigest(plan.owner) !== wait.owner_digest || operationPlanDigest(plan.channel) !== wait.channel_digest) {
      throw new Error("plan_wait_resume_stale");
    }
    try {
      this.ownedPlanForOwnerReauthentication(plan.revisions[0]!.plan.plan_id, control.owner_reauthentication, caller, "chat");
    } catch {
      throw new Error("plan_wait_resume_stale");
    }
    const recoveryHold = this.recoveryHolds.get(wait.plan_id_digest);
    if (recoveryHold) throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
    return { wait_id: wait.wait_id, task_identity_digest: wait.task_identity_digest, goal: plan.goal,
      ...(plan.goal_purpose_binding ? { goal_purpose_binding: structuredClone(plan.goal_purpose_binding) } : {}) };
  }

  /** Bind a fresh explicit owner reply to an interrupted wait without retaining the reply in J state. */
  resumeInterruptedWait(control: OperationPlanWaitResumeControl, caller: InboundRequest, commandId: string,
    nowMs = Date.now()): OperationPlanWaitState {
    if (!caller.id.trim() || !commandId.trim() || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("plan_wait_resume_invalid");
    }
    const inspected = this.inspectInterruptedWaitForResume(control, caller);
    const current = (this.state.waits ?? []).find((wait) => wait.wait_id === inspected.wait_id &&
      wait.state === "resumed" && wait.compute_outcome === "interrupted");
    if (!current) throw new Error("plan_wait_resume_stale");
    const resumed = structuredClone(current);
    delete resumed.compute_result_digest;
    delete resumed.candidate_plan_id_digest;
    delete resumed.compute_completed_at_ms;
    delete resumed.compute_interrupted_at_ms;
    delete resumed.compute_resource_use;
    resumed.resumed_at_ms = Math.max(nowMs, current.compute_interrupted_at_ms!);
    resumed.wake_reason = "recovery";
    resumed.wake_event_id_digest = operationPlanDigest({ schema_version: "operation-plan-wait-event.v1", event_id: caller.id });
    resumed.resume_command_id_digest = operationPlanDigest(commandId);
    resumed.compute_outcome = "pending";
    const checked = OperationPlanWaitStateSchema.parse(resumed);
    this.change((state) => {
      const waits = state.waits ?? [];
      const index = waits.findIndex((wait) => wait.wait_id === current.wait_id && wait.state === "resumed" &&
        wait.compute_outcome === "interrupted" && wait.compute_interrupted_at_ms === current.compute_interrupted_at_ms &&
        wait.revision_digest === current.revision_digest);
      if (index < 0) throw new Error("plan_wait_resume_state_changed");
      waits[index] = checked;
      state.waits = waits;
    });
    return structuredClone(checked);
  }

  listWaits(): readonly OperationPlanWaitState[] {
    return structuredClone(this.state.waits ?? []);
  }

  resumedWaitTaskIdentityDigest(waitId: string, eventId: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(waitId) || !eventId.trim()) return null;
    const eventDigest = operationPlanDigest({ schema_version: "operation-plan-wait-event.v1", event_id: eventId });
    const wait = (this.state.waits ?? []).find((candidate) => candidate.wait_id === waitId &&
      candidate.state === "resumed" && candidate.wake_event_id_digest === eventDigest);
    return wait?.task_identity_digest ?? null;
  }

  waitContext(wait: OperationPlanWaitState): { readonly goal: string; readonly owner: string; readonly channel: string;
    readonly goal_purpose_binding?: OperationPlanGoalPurposeBinding } | null {
    const plan = this.state.plans.find((candidate) => operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === wait.plan_id_digest);
    if (wait.state !== "waiting" || !plan || operationPlanTaskIdentityDigest(plan) !== wait.task_identity_digest ||
        plan.revisions.at(-1)?.digest !== wait.revision_digest || operationPlanDigest(plan.owner) !== wait.owner_digest ||
        operationPlanDigest(plan.channel) !== wait.channel_digest || this.recoveryHolds.has(wait.plan_id_digest) ||
        !this.goalPurposeBindingIsCurrent(plan.goal_purpose_binding)) return null;
    return { goal: plan.goal, owner: plan.owner, channel: plan.channel,
      ...(plan.goal_purpose_binding ? { goal_purpose_binding: structuredClone(plan.goal_purpose_binding) } : {}) };
  }

  /** Read only the exact current purpose version bound to this durable wait. */
  computePurposeForWait(waitId: string): { readonly binding: OperationPlanGoalPurposeBinding; readonly purpose_text: string } | null {
    const wait = (this.state.waits ?? []).find((candidate) => candidate.wait_id === waitId &&
      ((candidate.state === "waiting") || (candidate.state === "resumed" && candidate.compute_outcome === "interrupted")));
    if (!wait || !this.port || operationPlanDigest(this.port.load()) !== this.savedDigest) return null;
    const plan = this.state.plans.find((candidate) => operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === wait.plan_id_digest);
    const binding = plan?.goal_purpose_binding;
    if (!plan || !binding || plan.revisions.at(-1)?.digest !== wait.revision_digest ||
        operationPlanTaskIdentityDigest(plan) !== wait.task_identity_digest || operationPlanDigest(plan.owner) !== wait.owner_digest ||
        operationPlanDigest(plan.channel) !== wait.channel_digest || !this.goalPurposeBindingIsCurrent(binding)) return null;
    let purpose: OperationPlanGoalPurposeContent | undefined;
    try { purpose = this.goalPurposeContentReader?.(binding.goal_ref, binding.purpose_version) ?? undefined; }
    catch { return null; }
    if (!purpose || purpose.used_for_authority !== false || purpose.goal_ref !== binding.goal_ref ||
        purpose.version !== binding.purpose_version || purpose.purpose_digest !== binding.purpose_digest ||
        createHash("sha256").update(purpose.purpose_text, "utf8").digest("hex") !== binding.purpose_digest ||
        purpose.purpose_text.length > 20_000) return null;
    return { binding: structuredClone(binding), purpose_text: purpose.purpose_text };
  }

  private currentRevisionDigest(planIdDigest: string): string | null {
    const plan = this.state.plans.find((candidate) => operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === planIdDigest);
    return plan?.revisions.at(-1)?.digest ?? null;
  }

  /** Persist a non-authority hold before restoring either J or M as a whole store. */
  holdForCanonicalMemoryRestore(command: ExecuteCommand): boolean {
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        !["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"].includes(String(command.payload.arguments.store_key)) ||
        command.payload.arguments.confirm !== "RESTORE" || command.upstream_decision.commit_decision !== "ASSERT") return false;
    if (!this.port || this.recoveryRefreshPending || this.activePlanAttempts.size > 0) return false;
    if (this.state.plans.length === 0) return true;
    if (!this.savedDigest) return false;
    const restoreStoreKey = command.payload.arguments.store_key as NonNullable<OperationPlanRecoveryEvidenceProvenance["restore_store_key"]>;
    const evidence = parseOperationPlanRecoveryEvidence({
      schema_version: "operation-plan-recovery-evidence.v1",
      scope: "unverified_history",
      checkpoint_digest: this.savedDigest,
      provenance: {
        source: "recovery_restore",
        command_id_digest: recoveryCommandIdDigest(command.id),
        operation_digest: null,
        result_digest: null,
        restore_store_key: restoreStoreKey,
        restore_backup_id_digest: null,
        restore_scope_plan_digest: null,
        restored_state_digest: null,
      },
      plans: [],
      used_for_authority: false,
      may_execute: false,
    });
    this.applyRecoveryEvidence(evidence, true);
    this.persistRecoveryHoldState();
    // A selection predating a whole-store restore is not reusable after the hold
    // is later cleared. Started work is kept uncertain rather than made retryable.
    this.change((state) => {
      for (const plan of state.plans) for (const binding of plan.bindings) {
        if (binding.status === "selected") binding.status = "invalidated";
        if (binding.status === "intent_committed") binding.status = "outcome_unknown";
      }
    });
    return true;
  }

  /** Persist per-plan holds after a Broker restore without changing J selection or creating authority. */
  recordBrokerRestoreDependencyEvidence(
    command: ExecuteCommand,
    evidence: OperationPlanBrokerRestoreDependencyEvidence,
  ): boolean {
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        command.payload.arguments.store_key !== "broker" || command.payload.arguments.confirm !== "RESTORE" ||
        command.upstream_decision.commit_decision !== "ASSERT" || !this.port || this.recoveryRefreshPending ||
        this.activePlanAttempts.size > 0) return false;
    const checked = parseOperationPlanBrokerRestoreDependencyEvidence(evidence);
    if (checked.restore_observation !== "verified" ||
        checked.provenance.command_id_digest !== recoveryCommandIdDigest(command.id) ||
        !this.savedDigest || checked.checkpoint_digest !== this.savedDigest) return false;
    const saved = this.port.load(Boolean(this.memoryStorage));
    if (saved == null || operationPlanDigest(validateOperationPlanCheckpoint(saved, Boolean(this.memoryStorage))) !== this.savedDigest) {
      return false;
    }

    this.applyBrokerRestoreDependencyEvidence(checked, true);
    this.persistRecoveryHoldState();
    const statusByPlan = new Map(checked.plans.map((plan) => [plan.plan_id_digest, plan.status]));
    const affectedTaskIdentityDigests = new Set(this.state.plans.filter((plan) =>
      statusByPlan.get(operationPlanDigest(plan.revisions[0]!.plan.plan_id)) !== "unaffected")
      .map((plan) => operationPlanTaskIdentityDigest(plan)));
    const affectedPlanIds = new Set(this.state.plans.filter((plan) =>
      affectedTaskIdentityDigests.has(operationPlanTaskIdentityDigest(plan)))
      .map((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id)));
    if (affectedPlanIds.size > 0) {
      this.change((state) => {
        for (const plan of state.plans) {
          if (!affectedPlanIds.has(operationPlanDigest(plan.revisions[0]!.plan.plan_id))) continue;
          for (const binding of plan.bindings) {
            if (binding.status === "selected") binding.status = "invalidated";
            if (binding.status === "intent_committed") binding.status = "outcome_unknown";
          }
        }
      });
    }
    return true;
  }

  /** Attach a matched J/M restore observation to its existing non-authority holds. */
  recordCanonicalMemoryRestoreObservation(
    command: ExecuteCommand,
    observation: OperationPlanCanonicalMemoryRestoreObservation,
  ): boolean {
    const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        command.payload.arguments.store_key !== observation.store_key || command.payload.arguments.confirm !== "RESTORE" ||
        command.upstream_decision.commit_decision !== "ASSERT" ||
        observation.status !== "matched" || observation.operation !== "restore" ||
        !["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"].includes(observation.store_key) ||
        observation.store_ledger_status !== "verified" || observation.store_ledger_residual_count !== 0 ||
        !digest(observation.command_id_digest) || observation.command_id_digest !== recoveryCommandIdDigest(command.id) ||
        !digest(observation.operation_digest) || !digest(observation.result_digest) ||
        !digest(observation.restore_backup_id_digest) || !digest(observation.restored_state_digest)) return false;
    const taskRestorePoints = new Map<string, NonNullable<OperationPlanCanonicalMemoryRestoreObservation["task_memory_restore_points"]>[number]>();
    if (observation.store_key === "m_state") {
      if (observation.task_memory_restore_points !== undefined && observation.task_memory_restore_points !== null) {
        for (const point of observation.task_memory_restore_points) {
          if (!point || !digest(point.task_identity_digest) || !Array.isArray(point.plan_id_digests) ||
              point.plan_id_digests.length === 0 || point.plan_id_digests.some((planId) => !digest(planId)) ||
              new Set(point.plan_id_digests).size !== point.plan_id_digests.length ||
              !["observed", "residuals_present", "unobserved", "unknown"].includes(point.dependency_status) ||
              taskRestorePoints.has(point.task_identity_digest)) return false;
          taskRestorePoints.set(point.task_identity_digest, point);
        }
      }
    }
    if (this.state.plans.length === 0) return this.recoveryHolds.size === 0;
    if (!this.state.plans.every((plan) => this.recoveryHolds.has(operationPlanDigest(plan.revisions[0]!.plan.plan_id)))) {
      return false;
    }

    const updated = new Map<string, { reason: OperationPlanRecoveryHoldReason;
      restore_scope_relation: OperationPlanRecoveryScopeRelation; provenance: OperationPlanRecoveryHoldProvenance }>();
    for (const [planId, hold] of this.recoveryHolds) updated.set(planId, hold);
    let matched = 0;
    for (const [planId, hold] of updated) {
      if (hold.reason !== "held_unverified" || hold.provenance.source !== "recovery_restore" ||
          hold.provenance.command_id_digest !== observation.command_id_digest) continue;
      matched++;
      const plan = this.state.plans.find((candidate) =>
        operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === planId);
      if (!plan) return false;
      const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
      const taskPlanIds = this.state.plans.filter((candidate) =>
        operationPlanTaskIdentityDigest(candidate) === taskIdentityDigest)
        .map((candidate) => operationPlanDigest(candidate.revisions[0]!.plan.plan_id)).sort();
      const taskRestorePoint = observation.store_key === "m_state" ? taskRestorePoints.get(taskIdentityDigest) : undefined;
      const taskPointMatches = !!taskRestorePoint && [...taskRestorePoint.plan_id_digests].sort().length === taskPlanIds.length &&
        [...taskRestorePoint.plan_id_digests].sort().every((candidate, index) => candidate === taskPlanIds[index]);
      updated.set(planId, { ...hold, provenance: {
        ...hold.provenance,
        restore_store_key: observation.store_key,
        operation_digest: observation.operation_digest,
        result_digest: observation.result_digest,
        restore_backup_id_digest: observation.restore_backup_id_digest,
        restored_state_digest: observation.restored_state_digest,
        ...(observation.store_key === "m_state" ? {
          restore_task_identity_digest: taskIdentityDigest,
          restore_task_plan_set_digest: operationPlanTaskPlanSetDigest(taskPlanIds),
          restore_task_dependency_status: taskPointMatches ? taskRestorePoint.dependency_status : "unobserved",
        } : {}),
      } });
    }
    // Older residual/unobserved holds remain protective. They do not prevent the
    // J/M pair from reopening once the current restore itself has been observed.
    if (matched === 0) return this.state.plans.every((plan) => {
      const hold = this.recoveryHolds.get(operationPlanDigest(plan.revisions[0]!.plan.plan_id));
      if (!hold) return false;
      if (hold.reason !== "held_unverified" || hold.provenance.source !== "recovery_restore") return true;
      return hold.provenance.restore_store_key !== "j_control" && hold.provenance.restore_store_key !== "m_state" &&
        hold.provenance.restore_store_key !== "meaning_update_j_control" &&
        hold.provenance.restore_store_key !== "meaning_update_m_state";
    });
    const previous = new Map(this.recoveryHolds);
    this.recoveryHolds.clear();
    for (const [planId, hold] of updated) this.recoveryHolds.set(planId, hold);
    try {
      this.persistRecoveryHoldState();
      return true;
    } catch {
      this.recoveryHolds.clear();
      for (const [planId, hold] of previous) this.recoveryHolds.set(planId, hold);
      return false;
    }
  }

  /** Close only an idle, internally verified J/M pair before whole-store restore. */
  quiesceMemoryForCanonicalRestore(): boolean {
    if (!this.resultMemory || this.memoryQuiesced || this.activePlanAttempts.size > 0) return false;
    const lifecycle = this.resultMemory.snapshot();
    if (!lifecycle || !this.resultMemory.verify() || lifecycle.status === "memory_commit_pending" ||
        lifecycle.pending.some((entry) => ["approved", "applied", "unavailable", "receipt_mismatch"].includes(entry.lifecycle_state))) {
      return false;
    }
    this.memoryQuiesced = true;
    this.memoryReady = false;
    this.resultMemory.close();
    this.resultMemory = undefined;
    return true;
  }

  /** Reopen the configured pair only after recovery observation; failed opens stay unavailable. */
  reopenMemoryAfterCanonicalRestore(): boolean {
    if (!this.memoryQuiesced || !this.memoryStorage) return false;
    try {
      this.resultMemory?.close();
      const reopened = new JMemoryCommitCoordinator({ ...this.memoryStorage,
        j_approval_reader: { readVerifiedMemoryApproval: (ref) => this.readResultMemoryApproval(ref) } });
      const lifecycle = reopened.snapshot();
      if (!lifecycle || !reopened.verify() || lifecycle.status !== "ready" ||
          !["idle", "effect_confirmed"].includes(lifecycle.lifecycle_state) ||
          lifecycle.pending.some((entry) => entry.lifecycle_state !== "effect_confirmed")) {
        reopened.close();
        this.resultMemory = undefined;
        return false;
      }
      this.resultMemory = reopened;
      this.memoryQuiesced = false;
      this.memoryReady = true;
      return true;
    } catch {
      this.resultMemory = undefined;
      return false;
    }
  }

  refreshAfterRecoveryRestore(command: ExecuteCommand, recoveryEvidence?: OperationPlanRecoveryEvidence): string {
    if (!this.recoveryRefreshPending || this.activePlanAttempts.size > 0) {
      throw new Error("plan_recovery_refresh_not_ready");
    }
    const checkedEvidence = recoveryEvidence ? parseOperationPlanRecoveryEvidence(recoveryEvidence) : undefined;
    if (checkedEvidence) {
      const evidenceProvenance = checkedEvidence.provenance;
      if (!evidenceProvenance || evidenceProvenance.source !== "recovery_restore" ||
          evidenceProvenance.command_id_digest !== recoveryCommandIdDigest(command.id)) {
        throw new Error("plan_recovery_evidence_command_mismatch");
      }
    }
    const saved = this.port?.load(Boolean(this.memoryStorage));
    const checked = saved == null
      ? { schema_version: "operation-plan-state.v1" as const, plans: [] }
      : validateOperationPlanCheckpoint(saved, Boolean(this.resultMemory));
    const restoredCheckpointDigest = saved == null ? null : operationPlanDigest(checked);
    this.state = checked;
    this.savedDigest = restoredCheckpointDigest;
    this.reflections.clear();
    this.receiptReconciliations.clear();
    this.ownerSelectedFileStateObservations.clear();
    const scopedRestorePlanDigest = checkedEvidence?.provenance?.restore_scope_mode === "plan_scoped_merge_v1"
      ? checkedEvidence.provenance.restore_scope_plan_digest
      : null;
    const scopedRestoreTaskDigest = checkedEvidence?.provenance?.restore_scope_mode === "task_scoped_merge_v1"
      ? checkedEvidence.provenance.restore_scope_task_digest ?? null
      : null;
    // Restore changes only plan history. Any selection or started attempt from
    // the restored checkpoint must be revoked or represented as uncertain.
    this.change((state) => {
      for (const plan of state.plans) {
        if ((scopedRestorePlanDigest && operationPlanDigest(plan.revisions[0]!.plan.plan_id) !== scopedRestorePlanDigest) ||
            (scopedRestoreTaskDigest && operationPlanTaskIdentityDigest(plan) !== scopedRestoreTaskDigest)) continue;
        for (const binding of plan.bindings) {
          if (binding.status === "selected") binding.status = "invalidated";
          if (binding.status === "intent_committed") binding.status = "outcome_unknown";
        }
      }
    });
    if (scopedRestorePlanDigest) this.recoveryHolds.delete(scopedRestorePlanDigest);
    else if (scopedRestoreTaskDigest) {
      for (const [planIdDigest, hold] of this.recoveryHolds) {
        if (hold.provenance.restore_scope_task_digest === scopedRestoreTaskDigest) this.recoveryHolds.delete(planIdDigest);
      }
      for (const plan of this.state.plans) {
        if (operationPlanTaskIdentityDigest(plan) === scopedRestoreTaskDigest) {
          this.recoveryHolds.delete(operationPlanDigest(plan.revisions[0]!.plan.plan_id));
        }
      }
    } else this.recoveryHolds.clear();
    if (checkedEvidence) {
      this.applyRecoveryEvidence(checkedEvidence, checkedEvidence.checkpoint_digest === restoredCheckpointDigest);
    } else {
      for (const plan of this.state.plans) {
        if (scopedRestorePlanDigest && operationPlanDigest(plan.revisions[0]!.plan.plan_id) !== scopedRestorePlanDigest) continue;
        if (scopedRestoreTaskDigest && operationPlanTaskIdentityDigest(plan) !== scopedRestoreTaskDigest) continue;
        this.addRecoveryHold(operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest(command.id),
          operation_digest: null,
          result_digest: null,
          restore_backup_id_digest: null,
          restore_scope_plan_digest: scopedRestorePlanDigest,
          restore_scope_task_digest: scopedRestoreTaskDigest,
          ...(scopedRestoreTaskDigest ? { restore_scope_mode: "task_scoped_merge_v1" as const }
            : scopedRestorePlanDigest ? { restore_scope_mode: "plan_scoped_merge_v1" as const } : {}),
          restored_state_digest: null,
          checkpoint_digest: restoredCheckpointDigest ?? operationPlanDigest(checked),
        }, scopedRestoreTaskDigest ? "unknown" : scopedRestorePlanDigest ? "requested" : "unknown");
      }
    }
    this.persistRecoveryHoldState();
    this.memoryReady = this.resultMemory?.snapshot()?.status === "ready";
    return this.savedDigest!;
  }

  finishRecoveryRefresh(): void {
    if (!this.recoveryRefreshPending || this.activePlanAttempts.size > 0) {
      throw new Error("plan_recovery_refresh_not_ready");
    }
    this.recoveryRefreshPending = false;
  }

  private applyRecoveryEvidence(evidence: OperationPlanRecoveryEvidence, checkpointMatches: boolean): void {
    const provenance = this.provenanceForEvidence(evidence);
    if (!checkpointMatches || evidence.scope === "unverified_history") {
      if (provenance.restore_scope_mode === "task_scoped_merge_v1" && provenance.restore_scope_task_digest) {
        for (const plan of this.state.plans) {
          if (operationPlanTaskIdentityDigest(plan) !== provenance.restore_scope_task_digest) continue;
          this.addRecoveryHold(operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", provenance, "unknown");
        }
        return;
      }
      if (provenance.restore_scope_mode === "plan_scoped_merge_v1" && provenance.restore_scope_plan_digest) {
        this.addRecoveryHold(provenance.restore_scope_plan_digest, "held_unverified", provenance, "requested");
        return;
      }
      for (const plan of this.state.plans) this.addRecoveryHold(
        operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", provenance, "unknown");
      return;
    }
    const byPlan = new Map(evidence.plans.map((plan) => [plan.plan_id_digest, plan]));
    if (provenance.restore_scope_mode === "task_scoped_merge_v1" && provenance.restore_scope_task_digest) {
      for (const plan of this.state.plans) {
        const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
        if (taskIdentityDigest !== provenance.restore_scope_task_digest) continue;
        const digest = operationPlanDigest(plan.revisions[0]!.plan.plan_id);
        const state = byPlan.get(digest);
        const relation = "unknown" as const;
        if (!state || state.task_identity_digest !== taskIdentityDigest || state.restore_membership !== "restored") {
          this.addRecoveryHold(digest, "held_unverified", provenance, relation);
        } else if (state.integrity === "residuals_present" || state.dependency_status === "residuals_present") {
          this.addRecoveryHold(digest, "held_residual", provenance, relation);
        } else if (state.integrity === "unverified" || state.dependency_status === "unknown") {
          this.addRecoveryHold(digest, "held_unverified", provenance, relation);
        } else if (state.dependency_status === "unobserved" || state.dependency_status === "observed") {
          // J and its cross-store dependencies were not restored atomically. A fresh
          // J review must observe the current dependencies before any sibling resumes.
          this.addRecoveryHold(digest, "held_unobserved", provenance, relation);
        }
      }
      return;
    }
    for (const plan of this.state.plans) {
      const digest = operationPlanDigest(plan.revisions[0]!.plan.plan_id);
      const state = byPlan.get(digest);
      if (!state) {
        this.addRecoveryHold(digest, "held_unverified", provenance, "unknown");
    } else if (state.restore_membership === "not_restored") {
      continue;
    } else if (state.restore_membership === "unknown") {
      this.addRecoveryHold(digest, "held_unverified", provenance, state.restore_scope_relation);
      } else if (state.integrity === "residuals_present" || state.dependency_status === "residuals_present") {
        this.addRecoveryHold(digest, "held_residual", provenance, state.restore_scope_relation);
      } else if (state.integrity === "unverified" || state.dependency_status === "unknown") {
        this.addRecoveryHold(digest, "held_unverified", provenance, state.restore_scope_relation);
      } else if (state.dependency_status === "unobserved") {
        this.addRecoveryHold(digest, "held_unobserved", provenance, state.restore_scope_relation);
      }
    }
  }

  private applyBrokerRestoreDependencyEvidence(
    evidence: OperationPlanBrokerRestoreDependencyEvidence,
    checkpointMatches: boolean,
  ): void {
    const provenance: OperationPlanRecoveryHoldProvenance = {
      ...evidence.provenance,
      checkpoint_digest: evidence.checkpoint_digest,
    };
    const scopedTaskDigest = provenance.restore_scope_mode === "task_scoped_merge_v1"
      ? provenance.restore_scope_task_digest ?? null : null;
    if (!checkpointMatches || evidence.restore_observation !== "verified") {
      for (const plan of this.state.plans) {
        if (scopedTaskDigest && operationPlanTaskIdentityDigest(plan) !== scopedTaskDigest) continue;
        this.addRecoveryHold(operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", provenance, "unknown");
      }
      return;
    }
    const byPlan = new Map(evidence.plans.map((plan) => [plan.plan_id_digest, plan.status]));
    const plansByTaskIdentity = new Map<string, PlanState[]>();
    for (const plan of this.state.plans) {
      const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
      plansByTaskIdentity.set(taskIdentityDigest, [...(plansByTaskIdentity.get(taskIdentityDigest) ?? []), plan]);
    }
    for (const plans of plansByTaskIdentity.values()) {
      const taskIdentityDigest = operationPlanTaskIdentityDigest(plans[0]!);
      if (scopedTaskDigest && taskIdentityDigest !== scopedTaskDigest) continue;
      const statuses = plans.map((plan) => byPlan.get(operationPlanDigest(plan.revisions[0]!.plan.plan_id)) ?? "unverified");
      const reason: OperationPlanRecoveryHoldReason | null = statuses.includes("residuals_present") ? "held_residual"
        : statuses.includes("unverified") ? "held_unverified"
        : scopedTaskDigest ? "held_unobserved"
          : statuses.includes("unobserved") ? "held_unobserved" : null;
      if (!reason) continue;
      for (const plan of plans) this.addRecoveryHold(
        operationPlanDigest(plan.revisions[0]!.plan.plan_id), reason, provenance,
        scopedTaskDigest ? "unknown" : undefined);
    }
  }

  /** Older persisted Broker holds are expanded to the current J-owned task lineage on restart. */
  private propagateBrokerRestoreHoldsAcrossTaskLineage(): void {
    const plansById = new Map(this.state.plans.map((plan) =>
      [operationPlanDigest(plan.revisions[0]!.plan.plan_id), plan] as const));
    const brokerHolds = [...this.recoveryHolds.entries()].filter(([, hold]) =>
      hold.provenance.source === "recovery_restore" && hold.provenance.restore_store_key === "broker");
    for (const [heldPlanId, hold] of brokerHolds) {
      const heldPlan = plansById.get(heldPlanId);
      if (!heldPlan) continue;
      const taskIdentityDigest = operationPlanTaskIdentityDigest(heldPlan);
      for (const plan of this.state.plans) {
        if (operationPlanTaskIdentityDigest(plan) !== taskIdentityDigest) continue;
        this.addRecoveryHold(operationPlanDigest(plan.revisions[0]!.plan.plan_id), hold.reason,
          hold.provenance, hold.restore_scope_relation);
      }
    }
  }

  private provenanceForEvidence(evidence: OperationPlanRecoveryEvidence): OperationPlanRecoveryHoldProvenance {
    const source = evidence.provenance ?? recoveryEvidenceProvenance(undefined);
    return { ...source, checkpoint_digest: evidence.checkpoint_digest };
  }

  private recoveryDependenciesVerified(
    plan: PlanState,
    hold: { readonly reason: OperationPlanRecoveryHoldReason; readonly provenance: OperationPlanRecoveryHoldProvenance },
  ): boolean {
    try {
      const provenance = hold.provenance;
      const brokerRestoreHold = provenance.restore_store_key === "broker" && provenance.restore_scope_mode !== "task_scoped_merge_v1";
      const taskScopedRestoreHold = (provenance.restore_store_key === "operation_plans" || provenance.restore_store_key === "broker") &&
        provenance.restore_scope_mode === "task_scoped_merge_v1" && !!provenance.restore_scope_task_digest;
      if (taskScopedRestoreHold && hold.reason === "held_residual") return false;
      if ((!brokerRestoreHold && !taskScopedRestoreHold && hold.reason !== "held_unverified") || provenance.source !== "recovery_restore" ||
          ((brokerRestoreHold || taskScopedRestoreHold) && !this.brokerRestoreDependencyVerifier) ||
          (!brokerRestoreHold && !taskScopedRestoreHold && provenance.restore_store_key !== "j_control" &&
            provenance.restore_store_key !== "m_state" && provenance.restore_store_key !== "meaning_update_j_control" &&
            provenance.restore_store_key !== "meaning_update_m_state") ||
          !provenance.command_id_digest || !provenance.operation_digest || !provenance.result_digest ||
          !provenance.restore_backup_id_digest || !provenance.restored_state_digest ||
          !/^[a-f0-9]{64}$/.test(provenance.checkpoint_digest) || !this.port || !this.resultMemory ||
          this.memoryQuiesced || !this.savedDigest || operationPlanDigest(this.port.load()) !== this.savedDigest ||
          !this.resultMemory.verify()) return false;

      // A restore can invalidate prior selections, but must never turn an uncertain
      // or still-selected attempt into a fresh attempt. Such plans stay held for explicit recovery.
      if (plan.bindings.some((binding) => binding.status === "selected" ||
          binding.status === "intent_committed" || binding.status === "outcome_unknown")) {
        return false;
      }
      if (taskScopedRestoreHold && plan.bindings.some((binding) =>
        !["verified", "invalidated", "not_attempted"].includes(binding.status))) return false;
      if (plan.bindings.filter((binding) => binding.status === "verified").length === 0 &&
          (plan.results.length > 0 || plan.bindings.some((binding) =>
        !["invalidated", "not_attempted"].includes(binding.status) || binding.execution_admission !== undefined ||
        binding.delivery_digest !== undefined || binding.memory_commit !== undefined || binding.memory_receipt !== undefined))) {
        return false;
      }
      if (!this.recoveryPlanMemoryBindingsVerified(plan)) return false;
      if (provenance.restore_store_key === "m_state") {
        const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
        if (provenance.restore_task_dependency_status !== "observed" ||
            provenance.restore_task_identity_digest !== taskIdentityDigest ||
            !provenance.restore_task_plan_set_digest ||
            !/^[a-f0-9]{64}$/.test(provenance.restore_task_plan_set_digest)) return false;
        const taskPlans = this.state.plans.filter((candidate) =>
          operationPlanTaskIdentityDigest(candidate) === taskIdentityDigest);
        const taskPlanIds = taskPlans.map((candidate) =>
          operationPlanDigest(candidate.revisions[0]!.plan.plan_id));
        if (taskPlans.length === 0 || operationPlanTaskPlanSetDigest(taskPlanIds) !== provenance.restore_task_plan_set_digest) {
          return false;
        }
        return taskPlans.every((candidate) => {
          const candidateId = operationPlanDigest(candidate.revisions[0]!.plan.plan_id);
          const candidateHold = this.recoveryHolds.get(candidateId);
          if (candidateHold && (candidateHold.reason !== "held_unverified" ||
              candidateHold.provenance.source !== "recovery_restore" ||
              candidateHold.provenance.command_id_digest !== provenance.command_id_digest ||
              candidateHold.provenance.restore_store_key !== "m_state" ||
              candidateHold.provenance.restore_task_identity_digest !== taskIdentityDigest ||
              candidateHold.provenance.restore_task_plan_set_digest !== provenance.restore_task_plan_set_digest ||
              candidateHold.provenance.restore_task_dependency_status !== "observed")) return false;
          if (candidate.bindings.some((binding) => binding.status === "selected" || binding.status === "intent_committed" ||
              binding.status === "outcome_unknown" || !["verified", "invalidated", "not_attempted"].includes(binding.status))) {
            return false;
          }
          this.assertMemoryInterpretationDependenciesCurrent(candidate);
          return this.recoveryPlanMemoryBindingsVerified(candidate);
        });
      }
      if (provenance.restore_store_key === "meaning_update_j_control" ||
          provenance.restore_store_key === "meaning_update_m_state") {
        if (!this.meaningUpdateMemoryRestoreVerifier?.()) return false;
        this.assertMemoryInterpretationDependenciesCurrent(plan);
        return true;
      }
      if (taskScopedRestoreHold) {
        const taskIdentityDigest = provenance.restore_scope_task_digest!;
        if (operationPlanTaskIdentityDigest(plan) !== taskIdentityDigest) return false;
        const taskPlans = this.state.plans.filter((candidate) => operationPlanTaskIdentityDigest(candidate) === taskIdentityDigest);
        return taskPlans.length > 0 && taskPlans.every((candidate) => {
          const candidateId = operationPlanDigest(candidate.revisions[0]!.plan.plan_id);
          const candidateHold = this.recoveryHolds.get(candidateId);
          if (candidateHold && (candidateHold.provenance.restore_scope_mode !== "task_scoped_merge_v1" ||
              candidateHold.provenance.restore_scope_task_digest !== taskIdentityDigest ||
              candidateHold.reason === "held_residual")) return false;
          if (candidate.bindings.some((binding) => binding.status === "selected" || binding.status === "intent_committed" ||
              binding.status === "outcome_unknown")) return false;
          if (candidate.bindings.some((binding) =>
            !["verified", "invalidated", "not_attempted"].includes(binding.status))) return false;
          this.assertMemoryInterpretationDependenciesCurrent(candidate);
          return this.brokerRestoreDependencyVerifier!(candidateId, candidateHold?.provenance ?? provenance);
        });
      }
      if (!brokerRestoreHold) return true;
      if (!this.brokerRestoreDependencyVerifier) return false;
      const taskIdentityDigest = operationPlanTaskIdentityDigest(plan);
      const taskPlans = this.state.plans.filter((candidate) => operationPlanTaskIdentityDigest(candidate) === taskIdentityDigest);
      return taskPlans.length > 0 && taskPlans.every((candidate) => {
        const candidatePlanIdDigest = operationPlanDigest(candidate.revisions[0]!.plan.plan_id);
        const candidateHold = this.recoveryHolds.get(candidatePlanIdDigest);
        if (candidateHold && candidateHold.provenance.restore_store_key !== "broker") return false;
        return this.brokerRestoreDependencyVerifier!(candidatePlanIdDigest, candidateHold?.provenance ?? provenance);
      });
    } catch {
      return false;
    }
  }

  private recoveryPlanMemoryBindingsVerified(plan: PlanState): boolean {
    const memory = this.resultMemory;
    const lifecycle = memory?.snapshot();
    if (!memory || !lifecycle || lifecycle.status !== "ready" ||
        !["idle", "effect_confirmed"].includes(lifecycle.lifecycle_state) ||
        lifecycle.pending.some((entry) => entry.lifecycle_state !== "effect_confirmed")) return false;
    const verified = plan.bindings.filter((binding) => binding.status === "verified");
    return verified.every((binding) => {
      if (!binding.execution_admission || !binding.delivery_digest || !binding.memory_commit || !binding.memory_receipt ||
          !verifyResultMemoryCommit(plan, binding) || !receiptForResultCommit(binding.memory_receipt, binding.memory_commit)) {
        return false;
      }
      const commit = binding.memory_commit;
      if (commit.changes.length !== 1 || commit.changes[0]?.operation !== "upsert") return false;
      const directReceipt = memory.readMemoryReceipt(commit.update_id);
      const jEntries = lifecycle.pending.filter((entry) => entry.update_id === commit.update_id);
      if (!directReceipt || jEntries.length !== 1) return false;
      const jEntry = jEntries[0]!;
      if (jEntry.lifecycle_state !== "effect_confirmed" || jEntry.status !== "receipt_confirmed" ||
          jEntry.j_event_id !== commit.j_event_id || jEntry.content_digest !== commit.content_digest ||
          !jEntry.receipt || operationPlanDigest(jEntry.receipt) !== operationPlanDigest(binding.memory_receipt) ||
          operationPlanDigest(directReceipt) !== operationPlanDigest(binding.memory_receipt) ||
          !receiptForResultCommit(directReceipt, commit)) return false;
      const record = memory.readMemoryRecord(resultMemoryIdentity(binding).record_id);
      return !!record?.exists && operationPlanDigest(record.value) === operationPlanDigest(commit.changes[0]!.value);
    });
  }

  private releaseRecoveryHoldForFreshReview(plan: PlanState): boolean {
    const planIdDigest = operationPlanDigest(plan.revisions[0]!.plan.plan_id);
    const hold = this.recoveryHolds.get(planIdDigest);
    if (!hold || !this.recoveryDependenciesVerified(plan, hold)) return false;
    this.recoveryHolds.delete(planIdDigest);
    try {
      this.persistRecoveryHoldState();
      return true;
    } catch {
      this.recoveryHolds.set(planIdDigest, hold);
      return false;
    }
  }

  private addRecoveryHold(
    planIdDigest: string,
    reason: OperationPlanRecoveryHoldReason,
    provenance: OperationPlanRecoveryHoldProvenance,
    restoreScopeRelation: OperationPlanRecoveryScopeRelation = "unknown",
  ): void {
    const existing = this.recoveryHolds.get(planIdDigest);
    if (!existing) {
      this.recoveryHolds.set(planIdDigest, { reason, restore_scope_relation: restoreScopeRelation, provenance });
      return;
    }
    const rank: Record<OperationPlanRecoveryHoldReason, number> = {
      held_unobserved: 1, held_unverified: 2, held_residual: 3,
    };
    if (rank[reason] > rank[existing.reason]) this.recoveryHolds.set(planIdDigest,
      { reason, restore_scope_relation: restoreScopeRelation, provenance });
    else if (reason === existing.reason && reason === "held_unverified" &&
        provenance.source === "recovery_restore" && provenance.command_id_digest !== null &&
        (["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"] as const)
          .includes(provenance.restore_store_key as "j_control" | "m_state" | "meaning_update_j_control" | "meaning_update_m_state") &&
        existing.provenance.source === "recovery_restore" &&
        (["j_control", "m_state", "meaning_update_j_control", "meaning_update_m_state"] as const)
          .includes(existing.provenance.restore_store_key as "j_control" | "m_state" | "meaning_update_j_control" | "meaning_update_m_state")) {
      // A new whole-store restore supersedes the earlier pending observation for
      // this same kind of hold; its result still has to be observed afterwards.
      const sameObservedMRestore = provenance.restore_store_key === "m_state" &&
        existing.provenance.restore_store_key === "m_state" &&
        existing.provenance.command_id_digest === provenance.command_id_digest &&
        existing.provenance.restore_backup_id_digest === provenance.restore_backup_id_digest &&
        existing.provenance.restored_state_digest === provenance.restored_state_digest &&
        existing.provenance.restore_task_identity_digest !== null &&
        existing.provenance.restore_task_plan_set_digest !== null &&
        existing.provenance.restore_task_dependency_status !== null;
      this.recoveryHolds.set(planIdDigest, { reason, restore_scope_relation: restoreScopeRelation,
        provenance: sameObservedMRestore ? {
          ...provenance,
          restore_task_identity_digest: existing.provenance.restore_task_identity_digest,
          restore_task_plan_set_digest: existing.provenance.restore_task_plan_set_digest,
          restore_task_dependency_status: existing.provenance.restore_task_dependency_status,
        } : provenance });
    }
  }

  private persistRecoveryHoldState(): void {
    if (!this.port) return;
    const rawCurrent = this.port.loadRecoveryHoldState();
    if (rawCurrent !== null && rawCurrent !== undefined) parseOperationPlanRecoveryHoldState(rawCurrent);
    // CAS must compare against the exact persisted bytes' canonical JSON value.
    // Parsing may add defaults to legacy hold records, so hashing the parsed
    // projection would spuriously look like a concurrent writer.
    const currentDigest = rawCurrent === null || rawCurrent === undefined ? null : operationPlanDigest(rawCurrent);
    const state: OperationPlanRecoveryHoldState = {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [...this.recoveryHolds.entries()].map(([plan_id_digest, hold]) => ({
        plan_id_digest, reason: hold.reason, restore_scope_relation: hold.restore_scope_relation, provenance: hold.provenance,
      })).sort((left, right) => left.plan_id_digest.localeCompare(right.plan_id_digest)),
      used_for_authority: false,
      may_execute: false,
    };
    this.port.compareAndSetRecoveryHoldState(currentDigest, state);
  }

  inspectComputeParentPlan(reference: OperationPlanComputeParent, caller: InboundRequest): {
    readonly task_identity_digest: string;
    readonly goal: string;
    readonly goal_purpose_binding: OperationPlanGoalPurposeBinding;
  } {
    if (this.recoveryRefreshPending || this.memoryQuiesced || !this.port || !this.memoryReady ||
        operationPlanDigest(this.port.load()) !== this.savedDigest || !this.reconcileMemory()) {
      throw new Error("plan_compute_parent_memory_unavailable");
    }
    const matches = this.state.plans.filter((candidate) =>
      operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === reference.plan_id_digest);
    if (matches.length !== 1) throw new Error("plan_compute_parent_unavailable");
    const parent = matches[0]!;
    if (parent.owner !== caller.user || parent.channel !== caller.channel) {
      throw new Error("plan_compute_parent_identity_mismatch");
    }
    if (parent.revisions.at(-1)?.digest !== reference.revision_digest) {
      throw new Error("plan_compute_parent_stale");
    }
    if (this.recoveryHolds.has(reference.plan_id_digest)) {
      throw new Error("plan_compute_parent_recovery_hold");
    }
    if ((this.state.waits ?? []).some((wait) => wait.plan_id_digest === reference.plan_id_digest && wait.state === "waiting")) {
      throw new Error("plan_compute_parent_wait_active");
    }
    if (!parent.goal_purpose_binding) throw new Error("plan_compute_parent_purpose_unavailable");
    return { task_identity_digest: operationPlanTaskIdentityDigest(parent), goal: parent.goal,
      goal_purpose_binding: structuredClone(parent.goal_purpose_binding) };
  }

  retainCandidate(value: unknown, origin: InboundRequest, rawPurposeRelationCandidate?: unknown,
    computeSourceObservations?: readonly OperationPlanComputeSourceObservation[],
    memoryInterpretationDependencies?: readonly OperationPlanMemoryInterpretationDependency[],
    parentPlanReference?: OperationPlanComputeParent): string {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const plan = candidatePlan(value);
    const expected = origin.metadata?.["blue_tanuki.operation_core.request_id"] ?? origin.id;
    if (plan.request_id !== expected || this.state.plans.some((p) => p.revisions[0]!.plan.plan_id === plan.plan_id)) {
      throw new Error("plan_source_binding_mismatch");
    }
    const parentWaitId = origin.metadata?.["blue_tanuki.operation_core.parent_wait_id"];
    let parentTaskIdentityDigest: string | undefined;
    let retainedTaskGoal = origin.content;
    if (parentWaitId !== undefined) {
      if (!isGatewayInternalInboundRequest(origin) || typeof parentWaitId !== "string") {
        throw new Error("plan_wait_resume_origin_invalid");
      }
      parentTaskIdentityDigest = this.resumedWaitTaskIdentityDigest(parentWaitId, origin.id) ?? undefined;
      if (!parentTaskIdentityDigest ||
          origin.metadata?.["blue_tanuki.operation_core.parent_task_identity_digest"] !== parentTaskIdentityDigest) {
        throw new Error("plan_wait_resume_binding_invalid");
      }
      const eventDigest = operationPlanDigest({ schema_version: "operation-plan-wait-event.v1", event_id: origin.id });
      const parentWait = (this.state.waits ?? []).find((wait) => wait.wait_id === parentWaitId && wait.state === "resumed" &&
        wait.wake_event_id_digest === eventDigest && wait.compute_outcome === "pending" &&
        wait.task_identity_digest === parentTaskIdentityDigest);
      const parentPlan = parentWait && this.state.plans.find((candidate) =>
        operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === parentWait.plan_id_digest);
      if (!parentWait || !parentPlan || parentPlan.revisions.at(-1)?.digest !== parentWait.revision_digest ||
          operationPlanTaskIdentityDigest(parentPlan) !== parentTaskIdentityDigest ||
          operationPlanDigest(parentPlan.owner) !== parentWait.owner_digest ||
          operationPlanDigest(parentPlan.channel) !== parentWait.channel_digest ||
          origin.user !== parentPlan.owner || origin.channel !== parentPlan.channel) {
        throw new Error("plan_wait_resume_binding_invalid");
      }
      const recoveryHold = this.recoveryHolds.get(parentWait.plan_id_digest);
      if (recoveryHold) throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
      retainedTaskGoal = parentPlan.goal;
    }
    const rawGoalPurposeBinding = origin.metadata?.["blue_tanuki.operation_core.goal_purpose_binding"];
    let goalPurposeBinding: OperationPlanGoalPurposeBinding | undefined;
    if (rawGoalPurposeBinding !== undefined) {
      if (origin.metadata?.["blue_tanuki.authority_context"] !== "gateway_internal_v1" ||
          origin.metadata?.["blue_tanuki.operator_surface"] !== "developer") {
        throw new Error("plan_goal_purpose_binding_origin_invalid");
      }
      const parsedBinding = OperationPlanGoalPurposeBindingSchema.safeParse(rawGoalPurposeBinding);
      if (!parsedBinding.success) throw new Error("plan_goal_purpose_binding_invalid");
      goalPurposeBinding = this.resolveGoalPurposeBinding(parsedBinding.data, undefined);
    }
    let verifiedComputeSourceObservations: OperationPlanComputeSourceObservation[] | undefined;
    if (computeSourceObservations?.length) {
      if (!goalPurposeBinding || computeSourceObservations.length > 8) {
        throw new Error("plan_compute_source_observation_binding_invalid");
      }
      const references = computeSourceObservations.map((observation) =>
        observation.source === "verified_shell_exec_result"
          ? { command_id_digest: observation.command_id_digest }
          : { plan_id_digest: observation.plan_id_digest, revision_digest: observation.revision_digest,
            step_id_digest: observation.step_id_digest,
            ...(observation.source === "owner_selected_local_file_state"
              ? { owner_selected_observation: "local_file_state" as const } : {}) });
      const current = this.inspectComputeSourceObservations(references, origin);
      if (operationPlanDigest(current) !== operationPlanDigest(computeSourceObservations)) {
        throw new Error("plan_compute_source_observation_stale");
      }
      verifiedComputeSourceObservations = current;
    }
    if (parentPlanReference) {
      if (parentWaitId !== undefined) throw new Error("plan_compute_parent_conflicts_with_wait_resume");
      const parent = this.inspectComputeParentPlan(parentPlanReference, origin);
      const parentObservations = verifiedComputeSourceObservations?.filter((observation) =>
        observation.source !== "verified_shell_exec_result" &&
        observation.plan_id_digest === parentPlanReference.plan_id_digest &&
        observation.revision_digest === parentPlanReference.revision_digest);
      if (!goalPurposeBinding || operationPlanDigest(goalPurposeBinding) !== operationPlanDigest(parent.goal_purpose_binding) ||
          !parentObservations?.length || parentObservations.some((observation) =>
            observation.task_identity_digest !== parent.task_identity_digest)) {
        throw new Error("plan_compute_parent_source_observation_mismatch");
      }
      parentTaskIdentityDigest = parent.task_identity_digest;
      retainedTaskGoal = parent.goal;
    }
    const parsedMemoryDependencies = memoryInterpretationDependencies?.map((dependency) =>
      OperationPlanMemoryInterpretationDependencySchema.parse(dependency));
    if ((parsedMemoryDependencies?.length ?? 0) > 64 ||
        new Set((parsedMemoryDependencies ?? []).map((dependency) => dependency.judgment_ref)).size !==
          (parsedMemoryDependencies?.length ?? 0)) throw new Error("plan_memory_interpretation_dependency_invalid");
    const goalPurposeRelation = goalPurposeBinding
      ? this.recordGoalPurposeRelation(plan, retainedTaskGoal, goalPurposeBinding, rawPurposeRelationCandidate)
      : undefined;
    const requestGoalCriteria = GoalCriteriaProjectionSchema.parse(projectRequestGoalCriteria(
      { ...origin, id: expected, content: retainedTaskGoal }, retainedTaskGoal));
    this.change((state) => state.plans.push({ owner: origin.user, channel: origin.channel, goal: retainedTaskGoal,
      ...(parentTaskIdentityDigest ? { task_identity_digest: parentTaskIdentityDigest } : {}),
      ...(goalPurposeBinding ? { goal_purpose_binding: goalPurposeBinding } : {}),
      ...(goalPurposeRelation ? { goal_purpose_relation: goalPurposeRelation } : {}),
      ...(verifiedComputeSourceObservations ? { compute_source_observations: verifiedComputeSourceObservations } : {}),
      ...(parsedMemoryDependencies?.length ? { memory_interpretation_dependencies: parsedMemoryDependencies } : {}),
      request_goal_criteria: requestGoalCriteria,
      revisions: [{ digest: operationPlanDigest(plan), plan }], receipt_observations: [], bindings: [], results: [] }));
    return operationPlanDigest(plan.plan_id);
  }

  prepareGoalPurposeRelationReview(
    planIdDigest: string,
    revisionDigest: string,
    outcome: "supports" | "conflicts" | "unknown",
  ): { readonly args: OperationPlanGoalPurposeRelationReviewArguments; readonly content: OperationPlanGoalPurposeRelationReviewContent } {
    if (!/^[a-f0-9]{64}$/.test(planIdDigest) || !/^[a-f0-9]{64}$/.test(revisionDigest)) {
      throw new Error("plan_goal_purpose_relation_unavailable");
    }
    const matches = this.state.plans.filter((candidate) =>
      operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === planIdDigest);
    if (matches.length !== 1) throw new Error("plan_goal_purpose_relation_unavailable");
    const p = matches[0]!;
    const binding = p.goal_purpose_binding;
    const relation = p.goal_purpose_relation;
    if (!binding || !relation) throw new Error("plan_goal_purpose_relation_unavailable");
    const args = OperationPlanGoalPurposeRelationReviewArgumentsSchema.parse({
      plan_id_digest: planIdDigest,
      task_digest: relation.task_digest,
      revision_digest: revisionDigest,
      goal_ref: binding.goal_ref,
      purpose_version: binding.purpose_version,
      purpose_digest: binding.purpose_digest,
      outcome,
    });
    return { args, content: this.inspectGoalPurposeRelationReview(args) };
  }

  inspectGoalPurposeRelationReview(args: OperationPlanGoalPurposeRelationReviewArguments): OperationPlanGoalPurposeRelationReviewContent {
    const p = this.goalPurposeRelationReviewPlan(args);
    const binding = p.goal_purpose_binding!;
    const relation = p.goal_purpose_relation!;
    const purpose = this.goalPurposeContentReader?.(binding.goal_ref, binding.purpose_version) ?? undefined;
    if (!purpose || purpose.used_for_authority !== false || purpose.goal_ref !== binding.goal_ref ||
        purpose.version !== binding.purpose_version || purpose.purpose_digest !== binding.purpose_digest ||
        createHash("sha256").update(purpose.purpose_text, "utf8").digest("hex") !== binding.purpose_digest) {
      throw new Error("plan_goal_purpose_content_invalid");
    }
    return {
      task: p.goal,
      purpose_text: purpose.purpose_text,
      plan: structuredClone(p.revisions.at(-1)!.plan),
      goal_purpose_binding: structuredClone(binding),
      candidate_outcome: relation.candidate_outcome,
      candidate_status: relation.candidate_status,
      evidence_status: relation.evidence_status,
      evidence_count: relation.evidence_digests.length,
    };
  }

  isGoalPurposeRelationReviewCurrent(args: OperationPlanGoalPurposeRelationReviewArguments): boolean {
    try {
      this.goalPurposeRelationReviewPlan(args);
      return true;
    } catch { return false; }
  }

  recordGoalPurposeRelationOwnerReview(
    args: OperationPlanGoalPurposeRelationReviewArguments,
    review: OperationPlanGoalPurposeRelationOwnerReview,
  ): boolean {
    const parsedArgs = OperationPlanGoalPurposeRelationReviewArgumentsSchema.parse(args);
    const parsedReview = OperationPlanGoalPurposeRelationOwnerReviewSchema.parse(review);
    const p = this.goalPurposeRelationReviewPlan(parsedArgs);
    const { audit_event_digest, ...reviewDraft } = parsedReview;
    if (parsedReview.outcome !== parsedArgs.outcome ||
        audit_event_digest !== operationPlanGoalPurposeRelationReviewAuditDigest(parsedArgs, reviewDraft) ||
        this.goalPurposeRelationReviewVerifier?.({ request_id: parsedReview.request_id,
          command_id: parsedReview.command_id, audit_event_digest }) !== true) return false;
    const planId = p.revisions[0]!.plan.plan_id;
    this.change((state) => {
      const target = state.plans.find((candidate) => candidate.revisions[0]!.plan.plan_id === planId);
      if (!target?.goal_purpose_relation) throw new Error("plan_goal_purpose_relation_unavailable");
      target.goal_purpose_relation.owner_review = parsedReview;
    });
    return true;
  }

  inspectControl(control: Extract<OperationPlanControl, { action: "review" | "revise" }>, caller: InboundRequest): {
    plan_id: string; revision_digest: string; step?: OperationStep; goal: string; recovery_hold_released: boolean;
    goal_purpose_binding?: OperationPlanGoalPurposeBinding;
    resource_use_review?: { wait_id: string; resource_use: ComputeResourceUse };
  } {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const p = control.action === "review"
      ? this.ownedPlanForReview(control, caller)
      : this.ownedPlan(control.plan_id, caller);
    let recoveryHoldReleased = false;
    const recoveryHold = control.action === "review"
      ? this.recoveryHolds.get(operationPlanDigest(p.revisions[0]!.plan.plan_id)) : undefined;
    if (!this.reconcileMemory()) throw new Error("plan_memory_commit_pending");
    const current = p.revisions.at(-1)!;
    const expected = control.action === "review" ? control.revision_digest : control.expected_revision_digest;
    if (expected !== current.digest) throw new Error("plan_revision_changed");
    if (control.action === "review" && !this.computeSourceObservationsAreCurrent(p, Date.now())) {
      throw new Error("plan_compute_source_observation_expired");
    }
    if (control.action === "review") this.assertMemoryInterpretationDependenciesCurrent(p);
    if (control.action === "revise") {
      const planIdDigest = operationPlanDigest(p.revisions[0]!.plan.plan_id);
      if ((this.state.waits ?? []).some((wait) => wait.plan_id_digest === planIdDigest && wait.state === "waiting")) {
        throw new Error("plan_wait_active");
      }
      this.revisionImpact(p, control.plan);
      return { plan_id: control.plan_id, revision_digest: expected, goal: p.goal, recovery_hold_released: false };
    }
    const steps = current.plan.steps.filter((s) => s.step_id === control.step_id || operationPlanDigest(s.step_id) === control.step_id);
    if (steps.length !== 1) throw new Error("plan_step_identity_mismatch");
    const stepId = steps[0]!.step_id;
    if (p.bindings.some((b) => b.step_id === stepId && !["invalidated", "not_attempted"].includes(b.status))) {
      throw new Error("plan_step_already_selected_or_attempted");
    }
    const inspected = prepareOperationPlan(current.plan, { now_ms: Date.now(), results: p.results, observations: [] });
    if (inspected.kind === "rejected") throw new Error(`plan_${inspected.code}`);
    const step = inspected.plan.steps.find((s) => s.step_id === stepId);
    if (!step || inspected.summary.steps.find((s) => s.step_id === stepId)?.status !== "ready") throw new Error("plan_step_not_ready");
    // 実接続がある、対象と引数を狭く結び付けたadapterだけをcommand化する。
    if (!hasConnectedPlanTarget(step)) throw new Error("plan_target_resolver_not_connected");
    const goalPurposeBinding = this.resolveGoalPurposeBinding(control.goal_purpose_binding, p.goal_purpose_binding);
    const goalPurposeRelationIssue = this.goalPurposeRelationIssue(p, goalPurposeBinding);
    if (goalPurposeRelationIssue) throw new Error(goalPurposeRelationIssue);
    // 期限切れrevisionや不正stepの要求では復元holdを消さない。
    if (recoveryHold && !this.recoveryDependenciesVerified(p, recoveryHold)) {
      throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
    }
    const goalCriteriaIssue = this.requestGoalCriteriaIssue(p, step);
    if (goalCriteriaIssue) throw new Error(goalCriteriaIssue);
    if (recoveryHold && !this.releaseRecoveryHoldForFreshReview(p)) {
      throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
    }
    recoveryHoldReleased = recoveryHold !== undefined;
    const planIdDigest = operationPlanDigest(current.plan.plan_id);
    const failedResourceWaits = (this.state.waits ?? []).filter((wait) =>
      wait.plan_id_digest === planIdDigest && wait.revision_digest === current.digest &&
      (wait.compute_outcome === "candidate_rejected" || wait.compute_outcome === "failed") &&
      wait.compute_resource_use !== undefined &&
      (wait.compute_resource_use.charged_compute_ms > 0 || wait.compute_resource_use.charged_tokens > 0 ||
        wait.compute_resource_use.charged_cost_amount > 0));
    const currentTaskIdentityDigest = failedResourceWaits.length > 0 ? operationPlanTaskIdentityDigest(p) : undefined;
    const resourceUseReview = failedResourceWaits.filter((wait) =>
      wait.task_identity_digest === currentTaskIdentityDigest)
      .sort((a, b) => (b.compute_completed_at_ms ?? 0) - (a.compute_completed_at_ms ?? 0))[0];
    return { plan_id: current.plan.plan_id, revision_digest: expected, step, goal: p.goal,
      recovery_hold_released: recoveryHoldReleased,
      ...(resourceUseReview?.compute_resource_use
        ? { resource_use_review: { wait_id: resourceUseReview.wait_id,
          resource_use: structuredClone(resourceUseReview.compute_resource_use) } } : {}),
      ...(goalPurposeBinding ? { goal_purpose_binding: goalPurposeBinding } : {}) };
  }

  private assertMemoryInterpretationDependenciesCurrent(plan: PlanState): void {
    const dependencies = plan.memory_interpretation_dependencies ?? [];
    if (dependencies.length === 0) return;
    if (!this.memoryInterpretationReader) throw new Error("plan_memory_interpretation_state_unavailable");
    for (const dependency of dependencies) {
      const snapshot = this.memoryInterpretationReader(dependency.reference.record_id);
      const interpretation = snapshot?.record?.interpretations.find((item) =>
        item.interpretation_id === dependency.interpretation_id);
      if (!snapshot || snapshot.used_for_authority !== false || !snapshot.record ||
          snapshot.record.used_for_authority !== false || snapshot.record.may_execute !== false ||
          !interpretation || interpretation.basis_ref !== `${dependency.reference.record_id}#${dependency.reference.version}`) {
        throw new Error("plan_memory_interpretation_state_unavailable");
      }
      const judgment = snapshot.record.dependent_judgments.find((item) => item.judgment_ref === dependency.judgment_ref);
      if (!judgment || judgment.basis_interpretation_id !== dependency.interpretation_id) {
        if (!judgment && this.memoryCitationJudgmentVerifier?.(dependency) === true) continue;
        throw new Error("plan_memory_interpretation_state_unavailable");
      }
      if (snapshot.record.application_state !== "active" ||
          snapshot.record.current_interpretation_id !== dependency.interpretation_id ||
          judgment?.reassessment_required) {
        throw new Error("plan_memory_interpretation_reassessment_required");
      }
    }
  }

  /** Check the current J binding and issue no authority beyond one short-lived read-only lookup. */
  bindReceiptReconciliation(
    control: OperationPlanReceiptReconciliationControl,
    caller: InboundRequest,
    command: ExecuteCommand,
    now_ms = Date.now(),
  ): void {
    if (command.type !== "noop" || command.payload.control_event !== "operation_plan_receipt_reconciliation" ||
        command.upstream_decision.request_id !== caller.id || !Number.isSafeInteger(now_ms) || now_ms <= 0) {
      throw new Error("plan_receipt_reconciliation_command_invalid");
    }
    const inspected = this.inspectReceiptReconciliation(control, caller);
    const binding = inspected.binding;
    const authorization: OperationPlanReceiptReconciliationAuthorization = {
      authorization_id: randomUUID(), caller_user: caller.user, caller_channel: caller.channel,
      plan_id_digest: operationPlanDigest(inspected.plan_id), revision_digest: inspected.revision_digest,
      step_id_digest: operationPlanDigest(inspected.step.step_id), command_id: binding.command_id,
      command_digest: binding.command_digest, executor_command_digest: binding.execution_admission!.command_digest,
      command_key: binding.execution_admission!.command_key,
      execution_epoch: binding.execution_admission!.execution_epoch,
      task_identity_digest: binding.execution_admission!.task_identity_digest,
      operation: inspected.step.operation,
      parameters: structuredClone(inspected.step.parameters ?? {}), issued_at_ms: now_ms, expires_at_ms: now_ms + 30_000,
    };
    for (const [id, pending] of this.receiptReconciliations) {
      if (pending.authorization.expires_at_ms <= now_ms) this.receiptReconciliations.delete(id);
    }
    if (this.receiptReconciliations.size >= 128) throw new Error("plan_receipt_reconciliation_capacity_reached");
    this.receiptReconciliations.set(command.id, {
      command_digest: operationPlanDigest(command), caller_user: caller.user, caller_channel: caller.channel,
      control: structuredClone(control), authorization,
    });
    const expiry = setTimeout(() => {
      if (this.receiptReconciliations.get(command.id)?.authorization.authorization_id === authorization.authorization_id) {
        this.receiptReconciliations.delete(command.id);
      }
    }, 30_000);
    expiry.unref?.();
  }

  /** Consume a fresh J-issued reconciliation permit and recheck the current binding before any query. */
  takeReceiptReconciliationAuthorization(
    command: ExecuteCommand,
    caller: InboundRequest,
    now_ms = Date.now(),
  ): OperationPlanReceiptReconciliationAuthorization | null {
    const issued = this.receiptReconciliations.get(command.id);
    this.receiptReconciliations.delete(command.id);
    if (!issued || command.type !== "noop" || command.payload.control_event !== "operation_plan_receipt_reconciliation" ||
        issued.command_digest !== operationPlanDigest(command) || issued.caller_user !== caller.user ||
        issued.caller_channel !== caller.channel || !Number.isSafeInteger(now_ms) ||
        now_ms < issued.authorization.issued_at_ms || now_ms >= issued.authorization.expires_at_ms) return null;
    try {
      const current = this.inspectReceiptReconciliation(issued.control, caller);
      const binding = current.binding;
      if (operationPlanDigest(current.plan_id) !== issued.authorization.plan_id_digest ||
          current.revision_digest !== issued.authorization.revision_digest ||
          operationPlanDigest(current.step.step_id) !== issued.authorization.step_id_digest ||
          binding.command_id !== issued.authorization.command_id || binding.command_digest !== issued.authorization.command_digest ||
          binding.execution_admission?.command_digest !== issued.authorization.executor_command_digest ||
          binding.execution_admission?.command_key !== issued.authorization.command_key ||
          binding.execution_admission?.execution_epoch !== issued.authorization.execution_epoch ||
          binding.execution_admission?.task_identity_digest !== issued.authorization.task_identity_digest) return null;
      return structuredClone(issued.authorization);
    } catch { return null; }
  }

  inspectReceiptReconciliationForControl(
    control: OperationPlanReceiptReconciliationControl,
    caller: InboundRequest,
  ): void {
    this.inspectReceiptReconciliation(control, caller);
  }

  bind(control: Extract<OperationPlanControl, { action: "review" }>, caller: InboundRequest, command: ExecuteCommand): void {
    const prepared = this.inspectControl(control, caller);
    const step = prepared.step!;
    const descriptor = getOperationDescriptor(step.operation)!;
    const plan = this.state.plans.find((candidate) => candidate.revisions[0]!.plan.plan_id === prepared.plan_id);
    if (!plan) throw new Error("plan_execution_source_binding_unavailable");
    const goalRelationAdoptionAssessment = this.goalRelationAdoptionAssessment(plan, step);
    if (command.type !== "tool_call" || command.payload.tool_name !== descriptor.tool_name ||
        operationPlanDigest(command.payload.arguments) !== operationPlanDigest(step.parameters)) throw new Error("plan_command_content_changed");
    this.change((state) => {
      const p = state.plans.find((p) => p.revisions[0]!.plan.plan_id === prepared.plan_id)!;
      if (prepared.goal_purpose_binding) p.goal_purpose_binding = prepared.goal_purpose_binding;
      p.bindings.push({ step_id: step.step_id, revision_digest: prepared.revision_digest,
        step_digest: stepDigest(p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === step.step_id)!),
        prepared_step: step,
        command_id: command.id, request_id: command.upstream_decision.request_id!,
        commit_hash: command.upstream_decision.commit_hash, payload_digest: commandPayloadDigest(command),
        command_digest: operationPlanDigest(command),
        executor_command_digest: canonicalExecutorCommandDigest(command),
        operation: descriptor.operation_id, goal_relation_adoption_assessment: goalRelationAdoptionAssessment,
        status: "selected" });
    });
    this.issuedBindings.set(command, command.id);
    this.issuedBindingIds.add(command.id);
  }

  revise(control: Extract<OperationPlanControl, { action: "revise" }>, caller: InboundRequest): string[] {
    this.inspectControl(control, caller);
    const p = this.ownedPlan(control.plan_id, caller);
    const affected = this.revisionImpact(p, control.plan);
    const invalidated = p.bindings.filter((b) => b.status === "selected" && affected.has(b.step_id)).map((b) => b.command_id);
    this.change((state) => {
      const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === p.revisions[0]!.plan.plan_id)!;
      target.revisions.push({ digest: operationPlanDigest(control.plan), plan: candidatePlan(control.plan) });
      for (const b of target.bindings) if (invalidated.includes(b.command_id)) b.status = "invalidated";
    });
    return invalidated;
  }

  isBound(command_id: string): boolean { return this.binding(command_id) !== undefined; }
  /** Return only categorical counts from the saved J adoption record to the non-authoritative Rust observer. */
  runtimeKernelJPlanStepAdoptionProjection(command: ExecuteCommand | null | undefined): RuntimeKernelJPlanStepAdoptionProjection {
    if (!command) return { status: "not_applicable" };
    const issuedId = this.issuedBindings.get(command);
    if (issuedId === undefined) {
      return this.issuedBindingIds.has(command.id)
        ? { status: "not_comparable", reason: "binding_identity_unavailable" }
        : { status: "not_applicable" };
    }
    if (issuedId !== command.id) return { status: "not_comparable", reason: "binding_identity_unavailable" };
    const match = this.binding(issuedId);
    if (!match) return { status: "not_comparable", reason: "binding_unavailable" };
    if (match.b.status !== "selected") return { status: "not_comparable", reason: "binding_not_selected" };
    if (!match.b.goal_relation_adoption_assessment) {
      return { status: "not_comparable", reason: "legacy_record_unavailable" };
    }
    try {
      const assessment = OperationPlanGoalRelationAdoptionAssessmentSchema.parse(
        match.b.goal_relation_adoption_assessment,
      );
      const { assessment_digest: savedDigest, ...body } = assessment;
      if (savedDigest !== operationPlanDigest(body)) return { status: "not_comparable", reason: "record_invalid" };
      const criteria = assessment.criterion_relation.criterion_relations;
      return {
        status: "available",
        purpose_relation: {
          status: assessment.purpose_relation.status,
          candidate_outcome: assessment.purpose_relation.candidate_outcome,
          candidate_status: assessment.purpose_relation.candidate_status,
          evidence_status: assessment.purpose_relation.evidence_status,
          owner_review_outcome: assessment.purpose_relation.status === "owner_reviewed_supports" ? "supports" : null,
        },
        criterion_relation: {
          outcome: assessment.criterion_relation.outcome,
          evidence_status: assessment.criterion_relation.evidence_status,
          risk_status: assessment.criterion_relation.risk_status,
          relation_count: criteria.length,
          objective_count: criteria.filter((entry) => entry.criterion_kind === "objective").length,
          safety_count: criteria.filter((entry) => entry.criterion_kind === "safety").length,
          supports_count: criteria.filter((entry) => entry.relation === "supports").length,
          conflicts_count: criteria.filter((entry) => entry.relation === "conflicts").length,
          reason_code: assessment.criterion_relation.reason_code,
        },
      };
    } catch {
      return { status: "not_comparable", reason: "record_invalid" };
    }
  }
  /**
   * Produce non-authority source evidence for the exact J-selected plan step
   * that produced this command, including the explicitly selected purpose version.
   * This remains provenance and does not establish semantic fit or grant authority.
   */
  executionSourceBindingDigest(command: ExecuteCommand): string | undefined {
    const issuedId = this.issuedBindings.get(command);
    if (issuedId === undefined) {
      if (this.issuedBindingIds.has(command.id)) throw new Error("plan_execution_source_binding_unavailable");
      return undefined;
    }
    if (issuedId !== command.id) throw new Error("plan_execution_source_binding_identity_mismatch");
    const match = this.binding(issuedId);
    if (!match) throw new Error("plan_execution_source_binding_stale");
    const currentRevision = match.p.revisions.at(-1);
    const revision = match.p.revisions.find((entry) => entry.digest === match.b.revision_digest);
    const step = revision?.plan.steps.find((entry) => entry.step_id === match.b.step_id);
    const descriptor = step ? getOperationDescriptor(step.operation) : undefined;
    const computeSourceObservations = match.p.compute_source_observations ?? [];
    if (!this.computeSourceObservationsAreCurrent(match.p, Date.now())) {
      throw new Error("plan_execution_source_observation_expired");
    }
    if (!this.canExecute(command) ||
        !this.goalPurposeBindingIsCurrent(match.p.goal_purpose_binding) ||
        this.goalPurposeRelationIssue(match.p) !== undefined ||
        match.b.status !== "selected" || !currentRevision ||
        !revision || !step || stepDigest(step) !== match.b.step_digest || !descriptor ||
        this.requestGoalCriteriaIssue(match.p, step) !== undefined ||
        match.b.operation !== descriptor.operation_id || command.type !== "tool_call" ||
        command.payload.tool_name !== descriptor.tool_name || commandPayloadDigest(command) !== match.b.payload_digest ||
        operationPlanDigest(command) !== match.b.command_digest ||
        command.upstream_decision.request_id !== match.b.request_id ||
        command.upstream_decision.commit_hash !== match.b.commit_hash) {
      throw new Error("plan_execution_source_binding_stale");
    }
    const currentGoalRelationAdoptionAssessment = this.goalRelationAdoptionAssessment(match.p, step);
    if (match.b.goal_relation_adoption_assessment &&
        currentGoalRelationAdoptionAssessment.assessment_digest !== match.b.goal_relation_adoption_assessment.assessment_digest) {
      throw new Error("plan_execution_source_binding_stale");
    }
    return operationPlanDigest({
      schema_version: "blue-tanuki.operation-plan-execution-source.v1",
      owner_digest: operationPlanDigest(match.p.owner),
      channel: match.p.channel,
      original_goal_digest: operationPlanDigest(match.p.goal),
      plan_id_digest: operationPlanDigest(revision.plan.plan_id),
      plan_request_id_digest: operationPlanDigest(revision.plan.request_id),
      revision_digest: match.b.revision_digest,
      step_id_digest: operationPlanDigest(match.b.step_id),
      step_digest: match.b.step_digest,
      prepared_step_digest: operationPlanDigest(match.b.prepared_step),
      operation: match.b.operation,
      adapter: step.adapter,
      target_digest: operationPlanDigest(match.b.prepared_step.target),
      effects_digest: operationPlanDigest(match.b.prepared_step.effects),
      parameters_digest: operationPlanDigest(match.b.prepared_step.parameters ?? {}),
      preconditions_digest: operationPlanDigest(match.b.prepared_step.preparation?.preconditions ?? []),
      goal_purpose_binding: match.p.goal_purpose_binding ?? null,
      goal_purpose_relation_digest: operationPlanDigest(match.p.goal_purpose_relation ?? null),
      request_goal_criteria_digest: operationPlanDigest(match.p.request_goal_criteria ?? null),
      goal_relation_adoption_assessment_digest: match.b.goal_relation_adoption_assessment?.assessment_digest ?? null,
      compute_source_observations_digest: operationPlanDigest(computeSourceObservations),
      command_digest: match.b.command_digest,
    });
  }
  /** J所有計画のstep・改訂をまたぐ安定した非権威task identity。 */
  executionTaskIdentityDigest(command: ExecuteCommand): string | undefined {
    // Reuse the current-source checks so stale or unselected plans cannot mint
    // a task identity for a worker request.
    if (this.executionSourceBindingDigest(command) === undefined) return undefined;
    const match = this.binding(command.id);
    if (!match) throw new Error("plan_execution_task_identity_unavailable");
    return operationPlanTaskIdentityDigest(match.p);
  }
  canExecute(command: ExecuteCommand): boolean {
    const reflectionCommand = this.reflections.has(command.id) || (command.type === "llm_call" &&
      command.payload.compute_context?.local_p_version === OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION);
    const issuedBindingId = this.issuedBindings.get(command);
    if (this.recoveryRefreshPending &&
        (reflectionCommand || issuedBindingId !== undefined || this.issuedBindingIds.has(command.id))) {
      return false;
    }
    if (reflectionCommand) {
      return this.readReflection(command) !== undefined;
    }
    const bindingId = issuedBindingId ?? command.id;
    const match = this.binding(bindingId);
    const taskScopedPlanRestore = command.type === "tool_call" && command.payload.tool_name === "recovery.restore" &&
      command.payload.arguments.store_key === "operation_plans" && command.payload.arguments.scope_kind === "task_identity";
    const taskScopeDigest = taskScopedPlanRestore ? command.payload.arguments.scope_digest : undefined;
    if (taskScopedPlanRestore && (typeof taskScopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(taskScopeDigest))) return false;
    if (!match) {
      if (this.issuedBindingIds.has(bindingId) || this.issuedBindingIds.has(command.id)) return false;
      if (!taskScopedPlanRestore) return true;
      if (this.memoryQuiesced || !this.reconcileMemory()) return false;
      // Operator recovery is not itself a selected plan step. Bind its target
      // to an exact current J task identity; restored plans stay held until a
      // fresh J review validates their current cross-store dependencies.
      return this.state.plans.some((plan) => operationPlanTaskIdentityDigest(plan) === taskScopeDigest);
    }
    if (this.memoryQuiesced || this.recoveryHolds.has(operationPlanDigest(match.p.revisions[0]!.plan.plan_id))) return false;
    if (!this.reconcileMemory()) return false;
    const { p, b } = match;
    if (taskScopedPlanRestore && !this.state.plans.some((plan) => operationPlanTaskIdentityDigest(plan) === taskScopeDigest)) return false;
    // J/M evidence may change while the selected command waits at its L3 gate.
    try { this.assertMemoryInterpretationDependenciesCurrent(p); }
    catch { return false; }
    if (!this.goalPurposeBindingIsCurrent(p.goal_purpose_binding) || this.goalPurposeRelationIssue(p) !== undefined) return false;
    const nowMs = Date.now();
    if (!this.computeSourceObservationsAreCurrent(p, nowMs)) return false;
    const step = p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === b.step_id);
    if (!step || this.requestGoalCriteriaIssue(p, step) !== undefined) return false;
    try {
      const currentAssessment = this.goalRelationAdoptionAssessment(p, step);
      if (b.goal_relation_adoption_assessment &&
          currentAssessment.assessment_digest !== b.goal_relation_adoption_assessment.assessment_digest) return false;
    } catch { return false; }
    const prepared = prepareOperationPlan(p.revisions.at(-1)!.plan, { now_ms: nowMs, results: p.results, observations: [] });
    const current = prepared.kind === "inspected" ? prepared.plan.steps.find((s) => s.step_id === b.step_id) : undefined;
    const currentBinding = command.id === b.command_id && b.status === "selected" && !!step && stepDigest(step) === b.step_digest &&
      prepared.kind === "inspected" && prepared.summary.steps.find((s) => s.step_id === b.step_id)?.status === "ready" &&
      !!current && stepDigest(current) === stepDigest(b.prepared_step) &&
      command.upstream_decision.request_id === b.request_id && command.upstream_decision.commit_hash === b.commit_hash &&
      command.upstream_decision.commit_decision === "ASSERT" && command.type === "tool_call" &&
      command.payload.tool_name === b.operation && commandPayloadDigest(command) === b.payload_digest &&
      operationPlanDigest(command) === b.command_digest && matchesCanonicalExecutorCommandDigest(command, b.executor_command_digest);
    return currentBinding;
  }
  beginAttempt(command: ExecuteCommand, admission?: ExecutionAdmission): boolean {
    if (!this.canExecute(command)) return false;
    if (!this.isBound(command.id)) return true;
    const admitted = admission === undefined ? undefined : ExecutionAdmissionSchema.parse(admission);
    const binding = this.binding(command.id)?.b;
    if (admitted && (!binding?.executor_command_digest || admitted.command_digest !== binding.executor_command_digest ||
        admitted.command_key !== createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex") ||
        admitted.task_identity_digest !== this.executionTaskIdentityDigest(command) ||
        Date.now() < admitted.issued_at_ms || Date.now() >= admitted.expires_at_ms)) return false;
    this.change((state) => { for (const p of state.plans) {
      const b = p.bindings.find((b) => b.command_id === command.id);
      if (b) { b.status = "intent_committed"; if (admitted) b.execution_admission = admitted; }
    } });
    this.activePlanAttempts.add(this.issuedBindings.get(command) ?? command.id);
    freezeCommand(command);
    return true;
  }
  abandon(command_id: string): void {
    if (this.recoveryRefreshPending) return;
    if (!this.binding(command_id) || this.binding(command_id)!.b.status !== "selected") return;
    this.change((state) => { for (const p of state.plans) {
      const b = p.bindings.find((b) => b.command_id === command_id); if (b?.status === "selected") b.status = "invalidated";
    } });
  }

  recordResult(feedback: ExecuteFeedback): void {
    if (this.recoveryRefreshPending) {
      this.activePlanAttempts.delete(feedback.command_id);
      return;
    }
    try {
      const match = this.binding(feedback.command_id);
      if (!match || match.b.status !== "intent_committed") return;
      this.applyResult(match, feedback);
    } finally {
      this.activePlanAttempts.delete(feedback.command_id);
    }
  }

  /** Retain one exact HDS-issued shell result report as digest-only non-authority memory. */
  recordShellExecResultObservation(input: {
    command: ExecuteCommand;
    owner: string;
    channel: string;
    result: OperationCommandExecutionResult;
    result_digest: string;
  }): boolean {
    const { command, result } = input;
    if (this.recoveryRefreshPending || command.type !== "tool_call" || command.payload.tool_name !== "shell.exec" ||
        command.upstream_decision.commit_decision !== "ASSERT" || !/^[a-f0-9]{64}$/.test(input.result_digest)) return false;
    const matched = inspectOperationCommandExecutionResult(result, {
      request_id: command.upstream_decision.request_id ?? null,
      command_id: command.id,
      upstream_commit_hash: command.upstream_decision.commit_hash,
      status: "success",
      operation: "shell.exec",
    });
    if (!matched || matched.adapter !== "shell" || matched.execution_boundary !== "tool_adapter" ||
        matched.action_outcome !== "reported_success" || matched.plan_step_binding !== "unbound" ||
        matched.command_payload_digest !== commandPayloadDigest(command) || matched.output_digest !== input.result_digest ||
        !Number.isSafeInteger(matched.observed_at_ms) || matched.observed_at_ms > Date.now()) return false;
    const observation = OperationPlanShellExecResultObservationSchema.parse({
      schema_version: "operation-plan-shell-exec-result.v1",
      owner_digest: operationPlanDigest(input.owner),
      channel_digest: operationPlanDigest(input.channel),
      request_id_digest: operationPlanDigest(matched.request_id),
      command_id_digest: operationPlanDigest(matched.command_id),
      upstream_commit_hash_digest: operationPlanDigest(matched.upstream_commit_hash),
      command_payload_digest: matched.command_payload_digest,
      result_id_digest: operationPlanDigest(matched.result_id),
      result_contract_digest: operationPlanDigest(matched),
      result_digest: input.result_digest,
      execution_status: "succeeded",
      execution_boundary: "tool_adapter",
      action_outcome: "reported_success",
      plan_step_binding: "unbound",
      observed_at_ms: matched.observed_at_ms,
      used_for_authority: false,
      may_execute: false,
    });
    const existing = (this.state.shell_exec_result_observations ?? []).find((entry) =>
      entry.command_id_digest === observation.command_id_digest);
    if (existing) {
      const { memory_commit: _commit, memory_receipt: _receipt, ...saved } = existing;
      return operationPlanDigest(saved) === operationPlanDigest(observation);
    }
    if ((this.state.shell_exec_result_observations?.length ?? 0) >= 256) {
      throw new Error("plan_shell_result_observation_capacity_reached");
    }
    this.change((state) => {
      state.shell_exec_result_observations ??= [];
      state.shell_exec_result_observations.push(observation);
    });
    return true;
  }

  private recoveryHoldAllowsResultMemoryReconciliation(hold: {
    readonly reason: OperationPlanRecoveryHoldReason;
    readonly provenance: OperationPlanRecoveryHoldProvenance;
  }): boolean {
    const provenance = hold.provenance;
    if (hold.reason !== "held_unverified" || provenance.source !== "recovery_restore" ||
        (provenance.restore_store_key !== "j_control" && provenance.restore_store_key !== "m_state") ||
        !provenance.command_id_digest || !provenance.operation_digest || !provenance.result_digest ||
        !provenance.restore_backup_id_digest || !provenance.restored_state_digest ||
        !/^[a-f0-9]{64}$/.test(provenance.checkpoint_digest) || this.memoryQuiesced || !this.resultMemory) return false;
    const lifecycle = this.resultMemory.snapshot();
    return !!lifecycle && lifecycle.status === "ready" && this.resultMemory.verify();
  }

  /** 保存済みの同内容だけをJ→Mへ配送。作用・意味更新・承認復元は呼ばない。 */
  reconcileMemory(): boolean {
    if (this.recoveryRefreshPending) return false;
    if (this.memoryQuiesced) return false;
    if (!this.resultMemory) return (this.state.shell_exec_result_observations?.length ?? 0) === 0;
    this.memoryReady = false;
    try {
      if (this.port && operationPlanDigest(this.port.load()) !== this.savedDigest && this.savedDigest !== null) return false;
      for (const original of this.state.shell_exec_result_observations ?? []) {
        let observation = this.state.shell_exec_result_observations?.find((entry) =>
          entry.command_id_digest === original.command_id_digest);
        if (!observation) return false;
        if (!observation.memory_commit) {
          const lifecycle = this.resultMemory.snapshot();
          const stored = this.resultMemory.readMemoryRecord(shellExecResultMemoryIdentity(observation).record_id);
          if (!lifecycle || lifecycle.status !== "ready" || !stored || stored.exists) return false;
          const commit = buildShellExecResultMemoryCommit(observation, stored.revision);
          this.change((state) => {
            const target = state.shell_exec_result_observations?.find((entry) =>
              entry.command_id_digest === observation!.command_id_digest);
            if (!target) throw new Error("plan_shell_result_observation_missing");
            target.memory_commit = commit;
          });
          observation = this.state.shell_exec_result_observations?.find((entry) =>
            entry.command_id_digest === original.command_id_digest);
        }
        if (!observation?.memory_commit || !verifyShellExecResultMemoryCommit(observation)) return false;
        const commit = observation.memory_commit;
        const lifecycle = this.resultMemory.snapshot();
        if (!lifecycle) return false;
        const existing = lifecycle.pending.find((entry) => entry.update_id === commit.update_id);
        if (!existing) {
          const staged = this.resultMemory.stage(commit);
          if (!staged.ok || staged.status === "blocked") return false;
        }
        let reconciled = this.resultMemory.reconcile(commit.update_id);
        if (!reconciled.ok) return false;
        if (reconciled.status === "memory_commit_pending") {
          const applied = this.resultMemory.apply(commit);
          if (!applied.ok) return false;
          reconciled = this.resultMemory.reconcile(commit.update_id);
        }
        if (!reconciled.ok || reconciled.status !== "ready" || !receiptForResultCommit(reconciled.receipt, commit)) return false;
        const identity = shellExecResultMemoryIdentity(observation);
        const expectedValue = commit.changes[0]?.operation === "upsert" ? commit.changes[0].value : null;
        const stored = this.resultMemory.readMemoryRecord(identity.record_id);
        if (!stored?.exists || operationPlanDigest(stored.value) !== operationPlanDigest(expectedValue)) return false;
        if (observation.memory_receipt) {
          if (operationPlanDigest(observation.memory_receipt) !== operationPlanDigest(reconciled.receipt)) return false;
        } else {
          const receipt = reconciled.receipt;
          this.change((state) => {
            const target = state.shell_exec_result_observations?.find((entry) =>
              entry.command_id_digest === observation!.command_id_digest);
            if (!target) throw new Error("plan_shell_result_observation_missing");
            target.memory_receipt = receipt;
          });
        }
      }
      for (const p of this.state.plans) {
        const recoveryHold = this.recoveryHolds.get(operationPlanDigest(p.revisions[0]!.plan.plan_id));
        if (recoveryHold && !this.recoveryHoldAllowsResultMemoryReconciliation(recoveryHold)) continue;
        for (const original of p.bindings) {
          if (!resultMemoryEligible(original)) continue;
          if (!original.execution_admission || !original.delivery_digest) return false;
          let b = this.binding(original.command_id)!.b;
          if (!b.memory_commit) {
            const lifecycle = this.resultMemory.snapshot();
            const stored = this.resultMemory.readMemoryRecord(resultMemoryIdentity(b).record_id);
            if (!lifecycle || lifecycle.status !== "ready" || !stored || stored.exists) return false;
            const commit = buildResultMemoryCommit(p, b, stored.revision);
            this.change((state) => { state.plans.flatMap((entry) => entry.bindings).find((entry) => entry.command_id === b.command_id)!.memory_commit = commit; });
            b = this.binding(b.command_id)!.b;
          }
          if (!verifyResultMemoryCommit(p, b)) return false;
          const commit = b.memory_commit!;
          const lifecycle = this.resultMemory.snapshot();
          if (!lifecycle) return false;
          const existing = lifecycle.pending.find((entry) => entry.update_id === commit.update_id);
          if (!existing) {
            const staged = this.resultMemory.stage(commit);
            if (!staged.ok || staged.status === "blocked") return false;
          }
          let reconciled = this.resultMemory.reconcile(commit.update_id);
          if (!reconciled.ok) return false;
          if (reconciled.status === "memory_commit_pending") {
            const applied = this.resultMemory.apply(commit);
            if (!applied.ok) return false;
            reconciled = this.resultMemory.reconcile(commit.update_id);
          }
          if (!reconciled.ok || reconciled.status !== "ready" || !receiptForResultCommit(reconciled.receipt, commit)) return false;
          const record = this.resultMemory.readMemoryRecord(resultMemoryIdentity(b).record_id);
          if (!record?.exists || operationPlanDigest(record.value) !== operationPlanDigest(commit.changes[0]!.operation === "upsert" ? commit.changes[0]!.value : null)) return false;
          if (b.memory_receipt) {
            if (operationPlanDigest(b.memory_receipt) !== operationPlanDigest(reconciled.receipt)) return false;
          } else {
            const receipt = reconciled.receipt;
            this.change((state) => { state.plans.flatMap((entry) => entry.bindings).find((entry) => entry.command_id === b.command_id)!.memory_receipt = receipt; });
          }
        }
        for (const observation of p.receipt_observations) {
          const planId = p.revisions[0]!.plan.plan_id;
          let delivery = this.receiptMemoryDelivery(planId, observation.evidence_digest);
          if (!delivery) {
            this.change((state) => {
              const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === planId)!;
              target.receipt_memory ??= [];
              target.receipt_memory.push({ evidence_digest: observation.evidence_digest });
            });
            delivery = this.receiptMemoryDelivery(planId, observation.evidence_digest);
          }
          if (!delivery) return false;
          if (!delivery.memory_commit) {
            const lifecycle = this.resultMemory.snapshot();
            const identity = receiptMemoryIdentity(observation);
            const stored = this.resultMemory.readMemoryRecord(identity.record_id);
            if (!lifecycle || lifecycle.status !== "ready" || !stored || stored.exists) return false;
            const commit = buildReceiptMemoryCommit(observation, stored.revision);
            this.change((state) => {
              const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === planId)!;
              const receiptDelivery = target.receipt_memory?.find((entry) => entry.evidence_digest === observation.evidence_digest);
              if (!receiptDelivery) throw new Error("plan_receipt_memory_delivery_missing");
              receiptDelivery.memory_commit = commit;
            });
            delivery = this.receiptMemoryDelivery(planId, observation.evidence_digest);
          }
          if (!delivery?.memory_commit || !verifyReceiptMemoryCommit(observation, delivery)) return false;
          const commit = delivery.memory_commit;
          const lifecycle = this.resultMemory.snapshot();
          if (!lifecycle) return false;
          const existing = lifecycle.pending.find((entry) => entry.update_id === commit.update_id);
          if (!existing) {
            const staged = this.resultMemory.stage(commit);
            if (!staged.ok || staged.status === "blocked") return false;
          }
          let reconciled = this.resultMemory.reconcile(commit.update_id);
          if (!reconciled.ok) return false;
          if (reconciled.status === "memory_commit_pending") {
            const applied = this.resultMemory.apply(commit);
            if (!applied.ok) return false;
            reconciled = this.resultMemory.reconcile(commit.update_id);
          }
          if (!reconciled.ok || reconciled.status !== "ready" ||
              !receiptForReceiptMemoryCommit(reconciled.receipt, commit)) return false;
          const identity = receiptMemoryIdentity(observation);
          const record = this.resultMemory.readMemoryRecord(identity.record_id);
          const expectedValue = commit.changes[0]!.operation === "upsert" ? commit.changes[0]!.value : null;
          if (!record?.exists || operationPlanDigest(record.value) !== operationPlanDigest(expectedValue)) return false;
          if (delivery.memory_receipt) {
            if (operationPlanDigest(delivery.memory_receipt) !== operationPlanDigest(reconciled.receipt)) return false;
          } else {
            const receipt = reconciled.receipt;
            this.change((state) => {
              const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === planId)!;
              const receiptDelivery = target.receipt_memory?.find((entry) => entry.evidence_digest === observation.evidence_digest);
              if (!receiptDelivery) throw new Error("plan_receipt_memory_delivery_missing");
              receiptDelivery.memory_receipt = receipt;
            });
          }
        }
      }
      this.memoryReady = this.resultMemory.snapshot()?.status === "ready";
      return this.memoryReady;
    } catch { return false; }
  }
  /** Executor ackは、Jが後続配送のexact本文を保全した後だけ許す。 */
  resultMemoryIsDurable(command_id: string): boolean {
    try {
      if (this.port && operationPlanDigest(this.port.load()) !== this.savedDigest) return false;
      const match = this.binding(command_id);
      if (!match) return false;
      return !this.resultMemory || !resultMemoryEligible(match.b) || verifyResultMemoryCommit(match.p, match.b);
    } catch { return false; }
  }
  /** A user-visible plan result is released only after its exact M receipt and record are durable. */
  resultMemoryReceiptConfirmed(command_id: string): boolean {
    try {
      if (this.port && operationPlanDigest(this.port.load()) !== this.savedDigest) return false;
      const match = this.binding(command_id);
      if (!match) return false;
      if (this.recoveryHolds.has(operationPlanDigest(match.p.revisions[0]!.plan.plan_id))) return false;
      if (!this.resultMemory || !resultMemoryEligible(match.b)) return true;
      const commit = match.b.memory_commit;
      const savedReceipt = match.b.memory_receipt;
      if (!commit || !savedReceipt || !verifyResultMemoryCommit(match.p, match.b) ||
          !receiptForResultCommit(savedReceipt, commit)) return false;
      const current = this.resultMemory.reconcile(commit.update_id);
      if (!current.ok || current.status !== "ready" ||
          operationPlanDigest(current.receipt) !== operationPlanDigest(savedReceipt) ||
          !receiptForResultCommit(current.receipt, commit)) return false;
      const change = commit.changes[0];
      if (!change || change.operation !== "upsert") return false;
      const record = this.resultMemory.readMemoryRecord(resultMemoryIdentity(match.b).record_id);
      return !!record?.exists && operationPlanDigest(record.value) === operationPlanDigest(change.value);
    } catch { return false; }
  }
  /** Read only the owner's current, M-receipted file.search result; this never reruns the action or grants authority. */
  inspectSavedResultForReturn(control: OperationPlanResultReturnControl, caller: InboundRequest): OperationPlanSavedResultReturnProjection {
    if (this.recoveryRefreshPending) {
      throw new Error("plan_recovery_refresh_hold");
    }
    const plan = this.ownedPlanForOwnerReauthentication(control.plan_id, control.owner_reauthentication, caller);
    const recoveryHold = this.recoveryHolds.get(operationPlanDigest(plan.revisions[0]!.plan.plan_id));
    if (recoveryHold) throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
    if (!this.resultMemory || !this.port || operationPlanDigest(this.port.load()) !== this.savedDigest ||
        this.resultMemory.snapshot()?.status !== "ready") {
      throw new Error("plan_saved_result_memory_unavailable");
    }
    const current = plan.revisions.at(-1)!;
    if (current.digest !== control.revision_digest) throw new Error("plan_saved_result_revision_stale");
    const steps = current.plan.steps.filter((step) => step.step_id === control.step_id ||
      operationPlanDigest(step.step_id) === control.step_id);
    if (steps.length !== 1) throw new Error("plan_saved_result_step_identity_mismatch");
    const step = steps[0]!;
    const bindings = plan.bindings.filter((binding) => binding.step_id === step.step_id && binding.revision_digest === current.digest);
    const binding = bindings.at(-1);
    if (bindings.length !== 1 || !binding || binding.status !== "verified" || binding.operation !== "file.search" ||
        binding.step_digest !== stepDigest(step) || !resultMemoryEligible(binding) || !binding.memory_commit || !binding.memory_receipt ||
        !this.resultMemoryReceiptConfirmed(binding.command_id)) throw new Error("plan_saved_result_not_verified");
    const results = plan.results.filter((result) => result.plan_id === current.plan.plan_id &&
      result.request_id === current.plan.request_id && result.step_id === step.step_id &&
      result.operation === "file.search" && result.status === "succeeded");
    if (results.length !== 1) throw new Error("plan_saved_result_result_unavailable");
    const result = results[0]!;
    const change = binding.memory_commit.changes[0];
    if (!change || change.operation !== "upsert") throw new Error("plan_saved_result_memory_commit_invalid");
    const identity = resultMemoryIdentity(binding);
    const stored = this.resultMemory.readMemoryRecord(identity.record_id);
    if (!stored?.exists || operationPlanDigest(stored.value) !== operationPlanDigest(change.value)) {
      throw new Error("plan_saved_result_record_mismatch");
    }
    const committedObservation = change.value as unknown as Record<string, unknown>;
    if (operationPlanDigest(committedObservation.result) !== operationPlanDigest(result)) {
      throw new Error("plan_saved_result_observation_mismatch");
    }
    const parsedOutput = OperationJsonValueSchema.parse(result.output);
    if (!parsedOutput || typeof parsedOutput !== "object" || Array.isArray(parsedOutput)) {
      throw new Error("plan_saved_result_output_invalid");
    }
    const output = parsedOutput as Record<string, unknown>;
    if (!Number.isSafeInteger(output.visited_files) || (output.visited_files as number) < 0 ||
        !Array.isArray(output.matches) || output.matches.length > 100) throw new Error("plan_saved_result_output_invalid");
    const matches = output.matches.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan_saved_result_output_invalid");
      const match = value as Record<string, unknown>;
      if (typeof match.path !== "string" || match.path.length === 0 || match.path.startsWith("/") || match.path.startsWith("\\") ||
          /^[a-z]:/i.test(match.path) || match.path.split(/[\\/]/).includes("..") ||
          !Number.isSafeInteger(match.line_number) || (match.line_number as number) < 1 ||
          typeof match.line !== "string" || match.line.length > 240) throw new Error("plan_saved_result_output_invalid");
      return { path: match.path, line_number: match.line_number as number, line: match.line };
    });
    if (operationPlanDigest(this.port.load()) !== this.savedDigest || this.resultMemory.snapshot()?.status !== "ready") {
      throw new Error("plan_saved_result_state_changed");
    }
    return {
      schema_version: "operation-plan-saved-result-return.v1",
      plan_id_digest: operationPlanDigest(current.plan.plan_id), revision_digest: current.digest,
      step_id_digest: operationPlanDigest(step.step_id), command_digest: binding.command_digest,
      result_digest: binding.result_digest!, record_digest: operationPlanDigest(stored.value),
      memory_revision: binding.memory_receipt.revision, memory_receipt_digest: binding.memory_receipt.receipt_digest,
      observed_at_ms: result.observed_at_ms, visited_files: output.visited_files as number,
      search_completeness: "unknown", matches, used_as_world_truth: false, used_for_authority: false, may_execute: false,
    };
  }
  bindSavedResultReturn(control: OperationPlanResultReturnControl, caller: InboundRequest, command: ExecuteCommand,
    projection: OperationPlanSavedResultReturnProjection): void {
    if (this.savedResultReturns.size >= 32 || command.type !== "noop" ||
        command.payload.control_event !== "operation_plan_result_return" ||
        command.payload.result_projection_digest !== operationPlanDigest(projection) ||
        operationPlanDigest(this.inspectSavedResultForReturn(control, caller)) !== operationPlanDigest(projection)) {
      throw new Error("plan_saved_result_return_binding_failed");
    }
    this.savedResultReturns.set(command.id, { command_digest: operationPlanDigest(command),
      control: structuredClone(control),
      caller: createGatewayInternalInboundRequest(structuredClone(caller) as GatewayInternalInboundRequestInput),
      projection_digest: operationPlanDigest(projection) });
  }
  readSavedResultReturn(command: ExecuteCommand): OperationPlanSavedResultReturnProjection | undefined {
    try {
      const binding = this.savedResultReturns.get(command.id);
      if (!binding || operationPlanDigest(command) !== binding.command_digest) return undefined;
      const current = this.inspectSavedResultForReturn(binding.control, binding.caller);
      return operationPlanDigest(current) === binding.projection_digest ? current : undefined;
    } catch { return undefined; }
  }
  forgetSavedResultReturn(command_id: string): void { this.savedResultReturns.delete(command_id); }
  receiptObservationMemoryIsDurable(evidence_digest: string): boolean {
    try {
      if (!this.resultMemory || !this.port || operationPlanDigest(this.port.load()) !== this.savedDigest) return false;
      const matches = this.state.plans.flatMap((plan) => plan.receipt_observations
        .filter((observation) => observation.evidence_digest === evidence_digest)
        .map((observation) => ({ plan, observation })));
      if (matches.length !== 1) return false;
      const { plan, observation } = matches[0]!;
      if (this.recoveryHolds.has(operationPlanDigest(plan.revisions[0]!.plan.plan_id))) return false;
      const delivery = this.receiptMemoryDelivery(plan.revisions[0]!.plan.plan_id, evidence_digest);
      if (!delivery?.memory_commit || !delivery.memory_receipt || !verifyReceiptMemoryCommit(observation, delivery) ||
          !receiptForReceiptMemoryCommit(delivery.memory_receipt, delivery.memory_commit)) return false;
      const reconciled = this.resultMemory.reconcile(delivery.memory_commit.update_id);
      if (!reconciled.ok || reconciled.status !== "ready" ||
          operationPlanDigest(reconciled.receipt) !== operationPlanDigest(delivery.memory_receipt)) return false;
      const identity = receiptMemoryIdentity(observation);
      const record = this.resultMemory.readMemoryRecord(identity.record_id);
      const expectedValue = delivery.memory_commit.changes[0]!.operation === "upsert"
        ? delivery.memory_commit.changes[0]!.value : null;
      return !!record?.exists && operationPlanDigest(record.value) === operationPlanDigest(expectedValue);
    } catch { return false; }
  }
  closeMemory(): void {
    this.memoryQuiesced = true;
    this.memoryReady = false;
    this.resultMemory?.close();
    this.resultMemory = undefined;
  }

  /** Read-only Gateway lookup context for the exact owner-selected unresolved file action. */
  prepareOwnerLocalFileStateReceiptRecheckLookup(
    rawReference: OperationPlanComputeSourceObservationReference,
    caller: InboundRequest,
  ): OperationPlanOwnerLocalFileStateReceiptRecheckLookup {
    const reference = OperationPlanComputeSourceObservationReferenceSchema.parse(rawReference);
    if (!("plan_id_digest" in reference) || reference.owner_selected_observation !== "local_file_state" ||
        !isGatewayInternalInboundRequest(caller) || caller.channel !== "webchat" ||
        caller.metadata?.["blue_tanuki.actor_kind"] !== "owner" ||
        caller.metadata?.["blue_tanuki.trust_level"] !== "owner" ||
        caller.metadata?.["blue_tanuki.operator_surface"] !== "developer") {
      throw new Error("owner_gateway_receipt_recheck_authority_invalid");
    }
    if (this.recoveryRefreshPending || this.memoryQuiesced || !this.resultMemory || !this.port || !this.memoryReady ||
        operationPlanDigest(this.port.load()) !== this.savedDigest || this.resultMemory.snapshot()?.status !== "ready" ||
        !this.resultMemory.verify()) throw new Error("owner_gateway_receipt_recheck_unavailable");
    const plans = this.state.plans.filter((candidate) => candidate.revisions[0] &&
      operationPlanDigest(candidate.revisions[0].plan.plan_id) === reference.plan_id_digest);
    if (plans.length !== 1) throw new Error("owner_gateway_receipt_recheck_plan_unavailable");
    const plan = plans[0]!;
    if (plan.owner !== caller.user || plan.channel !== caller.channel || this.recoveryHolds.has(reference.plan_id_digest)) {
      throw new Error("owner_gateway_receipt_recheck_identity_mismatch");
    }
    const revision = plan.revisions.at(-1);
    if (!revision || revision.digest !== reference.revision_digest) throw new Error("owner_gateway_receipt_recheck_revision_stale");
    const steps = revision.plan.steps.filter((step) => operationPlanDigest(step.step_id) === reference.step_id_digest);
    if (steps.length !== 1) throw new Error("owner_gateway_receipt_recheck_step_mismatch");
    const step = steps[0]!;
    const bindings = plan.bindings.filter((binding) => binding.revision_digest === revision.digest && binding.step_id === step.step_id);
    if (bindings.length !== 1) throw new Error("owner_gateway_receipt_recheck_binding_unavailable");
    const binding = bindings[0]!;
    const admission = binding.execution_admission;
    const nowMs = Date.now();
    if (step.operation !== "file.write" || step.parameters?.mode !== "create" ||
        typeof step.parameters.path !== "string" || typeof step.parameters.content !== "string" ||
        binding.operation !== "file.write" || binding.status !== "outcome_unknown" || !admission ||
        binding.step_digest !== stepDigest(step) || !this.goalPurposeBindingIsCurrent(plan.goal_purpose_binding) ||
        !this.computeSourceObservationsAreCurrent(plan, nowMs)) {
      throw new Error("owner_gateway_receipt_recheck_not_owner_resolvable");
    }
    const expectedCommandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", binding.command_id]), "utf8").digest("hex");
    const receiptObservations = plan.receipt_observations.filter((entry) => entry.source === "local_file_state" &&
      entry.plan_id_digest === reference.plan_id_digest && entry.revision_digest === revision.digest &&
      entry.step_id_digest === reference.step_id_digest && entry.command_digest === binding.command_digest);
    const observation = receiptObservations.sort((left, right) => left.observed_at_ms - right.observed_at_ms).at(-1);
    if (!observation || admission.command_digest !== observation.executor_command_digest ||
        admission.command_key !== expectedCommandKey || binding.command_digest !== observation.command_digest ||
        observation.command_key_digest !== createHash("sha256").update(expectedCommandKey, "utf8").digest("hex") ||
        !observation.gateway_execution_receipt_digest || !observation.gateway_execution_receipt_state ||
        observation.gateway_execution_epoch_digest !== createHash("sha256").update(admission.execution_epoch, "utf8").digest("hex") ||
        observation.gateway_task_identity_digest !== admission.task_identity_digest || observation.status !== "matched" ||
        observation.match_count !== 1 || !observation.receipt_digest ||
        observation.target_identity_digest !== fileWriteTargetIdentityDigest(step.parameters.path) ||
        observation.request_payload_digest !== fileWritePayloadDigest(step.parameters.content) ||
        observation.observed_payload_digest !== observation.request_payload_digest || observation.observed_at_ms < admission.issued_at_ms ||
        !this.receiptObservationMemoryIsDurable(observation.evidence_digest) ||
        gatewayExecutionReceiptEvidenceDigest(observation) !== observation.gateway_execution_receipt_digest) {
      throw new Error("owner_gateway_receipt_recheck_observation_stale");
    }
    const expectedEvidence = OperationPlanGatewayReceiptRecheckEvidenceSchema.parse({
      schema_version: "operation-plan-gateway-receipt-recheck.v1",
      plan_id_digest: reference.plan_id_digest,
      revision_digest: revision.digest,
      step_id_digest: reference.step_id_digest,
      command_digest: observation.executor_command_digest,
      command_key_digest: observation.command_key_digest,
      execution_epoch_digest: observation.gateway_execution_epoch_digest,
      task_identity_digest: observation.gateway_task_identity_digest ?? null,
      state: observation.gateway_execution_receipt_state,
      feedback_status: observation.gateway_execution_feedback_status ?? null,
      result_delivery_digest: observation.gateway_result_delivery_digest ?? null,
      result_delivery_acknowledged: observation.gateway_result_delivery_acknowledged ?? null,
      used_for_authority: false,
    });
    return { command_key: admission.command_key, expected_evidence: expectedEvidence };
  }

  /** Issue a short-lived, single-use read-only permit after an owner selects local file-state context. */
  issueOwnerSelectedFileStateObservationAuthorization(
    rawReference: OperationPlanComputeSourceObservationReference,
    caller: InboundRequest,
    nowMs = Date.now(),
  ): OperationPlanOwnerSelectedFileStateObservationAuthorization {
    const reference = OperationPlanComputeSourceObservationReferenceSchema.parse(rawReference);
    if (!("plan_id_digest" in reference) || reference.owner_selected_observation !== "local_file_state" ||
        !Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new Error("plan_compute_source_observation_reference_invalid");
    }
    const lookup = this.prepareOwnerLocalFileStateReceiptRecheckLookup(reference, caller);
    const currentReceipt = OperationPlanGatewayReceiptRecheckEvidenceSchema.safeParse(
      this.gatewayReceiptRechecker?.(lookup.command_key, lookup.expected_evidence),
    );
    if (!currentReceipt.success || operationPlanDigest(currentReceipt.data) !== operationPlanDigest(lookup.expected_evidence)) {
      throw new Error("plan_compute_source_observation_gateway_receipt_recheck_failed");
    }
    const plan = this.state.plans.find((candidate) =>
      operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === reference.plan_id_digest)!;
    const revision = plan.revisions.at(-1)!;
    const step = revision.plan.steps.find((candidate) => operationPlanDigest(candidate.step_id) === reference.step_id_digest)!;
    const binding = plan.bindings.find((candidate) => candidate.revision_digest === revision.digest && candidate.step_id === step.step_id)!;
    const admission = binding.execution_admission!;
    const authorization: OperationPlanOwnerSelectedFileStateObservationAuthorization = {
      authorization_id: randomUUID(),
      caller_user: caller.user,
      caller_channel: caller.channel,
      plan_id_digest: reference.plan_id_digest,
      revision_digest: revision.digest,
      step_id_digest: reference.step_id_digest,
      command_id: binding.command_id,
      command_digest: binding.command_digest,
      executor_command_digest: admission.command_digest,
      command_key: admission.command_key,
      execution_epoch: admission.execution_epoch,
      ...(admission.task_identity_digest ? { task_identity_digest: admission.task_identity_digest } : {}),
      parameters: structuredClone(step.parameters ?? {}),
      expected_gateway_receipt_evidence: lookup.expected_evidence,
      issued_at_ms: nowMs,
      expires_at_ms: nowMs + 30_000,
    };
    for (const [id, pending] of this.ownerSelectedFileStateObservations) {
      if (pending.expires_at_ms <= nowMs) this.ownerSelectedFileStateObservations.delete(id);
    }
    if (this.ownerSelectedFileStateObservations.size >= 128) {
      throw new Error("plan_compute_source_observation_refresh_capacity_reached");
    }
    this.ownerSelectedFileStateObservations.set(authorization.authorization_id, authorization);
    const expiry = setTimeout(() => {
      this.ownerSelectedFileStateObservations.delete(authorization.authorization_id);
    }, 30_000);
    expiry.unref?.();
    return structuredClone(authorization);
  }

  /** Consume the permit and persist only an exact, fresh digest-only sandbox observation. */
  recordOwnerSelectedFileStateObservation(
    authorizationId: string,
    rawObservation: unknown,
    caller: InboundRequest,
    nowMs = Date.now(),
  ): { readonly request_id: string; readonly command_id: string; readonly evidence_digest: string;
      readonly reused: boolean } | null {
    const authorization = this.ownerSelectedFileStateObservations.get(authorizationId);
    this.ownerSelectedFileStateObservations.delete(authorizationId);
    if (!authorization || authorization.caller_user !== caller.user || authorization.caller_channel !== caller.channel ||
        !Number.isSafeInteger(nowMs) || nowMs < authorization.issued_at_ms || nowMs >= authorization.expires_at_ms) return null;
    const reference: OperationPlanComputeSourceObservationReference = {
      plan_id_digest: authorization.plan_id_digest,
      revision_digest: authorization.revision_digest,
      step_id_digest: authorization.step_id_digest,
      owner_selected_observation: "local_file_state",
    };
    let lookup: OperationPlanOwnerLocalFileStateReceiptRecheckLookup;
    try { lookup = this.prepareOwnerLocalFileStateReceiptRecheckLookup(reference, caller); }
    catch { return null; }
    if (lookup.command_key !== authorization.command_key ||
        operationPlanDigest(lookup.expected_evidence) !== operationPlanDigest(authorization.expected_gateway_receipt_evidence)) {
      return null;
    }
    const latestReceipt = OperationPlanGatewayReceiptRecheckEvidenceSchema.safeParse(
      this.gatewayReceiptRechecker?.(lookup.command_key, lookup.expected_evidence),
    );
    if (!latestReceipt.success || operationPlanDigest(latestReceipt.data) !== operationPlanDigest(lookup.expected_evidence)) return null;
    const parsed = OperationPlanExternalReceiptObservationSchema.safeParse(rawObservation);
    if (!parsed.success) return null;
    const observation = parsed.data;
    const observationReceipt = OperationPlanGatewayReceiptRecheckEvidenceSchema.safeParse({
      schema_version: "operation-plan-gateway-receipt-recheck.v1",
      plan_id_digest: observation.plan_id_digest,
      revision_digest: observation.revision_digest,
      step_id_digest: observation.step_id_digest,
      command_digest: observation.executor_command_digest,
      command_key_digest: observation.command_key_digest,
      execution_epoch_digest: observation.gateway_execution_epoch_digest,
      task_identity_digest: observation.gateway_task_identity_digest ?? null,
      state: observation.gateway_execution_receipt_state,
      feedback_status: observation.gateway_execution_feedback_status ?? null,
      result_delivery_digest: observation.gateway_result_delivery_digest ?? null,
      result_delivery_acknowledged: observation.gateway_result_delivery_acknowledged ?? null,
      used_for_authority: false,
    });
    if (observation.source !== "local_file_state" || observation.observed_at_ms < authorization.issued_at_ms ||
        !observationReceipt.success ||
        operationPlanDigest(observationReceipt.data) !== operationPlanDigest(authorization.expected_gateway_receipt_evidence) ||
        gatewayExecutionReceiptEvidenceDigest(observation) !== observation.gateway_execution_receipt_digest) return null;
    let recorded: { request_id: string; command_id: string } | null;
    try { recorded = this.recordExternalReceiptObservation(observation, caller); }
    catch { return null; }
    if (recorded) return { ...recorded, evidence_digest: observation.evidence_digest, reused: false };

    // recordExternalReceiptObservationは、command/evidenceが既に保存済みの場合にnullを返す。
    // ここまでに単回permit、最新receiptの再照合、新しいローカル読取は完了している。
    // 同一の未解決stepに結び付く同じdigest-only証拠だけを再利用する。
    const plans = this.state.plans.filter((plan) =>
      operationPlanDigest(plan.revisions[0]!.plan.plan_id) === authorization.plan_id_digest);
    if (plans.length !== 1) return null;
    const plan = plans[0]!;
    const steps = plan.revisions.at(-1)!.plan.steps.filter((step) =>
      operationPlanDigest(step.step_id) === authorization.step_id_digest);
    if (steps.length !== 1) return null;
    const existingObservations = plan.receipt_observations.filter((entry) =>
      entry.source === "local_file_state" && entry.revision_digest === authorization.revision_digest &&
      entry.step_id_digest === authorization.step_id_digest && entry.command_digest === authorization.command_digest &&
      entry.evidence_digest === observation.evidence_digest);
    if (existingObservations.length !== 1) return null;
    const bindings = plan.bindings.filter((entry) => entry.command_id === authorization.command_id &&
      entry.revision_digest === authorization.revision_digest && entry.step_id === steps[0]!.step_id);
    if (bindings.length !== 1) return null;
    const existing = existingObservations[0]!;
    const { evidence_digest: existingDigest, observed_at_ms: existingAt, ...existingEvidence } = existing;
    const { evidence_digest: currentDigest, observed_at_ms: currentAt, ...currentEvidence } = observation;
    if (existingDigest !== currentDigest || existingAt > currentAt ||
        operationPlanDigest(existingEvidence) !== existingDigest ||
        operationPlanDigest(currentEvidence) !== currentDigest) return null;
    return { request_id: bindings[0]!.request_id, command_id: bindings[0]!.command_id,
      evidence_digest: existingDigest, reused: true };
  }

  /** Resolve explicit references to durable, J-verified file action observations without exposing targets or content. */
  inspectComputeSourceObservations(
    rawReferences: readonly OperationPlanComputeSourceObservationReference[],
    caller: InboundRequest,
  ): OperationPlanComputeSourceObservation[] {
    const references = rawReferences.map((reference) => OperationPlanComputeSourceObservationReferenceSchema.parse(reference));
    if (references.length === 0) return [];
    if (references.length > 8 || this.recoveryRefreshPending || this.memoryQuiesced || !this.resultMemory || !this.port ||
        !this.memoryReady || operationPlanDigest(this.port.load()) !== this.savedDigest ||
        this.resultMemory.snapshot()?.status !== "ready" || !this.resultMemory.verify()) {
      throw new Error("plan_compute_source_observation_memory_unavailable");
    }
    const referenceKeys = references.map((reference) =>
      "command_id_digest" in reference ? `shell:${reference.command_id_digest}`
        : `plan:${reference.plan_id_digest}:${reference.revision_digest}:${reference.step_id_digest}`);
    if (new Set(referenceKeys).size !== referenceKeys.length) {
      throw new Error("plan_compute_source_observation_reference_invalid");
    }
    const observations: OperationPlanComputeSourceObservation[] = [];
    const inspectedAtMs = Date.now();
    for (const reference of references) {
      if ("command_id_digest" in reference) {
        const matches = (this.state.shell_exec_result_observations ?? []).filter((entry) =>
          entry.command_id_digest === reference.command_id_digest &&
          entry.owner_digest === operationPlanDigest(caller.user) && entry.channel_digest === operationPlanDigest(caller.channel));
        if (matches.length !== 1) throw new Error("plan_compute_shell_result_unavailable");
        const entry = matches[0]!;
        if (!entry.memory_commit || !entry.memory_receipt || !verifyShellExecResultMemoryCommit(entry) ||
            !receiptForResultCommit(entry.memory_receipt, entry.memory_commit)) {
          throw new Error("plan_compute_shell_result_not_verified");
        }
        const reconciled = this.resultMemory.reconcile(entry.memory_commit.update_id);
        if (!reconciled.ok || reconciled.status !== "ready" ||
            !receiptForResultCommit(reconciled.receipt, entry.memory_commit) ||
            operationPlanDigest(reconciled.receipt) !== operationPlanDigest(entry.memory_receipt)) {
          throw new Error("plan_compute_shell_result_receipt_unavailable");
        }
        const identity = shellExecResultMemoryIdentity(entry);
        const stored = this.resultMemory.readMemoryRecord(identity.record_id);
        const expectedValue = entry.memory_commit.changes[0]?.operation === "upsert"
          ? entry.memory_commit.changes[0].value : undefined;
        if (!stored?.exists || expectedValue === undefined || operationPlanDigest(stored.value) !== operationPlanDigest(expectedValue)) {
          throw new Error("plan_compute_shell_result_record_mismatch");
        }
        observations.push(OperationPlanComputeSourceObservationSchema.parse({
          schema_version: "operation-plan-compute-source-observation.v1",
          source: "verified_shell_exec_result",
          operation: "shell.exec",
          task_identity_digest: operationPlanDigest({ schema_version: "shell-exec-result-task-identity.v1",
            owner_digest: entry.owner_digest, channel_digest: entry.channel_digest,
            request_id_digest: entry.request_id_digest, command_id_digest: entry.command_id_digest }),
          effect_observation: "reported_success",
          record_digest: operationPlanDigest(stored.value),
          memory_revision: entry.memory_receipt.revision,
          memory_receipt_digest: entry.memory_receipt.receipt_digest,
          observed_at_ms: entry.observed_at_ms,
          command_id_digest: entry.command_id_digest,
          request_id_digest: entry.request_id_digest,
          upstream_commit_hash_digest: entry.upstream_commit_hash_digest,
          command_payload_digest: entry.command_payload_digest,
          result_id_digest: entry.result_id_digest,
          result_contract_digest: entry.result_contract_digest,
          result_digest: entry.result_digest,
          execution_status: entry.execution_status,
          execution_boundary: entry.execution_boundary,
          action_outcome: entry.action_outcome,
          adoption_status: "observation_only",
          used_as_world_truth: false,
          used_for_authority: false,
          may_execute: false,
        }));
        continue;
      }
      const matches = this.state.plans.filter((plan) =>
        operationPlanDigest(plan.revisions[0]!.plan.plan_id) === reference.plan_id_digest);
      if (matches.length !== 1) throw new Error("plan_compute_source_observation_unavailable");
      const plan = matches[0]!;
      if (plan.owner !== caller.user || plan.channel !== caller.channel) {
        throw new Error("plan_compute_source_observation_identity_mismatch");
      }
      if (this.recoveryHolds.has(reference.plan_id_digest)) {
        throw new Error("plan_compute_source_observation_recovery_hold");
      }
      const revision = plan.revisions.at(-1);
      if (!revision || revision.digest !== reference.revision_digest) {
        throw new Error("plan_compute_source_observation_stale");
      }
      const steps = revision.plan.steps.filter((step) => operationPlanDigest(step.step_id) === reference.step_id_digest);
      if (steps.length !== 1) throw new Error("plan_compute_source_observation_step_mismatch");
      const step = steps[0]!;
      const bindings = plan.bindings.filter((binding) =>
        binding.revision_digest === revision.digest && binding.step_id === step.step_id);
      if (bindings.length !== 1) throw new Error("plan_compute_source_observation_binding_unavailable");
      const binding = bindings[0]!;
      const operation = step.operation;
      if (reference.owner_selected_observation === "local_file_state") {
        if (operation !== "file.write" || binding.operation !== "file.write" || binding.status !== "outcome_unknown" ||
            !binding.execution_admission || binding.step_digest !== stepDigest(step) ||
            !this.goalPurposeBindingIsCurrent(plan.goal_purpose_binding) ||
            !this.computeSourceObservationsAreCurrent(plan, inspectedAtMs) ||
            step.parameters?.mode !== "create" || typeof step.parameters.path !== "string" ||
            typeof step.parameters.content !== "string") {
          throw new Error("plan_compute_source_observation_not_owner_resolvable");
        }
        const admission = binding.execution_admission;
        const expectedCommandKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", binding.command_id]), "utf8").digest("hex");
        const receiptObservations = plan.receipt_observations.filter((entry) => entry.source === "local_file_state" &&
          entry.plan_id_digest === reference.plan_id_digest && entry.revision_digest === revision.digest &&
          entry.step_id_digest === reference.step_id_digest && entry.command_digest === binding.command_digest);
        const observation = receiptObservations.sort((left, right) => left.observed_at_ms - right.observed_at_ms).at(-1);
        if (admission.command_digest !== observation?.executor_command_digest || admission.command_key !== expectedCommandKey ||
            binding.command_digest !== observation?.command_digest ||
            observation?.command_key_digest !== createHash("sha256").update(expectedCommandKey, "utf8").digest("hex") ||
            !observation.gateway_execution_receipt_digest || !observation.gateway_execution_receipt_state ||
            observation.gateway_execution_epoch_digest !== createHash("sha256").update(admission.execution_epoch, "utf8").digest("hex") ||
            observation.gateway_task_identity_digest !== admission.task_identity_digest ||
            observation.status !== "matched" || observation.match_count !== 1 || !observation.receipt_digest ||
            observation.target_identity_digest !== fileWriteTargetIdentityDigest(step.parameters.path) ||
            observation.request_payload_digest !== fileWritePayloadDigest(step.parameters.content) ||
            observation.observed_payload_digest !== observation.request_payload_digest ||
            observation.observed_at_ms < admission.issued_at_ms ||
            !this.receiptObservationMemoryIsDurable(observation.evidence_digest)) {
          throw new Error("plan_compute_source_observation_owner_resolution_stale");
        }
        const lookup = this.prepareOwnerLocalFileStateReceiptRecheckLookup(reference, caller);
        const rawRecheck = this.gatewayReceiptRechecker?.(lookup.command_key, lookup.expected_evidence);
        const gatewayReceiptRecheck = OperationPlanGatewayReceiptRecheckEvidenceSchema.safeParse(rawRecheck);
        if (!gatewayReceiptRecheck.success ||
            operationPlanDigest(gatewayReceiptRecheck.data) !== operationPlanDigest(lookup.expected_evidence)) {
          throw new Error("plan_compute_source_observation_gateway_receipt_recheck_failed");
        }
        const delivery = this.receiptMemoryDelivery(revision.plan.plan_id, observation.evidence_digest);
        const stored = delivery?.memory_commit && this.resultMemory
          ? this.resultMemory.readMemoryRecord(receiptMemoryIdentity(observation).record_id) : null;
        const expectedValue = delivery?.memory_commit?.changes[0]?.operation === "upsert"
          ? delivery.memory_commit.changes[0].value : undefined;
        if (!delivery?.memory_commit || !delivery.memory_receipt || expectedValue === undefined || !stored?.exists ||
            operationPlanDigest(stored.value) !== operationPlanDigest(expectedValue) ||
            !verifyReceiptMemoryCommit(observation, delivery) ||
            !receiptForReceiptMemoryCommit(delivery.memory_receipt, delivery.memory_commit)) {
          throw new Error("plan_compute_source_observation_owner_resolution_memory_unavailable");
        }
        const ownerSelectionDigest = operationPlanDigest({
          schema_version: "owner-selected-local-file-state.v1",
          owner_digest: operationPlanDigest(caller.user),
          channel_digest: operationPlanDigest(caller.channel),
          plan_id_digest: reference.plan_id_digest,
          revision_digest: reference.revision_digest,
          step_id_digest: reference.step_id_digest,
          observation_digest: observation.evidence_digest,
          decision: "use_as_non_authority_candidate_context",
        });
        observations.push(OperationPlanComputeSourceObservationSchema.parse({
          schema_version: "operation-plan-compute-source-observation.v1",
          source: "owner_selected_local_file_state",
          operation: "file.write",
          plan_id_digest: reference.plan_id_digest,
          task_identity_digest: operationPlanTaskIdentityDigest(plan),
          revision_digest: revision.digest,
          step_id_digest: reference.step_id_digest,
          plan_binding_status: "outcome_unknown",
          plan_validation_status: "owner_selected_observation",
          command_digest: binding.command_digest,
          execution_admission_digest: operationPlanDigest(admission),
          gateway_execution_receipt_digest: observation.gateway_execution_receipt_digest!,
          gateway_execution_receipt_state: observation.gateway_execution_receipt_state!,
          gateway_execution_epoch_digest: observation.gateway_execution_epoch_digest!,
          ...(observation.gateway_task_identity_digest ? { gateway_task_identity_digest: observation.gateway_task_identity_digest } : {}),
          ...(observation.gateway_execution_feedback_status
            ? { gateway_execution_feedback_status: observation.gateway_execution_feedback_status } : {}),
          ...(observation.gateway_result_delivery_digest
            ? { gateway_result_delivery_digest: observation.gateway_result_delivery_digest } : {}),
          ...(observation.gateway_result_delivery_acknowledged !== undefined
            ? { gateway_result_delivery_acknowledged: observation.gateway_result_delivery_acknowledged } : {}),
          ...(binding.result_digest ? { result_digest: binding.result_digest } : {}),
          ...(binding.delivery_digest ? { delivery_digest: binding.delivery_digest } : {}),
          observation_digest: observation.evidence_digest,
          observation_status: "matched",
          target_identity_digest: observation.target_identity_digest,
          effect_observation: "observed_target_state",
          record_digest: operationPlanDigest(stored.value),
          memory_revision: delivery.memory_receipt.revision,
          memory_receipt_digest: delivery.memory_receipt.receipt_digest,
          observed_at_ms: observation.observed_at_ms,
          owner_selection_digest: ownerSelectionDigest,
          adoption_status: "observation_only",
          used_as_world_truth: false,
          used_for_authority: false,
          may_execute: false,
        }));
        continue;
      }
      if ((operation !== "file.write" && operation !== "file.delete" && operation !== "file.edit" && operation !== "file.search") ||
          binding.operation !== operation || binding.status !== "verified" ||
          binding.step_digest !== stepDigest(step) || !binding.execution_admission || !binding.delivery_digest ||
          !binding.result_digest || !binding.memory_commit || !binding.memory_receipt ||
          !verifyResultMemoryCommit(plan, binding) || !receiptForResultCommit(binding.memory_receipt, binding.memory_commit)) {
        throw new Error("plan_compute_source_observation_not_verified");
      }
      const result = plan.results.find((candidate) => candidate.plan_id === revision.plan.plan_id &&
        candidate.request_id === revision.plan.request_id && candidate.step_id === step.step_id &&
        candidate.operation === operation && candidate.status === "succeeded");
      if (!result || result.observed_at_ms > inspectedAtMs) throw new Error("plan_compute_source_observation_result_unavailable");
      if (operation === "file.search" && inspectedAtMs >= result.expires_at_ms) {
        throw new Error("plan_compute_source_observation_expired");
      }
      const reconciled = this.resultMemory.reconcile(binding.memory_commit.update_id);
      if (!reconciled.ok || reconciled.status !== "ready" ||
          !receiptForResultCommit(reconciled.receipt, binding.memory_commit) ||
          operationPlanDigest(reconciled.receipt) !== operationPlanDigest(binding.memory_receipt)) {
        throw new Error("plan_compute_source_observation_receipt_unavailable");
      }
      const identity = resultMemoryIdentity(binding);
      const stored = this.resultMemory.readMemoryRecord(identity.record_id);
      const committed = binding.memory_commit.changes[0];
      const expected = committed?.operation === "upsert" ? committed.value : undefined;
      if (!stored?.exists || expected === undefined || operationPlanDigest(stored.value) !== operationPlanDigest(expected)) {
        throw new Error("plan_compute_source_observation_record_mismatch");
      }
      const common = {
        schema_version: "operation-plan-compute-source-observation.v1" as const,
        plan_id_digest: reference.plan_id_digest,
        task_identity_digest: operationPlanTaskIdentityDigest(plan),
        revision_digest: revision.digest,
        step_id_digest: reference.step_id_digest,
        plan_binding_status: "verified" as const,
        plan_validation_status: "matched" as const,
        effect_observation: "reported_success" as const,
        record_digest: operationPlanDigest(stored.value),
        memory_revision: binding.memory_receipt.revision,
        memory_receipt_digest: binding.memory_receipt.receipt_digest,
        observed_at_ms: result.observed_at_ms,
        adoption_status: "observation_only" as const,
        used_as_world_truth: false as const,
        used_for_authority: false as const,
        may_execute: false as const,
      };
      if (operation === "file.write" || operation === "file.delete" || operation === "file.edit") {
        observations.push(OperationPlanComputeSourceObservationSchema.parse({
          ...common,
          source: operation === "file.write" ? "verified_file_write_result" :
            operation === "file.delete" ? "verified_file_delete_result" : "verified_file_edit_result",
          operation,
        }));
      } else {
        const output = result.output;
        if (!output || typeof output !== "object" || Array.isArray(output) || !Array.isArray(output.matches) ||
            typeof output.visited_files !== "number" || !Number.isSafeInteger(output.visited_files) || output.visited_files < 0) {
          throw new Error("plan_compute_source_observation_result_unavailable");
        }
        observations.push(OperationPlanComputeSourceObservationSchema.parse({
          ...common, source: "verified_file_search_result", operation,
          expires_at_ms: result.expires_at_ms, match_count: output.matches.length,
          visited_files: output.visited_files, search_completeness: "unknown",
        }));
      }
    }
    if (operationPlanDigest(this.port.load()) !== this.savedDigest || this.resultMemory.snapshot()?.status !== "ready") {
      throw new Error("plan_compute_source_observation_stale");
    }
    if (observations.some((observation) => observation.source === "verified_file_search_result" &&
        Date.now() >= observation.expires_at_ms)) throw new Error("plan_compute_source_observation_expired");
    return observations;
  }

  /** 同仕事・現版の受領済み観測だけをJが選択する。全履歴やraw検索内容をCへ渡さない。 */
  inspectReflection(control: OperationPlanReflectionControl, caller: InboundRequest): ResultObservationProjection {
    if (this.recoveryRefreshPending || !this.resultMemory || !this.port || operationPlanDigest(this.port.load()) !== this.savedDigest ||
        this.resultMemory.snapshot()?.status !== "ready") throw new Error("plan_reflection_memory_unavailable");
    const p = this.ownedPlan(control.plan_id, caller);
    const current = p.revisions.at(-1)!;
    if (current.digest !== control.revision_digest) throw new Error("plan_revision_changed");
    const ids = new Set<string>();
    const citations: ResultObservationCitation[] = [];
    for (const id of control.step_ids) {
      const steps = current.plan.steps.filter((step) => step.step_id === id || operationPlanDigest(step.step_id) === id);
      if (steps.length !== 1 || ids.has(steps[0]!.step_id)) throw new Error("plan_reflection_step_identity_mismatch");
      const step = steps[0]!; ids.add(step.step_id);
      const bindings = p.bindings.filter((b) => b.step_id === step.step_id && b.revision_digest === current.digest);
      const b = bindings[0];
      if (bindings.length !== 1 || !b || b.step_digest !== stepDigest(step)) throw new Error("plan_reflection_observation_not_current");
      if (b.status === "outcome_unknown") {
        const observations = p.receipt_observations.filter((entry) => entry.revision_digest === current.digest &&
          entry.step_id_digest === operationPlanDigest(step.step_id) && entry.command_digest === b.command_digest &&
          entry.executor_command_digest === b.execution_admission?.command_digest);
        const observation = observations.at(-1);
        if (!b.execution_admission || !observation || observations.length === 0 ||
            !this.receiptObservationMemoryIsDurable(observation.evidence_digest)) {
          throw new Error("plan_reflection_receipt_observation_not_current");
        }
        const delivery = this.receiptMemoryDelivery(current.plan.plan_id, observation.evidence_digest);
        const identity = receiptMemoryIdentity(observation);
        const record = this.resultMemory.readMemoryRecord(identity.record_id);
        const expectedValue = receiptMemoryObservation(observation);
        if (!delivery?.memory_receipt || !record?.exists || operationPlanDigest(record.value) !== operationPlanDigest(expectedValue)) {
          throw new Error("plan_reflection_record_mismatch");
        }
        if (observation.source === "local_file_state" && observation.status === "ambiguous") {
          throw new Error("plan_reflection_file_state_observation_invalid");
        }
        citations.push(observation.source === "local_file_state" ? {
          evidence_type: "file_state", record_id: identity.record_id, record_digest: operationPlanDigest(record.value),
          memory_revision: delivery.memory_receipt.revision, receipt_digest: delivery.memory_receipt.receipt_digest,
          source_revision_digest: current.digest, step_digest: b.step_digest, observed_at_ms: observation.observed_at_ms,
          evidence_digest: observation.evidence_digest, operation: "file.write",
          observation: { source: "local_file_state", inspection_status: observation.status as "matched" | "not_found" | "mismatch",
            match_count: observation.match_count, target_identity_digest: observation.target_identity_digest!,
            ...(observation.observed_payload_digest ? { observed_payload_digest: observation.observed_payload_digest } : {}),
            ...(observation.receipt_digest ? { file_state_digest: observation.receipt_digest } : {}),
            action_outcome: "outcome_unknown" }, adoption_status: "observation_only", counterevidence_status: "not_assessed",
          used_as_world_truth: false, used_for_authority: false, may_execute: false,
        } : {
          evidence_type: "external_receipt", record_id: identity.record_id, record_digest: operationPlanDigest(record.value),
          memory_revision: delivery.memory_receipt.revision, receipt_digest: delivery.memory_receipt.receipt_digest,
          source_revision_digest: current.digest, step_digest: b.step_digest, observed_at_ms: observation.observed_at_ms,
          evidence_digest: observation.evidence_digest, operation: step.operation,
          observation: { source: "local_inspection", reconciliation_status: observation.status,
            match_count: observation.match_count, ...(observation.receipt_digest ? { observed_receipt_digest: observation.receipt_digest } : {}),
            action_outcome: "outcome_unknown" }, adoption_status: "observation_only", counterevidence_status: "not_assessed",
          used_as_world_truth: false, used_for_authority: false, may_execute: false,
        });
        continue;
      }
      if (b.operation !== "file.search") throw new Error("plan_reflection_operation_not_supported");
      if (b.status !== "verified" || !b.memory_commit || !b.memory_receipt || !verifyResultMemoryCommit(p, b) ||
          !receiptForResultCommit(b.memory_receipt, b.memory_commit)) throw new Error("plan_reflection_observation_not_current");
      const receipt = this.resultMemory.reconcile(b.memory_commit.update_id);
      if (!receipt.ok || receipt.status !== "ready" || operationPlanDigest(receipt.receipt) !== operationPlanDigest(b.memory_receipt)) {
        throw new Error("plan_reflection_record_mismatch");
      }
      const record = this.resultMemory.readMemoryRecord(resultMemoryIdentity(b).record_id);
      const value = b.memory_commit.changes[0]!;
      if (!record?.exists || value.operation !== "upsert" || operationPlanDigest(record.value) !== operationPlanDigest(value.value)) {
        throw new Error("plan_reflection_record_mismatch");
      }
      const result = p.results.find((r) => r.step_id === b.step_id)!;
      if (!result || Date.now() < result.observed_at_ms || Date.now() >= result.expires_at_ms) throw new Error("plan_reflection_observation_expired");
      const output = result.output;
      if (!output || typeof output !== "object" || Array.isArray(output) || !Array.isArray(output.matches) ||
          typeof output.visited_files !== "number" || !Number.isSafeInteger(output.visited_files) || output.visited_files < 0) {
        throw new Error("plan_reflection_summary_not_available");
      }
      citations.push({ evidence_type: "file_search", record_id: resultMemoryIdentity(b).record_id,
        record_digest: operationPlanDigest(record.value), memory_revision: b.memory_receipt.revision, receipt_digest: b.memory_receipt.receipt_digest,
        source_revision_digest: b.revision_digest, step_digest: b.step_digest, delivery_digest: b.delivery_digest!,
        observed_at_ms: result.observed_at_ms, expires_at_ms: result.expires_at_ms, operation: "file.search",
        observation: { reported_status: "succeeded", match_count: output.matches.length,
          visited_files: output.visited_files, completeness: "unknown" }, adoption_status: "observation_only",
        counterevidence_status: "not_assessed", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    }
    return { schema_version: "operation-result-current-projection.v2", scope: { plan_handle: operationPlanDigest(current.plan.plan_id),
      task_identity_digest: operationPlanTaskIdentityDigest(p),
      revision_digest: current.digest, owner_digest: operationPlanDigest(p.owner), channel_digest: operationPlanDigest(p.channel) },
      citations, used_for_authority: false, memory_adoption: false, may_execute: false };
  }
  bindReflection(control: OperationPlanReflectionControl, caller: InboundRequest, command: ExecuteCommand,
    projection: ResultObservationProjection): void {
    if (this.reflections.size >= 32 || command.type !== "llm_call" || command.payload.session_id ||
        command.payload.compute_context?.local_p_version !== OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION ||
        command.payload.compute_context.projection_digest !== operationPlanDigest(projection) ||
        operationPlanDigest(this.inspectReflection(control, caller)) !== operationPlanDigest(projection)) throw new Error("plan_reflection_binding_failed");
    this.reflections.set(command.id, { command_digest: operationPlanDigest(command), control: structuredClone(control),
      caller: structuredClone(caller), projection_digest: operationPlanDigest(projection) });
  }
  readReflection(command: ExecuteCommand): ResultObservationProjection | undefined {
    try {
      const binding = this.reflections.get(command.id);
      if (!binding || operationPlanDigest(command) !== binding.command_digest) return undefined;
      const current = this.inspectReflection(binding.control, binding.caller);
      return operationPlanDigest(current) === binding.projection_digest ? current : undefined;
    } catch { return undefined; }
  }
  forgetReflection(command_id: string): void { this.reflections.delete(command_id); }

  /** Persist read-only receipt evidence without changing an operation's J-owned outcome. */
  recordExternalReceiptObservation(value: unknown, caller: InboundRequest): { request_id: string; command_id: string } | null {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const observation = OperationPlanExternalReceiptObservationSchema.parse(value);
    const { evidence_digest, observed_at_ms, ...evidence } = observation;
    if (operationPlanDigest(evidence) !== evidence_digest || observed_at_ms > Date.now() + 30_000) {
      throw new Error("external_receipt_observation_integrity_failed");
    }
    const matches = this.state.plans.filter((plan) => operationPlanDigest(plan.revisions[0]!.plan.plan_id) === observation.plan_id_digest);
    const plan = matches[0];
    if (matches.length !== 1 || !plan || plan.owner !== caller.user || plan.channel !== caller.channel) {
      throw new Error("external_receipt_observation_owner_mismatch");
    }
    const revision = plan.revisions.at(-1)!;
    if (revision.digest !== observation.revision_digest) throw new Error("external_receipt_observation_stale_revision");
    const steps = revision.plan.steps.filter((step) => operationPlanDigest(step.step_id) === observation.step_id_digest);
    if (steps.length !== 1) throw new Error("external_receipt_observation_step_mismatch");
    const step = steps[0]!;
    const binding = plan.bindings.filter((entry) => entry.step_id === step.step_id && entry.revision_digest === revision.digest).at(-1);
    if (!binding || binding.status !== "outcome_unknown" || !binding.execution_admission ||
        binding.command_digest !== observation.command_digest ||
        binding.execution_admission.command_digest !== observation.executor_command_digest ||
        observation.command_key_digest !== createHash("sha256").update(binding.execution_admission.command_key, "utf8").digest("hex") ||
        observed_at_ms < binding.execution_admission.issued_at_ms) {
      throw new Error("external_receipt_observation_command_mismatch");
    }
    if (observation.source === "local_file_state") {
      const parameters = step.parameters ?? {};
      const admission = binding.execution_admission;
      const gatewayReceiptDigest = observation.gateway_execution_receipt_digest;
      const gatewayReceiptState = observation.gateway_execution_receipt_state;
      const gatewayExecutionEpochDigest = createHash("sha256").update(admission.execution_epoch, "utf8").digest("hex");
      if (step.operation !== "file.write" || parameters.mode !== "create" ||
          typeof parameters.path !== "string" || typeof parameters.content !== "string" ||
          observation.target_identity_digest !== fileWriteTargetIdentityDigest(parameters.path) ||
          observation.request_payload_digest !== fileWritePayloadDigest(parameters.content) ||
          !gatewayReceiptDigest || !gatewayReceiptState ||
          observation.gateway_execution_epoch_digest !== gatewayExecutionEpochDigest ||
          observation.gateway_task_identity_digest !== admission.task_identity_digest ||
          gatewayExecutionReceiptEvidenceDigest(observation) !== gatewayReceiptDigest) {
        throw new Error("file_write_state_observation_binding_mismatch");
      }
    } else if (step.operation !== "gmail.write" || step.parameters?.operation !== "message.send") {
      throw new Error("external_receipt_observation_operation_mismatch");
    }
    if (plan.receipt_observations.some((entry) => entry.command_digest === binding.command_digest &&
        entry.evidence_digest === evidence_digest)) return null;
    if (plan.receipt_observations.length >= 100) throw new Error("external_receipt_observation_capacity_reached");
    this.change((state) => {
      const target = state.plans.find((entry) => entry.revisions[0]!.plan.plan_id === plan.revisions[0]!.plan.plan_id)!;
      target.receipt_observations.push(observation);
    });
    return { request_id: binding.request_id, command_id: binding.command_id };
  }

  private readResultMemoryApproval(reference: JMemoryApprovalReference): unknown {
    if (!this.port || operationPlanDigest(this.port.load()) !== this.savedDigest) return null;
    for (const observation of this.state.shell_exec_result_observations ?? []) {
      const commit = observation.memory_commit;
      if (commit && commit.update_id === reference.update_id && commit.j_event_id === reference.j_event_id &&
          commit.content_digest === reference.content_digest && verifyShellExecResultMemoryCommit(observation)) {
        return Object.freeze({ ...reference });
      }
    }
    for (const p of this.state.plans) {
      for (const b of p.bindings) {
        const c = b.memory_commit;
        if (c && c.update_id === reference.update_id && c.j_event_id === reference.j_event_id &&
            c.content_digest === reference.content_digest && verifyResultMemoryCommit(p, b)) return Object.freeze({ ...reference });
      }
      for (const observation of p.receipt_observations) {
        const delivery = this.receiptMemoryDelivery(p.revisions[0]!.plan.plan_id, observation.evidence_digest);
        const c = delivery?.memory_commit;
        if (c && c.update_id === reference.update_id && c.j_event_id === reference.j_event_id &&
            c.content_digest === reference.content_digest && verifyReceiptMemoryCommit(observation, delivery)) {
          return Object.freeze({ ...reference });
        }
      }
    }
    return null;
  }

  private receiptMemoryDelivery(planId: string, evidenceDigest: string): NonNullable<PlanState["receipt_memory"]>[number] | undefined {
    return this.state.plans.find((plan) => plan.revisions[0]!.plan.plan_id === planId)?.receipt_memory
      ?.find((delivery) => delivery.evidence_digest === evidenceDigest);
  }

  /** 起動時の私有結果調停。inflightや承認を復元せず、作用を一切呼ばない。 */
  reconcileResult(value: ExecutionResultDelivery, delivery_digest: string): boolean {
    if (this.recoveryRefreshPending) return false;
    const delivery = inspectExecutionResultDelivery(value);
    if (createHash("sha256").update(JSON.stringify(delivery)).digest("hex") !== delivery_digest) throw new Error("plan_delivery_digest_mismatch");
    const match = this.binding(delivery.feedback.command_id);
    if (!match?.b.execution_admission) return false;
    const { b, p } = match;
    if (operationPlanDigest(b.execution_admission) !== operationPlanDigest(delivery.admission)) throw new Error("plan_delivery_admission_mismatch");
    if (b.delivery_digest) {
      if (b.delivery_digest !== delivery_digest) throw new Error("plan_delivery_identity_conflict");
      return true;
    }
    const fb = delivery.feedback;
    const result = inspectOperationCommandExecutionResult(fb.operation_core_result, {
      request_id: b.request_id, command_id: b.command_id, upstream_commit_hash: b.commit_hash, status: fb.status, operation: b.operation,
    });
    if (!result || result.command_payload_digest !== b.payload_digest || result.observed_at_ms < delivery.admission.issued_at_ms ||
        result.observed_at_ms > Date.now() || (fb.result === undefined ? result.output_digest !== undefined :
          createHash("sha256").update(JSON.stringify(fb.result)).digest("hex") !== result.output_digest)) throw new Error("plan_delivery_result_mismatch");
    if (["intent_committed", "outcome_unknown"].includes(b.status) && !b.result_digest) {
      this.applyResult(match, fb, delivery_digest);
      return true;
    }
    if (b.result_digest !== operationPlanDigest(result)) throw new Error("plan_delivery_result_conflict");
    if (b.status === "verified") {
      const saved = p.results.find((r) => r.step_id === b.step_id && r.result_id === result.result_id);
      if (!saved || saved.observed_at_ms !== result.observed_at_ms ||
          operationPlanDigest(saved.output) !== operationPlanDigest(fb.result)) throw new Error("plan_delivery_result_conflict");
    } else if (!["not_attempted", "outcome_unknown", "verification_failed"].includes(b.status)) return false;
    this.change((state) => { state.plans.flatMap((p) => p.bindings).find((b) => b.command_id === fb.command_id)!.delivery_digest = delivery_digest; });
    return true;
  }

  private applyResult({ p, b }: { p: PlanState; b: Binding }, feedback: ExecuteFeedback, delivery_digest?: string): void {
    const result = inspectOperationCommandExecutionResult(feedback.operation_core_result, {
      request_id: b.request_id, command_id: b.command_id, upstream_commit_hash: b.commit_hash,
      operation: b.operation, status: feedback.status,
    });
    const step = b.prepared_step;
    const output = OperationJsonValueSchema.safeParse(feedback.result);
    const verified = !!result && result.command_payload_digest === b.payload_digest && result.action_outcome === "reported_success" &&
      output.success && result.output_digest === createHash("sha256").update(JSON.stringify(feedback.result)).digest("hex") &&
      !!step.preparation?.validation.length && step.preparation.validation.every((v) => v.method === "result_equals" &&
        operationPlanDigest(v.target) === operationPlanDigest(step.target) && operationPlanDigest(v.expected) === operationPlanDigest(output.data));
    this.change((state) => {
      const target = state.plans.find((entry) => entry.bindings.some((binding) => binding.command_id === b.command_id))!;
      const binding = target.bindings.find((binding) => binding.command_id === b.command_id)!;
      binding.status = !result || result.command_payload_digest !== b.payload_digest ? "outcome_unknown"
        : result.action_outcome === "not_attempted" ? "not_attempted"
          : verified ? "verified" : result.action_outcome === "reported_success" ? "verification_failed" : "outcome_unknown";
      if (result) binding.result_digest = operationPlanDigest(result);
      if (delivery_digest) binding.delivery_digest = delivery_digest;
      if (verified && output.success && result) target.results.push({ plan_id: p.revisions[0]!.plan.plan_id,
        request_id: p.revisions[0]!.plan.request_id, step_id: b.step_id, result_id: result.result_id, operation: b.operation,
        status: "succeeded", target: step.target, output: output.data, observed_at_ms: result.observed_at_ms,
        expires_at_ms: result.observed_at_ms + 600_000 });
    });
  }

  projection() {
    const goalProjection = this.goalGovernanceReader?.();
    return { schema_version: "operation-plan-projection.v1", used_for_authority: false as const, raw_payload_exposed: false as const,
      recovery_refresh_status: this.recoveryRefreshPending ? "pending" as const : "ready" as const,
      goal_purpose_options: (goalProjection?.used_for_authority === false ? goalProjection.goals : []).map((goal) => ({
        goal_ref: goal.goal_ref, goal_kind: goal.goal_kind, purpose_version: goal.current_version,
        purpose_digest: goal.current_purpose_digest, parent_alignment_status: goal.parent_alignment_status,
      })),
      result_memory: { configured: !!this.resultMemory, status: !this.resultMemory ? "not_configured" : this.memoryReady ? "receipt_confirmed" : "pending_or_unavailable",
        used_for_authority: false as const },
      waits: (this.state.waits ?? []).slice(-256).reverse().map((wait) => ({
        wait_id: wait.wait_id, plan_id: wait.plan_id_digest, task_identity_digest: wait.task_identity_digest,
        revision_digest: wait.revision_digest,
        owner_authentication_required: wait.channel_digest !== operationPlanDigest("webchat") ||
          wait.owner_digest === operationPlanDigest("webchat-owner-token-holder"),
        ...(wait.channel_digest !== operationPlanDigest("webchat") ? { owner_reauthentication_binding: {
          owner_identity_digest: wait.owner_digest, channel_identity_digest: wait.channel_digest,
        } } : {}),
        state: wait.state, deadline_at_ms: wait.deadline_at_ms,
        ...(this.recoveryHolds.has(wait.plan_id_digest)
          ? { recovery_hold_reason: this.recoveryHolds.get(wait.plan_id_digest)!.reason } : {}),
        ...(wait.resumed_at_ms !== undefined ? { resumed_at_ms: wait.resumed_at_ms } : {}),
        ...(wait.wake_reason ? { wake_reason: wait.wake_reason } : {}),
        compute_outcome: wait.compute_outcome ?? (wait.state === "waiting" ? "not_started" as const : "not_recorded" as const),
        ...(wait.compute_result_digest ? { compute_result_digest: wait.compute_result_digest } : {}),
        ...(wait.candidate_plan_id_digest ? { candidate_plan_id: wait.candidate_plan_id_digest } : {}),
        ...(wait.compute_completed_at_ms !== undefined ? { compute_completed_at_ms: wait.compute_completed_at_ms } : {}),
        ...(wait.compute_interrupted_at_ms !== undefined ? { compute_interrupted_at_ms: wait.compute_interrupted_at_ms } : {}),
        ...(wait.compute_resource_use ? { compute_resource_use: structuredClone(wait.compute_resource_use) } : {}),
        used_for_authority: false as const, may_execute: false as const,
      })),
      plans: this.state.plans.map((p) => {
        const currentRevision = p.revisions.at(-1)!;
        const planIdDigest = operationPlanDigest(p.revisions[0]!.plan.plan_id);
        const recoveryHold = this.recoveryHolds.get(planIdDigest);
        return { plan_id: planIdDigest, task_identity_digest: operationPlanTaskIdentityDigest(p),
        owner_identity_digest: operationPlanDigest(p.owner),
        channel_identity_digest: operationPlanDigest(p.channel),
        request_id: p.revisions[0]!.plan.request_id, revision: p.revisions.length,
        revision_digest: currentRevision.digest, previous_revision_digests: p.revisions.slice(0, -1).map((r) => r.digest),
        ...(p.goal_purpose_binding ? { goal_purpose_binding: structuredClone(p.goal_purpose_binding) } : {}),
        goal_purpose_binding_status: p.goal_purpose_binding
          ? this.goalPurposeBindingIsCurrent(p.goal_purpose_binding) ? "current" as const : "stale" as const
          : goalProjection?.used_for_authority === false ? "required" as const : "not_configured" as const,
        goal_purpose_relation: this.goalPurposeRelationProjection(p),
        ...(p.compute_source_observations?.length
          ? { compute_source_observations: structuredClone(p.compute_source_observations) } : {}),
        ...(recoveryHold ? { recovery_hold_reason: recoveryHold.reason,
          recovery_hold_scope_relation: recoveryHold.restore_scope_relation } : {}),
        status: currentRevision.plan.steps.every((s) => p.bindings.some((b) => b.step_id === s.step_id && b.status === "verified"))
          ? "results_verified" : "awaiting_step_review",
        steps: currentRevision.plan.steps.map((step) => {
          const binding = p.bindings.filter((entry) => entry.step_id === step.step_id).at(-1);
          const observation = binding?.status === "outcome_unknown"
            ? p.receipt_observations.filter((entry) => entry.revision_digest === currentRevision.digest &&
              entry.step_id_digest === operationPlanDigest(step.step_id) && entry.command_digest === binding.command_digest).at(-1)
            : undefined;
          const observationMemory = observation?.source === "local_file_state"
            ? p.receipt_memory?.find((entry) => entry.evidence_digest === observation.evidence_digest)
            : undefined;
          return { step_id: operationPlanDigest(step.step_id), operation: step.operation,
            definition_digest: stepDigest(step), status: binding?.status ?? "not_selected",
            external_receipt_observation: binding?.status !== "outcome_unknown" || observation?.source === "local_file_state"
              ? "not_applicable" : observation?.status ?? "not_recorded",
            ...(observation?.source === "local_inspection" ? { external_receipt: {
              source: observation.source, match_count: observation.match_count, evidence_digest: observation.evidence_digest,
              ...(observation.receipt_digest ? { receipt_digest: observation.receipt_digest } : {}),
              observed_at_ms: observation.observed_at_ms, used_for_authority: false as const, raw_receipt_exposed: false as const,
            } } : {}),
            ...(observation?.source === "local_file_state" ? { local_file_state_observation: {
              source: observation.source, status: observation.status, match_count: observation.match_count,
              target_identity_digest: observation.target_identity_digest, evidence_digest: observation.evidence_digest,
              ...(observation.gateway_execution_receipt_digest
                ? { gateway_execution_receipt_digest: observation.gateway_execution_receipt_digest } : {}),
              ...(observation.gateway_execution_receipt_state
                ? { gateway_execution_receipt_state: observation.gateway_execution_receipt_state } : {}),
              ...(observation.gateway_execution_epoch_digest
                ? { gateway_execution_epoch_digest: observation.gateway_execution_epoch_digest } : {}),
              ...(observation.gateway_task_identity_digest
                ? { gateway_task_identity_digest: observation.gateway_task_identity_digest } : {}),
              ...(observation.receipt_digest ? { file_state_digest: observation.receipt_digest } : {}),
              observed_at_ms: observation.observed_at_ms,
              memory_status: observationMemory?.memory_receipt ? "receipt_confirmed" as const
                : observationMemory?.memory_commit ? "memory_commit_pending" as const : "not_recorded" as const,
              used_for_authority: false as const, raw_receipt_exposed: false as const,
            } } : {}),
          };
        }),
        bindings: p.bindings.map((b) => ({ step_id: operationPlanDigest(b.step_id), revision_digest: b.revision_digest,
          step_digest: b.step_digest, command_id: b.command_id, request_id: b.request_id, commit_hash: b.commit_hash,
          payload_digest: b.payload_digest, command_digest: b.command_digest, operation: b.operation,
          status: b.status, result_digest: b.result_digest, delivery_digest: b.delivery_digest,
          memory_status: b.memory_receipt ? "receipt_confirmed" : b.memory_commit ? "memory_commit_pending" : "not_recorded",
          memory_content_digest: b.memory_commit?.content_digest, memory_receipt_digest: b.memory_receipt?.receipt_digest })),
      }; }) };
  }

  private resolveGoalPurposeBinding(
    requested: OperationPlanGoalPurposeBinding | undefined,
    existing: OperationPlanGoalPurposeBinding | undefined,
  ): OperationPlanGoalPurposeBinding | undefined {
    const projection = this.goalGovernanceReader?.();
    if (projection === undefined) {
      if (requested !== undefined || existing !== undefined) throw new Error("plan_goal_purpose_governance_unavailable");
      return undefined;
    }
    if (projection.used_for_authority !== false) throw new Error("plan_goal_purpose_governance_invalid");
    if (requested === undefined) throw new Error("plan_goal_purpose_binding_required");
    const goal = projection.goals.find((candidate) => candidate.goal_ref === requested.goal_ref);
    if (!goal) throw new Error("plan_goal_purpose_unknown");
    if (goal.parent_alignment_status === "requires_review") throw new Error("plan_goal_purpose_parent_review_required");
    if (goal.current_version !== requested.purpose_version || goal.current_purpose_digest !== requested.purpose_digest) {
      throw new Error("plan_goal_purpose_stale");
    }
    if (existing && (existing.goal_ref !== requested.goal_ref || existing.purpose_version !== requested.purpose_version ||
        existing.purpose_digest !== requested.purpose_digest)) {
      throw new Error("plan_goal_purpose_scope_changed");
    }
    return { goal_ref: goal.goal_ref, purpose_version: goal.current_version, purpose_digest: goal.current_purpose_digest };
  }

  private goalPurposeBindingIsCurrent(binding: OperationPlanGoalPurposeBinding | undefined): boolean {
    try {
      this.resolveGoalPurposeBinding(binding, binding);
      return true;
    } catch { return false; }
  }

  private recordGoalPurposeRelation(
    plan: OperationPlan,
    task: string,
    binding: OperationPlanGoalPurposeBinding,
    rawCandidate: unknown,
  ): OperationPlanGoalPurposeRelationRecord {
    const parsed = rawCandidate === undefined
      ? undefined
      : OperationPlanGoalPurposeRelationCandidateSchema.safeParse(rawCandidate);
    const candidate = parsed?.success ? parsed.data : undefined;
    let candidateStatus: OperationPlanGoalPurposeRelationRecord["candidate_status"] = rawCandidate === undefined
      ? "missing" : parsed?.success ? "present" : "invalid";
    let evidenceStatus: OperationPlanGoalPurposeRelationRecord["evidence_status"] = "not_provided";
    const evidenceDigests: OperationPlanGoalPurposeRelationRecord["evidence_digests"] = [];
    if (candidate?.evidence.length) {
      let purpose: OperationPlanGoalPurposeContent | undefined;
      try { purpose = this.goalPurposeContentReader?.(binding.goal_ref, binding.purpose_version) ?? undefined; }
      catch { purpose = undefined; }
      const purposeIsCurrent = purpose?.used_for_authority === false && purpose.goal_ref === binding.goal_ref &&
        purpose.version === binding.purpose_version && purpose.purpose_digest === binding.purpose_digest &&
        createHash("sha256").update(purpose.purpose_text, "utf8").digest("hex") === binding.purpose_digest;
      if (!purposeIsCurrent || !purpose) {
        evidenceStatus = "purpose_unavailable";
      } else if (candidate.evidence.some((entry) => !task.includes(entry.task_quote) || !purpose!.purpose_text.includes(entry.purpose_quote))) {
        evidenceStatus = "citation_mismatch";
      } else {
        evidenceStatus = "exact_spans_present";
        for (const entry of candidate.evidence) evidenceDigests.push({
          task_span_digest: createHash("sha256").update(entry.task_quote, "utf8").digest("hex"),
          purpose_span_digest: createHash("sha256").update(entry.purpose_quote, "utf8").digest("hex"),
        });
      }
    }
    return OperationPlanGoalPurposeRelationRecordSchema.parse({
      schema_version: "operation-plan-goal-purpose-relation.v1",
      task_digest: createHash("sha256").update(task, "utf8").digest("hex"),
      plan_digest: operationPlanDigest(plan),
      goal_purpose_binding: binding,
      candidate_outcome: candidate?.outcome ?? "unknown",
      candidate_status: candidateStatus,
      evidence_status: evidenceStatus,
      evidence_digests: evidenceDigests,
      semantic_assessment_status: "not_assessed",
      used_for_authority: false,
      may_execute: false,
    });
  }

  private goalPurposeRelationReviewPlan(args: OperationPlanGoalPurposeRelationReviewArguments): PlanState {
    const parsed = OperationPlanGoalPurposeRelationReviewArgumentsSchema.parse(args);
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    if (this.port) {
      const loaded = this.port.load();
      if ((loaded === null ? null : operationPlanDigest(loaded)) !== this.savedDigest) throw new Error("plan_state_changed");
    }
    const matches = this.state.plans.filter((candidate) =>
      operationPlanDigest(candidate.revisions[0]!.plan.plan_id) === parsed.plan_id_digest);
    if (matches.length !== 1) throw new Error("plan_goal_purpose_relation_unavailable");
    const p = matches[0]!;
    if (p.bindings.some((binding) => this.activePlanAttempts.has(binding.command_id))) {
      throw new Error("plan_recovery_refresh_hold");
    }
    const current = p.revisions.at(-1)!;
    const relation = p.goal_purpose_relation;
    const binding = p.goal_purpose_binding;
    if (!relation || !binding) throw new Error("plan_goal_purpose_relation_unavailable");
    if (current.digest !== parsed.revision_digest || relation.plan_digest !== current.digest ||
        relation.task_digest !== parsed.task_digest || relation.task_digest !== createHash("sha256").update(p.goal, "utf8").digest("hex") ||
        relation.goal_purpose_binding.goal_ref !== parsed.goal_ref ||
        relation.goal_purpose_binding.purpose_version !== parsed.purpose_version ||
        relation.goal_purpose_binding.purpose_digest !== parsed.purpose_digest ||
        binding.goal_ref !== parsed.goal_ref || binding.purpose_version !== parsed.purpose_version ||
        binding.purpose_digest !== parsed.purpose_digest || !this.goalPurposeBindingIsCurrent(binding)) {
      throw new Error("plan_goal_purpose_relation_stale");
    }
    const planIdDigest = operationPlanDigest(p.revisions[0]!.plan.plan_id);
    if (this.recoveryHolds.has(planIdDigest)) throw new Error("plan_recovery_unverified_hold");
    return p;
  }

  private goalPurposeRelationOwnerReviewIsVerified(p: PlanState, relation: OperationPlanGoalPurposeRelationRecord): boolean {
    const review = relation.owner_review;
    if (!review || !p.goal_purpose_binding) return false;
    const current = p.revisions.at(-1)!;
    const args: OperationPlanGoalPurposeRelationReviewArguments = {
      plan_id_digest: operationPlanDigest(p.revisions[0]!.plan.plan_id),
      task_digest: relation.task_digest,
      revision_digest: current.digest,
      goal_ref: p.goal_purpose_binding.goal_ref,
      purpose_version: p.goal_purpose_binding.purpose_version,
      purpose_digest: p.goal_purpose_binding.purpose_digest,
      outcome: review.outcome,
    };
    const { audit_event_digest, ...reviewDraft } = review;
    return audit_event_digest === operationPlanGoalPurposeRelationReviewAuditDigest(args, reviewDraft) &&
      this.goalPurposeRelationReviewVerifier?.({ request_id: review.request_id,
        command_id: review.command_id, audit_event_digest }) === true;
  }

  private goalPurposeRelationIssue(
    p: PlanState,
    effectiveBinding: OperationPlanGoalPurposeBinding | undefined = p.goal_purpose_binding,
  ): string | undefined {
    if (!effectiveBinding) return undefined;
    const record = p.goal_purpose_relation;
    if (!record) return "plan_goal_purpose_relation_unavailable";
    const current = p.revisions.at(-1)!;
    if (record.task_digest !== createHash("sha256").update(p.goal, "utf8").digest("hex") ||
        record.plan_digest !== current.digest ||
        record.goal_purpose_binding.goal_ref !== effectiveBinding.goal_ref ||
        record.goal_purpose_binding.purpose_version !== effectiveBinding.purpose_version ||
        record.goal_purpose_binding.purpose_digest !== effectiveBinding.purpose_digest) {
      return "plan_goal_purpose_relation_stale";
    }
    const ownerReviewVerified = this.goalPurposeRelationOwnerReviewIsVerified(p, record);
    if (ownerReviewVerified && record.owner_review?.outcome === "supports") return undefined;
    if ((ownerReviewVerified && record.owner_review?.outcome === "conflicts") ||
        (!ownerReviewVerified && record.candidate_outcome === "conflicts" && record.candidate_status === "present" &&
          record.evidence_status === "exact_spans_present")) {
      return "plan_goal_purpose_relation_conflicts";
    }
    // C claims and exact citations remain non-authoritative; only a current, audited owner review can settle this relation.
    return "plan_goal_purpose_relation_unverified";
  }

  /** A search-derived candidate cannot be reviewed or executed after its bounded source window closes. */
  private computeSourceObservationsAreCurrent(p: PlanState, nowMs: number, seen = new Set<string>()): boolean {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
    const planKey = operationPlanDigest(p.revisions[0]!.plan.plan_id);
    if (seen.has(planKey)) return false;
    seen.add(planKey);
    const current = (p.compute_source_observations ?? []).every((observation) => {
      if (observation.source === "verified_file_search_result") {
        return observation.operation === "file.search" &&
          observation.expires_at_ms === observation.observed_at_ms + 600_000 &&
          observation.observed_at_ms <= nowMs && nowMs < observation.expires_at_ms;
      }
      if (observation.source === "owner_selected_local_file_state") {
        return this.ownerSelectedLocalFileStateIsCurrent(p, observation, nowMs, seen);
      }
      return true;
    });
    seen.delete(planKey);
    return current;
  }

  private ownerSelectedLocalFileStateIsCurrent(
    candidate: PlanState,
    source: Extract<OperationPlanComputeSourceObservation, { source: "owner_selected_local_file_state" }>,
    nowMs: number,
    seen: Set<string>,
  ): boolean {
    const matches = this.state.plans.filter((plan) =>
      operationPlanDigest(plan.revisions[0]!.plan.plan_id) === source.plan_id_digest);
    if (matches.length !== 1) return false;
    const plan = matches[0]!;
    if (plan.owner !== candidate.owner || plan.channel !== candidate.channel ||
        operationPlanTaskIdentityDigest(plan) !== source.task_identity_digest || this.recoveryHolds.has(source.plan_id_digest) ||
        !this.goalPurposeBindingIsCurrent(plan.goal_purpose_binding)) return false;
    const revision = plan.revisions.at(-1);
    if (!revision || revision.digest !== source.revision_digest) return false;
    const steps = revision.plan.steps.filter((step) => operationPlanDigest(step.step_id) === source.step_id_digest);
    if (steps.length !== 1 || steps[0]!.operation !== "file.write" || steps[0]!.parameters?.mode !== "create" ||
        typeof steps[0]!.parameters.path !== "string" || typeof steps[0]!.parameters.content !== "string") return false;
    const bindings = plan.bindings.filter((binding) => binding.revision_digest === revision.digest &&
      binding.step_id === steps[0]!.step_id);
    if (bindings.length !== 1) return false;
    const binding = bindings[0]!;
    if (binding.status !== "outcome_unknown" || binding.operation !== "file.write" || !binding.execution_admission ||
        binding.command_digest !== source.command_digest || operationPlanDigest(binding.execution_admission) !== source.execution_admission_digest ||
        binding.result_digest !== source.result_digest || binding.delivery_digest !== source.delivery_digest ||
        binding.step_digest !== stepDigest(steps[0]!)) return false;
    const observations = plan.receipt_observations.filter((entry) => entry.source === "local_file_state" &&
      entry.revision_digest === revision.digest && entry.step_id_digest === source.step_id_digest &&
      entry.command_digest === binding.command_digest);
    const observation = observations.sort((left, right) => left.observed_at_ms - right.observed_at_ms).at(-1);
    if (!observation || observation.evidence_digest !== source.observation_digest || observation.status !== "matched" ||
        observation.target_identity_digest !== source.target_identity_digest || observation.observed_at_ms !== source.observed_at_ms ||
        observation.command_key_digest !== createHash("sha256").update(binding.execution_admission.command_key, "utf8").digest("hex") ||
        observation.executor_command_digest !== binding.execution_admission.command_digest ||
        !observation.gateway_execution_receipt_digest || !observation.gateway_execution_receipt_state ||
        observation.gateway_execution_epoch_digest !== createHash("sha256")
          .update(binding.execution_admission.execution_epoch, "utf8").digest("hex") ||
        observation.gateway_task_identity_digest !== binding.execution_admission.task_identity_digest ||
        gatewayExecutionReceiptEvidenceDigest(observation) !== observation.gateway_execution_receipt_digest ||
        source.gateway_execution_receipt_digest !== observation.gateway_execution_receipt_digest ||
        source.gateway_execution_receipt_state !== observation.gateway_execution_receipt_state ||
        source.gateway_execution_epoch_digest !== observation.gateway_execution_epoch_digest ||
        source.gateway_task_identity_digest !== observation.gateway_task_identity_digest ||
        source.gateway_execution_feedback_status !== observation.gateway_execution_feedback_status ||
        source.gateway_result_delivery_digest !== observation.gateway_result_delivery_digest ||
        source.gateway_result_delivery_acknowledged !== observation.gateway_result_delivery_acknowledged ||
        observation.request_payload_digest !== fileWritePayloadDigest(steps[0]!.parameters.content) ||
        observation.target_identity_digest !== fileWriteTargetIdentityDigest(steps[0]!.parameters.path) ||
        observation.observed_payload_digest !== observation.request_payload_digest ||
        !this.receiptObservationMemoryIsDurable(observation.evidence_digest)) return false;
    const delivery = this.receiptMemoryDelivery(revision.plan.plan_id, observation.evidence_digest);
    const stored = delivery?.memory_commit && this.resultMemory
      ? this.resultMemory.readMemoryRecord(receiptMemoryIdentity(observation).record_id) : null;
    const expectedValue = delivery?.memory_commit?.changes[0]?.operation === "upsert"
      ? delivery.memory_commit.changes[0].value : undefined;
    if (!delivery?.memory_commit || !delivery.memory_receipt || expectedValue === undefined || !stored?.exists ||
        operationPlanDigest(stored.value) !== source.record_digest || operationPlanDigest(stored.value) !== operationPlanDigest(expectedValue) ||
        delivery.memory_receipt.revision !== source.memory_revision ||
        delivery.memory_receipt.receipt_digest !== source.memory_receipt_digest ||
        !verifyReceiptMemoryCommit(observation, delivery) ||
        !receiptForReceiptMemoryCommit(delivery.memory_receipt, delivery.memory_commit)) return false;
    const expectedSelectionDigest = operationPlanDigest({
      schema_version: "owner-selected-local-file-state.v1",
      owner_digest: operationPlanDigest(candidate.owner),
      channel_digest: operationPlanDigest(candidate.channel),
      plan_id_digest: source.plan_id_digest,
      revision_digest: source.revision_digest,
      step_id_digest: source.step_id_digest,
      observation_digest: source.observation_digest,
      decision: "use_as_non_authority_candidate_context",
    });
    return source.owner_selection_digest === expectedSelectionDigest &&
      this.computeSourceObservationsAreCurrent(plan, nowMs, seen);
  }

  private goalPurposeRelationProjection(p: PlanState) {
    const record = p.goal_purpose_relation;
    if (!p.goal_purpose_binding) return {
      status: "not_required" as const, used_for_authority: false as const, may_execute: false as const,
    };
    if (!record) return {
      status: "unavailable" as const, candidate_outcome: "unknown" as const,
      candidate_status: "missing" as const, evidence_status: "not_provided" as const, evidence_count: 0,
      semantic_assessment_status: "not_assessed" as const, used_for_authority: false as const, may_execute: false as const,
    };
    const issue = this.goalPurposeRelationIssue(p);
    const ownerReviewVerified = this.goalPurposeRelationOwnerReviewIsVerified(p, record);
    return {
      status: issue === "plan_goal_purpose_relation_stale" ? "stale" as const
        : issue === "plan_goal_purpose_relation_conflicts" ? "conflicts" as const
          : ownerReviewVerified && record.owner_review?.outcome === "supports" ? "owner_reviewed_supports" as const
            : ownerReviewVerified && record.owner_review?.outcome === "unknown" ? "owner_reviewed_unknown" as const
              : "unverified" as const,
      candidate_outcome: record.candidate_outcome, candidate_status: record.candidate_status,
      evidence_status: record.evidence_status, evidence_count: record.evidence_digests.length,
      ...(ownerReviewVerified && record.owner_review ? { owner_review_outcome: record.owner_review.outcome } : {}),
      owner_review_status: !record.owner_review ? "not_reviewed" as const : ownerReviewVerified ? "verified" as const : "invalid" as const,
      semantic_assessment_status: record.semantic_assessment_status,
      record_digest: operationPlanDigest(record), used_for_authority: false as const, may_execute: false as const,
    };
  }

  /** Build the same request-bound criterion assessment used by selection and its adoption record. */
  private requestGoalCriteriaEvaluation(p: PlanState, step: OperationStep): {
    assessment: ReturnType<typeof assessCandidateGoalCriteria>;
    projection_digest: string;
    criterion_relations: { criterion_ref_digest: string; criterion_kind: "objective" | "safety";
      relation: "supports" | "conflicts" }[];
    issue?: string;
  } {
    const projection = p.request_goal_criteria;
    const projectionDigest = operationPlanDigest(projection ?? null);
    if (!projection) return {
      assessment: assessCandidateGoalCriteria("", undefined), projection_digest: projectionDigest,
      criterion_relations: [],
      issue: "plan_goal_criteria_source_unavailable",
    };
    const requestId = p.revisions[0]!.plan.request_id;
    const contentSha256 = createHash("sha256").update(p.goal, "utf8").digest("hex");
    if (projection.request_id !== requestId || projection.content_sha256 !== contentSha256 || projection.status === "invalid") {
      return {
        assessment: assessCandidateGoalCriteria("", projection, { request_id: requestId, content_sha256: contentSha256 }),
        projection_digest: projectionDigest, criterion_relations: [], issue: "plan_goal_criteria_source_invalid",
      };
    }
    if (projection.status === "not_provided") return {
      assessment: assessCandidateGoalCriteria("", projection, { request_id: requestId, content_sha256: contentSha256 }),
      projection_digest: projectionDigest, criterion_relations: [],
    };
    const descriptor = getOperationDescriptor(step.operation);
    if (!descriptor) return {
      assessment: assessCandidateGoalCriteria("", projection, { request_id: requestId, content_sha256: contentSha256 }),
      projection_digest: projectionDigest, criterion_relations: [], issue: "plan_goal_criteria_operation_unavailable",
    };
    const toolName = descriptor.tool_name ?? descriptor.operation_id;
    const assessment = assessCandidateGoalCriteria(toolName, projection, {
      request_id: requestId,
      content_sha256: contentSha256,
    });
    const toolNameDigest = digestGoalCriteriaValue(toolName.trim().normalize("NFKC"));
    const criterionRelations = projection.criteria.flatMap((criterion) => criterion.tool_relations
      .filter((relation) => relation.tool_name_digest === toolNameDigest)
      .map((relation) => ({ criterion_ref_digest: criterion.criterion_ref_digest,
        criterion_kind: criterion.criterion_kind, relation: relation.relation })))
      .sort((left, right) => left.criterion_ref_digest.localeCompare(right.criterion_ref_digest));
    if (assessment.reason_code === "criteria_invalid") return { assessment, projection_digest: projectionDigest,
      criterion_relations: criterionRelations, issue: "plan_goal_criteria_source_invalid" };
    if (assessment.outcome === "conflicts") return { assessment, projection_digest: projectionDigest,
      criterion_relations: criterionRelations, issue: "plan_goal_criteria_conflict" };
    return { assessment, projection_digest: projectionDigest, criterion_relations: criterionRelations };
  }

  /** Record the exact non-text relation inputs J used before adopting a plan step. */
  private goalRelationAdoptionAssessment(
    p: PlanState,
    step: OperationStep,
  ): OperationPlanGoalRelationAdoptionAssessment {
    const criteria = this.requestGoalCriteriaEvaluation(p, step);
    if (criteria.issue) throw new Error(criteria.issue);
    const relation = p.goal_purpose_relation;
    const binding = p.goal_purpose_binding;
    if (relation && !binding) throw new Error("plan_goal_purpose_relation_binding_missing");
    const purposeIssue = this.goalPurposeRelationIssue(p);
    if (purposeIssue) throw new Error(purposeIssue);
    const ownerReviewVerified = relation !== undefined && this.goalPurposeRelationOwnerReviewIsVerified(p, relation);
    const purposeRelation = {
      status: binding ? "owner_reviewed_supports" as const : "not_required" as const,
      relation_digest: operationPlanDigest(relation ?? null),
      candidate_outcome: relation?.candidate_outcome ?? "unknown" as const,
      candidate_status: relation?.candidate_status ?? "missing" as const,
      evidence_status: relation?.evidence_status ?? "not_provided" as const,
      ...(ownerReviewVerified && relation?.owner_review
        ? { owner_review_outcome: relation.owner_review.outcome } : {}),
    };
    const criterionRelation = {
      projection_digest: criteria.projection_digest,
      outcome: criteria.assessment.outcome,
      evidence_status: criteria.assessment.evidence_status,
      risk_status: criteria.assessment.risk_status,
      criterion_ref_digests: [...new Set(criteria.criterion_relations.map((relation) => relation.criterion_ref_digest))].sort(),
      criterion_relations: criteria.criterion_relations,
      reason_code: criteria.assessment.reason_code,
    };
    const body = {
      schema_version: "operation-plan-goal-relation-adoption.v1" as const,
      purpose_relation: purposeRelation,
      criterion_relation: criterionRelation,
    };
    return OperationPlanGoalRelationAdoptionAssessmentSchema.parse({
      ...body,
      assessment_digest: operationPlanDigest(body),
    });
  }

  /** Request-declared conflicts constrain plan selection; support remains an unverified claim. */
  private requestGoalCriteriaIssue(p: PlanState, step: OperationStep): string | undefined {
    return this.requestGoalCriteriaEvaluation(p, step).issue;
  }

  private ownedPlan(id: string, caller: InboundRequest): PlanState {
    const matches = this.state.plans.filter((p) => p.revisions[0]!.plan.plan_id === id || operationPlanDigest(p.revisions[0]!.plan.plan_id) === id);
    const p = matches[0];
    if (matches.length !== 1 || !p || p.owner !== caller.user || p.channel !== caller.channel) throw new Error("plan_owner_or_identity_mismatch");
    return p;
  }

  private ownedPlanForReview(control: Extract<OperationPlanControl, { action: "review" }>, caller: InboundRequest): PlanState {
    return this.ownedPlanForOwnerReauthentication(control.plan_id, control.owner_reauthentication, caller);
  }

  private ownedPlanForOwnerReauthentication(planId: string,
    ownerReauthentication: { owner_identity_digest: string; channel_identity_digest: string } | undefined,
    caller: InboundRequest, processKind: "chat" | "tool" = "tool"): PlanState {
    const matches = this.state.plans.filter((p) => p.revisions[0]!.plan.plan_id === planId ||
      operationPlanDigest(p.revisions[0]!.plan.plan_id) === planId);
    const plan = matches[0];
    if (matches.length !== 1 || !plan) throw new Error("plan_owner_or_identity_mismatch");
    if (plan.owner === caller.user && plan.channel === caller.channel) {
      if (ownerReauthentication !== undefined) throw new Error("plan_owner_or_identity_mismatch");
      return plan;
    }

    const metadata = caller.metadata ?? {};
    const ownerReauthenticated = ownerReauthentication !== undefined &&
      isGatewayInternalInboundRequest(caller) && caller.channel === "webchat" && caller.user === "webchat-owner-token-holder" &&
      metadata["blue_tanuki.authority_context"] === "gateway_internal_v1" &&
      metadata["blue_tanuki.actor_kind"] === "owner" && metadata["blue_tanuki.trust_level"] === "owner" &&
      metadata["blue_tanuki.process_kind"] === processKind && metadata["blue_tanuki.operator_surface"] === "developer" &&
      metadata["blue_tanuki.operation_core.source_interface"] === "gui" &&
      ownerReauthentication.owner_identity_digest === operationPlanDigest(plan.owner) &&
      ownerReauthentication.channel_identity_digest === operationPlanDigest(plan.channel);
    if (!ownerReauthenticated) throw new Error("plan_owner_or_identity_mismatch");
    return plan;
  }

  private inspectReceiptReconciliation(control: OperationPlanReceiptReconciliationControl, caller: InboundRequest): {
    plan_id: string; revision_digest: string; step: OperationStep; binding: Binding;
  } {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    if (this.port) {
      const loaded = this.port.load();
      if ((loaded === null ? null : operationPlanDigest(loaded)) !== this.savedDigest) throw new Error("plan_state_changed");
    }
    const plan = this.ownedPlan(control.plan_id, caller);
    const current = plan.revisions.at(-1)!;
    if (current.digest !== control.revision_digest) throw new Error("plan_revision_changed");
    const steps = current.plan.steps.filter((step) => step.step_id === control.step_id ||
      operationPlanDigest(step.step_id) === control.step_id);
    if (steps.length !== 1) throw new Error("plan_step_identity_mismatch");
    const step = steps[0]!;
    const bindings = plan.bindings.filter((binding) => binding.step_id === step.step_id && binding.revision_digest === current.digest);
    const binding = bindings.at(-1);
    if (!binding || binding.status !== "outcome_unknown" || !binding.execution_admission) {
      throw new Error("plan_receipt_reconciliation_not_outcome_unknown");
    }
    if (binding.step_digest !== stepDigest(step) || binding.prepared_step.step_id !== step.step_id ||
        binding.prepared_step.operation !== step.operation) {
      throw new Error("plan_receipt_reconciliation_binding_invalid");
    }
    const gmailReceipt = step.operation === "gmail.write" && step.parameters?.operation === "message.send";
    const fileWriteState = step.operation === "file.write" && step.parameters?.mode === "create" &&
      typeof step.parameters.path === "string" && typeof step.parameters.content === "string";
    if (!gmailReceipt && !fileWriteState) {
      throw new Error("plan_receipt_reconciliation_operation_unsupported");
    }
    const expectedKey = createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", binding.command_id])).digest("hex");
    if (binding.execution_admission.command_key !== expectedKey ||
        binding.execution_admission.command_digest.length !== 64 || binding.command_digest.length !== 64) {
      throw new Error("plan_receipt_reconciliation_binding_invalid");
    }
    return { plan_id: current.plan.plan_id, revision_digest: current.digest, step, binding };
  }
  private binding(id: string): { p: PlanState; b: Binding } | undefined {
    for (const p of this.state.plans) { const b = p.bindings.find((b) => b.command_id === id); if (b) return { p, b }; }
    return undefined;
  }
  private revisionImpact(p: PlanState, input: unknown): Set<string> {
    const next = candidatePlan(input);
    const old = p.revisions.at(-1)!.plan;
    if (next.plan_id !== old.plan_id || next.request_id !== old.request_id) throw new Error("plan_revision_identity_changed");
    if (operationPlanDigest(next) === operationPlanDigest(old)) throw new Error("plan_revision_unchanged");
    const affected = new Set<string>();
    for (const s of [...old.steps, ...next.steps]) {
      const previous = old.steps.find((step) => step.step_id === s.step_id);
      const current = next.steps.find((step) => step.step_id === s.step_id);
      if (!previous || !current || stepDigest(previous) !== stepDigest(current)) affected.add(s.step_id);
    }
    let changed = true;
    while (changed) { changed = false; for (const s of [...old.steps, ...next.steps]) {
      if (!affected.has(s.step_id) && s.preparation?.depends_on.some((id) => affected.has(id))) { affected.add(s.step_id); changed = true; }
    } }
    for (const b of p.bindings) if (!["selected", "invalidated", "not_attempted"].includes(b.status) && affected.has(b.step_id)) {
      throw new Error("plan_attempted_step_or_dependency_changed");
    }
    return affected;
  }
  private change(mutate: (state: OperationPlanCheckpoint) => void): void {
    const next = OperationPlanCheckpointSchema.parse(this.state);
    mutate(next);
    const checked = OperationPlanCheckpointSchema.parse(next);
    if (JSON.stringify(checked).length > 4_000_000) throw new Error("plan_checkpoint_capacity_reached");
    this.port?.compareAndSet(this.savedDigest, checked, Boolean(this.memoryStorage));
    this.state = checked;
    this.savedDigest = operationPlanDigest(checked);
  }
}
