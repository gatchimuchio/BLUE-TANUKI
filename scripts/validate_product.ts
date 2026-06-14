import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as net from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecuteCommand } from "../packages/protocol/src/index.js";
import {
  AuditLog,
  HDSUpperController,
  CompleteHistoryStore,
  buildRuntimeInvariantEvidence,
  buildApprovalGrant,
  evaluateApproval,
  type DecisionLog,
} from "../packages/hds-brain/src/index.js";
import { AUDIT_FILENAME } from "../apps/gateway/src/audit_config.js";
import { buildAboutSnapshot } from "../apps/gateway/src/about_surface.js";
import { buildRecoverySnapshot } from "../apps/gateway/src/recovery_surface.js";
import { runAuditVerify } from "../apps/gateway/src/audit_verify.js";
import { WebChatChannel } from "../packages/channel-webchat/src/index.js";
import {
  LLMProviderError,
  LLMRegistry,
  Executor,
  ToolRegistry,
  composioStatus,
  invokeComposioExecute,
  type LLMBackend,
  type LLMRequest,
  type LLMResponse,
  type ComposioExecuteTarget,
} from "../packages/blue-tanuki/src/index.js";
import {
  resolveLLMSecretRefs,
  secretRefKey,
  storeLlmApiKeySecret,
  type SecretProtector,
} from "../apps/gateway/src/secret_store.js";
import { buildApprovalRuntime } from "../apps/gateway/src/approval_runtime.js";
import { createGatewayEvidencePack } from "../apps/gateway/src/evidence_pack.js";
import { writeEvidenceManifest } from "../apps/gateway/src/evidence_manifest.js";
import {
  redactEvidenceText,
  scanEvidenceForSecrets,
} from "../apps/gateway/src/evidence_redaction.js";
import { loadPluginRuntime } from "../apps/gateway/src/plugin_loader.js";

export type ProductPhase = "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10" | "P11";
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

const PHASE_ORDER: ProductPhase[] = ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"];
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
    id: "p2.test_suite",
    phase: "P2",
    platform: "linux",
    required: true,
    run: runTestSuite,
  },
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
  {
    id: "p4.control_center_settings_api",
    phase: "P4",
    platform: "any",
    required: true,
    run: runControlCenterSettingsApiSmoke,
  },
  {
    id: "p5.llm_resilience_health",
    phase: "P5",
    platform: "any",
    required: true,
    run: runLLMResilienceHealth,
  },
  {
    id: "p6.approval_authority_controls",
    phase: "P6",
    platform: "any",
    required: true,
    run: runApprovalAuthorityControls,
  },
  {
    id: "p7.evidence_pack_redaction",
    phase: "P7",
    platform: "any",
    required: true,
    run: runEvidencePackRedaction,
  },
  {
    id: "p8.composio_safety_closure",
    phase: "P8",
    platform: "any",
    required: true,
    run: runComposioSafetyClosure,
  },
  {
    id: "p9.channel_operator_extension_boundary",
    phase: "P9",
    platform: "any",
    required: true,
    run: runChannelOperatorExtensionBoundary,
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

async function runTestSuite(ctx: CheckContext): Promise<CheckResult> {
  const run = await ctx.runner(
    pnpmCommandSpec(["test"], ctx.rootDir, { ...process.env }),
    ctx.timeoutMs,
  );
  const log = commandLog(run);
  const pass = run.exit_code === 0;
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "pnpm test PASS"
      : `pnpm test failed exit=${String(run.exit_code)} timed_out=${run.timed_out}`,
    raw_log: log,
    log_excerpt: excerpt(log),
    details: {
      exit_code: run.exit_code,
      timed_out: run.timed_out,
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
    log.includes("launch_result=pass") &&
    log.includes("gui_result=pass") &&
    log.includes("first_message_result=pass") &&
    log.includes("repair_install_result=pass") &&
    log.includes("stop_result=pass") &&
    log.includes("doctor_result=pass") &&
    log.includes("restart_result=pass") &&
    log.includes("port_conflict_result=pass") &&
    log.includes("crash_recovery_result=pass") &&
    log.includes("safe_mode_result=pass") &&
    log.includes("uninstall_result=pass");
  return {
    status: pass ? "pass" : "fail",
    summary: pass
      ? "Windows installed-app smoke passed install/repair/port-conflict/start/gui/message/crash-recovery/stop/doctor/restart/safe-mode/uninstall"
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
      repair_install_result: log.includes("repair_install_result=pass"),
      stop_result: log.includes("stop_result=pass"),
      doctor_result: log.includes("doctor_result=pass"),
      restart_result: log.includes("restart_result=pass"),
      port_conflict_result: log.includes("port_conflict_result=pass"),
      crash_recovery_result: log.includes("crash_recovery_result=pass"),
      safe_mode_result: log.includes("safe_mode_result=pass"),
      uninstall_result: log.includes("uninstall_result=pass"),
    },
  };
}

async function runControlCenterSettingsApiSmoke(ctx: CheckContext): Promise<CheckResult> {
  const port = await allocateLoopbackPort();
  const webchatToken = "product-webchat-token-1234";
  const resumeToken = "product-resume-token-1234";
  const settingsToken = "product-settings-token-1234";
  const updates: unknown[] = [];
  const verifications: unknown[] = [];
  const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), "bt-product-recovery-"));
  const recoveryEnvFile = path.join(recoveryRoot, "product.env");
  const recoveryAuditDir = path.join(recoveryRoot, "audit");
  const recoverySessionDir = path.join(recoveryRoot, "sessions");
  const recoveryMemoryDir = path.join(recoveryRoot, "memory");
  const recoveryFailureMemoryDir = path.join(recoveryRoot, "failure-memory");
  const recoverySchedulesDir = path.join(recoveryRoot, "schedules");
  const recoveryFileRoot = path.join(recoveryRoot, "files");
  await mkdir(recoveryAuditDir);
  await mkdir(recoverySessionDir);
  await mkdir(recoveryMemoryDir);
  await mkdir(recoveryFailureMemoryDir);
  await mkdir(recoverySchedulesDir);
  await mkdir(recoveryFileRoot);
  await writeFile(recoveryEnvFile, "LLM_BACKEND=stub\nLLM_API_KEY=product-secret\n", "utf8");
  await writeFile(`${recoveryEnvFile}.2026-06-13T00-00-00-000Z.101.settings.bak`, "backup\n", "utf8");
  const channel = new WebChatChannel({
    port,
    host: "127.0.0.1",
    token: webchatToken,
    resume_token: resumeToken,
    rate_limits: false,
    settings: {
      token: settingsToken,
      html: "<!doctype html><title>Product Settings</title>",
      getSnapshot: async () => ({
        schema_version: 1,
        env_file: "product.env",
        writable: true,
        llm: {
          provider: "stub",
          model: null,
          endpoint: null,
          api_key_set: false,
          temperature: null,
          max_tokens: null,
          timeout_ms: null,
          site_url: null,
          app_title: null,
          configured_providers: ["stub"],
          command_route: {
            backend_hint: "(provider default)",
            model: "(provider default)",
            temperature: "(provider default)",
            max_tokens: "(provider default)",
            timeout_ms: "(provider default)",
          },
        },
        integrations: {
          native_first: true,
          openrouter: {
            configured: false,
            api_key_set: false,
            model: null,
            site_url: null,
            app_title: null,
            used_for_authority: false,
          },
          composio: {
            configured: false,
            dry_run: true,
            live_execution_enabled: false,
            live_execution_available: false,
            allowed_toolkits: [],
            allowed_actions: [],
            revoked_actions: [],
            user_id_set: false,
            api_base_url: "https://backend.composio.dev",
            connection_revoke_available: false,
            toolkit_count: 0,
            action_scope_count: 0,
            revoked_action_count: 0,
            used_for_authority: false,
            metadata_used_for_authority: false,
            live_execution_used_for_authority: false,
            last_tool_call: null,
          },
        },
        webchat: {
          host: "127.0.0.1",
          port,
          token_set: true,
          resume_token_set: true,
          settings_token_set: true,
        },
        paths: {
          file_root: "sandbox",
          session_dir: "sessions",
          audit_dir: "audit",
        },
        plugins: [],
      }),
      update: async (body) => {
        updates.push(body);
        return {
          output_path: "product.env",
          restart_required: true,
          env_keys: ["LLM_BACKEND"],
        };
      },
      verifyLlm: async (body) => {
        verifications.push(body);
        return {
          status: "pass",
          changed: false,
          safe: true,
          secret_exposed: false,
          provider: "stub",
          model: "stub-v0",
          detail: "stub provider does not require external credentials",
          next_action: "Save settings only if stub is desired.",
        };
      },
    },
    about: {
      getSnapshot: async () => buildAboutSnapshot(ctx.rootDir),
    },
    recovery: {
      getSnapshot: async () => buildRecoverySnapshot({
        BLUE_TANUKI_ENV_FILE: recoveryEnvFile,
        BLUE_TANUKI_AUDIT_DIR: recoveryAuditDir,
        BLUE_TANUKI_SESSION_DIR: recoverySessionDir,
        BLUE_TANUKI_MEMORY_DIR: recoveryMemoryDir,
        BLUE_TANUKI_FAILURE_MEMORY_DIR: recoveryFailureMemoryDir,
        BLUE_TANUKI_SCHEDULES_DIR: recoverySchedulesDir,
        BLUE_TANUKI_FILE_ROOT: recoveryFileRoot,
      }),
    },
  });

  const log: string[] = [];
  try {
    await channel.start(async () => undefined);
    const base = `http://127.0.0.1:${port}`;
    const app = await fetch(`${base}/app`);
    const html = await app.text();
    assertCheck(app.status === 200, `Control Center /app returned ${app.status}`);
    assertCheck(html.includes("BLUE-TANUKI Control Center"), "Control Center HTML missing title");
    assertCheck(html.includes("settings-provider"), "Control Center HTML missing settings provider field");
    assertCheck(html.includes("connectors-token"), "Control Center HTML missing connectors token field");
    assertCheck(html.includes("composio-allowed-toolkits"), "Control Center HTML missing Composio toolkit allowlist field");
    assertCheck(html.includes("composio-allowed-actions"), "Control Center HTML missing Composio action allowlist field");
    assertCheck(html.includes("composio-revoked-actions"), "Control Center HTML missing Composio revoke field");
    assertCheck(html.includes("composio-live-execution"), "Control Center HTML missing Composio live execution field");
    assertCheck(html.includes("composio-clear-api-key"), "Control Center HTML missing Composio disconnect field");
    assertCheck(html.includes("about-token"), "Control Center HTML missing About token field");
    assertCheck(html.includes("/app/about"), "Control Center HTML missing About route");
    assertCheck(html.includes("recovery-token"), "Control Center HTML missing Recovery token field");
    assertCheck(html.includes("/recovery/snapshot"), "Control Center HTML missing Recovery route");
    assertCheck(html.includes("/settings/config"), "Control Center HTML missing settings config route");
    assertCheck(html.includes("/settings/llm/verify"), "Control Center HTML missing LLM verify route");
    log.push("/app: control center settings, connectors, about, and recovery forms rendered");

    const unauth = await fetch(`${base}/settings/config`);
    assertCheck(unauth.status === 401, `/settings/config without token returned ${unauth.status}`);
    const wrongToken = await fetch(`${base}/settings/config`, {
      headers: { authorization: `Bearer ${webchatToken}` },
    });
    assertCheck(wrongToken.status === 401, `/settings/config with webchat token returned ${wrongToken.status}`);
    log.push("/settings/config: dedicated token required");

    const aboutUnauth = await fetch(`${base}/app/about`);
    assertCheck(aboutUnauth.status === 401, `/app/about without token returned ${aboutUnauth.status}`);
    const aboutWrongToken = await fetch(`${base}/app/about`, {
      headers: { authorization: `Bearer ${settingsToken}` },
    });
    assertCheck(aboutWrongToken.status === 401, `/app/about with settings token returned ${aboutWrongToken.status}`);
    const aboutPost = await fetch(`${base}/app/about`, {
      method: "POST",
      headers: { authorization: `Bearer ${webchatToken}` },
    });
    assertCheck(aboutPost.status === 405, `/app/about POST returned ${aboutPost.status}`);
    const about = await settingsRequest(base, webchatToken, "GET", "/app/about");
    assertCheck(about.product_name === "BLUE-TANUKI", "About snapshot product name mismatch");
    assertCheck(about.package?.version === "1.0.0-rc.1", "About snapshot version mismatch");
    assertCheck(about.package?.license === "MIT", "About snapshot license mismatch");
    assertCheck(about.release?.owner_go === "pending", "About snapshot owner GO state mismatch");
    assertCheck(about.release?.public_claim_allowed === false, "About snapshot unexpectedly allowed public claim");
    assertCheck(about.claim_boundary?.signed_native_installer === "not shipped", "About snapshot signed installer boundary mismatch");
    assertCheck(about.claim_boundary?.automatic_updater === "not shipped", "About snapshot updater boundary mismatch");
    assertCheck(about.authority_boundary?.hds_brain_owns_authority === true, "About snapshot missing HDS authority boundary");
    assertCheck(about.authority_boundary?.ui_used_for_authority === false, "About snapshot made UI authority");
    assertCheck(about.authority_boundary?.claim_metadata_used_for_authority === false, "About snapshot made claim metadata authority");
    assertCheck(about.authority_boundary?.used_for_authority === false, "About snapshot authority flag mismatch");
    log.push("/app/about: read-only pre-GO claim/license boundary loaded through webchat token gate");

    const recoveryUnauth = await fetch(`${base}/recovery/snapshot`);
    assertCheck(recoveryUnauth.status === 401, `/recovery/snapshot without token returned ${recoveryUnauth.status}`);
    const recoveryWrongToken = await fetch(`${base}/recovery/snapshot`, {
      headers: { authorization: `Bearer ${settingsToken}` },
    });
    assertCheck(recoveryWrongToken.status === 401, `/recovery/snapshot with settings token returned ${recoveryWrongToken.status}`);
    const recoveryPost = await fetch(`${base}/recovery/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${webchatToken}` },
    });
    assertCheck(recoveryPost.status === 405, `/recovery/snapshot POST returned ${recoveryPost.status}`);
    const recovery = await settingsRequest(base, webchatToken, "GET", "/recovery/snapshot");
    assertCheck(recovery.surface === "recovery", "Recovery snapshot surface mismatch");
    assertCheck(recovery.mode === "read_only", "Recovery snapshot was not read-only");
    assertCheck(recovery.env_file?.exists === true, "Recovery snapshot env file missing");
    assertCheck(recovery.env_file?.backup_count >= 1, "Recovery snapshot did not report env backup inventory");
    assertCheck(recovery.env_file?.secret_material === true, "Recovery snapshot did not mark env backups secret-bearing");
    assertCheck(recovery.restore?.execution_available === false, "Recovery snapshot unexpectedly exposed restore execution");
    assertCheck(recovery.restore?.factory_reset_available === false, "Recovery snapshot unexpectedly exposed factory reset");
    assertCheck(recovery.restore?.destructive_repair_available === false, "Recovery snapshot unexpectedly exposed destructive repair");
    assertCheck(recovery.authority_boundary?.ui_used_for_authority === false, "Recovery snapshot made UI authority");
    assertCheck(recovery.authority_boundary?.recovery_metadata_used_for_authority === false, "Recovery snapshot made recovery metadata authority");
    assertCheck(recovery.authority_boundary?.used_for_authority === false, "Recovery snapshot authority flag mismatch");
    assertCheck(recovery.runtime_paths?.audit_dir?.exists === true, "Recovery snapshot audit dir missing");
    log.push("/recovery/snapshot: read-only backup inventory loaded through webchat token gate");

    const snapshot = await settingsRequest(base, settingsToken, "GET", "/settings/config");
    const snapshotText = JSON.stringify(snapshot);
    assertCheck(snapshot.llm?.provider === "stub", "settings snapshot did not expose stub provider");
    assertCheck(snapshot.integrations?.composio?.used_for_authority === false, "Composio snapshot did not preserve non-authority flag");
    assertCheck(snapshot.integrations?.composio?.live_execution_available === false, "Composio snapshot unexpectedly exposed live execution");
    assertCheck(!snapshotText.includes(settingsToken), "settings snapshot exposed settings token");
    log.push("/settings/config: redacted snapshot loaded");

    const verify = await settingsRequest(base, settingsToken, "POST", "/settings/llm/verify", {
      llm: { provider: "stub", api_key: "candidate-secret-value" },
    });
    assertCheck(verify.ok === true, "settings LLM verify did not return ok");
    assertCheck(verify.result?.status === "pass", "settings LLM verify did not pass");
    assertCheck(verifications.length === 1, "settings LLM verify handler was not called once");
    assertCheck(!JSON.stringify(verify).includes("candidate-secret-value"), "settings LLM verify response exposed candidate secret");
    log.push("/settings/llm/verify: non-mutating verification passed");

    const save = await settingsRequest(base, settingsToken, "POST", "/settings/config", {
      llm: { provider: "stub", model: "" },
    });
    assertCheck(save.ok === true, "settings save did not return ok");
    assertCheck(save.result?.restart_required === true, "settings save did not report restart_required");
    assertCheck(updates.length === 1, "settings update handler was not called once");
    log.push("/settings/config: explicit save routed to settings update handler");

    const connectorSave = await settingsRequest(base, settingsToken, "POST", "/settings/config", {
      composio: {
        api_key: "composio-candidate-secret",
        allowed_toolkits: "github,gmail",
        allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
        revoked_actions: "github:GITHUB_DELETE_REPO",
        user_id: "owner-local",
        dry_run: "false",
        live_execution: "true",
      },
    });
    assertCheck(connectorSave.ok === true, "Composio save did not return ok");
    assertCheck(connectorSave.result?.restart_required === true, "Composio save did not report restart_required");
    assertCheck(updates.length === 2, "Composio settings update handler was not called");
    assertCheck(!JSON.stringify(connectorSave).includes("composio-candidate-secret"), "Composio save response exposed candidate secret");
    log.push("/settings/config: Composio allowlist/dry-run save routed through settings token gate");

    return {
      status: "pass",
      summary: "Control Center settings/connectors/about/recovery API smoke passed token-gated load/verify/save boundaries",
      raw_log: log.join("\n"),
      details: {
        app_rendered: true,
        settings_token_required: true,
        snapshot_redacted: true,
        composio_non_authority: true,
        composio_live_execution_available: false,
        about_public_claim_allowed: false,
        about_non_authority: true,
        recovery_restore_available: false,
        recovery_env_backup_count: recovery.env_file?.backup_count ?? 0,
        recovery_non_authority: true,
        verify_calls: verifications.length,
        update_calls: updates.length,
      },
    };
  } finally {
    await channel.stop();
    await rm(recoveryRoot, { recursive: true, force: true });
  }
}

async function runLLMResilienceHealth(): Promise<CheckResult> {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "bt-product-llm-secret-"));
  const fakeProtector: SecretProtector = {
    protect: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64url"),
    unprotect: (protectedValue) => {
      const decoded = Buffer.from(protectedValue, "base64url").toString("utf8");
      if (!decoded.startsWith("protected:")) throw new Error("bad product secret fixture");
      return decoded.slice("protected:".length);
    },
  };

  class FixtureBackend implements LLMBackend {
    readonly seen: LLMRequest[] = [];

    constructor(
      readonly name: string,
      private failuresRemaining: number,
    ) {}

    async call(req: LLMRequest): Promise<LLMResponse> {
      this.seen.push(req);
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        throw new LLMProviderError(`${this.name} synthetic 503`, {
          provider: this.name,
          kind: "remote_service_unavailable",
          retryable: true,
          status: 503,
        });
      }
      return {
        content: `fixture:${this.name}`,
        tokens_used: 1,
        model: this.name,
      };
    }
  }

  try {
    const retryBackend = new FixtureBackend("primary", 1);
    const retryRegistry = new LLMRegistry({
      retry: { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0 },
      sleep: async () => undefined,
      now: () => Date.parse("2026-06-13T00:00:00.000Z"),
    }).register(retryBackend);
    const retryResponse = await retryRegistry.call({
      messages: [{ role: "user", content: "fixture retry" }],
    });
    const retryHealth = retryRegistry.healthSnapshot();
    assertCheck(retryResponse.content === "fixture:primary", "LLM retry fixture did not return primary response");
    assertCheck(retryBackend.seen.length === 2, "LLM retry fixture did not retry exactly once");
    assertCheck(retryHealth.providers[0]?.state === "pass", "LLM retry health did not record pass");
    assertCheck(
      retryHealth.authority_boundary.used_for_authority === false,
      "LLM retry health became authority",
    );

    const fallbackPrimary = new FixtureBackend("primary", 1);
    const fallbackBackend = new FixtureBackend("stub", 0);
    const fallbackRegistry = new LLMRegistry({
      retry: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 },
      sleep: async () => undefined,
      now: () => Date.parse("2026-06-13T00:00:01.000Z"),
    })
      .register(fallbackPrimary)
      .register(fallbackBackend)
      .setDefault("primary")
      .setFallback("stub");
    const fallbackResponse = await fallbackRegistry.call({
      messages: [{ role: "user", content: "fixture fallback" }],
    });
    const fallbackHealth = fallbackRegistry.healthSnapshot();
    const primaryHealth = fallbackHealth.providers.find((provider) => provider.name === "primary");
    const stubHealth = fallbackHealth.providers.find((provider) => provider.name === "stub");
    assertCheck(fallbackResponse.content === "fixture:stub", "LLM fallback fixture did not use fallback");
    assertCheck(fallbackPrimary.seen.length === 1, "LLM fallback primary call count mismatch");
    assertCheck(fallbackBackend.seen.length === 1, "LLM fallback backend call count mismatch");
    assertCheck(primaryHealth?.state === "fail", "LLM fallback health did not record primary failure");
    assertCheck(stubHealth?.state === "pass", "LLM fallback health did not record fallback pass");
    assertCheck(stubHealth?.used_for_authority === false, "LLM fallback health became authority");
    assertCheck(
      fallbackHealth.authority_boundary.provider_metadata_used_for_authority === false,
      "LLM provider metadata became authority",
    );

    const storedSecret = storeLlmApiKeySecret(
      "OPENROUTER_API_KEY",
      "product-openrouter-secret",
      {
        envFilePath: path.join(secretRoot, "blue-tanuki.env"),
        platform: "linux",
        protector: fakeProtector,
      },
    );
    const resolvedSecretEnv = resolveLLMSecretRefs(
      { [secretRefKey("OPENROUTER_API_KEY")]: storedSecret.ref },
      { platform: "linux", protector: fakeProtector },
    );
    assertCheck(
      storedSecret.os_protected === true && storedSecret.used_for_authority === false,
      "LLM secret ref fixture did not preserve non-authority protected metadata",
    );
    assertCheck(
      resolvedSecretEnv.OPENROUTER_API_KEY === "product-openrouter-secret",
      "LLM secret ref fixture did not resolve secret material",
    );
    assertCheck(
      !storedSecret.ref.includes("product-openrouter-secret"),
      "LLM secret ref exposed secret material",
    );

    return {
      status: "pass",
      summary: "LLM retry/fallback/error classification/secret-ref health fixture passed",
      raw_log: [
        "retry: remote_service_unavailable retried once and recovered",
        "fallback: explicit fallback backend used after retryable default backend failure",
        "secret-ref: LLM API key ref round-trip verified with fixture protector",
        "authority: LLM output/provider/health/secret metadata used_for_authority=false",
      ].join("\n"),
      details: {
        retry_attempts: retryBackend.seen.length,
        fallback_primary_attempts: fallbackPrimary.seen.length,
        fallback_backend_attempts: fallbackBackend.seen.length,
        fallback_backend: fallbackHealth.fallback_backend,
        retry_policy_max_attempts: retryHealth.retry_policy.max_attempts,
        secret_ref_key: storedSecret.ref_key,
        secret_ref_os_protected: storedSecret.os_protected,
        llm_output_used_for_authority: false,
        provider_metadata_used_for_authority: false,
        health_metadata_used_for_authority: false,
        secret_metadata_used_for_authority: false,
        evidence_source: ["INTERNAL_STATE", "FIXTURE"],
      },
    };
  } finally {
    await rm(secretRoot, { recursive: true, force: true });
  }
}

async function runApprovalAuthorityControls(): Promise<CheckResult> {
  const log: string[] = [];
  const runtime = buildApprovalRuntime({
    BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
  });

  const fileWrite = toolCommand(
    "file.write",
    { path: "docs/product-validation.md", content: "fixture" },
    ["tool:file.write", "fs:write"],
  );
  const defaultAllow = evaluateApproval(fileWrite, [], {
    actor: "owner",
    default_mode: "full_access",
    now: 1,
  });
  assertCheck(defaultAllow.decision === "allow", "full_access did not allow non-final-review L2 operation");
  assertCheck(defaultAllow.approval_level === "L2_operate", "file.write was not L2");
  log.push("allow: full_access permitted L2 file.write without final-review bypass");

  const scheduleCreate = toolCommand(
    "schedule.create",
    {
      channel: "webchat",
      target: "owner",
      content: "product validation",
      interval_ms: 120000,
    },
    ["tool:schedule.create", "schedule:create"],
  );
  const finalReviewAsk = evaluateApproval(scheduleCreate, [], {
    actor: "owner",
    default_mode: "full_access",
    now: 1,
  });
  assertCheck(finalReviewAsk.decision === "ask", "full_access allowed L3 schedule.create");
  assertCheck(finalReviewAsk.final_review_required === true, "schedule.create final review was not required");
  assertCheck(finalReviewAsk.approval_level === "L3_final_review", "schedule.create was not L3");
  log.push("ask: L3 schedule.create remained final-review ask under full_access");

  runtime.store.add(buildApprovalGrant({
    mode: "remember_this_decision",
    decision: "deny",
    operation: "tool.file.write",
    target_scope: "file",
    target: "docs/product-validation.md",
    path_pattern: "docs/product-validation.md",
    risk: "medium",
    actor: "owner",
    created_by: "product-validation",
    created_at: 1,
    expires_at: null,
  }));
  const denied = runtime.evaluate(fileWrite, "owner");
  assertCheck(denied.decision === "deny", "explicit deny grant did not deny file.write");
  log.push("deny: explicit deny grant overrode ask/full-access paths");

  const rememberRuntime = buildApprovalRuntime({
    BLUE_TANUKI_APPROVAL_MODE: "ask_every_time",
  });
  const rememberedEval = rememberRuntime.evaluate(fileWrite, "owner");
  assertCheck(rememberedEval.decision === "ask", "ask_every_time did not ask before remembering");
  const rememberedGrant = rememberRuntime.remember(rememberedEval, {
    actor: "owner",
    mode: "remember_this_decision",
    duration_ms: null,
    note: "product validation remembered grant",
  });
  const rememberedAllow = rememberRuntime.evaluate(fileWrite, "owner");
  assertCheck(rememberedAllow.decision === "allow", "remembered grant did not allow matching L2 operation");
  assertCheck(rememberRuntime.revoke(rememberedGrant.id) === true, "remembered grant revoke returned false");
  const afterRevoke = rememberRuntime.evaluate(fileWrite, "owner");
  assertCheck(afterRevoke.decision === "ask", "revoked grant still allowed matching operation");
  log.push("revoke: remembered L2 grant allowed then reverted to ask after revoke");

  const fullAccessGrant = buildApprovalGrant({
    mode: "full_access",
    decision: "allow",
    operation: "*",
    target_scope: "*",
    risk: "*",
    actor: "*",
    created_by: "product-validation",
    created_at: 1,
    expires_at: null,
  });
  const fullAccessFinalReview = evaluateApproval(scheduleCreate, [fullAccessGrant], {
    actor: "owner",
    default_mode: "full_access",
    now: 1,
  });
  assertCheck(fullAccessFinalReview.decision === "ask", "full_access grant bypassed L3 final review");
  log.push("bypass: reusable full_access grant could not bypass L3 final review");

  const port = await allocateLoopbackPort();
  const webchatToken = "p6-webchat-token-1234";
  const resumeToken = "p6-resume-token-1234";
  let emergencyActive = false;
  let executedInbound = 0;
  let blockedInbound = 0;
  let revokedGrant = false;
  const channel = new WebChatChannel({
    port,
    host: "127.0.0.1",
    token: webchatToken,
    resume_token: resumeToken,
    rate_limits: false,
    approval: {
      list: async () => [],
      grants: async () => [
        {
          id: "p6-grant",
          mode: "remember_this_decision",
          decision: "allow",
          operation: "tool.file.write",
          target_scope: "file",
          target: "docs/product-validation.md",
          risk: "medium",
          actor: "owner",
          created_by: "product-validation",
          created_at: 1,
          expires_at: null,
          revocable: true,
        },
      ].filter(() => !revokedGrant),
      revokeGrant: async (grant_id, controlCtx) => {
        assertCheck(grant_id === "p6-grant", "unexpected grant id routed to revoke");
        assertCheck(controlCtx.token_kind === "resume", "revoke was not resume-token context");
        revokedGrant = true;
        return {
          grant_id,
          revoked: true,
          used_for_authority: false,
        };
      },
      history: async () => [
        {
          index: 1,
          event: revokedGrant ? "grant_revoked" : "policy_evaluation",
          request_id: null,
          command_id: null,
          grant_id: revokedGrant ? "p6-grant" : undefined,
          actor: "owner",
          decision: revokedGrant ? "allow" : "ask",
          operation: "tool.file.write",
          risk: "medium",
          approval_level: "L2_operate",
          final_review_required: false,
          reason: "product validation",
          timestamp: 1,
          payload_digest: "p6-digest",
          used_for_authority: false,
        },
      ],
      emergencyStop: {
        getSnapshot: async () => ({
          active: emergencyActive,
          activated_at: emergencyActive ? 2 : null,
          activated_by: emergencyActive ? "owner" : null,
          reason: emergencyActive ? "product validation stop" : null,
          cleared_at: emergencyActive ? null : 3,
          cleared_by: emergencyActive ? null : "owner",
          clear_reason: emergencyActive ? null : "product validation clear",
          execution_blocked: emergencyActive,
          hds_brain_remains_authority: true,
          used_for_authority: false,
          evidence_source: ["INTERNAL_STATE", "LIVE_RUNTIME"],
        }),
        activate: async (controlCtx) => {
          assertCheck(controlCtx.token_kind === "resume", "emergency activate was not resume-token context");
          emergencyActive = true;
          return { active: true, used_for_authority: false };
        },
        clear: async (controlCtx) => {
          assertCheck(controlCtx.token_kind === "resume", "emergency clear was not resume-token context");
          emergencyActive = false;
          return { active: false, used_for_authority: false };
        },
      },
    },
  });

  try {
    await channel.start(async () => {
      if (emergencyActive) {
        blockedInbound += 1;
        return;
      }
      executedInbound += 1;
    });
    const base = `http://127.0.0.1:${port}`;

    const approvalWrongToken = await fetch(`${base}/approval`, {
      headers: { authorization: `Bearer ${webchatToken}` },
    });
    assertCheck(approvalWrongToken.status === 401, `/approval accepted webchat token: ${approvalWrongToken.status}`);

    const approvalRoot = await settingsRequest(base, resumeToken, "GET", "/approval");
    assertCheck(Array.isArray(approvalRoot.pending_approvals), "/approval did not return pending_approvals");
    assertCheck(approvalRoot.grants?.[0]?.id === "p6-grant", "/approval did not expose reusable grant");
    assertCheck(approvalRoot.approval_history?.[0]?.used_for_authority === false, "/approval history became authority");
    assertCheck(approvalRoot.emergency_stop?.used_for_authority === false, "/approval emergency stop became authority");

    const inboundBeforeStop = await fetch(`${base}/inbound`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${webchatToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user: "owner", content: "hello before stop" }),
    });
    assertCheck(inboundBeforeStop.status === 202, `/inbound before stop returned ${inboundBeforeStop.status}`);
    assertCheck(executedInbound === 1, "inbound before emergency stop did not reach handler");

    const stop = await settingsRequest(base, resumeToken, "POST", "/approval/emergency-stop", {
      action: "activate",
      actor: "owner",
      reason: "product validation stop",
    });
    assertCheck(stop.ok === true, "emergency stop activation did not return ok");
    assertCheck(stop.result?.active === true, "emergency stop did not activate");

    const inboundDuringStop = await fetch(`${base}/inbound`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${webchatToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user: "owner", content: "hello during stop" }),
    });
    assertCheck(inboundDuringStop.status === 202, `/inbound during stop returned ${inboundDuringStop.status}`);
    assertCheck(executedInbound === 1, "emergency stop fixture allowed execution handler path");
    assertCheck(blockedInbound === 1, "emergency stop fixture did not block handler path");

    const revoke = await settingsRequest(base, resumeToken, "POST", "/approval/grants/p6-grant/revoke", {
      actor: "owner",
      reason: "product validation revoke",
    });
    assertCheck(revoke.ok === true, "grant revoke did not return ok");
    assertCheck(revokedGrant === true, "grant revoke handler did not run");
    const grantsAfterRevoke = await settingsRequest(base, resumeToken, "GET", "/approval/grants");
    assertCheck(grantsAfterRevoke.grants.length === 0, "revoked grant still listed");

    const clear = await settingsRequest(base, resumeToken, "POST", "/approval/emergency-stop", {
      action: "clear",
      actor: "owner",
      reason: "product validation clear",
    });
    assertCheck(clear.ok === true, "emergency stop clear did not return ok");
    assertCheck(clear.result?.active === false, "emergency stop did not clear");
    log.push("live-route: resume-token gated grant revoke and emergency stop endpoints passed");

    return {
      status: "pass",
      summary: "approval allow/ask/deny/revoke/emergency-stop dynamic controls passed",
      raw_log: log.join("\n"),
      details: {
        allow_decision: defaultAllow.decision,
        ask_decision: finalReviewAsk.decision,
        deny_decision: denied.decision,
        revoke_returned_to: afterRevoke.decision,
        final_review_bypass_allowed: false,
        webchat_resume_token_required: true,
        emergency_stop_blocked_inbound: blockedInbound,
        execution_count_after_stop: executedInbound,
        grant_revoked: revokedGrant,
        evidence_source: ["INTERNAL_STATE", "LIVE_RUNTIME", "FIXTURE"],
        hds_brain_remains_authority: true,
      },
    };
  } finally {
    await channel.stop();
  }
}

async function runEvidencePackRedaction(ctx: CheckContext): Promise<CheckResult> {
  const evidenceRoot = path.join(ctx.evidenceDir, "p7-runtime-evidence-root");
  await mkdir(path.join(evidenceRoot, "evidence-2026-01-01T00.00.00.000Z"), { recursive: true });
  await mkdir(path.join(evidenceRoot, "evidence-2026-01-02T00.00.00.000Z"), { recursive: true });
  await mkdir(path.join(evidenceRoot, "evidence-2026-01-03T00.00.00.000Z"), { recursive: true });

  const hds = new HDSUpperController();
  const decision = hds.decide(inbound("p7 fixture content with product-secret-value", "p7-evidence-request"));
  hds.onRuntimeInvariantsEvidence({ request_id: decision.log.request_id, reason: "p7_product_validation" });
  const completeHistory = new CompleteHistoryStore();
  completeHistory.append({
    kind: "user_input",
    request_id: "p7-evidence-request",
    actor: "owner",
    source: "product-validation-fixture",
    payload: {
      content: "raw user payload product-secret-value",
      token: "product-token-value",
      api_key: "product-api-key-value",
    },
    timestamp: Date.parse("2026-06-14T00:00:00.000Z"),
  });
  completeHistory.append({
    kind: "final_output",
    request_id: "p7-evidence-request",
    command_id: decision.command?.id ?? null,
    actor: "owner",
    source: "product-validation-fixture",
    payload: {
      rendered_output: "visible output product-secret-value",
      result: { secret: "product-secret-value" },
    },
    timestamp: Date.parse("2026-06-14T00:00:01.000Z"),
  });

  const pack = await createGatewayEvidencePack({
    rootDir: ctx.rootDir,
    env: {
      BLUE_TANUKI_EVIDENCE_DIR: evidenceRoot,
      BLUE_TANUKI_EVIDENCE_RETENTION_MAX_PACKS: "2",
      WEBCHAT_TOKEN: "product-token-value",
      OPENROUTER_API_KEY: "product-api-key-value",
      PRODUCT_SECRET_FIXTURE: "product-secret-value",
    },
    audit: hds.getAudit(),
    completeHistory,
    now: new Date("2026-06-14T00:00:02.000Z"),
    requested_by: "product-validation",
    source: "product_validation_fixture",
  });

  assertCheck(pack.used_for_authority === false, "evidence pack became authority");
  assertCheck(pack.hds_brain_remains_authority === true, "evidence pack did not preserve HDS authority flag");
  assertCheck(pack.audit_chain_valid === true, "evidence pack audit chain was invalid");
  assertCheck(pack.complete_history_chain_valid === true, "evidence pack complete-history chain was invalid");
  assertCheck(pack.secret_redaction.scan_ok === true, `evidence pack secret scan failed: ${pack.secret_redaction.findings.join(",")}`);
  assertCheck(pack.retention.max_packs === 2, "evidence retention max did not apply");
  assertCheck(pack.retention.removed_packs.length === 2, "evidence retention did not remove old packs");

  const requiredFiles = ["summary.json", "audit-summary.json", "complete-history-summary.json", "report.txt"];
  for (const rel of requiredFiles) {
    assertCheck(pack.manifest.files.some((file) => file.path === rel), `manifest missing ${rel}`);
  }
  const fileTexts = await Promise.all(
    [...requiredFiles, "manifest.json"].map((rel) => readFile(path.join(pack.pack_dir, rel), "utf8")),
  );
  const joined = fileTexts.join("\n");
  const scan = scanEvidenceForSecrets(joined, [
    "product-secret-value",
    "product-token-value",
    "product-api-key-value",
  ]);
  assertCheck(scan.ok, `exported evidence leaked secret material: ${scan.findings.join(",")}`);
  assertCheck(joined.includes("BLUE-TANUKI Evidence Pack"), "human-readable evidence report missing title");
  assertCheck(joined.includes("complete_history_used_for_authority"), "history authority flag missing from evidence");
  assertCheck(!joined.includes("raw user payload product-secret-value"), "raw complete-history payload leaked");

  return {
    status: "pass",
    summary: "evidence pack export, retention, human report, manifest, and secret redaction passed",
    raw_log: [
      `pack_dir=${pack.pack_dir}`,
      `files=${pack.manifest.files.map((file) => file.path).join(",")}`,
      `removed=${pack.retention.removed_packs.join(",")}`,
      `secret_scan_ok=${pack.secret_redaction.scan_ok}`,
      `used_for_authority=${pack.used_for_authority}`,
    ].join("\n"),
    details: {
      pack_dir: pack.pack_dir,
      manifest_files: pack.manifest.files.map((file) => file.path),
      removed_packs: pack.retention.removed_packs,
      audit_chain_valid: pack.audit_chain_valid,
      complete_history_chain_valid: pack.complete_history_chain_valid,
      secret_redaction_scan_ok: pack.secret_redaction.scan_ok,
      evidence_source: pack.evidence_source,
      used_for_authority: pack.used_for_authority,
      hds_brain_remains_authority: pack.hds_brain_remains_authority,
    },
  };
}

async function runComposioSafetyClosure(): Promise<CheckResult> {
  const log: string[] = [];
  const env = {
    COMPOSIO_API_KEY: "composio-product-secret",
    COMPOSIO_ALLOWED_TOOLKITS: "github",
    COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
    COMPOSIO_USER_ID: "owner-local",
    COMPOSIO_DRY_RUN: "false",
    COMPOSIO_LIVE_EXECUTION: "true",
  };
  const status = composioStatus(env);
  assertCheck(status.live_execution_available === true, "Composio status did not expose live availability after explicit gates");
  assertCheck(status.used_for_authority === false, "Composio status became authority");
  assertCheck(status.metadata_used_for_authority === false, "Composio metadata became authority");
  assertCheck(status.live_execution_used_for_authority === false, "Composio live status became authority");
  assertCheck(!JSON.stringify(status).includes("composio-product-secret"), "Composio status exposed API key");
  log.push("status: live execution available only after api key, user id, dry-run false, live opt-in, toolkit/action allowlists");

  let dryRunRequestCalled = false;
  const dryRunResult = await invokeComposioExecute(
    { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", payload: { title: "dry run" } },
    {
      env: { ...env, COMPOSIO_DRY_RUN: "true" },
      request: async () => {
        dryRunRequestCalled = true;
        throw new Error("dry-run must not call external request");
      },
    },
  ) as Record<string, unknown>;
  assertCheck(dryRunResult.external_call_performed === false, "Composio dry-run performed external call");
  assertCheck(dryRunRequestCalled === false, "Composio dry-run reached request adapter");
  log.push("dry-run: explicit action allowlist still produced external_call_performed=false");

  let revokedBlocked = false;
  try {
    await invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", payload: { title: "blocked" } },
      {
        env: {
          ...env,
          COMPOSIO_REVOKED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
        },
      },
    );
  } catch (error) {
    revokedBlocked = /revoked/.test(error instanceof Error ? error.message : String(error));
  }
  assertCheck(revokedBlocked, "Composio revoked action was not blocked");
  log.push("revoke: action denylist blocked before external request");

  const hds = new HDSUpperController();
  const { log: decisionLog, command } = hds.decide(
    inbound(
      'tool:composio.execute toolkit=github tool=GITHUB_CREATE_AN_ISSUE payload="{\\"title\\":\\"hello\\"}"',
      "p8-composio-live",
    ),
  );
  assertCheck(command?.type === "tool_call", "Composio HDS route did not emit tool_call");
  assertCheck(command.payload.tool_name === "composio.execute", "Composio HDS route emitted wrong tool");
  const approval = evaluateApproval(command, [], {
    actor: "owner",
    default_mode: "full_access",
    now: 1,
  });
  assertCheck(approval.approval_level === "L3_final_review", "Composio execute was not L3 final review");
  assertCheck(approval.final_review_required === true, "Composio execute did not require final review");
  assertCheck(approval.decision === "ask", "Composio execute bypassed final review under full_access");
  hds.onApprovalEvaluation(approval, { request_id: decisionLog.request_id });
  log.push("approval: HDS route required L3 final review and did not auto-allow");

  let seen: ComposioExecuteTarget | null = null;
  const tools = new ToolRegistry();
  tools.register({
    name: "composio.execute",
    description: "product validation Composio fixture",
    required_capabilities: [
      "tool:composio.execute",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
      "external:send",
    ],
    invoke: async (args) => invokeComposioExecute(args, {
      env,
      request: async (target) => {
        seen = target;
        return {
          status: 200,
          ok: true,
          content_type: "application/json",
          body: JSON.stringify({ data: { id: "issue-fixture", status: "ok" }, log_id: "log_product" }),
          truncated: false,
          request_id: "req_product",
        };
      },
    }),
  });
  const llm: LLMBackend = {
    async call(): Promise<LLMResponse> {
      return { content: "unused", model: "fixture", tokens_used: 0 };
    },
  };
  const executor = new Executor({ llm, tools });

  hds.onAuthorityEvent("composio_execution_requested", {
    request_id: decisionLog.request_id,
    command_id: command.id,
    actor: "owner",
    reason: "validate_product_p8_pre_executor",
    evaluation: approval,
  });
  const feedback = await executor.execute(command);
  hds.onAuthorityEvent("composio_execution_completed", {
    request_id: decisionLog.request_id,
    command_id: command.id,
    actor: "owner",
    reason: `validate_product_p8_post_executor:${feedback.status}`,
    evaluation: approval,
  });
  hds.onFeedback(feedback);

  assertCheck(feedback.status === "success", `Composio fixture execution failed: ${feedback.error ?? "unknown"}`);
  assertCheck(seen?.path === "/api/v3.1/tools/execute/GITHUB_CREATE_AN_ISSUE", "Composio execute endpoint mismatch");
  assertCheck(seen?.body.user_id === "owner-local", "Composio execute body missing user_id");
  assertCheck(JSON.stringify(feedback).includes("issue-fixture"), "Composio fixture result missing");
  assertCheck(!JSON.stringify(feedback).includes("composio-product-secret"), "Composio feedback exposed API key");

  const auditEvents = hds.getAudit().list().map((entry) => {
    const item = entry.log as { kind?: string; event?: string };
    return item.kind === "authority_event" ? item.event : item.kind;
  });
  assertCheck(auditEvents.includes("approval_gate"), "Composio approval gate audit missing");
  assertCheck(auditEvents.includes("composio_execution_requested"), "Composio pre-execution audit missing");
  assertCheck(auditEvents.includes("composio_execution_completed"), "Composio post-execution audit missing");
  assertCheck(hds.getAudit().verify() === true, "Composio audit chain did not verify");
  log.push("executor: approved fixture command reached Composio adapter and emitted pre/post audit events");

  return {
    status: "pass",
    summary: "Composio dry-run/live gates, allowlist/revoke, L3 approval boundary, and execution audit passed",
    raw_log: log.join("\n"),
    details: {
      live_execution_available: status.live_execution_available,
      dry_run_external_call_performed: dryRunResult.external_call_performed,
      revoked_blocked: revokedBlocked,
      approval_level: approval.approval_level,
      final_review_required: approval.final_review_required,
      full_access_auto_allowed: approval.decision === "allow",
      execute_endpoint: seen?.path,
      audit_events: auditEvents,
      audit_chain_valid: hds.getAudit().verify(),
      evidence_source: ["INTERNAL_STATE", "FIXTURE"],
      used_for_authority: false,
      hds_brain_remains_authority: true,
    },
  };
}

async function runChannelOperatorExtensionBoundary(ctx: CheckContext): Promise<CheckResult> {
  const log: string[] = [];
  const claim = await readFile(path.join(ctx.rootDir, "CLAIM.md"), "utf8");
  const pluginReviewGate = await readFile(path.join(ctx.rootDir, "docs", "PLUGIN_REVIEW_GATE.md"), "utf8");
  const pluginHig = await readFile(path.join(ctx.rootDir, "docs", "PLUGIN_HIG.md"), "utf8");
  const skillContract = await readFile(path.join(ctx.rootDir, "docs", "SKILL_LOADER_CONTRACT.md"), "utf8");
  const previewScope = await readFile(path.join(ctx.rootDir, "docs", "preview-scope.md"), "utf8");
  const inventory = await readFile(path.join(ctx.rootDir, "docs", "repository-health-inventory.md"), "utf8");
  const releaseBundle = await readFile(path.join(ctx.rootDir, "scripts", "create_release_bundle.ts"), "utf8");
  const windowsPackage = await readFile(path.join(ctx.rootDir, "scripts", "package_windows.ts"), "utf8");
  const compatibilityMatrix = JSON.parse(
    await readFile(path.join(ctx.rootDir, "docs", "compatibility-matrix.json"), "utf8"),
  ) as {
    channels?: Record<string, { status?: unknown; target_release?: unknown; core_supported?: unknown; warranty?: unknown }>;
  };

  assertCheck(
    claim.includes("Writing / Daily / Developer Operator: first-party Layer A operator surfaces"),
    "CLAIM.md does not explicitly list first-party operator surfaces",
  );
  assertCheck(
    claim.includes("Plugin API / Skill loader: v1.0 contract-stable Layer B boundary"),
    "CLAIM.md does not declare the plugin/skill v1 scope",
  );
  assertCheck(
    pluginReviewGate.includes("v1.0 Layer B Stability Boundary") &&
      pluginReviewGate.includes("API stability: contract-stable for v1.0 RC"),
    "Plugin Review Gate does not declare v1 Layer B stability",
  );
  assertCheck(
    pluginHig.includes("v1.0 HIG Stability Boundary") &&
      pluginHig.includes("contract-stable for v1.0 RC"),
    "Plugin HIG does not declare v1 stability",
  );
  assertCheck(
    skillContract.includes("v1.0 Skill Loader Stability Boundary") &&
      skillContract.includes("contract-stable for v1.0 RC"),
    "Skill Loader Contract does not declare v1 stability",
  );
  log.push("claim/docs: operator first-party and Layer B v1 stability declarations present");

  const expectedChannels: Record<string, { status: string; target_release: string | null }> = {
    webchat: { status: "first-party", target_release: "v1.0" },
    telegram: { status: "first-party", target_release: "v1.0" },
    slack: { status: "first-party-preview", target_release: "v1.0-preview" },
    discord: { status: "first-party-preview", target_release: "v1.0-preview" },
    teams: { status: "first-party-preview", target_release: "v1.0-preview" },
    line: { status: "first-party-preview", target_release: "v1.0-preview" },
    whatsapp: { status: "reserved-third-party", target_release: null },
  };
  for (const [channel, expected] of Object.entries(expectedChannels)) {
    const actual = compatibilityMatrix.channels?.[channel];
    assertCheck(actual?.status === expected.status, `${channel}: expected status ${expected.status}`);
    assertCheck(actual?.target_release === expected.target_release, `${channel}: expected target_release ${String(expected.target_release)}`);
  }
  assertCheck(compatibilityMatrix.channels?.whatsapp?.core_supported === false, "WhatsApp core support was not false");
  assertCheck(compatibilityMatrix.channels?.whatsapp?.warranty === "none", "WhatsApp warranty was not none");
  const channelsRun = await ctx.runner(
    pnpmCommandSpec(["validate:channels"], ctx.rootDir, { ...process.env }),
    ctx.timeoutMs,
  );
  const channelsLog = commandLog(channelsRun);
  assertCheck(channelsRun.exit_code === 0, `validate:channels failed: ${excerpt(channelsLog)}`);
  assertCheck(channelsLog.includes("[channels] PASS"), "validate:channels did not report PASS");
  log.push("channels: WebChat/Telegram first-party, Slack/Discord/Teams/LINE preview, WhatsApp reserved-third-party gate passed");

  const operatorPackages = [
    {
      rel: "packages/operator-writing",
      name: "@blue-tanuki/operator-writing",
      label: "Writing Operator",
      surface: "writing",
      required: ["tool:file.search", "fs:read", "tool:file.write", "tool:file.edit", "fs:write"],
    },
    {
      rel: "packages/operator-daily",
      name: "@blue-tanuki/operator-daily",
      label: "Daily Operator",
      surface: "daily",
      required: ["tool:schedule.list", "schedule:read", "tool:schedule.create", "schedule:create"],
    },
    {
      rel: "packages/operator-developer",
      name: "@blue-tanuki/operator-developer",
      label: "Developer Operator",
      surface: "developer",
      required: ["tool:file.search", "fs:read", "tool:github.write", "tool:shell.exec", "shell:exec"],
    },
  ] as const;

  const runtime = await loadPluginRuntime({
    root: ctx.rootDir,
    import_modules: true,
    allow_ts_fallback: true,
  });
  for (const operator of operatorPackages) {
    const pkg = JSON.parse(
      await readFile(path.join(ctx.rootDir, operator.rel, "package.json"), "utf8"),
    ) as { name?: unknown; description?: unknown; version?: unknown };
    const manifest = runtime.get(operator.name).manifest;
    assertCheck(pkg.name === operator.name, `${operator.label}: package name mismatch`);
    assertCheck(typeof pkg.description === "string" && pkg.description.includes("First-party"), `${operator.label}: package description does not say First-party`);
    assertCheck(manifest.kind === "core", `${operator.label}: manifest kind is not core`);
    assertCheck(manifest.description?.includes("Layer A"), `${operator.label}: manifest does not declare Layer A`);
    assertCheck(manifest.description?.includes("does not add authority") || manifest.description?.includes("without adding authority"), `${operator.label}: manifest authority boundary missing`);
    assertCheck(manifest.exports.surface !== undefined, `${operator.label}: manifest surface export missing`);
    assertCheck(inventory.includes(`| \`${operator.rel}\` | CORE |`), `${operator.label}: repository inventory does not classify package as CORE`);
    assertCheck(previewScope.includes(operator.rel), `${operator.label}: preview scope does not document first-party include`);
    assertCheck(releaseBundle.includes(`"${operator.rel}"`), `${operator.label}: release bundle core paths do not include operator`);
    assertCheck(windowsPackage.includes(`rel: "${operator.rel}"`), `${operator.label}: Windows package runtime list does not include operator`);

    const reviewRun = await ctx.runner(
      pnpmCommandSpec(["plugin:review", "--", "--package", operator.rel, "--bundled"], ctx.rootDir, { ...process.env }),
      ctx.timeoutMs,
    );
    const reviewLog = commandLog(reviewRun);
    assertCheck(reviewRun.exit_code === 0, `${operator.label}: bundled plugin review failed: ${excerpt(reviewLog)}`);
    assertCheck(reviewLog.includes("[plugin-review] PASS"), `${operator.label}: bundled plugin review did not report PASS`);

    const surfaceFn = runtime.getSurface<(input?: Record<string, unknown>) => Record<string, unknown>>({
      package_name: operator.name,
      required_permissions: operator.required,
      action: `validate ${operator.label} first-party surface`,
    });
    const snapshot = surfaceFn({});
    const operations = Array.isArray(snapshot.operations) ? snapshot.operations as Array<Record<string, unknown>> : [];
    assertCheck(snapshot.surface === operator.surface, `${operator.label}: surface snapshot mismatch`);
    assertCheck(snapshot.layer === "A", `${operator.label}: surface layer was not A`);
    assertCheck(snapshot.authority === "hds_brain_downstream_device", `${operator.label}: authority boundary mismatch`);
    assertCheck(snapshot.replaces_authority === false, `${operator.label}: surface replaced authority`);
    assertCheck(snapshot.raw_authority_added === false, `${operator.label}: raw authority was added`);
    assertCheck(operations.length > 0, `${operator.label}: no operations declared`);
    for (const operation of operations) {
      const capabilities = Array.isArray(operation.capabilities) ? operation.capabilities : [];
      assertCheck(!capabilities.includes("authority:write"), `${operator.label}: authority:write capability present`);
      assertCheck(!capabilities.includes("hds:bypass"), `${operator.label}: hds:bypass capability present`);
      if (operation.final_review_required === true) {
        assertCheck(operation.approval_level === "L3_final_review", `${operator.label}: final-review operation was not L3`);
      }
    }
  }
  log.push("operators: package metadata, manifests, bundled review, plugin-loader surfaces, and non-authority snapshots passed");

  return {
    status: "pass",
    summary: "channel/operator/plugin-skill claim, packaging, review, and downstream authority boundaries passed",
    raw_log: log.join("\n"),
    details: {
      channels: Object.fromEntries(
        Object.entries(expectedChannels).map(([channel, expected]) => [
          channel,
          {
            expected,
            actual: compatibilityMatrix.channels?.[channel],
          },
        ]),
      ),
      operators: operatorPackages.map((operator) => operator.name),
      release_bundle_operator_included: true,
      windows_package_operator_included: true,
      validate_channels_passed: true,
      bundled_plugin_review_passed: true,
      plugin_skill_contract_stable_v1: true,
      evidence_source: ["CONFIG", "INTERNAL_STATE", "FIXTURE"],
      used_for_authority: false,
      hds_brain_remains_authority: true,
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

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("failed to allocate loopback port"));
      });
    });
  });
}

async function settingsRequest(
  base: string,
  token: string,
  method: "GET" | "POST",
  route: string,
  body?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  assertCheck(response.ok, `${route} ${method} returned HTTP ${response.status}: ${text}`);
  assertCheck(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), `${route} did not return JSON object`);
  return parsed as Record<string, any>;
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
  return redactEvidenceText(value);
}

async function writeEnvironmentEvidence(
  ctx: CheckContext,
  runner: CommandRunner,
): Promise<void> {
  const pnpm = await safeShortCommand(
    runner,
    pnpmCommandSpec(["--version"], ctx.rootDir, { ...process.env }),
  );
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

export function pnpmCommandSpec(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CommandSpec {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /pnpm/i.test(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
      cwd,
      env,
    };
  }
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm", ...args],
      cwd,
      env,
    };
  }
  return {
    command: "pnpm",
    args,
    cwd,
    env,
  };
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
