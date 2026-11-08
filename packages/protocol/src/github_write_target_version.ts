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

export const GitHubWriteTargetVersionObservationSchema = z.discriminatedUnion("operation", [
  GitHubIssueCreateTargetVersionObservationSchema,
  GitHubIssueUpdateTargetVersionObservationSchema,
  GitHubIssueCommentCreateTargetVersionObservationSchema,
]);

export type GitHubWriteTargetVersionObservation = z.infer<typeof GitHubWriteTargetVersionObservationSchema>;
export type GitHubIssueCreateTargetVersionObservation = z.infer<typeof GitHubIssueCreateTargetVersionObservationSchema>;
export type GitHubIssueUpdateTargetVersionObservation = z.infer<typeof GitHubIssueUpdateTargetVersionObservationSchema>;
export type GitHubIssueCommentCreateTargetVersionObservation = z.infer<typeof GitHubIssueCommentCreateTargetVersionObservationSchema>;

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
