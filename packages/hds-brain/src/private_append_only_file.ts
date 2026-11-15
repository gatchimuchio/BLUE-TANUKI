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
    const opened = this.open("append");
    if (!opened) throw new Error("hds_private_file_unavailable");
    try {
      appendFileSync(opened.fd, value, "utf8");
      this.identity = opened.identity;
      this.absentAtConstruction = false;
    } finally {
      closeSync(opened.fd);
    }
  }

  private open(mode: "read" | "append"): { fd: number; identity: FileIdentity } | undefined {
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
      return { fd, identity: { dev: descriptorStat.dev, ino: descriptorStat.ino } };
    } catch (error) {
      closeSync(fd);
      throw error;
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
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = tryLstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("hds_private_file_directory_must_be_real");
    }
  }
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
