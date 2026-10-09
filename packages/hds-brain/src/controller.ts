import { randomUUID } from "node:crypto";
import type {
  InboundRequest,
  ExecuteCommand,
  ExecuteFeedback,
  GatewayInternalAuthorityMetadata,
  UpstreamDecision,
  LLMCallPayload,
} from "@blue-tanuki/protocol";
import {
  createGatewayInternalInboundRequest,
  isGatewayInternalInboundRequest,
  parseInboundRequestAtBoundary,
} from "@blue-tanuki/protocol";
import type {
  ApprovalGateLog,
  AuthorityEventLog,
  CommandLifecycleLog,
  CommandLifecyclePhase,
  ControllerState,
  DecisionLog,
  ModelResult,
  MemoryReferenceLog,
  PolicyConfig,
  ResumeAuditTrace,
  ResumeVerdict,
  RuntimeInvariantsLog,
  ScheduleLifecycleEvent,
  ScheduleLifecycleLog,
  SuspendedRequest,
} from "./types.js";
import type { GoalGovernanceConfig } from "@blue-tanuki/protocol";
import { frame } from "./frame.js";
import { buildGoalRelationTreeView, type ReadonlyGoalRelationTreeView } from "./goal_relations.js";
import { GoalGovernanceLedger } from "./goal_governance.js";
import { model } from "./model.js";
import { commit } from "./commit.js";
import { AuditLog } from "./audit.js";
import { normalizeForDetection } from "./normalization.js";
import {
  DetectorRegistry,
  createDefaultDetectorRegistry,
} from "./detectors/index.js";
import { DEFAULT_POLICY, validatePolicy } from "./policy.js";
import { routeAction } from "./action_router.js";
import type { ApprovalEvaluation } from "./approval_policy.js";
import {
  buildOutputAuditLog,
  type OutputAuditInput,
  type OutputAuditLog,
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
}

export interface LLMCommandRoute {
  backend_hint?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
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

export class HDSUpperController {
  private state: ControllerState = "IDLE";
  private readonly audit: AuditLog;
  private readonly policy: PolicyConfig;
  private readonly detectors: DetectorRegistry;
  private readonly memory?: LongTermMemoryPort;
  private readonly llm_route: LLMCommandRoute;
  private readonly self_health: ControllerSelfHealthOptions;
  private readonly goal_relation_tree?: ReadonlyGoalRelationTreeView;
  private readonly goal_governance?: GoalGovernanceLedger;

  /** Commands awaiting executor feedback (already ASSERTed). */
  private readonly inflight = new Map<string, DecisionLog>();

  /** Requests halted by SUSPEND, awaiting human verdict via resume(). */
  private readonly suspended = new Map<string, SuspendedRequest>();

  /** Cached original requests for suspended ones, so resume() can re-emit. */
  private readonly suspendedRequests = new Map<string, InboundRequest>();

  constructor(opts: ControllerOptions = {}) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.detectors = opts.detectors ?? createDefaultDetectorRegistry();
    this.audit = opts.audit ?? new AuditLog();
    this.memory = opts.memory;
    this.llm_route = opts.llm_route ?? {};
    this.goal_relation_tree = opts.goal_relation_graph === undefined
      ? undefined
      : buildGoalRelationTreeView(opts.goal_relation_graph);
    if (opts.goal_governance !== undefined) {
      const built = GoalGovernanceLedger.create(opts.goal_governance);
      if (!built.ok) throw new Error("invalid goal governance configuration");
      this.goal_governance = built.ledger;
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
  decide(raw: unknown): {
    log: DecisionLog;
    command: ExecuteCommand | null;
  } {
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
    const req = boundary.request;
    const input = normalizeForDetection(req.content);
    const authorityReq = requestWithNormalizedContent(req, input.normalized_content);
    const goalGovernanceProjection = this.goal_governance?.project(Date.now());
    const f = frame(authorityReq, {
      default_policy: this.policy,
      memory_reader: this.memory,
      original_content: req.content,
      ...(this.goal_relation_tree ? { goal_relation_tree: this.goal_relation_tree } : {}),
      ...(goalGovernanceProjection ? { goal_governance: goalGovernanceProjection } : {}),
    });
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
        input,
        frame: f,
        model: m,
        commit: c,
        timestamp: Date.now(),
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
    let c = processViolation
      ? securityCommit("process_authority_denied", processViolation, {
          request_id: req.id,
          actor: f.actor,
          process: f.process.process_id,
        })
      : commit(m, this.policy);

    let log: DecisionLog = {
      request_id: req.id,
      input,
      frame: f,
      model: m,
      commit: c,
      timestamp: Date.now(),
    };

    let command: ExecuteCommand | null = null;
    if (c.decision === "ASSERT") {
      const candidate = this.buildCommand(authorityReq, log);
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

    this.audit.append(log);
    this.captureMemoryReference(log);

    switch (c.decision) {
      case "ASSERT": {
        if (!command) {
          throw new Error("ASSERT without command after process execution policy");
        }
        this.state = "DECIDED";
        this.inflight.set(command.id, log);
        return { log, command };
      }
      case "SUSPEND": {
        this.state = "SUSPENDED";
        this.suspended.set(req.id, {
          request_id: req.id,
          log,
          suspended_at: Date.now(),
          reason: c.reason,
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
          ? `human_resume_denied:fail_safe (was SUSPEND: ${susp.reason})`
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
            "human_resume_denied:fail_safe",
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
      const command = this.buildCommand(req, resumeLog);
      this.inflight.set(command.id, resumeLog);
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
    event: AuthorityEventLog["event"],
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

  /** Record pre-executor command lifecycle events without pretending executor ran. */
  onCommandLifecycle(command_id: string, phase: CommandLifecyclePhase, opts: { actor?: string; reason?: string } = {}): void {
    const sourceLog = this.inflight.get(command_id);
    const lifecycleLog: CommandLifecycleLog = {
      kind: "command_lifecycle",
      phase,
      request_id: sourceLog?.request_id ?? null,
      command_id,
      upstream_commit_hash: sourceLog?.commit.hash ?? null,
      upstream_decision: sourceLog?.commit.decision ?? null,
      actor: opts.actor?.trim() || "system",
      reason: opts.reason ?? phase,
      timestamp: Date.now(),
    };
    this.audit.append(lifecycleLog);
    if (phase === "approval_rejected" || phase === "approval_cancelled") this.inflight.delete(command_id);
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
    const sourceLog = this.inflight.get(fb.command_id);
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
        result_digest: fb.result === undefined ? undefined : sha256(fb.result),
        error: fb.error,
        metrics: fb.metrics,
      },
      timestamp: Date.now(),
    };
    this.audit.append(feedbackLog);

    if (sourceLog) {
      this.inflight.delete(fb.command_id);
    }
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

  private buildCommand(req: InboundRequest, log: DecisionLog): ExecuteCommand {
    const upstream_decision: UpstreamDecision = {
      frame_goal: log.frame.goal,
      model_abstraction: log.model.abstraction,
      commit_hash: log.commit.hash,
      commit_decision: log.commit.decision,
    };

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
    const llmPayload: LLMCallPayload = {
      messages: [{ role: "user", content: req.content }],
      session_id: `${req.channel}:${req.user}`,
      backend_hint: this.llm_route.backend_hint,
      model: this.llm_route.model,
      temperature: this.llm_route.temperature,
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
