import type { HDSRuntimeSnapshot } from "./controller.js";
import {
  evaluateFailSafeBoundary,
  type FailSafeInput,
} from "./boundary_policy.js";
import {
  runtimeInvariantReportOk,
  runtimeInvariantValuesOk,
} from "./runtime_invariants.js";

export type HDSBrainHealthStatus = "ok" | "fail_safe";
export type HealthCheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export type HDSBrainHealthPrecondition = keyof FailSafeInput;

export interface HDSBrainHealth {
  status: HDSBrainHealthStatus;
  config_validation_status: HealthCheckStatus;
  runtime_health_status: HealthCheckStatus;
  runtime_health_observed: boolean;
  measured_checks_count: number;
  unknown_checks_count: number;
  assumed_checks_count: number;
  runtime_checks: HDSRuntimeHealthCheck[];
  hds_available: boolean;
  policy_valid: boolean;
  audit_chain_valid: boolean;
  runtime_invariants_ok: boolean;
  approval_gate_available: boolean;
  memory_chain_valid?: boolean;
  hds_calls_llm: false;
  downstream_limbs_are_authority: false;
  fail_safe: boolean;
  failed_preconditions: HDSBrainHealthPrecondition[];
  command_execution_allowed: boolean;
  downstream_execution_allowed: boolean;
  fail_safe_reason: string;
  operator_next_action: string | null;
  safe_to_retry: boolean;
  used_for_authority: false;
  checked_at_ms: number;
}

export interface HDSBrainHealthOptions {
  now?: number;
  hds_available?: boolean;
  policy_valid?: boolean;
  approval_gate_available?: boolean;
  required_directories?: readonly RuntimePathCheck[];
  storage_paths?: readonly RuntimePathCheck[];
  optional_dependencies?: readonly RuntimeDependencyCheck[];
  audit_appendable?: AuditAppendabilityStatus;
}

export type AuditAppendabilityStatus = boolean | "memory_only" | "not_configured";

export interface RuntimePathCheck {
  path: string;
  readable?: boolean;
  writable?: boolean;
}

export interface RuntimeDependencyCheck {
  name: string;
  available?: boolean;
}

export interface HDSRuntimeHealthCheck {
  name: string;
  status: HealthCheckStatus;
  expected: string;
  actual: string;
  evidence: string;
  used_for_authority: false;
}

export function evaluateHDSBrainHealth(
  snapshot: HDSRuntimeSnapshot,
  opts: HDSBrainHealthOptions = {},
): HDSBrainHealth {
  const runtime_invariants_ok =
    runtimeInvariantValuesOk(snapshot.invariants) &&
    runtimeInvariantReportOk(snapshot.runtime_invariants);
  const runtime_checks = buildRuntimeChecks(snapshot, opts, runtime_invariants_ok);
  const runtime_health_status = aggregateRuntimeStatus(runtime_checks);
  const runtime_health_observed = runtime_health_status !== "UNKNOWN";
  const failSafeInput: FailSafeInput = {
    hds_available: opts.hds_available ?? true,
    policy_valid: opts.policy_valid ?? true,
    audit_chain_valid: snapshot.audit.chain_valid,
    runtime_invariants_valid: runtime_invariants_ok,
    runtime_health_observed,
    approval_gate_available: opts.approval_gate_available ?? true,
    memory_chain_valid: snapshot.memory.chain_valid,
  };
  const failSafe = evaluateFailSafeBoundary(failSafeInput);
  const unknown_checks_count = runtime_checks.filter((check) => check.status === "UNKNOWN").length;
  return {
    status: failSafe.allowed ? "ok" : "fail_safe",
    config_validation_status: failSafeInput.policy_valid ? "PASS" : "FAIL",
    runtime_health_status,
    runtime_health_observed,
    measured_checks_count: runtime_checks.length - unknown_checks_count,
    unknown_checks_count,
    assumed_checks_count: 0,
    runtime_checks,
    hds_available: failSafeInput.hds_available,
    policy_valid: failSafeInput.policy_valid,
    audit_chain_valid: snapshot.audit.chain_valid,
    runtime_invariants_ok,
    approval_gate_available: failSafeInput.approval_gate_available,
    memory_chain_valid: snapshot.memory.chain_valid,
    hds_calls_llm: false,
    downstream_limbs_are_authority: false,
    fail_safe: !failSafe.allowed,
    failed_preconditions: failSafe.failed_preconditions,
    command_execution_allowed: failSafe.command_execution_allowed,
    downstream_execution_allowed: failSafe.downstream_execution_allowed,
    fail_safe_reason: failSafe.reason,
    operator_next_action: nextAction(failSafe.failed_preconditions),
    safe_to_retry: failSafe.allowed,
    used_for_authority: false,
    checked_at_ms: opts.now ?? Date.now(),
  };
}

function buildRuntimeChecks(
  snapshot: HDSRuntimeSnapshot,
  opts: HDSBrainHealthOptions,
  runtime_invariants_ok: boolean,
): HDSRuntimeHealthCheck[] {
  const checks: HDSRuntimeHealthCheck[] = [
    {
      name: "process.uptime",
      status: typeof process?.uptime === "function" && process.uptime() >= 0 ? "PASS" : "UNKNOWN",
      expected: "process uptime is observable",
      actual: typeof process?.uptime === "function" ? `${Math.round(process.uptime() * 1000)}ms` : "unavailable",
      evidence: "Node process telemetry",
      used_for_authority: false,
    },
    {
      name: "process.memory",
      status: typeof process?.memoryUsage === "function" ? "PASS" : "UNKNOWN",
      expected: "process memory usage is observable",
      actual: typeof process?.memoryUsage === "function" ? `${process.memoryUsage().rss} rss bytes` : "unavailable",
      evidence: "Node process telemetry",
      used_for_authority: false,
    },
    {
      name: "audit.chain",
      status: snapshot.audit.chain_valid ? "PASS" : "FAIL",
      expected: "audit hash-chain verifies",
      actual: snapshot.audit.chain_valid ? "valid" : "invalid",
      evidence: `${snapshot.audit.entries} audit entries`,
      used_for_authority: false,
    },
    {
      name: "audit.appendability",
      status: auditAppendabilityCheckStatus(opts.audit_appendable),
      expected: "persistent audit log can append when configured, or memory audit is explicitly identified",
      actual: auditAppendabilityActual(opts.audit_appendable),
      evidence: "caller-provided audit appendability probe",
      used_for_authority: false,
    },
    {
      name: "runtime_invariants",
      status: runtime_invariants_ok ? "PASS" : "FAIL",
      expected: "Runtime Invariants evidence passes",
      actual: runtime_invariants_ok ? "all_ok" : "failed",
      evidence: snapshot.runtime_invariants.report_digest,
      used_for_authority: false,
    },
  ];

  for (const item of opts.required_directories ?? []) {
    checks.push(pathCheck(`required_directory:${item.path}`, item, true));
  }
  if (opts.required_directories === undefined) {
    checks.push({
      name: "required_directories",
      status: "UNKNOWN",
      expected: "required runtime directories are probed by the gateway",
      actual: "no directory probe supplied",
      evidence: "self-health was evaluated without filesystem directory probes",
      used_for_authority: false,
    });
  } else if (opts.required_directories.length === 0) {
    checks.push({
      name: "required_directories",
      status: "PASS",
      expected: "required runtime directories are explicitly scoped",
      actual: "no required filesystem runtime directories in this HDS scope",
      evidence: "caller supplied an empty required_directories probe set",
      used_for_authority: false,
    });
  }

  for (const item of opts.storage_paths ?? []) {
    checks.push(pathCheck(`storage_path:${item.path}`, item, true));
  }
  if (opts.storage_paths === undefined) {
    checks.push({
      name: "storage_paths",
      status: snapshot.memory.configured ? "UNKNOWN" : "PASS",
      expected: "configured storage paths are accessible",
      actual: snapshot.memory.configured ? "memory configured but no path probe supplied" : "no configured storage path",
      evidence: "storage path accessibility must be supplied by the adapter that owns the path",
      used_for_authority: false,
    });
  } else if (opts.storage_paths.length === 0) {
    checks.push({
      name: "storage_paths",
      status: "PASS",
      expected: "configured storage paths are explicitly probed or absent",
      actual: "no configured storage path in this HDS scope",
      evidence: "caller supplied an empty storage_paths probe set",
      used_for_authority: false,
    });
  }

  for (const item of opts.optional_dependencies ?? []) {
    checks.push({
      name: `optional_dependency:${item.name}`,
      status: item.available === undefined ? "UNKNOWN" : item.available ? "PASS" : "WARN",
      expected: "optional channel dependency is either available or clearly absent",
      actual: item.available === undefined ? "not checked" : item.available ? "available" : "not available",
      evidence: "optional downstream dependency check",
      used_for_authority: false,
    });
  }

  return checks;
}

function auditAppendabilityCheckStatus(status: AuditAppendabilityStatus | undefined): HealthCheckStatus {
  if (status === undefined || status === "not_configured") return "UNKNOWN";
  if (status === "memory_only") return "WARN";
  return status ? "PASS" : "FAIL";
}

function auditAppendabilityActual(status: AuditAppendabilityStatus | undefined): string {
  if (status === undefined) return "not probed";
  if (status === "not_configured") return "persistent audit not configured";
  if (status === "memory_only") return "memory audit only";
  return status ? "persistent audit appendable" : "persistent audit not appendable";
}

function pathCheck(name: string, item: RuntimePathCheck, required: boolean): HDSRuntimeHealthCheck {
  const readable = item.readable === true;
  const writable = item.writable === true;
  const unknown = item.readable === undefined || item.writable === undefined;
  return {
    name,
    status: unknown ? "UNKNOWN" : readable && writable ? "PASS" : required ? "FAIL" : "WARN",
    expected: "path is readable and writable",
    actual: `readable=${String(item.readable)}, writable=${String(item.writable)}`,
    evidence: item.path,
    used_for_authority: false,
  };
}

function aggregateRuntimeStatus(checks: readonly HDSRuntimeHealthCheck[]): HealthCheckStatus {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.some((check) => check.status === "UNKNOWN")) return "UNKNOWN";
  if (checks.some((check) => check.status === "WARN")) return "WARN";
  return "PASS";
}

function nextAction(failed: HDSBrainHealthPrecondition[]): string | null {
  if (failed.length === 0) return null;
  if (failed.includes("hds_available")) {
    return "Stop downstream execution and restart HDS-BRAIN before retrying";
  }
  if (failed.includes("policy_valid")) {
    return "Repair or roll back the HDS policy configuration, then retry the request";
  }
  if (failed.includes("audit_chain_valid")) {
    return "Stop execution and run audit verification before continuing";
  }
  if (failed.includes("runtime_invariants_valid")) {
    return "Inspect Runtime Invariants evidence and remediate the failed invariant before retrying";
  }
  if (failed.includes("runtime_health_observed")) {
    return "Run runtime self-health probes and resolve UNKNOWN checks before retrying";
  }
  if (failed.includes("approval_gate_available")) {
    return "Restore Approval Gate availability before any downstream execution";
  }
  if (failed.includes("memory_chain_valid")) {
    return "Inspect or repair the memory store; do not use memory as authority";
  }
  return "Inspect HDS-BRAIN self-health before retrying";
}
