import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
type DeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
type TeamsOutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";

interface TeamsOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "teams";
  readonly target: string;
  readonly text: string;
}
interface TeamsOutboundDeliveryClaim extends TeamsOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}
interface TeamsPendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}
interface TeamsOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: TeamsOutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly retry_after_ms?: number;
  readonly external_message_id?: string;
  readonly error_code?: string;
}

export type TeamsEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: DeliveryState }
  | { readonly status: "identity_conflict" };

/** Durable Teams replay boundary. The database contains identity and payload digests only. */
export class GatewayTeamsEventStore {
  private readonly db: DatabaseType;
  private readonly botScopeDigest: string;
  private closed = false;

  constructor(filepath: string, clientId: string) {
    if (typeof clientId !== "string" || clientId.trim().length === 0) {
      throw new Error("teams_inbox_client_id_required");
    }
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.botScopeDigest = sha256(`teams-bot-scope.v1\0${clientId.toLowerCase()}`);
    this.db = new DatabaseSync(filepath);
    try {
      if (process.platform !== "win32") chmodSync(filepath, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS teams_event_inbox (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, event_digest)
      ) STRICT;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS teams_outbound_delivery (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        channel TEXT NOT NULL CHECK(channel = 'teams'),
        target TEXT,
        text TEXT,
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
            AND target IS NULL AND text IS NULL))
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("teams_inbox_integrity_check_failed");
      this.transaction(() => {
        this.db.prepare(`UPDATE teams_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
        this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          error_code='interrupted_during_send',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
        this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          error_code='credential_scope_changed',updated_at_ms=?
          WHERE bot_scope_digest<>? AND delivery_state IN ('queued','dispatching','retry_wait')`)
          .run(Date.now(), this.botScopeDigest);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, clientId: string): GatewayTeamsEventStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("teams_inbox_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "teams-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("teams_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "teams-inbox.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("teams_inbox_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayTeamsEventStore(filepath, clientId);
  }

  claim(eventId: string, payloadDigest: string, nowMs = Date.now()): TeamsEventClaim {
    validateClaimInput(eventId, payloadDigest, nowMs);
    const eventDigest = sha256(`teams-event-key.v1\0${eventId}`);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM teams_event_inbox WHERE bot_scope_digest=? AND event_digest=?`)
        .get(this.botScopeDigest, eventDigest) as TeamsEventRow | undefined;
      if (current) {
        validateRow(current);
        if (current.payload_digest !== payloadDigest) return { status: "identity_conflict" } as const;
        return { status: "duplicate", delivery_state: current.delivery_state } as const;
      }
      this.db.prepare(`INSERT INTO teams_event_inbox
        (bot_scope_digest,event_digest,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,'dispatching',?)`).run(this.botScopeDigest, eventDigest, payloadDigest, nowMs);
      return { status: "accepted" } as const;
    });
  }

  settle(eventId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown", nowMs = Date.now()): void {
    validateClaimInput(eventId, payloadDigest, nowMs);
    if (state !== "handler_returned" && state !== "outcome_unknown") throw new Error("teams_inbox_delivery_state_invalid");
    const eventDigest = sha256(`teams-event-key.v1\0${eventId}`);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE teams_event_inbox SET delivery_state=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND event_digest=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.botScopeDigest, eventDigest, payloadDigest);
      if (Number(update.changes) === 1) return;
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM teams_event_inbox WHERE bot_scope_digest=? AND event_digest=?`)
        .get(this.botScopeDigest, eventDigest) as TeamsEventRow | undefined;
      if (current) validateRow(current);
      if (!current || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("teams_inbox_settlement_conflict");
      }
    });
  }

  enqueue(input: TeamsOutboundDeliveryInput, nowMs = Date.now()): void {
    validateOutboundInput(input, nowMs);
    const payloadDigest = outboundPayloadDigest(input);
    this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest FROM teams_outbound_delivery
        WHERE bot_scope_digest=? AND delivery_id=?`)
        .get(this.botScopeDigest, input.delivery_id) as { payload_digest: string } | undefined;
      if (current) {
        if (current.payload_digest !== payloadDigest) throw new Error("teams_outbound_delivery_identity_conflict");
        return;
      }
      this.db.prepare(`INSERT INTO teams_outbound_delivery
        (bot_scope_digest,delivery_id,payload_digest,channel,target,text,delivery_state,
         attempt_count,not_before_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'teams',?,?,'queued',0,?,?,?)`)
        .run(this.botScopeDigest, input.delivery_id, payloadDigest, input.target, input.text, nowMs, nowMs, nowMs);
    });
  }

  pending(): readonly TeamsPendingDelivery[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT delivery_id,delivery_state,not_before_ms FROM teams_outbound_delivery
      WHERE bot_scope_digest=? AND delivery_state IN ('queued','retry_wait') ORDER BY not_before_ms,created_at_ms`)
      .all(this.botScopeDigest) as unknown as TeamsPendingDelivery[];
    for (const row of rows) validatePendingDelivery(row);
    return rows;
  }

  claimDelivery(deliveryId: string, nowMs = Date.now()): TeamsOutboundDeliveryClaim | null {
    validateDeliveryIdentity(deliveryId, nowMs);
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT delivery_id,payload_digest,channel,target,text,delivery_state,attempt_count,
        not_before_ms,retry_after_ms,external_message_id,error_code,created_at_ms,updated_at_ms
        FROM teams_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
        .get(this.botScopeDigest, deliveryId) as TeamsOutboundRow | undefined;
      if (!row) return null;
      validateOutboundRow(row);
      if ((row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") || row.not_before_ms > nowMs) return null;
      const update = this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state='dispatching',
        attempt_count=attempt_count+1,updated_at_ms=? WHERE bot_scope_digest=? AND delivery_id=?
        AND delivery_state IN ('queued','retry_wait') AND not_before_ms<=?`)
        .run(nowMs, this.botScopeDigest, deliveryId, nowMs);
      if (Number(update.changes) !== 1) return null;
      return { delivery_id: row.delivery_id, channel: "teams", target: row.target!, text: row.text!,
        payload_digest: row.payload_digest, attempt_count: row.attempt_count + 1 };
    });
  }

  scheduleRetry(deliveryId: string, notBeforeMs: number, retryAfterMs: number, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < nowMs ||
        !Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("teams_outbound_retry_schedule_invalid");
    }
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state='retry_wait',
        not_before_ms=?,retry_after_ms=?,error_code='rate_limited',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(notBeforeMs, retryAfterMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) !== 1) throw new Error("teams_outbound_retry_state_conflict");
    });
  }

  settleDelivery(deliveryId: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number } = {},
    nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    validateOutboundSettlement(state, result);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state=?,target=NULL,text=NULL,
        not_before_ms=?,retry_after_ms=COALESCE(?,retry_after_ms),external_message_id=?,error_code=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(state, nowMs, result.retry_after_ms ?? null, result.external_message_id ?? null,
          result.error_code ?? null, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== state || current.external_message_id !== result.external_message_id ||
          current.error_code !== result.error_code) throw new Error("teams_outbound_settlement_conflict");
    });
  }

  status(deliveryId: string): TeamsOutboundDeliveryStatus | null {
    validateDeliveryIdentity(deliveryId, 0);
    this.assertOpen();
    const row = this.db.prepare(`SELECT delivery_id,payload_digest,delivery_state,attempt_count,not_before_ms,
      retry_after_ms,external_message_id,error_code,channel,target,text,created_at_ms,updated_at_ms
      FROM teams_outbound_delivery WHERE bot_scope_digest=? AND delivery_id=?`)
      .get(this.botScopeDigest, deliveryId) as TeamsOutboundRow | undefined;
    if (!row) return null;
    validateOutboundRow(row);
    return { delivery_id: row.delivery_id, payload_digest: row.payload_digest, delivery_state: row.delivery_state,
      attempt_count: row.attempt_count, not_before_ms: row.not_before_ms,
      ...(row.retry_after_ms === null ? {} : { retry_after_ms: row.retry_after_ms }),
      ...(row.external_message_id === null ? {} : { external_message_id: row.external_message_id }),
      ...(row.error_code === null ? {} : { error_code: row.error_code }) };
  }

  cancelPending(deliveryId: string, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE teams_outbound_delivery SET delivery_state='not_delivered',target=NULL,
        text=NULL,not_before_ms=?,error_code='cancelled_before_retry',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_id=? AND delivery_state IN ('queued','retry_wait')`)
        .run(nowMs, nowMs, this.botScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== "not_delivered" || current.error_code !== "cancelled_before_retry") {
        throw new Error("teams_outbound_cancel_state_conflict");
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain original failure */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("teams_inbox_closed");
  }
}

interface TeamsEventRow {
  readonly payload_digest: string;
  readonly delivery_state: DeliveryState;
  readonly updated_at_ms: number;
}

interface TeamsOutboundRow {
  delivery_id: string;
  payload_digest: string;
  channel: string;
  target: string | null;
  text: string | null;
  delivery_state: TeamsOutboundDeliveryState;
  attempt_count: number;
  not_before_ms: number;
  retry_after_ms: number | null;
  external_message_id: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function validateDeliveryIdentity(deliveryId: string, nowMs: number): void {
  if (typeof deliveryId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(deliveryId) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("teams_outbound_delivery_identity_invalid");
}

function validateOutboundInput(input: TeamsOutboundDeliveryInput, nowMs: number): void {
  validateDeliveryIdentity(input.delivery_id, nowMs);
  if (input.channel !== "teams" || !isValidTeamsTarget(input.target) || typeof input.text !== "string" ||
      input.text.length === 0 || input.text.length > 1_000_000) throw new Error("teams_outbound_delivery_payload_invalid");
}

function validatePendingDelivery(row: TeamsPendingDelivery): void {
  validateDeliveryIdentity(row.delivery_id, row.not_before_ms);
  if (!Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      (row.delivery_state !== "queued" && row.delivery_state !== "retry_wait")) throw new Error("teams_outbound_pending_row_invalid");
}

function validateOutboundRow(row: TeamsOutboundRow): void {
  const states: readonly TeamsOutboundDeliveryState[] = ["queued", "dispatching", "retry_wait", "delivered",
    "not_delivered", "outcome_unknown", "retry_exhausted"];
  const pending = row.delivery_state === "queued" || row.delivery_state === "dispatching" || row.delivery_state === "retry_wait";
  const payloadValid = pending
    ? row.target !== null && isValidTeamsTarget(row.target) && row.text !== null && row.text.length > 0 && row.text.length <= 1_000_000 &&
      outboundPayloadDigest({ delivery_id: row.delivery_id, channel: "teams", target: row.target, text: row.text }) === row.payload_digest
    : row.target === null && row.text === null;
  if (!/^[a-f0-9-]{36}$/iu.test(row.delivery_id) || !DIGEST.test(row.payload_digest) || row.channel !== "teams" ||
      !states.includes(row.delivery_state) || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
      !Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0 ||
      (row.retry_after_ms !== null && (!Number.isSafeInteger(row.retry_after_ms) || row.retry_after_ms <= 0)) ||
      (row.external_message_id !== null && (row.external_message_id.length === 0 || row.external_message_id.length > 512 || /[\u0000-\u001f\u007f]/u.test(row.external_message_id))) ||
      (row.error_code !== null && !/^[a-z0-9_.-]{1,96}$/u.test(row.error_code)) || !payloadValid) {
    throw new Error("teams_outbound_row_invalid");
  }
}

function validateOutboundSettlement(
  state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
  result: { readonly external_message_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
): void {
  if (!( ["delivered", "not_delivered", "outcome_unknown", "retry_exhausted"] as const).includes(state) ||
      (result.external_message_id !== undefined && (result.external_message_id.length === 0 || result.external_message_id.length > 512 || /[\u0000-\u001f\u007f]/u.test(result.external_message_id))) ||
      (result.error_code !== undefined && !/^[a-z0-9_.-]{1,96}$/u.test(result.error_code)) ||
      (result.retry_after_ms !== undefined && (!Number.isSafeInteger(result.retry_after_ms) || result.retry_after_ms <= 0))) {
    throw new Error("teams_outbound_settlement_invalid");
  }
}

function outboundPayloadDigest(input: TeamsOutboundDeliveryInput): string {
  return sha256(JSON.stringify([input.channel, input.target, input.text]));
}

function isValidTeamsTarget(target: string): boolean {
  if (typeof target !== "string" || target.length > 4096) return false;
  const parts = target.split("/");
  try {
    const ids = parts[0] === "channel" && parts.length === 3 ? parts.slice(1) :
      parts[0] === "reply" && parts.length === 4 ? parts.slice(1) :
      parts[0] === "chat" && parts.length === 2 ? parts.slice(1) : null;
    return Boolean(ids?.every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded.length > 0 && decoded.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(decoded);
    }));
  } catch { return false; }
}

function validateClaimInput(eventId: string, payloadDigest: string, nowMs: number): void {
  if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(eventId)) {
    throw new Error("teams_inbox_event_id_invalid");
  }
  if (typeof payloadDigest !== "string" || !DIGEST.test(payloadDigest)) throw new Error("teams_inbox_payload_digest_invalid");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("teams_inbox_timestamp_invalid");
}

function validateRow(row: TeamsEventRow): void {
  if (!DIGEST.test(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("teams_inbox_corrupt_row");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
