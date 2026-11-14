import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  CompleteHistoryStore,
  FailureMemoryStore,
  HDSUpperController,
  LongTermMemoryStore,
  DOCUMENT_ORGANIZATION_MAX_SOURCE_CHARS,
  DOCUMENT_ORGANIZATION_PROMPT_PREFIX,
  extractFailureSignatures,
} from "@blue-tanuki/hds-brain";
import {
  Executor,
  LLMComputeAdapter,
  ToolRegistry,
  createMemoryPersonalizationStopTool,
  MemorySessionStore,
  JsonFileSessionStore,
  createExecutorApprovalAuthority,
  captureExecutorCommandForApproval,
  createLogger,
  type AgentWorkerLifecycleEvent,
  type SessionStore,
} from "@blue-tanuki/core";
import type { ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import {
  createCliInboundRequest,
  createCliGoalCompletionStatusRequest,
  cliGoalCompletionRulesRequested,
  cliRequestNeedsOperationPlanState,
  CLI_GOAL_COMPLETION_RULES_STDIN_FLAG,
  CLI_ORGANIZE_STDIN_FLAG,
  CLI_TASK_STDIN_FLAG,
  parseCliGoalCompletionStatusArguments,
  readCliGoalCompletionRulesInput,
  readCliTaskInput,
} from "./cli_goal_completion_rules.js";
import { buildAuditLog } from "./audit_config.js";
import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
  describeLLMCommandRoute,
  describeLLMConfig,
} from "./llm_config.js";
import { renderCommandOutput } from "./result_render.js";
import { finalizeCommandOutput } from "./finalize_command_output.js";
import { renderCurrentCliGoalCompletionProjection, renderCurrentCliGoalCompletionStatusProjection } from "./cli_goal_completion_projection.js";
import { approvalDeniedFeedback, buildApprovalRuntime } from "./approval_runtime.js";
import { loadPluginRuntime, type PluginRuntime } from "./plugin_loader.js";
import { stripEnvFileArgs } from "./env_file.js";
import { RuntimeScheduleManager } from "./runtime_schedule.js";
import { GatewayComputeBudgetStore } from "./compute_budget_store.js";
import { GatewayResourceBackpressure } from "./resource_backpressure.js";
import {
  documentOrganizationSourceFromRequest,
  presentRestoredDocumentOrganizationProjection,
  prepareDocumentOrganizationSession,
  runDocumentOrganizationTask,
  type DocumentOrganizationSession,
} from "./document_organization_runtime.js";
import { DocumentOrganizationCheckpointStore } from "./document_organization_checkpoint_store.js";
import { GatewayExecutionIntentStore } from "./execution_intent_store.js";
import { GatewayRuntimeOwnerLease } from "./runtime_owner_lease.js";
import { executionAdmissionForCommand, reconcileExecutionResults, reconcileStartupExecutionState } from "./reconcile_execution_results.js";
import { createFileSearchWorker } from "./file_search_worker.js";
import { goalGovernanceConfigFromEnvironment } from "./goal_governance_config.js";
import { developmentHandoffStoreFromEnvironment } from "./development_handoff_store.js";
import { resolveFailureMemoryFilePath } from "./failure_memory_paths.js";
import { registerMcpCallToolFromEnvironment } from "./mcp_connection_client.js";
import { McpRuntimeObservationStore } from "./mcp_connection_observation.js";
import { OperationPlanStateStore } from "./operation_plan_store.js";
import { operationResultMemoryStorage } from "./operation_result_memory_config.js";

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
 * Build the HDS failure-memory store from explicit or Setup-managed paths.
 * Failure memory is a deterministic pre-execution control asset; it does not
 * let complete history or LLM proposals become authority.
 */
export function buildFailureMemoryStore(env: NodeJS.ProcessEnv = process.env): FailureMemoryStore {
  const filepath = resolveFailureMemoryFilePath(env);
  return filepath ? new FailureMemoryStore({ filepath }) : new FailureMemoryStore();
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
  const ownerLease = GatewayRuntimeOwnerLease.fromEnvironment(process.env);
  let executionStore: GatewayExecutionIntentStore | undefined;
  let computeBudget: GatewayComputeBudgetStore | undefined;
  let resourceBackpressure: GatewayResourceBackpressure | undefined;
  let mcpRuntimeObservations: McpRuntimeObservationStore | undefined;
  let operationPlanState: OperationPlanStateStore | undefined;
  try {
    const cleanArgs = stripEnvFileArgs([...argv]);
    const completionRulesRequested = cliGoalCompletionRulesRequested(cleanArgs);
    const goalCompletionStatus = parseCliGoalCompletionStatusArguments(cleanArgs);
    if (completionRulesRequested && goalCompletionStatus) {
      throw new Error("--goal-completion-status cannot be combined with --goal-completion-rules-stdin");
    }
    mcpRuntimeObservations = McpRuntimeObservationStore.fromEnvironment(process.env);
    executionStore = GatewayExecutionIntentStore.fromEnvironment(ownerLease.executionEpoch, process.env);
    if (cliRequestNeedsOperationPlanState(cleanArgs) || executionStore.pendingResults(1).length > 0) {
      operationPlanState = OperationPlanStateStore.fromEnvironment(process.env);
    }
    computeBudget = GatewayComputeBudgetStore.fromEnvironment(process.env);
    resourceBackpressure = GatewayResourceBackpressure.fromEnvironment(process.env);
    await runCliWithExecutionStore(argv, executionStore, ownerLease, computeBudget, resourceBackpressure,
      mcpRuntimeObservations, operationPlanState, goalCompletionStatus);
  } finally {
    computeBudget?.close();
    executionStore?.close();
    mcpRuntimeObservations?.close();
    operationPlanState?.close();
    ownerLease.close();
  }
}

async function runCliWithExecutionStore(
  argv: readonly string[],
  executionStore: GatewayExecutionIntentStore,
  ownerLease: GatewayRuntimeOwnerLease,
  computeBudget: GatewayComputeBudgetStore,
  resourceBackpressure: GatewayResourceBackpressure,
  mcpRuntimeObservations: McpRuntimeObservationStore,
  operationPlanState: OperationPlanStateStore | undefined,
  goalCompletionStatus: ReturnType<typeof parseCliGoalCompletionStatusArguments>,
): Promise<void> {
  const cleanArgs = stripEnvFileArgs([...argv]);
  const completionRulesRequested = cliGoalCompletionRulesRequested(cleanArgs);
  const taskStdinCount = cleanArgs.filter((arg) => arg === CLI_TASK_STDIN_FLAG).length;
  if (taskStdinCount > 1) throw new Error("--task-stdin cannot be repeated");
  const taskStdinRequested = taskStdinCount === 1;
  if (completionRulesRequested && goalCompletionStatus) {
    throw new Error("--goal-completion-status cannot be combined with --goal-completion-rules-stdin");
  }
  if (taskStdinRequested && (completionRulesRequested || goalCompletionStatus ||
      cleanArgs.includes("--organize") || cleanArgs.includes(CLI_ORGANIZE_STDIN_FLAG))) {
    throw new Error("--task-stdin cannot be combined with goal-completion or document-organization input");
  }
  const requestArgs = completionRulesRequested
    ? cleanArgs.filter((arg) => arg !== CLI_GOAL_COMPLETION_RULES_STDIN_FLAG)
    : goalCompletionStatus?.remaining_args ?? cleanArgs;
  if (completionRulesRequested &&
      (requestArgs.includes("--organize") || requestArgs.includes(CLI_ORGANIZE_STDIN_FLAG))) {
    throw new Error("--goal-completion-rules-stdin cannot be combined with document organization input");
  }
  if (goalCompletionStatus && requestArgs.length > 0) {
    throw new Error("--goal-completion-status accepts only a request digest");
  }
  if (taskStdinRequested) {
    const extraArgs = requestArgs.filter((arg) => arg !== CLI_TASK_STDIN_FLAG && arg !== "--json");
    if (extraArgs.length > 0) {
      throw new Error("--task-stdin does not accept inline task text or additional arguments");
    }
    if (process.stdin.isTTY) throw new Error("--task-stdin requires piped UTF-8 task text on stdin");
  }
  if (completionRulesRequested && process.stdin.isTTY) {
    throw new Error("--goal-completion-rules-stdin requires piped UTF-8 JSON on stdin");
  }
  const goalCompletionRules = completionRulesRequested
    ? await readCliGoalCompletionRulesInput(process.stdin)
    : undefined;
  const taskStdinInput = taskStdinRequested ? await readCliTaskInput(process.stdin) : "";
  const organizeIndex = requestArgs.indexOf("--organize");
  const organizeStdinCount = requestArgs.filter((arg) => arg === CLI_ORGANIZE_STDIN_FLAG).length;
  if (organizeStdinCount > 1) throw new Error("--organize-stdin cannot be repeated");
  const organizeStdinRequested = organizeStdinCount === 1;
  if (organizeIndex >= 0 && organizeStdinRequested) {
    throw new Error("--organize and --organize-stdin cannot be combined");
  }
  let organizationSource: string | null = null;
  if (organizeIndex >= 0) {
    organizationSource = requestArgs.slice(organizeIndex + 1).join(" ").trim();
  } else if (organizeStdinRequested) {
    const extraArgs = requestArgs.filter((arg) => arg !== CLI_ORGANIZE_STDIN_FLAG);
    if (extraArgs.length > 0) {
      throw new Error("--organize-stdin does not accept inline source text or additional arguments");
    }
    if (process.stdin.isTTY) {
      throw new Error("--organize-stdin requires piped UTF-8 source text on stdin");
    }
    organizationSource = await readCliDocumentOrganizationSource(process.stdin);
  }
  if (organizeIndex >= 0 && !organizationSource) {
    throw new Error("--organize requires owner-provided source text after the flag");
  }
  const userInput = requestArgs
    .filter(
      (a) =>
        a !== "--serve" &&
        a !== "--setup" &&
        a !== "--doctor" &&
        a !== "--audit-dump" &&
        a !== "--audit-verify" &&
        a !== "--json" &&
        a !== "--organize" &&
        a !== CLI_ORGANIZE_STDIN_FLAG &&
        a !== CLI_TASK_STDIN_FLAG,
    )
    .join(" ")
    .trim();
  if (goalCompletionRules && userInput.length === 0) {
    throw new Error("--goal-completion-rules-stdin requires an explicit CLI task");
  }
  const content = organizationSource !== null
    ? `/organize\n${organizationSource}`
    : taskStdinRequested ? taskStdinInput : userInput || "Hello, BLUE-TANUKI";

  const inbound: InboundRequest = goalCompletionStatus
    ? createCliGoalCompletionStatusRequest({ id: randomUUID(), timestamp: Date.now(),
      request_id_digest: goalCompletionStatus.request_id_digest })
    : createCliInboundRequest({
      id: randomUUID(),
      content,
      timestamp: Date.now(),
      ...(goalCompletionRules ? { goal_completion_rules: goalCompletionRules } : {}),
    });

  const plugins = goalCompletionStatus ? undefined : await loadPluginRuntime();
  plugins?.enforceLLMConfig(process.env);
  plugins?.enforceSessionConfig(process.env);
  plugins?.enforceAuditConfig(process.env);

  ownerLease.assertActive();
  const memoryStore = buildHDSMemoryStore(process.env);
  const hds = new HDSUpperController({
    audit: buildAuditLog(),
    memory: memoryStore,
    llm_route: buildLLMCommandRouteFromEnv(),
    goal_governance: goalGovernanceConfigFromEnvironment(process.env),
    ...(operationPlanState ? { operation_plan_state: operationPlanState,
      operation_plan_memory: operationResultMemoryStorage(process.env) } : {}),
  });
  try {
  ownerLease.assertActive();
  const startupRecovery = reconcileStartupExecutionState(hds, executionStore, ownerLease.executionEpoch);
  gatewayLog.info("CLI startup saved-result reconciliation", {
    adopted: startupRecovery.adopted,
    deferred: startupRecovery.deferred,
    stale_generation_archived: startupRecovery.stale_generation_archived,
    memory_ready: startupRecovery.memory_ready,
    result_store_readable: startupRecovery.result_store_readable,
    wait_compute_candidate_reconciled: startupRecovery.wait_compute_candidate_reconciled,
    wait_compute_interrupted: startupRecovery.wait_compute_interrupted,
    wait_compute_reconciliation_ready: startupRecovery.wait_compute_reconciliation_ready,
  });
  if (!startupRecovery.ready) {
    gatewayLog.error("CLI startup blocked before processing the request: saved result, memory, or wait-compute reconciliation is unavailable or pending", {
      deferred: startupRecovery.deferred,
      memory_ready: startupRecovery.memory_ready,
      result_store_readable: startupRecovery.result_store_readable,
      wait_compute_reconciliation_ready: startupRecovery.wait_compute_reconciliation_ready,
    });
    throw new Error("gateway_startup_reconciliation_unresolved");
  }

  if (goalCompletionStatus) {
    const decision = hds.decide(inbound);
    const command = decision.command;
    if (!command) {
      gatewayLog.info("CLI goal-completion status query was not accepted", {
        request_id: inbound.id,
        decision: decision.log.commit.decision,
      });
      auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
      return;
    }
    if (command.type !== "noop" || command.payload.control_event !== "operation_plan_goal_completion_status" ||
        command.payload.request_id_digest !== goalCompletionStatus.request_id_digest) {
      hds.onCommandLifecycle(command.id, "approval_cancelled", { actor: inbound.user,
        reason: "cli_goal_completion_status_command_unexpected" });
      throw new Error("cli_goal_completion_status_command_unexpected");
    }
    const feedback: ExecuteFeedback = { command_id: command.id, status: "success",
      result: { content: "Read-only J goal completion status projection." }, metrics: { duration_ms: 0 } };
    const finalized = finalizeCommandOutput({
      hds,
      command,
      feedback,
      target_surface: "cli",
      request_id: inbound.id,
      rendered_output_after_feedback: () => renderCurrentCliGoalCompletionStatusProjection({
        hds,
        request_id_digest: goalCompletionStatus.request_id_digest,
      }),
    });
    if (finalized.rendered_output) process.stdout.write(`${finalized.rendered_output}\n`);
    auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
    return;
  }

  if (!plugins) throw new Error("cli_plugin_runtime_unavailable");

  gatewayLog.info("BLUE-TANUKI starting (CLI one-shot)");
  gatewayLog.info("LLM config", describeLLMConfig());
  gatewayLog.info("LLM command route", describeLLMCommandRoute());

  const tools = new ToolRegistry();
  tools.register(createMemoryPersonalizationStopTool(memoryStore));
  registerMcpCallToolFromEnvironment(tools, process.env, mcpRuntimeObservations);
  plugins.registerTools(tools);
  const runtimeSchedules = await RuntimeScheduleManager.open({ env: process.env });
  for (const tool of runtimeSchedules.tools()) tools.register(tool);
  const llm = buildLLMBackendFromEnv();
  const session_store = buildSessionStore(plugins);

  const failureMemory = buildFailureMemoryStore(process.env);
  const developmentHandoffStore = developmentHandoffStoreFromEnvironment(process.env);
  const approval = buildApprovalRuntime(process.env);
  const executorApproval = createExecutorApprovalAuthority({
    execution_store: executionStore,
    execution_epoch: ownerLease.executionEpoch,
    assert_execution_owner: () => ownerLease.assertActive(),
    require_hds_execution_binding: true,
  });
  const completeHistoryFile = process.env.BLUE_TANUKI_COMPLETE_HISTORY_FILE?.trim() || undefined;
  const completeHistoryMaxEntriesValue = Number(process.env.BLUE_TANUKI_COMPLETE_HISTORY_MAX_ENTRIES);
  const completeHistoryMaxEntries = Number.isInteger(completeHistoryMaxEntriesValue) &&
    completeHistoryMaxEntriesValue > 0 ? completeHistoryMaxEntriesValue : undefined;
  const completeHistory = new CompleteHistoryStore({
    ...(completeHistoryFile ? { filepath: completeHistoryFile } : {}),
    ...(completeHistoryMaxEntries ? { max_entries: completeHistoryMaxEntries } : {}),
  });
  const executor = new Executor({
    llm,
    compute: new LLMComputeAdapter(llm, computeBudget, resourceBackpressure),
    tools,
    approval_authority: executorApproval,
    on_agent_worker_lifecycle: (event: AgentWorkerLifecycleEvent) => {
      try {
        const entry = completeHistory.append({
          kind: "audit_history",
          command_id: event.parent_command_id,
          actor: "executor",
          source: "executor_agent_worker",
          timestamp: event.observed_at_ms,
          payload: {
            schema_version: event.schema_version,
            parent_command_digest: event.parent_command_digest,
            child_task_digest: event.child_task_digest,
            role: event.role,
            state: event.state,
            observed_at_ms: event.observed_at_ms,
            ...(event.output_observed ? { output_observed: true } : {}),
            ...(event.output_characters !== undefined ? { output_characters: event.output_characters } : {}),
            ...(event.resource_use_digest ? { resource_use_digest: event.resource_use_digest } : {}),
            used_for_authority: false,
            may_execute: false,
          },
        });
        if (!entry) gatewayLog.error("agent worker lifecycle evidence unavailable", {
          command_id: event.parent_command_id,
          child_task_digest: event.child_task_digest,
          state: event.state,
        });
        return entry !== null;
      } catch {
        gatewayLog.error("agent worker lifecycle evidence unavailable", {
          command_id: event.parent_command_id,
          child_task_digest: event.child_task_digest,
          state: event.state,
        });
        return false;
      }
    },
    file_search_worker: createFileSearchWorker({ execution_epoch: ownerLease.executionEpoch,
      host_audience_digest: ownerLease.hostAudienceDigest, env: process.env }),
    session_store,
  });

  const organizationSourceText = documentOrganizationSourceFromRequest(inbound);
  const organizationStore = organizationSourceText === null
    ? null
    : DocumentOrganizationCheckpointStore.fromEnvironment(process.env);
  let organizationSession: DocumentOrganizationSession | null = null;
  let decision: ReturnType<HDSUpperController["decide"]> | undefined;
  try {
    organizationSession = organizationSourceText === null || organizationStore === null
      ? null
      : prepareDocumentOrganizationSession({
        request: inbound,
        source_text: organizationSourceText,
        hds,
        store: organizationStore,
      });
    const organizationCoordinator = organizationSession?.coordinator ?? null;
    const decisionRequest = organizationCoordinator
      ? {
        ...inbound,
        content: organizationSession?.restored_terminal_state
          ? `${DOCUMENT_ORGANIZATION_PROMPT_PREFIX}復旧済みの終端projection表示に必要なHDS判断です。計算は実行しません。`
          : organizationCoordinator.buildComputePrompt(),
      }
      : inbound;

    if (organizationCoordinator) {
      gatewayLog.info("inbound", {
        id: inbound.id,
        channel: inbound.channel,
        user: inbound.user,
        task: "document_organization",
        content_digest: organizationCoordinator.snapshot().source_ref.content_sha256,
        content_chars: organizationSourceText?.length ?? 0,
      });
    } else {
      gatewayLog.info("inbound", {
        id: inbound.id,
        channel: inbound.channel,
        content_sha256: createHash("sha256").update(inbound.content, "utf8").digest("hex"),
        content_bytes: Buffer.byteLength(inbound.content, "utf8"),
      });
    }

    decision = hds.decide(decisionRequest, organizationCoordinator
      ? { transient_content: "document_organization" }
      : undefined);
    const { log, command } = decision;
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

    if (organizationSession?.restored_terminal_state && log.commit.decision === "ASSERT") {
      if (command) {
        hds.onCommandLifecycle(command.id, "approval_cancelled", {
          actor: inbound.user,
          reason: "document_organization_checkpoint_terminal_no_compute_required",
        });
      }
      const result = presentRestoredDocumentOrganizationProjection({
        coordinator: organizationSession.coordinator,
        request_id: inbound.id,
        upstream_commit_hash: log.commit.hash,
        hds,
        target_surface: "cli",
      });
      process.stdout.write(`${result.rendered_output}\n`);
      auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
      return;
    }

    if (organizationCoordinator && command && organizationSession) {
      const result = await runDocumentOrganizationTask({
        coordinator: organizationCoordinator,
        origin: inbound,
        hds,
        executor,
        executorApproval,
        approval,
        failureMemory,
        target_surface: "cli",
        first_decision: { log, command },
        persist_checkpoint: organizationSession.persist_checkpoint,
        current_memory_version: () => hds.documentOrganizationMemoryVersion(),
      });
      if (result) {
        coreLog.info("document_organization.result", {
          status: result.status,
          revision: result.projection.revision,
          cycles: result.projection.completed_cycles,
        });
        process.stdout.write(`${result.rendered_output}\n`);
        auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
        return;
      }
    }
  } finally {
    organizationStore?.close();
  }

  if (!decision) throw new Error("HDS decision was not produced");
  const { log, command } = decision;

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
      condition_changes: failureGate.condition_change_matches.map((match) => ({
        signature_id: match.signature_id,
        changed_conditions: match.changed_conditions,
        decision: match.decision,
      })),
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

  if (!hds.operationPlanCommandIsCurrent(command)) {
    hds.onCommandLifecycle(command.id, "approval_cancelled", {
      actor: inbound.user,
      reason: "plan_binding_stale",
    });
    gatewayLog.warn("CLI operation-plan command is no longer current", {
      used_for_authority: false,
    });
    auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
    return;
  }

  const reviewed = captureExecutorCommandForApproval(command);
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

  let targetVersionObservation: Awaited<ReturnType<Executor["inspectCommandTargetVersion"]>>;
  let executionAdmissionLease: { release(): void } | undefined;
  let feedback: Awaited<ReturnType<Executor["execute"]>>;
  let requestedStopSignal: NodeJS.Signals | undefined;
  const commandAbortController = new AbortController();
  const requestCommandStop = (signal: NodeJS.Signals): void => {
    if (requestedStopSignal) return;
    requestedStopSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    gatewayLog.warn("CLI command stop requested", {
      signal,
      request_id: inbound.id,
      command_id: command.id,
      used_for_authority: false,
    });
    try {
      process.stderr.write("停止要求を受け付けました。対象確認中なら実行前に中止し、Executor実行中なら中断を伝えます。\n");
    } catch { /* console failure must not prevent cancellation */ }
    commandAbortController.abort(new Error("cli_command_stop_requested"));
  };
  const onSigint = (): void => requestCommandStop("SIGINT");
  const onSigterm = (): void => requestCommandStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let planBound = false;
  try {
    let targetVersionAvailable = true;
    try {
      const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(command);
      targetVersionObservation = await executor.inspectCommandTargetVersion(command, undefined,
        operationPlanBindingDigest, commandAbortController.signal);
    } catch {
      targetVersionAvailable = false;
    }

    if (requestedStopSignal) {
      hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: inbound.user,
        reason: "cli_stop_requested_before_execution",
      });
      gatewayLog.warn("CLI stopped before Executor dispatch; read-only target inspection may be unresolved", {
        signal: requestedStopSignal,
        request_id: inbound.id,
        target_inspection: targetVersionAvailable ? "returned" : "unknown",
        executor_started: false,
        used_for_authority: false,
      });
      try {
        process.stdout.write(`停止要求を受け付けました。実行前の対象確認中に停止し、Executorは開始していません。\nrequest_id=${inbound.id}\n`);
      } catch { /* output failure must not change the recorded cancellation */ }
      auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
      return;
    }

    if (!targetVersionAvailable) {
      const reason = command.type === "tool_call" && command.payload.tool_name === "gmail.write"
        ? "gmail_write_target_version_unavailable"
        : command.type === "tool_call" && command.payload.tool_name === "file.search"
          ? "file_search_target_version_unavailable"
          : command.type === "tool_call" && command.payload.tool_name === "file.write"
            ? "file_write_target_version_unavailable"
            : command.type === "tool_call" && command.payload.tool_name === "file.delete"
              ? "file_delete_target_version_unavailable"
              : command.type === "tool_call" && command.payload.tool_name === "file.edit"
                ? "file_edit_target_version_unavailable"
                : command.type === "tool_call" && command.payload.tool_name === "shell.exec"
                  ? "shell_exec_target_version_unavailable" : "broker_target_version_unavailable";
      hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: inbound.user,
        reason,
      });
      coreLog.warn("Broker target version preflight failed", { command_id: command.id, reason });
      return;
    }

    const hdsBinding = hds.createExecutionAuthorityBinding(command, targetVersionObservation);
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
    }, reviewed.command_digest, hdsBinding, targetVersionObservation);
    planBound = hds.isOperationPlanCommand(command.id);
    const admission = planBound ? executionAdmissionForCommand(command, executorApproval.receipt(approvedCommand)) : undefined;
    let planAttemptRejection: string | undefined;
    if (!hds.beginOperationPlanAttempt(command, admission, (reason) => { planAttemptRejection = reason; })) {
      hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: inbound.user,
        reason: "plan_attempt_not_admitted",
      });
      gatewayLog.warn("CLI operation-plan attempt was not admitted", {
        reason: planAttemptRejection ?? "plan_attempt_not_admitted",
        used_for_authority: false,
      });
      auditLog.info("summary", { entries: hds.getAudit().size(), chain_valid: hds.getAudit().verify() });
      return;
    }

    feedback = await executor.execute(approvedCommand, {
      signal: commandAbortController.signal,
      save_result_delivery: planBound,
      before_execute: () => {
        const admission = resourceBackpressure.tryAcquireExecution();
        if (!admission.ok) throw new Error(admission.reason);
        executionAdmissionLease = admission.lease;
      },
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    executionAdmissionLease?.release();
  }
  if (planBound) {
    gatewayLog.info("CLI saved execution result reconciliation",
      reconcileExecutionResults(hds, executionStore, ownerLease.executionEpoch));
  }
  if (feedback.status === "failed" && !requestedStopSignal) {
    for (const signature of extractFailureSignatures({
      kind: "command_result",
      command,
      feedback,
      context: { actor: inbound.user, channel: inbound.channel },
    })) {
      failureMemory.upsertSignature(signature);
    }
  }
  coreLog.info("command", {
    command: command.id.slice(0, 8),
    status: feedback.status,
    duration_ms: feedback.metrics.duration_ms,
  });

  const finalized = finalizeCommandOutput({
    hds,
    command,
    feedback,
    target_surface: "cli",
    request_id: inbound.id,
    development_handoff_store: developmentHandoffStore,
    ...(requestedStopSignal ? { rendered_output_override:
      `停止要求（${requestedStopSignal}）を受け付けました。実行停止と外部作用の結果は未確認の可能性があります。` +
      `重複実行の前に、同じrequest_idに結び付く現在状態を確認してください。\nrequest_id=${inbound.id}` } :
      goalCompletionRules ? { rendered_output_after_feedback: () => renderCurrentCliGoalCompletionProjection({
      hds,
      request_id: inbound.id,
      rules: goalCompletionRules,
      }) } : {}),
  });
  const output = finalized.rendered_output;

  if (requestedStopSignal && output) {
    process.stdout.write(`${output}\n`);
  } else if (goalCompletionRules && output) {
    process.stdout.write(`${output}\n`);
  } else if (!requestedStopSignal && feedback.status === "success" && command.type === "llm_call") {
    const result = finalized.reviewed_feedback.result as {
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
    coreLog.error("error", { error: requestedStopSignal ? "cli_command_interrupted" : feedback.error });
  }

  if (output && command.type !== "llm_call" && !goalCompletionRules && !requestedStopSignal) {
    coreLog.info("command.output", { content: output });
  }

  auditLog.info("summary", {
    entries: hds.getAudit().size(),
    chain_valid: hds.getAudit().verify(),
  });
  } finally {
    hds.closeOperationPlanMemory();
  }
}

async function readCliDocumentOrganizationSource(input: AsyncIterable<Uint8Array>): Promise<string> {
  const maxBytes = DOCUMENT_ORGANIZATION_MAX_SOURCE_CHARS * 4;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) throw new Error("cli_document_organization_source_too_large");
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("cli_document_organization_source_invalid_utf8");
  }
  if (!source.trim() || source.length > DOCUMENT_ORGANIZATION_MAX_SOURCE_CHARS) {
    throw new Error("cli_document_organization_source_length_invalid");
  }
  return source;
}
