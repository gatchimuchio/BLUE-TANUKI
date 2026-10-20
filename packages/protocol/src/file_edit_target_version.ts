import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** 計画経由のfile.editに対し、変更前の実ファイル版と編集内容をdigestだけで観測する。 */
export const FileEditTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.file-edit-target-version.v1"),
  target_identity_digest: DigestSchema,
  before_content_digest: DigestSchema,
  after_content_digest: DigestSchema,
  file_identity_digest: DigestSchema,
  canonical_root_digest: DigestSchema,
  parent_identity_digest: DigestSchema,
  edit_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  replacement_count: z.number().int().positive().max(100),
  target_state: z.literal("present"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type FileEditTargetVersionObservation = z.infer<typeof FileEditTargetVersionObservationSchema>;

export function fileEditTargetIdentityDigest(path: string): string {
  return createHash("sha256").update(JSON.stringify(["blue-tanuki.file-edit-target-identity.v1", path]), "utf8").digest("hex");
}

export function fileEditPayloadDigest(input: {
  search: string;
  replace: string;
  expected_replacements: number;
  max_bytes: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-edit-payload.v1", input.search, input.replace, input.expected_replacements, input.max_bytes,
  ]), "utf8").digest("hex");
}

/** HDS・Executor・組込みadapterで共有する安定serialization。 */
export function canonicalFileEditTargetVersionObservation(value: unknown): string {
  const parsed = FileEditTargetVersionObservationSchema.parse(value);
  return canonicalJson(parsed);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("file_edit_target_version_not_canonical");
  return encoded;
}
