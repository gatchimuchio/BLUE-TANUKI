import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  correlateRecoveryUpdates,
  inspectGatewayRecoveryState,
  projectGatewayRecoveryInspectionForOperator,
} from "../src/recovery_inspection.js";
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

describe("Gateway recovery operator projection", () => {
  it("retains digest-keyed residual rows while omitting raw identifiers and unrelated fields", () => {
    const report = {
      schema_version: 3,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: {
        j: { status: "verified" },
        m: { status: "projection_mismatch" },
        execution: { status: "verified" },
        operation_plans: { status: "residuals_present" },
      },
      replay_checkpoint: null,
      operation_plan_correlations: [{
        plan_id_digest: "a".repeat(64),
        step_id_digest: "b".repeat(64),
        command_id_digest: "c".repeat(64),
        status: "outcome_unknown",
        binding_integrity: "residuals_present",
        admission_digest: "d".repeat(64),
        broker_correlation: "not_found",
        delivery_correlation: "not_observed",
        memory_update_id_digest: "f".repeat(64),
        memory_correlation: "missing_plan_memory_link",
        command_id: "RAW_COMMAND_SENTINEL",
        ticket_id: "RAW_TICKET_SENTINEL",
      }],
      update_residuals: [{
        update_id_digest: "e".repeat(64),
        disposition: "content_mismatch",
        update_id: "RAW_UPDATE_SENTINEL",
      }],
      isolated_update_count: 1,
      execution_residual_count: 0,
      operation_plan_residual_count: 1,
      external_backup_restore_point: "not_examined",
      used_for_authority: false,
      may_execute: false,
      next_safe_action: "RAW_ACTION_SENTINEL",
      database_path: "C:\\private\\state.sqlite",
    };

    const projection = projectGatewayRecoveryInspectionForOperator(report);
    expect(projection).toMatchObject({
      surface: "recovery_inspection_operator",
      mode: "read_only",
      status: "residuals_present",
      ledgers: { j: "verified", m: "projection_mismatch", broker: "verified", operation_plans: "residuals_present" },
      operation_plan_correlations: [{
        plan_id_digest: "a".repeat(64),
        step_id_digest: "b".repeat(64),
        command_id_digest: "c".repeat(64),
        status: "outcome_unknown",
        binding_integrity: "residuals_present",
        admission_digest: "d".repeat(64),
        broker_correlation: "not_found",
        delivery_correlation: "not_observed",
        memory_update_id_digest: "f".repeat(64),
        memory_correlation: "missing_plan_memory_link",
      }],
      omitted_operation_plan_correlation_count: 0,
      update_residuals: [{ update_id_digest: "e".repeat(64), disposition: "content_mismatch" }],
      omitted_update_residual_count: 0,
      external_backup_restore_point: "not_examined",
      boundary_valid: true,
      used_for_authority: false,
      may_execute: false,
    });
    const serialized = JSON.stringify(projection);
    for (const sentinel of ["RAW_COMMAND_SENTINEL", "RAW_TICKET_SENTINEL", "RAW_UPDATE_SENTINEL", "RAW_ACTION_SENTINEL", "private\\state.sqlite"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("caps operator rows and suppresses records when the source report boundary is invalid", () => {
    const row = {
      plan_id_digest: "a".repeat(64),
      step_id_digest: "b".repeat(64),
      command_id_digest: "c".repeat(64),
      status: "not_attempted",
      binding_integrity: "verified",
      admission_digest: null,
      broker_correlation: "not_admitted",
      delivery_correlation: "not_recorded",
      memory_update_id_digest: null,
      memory_correlation: "not_recorded",
    };
    const update = { update_id_digest: "e".repeat(64), disposition: "blocked_j" };
    const capped = projectGatewayRecoveryInspectionForOperator({
      schema_version: 3,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: {},
      replay_checkpoint: null,
      operation_plan_correlations: Array.from({ length: 201 }, () => row),
      update_residuals: Array.from({ length: 201 }, () => update),
      used_for_authority: false,
      may_execute: false,
    });
    expect(capped.operation_plan_correlations).toHaveLength(200);
    expect(capped.omitted_operation_plan_correlation_count).toBe(1);
    expect(capped.update_residuals).toHaveLength(200);
    expect(capped.omitted_update_residual_count).toBe(1);

    const invalid = projectGatewayRecoveryInspectionForOperator({
      schema_version: 3,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "verified",
      ledgers: {},
      operation_plan_correlations: [row],
      update_residuals: [update],
      used_for_authority: true,
      may_execute: false,
    });
    expect(invalid.status).toBe("invalid_report");
    expect(invalid.boundary_valid).toBe(false);
    expect(invalid.operation_plan_correlations).toEqual([]);
    expect(invalid.update_residuals).toEqual([]);
    expect(invalid.omitted_operation_plan_correlation_count).toBe(1);
    expect(invalid.omitted_update_residual_count).toBe(1);
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
