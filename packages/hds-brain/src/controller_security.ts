import { createHash } from "node:crypto";
import type { ChannelSendPayload, ExecuteCommand, InboundRequest } from "@blue-tanuki/protocol";
import { isGatewayInternalInboundRequest } from "@blue-tanuki/protocol";
import type { CommitResult, DecisionLog } from "./types.js";

export function securityCommit(kind: string, reason: string, bind: unknown): CommitResult {
  const triggered_thresholds = [`security:${kind}`];
  const hash = sha256({
    kind,
    reason,
    bind,
    decision: "FAIL",
    triggered_thresholds,
  });
  return {
    decision: "FAIL",
    reason: `${kind}:${reason}`,
    hash,
    triggered_thresholds,
  };
}

export function suspendCommit(
  kind: string,
  reason: string,
  bind: unknown,
  triggered_thresholds: string[],
): CommitResult {
  const hash = sha256({
    kind,
    reason,
    bind,
    decision: "SUSPEND",
    triggered_thresholds,
  });
  return {
    decision: "SUSPEND",
    reason: `${kind}:${reason}`,
    hash,
    triggered_thresholds,
  };
}

export function processAuthorityViolation(f: DecisionLog["frame"]): string | null {
  const { actor, process } = f;
  if (!process.actor_policy.allowed_actor_kinds.includes(actor.actor_kind)) {
    return `actor_kind ${actor.actor_kind} not allowed for ${process.process_id}`;
  }
  if (process.actor_policy.owner_required && actor.actor_kind !== "owner") {
    return `${process.process_id} requires owner actor`;
  }
  if (process.trigger.kind === "webhook" && actor.actor_kind !== "webhook") {
    return "webhook trigger requires webhook actor";
  }
  if (
    process.trigger.kind === "cron" &&
    actor.actor_kind !== "cron" &&
    actor.actor_kind !== "system" &&
    actor.actor_kind !== "owner"
  ) {
    return "cron trigger requires cron/system/owner actor";
  }
  return null;
}

export function commandExecutionPolicyViolation(
  command: ExecuteCommand,
  process: DecisionLog["frame"]["process"],
): string | null {
  const policy = process.execution_policy;
  if (!policy.allowed_command_types.includes(command.type)) {
    return `command_type ${command.type} not allowed for ${process.process_id}`;
  }

  if (command.type === "tool_call") {
    const toolName = command.payload.tool_name;
    if (!policy.allowed_tools.includes(toolName)) {
      return `tool ${toolName} not allowed for ${process.process_id}`;
    }
  }

  const allowedCaps = new Set(policy.allowed_capabilities);
  const caps = command.constraints?.allowed_capabilities ?? [];
  for (const cap of caps) {
    if (!allowedCaps.has(cap)) {
      return `capability ${cap} not allowed for ${process.process_id}`;
    }
  }

  const timeout = command.constraints?.timeout_ms;
  if (timeout !== undefined && timeout > policy.timeout_ms) {
    return `timeout_ms ${timeout} exceeds ${process.process_id} limit ${policy.timeout_ms}`;
  }

  return null;
}

export function trustedChannelSendFromMetadata(req: InboundRequest): ChannelSendPayload | null {
  const meta = req.metadata ?? {};
  if (!isGatewayInternalInboundRequest(req)) return null;
  if (meta["blue_tanuki.authority_context"] !== "gateway_internal_v1") return null;
  const channel = stringMeta(meta, "blue_tanuki.channel_send.channel");
  const target = stringMeta(meta, "blue_tanuki.channel_send.target");
  const content = stringMeta(meta, "blue_tanuki.channel_send.content");
  if (!channel || !target || !content) return null;
  return { channel, target, content };
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return "[undefined]";
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stringMeta(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
