import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  CANONICAL_STATE_STORE_PATHS,
  resolveCanonicalStateStoreInspectionPath,
  type CanonicalStateSnapshotManifest,
  type CanonicalStateStoreKey,
} from "./canonical_state_backup.js";
import {
  inspectJControlRecoveryLedger,
  inspectMemoryRecoveryLedger,
  type PersistenceLedgerInspection,
} from "@blue-tanuki/hds-brain";
import {
  inspectExecutionIntentRecoveryLedger,
  type ExecutionIntentRecoveryInspection,
} from "./execution_intent_store.js";
import {
  inspectOperationPlanRecoveryLedger,
  type OperationPlanBindingStatus,
  type OperationPlanRecoveryPlanSummary,
  type OperationPlanRecoveryInspection,
} from "./operation_plan_recovery_inspection.js";
import {
  inspectCronEventRecoveryLedger,
  type CronApprovalCommandMatch,
  type CronEventRecoveryInspection,
  type CronEventRecoveryLedgerInspection,
  type CronEventRecoveryReason,
  type CronEventRecoveryStatus,
} from "./cron_event_recovery_inspection.js";
import {
  inspectDocumentOrganizationCheckpointLedger,
  type DocumentOrganizationCheckpointRecordInspection,
  type DocumentOrganizationCheckpointRecoveryInspection,
} from "./document_organization_recovery_inspection.js";

export interface RecoveryUpdateResidual {
  readonly update_id_digest: string;
  readonly disposition:
    | "paired"
    | "pending_m_commit"
    | "pending_j_receipt"
    | "missing_verified_j_link"
    | "missing_verified_m_link"
    | "content_mismatch"
    | "event_identity_mismatch"
    | "revision_mismatch"
    | "receipt_mismatch"
    | "m_present_for_blocked_j"
    | "blocked_j"
    | "m_state_unverified"
    | "j_state_unverified";
}

export interface GatewayRecoveryInspectionReport {
  readonly schema_version: 8;
  readonly surface: "recovery_inspection";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present";
  readonly ledgers: {
    readonly j: PersistenceLedgerInspection;
    readonly m: PersistenceLedgerInspection;
    readonly execution: ExecutionIntentRecoveryInspection;
    readonly operation_plans: OperationPlanRecoveryInspection;
    readonly cron_events: CronEventRecoveryInspection;
    readonly document_organization_checkpoints: DocumentOrganizationCheckpointRecoveryInspection;
  };
  readonly operation_plan_correlations: readonly OperationPlanBrokerCorrelation[];
  readonly plan_dependency_scopes: readonly RecoveryPlanDependencyScope[];
  readonly replay_checkpoint: null | {
    readonly verified: true;
    readonly kind: "canonical_replay_checkpoint_not_backup";
    readonly j_revision: number;
    readonly j_event_digest: string;
    readonly m_revision: number;
    readonly m_event_digest: string;
    readonly update_count: number;
    readonly operation_plan_count: number;
    readonly operation_plan_binding_count: number;
  };
  readonly update_residuals: readonly RecoveryUpdateResidual[];
  readonly isolated_update_count: number;
  readonly execution_residual_count: number;
  readonly operation_plan_residual_count: number;
  readonly cron_event_residual_count: number;
  readonly cron_approval_correlation_residual_count: number;
  readonly document_organization_checkpoint_residual_count: number;
  readonly external_backup_restore_point: "not_examined";
  readonly used_for_authority: false;
  readonly may_execute: false;
  readonly next_safe_action: string;
}

export interface OperationPlanBrokerCorrelation {
  readonly plan_id_digest: string;
  readonly step_id_digest: string;
  readonly command_id_digest: string;
  readonly status: OperationPlanBindingStatus;
  readonly binding_integrity: "verified" | "residuals_present";
  readonly admission_digest: string | null;
  readonly broker_correlation:
    | "matched"
    | "not_admitted"
    | "admission_missing"
    | "not_found"
    | "not_observed_due_to_limit"
    | "ambiguous"
    | "broker_unverified"
    | "j_binding_unverified";
  readonly broker_state: ExecutionIntentRecoveryInspection["records"][number]["state"] | null;
  readonly delivery_correlation:
    | "matched"
    | "not_recorded"
    | "j_not_recorded"
    | "broker_not_recorded"
    | "mismatch"
    | "not_observed";
  readonly memory_update_id_digest: string | null;
  readonly memory_correlation:
    | "not_recorded"
    | "missing_plan_memory_link"
    | "binding_unverified"
    | "j_state_unverified"
    | "m_state_unverified"
    | "missing_verified_j_link"
    | "missing_verified_m_link"
    | "pending_m_commit"
    | "pending_j_receipt"
    | "blocked_j"
    | "m_present_for_blocked_j"
    | "content_mismatch"
    | "event_identity_mismatch"
    | "revision_mismatch"
    | "receipt_mismatch"
    | "ambiguous"
    | "matched";
  readonly cron_approval_correlation:
    | "not_recorded"
    | "pending"
    | "interrupted"
    | "resolved"
    | "ambiguous"
    | "not_observed_due_to_limit"
    | "cron_unverified"
    | "plan_binding_unverified";
}

export type RecoveryPlanDependencyCategory = "operation_plan" | "broker" | "delivery" | "memory" | "cron_approval";

/** Digest-only plan evidence; this is not a job recovery or restore authorization. */
export interface RecoveryPlanDependencyScope extends OperationPlanRecoveryPlanSummary {
  readonly status: "observed" | "residuals_present" | "unobserved";
  readonly inspected_binding_count: number;
  readonly residual_dependencies: readonly RecoveryPlanDependencyCategory[];
  readonly unobserved_dependencies: readonly RecoveryPlanDependencyCategory[];
}

export interface RecoveryRequestScopeCorrelationEntry {
  readonly request_scope_digest: string;
  readonly relationship: "both_ledgers" | "operation_plan_only" | "document_checkpoint_only" | "counterpart_unresolved";
  readonly status: "observed" | "residuals_present" | "unobserved";
  readonly operation_plan_scope_count: number;
  readonly residual_operation_plan_scope_count: number;
  readonly unobserved_operation_plan_scope_count: number;
  readonly verified_document_checkpoint_count: number;
  readonly unresolved_document_checkpoint_count: number;
}

/** Read-only cross-ledger correlation; this never identifies a job or authorizes recovery. */
export interface RecoveryRequestScopeCorrelation {
  readonly status: "available" | "not_verified";
  readonly entries: readonly RecoveryRequestScopeCorrelationEntry[];
  readonly matched_scope_count: number | null;
  readonly operation_plan_only_scope_count: number | null;
  readonly document_checkpoint_only_scope_count: number | null;
  readonly counterpart_unresolved_scope_count: number | null;
  readonly unlinked_operation_plan_scope_count: number | null;
  readonly unlinked_document_checkpoint_count: number | null;
}

export interface RecoveryLedgerBoundaryObservation {
  readonly reason: PersistenceLedgerInspection["reason"] | ExecutionIntentRecoveryInspection["reason"] | "unknown";
  readonly verified_event_count: number | null;
  readonly unverified_event_count: number | null;
  readonly first_unverified_ordinal: number | null;
  readonly last_verified_revision: number | null;
}

export interface GatewayRecoveryOperatorProjection {
  readonly schema_version: 8;
  readonly surface: "recovery_inspection_operator";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present" | "invalid_report";
  readonly ledgers: {
    readonly j: string;
    readonly m: string;
    readonly broker: string;
    readonly operation_plans: string;
    readonly cron_events: string;
    readonly document_organization_checkpoints: string;
  };
  readonly cron_event_summary: Omit<CronEventRecoveryInspection, "used_for_authority">;
  readonly document_organization_checkpoint_summary: Omit<DocumentOrganizationCheckpointRecoveryInspection, "used_for_authority">;
  readonly ledger_boundaries: {
    readonly j: RecoveryLedgerBoundaryObservation;
    readonly m: RecoveryLedgerBoundaryObservation;
    readonly broker: RecoveryLedgerBoundaryObservation;
  };
  readonly replay_checkpoint: "verified_replay_checkpoint_not_backup" | "not_verified";
  readonly isolated_update_count: number;
  readonly execution_residual_count: number;
  readonly operation_plan_residual_count: number;
  readonly cron_event_residual_count: number;
  readonly cron_approval_correlation_residual_count: number;
  readonly document_organization_checkpoint_residual_count: number;
  readonly operation_plan_correlations: readonly {
    readonly plan_id_digest: string;
    readonly step_id_digest: string;
    readonly command_id_digest: string;
    readonly status: OperationPlanBindingStatus;
    readonly binding_integrity: "verified" | "residuals_present";
    readonly admission_digest: string | null;
    readonly broker_correlation: OperationPlanBrokerCorrelation["broker_correlation"];
    readonly delivery_correlation: OperationPlanBrokerCorrelation["delivery_correlation"];
    readonly memory_update_id_digest: string | null;
    readonly memory_correlation: OperationPlanBrokerCorrelation["memory_correlation"];
    readonly cron_approval_correlation: OperationPlanBrokerCorrelation["cron_approval_correlation"];
  }[];
  readonly omitted_operation_plan_correlation_count: number;
  readonly plan_dependency_scopes: readonly RecoveryPlanDependencyScope[];
  readonly omitted_plan_dependency_scope_count: number;
  readonly request_scope_correlation: RecoveryRequestScopeCorrelation;
  readonly update_residuals: readonly RecoveryUpdateResidual[];
  readonly omitted_update_residual_count: number;
  readonly external_backup_restore_point: "not_examined";
  readonly boundary_valid: boolean;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

const OPERATOR_RECORD_LIMIT = 200;
const OPERATION_PLAN_LIMIT = 64;
const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const OPERATION_PLAN_STATUSES: readonly OperationPlanBindingStatus[] = [
  "selected", "intent_committed", "verified", "outcome_unknown", "verification_failed", "not_attempted", "invalidated",
];
const UPDATE_DISPOSITIONS: readonly RecoveryUpdateResidual["disposition"][] = [
  "paired", "pending_m_commit", "pending_j_receipt", "missing_verified_j_link", "missing_verified_m_link",
  "content_mismatch", "event_identity_mismatch", "revision_mismatch", "receipt_mismatch",
  "m_present_for_blocked_j", "blocked_j", "m_state_unverified", "j_state_unverified",
];
const BROKER_CORRELATIONS: readonly OperationPlanBrokerCorrelation["broker_correlation"][] = [
  "matched", "not_admitted", "admission_missing", "not_found", "not_observed_due_to_limit", "ambiguous",
  "broker_unverified", "j_binding_unverified",
];
const DELIVERY_CORRELATIONS: readonly OperationPlanBrokerCorrelation["delivery_correlation"][] = [
  "matched", "not_recorded", "j_not_recorded", "broker_not_recorded", "mismatch", "not_observed",
];
const MEMORY_CORRELATIONS: readonly OperationPlanBrokerCorrelation["memory_correlation"][] = [
  "not_recorded", "missing_plan_memory_link", "binding_unverified", "j_state_unverified", "m_state_unverified", "missing_verified_j_link",
  "missing_verified_m_link", "pending_m_commit", "pending_j_receipt", "blocked_j", "m_present_for_blocked_j",
  "content_mismatch", "event_identity_mismatch", "revision_mismatch", "receipt_mismatch", "ambiguous", "matched",
];
const CRON_APPROVAL_CORRELATIONS: readonly OperationPlanBrokerCorrelation["cron_approval_correlation"][] = [
  "not_recorded", "pending", "interrupted", "resolved", "ambiguous", "not_observed_due_to_limit", "cron_unverified", "plan_binding_unverified",
];
const CRON_APPROVAL_CORRELATION_RESIDUALS = new Set<OperationPlanBrokerCorrelation["cron_approval_correlation"]>([
  "ambiguous", "not_observed_due_to_limit", "cron_unverified", "plan_binding_unverified",
]);
const PLAN_DEPENDENCY_CATEGORIES: readonly RecoveryPlanDependencyCategory[] = [
  "operation_plan", "broker", "delivery", "memory", "cron_approval",
];
const RECOVERY_LEDGER_REASONS: readonly NonNullable<RecoveryLedgerBoundaryObservation["reason"]>[] = [
  "disk_full", "write_failed", "sync_failed", "schema_mismatch", "ledger_corrupt", "projection_mismatch",
  "store_unavailable", "outbox_mismatch",
];
const RECOVERY_LEDGER_STATUSES = ["verified", "projection_mismatch", "corrupt", "residuals_present", "unavailable", "schema_mismatch"] as const;
const CRON_RECOVERY_STATUSES: readonly CronEventRecoveryStatus[] = ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"];
const CRON_RECOVERY_REASONS: readonly CronEventRecoveryReason[] = ["store_unavailable", "schema_mismatch", "ledger_corrupt", "outbox_mismatch"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixedEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function fixedDigest(value: unknown): string | null {
  return typeof value === "string" && HEX_DIGEST.test(value) ? value.toLowerCase() : null;
}

function fixedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function unknownLedgerBoundary(): RecoveryLedgerBoundaryObservation {
  return {
    reason: "unknown",
    verified_event_count: null,
    unverified_event_count: null,
    first_unverified_ordinal: null,
    last_verified_revision: null,
  };
}

function projectLedgerBoundary(
  value: unknown,
  enabled: boolean,
  hasRevision: boolean,
): RecoveryLedgerBoundaryObservation {
  if (!enabled || !isRecord(value)) return unknownLedgerBoundary();
  const status = fixedEnum(value.status, RECOVERY_LEDGER_STATUSES);
  const reason = value.reason === null ? null : fixedEnum(value.reason, RECOVERY_LEDGER_REASONS) ?? "unknown";
  if (!status) return unknownLedgerBoundary();
  if (status === "unavailable" || status === "schema_mismatch") {
    return { ...unknownLedgerBoundary(), reason };
  }

  const verified = typeof value.verified_event_count === "number" && Number.isSafeInteger(value.verified_event_count) && value.verified_event_count >= 0
    ? value.verified_event_count : null;
  const unverified = typeof value.unverified_event_count === "number" && Number.isSafeInteger(value.unverified_event_count) && value.unverified_event_count >= 0
    ? value.unverified_event_count : null;
  const firstUnverified = value.first_unverified_ordinal === null
    ? null
    : typeof value.first_unverified_ordinal === "number" && Number.isSafeInteger(value.first_unverified_ordinal) && value.first_unverified_ordinal > 0
      ? value.first_unverified_ordinal : undefined;
  const lastVerifiedRevision = hasRevision
    ? typeof value.last_verified_revision === "number" && Number.isSafeInteger(value.last_verified_revision) && value.last_verified_revision >= 0
      ? value.last_verified_revision : null
    : null;
  const countsValid = verified !== null && unverified !== null && Number.isSafeInteger(verified + unverified) &&
    firstUnverified !== undefined &&
    (unverified === 0 ? firstUnverified === null : firstUnverified === verified + 1) &&
    (status !== "verified" || unverified === 0) &&
    (!hasRevision || lastVerifiedRevision !== null);
  if (!countsValid) return { ...unknownLedgerBoundary(), reason };

  return {
    reason,
    verified_event_count: verified,
    unverified_event_count: unverified,
    first_unverified_ordinal: firstUnverified,
    last_verified_revision: lastVerifiedRevision,
  };
}

function projectOperatorOperationPlanCorrelations(
  values: readonly unknown[],
  enabled: boolean,
): { rows: GatewayRecoveryOperatorProjection["operation_plan_correlations"]; omitted: number } {
  const rows: NonNullable<GatewayRecoveryOperatorProjection["operation_plan_correlations"]>[number][] = [];
  for (const value of enabled ? values.slice(0, OPERATOR_RECORD_LIMIT) : []) {
    if (!isRecord(value)) continue;
    const planIdDigest = fixedDigest(value.plan_id_digest);
    const stepIdDigest = fixedDigest(value.step_id_digest);
    const commandIdDigest = fixedDigest(value.command_id_digest);
    const status = fixedEnum(value.status, OPERATION_PLAN_STATUSES);
    const bindingIntegrity = fixedEnum(value.binding_integrity, ["verified", "residuals_present"] as const);
    const admissionDigest = value.admission_digest === null ? null : fixedDigest(value.admission_digest);
    const brokerCorrelation = fixedEnum(value.broker_correlation, BROKER_CORRELATIONS);
    const deliveryCorrelation = fixedEnum(value.delivery_correlation, DELIVERY_CORRELATIONS);
    const memoryUpdateIdDigest = value.memory_update_id_digest === null ? null : fixedDigest(value.memory_update_id_digest);
    const memoryCorrelation = fixedEnum(value.memory_correlation, MEMORY_CORRELATIONS);
    const cronApprovalCorrelation = fixedEnum(value.cron_approval_correlation, CRON_APPROVAL_CORRELATIONS);
    if (!planIdDigest || !stepIdDigest || !commandIdDigest || !status || !bindingIntegrity ||
        (value.admission_digest !== null && !admissionDigest) || !brokerCorrelation || !deliveryCorrelation ||
        (value.memory_update_id_digest !== null && !memoryUpdateIdDigest) || !memoryCorrelation || !cronApprovalCorrelation) continue;
    rows.push({
      plan_id_digest: planIdDigest,
      step_id_digest: stepIdDigest,
      command_id_digest: commandIdDigest,
      status,
      binding_integrity: bindingIntegrity,
      admission_digest: admissionDigest,
      broker_correlation: brokerCorrelation,
      delivery_correlation: deliveryCorrelation,
      memory_update_id_digest: memoryUpdateIdDigest,
      memory_correlation: memoryCorrelation,
      cron_approval_correlation: cronApprovalCorrelation,
    });
  }
  return { rows, omitted: values.length - rows.length };
}

type RecoveryPlanDependencyCorrelation = Pick<OperationPlanBrokerCorrelation,
  | "plan_id_digest"
  | "binding_integrity"
  | "broker_correlation"
  | "delivery_correlation"
  | "memory_correlation"
  | "cron_approval_correlation"
>;

/** Group plan evidence without upgrading an observed plan to a recoverable job or restore point. */
export function buildRecoveryPlanDependencyScopes(
  plans: readonly OperationPlanRecoveryPlanSummary[],
  correlations: readonly RecoveryPlanDependencyCorrelation[],
): RecoveryPlanDependencyScope[] {
  const correlationsByPlan = new Map<string, RecoveryPlanDependencyCorrelation[]>();
  for (const correlation of correlations) {
    correlationsByPlan.set(correlation.plan_id_digest, [
      ...(correlationsByPlan.get(correlation.plan_id_digest) ?? []), correlation,
    ]);
  }

  return plans.map((plan) => {
    const rows = correlationsByPlan.get(plan.plan_id_digest) ?? [];
    const residual = new Set<RecoveryPlanDependencyCategory>();
    const unobserved = new Set<RecoveryPlanDependencyCategory>();
    if (plan.integrity === "residuals_present" || plan.residual_binding_count > 0) residual.add("operation_plan");

    for (const row of rows) {
      if (row.binding_integrity === "residuals_present") residual.add("operation_plan");

      if (["matched", "not_admitted"].includes(row.broker_correlation)) {
        // Broker relationship is either verified or this plan binding was not admitted.
      } else if (["not_observed_due_to_limit", "broker_unverified", "j_binding_unverified"].includes(row.broker_correlation)) {
        unobserved.add("broker");
      } else {
        residual.add("broker");
      }

      if (row.broker_correlation === "matched") {
        if (["matched", "not_recorded"].includes(row.delivery_correlation)) {
          // No unresolved delivery dependency was observed.
        } else if (row.delivery_correlation === "not_observed") {
          unobserved.add("delivery");
        } else {
          residual.add("delivery");
        }
      } else if (row.broker_correlation !== "not_admitted") {
        unobserved.add("delivery");
      }

      if (["not_recorded", "matched"].includes(row.memory_correlation)) {
        // No unresolved memory dependency was observed.
      } else if (["binding_unverified", "j_state_unverified", "m_state_unverified"].includes(row.memory_correlation)) {
        unobserved.add("memory");
      } else {
        residual.add("memory");
      }

      if (["not_recorded", "resolved"].includes(row.cron_approval_correlation)) {
        // No unresolved approval handoff was observed.
      } else if (["not_observed_due_to_limit", "cron_unverified", "plan_binding_unverified"].includes(row.cron_approval_correlation)) {
        unobserved.add("cron_approval");
      } else {
        residual.add("cron_approval");
      }
    }

    const omittedBindingCount = Math.max(plan.omitted_binding_count, plan.binding_count - rows.length);
    const expectedObservedBindingCount = Math.max(0, plan.binding_count - omittedBindingCount);
    if (rows.length !== expectedObservedBindingCount || omittedBindingCount > 0) {
      for (const category of ["broker", "delivery", "memory", "cron_approval"] as const) unobserved.add(category);
    }

    const status: RecoveryPlanDependencyScope["status"] = residual.size > 0
      ? "residuals_present"
      : unobserved.size > 0 ? "unobserved" : "observed";
    return {
      ...plan,
      omitted_binding_count: omittedBindingCount,
      status,
      inspected_binding_count: rows.length,
      residual_dependencies: PLAN_DEPENDENCY_CATEGORIES.filter((category) => residual.has(category)),
      unobserved_dependencies: PLAN_DEPENDENCY_CATEGORIES.filter((category) => unobserved.has(category)),
    };
  });
}

/** Correlate request scopes for inspection only; incomplete counterpart inventories remain unresolved. */
export function buildRecoveryRequestScopeCorrelation(
  planScopes: readonly RecoveryPlanDependencyScope[],
  documentCheckpointRecords: readonly DocumentOrganizationCheckpointRecordInspection[],
  options: { readonly operationPlanInventoryComplete: boolean; readonly documentCheckpointInventoryComplete: boolean },
): RecoveryRequestScopeCorrelation {
  const groups = new Map<string, {
    planScopes: RecoveryPlanDependencyScope[];
    verifiedCheckpoints: number;
    unresolvedCheckpoints: number;
  }>();
  let unlinkedPlanScopes = 0;
  let unlinkedDocumentCheckpoints = 0;
  const getGroup = (digest: string) => {
    const existing = groups.get(digest);
    if (existing) return existing;
    const created = { planScopes: [], verifiedCheckpoints: 0, unresolvedCheckpoints: 0 };
    groups.set(digest, created);
    return created;
  };

  for (const scope of planScopes) {
    if (!scope.request_scope_digest) {
      unlinkedPlanScopes += 1;
      continue;
    }
    getGroup(scope.request_scope_digest).planScopes.push(scope);
  }
  for (const record of documentCheckpointRecords) {
    if (record.integrity !== "verified" || !record.request_scope_digest) {
      unlinkedDocumentCheckpoints += 1;
      continue;
    }
    const group = getGroup(record.request_scope_digest);
    group.verifiedCheckpoints += 1;
    if (record.checkpoint_status !== "completed") group.unresolvedCheckpoints += 1;
  }

  const entries: RecoveryRequestScopeCorrelationEntry[] = [...groups.entries()].map(([digest, group]) => {
    const operationPlanScopeCount = group.planScopes.length;
    const residualPlanScopeCount = group.planScopes.filter((scope) => scope.status === "residuals_present").length;
    const unobservedPlanScopeCount = group.planScopes.filter((scope) => scope.status === "unobserved").length;
    const hasPlans = operationPlanScopeCount > 0;
    const hasCheckpoints = group.verifiedCheckpoints > 0;
    const relationship: RecoveryRequestScopeCorrelationEntry["relationship"] = hasPlans && hasCheckpoints
      ? "both_ledgers"
      : hasPlans && options.documentCheckpointInventoryComplete && unlinkedDocumentCheckpoints === 0
        ? "operation_plan_only"
        : !hasPlans && hasCheckpoints && options.operationPlanInventoryComplete && unlinkedPlanScopes === 0
          ? "document_checkpoint_only"
          : "counterpart_unresolved";
    const status: RecoveryRequestScopeCorrelationEntry["status"] = residualPlanScopeCount > 0 || group.unresolvedCheckpoints > 0
      ? "residuals_present"
      : relationship === "counterpart_unresolved" || unobservedPlanScopeCount > 0 ? "unobserved" : "observed";
    return {
      request_scope_digest: digest,
      relationship,
      status,
      operation_plan_scope_count: operationPlanScopeCount,
      residual_operation_plan_scope_count: residualPlanScopeCount,
      unobserved_operation_plan_scope_count: unobservedPlanScopeCount,
      verified_document_checkpoint_count: group.verifiedCheckpoints,
      unresolved_document_checkpoint_count: group.unresolvedCheckpoints,
    };
  }).sort((left, right) => left.request_scope_digest < right.request_scope_digest ? -1 : left.request_scope_digest > right.request_scope_digest ? 1 : 0);

  return {
    status: "available",
    entries,
    matched_scope_count: entries.filter((entry) => entry.relationship === "both_ledgers").length,
    operation_plan_only_scope_count: entries.filter((entry) => entry.relationship === "operation_plan_only").length,
    document_checkpoint_only_scope_count: entries.filter((entry) => entry.relationship === "document_checkpoint_only").length,
    counterpart_unresolved_scope_count: entries.filter((entry) => entry.relationship === "counterpart_unresolved").length,
    unlinked_operation_plan_scope_count: options.operationPlanInventoryComplete ? unlinkedPlanScopes : null,
    unlinked_document_checkpoint_count: options.documentCheckpointInventoryComplete ? unlinkedDocumentCheckpoints : null,
  };
}

function projectOperationPlanSummaries(
  value: unknown,
  enabled: boolean,
): { rows: OperationPlanRecoveryPlanSummary[]; omitted: number; valid: boolean } {
  if (!Array.isArray(value)) return { rows: [], omitted: 0, valid: false };
  const rows: OperationPlanRecoveryPlanSummary[] = [];
  let valid = true;
  for (const item of enabled ? value.slice(0, OPERATION_PLAN_LIMIT) : []) {
    if (!isRecord(item)) {
      valid = false;
      continue;
    }
    const planIdDigest = fixedDigest(item.plan_id_digest);
    const requestScopeDigest = item.request_scope_digest === null ? null : fixedDigest(item.request_scope_digest);
    const integrity = fixedEnum(item.integrity, ["verified", "residuals_present"] as const);
    const planRecordCount = item.plan_record_count;
    const bindingCount = item.binding_count;
    const residualBindingCount = item.residual_binding_count;
    const omittedBindingCount = item.omitted_binding_count;
    if (!planIdDigest || (item.request_scope_digest !== null && !requestScopeDigest) || !integrity ||
        !Number.isSafeInteger(planRecordCount) || (planRecordCount as number) < 1 ||
        !Number.isSafeInteger(bindingCount) || (bindingCount as number) < 0 ||
        !Number.isSafeInteger(residualBindingCount) || (residualBindingCount as number) < 0 ||
        (residualBindingCount as number) > (bindingCount as number) ||
        !Number.isSafeInteger(omittedBindingCount) || (omittedBindingCount as number) < 0 ||
        (omittedBindingCount as number) > (bindingCount as number)) {
      valid = false;
      continue;
    }
    rows.push({
      plan_id_digest: planIdDigest,
      request_scope_digest: requestScopeDigest,
      integrity,
      plan_record_count: planRecordCount as number,
      binding_count: bindingCount as number,
      residual_binding_count: residualBindingCount as number,
      omitted_binding_count: omittedBindingCount as number,
    });
  }
  if (value.length > OPERATION_PLAN_LIMIT || rows.length !== value.length ||
      new Set(rows.map((item) => item.plan_id_digest)).size !== rows.length) valid = false;
  return { rows, omitted: Math.max(0, value.length - rows.length), valid };
}

function projectOperatorUpdateResiduals(
  values: readonly unknown[],
  enabled: boolean,
): { rows: GatewayRecoveryOperatorProjection["update_residuals"]; omitted: number } {
  const rows: RecoveryUpdateResidual[] = [];
  for (const value of enabled ? values.slice(0, OPERATOR_RECORD_LIMIT) : []) {
    if (!isRecord(value)) continue;
    const updateIdDigest = fixedDigest(value.update_id_digest);
    const disposition = fixedEnum(value.disposition, UPDATE_DISPOSITIONS);
    if (!updateIdDigest || !disposition) continue;
    rows.push({ update_id_digest: updateIdDigest, disposition });
  }
  return { rows, omitted: values.length - rows.length };
}

function projectCronEventSummary(value: unknown): {
  readonly summary: Omit<CronEventRecoveryInspection, "used_for_authority">;
  readonly valid: boolean;
} {
  const unknown: Omit<CronEventRecoveryInspection, "used_for_authority"> = {
    status: "unavailable",
    reason: "store_unavailable",
    cursor_count: null,
    verified_cursor_count: null,
    unverified_cursor_count: null,
    omitted_cursor_count: null,
    unresolved_cursor_count: null,
    orphan_outbox_count: null,
    approval_handoff_count: null,
    verified_approval_handoff_count: null,
    unverified_approval_handoff_count: null,
    omitted_approval_handoff_count: null,
    pending_approval_handoff_count: null,
    interrupted_approval_handoff_count: null,
    residual_count: 1,
  };
  if (!isRecord(value)) return { summary: unknown, valid: false };
  const status = fixedEnum(value.status, CRON_RECOVERY_STATUSES);
  const reason = value.reason === null ? null : fixedEnum(value.reason, CRON_RECOVERY_REASONS);
  const countKeys = [
    "cursor_count", "verified_cursor_count", "unverified_cursor_count", "omitted_cursor_count", "unresolved_cursor_count",
    "orphan_outbox_count", "approval_handoff_count", "verified_approval_handoff_count", "unverified_approval_handoff_count",
    "omitted_approval_handoff_count", "pending_approval_handoff_count", "interrupted_approval_handoff_count",
  ] as const;
  const counts = Object.fromEntries(countKeys.map((key) => {
    const item = value[key];
    return [key, item === null || (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) ? item : undefined];
  })) as Record<(typeof countKeys)[number], number | null | undefined>;
  const safeCounts = Object.fromEntries(countKeys.map((key) => [key, counts[key] === undefined ? null : counts[key]])) as
    Pick<Omit<CronEventRecoveryInspection, "used_for_authority" | "status" | "reason" | "residual_count">, (typeof countKeys)[number]>;
  const residualCount = value.residual_count;
  if (!status || (value.reason !== null && !reason) || value.used_for_authority !== false ||
      !Number.isSafeInteger(residualCount) || (residualCount as number) < 0 ||
      countKeys.some((key) => counts[key] === undefined)) return { summary: unknown, valid: false };
  if (["unavailable", "schema_mismatch", "corrupt"].includes(status)) {
    const countsUnknown = countKeys.every((key) => counts[key] === null);
    const expectedReason = status === "unavailable" ? "store_unavailable"
      : status === "schema_mismatch" ? "schema_mismatch" : "ledger_corrupt";
    if (!countsUnknown || (residualCount as number) < 1 || reason !== expectedReason) return { summary: unknown, valid: false };
    return { summary: { status, reason, ...safeCounts, residual_count: residualCount as number }, valid: true };
  }
  const numeric = countKeys.every((key) => typeof counts[key] === "number");
  if (!numeric) return { summary: unknown, valid: false };
  const cursorCount = counts.cursor_count as number;
  const verifiedCursorCount = counts.verified_cursor_count as number;
  const unverifiedCursorCount = counts.unverified_cursor_count as number;
  const omittedCursorCount = counts.omitted_cursor_count as number;
  const approvalCount = counts.approval_handoff_count as number;
  const verifiedApprovalCount = counts.verified_approval_handoff_count as number;
  const unverifiedApprovalCount = counts.unverified_approval_handoff_count as number;
  const omittedApprovalCount = counts.omitted_approval_handoff_count as number;
  const expectedResidualCount = unverifiedCursorCount + omittedCursorCount + (counts.unresolved_cursor_count as number) +
    (counts.orphan_outbox_count as number) + unverifiedApprovalCount + omittedApprovalCount +
    (counts.pending_approval_handoff_count as number) + (counts.interrupted_approval_handoff_count as number);
  const consistent = verifiedCursorCount + unverifiedCursorCount + omittedCursorCount === cursorCount &&
    verifiedApprovalCount + unverifiedApprovalCount + omittedApprovalCount === approvalCount &&
    Number.isSafeInteger(expectedResidualCount) && expectedResidualCount === residualCount &&
    ((status === "verified" && residualCount === 0) || (status === "residuals_present" && residualCount > 0)) &&
    (status !== "verified" || reason === null) &&
    (status !== "residuals_present" || reason === null || reason === "ledger_corrupt" || reason === "outbox_mismatch") &&
    (reason !== "ledger_corrupt" || unverifiedCursorCount + unverifiedApprovalCount > 0) &&
    (reason !== "outbox_mismatch" || (counts.orphan_outbox_count as number) > 0);
  if (!consistent) return { summary: unknown, valid: false };
  return { summary: { status, reason, ...safeCounts, residual_count: residualCount as number }, valid: true };
}

function projectDocumentOrganizationCheckpointSummary(value: unknown): {
  readonly summary: Omit<DocumentOrganizationCheckpointRecoveryInspection, "used_for_authority">;
  readonly valid: boolean;
} {
  const unknown: Omit<DocumentOrganizationCheckpointRecoveryInspection, "used_for_authority"> = {
    status: "unavailable", reason: "store_unavailable", checkpoint_count: null,
    verified_checkpoint_count: null, residual_checkpoint_count: null, omitted_checkpoint_count: null,
    unresolved_checkpoint_count: null, residual_count: 1, records: [],
  };
  if (!isRecord(value)) return { summary: unknown, valid: false };
  const statuses = ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"] as const;
  const reasons = ["store_unavailable", "schema_mismatch", "ledger_corrupt", "row_limit_reached", "unfinished_checkpoints"] as const;
  const checkpointStatuses = ["ready", "continuing", "completed", "held"] as const;
  const recordReasons = ["row_shape_invalid", "checkpoint_digest_mismatch", "checkpoint_json_invalid", "checkpoint_shape_invalid", "checkpoint_identity_mismatch"] as const;
  const status = fixedEnum(value.status, statuses);
  const reason = value.reason === null ? null : fixedEnum(value.reason, reasons);
  const countKeys = ["checkpoint_count", "verified_checkpoint_count", "residual_checkpoint_count", "omitted_checkpoint_count", "unresolved_checkpoint_count"] as const;
  const counts = Object.fromEntries(countKeys.map((key) => {
    const item = value[key];
    return [key, item === null || (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) ? item : undefined];
  })) as Record<(typeof countKeys)[number], number | null | undefined>;
  const safeCounts = Object.fromEntries(countKeys.map((key) => [key, counts[key] === undefined ? null : counts[key]])) as
    Pick<Omit<DocumentOrganizationCheckpointRecoveryInspection, "used_for_authority" | "status" | "reason" | "residual_count" | "records">, (typeof countKeys)[number]>;
  const residualCount = value.residual_count;
  if (!status || (value.reason !== null && !reason) || value.used_for_authority !== false ||
      !Number.isSafeInteger(residualCount) || (residualCount as number) < 0 || countKeys.some((key) => counts[key] === undefined)) {
    return { summary: unknown, valid: false };
  }
  const inputRecords = Array.isArray(value.records) ? value.records : null;
  if (!inputRecords || inputRecords.length > 128) return { summary: unknown, valid: false };
  const records: DocumentOrganizationCheckpointRecoveryInspection["records"][number][] = [];
  const seenReferences = new Set<string>();
  for (const input of inputRecords) {
    if (!isRecord(input)) return { summary: unknown, valid: false };
    const checkpointRefDigest = input.checkpoint_ref_digest === null ? null : fixedDigest(input.checkpoint_ref_digest);
    const requestScopeDigest = input.request_scope_digest === null ? null : fixedDigest(input.request_scope_digest);
    const integrity = fixedEnum(input.integrity, ["verified", "residuals_present"] as const);
    const recordReason = input.reason === null ? null : fixedEnum(input.reason, recordReasons);
    const checkpointStatus = input.checkpoint_status === null ? null : fixedEnum(input.checkpoint_status, checkpointStatuses);
    if ((input.checkpoint_ref_digest !== null && !checkpointRefDigest) ||
        (input.request_scope_digest !== null && !requestScopeDigest) || !integrity ||
        (input.reason !== null && !recordReason) || (input.checkpoint_status !== null && !checkpointStatus) ||
        (requestScopeDigest !== null && (integrity !== "verified" || recordReason !== null)) ||
        (integrity === "verified" && (recordReason !== null || checkpointStatus === null || checkpointRefDigest === null)) ||
        (integrity === "residuals_present" && recordReason === null) ||
        (checkpointRefDigest !== null && seenReferences.has(checkpointRefDigest))) return { summary: unknown, valid: false };
    if (checkpointRefDigest) seenReferences.add(checkpointRefDigest);
    records.push({
      checkpoint_ref_digest: checkpointRefDigest,
      request_scope_digest: requestScopeDigest,
      integrity,
      reason: recordReason,
      checkpoint_status: checkpointStatus,
    });
  }
  if (["unavailable", "schema_mismatch", "corrupt"].includes(status)) {
    const countsUnknown = countKeys.every((key) => counts[key] === null);
    const expectedReason = status === "unavailable" ? "store_unavailable" : status === "schema_mismatch" ? "schema_mismatch" : "ledger_corrupt";
    if (!countsUnknown || records.length !== 0 || (residualCount as number) < 1 || reason !== expectedReason) {
      return { summary: unknown, valid: false };
    }
    return { summary: { status, reason, ...safeCounts, residual_count: residualCount as number, records }, valid: true };
  }
  const numeric = countKeys.every((key) => typeof counts[key] === "number");
  if (!numeric) return { summary: unknown, valid: false };
  const checkpointCount = counts.checkpoint_count as number;
  const verifiedCount = counts.verified_checkpoint_count as number;
  const residualCheckpointCount = counts.residual_checkpoint_count as number;
  const omittedCount = counts.omitted_checkpoint_count as number;
  const unresolvedCount = counts.unresolved_checkpoint_count as number;
  const inspectedVerified = records.filter((record) => record.integrity === "verified").length;
  const inspectedResidual = records.filter((record) => record.integrity === "residuals_present").length;
  const inspectedUnresolved = records.filter((record) => record.integrity === "verified" && record.checkpoint_status !== "completed").length;
  const expectedReason = inspectedResidual > 0 ? "ledger_corrupt" : omittedCount > 0 ? "row_limit_reached"
    : unresolvedCount > 0 ? "unfinished_checkpoints" : null;
  const expectedResidual = residualCheckpointCount + omittedCount + unresolvedCount;
  const consistent = Number.isSafeInteger(expectedResidual) && expectedResidual === residualCount &&
    verifiedCount === inspectedVerified && residualCheckpointCount === inspectedResidual &&
    checkpointCount === verifiedCount + residualCheckpointCount + omittedCount &&
    records.length === verifiedCount + residualCheckpointCount && unresolvedCount === inspectedUnresolved &&
    ((status === "verified" && residualCount === 0 && reason === null) ||
      (status === "residuals_present" && residualCount > 0 && reason === expectedReason));
  if (!consistent) return { summary: unknown, valid: false };
  return { summary: { status, reason, ...safeCounts, residual_count: residualCount as number, records }, valid: true };
}

/** Whitelist a digest-only recovery report before exposing per-work residuals to an operator surface. */
export function projectGatewayRecoveryInspectionForOperator(value: unknown): GatewayRecoveryOperatorProjection {
  const source = isRecord(value) ? value : {};
  const ledgers = isRecord(source.ledgers) ? source.ledgers : {};
  const reportShapeValid = source.schema_version === 8 && source.surface === "recovery_inspection" && source.mode === "read_only";
  const sourceStatus = fixedEnum(source.status, ["verified", "residuals_present"] as const);
  const cronEvents = projectCronEventSummary(ledgers.cron_events);
  const cronLedgerStatus = fixedEnum(isRecord(ledgers.cron_events) ? ledgers.cron_events.status : null, CRON_RECOVERY_STATUSES);
  const cronResidualCount = source.cron_event_residual_count;
  const cronApprovalCorrelationResidualCount = source.cron_approval_correlation_residual_count;
  const documentOrganizationCheckpoints = projectDocumentOrganizationCheckpointSummary(ledgers.document_organization_checkpoints);
  const documentOrganizationLedgerStatus = fixedEnum(
    isRecord(ledgers.document_organization_checkpoints) ? ledgers.document_organization_checkpoints.status : null,
    ["verified", "residuals_present", "corrupt", "unavailable", "schema_mismatch"] as const,
  );
  const documentOrganizationResidualCount = source.document_organization_checkpoint_residual_count;
  const operationPlanSources = Array.isArray(source.operation_plan_correlations) ? source.operation_plan_correlations : [];
  const operationPlansProjection = projectOperatorOperationPlanCorrelations(operationPlanSources, reportShapeValid);
  const operationPlanLedger = isRecord(ledgers.operation_plans) ? ledgers.operation_plans : {};
  const planSummaries = projectOperationPlanSummaries(operationPlanLedger.plans, reportShapeValid);
  const operationPlanStatus = fixedEnum(operationPlanLedger.status, RECOVERY_LEDGER_STATUSES);
  const planDependencyScopes = buildRecoveryPlanDependencyScopes(planSummaries.rows, operationPlansProjection.rows);
  const planCount = operationPlanLedger.plan_count;
  const bindingCount = operationPlanLedger.binding_count;
  const residualBindingCount = operationPlanLedger.residual_binding_count;
  const omittedBindingCount = operationPlanLedger.omitted_binding_count;
  const planInventoryValid = operationPlanStatus !== null &&
    Number.isSafeInteger(planCount) && (planCount as number) >= 0 &&
    Number.isSafeInteger(bindingCount) && (bindingCount as number) >= 0 &&
    Number.isSafeInteger(residualBindingCount) && (residualBindingCount as number) >= 0 &&
    Number.isSafeInteger(omittedBindingCount) && (omittedBindingCount as number) >= 0 &&
    planSummaries.valid &&
    (operationPlanStatus === "verified" || operationPlanStatus === "residuals_present"
      ? planSummaries.rows.reduce((sum, item) => sum + item.plan_record_count, 0) === planCount &&
        planSummaries.rows.reduce((sum, item) => sum + item.binding_count, 0) === bindingCount &&
        planSummaries.rows.reduce((sum, item) => sum + item.residual_binding_count, 0) === residualBindingCount &&
        planSummaries.rows.reduce((sum, item) => sum + item.omitted_binding_count, 0) === omittedBindingCount &&
        planSummaries.rows.every((plan) => operationPlansProjection.rows.filter((row) => row.plan_id_digest === plan.plan_id_digest).length <=
          plan.binding_count - plan.omitted_binding_count) &&
        operationPlansProjection.rows.every((row) => planSummaries.rows.some((plan) => plan.plan_id_digest === row.plan_id_digest))
      : planCount === 0 && bindingCount === 0 && residualBindingCount === 0 && omittedBindingCount === 0 &&
        planSummaries.rows.length === 0 && operationPlansProjection.rows.length === 0);
  const planDependencyScopesValid = planInventoryValid && Array.isArray(source.plan_dependency_scopes) &&
    JSON.stringify(source.plan_dependency_scopes) === JSON.stringify(planDependencyScopes);
  const operationPlanInventoryComplete = planInventoryValid &&
    (operationPlanStatus === "verified" || operationPlanStatus === "residuals_present") &&
    planSummaries.omitted === 0;
  const documentCheckpointInventoryComplete = documentOrganizationCheckpoints.valid &&
    (documentOrganizationCheckpoints.summary.status === "verified" || documentOrganizationCheckpoints.summary.status === "residuals_present") &&
    documentOrganizationCheckpoints.summary.omitted_checkpoint_count === 0;
  const requestScopeCorrelation = buildRecoveryRequestScopeCorrelation(
    planDependencyScopes,
    documentOrganizationCheckpoints.summary.records,
    { operationPlanInventoryComplete, documentCheckpointInventoryComplete },
  );
  const cronCorrelationStates = operationPlanSources.map((item) =>
    isRecord(item) ? fixedEnum(item.cron_approval_correlation, CRON_APPROVAL_CORRELATIONS) : null,
  );
  const cronCorrelationsValid = cronCorrelationStates.every((item) => item !== null) &&
    Number.isSafeInteger(cronApprovalCorrelationResidualCount) &&
    cronCorrelationStates.filter((item) => item !== null && CRON_APPROVAL_CORRELATION_RESIDUALS.has(item)).length ===
      cronApprovalCorrelationResidualCount;
  const cronBoundaryValid = cronEvents.valid && cronLedgerStatus === cronEvents.summary.status &&
    Number.isSafeInteger(cronResidualCount) && cronResidualCount === cronEvents.summary.residual_count &&
    Number.isSafeInteger(cronApprovalCorrelationResidualCount) && (cronApprovalCorrelationResidualCount as number) >= 0 && cronCorrelationsValid;
  const boundaryValid = reportShapeValid && source.used_for_authority === false && source.may_execute === false &&
    sourceStatus !== null && cronBoundaryValid && planDependencyScopesValid && documentOrganizationCheckpoints.valid &&
    documentOrganizationLedgerStatus === documentOrganizationCheckpoints.summary.status &&
    Number.isSafeInteger(documentOrganizationResidualCount) &&
    documentOrganizationResidualCount === documentOrganizationCheckpoints.summary.residual_count;
  const updateSources = Array.isArray(source.update_residuals) ? source.update_residuals : [];
  const operationPlans = projectOperatorOperationPlanCorrelations(operationPlanSources, boundaryValid);
  const updates = projectOperatorUpdateResiduals(updateSources, boundaryValid);
  const ledgerStatuses = RECOVERY_LEDGER_STATUSES;
  const requestScopeCorrelationNotVerified: RecoveryRequestScopeCorrelation = {
    status: "not_verified",
    entries: [],
    matched_scope_count: null,
    operation_plan_only_scope_count: null,
    document_checkpoint_only_scope_count: null,
    counterpart_unresolved_scope_count: null,
    unlinked_operation_plan_scope_count: null,
    unlinked_document_checkpoint_count: null,
  };
  return {
    schema_version: 8,
    surface: "recovery_inspection_operator",
    mode: "read_only",
    status: boundaryValid && sourceStatus ? sourceStatus : "invalid_report",
    ledgers: {
      j: fixedEnum(isRecord(ledgers.j) ? ledgers.j.status : null, ledgerStatuses) ?? "unknown",
      m: fixedEnum(isRecord(ledgers.m) ? ledgers.m.status : null, ledgerStatuses) ?? "unknown",
      broker: fixedEnum(isRecord(ledgers.execution) ? ledgers.execution.status : null, ledgerStatuses) ?? "unknown",
      operation_plans: fixedEnum(isRecord(ledgers.operation_plans) ? ledgers.operation_plans.status : null, ledgerStatuses) ?? "unknown",
      cron_events: cronLedgerStatus ?? "unknown",
      document_organization_checkpoints: documentOrganizationLedgerStatus ?? "unknown",
    },
    cron_event_summary: cronEvents.summary,
    document_organization_checkpoint_summary: documentOrganizationCheckpoints.summary,
    ledger_boundaries: {
      j: projectLedgerBoundary(ledgers.j, boundaryValid, true),
      m: projectLedgerBoundary(ledgers.m, boundaryValid, true),
      broker: projectLedgerBoundary(ledgers.execution, boundaryValid, false),
    },
    replay_checkpoint: boundaryValid && isRecord(source.replay_checkpoint) &&
        source.replay_checkpoint.verified === true && source.replay_checkpoint.kind === "canonical_replay_checkpoint_not_backup"
      ? "verified_replay_checkpoint_not_backup"
      : "not_verified",
    isolated_update_count: fixedCount(source.isolated_update_count),
    execution_residual_count: fixedCount(source.execution_residual_count),
    operation_plan_residual_count: fixedCount(source.operation_plan_residual_count),
    cron_event_residual_count: fixedCount(source.cron_event_residual_count),
    cron_approval_correlation_residual_count: fixedCount(source.cron_approval_correlation_residual_count),
    document_organization_checkpoint_residual_count: fixedCount(source.document_organization_checkpoint_residual_count),
    operation_plan_correlations: operationPlans.rows,
    omitted_operation_plan_correlation_count: operationPlans.omitted,
    plan_dependency_scopes: boundaryValid ? planDependencyScopes : [],
    omitted_plan_dependency_scope_count: 0,
    request_scope_correlation: boundaryValid ? requestScopeCorrelation : requestScopeCorrelationNotVerified,
    update_residuals: updates.rows,
    omitted_update_residual_count: updates.omitted,
    external_backup_restore_point: "not_examined",
    boundary_valid: boundaryValid,
    used_for_authority: false,
    may_execute: false,
  };
}

interface StateDatabasePaths {
  readonly privateRoot: string;
  readonly jPath: string | null;
  readonly mPath: string | null;
  readonly executionPath: string | null;
  readonly operationPlansPath: string | null;
  readonly cronEventsPath: string | null;
}

function hasSafeExistingStatePaths(env: NodeJS.ProcessEnv): StateDatabasePaths | null {
  try {
    const configuredRoot = path.resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    const rootStat = lstatSync(configuredRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const stateRoot = realpathSync(configuredRoot);
    const privateRoot = path.join(stateRoot, "private-state");
    const privateStat = lstatSync(privateRoot);
    if (privateStat.isSymbolicLink() || !privateStat.isDirectory()) return null;
    const canonicalPath = (key: CanonicalStateStoreKey): string => {
      const store = CANONICAL_STATE_STORE_PATHS.find((item) => item.key === key);
      if (!store) throw new Error("canonical_state_store_path_missing");
      return path.join(privateRoot, store.relative_path);
    };
    const jPath = canonicalPath("j_control");
    const mPath = canonicalPath("m_state");
    const executionPath = canonicalPath("broker");
    const operationPlansPath = canonicalPath("operation_plans");
    const cronEventsPath = canonicalPath("cron_events");
    const safeDatabasePath = (directory: string, databasePath: string): string | null => {
      try {
        const directoryStat = lstatSync(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return null;
      }
      if (!existsSync(databasePath)) return databasePath;
      const stat = lstatSync(databasePath);
      return stat.isSymbolicLink() || !stat.isFile() ? null : databasePath;
    };
    return {
      privateRoot,
      jPath: safeDatabasePath(path.dirname(jPath), jPath),
      mPath: safeDatabasePath(path.dirname(mPath), mPath),
      executionPath: safeDatabasePath(path.dirname(executionPath), executionPath),
      operationPlansPath: safeDatabasePath(path.dirname(operationPlansPath), operationPlansPath),
      cronEventsPath: safeDatabasePath(path.dirname(cronEventsPath), cronEventsPath),
    };
  } catch {
    return null;
  }
}

function hasSafeCanonicalArchiveStatePaths(
  packDirectory: string,
  snapshot: CanonicalStateSnapshotManifest,
): StateDatabasePaths | null {
  try {
    const packPath = path.resolve(packDirectory);
    const packStat = lstatSync(packPath);
    if (packStat.isSymbolicLink() || !packStat.isDirectory() || realpathSync(packPath) !== packPath) return null;
    const archiveRoot = path.join(packPath, "canonical-state");
    const archiveRootStat = lstatSync(archiveRoot);
    if (archiveRootStat.isSymbolicLink() || !archiveRootStat.isDirectory() || realpathSync(archiveRoot) !== archiveRoot) return null;
    const expectedKeys = new Set(CANONICAL_STATE_STORE_PATHS.map((store) => store.key));
    if (snapshot.schema_version !== 1 || snapshot.cross_store_atomic !== false ||
        snapshot.store_consistency !== "independent_sqlite_online_snapshots" ||
        snapshot.entries.length !== expectedKeys.size || new Set(snapshot.entries.map((entry) => entry.store_key)).size !== expectedKeys.size ||
        snapshot.entries.some((entry) => !expectedKeys.has(entry.store_key))) return null;

    const pathsByKey = new Map<CanonicalStateStoreKey, string | null>();
    for (const store of CANONICAL_STATE_STORE_PATHS) {
      const entry = snapshot.entries.find((candidate) => candidate.store_key === store.key);
      if (!entry) return null;
      if (entry.status !== "verified") {
        pathsByKey.set(store.key, null);
        continue;
      }
      const expectedRelativePath = path.join("canonical-state", `${store.key}.sqlite`);
      if (entry.archive_rel_path !== expectedRelativePath) return null;
      const archivePath = path.join(packPath, expectedRelativePath);
      const archiveStat = lstatSync(archivePath);
      if (archiveStat.isSymbolicLink() || !archiveStat.isFile() || archiveStat.size === 0 ||
          realpathSync(archivePath) !== archivePath) return null;
      pathsByKey.set(store.key, archivePath);
    }

    return {
      privateRoot: packPath,
      jPath: pathsByKey.get("j_control") ?? null,
      mPath: pathsByKey.get("m_state") ?? null,
      executionPath: pathsByKey.get("broker") ?? null,
      operationPlansPath: pathsByKey.get("operation_plans") ?? null,
      cronEventsPath: pathsByKey.get("cron_events") ?? null,
    };
  } catch {
    return null;
  }
}

function inspectGatewayRecoveryStateFromPaths(
  paths: StateDatabasePaths | null,
  env: NodeJS.ProcessEnv,
): GatewayRecoveryInspectionReport {
  const unavailable = (owner: "J" | "M"): PersistenceLedgerInspection => ({
    owner,
    status: "unavailable",
    reason: "store_unavailable",
    verified_event_count: 0,
    unverified_event_count: 0,
    first_unverified_ordinal: null,
    last_verified_revision: 0,
    last_verified_event_digest: null,
    updates: [],
    used_for_authority: false,
  });
  const unavailableExecution: ExecutionIntentRecoveryInspection = {
    owner: "Broker",
    status: "unavailable",
    reason: "store_unavailable",
    total_event_count: 0,
    verified_event_count: 0,
    unverified_event_count: 0,
    first_unverified_ordinal: null,
    last_verified_event_digest: null,
    receipt_projection_mismatch_count: 0,
    outbox_mismatch_count: 0,
    current_state_available: false,
    omitted_record_count: 0,
    records: [],
    used_for_authority: false,
    execution_eligible: false,
  };
  const unavailableOperationPlans: OperationPlanRecoveryInspection = {
    owner: "J", status: "unavailable", reason: "store_unavailable", plan_count: 0, plan_integrity_residual_count: 0,
    binding_count: 0, verified_binding_count: 0, residual_binding_count: 0, unverified_memory_link_count: 0,
    omitted_binding_count: 0, plans: [],
    bindings: [], used_for_authority: false, may_execute: false,
  };
  const unavailableCronEvents: CronEventRecoveryInspection = {
    status: "unavailable", reason: "store_unavailable", cursor_count: null, verified_cursor_count: null,
    unverified_cursor_count: null, omitted_cursor_count: null, unresolved_cursor_count: null, orphan_outbox_count: null,
    approval_handoff_count: null, verified_approval_handoff_count: null, unverified_approval_handoff_count: null,
    omitted_approval_handoff_count: null, pending_approval_handoff_count: null, interrupted_approval_handoff_count: null,
    residual_count: 1, used_for_authority: false,
  };
  const j = paths?.jPath
    ? inspectJControlRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.jPath })
    : unavailable("J");
  const m = paths?.mPath
    ? inspectMemoryRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.mPath })
    : unavailable("M");
  const execution = paths?.executionPath
    ? inspectExecutionIntentRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.executionPath })
    : unavailableExecution;
  const operationPlans = paths?.operationPlansPath
    ? inspectOperationPlanRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.operationPlansPath })
    : unavailableOperationPlans;
  const cronCommandIdDigests = operationPlans.bindings
    .filter((binding) => binding.integrity === "verified")
    .map((binding) => binding.cron_command_id_digest);
  const cronInspection: CronEventRecoveryLedgerInspection = paths?.cronEventsPath
    ? inspectCronEventRecoveryLedger({
        private_state_root: paths.privateRoot,
        database_path: paths.cronEventsPath,
        command_id_digests: cronCommandIdDigests,
      })
    : { ...unavailableCronEvents, approval_command_matches: [] };
  const { approval_command_matches: cronApprovalMatches, ...cronEvents } = cronInspection;
  const documentOrganizationCheckpoints = inspectDocumentOrganizationCheckpointLedger(env);
  const residuals = correlateRecoveryUpdates(j, m);
  const operationPlanCorrelations = correlateOperationPlanBindings(operationPlans, execution, j, m, cronEvents, cronApprovalMatches);
  const planDependencyScopes = buildRecoveryPlanDependencyScopes(operationPlans.plans, operationPlanCorrelations);
  const operationPlanMemoryLinkResidualCount = operationPlanCorrelations.filter((item) =>
    item.memory_correlation !== "not_recorded" && item.memory_correlation !== "matched",
  ).length;
  const storesVerified = j.status === "verified" && m.status === "verified";
  const hasHardResidual = residuals.some((item) => !["paired", "pending_m_commit", "pending_j_receipt"].includes(item.disposition));
  const executionResidualCount = execution.status === "verified" ? 0 : Math.max(
    1,
    execution.unverified_event_count + execution.receipt_projection_mismatch_count + execution.outbox_mismatch_count,
  );
  const operationPlanCorrelationResidualCount = operationPlanCorrelations.filter((item) =>
    ["admission_missing", "not_found", "not_observed_due_to_limit", "ambiguous", "broker_unverified"].includes(item.broker_correlation) ||
    ["j_not_recorded", "broker_not_recorded", "mismatch"].includes(item.delivery_correlation),
  ).length;
  const cronApprovalCorrelationResidualCount = operationPlanCorrelations.filter((item) =>
    CRON_APPROVAL_CORRELATION_RESIDUALS.has(item.cron_approval_correlation),
  ).length;
  const operationPlanStructuralResidualCount = operationPlans.plan_integrity_residual_count + operationPlans.residual_binding_count +
    (operationPlans.omitted_binding_count > 0 ? 1 : 0);
  const operationPlanHasSourceState = ["verified", "residuals_present"].includes(operationPlans.status);
  const operationPlansResolved: OperationPlanRecoveryInspection = operationPlanHasSourceState
    ? {
        ...operationPlans,
        status: operationPlanStructuralResidualCount > 0 || operationPlanMemoryLinkResidualCount > 0
          ? "residuals_present"
          : "verified",
        reason: operationPlanStructuralResidualCount > 0
          ? "binding_mismatch"
          : operationPlanMemoryLinkResidualCount > 0 ? "cross_ledger_unverified" : null,
        unverified_memory_link_count: operationPlanMemoryLinkResidualCount,
      }
    : operationPlans;
  const operationPlanResidualCount = operationPlansResolved.status === "verified" && operationPlanCorrelationResidualCount === 0 &&
      operationPlans.omitted_binding_count === 0
    ? 0
    : Math.max(1, operationPlanStructuralResidualCount + operationPlanMemoryLinkResidualCount + operationPlanCorrelationResidualCount);
  const checkpointVerified = storesVerified && execution.status === "verified" && operationPlansResolved.status === "verified" &&
    cronEvents.status === "verified" &&
    documentOrganizationCheckpoints.status === "verified" &&
    !hasHardResidual && operationPlanCorrelationResidualCount === 0 && operationPlanMemoryLinkResidualCount === 0 &&
    operationPlans.omitted_binding_count === 0 && cronApprovalCorrelationResidualCount === 0;
  return {
    schema_version: 8,
    surface: "recovery_inspection",
    mode: "read_only",
    status: checkpointVerified ? "verified" : "residuals_present",
    ledgers: {
      j, m, execution, operation_plans: operationPlansResolved, cron_events: cronEvents,
      document_organization_checkpoints: documentOrganizationCheckpoints,
    },
    operation_plan_correlations: operationPlanCorrelations,
    plan_dependency_scopes: planDependencyScopes,
    replay_checkpoint: checkpointVerified
      ? {
          verified: true,
          kind: "canonical_replay_checkpoint_not_backup",
          j_revision: j.last_verified_revision,
          j_event_digest: j.last_verified_event_digest ?? "GENESIS",
          m_revision: m.last_verified_revision,
          m_event_digest: m.last_verified_event_digest ?? "GENESIS",
          update_count: residuals.length,
          operation_plan_count: operationPlans.plan_count,
          operation_plan_binding_count: operationPlans.binding_count,
        }
      : null,
    update_residuals: residuals,
    isolated_update_count: residuals.filter((item) =>
      !["paired", "pending_m_commit", "pending_j_receipt"].includes(item.disposition),
    ).length,
    execution_residual_count: executionResidualCount,
    operation_plan_residual_count: operationPlanResidualCount,
    cron_event_residual_count: cronEvents.residual_count,
    cron_approval_correlation_residual_count: cronApprovalCorrelationResidualCount,
    document_organization_checkpoint_residual_count: documentOrganizationCheckpoints.residual_count,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
    next_safe_action: checkpointVerified
      ? "This read-only checkpoint is not a backup or restore point and does not authorize work; use the guarded recovery path for any recovery action."
      : "Keep work suspended; preserve the stores and compare verified prefixes with an independently verified backup before any repair.",
  };
}

export function inspectGatewayRecoveryState(
  env: NodeJS.ProcessEnv = process.env,
): GatewayRecoveryInspectionReport {
  return inspectGatewayRecoveryStateFromPaths(hasSafeExistingStatePaths(env), env);
}

/** Inspect only manifest-verified canonical archive entries through the existing read-only recovery path. */
export function inspectGatewayRecoveryCanonicalArchive(
  packDirectory: string,
  snapshot: CanonicalStateSnapshotManifest,
): GatewayRecoveryInspectionReport {
  const archiveRoot = path.resolve(packDirectory, "canonical-state");
  return inspectGatewayRecoveryStateFromPaths(
    hasSafeCanonicalArchiveStatePaths(packDirectory, snapshot),
    { BLUE_TANUKI_FILE_ROOT: archiveRoot },
  );
}

export type RecoverySelectedStoreLedgerStatus =
  | "verified"
  | "residuals_present"
  | "projection_mismatch"
  | "corrupt"
  | "schema_mismatch"
  | "unavailable"
  | "unverified";

export interface RecoverySelectedStoreLedgerObservation {
  readonly status: RecoverySelectedStoreLedgerStatus;
  readonly residual_count: number | null;
  readonly plan_residuals: readonly RecoverySelectedPlanResidualObservation[] | null;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface RecoverySelectedPlanResidualObservation {
  readonly plan_id_digest: string;
  readonly status: "verified" | "residuals_present";
  readonly binding_count: number;
  readonly residual_binding_count: number;
  readonly omitted_binding_count: number;
}

function selectedLedgerObservation(
  status: string,
  reason: string | null,
  residualCount: number | null,
  planResiduals: readonly RecoverySelectedPlanResidualObservation[] | null = null,
): RecoverySelectedStoreLedgerObservation {
  const normalizedStatus: RecoverySelectedStoreLedgerStatus = status === "projection_mismatch"
    ? "projection_mismatch"
    : status === "corrupt"
      ? "corrupt"
      : status === "schema_mismatch" || reason === "schema_mismatch"
        ? "schema_mismatch"
        : status === "unavailable"
          ? "unavailable"
          : status === "unverified"
            ? "unverified"
            : status === "residuals_present" || (residualCount !== null && residualCount > 0)
              ? "residuals_present"
              : status === "verified"
                ? "verified"
                : "unverified";
  const count = residualCount === null || !Number.isSafeInteger(residualCount) || residualCount < 0
    ? null
    : residualCount;
  return {
    status: normalizedStatus,
    residual_count: normalizedStatus === "unavailable" ? null : count,
    plan_residuals: planResiduals,
    used_for_authority: false,
    may_execute: false,
  };
}

/** Inspect exactly one selected canonical store through its existing read-only ledger inspector. */
export function inspectCanonicalStateStoreLedger(
  stateRoot: string,
  storeKey: CanonicalStateStoreKey,
): RecoverySelectedStoreLedgerObservation {
  let databasePath: string;
  let privateRoot: string;
  try {
    databasePath = resolveCanonicalStateStoreInspectionPath(stateRoot, storeKey);
    privateRoot = path.join(realpathSync(path.resolve(stateRoot)), "private-state");
  } catch {
    return selectedLedgerObservation("unavailable", "store_unavailable", null);
  }

  switch (storeKey) {
    case "j_control": {
      const inspection = inspectJControlRecoveryLedger({ private_state_root: privateRoot, database_path: databasePath });
      const outstandingUpdates = inspection.updates.filter((update) => update.phase !== "committed").length;
      const residualCount = inspection.status === "unavailable" ? null
        : Math.max(inspection.unverified_event_count + outstandingUpdates,
          inspection.status === "projection_mismatch" || inspection.status === "corrupt" ? 1 : 0);
      return selectedLedgerObservation(inspection.status, inspection.reason, residualCount);
    }
    case "m_state": {
      const inspection = inspectMemoryRecoveryLedger({ private_state_root: privateRoot, database_path: databasePath });
      const residualCount = inspection.status === "unavailable" ? null
        : Math.max(inspection.unverified_event_count,
          inspection.status === "projection_mismatch" || inspection.status === "corrupt" ? 1 : 0);
      return selectedLedgerObservation(inspection.status, inspection.reason, residualCount);
    }
    case "broker": {
      const inspection = inspectExecutionIntentRecoveryLedger({ private_state_root: privateRoot, database_path: databasePath });
      const omittedRecords = inspection.omitted_record_count > 0;
      const knownResidualCount = inspection.unverified_event_count + inspection.receipt_projection_mismatch_count +
        inspection.outbox_mismatch_count + inspection.records.filter((record) =>
          record.reconciliation_required || record.result_delivery_pending,
        ).length;
      const residualCount = inspection.status === "unavailable" || inspection.status === "schema_mismatch" || omittedRecords
        ? null
        : Math.max(knownResidualCount, inspection.status === "corrupt" ? 1 : 0);
      return selectedLedgerObservation(inspection.status, inspection.reason, residualCount);
    }
    case "operation_plans": {
      const inspection = inspectOperationPlanRecoveryLedger({ private_state_root: privateRoot, database_path: databasePath });
      const residualCount = inspection.status === "unavailable"
        ? null
        : inspection.plan_integrity_residual_count + inspection.residual_binding_count + inspection.unverified_memory_link_count;
      const planResiduals = inspection.status === "verified" || inspection.status === "residuals_present"
        ? inspection.plans.map((plan): RecoverySelectedPlanResidualObservation => ({
            plan_id_digest: plan.plan_id_digest,
            status: plan.integrity,
            binding_count: plan.binding_count,
            residual_binding_count: plan.residual_binding_count,
            omitted_binding_count: plan.omitted_binding_count,
          }))
        : null;
      return selectedLedgerObservation(inspection.status, inspection.reason, residualCount, planResiduals);
    }
    case "cron_events": {
      const inspection = inspectCronEventRecoveryLedger({ private_state_root: privateRoot, database_path: databasePath });
      return selectedLedgerObservation(inspection.status, inspection.reason, inspection.residual_count);
    }
  }
}

export function correlateOperationPlanBindings(
  operationPlans: OperationPlanRecoveryInspection,
  execution: ExecutionIntentRecoveryInspection,
  j: PersistenceLedgerInspection,
  m: PersistenceLedgerInspection,
  cronEvents: CronEventRecoveryInspection,
  cronApprovalMatches: readonly CronApprovalCommandMatch[],
): OperationPlanBrokerCorrelation[] {
  const byAdmission = new Map<string, ExecutionIntentRecoveryInspection["records"]>();
  if (execution.status === "verified") {
    for (const record of execution.records) {
      byAdmission.set(record.admission_digest, [...(byAdmission.get(record.admission_digest) ?? []), record]);
    }
  }
  return operationPlans.bindings.map((binding): OperationPlanBrokerCorrelation => {
    let brokerCorrelation: OperationPlanBrokerCorrelation["broker_correlation"];
    let brokerRecord: ExecutionIntentRecoveryInspection["records"][number] | undefined;
    if (binding.integrity !== "verified") {
      brokerCorrelation = "j_binding_unverified";
    } else if (!binding.admission_digest) {
      brokerCorrelation = ["selected", "not_attempted", "invalidated"].includes(binding.status)
        ? "not_admitted"
        : "admission_missing";
    } else if (execution.status !== "verified") {
      brokerCorrelation = "broker_unverified";
    } else {
      const matches = byAdmission.get(binding.admission_digest) ?? [];
      if (matches.length > 1) brokerCorrelation = "ambiguous";
      else if (matches.length === 1) {
        brokerCorrelation = "matched";
        brokerRecord = matches[0];
      } else if (execution.omitted_record_count > 0) brokerCorrelation = "not_observed_due_to_limit";
      else brokerCorrelation = "not_found";
    }
    const deliveryCorrelation: OperationPlanBrokerCorrelation["delivery_correlation"] = !brokerRecord
      ? "not_observed"
      : binding.delivery_digest === null && brokerRecord.result_delivery_digest === null ? "not_recorded"
        : binding.delivery_digest === null ? "j_not_recorded"
          : brokerRecord.result_delivery_digest === null ? "broker_not_recorded"
            : binding.delivery_digest === brokerRecord.result_delivery_digest ? "matched" : "mismatch";
    return {
      plan_id_digest: binding.plan_id_digest,
      step_id_digest: binding.step_id_digest,
      command_id_digest: binding.command_id_digest,
      status: binding.status,
      binding_integrity: binding.integrity,
      admission_digest: binding.admission_digest,
      broker_correlation: brokerCorrelation,
      broker_state: brokerRecord?.state ?? null,
      delivery_correlation: deliveryCorrelation,
      memory_update_id_digest: binding.memory_link.update_id_digest,
      memory_correlation: correlateOperationPlanMemoryBinding(binding.memory_link, j, m),
      cron_approval_correlation: correlateCronApprovalHandoff(binding, cronEvents, cronApprovalMatches),
    };
  });
}

function correlateCronApprovalHandoff(
  binding: OperationPlanRecoveryInspection["bindings"][number],
  cronEvents: CronEventRecoveryInspection,
  matches: readonly CronApprovalCommandMatch[],
): OperationPlanBrokerCorrelation["cron_approval_correlation"] {
  if (binding.integrity !== "verified" || !HEX_DIGEST.test(binding.cron_command_id_digest)) return "plan_binding_unverified";
  if (["unavailable", "schema_mismatch", "corrupt"].includes(cronEvents.status)) return "cron_unverified";
  const omitted = cronEvents.omitted_approval_handoff_count;
  const unverified = cronEvents.unverified_approval_handoff_count;
  if (omitted === null || unverified === null) return "cron_unverified";
  if (omitted > 0) return "not_observed_due_to_limit";
  if (unverified > 0) return "cron_unverified";
  const match = matches.find((item) => item.command_id_digest === binding.cron_command_id_digest);
  if (!match) return "not_recorded";
  if (match.row_count !== 1 || match.states.length !== 1) return "ambiguous";
  switch (match.states[0]) {
    case "pending": return "pending";
    case "interrupted": return "interrupted";
    case "consumed":
    case "rejected":
    case "cancelled": return "resolved";
    default: return "cron_unverified";
  }
}

function correlateOperationPlanMemoryBinding(
  link: OperationPlanRecoveryInspection["bindings"][number]["memory_link"],
  j: PersistenceLedgerInspection,
  m: PersistenceLedgerInspection,
): OperationPlanBrokerCorrelation["memory_correlation"] {
  if (link.integrity === "not_recorded") return "not_recorded";
  if (link.integrity === "missing_expected") return "missing_plan_memory_link";
  if (link.integrity !== "verified" || !link.update_id_digest || !link.j_event_id_digest || !link.content_digest ||
      link.expected_version === null) return "binding_unverified";
  if (j.status !== "verified") return "j_state_unverified";
  if (m.status !== "verified") return "m_state_unverified";

  const jMatches = j.updates.filter((item) => item.update_id_digest === link.update_id_digest);
  const mMatches = m.updates.filter((item) => item.update_id_digest === link.update_id_digest);
  if (jMatches.length > 1 || mMatches.length > 1) return "ambiguous";
  const jUpdate = jMatches[0];
  const mUpdate = mMatches[0];
  if (!jUpdate) return "missing_verified_j_link";
  if (!mUpdate) {
    if (link.receipt_digest) return "receipt_mismatch";
    return jUpdate.phase === "pending" ? "pending_m_commit"
      : jUpdate.phase === "blocked" ? "blocked_j" : "missing_verified_m_link";
  }
  if (jUpdate.content_digest !== link.content_digest || mUpdate.content_digest !== link.content_digest) return "content_mismatch";
  if (jUpdate.j_event_id_digest !== link.j_event_id_digest || mUpdate.j_event_id_digest !== link.j_event_id_digest) {
    return "event_identity_mismatch";
  }
  if (jUpdate.expected_version !== undefined && jUpdate.expected_version !== link.expected_version) return "revision_mismatch";
  if (mUpdate.revision !== link.expected_version + 1) return "revision_mismatch";
  if (jUpdate.phase === "blocked") return "m_present_for_blocked_j";
  if (jUpdate.phase === "pending") return link.receipt_digest ? "receipt_mismatch" : "pending_j_receipt";
  if (!link.receipt_digest || link.receipt_revision === null || !link.receipt_event_digest) return "pending_j_receipt";
  if (jUpdate.receipt_revision !== link.receipt_revision || mUpdate.revision !== link.receipt_revision ||
      jUpdate.receipt_event_digest !== link.receipt_event_digest || mUpdate.event_digest !== link.receipt_event_digest) {
    return "receipt_mismatch";
  }
  return "matched";
}

export function correlateRecoveryUpdates(
  j: PersistenceLedgerInspection,
  m: PersistenceLedgerInspection,
): RecoveryUpdateResidual[] {
  const jUpdates = new Map(j.updates.map((item) => [item.update_id_digest, item]));
  const mUpdates = new Map(m.updates.map((item) => [item.update_id_digest, item]));
  const ids = [...new Set([...jUpdates.keys(), ...mUpdates.keys()])].sort();
  return ids.map((updateIdDigest): RecoveryUpdateResidual => {
    const jUpdate = jUpdates.get(updateIdDigest);
    const mUpdate = mUpdates.get(updateIdDigest);
    if (!jUpdate && mUpdate) {
      return { update_id_digest: updateIdDigest, disposition: j.status === "verified"
        ? "missing_verified_j_link"
        : "j_state_unverified" };
    }
    if (jUpdate && !mUpdate) {
      if (m.status !== "verified") {
        return { update_id_digest: updateIdDigest, disposition: "m_state_unverified" };
      }
      if (jUpdate.phase === "pending") {
        return { update_id_digest: updateIdDigest, disposition: "pending_m_commit" };
      }
      if (jUpdate.phase === "blocked") {
        return { update_id_digest: updateIdDigest, disposition: "blocked_j" };
      }
      return { update_id_digest: updateIdDigest, disposition: "missing_verified_m_link" };
    }
    if (!jUpdate || !mUpdate) return { update_id_digest: updateIdDigest, disposition: "j_state_unverified" };
    if (jUpdate.content_digest !== mUpdate.content_digest) {
      return { update_id_digest: updateIdDigest, disposition: "content_mismatch" };
    }
    if (jUpdate.j_event_id_digest !== mUpdate.j_event_id_digest) {
      return { update_id_digest: updateIdDigest, disposition: "event_identity_mismatch" };
    }
    if (jUpdate.expected_version !== undefined && mUpdate.revision !== jUpdate.expected_version + 1) {
      return { update_id_digest: updateIdDigest, disposition: "revision_mismatch" };
    }
    if (jUpdate.phase === "blocked") {
      return { update_id_digest: updateIdDigest, disposition: "m_present_for_blocked_j" };
    }
    if (jUpdate.phase === "pending") {
      return { update_id_digest: updateIdDigest, disposition: "pending_j_receipt" };
    }
    if (jUpdate.phase === "receipt_confirmed" &&
        (jUpdate.receipt_revision !== mUpdate.revision || jUpdate.receipt_event_digest !== mUpdate.event_digest)) {
      return { update_id_digest: updateIdDigest, disposition: "receipt_mismatch" };
    }
    return { update_id_digest: updateIdDigest, disposition: "paired" };
  });
}
