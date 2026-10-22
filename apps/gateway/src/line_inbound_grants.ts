const MAX_CONFIG_LENGTH = 60_000;
const MAX_GRANTS = 256;
const MAX_IDENTIFIER_LENGTH = 512;

export type LineSourceType = "user" | "group" | "room";

/** Exact operator-maintained LINE ingress scope; it does not grant HDS authority. */
export interface LineInboundGrant {
  readonly destination: string;
  readonly source_type: LineSourceType;
  readonly source_id: string;
  readonly user_id: string;
}

/** Missing configuration means deny-all. Wildcards and role labels are not accepted. */
export function parseLineInboundGrants(value: string | undefined): readonly LineInboundGrant[] {
  if (value === undefined || value.trim() === "") return [];
  if (value.length > MAX_CONFIG_LENGTH) throw new Error("line_inbound_grants_config_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("line_inbound_grants_config_invalid_json");
  }
  if (!Array.isArray(parsed)) throw new Error("line_inbound_grants_config_invalid_shape");
  if (parsed.length > MAX_GRANTS) throw new Error("line_inbound_grants_config_too_many_entries");

  const grants: LineInboundGrant[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new Error("line_inbound_grants_config_invalid_entry");
    const keys = Object.keys(entry).sort();
    const expected = ["destination", "source_id", "source_type", "user_id"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error("line_inbound_grants_config_invalid_entry");
    }
    const { destination, source_type, source_id, user_id } = entry;
    if (!isSafeIdentifier(destination) || !isSafeIdentifier(source_id) || !isSafeIdentifier(user_id) ||
        !isSourceType(source_type) || (source_type === "user" && source_id !== user_id)) {
      throw new Error("line_inbound_grants_config_invalid_entry");
    }
    const grant: LineInboundGrant = Object.freeze({ destination, source_type, source_id, user_id });
    const key = JSON.stringify([destination, source_type, source_id, user_id]);
    if (seen.has(key)) throw new Error("line_inbound_grants_config_duplicate_entry");
    seen.add(key);
    grants.push(grant);
  }
  return Object.freeze(grants);
}

function isSourceType(value: unknown): value is LineSourceType {
  return value === "user" || value === "group" || value === "room";
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && value !== "*";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
