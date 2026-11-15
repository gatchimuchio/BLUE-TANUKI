import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import {
  COMMON_RECORD_SCHEMA_VERSION,
  CommonRecordSchema,
  type CommonRecord,
} from "@blue-tanuki/protocol";
import {
  completeHistoryEntryHash,
  decodeCompleteHistoryEntry,
  encodeCompleteHistoryEntry,
  isValidCompleteHistorySemanticPayload,
  sha256Hex,
} from "./codec.js";
import {
  COMPLETE_HISTORY_SCHEMA_VERSION,
  type CompleteHistoryAppendInput,
  type CompleteHistoryEntry,
  type CompleteHistoryExport,
  type CompleteHistoryReplayFilter,
  type CompleteHistoryStoreOptions,
} from "./types.js";

export interface CompleteHistoryRecordProjection {
  readonly record: CommonRecord;
  readonly read_only: true;
  readonly used_for_authority: false;
  readonly complete_history_used_for_authority: false;
}

interface CompleteHistoryFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export class CompleteHistoryStore {
  private entries: CompleteHistoryEntry[] = [];
  private skipped = 0;
  private readonly filepath?: string;
  private readonly max_entries: number;
  private fileIdentity?: CompleteHistoryFileIdentity;
  private fileWasAbsentAtConstruction = false;

  constructor(opts: CompleteHistoryStoreOptions = {}) {
    this.filepath = opts.filepath ? resolve(opts.filepath) : undefined;
    this.max_entries = opts.max_entries ?? Number.POSITIVE_INFINITY;
    if (this.filepath) {
      ensureCompleteHistoryDirectory(dirname(this.filepath));
      if (tryLstat(this.filepath)) this.loadFromFile();
      else this.fileWasAbsentAtConstruction = true;
    }
  }

  append(input: CompleteHistoryAppendInput): CompleteHistoryEntry | null {
    if (!isValidCompleteHistorySemanticPayload(input.kind, input.payload)) {
      throw new Error("CompleteHistoryStore: 非権威意味記録の契約に不一致");
    }
    if (this.entries.length >= this.max_entries) {
      this.skipped += 1;
      return null;
    }
    const prev_hash = this.entries.length === 0 ? "GENESIS" : this.entries[this.entries.length - 1]!.entry_hash;
    const withoutHash: Omit<CompleteHistoryEntry, "entry_hash"> = {
      schema_version: COMPLETE_HISTORY_SCHEMA_VERSION,
      index: this.entries.length,
      id: randomUUID(),
      kind: input.kind,
      request_id: input.request_id ?? null,
      command_id: input.command_id ?? null,
      actor: input.actor,
      source: input.source,
      payload: input.payload,
      payload_digest: sha256Hex(input.payload),
      used_for_authority: false,
      timestamp: input.timestamp ?? Date.now(),
      prev_hash,
    };
    const entry: CompleteHistoryEntry = {
      ...withoutHash,
      entry_hash: completeHistoryEntryHash(withoutHash),
    };
    if (this.filepath) {
      const opened = openCompleteHistoryFile(
        this.filepath,
        "append",
        this.fileIdentity,
        this.fileWasAbsentAtConstruction,
      );
      try {
        appendFileSync(opened.fd, encodeCompleteHistoryEntry(entry) + "\n", "utf8");
        this.fileIdentity = opened.identity;
        this.fileWasAbsentAtConstruction = false;
      } finally {
        closeSync(opened.fd);
      }
    }
    this.entries.push(entry);
    return entry;
  }

  verify(): boolean {
    let prev_hash = "GENESIS";
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i]!;
      if (entry.index !== i) return false;
      if (entry.prev_hash !== prev_hash) return false;
      if (entry.used_for_authority !== false) return false;
      if (!isValidCompleteHistorySemanticPayload(entry.kind, entry.payload)) return false;
      const expectedPayloadDigest = sha256Hex(entry.payload);
      if (entry.payload_digest !== expectedPayloadDigest) return false;
      const { entry_hash: _entryHash, ...withoutHash } = entry;
      const expectedEntryHash = completeHistoryEntryHash(withoutHash);
      if (entry.entry_hash !== expectedEntryHash) return false;
      prev_hash = entry.entry_hash;
    }
    return true;
  }

  replay(filter: CompleteHistoryReplayFilter = {}): readonly CompleteHistoryEntry[] {
    return this.entries
      .filter((entry) => {
        if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
        if (filter.request_id !== undefined && entry.request_id !== filter.request_id) return false;
        if (filter.command_id !== undefined && entry.command_id !== filter.command_id) return false;
        return true;
      })
      .map(cloneEntry);
  }

  replayAsCommonRecords(): readonly CompleteHistoryRecordProjection[] {
    return this.entries.map((entry) => {
      const sourceRef = `complete-history:${entry.kind}:${entry.id}`;
      const candidate = {
        record_id: entry.id,
        record_kind: "legacy_history",
        schema_version: COMMON_RECORD_SCHEMA_VERSION,
        owner_id: "unknown",
        origin: { kind: "legacy_history", source_ref: sourceRef },
        recorded_at: entry.timestamp,
        source_refs: [sourceRef],
        previous_refs: entry.prev_hash === "GENESIS" ? [] : [`complete-history-hash:${entry.prev_hash}`],
        state: {
          meaning: { assertion: "unknown", adoption: "archived" },
          execution: { operation: "unknown", work: "unknown", effect: "unknown" },
          evidence: { status: "undecided" },
        },
        unknowns: ["旧履歴の内容から現在の意味、実行状態、外部結果、権限を推定しない。"],
        residual_refs: [],
        classification: "historical_reference_only",
        content_ref: `complete-history-payload:${entry.id}`,
        content_digest: entry.payload_digest,
      };
      const parsed = CommonRecordSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error("malformed read-only complete history projection");
      }
      return {
        record: parsed.data,
        read_only: true,
        used_for_authority: false,
        complete_history_used_for_authority: false,
      };
    });
  }

  exportSnapshot(opts: { exported_at?: number } = {}): CompleteHistoryExport {
    return {
      schema_version: COMPLETE_HISTORY_SCHEMA_VERSION,
      exported_at: opts.exported_at ?? Date.now(),
      entries: this.all(),
      entries_count: this.entries.length,
      chain_valid: this.verify(),
      complete_history_used_for_authority: false,
    };
  }

  exportJson(opts: { exported_at?: number } = {}): string {
    return JSON.stringify(this.exportSnapshot(opts), null, 2);
  }

  all(): CompleteHistoryEntry[] {
    return this.entries.map(cloneEntry);
  }

  size(): number {
    return this.entries.length;
  }

  skippedCount(): number {
    return this.skipped;
  }

  private loadFromFile(): void {
    if (!this.filepath) return;
    const opened = openCompleteHistoryFile(this.filepath, "read");
    let raw: string;
    try {
      raw = readFileSync(opened.fd, "utf8");
      this.fileIdentity = opened.identity;
    } finally {
      closeSync(opened.fd);
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    this.entries = lines.map(decodeCompleteHistoryEntry);
    if (!this.verify()) {
      throw new Error(`CompleteHistoryStore: chain verification failed on load from ${this.filepath}`);
    }
  }
}

function ensureCompleteHistoryDirectory(path: string): void {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  const parts = relative(root, absolutePath).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let stat = tryLstat(current);
    if (!stat) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = tryLstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("CompleteHistoryStore: storage directory must be a real directory");
    }
  }
}

function assertCompleteHistoryDirectory(path: string): void {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  for (const part of relative(root, absolutePath).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = tryLstat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("CompleteHistoryStore: storage directory identity changed");
    }
  }
}

function tryLstat(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function openCompleteHistoryFile(
  path: string,
  mode: "read" | "append",
  expectedIdentity?: CompleteHistoryFileIdentity,
  expectAbsent = false,
): { fd: number; identity: CompleteHistoryFileIdentity } {
  assertCompleteHistoryDirectory(dirname(path));
  const before = tryLstat(path);
  if (before && !isPrivateHistoryFileStat(before)) {
    throw new Error("CompleteHistoryStore: storage file must be a single-link regular file");
  }
  if ((expectedIdentity && !before) || (expectAbsent && before)) {
    throw new Error("CompleteHistoryStore: storage file identity changed");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = mode === "read"
    ? constants.O_RDONLY | noFollow
    : constants.O_WRONLY | constants.O_APPEND | noFollow |
      (expectAbsent ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    assertCompleteHistoryDirectory(dirname(path));
    const descriptorStat = fstatSync(fd, { bigint: true });
    const pathStat = tryLstat(path);
    if (!pathStat || !isPrivateHistoryFileStat(descriptorStat) || !isPrivateHistoryFileStat(pathStat) ||
        descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
        (expectedIdentity && (descriptorStat.dev !== expectedIdentity.dev || descriptorStat.ino !== expectedIdentity.ino))) {
      throw new Error("CompleteHistoryStore: storage file identity changed");
    }
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    return { fd, identity: { dev: descriptorStat.dev, ino: descriptorStat.ino } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function isPrivateHistoryFileStat(stat: { isFile(): boolean; nlink: bigint }): boolean {
  return stat.isFile() && stat.nlink === 1n;
}

function cloneEntry(entry: CompleteHistoryEntry): CompleteHistoryEntry {
  return structuredClone(entry);
}
