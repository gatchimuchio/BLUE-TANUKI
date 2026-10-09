import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  memoryCommitContentDigest,
} from "@blue-tanuki/protocol";
import { MemoryUpdateLedger } from "../src/記憶更新.js";
import type { JMemoryApprovalReader, JMemoryApprovalReference } from "../src/保存取引.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("M記憶更新取引", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "blue-tanuki-memory-update-"));
    databasePath = join(directory, "canonical.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("イベント・状態・更新ID消費・receiptを一取引で確定し、再起動後に照合する", () => {
    const approvalReader = approvingReader();
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvalReader });
    const first = ledger.apply(makeCommit("update-001", [
      { operation: "upsert", record_id: "keep", value: { count: 1 } },
      { operation: "upsert", record_id: "remove-me", value: "old" },
    ]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.receipt.revision).toBe(1);
    expect(first.receipt.previous_revision).toBe(0);
    expect(ledger.snapshot()).toMatchObject({
      revision: 1,
      used_for_authority: false,
      records: { keep: { count: 1 }, "remove-me": "old" },
    });

    const second = ledger.apply(makeCommit("update-002", [
      { operation: "upsert", record_id: "keep", value: { count: 2, tags: ["verified"] } },
      { operation: "delete", record_id: "remove-me" },
    ]));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.receipt.revision).toBe(2);
    expect(ledger.snapshot()).toMatchObject({
      revision: 2,
      used_for_authority: false,
      records: { keep: { count: 2, tags: ["verified"] } },
    });
    expect(Object.hasOwn(ledger.snapshot()!.records, "remove-me")).toBe(false);
    expect(ledger.verify()).toBe(true);
    ledger.close();

    const reopened = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvalReader });
    expect(reopened.verify()).toBe(true);
    expect(reopened.snapshot()).toMatchObject({ revision: 2, records: { keep: { count: 2, tags: ["verified"] } } });
    expect(reopened.receipt("update-002")).toEqual(second.receipt);
    reopened.close();
    expect(approvalReader.references).toEqual([
      { update_id: "update-001", j_event_id: "j-event-update-001", content_digest: first.receipt.content_digest },
      { update_id: "update-002", j_event_id: "j-event-update-002", content_digest: second.receipt.content_digest },
    ]);
  });

  it("J側の内容照合が失敗した場合はM状態を変更しない", () => {
    const ledger = new MemoryUpdateLedger({
      database_path: databasePath,
      private_state_root: directory,
      j_approval_reader: { readVerifiedMemoryApproval: () => ({ update_id: "different" }) },
    });
    const result = ledger.apply(makeCommit("update-denied", [
      { operation: "upsert", record_id: "fact", value: "must not persist" },
    ]));
    expect(result).toEqual({ ok: false, reason: "j_approval_not_verified" });
    expect(ledger.snapshot()).toMatchObject({ revision: 0, records: {} });
    expect(ledger.receipt("update-denied")).toBeNull();
    expect(ledger.verify()).toBe(true);
    ledger.close();
  });

  it("M database pathが明示された私有状態root外なら開かない", () => {
    expect(() => new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: join(tmpdir(), "blue-tanuki-outside.sqlite"),
      j_approval_reader: approvingReader(),
    })).toThrow("invalid M database path");
  });

  it.each([
    ["m_events", "CREATE TRIGGER injected_failure BEFORE INSERT ON m_events BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    ["m_records_insert", "CREATE TRIGGER injected_failure BEFORE INSERT ON m_records BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    ["m_records_delete", "CREATE TRIGGER injected_failure BEFORE DELETE ON m_records BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    ["m_state", "CREATE TRIGGER injected_failure BEFORE UPDATE ON m_state BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    ["m_updates", "CREATE TRIGGER injected_failure BEFORE INSERT ON m_updates BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    ["m_receipts", "CREATE TRIGGER injected_failure BEFORE INSERT ON m_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END"],
  ])("%s書込み時の失敗は同じM取引を全てrollbackする", (point, triggerSql) => {
    const approvalReader = approvingReader();
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvalReader });
    const seeded = ledger.apply(makeCommit("seed", [
      { operation: "upsert", record_id: "keep", value: "before" },
      { operation: "upsert", record_id: "remove-me", value: "old" },
    ]));
    expect(seeded.ok).toBe(true);
    const before = ledger.snapshot();
    expect(before).not.toBeNull();

    const triggerConnection: DatabaseSyncType = new DatabaseSync(databasePath);
    triggerConnection.exec(triggerSql);
    triggerConnection.close();

    const faultChanges = point === "m_records_delete"
      ? [{ operation: "delete" as const, record_id: "remove-me" }]
      : point === "m_records_insert"
        ? [{ operation: "upsert" as const, record_id: "new", value: "new" }]
        : [
            { operation: "upsert" as const, record_id: "keep", value: "after" },
            { operation: "delete" as const, record_id: "remove-me" },
          ];
    const failed = ledger.apply(makeCommit("faulted", faultChanges));
    expect(failed).toEqual({ ok: false, reason: "storage_failed" });
    expect(ledger.snapshot()).toEqual(before);
    expect(ledger.receipt("faulted")).toBeNull();
    expect(ledger.verify()).toBe(true);
    ledger.close();
  });

  it("同じ更新IDの再利用は二重に反映しない", () => {
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvingReader() });
    const commit = makeCommit("update-once", [{ operation: "upsert", record_id: "fact", value: 1 }]);
    expect(ledger.apply(commit).ok).toBe(true);
    const before = ledger.snapshot();
    expect(ledger.apply(commit)).toEqual({ ok: false, reason: "update_id_already_consumed" });
    expect(ledger.snapshot()).toEqual(before);
    ledger.close();
  });
});

function makeCommit(
  updateId: string,
  changes: Array<
    | { readonly operation: "upsert"; readonly record_id: string; readonly value: unknown }
    | { readonly operation: "delete"; readonly record_id: string }
  >,
) {
  const content = {
    schema_version: MEMORY_COMMIT_SCHEMA_VERSION,
    update_id: updateId,
    j_event_id: `j-event-${updateId}`,
    changes,
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

function approvingReader() {
  const references: JMemoryApprovalReference[] = [];
  const reader: JMemoryApprovalReader = {
    readVerifiedMemoryApproval(reference) {
      references.push(reference);
      return {
        update_id: reference.update_id,
        j_event_id: reference.j_event_id,
        content_digest: reference.content_digest,
      };
    },
  };
  return Object.assign(reader, { references });
}
