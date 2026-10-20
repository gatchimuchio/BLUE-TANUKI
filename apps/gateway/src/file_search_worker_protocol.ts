import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { executorCommandDigest, type ExecutionIntentTicket } from "@blue-tanuki/core";
import { canonicalFileSearchTargetVersionObservation, FileSearchTargetVersionObservationSchema,
  requireToolOperationDescriptor, type ExecuteCommand, type FileSearchTargetVersionObservation } from "@blue-tanuki/protocol";
import { isHostAudienceDigest } from "./host_audience_identity.js";

export const FILE_SEARCH_WORKER_PROFILE = "blue-file-search-worker.v3";
export const FILE_SEARCH_WORKER_PACKET_LIMIT = 262_144;
export const workerPacket = (packet: Record<string, unknown>): string => {
  const text = JSON.stringify({ profile: FILE_SEARCH_WORKER_PROFILE, ...packet });
  if (Buffer.byteLength(text, "utf8") > FILE_SEARCH_WORKER_PACKET_LIMIT) throw new Error("file_search_worker_packet_too_large");
  return text;
};
export function readWorkerPacket(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > FILE_SEARCH_WORKER_PACKET_LIMIT) throw new Error("file_search_worker_packet_invalid");
  const packet: unknown = JSON.parse(value);
  if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
      (packet as Record<string, unknown>).profile !== FILE_SEARCH_WORKER_PROFILE) throw new Error("file_search_worker_profile_mismatch");
  return packet as Record<string, unknown>;
}
export function validateWorkerRequest(packet: Record<string, unknown>, worker_id: string, expected_execution_epoch: string, now_ms: number,
  expected_task_identity_digest?: string, expected_host_audience_digest?: string): {
  command: Extract<ExecuteCommand, { type: "tool_call" }>;
  ticket: ExecutionIntentTicket;
  target_version_observation: FileSearchTargetVersionObservation;
  operation_plan_binding_digest?: string;
  task_identity_digest?: string;
  host_audience_digest: string;
} {
  if (packet.type !== "execute" || packet.worker_id !== worker_id ||
      Object.keys(packet).some((key) => !["profile", "type", "worker_id", "ticket", "command", "target_version_observation",
        "operation_plan_binding_digest", "task_identity_digest", "host_audience_digest"].includes(key))) throw new Error("file_search_worker_request_invalid");
  const ticket = packet.ticket as ExecutionIntentTicket;
  const command = packet.command as Extract<ExecuteCommand, { type: "tool_call" }>;
  let target_version_observation: FileSearchTargetVersionObservation;
  try { target_version_observation = FileSearchTargetVersionObservationSchema.parse(packet.target_version_observation); }
  catch { throw new Error("file_search_worker_target_version_invalid"); }
  const requestedRoot = command?.payload?.arguments?.root;
  if (!ticket || Object.keys(ticket).some((key) => !["ticket_id", "command_key", "command_digest", "proof_digest", "task_identity_digest",
      "execution_epoch", "issued_at_ms", "expires_at_ms"].includes(key)) ||
      !/^[0-9a-f-]{36}$/.test(ticket.ticket_id) || !/^[0-9a-f-]{36}$/.test(ticket.execution_epoch) ||
      ![ticket.command_key, ticket.command_digest, ticket.proof_digest].every((value) => /^[0-9a-f]{64}$/.test(value)) ||
      !Number.isSafeInteger(ticket.issued_at_ms) || !Number.isSafeInteger(ticket.expires_at_ms) ||
      ticket.issued_at_ms <= 0 || ticket.expires_at_ms <= ticket.issued_at_ms || ticket.expires_at_ms - ticket.issued_at_ms > 600_000 ||
      now_ms < ticket.issued_at_ms || now_ms >= ticket.expires_at_ms || command?.type !== "tool_call" ||
      command.payload?.tool_name !== "file.search" || command.upstream_decision?.commit_decision !== "ASSERT" ||
      typeof command.upstream_decision.request_id !== "string" || command.upstream_decision.request_id.length < 1 ||
      command.upstream_decision.request_id.length > 200 || ticket.execution_epoch !== expected_execution_epoch ||
      typeof requestedRoot !== "string" || target_version_observation.requested_root_digest !== createHash("sha256").update(requestedRoot, "utf8").digest("hex") ||
      ticket.command_digest !== executorCommandDigest(command) ||
      ticket.command_key !== createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", command.id])).digest("hex") ||
      packet.operation_plan_binding_digest !== target_version_observation.operation_plan_binding_digest ||
      packet.task_identity_digest !== ticket.task_identity_digest || packet.task_identity_digest !== expected_task_identity_digest ||
      !isHostAudienceDigest(packet.host_audience_digest) || packet.host_audience_digest !== expected_host_audience_digest ||
      (packet.task_identity_digest !== undefined &&
        (typeof packet.task_identity_digest !== "string" || !/^[a-f0-9]{64}$/.test(packet.task_identity_digest))) ||
      (packet.operation_plan_binding_digest !== undefined &&
        (typeof packet.operation_plan_binding_digest !== "string" || !/^[0-9a-f]{64}$/.test(packet.operation_plan_binding_digest)))) {
    throw new Error("file_search_worker_ticket_invalid");
  }
  const constraints = command.constraints;
  if (!constraints?.allowed_tools?.includes("file.search") ||
      !requireToolOperationDescriptor("file.search").required_capabilities.every((cap) => constraints.allowed_capabilities?.includes(cap))) {
    throw new Error("file_search_worker_capability_denied");
  }
  return { command, ticket, target_version_observation,
    ...(typeof packet.operation_plan_binding_digest === "string" ? { operation_plan_binding_digest: packet.operation_plan_binding_digest } : {}),
    ...(typeof packet.task_identity_digest === "string" ? { task_identity_digest: packet.task_identity_digest } : {}),
    host_audience_digest: packet.host_audience_digest };
}

export function validateWorkerResult(value: unknown, command: Extract<ExecuteCommand, { type: "tool_call" }>,
  observedTargetVersion: unknown, expectedTargetVersion: FileSearchTargetVersionObservation): FileSearchTargetVersionObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("file_search_worker_result_invalid");
  const result = value as Record<string, unknown>;
  let observedTargetVersionCanonical: string;
  let observedTargetVersionParsed: FileSearchTargetVersionObservation;
  try {
    observedTargetVersionParsed = FileSearchTargetVersionObservationSchema.parse(observedTargetVersion);
    observedTargetVersionCanonical = canonicalFileSearchTargetVersionObservation(observedTargetVersionParsed);
  }
  catch { throw new Error("file_search_worker_result_invalid"); }
  if (observedTargetVersionCanonical !== canonicalFileSearchTargetVersionObservation(expectedTargetVersion) ||
      Object.keys(result).some((key) => !["root", "sandbox_root", "query", "visited_files", "matches"].includes(key)) ||
      typeof result.root !== "string" || typeof result.sandbox_root !== "string" || result.query !== command.payload.arguments.query ||
      !Number.isSafeInteger(result.visited_files) || (result.visited_files as number) < 0 || (result.visited_files as number) > 1000 ||
      !Array.isArray(result.matches) || result.matches.length > 100) throw new Error("file_search_worker_result_invalid");
  for (const match of result.matches) {
    if (!match || typeof match !== "object" || Array.isArray(match) || Object.keys(match).some((key) => !["path", "line_number", "line"].includes(key)) ||
        typeof match.path !== "string" || !match.path || isAbsolute(match.path) || match.path.split(/[\\/]/).includes("..") ||
        typeof match.line !== "string" || match.line.length > 240 || !Number.isSafeInteger(match.line_number) || match.line_number <= 0) {
      throw new Error("file_search_worker_result_invalid");
    }
  }
  return observedTargetVersionParsed;
}
