import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpCallContentReview, Tool, ToolRegistry } from "@blue-tanuki/core";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { MCP_CALL_POTENTIAL_EFFECTS, OperationJsonValueSchema, OperationPlanSchema,
  McpCallTargetVersionObservationSchema, OperationPlanMcpCatalogContextSchema,
  requireToolOperationDescriptor,
  type OperationJsonValue, type OperationPlan, type McpCallTargetVersionObservation, type McpRequestKind,
  type OperationPlanMcpCatalogContext } from "@blue-tanuki/protocol";
import { parseLoopbackMcpEndpoint } from "./mcp_endpoint.js";
import { mcpRuntimeObservationStore, type McpRuntimeObservationStore } from "./mcp_connection_observation.js";

export const BLUE_TANUKI_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const BLUE_TANUKI_MCP_TRANSPORT = "streamable_http" as const;

const MAX_CATALOG_ITEMS = 128;
const MAX_MCP_PLANNING_CATALOG_BYTES = 48 * 1024;
const MAX_MCP_PLANNING_SCHEMA_DEPTH = 12;
const MAX_MCP_PLANNING_SCHEMA_NODES = 4_096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSAL_ARGUMENT_BYTES = 64 * 1024;
// Keep transport requests bounded below the Executor's 10-second operation timeout,
// so a disconnected loopback server returns a classified pre-dispatch failure first.
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

type McpFetch = NonNullable<NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>["fetch"]>;
type McpTargetInspectionOptions = NonNullable<Parameters<NonNullable<Tool["inspect_target_version"]>>[1]>;

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
  readonly read_request_sha256: string;
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
  /** Untrusted capability claims from the MCP server; null means no capability object was supplied. */
  readonly server_advertised_capabilities: {
    readonly tools: boolean;
    readonly resources: boolean;
    readonly prompts: boolean;
  } | null;
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
    return projectMcpCatalog(await readMcpCatalogSnapshot(client), endpoint);
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

/**
 * Reads bounded catalog metadata to bind the planning context to the same digest used by the
 * executor. Bounded tool/resource/prompt metadata is returned to C; no MCP request is sent and no
 * resource or prompt content is read.
 */
export async function inspectMcpToolPlanningCatalog(
  options: McpCatalogInspectionOptions,
): Promise<OperationPlanMcpCatalogContext> {
  const endpoint = parseLoopbackMcpEndpoint(options.endpoint);
  const client = await connectMcpClient(endpoint, options.fetch, options.signal);
  try {
    const snapshot = await readMcpCatalogSnapshot(client);
    const catalog = projectMcpCatalog(snapshot, endpoint);
    const listedTools = snapshot.tools;
    if (listedTools.length > MAX_CATALOG_ITEMS || snapshot.resources.length > MAX_CATALOG_ITEMS ||
        snapshot.resource_templates.length > MAX_CATALOG_ITEMS || snapshot.prompts.length > MAX_CATALOG_ITEMS) {
      throw new Error("mcp_catalog_planning_context_invalid");
    }
    const tools = listedTools.map((tool) => ({
      name: requireMcpPlanningText(tool.name, 200),
      title: optionalMcpPlanningText(tool.title, 200),
      description: optionalMcpPlanningText(tool.description, 2_048),
      input_schema: sanitizeMcpPlanningSchema(tool.inputSchema),
      input_schema_sha256: digestJson(tool.inputSchema),
    }));
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new Error("mcp_catalog_planning_context_invalid");
    }
    const resources = snapshot.resources.map((resource) => {
      const uri_sha256 = digestJson(resource.uri);
      return {
        name: requireMcpPlanningText(resource.name, 200),
        title: optionalMcpPlanningText(resource.title, 200),
        description: optionalMcpPlanningText(resource.description, 2_048),
        uri_sha256,
        read_request_sha256: mcpResourceReadRequestDigest(uri_sha256),
        mime_type: optionalMcpPlanningText(resource.mimeType, 120),
      };
    });
    const resourceTemplates = snapshot.resource_templates.map((template) => ({
      name: requireMcpPlanningText(template.name, 200),
      title: optionalMcpPlanningText(template.title, 200),
      description: optionalMcpPlanningText(template.description, 2_048),
      uri_template_sha256: digestJson(template.uriTemplate),
      mime_type: optionalMcpPlanningText(template.mimeType, 120),
    }));
    const prompts = snapshot.prompts.map((prompt) => ({
      name: requireMcpPlanningText(prompt.name, 200),
      title: optionalMcpPlanningText(prompt.title, 200),
      description: optionalMcpPlanningText(prompt.description, 2_048),
      arguments: (prompt.arguments ?? []).map((argument) => ({
        name: requireMcpPlanningText(argument.name, 200),
        description: optionalMcpPlanningText(argument.description, 2_048),
        required: argument.required === true,
      })),
      arguments_sha256: digestJson(prompt.arguments ?? []),
    }));
    if (new Set(resources.map((resource) => resource.uri_sha256)).size !== resources.length ||
        new Set(resourceTemplates.map((template) => template.uri_template_sha256)).size !== resourceTemplates.length ||
        new Set(prompts.map((prompt) => prompt.name)).size !== prompts.length ||
        prompts.some((prompt) => new Set(prompt.arguments.map((argument) => argument.name)).size !== prompt.arguments.length)) {
      throw new Error("mcp_catalog_planning_context_invalid");
    }
    const context = OperationPlanMcpCatalogContextSchema.parse({
      schema_version: "blue-tanuki.operation-plan-mcp-catalog-context.v1" as const,
      protocol_version: BLUE_TANUKI_MCP_PROTOCOL_VERSION,
      transport: BLUE_TANUKI_MCP_TRANSPORT,
      connection_digest: catalog.connection_digest,
      catalog_digest: catalog.catalog_digest,
      catalog_completeness: "unknown" as const,
      tools,
      resources,
      resource_templates: resourceTemplates,
      prompts,
      source_is_untrusted: true as const,
      used_for_authority: false as const,
      may_execute: false as const,
    });
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_MCP_PLANNING_CATALOG_BYTES) {
      throw new Error("mcp_catalog_planning_context_invalid");
    }
    return context;
  } catch {
    throw new Error("mcp_catalog_planning_context_invalid");
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function inspectMcpToolPlanningCatalogFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OperationPlanMcpCatalogContext> {
  const endpoint = env.BLUE_TANUKI_MCP_ENDPOINT?.trim();
  if (!endpoint) return Promise.reject(new Error("mcp_catalog_planning_endpoint_unavailable"));
  return inspectMcpToolPlanningCatalog({
    endpoint,
    fetch: globalThis.fetch.bind(globalThis) as McpFetch,
  });
}

function requireMcpPlanningText(value: unknown, limit: number): string {
  const text = optionalMcpPlanningText(value, limit);
  if (!text) throw new Error("mcp_catalog_planning_context_invalid");
  return text;
}

function optionalMcpPlanningText(value: unknown, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("mcp_catalog_planning_context_invalid");
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  if (normalized.length > limit) throw new Error("mcp_catalog_planning_context_invalid");
  return normalized || null;
}

function sanitizeMcpPlanningSchema(value: unknown): Record<string, OperationJsonValue> {
  const sanitized = sanitizeMcpPlanningJsonValue(value, { nodes: 0 }, 0);
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== "object") {
    throw new Error("mcp_catalog_planning_context_invalid");
  }
  const parsed = OperationJsonValueSchema.parse(sanitized);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("mcp_catalog_planning_context_invalid");
  }
  return parsed as Record<string, OperationJsonValue>;
}

function sanitizeMcpPlanningJsonValue(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): OperationJsonValue {
  budget.nodes++;
  if (depth > MAX_MCP_PLANNING_SCHEMA_DEPTH || budget.nodes > MAX_MCP_PLANNING_SCHEMA_NODES) {
    throw new Error("mcp_catalog_planning_context_invalid");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 4_096) throw new Error("mcp_catalog_planning_context_invalid");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("mcp_catalog_planning_context_invalid");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error("mcp_catalog_planning_context_invalid");
    return value.map((item) => sanitizeMcpPlanningJsonValue(item, budget, depth + 1));
  }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)) {
    throw new Error("mcp_catalog_planning_context_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 128) throw new Error("mcp_catalog_planning_context_invalid");
  const result: Record<string, OperationJsonValue> = Object.create(null) as Record<string, OperationJsonValue>;
  for (const [key, child] of entries) {
    if (!key || key.length > 256 || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("mcp_catalog_planning_context_invalid");
    }
    result[key] = sanitizeMcpPlanningJsonValue(child, budget, depth + 1);
  }
  return result;
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

async function readMcpCatalogSnapshot(client: Client) {
  const serverCapabilities = client.getServerCapabilities();
  // Only enumerate methods the server advertised; an omitted capability remains unknown, not a
  // proof that the server has no such data.
  const [toolPage, resourcePage, resourceTemplatePage, promptPage] = await Promise.all([
    serverCapabilities?.tools !== undefined ? client.listTools() : Promise.resolve({ tools: [] }),
    serverCapabilities?.resources !== undefined ? client.listResources() : Promise.resolve({ resources: [] }),
    serverCapabilities?.resources !== undefined
      ? client.listResourceTemplates() : Promise.resolve({ resourceTemplates: [] }),
    serverCapabilities?.prompts !== undefined ? client.listPrompts() : Promise.resolve({ prompts: [] }),
  ]);
  return {
    tools: toolPage.tools ?? [],
    resources: resourcePage.resources ?? [],
    resource_templates: resourceTemplatePage.resourceTemplates ?? [],
    prompts: promptPage.prompts ?? [],
    server_info: client.getServerVersion(),
    server_capabilities: serverCapabilities,
  };
}

function projectMcpCatalog(
  snapshot: Awaited<ReturnType<typeof readMcpCatalogSnapshot>>,
  endpoint: URL,
): McpCatalogProjection {
  const { tools, resources, resource_templates: resourceTemplates, prompts, server_info: serverInfo,
    server_capabilities: serverCapabilities } = snapshot;
  const projection = {
    schema_version: "blue-tanuki.mcp-catalog-projection.v1",
    protocol_version: BLUE_TANUKI_MCP_PROTOCOL_VERSION,
    transport: BLUE_TANUKI_MCP_TRANSPORT,
    connection_digest: digestJson({ endpoint: endpoint.href }),
    server_info: serverInfo?.name && serverInfo.version
      ? { name: boundedIdentifier(serverInfo.name), version: boundedIdentifier(serverInfo.version) }
      : null,
    server_advertised_capabilities: serverCapabilities ? {
      tools: serverCapabilities.tools !== undefined,
      resources: serverCapabilities.resources !== undefined,
      prompts: serverCapabilities.prompts !== undefined,
    } : null,
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
      const uri_sha256 = digestJson(resource.uri);
      return [{
        name,
        title: safeText(resource.title, 200),
        description_sha256: digestOptionalText(resource.description),
        uri_sha256,
        read_request_sha256: mcpResourceReadRequestDigest(uri_sha256),
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

  const inspectCandidate = async (args: Record<string, unknown>, inspectOptions: McpTargetInspectionOptions) => {
    if (!inspectOptions.command_digest || !inspectOptions.operation_plan_binding_digest) {
      throw new Error("mcp_operation_plan_binding_required");
    }
    let client: Client | undefined;
    let catalogObserved = false;
    try {
      client = await connect(inspectOptions.signal);
      const snapshot = await readMcpCatalogSnapshot(client);
      const catalog = projectMcpCatalog(snapshot, getEndpoint());
      runtimeObservations.recordCatalogReachable(getEndpoint());
      catalogObserved = true;
      const candidate = parseMcpCallArguments(args);
      assertCandidateMatchesCatalog(candidate, catalog, snapshot);
      const observation = McpCallTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.mcp-call-target-version.v1",
        connection_digest: catalog.connection_digest,
        catalog_digest: catalog.catalog_digest,
        request_kind: candidate.request_kind,
        tool_name: candidate.tool_name,
        input_schema_sha256: candidate.input_schema_sha256,
        ...(candidate.resource_uri_sha256 ? { resource_uri_sha256: candidate.resource_uri_sha256 } : {}),
        command_digest: inspectOptions.command_digest,
        operation_plan_binding_digest: inspectOptions.operation_plan_binding_digest,
        target_state: "available",
        used_for_authority: false,
        may_execute: false,
      } satisfies McpCallTargetVersionObservation);
      return { candidate, catalog, snapshot, observation };
    } catch (error) {
      const currentEndpoint = endpoint;
      if (!catalogObserved && currentEndpoint && !inspectOptions.signal?.aborted) {
        runtimeObservations.recordPreflightFailed(currentEndpoint);
      }
      if (inspectOptions.signal?.aborted) throw new Error("mcp_target_version_inspection_cancelled");
      throw safeMcpFailure(error, "mcp_target_version_unavailable");
    } finally {
      await client?.close().catch(() => undefined);
    }
  };

  const tool: Tool = {
    name: "mcp.call",
    adapter_version: "1.0.0-rc.1",
    description: "Sends one catalog-bound MCP tool/resource/prompt request through HDS-J selection, fresh target observation and L3 final review.",
    required_capabilities: requireToolOperationDescriptor("mcp.call").required_capabilities,
    async inspect_target_version(args, inspectOptions) {
      if (!inspectOptions) throw new Error("mcp_operation_plan_binding_required");
      return (await inspectCandidate(args, inspectOptions)).observation;
    },
    async inspect_content_review(args, reviewOptions) {
      if (!reviewOptions?.command_digest || !reviewOptions.operation_plan_binding_digest) {
        throw new Error("mcp_operation_plan_binding_required");
      }
      const inspection = await inspectCandidate(args, reviewOptions);
      const { candidate, catalog, snapshot, observation } = inspection;
      const reviewMetadata = getMcpRequestReviewMetadata(candidate, catalog, snapshot);
      if (!endpoint) throw new Error("mcp_request_review_unavailable");
      const requestPayloadDigest = operationPlanDigest({
        schema_version: "blue-tanuki.mcp-call-request.v1",
        profile: "native-live",
        request_kind: candidate.request_kind,
        connection_digest: candidate.connection_digest,
        catalog_digest: candidate.catalog_digest,
        tool_name: candidate.tool_name,
        input_schema_sha256: candidate.input_schema_sha256,
        ...(candidate.resource_uri_sha256 ? { resource_uri_sha256: candidate.resource_uri_sha256 } : {}),
        arguments: candidate.arguments,
      });
      const reviewBase: Omit<McpCallContentReview, "review_digest"> = {
        kind: "mcp_call",
        operation: "mcp.call",
        profile: "native-live",
        request_kind: candidate.request_kind,
        ...(candidate.resource_uri_sha256 ? { resource_uri_sha256: candidate.resource_uri_sha256 } : {}),
        command_digest: reviewOptions.command_digest,
        request_payload_digest: requestPayloadDigest,
        target_version_digest: operationPlanDigest(observation),
        target_version_observation: observation,
        operation_plan_binding_digest: reviewOptions.operation_plan_binding_digest,
        endpoint_origin: endpoint.origin,
        endpoint_path_digest: operationPlanDigest(endpoint.pathname),
        connection_digest: catalog.connection_digest,
        catalog_digest: catalog.catalog_digest,
        server_name: catalog.server_info?.name ?? null,
        server_version: catalog.server_info?.version ?? null,
        tool_name: candidate.tool_name,
        tool_title: reviewMetadata.title,
        tool_description: reviewMetadata.description,
        description_sha256: reviewMetadata.description_sha256,
        input_schema_sha256: candidate.input_schema_sha256,
        arguments: candidate.arguments,
        potential_effects: [...MCP_CALL_POTENTIAL_EFFECTS],
        no_store: true,
        used_for_authority: false,
        may_execute: false,
      };
      return Object.freeze({ ...reviewBase, review_digest: operationPlanDigest(reviewBase) });
    },
    async invoke(args, ctx) {
      const candidate = parseMcpCallArguments(args);
      const observation = McpCallTargetVersionObservationSchema.safeParse(ctx.target_version_observation);
      if (!observation.success || !ctx.command_digest || !ctx.operation_plan_command_digest ||
          observation.data.command_digest !== ctx.operation_plan_command_digest ||
          observation.data.connection_digest !== candidate.connection_digest ||
          observation.data.catalog_digest !== candidate.catalog_digest ||
          (observation.data.request_kind ?? "tool_call") !== candidate.request_kind ||
          observation.data.tool_name !== candidate.tool_name ||
          observation.data.input_schema_sha256 !== candidate.input_schema_sha256 ||
          observation.data.resource_uri_sha256 !== candidate.resource_uri_sha256) {
        throw new Error("mcp_target_version_binding_invalid");
      }
      if (ctx.signal?.aborted) throw new Error("mcp_call_cancelled_before_dispatch");
      let client: Client | undefined;
      let dispatchStarted = false;
      let catalogObserved = false;
      try {
        client = await connect(ctx.signal);
        const snapshot = await readMcpCatalogSnapshot(client);
        const catalog = projectMcpCatalog(snapshot, getEndpoint());
        runtimeObservations.recordCatalogReachable(getEndpoint());
        catalogObserved = true;
        assertCandidateMatchesCatalog(candidate, catalog, snapshot);
        if (catalog.catalog_digest !== observation.data.catalog_digest ||
            catalog.connection_digest !== observation.data.connection_digest) {
          throw new McpAdapterError("mcp_catalog_changed_after_review");
        }
        if (ctx.signal?.aborted) throw new McpAdapterError("mcp_call_cancelled_before_dispatch");
        dispatchStarted = true;
        runtimeObservations.recordDispatchStarted(getEndpoint());
        let result: unknown;
        if (candidate.request_kind === "tool_call") {
          const toolResult = await client.callTool({ name: candidate.tool_name, arguments: candidate.arguments });
          if (toolResult.isError === true) throw new McpAdapterError("mcp_server_reported_tool_failure");
          result = toolResult;
        } else if (candidate.request_kind === "resource_read") {
          const uriSha256 = candidate.resource_uri_sha256!;
          const resource = snapshot.resources.find((entry) => digestJson(entry.uri) === uriSha256);
          if (!resource) throw new McpAdapterError("mcp_resource_disappeared_after_review");
          result = await client.readResource({ uri: resource.uri }, { cacheMode: "bypass" });
        } else {
          result = await client.getPrompt({
            name: candidate.tool_name,
            arguments: candidate.arguments as Record<string, string>,
          });
        }
        const parsedResult = OperationJsonValueSchema.safeParse(result);
        if (!parsedResult.success || !isRecord(parsedResult.data)) {
          throw new McpAdapterError("mcp_request_result_invalid");
        }
        const sanitizedResult = redactMcpResponseUris(parsedResult.data);
        const parsedSanitizedResult = OperationJsonValueSchema.safeParse(sanitizedResult);
        if (!parsedSanitizedResult.success || !isRecord(parsedSanitizedResult.data)) {
          throw new McpAdapterError("mcp_request_result_invalid");
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(parsedSanitizedResult.data), "utf8");
        if (resultBytes > MAX_TOOL_RESULT_BYTES) throw new McpAdapterError("mcp_request_result_too_large");
        runtimeObservations.recordResponseReceived(getEndpoint());
        return {
          schema_version: "blue-tanuki.mcp-call-result.v1",
          ...(candidate.explicit_request_kind ? { request_kind: candidate.request_kind } : {}),
          connection_digest: candidate.connection_digest,
          catalog_digest: candidate.catalog_digest,
          tool_name: candidate.tool_name,
          input_schema_sha256: candidate.input_schema_sha256,
          ...(candidate.resource_uri_sha256 ? { resource_uri_sha256: candidate.resource_uri_sha256 } : {}),
          arguments_sha256: operationPlanDigest(candidate.arguments),
          result_digest: operationPlanDigest(parsedSanitizedResult.data),
          result: parsedSanitizedResult.data,
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
  return tool;
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
  readonly request_kind: McpRequestKind;
  readonly explicit_request_kind: boolean;
  readonly connection_digest: string;
  readonly catalog_digest: string;
  readonly tool_name: string;
  readonly input_schema_sha256: string;
  readonly resource_uri_sha256?: string;
  readonly arguments: Record<string, unknown>;
}

class McpAdapterError extends Error {}

function parseMcpCallArguments(value: Record<string, unknown>): NativeMcpCallArguments {
  const requestKind = value.request_kind === undefined ? "tool_call" : value.request_kind;
  const expectedKeys = requestKind === "resource_read"
    ? ["arguments", "catalog_digest", "connection_digest", "input_schema_sha256", "profile", "request_kind",
      "resource_uri_sha256", "tool_name"]
    : requestKind === "prompt_get"
      ? ["arguments", "catalog_digest", "connection_digest", "input_schema_sha256", "profile", "request_kind", "tool_name"]
      : requestKind === "tool_call"
        ? value.request_kind === undefined
          ? ["arguments", "catalog_digest", "connection_digest", "input_schema_sha256", "profile", "tool_name"]
          : ["arguments", "catalog_digest", "connection_digest", "input_schema_sha256", "profile", "request_kind", "tool_name"]
        : [];
  if (Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",") || expectedKeys.length === 0 ||
      value.profile !== "native-live" || typeof value.connection_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.connection_digest) || typeof value.catalog_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.catalog_digest) || typeof value.tool_name !== "string" ||
      value.tool_name.length < 1 || value.tool_name.length > 200 || value.tool_name.trim() !== value.tool_name ||
      /[\u0000-\u001f\u007f]/.test(value.tool_name) || typeof value.input_schema_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.input_schema_sha256) ||
      requestKind === "resource_read" && (typeof value.resource_uri_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.resource_uri_sha256) || value.tool_name !== `resource:${value.resource_uri_sha256}`) ||
      requestKind !== "resource_read" && value.resource_uri_sha256 !== undefined) {
    throw new McpAdapterError("mcp_call_arguments_invalid");
  }
  const parsedArguments = OperationJsonValueSchema.safeParse(value.arguments);
  if (!parsedArguments.success || !isRecord(parsedArguments.data) || containsSecretLikeKey(parsedArguments.data) ||
      Buffer.byteLength(JSON.stringify(parsedArguments.data), "utf8") > MAX_PROPOSAL_ARGUMENT_BYTES ||
      requestKind === "resource_read" && Object.keys(parsedArguments.data).length !== 0 ||
      requestKind === "prompt_get" && Object.values(parsedArguments.data).some((entry) =>
        typeof entry !== "string" || entry.length > 4_096)) {
    throw new McpAdapterError("mcp_call_arguments_invalid");
  }
  return {
    request_kind: requestKind as McpRequestKind,
    explicit_request_kind: value.request_kind !== undefined,
    connection_digest: value.connection_digest,
    catalog_digest: value.catalog_digest,
    tool_name: value.tool_name,
    input_schema_sha256: value.input_schema_sha256,
    ...(requestKind === "resource_read" ? { resource_uri_sha256: value.resource_uri_sha256 as string } : {}),
    arguments: parsedArguments.data,
  };
}

function assertCandidateMatchesCatalog(
  candidate: NativeMcpCallArguments,
  catalog: McpCatalogProjection,
  snapshot: Awaited<ReturnType<typeof readMcpCatalogSnapshot>>,
): void {
  if (catalog.connection_digest !== candidate.connection_digest || catalog.catalog_digest !== candidate.catalog_digest) {
    throw new McpAdapterError("mcp_catalog_changed_after_review");
  }
  if (candidate.request_kind === "tool_call") {
    const matches = catalog.tools.filter((tool) => tool.name === candidate.tool_name);
    if (matches.length !== 1 || matches[0]?.input_schema_sha256 !== candidate.input_schema_sha256) {
      throw new McpAdapterError("mcp_catalog_changed_after_review");
    }
    return;
  }
  if (candidate.request_kind === "resource_read") {
    const uriSha256 = candidate.resource_uri_sha256;
    const projected = catalog.resources.filter((resource) => resource.uri_sha256 === uriSha256);
    const raw = snapshot.resources.filter((resource) => digestJson(resource.uri) === uriSha256);
    if (!uriSha256 || projected.length !== 1 || raw.length !== 1 ||
        candidate.tool_name !== `resource:${uriSha256}` ||
        projected[0]?.read_request_sha256 !== candidate.input_schema_sha256 ||
        candidate.input_schema_sha256 !== mcpResourceReadRequestDigest(uriSha256) ||
        Object.keys(candidate.arguments).length !== 0) {
      throw new McpAdapterError("mcp_catalog_changed_after_review");
    }
    return;
  }
  const projected = catalog.prompts.filter((prompt) => prompt.name === candidate.tool_name);
  const raw = snapshot.prompts.filter((prompt) => prompt.name === candidate.tool_name);
  if (projected.length !== 1 || raw.length !== 1 ||
      projected[0]?.arguments_sha256 !== candidate.input_schema_sha256 ||
      !mcpPromptArgumentsMatch(raw[0]?.arguments ?? [], candidate.arguments)) {
    throw new McpAdapterError("mcp_prompt_arguments_invalid_or_catalog_changed");
  }
}

function getMcpRequestReviewMetadata(
  candidate: NativeMcpCallArguments,
  catalog: McpCatalogProjection,
  snapshot: Awaited<ReturnType<typeof readMcpCatalogSnapshot>>,
): { readonly title: string | null; readonly description: string | null; readonly description_sha256: string | null } {
  if (candidate.request_kind === "tool_call") {
    const raw = snapshot.tools.find((entry) => entry.name === candidate.tool_name);
    const projected = catalog.tools.find((entry) => entry.name === candidate.tool_name);
    if (!raw || !projected || projected.input_schema_sha256 !== candidate.input_schema_sha256) {
      throw new McpAdapterError("mcp_tool_review_stale");
    }
    return {
      title: optionalMcpPlanningText(raw.title, 200),
      description: optionalMcpPlanningText(raw.description, 2_048),
      description_sha256: projected.description_sha256,
    };
  }
  if (candidate.request_kind === "resource_read") {
    const raw = snapshot.resources.find((entry) => digestJson(entry.uri) === candidate.resource_uri_sha256);
    const projected = catalog.resources.find((entry) => entry.uri_sha256 === candidate.resource_uri_sha256);
    if (!raw || !projected || projected.read_request_sha256 !== candidate.input_schema_sha256) {
      throw new McpAdapterError("mcp_resource_review_stale");
    }
    return {
      title: optionalMcpPlanningText(raw.title, 200),
      description: optionalMcpPlanningText(raw.description, 2_048),
      description_sha256: projected.description_sha256,
    };
  }
  const raw = snapshot.prompts.find((entry) => entry.name === candidate.tool_name);
  const projected = catalog.prompts.find((entry) => entry.name === candidate.tool_name);
  if (!raw || !projected || projected.arguments_sha256 !== candidate.input_schema_sha256) {
    throw new McpAdapterError("mcp_prompt_review_stale");
  }
  return {
    title: optionalMcpPlanningText(raw.title, 200),
    description: optionalMcpPlanningText(raw.description, 2_048),
    description_sha256: projected.description_sha256,
  };
}

function redactMcpResponseUris(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes++;
  if (depth > 32 || budget.nodes > 100_000) throw new McpAdapterError("mcp_request_result_invalid");
  if (Array.isArray(value)) {
    if (value.length > 50_000) throw new McpAdapterError("mcp_request_result_invalid");
    return value.map((entry) => redactMcpResponseUris(entry, depth + 1, budget));
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "uri") continue;
    result[key] = redactMcpResponseUris(nested, depth + 1, budget);
  }
  return result;
}

function mcpPromptArgumentsMatch(
  declaredArguments: readonly { readonly name: string; readonly required?: boolean }[],
  argumentsValue: Record<string, unknown>,
): boolean {
  const declaredNames = new Set(declaredArguments.map((argument) => argument.name));
  if (declaredNames.size !== declaredArguments.length ||
      Object.keys(argumentsValue).some((name) => !declaredNames.has(name)) ||
      Object.entries(argumentsValue).some(([name, value]) => !name || typeof value !== "string" || value.length > 4_096)) {
    return false;
  }
  return declaredArguments.every((argument) => argument.required !== true ||
    typeof argumentsValue[argument.name] === "string");
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

function mcpResourceReadRequestDigest(uriSha256: string): string {
  return operationPlanDigest({ schema_version: "blue-tanuki.mcp-resource-read-request.v1", uri_sha256: uriSha256 });
}
