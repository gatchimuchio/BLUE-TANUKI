import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

type SlackEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
type SlackEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: SlackEventDeliveryState }
  | { readonly status: "identity_conflict" };
type SlackOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";
interface SlackOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: string;
  readonly target: string;
  readonly text: string;
  readonly thread_ts?: string;
}
interface SlackOutboundDeliveryClaim extends SlackOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}
interface SlackPendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}
interface SlackOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: SlackOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly retry_after_ms?: number;
  readonly external_ts?: string;
  readonly error_code?: string;
}
interface SlackEventInbox {
  claim(event_id: string, payload_digest: string): SlackEventClaim;
  settle(event_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}
interface SlackOutboundDeliveryStore {
  enqueue(input: SlackOutboundDeliveryInput, now_ms?: number): void;
  pending(): readonly SlackPendingDelivery[];
  claimDelivery(delivery_id: string, now_ms?: number): SlackOutboundDeliveryClaim | null;
  scheduleRetry(delivery_id: string, not_before_ms: number, retry_after_ms: number, now_ms?: number): void;
  settleDelivery(delivery_id: string, state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result?: { readonly external_ts?: string; readonly error_code?: string; readonly retry_after_ms?: number }, now_ms?: number): void;
  cancelPending(delivery_id: string, now_ms?: number): void;
  status(delivery_id: string): SlackOutboundDeliveryStatus | null;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;

/** Content-free durable replay boundary for one Slack bot installation. */
export class GatewaySlackEventStore implements SlackEventInbox, SlackOutboundDeliveryStore {
  private db: DatabaseType;
  private closed = false;
  private readonly botScopeDigest: string;
  private readonly filepath: string;

  constructor(filepath: string, botToken: string) {
    if (typeof botToken !== "string" || botToken.trim().length === 0) {
      throw new Error("slack_inbox_bot_token_required");
    }
    this.filepath = filepath;
    this.botScopeDigest = sha256(`slack-bot-scope.v1\0${botToken}`);
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.initializeDatabase();
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, botToken: string): GatewaySlackEventStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("slack_inbox_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "slack-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("slack_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "slack-inbox.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("slack_inbox_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewaySlackEventStore(filepath, botToken);
  }

  private initializeDatabase(): void {
    if (process.platform !== "win32") chmodSync(this.filepath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS slack_event_inbox (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, event_digest)
      ) STRICT;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS slack_outbound_delivery (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        channel TEXT NOT NULL CHECK(channel = 'slack'),
        target TEXT,
        text TEXT,
        thread_ts TEXT,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('queued','dispatching','retry_wait','delivered','not_delivered','outcome_unknown','retry_exhausted')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        not_before_ms INTEGER NOT NULL CHECK(not_before_ms >= 0),
        retry_after_ms INTEGER,
        external_ts TEXT,
        error_code TEXT,
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, delivery_id),
        CHECK((delivery_state IN ('queued','dispatching','retry_wait') AND target IS NOT NULL AND text IS NOT NULL)
          OR (delivery_state IN ('delivered','not_delivered','outcome_unknown','retry_exhausted') AND target IS NULL AND text IS NULL AND thread_ts IS NULL))
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("slack_inbox_integrity_check_failed");
      this.transaction(() => {
        // If the process stopped during admission, never assume the handler did nothing.
        this.db.prepare(`UPDATE slack_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
        // A crash after transport dispatch is ambiguous; never resend it automatically.
        this.db.prepare(`UPDATE slack_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          thread_ts=NULL,error_code='interrupted_during_send',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  claim(eventId: string, payloadDigest: string, nowMs = Date.now()): SlackEventClaim {
    validateIdentity(eventId, payloadDigest, nowMs);
    const eventDigest = sha256(`slack-event-id.v1\0${eventId}`);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM slack_event_inbox WHERE bot_scope_digest=? AND event_digest=?`)
        .get(this.botScopeDigest, eventDigest) as SlackEventInboxRow | undefined;
      if (current) {
        validateRow(current);
        if (payloadDigest !== current.payload_digest) return { status: "identity_conflict" } as const;
        return { status: "duplicate", delivery_state: current.delivery_state } as const;
      }
      this.db.prepare(`INSERT INTO slack_event_inbox
        (bot_scope_digest,event_digest,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,'dispatching',?)`).run(this.botScopeDigest, eventDigest, payloadDigest, nowMs);
      return { status: "accepted" } as const;
    });
  }

  settle(eventId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown", nowMs = Date.now()): void {
    validateIdentity(eventId, payloadDigest, nowMs);
    if (state !== "handler_returned" && state !== "outcome_unknown") throw new Error("slack_inbox_delivery_state_invalid");
    const eventDigest = sha256(`slack-event-id.v1\0${eventId}`);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE slack_event_inbox SET delivery_state=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND event_digest=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.botScopeDigest, eventDigest, payloadDigest);
      if (Number(update.changes) === 1) return;
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM slack_event_inbox WHERE bot_scope_digest=? AND event_digest=?`)
        .get(this.botScopeDigest, eventDigest) as SlackEventInboxRow | undefined;
      if (current) validateRow(current);
      if (!current || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("slack_inbox_settlement_conflict");
      }
    });
  }

  enqueue(input: SlackOutboundDeliveryInput, nowMs = Date.now()): void {
    validateOutboundInput(input, nowMs);
    const payloadDigest = outboundPayloadDigest(input);
    this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest FROM slack_outbound_delivery
        WHERE bot_scope_digest=? AND delivery_id=?`).get(this.botScopeDigest, input.delivery_id) as { payload_digest: string } | undefined;
      if (current) {
        if (current.payload_digest !== payloadDigest) throw new Error("slack_outbound_delivery_identity_conflict");
        return;
      }
      this.db.prepare(`INSERT INTO slack_outbound_delivery
        (bot_scope_digest,delivery_id,payload_digest,channel,target,text,thread_ts,delivery_state,attempt_count,
         not_before_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'slack',?,?,?,'queued',0,?,?,?)`)
        .run(this.botScopeDigest, input.delivery_id, payloadDigest, input.target, input.text,
          input.thread_ts ?? null, nowMs, nowMs, nowMs);
    });
  }

  pending(): readonly SlackPendingDelivery[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT delivery_id,delivery_state,not_before_ms FROM slack_outbound_delivery
      WHERE bot_scope_digest=? AND delivery_state IN ('queued','retry_wait') ORDER BY not_before_ms,created_at_ms`)
      .all(this.botScopeDigest) as unknown as SlackPendingDelivery[];
    for (const row of rows) validatePendingDelivery(row);
    return rows;
  }

  claimDelivery(deliveryId: string, nowMs = Date.now()): SlackOutboundDeliveryClaim | null {
    validateDeliveryIdentity(deliveryId, nowMs);
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT delivery_id,payload_digest,channel,target,text,thread_ts,delivery_state,
        attempt_count,not_before_ms,retry_after_ms,external_ts,error_code,created_at_ms,updated_at_ms
        FROM slack_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
        .get(this.botScopeDigest, deliveryId) as SlackOutboundRow | undefined;
      if (!row) return null;
      validateOutboundRow(row);
      if ((row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") || row.not_before_ms > nowMs) return null;
      const result = this.db.prepare(`UPDATE slack_outbound_delivery SET delivery_state='dispatching',
        attempt_count=attempt_count+1,updated_at_ms=? WHERE bot_scope_digest=? AND delivery_id=?
        AND delivery_state IN ('queued','retry_wait') AND not_before_ms<=?`)
        .run(nowMs, this.botScopeDigest, deliveryId, nowMs);
      if (Number(result.changes) !== 1) return null;
      return {
        delivery_id: row.delivery_id,
        channel: row.channel,
        target: row.target!,
        text: row.text!,
        ...(row.thread_ts ? { thread_ts: row.thread_ts } : {}),
        payload_digest: row.payload_digest,
        attempt_count: row.attempt_count + 1,
      };
    });
  }

  scheduleRetry(deliveryId: string, notBeforeMs: number, retryAfterMs: number, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < nowMs ||
        !Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("slack_outbound_retry_schedule_invalid");
    }
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE slack_outbound_delivery SET delivery_state='retry_wait',
        not_before_ms=?,retry_after_ms=?,error_code='rate_limited',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(notBeforeMs, retryAfterMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(result.changes) !== 1) throw new Error("slack_outbound_retry_state_conflict");
    });
  }

  settleDelivery(deliveryId: string, state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result: { readonly external_ts?: string; readonly error_code?: string; readonly retry_after_ms?: number } = {},
    nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    validateOutboundSettlement(state, result);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE slack_outbound_delivery SET delivery_state=?,target=NULL,text=NULL,
        thread_ts=NULL,not_before_ms=?,retry_after_ms=COALESCE(?,retry_after_ms),external_ts=?,error_code=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(state, nowMs, result.retry_after_ms ?? null, result.external_ts ?? null,
          result.error_code ?? null, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== state || current.external_ts !== result.external_ts ||
          current.error_code !== result.error_code) throw new Error("slack_outbound_settlement_conflict");
    });
  }

  status(deliveryId: string): SlackOutboundDeliveryStatus | null {
    validateDeliveryIdentity(deliveryId, 0);
    this.assertOpen();
    const row = this.db.prepare(`SELECT delivery_id,payload_digest,delivery_state,attempt_count,not_before_ms,
      retry_after_ms,external_ts,error_code,channel,target,text,thread_ts,created_at_ms,updated_at_ms
      FROM slack_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
      .get(this.botScopeDigest, deliveryId) as SlackOutboundRow | undefined;
    if (!row) return null;
    validateOutboundRow(row);
    return {
      delivery_id: row.delivery_id,
      payload_digest: row.payload_digest,
      delivery_state: row.delivery_state,
      attempt_count: row.attempt_count,
      not_before_ms: row.not_before_ms,
      ...(row.retry_after_ms === null ? {} : { retry_after_ms: row.retry_after_ms }),
      ...(row.external_ts === null ? {} : { external_ts: row.external_ts }),
      ...(row.error_code === null ? {} : { error_code: row.error_code }),
    };
  }

  cancelPending(deliveryId: string, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE slack_outbound_delivery SET delivery_state='not_delivered',
        target=NULL,text=NULL,thread_ts=NULL,not_before_ms=?,error_code='cancelled_before_retry',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state IN ('queued','retry_wait')`)
        .run(nowMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== "not_delivered" || current.error_code !== "cancelled_before_retry") {
        throw new Error("slack_outbound_cancel_state_conflict");
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
    if (this.closed) throw new Error("slack_inbox_store_closed");
  }
}

interface SlackEventInboxRow {
  payload_digest: string;
  delivery_state: SlackEventDeliveryState;
  updated_at_ms: number;
}

interface SlackOutboundRow {
  delivery_id: string;
  payload_digest: string;
  channel: string;
  target: string | null;
  text: string | null;
  thread_ts: string | null;
  delivery_state: SlackOutboundDeliveryState;
  attempt_count: number;
  not_before_ms: number;
  retry_after_ms: number | null;
  external_ts: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function validateIdentity(eventId: string, payloadDigest: string, nowMs: number): void {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(eventId) ||
      !DIGEST.test(payloadDigest) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("slack_inbox_identity_invalid");
  }
}

function validateRow(row: SlackEventInboxRow): void {
  if (!DIGEST.test(row.payload_digest) || !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("slack_inbox_row_invalid");
  }
}

function validateDeliveryIdentity(deliveryId: string, nowMs: number): void {
  if (typeof deliveryId !== "string" || !/^[0-9a-f-]{36}$/u.test(deliveryId) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("slack_outbound_delivery_identity_invalid");
}

function validateOutboundInput(input: SlackOutboundDeliveryInput, nowMs: number): void {
  validateDeliveryIdentity(input.delivery_id, nowMs);
  if (input.channel !== "slack" || !/^(?:C|D|G)[A-Z0-9]{1,31}$/u.test(input.target) ||
      typeof input.text !== "string" || input.text.length > 1_000_000 ||
      (input.thread_ts !== undefined && !/^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(input.thread_ts))) {
    throw new Error("slack_outbound_delivery_payload_invalid");
  }
}

function validatePendingDelivery(row: SlackPendingDelivery): void {
  validateDeliveryIdentity(row.delivery_id, row.not_before_ms);
  if (!Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      (row.delivery_state !== "queued" && row.delivery_state !== "retry_wait")) {
    throw new Error("slack_outbound_pending_row_invalid");
  }
}

function validateOutboundRow(row: SlackOutboundRow): void {
  const states: readonly SlackOutboundDeliveryState[] = ["queued", "dispatching", "retry_wait", "delivered",
    "not_delivered", "outcome_unknown", "retry_exhausted"];
  const pending = row.delivery_state === "queued" || row.delivery_state === "dispatching" || row.delivery_state === "retry_wait";
  const payloadValid = pending
    ? row.target !== null && /^(?:C|D|G)[A-Z0-9]{1,31}$/u.test(row.target) && row.text !== null &&
      row.text.length <= 1_000_000 && (row.thread_ts === null || /^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(row.thread_ts))
    : row.target === null && row.text === null && row.thread_ts === null;
  if (!/^[0-9a-f-]{36}$/u.test(row.delivery_id) || !DIGEST.test(row.payload_digest) || row.channel !== "slack" ||
      !states.includes(row.delivery_state) || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
      !Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0 ||
      (row.retry_after_ms !== null && (!Number.isSafeInteger(row.retry_after_ms) || row.retry_after_ms <= 0)) ||
      (row.external_ts !== null && !/^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(row.external_ts)) ||
      (row.error_code !== null && !/^[a-z0-9_.-]{1,96}$/u.test(row.error_code)) ||
      !payloadValid) {
    throw new Error("slack_outbound_row_invalid");
  }
}

function validateOutboundSettlement(
  state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
  result: { readonly external_ts?: string; readonly error_code?: string; readonly retry_after_ms?: number },
): void {
  if (!(["delivered", "not_delivered", "outcome_unknown", "retry_exhausted"] as const).includes(state) ||
      (result.external_ts !== undefined && !/^(?:0|[1-9]\d{0,19})\.\d{1,20}$/u.test(result.external_ts)) ||
      (result.error_code !== undefined && !/^[a-z0-9_.-]{1,96}$/u.test(result.error_code)) ||
      (result.retry_after_ms !== undefined && (!Number.isSafeInteger(result.retry_after_ms) || result.retry_after_ms <= 0))) {
    throw new Error("slack_outbound_settlement_invalid");
  }
}

function outboundPayloadDigest(input: SlackOutboundDeliveryInput): string {
  return sha256(JSON.stringify([input.channel, input.target, input.text, input.thread_ts ?? null]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
