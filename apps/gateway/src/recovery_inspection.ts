import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
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
  type OperationPlanRecoveryInspection,
} from "./operation_plan_recovery_inspection.js";
import {
  inspectCronEventRecoveryLedger,
  type CronEventRecoveryInspection,
  type CronEventRecoveryReason,
  type CronEventRecoveryStatus,
} from "./cron_event_recovery_inspection.js";

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
  readonly schema_version: 4;
  readonly surface: "recovery_inspection";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present";
  readonly ledgers: {
    readonly j: PersistenceLedgerInspection;
    readonly m: PersistenceLedgerInspection;
    readonly execution: ExecutionIntentRecoveryInspection;
    readonly operation_plans: OperationPlanRecoveryInspection;
    readonly cron_events: CronEventRecoveryInspection;
  };
  readonly operation_plan_correlations: readonly OperationPlanBrokerCorrelation[];
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
}

export interface RecoveryLedgerBoundaryObservation {
  readonly reason: PersistenceLedgerInspection["reason"] | ExecutionIntentRecoveryInspection["reason"] | "unknown";
  readonly verified_event_count: number | null;
  readonly unverified_event_count: number | null;
  readonly first_unverified_ordinal: number | null;
  readonly last_verified_revision: number | null;
}

export interface GatewayRecoveryOperatorProjection {
  readonly schema_version: 3;
  readonly surface: "recovery_inspection_operator";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present" | "invalid_report";
  readonly ledgers: {
    readonly j: string;
    readonly m: string;
    readonly broker: string;
    readonly operation_plans: string;
    readonly cron_events: string;
  };
  readonly cron_event_summary: Omit<CronEventRecoveryInspection, "used_for_authority">;
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
  }[];
  readonly omitted_operation_plan_correlation_count: number;
  readonly update_residuals: readonly RecoveryUpdateResidual[];
  readonly omitted_update_residual_count: number;
  readonly external_backup_restore_point: "not_examined";
  readonly boundary_valid: boolean;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

const OPERATOR_RECORD_LIMIT = 200;
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
    if (!planIdDigest || !stepIdDigest || !commandIdDigest || !status || !bindingIntegrity ||
        (value.admission_digest !== null && !admissionDigest) || !brokerCorrelation || !deliveryCorrelation ||
        (value.memory_update_id_digest !== null && !memoryUpdateIdDigest) || !memoryCorrelation) continue;
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
    });
  }
  return { rows, omitted: values.length - rows.length };
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

/** Whitelist a digest-only recovery report before exposing per-work residuals to an operator surface. */
export function projectGatewayRecoveryInspectionForOperator(value: unknown): GatewayRecoveryOperatorProjection {
  const source = isRecord(value) ? value : {};
  const ledgers = isRecord(source.ledgers) ? source.ledgers : {};
  const reportShapeValid = source.schema_version === 4 && source.surface === "recovery_inspection" && source.mode === "read_only";
  const sourceStatus = fixedEnum(source.status, ["verified", "residuals_present"] as const);
  const cronEvents = projectCronEventSummary(ledgers.cron_events);
  const cronLedgerStatus = fixedEnum(isRecord(ledgers.cron_events) ? ledgers.cron_events.status : null, CRON_RECOVERY_STATUSES);
  const cronResidualCount = source.cron_event_residual_count;
  const cronBoundaryValid = cronEvents.valid && cronLedgerStatus === cronEvents.summary.status &&
    Number.isSafeInteger(cronResidualCount) && cronResidualCount === cronEvents.summary.residual_count;
  const boundaryValid = reportShapeValid && source.used_for_authority === false && source.may_execute === false && sourceStatus !== null && cronBoundaryValid;
  const operationPlanSources = Array.isArray(source.operation_plan_correlations) ? source.operation_plan_correlations : [];
  const updateSources = Array.isArray(source.update_residuals) ? source.update_residuals : [];
  const operationPlans = projectOperatorOperationPlanCorrelations(operationPlanSources, boundaryValid);
  const updates = projectOperatorUpdateResiduals(updateSources, boundaryValid);
  const ledgerStatuses = ["verified", "projection_mismatch", "corrupt", "residuals_present", "unavailable", "schema_mismatch"] as const;
  return {
    schema_version: 3,
    surface: "recovery_inspection_operator",
    mode: "read_only",
    status: boundaryValid && sourceStatus ? sourceStatus : "invalid_report",
    ledgers: {
      j: fixedEnum(isRecord(ledgers.j) ? ledgers.j.status : null, ledgerStatuses) ?? "unknown",
      m: fixedEnum(isRecord(ledgers.m) ? ledgers.m.status : null, ledgerStatuses) ?? "unknown",
      broker: fixedEnum(isRecord(ledgers.execution) ? ledgers.execution.status : null, ledgerStatuses) ?? "unknown",
      operation_plans: fixedEnum(isRecord(ledgers.operation_plans) ? ledgers.operation_plans.status : null, ledgerStatuses) ?? "unknown",
      cron_events: cronLedgerStatus ?? "unknown",
    },
    cron_event_summary: cronEvents.summary,
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
    operation_plan_correlations: operationPlans.rows,
    omitted_operation_plan_correlation_count: operationPlans.omitted,
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
    const resultDirectory = path.join(privateRoot, "result-memory");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    const jPath = path.join(resultDirectory, "j-control.sqlite");
    const mPath = path.join(resultDirectory, "m-state.sqlite");
    const executionPath = path.join(executionDirectory, "executor.sqlite");
    const operationPlansDirectory = path.join(privateRoot, "operation-plans");
    const operationPlansPath = path.join(operationPlansDirectory, "j-state.sqlite");
    const cronEventsDirectory = path.join(privateRoot, "cron-events");
    const cronEventsPath = path.join(cronEventsDirectory, "cron-events.sqlite");
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
      jPath: safeDatabasePath(resultDirectory, jPath),
      mPath: safeDatabasePath(resultDirectory, mPath),
      executionPath: safeDatabasePath(executionDirectory, executionPath),
      operationPlansPath: safeDatabasePath(operationPlansDirectory, operationPlansPath),
      cronEventsPath: safeDatabasePath(cronEventsDirectory, cronEventsPath),
    };
  } catch {
    return null;
  }
}

export function inspectGatewayRecoveryState(
  env: NodeJS.ProcessEnv = process.env,
): GatewayRecoveryInspectionReport {
  const paths = hasSafeExistingStatePaths(env);
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
    omitted_binding_count: 0,
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
  const cronEvents = paths?.cronEventsPath
    ? inspectCronEventRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.cronEventsPath })
    : unavailableCronEvents;
  const residuals = correlateRecoveryUpdates(j, m);
  const operationPlanCorrelations = correlateOperationPlanBindings(operationPlans, execution, j, m);
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
    !hasHardResidual && operationPlanCorrelationResidualCount === 0 && operationPlanMemoryLinkResidualCount === 0 &&
    operationPlans.omitted_binding_count === 0;
  return {
    schema_version: 4,
    surface: "recovery_inspection",
    mode: "read_only",
    status: checkpointVerified ? "verified" : "residuals_present",
    ledgers: { j, m, execution, operation_plans: operationPlansResolved, cron_events: cronEvents },
    operation_plan_correlations: operationPlanCorrelations,
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
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
    next_safe_action: checkpointVerified
      ? "This read-only checkpoint is not a backup or restore point and does not authorize work; use the guarded recovery path for any recovery action."
      : "Keep work suspended; preserve the stores and compare verified prefixes with an independently verified backup before any repair.",
  };
}

export function correlateOperationPlanBindings(
  operationPlans: OperationPlanRecoveryInspection,
  execution: ExecutionIntentRecoveryInspection,
  j: PersistenceLedgerInspection,
  m: PersistenceLedgerInspection,
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
    };
  });
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
