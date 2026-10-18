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
  readonly schema_version: 3;
  readonly surface: "recovery_inspection";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present";
  readonly ledgers: {
    readonly j: PersistenceLedgerInspection;
    readonly m: PersistenceLedgerInspection;
    readonly execution: ExecutionIntentRecoveryInspection;
    readonly operation_plans: OperationPlanRecoveryInspection;
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
}

interface StateDatabasePaths {
  readonly privateRoot: string;
  readonly jPath: string | null;
  readonly mPath: string | null;
  readonly executionPath: string | null;
  readonly operationPlansPath: string | null;
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
  const residuals = correlateRecoveryUpdates(j, m);
  const operationPlanCorrelations = correlateOperationPlanBindings(operationPlans, execution);
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
  const operationPlanResidualCount = operationPlans.status === "verified" && operationPlanCorrelationResidualCount === 0 &&
      operationPlans.omitted_binding_count === 0
    ? 0
    : Math.max(1, operationPlans.plan_integrity_residual_count + operationPlans.residual_binding_count +
      operationPlans.unverified_memory_link_count + operationPlanCorrelationResidualCount +
      (operationPlans.omitted_binding_count > 0 ? 1 : 0));
  const checkpointVerified = storesVerified && execution.status === "verified" && operationPlans.status === "verified" &&
    !hasHardResidual && operationPlanCorrelationResidualCount === 0 && operationPlans.omitted_binding_count === 0;
  return {
    schema_version: 3,
    surface: "recovery_inspection",
    mode: "read_only",
    status: checkpointVerified ? "verified" : "residuals_present",
    ledgers: { j, m, execution, operation_plans: operationPlans },
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
    };
  });
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
