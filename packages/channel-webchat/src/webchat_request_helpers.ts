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
            used_for_authority: false,
            timestamp: raw.timestamp,
            prev_hash: raw.prev_hash,
            entry_hash: raw.entry_hash,
          };
        })
      : [],
  };
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
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024) {
      throw new Error("body_too_large");
    }
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return null;
  try {
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
