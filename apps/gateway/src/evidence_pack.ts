import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  type AuditEntry,
  type AuditLog,
  type CompleteHistoryEntry,
  type CompleteHistoryStore,
} from "@blue-tanuki/hds-brain";
import {
  auditDumpReportFromLog,
  formatAuditTextReport,
} from "./audit_dump.js";
import {
  redactEvidenceText,
  redactEvidenceValue,
  scanEvidenceForSecrets,
} from "./evidence_redaction.js";
import {
  writeEvidenceManifest,
  type EvidenceManifest,
} from "./evidence_manifest.js";

type Env = Record<string, string | undefined>;

export interface GatewayEvidencePackOptions {
  rootDir?: string;
  env?: Env;
  audit: AuditLog;
  completeHistory: CompleteHistoryStore;
  now?: Date;
  requested_by: string;
  source: "control_center" | "product_validation_fixture";
}

export interface GatewayEvidencePackResult {
  schema_version: 1;
  generated_at: string;
  pack_dir: string;
  files: string[];
  manifest: EvidenceManifest;
  retention: {
    max_packs: number;
    removed_packs: string[];
  };
  audit_chain_valid: boolean;
  complete_history_chain_valid: boolean;
  used_for_authority: false;
  hds_brain_remains_authority: true;
  evidence_source: readonly ["LIVE_RUNTIME", "INTERNAL_STATE", "EXTERNAL_EVIDENCE"];
  secret_redaction: {
    applied: true;
    scan_ok: boolean;
    findings: string[];
  };
}

interface SummaryFile {
  schema_version: 1;
  generated_at: string;
  source: GatewayEvidencePackOptions["source"];
  requested_by: string;
  audit: {
    entries_count: number;
    chain_valid: boolean;
  };
  complete_history: {
    entries_count: number;
    skipped_count: number;
    chain_valid: boolean;
    complete_history_used_for_authority: false;
  };
  authority_boundary: {
    hds_brain_owns_authority: true;
    evidence_pack_used_for_authority: false;
    audit_view_used_for_authority: false;
    complete_history_used_for_authority: false;
    ui_used_for_authority: false;
  };
  evidence_source: readonly ["LIVE_RUNTIME", "INTERNAL_STATE", "EXTERNAL_EVIDENCE"];
}

export async function createGatewayEvidencePack(
  opts: GatewayEvidencePackOptions,
): Promise<GatewayEvidencePackResult> {
  const env = opts.env ?? process.env;
  const rootDir = path.resolve(opts.rootDir ?? process.cwd());
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const evidenceRoot = evidenceRootFromEnv(env, rootDir);
  const packDir = path.join(evidenceRoot, `evidence-${safeTimestamp(generatedAt)}`);
  await mkdir(packDir, { recursive: true });

  const auditReport = auditDumpReportFromLog(opts.audit, {
    filepath: "live",
    timestamp: generatedAt,
  });
  const auditSummary = {
    schema_version: 1,
    generated_at: generatedAt,
    entries_count: auditReport.entry_count,
    chain_valid: auditReport.chain_valid,
    status: auditReport.status,
    used_for_authority: false,
    entries: auditReport.entries.map(projectAuditEntry),
  };
  const historyEntries = opts.completeHistory.all().map(projectHistoryEntry);
  const historySummary = {
    schema_version: 1,
    generated_at: generatedAt,
    entries_count: opts.completeHistory.size(),
    skipped_count: opts.completeHistory.skippedCount(),
    chain_valid: opts.completeHistory.verify(),
    complete_history_used_for_authority: false,
    entries: historyEntries,
  };
  const summary: SummaryFile = {
    schema_version: 1,
    generated_at: generatedAt,
    source: opts.source,
    requested_by: opts.requested_by,
    audit: {
      entries_count: auditSummary.entries_count,
      chain_valid: auditSummary.chain_valid,
    },
    complete_history: {
      entries_count: historySummary.entries_count,
      skipped_count: historySummary.skipped_count,
      chain_valid: historySummary.chain_valid,
      complete_history_used_for_authority: false,
    },
    authority_boundary: {
      hds_brain_owns_authority: true,
      evidence_pack_used_for_authority: false,
      audit_view_used_for_authority: false,
      complete_history_used_for_authority: false,
      ui_used_for_authority: false,
    },
    evidence_source: ["LIVE_RUNTIME", "INTERNAL_STATE", "EXTERNAL_EVIDENCE"],
  };
  const reportText = redactEvidenceText([
    "BLUE-TANUKI Evidence Pack",
    `generated_at: ${generatedAt}`,
    `source: ${opts.source}`,
    `requested_by: ${opts.requested_by}`,
    `audit_chain_valid: ${auditSummary.chain_valid}`,
    `audit_entries: ${auditSummary.entries_count}`,
    `complete_history_chain_valid: ${historySummary.chain_valid}`,
    `complete_history_entries: ${historySummary.entries_count}`,
    "used_for_authority: false",
    "hds_brain_remains_authority: true",
    "",
    "Audit summary:",
    formatAuditTextReport(auditReport),
  ].join("\n"));

  const files: Record<string, string> = {
    "summary.json": json(redactEvidenceValue(summary)),
    "audit-summary.json": json(redactEvidenceValue(auditSummary)),
    "complete-history-summary.json": json(redactEvidenceValue(historySummary)),
    "report.txt": `${reportText}\n`,
  };
  const scan = scanEvidenceForSecrets(files, secretEnvValues(env));
  if (!scan.ok) {
    await rm(packDir, { recursive: true, force: true });
    throw new Error(`evidence redaction scan failed: ${scan.findings.join(",")}`);
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), content, "utf8");
  }
  const manifest = await writeEvidenceManifest(packDir);
  const removed = await applyEvidenceRetention(
    evidenceRoot,
    retentionMaxPacks(env),
    packDir,
  );
  return {
    schema_version: 1,
    generated_at: generatedAt,
    pack_dir: packDir,
    files: Object.keys(files).sort(),
    manifest,
    retention: {
      max_packs: retentionMaxPacks(env),
      removed_packs: removed,
    },
    audit_chain_valid: auditSummary.chain_valid,
    complete_history_chain_valid: historySummary.chain_valid,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: ["LIVE_RUNTIME", "INTERNAL_STATE", "EXTERNAL_EVIDENCE"],
    secret_redaction: {
      applied: true,
      scan_ok: scan.ok,
      findings: scan.findings,
    },
  };
}

function projectAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const log = entry.log;
  const base: Record<string, unknown> = {
    index: entry.index,
    entry_hash: entry.entry_hash,
    prev_hash: entry.prev_hash,
    timestamp: "timestamp" in log ? log.timestamp : undefined,
  };
  if (!("kind" in log)) {
    return {
      ...base,
      kind: "decision",
      request_id: log.request_id,
      decision: log.commit.decision,
      commit_hash: log.commit.hash,
      memory_used_for_authority: log.frame.memory_trace?.used_for_authority ?? false,
    };
  }
  if (log.kind === "approval_gate") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id,
      command_id: log.command_id,
      decision: log.evaluation.decision,
      operation: log.evaluation.context.operation,
      risk: log.evaluation.risk,
      approval_level: log.evaluation.approval_level,
      final_review_required: log.evaluation.final_review_required,
    };
  }
  if (log.kind === "authority_event") {
    return {
      ...base,
      kind: log.kind,
      event: log.event,
      request_id: log.request_id ?? null,
      command_id: log.command_id ?? null,
      grant_id: log.grant_id ?? null,
      actor: log.actor,
    };
  }
  if (log.kind === "executor_feedback") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id ?? null,
      command_id: log.command_id,
      status: log.feedback.status,
      known_command: log.known_command,
    };
  }
  if (log.kind === "output_audit") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id ?? null,
      command_id: log.command_id,
      output_kind: log.output_kind,
      result_digest: log.result_digest,
      rendered_output_digest: log.rendered_output_digest,
      used_for_authority: log.used_for_authority,
    };
  }
  if (log.kind === "runtime_invariants") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id ?? null,
      all_ok: log.all_ok,
      report_digest: log.report_digest,
      evidence_count: log.evidence_count,
      used_for_authority: log.used_for_authority,
    };
  }
  if (log.kind === "schedule_lifecycle") {
    return {
      ...base,
      kind: log.kind,
      event: log.event,
      request_id: log.request_id ?? null,
      schedule_id: log.schedule_id,
      payload_hash: log.payload_hash,
      previous_payload_hash: log.previous_payload_hash,
    };
  }
  if (log.kind === "memory_reference") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id ?? null,
      memory_id: log.memory_id,
      f_reference: log.f_reference,
      used_for_authority: log.used_for_authority,
    };
  }
  if (log.kind === "command_lifecycle") {
    return {
      ...base,
      kind: log.kind,
      request_id: log.request_id ?? null,
      command_id: log.command_id,
      phase: log.phase,
      actor: log.actor,
    };
  }
  return { ...base, kind: "unknown" };
}

function projectHistoryEntry(entry: CompleteHistoryEntry): Record<string, unknown> {
  return {
    schema_version: entry.schema_version,
    index: entry.index,
    id: entry.id,
    kind: entry.kind,
    request_id: entry.request_id,
    command_id: entry.command_id,
    actor: entry.actor,
    source: entry.source,
    payload_digest: entry.payload_digest,
    used_for_authority: false,
    timestamp: entry.timestamp,
    prev_hash: entry.prev_hash,
    entry_hash: entry.entry_hash,
  };
}

function evidenceRootFromEnv(env: Env, rootDir: string): string {
  const configured = env.BLUE_TANUKI_EVIDENCE_DIR;
  return path.resolve(configured && configured.trim().length > 0
    ? configured
    : path.join(rootDir, ".blue-tanuki", "evidence"));
}

function retentionMaxPacks(env: Env): number {
  const raw = env.BLUE_TANUKI_EVIDENCE_RETENTION_MAX_PACKS;
  if (!raw) return 20;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
}

async function applyEvidenceRetention(
  evidenceRoot: string,
  maxPacks: number,
  currentPackDir: string,
): Promise<string[]> {
  const entries = await readdir(evidenceRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("evidence-"))
    .map((entry) => path.join(evidenceRoot, entry.name))
    .sort();
  const removable = dirs.filter((dir) => path.resolve(dir) !== path.resolve(currentPackDir));
  const removeCount = Math.max(0, dirs.length - maxPacks);
  const removed: string[] = [];
  for (const dir of removable.slice(0, removeCount)) {
    await rm(dir, { recursive: true, force: true });
    removed.push(path.basename(dir));
  }
  return removed;
}

function secretEnvValues(env: Env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTHORIZATION)/i.test(key) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value as string);
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z.-]/g, "-");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
