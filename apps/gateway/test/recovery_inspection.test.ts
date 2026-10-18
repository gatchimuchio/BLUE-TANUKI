import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { correlateRecoveryUpdates, inspectGatewayRecoveryState } from "../src/recovery_inspection.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import type { PersistenceLedgerInspection, PersistenceLedgerInspectionUpdate } from "@blue-tanuki/hds-brain";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

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
    expect(report.ledgers.execution.status).toBe("unavailable");
    expect(report.ledgers.operation_plans.status).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain(stateRoot);
    await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspects the Broker event ledger without creating J/M paths or exposing ticket handles", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-execution-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const databasePath = path.join(executionDirectory, "executor.sqlite");
    const ticket = executionTicket();
    const store = new GatewayExecutionIntentStore(databasePath);
    store.issue(ticket);
    store.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    const serialized = JSON.stringify(report);
    expect(report.ledgers.execution).toMatchObject({
      status: "verified",
      verified_event_count: 1,
      unverified_event_count: 0,
      current_state_available: true,
      used_for_authority: false,
      execution_eligible: false,
      records: [{
        ticket_digest: sha256(ticket.ticket_id),
        command_key_digest: sha256(ticket.command_key),
        execution_epoch_digest: sha256(ticket.execution_epoch),
        state: "issued",
        reconciliation_required: false,
      }],
    });
    expect(report.status).toBe("residuals_present");
    expect(report.replay_checkpoint).toBeNull();
    expect(serialized).not.toContain(ticket.ticket_id);
    expect(serialized).not.toContain(ticket.command_key);
    expect(await readFile(databasePath)).toEqual(before);
    await expect(stat(path.join(privateRoot, "result-memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates an unverified Broker suffix and never treats its receipt projection as current", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-corrupt-execution-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const databasePath = path.join(executionDirectory, "executor.sqlite");
    const store = new GatewayExecutionIntentStore(databasePath);
    store.issue(executionTicket());
    store.close();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE execution_events SET event_json='{}' WHERE sequence=1").run();
    database.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.execution).toMatchObject({
      status: "corrupt",
      reason: "ledger_corrupt",
      verified_event_count: 0,
      unverified_event_count: 1,
      first_unverified_ordinal: 1,
      current_state_available: false,
      records: [],
      used_for_authority: false,
      execution_eligible: false,
    });
    expect(report.execution_residual_count).toBeGreaterThan(0);
    expect(report.replay_checkpoint).toBeNull();
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("refuses an execution database with SQLite recovery sidecars without opening or changing it", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-sidecar-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const databasePath = path.join(executionDirectory, "executor.sqlite");
    const store = new GatewayExecutionIntentStore(databasePath);
    store.issue(executionTicket());
    store.close();
    const before = await readFile(databasePath);
    const sidecarPath = `${databasePath}-wal`;
    await writeFile(sidecarPath, "sentinel");

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.execution.status).toBe("unavailable");
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readFile(sidecarPath, "utf8")).toBe("sentinel");
  });

  it("detects a receipt projection that differs from a fully verified event chain", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-projection-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const databasePath = path.join(executionDirectory, "executor.sqlite");
    const store = new GatewayExecutionIntentStore(databasePath);
    const ticket = executionTicket();
    store.issue(ticket);
    store.close();
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT receipt_json FROM execution_intents WHERE ticket_id=?").get(ticket.ticket_id) as { receipt_json: string };
    const receipt = JSON.parse(row.receipt_json) as { state: string };
    receipt.state = "not_attempted";
    const receiptJson = JSON.stringify(receipt);
    database.prepare("UPDATE execution_intents SET receipt_json=?,receipt_digest=? WHERE ticket_id=?")
      .run(receiptJson, sha256(receiptJson), ticket.ticket_id);
    database.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.execution).toMatchObject({
      status: "residuals_present",
      reason: "projection_mismatch",
      verified_event_count: 1,
      receipt_projection_mismatch_count: 1,
      current_state_available: false,
      records: [],
    });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("isolates an outbox row that is not bound to the verified execution receipt", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-outbox-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const executionDirectory = path.join(privateRoot, "execution-intents");
    await mkdir(executionDirectory, { recursive: true });
    const databasePath = path.join(executionDirectory, "executor.sqlite");
    const ticket = executionTicket();
    const store = new GatewayExecutionIntentStore(databasePath);
    store.issue(ticket);
    store.close();
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO execution_result_outbox(ticket_id,delivery_json,delivery_digest) VALUES(?,?,?)")
      .run(ticket.ticket_id, "{}", sha256("{}"));
    database.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.execution).toMatchObject({
      status: "residuals_present",
      reason: "outbox_mismatch",
      outbox_mismatch_count: 1,
      current_state_available: false,
      records: [],
    });
    expect(await readFile(databasePath)).toEqual(before);
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

function executionTicket() {
  return {
    ticket_id: randomUUID(),
    command_key: sha256("synthetic-command-key"),
    command_digest: sha256("synthetic-command"),
    proof_digest: sha256("synthetic-proof"),
    execution_epoch: randomUUID(),
    issued_at_ms: 10_000,
    expires_at_ms: 20_000,
  };
}

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
