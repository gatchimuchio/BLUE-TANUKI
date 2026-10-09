import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "@blue-tanuki/protocol";
import type { DecisionLog } from "../src/types.js";
import {
  decodeMemoryEntry,
  encodeMemoryEntry,
  LongTermMemoryStore,
  shouldPersist,
  type MemoryEntry,
} from "../src/long-term-memory/index.js";

function makeLog(
  id: string,
  decision: Decision = "ASSERT",
  closure = { x: ["channel", "user"], r: ["request_response"], m: ["text"] },
): DecisionLog {
  return {
    request_id: id,
    frame: {
      actor: {
        actor_id: "u1",
        actor_kind: "user",
        channel: "test",
        trust_level: "limited",
      },
      process: {
        process_id: "chat.process",
        process_kind: "chat",
        version: "v1",
        trigger: { kind: "inbound", channel: "test" },
        actor_policy: { allowed_actor_kinds: ["owner", "user", "system", "cron", "webhook"], owner_required: false },
        memory_policy: {
          policy_id: "memory.chat.v1",
          enabled: true,
          max_hits: 5,
          allowed_sources: ["hds_ltm"],
          retrieval_modes: ["recent", "tag", "exact"],
        },
        approval_profile: { default_mode: "full_access", final_review_operations: [] },
        execution_policy: {
          allowed_command_types: ["llm_call", "tool_call", "noop"],
          allowed_tools: ["echo", "file.search", "http.fetch"],
          allowed_capabilities: [],
          timeout_ms: 30000,
        },
        capture_policy: { capture_on: ["assert", "approval", "feedback", "failure"], persist_to_ltm: true },
      },
      memory_trace: {
        policy_id: "memory.chat.v1",
        process_id: "chat.process",
        used_for_authority: false,
        hits: [],
      },
      goal: `goal-${id}`,
      protected_values: ["audit_traceability"],
      world_closure: closure,
      problem_definition_id: "default_v1",
    },
    model: {
      abstraction: `abs-${id}`,
      structure: {},
      scoring: { axis_scores: [], weights: {}, aggregate: 1 },
    },
    commit: {
      decision,
      reason: "test",
      hash: `hash-${id}-${decision}`,
      triggered_thresholds: [],
    },
    timestamp: 1000,
  };
}

describe("long-term memory guard", () => {
  it("persists ASSERT with non-empty x/r/m", () => {
    expect(shouldPersist(makeLog("assert"))).toBe(true);
  });

  it("skips SUSPEND", () => {
    expect(shouldPersist(makeLog("suspend", "SUSPEND"))).toBe(false);
  });

  it("skips OUT_OF_SCOPE", () => {
    expect(shouldPersist(makeLog("out", "OUT_OF_SCOPE"))).toBe(false);
  });

  it("skips FAIL", () => {
    expect(shouldPersist(makeLog("fail", "FAIL"))).toBe(false);
  });

  it("skips when x is empty", () => {
    expect(shouldPersist(makeLog("no-x", "ASSERT", { x: [], r: ["r"], m: ["m"] }))).toBe(false);
  });

  it("skips when r is empty", () => {
    expect(shouldPersist(makeLog("no-r", "ASSERT", { x: ["x"], r: [], m: ["m"] }))).toBe(false);
  });

  it("skips when m is empty", () => {
    expect(shouldPersist(makeLog("no-m", "ASSERT", { x: ["x"], r: ["r"], m: [] }))).toBe(false);
  });
});

describe("long-term memory codec", () => {
  it("round-trips an encoded MemoryEntry", () => {
    const store = new LongTermMemoryStore();
    const entry = store.capture(makeLog("r1"));
    expect(entry).not.toBeNull();

    const decoded = decodeMemoryEntry(encodeMemoryEntry(entry!));
    expect(decoded).toEqual(entry);
  });

  it("rejects malformed JSONL", () => {
    expect(() => decodeMemoryEntry("{not-json")).toThrow(/malformed JSONL/);
    expect(() => decodeMemoryEntry("{}")).toThrow(/malformed memory entry/);
  });
});

describe("LongTermMemoryStore in-memory", () => {
  it("captures valid logs and skips invalid logs", () => {
    const store = new LongTermMemoryStore();
    const valid = store.capture(makeLog("r1"));
    const invalid = store.capture(makeLog("r2", "SUSPEND"));

    expect(valid?.request_id).toBe("r1");
    expect(valid?.f_reference).toBe("F:r1");
    expect(valid?.actor).toMatchObject({ actor_id: "u1", actor_kind: "user", trust_level: "limited" });
    expect(valid?.process).toMatchObject({ process_id: "chat.process", process_kind: "chat" });
    expect(valid?.commit).toMatchObject({ decision: "ASSERT", hash: "hash-r1-ASSERT" });
    expect(valid?.tags).toContain("chat.process");
    expect(invalid).toBeNull();
    expect(store.size()).toBe(1);
  });

  it("returns recent entries newest first, capped to n", () => {
    const store = new LongTermMemoryStore();
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));
    store.capture(makeLog("r3"));

    expect(store.recent(2).map((entry) => entry.request_id)).toEqual(["r3", "r2"]);
  });

  it("returns all entries in insertion order", () => {
    const store = new LongTermMemoryStore();
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));

    expect(store.all().map((entry) => entry.request_id)).toEqual(["r1", "r2"]);
  });

  it("supports deterministic actor/process lookup", () => {
    const store = new LongTermMemoryStore();
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));

    expect(store.findByActor("u1").map((entry) => entry.request_id)).toEqual(["r2", "r1"]);
    expect(store.findByProcess("chat.process").map((entry) => entry.request_id)).toEqual(["r2", "r1"]);
  });

  it("verifies a fresh hash chain", () => {
    const store = new LongTermMemoryStore();
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));

    expect(store.verify()).toBe(true);
  });

  it("detects manual tampering", () => {
    const store = new LongTermMemoryStore();
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));

    const entries = store.all() as MemoryEntry[];
    entries[0]!.goal = "tampered";

    expect(store.verify()).toBe(false);
  });

  it("blocks new captures when max_entries is reached", () => {
    const store = new LongTermMemoryStore({ max_entries: 1 });
    expect(store.capture(makeLog("r1"))).not.toBeNull();
    expect(store.capture(makeLog("r2"))).toBeNull();
    expect(store.size()).toBe(1);
    expect(store.skippedCount()).toBe(1);
  });
});

describe("LongTermMemoryStore JSONL persistence", () => {
  let tmpDir: string;
  let filepath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ltm-test-"));
    filepath = join(tmpDir, "memory.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads existing entries and continues the chain", () => {
    const first = new LongTermMemoryStore({ filepath });
    first.capture(makeLog("r1"));
    first.capture(makeLog("r2"));

    const reloaded = new LongTermMemoryStore({ filepath });
    expect(reloaded.size()).toBe(2);
    expect(reloaded.verify()).toBe(true);

    const added = reloaded.capture(makeLog("r3"));
    expect(added?.prev_hash).toBe(reloaded.all()[1]!.entry_hash);

    const lines = readFileSync(filepath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(new LongTermMemoryStore({ filepath }).verify()).toBe(true);
  });

  it("reports a digest-only M version and detects an externally changed generation", () => {
    const store = new LongTermMemoryStore({ filepath });
    const emptyVersion = store.stateVersion();
    expect(emptyVersion).toMatchObject({ status: "verified", entry_count: 0 });
    expect(emptyVersion.revision_digest).toMatch(/^[a-f0-9]{64}$/u);

    store.capture(makeLog("memory-version-private-marker"));
    const populatedVersion = store.stateVersion();
    expect(populatedVersion.status).toBe("verified");
    expect(populatedVersion.entry_count).toBe(1);
    expect(populatedVersion.revision_digest).not.toBe(emptyVersion.revision_digest);
    expect(JSON.stringify(populatedVersion)).not.toContain("memory-version-private-marker");

    writeFileSync(filepath, `${readFileSync(filepath, "utf8")}not-a-memory-record\n`);
    const externallyChanged = store.stateVersion();
    expect(externallyChanged.status).toBe("invalid");
    expect(externallyChanged.revision_digest).not.toBe(populatedVersion.revision_digest);
  });

  it("throws on load when the persisted chain is broken", () => {
    const store = new LongTermMemoryStore({ filepath });
    store.capture(makeLog("r1"));
    store.capture(makeLog("r2"));

    const lines = readFileSync(filepath, "utf8").split("\n").filter(Boolean);
    const parsed0 = JSON.parse(lines[0]!);
    parsed0.goal = "tampered";
    writeFileSync(filepath, [JSON.stringify(parsed0), lines[1]].join("\n") + "\n");

    expect(() => new LongTermMemoryStore({ filepath })).toThrow(/chain verification failed/);
  });
});
