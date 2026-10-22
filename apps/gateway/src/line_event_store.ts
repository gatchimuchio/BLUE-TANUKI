import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
type InboundDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
type OutboundDeliveryState = "queued" | "dispatching" | "retry_wait" | "delivered" |
  "not_delivered" | "outcome_unknown" | "retry_exhausted";

export interface LineOutboundDeliveryInput {
  readonly delivery_id: string;
  readonly channel: "line";
  readonly target: string;
  readonly text: string;
  readonly expires_at_ms: number;
}

export interface LineOutboundDeliveryClaim extends LineOutboundDeliveryInput {
  readonly payload_digest: string;
  readonly attempt_count: number;
}

export interface LinePendingDelivery {
  readonly delivery_id: string;
  readonly delivery_state: "queued" | "retry_wait";
  readonly not_before_ms: number;
}

export interface LineOutboundDeliveryStatus {
  readonly delivery_id: string;
  readonly payload_digest: string;
  readonly delivery_state: OutboundDeliveryState;
  readonly attempt_count: number;
  readonly not_before_ms: number;
  readonly expires_at_ms: number;
  readonly retry_after_ms?: number;
  readonly external_request_id?: string;
  readonly error_code?: string;
}

export type LineEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: InboundDeliveryState }
  | { readonly status: "identity_conflict" };

interface LineEventRow {
  readonly payload_digest: string;
  readonly delivery_state: InboundDeliveryState;
  readonly updated_at_ms: number;
}

interface LineOutboundRow {
  delivery_id: string;
  payload_digest: string;
  channel: string;
  target: string | null;
  text: string | null;
  delivery_state: OutboundDeliveryState;
  attempt_count: number;
  not_before_ms: number;
  expires_at_ms: number;
  retry_after_ms: number | null;
  external_request_id: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Durable LINE replay inbox and private outbound queue. Payloads exist only while a send is pending. */
export class GatewayLineEventStore {
  private readonly db: DatabaseType;
  private readonly destinationScopeDigest: string;
  private readonly deliveryScopeDigest: string;
  private readonly hasDestination: boolean;
  private closed = false;

  constructor(filepath: string, destination?: string, channelAccessToken?: string) {
    if (destination !== undefined && !isSafeIdentifier(destination)) throw new Error("line_inbox_destination_invalid");
    this.hasDestination = destination !== undefined;
    this.destinationScopeDigest = sha256(`line-destination-scope.v1\0${destination ?? ""}`);
    // The token is used only to scope pending outbox records. Its raw value is never persisted.
    this.deliveryScopeDigest = sha256(JSON.stringify([
      "line-delivery-scope.v1",
      destination ?? "",
      channelAccessToken ?? "",
    ]));
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    try {
      if (process.platform !== "win32") chmodSync(filepath, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS line_event_inbox (
        destination_scope_digest TEXT NOT NULL CHECK(length(destination_scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(destination_scope_digest,event_digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS line_outbound_delivery (
        delivery_scope_digest TEXT NOT NULL CHECK(length(delivery_scope_digest) = 64),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        channel TEXT NOT NULL CHECK(channel = 'line'),
        target TEXT,
        text TEXT,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('queued','dispatching','retry_wait','delivered','not_delivered','outcome_unknown','retry_exhausted')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        not_before_ms INTEGER NOT NULL CHECK(not_before_ms >= 0),
        expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
        retry_after_ms INTEGER CHECK(retry_after_ms IS NULL OR retry_after_ms >= 0),
        external_request_id TEXT,
        error_code TEXT,
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(delivery_scope_digest,delivery_id),
        CHECK(expires_at_ms >= created_at_ms),
        CHECK((delivery_state IN ('queued','dispatching','retry_wait') AND target IS NOT NULL AND text IS NOT NULL)
          OR (delivery_state IN ('delivered','not_delivered','outcome_unknown','retry_exhausted')
            AND target IS NULL AND text IS NULL))
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("line_inbox_integrity_check_failed");
      this.transaction(() => {
        const now = Date.now();
        this.db.prepare(`UPDATE line_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE destination_scope_digest=? AND delivery_state='dispatching'`)
          .run(now, this.destinationScopeDigest);
        this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='retry_wait',not_before_ms=?,
          error_code='interrupted_same_key_retry',updated_at_ms=?
          WHERE delivery_scope_digest=? AND delivery_state='dispatching' AND expires_at_ms>?`)
          .run(now, now, this.deliveryScopeDigest, now);
        this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          error_code='delivery_expired',updated_at_ms=?
          WHERE delivery_scope_digest=? AND delivery_state='dispatching' AND expires_at_ms<=?`)
          .run(now, this.deliveryScopeDigest, now);
        this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='outcome_unknown',target=NULL,text=NULL,
          error_code='credential_scope_changed',updated_at_ms=?
          WHERE delivery_scope_digest<>? AND delivery_state IN ('queued','dispatching','retry_wait')`)
          .run(now, this.deliveryScopeDigest);
        this.expirePendingDeliveries(now);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    destination?: string,
    channelAccessToken?: string,
  ): GatewayLineEventStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("line_inbox_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "line-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("line_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "line-inbox.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("line_inbox_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayLineEventStore(filepath, destination, channelAccessToken);
  }

  claim(eventId: string, payloadDigest: string, nowMs = Date.now()): LineEventClaim {
    this.assertDestination();
    validateClaimInput(eventId, payloadDigest, nowMs);
    const eventDigest = sha256(`line-event-key.v1\0${eventId}`);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM line_event_inbox WHERE destination_scope_digest=? AND event_digest=?`)
        .get(this.destinationScopeDigest, eventDigest) as LineEventRow | undefined;
      if (current) {
        validateEventRow(current);
        if (current.payload_digest !== payloadDigest) return { status: "identity_conflict" } as const;
        return { status: "duplicate", delivery_state: current.delivery_state } as const;
      }
      this.db.prepare(`INSERT INTO line_event_inbox
        (destination_scope_digest,event_digest,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,'dispatching',?)`).run(this.destinationScopeDigest, eventDigest, payloadDigest, nowMs);
      return { status: "accepted" } as const;
    });
  }

  settle(
    eventId: string,
    payloadDigest: string,
    state: "handler_returned" | "outcome_unknown",
    nowMs = Date.now(),
  ): void {
    this.assertDestination();
    validateClaimInput(eventId, payloadDigest, nowMs);
    const eventDigest = sha256(`line-event-key.v1\0${eventId}`);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE line_event_inbox SET delivery_state=?,updated_at_ms=?
        WHERE destination_scope_digest=? AND event_digest=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.destinationScopeDigest, eventDigest, payloadDigest);
      if (Number(update.changes) === 1) return;
      const current = this.db.prepare(`SELECT payload_digest,delivery_state,updated_at_ms
        FROM line_event_inbox WHERE destination_scope_digest=? AND event_digest=?`)
        .get(this.destinationScopeDigest, eventDigest) as LineEventRow | undefined;
      if (current) validateEventRow(current);
      if (!current || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("line_inbox_settlement_conflict");
      }
    });
  }

  enqueue(input: LineOutboundDeliveryInput, nowMs = Date.now()): void {
    validateOutboundInput(input, nowMs);
    const payloadDigest = outboundPayloadDigest(input);
    this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest FROM line_outbound_delivery
        WHERE delivery_scope_digest=? AND delivery_id=?`)
        .get(this.deliveryScopeDigest, input.delivery_id) as { payload_digest: string } | undefined;
      if (current) {
        if (current.payload_digest !== payloadDigest) throw new Error("line_outbound_delivery_identity_conflict");
        return;
      }
      this.db.prepare(`INSERT INTO line_outbound_delivery
        (delivery_scope_digest,delivery_id,payload_digest,channel,target,text,delivery_state,
         attempt_count,not_before_ms,expires_at_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'line',?,?,'queued',0,?,?,?,?)`)
        .run(this.deliveryScopeDigest, input.delivery_id, payloadDigest, input.target, input.text,
          nowMs, input.expires_at_ms, nowMs, nowMs);
    });
  }

  pending(nowMs = Date.now()): readonly LinePendingDelivery[] {
    validateNow(nowMs);
    this.assertOpen();
    return this.transaction(() => {
      this.expirePendingDeliveries(nowMs);
      const rows = this.db.prepare(`SELECT delivery_id,delivery_state,not_before_ms FROM line_outbound_delivery
        WHERE delivery_scope_digest=? AND delivery_state IN ('queued','retry_wait')
        ORDER BY not_before_ms,created_at_ms`)
        .all(this.deliveryScopeDigest) as unknown as LinePendingDelivery[];
      for (const row of rows) validatePendingDelivery(row);
      return rows;
    });
  }

  claimDelivery(deliveryId: string, nowMs = Date.now()): LineOutboundDeliveryClaim | null {
    validateDeliveryIdentity(deliveryId, nowMs);
    return this.transaction(() => {
      this.expirePendingDeliveries(nowMs);
      const row = this.db.prepare(`SELECT delivery_id,payload_digest,channel,target,text,delivery_state,attempt_count,
        not_before_ms,expires_at_ms,retry_after_ms,external_request_id,error_code,created_at_ms,updated_at_ms
        FROM line_outbound_delivery WHERE delivery_scope_digest=? AND delivery_id=?`)
        .get(this.deliveryScopeDigest, deliveryId) as LineOutboundRow | undefined;
      if (!row) return null;
      validateOutboundRow(row);
      if ((row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") || row.not_before_ms > nowMs) return null;
      const update = this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='dispatching',
        attempt_count=attempt_count+1,updated_at_ms=? WHERE delivery_scope_digest=? AND delivery_id=?
        AND delivery_state IN ('queued','retry_wait') AND not_before_ms<=? AND expires_at_ms>?`)
        .run(nowMs, this.deliveryScopeDigest, deliveryId, nowMs, nowMs);
      if (Number(update.changes) !== 1) return null;
      return { delivery_id: row.delivery_id, channel: "line", target: row.target!, text: row.text!,
        expires_at_ms: row.expires_at_ms, payload_digest: row.payload_digest, attempt_count: row.attempt_count + 1 };
    });
  }

  scheduleRetry(
    deliveryId: string,
    notBeforeMs: number,
    retryAfterMs?: number,
    nowMs = Date.now(),
    errorCode: "rate_limited" | "server_retry" = "rate_limited",
  ): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    if (!Number.isSafeInteger(notBeforeMs) || notBeforeMs < nowMs ||
        (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) ||
        !["rate_limited", "server_retry"].includes(errorCode)) {
      throw new Error("line_outbound_retry_schedule_invalid");
    }
    this.transaction(() => {
      const row = this.db.prepare(`SELECT expires_at_ms FROM line_outbound_delivery
        WHERE delivery_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .get(this.deliveryScopeDigest, deliveryId) as { expires_at_ms: number } | undefined;
      if (!row || !Number.isSafeInteger(row.expires_at_ms)) throw new Error("line_outbound_retry_state_conflict");
      if (notBeforeMs >= row.expires_at_ms) throw new Error("line_outbound_retry_exceeds_expiry");
      const update = this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='retry_wait',
        not_before_ms=?,retry_after_ms=?,error_code=?,updated_at_ms=?
        WHERE delivery_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(notBeforeMs, retryAfterMs ?? null, errorCode, nowMs, this.deliveryScopeDigest, deliveryId);
      if (Number(update.changes) !== 1) throw new Error("line_outbound_retry_state_conflict");
    });
  }

  settleDelivery(
    deliveryId: string,
    state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
    result: { readonly external_request_id?: string; readonly error_code?: string; readonly retry_after_ms?: number } = {},
    nowMs = Date.now(),
  ): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    validateOutboundSettlement(state, result);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state=?,target=NULL,text=NULL,
        not_before_ms=?,retry_after_ms=COALESCE(?,retry_after_ms),external_request_id=?,error_code=?,updated_at_ms=?
        WHERE delivery_scope_digest=? AND delivery_id=? AND delivery_state='dispatching'`)
        .run(state, nowMs, result.retry_after_ms ?? null, result.external_request_id ?? null,
          result.error_code ?? null, nowMs, this.deliveryScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== state || current.external_request_id !== result.external_request_id ||
          current.error_code !== result.error_code) throw new Error("line_outbound_settlement_conflict");
    });
  }

  status(deliveryId: string): LineOutboundDeliveryStatus | null {
    validateDeliveryIdentity(deliveryId, 0);
    this.assertOpen();
    const row = this.db.prepare(`SELECT delivery_id,payload_digest,delivery_state,attempt_count,not_before_ms,
      expires_at_ms,retry_after_ms,external_request_id,error_code,channel,target,text,created_at_ms,updated_at_ms
      FROM line_outbound_delivery WHERE delivery_scope_digest=? AND delivery_id=?`)
      .get(this.deliveryScopeDigest, deliveryId) as LineOutboundRow | undefined;
    if (!row) return null;
    validateOutboundRow(row);
    return { delivery_id: row.delivery_id, payload_digest: row.payload_digest, delivery_state: row.delivery_state,
      attempt_count: row.attempt_count, not_before_ms: row.not_before_ms, expires_at_ms: row.expires_at_ms,
      ...(row.retry_after_ms === null ? {} : { retry_after_ms: row.retry_after_ms }),
      ...(row.external_request_id === null ? {} : { external_request_id: row.external_request_id }),
      ...(row.error_code === null ? {} : { error_code: row.error_code }) };
  }

  cancelPending(deliveryId: string, nowMs = Date.now()): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='not_delivered',target=NULL,
        text=NULL,not_before_ms=?,error_code='cancelled_before_retry',updated_at_ms=?
        WHERE delivery_scope_digest=? AND delivery_id=? AND delivery_state IN ('queued','retry_wait')`)
        .run(nowMs, nowMs, this.deliveryScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== "not_delivered" || current.error_code !== "cancelled_before_retry") {
        throw new Error("line_outbound_cancel_state_conflict");
      }
    });
  }

  abandonPending(
    deliveryId: string,
    state: "not_delivered" | "outcome_unknown",
    errorCode: string,
    nowMs = Date.now(),
  ): void {
    validateDeliveryIdentity(deliveryId, nowMs);
    validateOutboundSettlement(state, { error_code: errorCode });
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state=?,target=NULL,text=NULL,
        not_before_ms=?,error_code=?,updated_at_ms=?
        WHERE delivery_scope_digest=? AND delivery_id=? AND delivery_state IN ('queued','retry_wait')`)
        .run(state, nowMs, errorCode, nowMs, this.deliveryScopeDigest, deliveryId);
      if (Number(update.changes) === 1) return;
      const current = this.status(deliveryId);
      if (!current || current.delivery_state !== state || current.error_code !== errorCode) {
        throw new Error("line_outbound_abandon_state_conflict");
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private expirePendingDeliveries(nowMs: number): void {
    this.db.prepare(`UPDATE line_outbound_delivery SET delivery_state='retry_exhausted',target=NULL,text=NULL,
      error_code='delivery_expired',updated_at_ms=?
      WHERE delivery_state IN ('queued','retry_wait') AND expires_at_ms<=?`)
      .run(nowMs, nowMs);
  }

  private assertDestination(): void {
    if (!this.hasDestination) throw new Error("line_inbox_destination_required");
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("line_inbox_closed");
  }
}

function validateClaimInput(eventId: string, payloadDigest: string, nowMs: number): void {
  if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(eventId)) throw new Error("line_inbox_event_id_invalid");
  if (typeof payloadDigest !== "string" || !DIGEST.test(payloadDigest)) throw new Error("line_inbox_payload_digest_invalid");
  validateNow(nowMs);
}

function validateOutboundInput(input: LineOutboundDeliveryInput, nowMs: number): void {
  validateDeliveryIdentity(input.delivery_id, nowMs);
  if (input.channel !== "line" || !isValidLineTarget(input.target) || typeof input.text !== "string" ||
      input.text.length === 0 || input.text.length > 1_000_000 || !Number.isSafeInteger(input.expires_at_ms) ||
      input.expires_at_ms <= nowMs) throw new Error("line_outbound_delivery_payload_invalid");
}

function validateDeliveryIdentity(deliveryId: string, nowMs: number): void {
  if (typeof deliveryId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(deliveryId)) {
    throw new Error("line_outbound_delivery_identity_invalid");
  }
  validateNow(nowMs);
}

function validatePendingDelivery(row: LinePendingDelivery): void {
  validateDeliveryIdentity(row.delivery_id, row.not_before_ms);
  if ((row.delivery_state !== "queued" && row.delivery_state !== "retry_wait") ||
      !Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0) {
    throw new Error("line_outbound_pending_row_invalid");
  }
}

function validateOutboundRow(row: LineOutboundRow): void {
  const states: readonly OutboundDeliveryState[] = ["queued", "dispatching", "retry_wait", "delivered",
    "not_delivered", "outcome_unknown", "retry_exhausted"];
  const pending = row.delivery_state === "queued" || row.delivery_state === "dispatching" || row.delivery_state === "retry_wait";
  const payloadValid = pending
    ? row.target !== null && isValidLineTarget(row.target) && row.text !== null && row.text.length > 0 &&
      row.text.length <= 1_000_000 && outboundPayloadDigest({ delivery_id: row.delivery_id, channel: "line",
        target: row.target, text: row.text, expires_at_ms: row.expires_at_ms }) === row.payload_digest
    : row.target === null && row.text === null;
  if (!/^[a-f0-9-]{36}$/iu.test(row.delivery_id) || !DIGEST.test(row.payload_digest) || row.channel !== "line" ||
      !states.includes(row.delivery_state) || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
      !Number.isSafeInteger(row.not_before_ms) || row.not_before_ms < 0 ||
      !Number.isSafeInteger(row.expires_at_ms) || row.expires_at_ms < row.created_at_ms ||
      (row.retry_after_ms !== null && (!Number.isSafeInteger(row.retry_after_ms) || row.retry_after_ms < 0)) ||
      (row.external_request_id !== null && (row.external_request_id.length === 0 || row.external_request_id.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(row.external_request_id))) ||
      (row.error_code !== null && !/^[a-z0-9_.-]{1,96}$/u.test(row.error_code)) ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0 || !payloadValid) {
    throw new Error("line_outbound_row_invalid");
  }
}

function validateOutboundSettlement(
  state: "delivered" | "not_delivered" | "outcome_unknown" | "retry_exhausted",
  result: { readonly external_request_id?: string; readonly error_code?: string; readonly retry_after_ms?: number },
): void {
  if (!( ["delivered", "not_delivered", "outcome_unknown", "retry_exhausted"] as const).includes(state) ||
      (result.external_request_id !== undefined && (result.external_request_id.length === 0 ||
        result.external_request_id.length > 512 || /[\u0000-\u001f\u007f]/u.test(result.external_request_id))) ||
      (result.error_code !== undefined && !/^[a-z0-9_.-]{1,96}$/u.test(result.error_code)) ||
      (result.retry_after_ms !== undefined && (!Number.isSafeInteger(result.retry_after_ms) || result.retry_after_ms < 0))) {
    throw new Error("line_outbound_settlement_invalid");
  }
}

function outboundPayloadDigest(input: LineOutboundDeliveryInput): string {
  return sha256(JSON.stringify([input.channel, input.target, input.text, input.expires_at_ms]));
}

function isValidLineTarget(target: string): boolean {
  return typeof target === "string" && /^[UCR][A-Za-z0-9_-]{1,511}$/u.test(target);
}

function validateEventRow(row: LineEventRow): void {
  if (!DIGEST.test(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) throw new Error("line_inbox_corrupt_row");
}

function isSafeIdentifier(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("line_inbox_timestamp_invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
