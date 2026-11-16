import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  readonly path: string;
}

interface RegularFileStat {
  isFile(): boolean;
  readonly nlink: bigint;
}

/** Private append-only JSONL target bound to one regular-file identity. */
export class HDSPrivateAppendOnlyFile {
  readonly filepath: string;
  private readonly directoryIdentity: readonly DirectoryIdentity[];
  private identity?: FileIdentity;
  private absentAtConstruction = false;
  private appendFailed = false;

  constructor(filepath: string) {
    this.filepath = resolve(filepath);
    ensureDirectoryPath(dirname(this.filepath));
    this.directoryIdentity = captureDirectoryIdentity(dirname(this.filepath));
    const existing = tryLstat(this.filepath);
    if (existing) {
      if (!isSingleLinkRegularFile(existing)) {
        throw new Error("hds_private_file_must_be_a_single_link_regular_file");
      }
      this.identity = { dev: existing.dev, ino: existing.ino };
    } else {
      this.absentAtConstruction = true;
    }
  }

  readUtf8IfPresent(): string | undefined {
    const opened = this.open("read");
    if (!opened) return undefined;
    try {
      return readFileSync(opened.fd, "utf8");
    } finally {
      closeSync(opened.fd);
    }
  }

  appendUtf8(value: string): void {
    if (this.appendFailed) throw new Error("hds_private_file_append_disabled_after_failure");
    const opened = this.open("append");
    if (!opened) throw new Error("hds_private_file_unavailable");
    let failed = false;
    let failure: unknown;
    try {
      appendFileSync(opened.fd, value, "utf8");
      fsyncSync(opened.fd);
      if (opened.created) syncDirectoryChain(dirname(this.filepath), this.directoryIdentity);
      this.identity = opened.identity;
      this.absentAtConstruction = false;
    } catch (error) {
      // A write/flush can be outcome-ambiguous; never retry through this instance.
      this.appendFailed = true;
      failed = true;
      failure = error;
    }
    try {
      closeSync(opened.fd);
    } catch (error) {
      // Preserve fail-closed behavior even if the record was already flushed.
      this.appendFailed = true;
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
  }

  private open(mode: "read" | "append"): { fd: number; identity: FileIdentity; created: boolean } | undefined {
    assertDirectoryPath(dirname(this.filepath), this.directoryIdentity);
    const before = tryLstat(this.filepath);
    if (this.absentAtConstruction) {
      if (before) throw new Error("hds_private_file_identity_changed");
      if (mode === "read") return undefined;
    } else {
      if (!before || !isSingleLinkRegularFile(before) || !this.identity ||
          before.dev !== this.identity.dev || before.ino !== this.identity.ino) {
        throw new Error("hds_private_file_identity_changed");
      }
    }

    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const flags = mode === "read"
      ? constants.O_RDONLY | noFollow
      : constants.O_WRONLY | constants.O_APPEND | noFollow |
        (this.absentAtConstruction ? constants.O_CREAT | constants.O_EXCL : 0);
    const fd = openSync(this.filepath, flags, 0o600);
    try {
      assertDirectoryPath(dirname(this.filepath), this.directoryIdentity);
      const descriptorStat = fstatSync(fd, { bigint: true });
      const pathStat = tryLstat(this.filepath);
      if (!pathStat || !isSingleLinkRegularFile(descriptorStat) || !isSingleLinkRegularFile(pathStat) ||
          descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
          (this.identity && (descriptorStat.dev !== this.identity.dev || descriptorStat.ino !== this.identity.ino))) {
        throw new Error("hds_private_file_identity_changed");
      }
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      return {
        fd,
        identity: { dev: descriptorStat.dev, ino: descriptorStat.ino },
        created: this.absentAtConstruction && mode === "append",
      };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
}

/** Mutable private snapshot file bound to one directory and regular-file identity. */
export class HDSPrivateReplaceableFile {
  readonly filepath: string;
  private readonly directoryIdentity: readonly DirectoryIdentity[];
  private identity?: FileIdentity;
  private absentAtConstruction = false;
  private replaceFailed = false;

  constructor(filepath: string) {
    this.filepath = resolve(filepath);
    ensureDirectoryPath(dirname(this.filepath));
    this.directoryIdentity = captureDirectoryIdentity(dirname(this.filepath));
    const existing = tryLstat(this.filepath);
    if (existing) {
      if (!isSingleLinkRegularFile(existing)) {
        throw new Error("hds_private_replaceable_file_must_be_a_single_link_regular_file");
      }
      this.identity = { dev: existing.dev, ino: existing.ino };
    } else {
      this.absentAtConstruction = true;
    }
  }

  readUtf8IfPresent(): string | undefined {
    if (this.replaceFailed) throw new Error("hds_private_replaceable_file_disabled_after_failure");
    this.assertDirectory();
    const before = tryLstat(this.filepath);
    if (this.absentAtConstruction) {
      if (before) throw new Error("hds_private_replaceable_file_identity_changed");
      return undefined;
    }
    if (!before || !isSingleLinkRegularFile(before) || !this.identity ||
        before.dev !== this.identity.dev || before.ino !== this.identity.ino) {
      throw new Error("hds_private_replaceable_file_identity_changed");
    }

    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(this.filepath, constants.O_RDONLY | noFollow);
    try {
      this.assertDirectory();
      const descriptorStat = fstatSync(fd, { bigint: true });
      const pathStat = tryLstat(this.filepath);
      if (!pathStat || !isSingleLinkRegularFile(descriptorStat) || !isSingleLinkRegularFile(pathStat) ||
          descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
          descriptorStat.dev !== this.identity.dev || descriptorStat.ino !== this.identity.ino) {
        throw new Error("hds_private_replaceable_file_identity_changed");
      }
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  /** Write a complete new snapshot privately, then atomically replace the old one. */
  replaceUtf8(value: string): void {
    if (this.replaceFailed) throw new Error("hds_private_replaceable_file_disabled_after_failure");
    this.assertCurrentPath();
    const temporaryPath = join(dirname(this.filepath), `.${randomUUID()}.tmp`);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    let replacementIdentity: FileIdentity | undefined;
    let committed = false;
    try {
      this.assertDirectory();
      fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      writeFileSync(fd, value, "utf8");
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      fsyncSync(fd);
      const descriptorStat = fstatSync(fd, { bigint: true });
      const pathStat = tryLstat(temporaryPath);
      if (!pathStat || !isSingleLinkRegularFile(descriptorStat) || !isSingleLinkRegularFile(pathStat) ||
          descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
        throw new Error("hds_private_replaceable_file_temporary_identity_changed");
      }
      replacementIdentity = { dev: descriptorStat.dev, ino: descriptorStat.ino };
      closeSync(fd);
      fd = undefined;

      this.assertCurrentPath();
      renameSync(temporaryPath, this.filepath);
      committed = true;
      const installed = tryLstat(this.filepath);
      if (!installed || !replacementIdentity || !isSingleLinkRegularFile(installed) ||
          installed.dev !== replacementIdentity.dev || installed.ino !== replacementIdentity.ino) {
        throw new Error("hds_private_replaceable_file_identity_changed_after_replace");
      }
      this.identity = replacementIdentity;
      this.absentAtConstruction = false;
      syncDirectoryChain(dirname(this.filepath), this.directoryIdentity);
    } catch (error) {
      if (committed) this.replaceFailed = true;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (!committed) {
        try {
          unlinkSync(temporaryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  private assertDirectory(): void {
    assertDirectoryPath(dirname(this.filepath), this.directoryIdentity);
  }

  private assertCurrentPath(): void {
    this.assertDirectory();
    const current = tryLstat(this.filepath);
    if (this.absentAtConstruction) {
      if (current) throw new Error("hds_private_replaceable_file_identity_changed");
      return;
    }
    if (!current || !isSingleLinkRegularFile(current) || !this.identity ||
        current.dev !== this.identity.dev || current.ino !== this.identity.ino) {
      throw new Error("hds_private_replaceable_file_identity_changed");
    }
  }
}

function ensureDirectoryPath(path: string): void {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  for (const part of relative(root, absolutePath).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = tryLstat(current);
    if (!stat) {
      let created = false;
      try {
        mkdirSync(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = tryLstat(current);
      if (created) syncDirectoryChain(dirname(current));
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("hds_private_file_directory_must_be_real");
    }
  }
}

/** Persist newly created directory entries on POSIX before reporting append success. */
function syncDirectoryChain(path: string, expected?: readonly DirectoryIdentity[]): void {
  // Win32 directory-handle flushing is not used: the documented API contract does not
  // establish durable directory-entry semantics for FlushFileBuffers on directory handles.
  if (process.platform === "win32") return;

  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = absolutePath;
  while (true) {
    syncDirectory(current, expected?.find((entry) => entry.path === current));
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function syncDirectory(path: string, expected?: DirectoryIdentity): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryOnly = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow | directoryOnly);
  let failed = false;
  let failure: unknown;
  try {
    const descriptorStat = fstatSync(fd, { bigint: true });
    const pathStat = tryLstat(path);
    if (!pathStat || pathStat.isSymbolicLink() || !pathStat.isDirectory() ||
        descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
        (expected && (descriptorStat.dev !== expected.dev || descriptorStat.ino !== expected.ino))) {
      throw new Error("hds_private_file_directory_identity_changed");
    }
    fsyncSync(fd);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

function captureDirectoryIdentity(path: string): readonly DirectoryIdentity[] {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  const result: DirectoryIdentity[] = [];
  const rootStat = tryLstat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("hds_private_file_directory_must_be_real");
  }
  result.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });
  for (const part of relative(root, absolutePath).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = tryLstat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("hds_private_file_directory_must_be_real");
    }
    result.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return result;
}

function assertDirectoryPath(path: string, expected: readonly DirectoryIdentity[]): void {
  const current = captureDirectoryIdentity(path);
  if (current.length !== expected.length || current.some((entry, index) =>
    entry.path !== expected[index]?.path || entry.dev !== expected[index]?.dev || entry.ino !== expected[index]?.ino)) {
    throw new Error("hds_private_file_directory_identity_changed");
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

function isSingleLinkRegularFile(stat: RegularFileStat): boolean {
  return stat.isFile() && stat.nlink === 1n;
}
