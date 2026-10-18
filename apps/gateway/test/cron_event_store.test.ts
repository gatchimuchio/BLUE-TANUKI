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

    expect(store.claim(first)).toEqual({ status: "accepted" });
    expect(store.claim(first)).toEqual({ status: "duplicate", delivery_state: "dispatching" });
    expect(store.claim(next)).toEqual({ status: "blocked_unresolved", delivery_state: "dispatching" });
    store.settle(first, "handler_returned");
    expect(store.claim(next)).toEqual({ status: "accepted" });
    store.settle(next, "outcome_unknown");
    store.close();

    const reopened = new GatewayCronEventStore(filepath);
    try {
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
    } finally {
      reopened.close();
    }
  });
});
