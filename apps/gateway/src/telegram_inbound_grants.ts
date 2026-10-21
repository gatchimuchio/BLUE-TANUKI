import type { TelegramInboundGrant } from "@blue-tanuki/channel-telegram";

const MAX_CONFIG_LENGTH = 30_000;
const MAX_GRANTS = 256;
const MAX_TELEGRAM_ID = BigInt(Number.MAX_SAFE_INTEGER);

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
    if (!isRecord(entry)) throw new Error("telegram_inbound_grants_config_invalid_entry");
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== "chat_id" || keys[1] !== "message_thread_id" || keys[2] !== "user_id") {
      throw new Error("telegram_inbound_grants_config_invalid_entry");
    }
    const userId = entry.user_id;
    const chatId = entry.chat_id;
    const threadId = entry.message_thread_id;
    if (typeof userId !== "string" || !isCanonicalTelegramId(userId, false) ||
        typeof chatId !== "string" || !isCanonicalTelegramId(chatId, true) ||
        !(threadId === null || (typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0))) {
      throw new Error("telegram_inbound_grants_config_invalid_entry");
    }

    const key = `${userId}\u0000${chatId}\u0000${threadId ?? ""}`;
    if (seen.has(key)) throw new Error("telegram_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push({ user_id: userId, chat_id: chatId, message_thread_id: threadId });
  }
  return Object.freeze(grants.map((grant) => Object.freeze(grant)));
}

function isCanonicalTelegramId(value: string, allowNegative: boolean): boolean {
  if (!(allowNegative ? /^-?[1-9][0-9]{0,15}$/u : /^[1-9][0-9]{0,15}$/u).test(value)) return false;
  const absolute = value.startsWith("-") ? value.slice(1) : value;
  return BigInt(absolute) <= MAX_TELEGRAM_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
