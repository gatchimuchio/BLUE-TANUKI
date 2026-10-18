import { createHash, randomUUID } from "node:crypto";
import {
  getOperationDescriptor, inspectOperationCommandExecutionResult,
  OperationJsonValueSchema, OperationPlanCheckpointSchema, OperationPlanSchema, prepareOperationPlan,
  type ExecuteCommand, type ExecuteFeedback, type InboundRequest, type OperationPlan,
  type OperationPlanCheckpoint, type OperationPlanControl, type OperationStep,
  ExecutionAdmissionSchema, inspectExecutionResultDelivery, type ExecutionAdmission, type ExecutionResultDelivery,
  OperationPlanExternalReceiptObservationSchema,
  OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION, type OperationPlanReflectionControl,
  type OperationPlanReceiptReconciliationControl,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator } from "./制御状態.js";
import type { JMemoryApprovalReference } from "./保存取引.js";
import { buildResultMemoryCommit, resultMemoryIdentity, verifyResultMemoryCommit, receiptForResultCommit } from "./operation_result_memory.js";
import type { ResultObservationCitation, ResultObservationProjection } from "./operation_result_reflection.js";

type PlanState = OperationPlanCheckpoint["plans"][number];
type Binding = PlanState["bindings"][number];
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

export type OperationPlanRecoveryHoldReason = "held_residual" | "held_unobserved" | "held_unverified";
export type OperationPlanRecoveryScopeRelation = "requested" | "collateral" | "unknown";

export interface OperationPlanRecoveryEvidenceProvenance {
  readonly source: "recovery_restore" | "unverified_history";
  readonly command_id_digest: string | null;
  readonly operation_digest: string | null;
  readonly result_digest: string | null;
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
    restore_backup_id_digest: null, restore_scope_plan_digest: null, restored_state_digest: null,
  };
  const digestOrNull = (digest: unknown): digest is string | null => digest === null ||
    (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
        "restore_backup_id_digest", "restore_scope_plan_digest", "restored_state_digest"].includes(key)) ||
      !["recovery_restore", "unverified_history"].includes(String(raw.source)) ||
      !digestOrNull(raw.command_id_digest) || !digestOrNull(raw.operation_digest) ||
      !digestOrNull(raw.result_digest) || !digestOrNull(raw.restore_backup_id_digest) ||
      (raw.restore_scope_plan_digest !== undefined && !digestOrNull(raw.restore_scope_plan_digest)) ||
      !digestOrNull(raw.restored_state_digest)) throw new Error("plan_recovery_evidence_invalid");
  return {
    source: raw.source as OperationPlanRecoveryEvidenceProvenance["source"],
    command_id_digest: raw.command_id_digest,
    operation_digest: raw.operation_digest,
    result_digest: raw.result_digest,
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
      restore_backup_id_digest: provenance.restore_backup_id_digest,
      restore_scope_plan_digest: provenance.restore_scope_plan_digest,
      restored_state_digest: provenance.restored_state_digest,
    });
    if (Object.keys(provenance).some((key) => !["source", "command_id_digest", "operation_digest", "result_digest",
      "restore_backup_id_digest", "restore_scope_plan_digest", "restored_state_digest", "checkpoint_digest"].includes(key)) ||
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
  if (step.operation !== "gmail.write" || step.adapter !== "external_api" ||
      step.target.kind !== "external_service" || step.target.id !== "gmail" || !parameters ||
      parameters.operation !== "message.send" || typeof parameters.to !== "string" ||
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
    recoveryEvidence?: OperationPlanRecoveryEvidence) {
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
    if (!this.port || this.recoveryRefreshPending || this.activePlanAttempts.size > 0) return false;
    if (this.state.plans.length === 0) return true;
    if (!this.savedDigest) return false;
    const evidence = parseOperationPlanRecoveryEvidence({
      schema_version: "operation-plan-recovery-evidence.v1",
      scope: "unverified_history",
      checkpoint_digest: this.savedDigest,
      provenance: {
        source: "recovery_restore",
        command_id_digest: recoveryCommandIdDigest(command.id),
        operation_digest: null,
        result_digest: null,
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
    return true;
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
      held_unobserved: 1, held_residual: 2, held_unverified: 3,
    };
    if (rank[reason] > rank[existing.reason]) this.recoveryHolds.set(planIdDigest,
      { reason, restore_scope_relation: restoreScopeRelation, provenance });
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

  retainCandidate(value: unknown, origin: InboundRequest): void {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    const plan = candidatePlan(value);
    const expected = origin.metadata?.["blue_tanuki.operation_core.request_id"] ?? origin.id;
    if (plan.request_id !== expected || this.state.plans.some((p) => p.revisions[0]!.plan.plan_id === plan.plan_id)) {
      throw new Error("plan_source_binding_mismatch");
    }
    this.change((state) => state.plans.push({ owner: origin.user, channel: origin.channel, goal: origin.content,
      revisions: [{ digest: operationPlanDigest(plan), plan }], receipt_observations: [], bindings: [], results: [] }));
  }

  inspectControl(control: Extract<OperationPlanControl, { action: "review" | "revise" }>, caller: InboundRequest): {
    plan_id: string; revision_digest: string; step?: OperationStep; goal: string;
  } {
    if (this.recoveryRefreshPending) throw new Error("plan_recovery_refresh_hold");
    if (!this.reconcileMemory()) throw new Error("plan_memory_commit_pending");
    const p = this.ownedPlan(control.plan_id, caller);
    if (control.action === "review") {
      const recoveryHold = this.recoveryHolds.get(operationPlanDigest(p.revisions[0]!.plan.plan_id));
      if (recoveryHold) throw new Error(`plan_recovery_${recoveryHold.reason.slice("held_".length)}_hold`);
    }
    const current = p.revisions.at(-1)!;
    const expected = control.action === "review" ? control.revision_digest : control.expected_revision_digest;
    if (expected !== current.digest) throw new Error("plan_revision_changed");
    if (control.action === "revise") {
      this.revisionImpact(p, control.plan);
      return { plan_id: control.plan_id, revision_digest: expected, goal: p.goal };
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
    return { plan_id: current.plan.plan_id, revision_digest: expected, step, goal: p.goal };
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
    const step = p.revisions.at(-1)!.plan.steps.find((s) => s.step_id === b.step_id);
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
          if (original.status !== "verified") continue;
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
      return !this.resultMemory || match.b.status !== "verified" || verifyResultMemoryCommit(match.p, match.b);
    } catch { return false; }
  }
  closeMemory(): void {
    this.memoryQuiesced = true;
    this.memoryReady = false;
    this.resultMemory?.close();
    this.resultMemory = undefined;
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
      const bindings = p.bindings.filter((b) => b.step_id === step.step_id && b.status === "verified" && b.revision_digest === current.digest);
      const b = bindings[0];
      if (bindings.length !== 1 || !b || !b.memory_commit || !b.memory_receipt || !verifyResultMemoryCommit(p, b) ||
          !receiptForResultCommit(b.memory_receipt, b.memory_commit) || b.step_digest !== stepDigest(step)) throw new Error("plan_reflection_observation_not_current");
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
      if (Date.now() < result.observed_at_ms || Date.now() >= result.expires_at_ms) throw new Error("plan_reflection_observation_expired");
      const output = result.output;
      if (!output || typeof output !== "object" || Array.isArray(output) || !Array.isArray(output.matches) ||
          typeof output.visited_files !== "number" || !Number.isSafeInteger(output.visited_files) || output.visited_files < 0) {
        throw new Error("plan_reflection_summary_not_available");
      }
      citations.push({ record_id: resultMemoryIdentity(b).record_id, record_digest: operationPlanDigest(record.value),
        memory_revision: b.memory_receipt.revision, receipt_digest: b.memory_receipt.receipt_digest,
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
    for (const p of this.state.plans) for (const b of p.bindings) {
      const c = b.memory_commit;
      if (c && c.update_id === reference.update_id && c.j_event_id === reference.j_event_id &&
          c.content_digest === reference.content_digest && verifyResultMemoryCommit(p, b)) return Object.freeze({ ...reference });
    }
    return null;
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
    return { schema_version: "operation-plan-projection.v1", used_for_authority: false as const, raw_payload_exposed: false as const,
      recovery_refresh_status: this.recoveryRefreshPending ? "pending" as const : "ready" as const,
      result_memory: { configured: !!this.resultMemory, status: !this.resultMemory ? "not_configured" : this.memoryReady ? "receipt_confirmed" : "pending_or_unavailable",
        used_for_authority: false as const },
      plans: this.state.plans.map((p) => {
        const currentRevision = p.revisions.at(-1)!;
        const planIdDigest = operationPlanDigest(p.revisions[0]!.plan.plan_id);
        const recoveryHold = this.recoveryHolds.get(planIdDigest);
        return { plan_id: planIdDigest,
        request_id: p.revisions[0]!.plan.request_id, revision: p.revisions.length,
        revision_digest: currentRevision.digest, previous_revision_digests: p.revisions.slice(0, -1).map((r) => r.digest),
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
