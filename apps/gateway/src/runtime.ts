import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  FailureMemoryStore,
  HDSUpperController,
  LongTermMemoryStore,
  extractFailureSignatures,
} from "@blue-tanuki/hds-brain";
import {
  Executor,
  ToolRegistry,
  MemorySessionStore,
  JsonFileSessionStore,
  createExecutorApprovalAuthority,
  createLogger,
  type SessionStore,
} from "@blue-tanuki/core";
import { normalizeInboundRequestForAuthority, type InboundRequest } from "@blue-tanuki/protocol";
import { buildAuditLog } from "./audit_config.js";
import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
  describeLLMCommandRoute,
  describeLLMConfig,
} from "./llm_config.js";
import { renderCommandOutput } from "./result_render.js";
import { approvalDeniedFeedback, buildApprovalRuntime } from "./approval_runtime.js";
import { loadPluginRuntime, type PluginRuntime } from "./plugin_loader.js";
import { stripEnvFileArgs } from "./env_file.js";
import { RuntimeScheduleManager } from "./runtime_schedule.js";
import { resolveAllSecretRefs } from "./secret_store.js";

const gatewayLog = createLogger({ scope: "gateway" });
const hdsLog = createLogger({ scope: "hds-brain" });
const coreLog = createLogger({ scope: "blue-tanuki" });
const auditLog = createLogger({ scope: "audit" });

/**
 * Build the HDS memory store from explicit env configuration.
 * Memory remains reference/evidence only and is not used for authority.
 */
export function buildHDSMemoryStore(env: NodeJS.ProcessEnv = process.env): LongTermMemoryStore {
  const file = env.BLUE_TANUKI_MEMORY_FILE;
  const dir = env.BLUE_TANUKI_MEMORY_DIR;
  const max = parseInt(env.BLUE_TANUKI_MEMORY_CAP ?? "10000", 10);
  const max_entries = Number.isFinite(max) && max >= 0 ? max : 10_000;
  if (file) return new LongTermMemoryStore({ filepath: path.resolve(file), max_entries });
  if (dir) return new LongTermMemoryStore({ filepath: path.join(path.resolve(dir), "memory.jsonl"), max_entries });
  return new LongTermMemoryStore({ max_entries });
}

/**
 * Build the HDS failure-memory store from explicit env configuration.
 * Failure memory is a deterministic pre-execution control asset; it does not
 * let complete history or LLM proposals become authority.
 */
export function buildFailureMemoryStore(env: NodeJS.ProcessEnv = process.env): FailureMemoryStore {
  const file = env.BLUE_TANUKI_FAILURE_MEMORY_FILE;
  const dir = env.BLUE_TANUKI_FAILURE_MEMORY_DIR;
  if (file) return new FailureMemoryStore({ filepath: path.resolve(file) });
  if (dir) return new FailureMemoryStore({ filepath: path.join(path.resolve(dir), "failure-memory.json") });
  return new FailureMemoryStore();
}

export function buildSessionStore(
  plugins?: PluginRuntime,
  env: NodeJS.ProcessEnv = process.env,
): SessionStore {
  plugins?.enforceSessionConfig(env);
  const dir = env.BLUE_TANUKI_SESSION_DIR;
  const cap = parseInt(env.BLUE_TANUKI_SESSION_CAP ?? "100", 10);
  if (dir) {
    return new JsonFileSessionStore({
      base_dir: path.resolve(dir),
      cap: Number.isFinite(cap) && cap >= 0 ? cap : 100,
    });
  }
  return new MemorySessionStore({
    cap: Number.isFinite(cap) && cap >= 0 ? cap : 100,
  });
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  Object.assign(process.env, resolveAllSecretRefs(process.env));
  const userInput = stripEnvFileArgs([...argv])
    .filter(
      (a) =>
        a !== "--serve" &&
        a !== "--setup" &&
        a !== "--doctor" &&
        a !== "--audit-dump" &&
        a !== "--audit-verify" &&
        a !== "--json",
    )
    .join(" ")
    .trim();
  const content = userInput || "Hello, BLUE-TANUKI";

  const plugins = await loadPluginRuntime();
  plugins.enforceLLMConfig(process.env);
  plugins.enforceSessionConfig(process.env);
  plugins.enforceAuditConfig(process.env);

  gatewayLog.info("BLUE-TANUKI starting (CLI one-shot)");
  gatewayLog.info("LLM config", describeLLMConfig());
  gatewayLog.info("LLM command route", describeLLMCommandRoute());

  const tools = new ToolRegistry();
  plugins.registerTools(tools);
  const runtimeSchedules = await RuntimeScheduleManager.open({ env: process.env });
  for (const tool of runtimeSchedules.tools()) tools.register(tool);
  const llm = buildLLMBackendFromEnv();
  const session_store = buildSessionStore(plugins);

  const hds = new HDSUpperController({
    audit: buildAuditLog(),
    memory: buildHDSMemoryStore(process.env),
    llm_route: buildLLMCommandRouteFromEnv(),
  });
  const failureMemory = buildFailureMemoryStore(process.env);
  const approval = buildApprovalRuntime(process.env);
  const executorApproval = createExecutorApprovalAuthority();
  const executor = new Executor({ llm, tools, approval_authority: executorApproval, session_store });

  const inbound: InboundRequest = normalizeInboundRequestForAuthority({
    id: randomUUID(),
    channel: "cli",
    user: "local-user",
    content,
    timestamp: Date.now(),
  });

  gatewayLog.info("inbound", {
    id: inbound.id,
    channel: inbound.channel,
    content: inbound.content,
  });

  const { log, command } = hds.decide(inbound);
  hdsLog.info("decision", {
    decision: log.commit.decision,
    aggregate: log.model.scoring.aggregate.toFixed(2),
    hash: log.commit.hash.slice(0, 12),
  });
  hdsLog.info("reason", { reason: log.commit.reason });
  hdsLog.info("triggered", {
    thresholds: log.commit.triggered_thresholds.join(", "),
  });
  for (const ax of log.model.scoring.axis_scores) {
    hdsLog.info("axis", {
      axis: ax.axis,
      score: ax.score.toFixed(2),
      detector: ax.detector,
      evidence: ax.evidence,
    });
  }

  if (!command) {
    if (log.commit.decision === "SUSPEND") {
      gatewayLog.info("SUSPENDED. Awaiting human resume.", {
        request_id: inbound.id,
      });
      gatewayLog.info(
        'Resume through the Approval Gate; HDS-BRAIN fail-safe suspensions cannot be approved by human resume.',
      );
    } else {
      gatewayLog.info("halting (no command)", { decision: log.commit.decision });
    }
    auditLog.info("summary", {
      entries: hds.getAudit().size(),
      chain_valid: hds.getAudit().verify(),
    });
    return;
  }

  const failureGate = failureMemory.evaluateCommandGate(command, {
    actor: inbound.user,
    channel: inbound.channel,
    request_id: inbound.id,
    surface: "cli",
  });
  if (failureGate.decision === "block" || failureGate.decision === "require_approval") {
    const phase = failureGate.decision === "block" ? "approval_rejected" : "approval_pending";
    hds.onCommandLifecycle(command.id, phase, {
      actor: inbound.user,
      reason: `failure_memory:${failureGate.reason}`,
    });
    coreLog.info("failure_memory_gate", {
      command: command.id.slice(0, 8),
      decision: failureGate.decision,
      matches: failureGate.applied_signature_ids.join(", "),
      reason: failureGate.reason,
    });
    auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
    return;
  }
  if (failureGate.decision !== "allow") {
    coreLog.info("failure_memory_gate", {
      command: command.id.slice(0, 8),
      decision: failureGate.decision,
      matches: failureGate.applied_signature_ids.join(", "),
      reason: failureGate.reason,
    });
  }

  const approvalEval = approval.evaluate(command, inbound.user);
  hds.onApprovalEvaluation(approvalEval, { request_id: inbound.id });
  if (approvalEval.decision !== "allow") {
    hds.onCommandLifecycle(command.id, "approval_cancelled", { actor: inbound.user, reason: approvalEval.reason });
    const feedback = approvalDeniedFeedback(command, approvalEval.reason);
    coreLog.info("approval", { command: command.id.slice(0, 8), decision: approvalEval.decision, operation: approvalEval.context.operation, risk: approvalEval.risk, reason: approvalEval.reason });
    const output = renderCommandOutput(command, feedback);
    hds.onOutputAudit({ command, feedback, rendered_output: output, target_surface: "cli", request_id: inbound.id });
    if (output) coreLog.info("command.output", { content: output });
    auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
    return;
  }
  hds.onCommandLifecycle(command.id, "approval_approved", { actor: inbound.user, reason: approvalEval.reason });

  const approvedCommand = executorApproval.approve(command, {
    source: "approval_gate",
    decision: "allow",
    approved_by: inbound.user,
    approved_at_ms: Date.now(),
    upstream_commit_hash: command.upstream_decision.commit_hash,
    operation: approvalEval.context.operation,
    risk: approvalEval.risk,
    final_review_required: approvalEval.final_review_required,
    reason: approvalEval.reason,
  });
  const feedback = await executor.execute(approvedCommand);
  if (feedback.status === "failed") {
    for (const signature of extractFailureSignatures({ kind: "command_result", command, feedback })) {
      failureMemory.upsertSignature(signature);
    }
  }
  coreLog.info("command", {
    command: command.id.slice(0, 8),
    status: feedback.status,
    duration_ms: feedback.metrics.duration_ms,
  });

  const output = renderCommandOutput(command, feedback);
  hds.onFeedback(feedback);
  hds.onOutputAudit({ command, feedback, rendered_output: output, target_surface: "cli", request_id: inbound.id });

  if (feedback.status === "success" && command.type === "llm_call") {
    const result = feedback.result as {
      content: string;
      model: string;
      tokens_used: number;
    };
    coreLog.info("llm", {
      model: result.model,
      tokens: result.tokens_used,
    });
    coreLog.info("llm.content", { content: result.content });
  } else if (feedback.status === "failed") {
    coreLog.error("error", { error: feedback.error });
  }

  if (output && command.type !== "llm_call") {
    coreLog.info("command.output", { content: output });
  }

  auditLog.info("summary", {
    entries: hds.getAudit().size(),
    chain_valid: hds.getAudit().verify(),
  });
}
