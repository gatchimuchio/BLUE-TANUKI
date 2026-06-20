import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HDSUpperController } from "../src/controller.js";
import type { MemoryTrace } from "../src/types.js";
import {
  EXPECTED_RUNTIME_INVARIANTS,
  RUNTIME_INVARIANTS_SCHEMA_VERSION,
  buildRuntimeInvariantEvidence,
  runtimeInvariantReportDigest,
  runtimeInvariantReportOk,
  runtimeInvariantValuesOk,
} from "../src/runtime_invariants.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(packageRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

function importsFrom(source: string): string[] {
  const imports: string[] = [];
  const importRe = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    imports.push(match[1]!);
  }
  return imports;
}

describe("HDS runtime invariant structural guards", () => {
  it("keeps HDS-BRAIN dependency graph free of downstream LLM/core clients", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@blue-tanuki/protocol"]);
    expect(Object.keys(pkg.devDependencies ?? {})).not.toEqual(
      expect.arrayContaining([
        "@blue-tanuki/core",
        "@blue-tanuki/channel-slack",
        "@blue-tanuki/channel-discord",
        "openai",
        "@anthropic-ai/sdk",
      ]),
    );
  });

  it("does not import downstream LLM, channel, gateway, or core modules from src", () => {
    const forbidden = [
      /^@blue-tanuki\/core$/,
      /^@blue-tanuki\/channel-/,
      /^@blue-tanuki\/gateway$/,
      /^openai$/,
      /^@anthropic-ai\/sdk$/,
      /\/llm(\/|$)/,
    ];

    const violations = sourceFiles(srcRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return importsFrom(source)
        .filter((moduleName) => forbidden.some((pattern) => pattern.test(moduleName)))
        .map((moduleName) => `${relative(packageRoot, file)} -> ${moduleName}`);
    });

    expect(violations).toEqual([]);
  });

  it("types memory traces as non-authority data", () => {
    const proveLiteralFalse = (trace: MemoryTrace): false => trace.used_for_authority;

    expect(
      proveLiteralFalse({
        policy_id: "test.memory",
        process_id: "chat.process",
        used_for_authority: false,
        hits: [],
      }),
    ).toBe(false);
  });

  it("keeps the public runtime snapshot values stable", () => {
    const snapshot = new HDSUpperController().getRuntimeSnapshot();

    expect(snapshot.invariants).toEqual(EXPECTED_RUNTIME_INVARIANTS);
    expect(snapshot.runtime_invariants.schema_version).toBe(RUNTIME_INVARIANTS_SCHEMA_VERSION);
    expect(snapshot.runtime_invariants.values).toEqual(EXPECTED_RUNTIME_INVARIANTS);
    expect(snapshot.runtime_invariants.all_ok).toBe(true);
    expect(snapshot.runtime_invariants.runtime_invariants_used_for_authority).toBe(false);
    expect(snapshot.runtime_invariants.report_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.runtime_invariants.evidence.map((entry) => entry.key).sort()).toEqual(
      Object.keys(EXPECTED_RUNTIME_INVARIANTS).sort(),
    );
    expect(runtimeInvariantReportDigest(snapshot.runtime_invariants)).toBe(snapshot.runtime_invariants.report_digest);
    expect(runtimeInvariantReportOk(snapshot.runtime_invariants)).toBe(true);
    expect(runtimeInvariantValuesOk(snapshot.invariants)).toBe(true);
  });

  it("keeps report digest valid after JSON round trip", () => {
    const report = buildRuntimeInvariantEvidence({
      generated_at_ms: 1,
      actuals: {
        hds_calls_llm: false,
        process_policy_enforced: true,
        memory_used_for_authority: false,
        complete_history_used_for_authority: false,
      },
    });
    const parsed = JSON.parse(JSON.stringify(report));

    expect(runtimeInvariantReportDigest(parsed)).toBe(report.report_digest);
    expect(runtimeInvariantReportOk(parsed)).toBe(true);
  });

  it("marks missing actuals as UNKNOWN instead of falling back to expected constants", () => {
    const report = buildRuntimeInvariantEvidence({ generated_at_ms: 1 });

    expect(report.all_ok).toBe(false);
    expect(report.values.hds_calls_llm).toBeNull();
    expect(report.evidence.find((entry) => entry.key === "hds_calls_llm")).toMatchObject({
      actual: null,
      measurement_status: "UNKNOWN",
      ok: false,
      used_for_authority: false,
    });
    expect(runtimeInvariantReportOk(report)).toBe(false);
  });

  it("builds failed evidence instead of silently normalizing broken invariants", () => {
    const report = buildRuntimeInvariantEvidence({
      generated_at_ms: 1,
      actuals: { process_policy_enforced: false },
    });

    expect(report.all_ok).toBe(false);
    expect(report.values.process_policy_enforced).toBe(false);
    expect(report.evidence.find((entry) => entry.key === "process_policy_enforced")).toMatchObject({
      expected: true,
      actual: false,
      ok: false,
      used_for_authority: false,
    });
    expect(runtimeInvariantReportOk(report)).toBe(false);
  });

  it("can append runtime invariant evidence into the audit chain", () => {
    const controller = new HDSUpperController();
    const log = controller.onRuntimeInvariantsEvidence({
      reason: "test_snapshot",
      timestamp: 2,
      evidence_options: { generated_at_ms: 1 },
    });

    expect(log.kind).toBe("runtime_invariants");
    expect(log.event).toBe("runtime_invariants.evidence");
    expect(log.all_ok).toBe(true);
    expect(log.used_for_authority).toBe(false);
    expect(log.report.report_digest).toBe(log.report_digest);
    expect(controller.getAudit().verify()).toBe(true);
  });
});
