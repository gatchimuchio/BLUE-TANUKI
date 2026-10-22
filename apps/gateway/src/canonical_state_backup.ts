import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, lstatSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync, backup } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const CANONICAL_STATE_STORE_PATHS = [
  { key: "j_control", relative_path: join("result-memory", "j-control.sqlite") },
  { key: "m_state", relative_path: join("result-memory", "m-state.sqlite") },
  { key: "broker", relative_path: join("execution-intents", "executor.sqlite") },
  { key: "operation_plans", relative_path: join("operation-plans", "j-state.sqlite") },
  { key: "cron_events", relative_path: join("cron-events", "cron-events.sqlite") },
  { key: "meaning_update_j_control", relative_path: join("meaning-update-memory", "j-control.sqlite") },
  { key: "meaning_update_m_state", relative_path: join("meaning-update-memory", "m-state.sqlite") },
] as const;

export type CanonicalStateStoreKey = typeof CANONICAL_STATE_STORE_PATHS[number]["key"];
export type CanonicalStateSnapshotEntryStatus = "verified" | "captured_unverified" | "snapshot_failed" | "not_present";

export interface CanonicalStateSnapshotEntry {
  readonly store_key: CanonicalStateStoreKey;
  readonly status: CanonicalStateSnapshotEntryStatus;
  readonly archive_rel_path: string | null;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly integrity_check: "ok" | "failed" | "not_run";
}

export interface CanonicalStateSnapshotManifest {
  readonly schema_version: 1;
  readonly store_consistency: "independent_sqlite_online_snapshots";
  readonly cross_store_atomic: false;
  /** Five-store manifests are accepted for inspection only; new captures always contain seven stores. */
  readonly expected_store_count: 5 | 7;
  readonly entries: readonly CanonicalStateSnapshotEntry[];
}

export interface CanonicalStateSnapshotInspection {
  readonly coverage: "complete" | "partial" | "none_present";
  readonly expected_store_count: 7;
  readonly captured_store_count: number;
  readonly verified_store_count: number;
  readonly missing_store_count: number;
  readonly unverified_store_count: number;
  readonly store_consistency: "independent_sqlite_online_snapshots";
  readonly cross_store_atomic: false;
}

interface StoreSource {
  readonly key: CanonicalStateStoreKey;
  readonly path: string;
  readonly present: boolean;
}

interface StoreDataVersionObservation {
  readonly database: DatabaseSyncType;
  readonly initialVersion: number;
  readonly sourcePath: string;
  readonly sourceIdentity: StoreSourceIdentity;
}

interface StoreSourceIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

async function digestFile(filepath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filepath)) {
    if (!Buffer.isBuffer(chunk)) throw new Error("canonical_state_snapshot_read_failed");
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code) === "ENOENT";
}

function storeSourceIdentity(sourcePath: string): StoreSourceIdentity {
  const stat = lstatSync(sourcePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino <= 0n) {
    throw new Error("canonical_state_source_identity_unavailable");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs,
  };
}

function sameStoreSourceIdentity(left: StoreSourceIdentity, right: StoreSourceIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedAt === right.modifiedAt && left.changedAt === right.changedAt;
}

function safeDirectory(value: string): boolean {
  try {
    const stat = lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("canonical_state_backup_source_unavailable");
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new Error("canonical_state_backup_source_unavailable");
  }
}

function resolveStoreSources(stateRootValue: string): StoreSource[] {
  let stateRoot: string;
  try {
    const rootStat = lstatSync(stateRootValue);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("canonical_state_backup_source_unavailable");
    }
    stateRoot = realpathSync(stateRootValue);
  } catch (error) {
    if (isMissing(error)) {
      return CANONICAL_STATE_STORE_PATHS.map(({ key, relative_path }) => ({
        key,
        path: join(stateRootValue, "private-state", relative_path),
        present: false,
      }));
    }
    throw new Error("canonical_state_backup_source_unavailable");
  }

  const privateRoot = join(stateRoot, "private-state");
  if (!safeDirectory(privateRoot)) {
    return CANONICAL_STATE_STORE_PATHS.map(({ key, relative_path }) => ({
      key,
      path: join(privateRoot, relative_path),
      present: false,
    }));
  }

  return CANONICAL_STATE_STORE_PATHS.map(({ key, relative_path }) => {
    const sourcePath = join(privateRoot, relative_path);
    const sourceDirectory = join(privateRoot, ...relative_path.split(/[\\/]/).slice(0, -1));
    if (!safeDirectory(sourceDirectory)) return { key, path: sourcePath, present: false };
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("canonical_state_backup_source_unavailable");
      }
      const resolved = realpathSync(sourcePath);
      const rel = relative(privateRoot, resolved);
      if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(privateRoot, rel) !== resolved) {
        throw new Error("canonical_state_backup_source_unavailable");
      }
      return { key, path: resolved, present: true };
    } catch (error) {
      if (isMissing(error)) return { key, path: sourcePath, present: false };
      throw new Error("canonical_state_backup_source_unavailable");
    }
  });
}

export function resolveCanonicalStateStoreTargetPath(
  stateRootValue: string,
  storeKey: CanonicalStateStoreKey,
): string {
  const stateRoot = resolve(stateRootValue);
  const sources = resolveStoreSources(stateRoot);
  const source = sources.find((item) => item.key === storeKey);
  if (!source) throw new Error("canonical_state_restore_store_unknown");
  let realStateRoot: string;
  try { realStateRoot = realpathSync(stateRoot); }
  catch { throw new Error("canonical_state_restore_target_unavailable"); }
  const privateRoot = join(realStateRoot, "private-state");
  if (!safeDirectory(privateRoot) || !safeDirectory(dirname(source.path))) {
    throw new Error("canonical_state_restore_target_unavailable");
  }
  return source.path;
}

/** Resolve only the selected canonical store; never stat sibling stores. */
export function resolveCanonicalStateStoreInspectionPath(
  stateRootValue: string,
  storeKey: CanonicalStateStoreKey,
): string {
  const store = CANONICAL_STATE_STORE_PATHS.find((candidate) => candidate.key === storeKey);
  if (!store) throw new Error("canonical_state_restore_store_unknown");
  const stateRoot = resolve(stateRootValue);
  if (!safeDirectory(stateRoot)) throw new Error("canonical_state_restore_target_unavailable");
  const realStateRoot = realpathSync(stateRoot);
  const privateRoot = join(realStateRoot, "private-state");
  if (!safeDirectory(privateRoot)) throw new Error("canonical_state_restore_target_unavailable");
  const targetPath = join(privateRoot, store.relative_path);
  const targetDirectory = dirname(targetPath);
  try {
    const directoryStat = lstatSync(targetDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("canonical_state_restore_target_unavailable");
    }
    const resolvedDirectory = realpathSync(targetDirectory);
    const directoryRel = relative(privateRoot, resolvedDirectory);
    if (directoryRel.startsWith(`..${sep}`) || directoryRel === ".." ||
        resolve(privateRoot, directoryRel) !== resolvedDirectory) {
      throw new Error("canonical_state_restore_target_unavailable");
    }
  } catch (error) {
    if (isMissing(error)) return targetPath;
    throw new Error("canonical_state_restore_target_unavailable");
  }
  try {
    const stat = lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("canonical_state_restore_target_unavailable");
    const resolvedTarget = realpathSync(targetPath);
    const rel = relative(privateRoot, resolvedTarget);
    if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(privateRoot, rel) !== resolvedTarget) {
      throw new Error("canonical_state_restore_target_unavailable");
    }
    return resolvedTarget;
  } catch (error) {
    if (isMissing(error)) return targetPath;
    throw new Error("canonical_state_restore_target_unavailable");
  }
}

export interface CanonicalStateStoreTargetInspection {
  readonly status: "verified" | "not_present" | "mismatch" | "unverified";
  readonly bytes: number | null;
  readonly sha256: string | null;
}

/** Read one fixed canonical store without creating paths or accepting sidecar state. */
export async function inspectCanonicalStateStoreTarget(
  stateRootValue: string,
  storeKey: CanonicalStateStoreKey,
): Promise<CanonicalStateStoreTargetInspection> {
  let targetPath: string;
  try {
    targetPath = resolveCanonicalStateStoreInspectionPath(stateRootValue, storeKey);
  } catch {
    return { status: "unverified", bytes: null, sha256: null };
  }

  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      await fs.lstat(`${targetPath}${suffix}`);
      return { status: "unverified", bytes: null, sha256: null };
    } catch (error) {
      if (!isMissing(error)) return { status: "unverified", bytes: null, sha256: null };
    }
  }

  let beforeIdentity: StoreSourceIdentity;
  let beforeDigest: { bytes: number; sha256: string };
  try {
    beforeIdentity = storeSourceIdentity(targetPath);
    beforeDigest = await digestFile(targetPath);
  } catch (error) {
    if (isMissing(error)) return { status: "not_present", bytes: null, sha256: null };
    return { status: "unverified", bytes: null, sha256: null };
  }

  let database: DatabaseSyncType | undefined;
  let journalMode: string | null = null;
  let integrityValid = false;
  try {
    database = new DatabaseSync(targetPath, { readOnly: true });
    const journalModeRow = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    journalMode = typeof journalModeRow?.journal_mode === "string" ? journalModeRow.journal_mode.toLowerCase() : null;
    integrityValid = integrityCheck(database);
  } catch {
    integrityValid = false;
  } finally {
    try { database?.close(); } catch { /* The inspection remains non-authoritative. */ }
  }
  if (!integrityValid) return { status: "mismatch", bytes: null, sha256: null };
  if (journalMode !== "delete") return { status: "unverified", bytes: null, sha256: null };

  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      await fs.lstat(`${targetPath}${suffix}`);
      return { status: "unverified", bytes: null, sha256: null };
    } catch (error) {
      if (!isMissing(error)) return { status: "unverified", bytes: null, sha256: null };
    }
  }

  let afterIdentity: StoreSourceIdentity;
  let afterDigest: { bytes: number; sha256: string };
  try {
    afterIdentity = storeSourceIdentity(targetPath);
    afterDigest = await digestFile(targetPath);
  } catch {
    return { status: "unverified", bytes: null, sha256: null };
  }
  if (!sameStoreSourceIdentity(beforeIdentity, afterIdentity) ||
      beforeDigest.bytes !== afterDigest.bytes || beforeDigest.sha256 !== afterDigest.sha256) {
    return { status: "unverified", bytes: null, sha256: null };
  }
  return { status: "verified", bytes: afterDigest.bytes, sha256: afterDigest.sha256 };
}

function integrityCheck(database: DatabaseSyncType): boolean {
  try {
    let rows = 0;
    for (const row of database.prepare("PRAGMA integrity_check").iterate() as Iterable<{ integrity_check?: unknown }>) {
      rows += 1;
      if (rows > 1 || row.integrity_check !== "ok") return false;
    }
    return rows === 1;
  } catch {
    return false;
  }
}

function databaseDataVersion(database: DatabaseSyncType): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown } | undefined;
  if (row === undefined || !Number.isSafeInteger(row.data_version) || (row.data_version as number) < 0) {
    throw new Error("canonical_state_data_version_unavailable");
  }
  return row.data_version as number;
}

function copyDeleteJournalSnapshot(database: DatabaseSyncType, sourcePath: string, archivePath: string): void {
  database.exec("PRAGMA busy_timeout=5000");
  const journalMode = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
  if (typeof journalMode?.journal_mode !== "string" || journalMode.journal_mode.toLowerCase() !== "delete") {
    throw new Error("canonical_state_snapshot_requires_delete_journal");
  }
  database.exec("BEGIN");
  try {
    database.prepare("SELECT count(*) AS object_count FROM sqlite_master").get();
    // 読取取引のshared lockをcopy完了まで保ち、DELETE journalのcommit中にDB本体が置換されるのを防ぐ。
    copyFileSync(sourcePath, archivePath);
    database.exec("ROLLBACK");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 元のsnapshot失敗を保持する。 */ }
    throw error;
  }
}

function checkedEntry(value: unknown): value is CanonicalStateSnapshotEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const key = CANONICAL_STATE_STORE_PATHS.some((store) => store.key === item.store_key);
  const status = ["verified", "captured_unverified", "snapshot_failed", "not_present"].includes(String(item.status));
  if (!key || !status || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0) return false;
  if (item.integrity_check !== "ok" && item.integrity_check !== "failed" && item.integrity_check !== "not_run") return false;
  if (item.archive_rel_path !== null && typeof item.archive_rel_path !== "string") return false;
  if (item.sha256 !== null && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) return false;
  if (item.status === "verified") {
    return item.integrity_check === "ok" && typeof item.archive_rel_path === "string" && typeof item.sha256 === "string" && (item.bytes as number) > 0;
  }
  if (item.status === "captured_unverified") {
    return item.integrity_check === "failed" && typeof item.archive_rel_path === "string" && typeof item.sha256 === "string" && (item.bytes as number) > 0;
  }
  if (item.status === "snapshot_failed") {
    return item.integrity_check === "not_run" && item.archive_rel_path === null && item.sha256 === null && item.bytes === 0;
  }
  return item.integrity_check === "not_run" && item.archive_rel_path === null && item.sha256 === null && item.bytes === 0;
}

function checkedManifest(value: unknown): value is CanonicalStateSnapshotManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.schema_version !== 1 || source.store_consistency !== "independent_sqlite_online_snapshots" ||
      source.cross_store_atomic !== false || !Array.isArray(source.entries)) return false;
  const legacyKeys = new Set<string>(["j_control", "m_state", "broker", "operation_plans", "cron_events"]);
  const legacy = source.expected_store_count === 5 && source.entries.length === legacyKeys.size;
  const current = source.expected_store_count === CANONICAL_STATE_STORE_PATHS.length &&
    source.entries.length === CANONICAL_STATE_STORE_PATHS.length;
  if (!legacy && !current) return false;
  const keys = new Set<string>();
  for (const entry of source.entries) {
    if (!checkedEntry(entry)) return false;
    if (keys.has(entry.store_key)) return false;
    if (legacy && !legacyKeys.has(entry.store_key)) return false;
    keys.add(entry.store_key);
  }
  return legacy ? [...legacyKeys].every((key) => keys.has(key))
    : CANONICAL_STATE_STORE_PATHS.every((store) => keys.has(store.key));
}

export async function captureCanonicalStateSnapshots(
  stateRootValue: string,
  packDirectory: string,
): Promise<CanonicalStateSnapshotManifest> {
  const stateRoot = resolve(stateRootValue);
  const sources = resolveStoreSources(stateRoot);
  const archiveDirectory = join(packDirectory, "canonical-state");
  await fs.mkdir(archiveDirectory, { mode: 0o700 });
  const entries: CanonicalStateSnapshotEntry[] = [];
  const observations = new Map<CanonicalStateStoreKey, StoreDataVersionObservation>();
  const observationFailed = new Set<CanonicalStateStoreKey>();

  for (const source of sources) {
    if (!source.present) continue;
    let database: DatabaseSyncType | undefined;
    try {
      const initialIdentity = storeSourceIdentity(source.path);
      database = new DatabaseSync(source.path, { readOnly: true });
      const initialVersion = databaseDataVersion(database);
      const openedIdentity = storeSourceIdentity(source.path);
      if (!sameStoreSourceIdentity(initialIdentity, openedIdentity)) throw new Error("canonical_state_source_changed_during_observation");
      observations.set(source.key, { database, initialVersion, sourcePath: source.path, sourceIdentity: openedIdentity });
      database = undefined;
    } catch {
      try { database?.close(); } catch { /* 観測できなければ当該storeを未確認にする。 */ }
      observationFailed.add(source.key);
    }
  }

  for (const source of sources) {
    if (!source.present) {
      entries.push({
        store_key: source.key,
        status: "not_present",
        archive_rel_path: null,
        bytes: 0,
        sha256: null,
        integrity_check: "not_run",
      });
      continue;
    }

    if (observationFailed.has(source.key) || !observations.has(source.key)) {
      entries.push({
        store_key: source.key,
        status: "snapshot_failed",
        archive_rel_path: null,
        bytes: 0,
        sha256: null,
        integrity_check: "not_run",
      });
      continue;
    }

    const archiveRelPath = join("canonical-state", `${source.key}.sqlite`);
    const archivePath = join(packDirectory, archiveRelPath);
    let sourceDatabase: DatabaseSyncType | undefined;
    let archiveDatabase: DatabaseSyncType | undefined;
    try {
      sourceDatabase = new DatabaseSync(source.path, { readOnly: true });
      copyDeleteJournalSnapshot(sourceDatabase, source.path, archivePath);
      if (process.platform !== "win32") chmodSync(archivePath, 0o600);
      archiveDatabase = new DatabaseSync(archivePath, { readOnly: true });
      const isValid = integrityCheck(archiveDatabase);
      archiveDatabase.close();
      archiveDatabase = undefined;
      sourceDatabase.close();
      sourceDatabase = undefined;
      const digest = await digestFile(archivePath);
      entries.push({
        store_key: source.key,
        status: isValid ? "verified" : "captured_unverified",
        archive_rel_path: archiveRelPath,
        bytes: digest.bytes,
        sha256: digest.sha256,
        integrity_check: isValid ? "ok" : "failed",
      });
    } catch {
      try { archiveDatabase?.close(); } catch { /* 元のsnapshot結果を保持する。 */ }
      try { sourceDatabase?.close(); } catch { /* 元のsnapshot結果を保持する。 */ }
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
      entries.push({
        store_key: source.key,
        status: "snapshot_failed",
        archive_rel_path: null,
        bytes: 0,
        sha256: null,
        integrity_check: "not_run",
      });
    }
  }

  let sourceChangedDuringCapture = false;
  for (const observation of observations.values()) {
    try {
      if (databaseDataVersion(observation.database) !== observation.initialVersion ||
          !sameStoreSourceIdentity(observation.sourceIdentity, storeSourceIdentity(observation.sourcePath))) {
        sourceChangedDuringCapture = true;
      }
    } catch {
      sourceChangedDuringCapture = true;
    }
  }
  try {
    const finalSources = resolveStoreSources(stateRoot);
    const finalByKey = new Map(finalSources.map((source) => [source.key, source]));
    if (finalSources.length !== sources.length || sources.some((source) =>
      finalByKey.get(source.key)?.present !== source.present)) {
      sourceChangedDuringCapture = true;
    }
  } catch {
    sourceChangedDuringCapture = true;
  }
  for (const observation of observations.values()) {
    try { observation.database.close(); } catch { /* 観測結果を保持する。 */ }
  }

  if (sourceChangedDuringCapture) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.archive_rel_path !== null) {
        await fs.rm(join(packDirectory, entry.archive_rel_path), { force: true });
      }
      entries[index] = {
        store_key: entry.store_key,
        status: "snapshot_failed",
        archive_rel_path: null,
        bytes: 0,
        sha256: null,
        integrity_check: "not_run",
      };
    }
  }

  return {
    schema_version: 1,
    store_consistency: "independent_sqlite_online_snapshots",
    cross_store_atomic: false,
    expected_store_count: CANONICAL_STATE_STORE_PATHS.length,
    entries,
  };
}

export async function inspectCanonicalStateSnapshots(
  packDirectory: string,
  value: unknown,
): Promise<CanonicalStateSnapshotInspection> {
  if (!checkedManifest(value)) throw new Error("invalid_canonical_state_snapshot_manifest");
  const archiveDirectory = join(packDirectory, "canonical-state");
  const directoryStat = await fs.lstat(archiveDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("invalid_canonical_state_snapshot_directory");
  }
  const expectedArchiveNames = new Set(value.entries
    .filter((entry) => entry.archive_rel_path !== null)
    .map((entry) => `${entry.store_key}.sqlite`));
  const archiveItems = await fs.readdir(archiveDirectory, { withFileTypes: true });
  if (archiveItems.length !== expectedArchiveNames.size || archiveItems.some((item) =>
    item.isSymbolicLink() || !item.isFile() || !expectedArchiveNames.has(item.name),
  )) {
    throw new Error("invalid_canonical_state_snapshot_inventory");
  }
  let captured = 0;
  let verified = 0;
  let missing = 0;
  let unverified = 0;
  const expectedByKey = new Map(CANONICAL_STATE_STORE_PATHS.map((store) => [store.key, store]));

  for (const entry of value.entries) {
    if (entry.status === "not_present") {
      missing += 1;
      continue;
    }
    if (entry.status === "snapshot_failed") {
      unverified += 1;
      continue;
    }

    const expectedRelPath = join("canonical-state", `${entry.store_key}.sqlite`);
    if (entry.archive_rel_path !== expectedRelPath || !expectedByKey.has(entry.store_key)) {
      throw new Error("invalid_canonical_state_snapshot_path");
    }
    const archivePath = join(packDirectory, expectedRelPath);
    const fileStat = await fs.lstat(archivePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("invalid_canonical_state_snapshot_file");
    const digest = await digestFile(archivePath);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) {
      throw new Error("invalid_canonical_state_snapshot_digest");
    }
    captured += 1;

    let database: DatabaseSyncType | undefined;
    let isValid = false;
    try {
      database = new DatabaseSync(archivePath, { readOnly: true });
      isValid = integrityCheck(database);
    } catch {
      isValid = false;
    } finally {
      try { database?.close(); } catch { /* 読取検査の結果を保持する。 */ }
    }
    if (entry.status === "verified" && !isValid) throw new Error("invalid_canonical_state_snapshot_integrity");
    if (entry.status === "captured_unverified" && isValid) throw new Error("invalid_canonical_state_snapshot_status");
    if (isValid) verified += 1;
    else unverified += 1;
  }
  // A pre-K-B2 pack cannot prove that either meaning-update ledger was absent at capture time.
  unverified += CANONICAL_STATE_STORE_PATHS.length - value.entries.length;

  return {
    coverage: verified === CANONICAL_STATE_STORE_PATHS.length
      ? "complete"
      : captured === 0 && unverified === 0 ? "none_present" : "partial",
    expected_store_count: CANONICAL_STATE_STORE_PATHS.length,
    captured_store_count: captured,
    verified_store_count: verified,
    missing_store_count: missing,
    unverified_store_count: unverified,
    store_consistency: value.store_consistency,
    cross_store_atomic: false,
  };
}

export async function restoreCanonicalStateSnapshotStore(
  stateRootValue: string,
  packDirectory: string,
  snapshot: CanonicalStateSnapshotManifest,
  storeKey: CanonicalStateStoreKey,
): Promise<{ readonly bytes: number; readonly sha256: string; readonly restoredStateSha256: string }> {
  await inspectCanonicalStateSnapshots(packDirectory, snapshot);
  if (snapshot.expected_store_count !== CANONICAL_STATE_STORE_PATHS.length ||
      snapshot.entries.length !== CANONICAL_STATE_STORE_PATHS.length) {
    throw new Error("canonical_state_restore_store_unverified");
  }
  const entry = snapshot.entries.find((item) => item.store_key === storeKey);
  if (!entry || entry.status !== "verified" || !entry.archive_rel_path || !entry.sha256) {
    throw new Error("canonical_state_restore_store_unverified");
  }

  const targetPath = resolveCanonicalStateStoreTargetPath(stateRootValue, storeKey);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      await fs.lstat(`${targetPath}${suffix}`);
      throw new Error("canonical_state_restore_target_busy");
    } catch (error) {
      if (error instanceof Error && error.message === "canonical_state_restore_target_busy") throw error;
      if (!isMissing(error)) throw new Error("canonical_state_restore_target_unavailable");
    }
  }

  const archivePath = join(packDirectory, entry.archive_rel_path);
  const before = await digestFile(archivePath);
  if (before.bytes !== entry.bytes || before.sha256 !== entry.sha256) {
    throw new Error("canonical_state_restore_archive_changed");
  }

  let source: DatabaseSyncType | undefined;
  try {
    source = new DatabaseSync(archivePath, { readOnly: true });
    if (!integrityCheck(source)) throw new Error("canonical_state_restore_archive_invalid");
    await backup(source, targetPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical_state_restore_")) throw error;
    throw new Error("canonical_state_restore_write_failed");
  } finally {
    try { source?.close(); } catch { /* keep restore outcome */ }
  }

  const after = await digestFile(archivePath).catch(() => null);
  if (!after || after.bytes !== entry.bytes || after.sha256 !== entry.sha256) {
    throw new Error("canonical_state_restore_archive_changed");
  }

  let restored: DatabaseSyncType | undefined;
  try {
    restored = new DatabaseSync(targetPath, { readOnly: true });
    if (!integrityCheck(restored)) throw new Error("canonical_state_restore_target_invalid");
  } catch (error) {
    if (error instanceof Error && error.message === "canonical_state_restore_target_invalid") throw error;
    throw new Error("canonical_state_restore_target_invalid");
  } finally {
    try { restored?.close(); } catch { /* verification result is already fixed */ }
  }
  const targetInspection = await inspectCanonicalStateStoreTarget(stateRootValue, storeKey);
  if (targetInspection.status !== "verified" || !targetInspection.sha256 || targetInspection.bytes === null) {
    throw new Error("canonical_state_restore_target_unverified");
  }
  return { bytes: entry.bytes, sha256: entry.sha256, restoredStateSha256: targetInspection.sha256 };
}
