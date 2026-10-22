export interface TeamsAgentCredentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly tenant_id: string;
}

/** Partial configuration is an error; absence of all three values keeps ingress disabled. */
export function teamsAgentCredentialsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TeamsAgentCredentials | null {
  const clientId = env.TEAMS_AGENT_CLIENT_ID;
  const clientSecret = env.TEAMS_AGENT_CLIENT_SECRET;
  const tenantId = env.TEAMS_AGENT_TENANT_ID;
  const values = [clientId, clientSecret, tenantId];
  if (values.every((value) => value === undefined || value.trim() === "")) return null;
  if (values.some((value) => value === undefined || value.trim() === "")) {
    throw new Error("teams_agent_auth_configuration_incomplete");
  }
  if (!isUuid(clientId) || !isUuid(tenantId) || clientSecret!.length > 4096 || /[\r\n]/u.test(clientSecret!)) {
    throw new Error("teams_agent_auth_configuration_invalid");
  }
  return Object.freeze({
    client_id: clientId,
    client_secret: clientSecret!,
    tenant_id: tenantId,
  });
}

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}
