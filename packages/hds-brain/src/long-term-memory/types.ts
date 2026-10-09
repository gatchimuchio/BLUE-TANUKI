import type { Decision } from "@blue-tanuki/protocol";
import type { ActorKind, ProcessKind, TrustLevel } from "../types.js";

export interface MemoryClosure {
  x: string[];
  r: string[];
  m: string[];
}

export interface MemoryActorSnapshot {
  actor_id: string;
  actor_kind: ActorKind;
  channel: string;
  trust_level: TrustLevel;
}

export interface MemoryProcessSnapshot {
  process_id: string;
  process_kind: ProcessKind;
  version: string;
}

export interface MemoryCommitSnapshot {
  decision: Decision;
  hash: string;
  reason: string;
}

export interface MemoryEntry {
  /** Entry index (0-based, monotonic). */
  index: number;
  /** Source DecisionLog request_id. */
  request_id: string;
  /** Public audit reference for this memory write/read target. */
  f_reference?: string;
  /** Captured-at timestamp, copied from the source DecisionLog. */
  timestamp: number;
  /** TCP closure snapshot: the only judgment-relevant signal. */
  closure: MemoryClosure;
  /** Frame goal, retained for deterministic relevance lookup. */
  goal: string;
  /** Problem definition that handled this request. */
  problem_definition_id: string;
  /** Model abstraction, copied without summarization or generation. */
  abstraction: string;
  /** Actor snapshot copied from the upstream frame. Optional for legacy JSONL entries. */
  actor?: MemoryActorSnapshot;
  /** Process snapshot copied from the upstream frame. Optional for legacy JSONL entries. */
  process?: MemoryProcessSnapshot;
  /** Commit snapshot binding this memory entry to an audited upstream decision. */
  commit?: MemoryCommitSnapshot;
  /** Deterministic lookup tags. These are structural labels, not LLM-generated summaries. */
  tags?: string[];
  /** SHA-256 of index, prev_hash, and canonical entry content. */
  entry_hash: string;
  /** Previous entry hash, or GENESIS for index=0. */
  prev_hash: string;
}

export interface MemoryStoreOptions {
  /** Optional JSONL file path. If omitted, the store is in-memory only. */
  filepath?: string;
  /**
   * Soft cap in entries. On overflow, captures are skipped; existing entries
   * are never deleted or overwritten. Defaults to 10_000. Set 0 for unlimited.
   */
  max_entries?: number;
}

/** Digest-only view of the current M store generation for restart reconciliation. */
export interface MemoryStoreStateVersion {
  readonly schema_version: "blue-tanuki.memory-state-version.v1";
  readonly status: "verified" | "invalid";
  readonly revision_digest: string;
  readonly entry_count: number | null;
}
