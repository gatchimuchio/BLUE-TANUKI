import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecoveryPlanDependencyScopes,
  correlateRecoveryUpdates,
  inspectGatewayRecoveryState,
  projectGatewayRecoveryInspectionForOperator,
} from "../src/recovery_inspection.js";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";
import type { CronEventRecoveryInspection } from "../src/cron_event_recovery_inspection.js";
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
    expect(report.ledgers.cron_events).toMatchObject({ status: "unavailable", residual_count: 1, used_for_authority: false });
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

  it("inspects Cron cursors and approval handoffs read-only, isolating row corruption as counts", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-cron-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const cronDirectory = path.join(privateRoot, "cron-events");
    await mkdir(cronDirectory, { recursive: true });
    const databasePath = path.join(cronDirectory, "cron-events.sqlite");
    const store = new GatewayCronEventStore(databasePath);
    const settled = createCronEventIdentity("synthetic-settled-source", 1, sha256("settled-payload"));
    store.claim(settled, 10);
    store.settle(settled, "handler_returned", 11);
    const pending = createCronEventIdentity("synthetic-pending-source", 2, sha256("pending-payload"));
    store.claim(pending, 12);
    store.recordPendingApproval(pending.event_id, pending.payload_digest, "private-command-reference", "private-request-reference", 13);
    store.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.cron_events).toMatchObject({
      status: "residuals_present",
      cursor_count: 2,
      verified_cursor_count: 2,
      unverified_cursor_count: 0,
      unresolved_cursor_count: 1,
      orphan_outbox_count: 0,
      approval_handoff_count: 1,
      pending_approval_handoff_count: 1,
      interrupted_approval_handoff_count: 0,
      residual_count: 2,
      used_for_authority: false,
    });
    expect(report.replay_checkpoint).toBeNull();
    expect(await readFile(databasePath)).toEqual(before);
    let serialized = JSON.stringify(report);
    for (const secret of [settled.event_id, pending.event_id, pending.payload_digest, "private-command-reference", "private-request-reference"]) {
      expect(serialized).not.toContain(secret);
    }

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE cron_event_outbox SET payload_digest=? WHERE source_digest=?")
      .run(sha256("corrupt-outbox-payload"), sha256("synthetic-settled-source"));
    database.prepare("UPDATE cron_approval_handoff SET event_id=?")
      .run(`cron-${sha256("malformed-approval-identity")}`);
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(`INSERT INTO cron_event_outbox
      (source_digest,event_id,sequence,payload_digest,delivery_state,updated_at_ms)
      VALUES (?,?,?,?,?,?)`).run(sha256("orphan-source"), `cron-${sha256("orphan-event")}`, 9, sha256("orphan-payload"), "handler_returned", 14);
    database.close();
    const corruptBefore = await readFile(databasePath);

    const partial = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(partial.ledgers.cron_events).toMatchObject({
      status: "residuals_present",
      cursor_count: 2,
      verified_cursor_count: 1,
      unverified_cursor_count: 1,
      orphan_outbox_count: 1,
      approval_handoff_count: 1,
      verified_approval_handoff_count: 0,
      unverified_approval_handoff_count: 1,
      pending_approval_handoff_count: 0,
      residual_count: 4,
      used_for_authority: false,
    });
    expect(partial.replay_checkpoint).toBeNull();
    expect(await readFile(databasePath)).toEqual(corruptBefore);
    serialized = JSON.stringify(partial);
    for (const secret of [settled.event_id, pending.event_id, "orphan-source", "malformed-approval-identity", "private-command-reference"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("refuses Cron inspection when a SQLite sidecar exists and leaves the database unopened", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-cron-sidecar-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const cronDirectory = path.join(privateRoot, "cron-events");
    await mkdir(cronDirectory, { recursive: true });
    const databasePath = path.join(cronDirectory, "cron-events.sqlite");
    const store = new GatewayCronEventStore(databasePath);
    store.close();
    const before = await readFile(databasePath);
    const sidecarPath = `${databasePath}-wal`;
    await writeFile(sidecarPath, "synthetic-sidecar", "utf8");

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.cron_events).toMatchObject({
      status: "unavailable", reason: "store_unavailable", cursor_count: null, residual_count: 1, used_for_authority: false,
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readFile(sidecarPath, "utf8")).toBe("synthetic-sidecar");
  });

  it("reports an unknown Cron schema without modifying or exposing its path", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-recovery-cron-schema-"));
    const privateRoot = path.join(temporaryRoot, "state", "private-state");
    const cronDirectory = path.join(privateRoot, "cron-events");
    await mkdir(cronDirectory, { recursive: true });
    const databasePath = path.join(cronDirectory, "cron-events.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE unexpected (value TEXT) STRICT");
    database.close();
    const before = await readFile(databasePath);

    const report = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: path.dirname(privateRoot) });
    expect(report.ledgers.cron_events).toMatchObject({
      status: "schema_mismatch", reason: "schema_mismatch", cursor_count: null, residual_count: 1, used_for_authority: false,
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(databasePath);
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
    const planCorrelation = {
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
      cron_approval_correlation: "plan_binding_unverified",
      command_id: "RAW_COMMAND_SENTINEL",
      ticket_id: "RAW_TICKET_SENTINEL",
    } as const;
    const planSummary = {
      plan_id_digest: "a".repeat(64),
      integrity: "residuals_present",
      plan_record_count: 1,
      binding_count: 1,
      residual_binding_count: 1,
      omitted_binding_count: 0,
    } as const;
    const report = {
      schema_version: 6,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: {
        j: { status: "verified", reason: null, verified_event_count: 3, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: 3 },
        m: { status: "projection_mismatch", reason: "projection_mismatch", verified_event_count: 2, unverified_event_count: 1, first_unverified_ordinal: 3, last_verified_revision: 2 },
        execution: { status: "verified", reason: "RAW_REASON_SENTINEL", verified_event_count: 2, unverified_event_count: 0, first_unverified_ordinal: null },
        operation_plans: {
          status: "residuals_present",
          plan_count: 1,
          binding_count: 1,
          residual_binding_count: 1,
          omitted_binding_count: 0,
          plans: [planSummary],
        },
        cron_events: cronEventInspection("verified"),
      },
      replay_checkpoint: null,
      operation_plan_correlations: [planCorrelation],
      plan_dependency_scopes: buildRecoveryPlanDependencyScopes([planSummary], [planCorrelation]),
      update_residuals: [{
        update_id_digest: "e".repeat(64),
        disposition: "content_mismatch",
        update_id: "RAW_UPDATE_SENTINEL",
      }],
      isolated_update_count: 1,
      execution_residual_count: 0,
      operation_plan_residual_count: 1,
      cron_event_residual_count: 0,
      cron_approval_correlation_residual_count: 1,
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
      schema_version: 5,
      ledgers: { j: "verified", m: "projection_mismatch", broker: "verified", operation_plans: "residuals_present" },
      ledger_boundaries: {
        j: { reason: null, verified_event_count: 3, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: 3 },
        m: { reason: "projection_mismatch", verified_event_count: 2, unverified_event_count: 1, first_unverified_ordinal: 3, last_verified_revision: 2 },
        broker: { reason: "unknown", verified_event_count: 2, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: null },
      },
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
        cron_approval_correlation: "plan_binding_unverified",
      }],
      omitted_operation_plan_correlation_count: 0,
      plan_dependency_scopes: [{
        plan_id_digest: "a".repeat(64),
        integrity: "residuals_present",
        plan_record_count: 1,
        binding_count: 1,
        residual_binding_count: 1,
        omitted_binding_count: 0,
        inspected_binding_count: 1,
        status: "residuals_present",
        residual_dependencies: ["operation_plan", "broker", "memory"],
        unobserved_dependencies: ["delivery", "cron_approval"],
      }],
      omitted_plan_dependency_scope_count: 0,
      cron_approval_correlation_residual_count: 1,
      update_residuals: [{ update_id_digest: "e".repeat(64), disposition: "content_mismatch" }],
      omitted_update_residual_count: 0,
      external_backup_restore_point: "not_examined",
      boundary_valid: true,
      used_for_authority: false,
      may_execute: false,
    });
    const serialized = JSON.stringify(projection);
    for (const sentinel of ["RAW_COMMAND_SENTINEL", "RAW_TICKET_SENTINEL", "RAW_UPDATE_SENTINEL", "RAW_ACTION_SENTINEL", "RAW_REASON_SENTINEL", "private\\state.sqlite"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("keeps downstream delivery evidence unobserved when the Broker link is unavailable or absent", () => {
    const plan = {
      plan_id_digest: "a".repeat(64),
      integrity: "verified",
      plan_record_count: 1,
      binding_count: 1,
      residual_binding_count: 0,
      omitted_binding_count: 0,
    } as const;
    const row = {
      plan_id_digest: plan.plan_id_digest,
      binding_integrity: "verified",
      broker_correlation: "broker_unverified",
      delivery_correlation: "not_observed",
      memory_correlation: "not_recorded",
      cron_approval_correlation: "not_recorded",
    } as const;
    expect(buildRecoveryPlanDependencyScopes([plan], [row])).toMatchObject([{
      status: "unobserved",
      residual_dependencies: [],
      unobserved_dependencies: ["broker", "delivery"],
    }]);
    expect(buildRecoveryPlanDependencyScopes([plan], [{ ...row, broker_correlation: "not_found" }])).toMatchObject([{
      status: "residuals_present",
      residual_dependencies: ["broker"],
      unobserved_dependencies: ["delivery"],
    }]);
    expect(buildRecoveryPlanDependencyScopes([plan], [{ ...row, broker_correlation: "not_admitted" }])).toMatchObject([{
      status: "observed",
      residual_dependencies: [],
      unobserved_dependencies: [],
    }]);
    expect(buildRecoveryPlanDependencyScopes([plan], [{
      ...row,
      memory_correlation: "m_state_unverified",
      cron_approval_correlation: "cron_unverified",
    }])).toMatchObject([{
      status: "unobserved",
      residual_dependencies: [],
      unobserved_dependencies: ["broker", "delivery", "memory", "cron_approval"],
    }]);
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
      cron_approval_correlation: "not_recorded",
    };
    const update = { update_id_digest: "e".repeat(64), disposition: "blocked_j" };
    const omittedPlanSummary = {
      plan_id_digest: "a".repeat(64),
      integrity: "verified",
      plan_record_count: 1,
      binding_count: 201,
      residual_binding_count: 0,
      omitted_binding_count: 1,
    } as const;
    const inspectedRows = Array.from({ length: 200 }, () => row);
    const capped = projectGatewayRecoveryInspectionForOperator({
      schema_version: 6,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: {
        cron_events: cronEventInspection("verified"),
        operation_plans: {
          status: "verified",
          plan_count: 1,
          binding_count: 201,
          residual_binding_count: 0,
          omitted_binding_count: 1,
          plans: [omittedPlanSummary],
        },
      },
      cron_event_residual_count: 0,
      cron_approval_correlation_residual_count: 0,
      replay_checkpoint: null,
      operation_plan_correlations: Array.from({ length: 201 }, () => row),
      plan_dependency_scopes: buildRecoveryPlanDependencyScopes([omittedPlanSummary], inspectedRows),
      update_residuals: Array.from({ length: 201 }, () => update),
      used_for_authority: false,
      may_execute: false,
    });
    expect(capped.operation_plan_correlations).toHaveLength(200);
    expect(capped.omitted_operation_plan_correlation_count).toBe(1);
    expect(capped.update_residuals).toHaveLength(200);
    expect(capped.omitted_update_residual_count).toBe(1);

    const invalid = projectGatewayRecoveryInspectionForOperator({
      schema_version: 6,
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
    expect(invalid.ledger_boundaries).toMatchObject({
      j: { reason: "unknown", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
      m: { reason: "unknown", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
      broker: { reason: "unknown", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
    });
  });

  it("hides inconsistent or unavailable ledger positions instead of presenting an empty recovery boundary", () => {
    const projection = projectGatewayRecoveryInspectionForOperator({
      schema_version: 6,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: {
        j: { status: "corrupt", reason: "ledger_corrupt", verified_event_count: 8, unverified_event_count: 2, first_unverified_ordinal: 12, last_verified_revision: 8 },
        m: { status: "unavailable", reason: "store_unavailable", verified_event_count: 0, unverified_event_count: 0, first_unverified_ordinal: null, last_verified_revision: 0 },
        execution: { status: "verified", reason: null, verified_event_count: 4, unverified_event_count: 1, first_unverified_ordinal: null },
        operation_plans: { status: "unavailable", plan_count: 0, binding_count: 0, residual_binding_count: 0, omitted_binding_count: 0, plans: [] },
        cron_events: cronEventInspection("verified"),
      },
      cron_event_residual_count: 0,
      cron_approval_correlation_residual_count: 0,
      operation_plan_correlations: [],
      plan_dependency_scopes: [],
      update_residuals: [],
      used_for_authority: false,
      may_execute: false,
    });
    expect(projection.ledger_boundaries).toEqual({
      j: { reason: "ledger_corrupt", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
      m: { reason: "store_unavailable", verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
      broker: { reason: null, verified_event_count: null, unverified_event_count: null, first_unverified_ordinal: null, last_verified_revision: null },
    });
  });

  it("invalidates the entire operator boundary when Cron summary counts do not reconcile", () => {
    const projection = projectGatewayRecoveryInspectionForOperator({
      schema_version: 6,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "verified",
      ledgers: { cron_events: { ...cronEventInspection("verified"), cursor_count: 2 } },
      operation_plan_correlations: [],
      update_residuals: [],
      cron_approval_correlation_residual_count: 0,
      used_for_authority: false,
      may_execute: false,
    });
    expect(projection.status).toBe("invalid_report");
    expect(projection.boundary_valid).toBe(false);
    expect(projection.cron_event_summary.cursor_count).toBeNull();
  });

  it("invalidates the operator boundary when the Cron correlation residual count disagrees with its rows", () => {
    const projection = projectGatewayRecoveryInspectionForOperator({
      schema_version: 6,
      surface: "recovery_inspection",
      mode: "read_only",
      status: "residuals_present",
      ledgers: { cron_events: cronEventInspection("verified") },
      cron_event_residual_count: 0,
      cron_approval_correlation_residual_count: 0,
      operation_plan_correlations: [{
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
        cron_approval_correlation: "ambiguous",
      }],
      update_residuals: [],
      used_for_authority: false,
      may_execute: false,
    });
    expect(projection.status).toBe("invalid_report");
    expect(projection.boundary_valid).toBe(false);
    expect(projection.operation_plan_correlations).toEqual([]);
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

function cronEventInspection(status: "verified" | "unavailable" = "verified"): CronEventRecoveryInspection {
  if (status === "unavailable") {
    return {
      status,
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
      used_for_authority: false,
    };
  }
  return {
    status,
    reason: null,
    cursor_count: 0,
    verified_cursor_count: 0,
    unverified_cursor_count: 0,
    omitted_cursor_count: 0,
    unresolved_cursor_count: 0,
    orphan_outbox_count: 0,
    approval_handoff_count: 0,
    verified_approval_handoff_count: 0,
    unverified_approval_handoff_count: 0,
    omitted_approval_handoff_count: 0,
    pending_approval_handoff_count: 0,
    interrupted_approval_handoff_count: 0,
    residual_count: 0,
    used_for_authority: false,
  };
}
