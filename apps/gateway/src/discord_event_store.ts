import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
const UINT64_MAX = 18_446_744_073_709_551_615n;
type DiscordEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
type DiscordOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";
interface DiscordOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "discord";
  readonly target: string;
  readonly text: string;
  readonly reply_to_message_id?: string;
}
interface DiscordOutboundDeliveryClaim extends DiscordOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}
interface DiscordPendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}
interface DiscordOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: DiscordOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly retry_after_ms?: number;
  readonly external_message_id?: string;
  readonly error_code?: string;
}
interface DiscordOutboundDeliveryStore {
  enqueue(input: DiscordOutboundDeliveryInput, now_ms?: number): void;
  pending(): readonly DiscordPendingDelivery[];
  claimDelivery(delivery_id: string, now_ms?: number): DiscordOutboundDeliveryClaim | null;
  scheduleRetry(delivery_id: string, not_before_ms: number, retry_after_ms: number, now_ms?: number): void;
  settleDelivery(delivery_id: string, state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result?: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number }, now_ms?: number): void;
  cancelPending(delivery_id: string, now_ms?: number): void;
  status(delivery_id: string): DiscordOutboundDeliveryStatus | null;
}

/** Structural preview-channel contract; keep the optional adapter out of Gateway dependencies. */
interface DiscordEventInbox {
  claim(message_id: string, payload_digest: string): DiscordEventClaim;
  settle(message_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}

export type DiscordEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: DiscordEventDeliveryState }
  | { readonly status: "identity_conflict" };

/** Durable inbound replay and outbound delivery boundary for one Discord bot. */
export class GatewayDiscordEventStore implements DiscordEventInbox, DiscordOutboundDeliveryStore {
  private db: DatabaseType;
  private closed = false;
  private readonly botScopeDigest: string;
  private readonly filepath: string;

  constructor(filepath: string, botToken: string) {
    if (typeof botToken !== "string" || botToken.trim().length === 0) {
      throw new Error("discord_inbox_bot_token_required");
    }
    this.filepath = filepath;
    this.botScopeDigest = sha256(`discord-bot-scope.v1\0${botToken}`);
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.initializeDatabase();
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, botToken: string): GatewayDiscordEventStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("discord_inbox_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "discord-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("discord_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "discord-inbox.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("discord_inbox_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayDiscordEventStore(filepath, botToken);
  }

  private initializeDatabase(): void {
    if (process.platform !== "win32") chmodSync(this.filepath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS discord_event_inbox (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        message_digest TEXT NOT NULL CHECK(length(message_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, message_digest)
      ) STRICT;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS discord_outbound_delivery (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        channel TEXT NOT NULL CHECK(channel = 'discord'),
        target TEXT,
        text TEXT,
        reply_to_message_id TEXT,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('queued','dispatching','retry_wait','delivered','not_delivered','outcome_unknown','retry_exhausted')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        not_before_ms INTEGER NOT NULL CHECK(not_before_ms >= 0),
        retry_after_ms INTEGER,
        external_message_id TEXT,
        error_code TEXT,
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, delivery_id),
        CHECK((delivery_state IN ('queued','dispatching','retry_wait') AND target IS NOT NULL AND text IS NOT NULL)
          OR (delivery_state IN ('delivered','not_delivered','outcome_unknown','retry_exhausted')
            AND target IS NULL AND text IS NULL AND reply_to_message_id IS NULL))
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("discord_inbox_integrity_check_failed");
      this.transaction(() => {
        this.db.prepare(`UPDATE discord_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
        this.db.prepare(`UPDATE discord_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          reply_to_message_id=NULL,error_code='interrupted_during_send',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  claim(messageId: string, payloadDigest: string, nowMs = Date.now()): DiscordEventClaim {
    validateIdentity(messageId, payloadDigest, nowMs);
    const messageDigest = sha256(`discord-message-id.v1\0${messageId}`);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM discord_event_inbox WHERE bot_scope_digest=? AND message_digest=?`)
        .get(this.botScopeDigest, messageDigest) as DiscordEventInboxRow | undefined;
      if (current) {
        validateRow(current);
        if (current.payload_digest !== payloadDigest) return { status: "identity_conflict" } as const;
        return { status: "duplicate", delivery_state: current.delivery_state } as const;
      }
      this.db.prepare(`INSERT INTO discord_event_inbox
        (bot_scope_digest,message_digest,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,'dispatching',?)`).run(this.botScopeDigest, messageDigest, payloadDigest, nowMs);
      return { status: "accepted" } as const;
    });
  }

  settle(messageId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown", nowMs = Date.now()): void {
    validateIdentity(messageId, payloadDigest, nowMs);
    if (state !== "handler_returned" && state !== "outcome_unknown") throw new Error("discord_inbox_delivery_state_invalid");
    const messageDigest = sha256(`discord-message-id.v1\0${messageId}`);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE discord_event_inbox SET delivery_state=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND message_digest=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.botScopeDigest, messageDigest, payloadDigest);
      if (Number(update.changes) === 1) return;
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM discord_event_inbox WHERE bot_scope_digest=? AND message_digest=?`)
        .get(this.botScopeDigest, messageDigest) as DiscordEventInboxRow | undefined;
      if (current) validateRow(current);
      if (!current || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("discord_inbox_settlement_conflict");
      }
    });
  }

  enqueue(input: DiscordOutboundDeliveryInput, nowMs = Date.now()): void {
    validateOutboundInput(input, nowMs);
    const payloadDigest = outboundPayloadDigest(input);
    this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest FROM discord_outbound_delivery
        WHERE bot_scope_digest=? AND delivery_id=?`).get(this.botScopeDigest, input.delivery_id) as { payload_digest: string } | undefined;
      if (current) {
        if (current.payload_digest !== payloadDigest) throw new Error("discord_outbound_delivery_identity_conflict");
        return;
      }
      this.db.prepare(`INSERT INTO discord_outbound_delivery
        (bot_scope_digest,delivery_id,payload_digest,channel,target,text,reply_to_message_id,delivery_state,
         attempt_count,not_before_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'discord',?,?,?,'queued',0,?,?,?)`)
        .run(this.botScopeDigest, input.delivery_id, payloadDigest, input.target, input.text,
          input.reply_to_message_id ?? null, nowMs, nowMs, nowMs);
    });
  }

  pending(): readonly DiscordPendingDelivery[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT delivery_id,delivery_state,not_before_ms FROM discord_outbound_delivery
      WHERE bot_scope_digest=? AND delivery_state IN ('queued','retry_wait') ORDER BY not_before_ms,created_at_ms`)
      .all(this.botScopeDigest) as unknown as DiscordPendingDelivery[];
    for (const row of rows) validatePendingDelivery(row);
    return rows;
  }

  claimDelivery(deliveryId: string, nowMs = Date.now()): DiscordOutboundDeliveryClaim | null {
    validateDeliveryIdentity(deliveryId, nowMs);
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT delivery_id,payload_digest,channel,target,text,reply_to_message_id,
        delivery_state,attempt_count,not_before_ms,retry_after_ms,external_message_id,error_code,created_at_ms,updated_at_ms
        FROM discord_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
        .get(this.botScopeDigest, deliveryId) as DiscordOutboundRow | undefined;
      if (!row) return null;
      validateOutboundRow(row);
      if ((row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") || row.not_before_ms > nowMs) return null;
      const result = this.db.prepare(`UPDATE discord_outbound_delivery SET delivery_state='dispatching',
        attempt_count=attempt_count+1,updated_at_ms=? WHERE bot_scope_digest=? AND delivery_id=?
        AND delivery_state IN ('queued','retry_wait') AND not_before_ms<=?`)
        .run(nowMs, this.botScopeDigest, deliveryId, nowMs);
      if (Number(result.changes) !== 1) return null;
      return {
        delivery_id: row.delivery_id,
        channel: "discord",
        target: row.target!,
        text: row.text!,
        ...(row.reply_to_message_id ? { reply_to_message_id: row.reply_to_message_id } : {}),
        payload_digest: row.payload_digest,
        attempt_count: row.attempt_count + 1,
      };
    });
  }

  scheduleRetry(deliveryId: string, notBeforeMs: number, retryAfterMs: number, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < nowMs ||
        !Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("discord_outbound_retry_schedule_invalid");
    }
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE discord_outbound_delivery SET delivery_state='retry_wait',
        not_before_ms=?,retry_after_ms=?,error_code='rate_limited',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(notBeforeMs, retryAfterMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(result.changes) !== 1) throw new Error("discord_outbound_retry_state_conflict");
    });
  }

  settleDelivery(deliveryId: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number } = {},
    nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    validateOutboundSettlement(state, result);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE discord_outbound_delivery SET delivery_state=?,target=NULL,text=NULL,
        reply_to_message_id=NULL,not_before_ms=?,retry_after_ms=COALESCE(?,retry_after_ms),external_message_id=?,
        error_code=?,updated_at_ms=? WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(state, nowMs, result.retry_after_ms ?? null, result.external_message_id ?? null,
          result.error_code ?? null, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== state || current.external_message_id !== result.external_message_id ||
          current.error_code !== result.error_code) throw new Error("discord_outbound_settlement_conflict");
    });
  }

  status(deliveryId: string): DiscordOutboundDeliveryStatus | null {
    validateDeliveryIdentity(deliveryId, 0);
    this.assertOpen();
    const row = this.db.prepare(`SELECT delivery_id,payload_digest,delivery_state,attempt_count,not_before_ms,
      retry_after_ms,external_message_id,error_code,channel,target,text,reply_to_message_id,created_at_ms,updated_at_ms
      FROM discord_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
      .get(this.botScopeDigest, deliveryId) as DiscordOutboundRow | undefined;
    if (!row) return null;
    validateOutboundRow(row);
    return {
      delivery_id: row.delivery_id,
      payload_digest: row.payload_digest,
      delivery_state: row.delivery_state,
      attempt_count: row.attempt_count,
      not_before_ms: row.not_before_ms,
      ...(row.retry_after_ms === null ? {} : { retry_after_ms: row.retry_after_ms }),
      ...(row.external_message_id === null ? {} : { external_message_id: row.external_message_id }),
      ...(row.error_code === null ? {} : { error_code: row.error_code }),
    };
  }

  cancelPending(deliveryId: string, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE discord_outbound_delivery SET delivery_state='not_delivered',target=NULL,
        text=NULL,reply_to_message_id=NULL,not_before_ms=?,error_code='cancelled_before_retry',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state IN ('queued','retry_wait')`)
        .run(nowMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== "not_delivered" || current.error_code !== "cancelled_before_retry") {
        throw new Error("discord_outbound_cancel_state_conflict");
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  isClosed(): boolean { return this.closed; }

  private transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("discord_inbox_store_closed");
  }
}

interface DiscordEventInboxRow {
  payload_digest: string;
  delivery_state: DiscordEventDeliveryState;
  updated_at_ms: number;
}

interface DiscordOutboundRow {
  delivery_id: string;
  payload_digest: string;
  channel: string;
  target: string | null;
  text: string | null;
  reply_to_message_id: string | null;
  delivery_state: DiscordOutboundDeliveryState;
  attempt_count: number;
  not_before_ms: number;
  retry_after_ms: number | null;
  external_message_id: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function validateDeliveryIdentity(deliveryId: string, nowMs: number): void {
  if (typeof deliveryId !== "string" || !/^[0-9a-f-]{36}$/u.test(deliveryId) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("discord_outbound_delivery_identity_invalid");
  }
}

function validateOutboundInput(input: DiscordOutboundDeliveryInput, nowMs: number): void {
  validateDeliveryIdentity(input.delivery_id, nowMs);
  if (input.channel !== "discord" || !isDiscordSnowflake(input.target) ||
      typeof input.text !== "string" || input.text.length > 1_000_000 ||
      (input.reply_to_message_id !== undefined && !isDiscordSnowflake(input.reply_to_message_id))) {
    throw new Error("discord_outbound_delivery_payload_invalid");
  }
}

function validatePendingDelivery(row: DiscordPendingDelivery): void {
  validateDeliveryIdentity(row.delivery_id, row.not_before_ms);
  if (!Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      (row.delivery_state !== "queued" && row.delivery_state !== "retry_wait")) {
    throw new Error("discord_outbound_pending_row_invalid");
  }
}

function validateOutboundRow(row: DiscordOutboundRow): void {
  const states: readonly DiscordOutboundDeliveryState[] = ["queued", "dispatching", "retry_wait", "delivered",
    "not_delivered", "outcome_unknown", "retry_exhausted"];
  const pending = row.delivery_state === "queued" || row.delivery_state === "dispatching" || row.delivery_state === "retry_wait";
  const payloadValid = pending
    ? row.target !== null && isDiscordSnowflake(row.target) && row.text !== null && row.text.length <= 1_000_000 &&
      (row.reply_to_message_id === null || isDiscordSnowflake(row.reply_to_message_id))
    : row.target === null && row.text === null && row.reply_to_message_id === null;
  if (!/^[0-9a-f-]{36}$/u.test(row.delivery_id) || !DIGEST.test(row.payload_digest) || row.channel !== "discord" ||
      !states.includes(row.delivery_state) || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
      !Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0 ||
      (row.retry_after_ms !== null && (!Number.isSafeInteger(row.retry_after_ms) || row.retry_after_ms <= 0)) ||
      (row.external_message_id !== null && !isDiscordSnowflake(row.external_message_id)) ||
      (row.error_code !== null && !/^[a-z0-9_.-]{1,96}$/u.test(row.error_code)) || !payloadValid) {
    throw new Error("discord_outbound_row_invalid");
  }
}

function validateOutboundSettlement(
  state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
  result: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
): void {
  if (!( ["delivered", "not_delivered", "outcome_unknown", "retry_exhausted"] as const).includes(state) ||
      (result.external_message_id !== undefined && !isDiscordSnowflake(result.external_message_id)) ||
      (result.error_code !== undefined && !/^[a-z0-9_.-]{1,96}$/u.test(result.error_code)) ||
      (result.retry_after_ms !== undefined && (!Number.isSafeInteger(result.retry_after_ms) || result.retry_after_ms <= 0))) {
    throw new Error("discord_outbound_settlement_invalid");
  }
}

function outboundPayloadDigest(input: DiscordOutboundDeliveryInput): string {
  return sha256(JSON.stringify([input.channel, input.target, input.text, input.reply_to_message_id ?? null]));
}

function validateIdentity(messageId: string, payloadDigest: string, nowMs: number): void {
  if (!isDiscordSnowflake(messageId) || !DIGEST.test(payloadDigest) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("discord_inbox_identity_invalid");
  }
}

function validateRow(row: DiscordEventInboxRow): void {
  if (!DIGEST.test(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("discord_inbox_row_invalid");
  }
}

function isDiscordSnowflake(value: string): boolean {
  if (!/^(?:0|[1-9]\d{0,19})$/u.test(value)) return false;
  try { return BigInt(value) <= UINT64_MAX; } catch { return false; }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
