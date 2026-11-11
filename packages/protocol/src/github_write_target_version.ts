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
  start_line: z.number().int().positive().max(1_000_000).optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
  line: z.number().int().positive().max(1_000_000).optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  pull_request_head_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  pull_request_base_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  pull_request_diff_digest: DigestSchema.optional(),
}).strict();

/** Plan-bound, non-authority branch observations for a GitHub pull request create. */
export const GitHubPullRequestCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("pr.create"),
  head_repository_id: z.number().int().positive().safe(),
  head_canonical_full_name: z.string().min(3).max(201),
  head_repository_visibility: z.enum(["public", "private"]),
  repository_network_root_id: z.number().int().positive().safe(),
  head_repository_network_root_id: z.number().int().positive().safe(),
  head_repository_is_fork: z.boolean(),
  head_ref: z.string().min(1).max(255),
  head_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  base_ref: z.string().min(1).max(255),
  base_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  draft: z.boolean(),
  maintainer_can_modify: z.boolean().nullable(),
}).strict();

/** One reviewed, create-only file commit to an existing non-default branch. */
export const GitHubCodePushTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("code.push"),
  default_branch: z.string().min(1).max(255),
  branch: z.string().min(1).max(255),
  expected_head_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  path: z.string().min(1).max(4096),
}).strict();

/** A draft release bound to an existing tag and its observed commit. */
export const GitHubReleaseDraftCreateTargetVersionObservationSchema = GitHubWriteTargetVersionCommonSchema.extend({
  operation: z.literal("release.draft.create"),
  tag_name: z.string().min(1).max(255),
  tag_ref_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  tag_ref_type: z.enum(["commit", "tag"]),
  target_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  release_absent: z.literal(true),
}).strict();

export const GitHubWriteTargetVersionObservationSchema = z.discriminatedUnion("operation", [
  GitHubIssueCreateTargetVersionObservationSchema,
  GitHubIssueUpdateTargetVersionObservationSchema,
  GitHubIssueCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCreateTargetVersionObservationSchema,
  GitHubCodePushTargetVersionObservationSchema,
  GitHubReleaseDraftCreateTargetVersionObservationSchema,
]).superRefine((value, context) => {
  if (value.operation === "pr.create") {
    const sameRepository = value.head_repository_id === value.repository_id &&
      value.head_canonical_full_name.toLowerCase() === value.canonical_full_name.toLowerCase();
    if ((value.head_repository_id === value.repository_id) !==
        (value.head_canonical_full_name.toLowerCase() === value.canonical_full_name.toLowerCase()) ||
        value.repository_network_root_id !== value.head_repository_network_root_id ||
        (!sameRepository && !value.head_repository_is_fork)) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: "pull request head repository must be the base repository or a fork in the same GitHub network" });
    }
    return;
  }
  if (value.operation === "code.push") {
    const branchSegments = value.branch.split("/");
    if (value.branch === value.default_branch || value.branch !== value.branch.trim() || value.branch === "@" ||
        value.branch.startsWith("/") || value.branch.endsWith("/") || value.branch.includes("//") ||
        value.branch.includes("..") || value.branch.includes("@{") || /[\u0000-\u0020\u007f~^:?*\\\[]/.test(value.branch) ||
        value.branch.endsWith(".") || branchSegments.some((segment) => !segment || segment.startsWith(".") ||
          segment.endsWith(".") || segment.endsWith(".lock")) || value.path.startsWith("/") || value.path.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(value.path) ||
        value.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: "code push must create one safe file on an existing non-default branch" });
    }
    return;
  }
  if (value.operation !== "pr.comment.create") return;
  const inlineFields = [value.path, value.start_line, value.start_side, value.line, value.side, value.pull_request_head_sha,
    value.pull_request_base_sha, value.pull_request_diff_digest];
  if (value.comment_kind === "pull_request_review_inline") {
    const requiredInlineFields = [value.path, value.line, value.side, value.pull_request_head_sha,
      value.pull_request_base_sha, value.pull_request_diff_digest];
    if (requiredInlineFields.some((field) => field === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inline review comment target is incomplete" });
    }
    if ((value.start_line === undefined) !== (value.start_side === undefined) ||
        (value.start_line !== undefined && value.start_line === value.line && value.start_side === value.side)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inline review comment range is incomplete or empty" });
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
export type GitHubCodePushTargetVersionObservation = z.infer<typeof GitHubCodePushTargetVersionObservationSchema>;
export type GitHubReleaseDraftCreateTargetVersionObservation = z.infer<typeof GitHubReleaseDraftCreateTargetVersionObservationSchema>;

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
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}): string {
  const hasLocation = input.path !== undefined || input.start_line !== undefined || input.start_side !== undefined ||
    input.line !== undefined || input.side !== undefined;
  if (hasLocation) {
    if (typeof input.path !== "string" || input.path.length === 0 || input.path.length > 4_096 ||
        typeof input.line !== "number" || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > 1_000_000 ||
        (input.side !== "LEFT" && input.side !== "RIGHT") ||
        (input.start_line === undefined) !== (input.start_side === undefined) ||
        (input.start_line !== undefined && (!Number.isSafeInteger(input.start_line) || input.start_line < 1 ||
          (input.start_line === input.line && input.start_side === input.side) || input.start_line > 1_000_000 ||
          (input.start_side !== "LEFT" && input.start_side !== "RIGHT")))) {
      throw new Error("inline pull request review comment location is incomplete or invalid");
    }
    if (input.start_line !== undefined && input.start_side !== undefined) {
      return createHash("sha256").update(JSON.stringify([
        "blue-tanuki.github-pull-request-review-inline-range-comment-request-payload.v1",
        input.owner,
        input.repo,
        input.pull_request_number,
        input.body,
        input.path,
        input.start_line,
        input.start_side,
        input.line,
        input.side,
      ]), "utf8").digest("hex");
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
  head_repository_id?: number;
  head_canonical_full_name?: string;
  repository_network_root_id?: number;
  head_repository_network_root_id?: number;
  head_repository_is_fork?: boolean;
}): string {
  const crossRepository = input.head_repository_id !== undefined &&
    (input.head_repository_id !== input.repository_id ||
      input.head_canonical_full_name?.toLowerCase() !== input.canonical_full_name.toLowerCase());
  if (crossRepository) {
    if (input.head_repository_id === undefined || !input.head_canonical_full_name ||
        input.repository_network_root_id === undefined || input.head_repository_network_root_id === undefined ||
        input.head_repository_is_fork !== true || input.repository_network_root_id !== input.head_repository_network_root_id) {
      throw new Error("cross-repository pull request target identity is incomplete or outside one fork network");
    }
    return createHash("sha256").update(JSON.stringify([
      "blue-tanuki.github-pull-request-cross-repository-target-identity.v1",
      input.repository_id,
      input.canonical_full_name,
      input.repository_network_root_id,
      input.head_repository_id,
      input.head_canonical_full_name,
      input.head_repository_network_root_id,
      input.head_repository_is_fork,
      input.head_ref,
      input.base_ref,
    ]), "utf8").digest("hex");
  }
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
  head_repository?: string;
  draft: boolean;
  maintainer_can_modify?: boolean;
}): string {
  const sameRepository = !input.head_repository ||
    input.head_repository.toLowerCase() === `${input.owner}/${input.repo}`.toLowerCase();
  if (!sameRepository) {
    return createHash("sha256").update(JSON.stringify([
      "blue-tanuki.github-pull-request-cross-repository-create-request-payload.v1",
      input.owner,
      input.repo,
      input.title,
      input.body ?? null,
      input.head_repository,
      input.head_ref,
      input.base_ref,
      input.draft,
      input.maintainer_can_modify ?? null,
    ]), "utf8").digest("hex");
  }
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

export function githubCodePushTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  default_branch: string;
  branch: string;
  expected_head_sha: string;
  path: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-code-push-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.default_branch,
    input.branch,
    input.expected_head_sha,
    input.path,
  ]), "utf8").digest("hex");
}

export function githubCodePushRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  branch: string;
  expected_head_sha: string;
  path: string;
  content: string;
  commit_message: string;
}): string {
  const contentDigest = createHash("sha256").update(input.content, "utf8").digest("hex");
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-code-push-request-payload.v1",
    input.owner,
    input.repo,
    input.branch,
    input.expected_head_sha,
    input.path,
    contentDigest,
    input.commit_message,
  ]), "utf8").digest("hex");
}

export function githubReleaseDraftCreateTargetIdentityDigest(input: {
  repository_id: number;
  canonical_full_name: string;
  tag_name: string;
  tag_ref_sha: string;
  tag_ref_type: "commit" | "tag";
  target_commit_sha: string;
}): string {
  if (!Number.isSafeInteger(input.repository_id) || input.repository_id <= 0 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.tag_ref_sha) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.target_commit_sha) ||
      !isSafeGitHubRef(input.tag_name)) {
    throw new Error("invalid GitHub draft release target identity");
  }
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-release-draft-create-target-identity.v1",
    input.repository_id,
    input.canonical_full_name,
    input.tag_name,
    input.tag_ref_sha,
    input.tag_ref_type,
    input.target_commit_sha,
    true,
  ]), "utf8").digest("hex");
}

export function githubReleaseDraftCreateRequestPayloadDigest(input: {
  owner: string;
  repo: string;
  tag_name: string;
  target_commit_sha: string;
  name: string;
  body?: string;
}): string {
  if (!isSafeGitHubRef(input.tag_name) || !input.name || input.name.length > 256 ||
      input.name !== input.name.trim() || /[\u0000-\u001f\u007f]/.test(input.name) ||
      (input.body !== undefined && (input.body.length > 500_000 || input.body.includes("\u0000") ||
        Buffer.from(input.body, "utf8").toString("utf8") !== input.body)) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.target_commit_sha)) {
    throw new Error("invalid GitHub draft release request");
  }
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.github-release-draft-create-request-payload.v1",
    input.owner,
    input.repo,
    input.tag_name,
    input.target_commit_sha,
    input.name,
    input.body ?? null,
    true,
    false,
    false,
  ]), "utf8").digest("hex");
}

function isSafeGitHubRef(value: string): boolean {
  const segments = value.split("/");
  return value.length > 0 && value.length <= 255 && value === value.trim() && value !== "@" &&
    !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes("..") &&
    !value.includes("@{") && !/[\u0000-\u0020\u007f~^:?*\\\[]/.test(value) && !value.endsWith(".") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." &&
      !segment.startsWith(".") && !segment.endsWith(".") && !segment.endsWith(".lock"));
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
