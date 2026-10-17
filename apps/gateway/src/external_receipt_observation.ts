import { createHash } from "node:crypto";
import type { InboundRequest, OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { OperationPlanExternalReceiptObservationSchema } from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
interface LocalInspectionMatch {
  idempotency_key: string; command_digest: string; payload_digest: string; receipt_id: string;
}
export interface LocalInspectionResponse { status: "not_found" | "accepted" | "ambiguous"; matches: LocalInspectionMatch[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}
export function parseLocalInspectionResponse(value: unknown): LocalInspectionResponse {
  if (!isRecord(value) || !exactKeys(value, ["status", "matches"]) ||
      !["not_found", "accepted", "ambiguous"].includes(String(value.status)) ||
      !Array.isArray(value.matches) || value.matches.length > 100) throw new Error("external_receipt_observation_response_invalid");
  const matches: LocalInspectionMatch[] = [];
  for (const entry of value.matches) {
    if (!isRecord(entry) || !exactKeys(entry, ["idempotency_key", "command_digest", "payload_digest", "receipt_id"]) ||
        ![entry.idempotency_key, entry.command_digest, entry.payload_digest].every((item) => typeof item === "string" && DIGEST_PATTERN.test(item)) ||
        typeof entry.receipt_id !== "string" || entry.receipt_id.length === 0 || entry.receipt_id.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(entry.receipt_id)) throw new Error("external_receipt_observation_candidate_invalid");
    matches.push({ idempotency_key: entry.idempotency_key as string, command_digest: entry.command_digest as string,
      payload_digest: entry.payload_digest as string, receipt_id: entry.receipt_id });
  }
  return { status: value.status as LocalInspectionResponse["status"], matches };
}

export interface ExternalReceiptObservationSink {
  recordOperationPlanExternalReceiptObservation(value: unknown, caller: InboundRequest): boolean;
}

export interface LocalInspectionReceiptInput {
  caller: InboundRequest;
  command_id: string;
  command_digest: string;
  executor_command_digest: string;
  plan_id_digest: string;
  revision_digest: string;
  step_id_digest: string;
  request_payload_digest: string;
  response: unknown;
  observed_at_ms?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Accept only a bounded local-inspection response and retain digest-only evidence in J. */
export function ingestLocalInspectionReceipt(
  sink: ExternalReceiptObservationSink,
  input: LocalInspectionReceiptInput,
): OperationPlanExternalReceiptObservation {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(input.command_id) || ![input.command_digest, input.executor_command_digest, input.plan_id_digest,
      input.revision_digest, input.step_id_digest, input.request_payload_digest].every((value) => DIGEST_PATTERN.test(value))) {
    throw new Error("external_receipt_observation_binding_invalid");
  }
  const observedAt = input.observed_at_ms ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > Date.now() + 30_000) {
    throw new Error("external_receipt_observation_time_invalid");
  }
  const response = parseLocalInspectionResponse(input.response);
  const expectedCommandKey = sha256(JSON.stringify(["gateway-executor-command.v1", input.command_id]));
  const candidates = response.matches.map((match) => ({
    command_key_digest: sha256(match.idempotency_key),
    command_digest: match.command_digest,
    payload_digest: match.payload_digest,
    receipt_digest: sha256(match.receipt_id),
  })).sort((left, right) => left.receipt_digest.localeCompare(right.receipt_digest));
  if ((response.status === "not_found" && candidates.length !== 0) ||
      (response.status === "accepted" && candidates.length !== 1) ||
      (response.status === "ambiguous" && candidates.length < 2)) {
    throw new Error("external_receipt_observation_response_inconsistent");
  }
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const matched = response.status === "accepted" && candidate?.command_key_digest === sha256(expectedCommandKey) &&
    candidate.command_digest === input.executor_command_digest && candidate.payload_digest === input.request_payload_digest;
  const status = response.status === "not_found" ? "not_found" : response.status === "ambiguous" ? "ambiguous"
    : matched ? "matched" : "mismatch";
  const evidence = {
    schema_version: "external-receipt-observation.v1" as const,
    source: "local_inspection" as const,
    plan_id_digest: input.plan_id_digest,
    revision_digest: input.revision_digest,
    step_id_digest: input.step_id_digest,
    command_digest: input.command_digest,
    executor_command_digest: input.executor_command_digest,
    command_key_digest: sha256(expectedCommandKey),
    ...(candidate ? { observed_command_digest: candidate.command_digest,
      observed_command_key_digest: candidate.command_key_digest, observed_payload_digest: candidate.payload_digest,
      receipt_digest: candidate.receipt_digest } : {}),
    request_payload_digest: input.request_payload_digest,
    candidate_set_digest: operationPlanDigest(candidates),
    status,
    match_count: candidates.length,
    used_for_authority: false as const,
    raw_receipt_exposed: false as const,
  };
  const observation = OperationPlanExternalReceiptObservationSchema.parse({
    ...evidence,
    evidence_digest: operationPlanDigest(evidence),
    observed_at_ms: observedAt,
  });
  sink.recordOperationPlanExternalReceiptObservation(observation, input.caller);
  return observation;
}
