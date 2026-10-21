import { sha256Hex, stableJson } from "../complete-history/codec.js";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import type {
  CompleteHistoryEntry,
} from "../complete-history/index.js";
import {
  commandActionPattern,
  commandContextPattern,
  commandInputPattern,
  isConditionedFailurePatterns,
} from "./normalize.js";
import type {
  FailureExtractionInput,
  FailureScope,
  FailureSeverity,
  FailureSignatureInput,
  FailureType,
} from "./types.js";

export function extractFailureSignatures(input: FailureExtractionInput): FailureSignatureInput[] {
  if (input.kind === "complete_history") return extractFromCompleteHistory(input.entry);
  if (input.kind === "command_result") {
    if (input.feedback.status !== "failed") return [];
    const failureType = classifyFailure(input.feedback.error);
    return [signatureInput({
      scope: commandScope(input.command.type, input.command.type === "tool_call" ? input.command.payload.tool_name : undefined),
      failure_type: failureType,
      input_pattern: commandInputPattern(input.command),
      action_pattern: commandActionPattern(input.command),
      context_pattern: commandContextPattern(input.context),
      result_pattern: symptomDigest(input.feedback.error ?? "execution_failed"),
      unknowns: commandUnknowns(input.command, input.context),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: severityForError(input.feedback.error),
    })];
  }
  if (input.kind === "tool_result") {
    if (input.status !== "failed") return [];
    const failureType = classifyFailure(input.error);
    return [signatureInput({
      scope: "tool",
      failure_type: failureType,
      action_pattern: `sha256:${sha256Hex(input.tool_name)}`,
      result_pattern: symptomDigest(input.error ?? "failed"),
      unknowns: commonUnknowns(),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: severityForError(input.error),
    })];
  }
  if (input.kind === "test_result") {
    if (input.status !== "failed") return [];
    return [signatureInput({
      scope: "test",
      failure_type: "test_regression",
      action_pattern: `sha256:${sha256Hex(input.test_name)}`,
      result_pattern: symptomDigest(input.error ?? "test_failed"),
      unknowns: commonUnknowns(),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: "high",
    })];
  }
  if (input.kind === "workflow_result") {
    if (input.status !== "failed") return [];
    const failureType = classifyFailure(input.error);
    return [signatureInput({
      scope: "workflow",
      failure_type: failureType,
      action_pattern: `sha256:${sha256Hex(input.workflow)}`,
      result_pattern: symptomDigest(input.error ?? "workflow_failed"),
      unknowns: commonUnknowns(),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: severityForError(input.error),
    })];
  }
  if (input.kind === "llm_output_validation") {
    if (input.ok) return [];
    return [signatureInput({
      scope: "llm_output",
      failure_type: classifyLLMFailure(input.error),
      action_pattern: `sha256:${sha256Hex(input.validator)}`,
      result_pattern: symptomDigest(input.error ?? "llm_output_validation_failed"),
      unknowns: commonUnknowns(),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: "medium",
      match_level: 3,
    })];
  }
  if (input.kind === "authority_boundary") {
    if (!boundaryFailure(input.reason, input.decision)) return [];
    return [signatureInput({
      scope: input.reason.includes("gateway") ? "boundary" : "authority",
      failure_type: "boundary_violation",
      action_pattern: `sha256:${sha256Hex(input.decision)}`,
      result_pattern: symptomDigest(input.reason),
      unknowns: commonUnknowns(),
      evidence_log_ids: input.evidence_log_id ? [input.evidence_log_id] : [],
      severity: "critical",
      confidence: 0.95,
      match_level: 1,
    })];
  }
  return [];
}

export function extractFromCompleteHistory(entry: CompleteHistoryEntry): FailureSignatureInput[] {
  if (entry.kind === "execution_history") {
    const payload = asRecord(entry.payload);
    if (payload.status !== "failed") return [];
    const command = asRecord(payload.command);
    const operation = stringValue(command.operation) || stringValue(command.type) || "unknown_command";
    const commandType = stringValue(command.type);
    const error = stringValue(payload.error) || "execution_failed";
    const failureType = classifyFailure(error);
    const conditioned = command.failure_patterns;
    const hasConditionedPatterns = isConditionedFailurePatterns(conditioned);
    const safeActionPattern = hasConditionedPatterns
      ? conditioned.action_pattern
      : stableJson({ pattern_version: "failure-legacy-action-digest-v1", descriptor_digest: `sha256:${sha256Hex(command)}` });
    const safeInputPattern = hasConditionedPatterns
      ? conditioned.input_pattern
      : stableJson({ pattern_version: "failure-legacy-input-unavailable-v1" });
    return [signatureInput({
      scope: commandScope(commandType, operation),
      failure_type: failureType,
      input_pattern: safeInputPattern,
      action_pattern: safeActionPattern,
      context_pattern: commandContextPattern({ actor: entry.actor, channel: payload.origin_channel }),
      result_pattern: symptomDigest(error),
      unknowns: [
        ...commonUnknowns(),
        ...(hasConditionedPatterns ? [] : ["legacy_history_missing_conditioned_patterns"]),
      ],
      evidence_log_ids: [entry.id],
      severity: severityForError(error),
    })];
  }
  if (entry.kind === "hds_decision") {
    const payload = asRecord(entry.payload);
    const decision = stringValue(payload.decision);
    const reason = stringValue(payload.reason);
    if (!boundaryFailure(reason, decision) && decision !== "FAIL") return [];
    return [signatureInput({
      scope: reason.includes("boundary") ? "boundary" : "authority",
      failure_type: reason.includes("boundary") ? "boundary_violation" : "logic_drift",
      action_pattern: stableJson({
        decision_digest: `sha256:${sha256Hex(decision)}`,
        reason_digest: `sha256:${sha256Hex(reason)}`,
        command_present: payload.command !== null,
      }),
      context_pattern: commandContextPattern({ actor: payload.actor, channel: payload.channel }),
      result_pattern: symptomDigest(reason),
      unknowns: commonUnknowns(),
      evidence_log_ids: [entry.id],
      severity: reason.includes("boundary") ? "critical" : "high",
      confidence: reason.includes("boundary") ? 0.95 : 0.8,
      match_level: reason.includes("boundary") ? 1 : 2,
    })];
  }
  if (entry.kind === "approval_history") {
    const payload = asRecord(entry.payload);
    const event = stringValue(payload.event);
    const reason = stringValue(payload.reason);
    if (!event.includes("rejected") && !event.includes("denied") && !reason.includes("manual_correction")) return [];
    return [signatureInput({
      scope: "workflow",
      failure_type: reason.includes("manual_correction") ? "repeated_manual_correction" : classifyFailure(reason),
      action_pattern: `sha256:${sha256Hex(payload.command ?? {})}`,
      context_pattern: commandContextPattern({ actor: entry.actor, channel: payload.origin_channel }),
      result_pattern: symptomDigest(reason || event),
      unknowns: commonUnknowns(),
      evidence_log_ids: [entry.id],
      severity: event.includes("denied") ? "high" : "medium",
      match_level: 1,
    })];
  }
  if (entry.kind === "final_output") {
    const payload = asRecord(entry.payload);
    const releaseDecision = stringValue(payload.release_decision);
    const reason = stringValue(payload.reason);
    if (releaseDecision !== "block" && releaseDecision !== "hold") return [];
    return [signatureInput({
      scope: "llm_output",
      failure_type: classifyLLMFailure(reason),
      action_pattern: stableJson({
        command_type_digest: `sha256:${sha256Hex(payload.command_type)}`,
        output_kind_digest: `sha256:${sha256Hex(payload.output_kind)}`,
      }),
      result_pattern: symptomDigest(reason || releaseDecision),
      unknowns: commonUnknowns(),
      evidence_log_ids: [entry.id],
      severity: releaseDecision === "block" ? "high" : "medium",
      match_level: 3,
    })];
  }
  return [];
}

function signatureInput(input: {
  scope: FailureScope;
  failure_type: FailureType;
  action_pattern: string;
  input_pattern?: string;
  result_pattern?: string;
  context_pattern?: string;
  predicted_difference_digest?: string;
  unknowns?: readonly string[];
  evidence_log_ids?: readonly string[];
  severity?: FailureSeverity;
  confidence?: number;
  match_level?: FailureSignatureInput["match_level"];
}): FailureSignatureInput {
  return {
    scope: input.scope,
    failure_type: input.failure_type,
    input_pattern: input.input_pattern ?? input.action_pattern,
    action_pattern: input.action_pattern,
    context_pattern: input.context_pattern ?? "{}",
    predicted_difference_digest: input.predicted_difference_digest,
    result_pattern: input.result_pattern,
    unknowns: input.unknowns,
    evidence_log_ids: input.evidence_log_ids ?? [],
    confidence: input.confidence ?? 0.65,
    severity: input.severity ?? "medium",
    state: "shadow",
    match_level: input.match_level ?? 1,
  };
}

function symptomDigest(symptom: string): string {
  return `sha256:${sha256Hex(symptom)}`;
}

function commonUnknowns(): string[] {
  return ["root_cause_unconfirmed", "predicted_difference_not_observed"];
}

function commandUnknowns(command: ExecuteCommand, context: Record<string, unknown> = {}): string[] {
  return [
    ...commonUnknowns(),
    ...(command.upstream_decision.frame_goal.trim() ? [] : ["goal_not_available"]),
    ...(typeof context.actor === "string" || typeof context.origin_user === "string" ? [] : ["actor_not_available"]),
    ...(typeof context.channel === "string" ? [] : ["channel_not_available"]),
  ];
}

function commandScope(commandType: string, operation?: string): FailureScope {
  if (commandType === "llm_call") return "llm_output";
  if (commandType === "channel_send") return "workflow";
  if (operation?.startsWith("file.")) return "file";
  if (operation?.includes("test")) return "test";
  if (commandType === "tool_call") return "tool";
  return "command";
}

function classifyFailure(error: string | undefined): FailureType {
  const text = (error ?? "").toLowerCase();
  if (text.includes("boundary") || text.includes("forbidden") || text.includes("dangerous")) return "boundary_violation";
  if (text.includes("permission") || text.includes("eacces") || text.includes("denied") || text.includes("not allowed")) return "permission_error";
  if (text.includes("enoent") || text.includes("not found") || text.includes("not registered") || text.includes("bad command")) return "bad_command";
  if (text.includes("expected") || text.includes("assert") || text.includes("test failed") || text.includes("regression")) return "test_regression";
  if (text.includes("timeout") || text.includes("network") || text.includes("econn") || text.includes("environment")) return "environment_error";
  if (text.includes("wrong file") || text.includes("wrong_file")) return "wrong_file";
  if (text.includes("manual correction")) return "repeated_manual_correction";
  if (text.includes("warning")) return "unresolved_warning";
  if (text.includes("no progress")) return "no_progress";
  return "repeat_error";
}

function classifyLLMFailure(error: string | undefined): FailureType {
  const text = (error ?? "").toLowerCase();
  if (text.includes("hallucinat") || text.includes("invented")) return "hallucination";
  if (text.includes("drift")) return "logic_drift";
  return "hallucination";
}

function severityForError(error: string | undefined): FailureSeverity {
  const type = classifyFailure(error);
  if (type === "boundary_violation") return "critical";
  if (type === "permission_error" || type === "test_regression" || type === "wrong_file") return "high";
  if (type === "environment_error" || type === "bad_command") return "medium";
  return "medium";
}

function boundaryFailure(reason: string, decision: string): boolean {
  const text = `${reason} ${decision}`.toLowerCase();
  return text.includes("boundary") || text.includes("suspend") || text.includes("fail");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
