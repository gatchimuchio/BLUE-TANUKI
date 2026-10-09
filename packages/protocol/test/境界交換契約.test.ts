import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoundaryExchangeAtBoundary } from "../src/index.js";

type GeneratedInput =
  | { kind: "oversized_content"; repeat: number }
  | { kind: "nested_arrays"; count: number };

type PositiveVector = { id: string; input: string; canonical: string };
type NegativeVector = {
  id: string;
  input?: string;
  input_utf8_hex?: string;
  generated?: GeneratedInput;
  reason: string;
};

const vectorFile = JSON.parse(
  readFileSync(new URL("./fixtures/c01_02_境界交換vector.json", import.meta.url), "utf8"),
) as {
  format_version: string;
  positive: PositiveVector[];
  negative: NegativeVector[];
};

describe("BT-U-C01.02-P TS/Rust shared vectors", () => {
  it("accepts each valid raw boundary input and emits the fixed canonical bytes", () => {
    expect(vectorFile.format_version).toBe("blue-tanuki.boundary-exchange-vectors.v1");
    expect(vectorFile.positive.length).toBeGreaterThan(0);

    for (const vector of vectorFile.positive) {
      const result = parseBoundaryExchangeAtBoundary(new TextEncoder().encode(vector.input));
      expect(result, vector.id).toMatchObject({ ok: true, canonical_json: vector.canonical });
      if (!result.ok) continue;
      expect(Buffer.from(result.canonical_bytes).toString("utf8"), vector.id).toBe(vector.canonical);
      expect(Buffer.from(result.canonical_bytes).toString("hex"), vector.id).toBe(
        Buffer.from(vector.canonical, "utf8").toString("hex"),
      );
    }
  });
});

describe("BT-U-C01.02-N TS/Rust shared vectors", () => {
  it("rejects each invalid raw boundary input with the same safe failure class", () => {
    expect(vectorFile.negative.length).toBeGreaterThan(0);

    for (const vector of vectorFile.negative) {
      const result = parseBoundaryExchangeAtBoundary(materializeInput(vector));
      expect(result, vector.id).toEqual({ ok: false, reason: vector.reason });
      expect(JSON.stringify(result), vector.id).not.toContain("SECRET_VECTOR_SENTINEL");
    }
  });
});

function materializeInput(vector: NegativeVector): Uint8Array {
  if (vector.input !== undefined) return new TextEncoder().encode(vector.input);
  if (vector.input_utf8_hex !== undefined) return Buffer.from(vector.input_utf8_hex, "hex");
  if (vector.generated?.kind === "oversized_content") {
    const prefix =
      '{"schema_version":"blue-tanuki.boundary-exchange.v1","canonicalization_version":"blue-tanuki.jcs-safe-integer.v1","issued_at_utc":"2026-10-09T00:00:00.000Z","content":{"padding":"';
    const suffix = '"}}';
    return new TextEncoder().encode(`${prefix}${"x".repeat(vector.generated.repeat)}${suffix}`);
  }
  if (vector.generated?.kind === "nested_arrays") {
    const prefix =
      '{"schema_version":"blue-tanuki.boundary-exchange.v1","canonicalization_version":"blue-tanuki.jcs-safe-integer.v1","issued_at_utc":"2026-10-09T00:00:00.000Z","content":{"value":';
    const nested = "[".repeat(vector.generated.count) + "0" + "]".repeat(vector.generated.count);
    return new TextEncoder().encode(`${prefix}${nested}}}`);
  }
  throw new Error(`invalid test vector: ${vector.id}`);
}
