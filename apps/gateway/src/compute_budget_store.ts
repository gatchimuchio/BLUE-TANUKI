import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type {
  ComputeBudgetCostBound,
  ComputeBudgetPort,
  ComputeBudgetSettlement,
  ComputeBudgetPolicy,
} from "@blue-tanuki/core";
import { DEFAULT_COMPUTE_BUDGET_POLICY } from "@blue-tanuki/core";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIGEST = /^[a-f0-9]{64}$/;
const COST_SCALE = 1_000_000;

/** Private durable accounting. All persisted identities are digests; payload text is never accepted. */
export class GatewayComputeBudgetStore implements ComputeBudgetPort {
  private readonly database: DatabaseType;

  constructor(filepath: string, private readonly policy?: ComputeBudgetPolicy) {
    const absolutePath = resolve(filepath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database = new DatabaseSync(absolutePath);
    if (process.platform !== "win32") chmodSync(absolutePath, 0o600);
    this.database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
    this.database.exec(`CREATE TABLE IF NOT EXISTS compute_budget_reservations (
      reservation_id TEXT PRIMARY KEY CHECK(length(reservation_id)=64),
      request_id_digest TEXT NOT NULL UNIQUE CHECK(length(request_id_digest)=64),
      window_start_ms INTEGER NOT NULL CHECK(window_start_ms>=0),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      parent_scope_digest TEXT NOT NULL CHECK(length(parent_scope_digest)=64),
      task_scope_digest TEXT NOT NULL CHECK(length(task_scope_digest)=64),
      reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),
      charged_tokens INTEGER NOT NULL CHECK(charged_tokens>=0),
      reserved_compute_ms INTEGER NOT NULL CHECK(reserved_compute_ms>=0),
      charged_compute_ms INTEGER NOT NULL CHECK(charged_compute_ms>=0),
      reserved_cost_micros INTEGER NOT NULL CHECK(reserved_cost_micros>=0),
      charged_cost_micros INTEGER NOT NULL CHECK(charged_cost_micros>=0),
      currency TEXT NOT NULL CHECK(length(currency)=3),
      state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown')),
      settlement_digest TEXT,
      settlement_json TEXT CHECK(settlement_json IS NULL OR length(settlement_json)<=2048),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS compute_budget_parent_window
      ON compute_budget_reservations(window_start_ms,currency,parent_scope_digest);
    CREATE INDEX IF NOT EXISTS compute_budget_task_window
      ON compute_budget_reservations(window_start_ms,currency,task_scope_digest);`);
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
  ): GatewayComputeBudgetStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? join(cwd, ".blue-tanuki"));
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "compute-budget");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("compute_budget_directory_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
    }
    const filepath = join(directory, "ledger.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("compute_budget_file_must_not_be_symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new GatewayComputeBudgetStore(filepath, parseComputeBudgetPolicy(env.BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON));
  }

  reserve(input: Parameters<ComputeBudgetPort["reserve"]>[0]): ReturnType<ComputeBudgetPort["reserve"]> {
    const policy = this.policy;
    if (!policy) throw new Error("compute_budget_policy_missing");
    validateReservation(input, policy);
    const now = Date.now();
    const windowStart = Math.floor(now / policy.window_ms) * policy.window_ms;
    const policyDigest = sha256(JSON.stringify(policy));
    const reservationId = sha256(`blue-tanuki.compute-budget.reservation.v1\0${input.request_id}`);
    const requestDigest = sha256(`blue-tanuki.compute-budget.request.v1\0${input.request_id}`);
    const costMicros = toMicros(input.reserved_cost.amount);
    const requested = {
      tokens: input.reserved_tokens,
      compute_ms: input.reserved_compute_ms,
      cost_micros: costMicros,
    };

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT reservation_id FROM compute_budget_reservations WHERE request_id_digest=?",
      ).get(requestDigest) as { reservation_id: string } | undefined;
      if (existing) throw new Error("compute_budget_duplicate_request");
      this.assertWindowCurrency(windowStart, input.reserved_cost.currency);
      assertWithinLimit(this.totals(windowStart, input.reserved_cost.currency), requested, policy.system, "system");
      assertWithinLimit(this.totals(windowStart, input.reserved_cost.currency, "parent_scope_digest", input.scope.parent_task_identity_digest), requested, policy.parent, "parent");
      assertWithinLimit(this.totals(windowStart, input.reserved_cost.currency, "task_scope_digest", input.scope.task_identity_digest), requested, policy.task, "task");
      this.database.prepare(`INSERT INTO compute_budget_reservations (
        reservation_id,request_id_digest,window_start_ms,policy_digest,parent_scope_digest,task_scope_digest,
        reserved_tokens,charged_tokens,reserved_compute_ms,charged_compute_ms,
        reserved_cost_micros,charged_cost_micros,currency,state,settlement_digest,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',NULL,?,?)`).run(
        reservationId,
        requestDigest,
        windowStart,
        policyDigest,
        input.scope.parent_task_identity_digest,
        input.scope.task_identity_digest,
        requested.tokens,
        requested.tokens,
        requested.compute_ms,
        requested.compute_ms,
        requested.cost_micros,
        requested.cost_micros,
        input.reserved_cost.currency,
        now,
        now,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      reservation_id: reservationId,
      reserved_tokens: requested.tokens,
      reserved_compute_ms: requested.compute_ms,
      reserved_cost: { ...input.reserved_cost },
    };
  }

  settle(reservationId: string, settlement: ComputeBudgetSettlement): void {
    if (!DIGEST.test(reservationId)) throw new Error("compute_budget_reservation_id_invalid");
    validateSettlement(settlement);
    const settlementJson = JSON.stringify(settlement);
    const settlementDigest = sha256(settlementJson);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT state,settlement_digest,reserved_tokens,reserved_compute_ms,
        reserved_cost_micros,currency FROM compute_budget_reservations WHERE reservation_id=?`)
        .get(reservationId) as {
          state: "reserved" | "settled" | "unknown";
          settlement_digest: string | null;
          reserved_tokens: number;
          reserved_compute_ms: number;
          reserved_cost_micros: number;
          currency: string;
        } | undefined;
      if (!row) throw new Error("compute_budget_reservation_missing");
      if (row.state !== "reserved") {
        if (row.settlement_digest === settlementDigest) {
          this.database.exec("COMMIT");
          return;
        }
        throw new Error("compute_budget_settlement_conflict");
      }

      let chargedTokens = row.reserved_tokens;
      if (settlement.tokens_usage_status === "provider_reported") {
        chargedTokens = settlement.tokens_used;
      }
      let chargedComputeMs = settlement.state === "unknown"
        ? Math.max(row.reserved_compute_ms, settlement.compute_ms)
        : settlement.compute_ms;
      let chargedCostMicros = row.reserved_cost_micros;
      let finalState: "settled" | "unknown" = settlement.state;
      if (settlement.cost.status === "actual" || settlement.cost.status === "estimated") {
        if (settlement.cost.currency === row.currency) {
          chargedCostMicros = toMicros(settlement.cost.amount);
          if (chargedCostMicros > row.reserved_cost_micros) finalState = "unknown";
        } else {
          finalState = "unknown";
        }
      }
      if (settlement.state === "unknown") {
        chargedTokens = row.reserved_tokens;
        chargedComputeMs = Math.max(row.reserved_compute_ms, settlement.compute_ms);
        chargedCostMicros = row.reserved_cost_micros;
      }
      this.database.prepare(`UPDATE compute_budget_reservations SET state=?,charged_tokens=?,charged_compute_ms=?,
        charged_cost_micros=?,settlement_digest=?,settlement_json=?,updated_at_ms=? WHERE reservation_id=? AND state='reserved'`)
        .run(finalState, chargedTokens, chargedComputeMs, chargedCostMicros, settlementDigest, settlementJson, Date.now(), reservationId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private totals(windowStart: number, currency: string, scopeColumn?: "parent_scope_digest" | "task_scope_digest", scopeDigest?: string): ResourceTotals {
    const where = scopeColumn ? `window_start_ms=? AND currency=? AND ${scopeColumn}=?` : "window_start_ms=? AND currency=?";
    const query = this.database.prepare(`SELECT COALESCE(SUM(charged_tokens),0) AS tokens,
      COALESCE(SUM(charged_compute_ms),0) AS compute_ms,
      COALESCE(SUM(charged_cost_micros),0) AS cost_micros
      FROM compute_budget_reservations WHERE ${where}`);
    const result = scopeColumn
      ? query.get(windowStart, currency, scopeDigest!) as unknown as ResourceTotals
      : query.get(windowStart, currency) as unknown as ResourceTotals;
    return result;
  }

  private assertWindowCurrency(windowStart: number, currency: string): void {
    const rows = this.database.prepare("SELECT DISTINCT currency FROM compute_budget_reservations WHERE window_start_ms=? LIMIT 2")
      .all(windowStart) as unknown as Array<{ currency: string }>;
    if (rows.some((row) => row.currency !== currency)) throw new Error("compute_budget_currency_changed_within_window");
  }
}

export function parseComputeBudgetPolicy(raw: string | undefined): ComputeBudgetPolicy {
  if (!raw?.trim()) return structuredClone(DEFAULT_COMPUTE_BUDGET_POLICY);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON must be valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "currency,parent,system,task,window_ms") {
    throw new Error("BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON has an invalid shape");
  }
  const policy: ComputeBudgetPolicy = {
    window_ms: value.window_ms as number,
    currency: value.currency as string,
    system: parseLimit(value.system, "system"),
    parent: parseLimit(value.parent, "parent"),
    task: parseLimit(value.task, "task"),
  };
  validatePolicy(policy);
  return policy;
}

interface ResourceTotals {
  tokens: number;
  compute_ms: number;
  cost_micros: number;
}

function parseLimit(value: unknown, label: string): ComputeBudgetPolicy["system"] {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "max_compute_ms,max_cost,max_tokens") {
    throw new Error(`BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON.${label} has an invalid shape`);
  }
  if (!isRecord(value.max_cost) || Object.keys(value.max_cost).sort().join(",") !== "amount,currency") {
    throw new Error(`BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON.${label}.max_cost has an invalid shape`);
  }
  return {
    max_tokens: value.max_tokens as number,
    max_compute_ms: value.max_compute_ms as number,
    max_cost: { amount: value.max_cost.amount as number, currency: value.max_cost.currency as string },
  };
}

function validatePolicy(policy: ComputeBudgetPolicy): void {
  if (policy.window_ms !== DEFAULT_COMPUTE_BUDGET_POLICY.window_ms) {
    throw new Error("compute budget window_ms must be the fixed 24-hour UTC period");
  }
  if (!/^[A-Z]{3}$/.test(policy.currency)) throw new Error("compute budget currency must be an uppercase ISO-style code");
  for (const [scope, limit] of Object.entries({ system: policy.system, parent: policy.parent, task: policy.task })) {
    if (!Number.isSafeInteger(limit.max_tokens) || limit.max_tokens <= 0 ||
        !Number.isSafeInteger(limit.max_compute_ms) || limit.max_compute_ms <= 0 ||
        !Number.isFinite(limit.max_cost.amount) || limit.max_cost.amount < 0 ||
        limit.max_cost.currency !== policy.currency || !/^[A-Z]{3}$/.test(limit.max_cost.currency)) {
      throw new Error(`compute budget ${scope} limits are invalid`);
    }
    toMicros(limit.max_cost.amount);
  }
}

function validateReservation(
  input: Parameters<ComputeBudgetPort["reserve"]>[0],
  policy: ComputeBudgetPolicy,
): void {
  validatePolicy(policy);
  if (!input.request_id.trim() || !DIGEST.test(input.scope.parent_task_identity_digest) ||
      !DIGEST.test(input.scope.task_identity_digest)) throw new Error("compute_budget_scope_invalid");
  if (!Number.isSafeInteger(input.reserved_tokens) || input.reserved_tokens <= 0 ||
      !Number.isSafeInteger(input.reserved_compute_ms) || input.reserved_compute_ms <= 0 ||
      !Number.isFinite(input.reserved_cost.amount) || input.reserved_cost.amount < 0 ||
      input.reserved_cost.currency !== policy.currency || input.reserved_cost.source !== "CONFIG") {
    throw new Error("compute_budget_reservation_invalid");
  }
  toMicros(input.reserved_cost.amount);
}

function validateSettlement(settlement: ComputeBudgetSettlement): void {
  if ((settlement.state !== "settled" && settlement.state !== "unknown") ||
      !Number.isSafeInteger(settlement.tokens_used) || settlement.tokens_used < 0 ||
      (settlement.tokens_usage_status !== "provider_reported" && settlement.tokens_usage_status !== "unknown") ||
      !Number.isSafeInteger(settlement.compute_ms) || settlement.compute_ms < 0) {
    throw new Error("compute_budget_settlement_invalid");
  }
  if (settlement.cost.status === "unknown") {
    if (!/^[a-z0-9_]{1,120}$/.test(settlement.cost.reason)) throw new Error("compute_budget_settlement_reason_invalid");
    return;
  }
  if (!Number.isFinite(settlement.cost.amount) || settlement.cost.amount < 0 || !/^[A-Z]{3}$/.test(settlement.cost.currency)) {
    throw new Error("compute_budget_settlement_cost_invalid");
  }
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(settlement.cost.source)) throw new Error("compute_budget_settlement_source_invalid");
  toMicros(settlement.cost.amount);
}

function assertWithinLimit(
  current: ResourceTotals,
  requested: ResourceTotals,
  limit: ComputeBudgetPolicy["system"],
  scope: string,
): void {
  const maxCostMicros = toMicros(limit.max_cost.amount);
  if (current.tokens + requested.tokens > limit.max_tokens ||
      current.compute_ms + requested.compute_ms > limit.max_compute_ms ||
      current.cost_micros + requested.cost_micros > maxCostMicros) {
    throw new Error(`compute_budget_${scope}_exhausted`);
  }
}

function toMicros(amount: number): number {
  const micros = Math.ceil(amount * COST_SCALE);
  if (!Number.isSafeInteger(micros)) throw new Error("compute_budget_cost_out_of_range");
  return micros;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
