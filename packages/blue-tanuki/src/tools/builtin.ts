import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import * as path from "node:path";
import { echoTool, type Tool } from "./registry.js";
import {
  gmailReadTool,
  googleCalendarReadTool,
  googleDriveReadTool,
} from "./google_read.js";
import {
  gmailWriteTool,
  googleCalendarWriteTool,
  googleDriveWriteTool,
} from "./google_write.js";
import {
  composioExecuteTool,
  composioSearchTool,
} from "./composio.js";
import {
  resolveFileSearchRoot,
  resolveSandboxFilePath,
  sandboxRootFromEnv,
  walkFiles,
} from "./file_safety.js";
import { shellExecTool } from "./shell_exec.js";
import type {
  BrowserAutomationAction,
  BrowserAutomationOptions,
  BrowserAutomationRunRequest,
  BrowserAutomationRunResult,
  BrowserAutomationRunner,
  BrowserReadOptions,
  BrowserSnapshotOptions,
  Env,
  FileSearchOptions,
  FileWriteOptions,
  GitHubReadOptions,
  GitHubReadResponse,
  GitHubReadTarget,
  GitHubWriteMethod,
  GitHubWriteOptions,
  GitHubWriteResponse,
  GitHubWriteTarget,
  HttpFetchOptions,
  HttpFetchResponse,
  HttpFetchTarget,
  ResolvedAddress,
  WebSearchOptions,
  WebSearchResult,
} from "./builtin_types.js";
export type {
  BrowserAutomationAction,
  BrowserAutomationOptions,
  BrowserAutomationRunRequest,
  BrowserAutomationRunResult,
  BrowserAutomationRunner,
  BrowserReadOptions,
  BrowserSnapshotOptions,
  Env,
  FileSearchOptions,
  FileWriteOptions,
  GitHubReadOptions,
  GitHubReadResponse,
  GitHubReadTarget,
  GitHubWriteMethod,
  GitHubWriteOptions,
  GitHubWriteResponse,
  GitHubWriteTarget,
  HttpFetchOptions,
  HttpFetchResponse,
  HttpFetchTarget,
  ResolvedAddress,
  WebSearchOptions,
  WebSearchResult,
} from "./builtin_types.js";
export {
  invokeShellExec,
  shellExecTool,
  type ShellExecOptions,
} from "./shell_exec.js";
export {
  buildGoogleDailyBriefContent,
  gmailReadTool,
  googleCalendarReadTool,
  googleDriveReadTool,
  invokeGmailRead,
  invokeGoogleCalendarRead,
  invokeGoogleDriveRead,
  type GmailReadMessage,
  type GoogleCalendarEvent,
  type GoogleDailyBriefOptions,
  type GoogleDriveFile,
  type GoogleReadOptions,
  type GoogleReadResponse,
  type GoogleReadService,
  type GoogleReadTarget,
} from "./google_read.js";
export {
  gmailWriteTool,
  googleCalendarWriteTool,
  googleDriveWriteTool,
  invokeGmailWrite,
  invokeGoogleCalendarWrite,
  invokeGoogleDriveWrite,
  type GoogleWriteMethod,
  type GoogleWriteOptions,
  type GoogleWriteResponse,
  type GoogleWriteService,
  type GoogleWriteTarget,
} from "./google_write.js";

const HTTP_REDIRECT_LIMIT = 3;
const HTTP_FETCH_TIMEOUT_MS = 15_000;
const BROWSER_AUTOMATION_ENABLE_ENV = "BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW";
const BROWSER_AUTOMATION_TIMEOUT_MS = 15_000;
const BROWSER_AUTOMATION_MAX_CHARS = 20_000;
const BROWSER_AUTOMATION_VIEWPORT = { width: 1280, height: 720 } as const;
const BLOCKED_IPS = new BlockList();

for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) {
  BLOCKED_IPS.addSubnet(address, prefix, type);
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`${name} must be a non-empty string`);
  return undefined;
}

function positiveIntArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, max);
}

function requiredPositiveIntArg(
  args: Record<string, unknown>,
  name: string,
  max: number,
): number {
  if (args[name] === undefined) {
    throw new Error(`${name} must be a positive integer`);
  }
  return positiveIntArg(args, name, 1, max);
}

function safeProcessEnv(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "Path",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name]) out[name] = process.env[name];
  }
  return out;
}

function parseHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("url credentials are not allowed");
  }
  return url;
}

function hostnameFor(url: URL): string {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (hostname.length === 0) throw new Error("url hostname is required");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("http.fetch denied localhost target");
  }
  return hostname;
}

function enforceHttpAllowlist(hostname: string, env: Env): void {
  const raw = env.BLUE_TANUKI_HTTP_ALLOWLIST;
  if (!raw || raw.trim().length === 0) return;
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return;
  const allowed = entries.some((entry) => {
    const suffix = entry.startsWith(".") ? entry.slice(1) : entry;
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!allowed) {
    throw new Error(`http.fetch denied host outside BLUE_TANUKI_HTTP_ALLOWLIST: ${hostname}`);
  }
}

function ipv4FromMappedIPv6(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1];
}

function assertPublicAddress(hostname: string, resolved: ResolvedAddress): void {
  const mapped = ipv4FromMappedIPv6(resolved.address);
  if (mapped) {
    assertPublicAddress(hostname, { address: mapped, family: 4 });
    return;
  }
  if (resolved.address.toLowerCase().startsWith("::ffff:")) {
    throw new Error(
      `http.fetch denied non-public address for ${hostname}: ${resolved.address}`,
    );
  }
  const detected = isIP(resolved.address);
  if (detected !== resolved.family) {
    throw new Error(`http.fetch could not validate resolved address for ${hostname}`);
  }
  const type = resolved.family === 6 ? "ipv6" : "ipv4";
  if (BLOCKED_IPS.check(resolved.address, type)) {
    throw new Error(
      `http.fetch denied non-public address for ${hostname}: ${resolved.address}`,
    );
  }
}

async function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error(`http.fetch unsupported address family for ${hostname}`);
    }
    return { address: record.address, family: record.family };
  });
}

async function resolvePublicTarget(
  url: URL,
  env: Env,
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<HttpFetchTarget> {
  const hostname = hostnameFor(url);
  enforceHttpAllowlist(hostname, env);
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) {
    throw new Error(`http.fetch DNS lookup returned no addresses for ${hostname}`);
  }
  for (const address of addresses) {
    assertPublicAddress(hostname, address);
  }
  const selected = addresses[0]!;
  return {
    url,
    hostname,
    address: selected.address,
    family: selected.family,
  };
}

function hostHeaderFor(url: URL): string {
  const defaultPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443");
  return defaultPort ? url.hostname : url.host;
}

function headerString(value: string | string[] | number | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "number") return String(value);
  return value ?? null;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function browserAutomationEnabled(env: Env): boolean {
  return env[BROWSER_AUTOMATION_ENABLE_ENV] === "1";
}

function browserAutomationDisabledError(): Error {
  return new Error(
    `${BROWSER_AUTOMATION_ENABLE_ENV}=1 is required for browser automation preview; ` +
      "preview_enabled=false; mutation_sent=false; safe_to_ignore=true",
  );
}

function browserAutomationAction(args: Record<string, unknown>): BrowserAutomationAction {
  const raw = (stringArg(args, "action", false) ?? "navigate").toLowerCase();
  if (
    raw === "smoke" ||
    raw === "navigate" ||
    raw === "click" ||
    raw === "form_submit" ||
    raw === "download" ||
    raw === "upload"
  ) {
    return raw;
  }
  throw new Error("action must be smoke, navigate, click, form_submit, download, or upload");
}

function assertNoBrowserCredentialUse(args: Record<string, unknown>): void {
  for (const key of [
    "credentials",
    "credential",
    "cookies",
    "headers",
    "extra_headers",
    "storage_state",
  ]) {
    if (args[key] !== undefined) {
      throw new Error(
        `browser automation preview does not accept ${key}; credential_usage=denied; mutation_sent=false`,
      );
    }
  }
  const useCredentials = args.use_credentials;
  if (
    useCredentials === true ||
    (typeof useCredentials === "string" && useCredentials.toLowerCase() === "true")
  ) {
    throw new Error(
      "browser automation preview does not support credential usage; credential_usage=denied; mutation_sent=false",
    );
  }
}

function browserAutomationSmoke(env: Env): unknown {
  const enabled = browserAutomationEnabled(env);
  return {
    preview: "browser.automation",
    enabled,
    status: enabled ? "ready" : "skipped",
    safe_to_ignore: !enabled,
    reason: enabled
      ? "browser automation preview is explicitly enabled"
      : `${BROWSER_AUTOMATION_ENABLE_ENV}=1 is not set`,
    next_action: enabled
      ? "Run a targeted browser.snapshot or browser.automation request."
      : `Set ${BROWSER_AUTOMATION_ENABLE_ENV}=1 only in an operator-controlled preview environment.`,
  };
}

function webSearchEndpointUrl(
  endpoint: string,
  query: string,
  maxResults: number,
): string {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    throw new Error("BLUE_TANUKI_WEB_SEARCH_ENDPOINT must be a non-empty URL");
  }
  if (trimmed.includes("{query}") || trimmed.includes("{max_results}")) {
    return trimmed
      .replaceAll("{query}", encodeURIComponent(query))
      .replaceAll("{max_results}", String(maxResults));
  }
  const url = new URL(trimmed);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  return url.href;
}

function arrayCandidate(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function resultArrayFromJson(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return (
    arrayCandidate(record.results) ??
    arrayCandidate(record.items) ??
    arrayCandidate(record.organic_results) ??
    arrayCandidate((record.web as Record<string, unknown> | undefined)?.results) ??
    arrayCandidate((record.webPages as Record<string, unknown> | undefined)?.value) ??
    null
  );
}

function coerceWebSearchResult(value: unknown): WebSearchResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const title =
    optionalString(record.title) ??
    optionalString(record.name) ??
    optionalString(record.heading) ??
    "Untitled result";
  const url =
    optionalString(record.url) ??
    optionalString(record.link) ??
    optionalString(record.href);
  const snippet =
    optionalString(record.snippet) ??
    optionalString(record.description) ??
    optionalString(record.summary) ??
    optionalString(record.content) ??
    optionalString(record.text) ??
    "";
  if (!url && !snippet && title === "Untitled result") return null;
  return {
    title: truncateText(title, 160),
    url,
    snippet: truncateText(snippet, 600),
  };
}

function parseWebSearchResults(body: string, maxResults: number): WebSearchResult[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    const entries = resultArrayFromJson(parsed);
    if (entries) {
      return entries
        .map(coerceWebSearchResult)
        .filter((entry): entry is WebSearchResult => entry !== null)
        .slice(0, maxResults);
    }
  } catch {
    // Fall through to bounded text fallback below.
  }
  const text = body.trim();
  if (!text) return [];
  return [
    {
      title: "Raw search response",
      url: null,
      snippet: truncateText(text.replace(/\s+/g, " "), 600),
    },
  ];
}

function githubNameArg(args: Record<string, unknown>, name: string): string {
  const value = stringArg(args, name)!;
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return value;
}

function githubResource(args: Record<string, unknown>): string {
  return (stringArg(args, "resource", false) ?? "repo").toLowerCase();
}

function githubOperation(args: Record<string, unknown>): string {
  return (stringArg(args, "operation")!).toLowerCase();
}

function githubState(args: Record<string, unknown>): "open" | "closed" | "all" {
  const state = (stringArg(args, "state", false) ?? "open").toLowerCase();
  if (state !== "open" && state !== "closed" && state !== "all") {
    throw new Error("state must be open, closed, or all");
  }
  return state;
}

function githubPath(args: Record<string, unknown>): { resource: string; path: string } {
  const owner = encodeURIComponent(githubNameArg(args, "owner"));
  const repo = encodeURIComponent(githubNameArg(args, "repo"));
  const resource = githubResource(args);
  if (resource === "repo") {
    return { resource, path: `/repos/${owner}/${repo}` };
  }
  if (resource === "issue") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    return { resource, path: `/repos/${owner}/${repo}/issues/${number}` };
  }
  if (resource === "issues") {
    const state = githubState(args);
    const perPage = positiveIntArg(args, "max_results", 10, 100);
    return {
      resource,
      path: `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`,
    };
  }
  if (resource === "pr" || resource === "pull" || resource === "pull_request") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    return { resource: "pr", path: `/repos/${owner}/${repo}/pulls/${number}` };
  }
  if (resource === "prs" || resource === "pulls" || resource === "pull_requests") {
    const state = githubState(args);
    const perPage = positiveIntArg(args, "max_results", 10, 100);
    return {
      resource: "prs",
      path: `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
    };
  }
  throw new Error("resource must be repo, issue, issues, pr, or prs");
}

function githubBoolArg(
  args: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  throw new Error(`${name} must be true or false`);
}

function githubOptionalBody(args: Record<string, unknown>): string | undefined {
  return stringArg(args, "body", false);
}

function githubWriteRoute(args: Record<string, unknown>): {
  operation: string;
  method: GitHubWriteMethod;
  path: string;
  body: Record<string, unknown>;
  repo: string;
} {
  const owner = githubNameArg(args, "owner");
  const repoName = githubNameArg(args, "repo");
  const ownerPath = encodeURIComponent(owner);
  const repoPath = encodeURIComponent(repoName);
  const repo = `${owner}/${repoName}`;
  const operation = githubOperation(args);

  if (operation === "issue.create") {
    const body: Record<string, unknown> = {
      title: stringArg(args, "title")!,
    };
    const issueBody = githubOptionalBody(args);
    if (issueBody !== undefined) body.body = issueBody;
    return {
      operation,
      method: "POST",
      path: `/repos/${ownerPath}/${repoPath}/issues`,
      body,
      repo,
    };
  }

  if (operation === "issue.comment.create" || operation === "pr.comment.create") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    return {
      operation,
      method: "POST",
      path: `/repos/${ownerPath}/${repoPath}/issues/${number}/comments`,
      body: { body: stringArg(args, "body")! },
      repo,
    };
  }

  if (operation === "issue.update") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    const body: Record<string, unknown> = {};
    const title = stringArg(args, "title", false);
    const issueBody = githubOptionalBody(args);
    if (title !== undefined) body.title = title;
    if (issueBody !== undefined) body.body = issueBody;
    if (Object.keys(body).length === 0) {
      throw new Error("issue.update requires title or body; close/reopen is deferred");
    }
    return {
      operation,
      method: "PATCH",
      path: `/repos/${ownerPath}/${repoPath}/issues/${number}`,
      body,
      repo,
    };
  }

  if (operation === "pr.create") {
    const body: Record<string, unknown> = {
      title: stringArg(args, "title")!,
      head: stringArg(args, "head")!,
      base: stringArg(args, "base")!,
      draft: githubBoolArg(args, "draft", false),
    };
    const prBody = githubOptionalBody(args);
    if (prBody !== undefined) body.body = prBody;
    if (args.maintainer_can_modify !== undefined) {
      body.maintainer_can_modify = githubBoolArg(args, "maintainer_can_modify", true);
    }
    return {
      operation,
      method: "POST",
      path: `/repos/${ownerPath}/${repoPath}/pulls`,
      body,
      repo,
    };
  }

  throw new Error(
    "operation must be issue.create, issue.comment.create, issue.update, pr.create, or pr.comment.create",
  );
}

function githubWriteToken(env: Env): string {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for github.write; mutation_sent=false");
  }
  return token;
}

function githubAllowedRepos(env: Env): Set<string> {
  const raw = env.BLUE_TANUKI_GITHUB_REPOS?.trim();
  if (!raw) {
    throw new Error("BLUE_TANUKI_GITHUB_REPOS is required for github.write; mutation_sent=false");
  }
  const repos = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (repos.length === 0) {
    throw new Error("BLUE_TANUKI_GITHUB_REPOS must list at least one owner/repo; mutation_sent=false");
  }
  for (const repo of repos) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
      throw new Error(`invalid BLUE_TANUKI_GITHUB_REPOS entry: ${repo}; mutation_sent=false`);
    }
  }
  return new Set(repos);
}

function assertGitHubRepoAllowed(env: Env, repo: string): void {
  const allowed = githubAllowedRepos(env);
  if (!allowed.has(repo.toLowerCase())) {
    throw new Error(
      `github.write denied repository ${repo}; mutation_sent=false; next_action=add ${repo} to BLUE_TANUKI_GITHUB_REPOS if intended`,
    );
  }
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return "[undefined]";
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => normalize(item));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function githubResultSummary(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { value_type: typeof value };
  }
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "node_id", "number", "state", "title", "html_url", "url"] as const) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return summary;
}

function parseJsonOrText(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[lower] ?? "";
  });
}

function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1]!.replace(/\s+/g, " ").trim());
  return title.length > 0 ? truncateText(title, 240) : null;
}

function htmlToText(html: string, maxChars: number): string {
  const text = decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return truncateText(text, maxChars);
}

function htmlLinks(html: string, baseUrl: string, maxLinks: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) {
      continue;
    }
    try {
      const href = new URL(decodeHtmlEntities(raw), baseUrl);
      if (href.protocol !== "http:" && href.protocol !== "https:") continue;
      const normalized = href.href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= maxLinks) break;
    } catch {
      continue;
    }
  }
  return out;
}

async function defaultHttpRequest(
  target: HttpFetchTarget,
  method: "GET" | "HEAD",
  maxBytes: number,
): Promise<HttpFetchResponse> {
  return await new Promise((resolve, reject) => {
    const url = target.url;
    const requestFn = url.protocol === "https:" ? https.request : http.request;
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, target.address, target.family);
    };
    let finished = false;
    const finish = (result: HttpFetchResponse): void => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: target.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Host: hostHeaderFor(url),
        },
        lookup,
        servername: target.hostname,
        timeout: HTTP_FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerString(res.headers["content-type"]);
        const location = headerString(res.headers.location);
        if (method === "HEAD") {
          res.resume();
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            location,
            body: "",
            truncated: false,
          });
          return;
        }

        const chunks: Buffer[] = [];
        let seenBytes = 0;
        let keptBytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer | string) => {
          if (finished) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          seenBytes += buf.length;
          if (keptBytes < maxBytes) {
            const keep = buf.subarray(0, maxBytes - keptBytes);
            chunks.push(keep);
            keptBytes += keep.length;
          }
          if (seenBytes >= maxBytes) {
            truncated = true;
            res.destroy();
            finish({
              status,
              ok: status >= 200 && status < 300,
              content_type: contentType,
              location,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
            });
          }
        });
        res.on("end", () => {
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            location,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        });
        res.on("error", (error) => {
          if (!finished) fail(error);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`http.fetch timed out after ${HTTP_FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    req.end();
  });
}

async function defaultGitHubReadRequest(
  target: GitHubReadTarget,
): Promise<GitHubReadResponse> {
  return await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (result: GitHubReadResponse): void => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.github.com",
        path: target.path,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "BLUE-TANUKI/0.1 github.read",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: HTTP_FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerString(res.headers["content-type"]);
        const rateLimitRemaining = headerString(res.headers["x-ratelimit-remaining"]);
        const chunks: Buffer[] = [];
        let seenBytes = 0;
        let keptBytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer | string) => {
          if (finished) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          seenBytes += buf.length;
          if (keptBytes < target.maxBytes) {
            const keep = buf.subarray(0, target.maxBytes - keptBytes);
            chunks.push(keep);
            keptBytes += keep.length;
          }
          if (seenBytes >= target.maxBytes) {
            truncated = true;
            res.destroy();
            finish({
              status,
              ok: status >= 200 && status < 300,
              content_type: contentType,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
              rate_limit_remaining: rateLimitRemaining,
            });
          }
        });
        res.on("end", () => {
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
            rate_limit_remaining: rateLimitRemaining,
          });
        });
        res.on("error", (error) => {
          if (!finished) fail(error);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`github.read timed out after ${HTTP_FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    req.end();
  });
}

async function defaultGitHubWriteRequest(
  target: GitHubWriteTarget,
): Promise<GitHubWriteResponse> {
  return await new Promise((resolve, reject) => {
    const requestBody = Buffer.from(JSON.stringify(target.body), "utf8");
    let finished = false;
    const finish = (result: GitHubWriteResponse): void => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.github.com",
        path: target.path,
        method: target.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
          "Content-Length": String(requestBody.length),
          "User-Agent": "BLUE-TANUKI/0.1 github.write",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: HTTP_FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerString(res.headers["content-type"]);
        const rateLimitRemaining = headerString(res.headers["x-ratelimit-remaining"]);
        const requestId = headerString(res.headers["x-github-request-id"]);
        const chunks: Buffer[] = [];
        let seenBytes = 0;
        let keptBytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer | string) => {
          if (finished) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          seenBytes += buf.length;
          if (keptBytes < target.maxBytes) {
            const keep = buf.subarray(0, target.maxBytes - keptBytes);
            chunks.push(keep);
            keptBytes += keep.length;
          }
          if (seenBytes >= target.maxBytes) {
            truncated = true;
            res.destroy();
            finish({
              status,
              ok: status >= 200 && status < 300,
              content_type: contentType,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
              rate_limit_remaining: rateLimitRemaining,
              request_id: requestId,
            });
          }
        });
        res.on("end", () => {
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
            rate_limit_remaining: rateLimitRemaining,
            request_id: requestId,
          });
        });
        res.on("error", (error) => {
          if (!finished) fail(error);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`github.write timed out after ${HTTP_FETCH_TIMEOUT_MS}ms; mutation_status=not_confirmed`));
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    req.write(requestBody);
    req.end();
  });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

export async function invokeHttpFetch(
  args: Record<string, unknown>,
  opts: HttpFetchOptions = {},
): Promise<unknown> {
  const rawUrl = stringArg(args, "url")!;
  const method = (stringArg(args, "method", false) ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("method must be GET or HEAD");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", 64_000, 512_000);
  const env = opts.env ?? process.env;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const request = opts.request ?? defaultHttpRequest;
  let url = parseHttpUrl(rawUrl);

  for (let redirects = 0; ; redirects += 1) {
    const target = await resolvePublicTarget(url, env, resolveHost);
    const res = await request(target, method, maxBytes);
    if (isRedirect(res.status) && res.location) {
      if (redirects >= HTTP_REDIRECT_LIMIT) {
        throw new Error(`http.fetch redirect limit exceeded (${HTTP_REDIRECT_LIMIT})`);
      }
      url = parseHttpUrl(new URL(res.location, url).href);
      continue;
    }
    return {
      url: url.href,
      status: res.status,
      ok: res.ok,
      content_type: res.content_type,
      body: res.body,
      truncated: res.truncated,
    };
  }
}

export async function invokeWebSearch(
  args: Record<string, unknown>,
  opts: WebSearchOptions = {},
): Promise<unknown> {
  const query = stringArg(args, "query")!;
  const maxResults = positiveIntArg(args, "max_results", 5, 20);
  const maxBytes = positiveIntArg(args, "max_bytes", 64_000, 512_000);
  const env = opts.env ?? process.env;
  const endpoint = env.BLUE_TANUKI_WEB_SEARCH_ENDPOINT;
  if (!endpoint) {
    throw new Error("BLUE_TANUKI_WEB_SEARCH_ENDPOINT is required for web.search");
  }
  const url = webSearchEndpointUrl(endpoint, query, maxResults);
  const fetched = (await invokeHttpFetch(
    { url, method: "GET", max_bytes: maxBytes },
    opts,
  )) as {
    url: string;
    status: number;
    ok: boolean;
    content_type: string | null;
    body: string;
    truncated: boolean;
  };
  if (!fetched.ok) {
    throw new Error(`web.search provider returned HTTP ${fetched.status}`);
  }
  return {
    query,
    endpoint: fetched.url,
    status: fetched.status,
    content_type: fetched.content_type,
    truncated: fetched.truncated,
    results: parseWebSearchResults(fetched.body, maxResults),
  };
}

export async function invokeGitHubRead(
  args: Record<string, unknown>,
  opts: GitHubReadOptions = {},
): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const route = githubPath(args);
  const request = opts.request ?? defaultGitHubReadRequest;
  const response = await request({
    path: route.path,
    maxBytes,
  });
  if (!response.ok) {
    throw new Error(`github.read returned HTTP ${response.status}`);
  }
  return {
    resource: route.resource,
    api_host: "api.github.com",
    path: route.path,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    data: parseJsonOrText(response.body),
  };
}

export async function invokeGitHubWrite(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const request = opts.request ?? defaultGitHubWriteRequest;
  const response = await request({
    method: route.method,
    path: route.path,
    body: route.body,
    maxBytes,
    token,
  });
  const data = parseJsonOrText(response.body);
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && !Array.isArray(data)
      ? optionalString((data as Record<string, unknown>).message)
      : null;
    throw new Error(
      `github.write returned HTTP ${response.status}; mutation_status=not_confirmed; next_action=check GitHub/audit before retrying${message ? `; message=${message}` : ""}`,
    );
  }
  return {
    operation: route.operation,
    api_host: "api.github.com",
    repo: route.repo,
    method: route.method,
    path: route.path,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: githubResultSummary(data),
  };
}

export async function invokeBrowserRead(
  args: Record<string, unknown>,
  opts: BrowserReadOptions = {},
): Promise<unknown> {
  const url = stringArg(args, "url")!;
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 512_000);
  const maxChars = positiveIntArg(args, "max_chars", 8_000, 50_000);
  const fetched = (await invokeHttpFetch(
    { url, method: "GET", max_bytes: maxBytes },
    opts,
  )) as {
    url: string;
    status: number;
    ok: boolean;
    content_type: string | null;
    body: string;
    truncated: boolean;
  };
  if (!fetched.ok) {
    throw new Error(`browser.read returned HTTP ${fetched.status}`);
  }
  const body = fetched.body;
  const isHtml =
    fetched.content_type === null ||
    fetched.content_type.toLowerCase().includes("html") ||
    /<\/?[a-z][\s\S]*>/i.test(body);
  const text = isHtml
    ? htmlToText(body, maxChars)
    : truncateText(body.replace(/\s+/g, " ").trim(), maxChars);
  return {
    url: fetched.url,
    status: fetched.status,
    content_type: fetched.content_type,
    title: isHtml ? htmlTitle(body) : null,
    text,
    links: isHtml ? htmlLinks(body, fetched.url, 20) : [],
    truncated: fetched.truncated || text.length >= maxChars,
  };
}

interface PlaywrightLike {
  chromium?: {
    launch(options: Record<string, unknown>): Promise<BrowserLike>;
  };
}

interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  route?(
    pattern: string,
    handler: (route: RouteLike, request: RequestLike) => Promise<void>,
  ): Promise<void>;
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  url(): string;
}

interface RouteLike {
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface RequestLike {
  url(): string;
}

async function importPlaywright(): Promise<PlaywrightLike> {
  try {
    const specifier = "playwright";
    const imported = await import(specifier);
    if (!isRecord(imported)) {
      throw new Error("playwright module did not load as an object");
    }
    return imported as PlaywrightLike;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      "browser automation preview engine unavailable; mutation_sent=false; " +
        "next_action=install Playwright in a preview environment or keep the preview disabled; " +
        `reason=${reason}`,
    );
  }
}

async function defaultBrowserAutomationRunner(
  request: BrowserAutomationRunRequest,
): Promise<BrowserAutomationRunResult> {
  const playwright = await importPlaywright();
  if (!playwright.chromium?.launch) {
    throw new Error("browser automation preview requires Playwright chromium; mutation_sent=false");
  }

  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      env: safeProcessEnv(),
    });
    context = await browser.newContext({
      viewport: { ...BROWSER_AUTOMATION_VIEWPORT },
      acceptDownloads: false,
    });
    const page = await context.newPage();
    if (page.route) {
      await page.route("**/*", async (route, browserRequest) => {
        try {
          const requestUrl = browserRequest.url();
          await resolvePublicTarget(
            parseHttpUrl(requestUrl),
            request.env,
            request.resolveHost,
          );
          await route.continue();
        } catch {
          await route.abort();
        }
      });
    }
    await page.goto(request.url, {
      waitUntil: "domcontentloaded",
      timeout: request.timeout_ms,
    });
    const finalUrl = page.url();
    await resolvePublicTarget(
      parseHttpUrl(finalUrl),
      request.env,
      request.resolveHost,
    );
    const title = await page.title();
    const bodyText = await page.evaluate("document.body ? document.body.innerText : ''");
    const text = typeof bodyText === "string" ? bodyText.replace(/\s+/g, " ").trim() : "";
    return {
      engine: "playwright.chromium",
      final_url: finalUrl,
      title: title.trim().length > 0 ? title : null,
      text: truncateText(text, request.max_chars),
      truncated: text.length > request.max_chars,
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export async function invokeBrowserSnapshot(
  args: Record<string, unknown>,
  opts: BrowserSnapshotOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  if (!browserAutomationEnabled(env)) {
    throw browserAutomationDisabledError();
  }
  assertNoBrowserCredentialUse(args);

  const url = parseHttpUrl(stringArg(args, "url")!);
  const maxChars = positiveIntArg(
    args,
    "max_chars",
    8_000,
    BROWSER_AUTOMATION_MAX_CHARS,
  );
  const timeoutMs = positiveIntArg(
    args,
    "timeout_ms",
    BROWSER_AUTOMATION_TIMEOUT_MS,
    BROWSER_AUTOMATION_TIMEOUT_MS,
  );
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const target = await resolvePublicTarget(url, env, resolveHost);
  const runner = opts.runner ?? defaultBrowserAutomationRunner;
  const snapshot = await runner({
    action: "snapshot",
    url: url.href,
    target,
    timeout_ms: timeoutMs,
    max_chars: maxChars,
    env,
    resolveHost,
  });

  return {
    preview: "browser.automation",
    enabled: true,
    action: "snapshot",
    engine: snapshot.engine,
    url: url.href,
    final_url: snapshot.final_url,
    title: snapshot.title,
    text: truncateText(snapshot.text, maxChars),
    truncated: snapshot.truncated || snapshot.text.length > maxChars,
    sandbox: {
      persistent_profile: false,
      downloads: "disabled",
      credential_reuse: false,
    },
    network_policy: {
      protocol: url.protocol.replace(":", ""),
      host: target.hostname,
      allowlist_configured: Boolean(env.BLUE_TANUKI_HTTP_ALLOWLIST?.trim()),
      ssrf_guard: "public_address_required",
    },
    resource_limits: {
      timeout_ms: timeoutMs,
      max_chars: maxChars,
      viewport: BROWSER_AUTOMATION_VIEWPORT,
    },
  };
}

export async function invokeBrowserAutomation(
  args: Record<string, unknown>,
  opts: BrowserAutomationOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const action = browserAutomationAction(args);
  if (action === "smoke") {
    return browserAutomationSmoke(env);
  }
  if (!browserAutomationEnabled(env)) {
    throw browserAutomationDisabledError();
  }
  assertNoBrowserCredentialUse(args);

  if (action !== "navigate") {
    throw new Error(
      `browser.automation action ${action} is preview-quarantined and not implemented; ` +
        "approval_level=L3_final_review; mutation_sent=false",
    );
  }

  const snapshot = await invokeBrowserSnapshot(args, opts);
  if (isRecord(snapshot)) {
    return {
      ...snapshot,
      action,
      approval_level: "L3_final_review",
    };
  }
  return snapshot;
}

export async function invokeFileSearch(
  args: Record<string, unknown>,
  opts: FileSearchOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const root = await resolveFileSearchRoot(stringArg(args, "root")!, sandboxRoot);
  const query = stringArg(args, "query")!;
  const maxResults = positiveIntArg(args, "max_results", 20, 100);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("root must be a directory");
  }

  const matches: Array<{ path: string; line_number: number; line: string }> = [];
  let visited = 0;
  for await (const file of walkFiles(root, sandboxRoot)) {
    if (matches.length >= maxResults || visited >= 1_000) break;
    visited += 1;
    const data = await fs.readFile(file);
    if (data.includes(0)) continue;
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes(query)) {
        matches.push({
          path: path.relative(root, file).replace(/\\/g, "/"),
          line_number: i + 1,
          line: line.length > 240 ? `${line.slice(0, 237)}...` : line,
        });
        if (matches.length >= maxResults) break;
      }
    }
  }

  return {
    root,
    sandbox_root: sandboxRoot,
    query,
    visited_files: visited,
    matches,
  };
}

export async function invokeFileWrite(
  args: Record<string, unknown>,
  opts: FileWriteOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const { filepath, relative_path } = await resolveSandboxFilePath(
    stringArg(args, "path")!,
    sandboxRoot,
  );
  const content = stringArg(args, "content")!;
  const modeRaw = stringArg(args, "mode", false) ?? "create";
  if (modeRaw !== "create" && modeRaw !== "overwrite" && modeRaw !== "append") {
    throw new Error("mode must be create, overwrite, or append");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 1_000_000);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`file.write content exceeds max_bytes (${bytes} > ${maxBytes})`);
  }

  if (modeRaw === "create") {
    await fs.writeFile(filepath, content, { encoding: "utf8", flag: "wx" });
  } else if (modeRaw === "overwrite") {
    await fs.writeFile(filepath, content, { encoding: "utf8", flag: "w" });
  } else {
    await fs.appendFile(filepath, content, { encoding: "utf8" });
  }

  return {
    path: relative_path,
    sandbox_root: sandboxRoot,
    mode: modeRaw,
    bytes_written: bytes,
  };
}

export async function invokeFileEdit(
  args: Record<string, unknown>,
  opts: FileWriteOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const { filepath, relative_path } = await resolveSandboxFilePath(
    stringArg(args, "path")!,
    sandboxRoot,
  );
  const search = stringArg(args, "search")!;
  const replace = stringArg(args, "replace")!;
  if (search === replace) {
    throw new Error("search and replace must differ");
  }
  const expectedReplacements = positiveIntArg(
    args,
    "expected_replacements",
    1,
    100,
  );
  const maxBytes = positiveIntArg(args, "max_bytes", 512_000, 1_000_000);

  const beforeBuffer = await fs.readFile(filepath);
  if (beforeBuffer.includes(0)) {
    throw new Error("file.edit refuses binary-looking files");
  }
  if (beforeBuffer.length > maxBytes) {
    throw new Error(`file.edit input exceeds max_bytes (${beforeBuffer.length} > ${maxBytes})`);
  }
  const before = beforeBuffer.toString("utf8");
  const parts = before.split(search);
  const replacements = parts.length - 1;
  if (replacements !== expectedReplacements) {
    throw new Error(
      `file.edit expected ${expectedReplacements} replacement(s), found ${replacements}`,
    );
  }
  const after = parts.join(replace);
  const afterBytes = Buffer.byteLength(after, "utf8");
  if (afterBytes > maxBytes) {
    throw new Error(`file.edit output exceeds max_bytes (${afterBytes} > ${maxBytes})`);
  }
  await fs.writeFile(filepath, after, { encoding: "utf8", flag: "w" });
  return {
    path: relative_path,
    sandbox_root: sandboxRoot,
    replacements,
    bytes_written: afterBytes,
  };
}

export const fileSearchTool: Tool = {
  name: "file.search",
  description: "Read-only text search under a requested root directory.",
  required_capabilities: ["tool:file.search", "fs:read"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeFileSearch(args);
  },
};

export const fileWriteTool: Tool = {
  name: "file.write",
  description: "Create, overwrite, or append a UTF-8 file under BLUE_TANUKI_FILE_ROOT.",
  required_capabilities: ["tool:file.write", "fs:write"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeFileWrite(args);
  },
};

export const fileEditTool: Tool = {
  name: "file.edit",
  description: "Perform an exact UTF-8 text replacement under BLUE_TANUKI_FILE_ROOT.",
  required_capabilities: ["tool:file.edit", "fs:read", "fs:write"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeFileEdit(args);
  },
};

export const httpFetchTool: Tool = {
  name: "http.fetch",
  description: "GET or HEAD an HTTP(S) URL and return a bounded response body.",
  required_capabilities: ["tool:http.fetch", "network:http"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeHttpFetch(args);
  },
};

export const webSearchTool: Tool = {
  name: "web.search",
  description: "Provider-neutral web search via BLUE_TANUKI_WEB_SEARCH_ENDPOINT.",
  required_capabilities: ["tool:web.search", "network:http"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeWebSearch(args);
  },
};

export const githubReadTool: Tool = {
  name: "github.read",
  description: "Read public GitHub repo, issue, and pull request metadata from api.github.com.",
  required_capabilities: ["tool:github.read", "network:github.com"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGitHubRead(args);
  },
};

export const githubWriteTool: Tool = {
  name: "github.write",
  description: "Create/update GitHub issues, pull requests, and comments on allowlisted repositories.",
  required_capabilities: [
    "tool:github.write",
    "network:github.com",
    "secrets:GITHUB_TOKEN",
    "github:issue.write",
    "github:pr.write",
    "github:comment.write",
  ],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGitHubWrite(args);
  },
};

export const browserReadTool: Tool = {
  name: "browser.read",
  description: "Fetch a public web page through the SSRF guard and extract bounded readable text.",
  required_capabilities: ["tool:browser.read", "network:http"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeBrowserRead(args);
  },
};

export const browserSnapshotTool: Tool = {
  name: "browser.snapshot",
  description: "Disabled-by-default preview: capture a bounded headless page snapshot without credentials.",
  required_capabilities: ["tool:browser.snapshot", "browser:snapshot", "network:http"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeBrowserSnapshot(args);
  },
};

export const browserAutomationTool: Tool = {
  name: "browser.automation",
  description: "Disabled-by-default preview for guarded headless browser actions.",
  required_capabilities: ["tool:browser.automation", "browser:act", "network:http"],
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeBrowserAutomation(args);
  },
};

export function registerBuiltinTools(registry: {
  register(tool: Tool): void;
}): void {
  registry.register(echoTool);
  registry.register(fileSearchTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(httpFetchTool);
  registry.register(webSearchTool);
  registry.register(githubReadTool);
  registry.register(githubWriteTool);
  registry.register(gmailReadTool);
  registry.register(googleCalendarReadTool);
  registry.register(googleDriveReadTool);
  registry.register(gmailWriteTool);
  registry.register(googleCalendarWriteTool);
  registry.register(googleDriveWriteTool);
  registry.register(composioSearchTool);
  registry.register(composioExecuteTool);
  registry.register(browserReadTool);
  registry.register(browserSnapshotTool);
  registry.register(browserAutomationTool);
  registry.register(shellExecTool);
}
