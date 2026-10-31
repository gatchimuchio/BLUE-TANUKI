import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest, fileWritePayloadDigest, fileWriteTargetIdentityDigest,
  OperationPlanExternalReceiptObservationSchema } from "@blue-tanuki/protocol";
import { ingestLocalFileWriteStateObservation, ingestLocalInspectionReceipt,
  type ExternalReceiptObservationSink, type LocalInspectionReceiptInput } from "../src/external_receipt_observation.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const commandId = "command-fixture-1";
const commandKey = digest(JSON.stringify(["gateway-executor-command.v1", commandId]));
const expected = {
  caller: createGatewayInternalInboundRequest({ id: "request-1", channel: "webchat", user: "owner", timestamp: Date.now(),
    content: "fixture", metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
      "blue_tanuki.operator_surface": "developer" } }),
  command_id: commandId,
  command_digest: "a".repeat(64),
  executor_command_digest: "b".repeat(64),
  plan_id_digest: "c".repeat(64),
  revision_digest: "d".repeat(64),
  step_id_digest: "e".repeat(64),
  request_payload_digest: "f".repeat(64),
  observed_at_ms: Date.now(),
} satisfies Omit<LocalInspectionReceiptInput, "response">;

function sink(): { target: ExternalReceiptObservationSink; records: unknown[] } {
  const records: unknown[] = [];
  return { records, target: { recordOperationPlanExternalReceiptObservation(value) { records.push(value); return true; } } };
}

function response(overrides: Partial<{ status: string; idempotency_key: string; command_digest: string; payload_digest: string }> = {}) {
  return { status: "accepted", matches: [{ idempotency_key: commandKey, command_digest: expected.executor_command_digest,
    payload_digest: expected.request_payload_digest, receipt_id: "local-inspection-receipt" }], ...overrides };
}

describe("local receipt observation ingestion", () => {
  it("records a single exact match as digest-only non-authority evidence", () => {
    const store = sink();
    const observation = ingestLocalInspectionReceipt(store.target, { ...expected, response: response() });
    expect(observation).toMatchObject({ source: "local_inspection", status: "matched", match_count: 1,
      command_digest: expected.command_digest, executor_command_digest: expected.executor_command_digest,
      request_payload_digest: expected.request_payload_digest, observed_payload_digest: expected.request_payload_digest,
      used_for_authority: false, raw_receipt_exposed: false });
    expect(JSON.stringify(observation)).not.toContain("local-inspection-receipt");
    expect(store.records).toHaveLength(1);
  });

  it.each([
    ["command key", { idempotency_key: "8".repeat(64) }],
    ["Executor command", { command_digest: "9".repeat(64) }],
    ["request payload", { payload_digest: "7".repeat(64) }],
  ])("records a %s digest mismatch without treating it as success", (_name, mismatch) => {
    const store = sink();
    const observation = ingestLocalInspectionReceipt(store.target, { ...expected,
      response: { status: "accepted", matches: [{ idempotency_key: commandKey,
        command_digest: expected.executor_command_digest, payload_digest: expected.request_payload_digest,
        receipt_id: "mismatched", ...mismatch }] } });
    expect(observation).toMatchObject({ status: "mismatch", match_count: 1,
      used_for_authority: false, raw_receipt_exposed: false });
  });

  it("preserves not-found and ambiguous as distinct observations", () => {
    const noMatch = sink();
    expect(ingestLocalInspectionReceipt(noMatch.target, { ...expected,
      response: { status: "not_found", matches: [] } })).toMatchObject({ status: "not_found", match_count: 0 });

    const multiple = sink();
    const first = response().matches[0]!;
    const ambiguous = ingestLocalInspectionReceipt(multiple.target, { ...expected, response: {
      status: "ambiguous", matches: [first, { ...first, receipt_id: "second-receipt" }],
    } });
    expect(ambiguous).toMatchObject({ status: "ambiguous", match_count: 2 });
    expect(ambiguous).not.toHaveProperty("receipt_digest");
    expect(() => OperationPlanExternalReceiptObservationSchema.parse({ ...ambiguous,
      receipt_digest: "a".repeat(64) })).toThrow();
  });

  it("rejects inconsistent or content-bearing response shapes before J receives them", () => {
    const store = sink();
    expect(() => ingestLocalInspectionReceipt(store.target, { ...expected,
      response: { status: "accepted", matches: [], raw: "SECRET" } })).toThrow(/response_invalid/);
    expect(store.records).toHaveLength(0);
  });

  it("records create-only file state by digest without claiming command receipt or exposing content", () => {
    const store = sink();
    const content = "synthetic file result\n";
    const parameters = { path: "notes.txt", content, mode: "create" };
    const target_identity_digest = fileWriteTargetIdentityDigest(parameters.path);
    const observation = ingestLocalFileWriteStateObservation(store.target, { ...expected,
      parameters, request_payload_digest: fileWritePayloadDigest(content), inspection: {
        state: "present", target_identity_digest, canonical_root_digest: "1".repeat(64),
        parent_identity_digest: "2".repeat(64), observed_payload_digest: fileWritePayloadDigest(content),
        file_identity_digest: "3".repeat(64),
      } });
    expect(observation).toMatchObject({ source: "local_file_state", status: "matched", match_count: 1,
      target_identity_digest, used_for_authority: false, raw_receipt_exposed: false });
    expect(observation).not.toHaveProperty("observed_command_digest");
    expect(observation).not.toHaveProperty("observed_command_key_digest");
    expect(JSON.stringify(observation)).not.toContain(content);
    expect(JSON.stringify(observation)).not.toContain(parameters.path);

    const mismatch = ingestLocalFileWriteStateObservation(store.target, { ...expected,
      parameters, request_payload_digest: fileWritePayloadDigest(content), inspection: {
        state: "present", target_identity_digest, canonical_root_digest: "1".repeat(64),
        parent_identity_digest: "2".repeat(64), observed_payload_digest: fileWritePayloadDigest("other"),
        file_identity_digest: "4".repeat(64),
      } });
    expect(mismatch).toMatchObject({ source: "local_file_state", status: "mismatch", match_count: 1 });
    const absent = ingestLocalFileWriteStateObservation(store.target, { ...expected,
      parameters, request_payload_digest: fileWritePayloadDigest(content), inspection: {
        state: "absent", target_identity_digest, canonical_root_digest: "1".repeat(64),
        parent_identity_digest: "2".repeat(64),
      } });
    expect(absent).toMatchObject({ source: "local_file_state", status: "not_found", match_count: 0 });
  });
});
