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
interface SlackEventInbox {
  claim(event_id: string, payload_digest: string): SlackEventClaim;
  settle(event_id: string, payload_digest: string, state: "handler_returned" | "outcome_unknown"): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;

/** Content-free durable replay boundary for one Slack bot installation. */
export class GatewaySlackEventStore implements SlackEventInbox {
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
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
      this.db.exec(`CREATE TABLE IF NOT EXISTS slack_event_inbox (
        bot_scope_digest TEXT NOT NULL CHECK(length(bot_scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(bot_scope_digest, event_digest)
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("slack_inbox_integrity_check_failed");
      this.transaction(() => {
        // If the process stopped during admission, never assume the handler did nothing.
        this.db.prepare(`UPDATE slack_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
