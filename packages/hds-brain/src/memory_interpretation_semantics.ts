import { createHash } from "node:crypto";
import type { MemoryCommitJsonValue } from "@blue-tanuki/protocol";

const MAX_INTERPRETATION_BYTES = 65_536;

export interface MemoryInterpretationEvidenceReference {
  readonly reference: string;
  readonly digest: string;
}

export interface MemoryInterpretation {
  readonly interpretation_id: string;
  readonly basis_ref: string;
  readonly meaning: Readonly<Record<string, MemoryCommitJsonValue>>;
  readonly content_digest: string;
}

export function interpretationContentDigest(
  meaning: Readonly<Record<string, MemoryCommitJsonValue>>,
): string {
  if (!isPlainRecord(meaning) || !isJsonValue(meaning)) throw new Error("invalid interpretation meaning");
  const canonical = canonicalJson(meaning);
  if (Buffer.byteLength(canonical, "utf8") > MAX_INTERPRETATION_BYTES) throw new Error("interpretation meaning is too large");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function isJsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = Object.getPrototypeOf(value) === Array.prototype && Object.getOwnPropertySymbols(value).length === 0 &&
      Object.getOwnPropertyNames(value).length === value.length + 1;
    if (valid) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
            !isJsonValue(descriptor.value, depth + 1, ancestors)) {
          valid = false;
          break;
        }
      }
    }
  } else if (isPlainRecord(value)) {
    valid = Object.keys(value).every((key) => key !== "__proto__" && key !== "prototype" && key !== "constructor" &&
      isJsonValue(value[key], depth + 1, ancestors));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
    Object.keys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
