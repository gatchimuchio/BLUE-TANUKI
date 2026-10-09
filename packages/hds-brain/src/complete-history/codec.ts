import { createHash } from "node:crypto";
import {
  parseJsonTextAtBoundary,
  parseMeaningUpdateProposal,
  parseObservationAcquisitionRecord,
} from "@blue-tanuki/protocol";
import type { CompleteHistoryEntry, CompleteHistoryKind } from "./types.js";

const COMPLETE_HISTORY_KINDS = new Set<CompleteHistoryKind>([
  "user_input",
  "llm_history",
  "hds_decision",
  "approval_history",
  "execution_history",
  "audit_history",
  "final_output",
]);

export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown, inArray = false): unknown => {
    if (v === undefined) return inArray ? null : undefined;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item, true));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const normalized = normalize((v as Record<string, unknown>)[key]);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function completeHistoryEntryHash(
  input: Omit<CompleteHistoryEntry, "entry_hash">,
): string {
  return sha256Hex(input);
}

export function encodeCompleteHistoryEntry(entry: CompleteHistoryEntry): string {
  return JSON.stringify(entry);
}

export function decodeCompleteHistoryEntry(line: string): CompleteHistoryEntry {
  const boundary = parseJsonTextAtBoundary(line);
  if (!boundary.ok) {
    throw new Error(`malformed complete history JSONL: ${boundary.reason}`);
  }
  if (!isCompleteHistoryEntry(boundary.value)) {
    throw new Error("malformed complete history entry");
  }
  return boundary.value;
}

export function isValidCompleteHistorySemanticPayload(
  kind: CompleteHistoryKind,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(payload, "record_type");
    if (!descriptor) return true;
    if (!("value" in descriptor)) return false;
    if (descriptor.value === "observation_acquisition" && kind === "user_input") {
      return parseObservationAcquisitionRecord(payload).ok;
    }
    if (descriptor.value === "meaning_update_proposal" && kind === "audit_history") {
      return parseMeaningUpdateProposal(payload).ok;
    }
    return false;
  } catch {
    return false;
  }
}

function isCompleteHistoryEntry(value: unknown): value is CompleteHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CompleteHistoryEntry>;
  return (
    typeof entry.schema_version === "string" &&
    typeof entry.index === "number" &&
    typeof entry.id === "string" &&
    typeof entry.kind === "string" &&
    COMPLETE_HISTORY_KINDS.has(entry.kind as CompleteHistoryKind) &&
    isValidCompleteHistorySemanticPayload(entry.kind as CompleteHistoryKind, entry.payload) &&
    (typeof entry.request_id === "string" || entry.request_id === null) &&
    (typeof entry.command_id === "string" || entry.command_id === null) &&
    (entry.actor === undefined || typeof entry.actor === "string") &&
    (entry.source === undefined || typeof entry.source === "string") &&
    Object.prototype.hasOwnProperty.call(entry, "payload") &&
    typeof entry.payload_digest === "string" &&
    entry.used_for_authority === false &&
    typeof entry.timestamp === "number" &&
    typeof entry.prev_hash === "string" &&
    typeof entry.entry_hash === "string"
  );
}
