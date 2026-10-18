import { createLogger } from "@blue-tanuki/core";
import { loadEnvFileFromArgv } from "./env_file.js";

const gatewayLog = createLogger({ scope: "gateway" });

function writeStdout(text: string): void {
  process.stdout.write(text + "\n");
}

async function runDoctorCli(): Promise<void> {
  const { runDoctor, formatTextReport, formatJsonReport } = await import(
    "./doctor.js"
  );
  const json = process.argv.includes("--json");
  const mode = process.argv.includes("--strict")
    ? "strict"
    : process.argv.includes("--preview")
    ? "preview"
    : "core";
  const report = await runDoctor({ mode });
  if (json) {
    writeStdout(formatJsonReport(report));
  } else {
    writeStdout(formatTextReport(report));
  }
  process.exit(report.exit_code);
}

async function runAuditDumpCli(): Promise<void> {
  const { runAuditDump, formatAuditTextReport, formatAuditJsonReport } =
    await import("./audit_dump.js");
  const json = process.argv.includes("--json");
  const report = runAuditDump();
  if (json) {
    writeStdout(formatAuditJsonReport(report));
  } else {
    writeStdout(formatAuditTextReport(report));
  }
  process.exit(report.exit_code);
}

async function runAuditVerifyCli(): Promise<void> {
  const {
    runAuditVerify,
    formatAuditVerifyTextReport,
    formatAuditVerifyJsonReport,
  } = await import("./audit_verify.js");
  const json = process.argv.includes("--json");
  const report = runAuditVerify();
  if (json) {
    writeStdout(formatAuditVerifyJsonReport(report));
  } else {
    writeStdout(formatAuditVerifyTextReport(report));
  }
  process.exit(report.exit_code);
}

async function runFailureMemoryVerifyCli(): Promise<void> {
  const {
    runFailureMemoryVerify,
    formatFailureMemoryVerifyJson,
    formatFailureMemoryVerifyText,
  } = await import("./failure_memory_verify.js");
  const json = process.argv.includes("--json");
  const trigger = process.argv.includes("--before-release")
    ? "before_release"
    : process.argv.includes("--daily")
    ? "daily"
    : process.argv.includes("--startup")
    ? "startup"
    : process.argv.includes("--post-failure")
    ? "post_failure"
    : process.argv.includes("--after-test-failure")
    ? "after_test_failure"
    : "manual";
  const report = runFailureMemoryVerify({ trigger });
  if (json) {
    writeStdout(formatFailureMemoryVerifyJson(report));
  } else {
    writeStdout(formatFailureMemoryVerifyText(report));
  }
  process.exit(report.unresolved_risks.length > 0 || report.requires_human_review.length > 0 ? 1 : 0);
}

async function runRecoveryInspectCli(): Promise<void> {
  const { inspectGatewayRecoveryState } = await import("./recovery_inspection.js");
  const report = inspectGatewayRecoveryState(process.env);
  if (process.argv.includes("--json")) {
    writeStdout(JSON.stringify(report, null, 2));
  } else {
    writeStdout(`Recovery inspection: ${report.status}`);
    for (const ledger of [report.ledgers.j, report.ledgers.m]) {
      writeStdout(`${ledger.owner}: ${ledger.status}; verified_events=${ledger.verified_event_count}; unverified_events=${ledger.unverified_event_count}; last_verified_revision=${ledger.last_verified_revision}; last_verified_digest=${ledger.last_verified_event_digest ?? "unavailable"}`);
      if (ledger.first_unverified_ordinal !== null) {
        writeStdout(`${ledger.owner} first unverified event ordinal: ${ledger.first_unverified_ordinal}`);
      }
      if (ledger.reason) writeStdout(`${ledger.owner} reason: ${ledger.reason}`);
    }
    const execution = report.ledgers.execution;
    writeStdout(`Broker execution: ${execution.status}; verified_events=${execution.verified_event_count}; unverified_events=${execution.unverified_event_count}; last_verified_digest=${execution.last_verified_event_digest ?? "unavailable"}; current_state_available=${execution.current_state_available}; projection_mismatches=${execution.receipt_projection_mismatch_count}; outbox_mismatches=${execution.outbox_mismatch_count}`);
    if (execution.first_unverified_ordinal !== null) {
      writeStdout(`Broker execution first unverified event ordinal: ${execution.first_unverified_ordinal}`);
    }
    if (execution.reason) writeStdout(`Broker execution reason: ${execution.reason}`);
    const operationPlans = report.ledgers.operation_plans;
    writeStdout(`J Operation Plans: ${operationPlans.status}; plans=${operationPlans.plan_count}; plan_residuals=${operationPlans.plan_integrity_residual_count}; bindings=${operationPlans.binding_count}; verified_bindings=${operationPlans.verified_binding_count}; residual_bindings=${operationPlans.residual_binding_count}; unverified_memory_links=${operationPlans.unverified_memory_link_count}; omitted_bindings=${operationPlans.omitted_binding_count}`);
    if (operationPlans.reason) writeStdout(`J Operation Plans reason: ${operationPlans.reason}`);
    for (const correlation of report.operation_plan_correlations) {
      writeStdout(`plan=${correlation.plan_id_digest} step=${correlation.step_id_digest} binding=${correlation.status}/${correlation.binding_integrity} broker=${correlation.broker_correlation} delivery=${correlation.delivery_correlation}`);
    }
    writeStdout(`Replay checkpoint: ${report.replay_checkpoint?.kind ?? "not confirmed"}`);
    writeStdout(`External backup restore point: ${report.external_backup_restore_point}`);
    writeStdout(`Isolated update references: ${report.isolated_update_count}`);
    writeStdout(`Execution ledger residuals: ${report.execution_residual_count}`);
    writeStdout(`Operation plan residuals: ${report.operation_plan_residual_count}`);
    for (const residual of report.update_residuals) {
      writeStdout(`update=${residual.update_id_digest} disposition=${residual.disposition}`);
    }
    writeStdout(report.next_safe_action);
  }
  process.exitCode = report.status === "verified" ? 0 : 2;
}

async function runSetupCliMode(): Promise<void> {
  const { runSetupCli } = await import("./setup.js");
  await runSetupCli(process.argv.slice(2));
}

async function runServeCliMode(): Promise<void> {
  const { runServe } = await import("./serve.js");
  await runServe();
}

async function runOneShotCliMode(argv: readonly string[]): Promise<void> {
  const { runCli } = await import("./runtime.js");
  await runCli(argv);
}

export async function runGatewayCliRouter(): Promise<void> {
  if (process.argv.includes("--recovery-inspect")) {
    await runRecoveryInspectCli();
    return;
  }
  const envFile = await loadEnvFileFromArgv(process.argv.slice(2));
  if (envFile) {
    gatewayLog.info("env file loaded", {
      path: envFile.path,
      applied: envFile.applied.length,
      skipped: envFile.skipped.length,
      warnings: envFile.warnings.length,
    });
  }
  if (process.argv.includes("--setup")) {
    await runSetupCliMode();
    return;
  }
  if (process.argv.includes("--doctor")) {
    await runDoctorCli();
    return;
  }
  if (process.argv.includes("--audit-dump")) {
    await runAuditDumpCli();
    return;
  }
  if (process.argv.includes("--audit-verify")) {
    await runAuditVerifyCli();
    return;
  }
  if (process.argv.includes("--failure-memory-verify")) {
    await runFailureMemoryVerifyCli();
    return;
  }
  const serveMode =
    process.argv.includes("--serve") || process.env.BLUE_TANUKI_SERVE === "1";
  if (serveMode) {
    await runServeCliMode();
    return;
  }
  await runOneShotCliMode(process.argv.slice(2));
}
