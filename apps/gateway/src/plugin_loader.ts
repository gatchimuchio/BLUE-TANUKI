import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  manifestPathFor,
  readManifest,
  type PluginManifest,
} from "@blue-tanuki/protocol";
import type { ToolRegistry } from "@blue-tanuki/core";
import {
  assertPluginReviewAccepted,
  reviewPluginPackage,
} from "./plugin_review_gate.js";

type PluginModule = Record<string, unknown>;
type Env = Record<string, string | undefined>;

interface PackageJson {
  name: string;
  version: string;
  main?: string;
}

export interface WorkspacePlugin {
  package_dir: string;
  package_json: PackageJson;
  manifest: PluginManifest;
  module?: PluginModule;
}

export interface PluginRuntimeOptions {
  root?: string;
  import_modules?: boolean;
  allow_ts_fallback?: boolean;
}

export interface ChannelPluginOptions {
  package_name: string;
  export_key?: string;
  constructor_args?: unknown[];
  required_permissions: readonly string[];
  action: string;
}

export interface SurfacePluginOptions {
  package_name: string;
  export_key?: string;
  required_permissions: readonly string[];
  action: string;
}

const CORE_PACKAGE = "@blue-tanuki/core";
const HDS_PACKAGE = "@blue-tanuki/hds-brain";

const BUILTIN_TOOL_PERMISSIONS = [
  "tool:echo",
  "tool:file.search",
  "fs:read",
  "tool:file.write",
  "tool:file.edit",
  "fs:write",
  "tool:http.fetch",
  "tool:web.search",
  "tool:github.read",
  "tool:github.write",
  "tool:gmail.read",
  "tool:google.calendar.read",
  "tool:google.drive.read",
  "tool:gmail.write",
  "tool:google.calendar.write",
  "tool:google.drive.write",
  "tool:composio.search",
  "tool:composio.execute",
  "tool:browser.read",
  "tool:browser.snapshot",
  "tool:browser.automation",
  "browser:snapshot",
  "browser:act",
  "tool:shell.exec",
  "network:http",
  "network:github.com",
  "network:googleapis.com",
  "network:composio.dev",
  "secrets:GITHUB_TOKEN",
  "secrets:COMPOSIO_API_KEY",
  "secrets:GOOGLE_ACCESS_TOKEN",
  "secrets:GMAIL_ACCESS_TOKEN",
  "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
  "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
  "google:gmail.read",
  "google:calendar.read",
  "google:drive.read",
  "google:gmail.write",
  "google:calendar.write",
  "google:drive.write",
  "external:send",
  "email:send",
  "github:issue.write",
  "github:pr.write",
  "github:comment.write",
  "shell:exec",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPackageJson(value: unknown, filepath: string): PackageJson {
  if (!isRecord(value)) {
    throw new Error(`${filepath}: package.json must be an object`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${filepath}: package.json name is required`);
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`${filepath}: package.json version is required`);
  }
  if (value.main !== undefined && typeof value.main !== "string") {
    throw new Error(`${filepath}: package.json main must be a string`);
  }
  return {
    name: value.name,
    version: value.version,
    main: value.main,
  };
}

function assertInside(parent: string, child: string, label: string): void {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label}: path escapes workspace/package boundary`);
  }
}

async function pathExists(filepath: string): Promise<boolean> {
  return await fs
    .stat(filepath)
    .then(() => true)
    .catch(() => false);
}

async function readPackageJson(packageDir: string): Promise<PackageJson> {
  const filepath = path.join(packageDir, "package.json");
  const raw = await fs.readFile(filepath, "utf8");
  return assertPackageJson(JSON.parse(raw) as unknown, filepath);
}

function validateManifestMetadata(
  packageDir: string,
  pkg: PackageJson,
  manifest: PluginManifest,
): void {
  if (manifest.name !== pkg.name) {
    throw new Error(
      `${packageDir}: manifest name mismatch (${manifest.name} != ${pkg.name})`,
    );
  }
  if (manifest.version !== pkg.version) {
    throw new Error(
      `${packageDir}: manifest version mismatch (${manifest.version} != ${pkg.version})`,
    );
  }
  if (manifest.entry !== "./dist/index.js") {
    throw new Error(`${packageDir}: manifest entry must be ./dist/index.js`);
  }
  if (pkg.main && manifest.entry !== pkg.main) {
    throw new Error(
      `${packageDir}: manifest entry mismatch with package.json main`,
    );
  }
}

export async function findWorkspaceRoot(start = path.dirname(fileURLToPath(import.meta.url))): Promise<string> {
  let cur = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (await pathExists(path.join(cur, "pnpm-workspace.yaml"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("plugin loader: pnpm-workspace.yaml not found");
}

export function parseWorkspacePackagePatterns(raw: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (!trimmed.startsWith("-")) {
      if (!line.startsWith(" ") && !line.startsWith("\t")) inPackages = false;
      continue;
    }
    const pattern = trimmed
      .replace(/^-\s*/, "")
      .replace(/^["']/, "")
      .replace(/["']$/, "")
      .trim();
    if (pattern.length > 0) patterns.push(pattern);
  }
  return patterns;
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, "/");
  if (!normalized.includes("*")) {
    const dir = path.resolve(root, normalized);
    assertInside(root, dir, `workspace pattern ${pattern}`);
    return (await pathExists(path.join(dir, "package.json"))) ? [dir] : [];
  }
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    throw new Error(`plugin loader: unsupported workspace pattern '${pattern}'`);
  }
  const base = path.resolve(root, normalized.slice(0, -2));
  assertInside(root, base, `workspace pattern ${pattern}`);
  const entries = await fs
    .readdir(base, { withFileTypes: true })
    .catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (await pathExists(path.join(dir, "package.json"))) {
      dirs.push(dir);
    }
  }
  return dirs.sort();
}

export async function discoverWorkspacePackageDirs(root: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = parseWorkspacePackagePatterns(raw);
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      dirs.add(path.resolve(dir));
    }
  }
  return Array.from(dirs).sort();
}

async function resolveManifestEntry(
  packageDir: string,
  manifest: PluginManifest,
  allowTsFallback: boolean,
): Promise<string> {
  const entry = path.resolve(packageDir, manifest.entry);
  assertInside(packageDir, entry, `${manifest.name} entry`);
  if (await pathExists(entry)) {
    return entry;
  }

  const fallback = path.resolve(packageDir, "src", "index.ts");
  if (
    allowTsFallback &&
    manifest.entry === "./dist/index.js" &&
    await pathExists(fallback)
  ) {
    return fallback;
  }
  throw new Error(`${manifest.name}: entry not found at ${entry}`);
}

async function importPluginModule(entry: string): Promise<PluginModule> {
  const importEntry = process.platform === "win32" ? await fs.realpath(entry) : entry;
  return await import(/* @vite-ignore */ pathToFileURL(importEntry).href) as PluginModule;
}

function verifyExportBindings(plugin: WorkspacePlugin): void {
  if (!plugin.module) return;
  for (const [key, exportName] of Object.entries(plugin.manifest.exports)) {
    if (typeof exportName !== "string") {
      throw new Error(
        `${plugin.manifest.name}: manifest export '${key}' must be a string`,
      );
    }
    if (exportName === "*") continue;
    if (!(exportName in plugin.module)) {
      throw new Error(
        `${plugin.manifest.name}: manifest export '${key}' points to missing '${exportName}'`,
      );
    }
  }
}

export async function loadWorkspacePlugins(
  opts: PluginRuntimeOptions = {},
): Promise<WorkspacePlugin[]> {
  const root = opts.root ? path.resolve(opts.root) : await findWorkspaceRoot();
  const packageDirs = await discoverWorkspacePackageDirs(root);
  const plugins: WorkspacePlugin[] = [];
  for (const packageDir of packageDirs) {
    assertInside(root, packageDir, "workspace package");
    const manifestPath = manifestPathFor(packageDir);
    if (!await pathExists(manifestPath)) continue;
    const pkg = await readPackageJson(packageDir);
    const manifest = await readManifest(manifestPath);
    validateManifestMetadata(packageDir, pkg, manifest);
    assertPluginReviewAccepted(
      await reviewPluginPackage(packageDir, {
        mode: "bundled",
        require_entry_exists: false,
      }),
    );
    const plugin: WorkspacePlugin = {
      package_dir: packageDir,
      package_json: pkg,
      manifest,
    };
    if (opts.import_modules !== false) {
      const entry = await resolveManifestEntry(
        packageDir,
        manifest,
        opts.allow_ts_fallback ?? true,
      );
      plugin.module = await importPluginModule(entry);
    }
    verifyExportBindings(plugin);
    plugins.push(plugin);
  }
  return plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export class PluginRuntime {
  private readonly byName = new Map<string, WorkspacePlugin>();

  constructor(readonly root: string, readonly plugins: readonly WorkspacePlugin[]) {
    for (const plugin of plugins) {
      if (this.byName.has(plugin.manifest.name)) {
        throw new Error(`plugin loader: duplicate plugin ${plugin.manifest.name}`);
      }
      this.byName.set(plugin.manifest.name, plugin);
    }
  }

  get(name: string): WorkspacePlugin {
    const plugin = this.byName.get(name);
    if (!plugin) {
      throw new Error(`plugin loader: missing required plugin ${name}`);
    }
    return plugin;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  permissionsFor(name: string): Set<string> {
    return new Set(this.get(name).manifest.permissions);
  }

  requirePermissions(
    packageName: string,
    required: readonly string[],
    action: string,
  ): void {
    const declared = this.permissionsFor(packageName);
    const missing = required.filter((permission) => !declared.has(permission));
    if (missing.length > 0) {
      throw new Error(
        `plugin permission denied: ${action} requires ${missing.join(", ")} ` +
          `but ${packageName} did not declare them`,
      );
    }
  }

  getExport(packageName: string, key: string): unknown {
    const plugin = this.get(packageName);
    if (!plugin.module) {
      throw new Error(`plugin loader: module not imported for ${packageName}`);
    }
    const exportName = plugin.manifest.exports[key] ?? plugin.manifest.exports.default;
    if (!exportName) {
      throw new Error(`${packageName}: manifest does not declare export '${key}'`);
    }
    if (exportName === "*") return plugin.module;
    const value = plugin.module[exportName];
    if (value === undefined) {
      throw new Error(`${packageName}: export '${exportName}' is missing`);
    }
    return value;
  }

  registerTools(registry: ToolRegistry): void {
    this.requirePermissions(
      CORE_PACKAGE,
      BUILTIN_TOOL_PERMISSIONS,
      "register built-in tools",
    );
    const register = this.getExport(CORE_PACKAGE, "tools");
    if (typeof register !== "function") {
      throw new Error(`${CORE_PACKAGE}: export 'tools' must be a register function`);
    }
    (register as (registry: ToolRegistry) => void)(registry);
  }

  createChannel<T>(opts: ChannelPluginOptions): T {
    this.requirePermissions(opts.package_name, opts.required_permissions, opts.action);
    const ctor = this.getExport(opts.package_name, opts.export_key ?? "channel");
    if (typeof ctor !== "function") {
      throw new Error(`${opts.package_name}: channel export must be a constructor`);
    }
    return new (ctor as new (...args: unknown[]) => T)(
      ...(opts.constructor_args ?? []),
    );
  }

  getSurface<T>(opts: SurfacePluginOptions): T {
    this.requirePermissions(opts.package_name, opts.required_permissions, opts.action);
    return this.getExport(opts.package_name, opts.export_key ?? "surface") as T;
  }

  enforceSessionConfig(env: Env): void {
    if (!env.BLUE_TANUKI_SESSION_DIR) return;
    this.requirePermissions(
      CORE_PACKAGE,
      ["fs:read:session_dir", "fs:write:session_dir", "fs:append:session_dir"],
      "configure BLUE_TANUKI_SESSION_DIR",
    );
  }

  enforceAuditConfig(env: Env): void {
    if (!env.BLUE_TANUKI_AUDIT_DIR) return;
    this.requirePermissions(
      HDS_PACKAGE,
      ["fs:append:audit_dir"],
      "configure BLUE_TANUKI_AUDIT_DIR",
    );
  }

  enforceLLMConfig(env: Env): void {
    const backend = envValue(env, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub";
    const hasProviderConfig = Boolean(
      envValue(
        env,
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_COMPAT_API_KEY",
        "LLM_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY_REF",
        "OPENAI_API_KEY_REF",
        "OPENAI_COMPAT_API_KEY_REF",
        "LLM_API_KEY_REF",
        "OPENROUTER_API_KEY_REF",
        "OPENROUTER_MODEL",
        "OPENAI_COMPAT_ENDPOINT",
        "OPENAI_ENDPOINT",
        "LLM_ENDPOINT",
        "LLM_PROVIDERS_JSON",
      ),
    );
    if (backend.trim().toLowerCase() !== "stub" || hasProviderConfig) {
      this.requirePermissions(
        CORE_PACKAGE,
        ["network:llm-provider"],
        "configure non-stub LLM provider",
      );
    }

    const baseSecretNames = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_COMPAT_API_KEY",
      "LLM_API_KEY",
      "OPENROUTER_API_KEY",
    ].filter((name) => envValue(env, name, `${name}_REF`));
    const metadataSecretNames = [
      "OPENAI_COMPAT_HEADERS_JSON",
      "LLM_HEADERS_JSON",
      "OPENROUTER_MODEL",
      "OPENROUTER_SITE_URL",
      "OPENROUTER_APP_TITLE",
    ].filter((name) => envValue(env, name));
    const secretNames = [
      ...baseSecretNames,
      ...metadataSecretNames,
    ];

    for (const name of providerSecretEnvNames(env)) {
      secretNames.push(name);
    }

    for (const name of Array.from(new Set(secretNames))) {
      this.requirePermissions(
        CORE_PACKAGE,
        [`secrets:${name}`],
        `read ${name}`,
      );
    }
  }
}

export async function loadPluginRuntime(
  opts: PluginRuntimeOptions = {},
): Promise<PluginRuntime> {
  const root = opts.root ? path.resolve(opts.root) : await findWorkspaceRoot();
  const plugins = await loadWorkspacePlugins({ ...opts, root });
  return new PluginRuntime(root, plugins);
}

function envValue(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function providerSecretEnvNames(env: Env): string[] {
  const raw = envValue(env, "LLM_PROVIDERS_JSON");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const rows =
    Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.providers)
      ? parsed.providers
      : [];
  const names: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (
      typeof row.api_key === "string" ||
      (isRecord(row.headers) && Object.keys(row.headers).length > 0)
    ) {
      names.push("LLM_PROVIDERS_JSON");
    }
    if (typeof row.api_key_env === "string" && row.api_key_env.length > 0) {
      names.push(row.api_key_env);
    }
    if (typeof row.headers_env === "string" && row.headers_env.length > 0) {
      names.push(row.headers_env);
    }
  }
  return names;
}
