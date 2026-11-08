import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const GitHubWriteTargetVersionCommonSchema = z.object({
  schema_version: z.literal("blue-tanuki.github-write-target-version.v1"),
  repository_id: z.number().int().positive().safe(),
  requested_owner: z.string().min(1).max(100),
  requested_repo: z.string().min(1).max(100),
  canonical_full_name: z.string().min(3).max(201),
  repository_visibility: z.enum(["public", "private"]),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  provider_observation_is_atomic: z.literal(false),
  provider_data_is_untrusted: z.literal(true),
  mutation_sent: z.literal(false),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
});

/** Plan-bound, non-authority target evidence for connected GitHub issue writes. */
export const GitHubIssueCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("issue.create"),
}).strict();

export const GitHubIssueUpdateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("issue.update"),
  issue_id: z.number().int().positive().safe(),
  issue_number: z.number().int().positive().max(1_000_000),
  issue_state: z.enum(["open", "closed"]),
  issue_locked: z.boolean(),
  issue_updated_at: z.string().datetime({ offset: true }),
  issue_title: z.string().min(1).max(65_536),
  issue_body: z.string().max(500_000).nullable(),
}).strict();

export const GitHubIssueCommentCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("issue.comment.create"),
  issue_id: z.number().int().positive().safe(),
  issue_number: z.number().int().positive().max(1_000_000),
  issue_state: z.enum(["open", "closed"]),
  issue_locked: z.boolean(),
  issue_updated_at: z.string().datetime({ offset: true }),
}).strict();

/** Plan-bound, non-authority target evidence for a regular pull request timeline comment. */
export const GitHubPullRequestCommentCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("pr.comment.create"),
  pull_request_id: z.number().int().positive().safe(),
  pull_request_number: z.number().int().positive().max(1_000_000),
  pull_request_state: z.enum(["open", "closed"]),
  pull_request_locked: z.boolean(),
  pull_request_updated_at: z.string().datetime({ offset: true }),
  comment_kind: z.literal("pull_request_review_inline").optional(),
  path: z.string().min(1).max(4_096).optional(),
  line: z.number().int().positive().max(1_000_000).optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  pull_request_head_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  pull_request_base_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  pull_request_diff_digest: DigestSchema.optional(),
}).strict();

/** Plan-bound, non-authority branch observations for a GitHub pull request create. */
export const GitHubPullRequestCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("pr.create"),
  head_ref: z.string().min(1).max(255),
  head_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  base_ref: z.string().min(1).max(255),
  base_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  draft: z.boolean(),
  maintainer_can_modify: z.boolean().nullable(),
}).strict();

export const GitHubWriteTargetVersionObservationSchema = z.discriminatedUnion("operation", [
  GitHubIssueCreateTargetVersionObservationSchema,
  GitHubIssueUpdateTargetVersionObservationSchema,
  GitHubIssueCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCreateTargetVersionObservationSchema,
]).superRefine((value, context) => {
  if (value.operation !== "pr.comment.create") return;
  const inlineFields = [value.path, value.line, value.side, value.pull_request_head_sha,
    value.pull_request_base_sha, value.pull_request_diff_digest];
  if (value.comment_kind === "pull_request_review_inline") {
    if (inlineFields.some((field) => field === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inline review comment target is incomplete" });
    }
  } else if (inlineFields.some((field) => field !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "timeline comment target cannot contain inline review fields" });
  }
});

export type GitHubWriteTargetVersionObservation = z.infer<typeof GitHubWriteTargetVersionObservationSchema>;
export type GitHubIssueCreateTargetVersionObservation = z.infer<typeof GitHubIssueCreateTargetVersionObservationSchema>;
export type GitHubIssueUpdateTargetVersionObservation = z.infer<typeof GitHubIssueUpdateTargetVersionObservationSchema>;
export type GitHubIssueCommentCreateTargetVersionObservation = z.infer<typeof GitHubIssueCommentCreateTargetVersionObservationSchema>;
export type GitHubPullRequestCommentCreateTargetVersionObservation = z.infer<typeof GitHubPullRequestCommentCreateTargetVersionObservationSchema>;
export type GitHubPullRequestCreateTargetVersionObservation = z.infer<typeof GitHubPullRequestCreateTargetVersionObservationSchema>;

export function githubIssueCreateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-create-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
  ]), "utf8").digest("hex");
}

export function githubIssueCreateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  title: string;
  body?: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-create-request-payload.v1",
    input.owner,
    input.repo,
    input.title,
    input.body ?? null,
  ]), "utf8").digest("hex");
}

export function githubIssueUpdateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  issue_id: number;
  issue_number: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-update-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.issue_id,
    input.issue_number,
  ]), "utf8").digest("hex");
}

export function githubIssueUpdateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  issue_number: number;
  title?: string;
  body?: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-update-request-payload.v1",
    input.owner,
    input.repo,
    input.issue_number,
    input.title ?? null,
    input.body ?? null,
  ]), "utf8").digest("hex");
}

export function githubIssueCommentCreateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  issue_id: number;
  issue_number: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-comment-create-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.issue_id,
    input.issue_number,
  ]), "utf8").digest("hex");
}

export function githubIssueCommentCreateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-issue-comment-create-request-payload.v1",
    input.owner,
    input.repo,
    input.issue_number,
    input.body,
  ]), "utf8").digest("hex");
}

export function githubPullRequestCommentCreateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  pull_request_id: number;
  pull_request_number: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-pull-request-comment-create-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.pull_request_id,
    input.pull_request_number,
  ]), "utf8").digest("hex");
}

export function githubPullRequestCommentCreateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  pull_request_number: number;
  body: string;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
}): string {
  const hasLocation = input.path !== undefined || input.line !== undefined || input.side !== undefined;
  if (hasLocation) {
    if (typeof input.path !== "string" || input.path.length === 0 || input.path.length > 4_096 ||
        typeof input.line !== "number" || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > 1_000_000 ||
        (input.side !== "LEFT" && input.side !== "RIGHT")) {
      throw new Error("inline pull request review comment location is incomplete or invalid");
    }
    return createHash("sha256").update(JSON.stringify([
      "blue-tanuki.github-pull-request-review-inline-comment-request-payload.v1",
      input.owner,
      input.repo,
      input.pull_request_number,
      input.body,
      input.path,
      input.line,
      input.side,
    ]), "utf8").digest("hex");
  }
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-pull-request-comment-create-request-payload.v1",
    input.owner,
    input.repo,
    input.pull_request_number,
    input.body,
  ]), "utf8").digest("hex");
}

export function githubPullRequestCreateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  head_ref: string;
  base_ref: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-pull-request-create-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.head_ref,
    input.base_ref,
  ]), "utf8").digest("hex");
}

export function githubPullRequestCreateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head_ref: string;
  base_ref: string;
  draft: boolean;
  maintainer_can_modify?: boolean;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-pull-request-create-request-payload.v1",
    input.owner,
    input.repo,
    input.title,
    input.body ?? null,
    input.head_ref,
    input.base_ref,
    input.draft,
    input.maintainer_can_modify ?? null,
  ]), "utf8").digest("hex");
}

/** Stable serialization used by HDS, Executor and the registered GitHub adapter. */
export function canonicalGitHubWriteTargetVersionObservation(value: unknown): string {
  const parsed = GitHubWriteTargetVersionObservationSchema.parse(value);
  return canonicalJson(parsed);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("github_write_target_version_not_canonical");
  return encoded;
}
