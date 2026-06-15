import { randomUUID } from "node:crypto";
import type { ChannelSendPayload, InboundRequest } from "@blue-tanuki/protocol";
import type { InboundChannel, InboundHandler, OutboundChannel, SendMeta, SendResult } from "@blue-tanuki/channel-base";

export type TelegramFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramOptions {
  /** Telegram bot token. Env: TELEGRAM_BOT_TOKEN. Absent -> silent mode. */
  bot_token?: string;
  /** Poll interval. Default 1500ms. */
  poll_interval_ms?: number;
  /** Long-poll timeout seconds. Default 25. */
  poll_timeout_sec?: number;
  /** Dependency injection for tests. Default global fetch. */
  fetch?: TelegramFetch;
  /** Per-request HTTP timeout. Defaults to long-poll timeout + 5s for polling and 15s for sends. */
  request_timeout_ms?: number;
  log?: (line: string) => void;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number | string; type?: string; title?: string; username?: string };
  from?: { id: number | string; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
}

interface SentRecord {
  payload: ChannelSendPayload;
  meta: SendMeta;
  at: number;
  external_id: string;
  ok: boolean;
  error?: string;
}

/**
 * Telegram Bot API channel.
 *
 * Design boundary:
 * - This adapter is pure I/O. It never calls an LLM and never decides authority.
 * - Inbound messages are normalized to InboundRequest and handed to HDS-BRAIN.
 * - Outbound target is the Telegram chat_id as string.
 * - Missing TELEGRAM_BOT_TOKEN results in silent mode so local WebChat remains usable.
 */
export class TelegramChannel implements InboundChannel, OutboundChannel {
  readonly name = "telegram";
  private started = false;
  private silent = false;
  private stopped = false;
  private offset = 0;
  private loop: Promise<void> | null = null;
  private readonly history: SentRecord[] = [];
  private counter = 0;

  constructor(private readonly opts: TelegramOptions = {}) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (!this.opts.bot_token) {
      this.silent = true;
      this.log("[telegram] WARN TELEGRAM_BOT_TOKEN unset — running in silent mode");
      return;
    }
    this.loop = this.pollLoop(handler);
    this.log("[telegram] polling started");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopped = true;
    this.started = false;
    if (this.loop) {
      await Promise.race([this.loop.catch(() => undefined), sleep(250)]);
      this.loop = null;
    }
  }

  async send(payload: ChannelSendPayload, meta: SendMeta): Promise<SendResult> {
    this.counter += 1;
    const at = Date.now();
    if (this.silent || !this.opts.bot_token) {
      const external_id = `telegram-silent-${meta.command_id}-${this.counter}`;
      this.history.push({ payload, meta, at, external_id, ok: false, error: "silent_mode" });
      this.log(`[telegram:silent] would-send target=${payload.target} commit=${meta.upstream_commit_hash.slice(0, 8)}… content="${truncate(payload.content, 80)}"`);
      return { delivered: false, error: "silent_mode" };
    }

    const body = {
      chat_id: payload.target,
      text: payload.content,
      disable_web_page_preview: true,
    };
    try {
      const r = await this.call("sendMessage", body);
      if (!r.ok) {
        const err = r.description ?? "telegram_send_failed";
        this.history.push({ payload, meta, at, external_id: `telegram-failed-${meta.command_id}-${this.counter}`, ok: false, error: err });
        return { delivered: false, error: err };
      }
      const messageId = readTelegramMessageId(r.result) ?? `${this.counter}`;
      const external_id = `telegram-${messageId}`;
      this.history.push({ payload, meta, at, external_id, ok: true });
      return { delivered: true, external_id };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.history.push({ payload, meta, at, external_id: `telegram-error-${meta.command_id}-${this.counter}`, ok: false, error: err });
      return { delivered: false, error: err };
    }
  }

  getHistory(): readonly SentRecord[] { return [...this.history]; }
  isSilent(): boolean { return this.silent; }

  private async pollLoop(handler: InboundHandler): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await this.call("getUpdates", {
          offset: this.offset > 0 ? this.offset : undefined,
          timeout: this.opts.poll_timeout_sec ?? 25,
          allowed_updates: ["message", "edited_message"],
        });
        if (r.ok && Array.isArray(r.result)) {
          for (const update of r.result as TelegramUpdate[]) {
            this.offset = Math.max(this.offset, update.update_id + 1);
            const inbound = this.normalize(update);
            if (!inbound) continue;
            await handler(inbound);
          }
        } else if (!r.ok) {
          this.log(`[telegram] getUpdates failed: ${r.description ?? "unknown"}`);
          await sleep(this.opts.poll_interval_ms ?? 1500);
        }
      } catch (e) {
        this.log(`[telegram] poll error: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(this.opts.poll_interval_ms ?? 1500);
      }
    }
  }

  private normalize(update: TelegramUpdate): InboundRequest | null {
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.text) return null;
    if (msg.from?.is_bot) return null;
    const chatId = String(msg.chat.id);
    const fromId = msg.from?.id === undefined ? chatId : String(msg.from.id);
    const username = msg.from?.username ?? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim();
    return {
      id: randomUUID(),
      channel: "telegram",
      user: username || fromId,
      content: msg.text,
      timestamp: Date.now(),
      metadata: {
        reply_to: chatId,
        telegram_chat_id: chatId,
        telegram_user_id: fromId,
        telegram_message_id: msg.message_id,
        telegram_update_id: update.update_id,
      },
    };
  }

  private async call(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    const token = this.opts.bot_token;
    if (!token) return { ok: false, description: "missing_bot_token" };
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch is not available in this runtime");
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const timeoutMs =
      this.opts.request_timeout_ms ??
      (method === "getUpdates"
        ? ((this.opts.poll_timeout_sec ?? 25) * 1000) + 5000
        : 15_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stripUndefined(body)),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, description: `telegram_${method}_timeout_${timeoutMs}ms` };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { ok: false, description: text }; }
    if (isRecord(parsed)) {
      return {
        ok: parsed.ok === true,
        result: parsed.result,
        description: typeof parsed.description === "string" ? parsed.description : res.ok ? undefined : `http_${res.status}`,
      };
    }
    return { ok: false, description: `http_${res.status}` };
  }

  private log(line: string): void { (this.opts.log ?? console.log)(line); }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out;
}

function readTelegramMessageId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const id = value.message_id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…"; }
