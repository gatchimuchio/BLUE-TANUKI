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
import type { MemoryEntry, MemoryStoreOptions, PersonalizationExclusionEvent, PersonalizationExclusionState,
  PersonalizationTargetSnapshot } from "./types.js";
import { fReferenceForId } from "../f_reference.js";

const DEFAULT_MAX_ENTRIES = 10_000;

/** Digest-only view of exact M records, freshly read from the current store. */
export interface CurrentMemoryReferenceVersionSnapshot {
  readonly status: "verified" | "unverified";
  readonly records: readonly { readonly request_id: string; readonly version: string | null }[];
}

export class LongTermMemoryStore {
  private readonly filepath?: string;
  private readonly max_entries: number;
  private entries: MemoryEntry[] = [];
  private personalizationExclusions: PersonalizationExclusionEvent[] = [];
  private readonly excludedPersonalizationTargets = new Set<string>();
  private personalizationLedgerValid = true;
  private skipped_captures = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.filepath = opts.filepath;
    this.max_entries = opts.max_entries ?? DEFAULT_MAX_ENTRIES;

    if (this.filepath && !existsSync(dirname(this.filepath))) {
      mkdirSync(dirname(this.filepath), { recursive: true });
    }
    this.loadPersonalizationExclusions();
    if (this.filepath && existsSync(this.filepath)) {
      this.loadFromFile();
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

  /** Verified, digest-only state for binding a current memory search to the active preference ledger. */
  personalizationExclusionState(): PersonalizationExclusionState {
    let raw = "";
    try {
      raw = this.readPersonalizationRaw();
      const diskEvents = decodePersonalizationEvents(raw);
      const valid = this.personalizationLedgerValid && verifyPersonalizationExclusionSequence(diskEvents) &&
        samePersonalizationEvents(diskEvents, this.personalizationExclusions) &&
        this.personalizationTargetsExist(diskEvents, this.entries);
      return {
        status: valid ? "verified" : "invalid",
        revision_digest: createHash("sha256").update(raw, "utf8").digest("hex"),
        event_count: valid ? diskEvents.length : null,
      };
    } catch {
      return { status: "invalid", revision_digest: createHash("sha256").update(raw, "utf8").digest("hex"), event_count: null };
    }
  }

  /** Resolve one exact historical M record for a reviewed personalization-stop request. */
  inspectPersonalizationTarget(request_id: string, entry_hash: string): PersonalizationTargetSnapshot {
    const state = this.personalizationExclusionState();
    if (state.status !== "verified" || !/^[A-Za-z0-9_.:-]{1,96}$/.test(request_id) || !/^[a-f0-9]{64}$/.test(entry_hash)) {
      return { status: "unavailable", entry_hash: null, exclusion_revision_digest: state.revision_digest };
    }
    let currentEntries: readonly MemoryEntry[];
    try {
      const raw = this.filepath && existsSync(this.filepath) ? readFileSync(this.filepath, "utf8") : undefined;
      currentEntries = raw === undefined ? this.entries : raw.split("\n").filter((line) => line.trim().length > 0).map(decodeMemoryEntry);
    } catch {
      return { status: "unavailable", entry_hash: null, exclusion_revision_digest: state.revision_digest };
    }
    if (!verifyMemoryEntrySequence(currentEntries) || !this.personalizationTargetsExist(this.personalizationExclusions, currentEntries)) {
      return { status: "unavailable", entry_hash: null, exclusion_revision_digest: state.revision_digest };
    }
    const confirmedState = this.personalizationExclusionState();
    if (confirmedState.status !== "verified" || confirmedState.revision_digest !== state.revision_digest) {
      return { status: "unavailable", entry_hash: null, exclusion_revision_digest: confirmedState.revision_digest };
    }
    const matching = currentEntries.filter((entry) => entry.request_id === request_id && entry.entry_hash === entry_hash);
    if (matching.length !== 1) {
      return { status: "unavailable", entry_hash: null, exclusion_revision_digest: state.revision_digest };
    }
    const excluded = this.personalizationExclusions.some((event) =>
      event.request_id === request_id && event.entry_hash === entry_hash);
    return { status: excluded ? "already_excluded" : "available", entry_hash, exclusion_revision_digest: state.revision_digest };
  }

  /**
   * Append a digest-only stop-use preference. The exact entry stays in M; this
   * method changes future citation and personalization projections and must be called
   * through the Gateway's HDS-selected, L3-reviewed built-in operation.
   */
  stopPersonalizationUse(input: {
    request_id: string;
    expected_entry_hash: string;
    expected_exclusion_revision_digest: string;
    command_digest: string;
    operation_plan_binding_digest: string;
    timestamp_ms: number;
  }): { status: "excluded" | "already_excluded"; entry_hash: string; exclusion_digest: string;
      exclusion_revision_digest: string; historical_record_retained: true; physical_deletion: false;
      used_for_authority: false; may_execute: false } {
    const hexDigest = /^[a-f0-9]{64}$/;
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(input.request_id) || !hexDigest.test(input.expected_entry_hash) ||
        !hexDigest.test(input.expected_exclusion_revision_digest) || !hexDigest.test(input.command_digest) ||
        !hexDigest.test(input.operation_plan_binding_digest) || !Number.isSafeInteger(input.timestamp_ms) || input.timestamp_ms <= 0) {
      throw new Error("memory_personalization_input_invalid");
    }
    const target = this.inspectPersonalizationTarget(input.request_id, input.expected_entry_hash);
    if (target.exclusion_revision_digest !== input.expected_exclusion_revision_digest) {
      throw new Error("memory_personalization_target_stale_or_unverified");
    }
    if (target.status === "already_excluded") {
      const prior = this.personalizationExclusions.find((event) => event.request_id === input.request_id &&
        event.entry_hash === input.expected_entry_hash)!;
      return { status: "already_excluded", entry_hash: input.expected_entry_hash, exclusion_digest: prior.event_hash,
        exclusion_revision_digest: target.exclusion_revision_digest, historical_record_retained: true, physical_deletion: false,
        used_for_authority: false, may_execute: false };
    }
    if (target.status !== "available" || target.exclusion_revision_digest !== input.expected_exclusion_revision_digest) {
      throw new Error("memory_personalization_target_stale_or_unverified");
    }
    if (this.personalizationExclusions.some((event) => event.command_digest === input.command_digest)) {
      throw new Error("memory_personalization_command_reused");
    }
    const previous = this.personalizationExclusions.at(-1)?.event_hash ?? "GENESIS";
    const base = {
      index: this.personalizationExclusions.length,
      request_id: input.request_id,
      entry_hash: input.expected_entry_hash,
      command_digest: input.command_digest,
      operation_plan_binding_digest: input.operation_plan_binding_digest,
      timestamp_ms: input.timestamp_ms,
      prev_hash: previous,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    const event: PersonalizationExclusionEvent = { ...base, event_hash: hashPersonalizationExclusion(base) };
    const filepath = this.personalizationFilepath();
    if (filepath) {
      try {
        const currentRaw = this.readPersonalizationRaw();
        const separator = currentRaw.length > 0 && !currentRaw.endsWith("\n") ? "\n" : "";
        appendFileSync(filepath, `${separator}${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
      } catch {
        throw new Error("memory_personalization_persistence_failed");
      }
    }
    this.personalizationExclusions.push(event);
    this.excludedPersonalizationTargets.add(`${event.request_id}:${event.entry_hash}`);
    const state = this.personalizationExclusionState();
    if (state.status !== "verified") {
      this.personalizationLedgerValid = false;
      throw new Error("memory_personalization_persistence_unverified");
    }
    return { status: "excluded", entry_hash: input.expected_entry_hash, exclusion_digest: event.event_hash,
      exclusion_revision_digest: state.revision_digest, historical_record_retained: true, physical_deletion: false,
      used_for_authority: false, may_execute: false };
  }

  isPersonalizationExcluded(request_id: string, entry_hash: string): boolean {
    if (!this.personalizationLedgerValid) return true;
    return this.excludedPersonalizationTargets.has(`${request_id}:${entry_hash}`);
  }

  /**
   * Re-read and verify the current M chain, returning only requested versions.
   * A valid append to another record does not invalidate existing references.
   */
  currentReferenceVersions(requestIds: readonly string[]): CurrentMemoryReferenceVersionSnapshot {
    if (requestIds.length > 100 || requestIds.some((id) => !/^[A-Za-z0-9_.:-]{1,96}$/.test(id))) {
      return { status: "unverified", records: [] };
    }
    const ids = [...new Set(requestIds)];
    let currentEntries: readonly MemoryEntry[];
    try {
      if (!this.filepath) {
        currentEntries = this.entries;
      } else {
        const raw = existsSync(this.filepath) ? readFileSync(this.filepath, "utf8") : "";
        currentEntries = raw.split("\n").filter((line) => line.trim().length > 0).map(decodeMemoryEntry);
      }
    } catch {
      return { status: "unverified", records: [] };
    }
    if (!verifyMemoryEntrySequence(currentEntries) || this.personalizationExclusionState().status !== "verified") {
      return { status: "unverified", records: [] };
    }

    return {
      status: "verified",
      records: ids.map((request_id) => {
        const matches = currentEntries.filter((entry) => entry.request_id === request_id);
        const entry = matches.length === 1 ? matches[0]! : undefined;
        return { request_id, version: entry && !this.isPersonalizationExcluded(request_id, entry.entry_hash) ? entry.entry_hash : null };
      }),
    };
  }

  size(): number {
    return this.entries.length;
  }

  skippedCount(): number {
    return this.skipped_captures;
  }

  verify(): boolean {
    return verifyMemoryEntrySequence(this.entries) && this.personalizationExclusionState().status === "verified";
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
          .update(`${this.entries.length}|${lastHash}|${this.personalizationExclusionState().revision_digest}`)
          .digest("hex"),
        entry_count: this.entries.length,
      };
    }

    let raw = "";
    try {
      raw = existsSync(this.filepath) ? readFileSync(this.filepath, "utf8") : "";
      const exclusionRaw = this.readPersonalizationRaw();
      const diskEntries = raw.split("\n").filter((line) => line.trim().length > 0).map(decodeMemoryEntry);
      const diskValid = verifyMemoryEntrySequence(diskEntries);
      const diskExclusions = decodePersonalizationEvents(exclusionRaw);
      const exclusionValid = this.personalizationLedgerValid && verifyPersonalizationExclusionSequence(diskExclusions) &&
        samePersonalizationEvents(diskExclusions, this.personalizationExclusions) && this.personalizationTargetsExist(diskExclusions, diskEntries);
      const sameLoadedState = diskEntries.length === this.entries.length && diskEntries.every(
        (entry, index) => entry.entry_hash === this.entries[index]?.entry_hash,
      );
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: diskValid && sameLoadedState && exclusionValid ? "verified" : "invalid",
        revision_digest: createHash("sha256").update(`${raw}\u0000${exclusionRaw}`, "utf8").digest("hex"),
        entry_count: diskEntries.length,
      };
    } catch {
      return {
        schema_version: "blue-tanuki.memory-state-version.v1",
        status: "invalid",
        revision_digest: createHash("sha256").update(`${raw}\u0000${this.safePersonalizationRaw()}`, "utf8").digest("hex"),
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

  private personalizationFilepath(): string | undefined {
    return this.filepath ? `${this.filepath}.personalization.jsonl` : undefined;
  }

  private readPersonalizationRaw(): string {
    const filepath = this.personalizationFilepath();
    if (filepath) return existsSync(filepath) ? readFileSync(filepath, "utf8") : "";
    return this.personalizationExclusions.map((event) => JSON.stringify(event)).join("\n") +
      (this.personalizationExclusions.length > 0 ? "\n" : "");
  }

  private safePersonalizationRaw(): string {
    try { return this.readPersonalizationRaw(); } catch { return "<unreadable>"; }
  }

  private loadPersonalizationExclusions(): void {
    try {
      const raw = this.readPersonalizationRaw();
      this.personalizationExclusions = decodePersonalizationEvents(raw);
      this.personalizationLedgerValid = verifyPersonalizationExclusionSequence(this.personalizationExclusions);
      this.excludedPersonalizationTargets.clear();
      for (const event of this.personalizationExclusions) {
        this.excludedPersonalizationTargets.add(`${event.request_id}:${event.entry_hash}`);
      }
    } catch {
      this.personalizationExclusions = [];
      this.excludedPersonalizationTargets.clear();
      this.personalizationLedgerValid = false;
    }
  }

  private personalizationTargetsExist(events: readonly PersonalizationExclusionEvent[], entries: readonly MemoryEntry[]): boolean {
    return events.every((event) => entries.filter((entry) => entry.request_id === event.request_id &&
      entry.entry_hash === event.entry_hash).length === 1);
  }
}

type PersonalizationExclusionEventBase = Omit<PersonalizationExclusionEvent, "event_hash">;

function hashPersonalizationExclusion(event: PersonalizationExclusionEventBase): string {
  return createHash("sha256").update(`${event.index}|${event.prev_hash}|${canonicalJson(event)}`, "utf8").digest("hex");
}

function decodePersonalizationEvents(raw: string): PersonalizationExclusionEvent[] {
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory_personalization_event_invalid");
    const event = value as Partial<PersonalizationExclusionEvent>;
    const keys = Object.keys(value).sort().join(",");
    if (keys !== ["command_digest", "entry_hash", "event_hash", "index", "may_execute", "operation_plan_binding_digest",
      "prev_hash", "request_id", "timestamp_ms", "used_for_authority"].sort().join(",") ||
        !Number.isSafeInteger(event.index) || typeof event.request_id !== "string" || typeof event.entry_hash !== "string" ||
        typeof event.command_digest !== "string" || typeof event.operation_plan_binding_digest !== "string" ||
        typeof event.timestamp_ms !== "number" || typeof event.prev_hash !== "string" || typeof event.event_hash !== "string" ||
        event.used_for_authority !== false || event.may_execute !== false) {
      throw new Error("memory_personalization_event_invalid");
    }
    return event as PersonalizationExclusionEvent;
  });
}

function verifyPersonalizationExclusionSequence(events: readonly PersonalizationExclusionEvent[]): boolean {
  let previousHash = "GENESIS";
  const targets = new Set<string>();
  const commands = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const target = `${event.request_id}:${event.entry_hash}`;
    if (event.index !== index || !/^[A-Za-z0-9_.:-]{1,96}$/.test(event.request_id) ||
        !/^[a-f0-9]{64}$/.test(event.entry_hash) || !/^[a-f0-9]{64}$/.test(event.command_digest) ||
        !/^[a-f0-9]{64}$/.test(event.operation_plan_binding_digest) || !Number.isSafeInteger(event.timestamp_ms) ||
        event.timestamp_ms <= 0 || event.prev_hash !== previousHash || targets.has(target) || commands.has(event.command_digest) ||
        event.event_hash !== hashPersonalizationExclusion({ index: event.index, request_id: event.request_id,
          entry_hash: event.entry_hash, command_digest: event.command_digest,
          operation_plan_binding_digest: event.operation_plan_binding_digest, timestamp_ms: event.timestamp_ms,
          prev_hash: event.prev_hash, used_for_authority: false, may_execute: false })) return false;
    targets.add(target);
    commands.add(event.command_digest);
    previousHash = event.event_hash;
  }
  return true;
}

function samePersonalizationEvents(a: readonly PersonalizationExclusionEvent[], b: readonly PersonalizationExclusionEvent[]): boolean {
  return a.length === b.length && a.every((event, index) => event.event_hash === b[index]?.event_hash);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("memory_personalization_event_not_canonical");
  return encoded;
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
