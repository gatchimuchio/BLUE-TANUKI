import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCronEventIdentity, GatewayCronEventStore } from "../src/cron_event_store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeEvent(source: string, sequence: number, payload: string) {
  return createCronEventIdentity(source, sequence, createHash("sha256").update(payload).digest("hex"));
}

function makeStore(): { root: string; filepath: string; store: GatewayCronEventStore } {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-cron-event-"));
  roots.push(root);
  const filepath = join(root, "private", "cron-events.sqlite");
  return { root, filepath, store: new GatewayCronEventStore(filepath) };
}

describe("GatewayCronEventStore", () => {
  it("persists a high-water cursor, rejects duplicates and reverse order, and blocks unresolved delivery", () => {
    const { filepath, store } = makeStore();
    const first = makeEvent("cron:runtime:synthetic", 1_000, "合成内容 A");
    const next = makeEvent("cron:runtime:synthetic", 2_000, "合成内容 B");

    expect(store.claim(first, 100)).toEqual({ status: "accepted" });
    expect(store.unresolvedEvents()).toEqual([{
      source_digest: createHash("sha256").update(first.source).digest("hex"),
      sequence: first.sequence,
      event_id: first.event_id,
      payload_digest: first.payload_digest,
      delivery_state: "dispatching",
      resolution_state: "unacknowledged",
      updated_at_ms: 100,
    }]);
    expect(store.claim(first)).toEqual({ status: "duplicate", delivery_state: "dispatching" });
    expect(store.claim(next)).toEqual({ status: "blocked_unresolved", delivery_state: "dispatching" });
    store.settle(first, "handler_returned", 200);
    expect(store.unresolvedEvents()).toEqual([]);
    expect(store.claim(next)).toEqual({ status: "accepted" });
    store.settle(next, "outcome_unknown", 400);
    store.close();

    const reopened = new GatewayCronEventStore(filepath);
    try {
      expect(reopened.unresolvedEvents()).toEqual([{
        source_digest: createHash("sha256").update(next.source).digest("hex"),
        sequence: next.sequence,
        event_id: next.event_id,
        payload_digest: next.payload_digest,
        delivery_state: "outcome_unknown",
        resolution_state: "unacknowledged",
        updated_at_ms: 400,
      }]);
      expect(reopened.claim(next)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      expect(reopened.claim(makeEvent("cron:runtime:synthetic", 3_000, "合成内容 C")))
        .toEqual({ status: "blocked_unresolved", delivery_state: "outcome_unknown" });
      expect(reopened.claim(first)).toEqual({ status: "stale" });
      expect(reopened.claim(makeEvent("cron:runtime:synthetic", 2_000, "衝突内容")))
        .toEqual({ status: "identity_conflict" });
    } finally {
      reopened.close();
    }
  });

  it("derives canonical identity from source and scheduled time, not payload", () => {
    const a = makeEvent(" cron:runtime:例 " , 123, "payload one");
    const b = makeEvent("cron:runtime:例", 123, "payload two");
    expect(a.source).toBe("cron:runtime:例");
    expect(a.event_id).toBe(b.event_id);
    expect(a.payload_digest).not.toBe(b.payload_digest);
  });

  it("advances only after an exact HDS no-replay disposition is verified", () => {
    const { filepath, store } = makeStore();
    const unresolved = makeEvent("cron:runtime:ack", 5_000, "synthetic action");
    const next = makeEvent("cron:runtime:ack", 6_000, "next synthetic action");
    let acknowledged = false;
    store.close();
    const verified = new GatewayCronEventStore(filepath, {
      verifyNoReplayDisposition: (event_id, payload_digest) =>
        acknowledged && event_id === unresolved.event_id && payload_digest === unresolved.payload_digest,
    });
    try {
      expect(verified.claim(unresolved, 500)).toEqual({ status: "accepted" });
      verified.settle(unresolved, "outcome_unknown", 600);
      expect(verified.claim(next)).toEqual({ status: "blocked_unresolved", delivery_state: "outcome_unknown" });
      expect(verified.unresolvedEvents()[0]?.resolution_state).toBe("unacknowledged");

      acknowledged = true;
      expect(verified.unresolvedEvents()[0]?.resolution_state).toBe("owner_acknowledged_no_replay");
      expect(verified.claim(next)).toEqual({ status: "accepted" });
      expect(verified.unresolvedEvents()).toEqual([expect.objectContaining({
        event_id: next.event_id,
        delivery_state: "dispatching",
        resolution_state: "unacknowledged",
      })]);
    } finally {
      verified.close();
    }
  });

  it("reports unavailable verification and keeps the next event blocked", () => {
    const { store, filepath } = makeStore();
    const unresolved = makeEvent("cron:runtime:verify", 7_000, "synthetic action");
    const next = makeEvent("cron:runtime:verify", 8_000, "next synthetic action");
    store.claim(unresolved);
    store.settle(unresolved, "outcome_unknown");
    store.close();
    const unavailable = new GatewayCronEventStore(filepath, {
      verifyNoReplayDisposition: () => { throw new Error("audit unavailable"); },
    });
    try {
      expect(unavailable.unresolvedEvents()[0]?.resolution_state).toBe("verification_unavailable");
      expect(unavailable.claim(next)).toEqual({ status: "blocked_unresolved", delivery_state: "outcome_unknown" });
    } finally {
      unavailable.close();
    }
  });

  it("keeps event payload out of the durable cursor and fails closed on inbox/outbox mismatch", () => {
    const { filepath, store } = makeStore();
    const event = makeEvent("cron:runtime:private", 4_000, "secret synthetic payload");
    expect(store.claim(event)).toEqual({ status: "accepted" });
    store.settle(event, "handler_returned");
    store.close();

    const db = new DatabaseSync(filepath);
    try {
      const rows = db.prepare("SELECT * FROM cron_event_inbox").all();
      expect(JSON.stringify(rows)).not.toContain("secret synthetic payload");
      db.exec("DELETE FROM cron_event_outbox");
    } finally {
      db.close();
    }

    const reopened = new GatewayCronEventStore(filepath);
    try {
      expect(() => reopened.claim(event)).toThrow(/cursor_integrity/);
      expect(() => reopened.unresolvedEvents()).toThrow(/cursor_integrity/);
    } finally {
      reopened.close();
    }
  });

  it("recovers pending approval as a non-resumable digest-only interruption", () => {
    const { filepath, store } = makeStore();
    const event = makeEvent("cron:runtime:approval", 9_000, "synthetic scheduled approval content");
    const commandId = "synthetic-command-private-id";
    const requestId = "synthetic-request-private-id";
    expect(store.claim(event, 100)).toEqual({ status: "accepted" });
    store.recordPendingApproval(event.event_id, event.payload_digest, commandId, requestId, 150);
    store.settle(event, "handler_returned", 200);
    expect(store.interruptedApprovalHandoffs()).toEqual([]);
    expect(store.hasCronApprovalReference(commandId)).toBe(true);
    store.close();

    const db = new DatabaseSync(filepath);
    try {
      const saved = JSON.stringify(db.prepare("SELECT * FROM cron_approval_handoff").all());
      expect(saved).not.toContain(commandId);
      expect(saved).not.toContain(requestId);
      expect(saved).not.toContain("synthetic scheduled approval content");
    } finally {
      db.close();
    }

    const reopened = new GatewayCronEventStore(filepath);
    try {
      expect(reopened.recoverPendingApprovalHandoffs(50)).toBe(1);
      expect(reopened.recoverPendingApprovalHandoffs(400)).toBe(0);
      expect(reopened.interruptedApprovalHandoffs()).toEqual([{
        source_digest: createHash("sha256").update(event.source).digest("hex"),
        sequence: event.sequence,
        event_id: event.event_id,
        payload_digest: event.payload_digest,
        command_id_digest: createHash("sha256").update(commandId).digest("hex"),
        state: "interrupted",
        updated_at_ms: 50,
      }]);
      expect(reopened.hasCronApprovalReference(commandId)).toBe(true);
      expect(reopened.hasCronApprovalReference(requestId)).toBe(true);
      const projection = JSON.stringify(reopened.interruptedApprovalHandoffs());
      expect(projection).not.toContain(commandId);
      expect(projection).not.toContain(requestId);
      expect(projection).not.toContain("synthetic scheduled approval content");
      expect(() => reopened.resolvePendingApproval(
        event.event_id,
        event.payload_digest,
        commandId,
        requestId,
        "consumed",
        500,
      )).toThrow(/already resolved differently/);
    } finally {
      reopened.close();
    }
  });

  it("keeps a resolved Cron approval reference as a stale-resume tombstone", () => {
    const { store } = makeStore();
    const event = makeEvent("cron:runtime:approval-resolved", 10_000, "synthetic approved task");
    store.claim(event, 100);
    store.recordPendingApproval(event.event_id, event.payload_digest, "command-old", "request-old", 150);
    store.resolvePendingApproval(event.event_id, event.payload_digest, "command-old", "request-old", "consumed", 200);
    expect(store.hasCronApprovalReference("command-old")).toBe(true);
    expect(store.hasCronApprovalReference("request-old")).toBe(true);
    expect(store.interruptedApprovalHandoffs()).toEqual([]);
    store.close();
  });
});
