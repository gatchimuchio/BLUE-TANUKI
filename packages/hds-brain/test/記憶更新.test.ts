import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  MEMORY_COMMIT_V1_SCHEMA_VERSION,
  MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION,
  createMemoryUpdateReceipt,
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
    ], 1));
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
    const failed = ledger.apply(makeCommit("faulted", faultChanges, 1));
    expect(failed).toEqual({ ok: false, reason: "storage_failed" });
    expect(ledger.snapshot()).toEqual(before);
    expect(ledger.receipt("faulted")).toBeNull();
    expect(ledger.verify()).toBe(true);
    ledger.close();
  });

  it("同じ承認内容の再送は保存済みreceiptを返し、異内容の同一IDを拒否する", () => {
    const reader = approvingReader();
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: reader });
    const commit = makeCommit("update-once", [{ operation: "upsert", record_id: "fact", value: 1 }]);
    const first = ledger.apply(commit);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = ledger.snapshot();
    expect(ledger.apply(commit)).toEqual(first);
    expect(ledger.snapshot()).toEqual(before);
    const secondHandle = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: reader });
    expect(secondHandle.apply(commit)).toEqual(first);
    expect(secondHandle.snapshot()).toEqual(before);
    expect(secondHandle.apply(makeCommit("update-once", [
      { operation: "upsert", record_id: "fact", value: 2 },
    ]))).toEqual({ ok: false, reason: "update_id_content_conflict" });
    expect(secondHandle.apply(makeCommit("update-once", [
      { operation: "upsert", record_id: "fact", value: 1 },
    ], 1))).toEqual({ ok: false, reason: "update_id_content_conflict" });
    expect(secondHandle.snapshot()).toEqual(before);
    expect(secondHandle.receipt("update-once")).toEqual(first.receipt);
    secondHandle.close();
    ledger.close();
  });

  it("未使用IDの古い期待版を拒否し、M状態とreceiptを変更しない", () => {
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvingReader() });
    expect(ledger.apply(makeCommit("current", [{ operation: "upsert", record_id: "fact", value: 1 }])).ok).toBe(true);
    const before = ledger.snapshot();
    expect(ledger.apply(makeCommit("stale", [{ operation: "upsert", record_id: "fact", value: 2 }], 0))).toEqual({
      ok: false,
      reason: "expected_version_conflict",
    });
    expect(ledger.snapshot()).toEqual(before);
    expect(ledger.receipt("stale")).toBeNull();
    expect(ledger.verify()).toBe(true);
    ledger.close();
  });

  it("再送時もJの承認参照を再照合し、不一致なら保存済みreceiptを返さない", () => {
    const ledger = new MemoryUpdateLedger({ private_state_root: directory, database_path: databasePath, j_approval_reader: approvingReader() });
    const commit = makeCommit("retry-approval", [{ operation: "upsert", record_id: "fact", value: 1 }]);
    const first = ledger.apply(commit);
    expect(first.ok).toBe(true);
    const before = ledger.snapshot();
    ledger.close();

    const retry = new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: { readVerifiedMemoryApproval: () => ({ update_id: "different" }) },
    });
    expect(retry.apply(commit)).toEqual({ ok: false, reason: "j_approval_not_verified" });
    expect(retry.snapshot()).toEqual(before);
    expect(retry.verify()).toBe(true);
    retry.close();
  });

  it("既存V1 event履歴を検証・再生し、その後V2 eventを追記できる", () => {
    const empty = new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    empty.close();

    const legacyContent = {
      schema_version: MEMORY_COMMIT_V1_SCHEMA_VERSION,
      update_id: "legacy-update",
      j_event_id: "legacy-j-event",
      changes: [{ operation: "upsert" as const, record_id: "legacy-fact", value: { count: 1 } }],
    };
    const contentDigest = memoryCommitContentDigest(legacyContent);
    const committedAt = "2026-10-09T00:00:00.000Z";
    const eventBody = {
      schema_version: "blue-tanuki.memory-event.v1",
      event_id: "legacy-m-event",
      revision: 1,
      previous_event_digest: "GENESIS",
      update_id: legacyContent.update_id,
      j_event_id: legacyContent.j_event_id,
      content_digest: contentDigest,
      changes: legacyContent.changes,
      committed_at_utc: committedAt,
    };
    const eventDigest = sha256(canonicalJson(eventBody));
    const receipt = createMemoryUpdateReceipt({
      schema_version: MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION,
      update_id: legacyContent.update_id,
      event_id: eventBody.event_id,
      previous_revision: 0,
      revision: 1,
      content_digest: contentDigest,
      event_digest: eventDigest,
      committed_at_utc: committedAt,
    });
    const connection: DatabaseSyncType = new DatabaseSync(databasePath);
    connection.exec("BEGIN IMMEDIATE");
    connection.prepare(
      "INSERT INTO m_events (event_id, revision, previous_event_digest, event_digest, event_payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(eventBody.event_id, 1, "GENESIS", eventDigest, canonicalJson({ ...eventBody, event_digest: eventDigest }));
    connection.prepare("INSERT INTO m_records (record_id, value_json) VALUES (?, ?)")
      .run("legacy-fact", canonicalJson({ count: 1 }));
    connection.prepare("UPDATE m_state SET revision = 1, event_digest = ? WHERE singleton = 1").run(eventDigest);
    connection.prepare(
      "INSERT INTO m_updates (update_id, content_digest, revision, event_id) VALUES (?, ?, 1, ?)",
    ).run(legacyContent.update_id, contentDigest, eventBody.event_id);
    connection.prepare("INSERT INTO m_receipts (update_id, receipt_json) VALUES (?, ?)")
      .run(legacyContent.update_id, canonicalJson(receipt));
    connection.exec("COMMIT");
    connection.close();

    const reopened = new MemoryUpdateLedger({
      private_state_root: directory,
      database_path: databasePath,
      j_approval_reader: approvingReader(),
    });
    expect(reopened.verify()).toBe(true);
    expect(reopened.snapshot()).toMatchObject({ revision: 1, records: { "legacy-fact": { count: 1 } } });
    expect(reopened.apply(makeCommit("after-legacy", [
      { operation: "upsert", record_id: "current-fact", value: 2 },
    ], 1)).ok).toBe(true);
    expect(reopened.verify()).toBe(true);
    expect(reopened.snapshot()).toMatchObject({ revision: 2, records: { "legacy-fact": { count: 1 }, "current-fact": 2 } });
    reopened.close();
  });
});

function makeCommit(
  updateId: string,
  changes: Array<
    | { readonly operation: "upsert"; readonly record_id: string; readonly value: unknown }
    | { readonly operation: "delete"; readonly record_id: string }
  >,
  expectedVersion = 0,
) {
  const content = {
    schema_version: MEMORY_COMMIT_SCHEMA_VERSION,
    expected_version: expectedVersion,
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid canonical JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
