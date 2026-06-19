export type AotanuMascotState =
  | "idle"
  | "walk"
  | "working"
  | "happy"
  | "error";

export interface AotanuSpriteSheetSpec {
  asset_path: string;
  columns: 2;
  rows: 2;
  frame_count: 4;
  fps: number;
  label: string;
}

export const AOTANU_ASSET_ROUTE_PREFIX = "/assets/aotanu/spritesheets/" as const;

export const AOTANU_SPRITE_SPECS: Record<AotanuMascotState, AotanuSpriteSheetSpec> = {
  idle: {
    asset_path: `${AOTANU_ASSET_ROUTE_PREFIX}aotanu_idle_2x2.png`,
    columns: 2,
    rows: 2,
    frame_count: 4,
    fps: 3,
    label: "休憩中",
  },
  walk: {
    asset_path: `${AOTANU_ASSET_ROUTE_PREFIX}aotanu_walk_2x2.png`,
    columns: 2,
    rows: 2,
    frame_count: 4,
    fps: 6,
    label: "起動中",
  },
  working: {
    asset_path: `${AOTANU_ASSET_ROUTE_PREFIX}aotanu_working_2x2.png`,
    columns: 2,
    rows: 2,
    frame_count: 4,
    fps: 5,
    label: "診断中",
  },
  happy: {
    asset_path: `${AOTANU_ASSET_ROUTE_PREFIX}aotanu_happy_2x2.png`,
    columns: 2,
    rows: 2,
    frame_count: 4,
    fps: 6,
    label: "休憩中",
  },
  error: {
    asset_path: `${AOTANU_ASSET_ROUTE_PREFIX}aotanu_error_2x2.png`,
    columns: 2,
    rows: 2,
    frame_count: 4,
    fps: 3,
    label: "エラー",
  },
};

export const AOTANU_ASSET_FILENAMES = Object.values(AOTANU_SPRITE_SPECS).map((spec) =>
  spec.asset_path.slice(AOTANU_ASSET_ROUTE_PREFIX.length),
);

export interface AotanuRuntimeProjection {
  gateway_status?: unknown;
  status?: unknown;
  runtime_status?: unknown;
  task_status?: unknown;
  state?: unknown;
  phase?: unknown;
  hds_invariants_ok?: unknown;
  audit_chain_valid?: unknown;
  webchat_ready?: unknown;
  pending_approvals_count?: unknown;
  pending_schedule_approvals_count?: unknown;
  next_recommended_action?: unknown;
}

export function mapRuntimeSnapshotToAotanuMascotState(snapshot: AotanuRuntimeProjection): AotanuMascotState {
  const gatewayStatus = lowerStatus(snapshot.gateway_status);
  const workflowStatus = [
    snapshot.status,
    snapshot.runtime_status,
    snapshot.task_status,
    snapshot.state,
    snapshot.phase,
  ].map(lowerStatus).filter(Boolean).join(" ");
  const nextAction = lowerStatus(snapshot.next_recommended_action);
  const pendingApprovals = numberValue(snapshot.pending_approvals_count);
  const pendingSchedules = numberValue(snapshot.pending_schedule_approvals_count);

  if (
    isAny(gatewayStatus, ["degraded", "error", "failed", "blocked", "warning", "disconnected"]) ||
    containsAny(workflowStatus, ["error", "failed", "blocked", "warning", "permission_denied", "disconnected", "suspended"]) ||
    snapshot.hds_invariants_ok === false ||
    snapshot.audit_chain_valid === false ||
    snapshot.webchat_ready === false
  ) {
    return "error";
  }

  if (
    isAny(gatewayStatus, ["starting", "connecting", "launching", "loading"]) ||
    containsAny(workflowStatus, ["connecting", "launching", "navigating", "switching", "loading_route", "loading"])
  ) {
    return "walk";
  }

  if (
    pendingApprovals > 0 ||
    pendingSchedules > 0 ||
    containsAny(workflowStatus, ["running", "processing", "installing", "updating", "diagnosing", "setup_doctor", "syncing", "indexing", "waiting_approval"])
  ) {
    return "working";
  }

  if (
    containsAny(workflowStatus, ["success", "completed", "passed", "done", "recovered"]) ||
    (gatewayStatus === "running" &&
      snapshot.hds_invariants_ok === true &&
      snapshot.audit_chain_valid === true &&
      snapshot.webchat_ready !== false &&
      nextAction.length === 0)
  ) {
    return "happy";
  }

  return "idle";
}

function lowerStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isAny(value: string, candidates: readonly string[]): boolean {
  return candidates.includes(value);
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
