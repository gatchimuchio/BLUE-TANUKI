import * as path from "node:path";
import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";
import {
  approvalGrantFromEvaluation,
  buildApprovalGrant,
  evaluateApproval,
  JsonFileApprovalGrantStore,
  MemoryApprovalGrantStore,
  type ApprovalEvaluation,
  type ApprovalGrant,
  type ApprovalGrantStore,
  type ApprovalMode,
} from "@blue-tanuki/hds-brain";

export interface ApprovalRuntime {
  default_mode: ApprovalMode;
  store: ApprovalGrantStore;
  system_grants: readonly ApprovalGrant[];
  listGrants(): readonly ApprovalGrant[];
  evaluate(command: ExecuteCommand, actor: string): ApprovalEvaluation;
  remember(evaluation: ApprovalEvaluation, opts: RememberApprovalOptions): ApprovalGrant;
  revoke(id: string): boolean;
}
export interface RememberApprovalOptions { actor: string; mode?: "remember_this_decision" | "full_access"; duration_ms?: number | null; note?: string; }
type Env = Record<string, string | undefined>;

export function buildApprovalRuntime(env: Env = process.env): ApprovalRuntime {
  const default_mode = parseApprovalMode(env.BLUE_TANUKI_APPROVAL_MODE);
  const store = env.BLUE_TANUKI_APPROVALS_FILE ? new JsonFileApprovalGrantStore(path.resolve(env.BLUE_TANUKI_APPROVALS_FILE)) : new MemoryApprovalGrantStore();
  const system_grants = buildSystemGrants();
  return {
    default_mode,
    store,
    system_grants,
    listGrants() { store.clearExpired(); return [...system_grants, ...store.list()]; },
    evaluate(command, actor) { store.clearExpired(); return evaluateApproval(command, [...system_grants, ...store.list()], { actor, default_mode }); },
    remember(evaluation, opts) {
      const mode = opts.mode ?? "remember_this_decision";
      const expires_at = opts.duration_ms === null ? null : typeof opts.duration_ms === "number" && opts.duration_ms > 0 ? Date.now() + Math.floor(opts.duration_ms) : null;
      const grant = approvalGrantFromEvaluation(evaluation, { created_by: opts.actor, mode, expires_at, widen_to_full_access: mode === "full_access", note: opts.note ?? "created from human approval" });
      return store.add(grant);
    },
    revoke(id) {
      store.clearExpired();
      return store.revoke(id);
    },
  };
}

export function approvalRequiredMessage(evaluation: ApprovalEvaluation, command_id: string, approval_token?: string): string {
  const ctx = evaluation.context;
  return [
    "[approval-required] Executor command is waiting for human approval.",
    `command_id=${command_id}`,
    `operation=${ctx.operation}`,
    `scope=${ctx.target_scope}`,
    ctx.target ? `target=${ctx.target}` : null,
    `risk=${evaluation.risk}`,
    `approval_level=${evaluation.approval_level}`,
    `mode=${evaluation.mode}`,
    evaluation.final_review_required ? "final_review_required=true" : null,
    `reason=${evaluation.reason}`,
    approval_token ? `approval_token=${approval_token}` : null,
    "Approve via POST /resume with request_id=<command_id> and verdict=approve.",
    "To remember: include remember=true and optional duration_ms, or approval_mode=full_access.",
  ].filter(Boolean).join(" ");
}

export function approvalDeniedFeedback(command: ExecuteCommand, reason: string): ExecuteFeedback {
  return { command_id: command.id, status: "failed", error: `approval_denied:${reason}`, metrics: { duration_ms: 0 } };
}
function parseApprovalMode(value: string | undefined): ApprovalMode { return value === "remember_this_decision" || value === "full_access" || value === "ask_every_time" ? value : "full_access"; }
function buildSystemGrants(): ApprovalGrant[] {
  const created_at = 0;
  return [
    buildApprovalGrant({ id: "system-allow-llm-call", mode: "remember_this_decision", decision: "allow", operation: "llm.call", target_scope: "task_type", target: "llm_call", risk: "low", actor: "*", created_by: "system", created_at, expires_at: null, revocable: false, note: "Default local chat allowance: chat generation is not an external side effect." }),
    buildApprovalGrant({ id: "system-allow-noop", mode: "remember_this_decision", decision: "allow", operation: "noop", target_scope: "task_type", target: "noop", risk: "low", actor: "*", created_by: "system", created_at, expires_at: null, revocable: false, note: "No-op commands are safe to complete without human interruption." }),
  ];
}
