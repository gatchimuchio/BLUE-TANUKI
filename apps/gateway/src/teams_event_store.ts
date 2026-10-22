import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
type DeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";

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
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("teams_inbox_integrity_check_failed");
      this.db.prepare(`UPDATE teams_event_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
        WHERE bot_scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), this.botScopeDigest);
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
