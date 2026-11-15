import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ModelSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)
  .refine((value) => !/^(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})$/iu.test(value),
    "credential-like values are not model identifiers");

export const SettingsWritePatchSchema = z.object({
  llm: z.object({
    model: ModelSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_048_576).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  }).strict().refine((llm) => Object.keys(llm).length > 0, "at least one supported LLM setting is required"),
}).strict();

export const SettingsWriteArgumentsSchema = z.object({
  patch: SettingsWritePatchSchema,
}).strict();

/** Non-authority target evidence for one explicitly selected Gateway settings patch. */
export const SettingsWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.settings-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  target_state_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type SettingsWritePatch = z.infer<typeof SettingsWritePatchSchema>;
export type SettingsWriteArguments = z.infer<typeof SettingsWriteArgumentsSchema>;
export type SettingsWriteTargetVersionObservation =
  z.infer<typeof SettingsWriteTargetVersionObservationSchema>;

export function settingsWriteTargetIdentityDigest(): string {
  return createHash("sha256").update("blue-tanuki.gateway-settings-target.v1", "utf8").digest("hex");
}
