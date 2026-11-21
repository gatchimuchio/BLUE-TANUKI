import { createHash } from "node:crypto";
import * as https from "node:https";
import { requireToolOperationDescriptor, ComposioActionEffectRegistryBindingSchema,
  ComposioActionTargetVersionObservationSchema, type ComposioActionEffectRegistryBinding,
  type ComposioActionTargetVersionObservation, type ComposioActionContentReview } from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { assertToolExecutionNotCancelled, type Tool, type ToolContext } from "./registry.js";

type Env = Record<string, string | undefined>;

/** 既存のComposio設定とその接続資格だけをadapterへ渡す。 */
export function composioToolEnvironment(env: Readonly<Env>, apiKey = env.COMPOSIO_API_KEY): Env {
  return {
    COMPOSIO_API_KEY: apiKey,
    COMPOSIO_ALLOWED_TOOLKITS: env.COMPOSIO_ALLOWED_TOOLKITS,
    COMPOSIO_ALLOWED_ACTIONS: env.COMPOSIO_ALLOWED_ACTIONS,
    COMPOSIO_REVOKED_ACTIONS: env.COMPOSIO_REVOKED_ACTIONS,
    COMPOSIO_USER_ID: env.COMPOSIO_USER_ID,
    COMPOSIO_API_BASE_URL: env.COMPOSIO_API_BASE_URL,
    COMPOSIO_DRY_RUN: env.COMPOSIO_DRY_RUN,
    COMPOSIO_LIVE_EXECUTION: env.COMPOSIO_LIVE_EXECUTION,
  };
}

export type ComposioActionIntent =
  | "read"
  | "write"
  | "send"
  | "delete"
  | "unknown";

export interface ComposioConnectorStatus {
  configured: boolean;
  dry_run: boolean;
  live_execution_enabled: boolean;
  allowed_toolkits: string[];
  allowed_actions: string[];
  revoked_actions: string[];
  user_id_set: boolean;
  api_base_url: string;
  /** @deprecated Compatibility alias for local_credential_removal_available; no provider-side disconnect is implied. */
  connection_revoke_available: boolean;
  toolkit_count: number;
  action_scope_count: number;
  revoked_action_count: number;
  /** Local flags and allowlists satisfy configuration prerequisites only; this does not verify the account, action schema/effects, current delegation, or HDS approval. */
  live_execution_configuration_ready: boolean;
  /** @deprecated Compatibility alias for live_execution_configuration_ready; not an authorization or provider-readiness signal. */
  live_execution_available: boolean;
  /** The locally configured credential can be removed through the reviewed settings path; no provider-side disconnect is implied. */
  local_credential_removal_available: boolean;
  used_for_authority: false;
  metadata_used_for_authority: false;
  live_execution_used_for_authority: false;
}

export interface ComposioExecuteTarget {
  api_base_url: string;
  path: string;
  method: "POST";
  tool: string;
  toolkit: string;
  user_id: string;
  body: Record<string, unknown>;
  api_key: string;
  maxBytes: number;
}

export interface ComposioSearchTarget {
  api_base_url: string;
  path: string;
  method: "GET";
  toolkit: string;
  query: string;
  limit: number;
  api_key: string;
  maxBytes: number;
}

export interface ComposioAccountsTarget {
  api_base_url: string;
  path: string;
  method: "GET";
  toolkit: string;
  user_id: string;
  connected_account_id?: string;
  limit: number;
  api_key: string;
  maxBytes: number;
}

export interface ComposioScopesTarget {
  api_base_url: string;
  path: string;
  method: "POST";
  toolkit: string;
  tools: string[];
  toolkit_version: string;
  auth_scheme: string;
  body: Record<string, unknown>;
  api_key: string;
  maxBytes: number;
}

export interface ComposioExecuteResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  truncated: boolean;
  request_id: string | null;
}

export interface ComposioOptions {
  env?: Env;
  signal?: AbortSignal;
  commandDigest?: string;
  operationPlanBindingDigest?: string;
  targetVersionObservation?: ComposioActionTargetVersionObservation;
  requireTargetVersionObservation?: boolean;
  request?: (target: ComposioExecuteTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
  searchRequest?: (target: ComposioSearchTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
  accountsRequest?: (target: ComposioAccountsTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
  scopesRequest?: (target: ComposioScopesTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
}

const DEFAULT_DRY_RUN = true;
const DEFAULT_API_BASE_URL = "https://backend.composio.dev";
const COMPOSIO_API_VERSION = "v3.1";
const COMPOSIO_EXECUTE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 128_000;
const MAX_MAX_BYTES = 512_000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_SEARCH_QUERY_LENGTH = 500;
const DEFAULT_ACCOUNT_LIMIT = 20;
const MAX_ACCOUNT_LIMIT = 50;

type ComposioRegisteredActionEffect = ComposioActionEffectRegistryBinding["effects"][number];

interface ComposioActionEffectRegistryEntry {
  entry_id: string;
  toolkit: string;
  tool: string;
  input_schema_sha256: string;
  output_schema_sha256: string;
  action_definition_sha256: string;
  effects: readonly ComposioRegisteredActionEffect[];
}

const COMPOSIO_ACTION_EFFECT_REGISTRY_VERSION = "1.1.0";

/**
 * Entries pin exact code-reviewed input/output schema and action-definition digests; provider
 * metadata and environment settings never populate the registry. The sole current row matches
 * the test fixture only; no live provider schema is registered. Provider schema drift stays unreviewed.
 */
const COMPOSIO_ACTION_EFFECT_REGISTRY: readonly ComposioActionEffectRegistryEntry[] = Object.freeze([
  Object.freeze({
    entry_id: "github.issue.create.fixture-schema.v1",
    toolkit: "github",
    tool: "GITHUB_CREATE_AN_ISSUE",
    input_schema_sha256: "75a323804435b510db3f8cc7fda9a750763b0ee894a8e28a00ffafc4823ee03a",
    output_schema_sha256: "a2c799262a3ce3c19ef5cdd983bf3d12b43ab3c426227091b909dcb7054738c0",
    action_definition_sha256: "a7dea94a84dd997dc18129bc636ce71d7c2a4868d2df7bf826b515a19d4aec71",
    effects: Object.freeze(["external_send", "write"] as const),
  }),
]);

export function isComposioActionEffectRegistered(toolkit: string, tool: string): boolean {
  const normalizedToolkit = toolkit.trim().toLowerCase();
  const normalizedTool = tool.trim().toLowerCase();
  return COMPOSIO_ACTION_EFFECT_REGISTRY.some((entry) =>
    entry.toolkit === normalizedToolkit && entry.tool.toLowerCase() === normalizedTool);
}

export function resolveComposioActionEffectRegistryBinding(params: {
  toolkit: string;
  tool: string;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  actionDefinitionSha256: string;
}): ComposioActionEffectRegistryBinding | undefined {
  const toolkit = params.toolkit.trim().toLowerCase();
  const tool = params.tool.trim();
  const entry = COMPOSIO_ACTION_EFFECT_REGISTRY.find((candidate) =>
    candidate.toolkit === toolkit && candidate.tool.toLowerCase() === tool.toLowerCase());
  if (!entry || ![params.inputSchemaSha256, params.outputSchemaSha256, params.actionDefinitionSha256]
    .every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
      entry.input_schema_sha256 !== params.inputSchemaSha256 ||
      entry.output_schema_sha256 !== params.outputSchemaSha256 ||
      entry.action_definition_sha256 !== params.actionDefinitionSha256) return undefined;

  const operationEffects = new Set(requireToolOperationDescriptor("composio.execute").effects);
  if (entry.effects.some((effect) => !operationEffects.has(effect))) return undefined;

  const entryBase = {
    schema_version: "blue-tanuki.composio-action-effect-registry-entry.v1" as const,
    registry_version: COMPOSIO_ACTION_EFFECT_REGISTRY_VERSION,
    registry_entry_id: entry.entry_id,
    toolkit: entry.toolkit,
    tool: entry.tool,
    input_schema_sha256: entry.input_schema_sha256,
    output_schema_sha256: entry.output_schema_sha256,
    action_definition_sha256: entry.action_definition_sha256,
    effects: [...entry.effects],
  };
  const entrySha256 = operationPlanDigest(entryBase);
  const bindingBase = {
    schema_version: "blue-tanuki.composio-action-effect-registry-binding.v1" as const,
    status: "reviewed" as const,
    registry_version: COMPOSIO_ACTION_EFFECT_REGISTRY_VERSION,
    registry_entry_id: entry.entry_id,
    registry_entry_sha256: entrySha256,
    toolkit,
    tool,
    input_schema_sha256: params.inputSchemaSha256,
    output_schema_sha256: params.outputSchemaSha256,
    action_definition_sha256: params.actionDefinitionSha256,
    effects: [...entry.effects],
  };
  return ComposioActionEffectRegistryBindingSchema.parse({
    ...bindingBase,
    binding_sha256: operationPlanDigest(bindingBase),
  });
}

function envValue(env: Env, name: string): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) throw new Error(`${name} must be a non-empty string`);
  return undefined;
}

function positiveIntArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, max);
}

function headerString(value: string | string[] | number | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "number") return String(value);
  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable digest used to bind a selected Composio JSON schema across catalog observations. */
export function composioSchemaDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function composioIdentityDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function composioRequestPayloadDigest(params: {
  toolkit: string;
  tool: string;
  connectedAccountId: string;
  userId: string;
  arguments: Record<string, unknown>;
}): string {
  return operationPlanDigest({
    schema_version: "blue-tanuki.composio-execute-request.v1",
    toolkit: params.toolkit.toLowerCase(),
    tool: params.tool,
    connected_account_id_sha256: composioIdentityDigest(params.connectedAccountId),
    user_id_sha256: composioIdentityDigest(params.userId),
    arguments: params.arguments,
  });
}

function assertConfigured(env: Env): string {
  const key = envValue(env, "COMPOSIO_API_KEY");
  if (!key) {
    throw new Error(
      "COMPOSIO_API_KEY is required for Composio connector; external_call_performed=false",
    );
  }
  return key;
}

export function composioAllowedToolkits(env: Env = process.env): string[] {
  return splitList(envValue(env, "COMPOSIO_ALLOWED_TOOLKITS"))
    .map((item) => item.toLowerCase());
}

export function composioAllowedActions(env: Env = process.env): string[] {
  return splitList(envValue(env, "COMPOSIO_ALLOWED_ACTIONS"))
    .map((item) => item.toLowerCase());
}

export function composioRevokedActions(env: Env = process.env): string[] {
  return splitList(envValue(env, "COMPOSIO_REVOKED_ACTIONS"))
    .map((item) => item.toLowerCase());
}

export function composioDryRun(env: Env = process.env): boolean {
  return boolEnv(envValue(env, "COMPOSIO_DRY_RUN"), DEFAULT_DRY_RUN);
}

export function composioLiveExecutionEnabled(env: Env = process.env): boolean {
  return boolEnv(envValue(env, "COMPOSIO_LIVE_EXECUTION"), false);
}

export function composioApiBaseUrl(env: Env = process.env): string {
  const raw = envValue(env, "COMPOSIO_API_BASE_URL") ?? DEFAULT_API_BASE_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("COMPOSIO_API_BASE_URL must use https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function composioStatus(env: Env = process.env): ComposioConnectorStatus {
  const configured = Boolean(envValue(env, "COMPOSIO_API_KEY"));
  const dryRun = composioDryRun(env);
  const liveExecutionEnabled = composioLiveExecutionEnabled(env);
  const allowedToolkits = composioAllowedToolkits(env);
  const allowedActions = composioAllowedActions(env);
  const revokedActions = composioRevokedActions(env);
  const userIdSet = Boolean(envValue(env, "COMPOSIO_USER_ID"));
  const liveExecutionConfigurationReady =
    configured &&
    !dryRun &&
    liveExecutionEnabled &&
    userIdSet &&
    allowedToolkits.length > 0 &&
    allowedActions.length > 0;
  return {
    configured,
    dry_run: dryRun,
    live_execution_enabled: liveExecutionEnabled,
    allowed_toolkits: allowedToolkits,
    allowed_actions: allowedActions,
    revoked_actions: revokedActions,
    user_id_set: userIdSet,
    api_base_url: composioApiBaseUrl(env),
    connection_revoke_available: configured,
    toolkit_count: allowedToolkits.length,
    action_scope_count: allowedActions.length,
    revoked_action_count: revokedActions.length,
    live_execution_configuration_ready: liveExecutionConfigurationReady,
    live_execution_available: liveExecutionConfigurationReady,
    local_credential_removal_available: configured,
    used_for_authority: false,
    metadata_used_for_authority: false,
    live_execution_used_for_authority: false,
  };
}

function assertToolkitAllowed(toolkit: string, allowed: readonly string[]): void {
  const normalized = toolkit.trim().toLowerCase();
  if (allowed.length === 0) {
    throw new Error(
      "COMPOSIO_ALLOWED_TOOLKITS must explicitly allow a toolkit before Composio use",
    );
  }
  if (!allowed.includes(normalized)) {
    throw new Error(`Composio toolkit not allowed: ${toolkit}`);
  }
}

function actionKeys(toolkit: string, tool: string): string[] {
  const normalizedToolkit = toolkit.trim().toLowerCase();
  const normalizedTool = tool.trim().toLowerCase();
  return [
    `${normalizedToolkit}:${normalizedTool}`,
    `${normalizedToolkit}:*`,
    normalizedTool,
  ];
}

function assertActionAllowed(
  toolkit: string,
  tool: string,
  allowed: readonly string[],
  revoked: readonly string[],
): void {
  const keys = actionKeys(toolkit, tool);
  const exactActionKey = keys[0]!;
  if (revoked.some((item) => keys.includes(item.toLowerCase()))) {
    throw new Error(`Composio action revoked: ${toolkit}:${tool}; external_call_performed=false`);
  }
  if (allowed.length === 0) {
    throw new Error(
      "COMPOSIO_ALLOWED_ACTIONS must explicitly allow a toolkit action before Composio live execution",
    );
  }
  if (!allowed.some((item) => item.trim().toLowerCase() === exactActionKey)) {
    throw new Error(`Composio action not allowed: ${toolkit}:${tool}; external_call_performed=false`);
  }
}

export function classifyComposioAction(value: string | undefined): ComposioActionIntent {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (/(delete|remove|destroy|revoke|purge)/.test(raw)) return "delete";
  if (/(send|post|publish|reply|invite|upload|share)/.test(raw)) return "send";
  if (/(create|update|write|patch|edit|draft|move|copy)/.test(raw)) return "write";
  if (/(read|get|list|search|find|lookup|fetch|metadata)/.test(raw)) return "read";
  return "unknown";
}

export function parseComposioArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (isRecord(value)) return { ...value };
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return { ...parsed };
  }
  throw new Error("payload/arguments must be a JSON object");
}

function parseJsonOrText(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function composioResponseError(toolName: string, response: ComposioExecuteResponse): Error {
  let message = "";
  const data = parseJsonOrText(response.body);
  if (isRecord(data)) {
    const error = data.error;
    if (isRecord(error) && typeof error.message === "string") message = error.message;
    else if (typeof data.message === "string") message = data.message;
  }
  return new Error(
    `${toolName} returned HTTP ${response.status}; mutation_status=not_confirmed; next_action=check Composio connection/audit before retrying${message ? `; message=${message}` : ""}`,
  );
}

interface ComposioHttpRequestTarget {
  api_base_url: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  api_key: string;
  maxBytes: number;
  operation: "search" | "execute" | "accounts" | "scopes";
}

async function defaultComposioApiRequest(
  target: ComposioHttpRequestTarget,
  signal?: AbortSignal,
): Promise<ComposioExecuteResponse> {
  const endpoint = new URL(target.path, `${target.api_base_url}/`);
  return await new Promise((resolve, reject) => {
    const requestBody = target.body ? Buffer.from(JSON.stringify(target.body), "utf8") : undefined;
    let finished = false;
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const finish = (result: ComposioExecuteResponse): void => {
      if (finished) return;
      const { body, content_type, request_id } = result;
      const key = target.api_key;
      if (body.includes(key) || content_type?.includes(key) || request_id?.includes(key) ||
          (body.includes("\\") && body.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g,
            escape => JSON.parse(`"${escape}"`) as string).includes(key))) {
        fail(new Error("composio_credential_echo"));
        return;
      }
      finished = true;
      resolve(result);
    };
    const req = https.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: target.method,
        headers: {
          Accept: "application/json",
          ...(requestBody ? {
            "Content-Type": "application/json",
            "Content-Length": String(requestBody.length),
          } : {}),
          "User-Agent": `BLUE-TANUKI/1.0 composio.${target.operation}`,
          "x-api-key": target.api_key,
        },
        timeout: COMPOSIO_EXECUTE_TIMEOUT_MS,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerString(res.headers["content-type"]);
        const requestId =
          headerString(res.headers["x-request-id"]) ??
          headerString(res.headers["x-composio-request-id"]);
        const chunks: Buffer[] = [];
        let seenBytes = 0;
        let keptBytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer | string) => {
          if (finished) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          seenBytes += buf.length;
          if (keptBytes < target.maxBytes) {
            const keep = buf.subarray(0, target.maxBytes - keptBytes);
            chunks.push(keep);
            keptBytes += keep.length;
          }
          if (seenBytes >= target.maxBytes) {
            truncated = true;
            res.destroy();
            finish({
              status,
              ok: status >= 200 && status < 300,
              content_type: contentType,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
              request_id: requestId,
            });
          }
        });
        res.on("end", () => {
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
            request_id: requestId,
          });
        });
        res.on("error", (error) => {
          if (!finished) fail(error);
        });
      },
    );
    req.on("timeout", () => {
      const outcomeLabel = target.operation === "execute"
        ? "mutation_status"
        : target.operation === "accounts"
          ? "account_status"
          : target.operation === "scopes"
            ? "scope_status"
            : "catalog_status";
      req.destroy(
        new Error(
          `composio.${target.operation} timed out after ${COMPOSIO_EXECUTE_TIMEOUT_MS}ms; ${outcomeLabel}=not_confirmed`,
        ),
      );
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function defaultComposioExecuteRequest(
  target: ComposioExecuteTarget,
  signal?: AbortSignal,
): Promise<ComposioExecuteResponse> {
  return await defaultComposioApiRequest({
    ...target,
    operation: "execute",
  }, signal);
}

async function defaultComposioSearchRequest(
  target: ComposioSearchTarget,
  signal?: AbortSignal,
): Promise<ComposioExecuteResponse> {
  return await defaultComposioApiRequest({
    ...target,
    operation: "search",
  }, signal);
}

async function defaultComposioAccountsRequest(
  target: ComposioAccountsTarget,
  signal?: AbortSignal,
): Promise<ComposioExecuteResponse> {
  return await defaultComposioApiRequest({
    ...target,
    operation: "accounts",
  }, signal);
}

async function defaultComposioScopesRequest(
  target: ComposioScopesTarget,
  signal?: AbortSignal,
): Promise<ComposioExecuteResponse> {
  return await defaultComposioApiRequest({
    ...target,
    operation: "scopes",
  }, signal);
}

function catalogResponseError(response: ComposioExecuteResponse): Error {
  const requestId = response.request_id ? `; request_id=${response.request_id}` : "";
  return new Error(
    `composio.search returned HTTP ${response.status}; catalog_status=not_confirmed${requestId}; next_action=check Composio connection before retrying`,
  );
}

function accountsResponseError(response: ComposioExecuteResponse): Error {
  const requestId = response.request_id ? `; request_id=${response.request_id}` : "";
  return new Error(
    `composio.accounts returned HTTP ${response.status}; account_status=not_confirmed${requestId}; next_action=check the Composio connection before retrying`,
  );
}

function scopesResponseError(response: ComposioExecuteResponse): Error {
  const requestId = response.request_id ? `; request_id=${response.request_id}` : "";
  return new Error(
    `composio.scopes returned HTTP ${response.status}; scope_status=not_confirmed${requestId}; next_action=check the Composio toolkit scope contract before retrying`,
  );
}

const COMPOSIO_SCOPE_AUTH_SCHEMES = [
  "OAUTH2",
  "OAUTH1",
  "API_KEY",
  "BASIC",
  "BILLCOM_AUTH",
  "BEARER_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT",
  "NO_AUTH",
  "BASIC_WITH_JWT",
  "CALCOM_AUTH",
  "SERVICE_ACCOUNT",
  "SAML",
  "DCR_OAUTH",
  "CIMD_OAUTH",
  "S2S_OAUTH2",
] as const;

function boundedScopeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`Composio scope recommendation has an invalid ${field}; scope_status=not_confirmed`);
  }
  const scopes: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 512 ||
      item.trim() !== item ||
      /[\u0000-\u001f\u007f]/.test(item)
    ) {
      throw new Error(`Composio scope recommendation has an invalid ${field}; scope_status=not_confirmed`);
    }
    if (!scopes.includes(item)) scopes.push(item);
  }
  return scopes;
}

function boundedScopeCondition(value: unknown): Record<string, string | number | boolean | null | Array<string | number | boolean | null>> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).length > 20) {
    throw new Error("Composio scope recommendation has an invalid conditional requirement; scope_status=not_confirmed");
  }
  const result: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key)) {
      throw new Error("Composio scope recommendation has an invalid conditional requirement; scope_status=not_confirmed");
    }
    const items = Array.isArray(raw) ? raw : [raw];
    if (items.length > 20) {
      throw new Error("Composio scope recommendation has an oversized conditional requirement; scope_status=not_confirmed");
    }
    const bounded = items.map((item) => {
      if (
        item === null ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        (typeof item === "string" && item.length <= 256 && !/[\u0000-\u001f\u007f]/.test(item))
      ) return item;
      throw new Error("Composio scope recommendation has an invalid conditional requirement; scope_status=not_confirmed");
    });
    result[key] = Array.isArray(raw) ? bounded : bounded[0]!;
  }
  return result;
}

function scopeRecommendationProjection(
  value: unknown,
  toolkit: string,
  tools: readonly string[],
  authScheme: typeof COMPOSIO_SCOPE_AUTH_SCHEMES[number],
  requestedToolkitVersion: string,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.scopes)) {
    throw new Error("Composio scope recommendation did not contain scope data; scope_status=not_confirmed");
  }
  if (
    typeof value.toolkit_version !== "string" ||
    value.toolkit_version.length === 0 ||
    value.toolkit_version.length > 80 ||
    value.toolkit_version.trim() !== value.toolkit_version ||
    (requestedToolkitVersion !== "latest" && value.toolkit_version !== requestedToolkitVersion) ||
    (value.auth_scheme !== undefined && value.auth_scheme !== authScheme)
  ) {
    throw new Error("Composio scope recommendation did not confirm its toolkit version or auth scheme; scope_status=not_confirmed");
  }
  const scopes = value.scopes;
  const conditionalRaw = scopes.conditional ?? [];
  if (!Array.isArray(conditionalRaw) || conditionalRaw.length > 100) {
    throw new Error("Composio scope recommendation has an invalid conditional scope list; scope_status=not_confirmed");
  }
  const conditional = conditionalRaw.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.scope !== "string" ||
      item.scope.length === 0 ||
      item.scope.length > 512 ||
      item.scope.trim() !== item.scope ||
      /[\u0000-\u001f\u007f]/.test(item.scope) ||
      !Array.isArray(item.for)
    ) {
      throw new Error("Composio scope recommendation has an invalid conditional scope entry; scope_status=not_confirmed");
    }
    if (item.for.length > tools.length) {
      throw new Error("Composio scope recommendation has too many conditional action entries; scope_status=not_confirmed");
    }
    const forTools = item.for.filter((tool): tool is string => typeof tool === "string" && tools.includes(tool));
    if (forTools.length !== item.for.length) {
      throw new Error("Composio scope recommendation references an unrequested tool; scope_status=not_confirmed");
    }
    return {
      scope: boundedScopeList([item.scope], "conditional")[0],
      for: forTools,
      when: boundedScopeCondition(item.when),
    };
  });
  return {
    provider: "composio",
    operation: "scopes",
    toolkit,
    tools: [...tools],
    auth_scheme: authScheme,
    toolkit_version: value.toolkit_version,
    least_privilege: boundedScopeList(scopes.least_privilege, "least_privilege"),
    fewest: boundedScopeList(scopes.fewest, "fewest"),
    conditional,
  };
}

export async function invokeComposioScopes(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const apiKey = assertConfigured(env);
  const toolkit = stringArg(args, "toolkit")!.toLowerCase();
  assertToolkitAllowed(toolkit, composioAllowedToolkits(env));
  if (!Array.isArray(args.tools) || args.tools.length < 1 || args.tools.length > 20) {
    throw new Error("tools must contain between 1 and 20 explicitly allowed Composio action slugs");
  }
  const tools = args.tools.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,160}$/.test(value)) {
      throw new Error("tools must contain valid Composio action slugs");
    }
    return value;
  });
  if (new Set(tools.map((tool) => tool.toLowerCase())).size !== tools.length) {
    throw new Error("tools must not contain duplicate Composio action slugs");
  }
  const allowedActions = composioAllowedActions(env);
  const revokedActions = composioRevokedActions(env);
  for (const tool of tools) assertActionAllowed(toolkit, tool, allowedActions, revokedActions);
  const toolkitVersionArg = stringArg(args, "toolkit_version", false);
  if (args.toolkit_version !== undefined && toolkitVersionArg === undefined) {
    throw new Error("toolkit_version must be a string when supplied");
  }
  const toolkitVersion = toolkitVersionArg ?? "latest";
  if (!/^(latest|\d{8}_\d{2})$/.test(toolkitVersion)) {
    throw new Error("toolkit_version must be latest or a pinned YYYYMMDD_NN version");
  }
  const authSchemeArg = stringArg(args, "auth_scheme", false);
  if (args.auth_scheme !== undefined && authSchemeArg === undefined) {
    throw new Error("auth_scheme must be a string when supplied");
  }
  const authSchemeRaw = authSchemeArg ?? "OAUTH2";
  if (!(COMPOSIO_SCOPE_AUTH_SCHEMES as readonly string[]).includes(authSchemeRaw)) {
    throw new Error("auth_scheme is not supported by the Composio scope recommendation contract");
  }
  const authScheme = authSchemeRaw as typeof COMPOSIO_SCOPE_AUTH_SCHEMES[number];
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const apiBaseUrl = composioApiBaseUrl(env);
  const path = `/api/${COMPOSIO_API_VERSION}/toolkits/${encodeURIComponent(toolkit)}/scopes/recommended`;
  assertToolExecutionNotCancelled(opts.signal, "composio.scopes");
  const response = await (opts.scopesRequest ?? defaultComposioScopesRequest)({
    api_base_url: apiBaseUrl,
    path,
    method: "POST",
    toolkit,
    tools,
    toolkit_version: toolkitVersion,
    auth_scheme: authScheme,
    body: { tools, toolkit_version: toolkitVersion, auth_scheme: authScheme },
    api_key: apiKey,
    maxBytes,
  }, opts.signal);
  if (!response.ok) throw scopesResponseError(response);
  if (response.truncated) {
    throw new Error("Composio scope recommendation exceeded the configured limit; scope_status=not_confirmed");
  }
  const projection = scopeRecommendationProjection(
    parseJsonOrText(response.body),
    toolkit,
    tools,
    authScheme,
    toolkitVersion,
  );
  return {
    ...projection,
    requested_toolkit_version: toolkitVersion,
    auth_scheme_source: authSchemeArg ? "owner_input" : "default_OAUTH2",
    contract_status: "experimental_beta",
    external_call_performed: true,
    external_mutation_sent: false,
    permission_granted: false,
    granted_scopes_observed: false,
    scope_recommendation_used_for_authority: false,
    used_for_authority: false,
    metadata_used_for_authority: false,
    api_base_url: apiBaseUrl,
    api_version: COMPOSIO_API_VERSION,
    status: response.status,
    composio_request_id: response.request_id,
    result_digest: jsonDigest(projection),
    next_action:
      "Review the least-privilege scopes with the owner. This experimental recommendation does not show scopes already granted to a connected account, create a connection, or authorize execution; keep HDS-BRAIN and Approval Gate L3 in the execution path.",
  };
}

interface ComposioConnectedAccountProjection {
  connected_account_id: string;
  toolkit: string;
  status: string;
  is_disabled: boolean | null;
  account_type: "PRIVATE" | "SHARED" | "UNKNOWN";
  auth_scheme: string;
  provider_region: "us" | "eu" | "unknown" | null;
}

const COMPOSIO_AUTH_SCHEMES = new Set([
  "API_KEY",
  "BASIC",
  "BEARER",
  "CUSTOM",
  "DCR_OAUTH",
  "NO_AUTH",
  "OAUTH1",
  "OAUTH2",
]);

function connectedAccountAuthScheme(value: Record<string, unknown>): string {
  const authConfig = isRecord(value.auth_config) ? value.auth_config : {};
  const state = isRecord(value.state) ? value.state : {};
  const candidates = [value.authScheme, authConfig.auth_scheme, state.authScheme]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    .map((candidate) => candidate.trim().toUpperCase());
  if (candidates.length === 0 || candidates.some((candidate) => !COMPOSIO_AUTH_SCHEMES.has(candidate))) {
    return "UNKNOWN";
  }
  return new Set(candidates).size === 1 ? candidates[0]! : "UNKNOWN";
}

function connectedProviderRegion(
  value: Record<string, unknown>,
  toolkit: string,
): "us" | "eu" | "unknown" | null {
  if (toolkit !== "posthog") return null;
  const state = isRecord(value.state) ? value.state : {};
  const stateValue = isRecord(state.val) ? state.val : {};
  const region = typeof stateValue.region === "string" ? stateValue.region.trim().toLowerCase() : "";
  return region === "us" || region === "eu" ? region : "unknown";
}

function connectedAccountProjection(
  value: unknown,
  expectedToolkit: string,
  expectedUserId: string,
): ComposioConnectedAccountProjection {
  if (!isRecord(value) || !isRecord(value.toolkit)) {
    throw new Error("Composio account list returned an invalid entry; account_status=not_confirmed");
  }
  const id = typeof value.id === "string" ? value.id : "";
  const toolkit = typeof value.toolkit.slug === "string" ? value.toolkit.slug.toLowerCase() : "";
  if (!id || id !== id.trim() || id.length > 256 || toolkit !== expectedToolkit.toLowerCase() || value.user_id !== expectedUserId) {
    throw new Error("Composio account list returned an out-of-scope entry; account_status=not_confirmed");
  }
  const experimental = isRecord(value.experimental) ? value.experimental : {};
  const accountTypeRaw = experimental.account_type;
  const accountType = accountTypeRaw === "PRIVATE" || accountTypeRaw === "SHARED"
    ? accountTypeRaw
    : "UNKNOWN";
  if (accountType !== "PRIVATE") {
    throw new Error("Composio account list returned a non-private or unclassified entry; account_status=not_confirmed");
  }
  const status = typeof value.status === "string" && /^[A-Za-z_]{1,40}$/.test(value.status)
    ? value.status.toUpperCase()
    : "UNKNOWN";
  return {
    connected_account_id: id,
    toolkit,
    status,
    is_disabled: typeof value.is_disabled === "boolean" ? value.is_disabled : null,
    account_type: accountType,
    auth_scheme: connectedAccountAuthScheme(value),
    provider_region: connectedProviderRegion(value, toolkit),
  };
}

async function readComposioAccounts(
  params: {
    apiBaseUrl: string;
    apiKey: string;
    toolkit: string;
    userId: string;
    connectedAccountId?: string;
    limit: number;
    maxBytes: number;
    request: (target: ComposioAccountsTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
    signal?: AbortSignal;
  },
): Promise<{ accounts: ComposioConnectedAccountProjection[]; response: ComposioExecuteResponse }> {
  const path = new URL("/api/v3.1/connected_accounts", `${params.apiBaseUrl}/`);
  path.searchParams.set("toolkit_slugs", params.toolkit.toLowerCase());
  path.searchParams.set("user_ids", params.userId);
  path.searchParams.set("account_type", "PRIVATE");
  path.searchParams.set("limit", String(params.limit));
  if (params.connectedAccountId) path.searchParams.set("connected_account_ids", params.connectedAccountId);
  assertToolExecutionNotCancelled(params.signal, "composio.accounts");
  const response = await params.request({
    api_base_url: params.apiBaseUrl,
    path: `${path.pathname}${path.search}`,
    method: "GET",
    toolkit: params.toolkit.toLowerCase(),
    user_id: params.userId,
    ...(params.connectedAccountId ? { connected_account_id: params.connectedAccountId } : {}),
    limit: params.limit,
    api_key: params.apiKey,
    maxBytes: params.maxBytes,
  }, params.signal);
  if (!response.ok) throw accountsResponseError(response);
  if (response.truncated) {
    throw new Error("Composio account list exceeded the configured limit; account_status=not_confirmed");
  }
  const data = parseJsonOrText(response.body);
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("Composio account list did not contain an accounts list; account_status=not_confirmed");
  }
  if (
    data.items.length > params.limit ||
    (data.next_cursor !== undefined && data.next_cursor !== null && data.next_cursor !== "")
  ) {
    throw new Error("Composio account list is incomplete; account_status=not_confirmed");
  }
  const accounts = data.items.map((item) =>
    connectedAccountProjection(item, params.toolkit, params.userId));
  return { accounts, response };
}

export async function invokeComposioAccounts(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const apiKey = assertConfigured(env);
  const userId = envValue(env, "COMPOSIO_USER_ID");
  if (!userId) throw new Error("COMPOSIO_USER_ID is required for Composio account lookup; external_call_performed=false");
  const toolkit = stringArg(args, "toolkit")!.toLowerCase();
  assertToolkitAllowed(toolkit, composioAllowedToolkits(env));
  const limit = positiveIntArg(args, "limit", DEFAULT_ACCOUNT_LIMIT, MAX_ACCOUNT_LIMIT);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const apiBaseUrl = composioApiBaseUrl(env);
  const result = await readComposioAccounts({
    apiBaseUrl,
    apiKey,
    toolkit,
    userId,
    limit,
    maxBytes,
    request: opts.accountsRequest ?? defaultComposioAccountsRequest,
    signal: opts.signal,
  });
  const accounts = result.accounts;
  return {
    provider: "composio",
    operation: "accounts",
    toolkit,
    account_count: accounts.length,
    accounts,
    external_call_performed: true,
    external_mutation_sent: false,
    api_base_url: apiBaseUrl,
    api_version: COMPOSIO_API_VERSION,
    status: result.response.status,
    truncated: result.response.truncated,
    composio_request_id: result.response.request_id,
    result_digest: jsonDigest(accounts),
    used_for_authority: false,
    metadata_used_for_authority: false,
    next_action:
      "Select a PRIVATE ACTIVE account for an explicit task. For PostHog, require an observed us/eu region and API_KEY auth scheme; unknown connection metadata blocks live execution. Account status and metadata do not grant task consent or permission; keep the owner-reviewed HDS-BRAIN Approval Gate L3.",
  };
}

function catalogToolProjection(value: unknown, expectedToolkit: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.toolkit)) {
    throw new Error("Composio catalog returned an invalid tool entry; catalog_status=not_confirmed");
  }
  const slug = typeof value.slug === "string" ? value.slug : "";
  const name = typeof value.name === "string" ? value.name : "";
  const toolkit = typeof value.toolkit.slug === "string" ? value.toolkit.slug.toLowerCase() : "";
  if (!slug || !name || toolkit !== expectedToolkit.toLowerCase()) {
    throw new Error("Composio catalog returned an out-of-scope tool entry; catalog_status=not_confirmed");
  }
  const inputParameters = isRecord(value.input_parameters) ? value.input_parameters : {};
  const outputParameters = isRecord(value.output_parameters) ? value.output_parameters : {};
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 100)
    : [];
  const projection = {
    slug: slug.slice(0, 160),
    name: name.slice(0, 240),
    toolkit,
    description: typeof value.description === "string" ? value.description.slice(0, 2_000) : "",
    version: typeof value.version === "string" ? value.version.slice(0, 80) : null,
    no_auth: typeof value.no_auth === "boolean" ? value.no_auth : null,
    is_deprecated: typeof value.is_deprecated === "boolean" ? value.is_deprecated : null,
    scopes,
    input_parameters: inputParameters,
    output_parameters: outputParameters,
  };
  const actionDefinitionSha256 = composioSchemaDigest(projection);
  const inputSchemaSha256 = composioSchemaDigest(inputParameters);
  const outputSchemaSha256 = composioSchemaDigest(outputParameters);
  const actionEffectRegistry = resolveComposioActionEffectRegistryBinding({
    toolkit,
    tool: slug,
    inputSchemaSha256,
    outputSchemaSha256,
    actionDefinitionSha256,
  });
  return {
    ...projection,
    input_schema_sha256: inputSchemaSha256,
    output_schema_sha256: outputSchemaSha256,
    action_definition_sha256: actionDefinitionSha256,
    action_effect_registry: actionEffectRegistry ?? {
      status: "unreviewed",
      registry_version: COMPOSIO_ACTION_EFFECT_REGISTRY_VERSION,
      effects: [],
      reason_code: "action_or_schema_not_in_reviewed_registry",
    },
  };
}

async function readCurrentComposioAction(params: {
  toolkit: string;
  tool: string;
  apiBaseUrl: string;
  apiKey: string;
  maxBytes: number;
  request: (target: ComposioSearchTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const path = new URL("/api/v3.1/tools", `${params.apiBaseUrl}/`);
  path.searchParams.set("toolkit_slug", params.toolkit.toLowerCase());
  path.searchParams.set("query", params.tool);
  path.searchParams.set("limit", String(MAX_SEARCH_LIMIT));
  path.searchParams.set("toolkit_versions", "latest");
  path.searchParams.set("include_deprecated", "false");
  assertToolExecutionNotCancelled(params.signal, "composio.execute");
  const response = await params.request({
    api_base_url: params.apiBaseUrl,
    path: `${path.pathname}${path.search}`,
    method: "GET",
    toolkit: params.toolkit.toLowerCase(),
    query: params.tool,
    limit: MAX_SEARCH_LIMIT,
    api_key: params.apiKey,
    maxBytes: params.maxBytes,
  }, params.signal);
  if (!response.ok) throw catalogResponseError(response);
  if (response.truncated) {
    throw new Error("Composio action schema response exceeded the configured limit; mutation_sent=false");
  }
  const data = parseJsonOrText(response.body);
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("Composio action schema response did not contain a tools list; mutation_sent=false");
  }
  const exactItems = data.items.filter((item) => isRecord(item) && isRecord(item.toolkit) &&
    typeof item.slug === "string" && item.slug.toLowerCase() === params.tool.toLowerCase() &&
    typeof item.toolkit.slug === "string" && item.toolkit.slug.toLowerCase() === params.toolkit.toLowerCase());
  if (exactItems.length !== 1 || !isRecord(exactItems[0]) || !isRecord(exactItems[0].input_parameters) ||
      !isRecord(exactItems[0].output_parameters) || exactItems[0].is_deprecated !== false) {
    throw new Error("Composio action schema was missing, ambiguous, incomplete, or deprecated; mutation_sent=false");
  }
  return catalogToolProjection(exactItems[0], params.toolkit);
}

async function assertComposioInputSchemaUnchanged(params: {
  toolkit: string;
  tool: string;
  expectedInputSchemaSha256: string;
  expectedActionDefinitionSha256?: string;
  apiBaseUrl: string;
  apiKey: string;
  maxBytes: number;
  request: (target: ComposioSearchTarget, signal?: AbortSignal) => Promise<ComposioExecuteResponse>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(params.expectedInputSchemaSha256)) {
    throw new Error("input_schema_sha256 must be a SHA-256 digest; mutation_sent=false");
  }
  const projection = await readCurrentComposioAction(params);
  if (projection.input_schema_sha256 !== params.expectedInputSchemaSha256) {
    throw new Error("Composio action input schema changed since selection; owner must review the current schema; mutation_sent=false");
  }
  if (params.expectedActionDefinitionSha256 &&
      projection.action_definition_sha256 !== params.expectedActionDefinitionSha256) {
    throw new Error("Composio action definition changed since owner review; mutation_sent=false");
  }
  return projection;
}

interface ComposioLiveActionInspection {
  projection: Record<string, unknown>;
  actionEffectRegistryBinding: ComposioActionEffectRegistryBinding;
  account: ComposioConnectedAccountProjection;
  toolkit: string;
  tool: string;
  connectedAccountId: string;
  userId: string;
  argumentsBody: Record<string, unknown>;
  requestPayloadDigest: string;
  observation: ComposioActionTargetVersionObservation;
}

async function inspectComposioLiveAction(
  args: Record<string, unknown>,
  opts: ComposioOptions,
): Promise<ComposioLiveActionInspection> {
  const env = opts.env ?? process.env;
  if (composioDryRun(env) || !composioLiveExecutionEnabled(env)) {
    throw new Error("Composio live target review is unavailable unless dry-run is disabled and live execution is enabled");
  }
  if (!opts.commandDigest || !/^[a-f0-9]{64}$/.test(opts.commandDigest) ||
      !opts.operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(opts.operationPlanBindingDigest)) {
    throw new Error("Composio review requires an exact HDS command and Operation Plan binding");
  }
  const allowedToolkits = composioAllowedToolkits(env);
  const allowedActions = composioAllowedActions(env);
  const revokedActions = composioRevokedActions(env);
  const toolkit = stringArg(args, "toolkit")!.toLowerCase();
  const tool = stringArg(args, "tool", false) ?? stringArg(args, "action", false) ?? "unknown";
  if (tool === "unknown") throw new Error("tool/action must be supplied for composio.execute review");
  assertToolkitAllowed(toolkit, allowedToolkits);
  assertActionAllowed(toolkit, tool, allowedActions, revokedActions);
  if (!isComposioActionEffectRegistered(toolkit, tool)) {
    throw new Error("Composio action is not registered with reviewed effects; live review is unavailable and no action may execute");
  }
  const apiKey = assertConfigured(env);
  const connectedAccountId = stringArg(args, "connected_account_id", false);
  const userId = envValue(env, "COMPOSIO_USER_ID");
  if (!connectedAccountId || connectedAccountId.toLowerCase() === "instant_account" || !userId) {
    throw new Error("Composio review requires an explicit owner account and configured owner identity");
  }
  if (args.connected_account_id !== undefined && !connectedAccountId) {
    throw new Error("connected_account_id must be a non-empty string");
  }
  const inputSchemaSha256 = stringArg(args, "input_schema_sha256", false);
  if (!inputSchemaSha256 || !/^[a-f0-9]{64}$/.test(inputSchemaSha256)) {
    throw new Error("input_schema_sha256 is required for Composio owner review");
  }
  const expectedRegion = stringArg(args, "expected_provider_region", false)?.toLowerCase();
  if (expectedRegion !== undefined && expectedRegion !== "us" && expectedRegion !== "eu") {
    throw new Error("expected_provider_region must be us or eu");
  }
  if (toolkit !== "posthog" && expectedRegion !== undefined) {
    throw new Error("expected_provider_region is only valid for the PostHog toolkit");
  }
  if (toolkit === "posthog" && expectedRegion === undefined) {
    throw new Error("expected_provider_region=us|eu is required for PostHog owner review");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const apiBaseUrl = composioApiBaseUrl(env);
  const accounts = await readComposioAccounts({
    apiBaseUrl,
    apiKey,
    toolkit,
    userId,
    connectedAccountId,
    limit: 2,
    maxBytes,
    request: opts.accountsRequest ?? defaultComposioAccountsRequest,
    signal: opts.signal,
  });
  const account = accounts.accounts[0];
  if (accounts.accounts.length !== 1 || !account || account.connected_account_id !== connectedAccountId ||
      account.status !== "ACTIVE" || account.is_disabled !== false || account.account_type !== "PRIVATE" ||
      (toolkit === "posthog" && (account.auth_scheme !== "API_KEY" || account.provider_region !== expectedRegion))) {
    throw new Error("Composio account is not the selected active private owner account; review unavailable");
  }
  const projection = await readCurrentComposioAction({
    toolkit,
    tool,
    apiBaseUrl,
    apiKey,
    maxBytes,
    request: opts.searchRequest ?? defaultComposioSearchRequest,
    signal: opts.signal,
  });
  if (projection.input_schema_sha256 !== inputSchemaSha256) {
    throw new Error("Composio action schema differs from the selected input schema; owner review must restart");
  }
  const actionEffectRegistryBinding = resolveComposioActionEffectRegistryBinding({
    toolkit,
    tool: String(projection.slug),
    inputSchemaSha256: String(projection.input_schema_sha256),
    outputSchemaSha256: String(projection.output_schema_sha256),
    actionDefinitionSha256: String(projection.action_definition_sha256),
  });
  if (!actionEffectRegistryBinding) {
    throw new Error("Composio action definition or dynamic schema is not registered with reviewed effects; live review is unavailable");
  }
  const payload = args.payload ?? args.arguments ?? {};
  const argumentsBody = parseComposioArguments(payload);
  const requestPayloadDigest = composioRequestPayloadDigest({ toolkit, tool, connectedAccountId, userId,
    arguments: argumentsBody });
  const observation = ComposioActionTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.composio-action-target-version.v1",
    toolkit,
    tool,
    connected_account_id_sha256: composioIdentityDigest(connectedAccountId),
    user_id_sha256: composioIdentityDigest(userId),
    account_state_sha256: composioSchemaDigest(account),
    input_schema_sha256: projection.input_schema_sha256,
    output_schema_sha256: projection.output_schema_sha256,
    action_definition_sha256: projection.action_definition_sha256,
    action_effect_registry: actionEffectRegistryBinding,
    request_payload_digest: requestPayloadDigest,
    command_digest: opts.commandDigest,
    operation_plan_binding_digest: opts.operationPlanBindingDigest,
    target_state: "available",
    used_for_authority: false,
    may_execute: false,
  });
  return { projection, actionEffectRegistryBinding, account, toolkit, tool, connectedAccountId, userId, argumentsBody,
    requestPayloadDigest, observation };
}

export async function inspectComposioActionTargetVersion(
  args: Record<string, unknown>,
  opts: ComposioOptions,
): Promise<ComposioActionTargetVersionObservation> {
  return (await inspectComposioLiveAction(args, opts)).observation;
}

export async function inspectComposioActionContentReview(
  args: Record<string, unknown>,
  opts: ComposioOptions,
): Promise<ComposioActionContentReview> {
  const inspection = await inspectComposioLiveAction(args, opts);
  const { projection, actionEffectRegistryBinding, account, toolkit, tool, connectedAccountId, userId,
    argumentsBody, requestPayloadDigest, observation } = inspection;
  const reviewComponents = [projection.input_parameters, projection.output_parameters, argumentsBody];
  const reviewComponentBytes = reviewComponents.map((value) => new TextEncoder().encode(canonicalJson(value)).byteLength);
  if (reviewComponentBytes.some((size) => size > 64 * 1024) ||
      reviewComponentBytes.reduce((sum, size) => sum + size, 0) > 160 * 1024) {
    throw new Error("Composio owner review exceeds the bounded no-store projection size");
  }
  const descriptor = requireToolOperationDescriptor("composio.execute");
  const base: Omit<ComposioActionContentReview, "review_digest"> = {
    kind: "composio_execute",
    operation: "composio.execute",
    command_digest: opts.commandDigest!,
    request_payload_digest: requestPayloadDigest,
    target_version_digest: operationPlanDigest(observation),
    target_version_observation: observation,
    operation_plan_binding_digest: opts.operationPlanBindingDigest!,
    toolkit,
    tool,
    action_name: String(projection.name),
    description: String(projection.description ?? ""),
    version: typeof projection.version === "string" ? projection.version : null,
    no_auth: typeof projection.no_auth === "boolean" ? projection.no_auth : null,
    is_deprecated: false,
    scopes: Array.isArray(projection.scopes) ? projection.scopes as string[] : [],
    input_parameters: projection.input_parameters as Record<string, unknown>,
    output_parameters: projection.output_parameters as Record<string, unknown>,
    arguments: argumentsBody,
    input_schema_sha256: String(projection.input_schema_sha256),
    output_schema_sha256: String(projection.output_schema_sha256),
    action_definition_sha256: String(projection.action_definition_sha256),
    action_effect_registry: actionEffectRegistryBinding,
    connected_account_id: connectedAccountId,
    connected_account_id_sha256: composioIdentityDigest(connectedAccountId),
    user_id_sha256: composioIdentityDigest(userId),
    account_type: "PRIVATE",
    account_status: "ACTIVE",
    account_disabled: false,
    auth_scheme: account.auth_scheme,
    provider_region: account.provider_region,
    intent: classifyComposioAction(tool),
    potential_effects: [...descriptor.effects],
    no_store: true,
    used_for_authority: false,
    may_execute: false,
    provider_metadata_used_for_authority: false,
  };
  // The exact argument payload is digest-bound; the owner sees it in the authenticated no-store panel.
  return Object.freeze({ ...base, review_digest: operationPlanDigest({ ...base, arguments: argumentsBody }) });
}

export async function invokeComposioSearch(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const apiKey = assertConfigured(env);
  const allowed = composioAllowedToolkits(env);
  const toolkit = stringArg(args, "toolkit")!.toLowerCase();
  assertToolkitAllowed(toolkit, allowed);
  const query = stringArg(args, "query")!;
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer`);
  }
  const limit = positiveIntArg(args, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const apiBaseUrl = composioApiBaseUrl(env);
  const path = new URL("/api/v3.1/tools", `${apiBaseUrl}/`);
  path.searchParams.set("toolkit_slug", toolkit);
  path.searchParams.set("query", query);
  path.searchParams.set("limit", String(limit));
  path.searchParams.set("toolkit_versions", "latest");
  path.searchParams.set("include_deprecated", "false");
  assertToolExecutionNotCancelled(opts.signal, "composio.search");
  const request = opts.searchRequest ?? defaultComposioSearchRequest;
  const response = await request({
    api_base_url: apiBaseUrl,
    path: `${path.pathname}${path.search}`,
    method: "GET",
    toolkit,
    query,
    limit,
    api_key: apiKey,
    maxBytes,
  }, opts.signal);
  if (!response.ok) throw catalogResponseError(response);
  if (response.truncated) {
    throw new Error("Composio catalog response exceeded the configured limit; catalog_status=not_confirmed");
  }
  const data = parseJsonOrText(response.body);
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("Composio catalog response did not contain a tools list; catalog_status=not_confirmed");
  }
  const tools = data.items.slice(0, limit).map((item) => catalogToolProjection(item, toolkit));
  return {
    provider: "composio",
    operation: "search",
    toolkit,
    query_digest: jsonDigest(query),
    tool_count: tools.length,
    tools,
    external_call_performed: true,
    external_mutation_sent: false,
    api_base_url: apiBaseUrl,
    api_version: COMPOSIO_API_VERSION,
    status: response.status,
    truncated: response.truncated,
    composio_request_id: response.request_id,
    result_digest: jsonDigest(tools),
    permission_granted: false,
    used_for_authority: false,
    metadata_used_for_authority: false,
    next_action:
      "Provider metadata is untrusted and non-authoritative. Only an action with action_effect_registry.status=reviewed may proceed to exact HDS-BRAIN and Approval Gate L3 review; unreviewed actions remain discovery-only.",
  };
}

export async function invokeComposioExecute(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const allowed = composioAllowedToolkits(env);
  const allowedActions = composioAllowedActions(env);
  const revokedActions = composioRevokedActions(env);
  const toolkit = stringArg(args, "toolkit")!;
  assertToolkitAllowed(toolkit, allowed);
  const tool = stringArg(args, "tool", false) ?? stringArg(args, "action", false) ?? "unknown";
  if (tool === "unknown") {
    throw new Error("tool/action must be supplied for composio.execute; external_call_performed=false");
  }
  assertActionAllowed(toolkit, tool, allowedActions, revokedActions);
  const dryRun = composioDryRun(env);
  if (!dryRun && composioLiveExecutionEnabled(env) && !isComposioActionEffectRegistered(toolkit, tool)) {
    throw new Error("Composio action is not registered with reviewed effects; live execution is blocked before provider access");
  }
  const apiKey = assertConfigured(env);
  const intent = classifyComposioAction(tool);
  const suppliedIntent = stringArg(args, "intent", false);
  if (suppliedIntent !== undefined && suppliedIntent !== intent) {
    throw new Error(
      `Composio intent does not match the action classification for ${tool}; external_call_performed=false`,
    );
  }
  const isPostHog = toolkit.toLowerCase() === "posthog";
  const expectedProviderRegionInput = stringArg(args, "expected_provider_region", false);
  const expectedProviderRegion = expectedProviderRegionInput?.toLowerCase();
  if (expectedProviderRegion !== undefined && expectedProviderRegion !== "us" && expectedProviderRegion !== "eu") {
    throw new Error("expected_provider_region must be us or eu; mutation_sent=false");
  }
  if (!isPostHog && expectedProviderRegion !== undefined) {
    throw new Error("expected_provider_region is only valid for the PostHog toolkit; mutation_sent=false");
  }
  const connectedAccountId = stringArg(args, "connected_account_id", false);
  if (args.connected_account_id !== undefined && !connectedAccountId) {
    throw new Error("connected_account_id must be a non-empty string; external_call_performed=false");
  }
  if (connectedAccountId?.toLowerCase() === "instant_account") {
    throw new Error("connected_account_id must identify an explicit owner connection; external_call_performed=false");
  }
  const userId = envValue(env, "COMPOSIO_USER_ID");
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const payload = args.payload ?? args.arguments ?? {};
  const argumentsBody = parseComposioArguments(payload);
  const base = {
    provider: "composio",
    operation: "execute",
    toolkit: toolkit.toLowerCase(),
    tool,
    intent,
    dry_run: dryRun,
    live_execution_enabled: composioLiveExecutionEnabled(env),
    approval_required: true,
    approval_boundary: "HDS-BRAIN Approval Gate",
    capability_boundary: "tool:composio.execute",
    toolkit_allowlist_boundary: "COMPOSIO_ALLOWED_TOOLKITS",
    action_allowlist_boundary: "COMPOSIO_ALLOWED_ACTIONS",
    revoke_boundary: "COMPOSIO_REVOKED_ACTIONS",
    account_selection_boundary: "explicit PRIVATE account owned by COMPOSIO_USER_ID and matching toolkit",
    ...(isPostHog ? { expected_provider_region: expectedProviderRegion ?? null } : {}),
    connected_account_id: connectedAccountId ?? null,
    audit_required: true,
    used_for_authority: false,
    metadata_used_for_authority: false,
    live_execution_used_for_authority: false,
    payload_digest: jsonDigest(argumentsBody),
  };
  if (dryRun) {
    return {
      ...base,
      executed: false,
      external_mutation_sent: false,
      external_call_performed: false,
      next_action:
        "Inspect the dry-run result, then disable dry-run and enable live execution only after owner approval.",
    };
  }
  if (!composioLiveExecutionEnabled(env)) {
    throw new Error(
      "COMPOSIO_LIVE_EXECUTION=true is required for Composio live execution; mutation_sent=false",
    );
  }
  if (!userId) {
    throw new Error(
      "COMPOSIO_USER_ID is required for Composio live execution; mutation_sent=false",
    );
  }
  if (!connectedAccountId) {
    throw new Error(
      "connected_account_id is required for Composio live execution; mutation_sent=false",
    );
  }
  if (isPostHog && expectedProviderRegion === undefined) {
    throw new Error(
      "expected_provider_region=us|eu is required for PostHog live execution; mutation_sent=false",
    );
  }
  const inputSchemaSha256 = stringArg(args, "input_schema_sha256", false);
  if (!inputSchemaSha256 || !/^[a-f0-9]{64}$/.test(inputSchemaSha256)) {
    throw new Error("input_schema_sha256 is required for live execution; mutation_sent=false");
  }
  const apiBaseUrl = composioApiBaseUrl(env);
  const request = opts.request ?? defaultComposioExecuteRequest;
  const plannedObservation = opts.targetVersionObservation;
  if (!opts.requireTargetVersionObservation || !plannedObservation) {
    throw new Error("Composio live execution requires a target observation from the registered HDS Executor; mutation_sent=false");
  }
  const plannedEffectRegistryBindingSha256 = plannedObservation?.action_effect_registry.binding_sha256;
  const parsedObservation = ComposioActionTargetVersionObservationSchema.safeParse(plannedObservation);
  if (!parsedObservation.success || !opts.commandDigest ||
      parsedObservation.data.command_digest !== opts.commandDigest ||
      parsedObservation.data.toolkit !== toolkit || parsedObservation.data.tool !== tool ||
      parsedObservation.data.connected_account_id_sha256 !== composioIdentityDigest(connectedAccountId) ||
      parsedObservation.data.user_id_sha256 !== composioIdentityDigest(userId) ||
      parsedObservation.data.input_schema_sha256 !== inputSchemaSha256 ||
      parsedObservation.data.request_payload_digest !== composioRequestPayloadDigest({ toolkit, tool,
        connectedAccountId, userId, arguments: argumentsBody })) {
    throw new Error("Composio live execution requires target evidence bound to this exact HDS request and owner account; mutation_sent=false");
  }
  if (!plannedEffectRegistryBindingSha256) {
    throw new Error("Composio live execution requires reviewed action effect registry evidence; mutation_sent=false");
  }
  const accounts = await readComposioAccounts({
    apiBaseUrl,
    apiKey,
    toolkit,
    userId,
    connectedAccountId,
    limit: 2,
    maxBytes,
    request: opts.accountsRequest ?? defaultComposioAccountsRequest,
    signal: opts.signal,
  });
  const selectedAccount = accounts.accounts[0];
  if (
    accounts.accounts.length !== 1 ||
    !selectedAccount ||
    selectedAccount.connected_account_id !== connectedAccountId ||
    selectedAccount.status !== "ACTIVE" ||
    selectedAccount.is_disabled !== false ||
    selectedAccount.account_type !== "PRIVATE" ||
    (isPostHog && (
      selectedAccount.auth_scheme !== "API_KEY" ||
      selectedAccount.provider_region !== expectedProviderRegion
    ))
  ) {
    throw new Error(
      "Composio connected account is missing, not PRIVATE ACTIVE, disabled, outside the configured owner/toolkit, or has unknown/mismatched PostHog auth scheme or region; mutation_sent=false",
    );
  }
  if (composioSchemaDigest(selectedAccount) !== parsedObservation.data.account_state_sha256) {
    throw new Error("Composio connected account changed after owner review; mutation_sent=false");
  }
  const currentAction = await assertComposioInputSchemaUnchanged({
    toolkit,
    tool,
    expectedInputSchemaSha256: inputSchemaSha256,
    ...(opts.requireTargetVersionObservation && plannedObservation
      ? { expectedActionDefinitionSha256: plannedObservation.action_definition_sha256 } : {}),
    apiBaseUrl,
    apiKey,
    maxBytes,
    request: opts.searchRequest ?? defaultComposioSearchRequest,
    signal: opts.signal,
  });
  if (opts.requireTargetVersionObservation && plannedObservation &&
      currentAction.action_definition_sha256 !== plannedObservation.action_definition_sha256) {
    throw new Error("Composio action definition changed after the owner review; mutation_sent=false");
  }
  const actionEffectRegistryBinding = resolveComposioActionEffectRegistryBinding({
    toolkit,
    tool: String(currentAction.slug),
    inputSchemaSha256: String(currentAction.input_schema_sha256),
    outputSchemaSha256: String(currentAction.output_schema_sha256),
    actionDefinitionSha256: String(currentAction.action_definition_sha256),
  });
  if (!actionEffectRegistryBinding || actionEffectRegistryBinding.binding_sha256 !== plannedEffectRegistryBindingSha256 ||
      operationPlanDigest(actionEffectRegistryBinding) !== operationPlanDigest(plannedObservation.action_effect_registry)) {
    throw new Error("Composio action schema/effects registry binding changed after owner review; mutation_sent=false");
  }
  assertToolExecutionNotCancelled(opts.signal, "composio.execute");
  const response = await request({
    api_base_url: apiBaseUrl,
    path: `/api/${COMPOSIO_API_VERSION}/tools/execute/${encodeURIComponent(tool)}`,
    method: "POST",
    tool,
    toolkit: toolkit.toLowerCase(),
    user_id: userId,
    body: {
      user_id: userId,
      connected_account_id: connectedAccountId,
      arguments: argumentsBody,
    },
    api_key: apiKey,
    maxBytes,
  }, opts.signal);
  const data = parseJsonOrText(response.body);
  if (!response.ok) throw composioResponseError(tool, response);
  return {
    ...base,
    executed: true,
    external_call_performed: true,
    external_mutation_sent: intent !== "read",
    mutation_status: "confirmed",
    api_base_url: apiBaseUrl,
    api_version: COMPOSIO_API_VERSION,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    composio_request_id: response.request_id,
    response_digest: jsonDigest(data),
    result_digest: jsonDigest(data),
    ...(isPostHog ? {
      provider_region: selectedAccount.provider_region,
      provider_auth_scheme: selectedAccount.auth_scheme,
      connection_context_used_for_authority: false,
    } : {}),
    result: data,
  };
}

export const composioSearchTool: Tool = {
  name: "composio.search",
  adapter_version: "1.0.0-rc.1",
  description:
    "Searches Composio toolkit/action metadata under an explicit allowlist and returns canonical schema digests plus the reviewed action-effect registry status. Unreviewed actions are discovery-only; metadata never grants authority.",
  required_capabilities: requireToolOperationDescriptor("composio.search").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeComposioSearch(args, {
      env: composioToolEnvironment(process.env, context.composio_api_key), signal: context.signal,
    });
  },
};

export const composioAccountsTool: Tool = {
  name: "composio.accounts",
  adapter_version: "1.0.0-rc.1",
  description:
    "Lists bounded Composio account projections for the configured owner and an explicitly allowed toolkit. Account metadata is never authority.",
  required_capabilities: requireToolOperationDescriptor("composio.accounts").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeComposioAccounts(args, {
      env: composioToolEnvironment(process.env, context.composio_api_key), signal: context.signal,
    });
  },
};

export const composioScopesTool: Tool = {
  name: "composio.scopes",
  adapter_version: "1.0.0-rc.1",
  description:
    "Returns a bounded, experimental least-privilege scope recommendation for explicitly allowed Composio actions. It does not observe granted scopes or grant authority.",
  required_capabilities: requireToolOperationDescriptor("composio.scopes").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeComposioScopes(args, {
      env: composioToolEnvironment(process.env, context.composio_api_key), signal: context.signal,
    });
  },
};

export const composioExecuteTool: Tool = {
  name: "composio.execute",
  adapter_version: "1.0.0-rc.1",
  description:
    "Executes only actions with an exact reviewed action-effect registry entry through HDS-BRAIN L3 review, explicit toolkit/action allowlists, live opt-in, capability, and audit boundaries. The authenticated no-store review binds the exact account, provider schema, registry mapping, payload, and Operation Plan; current action definition and registry binding are rechecked immediately before dispatch. PostHog also requires an explicit expected_provider_region matching the observed owner account.",
  required_capabilities: requireToolOperationDescriptor("composio.execute").required_capabilities,
  async inspect_target_version(args, inspectOptions) {
    if (!inspectOptions?.command_digest || !inspectOptions.operation_plan_binding_digest) {
      throw new Error("Composio live action inspection requires an HDS command and Operation Plan binding");
    }
    return await inspectComposioActionTargetVersion(args, {
      env: composioToolEnvironment(inspectOptions.env ?? process.env),
      ...(inspectOptions.signal ? { signal: inspectOptions.signal } : {}),
      commandDigest: inspectOptions.command_digest,
      operationPlanBindingDigest: inspectOptions.operation_plan_binding_digest,
    });
  },
  async inspect_content_review(args, reviewOptions) {
    if (!reviewOptions?.command_digest || !reviewOptions.operation_plan_binding_digest) {
      throw new Error("Composio owner review requires an HDS command and Operation Plan binding");
    }
    return await inspectComposioActionContentReview(args, {
      env: composioToolEnvironment(reviewOptions.env ?? process.env),
      ...(reviewOptions.signal ? { signal: reviewOptions.signal } : {}),
      commandDigest: reviewOptions.command_digest,
      operationPlanBindingDigest: reviewOptions.operation_plan_binding_digest,
    });
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const observation = context.target_version_observation === undefined
      ? undefined : ComposioActionTargetVersionObservationSchema.parse(context.target_version_observation);
    return await invokeComposioExecute(args, {
      env: composioToolEnvironment(process.env, context.composio_api_key),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.operation_plan_command_digest ? { commandDigest: context.operation_plan_command_digest } : {}),
      ...(observation ? { targetVersionObservation: observation } : {}),
      requireTargetVersionObservation: true,
    });
  },
};
