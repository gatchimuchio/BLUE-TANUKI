import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { operationPlanDigest, receiptForResultCommit, verifyResultMemoryCommit } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema, type ExecutionAdmission, type OperationPlanCheckpoint } from "@blue-tanuki/protocol";
import { executionAdmissionDigest } from "./execution_intent_store.js";
import { operationPlanRequestScopeDigest } from "./recovery_request_scope.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type OperationPlanBindingStatus = OperationPlanCheckpoint["plans"][number]["bindings"][number]["status"];

export interface OperationPlanMemoryLinkInspection {
  readonly integrity: "not_recorded" | "missing_expected" | "verified" | "residuals_present";
  readonly update_id_digest: string | null;
  readonly j_event_id_digest: string | null;
  readonly content_digest: string | null;
  readonly expected_version: number | null;
  readonly receipt_digest: string | null;
  readonly receipt_revision: number | null;
  readonly receipt_event_digest: string | null;
}

export interface OperationPlanRecoveryPlanSummary {
  readonly plan_id_digest: string;
  readonly request_scope_digest: string | null;
  readonly integrity: "verified" | "residuals_present";
  readonly plan_record_count: number;
  readonly binding_count: number;
  readonly residual_binding_count: number;
  readonly omitted_binding_count: number;
}

export interface OperationPlanRecoveryInspection {
  readonly owner: "J";
  readonly status: "verified" | "residuals_present" | "corrupt" | "unavailable" | "schema_mismatch";
  readonly reason: "checkpoint_missing" | "checkpoint_integrity_mismatch" | "binding_mismatch" | "cross_ledger_unverified" | "store_unavailable" | "schema_mismatch" | null;
  readonly plan_count: number;
  readonly plan_integrity_residual_count: number;
  readonly binding_count: number;
  readonly verified_binding_count: number;
  readonly residual_binding_count: number;
  readonly unverified_memory_link_count: number;
  readonly omitted_binding_count: number;
  readonly plans: readonly OperationPlanRecoveryPlanSummary[];
  readonly bindings: readonly {
    readonly plan_id_digest: string;
    readonly step_id_digest: string;
    readonly command_id_digest: string;
    /** SHA-256 of the raw command ID, matching the digest stored by Cron approval handoffs. */
    readonly cron_command_id_digest: string;
    readonly revision_digest: string;
    readonly step_digest: string;
    readonly status: OperationPlanBindingStatus;
    readonly integrity: "verified" | "residuals_present";
    readonly admission_digest: string | null;
    readonly delivery_digest: string | null;
    readonly memory_link: OperationPlanMemoryLinkInspection;
  }[];
  readonly used_for_authority: false;
  readonly may_execute: false;
}

function unavailablePlanInspection(
  status: OperationPlanRecoveryInspection["status"] = "unavailable",
  reason: OperationPlanRecoveryInspection["reason"] = "store_unavailable",
): OperationPlanRecoveryInspection {
  return {
    owner: "J", status, reason, plan_count: 0, plan_integrity_residual_count: 0, binding_count: 0,
    verified_binding_count: 0, residual_binding_count: 0, unverified_memory_link_count: 0, omitted_binding_count: 0,
    plans: [], bindings: [], used_for_authority: false, may_execute: false,
  };
}

function safeOperationPlanRecoveryPath(privateStateRoot: string, databasePath: string): string | null {
  try {
    const rootStat = lstatSync(privateStateRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const root = realpathSync(privateStateRoot);
    const absolutePath = resolve(databasePath);
    const rel = relative(root, absolutePath);
    if (rel !== join("operation-plans", "j-state.sqlite") || isAbsolute(rel) || rel.startsWith(`..${sep}`)) return null;
    const directory = join(root, "operation-plans");
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
    const fileStat = lstatSync(absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size === 0 || realpathSync(absolutePath) !== absolutePath) return null;
    return absolutePath;
  } catch {
    return null;
  }
}

function verifyOperationPlanRecoverySchema(database: DatabaseType): boolean {
  const rows = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger')")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables = rows.filter((row) => row.type === "table");
  if (tables.length !== 1 || tables[0]?.name !== "operation_plan_state" || rows.some((row) => row.type === "trigger")) return false;
  if (typeof tables[0]?.sql !== "string" || !/\bSTRICT\b/i.test(tables[0].sql)) return false;
  const columns = database.prepare("PRAGMA table_info(operation_plan_state)").all() as
    { name: string; type: string; pk: number }[];
  const expected = [
    { name: "id", type: "INTEGER", pk: 1 },
    { name: "checkpoint_json", type: "TEXT", pk: 0 },
    { name: "digest", type: "TEXT", pk: 0 },
  ];
  return columns.length === expected.length && expected.every((column, index) => {
    const actual = columns[index];
    return actual?.name === column.name && actual.type.toUpperCase() === column.type && actual.pk === column.pk;
  });
}

function stepDefinitionDigest(step: OperationPlanCheckpoint["plans"][number]["revisions"][number]["plan"]["steps"][number]): string {
  const { state: _state, result_digest: _result, ...definition } = step;
  return operationPlanDigest(definition);
}

function commandKeyFor(commandId: string): string {
  // Keep this digest definition aligned with the Executor command-key contract.
  return createHash("sha256").update(JSON.stringify(["gateway-executor-command.v1", commandId])).digest("hex");
}

function inspectResultMemoryLink(
  plan: OperationPlanCheckpoint["plans"][number],
  binding: OperationPlanCheckpoint["plans"][number]["bindings"][number],
): OperationPlanMemoryLinkInspection {
  const commit = binding.memory_commit;
  const receipt = binding.memory_receipt;
  if (!commit && !receipt) {
    const expected = binding.status === "verified" && binding.operation === "file.search" &&
      binding.execution_admission !== undefined && binding.delivery_digest !== undefined && binding.result_digest !== undefined &&
      plan.results.some((result) => result.step_id === binding.step_id);
    return {
      integrity: expected ? "missing_expected" : "not_recorded",
      update_id_digest: null, j_event_id_digest: null, content_digest: null,
      expected_version: null, receipt_digest: null, receipt_revision: null, receipt_event_digest: null,
    };
  }

  let commitValid = false;
  let receiptValid = !receipt;
  try {
    commitValid = !!commit && verifyResultMemoryCommit(plan, binding);
    receiptValid = !receipt || (!!commit && commitValid && receiptForResultCommit(receipt, commit));
  } catch {
    commitValid = false;
    receiptValid = false;
  }
  if (!commitValid || !receiptValid || !commit) {
    return {
      integrity: "residuals_present", update_id_digest: null, j_event_id_digest: null, content_digest: null,
      expected_version: null, receipt_digest: null, receipt_revision: null, receipt_event_digest: null,
    };
  }
  return {
    integrity: "verified",
    update_id_digest: createHash("sha256").update(commit.update_id).digest("hex"),
    j_event_id_digest: createHash("sha256").update(commit.j_event_id).digest("hex"),
    content_digest: commit.content_digest,
    expected_version: commit.expected_version,
    receipt_digest: receipt?.receipt_digest ?? null,
    receipt_revision: receipt?.revision ?? null,
    receipt_event_digest: receipt?.event_digest ?? null,
  };
}

function inspectCheckpointBindings(checkpoint: OperationPlanCheckpoint): {
  bindings: OperationPlanRecoveryInspection["bindings"];
  plans: Omit<OperationPlanRecoveryPlanSummary, "omitted_binding_count">[];
  residualPlanCount: number;
  verifiedCount: number;
  residualCount: number;
  unverifiedMemoryLinkCount: number;
} {
  const planIds = checkpoint.plans.map((plan) => plan.revisions[0]!.plan.plan_id);
  const duplicatePlanIds = new Set(planIds.filter((id, index) => planIds.indexOf(id) !== index));
  const commandIds = checkpoint.plans.flatMap((plan) => plan.bindings.map((binding) => binding.command_id));
  const duplicateCommandIds = new Set(commandIds.filter((id, index) => commandIds.indexOf(id) !== index));
  const ticketIds = checkpoint.plans.flatMap((plan) => plan.bindings.flatMap((binding) =>
    binding.execution_admission ? [binding.execution_admission.ticket_id] : []));
  const duplicateTicketIds = new Set(ticketIds.filter((id, index) => ticketIds.indexOf(id) !== index));
  const bindings: NonNullable<OperationPlanRecoveryInspection["bindings"]>[number][] = [];
  const planSummaries = new Map<string, Omit<OperationPlanRecoveryPlanSummary, "omitted_binding_count">>();
  let verifiedCount = 0;
  let residualCount = 0;
  let residualPlanCount = 0;
  let unverifiedMemoryLinkCount = 0;

  for (const planState of checkpoint.plans) {
    const firstRevision = planState.revisions[0]!;
    const planId = firstRevision.plan.plan_id;
    const planIdDigest = operationPlanDigest(planId);
    const requestId = firstRevision.plan.request_id;
    const planRevisionMismatch = duplicatePlanIds.has(planId) || planState.revisions.some((revision) =>
      revision.digest !== operationPlanDigest(revision.plan) || revision.plan.plan_id !== planId || revision.plan.request_id !== requestId ||
      !["planned", "draft"].includes(revision.plan.state) || revision.plan.steps.some((step) =>
        !["planned", "draft"].includes(step.state) || step.result_digest !== undefined));
    if (planRevisionMismatch) residualPlanCount++;
    let planResidualBindingCount = 0;
    let planHasResidual = planRevisionMismatch;
    const invalidResultCommands = new Set<string>();
    for (const result of planState.results) {
      const binding = planState.bindings.find((item) => item.step_id === result.step_id && item.status === "verified");
      const validations = binding?.prepared_step.preparation?.validation;
      const resultMismatch = !binding || result.plan_id !== planId || result.request_id !== requestId ||
        result.operation !== binding.operation || result.expires_at_ms !== result.observed_at_ms + 600_000 ||
        operationPlanDigest(result.target) !== operationPlanDigest(binding.prepared_step.target) || !validations?.length ||
        !validations.every((validation) => validation.method === "result_equals" &&
          operationPlanDigest(validation.target) === operationPlanDigest(result.target) &&
          operationPlanDigest(validation.expected) === operationPlanDigest(result.output));
      if (resultMismatch) {
        if (binding) invalidResultCommands.add(binding.command_id);
        else {
          residualPlanCount++;
          planHasResidual = true;
        }
      }
    }
    for (const binding of planState.bindings) {
      const revision = planState.revisions.find((item) => item.digest === binding.revision_digest);
      const step = revision?.plan.steps.find((item) => item.step_id === binding.step_id);
      const admission = binding.execution_admission as ExecutionAdmission | undefined;
      const admissionMismatch = admission !== undefined && (
        duplicateTicketIds.has(admission.ticket_id) || admission.command_key !== commandKeyFor(binding.command_id) ||
        binding.status === "selected" || binding.status === "invalidated");
      const deliveryMismatch = binding.delivery_digest !== undefined && (!admission || !binding.result_digest);
      const memoryLink = inspectResultMemoryLink(planState, binding);
      if (memoryLink.integrity !== "not_recorded") unverifiedMemoryLinkCount++;
      const invalid = planRevisionMismatch || !revision || !step ||
        (step ? stepDefinitionDigest(step) !== binding.step_digest : true) ||
        binding.prepared_step.step_id !== binding.step_id || binding.prepared_step.operation !== binding.operation ||
        (step ? step.operation !== binding.operation : true) || duplicateCommandIds.has(binding.command_id) ||
        admissionMismatch || deliveryMismatch || invalidResultCommands.has(binding.command_id) ||
        ["missing_expected", "residuals_present"].includes(memoryLink.integrity) ||
        (!admission && !["selected", "not_attempted", "invalidated"].includes(binding.status));
      if (invalid) {
        residualCount++;
        planResidualBindingCount++;
        planHasResidual = true;
      }
      else verifiedCount++;
      bindings.push({
        plan_id_digest: planIdDigest,
        step_id_digest: operationPlanDigest(binding.step_id),
        command_id_digest: operationPlanDigest(binding.command_id),
        cron_command_id_digest: createHash("sha256").update(binding.command_id).digest("hex"),
        revision_digest: binding.revision_digest,
        step_digest: binding.step_digest,
        status: binding.status,
        integrity: invalid ? "residuals_present" : "verified",
        admission_digest: admission ? executionAdmissionDigest(admission) : null,
        delivery_digest: binding.delivery_digest ?? null,
        memory_link: memoryLink,
      });
    }
    const existing = planSummaries.get(planIdDigest);
    const requestScopeDigest = planRevisionMismatch ? null :
      operationPlanRequestScopeDigest(requestId, planState.channel, planState.owner);
    planSummaries.set(planIdDigest, {
      plan_id_digest: planIdDigest,
      request_scope_digest: existing && existing.request_scope_digest !== requestScopeDigest
        ? null
        : requestScopeDigest,
      integrity: planHasResidual || !!existing ? "residuals_present" : "verified",
      plan_record_count: (existing?.plan_record_count ?? 0) + 1,
      binding_count: (existing?.binding_count ?? 0) + planState.bindings.length,
      residual_binding_count: (existing?.residual_binding_count ?? 0) + planResidualBindingCount,
    });
  }
  return { bindings, plans: [...planSummaries.values()], residualPlanCount, verifiedCount, residualCount, unverifiedMemoryLinkCount };
}

/** Inspect J's operation-plan checkpoint without constructing its mutating runtime store. */
export function inspectOperationPlanRecoveryLedger(options: {
  readonly private_state_root: string;
  readonly database_path: string;
}): OperationPlanRecoveryInspection {
  let database: DatabaseType | undefined;
  let databasePath: string;
  try {
    databasePath = safeOperationPlanRecoveryPath(options.private_state_root, options.database_path) ?? "";
    if (!databasePath || ["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      return unavailablePlanInspection();
    }
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    database.enableLoadExtension(false);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; BEGIN");
    if (["-journal", "-wal", "-shm"].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      return unavailablePlanInspection();
    }
    const mode = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof mode?.journal_mode !== "string" || mode.journal_mode.toLowerCase() !== "delete") {
      return unavailablePlanInspection();
    }
    if (!verifyOperationPlanRecoverySchema(database)) return unavailablePlanInspection("schema_mismatch", "schema_mismatch");

    const rows = database.prepare("SELECT id,checkpoint_json,digest FROM operation_plan_state ORDER BY id")
      .all() as { id: number; checkpoint_json: string; digest: string }[];
    if (rows.length === 0) return unavailablePlanInspection("unavailable", "checkpoint_missing");
    const row = rows[0];
    if (rows.length !== 1 || !row || row.id !== 1 || typeof row.checkpoint_json !== "string" || typeof row.digest !== "string") {
      return { ...unavailablePlanInspection("corrupt", "checkpoint_integrity_mismatch"), plan_integrity_residual_count: 1 };
    }
    let raw: unknown;
    try { raw = JSON.parse(row.checkpoint_json); }
    catch { return { ...unavailablePlanInspection("corrupt", "checkpoint_integrity_mismatch"), plan_integrity_residual_count: 1 }; }
    try {
      if (operationPlanDigest(raw) !== row.digest) return { ...unavailablePlanInspection("corrupt", "checkpoint_integrity_mismatch"), plan_integrity_residual_count: 1 };
    } catch { return { ...unavailablePlanInspection("corrupt", "checkpoint_integrity_mismatch"), plan_integrity_residual_count: 1 }; }
    const parsed = OperationPlanCheckpointSchema.safeParse(raw);
    if (!parsed.success) return { ...unavailablePlanInspection("schema_mismatch", "schema_mismatch"), plan_integrity_residual_count: 1 };

    const checkpoint = parsed.data;
    const inspected = inspectCheckpointBindings(checkpoint);
    const capped = inspected.bindings.slice(0, 200);
    const inspectedBindingsByPlan = new Map<string, number>();
    for (const binding of capped) {
      inspectedBindingsByPlan.set(binding.plan_id_digest, (inspectedBindingsByPlan.get(binding.plan_id_digest) ?? 0) + 1);
    }
    const residual = inspected.residualCount > 0 || inspected.residualPlanCount > 0 || inspected.unverifiedMemoryLinkCount > 0;
    return {
      owner: "J",
      status: residual ? "residuals_present" : "verified",
      reason: inspected.residualCount > 0 || inspected.residualPlanCount > 0
        ? "binding_mismatch"
        : inspected.unverifiedMemoryLinkCount > 0 ? "cross_ledger_unverified" : null,
      plan_count: checkpoint.plans.length,
      plan_integrity_residual_count: inspected.residualPlanCount,
      binding_count: inspected.bindings.length,
      verified_binding_count: inspected.verifiedCount,
      residual_binding_count: inspected.residualCount,
      unverified_memory_link_count: inspected.unverifiedMemoryLinkCount,
      omitted_binding_count: Math.max(0, inspected.bindings.length - capped.length),
      plans: inspected.plans.map((plan) => ({
        ...plan,
        omitted_binding_count: Math.max(0, plan.binding_count - (inspectedBindingsByPlan.get(plan.plan_id_digest) ?? 0)),
      })),
      bindings: capped,
      used_for_authority: false,
      may_execute: false,
    };
  } catch {
    return unavailablePlanInspection();
  } finally {
    try { database?.exec("ROLLBACK"); } catch { /* no read snapshot was opened */ }
    try { database?.close(); } catch { /* read-only inspection has no state to commit */ }
  }
}
