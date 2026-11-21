import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  WebChatApprovalControlContext,
  WebChatEvidenceControlContext,
  WebChatHistoryEntry,
  WebChatHistoryReplayFilter,
  WebChatHistorySnapshot,
  WebChatResumeApprovalOptions,
} from "./webchat_types.js";

export function readResumeApprovalOptions(body: Record<string, unknown> | null): WebChatResumeApprovalOptions | undefined {
  if (!body) return undefined;
  const remember = body.remember === true || body.remember === "true";
  const modeRaw = body.approval_mode ?? body.mode;
  const mode = modeRaw === "full_access" || modeRaw === "remember_this_decision" ? modeRaw : undefined;
  const durationRaw = body.duration_ms ?? body.remember_duration_ms;
  let duration_ms: number | null | undefined;
  if (durationRaw === null || durationRaw === "always") duration_ms = null;
  else if (typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0) duration_ms = Math.floor(durationRaw);
  else if (typeof durationRaw === "string" && /^\d+$/.test(durationRaw)) duration_ms = Math.floor(Number(durationRaw));
  if (!remember && !mode && duration_ms === undefined) return undefined;
  return { remember, mode, duration_ms };
}

export function readApprovalControlContext(body: Record<string, unknown> | null): WebChatApprovalControlContext {
  const actor =
    typeof body?.actor === "string" && body.actor.trim().length > 0
      ? body.actor.trim()
      : "webchat-human";
  const reason =
    typeof body?.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : undefined;
  return { actor, token_kind: "resume", reason };
}

export function readHistoryReplayFilter(url: URL): WebChatHistoryReplayFilter {
  const filter: WebChatHistoryReplayFilter = {};
  const kind = nonEmptyString(url.searchParams.get("kind"));
  const request_id = url.searchParams.has("request_id")
    ? url.searchParams.get("request_id")
    : undefined;
  const command_id = url.searchParams.has("command_id")
    ? url.searchParams.get("command_id")
    : undefined;
  const limitRaw = url.searchParams.get("limit");
  if (kind) filter.kind = kind;
  if (request_id !== undefined) filter.request_id = request_id || null;
  if (command_id !== undefined) filter.command_id = command_id || null;
  if (limitRaw && /^\d+$/.test(limitRaw)) {
    filter.limit = Math.min(500, Math.max(1, Number(limitRaw)));
  }
  return filter;
}

export function readEvidenceControlContext(body: Record<string, unknown> | null): WebChatEvidenceControlContext {
  const actor =
    typeof body?.actor === "string" && body.actor.trim().length > 0
      ? body.actor.trim()
      : "webchat-human";
  return { actor, token_kind: "inbound" };
}

export function sanitizeHistorySnapshot(snapshot: WebChatHistorySnapshot): WebChatHistorySnapshot {
  return {
    schema_version: snapshot.schema_version,
    entries_count: Number.isFinite(snapshot.entries_count)
      ? snapshot.entries_count
      : 0,
    skipped_count: snapshot.skipped_count,
    chain_valid: snapshot.chain_valid === true,
    complete_history_used_for_authority: false,
    replay_filter: snapshot.replay_filter,
    entries: Array.isArray(snapshot.entries)
      ? snapshot.entries.map((entry) => {
          const raw = entry as WebChatHistoryEntry & { payload?: unknown };
          const agent_worker_observation = projectAgentWorkerObservation(raw);
          return {
            schema_version: raw.schema_version,
            index: raw.index,
            id: raw.id,
            kind: raw.kind,
            request_id: raw.request_id ?? null,
            command_id: raw.command_id ?? null,
            actor: raw.actor,
            source: raw.source,
            payload_digest: raw.payload_digest,
            ...(agent_worker_observation ? { agent_worker_observation } : {}),
            used_for_authority: false,
            timestamp: raw.timestamp,
            prev_hash: raw.prev_hash,
            entry_hash: raw.entry_hash,
          };
        })
      : [],
  };
}

function projectAgentWorkerObservation(
  entry: WebChatHistoryEntry & { payload?: unknown },
): WebChatHistoryEntry["agent_worker_observation"] {
  if (entry.kind !== "audit_history" || entry.actor !== "executor" || entry.source !== "executor_agent_worker" ||
      typeof entry.command_id !== "string" || !Number.isSafeInteger(entry.timestamp) || entry.timestamp <= 0) return undefined;
  try {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const value = payload as Record<string, unknown>;
    const allowedKeys = new Set([
      "schema_version", "parent_command_digest", "child_task_digest", "role", "state", "observed_at_ms",
      "output_observed", "output_characters", "resource_use_digest", "used_for_authority", "may_execute",
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        !["schema_version", "parent_command_digest", "child_task_digest", "role", "state", "observed_at_ms",
          "used_for_authority", "may_execute"].every((key) => Object.hasOwn(value, key))) return undefined;
    const parentCommandDigest = createHash("sha256")
      .update("blue-tanuki.agent.parent-command.v1\0").update(entry.command_id).digest("hex");
    const roles = ["division", "independent_comparison", "audit", "redundancy"];
    const states = ["started", "cancel_requested", "cancelled_before_dispatch", "settled", "settled_after_abort",
      "late_result_discarded", "residual_worker_observed"];
    if (value.schema_version !== "blue-tanuki.agent-worker-lifecycle.v1" || value.parent_command_digest !== parentCommandDigest ||
        typeof value.child_task_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.child_task_digest) ||
        typeof value.role !== "string" || !roles.includes(value.role) ||
        typeof value.state !== "string" || !states.includes(value.state) ||
        !Number.isSafeInteger(value.observed_at_ms) || value.observed_at_ms !== entry.timestamp ||
        value.used_for_authority !== false || value.may_execute !== false ||
        (Object.hasOwn(value, "output_observed") && value.output_observed !== true) ||
        (Object.hasOwn(value, "output_characters") &&
          (!Number.isSafeInteger(value.output_characters) || (value.output_characters as number) < 0)) ||
        (Object.hasOwn(value, "resource_use_digest") &&
          (typeof value.resource_use_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.resource_use_digest)))) return undefined;
    return {
      schema_version: "blue-tanuki.agent-worker-lifecycle.v1",
      child_task_digest: value.child_task_digest,
      role: value.role as NonNullable<WebChatHistoryEntry["agent_worker_observation"]>["role"],
      state: value.state as NonNullable<WebChatHistoryEntry["agent_worker_observation"]>["state"],
      observed_at_ms: value.observed_at_ms as number,
      current_worker_state: "unknown",
      external_processing_stop: "unknown",
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return undefined;
  }
}

export function readWebhookContent(body: Record<string, unknown> | null): string | null {
  const direct = nonEmptyString(body?.content) ?? nonEmptyString(body?.text);
  if (direct) return direct;
  if (!body || !Object.hasOwn(body, "event")) return null;
  try {
    return JSON.stringify(body.event);
  } catch {
    return null;
  }
}

export async function readJson(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
  strictUtf8 = false,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    const bytes = Buffer.concat(chunks);
    const text = strictUtf8 ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("utf8");
    if (!text.trim()) return null;
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
