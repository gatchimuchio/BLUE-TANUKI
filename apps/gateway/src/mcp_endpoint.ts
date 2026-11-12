/** Canonical endpoint boundary shared by Gateway execution and owner settings. */
export function parseLoopbackMcpEndpoint(input: string | URL): URL {
  if (input.toString().length > 2048) throw new Error("mcp_endpoint_invalid");
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new Error("mcp_endpoint_invalid");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("mcp_endpoint_must_be_credentialless_loopback_streamable_http");
  }
  return url;
}
