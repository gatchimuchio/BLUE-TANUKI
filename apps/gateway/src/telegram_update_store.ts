import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type { TelegramOutboundDeliveryState, TelegramOutboundDeliveryStore, TelegramUpdateInbox } from "@blue-tanuki/channel-telegram";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;
const CREATE_CURSOR = `CREATE TABLE telegram_update_cursor (
  bot_scope_digest TEXT PRIMARY KEY CHECK(length(bot_scope_digest) = 64),
  update_id INTEGER NOT NULL CHECK(update_id >= 0),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT`;
const CREATE_OUTBOUND = `CREATE TABLE telegram_outbound_delivery (
  bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
  delivery_digest TEXT NOT NULL CHECK(length(delivery_digest) = 64),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','delivered','not_delivered','outcome_unknown')),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(bot_scope_digest, delivery_digest)
) STRICT`;

export type TelegramUpdateDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type TelegramUpdateClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: TelegramUpdateDeliveryState }
  | { readonly status: "stale" }
  | { readonly status: "blocked_unresolved"; readonly delivery_state: TelegramUpdateDeliveryState }
  | { readonly status: "identity_conflict" };

export type TelegramDeliveryNotificationSnapshot =
  | { readonly status: "available"; readonly unknown_count: number;
      readonly recent_unknown: readonly { delivery_digest: string; updated_at_ms: number }[] }
  | { readonly status: "unavailable"; readonly unknown_count: null; readonly recent_unknown: readonly [] };

/**
 * Durable admission and outbound delivery evidence for one Telegram bot.
 * Update and send bodies, target identifiers, and credentials are kept off disk.
 */
export class GatewayTelegramUpdateStore implements TelegramUpdateInbox, TelegramOutboundDeliveryStore {
  private db: DatabaseType;
  private closed = false;
  private readonly botScopeDigest: string;

  constructor(filepath: string, botToken: string) {
    if (typeof botToken !== "string" || botToken.trim().length === 0) {
      throw new Error("telegram_inbox_bot_token_required");
    }
    const databasePath = resolve(filepath);
    this.botScopeDigest = sha256(`telegram-bot-scope.v1\0${botToken}`);
    mkdirSync(dirname(databasePath), { recursive: true });
    const existing = prepareDatabaseFile(databasePath);
    this.db = new DatabaseSync(databasePath);
    this.initializeDatabase(databasePath, existing);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, botToken: string): GatewayTelegramUpdateStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "telegram-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) throw new Error("telegram_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    }
    return new GatewayTelegramUpdateStore(join(directory, "telegram-inbox.sqlite"), botToken);
  }

  private initializeDatabase(databasePath: string, existing: boolean): void {
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA");
      if (this.db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
        throw new Error("telegram_inbox_journal_mode_invalid");
      }
      this.transaction(() => {
        let hasOutbound = false;
        if (existing) {
          const integrity = this.db.prepare("PRAGMA quick_check(1)").get();
          if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("telegram_inbox_integrity_check_failed");
          hasOutbound = validateExistingSchema(this.db);
          this.readCursor();
          if (hasOutbound && this.db.prepare(`SELECT 1 FROM telegram_outbound_delivery WHERE bot_scope_digest=? AND
            (delivery_digest GLOB '*[^0-9a-f]*' OR updated_at_ms>?) LIMIT 1`)
            .get(this.botScopeDigest, Number.MAX_SAFE_INTEGER)) {
            throw new Error("telegram_outbound_delivery_state_invalid");
          }
          if (process.platform !== "win32" && (lstatSync(databasePath).mode & 0o777) !== 0o600) chmodSync(databasePath, 0o600);
        } else {
          this.db.exec(CREATE_CURSOR);
        }
        if (!hasOutbound) this.db.exec(CREATE_OUTBOUND);
        const nowMs = Date.now();
        // A process interrupted after admission cannot prove whether Gateway
        // began acting. Keep the cursor and suppress replay as outcome-unknown.
        this.db.prepare(`UPDATE telegram_update_cursor SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(nowMs, this.botScopeDigest);
        this.db.prepare(`UPDATE telegram_outbound_delivery SET delivery_state='outcome_unknown',updated_at_ms=MAX(updated_at_ms,?)
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(nowMs, this.botScopeDigest);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  latestUpdateId(): number | null {
    this.assertOpen();
    return this.readCursor()?.update_id ?? null;
  }

  claim(updateId: number, payloadDigest: string, nowMs = Date.now()): TelegramUpdateClaim {
    validateIdentity(updateId, payloadDigest, nowMs);
    return this.transaction(() => {
      const current = this.readCursor();
      if (current) {
        if (updateId < current.update_id) return { status: "stale" } as const;
        if (updateId === current.update_id) {
          if (payloadDigest !== current.payload_digest) return { status: "identity_conflict" } as const;
          return { status: "duplicate", delivery_state: current.delivery_state } as const;
        }
        if (current.delivery_state === "dispatching") {
          return { status: "blocked_unresolved", delivery_state: current.delivery_state } as const;
        }
      }
      this.db.prepare(`INSERT INTO telegram_update_cursor
        (bot_scope_digest,update_id,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,'dispatching',?)
        ON CONFLICT(bot_scope_digest) DO UPDATE SET update_id=excluded.update_id,
          payload_digest=excluded.payload_digest,delivery_state='dispatching',updated_at_ms=excluded.updated_at_ms`)
        .run(this.botScopeDigest, updateId, payloadDigest, nowMs);
      return { status: "accepted" } as const;
    });
  }

  settle(updateId: number, payloadDigest: string, state: Exclude<TelegramUpdateDeliveryState, "dispatching">, nowMs = Date.now()): void {
    validateIdentity(updateId, payloadDigest, nowMs);
    if (state !== "handler_returned" && state !== "outcome_unknown") throw new Error("telegram_inbox_delivery_state_invalid");
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE telegram_update_cursor SET delivery_state=?,updated_at_ms=?
        WHERE bot_scope_digest=? AND update_id=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.botScopeDigest, updateId, payloadDigest);
      if (Number(update.changes) === 1) return;
      const current = this.readCursor();
      if (!current || current.update_id !== updateId || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("telegram_inbox_settlement_conflict");
      }
    });
  }

  beginDelivery(commandId: string, nowMs = Date.now()): ReturnType<TelegramOutboundDeliveryStore["beginDelivery"]> {
    if (typeof commandId !== "string" || commandId.trim().length === 0 || !validTimestamp(nowMs)) {
      throw new Error("telegram_outbound_delivery_identity_invalid");
    }
    const deliveryDigest = sha256(JSON.stringify(["telegram-outbound-delivery.v1", this.botScopeDigest, commandId]));
    return this.transaction(() => {
      const current = this.readOutboundState(deliveryDigest);
      if (current) return { status: "duplicate", delivery_state: current };
      this.db.prepare(`INSERT INTO telegram_outbound_delivery (bot_scope_digest,delivery_digest,delivery_state,updated_at_ms)
        VALUES (?,?,'dispatching',?)`).run(this.botScopeDigest, deliveryDigest, nowMs);
      return { status: "accepted", delivery_digest: deliveryDigest };
    });
  }

  settleDelivery(deliveryDigest: string, state: Exclude<TelegramOutboundDeliveryState, "dispatching">, nowMs = Date.now()): void {
    if (!validDigest(deliveryDigest) || !validTimestamp(nowMs) ||
        (state !== "delivered" && state !== "not_delivered" && state !== "outcome_unknown")) {
      throw new Error("telegram_outbound_delivery_settlement_invalid");
    }
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE telegram_outbound_delivery SET delivery_state=?,updated_at_ms=MAX(updated_at_ms,?)
        WHERE bot_scope_digest=? AND delivery_digest=? AND delivery_state='dispatching'`)
        .run(state, nowMs, this.botScopeDigest, deliveryDigest);
      if (Number(update.changes) !== 1 && this.readOutboundState(deliveryDigest) !== state) {
        throw new Error("telegram_outbound_delivery_settlement_conflict");
      }
    });
  }

  unknownDeliverySnapshot(): TelegramDeliveryNotificationSnapshot {
    try {
      this.assertOpen();
      const rows = this.db.prepare(`SELECT delivery_digest, updated_at_ms, COUNT(*) OVER () AS unknown_count
        FROM telegram_outbound_delivery WHERE bot_scope_digest=? AND delivery_state='outcome_unknown'
        ORDER BY updated_at_ms DESC, delivery_digest LIMIT 20`).all(this.botScopeDigest) as unknown as
        { delivery_digest: string; updated_at_ms: number; unknown_count: number }[];
      const unknownCount = rows[0]?.unknown_count ?? 0;
      if (!validTimestamp(unknownCount) || rows.length !== Math.min(unknownCount, 20) || rows.some(row =>
        !validDigest(row.delivery_digest) || !validTimestamp(row.updated_at_ms) || row.unknown_count !== unknownCount)) {
        throw new Error("telegram_outbound_delivery_snapshot_invalid");
      }
      return { status: "available", unknown_count: unknownCount,
        recent_unknown: rows.map(({ delivery_digest, updated_at_ms }) => ({ delivery_digest, updated_at_ms })) };
    } catch {
      return { status: "unavailable", unknown_count: null, recent_unknown: [] };
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  isClosed(): boolean { return this.closed; }

  private readCursor(): TelegramUpdateCursorRow | undefined {
    const row = this.db.prepare(`SELECT update_id,payload_digest,delivery_state,updated_at_ms
      FROM telegram_update_cursor WHERE bot_scope_digest=?`).get(this.botScopeDigest) as TelegramUpdateCursorRow | undefined;
    if (row) validateCursorRow(row);
    return row;
  }

  private readOutboundState(deliveryDigest: string): TelegramOutboundDeliveryState | undefined {
    const row = this.db.prepare(`SELECT delivery_state FROM telegram_outbound_delivery
      WHERE bot_scope_digest=? AND delivery_digest=?`).get(this.botScopeDigest, deliveryDigest);
    if (!row) return undefined;
    const state = row.delivery_state;
    if (state !== "dispatching" && state !== "delivered" && state !== "not_delivered" && state !== "outcome_unknown") {
      throw new Error("telegram_outbound_delivery_state_invalid");
    }
    return state;
  }

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
    if (this.closed) throw new Error("telegram_inbox_store_closed");
  }
}

interface TelegramUpdateCursorRow {
  update_id: number;
  payload_digest: string;
  delivery_state: TelegramUpdateDeliveryState;
  updated_at_ms: number;
}

function prepareDatabaseFile(filepath: string): boolean {
  try {
    const file = lstatSync(filepath);
    if (!file.isFile()) throw new Error("telegram_inbox_state_file_not_regular");
    if (file.size === 0) throw new Error("telegram_inbox_existing_database_empty");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    closeSync(openSync(filepath, "wx", 0o600));
    return false;
  }
}

function validateExistingSchema(database: DatabaseType): boolean {
  const objects = database.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  const canonical = (sql: string): string => sql.trim().replace(/\s+/gu, " ").replace(/\s*([(),=<>])\s*/gu, "$1");
  const expectedTables = new Map([["telegram_update_cursor", CREATE_CURSOR], ["telegram_outbound_delivery", CREATE_OUTBOUND]]);
  if (!objects.some(row => row.name === "telegram_update_cursor") || objects.some(row => {
    const expected = typeof row.name === "string" ? expectedTables.get(row.name) : undefined;
    return row.type !== "table" || typeof row.sql !== "string" || expected === undefined || canonical(row.sql) !== canonical(expected);
  })) throw new Error("telegram_inbox_schema_invalid");
  return objects.some(row => row.name === "telegram_outbound_delivery");
}

function validateIdentity(updateId: number, payloadDigest: string, nowMs: number): void {
  if (!Number.isSafeInteger(updateId) || updateId < 0 || updateId >= Number.MAX_SAFE_INTEGER ||
      !DIGEST.test(payloadDigest) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("telegram_inbox_identity_invalid");
  }
}

function validateCursorRow(row: TelegramUpdateCursorRow): void {
  if (!Number.isSafeInteger(row.update_id) || row.update_id < 0 || row.update_id >= Number.MAX_SAFE_INTEGER ||
      !validDigest(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("telegram_inbox_cursor_invalid");
  }
}

function validDigest(value: string): boolean {
  return typeof value === "string" && value.length === 64 && DIGEST.test(value);
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
