import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLog,
  EXPECTED_RUNTIME_INVARIANTS,
  buildOutputAuditLog,
  buildRuntimeInvariantEvidence,
} from "@blue-tanuki/hds-brain";
import {
  runAuditDump,
  auditDumpReportFromLog,
  formatAuditTextReport,
  formatAuditJsonReport,
  type AuditDumpReport,
} from "../src/audit_dump.js";
import { AUDIT_FILENAME } from "../src/audit_config.js";
import type { DecisionLog } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";

function makeLog(id: string): DecisionLog {
  return {
    request_id: id,
    frame: {
      goal: "g",
      protected_values: [],
      world_closure: { x: [], r: [], m: [] },
      problem_definition_id: "p",
    },
    model: {
      abstraction: "abs",
      structure: {},
      scoring: { axis_scores: [], weights: {}, aggregate: 0 },
    },
    commit: {
      decision: "ASSERT",
      reason: "ok",
      hash: "h",
      triggered_thresholds: [],
    },
    timestamp: 0,
  };
}

const upstream = {
  frame_goal: "g",
  model_abstraction: "m",
  commit_hash: "h",
  commit_decision: "ASSERT" as const,
};

function llmCommand(): ExecuteCommand {
  return {
    id: "cmd-output",
    type: "llm_call",
    payload: { messages: [{ role: "user", content: "hi" }] },
    upstream_decision: upstream,
  };
}

function outputFeedback(): ExecuteFeedback {
  return {
    command_id: "cmd-output",
    status: "success",
    result: { content: "hello" },
    metrics: { duration_ms: 1 },
  };
}

describe("runAuditDump", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-dump-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns setup_error when BLUE_TANUKI_AUDIT_DIR is unset", () => {
    const r = runAuditDump({ env: {} });
    expect(r.status).toBe("setup_error");
    expect(r.exit_code).toBe(2);
    expect(r.filepath).toBeNull();
    expect(r.entry_count).toBe(0);
  });

  it("returns empty when audit dir is set but file does not exist yet", () => {
    const r = runAuditDump({ env: { BLUE_TANUKI_AUDIT_DIR: tmpDir } });
    expect(r.status).toBe("empty");
    expect(r.exit_code).toBe(0);
    expect(r.filepath).toBe(join(tmpDir, AUDIT_FILENAME));
    expect(r.entry_count).toBe(0);
    expect(r.chain_valid).toBe(true);
  });

  it("returns ok with entry list when chain is valid", () => {
    const filepath = join(tmpDir, AUDIT_FILENAME);
    const log = new AuditLog({ filepath });
    log.append(makeLog("r1"));
    log.append(makeLog("r2"));
    const r = runAuditDump({ env: { BLUE_TANUKI_AUDIT_DIR: tmpDir } });
    expect(r.status).toBe("ok");
    expect(r.exit_code).toBe(0);
    expect(r.entry_count).toBe(2);
    expect(r.chain_valid).toBe(true);
    expect(r.entries.map((e) => e.log.request_id)).toEqual(["r1", "r2"]);
  });

  it("returns broken with exit_code=1 when chain is tampered", () => {
    const filepath = join(tmpDir, AUDIT_FILENAME);
    const log = new AuditLog({ filepath });
    log.append(makeLog("r1"));
    log.append(makeLog("r2"));
    // Corrupt the first entry's hash; AuditLog#load will throw.
    const lines = readFileSync(filepath, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.entry_hash = "deadbeef";
    writeFileSync(
      filepath,
      [JSON.stringify(first), lines[1]].join("\n") + "\n",
    );
    const r = runAuditDump({ env: { BLUE_TANUKI_AUDIT_DIR: tmpDir } });
    expect(r.status).toBe("broken");
    expect(r.exit_code).toBe(1);
    expect(r.chain_valid).toBe(false);
  });

  it("never throws on broken chain — surfaces structured report", () => {
    // Write an obviously malformed JSONL line (not even valid JSON).
    const filepath = join(tmpDir, AUDIT_FILENAME);
    writeFileSync(filepath, "not-json\n");
    const r = runAuditDump({ env: { BLUE_TANUKI_AUDIT_DIR: tmpDir } });
    expect(r.status).toBe("broken");
    expect(r.exit_code).toBe(1);
    expect(r.detail).toMatch(/chain load failed/);
  });
});

describe("audit-dump format", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-dump-fmt-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildReport(): AuditDumpReport {
    const filepath = join(tmpDir, AUDIT_FILENAME);
    const log = new AuditLog({ filepath });
    log.append(makeLog("r1"));
    return runAuditDump({ env: { BLUE_TANUKI_AUDIT_DIR: tmpDir } });
  }

  it("text format includes summary header and per-entry lines", () => {
    const txt = formatAuditTextReport(buildReport());
    expect(txt).toMatch(/blue-tanuki audit-dump — OK/);
    expect(txt).toMatch(/entries:\s+1/);
    expect(txt).toMatch(/chain_valid: true/);
    expect(txt).toMatch(/\[0000\] ASSERT/);
    expect(txt).toMatch(/Exit code: 0/);
  });

  it("text format includes output audit entries without raw output", () => {
    const log = new AuditLog();
    log.append(makeLog("r-output"));
    log.append(buildOutputAuditLog({
      command: llmCommand(),
      feedback: outputFeedback(),
      rendered_output: "hello",
      target_surface: "cli",
      request_id: "r-output",
      timestamp: 1,
    }));

    const txt = formatAuditTextReport(auditDumpReportFromLog(log));
    expect(txt).toMatch(/OUTPUT:llm_raw_output/);
    expect(txt).toMatch(/surface=cli visible=true/);
    expect(txt).not.toContain("hello");
  });

  it("text format includes runtime invariant evidence entries", () => {
    const log = new AuditLog();
    const report = buildRuntimeInvariantEvidence({
      generated_at_ms: 1,
      actuals: EXPECTED_RUNTIME_INVARIANTS,
    });
    log.append({
      kind: "runtime_invariants",
      event: "runtime_invariants.evidence",
      request_id: null,
      all_ok: report.all_ok,
      report_digest: report.report_digest,
      evidence_count: report.evidence.length,
      values: report.values,
      report,
      used_for_authority: false,
      reason: "test",
      timestamp: 1,
    });

    const txt = formatAuditTextReport(auditDumpReportFromLog(log));
    expect(txt).toMatch(/INVARIANTS:pass/);
    expect(txt).toContain(report.report_digest);
  });

  it("text format for setup_error", () => {
    const r = runAuditDump({ env: {} });
    const txt = formatAuditTextReport(r);
    expect(txt).toMatch(/SETUP-ERROR/);
    expect(txt).toMatch(/Exit code: 2/);
  });

  it("json format is parseable and includes entries", () => {
    const json = formatAuditJsonReport(buildReport());
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe("ok");
    expect(parsed.entry_count).toBe(1);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries[0].log.request_id).toBe("r1");
  });

  it("uses the same report shape for live AuditLog dumps", () => {
    const log = new AuditLog();
    log.append(makeLog("live-r1"));
    const report = auditDumpReportFromLog(log, {
      timestamp: "2026-05-09T00:00:00.000Z",
    });
    expect(report.status).toBe("ok");
    expect(report.exit_code).toBe(0);
    expect(report.filepath).toBeNull();
    expect(report.entry_count).toBe(1);
    expect(report.chain_valid).toBe(true);
    expect(report.entries[0]?.log.request_id).toBe("live-r1");
  });
});
