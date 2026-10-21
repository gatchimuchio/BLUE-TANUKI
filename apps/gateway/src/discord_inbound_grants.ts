const MAX_CONFIG_LENGTH = 30_000;
const MAX_GRANTS = 256;
const UINT64_MAX = 18_446_744_073_709_551_615n;

/** Structural preview-channel contract; keep the optional adapter out of Gateway dependencies. */
export interface DiscordInboundGrant {
  readonly guild_id: string | null;
  readonly channel_id: string;
  readonly user_id: string;
}

/** Parse exact owner-maintained Discord admission entries; missing means deny-all. */
export function parseDiscordInboundGrants(value: string | undefined): readonly DiscordInboundGrant[] {
  if (value === undefined || value.trim() === "") return [];
  if (value.length > MAX_CONFIG_LENGTH) throw new Error("discord_inbound_grants_config_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("discord_inbound_grants_config_invalid_json");
  }
  if (!Array.isArray(parsed)) throw new Error("discord_inbound_grants_config_invalid_shape");
  if (parsed.length > MAX_GRANTS) throw new Error("discord_inbound_grants_config_too_many_entries");

  const grants: DiscordInboundGrant[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new Error("discord_inbound_grants_config_invalid_entry");
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== "channel_id" || keys[1] !== "guild_id" || keys[2] !== "user_id") {
      throw new Error("discord_inbound_grants_config_invalid_entry");
    }
    const { guild_id, channel_id, user_id } = entry;
    if (!(guild_id === null || isDiscordSnowflake(guild_id)) ||
        !isDiscordSnowflake(channel_id) || !isDiscordSnowflake(user_id)) {
      throw new Error("discord_inbound_grants_config_invalid_entry");
    }

    const grant: DiscordInboundGrant = { guild_id, channel_id, user_id };
    const key = JSON.stringify([guild_id, channel_id, user_id]);
    if (seen.has(key)) throw new Error("discord_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push(grant);
  }
  return Object.freeze(grants.map((grant) => Object.freeze(grant)));
}

function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/u.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
