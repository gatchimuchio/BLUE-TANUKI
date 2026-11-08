import { afterAll, describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { AuditLog, CompleteHistoryStore, HDSUpperController, evaluateApproval, goalGovernanceEventDigest, operationPlanDigest,
  operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import { Executor, ToolRegistry, createExecutorApprovalAuthority, fileDeleteTool, fileEditTool, fileSearchTool, fileWriteTool, invokeShellExec, shellExecTool,
  githubWriteTool, LLMComputeAdapter, LLMRegistry, type ComputeBudgetPort, type ExecutorApprovalClock, type LLMRequest, type LLMResponse } from "@blue-tanuki/core";
import { createGatewayInternalInboundRequest, githubIssueCreateRequestPayloadDigest, githubIssueCreateTargetIdentityDigest,
  githubIssueUpdateRequestPayloadDigest, githubIssueUpdateTargetIdentityDigest,
  githubIssueCommentCreateRequestPayloadDigest, githubIssueCommentCreateTargetIdentityDigest,
  githubPullRequestCommentCreateRequestPayloadDigest, githubPullRequestCommentCreateTargetIdentityDigest,
  githubPullRequestCreateRequestPayloadDigest, githubPullRequestCreateTargetIdentityDigest,
  GitHubWriteTargetVersionObservationSchema, memoryCommitContentDigest, type ExecuteCommand, type OperationPlan, type InboundRequest } from "@blue-tanuki/protocol";
import { GatewayExecutionIntentStore } from "../src/execution_intent_store.js";
import { OperationPlanStateStore } from "../src/operation_plan_store.js";
import { createFileSearchWorker } from "../src/file_search_worker.js";
import { executionAdmissionForCommand, reconcileExecutionResults, reconcileStartupExecutionState } from "../src/reconcile_execution_results.js";
import { finalizeCommandOutput } from "../src/finalize_command_output.js";
import { projectOperationPlanStatus } from "../src/serve_projection.js";
import { goalPurposeMemoryStorage, operationResultMemoryStorage } from "../src/operation_result_memory_config.js";
import { operationPlanRecoveryEvidenceFromObservation } from "../src/operation_plan_recovery_evidence.js";
import { correlateOperationPlanBindings, inspectGatewayRecoveryState } from "../src/recovery_inspection.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== "object" || input === null) return input;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      output[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return output;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
const githubInlinePatch = "@@ -9,2 +9,2 @@\n context line\n-old synthetic diff value\n+new synthetic diff value";
const githubInlineRangePatch = "@@ -9,3 +9,1 @@\n-old synthetic diff value 9\n-old synthetic diff value 10\n-old synthetic diff value 11\n+new synthetic diff value";
function planTaskIdentityDigest(owner: string, channel: string, task: string, planId: string, requestId: string): string {
  return operationPlanDigest({
    schema_version: "blue-tanuki.operation-plan-task-identity.v1",
    owner_digest: operationPlanDigest(owner),
    channel_digest: operationPlanDigest(channel),
    task_digest: operationPlanDigest(task),
    plan_id_digest: operationPlanDigest(planId),
    request_id_digest: operationPlanDigest(requestId),
  });
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const servedGatewayTempRoots: string[] = [];
afterAll(() => {
  for (const tempRoot of servedGatewayTempRoots) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
function request(content: string, user = "fixture-owner"): InboundRequest {
  return createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user, timestamp: Date.now(), content,
    metadata: { "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.operator_surface": "developer" } });
}
function recoveryCommandIdDigest(commandId: string): string { return createHash("sha256").update(commandId).digest("hex"); }
function taskMemoryRestorePoints(state: OperationPlanStateStore,
  dependencyStatus: "observed" | "residuals_present" | "unobserved" | "unknown" = "observed") {
  const plans = state.load()?.plans ?? [];
  const groups = new Map<string, string[]>();
  for (const plan of plans) {
    const taskDigest = operationPlanTaskIdentityDigest(plan);
    groups.set(taskDigest, [...(groups.get(taskDigest) ?? []), operationPlanDigest(plan.revisions[0]!.plan.plan_id)]);
  }
  return [...groups.entries()].map(([task_identity_digest, plan_id_digests]) => ({
    task_identity_digest,
    plan_id_digests: plan_id_digests.sort(),
    dependency_status: dependencyStatus,
  }));
}
function canonicalMemoryRestoreCommand(): ExecuteCommand {
  return { id: randomUUID(), type: "tool_call",
    payload: { tool_name: "recovery.restore", arguments: { backup_id: "fixture", store_key: "m_state", confirm: "RESTORE" } },
    upstream_decision: { request_id: randomUUID(), commit_hash: "a".repeat(64), commit_decision: "ASSERT" },
  } as unknown as ExecuteCommand;
}
function candidate(id: string, root: string): OperationPlan {
  const target = { kind: "directory" as const, id: root };
  const output = { root, sandbox_root: root, query: "blue", visited_files: 1, matches: [{ path: "blue.txt", line_number: 1, line: "blue" }] };
  const step = (step_id: string) => ({ step_id, operation: "file.search", target, state: "planned" as const, effects: ["read" as const],
    permission: { risk: "low" as const, approval_level: "L1_observe" as const, final_review_required: false,
      hds_brain_authority_required: true as const, approval_gate_required: true },
    adapter: "internal_runtime" as const, adapter_is_authority: false as const, command_generated_by_adapter_only: false,
    parameters: { root, query: "blue", max_results: 1 }, preparation: { depends_on: [] as string[], bindings: [], preconditions: [],
      validation: [{ check_id: step_id, method: "result_equals" as const, target, expected: output }],
      compensation: { available: false as const, reason: "read-only" } } });
  const first = step("search"); const next = step("dependent"); next.preparation.depends_on = ["search"];
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned", steps: [first, next],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileWriteCandidate(id: string, root: string, expectedByteAdjustment = 0): OperationPlan {
  const content = "synthetic planned file content\n";
  const target = { kind: "file" as const, id: "notes.txt" };
  const output = { path: "notes.txt", sandbox_root: root, mode: "create",
    bytes_written: Buffer.byteLength(content) + expectedByteAdjustment };
  return { version: "operation-core.v1", plan_id: `plan-${id}`, request_id: id, state: "planned",
    steps: [{ step_id: "create-note", operation: "file.write", target, state: "planned", effects: ["write"],
      permission: { risk: "medium", approval_level: "L2_operate", final_review_required: false,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", content, mode: "create" }, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "created-note", method: "result_equals", target, expected: output }],
        compensation: { available: false, reason: "new file cleanup requires owner direction" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileWriteWithDependentCandidate(id: string, root: string): OperationPlan {
  const writePlan = fileWriteCandidate(id, root);
  const search = candidate(id, root).steps[0]!;
  if (!search.preparation) throw new Error("synthetic dependent search preparation is missing");
  const dependent: OperationPlan["steps"][number] = {
    ...search,
    step_id: "verify-note",
    preparation: { ...search.preparation, depends_on: ["create-note"] },
  };
  return { ...writePlan, steps: [writePlan.steps[0]!, dependent] };
}
function fileDeleteCandidate(id: string): OperationPlan {
  const target = { kind: "file" as const, id: "notes.txt" };
  return { version: "operation-core.v1", plan_id: "plan-" + id, request_id: id, state: "planned",
    steps: [{ step_id: "delete-note", operation: "file.delete", target, state: "planned", effects: ["delete"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", max_bytes: 128 }, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "deleted-note", method: "result_equals", target, expected: { deleted: true } }],
        compensation: { available: false, reason: "file deletion requires a new owner-reviewed create operation to recover" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
function fileEditCandidate(id: string): OperationPlan {
  const target = { kind: "file" as const, id: "notes.txt" };
  const output = { edited: true, replacements: 1, bytes_written: Buffer.byteLength("synthetic edited text\n") };
  return { version: "operation-core.v1", plan_id: "plan-" + id, request_id: id, state: "planned",
    steps: [{ step_id: "edit-note", operation: "file.edit", target, state: "planned", effects: ["read", "write"],
      permission: { risk: "medium", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "internal_runtime", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: { path: "notes.txt", search: "original", replace: "edited", expected_replacements: 1, max_bytes: 128 },
      preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "edited-note", method: "result_equals", target, expected: output }],
        compensation: { available: false, reason: "an in-place edit requires a newly reviewed edit to restore" } } }],
    rollback: { available: false }, raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}
type GitHubWriteOperation = "issue.create" | "issue.update" | "issue.comment.create" | "pr.create" | "pr.comment.create";
type GitHubWriteCase = { operation: GitHubWriteOperation; comment_kind?: "pull_request_review_inline"; inline_range?: boolean };
const githubWriteCases: readonly GitHubWriteCase[] = [
  { operation: "issue.create" },
  { operation: "issue.update" },
  { operation: "issue.comment.create" },
  { operation: "pr.create" },
  { operation: "pr.comment.create" },
  { operation: "pr.comment.create", comment_kind: "pull_request_review_inline" },
  { operation: "pr.comment.create", comment_kind: "pull_request_review_inline", inline_range: true },
];
type GitHubWriteScenario = {
  operation: GitHubWriteOperation;
  step_id: string;
  parameters: NonNullable<OperationPlan["steps"][number]["parameters"]>;
  target_identity_digest: string;
  request_payload_digest: string;
  target_fields: Record<string, unknown>;
  method: "POST" | "PATCH";
  path: string;
  accepted_status: 200 | 201;
  accepted_provider_response: Record<string, unknown>;
  accepted_result: Record<string, unknown>;
  private_values: string[];
};

function githubWriteScenario(operation: GitHubWriteOperation, commentKind?: "pull_request_review_inline", range = false): GitHubWriteScenario {
  const owner = "fixture-owner";
  const repo = "synthetic-repo";
  const canonicalFullName = `${owner}/${repo}`;
  const repositoryId = 424242;
  const number = 7;
  const issueUpdatedAt = "2026-11-08T01:02:03.000Z";
  const pullRequestUpdatedAt = "2026-11-08T01:02:04.000Z";
  const title = "synthetic issue title";
  const body = "synthetic issue body never retained in M";
  if (operation === "issue.create") {
    return { operation, step_id: "write-issue-create",
      parameters: { operation, owner, repo, title, body },
      target_identity_digest: githubIssueCreateTargetIdentityDigest({ repository_id: repositoryId, canonical_full_name: canonicalFullName }),
      request_payload_digest: githubIssueCreateRequestPayloadDigest({ owner, repo, title, body }), target_fields: {},
      method: "POST", path: `/repos/${owner}/${repo}/issues`, accepted_status: 201,
      accepted_provider_response: { id: 42, number, title, body },
      accepted_result: { id: 42, number, title }, private_values: [title, body] };
  }
  if (operation === "issue.update") {
    const updatedTitle = "synthetic updated issue title";
    const updatedBody = "synthetic updated issue body never retained in M";
    return { operation, step_id: "write-issue-update",
      parameters: { operation, owner, repo, number, title: updatedTitle, body: updatedBody },
      target_identity_digest: githubIssueUpdateTargetIdentityDigest({ repository_id: repositoryId, canonical_full_name: canonicalFullName,
        issue_id: 424243, issue_number: number }),
      request_payload_digest: githubIssueUpdateRequestPayloadDigest({ owner, repo, issue_number: number, title: updatedTitle, body: updatedBody }),
      target_fields: { issue_id: 424243, issue_number: number, issue_state: "open", issue_locked: false,
        issue_updated_at: issueUpdatedAt, issue_title: "prior synthetic issue title", issue_body: "prior synthetic issue body" },
      method: "PATCH", path: `/repos/${owner}/${repo}/issues/${number}`, accepted_status: 200,
      accepted_provider_response: { id: 424243, number, state: "open", locked: false, updated_at: "2026-11-08T01:02:05.000Z",
        title: updatedTitle, body: updatedBody },
      accepted_result: { id: 424243, number, state: "open", locked: false, title: updatedTitle },
      private_values: [updatedTitle, updatedBody, "prior synthetic issue title", "prior synthetic issue body"] };
  }
  if (operation === "issue.comment.create") {
    const comment = "synthetic issue comment body never retained in M";
    return { operation, step_id: "write-issue-comment",
      parameters: { operation, owner, repo, number, body: comment },
      target_identity_digest: githubIssueCommentCreateTargetIdentityDigest({ repository_id: repositoryId, canonical_full_name: canonicalFullName,
        issue_id: 424244, issue_number: number }),
      request_payload_digest: githubIssueCommentCreateRequestPayloadDigest({ owner, repo, issue_number: number, body: comment }),
      target_fields: { issue_id: 424244, issue_number: number, issue_state: "open", issue_locked: false, issue_updated_at: issueUpdatedAt },
      method: "POST", path: `/repos/${owner}/${repo}/issues/${number}/comments`, accepted_status: 201,
      accepted_provider_response: { id: 42_445, body: comment }, accepted_result: { id: 42_445 }, private_values: [comment] };
  }
  if (operation === "pr.comment.create") {
    const comment = "synthetic pull request comment body never retained in M";
    const path = "src/inline-review.ts";
    const inline = commentKind === "pull_request_review_inline";
    const inlineRange = inline && range;
    const line = inlineRange ? 9 : 10;
    const side = "RIGHT" as const;
    const startLine = inlineRange ? 11 : undefined;
    const startSide = inlineRange ? "LEFT" as const : undefined;
    const headSha = "c".repeat(40);
    const baseSha = "d".repeat(40);
    const patch = inlineRange ? githubInlineRangePatch : githubInlinePatch;
    const inlineTargetFields = inline ? {
      comment_kind: "pull_request_review_inline" as const,
      path,
      ...(inlineRange ? { start_line: startLine, start_side: startSide } : {}),
      line,
      side,
      pull_request_head_sha: headSha,
      pull_request_base_sha: baseSha,
      pull_request_diff_digest: stableHash({ schema_version: inlineRange
        ? "blue-tanuki.github-pull-request-inline-diff-range.v1"
        : "blue-tanuki.github-pull-request-inline-diff.v1",
        path, ...(inlineRange ? { start_line: startLine, start_side: startSide } : {}),
        line, side, head_sha: headSha, base_sha: baseSha, file_status: "modified", patch }),
    } : {};
    return { operation, step_id: "write-pr-comment",
      parameters: { operation, owner, repo, number, body: comment,
        ...(inline ? { comment_kind: "pull_request_review_inline", path,
          ...(inlineRange ? { start_line: startLine, start_side: startSide } : {}), line, side } : {}) },
      target_identity_digest: githubPullRequestCommentCreateTargetIdentityDigest({ repository_id: repositoryId,
        canonical_full_name: canonicalFullName, pull_request_id: 424246, pull_request_number: number }),
      request_payload_digest: githubPullRequestCommentCreateRequestPayloadDigest({ owner, repo,
        pull_request_number: number, body: comment, ...(inline ? { path,
          ...(inlineRange ? { start_line: startLine, start_side: startSide } : {}), line, side } : {}) }),
      target_fields: { pull_request_id: 424246, pull_request_number: number, pull_request_state: "open",
        pull_request_locked: false, pull_request_updated_at: pullRequestUpdatedAt, ...inlineTargetFields },
      method: "POST", path: inline ? `/repos/${owner}/${repo}/pulls/${number}/comments`
        : `/repos/${owner}/${repo}/issues/${number}/comments`, accepted_status: 201,
      accepted_provider_response: inline
        ? { id: 42_447, body: comment, path, ...(inlineRange ? { start_line: startLine, start_side: startSide } : {}),
          line, side, commit_id: headSha,
          pull_request_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}` }
        : { id: 42_447, body: comment, issue_url: `https://api.github.com/repos/${owner}/${repo}/issues/${number}` },
      accepted_result: { id: 42_447 },
      private_values: [comment, "synthetic pull request target title", ...(inline ? ["old synthetic diff value", "new synthetic diff value"] : [])] };
  }
  const prTitle = "synthetic pull request title";
  const prBody = "synthetic pull request body never retained in M";
  const head = "feature/synthetic";
  const base = "main";
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  return { operation, step_id: "write-pr-create",
    parameters: { operation, owner, repo, title: prTitle, body: prBody, head, base, draft: true, maintainer_can_modify: false },
    target_identity_digest: githubPullRequestCreateTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: canonicalFullName, head_ref: head, base_ref: base }),
    request_payload_digest: githubPullRequestCreateRequestPayloadDigest({ owner, repo, title: prTitle, body: prBody,
      head_ref: head, base_ref: base, draft: true, maintainer_can_modify: false }),
    target_fields: { head_ref: head, head_commit_sha: headSha, base_ref: base, base_commit_sha: baseSha,
      draft: true, maintainer_can_modify: false },
    method: "POST", path: `/repos/${owner}/${repo}/pulls`, accepted_status: 201,
    accepted_provider_response: { id: 42_448, number, title: prTitle, body: prBody, state: "open", draft: true,
      maintainer_can_modify: false, head: { ref: head, sha: headSha, repo: { id: repositoryId } },
      base: { ref: base, sha: baseSha, repo: { id: repositoryId } } },
    accepted_result: { id: 42_448, number, title: prTitle, head_ref: head, head_commit_sha: headSha,
      base_ref: base, base_commit_sha: baseSha, draft: true, maintainer_can_modify: false },
    private_values: [prTitle, prBody] };
}

function githubWriteCandidate(id: string, scenario = githubWriteScenario("issue.create")): OperationPlan {
  const target = { kind: "external_service" as const, id: "github" };
  return { version: "operation-core.v1", plan_id: `github-plan-${id}`, request_id: id, state: "planned",
    steps: [{ step_id: scenario.step_id, operation: "github.write", target, state: "planned",
      effects: ["external_send", "write", "credential_access"],
      permission: { risk: "high", approval_level: "L3_final_review", final_review_required: true,
        hds_brain_authority_required: true, approval_gate_required: true },
      adapter: "external_api", adapter_is_authority: false, command_generated_by_adapter_only: false,
      parameters: scenario.parameters, preparation: { depends_on: [], bindings: [], preconditions: [],
        validation: [{ check_id: "github-write-receipt", method: "github_write_result_matches", target,
          expected: { schema_version: "blue-tanuki.github-write-result-validation.v1", operation: scenario.operation } }],
        compensation: { available: false, reason: "An accepted GitHub write cannot be automatically retracted." } } }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false, hds_brain_authority_required: true };
}

function mockSyntheticGitHubWrite(mode: "accepted" | "rejected" | "unknown", scenario = githubWriteScenario("issue.create")): void {
  vi.spyOn(githubWriteTool, "inspect_target_version").mockImplementation(async (args, options) => {
    const owner = String(args.owner);
    const repo = String(args.repo);
    if (args.operation !== scenario.operation) throw new Error("synthetic github operation changed");
    if (!options?.command_digest || !options.operation_plan_binding_digest) {
      throw new Error("synthetic github target inspection is missing command binding");
    }
    return GitHubWriteTargetVersionObservationSchema.parse({
      schema_version: "blue-tanuki.github-write-target-version.v1", operation: scenario.operation,
      repository_id: 424242, requested_owner: owner, requested_repo: repo, canonical_full_name: `${owner}/${repo}`,
      repository_visibility: "public",
      target_identity_digest: scenario.target_identity_digest,
      request_payload_digest: scenario.request_payload_digest,
      command_digest: options.command_digest, operation_plan_binding_digest: options.operation_plan_binding_digest,
      ...scenario.target_fields,
      provider_observation_is_atomic: false, provider_data_is_untrusted: true, mutation_sent: false,
      used_for_authority: false, may_execute: false,
    });
  });
  vi.spyOn(githubWriteTool, "invoke").mockImplementation(async (args, context) => {
    if (mode === "unknown") throw new Error("synthetic provider timeout after dispatch");
    const target = context.target_version_observation;
    if (target?.schema_version !== "blue-tanuki.github-write-target-version.v1") {
      throw new Error("synthetic github target observation missing");
    }
    const common = {
      schema_version: "blue-tanuki.github-write-result.v1", operation: scenario.operation, api_host: "api.github.com",
      repo: `${String(args.owner)}/${String(args.repo)}`, repository_id: target.repository_id,
      target_identity_digest: target.target_identity_digest, request_payload_digest: target.request_payload_digest,
      command_digest: target.command_digest, operation_plan_binding_digest: target.operation_plan_binding_digest,
      method: scenario.method, path: scenario.path,
      result_digest: mode === "accepted" ? hash(scenario.accepted_provider_response) : "c".repeat(64),
      provider_data_is_untrusted: true, used_for_authority: false, may_execute: false,
    };
    if (mode === "rejected") return { ...common, status: 403, mutation_status: "provider_rejected",
      retry_permitted: false,
      next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision." };
    return { ...common, status: scenario.accepted_status, mutation_status: "provider_accepted", content_type: "application/json",
      truncated: false, rate_limit_remaining: null, github_request_id: null,
      result: scenario.accepted_result };
  });
}
function review(hds: HDSUpperController, plan: OperationPlan, step_id: string) {
  const p = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:review ${JSON.stringify({ plan_id: plan.plan_id, revision_digest: p.revision_digest, step_id })}`)).command;
}
async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  planFactory: (id: string, root: string) => OperationPlan = candidate,
  prepareWorkspace?: (workspace: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "blue-result-reconcile-")); const workspace = join(root, "workspace");
  mkdirSync(workspace); writeFileSync(join(workspace, "blue.txt"), "blue\n");
  prepareWorkspace?.(workspace);
  vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
  const context = await setup(root, workspace, planFactory);
  try { await run(context); } finally {
    for (const hds of context.controllers) { hds.closeOperationPlanMemory(); hds.close(); }
    context.execution.close(); context.j.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}
async function setup(root: string, workspace: string, planFactory: (id: string, root: string) => OperationPlan = candidate,
  owner = "fixture-owner") {
  const context = await setupInternal(root, workspace, planFactory, owner, true);
  if (!("cmd" in context)) throw new Error("prepared setup did not select an Operation Plan step");
  return context;
}

async function setupPlanOnly(root: string, workspace: string,
  planFactory: (id: string, root: string) => OperationPlan = candidate, owner = "fixture-owner") {
  const context = await setupInternal(root, workspace, planFactory, owner, false);
  if ("cmd" in context) throw new Error("plan-only setup unexpectedly selected an Operation Plan step");
  return context;
}

async function setupInternal(root: string, workspace: string, planFactory: (id: string, root: string) => OperationPlan,
  owner: string, prepareReviewedStep: boolean) {
  const executionPath = join(root, "executor.sqlite"); const jPath = join(root, "j.sqlite"); const executionEpoch = randomUUID();
  const execution = new GatewayExecutionIntentStore(executionPath, executionEpoch); const j = new OperationPlanStateStore(jPath);
  const memory = operationResultMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") });
  const hostWallNow = Date.now.bind(Date);
  let harnessWallFloor = Math.max(1, hostWallNow());
  const harnessWallNow = () => {
    harnessWallFloor = Math.max(harnessWallFloor, hostWallNow());
    return harnessWallFloor;
  };
  const controllers: HDSUpperController[] = [];
  const oldMemory = { capture: vi.fn(), recent: vi.fn(() => []), all: vi.fn(() => []) };
  function createHds(state = j, installPurpose = false) {
    const controller = new HDSUpperController({ operation_plan_state: state, operation_plan_memory: memory, memory: oldMemory,
      wall_clock: harnessWallNow,
      ...(installPurpose ? { audit: new AuditLog({ filepath: join(root, "audit.jsonl") }),
        goal_purpose_memory: goalPurposeMemoryStorage({ BLUE_TANUKI_STATE_ROOT: join(root, "state") }),
        goal_governance: testGoalGovernance() } : {}) });
    controllers.push(controller); return controller;
  }
  const hds = createHds();
  const origin = request("plan:compute 合成の実行結果を後続へ安全に返す", owner);
  const plan = planFactory(origin.id, workspace); const tools = new ToolRegistry();
  tools.register(fileSearchTool); tools.register(fileWriteTool); tools.register(fileDeleteTool); tools.register(fileEditTool); tools.register(shellExecTool);
  tools.register(githubWriteTool);
  // HDS and approval share a monotonic wall-clock floor; the executor worker still observes the real host clock.
  // Executor rollback/expiry behavior is covered by execution_intent_runtime.test.ts.
  let approvalMonotonicMs = 0;
  const approvalClock: ExecutorApprovalClock = {
    wallNow: harnessWallNow,
    monotonicNow: () => ++approvalMonotonicMs,
  };
  const authority = createExecutorApprovalAuthority({ execution_store: execution, execution_epoch: executionEpoch,
    require_hds_execution_binding: true, clock: approvalClock });
  const actualWorker = createFileSearchWorker({ execution_epoch: executionEpoch,
    env: { SystemRoot: process.env.SystemRoot, BLUE_TANUKI_FILE_ROOT: workspace } });
  const invoke = vi.fn(actualWorker.invoke); const worker = { invoke };
  const fixtureLlmCall = vi.fn(async () => ({ content: JSON.stringify(plan), model: "fixture-model", tokens_used: 0 }));
  const fixtureBackend = { name: "fixture", call: fixtureLlmCall };
  const llm = new LLMRegistry({ retry: { max_attempts: 1 } }).register(fixtureBackend, [], {
    capabilities: ["llm.text.generate"], max_cost_per_attempt: { amount: 0.01, currency: "USD" },
  }).setDefault("fixture");
  const computeBudget: ComputeBudgetPort = {
    reserve(input) {
      return { reservation_id: randomUUID(), reserved_tokens: input.reserved_tokens,
        reserved_compute_ms: input.reserved_compute_ms, reserved_cost: structuredClone(input.reserved_cost) };
    },
    settle() {},
  };
  const executor = new Executor({ tools, approval_authority: authority, file_search_worker: worker, llm,
    compute: new LLMComputeAdapter(llm, computeBudget), on_agent_worker_lifecycle: () => true });
  const execute = executor.execute.bind(executor);
  vi.spyOn(executor, "execute").mockImplementation(async (command, context) => {
    const feedback = await execute(command, context);
    const observedAt = feedback.operation_core_result?.observed_at_ms;
    if (observedAt !== undefined) harnessWallFloor = Math.max(harnessWallFloor, observedAt);
    return feedback;
  });
  async function approve(cmd: ExecuteCommand) {
    const a = evaluateApproval(cmd, [], { actor: "fixture-owner", default_mode: "full_access" });
    const operationPlanBindingDigest = hds.getExecutionOperationPlanBindingDigest(cmd);
    const targetVersion = await executor.inspectCommandTargetVersion(cmd, undefined, operationPlanBindingDigest);
    const hdsBinding = hds.createExecutionAuthorityBinding(cmd, targetVersion);
    return authority.approve(cmd, { source: a.final_review_required ? "human_final_review" : "approval_gate",
      decision: a.final_review_required ? "approve" : "allow",
      approved_by: "fixture-owner", approved_at_ms: harnessWallNow(), upstream_commit_hash: cmd.upstream_decision.commit_hash,
      operation: a.context.operation, risk: a.risk, final_review_required: a.final_review_required, reason: "fixture" },
      undefined, hdsBinding, targetVersion);
  }
  const initial = hds.decide(origin).command!; const first = await executor.execute(await approve(initial));
  finalizeCommandOutput({ hds, command: initial, feedback: first, request_id: origin.id, target_surface: "channel" });
  const advanceWallClockTo = (timestamp: number) => {
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("fixture clock target is invalid");
    harnessWallFloor = Math.max(harnessWallFloor, timestamp);
  };
  const baseContext = { root, workspace, executionPath, jPath, execution, j, hds, plan, authority, executor, invoke, memory,
    controllers, createHds, approve, advanceWallClockTo, currentWallClock: harnessWallNow, oldMemory, purposeBinding: undefined as
      { goal_ref: string; purpose_version: number; purpose_digest: string } | undefined };
  if (!prepareReviewedStep) return baseContext;
  const cmd = review(hds, plan, plan.steps[0]!.step_id)!; const approved = await approve(cmd);
  const admission = executionAdmissionForCommand(cmd, authority.receipt(approved));
  return { ...baseContext, cmd, approved, admission };
}

function testGoalGovernance() {
  const event = { event_ref: "ge_0123456789abcdef", event_kind: "purpose_change" as const,
    goal_ref: "goal_0123456789abcdef", source_ref: "F:0123456789abcdef", goal_kind: "delegated" as const,
    prior_version: 1, new_version: 2, prior_purpose_digest: "a".repeat(64), new_purpose_digest: "e".repeat(64),
    authority_kind: "owner" as const, authorization_ref: "ga_0123456789abcdef", recorded_at: 100, effective_from: 500 };
  return { schema_version: "blue-tanuki.goal-governance.v1" as const,
    goals: [{ goal_ref: event.goal_ref, goal_kind: event.goal_kind, source_ref: event.source_ref,
      initial_purpose_digest: "a".repeat(64), initial_interpretation_digest: "b".repeat(64), adopted_at: 0 }],
    authorizations: [{ authorization_ref: event.authorization_ref, event_ref: event.event_ref,
      event_digest: goalGovernanceEventDigest(event), goal_ref: event.goal_ref, event_kind: event.event_kind,
      authority_kind: event.authority_kind, authorized_at: event.recorded_at }], events: [event] };
}

function installTestPurpose(hds: HDSUpperController) {
  const purposeText = "Keep synthetic file action results as non-authoritative history and ask for fresh evidence before claiming current state.";
  const purposeDigest = createHash("sha256").update(purposeText, "utf8").digest("hex");
  const binding = { goal_ref: "goal_0123456789abcdef", purpose_version: 3, purpose_digest: purposeDigest };
  const requestId = randomUUID();
  const command: ExecuteCommand = { id: randomUUID(), type: "tool_call",
    payload: { tool_name: "goal.governance.change", arguments: { goal_ref: binding.goal_ref,
      prior_version: 2, prior_purpose_digest: "e".repeat(64), new_purpose_digest: purposeDigest } },
    constraints: { allowed_tools: ["goal.governance.change"], allowed_capabilities: ["tool:goal.governance.change"] },
    upstream_decision: { request_id: requestId, frame_goal: "Review a synthetic delegated-goal purpose update.",
      model_abstraction: "test", commit_hash: "a".repeat(64), commit_decision: "ASSERT" } };
  const evaluation = evaluateApproval(command, [], { actor: "webchat-owner-token-holder", default_mode: "full_access" });
  hds.onApprovalEvaluation(evaluation, { request_id: requestId });
  hds.onCommandLifecycle(command.id, "approval_approved", { actor: "webchat-resume-token-holder",
    reason: "human_approval:approve", request_id: requestId });
  const committed = hds.commitGoalPurposeChangeAfterL3({ goal_ref: binding.goal_ref, prior_version: 2,
    prior_purpose_digest: "e".repeat(64), new_purpose_digest: purposeDigest, purpose_text: purposeText,
    request_id: requestId, command_id: command.id, proposal_actor: "webchat-owner-token-holder",
    actor: "webchat-resume-token-holder", evaluation });
  if (!committed.ok) throw new Error(`synthetic purpose setup failed: ${committed.reason}`);
  return binding;
}

function inspectMemory(c: Awaited<ReturnType<typeof setup>>) {
  const db = new DatabaseSync(c.memory.memory_database_path);
  try {
    const revision = db.prepare("SELECT revision FROM m_state").get()!.revision;
    const rows = db.prepare("SELECT value_json FROM m_records").all();
    const receipts = db.prepare("SELECT receipt_json FROM m_receipts").all();
    return { revision, records: rows.map((r) => JSON.parse(String(r.value_json))), receipts: receipts.map((r) => JSON.parse(String(r.receipt_json))) };
  } finally { db.close(); }
}

describe("保存実結果→再起動J→依存stepの非作用調停", () => {
  for (const writeCase of githubWriteCases) {
    const { operation } = writeCase;
    const operationLabel = `${operation}${writeCase.comment_kind === "pull_request_review_inline" ? " inline diff" : ""}` +
      `${writeCase.inline_range ? " range" : ""}`;
    it(`github.write ${operationLabel}受理をJの束縛・digest-only M・Owner照会まで運ぶ`, async () => {
      const scenario = githubWriteScenario(operation, writeCase.comment_kind, writeCase.inline_range);
      await fixture(async (c) => {
        expect(c.cmd.payload.tool_name).toBe("github.write");
        expect(c.cmd.payload.arguments.operation).toBe(operation);
        expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
        const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
        expect(feedback.status, feedback.error).toBe("success");
        expect(feedback.operation_core_result).toMatchObject({ action_outcome: "reported_success", used_for_authority: false });
        finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id, target_surface: "channel" });
        expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
        const saved = c.j.load()!.plans[0]!;
        const binding = saved.bindings[0]!;
        expect(binding).toMatchObject({ status: "verified", operation: "github.write",
          github_write_result: { operation, mutation_status: "provider_accepted", http_status: scenario.accepted_status,
            used_for_authority: false, may_execute: false } });
        expect(saved.results).toHaveLength(0);
        const memory = JSON.stringify(inspectMemory(c));
        for (const privateValue of scenario.private_values) expect(memory).not.toContain(privateValue);
        const resultRead = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
          revision_digest: saved.revisions.at(-1)!.digest, step_id: scenario.step_id })}`));
        expect(resultRead.command).toMatchObject({ type: "noop", payload: { control_event: "operation_plan_result_return" } });
        const projection = c.hds.takeOperationPlanSavedResultReturn(resultRead.command!);
        expect(projection).toMatchObject({ schema_version: "operation-plan-saved-result-return.v6", operation: "github.write",
          operation_name: operation, status: "verified", mutation_status: "provider_accepted", http_status: scenario.accepted_status,
          used_for_authority: false, may_execute: false });
        const projectedJson = JSON.stringify(projection);
        for (const privateValue of scenario.private_values) expect(projectedJson).not.toContain(privateValue);
        expect(githubWriteTool.invoke).toHaveBeenCalledTimes(1);
      }, (id) => githubWriteCandidate(id, scenario), () => mockSyntheticGitHubWrite("accepted", scenario));
    });

    it(`github.write ${operationLabel}明示拒否をMへ記録し、Ownerへ再送せず返す`, async () => {
      const scenario = githubWriteScenario(operation, writeCase.comment_kind, writeCase.inline_range);
      await fixture(async (c) => {
        expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
        const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
        expect(feedback.status).toBe("failed");
        expect(feedback.operation_core_result).toMatchObject({ action_outcome: "reported_rejection", state: "failed" });
        finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id, target_surface: "channel" });
        expect(c.authority.receipt(c.approved)?.state).toBe("adapter_returned");
        expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
        const saved = c.j.load()!.plans[0]!;
        expect(saved.bindings[0]).toMatchObject({ status: "provider_rejected",
          github_write_result: { operation, mutation_status: "provider_rejected", http_status: 403 } });
        expect(saved.results).toHaveLength(0);
        const memory = JSON.stringify(inspectMemory(c));
        expect(memory).toContain("provider_rejected");
        for (const privateValue of scenario.private_values) expect(memory).not.toContain(privateValue);
        const resultRead = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
          revision_digest: saved.revisions.at(-1)!.digest, step_id: scenario.step_id })}`));
        const projection = c.hds.takeOperationPlanSavedResultReturn(resultRead.command!);
        expect(projection).toMatchObject({ schema_version: "operation-plan-saved-result-return.v6", operation_name: operation,
          status: "provider_rejected", mutation_status: "provider_rejected", http_status: 403 });
        expect(githubWriteTool.invoke).toHaveBeenCalledTimes(1);
      }, (id) => githubWriteCandidate(id, scenario), () => mockSyntheticGitHubWrite("rejected", scenario));
    });

    it(`github.write ${operationLabel}結果不明をtask-bound M receiptとOwner照会へ運び、自動再送しない`, async () => {
      const scenario = githubWriteScenario(operation, writeCase.comment_kind, writeCase.inline_range);
      await fixture(async (c) => {
        expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
        const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
        expect(feedback.status).toBe("failed");
        expect(feedback.operation_core_result).toMatchObject({ action_outcome: "unknown", state: "failed" });
        finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id, target_surface: "channel" });
        expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
        const saved = c.j.load()!.plans[0]!;
        expect(saved.bindings[0]).toMatchObject({ status: "outcome_unknown" });
        expect(saved.bindings[0]?.github_write_result).toBeUndefined();
        const memory = JSON.stringify(inspectMemory(c));
        expect(memory).toContain("github_write_outcome_observation");
        for (const privateValue of scenario.private_values) expect(memory).not.toContain(privateValue);
        const resultRead = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
          revision_digest: saved.revisions.at(-1)!.digest, step_id: scenario.step_id })}`));
        const projection = c.hds.takeOperationPlanSavedResultReturn(resultRead.command!);
        expect(projection).toMatchObject({ schema_version: "operation-plan-saved-result-return.v6", operation_name: operation,
          status: "outcome_unknown", mutation_status: null, http_status: null });
        expect(githubWriteTool.invoke).toHaveBeenCalledTimes(1);
      }, (id) => githubWriteCandidate(id, scenario), () => mockSyntheticGitHubWrite("unknown", scenario));
    });
  }

  it("Jが保持するcanonical action digestとExecutor ticket digestが一致しない限りattemptを開始しない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, { ...c.admission!, command_digest: "0".repeat(64) })).toBe(false);
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
  }));

  it("旧generationの遅延結果をprivate evidenceへ隔離し、現行J/Mへ適用しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status, feedback.status === "failed" ? feedback.error ?? "executor_failed_without_error" : undefined).toBe("success");
    const saved = c.execution.pendingResults()[0]!;
    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    const currentEpoch = randomUUID();
    const reconcileResult = vi.spyOn(restarted, "reconcileOperationPlanResult");

    expect(reconcileStartupExecutionState(restarted, c.execution, currentEpoch)).toEqual({
      ready: true, adopted: 0, deferred: 0, stale_generation_archived: 1,
      memory_ready: true, result_store_readable: true, wait_compute_candidate_reconciled: 0,
      wait_compute_interrupted: 0, wait_compute_reconciliation_ready: true,
    });
    expect(reconcileResult).not.toHaveBeenCalled();
    expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    expect(inspectMemory(c).revision).toBe(0);
    expect(c.execution.pendingResults()).toHaveLength(0);
    expect(c.execution.lookup(c.admission.ticket_id)).toMatchObject({
      result_delivery_acknowledged: true,
      result_delivery_disposition: "stale_generation_evidence",
      result_archived_by_epoch_digest: createHash("sha256").update(currentEpoch).digest("hex"),
    });
    expect(c.execution.verifyEvents()).toBe(true);
    const db = new DatabaseSync(c.executionPath);
    try {
      expect(db.prepare("SELECT delivery_digest FROM execution_result_outbox WHERE ticket_id=?")
        .get(c.admission.ticket_id)).toEqual({ delivery_digest: saved.delivery_digest });
    } finally { db.close(); }
    const visible = JSON.stringify(c.execution.snapshot());
    expect(visible).toContain("stale_generation_evidence");
    expect(visible).not.toContain(c.workspace);
    expect(visible).not.toContain('"matches"');
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("実worker結果とreceiptを保存し、承認/inflightなしの再起動後にJへ一回採用する", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success"); expect(c.invoke).toHaveBeenCalledTimes(1);
    const saved = c.execution.pendingResults()[0]!;
    expect(hash(saved.delivery.feedback.result)).toBe(feedback.operation_core_result?.output_digest);
    expect(saved.delivery.feedback.operation_core_result).toEqual(feedback.operation_core_result);
    expect(c.execution.lookup(c.admission.ticket_id)?.result_delivery_acknowledged).toBe(false);
    const reopened = new GatewayExecutionIntentStore(c.executionPath, c.execution.executionEpoch); const j = new OperationPlanStateStore(c.jPath);
    try {
      c.hds.closeOperationPlanMemory(); const hds = c.createHds(j);
      hds.onFeedback(feedback); // 通常のinflight保護は維持し、この遅延feedbackを採用しない。
      expect(hds.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
      expect(review(hds, c.plan, "dependent")).toBeNull();
      expect(reconcileExecutionResults(hds, reopened, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
      expect(j.load()?.plans[0]?.results[0]?.observed_at_ms).toBe(feedback.operation_core_result?.observed_at_ms);
      expect(review(hds, c.plan, "dependent")?.type).toBe("tool_call");
      expect(reopened.pendingResults()).toHaveLength(0); expect(reopened.verifyEvents()).toBe(true);
      const visible = JSON.stringify({ execution: reopened.snapshot(), j: hds.getRuntimeSnapshot().operation_plans });
      for (const secret of [c.workspace, c.admission.ticket_id, c.admission.execution_epoch, '"matches"', '"execution_admission"']) expect(visible).not.toContain(secret);
      expect(c.invoke).toHaveBeenCalledTimes(1); expect((await c.executor.execute(c.approved)).status).toBe("failed");
    } finally { reopened.close(); j.close(); }
  }));

  it("実file.write後・Broker result receipt前の中断は再起動後も同taskを未知保留し、Mと依存stepを進めない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const fault = new DatabaseSync(c.executionPath);
    fault.exec(`CREATE TRIGGER fixture_file_write_result_failure BEFORE UPDATE ON execution_intents
      WHEN json_extract(NEW.receipt_json,'$.result_delivery_digest') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture Broker result receipt failure'); END;`);
    try {
      const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(feedback.status).toBe("failed");
      expect(feedback.error).toMatch(/receipt persistence failed/);
      expect(feedback.operation_core_result).toMatchObject({ action_outcome: "unknown", execution_boundary: "tool_adapter" });
      expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");
      expect(c.execution.lookupCommand(c.admission.command_key)).toMatchObject({
        state: "outcome_unknown", task_identity_digest: c.admission.task_identity_digest,
      });
      expect(c.execution.pendingResults()).toHaveLength(0);
      expect(c.j.load()?.plans[0]?.bindings[0]?.status).toBe("intent_committed");
      expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
    } finally {
      fault.exec("DROP TRIGGER fixture_file_write_result_failure");
      fault.close();
    }

    // Re-open both durable ledgers as a fresh runtime would after process loss.
    c.hds.closeOperationPlanMemory();
    const restartedEpoch = randomUUID();
    const restartedExecution = new GatewayExecutionIntentStore(c.executionPath, restartedEpoch);
    const restartedJ = new OperationPlanStateStore(c.jPath);
    try {
      const restarted = c.createHds(restartedJ);
      expect(reconcileStartupExecutionState(restarted, restartedExecution, restartedEpoch)).toMatchObject({
        ready: true, adopted: 0, deferred: 0, memory_ready: true, result_store_readable: true,
      });
      const plan = restarted.getRuntimeSnapshot().operation_plans.plans[0]!;
      expect(plan.task_identity_digest).toBe(c.admission.task_identity_digest);
      expect(plan.steps.find((step) => step.step_id === operationPlanDigest("create-note"))?.status).toBe("outcome_unknown");
      expect(restartedJ.load()?.plans[0]?.results).toHaveLength(0);
      expect(restartedExecution.lookupCommand(c.admission.command_key)).toMatchObject({
        state: "outcome_unknown", task_identity_digest: c.admission.task_identity_digest,
      });
      expect(restartedExecution.pendingResults()).toHaveLength(0);
      expect(restarted.reconcileOperationPlanMemory()).toBe(true);
      expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
      expect(review(restarted, c.plan, "create-note")).toBeNull();
      expect(review(restarted, c.plan, "verify-note")).toBeNull();

      const now = c.currentWallClock();
      expect(() => restartedExecution.issue({ ...c.admission, ticket_id: randomUUID(),
        execution_epoch: restartedEpoch, issued_at_ms: now, expires_at_ms: now + 60_000 })).toThrow(/command already issued/);
      expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");
    } finally {
      restartedExecution.close();
      restartedJ.close();
    }
  }, fileWriteWithDependentCandidate));

  it("Jで検証したfile.write結果だけをdigest観測としてMへ返し、C反省へ渡さない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");

    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results).toHaveLength(1);
    expect(checkpoint.results[0]?.output).toEqual(feedback.result);
    expect(c.execution.pendingResults()).toHaveLength(0);

    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1); expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.write", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic planned file content", "sandbox_root", "bytes_written"]) {
      expect(memoryJson).not.toContain(raw);
    }

    const current = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const reflection = request(`plan:reflect ${JSON.stringify({ plan_id: current.plan_id, revision_digest: current.revision_digest,
      step_ids: ["create-note"], question: "書込み結果を解釈する" })}`);
    expect(c.hds.decide(reflection).command).toBeNull();

    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(inspectMemory(c)).toEqual(memory);
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("verified");
  }, fileWriteCandidate));

  it("Jで検証したfile.delete結果をdigest限定の非権威観測としてMへ返す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(feedback.result).toEqual({ deleted: true });
    expect(() => readFileSync(join(c.workspace, "notes.txt"), "utf8")).toThrow();

    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results[0]?.output).toEqual({ deleted: true });
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1);
    expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.delete", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic delete target"]) expect(memoryJson).not.toContain(raw);
    expect(c.execution.pendingResults()).toHaveLength(0);
  }, fileDeleteCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic delete target\n")));

  it("Operation Planから実行したfile.edit結果をJ/Mへ返し、明示選択後に非権威観測としてCへ渡す", async () => fixture(async (c) => {
    const operationPlanBindingDigest = c.hds.getExecutionOperationPlanBindingDigest(c.cmd);
    const observedTarget = await c.executor.inspectCommandTargetVersion(c.cmd, undefined, operationPlanBindingDigest);
    expect(observedTarget?.schema_version).toBe("blue-tanuki.file-edit-target-version.v1");
    const contentReview = await c.executor.inspectCommandContentReview(c.cmd, undefined, operationPlanBindingDigest);
    if (!contentReview || !("diff" in contentReview)) throw new Error("selected file.edit has no owner-review diff");
    expect(contentReview).toMatchObject({ path: "notes.txt", replacement_count: 1,
      command_digest: operationPlanDigest(c.cmd), operation_plan_binding_digest: operationPlanBindingDigest,
      used_for_authority: false, may_execute: false });
    expect(contentReview.diff).toContain("-original\n+edited\n");
    expect(contentReview.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic original text\n");
    expect(() => c.hds.createExecutionAuthorityBinding(c.cmd, { ...observedTarget!,
      operation_plan_binding_digest: "f".repeat(64) })).toThrow(/current Operation Plan source/);

    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(feedback.result).toEqual({ edited: true, replacements: 1,
      bytes_written: Buffer.byteLength("synthetic edited text\n") });
    const appliedContent = readFileSync(join(c.workspace, "notes.txt"));
    expect(appliedContent.toString("utf8")).toBe("synthetic edited text\n");
    expect(createHash("sha256").update(appliedContent).digest("hex")).toBe(contentReview.after_content_digest);
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const checkpoint = c.j.load()!.plans[0]!;
    const binding = checkpoint.bindings[0]!;
    expect(binding).toMatchObject({ status: "verified", operation: "file.edit",
      delivery_digest: expect.stringMatching(/^[a-f0-9]{64}$/), memory_receipt: expect.objectContaining({ revision: 1 }) });
    expect(checkpoint.results[0]?.output).toEqual(feedback.result);
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1);
    expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.edit", delivery_digest: binding.delivery_digest, result_digest: binding.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched", effect_observation: "reported_success",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const memoryJson = JSON.stringify(observation);
    for (const raw of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(memoryJson).not.toContain(raw);
    }
    expect(c.execution.pendingResults()).toHaveLength(0);

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);
    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Use the selected historical edit report only as context; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected edit observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.local_p_version).toBe("blue-tanuki.plan-compute-source-observations.v8");
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_file_edit_result");
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(serializedInput).not.toContain(forbidden);
    }

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toMatchObject([{ source: "verified_file_edit_result",
      operation: "file.edit", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false }]);
    const retainedJson = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic original text", "synthetic edited text"]) {
      expect(retainedJson).not.toContain(forbidden);
    }
  }, fileEditCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic original text\n")));

  it("直接shell.execの結果報告をdigest限定でJ/Mへ保持し、明示選択後にCの次計画へ渡す", async () => fixture(async (c) => {
    const shellRequest = request(`tool:shell.exec ${JSON.stringify({ cmd: "node", args: ["--version"], cwd: "." })}`);
    const shellDecision = c.hds.decide(shellRequest);
    if (shellDecision.command?.type !== "tool_call") throw new Error(`shell command was not issued: ${shellDecision.log.commit.reason}`);
    const shellCommand = shellDecision.command;
    expect(shellCommand.payload.tool_name).toBe("shell.exec");
    expect(shellDecision.log.commit.decision).toBe("ASSERT");

    // Fixture feedback only: no process is launched here, and the output is deliberately private.
    const privateOutput = { stdout: "PRIVATE_SYNTHETIC_SHELL_STDOUT", stderr: "", exit_code: 0 };
    const operationCoreResult = {
      version: "operation-core.v1" as const, role: "command_execution_result" as const,
      result_id: randomUUID(), request_id: shellDecision.log.request_id, command_id: shellCommand.id,
      upstream_commit_hash: shellDecision.log.commit.hash, operation: "shell.exec",
      state: "succeeded" as const, adapter: "shell" as const, execution_boundary: "tool_adapter" as const,
      action_outcome: "reported_success" as const, observed_at_ms: Date.now(),
      command_payload_digest: hash(shellCommand.payload), output_digest: hash(privateOutput), plan_step_binding: "unbound" as const,
      adapter_result_used_for_authority: false as const, used_for_authority: false as const,
      evidence_source: ["INTERNAL_STATE"] as ["INTERNAL_STATE"],
    };
    c.hds.onFeedback({ command_id: shellCommand.id, status: "success", result: privateOutput,
      operation_core_result: operationCoreResult, metrics: { duration_ms: 1 } });

    const checkpoint = c.j.load()!;
    const shellObservation = checkpoint.shell_exec_result_observations?.[0];
    expect(checkpoint.shell_exec_result_observations).toHaveLength(1);
    expect(shellObservation).toMatchObject({ command_id_digest: operationPlanDigest(shellCommand.id),
      request_id_digest: operationPlanDigest(shellDecision.log.request_id),
      result_digest: hash(privateOutput), execution_status: "succeeded", execution_boundary: "tool_adapter",
      action_outcome: "reported_success", plan_step_binding: "unbound", used_for_authority: false, may_execute: false,
      memory_receipt: expect.objectContaining({ revision: 1 }) });
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1);
    expect(memory.records).toHaveLength(1);
    expect(memory.records[0]).toMatchObject({ record_type: "shell_exec_result_observation",
      command_id_digest: operationPlanDigest(shellCommand.id), result_digest: hash(privateOutput),
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    for (const serialized of [JSON.stringify(shellObservation), JSON.stringify(memory.records[0])]) {
      for (const forbidden of ["node", "--version", "PRIVATE_SYNTHETIC_SHELL_STDOUT", c.workspace]) {
        expect(serialized).not.toContain(forbidden);
      }
    }

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);
    const destinationRequestId = randomUUID();
    const task = "Use this explicitly selected shell result report only as historical context; verify any current-state claim with fresh evidence.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ command_id_digest: operationPlanDigest(shellCommand.id) }] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected shell observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.local_p_version)
      .toBe("blue-tanuki.plan-compute-source-observations.v8");
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_shell_exec_result");
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(operationPlanDigest(shellCommand.id));
    for (const forbidden of ["node", "--version", "PRIVATE_SYNTHETIC_SHELL_STDOUT", c.workspace]) {
      expect(serializedInput).not.toContain(forbidden);
    }

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toMatchObject([{ source: "verified_shell_exec_result",
      operation: "shell.exec", command_id_digest: operationPlanDigest(shellCommand.id),
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false }]);
    expect(JSON.stringify(retained?.compute_source_observations)).not.toContain("PRIVATE_SYNTHETIC_SHELL_STDOUT");
  }, fileWriteCandidate));

  it.skipIf(process.platform !== "win32")("承認済みworkspace編集をWindows隔離shellで確かめ、その結果をJ/Mへ返す", async () => fixture(async (c) => {
    const editBindingDigest = c.hds.getExecutionOperationPlanBindingDigest(c.cmd);
    const editReview = await c.executor.inspectCommandContentReview(c.cmd, undefined, editBindingDigest);
    if (!editReview || !("diff" in editReview)) throw new Error("planned workspace edit has no owner-review diff");
    expect(editReview.diff).toContain("-original\n+edited\n");
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const editFeedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(editFeedback.status).toBe("success");
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic edited text\n");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    vi.stubEnv("BLUE_TANUKI_SHELL_ROOT", c.workspace);
    const providerPath = resolve(process.cwd(), "packages/blue-tanuki/native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe");
    vi.spyOn(shellExecTool, "invoke").mockImplementation((args, context) => invokeShellExec(args, {
      signal: context.signal, targetVersionObservation: context.target_version_observation, nativeProviderPath: providerPath,
    }));
    const shellArgs = { cmd: "node", args: ["-e",
      "const fs = require('node:fs'); if (fs.readFileSync('notes.txt', 'utf8') !== 'synthetic edited text\\n') process.exit(7);"], cwd: "." };
    const shellRequest = request(`tool:shell.exec ${JSON.stringify(shellArgs)}`);
    const shellDecision = c.hds.decide(shellRequest);
    if (shellDecision.command?.type !== "tool_call") {
      throw new Error(`workspace verification shell command was not issued: ${shellDecision.log.commit.reason}`);
    }
    const shellCommand = shellDecision.command;
    const shellApproval = await c.approve(shellCommand);
    const shellFeedback = await c.executor.execute(shellApproval, { save_result_delivery: true });
    expect(shellFeedback.status, shellFeedback.error).toBe("success");
    expect(shellFeedback.result).toMatchObject({ exit_code: 0, signal: null, timed_out: false,
      process_tree_empty: true, operation_core: { state: "succeeded", adapter_is_authority: false } });

    const finalized = finalizeCommandOutput({ hds: c.hds, command: shellCommand, feedback: shellFeedback,
      target_surface: "channel", request_id: shellRequest.id });
    expect(finalized.output_audit.used_for_authority).toBe(false);
    const observation = c.j.load()?.shell_exec_result_observations?.[0];
    expect(observation).toMatchObject({ command_id_digest: operationPlanDigest(shellCommand.id),
      execution_status: "succeeded", execution_boundary: "tool_adapter", action_outcome: "reported_success",
      used_for_authority: false, may_execute: false, memory_receipt: expect.objectContaining({ revision: 2 }) });
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(2);
    expect(memory.records.map((record) => record.record_type)).toEqual([
      "action_result_observation", "shell_exec_result_observation",
    ]);
    for (const record of memory.records) {
      expect(JSON.stringify(record)).not.toContain(c.workspace);
      expect(JSON.stringify(record)).not.toContain("synthetic edited text");
    }

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);
    const destinationRequestId = randomUUID();
    const task = "Use the successful workspace check as non-authority context and require fresh evidence before claiming current state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ command_id_digest: operationPlanDigest(shellCommand.id) }] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") {
      throw new Error(`workspace result did not reach explicit C selection: ${compute.log.commit.reason}`);
    }
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_shell_exec_result");
    expect(serializedInput).toContain(operationPlanDigest(shellCommand.id));
    for (const privateValue of [c.workspace, "node", "synthetic edited text"]) {
      expect(serializedInput).not.toContain(privateValue);
    }
    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toMatchObject([{ source: "verified_shell_exec_result",
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false }]);
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic edited text\n");
  }, fileEditCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic original text\n")));

  it("明示選択されたfile.write履歴はdigestだけを後続plan:computeへ渡し、候補保持前にも再照合する", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Plan a safe follow-up from a selected historical action report; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected observation was not routed to C: ${compute.log.commit.reason}`);
    const context = compute.command.payload.compute_context;
    expect(context?.data_exposure.input_sources).toContain("selected_operation_result_observations");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    expect(serializedInput).not.toContain(c.workspace);
    expect(serializedInput).not.toContain("notes.txt");
    expect(serializedInput).not.toContain("synthetic planned file content");

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toHaveLength(1);
    expect(retained?.compute_source_observations?.[0]).toMatchObject({ source: "verified_file_write_result",
      operation: "file.write", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const publicProjection = projectOperationPlanStatus(c.hds.getRuntimeSnapshot().operation_plans);
    expect(publicProjection.status).toBe("available");
    expect(publicProjection.plans.find((entry) => entry.plan_id === operationPlanDigest(nextCandidate.plan_id))
      ?.compute_source_observations).toEqual(retained?.compute_source_observations);
    const safeObservation = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic planned file content", "sandbox_root", "target"]) {
      expect(safeObservation).not.toContain(forbidden);
    }
  }, fileWriteCandidate));

  it("明示選択されたfile.delete履歴を現在J/M照合後に非権威入力として後続plan:computeへ渡す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status, feedback.error?.replaceAll(c.workspace, "[workspace]") ?? "file.delete returned no error detail")
      .toBe("success");
    expect(feedback.result).toEqual({ deleted: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    expect(c.hds.reconcileOperationPlanMemory()).toBe(true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    const destinationRequestId = randomUUID();
    const task = "Use the selected historical deletion report as context; require fresh observation before claiming current file state.";
    const computeRequest = createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat", user: "fixture-owner",
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding, source_observation_refs: [sourceRef] })}`,
      timestamp: Date.now(), metadata: { "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner", "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": destinationRequestId } });
    const compute = c.hds.decide(computeRequest);
    if (compute.command?.type !== "llm_call") throw new Error(`selected delete observation was not routed to C: ${compute.log.commit.reason}`);
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    expect(compute.command.payload.compute_context?.local_p_version)
      .toBe("blue-tanuki.plan-compute-source-observations.v8");
    const serializedInput = JSON.stringify(compute.command.payload.messages);
    expect(serializedInput).toContain("verified_file_delete_result");
    expect(serializedInput).toContain("reported_success");
    expect(serializedInput).toContain(expectedTaskIdentityDigest);
    expect(serializedInput).toContain(sourceRef.plan_id_digest);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic delete target"]) {
      expect(serializedInput).not.toContain(forbidden);
    }

    const invalidRequest = createGatewayInternalInboundRequest({ ...computeRequest, id: randomUUID(),
      content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [{ ...sourceRef, step_id_digest: "f".repeat(64) }] })}`, timestamp: Date.now() });
    const invalid = c.hds.decide(invalidRequest);
    expect(invalid.command?.type).not.toBe("llm_call");
    expect(invalid.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_step_mismatch");

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toHaveLength(1);
    expect(retained?.compute_source_observations?.[0]).toMatchObject({ source: "verified_file_delete_result",
      operation: "file.delete", task_identity_digest: expectedTaskIdentityDigest,
      effect_observation: "reported_success", adoption_status: "observation_only",
      used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const safeObservation = JSON.stringify(retained?.compute_source_observations);
    for (const forbidden of [c.workspace, "notes.txt", "synthetic delete target", "sandbox_root", "target"]) {
      expect(safeObservation).not.toContain(forbidden);
    }
  }, fileDeleteCandidate, (workspace) => writeFileSync(join(workspace, "notes.txt"), "synthetic delete target\n")));

  it("有効期限内のJ/M照合済みfile.search要約だけを後続plan:computeへ渡す", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const sourceCheckpoint = c.j.load()!.plans[0]!;
    const sourceResult = sourceCheckpoint.results[0]!;
    expect(sourceResult.operation).toBe("file.search");
    const expectedTaskIdentityDigest = planTaskIdentityDigest(sourceCheckpoint.owner, sourceCheckpoint.channel,
      sourceCheckpoint.goal, c.plan.plan_id, c.plan.request_id);
    c.hds.closeOperationPlanMemory();
    c.hds = c.createHds(c.j, true);
    c.purposeBinding = installTestPurpose(c.hds);

    const sourceRevision = sourceCheckpoint.revisions.at(-1)!;
    const sourceRef = { plan_id_digest: operationPlanDigest(c.plan.plan_id), revision_digest: sourceRevision.digest,
      step_id_digest: operationPlanDigest(c.plan.steps[0]!.step_id) };
    const task = "Plan a follow-up from a selected, bounded search observation; do not claim complete coverage.";
    const makeComputeRequest = (requestId: string) => createGatewayInternalInboundRequest({ id: randomUUID(), channel: "webchat",
      user: "fixture-owner", content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: c.purposeBinding,
        source_observation_refs: [sourceRef] })}`, timestamp: Date.now(), metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1", "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner", "blue_tanuki.process_kind": "chat",
        "blue_tanuki.operator_surface": "developer", "blue_tanuki.operation_core.version": "operation-core.v1",
        "blue_tanuki.operation_core.request_id": requestId,
      } });

    const destinationRequestId = randomUUID();
    const compute = c.hds.decide(makeComputeRequest(destinationRequestId));
    if (compute.command?.type !== "llm_call") {
      const result = sourceCheckpoint.results.find((entry) => entry.step_id === "search");
      const now = c.currentWallClock();
      const freshness = !result ? "missing" : now < result.observed_at_ms ? "future"
        : now >= result.expires_at_ms ? "expired" : "fresh";
      const ageMs = result ? now - result.observed_at_ms : "unavailable";
      const remainingMs = result ? result.expires_at_ms - now : "unavailable";
      const output = result?.output;
      const outputShape = !output || typeof output !== "object" || Array.isArray(output) ? "invalid"
        : Array.isArray((output as { matches?: unknown }).matches) &&
          Number.isSafeInteger((output as { visited_files?: unknown }).visited_files) ? "valid" : "invalid";
      throw new Error(`selected search observation was not routed to C: reason=${compute.log.commit.reason}; ` +
        `freshness=${freshness}; age_ms=${ageMs}; remaining_ms=${remainingMs}; output=${outputShape}`);
    }
    expect(compute.command.payload.compute_context?.local_p_version).toBe("blue-tanuki.plan-compute-source-observations.v8");
    expect(compute.command.payload.compute_context?.data_exposure.input_sources)
      .toContain("selected_operation_result_observations");
    const observationMessage = compute.command.payload.messages.find((message) =>
      message.role === "system" && message.content.includes("verified_file_search_result"));
    expect(observationMessage).toBeDefined();
    const observationPayload = JSON.parse(observationMessage!.content.slice(observationMessage!.content.indexOf("\n") + 1)) as {
      observations: Array<Record<string, unknown>>;
    };
    expect(observationPayload.observations).toHaveLength(1);
    expect(observationPayload.observations[0]).toMatchObject({ source: "verified_file_search_result",
      operation: "file.search", task_identity_digest: expectedTaskIdentityDigest,
      plan_binding_status: "verified", plan_validation_status: "matched",
      effect_observation: "reported_success", match_count: 1, visited_files: 1,
      expires_at_ms: sourceResult.expires_at_ms, search_completeness: "unknown",
      adoption_status: "observation_only", used_as_world_truth: false, used_for_authority: false, may_execute: false });
    const serializedInput = compute.command.payload.messages.map((message) => message.content).join("\n");
    for (const privateValue of [c.workspace, "blue.txt", '"line_number"', '"sandbox_root"']) {
      expect(serializedInput).not.toContain(privateValue);
    }

    const nextCandidate = fileWriteCandidate(destinationRequestId, c.workspace);
    c.hds.onFeedback({ command_id: compute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: nextCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    const retained = c.hds.getRuntimeSnapshot().operation_plans.plans.find((entry) =>
      entry.plan_id === operationPlanDigest(nextCandidate.plan_id));
    expect(retained?.compute_source_observations).toEqual(observationPayload.observations);

    const secondRequestId = randomUUID();
    const secondCompute = c.hds.decide(makeComputeRequest(secondRequestId));
    if (secondCompute.command?.type !== "llm_call") throw new Error("fresh search observation was not reusable before expiry");
    const expiredCandidate = fileWriteCandidate(secondRequestId, c.workspace);
    c.advanceWallClockTo(sourceResult.expires_at_ms);
    c.hds.onFeedback({ command_id: secondCompute.command.id, status: "success",
      result: { operation_core: { status: "valid_plan", plan: expiredCandidate } },
      metrics: { duration_ms: 1, tokens_used: 1, tool_calls: 0 } });
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans.some((entry) =>
      entry.plan_id === operationPlanDigest(expiredCandidate.plan_id))).toBe(false);

    const expired = c.hds.decide(makeComputeRequest(randomUUID()));
    expect(expired.command?.type).not.toBe("llm_call");
    expect(expired.log.commit.reason).toContain("plan_control_denied:plan_compute_source_observation_expired");
  }));

  it("file.writeの応答が計画のresult_equals条件に合わない場合はMへ昇格しない", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    expect(readFileSync(join(c.workspace, "notes.txt"), "utf8")).toBe("synthetic planned file content\n");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch))
      .toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });

    const binding = c.j.load()!.plans[0]!.bindings[0]!;
    expect(binding.status).toBe("verification_failed");
    expect(binding.memory_receipt).toBeUndefined();
    expect(c.j.load()!.plans[0]!.results).toHaveLength(0);
    expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
    expect(c.execution.pendingResults()).toHaveLength(0);
  }, (id, root) => fileWriteCandidate(id, root, 1)));

  it("withholds a plan result while a failed M commit has no confirmed receipt", async () => fixture(async (c) => {
    const db = new DatabaseSync(c.memory.memory_database_path);
    db.exec(`CREATE TRIGGER fixture_operation_result_memory_failure BEFORE INSERT ON m_records
      BEGIN SELECT RAISE(ABORT,'fixture M result persistence failure'); END;`);
    try {
      expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
      await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1 });
      expect(c.j.load()?.plans[0]?.bindings[0]?.memory_commit).toBeDefined();
      expect(c.j.load()?.plans[0]?.bindings[0]?.memory_receipt).toBeUndefined();
      expect(c.hds.operationPlanResultReadyForReturn(c.cmd.id)).toBe(false);
      expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
    } finally {
      db.exec("DROP TRIGGER fixture_operation_result_memory_failure");
      db.close();
    }
    expect(c.hds.operationPlanResultReadyForReturn(c.cmd.id)).toBe(false);
    expect(inspectMemory(c)).toMatchObject({ revision: 0, records: [], receipts: [] });
    expect(c.invoke).toHaveBeenCalledTimes(1);
    const current = c.j.load()!.plans[0]!;
    const withheld = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
      revision_digest: current.revisions.at(-1)!.digest, step_id: "search" })}`));
    expect(withheld.command).toBeNull();
    expect(withheld.log.commit.reason).toContain("plan_control_denied:plan_saved_result_");
  }));

  it("J/M restore hold clears only at a fresh review after digest-exact dependencies are verified", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id,
      target_surface: "channel" });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
    expect(c.j.load()?.plans[0]?.bindings[0]?.memory_receipt).toBeDefined();
    expect(c.hds.operationPlanResultReadyForReturn(c.cmd.id)).toBe(true);

    const staleSelection = review(c.hds, c.plan, "dependent")!;
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
    expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);

    const observation = (command: ExecuteCommand) => ({
      status: "matched" as const,
      operation: "restore" as const,
      store_key: "m_state" as const,
      command_id_digest: recoveryCommandIdDigest(command.id),
      operation_digest: createHash("sha256").update("restore-operation").digest("hex"),
      result_digest: createHash("sha256").update("restore-result").digest("hex"),
      restore_backup_id_digest: createHash("sha256").update("restore-backup").digest("hex"),
      restored_state_digest: createHash("sha256").update("restored-state").digest("hex"),
      store_ledger_status: "verified" as const,
      store_ledger_residual_count: 0 as const,
      task_memory_restore_points: taskMemoryRestorePoints(c.j),
    });
    const unrelatedRestore = canonicalMemoryRestoreCommand();
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(unrelatedRestore, observation(unrelatedRestore))).toBe(false);
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation(restoreCommand))).toBe(true);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
    expect(c.hds.operationPlanResultReadyForReturn(c.cmd.id)).toBe(false);

    const heldPlan = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const heldResult = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
      revision_digest: heldPlan.revision_digest, step_id: "search" })}`));
    expect(heldResult.command).toBeNull();
    expect(heldResult.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");

    const currentPlan = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const staleReview = c.hds.decide(request(`plan:review ${JSON.stringify({ plan_id: currentPlan.plan_id,
      revision_digest: "f".repeat(64), step_id: operationPlanDigest("dependent") })}`));
    expect(staleReview.command).toBeNull();
    expect(staleReview.log.commit.reason).toBe("plan_control_denied:plan_revision_changed");
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });

    const freshSelection = review(c.hds, c.plan, "dependent")!;
    expect(freshSelection.type).toBe("tool_call");
    expect(freshSelection.id).not.toBe(staleSelection.id);
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
    expect(c.hds.operationPlanResultReadyForReturn(c.cmd.id)).toBe(true);
    const releasedResult = c.hds.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
      revision_digest: currentPlan.revision_digest, step_id: "search" })}`));
    expect(releasedResult.command).toMatchObject({ type: "noop", payload: { control_event: "operation_plan_result_return" } });
    expect(c.hds.takeOperationPlanSavedResultReturn(releasedResult.command!)).toMatchObject({
      matches: [{ path: "blue.txt", line_number: 1, line: "blue" }], used_for_authority: false, may_execute: false,
    });
    expect(c.hds.getAudit().verify()).toBe(true);
  }));

  it("task-scoped M restore residual keeps a receipt-backed plan held through fresh J review", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("success");
    finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id,
      target_surface: "channel" });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });

    const staleSelection = review(c.hds, c.plan, "dependent")!;
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
    expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, {
      status: "matched", operation: "restore", store_key: "m_state",
      command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
      operation_digest: hash("residual-task-restore-operation"),
      result_digest: hash("residual-task-restore-result"),
      restore_backup_id_digest: hash("residual-task-restore-backup"),
      restored_state_digest: hash("residual-task-restored-state"),
      store_ledger_status: "verified", store_ledger_residual_count: 0,
      task_memory_restore_points: taskMemoryRestorePoints(c.j, "residuals_present"),
    })).toBe(true);

    const held = review(c.hds, c.plan, "dependent");
    expect(held).toBeNull();
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
    expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
  }));

  it("startup reconciles a pending Broker result into M under an observed restore hold without releasing the plan", async () => fixture(async (c) => {
    expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status, feedback.status === "failed" ? feedback.error ?? "executor_failed_without_error" : undefined).toBe("success");
    expect(c.execution.pendingResults()).toHaveLength(1);

    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(restarted.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(restarted.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(restarted.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);
    const observation = {
      status: "matched" as const,
      operation: "restore" as const,
      store_key: "m_state" as const,
      command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
      operation_digest: hash("pending-result-restore-operation"),
      result_digest: hash("pending-result-restore-result"),
      restore_backup_id_digest: hash("pending-result-restore-backup"),
      restored_state_digest: hash("pending-result-restored-state"),
      store_ledger_status: "verified" as const,
      store_ledger_residual_count: 0 as const,
      task_memory_restore_points: taskMemoryRestorePoints(c.j),
    };
    expect(restarted.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);

    expect(reconcileStartupExecutionState(restarted, c.execution, c.admission.execution_epoch)).toMatchObject({
      ready: true, adopted: 1, deferred: 0, stale_generation_archived: 0,
      memory_ready: true, result_store_readable: true, wait_compute_reconciliation_ready: true,
    });
    expect(c.execution.pendingResults()).toHaveLength(0);
    expect(inspectMemory(c)).toMatchObject({ revision: 1, records: expect.any(Array) });
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
    expect(restarted.operationPlanResultReadyForReturn(c.cmd.id)).toBe(false);
    const heldPlan = restarted.getRuntimeSnapshot().operation_plans.plans[0]!;
    const heldResult = restarted.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
      revision_digest: heldPlan.revision_digest, step_id: "search" })}`));
    expect(heldResult.command).toBeNull();
    expect(heldResult.log.commit.reason).toBe("plan_control_denied:plan_recovery_unverified_hold");

    const freshSelection = review(restarted, c.plan, "dependent");
    expect(freshSelection?.type).toBe("tool_call");
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
    expect(restarted.operationPlanResultReadyForReturn(c.cmd.id)).toBe(true);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("J/M receipt-backed plan hold survives a closed-store restart and releases only at a fresh review", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-result-reconcile-jm-process-restart-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "blue.txt"), "blue\n");
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
    const c = await setup(root, workspace);
    let originalJOpen = true;
    let restartedJ: OperationPlanStateStore | undefined;
    try {
      const rejectionReasons: string[] = [];
      const attemptStarted = c.hds.beginOperationPlanAttempt(c.cmd, c.admission, (reason) => rejectionReasons.push(reason));
      expect(attemptStarted, rejectionReasons.join(",") || "attempt_rejected_without_reason").toBe(true);
      const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(feedback.status).toBe("success");
      finalizeCommandOutput({ hds: c.hds, command: c.cmd, feedback, request_id: c.plan.request_id,
        target_surface: "channel" });
      expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toMatchObject({ adopted: 1, deferred: 0 });
      expect(c.j.load()?.plans[0]?.bindings[0]?.memory_receipt).toBeDefined();

      const staleSelection = review(c.hds, c.plan, "dependent")!;
      const restoreCommand = canonicalMemoryRestoreCommand();
      expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
      expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
      expect(c.hds.beginOperationPlanAttempt(staleSelection)).toBe(false);
      expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);
      const observation = {
        status: "matched" as const,
        operation: "restore" as const,
        store_key: "m_state" as const,
        command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
        operation_digest: createHash("sha256").update("restart-restore-operation").digest("hex"),
        result_digest: createHash("sha256").update("restart-restore-result").digest("hex"),
        restore_backup_id_digest: createHash("sha256").update("restart-restore-backup").digest("hex"),
        restored_state_digest: createHash("sha256").update("restart-restored-state").digest("hex"),
        store_ledger_status: "verified" as const,
        store_ledger_residual_count: 0 as const,
        task_memory_restore_points: taskMemoryRestorePoints(c.j),
      };
      expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);
      const checkpointBeforeRestart = c.j.load();
      const holdBeforeRestart = c.j.loadRecoveryHoldState();
      if (!checkpointBeforeRestart) throw new Error("missing restart checkpoint fixture");
      expect(holdBeforeRestart).toMatchObject({
        used_for_authority: false,
        may_execute: false,
        holds: [{ provenance: { source: "recovery_restore", restore_store_key: "m_state",
          checkpoint_digest: expect.any(String) } }],
      });
      expect(inspectMemory(c).receipts).toHaveLength(1);

      c.hds.closeOperationPlanMemory();
      c.controllers.splice(0, c.controllers.length);
      c.j.close();
      originalJOpen = false;
      restartedJ = new OperationPlanStateStore(c.jPath);
      const startupEvidence = operationPlanRecoveryEvidenceFromObservation({
        observation: {
          status: "matched", operation: "restore", store_key: "m_state",
          operation_digest: observation.operation_digest, result_digest: observation.result_digest,
          command_id_digest: observation.command_id_digest, restored_state_digest: observation.restored_state_digest,
          store_ledger_status: "verified", store_ledger_residual_count: 0,
          plan_residuals: null, restore_backup_id_digest: observation.restore_backup_id_digest,
          restore_scope_plan_digest: null, plan_restore_points: null, configuration_state: "not_observed",
          evidence_source: "COMPLETE_HISTORY", used_for_authority: false, may_execute: false,
        },
        checkpoint: checkpointBeforeRestart,
        history_complete: true,
      });
      const restarted = new HDSUpperController({ operation_plan_state: restartedJ, operation_plan_memory: c.memory,
        operation_plan_recovery_evidence: startupEvidence, memory: c.oldMemory });
      c.controllers.push(restarted);

      expect(restartedJ.load()).toEqual(checkpointBeforeRestart);
      expect(restartedJ.loadRecoveryHoldState()).toMatchObject({
        used_for_authority: false,
        may_execute: false,
        holds: [{ reason: "held_unverified", provenance: {
          command_id_digest: recoveryCommandIdDigest(restoreCommand.id), restore_store_key: "m_state",
          checkpoint_digest: operationPlanDigest(checkpointBeforeRestart),
        } }],
      });
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });
      expect(restarted.beginOperationPlanAttempt(staleSelection)).toBe(false);
      expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call");
      expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
      expect(restartedJ.loadRecoveryHoldState()).toMatchObject({ holds: [] });
      expect(inspectMemory(c).receipts).toHaveLength(1);
      expect(restarted.getAudit().verify()).toBe(true);
    } finally {
      for (const controller of c.controllers) controller.closeOperationPlanMemory();
      restartedJ?.close();
      if (originalJOpen) c.j.close();
      c.execution.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("J/M restore permits a fresh review when an unexecuted plan has no J/M result dependency", async () => fixture(async (c) => {
    const staleSelection = c.cmd;
    const restoreCommand = canonicalMemoryRestoreCommand();
    expect(c.hds.quiesceOperationPlanMemoryForCanonicalRestore()).toBe(true);
    expect(c.hds.holdOperationPlansForCanonicalMemoryRestore(restoreCommand)).toBe(true);
    expect(c.hds.beginOperationPlanAttempt(staleSelection, c.admission)).toBe(false);
    expect(c.hds.reopenOperationPlanMemoryAfterCanonicalRestore()).toBe(true);

    const observation = {
      status: "matched" as const,
      operation: "restore" as const,
      store_key: "m_state" as const,
      command_id_digest: recoveryCommandIdDigest(restoreCommand.id),
      operation_digest: createHash("sha256").update("no-dependency-restore-operation").digest("hex"),
      result_digest: createHash("sha256").update("no-dependency-restore-result").digest("hex"),
      restore_backup_id_digest: createHash("sha256").update("no-dependency-restore-backup").digest("hex"),
      restored_state_digest: createHash("sha256").update("no-dependency-restored-state").digest("hex"),
      store_ledger_status: "verified" as const,
      store_ledger_residual_count: 0 as const,
      task_memory_restore_points: taskMemoryRestorePoints(c.j),
    };
    expect(c.hds.recordOperationPlanMemoryRestoreObservation(restoreCommand, observation)).toBe(true);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).toMatchObject({ recovery_hold_reason: "held_unverified" });

    const freshSelection = review(c.hds, c.plan, "search")!;
    expect(freshSelection.type).toBe("tool_call");
    expect(freshSelection.id).not.toBe(staleSelection.id);
    expect(c.hds.beginOperationPlanAttempt(staleSelection, c.admission)).toBe(false);
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans[0]).not.toHaveProperty("recovery_hold_reason");
  }));

  it("J commit後ack前の中断は同結果再送で回復し、ID差替えを拒否して結果を二重追加しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const saved = c.execution.pendingResults()[0]!;
    const ack = vi.spyOn(c.execution, "acknowledgeResult").mockImplementationOnce(() => { throw new Error("fixture lost ack"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(1); expect(c.execution.pendingResults()).toHaveLength(1);
    ack.mockRestore();
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const checkpoint = c.j.load()!;
    expect(restarted.reconcileOperationPlanResult(saved.delivery, saved.delivery_digest)).toBe(true);
    expect(c.j.load()).toEqual(checkpoint); expect(checkpoint.plans[0]?.results).toHaveLength(1);
    const changed = structuredClone(saved.delivery); changed.feedback.result!.matches[0]!.line = "forged";
    expect(() => restarted.reconcileOperationPlanResult(changed, hash(changed))).toThrow("plan_delivery_identity_conflict");
    const foreign = structuredClone(saved.delivery); foreign.admission.execution_epoch = randomUUID();
    expect(() => restarted.reconcileOperationPlanResult(foreign, hash(foreign))).toThrow("plan_delivery_admission_mismatch");
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("配送時刻で鮮度を更新せず、旧revisionの結果へ帰属させる", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    const revised = structuredClone(c.plan); revised.steps[1]!.parameters!.max_results = 2;
    c.hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: c.plan.plan_id, expected_revision_digest: operationPlanDigest(c.plan), plan: revised })}`));
    const now = feedback.operation_core_result!.observed_at_ms + 600_001;
    c.advanceWallClockTo(now);
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch).adopted).toBe(1);
    expect(review(restarted, revised, "dependent")).toBeNull();
    const state = c.j.load()!.plans[0]!;
    expect(state.bindings[0]?.revision_digest).toBe(operationPlanDigest(c.plan));
    expect(state.results[0]?.expires_at_ms).toBe(feedback.operation_core_result!.observed_at_ms + 600_000);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("admissionが無い・まだ開始されていないJ bindingを保存結果から権限化しない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd); await c.executor.execute(c.approved, { save_result_delivery: true });
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(reconcileExecutionResults(restarted, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.results).toHaveLength(0); expect(c.execution.pendingResults()).toHaveLength(1);
    expect(review(restarted, c.plan, "search")).toBeNull(); expect(c.invoke).toHaveBeenCalledTimes(1);
    expect(() => executionAdmissionForCommand({ ...c.cmd, id: randomUUID() }, c.authority.receipt(c.approved))).toThrow();
  }));

  it("未呼出し結果も配送し、検証成功へ変換せず同ticketの再作用を防ぐ", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true, before_tool_dispatch: () => { throw new Error("fixture stop"); } });
    expect(feedback.operation_core_result?.action_outcome).toBe("not_attempted");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(c.j.load()?.plans[0]?.bindings[0]?.status).toBe("not_attempted"); expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    expect(review(c.hds, c.plan, "dependent")).toBeNull(); expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
  }));

  it("呼出し後の不明結果をdigestだけMへ記録し、成功・反省・再作用へ昇格させない", async () => fixture(async (c) => {
    const privateFailure = "synthetic response lost after dispatch";
    c.invoke.mockImplementationOnce(async (workerRequest) => {
      const identity = { worker_id: randomUUID(), worker_pid: process.pid,
        worker_platform: process.platform, worker_started_at_ms: Date.now(),
        ...(workerRequest.operation_plan_binding_digest
          ? { operation_plan_binding_digest: workerRequest.operation_plan_binding_digest } : {}),
        ...(workerRequest.task_identity_digest ? { task_identity_digest: workerRequest.task_identity_digest } : {}) };
      workerRequest.on_started(identity);
      workerRequest.before_dispatch();
      workerRequest.on_exit(identity, Date.now());
      throw new Error(privateFailure);
    });
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(feedback.status).toBe("failed");
    expect(feedback.operation_core_result).toMatchObject({ action_outcome: "unknown", execution_boundary: "tool_adapter" });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const saved = c.execution.lookup(c.admission.ticket_id)!;
    const checkpoint = c.j.load()!.plans[0]!;
    expect(checkpoint.bindings[0]).toMatchObject({ status: "outcome_unknown", delivery_digest: saved.result_delivery_digest });
    expect(checkpoint.results).toHaveLength(0);
    expect(checkpoint.bindings[0]?.memory_receipt).toBeDefined();
    const memory = inspectMemory(c);
    expect(memory.revision).toBe(1); expect(memory.records).toHaveLength(1);
    const observation = memory.records[0];
    expect(observation).toMatchObject({ schema_version: "operation-action-outcome.v1", record_type: "action_outcome_observation",
      plan_revision_digest: operationPlanDigest(c.plan), step_review_request_id: c.cmd.upstream_decision.request_id,
      command_id: c.cmd.id, upstream_commit_hash: c.cmd.upstream_decision.commit_hash,
      operation: "file.search", delivery_digest: saved.result_delivery_digest,
      result_digest: checkpoint.bindings[0]?.result_digest, plan_binding_status: "outcome_unknown",
      effect_observation: "unknown", adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false });
    expect(JSON.stringify(observation)).not.toContain(privateFailure);
    expect(review(c.hds, c.plan, "dependent")).toBeNull();
    expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
    expect(c.invoke).toHaveBeenCalledTimes(1);
    c.hds.closeOperationPlanMemory();
    const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(inspectMemory(c)).toEqual(memory);
    expect(restarted.getRuntimeSnapshot().operation_plans.plans[0]?.steps[0]?.status).toBe("outcome_unknown");
    expect(review(restarted, c.plan, "dependent")).toBeNull();
  }));

  it("outbox挿入後のreceipt保存故障を同じ取引でrollbackし、実結果を成功へ昇格しない", async () => fixture(async (c) => {
    const db = new DatabaseSync(c.executionPath);
    db.exec(`CREATE TRIGGER fixture_result_failure BEFORE UPDATE ON execution_intents
      WHEN json_extract(NEW.receipt_json,'$.result_delivery_digest') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;`);
    try {
      c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
      const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
      expect(feedback.status).toBe("failed"); expect(feedback.error).toMatch(/receipt persistence failed/);
      expect(c.execution.pendingResults()).toHaveLength(0); expect(c.execution.verifyEvents()).toBe(true);
      expect(c.execution.snapshot().records[0]?.state).toBe("outcome_unknown");
      expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 0, stale_generation_archived: 0 });
      expect(c.j.load()?.plans[0]?.results).toHaveLength(0); expect(c.invoke).toHaveBeenCalledTimes(1);
      expect((await c.executor.execute(c.approved)).error).toMatch(/already consumed/);
    } finally { db.close(); }
  }));

  it("私有outboxの本文改変と候補consumer追加を拒否する", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const saved = c.execution.pendingResults()[0]!;
    const augmented = { ...saved.delivery, feedback: { ...saved.delivery.feedback, meaning_update_proposal: {} } };
    expect(() => c.hds.reconcileOperationPlanResult(augmented, hash(augmented))).toThrow();
    const db = new DatabaseSync(c.executionPath);
    try {
      db.prepare("UPDATE execution_result_outbox SET delivery_json=? WHERE ticket_id=?").run('{}', c.admission.ticket_id);
      expect(c.execution.verifyEvents()).toBe(false);
      expect(() => c.execution.pendingResults()).toThrow("execution_event_integrity_failed");
      expect(() => c.execution.acknowledgeResult(c.admission.ticket_id, saved.delivery_digest)).toThrow("execution_event_integrity_failed");
      expect(c.j.load()?.plans[0]?.results).toHaveLength(0);
    } finally { db.close(); }
  }));

  it("実観測だけをMへ一度保存し、別DBの同receiptと元出力を読取照合して後続へ戻る", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const before = inspectMemory(c); expect(before.revision).toBe(1); expect(before.records).toHaveLength(1);
    const observation = before.records[0];
    expect(observation.adoption_status).toBe("observation_only"); expect(observation.used_as_world_truth).toBe(false);
    expect(observation.used_for_authority).toBe(false); expect(observation.may_execute).toBe(false);
    expect(observation.result.request_id).toBe(c.plan.request_id);
    expect(observation.step_review_request_id).toBe(c.cmd.upstream_decision.request_id);
    expect(observation.result.request_id).not.toBe(observation.step_review_request_id);
    expect(observation.output_digest).toBe(feedback.operation_core_result!.output_digest);
    expect(observation.result.output).toEqual(feedback.result);
    expect(hash(observation.result.output)).not.toBe(observation.output_digest); // M canonical保存でキー順が変わる。
    const jDb = new DatabaseSync(c.memory.database_path);
    try { expect(jDb.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'm_*'").all()).toHaveLength(0); }
    finally { jDb.close(); }
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(restarted.reconcileOperationPlanMemory()).toBe(true); expect(inspectMemory(c)).toEqual(before);
    expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call");
    const currentPlan = c.j.load()!.plans[0]!;
    const resultRead = restarted.decide(request(`plan:result ${JSON.stringify({ plan_id: c.plan.plan_id,
      revision_digest: currentPlan.revisions.at(-1)!.digest, step_id: "search" })}`));
    expect(resultRead.command).toMatchObject({ type: "noop", payload: { control_event: "operation_plan_result_return" } });
    const returned = restarted.takeOperationPlanSavedResultReturn(resultRead.command!);
    expect(returned).toMatchObject({ schema_version: "operation-plan-saved-result-return.v1",
      visited_files: 1, search_completeness: "unknown", matches: [{ path: "blue.txt", line_number: 1, line: "blue" }],
      used_as_world_truth: false, used_for_authority: false, may_execute: false });
    expect(JSON.stringify(returned)).not.toContain(c.workspace);
    expect(restarted.takeOperationPlanSavedResultReturn(resultRead.command!)).toBeUndefined();
    expect(c.invoke).toHaveBeenCalledTimes(1);
    const projection = JSON.stringify(restarted.getRuntimeSnapshot().operation_plans);
    for (const raw of [c.workspace, '"matches"', '"memory_commit"', c.admission.ticket_id]) expect(projection).not.toContain(raw);

    const privateRoot = c.memory.private_state_root;
    const operationPlansDirectory = join(privateRoot, "operation-plans");
    const executionDirectory = join(privateRoot, "execution-intents");
    mkdirSync(operationPlansDirectory, { recursive: true }); mkdirSync(executionDirectory, { recursive: true });
    const inspectedPlanPath = join(operationPlansDirectory, "j-state.sqlite");
    const inspectedExecutionPath = join(executionDirectory, "executor.sqlite");
    copyFileSync(c.jPath, inspectedPlanPath); copyFileSync(c.executionPath, inspectedExecutionPath);
    const inspectedPaths = [c.memory.database_path, inspectedPlanPath, inspectedExecutionPath];
    const inspectedBefore = inspectedPaths.map((file) => readFileSync(file));
    const recovery = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: join(c.root, "state") });
    const memoryCorrelation = recovery.operation_plan_correlations.find((item) => item.memory_update_id_digest !== null);
    expect(memoryCorrelation).toMatchObject({ memory_correlation: "matched" });
    expect(memoryCorrelation?.memory_update_id_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(recovery.ledgers.operation_plans).toMatchObject({ status: "verified", unverified_memory_link_count: 0 });
    expect(recovery.operation_plan_residual_count).toBe(0);
    expect(recovery.used_for_authority).toBe(false); expect(recovery.may_execute).toBe(false);
    const mismatchedMemory = {
      ...recovery.ledgers.m,
      updates: recovery.ledgers.m.updates.map((update) => update.update_id_digest === memoryCorrelation?.memory_update_id_digest
        ? { ...update, content_digest: "f".repeat(64) }
        : update),
    };
    const mismatchCorrelation = correlateOperationPlanBindings(
      recovery.ledgers.operation_plans,
      recovery.ledgers.execution,
      recovery.ledgers.j,
      mismatchedMemory,
      recovery.ledgers.cron_events,
      [],
    ).find((item) => item.memory_update_id_digest !== null);
    expect(mismatchCorrelation?.memory_correlation).toBe("content_mismatch");
    const recoveryJson = JSON.stringify(recovery);
    const savedCommit = c.j.load()!.plans[0]!.bindings.find((binding) => binding.memory_commit)?.memory_commit!;
    for (const raw of [savedCommit.update_id, savedCommit.j_event_id, c.workspace, "blue.txt", '"matches"']) {
      expect(recoveryJson).not.toContain(raw);
    }
    expect(inspectedPaths.map((file) => readFileSync(file))).toEqual(inspectedBefore);

    const currentCheckpoint = c.j.load()!;
    const checkpointWithoutMemoryLink = structuredClone(currentCheckpoint);
    const resultBinding = checkpointWithoutMemoryLink.plans[0]!.bindings.find((binding) => binding.memory_commit)!;
    delete resultBinding.memory_commit; delete resultBinding.memory_receipt;
    c.j.compareAndSet(operationPlanDigest(currentCheckpoint), checkpointWithoutMemoryLink);
    expect(c.j.load()!.plans[0]!.bindings.find((binding) => binding.step_id === resultBinding.step_id)?.memory_commit).toBeUndefined();
    copyFileSync(c.jPath, inspectedPlanPath);
    const missingLinkBefore = [readFileSync(inspectedPlanPath), readFileSync(c.memory.database_path)];
    const missingLinkReport = inspectGatewayRecoveryState({ BLUE_TANUKI_STATE_ROOT: join(c.root, "state") });
    expect(missingLinkReport.operation_plan_correlations.find((item) => item.plan_id_digest === memoryCorrelation?.plan_id_digest &&
      item.step_id_digest === memoryCorrelation.step_id_digest)?.memory_correlation)
      .toBe("missing_plan_memory_link");
    expect(missingLinkReport.operation_plan_residual_count).toBeGreaterThan(0);
    expect([readFileSync(inspectedPlanPath), readFileSync(c.memory.database_path)]).toEqual(missingLinkBefore);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it.each(["j_stage", "j_receipt", "checkpoint_receipt"])("%sの中断窓から保存済み同commitだけでM帰還を復旧する", async (window) => fixture(async (c) => {
    const path = window === "checkpoint_receipt" ? c.jPath : c.memory.database_path;
    const db = new DatabaseSync(path);
    if (window === "checkpoint_receipt") db.exec(`CREATE TRIGGER fixture_memory_failure BEFORE UPDATE ON operation_plan_state
      WHEN json_extract(NEW.checkpoint_json,'$.plans[0].bindings[0].memory_receipt') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture memory checkpoint failure'); END;`);
    else db.exec(`CREATE TRIGGER fixture_memory_failure BEFORE UPDATE ON j_state
      WHEN NEW.status='${window === "j_stage" ? "memory_commit_pending" : "ready"}'
      BEGIN SELECT RAISE(ABORT,'fixture memory receipt failure'); END;`);
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission);
    await c.executor.execute(c.approved, { save_result_delivery: true });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    const saved = c.j.load()!.plans[0]!.bindings[0]!.memory_commit;
    expect(saved).toBeDefined(); expect(c.j.load()!.plans[0]!.bindings[0]!.memory_receipt).toBeUndefined();
    const before = inspectMemory(c);
    expect(before.revision).toBe(window === "j_stage" ? 0 : 1);
    expect(review(c.hds, c.plan, "dependent")).toBeNull(); expect(c.hds.operationPlanCommandIsCurrent(c.cmd)).toBe(false);
    c.hds.closeOperationPlanMemory(); db.exec("DROP TRIGGER fixture_memory_failure"); db.close();
    const restarted = c.createHds(); expect(restarted.reconcileOperationPlanMemory()).toBe(true);
    expect(c.j.load()!.plans[0]!.bindings[0]!.memory_commit).toEqual(saved);
    const after = inspectMemory(c); expect(after.revision).toBe(1); expect(after.records).toHaveLength(1);
    if (before.revision === 1) expect(after.receipts).toEqual(before.receipts);
    expect(review(restarted, c.plan, "dependent")?.type).toBe("tool_call"); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("保存J commitの権限化・任意変更を再起動時に拒否する", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch); c.hds.closeOperationPlanMemory();
    const previous = c.j.load()!; const changed = structuredClone(previous);
    const b = changed.plans[0]!.bindings[0]!; const commit = b.memory_commit!;
    (commit.changes[0] as { value: Record<string, unknown> }).value.used_for_authority = true;
    const { content_digest: _digest, ...content } = commit; commit.content_digest = memoryCommitContentDigest(content);
    delete b.memory_receipt;
    // 通常writerはこの不正checkpointを拒否するため、保存DBを直接改変して
    // 再起動時の破損・権限化検査を再現する。
    const tamperedStore = new DatabaseSync(c.jPath);
    try {
      tamperedStore.prepare("UPDATE operation_plan_state SET checkpoint_json = ?, digest = ? WHERE id = 1")
        .run(JSON.stringify(changed), operationPlanDigest(changed));
    } finally { tamperedStore.close(); }
    const restarted = c.createHds();
    expect(restarted.getRuntimeSnapshot().operation_plans.plans).toHaveLength(0);
    expect(() => restarted.createExecutionAuthorityBinding(c.cmd)).toThrow("HDS execution authority source is unavailable");
    const persisted = new DatabaseSync(c.jPath);
    try {
      const row = persisted.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id = 1").get() as
        { checkpoint_json: string } | undefined;
      expect(JSON.parse(row!.checkpoint_json).plans[0].bindings[0].memory_commit.changes[0].value.used_for_authority).toBe(true);
    } finally { persisted.close(); }
    expect(inspectMemory(c).revision).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("J保存読取不能で配送ackを保留し、復旧後の同内容確認だけでackする", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    const lost = vi.spyOn(c.execution, "acknowledgeResult").mockImplementationOnce(() => { throw new Error("fixture ack interrupted"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 }); lost.mockRestore();
    const before = inspectMemory(c);
    const unavailable = vi.spyOn(c.j, "load").mockImplementation(() => { throw new Error("fixture J unavailable"); });
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 0, deferred: 1, stale_generation_archived: 0 });
    expect(c.execution.pendingResults()).toHaveLength(1); unavailable.mockRestore();
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));

  it("片方だけ失われたJ/M DBを新規初期化して履歴の確定と扱わない", async () => fixture(async (c) => {
    c.hds.beginOperationPlanAttempt(c.cmd, c.admission); await c.executor.execute(c.approved, { save_result_delivery: true });
    reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch); c.hds.closeOperationPlanMemory();
    rmSync(c.memory.database_path);
    expect(() => c.createHds()).toThrow(/schema_mismatch/); expect(inspectMemory(c).revision).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);
  }));
});

describe("保存済みGitHub結果→Gateway process→WebChat Owner表示", () => {
  for (const mode of ["accepted", "rejected", "unknown"] as const) {
    it(`${mode}結果を再送せずにOwnerへ返す`, async () => {
      const scenario = githubWriteScenario("issue.create");
      const tempRoot = mkdtempSync(join(tmpdir(), "blue-github-result-served-"));
      servedGatewayTempRoots.push(tempRoot);
      const workspace = join(tempRoot, "workspace");
      const stateRoot = join(tempRoot, "state");
      mkdirSync(workspace, { recursive: true });
      vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);
      let context: Awaited<ReturnType<typeof setup>> | undefined;
      let contextClosed = false;
      let gateway: ServedGatewayProcess | undefined;
      let socket: WebSocket | undefined;
      const frames: ServedGatewayFrame[] = [];

      try {
        // Seed a real HDS/J/M receipt using only the test-owned synthetic adapter.
        mockSyntheticGitHubWrite(mode, scenario);
        context = await setup(tempRoot, workspace, (id) => githubWriteCandidate(id, scenario));
        expect(context.hds.beginOperationPlanAttempt(context.cmd, context.admission)).toBe(true);
        const feedback = await context.executor.execute(context.approved, { save_result_delivery: true });
        expect(feedback.status).toBe(mode === "accepted" ? "success" : "failed");
        finalizeCommandOutput({ hds: context.hds, command: context.cmd, feedback,
          request_id: context.plan.request_id, target_surface: "channel" });
        expect(reconcileExecutionResults(context.hds, context.execution, context.admission.execution_epoch))
          .toMatchObject({ adopted: 1, deferred: 0 });

        const savedPlan = context.j.load()?.plans[0];
        const savedBinding = savedPlan?.bindings.at(-1);
        expect(savedBinding?.status).toBe(mode === "accepted" ? "verified"
          : mode === "rejected" ? "provider_rejected" : "outcome_unknown");
        const memory = JSON.stringify(inspectMemory(context));
        for (const privateValue of scenario.private_values) expect(memory).not.toContain(privateValue);
        expect(githubWriteTool.invoke).toHaveBeenCalledTimes(1);
        if (!savedPlan) throw new Error("synthetic GitHub result plan was not persisted");
        const resultControl = { plan_id: context.plan.plan_id,
          revision_digest: savedPlan.revisions.at(-1)!.digest, step_id: scenario.step_id };

        // The served process reopens this exact J checkpoint and the same M receipt store.
        for (const hds of context.controllers) {
          hds.closeOperationPlanMemory();
          hds.close();
        }
        context.controllers.splice(0, context.controllers.length);
        context.execution.close();
        context.j.close();
        contextClosed = true;
        const runtimePlanState = join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
        mkdirSync(dirname(runtimePlanState), { recursive: true });
        copyFileSync(context.jPath, runtimePlanState);
        const completeHistory = new CompleteHistoryStore({ filepath: join(tempRoot, "complete-history.jsonl") });
        completeHistory.append({ kind: "audit_history", actor: "synthetic-fixture", source: "f05-02-result-seed",
          timestamp: Date.now(), payload: { synthetic: true, used_for_authority: false } });
        expect(completeHistory.verify()).toBe(true);

        const gatewayPort = await reserveServedGatewayPort();
        gateway = startServedGateway(gatewayPort, stateRoot, workspace, tempRoot);
        await waitForServedGatewayHealth(gatewayPort, gateway);
        socket = await connectServedGatewayWebChat(gatewayPort, "fixture-owner", frames);

        const response = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
          method: "POST",
          headers: { authorization: "Bearer f05.02-synthetic-webchat-token", "content-type": "application/json" },
          body: JSON.stringify({ user: "fixture-owner", content: `plan:result ${JSON.stringify(resultControl)}` }),
        });
        expect(response.status).toBe(202);
        const frame = await waitForServedGatewayFrame(frames, gateway,
          (item) => item.kind === "channel_send" && typeof item.content === "string" &&
            item.content.includes("保存済みGitHub操作結果（issue.create）"));
        const content = String(frame.content);
        expect(content).toContain("この結果照会は操作を再実行しません。");
        expect(content).toContain(mode === "accepted" ? "GitHub APIが受理を返しました。"
          : mode === "rejected" ? "GitHub APIが明示的に拒否しました。自動再送は行っていません。"
            : "作用結果は不明です。自動再送は行っていません。");
        expect(content).toContain(`HTTP status: ${mode === "accepted" ? "201" : mode === "rejected" ? "403" : "不明"}`);
        for (const privateValue of scenario.private_values) expect(content).not.toContain(privateValue);
        expect(gateway.child.exitCode).toBeNull();
      } finally {
        if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.terminate();
        if (gateway) await stopServedGateway(gateway);
        if (context && !contextClosed) {
          for (const hds of context.controllers) {
            hds.closeOperationPlanMemory();
            hds.close();
          }
          context.execution.close();
          context.j.close();
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 45_000);
  }
});

describe("WebChat OwnerのL3確認→合成GitHub write→保存結果", () => {
  it.each(githubWriteCases)(
    "実Gateway processは$operation/$comment_kindを明示L3承認後だけ一度送信し、同じOwnerへ保存結果を返す",
    async ({ operation, comment_kind, inline_range }) => {
    const inlineReview = comment_kind === "pull_request_review_inline";
    const inlineRange = inlineReview && inline_range === true;
    const scenario = githubWriteScenario(operation, comment_kind, inline_range);
    const title = String(scenario.parameters.title ?? "");
    const body = String(scenario.parameters.body);
    const repositoryPath = "/repos/fixture-owner/synthetic-repo";
    const issueTargetPath = `/repos/${String(scenario.parameters.owner)}/${String(scenario.parameters.repo)}/issues/${String(scenario.parameters.number ?? 7)}`;
    const fakeGitHubToken = "f05.02-synthetic-github-token";
    const tempRoot = mkdtempSync(join(tmpdir(), "blue-github-write-served-"));
    servedGatewayTempRoots.push(tempRoot);
    const workspace = join(tempRoot, "workspace");
    const stateRoot = join(tempRoot, "state");
    mkdirSync(workspace, { recursive: true });
    vi.stubEnv("BLUE_TANUKI_FILE_ROOT", workspace);

    const mockRequests: Array<{ method: string; path: string; authorization: string | undefined; body: string }> = [];
    const mockResponses: Array<{ method: string; path: string; status: number; finished: boolean; closed: boolean }> = [];
    const unexpectedMockRequests: Array<{ method: string; path: string }> = [];
    const mutationRequests = () => mockRequests.filter((item) => item.method === scenario.method && item.path === scenario.path);
    const mockServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        const requestBody = Buffer.concat(chunks).toString("utf8");
        const path = request.url ?? "";
        const method = request.method ?? "";
        const responseRecord = { method, path, status: 0, finished: false, closed: false };
        mockResponses.push(responseRecord);
        response.on("finish", () => { responseRecord.finished = true; });
        response.on("close", () => { responseRecord.closed = true; });
        mockRequests.push({ method, path, authorization: request.headers.authorization, body: requestBody });
        response.setHeader("content-type", "application/json; charset=utf-8");
        if (method === "GET" && path === repositoryPath) {
          response.statusCode = 200;
          responseRecord.status = response.statusCode;
          response.end(JSON.stringify({ id: 424242, full_name: "fixture-owner/synthetic-repo", name: "synthetic-repo",
            private: false, default_branch: "main", owner: { login: "fixture-owner" } }));
          return;
        }
        const branchPathPrefix = `${repositoryPath}/branches/`;
        if (operation === "pr.create" && method === "GET" && path.startsWith(branchPathPrefix)) {
          const branchRef = decodeURIComponent(path.slice(branchPathPrefix.length));
          const headRef = String(scenario.parameters.head);
          const baseRef = String(scenario.parameters.base);
          const sha = branchRef === headRef ? scenario.target_fields.head_commit_sha
            : branchRef === baseRef ? scenario.target_fields.base_commit_sha : undefined;
          if (sha) {
            response.statusCode = 200;
            responseRecord.status = response.statusCode;
            response.end(JSON.stringify({ name: branchRef, commit: { sha } }));
            return;
          }
        }
        const pullRequestPath = `/repos/${String(scenario.parameters.owner)}/${String(scenario.parameters.repo)}/pulls/${String(scenario.parameters.number ?? 7)}`;
        if (inlineReview && method === "GET" && path === pullRequestPath) {
          response.statusCode = 200;
          responseRecord.status = response.statusCode;
          response.end(JSON.stringify({ id: scenario.target_fields.pull_request_id,
            number: scenario.target_fields.pull_request_number, state: scenario.target_fields.pull_request_state,
            head: { sha: scenario.target_fields.pull_request_head_sha },
            base: { sha: scenario.target_fields.pull_request_base_sha } }));
          return;
        }
        if (inlineReview && method === "GET" && path === `${pullRequestPath}/files?per_page=100&page=1`) {
          response.statusCode = 200;
          responseRecord.status = response.statusCode;
          response.end(JSON.stringify([{ filename: scenario.parameters.path, status: "modified",
            patch: inlineRange ? githubInlineRangePatch : githubInlinePatch }]));
          return;
        }
        if ((operation === "issue.update" || operation === "issue.comment.create" || operation === "pr.comment.create") &&
          method === "GET" && path === issueTargetPath) {
          const isPullRequest = operation === "pr.comment.create";
          response.statusCode = 200;
          responseRecord.status = response.statusCode;
          response.end(JSON.stringify({
            id: isPullRequest ? scenario.target_fields.pull_request_id : scenario.target_fields.issue_id,
            number: isPullRequest ? scenario.target_fields.pull_request_number : scenario.target_fields.issue_number,
            state: isPullRequest ? scenario.target_fields.pull_request_state : scenario.target_fields.issue_state,
            locked: isPullRequest ? scenario.target_fields.pull_request_locked : scenario.target_fields.issue_locked,
            updated_at: isPullRequest ? scenario.target_fields.pull_request_updated_at : scenario.target_fields.issue_updated_at,
            title: scenario.target_fields.issue_title ?? (isPullRequest ? "synthetic pull request target title" : "synthetic issue target title"),
            body: scenario.target_fields.issue_body ?? null,
            ...(isPullRequest ? { pull_request: { url: `https://api.github.com/repos/fixture-owner/synthetic-repo/pulls/${String(scenario.parameters.number)}` } } : {}) }));
          return;
        }
        if (method === scenario.method && path === scenario.path) {
          response.statusCode = scenario.accepted_status;
          responseRecord.status = response.statusCode;
          response.end(JSON.stringify(scenario.accepted_provider_response));
          return;
        }
        unexpectedMockRequests.push({ method, path });
        response.statusCode = 404;
        responseRecord.status = response.statusCode;
        response.end(JSON.stringify({ message: "synthetic GitHub fixture has no such route" }));
      });
    });

    let context: Awaited<ReturnType<typeof setupPlanOnly>> | undefined;
    let contextClosed = false;
    let gateway: ServedGatewayProcess | undefined;
    let socket: WebSocket | undefined;
    let mockPort: number | undefined;
    const frames: ServedGatewayFrame[] = [];

    try {
      mockServer.listen(0, "127.0.0.1");
      await once(mockServer, "listening");
      const mockAddress = mockServer.address();
      if (!mockAddress || typeof mockAddress === "string") throw new Error("synthetic GitHub loopback port unavailable");
      mockPort = mockAddress.port;

      context = await setupPlanOnly(tempRoot, workspace, (id) => githubWriteCandidate(id, scenario));
      const initialPlanState = context.j.load()?.plans[0];
      if (!initialPlanState) throw new Error("synthetic GitHub Operation Plan was not persisted");
      expect(initialPlanState.bindings).toHaveLength(0);
      expect(initialPlanState.revisions.at(-1)?.plan.steps[0]?.state).toBe("planned");
      const planId = context.plan.plan_id;
      const initialRevisionDigest = initialPlanState.revisions.at(-1)!.digest;
      const stepId = scenario.step_id;

      // Transfer the unreviewed plan to the real Gateway process without preserving an open J writer.
      for (const hds of context.controllers) {
        hds.closeOperationPlanMemory();
        hds.close();
      }
      context.controllers.splice(0, context.controllers.length);
      context.execution.close();
      context.j.close();
      contextClosed = true;
      const runtimePlanState = join(stateRoot, "private-state", "operation-plans", "j-state.sqlite");
      mkdirSync(dirname(runtimePlanState), { recursive: true });
      copyFileSync(context.jPath, runtimePlanState);
      const completeHistoryPath = join(tempRoot, "complete-history.jsonl");
      const completeHistory = new CompleteHistoryStore({ filepath: completeHistoryPath });
      completeHistory.append({ kind: "audit_history", actor: "synthetic-fixture", source: "f05-02-live-process-seed",
        timestamp: Date.now(), payload: { synthetic: true, used_for_authority: false } });
      expect(completeHistory.verify()).toBe(true);

      const gatewayPort = await reserveServedGatewayPort();
      const networkGuardPath = resolve(findWorkspaceRoot(), "apps", "gateway", "test", "fixtures", "github_loopback_network_guard.cjs");
      gateway = startServedGateway(gatewayPort, stateRoot, workspace, tempRoot, { githubMockPort: mockPort, networkGuardPath });
      await waitForServedGatewayHealth(gatewayPort, gateway);
      socket = await connectServedGatewayWebChat(gatewayPort, "fixture-owner", frames);

      const reviewRequest = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST",
        headers: { authorization: "Bearer f05.02-synthetic-webchat-token", "content-type": "application/json" },
        body: JSON.stringify({ user: "fixture-owner", content: `plan:review ${JSON.stringify({
          plan_id: planId, revision_digest: initialRevisionDigest, step_id: stepId,
        })}` }),
      });
      expect(reviewRequest.status).toBe(202);

      const loadQueue = async (): Promise<{ pending_approvals: Array<Record<string, unknown>> }> => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/approval`, {
          headers: { authorization: "Bearer f05.02-synthetic-resume-token" },
        });
        if (response.status !== 200) throw new Error("synthetic Owner approval queue was unavailable");
        return await response.json() as { pending_approvals: Array<Record<string, unknown>> };
      };
      let pending: Record<string, unknown> | undefined;
      const approvalDeadline = Date.now() + 10_000;
      while (Date.now() < approvalDeadline && !pending) {
        const queue = await loadQueue();
        pending = queue.pending_approvals.find((item) => item.approval_level === "L3_final_review" &&
          item.final_review_required === true && item.content_review_required === true &&
          String(item.operation ?? item.target ?? "").includes("github.write"));
        if (!pending) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!pending) throw new Error("synthetic GitHub write did not reach the L3 content-review queue");
      expect(typeof pending.command_id).toBe("string");
      expect(typeof pending.approval_token).toBe("string");
      expect(String(pending.operation ?? pending.target)).toContain("github.write");
      expect(mutationRequests()).toHaveLength(0);

      const approvalUrl = `http://127.0.0.1:${gatewayPort}/approval/${encodeURIComponent(String(pending.command_id))}`;
      const prematureApproval = await fetch(approvalUrl, {
        method: "POST",
        headers: { authorization: "Bearer f05.02-synthetic-resume-token", "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: pending.approval_token }),
      });
      expect(prematureApproval.status).toBe(409);
      expect(await prematureApproval.json()).toMatchObject({ error: "approval_content_review_required" });
      expect(mutationRequests()).toHaveLength(0);

      const contentReviewResponse = await fetch(`${approvalUrl}/content`, {
        method: "POST",
        headers: { authorization: "Bearer f05.02-synthetic-resume-token" },
      });
      const contentReviewText = await contentReviewResponse.text();
      expect(contentReviewResponse.status, JSON.stringify({
        response: contentReviewText,
        github_routes: mockRequests.map(({ method, path }) => ({ method, path })),
        mock_responses: mockResponses,
        unexpected_routes: unexpectedMockRequests,
        gateway_stderr: gateway.stderr.join(""),
      })).toBe(200);
      expect(contentReviewResponse.headers.get("cache-control")).toBe("no-store");
      const contentReview = JSON.parse(contentReviewText) as Record<string, unknown>;
      const expectedReview = operation === "issue.create"
        ? { kind: "github_issue_create", operation: "github.write.issue.create", title, body }
        : operation === "issue.update"
          ? { kind: "github_issue_update", operation: "github.write.issue.update", issue_number: 7,
            current_title: "prior synthetic issue title", current_body: "prior synthetic issue body",
            requested_title: title, requested_body: body }
          : operation === "issue.comment.create"
            ? { kind: "github_issue_comment_create", operation: "github.write.issue.comment.create",
              issue_id: 424244, issue_number: 7, issue_state: "open", issue_locked: false,
              issue_updated_at: "2026-11-08T01:02:03.000Z", issue_title: "synthetic issue target title", body }
            : operation === "pr.create"
              ? { kind: "github_pull_request_create", operation: "github.write.pr.create",
                head_repository_id: 424242, head_canonical_full_name: "fixture-owner/synthetic-repo",
                head_ref: "feature/synthetic", head_commit_sha: "a".repeat(40), base_ref: "main",
                base_commit_sha: "b".repeat(40), title, body, draft: true, draft_was_defaulted: false,
                maintainer_can_modify: false, publication_effect: "visible_to_repository_audience",
                creation_is_reversible: false }
              : inlineReview
                ? { kind: "github_pull_request_comment_create", operation: "github.write.pr.comment.create",
                  pull_request_id: scenario.target_fields.pull_request_id, pull_request_number: 7,
                  pull_request_state: "open", pull_request_locked: false,
                  pull_request_updated_at: "2026-11-08T01:02:04.000Z",
                  pull_request_title: "synthetic pull request target title",
                  comment_kind: "pull_request_review_inline", path: scenario.parameters.path,
                  ...(inlineRange ? { start_line: scenario.parameters.start_line, start_side: scenario.parameters.start_side } : {}),
                  line: scenario.parameters.line, side: scenario.parameters.side,
                  head_commit_sha: scenario.target_fields.pull_request_head_sha,
                  base_commit_sha: scenario.target_fields.pull_request_base_sha,
                  diff_digest: scenario.target_fields.pull_request_diff_digest,
                  diff_excerpt: expect.stringContaining("new synthetic diff value"), body,
                  publication_effect: "visible_to_repository_audience", comment_removal_retracts_notifications: false }
                : { kind: "github_pull_request_comment_create", operation: "github.write.pr.comment.create",
                pull_request_id: 424246, pull_request_number: 7, pull_request_state: "open", pull_request_locked: false,
                pull_request_updated_at: "2026-11-08T01:02:04.000Z", pull_request_title: "synthetic pull request target title",
                comment_kind: "pull_request_timeline", body, publication_effect: "visible_to_repository_audience",
                comment_removal_retracts_notifications: false };
      expect(contentReview).toMatchObject({
        ...expectedReview,
        requested_owner: "fixture-owner", requested_repo: "synthetic-repo", canonical_full_name: "fixture-owner/synthetic-repo",
        repository_id: 424242, repository_visibility: "public",
        request_payload_digest: scenario.request_payload_digest, notification_effect: "github_api_may_trigger_notifications",
        provider_observation_is_atomic: false, used_for_authority: false, may_execute: false });
      expect(contentReview.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(contentReview.review_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(contentReview)).not.toContain(fakeGitHubToken);
      expect(mutationRequests()).toHaveLength(0);

      const githubRequestCountBeforeApproval = mockRequests.length;
      const finalApproval = await fetch(approvalUrl, {
        method: "POST",
        headers: { authorization: "Bearer f05.02-synthetic-resume-token", "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approve", approval_token: pending.approval_token,
          content_review_digest: contentReview.review_digest }),
      });
      const finalApprovalText = await finalApproval.text();
      expect(finalApproval.status, JSON.stringify({ response: finalApprovalText,
        mock_requests: mockRequests.map(({ method, path }) => ({ method, path })), gateway_stderr: gateway.stderr.join("") })).toBe(200);
      const finalApprovalBody = JSON.parse(finalApprovalText) as Record<string, unknown>;
      expect(finalApprovalBody, JSON.stringify({ finalApprovalBody,
        mock_requests: mockRequests.map(({ method, path, authorization, body }) => ({ method, path,
          authorization_present: !!authorization, body_bytes: Buffer.byteLength(body) })), unexpectedMockRequests,
        mock_responses: mockResponses,
        gateway_stderr: gateway.stderr.join("") })).toMatchObject({ ok: true,
        result: { approval: "approve", executed: true } });

      const issueWriteDeadline = Date.now() + 10_000;
      while (Date.now() < issueWriteDeadline && mutationRequests().length === 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      const writes = mutationRequests();
      expect(writes, JSON.stringify({ mock_requests: mockRequests.map(({ method, path, authorization, body }) => ({ method,
        path, authorization_present: !!authorization, body_bytes: Buffer.byteLength(body) })), unexpectedMockRequests,
        mock_responses: mockResponses, finalApprovalBody, gateway_stderr: gateway.stderr.join("") })).toHaveLength(1);
      expect(writes[0]?.authorization).toBe(`Bearer ${fakeGitHubToken}`);
      const expectedMutationBody = operation === "pr.comment.create" && inlineReview
        ? { body, path: scenario.parameters.path,
          ...(inlineRange ? { start_line: scenario.parameters.start_line, start_side: scenario.parameters.start_side } : {}),
          line: scenario.parameters.line, side: scenario.parameters.side,
          commit_id: scenario.target_fields.pull_request_head_sha }
        : operation === "issue.comment.create" || operation === "pr.comment.create"
          ? { body }
        : operation === "pr.create"
          ? { title, body, head: scenario.parameters.head, base: scenario.parameters.base, draft: true, maintainer_can_modify: false }
          : { title, body };
      expect(JSON.parse(writes[0]!.body)).toEqual(expectedMutationBody);
      if (operation === "issue.update" || operation === "issue.comment.create" || operation === "pr.comment.create") {
        const writeIndex = mockRequests.findIndex((item) => item.method === scenario.method && item.path === scenario.path);
        const postApprovalIssueReadIndexes = mockRequests.map((item, index) => ({ item, index }))
          .filter(({ item, index }) => index >= githubRequestCountBeforeApproval && item.method === "GET" && item.path === issueTargetPath)
          .map(({ index }) => index);
        expect(postApprovalIssueReadIndexes.length).toBeGreaterThan(0);
        expect(postApprovalIssueReadIndexes.at(-1)!).toBeLessThan(writeIndex);
      }
      if (operation === "pr.create") {
        const branchPathPrefix = `${repositoryPath}/branches/`;
        const prBranchRefs = [String(scenario.parameters.head), String(scenario.parameters.base)];
        const writeIndex = mockRequests.findIndex((item) => item.method === scenario.method && item.path === scenario.path);
        for (const branchRef of prBranchRefs) {
          const postApprovalBranchReadIndexes = mockRequests.map((item, index) => ({ item, index }))
            .filter(({ item, index }) => index >= githubRequestCountBeforeApproval && item.method === "GET" &&
              item.path.startsWith(branchPathPrefix) && decodeURIComponent(item.path.slice(branchPathPrefix.length)) === branchRef)
            .map(({ index }) => index);
          expect(postApprovalBranchReadIndexes.length,
            JSON.stringify(mockRequests.map(({ method, path }) => ({ method, path })))).toBeGreaterThan(0);
          expect(postApprovalBranchReadIndexes.at(-1)!).toBeLessThan(writeIndex);
        }
      }
      expect(unexpectedMockRequests).toEqual([]);
      expect(mockRequests.length).toBeGreaterThan(1);
      for (const item of mockRequests) expect(item.authorization).toBe(`Bearer ${fakeGitHubToken}`);

      const persistedDb = new DatabaseSync(runtimePlanState);
      let persistedPlan: ReturnType<OperationPlanStateStore["load"]>["plans"][number];
      try {
        const row = persistedDb.prepare("SELECT checkpoint_json FROM operation_plan_state WHERE id = 1").get() as
          { checkpoint_json: string } | undefined;
        if (!row) throw new Error("Gateway process did not persist the J Operation Plan checkpoint");
        persistedPlan = (JSON.parse(row.checkpoint_json) as ReturnType<OperationPlanStateStore["load"]>).plans[0]!;
      } finally { persistedDb.close(); }
      expect(persistedPlan.bindings.at(-1), JSON.stringify({ requests: mockRequests.map(({ method, path }) => ({ method, path })),
        responses: mockResponses.map(({ method, path, status }) => ({ method, path, status })), unexpectedMockRequests,
        approval: finalApprovalBody, gateway_stderr: gateway.stderr.join("") })).toMatchObject({ status: "verified", operation: "github.write",
        github_write_result: { operation, mutation_status: "provider_accepted", http_status: scenario.accepted_status,
          used_for_authority: false, may_execute: false } });
      const memory = JSON.stringify(inspectMemory(context));
      expect(inspectMemory(context).receipts.length).toBeGreaterThan(0);
      for (const privateValue of [...scenario.private_values, fakeGitHubToken]) expect(memory).not.toContain(privateValue);
      const persistedGatewayMemory = existsSync(join(tempRoot, "memory.jsonl"))
        ? readFileSync(join(tempRoot, "memory.jsonl"), "utf8") : "";

      const latestRevisionDigest = persistedPlan.revisions.at(-1)!.digest;
      const resultRead = await fetch(`http://127.0.0.1:${gatewayPort}/operators/developer/invoke`, {
        method: "POST",
        headers: { authorization: "Bearer f05.02-synthetic-webchat-token", "content-type": "application/json" },
        body: JSON.stringify({ user: "fixture-owner", content: `plan:result ${JSON.stringify({
          plan_id: planId, revision_digest: latestRevisionDigest, step_id: stepId,
        })}` }),
      });
      expect(resultRead.status).toBe(202);
      const resultFrame = await waitForServedGatewayFrame(frames, gateway,
        (item) => item.kind === "channel_send" && typeof item.content === "string" &&
          item.content.includes(`保存済みGitHub操作結果（${operation}）`));
      const resultContent = String(resultFrame.content);
      expect(resultContent).toContain("GitHub APIが受理を返しました。");
      expect(resultContent).toContain(`HTTP status: ${scenario.accepted_status}`);
      expect(resultContent).toContain("この結果照会は操作を再実行しません。");
      for (const privateValue of scenario.private_values) expect(resultContent).not.toContain(privateValue);
      expect(mutationRequests()).toHaveLength(1);

      const persistedAudit = readUtf8FilesUnder(join(tempRoot, "audit")).join("\n");
      const persistedHistory = readFileSync(completeHistoryPath, "utf8");
      const persistedSessions = readUtf8FilesUnder(join(tempRoot, "sessions")).join("\n");
      const processOutput = gateway.stdout.join("") + gateway.stderr.join("");
      for (const privateValue of [...scenario.private_values, fakeGitHubToken]) {
        expect(persistedGatewayMemory).not.toContain(privateValue);
        expect(persistedAudit).not.toContain(privateValue);
        expect(persistedHistory).not.toContain(privateValue);
        expect(persistedSessions).not.toContain(privateValue);
        expect(processOutput).not.toContain(privateValue);
      }
      expect(gateway.child.exitCode).toBeNull();
    } finally {
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.terminate();
      if (gateway) await stopServedGateway(gateway);
      if (mockServer.listening) {
        await new Promise<void>((resolveClose, rejectClose) => mockServer.close((error) => error ? rejectClose(error) : resolveClose()));
      }
      if (context && !contextClosed) {
        for (const hds of context.controllers) {
          hds.closeOperationPlanMemory();
          hds.close();
        }
        context.execution.close();
        context.j.close();
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 45_000);
});

interface ServedGatewayFrame {
  readonly kind?: string;
  readonly content?: string;
  readonly [key: string]: unknown;
}

interface ServedGatewayProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function startServedGateway(port: number, stateRoot: string, workspace: string, tempRoot: string,
  options: { githubMockPort?: number; networkGuardPath?: string } = {}): ServedGatewayProcess {
  const repositoryRoot = findWorkspaceRoot();
  const entrypoint = join(repositoryRoot, "apps", "gateway", "dist", "main.js");
  if (!existsSync(entrypoint)) throw new Error("built Gateway process entrypoint is unavailable");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    WEBCHAT_HOST: "127.0.0.1",
    WEBCHAT_PORT: String(port),
    WEBCHAT_TOKEN: "f05.02-synthetic-webchat-token",
    WEBCHAT_RESUME_TOKEN: "f05.02-synthetic-resume-token",
    BLUE_TANUKI_OWNER_TOKEN: "f05.02-synthetic-owner-token",
    BLUE_TANUKI_MAINTENANCE_TOKEN: "f05.02-synthetic-maintenance-token",
    BLUE_TANUKI_FILE_ROOT: workspace,
    BLUE_TANUKI_STATE_ROOT: stateRoot,
    BLUE_TANUKI_MEMORY_FILE: join(tempRoot, "memory.jsonl"),
    BLUE_TANUKI_AUDIT_DIR: join(tempRoot, "audit"),
    BLUE_TANUKI_COMPLETE_HISTORY_FILE: join(tempRoot, "complete-history.jsonl"),
    BLUE_TANUKI_SESSION_DIR: join(tempRoot, "sessions"),
    BLUE_TANUKI_SCHEDULES_DIR: join(tempRoot, "schedules"),
    BLUE_TANUKI_APPROVAL_MODE: "full_access",
    LLM_BACKEND: "stub",
  });
  if (options.githubMockPort !== undefined) {
    Object.assign(env, {
      GITHUB_TOKEN: "f05.02-synthetic-github-token",
      BLUE_TANUKI_GITHUB_REPOS: "fixture-owner/synthetic-repo",
      BT_F05_02_GITHUB_MOCK_PORT: String(options.githubMockPort),
    });
  }
  // No host GITHUB_TOKEN or provider credential is inherited; the configured mock gets only a synthetic token.
  const args = options.networkGuardPath ? ["--require", options.networkGuardPath, entrypoint, "--serve"] : [entrypoint, "--serve"];
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot, env, stdio: "pipe", windowsHide: true,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  return { child, stdout, stderr };
}

function findWorkspaceRoot(): string {
  let root = resolve(process.cwd());
  while (!existsSync(join(root, "pnpm-workspace.yaml")) && dirname(root) !== root) root = dirname(root);
  if (!existsSync(join(root, "pnpm-workspace.yaml"))) throw new Error("Gateway test could not locate pnpm workspace root");
  return root;
}

function readUtf8FilesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const pending = [root];
  const contents: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) contents.push(readFileSync(path, "utf8"));
    }
  }
  return contents;
}

async function reserveServedGatewayPort(): Promise<number> {
  const server = (await import("node:http")).createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("served Gateway port reservation failed");
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function waitForServedGatewayHealth(port: number, gateway: ServedGatewayProcess): Promise<void> {
  // The Windows workspace review/import of all bundled plugins takes about 12 seconds locally.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) {
      throw new Error(`served Gateway exited before health: ${gateway.stderr.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* local Gateway startup is still in progress */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`served Gateway health timed out; stdout=${gateway.stdout.join("")}; stderr=${gateway.stderr.join("")}`);
}

async function connectServedGatewayWebChat(port: number, user: string, frames: ServedGatewayFrame[]): Promise<WebSocket> {
  const ticketResponse = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
    method: "POST",
    headers: { authorization: "Bearer f05.02-synthetic-webchat-token", "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });
  if (!ticketResponse.ok) throw new Error(`served WebChat ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
  const ticket = (await ticketResponse.json() as { ticket?: string }).ticket;
  if (!ticket) throw new Error("served WebChat ticket was missing");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
  socket.on("message", (data) => {
    try { frames.push(JSON.parse(data.toString("utf8")) as ServedGatewayFrame); } catch { /* ignore malformed fixture frames */ }
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", rejectOpen);
  });
  return socket;
}

async function waitForServedGatewayFrame(
  frames: readonly ServedGatewayFrame[], gateway: ServedGatewayProcess,
  predicate: (frame: ServedGatewayFrame) => boolean,
): Promise<ServedGatewayFrame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`served Gateway exited: ${gateway.stderr.join("")}`);
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`served Gateway result frame timed out; frames=${JSON.stringify(frames)}; stderr=${gateway.stderr.join("")}`);
}

async function stopServedGateway(gateway: ServedGatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  const closed = once(gateway.child, "close");
  if (!gateway.child.kill("SIGTERM")) throw new Error("test-owned Gateway process could not be stopped");
  await closed;
}

function reflect(c: Awaited<ReturnType<typeof setup>>, hds = c.hds, changes: Record<string, unknown> = {}) {
  const p = hds.getRuntimeSnapshot().operation_plans.plans[0]!;
  return hds.decide(request(`plan:reflect ${JSON.stringify({ plan_id: p.plan_id, revision_digest: p.revision_digest,
    step_ids: [p.steps[0]!.step_id], question: "この観測で何が言えて、何が未確認か", ...changes })}`));
}
function reflectionExecutor(c: Awaited<ReturnType<typeof setup>>, mutate?: (response: LLMResponse) => LLMResponse) {
  const call = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    const projection = JSON.parse(req.messages[0]!.content.split("\n").at(-1)!);
    const response = { content: JSON.stringify({ schema_version: "operation-result-reflection-candidate.v1",
      projection_digest: operationPlanDigest(projection), citations: projection.citations.map((source: {record_id: string; record_digest: string}) => ({
        record_id: source.record_id, record_digest: source.record_digest,
        interpretation: "検索で1件の一致が報告された", uncertainty: "完全走査と現在の外界状態は未確認" })) }),
      model: "fixture", tokens_used: 0 };
    return mutate ? mutate(response) : response;
  });
  const llm = { name: "fixture", call };
  const history = { getMessages: vi.fn(async () => [{ role: "user" as const, content: "private-history-sentinel", timestamp: 1 }]),
    append: vi.fn(async () => {}), clear: vi.fn(async () => {}), size: async () => 1 };
  const executor = new Executor({ tools: new ToolRegistry(), approval_authority: c.authority,
    llm, compute: new LLMComputeAdapter(llm), session_store: history });
  return { executor, call, history };
}
async function recordActualObservation(c: Awaited<ReturnType<typeof setup>>) {
  expect(c.hds.beginOperationPlanAttempt(c.cmd, c.admission)).toBe(true);
  const feedback = await c.executor.execute(c.approved, { save_result_delivery: true });
  expect(feedback.status, feedback.status === "failed" ? feedback.error ?? "executor_failed_without_error" : undefined).toBe("success");
  expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
}
describe("受領済みM実観測→有限C射影→表示前J照合", () => {
  it("実worker観測をraw/historyなしでCへ戻し、未採用解釈だけを表示する", async () => fixture(async (c) => {
    await recordActualObservation(c); const before = inspectMemory(c);
    const calls = { capture: c.oldMemory.capture.mock.calls.length, recent: c.oldMemory.recent.mock.calls.length };
    const decision = reflect(c); const command = decision.command!;
    expect(command.type).toBe("llm_call"); if (command.type !== "llm_call") throw new Error("expected reflection");
    expect(command.payload.session_id).toBeUndefined(); expect(command.payload.compute_context?.data_exposure.input_sources)
      .toEqual(["accepted_inbound_request", "selected_memory_references"]);
    expect(decision.log.memory_capture_suppressed_for).toBe("operation_result_reflection");
    expect(c.oldMemory.capture).toHaveBeenCalledTimes(calls.capture); expect(c.oldMemory.recent).toHaveBeenCalledTimes(calls.recent);
    const visible = JSON.stringify(command.payload);
    const planState = c.j.load()!.plans[0]!;
    expect(visible).toContain("operation-result-current-projection.v2");
    expect(command.payload.compute_context?.local_p_version).toBe("blue-tanuki.result-reflection.v2");
    expect(visible).toContain(planTaskIdentityDigest(planState.owner, planState.channel, planState.goal,
      c.plan.plan_id, c.plan.request_id));
    for (const raw of [c.workspace, "blue.txt", '"matches"', c.admission.ticket_id, c.cmd.id, c.plan.plan_id]) expect(visible).not.toContain(raw);
    expect(visible).toContain('completeness'); expect(visible).toContain('not_assessed');
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(true);
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    expect(feedback.status).toBe("success"); expect(runner.call).toHaveBeenCalledTimes(1);
    expect(runner.history.getMessages).not.toHaveBeenCalled(); expect(runner.history.append).not.toHaveBeenCalled();
    const result = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(result.reviewed_feedback.status).toBe("success");
    expect(result.rendered_output).toContain("references_verified_interpretation_unverified");
    expect(result.rendered_output).toContain('"memory_adoption": false'); expect(result.rendered_output).not.toContain(c.workspace);
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
  }));
  it("別owner/channel・重複step・未受領・旧版をCへfallbackせず拒否する", async () => fixture(async (c) => {
    expect(reflect(c).command).toBeNull(); await recordActualObservation(c);
    const p = c.hds.getRuntimeSnapshot().operation_plans.plans[0]!;
    const content = `plan:reflect ${JSON.stringify({ plan_id: p.plan_id, revision_digest: p.revision_digest,
      step_ids: [p.steps[0]!.step_id], question: "観測を解釈" })}`;
    const outsider = createGatewayInternalInboundRequest({ ...request(content), user: "different-owner" });
    expect(c.hds.decide(outsider).command).toBeNull();
    const otherChannel = createGatewayInternalInboundRequest({ ...request(content), channel: "telegram" });
    expect(c.hds.decide(otherChannel).command).toBeNull();
    expect(c.hds.decide({ ...request(content) }).command).toBeNull(); // private brandはspreadで失われる。
    expect(reflect(c, c.hds, { step_ids: [p.steps[0]!.step_id, "search"] }).command).toBeNull();
    expect(reflect(c, c.hds, { revision_digest: "0".repeat(64) }).command).toBeNull();
  }));
  it("送信待機・返答待機中の計画改訂と再起動旧commandを拒否する", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const altered = structuredClone(command); if (altered.type === "llm_call") altered.payload.compute_context!.local_p_version = "forged";
    expect(c.hds.operationPlanCommandIsCurrent(altered)).toBe(false);
    const changed = structuredClone(c.plan); changed.steps[1]!.parameters!.max_results = 2;
    const revised = c.hds.decide(request(`plan:revise ${JSON.stringify({ plan_id: c.plan.plan_id,
      expected_revision_digest: operationPlanDigest(c.plan), plan: changed })}`)); expect(revised.command?.type).toBe("noop");
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("failed"); expect(output.rendered_output).not.toContain("検索で1件");
    c.hds.closeOperationPlanMemory(); const restarted = c.createHds();
    expect(restarted.operationPlanCommandIsCurrent(command)).toBe(false); expect(reflect(c, restarted).command).toBeNull();
  }));
  it("参照しない別M観測の追加で同じ引用射影を全失効しない", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c); const command = decision.command!;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const next = review(c.hds, c.plan, "dependent")!; const approved = await c.approve(next);
    const admission = executionAdmissionForCommand(next, c.authority.receipt(approved));
    expect(c.hds.beginOperationPlanAttempt(next, admission)).toBe(true);
    expect((await c.executor.execute(approved, { save_result_delivery: true })).status).toBe("success");
    expect(reconcileExecutionResults(c.hds, c.execution, c.admission.execution_epoch)).toEqual({ adopted: 1, deferred: 0, stale_generation_archived: 0 });
    expect(inspectMemory(c).revision).toBe(2); expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(true);
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("success"); expect(c.invoke).toHaveBeenCalledTimes(2);
  }), 15_000);
  it.each(["reference", "duplicate", "compute_request", "compute_output", "missing_compute", "tool", "meaning", "planner", "malformed_result", "failure"])("%sを成功・意味採用・作用へ変換しない", async (failure) => fixture(async (c) => {
    await recordActualObservation(c); const before = inspectMemory(c); const decision = reflect(c);
    if (!decision.command) {
      const result = c.j.load()?.plans[0]?.results.find((entry) => entry.step_id === "search");
      const now = c.currentWallClock();
      const freshness = !result ? "missing" : now < result.observed_at_ms ? "future"
        : now >= result.expires_at_ms ? "expired" : "fresh";
      throw new Error(`result reflection command was not issued for ${failure}; decision=${decision.log.commit.decision}; ` +
        `reason=${decision.log.commit.reason}; freshness=${freshness}; age_ms=${result ? now - result.observed_at_ms : "unavailable"}; ` +
        `remaining_ms=${result ? result.expires_at_ms - now : "unavailable"}`);
    }
    const command = decision.command;
    const runner = reflectionExecutor(c, (response) => {
      if (failure === "tool") return { ...response, tool_calls: [{
        schema_version: "blue-tanuki.llm-tool-call-candidate.v1",
        call_id: "x",
        tool_name: "file.search",
        arguments: {},
        authority_boundary: { candidate_only: true, may_execute: false, used_for_authority: false },
      }] };
      if (failure === "meaning") return { ...response, meaning_update_proposal: { private: true } };
      if (failure === "planner") return { ...response, content: JSON.stringify(c.plan) };
      const candidate = JSON.parse(response.content);
      if (failure === "reference") candidate.citations[0].record_digest = "0".repeat(64);
      if (failure === "duplicate") candidate.citations.push(candidate.citations[0]);
      return { ...response, content: JSON.stringify(candidate) };
    });
    const feedback = await runner.executor.execute(await c.approve(command));
    const value = feedback.result as Record<string, any>;
    if (failure === "compute_request") value.execution_identity.request_id = "other-command";
    if (failure === "compute_output") value.execution_identity.output_digest = "0".repeat(64);
    if (failure === "missing_compute") delete value.execution_identity;
      if (failure === "malformed_result") feedback.result = new Proxy({}, { ownKeys: () => { throw new Error("private provider metadata"); } });
    if (failure === "failure") { feedback.status = "failed"; feedback.error = "private-provider-error"; }
    const output = finalizeCommandOutput({ hds: c.hds, command, feedback, request_id: decision.log.request_id, target_surface: "channel" });
    expect(output.reviewed_feedback.status).toBe("failed"); expect(output.rendered_output).toContain("解釈候補を採用できません");
    expect(output.rendered_output).not.toContain("private-provider-error"); expect(output.rendered_output).not.toContain("private provider metadata");
    expect(output.output_audit.result_digest_status).toBe(failure === "malformed_result" ? "unavailable" : "recorded");
    expect(c.hds.getRuntimeSnapshot().operation_plans.plans).toHaveLength(1);
    expect(inspectMemory(c)).toEqual(before); expect(c.invoke).toHaveBeenCalledTimes(1);
  }));
  it("関連M破損・J読取不能・観測期限切れはC送信と返答を遮断する", async () => fixture(async (c) => {
    await recordActualObservation(c); const decision = reflect(c);
    if (!decision.command) throw new Error(`result reflection command was not issued; decision=${decision.log.commit.decision}; reason=${decision.log.commit.reason}`);
    const command = decision.command;
    const runner = reflectionExecutor(c); const feedback = await runner.executor.execute(await c.approve(command));
    const unreadable = vi.spyOn(c.j, "load").mockImplementation(() => { throw new Error("fixture read failure"); });
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false); unreadable.mockRestore();
    const observed = c.j.load()!.plans[0]!.results[0]!; c.advanceWallClockTo(observed.expires_at_ms);
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
    const db = new DatabaseSync(c.memory.memory_database_path);
    try { db.exec("UPDATE m_records SET value_json='{}'"); } finally { db.close(); }
    expect(c.hds.operationPlanCommandIsCurrent(command)).toBe(false);
    expect(c.hds.reviewMemoryCitations(command, feedback).status).toBe("failed"); expect(reflect(c).command).toBeNull();
  }));
});
