import { describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  MEMORY_COMMIT_V1_SCHEMA_VERSION,
  MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION,
  createMemoryUpdateReceipt,
  memoryCommitContentDigest,
  parseMemoryCommit,
  parseMemoryCommitV2,
  parseMemoryUpdateReceipt,
} from "../src/状態更新契約.js";

function validCommit() {
  const content = {
    schema_version: MEMORY_COMMIT_SCHEMA_VERSION,
    expected_version: 0,
    update_id: "update-001",
    j_event_id: "j-event-001",
    changes: [
      { operation: "upsert" as const, record_id: "fact-001", value: { z: 2, a: ["safe", true] } },
      { operation: "delete" as const, record_id: "fact-old" },
    ],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

function validReceipt() {
  return createMemoryUpdateReceipt({
    schema_version: MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION,
    update_id: "update-001",
    event_id: "m-event-001",
    previous_revision: 0,
    revision: 1,
    content_digest: "a".repeat(64),
    event_digest: "b".repeat(64),
    committed_at_utc: "2026-10-09T00:00:00.000Z",
  });
}

describe("状態更新契約", () => {
  it("canonical digestで内容を検査し、正常なMemoryCommitを解析する", () => {
    const commit = validCommit();
    const parsed = parseMemoryCommit(commit);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.content_digest).toBe(commit.content_digest);
    expect(parsed.canonical_content_json).toContain('"record_id":"fact-001"');
    expect(parsed.canonical_content_json.indexOf('"a"')).toBeLessThan(
      parsed.canonical_content_json.indexOf('"z"'),
    );
    const otherVersion = {
      schema_version: commit.schema_version,
      expected_version: 1,
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      changes: commit.changes,
    };
    expect(memoryCommitContentDigest(otherVersion)).not.toBe(commit.content_digest);
  });

  it("V1履歴を読めるが新規書込み契約V2では受け付けない", () => {
    const content = {
      schema_version: MEMORY_COMMIT_V1_SCHEMA_VERSION,
      update_id: "legacy-update",
      j_event_id: "legacy-j-event",
      changes: [{ operation: "upsert" as const, record_id: "legacy-fact", value: 1 }],
    };
    const legacy = { ...content, content_digest: memoryCommitContentDigest(content) };
    expect(parseMemoryCommit(legacy).ok).toBe(true);
    expect(parseMemoryCommitV2(legacy)).toEqual({ ok: false, reason: "schema_validation_failed" });
  });

  it("unknown fieldと同一recordへの重複変更を拒否する", () => {
    const commit = validCommit();
    expect(parseMemoryCommit({ ...commit, approved: true })).toEqual({
      ok: false,
      reason: "schema_validation_failed",
    });

    const duplicateContent = {
      schema_version: commit.schema_version,
      expected_version: commit.expected_version,
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      changes: [
        { operation: "delete" as const, record_id: "same" },
        { operation: "upsert" as const, record_id: "same", value: 1 },
      ],
    };
    expect(parseMemoryCommit({ ...duplicateContent, content_digest: "a".repeat(64) })).toEqual({
      ok: false,
      reason: "duplicate_record_id",
    });
    expect(() => memoryCommitContentDigest(duplicateContent)).toThrow("invalid memory commit content");
  });

  it("拒否理由を一定に保ち、危険なJSON keyと不正digestを拒否する", () => {
    const commit = validCommit();
    const dangerous = {
      schema_version: commit.schema_version,
      expected_version: commit.expected_version,
      update_id: commit.update_id,
      j_event_id: commit.j_event_id,
      changes: [
        { operation: "upsert", record_id: "fact-001", value: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') },
      ],
    };
    expect(parseMemoryCommit({
      ...dangerous,
      content_digest: "c".repeat(64),
    })).toEqual({ ok: false, reason: "invalid_json_value" });
    expect(parseMemoryCommit({ ...commit, content_digest: "0".repeat(64) })).toEqual({
      ok: false,
      reason: "content_digest_mismatch",
    });
  });

  it("循環・深すぎる・上限超過のraw valueをschema parserより先に拒否する", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(parseMemoryCommit({
      ...validCommit(),
      changes: [{ operation: "upsert", record_id: "cycle", value: cycle }],
    })).toEqual({ ok: false, reason: "invalid_json_value" });

    let deep: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    expect(parseMemoryCommit({
      ...validCommit(),
      changes: [{ operation: "upsert", record_id: "deep", value: deep }],
    })).toEqual({ ok: false, reason: "payload_too_deep" });

    expect(parseMemoryCommit({
      ...validCommit(),
      changes: [{ operation: "upsert", record_id: "large", value: "x".repeat(1_100_000) }],
    })).toEqual({ ok: false, reason: "payload_too_large" });
  });

  it("一つ進んだrevisionのreceiptを構成・検査し、改変を拒否する", () => {
    const receipt = validReceipt();
    expect(parseMemoryUpdateReceipt(receipt)).toEqual({ ok: true, receipt });
    expect(() => createMemoryUpdateReceipt({ ...receipt, revision: 2 })).toThrow(
      "invalid memory update receipt",
    );
    expect(parseMemoryUpdateReceipt({ ...receipt, update_id: "different" })).toEqual({
      ok: false,
      reason: "receipt_digest_mismatch",
    });
    expect(parseMemoryUpdateReceipt({ ...receipt, unreviewed: true })).toEqual({
      ok: false,
      reason: "schema_validation_failed",
    });
  });
});
