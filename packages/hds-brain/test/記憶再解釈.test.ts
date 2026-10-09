import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION,
  memoryCommitContentDigest,
  type MemoryCommitJsonValue,
  type MemoryCommitV2,
} from "@blue-tanuki/protocol";
import { JMemoryCommitCoordinator } from "../src/制御状態.js";
import {
  MemoryInterpretationConsumer,
  buildMemoryInterpretationCommit,
  createInitialMemoryInterpretationRecord,
  interpretationContentDigest,
  memoryInterpretationRecordId,
  parseMemoryInterpretationRecord,
  type MemoryInterpretationTransition,
} from "../src/記憶再解釈.js";
import type { JMemoryApprovalReader } from "../src/保存取引.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let coordinators: JMemoryCommitCoordinator[] = [];

describe("追記型記憶再解釈consumer", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "blue-tanuki-memory-reinterpretation-"));
    databasePath = join(directory, "canonical.sqlite");
    coordinators = [];
  });

  afterEach(() => {
    for (const coordinator of coordinators) coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("BT-U-C07.03-P 汚染を隔離し再open後に新解釈を追加して過去判断へ影響を返す", () => {
    const approvalReader = approvingReader();
    let coordinator = createCoordinator(approvalReader, directory, databasePath);
    const consumer = new MemoryInterpretationConsumer(coordinator);
    const initial = createInitialMemoryInterpretationRecord({
      lineage_id: "lineage:test-policy",
      interpretation: {
        interpretation_id: "interpretation:v1",
        basis_ref: "source:policy-v1",
        meaning: { statement: "The service permits guest access.", review_state: "accepted" },
        content_digest: interpretationContentDigest({ statement: "The service permits guest access.", review_state: "accepted" }),
      },
      dependent_judgment_refs: ["judgment:trip-001", "judgment:trip-002"],
    });
    expect(initial).not.toBeNull();
    if (!initial) return;
    expect(parseMemoryInterpretationRecord(initial)).toEqual(initial);
    expect(applyCommitThroughJ(coordinator, makeCommit("seed-lineage", "j-seed-lineage", 0, [
      { operation: "upsert", record_id: memoryInterpretationRecordId(initial.lineage_id), value: asJsonValue(initial) },
    ]))).toMatchObject({ ok: true, status: "ready" });

    const current = consumer.read("lineage:test-policy");
    expect(current?.record).toEqual(initial);
    expect(current?.used_for_authority).toBe(false);
    if (!current) return;
    const quarantine = buildMemoryInterpretationCommit({
      current,
      lineage_id: initial.lineage_id,
      update_id: "quarantine-v1",
      j_event_id: "j-quarantine-v1",
      transition: {
        kind: "quarantine",
        event_id: "event-quarantine-v1",
        reason_digest: digest("counterevidence invalidated v1"),
        evidence_refs: [{ reference: "evidence:counterexample-1", digest: digest("counterexample") }],
        affected_judgment_refs: ["judgment:trip-001", "judgment:trip-002"],
      },
    });
    expect(quarantine.ok).toBe(true);
    if (!quarantine.ok) return;
    const quarantined = consumer.apply(quarantine.commit);
    expect(quarantined.ok).toBe(true);
    if (!quarantined.ok) return;
    expect(quarantined.record).toMatchObject({
      application_state: "quarantined",
      current_interpretation_id: null,
      interpretations: [initial.interpretations[0]],
      events: [{ kind: "quarantined", prior_interpretation_id: "interpretation:v1", resulting_interpretation_id: null }],
      dependent_judgments: [
        { judgment_ref: "judgment:trip-001", basis_interpretation_id: "interpretation:v1", reassessment_required: true },
        { judgment_ref: "judgment:trip-002", basis_interpretation_id: "interpretation:v1", reassessment_required: true },
      ],
      used_for_authority: false,
      may_execute: false,
    });
    expect(coordinator.snapshot()?.lifecycle_state).toBe("effect_confirmed");
    const countsAfterQuarantine = readCounts(databasePath);
    expect(consumer.apply(quarantine.commit)).toMatchObject({ ok: true });
    expect(readCounts(databasePath)).toEqual(countsAfterQuarantine);
    coordinator.close();

    coordinator = createCoordinator(approvalReader, directory, databasePath);
    const reopenedConsumer = new MemoryInterpretationConsumer(coordinator);
    const afterReopen = reopenedConsumer.read("lineage:test-policy");
    expect(afterReopen?.record).toEqual(quarantined.record);
    expect(afterReopen?.revision).toBe(2);
    if (!afterReopen?.record) return;

    const restoration: MemoryInterpretationTransition = {
      kind: "restore",
      event_id: "event-restore-v2",
      reason_digest: digest("independent reevaluation supports v2"),
      evidence_refs: [{ reference: "evidence:verified-policy-v2", digest: digest("verified v2") }],
      interpretation: {
        interpretation_id: "interpretation:v2",
        basis_ref: "source:verified-v2",
        meaning: { statement: "Guest access is disabled after verification.", review_state: "verified" },
        content_digest: interpretationContentDigest({ statement: "Guest access is disabled after verification.", review_state: "verified" }),
      },
    };
    const restore = buildMemoryInterpretationCommit({
      current: afterReopen,
      lineage_id: initial.lineage_id,
      update_id: "restore-v2",
      j_event_id: "j-restore-v2",
      transition: restoration,
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) return;
    const restored = reopenedConsumer.apply(restore.commit);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.record).toMatchObject({
      application_state: "active",
      current_interpretation_id: "interpretation:v2",
      interpretations: [
        { interpretation_id: "interpretation:v1", basis_ref: "source:policy-v1", meaning: { statement: "The service permits guest access.", review_state: "accepted" } },
        { interpretation_id: "interpretation:v2", basis_ref: "source:verified-v2", meaning: { statement: "Guest access is disabled after verification.", review_state: "verified" } },
      ],
      events: [
        { event_id: "event-quarantine-v1", kind: "quarantined", prior_interpretation_id: "interpretation:v1" },
        { event_id: "event-restore-v2", kind: "restored", prior_interpretation_id: "interpretation:v1", resulting_interpretation_id: "interpretation:v2" },
      ],
      dependent_judgments: [
        { judgment_ref: "judgment:trip-001", basis_interpretation_id: "interpretation:v1", reassessment_required: true },
        { judgment_ref: "judgment:trip-002", basis_interpretation_id: "interpretation:v1", reassessment_required: true },
      ],
      used_for_authority: false,
      may_execute: false,
    });
    expect(restored.record.interpretations[0]?.content_digest).toBe(initial.interpretations[0]?.content_digest);
    expect(restored.record.interpretations[0]?.meaning).toEqual(initial.interpretations[0]?.meaning);
    expect(coordinator.snapshot()?.lifecycle_state).toBe("effect_confirmed");
    expect(coordinator.verify()).toBe(true);

    const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count).toBe(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM m_receipts").get()?.count).toBe(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count).toBe(6);
    const jPayloads = database.prepare("SELECT event_payload_json FROM j_events").all();
    expect(JSON.stringify(jPayloads)).not.toContain("The service permits guest access.");
    expect(JSON.stringify(jPayloads)).not.toContain("Guest access is disabled after verification.");
    database.close();
  });

  it("BT-U-C07.03-N 旧解釈の消去とauthority昇格をJ/M書込み前に拒否する", () => {
    const coordinator = createCoordinator(approvingReader(), directory, databasePath);
    const consumer = new MemoryInterpretationConsumer(coordinator);
    const initial = createInitialMemoryInterpretationRecord({
      lineage_id: "lineage:guarded-memory",
      interpretation: {
        interpretation_id: "interpretation:old",
        basis_ref: "source:old-basis",
        meaning: { statement: "Keep this historical basis.", status: "old" },
        content_digest: interpretationContentDigest({ statement: "Keep this historical basis.", status: "old" }),
      },
      dependent_judgment_refs: ["judgment:old-result"],
    });
    expect(initial).not.toBeNull();
    if (!initial) return;
    expect(parseMemoryInterpretationRecord(initial)).toEqual(initial);
    expect(applyCommitThroughJ(coordinator, makeCommit("seed-guarded", "j-seed-guarded", 0, [
      { operation: "upsert", record_id: memoryInterpretationRecordId(initial.lineage_id), value: asJsonValue(initial) },
    ]))).toMatchObject({ ok: true, status: "ready" });
    const current = consumer.read(initial.lineage_id);
    expect(current?.record).toEqual(initial);
    if (!current) return;
    const valid = buildMemoryInterpretationCommit({
      current,
      lineage_id: initial.lineage_id,
      update_id: "attempted-quarantine",
      j_event_id: "j-attempted-quarantine",
      transition: {
        kind: "quarantine",
        event_id: "event-attempted-quarantine",
        reason_digest: digest("contamination report"),
        evidence_refs: [{ reference: "evidence:reported-problem", digest: digest("problem evidence") }],
        affected_judgment_refs: ["judgment:old-result"],
      },
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const snapshotBefore = coordinator.snapshot();
    const databaseBefore = readCounts(databasePath);
    const proposedRecord = valid.record as unknown as Record<string, unknown>;

    const erasedHistory = {
      ...valid.record,
      interpretations: [],
    };
    const erasedCommit = makeCommit("attempted-quarantine-erased", "j-attempted-quarantine-erased", 1, [
      { operation: "upsert", record_id: valid.record_id, value: asJsonValue(erasedHistory) },
    ]);
    expect(consumer.apply(erasedCommit)).toMatchObject({ ok: false, stage: "validation", reason: "invalid_transition" });

    const elevatedRecord = { ...proposedRecord, used_for_authority: true };
    const elevatedCommit = makeCommit("attempted-quarantine-elevated", "j-attempted-quarantine-elevated", 1, [
      { operation: "upsert", record_id: valid.record_id, value: asJsonValue(elevatedRecord) },
    ]);
    expect(consumer.apply(elevatedCommit)).toMatchObject({ ok: false, stage: "validation", reason: "invalid_transition" });

    expect(coordinator.snapshot()).toEqual(snapshotBefore);
    expect(readCounts(databasePath)).toEqual(databaseBefore);
    expect(coordinator.readMemoryRecord(valid.record_id)).toMatchObject({
      revision: 1,
      exists: true,
      value: initial,
      used_for_authority: false,
    });
    expect(coordinator.verify()).toBe(true);
  });
});

function createCoordinator(
  reader: JMemoryApprovalReader,
  privateStateRoot: string,
  dbPath: string,
): JMemoryCommitCoordinator {
  const coordinator = new JMemoryCommitCoordinator({
    private_state_root: privateStateRoot,
    database_path: dbPath,
    j_approval_reader: reader,
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  coordinators.push(coordinator);
  return coordinator;
}

function approvingReader(): JMemoryApprovalReader {
  return { readVerifiedMemoryApproval: (reference) => ({ ...reference }) };
}

function makeCommit(
  updateId: string,
  jEventId: string,
  expectedVersion: number,
  changes: MemoryCommitV2["changes"],
) {
  const content = {
    schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION,
    expected_version: expectedVersion,
    update_id: updateId,
    j_event_id: jEventId,
    changes,
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

function applyCommitThroughJ(
  coordinator: JMemoryCommitCoordinator,
  commit: ReturnType<typeof makeCommit>,
) {
  const staged = coordinator.stage(commit);
  if (!staged.ok) return staged;
  const applied = coordinator.apply(commit);
  if (!applied.ok) return applied;
  return coordinator.reconcile(commit.update_id);
}

function asJsonValue(value: unknown): MemoryCommitJsonValue {
  return JSON.parse(JSON.stringify(value)) as MemoryCommitJsonValue;
}

function readCounts(path: string): { readonly mEvents: number; readonly mReceipts: number; readonly jEvents: number } {
  const database: InstanceType<typeof DatabaseSync> = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      mEvents: Number(database.prepare("SELECT COUNT(*) AS count FROM m_events").get()?.count),
      mReceipts: Number(database.prepare("SELECT COUNT(*) AS count FROM m_receipts").get()?.count),
      jEvents: Number(database.prepare("SELECT COUNT(*) AS count FROM j_events").get()?.count),
    };
  } finally {
    database.close();
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
