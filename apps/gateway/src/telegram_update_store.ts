import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type { TelegramUpdateInbox } from "@blue-tanuki/channel-telegram";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;

export type TelegramUpdateDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type TelegramUpdateClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: TelegramUpdateDeliveryState }
  | { readonly status: "stale" }
  | { readonly status: "blocked_unresolved"; readonly delivery_state: TelegramUpdateDeliveryState }
  | { readonly status: "identity_conflict" };

/**
 * Durable, content-free admission cursor for one Telegram bot. The update body
 * is never persisted; only its digest and delivery state survive a restart.
 */
export class GatewayTelegramUpdateStore implements TelegramUpdateInbox {
  private db: DatabaseType;
  private closed = false;
  private readonly botScopeDigest: string;
  private readonly filepath: string;

  constructor(filepath: string, botToken: string) {
    if (typeof botToken !== "string" || botToken.trim().length === 0) {
      throw new Error("telegram_inbox_bot_token_required");
    }
    this.filepath = filepath;
    this.botScopeDigest = sha256(`telegram-bot-scope.v1\0${botToken}`);
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.initializeDatabase();
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, botToken: string): GatewayTelegramUpdateStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "telegram-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("telegram_inbox_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "telegram-inbox.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("telegram_inbox_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayTelegramUpdateStore(filepath, botToken);
  }

  private initializeDatabase(): void {
    if (process.platform !== "win32") chmodSync(this.filepath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
      this.db.exec(`CREATE TABLE IF NOT EXISTS telegram_update_cursor (
        bot_scope_digest TEXT PRIMARY KEY CHECK(length(bot_scope_digest) = 64),
        update_id INTEGER NOT NULL CHECK(update_id >= 0),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("telegram_inbox_integrity_check_failed");
      this.transaction(() => {
        // A process interrupted after admission cannot prove whether Gateway
        // began acting. Keep the cursor and suppress replay as outcome-unknown.
        this.db.prepare(`UPDATE telegram_update_cursor SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  latestUpdateId(): number | null {
    this.assertOpen();
    const row = this.db.prepare(`SELECT update_id,payload_digest,delivery_state,updated_at_ms
      FROM telegram_update_cursor WHERE bot_scope_digest=?`).get(this.botScopeDigest) as TelegramUpdateCursorRow | undefined;
    if (!row) return null;
    validateCursorRow(row);
    return row.update_id;
  }

  claim(updateId: number, payloadDigest: string, nowMs = Date.now()): TelegramUpdateClaim {
    validateIdentity(updateId, payloadDigest, nowMs);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT update_id,payload_digest,delivery_state,updated_at_ms
        FROM telegram_update_cursor WHERE bot_scope_digest=?`).get(this.botScopeDigest) as TelegramUpdateCursorRow | undefined;
      if (current) {
        validateCursorRow(current);
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
      const current = this.db.prepare(`SELECT update_id,payload_digest,delivery_state,updated_at_ms
        FROM telegram_update_cursor WHERE bot_scope_digest=?`).get(this.botScopeDigest) as TelegramUpdateCursorRow | undefined;
      if (current) validateCursorRow(current);
      if (!current || current.update_id !== updateId || current.payload_digest !== payloadDigest || current.delivery_state !== state) {
        throw new Error("telegram_inbox_settlement_conflict");
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
    if (this.closed) throw new Error("telegram_inbox_store_closed");
  }
}

interface TelegramUpdateCursorRow {
  update_id: number;
  payload_digest: string;
  delivery_state: TelegramUpdateDeliveryState;
  updated_at_ms: number;
}

function validateIdentity(updateId: number, payloadDigest: string, nowMs: number): void {
  if (!Number.isSafeInteger(updateId) || updateId < 0 || updateId >= Number.MAX_SAFE_INTEGER ||
      !DIGEST.test(payloadDigest) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("telegram_inbox_identity_invalid");
  }
}

function validateCursorRow(row: TelegramUpdateCursorRow): void {
  if (!Number.isSafeInteger(row.update_id) || row.update_id < 0 || !DIGEST.test(row.payload_digest) ||
      !["dispatching", "handler_returned", "outcome_unknown"].includes(row.delivery_state) ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("telegram_inbox_cursor_invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
