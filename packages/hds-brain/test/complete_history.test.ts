import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompleteHistoryStore,
  completeHistoryEntryHash,
  decodeCompleteHistoryEntry,
  encodeCompleteHistoryEntry,
  sha256Hex,
  type CompleteHistoryEntry,
  type CompleteHistoryKind,
} from "../src/complete-history/index.js";

const ALL_KINDS: CompleteHistoryKind[] = [
  "user_input",
  "llm_history",
  "hds_decision",
  "approval_history",
  "execution_history",
  "audit_history",
  "final_output",
];

describe("CompleteHistoryStore in-memory", () => {
  it("captures all complete-history kinds as non-authority source records", () => {
    const store = new CompleteHistoryStore();

    for (const kind of ALL_KINDS) {
      const entry = store.append({
        kind,
        request_id: "r1",
        command_id: kind === "user_input" ? null : "cmd1",
        actor: "alice",
        source: "test",
        payload: { kind, content: `payload:${kind}` },
        timestamp: 1,
      });
      expect(entry?.kind).toBe(kind);
      expect(entry?.used_for_authority).toBe(false);
      expect(entry?.payload_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(entry?.entry_hash).toMatch(/^[a-f0-9]{64}$/);
    }

    expect(store.size()).toBe(ALL_KINDS.length);
    expect(store.verify()).toBe(true);
  });

  it("replays by request_id, command_id, and kind in insertion order", () => {
    const store = new CompleteHistoryStore();
    store.append({ kind: "user_input", request_id: "r1", payload: "first", timestamp: 1 });
    store.append({ kind: "final_output", request_id: "r1", command_id: "cmd1", payload: "answer", timestamp: 2 });
    store.append({ kind: "user_input", request_id: "r2", payload: "second", timestamp: 3 });

    expect(store.replay({ request_id: "r1" }).map((entry) => entry.kind)).toEqual(["user_input", "final_output"]);
    expect(store.replay({ command_id: "cmd1" }).map((entry) => entry.kind)).toEqual(["final_output"]);
    expect(store.replay({ kind: "user_input" }).map((entry) => entry.request_id)).toEqual(["r1", "r2"]);
  });

  it("exports a complete snapshot with chain status and non-authority invariant", () => {
    const store = new CompleteHistoryStore();
    store.append({ kind: "user_input", request_id: "r1", payload: "hello", timestamp: 1 });

    const snapshot = store.exportSnapshot({ exported_at: 2 });
    expect(snapshot.exported_at).toBe(2);
    expect(snapshot.entries_count).toBe(1);
    expect(snapshot.chain_valid).toBe(true);
    expect(snapshot.complete_history_used_for_authority).toBe(false);
    expect(JSON.parse(store.exportJson({ exported_at: 2 })).entries_count).toBe(1);
  });

  it("does not expose mutable internal records through replay", () => {
    const store = new CompleteHistoryStore();
    const entry = store.append({ kind: "user_input", request_id: "r1", payload: { text: "original" } });
    expect(entry).not.toBeNull();

    const all = store.replay() as Array<{ payload: unknown }>;
    all[0]!.payload = { text: "tampered" };

    expect(store.replay()[0]!.payload).toEqual({ text: "original" });
    expect(store.verify()).toBe(true);
  });

  it("blocks appends when max_entries is reached", () => {
    const store = new CompleteHistoryStore({ max_entries: 1 });
    expect(store.append({ kind: "user_input", payload: "one" })).not.toBeNull();
    expect(store.append({ kind: "user_input", payload: "two" })).toBeNull();
    expect(store.size()).toBe(1);
    expect(store.skippedCount()).toBe(1);
  });
});

describe("CompleteHistoryStore JSONL persistence", () => {
  let tmpDir: string;
  let filepath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "complete-history-test-"));
    filepath = join(tmpDir, "complete-history.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips entries through JSONL codec", () => {
    const store = new CompleteHistoryStore();
    const entry = store.append({ kind: "final_output", payload: { content: "done" }, timestamp: 1 });
    expect(entry).not.toBeNull();

    expect(decodeCompleteHistoryEntry(encodeCompleteHistoryEntry(entry!))).toEqual(entry);
    expect(() => decodeCompleteHistoryEntry("{not-json")).toThrow(/malformed complete history JSONL/);
    expect(() => decodeCompleteHistoryEntry("{}")).toThrow(/malformed complete history entry/);
  });

  it("rejects duplicate keys and non-finite values at the persisted JSONL boundary", () => {
    const source = new CompleteHistoryStore();
    const entry = source.append({ kind: "user_input", payload: { id: "original" }, timestamp: 1 });
    expect(entry).not.toBeNull();

    const encoded = encodeCompleteHistoryEntry(entry!);
    const duplicate = encoded.replace(
      '"payload":{"id":"original"}',
      '"payload":{"id":"original","id":"tampered"}',
    );
    const overflow = encoded.replace('"timestamp":1', '"timestamp":1e999');
    const nan = encoded.replace('"timestamp":1', '"timestamp":NaN');

    expect(duplicate).not.toBe(encoded);
    expect(() => decodeCompleteHistoryEntry(duplicate)).toThrow(/duplicate_key/);
    expect(() => decodeCompleteHistoryEntry(overflow)).toThrow(/non_finite_number/);
    expect(() => decodeCompleteHistoryEntry(nan)).toThrow(/invalid_json/);
  });

  it("BT-U-C01.01-P exposes legacy entries as read-only common records without payload authority", () => {
    const source = new CompleteHistoryStore();
    const payload = { approved: true, detail: "LEGACY_SECRET_SENTINEL" };
    const current = source.append({ kind: "approval_history", payload, timestamp: 7 });
    expect(current).not.toBeNull();

    const { entry_hash: _currentHash, ...currentBody } = current!;
    const legacyBody = {
      ...currentBody,
      schema_version: "legacy-complete-history.v0",
    } as unknown as Omit<CompleteHistoryEntry, "entry_hash">;
    const legacyEntry: CompleteHistoryEntry = {
      ...legacyBody,
      entry_hash: completeHistoryEntryHash(legacyBody),
    };
    writeFileSync(filepath, `${encodeCompleteHistoryEntry(legacyEntry)}\n`, "utf8");

    const store = new CompleteHistoryStore({ filepath });
    expect(store.verify()).toBe(true);
    expect(store.replay()[0]).toMatchObject({
      schema_version: "legacy-complete-history.v0",
      payload,
      used_for_authority: false,
    });

    const [projection] = store.replayAsCommonRecords();
    expect(projection).toMatchObject({
      read_only: true,
      used_for_authority: false,
      complete_history_used_for_authority: false,
      record: {
        record_id: legacyEntry.id,
        record_kind: "legacy_history",
        origin: { kind: "legacy_history" },
        state: {
          meaning: { assertion: "unknown", adoption: "archived" },
          execution: { operation: "unknown", work: "unknown", effect: "unknown" },
          evidence: { status: "undecided" },
        },
        content_digest: legacyEntry.payload_digest,
      },
    });
    expect(projection?.record).not.toHaveProperty("payload");
    expect(JSON.stringify(projection)).not.toContain("LEGACY_SECRET_SENTINEL");
    expect(JSON.stringify(projection)).not.toContain('"approved":true');
    expect(sha256Hex(store.replay()[0]?.payload)).toBe(legacyEntry.payload_digest);
  });

  it("loads existing entries and continues the chain", () => {
    const first = new CompleteHistoryStore({ filepath });
    first.append({ kind: "user_input", request_id: "r1", payload: "hello", timestamp: 1 });
    first.append({ kind: "hds_decision", request_id: "r1", payload: { decision: "ASSERT" }, timestamp: 2 });

    const reloaded = new CompleteHistoryStore({ filepath });
    expect(reloaded.size()).toBe(2);
    expect(reloaded.verify()).toBe(true);

    const added = reloaded.append({ kind: "final_output", request_id: "r1", payload: "done", timestamp: 3 });
    expect(added?.prev_hash).toBe(reloaded.replay()[1]!.entry_hash);

    const lines = readFileSync(filepath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(new CompleteHistoryStore({ filepath }).verify()).toBe(true);
  });

  it("throws on load when the persisted chain is broken", () => {
    const store = new CompleteHistoryStore({ filepath });
    store.append({ kind: "user_input", request_id: "r1", payload: "hello", timestamp: 1 });
    store.append({ kind: "final_output", request_id: "r1", payload: "done", timestamp: 2 });

    const lines = readFileSync(filepath, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.payload = "tampered";
    writeFileSync(filepath, [JSON.stringify(first), lines[1]].join("\n") + "\n");

    expect(() => new CompleteHistoryStore({ filepath })).toThrow(/chain verification failed/);
  });
});
