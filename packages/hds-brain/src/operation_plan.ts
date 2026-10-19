import { createHash, randomUUID } from "node:crypto";
import {
  getOperationDescriptor, inspectOperationCommandExecutionResult,
  GoalCriteriaProjectionSchema, OperationJsonValueSchema, OperationPlanCheckpointSchema, OperationPlanSchema, prepareOperationPlan,
  type ExecuteCommand, type ExecuteFeedback, type InboundRequest, type OperationPlan,
  type OperationPlanCheckpoint, type OperationPlanControl, type OperationPlanGoalPurposeBinding,
  type OperationPlanComputeSourceObservation, type OperationPlanComputeSourceObservationReference,
  type OperationPlanGoalPurposeRelationCandidate, type OperationPlanGoalPurposeRelationOwnerReview,
  type OperationPlanGoalPurposeRelationRecord, type OperationPlanGoalPurposeRelationReviewArguments, type OperationStep,
  type MemoryCommitV2, type MemoryUpdateReceiptV1,
  ExecutionAdmissionSchema, inspectExecutionResultDelivery, type ExecutionAdmission, type ExecutionResultDelivery,
  OperationPlanExternalReceiptObservationSchema,
  OperationPlanComputeSourceObservationSchema,
  OperationPlanComputeSourceObservationReferenceSchema,
  OperationPlanGoalPurposeBindingSchema,
  OperationPlanGoalPurposeRelationCandidateSchema,
  OperationPlanGoalPurposeRelationOwnerReviewSchema,
  OperationPlanGoalPurposeRelationRecordSchema,
  OperationPlanGoalPurposeRelationReviewArgumentsSchema,
  OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION, type OperationPlanReflectionControl,
  type OperationPlanReceiptReconciliationControl,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator } from "./制御状態.js";
import type { JMemoryApprovalReference } from "./保存取引.js";
import { assessCandidateGoalCriteria, projectRequestGoalCriteria } from "./candidate_criteria.js";
import { buildResultMemoryCommit, resultMemoryEligible, resultMemoryIdentity, verifyResultMemoryCommit, receiptForResultCommit } from "./operation_result_memory.js";
import { buildReceiptMemoryCommit, receiptForReceiptMemoryCommit, receiptMemoryIdentity, receiptMemoryObservation,
  verifyReceiptMemoryCommit } from "./operation_receipt_memory.js";
import type { ResultObservationCitation, ResultObservationProjection } from "./operation_result_reflection.js";
import type { ReadonlyGoalGovernanceProjection } from "./goal_governance.js";

type PlanState = OperationPlanCheckpoint["plans"][number];
type Binding = PlanState["bindings"][number];

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
  load(): unknown | null;
  compareAndSet(expected_digest: string | null, checkpoint: OperationPlanCheckpoint): void;
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
  readonly restore_store_key?: "j_control" | "m_state" | "broker" | "operation_plans" | "cron_events" | null;
  readonly restore_backup_id_digest: string | null;
  readonly restore_scope_plan_digest: string | null;
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
  readonly store_key: "j_control" | "m_state";
  readonly command_id_digest: string;
  readonly operation_digest: string;
  readonly result_digest: string;
  readonly restore_backup_id_digest: string;
  readonly restored_state_digest: string;
  readonly store_ledger_status: "verified";
  readonly store_ledger_residual_count: 0;
}

export interface OperationPlanRecoveryEvidence {
  readonly schema_version: "operation-plan-recovery-evidence.v1";
  readonly scope: "restored_operation_plans" | "unverified_history";
  readonly checkpoint_digest: string;
  readonly provenance?: OperationPlanRecoveryEvidenceProvenance;
  readonly plans: readonly {
    readonly plan_id_digest: string;
    readonly restore_scope_relation: OperationPlanRecoveryScopeRelation;
    readonly restore_membership: "restored" | "not_restored" | "unknown";
    readonly integrity: "verified" | "residuals_present" | "unverified";
    readonly dependency_status: "observed" | "residuals_present" | "unobserved" | "unknown";
  }[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

function recoveryEvidenceProvenance(value: unknown): OperationPlanRecoveryEvidenceProvenance {
  const raw = value as Record<string, unknown> | undefined;
  if (raw === undefined) return {
    source: "unverified_history", command_id_digest: null, operation_digest: null, result_digest: null,
    restore_store_key: null, restore_backup_id_digest: null, restore_scope_plan_digest: null, restored_state_digest: null,
  };
  const digestOrNull = (digest: unknown): digest is string | null => digest === null ||
    (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
        "restore_store_key", "restore_backup_id_digest", "restore_scope_plan_digest", "restored_state_digest"].includes(key)) ||
      !["recovery_restore", "unverified_history"].includes(String(raw.source)) ||
      !digestOrNull(raw.command_id_digest) || !digestOrNull(raw.operation_digest) ||
      !digestOrNull(raw.result_digest) || !digestOrNull(raw.restore_backup_id_digest) ||
      (raw.restore_store_key !== undefined && raw.restore_store_key !== null &&
        !["j_control", "m_state", "broker", "operation_plans", "cron_events"].includes(String(raw.restore_store_key))) ||
      (raw.restore_scope_plan_digest !== undefined && !digestOrNull(raw.restore_scope_plan_digest)) ||
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
      restored_state_digest: provenance.restored_state_digest,
    });
    if (Object.keys(provenance).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
      "restore_store_key", "restore_backup_id_digest", "restore_scope_plan_digest", "restored_state_digest", "checkpoint_digest"].includes(key)) ||
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
      (provenance?.source !== "recovery_restore" || !provenance.restore_scope_plan_digest)) {
    throw new Error("plan_recovery_evidence_invalid");
  }
  const seen = new Set<string>();
  const plans = raw.plans.map((entry): OperationPlanRecoveryEvidence["plans"][number] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plan_recovery_evidence_invalid");
    const plan = entry as Record<string, unknown>;
    if (Object.keys(plan).some((key) => !["plan_id_digest", "restore_scope_relation", "restore_membership", "integrity", "dependency_status"].includes(key)) ||
        typeof plan.plan_id_digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.plan_id_digest) || seen.has(plan.plan_id_digest) ||
        (plan.restore_scope_relation !== undefined && !["requested", "collateral", "unknown"].includes(String(plan.restore_scope_relation))) ||
        !["restored", "not_restored", "unknown"].includes(String(plan.restore_membership)) ||
        !["verified", "residuals_present", "unverified"].includes(String(plan.integrity)) ||
        !["observed", "residuals_present", "unobserved", "unknown"].includes(String(plan.dependency_status))) {
      throw new Error("plan_recovery_evidence_invalid");
    }
    seen.add(plan.plan_id_digest);
    const inferredRelation = recoveryScopeRelation(plan.plan_id_digest, provenance?.restore_scope_plan_digest ?? null);
    const relation = plan.restore_scope_relation === undefined ? inferredRelation : plan.restore_scope_relation;
    if (relation !== inferredRelation) throw new Error("plan_recovery_evidence_invalid");
    return { plan_id_digest: plan.plan_id_digest, restore_scope_relation: relation as OperationPlanRecoveryScopeRelation,
      restore_membership: plan.restore_membership as OperationPlanRecoveryEvidence["plans"][number]["restore_membership"],
      integrity: plan.integrity as OperationPlanRecoveryEvidence["plans"][number]["integrity"],
      dependency_status: plan.dependency_status as OperationPlanRecoveryEvidence["plans"][number]["dependency_status"] };
  });
  if (raw.scope === "unverified_history" && plans.length !== 0) throw new Error("plan_recovery_evidence_invalid");
  return { schema_version: "operation-plan-recovery-evidence.v1", scope: raw.scope as OperationPlanRecoveryEvidence["scope"],
    checkpoint_digest: raw.checkpoint_digest,
    ...(provenance === undefined ? {} : { provenance }),
    plans, used_for_authority: false, may_execute: false };
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
  readonly operation: string;
  readonly parameters: Record<string, unknown>;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

export function operationPlanDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
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
          observed_at_ms < binding.execution_admission.issued_at_ms) {
        throw new Error("plan_checkpoint_receipt_observation_binding_mismatch");
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
  return state;
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
  private state: OperationPlanCheckpoint = { schema_version: "operation-plan-state.v1", plans: [] };
  private savedDigest: string | null = null;
  private readonly issuedBindings = new WeakMap<ExecuteCommand, string>();
  private readonly issuedBindingIds = new Set<string>();
  private readonly activePlanAttempts = new Set<string>();
  private readonly memoryStorage?: OperationPlanMemoryStorage;
  private resultMemory?: JMemoryCommitCoordinator;
  private memoryQuiesced = false;
  private memoryReady = true;
  private readonly reflections = new Map<string, { command_digest: string; control: OperationPlanReflectionControl;
    caller: InboundRequest; projection_digest: string }>();
  private readonly receiptReconciliations = new Map<string, {
    command_digest: string;
    caller_user: string;
    caller_channel: string;
    control: OperationPlanReceiptReconciliationControl;
    authorization: OperationPlanReceiptReconciliationAuthorization;
  }>();
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
    private readonly goalPurposeRelationReviewVerifier?: OperationPlanGoalPurposeRelationReviewVerifier) {
    if (memoryStorage && !port) throw new Error("plan_memory_requires_durable_j_state");
    this.memoryStorage = memoryStorage;
    const checkedRecoveryEvidence = recoveryEvidence ? parseOperationPlanRecoveryEvidence(recoveryEvidence) : undefined;
    let loadedCheckpointDigest: string | null = null;
    const saved = port?.load();
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
  }

  beginRecoveryRefresh(): boolean {
    if (!this.port || this.recoveryRefreshPending || this.activePlanAttempts.size > 0) return false;
    this.recoveryRefreshPending = true;
    return true;
  }

  /** Persist a non-authority hold before restoring either J or M as a whole store. */
  holdForCanonicalMemoryRestore(command: ExecuteCommand): boolean {
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        !["j_control", "m_state"].includes(String(command.payload.arguments.store_key)) ||
        command.payload.arguments.confirm !== "RESTORE" || command.upstream_decision.commit_decision !== "ASSERT") return false;
    if (!this.port || this.recoveryRefreshPending || this.activePlanAttempts.size > 0) return false;
    if (this.state.plans.length === 0) return true;
    if (!this.savedDigest) return false;
    const restoreStoreKey = command.payload.arguments.store_key as "j_control" | "m_state";
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
        !["j_control", "m_state"].includes(observation.store_key) ||
        observation.store_ledger_status !== "verified" || observation.store_ledger_residual_count !== 0 ||
        !digest(observation.command_id_digest) || observation.command_id_digest !== recoveryCommandIdDigest(command.id) ||
        !digest(observation.operation_digest) || !digest(observation.result_digest) ||
        !digest(observation.restore_backup_id_digest) || !digest(observation.restored_state_digest)) return false;
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
      updated.set(planId, { ...hold, provenance: {
        ...hold.provenance,
        restore_store_key: observation.store_key,
        operation_digest: observation.operation_digest,
        result_digest: observation.result_digest,
        restore_backup_id_digest: observation.restore_backup_id_digest,
        restored_state_digest: observation.restored_state_digest,
      } });
    }
    // Older residual/unobserved holds remain protective. They do not prevent the
    // J/M pair from reopening once the current restore itself has been observed.
    if (matched === 0) return this.state.plans.every((plan) => {
      const hold = this.recoveryHolds.get(operationPlanDigest(plan.revisions[0]!.plan.plan_id));
      if (!hold) return false;
      if (hold.reason !== "held_unverified" || hold.provenance.source !== "recovery_restore") return true;
      return hold.provenance.restore_store_key !== "j_control" && hold.provenance.restore_store_key !== "m_state";
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
    const saved = this.port?.load();
    const checked = saved == null
      ? { schema_version: "operation-plan-state.v1" as const, plans: [] }
      : validateOperationPlanCheckpoint(saved, Boolean(this.resultMemory));
    const restoredCheckpointDigest = saved == null ? null : operationPlanDigest(checked);
    this.state = checked;
    this.savedDigest = restoredCheckpointDigest;
    this.reflections.clear();
    this.receiptReconciliations.clear();
    // Restore changes only plan history. Any selection or started attempt from
    // the restored checkpoint must be revoked or represented as uncertain.
    this.change((state) => {
      for (const plan of state.plans) for (const binding of plan.bindings) {
        if (binding.status === "selected") binding.status = "invalidated";
        if (binding.status === "intent_committed") binding.status = "outcome_unknown";
      }
    });
    this.recoveryHolds.clear();
    if (checkedEvidence) {
      this.applyRecoveryEvidence(checkedEvidence, checkedEvidence.checkpoint_digest === restoredCheckpointDigest);
    } else {
      for (const plan of this.state.plans) {
        this.addRecoveryHold(operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", {
          source: "recovery_restore",
          command_id_digest: recoveryCommandIdDigest(command.id),
          operation_digest: null,
          result_digest: null,
          restore_backup_id_digest: null,
          restore_scope_plan_digest: null,
          restored_state_digest: null,
          checkpoint_digest: restoredCheckpointDigest ?? operationPlanDigest(checked),
        });
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
      for (const plan of this.state.plans) this.addRecoveryHold(
        operationPlanDigest(plan.revisions[0]!.plan.plan_id), "held_unverified", provenance, "unknown");
      return;
    }
    const byPlan = new Map(evidence.plans.map((plan) => [plan.plan_id_digest, plan]));
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
      if (hold.reason !== "held_unverified" || provenance.source !== "recovery_restore" ||
          (provenance.restore_store_key !== "j_control" && provenance.restore_store_key !== "m_state") ||
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
      const verified = plan.bindings.filter((binding) => binding.status === "verified");
      if (verified.length === 0 && (plan.results.length > 0 || plan.bindings.some((binding) =>
        !["invalidated", "not_attempted"].includes(binding.status) || binding.execution_admission !== undefined ||
        binding.delivery_digest !== undefined || binding.memory_commit !== undefined || binding.memory_receipt !== undefined))) {
        return false;
      }

      const lifecycle = this.resultMemory.snapshot();
      if (!lifecycle || lifecycle.status !== "ready" ||
          !["idle", "effect_confirmed"].includes(lifecycle.lifecycle_state) ||
          lifecycle.pending.some((entry) => entry.lifecycle_state !== "effect_confirmed")) return false;

      return verified.every((binding) => {
        if (!binding.execution_admission || !binding.delivery_digest || !binding.memory_commit || !binding.memory_receipt ||
            !verifyResultMemoryCommit(plan, binding) || !receiptForResultCommit(binding.memory_receipt, binding.memory_commit)) {
          return false;
        }
        const commit = binding.memory_commit;
        if (commit.changes.length !== 1 || commit.changes[0]?.operation !== "upsert") return false;
        const directReceipt = this.resultMemory!.readMemoryReceipt(commit.update_id);
        const jEntries = lifecycle.pending.filter((entry) => entry.update_id === commit.update_id);
        if (!directReceipt || jEntries.length !== 1) return false;
        const jEntry = jEntries[0]!;
        if (jEntry.lifecycle_state !== "effect_confirmed" || jEntry.status !== "receipt_confirmed" ||
            jEntry.j_event_id !== commit.j_event_id || jEntry.content_digest !== commit.content_digest ||
            !jEntry.receipt || operationPlanDigest(jEntry.receipt) !== operationPlanDigest(binding.memory_receipt) ||
            operationPlanDigest(directReceipt) !== operationPlanDigest(binding.memory_receipt) ||
            !receiptForResultCommit(directReceipt, commit)) return false;
        const record = this.resultMemory!.readMemoryRecord(resultMemoryIdentity(binding).record_id);
        return !!record?.exists && operationPlanDigest(record.value) === operationPlanDigest(commit.changes[0]!.value);
      });
    } catch {
      return false;
    }
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
        (provenance.restore_store_key === "j_control" || provenance.restore_store_key === "m_state") &&
        existing.provenance.source === "recovery_restore" &&
        (existing.provenance.restore_store_key === "j_control" || existing.provenance.restore_store_key === "m_state")) {
      // A new whole-store restore supersedes the earlier pending observation for
      // this same kind of hold; its result still has to be observed afterwards.
      this.recoveryHolds.set(planIdDigest, { reason, restore_scope_relation: restoreScopeRelation, provenance });
    }
  }

  private persistRecoveryHoldState(): void {
    if (!this.port) return;
    const rawCurrent = this.port.loadRecoveryHoldState();
    const current = rawCurrent === null || rawCurrent === undefined
      ? null : parseOperationPlanRecoveryHoldState(rawCurrent);
    const state: OperationPlanRecoveryHoldState = {
      schema_version: "operation-plan-recovery-holds.v1",
      holds: [...this.recoveryHolds.entries()].map(([plan_id_digest, hold]) => ({
        plan_id_digest, reason: hold.reason, restore_scope_relation: hold.restore_scope_relation, provenance: hold.provenance,
      })).sort((left, right) => left.plan_id_digest.localeCompare(right.plan_id_digest)),
      used_for_authority: false,
      may_execute: false,
    };
    this.port.compareAndSetRecoveryHoldState(current ? operationPlanDigest(current) : null, state);
  }

  retainCandidate(value: unknown, origin: InboundRequest, rawPurposeRelationCandidate?: unknown,
    computeSourceObservations?: readonly OperationPlanComputeSourceObservation[]): void {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const plan = candidatePlan(value);
    const expected = origin.metadata?.["blue_tanuki.operation_core.request_id"] ?? origin.id;
    if (plan.request_id !== expected || this.state.plans.some((p) => p.revisions[0]!.plan.plan_id === plan.plan_id)) {
      throw new Error("plan_source_binding_mismatch");
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
      const references = computeSourceObservations.map(({ plan_id_digest, revision_digest, step_id_digest }) => ({
        plan_id_digest, revision_digest, step_id_digest,
      }));
      const current = this.inspectComputeSourceObservations(references, origin);
      if (operationPlanDigest(current) !== operationPlanDigest(computeSourceObservations)) {
        throw new Error("plan_compute_source_observation_stale");
      }
      verifiedComputeSourceObservations = current;
    }
    const goalPurposeRelation = goalPurposeBinding
      ? this.recordGoalPurposeRelation(plan, origin.content, goalPurposeBinding, rawPurposeRelationCandidate)
      : undefined;
    const requestGoalCriteria = GoalCriteriaProjectionSchema.parse(projectRequestGoalCriteria(
      { ...origin, id: expected }, origin.content));
    this.change((state) => state.plans.push({ owner: origin.user, channel: origin.channel, goal: origin.content,
      ...(goalPurposeBinding ? { goal_purpose_binding: goalPurposeBinding } : {}),
      ...(goalPurposeRelation ? { goal_purpose_relation: goalPurposeRelation } : {}),
      ...(verifiedComputeSourceObservations ? { compute_source_observations: verifiedComputeSourceObservations } : {}),
      request_goal_criteria: requestGoalCriteria,
      revisions: [{ digest: operationPlanDigest(plan), plan }], receipt_observations: [], bindings: [], results: [] }));
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
  } {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const p = this.ownedPlan(control.plan_id, caller);
    let recoveryHoldReleased = false;
    const recoveryHold = control.action === "review"
      ? this.recoveryHolds.get(operationPlanDigest(p.revisions[0]!.plan.plan_id)) : undefined;
    if (!this.reconcileMemory()) throw new Error("plan_memory_commit_pending");
    const current = p.revisions.at(-1)!;
    const expected = control.action === "review" ? control.revision_digest : control.expected_revision_digest;
    if (expected !== current.digest) throw new Error("plan_revision_changed");
    if (control.action === "revise") {
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
    return { plan_id: current.plan.plan_id, revision_digest: expected, step, goal: p.goal,
      recovery_hold_released: recoveryHoldReleased,
      ...(goalPurposeBinding ? { goal_purpose_binding: goalPurposeBinding } : {}) };
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
      command_key: binding.execution_admission!.command_key, operation: inspected.step.operation,
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
          binding.execution_admission?.command_key !== issued.authorization.command_key) return null;
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
        operation: descriptor.operation_id, status: "selected" });
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
    if (!this.goalPurposeBindingIsCurrent(match.p.goal_purpose_binding) ||
        this.goalPurposeRelationIssue(match.p) !== undefined ||
        match.b.status !== "selected" || !currentRevision || currentRevision.digest !== match.b.revision_digest ||
        !revision || !step || stepDigest(step) !== match.b.step_digest || !descriptor ||
        this.requestGoalCriteriaIssue(match.p, step) !== undefined ||
        match.b.operation !== descriptor.operation_id || command.type !== "tool_call" ||
        command.payload.tool_name !== descriptor.tool_name || commandPayloadDigest(command) !== match.b.payload_digest ||
        operationPlanDigest(command) !== match.b.command_digest ||
        command.upstream_decision.request_id !== match.b.request_id ||
        command.upstream_decision.commit_hash !== match.b.commit_hash) {
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
      command_digest: match.b.command_digest,
    });
  }
  canExecute(command: ExecuteCommand): boolean {
    const reflectionCommand = this.reflections.has(command.id) || (command.type === "llm_call" &&
      command.payload.compute_context?.local_p_version === OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION);
    const issuedBindingId = this.issuedBindings.get(command);
    if (this.recoveryRefreshPending &&
        (reflectionCommand || issuedBindingId !== undefined || this.issuedBindingIds.has(command.id))) return false;
    if (reflectionCommand) {
      return this.readReflection(command) !== undefined;
    }
    const bindingId = issuedBindingId ?? command.id;
    const match = this.binding(bindingId);
    if (!match) return !this.issuedBindingIds.has(bindingId) && !this.issuedBindingIds.has(command.id);
    if (this.memoryQuiesced || this.recoveryHolds.has(operationPlanDigest(match.p.revisions[0]!.plan.plan_id))) return false;
    if (!this.reconcileMemory()) return false;
    const { p, b } = match;
    if (!this.goalPurposeBindingIsCurrent(p.goal_purpose_binding) || this.goalPurposeRelationIssue(p) !== undefined) return false;
    const step = p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === b.step_id);
    if (!step || this.requestGoalCriteriaIssue(p, step) !== undefined) return false;
    const prepared = prepareOperationPlan(p.revisions.at(-1)!.plan, { now_ms: Date.now(), results: p.results, observations: [] });
    const current = prepared.kind === "inspected" ? prepared.plan.steps.find((s) => s.step_id === b.step_id) : undefined;
    return command.id === b.command_id && b.status === "selected" && !!step && stepDigest(step) === b.step_digest &&
      prepared.kind === "inspected" && prepared.summary.steps.find((s) => s.step_id === b.step_id)?.status === "ready" &&
      !!current && stepDigest(current) === stepDigest(b.prepared_step) &&
      command.upstream_decision.request_id === b.request_id && command.upstream_decision.commit_hash === b.commit_hash &&
      command.upstream_decision.commit_decision === "ASSERT" && command.type === "tool_call" &&
      command.payload.tool_name === b.operation && commandPayloadDigest(command) === b.payload_digest &&
      operationPlanDigest(command) === b.command_digest;
  }
  beginAttempt(command: ExecuteCommand, admission?: ExecutionAdmission): boolean {
    if (!this.canExecute(command)) return false;
    if (!this.isBound(command.id)) return true;
    const admitted = admission === undefined ? undefined : ExecutionAdmissionSchema.parse(admission);
    if (admitted && (admitted.command_key !== createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex") ||
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

  /** 保存済みの同内容だけをJ→Mへ配送。作用・意味更新・承認復元は呼ばない。 */
  reconcileMemory(): boolean {
    if (this.recoveryRefreshPending) return false;
    if (this.memoryQuiesced) return false;
    if (!this.resultMemory) return true;
    this.memoryReady = false;
    try {
      if (this.port && operationPlanDigest(this.port.load()) !== this.savedDigest && this.savedDigest !== null) return false;
      for (const p of this.state.plans) {
        if (this.recoveryHolds.has(operationPlanDigest(p.revisions[0]!.plan.plan_id))) continue;
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

  /** Resolve explicit references to durable, J-verified file.write observations without exposing targets or content. */
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
      `${reference.plan_id_digest}:${reference.revision_digest}:${reference.step_id_digest}`);
    if (new Set(referenceKeys).size !== referenceKeys.length) {
      throw new Error("plan_compute_source_observation_reference_invalid");
    }
    const observations: OperationPlanComputeSourceObservation[] = [];
    for (const reference of references) {
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
      if (step.operation !== "file.write" || binding.operation !== "file.write" || binding.status !== "verified" ||
          binding.step_digest !== stepDigest(step) || !binding.execution_admission || !binding.delivery_digest ||
          !binding.result_digest || !binding.memory_commit || !binding.memory_receipt ||
          !verifyResultMemoryCommit(plan, binding) || !receiptForResultCommit(binding.memory_receipt, binding.memory_commit)) {
        throw new Error("plan_compute_source_observation_not_verified");
      }
      const result = plan.results.find((candidate) => candidate.plan_id === revision.plan.plan_id &&
        candidate.request_id === revision.plan.request_id && candidate.step_id === step.step_id &&
        candidate.operation === "file.write" && candidate.status === "succeeded");
      if (!result || result.observed_at_ms > Date.now()) throw new Error("plan_compute_source_observation_result_unavailable");
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
      observations.push(OperationPlanComputeSourceObservationSchema.parse({
        schema_version: "operation-plan-compute-source-observation.v1",
        source: "verified_file_write_result",
        plan_id_digest: reference.plan_id_digest,
        revision_digest: revision.digest,
        step_id_digest: reference.step_id_digest,
        operation: "file.write",
        plan_binding_status: "verified",
        plan_validation_status: "matched",
        effect_observation: "reported_success",
        record_digest: operationPlanDigest(stored.value),
        memory_revision: binding.memory_receipt.revision,
        memory_receipt_digest: binding.memory_receipt.receipt_digest,
        observed_at_ms: result.observed_at_ms,
        adoption_status: "observation_only",
        used_as_world_truth: false,
        used_for_authority: false,
        may_execute: false,
      }));
    }
    if (operationPlanDigest(this.port.load()) !== this.savedDigest || this.resultMemory.snapshot()?.status !== "ready") {
      throw new Error("plan_compute_source_observation_stale");
    }
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
        citations.push({ evidence_type: "external_receipt", record_id: identity.record_id,
          record_digest: operationPlanDigest(record.value), memory_revision: delivery.memory_receipt.revision,
          receipt_digest: delivery.memory_receipt.receipt_digest, source_revision_digest: current.digest,
          step_digest: b.step_digest, observed_at_ms: observation.observed_at_ms, evidence_digest: observation.evidence_digest,
          operation: step.operation, observation: { source: "local_inspection", reconciliation_status: observation.status,
            match_count: observation.match_count, ...(observation.receipt_digest ? { observed_receipt_digest: observation.receipt_digest } : {}),
            action_outcome: "outcome_unknown" }, adoption_status: "observation_only", counterevidence_status: "not_assessed",
          used_as_world_truth: false, used_for_authority: false, may_execute: false });
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
    return { schema_version: "operation-result-current-projection.v1", scope: { plan_handle: operationPlanDigest(current.plan.plan_id),
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
        observed_at_ms < binding.execution_admission.issued_at_ms) {
      throw new Error("external_receipt_observation_command_mismatch");
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
      plans: this.state.plans.map((p) => {
        const currentRevision = p.revisions.at(-1)!;
        const planIdDigest = operationPlanDigest(p.revisions[0]!.plan.plan_id);
        const recoveryHold = this.recoveryHolds.get(planIdDigest);
        return { plan_id: planIdDigest,
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
          return { step_id: operationPlanDigest(step.step_id), operation: step.operation,
            definition_digest: stepDigest(step), status: binding?.status ?? "not_selected",
            external_receipt_observation: binding?.status !== "outcome_unknown" ? "not_applicable" : observation?.status ?? "not_recorded",
            ...(observation ? { external_receipt: {
              source: observation.source, match_count: observation.match_count, evidence_digest: observation.evidence_digest,
              ...(observation.receipt_digest ? { receipt_digest: observation.receipt_digest } : {}),
              observed_at_ms: observation.observed_at_ms, used_for_authority: false as const, raw_receipt_exposed: false as const,
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

  /** Request-declared conflicts constrain plan selection; support remains an unverified claim. */
  private requestGoalCriteriaIssue(p: PlanState, step: OperationStep): string | undefined {
    const projection = p.request_goal_criteria;
    if (!projection) return "plan_goal_criteria_source_unavailable";
    const requestId = p.revisions[0]!.plan.request_id;
    const contentSha256 = createHash("sha256").update(p.goal, "utf8").digest("hex");
    if (projection.request_id !== requestId || projection.content_sha256 !== contentSha256 || projection.status === "invalid") {
      return "plan_goal_criteria_source_invalid";
    }
    if (projection.status === "not_provided") return undefined;
    const descriptor = getOperationDescriptor(step.operation);
    if (!descriptor) return "plan_goal_criteria_operation_unavailable";
    const assessment = assessCandidateGoalCriteria(descriptor.tool_name ?? descriptor.operation_id, projection, {
      request_id: requestId,
      content_sha256: contentSha256,
    });
    if (assessment.reason_code === "criteria_invalid") return "plan_goal_criteria_source_invalid";
    if (assessment.outcome === "conflicts") return "plan_goal_criteria_conflict";
    return undefined;
  }

  private ownedPlan(id: string, caller: InboundRequest): PlanState {
    const matches = this.state.plans.filter((p) => p.revisions[0]!.plan.plan_id === id || operationPlanDigest(p.revisions[0]!.plan.plan_id) === id);
    const p = matches[0];
    if (matches.length !== 1 || !p || p.owner !== caller.user || p.channel !== caller.channel) throw new Error("plan_owner_or_identity_mismatch");
    return p;
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
    if (step.operation !== "gmail.write" || step.parameters?.operation !== "message.send") {
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
    this.port?.compareAndSet(this.savedDigest, checked);
    this.state = checked;
    this.savedDigest = operationPlanDigest(checked);
  }
}
