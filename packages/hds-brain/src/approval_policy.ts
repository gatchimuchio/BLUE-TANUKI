import { createHash } from "node:crypto";
import { OperationPlanGoalPurposeRelationReviewArgumentsSchema, type ExecuteCommand, type OperationPlanGoalPurposeRelationReviewArguments, type ToolCapability } from "@blue-tanuki/protocol";

/** Approval policy is the human-authority layer above HDS ASSERT. */
export type ApprovalMode = "ask_every_time" | "remember_this_decision" | "full_access";
export type ApprovalDecision = "allow" | "ask" | "deny";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";
export type ApprovalOperation =
  | "noop"
  | "llm.call"
  | "tool.call"
  | "tool.file.read"
  | "tool.file.search"
  | "tool.file.write"
  | "tool.file.edit"
  | "tool.file.delete"
  | "tool.shell.exec"
  | "tool.network.http"
  | "browser.snapshot"
  | "browser.automation"
  | "channel.send"
  | "external.send"
  | "settings.write"
  | "credential.access"
  | "schedule.list"
  | "schedule.create"
  | "schedule.update"
  | "schedule.delete"
  | "schedule.resolve_event"
  | "recovery.restore"
  | "recovery.reset_provider"
  | "recovery.reset_connector"
  | "recovery.factory_reset"
  | "github.write"
  | "google.write"
  | "payment.charge"
  | "unknown";
export type ApprovalScopeKind = "command" | "file" | "folder" | "repo" | "channel" | "task_type" | "global";

/**
 * AuthorityTransparencyTrace is the explicit "no black box in the authority path"
 * claim. It does not pretend that OS kernels, provider LLMs, networks, or tools
 * are internally transparent. It states that BLUE-TANUKI's own authority plane
 * resolves operation/scope/risk/actor/final-review status as structured data,
 * then writes that resolution into the audit chain.
 */
export interface AuthorityTransparencyTrace {
  authority_model: "owner_operated_full_access";
  control_plane_black_boxes: [];
  black_box_boundary: "none_in_hds_authority_path";
  hds_position: "upper_control_self_norm";
  full_access_default: boolean;
  final_review_boundary: ApprovalOperation[];
  resolved_factors: {
    operation: ApprovalOperation;
    target_scope: ApprovalScopeKind;
    risk: ApprovalRisk;
    approval_level: ApprovalLevel;
    actor: string;
    final_review_required: boolean;
    matched_grant_id?: string;
    reason: string;
  };
  audit_closure: {
    decision: "hash_chain";
    approval: "hash_chain";
    execution_feedback: "hash_chain";
  };
}

export interface ApprovalContext {
  operation: ApprovalOperation;
  target_scope: ApprovalScopeKind;
  target?: string;
  path_pattern?: string;
  channel?: string;
  risk: ApprovalRisk;
  actor: string;
  capabilities: ToolCapability[];
  command_type: ExecuteCommand["type"];
  command_id: string;
  upstream_commit_hash: string;
  created_at: number;
}

export interface ApprovalGrant {
  id: string;
  mode: ApprovalMode;
  decision: Exclude<ApprovalDecision, "ask">;
  operation: ApprovalOperation | "*";
  target_scope: ApprovalScopeKind | "*";
  target?: string;
  path_pattern?: string;
  channel?: string;
  risk: ApprovalRisk | "*";
  actor: string | "*";
  capabilities?: ToolCapability[];
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revocable: boolean;
  note?: string;
}

export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  mode: ApprovalMode;
  risk: ApprovalRisk;
  approval_level: ApprovalLevel;
  reason: string;
  matched_grant_id?: string;
  final_review_required: boolean;
  context: ApprovalContext;
  authority_trace: AuthorityTransparencyTrace;
}

const RISK_ORDER: Record<ApprovalRisk, number> = { low: 1, medium: 2, high: 3 };

export const FINAL_REVIEW_OPERATION_LIST = [
  "tool.call",
  "tool.file.edit",
  "tool.file.delete",
  "tool.shell.exec",
  "external.send",
  "credential.access",
  "settings.write",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "schedule.resolve_event",
  "recovery.restore",
  "recovery.reset_provider",
  "recovery.reset_connector",
  "recovery.factory_reset",
  "browser.automation",
  "github.write",
  "google.write",
  "payment.charge",
  "unknown",
] as const satisfies readonly ApprovalOperation[];

export const FINAL_REVIEW_OPERATIONS: ReadonlySet<ApprovalOperation> =
  new Set<ApprovalOperation>(FINAL_REVIEW_OPERATION_LIST);

export function finalReviewOperationList(): ApprovalOperation[] {
  return [...FINAL_REVIEW_OPERATION_LIST];
}

export function goalPurposeChangeApprovalTarget(input: {
  goal_ref: string;
  prior_version: number;
  prior_purpose_digest: string;
  new_purpose_digest: string;
}): string {
  return [
    "goal.governance.change",
    input.goal_ref,
    String(input.prior_version),
    input.prior_purpose_digest,
    input.new_purpose_digest,
  ].join(":");
}

export function goalPurposeRelationReviewApprovalTarget(input: OperationPlanGoalPurposeRelationReviewArguments): string {
  const parsed = OperationPlanGoalPurposeRelationReviewArgumentsSchema.parse(input);
  return ["goal.governance.review_task_purpose", parsed.plan_id_digest, parsed.task_digest, parsed.revision_digest,
    parsed.goal_ref, String(parsed.purpose_version), parsed.purpose_digest, parsed.outcome].join(":");
}

export function meaningUpdateAdoptionApprovalTarget(input: {
  proposal_digest: string;
  candidate_digest: string;
  target_record_id: string;
  target_version: string;
}): string {
  return ["memory.meaning.adopt", input.proposal_digest, input.candidate_digest,
    input.target_record_id, input.target_version].join(":");
}

export function memoryJudgmentReassessmentApprovalTarget(input: {
  citation_request_id: string;
  citation_command_id: string;
  target_record_id: string;
  target_version: string;
  interpretation_id: string;
  judgment_ref: string;
  citation_audit_digest: string;
}): string {
  const binding = [input.citation_request_id, input.citation_command_id, input.target_record_id,
    input.target_version, input.interpretation_id, input.judgment_ref, input.citation_audit_digest].join("\n");
  return `memory.citation.reassess:${createHash("sha256").update(binding, "utf8").digest("hex")}`;
}

export function approvalContextFromCommand(command: ExecuteCommand, opts: { actor?: string; now?: number } = {}): ApprovalContext {
  const actor = opts.actor?.trim() || "local-user";
  const now = opts.now ?? Date.now();
  const caps = command.constraints?.allowed_capabilities ?? [];
  const op = operationFromCommand(command, caps);
  const scope = scopeFromCommand(command, op);
  const risk = riskForOperation(op, caps);
  return {
    operation: op,
    target_scope: scope.target_scope,
    target: scope.target,
    path_pattern: scope.path_pattern,
    channel: scope.channel,
    risk,
    actor,
    capabilities: [...caps],
    command_type: command.type,
    command_id: command.id,
    upstream_commit_hash: command.upstream_decision.commit_hash,
    created_at: now,
  };
}

export function operationFromCommand(command: ExecuteCommand, caps: readonly ToolCapability[] = command.constraints?.allowed_capabilities ?? []): ApprovalOperation {
  if (command.type === "noop") return "noop";
  if (command.type === "tool_call") {
    if (command.payload.tool_name === "recovery.restore") return "recovery.restore";
    if (command.payload.tool_name === "recovery.reset_provider") return "recovery.reset_provider";
    if (command.payload.tool_name === "recovery.reset_connector") return "recovery.reset_connector";
    if (command.payload.tool_name === "recovery.factory_reset") return "recovery.factory_reset";
  }
  if (hasAny(caps, ["credential:read", "credential.access", "secrets:read"])) return "credential.access";
  if (hasAny(caps, ["payment:charge", "billing:write"])) return "payment.charge";
  if (hasAny(caps, ["schedule:read"])) return "schedule.list";
  if (hasAny(caps, ["schedule:resolve_event"])) return "schedule.resolve_event";
  if (hasAny(caps, ["schedule:create", "automation:create"])) return "schedule.create";
  if (hasAny(caps, ["schedule:update", "automation:update"])) return "schedule.update";
  if (hasAny(caps, ["schedule:delete", "automation:delete"])) return "schedule.delete";
  if (hasAny(caps, ["tool:github.write"]) || hasPrefix(caps, "github:")) return "github.write";
  if (
    hasAny(caps, ["tool:gmail.write", "tool:google.calendar.write", "tool:google.drive.write"]) ||
    hasAny(caps, ["google:gmail.write", "google:calendar.write", "google:drive.write"])
  ) return "google.write";
  if (hasAny(caps, ["browser:act", "tool:browser.automation"])) return "browser.automation";
  if (hasAny(caps, ["browser:snapshot", "tool:browser.snapshot"])) return "browser.snapshot";
  if (
    hasPrefix(caps, "secrets:") ||
    hasPrefix(caps, "google:")
  ) return "credential.access";
  if (hasAny(caps, ["settings:write"])) return "settings.write";
  if (hasAny(caps, ["shell:exec", "process:exec"])) return "tool.shell.exec";
  if (hasAny(caps, ["fs:delete", "file:delete"])) return "tool.file.delete";
  if (hasAny(caps, ["tool:file.edit"]) || (command.type === "tool_call" && command.payload.tool_name === "file.edit")) {
    return "tool.file.edit";
  }
  if (hasAny(caps, ["fs:write", "file:write"])) return "tool.file.write";
  if (hasAny(caps, ["fs:read", "file:read"])) {
    if (command.type === "tool_call" && command.payload.tool_name === "file.search") return "tool.file.search";
    return "tool.file.read";
  }
  if (hasAny(caps, ["network:http", "http.fetch"]) || hasPrefix(caps, "network:")) return "tool.network.http";
  if (hasAny(caps, ["external:send", "email:send", "slack:send", "discord:send"])) return "external.send";
  if (command.type === "llm_call") return "llm.call";
  if (command.type === "channel_send") return "channel.send";
  if (command.type === "tool_call") {
    if (command.payload.tool_name === "schedule.list") return "schedule.list";
    if (command.payload.tool_name === "schedule.create") return "schedule.create";
    if (command.payload.tool_name === "schedule.update") return "schedule.update";
    if (command.payload.tool_name === "schedule.delete") return "schedule.delete";
    if (command.payload.tool_name === "schedule.resolve_event") return "schedule.resolve_event";
    if (command.payload.tool_name === "file.search") return "tool.file.search";
    if (command.payload.tool_name === "http.fetch") return "tool.network.http";
    if (command.payload.tool_name === "browser.snapshot") return "browser.snapshot";
    if (command.payload.tool_name === "browser.automation") return "browser.automation";
    return "tool.call";
  }
  return "unknown";
}

export function riskForOperation(op: ApprovalOperation, caps: readonly ToolCapability[] = []): ApprovalRisk {
  if (op === "tool.call" || op === "unknown") return "high";
  if (["credential.access", "payment.charge"].includes(op)) return "high";
  if (["tool.file.delete", "tool.shell.exec", "external.send", "settings.write", "schedule.create", "schedule.update", "schedule.delete", "schedule.resolve_event", "recovery.restore", "recovery.reset_provider", "recovery.reset_connector", "recovery.factory_reset", "browser.automation", "github.write", "google.write"].includes(op)) return "high";
  if (
    ["tool.file.write", "tool.file.edit", "tool.network.http", "browser.snapshot", "channel.send"].includes(op) ||
    hasPrefix(caps, "network:")
  ) return "medium";
  return "low";
}

export function finalReviewRequired(ctx: ApprovalContext): boolean {
  return FINAL_REVIEW_OPERATIONS.has(ctx.operation) || ctx.risk === "high";
}

export function approvalLevelFromContext(ctx: ApprovalContext): ApprovalLevel {
  if (finalReviewRequired(ctx)) return "L3_final_review";
  if (ctx.risk === "low") return "L1_observe";
  return "L2_operate";
}

export function evaluateApproval(command: ExecuteCommand, grants: readonly ApprovalGrant[], opts: { actor?: string; now?: number; default_mode?: ApprovalMode } = {}): ApprovalEvaluation {
  const now = opts.now ?? Date.now();
  const ctx = approvalContextFromCommand(command, { actor: opts.actor, now });
  const defaultMode = opts.default_mode ?? "full_access";
  const needsFinalReview = finalReviewRequired(ctx);
  const approvalLevel = approvalLevelFromContext(ctx);
  const matched = grants.filter((g) => grantMatches(g, ctx, now)).sort((a, b) => specificity(b) - specificity(a))[0];

  const withTrace = (base: Omit<ApprovalEvaluation, "authority_trace">): ApprovalEvaluation => ({
    ...base,
    authority_trace: buildAuthorityTransparencyTrace(ctx, {
      final_review_required: base.final_review_required,
      matched_grant_id: base.matched_grant_id,
      reason: base.reason,
      full_access_default: defaultMode === "full_access",
    }),
  });

  if (matched) {
    if (matched.decision === "deny") {
      return withTrace({ decision: "deny", mode: matched.mode, risk: ctx.risk, approval_level: approvalLevel, reason: `deny_grant_matched:${matched.id}`, matched_grant_id: matched.id, final_review_required: needsFinalReview, context: ctx });
    }
    if (needsFinalReview) {
      return withTrace({ decision: "ask", mode: matched.mode, risk: ctx.risk, approval_level: approvalLevel, reason: `grant_matched_but_final_review_required:${matched.id}`, matched_grant_id: matched.id, final_review_required: true, context: ctx });
    }
    return withTrace({ decision: matched.decision, mode: matched.mode, risk: ctx.risk, approval_level: approvalLevel, reason: `grant_matched:${matched.id}`, matched_grant_id: matched.id, final_review_required: false, context: ctx });
  }
  if (defaultMode === "full_access" && !needsFinalReview) {
    return withTrace({ decision: "allow", mode: "full_access", risk: ctx.risk, approval_level: approvalLevel, reason: "default_full_access_without_final_review_exception", final_review_required: false, context: ctx });
  }
  return withTrace({ decision: "ask", mode: defaultMode, risk: ctx.risk, approval_level: approvalLevel, reason: "no_matching_approval_grant", final_review_required: needsFinalReview, context: ctx });
}

export function buildAuthorityTransparencyTrace(
  ctx: ApprovalContext,
  opts: {
    final_review_required: boolean;
    matched_grant_id?: string;
    reason: string;
    full_access_default?: boolean;
  },
): AuthorityTransparencyTrace {
  return {
    authority_model: "owner_operated_full_access",
    control_plane_black_boxes: [],
    black_box_boundary: "none_in_hds_authority_path",
    hds_position: "upper_control_self_norm",
    full_access_default: opts.full_access_default ?? true,
    final_review_boundary: finalReviewOperationList().sort(),
    resolved_factors: {
      operation: ctx.operation,
      target_scope: ctx.target_scope,
      risk: ctx.risk,
      approval_level: approvalLevelFromContext(ctx),
      actor: ctx.actor,
      final_review_required: opts.final_review_required,
      matched_grant_id: opts.matched_grant_id,
      reason: opts.reason,
    },
    audit_closure: {
      decision: "hash_chain",
      approval: "hash_chain",
      execution_feedback: "hash_chain",
    },
  };
}

export function buildApprovalGrant(input: Omit<ApprovalGrant, "id" | "created_at" | "revocable"> & Partial<Pick<ApprovalGrant, "id" | "created_at" | "revocable">>): ApprovalGrant {
  const created_at = input.created_at ?? Date.now();
  const revocable = input.revocable ?? true;
  const withoutId = { ...input, created_at, revocable, id: undefined };
  const id = input.id ?? createHash("sha256").update(stableJson(withoutId)).digest("hex");
  return { ...input, id, created_at, revocable };
}

export function approvalGrantFromEvaluation(evaluation: ApprovalEvaluation, opts: { created_by: string; mode?: ApprovalMode; decision?: Exclude<ApprovalDecision, "ask">; expires_at?: number | null; widen_to_full_access?: boolean; note?: string }): ApprovalGrant {
  const ctx = evaluation.context;
  const mode = opts.mode ?? "remember_this_decision";
  const full = opts.widen_to_full_access || mode === "full_access";
  return buildApprovalGrant({
    mode,
    decision: opts.decision ?? "allow",
    operation: full ? "*" : ctx.operation,
    target_scope: full ? "*" : ctx.target_scope,
    target: full ? undefined : ctx.target,
    path_pattern: full ? undefined : ctx.path_pattern,
    channel: full ? undefined : ctx.channel,
    risk: full ? "*" : ctx.risk,
    actor: ctx.actor,
    capabilities: full ? undefined : ctx.capabilities,
    created_by: opts.created_by,
    expires_at: opts.expires_at ?? null,
    note: opts.note,
  });
}

export function grantMatches(grant: ApprovalGrant, ctx: ApprovalContext, now = Date.now()): boolean {
  if (grant.expires_at !== null && grant.expires_at <= now) return false;
  if (grant.operation !== "*" && grant.operation !== ctx.operation) return false;
  if (grant.target_scope !== "*" && grant.target_scope !== ctx.target_scope) return false;
  if (grant.actor !== "*" && grant.actor !== ctx.actor) return false;
  if (grant.risk !== "*" && RISK_ORDER[ctx.risk] > RISK_ORDER[grant.risk]) return false;
  if (grant.channel && grant.channel !== ctx.channel) return false;
  if (grant.target && grant.target !== ctx.target) return false;
  if (grant.path_pattern && ctx.path_pattern && grant.path_pattern !== ctx.path_pattern) return false;
  if (grant.capabilities?.length) {
    const s = new Set(ctx.capabilities);
    for (const cap of grant.capabilities) if (!s.has(cap)) return false;
  }
  return true;
}

function scopeFromCommand(command: ExecuteCommand, op: ApprovalOperation): Pick<ApprovalContext, "target_scope" | "target" | "path_pattern" | "channel"> {
  if (command.type === "channel_send") return { target_scope: "channel", channel: command.payload.channel, target: `${command.payload.channel}:${command.payload.target}` };
  if (command.type === "tool_call") {
    const args = command.payload.arguments;
    if (command.payload.tool_name === "goal.governance.change") {
      const goal_ref = typeof args.goal_ref === "string" ? args.goal_ref : "invalid-goal";
      const prior_version = typeof args.prior_version === "number" && Number.isSafeInteger(args.prior_version) && args.prior_version > 0
        ? args.prior_version
        : 0;
      const prior_purpose_digest = typeof args.prior_purpose_digest === "string" && /^[a-f0-9]{64}$/.test(args.prior_purpose_digest)
        ? args.prior_purpose_digest
        : "invalid-prior-digest";
      const new_purpose_digest = typeof args.new_purpose_digest === "string" && /^[a-f0-9]{64}$/.test(args.new_purpose_digest)
        ? args.new_purpose_digest
        : "invalid-new-digest";
      return {
        target_scope: "task_type",
        target: goalPurposeChangeApprovalTarget({ goal_ref, prior_version, prior_purpose_digest, new_purpose_digest }),
      };
    }
    if (command.payload.tool_name === "goal.governance.review_task_purpose") {
      const parsed = OperationPlanGoalPurposeRelationReviewArgumentsSchema.safeParse(args);
      return {
        target_scope: "task_type",
        target: parsed.success ? goalPurposeRelationReviewApprovalTarget(parsed.data) : "goal.governance.review_task_purpose:invalid",
      };
    }
    if (command.payload.tool_name === "memory.meaning.adopt") {
      const proposal_digest = typeof args.proposal_digest === "string" && /^[a-f0-9]{64}$/.test(args.proposal_digest)
        ? args.proposal_digest : "invalid-proposal-digest";
      const candidate_digest = typeof args.candidate_digest === "string" && /^[a-f0-9]{64}$/.test(args.candidate_digest)
        ? args.candidate_digest : "invalid-candidate-digest";
      const target_record_id = typeof args.target_record_id === "string" && /^F:[A-Za-z0-9_.:-]{1,96}$/.test(args.target_record_id)
        ? args.target_record_id : "invalid-target-record";
      const target_version = typeof args.target_version === "string" && /^[a-f0-9]{64}$/.test(args.target_version)
        ? args.target_version : "invalid-target-version";
      return { target_scope: "task_type", target: meaningUpdateAdoptionApprovalTarget({
        proposal_digest, candidate_digest, target_record_id, target_version,
      }) };
    }
    if (command.payload.tool_name === "memory.citation.reassess") {
      const fields = ["citation_request_id", "citation_command_id", "target_record_id", "target_version",
        "interpretation_id", "judgment_ref", "citation_audit_digest"] as const;
      if (fields.some((field) => typeof args[field] !== "string")) {
        return { target_scope: "task_type", target: "memory.citation.reassess:invalid" };
      }
      return { target_scope: "task_type", target: memoryJudgmentReassessmentApprovalTarget({
        citation_request_id: args.citation_request_id as string,
        citation_command_id: args.citation_command_id as string,
        target_record_id: args.target_record_id as string,
        target_version: args.target_version as string,
        interpretation_id: args.interpretation_id as string,
        judgment_ref: args.judgment_ref as string,
        citation_audit_digest: args.citation_audit_digest as string,
      }) };
    }
    if (op === "github.write") {
      const ownerValue = typeof args.owner === "string" ? args.owner : undefined;
      const repoValue = typeof args.repo === "string" ? args.repo : undefined;
      return {
        target_scope: "repo",
        target: ownerValue && repoValue ? `${ownerValue}/${repoValue}` : command.payload.tool_name,
      };
    }
    if (op === "google.write") {
      const operationValue = typeof args.operation === "string" ? args.operation : undefined;
      const calendarId = typeof args.calendar_id === "string" ? args.calendar_id : undefined;
      const eventId = typeof args.event_id === "string" ? args.event_id : undefined;
      const fileId = typeof args.file_id === "string" ? args.file_id : undefined;
      const name = typeof args.name === "string" ? args.name : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      return {
        target_scope: "task_type",
        target: [
          command.payload.tool_name,
          operationValue,
          calendarId,
          eventId,
          fileId,
          name,
          to,
        ].filter(Boolean).join(":") || command.payload.tool_name,
      };
    }
    if (op === "browser.snapshot" || op === "browser.automation") {
      const urlValue = typeof args.url === "string" ? args.url : undefined;
      return {
        target_scope: "task_type",
        target: urlValue ? `${op}:${urlValue}` : command.payload.tool_name,
      };
    }
    if (op === "recovery.restore") {
      const backupId = typeof args.backup_id === "string" ? args.backup_id : undefined;
      const storeKey = typeof args.store_key === "string" ? args.store_key : undefined;
      const scopeKind = typeof args.scope_kind === "string" ? args.scope_kind : undefined;
      const scopeDigest = typeof args.scope_digest === "string" && /^[a-f0-9]{64}$/i.test(args.scope_digest)
        ? args.scope_digest.toLowerCase() : undefined;
      const planScope = storeKey === "operation_plans"
        ? scopeKind === "operation_plan" && scopeDigest
          ? `:effect:whole_store:scope:operation_plan:${scopeDigest}`
          : scopeKind === "task_identity" && scopeDigest
            ? `:effect:task_lineage:scope:task_identity:${scopeDigest}`
          : ":effect:whole_store:scope:missing_or_invalid"
        : "";
      const brokerScope = storeKey !== "broker" ? ""
        : scopeKind === "task_identity" && scopeDigest
          ? `:effect:task_lineage:scope:task_identity:${scopeDigest}`
          : scopeKind === undefined && args.scope_digest === undefined
            ? ""
            : ":effect:task_lineage:scope:missing_or_invalid";
      return {
        target_scope: "task_type",
        target: backupId
          ? storeKey ? `recovery.restore:${backupId}:store:${storeKey}${planScope}${brokerScope}` : `recovery.restore:${backupId}`
          : "recovery.restore:missing-backup-id",
      };
    }
    if (op === "recovery.reset_provider") {
      return { target_scope: "task_type", target: "recovery.reset_provider:provider-configuration" };
    }
    if (op === "recovery.reset_connector") {
      return { target_scope: "task_type", target: "recovery.reset_connector:connector-configuration" };
    }
    if (op === "recovery.factory_reset") {
      return { target_scope: "task_type", target: "recovery.factory_reset:local-runtime-state-and-config" };
    }
    const pathValue = typeof args.path === "string" ? args.path : undefined;
    const rootValue = typeof args.root === "string" ? args.root : undefined;
    const queryValue = typeof args.query === "string" ? args.query : undefined;
    const fileTarget = pathValue ?? rootValue;
    if (fileTarget) return { target_scope: op === "tool.file.read" || op === "tool.file.search" ? "folder" : "file", target: fileTarget, path_pattern: fileTarget };
    if (queryValue) return { target_scope: "task_type", target: `${command.payload.tool_name}:${queryValue}` };
    return { target_scope: "task_type", target: command.payload.tool_name };
  }
  if (command.type === "llm_call") return { target_scope: "task_type", target: "llm_call" };
  if (command.type === "noop") return { target_scope: "task_type", target: "noop" };
  throw new Error(`scopeFromCommand: unhandled command type: ${String((command as ExecuteCommand).type)}`);
}
function hasAny(caps: readonly string[], needles: readonly string[]): boolean { const s = new Set(caps); return needles.some((n) => s.has(n)); }
function hasPrefix(caps: readonly string[], prefix: string): boolean { return caps.some((cap) => cap.startsWith(prefix)); }
function specificity(grant: ApprovalGrant): number { let n = 0; if (grant.operation !== "*") n += 8; if (grant.target_scope !== "*") n += 4; if (grant.target) n += 3; if (grant.path_pattern) n += 3; if (grant.channel) n += 2; if (grant.actor !== "*") n += 2; if (grant.risk !== "*") n += 1; if (grant.capabilities?.length) n += grant.capabilities.length; return n; }
function stableJson(value: unknown): string { const seen = new WeakSet<object>(); const normalize = (v: unknown): unknown => { if (v === undefined) return "[undefined]"; if (typeof v === "bigint") return v.toString(); if (typeof v !== "object" || v === null) return v; if (seen.has(v)) return "[circular]"; seen.add(v); if (Array.isArray(v)) return v.map((item) => normalize(item)); const out: Record<string, unknown> = {}; for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = normalize((v as Record<string, unknown>)[key]); return out; }; return JSON.stringify(normalize(value)); }
