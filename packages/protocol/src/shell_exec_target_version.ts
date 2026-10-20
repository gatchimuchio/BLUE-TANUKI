import { z } from "zod";

/** Broker observation binding an approved shell command to the exact sandbox root and cwd. */
export const ShellExecTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.shell-exec-target-version.v1"),
  command_digest: z.string().regex(/^[a-f0-9]{64}$/),
  root_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  cwd_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  operation_plan_binding_digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type ShellExecTargetVersionObservation = z.infer<typeof ShellExecTargetVersionObservationSchema>;
