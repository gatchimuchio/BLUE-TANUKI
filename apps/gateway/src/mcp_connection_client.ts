import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool, ToolRegistry } from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { MCP_CALL_POTENTIAL_EFFECTS, OperationJsonValueSchema, OperationPlanSchema,
  McpCallTargetVersionObservationSchema, requireToolOperationDescriptor,
  type OperationPlan, type McpCallTargetVersionObservation } from "@blue-tanuki/protocol";
import { parseLoopbackMcpEndpoint } from "./mcp_endpoint.js";
import { mcpRuntimeObservationStore, type McpRuntimeObservationStore } from "./mcp_connection_observation.js";

export const BLUE_TANUKI_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const BLUE_TANUKI_MCP_TRANSPORT = "streamable_http" as const;

const MAX_CATALOG_ITEMS = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSAL_ARGUMENT_BYTES = 64 * 1024;
// Keep transport requests bounded below the Executor's 10-second operation timeout,
// so a disconnected loopback server returns a classified pre-dispatch failure first.
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

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
  /** Digest of the configured endpoint; the endpoint itself is never returned. */
  readonly connection_digest: string;
  /** Digest of the bounded catalog projection and connection digest. */
  readonly catalog_digest: string;
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
  const endpoint = parseLoopbackMcpEndpoint(options.endpoint);
  const client = await connectMcpClient(endpoint, options.fetch, options.signal);
  try {
    return await projectMcpCatalog(client, endpoint);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Owner-triggered Settings preflight for a credentialless loopback endpoint. */
export function inspectMcpCatalogFromSettings(
  endpoint: string | URL,
  signal?: AbortSignal,
): Promise<McpCatalogProjection> {
  return inspectMcpCatalog({
    endpoint,
    fetch: globalThis.fetch.bind(globalThis) as McpFetch,
    ...(signal ? { signal } : {}),
  });
}

async function connectMcpClient(endpoint: URL, fetcher: McpFetch, signal?: AbortSignal): Promise<Client> {
  const client = new Client({ name: "BLUE-TANUKI", version: "1.0.0-rc.1" }, {
    versionNegotiation: { mode: { pin: BLUE_TANUKI_MCP_PROTOCOL_VERSION } },
    listMaxPages: 4,
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: scopedMcpFetch(endpoint, fetcher, signal),
  });
  try {
    await client.connect(transport);
    if (client.getProtocolEra() !== "modern") throw new Error("mcp_protocol_version_mismatch");
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function projectMcpCatalog(client: Client, endpoint: URL): Promise<McpCatalogProjection> {
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
  const projection = {
    schema_version: "blue-tanuki.mcp-catalog-projection.v1",
    protocol_version: BLUE_TANUKI_MCP_PROTOCOL_VERSION,
    transport: BLUE_TANUKI_MCP_TRANSPORT,
    connection_digest: digestJson({ endpoint: endpoint.href }),
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
        source_is_untrusted: true as const,
        used_for_authority: false as const,
        may_execute: false as const,
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
        source_is_untrusted: true as const,
        used_for_authority: false as const,
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
        source_is_untrusted: true as const,
        used_for_authority: false as const,
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
        source_is_untrusted: true as const,
        used_for_authority: false as const,
      }];
    }),
    truncated: tools.length > MAX_CATALOG_ITEMS || resources.length > MAX_CATALOG_ITEMS ||
      resourceTemplates.length > MAX_CATALOG_ITEMS || prompts.length > MAX_CATALOG_ITEMS,
    source_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  } as const;
  return { ...projection, catalog_digest: digestJson(projection) };
}

export type McpToolCallProfile = "adapter-fixture" | "native-live";

export interface McpToolCallProposalInput {
  readonly plan_id: string;
  readonly request_id: string;
  readonly step_id: string;
  readonly catalog: McpCatalogProjection;
  readonly tool_name: string;
  readonly arguments: unknown;
  readonly profile?: McpToolCallProfile;
}

export interface McpToolCallProposal {
  readonly profile: McpToolCallProfile;
  readonly plan: OperationPlan;
  readonly connection_digest: string;
  readonly catalog_digest: string;
  readonly tool_name: string;
  readonly input_schema_sha256: string;
  readonly arguments_sha256: string;
  readonly source_is_untrusted: true;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

/**
 * Creates a digest-bound MCP OperationPlan candidate. The default fixture profile
 * remains non-executable; native-live becomes selectable only through HDS-J and
 * still requires a separate L3 review and fresh server observation.
 */
export function createMcpToolCallProposal(input: McpToolCallProposalInput): McpToolCallProposal {
  const { catalog } = input;
  const profile = input.profile ?? "adapter-fixture";
  if (profile !== "adapter-fixture" && profile !== "native-live") throw new Error("mcp_profile_invalid");
  if (catalog.schema_version !== "blue-tanuki.mcp-catalog-projection.v1" ||
      catalog.protocol_version !== BLUE_TANUKI_MCP_PROTOCOL_VERSION ||
      catalog.transport !== BLUE_TANUKI_MCP_TRANSPORT || catalog.source_is_untrusted !== true ||
      catalog.used_for_authority !== false || catalog.may_execute !== false ||
      !/^[a-f0-9]{64}$/u.test(catalog.connection_digest) || !/^[a-f0-9]{64}$/u.test(catalog.catalog_digest)) {
    throw new Error("mcp_catalog_projection_invalid");
  }
  const { catalog_digest: _digest, ...catalogWithoutDigest } = catalog;
  if (digestJson(catalogWithoutDigest) !== catalog.catalog_digest) throw new Error("mcp_catalog_projection_changed");

  const matches = catalog.tools.filter((tool) => tool.name === input.tool_name);
  if (matches.length !== 1 || matches[0]?.source_is_untrusted !== true ||
      matches[0].used_for_authority !== false || matches[0].may_execute !== false ||
      !/^[a-f0-9]{64}$/u.test(matches[0].input_schema_sha256)) {
    throw new Error("mcp_tool_not_uniquely_catalogued");
  }
  const parsedArguments = OperationJsonValueSchema.safeParse(input.arguments);
  if (!parsedArguments.success || !isRecord(parsedArguments.data) || containsSecretLikeKey(parsedArguments.data)) {
    throw new Error("mcp_fixture_arguments_invalid");
  }
  const serializedArguments = JSON.stringify(parsedArguments.data);
  if (Buffer.byteLength(serializedArguments, "utf8") > MAX_PROPOSAL_ARGUMENT_BYTES) {
    throw new Error("mcp_fixture_arguments_too_large");
  }

  const stepId = input.step_id.trim();
  if (!input.plan_id.trim() || !input.request_id.trim() || !stepId ||
      input.plan_id.length > 200 || input.request_id.length > 200 || stepId.length > 200) {
    throw new Error("mcp_proposal_identity_invalid");
  }
  const target = {
    kind: "external_service",
    id: `mcp:${catalog.connection_digest}`,
    display_name: "MCP server (identity withheld)",
  } as const;
  const argumentsDigest = operationPlanDigest(parsedArguments.data);
  const stepParameters = {
    profile,
    connection_digest: catalog.connection_digest,
    catalog_digest: catalog.catalog_digest,
    tool_name: input.tool_name,
    input_schema_sha256: matches[0]!.input_schema_sha256,
    arguments: parsedArguments.data,
    ...(profile === "adapter-fixture"
      ? { source_is_untrusted: true, used_for_authority: false, may_execute: false }
      : {}),
  };
  const plan = OperationPlanSchema.parse({
    version: "operation-core.v1",
    plan_id: input.plan_id,
    request_id: input.request_id,
    state: "planned",
    steps: [{
      step_id: stepId,
      operation: "mcp.call",
      target,
      state: "planned",
      effects: [...MCP_CALL_POTENTIAL_EFFECTS],
      permission: {
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
        hds_brain_authority_required: true,
        approval_gate_required: true,
      },
      parameters: stepParameters,
      ...(profile === "native-live" ? { preparation: {
        depends_on: [],
        bindings: [],
        preconditions: [],
        validation: [{
          check_id: "mcp-call-result-bound",
          method: "mcp_call_result_matches",
          target,
          expected: {
            schema_version: "blue-tanuki.mcp-call-result-validation.v1",
            connection_digest: catalog.connection_digest,
            catalog_digest: catalog.catalog_digest,
            tool_name: input.tool_name,
            input_schema_sha256: matches[0]!.input_schema_sha256,
            arguments_sha256: argumentsDigest,
          },
        }],
        compensation: { available: false, reason: "MCP server effects are not assumed reversible" },
      } } : {}),
      adapter: profile === "native-live" ? "external_api" : "none",
      adapter_is_authority: false,
      command_generated_by_adapter_only: false,
    }],
    rollback: { available: false },
    raw_command_policy: { raw_command_is_core_operation: false, command_generation_location: "not_applicable" },
    planner_output_used_for_authority: false,
    hds_brain_authority_required: true,
  });
  return Object.freeze({
    profile,
    plan,
    connection_digest: catalog.connection_digest,
    catalog_digest: catalog.catalog_digest,
    tool_name: input.tool_name,
    input_schema_sha256: matches[0]!.input_schema_sha256,
    arguments_sha256: argumentsDigest,
    source_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  });
}

export interface McpCallToolOptions {
  readonly endpoint?: string | URL;
  readonly fetch?: McpFetch;
  readonly disabled_reason?: "mcp_endpoint_not_configured" | "mcp_endpoint_invalid";
  readonly runtime_observations?: McpRuntimeObservationStore;
}

/** A per-invocation MCP client that never forwards credentials or accepts a command endpoint. */
export function createMcpCallTool(options: McpCallToolOptions): Tool {
  let endpoint: URL | undefined;
  let configurationError = options.disabled_reason;
  if (options.endpoint !== undefined) {
    try {
      endpoint = parseLoopbackMcpEndpoint(options.endpoint);
    } catch {
      configurationError = "mcp_endpoint_invalid";
    }
  }
  if (!endpoint && !configurationError) configurationError = "mcp_endpoint_not_configured";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis) as McpFetch;
  const runtimeObservations = options.runtime_observations ?? mcpRuntimeObservationStore;
  const getEndpoint = (): URL => {
    if (configurationError) throw new McpAdapterError(configurationError);
    if (!endpoint) throw new McpAdapterError("mcp_endpoint_not_configured");
    return endpoint;
  };
  const connect = (signal?: AbortSignal): Promise<Client> =>
    connectMcpClient(getEndpoint(), fetcher, signal);

  return {
    name: "mcp.call",
    description: "Calls one catalog-bound MCP tool through HDS-J selection, fresh target observation and L3 final review.",
    required_capabilities: requireToolOperationDescriptor("mcp.call").required_capabilities,
    async inspect_target_version(args, inspectOptions) {
      if (!inspectOptions?.command_digest || !inspectOptions.operation_plan_binding_digest) {
        throw new Error("mcp_operation_plan_binding_required");
      }
      let client: Client | undefined;
      let catalogObserved = false;
      try {
        client = await connect();
        const catalog = await projectMcpCatalog(client, getEndpoint());
        runtimeObservations.recordCatalogReachable(getEndpoint());
        catalogObserved = true;
        const candidate = parseMcpCallArguments(args);
        assertCandidateMatchesCatalog(candidate, catalog);
        return McpCallTargetVersionObservationSchema.parse({
          schema_version: "blue-tanuki.mcp-call-target-version.v1",
          connection_digest: catalog.connection_digest,
          catalog_digest: catalog.catalog_digest,
          tool_name: candidate.tool_name,
          input_schema_sha256: candidate.input_schema_sha256,
          command_digest: inspectOptions.command_digest,
          operation_plan_binding_digest: inspectOptions.operation_plan_binding_digest,
          target_state: "available",
          used_for_authority: false,
          may_execute: false,
        } satisfies McpCallTargetVersionObservation);
      } catch (error) {
        if (!catalogObserved && endpoint) runtimeObservations.recordPreflightFailed(endpoint);
        throw safeMcpFailure(error, "mcp_target_version_unavailable");
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
    async invoke(args, ctx) {
      const candidate = parseMcpCallArguments(args);
      const observation = McpCallTargetVersionObservationSchema.safeParse(ctx.target_version_observation);
      if (!observation.success || !ctx.command_digest || !ctx.operation_plan_command_digest ||
          observation.data.command_digest !== ctx.operation_plan_command_digest ||
          observation.data.connection_digest !== candidate.connection_digest ||
          observation.data.catalog_digest !== candidate.catalog_digest ||
          observation.data.tool_name !== candidate.tool_name ||
          observation.data.input_schema_sha256 !== candidate.input_schema_sha256) {
        throw new Error("mcp_target_version_binding_invalid");
      }
      if (ctx.signal?.aborted) throw new Error("mcp_call_cancelled_before_dispatch");
      let client: Client | undefined;
      let dispatchStarted = false;
      let catalogObserved = false;
      try {
        client = await connect(ctx.signal);
        const catalog = await projectMcpCatalog(client, getEndpoint());
        runtimeObservations.recordCatalogReachable(getEndpoint());
        catalogObserved = true;
        assertCandidateMatchesCatalog(candidate, catalog);
        if (catalog.catalog_digest !== observation.data.catalog_digest ||
            catalog.connection_digest !== observation.data.connection_digest) {
          throw new McpAdapterError("mcp_catalog_changed_after_review");
        }
        if (ctx.signal?.aborted) throw new McpAdapterError("mcp_call_cancelled_before_dispatch");
        dispatchStarted = true;
        runtimeObservations.recordDispatchStarted(getEndpoint());
        const result = await client.callTool({ name: candidate.tool_name, arguments: candidate.arguments });
        if (result.isError === true) throw new McpAdapterError("mcp_server_reported_tool_failure");
        const parsedResult = OperationJsonValueSchema.safeParse(result);
        if (!parsedResult.success || !isRecord(parsedResult.data)) {
          throw new McpAdapterError("mcp_tool_result_invalid");
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(parsedResult.data), "utf8");
        if (resultBytes > MAX_TOOL_RESULT_BYTES) throw new McpAdapterError("mcp_tool_result_too_large");
        runtimeObservations.recordResponseReceived(getEndpoint());
        return {
          schema_version: "blue-tanuki.mcp-call-result.v1",
          connection_digest: candidate.connection_digest,
          catalog_digest: candidate.catalog_digest,
          tool_name: candidate.tool_name,
          input_schema_sha256: candidate.input_schema_sha256,
          arguments_sha256: operationPlanDigest(candidate.arguments),
          result_digest: operationPlanDigest(parsedResult.data),
          result: parsedResult.data,
          source_is_untrusted: true,
          used_for_authority: false,
          may_execute: false,
        };
      } catch (error) {
        if (dispatchStarted) {
          runtimeObservations.recordOutcomeUnknown(getEndpoint());
          throw new Error("mcp_call_outcome_unknown");
        }
        if (!catalogObserved && endpoint) runtimeObservations.recordPreflightFailed(endpoint);
        throw safeMcpFailure(error, "mcp_call_preflight_failed");
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
  };
}

/** Always reserve the core tool name; an absent or invalid endpoint stays disabled. */
export function registerMcpCallToolFromEnvironment(
  registry: ToolRegistry,
  env: Readonly<Record<string, string | undefined>>,
  runtimeObservations: McpRuntimeObservationStore = mcpRuntimeObservationStore,
): void {
  const endpoint = env.BLUE_TANUKI_MCP_ENDPOINT?.trim();
  if (!endpoint) {
    registry.register(createMcpCallTool({ disabled_reason: "mcp_endpoint_not_configured", runtime_observations: runtimeObservations }));
    return;
  }
  registry.register(createMcpCallTool({ endpoint, runtime_observations: runtimeObservations }));
}

interface NativeMcpCallArguments {
  readonly connection_digest: string;
  readonly catalog_digest: string;
  readonly tool_name: string;
  readonly input_schema_sha256: string;
  readonly arguments: Record<string, unknown>;
}

class McpAdapterError extends Error {}

function parseMcpCallArguments(value: Record<string, unknown>): NativeMcpCallArguments {
  if (Object.keys(value).sort().join(",") !==
      "arguments,catalog_digest,connection_digest,input_schema_sha256,profile,tool_name" ||
      value.profile !== "native-live" || typeof value.connection_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.connection_digest) || typeof value.catalog_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.catalog_digest) || typeof value.tool_name !== "string" ||
      value.tool_name.length < 1 || value.tool_name.length > 200 || value.tool_name.trim() !== value.tool_name ||
      /[\u0000-\u001f\u007f]/.test(value.tool_name) || typeof value.input_schema_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.input_schema_sha256)) {
    throw new McpAdapterError("mcp_call_arguments_invalid");
  }
  const parsedArguments = OperationJsonValueSchema.safeParse(value.arguments);
  if (!parsedArguments.success || !isRecord(parsedArguments.data) || containsSecretLikeKey(parsedArguments.data) ||
      Buffer.byteLength(JSON.stringify(parsedArguments.data), "utf8") > MAX_PROPOSAL_ARGUMENT_BYTES) {
    throw new McpAdapterError("mcp_call_arguments_invalid");
  }
  return {
    connection_digest: value.connection_digest,
    catalog_digest: value.catalog_digest,
    tool_name: value.tool_name,
    input_schema_sha256: value.input_schema_sha256,
    arguments: parsedArguments.data,
  };
}

function assertCandidateMatchesCatalog(candidate: NativeMcpCallArguments, catalog: McpCatalogProjection): void {
  const matches = catalog.tools.filter((tool) => tool.name === candidate.tool_name);
  if (catalog.connection_digest !== candidate.connection_digest || catalog.catalog_digest !== candidate.catalog_digest ||
      matches.length !== 1 || matches[0]?.input_schema_sha256 !== candidate.input_schema_sha256) {
    throw new McpAdapterError("mcp_catalog_changed_after_review");
  }
}

function safeMcpFailure(error: unknown, fallback: string): Error {
  return error instanceof McpAdapterError ? error : new McpAdapterError(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsSecretLikeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.replace(/[A-Z]/gu, (letter) => `_${letter}`).toLowerCase().replace(/[^a-z0-9]/gu, "");
    const sensitive = ["access", "refresh", "token", "secret", "password", "credential", "authorization", "apikey",
      "privatekey", "bearer"].some((part) => normalized.includes(part));
    return sensitive || containsSecretLikeKey(nested);
  });
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
