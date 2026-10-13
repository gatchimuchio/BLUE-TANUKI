import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";

export interface RenderOptions {
  max_chars?: number;
}

const DEFAULT_MAX_CHARS = 4_000;

export function renderCommandOutput(
  cmd: ExecuteCommand,
  feedback: ExecuteFeedback,
  opts: RenderOptions = {},
): string | null {
  const maxChars = opts.max_chars ?? DEFAULT_MAX_CHARS;
  if (cmd.type === "channel_send") return null;

  if (feedback.status === "failed") {
    return truncate(
      `[failed:${cmd.type}] ${feedback.error ?? "command failed"}`,
      maxChars,
    );
  }

  if (feedback.status === "suspended") {
    return truncate(`[suspended:${cmd.type}]`, maxChars);
  }

  switch (cmd.type) {
    case "llm_call":
      return renderLLMResult(feedback.result, maxChars);
    case "tool_call":
      return truncate(
        `[tool:${cmd.payload.tool_name}]\n${stableJson(feedback.result)}`,
        maxChars,
      );
    case "noop": {
      if (cmd.payload.control_event === "plan_revision_committed") {
        return truncate("計画の未実行部分を改訂しました。変更部分は新しいstep選択と現在の承認条件を確認してください。", maxChars);
      }
      const reason = readReason(cmd.payload);
      return truncate(reason ? `[noop] ${reason}` : "[noop]", maxChars);
    }
  }
  return null;
}

function renderLLMResult(result: unknown, maxChars: number): string | null {
  if (isRecord(result) && typeof result.content === "string") {
    return truncate(result.content, maxChars);
  }
  if (typeof result === "string") {
    return truncate(result, maxChars);
  }
  return null;
}

function readReason(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const reason = payload.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value), null, 2);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalize(value[key]);
  }
  return out;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `\n[truncated ${value.length - maxChars} chars]`;
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
