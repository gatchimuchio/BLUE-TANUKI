import { z } from "zod";
import { parseJsonTextAtBoundary } from "./common_record.js";

export const BOUNDARY_EXCHANGE_SCHEMA_VERSION = "blue-tanuki.boundary-exchange.v1" as const;
export const BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION = "blue-tanuki.jcs-safe-integer.v1" as const;
export const BOUNDARY_EXCHANGE_MAX_BYTES = 1_048_576;
export const BOUNDARY_EXCHANGE_MAX_DEPTH = 64;

const DangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const JsonNumberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const SafeIntegerTokenPattern = /^-?(?:0|[1-9][0-9]*)$/;

export type BoundaryExchangeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BoundaryExchangeJsonValue[]
  | { readonly [key: string]: BoundaryExchangeJsonValue };

export interface BoundaryExchangeContractV1 {
  readonly schema_version: typeof BOUNDARY_EXCHANGE_SCHEMA_VERSION;
  readonly canonicalization_version: typeof BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION;
  readonly issued_at_utc: string;
  readonly content: Readonly<Record<string, BoundaryExchangeJsonValue>>;
}

const BoundaryExchangeContractV1Schema = z.object({
  schema_version: z.literal(BOUNDARY_EXCHANGE_SCHEMA_VERSION),
  canonicalization_version: z.literal(BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION),
  issued_at_utc: z.string().refine(isUtcMillisecondTimestamp),
  content: z.record(z.unknown()),
}).strict();

export type BoundaryExchangeFailureReason =
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_key"
  | "invalid_unicode"
  | "invalid_number_profile"
  | "schema_validation_failed"
  | "dangerous_key"
  | "payload_too_large"
  | "payload_too_deep";

export type BoundaryExchangeResult =
  | { ok: true; canonical_json: string; canonical_bytes: Uint8Array }
  | { ok: false; reason: BoundaryExchangeFailureReason };

/**
 * 制限JSONのraw UTF-8交換境界を検査し、同じ入力だけからJCS bytesを返す。
 * この関数はissuer、permission、approval、executionの意味を付与しない。
 */
export function parseBoundaryExchangeAtBoundary(rawInput: Uint8Array): BoundaryExchangeResult {
  if (rawInput.byteLength > BOUNDARY_EXCHANGE_MAX_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }

  let text: string;
  try {
    const snapshot = new Uint8Array(rawInput);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }

  const profileFailure = inspectRawJsonProfile(text);
  if (profileFailure) return { ok: false, reason: profileFailure };

  const parsedJson = parseJsonTextAtBoundary(text);
  if (!parsedJson.ok) {
    if (parsedJson.reason === "non_finite_number") {
      return { ok: false, reason: "invalid_number_profile" };
    }
    return { ok: false, reason: parsedJson.reason };
  }
  const parsedContract = BoundaryExchangeContractV1Schema.safeParse(parsedJson.value);
  if (!parsedContract.success) {
    return { ok: false, reason: "schema_validation_failed" };
  }
  const rawContract = parsedJson.value as Record<string, unknown>;
  if (containsDangerousKey(rawContract.content)) {
    return { ok: false, reason: "dangerous_key" };
  }
  if (containsDangerousKey(parsedContract.data.content)) {
    return { ok: false, reason: "dangerous_key" };
  }

  const canonicalJson = canonicalizeJcsValue(parsedContract.data);
  return {
    ok: true,
    canonical_json: canonicalJson,
    canonical_bytes: new TextEncoder().encode(canonicalJson),
  };
}

function inspectRawJsonProfile(text: string): BoundaryExchangeFailureReason | null {
  let index = 0;
  let depth = 0;

  while (index < text.length) {
    const character = text[index]!;
    if (character === "\"") {
      const stringResult = inspectJsonString(text, index);
      if (stringResult.reason) return stringResult.reason;
      index = stringResult.nextIndex;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > BOUNDARY_EXCHANGE_MAX_DEPTH) return "payload_too_deep";
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      while (index < text.length && /[0-9eE.+-]/.test(text[index]!)) index += 1;
      const token = text.slice(start, index);
      if (!JsonNumberPattern.test(token)) return "invalid_json";
      if (!SafeIntegerTokenPattern.test(token) || token === "-0") {
        return "invalid_number_profile";
      }
      if (token.replace(/^-/, "").length > 16 || !Number.isSafeInteger(Number(token))) {
        return "invalid_number_profile";
      }
      continue;
    }

    index += 1;
  }

  return null;
}

function inspectJsonString(
  text: string,
  start: number,
): { nextIndex: number; reason?: BoundaryExchangeFailureReason } {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\"") return { nextIndex: index + 1 };
    if (character !== "\\") {
      index += 1;
      continue;
    }

    const escape = text[index + 1];
    if (escape !== "u") {
      index += 2;
      continue;
    }

    const codeUnit = readHexCodeUnit(text, index + 2);
    if (codeUnit === null) return { nextIndex: text.length, reason: "invalid_json" };
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (text[index + 6] !== "\\" || text[index + 7] !== "u") {
        return { nextIndex: text.length, reason: "invalid_unicode" };
      }
      const trailing = readHexCodeUnit(text, index + 8);
      if (trailing === null) return { nextIndex: text.length, reason: "invalid_json" };
      if (trailing < 0xdc00 || trailing > 0xdfff) {
        return { nextIndex: text.length, reason: "invalid_unicode" };
      }
      index += 12;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return { nextIndex: text.length, reason: "invalid_unicode" };
    }
    index += 6;
  }
  return { nextIndex: text.length };
}

function readHexCodeUnit(text: string, start: number): number | null {
  const token = text.slice(start, start + 4);
  if (token.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(token)) return null;
  return Number.parseInt(token, 16);
}

function containsDangerousKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const nested of current) pending.push(nested);
    } else if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        if (DangerousKeys.has(key)) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

function isUtcMillisecondTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

function canonicalizeJcsValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcsValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJcsValue(record[key])}`).join(",")}}`;
  }
  throw new Error("validated JSON boundary contained a non-JSON value");
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
