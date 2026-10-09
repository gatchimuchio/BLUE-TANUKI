import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  memoryCommitContentDigest,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator } from "../src/制御状態.js";
import { MemoryUpdateLedger } from "../src/記憶更新.js";
import type { JMemoryApprovalReader, JMemoryApprovalReference } from "../src/保存取引.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let coordinators: JMemoryCommitCoordinator[] = [];

describe("J制御状態とM receipt再照合", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "blue-tanuki-j-control-"));
    databasePath = join(directory, "canonical.sqlite");
    coordinators = [];
  });

  afterEach(() => {
    for (const coordinator of coordinators) coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("M確定後J受領前の切断から、永続pendingとreceipt照会で一度だけ復帰する", () => {
    const approvalReader = approvingReader();
    const commit = makeCommit("reconcile-001", "private-memory-value");
    let coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvalReader,
    });

    expect(coordinator.stage(commit)).toMatchObject({ ok: true, status: "memory_commit_pending", revision: 1 });
    expect(coordinator.stage(commit)).toMatchObject({ ok: true, status: "memory_commit_pending", revision: 1 });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
      active_update_id: "reconcile-001",
      pending: [{ update_id: "reconcile-001", status: "pending", expected_version: 0, receipt: null }],
    });

    const committed = coordinator.apply(commit);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const retried = coordinator.apply(commit);
    expect(retried).toEqual(committed);
    expect(coordinator.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
    });

    // M commitの確定後、Jがreceiptを記録する前に両storeを閉じる。
    coordinator.close();
    coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvalReader,
    });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
      active_update_id: "reconcile-001",
    });
    expect(coordinator.reconcile("reconcile-001")).toEqual({
      ok: true,
      status: "ready",
      revision: 2,
      update_id: "reconcile-001",
      receipt: committed.receipt,
    });
    expect(coordinator.reconcile("reconcile-001")).toEqual({
      ok: true,
      status: "ready",
      revision: 2,
      update_id: "reconcile-001",
      receipt: committed.receipt,
    });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 2,
      status: "ready",
      active_update_id: null,
      pending: [{ update_id: "reconcile-001", status: "receipt_confirmed", receipt: committed.receipt }],
    });
    expect(coordinator.verify()).toBe(true);

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_receipts").get()?.count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(2);
    const jEventPayloads = database.prepare("SELECT event_payload_json FROM j_events").all();
    expect(JSON.stringify(jEventPayloads)).not.toContain("private-memory-value");
    database.close();
    coordinator.close();
  });

  it("receipt不在間はpendingを保ち、再照合からMへの再送を起こさない", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const commit = makeCommit("receipt-not-yet", "later");
    expect(coordinator.stage(commit).ok).toBe(true);
    expect(coordinator.reconcile("receipt-not-yet")).toEqual({
      ok: true,
      status: "memory_commit_pending",
      revision: 1,
      update_id: "receipt-not-yet",
    });
    expect(coordinator.reconcile("receipt-not-yet")).toEqual({
      ok: true,
      status: "memory_commit_pending",
      revision: 1,
      update_id: "receipt-not-yet",
    });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
      active_update_id: "receipt-not-yet",
    });
    expect(coordinator.verify()).toBe(true);
    coordinator.close();

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_receipts").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(1);
    database.close();
  });

  it("Mの既存receiptがJ pendingのdigestと異なる場合は進行を止める", () => {
    const previousCommit = makeCommit("reused-id", "previous-value");
    const previousM = new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(previousM.apply(previousCommit).ok).toBe(true);
    previousM.close();

    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const newCommit = makeCommit("reused-id", "different-value");
    expect(coordinator.stage(newCommit)).toMatchObject({ ok: true, status: "memory_commit_pending" });
    expect(coordinator.reconcile("reused-id")).toEqual({
      ok: false,
      status: "blocked",
      revision: 2,
      update_id: "reused-id",
      reason: "m_receipt_mismatch",
    });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 2,
      status: "blocked",
      active_update_id: "reused-id",
      pending: [{ update_id: "reused-id", status: "blocked", block_reason: "m_receipt_mismatch", receipt: null }],
    });
    expect(coordinator.verify()).toBe(true);
    coordinator.close();

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(2);
    database.close();
  });

  it("Mの期待版競合でJ pendingをblockedへ確定し、その後の照合で進行しない", () => {
    const priorM = new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(priorM.apply(makeCommit("prior-version", "already-current", 0)).ok).toBe(true);
    priorM.close();

    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const stale = makeCommit("stale-version", "stale-write", 0);
    expect(coordinator.stage(stale).ok).toBe(true);
    expect(coordinator.apply(stale)).toEqual({ ok: false, reason: "expected_version_conflict" });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 2,
      status: "blocked",
      active_update_id: "stale-version",
      pending: [{ update_id: "stale-version", status: "blocked", block_reason: "m_update_rejected", receipt: null }],
    });
    expect(coordinator.reconcile("stale-version")).toEqual({
      ok: false,
      status: "blocked",
      revision: 2,
      update_id: "stale-version",
      reason: "m_update_rejected",
    });
    expect(coordinator.verify()).toBe(true);
    coordinator.close();
  });

  it("承認参照不一致やbooleanだけではpendingも権限も作らない", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: { readVerifiedMemoryApproval: () => ({ approved: true }) },
    });
    const commit = makeCommit("denied-001", "must-not-persist");
    expect(coordinator.stage(commit)).toEqual({ ok: false, reason: "j_approval_not_verified" });
    expect(coordinator.stage({ ...commit, approved: true })).toEqual({ ok: false, reason: "schema_validation_failed" });
    expect(coordinator.snapshot()).toMatchObject({
      revision: 0,
      status: "ready",
      active_update_id: null,
      pending: [],
    });
    expect(coordinator.apply(commit)).toEqual({ ok: false, reason: "j_approval_not_verified" });
    expect(coordinator.verify()).toBe(true);
    coordinator.close();

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(0);
    database.close();
  });

  it("Jの状態projectionがevent chainと合わなければ復帰・反映を開始しない", () => {
    const coordinator = new JMemoryCommitCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const commit = makeCommit("tamper-001", "unconfirmed");
    expect(coordinator.stage(commit).ok).toBe(true);
    coordinator.close();

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    database.prepare("UPDATE j_state SET status = 'ready', active_update_id = NULL WHERE singleton = 1").run();
    database.close();

    expect(() => new JMemoryCommitCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    })).toThrow("J control state initialization failed");

    const check: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    expect(check.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(1);
    check.close();
  });
});

function makeCommit(updateId: string, value: unknown, expectedVersion = 0) {
  const content = {
    schema_version: MEMORY_COMMIT_SCHEMA_VERSION,
    expected_version: expectedVersion,
    update_id: updateId,
    j_event_id: `j-event-${updateId}`,
    changes: [{ operation: "upsert" as const, record_id: "synthetic-fact", value }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

function approvingReader(): JMemoryApprovalReader {
  return {
    readVerifiedMemoryApproval(reference: JMemoryApprovalReference) {
      return {
        update_id: reference.update_id,
        j_event_id: reference.j_event_id,
        content_digest: reference.content_digest,
      };
    },
  };
}

function createCoordinator(options: ConstructorParameters<typeof JMemoryCommitCoordinator>[0]): JMemoryCommitCoordinator {
  const coordinator = new JMemoryCommitCoordinator(options);
  coordinators.push(coordinator);
  return coordinator;
}
