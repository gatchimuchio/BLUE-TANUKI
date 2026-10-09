import {
  OperationRequestSchema,
  isGatewayInternalInboundRequest,
  type InboundRequest,
  type OperationInterface,
  type OperationTarget,
} from "@blue-tanuki/protocol";
import type {
  ActorRef,
  FrameResult,
  HDSProcessDefinition,
  MemoryTrace,
  OperationCoreFrameRef,
  OperatorSurfaceRef,
  PolicyConfig,
} from "./types.js";
import { resolveActor, resolveProcess } from "./process.js";
import { buildMemoryTrace, type MemoryReaderPort } from "./memory_trace.js";
import {
  createUnidentifiedGoalProjection,
  type GoalProjectionSourceKind,
} from "./goal_projection.js";

/**
 * Optional frame configuration: lets the gateway decide which policy
 * to attach to a request, e.g. by channel, user, or content prefix.
 *
 * If no resolver is provided, all requests map to the policy's
 * problem_definition_id (single-policy mode).
 */
export interface FrameConfig {
  default_policy: PolicyConfig;
  resolve?: (req: InboundRequest) => string | undefined;
  /**
   * Upstream-owned deterministic memory reader. HDS-BRAIN may attach memory
   * hits to the audit frame, but the current release never lets those hits expand authority.
   */
  memory_reader?: MemoryReaderPort;
  /** Override actor/process resolution for tests or higher-level gateway policy. */
  actor?: ActorRef;
  process?: HDSProcessDefinition;
  /** Raw accepted content is hashed for the immutable reference and is not copied into the projection. */
  original_content?: string;
  original_reference_kind?: GoalProjectionSourceKind;
  /**
   * Override protected_values per request, if needed.
   * Falls back to a conservative default.
   */
  protected_values?: string[];
}

const DEFAULT_PROTECTED_VALUES = [
  "user_safety",
  "audit_traceability",
  "no_irreversible_action",
  "authority_non_bypass",
];

/**
 * F (Frame) phase.
 *
 * Responsibilities:
 *   - Resolve actor/process before any downstream action.
 *   - Attach deterministic memory hits as traceable context, not authority.
 *   - Extract goal (truncated content as a stand-in for richer NLP later).
 *   - Attach protected_values from config.
 *   - Construct world closure W=(X,R,M).
 *   - Resolve which problem_definition_id this request maps to.
 *
 * This layer never calls an LLM. Goal "extraction" is structural truncation;
 * memory retrieval is exact/tag/recent only and is explicitly non-authority.
 */
export function frame(req: InboundRequest, config?: FrameConfig): FrameResult {
  const actor = config?.actor ?? resolveActor(req);
  const process = config?.process ?? resolveProcess(req, actor);
  const memory_trace: MemoryTrace = buildMemoryTrace(req, process, config?.memory_reader);
  const operator_surface = resolveOperatorSurface(req);
  const operation_core = resolveOperationCore(req, operator_surface);
  const problem_definition_id =
    config?.resolve?.(req) ?? config?.default_policy.problem_definition_id ?? "default_v1";

  return {
    actor,
    process,
    memory_trace,
    ...(operator_surface ? { operator_surface } : {}),
    ...(operation_core ? { operation_core } : {}),
    goal_projection: createUnidentifiedGoalProjection({
      request_id: req.id,
      original_content: config?.original_content ?? req.content,
      ...(config?.original_reference_kind ? { source_kind: config.original_reference_kind } : {}),
    }),
    goal: req.content.slice(0, 200),
    protected_values: config?.protected_values ?? DEFAULT_PROTECTED_VALUES,
    world_closure: {
      x: [
        req.channel,
        req.user,
        actor.actor_kind,
        process.process_id,
        ...(operator_surface ? [`surface:${operator_surface.id}`] : []),
        ...(operation_core ? [`operation_core:${operation_core.request.request_id}`] : []),
      ],
      r: [
        "request_response",
        "actor_process_binding",
        ...(operator_surface ? ["operator_surface_binding"] : []),
        ...(operation_core ? ["operation_core_request_binding"] : []),
      ],
      m: [
        "text",
        "hds_authority_plane",
        ...(operation_core ? ["operation_core"] : []),
      ],
    },
    problem_definition_id,
  };
}

const OPERATION_INTERFACES: readonly OperationInterface[] = [
  "gui",
  "natural_language",
  "api",
  "cli",
  "agent",
  "scheduler",
  "system",
];

function resolveOperationCore(
  req: InboundRequest,
  operator_surface?: OperatorSurfaceRef,
): OperationCoreFrameRef | undefined {
  if (!isGatewayInternalInboundRequest(req)) return undefined;
  const meta = req.metadata ?? {};
  if (meta["blue_tanuki.authority_context"] !== "gateway_internal_v1") return undefined;
  if (meta["blue_tanuki.operation_core.version"] !== "operation-core.v1") return undefined;
  if (
    meta["blue_tanuki.operation_core.used_for_authority"] !== false ||
    meta["blue_tanuki.operation_core.planner_output_used_for_authority"] !== false ||
    meta["blue_tanuki.operation_core.ui_projection_used_for_authority"] !== false
  ) {
    return undefined;
  }

  const sourceInterface = normalizeOperationInterface(meta["blue_tanuki.operation_core.source_interface"]);
  const requestId = stringMetadata(meta["blue_tanuki.operation_core.request_id"]) ?? `operation-request:${req.id}`;
  const projectionId = stringMetadata(meta["blue_tanuki.operation_core.projection_id"]);
  const target = operator_surface ? operationTargetForSurface(operator_surface) : undefined;
  const parsedRequest = OperationRequestSchema.safeParse({
    version: "operation-core.v1",
    request_id: requestId,
    source_interface: sourceInterface,
    actor: req.user,
    goal: req.content,
    ...(target ? { target } : {}),
    constraints: {
      hds_brain_authority_required: true,
      disallow_raw_command_as_authority: true,
    },
    used_for_authority: false,
  });
  if (!parsedRequest.success) return undefined;

  return {
    request: parsedRequest.data,
    source: "gateway_internal_metadata",
    ...(projectionId ? { projection_id: projectionId } : {}),
    used_for_authority: false,
    planner_output_used_for_authority: false,
    ui_projection_used_for_authority: false,
  };
}

function normalizeOperationInterface(value: unknown): OperationInterface {
  return typeof value === "string" && OPERATION_INTERFACES.includes(value as OperationInterface)
    ? (value as OperationInterface)
    : "api";
}

function stringMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function operationTargetForSurface(operator_surface: OperatorSurfaceRef): OperationTarget {
  return {
    kind: "runtime",
    id: `operator:${operator_surface.id}`,
    display_name: `${operator_surface.id} operator`,
    scope: "operator_surface",
  };
}

function resolveOperatorSurface(req: InboundRequest): OperatorSurfaceRef | undefined {
  const trimmed = req.content.trim().toLowerCase();
  if (
    trimmed.startsWith("/writing") ||
    trimmed.startsWith("writing:") ||
    trimmed.startsWith("operator:writing")
  ) {
    return {
      id: "writing",
      layer: "A",
      source: "content_prefix",
      authority: "downstream_device_only",
    };
  }
  if (
    trimmed.startsWith("/daily") ||
    trimmed.startsWith("daily:") ||
    trimmed.startsWith("operator:daily")
  ) {
    return {
      id: "daily",
      layer: "A",
      source: "content_prefix",
      authority: "downstream_device_only",
    };
  }
  if (
    trimmed.startsWith("/developer") ||
    trimmed.startsWith("developer:") ||
    trimmed.startsWith("operator:developer")
  ) {
    return {
      id: "developer",
      layer: "A",
      source: "content_prefix",
      authority: "downstream_device_only",
    };
  }

  const meta = req.metadata ?? {};
  if (
    isGatewayInternalInboundRequest(req) &&
    meta["blue_tanuki.authority_context"] === "gateway_internal_v1" &&
    (meta["blue_tanuki.operator_surface"] === "writing" ||
      meta["blue_tanuki.operator_surface"] === "daily" ||
      meta["blue_tanuki.operator_surface"] === "developer")
  ) {
    return {
      id: meta["blue_tanuki.operator_surface"],
      layer: "A",
      source: "gateway_internal_metadata",
      authority: "downstream_device_only",
    };
  }

  return undefined;
}
