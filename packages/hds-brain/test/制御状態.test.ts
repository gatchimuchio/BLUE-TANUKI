import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  memoryCommitContentDigest,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator, rebuildJControlProjection } from "../src/制御状態.js";
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

  it("BT-U-C07.02-P 承認・M反映・後続receipt確認を別状態として観測し、切断後に復帰する", () => {
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
      lifecycle_state: "approved",
      active_update_id: "reconcile-001",
      pending: [{ update_id: "reconcile-001", status: "pending", lifecycle_state: "approved", expected_version: 0, receipt: null }],
    });

    const committed = coordinator.apply(commit);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const retried = coordinator.apply(commit);
    expect(retried).toEqual(committed);
    expect(coordinator.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
      lifecycle_state: "applied",
      pending: [{ update_id: "reconcile-001", lifecycle_state: "applied", receipt: null }],
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
      lifecycle_state: "applied",
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
      lifecycle_state: "effect_confirmed",
      active_update_id: null,
      pending: [{ update_id: "reconcile-001", status: "receipt_confirmed", lifecycle_state: "effect_confirmed", receipt: committed.receipt }],
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

  it("BT-U-C07.02-N 承認後に内容を変えたcommitは同じ承認で反映しない", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const approved = makeCommit("changed-after-approval", "approved-value");
    const changed = makeCommit("changed-after-approval", "changed-value");

    expect(coordinator.stage(approved)).toMatchObject({ ok: true, status: "memory_commit_pending" });
    expect(coordinator.snapshot()).toMatchObject({ lifecycle_state: "approved" });
    expect(coordinator.apply(changed)).toEqual({ ok: false, reason: "j_approval_not_verified" });
    expect(coordinator.snapshot()).toMatchObject({
      lifecycle_state: "approved",
      pending: [{ update_id: "changed-after-approval", lifecycle_state: "approved" }],
    });
    expect(coordinator.verify()).toBe(true);

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_receipts").get()?.count).toBe(0);
    database.close();

    const applied = coordinator.apply(approved);
    expect(applied.ok).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ lifecycle_state: "applied" });
    expect(coordinator.reconcile(approved.update_id)).toMatchObject({ ok: true, status: "ready" });
    expect(coordinator.snapshot()).toMatchObject({ lifecycle_state: "effect_confirmed" });
    coordinator.close();
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
    })).toThrow("projection_mismatch");

    const check: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    expect(check.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(1);
    check.close();
  });

  it("Jの派生像をj_eventsから再構築し、J ledgerだけを保持する", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const commit = makeCommit("repair-j", "synthetic-value");
    expect(coordinator.stage(commit)).toMatchObject({ ok: true, status: "memory_commit_pending" });
    coordinator.close();

    const damaged: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    const canonicalBefore = damaged.prepare("SELECT event_payload_json FROM j_events ORDER BY revision").all();
    damaged.exec("UPDATE j_state SET revision = 0, event_digest = 'GENESIS', status = 'ready', active_update_id = NULL");
    damaged.exec("DELETE FROM j_pending");
    damaged.close();

    expect(rebuildJControlProjection({
      private_state_root: directory,
      database_path: databasePath,
    })).toEqual({ ok: true, revision: 1, event_count: 1 });
    const checked: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT event_payload_json FROM j_events ORDER BY revision").all()).toEqual(canonicalBefore);
    expect(checked.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(0);
    checked.close();

    const reopened = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(reopened.snapshot()).toMatchObject({
      revision: 1,
      status: "memory_commit_pending",
      active_update_id: "repair-j",
      pending: [{ update_id: "repair-j", status: "pending" }],
    });
    expect(reopened.verify()).toBe(true);
    reopened.close();
  });

  it("Jの破損末尾を修復せず保持し、storeをledger_corruptで停止する", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(coordinator.stage(makeCommit("corrupt-j", "synthetic")).ok).toBe(true);
    coordinator.close();

    const damaged: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    damaged.prepare("UPDATE j_events SET event_payload_json = ? WHERE revision = 1").run("{torn");
    damaged.close();
    expect(rebuildJControlProjection({
      private_state_root: directory,
      database_path: databasePath,
    })).toEqual({ ok: false, reason: "ledger_corrupt" });
    const checked: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT event_payload_json FROM j_events WHERE revision = 1").get()?.event_payload_json)
      .toBe("{torn");
    checked.close();
    let openFailure: unknown;
    try {
      new JMemoryCommitCoordinator({
        private_state_root: directory,
        database_path: databasePath,
        j_approval_reader: approvingReader(),
      });
    } catch (error) {
      openFailure = error;
    }
    expect(openFailure).toMatchObject({ reason: "ledger_corrupt" });
  });

  it("J write failure後は同じhandleとcoordinatorからの新規stageを停止する", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    const connection: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    connection.exec(
      "CREATE TRIGGER injected_j_failure BEFORE INSERT ON j_events BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    connection.close();

    const first = makeCommit("j-write-fault", "synthetic");
    expect(coordinator.stage(first)).toEqual({ ok: false, reason: "write_failed" });
    expect(coordinator.health().j).toEqual({ available: false, failure: "write_failed", outcome_unknown: false });
    expect(coordinator.stage(makeCommit("j-after-fault", "later"))).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
    coordinator.close();
  });

  it("J schema version不一致の派生再構築を拒否する", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    coordinator.close();
    const damaged: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    damaged.exec("UPDATE j_schema SET schema_version = 99 WHERE singleton = 1");
    damaged.close();

    expect(rebuildJControlProjection({
      private_state_root: directory,
      database_path: databasePath,
    })).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  it("J派生tableのtriggerが正本を書き換え得るDBでは再構築を拒否する", () => {
    const coordinator = createCoordinator({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(coordinator.stage(makeCommit("trigger-guard-j", "synthetic")).ok).toBe(true);
    coordinator.close();

    const damaged: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath);
    const canonicalPayload = damaged.prepare(
      "SELECT event_payload_json FROM j_events WHERE revision = 1",
    ).get()?.event_payload_json;
    damaged.exec("UPDATE j_state SET revision = 0, event_digest = 'GENESIS', status = 'ready', active_update_id = NULL");
    damaged.exec(
      "CREATE TRIGGER tamper_canonical_j AFTER DELETE ON j_pending BEGIN UPDATE j_events SET event_payload_json = '{torn' WHERE revision = 1; END",
    );
    damaged.close();

    expect(rebuildJControlProjection({
      private_state_root: directory,
      database_path: databasePath,
    })).toEqual({ ok: false, reason: "schema_mismatch" });
    const checked: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT event_payload_json FROM j_events WHERE revision = 1").get()?.event_payload_json)
      .toBe(canonicalPayload);
    expect(checked.prepare("SELECT revision FROM j_state WHERE singleton = 1").get()?.revision).toBe(0);
    checked.close();
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
