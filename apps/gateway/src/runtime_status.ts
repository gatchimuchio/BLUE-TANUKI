import {
  runtimeInvariantReportOk,
  runtimeInvariantValuesOk,
  type HDSRuntimeSnapshot,
} from "@blue-tanuki/hds-brain";

export type GatewayStatus = "running" | "starting" | "degraded";

export interface RuntimeStatusInput {
  gateway_status?: GatewayStatus;
  hds: HDSRuntimeSnapshot;
  webchat_token?: string;
  webchat_resume_token?: string;
  webchat_maintenance_token?: string;
  telegram_bot_token?: string;
  pending_approvals_count: number;
  runtime_schedules_count: number;
  pending_schedule_approvals_count: number;
}

export interface RuntimeStatusSnapshot {
  gateway_status: GatewayStatus;
  hds_invariants_ok: boolean;
  webchat_ready: boolean;
  telegram_configured: boolean;
  pending_approvals_count: number;
  runtime_schedules_count: number;
  pending_schedule_approvals_count: number;
  audit_chain_valid: boolean;
  next_recommended_action: string | null;
}

export function buildRuntimeStatusSnapshot(
  input: RuntimeStatusInput,
): RuntimeStatusSnapshot {
  const hds_invariants_ok = runtimeInvariantsOk(input.hds);
  const webchat_ready = Boolean(
    input.webchat_token &&
      input.webchat_resume_token &&
      input.webchat_maintenance_token &&
      input.webchat_token !== input.webchat_resume_token &&
      input.webchat_token !== input.webchat_maintenance_token &&
      input.webchat_resume_token !== input.webchat_maintenance_token,
  );
  const telegram_configured = Boolean(input.telegram_bot_token);
  const audit_chain_valid = input.hds.audit.chain_valid === true;
  const gateway_status =
    input.gateway_status ?? (hds_invariants_ok && audit_chain_valid ? "running" : "degraded");

  return {
    gateway_status,
    hds_invariants_ok,
    webchat_ready,
    telegram_configured,
    pending_approvals_count: input.pending_approvals_count,
    runtime_schedules_count: input.runtime_schedules_count,
    pending_schedule_approvals_count: input.pending_schedule_approvals_count,
    audit_chain_valid,
    next_recommended_action: nextRecommendedAction({
      hds_invariants_ok,
      webchat_ready,
      telegram_configured,
      pending_approvals_count: input.pending_approvals_count,
      pending_schedule_approvals_count: input.pending_schedule_approvals_count,
      audit_chain_valid,
    }),
  };
}

function runtimeInvariantsOk(snapshot: HDSRuntimeSnapshot): boolean {
  return runtimeInvariantValuesOk(snapshot.invariants) && runtimeInvariantReportOk(snapshot.runtime_invariants);
}

function nextRecommendedAction(input: {
  hds_invariants_ok: boolean;
  webchat_ready: boolean;
  telegram_configured: boolean;
  pending_approvals_count: number;
  pending_schedule_approvals_count: number;
  audit_chain_valid: boolean;
}): string | null {
  if (!input.hds_invariants_ok) {
    return "Stop gateway and inspect Runtime Invariants before continuing";
  }
  if (!input.audit_chain_valid) {
    return "Run audit verification and inspect AUDIT.md before continuing";
  }
  if (!input.webchat_ready) {
    return "Configure distinct WEBCHAT_TOKEN, WEBCHAT_RESUME_TOKEN, and BLUE_TANUKI_MAINTENANCE_TOKEN, then restart";
  }
  if (input.pending_approvals_count > 0) {
    return "Review pending approvals in Control Center";
  }
  if (input.pending_schedule_approvals_count > 0) {
    return "Review pending runtime schedule approvals";
  }
  if (!input.telegram_configured) {
    return "Configure TELEGRAM_BOT_TOKEN to enable Telegram";
  }
  return null;
}
