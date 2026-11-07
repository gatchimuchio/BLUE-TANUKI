import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Plan-bound, non-authority repository evidence for the first GitHub write vertical slice. */
export const GitHubWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.github-write-target-version.v1"),
  operation: z.literal("issue.create"),
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
}).strict();

export type GitHubWriteTargetVersionObservation = z.infer<typeof GitHubWriteTargetVersionObservationSchema>;

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
