import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { operationPlanDigest, operationPlanTaskIdentityDigest } from "@blue-tanuki/hds-brain";
import type { OperationPlanCheckpoint } from "@blue-tanuki/protocol";
import type { RecoveryPostActionObservation } from "../src/recovery_surface.js";
import type { GatewayRecoveryOperatorProjection } from "../src/recovery_inspection.js";
import { brokerRestorePlanDependencyIsCurrent, operationPlanBrokerRestoreDependencyEvidenceFromObservation,
  operationPlanRecoveryEvidenceFromObservation } from "../src/operation_plan_recovery_evidence.js";

const planIds = ["plan-restored-clean", "plan-restored-residual"] as const;
const checkpoint = {
  schema_version: "operation-plan-state.v1",
  plans: planIds.map((plan_id) => ({ revisions: [{ plan: { plan_id } }] })),
} as unknown as OperationPlanCheckpoint;

function observation(overrides: Partial<RecoveryPostActionObservation> = {}): RecoveryPostActionObservation {
  return {
    status: "matched",
    operation: "restore",
    store_key: "operation_plans",
    operation_digest: "a".repeat(64),
    result_digest: "b".repeat(64),
    command_id_digest: createHash("sha256").update("recovery-command-1").digest("hex"),
    restored_state_digest: "d".repeat(64),
    store_ledger_status: "verified",
    store_ledger_residual_count: 0,
    plan_residuals: planIds.map((plan_id) => ({ plan_id_digest: operationPlanDigest(plan_id), status: "verified" as const,
      binding_count: 0, residual_binding_count: 0, omitted_binding_count: 0 })),
    restore_backup_id_digest: "c".repeat(64),
    restore_scope_plan_digest: operationPlanDigest(planIds[0]),
    plan_restore_points: planIds.map((plan_id) => ({ plan_id_digest: operationPlanDigest(plan_id),
      backup_plan_record_status: "matched" as const, backup_plan_integrity: "verified" as const, backup_plan_record_count: 1,
      dependency_status: "observed" as const, residual_dependencies: [], unobserved_dependencies: [] })),
    configuration_state: "not_observed",
    evidence_source: "COMPLETE_HISTORY_AND_LIVE_RUNTIME",
    used_for_authority: false,
    may_execute: false,
    ...overrides,
  };
}

function brokerProjection(input: {
  readonly scopes: readonly { plan_id_digest: string; status: "observed" | "residuals_present" | "unobserved";
    binding_count: number; inspected_binding_count: number; omitted_binding_count: number;
    residual_dependencies: readonly string[]; unobserved_dependencies: readonly string[] }[];
  readonly correlations: readonly { plan_id_digest: string; broker_correlation: "matched" | "not_admitted" | "not_found" }[];
}): GatewayRecoveryOperatorProjection {
  return {
    schema_version: 12,
    surface: "recovery_inspection_operator",
    mode: "read_only",
    boundary_valid: true,
    used_for_authority: false,
    may_execute: false,
    omitted_plan_dependency_scope_count: 0,
    plan_dependency_scopes: input.scopes.map((scope) => ({
      plan_id_digest: scope.plan_id_digest,
      request_scope_digest: null,
      integrity: "verified",
      plan_record_count: 1,
      binding_count: scope.binding_count,
      residual_binding_count: 0,
      omitted_binding_count: scope.omitted_binding_count,
      inspected_binding_count: scope.inspected_binding_count,
      status: scope.status,
      residual_dependencies: scope.residual_dependencies,
      unobserved_dependencies: scope.unobserved_dependencies,
    })),
    operation_plan_correlations: input.correlations.map((correlation) => ({
      plan_id_digest: correlation.plan_id_digest,
      broker_correlation: correlation.broker_correlation,
    })),
  } as unknown as GatewayRecoveryOperatorProjection;
}

describe("Recovery observationからHDS計画保留を導出", () => {
  it("cleanな計画証拠は観測状態のまま渡し、権限化しない", () => {
    const evidence = operationPlanRecoveryEvidenceFromObservation({ observation: observation(), checkpoint, history_complete: true });
    expect(evidence).toMatchObject({ scope: "restored_operation_plans", used_for_authority: false, may_execute: false,
      provenance: { source: "recovery_restore", restore_store_key: "operation_plans",
        command_id_digest: createHash("sha256").update("recovery-command-1").digest("hex") },
      plans: planIds.map((plan_id, index) => ({ plan_id_digest: operationPlanDigest(plan_id),
        restore_scope_relation: index === 0 ? "requested" : "collateral", restore_membership: "restored",
        integrity: "verified", dependency_status: "observed" })) });
  });

  it("plan-scoped mergeは要求planだけを復元済みにし、兄弟planを未変更として示す", () => {
    const evidence = operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ restore_scope_mode: "plan_scoped_merge_v1", status: "changed" }),
      checkpoint,
      history_complete: true,
    });
    expect(evidence).toMatchObject({
      scope: "restored_operation_plans",
      provenance: { restore_scope_mode: "plan_scoped_merge_v1", restore_store_key: "operation_plans" },
      plans: [
        { plan_id_digest: operationPlanDigest(planIds[0]), restore_scope_relation: "requested", restore_membership: "restored" },
        { plan_id_digest: operationPlanDigest(planIds[1]), restore_scope_relation: "collateral", restore_membership: "not_restored" },
      ],
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("task-scoped mergeは同じtask lineageの全計画だけを復元対象にし、別taskを保持対象として示す", () => {
    const taskDigest = "e".repeat(64);
    const unrelatedTaskDigest = "f".repeat(64);
    const ids = ["task-first", "task-sibling", "task-unrelated"] as const;
    const taskCheckpoint = {
      schema_version: "operation-plan-state.v1",
      plans: ids.map((plan_id, index) => ({
        task_identity_digest: index < 2 ? taskDigest : unrelatedTaskDigest,
        revisions: [{ plan: { plan_id } }],
      })),
    } as unknown as OperationPlanCheckpoint;
    const taskObservation = observation({
      status: "changed",
      restore_scope_plan_digest: null,
      restore_scope_task_digest: taskDigest,
      restore_scope_mode: "task_scoped_merge_v1",
      plan_residuals: ids.map((plan_id) => ({ plan_id_digest: operationPlanDigest(plan_id), status: "verified" as const,
        binding_count: 0, residual_binding_count: 0, omitted_binding_count: 0 })),
      plan_restore_points: ids.map((plan_id, index) => ({
        plan_id_digest: operationPlanDigest(plan_id),
        backup_task_identity_digest: index < 2 ? taskDigest : unrelatedTaskDigest,
        backup_task_lineage_plan_scope_count: index < 2 ? 2 : 1,
        backup_plan_record_status: "matched" as const,
        backup_plan_integrity: "verified" as const,
        backup_plan_record_count: 1,
        dependency_status: "observed" as const,
        residual_dependencies: [],
        unobserved_dependencies: [],
      })),
    });
    const evidence = operationPlanRecoveryEvidenceFromObservation({
      observation: taskObservation,
      checkpoint: taskCheckpoint,
      history_complete: true,
    });
    expect(evidence).toMatchObject({
      scope: "restored_operation_plans",
      provenance: {
        restore_store_key: "operation_plans",
        restore_scope_plan_digest: null,
        restore_scope_task_digest: taskDigest,
        restore_scope_mode: "task_scoped_merge_v1",
      },
      plans: [
        { plan_id_digest: operationPlanDigest(ids[0]), task_identity_digest: taskDigest,
          restore_scope_relation: "requested", restore_membership: "restored", dependency_status: "unobserved" },
        { plan_id_digest: operationPlanDigest(ids[1]), task_identity_digest: taskDigest,
          restore_scope_relation: "requested", restore_membership: "restored", dependency_status: "unobserved" },
        { plan_id_digest: operationPlanDigest(ids[2]), task_identity_digest: unrelatedTaskDigest,
          restore_scope_relation: "collateral", restore_membership: "not_restored" },
      ],
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("残差と未観測をdigest単位に保ち、未対応planはunknownに閉じる", () => {
    const current = observation({
      plan_residuals: [
        { plan_id_digest: operationPlanDigest(planIds[0]), status: "verified", binding_count: 1, residual_binding_count: 0, omitted_binding_count: 0 },
        { plan_id_digest: operationPlanDigest(planIds[1]), status: "residuals_present", binding_count: 1, residual_binding_count: 1, omitted_binding_count: 0 },
      ],
      plan_restore_points: [
        { plan_id_digest: operationPlanDigest(planIds[0]), backup_plan_record_status: "matched", backup_plan_integrity: "verified", backup_plan_record_count: 1,
          dependency_status: "unobserved", residual_dependencies: [], unobserved_dependencies: ["approval"] },
        { plan_id_digest: operationPlanDigest(planIds[1]), backup_plan_record_status: "matched", backup_plan_integrity: "residuals_present", backup_plan_record_count: 1,
          dependency_status: "residuals_present", residual_dependencies: ["execution_intent"], unobserved_dependencies: [] },
      ],
    });
    const evidence = operationPlanRecoveryEvidenceFromObservation({ observation: current, checkpoint, history_complete: true });
    expect(evidence?.plans).toEqual([
      { plan_id_digest: operationPlanDigest(planIds[0]), task_identity_digest: operationPlanTaskIdentityDigest(checkpoint.plans[0]!),
        restore_scope_relation: "requested", restore_membership: "restored", integrity: "verified", dependency_status: "unobserved" },
      { plan_id_digest: operationPlanDigest(planIds[1]), task_identity_digest: operationPlanTaskIdentityDigest(checkpoint.plans[1]!),
        restore_scope_relation: "collateral", restore_membership: "restored", integrity: "residuals_present", dependency_status: "residuals_present" },
    ]);

    const incomplete = operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ plan_restore_points: null }), checkpoint, history_complete: true,
    });
    expect(incomplete?.plans).toEqual(planIds.map((plan_id, index) => ({ plan_id_digest: operationPlanDigest(plan_id),
      task_identity_digest: operationPlanTaskIdentityDigest(checkpoint.plans[index]!),
      restore_scope_relation: index === 0 ? "requested" : "collateral", restore_membership: "unknown",
      integrity: "unverified", dependency_status: "unknown" })));
  });

  it("変更後stateで完全backup inventoryに存在しない計画は復元対象外として分離する", () => {
    const changed = observation({
      status: "changed",
      plan_restore_points: [
        { plan_id_digest: operationPlanDigest(planIds[0]), backup_plan_record_status: "not_found", backup_plan_integrity: null,
          backup_plan_record_count: null, dependency_status: "unknown", residual_dependencies: [], unobserved_dependencies: [] },
        { plan_id_digest: operationPlanDigest(planIds[1]), backup_plan_record_status: "matched", backup_plan_integrity: "residuals_present",
          backup_plan_record_count: 1, dependency_status: "residuals_present", residual_dependencies: ["operation_plan"], unobserved_dependencies: [] },
      ],
    });
    const evidence = operationPlanRecoveryEvidenceFromObservation({ observation: changed, checkpoint, history_complete: true });
    expect(evidence?.plans.map((plan) => plan.restore_membership)).toEqual(["not_restored", "restored"]);
  });

  it("missing requested-plan scope produces only unverified history evidence", () => {
    const evidence = operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ restore_scope_plan_digest: null }), checkpoint, history_complete: true,
    });
    expect(evidence).toMatchObject({
      scope: "unverified_history",
      provenance: { source: "recovery_restore", restore_scope_plan_digest: null },
      plans: [],
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("復元historyが欠落・不完全なら既存plan群のみにhold scopeを付ける", () => {
    const evidence = operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ status: "no_record", operation: null, store_key: null }), checkpoint, history_complete: false,
    });
    expect(evidence).toMatchObject({ scope: "unverified_history", plans: [], used_for_authority: false, may_execute: false });
  });

  it("完全なhistoryに復元recordがなければRecovery holdを作らない", () => {
    expect(operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ status: "no_record", operation: null, store_key: null }), checkpoint, history_complete: true,
    })).toBeUndefined();
  });

  it("J/M restore後はstore integrityがcleanでも既存plan群をunverified holdにする", () => {
    for (const store_key of ["j_control", "m_state", "cron_events"] as const) {
      const held = operationPlanRecoveryEvidenceFromObservation({
        observation: observation({
          status: "failed",
          store_key,
          store_ledger_status: "unverified",
          store_ledger_residual_count: null,
          plan_residuals: null,
          plan_restore_points: null,
        }),
        checkpoint,
        history_complete: true,
      });
      expect(held).toMatchObject({
        scope: "unverified_history",
        plans: [],
        used_for_authority: false,
        may_execute: false,
        provenance: { source: "recovery_restore", restore_store_key: store_key },
      });
      const verified = operationPlanRecoveryEvidenceFromObservation({
        observation: observation({
          store_key,
          store_ledger_status: "verified",
          store_ledger_residual_count: 0,
        }),
        checkpoint,
        history_complete: true,
      });
      if (store_key === "j_control" || store_key === "m_state") {
        expect(verified).toMatchObject({ scope: "unverified_history", plans: [], used_for_authority: false, may_execute: false,
          provenance: { restore_store_key: store_key } });
      } else {
        expect(verified).toBeUndefined();
      }
    }
  });

  it("Broker復元後は計画ごとの相関を分類し、別計画の未観測を混ぜない", () => {
    const brokerRestore = observation({
      store_key: "broker",
      restore_scope_plan_digest: null,
      plan_restore_points: null,
    });
    const affected = operationPlanDigest(planIds[0]);
    const unrelated = operationPlanDigest(planIds[1]);
    const projection = brokerProjection({
      scopes: [
        { plan_id_digest: affected, status: "observed", binding_count: 1, inspected_binding_count: 1,
          omitted_binding_count: 0, residual_dependencies: [], unobserved_dependencies: [] },
        { plan_id_digest: unrelated, status: "observed", binding_count: 1, inspected_binding_count: 1,
          omitted_binding_count: 0, residual_dependencies: [], unobserved_dependencies: [] },
      ],
      correlations: [
        { plan_id_digest: affected, broker_correlation: "matched" },
        { plan_id_digest: unrelated, broker_correlation: "not_admitted" },
      ],
    });
    const evidence = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: brokerRestore, checkpoint, history_complete: true, recovery_projection: projection,
    });
    expect(evidence).toMatchObject({
      restore_observation: "verified",
      plans: [
        { plan_id_digest: affected, status: "observed" },
        { plan_id_digest: unrelated, status: "unaffected" },
      ],
      used_for_authority: false,
      may_execute: false,
    });
    expect(brokerRestorePlanDependencyIsCurrent(projection, affected)).toBe(true);
    expect(brokerRestorePlanDependencyIsCurrent(projection, unrelated)).toBe(true);

    const taskIdentityDigest = "e".repeat(64);
    const unrelatedTaskDigest = "f".repeat(64);
    const taskCheckpoint = {
      ...checkpoint,
      plans: checkpoint.plans.map((plan, index) => ({
        ...plan,
        task_identity_digest: index === 0 ? taskIdentityDigest : unrelatedTaskDigest,
      })),
    } as unknown as OperationPlanCheckpoint;
    const taskScopedEvidence = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: observation({
        store_key: "broker",
        restore_scope_plan_digest: null,
        restore_scope_task_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
        plan_restore_points: null,
      }),
      checkpoint: taskCheckpoint,
      history_complete: true,
      recovery_projection: projection,
    });
    expect(taskScopedEvidence).toMatchObject({
      restore_observation: "verified",
      provenance: {
        restore_store_key: "broker",
        restore_scope_plan_digest: null,
        restore_scope_task_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
      },
      plans: [
        { plan_id_digest: affected, status: "observed" },
        { plan_id_digest: unrelated, status: "unaffected" },
      ],
      used_for_authority: false,
      may_execute: false,
    });

    const residualProjection = brokerProjection({
      scopes: [
        { plan_id_digest: affected, status: "residuals_present", binding_count: 1, inspected_binding_count: 1,
          omitted_binding_count: 0, residual_dependencies: ["memory"], unobserved_dependencies: [] },
        { plan_id_digest: unrelated, status: "observed", binding_count: 1, inspected_binding_count: 1,
          omitted_binding_count: 0, residual_dependencies: [], unobserved_dependencies: [] },
      ],
      correlations: [
        { plan_id_digest: affected, broker_correlation: "matched" },
        { plan_id_digest: unrelated, broker_correlation: "not_admitted" },
      ],
    });
    const residualEvidence = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: observation({
        store_key: "broker",
        restore_scope_plan_digest: null,
        restore_scope_task_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
        plan_restore_points: null,
      }),
      checkpoint: taskCheckpoint,
      history_complete: true,
      recovery_projection: residualProjection,
    });
    expect(residualEvidence?.plans).toEqual([
      { plan_id_digest: affected, status: "residuals_present" },
      { plan_id_digest: unrelated, status: "unaffected" },
    ]);

    const unavailableProjectionEvidence = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: observation({
        store_key: "broker",
        restore_scope_plan_digest: null,
        restore_scope_task_digest: taskIdentityDigest,
        restore_scope_mode: "task_scoped_merge_v1",
        plan_restore_points: null,
      }),
      checkpoint: taskCheckpoint,
      history_complete: true,
    });
    expect(unavailableProjectionEvidence?.plans).toEqual([
      { plan_id_digest: affected, status: "unobserved" },
      { plan_id_digest: unrelated, status: "unaffected" },
    ]);
  });

  it("Broker相関の未観測・残差と無効なprojectionはfail-closedで計画holdへ送る", () => {
    const brokerRestore = observation({ store_key: "broker", restore_scope_plan_digest: null, plan_restore_points: null });
    const affected = operationPlanDigest(planIds[0]);
    const unrelated = operationPlanDigest(planIds[1]);
    const projection = brokerProjection({
      scopes: [
        { plan_id_digest: affected, status: "residuals_present", binding_count: 1, inspected_binding_count: 1,
          omitted_binding_count: 0, residual_dependencies: ["memory"], unobserved_dependencies: [] },
        { plan_id_digest: unrelated, status: "unobserved", binding_count: 1, inspected_binding_count: 0,
          omitted_binding_count: 1, residual_dependencies: [], unobserved_dependencies: ["broker"] },
      ],
      correlations: [
        { plan_id_digest: affected, broker_correlation: "not_admitted" },
      ],
    });
    const evidence = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: brokerRestore, checkpoint, history_complete: true, recovery_projection: projection,
    });
    expect(evidence?.plans).toEqual([
      { plan_id_digest: affected, status: "residuals_present" },
      { plan_id_digest: unrelated, status: "unobserved" },
    ]);
    expect(brokerRestorePlanDependencyIsCurrent(projection, affected)).toBe(false);
    expect(brokerRestorePlanDependencyIsCurrent(projection, unrelated)).toBe(false);

    const unavailable = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: brokerRestore, checkpoint, history_complete: true,
    });
    expect(unavailable?.plans.every((entry) => entry.status === "unverified")).toBe(true);
    const incompleteHistory = operationPlanBrokerRestoreDependencyEvidenceFromObservation({
      observation: brokerRestore, checkpoint, history_complete: false, recovery_projection: projection,
    });
    expect(incompleteHistory).toMatchObject({
      restore_observation: "unverified",
      plans: checkpoint.plans.map((plan) => ({ plan_id_digest: operationPlanDigest(plan.revisions[0]!.plan.plan_id), status: "unverified" })),
    });
  });
});
