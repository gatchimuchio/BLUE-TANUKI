import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EMAIL_ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** GmailのTo/Cc/Bcc/Reply-Toで共有する、表示名なし・上限付き宛先列の正規形。 */
export function normalizeGmailAddressList(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_048) return undefined;
  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.length > 20 || addresses.some((address) => address.length === 0 || address.length > 320 ||
      !EMAIL_ADDRESS_PATTERN.test(address))) return undefined;
  return addresses.join(", ");
}

/** 実行権限を与えないGmail書込み要求のtarget・payload・provider状態観測。 */
export const GmailWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.gmail-write-target-version.v1"),
  target_identity_digest: DigestSchema,
  /** draft.sendではdraft ID + provider_raw_digestから再計算できるrequest intent digest。 */
  request_payload_digest: DigestSchema,
  /** draft.sendでは表示・送信対象にした既存resource状態のdigest。 */
  provider_state_digest: DigestSchema.optional(),
  /** draft.sendで同一性照合するMIME raw bytesのdigest。本文そのものは保持しない。 */
  provider_raw_digest: DigestSchema.optional(),
  /** 観測を発行元へ結ぶ、HDS発行commandのdigest。 */
  command_digest: DigestSchema,
  /** J選択中Operation Planから発行されたcommandの場合、そのsource digest。 */
  operation_plan_binding_digest: DigestSchema.optional(),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type GmailWriteTargetVersionObservation = z.infer<typeof GmailWriteTargetVersionObservationSchema>;
