import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, HDSUpperController } from "@blue-tanuki/hds-brain";
import { EmergencyStopControl } from "../src/emergency_stop_control.js";
import { EmergencyStopStateStore } from "../src/emergency_stop_state_store.js";

interface TestAuditEvent {
  kind: "authority_event";
  event: "emergency_stop_activated" | "emergency_stop_cleared";
  control_event_id: string;
  actor: string;
  reason: string;
  occurred_at_ms: number;
  audit_gap_recovered?: boolean;
  timestamp: number;
}

const directories: string[] = [];
const stores = new Set<EmergencyStopStateStore>();

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
    const control = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 100 });
    control.activate({ actor: "owner" });
    expect(() => control.clear({ actor: "owner" })).toThrow("emergency_stop_audit_recovery_pending");
    expect(control.snapshot()).toMatchObject({ active: true, execution_blocked: true });

    audit.setFailed(false);
    const recovered = new EmergencyStopControl({ store, authority: audit.authority, abortRunningExecutions: vi.fn(), now: () => 200 });
    audit.setPersistent(false);
    expect(() => recovered.clear({ actor: "owner" })).toThrow("emergency_stop_clear_requires_persistent_audit");
    expect(recovered.snapshot()).toMatchObject({ active: true, execution_blocked: true });
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
    writeFileSync(auditDirectory, "blocks-audit-directory-creation");
    const firstAuthority = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }) });
    const first = new EmergencyStopControl({ store, authority: firstAuthority, abortRunningExecutions: vi.fn(), now: () => 300 });

    expect(first.activate({ actor: "owner" })).toMatchObject({ active: true, audit_recovery_status: "pending" });
    expect(firstAuthority.getAudit().verify()).toBe(false);
    firstAuthority.close();

    rmSync(auditDirectory);
    mkdirSync(auditDirectory);
    const recoveredAuthority = new HDSUpperController({ audit: new AuditLog({ filepath: auditPath }) });
    const recovered = new EmergencyStopControl({ store, authority: recoveredAuthority, abortRunningExecutions: vi.fn(), now: () => 400 });

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
