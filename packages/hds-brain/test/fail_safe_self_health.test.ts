import { describe, expect, it } from "vitest";
import { HDSUpperController } from "../src/controller.js";
import { buildRuntimeInvariantEvidence } from "../src/runtime_invariants.js";
import { evaluateHDSBrainHealth } from "../src/health.js";
import type { AuditEntry } from "../src/audit.js";
import type { DecisionLog, PolicyConfig } from "../src/types.js";

function inbound(content: string, id = "self-health") {
  return {
    id,
    channel: "test",
    user: "u1",
    content,
    timestamp: 1,
  };
}

function asDecisionLog(entry: AuditEntry): DecisionLog {
  if (!("commit" in entry.log)) {
    throw new Error(`expected decision audit entry, got ${entry.log.kind}`);
  }
  return entry.log;
}

describe("Phase 12-S8 HDS-BRAIN fail-safe / self-health policy", () => {
  it("reports healthy self-health with command execution allowed", () => {
    const controller = new HDSUpperController();
    const health = evaluateHDSBrainHealth(controller.getRuntimeSnapshot(), {
      now: 1,
      required_directories: [],
      storage_paths: [],
      optional_dependencies: [],
      audit_appendable: "memory_only",
    });

    expect(health.status).toBe("ok");
    expect(health.config_validation_status).toBe("PASS");
    expect(health.runtime_health_status).toBe("WARN");
    expect(health.runtime_health_observed).toBe(true);
    expect(health.runtime_checks.some((check) => check.name === "process.uptime" && check.status === "PASS")).toBe(true);
    expect(health.runtime_checks.every((check) => check.used_for_authority === false)).toBe(true);
    expect(health.fail_safe).toBe(false);
    expect(health.failed_preconditions).toEqual([]);
    expect(health.command_execution_allowed).toBe(true);
    expect(health.downstream_execution_allowed).toBe(true);
    expect(health.used_for_authority).toBe(false);
    expect(health.operator_next_action).toBeNull();
  });

  it("fails closed when runtime health probes are UNKNOWN", () => {
    const controller = new HDSUpperController();
    const health = evaluateHDSBrainHealth(controller.getRuntimeSnapshot(), { now: 1 });

    expect(health.config_validation_status).toBe("PASS");
    expect(health.runtime_health_status).toBe("UNKNOWN");
    expect(health.runtime_health_observed).toBe(false);
    expect(health.runtime_checks.find((check) => check.name === "required_directories")?.status).toBe("UNKNOWN");
    expect(health.status).toBe("fail_safe");
    expect(health.failed_preconditions).toContain("runtime_health_observed");
    expect(health.command_execution_allowed).toBe(false);
    expect(health.downstream_execution_allowed).toBe(false);
    expect(health.operator_next_action).toContain("UNKNOWN");
  });

  it("suspends invalid raw inbound objects at the authority boundary", () => {
    const controller = new HDSUpperController();
    const { log, command } = controller.decide({
      id: "bad",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      unexpected: true,
    });

    expect(command).toBeNull();
    expect(log.commit.decision).toBe("SUSPEND");
    expect(log.commit.reason).toContain("authority_input_boundary");
    expect(log.model.structure.raw_input_used_for_authority).toBe(false);
    expect(controller.listSuspended()[0]?.resume_allowed).toBe(false);
  });

  it("maps failed runtime invariants into fail-safe self-health", () => {
    const failedReport = buildRuntimeInvariantEvidence({
      generated_at_ms: 1,
      actuals: { process_policy_enforced: false },
    });
    const controller = new HDSUpperController();
    const health = controller.getSelfHealth({ runtime_invariants: failedReport });

    expect(health.status).toBe("fail_safe");
    expect(health.failed_preconditions).toEqual(["runtime_invariants_valid"]);
    expect(health.command_execution_allowed).toBe(false);
    expect(health.downstream_execution_allowed).toBe(false);
    expect(health.operator_next_action).toContain("Runtime Invariants");
  });

  it("suspends new decisions and emits no command when self-health is fail-safe", () => {
    const failedReport = buildRuntimeInvariantEvidence({
      generated_at_ms: 1,
      actuals: { process_policy_enforced: false },
    });
    const controller = new HDSUpperController({
      self_health: { runtime_invariants: failedReport },
    });

    const { log, command } = controller.decide(inbound("hello under failed invariant", "fail-safe-runtime"));

    expect(command).toBeNull();
    expect(log.commit.decision).toBe("SUSPEND");
    expect(log.commit.reason).toContain("hds_fail_safe:suspend:runtime_invariants_valid");
    expect(log.commit.triggered_thresholds).toContain("hds_fail_safe:runtime_invariants_valid=false");
    expect(log.model.structure.self_health).toMatchObject({
      status: "fail_safe",
      failed_preconditions: ["runtime_invariants_valid"],
      command_execution_allowed: false,
      downstream_execution_allowed: false,
      used_for_authority: false,
    });
    expect(controller.listSuspended()[0]).toMatchObject({
      request_id: "fail-safe-runtime",
      fail_safe: true,
      resume_allowed: false,
    });
  });

  it("does not let human resume approve through a fail-safe suspension", () => {
    const controller = new HDSUpperController({
      self_health: { hds_available: false },
    });
    controller.decide(inbound("hello unavailable hds", "fail-safe-resume"));

    const resumed = controller.resume("fail-safe-resume", "approve", { actor: "owner" });

    expect(resumed.command).toBeNull();
    expect(resumed.log.commit.decision).toBe("SUSPEND");
    expect(resumed.log.commit.reason).toContain("human_resume_denied:fail_safe");
    expect(controller.listSuspended()).toHaveLength(1);
  });

  it("suspends before normal policy evaluation when the policy is structurally invalid", () => {
    const invalidPolicy: PolicyConfig = {
      problem_definition_id: "invalid_policy",
      axes: [],
      thresholds: {
        aggregate_assert: 0.6,
        out_of_scope_below: 0.2,
      },
    };
    const controller = new HDSUpperController({ policy: invalidPolicy });

    const { log, command } = controller.decide(inbound("hello invalid policy", "fail-safe-policy"));

    expect(command).toBeNull();
    expect(log.commit.decision).toBe("SUSPEND");
    expect(log.commit.triggered_thresholds).toContain("hds_fail_safe:policy_valid=false");
    expect(log.model.abstraction).toBe("self_health:fail_safe");
  });

  it("suspends later decisions when the audit chain is already broken", () => {
    const controller = new HDSUpperController();
    controller.decide(inbound("first normal request", "normal-before-tamper"));
    const entries = controller.getAudit().list() as Array<{ log: DecisionLog }>;
    entries[0]!.log.commit.reason = "tampered";

    const { log, command } = controller.decide(inbound("second request after tamper", "fail-safe-audit"));

    expect(command).toBeNull();
    expect(log.commit.decision).toBe("SUSPEND");
    expect(log.commit.triggered_thresholds).toContain("hds_fail_safe:audit_chain_valid=false");
    expect(asDecisionLog(controller.getAudit().list().at(-1)!).request_id).toBe("fail-safe-audit");
  });
});
