import { createHash } from "node:crypto";
import type { InboundRequest, OperationPlanExternalReceiptObservation } from "@blue-tanuki/protocol";
import { OperationPlanExternalReceiptObservationSchema, fileWritePayloadDigest } from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { ExecutionIntentReceipt } from "@blue-tanuki/core";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
interface LocalInspectionMatch {
  idempotency_key: string; command_digest: string; payload_digest: string; receipt_id: string;
}
export interface LocalInspectionResponse { status: "not_found" | "accepted" | "ambiguous"; matches: LocalInspectionMatch[] }

export function gatewayExecutionReceiptEvidence(receipt: ExecutionIntentReceipt, command_key_digest: string) {
  const execution_epoch_digest = sha256(receipt.execution_epoch);
  const projection = {
    schema_version: "gateway-execution-receipt-evidence.v1",
    command_key_digest,
    command_digest: receipt.command_digest,
    execution_epoch_digest,
    task_identity_digest: receipt.task_identity_digest ?? null,
    state: receipt.state,
    feedback_status: receipt.feedback_status ?? null,
    result_delivery_digest: receipt.result_delivery_digest ?? null,
    result_delivery_acknowledged: receipt.result_delivery_acknowledged ?? null,
    used_for_authority: false,
  };
  return {
    gateway_execution_receipt_digest: operationPlanDigest(projection),
    gateway_execution_receipt_state: receipt.state,
    gateway_execution_epoch_digest: execution_epoch_digest,
    ...(receipt.task_identity_digest ? { gateway_task_identity_digest: receipt.task_identity_digest } : {}),
    ...(receipt.feedback_status ? { gateway_execution_feedback_status: receipt.feedback_status } : {}),
    ...(receipt.result_delivery_digest ? { gateway_result_delivery_digest: receipt.result_delivery_digest } : {}),
    ...(receipt.result_delivery_acknowledged !== undefined
      ? { gateway_result_delivery_acknowledged: receipt.result_delivery_acknowledged } : {}),
  } as const;
}

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

export interface LocalFileWriteStateObservationInput extends Omit<LocalInspectionReceiptInput, "response"> {
  parameters: Record<string, unknown>;
  execution_epoch?: string;
  task_identity_digest?: string;
  execution_receipt?: ExecutionIntentReceipt;
  inspection: {
    state: "absent" | "present" | "non_regular";
    target_identity_digest: string;
    canonical_root_digest: string;
    parent_identity_digest: string;
    observed_payload_digest?: string;
    file_identity_digest?: string;
  };
}

/** Build digest-only evidence for one create-only sandbox target; this does not prove who created it. */
export function createLocalFileWriteStateObservation(
  input: LocalFileWriteStateObservationInput,
): OperationPlanExternalReceiptObservation {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(input.command_id) ||
      ![input.command_digest, input.executor_command_digest, input.plan_id_digest, input.revision_digest,
        input.step_id_digest].every((value) => DIGEST_PATTERN.test(value)) ||
      input.parameters.mode !== "create" || typeof input.parameters.path !== "string" ||
      typeof input.parameters.content !== "string" ||
      input.request_payload_digest !== fileWritePayloadDigest(input.parameters.content) ||
      !DIGEST_PATTERN.test(input.inspection.target_identity_digest)) {
    throw new Error("local_file_state_observation_binding_invalid");
  }
  const observedAt = input.observed_at_ms ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > Date.now() + 30_000) {
    throw new Error("external_receipt_observation_time_invalid");
  }
  const inspection = input.inspection;
  const candidate = inspection.state === "absent" ? undefined : {
    target_identity_digest: inspection.target_identity_digest,
    canonical_root_digest: inspection.canonical_root_digest,
    parent_identity_digest: inspection.parent_identity_digest,
    state: inspection.state,
    ...(inspection.observed_payload_digest ? { observed_payload_digest: inspection.observed_payload_digest } : {}),
    ...(inspection.file_identity_digest ? { file_identity_digest: inspection.file_identity_digest } : {}),
  };
  const candidates = candidate ? [candidate] : [];
  const status = !candidate ? "not_found" as const
    : inspection.state === "present" && inspection.observed_payload_digest === input.request_payload_digest
      ? "matched" as const : "mismatch" as const;
  const expectedCommandKey = sha256(JSON.stringify(["gateway-executor-command.v1", input.command_id]));
  const executionReceipt = input.execution_receipt;
  let gatewayReceipt: ReturnType<typeof gatewayExecutionReceiptEvidence> | undefined;
  if (executionReceipt) {
    if (!input.execution_epoch || executionReceipt.command_key !== expectedCommandKey ||
        executionReceipt.command_digest !== input.executor_command_digest || executionReceipt.execution_epoch !== input.execution_epoch ||
        executionReceipt.task_identity_digest !== input.task_identity_digest || executionReceipt.used_for_authority !== false) {
      throw new Error("local_file_state_gateway_receipt_binding_invalid");
    }
    gatewayReceipt = gatewayExecutionReceiptEvidence(executionReceipt, sha256(expectedCommandKey));
  }
  const evidence = {
    schema_version: "external-receipt-observation.v1" as const,
    source: "local_file_state" as const,
    plan_id_digest: input.plan_id_digest,
    revision_digest: input.revision_digest,
    step_id_digest: input.step_id_digest,
    command_digest: input.command_digest,
    executor_command_digest: input.executor_command_digest,
    command_key_digest: sha256(expectedCommandKey),
    request_payload_digest: input.request_payload_digest,
    ...(gatewayReceipt ?? {}),
    ...(candidate && inspection.state === "present" && inspection.observed_payload_digest
      ? { observed_payload_digest: inspection.observed_payload_digest } : {}),
    target_identity_digest: inspection.target_identity_digest,
    candidate_set_digest: operationPlanDigest(candidates),
    status,
    match_count: candidates.length,
    ...(candidate ? { receipt_digest: operationPlanDigest(candidate) } : {}),
    used_for_authority: false as const,
    raw_receipt_exposed: false as const,
  };
  const observation = OperationPlanExternalReceiptObservationSchema.parse({
    ...evidence, evidence_digest: operationPlanDigest(evidence), observed_at_ms: observedAt,
  });
  return observation;
}

/** Build and persist a digest-only observation through the existing J observation sink. */
export function ingestLocalFileWriteStateObservation(
  sink: ExternalReceiptObservationSink,
  input: LocalFileWriteStateObservationInput,
): OperationPlanExternalReceiptObservation {
  const observation = createLocalFileWriteStateObservation(input);
  sink.recordOperationPlanExternalReceiptObservation(observation, input.caller);
  return observation;
}
