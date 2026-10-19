import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** 実行権限を与えない、正確なGmail送信要求の観測。 */
export const GmailWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.gmail-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  /** 観測を発行元へ結ぶ、HDS発行commandのdigest。 */
  command_digest: DigestSchema,
  /** J選択中Operation Planから発行されたcommandの場合、そのsource digest。 */
  operation_plan_binding_digest: DigestSchema.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type GmailWriteTargetVersionObservation = z.infer<typeof GmailWriteTargetVersionObservationSchema>;
