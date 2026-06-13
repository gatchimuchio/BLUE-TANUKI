import { createHash } from "node:crypto";
import * as https from "node:https";
import type { Tool } from "./registry.js";

type Env = Record<string, string | undefined>;

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
  connection_revoke_available: boolean;
  toolkit_count: number;
  action_scope_count: number;
  revoked_action_count: number;
  live_execution_available: boolean;
  used_for_authority: false;
  metadata_used_for_authority: false;
  live_execution_used_for_authority: false;
}

export interface ComposioExecuteTarget {
  api_base_url: string;
  path: string;
  tool: string;
  toolkit: string;
  user_id: string;
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
  request?: (target: ComposioExecuteTarget) => Promise<ComposioExecuteResponse>;
}

const DEFAULT_DRY_RUN = true;
const DEFAULT_API_BASE_URL = "https://backend.composio.dev";
const COMPOSIO_API_VERSION = "v3.1";
const COMPOSIO_EXECUTE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 128_000;
const MAX_MAX_BYTES = 512_000;

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
    live_execution_available:
      configured &&
      !dryRun &&
      liveExecutionEnabled &&
      userIdSet &&
      allowedToolkits.length > 0 &&
      allowedActions.length > 0,
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
  if (revoked.some((item) => keys.includes(item.toLowerCase()))) {
    throw new Error(`Composio action revoked: ${toolkit}:${tool}; external_call_performed=false`);
  }
  if (allowed.length === 0) {
    throw new Error(
      "COMPOSIO_ALLOWED_ACTIONS must explicitly allow a toolkit action before Composio live execution",
    );
  }
  if (!allowed.some((item) => keys.includes(item.toLowerCase()))) {
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

function parseComposioArguments(value: unknown): Record<string, unknown> {
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

async function defaultComposioExecuteRequest(
  target: ComposioExecuteTarget,
): Promise<ComposioExecuteResponse> {
  const endpoint = new URL(target.path, `${target.api_base_url}/`);
  return await new Promise((resolve, reject) => {
    const requestBody = Buffer.from(JSON.stringify(target.body), "utf8");
    let finished = false;
    const finish = (result: ComposioExecuteResponse): void => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const req = https.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": String(requestBody.length),
          "User-Agent": "BLUE-TANUKI/1.0 composio.execute",
          "x-api-key": target.api_key,
        },
        timeout: COMPOSIO_EXECUTE_TIMEOUT_MS,
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
      req.destroy(
        new Error(
          `composio.execute timed out after ${COMPOSIO_EXECUTE_TIMEOUT_MS}ms; mutation_status=not_confirmed`,
        ),
      );
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    req.write(requestBody);
    req.end();
  });
}

export async function invokeComposioSearch(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  assertConfigured(env);
  const allowed = composioAllowedToolkits(env);
  const toolkit = stringArg(args, "toolkit", false);
  if (toolkit) assertToolkitAllowed(toolkit, allowed);
  const query = stringArg(args, "query", false) ?? "";
  const allowedActions = composioAllowedActions(env);
  return {
    provider: "composio",
    operation: "search",
    toolkit: toolkit ?? null,
    query_digest: query ? jsonDigest(query) : null,
    allowed_toolkits: allowed,
    allowed_actions_count: allowedActions.length,
    external_call_performed: false,
    dry_run: true,
    permission_granted: false,
    used_for_authority: false,
    metadata_used_for_authority: false,
    next_action:
      "Use composio.execute through HDS-BRAIN and Approval Gate; search metadata cannot grant permission.",
  };
}

export async function invokeComposioExecute(
  args: Record<string, unknown>,
  opts: ComposioOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const apiKey = assertConfigured(env);
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
  const intent = classifyComposioAction(
    stringArg(args, "intent", false) ?? tool,
  );
  const dryRun = composioDryRun(env);
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
  const apiBaseUrl = composioApiBaseUrl(env);
  const request = opts.request ?? defaultComposioExecuteRequest;
  const response = await request({
    api_base_url: apiBaseUrl,
    path: `/api/${COMPOSIO_API_VERSION}/tools/execute/${encodeURIComponent(tool)}`,
    tool,
    toolkit: toolkit.toLowerCase(),
    user_id: userId,
    body: {
      user_id: userId,
      arguments: argumentsBody,
    },
    api_key: apiKey,
    maxBytes,
  });
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
    result: data,
  };
}

export const composioSearchTool: Tool = {
  name: "composio.search",
  description:
    "Searches Composio toolkit/tool metadata under an explicit allowlist. Metadata is never authority.",
  required_capabilities: [
    "tool:composio.search",
    "network:composio.dev",
    "secrets:COMPOSIO_API_KEY",
  ],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeComposioSearch(args);
  },
};

export const composioExecuteTool: Tool = {
  name: "composio.execute",
  description:
    "Executes Composio external tools only after explicit toolkit/action allowlists, live opt-in, capability, approval, and audit boundaries.",
  required_capabilities: [
    "tool:composio.execute",
    "network:composio.dev",
    "secrets:COMPOSIO_API_KEY",
    "external:send",
  ],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeComposioExecute(args);
  },
};
