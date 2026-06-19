import type { Clock } from "@blue-tanuki/channel-base";
import type { OperationCoreApprovalTrace } from "@blue-tanuki/protocol";
import type { TicketStore } from "./ticket_store.js";
import type { ResumeApprovalTokenStore } from "./resume_approval_token_store.js";

export interface WebChatRateLimit {
  /** Burst capacity. */
  capacity: number;
  /** Sustained refill rate (tokens/sec). */
  refill_per_sec: number;
}

/**
 * Rate-limit configuration for the three authenticated endpoints.
 *
 * Defaults (Phase 4):
 *   - inbound:    capacity 10, refill 1.0/sec  ≈ 60/min/user with burst
 *   - resume:     capacity  5, refill 0.5/sec  ≈ 30/min global with burst
 *   - ws_ticket:  capacity  3, refill 10/60/sec ≈ 10/min/user with burst
 *
 * Pass `rate_limits: false` to disable entirely (used in tests).
 */
export interface WebChatRateLimits {
  inbound?: WebChatRateLimit;
  resume?: WebChatRateLimit;
  ws_ticket?: WebChatRateLimit;
}

export interface WebChatResumeApprovalOptions {
  /** If true, the gateway may convert this approval into a reusable grant. */
  remember?: boolean;
  /** Optional duration for the reusable grant. Null means no expiry. */
  duration_ms?: number | null;
  /** Optional widen mode. `full_access` remains final-review guarded downstream. */
  mode?: "remember_this_decision" | "full_access";
}

export interface WebChatResumeContext {
  actor: string;
  token_kind: "resume";
  approval?: WebChatResumeApprovalOptions;
}

export interface WebChatSettingsSurface {
  /** Dedicated bearer token for settings API endpoints. */
  token: string;
  /** Static settings HTML or a function that renders it. */
  html: string | (() => string);
  /** Return a redacted current-settings snapshot. */
  getSnapshot: () => Promise<unknown>;
  /** Persist a settings update. When omitted, POST is rejected. */
  update?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Verify a candidate LLM configuration without persisting it. */
  verifyLlm?: (body: Record<string, unknown>) => Promise<unknown>;
}

export interface WebChatRuntimeSurface {
  /** Return the HDS/process/memory/authority state visible to the local console. */
  getSnapshot: () => Promise<unknown>;
}

export interface WebChatOperatorSurface {
  /** Return a read-only operator surface snapshot. */
  getSnapshot: () => Promise<unknown>;
}

export interface WebChatApprovalQueueItem {
  command_id: string;
  request_id: string;
  operation: string;
  risk: string;
  approval_level?: string;
  final_review_required: boolean;
  reason: string;
  approval_token?: string;
  approval_token_expires_at_ms?: number;
  authority_trace?: unknown;
}

export interface WebChatApprovalGrantItem {
  id: string;
  mode: string;
  decision: string;
  operation: string;
  target_scope: string;
  target?: string;
  path_pattern?: string;
  channel?: string;
  risk: string;
  actor: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revocable: boolean;
  note?: string;
}

export interface WebChatApprovalHistoryItem {
  index: number;
  event: string;
  request_id: string | null;
  command_id: string | null;
  grant_id?: string;
  actor?: string;
  decision?: string | null;
  operation?: string | null;
  risk?: string | null;
  approval_level?: string | null;
  final_review_required?: boolean;
  reason?: string | null;
  timestamp: number;
  payload_digest: string;
  used_for_authority: false;
  operation_core?: OperationCoreApprovalTrace;
}

export interface WebChatEmergencyStopSnapshot {
  active: boolean;
  activated_at: number | null;
  activated_by: string | null;
  reason: string | null;
  cleared_at: number | null;
  cleared_by: string | null;
  clear_reason: string | null;
  execution_blocked: boolean;
  hds_brain_remains_authority: true;
  used_for_authority: false;
  evidence_source: readonly ("INTERNAL_STATE" | "LIVE_RUNTIME")[];
}

export interface WebChatApprovalControlContext {
  actor: string;
  token_kind: "resume";
  reason?: string;
}

export interface WebChatApprovalSurface {
  /** Return pending human approval work for the local console. */
  list: () => Promise<readonly WebChatApprovalQueueItem[]>;
  /** Return reusable approval grants, including non-revocable system grants. */
  grants?: () => Promise<readonly WebChatApprovalGrantItem[]>;
  /** Revoke a reusable human approval grant. */
  revokeGrant?: (
    grant_id: string,
    context: WebChatApprovalControlContext,
  ) => Promise<unknown>;
  /** Return sanitized approval history metadata. */
  history?: () => Promise<readonly WebChatApprovalHistoryItem[]>;
  /** Return owner emergency-stop state. */
  emergencyStop?: {
    getSnapshot: () => Promise<WebChatEmergencyStopSnapshot>;
    activate: (context: WebChatApprovalControlContext) => Promise<unknown>;
    clear: (context: WebChatApprovalControlContext) => Promise<unknown>;
  };
}

export interface WebChatAuditSurface {
  /** Return a read-only audit dump. The channel never accepts a filesystem path. */
  dump: (format: "json" | "text") => Promise<{
    content_type: string;
    body: string;
  }>;
}

export interface WebChatAuthorityTraceItem {
  index: number;
  entry_hash: string;
  kind:
    | "approval_gate"
    | "authority_event"
    | "command_lifecycle"
    | "executor_feedback"
    | "output_audit"
    | "runtime_invariants"
    | "schedule_lifecycle"
    | "memory_reference";
  event: string;
  request_id: string | null;
  command_id?: string;
  actor?: string;
  operation?: string;
  risk?: string;
  approval_level?: string;
  schedule_id?: string;
  payload_hash?: string;
  previous_payload_hash?: string;
  memory_id?: string;
  f_reference?: string;
  memory_entry_hash?: string;
  source?: string;
  used_for_authority?: false;
  matched_on?: string;
  summary?: unknown;
  reason?: string;
  decision?: string;
  status?: string;
  error?: string;
  known_command?: boolean;
  report_digest?: string;
  evidence_count?: number;
  source_process_kind?: string;
  source_channel?: string;
  authority_trace?: unknown;
  timestamp: number;
}

export interface WebChatAuthoritySurface {
  /** Return a read-only authority trace projected from the live audit chain. */
  trace: () => Promise<readonly WebChatAuthorityTraceItem[]>;
}

export type WebChatNotificationKind =
  | "approval_required"
  | "schedule_fired"
  | "schedule_failed"
  | "connector_failure"
  | "audit_warning";

export type WebChatNotificationSeverity =
  | "info"
  | "warning"
  | "critical"
  | "action_required";

export interface WebChatNotificationItem {
  id: string;
  kind: WebChatNotificationKind;
  severity: WebChatNotificationSeverity;
  title: string;
  message: string;
  timestamp: number;
  source: string;
  read_only: true;
  authority: "display_only";
  request_id?: string | null;
  command_id?: string;
  schedule_id?: string;
  approval_level?: string;
  risk?: string;
  payload_hash?: string;
  expires_at_ms?: number;
  next_action?: string;
}

export interface WebChatNotificationSurface {
  /** Return display-only resident notifications for the local console. */
  list: () => Promise<readonly WebChatNotificationItem[]>;
}

export interface WebChatHistoryReplayFilter {
  kind?: string;
  request_id?: string | null;
  command_id?: string | null;
  limit?: number;
}

export interface WebChatHistoryEntry {
  schema_version?: string;
  index: number;
  id: string;
  kind: string;
  request_id: string | null;
  command_id: string | null;
  actor?: string;
  source?: string;
  payload_digest: string;
  used_for_authority: false;
  timestamp: number;
  prev_hash?: string;
  entry_hash: string;
}

export interface WebChatHistorySnapshot {
  schema_version?: string;
  entries_count: number;
  skipped_count?: number;
  chain_valid: boolean;
  complete_history_used_for_authority: false;
  replay_filter?: WebChatHistoryReplayFilter;
  entries: readonly WebChatHistoryEntry[];
}

export interface WebChatHistorySurface {
  /** Return read-only complete-history replay metadata; raw payloads are never exposed. */
  replay: (filter: WebChatHistoryReplayFilter) => Promise<WebChatHistorySnapshot>;
}

export interface WebChatEvidenceControlContext {
  actor: string;
  token_kind: "inbound";
}

export interface WebChatEvidenceSurface {
  /** Export a sanitized diagnostic evidence pack; no request path is accepted. */
  exportPack: (context: WebChatEvidenceControlContext) => Promise<unknown>;
}

export interface WebChatAboutSurface {
  /** Return read-only product identity, claim-boundary, and release-boundary metadata. */
  getSnapshot: () => Promise<unknown>;
}

export interface WebChatUpdateSurface {
  /** Return manual update readiness, release sidecar status, and rollback metadata. */
  getSnapshot: () => Promise<unknown>;
  /** Verify the configured release bundle sidecars without applying an update. */
  verifyCandidate?: () => Promise<unknown>;
  /** Create a pre-update backup and rollback plan. */
  prepareUpdate?: (body: Record<string, unknown>) => Promise<unknown>;
}

export interface WebChatRecoverySurface {
  /** Return recovery readiness and backup inventory metadata. */
  getSnapshot: () => Promise<unknown>;
  /** Create a local recovery backup pack. */
  createBackup?: () => Promise<unknown>;
  /** Restore from a selected or latest local recovery backup pack. */
  restoreBackup?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Reset LLM provider configuration to offline stub mode. */
  resetProvider?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Reset connector credentials/allowlists to dry-run. */
  resetConnector?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Reset local runtime state while preserving audit and recovery backup roots. */
  factoryReset?: (body: Record<string, unknown>) => Promise<unknown>;
}

export interface WebChatOperatorSurfaces {
  writing?: WebChatOperatorSurface;
  daily?: WebChatOperatorSurface;
  developer?: WebChatOperatorSurface;
}

export interface WebChatOptions {
  /** HTTP/WS port. Required. */
  port: number;
  /**
   * Bearer token required on POST /inbound and POST /ws-ticket.
   * Must be ≥8 chars; throws on construction otherwise.
   */
  token: string;
  /** Separate Bearer token required on POST /resume. Must differ from token. */
  resume_token?: string;
  /**
   * Optional dedicated token for POST /webhook. When omitted, /webhook is
   * disabled; webhook-origin metadata is never allowed to carry authority.
   */
  webhook_token?: string;
  /** Bind host. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /**
   * Optional human-resume sink. If provided, POST /resume routes here.
   */
  onResume?: (
    request_id: string,
    verdict: "approve" | "reject" | "block",
    context: WebChatResumeContext,
  ) => Promise<unknown>;
  /**
   * TTL for /ws-ticket entries in milliseconds. Default 30_000 (30s).
   */
  ws_ticket_ttl_ms?: number;
  /**
   * Hard cap on the live ticket store. Default 10_000. Only consulted
   * when `ticket_store` is not supplied (default MemoryTicketStore).
   */
  ws_ticket_cap?: number;
  /**
   * Inject a custom TicketStore (Phase 4-3). When unset, an internal
   * MemoryTicketStore is created with `cap = ws_ticket_cap`.
   */
  ticket_store?: TicketStore;
  /**
   * One-time token store for human resume approvals. Default: in-memory,
   * enabled. Pass `false` only for legacy/custom deployments that supply an
   * equivalent gate outside WebChat.
   */
  resume_approval_tokens?: ResumeApprovalTokenStore | false;
  /**
   * TTL for request_id-bound resume approval tokens. Default 600_000 (10 min).
   */
  resume_approval_token_ttl_ms?: number;
  /**
   * Hard cap on the live approval-token store. Default 10_000. Only consulted
   * when `resume_approval_tokens` is not supplied.
   */
  resume_approval_token_cap?: number;
  /** Optional local settings window/API surface. */
  settings?: WebChatSettingsSurface;
  /** Optional local runtime/status API surface. Uses the normal inbound bearer token. */
  runtime?: WebChatRuntimeSurface;
  /** Optional local approval queue API surface. Uses the resume bearer token. */
  approval?: WebChatApprovalSurface;
  /** Optional local audit dump API surface. Uses the normal inbound bearer token. */
  audit?: WebChatAuditSurface;
  /** Optional local authority trace API surface. Uses the normal inbound bearer token. */
  authority?: WebChatAuthoritySurface;
  /** Optional display-only notification API surface. Uses the normal inbound bearer token. */
  notifications?: WebChatNotificationSurface;
  /** Optional read-only complete-history replay surface. Uses the normal inbound bearer token. */
  history?: WebChatHistorySurface;
  /** Optional diagnostic evidence export surface. Uses the normal inbound bearer token. */
  evidence?: WebChatEvidenceSurface;
  /** Optional read-only product About surface. Uses the normal inbound bearer token. */
  about?: WebChatAboutSurface;
  /** Optional manual update readiness surface. Uses the normal inbound bearer token. */
  update?: WebChatUpdateSurface;
  /** Optional recovery readiness surface. Uses the normal inbound bearer token. */
  recovery?: WebChatRecoverySurface;
  /** Optional first-party operator endpoints. Uses the normal inbound bearer token. */
  operators?: WebChatOperatorSurfaces;
  /**
   * Per-endpoint rate limit configuration. Pass `false` to disable
   * rate limiting entirely. Default: enabled with the per-endpoint
   * defaults documented on `WebChatRateLimits`.
   */
  rate_limits?: WebChatRateLimits | false;
  /**
   * Periodic TokenBucket prune interval in milliseconds. The prune sweep
   * drops bucket entries that are both idle and conceptually full (i.e.
   * carry no rate-limit memory). Set to 0 to disable. Default 60_000.
   *
   * Sets a guard against unbounded keyspace growth on long-running
   * gateways receiving traffic from many distinct (user, endpoint)
   * pairs. Without it, in-memory `state` map grows monotonically.
   */
  rate_limit_prune_interval_ms?: number;
  /**
   * Idle threshold (ms) for an entry to become prune-eligible. Default
   * 5 × the prune interval, so a key that sees traffic more than once
   * per prune sweep is never dropped. Has no effect when
   * `rate_limit_prune_interval_ms === 0`.
   */
  rate_limit_prune_idle_ms?: number;
  /** Clock injection for tests. */
  clock?: Clock;
}
