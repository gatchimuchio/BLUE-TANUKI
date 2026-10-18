import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;

export interface CronEventIdentity {
  readonly source: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly payload_digest: string;
}

export type CronEventDeliveryState = "dispatching" | "handler_returned" | "outcome_unknown";
export type CronEventResolutionState = "unacknowledged" | "owner_acknowledged_no_replay" | "verification_unavailable";

export interface CronEventCursorSnapshot {
  readonly source_digest: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly payload_digest: string;
  readonly delivery_state: CronEventDeliveryState;
  readonly resolution_state: CronEventResolutionState;
  readonly updated_at_ms: number;
}

export interface CronApprovalHandoffSnapshot {
  readonly source_digest: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly payload_digest: string;
  readonly command_id_digest: string;
  readonly state: "interrupted";
  readonly updated_at_ms: number;
}

export type CronApprovalHandoffResolution = "consumed" | "rejected" | "cancelled";

const MAX_CRON_APPROVAL_HANDOFFS = 10_000;

export type CronEventClaim =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate"; readonly delivery_state: CronEventDeliveryState }
  | { readonly status: "stale" }
  | { readonly status: "blocked_unresolved"; readonly delivery_state: CronEventDeliveryState }
  | { readonly status: "identity_conflict" };

export function createCronEventIdentity(
  source: string,
  sequence: number,
  payload_digest: string,
): CronEventIdentity {
  if (typeof source !== "string" || source.trim().length === 0 || source.length > 200 ||
      !Number.isSafeInteger(sequence) || sequence < 0 || !DIGEST.test(payload_digest)) {
    throw new Error("invalid cron event identity");
  }
  const normalizedSource = source.normalize("NFKC").trim();
  const source_digest = sha256(normalizedSource);
  return {
    source: normalizedSource,
    event_id: `cron-${sha256(`${source_digest}\0${sequence}`)}`,
    sequence,
    payload_digest,
  };
}

/**
 * Private, bounded inbox/outbox cursor for scheduled events. It keeps only the
 * latest sequence per source; older identities are rejected by the high-water
 * mark. The cursor prevents duplicate dispatch but is not proof of job success.
 */
export class GatewayCronEventStore {
  private readonly db: DatabaseType;
  private readonly verifyNoReplayDisposition?: (event_id: string, payload_digest: string) => boolean;

  constructor(filepath: string, opts: {
    verifyNoReplayDisposition?: (event_id: string, payload_digest: string) => boolean;
  } = {}) {
    this.verifyNoReplayDisposition = opts.verifyNoReplayDisposition;
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    if (process.platform !== "win32") chmodSync(filepath, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS cron_event_inbox (
        source_digest TEXT PRIMARY KEY CHECK(length(source_digest) = 64),
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        event_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cron_event_outbox (
        source_digest TEXT PRIMARY KEY REFERENCES cron_event_inbox(source_digest),
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('dispatching','handler_returned','outcome_unknown')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cron_approval_handoff (
        source_digest TEXT NOT NULL CHECK(length(source_digest) = 64),
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        event_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        command_id_digest TEXT NOT NULL CHECK(length(command_id_digest) = 64),
        request_id_digest TEXT NOT NULL CHECK(length(request_id_digest) = 64),
        state TEXT NOT NULL CHECK(state IN ('pending','interrupted','consumed','rejected','cancelled')),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(event_id,command_id_digest)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cron_approval_handoff_command_ref
        ON cron_approval_handoff(command_id_digest);
      CREATE INDEX IF NOT EXISTS cron_approval_handoff_request_ref
        ON cron_approval_handoff(request_id_digest);`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") {
        throw new Error("cron_event_store_integrity_check_failed");
      }
      if (this.db.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("cron_event_store_foreign_key_check_failed");
      }
      this.db.prepare(`SELECT i.source_digest,i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
        o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
        o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
        FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest LIMIT 0`);
      const handoffRows = this.db.prepare(`SELECT source_digest,sequence,event_id,payload_digest,command_id_digest,
        request_id_digest,state,created_at_ms,updated_at_ms FROM cron_approval_handoff`).all() as unknown as CronApprovalHandoffRow[];
      if (handoffRows.length > MAX_CRON_APPROVAL_HANDOFFS) {
        throw new Error("cron approval handoff capacity exceeded");
      }
      for (const row of handoffRows) validateApprovalHandoffRow(row);
      this.transaction(() => {});
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    opts: { verifyNoReplayDisposition?: (event_id: string, payload_digest: string) => boolean } = {},
  ): GatewayCronEventStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "cron-events");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("cron_event_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "cron-events.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("cron_event_state_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayCronEventStore(filepath, opts);
  }

  claim(event: CronEventIdentity, now_ms = Date.now()): CronEventClaim {
    validateEvent(event);
    if (!Number.isSafeInteger(now_ms) || now_ms < 0) throw new Error("invalid cron event receipt time");
    const source_digest = sha256(event.source);
    return this.transaction(() => {
      const current = this.readCurrentCursor(source_digest);
      if (current && event.sequence < current.sequence) return { status: "stale" } as const;
      if (current && event.sequence === current.sequence) {
        if (current.event_id !== event.event_id || current.payload_digest !== event.payload_digest) {
          return { status: "identity_conflict" } as const;
        }
        return { status: "duplicate", delivery_state: current.delivery_state } as const;
      }
      if (current && current.delivery_state !== "handler_returned" &&
          this.resolutionState(current.event_id, current.payload_digest) !== "owner_acknowledged_no_replay") {
        return { status: "blocked_unresolved", delivery_state: current.delivery_state } as const;
      }

      this.db.prepare(`INSERT INTO cron_event_inbox
        (source_digest,sequence,event_id,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,?, 'dispatching',?)
        ON CONFLICT(source_digest) DO UPDATE SET sequence=excluded.sequence,event_id=excluded.event_id,
          payload_digest=excluded.payload_digest,delivery_state='dispatching',updated_at_ms=excluded.updated_at_ms`)
        .run(source_digest, event.sequence, event.event_id, event.payload_digest, now_ms);
      this.db.prepare(`INSERT INTO cron_event_outbox
        (source_digest,event_id,sequence,payload_digest,delivery_state,updated_at_ms)
        VALUES (?,?,?,?, 'dispatching',?)
        ON CONFLICT(source_digest) DO UPDATE SET event_id=excluded.event_id,sequence=excluded.sequence,
          payload_digest=excluded.payload_digest,delivery_state='dispatching',updated_at_ms=excluded.updated_at_ms`)
        .run(source_digest, event.event_id, event.sequence, event.payload_digest, now_ms);
      return { status: "accepted" } as const;
    });
  }

  settle(event: CronEventIdentity, state: Exclude<CronEventDeliveryState, "dispatching">, now_ms = Date.now()): void {
    validateEvent(event);
    if (!Number.isSafeInteger(now_ms) || now_ms < 0) throw new Error("invalid cron event receipt time");
    const source_digest = sha256(event.source);
    this.transaction(() => {
      const inbox = this.db.prepare(`UPDATE cron_event_inbox SET delivery_state=?,updated_at_ms=?
        WHERE source_digest=? AND sequence=? AND event_id=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, now_ms, source_digest, event.sequence, event.event_id, event.payload_digest);
      const outbox = this.db.prepare(`UPDATE cron_event_outbox SET delivery_state=?,updated_at_ms=?
        WHERE source_digest=? AND sequence=? AND event_id=? AND payload_digest=? AND delivery_state='dispatching'`)
        .run(state, now_ms, source_digest, event.sequence, event.event_id, event.payload_digest);
      if (Number(inbox.changes) !== 1 || Number(outbox.changes) !== 1) {
        throw new Error("cron event settlement does not match the current dispatch");
      }
    });
  }

  unresolvedEvents(): CronEventCursorSnapshot[] {
    const rows = this.db.prepare(`SELECT i.source_digest,i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
      o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
      o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
      FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest
      ORDER BY i.updated_at_ms DESC,i.source_digest ASC`).all() as Array<{
        source_digest: string;
        sequence: number;
        event_id: string;
        payload_digest: string;
        delivery_state: string;
        updated_at_ms: number;
        outbox_event_id?: string;
        outbox_sequence?: number;
        outbox_payload_digest?: string;
        outbox_delivery_state?: string;
        outbox_updated_at_ms?: number;
      }>;
    const orphan = this.db.prepare(`SELECT 1 AS present FROM cron_event_outbox o
      LEFT JOIN cron_event_inbox i ON i.source_digest=o.source_digest WHERE i.source_digest IS NULL LIMIT 1`).get();
    if (orphan) throw new Error("cron_event_store_orphan_outbox_detected");
    return rows
      .map((row) => {
        const cursor = parseCursorRow(row.source_digest, row);
        return { ...cursor, resolution_state: this.resolutionState(cursor.event_id, cursor.payload_digest) };
      })
      .filter((row) => row.delivery_state !== "handler_returned");
  }

  unresolvedEvent(event_id: string, payload_digest: string): CronEventCursorSnapshot | undefined {
    if (typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
        typeof payload_digest !== "string" || !DIGEST.test(payload_digest)) return undefined;
    return this.unresolvedEvents().find((event) => event.event_id === event_id && event.payload_digest === payload_digest);
  }

  recordPendingApproval(
    event_id: string,
    payload_digest: string,
    command_id: string,
    request_id: string,
    now_ms = Date.now(),
  ): void {
    validateApprovalHandoffInput(event_id, payload_digest, command_id, request_id, now_ms);
    const command_id_digest = sha256(command_id);
    const request_id_digest = sha256(request_id);
    this.transaction(() => {
      const row = this.db.prepare(`SELECT i.source_digest,i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
        o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
        o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
        FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest
        WHERE i.event_id=?`).get(event_id) as {
          source_digest: string; sequence: number; event_id: string; payload_digest: string;
          delivery_state: CronEventDeliveryState; updated_at_ms: number; outbox_event_id?: string;
          outbox_sequence?: number; outbox_payload_digest?: string; outbox_delivery_state?: CronEventDeliveryState;
          outbox_updated_at_ms?: number;
        } | undefined;
      if (!row) throw new Error("cron approval handoff event is not present in the durable cursor");
      const cursor = parseCursorRow(row.source_digest, row);
      if (cursor.event_id !== event_id || cursor.payload_digest !== payload_digest || cursor.delivery_state !== "dispatching") {
        throw new Error("cron approval handoff event is stale or not dispatching");
      }

      const existing = this.db.prepare(`SELECT source_digest,sequence,event_id,payload_digest,command_id_digest,
        request_id_digest,state,created_at_ms,updated_at_ms FROM cron_approval_handoff
        WHERE event_id=? AND command_id_digest=?`).get(event_id, command_id_digest) as CronApprovalHandoffRow | undefined;
      if (existing) {
        validateApprovalHandoffRow(existing);
        if (existing.source_digest !== cursor.source_digest || existing.sequence !== cursor.sequence ||
            existing.payload_digest !== payload_digest || existing.request_id_digest !== request_id_digest ||
            existing.state !== "pending") {
          throw new Error("cron approval handoff identity conflicts with a saved record");
        }
        return;
      }

      const count = this.db.prepare("SELECT COUNT(*) AS count FROM cron_approval_handoff").get() as { count: number };
      if (!Number.isSafeInteger(count.count) || count.count >= MAX_CRON_APPROVAL_HANDOFFS) {
        throw new Error("cron approval handoff capacity reached; new approvals are blocked");
      }
      this.db.prepare(`INSERT INTO cron_approval_handoff
        (source_digest,sequence,event_id,payload_digest,command_id_digest,request_id_digest,state,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,'pending',?,?)`)
        .run(cursor.source_digest, cursor.sequence, event_id, payload_digest, command_id_digest, request_id_digest, now_ms, now_ms);
    });
  }

  resolvePendingApproval(
    event_id: string,
    payload_digest: string,
    command_id: string,
    request_id: string,
    resolution: CronApprovalHandoffResolution,
    now_ms = Date.now(),
  ): void {
    validateApprovalHandoffInput(event_id, payload_digest, command_id, request_id, now_ms);
    if (resolution !== "consumed" && resolution !== "rejected" && resolution !== "cancelled") {
      throw new Error("invalid cron approval handoff resolution");
    }
    const command_id_digest = sha256(command_id);
    const request_id_digest = sha256(request_id);
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE cron_approval_handoff SET state=?,updated_at_ms=?
        WHERE event_id=? AND payload_digest=? AND command_id_digest=? AND request_id_digest=? AND state='pending'`)
        .run(resolution, now_ms, event_id, payload_digest, command_id_digest, request_id_digest);
      if (Number(update.changes) === 1) return;
      const existing = this.db.prepare(`SELECT source_digest,sequence,event_id,payload_digest,command_id_digest,
        request_id_digest,state,created_at_ms,updated_at_ms FROM cron_approval_handoff
        WHERE event_id=? AND command_id_digest=?`).get(event_id, command_id_digest) as CronApprovalHandoffRow | undefined;
      if (existing) validateApprovalHandoffRow(existing);
      if (!existing || existing.payload_digest !== payload_digest || existing.request_id_digest !== request_id_digest ||
          existing.state !== resolution) {
        throw new Error("cron approval handoff is missing, stale, or already resolved differently");
      }
    });
  }

  recoverPendingApprovalHandoffs(now_ms = Date.now()): number {
    if (!Number.isSafeInteger(now_ms) || now_ms < 0) throw new Error("invalid cron approval recovery time");
    const result = this.db.prepare(`UPDATE cron_approval_handoff SET state='interrupted',updated_at_ms=?
      WHERE state='pending'`).run(now_ms);
    return Number(result.changes);
  }

  interruptedApprovalHandoffs(): CronApprovalHandoffSnapshot[] {
    const rows = this.db.prepare(`SELECT source_digest,sequence,event_id,payload_digest,command_id_digest,
      request_id_digest,state,created_at_ms,updated_at_ms FROM cron_approval_handoff
      WHERE state='interrupted' ORDER BY updated_at_ms DESC,event_id ASC,command_id_digest ASC`).all() as unknown as CronApprovalHandoffRow[];
    return rows.map((row) => {
      validateApprovalHandoffRow(row);
      return {
        source_digest: row.source_digest,
        sequence: row.sequence,
        event_id: row.event_id,
        payload_digest: row.payload_digest,
        command_id_digest: row.command_id_digest,
        state: "interrupted" as const,
        updated_at_ms: row.updated_at_ms,
      };
    });
  }

  hasCronApprovalReference(reference: string): boolean {
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 500) return false;
    const digest = sha256(reference);
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM cron_approval_handoff
      WHERE command_id_digest=? OR request_id_digest=? LIMIT 1`).get(digest, digest));
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain the original failure */ }
      throw error;
    }
  }

  private readCurrentCursor(source_digest: string): {
    sequence: number;
    event_id: string;
    payload_digest: string;
    delivery_state: CronEventDeliveryState;
  } | undefined {
    const row = this.db.prepare(`SELECT i.sequence,i.event_id,i.payload_digest,i.delivery_state,i.updated_at_ms,
      o.event_id AS outbox_event_id,o.sequence AS outbox_sequence,o.payload_digest AS outbox_payload_digest,
      o.delivery_state AS outbox_delivery_state,o.updated_at_ms AS outbox_updated_at_ms
      FROM cron_event_inbox i LEFT JOIN cron_event_outbox o ON o.source_digest=i.source_digest
      WHERE i.source_digest=?`).get(source_digest) as {
        sequence: number; event_id: string; payload_digest: string; delivery_state: CronEventDeliveryState;
        updated_at_ms: number; outbox_event_id?: string; outbox_sequence?: number;
        outbox_payload_digest?: string; outbox_delivery_state?: CronEventDeliveryState;
        outbox_updated_at_ms?: number;
      } | undefined;
    if (!row) {
      const orphan = this.db.prepare("SELECT 1 AS present FROM cron_event_outbox WHERE source_digest=?").get(source_digest);
      if (orphan) throw new Error("cron_event_store_orphan_outbox_detected");
      return undefined;
    }
    const snapshot = parseCursorRow(source_digest, row);
    return {
      sequence: snapshot.sequence,
      event_id: snapshot.event_id,
      payload_digest: snapshot.payload_digest,
      delivery_state: snapshot.delivery_state,
    };
  }

  private resolutionState(event_id: string, payload_digest: string): CronEventResolutionState {
    if (!this.verifyNoReplayDisposition) return "unacknowledged";
    try {
      return this.verifyNoReplayDisposition(event_id, payload_digest)
        ? "owner_acknowledged_no_replay"
        : "unacknowledged";
    } catch {
      return "verification_unavailable";
    }
  }
}

interface CronApprovalHandoffRow {
  source_digest: string;
  sequence: number;
  event_id: string;
  payload_digest: string;
  command_id_digest: string;
  request_id_digest: string;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function validateApprovalHandoffInput(
  event_id: string,
  payload_digest: string,
  command_id: string,
  request_id: string,
  now_ms: number,
): void {
  if (typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
      typeof payload_digest !== "string" || !DIGEST.test(payload_digest) ||
      typeof command_id !== "string" || command_id.length === 0 || command_id.length > 500 ||
      typeof request_id !== "string" || request_id.length === 0 || request_id.length > 500 ||
      !Number.isSafeInteger(now_ms) || now_ms < 0) {
    throw new Error("invalid cron approval handoff identity");
  }
}

function validateApprovalHandoffRow(row: CronApprovalHandoffRow): void {
  if (!DIGEST.test(row.source_digest) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 ||
      row.event_id !== `cron-${sha256(`${row.source_digest}\0${row.sequence}`)}` ||
      !DIGEST.test(row.payload_digest) || !DIGEST.test(row.command_id_digest) || !DIGEST.test(row.request_id_digest) ||
      !["pending", "interrupted", "consumed", "rejected", "cancelled"].includes(row.state) ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
    throw new Error("cron approval handoff integrity check failed");
  }
}

function parseCursorRow(
  source_digest: string,
  row: {
    sequence: number;
    event_id: string;
    payload_digest: string;
    delivery_state: string;
    updated_at_ms: number;
    outbox_event_id?: string;
    outbox_sequence?: number;
    outbox_payload_digest?: string;
    outbox_delivery_state?: string;
    outbox_updated_at_ms?: number;
  },
): CronEventCursorSnapshot {
  if (!DIGEST.test(source_digest) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 ||
      row.event_id !== `cron-${sha256(`${source_digest}\0${row.sequence}`)}` || !DIGEST.test(row.payload_digest) ||
      (row.delivery_state !== "dispatching" && row.delivery_state !== "handler_returned" && row.delivery_state !== "outcome_unknown") ||
      !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0 ||
      row.outbox_event_id !== row.event_id || row.outbox_sequence !== row.sequence ||
      row.outbox_payload_digest !== row.payload_digest || row.outbox_delivery_state !== row.delivery_state ||
      row.outbox_updated_at_ms !== row.updated_at_ms) {
    throw new Error("cron_event_store_cursor_integrity_failed");
  }
  return {
    source_digest,
    sequence: row.sequence,
    event_id: row.event_id,
    payload_digest: row.payload_digest,
    delivery_state: row.delivery_state,
    resolution_state: "unacknowledged",
    updated_at_ms: row.updated_at_ms,
  };
}

function validateEvent(event: CronEventIdentity): void {
  if (!event || typeof event !== "object" || typeof event.source !== "string" ||
      event.source.length === 0 || event.source.length > 200 ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
      !DIGEST.test(event.payload_digest) ||
      event.event_id !== `cron-${sha256(`${sha256(event.source)}\0${event.sequence}`)}`) {
    throw new Error("invalid cron event identity");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
