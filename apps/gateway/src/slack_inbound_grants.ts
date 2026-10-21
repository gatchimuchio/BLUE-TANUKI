interface SlackInboundGrant {
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly thread_ts: string | null;
}

const MAX_CONFIG_LENGTH = 30_000;
const MAX_GRANTS = 256;
const SLACK_ID = /^[A-Z][A-Z0-9]{1,31}$/u;
const SLACK_TIMESTAMP = /^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u;

/** Parse exact owner-maintained Slack admission entries; missing means deny-all. */
export function parseSlackInboundGrants(value: string | undefined): readonly SlackInboundGrant[] {
  if (value === undefined || value.trim() === "") return [];
  if (value.length > MAX_CONFIG_LENGTH) throw new Error("slack_inbound_grants_config_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("slack_inbound_grants_config_invalid_json");
  }
  if (!Array.isArray(parsed)) throw new Error("slack_inbound_grants_config_invalid_shape");
  if (parsed.length > MAX_GRANTS) throw new Error("slack_inbound_grants_config_too_many_entries");

  const grants: SlackInboundGrant[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new Error("slack_inbound_grants_config_invalid_entry");
    const keys = Object.keys(entry).sort();
    if (keys.length !== 4 || keys[0] !== "channel_id" || keys[1] !== "team_id" ||
        keys[2] !== "thread_ts" || keys[3] !== "user_id") {
      throw new Error("slack_inbound_grants_config_invalid_entry");
    }
    const { team_id, channel_id, user_id, thread_ts } = entry;
    if (typeof team_id !== "string" || !SLACK_ID.test(team_id) || !team_id.startsWith("T") ||
        typeof channel_id !== "string" || !SLACK_ID.test(channel_id) || !/^[CDG]/u.test(channel_id) ||
        typeof user_id !== "string" || !SLACK_ID.test(user_id) || !/^[UW]/u.test(user_id) ||
        !(thread_ts === null || (typeof thread_ts === "string" && SLACK_TIMESTAMP.test(thread_ts)))) {
      throw new Error("slack_inbound_grants_config_invalid_entry");
    }

    const grant: SlackInboundGrant = { team_id, channel_id, user_id, thread_ts };
    const key = JSON.stringify([team_id, channel_id, user_id, thread_ts]);
    if (seen.has(key)) throw new Error("slack_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push(grant);
  }
  return Object.freeze(grants.map((grant) => Object.freeze(grant)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
