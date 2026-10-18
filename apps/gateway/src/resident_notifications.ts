import type {
  WebChatApprovalQueueItem,
  WebChatCronResultCorrelationStatus,
  WebChatCronResultMemoryStatus,
  WebChatAuthorityTraceItem,
  WebChatNotificationItem,
} from "@blue-tanuki/channel-webchat";
import type { CronApprovalHandoffSnapshot, CronEventCursorSnapshot } from "./cron_event_store.js";

interface OperationPlanCorrelationProjection {
  readonly schema_version: string;
  readonly used_for_authority: false;
  readonly raw_payload_exposed: false;
  readonly plans: readonly {
    readonly request_id: string;
    readonly steps?: readonly {
      readonly status: string;
      readonly external_receipt_observation?: string;
      readonly external_receipt?: {
        readonly source: string;
        readonly match_count: number;
        readonly evidence_digest: string;
        readonly receipt_digest?: string;
        readonly observed_at_ms: number;
        readonly used_for_authority: boolean;
        readonly raw_receipt_exposed: boolean;
      };
    }[];
    readonly bindings: readonly {
      readonly request_id: string;
      readonly status: string;
      readonly result_digest?: string;
      readonly delivery_digest?: string;
      readonly memory_status?: string;
    }[];
  }[];
}

export interface ResidentNotificationInput {
  now_ms?: number;
  audit_chain_valid: boolean;
  pending_approvals: readonly WebChatApprovalQueueItem[];
  authority_trace: readonly WebChatAuthorityTraceItem[];
  unresolved_cron_events?: readonly CronEventCursorSnapshot[];
  interrupted_cron_approvals?: readonly CronApprovalHandoffSnapshot[];
  cron_state_read_failures?: readonly CronNotificationStateReadFailure[];
  operation_plan_projection?: OperationPlanCorrelationProjection;
  limit?: number;
}

export type CronNotificationStateReadFailure = "unresolved_events" | "interrupted_approvals";

export interface CronNotificationStateReader {
  unresolvedEvents(): CronEventCursorSnapshot[];
  interruptedApprovalHandoffs(): CronApprovalHandoffSnapshot[];
}

export interface CronNotificationStateSnapshot {
  readonly unresolved_events: readonly CronEventCursorSnapshot[];
  readonly interrupted_approvals: readonly CronApprovalHandoffSnapshot[];
  readonly read_failures: readonly CronNotificationStateReadFailure[];
}

/** Keep one unreadable Cron projection from suppressing the other notifications. */
export function readCronNotificationState(store: CronNotificationStateReader): CronNotificationStateSnapshot {
  let unresolvedEvents: CronEventCursorSnapshot[] = [];
  let interruptedApprovals: CronApprovalHandoffSnapshot[] = [];
  const readFailures: CronNotificationStateReadFailure[] = [];
  try {
    unresolvedEvents = store.unresolvedEvents();
  } catch {
    readFailures.push("unresolved_events");
  }
  try {
    interruptedApprovals = store.interruptedApprovalHandoffs();
  } catch {
    readFailures.push("interrupted_approvals");
  }
  return {
    unresolved_events: unresolvedEvents,
    interrupted_approvals: interruptedApprovals,
    read_failures: readFailures,
  };
}

export function buildResidentNotificationsSnapshot(
  input: ResidentNotificationInput,
): WebChatNotificationItem[] {
  const now = input.now_ms ?? Date.now();
  const notifications: WebChatNotificationItem[] = [];

  if (!input.audit_chain_valid) {
    notifications.push({
      id: "audit:chain-invalid",
      kind: "audit_warning",
      severity: "critical",
      title: "Audit chain warning",
      message: "Hash-chain verification failed.",
      timestamp: now,
      source: "audit",
      read_only: true,
      authority: "display_only",
      next_action: "Stop normal operation, preserve the audit store, and run audit verification before continuing.",
    });
  }

  for (const failure of input.cron_state_read_failures ?? []) {
    if (failure !== "unresolved_events" && failure !== "interrupted_approvals") continue;
    notifications.push({
      id: `cron-state-unavailable:${failure}`,
      kind: "cron_recovery_state_unavailable",
      severity: "warning",
      title: "Scheduled recovery state could not be verified",
      message: failure === "unresolved_events"
        ? "The unresolved schedule-event list could not be verified; its state may be incomplete. No recovery action was taken."
        : "The interrupted schedule-approval list could not be verified; its state may be incomplete. No recovery action was taken.",
      timestamp: now,
      source: failure === "unresolved_events" ? "cron_event_cursor" : "cron_approval_handoff",
      read_only: true,
      authority: "display_only",
      next_action: "Preserve the recovery state and verify pending schedule work before creating a duplicate request.",
    });
  }

  for (const item of input.pending_approvals) {
    notifications.push({
      id: `approval:${item.command_id}`,
      kind: "approval_required",
      severity: "action_required",
      title: item.final_review_required
        ? "Final review required"
        : "Approval required",
      message: `${item.operation} is waiting for an explicit owner verdict.`,
      timestamp: now,
      source: "approval_queue",
      read_only: true,
      authority: "display_only",
      request_id: item.request_id,
      command_id: item.command_id,
      approval_level: item.approval_level,
      risk: item.risk,
      expires_at_ms: item.approval_token_expires_at_ms,
      next_action: "Open Approval Queue and submit approve, reject, or block through the Approval Gate.",
    });
  }

  for (const event of input.unresolved_cron_events ?? []) {
    const externalReceiptCorrelation = cronExternalReceiptCorrelation(event.event_id, input.operation_plan_projection);
    const receiptDisclosure = receiptObservationDisclosure(
      externalReceiptCorrelation.external_receipt_observation_status,
      externalReceiptCorrelation.external_receipt_observation_source,
    );
    notifications.push({
      id: `schedule-delivery-unsettled:${event.event_id}`,
      kind: "schedule_delivery_unknown",
      severity: "warning",
      title: "Schedule delivery result is unsettled",
      message: event.resolution_state === "owner_acknowledged_no_replay"
        ? `Cron event sequence ${event.sequence} remains ${event.delivery_state}; the owner recorded a no-replay disposition, so later events may proceed. The original outcome remains unknown. A saved-result link is evidence correlation only.${receiptDisclosure}`
        : event.resolution_state === "verification_unavailable"
        ? `Cron event sequence ${event.sequence} remains ${event.delivery_state}; the no-replay disposition could not be verified, so later events remain blocked. A saved-result link is evidence correlation only, not proof of external success.${receiptDisclosure}`
        : `Cron event sequence ${event.sequence} remains ${event.delivery_state}; delivery is not confirmed, and later events from this source are blocked without automatic replay. A saved-result link is evidence correlation only, not proof of external success.${receiptDisclosure}`,
      timestamp: event.updated_at_ms,
      source: "cron_event_cursor",
      read_only: true,
      authority: "display_only",
      request_id: event.event_id,
      payload_hash: event.payload_digest,
      cron_resolution_state: event.resolution_state,
      ...cronResultCorrelation(event.event_id, input.operation_plan_projection),
      ...externalReceiptCorrelation,
      next_action: event.resolution_state === "owner_acknowledged_no_replay"
        ? "The next event may proceed, but this result is still unknown; inspect the authorized target independently before treating the action as complete."
        : "Inspect Authority Trace for this event ID and verify target delivery before taking any duplicate action.",
    });
  }

  for (const [index, approval] of (input.interrupted_cron_approvals ?? []).entries()) {
    const resultCorrelation = cronResultCorrelation(approval.event_id, input.operation_plan_projection);
    const externalReceiptCorrelation = cronExternalReceiptCorrelation(approval.event_id, input.operation_plan_projection);
    notifications.push({
      id: `cron-approval-interrupted:${approval.event_id}:${index}`,
      kind: "approval_interrupted",
      severity: "warning",
      title: "Cron approval was interrupted by Gateway restart",
      message: `A saved approval was not restored after restart. Inspect the event and any saved result before creating a new request.${receiptObservationDisclosure(
        externalReceiptCorrelation.external_receipt_observation_status,
        externalReceiptCorrelation.external_receipt_observation_source,
      )}`,
      timestamp: approval.updated_at_ms,
      source: "cron_approval_handoff",
      read_only: true,
      authority: "display_only",
      request_id: approval.event_id,
      payload_hash: approval.payload_digest,
      ...resultCorrelation,
      ...externalReceiptCorrelation,
      next_action: "Review Authority Trace and result evidence for this event. If work is still needed, submit a new request for a fresh approval; do not reuse the interrupted approval.",
    });
  }

  for (const trace of input.authority_trace) {
    if (trace.kind === "schedule_lifecycle") {
      if (trace.event === "schedule.lifecycle.fired") {
        notifications.push({
          id: `schedule-fired:${trace.index}:${trace.schedule_id ?? "unknown"}`,
          kind: "schedule_fired",
          severity: "info",
          title: "Schedule fired",
          message: "A runtime or boot schedule entered the cron lane.",
          timestamp: trace.timestamp,
          source: "runtime_schedule",
          read_only: true,
          authority: "display_only",
          request_id: trace.request_id,
          command_id: trace.command_id,
          schedule_id: trace.schedule_id,
          payload_hash: trace.payload_hash,
          next_action: "Inspect Runtime Schedules and Authority Trace if delivery status is unclear.",
        });
      } else if (trace.event === "schedule.lifecycle.rejected") {
        notifications.push({
          id: `schedule-failed:${trace.index}:${trace.schedule_id ?? "unknown"}`,
          kind: "schedule_failed",
          severity: "warning",
          title: "Schedule request failed",
          message: "A schedule request was rejected, expired, or failed before activation.",
          timestamp: trace.timestamp,
          source: "runtime_schedule",
          read_only: true,
          authority: "display_only",
          request_id: trace.request_id,
          command_id: trace.command_id,
          schedule_id: trace.schedule_id,
          approval_level: trace.approval_level,
          risk: trace.risk,
          payload_hash: trace.payload_hash,
          next_action: "Run schedule.list, fix the request, and submit a new approval if the schedule should still exist.",
        });
      }
      continue;
    }

    if (trace.kind !== "executor_feedback" || trace.status !== "failed") {
      continue;
    }

    if (trace.source_process_kind === "cron" || trace.source_channel === "cron") {
      notifications.push({
        id: `schedule-delivery-failed:${trace.index}:${trace.command_id ?? "unknown"}`,
        kind: "schedule_failed",
        severity: "warning",
        title: "Schedule delivery failed",
        message: trace.error ?? "Cron downstream delivery failed.",
        timestamp: trace.timestamp,
        source: "executor_feedback",
        read_only: true,
        authority: "display_only",
        request_id: trace.request_id,
        command_id: trace.command_id,
        next_action: "Inspect the target channel credentials, run doctor, and retry only after the connector is healthy.",
      });
      continue;
    }

    if (looksLikeConnectorFailure(trace.error)) {
      notifications.push({
        id: `connector-failure:${trace.index}:${trace.command_id ?? "unknown"}`,
        kind: "connector_failure",
        severity: "warning",
        title: "Connector delivery failed",
        message: trace.error ?? "Downstream connector delivery failed.",
        timestamp: trace.timestamp,
        source: "executor_feedback",
        read_only: true,
        authority: "display_only",
        request_id: trace.request_id,
        command_id: trace.command_id,
        next_action: "Inspect the connector credential and target, then rerun the relevant live smoke if needed.",
      });
    }
  }

  return dedupe(notifications)
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
    .slice(0, input.limit ?? 50);
}

function cronResultCorrelation(
  requestId: string,
  projection: OperationPlanCorrelationProjection | undefined,
): Pick<WebChatNotificationItem, "result_correlation_status" | "result_memory_status"> {
  if (!projection || projection.schema_version !== "operation-plan-projection.v1" ||
      projection.used_for_authority !== false || projection.raw_payload_exposed !== false ||
      !Array.isArray(projection.plans) || !projection.plans.every((plan) =>
        plan && typeof plan.request_id === "string" && Array.isArray(plan.bindings))) {
    return { result_correlation_status: "projection_unavailable" };
  }

  const plans = (projection.plans as OperationPlanCorrelationProjection["plans"])
    .filter((plan) => plan.request_id === requestId);
  if (plans.length === 0) return { result_correlation_status: "no_matching_plan" };
  if (plans.length !== 1) return { result_correlation_status: "ambiguous" };

  const planBindings = plans[0]!.bindings as unknown;
  if (!Array.isArray(planBindings)) return { result_correlation_status: "ambiguous" };
  const bindings = planBindings as OperationPlanCorrelationProjection["plans"][number]["bindings"];
  if (bindings.some((binding) => binding.request_id !== requestId)) {
    return { result_correlation_status: "ambiguous" };
  }
  if (bindings.length === 0) return { result_correlation_status: "no_bound_command" };
  const unresolved = new Set(["selected", "intent_committed", "outcome_unknown"]);
  if (bindings.some((binding) => unresolved.has(binding.status))) {
    return { result_correlation_status: "execution_unresolved" };
  }
  const terminal = new Set(["verified", "verification_failed", "not_attempted"]);
  const known = new Set([...unresolved, ...terminal, "invalidated"]);
  if (bindings.some((binding) => !known.has(binding.status))) {
    return { result_correlation_status: "ambiguous" };
  }
  if (bindings.some((binding) => !terminal.has(binding.status)) ||
      bindings.some((binding) => !/^[a-f0-9]{64}$/.test(binding.result_digest ?? "") ||
        !/^[a-f0-9]{64}$/.test(binding.delivery_digest ?? ""))) {
    return { result_correlation_status: "saved_result_missing" };
  }

  const memoryStates = bindings.map((binding) => binding.memory_status);
  const singleMemoryState = memoryStates.every((state) => state === memoryStates[0]) ? memoryStates[0] : undefined;
  const memoryStatus: WebChatCronResultMemoryStatus = singleMemoryState === "memory_commit_pending"
    ? "commit_pending"
    : singleMemoryState === "receipt_confirmed"
      ? "receipt_confirmed"
      : singleMemoryState === "not_recorded"
        ? "not_recorded"
        : "mixed_or_unknown";
  return {
    result_correlation_status: "saved_result_linked",
    result_memory_status: memoryStatus,
  };
}

function cronExternalReceiptCorrelation(
  requestId: string,
  projection: OperationPlanCorrelationProjection | undefined,
): Pick<WebChatNotificationItem, "external_receipt_observation_status" | "external_receipt_observation_source"> {
  if (!projection || projection.schema_version !== "operation-plan-projection.v1" ||
      projection.used_for_authority !== false || projection.raw_payload_exposed !== false ||
      !Array.isArray(projection.plans) || !projection.plans.every((plan) =>
        plan && typeof plan.request_id === "string" && Array.isArray(plan.bindings))) {
    return { external_receipt_observation_status: "projection_unavailable" };
  }
  const plans = projection.plans.filter((plan) => plan?.request_id === requestId);
  if (plans.length === 0) return { external_receipt_observation_status: "no_matching_plan" };
  if (plans.length !== 1) return { external_receipt_observation_status: "ambiguous" };
  const steps = plans[0]!.steps;
  if (!Array.isArray(steps) || !steps.every((step) => step && typeof step.status === "string")) {
    return { external_receipt_observation_status: "projection_unavailable" };
  }
  const unresolved = steps.filter((step) => step.status === "outcome_unknown");
  if (unresolved.length === 0) return { external_receipt_observation_status: "not_applicable" };

  const statuses: string[] = [];
  let hasRecordedObservation = false;
  for (const step of unresolved) {
    const status = step.external_receipt_observation;
    if (!status || !["not_recorded", "matched", "not_found", "mismatch", "ambiguous"].includes(status)) {
      return { external_receipt_observation_status: "mixed_or_unknown" };
    }
    statuses.push(status);
    if (status === "not_recorded") {
      if (step.external_receipt !== undefined) return { external_receipt_observation_status: "mixed_or_unknown" };
      continue;
    }
    const observation = step.external_receipt;
    if (!observation || observation.source !== "local_inspection" || observation.used_for_authority !== false ||
        observation.raw_receipt_exposed !== false || !Number.isSafeInteger(observation.match_count) ||
        observation.match_count < 0 || observation.match_count > 100 ||
        !/^[a-f0-9]{64}$/.test(observation.evidence_digest) ||
        (observation.receipt_digest !== undefined && !/^[a-f0-9]{64}$/.test(observation.receipt_digest)) ||
        !Number.isSafeInteger(observation.observed_at_ms) || observation.observed_at_ms < 0) {
      return { external_receipt_observation_status: "mixed_or_unknown" };
    }
    const consistent = status === "matched"
      ? observation.match_count === 1 && observation.receipt_digest !== undefined
      : status === "not_found"
        ? observation.match_count === 0 && observation.receipt_digest === undefined
        : status === "mismatch"
          ? observation.match_count === 1 && observation.receipt_digest !== undefined
          : observation.match_count >= 2 && observation.receipt_digest === undefined;
    if (!consistent) return { external_receipt_observation_status: "mixed_or_unknown" };
    hasRecordedObservation = true;
  }

  const uniqueStatuses = new Set(statuses);
  return {
    external_receipt_observation_status: uniqueStatuses.size === 1
      ? statuses[0] as WebChatNotificationItem["external_receipt_observation_status"]
      : "mixed_or_unknown",
    ...(hasRecordedObservation ? { external_receipt_observation_source: "local_inspection" as const } : {}),
  };
}

function receiptObservationDisclosure(
  status: WebChatNotificationItem["external_receipt_observation_status"],
  source: WebChatNotificationItem["external_receipt_observation_source"],
): string {
  if (!status || status === "projection_unavailable" || status === "no_matching_plan" || status === "not_applicable") return "";
  const label = source === "local_inspection" ? "Read-only local receipt observation" : "Receipt observation state";
  return ` ${label}=${status}; it does not settle delivery or establish action success.`;
}

function looksLikeConnectorFailure(error: string | undefined): boolean {
  if (!error) return false;
  const value = error.toLowerCase();
  return [
    "channel",
    "delivery",
    "slack",
    "discord",
    "telegram",
    "teams",
    "line",
    "not_configured",
    "rate_limited",
  ].some((needle) => value.includes(needle));
}

function dedupe(
  notifications: readonly WebChatNotificationItem[],
): WebChatNotificationItem[] {
  const byId = new Map<string, WebChatNotificationItem>();
  for (const notification of notifications) {
    byId.set(notification.id, notification);
  }
  return Array.from(byId.values());
}
