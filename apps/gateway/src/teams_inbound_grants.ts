const MAX_CONFIG_LENGTH = 60_000;
const MAX_GRANTS = 256;
const MAX_IDENTIFIER_LENGTH = 512;

export type TeamsConversationType = "personal" | "groupChat" | "channel";

/** Exact owner-maintained Microsoft Teams admission scope. */
export interface TeamsInboundGrant {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly conversation_type: TeamsConversationType;
  readonly user_id: string;
  readonly team_id: string | null;
  readonly channel_id: string | null;
}

/** Missing configuration means deny-all. Values are identities, never HDS permission. */
export function parseTeamsInboundGrants(value: string | undefined): readonly TeamsInboundGrant[] {
  if (value === undefined || value.trim() === "") return [];
  if (value.length > MAX_CONFIG_LENGTH) throw new Error("teams_inbound_grants_config_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("teams_inbound_grants_config_invalid_json");
  }
  if (!Array.isArray(parsed)) throw new Error("teams_inbound_grants_config_invalid_shape");
  if (parsed.length > MAX_GRANTS) throw new Error("teams_inbound_grants_config_too_many_entries");

  const grants: TeamsInboundGrant[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new Error("teams_inbound_grants_config_invalid_entry");
    const keys = Object.keys(entry).sort();
    const expected = ["channel_id", "conversation_id", "conversation_type", "team_id", "tenant_id", "user_id"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error("teams_inbound_grants_config_invalid_entry");
    }

    const { tenant_id, conversation_id, conversation_type, user_id, team_id, channel_id } = entry;
    if (!isTenantId(tenant_id) || !isSafeIdentifier(conversation_id) || !isSafeIdentifier(user_id) ||
        !isConversationType(conversation_type) ||
        !(team_id === null || isSafeIdentifier(team_id)) ||
        !(channel_id === null || isSafeIdentifier(channel_id))) {
      throw new Error("teams_inbound_grants_config_invalid_entry");
    }
    if (conversation_type === "channel"
      ? team_id === null || channel_id === null
      : team_id !== null || channel_id !== null) {
      throw new Error("teams_inbound_grants_config_invalid_entry");
    }

    const grant: TeamsInboundGrant = {
      tenant_id: tenant_id.toLowerCase(),
      conversation_id,
      conversation_type,
      user_id,
      team_id,
      channel_id,
    };
    const key = JSON.stringify([
      grant.tenant_id,
      grant.conversation_type,
      grant.conversation_id,
      grant.user_id,
      grant.team_id,
      grant.channel_id,
    ]);
    if (seen.has(key)) throw new Error("teams_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push(Object.freeze(grant));
  }
  return Object.freeze(grants);
}

function isConversationType(value: unknown): value is TeamsConversationType {
  return value === "personal" || value === "groupChat" || value === "channel";
}

function isTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
