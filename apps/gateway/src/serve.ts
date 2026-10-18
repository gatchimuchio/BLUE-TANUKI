import { createHash, randomUUID } from "node:crypto";
import {
  COMPLETE_HISTORY_SCHEMA_VERSION,
  CompleteHistoryStore,
  HDSUpperController,
  DOCUMENT_ORGANIZATION_PROMPT_PREFIX,
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
  LLMComputeAdapter,
  ToolRegistry,
  createExecutorApprovalAuthority,
  captureExecutorCommandForApproval,
  executorCommandDigest,
  createLogger,
  type ExecutionIntentReceipt,
} from "@blue-tanuki/core";
import { GatewayExecutionIntentStore } from "./execution_intent_store.js";
import { GatewayRuntimeOwnerLease } from "./runtime_owner_lease.js";
import { executionAdmissionForCommand, reconcileExecutionResults, reconcileStartupExecutionState } from "./reconcile_execution_results.js";
import { operationResultMemoryStorage } from "./operation_result_memory_config.js";
import { localInspectionReconciliationMessage, runLocalInspectionReconciliation } from "./local_inspection_runtime.js";
import { createFileSearchWorker } from "./file_search_worker.js";
import { buildFailureMemoryStore, buildHDSMemoryStore, buildSessionStore } from "./runtime.js";
import { prepareFailureReviewInbound } from "./failure_review_runtime.js";
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
  ObservationAcquisitionRecord,
} from "@blue-tanuki/protocol";
import {
  OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION,
  parseInboundRequestAtBoundary,
  parseMeaningUpdateProposal,
  parseObservationAcquisitionRecord,
} from "@blue-tanuki/protocol";
import type {
  WebChatChannel,
  WebChatApprovalQueueItem,
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatApprovalContentReview,
  WebChatApprovalContentReviewValidation,
  WebChatEmergencyStopSnapshot,
  WebChatApprovalControlContext,
  WebChatAuthorityTraceItem,
  WebChatEvidenceControlContext,
  WebChatHistoryReplayFilter,
  WebChatHistorySnapshot,
  WebChatResumeContext,
} from "@blue-tanuki/channel-webchat";
import { renderCommandOutput } from "./result_render.js";
import { finalizeCommandOutput } from "./finalize_command_output.js";
import { approvalDeniedFeedback, approvalRequiredMessage, buildApprovalRuntime } from "./approval_runtime.js";
import { loadPluginRuntime } from "./plugin_loader.js";
import { createWebChatSettingsSurface } from "./settings_surface.js";
import { buildAboutSnapshot } from "./about_surface.js";
import {
  buildRecoveryPostActionObservation,
  buildRecoverySnapshot,
  createRecoveryBackup,
  inspectLatestRecoveryBackup,
  inspectRecoveryPlanRestoreScopeApplicability,
  inspectRecoveryScopeApplicability,
  isVerifiedRecoveryPlanRestoreScope,
  recoveryStoreRestoreAttemptHistoryEvidence,
  recoveryStoreRestoreHistoryEvidence,
} from "./recovery_surface.js";
import {
  createRecoveryMutationTools,
  canonicalStoreRestoreConsumersNotQuiesced,
  normalizeRecoveryMutationArguments,
  RECOVERY_TOOL_NAMES,
  type RecoveryToolName,
} from "./recovery_tools.js";
import {
  buildUpdateSnapshot,
  prepareManualUpdate,
  verifyUpdateCandidate,
} from "./update_surface.js";
import { createGatewayEvidencePack } from "./evidence_pack.js";
import { CronSchedulerChannel, cronRestoreObservationRequiresHold, cronSchedulesFromEnv } from "./cron_channel.js";
import { GatewayCronEventStore } from "./cron_event_store.js";
import { createCronEventResolutionTool } from "./cron_event_resolution_tool.js";
import { googleDailyBriefProviderFromEnv } from "./google_daily_brief.js";
import {
  RuntimeScheduleManager,
  runtimeScheduleMutationCommand,
} from "./runtime_schedule.js";
import {
  isGmailMessageSendCommand,
  projectGmailMessageSendContentReview,
  validateGmailMessageSendContentReview,
} from "./approval_content_review.js";
import { buildRuntimeStatusSnapshot } from "./runtime_status.js";
import { buildResidentNotificationsSnapshot, readCronNotificationState } from "./resident_notifications.js";
import { probeGatewaySelfHealth } from "./runtime_health.js";
import { resolveAllSecretRefs } from "./secret_store.js";
import {
  documentOrganizationSourceFromRequest,
  presentRestoredDocumentOrganizationProjection,
  prepareDocumentOrganizationSession,
  runDocumentOrganizationTask,
} from "./document_organization_runtime.js";
import { DocumentOrganizationCheckpointStore } from "./document_organization_checkpoint_store.js";
import { OperationPlanStateStore } from "./operation_plan_store.js";
import { operationPlanRecoveryEvidenceFromObservation } from "./operation_plan_recovery_evidence.js";
import type { CanonicalStateStoreKey } from "./canonical_state_backup.js";
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
  operationCorePlannerHistoryProjection,
  operationCoreResultHistoryProjection,
  projectApprovalGrant,
  projectApprovalHistoryEntry,
  projectCompleteHistoryEntry,
  projectOperationCoreExecutionHistory,
  projectOperationPlanStatus,
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
  command_digest: string;
  log: DecisionLog;
  origin: InboundRequest;
  evaluation: ApprovalEvaluation;
  approval_token?: string;
  approval_token_expires_at_ms?: number;
  content_review_digest?: string;
  cron_event?: { event_id: string; payload_digest: string };
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

function cronApprovalEventReference(request: InboundRequest): { event_id: string; payload_digest: string } | undefined {
  if (request.channel !== "cron") return undefined;
  const event_id = request.metadata?.["blue_tanuki.cron.event_id"];
  const payload_digest = request.metadata?.["blue_tanuki.cron.payload_hash"];
  if (typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
      typeof payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(payload_digest)) {
    throw new Error("cron approval request is missing a valid durable event identity");
  }
  return { event_id, payload_digest };
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

export function buildObservationAcquisitionRecord(
  boundary: Pick<GatewayInboundBoundaryPlan, "boundary_ok" | "request">,
): ObservationAcquisitionRecord | null {
  if (!boundary.boundary_ok) return null;
  const request = boundary.request;
  const webhookSource = request.metadata?.["webhook_source"];
  const contentDigest = digestString(request.content);
  const parsed = parseObservationAcquisitionRecord({
    schema_version: "blue-tanuki.observation-acquisition.v1",
    record_type: "observation_acquisition",
    record_id: `observation:${digestString(`${request.id}:${request.timestamp}:${contentDigest}`)}`,
    request_id: request.id,
    source_channel: request.channel,
    actor_digest: digestString(request.user),
    acquired_at: request.timestamp,
    content_digest: contentDigest,
    content_chars: request.content.length,
    metadata_key_count: metadataKeys(request.metadata).length,
    reply_to_present: typeof request.metadata?.["reply_to"] === "string",
    ...(typeof webhookSource === "string"
      ? { webhook_source_digest: digestString(webhookSource) }
      : {}),
    boundary_status: "canonical",
    semantic_status: "unassessed",
    adoption_status: "not_adopted",
    used_as_world_truth: false,
    used_for_authority: false,
  });
  return parsed.ok ? parsed.record : null;
}

export function buildMeaningUpdateProposalHistoryInput(
  command: ExecuteCommand,
  request_id: string,
  actor: string,
  feedback: ExecuteFeedback,
  timestamp = Date.now(),
): CompleteHistoryAppendInput | null {
  if (
    command.type !== "llm_call" ||
    command.payload.compute_context?.local_p_version === OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION ||
    feedback.status !== "success" ||
    feedback.command_id !== command.id ||
    feedback.meaning_update_proposal === undefined
  ) return null;
  const parsed = parseMeaningUpdateProposal(feedback.meaning_update_proposal);
  if (!parsed.ok) return null;
  return {
    kind: "audit_history",
    request_id,
    command_id: command.id,
    actor,
    source: "llm_meaning_update_proposal",
    timestamp,
    payload: parsed.record,
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
  const ownerLease = GatewayRuntimeOwnerLease.fromEnvironment(process.env);
  try {
    return await serveWithOwnerLease(ownerLease);
  } catch (error) {
    ownerLease.close();
    throw error;
  }
}

async function serveWithOwnerLease(ownerLease: GatewayRuntimeOwnerLease): Promise<ServeShutdown> {
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
  let recoveryExecutionStore: GatewayExecutionIntentStore | undefined;
  let gatewayShuttingDown = false;
  let cronEventsStoreQuiesced = false;
  let jMRestoreStoreQuiesced: "j_control" | "m_state" | null = null;
  let canonicalStoreRestoreMaintenanceCommandId: string | null = null;
  for (const tool of createRecoveryMutationTools(process.env, () => recoveryExecutionStore, {
    canonicalStoreRestoreQuiesced: (storeKey: CanonicalStateStoreKey) =>
      storeKey === "cron_events" ? cronEventsStoreQuiesced : storeKey === jMRestoreStoreQuiesced,
  })) tools.register(tool);
  plugins.registerTools(tools);
  const llm = buildLLMBackendFromEnv();

  const runtimeSelfHealth = await probeGatewaySelfHealth(process.env);
  const operationPlanState = OperationPlanStateStore.fromEnvironment();
  const completeHistoryFile = nonEmptyEnv(process.env.BLUE_TANUKI_COMPLETE_HISTORY_FILE);
  const completeHistoryMaxEntries = parsePositiveInt(process.env.BLUE_TANUKI_COMPLETE_HISTORY_MAX_ENTRIES);
  const completeHistory = new CompleteHistoryStore({
    filepath: completeHistoryFile,
    max_entries: completeHistoryMaxEntries,
  });
  const recoveryObservationStartedAtMs = Date.now();
  let recoveryObservationHistoryIncomplete = false;
  const operationPlanCheckpointAtStartup = operationPlanState.load();
  const startupHistorySize = completeHistory.size();
  const startupHistorySkippedCount = completeHistory.skippedCount();
  const startupHistoryChainValid = completeHistory.verify();
  const startupHistoryAtCapacity = completeHistoryMaxEntries !== undefined &&
    startupHistorySize >= completeHistoryMaxEntries;
  const startupHistoryEntries = completeHistory.replay().filter(
    (entry): entry is CompleteHistoryEntry & { kind: "execution_history" | "final_output" } =>
      entry.kind === "execution_history" || entry.kind === "final_output",
  );
  const startupRecoveryHistory = {
    entries: startupHistoryEntries,
    chain_valid: startupHistoryChainValid,
    skipped_count: startupHistorySkippedCount +
      (!completeHistoryFile || startupHistoryAtCapacity ? 1 : 0),
    not_before_timestamp_ms: recoveryObservationStartedAtMs,
  };
  let startupRecoveryObservation = await buildRecoveryPostActionObservation(startupRecoveryHistory, process.env, {
    mode: "startup_canonical_store_hold",
  });
  let startupOperationPlanHoldObservation = await buildRecoveryPostActionObservation(startupRecoveryHistory, process.env, {
    mode: "startup_operation_plan_hold",
  });
  const startupHistoryStable = startupHistorySize === completeHistory.size() &&
    startupHistorySkippedCount === completeHistory.skippedCount() && startupHistoryChainValid === completeHistory.verify();
  if (!startupHistoryStable) {
    const unstableHistory = {
      entries: startupHistoryEntries,
      chain_valid: false,
      skipped_count: Math.max(1, startupHistorySkippedCount),
      not_before_timestamp_ms: recoveryObservationStartedAtMs,
    } as const;
    startupRecoveryObservation = await buildRecoveryPostActionObservation(unstableHistory, process.env, {
      mode: "startup_canonical_store_hold",
    });
    startupOperationPlanHoldObservation = await buildRecoveryPostActionObservation(unstableHistory, process.env, {
      mode: "startup_operation_plan_hold",
    });
  }
  const canonicalStoreRestoreNeedsOperationPlanHold = startupRecoveryObservation.operation === "restore" &&
    (startupRecoveryObservation.store_key === null ||
      ((startupRecoveryObservation.store_key === "j_control" || startupRecoveryObservation.store_key === "m_state" ||
        startupRecoveryObservation.store_key === "cron_events") &&
        (startupRecoveryObservation.status !== "matched" ||
          startupRecoveryObservation.store_ledger_status !== "verified" ||
          startupRecoveryObservation.store_ledger_residual_count !== 0)));
  const startupOperationPlanRecoveryEvidence = operationPlanRecoveryEvidenceFromObservation({
    observation: canonicalStoreRestoreNeedsOperationPlanHold
      ? startupRecoveryObservation
      : startupOperationPlanHoldObservation,
    checkpoint: operationPlanCheckpointAtStartup,
    history_complete: !!completeHistoryFile && startupHistoryStable && startupHistoryChainValid && startupHistorySkippedCount === 0 &&
      !startupHistoryAtCapacity && !(operationPlanCheckpointAtStartup?.plans.length && startupHistorySize === 0),
  });
  const hds = new HDSUpperController({
    operation_plan_state: operationPlanState,
    operation_plan_memory: operationResultMemoryStorage(),
    operation_plan_recovery_evidence: startupOperationPlanRecoveryEvidence,
    audit: buildAuditLog(),
    memory: buildHDSMemoryStore(process.env),
    llm_route: buildLLMCommandRouteFromEnv(),
    self_health: runtimeSelfHealth,
  });
  const failureMemory = buildFailureMemoryStore(process.env);
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
  const executionControllers = new Set<AbortController>();
  const executionTasks = new Set<Promise<ExecuteFeedback>>();
  const emergencyStop: EmergencyStopState = {
    active: false,
    activated_at: null,
    activated_by: null,
    reason: null,
    cleared_at: null,
    cleared_by: null,
    clear_reason: null,
  };
  const router = new InboundRouter({ propagateHandlerErrorsForChannels: ["cron"] });
  const dispatcher = new OutboundDispatcher();

  const port = parseInt(process.env.WEBCHAT_PORT ?? "8787", 10);
  const webchatPermissions = [
    "network:listen",
    "secrets:WEBCHAT_TOKEN",
    "secrets:WEBCHAT_RESUME_TOKEN",
    "secrets:BLUE_TANUKI_MAINTENANCE_TOKEN",
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
  const maintenanceToken = process.env.BLUE_TANUKI_MAINTENANCE_TOKEN;
  if (!maintenanceToken) {
    throw new Error("BLUE_TANUKI_MAINTENANCE_TOKEN is required for update/recovery maintenance surfaces");
  }
  if (maintenanceToken === token || maintenanceToken === resumeToken) {
    throw new Error("BLUE_TANUKI_MAINTENANCE_TOKEN must differ from WebChat tokens");
  }
  const cronTasks = cronSchedulesFromEnv(process.env);
  const cronEventStore = GatewayCronEventStore.fromEnvironment(process.env, {
    verifyNoReplayDisposition: (event_id, payload_digest) =>
      hds.isCronEventNoReplayAcknowledged(event_id, payload_digest),
  });
  cronEventStore.recoverPendingApprovalHandoffs();
  const cron = new CronSchedulerChannel({
    tasks: [...cronTasks, ...runtimeSchedules.activeCronTasks()],
    log: (line: string) => cronLog.info(line),
    content_provider: googleDailyBriefProviderFromEnv(process.env),
    event_store: cronEventStore,
    onFire: (task, event) => {
      hds.onScheduleLifecycle("schedule.lifecycle.fired", {
        schedule_id: task.id,
        origin: task.origin,
        operation: "fire",
        actor: "blue-tanuki-cron",
        payload_hash: task.payload_hash,
        request_id: event.event_id,
      });
    },
  });
  if (cronRestoreObservationRequiresHold(startupRecoveryObservation)) {
    cron.holdForUnverifiedRestoreObservation();
    gatewayLog.warn("Cron scheduler held after canonical restore observation", {
      store_key: "cron_events",
      observation_status: startupRecoveryObservation.status,
      ledger_status: startupRecoveryObservation.store_ledger_status,
      residual_count: startupRecoveryObservation.store_ledger_residual_count,
    });
  }
  runtimeSchedules.attachScheduler(cron);
  tools.register(createCronEventResolutionTool(cronEventStore, cron));

  // Forward declarations: resume/approval closures resolve at call time.
  // eslint-disable-next-line prefer-const
  let executor: Executor;
  const executionStore = GatewayExecutionIntentStore.fromEnvironment(process.env);
  recoveryExecutionStore = executionStore;
  const executorApproval = createExecutorApprovalAuthority({
    execution_store: executionStore,
    execution_epoch: ownerLease.executionEpoch,
    assert_execution_owner: () => ownerLease.assertActive(),
  });
  const startupRecovery = reconcileStartupExecutionState(hds, executionStore, ownerLease.executionEpoch);
  gatewayLog.info("startup saved-result reconciliation", {
    adopted: startupRecovery.adopted,
    deferred: startupRecovery.deferred,
    stale_generation_archived: startupRecovery.stale_generation_archived,
    memory_ready: startupRecovery.memory_ready,
    result_store_readable: startupRecovery.result_store_readable,
  });
  if (!startupRecovery.ready) {
    gatewayLog.error("Gateway startup blocked before inbound channels: saved result or memory reconciliation is unavailable or pending", {
      deferred: startupRecovery.deferred,
      memory_ready: startupRecovery.memory_ready,
      result_store_readable: startupRecovery.result_store_readable,
    });
    cronEventStore.close();
    operationPlanState.close();
    hds.closeOperationPlanMemory();
    executionStore.close();
    throw new Error("gateway_startup_reconciliation_unresolved");
  }
  let webchat: WebChatChannel;

  function isRecoveryMutationCommand(cmd: ExecuteCommand): boolean {
    return cmd.type === "tool_call" && RECOVERY_TOOL_NAMES.includes(cmd.payload.tool_name as RecoveryToolName);
  }

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
    // worker停止は監査・history保存の成功に依存させない。
    for (const controller of executionControllers) controller.abort();
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
    receipt: ExecutionIntentReceipt | null,
  ): CompleteHistoryEntry | null {
    const recoveryStoreRestore = feedback.status === "success" && isRecoveryMutationCommand(cmd)
      ? recoveryStoreRestoreHistoryEvidence(feedback.result)
      : undefined;
    const recoveryStoreRestoreAttempt = cmd.type === "tool_call" && cmd.payload.tool_name === "recovery.restore"
      ? recoveryStoreRestoreAttemptHistoryEvidence(cmd)
      : undefined;
    const entry = recordCompleteHistory({
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
        ...(recoveryStoreRestore ? { recovery_store_restore: recoveryStoreRestore } : {}),
        ...(recoveryStoreRestoreAttempt ? { recovery_store_restore_attempt: recoveryStoreRestoreAttempt } : {}),
        error: feedback.error,
        metrics: feedback.metrics,
        operation_core: feedback.operation_core,
        operation_core_result: operationCoreResultHistoryProjection(cmd, feedback),
        operation_core_planner: operationCorePlannerHistoryProjection(feedback),
        execution_receipt: receipt ? {
          ticket_digest: digestString(receipt.ticket_id), command_digest: receipt.command_digest,
          execution_epoch_digest: digestString(receipt.execution_epoch), state: receipt.state,
          invocation_boundary: receipt.invocation_boundary, feedback_status: receipt.feedback_status,
          output_digest: receipt.output_digest, error_digest: receipt.error_digest, used_for_authority: false,
        } : undefined,
      },
    });
    if (isRecoveryMutationCommand(cmd) && !entry) recoveryObservationHistoryIncomplete = true;
    return entry;
  }

  function recordFinalOutputHistory(
    log: DecisionLog,
    origin: InboundRequest,
    actor: string,
    output: OutputAuditLog,
    command?: ExecuteCommand,
  ): boolean {
    const entry = recordCompleteHistory({
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
    if (command && isRecoveryMutationCommand(command) && !entry) recoveryObservationHistoryIncomplete = true;
    return entry !== null;
  }

  /**
   * Run a command through the executor, then mirror user-visible command
   * output back to the originating channel as a channel_send.
   */
  async function executeAndEcho(
    cmd: ExecuteCommand,
    log: DecisionLog,
    origin: InboundRequest,
    opts: { skip_approval?: boolean; actor?: string; approval_evaluation?: ApprovalEvaluation; command_digest?: string } = {},
  ): Promise<{ status: string }> {
    const actor = opts.actor ?? origin.user;
    if (canonicalStoreRestoreMaintenanceCommandId && canonicalStoreRestoreMaintenanceCommandId !== cmd.id) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", {
        actor,
        reason: "canonical_state_restore_in_progress",
      });
      return { status: "canonical_state_restore_in_progress" };
    }
    const restoreStoreKey = cmd.type === "tool_call" && cmd.payload.tool_name === "recovery.restore"
      ? cmd.payload.arguments.store_key
      : undefined;
    const restoreConsumersNotQuiesced = canonicalStoreRestoreConsumersNotQuiesced(restoreStoreKey);
    const operationPlanRestore = cmd.type === "tool_call" && cmd.payload.tool_name === "recovery.restore" &&
      cmd.payload.arguments.store_key === "operation_plans" && cmd.payload.arguments.confirm === "RESTORE";
    const cronEventsRestore = cmd.type === "tool_call" && cmd.payload.tool_name === "recovery.restore" &&
      cmd.payload.arguments.store_key === "cron_events" && cmd.payload.arguments.confirm === "RESTORE";
    const jMRestoreStoreKey = cmd.type === "tool_call" && cmd.payload.tool_name === "recovery.restore" &&
      (cmd.payload.arguments.store_key === "j_control" || cmd.payload.arguments.store_key === "m_state") &&
      cmd.payload.arguments.confirm === "RESTORE" ? cmd.payload.arguments.store_key : null;
    let executionEvaluation = opts.approval_evaluation ?? null;
    if (!hds.operationPlanCommandIsCurrent(cmd)) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "plan_binding_stale" });
      return { status: "plan_binding_stale" };
    }
    const reviewed = captureExecutorCommandForApproval(cmd);
    const reviewedDigest = opts.command_digest ?? reviewed.command_digest;
    if (reviewed.command_digest !== reviewedDigest) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "approval_content_changed" });
      return { status: "approval_content_changed" };
    }
    if (restoreConsumersNotQuiesced.length > 0) {
      const reason = "canonical_state_restore_consumers_not_quiesced";
      const feedback: ExecuteFeedback = {
        command_id: cmd.id,
        status: "failed",
        error: reason,
        metrics: { duration_ms: 0 },
      };
      const finalized = finalizeCommandOutput({
        hds,
        command: cmd,
        feedback,
        target_surface: "channel",
        request_id: log.request_id,
      });
      recordApprovalHistory("recovery_restore_blocked", cmd, log, origin, actor, null, {
        blocking_consumers: restoreConsumersNotQuiesced,
        l3_request_created: false,
        used_for_authority: false,
        may_execute: false,
      });
      recordFinalOutputHistory(log, origin, actor, finalized.output_audit, cmd);
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason });
      if (finalized.rendered_output) {
        await dispatcher.dispatch(
          { channel: origin.channel, target: replyTarget(origin), content: finalized.rendered_output },
          { command_id: cmd.id, upstream_commit_hash: log.commit.hash },
        );
      }
      return { status: reason };
    }
    // HDS発行objectのplan対応を維持し、承認/tokenのawait前に内容を固定する。
    // 権限記録自体はprivateに保持する。
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
      const evaluation = opts.approval_evaluation ?? approval.evaluate(cmd, actor);
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
        let cronEvent: PendingApproval["cron_event"];
        try {
          cronEvent = cronApprovalEventReference(origin);
          if (cronEvent) {
            cronEventStore.recordPendingApproval(cronEvent.event_id, cronEvent.payload_digest, cmd.id, log.request_id);
          }
        } catch (error) {
          hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "cron_approval_handoff_unavailable" });
          recordApprovalHistory("approval_cancelled", cmd, log, origin, actor, evaluation, {
            reason: "cron_approval_handoff_unavailable",
          });
          throw error;
        }
        const issued = await webchat.issueResumeApprovalToken(cmd.id);
        if (!hds.operationPlanCommandIsCurrent(cmd)) {
          if (cronEvent) {
            cronEventStore.resolvePendingApproval(
              cronEvent.event_id,
              cronEvent.payload_digest,
              cmd.id,
              log.request_id,
              "cancelled",
            );
          }
          hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "plan_changed_while_issuing_token" });
          return { status: "plan_binding_stale" };
        }
        recordApprovalHistory("approval_pending", cmd, log, origin, actor, evaluation, {
          failure_memory_required: failureMemoryRequiresApproval,
          failure_memory_reason: failureMemoryRequiresApproval ? failureGate.reason : undefined,
          approval_token_issued: Boolean(issued?.token),
          approval_token_expires_at_ms: issued?.expires_at_ms,
        });
        pendingApprovals.set(cmd.id, {
          command: cmd,
          command_digest: reviewedDigest,
          log,
          origin,
          evaluation,
          approval_token: issued?.token,
          approval_token_expires_at_ms: issued?.expires_at_ms,
          ...(cronEvent ? { cron_event: cronEvent } : {}),
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
    if (canonicalStoreRestoreMaintenanceCommandId && canonicalStoreRestoreMaintenanceCommandId !== cmd.id) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", {
        actor,
        reason: "canonical_state_restore_in_progress",
      });
      return { status: "canonical_state_restore_in_progress" };
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
    }, reviewedDigest);
    const planBound = hds.isOperationPlanCommand(cmd.id);
    const admission = planBound ? executionAdmissionForCommand(cmd, executorApproval.receipt(approvedCommand)) : undefined;
    if (!hds.beginOperationPlanAttempt(cmd, admission)) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "plan_attempt_not_admitted" });
      return { status: "plan_binding_stale" };
    }
    if (operationPlanRestore && !hds.beginOperationPlanRecoveryRefresh(cmd)) {
      hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "operation_plan_recovery_refresh_busy" });
      gatewayLog.warn("operation-plan restore was not started", { command_id: cmd.id, reason: "plan_refresh_busy" });
      return { status: "operation_plan_recovery_refresh_busy" };
    }
    let cronEventsRestoreQuiesced = false;
    const reopenCronEventStoreAfterRestore = () => {
      if (cronEventsRestoreQuiesced && cronEventStore.isClosed()) {
        cronEventStore.reopenAfterRecoveryRestore();
        cronEventsStoreQuiesced = false;
      }
    };
    const finishCronEventRestore = async (observationVerified: boolean) => {
      if (!cronEventsRestoreQuiesced) return;
      if (!gatewayShuttingDown) {
        await cron.resumeAfterRecoveryRestore({ restore_attempted: true, observation_verified: observationVerified });
      }
      cronEventsRestoreQuiesced = false;
      canonicalStoreRestoreMaintenanceCommandId = null;
    };
    if (cronEventsRestore) {
      if (!await cron.quiesceForRecoveryRestore()) {
        hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "cron_recovery_restore_busy" });
        return { status: "cron_recovery_restore_busy" };
      }
      if (Array.from(pendingApprovals.values()).some((pending) => pending.cron_event !== undefined)) {
        await cron.resumeAfterRecoveryRestore({ restore_attempted: false, observation_verified: false });
        hds.onCommandLifecycle(cmd.id, "approval_cancelled", {
          actor,
          reason: "cron_approval_handoff_pending",
        });
        return { status: "cron_approval_handoff_pending" };
      }
      canonicalStoreRestoreMaintenanceCommandId = cmd.id;
      while (executionTasks.size > 0) await Promise.allSettled(Array.from(executionTasks));
      try {
        cronEventStore.close();
        cronEventsStoreQuiesced = true;
        cronEventsRestoreQuiesced = true;
      } catch {
        canonicalStoreRestoreMaintenanceCommandId = null;
        if (cronEventStore.isClosed()) {
          try {
            cronEventStore.reopenAfterRecoveryRestore();
            cronEventsStoreQuiesced = false;
          } catch {
            canonicalStoreRestoreMaintenanceCommandId = cmd.id;
            throw new Error("cron_event_store_quiescence_failed");
          }
        }
        await cron.resumeAfterRecoveryRestore({ restore_attempted: false, observation_verified: false });
        hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "cron_event_store_quiescence_failed" });
        return { status: "cron_event_store_quiescence_failed" };
      }
    }
    let jMRestoreQuiesced = false;
    if (jMRestoreStoreKey) {
      canonicalStoreRestoreMaintenanceCommandId = cmd.id;
      while (executionTasks.size > 0) await Promise.allSettled(Array.from(executionTasks));
      if (!hds.quiesceOperationPlanMemoryForCanonicalRestore()) {
        canonicalStoreRestoreMaintenanceCommandId = null;
        hds.onCommandLifecycle(cmd.id, "approval_cancelled", { actor, reason: "j_m_store_not_quiescent" });
        return { status: "j_m_store_not_quiescent" };
      }
      jMRestoreQuiesced = true;
      jMRestoreStoreQuiesced = jMRestoreStoreKey;
      // Persist a conservative hold before invoking whole-store restore. If it
      // cannot be recorded, keep both the database and gateway maintenance lock closed.
      if (!hds.holdOperationPlansForCanonicalMemoryRestore(cmd)) {
        throw new Error("j_m_operation_plan_hold_unavailable");
      }
    }
    const executionController = new AbortController();
    if (emergencyStop.active) executionController.abort();
    executionControllers.add(executionController);
    let fb: ExecuteFeedback;
    let executionTask: Promise<ExecuteFeedback>;
    try {
      executionTask = executor.execute(approvedCommand, { save_result_delivery: planBound,
        signal: executionController.signal, before_tool_dispatch: () => {
          if (emergencyStop.active) throw new Error("file_search_worker_emergency_stop_active");
        } });
    } catch (error) {
      try {
        reopenCronEventStoreAfterRestore();
        await finishCronEventRestore(false);
      } catch {
        throw new Error("cron_event_store_reopen_failed");
      }
      throw error;
    }
    executionTasks.add(executionTask);
    try {
      fb = await executionTask;
    } catch (error) {
      try {
        reopenCronEventStoreAfterRestore();
        await finishCronEventRestore(false);
      } catch {
        throw new Error("cron_event_store_reopen_failed");
      }
      throw error;
    } finally { executionControllers.delete(executionController); executionTasks.delete(executionTask); }
    reopenCronEventStoreAfterRestore();
    if (fb.status === "success" && cmd.type === "tool_call" &&
        cmd.payload.tool_name === "schedule.resolve_event") {
      if (!executionEvaluation) throw new Error("cron event disposition requires its HDS approval evaluation");
      hds.acknowledgeCronEventNoReplay(cmd, executionEvaluation, actor, log.request_id);
    }
    if (planBound) gatewayLog.info("saved execution result reconciliation",
      reconcileExecutionResults(hds, executionStore, ownerLease.executionEpoch));
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
    const executionHistory = recordExecutionHistory(cmd, log, origin, actor, fb, executorApproval.receipt(approvedCommand));
    const meaningUpdateProposalHistory = buildMeaningUpdateProposalHistoryInput(
      cmd,
      log.request_id,
      actor,
      fb,
    );
    if (meaningUpdateProposalHistory) recordCompleteHistory(meaningUpdateProposalHistory);
    if (fb.status === "failed") {
      const extracted = executionHistory
        ? extractFailureSignatures({ kind: "complete_history", entry: executionHistory })
        : extractFailureSignatures({
            kind: "command_result",
            command: cmd,
            feedback: fb,
            context: { actor, channel: origin.channel },
          });
      for (const signature of extracted) failureMemory.upsertSignature(signature);
      runFailureMemoryVerification("post_failure");
    }
    coreLog.info("command", { command: cmd.id.slice(0, 8), status: fb.status, duration_ms: fb.metrics.duration_ms });
    const finalized = finalizeCommandOutput({
      hds,
      command: cmd,
      feedback: fb,
      target_surface: "channel",
      request_id: log.request_id,
    });
    const content = finalized.rendered_output;
    const output = finalized.output_audit;
    const finalOutputRecorded = recordFinalOutputHistory(log, origin, actor, output, cmd);
    if (jMRestoreQuiesced && jMRestoreStoreKey) {
      const restoreResultEvidence = fb.status === "success"
        ? recoveryStoreRestoreHistoryEvidence(fb.result)
        : null;
      let observationVerified = false;
      if (executionHistory && finalOutputRecorded && restoreResultEvidence?.store_key === jMRestoreStoreKey) {
        const historySize = completeHistory.size();
        const historySkippedCount = completeHistory.skippedCount();
        const historyChainValid = completeHistory.verify();
        const historyIncompleteAtStart = recoveryObservationHistoryIncomplete;
        const historyAtCapacity = completeHistoryMaxEntries !== undefined && historySize >= completeHistoryMaxEntries;
        const historyEntries = completeHistory.replay().filter(
          (entry): entry is CompleteHistoryEntry & { kind: "execution_history" | "final_output" } =>
            entry.kind === "execution_history" || entry.kind === "final_output",
        );
        const historyEvidence = {
          entries: historyEntries,
          chain_valid: historyChainValid,
          skipped_count: historySkippedCount +
            (historyAtCapacity || historyIncompleteAtStart ? 1 : 0),
          not_before_timestamp_ms: recoveryObservationStartedAtMs,
        };
        const historyComplete = !!completeHistoryFile && historyChainValid && historySkippedCount === 0 &&
          !historyAtCapacity && !historyIncompleteAtStart;
        if (historyComplete) {
          try {
            const observation = await buildRecoveryPostActionObservation(historyEvidence, process.env, {
              mode: "in_process_restore",
              expected_command_id: cmd.id,
            });
            const historyStable = historySize === completeHistory.size() &&
              historySkippedCount === completeHistory.skippedCount() && historyChainValid === completeHistory.verify() &&
              historyIncompleteAtStart === recoveryObservationHistoryIncomplete;
            observationVerified = historyStable && observation.status === "matched" &&
              observation.operation === "restore" && observation.store_key === jMRestoreStoreKey &&
              observation.command_id_digest === createHash("sha256").update(cmd.id).digest("hex") &&
              observation.store_ledger_status === "verified" && observation.store_ledger_residual_count === 0 &&
              observation.restore_backup_id_digest === restoreResultEvidence.restored_backup_id_digest &&
              observation.restored_state_digest === restoreResultEvidence.restored_store_state_digest;
            if (observationVerified && !gatewayShuttingDown) {
              observationVerified = hds.reopenOperationPlanMemoryAfterCanonicalRestore();
              if (observationVerified) {
                jMRestoreStoreQuiesced = null;
                jMRestoreQuiesced = false;
                canonicalStoreRestoreMaintenanceCommandId = null;
              }
            }
            if (!observationVerified) {
              gatewayLog.warn("J/M restore remains held after post-action observation", {
                command_id: cmd.id,
                history_stable: historyStable,
                observation_status: observation.status,
                observation_store_key: observation.store_key,
                store_ledger_status: observation.store_ledger_status,
                store_ledger_residual_count: observation.store_ledger_residual_count,
                restore_backup_id_digest_matches:
                  observation.restore_backup_id_digest === restoreResultEvidence.restored_backup_id_digest,
                restored_state_digest_matches:
                  observation.restored_state_digest === restoreResultEvidence.restored_store_state_digest,
                hds_store_reopened: false,
              });
            }
          } catch {
            gatewayLog.warn("J/M restore remains held after post-action observation", {
              command_id: cmd.id,
              reason: "restore_observation_or_reopen_failed",
            });
          }
        } else {
          gatewayLog.warn("J/M restore remains held after post-action observation", {
            command_id: cmd.id,
            reason: "restore_history_incomplete",
          });
        }
      } else {
        gatewayLog.warn("J/M restore remains held after post-action observation", {
          command_id: cmd.id,
          reason: "restore_result_unverified",
        });
      }
    }
    if (operationPlanRestore && fb.status === "success") {
      const restoreResultEvidence = recoveryStoreRestoreHistoryEvidence(fb.result);
      if (!executionHistory || !finalOutputRecorded || restoreResultEvidence?.store_key !== "operation_plans") {
        gatewayLog.warn("operation-plan restore refresh remains held", {
          command_id: cmd.id,
          reason: !executionHistory || !finalOutputRecorded ? "restore_history_incomplete" : "restore_result_unverified",
        });
      } else {
        const historySize = completeHistory.size();
        const historySkippedCount = completeHistory.skippedCount();
        const historyChainValid = completeHistory.verify();
        const historyIncompleteAtStart = recoveryObservationHistoryIncomplete;
        const historyAtCapacity = completeHistoryMaxEntries !== undefined && historySize >= completeHistoryMaxEntries;
        const historyEntries = completeHistory.replay().filter(
          (entry): entry is CompleteHistoryEntry & { kind: "execution_history" | "final_output" } =>
            entry.kind === "execution_history" || entry.kind === "final_output",
        );
        const historyEvidence = {
          entries: historyEntries,
          chain_valid: historyChainValid,
          skipped_count: historySkippedCount +
            (historyAtCapacity || historyIncompleteAtStart ? 1 : 0),
          not_before_timestamp_ms: recoveryObservationStartedAtMs,
        };
        const historyComplete = !!completeHistoryFile && historyChainValid && historySkippedCount === 0 &&
          !historyAtCapacity && !historyIncompleteAtStart;
        if (!historyComplete) {
          gatewayLog.warn("operation-plan restore refresh remains held", {
            command_id: cmd.id,
            reason: "restore_history_incomplete",
          });
        } else {
          try {
            const observation = await buildRecoveryPostActionObservation(historyEvidence, process.env, {
              mode: "in_process_restore",
              expected_command_id: cmd.id,
            });
            const historyStable = historySize === completeHistory.size() &&
              historySkippedCount === completeHistory.skippedCount() && historyChainValid === completeHistory.verify() &&
              historyIncompleteAtStart === recoveryObservationHistoryIncomplete;
            if (!historyStable) {
              gatewayLog.warn("operation-plan restore refresh remains held", {
                command_id: cmd.id,
                reason: "restore_history_changed_during_inspection",
              });
            } else if (observation.status !== "matched" || observation.operation !== "restore" ||
                observation.store_key !== "operation_plans" ||
                observation.restore_backup_id_digest !== restoreResultEvidence.restored_backup_id_digest ||
                observation.restore_scope_plan_digest !== restoreResultEvidence.restore_scope_plan_digest ||
                observation.plan_residuals === null || observation.plan_restore_points === null) {
              gatewayLog.warn("operation-plan restore refresh remains held", {
                command_id: cmd.id,
                reason: "restore_plan_dependency_evidence_unverified",
              });
            } else {
              const checkpoint = operationPlanState.load();
              const recoveryEvidence = operationPlanRecoveryEvidenceFromObservation({
                observation,
                checkpoint,
                history_complete: true,
              });
              if ((checkpoint?.plans.length ?? 0) > 0 && !recoveryEvidence) {
                gatewayLog.warn("operation-plan restore refresh remains held", {
                  command_id: cmd.id,
                  reason: "restore_plan_dependency_evidence_missing",
                });
              } else {
                hds.refreshOperationPlansAfterRecoveryRestore(cmd, recoveryEvidence);
              }
            }
          } catch {
            gatewayLog.warn("operation-plan restore refresh remains held", {
              command_id: cmd.id,
              reason: "restore_plan_dependency_inspection_failed",
            });
          }
        }
      }
    }
    if (cronEventsRestoreQuiesced) {
      let observationVerified = false;
      const restoreResultEvidence = fb.status === "success"
        ? recoveryStoreRestoreHistoryEvidence(fb.result)
        : null;
      if (executionHistory && finalOutputRecorded && restoreResultEvidence?.store_key === "cron_events") {
        const historySize = completeHistory.size();
        const historySkippedCount = completeHistory.skippedCount();
        const historyChainValid = completeHistory.verify();
        const historyIncompleteAtStart = recoveryObservationHistoryIncomplete;
        const historyAtCapacity = completeHistoryMaxEntries !== undefined && historySize >= completeHistoryMaxEntries;
        const historyEntries = completeHistory.replay().filter(
          (entry): entry is CompleteHistoryEntry & { kind: "execution_history" | "final_output" } =>
            entry.kind === "execution_history" || entry.kind === "final_output",
        );
        const historyEvidence = {
          entries: historyEntries,
          chain_valid: historyChainValid,
          skipped_count: historySkippedCount +
            (historyAtCapacity || historyIncompleteAtStart ? 1 : 0),
          not_before_timestamp_ms: recoveryObservationStartedAtMs,
        };
        const historyComplete = !!completeHistoryFile && historyChainValid && historySkippedCount === 0 &&
          !historyAtCapacity && !historyIncompleteAtStart;
        if (historyComplete) {
          try {
            const observation = await buildRecoveryPostActionObservation(historyEvidence, process.env, {
              mode: "in_process_restore",
              expected_command_id: cmd.id,
            });
            const historyStable = historySize === completeHistory.size() &&
              historySkippedCount === completeHistory.skippedCount() && historyChainValid === completeHistory.verify() &&
              historyIncompleteAtStart === recoveryObservationHistoryIncomplete;
            observationVerified = historyStable && observation.status === "matched" &&
              observation.operation === "restore" && observation.store_key === "cron_events" &&
              observation.restore_backup_id_digest === restoreResultEvidence.restored_backup_id_digest &&
              !cronRestoreObservationRequiresHold(observation);
            if (!observationVerified) {
              gatewayLog.warn("Cron restore remains held after post-action observation", {
                command_id: cmd.id,
                history_stable: historyStable,
                observation_status: observation.status,
                observation_operation: observation.operation,
                observation_store_key: observation.store_key,
                store_ledger_status: observation.store_ledger_status,
                store_ledger_residual_count: observation.store_ledger_residual_count,
                restore_backup_id_digest_matches:
                  observation.restore_backup_id_digest === restoreResultEvidence.restored_backup_id_digest,
              });
            }
          } catch {
            gatewayLog.warn("Cron restore remains held after post-action observation", {
              command_id: cmd.id,
              reason: "restore_observation_failed",
            });
          }
        } else {
          gatewayLog.warn("Cron restore remains held after post-action observation", {
            command_id: cmd.id,
            reason: "restore_history_incomplete",
          });
        }
      } else {
        gatewayLog.warn("Cron restore remains held after post-action observation", {
          command_id: cmd.id,
          reason: "restore_result_unverified",
        });
      }
      await finishCronEventRestore(observationVerified);
    }
    if (content) await dispatcher.dispatch({ channel: origin.channel, target: replyTarget(origin), content }, { command_id: cmd.id, upstream_commit_hash: log.commit.hash });
    return { status: finalized.reviewed_feedback.status };
  }

  async function resumePendingApproval(command_id: string, verdict: "approve" | "reject" | "block", ctx: WebChatResumeContext): Promise<unknown> {
    if (canonicalStoreRestoreMaintenanceCommandId) {
      return { executed: false, status: "canonical_state_restore_in_progress" };
    }
    const pending = pendingApprovals.get(command_id);
    if (!pending) {
      if (cronEventStore.hasCronApprovalReference(command_id)) {
        return { executed: false, status: "approval_unavailable_after_restart", fresh_request_required: true };
      }
      return hds.isOperationPlanCommand(command_id) ? { executed: false, status: "plan_binding_stale" } : null;
    }
    const approvalActor = pending.command.type === "tool_call" &&
      RECOVERY_TOOL_NAMES.includes(pending.command.payload.tool_name as RecoveryToolName)
      ? "webchat-resume-token-holder"
      : ctx.actor;
    if (executorCommandDigest(pending.command) !== pending.command_digest) {
      resolveCronApprovalHandoff(pending, "cancelled");
      pendingApprovals.delete(command_id);
      hds.onCommandLifecycle(command_id, "approval_cancelled", { actor: approvalActor, reason: "approval_content_changed" });
      return { executed: false, status: "approval_content_changed" };
    }
    if (!hds.operationPlanCommandIsCurrent(pending.command)) {
      resolveCronApprovalHandoff(pending, "cancelled");
      pendingApprovals.delete(command_id);
      hds.onCommandLifecycle(command_id, "approval_cancelled", { actor: approvalActor, reason: "plan_binding_stale" });
      return { executed: false, status: "plan_binding_stale" };
    }
    if (verdict === "approve" && isGmailMessageSendCommand(pending.command) &&
        validateGmailMessageSendContentReview(
          pending.command,
          pending.command_digest,
          true,
          pending.content_review_digest,
          ctx.content_review_digest,
        ) !== "valid") {
      return {
        executed: false,
        pending: true,
        status: "approval_content_review_required",
      };
    }
    if (verdict === "approve" && emergencyStop.active) {
      const issued = await webchat.issueResumeApprovalToken(command_id);
      if (!hds.operationPlanCommandIsCurrent(pending.command)) {
        resolveCronApprovalHandoff(pending, "cancelled");
        pendingApprovals.delete(command_id);
        hds.onCommandLifecycle(command_id, "approval_cancelled", { actor: approvalActor, reason: "plan_binding_stale" });
        return { executed: false, status: "plan_binding_stale" };
      }
      pendingApprovals.set(command_id, {
        ...pending,
        approval_token: issued?.token,
        approval_token_expires_at_ms: issued?.expires_at_ms,
      });
      hds.onAuthorityEvent("emergency_stop_blocked", {
        request_id: pending.log.request_id,
        command_id,
        actor: approvalActor,
        reason: emergencyStop.reason ?? "owner emergency stop active",
      });
      recordApprovalHistory("emergency_stop_blocked_approval", pending.command, pending.log, pending.origin, approvalActor, pending.evaluation, {
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
    if (verdict !== "approve") {
      resolveCronApprovalHandoff(pending, "rejected");
      pendingApprovals.delete(command_id);
      runtimeSchedules.rejectPending(command_id, approvalActor, `human_approval:${verdict}`);
      hds.onCommandLifecycle(command_id, "approval_rejected", { actor: approvalActor, reason: `human_approval:${verdict}` });
      recordApprovalHistory("human_resume_rejected", pending.command, pending.log, pending.origin, approvalActor, pending.evaluation, {
        verdict,
        token_kind: ctx.token_kind,
      });
      await dispatcher.dispatch({ channel: pending.origin.channel, target: replyTarget(pending.origin), content: `[approval-${verdict}] command_id=${command_id}` }, { command_id: `approval-${verdict}-${command_id}`, upstream_commit_hash: pending.log.commit.hash });
      return { approval: verdict, executed: false };
    }
    if (runtimeScheduleMutationCommand(pending.command) && !runtimeSchedules.hasPending(command_id)) {
      resolveCronApprovalHandoff(pending, "cancelled");
      pendingApprovals.delete(command_id);
      const content = "[schedule-expired] approval expired before activation. activated=false can_fire=false next_action=Submit the schedule request again and approve the new command_id.";
      hds.onCommandLifecycle(command_id, "approval_rejected", { actor: approvalActor, reason: "schedule_approval_expired" });
      recordApprovalHistory("schedule_approval_expired", pending.command, pending.log, pending.origin, approvalActor, pending.evaluation, {
        verdict,
        token_kind: ctx.token_kind,
      });
      await dispatcher.dispatch({ channel: pending.origin.channel, target: replyTarget(pending.origin), content }, { command_id: `schedule-expired-${command_id}`, upstream_commit_hash: pending.log.commit.hash });
      return { approval: "approve", executed: false, status: "schedule_approval_expired" };
    }
    resolveCronApprovalHandoff(pending, "consumed");
    pendingApprovals.delete(command_id);
    const rememberRequested = Boolean(ctx.approval?.remember || ctx.approval?.mode);
    if (rememberRequested && !pending.evaluation.final_review_required) {
      const grant = approval.remember(pending.evaluation, { actor: approvalActor, mode: ctx.approval?.mode, duration_ms: ctx.approval?.duration_ms, note: `remembered from approval of command_id=${command_id}` });
      hds.onAuthorityEvent("grant_created", {
        request_id: pending.log.request_id,
        command_id,
        grant_id: grant.id,
        actor: approvalActor,
        reason: `remembered from approval of command_id=${command_id}`,
        evaluation: pending.evaluation,
      });
    }
    hds.onCommandLifecycle(command_id, "approval_approved", { actor: approvalActor, reason: "human_approval:approve" });
    recordApprovalHistory("human_resume_approved", pending.command, pending.log, pending.origin, approvalActor, pending.evaluation, {
      verdict,
      token_kind: ctx.token_kind,
      remember_requested: rememberRequested && !pending.evaluation.final_review_required,
      remember_ignored_final_review: rememberRequested && pending.evaluation.final_review_required,
      ...(ctx.content_review_digest ? { content_review_digest: ctx.content_review_digest } : {}),
    });
    const r = await executeAndEcho(pending.command, pending.log, pending.origin, {
      skip_approval: true,
      actor: approvalActor,
      approval_evaluation: pending.evaluation,
      command_digest: pending.command_digest,
    });
    return { approval: "approve", executed: true, status: r.status };
  }

  async function requestRecoveryMutation(
    toolName: RecoveryToolName,
    rawArguments: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (canonicalStoreRestoreMaintenanceCommandId) {
      return {
        status: "blocked_restore_in_progress",
        executed: false,
        operation: toolName,
        l3_request_created: false,
        used_for_authority: false,
        may_execute: false,
      };
    }
    const snapshot = await buildRecoverySnapshot(process.env);
    if (toolName !== "recovery.restore" && !snapshot.env_file.configured) {
      throw new Error("env_file_required");
    }
    const latestBackupId = toolName === "recovery.restore"
      ? snapshot.recovery_backups.latest_backup_id
      : null;
    const arguments_ = normalizeRecoveryMutationArguments(toolName, rawArguments, { latestBackupId });
    if (toolName === "recovery.restore" && arguments_.store_key === "cron_events" &&
        Array.from(pendingApprovals.values()).some((pending) => pending.cron_event !== undefined)) {
      return {
        status: "blocked_cron_approval_handoff_pending",
        executed: false,
        operation: toolName,
        restore_effect_scope: "entire_selected_store",
        store_key: "cron_events",
        blocking_consumers: ["pending_cron_approval_handoff"],
        reason: "cron_approval_handoff_pending",
        l3_request_created: false,
        used_for_authority: false,
        may_execute: false,
        next_action: "未処理のCron承認を完了または取消してから、Cronイベント台帳の復元を再申請してください。",
      };
    }
    const restoreConsumersNotQuiesced = toolName === "recovery.restore"
      ? canonicalStoreRestoreConsumersNotQuiesced(arguments_.store_key)
      : [];
    if (restoreConsumersNotQuiesced.length > 0) {
      return {
        status: "blocked_consumers_not_quiesced",
        executed: false,
        operation: toolName,
        restore_effect_scope: "entire_selected_store",
        store_key: arguments_.store_key,
        blocking_consumers: restoreConsumersNotQuiesced,
        reason: "canonical_state_restore_consumers_not_quiesced",
        l3_request_created: false,
        used_for_authority: false,
        may_execute: false,
        next_action: "Gatewayの実consumerを静止・排出し、復元後に再起動・再観測する境界が未接続です。安全な静止を確認できる復元経路が実装されるまで、このstoreの復元要求は作成されません。",
      };
    }
    const planScopeInspection = toolName === "recovery.restore" && arguments_.store_key === "operation_plans"
      ? await inspectRecoveryPlanRestoreScopeApplicability(process.env, arguments_.backup_id!, arguments_.scope_digest!)
      : null;
    if (planScopeInspection && !isVerifiedRecoveryPlanRestoreScope(
      planScopeInspection, arguments_.backup_id!, arguments_.scope_digest!,
    )) {
      return {
        status: "blocked_unverified_scope",
        executed: false,
        operation: toolName,
        restore_effect_scope: "entire_selected_store",
        scope_applicability: planScopeInspection,
        used_for_authority: false,
        may_execute: false,
        next_action: "指定backupとOperation Plan digestの読み取り照合を確認してから、必要ならowner L3レビューを申請してください。復元要求は作成されていません。",
      };
    }
    const origin: InboundRequest = {
      id: randomUUID(),
      channel: "webchat",
      user: "webchat-maintenance-token-holder",
      content: `tool:${toolName} ${JSON.stringify(arguments_)}`,
      timestamp: Date.now(),
      metadata: { reply_to: "local-user" },
    };
    const boundary = planGatewayInboundBoundary(origin);
    if (!gatewayInboundAllowsDownstream(boundary)) throw new Error("recovery_request_boundary_invalid");
    const authorityOrigin = boundary.request;
    const observation = buildObservationAcquisitionRecord(boundary);
    recordCompleteHistory({
      kind: "user_input",
      request_id: authorityOrigin.id,
      actor: authorityOrigin.user,
      source: authorityOrigin.channel,
      timestamp: authorityOrigin.timestamp,
      payload: observation ?? {
        channel: authorityOrigin.channel,
        content_digest: digestString(authorityOrigin.content),
        content_chars: authorityOrigin.content.length,
        metadata_keys: metadataKeys(authorityOrigin.metadata),
        boundary_status: "canonical_record_contract_failed",
        boundary_issues_count: 0,
        reply_to_present: true,
      },
    });
    const { log, command } = hds.decide(boundary.hdsBoundaryInput);
    recordCompleteHistory({
      kind: "hds_decision",
      request_id: log.request_id,
      command_id: command?.id,
      actor: authorityOrigin.user,
      source: "hds-brain",
      timestamp: log.timestamp,
      payload: hdsDecisionHistoryPayload(log, command),
    });
    if (!command || command.type !== "tool_call" || command.payload.tool_name !== toolName) {
      if (command) hds.onCommandLifecycle(command.id, "approval_rejected", {
        actor: authorityOrigin.user,
        reason: "recovery_hds_operation_mismatch",
      });
      return { status: "blocked_authority", executed: false, operation: toolName, reason: "recovery_hds_operation_mismatch" };
    }
    const evaluation = approval.evaluate(command, authorityOrigin.user);
    const finalReviewReady = evaluation.context.operation === toolName &&
      evaluation.decision === "ask" &&
      evaluation.risk === "high" &&
      evaluation.approval_level === "L3_final_review" &&
      evaluation.final_review_required;
    if (!finalReviewReady) {
      hds.onApprovalEvaluation(evaluation, { request_id: log.request_id });
      recordApprovalHistory("recovery_final_review_unavailable", command, log, authorityOrigin, authorityOrigin.user, evaluation, {
        recovery_request_blocked: true,
      });
      hds.onCommandLifecycle(command.id, "approval_rejected", {
        actor: authorityOrigin.user,
        reason: "recovery_l3_gate_unavailable",
      });
      return { status: "blocked_authority", executed: false, operation: toolName, reason: "recovery_l3_gate_unavailable" };
    }
    const result = await executeAndEcho(command, log, authorityOrigin, {
      actor: authorityOrigin.user,
      approval_evaluation: evaluation,
    });
    if (result.status !== "approval_required") {
      return {
        status: result.status,
        executed: false,
        operation: toolName,
        request_id: log.request_id,
        command_id: command.id,
      };
    }
    const pending = pendingApprovals.get(command.id);
    if (!pending || pending.evaluation.context.operation !== toolName || !pending.evaluation.final_review_required) {
      if (pending) pendingApprovals.delete(command.id);
      hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: authorityOrigin.user,
        reason: "recovery_approval_queue_incomplete",
      });
      return { status: "approval_unavailable", executed: false, operation: toolName, command_id: command.id };
    }
    if (!pending.approval_token) {
      pendingApprovals.delete(command.id);
      hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: authorityOrigin.user,
        reason: "recovery_approval_token_unavailable",
      });
      recordApprovalHistory("approval_cancelled", command, log, authorityOrigin, authorityOrigin.user, evaluation, {
        reason: "recovery_approval_token_unavailable",
      });
      return { status: "approval_unavailable", executed: false, operation: toolName, command_id: command.id };
    }
    return {
      status: "approval_required",
      executed: false,
      request_id: log.request_id,
      command_id: command.id,
      operation: evaluation.context.operation,
      target: evaluation.context.target,
      risk: evaluation.risk,
      approval_level: evaluation.approval_level,
      final_review_required: true,
      ...(planScopeInspection ? {
        restore_effect_scope: "entire_selected_store",
        scope_applicability: planScopeInspection,
      } : {}),
      next_action: "Review this exact operation and target in the owner approval queue. A fresh owner L3 approval token is required; this request has not executed.",
    };
  }

  webchat = plugins.createChannel<WebChatChannel>({
    package_name: "@blue-tanuki/channel-webchat",
    required_permissions: webchatPermissions,
    action: "register webchat channel",
    constructor_args: [{
      port,
      token,
      resume_token: resumeToken,
      maintenance_token: maintenanceToken,
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
              webchat_maintenance_token: process.env.BLUE_TANUKI_MAINTENANCE_TOKEN,
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
            execution_receipts: executionStore.snapshot(),
            operation_plan_status: projectOperationPlanStatus(hdsSnapshot.operation_plans),
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
        reviewContent: async (command_id: string) => pendingApprovalContentReview(command_id),
        validateContentReview: async (command_id: string, content_review_digest: string | undefined) =>
          validatePendingApprovalContentReview(command_id, content_review_digest),
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
        getSnapshot: async () => {
          const historySize = completeHistory.size();
          const historySkippedCount = completeHistory.skippedCount();
          const historyChainValid = completeHistory.verify();
          const recoveryHistoryIncompleteAtStart = recoveryObservationHistoryIncomplete;
          const historyAtCapacity = completeHistoryMaxEntries !== undefined &&
            historySize >= completeHistoryMaxEntries;
          const historyEntries = completeHistory.replay().filter(
            (entry): entry is CompleteHistoryEntry & { kind: "execution_history" | "final_output" } =>
              entry.kind === "execution_history" || entry.kind === "final_output",
          );
          const historyEvidence = {
            entries: historyEntries,
            chain_valid: historyChainValid,
            skipped_count: historySkippedCount +
              (historyAtCapacity || recoveryHistoryIncompleteAtStart ? 1 : 0),
            not_before_timestamp_ms: recoveryObservationStartedAtMs,
          };
          let postActionObservation = await buildRecoveryPostActionObservation(historyEvidence, process.env);
          if (historySize !== completeHistory.size() ||
              historySkippedCount !== completeHistory.skippedCount() ||
              historyChainValid !== completeHistory.verify() ||
              recoveryHistoryIncompleteAtStart !== recoveryObservationHistoryIncomplete) {
            postActionObservation = await buildRecoveryPostActionObservation({
              entries: [],
              chain_valid: false,
              skipped_count: 0,
            }, process.env);
          }
          return buildRecoverySnapshot(process.env, postActionObservation);
        },
        inspectBackup: async () => inspectLatestRecoveryBackup(process.env),
        inspectScopeApplicability: async (body: Record<string, unknown>) =>
          inspectRecoveryScopeApplicability(process.env, body),
        inspectLedgerState: async () => {
          const { inspectGatewayRecoveryState, projectGatewayRecoveryInspectionForOperator } =
            await import("./recovery_inspection.js");
          return projectGatewayRecoveryInspectionForOperator(inspectGatewayRecoveryState(process.env));
        },
        createBackup: async () => createRecoveryBackup(process.env),
        restoreBackup: async (body: Record<string, unknown>) => requestRecoveryMutation("recovery.restore", body),
        resetProvider: async (body: Record<string, unknown>) => requestRecoveryMutation("recovery.reset_provider", body),
        resetConnector: async (body: Record<string, unknown>) => requestRecoveryMutation("recovery.reset_connector", body),
        factoryReset: async (body: Record<string, unknown>) => requestRecoveryMutation("recovery.factory_reset", body),
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

  function pendingApprovalContentReview(command_id: string): WebChatApprovalContentReview | null {
    const pending = pendingApprovals.get(command_id);
    if (!pending || !isGmailMessageSendCommand(pending.command) ||
        executorCommandDigest(pending.command) !== pending.command_digest ||
        !hds.operationPlanCommandIsCurrent(pending.command)) return null;
    const review = projectGmailMessageSendContentReview(pending.command, pending.command_digest);
    if (!review) return null;
    pendingApprovals.set(command_id, {
      ...pending,
      content_review_digest: review.command_digest,
    });
    return review;
  }

  function validatePendingApprovalContentReview(
    command_id: string,
    content_review_digest: string | undefined,
  ): WebChatApprovalContentReviewValidation {
    const pending = pendingApprovals.get(command_id);
    if (!pending) return "stale";
    return validateGmailMessageSendContentReview(
      pending.command,
      pending.command_digest,
      executorCommandDigest(pending.command) === pending.command_digest &&
        hds.operationPlanCommandIsCurrent(pending.command),
      pending.content_review_digest,
      content_review_digest,
    );
  }

  function pendingApprovalSnapshot(): WebChatApprovalQueueItem[] {
    for (const [id, p] of pendingApprovals) if (!hds.operationPlanCommandIsCurrent(p.command)) {
      resolveCronApprovalHandoff(p, "cancelled");
      pendingApprovals.delete(id);
      hds.onCommandLifecycle(id, "approval_cancelled", { reason: "plan_binding_stale" });
    }
    return Array.from(pendingApprovals.values()).map((p) => ({
      command_id: p.command.id,
      request_id: p.log.request_id,
      operation: p.evaluation.context.operation,
      target: p.evaluation.context.target,
      risk: p.evaluation.risk,
      approval_level: p.evaluation.approval_level,
      final_review_required: p.evaluation.final_review_required,
      reason: p.evaluation.reason,
      content_review_required: isGmailMessageSendCommand(p.command),
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
      cron_no_replay_review: cronNoReplayReview(p.command),
    }));
  }

  function cronNoReplayReview(command: ExecuteCommand): WebChatApprovalQueueItem["cron_no_replay_review"] {
    if (command.type !== "tool_call" || command.payload.tool_name !== "schedule.resolve_event") return undefined;
    if (canonicalStoreRestoreMaintenanceCommandId) {
      return {
        kind: "cron_no_replay",
        status: "verification_unavailable",
        disposition: "acknowledge_no_replay",
        original_outcome: "unknown",
        eligible: false,
      };
    }
    const rawArgs = command.payload.arguments;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : undefined;
    if (!args) {
      return {
        kind: "cron_no_replay",
        status: "invalid_request",
        disposition: "acknowledge_no_replay",
        original_outcome: "unknown",
        eligible: false,
      };
    }
    const event_id = args.event_id;
    const payload_digest = args.payload_digest;
    if (Object.keys(args).length !== 3 || args.disposition !== "acknowledge_no_replay" ||
        typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
        typeof payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(payload_digest)) {
      return {
        kind: "cron_no_replay",
        status: "invalid_request",
        disposition: "acknowledge_no_replay",
        original_outcome: "unknown",
        eligible: false,
      };
    }
    const current = cronEventStore.unresolvedEvent(event_id, payload_digest);
    if (!current) {
      return {
        kind: "cron_no_replay",
        status: "stale_or_resolved",
        event_id,
        payload_digest,
        disposition: "acknowledge_no_replay",
        original_outcome: "unknown",
        eligible: false,
      };
    }
    if (current.delivery_state === "handler_returned") {
      return {
        kind: "cron_no_replay",
        status: "stale_or_resolved",
        event_id,
        payload_digest,
        disposition: "acknowledge_no_replay",
        original_outcome: "unknown",
        eligible: false,
      };
    }
    const status = current.resolution_state === "verification_unavailable"
      ? "verification_unavailable"
      : current.resolution_state === "owner_acknowledged_no_replay"
      ? "already_acknowledged"
      : cron.isEventInFlight(event_id)
      ? "in_flight"
      : "eligible";
    return {
      kind: "cron_no_replay",
      status,
      event_id,
      payload_digest,
      delivery_state: current.delivery_state,
      disposition: "acknowledge_no_replay",
      original_outcome: "unknown",
      eligible: status === "eligible",
    };
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

      if (log.kind === "memory_citation_review") {
        items.push({
          ...base,
          kind: "memory_citation_review",
          event: log.event,
          command_id: log.command_id,
          search_plan_id: log.search_plan_id,
          application_scope_id: log.application_scope_id,
          status: log.status,
          candidate_count: log.candidate_count,
          candidate_references: log.candidate_references,
          projection_records: log.projection_records ?? [],
          accepted_citations: log.accepted_citations,
          rejected_proposal_count: log.rejected_proposal_count,
          rejection_reasons: log.rejection_reasons,
          source_result_digest: log.source_result_digest,
          reviewed_content_digest: log.reviewed_content_digest,
          used_for_authority: log.used_for_authority,
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
    const authorityTrace = authorityTraceSnapshot();
    let operationPlanProjection: ReturnType<HDSUpperController["getRuntimeSnapshot"]>["operation_plans"] | undefined;
    try { operationPlanProjection = hds.getRuntimeSnapshot().operation_plans; } catch { /* optional read-only correlation */ }
    const cronState = readCronNotificationState(cronEventStore);
    return buildResidentNotificationsSnapshot({
      audit_chain_valid: hds.getAudit().verify(),
      pending_approvals: pendingApprovalSnapshot(),
      authority_trace: authorityTrace,
      unresolved_cron_events: cronState.unresolved_events,
      interrupted_cron_approvals: cronState.interrupted_approvals,
      cron_state_read_failures: cronState.read_failures,
      operation_plan_projection: operationPlanProjection,
    });
  }

  function resolveCronApprovalHandoff(
    pending: PendingApproval,
    resolution: "consumed" | "rejected" | "cancelled",
  ): void {
    if (!pending.cron_event) return;
    cronEventStore.resolvePendingApproval(
      pending.cron_event.event_id,
      pending.cron_event.payload_digest,
      pending.command.id,
      pending.log.request_id,
      resolution,
    );
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
    compute: new LLMComputeAdapter(llm),
    tools,
    approval_authority: executorApproval,
    file_search_worker: createFileSearchWorker(process.env),
    dispatcher,
    session_store: buildSessionStore(plugins),
  });

  let documentOrganizationCheckpointStore: DocumentOrganizationCheckpointStore | null = null;
  const checkpointStoreForOrganizer = (): DocumentOrganizationCheckpointStore => {
    documentOrganizationCheckpointStore ??= DocumentOrganizationCheckpointStore.fromEnvironment(process.env);
    return documentOrganizationCheckpointStore;
  };

  const handler = async (req: InboundRequest): Promise<void> => {
    const boundary = planGatewayInboundBoundary(req);
    const authorityReq = boundary.request;
    // Gateway history, reply, and execution paths use only authorityReq, which
    // is a canonical request or the safe invalid-inbound fallback. Raw invalid
    // input is passed to HDS-BRAIN only for its independent fail-closed
    // authority-boundary audit; raw input must not be used for execution.
    const hdsBoundaryInput = boundary.hdsBoundaryInput;
    const observationAcquisitionRecord = buildObservationAcquisitionRecord(boundary);
    recordCompleteHistory({
      kind: "user_input",
      request_id: authorityReq.id,
      actor: authorityReq.user,
      source: authorityReq.channel,
      timestamp: authorityReq.timestamp,
      payload: observationAcquisitionRecord ?? {
        channel: authorityReq.channel,
        user: authorityReq.user,
        content_digest: boundary.boundary_ok ? digestString(authorityReq.content) : undefined,
        content_chars: boundary.boundary_ok ? authorityReq.content.length : 0,
        metadata_keys: metadataKeys(authorityReq.metadata),
        boundary_status: boundary.boundary_ok
          ? "canonical_record_contract_failed"
          : "invalid_fail_closed",
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
    const documentSource = boundary.boundary_ok
      ? documentOrganizationSourceFromRequest(authorityReq)
      : null;
    const documentSession = documentSource === null
      ? null
      : prepareDocumentOrganizationSession({
        request: authorityReq,
        source_text: documentSource,
        hds,
        store: checkpointStoreForOrganizer(),
      });
    const documentCoordinator = documentSession?.coordinator ?? null;
    const decisionInput = documentCoordinator
      ? {
        ...authorityReq,
        content: documentSession?.restored_terminal_state
          ? `${DOCUMENT_ORGANIZATION_PROMPT_PREFIX}復旧済みの終端projection表示に必要なHDS判断です。計算は実行しません。`
          : documentCoordinator.buildComputePrompt(),
      }
      : boundary.boundary_ok
        ? prepareFailureReviewInbound(hdsBoundaryInput, failureMemory)
        : hdsBoundaryInput;
    const { log, command } = hds.decide(decisionInput, documentCoordinator
      ? { transient_content: "document_organization" }
      : undefined);
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

    if (documentSession?.restored_terminal_state && log.commit.decision === "ASSERT") {
      if (command) {
        hds.onCommandLifecycle(command.id, "approval_cancelled", {
          actor: authorityReq.user,
          reason: "document_organization_checkpoint_terminal_no_compute_required",
        });
      }
      const result = presentRestoredDocumentOrganizationProjection({
        coordinator: documentSession.coordinator,
        request_id: authorityReq.id,
        upstream_commit_hash: log.commit.hash,
        hds,
        target_surface: "channel",
      });
      recordCompleteHistory({
        kind: "audit_history",
        request_id: authorityReq.id,
        actor: authorityReq.user,
        source: "document_organization_restored_j_projection",
        timestamp: Date.now(),
        payload: {
          task_id: result.projection.task_id,
          projection_revision: result.projection.revision,
          status: result.projection.status,
          source_sha256: result.projection.source_ref.content_sha256,
          accepted_excerpt_count: result.projection.accepted_excerpts.length,
          output_digest: result.output_audit.rendered_output_digest,
          restored_from_checkpoint: true,
          used_for_authority: false,
          may_execute: false,
          may_commit_to_memory: false,
        },
      });
      if (result.rendered_output) {
        await dispatcher.dispatch({
          channel: authorityReq.channel,
          target: replyTarget(authorityReq),
          content: result.rendered_output,
        }, {
          command_id: `notify-${authorityReq.id}`,
          upstream_commit_hash: log.commit.hash,
        });
      }
      return;
    }

    if (documentCoordinator && documentSession && command) {
      const result = await runDocumentOrganizationTask({
        coordinator: documentCoordinator,
        origin: authorityReq,
        hds,
        executor,
        executorApproval,
        approval,
        failureMemory,
        target_surface: "channel",
        first_decision: { log, command },
        persist_checkpoint: documentSession.persist_checkpoint,
        current_memory_version: () => hds.documentOrganizationMemoryVersion(),
        emergency_stop_active: emergencyStop.active,
      });
      if (!result) return;

      recordCompleteHistory({
        kind: "audit_history",
        request_id: authorityReq.id,
        ...(result.command_id !== null ? { command_id: result.command_id } : {}),
        actor: authorityReq.user,
        source: "document_organization_j_projection",
        timestamp: Date.now(),
        payload: {
          schema_version: result.projection.schema_version,
          task_id: result.projection.task_id,
          projection_revision: result.projection.revision,
          status: result.projection.status,
          completed_cycles: result.projection.completed_cycles,
          source_sha256: result.projection.source_ref.content_sha256,
          accepted_excerpt_count: result.projection.accepted_excerpts.length,
          uncovered_range_count: result.projection.uncovered_ranges.length,
          issue_codes: result.projection.issue_codes,
          used_for_authority: false,
          may_execute: false,
          may_commit_to_memory: false,
        },
      });
      if (result.output_audit.kind === "output_audit") {
        recordFinalOutputHistory(log, authorityReq, authorityReq.user, result.output_audit);
      } else {
        recordCompleteHistory({
          kind: "audit_history",
          request_id: authorityReq.id,
          actor: authorityReq.user,
          source: "document_organization_j_projection_output_audit",
          timestamp: Date.now(),
          payload: {
            task_id: result.output_audit.task_id,
            projection_revision: result.output_audit.projection_revision,
            projection_status: result.output_audit.projection_status,
            rendered_output_digest: result.output_audit.rendered_output_digest,
            rendered_output_chars: result.output_audit.rendered_output_chars,
            used_for_authority: false,
            may_execute: false,
            may_commit_to_memory: false,
          },
        });
      }
      if (result.rendered_output) {
        await dispatcher.dispatch({
          channel: authorityReq.channel,
          target: replyTarget(authorityReq),
          content: result.rendered_output,
        }, {
          command_id: result.command_id ?? `notify-${authorityReq.id}`,
          upstream_commit_hash: result.upstream_commit_hash,
        });
      }
      return;
    }

    if (command?.type === "noop" && command.payload.control_event === "operation_plan_receipt_reconciliation") {
      const startedAt = Date.now();
      const result = await runLocalInspectionReconciliation({
        hds,
        command,
        caller: authorityReq,
        endpoint: nonEmptyEnv(process.env.BLUE_TANUKI_LOCAL_INSPECTION_ENDPOINT),
      });
      const content = localInspectionReconciliationMessage(result);
      const feedback: ExecuteFeedback = {
        command_id: command.id,
        status: result.status === "observed" ? "success" : "failed",
        result: { content },
        ...(result.status === "observed" ? {} : { error: result.reason }),
        metrics: { duration_ms: Math.max(0, Date.now() - startedAt) },
      };
      const finalized = finalizeCommandOutput({ hds, command, feedback, target_surface: "channel", request_id: log.request_id });
      recordFinalOutputHistory(log, authorityReq, authorityReq.user, finalized.output_audit);
      if (finalized.rendered_output) await dispatcher.dispatch({
        channel: authorityReq.channel, target: replyTarget(authorityReq), content: finalized.rendered_output,
      }, { command_id: command.id, upstream_commit_hash: log.commit.hash });
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
      gatewayShuttingDown = true;
      clearInterval(failureMemoryVerificationTimer);
      emergencyStop.active = true;
      for (const controller of executionControllers) controller.abort();
      await router.stop();
      // workerのcloseと最終receipt保存が済む前にDBを閉じない。
      await Promise.allSettled([...executionTasks]);
      cronEventStore.close();
      documentOrganizationCheckpointStore?.close();
      documentOrganizationCheckpointStore = null;
      operationPlanState.close();
      hds.closeOperationPlanMemory();
      executionStore.close();
      auditLog.info("summary", {
        entries: hds.getAudit().size(),
        chain_valid: hds.getAudit().verify(),
      });
      ownerLease.close();
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
