import { mkdtemp, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { correlateRecoveryUpdates, inspectGatewayRecoveryState } from "../src/recovery_inspection.js";
import type { PersistenceLedgerInspection, PersistenceLedgerInspectionUpdate } from "@blue-tanuki/hds-brain";

describe("Gateway read-only recovery inspection", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("reports missing ledgers without creating runtime state or implying a restore point", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-inspection-"));
    const stateRoot = path.join(temporaryRoot, "not-created");
    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: stateRoot });

    expect(report).toMatchObject({
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      replay_checkpoint: null,
      external_backup_restore_point: "not_examined",
      used_for_authority: false,
      may_execute: false,
    });
    expect(report.ledgers.j.status).toBe("unavailable");
    expect(report.ledgers.m.status).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain(stateRoot);
    await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("correlates only verified update digests and leaves unresolved two-store states explicit", () => {
    const jPending: PersistenceLedgerInspectionUpdate = {
      update_id_digest: "a".repeat(64),
      j_event_id_digest: "b".repeat(64),
      content_digest: "c".repeat(64),
      phase: "pending",
      expected_version: 0,
    };
    const mCommit: PersistenceLedgerInspectionUpdate = {
      update_id_digest: "a".repeat(64),
      j_event_id_digest: "b".repeat(64),
      content_digest: "c".repeat(64),
      phase: "committed",
      revision: 1,
      event_digest: "d".repeat(64),
    };

    expect(correlateRecoveryUpdates(ledgerInspection("J", [jPending]), ledgerInspection("M", [mCommit])))
      .toEqual([{ update_id_digest: "a".repeat(64), disposition: "pending_j_receipt" }]);
    expect(correlateRecoveryUpdates(ledgerInspection("J", []), ledgerInspection("M", [mCommit])))
      .toEqual([{ update_id_digest: "a".repeat(64), disposition: "missing_verified_j_link" }]);
    expect(correlateRecoveryUpdates(ledgerInspection("J", [jPending]), ledgerInspection("M", [{ ...mCommit, content_digest: "e".repeat(64) }])))
      .toEqual([{ update_id_digest: "a".repeat(64), disposition: "content_mismatch" }]);
  });
});

function ledgerInspection(
  owner: "J" | "M",
  updates: readonly PersistenceLedgerInspectionUpdate[],
): PersistenceLedgerInspection {
  return {
    owner,
    status: "verified",
    reason: null,
    verified_event_count: updates.length,
    unverified_event_count: 0,
    first_unverified_ordinal: null,
    last_verified_revision: updates.length,
    last_verified_event_digest: "f".repeat(64),
    updates,
    used_for_authority: false,
  };
}
