import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Broker observation for the exact bounded file.search snapshot that the
 * adapter will read. It is provenance evidence only and never grants access.
 */
export const FileSearchTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.file-search-target-version.v1"),
  requested_root_digest: DigestSchema,
  /** Present for an exact single-file search; binds the approved command to that relative path. */
  requested_path_digest: DigestSchema.optional(),
  canonical_root_digest: DigestSchema,
  resource_version_digest: DigestSchema,
  /** Non-authority binding to the exact J-selected Operation Plan source, when present. */
  operation_plan_binding_digest: DigestSchema.optional(),
  files_examined: z.number().int().min(0).max(1_000),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type FileSearchTargetVersionObservation = z.infer<typeof FileSearchTargetVersionObservationSchema>;

/** Stable serialization shared by the HDS seal, Executor ticket, and Broker worker. */
export function canonicalFileSearchTargetVersionObservation(value: unknown): string {
  const parsed = FileSearchTargetVersionObservationSchema.parse(value);
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
  if (encoded === undefined) throw new Error("file_search_target_version_not_canonical");
  return encoded;
}
