import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** 計画経由のfile.write create-onlyに対する非権威Broker観測。 */
const FileWritePlannedCreateTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.file-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  payload_digest: DigestSchema,
  canonical_root_digest: DigestSchema,
  parent_identity_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("absent"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

const FileWriteMutationTargetVersionBase = {
  schema_version: z.literal("blue-tanuki.file-write-target-version.v2"),
  target_identity_digest: DigestSchema,
  payload_digest: DigestSchema,
  mode: z.enum(["create", "overwrite", "append"]),
  canonical_root_digest: DigestSchema,
  parent_identity_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
};

/** 直接file.writeを要求データと対象版のdigestだけへ結び、本文を返さない。 */
export const FileWriteMutationTargetVersionObservationSchema = z.discriminatedUnion("target_state", [
  z.object({
    ...FileWriteMutationTargetVersionBase,
    target_state: z.literal("absent"),
  }).strict(),
  z.object({
    ...FileWriteMutationTargetVersionBase,
    mode: z.enum(["overwrite", "append"]),
    target_state: z.literal("present"),
    file_identity_digest: DigestSchema,
    target_content_digest: DigestSchema,
  }).strict(),
]);

export const FileWriteTargetVersionObservationSchema = z.union([
  FileWritePlannedCreateTargetVersionObservationSchema,
  FileWriteMutationTargetVersionObservationSchema,
]);

export type FileWriteTargetVersionObservation = z.infer<typeof FileWriteTargetVersionObservationSchema>;

export function fileWriteTargetIdentityDigest(path: string): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-write-target-identity.v1",
    path,
  ]), "utf8").digest("hex");
}

export function fileWritePayloadDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** HDS・Executor・組込みadapterで共有する安定serialization。 */
export function canonicalFileWriteTargetVersionObservation(value: unknown): string {
  const parsed = FileWriteTargetVersionObservationSchema.parse(value);
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
  if (encoded === undefined) throw new Error("file_write_target_version_not_canonical");
  return encoded;
}
