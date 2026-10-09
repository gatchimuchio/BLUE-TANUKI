import { z } from "zod";
import { GoalCriteriaSchema } from "./goal_criteria.js";

import { OperationCoreExecutorTraceSchema, type OperationInterface } from "./operation_core.js";

const DangerousObjectKeySchema = z.string().refine(
  (key) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
  "dangerous object key is not allowed",
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type MetadataObject = Record<string, JsonValue | undefined>;

const GATEWAY_INTERNAL_AUTHORITY_BRAND: unique symbol = Symbol("blue_tanuki.gateway_internal_authority.v1");

export const RESERVED_EXTERNAL_METADATA_KEYS = [
  "blue_tanuki.authority_context",
  "blue_tanuki.actor_kind",
  "blue_tanuki.trust_level",
  "blue_tanuki.process_kind",
  "blue_tanuki.operator_surface",
  "blue_tanuki.operation_core",
  "blue_tanuki.channel_send",
  "actor_kind",
  "trust_level",
  "process_kind",
] as const;

const RESERVED_EXTERNAL_METADATA_KEY_SET = new Set<string>(RESERVED_EXTERNAL_METADATA_KEYS);

export interface GatewayInternalAuthorityMetadata extends MetadataObject {
  "blue_tanuki.authority_context": "gateway_internal_v1";
  "blue_tanuki.actor_kind"?: "owner" | "user" | "system" | "webhook" | "cron";
  "blue_tanuki.trust_level"?: "owner" | "trusted" | "limited" | "untrusted";
  "blue_tanuki.process_kind"?: "chat" | "tool" | "approval" | "cron" | "webhook" | "system";
  "blue_tanuki.operator_surface"?: "writing" | "daily" | "developer";
  "blue_tanuki.operation_core.version"?: "operation-core.v1";
  "blue_tanuki.operation_core.request_id"?: string;
  "blue_tanuki.operation_core.projection_id"?: string;
  "blue_tanuki.operation_core.source_interface"?: OperationInterface;
  "blue_tanuki.operation_core.used_for_authority"?: false;
  "blue_tanuki.operation_core.planner_output_used_for_authority"?: false;
  "blue_tanuki.operation_core.ui_projection_used_for_authority"?: false;
  "blue_tanuki.channel_send.channel"?: string;
  "blue_tanuki.channel_send.target"?: string;
  "blue_tanuki.channel_send.content"?: string;
}

export interface GatewayInternalInboundRequestInput extends Omit<InboundRequest, "metadata"> {
  metadata: GatewayInternalAuthorityMetadata;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(DangerousObjectKeySchema, JsonValueSchema.optional()),
  ]),
);

/**
 * Decision values returned by HDS-BRAIN's commit phase.
 * - ASSERT       : Execute. Pass command to BLUE-TANUKI.
 * - SUSPEND      : Hold. Wait for resolution (human/external signal).
 * - OUT_OF_SCOPE : Outside protected scope. No action.
 * - FAIL         : Reject. Audit-only.
 */
export const DecisionSchema = z.enum([
  "ASSERT",
  "SUSPEND",
  "OUT_OF_SCOPE",
  "FAIL",
]);
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * The upstream (HDS-BRAIN) decision attached to every command sent downstream.
 * Used for audit traceability — every executor action carries the F→M→C trace.
 */
export const UpstreamDecisionSchema = z.object({
  frame_goal: z.string(),
  model_abstraction: z.string(),
  commit_hash: z.string(),
  commit_decision: DecisionSchema,
});
export type UpstreamDecision = z.infer<typeof UpstreamDecisionSchema>;

/**
 * LLM call payload (one of the executor's primary command types).
 */
export const LLMFallbackAuthorizationSchema = z.object({
  allowed_providers: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
  allowed_input_sources: z.array(z.enum([
    "accepted_inbound_request",
    "selected_memory_references",
    "session_history",
  ])).min(1).max(3),
  required_capabilities: z.array(z.string().trim().min(1).max(120)).min(1).max(16),
  max_total_cost: z.object({
    amount: z.number().finite().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
}).strict().superRefine((value, context) => {
  const providers = value.allowed_providers.map((provider) => provider.toLowerCase());
  if (new Set(providers).size !== providers.length) {
    context.addIssue({ code: "custom", message: "fallback providers must be unique" });
  }
  if (new Set(value.allowed_input_sources).size !== value.allowed_input_sources.length) {
    context.addIssue({ code: "custom", message: "fallback input sources must be unique" });
  }
  if (new Set(value.required_capabilities).size !== value.required_capabilities.length) {
    context.addIssue({ code: "custom", message: "fallback capabilities must be unique" });
  }
});
export type LLMFallbackAuthorization = z.infer<typeof LLMFallbackAuthorizationSchema>;

export const LLMComputeContextSchema = z.object({
  schema_version: z.literal("blue-tanuki.compute-context.v1"),
  projection_digest: z.string().regex(/^[a-f0-9]{64}$/),
  local_p_version: z.string().trim().min(1).max(120),
  data_exposure: z.object({
    input_sources: z.array(z.enum([
      "accepted_inbound_request",
      "selected_memory_references",
    ])).min(1).max(2),
    requested_egress_provider: z.string().trim().min(1).max(120),
  }).strict(),
  /** HDS-issued constraints for an alternate provider; absent means no fallback authorization. */
  fallback_authorization: LLMFallbackAuthorizationSchema.optional(),
}).strict();
export type LLMComputeContext = z.infer<typeof LLMComputeContextSchema>;

export const LLMCallPayloadSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
  /**
   * Optional downstream provider selector. This is a routing hint, not an
   * authority signal: HDS-BRAIN still owns the ASSERT/SUSPEND/FAIL decision,
   * and the executor resolves the hint against its configured registry.
   */
  backend_hint: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Non-authority binding for the current HDS projection and requested data route. */
  compute_context: LLMComputeContextSchema.optional(),
  /**
   * Optional session identifier. When set, the executor's SessionStore
   * (if configured) will (a) prepend retained history before calling the
   * LLM, and (b) append the current user message and the assistant's
   * reply on success. When unset, history is not consulted nor written.
   *
   * Convention used by the gateway: `${channel}:${user}` (e.g.
   * `slack:U12345`, `webchat:bob`). The executor treats it opaquely.
   */
  session_id: z.string().optional(),
});
export type LLMCallPayload = z.infer<typeof LLMCallPayloadSchema>;

/**
 * Tool call payload.
 */
export const ToolCallPayloadSchema = z.object({
  tool_name: z.string(),
  arguments: z.record(z.unknown()),
});
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

/**
 * Channel send payload (e.g. reply on Slack/Discord/WebChat).
 */
export const ChannelSendPayloadSchema = z.object({
  channel: z.string(),
  target: z.string(),
  content: z.string(),
});
export type ChannelSendPayload = z.infer<typeof ChannelSendPayloadSchema>;

/**
 * Runtime capability strings enforced by the executor.
 *
 * Capability names are intentionally free-form but non-empty. Built-in
 * conventions include:
 *   - tool:<name>
 *   - fs:read
 *   - fs:write
 *   - network:http
 *   - network:<host>
 *   - shell:probe
 *   - shell:exec
 *   - channel:send
 */
export const ToolCapabilitySchema = z.string().min(1);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * Constraints attached to a command. Set by upstream, enforced by executor.
 */
export const CommandConstraintsSchema = z.object({
  max_tokens: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  allowed_capabilities: z.array(ToolCapabilitySchema).optional(),
});
export type CommandConstraints = z.infer<typeof CommandConstraintsSchema>;

/**
 * Discriminated union of all command shapes.
 * BLUE-TANUKI executor switches on `type`.
 */
export const ExecuteCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("llm_call"),
    payload: LLMCallPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("tool_call"),
    payload: ToolCallPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("channel_send"),
    payload: ChannelSendPayloadSchema,
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("noop"),
    payload: z.object({}).passthrough(),
    constraints: CommandConstraintsSchema.optional(),
    upstream_decision: UpstreamDecisionSchema,
  }),
]);
export type ExecuteCommand = z.infer<typeof ExecuteCommandSchema>;

/**
 * Feedback from BLUE-TANUKI executor back to HDS-BRAIN.
 * Used by HDS-BRAIN to update its state machine.
 */
export const LLMCallFailureSchema = z.object({
  schema_version: z.literal("blue-tanuki.llm-failure.v1"),
  kind: z.enum([
    "rate_limited",
    "temporary_network",
    "disconnected",
    "remote_service_unavailable",
    "auth",
    "bad_request",
    "bad_response",
    "timeout",
    "cancelled",
    "partial_response",
    "invalid_structured_output",
    "unknown",
  ]),
  retryable: z.boolean(),
  provider: z.string().min(1).max(128).optional(),
  status: z.number().int().min(100).max(599).optional(),
  retry_after_ms: z.number().int().min(0).max(604_800_000).optional(),
  authority_boundary: z.object({
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();
export type LLMCallFailure = z.infer<typeof LLMCallFailureSchema>;
export type LLMCallFailureKind = LLMCallFailure["kind"];

/**
 * Untrusted provider tool output. It is returned for J review and is never an
 * executable command or permission grant by itself.
 */
export const LLMToolCallCandidateSchema = z.object({
  schema_version: z.literal("blue-tanuki.llm-tool-call-candidate.v1"),
  call_id: z.string().min(1).max(200),
  tool_name: z.string().min(1).max(200),
  arguments: z.record(z.unknown()),
  authority_boundary: z.object({
    candidate_only: z.literal(true),
    may_execute: z.literal(false),
    used_for_authority: z.literal(false),
  }).strict(),
}).strict();
export type LLMToolCallCandidate = z.infer<typeof LLMToolCallCandidateSchema>;

export const ExecuteFeedbackSchema = z.object({
  command_id: z.string(),
  status: z.enum(["success", "failed", "suspended"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  llm_failure: LLMCallFailureSchema.optional(),
  llm_tool_candidates: z.array(LLMToolCallCandidateSchema).max(32).optional(),
  metrics: z.object({
    duration_ms: z.number(),
    tokens_used: z.number().optional(),
    tool_calls: z.number().optional(),
  }),
  operation_core: OperationCoreExecutorTraceSchema.optional(),
});
export type ExecuteFeedback = z.infer<typeof ExecuteFeedbackSchema>;

/**
 * Inbound request that reaches HDS-BRAIN. Channel-agnostic.
 * BLUE-TANUKI's channel adapters normalize raw channel events into this shape.
 */
export const InboundRequestSchema = z.object({
  id: z.string().min(1).max(200),
  channel: z.string().min(1).max(80),
  user: z.string().min(1).max(200),
  content: z.string().max(200_000),
  timestamp: z.number().finite().nonnegative(),
  goal_criteria: GoalCriteriaSchema.optional(),
  metadata: z.record(DangerousObjectKeySchema, JsonValueSchema.optional()).optional(),
}).strict();
export type InboundRequest = z.infer<typeof InboundRequestSchema>;

export type InboundRequestBoundaryFailureReason =
  | "schema_validation_failed"
  | "canonicalization_failed";

export interface InboundRequestBoundaryFailure {
  ok: false;
  reason: InboundRequestBoundaryFailureReason;
  issues: string[];
}

export interface InboundRequestBoundarySuccess {
  ok: true;
  request: InboundRequest;
}

export type InboundRequestBoundaryResult =
  | InboundRequestBoundarySuccess
  | InboundRequestBoundaryFailure;

export function parseInboundRequestAtBoundary(raw: unknown): InboundRequestBoundaryResult {
  const parsed = InboundRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_validation_failed",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    };
  }
  try {
    return {
      ok: true,
      request: normalizeInboundRequestForAuthority(parsed.data, {
        internal_authority_metadata: isGatewayInternalInboundRequest(raw),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "canonicalization_failed",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function normalizeInboundRequestForAuthority(
  request: InboundRequest,
  opts: { internal_authority_metadata?: boolean } = {},
): InboundRequest {
  const metadata = request.metadata
    ? canonicalJsonObject(request.metadata, {
        stripReservedAuthorityMetadata: opts.internal_authority_metadata !== true,
      })
    : undefined;
  const normalized: InboundRequest = {
    id: normalizeScalar(request.id, "id"),
    channel: normalizeScalar(request.channel, "channel"),
    user: normalizeScalar(request.user, "user"),
    content: request.content.normalize("NFKC"),
    timestamp: request.timestamp,
    ...(request.goal_criteria ? { goal_criteria: GoalCriteriaSchema.parse(request.goal_criteria) } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  return opts.internal_authority_metadata === true
    ? markGatewayInternalInboundRequest(normalized)
    : normalized;
}

export function createGatewayInternalInboundRequest(
  request: GatewayInternalInboundRequestInput,
): InboundRequest {
  return normalizeInboundRequestForAuthority(request, {
    internal_authority_metadata: true,
  });
}

export function isGatewayInternalInboundRequest(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { [GATEWAY_INTERNAL_AUTHORITY_BRAND]?: unknown })[GATEWAY_INTERNAL_AUTHORITY_BRAND] === true,
  );
}

export function metadataKeyReservedForInternalAuthority(key: string): boolean {
  const normalized = key.normalize("NFKC").trim();
  return (
    RESERVED_EXTERNAL_METADATA_KEY_SET.has(normalized) ||
    normalized.startsWith("blue_tanuki.operation_core.") ||
    normalized.startsWith("blue_tanuki.channel_send.")
  );
}

function normalizeScalar(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new Error(`${field} normalized to empty string`);
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`${field} contains path-like traversal characters`);
  }
  return normalized;
}

function canonicalJsonObject(
  value: MetadataObject,
  opts: { stripReservedAuthorityMetadata: boolean },
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (item === undefined) continue;
    const normalizedKey = normalizeMetadataKey(key);
    if (opts.stripReservedAuthorityMetadata && metadataKeyReservedForInternalAuthority(normalizedKey)) {
      continue;
    }
    out[normalizedKey] = canonicalJsonValue(item, opts);
  }
  return out;
}

function canonicalJsonValue(value: JsonValue, opts: { stripReservedAuthorityMetadata: boolean }): JsonValue {
  if (typeof value === "string") return value.normalize("NFKC");
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, opts));
  if (value && typeof value === "object") return canonicalJsonObject(value, opts);
  return value;
}

function normalizeMetadataKey(key: string): string {
  const normalized = key.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new Error("metadata key normalized to empty string");
  }
  if (normalized === "__proto__" || normalized === "prototype" || normalized === "constructor") {
    throw new Error(`metadata key is not allowed: ${normalized}`);
  }
  return normalized;
}

function markGatewayInternalInboundRequest(request: InboundRequest): InboundRequest {
  Object.defineProperty(request, GATEWAY_INTERNAL_AUTHORITY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return request;
}
