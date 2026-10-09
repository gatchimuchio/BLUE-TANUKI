import { describe, expect, it } from "vitest";
import {
  MEMORY_COMMIT_SCHEMA_VERSION,
  MEMORY_COMMIT_V1_SCHEMA_VERSION,
  MEANING_UPDATE_PROPOSAL_SCHEMA_VERSION,
  OBSERVATION_ACQUISITION_SCHEMA_VERSION,
  MEMORY_UPDATE_RECEIPT_SCHEMA_VERSION,
  createMemoryUpdateReceipt,
  memoryCommitContentDigest,
  parseMeaningUpdateProposal,
  parseObservationAcquisitionRecord,
  parseMemoryCommit,
  parseMemoryCommitV2,
  parseMemoryUpdateReceipt,
} from "../src/状態更新契約.js";

function validObservationAcquisitionRecord() {
  return {
    schema_version: OBSERVATION_ACQUISITION_SCHEMA_VERSION,
    record_type: "observation_acquisition" as const,
    record_id: "observation:0123456789abcdef",
    request_id: "request-001",
    source_channel: "webchat",
    actor_digest: "a".repeat(64),
    acquired_at: 1,
    content_digest: "b".repeat(64),
    content_chars: 12,
    metadata_key_count: 0,
    reply_to_present: false,
    boundary_status: "canonical" as const,
    semantic_status: "unassessed" as const,
    adoption_status: "not_adopted" as const,
    used_as_world_truth: false as const,
    used_for_authority: false as const,
  };
}

function validMeaningUpdateProposal() {
  return {
    schema_version: MEANING_UPDATE_PROPOSAL_SCHEMA_VERSION,
    record_type: "meaning_update_proposal" as const,
    proposal_ref: "proposal-001",
    candidate_ref: "candidate:001",
    candidate_digest: "c".repeat(64),
    target_ref: "memory:fact-001",
    prior_version_ref: "version:4",
    supporting_evidence: [{ reference: "evidence:support-001", digest: "d".repeat(64) }],
    counterevidence_review: {
      status: "reviewed_with_references" as const,
      review_scope: { reference: "scope:counterevidence-001", digest: "e".repeat(64) },
      references: [{ reference: "evidence:counter-001", digest: "f".repeat(64) }],
    },
    applicability_scope: { reference: "scope:applicability-001", digest: "1".repeat(64) },
    reflection_target_ref: "reflection:goal-001",
    proposal_status: "unverified" as const,
    adoption_status: "not_adopted" as const,
    may_apply: false as const,
    used_for_authority: false as const,
  };
}

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
  it("受領した一次記録を未評価・未採用で固定する", () => {
    const record = validObservationAcquisitionRecord();
    expect(parseObservationAcquisitionRecord(record)).toMatchObject({ ok: true });
    expect(parseObservationAcquisitionRecord({ ...record, used_as_world_truth: true }).ok).toBe(false);
    expect(parseObservationAcquisitionRecord({ ...record, adoption_status: "adopted" }).ok).toBe(false);
    expect(parseObservationAcquisitionRecord({ ...record, raw_content: "do not persist" }).ok).toBe(false);
  });

  it("根拠・反証・範囲・旧版・反映先を持つ意味更新案だけを非採用提案として解析する", () => {
    const proposal = validMeaningUpdateProposal();
    expect(parseMeaningUpdateProposal(proposal)).toMatchObject({ ok: true });
    expect(parseMeaningUpdateProposal({ ...proposal, counterevidence_review: {
      status: "reviewed_with_references",
      review_scope: proposal.counterevidence_review.review_scope,
      references: [],
    } }).ok).toBe(false);
    expect(parseMeaningUpdateProposal({ ...proposal, may_apply: true }).ok).toBe(false);
    expect(parseMeaningUpdateProposal({ ...proposal, raw_candidate_text: "private claim" }).ok).toBe(false);
  });

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
