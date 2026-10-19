import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  GoalGovernanceAuthorization,
  GoalGovernanceEvent,
  GoalGovernanceConfig,
  InboundRequest,
  ExecuteCommand,
  ExecuteFeedback,
  GatewayInternalAuthorityMetadata,
  UpstreamDecision,
  LLMCallPayload,
  LLMToolCallCandidate,
  LLMFallbackAuthorization,
  ExecutionAdmission, ExecutionResultDelivery,
} from "@blue-tanuki/protocol";
import {
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  parseInboundRequestAtBoundary,
  LLMCallFailureSchema,
  LLMToolCallCandidateSchema,
  parseMeaningUpdateProposal,
  SkepticalReviewRequestSchema,
  LLMFallbackAuthorizationSchema,
  inspectOperationCommandExecutionResult,
  OperationPlanExternalReceiptObservationSchema,
  FileSearchTargetVersionObservationSchema,
  OperationPlanControlSchema,
  type OperationPlanControl,
  getOperationDescriptor,
  OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION,
  FAILURE_REVIEW_LOCAL_P_VERSION,
  FailureReviewProjectionSchema,
  type FailureReviewProjection,
} from "@blue-tanuki/protocol";
import { OperationPlanLedger, operationPlanDigest, type OperationPlanStatePort, type OperationPlanMemoryStorage,
  type OperationPlanRecoveryEvidence, type OperationPlanReceiptReconciliationAuthorization,
  type OperationPlanCanonicalMemoryRestoreObservation } from "./operation_plan.js";
import { reviewResultReflection, type ResultObservationProjection } from "./operation_result_reflection.js";
import type {
  ApprovalGateLog,
  AuthorityEventLog,
  CommandLifecycleLog,
  CommandLifecyclePhase,
  ControllerState,
  DecisionLog,
  FailureReviewAuditTrace,
  ModelResult,
  MemoryReferenceLog,
  PolicyConfig,
  ResumeAuditTrace,
  ResumeVerdict,
  RuntimeInvariantsLog,
  ScheduleLifecycleEvent,
  ScheduleLifecycleLog,
  SuspendedRequest,
  LLMToolCandidateAssessment,
  AuditRecord,
} from "./types.js";
import { frame } from "./frame.js";
import { buildGoalRelationTreeView, type ReadonlyGoalRelationTreeView } from "./goal_relations.js";
import { GoalGovernanceLedger, goalGovernanceEventDigest, type ReadonlyGoalGovernanceProjection } from "./goal_governance.js";
import { goalPurposeChangeApprovalTarget } from "./approval_policy.js";
import { model } from "./model.js";
import { commit } from "./commit.js";
import { AuditLog, type AuditEntry } from "./audit.js";
import { normalizeForDetection } from "./normalization.js";
import {
  DetectorRegistry,
  createDefaultDetectorRegistry,
} from "./detectors/index.js";
import { DEFAULT_POLICY, determineCandidateAdoptionDisposition, validatePolicy } from "./policy.js";
import { assessCandidateGoalCriteria } from "./candidate_criteria.js";
import { assessSkepticalReview, invalidSkepticalReviewTrace } from "./skeptical_review.js";
import {
  assessFailureReviewCandidate,
  failureReviewProjectionDigest,
  failureReviewResultContent,
  invalidFailureReviewTrace,
  parseFailureReviewCandidate,
} from "./failure-memory/review.js";
import { routeAction } from "./action_router.js";
import { resolveActor } from "./process.js";
import type { ApprovalEvaluation } from "./approval_policy.js";
import {
  buildProjectionOutputAuditLog,
  buildOutputAuditLog,
  type OutputAuditInput,
  type OutputAuditLog,
  type ProjectionOutputAuditLog,
} from "./output_audit.js";
import {
  buildRuntimeInvariantEvidence,
  type RuntimeInvariantEvidenceOptions,
  type RuntimeInvariantEvidenceReport,
  type RuntimeInvariantKey,
  type RuntimeInvariantValues,
} from "./runtime_invariants.js";
import { fReferenceForId } from "./f_reference.js";
import {
  DOCUMENT_ORGANIZATION_PROMPT_PREFIX,
  type DocumentOrganizationMemoryVersion,
  type DocumentOrganizationProjection,
} from "./document_organization.js";
import type { MemoryStoreStateVersion } from "./long-term-memory/types.js";
import {
  buildMemoryCitationSystemMessages,
  redactUnverifiedReferences,
  reviewMeaningUpdateProposalReferences,
  reviewMemoryCitationOutput,
} from "./memory_citation_review.js";
import {
  evaluateHDSBrainHealth,
  type HDSBrainHealth,
  type RuntimeDependencyCheck,
  type RuntimePathCheck,
} from "./health.js";
import {
  commandExecutionPolicyViolation,
  processAuthorityViolation,
  securityCommit,
  sha256,
  suspendCommit,
  trustedChannelSendFromMetadata,
} from "./controller_security.js";

interface LongTermMemoryPort {
  capture(log: DecisionLog): unknown;
  recent(n: number): readonly unknown[];
  all?: () => readonly unknown[];
  size?: () => number;
  verify?: () => boolean;
  stateVersion?: () => MemoryStoreStateVersion;
}

export interface HDSDecisionOptions {
  /** Prevent transient document-organization input from reading/writing memory or persisting session history. */
  readonly transient_content?: "document_organization";
}

interface CapturedMemoryReference {
  request_id: string;
  f_reference?: string;
  entry_hash: string;
}

export interface HDSRuntimeSnapshot {
  state: ControllerState;
  suspended: readonly SuspendedRequest[];
  inflight: Array<{ command_id: string; request_id: string; commit_hash: string; decision: string }>;
  audit: { entries: number; chain_valid: boolean };
  memory: { configured: boolean; entries?: number; chain_valid?: boolean };
  invariants: RuntimeInvariantValues;
  runtime_invariants: RuntimeInvariantEvidenceReport;
  operation_plans: ReturnType<OperationPlanLedger["projection"]>;
}

/** An in-process, non-serializable provenance seal for one exact HDS-issued command. */
export interface HDSExecutionAuthorityBinding {
  readonly schema_version: "blue-tanuki.hds-execution-authority-binding.v3";
  readonly source_context_digest: string;
  readonly operation_plan_binding_digest?: string;
  readonly broker_target_version_observation_digest?: string;
  readonly goal_governance_projection_digest?: string;
  readonly goal_governance_used_for_authority?: false;
}

interface HDSExecutionAuthorityBindingRecord {
  readonly command: ExecuteCommand;
  readonly source_context_digest: string;
  readonly operation_plan_binding_digest?: string;
  readonly broker_target_version_observation_digest?: string;
  readonly goal_governance_projection_digest?: string;
  readonly goal_governance_used_for_authority?: false;
  consumed: boolean;
}

const HDS_EXECUTION_AUTHORITY_BINDINGS = new WeakMap<object, HDSExecutionAuthorityBindingRecord>();

/**
 * Consume the private seal once. Copying its public digest cannot recreate the
 * HDS issuer record or its binding to the exact command object.
 */
export function consumeHdsExecutionAuthorityBinding(
  command: ExecuteCommand,
  binding: HDSExecutionAuthorityBinding,
): string {
  const record = HDS_EXECUTION_AUTHORITY_BINDINGS.get(binding as object);
  if (!record || record.command !== command || record.consumed ||
      binding.schema_version !== "blue-tanuki.hds-execution-authority-binding.v3" ||
      binding.source_context_digest !== record.source_context_digest ||
      binding.operation_plan_binding_digest !== record.operation_plan_binding_digest ||
      binding.broker_target_version_observation_digest !== record.broker_target_version_observation_digest ||
      binding.goal_governance_projection_digest !== record.goal_governance_projection_digest ||
      binding.goal_governance_used_for_authority !== record.goal_governance_used_for_authority) {
    throw new Error("HDS execution authority binding is invalid, copied, or already consumed");
  }
  record.consumed = true;
  return record.source_context_digest;
}

/**
 * HDSUpperController — Phase 1.
 *
 * Receives inbound requests, runs F→M→C, produces commands for downstream,
 * consumes feedback, maintains audit chain, and manages the SUSPEND/RESUME
 * state machine.
 *
 * Critical invariants:
 *   1. This class NEVER calls an LLM. All LLM/tool/channel actions are
 *      emitted as commands and executed by BLUE-TANUKI core.
 *   2. RESUME is HUMAN-ONLY in Phase 1. There is no executor-feedback path
 *      that can lift a SUSPEND. This preserves the upstream containment
 *      property: a misbehaving downstream cannot escalate its own privileges.
 */
export interface ControllerOptions {
  policy?: PolicyConfig;
  detectors?: DetectorRegistry;
  audit?: AuditLog;
  memory?: LongTermMemoryPort;
  llm_route?: LLMCommandRoute;
  self_health?: ControllerSelfHealthOptions;
  /** Owner-supplied relationship references; audit/display only, never authority. */
  goal_relation_graph?: unknown;
  /** Trusted HDS construction input; exact event-to-authorization digests are checked at creation. */
  goal_governance?: GoalGovernanceConfig;
  operation_plan_state?: OperationPlanStatePort;
  operation_plan_memory?: OperationPlanMemoryStorage;
  /** Verified startup evidence can only hold existing plan selection; it never grants or resumes authority. */
  operation_plan_recovery_evidence?: OperationPlanRecoveryEvidence;
}

export interface LLMCommandRoute {
  backend_hint?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  /** Owner-supplied HDS grant. Omission prevents alternate-provider fallback. */
  fallback_authorization?: LLMFallbackAuthorization;
}

export interface ControllerSelfHealthOptions {
  hds_available?: boolean;
  policy_valid?: boolean;
  approval_gate_available?: boolean;
  runtime_invariants?: RuntimeInvariantEvidenceReport;
  required_directories?: readonly RuntimePathCheck[];
  storage_paths?: readonly RuntimePathCheck[];
  optional_dependencies?: readonly RuntimeDependencyCheck[];
  audit_appendable?: import("./health.js").AuditAppendabilityStatus;
}

const STANDALONE_SELF_HEALTH_DEFAULTS: Required<
  Pick<ControllerSelfHealthOptions, "required_directories" | "storage_paths" | "optional_dependencies" | "audit_appendable">
> = {
  required_directories: [],
  storage_paths: [],
  optional_dependencies: [],
  audit_appendable: "memory_only",
};

export interface ResumeAuditOptions {
  actor?: string;
  token_kind?: ResumeAuditTrace["token_kind"];
}

type GoalPurposeChangeEvent = Extract<GoalGovernanceEvent, { event_kind: "purpose_change" }>;
type GoalPurposeChangeCommitLog = AuthorityEventLog & {
  event: "goal_purpose_change_committed";
  proposal_actor: string;
  goal_governance_event: GoalPurposeChangeEvent;
  goal_governance_authorization: GoalGovernanceAuthorization;
};

type GoalPurposeChangeCommitResult =
  | { readonly ok: true; readonly event_ref: string; readonly goal_ref: string; readonly version: number; readonly purpose_digest: string; readonly effective_from: number }
  | { readonly ok: false; readonly reason: "goal_governance_unavailable" | "audit_not_persistent" | "audit_invalid" | "approval_not_verified" | "purpose_version_conflict" | "event_invalid" | "audit_append_failed" };

function goalPurposeChangeReviewTarget(input: {
  goal_ref: string;
  prior_version: number;
  prior_purpose_digest: string;
  new_purpose_digest: string;
}): string {
  return goalPurposeChangeApprovalTarget(input);
}

function isGoalPurposeChangeCommitLog(log: AuditRecord): log is GoalPurposeChangeCommitLog {
  return isGoalPurposeChangeCommitMarker(log) &&
    typeof log.proposal_actor === "string" && log.proposal_actor.trim().length > 0 &&
    log.goal_governance_event?.event_kind === "purpose_change" &&
    log.goal_governance_authorization !== undefined;
}

function isGoalPurposeChangeCommitMarker(log: AuditRecord): log is AuthorityEventLog {
  return "kind" in log && log.kind === "authority_event" && log.event === "goal_purpose_change_committed";
}

function goalPurposeChangeApprovalEvidence(
  entries: readonly AuditEntry[],
  input: {
    request_id: string;
    command_id: string;
    proposal_actor: string;
    reviewer_actor: string;
    target: string;
    before_index?: number;
  },
): { readonly timestamp: number; readonly evaluation: ApprovalEvaluation } | null {
  const asks = entries.filter(({ index, log }) => index < (input.before_index ?? Number.POSITIVE_INFINITY) &&
    "kind" in log && log.kind === "approval_gate" && log.request_id === input.request_id &&
    log.command_id === input.command_id && log.evaluation.decision === "ask" &&
    log.evaluation.context.operation === "tool.call" && log.evaluation.context.command_id === input.command_id &&
    log.evaluation.context.actor === input.proposal_actor && log.evaluation.context.target === input.target && log.evaluation.risk === "high" &&
    log.evaluation.approval_level === "L3_final_review" && log.evaluation.final_review_required);
  const approvals = entries.filter(({ index, log }) => index < (input.before_index ?? Number.POSITIVE_INFINITY) &&
    "kind" in log && log.kind === "command_lifecycle" && log.request_id === input.request_id &&
    log.command_id === input.command_id && log.phase === "approval_approved" &&
    log.actor === input.reviewer_actor && log.reason === "human_approval:approve");
  const ask = asks[0];
  const approved = approvals.find(({ index }) => !ask || index > ask.index);
  const askLog = ask && "kind" in ask.log && ask.log.kind === "approval_gate" ? ask.log : null;
  return askLog && approved ? { timestamp: approved.log.timestamp, evaluation: askLog.evaluation } : null;
}

function replayGoalPurposeChanges(audit: AuditLog, initial: GoalGovernanceLedger): GoalGovernanceLedger {
  let ledger = initial;
  const entries = audit.list();
  for (const { index, log } of entries) {
    if (!isGoalPurposeChangeCommitMarker(log)) continue;
    if (!isGoalPurposeChangeCommitLog(log)) throw new Error("persisted goal purpose change record is malformed");
    const event = log.goal_governance_event;
    const authorization = log.goal_governance_authorization;
    const target = goalPurposeChangeReviewTarget({
      goal_ref: event.goal_ref,
      prior_version: event.prior_version,
      prior_purpose_digest: event.prior_purpose_digest,
      new_purpose_digest: event.new_purpose_digest,
    });
    const approvalEvidence = log.request_id && log.command_id
      ? goalPurposeChangeApprovalEvidence(entries, {
        request_id: log.request_id,
        command_id: log.command_id,
        proposal_actor: log.proposal_actor,
        reviewer_actor: log.actor,
        target,
        before_index: index,
      })
      : null;
    if (approvalEvidence === null || event.authority_kind !== "owner" || event.recorded_at !== approvalEvidence.timestamp ||
        authorization.authority_kind !== "owner" || authorization.authorized_at !== approvalEvidence.timestamp ||
        authorization.event_digest !== goalGovernanceEventDigest(event)) {
      throw new Error("persisted goal purpose change lacks a matching L3 approval record");
    }
    const appended = ledger.appendAuthorizedEvent(event, authorization);
    if (!appended.ok) throw new Error("persisted goal purpose change does not extend the current J ledger");
    ledger = appended.ledger;
  }
  return ledger;
}

export class HDSUpperController {
  private state: ControllerState = "IDLE";
  private readonly audit: AuditLog;
  private readonly policy: PolicyConfig;
  private readonly detectors: DetectorRegistry;
  private readonly memory?: LongTermMemoryPort;
  private readonly llm_route: LLMCommandRoute;
  private readonly self_health: ControllerSelfHealthOptions;
  private readonly goal_relation_tree?: ReadonlyGoalRelationTreeView;
  private goal_governance?: GoalGovernanceLedger;
  private readonly operationPlans: OperationPlanLedger;
  private readonly issuedLLM = new Map<string, {
    command: ExecuteCommand;
    origin: InboundRequest;
    failure_review_projection?: FailureReviewProjection;
  }>();
  /** Exact HDS-returned command object -> source log; never serialized. */
  private readonly issuedExecutionCommands = new WeakMap<ExecuteCommand, DecisionLog>();

  /** Commands awaiting executor feedback (already ASSERTed). */
  private readonly inflight = new Map<string, DecisionLog>();

  /** Requests halted by SUSPEND, awaiting human verdict via resume(). */
  private readonly suspended = new Map<string, SuspendedRequest>();

  /** Cached original requests for suspended ones, so resume() can re-emit. */
  private readonly suspendedRequests = new Map<string, InboundRequest>();

  constructor(opts: ControllerOptions = {}) {
    this.operationPlans = new OperationPlanLedger(opts.operation_plan_state, opts.operation_plan_memory,
      opts.operation_plan_recovery_evidence);
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.detectors = opts.detectors ?? createDefaultDetectorRegistry();
    this.audit = opts.audit ?? new AuditLog();
    this.memory = opts.memory;
    const llmRoute = opts.llm_route ?? {};
    this.llm_route = {
      ...llmRoute,
      ...(llmRoute.fallback_authorization !== undefined
        ? { fallback_authorization: LLMFallbackAuthorizationSchema.parse(llmRoute.fallback_authorization) }
        : {}),
    };
    this.goal_relation_tree = opts.goal_relation_graph === undefined
      ? undefined
      : buildGoalRelationTreeView(opts.goal_relation_graph);
    if (opts.goal_governance !== undefined) {
      const built = GoalGovernanceLedger.create(opts.goal_governance);
      if (!built.ok) throw new Error("invalid goal governance configuration");
      if (!this.audit.verify()) throw new Error("goal governance requires a valid audit chain");
      this.goal_governance = replayGoalPurposeChanges(this.audit, built.ledger);
    } else if (this.audit.list().some(({ log }) => isGoalPurposeChangeCommitMarker(log))) {
      throw new Error("persisted goal purpose changes require a base goal governance ledger");
    }
    this.self_health = {
      ...STANDALONE_SELF_HEALTH_DEFAULTS,
      ...(opts.self_health ?? {}),
    };
  }

  /**
   * Run F→M→C on an inbound request.
   *   - ASSERT       → emit command (returned in `command`)
   *   - SUSPEND      → store as suspended; no command emitted
   *   - OUT_OF_SCOPE → audit only; no command
   *   - FAIL         → audit only; no command
   */
  decide(raw: unknown, options: HDSDecisionOptions = {}): {
    log: DecisionLog;
    command: ExecuteCommand | null;
  } {
    if (Object.keys(options).some((key) => key !== "transient_content") || (options.transient_content !== undefined && options.transient_content !== "document_organization")) {
      throw new Error("invalid HDS decision options");
    }
    const boundary = parseInboundRequestAtBoundary(raw);
    if (!boundary.ok) {
      const fallbackReq: InboundRequest = {
        id: "invalid-inbound-boundary",
        channel: "invalid",
        user: "unknown",
        content: "Invalid inbound request rejected at authority boundary",
        timestamp: Date.now(),
      };
      const input = normalizeForDetection(fallbackReq.content);
      const goalGovernanceProjection = this.goal_governance?.project(Date.now());
      const f = frame(fallbackReq, {
        default_policy: this.policy,
        memory_reader: this.memory,
        original_reference_kind: "synthetic_rejection_placeholder",
        ...(this.goal_relation_tree ? { goal_relation_tree: this.goal_relation_tree } : {}),
        ...(goalGovernanceProjection ? { goal_governance: goalGovernanceProjection } : {}),
      });
      const c = suspendCommit(
        "authority_input_boundary",
        boundary.reason,
        {
          request_id: fallbackReq.id,
          issue_count: boundary.issues.length,
        },
        ["authority_input_boundary:suspend", `authority_input_boundary:${boundary.reason}`],
      );
      const m: ModelResult = {
        abstraction: "authority_input_boundary:invalid",
        structure: {
          problem_definition_id: f.problem_definition_id,
          validation_failure: boundary.reason,
          issues: boundary.issues,
          raw_input_used_for_authority: false,
          canonical_frame_only: true,
        },
        scoring: {
          axis_scores: [
            {
              axis: "authority_input_boundary",
              score: 0,
              detector: "strict_inbound_request_schema",
              evidence: boundary.reason,
              lifecycle: {
                status: "ok",
                reason: "boundary_validation_failed_closed",
              },
            },
          ],
          weights: { authority_input_boundary: 1 },
          aggregate: 0,
        },
      };
      const log: DecisionLog = {
        request_id: fallbackReq.id,
        input,
        frame: f,
        model: m,
        commit: c,
        timestamp: Date.now(),
      };
      this.audit.append(log);
      this.state = "SUSPENDED";
      this.suspended.set(fallbackReq.id, {
        request_id: fallbackReq.id,
        log,
        suspended_at: Date.now(),
        reason: c.reason,
        fail_safe: true,
        resume_allowed: false,
      });
      this.suspendedRequests.set(fallbackReq.id, fallbackReq);
      return { log, command: null };
    }
    let req = boundary.request;
    let planControl: OperationPlanControl | undefined;
    let planControlFailure: string | undefined;
    let failureReviewControlFailure: string | undefined;
    let failureReviewProjection: FailureReviewProjection | undefined;
    let reflection: ResultObservationProjection | undefined;
    const controlCaller = req;
    const planPrefix = /^plan:([^\s]+)(?:\s+([\s\S]*))?$/i.exec(req.content.trim());
    if (planPrefix && planPrefix[1] !== "compute") {
      try {
        if (!isGatewayInternalInboundRequest(req) || req.metadata?.["blue_tanuki.operator_surface"] !== "developer" ||
            !["owner", "user"].includes(resolveActor(req).actor_kind)) {
          throw new Error("plan_control_requires_internal_developer");
        }
        planControl = OperationPlanControlSchema.parse({ ...JSON.parse(planPrefix[2] ?? "{}"), action: planPrefix[1] });
        if (planControl.action === "reflect") {
          if (!this.operationPlans.reconcileMemory()) throw new Error("plan_reflection_memory_unavailable");
          reflection = this.operationPlans.inspectReflection(planControl, req);
          req = createGatewayInternalInboundRequest({ ...req, content: `保存実観測の解釈候補を作る。
${planControl.question}`,
            metadata: { ...req.metadata, "blue_tanuki.authority_context": "gateway_internal_v1" } });
        } else if (planControl.action === "reconcile") {
          this.inspectOperationPlanReceiptReconciliationForControl(planControl, req);
          req = createGatewayInternalInboundRequest({ ...req, content: "plan:reconcile",
            metadata: { ...req.metadata, "blue_tanuki.authority_context": "gateway_internal_v1" } });
        } else {
        const selection = this.operationPlans.inspectControl(planControl, req);
        if (selection.step) {
          const descriptor = getOperationDescriptor(selection.step.operation)!;
          req = createGatewayInternalInboundRequest({ ...req,
            content: `${selection.goal}\n今回選択した作用候補: ${JSON.stringify({ operation: descriptor.operation_id, target: selection.step.target, parameters: selection.step.parameters })}`,
            metadata: { ...req.metadata, "blue_tanuki.authority_context": "gateway_internal_v1",
              "blue_tanuki.tool_call": { tool_name: descriptor.tool_name!, arguments: selection.step.parameters! } },
          });
        }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        planControlFailure = ["plan_control_requires_internal_developer", "plan_owner_or_identity_mismatch",
          "plan_revision_changed", "plan_step_identity_mismatch", "plan_step_already_selected_or_attempted", "plan_step_not_ready",
          "plan_recovery_residual_hold", "plan_recovery_unobserved_hold", "plan_recovery_unverified_hold",
          "plan_recovery_refresh_hold", "plan_memory_commit_pending",
          "plan_target_resolver_not_connected", "plan_revision_identity_changed", "plan_revision_unchanged",
          "plan_attempted_step_or_dependency_changed", "plan_reflection_memory_unavailable", "plan_reflection_step_identity_mismatch",
          "plan_reflection_observation_not_current", "plan_reflection_record_mismatch", "plan_reflection_observation_expired",
          "plan_reflection_summary_not_available", "plan_receipt_reconciliation_not_outcome_unknown",
          "plan_receipt_reconciliation_operation_unsupported", "plan_receipt_reconciliation_binding_invalid",
          "plan_receipt_reconciliation_capacity_reached", "plan_state_changed"]
          .includes(reason) ? reason : "plan_control_rejected";
      }
    } else if (/^plan:/i.test(req.content.trim()) && !planPrefix) {
      planControlFailure = "plan_control_invalid";
    }
    const failureReviewControlRequested = /^failure:review(?:\s|$)/i.test(controlCaller.content.trim());
    const failureReviewPrefix = /^failure:review\s+(\S+)$/i.exec(controlCaller.content.trim());
    if (failureReviewControlRequested) {
      try {
        if (!isGatewayInternalInboundRequest(req) || req.metadata?.["blue_tanuki.operator_surface"] !== "developer") {
          throw new Error("failure_review_requires_internal_developer");
        }
        if (!["owner", "user"].includes(resolveActor(req).actor_kind)) {
          throw new Error("failure_review_actor_not_allowed");
        }
        if (!failureReviewPrefix) throw new Error("failure_review_control_invalid");
        const metadata = req.metadata ?? {};
        if (metadata["blue_tanuki.failure_review.version"] !== "blue-tanuki.failure-review.v1" ||
            typeof metadata["blue_tanuki.failure_review.projection_json"] !== "string") {
          throw new Error("failure_review_projection_unavailable");
        }
        let rawProjection: unknown;
        try { rawProjection = JSON.parse(metadata["blue_tanuki.failure_review.projection_json"] as string) as unknown; }
        catch { throw new Error("failure_review_projection_invalid"); }
        const parsedProjection = FailureReviewProjectionSchema.safeParse(rawProjection);
        if (!parsedProjection.success) throw new Error("failure_review_projection_invalid");
        if (metadata["blue_tanuki.failure_review.signature_id"] !== parsedProjection.data.signature_id ||
            (failureReviewPrefix[1]!.toLowerCase() !== "latest" &&
              failureReviewPrefix[1] !== parsedProjection.data.signature_id)) {
          throw new Error("failure_review_signature_mismatch");
        }
        failureReviewProjection = parsedProjection.data;
        req = createGatewayInternalInboundRequest({
          ...req,
          content: "failure:review",
          metadata: { ...metadata, "blue_tanuki.authority_context": "gateway_internal_v1" },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        failureReviewControlFailure = [
          "failure_review_requires_internal_developer", "failure_review_actor_not_allowed",
          "failure_review_control_invalid", "failure_review_projection_unavailable",
          "failure_review_projection_invalid", "failure_review_signature_mismatch",
        ].includes(reason) ? reason : "failure_review_rejected";
        req = isGatewayInternalInboundRequest(req)
          ? createGatewayInternalInboundRequest({ ...req, content: "failure:review", metadata: {
              ...(req.metadata ?? {}), "blue_tanuki.authority_context": "gateway_internal_v1",
            } })
          : { ...req, content: "failure:review" };
      }
    }
    const suppressTransientDocumentOrganizationContext = options.transient_content === "document_organization" && req.content.startsWith(DOCUMENT_ORGANIZATION_PROMPT_PREFIX);
    const isolatedContextReason = suppressTransientDocumentOrganizationContext ? "transient_document_organization" as const
      : planPrefix?.[1]?.toLowerCase() === "reflect" ? "operation_result_reflection" as const
      : planPrefix?.[1]?.toLowerCase() === "reconcile" ? "operation_plan_receipt_reconciliation" as const
      : failureReviewControlRequested ? "failure_review" as const : undefined;
    const input = normalizeForDetection(req.content);
    const authorityReq = requestWithNormalizedContent(req, input.normalized_content);
    const decisionTraceInput = isolatedContextReason
      ? {
          ...input,
          raw_content: `[${isolatedContextReason}_content_redacted]`,
          normalized_content: `[${isolatedContextReason}_content_redacted]`,
          raw_content_redacted: true as const,
          source_content_sha256: sha256(req.content),
          source_content_chars: req.content.length,
        }
      : input;
    const goalGovernanceProjection = this.goal_governance?.project(Date.now());
    const initialFrame = frame(authorityReq, {
      default_policy: this.policy,
      ...(isolatedContextReason ? {} : { memory_reader: this.memory }),
      original_content: req.content,
      ...(this.goal_relation_tree ? { goal_relation_tree: this.goal_relation_tree } : {}),
      ...(goalGovernanceProjection ? { goal_governance: goalGovernanceProjection } : {}),
    });
    const f = isolatedContextReason
      ? { ...initialFrame, goal: `[${isolatedContextReason} sha256=${sha256(req.content)} chars=${req.content.length}]` }
      : initialFrame;
    const selfHealth = this.evaluateSelfHealth();
    if (selfHealth.fail_safe) {
      const m = selfHealthModel(f, selfHealth);
      const failSafeReason = selfHealth.fail_safe_reason.startsWith("hds_fail_safe:")
        ? selfHealth.fail_safe_reason.slice("hds_fail_safe:".length)
        : selfHealth.fail_safe_reason;
      const c = suspendCommit(
        "hds_fail_safe",
        failSafeReason,
        {
          request_id: req.id,
          failed_preconditions: selfHealth.failed_preconditions,
          command_execution_allowed: selfHealth.command_execution_allowed,
          downstream_execution_allowed: selfHealth.downstream_execution_allowed,
        },
        [
          "hds_fail_safe:suspend",
          ...selfHealth.failed_preconditions.map((precondition) => `hds_fail_safe:${precondition}=false`),
        ],
      );
      const log: DecisionLog = {
        request_id: req.id,
        input: decisionTraceInput,
        frame: f,
        model: m,
        commit: c,
        timestamp: Date.now(),
        ...(isolatedContextReason ? {
          memory_retrieval_suppressed_for: isolatedContextReason,
          memory_capture_suppressed_for: isolatedContextReason,
          session_history_suppressed_for: isolatedContextReason,
        } : {}),
      };
      this.audit.append(log);
      this.state = "SUSPENDED";
      this.suspended.set(req.id, {
        request_id: req.id,
        log,
        suspended_at: Date.now(),
        reason: c.reason,
        fail_safe: true,
        resume_allowed: false,
        self_health: selfHealth,
      });
      this.suspendedRequests.set(req.id, authorityReq);
      return { log, command: null };
    }
    const m = model(authorityReq, f, this.policy, this.detectors);

    const processViolation = processAuthorityViolation(f);
    let c = failureReviewControlFailure
      ? securityCommit("failure_review_control_denied", failureReviewControlFailure, { request_id: req.id })
      : planControlFailure
      ? securityCommit("plan_control_denied", planControlFailure, { request_id: req.id })
      : processViolation
      ? securityCommit("process_authority_denied", processViolation, {
          request_id: req.id,
          actor: f.actor,
          process: f.process.process_id,
        })
      : commit(m, this.policy);

    let log: DecisionLog = {
      request_id: req.id,
      input: decisionTraceInput,
      frame: f,
      model: m,
      commit: c,
      timestamp: Date.now(),
      ...(isolatedContextReason ? {
        memory_retrieval_suppressed_for: isolatedContextReason,
        memory_capture_suppressed_for: isolatedContextReason,
        session_history_suppressed_for: isolatedContextReason,
      } : {}),
    };

    let command: ExecuteCommand | null = null;
    if (c.decision === "ASSERT") {
      const candidate = this.buildCommand(authorityReq, log, reflection, failureReviewProjection);
      const commandViolation = commandExecutionPolicyViolation(candidate, f.process);
      if (commandViolation) {
        c = securityCommit("process_execution_policy_denied", commandViolation, {
          request_id: req.id,
          actor: f.actor,
          process: f.process.process_id,
          command_type: candidate.type,
          command_id: candidate.id,
          prior_commit_hash: c.hash,
        });
        log = { ...log, commit: c, timestamp: Date.now() };
      } else {
        command = candidate;
      }
    }

    if (command && planControl) {
      try {
        if (planControl.action === "review") this.operationPlans.bind(planControl, controlCaller, command);
        else if (planControl.action === "revise") {
          const invalidated = this.operationPlans.revise(planControl, controlCaller);
          for (const id of invalidated) this.onCommandLifecycle(id, "approval_cancelled", { reason: "plan_revision_invalidated" });
        } else if (planControl.action === "reconcile") {
          this.operationPlans.bindReceiptReconciliation(planControl, controlCaller, command);
        } else {
          this.operationPlans.bindReflection(planControl, controlCaller, command, reflection!);
          this.audit.append({ kind: "operation_plan", event: "reflection_projection_selected", request_id: req.id,
            command_id: command.id, projection_digest: operationPlanDigest(reflection), used_for_authority: false, timestamp: Date.now() });
        }
      } catch {
        c = securityCommit("plan_control_denied", "plan_state_or_command_binding_failed", { request_id: req.id });
        log = { ...log, commit: c }; command = null;
      }
    }
    this.audit.append(log);
    if (!isolatedContextReason) this.captureMemoryReference(log);

    switch (c.decision) {
      case "ASSERT": {
        if (!command) {
          throw new Error("ASSERT without command after process execution policy");
        }
        this.state = "DECIDED";
        this.inflight.set(command.id, log);
        this.issuedExecutionCommands.set(command, log);
        if (command.type === "llm_call" && isGatewayInternalInboundRequest(req) &&
            req.metadata?.["blue_tanuki.operator_surface"] === "developer") {
          this.issuedLLM.set(command.id, { command: structuredClone(command), origin: structuredClone(req),
            ...(failureReviewProjection ? { failure_review_projection: failureReviewProjection } : {}) });
        }
        return { log, command };
      }
      case "SUSPEND": {
        this.state = "SUSPENDED";
        this.suspended.set(req.id, {
          request_id: req.id,
          log,
          suspended_at: Date.now(),
          reason: c.reason,
          ...(planControl ? { resume_allowed: false, resume_denied_reason: "plan_control_requires_fresh_review" } : {}),
        });
        this.suspendedRequests.set(req.id, authorityReq);
        return { log, command: null };
      }
      case "OUT_OF_SCOPE":
      case "FAIL": {
        this.state = "DECIDED";
        return { log, command: null };
      }
      default: {
        const neverDecision = c.decision as never;
        throw new Error(`unknown HDS decision: ${String(neverDecision)}`);
      }
    }
  }

  /**
   * Human-only RESUME. Pass the request_id of a suspended request and a
   * verdict. Returns:
   *   - log     : a fresh DecisionLog entry recording the human verdict
   *   - command : the lifted ExecuteCommand if verdict==="approve", else null
   *   - request : the originating InboundRequest. Returned for ALL verdicts
   *               so callers (e.g. gateway serve.ts) can route resume-driven
   *               outputs back to the originating channel/user without
   *               having to maintain a parallel cache of suspended requests.
   *
   * Audit gets a fresh entry recording the human verdict for traceability.
   */
  resume(request_id: string, verdict: ResumeVerdict, opts: ResumeAuditOptions = {}): {
    log: DecisionLog;
    command: ExecuteCommand | null;
    request: InboundRequest;
  } {
    const susp = this.suspended.get(request_id);
    const req = this.suspendedRequests.get(request_id);
    if (!susp || !req) {
      throw new Error(`resume: no suspended request with id=${request_id}`);
    }

    this.state = "AWAITING_RESUME";
    const selfHealth = this.evaluateSelfHealth();
    if (susp.resume_allowed === false || selfHealth.fail_safe) {
      const actor = opts.actor?.trim() || "unknown";
      const token_kind = opts.token_kind ?? "resume";
      const reason =
        susp.resume_allowed === false
          ? `human_resume_denied:${susp.resume_denied_reason ?? "fail_safe"} (was SUSPEND: ${susp.reason})`
          : `human_resume_denied:self_health_fail_safe:${selfHealth.fail_safe_reason}`;
      const deniedHash = sha256({
        kind: "human_resume_denied",
        previous_commit_hash: susp.log.commit.hash,
        request_id: susp.request_id,
        verdict,
        actor,
        token_kind,
        suspended_reason: susp.reason,
        self_health: selfHealth,
      });
      const deniedLog: DecisionLog = {
        request_id: susp.request_id,
        input: susp.log.input,
        resume: {
          verdict,
          actor,
          token_kind,
        },
        frame: susp.log.frame,
        model: selfHealthModel(susp.log.frame, selfHealth),
        commit: {
          decision: "SUSPEND",
          reason,
          hash: deniedHash,
          triggered_thresholds: [
            ...susp.log.commit.triggered_thresholds,
            `human_resume_denied:${susp.resume_denied_reason ?? "fail_safe"}`,
            ...selfHealth.failed_preconditions.map((precondition) => `hds_fail_safe:${precondition}=false`),
          ],
        },
        timestamp: Date.now(),
      };
      this.audit.append(deniedLog);
      this.state = "SUSPENDED";
      return { log: deniedLog, command: null, request: req };
    }

    // Map verdict → effective decision for the resume audit entry.
    const lifted: "ASSERT" | "FAIL" | "OUT_OF_SCOPE" =
      verdict === "approve"
        ? "ASSERT"
        : verdict === "reject"
        ? "FAIL"
        : "OUT_OF_SCOPE";

    const now = Date.now();
    const actor = opts.actor?.trim() || "unknown";
    const token_kind = opts.token_kind ?? "resume";
    const resumeHash = sha256({
      kind: "human_resume",
      previous_commit_hash: susp.log.commit.hash,
      request_id: susp.request_id,
      verdict,
      actor,
      token_kind,
      effective_decision: lifted,
      suspended_reason: susp.reason,
      timestamp: now,
    });

    const resumeLog: DecisionLog = {
      request_id: susp.request_id,
      input: susp.log.input,
      resume: {
        verdict,
        actor,
        token_kind,
      },
      frame: susp.log.frame,
      model: susp.log.model,
      commit: {
        decision: lifted,
        reason: `human_resume:${verdict} (was SUSPEND: ${susp.reason})`,
        hash: resumeHash,
        triggered_thresholds: [...susp.log.commit.triggered_thresholds, `human_resume:${verdict}`],
      },
      timestamp: now,
    };
    this.audit.append(resumeLog);
    if (verdict === "approve") {
      this.captureMemoryReference(resumeLog);
    }

    this.suspended.delete(request_id);
    this.suspendedRequests.delete(request_id);
    this.state = "DECIDED";

    if (verdict === "approve") {
      const failureReviewProjection = failureReviewProjectionFromRequest(req);
      const command = this.buildCommand(req, resumeLog, undefined, failureReviewProjection);
      this.inflight.set(command.id, resumeLog);
      this.issuedExecutionCommands.set(command, resumeLog);
      if (command.type === "llm_call" && isGatewayInternalInboundRequest(req) &&
          req.metadata?.["blue_tanuki.operator_surface"] === "developer") {
        this.issuedLLM.set(command.id, { command: structuredClone(command), origin: structuredClone(req),
          ...(failureReviewProjection ? { failure_review_projection: failureReviewProjection } : {}) });
      }
      return { log: resumeLog, command, request: req };
    }
    return { log: resumeLog, command: null, request: req };
  }

  /** Record approval gate evaluation after HDS ASSERT and before executor execution. */
  onApprovalEvaluation(evaluation: ApprovalEvaluation, opts: { request_id?: string | null } = {}): void {
    const request_id = opts.request_id ?? this.inflight.get(evaluation.context.command_id)?.request_id ?? null;
    const approvalLog: ApprovalGateLog = {
      kind: "approval_gate",
      request_id,
      command_id: evaluation.context.command_id,
      upstream_commit_hash: evaluation.context.upstream_commit_hash,
      evaluation,
      timestamp: Date.now(),
    };
    this.audit.append(approvalLog);
    this.onAuthorityEvent(
      evaluation.decision === "allow"
        ? "approval_allowed"
        : evaluation.decision === "deny"
        ? "approval_denied"
        : "approval_asked",
      {
        request_id,
        command_id: evaluation.context.command_id,
        actor: evaluation.context.actor,
        reason: evaluation.reason,
        evaluation,
        grant_id: evaluation.matched_grant_id,
      },
    );
  }

  /** Append an explicit authority-ledger event into the same audit hash-chain. */
  onAuthorityEvent(
    event: Exclude<AuthorityEventLog["event"], "cron_event_no_replay_acknowledged" | "goal_purpose_change_committed">,
    opts: {
      request_id?: string | null;
      command_id?: string;
      grant_id?: string;
      actor?: string;
      reason?: string;
      evaluation?: ApprovalEvaluation;
    } = {},
  ): void {
    const log: AuthorityEventLog = {
      kind: "authority_event",
      event,
      request_id: opts.request_id ?? null,
      command_id: opts.command_id,
      grant_id: opts.grant_id,
      actor: opts.actor?.trim() || "system",
      reason: opts.reason ?? event,
      operation: opts.evaluation?.context.operation,
      target_scope: opts.evaluation?.context.target_scope,
      risk: opts.evaluation?.risk,
      authority_trace: opts.evaluation?.authority_trace,
      timestamp: Date.now(),
    };
    this.audit.append(log);
  }

  /**
   * Commit a delegated goal purpose change only after a matching, recorded L3
   * review. The audit chain is the durable J event source; caller-supplied
   * identity labels are compared with the reviewed lifecycle record and are
   * not treated as proof of a person's identity.
   */
  commitGoalPurposeChangeAfterL3(input: {
    readonly goal_ref: string;
    readonly prior_version: number;
    readonly prior_purpose_digest: string;
    readonly new_purpose_digest: string;
    readonly request_id: string;
    readonly command_id: string;
    readonly proposal_actor: string;
    readonly actor: string;
    readonly evaluation: ApprovalEvaluation;
  }): GoalPurposeChangeCommitResult {
    const ledger = this.goal_governance;
    if (!ledger) return { ok: false, reason: "goal_governance_unavailable" };
    if (!this.audit.isPersistent()) return { ok: false, reason: "audit_not_persistent" };
    if (!this.audit.verify()) return { ok: false, reason: "audit_invalid" };

    const actor = input.actor.trim();
    const proposalActor = input.proposal_actor.trim();
    const request_id = input.request_id.trim();
    const command_id = input.command_id.trim();
    const target = goalPurposeChangeReviewTarget(input);
    const evaluation = input.evaluation;
    if (!actor || actor === "system" || !proposalActor || proposalActor === "system" || !request_id || !command_id ||
        evaluation.decision !== "ask" || evaluation.context.operation !== "tool.call" ||
        evaluation.context.command_id !== command_id || evaluation.context.actor !== proposalActor ||
        evaluation.context.target !== target || evaluation.risk !== "high" ||
        evaluation.approval_level !== "L3_final_review" || !evaluation.final_review_required) {
      return { ok: false, reason: "approval_not_verified" };
    }
    const entries = this.audit.list();
    const approvalEvidence = goalPurposeChangeApprovalEvidence(entries, {
      request_id,
      command_id,
      proposal_actor: proposalActor,
      reviewer_actor: actor,
      target,
    });
    if (!approvalEvidence || JSON.stringify(approvalEvidence.evaluation) !== JSON.stringify(evaluation)) {
      return { ok: false, reason: "approval_not_verified" };
    }
    const approvedAt = approvalEvidence.timestamp;

    const current = ledger.project(Date.now()).goals.find((goal) => goal.goal_ref === input.goal_ref);
    if (!current || current.goal_kind !== "delegated" || current.current_version !== input.prior_version ||
        current.current_purpose_digest !== input.prior_purpose_digest ||
        !/^[a-f0-9]{64}$/.test(input.new_purpose_digest) || input.new_purpose_digest === input.prior_purpose_digest) {
      return { ok: false, reason: "purpose_version_conflict" };
    }

    const effective_from = Math.max(Date.now(), approvedAt);
    const authorization_ref = `ga_${randomBytes(16).toString("hex")}`;
    const event: GoalPurposeChangeEvent = {
      event_ref: `ge_${randomBytes(16).toString("hex")}`,
      event_kind: "purpose_change",
      goal_ref: input.goal_ref,
      source_ref: current.source_ref,
      goal_kind: "delegated",
      prior_version: input.prior_version,
      new_version: input.prior_version + 1,
      prior_purpose_digest: input.prior_purpose_digest,
      new_purpose_digest: input.new_purpose_digest,
      authority_kind: "owner",
      authorization_ref,
      recorded_at: approvedAt,
      effective_from,
    };
    const authorization: GoalGovernanceAuthorization = {
      authorization_ref,
      event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event),
      goal_ref: event.goal_ref,
      event_kind: event.event_kind,
      authority_kind: event.authority_kind,
      authorized_at: approvedAt,
    };
    const appended = ledger.appendAuthorizedEvent(event, authorization);
    if (!appended.ok) return { ok: false, reason: "event_invalid" };

    const commitLog: GoalPurposeChangeCommitLog = {
      kind: "authority_event",
      event: "goal_purpose_change_committed",
      request_id,
      command_id,
      actor,
      proposal_actor: proposalActor,
      reason: "matching_l3_review_committed_delegated_goal_purpose_change",
      operation: evaluation.context.operation,
      target_scope: evaluation.context.target_scope,
      risk: evaluation.risk,
      authority_trace: evaluation.authority_trace,
      goal_governance_event: event,
      goal_governance_authorization: authorization,
      timestamp: effective_from,
    };
    try {
      this.audit.append(commitLog);
    } catch {
      return { ok: false, reason: "audit_append_failed" };
    }
    this.goal_governance = appended.ledger;
    return {
      ok: true,
      event_ref: event.event_ref,
      goal_ref: event.goal_ref,
      version: event.new_version,
      purpose_digest: event.new_purpose_digest,
      effective_from: event.effective_from,
    };
  }

  /**
   * Persist an owner-reviewed no-replay disposition for one exact unsettled
   * cron event. The audited HDS record, not the gateway cursor, owns this
   * disposition. It never claims that the original external effect succeeded.
   */
  acknowledgeCronEventNoReplay(
    command: ExecuteCommand,
    evaluation: ApprovalEvaluation,
    actor: string,
    request_id: string,
  ): { event_id: string; payload_digest: string; disposition: "acknowledge_no_replay" } {
    if (command.type !== "tool_call" || command.payload.tool_name !== "schedule.resolve_event" ||
        !command.payload.arguments || typeof command.payload.arguments !== "object" ||
        Array.isArray(command.payload.arguments)) {
      throw new Error("cron event disposition requires a schedule.resolve_event tool command");
    }
    const args = command.payload.arguments as Record<string, unknown>;
    const event_id = args.event_id;
    const payload_digest = args.payload_digest;
    if (Object.keys(args).length !== 3 || args.disposition !== "acknowledge_no_replay" ||
        typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
        typeof payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(payload_digest)) {
      throw new Error("cron event disposition arguments are invalid");
    }
    const normalizedActor = actor.trim();
    const command_id = command.id;
    const evaluationBound = evaluation.decision === "ask" &&
      evaluation.context.operation === "schedule.resolve_event" &&
      evaluation.context.command_type === "tool_call" &&
      evaluation.context.command_id === command_id &&
      evaluation.risk === "high" && evaluation.approval_level === "L3_final_review" &&
      evaluation.final_review_required &&
      evaluation.authority_trace.resolved_factors.operation === "schedule.resolve_event" &&
      evaluation.authority_trace.resolved_factors.final_review_required;
    if (!normalizedActor || !request_id.trim() || !evaluationBound || !this.audit.isPersistent() || !this.audit.verify()) {
      throw new Error("cron event disposition lacks a valid bound L3 final-review evaluation");
    }
    const entries = this.audit.list();
    const recordedL3Ask = entries.some(({ log }) => "kind" in log && log.kind === "approval_gate" &&
      log.request_id === request_id &&
      log.command_id === command_id && log.evaluation.decision === "ask" &&
      log.evaluation.context.operation === "schedule.resolve_event" &&
      log.evaluation.context.command_id === command_id &&
      log.evaluation.risk === "high" &&
      log.evaluation.final_review_required && log.evaluation.approval_level === "L3_final_review");
    const explicitHumanApproval = entries.some(({ log }) => "kind" in log && log.kind === "command_lifecycle" &&
      log.request_id === request_id &&
      log.command_id === command_id && log.phase === "approval_approved" &&
      log.actor === normalizedActor && log.reason === "human_approval:approve");
    if (!recordedL3Ask || !explicitHumanApproval) {
      throw new Error("cron event disposition requires a recorded human L3 approval");
    }
    if (this.isCronEventNoReplayAcknowledged(event_id, payload_digest)) {
      throw new Error("cron event already has an owner no-replay disposition");
    }
    this.audit.append({
      kind: "authority_event",
      event: "cron_event_no_replay_acknowledged",
      request_id,
      command_id,
      actor: normalizedActor,
      reason: "owner_l3_approved_no_replay; original outcome remains unknown",
      operation: evaluation.context.operation,
      target_scope: evaluation.context.target_scope,
      risk: evaluation.risk,
      authority_trace: evaluation.authority_trace,
      cron_event_id: event_id,
      cron_payload_digest: payload_digest,
      cron_disposition: "acknowledge_no_replay",
      timestamp: Date.now(),
    });
    return { event_id, payload_digest, disposition: "acknowledge_no_replay" };
  }

  /** Read-only verification used by the Cron cursor to decide whether it may advance. */
  isCronEventNoReplayAcknowledged(event_id: string, payload_digest: string): boolean {
    if (!/^cron-[a-f0-9]{64}$/.test(event_id) || !/^[a-f0-9]{64}$/.test(payload_digest)) return false;
    if (!this.audit.isPersistent() || !this.audit.verify()) {
      throw new Error("cron no-replay disposition audit is unavailable or invalid");
    }
    const entries = this.audit.list();
    return entries.some(({ log }) => {
      if (!("kind" in log) || log.kind !== "authority_event" ||
          log.event !== "cron_event_no_replay_acknowledged" ||
          log.cron_event_id !== event_id || log.cron_payload_digest !== payload_digest ||
          log.cron_disposition !== "acknowledge_no_replay" ||
          log.operation !== "schedule.resolve_event" || log.risk !== "high" ||
          log.actor === "system" || !log.command_id || !log.request_id ||
          log.reason !== "owner_l3_approved_no_replay; original outcome remains unknown" ||
          log.authority_trace?.resolved_factors.operation !== "schedule.resolve_event" ||
          !log.authority_trace.resolved_factors.final_review_required) return false;
      const matchingL3Ask = entries.some(({ log: candidate }) => "kind" in candidate && candidate.kind === "approval_gate" &&
        candidate.command_id === log.command_id && candidate.request_id === log.request_id &&
        candidate.evaluation.decision === "ask" &&
        candidate.evaluation.context.command_id === log.command_id &&
        candidate.evaluation.context.operation === "schedule.resolve_event" &&
        candidate.evaluation.risk === "high" &&
        candidate.evaluation.approval_level === "L3_final_review" && candidate.evaluation.final_review_required);
      const matchingHumanApproval = entries.some(({ log: candidate }) => "kind" in candidate && candidate.kind === "command_lifecycle" &&
        candidate.command_id === log.command_id && candidate.request_id === log.request_id &&
        candidate.phase === "approval_approved" && candidate.actor === log.actor &&
        candidate.reason === "human_approval:approve");
      return matchingL3Ask && matchingHumanApproval;
    });
  }

  /** Record pre-executor command lifecycle events without pretending executor ran. */
  onCommandLifecycle(command_id: string, phase: CommandLifecyclePhase, opts: {
    actor?: string;
    reason?: string;
    request_id?: string | null;
  } = {}): void {
    const sourceLog = this.inflight.get(command_id);
    const lifecycleLog: CommandLifecycleLog = {
      kind: "command_lifecycle",
      phase,
      request_id: opts.request_id ?? sourceLog?.request_id ?? null,
      command_id,
      upstream_commit_hash: sourceLog?.commit.hash ?? null,
      upstream_decision: sourceLog?.commit.decision ?? null,
      actor: opts.actor?.trim() || "system",
      reason: opts.reason ?? phase,
      timestamp: Date.now(),
    };
    this.audit.append(lifecycleLog);
    if (phase === "approval_rejected" || phase === "approval_cancelled") {
      this.operationPlans.abandon(command_id);
      this.operationPlans.forgetReflection(command_id);
      this.issuedLLM.delete(command_id);
      this.inflight.delete(command_id);
    }
  }

  /** Record runtime schedule lifecycle without feeding it back into authority. */
  onScheduleLifecycle(
    event: ScheduleLifecycleEvent,
    opts: Omit<ScheduleLifecycleLog, "kind" | "event" | "timestamp">,
  ): void {
    const log: ScheduleLifecycleLog = {
      kind: "schedule_lifecycle",
      event,
      ...opts,
      timestamp: Date.now(),
    };
    this.audit.append(log);
  }

  /**
   * J reviews the downstream C response while the originating search trace is
   * still available. Call this before onFeedback removes the in-flight log.
   */
  reviewMemoryCitations(command: ExecuteCommand, feedback: ExecuteFeedback): ExecuteFeedback {
    if (command.type === "llm_call" && command.payload.compute_context?.local_p_version === FAILURE_REVIEW_LOCAL_P_VERSION) {
      const issued = this.issuedLLM.get(command.id);
      const source = this.inflight.get(command.id);
      const projection = issued?.failure_review_projection;
      if (!projection || feedback.command_id !== command.id || feedback.status !== "success") return feedback;
      const bound = Boolean(source && issued.command.id === command.id &&
        issued.command.upstream_decision.commit_hash === source.commit.hash &&
        command.payload.compute_context.projection_digest === failureReviewProjectionDigest(projection));
      const reviewed = assessFailureReviewCandidate({
        projection,
        candidate: llmResultContent(feedback.result),
        source_bound: bound,
      });
      return withLlmResultContent(feedback, failureReviewResultContent(reviewed, llmResultContent(feedback.result)));
    }
    if (command.type === "llm_call" && command.payload.compute_context?.local_p_version === OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION) {
      const source = this.inflight.get(command.id);
      const issued = this.issuedLLM.get(command.id);
      const projection = source?.commit.hash === command.upstream_decision.commit_hash && issued &&
        operationPlanDigest(issued.command) === operationPlanDigest(command) ? this.operationPlans.readReflection(command) : undefined;
      const reviewed = reviewResultReflection(command, feedback, projection, projection ? operationPlanDigest(projection) : undefined);
      this.audit.append({ kind: "operation_plan", event: reviewed.accepted ? "reflection_references_verified" : "reflection_candidate_rejected",
        request_id: source?.request_id ?? null, command_id: command.id, projection_digest: command.payload.compute_context.projection_digest,
        used_for_authority: false, timestamp: Date.now() });
      return { command_id: feedback.command_id, metrics: feedback.metrics,
        status: reviewed.accepted ? "success" : feedback.status === "suspended" ? "suspended" : "failed",
        ...(reviewed.accepted ? { result: { content: reviewed.content } } : { error: reviewed.content }) };
    }
    if (command.type !== "llm_call" || feedback.command_id !== command.id || feedback.status !== "success") {
      return feedback;
    }
    const rawContent = llmResultContent(feedback.result);
    if (rawContent === null) return feedback;

    const sourceLog = this.inflight.get(command.id);
    if (!sourceLog || sourceLog.commit.decision !== "ASSERT") {
      return withLlmResultContent(feedback, redactUnverifiedReferences(rawContent));
    }

    const reviewed = reviewMemoryCitationOutput({
      trace: sourceLog.frame.memory_trace,
      request_id: sourceLog.request_id,
      command_id: command.id,
      content: rawContent,
    });
    if (reviewed.audit_log) this.audit.append(reviewed.audit_log);
    return withLlmResultContent(feedback, reviewed.content);
  }

  private captureMemoryReference(log: DecisionLog): void {
    const captured = this.memory?.capture(log);
    if (!isCapturedMemoryReference(captured)) return;
    const referenceLog: MemoryReferenceLog = {
      kind: "memory_reference",
      event: "memory.write",
      request_id: log.request_id,
      memory_id: captured.request_id,
      f_reference: captured.f_reference ?? fReferenceForId(captured.request_id),
      entry_hash: captured.entry_hash,
      source: "hds_ltm",
      used_for_authority: false,
      reason: "hds_ltm_capture",
      summary: {
        goal: log.frame.goal,
        problem_definition_id: log.frame.problem_definition_id,
        abstraction: log.model.abstraction,
      },
      timestamp: Date.now(),
    };
    this.audit.append(referenceLog);
  }

  /**
   * Consume executor feedback for an in-flight (already ASSERTed) command.
   * Phase 1: feedback is recorded but cannot transition state away from a
   * SUSPENDED entry — that boundary is enforced by design.
   */
  onFeedback(fb: ExecuteFeedback): void {
    const llmFailure = fb.llm_failure === undefined
      ? undefined
      : LLMCallFailureSchema.parse(fb.llm_failure);
    const candidateParse = fb.llm_tool_candidates === undefined
      ? undefined
      : LLMToolCallCandidateSchema.array().max(32).safeParse(fb.llm_tool_candidates);
    const toolCandidates = candidateParse?.success ? candidateParse.data : undefined;
    const skepticalReviewParse = fb.skeptical_review === undefined
      ? undefined
      : SkepticalReviewRequestSchema.safeParse(fb.skeptical_review);
    const meaningUpdateProposalParse = fb.meaning_update_proposal === undefined
      ? undefined
      : parseMeaningUpdateProposal(fb.meaning_update_proposal);
    const sourceLog = this.inflight.get(fb.command_id);
    const issued = this.issuedLLM.get(fb.command_id);
    const resultAudit: { digest?: string; status: "not_present" | "recorded" | "unavailable" } = fb.result === undefined ? { status: "not_present" } : (() => {
      try { return { digest: sha256(fb.result), status: "recorded" as const }; }
      catch { return { status: "unavailable" as const }; }
    })();
    const operationResult = sourceLog ? inspectOperationCommandExecutionResult(fb.operation_core_result, {
      request_id: sourceLog.request_id,
      command_id: fb.command_id,
      upstream_commit_hash: sourceLog.commit.hash,
      status: fb.status,
    }) : undefined;
    const meaningUpdateProposalContractStatus = fb.meaning_update_proposal === undefined
      ? "not_present" as const
      : fb.status === "success" && sourceLog !== undefined && meaningUpdateProposalParse?.ok
        ? "passed" as const
        : "failed" as const;
    const meaningUpdateProposalReferenceReview = fb.meaning_update_proposal === undefined
      ? { review_status: "not_present" as const, supporting_reference_count: 0, supporting_references_verified: 0,
          counterevidence_reference_count: 0, counterevidence_references_verified: 0,
          applicability_scope_matches_current: false, counterevidence_scope_matches_current: false,
          applicability_scope_digest_matches_current: false, counterevidence_scope_digest_matches_current: false,
          counterevidence_claim_status: "not_present" as const, scope_digests_verified: false as const,
          target_reference_matches_current_projection: false as const,
          target_and_prior_version_verified: false as const, semantic_relation_status: "not_assessed" as const,
          adoption_status: "not_adopted" as const, may_apply: false as const, used_for_authority: false as const }
      : meaningUpdateProposalParse?.ok
        ? meaningUpdateProposalContractStatus === "passed"
          ? reviewMeaningUpdateProposalReferences(meaningUpdateProposalParse.record, sourceLog?.frame.memory_trace)
          : { review_status: "not_reviewed" as const, supporting_reference_count: 0, supporting_references_verified: 0,
              counterevidence_reference_count: 0, counterevidence_references_verified: 0,
              applicability_scope_matches_current: false, counterevidence_scope_matches_current: false,
              applicability_scope_digest_matches_current: false, counterevidence_scope_digest_matches_current: false,
              counterevidence_claim_status: "not_reviewed" as const, scope_digests_verified: false as const,
              target_reference_matches_current_projection: false as const,
              target_and_prior_version_verified: false as const, semantic_relation_status: "not_assessed" as const,
              adoption_status: "not_adopted" as const, may_apply: false as const, used_for_authority: false as const }
        : { review_status: "invalid_contract" as const, supporting_reference_count: 0, supporting_references_verified: 0,
            counterevidence_reference_count: 0, counterevidence_references_verified: 0,
            applicability_scope_matches_current: false, counterevidence_scope_matches_current: false,
            applicability_scope_digest_matches_current: false, counterevidence_scope_digest_matches_current: false,
            counterevidence_claim_status: "invalid_contract" as const, scope_digests_verified: false as const,
            target_reference_matches_current_projection: false as const,
            target_and_prior_version_verified: false as const, semantic_relation_status: "not_assessed" as const,
            adoption_status: "not_adopted" as const, may_apply: false as const, used_for_authority: false as const };
    const candidateAssessments = toolCandidates
      ? assessLLMToolCandidates(toolCandidates, sourceLog)
      : [];
    const skepticalReview = fb.skeptical_review === undefined
      ? undefined
      : skepticalReviewParse?.success
        ? assessSkepticalReview({
          review: skepticalReviewParse.data,
          sourceLog,
          candidates: toolCandidates ?? [],
          assessments: candidateAssessments,
        })
        : invalidSkepticalReviewTrace();
    const failureReviewTrace = issued?.failure_review_projection
      ? assessFailureReviewCandidate({
          projection: issued.failure_review_projection,
          candidate: fb.status === "success" ? parseFailureReviewCandidate(llmResultContent(fb.result)) : null,
          source_bound: Boolean(sourceLog && issued.command.type === "llm_call" &&
            issued.command.payload.compute_context?.local_p_version === FAILURE_REVIEW_LOCAL_P_VERSION &&
            issued.command.upstream_decision.commit_hash === sourceLog.commit.hash &&
            issued.command.payload.compute_context.projection_digest === failureReviewProjectionDigest(issued.failure_review_projection)),
        })
      : undefined;
    const failureReviewContractStatus = failureReviewTrace === undefined
      ? "not_present" as const
      : failureReviewTrace.status === "recorded" ? "passed" as const : "failed" as const;
    const feedbackLog = {
      kind: "executor_feedback" as const,
      request_id: sourceLog?.request_id ?? null,
      command_id: fb.command_id,
      upstream_commit_hash: sourceLog?.commit.hash ?? null,
      upstream_decision: sourceLog?.commit.decision ?? null,
      known_command: sourceLog !== undefined,
      feedback: {
        status: fb.status,
        result_present: fb.result !== undefined,
        result_digest: resultAudit.digest,
        result_digest_status: resultAudit.status,
        operation_result_contract_status: fb.operation_core_result === undefined
          ? "not_present" as const : operationResult ? "passed" as const : "failed" as const,
        operation_result_digest: operationResult ? sha256(operationResult) : undefined,
        error: fb.error,
        llm_failure: llmFailure,
        llm_tool_candidate_count: toolCandidates?.length ?? rawCandidateCount(fb.llm_tool_candidates),
        llm_tool_candidates_digest: toolCandidates?.length ? sha256(toolCandidates) : undefined,
        llm_tool_candidate_contract_status: fb.llm_tool_candidates === undefined
          ? "not_present" as const
          : candidateParse?.success ? "passed" as const : "failed" as const,
        llm_tool_candidate_assessments: candidateAssessments,
        skeptical_review_contract_status: fb.skeptical_review === undefined
          ? "not_present" as const
          : skepticalReviewParse?.success ? "passed" as const : "failed" as const,
        ...(skepticalReview ? { skeptical_review: skepticalReview } : {}),
        failure_review_contract_status: failureReviewContractStatus,
        ...(failureReviewTrace ? { failure_review: failureReviewTrace } : {}),
        meaning_update_proposal_contract_status: meaningUpdateProposalContractStatus,
        ...(meaningUpdateProposalContractStatus === "passed" && meaningUpdateProposalParse?.ok
          ? { meaning_update_proposal_digest: sha256(meaningUpdateProposalParse.record) }
          : {}),
        meaning_update_proposal_reference_review: meaningUpdateProposalReferenceReview,
        meaning_update_proposal_used_for_authority: false as const,
        meaning_update_proposal_applied: false as const,
        metrics: fb.metrics,
      },
      timestamp: Date.now(),
    };
    this.audit.append(feedbackLog);

    if (sourceLog && issued && issued.command.type === "llm_call" &&
        issued.command.payload.compute_context?.local_p_version !== OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION &&
        issued.command.payload.compute_context?.local_p_version !== FAILURE_REVIEW_LOCAL_P_VERSION &&
        issued.command.upstream_decision.commit_hash === sourceLog.commit.hash && fb.status === "success") {
      const result = fb.result && typeof fb.result === "object" ? fb.result as Record<string, unknown> : undefined;
      const planner = result?.operation_core && typeof result.operation_core === "object"
        ? result.operation_core as Record<string, unknown> : undefined;
      if (planner?.status === "valid_plan") {
        try {
          this.operationPlans.retainCandidate(planner.plan, issued.origin);
          this.planEvent("candidate_retained", fb.command_id);
        } catch {
          this.planEvent("candidate_rejected", fb.command_id);
        }
      }
    }
    if (sourceLog && this.operationPlans.isBound(fb.command_id)) {
      this.operationPlans.recordResult(fb);
      this.planEvent("result_observed", fb.command_id);
    }
    this.issuedLLM.delete(fb.command_id);
    this.operationPlans.forgetReflection(fb.command_id);

    if (sourceLog) {
      this.inflight.delete(fb.command_id);
    }
  }

  operationPlanCommandIsCurrent(command: ExecuteCommand): boolean {
    return this.operationPlans.canExecute(command);
  }
  beginOperationPlanRecoveryRefresh(command: ExecuteCommand): boolean {
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        command.payload.arguments.store_key !== "operation_plans" || command.payload.arguments.confirm !== "RESTORE" ||
        command.upstream_decision.commit_decision !== "ASSERT") return false;
    const started = this.operationPlans.beginRecoveryRefresh();
    if (started) this.audit.append({ kind: "operation_plan", event: "recovery_refresh_started",
      request_id: command.upstream_decision.request_id ?? null, command_id: command.id,
      projection_digest: operationPlanDigest(this.operationPlans.projection()), used_for_authority: false,
      timestamp: Date.now() });
    return started;
  }
  refreshOperationPlansAfterRecoveryRestore(command: ExecuteCommand, recoveryEvidence?: OperationPlanRecoveryEvidence): string {
    if (command.type !== "tool_call" || command.payload.tool_name !== "recovery.restore" ||
        command.payload.arguments.store_key !== "operation_plans" || command.payload.arguments.confirm !== "RESTORE" ||
        command.upstream_decision.commit_decision !== "ASSERT") throw new Error("plan_recovery_refresh_command_invalid");
    const checkpointDigest = this.operationPlans.refreshAfterRecoveryRestore(command, recoveryEvidence);
    this.operationPlans.finishRecoveryRefresh();
    try {
      this.audit.append({ kind: "operation_plan", event: "recovery_refresh_completed",
        request_id: command.upstream_decision.request_id ?? null, command_id: command.id,
        projection_digest: operationPlanDigest(this.operationPlans.projection()), used_for_authority: false,
        timestamp: Date.now() });
    } catch (error) {
      // No event-loop yield occurs before the audit append; reacquire the gate
      // immediately if the completion record cannot be durably emitted.
      if (!this.operationPlans.beginRecoveryRefresh()) throw new Error("plan_recovery_refresh_relock_failed");
      throw error;
    }
    return checkpointDigest;
  }
  isOperationPlanCommand(command_id: string): boolean { return this.operationPlans.isBound(command_id); }
  /**
   * Bind the exact current command to the HDS source that issued it. This is
   * provenance only: the digest never grants permission or identifies an
   * adopted semantic purpose version.
   */
  createExecutionAuthorityBinding(command: ExecuteCommand, brokerTargetVersionObservation?: unknown): HDSExecutionAuthorityBinding {
    const source = this.issuedExecutionCommands.get(command);
    if (!source || this.inflight.get(command.id) !== source || source.commit.decision !== "ASSERT" ||
        command.upstream_decision.commit_decision !== "ASSERT" ||
        command.upstream_decision.commit_hash !== source.commit.hash ||
        command.upstream_decision.request_id !== source.request_id) {
      throw new Error("HDS execution authority source is unavailable or no longer current");
    }
    let brokerTargetVersionObservationDigest: string | undefined;
    if (command.type === "tool_call" && command.payload.tool_name === "file.search") {
      if (brokerTargetVersionObservation === undefined) {
        throw new Error("HDS file.search target version observation is required");
      }
      const observation = FileSearchTargetVersionObservationSchema.parse(brokerTargetVersionObservation);
      const requestedRoot = command.payload.arguments.root;
      if (typeof requestedRoot !== "string" || observation.requested_root_digest !==
          createHash("sha256").update(requestedRoot, "utf8").digest("hex")) {
        throw new Error("HDS file.search target version does not match the issued command");
      }
      brokerTargetVersionObservationDigest = operationPlanDigest(observation);
    } else if (brokerTargetVersionObservation !== undefined) {
      throw new Error("HDS target version observation is unsupported for this command");
    }
    const projection = source.frame.goal_projection;
    const goalGovernance = source.frame.goal_governance;
    if (goalGovernance && goalGovernance.used_for_authority !== false) {
      throw new Error("HDS goal governance projection must remain non-authoritative");
    }
    const goalGovernanceProjectionDigest = goalGovernance ? operationPlanDigest(goalGovernance) : undefined;
    const operation_plan_binding_digest = this.operationPlans.executionSourceBindingDigest(command);
    const source_context_digest = sha256({
      schema_version: "blue-tanuki.hds-execution-source-context.v3",
      request_id: source.request_id,
      command_id: command.id,
      commit_hash: source.commit.hash,
      actor_id_digest: sha256(source.frame.actor.actor_id),
      ...(source.frame.actor.external_user_id
        ? { external_user_id_digest: sha256(source.frame.actor.external_user_id) }
        : {}),
      actor_kind: source.frame.actor.actor_kind,
      channel: source.frame.actor.channel,
      actor_trust_level: source.frame.actor.trust_level,
      process_id: source.frame.process.process_id,
      goal_projection_id: projection.projection_id,
      goal_projection_digest: sha256(projection),
      source_content_sha256: projection.original_request_ref.content_sha256,
      goal_projection_state: projection.state,
      goal_authority_status: projection.authority.status,
      ...(operation_plan_binding_digest ? { operation_plan_binding_digest } : {}),
      ...(brokerTargetVersionObservationDigest
        ? { broker_target_version_observation_digest: brokerTargetVersionObservationDigest } : {}),
      ...(goalGovernanceProjectionDigest
        ? { goal_governance_projection_digest: goalGovernanceProjectionDigest, goal_governance_used_for_authority: false } : {}),
    });
    const binding: HDSExecutionAuthorityBinding = Object.freeze({
      schema_version: "blue-tanuki.hds-execution-authority-binding.v3",
      source_context_digest,
      ...(operation_plan_binding_digest ? { operation_plan_binding_digest } : {}),
      ...(brokerTargetVersionObservationDigest
        ? { broker_target_version_observation_digest: brokerTargetVersionObservationDigest } : {}),
      ...(goalGovernanceProjectionDigest
        ? { goal_governance_projection_digest: goalGovernanceProjectionDigest, goal_governance_used_for_authority: false } : {}),
    });
    HDS_EXECUTION_AUTHORITY_BINDINGS.set(binding, { command, source_context_digest,
      ...(operation_plan_binding_digest ? { operation_plan_binding_digest } : {}),
      ...(brokerTargetVersionObservationDigest
        ? { broker_target_version_observation_digest: brokerTargetVersionObservationDigest } : {}),
      ...(goalGovernanceProjectionDigest
        ? { goal_governance_projection_digest: goalGovernanceProjectionDigest, goal_governance_used_for_authority: false } : {}),
      consumed: false });
    return binding;
  }
  beginOperationPlanAttempt(command: ExecuteCommand, admission?: ExecutionAdmission): boolean {
    const known = this.inflight.get(command.id);
    if (this.operationPlans.isBound(command.id) && (!known || known.commit.hash !== command.upstream_decision.commit_hash)) return false;
    const allowed = this.operationPlans.beginAttempt(command, admission);
    if (allowed && this.operationPlans.isBound(command.id)) this.planEvent("intent_committed", command.id);
    return allowed;
  }
  reconcileOperationPlanResult(delivery: ExecutionResultDelivery, delivery_digest: string): boolean {
    const adopted = this.operationPlans.reconcileResult(delivery, delivery_digest);
    if (adopted) {
      this.operationPlans.reconcileMemory();
      this.planEvent("result_reconciled", delivery.feedback.command_id);
    }
    return adopted && this.operationPlans.resultMemoryIsDurable(delivery.feedback.command_id);
  }
  recordOperationPlanExternalReceiptObservation(value: unknown, caller: InboundRequest): boolean {
    const observation = OperationPlanExternalReceiptObservationSchema.parse(value);
    const recorded = this.operationPlans.recordExternalReceiptObservation(observation, caller);
    if (recorded !== null) this.planEvent("external_receipt_observed", recorded.command_id);
    return recorded !== null;
  }
  takeOperationPlanReceiptReconciliationAuthorization(
    command: ExecuteCommand,
    caller: InboundRequest,
    now_ms?: number,
  ): OperationPlanReceiptReconciliationAuthorization | null {
    return this.operationPlans.takeReceiptReconciliationAuthorization(command, caller, now_ms);
  }
  inspectOperationPlanReceiptReconciliationForControl(
    control: Extract<OperationPlanControl, { action: "reconcile" }>,
    caller: InboundRequest,
  ): void {
    this.operationPlans.inspectReceiptReconciliationForControl(control, caller);
  }
  reconcileOperationPlanMemory(): boolean { return this.operationPlans.reconcileMemory(); }
  closeOperationPlanMemory(): void { this.operationPlans.closeMemory(); }
  holdOperationPlansForCanonicalMemoryRestore(command: ExecuteCommand): boolean {
    return this.operationPlans.holdForCanonicalMemoryRestore(command);
  }
  recordOperationPlanMemoryRestoreObservation(
    command: ExecuteCommand,
    observation: OperationPlanCanonicalMemoryRestoreObservation,
  ): boolean {
    return this.operationPlans.recordCanonicalMemoryRestoreObservation(command, observation);
  }
  quiesceOperationPlanMemoryForCanonicalRestore(): boolean {
    return this.operationPlans.quiesceMemoryForCanonicalRestore();
  }
  reopenOperationPlanMemoryAfterCanonicalRestore(): boolean {
    return this.operationPlans.reopenMemoryAfterCanonicalRestore();
  }
  private planEvent(event: string, command_id: string): void {
    this.audit.append({ kind: "operation_plan", event, request_id: this.inflight.get(command_id)?.request_id ?? null, command_id,
      projection_digest: operationPlanDigest(this.operationPlans.projection()), used_for_authority: false, timestamp: Date.now() });
  }

  /** Record result/output release before a user-visible or external handoff. */
  onOutputAudit(input: Omit<OutputAuditInput, "request_id"> & { request_id?: string | null }): OutputAuditLog {
    const sourceLog = this.inflight.get(input.command.id);
    const log = buildOutputAuditLog({
      ...input,
      request_id: input.request_id ?? sourceLog?.request_id ?? null,
    });
    this.audit.append(log);
    return log;
  }

  /** Digest-only M generation used to prevent a transient J task from resuming against changed memory. */
  documentOrganizationMemoryVersion(): DocumentOrganizationMemoryVersion {
    const version = this.memory?.stateVersion?.();
    if (!version) {
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: "unavailable",
        revision_digest: null,
        entry_count: null,
      };
    }
    return version;
  }

  /** Audit a terminal J projection restored without a new C execution. */
  onDocumentOrganizationProjectionOutputAudit(input: {
    readonly request_id: string;
    readonly upstream_commit_hash: string;
    readonly projection: DocumentOrganizationProjection;
    readonly rendered_output: string;
    readonly target_surface: import("./output_audit.js").OutputTargetSurface;
    readonly timestamp?: number;
  }): ProjectionOutputAuditLog {
    const projection = input.projection;
    if (projection.status !== "completed" && projection.status !== "held") {
      throw new Error("only terminal document organization projections may be restored for display");
    }
    if (projection.used_for_authority || projection.may_execute || projection.may_commit_to_memory ||
        projection.accepted_excerpts.some((excerpt) => excerpt.used_for_authority || excerpt.may_execute || excerpt.may_commit_to_memory)) {
      throw new Error("document organization projection authority flags are invalid");
    }
    const log = buildProjectionOutputAuditLog({
      request_id: input.request_id,
      upstream_commit_hash: input.upstream_commit_hash,
      task_id: projection.task_id,
      projection_revision: projection.revision,
      projection_status: projection.status,
      rendered_output: input.rendered_output,
      target_surface: input.target_surface,
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    });
    this.audit.append(log);
    return log;
  }

  /** Build and append runtime invariant evidence into the HDS audit chain. */
  onRuntimeInvariantsEvidence(opts: {
    request_id?: string | null;
    reason?: string;
    report?: RuntimeInvariantEvidenceReport;
    evidence_options?: RuntimeInvariantEvidenceOptions;
    timestamp?: number;
  } = {}): RuntimeInvariantsLog {
    const evidence_options = {
      ...opts.evidence_options,
      actuals: {
        ...this.runtimeInvariantActuals(),
        ...(opts.evidence_options?.actuals ?? {}),
      },
    };
    const report = opts.report ?? buildRuntimeInvariantEvidence(evidence_options);
    const log: RuntimeInvariantsLog = {
      kind: "runtime_invariants",
      request_id: opts.request_id ?? null,
      event: "runtime_invariants.evidence",
      all_ok: report.all_ok,
      report_digest: report.report_digest,
      evidence_count: report.evidence.length,
      values: report.values,
      report,
      used_for_authority: false,
      reason: opts.reason ?? "runtime_invariants_evidence",
      timestamp: opts.timestamp ?? Date.now(),
    };
    this.audit.append(log);
    return log;
  }

  getState(): ControllerState {
    return this.state;
  }

  getAudit(): AuditLog {
    return this.audit;
  }

  getGoalGovernanceProjection(asOf = Date.now()): ReadonlyGoalGovernanceProjection | undefined {
    return this.goal_governance?.project(asOf);
  }

  /**
   * List currently suspended requests for human review.
   */
  listSuspended(): readonly SuspendedRequest[] {
    return Array.from(this.suspended.values());
  }

  getRuntimeSnapshot(opts: { runtime_invariants?: RuntimeInvariantEvidenceReport } = {}): HDSRuntimeSnapshot {
    const runtime_invariants = opts.runtime_invariants ?? buildRuntimeInvariantEvidence({
      actuals: this.runtimeInvariantActuals(),
    });
    return {
      state: this.state,
      suspended: this.listSuspended(),
      inflight: Array.from(this.inflight.entries()).map(([command_id, log]) => ({
        command_id,
        request_id: log.request_id,
        commit_hash: log.commit.hash,
        decision: log.commit.decision,
      })),
      audit: {
        entries: this.audit.size(),
        chain_valid: this.audit.verify(),
      },
      memory: {
        configured: this.memory !== undefined,
        entries: this.memory?.size?.(),
        chain_valid: this.memory?.verify?.(),
      },
      invariants: runtime_invariants.values,
      runtime_invariants,
      operation_plans: this.operationPlans.projection(),
    };
  }

  getSelfHealth(opts: { runtime_invariants?: RuntimeInvariantEvidenceReport } = {}): HDSBrainHealth {
    return this.evaluateSelfHealth(opts);
  }

  private evaluateSelfHealth(opts: { runtime_invariants?: RuntimeInvariantEvidenceReport } = {}): HDSBrainHealth {
    const runtime_invariants = opts.runtime_invariants ?? this.self_health.runtime_invariants;
    return evaluateHDSBrainHealth(this.getRuntimeSnapshot({ ...(runtime_invariants ? { runtime_invariants } : {}) }), {
      hds_available: this.self_health.hds_available,
      policy_valid: this.self_health.policy_valid ?? this.policyStructurallyValid(),
      approval_gate_available: this.self_health.approval_gate_available,
      required_directories: this.self_health.required_directories,
      storage_paths: this.self_health.storage_paths,
      optional_dependencies: this.self_health.optional_dependencies,
      audit_appendable: this.self_health.audit_appendable,
    });
  }

  private policyStructurallyValid(): boolean {
    try {
      validatePolicy(this.policy);
      return true;
    } catch {
      return false;
    }
  }

  private runtimeInvariantActuals(): Partial<Record<RuntimeInvariantKey, boolean>> {
    return {
      hds_calls_llm: false,
      process_policy_enforced: this.policyStructurallyValid(),
      memory_used_for_authority: false,
      complete_history_used_for_authority: false,
    };
  }

  private buildCommand(
    req: InboundRequest,
    log: DecisionLog,
    reflection?: ResultObservationProjection,
    failureReview?: FailureReviewProjection,
  ): ExecuteCommand {
    const upstream_decision: UpstreamDecision = {
      frame_goal: log.frame.goal,
      model_abstraction: log.model.abstraction,
      commit_hash: log.commit.hash,
      commit_decision: log.commit.decision,
      request_id: log.request_id,
    };

    if (failureReview) {
      const backendHint = this.llm_route.backend_hint?.trim() || undefined;
      const projectionDigest = failureReviewProjectionDigest(failureReview);
      const systemContent = [
        "失敗署名を検討する未信頼計算です。入力は失敗カテゴリとSHA-256 digestだけで、元のgoal/action/context/resultは読めません。digestに意味を見立てず、カテゴリに基づく一般的な原因候補・別仮説・目的同定/評価器/観測方法の誤り候補、範囲、反例、独立観測、条件付き再開条件をJSONで提案してください。原因を事実として断定しないでください。",
        "raw内容・tool・計画・意味更新・実行・再試行・権限提案を出さないでください。空欄や不明は不明のままにしてください。",
        `出力schema: {"schema_version":"blue-tanuki.failure-review-candidate.v1","signature_id":${JSON.stringify(failureReview.signature_id)},"signature_digest":${JSON.stringify(failureReview.signature_digest)},"projection_digest":${JSON.stringify(projectionDigest)},"cause_hypotheses":[{"category":${JSON.stringify(failureReview.failure_type)},"rationale":"未検証候補"}],"alternative_hypotheses":["未検証の別仮説"],"observation_error_hypotheses":["目的/評価/観測の未検証候補"],"scope_assessment":"uncertain","counterexamples":["未検証の反例候補"],"resume_conditions":["独立観測で確認する条件候補"],"additional_observations":["必要な追加観測候補"],"authority_boundary":{"candidate_only":true,"may_execute":false,"used_for_authority":false}}。scope_assessmentはsame_scope / uncertain / different_scopeの一つを選択してください。各配列は最大16件、各自由文は1200文字以内。`,
        `FailureReviewProjection=${JSON.stringify(failureReview)}`,
      ].join("\n");
      return {
        id: randomUUID(),
        type: "llm_call",
        upstream_decision,
        constraints: { max_tokens: this.llm_route.max_tokens ?? 1024, timeout_ms: this.llm_route.timeout_ms ?? 30_000 },
        payload: {
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: "提示された失敗署名について、原因候補と観測誤りを反対仮説・反例とともに挙げてください。" },
          ],
          backend_hint: backendHint,
          model: this.llm_route.model,
          temperature: this.llm_route.temperature,
          compute_context: {
            schema_version: "blue-tanuki.compute-context.v1",
            projection_digest: projectionDigest,
            local_p_version: FAILURE_REVIEW_LOCAL_P_VERSION,
            data_exposure: {
              input_sources: ["failure_memory_digest_projection"],
              requested_egress_provider: backendHint ?? "registry-default",
            },
          },
        },
      };
    }

    if (/^failure:review(?:\s|$)/i.test(req.content.trim())) {
      return {
        id: randomUUID(),
        type: "noop",
        payload: { control_event: "failure_review_unavailable" },
        upstream_decision,
      };
    }

    // 観測解釈はtool/channel routingより前に、有限入力のC計算だけへ固定する。
    if (reflection) {
      const backendHint = this.llm_route.backend_hint?.trim() || undefined;
      const digest = operationPlanDigest(reflection);
      return { id: randomUUID(), type: "llm_call", upstream_decision,
        constraints: { max_tokens: this.llm_route.max_tokens ?? 1024, timeout_ms: this.llm_route.timeout_ms ?? 30000 },
        payload: { messages: [{ role: "system", content: `受領確認済みの限定観測から解釈候補だけを返してください。検索件数は観測値で、完全走査・不存在・世界真理・反証不存在・承認を証明しません。出力はJSONのみ: {"schema_version":"operation-result-reflection-candidate.v1","projection_digest":"${digest}","citations":[{"record_id":"引用元ID","record_digest":"引用元digest","interpretation":"未検証の解釈候補","uncertainty":"不確実性と追加観測の必要性"}]}。引用は下記だけ。tool・計画・意味更新・実行を発行しない。各解釈/不確実性は800文字以内。\n${JSON.stringify(reflection)}` },
          { role: "user", content: req.content }], backend_hint: backendHint, model: this.llm_route.model,
          temperature: this.llm_route.temperature, compute_context: { schema_version: "blue-tanuki.compute-context.v1",
            projection_digest: digest, local_p_version: OPERATION_RESULT_REFLECTION_LOCAL_P_VERSION,
            data_exposure: { input_sources: ["accepted_inbound_request", "selected_memory_references"],
              requested_egress_provider: backendHint ?? "registry-default" } } } };
    }
    if (log.memory_retrieval_suppressed_for === "operation_result_reflection") throw new Error("plan_reflection_context_missing");

    if (req.content.trim().startsWith("plan:revise")) {
      return { id: randomUUID(), type: "noop", payload: { control_event: "plan_revision_committed" }, upstream_decision };
    }
    if (req.content.trim() === "plan:reconcile") {
      return { id: randomUUID(), type: "noop", payload: { control_event: "operation_plan_receipt_reconciliation" }, upstream_decision };
    }

    // S7 action routing: explicit safe tool requests may become tool_call.
    // Unknown explicit tool requests become noop instead of being passed to
    // the LLM as ordinary text.
    const action = routeAction(req);
    if (action?.type === "tool_call") {
      return {
        id: randomUUID(),
        type: "tool_call",
        payload: {
          tool_name: action.tool_name,
          arguments: action.arguments,
        },
        constraints: {
          allowed_tools: [action.tool_name],
          allowed_capabilities: action.allowed_capabilities,
          timeout_ms: action.timeout_ms,
        },
        upstream_decision,
      };
    }
    if (action?.type === "noop") {
      return {
        id: randomUUID(),
        type: "noop",
        payload: { reason: action.reason },
        upstream_decision,
      };
    }

    const scheduledSend = trustedChannelSendFromMetadata(req);
    if (scheduledSend) {
      return {
        id: randomUUID(),
        type: "channel_send",
        payload: scheduledSend,
        constraints: {
          allowed_capabilities: ["channel:send"],
          timeout_ms: Math.min(this.llm_route.timeout_ms ?? 30_000, 30_000),
        },
        upstream_decision,
      };
    }

    // Default routing: emit llm_call with the request content.
    //
    // session_id (Phase 4-S2): set to `${channel}:${user}` so the
    // executor's SessionStore can scope history retrieval and append.
    // HDS-BRAIN itself does NOT read the history — judgement is always
    // on the latest inbound request only. The session_id is upstream's
    // declaration of WHERE the executor should persist, not a signal
    // that HDS-BRAIN is consuming past context.
    const memoryMessages = buildMemoryCitationSystemMessages(log.frame.memory_trace);
    const backendHint = this.llm_route.backend_hint?.trim() || undefined;
    const llmPayload: LLMCallPayload = {
      messages: [
        ...memoryMessages,
        ...(req.content.trim().startsWith("plan:compute") && isGatewayInternalInboundRequest(req) &&
          req.metadata?.["blue_tanuki.operator_surface"] === "developer" ? [{ role: "system" as const,
          content: `OperationPlanの候補だけをoperation-core.v1のJSONで返してください。固定request_id=${req.metadata["blue_tanuki.operation_core.request_id"] ?? req.id}。plan_idとstep_idは不透明ID、stateはplanned。stepsはoperation/target/parameters/effects/permission/adapter/preparationを持ち、依存はdepends_onとbindingsで表します。未実行を成功と申告しないこと。planner_output_used_for_authority=false、hds_brain_authority_required=true。raw_command_policyはraw_command_is_core_operation=false、command_generation_location=not_applicable。rollback.available=false。現在の実target resolverはfile.searchのdirectory targetとparameters.rootの一致、およびgmail.writeのexternal_service target id=gmailでoperation=message.send、単一のto、subject、body_textだけを使う場合に限ります。Gmail計画へcc/bcc/fromやcredentialを含めません。採用・承認・実行はこの計算の責務ではありません。` }] : []),
        { role: "user", content: req.content },
      ],
      ...(log.memory_retrieval_suppressed_for === "transient_document_organization"
        ? {}
        : { session_id: `${req.channel}:${req.user}` }),
      backend_hint: backendHint,
      model: this.llm_route.model,
      temperature: this.llm_route.temperature,
      compute_context: {
        schema_version: "blue-tanuki.compute-context.v1",
        projection_digest: computeCurrentProjectionDigest(
          log.frame.goal_projection.projection_id,
          memoryMessages,
        ),
        local_p_version: "blue-tanuki.c-input-rules.v1",
        data_exposure: {
          input_sources: [
            "accepted_inbound_request",
            ...(memoryMessages.length > 0 ? ["selected_memory_references" as const] : []),
          ],
          requested_egress_provider: backendHint ?? "registry-default",
        },
        ...(this.llm_route.fallback_authorization
          ? { fallback_authorization: this.llm_route.fallback_authorization }
          : {}),
      },
    };

    const max_tokens = this.llm_route.max_tokens ?? 1024;
    const timeout_ms = this.llm_route.timeout_ms ?? 30_000;

    return {
      id: randomUUID(),
      type: "llm_call",
      payload: llmPayload,
      constraints: { max_tokens, timeout_ms },
      upstream_decision,
    };
  }
}

function computeCurrentProjectionDigest(
  goalProjectionId: string,
  memoryMessages: readonly { role: string; content: string }[],
): string {
  const memoryContextDigest = createHash("sha256")
    .update(JSON.stringify(memoryMessages))
    .digest("hex");
  return createHash("sha256")
    .update(JSON.stringify({
      schema_version: "blue-tanuki.compute-current-projection.v1",
      goal_projection_id: goalProjectionId,
      memory_context_digest: memoryContextDigest,
    }))
    .digest("hex");
}

function assessLLMToolCandidates(
  candidates: readonly LLMToolCallCandidate[],
  sourceLog: DecisionLog | undefined,
): LLMToolCandidateAssessment[] {
  const callIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    callIdCounts.set(candidate.call_id, (callIdCounts.get(candidate.call_id) ?? 0) + 1);
  }

  return candidates.map((candidate) => {
    const duplicateCallId = (callIdCounts.get(candidate.call_id) ?? 0) > 1;
    const mechanicalOutcome = duplicateCallId ? "fail" : "pass";
    const domainOutcome = sourceLog === undefined
      ? "unknown"
      : sourceLog.frame.process.execution_policy.allowed_command_types.includes("tool_call") &&
          sourceLog.frame.process.execution_policy.allowed_tools.includes(candidate.tool_name)
        ? "pass"
        : "fail";
    const semanticOutcome = "not_assessed" as const;
    const semanticEvidenceStatus = "unknown" as const;
    const goalCriteria = assessCandidateGoalCriteria(
      candidate.tool_name,
      sourceLog?.frame.candidate_goal_criteria,
      sourceLog ? {
        request_id: sourceLog.request_id,
        content_sha256: sourceLog.frame.goal_projection.original_request_ref.content_sha256,
      } : undefined,
    );

    return {
      candidate_digest: sha256(candidate),
      candidate_origin_status: "inferred",
      mechanical_contract: {
        outcome: mechanicalOutcome,
        evidence_status: "observed",
        reason_code: duplicateCallId ? "duplicate_call_id" : "strict_schema_passed",
      },
      domain_validation: {
        outcome: domainOutcome,
        evidence_status: sourceLog === undefined ? "unknown" : "observed",
        reason_code: sourceLog === undefined
          ? "origin_command_unavailable"
          : domainOutcome === "pass" ? "process_allowlist_match" : "process_allowlist_mismatch",
      },
      semantic_judgment: {
        outcome: semanticOutcome,
        evidence_status: semanticEvidenceStatus,
        reason_code: "purpose_relation_not_assessed",
      },
      goal_criteria: goalCriteria,
      adoption_disposition: determineCandidateAdoptionDisposition({
        mechanical_contract: mechanicalOutcome,
        domain_validation: domainOutcome,
        semantic_outcome: semanticOutcome,
        semantic_evidence_status: semanticEvidenceStatus,
        goal_criteria: goalCriteria,
      }),
      may_execute: false,
      used_for_authority: false,
    };
  });
}

function rawCandidateCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function llmResultContent(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const content = (result as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function withLlmResultContent(feedback: ExecuteFeedback, content: string): ExecuteFeedback {
  if (typeof feedback.result === "string") return { ...feedback, result: content };
  if (!feedback.result || typeof feedback.result !== "object" || Array.isArray(feedback.result)) return feedback;
  return {
    ...feedback,
    result: { ...(feedback.result as Record<string, unknown>), content },
  };
}

function requestWithNormalizedContent(req: InboundRequest, content: string): InboundRequest {
  if (
    isGatewayInternalInboundRequest(req) &&
    req.metadata?.["blue_tanuki.authority_context"] === "gateway_internal_v1"
  ) {
    return createGatewayInternalInboundRequest({
      ...req,
      content,
      metadata: req.metadata as GatewayInternalAuthorityMetadata,
    });
  }
  return {
    ...req,
    content,
  };
}

function failureReviewProjectionFromRequest(req: InboundRequest): FailureReviewProjection | undefined {
  const command = /^failure:review(?:\s+(\S+))?$/i.exec(req.content.trim());
  if (!command || !isGatewayInternalInboundRequest(req) ||
      req.metadata?.["blue_tanuki.operator_surface"] !== "developer" ||
      !["owner", "user"].includes(resolveActor(req).actor_kind)) return undefined;
  const metadata = req.metadata ?? {};
  if (metadata["blue_tanuki.failure_review.version"] !== FAILURE_REVIEW_LOCAL_P_VERSION ||
      typeof metadata["blue_tanuki.failure_review.projection_json"] !== "string") return undefined;
  let value: unknown;
  try { value = JSON.parse(metadata["blue_tanuki.failure_review.projection_json"] as string) as unknown; }
  catch { return undefined; }
  const parsed = FailureReviewProjectionSchema.safeParse(value);
  if (!parsed.success || metadata["blue_tanuki.failure_review.signature_id"] !== parsed.data.signature_id ||
      (command[1] !== undefined && command[1].toLowerCase() !== "latest" && command[1] !== parsed.data.signature_id)) {
    return undefined;
  }
  return parsed.data;
}

function selfHealthModel(frameResult: DecisionLog["frame"], health: HDSBrainHealth): ModelResult {
  return {
    abstraction: `self_health:${health.status}`,
    structure: {
      problem_definition_id: frameResult.problem_definition_id,
      actor: frameResult.actor,
      process: {
        process_id: frameResult.process.process_id,
        process_kind: frameResult.process.process_kind,
        trigger: frameResult.process.trigger,
      },
      self_health: {
        status: health.status,
        config_validation_status: health.config_validation_status,
        runtime_health_status: health.runtime_health_status,
        runtime_checks: health.runtime_checks,
        failed_preconditions: health.failed_preconditions,
        command_execution_allowed: health.command_execution_allowed,
        downstream_execution_allowed: health.downstream_execution_allowed,
        operator_next_action: health.operator_next_action,
        used_for_authority: health.used_for_authority,
      },
    },
    scoring: {
      axis_scores: [
        {
          axis: "self_health",
          score: health.fail_safe ? 0 : 1,
          detector: "hds_self_health",
          evidence: health.fail_safe_reason,
          lifecycle: {
            status: "ok",
            reason: "self_health_evaluated",
          },
        },
      ],
      weights: { self_health: 1 },
      aggregate: health.fail_safe ? 0 : 1,
    },
  };
}

function isCapturedMemoryReference(value: unknown): value is CapturedMemoryReference {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Partial<CapturedMemoryReference>).request_id === "string" &&
    typeof (value as Partial<CapturedMemoryReference>).entry_hash === "string"
  );
}
