import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, HDSUpperController } from "@blue-tanuki/hds-brain";
import { EmergencyStopControl } from "../src/emergency_stop_control.js";
import { EmergencyStopStateStore } from "../src/emergency_stop_state_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

interface TestAuditEvent {
  kind: "authority_event";
  event: "emergency_stop_activated" | "emergency_stop_cleared";
  control_event_id: string;
  actor: string;
  reason: string;
  occurred_at_ms: number;
  execution_epoch?: string | null;
  audit_gap_recovered?: boolean;
  timestamp: number;
}

const directories: string[] = [];
const stores = new Set<EmergencyStopStateStore>();
const firstExecutionEpoch = "00000000-0000-4000-8000-000000000001";
const nextExecutionEpoch = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeStore(): { readonly store: EmergencyStopStateStore; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "blue-tanuki-emergency-stop-"));
  directories.push(directory);
  const path = join(directory, "emergency-stop.sqlite");
  return { store: openStore(path), path };
}

function openStore(path: string): EmergencyStopStateStore {
  const store = new EmergencyStopStateStore(path);
  stores.add(store);
  return store;
}

function makeAuthority(initial: TestAuditEvent[] = [], failAppend = false) {
  const entries = initial.map((log) => ({ entry_hash: hash(log), log }));
  let failed = failAppend;
  let persistent = true;
  const audit = {
    isPersistent: () => persistent,
    verify: () => !failed,
    list: () => entries,
  };
  const authority = {
    getAudit: () => audit,
    onAuthorityEvent: vi.fn((event: TestAuditEvent["event"], opts: Omit<TestAuditEvent, "kind" | "event" | "timestamp">) => {
      if (failed) throw new Error("audit persistence failed");
      const log: TestAuditEvent = { kind: "authority_event", event, ...opts, timestamp: Date.now() };
      entries.push({ entry_hash: hash(log), log });
    }),
  };
  return { authority, entries, setFailed: (value: boolean) => { failed = value; }, setPersistent: (value: boolean) => { persistent = value; } };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("EmergencyStopControl", () => {
  it("migrates a legacy active stop to a restart-bound execution epoch", () => {
    const { store: initialStore, path } = makeStore();
    initialStore.close();
    stores.delete(initialStore);
    const legacyState = {
      schema_version: "blue-tanuki.emergency-stop-state.v1",
      active: true,
      activation: {
        control_event_id: "legacy-activation", actor: "owner", occurred_at_ms: 100, audit_recorded: true,
      },
      last_clear: null,
    };
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO emergency_stop_state(id, state_json, digest) VALUES(1, ?, ?)")
      .run(JSON.stringify(legacyState), hash(legacyState));
    db.close();

    const store = openStore(path);
    const audit = makeAuthority([{
      kind: "authority_event", event: "emergency_stop_activated", control_event_id: "legacy-activation",
      actor: "owner", reason: "legacy stop", occurred_at_ms: 100, timestamp: 100,
    }]);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => firstExecutionEpoch });

    expect(store.load()).toMatchObject({ schema_version: "blue-tanuki.emergency-stop-state.v2",
      active: true, activation: { execution_epoch: firstExecutionEpoch } });
    expect(control.snapshot()).toMatchObject({ active: true, clear_requires_new_execution_epoch: true });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_requires_new_execution_epoch");
  });

  it("refuses clear when the HDS activation epoch conflicts with the durable stop", () => {
    const { store } = makeStore();
    store.activate({ control_event_id: "epoch-conflict", actor: "owner", occurred_at_ms: 100,
      execution_epoch: firstExecutionEpoch });
    store.markActivationAudited("epoch-conflict");
    const audit = makeAuthority([{
      kind: "authority_event", event: "emergency_stop_activated", control_event_id: "epoch-conflict",
      actor: "owner", reason: "fixture", occurred_at_ms: 100, execution_epoch: nextExecutionEpoch, timestamp: 100,
    }]);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => nextExecutionEpoch });

    expect(control.snapshot()).toMatchObject({ active: true, clear_state_conflict: true });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_state_conflict");
    expect(store.load()).toMatchObject({ active: true, activation: { execution_epoch: firstExecutionEpoch } });
  });

  it("keeps the stop observed in the audit active if restoring durable state fails", () => {
    const { store } = makeStore();
    const { authority, entries } = makeAuthority([{
      kind: "authority_event", event: "emergency_stop_activated",
      control_event_id: "12345678-1234-4123-8123-123456789abc", actor: "owner",
      reason: "fixture stop", occurred_at_ms: 100, timestamp: 100,
    }]);
    vi.spyOn(store, "activate").mockImplementation(() => { throw new Error("fixture store unavailable"); });
    const control = new EmergencyStopControl({ store, authority, abortRunningExecutions: vi.fn() });
    expect(control.snapshot()).toMatchObject({
      active: true, execution_blocked: true, audit_recovery_status: "state_unavailable",
    });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_state_store_unavailable");
    expect(entries).toHaveLength(1);
  });

  it("keeps execution blocked on audit failure and records the missing activation after restart", () => {
    const { store: initialStore, path } = makeStore();
    const firstAuthority = makeAuthority([], true);
    const abort = vi.fn();
    const first = new EmergencyStopControl({ store: initialStore, authority: firstAuthority.authority, abortRunningExecutions: abort, now: () => 100 });

    expect(first.activate({ actor: "owner", reason: "synthetic stop" })).toMatchObject({
      active: true, execution_blocked: true, audit_recovery_status: "pending",
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(initialStore.load()).toMatchObject({ active: true, activation: { audit_recorded: false } });
    initialStore.close();
    stores.delete(initialStore);

    firstAuthority.setFailed(false); // A restarted AuditLog can append again.
    const store = openStore(path);
    const recovered = new EmergencyStopControl({ store, authority: firstAuthority.authority, abortRunningExecutions: vi.fn(), now: () => 200 });
    expect(recovered.snapshot()).toMatchObject({ active: true, audit_recovery_status: "recorded" });
    expect(firstAuthority.entries).toHaveLength(1);
    expect(firstAuthority.entries[0]!.log).toMatchObject({
      event: "emergency_stop_activated", audit_gap_recovered: true, occurred_at_ms: 100,
    });
    expect(store.load()).toMatchObject({ active: true, activation: { audit_recorded: true } });
  });

  it("does not clear the stop while the activation gap or persistent audit is unavailable", () => {
    const { store } = makeStore();
    const audit = makeAuthority([], true);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => firstExecutionEpoch, now: () => 100 });
    control.activate({ actor: "owner" });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_audit_recovery_pending");
    expect(control.snapshot()).toMatchObject({ active: true, execution_blocked: true });

    audit.setFailed(false);
    const recovered = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => nextExecutionEpoch, now: () => 200 });
    audit.setPersistent(false);
    expect(() => recovered.clear({ actor: "owner" })).toThrow("emergency_stop_clear_requires_persistent_audit");
    expect(recovered.snapshot()).toMatchObject({ active: true, execution_blocked: true });
  });

  it("revalidates a repaired activation and refuses clear when its durable audit marker cannot be saved", () => {
    const { store } = makeStore();
    const audit = makeAuthority([], true);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => firstExecutionEpoch, now: () => 100 });
    expect(control.activate({ actor: "owner" })).toMatchObject({
      active: true, audit_recovery_status: "pending", clear_state_conflict: false,
    });
    audit.setFailed(false);
    vi.spyOn(store, "markActivationAudited").mockImplementationOnce(() => {
      throw new Error("fixture unavailable");
    });

    const recovered = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => nextExecutionEpoch, now: () => 200 });
    expect(() => recovered.clear({ actor: "owner" })).toThrow("emergency_stop_state_store_unavailable");
    expect(recovered.snapshot()).toMatchObject({ active: true, execution_blocked: true, audit_recovery_status: "state_unavailable" });
    expect(store.load()).toMatchObject({ active: true, activation: { audit_recorded: false } });
    expect(audit.entries.map((entry) => entry.log.event)).toEqual(["emergency_stop_activated"]);
  });

  it("requires a new execution epoch before clearing after a missing activation is repaired", () => {
    const { store } = makeStore();
    const audit = makeAuthority([{
      kind: "authority_event", event: "emergency_stop_cleared", control_event_id: "prior-clear",
      actor: "owner", reason: "prior stop cleared", occurred_at_ms: 90, timestamp: 90,
    }], true);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => firstExecutionEpoch, now: () => 100 });
    expect(control.activate({ actor: "owner" })).toMatchObject({ clear_state_conflict: false, audit_recovery_status: "pending" });
    audit.setFailed(false);

    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_requires_new_execution_epoch");
    const restarted = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => nextExecutionEpoch, now: () => 200 });
    expect(restarted.clear({ actor: "owner", reason: "cause repaired and pending actions reconciled" }))
      .toMatchObject({ active: false, clear_state_conflict: false });
    expect(store.load().active).toBe(false);
    expect(audit.entries.map((entry) => entry.log.event)).toEqual([
      "emergency_stop_cleared", "emergency_stop_activated", "emergency_stop_cleared",
    ]);
  });

  it.each([true, false])("preserves a conflicting latched activation after restart (recorded=%s)", (recorded) => {
    const { store } = makeStore();
    store.activate({ control_event_id: "latched-activation", actor: "owner", occurred_at_ms: 100, execution_epoch: null });
    if (recorded) store.markActivationAudited("latched-activation");
    const original = store.load();
    const audit = makeAuthority([{
      kind: "authority_event", event: "emergency_stop_cleared", control_event_id: "different-later-clear",
      actor: "owner", reason: "fixture", occurred_at_ms: 110, timestamp: 110,
    }]);

    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 120 });
    expect(control.snapshot()).toMatchObject({
      active: true, execution_blocked: true, clear_state_conflict: true,
      audit_recovery_status: recorded ? "recorded" : "pending",
    });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_state_conflict");
    expect(store.load()).toEqual(original);
    expect(audit.authority.onAuthorityEvent).not.toHaveBeenCalled();
  });

  it("does not reconstruct a missing audit record for an activation already marked audited", () => {
    const { store } = makeStore();
    store.activate({ control_event_id: "missing-activation", actor: "owner", occurred_at_ms: 100, execution_epoch: null });
    const original = store.markActivationAudited("missing-activation");
    const audit = makeAuthority();

    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 120 });
    expect(control.snapshot()).toMatchObject({
      execution_blocked: true, clear_state_conflict: true, audit_recovery_status: "recorded",
    });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_state_conflict");
    expect(store.load()).toEqual(original);
    expect(audit.entries).toEqual([]);
  });

  it.each(["emergency_stop_cleared", "emergency_stop_activated"] as const)(
    "keeps the durable stop active when the last recorded control event is an unrelated %s",
    (event) => {
      const { store } = makeStore();
      const audit = makeAuthority();
      const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 100 });
      control.activate({ actor: "owner" });
      const original = store.load();
      audit.authority.onAuthorityEvent(event, {
        control_event_id: "other-event", actor: "owner", reason: "fixture", occurred_at_ms: 101,
      });

      expect(control.snapshot()).toMatchObject({ active: true, execution_blocked: true, clear_state_conflict: true });
      expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_state_conflict");
      expect(store.load()).toEqual(original);
      expect(audit.authority.onAuthorityEvent).toHaveBeenCalledTimes(2);
    },
  );

  it("refuses to clear a different recorded activation now present in the durable store", () => {
    const { store } = makeStore();
    const audit = makeAuthority();
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 100 });
    control.activate({ actor: "owner" });
    store.clear({ control_event_id: "fixture-clear", actor: "owner", occurred_at_ms: 101 });
    store.activate({ control_event_id: "fixture-other-activation", actor: "owner", occurred_at_ms: 102, execution_epoch: null });
    const actual = store.markActivationAudited("fixture-other-activation");

    expect(control.snapshot()).toMatchObject({ active: true, execution_blocked: true, clear_state_conflict: true });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_clear_state_conflict");
    expect(store.load()).toEqual(actual);
    expect(audit.authority.onAuthorityEvent).toHaveBeenCalledTimes(1);
  });

  it("restores an activation from the canonical HDS audit after the latch write was interrupted", () => {
    const { store } = makeStore();
    const event: TestAuditEvent = { kind: "authority_event", event: "emergency_stop_activated",
      control_event_id: "existing-activation", actor: "owner", reason: "owner emergency stop",
      occurred_at_ms: 100, timestamp: 100 };
    const audit = makeAuthority([event]);
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 200 });
    expect(control.snapshot()).toMatchObject({ active: true, audit_recovery_status: "recorded" });
    expect(store.load()).toMatchObject({ active: true, activation: { control_event_id: "existing-activation", audit_recorded: true } });
  });

  it("recovers a failed persistent HDS audit append after restart", () => {
    const { store, path } = makeStore();
    const auditDirectory = `${path}.audit`;
    const auditPath = join(auditDirectory, "events.jsonl");
    const firstAuthority = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }) });
    const first = new EmergencyStopControl({ store, authority: firstAuthority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => firstExecutionEpoch, now: () => 300 });

    writeFileSync(auditPath, "fixture appears after audit target identity was observed");
    expect(first.activate({ actor: "owner" })).toMatchObject({ active: true, audit_recovery_status: "pending" });
    expect(firstAuthority.getAudit().verify()).toBe(false);
    firstAuthority.close();

    rmSync(auditPath);
    const recoveredAuthority = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }) });
    const recovered = new EmergencyStopControl({ store, authority: recoveredAuthority, abortRunningExecutions: vi.fn(),
      currentExecutionEpoch: () => nextExecutionEpoch, now: () => 400 });

    expect(recovered.snapshot()).toMatchObject({ active: true, audit_recovery_status: "recorded" });
    expect(recoveredAuthority.getAudit().list().at(-1)?.log).toMatchObject({
      kind: "authority_event", event: "emergency_stop_activated", occurred_at_ms: 300, audit_gap_recovered: true,
    });
    expect(recoveredAuthority.getAudit().verify()).toBe(true);
    expect(recovered.clear({ actor: "owner" })).toMatchObject({ active: false, audit_recovery_status: "not_required" });
    expect(recoveredAuthority.getAudit().list().at(-1)?.log).toMatchObject({
      kind: "authority_event", event: "emergency_stop_cleared",
    });
    recoveredAuthority.close();
  });
});
