import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecuteCommand } from "../packages/protocol/src/index.js";
import {
  AuditLog,
  HDSUpperController,
  buildRuntimeInvariantEvidence,
  evaluateApproval,
  type DecisionLog,
} from "../packages/hds-brain/src/index.js";
import { AUDIT_FILENAME } from "../apps/gateway/src/audit_config.js";
import { runAuditVerify } from "../apps/gateway/src/audit_verify.js";

export type ProductPhase = "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P10" | "P11";
export type ProductPlatform = "linux" | "win32" | "any";
export type ProductCheckStatus = "pass" | "fail" | "skipped";

export interface ProductCheck {
  id: string;
  phase: ProductPhase;
  platform: ProductPlatform;
  required: boolean;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface CheckResult {
  status: ProductCheckStatus;
  summary: string;
  log_excerpt?: string;
  details?: Record<string, unknown>;
  raw_log?: string;
}

export interface CheckContext {
  rootDir: string;
  phase: ProductPhase;
  platform: NodeJS.Platform;
  timeoutMs: number;
  evidenceDir: string;
  runner: CommandRunner;
  shared: Map<string, unknown>;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CommandRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

export type CommandRunner = (
  spec: CommandSpec,
  timeoutMs: number,
) => Promise<CommandRunResult>;

export interface ProductValidationOptions {
  rootDir?: string;
  phase?: ProductPhase;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  evidenceDir?: string;
  runner?: CommandRunner;
  checks?: readonly ProductCheck[];
  now?: Date;
  progress?: (line: string) => void;
}

export interface CheckRunRecord {
  id: string;
  phase: ProductPhase;
  platform: ProductPlatform;
  required: boolean;
  status: ProductCheckStatus;
  duration_ms: number;
  summary: string;
  log_excerpt: string;
  details?: Record<string, unknown>;
  log_file?: string;
}

export interface ProductValidationResult {
  ok: boolean;
  phase: ProductPhase;
  evidence_dir: string;
  required: number;
  passed: number;
  failed: number;
  skipped: number;
  checks: CheckRunRecord[];
}

export interface EvidenceManifest {
  schema_version: 1;
  generated_at: string;
  manifest_excludes_self: true;
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

const PHASE_ORDER: ProductPhase[] = ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P10", "P11"];
const DEFAULT_TIMEOUT_MS = 120_000;
const TSX = "node_modules/tsx/dist/cli.mjs";

const upstream = {
  frame_goal: "product-validation",
  model_abstraction: "validate_product",
  commit_hash: "validate-product",
  commit_decision: "ASSERT" as const,
};

export const PRODUCT_CHECKS: readonly ProductCheck[] = [
  {
    id: "p2.smoke_serve",
    phase: "P2",
    platform: "any",
    required: true,
    run: runSmokeServe,
  },
  {
    id: "p2.smoke_resume",
    phase: "P2",
    platform: "any",
    required: true,
    run: runSmokeResume,
  },
  {
    id: "p2.hds_standalone",
    phase: "P2",
    platform: "any",
    required: true,
    run: runHdsStandalone,
  },
  {
    id: "p2.suspend_dynamic",
    phase: "P2",
    platform: "any",
    required: true,
    run: runSuspendDynamic,
  },
  {
    id: "p2.approval_bypass_dynamic",
    phase: "P2",
    platform: "any",
    required: true,
    run: runApprovalBypassDynamic,
  },
  {
    id: "p2.audit_chain_verify",
    phase: "P2",
    platform: "any",
    required: true,
    run: runAuditChainVerify,
  },
  {
    id: "p3.package_windows_verify",
    phase: "P3",
    platform: "win32",
    required: true,
    run: runWindowsPackageVerify,
  },
  {
    id: "p3.windows_installed_smoke",
    phase: "P3",
    platform: "win32",
    required: true,
    run: runWindowsInstalledSmoke,
  },
];

export function parseProductPhase(value: string | undefined): ProductPhase {
  if (value && (PHASE_ORDER as readonly string[]).includes(value)) return value as ProductPhase;
  throw new Error(`invalid product phase: ${value ?? "(missing)"}`);
}

export function defaultEvidenceDir(rootDir: string, now = new Date()): string {
  return path.join(rootDir, ".codex-tmp", "validate-product-evidence", now.toISOString());
}

export function filterProductChecks(
  checks: readonly ProductCheck[],
  phase: ProductPhase,
): readonly ProductCheck[] {
  const targetIndex = PHASE_ORDER.indexOf(phase);
  return checks.filter((check) => {
    const checkIndex = PHASE_ORDER.indexOf(check.phase);
    return checkIndex >= 0 && checkIndex <= targetIndex;
  });
}

export function exitCodeFromProductValidation(result: ProductValidationResult): 0 | 1 {
  return result.ok ? 0 : 1;
}

export async function runProductValidation(
  opts: ProductValidationOptions = {},
): Promise<ProductValidationResult> {
  const rootDir = path.resolve(opts.rootDir ?? process.cwd());
  const checks = opts.checks ?? PRODUCT_CHECKS;
  const phase = opts.phase ?? maxRegisteredPhase(checks);
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? timeoutFromEnv(process.env);
  const evidenceDir = path.resolve(opts.evidenceDir ?? defaultEvidenceDir(rootDir, opts.now));
  const runner = opts.runner ?? defaultCommandRunner;
  const progress = opts.progress;
  const shared = new Map<string, unknown>();
  const ctx: CheckContext = {
    rootDir,
    phase,
    platform,
    timeoutMs,
    evidenceDir,
    runner,
    shared,
  };

  await mkdir(path.join(evidenceDir, "logs"), { recursive: true });
  await writeEnvironmentEvidence(ctx, runner);

  const records: CheckRunRecord[] = [];
  for (const check of checks) {
    progress?.(`[product] START ${check.id}`);
    const started = Date.now();
    const phaseReached = phaseIndex(check.phase) <= phaseIndex(phase);
    const platformMatches = check.platform === "any" || check.platform === platform;
    let result: CheckResult;
    if (!phaseReached) {
      result = {
        status: "skipped",
        summary: `phase ${check.phase} is not reached by ${phase}`,
      };
    } else if (!platformMatches) {
      result = {
        status: "skipped",
        summary: `platform ${String(platform)} does not match ${check.platform}`,
      };
    } else {
      try {
        result = await check.run(ctx);
      } catch (error) {
        result = {
          status: "fail",
          summary: error instanceof Error ? error.message : String(error),
          raw_log: error instanceof Error ? error.stack ?? error.message : String(error),
        };
      }
    }
    const durationMs = Date.now() - started;
    const rawLog = redactForEvidence(
      result.raw_log ?? result.log_excerpt ?? result.summary,
    );
    const logFile = path.join("logs", `${safeFileName(check.id)}.log`);
    await writeFile(path.join(evidenceDir, logFile), rawLog.endsWith("\n") ? rawLog : `${rawLog}\n`, "utf8");

    records.push({
      id: check.id,
      phase: check.phase,
      platform: check.platform,
      required: check.required,
      status: result.status,
      duration_ms: durationMs,
      summary: result.summary,
      log_excerpt: result.log_excerpt ?? excerpt(rawLog),
      ...(result.details ? { details: result.details } : {}),
      log_file: logFile,
    });
    progress?.(`[product] END ${check.id} status=${result.status} duration_ms=${durationMs}`);
  }

  await writeFile(
    path.join(evidenceDir, "checks.json"),
    `${JSON.stringify(records, null, 2)}\n`,
    "utf8",
  );
  await writeEvidenceManifest(evidenceDir);

  const requiredRecords = records.filter(
    (record) => record.required && phaseIndex(record.phase) <= phaseIndex(phase),
  );
  const failed = records.filter((record) => record.status === "fail").length;
  const result: ProductValidationResult = {
    ok: failed === 0,
    phase,
    evidence_dir: evidenceDir,
    required: requiredRecords.length,
    passed: records.filter((record) => record.status === "pass").length,
    failed,
    skipped: records.filter((record) => record.status === "skipped").length,
    checks: records,
  };
  return result;
}

function phaseIndex(phase: ProductPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export async function writeEvidenceManifest(evidenceDir: string): Promise<EvidenceManifest> {
  const files = await listFiles(evidenceDir);
  const entries: EvidenceManifest["files"] = [];
  for (const file of files) {
    const rel = path.relative(evidenceDir, file).replace(/\\/g, "/");
    if (rel === "manifest.json") continue;
    const buf = await readFile(file);
    entries.push({
      path: rel,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.byteLength,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: EvidenceManifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    manifest_excludes_self: true,
    files: entries,
  };
  await writeFile(
    path.join(evidenceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export function productSummaryLine(result: ProductValidationResult): string {
  return `[product] ${result.ok ? "PASS" : "FAIL"} phase=${result.phase} required=${result.required} passed=${result.passed} failed=${result.failed} skipped=${result.skipped}`;
}

export function listProductChecks(checks: readonly ProductCheck[] = PRODUCT_CHECKS): string {
  return checks
    .map((check) => `${check.id}\tphase=${check.phase}\tplatform=${check.platform}\trequired=${check.required}`)
    .join("\n");
}

export async function defaultCommandRunner(
  spec: CommandSpec,
  timeoutMs: number,
): Promise<CommandRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const settle = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) {
          terminateProcessTree(child, "SIGKILL");
        }
      }, 2_000).unref();
      settle({
        exit_code: null,
        stdout,
        stderr,
        timed_out: true,
        duration_ms: Date.now() - started,
      });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({
        exit_code: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      settle({
        exit_code: code,
        stdout,
        stderr,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        // best-effort timeout cleanup
      });
      killer.unref();
    } catch {
      // fall through to direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // best-effort timeout cleanup
  }
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.BLUE_TANUKI_VALIDATE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function maxRegisteredPhase(checks: readonly ProductCheck[]): ProductPhase {
  let max = "P2" as ProductPhase;
  for (const check of checks) {
    if (PHASE_ORDER.indexOf(check.phase) > PHASE_ORDER.indexOf(max)) max = check.phase;
  }
  return max;
}

async function runSmokeServe(ctx: CheckContext): Promise<CheckResult> {
  const run = await runNodeScript(ctx, "scripts/smoke_serve.ts");
  const log = commandLog(run);
  const pass =
    run.exit_code === 0 &&
    log.includes("[smoke] PASS") &&
    log.includes("audit-dump OK");
  ctx.shared.set("p2.smoke_serve.audit_chain_verified", pass);
  ctx.shared.set("p2.smoke_serve.log", log);
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "smoke_serve PASS with audit-dump verification"
      : `smoke_serve failed exit=${String(run.exit_code)} timed_out=${run.timed_out}`,
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      audit_dump_verified: log.includes("audit-dump OK"),
      audit_raw_verified: log.includes("audit raw OK"),
    },
  };
}

async function runSmokeResume(ctx: CheckContext): Promise<CheckResult> {
  const run = await runNodeScript(ctx, "scripts/smoke_resume.ts");
  const log = commandLog(run);
  const pass = run.exit_code === 0 && log.includes("[smoke] PASS");
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "smoke_resume PASS"
      : `smoke_resume failed exit=${String(run.exit_code)} timed_out=${run.timed_out}`,
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      exit_code: run.exit_code,
      timed_out: run.timed_out,
    },
  };
}

async function runHdsStandalone(ctx: CheckContext): Promise<CheckResult> {
  const run = await runNodeScript(ctx, "examples/hds-brain-standalone.ts");
  const log = commandLog(run);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(run.stdout);
  } catch (error) {
    return {
      status: "fail",
      summary: `hds standalone JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      raw_log: log,
      log_excerpt: excerpt(log),
      details: { exit_code: run.exit_code },
    };
  }
  const runtimeInvariants = parsed.runtime_invariants as Record<string, unknown> | undefined;
  const allOk = parsed.all_ok === true || runtimeInvariants?.all_ok === true;
  const auditOk = parsed.audit_chain_valid === true;
  const pass = run.exit_code === 0 && allOk && auditOk;
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "hds standalone JSON all_ok/audit_chain_valid PASS"
      : "hds standalone failed runtime invariant or audit-chain check",
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      exit_code: run.exit_code,
      all_ok: allOk,
      audit_chain_valid: auditOk,
      health: parsed.health,
    },
  };
}

async function runSuspendDynamic(_ctx: CheckContext): Promise<CheckResult> {
  const conditions: Array<{
    name: string;
    controller: () => HDSUpperController;
    prepare?: (controller: HDSUpperController) => void;
  }> = [
    {
      name: "hds_available",
      controller: () => new HDSUpperController({ self_health: { hds_available: false } }),
    },
    {
      name: "policy_valid",
      controller: () => new HDSUpperController({ self_health: { policy_valid: false } }),
    },
    {
      name: "audit_chain_valid",
      controller: () => new HDSUpperController(),
      prepare: (controller) => {
        controller.decide(inbound("normal-before-audit-tamper", "product-audit-tamper-prime"));
        const entries = controller.getAudit().list() as Array<{ log: DecisionLog }>;
        entries[0]!.log.commit.reason = "tampered-by-product-gate";
      },
    },
    {
      name: "runtime_invariants_valid",
      controller: () => new HDSUpperController({
        self_health: {
          runtime_invariants: buildRuntimeInvariantEvidence({
            actuals: { process_policy_enforced: false },
          }),
        },
      }),
    },
    {
      name: "approval_gate_available",
      controller: () => new HDSUpperController({ self_health: { approval_gate_available: false } }),
    },
    {
      name: "memory_chain_valid",
      controller: () => new HDSUpperController({
        memory: {
          capture: () => undefined,
          recent: () => [],
          all: () => [],
          size: () => 0,
          verify: () => false,
        },
      }),
    },
  ];

  const observed: string[] = [];
  for (const condition of conditions) {
    const controller = condition.controller();
    condition.prepare?.(controller);
    const requestId = `product-suspend-${condition.name}`;
    const { log, command } = controller.decide(inbound("hello product validation", requestId));
    assertCheck(command === null, `${condition.name}: command emitted during fail-safe`);
    assertCheck(log.commit.decision === "SUSPEND", `${condition.name}: decision was ${log.commit.decision}`);
    assertCheck(
      log.commit.triggered_thresholds.some((threshold) => threshold.includes(`${condition.name}=false`)),
      `${condition.name}: missing fail-safe threshold`,
    );
    const suspended = controller.listSuspended().find((entry) => entry.request_id === requestId);
    assertCheck(suspended?.fail_safe === true, `${condition.name}: suspension was not fail_safe`);
    assertCheck(suspended?.resume_allowed === false, `${condition.name}: resume_allowed was not false`);
    const resumed = controller.resume(requestId, "approve", { actor: "owner" });
    assertCheck(resumed.command === null, `${condition.name}: human resume emitted a command`);
    assertCheck(resumed.log.commit.decision === "SUSPEND", `${condition.name}: human resume lifted fail-safe`);
    assertCheck(
      resumed.log.commit.reason.includes("human_resume_denied"),
      `${condition.name}: resume denial reason missing`,
    );
    observed.push(condition.name);
  }

  return {
    status: "pass",
    summary: `fail-safe SUSPEND and human-resume denial observed for ${observed.length} conditions`,
    raw_log: observed.map((name) => `${name}: SUSPEND human_resume_denied`).join("\n"),
    details: { conditions: observed },
  };
}

async function runApprovalBypassDynamic(_ctx: CheckContext): Promise<CheckResult> {
  const finalReviewCommands = [
    toolCommand("schedule.create", {
      channel: "webchat",
      target: "local-user",
      content: "product validation",
      interval_ms: 120000,
    }, ["tool:schedule.create", "schedule:create"]),
    toolCommand("github.issue.create", {
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "product validation",
    }, ["tool:github.write", "github:issues.write"]),
  ];

  for (const command of finalReviewCommands) {
    const evaluation = evaluateApproval(command, [], {
      actor: "owner",
      default_mode: "full_access",
      now: 1,
    });
    assertCheck(evaluation.final_review_required === true, `${evaluation.context.operation}: final review not required`);
    assertCheck(evaluation.approval_level === "L3_final_review", `${evaluation.context.operation}: not L3`);
    assertCheck(evaluation.decision !== "allow", `${evaluation.context.operation}: full_access allowed final review operation`);
  }

  const hds = new HDSUpperController();
  const { command } = hds.decide({
    id: "product-metadata-non-escalation",
    channel: "test",
    user: "owner",
    content: "metadata request",
    timestamp: 1,
    metadata: {
      "blue_tanuki.tool_call": {
        tool_name: "composio.search",
        arguments: {
          toolkit: "github",
          query: "grant admin",
          metadata: {
            approval: "allow",
            capabilities: ["full_access", "settings:write"],
          },
        },
      },
    },
  });
  assertCheck(command?.type === "tool_call", "metadata tool command was not emitted as tool_call");
  const caps = command.constraints?.allowed_capabilities ?? [];
  assertCheck(!caps.includes("settings:write"), "external metadata escalated settings:write");
  assertCheck(!caps.includes("full_access"), "external metadata escalated full_access");
  const metadataEvaluation = evaluateApproval(command, [], {
    actor: "owner",
    default_mode: "full_access",
    now: 1,
  });
  assertCheck(metadataEvaluation.decision !== "allow", "metadata-derived command bypassed approval");

  return {
    status: "pass",
    summary: "final-review operations and external metadata non-escalation stayed non-allow",
    raw_log: [
      "schedule.create: L3_final_review ask",
      "github.write: L3_final_review ask",
      "external metadata: no settings/full_access escalation",
    ].join("\n"),
    details: {
      final_review_operations: finalReviewCommands.length,
      metadata_allowed_capabilities: caps,
    },
  };
}

async function runAuditChainVerify(ctx: CheckContext): Promise<CheckResult> {
  const tmpAuditDir = await mkdtemp(path.join(ctx.evidenceDir, "audit-verify-"));
  const audit = new AuditLog({ filepath: path.join(tmpAuditDir, AUDIT_FILENAME) });
  audit.append(makeDecisionLog("product-audit-1"));
  audit.append(makeDecisionLog("product-audit-2"));
  const report = runAuditVerify({ env: { BLUE_TANUKI_AUDIT_DIR: tmpAuditDir } });
  const smokeServeVerified = ctx.shared.get("p2.smoke_serve.audit_chain_verified") === true;
  const pass = report.chain_valid === true && report.status === "ok" && smokeServeVerified;
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "audit chain verified through runAuditVerify and smoke_serve audit-dump"
      : "audit chain verification failed or smoke_serve audit evidence missing",
    raw_log: JSON.stringify({
      runAuditVerify: report,
      smoke_serve_audit_dump_verified: smokeServeVerified,
    }, null, 2),
    details: {
      chain_valid: report.chain_valid,
      status: report.status,
      entry_count: report.entry_count,
      smoke_serve_audit_dump_verified: smokeServeVerified,
    },
  };
}

async function runWindowsPackageVerify(ctx: CheckContext): Promise<CheckResult> {
  const packageRun = await runNodeScript(ctx, "scripts/package_windows.ts");
  const verifyRun = packageRun.exit_code === 0
    ? await runNodeScript(ctx, "scripts/verify_windows_package.ts")
    : null;
  const log = [
    "[package_windows]",
    commandLog(packageRun),
    "[verify_windows_package]",
    verifyRun ? commandLog(verifyRun) : "skipped because package_windows failed",
  ].join("\n");
  const pass =
    packageRun.exit_code === 0 &&
    verifyRun?.exit_code === 0 &&
    packageRun.stdout.includes("windows_installer=") &&
    verifyRun.stdout.includes("windows_installer_verified=");
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "Windows installer package created and verified"
      : `Windows package verification failed package_exit=${String(packageRun.exit_code)} verify_exit=${String(verifyRun?.exit_code)}`,
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      package_exit_code: packageRun.exit_code,
      verify_exit_code: verifyRun?.exit_code ?? null,
      package_timed_out: packageRun.timed_out,
      verify_timed_out: verifyRun?.timed_out ?? null,
    },
  };
}

async function runWindowsInstalledSmoke(ctx: CheckContext): Promise<CheckResult> {
  const run = await runNodeScript(ctx, "scripts/smoke_windows_installed.ts");
  const log = commandLog(run);
  const pass =
    run.exit_code === 0 &&
    log.includes("windows_installed_smoke=pass") &&
    log.includes("install_result=pass") &&
    log.includes("uninstall_result=pass");
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "Windows installed-app smoke passed install/start/gui/message/doctor/stop/uninstall"
      : `Windows installed-app smoke failed exit=${String(run.exit_code)} timed_out=${run.timed_out}`,
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      install_result: log.includes("install_result=pass"),
      launch_result: log.includes("launch_result=pass"),
      gui_result: log.includes("gui_result=pass"),
      first_message_result: log.includes("first_message_result=pass"),
      doctor_result: log.includes("doctor_result=pass"),
      uninstall_result: log.includes("uninstall_result=pass"),
    },
  };
}

async function runNodeScript(ctx: CheckContext, scriptRel: string): Promise<CommandRunResult> {
  return ctx.runner({
    command: process.execPath,
    args: [TSX, scriptRel],
    cwd: ctx.rootDir,
    env: { ...process.env },
  }, ctx.timeoutMs);
}

function commandLog(run: CommandRunResult): string {
  return [
    `[exit_code] ${String(run.exit_code)}`,
    `[timed_out] ${String(run.timed_out)}`,
    "[stdout]",
    run.stdout,
    "[stderr]",
    run.stderr,
  ].join("\n");
}

function toolCommand(
  tool_name: string,
  args: Record<string, unknown>,
  caps: string[],
): ExecuteCommand {
  return {
    id: `product-${tool_name}`,
    type: "tool_call",
    payload: { tool_name, arguments: args },
    constraints: { allowed_tools: [tool_name], allowed_capabilities: caps },
    upstream_decision: upstream,
  };
}

function inbound(content: string, id: string) {
  return {
    id,
    channel: "product-validation",
    user: "owner",
    content,
    timestamp: 1,
  };
}

function makeDecisionLog(id: string): DecisionLog {
  return {
    request_id: id,
    frame: {
      goal: "product validation",
      protected_values: [],
      world_closure: { x: [], r: [], m: [] },
      problem_definition_id: "product-validation",
    },
    model: {
      abstraction: "validate_product.audit_chain_verify",
      structure: {},
      scoring: { axis_scores: [], weights: {}, aggregate: 1 },
    },
    commit: {
      decision: "ASSERT",
      reason: "validate_product",
      hash: "validate-product",
      triggered_thresholds: [],
    },
    timestamp: 1,
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("stdout did not contain a JSON object");
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stdout JSON was not an object");
  }
  return parsed as Record<string, unknown>;
}

function assertCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function excerpt(value: string, maxLength = 2_000): string {
  const text = redactForEvidence(value.trim());
  if (text.length <= maxLength) return text;
  return text.slice(Math.max(0, text.length - maxLength));
}

export function redactForEvidence(value: string): string {
  return value
    .replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1[redacted]")
    .replace(/("(?:content|rendered_output|raw_output|payload|messages)"\s*:\s*)"([^"\\]|\\.)*"/gi, "$1\"[redacted]\"")
    .replace(/("(?:result)"\s*:\s*)\{[^}\n]*\}/gi, "$1\"[redacted]\"");
}

async function writeEnvironmentEvidence(
  ctx: CheckContext,
  runner: CommandRunner,
): Promise<void> {
  const pnpm = await safeShortCommand(runner, {
    command: "pnpm",
    args: ["--version"],
    cwd: ctx.rootDir,
    env: { ...process.env },
  });
  const gitRev = await safeShortCommand(runner, {
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: ctx.rootDir,
    env: { ...process.env },
  });
  const environment = {
    generated_at: new Date().toISOString(),
    node: process.version,
    pnpm: pnpm.trim() || null,
    git_rev: gitRev.trim() || null,
    platform: process.platform,
    arch: process.arch,
    cwd: ctx.rootDir,
    env_keys: Object.keys(process.env).sort(),
    env_values_redacted: true,
  };
  await writeFile(
    path.join(ctx.evidenceDir, "environment.json"),
    `${JSON.stringify(environment, null, 2)}\n`,
    "utf8",
  );
}

async function safeShortCommand(runner: CommandRunner, spec: CommandSpec): Promise<string> {
  try {
    const result = await runner(spec, 5_000);
    if (result.exit_code === 0) return result.stdout;
  } catch {
    // best effort environment metadata
  }
  return "";
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

async function printUsageAndExit(exitCode: 0 | 1): Promise<never> {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write([
    "Usage: pnpm validate:product -- [--phase P2] [--evidence <dir>] [--list]",
    "",
    "Options:",
    "  --phase <P2|P3|P4|P5|P6|P7|P8|P10|P11>",
    "  --evidence <dir>",
    "  --list",
    "",
  ].join(os.EOL));
  process.exit(exitCode);
}

function parseCliArgs(argv: string[]): {
  phase?: ProductPhase;
  evidenceDir?: string;
  list: boolean;
} {
  const args = argv.filter((arg) => arg !== "--");
  const parsed: { phase?: ProductPhase; evidenceDir?: string; list: boolean } = { list: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--list") {
      parsed.list = true;
    } else if (arg === "--phase") {
      parsed.phase = parseProductPhase(args[++i]);
    } else if (arg === "--evidence") {
      const value = args[++i];
      if (!value) throw new Error("--evidence requires a directory");
      parsed.evidenceDir = value;
    } else if (arg === "--help" || arg === "-h") {
      void printUsageAndExit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[product] ${error instanceof Error ? error.message : String(error)}\n`);
    await printUsageAndExit(1);
  }

  if (args.list) {
    process.stdout.write(`${listProductChecks()}\n`);
    return;
  }

  const result = await runProductValidation({
    phase: args.phase,
    evidenceDir: args.evidenceDir,
    progress: (line) => process.stdout.write(`${line}\n`),
  });
  for (const record of result.checks) {
    process.stdout.write(
      `[product] ${record.status.toUpperCase()} ${record.id} duration_ms=${record.duration_ms} ${record.summary}\n`,
    );
    if (record.status === "fail" && record.log_excerpt.trim()) {
      process.stderr.write(`[product] LOG ${record.id}\n${record.log_excerpt}\n`);
    }
  }
  process.stdout.write(`${productSummaryLine(result)}\n`);
  process.stdout.write(`[product] evidence=${result.evidence_dir}\n`);
  process.exit(exitCodeFromProductValidation(result));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`[product] crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
