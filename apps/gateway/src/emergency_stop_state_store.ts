import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import type { DatabaseSync as DatabaseType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface EmergencyStopActivation {
  control_event_id: string;
  actor: string;
  occurred_at_ms: number;
  audit_recorded: boolean;
}

export interface EmergencyStopClear {
  control_event_id: string;
  actor: string;
  occurred_at_ms: number;
}

export interface EmergencyStopDurableState {
  schema_version: "blue-tanuki.emergency-stop-state.v1";
  active: boolean;
  activation: EmergencyStopActivation | null;
  last_clear: EmergencyStopClear | null;
}

const INITIAL_STATE: EmergencyStopDurableState = {
  schema_version: "blue-tanuki.emergency-stop-state.v1",
  active: false,
  activation: null,
  last_clear: null,
};

/** Durable, deny-only stop latch. Its state is not an approval or execution grant. */
export class EmergencyStopStateStore {
  private readonly db: DatabaseType;

  constructor(filepath: string) {
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
    this.db.exec("CREATE TABLE IF NOT EXISTS emergency_stop_state (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT");
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): EmergencyStopStateStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "safety-control");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("emergency_stop_state_directory_must_not_be_symlink");
    }
    const filepath = join(directory, "emergency-stop.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("emergency_stop_state_file_must_not_be_symlink");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new EmergencyStopStateStore(filepath);
  }

  load(): EmergencyStopDurableState {
    const row = this.db.prepare("SELECT state_json, digest FROM emergency_stop_state WHERE id=1").get() as
      { state_json: string; digest: string } | undefined;
    if (!row) return structuredClone(INITIAL_STATE);
    const raw: unknown = JSON.parse(row.state_json);
    if (digest(raw) !== row.digest) throw new Error("emergency_stop_state_integrity_failed");
    return parseDurableState(raw);
  }

  activate(input: { control_event_id: string; actor: string; occurred_at_ms: number }): EmergencyStopDurableState {
    const current = this.load();
    if (current.active) return current;
    return this.write({ schema_version: "blue-tanuki.emergency-stop-state.v1", active: true,
      activation: parseActivation({ ...input, audit_recorded: false }), last_clear: null });
  }

  markActivationAudited(controlEventId: string): EmergencyStopDurableState {
    const current = this.load();
    if (!current.active || current.activation?.control_event_id !== controlEventId) {
      throw new Error("emergency_stop_activation_state_changed");
    }
    if (current.activation.audit_recorded) return current;
    return this.write({ ...current, activation: { ...current.activation, audit_recorded: true } });
  }

  markActivationPending(controlEventId: string): EmergencyStopDurableState {
    const current = this.load();
    if (!current.active || current.activation?.control_event_id !== controlEventId) {
      throw new Error("emergency_stop_activation_state_changed");
    }
    if (!current.activation.audit_recorded) return current;
    return this.write({ ...current, activation: { ...current.activation, audit_recorded: false } });
  }

  clear(input: { control_event_id: string; actor: string; occurred_at_ms: number }): EmergencyStopDurableState {
    const current = this.load();
    if (!current.active || !current.activation?.audit_recorded) throw new Error("emergency_stop_clear_requires_audited_activation");
    return this.write({ schema_version: "blue-tanuki.emergency-stop-state.v1", active: false, activation: null,
      last_clear: parseClear(input) });
  }

  close(): void { this.db.close(); }

  private write(state: EmergencyStopDurableState): EmergencyStopDurableState {
    const checked = parseDurableState(state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO emergency_stop_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,digest=excluded.digest")
        .run(JSON.stringify(checked), digest(checked));
      this.db.exec("COMMIT");
      return structuredClone(checked);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Keep the original storage failure. */ }
      throw error;
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseDurableState(value: unknown): EmergencyStopDurableState {
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "active", "activation", "last_clear"]) ||
    value.schema_version !== "blue-tanuki.emergency-stop-state.v1" || typeof value.active !== "boolean") {
    throw new Error("emergency_stop_state_invalid");
  }
  const activation = value.activation === null ? null : parseActivation(value.activation);
  const lastClear = value.last_clear === null ? null : parseClear(value.last_clear);
  if (value.active !== (activation !== null)) throw new Error("emergency_stop_state_active_record_mismatch");
  return { schema_version: "blue-tanuki.emergency-stop-state.v1", active: value.active,
    activation, last_clear: lastClear };
}

function parseActivation(value: unknown): EmergencyStopActivation {
  if (!isRecord(value) || !hasExactKeys(value, ["control_event_id", "actor", "occurred_at_ms", "audit_recorded"]) ||
    !validText(value.control_event_id, 128) || !validText(value.actor, 120) ||
    !validTimestamp(value.occurred_at_ms) || typeof value.audit_recorded !== "boolean") {
    throw new Error("emergency_stop_activation_invalid");
  }
  return { control_event_id: value.control_event_id, actor: value.actor,
    occurred_at_ms: value.occurred_at_ms, audit_recorded: value.audit_recorded };
}

function parseClear(value: unknown): EmergencyStopClear {
  if (!isRecord(value) || !hasExactKeys(value, ["control_event_id", "actor", "occurred_at_ms"]) ||
    !validText(value.control_event_id, 128) || !validText(value.actor, 120) || !validTimestamp(value.occurred_at_ms)) {
    throw new Error("emergency_stop_clear_invalid");
  }
  return { control_event_id: value.control_event_id, actor: value.actor, occurred_at_ms: value.occurred_at_ms };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
