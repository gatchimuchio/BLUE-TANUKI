import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const BLUE_TANUKI_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const BLUE_TANUKI_MCP_TRANSPORT = "streamable_http" as const;

const MAX_CATALOG_ITEMS = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type McpFetch = NonNullable<NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>["fetch"]>;

export interface McpCatalogEntry {
  readonly name: string;
  readonly title: string | null;
  readonly description_sha256: string | null;
  readonly source_is_untrusted: true;
  readonly used_for_authority: false;
}

export interface McpToolCatalogEntry extends McpCatalogEntry {
  readonly input_schema_sha256: string;
  readonly may_execute: false;
}

export interface McpResourceCatalogEntry extends McpCatalogEntry {
  readonly uri_sha256: string;
  readonly mime_type: string | null;
}

export interface McpResourceTemplateCatalogEntry extends McpCatalogEntry {
  readonly uri_template_sha256: string;
  readonly mime_type: string | null;
}

export interface McpPromptCatalogEntry extends McpCatalogEntry {
  readonly arguments_sha256: string;
}

/** A bounded, metadata-only projection. It never contains tool/resource/prompt payloads or authority. */
export interface McpCatalogProjection {
  readonly schema_version: "blue-tanuki.mcp-catalog-projection.v1";
  readonly protocol_version: typeof BLUE_TANUKI_MCP_PROTOCOL_VERSION;
  readonly transport: typeof BLUE_TANUKI_MCP_TRANSPORT;
  readonly server_info: { readonly name: string; readonly version: string } | null;
  readonly tools: readonly McpToolCatalogEntry[];
  readonly resources: readonly McpResourceCatalogEntry[];
  readonly resource_templates: readonly McpResourceTemplateCatalogEntry[];
  readonly prompts: readonly McpPromptCatalogEntry[];
  readonly truncated: boolean;
  readonly source_is_untrusted: true;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export interface McpCatalogInspectionOptions {
  /** The endpoint is owner-supplied. This first transport is restricted to an explicit loopback endpoint. */
  readonly endpoint: string | URL;
  /** Injected so the caller supplies the approved network boundary; no credentials are accepted or forwarded. */
  readonly fetch: McpFetch;
  readonly signal?: AbortSignal;
}

/** Connects to one MCP Streamable HTTP endpoint and reads only discovery metadata. */
export async function inspectMcpCatalog(options: McpCatalogInspectionOptions): Promise<McpCatalogProjection> {
  const endpoint = parseLoopbackEndpoint(options.endpoint);
  const client = new Client({ name: "BLUE-TANUKI", version: "1.0.0-rc.1" }, {
    versionNegotiation: { mode: { pin: BLUE_TANUKI_MCP_PROTOCOL_VERSION } },
    listMaxPages: 4,
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: scopedMcpFetch(endpoint, options.fetch, options.signal),
  });

  try {
    await client.connect(transport);
    if (client.getProtocolEra() !== "modern") throw new Error("mcp_protocol_version_mismatch");

    const [toolPage, resourcePage, resourceTemplatePage, promptPage] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    const tools = toolPage.tools ?? [];
    const resources = resourcePage.resources ?? [];
    const resourceTemplates = resourceTemplatePage.resourceTemplates ?? [];
    const prompts = promptPage.prompts ?? [];
    const serverInfo = client.getServerVersion();

    return {
      schema_version: "blue-tanuki.mcp-catalog-projection.v1",
      protocol_version: BLUE_TANUKI_MCP_PROTOCOL_VERSION,
      transport: BLUE_TANUKI_MCP_TRANSPORT,
      server_info: serverInfo?.name && serverInfo.version
        ? { name: boundedIdentifier(serverInfo.name), version: boundedIdentifier(serverInfo.version) }
        : null,
      tools: tools.slice(0, MAX_CATALOG_ITEMS).flatMap((tool) => {
        const name = safeText(tool.name, 200);
        if (!name) return [];
        return [{
          name,
          title: safeText(tool.title, 200),
          description_sha256: digestOptionalText(tool.description),
          input_schema_sha256: digestJson(tool.inputSchema),
          source_is_untrusted: true,
          used_for_authority: false,
          may_execute: false,
        }];
      }),
      resources: resources.slice(0, MAX_CATALOG_ITEMS).flatMap((resource) => {
        const name = safeText(resource.name, 200);
        if (!name) return [];
        return [{
          name,
          title: safeText(resource.title, 200),
          description_sha256: digestOptionalText(resource.description),
          uri_sha256: digestJson(resource.uri),
          mime_type: safeText(resource.mimeType, 120),
          source_is_untrusted: true,
          used_for_authority: false,
        }];
      }),
      resource_templates: resourceTemplates.slice(0, MAX_CATALOG_ITEMS).flatMap((template) => {
        const name = safeText(template.name, 200);
        if (!name) return [];
        return [{
          name,
          title: safeText(template.title, 200),
          description_sha256: digestOptionalText(template.description),
          uri_template_sha256: digestJson(template.uriTemplate),
          mime_type: safeText(template.mimeType, 120),
          source_is_untrusted: true,
          used_for_authority: false,
        }];
      }),
      prompts: prompts.slice(0, MAX_CATALOG_ITEMS).flatMap((prompt) => {
        const name = safeText(prompt.name, 200);
        if (!name) return [];
        return [{
          name,
          title: safeText(prompt.title, 200),
          description_sha256: digestOptionalText(prompt.description),
          arguments_sha256: digestJson(prompt.arguments ?? []),
          source_is_untrusted: true,
          used_for_authority: false,
        }];
      }),
      truncated: tools.length > MAX_CATALOG_ITEMS || resources.length > MAX_CATALOG_ITEMS ||
        resourceTemplates.length > MAX_CATALOG_ITEMS || prompts.length > MAX_CATALOG_ITEMS,
      source_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function parseLoopbackEndpoint(input: string | URL): URL {
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

function scopedMcpFetch(endpoint: URL, fetcher: McpFetch, signal?: AbortSignal): McpFetch {
  return async (input, init) => {
    if (input instanceof Request) throw new Error("mcp_request_shape_unsupported");
    let requestUrl: URL;
    try {
      requestUrl = new URL(input.toString());
    } catch {
      throw new Error("mcp_request_url_invalid");
    }
    if (requestUrl.origin !== endpoint.origin || requestUrl.pathname !== endpoint.pathname ||
        requestUrl.search || requestUrl.hash || !["GET", "POST"].includes((init?.method ?? "GET").toUpperCase())) {
      throw new Error("mcp_request_outside_configured_endpoint");
    }
    if (typeof init?.body === "string" && Buffer.byteLength(init.body, "utf8") > 256 * 1024) {
      throw new Error("mcp_request_body_too_large");
    }

    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
    const requestController = new AbortController();
    const signals = [signal, init?.signal, requestController.signal].filter((value): value is AbortSignal => !!value);
    const requestSignal = AbortSignal.any(signals);
    const timer = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(requestUrl, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: requestSignal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("mcp_redirect_rejected");
      }
      return await boundedResponse(response, MAX_RESPONSE_BYTES);
    } catch {
      throw new Error("mcp_transport_request_failed");
    } finally {
      clearTimeout(timer);
    }
  };
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      byteLength += item.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("mcp_response_too_large");
      }
      chunks.push(item.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("mcp_response_read_failed");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(byteLength === 0 ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function boundedIdentifier(value: string): string {
  return safeText(value, 200) ?? "unknown";
}

function digestOptionalText(value: unknown): string | null {
  return typeof value === "string" ? digestJson(value) : null;
}

function digestJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = "invalid";
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
