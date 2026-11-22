import { randomUUID } from "node:crypto";
import type { EmergencyStopDurableState, EmergencyStopStateStore } from "./emergency_stop_state_store.js";

export type EmergencyStopAuditRecoveryStatus = "not_required" | "recorded" | "pending" | "state_unavailable";

export interface EmergencyStopSnapshot {
  active: boolean;
  activated_at: number | null;
  activated_by: string | null;
  reason: string | null;
  cleared_at: number | null;
  cleared_by: string | null;
  clear_reason: string | null;
  audit_recovery_status: EmergencyStopAuditRecoveryStatus;
  execution_blocked: boolean;
  clear_blocked_by_active_work: boolean;
  clear_requires_new_execution_epoch: boolean;
  clear_state_conflict: boolean;
  hds_brain_remains_authority: true;
  used_for_authority: false;
  evidence_source: readonly ("INTERNAL_STATE" | "LIVE_RUNTIME")[];
}

interface AuthorityEventLike {
  readonly kind?: unknown;
  readonly event?: unknown;
  readonly control_event_id?: unknown;
  readonly actor?: unknown;
  readonly timestamp?: unknown;
  readonly occurred_at_ms?: unknown;
  readonly execution_epoch?: unknown;
}

interface EmergencyStopAuditEntry {
  readonly entry_hash: string;
  readonly log: unknown;
}

interface EmergencyStopAuthority {
  getAudit(): {
    isPersistent(): boolean;
    verify(): boolean;
    list(): readonly EmergencyStopAuditEntry[];
  };
  onAuthorityEvent(event: "emergency_stop_activated" | "emergency_stop_cleared", opts: {
    actor: string;
    reason: string;
    control_event_id: string;
    occurred_at_ms: number;
    execution_epoch?: string | null;
    audit_gap_recovered?: boolean;
  }): void;
}

export interface EmergencyStopCancellationContext {
  actor: string;
  requested_at_ms: number;
}

export class EmergencyStopControl {
  private durable: EmergencyStopDurableState;
  private reasonText: string | null = null;
  private clearReasonText: string | null = null;
  private stateStoreAvailable = true;

  constructor(private readonly options: {
    readonly store: EmergencyStopStateStore;
    readonly authority: EmergencyStopAuthority;
    readonly abortRunningExecutions: (context: EmergencyStopCancellationContext) => void;
    readonly hasUnsettledWork?: () => boolean;
    readonly currentExecutionEpoch?: () => string;
    readonly now?: () => number;
  }) {
    this.durable = options.store.load();
    this.restoreFromAudit();
    this.bindMissingActivationExecutionEpoch();
    if (this.durable.active && !this.durable.activation?.audit_recorded) {
      this.recordActivationIfPossible(true);
    }
  }

  snapshot(): EmergencyStopSnapshot {
    const active = this.durable.active;
    const clearBlockedByActiveWork = active && (this.options.hasUnsettledWork?.() ?? false);
    const currentEpoch = this.readCurrentExecutionEpoch();
    const clearRequiresNewExecutionEpoch = active && (!this.durable.activation?.execution_epoch ||
      !currentEpoch || this.durable.activation.execution_epoch === currentEpoch);
    const clearStateConflict = active &&
      this.hasClearStateConflict(() => this.options.authority.getAudit().list());
    return {
      active,
      activated_at: this.durable.activation?.occurred_at_ms ?? null,
      activated_by: this.durable.activation?.actor ?? null,
      reason: active
        ? clearStateConflict
          ? "Emergency stop remains latched, but the latest stop audit event does not match the durable active state."
          : this.reasonText ?? "Emergency stop restored from durable state."
        : null,
      cleared_at: this.durable.last_clear?.occurred_at_ms ?? null,
      cleared_by: this.durable.last_clear?.actor ?? null,
      clear_reason: this.clearReasonText,
      audit_recovery_status: !active ? "not_required"
        : !this.stateStoreAvailable ? "state_unavailable"
          : this.durable.activation?.audit_recorded ? "recorded" : "pending",
      execution_blocked: active,
      clear_blocked_by_active_work: clearBlockedByActiveWork,
      clear_requires_new_execution_epoch: clearRequiresNewExecutionEpoch,
      clear_state_conflict: clearStateConflict,
      hds_brain_remains_authority: true,
      used_for_authority: false,
      evidence_source: ["INTERNAL_STATE", "LIVE_RUNTIME"],
    };
  }

  get active(): boolean { return this.durable.active; }
  get reason(): string | null { return this.reasonText; }

  activate(context: { actor: string; reason?: string }): EmergencyStopSnapshot {
    this.reasonText = context.reason ?? "owner emergency stop";
    let activationToPersist: EmergencyStopDurableState["activation"] = null;
    if (!this.durable.active) {
      const activation = { control_event_id: randomUUID(), actor: context.actor,
        occurred_at_ms: this.now(), audit_recorded: false, execution_epoch: this.readCurrentExecutionEpoch() };
      this.durable = { schema_version: "blue-tanuki.emergency-stop-state.v2", active: true,
        activation, last_clear: this.durable.last_clear };
      activationToPersist = activation;
    }
    // Latch the deny state before asking workers to cancel. A cancellation callback
    // failure must never leave new execution admissible or undo the emergency stop.
    try {
      this.options.abortRunningExecutions({ actor: context.actor, requested_at_ms: this.now() });
    } catch {
      // Active execution observations remain authoritative for local worker state;
      // this cancellation request does not claim that local or external work stopped.
    }
    // Deliver the stop signal before synchronous persistence. A blocked or failed
    // state-store write must not delay cancellation of already running workers.
    if (activationToPersist) {
      try { this.durable = this.options.store.activate(activationToPersist); }
      catch { this.stateStoreAvailable = false; }
    }
    if (this.durable.activation && !this.durable.activation.audit_recorded) this.recordActivationIfPossible(false);
    return this.snapshot();
  }

  clear(context: { actor: string; reason?: string }): EmergencyStopSnapshot {
    if (!this.durable.active) return this.snapshot();
    if (!this.stateStoreAvailable) throw new Error("emergency_stop_state_store_unavailable");
    if (this.snapshot().clear_state_conflict) throw new Error("emergency_stop_clear_state_conflict");
    if (!this.durable.activation?.audit_recorded) {
      if (this.hasClearStateConflict(() => this.options.authority.getAudit().list())) {
        throw new Error("emergency_stop_clear_state_conflict");
      }
      if (!this.recordActivationIfPossible(true)) throw new Error("emergency_stop_audit_recovery_pending");
    }
    if (!this.stateStoreAvailable) throw new Error("emergency_stop_state_store_unavailable");
    const currentSnapshot = this.snapshot();
    if (currentSnapshot.clear_state_conflict) throw new Error("emergency_stop_clear_state_conflict");
    if (currentSnapshot.clear_requires_new_execution_epoch) {
      throw new Error("emergency_stop_clear_requires_new_execution_epoch");
    }
    if (this.options.hasUnsettledWork?.()) throw new Error("emergency_stop_clear_blocked_active_work");
    const audit = this.options.authority.getAudit();
    if (!audit.isPersistent() || !audit.verify()) throw new Error("emergency_stop_clear_requires_persistent_audit");
    if (this.hasClearStateConflict(() => audit.list())) {
      throw new Error("emergency_stop_clear_state_conflict");
    }

    const clear = { control_event_id: randomUUID(), actor: context.actor, occurred_at_ms: this.now() };
    this.options.authority.onAuthorityEvent("emergency_stop_cleared", {
      ...clear,
      reason: "owner emergency stop cleared",
    });
    this.durable = this.options.store.clear(clear);
    this.reasonText = null;
    this.clearReasonText = context.reason ?? "owner emergency stop cleared";
    return this.snapshot();
  }

  private hasClearStateConflict(list: () => readonly EmergencyStopAuditEntry[]): boolean {
    try {
      const activation = this.durable.activation;
      const persisted = this.options.store.load();
      if (!activation || !persisted.active || !persisted.activation ||
          persisted.activation.audit_recorded !== activation.audit_recorded ||
          persisted.activation.control_event_id !== activation.control_event_id ||
          persisted.activation.actor !== activation.actor ||
          persisted.activation.occurred_at_ms !== activation.occurred_at_ms ||
          persisted.activation.execution_epoch !== activation.execution_epoch) return true;
      const entries = list();
      const activationAudit = entries.find(({ log, entry_hash }) => isAuthorityEvent(log) && log.event === "emergency_stop_activated" &&
        auditControlEventId(log, entry_hash) === activation.control_event_id);
      if (activationAudit && isAuthorityEvent(activationAudit.log) && Object.hasOwn(activationAudit.log, "execution_epoch") &&
          activationAudit.log.execution_epoch !== activation.execution_epoch) return true;
      if (!activation.audit_recorded && !hasActivationAudit(entries, activation.control_event_id)) {
        return !mayRecoverMissingActivation(entries, activation.occurred_at_ms);
      }
      const latest = latestEmergencyStopAudit(entries);
      return !latest || latest.log.event !== "emergency_stop_activated" ||
        auditControlEventId(latest.log, latest.entry_hash) !== activation.control_event_id;
    } catch {
      return true;
    }
  }

  private restoreFromAudit(): void {
    const auditEntries = this.options.authority.getAudit().list();
    if (this.durable.active && this.durable.activation) {
      const exists = hasActivationAudit(auditEntries, this.durable.activation.control_event_id);
      if (exists && !this.durable.activation.audit_recorded) {
        try { this.durable = this.options.store.markActivationAudited(this.durable.activation.control_event_id); }
        catch { this.stateStoreAvailable = false; }
      }
      this.reasonText = "Emergency stop restored from durable state.";
      return;
    }
    const latest = latestEmergencyStopAudit(auditEntries);
    if (!latest || latest.log.event !== "emergency_stop_activated") return;
    const eventId = auditControlEventId(latest.log, latest.entry_hash);
    const activation = {
      control_event_id: eventId,
      actor: typeof latest.log.actor === "string" && latest.log.actor.trim() ? latest.log.actor : "system",
      occurred_at_ms: Number.isSafeInteger(latest.log.occurred_at_ms) && Number(latest.log.occurred_at_ms) > 0
        ? Number(latest.log.occurred_at_ms)
        : Number.isSafeInteger(latest.log.timestamp) && Number(latest.log.timestamp) > 0 ? Number(latest.log.timestamp) : this.now(),
      execution_epoch: isExecutionEpoch(latest.log.execution_epoch) ? latest.log.execution_epoch : null,
    };
    this.durable = { ...this.durable, active: true, activation: { ...activation, audit_recorded: true } };
    try {
      this.options.store.activate(activation);
      this.durable = this.options.store.markActivationAudited(eventId);
    } catch { this.stateStoreAvailable = false; }
    if (this.durable.active) this.reasonText = "Emergency stop restored from the HDS audit record.";
  }

  private recordActivationIfPossible(recovered: boolean): boolean {
    const activation = this.durable.activation;
    if (!this.durable.active || !activation) return false;
    const audit = this.options.authority.getAudit();
    const entries = audit.list();
    const existing = hasActivationAudit(entries, activation.control_event_id);
    if (existing) {
      try { this.durable = this.options.store.markActivationAudited(activation.control_event_id); }
      catch { this.durable = { ...this.durable, activation: { ...activation, audit_recorded: true } }; this.stateStoreAvailable = false; }
      return true;
    }
    if (!mayRecoverMissingActivation(entries, activation.occurred_at_ms) ||
        !audit.isPersistent() || !audit.verify()) return false;
    try {
      this.options.authority.onAuthorityEvent("emergency_stop_activated", {
        actor: activation.actor,
        reason: recovered ? "emergency stop activation recovered after audit persistence failure" : "owner emergency stop",
        control_event_id: activation.control_event_id,
        occurred_at_ms: activation.occurred_at_ms,
        execution_epoch: activation.execution_epoch,
        audit_gap_recovered: recovered,
      });
      const appended = hasActivationAudit(this.options.authority.getAudit().list(), activation.control_event_id);
      if (!appended) return false;
      try { this.durable = this.options.store.markActivationAudited(activation.control_event_id); }
      catch { this.durable = { ...this.durable, activation: { ...activation, audit_recorded: true } }; this.stateStoreAvailable = false; }
      return true;
    } catch { return false; }
  }

  private bindMissingActivationExecutionEpoch(): void {
    const activation = this.durable.activation;
    if (!this.durable.active || !activation || activation.execution_epoch) return;
    const epoch = this.readCurrentExecutionEpoch();
    if (!epoch) return;
    try {
      this.durable = this.options.store.bindActivationExecutionEpoch(activation.control_event_id, epoch);
    } catch {
      this.stateStoreAvailable = false;
    }
  }

  private readCurrentExecutionEpoch(): string | null {
    try {
      const epoch = this.options.currentExecutionEpoch?.();
      return isExecutionEpoch(epoch) ? epoch : null;
    } catch {
      return null;
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

function isAuthorityEvent(value: unknown): value is AuthorityEventLike {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "authority_event";
}

function auditControlEventId(log: AuthorityEventLike, entryHash: string): string {
  return typeof log.control_event_id === "string" && log.control_event_id.length > 0
    ? log.control_event_id : entryHash;
}

function isExecutionEpoch(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function hasActivationAudit(entries: readonly EmergencyStopAuditEntry[], activationId: string): boolean {
  return entries.some(({ log, entry_hash }) => isAuthorityEvent(log) && log.event === "emergency_stop_activated" &&
    auditControlEventId(log, entry_hash) === activationId);
}

function latestEmergencyStopAudit(entries: readonly EmergencyStopAuditEntry[]) {
  return entries.flatMap(({ log, entry_hash }) => isAuthorityEvent(log) &&
    (log.event === "emergency_stop_activated" || log.event === "emergency_stop_cleared")
    ? [{ log, entry_hash }] : []).at(-1);
}

function mayRecoverMissingActivation(entries: readonly EmergencyStopAuditEntry[], activationTime: number): boolean {
  const latest = latestEmergencyStopAudit(entries);
  if (!latest) return true;
  const time = latest.log.occurred_at_ms ?? latest.log.timestamp;
  return latest.log.event === "emergency_stop_cleared" && Number.isSafeInteger(time) &&
    Number(time) > 0 && Number(time) < activationTime;
}
