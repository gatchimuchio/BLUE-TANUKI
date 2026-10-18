import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  inspectJControlRecoveryLedger,
  inspectMemoryRecoveryLedger,
  type PersistenceLedgerInspection,
} from "@blue-tanuki/hds-brain";

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
  readonly schema_version: 1;
  readonly surface: "recovery_inspection";
  readonly mode: "read_only";
  readonly status: "verified" | "residuals_present";
  readonly ledgers: {
    readonly j: PersistenceLedgerInspection;
    readonly m: PersistenceLedgerInspection;
  };
  readonly replay_checkpoint: null | {
    readonly verified: true;
    readonly kind: "canonical_replay_checkpoint_not_backup";
    readonly j_revision: number;
    readonly j_event_digest: string;
    readonly m_revision: number;
    readonly m_event_digest: string;
    readonly update_count: number;
  };
  readonly update_residuals: readonly RecoveryUpdateResidual[];
  readonly isolated_update_count: number;
  readonly external_backup_restore_point: "not_examined";
  readonly used_for_authority: false;
  readonly may_execute: false;
  readonly next_safe_action: string;
}

interface StateDatabasePaths {
  readonly privateRoot: string;
  readonly jPath: string | null;
  readonly mPath: string | null;
}

function hasSafeExistingStatePaths(env: NodeJS.ProcessEnv): StateDatabasePaths | null {
  try {
    const configuredRoot = path.resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    const rootStat = lstatSync(configuredRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const stateRoot = realpathSync(configuredRoot);
    const privateRoot = path.join(stateRoot, "private-state");
    const resultDirectory = path.join(privateRoot, "result-memory");
    for (const directory of [privateRoot, resultDirectory]) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    }
    const jPath = path.join(resultDirectory, "j-control.sqlite");
    const mPath = path.join(resultDirectory, "m-state.sqlite");
    const safeDatabasePath = (databasePath: string): string | null => {
      if (!existsSync(databasePath)) return databasePath;
      const stat = lstatSync(databasePath);
      return stat.isSymbolicLink() || !stat.isFile() ? null : databasePath;
    };
    return { privateRoot, jPath: safeDatabasePath(jPath), mPath: safeDatabasePath(mPath) };
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
  const j = paths?.jPath
    ? inspectJControlRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.jPath })
    : unavailable("J");
  const m = paths?.mPath
    ? inspectMemoryRecoveryLedger({ private_state_root: paths.privateRoot, database_path: paths.mPath })
    : unavailable("M");
  const residuals = correlateRecoveryUpdates(j, m);
  const storesVerified = j.status === "verified" && m.status === "verified";
  const hasHardResidual = residuals.some((item) => !["paired", "pending_m_commit", "pending_j_receipt"].includes(item.disposition));
  const checkpointVerified = storesVerified && !hasHardResidual;
  return {
    schema_version: 1,
    surface: "recovery_inspection",
    mode: "read_only",
    status: checkpointVerified ? "verified" : "residuals_present",
    ledgers: { j, m },
    replay_checkpoint: checkpointVerified
      ? {
          verified: true,
          kind: "canonical_replay_checkpoint_not_backup",
          j_revision: j.last_verified_revision,
          j_event_digest: j.last_verified_event_digest ?? "GENESIS",
          m_revision: m.last_verified_revision,
          m_event_digest: m.last_verified_event_digest ?? "GENESIS",
          update_count: residuals.length,
        }
      : null,
    update_residuals: residuals,
    isolated_update_count: residuals.filter((item) =>
      !["paired", "pending_m_commit", "pending_j_receipt"].includes(item.disposition),
    ).length,
    external_backup_restore_point: "not_examined",
    used_for_authority: false,
    may_execute: false,
    next_safe_action: checkpointVerified
      ? "This read-only checkpoint does not restore data or authorize work; use the guarded recovery path for any repair."
      : "Keep work suspended; preserve the stores and compare the verified prefixes with an independently verified backup before repair.",
  };
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
