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
  const real = await fs.realpath(resolved);
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
): Promise<{ filepath: string; relative_path: string }> {
  const lexical = path.isAbsolute(pathArg)
    ? path.resolve(pathArg)
    : path.resolve(sandboxRoot, pathArg);
  if (!pathInside(sandboxRoot, lexical)) {
    throw new Error("file path must stay within BLUE_TANUKI_FILE_ROOT");
  }
  const rel = path.relative(sandboxRoot, lexical);
  assertNotSecretLike(rel, displayPath(rel || "."));

  const parent = path.dirname(lexical);
  const realParent = await fs.realpath(parent);
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
    if (!pathInside(sandboxRoot, real)) {
      throw new Error("file path escapes BLUE_TANUKI_FILE_ROOT via symlink");
    }
  }

  return {
    filepath: lexical,
    relative_path: displayPath(rel),
  };
}

export async function* walkFiles(
  root: string,
  sandboxRoot: string,
): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(root, entry.name);
    const rel = path.relative(sandboxRoot, full);
    if (isSecretLikeRelativePath(rel)) {
      continue;
    }
    const real = await fs.realpath(full);
    if (!pathInside(sandboxRoot, real)) {
      throw new Error(
        `file.search path escapes BLUE_TANUKI_FILE_ROOT via symlink: ${displayPath(rel)}`,
      );
    }
    if (entry.isDirectory()) {
      yield* walkFiles(real, sandboxRoot);
    } else if (entry.isFile()) {
      yield real;
    }
  }
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
