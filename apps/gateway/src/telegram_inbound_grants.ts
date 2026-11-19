import { TelegramInboundGrantSchema, type TelegramInboundGrant } from "@blue-tanuki/protocol";

const MAX_CONFIG_LENGTH = 30_000;
const MAX_GRANTS = 256;

/**
 * Parse the owner-maintained Telegram inbound admission list without echoing
 * its contents into errors or logs. Missing and empty configuration is deny-all.
 */
export function parseTelegramInboundGrants(value: string | undefined): readonly TelegramInboundGrant[] {
  if (value === undefined || value.trim() === "") return [];
  if (value.length > MAX_CONFIG_LENGTH) throw new Error("telegram_inbound_grants_config_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("telegram_inbound_grants_config_invalid_json");
  }
  if (!Array.isArray(parsed)) throw new Error("telegram_inbound_grants_config_invalid_shape");
  if (parsed.length > MAX_GRANTS) throw new Error("telegram_inbound_grants_config_too_many_entries");

  const grants: TelegramInboundGrant[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const grant = TelegramInboundGrantSchema.safeParse(entry);
    if (!grant.success) throw new Error("telegram_inbound_grants_config_invalid_entry");
    const { user_id, chat_id, message_thread_id } = grant.data;
    const key = `${user_id}\u0000${chat_id}\u0000${message_thread_id ?? ""}`;
    if (seen.has(key)) throw new Error("telegram_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push(grant.data);
  }
  return Object.freeze(grants.map((grant) => Object.freeze(grant)));
}
