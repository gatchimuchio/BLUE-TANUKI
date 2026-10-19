import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** 計画経由のfile.delete直前にBrokerが観測する非権威target evidence。 */
export const FileDeleteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.file-delete-target-version.v1"),
  target_identity_digest: DigestSchema,
  file_content_digest: DigestSchema,
  file_identity_digest: DigestSchema,
  canonical_root_digest: DigestSchema,
  parent_identity_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("present"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type FileDeleteTargetVersionObservation = z.infer<typeof FileDeleteTargetVersionObservationSchema>;

export function fileDeleteTargetIdentityDigest(path: string): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-delete-target-identity.v1",
    path,
  ]), "utf8").digest("hex");
}

/** HDS・Executor・組込みadapterで共有する安定serialization。 */
export function canonicalFileDeleteTargetVersionObservation(value: unknown): string {
  const parsed = FileDeleteTargetVersionObservationSchema.parse(value);
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
  if (encoded === undefined) throw new Error("file_delete_target_version_not_canonical");
  return encoded;
}
