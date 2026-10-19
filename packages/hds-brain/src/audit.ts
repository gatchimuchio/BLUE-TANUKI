import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord } from "./types.js";

/**
 * Append-only audit log with hash-chain.
 * Each entry's hash includes the previous entry's hash, making the log
 * tamper-evident: any modification breaks the chain on `verify()`.
 *
 * Phase 1: optional JSONL file persistence + load-time chain verification.
 *
 * Concurrency note: file writes use synchronous appendFileSync to keep the
 * chain ordering atomic per process. Multi-process writers are not supported
 * in Phase 1; if needed, Phase 2+ should add a write-mutex or single-writer
 * daemon.
 */
export interface AuditEntry {
  index: number;
  log: AuditRecord;
  prev_hash: string;
  entry_hash: string;
}

export interface AuditOptions {
  /**
   * Path to a JSONL file for persistence. If provided and the file exists,
   * the chain is loaded and verified on construction.
   */
  filepath?: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly filepath?: string;
  private persistenceFailure = false;

  constructor(opts: AuditOptions = {}) {
    this.filepath = opts.filepath;
    if (this.filepath && existsSync(this.filepath)) {
      this.loadFromFile();
    } else if (this.filepath) {
      // Ensure parent directory exists, but do not create the file —
      // first append() will create it.
      const dir = dirname(this.filepath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  append(log: AuditRecord): AuditEntry {
    if (this.persistenceFailure) {
      throw new Error("AuditLog persistence has failed; refusing further appends");
    }
    const prev_hash =
      this.entries.length === 0
        ? "GENESIS"
        : this.entries[this.entries.length - 1]!.entry_hash;

    const index = this.entries.length;
    const entry_hash = this.computeHash(index, log, prev_hash);
    const entry: AuditEntry = { index, log, prev_hash, entry_hash };

    if (this.filepath) {
      try {
        appendFileSync(this.filepath, JSON.stringify(entry) + "\n");
      } catch (error) {
        this.persistenceFailure = true;
        throw error;
      }
    }
    this.entries.push(entry);
    return entry;
  }

  /**
   * Verify the chain. Returns true iff all hashes are consistent.
   */
  verify(): boolean {
    if (this.persistenceFailure) return false;
    let prev_hash = "GENESIS";
    for (const entry of this.entries) {
      const expected = this.computeHash(entry.index, entry.log, prev_hash);
      if (expected !== entry.entry_hash || entry.prev_hash !== prev_hash) {
        return false;
      }
      prev_hash = entry.entry_hash;
    }
    return true;
  }

  list(): readonly AuditEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  /** Whether appended records survive a process restart through this log. */
  isPersistent(): boolean {
    return this.filepath !== undefined;
  }

  private computeHash(index: number, log: AuditRecord, prev_hash: string): string {
    return createHash("sha256")
      .update(`${index}|${prev_hash}|${JSON.stringify(log)}`)
      .digest("hex");
  }

  private loadFromFile(): void {
    if (!this.filepath) return;
    const raw = readFileSync(this.filepath, "utf8");
    const lines = raw.split("\n").filter((l: string) => l.trim().length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEntry;
      this.entries.push(parsed);
    }
    if (!this.verify()) {
      throw new Error(
        `AuditLog: chain verification failed on load from ${this.filepath}`,
      );
    }
  }
}
