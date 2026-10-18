import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, lstatSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type { ExecutionIntentStore, ExecutionIntentTicket, ExecutionIntentReceipt, ExecutionInvocationBoundary, ExecutionWorkerIdentity } from "@blue-tanuki/core";
import { BOUNDARY_EXCHANGE_SCHEMA_VERSION, BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
  parseBoundaryExchangeAtBoundary, inspectExecutionResultDelivery, inspectOperationCommandExecutionResult,
  getOperationDescriptor, type ExecutionAdmission, type ExecutionResultDelivery } from "@blue-tanuki/protocol";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
/** Stable opaque join key for J's saved admission and the verified Broker receipt. */
export function executionAdmissionDigest(admission: ExecutionAdmission): string {
  return digest(JSON.stringify(["blue-tanuki.execution-admission.v1", admission.ticket_id, admission.command_key,
    admission.command_digest, admission.proof_digest, admission.execution_epoch, admission.issued_at_ms, admission.expires_at_ms]));
}
const sameTicket = (a: ExecutionIntentTicket, b: ExecutionIntentTicket): boolean =>
  ["ticket_id", "command_key", "command_digest", "proof_digest", "execution_epoch", "issued_at_ms", "expires_at_ms"]
    .every((key) => a[key as keyof ExecutionIntentTicket] === b[key as keyof ExecutionIntentTicket]);

/** 私有の実行所有記録。Jのcheckpointと別取引であり、権限の復元元ではない。 */
export class GatewayExecutionIntentStore implements ExecutionIntentStore {
  private readonly db: DatabaseType;
  private readonly filepath: string;
  constructor(filepath: string) {
    this.filepath = resolve(filepath);
    mkdirSync(dirname(this.filepath), { recursive: true });
    this.db = new DatabaseSync(this.filepath);
    if (process.platform !== "win32") chmodSync(this.filepath, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_intents (
      ticket_id TEXT PRIMARY KEY, command_key TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS execution_events (
      sequence INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, event_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS execution_result_outbox (
      ticket_id TEXT PRIMARY KEY REFERENCES execution_intents(ticket_id),
      delivery_json TEXT NOT NULL, delivery_digest TEXT NOT NULL
    ) STRICT;`);
    // 別processのcommitとevents/receipt読取が交差しない一貫した境界で確認する。
    try { this.transaction(() => {}); }
    catch (error) { this.db.close(); throw error; }
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayExecutionIntentStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "execution-intents");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("execution_state_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "executor.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("execution_state_file_must_not_be_symlink");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new GatewayExecutionIntentStore(filepath);
  }
  issue(ticket: Readonly<ExecutionIntentTicket>): void {
    this.transaction(() => {
      validateTicket(ticket);
      if (this.db.prepare("SELECT ticket_id FROM execution_intents WHERE command_key=?").get(ticket.command_key)) {
        throw new Error("Executor ticket issue rejected: command already issued; inspect existing receipt");
      }
      const receipt: ExecutionIntentReceipt = { ...ticket, state: "issued", used_for_authority: false };
      this.save(receipt, true);
      this.appendEvent(receipt, ticket.issued_at_ms);
    });
  }
  consume(ticket: Readonly<ExecutionIntentTicket>, now_ms: number): void {
    this.transaction(() => {
      const receipt = this.current(ticket, now_ms);
      if (receipt.state !== "issued") throw new Error("Executor ticket consumption rejected: already consumed");
      // 単回消費、開始意思、開始eventを同一commitにする。下流はこの後だけ。
      receipt.state = "intent_committed"; receipt.consumed_at_ms = now_ms;
      this.save(receipt); this.appendEvent(receipt, now_ms);
    });
  }
  markInvocation(ticket: Readonly<ExecutionIntentTicket>, boundary: ExecutionInvocationBoundary, now_ms: number): void {
    this.transaction(() => {
      const receipt = this.current(ticket, now_ms);
      if (receipt.state !== "intent_committed") throw new Error("Executor invocation rejected: intent not current");
      receipt.state = "invocation_attempted"; receipt.invocation_boundary = boundary;
      this.save(receipt); this.appendEvent(receipt, now_ms);
    });
  }
  bindWorker(ticket: Readonly<ExecutionIntentTicket>, worker: Readonly<ExecutionWorkerIdentity>, now_ms: number): void {
    this.transaction(() => {
      const receipt = this.current(ticket, now_ms);
      if (receipt.state !== "intent_committed" || receipt.worker_id !== undefined) throw new Error("Executor worker binding rejected");
      Object.assign(receipt, { worker_id: worker.worker_id, worker_pid: worker.worker_pid,
        worker_platform: worker.worker_platform, worker_started_at_ms: worker.worker_started_at_ms });
      this.save(receipt); this.appendEvent(receipt, now_ms);
    });
  }
  observeWorkerExit(ticket: Readonly<ExecutionIntentTicket>, worker: Readonly<ExecutionWorkerIdentity>, now_ms: number): void {
    this.transaction(() => {
      const receipt = this.lookup(ticket.ticket_id);
      if (!receipt || !sameTicket(receipt, ticket) || receipt.worker_exit_observed_at_ms !== undefined ||
          (receipt.state !== "intent_committed" && receipt.state !== "invocation_attempted") ||
          ["worker_id", "worker_pid", "worker_platform", "worker_started_at_ms"].some((key) =>
            receipt[key as keyof ExecutionIntentReceipt] !== worker[key as keyof ExecutionWorkerIdentity])) {
        throw new Error("Executor worker exit identity rejected");
      }
      receipt.worker_exit_observed_at_ms = now_ms;
      this.save(receipt); this.appendEvent(receipt, now_ms);
    });
  }
  complete(ticket: Readonly<ExecutionIntentTicket>, result: Pick<ExecutionIntentReceipt,
    "state" | "feedback_status" | "output_digest" | "error_digest" | "observed_at_ms">,
    delivery?: ExecutionResultDelivery): void {
    this.transaction(() => {
      const receipt = this.lookup(ticket.ticket_id);
      if (!receipt || !sameTicket(receipt, ticket)) throw new Error("Executor receipt rejected: ticket mismatch");
      if ((receipt.state === "intent_committed" && result.state !== "not_attempted") ||
          (receipt.state === "invocation_attempted" && result.state !== "adapter_returned" && result.state !== "outcome_unknown") ||
          (receipt.state !== "intent_committed" && receipt.state !== "invocation_attempted") ||
          (result.state === "adapter_returned" && (result.feedback_status !== "success" ||
            (receipt.worker_id !== undefined && receipt.worker_exit_observed_at_ms === undefined)))) {
        throw new Error("Executor receipt rejected: invalid state transition");
      }
      const completed = { ...receipt, ...result };
      if (delivery) {
        const checked = inspectExecutionResultDelivery(delivery);
        validateDelivery(completed, checked);
        const json = JSON.stringify(checked);
        const capacity = this.db.prepare("SELECT count(*) AS rows, coalesce(sum(length(CAST(delivery_json AS BLOB))),0) AS bytes FROM execution_result_outbox").get() as { rows: number; bytes: number };
        if (capacity.rows >= 1000 || capacity.bytes + Buffer.byteLength(json) > 8_388_608) throw new Error("execution_delivery_store_full");
        completed.result_delivery_digest = digest(json);
        completed.result_delivery_acknowledged = false;
        this.db.prepare("INSERT INTO execution_result_outbox VALUES(?,?,?)").run(ticket.ticket_id, json, completed.result_delivery_digest);
      }
      validateReceipt(completed);
      this.save(completed); this.appendEvent(completed, result.observed_at_ms!);
    });
  }
  /** 内部J consumer専用。配送は作用や現在承認を復元しない。rawをsnapshotへ返さない。 */
  pendingResults(limit = 50): Array<{ delivery: ExecutionResultDelivery; delivery_digest: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("execution_delivery_limit_invalid");
    let results: ReturnType<GatewayExecutionIntentStore["pendingResults"]> = [];
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT o.delivery_json,o.delivery_digest FROM execution_result_outbox o
        JOIN execution_intents i ON i.ticket_id=o.ticket_id
        WHERE json_extract(i.receipt_json,'$.result_delivery_acknowledged')=0 ORDER BY o.rowid LIMIT ?`).all(limit) as
        { delivery_json: string; delivery_digest: string }[];
      results = rows.map((row) => ({ delivery: inspectExecutionResultDelivery(JSON.parse(row.delivery_json)), delivery_digest: row.delivery_digest }));
    });
    return results;
  }
  acknowledgeResult(ticket_id: string, delivery_digest: string): void {
    this.transaction(() => {
      const receipt = this.lookup(ticket_id);
      if (!receipt?.result_delivery_digest || receipt.result_delivery_digest !== delivery_digest) throw new Error("execution_delivery_ack_mismatch");
      if (receipt.result_delivery_acknowledged) return;
      receipt.result_delivery_acknowledged = true;
      receipt.result_delivery_disposition = "reconciled";
      this.save(receipt); this.appendEvent(receipt, Date.now());
    });
  }
  /** Old-generation delivery remains private, digest-traceable evidence and never enters J/M. */
  archiveStaleGenerationResult(ticket_id: string, delivery_digest: string, current_epoch: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(current_epoch)) throw new Error("execution_owner_epoch_invalid");
    this.transaction(() => {
      const receipt = this.lookup(ticket_id);
      if (!receipt?.result_delivery_digest || receipt.result_delivery_digest !== delivery_digest) {
        throw new Error("execution_delivery_ack_mismatch");
      }
      if (receipt.execution_epoch === current_epoch) throw new Error("execution_delivery_not_stale");
      if (receipt.result_delivery_acknowledged) {
        if (receipt.result_delivery_disposition === "stale_generation_evidence") return;
        throw new Error("execution_delivery_disposition_conflict");
      }
      receipt.result_delivery_acknowledged = true;
      receipt.result_delivery_disposition = "stale_generation_evidence";
      receipt.result_archived_by_epoch_digest = digest(current_epoch);
      this.save(receipt); this.appendEvent(receipt, Date.now());
    });
  }
  lookup(ticket_id: string): ExecutionIntentReceipt | null {
    const row = this.db.prepare("SELECT receipt_json,receipt_digest,command_key,ticket_id FROM execution_intents WHERE ticket_id=?")
      .get(ticket_id) as { receipt_json: string; receipt_digest: string; command_key: string; ticket_id: string } | undefined;
    if (!row) return null;
    if (digest(row.receipt_json) !== row.receipt_digest) throw new Error("execution_receipt_integrity_failed");
    let receipt: ExecutionIntentReceipt;
    try { receipt = JSON.parse(row.receipt_json) as ExecutionIntentReceipt; validateReceipt(receipt); }
    catch { throw new Error("execution_receipt_integrity_failed"); }
    if (receipt.ticket_id !== row.ticket_id || receipt.command_key !== row.command_key) throw new Error("execution_receipt_integrity_failed");
    return receipt;
  }
  /** 再起動・再照会では未完intentを結果不明にする。作用も権限復元もしない。 */
  lookupCommand(command_key: string): ExecutionIntentReceipt | null {
    const row = this.db.prepare("SELECT ticket_id FROM execution_intents WHERE command_key=?").get(command_key) as { ticket_id: string } | undefined;
    const receipt = row ? this.lookup(row.ticket_id) : null;
    return receipt && (receipt.state === "intent_committed" || receipt.state === "invocation_attempted")
      ? { ...receipt, state: "outcome_unknown" } : receipt;
  }
  /** 認証済みControl Center snapshot用。raw command、ticket handle、現在権限を返さない。 */
  snapshot(limit = 50): { used_for_authority: false; execution_eligible: false; records: Array<{
    ticket_digest: string; command_digest: string; execution_epoch_digest: string; state: ExecutionIntentReceipt["state"];
    invocation_boundary?: ExecutionInvocationBoundary; feedback_status?: ExecutionIntentReceipt["feedback_status"];
    output_digest?: string; error_digest?: string;
    worker_id_digest?: string; worker_pid?: number; worker_platform?: string; worker_exit_observed: boolean;
    result_delivery_digest?: string; result_delivery_acknowledged?: boolean;
    result_delivery_disposition?: ExecutionIntentReceipt["result_delivery_disposition"];
    result_archived_by_epoch_digest?: string;
  }> } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("execution_receipt_limit_invalid");
    let records: ReturnType<GatewayExecutionIntentStore["snapshot"]>["records"] = [];
    this.transaction(() => {
      const rows = this.db.prepare("SELECT command_key FROM execution_intents ORDER BY rowid DESC LIMIT ?").all(limit) as { command_key: string }[];
      records = rows.map(({ command_key }) => {
        const receipt = this.lookupCommand(command_key)!;
        return { ticket_digest: digest(receipt.ticket_id), command_digest: receipt.command_digest,
          execution_epoch_digest: digest(receipt.execution_epoch), state: receipt.state,
          invocation_boundary: receipt.invocation_boundary, feedback_status: receipt.feedback_status,
          output_digest: receipt.output_digest, error_digest: receipt.error_digest,
          worker_id_digest: receipt.worker_id ? digest(receipt.worker_id) : undefined,
          worker_pid: receipt.worker_pid, worker_platform: receipt.worker_platform,
          worker_exit_observed: receipt.worker_exit_observed_at_ms !== undefined,
          result_delivery_digest: receipt.result_delivery_digest, result_delivery_acknowledged: receipt.result_delivery_acknowledged,
          result_delivery_disposition: receipt.result_delivery_disposition,
          result_archived_by_epoch_digest: receipt.result_archived_by_epoch_digest };
      });
    });
    return { used_for_authority: false, execution_eligible: false, records };
  }
  verifyEvents(): boolean {
    return verifyExecutionIntentDatabase(this.db, false);
  }
  /**
   * Replace the selected Broker snapshot atomically while preserving only the
   * currently invoking restore's non-authoritative receipt. The caller must
   * already have obtained fresh HDS approval and verified the backup manifest.
   */
  restoreFromCanonicalSnapshot(snapshotPath: string, executionCommandKey: string): void {
    if (!/^[a-f0-9]{64}$/.test(executionCommandKey)) throw new Error("broker_restore_execution_context_invalid");
    const resolvedSnapshot = resolve(snapshotPath);
    let source: DatabaseType | undefined;
    try {
      const stat = lstatSync(resolvedSnapshot);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(resolvedSnapshot) !== resolvedSnapshot ||
          resolvedSnapshot === this.filepath ||
          ["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${resolvedSnapshot}${suffix}`))) {
        throw new Error("broker_restore_archive_unavailable");
      }
      if (["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${this.filepath}${suffix}`))) {
        throw new Error("broker_restore_store_busy");
      }
      source = new DatabaseSync(resolvedSnapshot, {
        readOnly: true,
        enableForeignKeyConstraints: true,
        allowExtension: false,
      });
      source.enableLoadExtension(false);
      source.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; BEGIN");
      const integrity = source.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
      const journal = source.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
      if (integrity?.integrity_check !== "ok" || journal?.journal_mode !== "delete" ||
          !verifyExecutionIntentDatabase(source, true)) {
        throw new Error("broker_restore_archive_invalid");
      }

      this.transaction(() => {
        const currentRow = this.db.prepare("SELECT ticket_id FROM execution_intents WHERE command_key=?")
          .get(executionCommandKey) as { ticket_id: string } | undefined;
        const current = currentRow ? this.lookup(currentRow.ticket_id) : null;
        if (!current || current.command_key !== executionCommandKey || current.state !== "invocation_attempted" ||
            current.invocation_boundary !== "tool_adapter") {
          throw new Error("broker_restore_active_executor_receipt_required");
        }

        const activeStates = new Set<ExecutionIntentReceipt["state"]>(["issued", "intent_committed", "invocation_attempted"]);
        const currentActive = executionReceipts(this.db).filter((receipt) =>
          receipt.execution_epoch === current.execution_epoch && activeStates.has(receipt.state));
        if (currentActive.length !== 1 || currentActive[0]?.ticket_id !== current.ticket_id) {
          throw new Error("broker_restore_other_current_epoch_execution_active");
        }
        if (executionReceipts(source!).some((receipt) =>
          receipt.execution_epoch === current.execution_epoch && activeStates.has(receipt.state))) {
          throw new Error("broker_restore_archive_current_epoch_execution_active");
        }
        const collision = source!.prepare(
          "SELECT ticket_id FROM execution_intents WHERE ticket_id=? OR command_key=?",
        ).get(current.ticket_id, current.command_key);
        if (collision) throw new Error("broker_restore_executor_receipt_conflict");

        this.db.exec("DELETE FROM execution_result_outbox; DELETE FROM execution_events; DELETE FROM execution_intents;");
        const insertIntent = this.db.prepare("INSERT INTO execution_intents(ticket_id,command_key,receipt_json,receipt_digest) VALUES(?,?,?,?)");
        for (const row of source!.prepare(
          "SELECT ticket_id,command_key,receipt_json,receipt_digest FROM execution_intents ORDER BY rowid",
        ).iterate() as Iterable<{ ticket_id: string; command_key: string; receipt_json: string; receipt_digest: string }>) {
          insertIntent.run(row.ticket_id, row.command_key, row.receipt_json, row.receipt_digest);
        }
        const insertEvent = this.db.prepare(
          "INSERT INTO execution_events(sequence,ticket_id,event_json,previous_hash,event_hash) VALUES(?,?,?,?,?)",
        );
        for (const row of source!.prepare(
          "SELECT sequence,ticket_id,event_json,previous_hash,event_hash FROM execution_events ORDER BY sequence",
        ).iterate() as Iterable<{ sequence: number; ticket_id: string; event_json: string; previous_hash: string; event_hash: string }>) {
          insertEvent.run(row.sequence, row.ticket_id, row.event_json, row.previous_hash, row.event_hash);
        }
        const insertDelivery = this.db.prepare(
          "INSERT INTO execution_result_outbox(ticket_id,delivery_json,delivery_digest) VALUES(?,?,?)",
        );
        for (const row of source!.prepare(
          "SELECT ticket_id,delivery_json,delivery_digest FROM execution_result_outbox ORDER BY rowid",
        ).iterate() as Iterable<{ ticket_id: string; delivery_json: string; delivery_digest: string }>) {
          insertDelivery.run(row.ticket_id, row.delivery_json, row.delivery_digest);
        }
        this.save(current, true);
        this.appendEvent(current, Date.now());
        if (!this.verifyEvents()) throw new Error("broker_restore_result_integrity_failed");
      });
    } finally {
      try { source?.exec("ROLLBACK"); } catch { /* preserve the restore result */ }
      try { source?.close(); } catch { /* preserve the restore result */ }
    }
  }
  close(): void { this.db.close(); }
  private current(ticket: Readonly<ExecutionIntentTicket>, now_ms: number): ExecutionIntentReceipt {
    const receipt = this.lookup(ticket.ticket_id);
    if (!receipt || !sameTicket(receipt, ticket)) throw new Error("Executor ticket rejected: content or epoch mismatch");
    if (!Number.isSafeInteger(now_ms) || now_ms < receipt.issued_at_ms || now_ms >= receipt.expires_at_ms) {
      throw new Error("Executor ticket rejected: expired or clock invalid");
    }
    return receipt;
  }
  private save(receipt: ExecutionIntentReceipt, insert = false): void {
    validateReceipt(receipt);
    const json = JSON.stringify(receipt);
    if (insert) this.db.prepare("INSERT INTO execution_intents VALUES(?,?,?,?)").run(receipt.ticket_id, receipt.command_key, json, digest(json));
    else this.db.prepare("UPDATE execution_intents SET receipt_json=?,receipt_digest=? WHERE ticket_id=?").run(json, digest(json), receipt.ticket_id);
  }
  private appendEvent(receipt: ExecutionIntentReceipt, now_ms: number): void {
    const row = this.db.prepare("SELECT event_hash FROM execution_events ORDER BY sequence DESC LIMIT 1").get() as { event_hash: string } | undefined;
    const previous = row?.event_hash ?? "0".repeat(64);
    const parsed = parseBoundaryExchangeAtBoundary(new TextEncoder().encode(JSON.stringify({
      schema_version: BOUNDARY_EXCHANGE_SCHEMA_VERSION, canonicalization_version: BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION,
      issued_at_utc: new Date(now_ms).toISOString(), content: { profile: "executor-intent-event.v1", receipt },
    })));
    if (!parsed.ok) throw new Error("execution_event_canonicalization_failed");
    const json = new TextDecoder().decode(parsed.canonical_bytes);
    this.db.prepare("INSERT INTO execution_events(ticket_id,event_json,previous_hash,event_hash) VALUES(?,?,?,?)")
      .run(receipt.ticket_id, json, previous, digest(previous + json));
  }
  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.verifyEvents()) throw new Error("execution_event_integrity_failed");
      operation(); this.db.exec("COMMIT");
    }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* 元の失敗を保つ。 */ } throw error; }
  }
}

function executionReceipts(database: DatabaseType): ExecutionIntentReceipt[] {
  const rows = database.prepare("SELECT ticket_id,command_key,receipt_json,receipt_digest FROM execution_intents")
    .all() as { ticket_id: string; command_key: string; receipt_json: string; receipt_digest: string }[];
  return rows.map((row) => {
    if (digest(row.receipt_json) !== row.receipt_digest) throw new Error("execution_receipt_integrity_failed");
    let receipt: ExecutionIntentReceipt;
    try { receipt = JSON.parse(row.receipt_json) as ExecutionIntentReceipt; validateReceipt(receipt); }
    catch { throw new Error("execution_receipt_integrity_failed"); }
    if (receipt.ticket_id !== row.ticket_id || receipt.command_key !== row.command_key) {
      throw new Error("execution_receipt_integrity_failed");
    }
    return receipt;
  });
}

function verifyExecutionIntentDatabase(database: DatabaseType, checkSchema: boolean): boolean {
  try {
    if (checkSchema && !verifyExecutionRecoverySchema(database)) return false;
    let previous = "0".repeat(64);
    let sequence = 0;
    const latest = new Map<string, ExecutionIntentReceipt>();
    const rows = database.prepare("SELECT sequence,ticket_id,event_json,previous_hash,event_hash FROM execution_events ORDER BY sequence").all() as
      { sequence: number; ticket_id: string; event_json: string; previous_hash: string; event_hash: string }[];
    for (const row of rows) {
      if (row.sequence !== ++sequence || row.previous_hash !== previous || digest(previous + row.event_json) !== row.event_hash) return false;
      try {
        const receipt = JSON.parse(row.event_json).content.receipt as ExecutionIntentReceipt;
        validateReceipt(receipt);
        if (receipt.ticket_id !== row.ticket_id) return false;
        latest.set(row.ticket_id, receipt);
      } catch { return false; }
      previous = row.event_hash;
    }
    const receipts = executionReceipts(database);
    if (receipts.length !== latest.size) return false;
    for (const receipt of receipts) {
      const event = latest.get(receipt.ticket_id);
      if (!event || JSON.stringify(Object.entries(receipt).sort()) !== JSON.stringify(Object.entries(event).sort())) return false;
    }
    const outbox = database.prepare("SELECT ticket_id,delivery_json,delivery_digest FROM execution_result_outbox").all() as
      { ticket_id: string; delivery_json: string; delivery_digest: string }[];
    if (outbox.length !== [...latest.values()].filter((receipt) => receipt.result_delivery_digest !== undefined).length) return false;
    for (const row of outbox) {
      try {
        const receipt = latest.get(row.ticket_id);
        if (!receipt || receipt.result_delivery_digest !== row.delivery_digest || digest(row.delivery_json) !== row.delivery_digest) return false;
        validateDelivery(receipt, inspectExecutionResultDelivery(JSON.parse(row.delivery_json)));
      } catch { return false; }
    }
    return true;
  } catch { return false; }
}

export interface ExecutionIntentRecoveryInspection {
  readonly owner: "Broker";
  readonly status: "verified" | "corrupt" | "residuals_present" | "unavailable" | "schema_mismatch";
  readonly reason: "ledger_corrupt" | "projection_mismatch" | "outbox_mismatch" | "store_unavailable" | "schema_mismatch" | null;
  readonly total_event_count: number;
  readonly verified_event_count: number;
  readonly unverified_event_count: number;
  readonly first_unverified_ordinal: number | null;
  readonly last_verified_event_digest: string | null;
  readonly receipt_projection_mismatch_count: number;
  readonly outbox_mismatch_count: number;
  readonly current_state_available: boolean;
  readonly omitted_record_count: number;
  readonly records: readonly {
    readonly ticket_digest: string;
    readonly command_key_digest: string;
    readonly execution_epoch_digest: string;
    readonly admission_digest: string;
    readonly state: ExecutionIntentReceipt["state"];
    readonly reconciliation_required: boolean;
    readonly result_delivery_pending: boolean;
    readonly result_delivery_digest: string | null;
  }[];
  readonly used_for_authority: false;
  readonly execution_eligible: false;
}

interface VerifiedExecutionEvent {
  readonly receipt: ExecutionIntentReceipt;
  readonly event_hash: string;
  readonly sequence: number;
}

function unavailableExecutionInspection(
  status: "unavailable" | "schema_mismatch" = "unavailable",
  reason: "store_unavailable" | "schema_mismatch" = "store_unavailable",
): ExecutionIntentRecoveryInspection {
  return {
    owner: "Broker",
    status,
    reason,
    total_event_count: 0,
    verified_event_count: 0,
    unverified_event_count: 0,
    first_unverified_ordinal: null,
    last_verified_event_digest: null,
    receipt_projection_mismatch_count: 0,
    outbox_mismatch_count: 0,
    current_state_available: false,
    omitted_record_count: 0,
    records: [],
    used_for_authority: false,
    execution_eligible: false,
  };
}

function safeExecutionRecoveryPath(privateStateRoot: string, databasePath: string): string | null {
  try {
    const rootStat = lstatSync(privateStateRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const root = realpathSync(privateStateRoot);
    const absolutePath = resolve(databasePath);
    const rel = relative(root, absolutePath);
    const allowedPaths = [join("execution-intents", "executor.sqlite"), join("canonical-state", "broker.sqlite")];
    if (!allowedPaths.includes(rel) || isAbsolute(rel) || rel.startsWith(`..${sep}`)) return null;
    const directory = join(root, dirname(rel));
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || realpathSync(directory) !== directory) return null;
    const fileStat = lstatSync(absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size === 0 || realpathSync(absolutePath) !== absolutePath) return null;
    return absolutePath;
  } catch {
    return null;
  }
}

function verifyExecutionRecoverySchema(database: DatabaseType): boolean {
  const tables = new Set(["execution_intents", "execution_events", "execution_result_outbox"]);
  const objectRows = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger')")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tableRows = objectRows.filter((row) => row.type === "table" && tables.has(row.name));
  if (tableRows.length !== tables.size || objectRows.some((row) => row.type === "trigger" && tables.has(row.tbl_name))) return false;
  const expected: Record<string, readonly { name: string; type: string; primaryKey: number }[]> = {
    execution_intents: [
      { name: "ticket_id", type: "TEXT", primaryKey: 1 },
      { name: "command_key", type: "TEXT", primaryKey: 0 },
      { name: "receipt_json", type: "TEXT", primaryKey: 0 },
      { name: "receipt_digest", type: "TEXT", primaryKey: 0 },
    ],
    execution_events: [
      { name: "sequence", type: "INTEGER", primaryKey: 1 },
      { name: "ticket_id", type: "TEXT", primaryKey: 0 },
      { name: "event_json", type: "TEXT", primaryKey: 0 },
      { name: "previous_hash", type: "TEXT", primaryKey: 0 },
      { name: "event_hash", type: "TEXT", primaryKey: 0 },
    ],
    execution_result_outbox: [
      { name: "ticket_id", type: "TEXT", primaryKey: 1 },
      { name: "delivery_json", type: "TEXT", primaryKey: 0 },
      { name: "delivery_digest", type: "TEXT", primaryKey: 0 },
    ],
  };
  return Object.entries(expected).every(([table, columns]) => {
    const schema = tableRows.find((row) => row.name === table)?.sql;
    if (typeof schema !== "string" || !/\bSTRICT\b/i.test(schema)) return false;
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[];
    return actual.length === columns.length && columns.every((column, index) => {
      const row = actual[index];
      return row?.name === column.name && row.type.toUpperCase() === column.type && row.pk === column.primaryKey;
    });
  });
}

/** Inspect the private Broker execution ledger without creating or repairing a store. */
export function inspectExecutionIntentRecoveryLedger(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): ExecutionIntentRecoveryInspection {
  let database: DatabaseType | undefined;
  let databasePath: string;
  try {
    databasePath = safeExecutionRecoveryPath(options.private_state_root, options.database_path) ?? "";
    if (!databasePath || ["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      return unavailableExecutionInspection();
    }
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; BEGIN");
    if (["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      return unavailableExecutionInspection();
    }
    const mode = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof mode?.journal_mode !== "string" || mode.journal_mode.toLowerCase() !== "delete") {
      return unavailableExecutionInspection();
    }
    if (!verifyExecutionRecoverySchema(database)) {
      return unavailableExecutionInspection("schema_mismatch", "schema_mismatch");
    }

    const totalRow = database.prepare("SELECT count(*) AS count FROM execution_events").get() as { count?: unknown } | undefined;
    const totalEventCount = totalRow?.count;
    if (typeof totalEventCount !== "number" || !Number.isSafeInteger(totalEventCount) || totalEventCount < 0) {
      return unavailableExecutionInspection("schema_mismatch", "schema_mismatch");
    }
    const rows = database.prepare("SELECT sequence,ticket_id,event_json,previous_hash,event_hash FROM execution_events ORDER BY sequence")
      .all() as { sequence: number; ticket_id: string; event_json: string; previous_hash: string; event_hash: string }[];
    const latest = new Map<string, VerifiedExecutionEvent>();
    let previous = "0".repeat(64);
    let verifiedEventCount = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== verifiedEventCount + 1 ||
          typeof row.ticket_id !== "string" || typeof row.event_json !== "string" ||
          typeof row.previous_hash !== "string" || typeof row.event_hash !== "string" ||
          row.previous_hash !== previous || digest(previous + row.event_json) !== row.event_hash) break;
      try {
        const parsed: unknown = JSON.parse(row.event_json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
            typeof (parsed as { content?: unknown }).content !== "object" ||
            (parsed as { content?: { profile?: unknown } }).content?.profile !== "executor-intent-event.v1") break;
        const receipt = (parsed as { content: { receipt?: unknown } }).content.receipt as ExecutionIntentReceipt;
        validateReceipt(receipt);
        if (receipt.ticket_id !== row.ticket_id) break;
        verifiedEventCount++;
        previous = row.event_hash;
        latest.set(row.ticket_id, { receipt, event_hash: row.event_hash, sequence: row.sequence });
      } catch {
        break;
      }
    }

    if (verifiedEventCount !== totalEventCount || rows.length !== totalEventCount) {
      return {
        owner: "Broker",
        status: "corrupt",
        reason: "ledger_corrupt",
        total_event_count: totalEventCount,
        verified_event_count: verifiedEventCount,
        unverified_event_count: Math.max(0, totalEventCount - verifiedEventCount),
        first_unverified_ordinal: verifiedEventCount < totalEventCount ? verifiedEventCount + 1 : null,
        last_verified_event_digest: verifiedEventCount > 0 ? previous : null,
        receipt_projection_mismatch_count: 0,
        outbox_mismatch_count: 0,
        current_state_available: false,
        omitted_record_count: 0,
        records: [],
        used_for_authority: false,
        execution_eligible: false,
      };
    }

    let receiptProjectionMismatchCount = 0;
    try {
      const projections = database.prepare("SELECT ticket_id,command_key,receipt_json,receipt_digest FROM execution_intents ORDER BY rowid")
        .all() as { ticket_id: string; command_key: string; receipt_json: string; receipt_digest: string }[];
      const seen = new Set<string>();
      for (const row of projections) {
        const ticketId = typeof row.ticket_id === "string" ? row.ticket_id : null;
        const duplicateTicket = ticketId !== null && seen.has(ticketId);
        if (ticketId !== null) seen.add(ticketId);
        try {
          if (typeof row.ticket_id !== "string" || typeof row.command_key !== "string" ||
              typeof row.receipt_json !== "string" || typeof row.receipt_digest !== "string" ||
              digest(row.receipt_json) !== row.receipt_digest) throw new Error("invalid_projection");
          const receipt = JSON.parse(row.receipt_json) as ExecutionIntentReceipt;
          validateReceipt(receipt);
          const event = latest.get(row.ticket_id);
          if (!event || duplicateTicket || receipt.ticket_id !== row.ticket_id || receipt.command_key !== row.command_key ||
              JSON.stringify(Object.entries(receipt).sort()) !== JSON.stringify(Object.entries(event.receipt).sort())) {
            receiptProjectionMismatchCount++;
          }
        } catch {
          receiptProjectionMismatchCount++;
        }
      }
      for (const ticketId of latest.keys()) if (!seen.has(ticketId)) receiptProjectionMismatchCount++;
    } catch {
      return unavailableExecutionInspection("schema_mismatch", "schema_mismatch");
    }

    let outboxMismatchCount = 0;
    try {
      const outbox = database.prepare("SELECT ticket_id,delivery_json,delivery_digest FROM execution_result_outbox ORDER BY rowid")
        .all() as { ticket_id: string; delivery_json: string; delivery_digest: string }[];
      const seen = new Set<string>();
      for (const row of outbox) {
        const ticketId = typeof row.ticket_id === "string" ? row.ticket_id : null;
        const duplicateTicket = ticketId !== null && seen.has(ticketId);
        if (ticketId !== null) seen.add(ticketId);
        try {
          if (typeof row.ticket_id !== "string" || typeof row.delivery_json !== "string" || typeof row.delivery_digest !== "string") {
            throw new Error("invalid_outbox");
          }
          const event = latest.get(row.ticket_id);
          const delivery = inspectExecutionResultDelivery(JSON.parse(row.delivery_json));
          if (!event || duplicateTicket || event.receipt.result_delivery_digest !== row.delivery_digest ||
              digest(row.delivery_json) !== row.delivery_digest) throw new Error("outbox_digest_mismatch");
          validateDelivery(event.receipt, delivery);
        } catch {
          outboxMismatchCount++;
        }
      }
      for (const [ticketId, { receipt }] of latest) {
        if (receipt.result_delivery_digest !== undefined && !seen.has(ticketId)) outboxMismatchCount++;
      }
    } catch {
      return unavailableExecutionInspection("schema_mismatch", "schema_mismatch");
    }

    const mismatch = receiptProjectionMismatchCount > 0 || outboxMismatchCount > 0;
    const records = mismatch ? [] : [...latest.entries()]
      .sort((a, b) => b[1].sequence - a[1].sequence)
      .slice(0, 200)
      .map(([ticketId, { receipt }]) => ({
        ticket_digest: digest(ticketId),
        command_key_digest: digest(receipt.command_key),
        execution_epoch_digest: digest(receipt.execution_epoch),
        admission_digest: executionAdmissionDigest(receipt),
        state: receipt.state,
        reconciliation_required: ["intent_committed", "invocation_attempted", "outcome_unknown"].includes(receipt.state) ||
          receipt.result_delivery_acknowledged === false,
        result_delivery_pending: receipt.result_delivery_acknowledged === false,
        result_delivery_digest: receipt.result_delivery_digest ?? null,
      }));
    return {
      owner: "Broker",
      status: mismatch ? "residuals_present" : "verified",
      reason: receiptProjectionMismatchCount > 0 ? "projection_mismatch" : outboxMismatchCount > 0 ? "outbox_mismatch" : null,
      total_event_count: totalEventCount,
      verified_event_count: verifiedEventCount,
      unverified_event_count: 0,
      first_unverified_ordinal: null,
      last_verified_event_digest: verifiedEventCount > 0 ? previous : null,
      receipt_projection_mismatch_count: receiptProjectionMismatchCount,
      outbox_mismatch_count: outboxMismatchCount,
      current_state_available: !mismatch,
      omitted_record_count: Math.max(0, latest.size - records.length),
      records,
      used_for_authority: false,
      execution_eligible: false,
    };
  } catch {
    return unavailableExecutionInspection();
  } finally {
    try { database?.exec("ROLLBACK"); } catch { /* no read snapshot was opened */ }
    try { database?.close(); } catch { /* read-only inspection has no state to commit */ }
  }
}

function validateTicket(ticket: ExecutionIntentTicket): void {
  if (!ticket || !/^[0-9a-f-]{36}$/.test(ticket.ticket_id) || !/^[0-9a-f-]{36}$/.test(ticket.execution_epoch) ||
      ![ticket.command_key, ticket.command_digest, ticket.proof_digest].every((v) => /^[0-9a-f]{64}$/.test(v)) ||
      !Number.isSafeInteger(ticket.issued_at_ms) || ticket.issued_at_ms <= 0 || !Number.isSafeInteger(ticket.expires_at_ms) ||
      ticket.expires_at_ms <= ticket.issued_at_ms || ticket.expires_at_ms - ticket.issued_at_ms > 600_000) {
    throw new Error("execution_ticket_invalid");
  }
}
function validateReceipt(receipt: ExecutionIntentReceipt): void {
  validateTicket(receipt);
  const fields = ["ticket_id", "command_key", "command_digest", "proof_digest", "execution_epoch", "issued_at_ms", "expires_at_ms",
    "state", "invocation_boundary", "feedback_status", "output_digest", "error_digest", "consumed_at_ms", "observed_at_ms", "used_for_authority",
    "worker_id", "worker_pid", "worker_platform", "worker_started_at_ms", "worker_exit_observed_at_ms",
    "result_delivery_digest", "result_delivery_acknowledged", "result_delivery_disposition", "result_archived_by_epoch_digest"];
  const workerFields = [receipt.worker_id, receipt.worker_pid, receipt.worker_platform, receipt.worker_started_at_ms];
  const hasWorker = workerFields.some((value) => value !== undefined);
  if (receipt.used_for_authority !== false ||
      Object.keys(receipt).some((key) => !fields.includes(key)) ||
      !["issued", "intent_committed", "invocation_attempted", "adapter_returned", "not_attempted", "outcome_unknown"].includes(receipt.state) ||
      (receipt.feedback_status !== undefined && !["success", "failed", "suspended"].includes(receipt.feedback_status)) ||
      (receipt.invocation_boundary !== undefined && !["tool_adapter", "channel_adapter", "llm_adapter", "console_preview"].includes(receipt.invocation_boundary)) ||
      [receipt.output_digest, receipt.error_digest, receipt.result_delivery_digest].some((v) => v !== undefined && !/^[0-9a-f]{64}$/.test(v)) ||
      ((receipt.result_delivery_digest !== undefined) !== (receipt.result_delivery_acknowledged !== undefined)) ||
      (receipt.result_delivery_acknowledged !== undefined && typeof receipt.result_delivery_acknowledged !== "boolean") ||
      (receipt.result_delivery_disposition !== undefined && !["reconciled", "stale_generation_evidence"].includes(receipt.result_delivery_disposition)) ||
      (receipt.result_delivery_disposition !== undefined && receipt.result_delivery_acknowledged !== true) ||
      ((receipt.result_delivery_disposition === "stale_generation_evidence") !== (receipt.result_archived_by_epoch_digest !== undefined)) ||
      (receipt.result_archived_by_epoch_digest !== undefined && !/^[0-9a-f]{64}$/.test(receipt.result_archived_by_epoch_digest)) ||
      [receipt.consumed_at_ms, receipt.observed_at_ms, receipt.worker_started_at_ms, receipt.worker_exit_observed_at_ms]
        .some((v) => v !== undefined && (!Number.isSafeInteger(v) || v <= 0)) ||
      (hasWorker && (!/^[0-9a-f-]{36}$/.test(receipt.worker_id ?? "") || !Number.isSafeInteger(receipt.worker_pid) || receipt.worker_pid! <= 0 ||
        !["win32", "linux", "darwin"].includes(receipt.worker_platform ?? "") || !receipt.worker_started_at_ms || receipt.state === "issued")) ||
      (receipt.worker_exit_observed_at_ms !== undefined && (!hasWorker || receipt.worker_exit_observed_at_ms < receipt.worker_started_at_ms!))) {
    throw new Error("execution_receipt_invalid");
  }
}

function validateDelivery(receipt: ExecutionIntentReceipt, delivery: ExecutionResultDelivery): void {
  const fb = delivery.feedback;
  const operation = fb.operation_core_result.operation;
  const descriptor = getOperationDescriptor(operation);
  const profileMatches = delivery.profile === "file-search-result-delivery.v1"
    ? operation === "file.search" && receipt.worker_id !== undefined
    : !!descriptor && descriptor.tool_name === operation && receipt.invocation_boundary === "tool_adapter";
  const result = inspectOperationCommandExecutionResult(fb.operation_core_result, {
    request_id: fb.operation_core_result.request_id, command_id: fb.command_id,
    upstream_commit_hash: fb.operation_core_result.upstream_commit_hash, status: fb.status, operation,
  });
  if (!sameTicket(receipt, delivery.admission) || !profileMatches || !descriptor || result?.adapter !== descriptor.adapter ||
      !result || receipt.feedback_status !== fb.status ||
      receipt.command_key !== digest(JSON.stringify(["gateway-executor-command.v1", fb.command_id])) ||
      receipt.output_digest !== result.output_digest || receipt.error_digest !== result.error_digest ||
      receipt.observed_at_ms !== result.observed_at_ms ||
      (fb.result === undefined ? result.output_digest !== undefined : digest(JSON.stringify(fb.result)) !== result.output_digest) ||
      (receipt.state === "adapter_returned" ? result.action_outcome !== "reported_success" || !fb.result
        : receipt.state === "not_attempted" ? result.action_outcome !== "not_attempted"
          : receipt.state !== "outcome_unknown" || result.action_outcome !== "unknown")) throw new Error("execution_delivery_receipt_mismatch");
}
