import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLog, type AuditEntry } from "@blue-tanuki/hds-brain";
import { AUDIT_FILENAME } from "./audit_config.js";

/**
 * audit-dump — read the persisted hash-chain from disk, verify it, and emit
 * either a human-readable text report or a JSON dump of the chain.
 *
 * Design goals:
 *   - Read-only. NEVER appends, mutates, or rotates the file.
 *   - Deterministic exit code mapping:
 *       0 = chain valid (or empty: no file → emits 'empty' status, exit 0)
 *       1 = chain broken (load-time verification failed)
 *       2 = setup error (BLUE_TANUKI_AUDIT_DIR unset)
 *   - Two output formats: human-readable (default) and JSON (--json).
 *
 * What we deliberately do NOT do:
 *   - We don't accept arbitrary file paths via flag. Source of truth is
 *     BLUE_TANUKI_AUDIT_DIR + AUDIT_FILENAME, matching the gateway runtime.
 *     Letting `--audit-dump --file=/somewhere/else` would invite divergent
 *     ad-hoc audit corpora that drift from the live chain.
 *   - We don't print full DecisionLog content by default. The text view shows
 *     a one-line-per-entry summary (index, decision, hash prefix, request_id).
 *     Use --json for the full structured dump.
 */

export type AuditDumpStatus = "ok" | "empty" | "broken" | "setup_error";

export interface AuditDumpReport {
  status: AuditDumpStatus;
  exit_code: 0 | 1 | 2;
  /** Resolved file path inspected. May be null when setup_error. */
  filepath: string | null;
  /** Number of entries successfully loaded. 0 when empty/broken/setup_error. */
  entry_count: number;
  /** Whether the loaded chain verified end-to-end. False when broken. */
  chain_valid: boolean;
  /** Human-readable detail (single line). */
  detail: string;
  /** Full chain entries. Empty when status !== "ok". */
  entries: AuditEntry[];
  /** ISO-8601 UTC timestamp of dump generation. */
  timestamp: string;
}

export interface AuditDumpOptions {
  /** Override env source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface LiveAuditDumpOptions {
  /** Optional source label/path. HTTP live dumps normally use null. */
  filepath?: string | null;
  timestamp?: string;
}

/** Build the same report shape from the live in-memory/file-backed AuditLog. */
export function auditDumpReportFromLog(
  log: AuditLog,
  opts: LiveAuditDumpOptions = {},
): AuditDumpReport {
  const entries = [...log.list()];
  const chain_valid = log.verify();
  const timestamp = opts.timestamp ?? new Date().toISOString();
  if (entries.length === 0) {
    return {
      status: "empty",
      exit_code: 0,
      filepath: opts.filepath ?? null,
      entry_count: 0,
      chain_valid,
      detail: "live audit chain is empty",
      entries: [],
      timestamp,
    };
  }
  return {
    status: chain_valid ? "ok" : "broken",
    exit_code: chain_valid ? 0 : 1,
    filepath: opts.filepath ?? null,
    entry_count: entries.length,
    chain_valid,
    detail: chain_valid
      ? `loaded ${entries.length} live entries; chain verified`
      : `loaded ${entries.length} live entries; chain DOES NOT verify`,
    entries,
    timestamp,
  };
}

/**
 * Run the audit-dump procedure. Pure: no I/O beyond reading the audit file.
 */
export function runAuditDump(opts: AuditDumpOptions = {}): AuditDumpReport {
  const env = opts.env ?? process.env;
  const dir = env.BLUE_TANUKI_AUDIT_DIR;
  const timestamp = new Date().toISOString();

  if (!dir) {
    return {
      status: "setup_error",
      exit_code: 2,
      filepath: null,
      entry_count: 0,
      chain_valid: false,
      detail: "BLUE_TANUKI_AUDIT_DIR is unset; nothing to dump",
      entries: [],
      timestamp,
    };
  }

  const filepath = path.join(path.resolve(dir), AUDIT_FILENAME);

  if (!existsSync(filepath)) {
    return {
      status: "empty",
      exit_code: 0,
      filepath,
      entry_count: 0,
      chain_valid: true,
      detail: `no audit file at '${filepath}' (chain has not been written yet)`,
      entries: [],
      timestamp,
    };
  }

  // Constructing AuditLog with filepath triggers loadFromFile() which
  // throws on broken chain. We catch and surface as a structured report
  // rather than letting the CLI crash unhandled.
  try {
    const log = new AuditLog({ filepath });
    const entries = log.list();
    const valid = log.verify();
    return {
      status: valid ? "ok" : "broken",
      exit_code: valid ? 0 : 1,
      filepath,
      entry_count: entries.length,
      chain_valid: valid,
      detail: valid
        ? `loaded ${entries.length} entries; chain verified`
        : `loaded ${entries.length} entries; chain DOES NOT verify`,
      entries: [...entries],
      timestamp,
    };
  } catch (e) {
    return {
      status: "broken",
      exit_code: 1,
      filepath,
      entry_count: 0,
      chain_valid: false,
      detail: `chain load failed: ${(e as Error).message}`,
      entries: [],
      timestamp,
    };
  }
}

/** Render the report as a one-line-per-entry text view. */
export function formatAuditTextReport(report: AuditDumpReport): string {
  const lines: string[] = [];
  const status =
    report.status === "ok"
      ? "OK"
      : report.status === "empty"
      ? "EMPTY"
      : report.status === "broken"
      ? "BROKEN"
      : "SETUP-ERROR";
  lines.push(`blue-tanuki audit-dump — ${status} (${report.timestamp})`);
  lines.push(`  filepath:    ${report.filepath ?? "(none)"}`);
  lines.push(`  entries:     ${report.entry_count}`);
  lines.push(`  chain_valid: ${report.chain_valid}`);
  lines.push(`  detail:      ${report.detail}`);
  if (report.entries.length > 0) {
    lines.push("");
    lines.push("entries:");
    for (const e of report.entries) {
      const hashShort = e.entry_hash.slice(0, 12);
      if ("commit" in e.log) {
        const reqId = e.log.request_id;
        const dec = e.log.commit.decision;
        const fRefs = memoryReferenceSummary(e.log.frame.memory_trace?.hits ?? []);
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${dec.padEnd(18)} ${hashShort}… request_id=${reqId}${fRefs}`);
      } else if (e.log.kind === "executor_feedback") {
        const status = `FEEDBACK:${e.log.feedback.status}`;
        const reqId = e.log.request_id ?? "(unknown)";
        const known = e.log.known_command ? "known" : "unknown";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id} ${known}`);
      } else if (e.log.kind === "output_audit") {
        const status = `OUTPUT:${e.log.output_kind}`;
        const reqId = e.log.request_id ?? "(unknown)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id} surface=${e.log.target_surface} visible=${e.log.user_visible_output}`);
      } else if (e.log.kind === "runtime_invariants") {
        const status = e.log.all_ok ? "INVARIANTS:pass" : "INVARIANTS:fail";
        const reqId = e.log.request_id ?? "(none)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} digest=${e.log.report_digest} evidence=${e.log.evidence_count}`);
      } else if (e.log.kind === "approval_gate") {
        const ev = e.log.evaluation;
        const status = `APPROVAL:${ev.decision}`;
        const reqId = e.log.request_id ?? "(unknown)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id} op=${ev.context.operation} risk=${ev.risk} authority=${ev.authority_trace.black_box_boundary}`);
      } else if (e.log.kind === "authority_event") {
        const status = `AUTH:${e.log.event}`;
        const reqId = e.log.request_id ?? "(unknown)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id ?? "(none)"} grant_id=${e.log.grant_id ?? "(none)"} actor=${e.log.actor}`);
      } else if (e.log.kind === "memory_reference") {
        const status = `MEM:${e.log.event}`;
        const reqId = e.log.request_id ?? "(unknown)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} ref=${e.log.f_reference} used_for_authority=${e.log.used_for_authority}`);
      } else if (e.log.kind === "memory_citation_review") {
        const status = `MEM:CITATION:${e.log.status}`;
        const reqId = e.log.request_id ?? "(unknown)";
        const projectionRecords = e.log.projection_records ?? [];
        const notAdopted = projectionRecords.filter((record) => record.disposition === "not_adopted").length;
        const excluded = projectionRecords.filter((record) => record.disposition === "excluded_from_context").length;
        const dependencyVersions = e.log.dependency_versions ?? e.log.candidate_references;
        const dependencyText = dependencyVersions.length === 0
          ? "(none)"
          : dependencyVersions.map((reference) => `${reference.record_id}@${reference.version}`).join(",");
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id} candidates=${e.log.candidate_count} accepted=${e.log.accepted_citations.length} not_adopted=${notAdopted} excluded=${excluded} rejected=${e.log.rejected_proposal_count} used_for_authority=${e.log.used_for_authority} dependency_versions=${dependencyText}`);
      } else if (e.log.kind === "command_lifecycle") {
        const status = `COMMAND:${e.log.phase}`;
        const reqId = e.log.request_id ?? "(unknown)";
        lines.push(`  [${String(e.index).padStart(4, "0")}] ${status.padEnd(18)} ${hashShort}… request_id=${reqId} command_id=${e.log.command_id} actor=${e.log.actor}`);
      }
    }
  }
  lines.push("");
  lines.push(`Exit code: ${report.exit_code}`);
  return lines.join(os.EOL);
}

/** Render the report as JSON with full chain data. */
export function formatAuditJsonReport(report: AuditDumpReport): string {
  return JSON.stringify(report, null, 2);
}

function memoryReferenceSummary(
  hits: Array<{ f_reference?: string; memory_id: string }>,
): string {
  const refs = hits
    .map((hit) => hit.f_reference ?? `F:${hit.memory_id}`)
    .filter((ref, index, all) => all.indexOf(ref) === index);
  return refs.length === 0 ? "" : ` f_refs=${refs.join(",")}`;
}
