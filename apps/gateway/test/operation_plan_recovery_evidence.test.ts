import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import type { OperationPlanCheckpoint } from "@blue-tanuki/protocol";
import type { RecoveryPostActionObservation } from "../src/recovery_surface.js";
import { operationPlanRecoveryEvidenceFromObservation } from "../src/operation_plan_recovery_evidence.js";

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

describe("Recovery observationからHDS計画保留を導出", () => {
  it("cleanな計画証拠は観測状態のまま渡し、権限化しない", () => {
    const evidence = operationPlanRecoveryEvidenceFromObservation({ observation: observation(), checkpoint, history_complete: true });
    expect(evidence).toMatchObject({ scope: "restored_operation_plans", used_for_authority: false, may_execute: false,
      provenance: { source: "recovery_restore", command_id_digest: createHash("sha256").update("recovery-command-1").digest("hex") },
      plans: planIds.map((plan_id) => ({ plan_id_digest: operationPlanDigest(plan_id), restore_membership: "restored",
        integrity: "verified", dependency_status: "observed" })) });
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
      { plan_id_digest: operationPlanDigest(planIds[0]), restore_membership: "restored", integrity: "verified", dependency_status: "unobserved" },
      { plan_id_digest: operationPlanDigest(planIds[1]), restore_membership: "restored", integrity: "residuals_present", dependency_status: "residuals_present" },
    ]);

    const incomplete = operationPlanRecoveryEvidenceFromObservation({
      observation: observation({ plan_restore_points: null }), checkpoint, history_complete: true,
    });
    expect(incomplete?.plans).toEqual(planIds.map((plan_id) => ({ plan_id_digest: operationPlanDigest(plan_id), restore_membership: "unknown",
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
});
