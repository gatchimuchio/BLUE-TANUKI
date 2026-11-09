import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Env } from "./builtin_types.js";

const SECRET_DENY_COMPONENTS = new Set([
  ".aws",
  ".azure",
  ".env",
  ".git",
  ".gcloud",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secret",
  "secrets",
  "private-state",
]);
const SECRET_DENY_SUFFIXES = [".key", ".pem", ".p12", ".pfx"] as const;

export function displayPath(filepath: string): string {
  return filepath.replace(/\\/g, "/");
}

export function isSecretLikeRelativePath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (SECRET_DENY_COMPONENTS.has(lower)) return true;
    if (lower.startsWith(".env.")) return true;
    return SECRET_DENY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  });
}

export async function sandboxRootFromEnv(env: Env): Promise<string> {
  const raw = env.BLUE_TANUKI_FILE_ROOT;
  if (!raw || raw.trim().length === 0) {
    throw new Error("BLUE_TANUKI_FILE_ROOT is required for file.search");
  }
  const resolved = path.resolve(raw);
  assertNotPrivateState(resolved);
  const real = await fs.realpath(resolved);
  assertNotPrivateState(real);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new Error("BLUE_TANUKI_FILE_ROOT must be a directory");
  }
  return real;
}

export async function resolveFileSearchRoot(
  rootArg: string,
  sandboxRoot: string,
): Promise<string> {
  const lexical = path.isAbsolute(rootArg)
    ? path.resolve(rootArg)
    : path.resolve(sandboxRoot, rootArg);
  if (!pathInside(sandboxRoot, lexical)) {
    throw new Error("file.search root must stay within BLUE_TANUKI_FILE_ROOT");
  }
  const lexicalRel = path.relative(sandboxRoot, lexical);
  assertNotSecretLike(lexicalRel, displayPath(lexicalRel || "."));

  const real = await fs.realpath(lexical);
  if (!pathInside(sandboxRoot, real)) {
    throw new Error("file.search root escapes BLUE_TANUKI_FILE_ROOT via symlink");
  }
  const realRel = path.relative(sandboxRoot, real);
  assertNotSecretLike(realRel, displayPath(realRel || "."));
  return real;
}

export async function resolveSandboxFilePath(
  pathArg: string,
  sandboxRoot: string,
  env: Env = process.env,
): Promise<{ filepath: string; relative_path: string }> {
  const lexical = path.isAbsolute(pathArg)
    ? path.resolve(pathArg)
    : path.resolve(sandboxRoot, pathArg);
  if (!pathInside(sandboxRoot, lexical)) {
    throw new Error("file path must stay within BLUE_TANUKI_FILE_ROOT");
  }
  const rel = path.relative(sandboxRoot, lexical);
  assertNotSecretLike(rel, displayPath(rel || "."));
  await assertNotHdsMemoryArtifact(lexical, env);

  const parent = path.dirname(lexical);
  const realParent = await fs.realpath(parent);
  assertNotPrivateState(realParent);
  assertNotSecretLike(path.relative(sandboxRoot, realParent), displayPath(rel || "."));
  if (!pathInside(sandboxRoot, realParent)) {
    throw new Error("file path escapes BLUE_TANUKI_FILE_ROOT via symlink");
  }
  const parentStat = await fs.stat(realParent);
  if (!parentStat.isDirectory()) {
    throw new Error("file parent must be a directory");
  }

  const existing = await fs.lstat(lexical).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error("file path must not be a symlink");
  }
  if (existing) {
    const real = await fs.realpath(lexical);
    assertNotPrivateState(real);
    assertNotSecretLike(path.relative(sandboxRoot, real), displayPath(rel || "."));
    if (!pathInside(sandboxRoot, real)) {
      throw new Error("file path escapes BLUE_TANUKI_FILE_ROOT via symlink");
    }
    await assertNotHdsMemoryArtifact(real, env);
  }

  return {
    filepath: lexical,
    relative_path: displayPath(rel),
  };
}

/**
 * HDS M is read and changed through its governed store, never as an ordinary
 * sandbox file. This also protects the append-only personalization ledger so
 * generic file search cannot bypass an M citation exclusion.
 */
export async function isHdsMemoryArtifact(filepath: string, env: Env = process.env): Promise<boolean> {
  const configuredFile = env.BLUE_TANUKI_MEMORY_FILE?.trim();
  const configuredDir = env.BLUE_TANUKI_MEMORY_DIR?.trim();
  const memoryFile = configuredFile
    ? path.resolve(configuredFile)
    : configuredDir
      ? path.join(path.resolve(configuredDir), "memory.jsonl")
      : undefined;
  if (!memoryFile) return false;

  const protectedFiles = [memoryFile, `${memoryFile}.personalization.jsonl`];
  const targetPaths = await canonicalPathCandidates(filepath);
  const protectedPaths = new Set<string>();
  for (const protectedFile of protectedFiles) {
    for (const candidate of await canonicalPathCandidates(protectedFile)) protectedPaths.add(pathKey(candidate));
  }
  if ([...targetPaths].some((candidate) => protectedPaths.has(pathKey(candidate)))) return true;

  const targetIdentity = await fileIdentity(filepath);
  if (!targetIdentity) return false;
  for (const protectedFile of protectedFiles) {
    const protectedIdentity = await fileIdentity(protectedFile);
    if (protectedIdentity && protectedIdentity === targetIdentity) return true;
  }
  return false;
}

export async function assertNotHdsMemoryArtifact(filepath: string, env: Env = process.env): Promise<void> {
  if (await isHdsMemoryArtifact(filepath, env)) {
    throw new Error("file operation denied HDS memory storage");
  }
}

export async function* walkFiles(
  root: string,
  sandboxRoot: string,
  env: Env = process.env,
): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(root, entry.name);
    if (await isHdsMemoryArtifact(full, env)) continue;
    const rel = path.relative(sandboxRoot, full);
    if (isSecretLikeRelativePath(rel)) {
      continue;
    }
    const real = await fs.realpath(full);
    if (await isHdsMemoryArtifact(real, env)) continue;
    if (isPrivateStatePath(real) || isSecretLikeRelativePath(path.relative(sandboxRoot, real))) continue;
    if (!pathInside(sandboxRoot, real)) {
      throw new Error(
        `file.search path escapes BLUE_TANUKI_FILE_ROOT via symlink: ${displayPath(rel)}`,
      );
    }
    if (entry.isDirectory()) {
      yield* walkFiles(real, sandboxRoot, env);
    } else if (entry.isFile()) {
      yield real;
    }
  }
}

async function canonicalPathCandidates(filepath: string): Promise<Set<string>> {
  const absolute = path.resolve(filepath);
  const candidates = new Set<string>([absolute]);
  try {
    candidates.add(await fs.realpath(absolute));
  } catch {
    try {
      candidates.add(path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute)));
    } catch {
      // Keep the lexical path. If its parent is inaccessible, the protected
      // target itself cannot be opened through the ordinary sandbox path.
    }
  }
  return candidates;
}

async function fileIdentity(filepath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filepath, { bigint: true });
    if (!stat.isFile()) return null;
    return `${stat.dev.toString()}:${stat.ino.toString()}`;
  } catch {
    return null;
  }
}

function pathKey(filepath: string): string {
  const absolute = path.resolve(filepath);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function pathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertNotSecretLike(rel: string, label: string): void {
  if (isSecretLikeRelativePath(rel)) {
    throw new Error(`file.search denied secret-like path: ${label}`);
  }
}

function isPrivateStatePath(filepath: string): boolean {
  return filepath.replace(/\\/g, "/").split("/").some((part) => part.toLowerCase() === "private-state");
}
function assertNotPrivateState(filepath: string): void {
  if (isPrivateStatePath(filepath)) throw new Error("file operation denied private runtime state");
}
