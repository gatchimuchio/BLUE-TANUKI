import {
  BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
  BOUNDARY_EXCHANGE_SCHEMA_VERSION,
  parseBoundaryExchangeAtBoundary,
} from "./境界交換契約.js";

const optionalUndefinedFields = new Set([
  "constraints", "constraints.max_tokens", "constraints.timeout_ms", "constraints.allowed_tools", "constraints.allowed_capabilities",
  "upstream_decision.request_id", "payload.backend_hint", "payload.model", "payload.temperature", "payload.compute_context", "payload.session_id",
  "payload.compute_context.fallback_authorization",
]);

/** 承認・境界間hashで共用する、JSON値のみの独立snapshotを返す。 */
export function canonicalExecutorCommandSnapshot(command: unknown): unknown {
  const visit = (value: unknown, depth: number, path: string[] = []): unknown => {
    if (depth > 64) throw new Error("Executor approval rejected: command content is not canonical JSON");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    if (!value || typeof value !== "object" ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Executor approval rejected: command content is not canonical JSON");
    if (Object.getOwnPropertyNames(value).some((key) => !(Array.isArray(value) && key === "length") && !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    if (Array.isArray(value) && Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error("Executor approval rejected: command content is not canonical JSON");
    }
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Executor approval rejected: command content is not canonical JSON");
      const nextPath = [...path, key];
      if (descriptor.value === undefined && !Array.isArray(value) && !nextPath.some((part) => part.includes(".")) &&
          optionalUndefinedFields.has(nextPath.join("."))) continue;
      Object.defineProperty(out, key, { value: visit(descriptor.value, depth + 1, nextPath), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return visit(command, 0);
}

function approvalDigestValue(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "number") return ["number", JSON.stringify(value)];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (Array.isArray(value)) return ["array", value.map(approvalDigestValue)];
  const fields = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, approvalDigestValue(child)]));
  return ["object", fields];
}

/** HDS-BRAINの行為選択とExecutorの許可ticketが共有するcanonical bytes。 */
export function canonicalExecutorCommandBytes(command: unknown): Uint8Array {
  const content = canonicalExecutorCommandSnapshot(command);
  const boundary = parseBoundaryExchangeAtBoundary(new TextEncoder().encode(JSON.stringify({
    schema_version: BOUNDARY_EXCHANGE_SCHEMA_VERSION,
    canonicalization_version: BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
    issued_at_utc: "1970-01-01T00:00:00.000Z",
    content: { profile: "executor-command-content.v1", command: approvalDigestValue(content) },
  })));
  if (!boundary.ok) throw new Error("Executor approval rejected: command content is not canonical JSON");
  return boundary.canonical_bytes;
}
