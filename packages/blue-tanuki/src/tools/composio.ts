import { createHash } from "node:crypto";
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
  allowed_toolkits: string[];
  live_execution_available: false;
  used_for_authority: false;
  metadata_used_for_authority: false;
}

export interface ComposioOptions {
  env?: Env;
}

const DEFAULT_DRY_RUN = true;

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
    .map((item) => item.trim().toLowerCase())
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
  return splitList(envValue(env, "COMPOSIO_ALLOWED_TOOLKITS"));
}

export function composioDryRun(env: Env = process.env): boolean {
  return boolEnv(envValue(env, "COMPOSIO_DRY_RUN"), DEFAULT_DRY_RUN);
}

export function composioStatus(env: Env = process.env): ComposioConnectorStatus {
  return {
    configured: Boolean(envValue(env, "COMPOSIO_API_KEY")),
    dry_run: composioDryRun(env),
    allowed_toolkits: composioAllowedToolkits(env),
    live_execution_available: false,
    used_for_authority: false,
    metadata_used_for_authority: false,
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

export function classifyComposioAction(value: string | undefined): ComposioActionIntent {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (/(delete|remove|destroy|revoke|purge)/.test(raw)) return "delete";
  if (/(send|post|publish|reply|invite|upload|share)/.test(raw)) return "send";
  if (/(create|update|write|patch|edit|draft|move|copy)/.test(raw)) return "write";
  if (/(read|get|list|search|find|lookup|fetch|metadata)/.test(raw)) return "read";
  return "unknown";
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
  return {
    provider: "composio",
    operation: "search",
    toolkit: toolkit ?? null,
    query_digest: query ? jsonDigest(query) : null,
    allowed_toolkits: allowed,
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
  assertConfigured(env);
  const allowed = composioAllowedToolkits(env);
  const toolkit = stringArg(args, "toolkit")!;
  assertToolkitAllowed(toolkit, allowed);
  const tool = stringArg(args, "tool", false) ?? stringArg(args, "action", false) ?? "unknown";
  const intent = classifyComposioAction(
    stringArg(args, "intent", false) ?? tool,
  );
  const dryRun = composioDryRun(env);
  const payload = args.payload ?? args.arguments ?? {};
  const base = {
    provider: "composio",
    operation: "execute",
    toolkit: toolkit.toLowerCase(),
    tool,
    intent,
    dry_run: dryRun,
    approval_required: true,
    approval_boundary: "HDS-BRAIN Approval Gate",
    capability_boundary: "tool:composio.execute",
    audit_required: true,
    used_for_authority: false,
    metadata_used_for_authority: false,
    payload_digest: jsonDigest(payload),
  };
  if (dryRun) {
    return {
      ...base,
      executed: false,
      external_mutation_sent: false,
      next_action:
        "Inspect the dry-run result and request owner approval before any live connector phase.",
    };
  }
  throw new Error(
    "Composio live execution is not implemented in this phase; mutation_sent=false; set COMPOSIO_DRY_RUN=true",
  );
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
    "Dry-run Composio external tool execution under allowlist, capability, approval, and audit boundaries.",
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
