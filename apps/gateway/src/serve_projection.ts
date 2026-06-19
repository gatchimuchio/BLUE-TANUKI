import { createHash } from "node:crypto";
import type {
  ApprovalGrant,
  CompleteHistoryEntry,
  CompleteHistoryKind,
  DecisionLog,
} from "@blue-tanuki/hds-brain";
import type {
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatHistoryEntry,
} from "@blue-tanuki/channel-webchat";
import {
  OperationCoreApprovalTraceSchema,
  OperationCoreExecutorTraceSchema,
  OperationCoreExecutionProjectionSchema,
  OperationCorePlannerExecutionProjectionSchema,
  OperationPlanSchema,
  type ExecuteCommand,
  type ExecuteFeedback,
  type OperationCoreApprovalTrace,
  type OperationCoreExecutionProjection,
  type OperationCorePlannerExecutionProjection,
} from "@blue-tanuki/protocol";

export function metadataKeys(meta: Record<string, unknown> | undefined): string[] {
  return Object.keys(meta ?? {}).sort();
}

export function hdsDecisionHistoryPayload(
  log: DecisionLog,
  command: ExecuteCommand | null,
): Record<string, unknown> {
  return {
    decision: log.commit.decision,
    reason: log.commit.reason,
    commit_hash: log.commit.hash,
    triggered_thresholds: log.commit.triggered_thresholds,
    input_changed: log.input?.changed ?? false,
    normalized_content_digest: log.input?.normalized_content
      ? digestString(log.input.normalized_content)
      : undefined,
    control_chars: log.input?.controls.map((control) => ({
      index: control.index,
      code_point: control.code_point,
      kind: control.kind,
      name: control.name,
    })) ?? [],
    actor: {
      actor_kind: log.frame.actor.actor_kind,
      channel: log.frame.actor.channel,
      trust_level: log.frame.actor.trust_level,
    },
    process: {
      process_id: log.frame.process.process_id,
      process_kind: log.frame.process.process_kind,
      trigger_kind: log.frame.process.trigger.kind,
      approval_profile: log.frame.process.approval_profile,
      execution_policy: {
        allowed_command_types: log.frame.process.execution_policy.allowed_command_types,
        allowed_tools: log.frame.process.execution_policy.allowed_tools,
        allowed_capabilities: log.frame.process.execution_policy.allowed_capabilities,
        timeout_ms: log.frame.process.execution_policy.timeout_ms,
      },
    },
    operator_surface: log.frame.operator_surface,
    memory_trace: {
      policy_id: log.frame.memory_trace.policy_id,
      hits: log.frame.memory_trace.hits.length,
      used_for_authority: log.frame.memory_trace.used_for_authority,
    },
    model: {
      abstraction: log.model.abstraction,
      scoring_aggregate: log.model.scoring.aggregate,
      axis_count: log.model.scoring.axis_scores.length,
    },
    command: command ? commandHistoryDescriptor(command) : null,
  };
}

export function commandHistoryDescriptor(command: ExecuteCommand): Record<string, unknown> {
  const base = {
    command_id: command.id,
    type: command.type,
    operation: commandOperation(command),
    upstream_commit_hash: command.upstream_decision.commit_hash,
    upstream_decision: command.upstream_decision.commit_decision,
    constraints: {
      max_tokens: command.constraints?.max_tokens,
      timeout_ms: command.constraints?.timeout_ms,
      allowed_tools: command.constraints?.allowed_tools,
      allowed_capabilities: command.constraints?.allowed_capabilities,
    },
  };
  if (command.type === "tool_call") {
    return {
      ...base,
      payload: {
        tool_name: command.payload.tool_name,
        argument_keys: Object.keys(command.payload.arguments).sort(),
        arguments_digest: digestValue(command.payload.arguments),
      },
    };
  }
  if (command.type === "llm_call") {
    return {
      ...base,
      payload: {
        messages_count: command.payload.messages.length,
        message_roles: command.payload.messages.map((message) => message.role),
        messages_digest: digestValue(command.payload.messages),
        backend_hint: command.payload.backend_hint,
        model: command.payload.model,
        temperature: command.payload.temperature,
        session_id_digest: command.payload.session_id
          ? digestString(command.payload.session_id)
          : undefined,
      },
    };
  }
  if (command.type === "channel_send") {
    return {
      ...base,
      payload: {
        channel: command.payload.channel,
        target_digest: digestString(command.payload.target),
        content_digest: digestString(command.payload.content),
        content_chars: command.payload.content.length,
      },
    };
  }
  return {
    ...base,
    payload: {},
  };
}

export function isComposioExecuteCommand(command: ExecuteCommand): boolean {
  return command.type === "tool_call" && command.payload.tool_name === "composio.execute";
}

const COMPLETE_HISTORY_KINDS: readonly CompleteHistoryKind[] = [
  "user_input",
  "llm_history",
  "hds_decision",
  "approval_history",
  "execution_history",
  "audit_history",
  "final_output",
];

export function isCompleteHistoryKind(value: unknown): value is CompleteHistoryKind {
  return typeof value === "string" && COMPLETE_HISTORY_KINDS.includes(value as CompleteHistoryKind);
}

export function projectCompleteHistoryEntry(entry: CompleteHistoryEntry): WebChatHistoryEntry {
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

export function projectOperationCoreExecutionHistory(
  entries: readonly CompleteHistoryEntry[],
  opts: { chain_valid: boolean; skipped_count: number; limit?: number },
): OperationCoreExecutionProjection {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 6));
  const executionEntries = entries.filter((entry) => entry.kind === "execution_history");
  const latestResults = executionEntries
    .slice(-limit)
    .reverse()
    .map(projectOperationCoreExecutionEntry);
  return OperationCoreExecutionProjectionSchema.parse({
    schema_version: "operation-core.execution.v1",
    evidence_source: ["INTERNAL_STATE"],
    used_for_authority: false,
    adapter_result_used_for_authority: false,
    execution_history_used_for_authority: false,
    raw_payload_exposed: false,
    chain_valid: opts.chain_valid === true,
    skipped_count: opts.skipped_count,
    entries_count: executionEntries.length,
    displayed_count: latestResults.length,
    latest_results: latestResults,
  });
}

export function operationCorePlannerHistoryProjection(
  feedback: ExecuteFeedback,
): OperationCorePlannerExecutionProjection | undefined {
  const result = isRecord(feedback.result) ? feedback.result : null;
  const operationCore = isRecord(result?.operation_core) ? result.operation_core : null;
  if (!operationCore || operationCore.status !== "valid_plan") return undefined;
  const plan = OperationPlanSchema.safeParse(operationCore.plan);
  if (!plan.success) return undefined;
  return OperationCorePlannerExecutionProjectionSchema.parse({
    role: "planner_output_projection",
    status: "valid_plan",
    plan_id: plan.data.plan_id,
    request_id: plan.data.request_id,
    state: plan.data.state,
    steps_count: plan.data.steps.length,
    step_summaries: plan.data.steps.slice(0, 20).map((step) => ({
      step_id: step.step_id,
      operation: step.operation,
      target_kind: step.target.kind,
      target_id_digest: digestString(step.target.id),
      effects: step.effects,
      adapter: step.adapter,
      adapter_is_authority: step.adapter_is_authority,
      command_generated_by_adapter_only: step.command_generated_by_adapter_only,
      approval_level: step.permission.approval_level,
      risk: step.permission.risk,
      final_review_required: step.permission.final_review_required,
    })),
    raw_command_is_core_operation: plan.data.raw_command_policy.raw_command_is_core_operation,
    planner_output_used_for_authority: plan.data.planner_output_used_for_authority,
    hds_brain_authority_required: plan.data.hds_brain_authority_required,
    evidence_source: ["EXTERNAL_EVIDENCE", "INTERNAL_STATE"],
  });
}

function projectOperationCoreExecutionEntry(entry: CompleteHistoryEntry): Record<string, unknown> {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  const command = isRecord(payload.command) ? payload.command : {};
  const metrics = isRecord(payload.metrics) ? payload.metrics : {};
  const error = stringValue(payload.error);
  const executionTrace = projectOperationCoreExecutorTrace(payload.operation_core);
  const plannerOutput = projectOperationCorePlannerExecutionProjection(payload.operation_core_planner);
  return {
    index: entry.index,
    request_id: entry.request_id,
    command_id: entry.command_id,
    actor: entry.actor,
    source: entry.source,
    timestamp: entry.timestamp,
    payload_digest: entry.payload_digest,
    entry_hash: entry.entry_hash,
    origin_channel: stringValue(payload.origin_channel) ?? "unknown",
    status: stringValue(payload.status) ?? "unknown",
    result_present: payload.result_present === true,
    result_digest: stringValue(payload.result_digest) ?? null,
    error_present: Boolean(error),
    error_digest: error ? digestString(error) : null,
    metrics: {
      duration_ms: numberValue(metrics.duration_ms),
    },
    command: projectOperationCoreCommandDescriptor(command),
    ...(executionTrace ? { execution_trace: executionTrace } : {}),
    ...(plannerOutput ? { planner_output: plannerOutput } : {}),
    diff: {
      available: false,
      reason: "OperationDiff is not recorded for this execution yet",
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE"],
    },
    rollback: {
      available: false,
      reason: "Rollback plan is not recorded for this execution yet",
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE"],
    },
    operation_core: {
      role: "execution_result_projection",
      used_for_authority: false,
      adapter_result_used_for_authority: false,
      raw_payload_exposed: false,
      evidence_source: ["INTERNAL_STATE"],
    },
  };
}

function projectOperationCorePlannerExecutionProjection(
  value: unknown,
): OperationCorePlannerExecutionProjection | undefined {
  const parsed = OperationCorePlannerExecutionProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function projectOperationCoreExecutorTrace(value: unknown): unknown | undefined {
  const parsed = OperationCoreExecutorTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function projectOperationCoreCommandDescriptor(command: Record<string, unknown>): Record<string, unknown> {
  const constraints = isRecord(command.constraints) ? command.constraints : {};
  const payload = isRecord(command.payload) ? command.payload : {};
  return {
    type: stringValue(command.type) ?? "unknown",
    operation: stringValue(command.operation) ?? "unknown",
    upstream_decision: stringValue(command.upstream_decision) ?? "unknown",
    upstream_commit_hash: stringValue(command.upstream_commit_hash) ?? "unknown",
    constraints: {
      max_tokens: numberValueOrNull(constraints.max_tokens),
      timeout_ms: numberValueOrNull(constraints.timeout_ms),
      allowed_tools: stringArray(constraints.allowed_tools),
      allowed_capabilities: stringArray(constraints.allowed_capabilities),
    },
    payload: {
      tool_name: stringValue(payload.tool_name),
      argument_keys: stringArray(payload.argument_keys),
      arguments_digest: stringValue(payload.arguments_digest),
      messages_count: numberValueOrNull(payload.messages_count),
      message_roles: stringArray(payload.message_roles),
      messages_digest: stringValue(payload.messages_digest),
      backend_hint: stringValue(payload.backend_hint),
      model: stringValue(payload.model),
      channel: stringValue(payload.channel),
      target_digest: stringValue(payload.target_digest),
      content_digest: stringValue(payload.content_digest),
      content_chars: numberValueOrNull(payload.content_chars),
    },
  };
}

export function projectApprovalGrant(grant: ApprovalGrant): WebChatApprovalGrantItem {
  return {
    id: grant.id,
    mode: grant.mode,
    decision: grant.decision,
    operation: grant.operation,
    target_scope: grant.target_scope,
    target: grant.target,
    path_pattern: grant.path_pattern,
    channel: grant.channel,
    risk: grant.risk,
    actor: grant.actor,
    created_by: grant.created_by,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    revocable: grant.revocable,
    note: grant.note,
  };
}

export function projectApprovalHistoryEntry(entry: CompleteHistoryEntry): WebChatApprovalHistoryItem {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  const operationCore = projectOperationCoreApprovalTrace(payload.operation_core);
  return {
    index: entry.index,
    event: stringValue(payload.event) ?? "approval_history",
    request_id: entry.request_id,
    command_id: entry.command_id,
    grant_id: stringValue(payload.grant_id),
    actor: entry.actor,
    decision: stringValue(payload.decision) ?? null,
    operation: stringValue(payload.operation) ?? null,
    risk: stringValue(payload.risk) ?? null,
    approval_level: stringValue(payload.approval_level) ?? null,
    final_review_required:
      typeof payload.final_review_required === "boolean"
        ? payload.final_review_required
        : undefined,
    reason: stringValue(payload.reason) ?? null,
    timestamp: entry.timestamp,
    payload_digest: entry.payload_digest,
    used_for_authority: false,
    ...(operationCore ? { operation_core: operationCore } : {}),
  };
}

function projectOperationCoreApprovalTrace(value: unknown): OperationCoreApprovalTrace | undefined {
  const parsed = OperationCoreApprovalTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function humanizeDecision(
  decision: "ASSERT" | "SUSPEND" | "OUT_OF_SCOPE" | "FAIL",
  reason: string,
  request_id: string,
  approval_token?: string,
): string {
  switch (decision) {
    case "SUSPEND":
      return `[suspended] Awaiting human review. reason=${reason} request_id=${request_id}${
        approval_token ? ` approval_token=${approval_token}` : ""
      }`;
    case "OUT_OF_SCOPE":
      return `[out-of-scope] Request not handled. reason=${reason}`;
    case "FAIL":
      return `[rejected] Request blocked by upstream policy. reason=${reason}`;
    case "ASSERT":
      return `[ok] reason=${reason}`;
  }
}

export function commandOperation(command: ExecuteCommand): string {
  if (command.type === "tool_call") return command.payload.tool_name;
  if (command.type === "llm_call") return "llm_call";
  if (command.type === "channel_send") return `channel_send:${command.payload.channel}`;
  return "noop";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberValueOrNull(value: unknown): number | null {
  return numberValue(value) ?? null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function digestString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown, inArray = false): unknown => {
    if (v === undefined) return inArray ? null : undefined;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item, true));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const normalized = normalize((v as Record<string, unknown>)[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}
