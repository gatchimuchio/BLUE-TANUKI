import { describe, expect, it } from "vitest";
import {
  COMMON_RECORD_SCHEMA_VERSION,
  parseCommonRecordAtBoundary,
} from "../src/index.js";

function validRecord() {
  return {
    record_id: "opaque:record/001",
    record_kind: "observation",
    schema_version: COMMON_RECORD_SCHEMA_VERSION,
    task_id: "task-ref-1",
    run_id: "run-ref-1",
    owner_id: "owner-ref-1",
    origin: { kind: "environment_observation", source_ref: "environment-ref-1" },
    observed_at: 1_760_000_000_000,
    recorded_at: 1_760_000_000_001,
    effective_from: 1_760_000_000_000,
    source_refs: ["source-ref-1"],
    previous_refs: ["previous-ref-1"],
    state: {
      meaning: { assertion: "assertion_pending", adoption: "proposed" },
      execution: { operation: "request_observation", work: "waiting_observation", effect: "outcome_unknown" },
      evidence: { status: "undecided" },
    },
    unknowns: ["観測範囲外の意味は未確認"],
    residual_refs: ["residual-ref-1"],
    classification: "test_fixture",
    content_ref: "content-ref-1",
    content_digest: "a".repeat(64),
  };
}

describe("BT-U-C01.01-P common record boundary", () => {
  it("parses JSON and retains opaque references and independent state axes", () => {
    const result = parseCommonRecordAtBoundary(JSON.stringify(validRecord()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.record_id).toBe("opaque:record/001");
    expect(result.record.source_refs).toEqual(["source-ref-1"]);
    expect(result.record.previous_refs).toEqual(["previous-ref-1"]);
    expect(result.record.schema_version).toBe(COMMON_RECORD_SCHEMA_VERSION);
    expect(result.record.state.meaning.assertion).toBe("assertion_pending");
    expect(result.record.state.execution.work).toBe("waiting_observation");
    expect(result.record.state.execution.effect).toBe("outcome_unknown");
    expect(result.record.state.evidence.status).toBe("undecided");
    expect(result.record.content_digest).toBe("a".repeat(64));
  });
});

describe("BT-U-C01.01-N common record boundary", () => {
  it("rejects unknown authority-shaped fields without echoing their values", () => {
    const input = { ...validRecord(), approval: { approved: true, token: "SECRET_SENTINEL" } };
    const result = parseCommonRecordAtBoundary(JSON.stringify(input));

    expect(result).toMatchObject({ ok: false, reason: "schema_validation_failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  });

  it("rejects an overlong opaque record identifier", () => {
    const result = parseCommonRecordAtBoundary(JSON.stringify({
      ...validRecord(),
      record_id: "x".repeat(201),
    }));

    expect(result).toMatchObject({ ok: false, reason: "schema_validation_failed" });
  });

  it("rejects decoded duplicate keys at nested JSON boundaries", () => {
    const text = JSON.stringify(validRecord()).replace(
      '"kind":"environment_observation"',
      '"kind":"environment_observation","\\u006bind":"legacy_history"',
    );
    const result = parseCommonRecordAtBoundary(text);

    expect(result).toEqual({ ok: false, reason: "duplicate_key" });
  });

  it("rejects NaN syntax and a JSON number that overflows to a non-finite value", () => {
    const valid = JSON.stringify(validRecord());
    const nan = valid.replace('"recorded_at":1760000000001', '"recorded_at":NaN');
    const overflow = valid.replace('"recorded_at":1760000000001', '"recorded_at":1e999');

    expect(parseCommonRecordAtBoundary(nan)).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseCommonRecordAtBoundary(overflow)).toEqual({ ok: false, reason: "non_finite_number" });
  });

  it("rejects a content reference without its digest", () => {
    const { content_digest: _contentDigest, ...incomplete } = validRecord();
    const result = parseCommonRecordAtBoundary(JSON.stringify(incomplete));

    expect(result).toMatchObject({ ok: false, reason: "schema_validation_failed" });
  });
});
