import { randomUUID } from "node:crypto";
import {
  COMPLETE_HISTORY_SCHEMA_VERSION,
  CompleteHistoryStore,
  HDSUpperController,
  extractFailureSignatures,
  runPeriodicFailureMemoryVerification,
} from "@blue-tanuki/hds-brain";
import type {
  ApprovalEvaluation,
  CompleteHistoryAppendInput,
  CompleteHistoryEntry,
  CompleteHistoryReplayFilter,
  DecisionLog,
  OutputAuditLog,
  PeriodicVerificationTrigger,
} from "@blue-tanuki/hds-brain";
import {
  buildOperationCoreApprovalTrace,
  Executor,
  ToolRegistry,
  createExecutorApprovalAuthority,
  createLogger,
} from "@blue-tanuki/core";
import { buildFailureMemoryStore, buildHDSMemoryStore, buildSessionStore } from "./runtime.js";
import { buildAuditLog } from "./audit_config.js";
import {
  buildLLMBackendFromEnv,
  buildLLMCommandRouteFromEnv,
  describeLLMCommandRoute,
  describeLLMConfig,
} from "./llm_config.js";
import {
  InboundRouter,
  OutboundDispatcher,
  type InboundChannel,
  type OutboundChannel,
} from "@blue-tanuki/channel-base";
import type {
  ExecuteCommand,
  ExecuteFeedback,
  InboundRequest,
} from "@blue-tanuki/protocol";
import { parseInboundRequestAtBoundary } from "@blue-tanuki/protocol";
import type {
  WebChatChannel,
  WebChatApprovalQueueItem,
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatEmergencyStopSnapshot,
  WebChatApprovalControlContext,
  WebChatAuthorityTraceItem,
  WebChatEvidenceControlContext,
  WebChatHistoryReplayFilter,
  WebChatHistorySnapshot,
  WebChatResumeContext,
} from "@blue-tanuki/channel-webchat";
import { renderCommandOutput } from "./result_render.js";
import { approvalDeniedFeedback, approvalRequiredMessage, buildApprovalRuntime } from "./approval_runtime.js";
import { loadPluginRuntime } from "./plugin_loader.js";
import { createWebChatSettingsSurface } from "./settings_surface.js";
import { buildAboutSnapshot } from "./about_surface.js";
import {
  buildRecoverySnapshot,
  createRecoveryBackup,
  factoryResetRecovery,
  resetRecoveryConnector,
  resetRecoveryProvider,
  restoreRecoveryBackup,
} from "./recovery_surface.js";
import {
  buildUpdateSnapshot,
  prepareManualUpdate,
  verifyUpdateCandidate,
} from "./update_surface.js";
import { createGatewayEvidencePack } from "./evidence_pack.js";
import { CronSchedulerChannel, cronSchedulesFromEnv } from "./cron_channel.js";
import { googleDailyBriefProviderFromEnv } from "./google_daily_brief.js";
import {
  RuntimeScheduleManager,
  runtimeScheduleMutationCommand,
} from "./runtime_schedule.js";
import { buildRuntimeStatusSnapshot } from "./runtime_status.js";
import { buildResidentNotificationsSnapshot } from "./resident_notifications.js";
import { probeGatewaySelfHealth } from "./runtime_health.js";
import { resolveAllSecretRefs } from "./secret_store.js";
import {
  commandOperation,
  commandHistoryDescriptor,
  digestString,
  digestValue,
  hdsDecisionHistoryPayload,
  humanizeDecision,
  isComposioExecuteCommand,
  isCompleteHistoryKind,
  metadataKeys,
  projectApprovalGrant,
  projectApprovalHistoryEntry,
  projectCompleteHistoryEntry,
  projectOperationCoreExecutionHistory,
} from "./serve_projection.js";
import {
  DAILY_OPERATOR_REQUIRED_PERMISSIONS,
  DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS,
  WRITING_OPERATOR_REQUIRED_PERMISSIONS,
} from "./serve_operator_permissions.js";

/**
 * Gateway serve mode.
 *
 * Wires HDS-BRAIN, the executor, WebChat, Slack, Discord, Teams, and LINE. HDS-BRAIN
 * remains the upstream state owner; LLM calls stay downstream.
 */

interface ServeShutdown {
  shutdown: () => Promise<void>;
}

const gatewayLog = createLogger({ scope: "gateway" });
const hdsLog = createLogger({ scope: "hds-brain" });
const coreLog = createLogger({ scope: "blue-tanuki" });
const auditLog = createLogger({ scope: "audit" });
const slackLog = createLogger({ scope: "slack" });
const discordLog = createLogger({ scope: "discord" });
const teamsLog = createLogger({ scope: "teams" });
const lineLog = createLogger({ scope: "line" });
const telegramLog = createLogger({ scope: "telegram" });
const cronLog = createLogger({ scope: "cron" });

interface PendingApproval {
  command: ExecuteCommand;
  log: DecisionLog;
  origin: InboundRequest;
  evaluation: ApprovalEvaluation;
  approval_token?: string;
  approval_token_expires_at_ms?: number;
}

interface EmergencyStopState {
  active: boolean;
  activated_at: number | null;
  activated_by: string | null;
  reason: string | null;
  cleared_at: number | null;
  cleared_by: string | null;
  clear_reason: string | null;
}

type OperatorSnapshot = Record<string, unknown>;
type DailySurfaceSnapshotFn = (input: {
  env: NodeJS.ProcessEnv;
  scheduled_tasks: readonly unknown[];
  runtime_schedules: readonly unknown[];
}) => OperatorSnapshot;
type OperatorSurfaceSnapshotFn = () => OperatorSnapshot;

export interface GatewayInboundBoundaryResult {
  request: InboundRequest;
  boundary_ok: boolean;
  boundary_issues: readonly string[];
}

export interface GatewayInboundBoundaryPlan extends GatewayInboundBoundaryResult {
  hdsBoundaryInput: unknown;
}

/** Resolve the address to send replies back to. */
function replyTarget(req: InboundRequest): string {
  const m = req.metadata?.["reply_to"];
  return typeof m === "string" && m.length > 0 ? m : req.user;
}

export function canonicalizeGatewayInbound(raw: unknown): GatewayInboundBoundaryResult {
  const boundary = parseInboundRequestAtBoundary(raw);
  if (boundary.ok) {
    return { request: boundary.request, boundary_ok: true, boundary_issues: [] };
  }
  return {
    request: {
      id: `invalid-gateway-boundary-${randomUUID()}`,
      channel: "invalid",
      user: "unknown",
      content: "Invalid inbound request rejected at gateway boundary. No downstream action requested.",
      timestamp: Date.now(),
      metadata: {
        "blue_tanuki.boundary_failure": "gateway_inbound",
      },
    },
    boundary_ok: false,
    boundary_issues: boundary.issues,
  };
}

export function planGatewayInboundBoundary(raw: unknown): GatewayInboundBoundaryPlan {
  const boundary = canonicalizeGatewayInbound(raw);
  return {
    ...boundary,
    hdsBoundaryInput: boundary.boundary_ok ? boundary.request : raw,
  };
}

export function gatewayInboundAllowsDownstream(boundary: Pick<GatewayInboundBoundaryPlan, "boundary_ok">): boolean {
  return boundary.boundary_ok;
}

function unavailableOperatorSurface(surface: "daily" | "developer" | "writing"): OperatorSnapshot {
  return {
    surface,
    layer: "A",
    status: "preview_unavailable",
    authority: "hds_brain_downstream_device",
    replaces_authority: false,
    raw_authority_added: false,
    operations: [],
    next_recommended_action: `Install the ${surface} operator preview package outside the core release path if this surface is needed.`,
  };
}

export async function serve(): Promise<ServeShutdown> {
  Object.assign(process.env, resolveAllSecretRefs(process.env));
  const plugins = await loadPluginRuntime();
  plugins.enforceLLMConfig(process.env);
  plugins.enforceSessionConfig(process.env);
  plugins.enforceAuditConfig(process.env);
  const dailySurfaceSnapshot: DailySurfaceSnapshotFn =
    plugins.has("@blue-tanuki/operator-daily")
      ? plugins.getSurface<DailySurfaceSnapshotFn>({
          package_name: "@blue-tanuki/operator-daily",
          required_permissions: DAILY_OPERATOR_REQUIRED_PERMISSIONS,
          action: "register daily operator surface",
        })
      : () => unavailableOperatorSurface("daily");
  const developerSurfaceSnapshot: OperatorSurfaceSnapshotFn =
    plugins.has("@blue-tanuki/operator-developer")
      ? plugins.getSurface<OperatorSurfaceSnapshotFn>({
          package_name: "@blue-tanuki/operator-developer",
          required_permissions: DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS,
          action: "register developer operator surface",
        })
      : () => unavailableOperatorSurface("developer");
  const writingSurfaceSnapshot: OperatorSurfaceSnapshotFn =
    plugins.has("@blue-tanuki/operator-writing")
      ? plugins.getSurface<OperatorSurfaceSnapshotFn>({
          package_name: "@blue-tanuki/operator-writing",
          required_permissions: WRITING_OPERATOR_REQUIRED_PERMISSIONS,
          action: "register writing operator surface",
        })
      : () => unavailableOperatorSurface("writing");

  gatewayLog.info("BLUE-TANUKI starting (Phase 5-S2: plugin-loaded serve mode)");
  gatewayLog.info("LLM config", describeLLMConfig());
  gatewayLog.info("LLM command route", describeLLMCommandRoute());

  const tools = new ToolRegistry();
  plugins.registerTools(tools);
  const llm = buildLLMBackendFromEnv();

  const runtimeSelfHealth = await probeGatewaySelfHealth(process.env);
  const hds = new HDSUpperController({
    audit: buildAuditLog(),
    memory: buildHDSMemoryStore(process.env),
    llm_route: buildLLMCommandRouteFromEnv(),
    self_health: runtimeSelfHealth,
  });
  const failureMemory = buildFailureMemoryStore(process.env);
  const completeHistoryFile = nonEmptyEnv(process.env.BLUE_TANUKI_COMPLETE_HISTORY_FILE);
  const completeHistoryMaxEntries = parsePositiveInt(process.env.BLUE_TANUKI_COMPLETE_HISTORY_MAX_ENTRIES);
  const completeHistory = new CompleteHistoryStore({
    filepath: completeHistoryFile,
    max_entries: completeHistoryMaxEntries,
  });
  gatewayLog.info("complete history", {
    persistence: completeHistoryFile ? "jsonl" : "memory",
    entries: completeHistory.size(),
    max_entries: completeHistoryMaxEntries ?? "unbounded",
  });
  hds.onRuntimeInvariantsEvidence({ reason: "gateway_startup" });
  const runtimeSchedules = await RuntimeScheduleManager.open({
    env: process.env,
    onLifecycle: (event, lifecycle) => {
      hds.onScheduleLifecycle(event, lifecycle);
    },
  });
  for (const tool of runtimeSchedules.tools()) tools.register(tool);
  const approval = buildApprovalRuntime(process.env);
  const pendingApprovals = new Map<string, PendingApproval>();
  const emergencyStop: EmergencyStopState = {
    active: false,
    activated_at: null,
    activated_by: null,
    reason: null,
    cleared_at: null,
    cleared_by: null,
    clear_reason: null,
  };
  const router = new InboundRouter();
  const dispatcher = new OutboundDispatcher();

  const port = parseInt(process.env.WEBCHAT_PORT ?? "8787", 10);
  const webchatPermissions = [
    "network:listen",
    "secrets:WEBCHAT_TOKEN",
    "secrets:WEBCHAT_RESUME_TOKEN",
    ...(process.env.WEBHOOK_TOKEN ? ["secrets:WEBHOOK_TOKEN"] : []),
    ...(process.env.BLUE_TANUKI_SETTINGS_TOKEN
      ? ["secrets:BLUE_TANUKI_SETTINGS_TOKEN"]
      : []),
  ] as const;
  plugins.requirePermissions(
    "@blue-tanuki/channel-webchat",
    webchatPermissions,
    "read/register webchat channel",
  );
  const token = process.env.WEBCHAT_TOKEN;
  if (!token) {
    throw new Error("WEBCHAT_TOKEN is required for serve mode");
  }
  const resumeToken = process.env.WEBCHAT_RESUME_TOKEN;
  if (!resumeToken) {
    throw new Error("WEBCHAT_RESUME_TOKEN is required for serve mode");
  }
  if (resumeToken === token) {
    throw new Error("WEBCHAT_RESUME_TOKEN must differ from WEBCHAT_TOKEN");
  }
  const cronTasks = cronSchedulesFromEnv(process.env);
  const cron = new CronSchedulerChannel({
    tasks: [...cronTasks, ...runtimeSchedules.activeCronTasks()],
    log: (line: string) => cronLog.info(line),
    content_provider: googleDailyBriefProviderFromEnv(process.env),
    onFire: (task) => {
      hds.onScheduleLifecycle("schedule.lifecycle.fired", {
        schedule_id: task.id,
        origin: task.origin,
        operation: "fire",
        actor: "blue-tanuki-cron",
        payload_hash: task.payload_hash,
        request_id: null,
      });
    },
  });
  runtimeSchedules.attachScheduler(cron);

  // Forward declarations: resume/approval closures resolve at call time.
  // eslint-disable-next-line prefer-const
  let executor: Executor;
  const executorApproval = createExecutorApprovalAuthority();
  let webchat: WebChatChannel;

  function recordCompleteHistory(input: CompleteHistoryAppendInput): CompleteHistoryEntry | null {
    try {
      return completeHistory.append(input);
    } catch (e) {
      gatewayLog.error("complete history append failed", {
        kind: input.kind,
        request_id: input.request_id ?? null,
        command_id: input.command_id ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  function runFailureMemoryVerification(trigger: PeriodicVerificationTrigger): void {
    const report = runPeriodicFailureMemoryVerification({
      entries: completeHistory.all(),
      existing_rules: failureMemory.list(),
      trigger,
    });
    gatewayLog.info("failure memory verification", {
      trigger,
      detected_failures: report.detected_failures.length,
      repeated_failures: report.repeated_failures.length,
      recommended_rules: report.recommended_rules.length,
      stale_rules: report.stale_rules.length,
      requires_human_review: report.requires_human_review.length,
    });
  }

  runFailureMemoryVerification("startup");
  const failureMemoryVerificationTimer = setInterval(
    () => runFailureMemoryVerification("daily"),
    24 * 60 * 60 * 1000,
  );
  failureMemoryVerificationTimer.unref();

  function recordApprovalHistory(
    event: string,
    cmd: ExecuteCommand,
    log: DecisionLog,
    origin: InboundRequest,
    actor: string,
    evaluation: ApprovalEvaluation | null,
    extra: Record<string, unknown> = {},
  ): void {
    recordCompleteHistory({
      kind: "approval_history",
      request_id: log.request_id,
      command_id: cmd.id,
      actor,
      source: "approval_runtime",
      timestamp: Date.now(),
      payload: {
        event,
        command: commandHistoryDescriptor(cmd),
        decision: evaluation?.decision ?? null,
        risk: evaluation?.risk ?? null,
        approval_level: evaluation?.approval_level ?? null,
        final_review_required: evaluation?.final_review_required ?? false,
        reason: evaluation?.reason ?? null,
        operation: evaluation?.context.operation ?? commandOperation(cmd),
        origin_channel: origin.channel,
        operation_core: evaluation
          ? buildOperationCoreApprovalTrace({
              command: cmd,
              operation: evaluation.context.operation,
              state: approvalTraceState(event, evaluation),
              risk: evaluation.risk,
              approval_level: evaluation.approval_level,
              final_review_required: evaluation.final_review_required,
            })
          : undefined,
        ...extra,
      },
    });
  }

  function approvalTraceState(
    event: string,
    evaluation: ApprovalEvaluation,
  ): "awaiting_permission" | "approved" | "failed" | "suspended" {
    if (event.includes("emergency_stop")) return "suspended";
    if (event.includes("pending") || evaluation.decision === "ask") return "awaiting_permission";
    if (event.includes("approved") || evaluation.decision === "allow") return "approved";
    return "failed";
  }

  function recordApprovalControlHistory(
    event: string,
    actor: string,
    extra: Record<string, unknown> = {},
  ): void {
    recordCompleteHistory({
      kind: "approval_history",
      request_id: typeof extra.request_id === "string" ? extra.request_id : null,
      command_id: typeof extra.command_id === "string" ? extra.command_id : null,
      actor,
      source: "approval_control",
      timestamp: Date.now(),
      payload: {
        event,
        final_review_required: false,
        used_for_authority: false,
        ...extra,
      },
    });
  }

  function emergencyStopSnapshot(): WebChatEmergencyStopSnapshot {
    return {
      active: emergencyStop.active,
      activated_at: emergencyStop.activated_at,
      activated_by: emergencyStop.activated_by,
      reason: emergencyStop.reason,
      cleared_at: emergencyStop.cleared_at,
      cleared_by: emergencyStop.cleared_by,
      clear_reason: emergencyStop.clear_reason,
      execution_blocked: emergencyStop.active,
      hds_brain_remains_authority: true,
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE", "LIVE_RUNTIME"],
    };
  }

  function activateEmergencyStop(ctx: WebChatApprovalControlContext): WebChatEmergencyStopSnapshot {
    emergencyStop.active = true;
    emergencyStop.activated_at = Date.now();
    emergencyStop.activated_by = ctx.actor;
    emergencyStop.reason = ctx.reason ?? "owner emergency stop";
    hds.onAuthorityEvent("emergency_stop_activated", {
      actor: ctx.actor,
      reason: emergencyStop.reason,
    });
    recordApprovalControlHistory("emergency_stop_activated", ctx.actor, {
      reason: emergencyStop.reason,
      token_kind: ctx.token_kind,
      execution_blocked: true,
    });
    return emergencyStopSnapshot();
  }

  function clearEmergencyStop(ctx: WebChatApprovalControlContext): WebChatEmergencyStopSnapshot {
    emergencyStop.active = false;
    emergencyStop.cleared_at = Date.now();
    emergencyStop.cleared_by = ctx.actor;
    emergencyStop.clear_reason = ctx.reason ?? "owner emergency stop cleared";
    hds.onAuthorityEvent("emergency_stop_cleared", {
      actor: ctx.actor,
      reason: emergencyStop.clear_reason,
    });
    recordApprovalControlHistory("emergency_stop_cleared", ctx.actor, {
      reason: emergencyStop.clear_reason,
      token_kind: ctx.token_kind,
      execution_blocked: false,
    });
    return emergencyStopSnapshot();
  }

  function approvalGrantsSnapshot(): WebChatApprovalGrantItem[] {
    return approval.listGrants().map(projectApprovalGrant);
  }

  function revokeApprovalGrant(grant_id: string, ctx: WebChatApprovalControlContext): {
    grant_id: string;
    revoked: boolean;
    emergency_stop: WebChatEmergencyStopSnapshot;
  } {
    const before = approval.listGrants().find((grant) => grant.id === grant_id);
    const revoked = approval.revoke(grant_id);
    hds.onAuthorityEvent(revoked ? "grant_revoked" : "grant_revoke_failed", {
      grant_id,
      actor: ctx.actor,
      reason: revoked
        ? ctx.reason ?? `reusable approval grant revoked:${grant_id}`
        : `grant revoke failed:${grant_id}`,
    });
    recordApprovalControlHistory("grant_revoked", ctx.actor, {
      grant_id,
      revoked,
      mode: before?.mode ?? null,
      decision: before?.decision ?? null,
      operation: before?.operation ?? null,
      risk: before?.risk ?? null,
      reason: ctx.reason ?? null,
      token_kind: ctx.token_kind,
    });
    return { grant_id, revoked, emergency_stop: emergencyStopSnapshot() };
  }

  function approvalHistorySnapshot(limit = 50): WebChatApprovalHistoryItem[] {
    return completeHistory
      .replay({ kind: "approval_history" })
      .slice(-limit)
      .map(projectApprovalHistoryEntry);
  }

  function recordExecutionHistory(
    cmd: ExecuteCommand,
    log: DecisionLog,
    origin: InboundRequest,
    actor: string,
    feedback: ExecuteFeedback,
  ): CompleteHistoryEntry | null {
    return recordCompleteHistory({
      kind: "execution_history",
      request_id: log.request_id,
      command_id: cmd.id,
      actor,
      source: "executor",
      timestamp: Date.now(),
      payload: {
        command: commandHistoryDescriptor(cmd),
        origin_channel: origin.channel,
        status: feedback.status,
        result_present: feedback.result !== undefined,
        result_digest: feedback.result === undefined ? undefined : digestValue(feedback.result),
        error: feedback.error,
        metrics: feedback.metrics,
        operation_core: feedback.operation_core,
      },
    });
  }

  function recordFinalOutputHistory(
    log: DecisionLog,
    origin: InboundRequest,
    actor: string,
    output: OutputAuditLog,
  ): void {
    recordCompleteHistory({
      kind: "final_output",
      request_id: output.request_id ?? log.request_id,
      command_id: output.command_id,
      actor,
      source: "output_audit",
      timestamp: output.timestamp,
      payload: {
        origin_channel: origin.channel,
        command_type: output.command_type,
        upstream_commit_hash: output.upstream_commit_hash,
        upstream_decision: output.upstream_decision,
        output_kind: output.output_kind,
        target_surface: output.target_surface,
        status: output.status,
        result_present: output.result_present,
        result_digest: output.result_digest,
        rendered_output_present: output.rendered_output_present,
        rendered_output_digest: output.rendered_output_digest,
        rendered_output_chars: output.rendered_output_chars,
        user_visible_output: output.user_visible_output,
        external_side_effect_result: output.external_side_effect_result,
        used_for_authority: output.used_for_authority,
        release_decision: output.release_decision,
        reason: output.reason,
      },
    });
  }

  /**
   * Run a command through the executor, then mirror user-visible command
   * output back to the originating channel as a channel_send.
   */
  async function executeAndEcho(
    cmd: ExecuteCommand,
    log: DecisionLog,
    origin: InboundRequest,
    opts: { skip_approval?: boolean; actor?: string; approval_evaluation?: ApprovalEvaluation } = {},
  ): Promise<{ status: string }> {
    const actor = opts.actor ?? origin.user;
    let executionEvaluation = opts.approval_evaluation ?? null;
    if (emergencyStop.active) {
      hds.onAuthorityEvent("emergency_stop_blocked", {
        request_id: log.request_id,
        command_id: cmd.id,
        actor,
        reason: emergencyStop.reason ?? "owner emergency stop active",
      });
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", {
        actor,
        reason: "emergency_stop_active",
      });
      recordApprovalHistory("emergency_stop_blocked", cmd, log, origin, actor, null, {
        emergency_stop_active: true,
        emergency_stop_reason: emergencyStop.reason,
      });
      await dispatcher.dispatch(
        {
          channel: origin.channel,
          target: replyTarget(origin),
          content: `[emergency-stop-active] command_id=${cmd.id} executed=false next_action=Clear emergency stop from Control Center approvals only after reviewing the stop reason.`,
        },
        {
          command_id: `emergency-stop-blocked-${cmd.id}`,
          upstream_commit_hash: log.commit.hash,
        },
      );
      return { status: "emergency_stop_blocked" };
    }
    const failureGate = failureMemory.evaluateCommandGate(cmd, {
      actor,
      channel: origin.channel,
      request_id: log.request_id,
      origin_user: origin.user,
    });
    recordApprovalHistory("failure_memory_gate", cmd, log, origin, actor, null, {
      gate_decision: failureGate.decision,
      gate_reason: failureGate.reason,
      matched_signature_ids: failureGate.applied_signature_ids,
      requires_human_review: failureGate.requires_human_review,
    });
    if (failureGate.decision === "block") {
      hds.onCommandLifecycle(cmd.id, "approval_rejected", {
        actor,
        reason: `failure_memory:${failureGate.reason}`,
      });
      const content = `[blocked] Failure memory gate blocked execution. command_id=${cmd.id} reason=${failureGate.reason}`;
      await dispatcher.dispatch(
        { channel: origin.channel, target: replyTarget(origin), content },
        { command_id: `failure-memory-blocked-${cmd.id}`, upstream_commit_hash: log.commit.hash },
      );
      return { status: "failure_memory_blocked" };
    }
    if (!opts.skip_approval) {
      const evaluation = approval.evaluate(cmd, actor);
      executionEvaluation = evaluation;
      hds.onApprovalEvaluation(evaluation, { request_id: log.request_id });
      recordApprovalHistory("policy_evaluation", cmd, log, origin, actor, evaluation);
      if (evaluation.decision === "deny") {
        hds.onCommandLifecycle(cmd.id, "approval_rejected", { actor, reason: evaluation.reason });
        recordApprovalHistory("approval_denied", cmd, log, origin, actor, evaluation);
        const fb = approvalDeniedFeedback(cmd, evaluation.reason);
        const content = renderCommandOutput(cmd, fb);
        const output = hds.onOutputAudit({ command: cmd, feedback: fb, rendered_output: content, target_surface: "channel", request_id: log.request_id });
        recordFinalOutputHistory(log, origin, actor, output);
        if (content) await dispatcher.dispatch({ channel: origin.channel, target: replyTarget(origin), content }, { command_id: cmd.id, upstream_commit_hash: log.commit.hash });
        return { status: "approval_denied" };
      }
      const failureMemoryRequiresApproval = failureGate.decision === "require_approval";
      if (evaluation.decision === "ask" || failureMemoryRequiresApproval) {
        if (runtimeScheduleMutationCommand(cmd)) {
          const prepared = runtimeSchedules.preparePending(cmd, evaluation, {
            request_id: log.request_id,
            actor,
          });
          if (!prepared.ok) {
            hds.onCommandLifecycle(cmd.id, "approval_rejected", {
              actor,
              reason: prepared.message,
            });
            recordApprovalHistory("schedule_approval_rejected", cmd, log, origin, actor, evaluation, {
              prepared: false,
              schedule_rejection_reason: prepared.message,
            });
            await dispatcher.dispatch(
              { channel: origin.channel, target: replyTarget(origin), content: prepared.message },
              { command_id: `schedule-rejected-${cmd.id}`, upstream_commit_hash: log.commit.hash },
            );
            return { status: "schedule_rejected" };
          }
        }
        hds.onCommandLifecycle(cmd.id, "approval_pending", {
          actor,
          reason: failureMemoryRequiresApproval ? `failure_memory:${failureGate.reason}` : evaluation.reason,
        });
        const issued = await webchat.issueResumeApprovalToken(cmd.id);
        recordApprovalHistory("approval_pending", cmd, log, origin, actor, evaluation, {
          failure_memory_required: failureMemoryRequiresApproval,
          failure_memory_reason: failureMemoryRequiresApproval ? failureGate.reason : undefined,
          approval_token_issued: Boolean(issued?.token),
          approval_token_expires_at_ms: issued?.expires_at_ms,
        });
        pendingApprovals.set(cmd.id, {
          command: cmd,
          log,
          origin,
          evaluation,
          approval_token: issued?.token,
          approval_token_expires_at_ms: issued?.expires_at_ms,
        });
        const approvalContent = failureMemoryRequiresApproval
          ? `${approvalRequiredMessage(evaluation, cmd.id, issued?.token)} failure_memory_gate=${failureGate.reason}`
          : approvalRequiredMessage(evaluation, cmd.id, issued?.token);
        await dispatcher.dispatch(
          { channel: origin.channel, target: replyTarget(origin), content: approvalContent },
          { command_id: `approval-${cmd.id}`, upstream_commit_hash: log.commit.hash },
        );
        return { status: "approval_required" };
      }
      hds.onCommandLifecycle(cmd.id, "approval_approved", { actor, reason: evaluation.reason });
      recordApprovalHistory("approval_approved", cmd, log, origin, actor, evaluation);
    }
    if (isComposioExecuteCommand(cmd)) {
      hds.onAuthorityEvent("composio_execution_requested", {
        request_id: log.request_id,
        command_id: cmd.id,
        actor,
        reason: "composio_execute_pre_executor",
        evaluation: executionEvaluation ?? undefined,
      });
      recordCompleteHistory({
        kind: "audit_history",
        request_id: log.request_id,
        command_id: cmd.id,
        actor,
        source: "composio_execution",
        timestamp: Date.now(),
        payload: {
          event: "composio_execution_requested",
          command: commandHistoryDescriptor(cmd),
          approval_level: executionEvaluation?.approval_level ?? null,
          final_review_required: executionEvaluation?.final_review_required ?? true,
          used_for_authority: false,
        },
      });
    }
    if (!executionEvaluation) {
      throw new Error("approval evaluation proof is required before executor execution");
    }
    const approvedCommand = executorApproval.approve(cmd, {
      source: opts.skip_approval ? "human_final_review" : "approval_gate",
      decision: opts.skip_approval ? "approve" : "allow",
      approved_by: actor,
      approved_at_ms: Date.now(),
      upstream_commit_hash: cmd.upstream_decision.commit_hash,
      operation: executionEvaluation.context.operation,
      risk: executionEvaluation.risk,
      final_review_required: executionEvaluation.final_review_required,
      reason: executionEvaluation.reason,
    });
    const fb = await executor.execute(approvedCommand);
    if (isComposioExecuteCommand(cmd)) {
      hds.onAuthorityEvent(
        fb.status === "success" ? "composio_execution_completed" : "composio_execution_failed",
        {
          request_id: log.request_id,
          command_id: cmd.id,
          actor,
          reason: `composio_execute_post_executor:${fb.status}`,
          evaluation: executionEvaluation ?? undefined,
        },
      );
      recordCompleteHistory({
        kind: "audit_history",
        request_id: log.request_id,
        command_id: cmd.id,
        actor,
        source: "composio_execution",
        timestamp: Date.now(),
        payload: {
          event: fb.status === "success" ? "composio_execution_completed" : "composio_execution_failed",
          command: commandHistoryDescriptor(cmd),
          status: fb.status,
          result_present: fb.result !== undefined,
          result_digest: fb.result === undefined ? undefined : digestValue(fb.result),
          error: fb.error,
          used_for_authority: false,
        },
      });
    }
    hds.onFeedback(fb);
    const executionHistory = recordExecutionHistory(cmd, log, origin, actor, fb);
    if (fb.status === "failed") {
      const extracted = executionHistory
        ? extractFailureSignatures({ kind: "complete_history", entry: executionHistory })
        : extractFailureSignatures({ kind: "command_result", command: cmd, feedback: fb });
      for (const signature of extracted) failureMemory.upsertSignature(signature);
      runFailureMemoryVerification("post_failure");
    }
    coreLog.info("command", { command: cmd.id.slice(0, 8), status: fb.status, duration_ms: fb.metrics.duration_ms });
    const content = renderCommandOutput(cmd, fb);
    const output = hds.onOutputAudit({ command: cmd, feedback: fb, rendered_output: content, target_surface: "channel", request_id: log.request_id });
    recordFinalOutputHistory(log, origin, actor, output);
    if (content) await dispatcher.dispatch({ channel: origin.channel, target: replyTarget(origin), content }, { command_id: cmd.id, upstream_commit_hash: log.commit.hash });
    return { status: fb.status };
  }

  async function resumePendingApproval(command_id: string, verdict: "approve" | "reject" | "block", ctx: WebChatResumeContext): Promise<unknown> {
    const pending = pendingApprovals.get(command_id);
    if (!pending) return null;
    if (verdict === "approve" && emergencyStop.active) {
      const issued = await webchat.issueResumeApprovalToken(command_id);
      pendingApprovals.set(command_id, {
        ...pending,
        approval_token: issued?.token,
        approval_token_expires_at_ms: issued?.expires_at_ms,
      });
      hds.onAuthorityEvent("emergency_stop_blocked", {
        request_id: pending.log.request_id,
        command_id,
        actor: ctx.actor,
        reason: emergencyStop.reason ?? "owner emergency stop active",
      });
      recordApprovalHistory("emergency_stop_blocked_approval", pending.command, pending.log, pending.origin, ctx.actor, pending.evaluation, {
        verdict,
        token_kind: ctx.token_kind,
        approval_token_reissued: Boolean(issued?.token),
        approval_token_expires_at_ms: issued?.expires_at_ms,
        emergency_stop_reason: emergencyStop.reason,
      });
      await dispatcher.dispatch({
        channel: pending.origin.channel,
        target: replyTarget(pending.origin),
        content: `[emergency-stop-active] command_id=${command_id} approval=approve executed=false pending=true next_action=Clear emergency stop only after reviewing the stop reason, then reload approvals for a fresh token.`,
      }, {
        command_id: `emergency-stop-approval-blocked-${command_id}`,
        upstream_commit_hash: pending.log.commit.hash,
      });
      return {
        approval: "approve",
        executed: false,
        status: "emergency_stop_active",
        pending: true,
        approval_token_reissued: Boolean(issued?.token),
      };
    }
    pendingApprovals.delete(command_id);
    if (verdict !== "approve") {
      runtimeSchedules.rejectPending(command_id, ctx.actor, `human_approval:${verdict}`);
      hds.onCommandLifecycle(command_id, "approval_rejected", { actor: ctx.actor, reason: `human_approval:${verdict}` });
      recordApprovalHistory("human_resume_rejected", pending.command, pending.log, pending.origin, ctx.actor, pending.evaluation, {
        verdict,
        token_kind: ctx.token_kind,
      });
      await dispatcher.dispatch({ channel: pending.origin.channel, target: replyTarget(pending.origin), content: `[approval-${verdict}] command_id=${command_id}` }, { command_id: `approval-${verdict}-${command_id}`, upstream_commit_hash: pending.log.commit.hash });
      return { approval: verdict, executed: false };
    }
    if (runtimeScheduleMutationCommand(pending.command) && !runtimeSchedules.hasPending(command_id)) {
      const content = "[schedule-expired] approval expired before activation. activated=false can_fire=false next_action=Submit the schedule request again and approve the new command_id.";
      hds.onCommandLifecycle(command_id, "approval_rejected", { actor: ctx.actor, reason: "schedule_approval_expired" });
      recordApprovalHistory("schedule_approval_expired", pending.command, pending.log, pending.origin, ctx.actor, pending.evaluation, {
        verdict,
        token_kind: ctx.token_kind,
      });
      await dispatcher.dispatch({ channel: pending.origin.channel, target: replyTarget(pending.origin), content }, { command_id: `schedule-expired-${command_id}`, upstream_commit_hash: pending.log.commit.hash });
      return { approval: "approve", executed: false, status: "schedule_approval_expired" };
    }
    if (ctx.approval?.remember || ctx.approval?.mode) {
      const grant = approval.remember(pending.evaluation, { actor: ctx.actor, mode: ctx.approval.mode, duration_ms: ctx.approval.duration_ms, note: `remembered from approval of command_id=${command_id}` });
      hds.onAuthorityEvent("grant_created", {
        request_id: pending.log.request_id,
        command_id,
        grant_id: grant.id,
        actor: ctx.actor,
        reason: `remembered from approval of command_id=${command_id}`,
        evaluation: pending.evaluation,
      });
    }
    hds.onCommandLifecycle(command_id, "approval_approved", { actor: ctx.actor, reason: "human_approval:approve" });
    recordApprovalHistory("human_resume_approved", pending.command, pending.log, pending.origin, ctx.actor, pending.evaluation, {
      verdict,
      token_kind: ctx.token_kind,
      remember_requested: Boolean(ctx.approval?.remember || ctx.approval?.mode),
    });
    const r = await executeAndEcho(pending.command, pending.log, pending.origin, {
      skip_approval: true,
      actor: ctx.actor,
      approval_evaluation: pending.evaluation,
    });
    return { approval: "approve", executed: true, status: r.status };
  }

  webchat = plugins.createChannel<WebChatChannel>({
    package_name: "@blue-tanuki/channel-webchat",
    required_permissions: webchatPermissions,
    action: "register webchat channel",
    constructor_args: [{
      port,
      token,
      resume_token: resumeToken,
      webhook_token: process.env.WEBHOOK_TOKEN,
      host: process.env.WEBCHAT_HOST ?? "127.0.0.1",
      settings: createWebChatSettingsSurface({
        env: process.env,
        plugins,
      }),
      runtime: {
        getSnapshot: async () => {
          const hdsSnapshot = hds.getRuntimeSnapshot();
          const pendingApprovals = pendingApprovalSnapshot();
          const runtimeSchedulesCount = runtimeSchedules.activeCount();
          const pendingScheduleApprovalsCount = runtimeSchedules.pendingCount();
          const scheduledTasks = cron.snapshot();
          const runtimeScheduleSnapshot = runtimeSchedules.snapshot();
          return {
            ...buildRuntimeStatusSnapshot({
              gateway_status: "running",
              hds: hdsSnapshot,
              webchat_token: process.env.WEBCHAT_TOKEN,
              webchat_resume_token: process.env.WEBCHAT_RESUME_TOKEN,
              telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN,
              pending_approvals_count: pendingApprovals.length,
              runtime_schedules_count: runtimeSchedulesCount,
              pending_schedule_approvals_count: pendingScheduleApprovalsCount,
            }),
            hds: hdsSnapshot,
            emergency_stop: emergencyStopSnapshot(),
            pending_approvals: pendingApprovals,
            scheduled_tasks: scheduledTasks,
            operator_surfaces: {
              daily: dailySurfaceSnapshot({
                env: process.env,
                scheduled_tasks: scheduledTasks,
                runtime_schedules: runtimeScheduleSnapshot,
              }),
              developer: developerSurfaceSnapshot(),
              writing: writingSurfaceSnapshot(),
            },
            runtime_schedules_count: runtimeSchedulesCount,
            pending_schedule_approvals_count: pendingScheduleApprovalsCount,
            runtime_schedules: runtimeScheduleSnapshot,
            operation_core_execution: projectOperationCoreExecutionHistory(
              completeHistory.replay({ kind: "execution_history" }),
              {
                chain_valid: completeHistory.verify(),
                skipped_count: completeHistory.skippedCount(),
              },
            ),
          };
        },
      },
      approval: {
        list: async () => pendingApprovalSnapshot(),
        grants: async () => approvalGrantsSnapshot(),
        revokeGrant: async (grant_id: string, ctx: WebChatApprovalControlContext) =>
          revokeApprovalGrant(grant_id, ctx),
        history: async () => approvalHistorySnapshot(),
        emergencyStop: {
          getSnapshot: async () => emergencyStopSnapshot(),
          activate: async (ctx: WebChatApprovalControlContext) =>
            activateEmergencyStop(ctx),
          clear: async (ctx: WebChatApprovalControlContext) =>
            clearEmergencyStop(ctx),
        },
      },
      audit: {
        dump: async (format: "json" | "text") => {
          const entries = hds.getAudit().list();
          const chainValid = hds.getAudit().verify();
          const report = {
            status: entries.length === 0 ? "empty" : chainValid ? "ok" : "broken",
            exit_code: chainValid ? 0 : 1,
            filepath: null,
            entry_count: entries.length,
            chain_valid: chainValid,
            detail: entries.length === 0
              ? "live audit chain is empty"
              : chainValid
              ? `loaded ${entries.length} live entries; chain verified`
              : `loaded ${entries.length} live entries; chain DOES NOT verify`,
            entries,
            timestamp: new Date().toISOString(),
          };
          return format === "text"
            ? {
                content_type: "text/plain; charset=utf-8",
                body: [
                  `blue-tanuki audit-dump - ${String(report.status).toUpperCase()} (${report.timestamp})`,
                  `  filepath:    ${report.filepath ?? "(live)"}`,
                  `  entries:     ${report.entry_count}`,
                  `  chain_valid: ${report.chain_valid}`,
                  `  detail:      ${report.detail}`,
                  "",
                  `Exit code: ${report.exit_code}`,
                ].join("\n"),
              }
            : {
                content_type: "application/json",
                body: JSON.stringify(report, null, 2),
              };
        },
      },
      authority: {
        trace: async () => authorityTraceSnapshot(),
      },
      notifications: {
        list: async () => residentNotificationSnapshot(),
      },
      history: {
        replay: async (filter: WebChatHistoryReplayFilter) => completeHistorySnapshot(filter),
      },
      evidence: {
        exportPack: async (ctx: WebChatEvidenceControlContext) => {
          hds.onAuthorityEvent("evidence_pack_export_requested", {
            actor: ctx.actor,
            reason: "control_center_evidence_export",
          });
          const result = await createGatewayEvidencePack({
            rootDir: process.cwd(),
            env: process.env,
            audit: hds.getAudit(),
            completeHistory,
            requested_by: ctx.actor,
            source: "control_center",
          });
          hds.onAuthorityEvent("evidence_pack_exported", {
            actor: ctx.actor,
            reason: "control_center_evidence_export",
          });
          recordCompleteHistory({
            kind: "audit_history",
            actor: ctx.actor,
            source: "evidence_pack",
            timestamp: Date.now(),
            payload: {
              event: "evidence_pack_exported",
              pack_dir: result.pack_dir,
              files: result.manifest.files.map((file) => file.path),
              audit_chain_valid: result.audit_chain_valid,
              complete_history_chain_valid: result.complete_history_chain_valid,
              used_for_authority: false,
            },
          });
          return result;
        },
      },
      about: {
        getSnapshot: async () => buildAboutSnapshot(),
      },
      update: {
        getSnapshot: async () => buildUpdateSnapshot(process.cwd(), process.env),
        verifyCandidate: async () => verifyUpdateCandidate(process.cwd(), process.env),
        prepareUpdate: async (body: Record<string, unknown>) =>
          prepareManualUpdate(process.cwd(), process.env, {
            confirm: typeof body.confirm === "string" ? body.confirm : undefined,
          }),
      },
      recovery: {
        getSnapshot: async () => buildRecoverySnapshot(process.env),
        createBackup: async () => createRecoveryBackup(process.env),
        restoreBackup: async (body: Record<string, unknown>) =>
          restoreRecoveryBackup(process.env, {
            backup_id: typeof body.backup_id === "string" ? body.backup_id : undefined,
            confirm: typeof body.confirm === "string" ? body.confirm : undefined,
          }),
        resetProvider: async (body: Record<string, unknown>) =>
          resetRecoveryProvider(process.env, {
            confirm: typeof body.confirm === "string" ? body.confirm : undefined,
          }),
        resetConnector: async (body: Record<string, unknown>) =>
          resetRecoveryConnector(process.env, {
            confirm: typeof body.confirm === "string" ? body.confirm : undefined,
          }),
        factoryReset: async (body: Record<string, unknown>) =>
          factoryResetRecovery(process.env, {
            confirm: typeof body.confirm === "string" ? body.confirm : undefined,
          }),
      },
      operators: {
        daily: {
          getSnapshot: async () => dailySurfaceSnapshot({
            env: process.env,
            scheduled_tasks: cron.snapshot(),
            runtime_schedules: runtimeSchedules.snapshot(),
          }),
        },
        developer: {
          getSnapshot: async () => developerSurfaceSnapshot(),
        },
        writing: {
          getSnapshot: async () => writingSurfaceSnapshot(),
        },
      },
      onResume: async (
        request_id: string,
        verdict: "approve" | "reject" | "block",
        ctx: WebChatResumeContext,
      ) => {
        const pending = await resumePendingApproval(request_id, verdict, ctx);
        if (pending) return pending;
        const { log, command, request } = hds.resume(request_id, verdict, { actor: ctx.actor, token_kind: ctx.token_kind });
        recordCompleteHistory({
          kind: "hds_decision",
          request_id: log.request_id,
          command_id: command?.id,
          actor: ctx.actor,
          source: "hds-brain.resume",
          timestamp: log.timestamp,
          payload: {
            ...hdsDecisionHistoryPayload(log, command),
            resumed_request_id: request_id,
            verdict,
            token_kind: ctx.token_kind,
          },
        });
        if (command) {
          const r = await executeAndEcho(command, log, request, { actor: ctx.actor });
          return { decision: log.commit.decision, executed: true, status: r.status };
        }
        return { decision: log.commit.decision, executed: false };
      },
    }],
  });

  function pendingApprovalSnapshot(): WebChatApprovalQueueItem[] {
    return Array.from(pendingApprovals.values()).map((p) => ({
      command_id: p.command.id,
      request_id: p.log.request_id,
      operation: p.evaluation.context.operation,
      risk: p.evaluation.risk,
      approval_level: p.evaluation.approval_level,
      final_review_required: p.evaluation.final_review_required,
      reason: p.evaluation.reason,
      approval_token: p.approval_token,
      approval_token_expires_at_ms: p.approval_token_expires_at_ms,
      authority_trace: p.evaluation.authority_trace,
      operation_core: buildOperationCoreApprovalTrace({
        command: p.command,
        operation: p.evaluation.context.operation,
        state: "awaiting_permission",
        risk: p.evaluation.risk,
        approval_level: p.evaluation.approval_level,
        final_review_required: p.evaluation.final_review_required,
      }),
    }));
  }

  function authorityTraceSnapshot(): WebChatAuthorityTraceItem[] {
    const items: WebChatAuthorityTraceItem[] = [];
    const auditEntries = hds.getAudit().list();
    const requestSources = new Map<
      string,
      { source_process_kind: string; source_channel: string }
    >();
    for (const entry of auditEntries) {
      const log = entry.log;
      if (!("kind" in log)) {
        requestSources.set(log.request_id, {
          source_process_kind: log.frame.process.process_kind,
          source_channel: log.frame.actor.channel,
        });
      }
    }

    for (const entry of auditEntries) {
      const log = entry.log;
      const base = {
        index: entry.index,
        entry_hash: entry.entry_hash,
        request_id: log.request_id ?? null,
        timestamp: log.timestamp,
      };

      if (!("kind" in log)) {
        for (const hit of log.frame.memory_trace.hits) {
          items.push({
            ...base,
            kind: "memory_reference",
            event: "memory.read",
            memory_id: hit.memory_id,
            f_reference: hit.f_reference,
            memory_entry_hash: hit.entry_hash,
            source: hit.source,
            used_for_authority: log.frame.memory_trace.used_for_authority,
            matched_on: hit.matched_on,
            reason: hit.reason,
            summary: hit.summary,
          });
        }
        continue;
      }

      if (log.kind === "approval_gate") {
        items.push({
          ...base,
          kind: "approval_gate",
          event: "approval_gate",
          command_id: log.command_id,
          actor: log.evaluation.context.actor,
          operation: log.evaluation.context.operation,
          risk: log.evaluation.risk,
          reason: log.evaluation.reason,
          decision: log.evaluation.decision,
          authority_trace: log.evaluation.authority_trace,
        });
        continue;
      }

      if (log.kind === "authority_event") {
        items.push({
          ...base,
          kind: "authority_event",
          event: log.event,
          command_id: log.command_id,
          actor: log.actor,
          operation: log.operation,
          risk: log.risk,
          reason: log.reason,
          authority_trace: log.authority_trace,
        });
        continue;
      }

      if (log.kind === "memory_reference") {
        items.push({
          ...base,
          kind: "memory_reference",
          event: log.event,
          memory_id: log.memory_id,
          f_reference: log.f_reference,
          memory_entry_hash: log.entry_hash,
          source: log.source,
          used_for_authority: log.used_for_authority,
          matched_on: log.matched_on,
          reason: log.reason,
          summary: log.summary,
        });
        continue;
      }

      if (log.kind === "executor_feedback") {
        const source = log.request_id
          ? requestSources.get(log.request_id)
          : undefined;
        items.push({
          ...base,
          kind: "executor_feedback",
          event: `executor.${log.feedback.status}`,
          command_id: log.command_id,
          status: log.feedback.status,
          error: log.feedback.error,
          known_command: log.known_command,
          source_process_kind: source?.source_process_kind,
          source_channel: source?.source_channel,
        });
        continue;
      }

      if (log.kind === "output_audit") {
        const source = log.request_id
          ? requestSources.get(log.request_id)
          : undefined;
        items.push({
          ...base,
          kind: "output_audit",
          event: `output.${log.output_kind}`,
          command_id: log.command_id,
          status: log.status,
          source_process_kind: source?.source_process_kind,
          source_channel: source?.source_channel,
          used_for_authority: log.used_for_authority,
          reason: log.reason,
        });
        continue;
      }

      if (log.kind === "runtime_invariants") {
        items.push({
          ...base,
          kind: "runtime_invariants",
          event: log.event,
          used_for_authority: log.used_for_authority,
          reason: log.reason,
          status: log.all_ok ? "pass" : "fail",
          report_digest: log.report_digest,
          evidence_count: log.evidence_count,
        });
        continue;
      }

      if (log.kind === "command_lifecycle") {
        items.push({
          ...base,
          kind: "command_lifecycle",
          event: log.phase,
          command_id: log.command_id,
          actor: log.actor,
          reason: log.reason,
        });
        continue;
      }

      if (log.kind === "schedule_lifecycle") {
        items.push({
          ...base,
          kind: "schedule_lifecycle",
          event: log.event,
          request_id: log.request_id ?? null,
          command_id: log.command_id,
          actor: log.actor,
          operation: log.operation,
          risk: log.risk,
          approval_level: log.approval_level,
          schedule_id: log.schedule_id,
          payload_hash: log.payload_hash,
          previous_payload_hash: log.previous_payload_hash,
        });
      }
    }
    return items;
  }

  function residentNotificationSnapshot() {
    return buildResidentNotificationsSnapshot({
      audit_chain_valid: hds.getAudit().verify(),
      pending_approvals: pendingApprovalSnapshot(),
      authority_trace: authorityTraceSnapshot(),
    });
  }

  function completeHistorySnapshot(filter: WebChatHistoryReplayFilter): WebChatHistorySnapshot {
    const replayFilter: CompleteHistoryReplayFilter = {};
    const invalidKind = filter.kind !== undefined && !isCompleteHistoryKind(filter.kind);
    if (isCompleteHistoryKind(filter.kind)) replayFilter.kind = filter.kind;
    if (filter.request_id !== undefined) replayFilter.request_id = filter.request_id;
    if (filter.command_id !== undefined) replayFilter.command_id = filter.command_id;
    const limit = Number.isInteger(filter.limit)
      ? Math.min(500, Math.max(1, filter.limit!))
      : 100;
    const entries = invalidKind
      ? []
      : completeHistory
          .replay(replayFilter)
          .slice(-limit)
          .map(projectCompleteHistoryEntry);
    return {
      schema_version: COMPLETE_HISTORY_SCHEMA_VERSION,
      entries_count: completeHistory.size(),
      skipped_count: completeHistory.skippedCount(),
      chain_valid: completeHistory.verify(),
      complete_history_used_for_authority: false,
      replay_filter: {
        ...filter,
        limit,
      },
      entries,
    };
  }

  function optionalPreviewChannel(
    packageName: string,
    requiredPermissions: readonly string[],
    action: string,
    constructorArgs: Record<string, unknown>,
  ): (InboundChannel & OutboundChannel) | null {
    if (!plugins.has(packageName)) {
      gatewayLog.info("preview channel skipped", {
        package_name: packageName,
        reason: "plugin_not_present_in_core_release",
      });
      return null;
    }
    return plugins.createChannel<InboundChannel & OutboundChannel>({
      package_name: packageName,
      required_permissions: requiredPermissions,
      action,
      constructor_args: [constructorArgs],
    });
  }

  const telegramPermissions = [
    "network:api.telegram.org",
    "secrets:TELEGRAM_BOT_TOKEN",
  ] as const;
  plugins.requirePermissions(
    "@blue-tanuki/channel-telegram",
    telegramPermissions,
    "read/register telegram channel",
  );
  const telegram = plugins.createChannel<InboundChannel & OutboundChannel>({
    package_name: "@blue-tanuki/channel-telegram",
    required_permissions: telegramPermissions,
    action: "register telegram channel",
    constructor_args: [{
      bot_token: process.env.TELEGRAM_BOT_TOKEN,
      poll_interval_ms: parsePositiveInt(process.env.TELEGRAM_POLL_INTERVAL_MS),
      poll_timeout_sec: parsePositiveInt(process.env.TELEGRAM_POLL_TIMEOUT_SEC),
      log: (line: string) => telegramLog.info(line),
    }],
  });

  const previewChannels = [
    optionalPreviewChannel("@blue-tanuki/channel-slack", [
      "network:slack.com",
      "secrets:SLACK_BOT_TOKEN",
      "secrets:SLACK_APP_TOKEN",
    ], "register slack channel", {
      bot_token: process.env.SLACK_BOT_TOKEN,
      app_token: process.env.SLACK_APP_TOKEN,
      log: (line: string) => slackLog.info(line),
    }),
    optionalPreviewChannel("@blue-tanuki/channel-discord", [
      "network:discord.com",
      "secrets:DISCORD_BOT_TOKEN",
    ], "register discord channel", {
      bot_token: process.env.DISCORD_BOT_TOKEN,
      log: (line: string) => discordLog.info(line),
    }),
    optionalPreviewChannel("@blue-tanuki/channel-teams", [
      "network:graph.microsoft.com",
      "secrets:MICROSOFT_GRAPH_ACCESS_TOKEN",
    ], "register teams channel", {
      access_token: process.env.MICROSOFT_GRAPH_ACCESS_TOKEN,
      log: (line: string) => teamsLog.info(line),
    }),
    optionalPreviewChannel("@blue-tanuki/channel-line", [
      "network:api.line.me",
      "secrets:LINE_CHANNEL_ACCESS_TOKEN",
    ], "register line channel", {
      channel_access_token: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      log: (lineText: string) => lineLog.info(lineText),
    }),
  ].filter((channel): channel is InboundChannel & OutboundChannel => channel !== null);

  router.register(webchat);
  router.register(telegram);
  for (const channel of previewChannels) router.register(channel);
  router.register(cron);

  dispatcher.register(webchat);
  dispatcher.register(telegram);
  for (const channel of previewChannels) dispatcher.register(channel);

  executor = new Executor({
    llm,
    tools,
    approval_authority: executorApproval,
    dispatcher,
    session_store: buildSessionStore(plugins),
  });

  const handler = async (req: InboundRequest): Promise<void> => {
    const boundary = planGatewayInboundBoundary(req);
    const authorityReq = boundary.request;
    // Gateway history, reply, and execution paths use only authorityReq, which
    // is a canonical request or the safe invalid-inbound fallback. Raw invalid
    // input is passed to HDS-BRAIN only for its independent fail-closed
    // authority-boundary audit; raw input must not be used for execution.
    const hdsBoundaryInput = boundary.hdsBoundaryInput;
    recordCompleteHistory({
      kind: "user_input",
      request_id: authorityReq.id,
      actor: authorityReq.user,
      source: authorityReq.channel,
      timestamp: authorityReq.timestamp,
      payload: {
        channel: authorityReq.channel,
        user: authorityReq.user,
        content_digest: boundary.boundary_ok ? digestString(authorityReq.content) : undefined,
        content_chars: boundary.boundary_ok ? authorityReq.content.length : 0,
        metadata_keys: metadataKeys(authorityReq.metadata),
        boundary_status: boundary.boundary_ok ? "canonical" : "invalid_fail_closed",
        boundary_issues_count: boundary.boundary_issues.length,
        reply_to_present: typeof authorityReq.metadata?.["reply_to"] === "string",
        webhook_source: typeof authorityReq.metadata?.["webhook_source"] === "string"
          ? authorityReq.metadata["webhook_source"]
          : undefined,
        operator_surface: typeof authorityReq.metadata?.["blue_tanuki.operator_surface"] === "string"
          ? authorityReq.metadata["blue_tanuki.operator_surface"]
          : undefined,
      },
    });
    const { log, command } = hds.decide(hdsBoundaryInput);
    recordCompleteHistory({
      kind: "hds_decision",
      request_id: log.request_id,
      command_id: command?.id,
      actor: authorityReq.user,
      source: "hds-brain",
      timestamp: log.timestamp,
      payload: hdsDecisionHistoryPayload(log, command),
    });
    hdsLog.info("decision", {
      channel: authorityReq.channel,
      user: authorityReq.user,
      request_id: authorityReq.id.slice(0, 8),
      decision: log.commit.decision,
      hash: log.commit.hash.slice(0, 12),
    });

    if (!gatewayInboundAllowsDownstream(boundary)) {
      if (command) {
        hds.onCommandLifecycle(command.id, "approval_rejected", {
          actor: "gateway",
          reason: "gateway_inbound_boundary_invalid",
        });
      }
      return;
    }

    if (command) {
      await executeAndEcho(command, log, authorityReq);
      return;
    }

    // No command means the upstream decision is sent back to the user.
    const issued =
      log.commit.decision === "SUSPEND"
        ? await webchat.issueResumeApprovalToken(authorityReq.id)
        : null;
    const human = humanizeDecision(
      log.commit.decision,
      log.commit.reason,
      authorityReq.id,
      issued?.token,
    );
    await dispatcher.dispatch(
      { channel: authorityReq.channel, target: replyTarget(authorityReq), content: human },
      { command_id: `notify-${authorityReq.id}`, upstream_commit_hash: log.commit.hash },
    );
  };

  await router.start(handler);
  gatewayLog.info("inbound channels", { channels: router.list().join(", ") });
  gatewayLog.info("outbound channels", { channels: dispatcher.list().join(", ") });
  gatewayLog.info("webchat listening", {
    url: `http://${process.env.WEBCHAT_HOST ?? "127.0.0.1"}:${port}`,
  });

  return {
    shutdown: async () => {
      gatewayLog.info("shutting down");
      clearInterval(failureMemoryVerificationTimer);
      await router.stop();
      auditLog.info("summary", {
        entries: hds.getAudit().size(),
        chain_valid: hds.getAudit().verify(),
      });
    },
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function runServe(): Promise<void> {
  const handle = await serve();
  const onSignal = async (sig: string): Promise<void> => {
    gatewayLog.info("received signal", { signal: sig });
    await handle.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}
