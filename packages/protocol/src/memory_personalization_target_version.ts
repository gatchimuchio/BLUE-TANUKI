import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Exact non-authority target evidence for stopping future M personalization use. */
export const MemoryPersonalizationTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.memory-personalization-target-version.v1"),
  target_identity_digest: DigestSchema,
  entry_hash: DigestSchema,
  exclusion_revision_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("available"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type MemoryPersonalizationTargetVersionObservation =
  z.infer<typeof MemoryPersonalizationTargetVersionObservationSchema>;

export function memoryPersonalizationTargetIdentityDigest(reference: string, entry_hash: string): string {
  if (!/^F:[A-Za-z0-9_.:-]{1,96}$/.test(reference) || !/^[a-f0-9]{64}$/.test(entry_hash)) {
    throw new Error("memory_personalization_target_identity_invalid");
  }
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.memory-personalization-target-identity.v1",
    reference,
    entry_hash,
  ]), "utf8").digest("hex");
}

export function canonicalMemoryPersonalizationTargetVersionObservation(value: unknown): string {
  const parsed = MemoryPersonalizationTargetVersionObservationSchema.parse(value);
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
  if (encoded === undefined) throw new Error("memory_personalization_target_version_not_canonical");
  return encoded;
}
