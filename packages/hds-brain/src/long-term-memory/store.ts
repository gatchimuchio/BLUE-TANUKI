import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionLog } from "../types.js";
import {
  canonicalizeMemoryEntry,
  decodeMemoryEntry,
  encodeMemoryEntry,
  type MemoryEntryHashInput,
} from "./codec.js";
import { shouldPersist } from "./guard.js";
import type { MemoryEntry, MemoryStoreOptions } from "./types.js";
import { fReferenceForId } from "../f_reference.js";

const DEFAULT_MAX_ENTRIES = 10_000;

export class LongTermMemoryStore {
  private readonly filepath?: string;
  private readonly max_entries: number;
  private entries: MemoryEntry[] = [];
  private skipped_captures = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.filepath = opts.filepath;
    this.max_entries = opts.max_entries ?? DEFAULT_MAX_ENTRIES;

    if (this.filepath && existsSync(this.filepath)) {
      this.loadFromFile();
    } else if (this.filepath) {
      const dir = dirname(this.filepath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Conditional write. Skips non-ASSERT / non-TCP-closed logs and never
   * propagates persistence write failures into the controller path.
   */
  capture(log: DecisionLog): MemoryEntry | null {
    if (!shouldPersist(log)) {
      return null;
    }
    if (this.max_entries > 0 && this.entries.length >= this.max_entries) {
      this.skipped_captures += 1;
      return null;
    }

    const entry = this.createEntry(log);
    if (this.filepath) {
      try {
        appendFileSync(this.filepath, encodeMemoryEntry(entry) + "\n");
      } catch {
        this.skipped_captures += 1;
        return null;
      }
    }
    this.entries.push(entry);
    return entry;
  }

  /** Read most recent N entries, newest first. */
  recent(n: number): readonly MemoryEntry[] {
    if (n <= 0) return [];
    return this.entries.slice(Math.max(0, this.entries.length - n)).reverse();
  }

  /** Read all entries in insertion order. */
  all(): readonly MemoryEntry[] {
    return this.entries;
  }

  /** Deterministic tag lookup over stored structural fields. Newest first. */
  findByTag(tag: string, limit = 20): readonly MemoryEntry[] {
    const needle = tag.trim().toLowerCase();
    if (!needle || limit <= 0) return [];
    return this.entries
      .filter((entry) => entryContains(entry, needle))
      .slice(-limit)
      .reverse();
  }

  /** Deterministic actor lookup. Newest first. */
  findByActor(actor_id: string, limit = 20): readonly MemoryEntry[] {
    const needle = actor_id.trim();
    if (!needle || limit <= 0) return [];
    return this.entries
      .filter((entry) => entry.actor?.actor_id === needle)
      .slice(-limit)
      .reverse();
  }

  /** Deterministic process lookup. Newest first. */
  findByProcess(process_id: string, limit = 20): readonly MemoryEntry[] {
    const needle = process_id.trim();
    if (!needle || limit <= 0) return [];
    return this.entries
      .filter((entry) => entry.process?.process_id === needle)
      .slice(-limit)
      .reverse();
  }

  /** Deterministic request id lookup. */
  findByRequestId(request_id: string): MemoryEntry | null {
    return this.entries.find((entry) => entry.request_id === request_id) ?? null;
  }

  size(): number {
    return this.entries.length;
  }

  skippedCount(): number {
    return this.skipped_captures;
  }

  verify(): boolean {
    return verifyMemoryEntrySequence(this.entries);
  }

  /**
   * Return only a digest and count for binding a transient J checkpoint to an
   * M generation. This does not expose memory entries to the caller.
   */
  stateVersion(): import("./types.js").MemoryStoreStateVersion {
    if (!this.filepath) {
      const valid = this.verify();
      const lastHash = this.entries.at(-1)?.entry_hash ?? "GENESIS";
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: valid ? "verified" : "invalid",
        revision_digest: createHash("sha256")
          .update(`${this.entries.length}|${lastHash}`)
          .digest("hex"),
        entry_count: this.entries.length,
      };
    }

    let raw = "";
    try {
      raw = existsSync(this.filepath) ? readFileSync(this.filepath, "utf8") : "";
      const diskEntries = raw.split("\n").filter((line) => line.trim().length > 0).map(decodeMemoryEntry);
      const diskValid = verifyMemoryEntrySequence(diskEntries);
      const sameLoadedState = diskEntries.length === this.entries.length && diskEntries.every(
        (entry, index) => entry.entry_hash === this.entries[index]?.entry_hash,
      );
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: diskValid && sameLoadedState ? "verified" : "invalid",
        revision_digest: createHash("sha256").update(raw, "utf8").digest("hex"),
        entry_count: diskEntries.length,
      };
    } catch {
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: "invalid",
        revision_digest: createHash("sha256").update(raw, "utf8").digest("hex"),
        entry_count: null,
      };
    }
  }

  private createEntry(log: DecisionLog): MemoryEntry {
    const index = this.entries.length;
    const prev_hash =
      this.entries.length === 0
        ? "GENESIS"
        : this.entries[this.entries.length - 1]!.entry_hash;
    const hashInput: MemoryEntryHashInput = {
      index,
      request_id: log.request_id,
      f_reference: fReferenceForId(log.request_id),
      timestamp: log.timestamp,
      closure: {
        x: [...log.frame.world_closure.x],
        r: [...log.frame.world_closure.r],
        m: [...log.frame.world_closure.m],
      },
      goal: log.frame.goal,
      problem_definition_id: log.frame.problem_definition_id,
      abstraction: log.model.abstraction,
      actor: {
        actor_id: log.frame.actor.actor_id,
        actor_kind: log.frame.actor.actor_kind,
        channel: log.frame.actor.channel,
        trust_level: log.frame.actor.trust_level,
      },
      process: {
        process_id: log.frame.process.process_id,
        process_kind: log.frame.process.process_kind,
        version: log.frame.process.version,
      },
      commit: {
        decision: log.commit.decision,
        hash: log.commit.hash,
        reason: log.commit.reason,
      },
      tags: memoryTags(log),
      prev_hash,
    };

    return {
      ...hashInput,
      entry_hash: this.computeHash(hashInput),
    };
  }

  private computeHash(entry: MemoryEntryHashInput): string {
    return createHash("sha256")
      .update(`${entry.index}|${entry.prev_hash}|${canonicalizeMemoryEntry(entry)}`)
      .digest("hex");
  }

  private loadFromFile(): void {
    if (!this.filepath) return;
    const raw = readFileSync(this.filepath, "utf8");
    const lines = raw.split("\n").filter((line: string) => line.trim().length > 0);
    this.entries = lines.map((line: string) => decodeMemoryEntry(line));
    if (!this.verify()) {
      throw new Error(
        `LongTermMemoryStore: chain verification failed on load from ${this.filepath}`,
      );
    }
  }
}

function verifyMemoryEntrySequence(entries: readonly MemoryEntry[]): boolean {
  let previousHash = "GENESIS";
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const canonical = canonicalizeMemoryEntry({
      index: entry.index,
      request_id: entry.request_id,
      f_reference: entry.f_reference,
      timestamp: entry.timestamp,
      closure: entry.closure,
      goal: entry.goal,
      problem_definition_id: entry.problem_definition_id,
      abstraction: entry.abstraction,
      actor: entry.actor,
      process: entry.process,
      commit: entry.commit,
      tags: entry.tags,
      prev_hash: previousHash,
    });
    const expectedHash = createHash("sha256")
      .update(`${entry.index}|${previousHash}|${canonical}`)
      .digest("hex");
    if (entry.index !== index || entry.prev_hash !== previousHash || entry.entry_hash !== expectedHash) {
      return false;
    }
    previousHash = entry.entry_hash;
  }
  return true;
}


function entryContains(entry: MemoryEntry, needle: string): boolean {
  const hay = [
    entry.request_id,
    entry.f_reference ?? "",
    entry.goal,
    entry.problem_definition_id,
    entry.abstraction,
    entry.actor?.actor_id ?? "",
    entry.actor?.actor_kind ?? "",
    entry.actor?.trust_level ?? "",
    entry.process?.process_id ?? "",
    entry.process?.process_kind ?? "",
    entry.commit?.decision ?? "",
    ...(entry.tags ?? []),
    ...entry.closure.x,
    ...entry.closure.r,
    ...entry.closure.m,
  ].join("\n").toLowerCase();
  return hay.includes(needle);
}


function memoryTags(log: DecisionLog): string[] {
  const tags = new Set<string>();
  tags.add(log.frame.actor.channel.toLowerCase());
  tags.add(log.frame.actor.actor_kind);
  tags.add(log.frame.actor.trust_level);
  tags.add(log.frame.process.process_id);
  tags.add(log.frame.process.process_kind);
  tags.add(log.frame.problem_definition_id);
  for (const value of log.frame.world_closure.x) tags.add(value.toLowerCase());
  return Array.from(tags).filter((tag) => tag.length > 0).sort();
}
