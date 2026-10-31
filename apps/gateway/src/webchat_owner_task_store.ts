import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type {
  WebChatOwnerTaskSubmissionClaim,
  WebChatOwnerTaskSubmissionState,
  WebChatOwnerTaskSubmissionStore,
} from "@blue-tanuki/channel-webchat";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/u;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER_TASK_SCOPE = sha256("webchat-owner-task-scope.v1");

interface SubmissionRow {
  readonly payload_digest: string;
  readonly request_id: string;
  readonly delivery_state: WebChatOwnerTaskSubmissionState;
}

/** Durable, content-free inbox for deduplicating authenticated WebChat owner task submissions. */
export class GatewayWebChatOwnerTaskStore implements WebChatOwnerTaskSubmissionStore {
  private readonly db: DatabaseType;
  private closed = false;

  constructor(filepath: string) {
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("webchat_owner_task_store_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new DatabaseSync(filepath);
    try {
      if (process.platform !== "win32") chmodSync(filepath, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON");
      this.db.exec(`CREATE TABLE IF NOT EXISTS webchat_owner_task_inbox (
        scope_digest TEXT NOT NULL CHECK(length(scope_digest) = 64),
        event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
        payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
        request_id TEXT NOT NULL UNIQUE,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('dispatching','handler_returned','outcome_unknown','rejected')),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
        PRIMARY KEY(scope_digest,event_digest)
      ) STRICT;`);
      const integrity = this.db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") {
        throw new Error("webchat_owner_task_store_integrity_check_failed");
      }
      // A previous process may have stopped after claiming the event but before completing the handler.
      // Preserve the event identity and refuse replay; never infer that no work started.
      this.transaction(() => {
        this.db.prepare(`UPDATE webchat_owner_task_inbox SET delivery_state='outcome_unknown',updated_at_ms=?
          WHERE scope_digest=? AND delivery_state='dispatching'`).run(Date.now(), OWNER_TASK_SCOPE);
      });
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayWebChatOwnerTaskStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    if (lstatSync(stateRoot).isSymbolicLink()) throw new Error("webchat_owner_task_state_root_must_not_be_symlink");
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "webchat-owner-task-inbox");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("webchat_owner_task_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    return new GatewayWebChatOwnerTaskStore(join(directory, "owner-task-inbox.sqlite"));
  }

  claim(input: { readonly submission_id: string; readonly payload_digest: string; readonly request_id: string }):
    WebChatOwnerTaskSubmissionClaim {
    this.assertOpen();
    if (!SUBMISSION_ID.test(input.submission_id) || !DIGEST.test(input.payload_digest) ||
        !REQUEST_ID.test(input.request_id)) throw new Error("webchat_owner_task_claim_invalid");
    const eventDigest = sha256(`webchat-owner-task-event.v1\0${input.submission_id.toLowerCase()}`);
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT payload_digest,request_id,delivery_state
        FROM webchat_owner_task_inbox WHERE scope_digest=? AND event_digest=?`)
        .get(OWNER_TASK_SCOPE, eventDigest) as SubmissionRow | undefined;
      if (current) {
        validateSubmissionRow(current);
        return current.payload_digest === input.payload_digest
          ? { status: "duplicate", request_id: current.request_id, state: current.delivery_state } as const
          : { status: "identity_conflict", request_id: current.request_id } as const;
      }
      const now = Date.now();
      this.db.prepare(`INSERT INTO webchat_owner_task_inbox
        (scope_digest,event_digest,payload_digest,request_id,delivery_state,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,'dispatching',?,?)`)
        .run(OWNER_TASK_SCOPE, eventDigest, input.payload_digest, input.request_id, now, now);
      return { status: "accepted", request_id: input.request_id } as const;
    });
  }

  markHandlerReturned(request_id: string): void {
    this.updateDispatchState(request_id, "handler_returned");
  }

  markOutcomeUnknown(request_id: string): void {
    this.updateDispatchState(request_id, "outcome_unknown");
  }

  markRejected(request_id: string): void {
    this.updateDispatchState(request_id, "rejected");
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private updateDispatchState(requestId: string, state: Exclude<WebChatOwnerTaskSubmissionState, "dispatching">): void {
    this.assertOpen();
    if (!REQUEST_ID.test(requestId)) throw new Error("webchat_owner_task_request_id_invalid");
    const result = this.db.prepare(`UPDATE webchat_owner_task_inbox SET delivery_state=?,updated_at_ms=?
      WHERE scope_digest=? AND request_id=? AND delivery_state='dispatching'`)
      .run(state, Date.now(), OWNER_TASK_SCOPE, requestId);
    if (result.changes !== 1) throw new Error("webchat_owner_task_state_transition_rejected");
  }

  private transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("webchat_owner_task_store_closed");
  }
}

function validateSubmissionRow(row: SubmissionRow): void {
  if (!DIGEST.test(row.payload_digest) || !REQUEST_ID.test(row.request_id) ||
      !["dispatching", "handler_returned", "outcome_unknown", "rejected"].includes(row.delivery_state)) {
    throw new Error("webchat_owner_task_store_row_invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
