import { randomUUID } from "node:crypto";
import type { ExecuteCommand, ExecuteFeedback, InboundRequest } from "@blue-tanuki/protocol";
import { normalizeInboundRequestForAuthority } from "@blue-tanuki/protocol";
import {
  DocumentOrganizationCoordinator,
  HDSUpperController,
  type DecisionLog,
  type DocumentOrganizationProjection,
  type OutputTargetSurface,
} from "@blue-tanuki/hds-brain";
import {
  Executor,
  type ExecutorApprovalAuthority,
} from "@blue-tanuki/core";
import type { FailureMemoryStore } from "@blue-tanuki/hds-brain";
import type { ApprovalRuntime } from "./approval_runtime.js";
import { approvalDeniedFeedback } from "./approval_runtime.js";
import { renderDocumentOrganizationProjection } from "@blue-tanuki/hds-brain";

export interface DocumentOrganizationTaskInput {
  readonly coordinator: DocumentOrganizationCoordinator;
  readonly origin: InboundRequest;
  readonly hds: HDSUpperController;
  readonly executor: Executor;
  readonly executorApproval: ExecutorApprovalAuthority;
  readonly approval: ApprovalRuntime;
  readonly failureMemory: FailureMemoryStore;
  readonly target_surface: OutputTargetSurface;
  readonly first_decision: { readonly log: DecisionLog; readonly command: ExecuteCommand | null };
  readonly emergency_stop_active?: boolean;
}

export interface DocumentOrganizationTaskResult {
  readonly projection: DocumentOrganizationProjection;
  readonly rendered_output: string;
  readonly output_audit: ReturnType<HDSUpperController["onOutputAudit"]>;
  readonly command_id: string;
  readonly upstream_commit_hash: string;
  readonly status: "completed" | "held";
}

/** A task is explicitly selected by an owner-facing local entry. */
export function documentOrganizationSourceFromRequest(request: InboundRequest): string | null {
  if (request.channel !== "cli" && request.channel !== "webchat") return null;
  const match = /^\/organize(?:\r?\n|[ \t]+)([\s\S]*)$/u.exec(request.content);
  if (!match) return null;
  return match[1] ?? "";
}

export function createDocumentOrganizationCoordinator(
  request: Pick<InboundRequest, "id">,
  source_text: string,
): DocumentOrganizationCoordinator {
  return new DocumentOrganizationCoordinator({
    task_id: `document-organization:${request.id}`,
    request_id: request.id,
    source_text,
  });
}

/**
 * Run each C call as a fresh HDS decision and only execute an LLM command.
 * J validates the provider content before it can update the display projection.
 */
export async function runDocumentOrganizationTask(
  input: DocumentOrganizationTaskInput,
): Promise<DocumentOrganizationTaskResult | null> {
  let decision = input.first_decision;
  let lastCommand: ExecuteCommand | null = null;
  let lastFeedback: ExecuteFeedback | null = null;
  let projection = input.coordinator.snapshot();

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const { log, command } = decision;
    if (!command) {
      if (!lastCommand || !lastFeedback) return null;
      projection = input.coordinator.rejectCycle("j_decision_no_command");
      break;
    }
    lastCommand = command;

    if (input.emergency_stop_active) {
      input.hds.onAuthorityEvent("emergency_stop_blocked", {
        request_id: log.request_id,
        command_id: command.id,
        actor: input.origin.user,
        reason: "document_organization_cycle_emergency_stop_active",
      });
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: "emergency_stop_active",
      });
      lastFeedback = approvalDeniedFeedback(command, "emergency_stop_active");
      projection = input.coordinator.rejectCycle("emergency_stop_active");
      break;
    }

    if (command.type !== "llm_call") {
      input.hds.onCommandLifecycle(command.id, "approval_rejected", {
        actor: input.origin.user,
        reason: "document_organization_allows_llm_call_only",
      });
      lastFeedback = approvalDeniedFeedback(command, "document_organization_allows_llm_call_only");
      projection = input.coordinator.rejectCycle("unsupported_command_type");
      break;
    }

    const failureGate = input.failureMemory.evaluateCommandGate(command, {
      actor: input.origin.user,
      channel: input.origin.channel,
      request_id: log.request_id,
      surface: input.target_surface === "cli" ? "cli" : "webchat",
    });
    if (failureGate.decision !== "allow") {
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: `failure_memory:${failureGate.reason}`,
      });
      lastFeedback = approvalDeniedFeedback(command, `failure_memory:${failureGate.reason}`);
      projection = input.coordinator.rejectCycle(
        failureGate.decision === "block" ? "failure_memory_blocked" : "failure_memory_requires_approval",
      );
      break;
    }

    const evaluation = input.approval.evaluate(command, input.origin.user);
    input.hds.onApprovalEvaluation(evaluation, { request_id: log.request_id });
    if (evaluation.decision !== "allow") {
      input.hds.onCommandLifecycle(command.id, "approval_cancelled", {
        actor: input.origin.user,
        reason: evaluation.decision === "deny" ? evaluation.reason : "human_approval_required",
      });
      lastFeedback = approvalDeniedFeedback(command, evaluation.reason);
      projection = input.coordinator.rejectCycle(
        evaluation.decision === "deny" ? "approval_denied" : "approval_required",
      );
      break;
    }

    input.hds.onCommandLifecycle(command.id, "approval_approved", {
      actor: input.origin.user,
      reason: evaluation.reason,
    });
    const approvedCommand = input.executorApproval.approve(command, {
      source: "approval_gate",
      decision: "allow",
      approved_by: input.origin.user,
      approved_at_ms: Date.now(),
      upstream_commit_hash: command.upstream_decision.commit_hash,
      operation: evaluation.context.operation,
      risk: evaluation.risk,
      final_review_required: evaluation.final_review_required,
      reason: evaluation.reason,
    });
    const feedback = await input.executor.execute(approvedCommand);
    lastFeedback = feedback;
    const reviewedFeedback = input.hds.reviewMemoryCitations(command, feedback);
    input.hds.onFeedback(feedback);

    if (feedback.status !== "success") {
      projection = input.coordinator.rejectCycle("c_compute_failed");
      break;
    }
    const content = resultContent(reviewedFeedback.result);
    projection = content === null
      ? input.coordinator.rejectCycle("c_output_missing")
      : input.coordinator.applyComputeOutput(content);
    if (projection.status !== "continuing") break;

    const nextRequest = normalizeInboundRequestForAuthority({
      id: randomUUID(),
      channel: input.origin.channel,
      user: input.origin.user,
      content: input.coordinator.buildComputePrompt(),
      timestamp: Date.now(),
      ...(input.origin.goal_criteria ? { goal_criteria: input.origin.goal_criteria } : {}),
    });
    decision = input.hds.decide(nextRequest, {
      transient_content: "document_organization",
    });
  }

  if (!lastCommand || !lastFeedback) return null;
  projection = input.coordinator.snapshot();
  const rendered_output = renderDocumentOrganizationProjection(projection);
  const output_audit = input.hds.onOutputAudit({
    command: lastCommand,
    feedback: lastFeedback,
    rendered_output,
    target_surface: input.target_surface,
    request_id: input.origin.id,
  });
  return {
    projection,
    rendered_output,
    output_audit,
    command_id: lastCommand.id,
    upstream_commit_hash: lastCommand.upstream_decision.commit_hash,
    status: projection.status === "completed" ? "completed" : "held",
  };
}

function resultContent(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = (value as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}
