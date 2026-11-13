import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { parseLoopbackMcpEndpoint } from "./mcp_endpoint.js";

export type McpConnectionObservationState = "not_observed" | "catalog_reachable" | "preflight_failed";
export type McpCallObservationState = "not_observed" | "dispatching" | "response_received" | "outcome_unknown";

export interface McpRuntimeObservationSnapshot {
  readonly connection: {
    readonly state: McpConnectionObservationState;
    readonly observed_at: string | null;
  };
  readonly last_call: {
    readonly state: McpCallObservationState;
    readonly observed_at: string | null;
  };
  readonly used_for_authority: false;
  readonly may_execute: false;
}

interface StoredMcpRuntimeObservation {
  connection: McpRuntimeObservationSnapshot["connection"];
  last_call: McpRuntimeObservationSnapshot["last_call"];
}

interface McpRuntimeObservationRow {
  endpoint_digest: string;
  connection_state: string;
  connection_observed_at: string | null;
  last_call_state: string;
  last_call_observed_at: string | null;
  updated_at: string;
}

const MAX_TRACKED_ENDPOINTS = 8;
const STORE_SCHEMA_VERSION = 1;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function emptyObservation(): StoredMcpRuntimeObservation {
  return {
    connection: { state: "not_observed", observed_at: null },
    last_call: { state: "not_observed", observed_at: null },
  };
}

function endpointDigest(endpoint: string | URL): string | null {
  try {
    const canonical = parseLoopbackMcpEndpoint(endpoint);
    return createHash("sha256").update(canonical.href, "utf8").digest("hex");
  } catch {
    return null;
  }
}

function isConnectionState(value: string): value is McpConnectionObservationState {
  return value === "not_observed" || value === "catalog_reachable" || value === "preflight_failed";
}

function isCallState(value: string): value is McpCallObservationState {
  return value === "not_observed" || value === "dispatching" || value === "response_received" ||
    value === "outcome_unknown";
}

function validateObservedAt(value: string | null, state: string): boolean {
  if (state === "not_observed") return value === null;
  return value !== null && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseStoredObservation(row: McpRuntimeObservationRow): StoredMcpRuntimeObservation {
  if (!/^[a-f0-9]{64}$/.test(row.endpoint_digest) || !isConnectionState(row.connection_state) ||
      !validateObservedAt(row.connection_observed_at, row.connection_state) || !isCallState(row.last_call_state) ||
      !validateObservedAt(row.last_call_observed_at, row.last_call_state) ||
      !Number.isFinite(Date.parse(row.updated_at)) || new Date(row.updated_at).toISOString() !== row.updated_at) {
    throw new Error("mcp_runtime_observation_store_invalid");
  }
  return {
    connection: { state: row.connection_state, observed_at: row.connection_observed_at },
    last_call: { state: row.last_call_state, observed_at: row.last_call_observed_at },
  };
}

/** Bounded MCP observations for normal calls. They are never live health or authority inputs. */
export class McpRuntimeObservationStore {
  private readonly observations = new Map<string, StoredMcpRuntimeObservation>();
  private readonly db?: DatabaseType;
  private closed = false;

  /** Omitting `filepath` keeps an isolated in-memory store for fixtures. */
  constructor(filepath?: string) {
    if (!filepath) return;
    this.db = new DatabaseSync(resolve(filepath));
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== STORE_SCHEMA_VERSION) {
        throw new Error("mcp_runtime_observation_store_version_unsupported");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_runtime_observations (
          endpoint_digest TEXT PRIMARY KEY CHECK(length(endpoint_digest)=64 AND endpoint_digest NOT GLOB '*[^0-9a-f]*'),
          connection_state TEXT NOT NULL CHECK(connection_state IN ('not_observed','catalog_reachable','preflight_failed')),
          connection_observed_at TEXT,
          last_call_state TEXT NOT NULL CHECK(last_call_state IN ('not_observed','dispatching','response_received','outcome_unknown')),
          last_call_observed_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      if (version.user_version === 0) this.db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
      this.recoverInterruptedDispatches();
      this.listRows();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static fromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): McpRuntimeObservationStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "mcp-runtime-observations");
    for (const path of [privateRoot, directory]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink()) throw new Error("mcp_runtime_observation_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(path, 0o700);
    }
    const filepath = join(directory, "observations.sqlite");
    try {
      const stat = lstatSync(filepath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("mcp_runtime_observation_file_must_be_regular");
      if (process.platform !== "win32") chmodSync(filepath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      closeSync(openSync(filepath, "wx", 0o600));
    }
    return new McpRuntimeObservationStore(filepath);
  }

  recordCatalogReachable(endpoint: string | URL): void {
    this.update(endpoint, (current, observedAt) => ({
      ...current,
      connection: { state: "catalog_reachable", observed_at: observedAt },
    }));
  }

  recordPreflightFailed(endpoint: string | URL): void {
    this.update(endpoint, (current, observedAt) => ({
      ...current,
      connection: { state: "preflight_failed", observed_at: observedAt },
    }));
  }

  recordDispatchStarted(endpoint: string | URL): void {
    this.update(endpoint, (current, observedAt) => ({
      ...current,
      last_call: { state: "dispatching", observed_at: observedAt },
    }));
  }

  recordResponseReceived(endpoint: string | URL): void {
    this.update(endpoint, (current, observedAt) => ({
      ...current,
      last_call: { state: "response_received", observed_at: observedAt },
    }));
  }

  recordOutcomeUnknown(endpoint: string | URL): void {
    this.update(endpoint, (current, observedAt) => ({
      ...current,
      last_call: { state: "outcome_unknown", observed_at: observedAt },
    }));
  }

  snapshot(endpoint: string | URL | undefined): McpRuntimeObservationSnapshot {
    this.assertOpen();
    const digest = endpoint === undefined ? null : endpointDigest(endpoint);
    const stored = digest === null ? undefined : this.read(digest);
    const observation = stored ?? emptyObservation();
    return {
      connection: { ...observation.connection },
      last_call: { ...observation.last_call },
      used_for_authority: false,
      may_execute: false,
    };
  }

  close(): void {
    if (this.closed) return;
    this.db?.close();
    this.closed = true;
  }

  private update(
    endpoint: string | URL,
    update: (current: StoredMcpRuntimeObservation, observedAt: string) => StoredMcpRuntimeObservation,
  ): void {
    this.assertOpen();
    const digest = endpointDigest(endpoint);
    if (digest === null) return;
    const observedAt = new Date().toISOString();
    const current = this.read(digest) ?? emptyObservation();
    const next = update(current, observedAt);
    if (this.db) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO mcp_runtime_observations
            (endpoint_digest, connection_state, connection_observed_at, last_call_state, last_call_observed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(endpoint_digest) DO UPDATE SET
            connection_state=excluded.connection_state,
            connection_observed_at=excluded.connection_observed_at,
            last_call_state=excluded.last_call_state,
            last_call_observed_at=excluded.last_call_observed_at,
            updated_at=excluded.updated_at
        `).run(digest, next.connection.state, next.connection.observed_at,
          next.last_call.state, next.last_call.observed_at, observedAt);
        this.db.prepare(`
          DELETE FROM mcp_runtime_observations WHERE endpoint_digest NOT IN (
            SELECT endpoint_digest FROM mcp_runtime_observations
            ORDER BY updated_at DESC, endpoint_digest ASC LIMIT ?
          )
        `).run(MAX_TRACKED_ENDPOINTS);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original persistence failure. */ }
        throw error;
      }
      return;
    }
    this.observations.delete(digest);
    if (this.observations.size >= MAX_TRACKED_ENDPOINTS) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }
    this.observations.set(digest, next);
  }

  private read(digest: string): StoredMcpRuntimeObservation | undefined {
    if (!this.db) return this.observations.get(digest);
    const row = this.db.prepare(`
      SELECT endpoint_digest, connection_state, connection_observed_at,
        last_call_state, last_call_observed_at, updated_at
      FROM mcp_runtime_observations WHERE endpoint_digest=?
    `).get(digest) as McpRuntimeObservationRow | undefined;
    return row ? parseStoredObservation(row) : undefined;
  }

  private listRows(): void {
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT endpoint_digest, connection_state, connection_observed_at,
        last_call_state, last_call_observed_at, updated_at
      FROM mcp_runtime_observations
    `).all() as unknown as McpRuntimeObservationRow[];
    for (const row of rows) parseStoredObservation(row);
  }

  private recoverInterruptedDispatches(): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE mcp_runtime_observations
        SET last_call_state='outcome_unknown', last_call_observed_at=?, updated_at=?
        WHERE last_call_state='dispatching'
      `).run(now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original recovery failure. */ }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("mcp_runtime_observation_store_closed");
  }
}

/** Default fixture store. Runtime entry points inject a durable per-install store. */
export const mcpRuntimeObservationStore = new McpRuntimeObservationStore();
