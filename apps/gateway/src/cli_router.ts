import { relative } from "node:path";
import { createLogger } from "@blue-tanuki/core";
import { loadEnvFileFromArgv, stripEnvFileArgs } from "./env_file.js";
import { applyGatewaySafeMode } from "./safe_mode.js";

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

async function runRecoveryInspectCli(argv: string[]): Promise<void> {
  const env = { ...process.env };
  const args = stripEnvFileArgs(argv);
  const json = args.includes("--json");
  const backupArg = args.indexOf("--backup-id");
  const backupId = backupArg === -1 ? undefined : args[backupArg + 1];
  if (backupArg !== -1 && (backupArg !== args.lastIndexOf("--backup-id") ||
      !backupId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(backupId) || backupId === "latest")) {
    writeStdout(json ? JSON.stringify({ status: "invalid_backup_id" }) : "正確なバックアップIDを指定してください。");
    process.exitCode = 2;
    return;
  }
  if (backupArg !== -1) args.splice(backupArg, 2);
  if (args.some((arg) => arg !== "--recovery-inspect" && arg !== "--json")) {
    writeStdout(json ? JSON.stringify({ status: "invalid_arguments" }) : "復旧診断の引数に未対応の項目があります。");
    process.exitCode = 2;
    return;
  }
  try {
    await loadEnvFileFromArgv(argv, env);
  } catch {
    writeStdout(json ? JSON.stringify({ status: "configuration_unavailable" }) : "診断に使用する環境設定を読み込めません。");
    process.exitCode = 2;
    return;
  }
  const { inspectRuntimeRecoveryFence } = await import("./runtime_owner_lease.js");
  const runtimeRecoveryFence = inspectRuntimeRecoveryFence(env);
  if (!json) {
    writeStdout(`復旧処理の照合状態 ${runtimeRecoveryFence.status}`);
    if (runtimeRecoveryFence.status === "pending") {
      writeStdout(`事前バックアップID ${runtimeRecoveryFence.backup_id}`);
      writeStdout(`事前マニフェストSHA-256 ${runtimeRecoveryFence.manifest_sha256}`);
    }
  }
  if (backupId !== undefined) {
    const { inspectRecoveryBackupById } = await import("./recovery_surface.js");
    const backup = await inspectRecoveryBackupById(env, backupId);
    if (json) {
      writeStdout(JSON.stringify({ ...backup, runtime_recovery_fence: runtimeRecoveryFence }, null, 2));
    } else {
      writeStdout(`バックアップ検査 ${backup.status}`);
      writeStdout(`マニフェストSHA-256 ${backup.manifest_sha256 ?? "未確認"}`);
      writeStdout(`設定対象 ${backup.copied_required_item_count ?? "未確認"}/${backup.configured_required_item_count ?? "未確認"} (${backup.coverage})`);
      writeStdout(`正本台帳 ${backup.canonical_state_verified_store_count ?? "未確認"}/${backup.canonical_state_expected_store_count ?? "未確認"} (${backup.canonical_state_coverage})`);
      writeStdout("読み取り専用の検査です。台帳は個別に取得されており、仕事全体の復元可否はこの結果から判定できません。");
    }
    process.exitCode = runtimeRecoveryFence.status === "clear" && backup.status === "verified" &&
      (backup.coverage === "complete_for_configured_targets" || backup.coverage === "none_configured") &&
      backup.canonical_state_coverage === "complete" ? 0 : 2;
    return;
  }
  const { inspectGatewayRecoveryState, projectGatewayRecoveryInspectionForOperator } = await import("./recovery_inspection.js");
  const report = inspectGatewayRecoveryState(env);
  if (json) {
    writeStdout(JSON.stringify({ ...report, runtime_recovery_fence: runtimeRecoveryFence }, null, 2));
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
    const cronEvents = report.ledgers.cron_events;
    writeStdout(`Cron events: ${cronEvents.status}; cursors=${cronEvents.verified_cursor_count ?? "unavailable"}/${cronEvents.cursor_count ?? "unavailable"}; unresolved_cursors=${cronEvents.unresolved_cursor_count ?? "unavailable"}; unverified_cursors=${cronEvents.unverified_cursor_count ?? "unavailable"}; orphan_outbox=${cronEvents.orphan_outbox_count ?? "unavailable"}; approvals=${cronEvents.verified_approval_handoff_count ?? "unavailable"}/${cronEvents.approval_handoff_count ?? "unavailable"}; pending_approvals=${cronEvents.pending_approval_handoff_count ?? "unavailable"}; interrupted_approvals=${cronEvents.interrupted_approval_handoff_count ?? "unavailable"}; residuals=${cronEvents.residual_count}`);
    if (cronEvents.reason) writeStdout(`Cron events reason: ${cronEvents.reason}`);
    for (const correlation of report.operation_plan_correlations) {
      writeStdout(`plan=${correlation.plan_id_digest} step=${correlation.step_id_digest} binding=${correlation.status}/${correlation.binding_integrity} broker=${correlation.broker_correlation} delivery=${correlation.delivery_correlation} memory=${correlation.memory_correlation} cron_approval=${correlation.cron_approval_correlation} cron_event=${correlation.cron_event_correlation}${correlation.cron_event_delivery_state ? ` cron_delivery_state=${correlation.cron_event_delivery_state}` : ""}${correlation.memory_update_id_digest ? ` update=${correlation.memory_update_id_digest}` : ""}`);
    }
    writeStdout(`Cron event history schema: ${cronEvents.event_history_available === null ? "unavailable" : cronEvents.event_history_available ? "digest archive" : "current cursor only"}; archived=${cronEvents.verified_archived_event_count ?? "unavailable"}/${cronEvents.archived_event_count ?? "unavailable"}; handler_returned does not prove task success.`);
    for (const scope of report.plan_dependency_scopes) {
      writeStdout(`plan_scope=${scope.plan_id_digest} request_scope=${scope.request_scope_digest ?? "unlinked"} status=${scope.status} bindings=${scope.inspected_binding_count}/${scope.binding_count} omitted=${scope.omitted_binding_count} residual_dependencies=${scope.residual_dependencies.join(",") || "none"} unobserved_dependencies=${scope.unobserved_dependencies.join(",") || "none"}`);
    }
    writeStdout(`Replay checkpoint: ${report.replay_checkpoint?.kind ?? "not confirmed"}`);
    writeStdout(`External backup restore point: ${report.external_backup_restore_point}`);
    writeStdout(`Isolated update references: ${report.isolated_update_count}`);
    writeStdout(`Execution ledger residuals: ${report.execution_residual_count}`);
    writeStdout(`Operation plan residuals: ${report.operation_plan_residual_count}`);
    writeStdout(`Cron approval correlation residuals: ${report.cron_approval_correlation_residual_count}`);
    const checkpoints = report.ledgers.document_organization_checkpoints;
    writeStdout(`Document organization checkpoints: ${checkpoints.status}; records=${checkpoints.checkpoint_count ?? "unavailable"}; verified=${checkpoints.verified_checkpoint_count ?? "unavailable"}; residual=${checkpoints.residual_checkpoint_count ?? "unavailable"}; omitted=${checkpoints.omitted_checkpoint_count ?? "unavailable"}; unresolved=${checkpoints.unresolved_checkpoint_count ?? "unavailable"}`);
    for (const checkpoint of checkpoints.records) {
      writeStdout(`checkpoint=${checkpoint.checkpoint_ref_digest ?? "unidentified"} request_scope=${checkpoint.request_scope_digest ?? "unlinked"} integrity=${checkpoint.integrity} reason=${checkpoint.reason ?? "none"} recorded_status=${checkpoint.checkpoint_status ?? "unknown"}`);
    }
    const requestScopeCorrelation = projectGatewayRecoveryInspectionForOperator(report).request_scope_correlation;
    writeStdout(`Request scope correlation: ${requestScopeCorrelation.status}; matched=${requestScopeCorrelation.matched_scope_count ?? "unavailable"}; plan_only=${requestScopeCorrelation.operation_plan_only_scope_count ?? "unavailable"}; checkpoint_only=${requestScopeCorrelation.document_checkpoint_only_scope_count ?? "unavailable"}; counterpart_unresolved=${requestScopeCorrelation.counterpart_unresolved_scope_count ?? "unavailable"}; unlinked_plan_scopes=${requestScopeCorrelation.unlinked_operation_plan_scope_count ?? "unavailable"}; unlinked_checkpoints=${requestScopeCorrelation.unlinked_document_checkpoint_count ?? "unavailable"}`);
    for (const scope of requestScopeCorrelation.entries) {
      writeStdout(`request_scope=${scope.request_scope_digest} relationship=${scope.relationship} status=${scope.status} plan_scopes=${scope.operation_plan_scope_count} residual_plan_scopes=${scope.residual_operation_plan_scope_count} unobserved_plan_scopes=${scope.unobserved_operation_plan_scope_count} verified_checkpoints=${scope.verified_document_checkpoint_count} unresolved_checkpoints=${scope.unresolved_document_checkpoint_count}`);
    }
    writeStdout(`Document organization checkpoint residuals: ${report.document_organization_checkpoint_residual_count}`);
    for (const residual of report.update_residuals) {
      writeStdout(`update=${residual.update_id_digest} disposition=${residual.disposition}`);
    }
    writeStdout(report.next_safe_action);
  }
  process.exitCode = runtimeRecoveryFence.status === "clear" && report.status === "verified" ? 0 : 2;
}

async function runRecoveryReconcileCli(argv: string[]): Promise<void> {
  const args = stripEnvFileArgs(argv);
  const json = args.includes("--json");
  function writeResult(status: string, successful = false): void {
    writeStdout(json ? JSON.stringify({ status, used_for_authority: false })
      : `初期化の照合結果 ${status}`);
    process.exitCode = successful ? 0 : 2;
  }

  const inputs = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--recovery-reconcile" || flag === "--json") continue;
    const value = args[index + 1];
    if ((flag !== "--backup-id" && flag !== "--manifest-sha256") || !value || inputs.has(flag)) {
      writeResult("invalid_arguments");
      return;
    }
    inputs.set(flag, value);
    index += 1;
  }
  const backupId = inputs.get("--backup-id");
  const manifestSha256 = inputs.get("--manifest-sha256")?.toLowerCase();
  if (!backupId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(backupId) ||
      !manifestSha256 || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    writeResult("invalid_arguments");
    return;
  }

  const env = { ...process.env };
  try {
    const config = await loadEnvFileFromArgv(argv, env);
    if (!config || (env.BLUE_TANUKI_ENV_FILE && relative(config.path, env.BLUE_TANUKI_ENV_FILE) !== "")) {
      writeResult("configuration_unavailable");
      return;
    }
    env.BLUE_TANUKI_ENV_FILE = config.path;
  } catch {
    writeResult("configuration_unavailable");
    return;
  }

  try {
    const { reconcileRuntimeRecoveryFence } = await import("./runtime_owner_lease.js");
    const { observeFactoryResetRecoveryState } = await import("./recovery_surface.js");
    const result = await reconcileRuntimeRecoveryFence(env, {
      backup_id: backupId, manifest_sha256: manifestSha256,
    }, evidence => observeFactoryResetRecoveryState(env, evidence));
    writeResult(result.status, result.status !== "unresolved");
  } catch {
    writeResult("unresolved");
  }
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
  const argv = process.argv.slice(2);
  if (argv.includes("--recovery-inspect")) {
    await runRecoveryInspectCli(argv);
    return;
  }
  if (argv.includes("--recovery-reconcile")) {
    await runRecoveryReconcileCli(argv);
    return;
  }
  const envFile = await loadEnvFileFromArgv(argv);
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
    if (applyGatewaySafeMode(process.env)) {
      gatewayLog.warn("safe mode active", {
        llm_provider: "stub",
        external_connectors: "disabled",
        runtime_schedules: "paused",
      });
    }
    await runServeCliMode();
    return;
  }
  await runOneShotCliMode(process.argv.slice(2));
}
