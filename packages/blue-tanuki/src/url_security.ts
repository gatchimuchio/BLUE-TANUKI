const CREDENTIAL_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "accesskey",
  "token",
  "accesstoken",
  "auth",
  "authorization",
  "bearer",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "signature",
  "sig",
]);

/** Detect common credential-bearing query parameter names without exposing values. */
export function hasCredentialQueryParameter(url: URL): boolean {
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (
      CREDENTIAL_QUERY_KEYS.has(normalized) ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("accesstoken") ||
      normalized.endsWith("clientsecret")
    ) {
      return true;
    }
  }
  return false;
}
