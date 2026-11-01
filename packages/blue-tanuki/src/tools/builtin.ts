import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import * as path from "node:path";
import {
  canonicalFileSearchTargetVersionObservation,
  canonicalFileWriteTargetVersionObservation,
  canonicalFileDeleteTargetVersionObservation,
  canonicalFileEditTargetVersionObservation,
  FileSearchTargetVersionObservationSchema,
  FileWriteTargetVersionObservationSchema,
  FileDeleteTargetVersionObservationSchema,
  FileEditTargetVersionObservationSchema,
  fileDeleteTargetIdentityDigest,
  fileWritePayloadDigest,
  fileWriteTargetIdentityDigest,
  fileEditPayloadDigest,
  fileEditTargetIdentityDigest,
  requireToolOperationDescriptor,
  type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation,
  type FileDeleteTargetVersionObservation,
  type FileEditTargetVersionObservation,
} from "@blue-tanuki/protocol";
import { assertToolExecutionNotCancelled, echoTool, type FileEditDiffContentReview, type Tool } from "./registry.js";
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
  composioAccountsTool,
  composioScopesTool,
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
  FileDeleteOptions,
  FileEditOptions,
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
  FileDeleteOptions,
  FileEditOptions,
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
  shellExecIsolationProviderAvailable,
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
  createGmailWriteTool,
  gmailWriteTool,
  googleCalendarWriteTool,
  googleDriveWriteTool,
  invokeGmailWrite,
  gmailDraftSendRequestPayloadDigest,
  gmailWriteRequestPayloadDigest,
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
const FILE_SEARCH_EXACT_TARGET_MAX_BYTES = 1_000_000;
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
  signal?: AbortSignal,
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
        signal,
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
  signal?: AbortSignal,
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
        signal,
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
  signal?: AbortSignal,
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
        signal,
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
    assertToolExecutionNotCancelled(opts.signal, "http.fetch");
    const target = await resolvePublicTarget(url, env, resolveHost);
    assertToolExecutionNotCancelled(opts.signal, "http.fetch");
    const res = await request(target, method, maxBytes, opts.signal);
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
  assertToolExecutionNotCancelled(opts.signal, "github.read");
  const response = await request({
    path: route.path,
    maxBytes,
  }, opts.signal);
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
  assertToolExecutionNotCancelled(opts.signal, "github.write");
  const response = await request({
    method: route.method,
    path: route.path,
    body: route.body,
    maxBytes,
    token,
  }, opts.signal);
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

interface ExactFileSearchTarget {
  filepath: string;
  relative_path: string;
  data: Buffer;
}

function assertExactFileSearchPath(filePath: string): void {
  if (filePath.length === 0 || filePath.length > 512 || path.isAbsolute(filePath) || filePath.includes("\\") ||
      filePath.includes(":") || filePath.includes("\0") || filePath.startsWith("/")) {
    throw new Error("file.search file_path must be a bounded relative path");
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("file.search file_path must not contain empty or traversal segments");
  }
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readExactFileSearchTarget(
  filePath: string,
  root: string,
  sandboxRoot: string,
): Promise<ExactFileSearchTarget> {
  assertExactFileSearchPath(filePath);
  const resolved = await resolveSandboxFilePath(filePath, sandboxRoot);
  let canonicalPath: string;
  try { canonicalPath = await fs.realpath(resolved.filepath); }
  catch { throw new Error("file.search exact target is unavailable"); }
  if (!isWithinDirectory(root, canonicalPath)) {
    throw new Error("file.search exact target must stay within the requested root");
  }
  const before = await fs.lstat(canonicalPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("file.search exact target must be a regular file");
  if (before.size > BigInt(FILE_SEARCH_EXACT_TARGET_MAX_BYTES)) {
    throw new Error("file.search exact target exceeds the bounded read size");
  }
  const identity = (stat: {
    dev: bigint; ino: bigint; size: bigint; mode: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
  }) => JSON.stringify([
    stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mode.toString(), stat.nlink.toString(),
    stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ]);
  const expectedIdentity = identity(before);
  const handle = await fs.open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || identity(opened) !== expectedIdentity) {
      throw new Error("file.search exact target changed while being opened");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= FILE_SEARCH_EXACT_TARGET_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64_000, FILE_SEARCH_EXACT_TARGET_MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
      if (total > FILE_SEARCH_EXACT_TARGET_MAX_BYTES) {
        throw new Error("file.search exact target exceeds the bounded read size");
      }
    }
    const openedAfter = identity(await handle.stat({ bigint: true }));
    const after = await fs.lstat(canonicalPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || openedAfter !== expectedIdentity || identity(after) !== expectedIdentity) {
      throw new Error("file.search exact target changed while being read");
    }
    return {
      filepath: canonicalPath,
      relative_path: path.relative(root, canonicalPath).replace(/\\/g, "/"),
      data: Buffer.concat(chunks, total),
    };
  } finally {
    await handle.close();
  }
}

export async function invokeFileSearch(
  args: Record<string, unknown>,
  opts: FileSearchOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const requestedRoot = stringArg(args, "root")!;
  const root = await resolveFileSearchRoot(requestedRoot, sandboxRoot);
  const requestedFilePath = args.file_path === undefined ? undefined : stringArg(args, "file_path")!;
  const query = stringArg(args, "query")!;
  const maxResults = positiveIntArg(args, "max_results", 20, 100);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("root must be a directory");
  }

  const targetVersionHasher = createHash("sha256").update("blue-tanuki.file-search-resource-version.v1\n", "utf8");
  const matches: Array<{ path: string; line_number: number; line: string }> = [];
  let visited = 0;
  const appendMatches = (relativeFilePath: string, data: Buffer) => {
    if (matches.length >= maxResults || data.includes(0)) return;
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes(query)) {
        matches.push({
          path: relativeFilePath.replace(/\\/g, "/"),
          line_number: i + 1,
          line: line.length > 240 ? `${line.slice(0, 237)}...` : line,
        });
        if (matches.length >= maxResults) break;
      }
    }
  };
  if (requestedFilePath !== undefined) {
    const target = await readExactFileSearchTarget(requestedFilePath, root, sandboxRoot);
    visited = 1;
    appendFileSearchVersionEntry(targetVersionHasher, root, target.filepath, target.data);
    appendMatches(target.relative_path, target.data);
  } else {
    for await (const file of walkFiles(root, sandboxRoot)) {
      if (visited >= 1_000) break;
      visited += 1;
      const data = await fs.readFile(file);
      appendFileSearchVersionEntry(targetVersionHasher, root, file, data);
      appendMatches(path.relative(root, file).replace(/\\/g, "/"), data);
    }
  }

  const targetVersion = fileSearchTargetVersionObservation(requestedRoot, root, visited, targetVersionHasher.digest("hex"),
    opts.expected_target_version?.operation_plan_binding_digest, requestedFilePath);
  if (opts.expected_target_version &&
      canonicalFileSearchTargetVersionObservation(targetVersion) !==
        canonicalFileSearchTargetVersionObservation(opts.expected_target_version)) {
    throw new Error("file.search target version changed; request fresh review");
  }

  const result = {
    root,
    sandbox_root: sandboxRoot,
    query,
    visited_files: visited,
    matches,
  };
  return opts.include_target_version_observation ? { ...result, target_version_observation: targetVersion } : result;
}

/** Read-only broker observation; it records only digests and the bounded file count. */
export async function inspectFileSearchTargetVersion(
  args: Record<string, unknown>,
  opts: FileSearchOptions = {},
): Promise<FileSearchTargetVersionObservation> {
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const requestedRoot = stringArg(args, "root")!;
  const root = await resolveFileSearchRoot(requestedRoot, sandboxRoot);
  const requestedFilePath = args.file_path === undefined ? undefined : stringArg(args, "file_path")!;
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("root must be a directory");
  const hasher = createHash("sha256").update("blue-tanuki.file-search-resource-version.v1\n", "utf8");
  let filesExamined = 0;
  if (requestedFilePath !== undefined) {
    const target = await readExactFileSearchTarget(requestedFilePath, root, sandboxRoot);
    appendFileSearchVersionEntry(hasher, root, target.filepath, target.data);
    filesExamined = 1;
  } else {
    for await (const file of walkFiles(root, sandboxRoot)) {
      if (filesExamined >= 1_000) break;
      const data = await fs.readFile(file);
      appendFileSearchVersionEntry(hasher, root, file, data);
      filesExamined += 1;
    }
  }
  return fileSearchTargetVersionObservation(requestedRoot, root, filesExamined, hasher.digest("hex"),
    opts.operation_plan_binding_digest, requestedFilePath);
}

function appendFileSearchVersionEntry(hasher: ReturnType<typeof createHash>, root: string, file: string, data: Buffer): void {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  const contentDigest = createHash("sha256").update(data).digest("hex");
  hasher.update(`${JSON.stringify([relative, data.length, contentDigest])}\n`, "utf8");
}

function fileSearchTargetVersionObservation(
  requestedRoot: string,
  canonicalRoot: string,
  filesExamined: number,
  resourceVersionDigest: string,
  operationPlanBindingDigest?: string,
  requestedFilePath?: string,
): FileSearchTargetVersionObservation {
  return FileSearchTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.file-search-target-version.v1",
    requested_root_digest: createHash("sha256").update(requestedRoot, "utf8").digest("hex"),
    ...(requestedFilePath !== undefined ? {
      requested_path_digest: createHash("sha256").update(requestedFilePath, "utf8").digest("hex"),
    } : {}),
    canonical_root_digest: createHash("sha256").update(canonicalRoot, "utf8").digest("hex"),
    resource_version_digest: resourceVersionDigest,
    ...(operationPlanBindingDigest ? { operation_plan_binding_digest: operationPlanBindingDigest } : {}),
    files_examined: filesExamined,
    used_for_authority: false,
    may_execute: false,
  });
}

export async function invokeFileWrite(
  args: Record<string, unknown>,
  opts: FileWriteOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  let sandboxRoot: string;
  let filepath: string;
  let relative_path: string;
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

  if (opts.expected_target_version) {
    const expected = FileWriteTargetVersionObservationSchema.parse(opts.expected_target_version);
    if (modeRaw !== "create" || !opts.command_digest || !opts.operation_plan_binding_digest ||
        expected.command_digest !== opts.command_digest ||
        expected.operation_plan_binding_digest !== opts.operation_plan_binding_digest) {
      throw new Error("file.write plan target evidence does not match the approved command");
    }
    const resolved = await resolveFileWriteTargetVersion(args, {
      env,
      command_digest: opts.command_digest,
      operation_plan_binding_digest: opts.operation_plan_binding_digest,
    });
    if (canonicalFileWriteTargetVersionObservation(resolved.observation) !==
        canonicalFileWriteTargetVersionObservation(expected)) {
      throw new Error("file.write target version changed; request fresh review");
    }
    ({ sandbox_root: sandboxRoot, filepath, relative_path } = resolved);
  } else {
    sandboxRoot = await sandboxRootFromEnv(env);
    const resolved = await resolveSandboxFilePath(stringArg(args, "path")!, sandboxRoot);
    ({ filepath, relative_path } = resolved);
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

interface ResolvedFileWriteTargetVersion {
  sandbox_root: string;
  filepath: string;
  relative_path: string;
  observation: FileWriteTargetVersionObservation;
}

/** J計画で使う、上限付きcreate-only file.writeだけを観測する。 */
async function resolveFileWriteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileWriteOptions, "env" | "command_digest" | "operation_plan_binding_digest">,
): Promise<ResolvedFileWriteTargetVersion> {
  const pathArg = stringArg(args, "path")!;
  const content = stringArg(args, "content")!;
  const mode = stringArg(args, "mode", false);
  if (mode !== "create" || !opts.command_digest || !opts.operation_plan_binding_digest ||
      !/^[a-f0-9]{64}$/.test(opts.command_digest) || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest) ||
      Object.keys(args).some((key) => !["path", "content", "mode", "max_bytes"].includes(key))) {
    throw new Error("file.write plan target resolver supports only bounded create commands");
  }
  assertPlannedFileWritePath(pathArg);
  const env = opts.env ?? process.env;
  const sandboxRoot = await sandboxRootFromEnv(env);
  const { filepath: resolvedPath, relative_path } = await resolveSandboxFilePath(pathArg, sandboxRoot);
  const realParent = await fs.realpath(path.dirname(resolvedPath));
  const filepath = path.join(realParent, path.basename(resolvedPath));
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 1_000_000);
  const payloadBytes = Buffer.byteLength(content, "utf8");
  if (payloadBytes > maxBytes) throw new Error("file.write plan payload exceeds max_bytes");

  const existing = await fs.lstat(filepath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("file.write planned create target must be absent");

  const parentStat = await fs.stat(realParent, { bigint: true });
  if (!parentStat.isDirectory()) throw new Error("file.write parent must be a directory");
  const rootStat = await fs.stat(sandboxRoot, { bigint: true });
  const observation = FileWriteTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.file-write-target-version.v1",
    target_identity_digest: fileWriteTargetIdentityDigest(pathArg),
    payload_digest: fileWritePayloadDigest(content),
    canonical_root_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-write-root-identity.v1", sandboxRoot, rootStat.dev.toString(), rootStat.ino.toString(),
    ]), "utf8").digest("hex"),
    parent_identity_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-write-parent-identity.v1", realParent, parentStat.dev.toString(), parentStat.ino.toString(),
    ]), "utf8").digest("hex"),
    command_digest: opts.command_digest,
    operation_plan_binding_digest: opts.operation_plan_binding_digest,
    target_state: "absent",
    used_for_authority: false,
    may_execute: false,
  });
  return { sandbox_root: sandboxRoot, filepath, relative_path, observation };
}

export async function inspectFileWriteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileWriteOptions, "env" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileWriteTargetVersionObservation> {
  return (await resolveFileWriteTargetVersion(args, opts)).observation;
}

export interface FileWriteOutcomeStateInspection {
  readonly state: "absent" | "present" | "non_regular";
  readonly target_identity_digest: string;
  readonly canonical_root_digest: string;
  readonly parent_identity_digest: string;
  readonly observed_payload_digest?: string;
  readonly file_identity_digest?: string;
}

/** Read the exact planned create target after an unknown result; never returns file contents. */
export async function inspectFileWriteOutcomeState(
  args: Record<string, unknown>,
  opts: Pick<FileWriteOptions, "env"> = {},
): Promise<FileWriteOutcomeStateInspection> {
  const pathArg = stringArg(args, "path")!;
  const content = stringArg(args, "content")!;
  if (stringArg(args, "mode", false) !== "create" ||
      Object.keys(args).some((key) => !["path", "content", "mode", "max_bytes"].includes(key))) {
    throw new Error("file.write outcome inspection supports only planned create commands");
  }
  assertPlannedFileWritePath(pathArg);
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 1_000_000);
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("file.write plan payload exceeds max_bytes");
  const sandboxRoot = await sandboxRootFromEnv(opts.env ?? process.env);
  const resolved = await resolveSandboxFilePath(pathArg, sandboxRoot);
  const realParent = await fs.realpath(path.dirname(resolved.filepath));
  if (!isPathWithin(sandboxRoot, realParent)) throw new Error("file.write outcome parent escapes BLUE_TANUKI_FILE_ROOT");
  const filepath = path.join(realParent, path.basename(resolved.filepath));
  const rootStat = await fs.stat(sandboxRoot, { bigint: true });
  const parentStat = await fs.stat(realParent, { bigint: true });
  const common = {
    target_identity_digest: fileWriteTargetIdentityDigest(pathArg),
    canonical_root_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-write-root-identity.v1", sandboxRoot, rootStat.dev.toString(), rootStat.ino.toString(),
    ]), "utf8").digest("hex"),
    parent_identity_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-write-parent-identity.v1", realParent, parentStat.dev.toString(), parentStat.ino.toString(),
    ]), "utf8").digest("hex"),
  };
  const before = await fs.lstat(filepath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return { state: "absent", ...common };
  if (!before.isFile() || before.isSymbolicLink()) return { state: "non_regular", ...common };
  if (before.size > BigInt(maxBytes)) throw new Error("file.write outcome target exceeds max_bytes");
  const identity = (stat: {
    dev: bigint; ino: bigint; size: bigint; mode: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
  }) => createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-write-outcome-file-identity.v1", stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
    stat.mode.toString(), stat.nlink.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ]), "utf8").digest("hex");
  const beforeIdentity = identity(before);
  const handle = await fs.open(filepath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: Buffer;
  let openedIdentity: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || identity(opened) !== beforeIdentity) throw new Error("file.write outcome target changed while being observed");
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64_000, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
      if (total > maxBytes) throw new Error("file.write outcome target exceeds max_bytes");
    }
    contents = Buffer.concat(chunks, total);
    openedIdentity = identity(await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(filepath, { bigint: true });
  if (!after.isFile() || identity(after) !== openedIdentity) throw new Error("file.write outcome target changed while being observed");
  return { state: "present", ...common,
    observed_payload_digest: createHash("sha256").update(contents).digest("hex"),
    file_identity_digest: openedIdentity };
}

interface ResolvedFileDeleteTargetVersion {
  filepath: string;
  observation: FileDeleteTargetVersionObservation;
}

/** J計画で選ばれた、sandbox内の単一regular file削除対象をdigestだけで観測する。 */
async function resolveFileDeleteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileDeleteOptions, "env" | "command_digest" | "operation_plan_binding_digest">,
): Promise<ResolvedFileDeleteTargetVersion> {
  const pathArg = stringArg(args, "path")!;
  if (!opts.command_digest || !opts.operation_plan_binding_digest ||
      !/^[a-f0-9]{64}$/.test(opts.command_digest) || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest) ||
      Object.keys(args).some((key) => !["path", "max_bytes"].includes(key))) {
    throw new Error("file.delete target resolver requires a bounded planned command");
  }
  assertPlannedFileDeletePath(pathArg);
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 1_000_000);
  const sandboxRoot = await sandboxRootFromEnv(opts.env ?? process.env);
  const resolved = await resolveSandboxFilePath(pathArg, sandboxRoot);
  const realParent = await fs.realpath(path.dirname(resolved.filepath));
  if (!isPathWithin(sandboxRoot, realParent)) throw new Error("file.delete parent escapes BLUE_TANUKI_FILE_ROOT");
  const filepath = path.join(realParent, path.basename(resolved.filepath));
  const before = await fs.lstat(filepath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("file.delete target must be a regular non-symlink file");
  if (before.size > BigInt(maxBytes)) throw new Error("file.delete target exceeds max_bytes");
  const realFile = await fs.realpath(filepath);
  if (!isPathWithin(sandboxRoot, realFile)) throw new Error("file.delete target escapes BLUE_TANUKI_FILE_ROOT");

  const handle = await fs.open(filepath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: Buffer;
  let openedIdentity: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || fileDeleteStatIdentity(opened) !== fileDeleteStatIdentity(before)) {
      throw new Error("file.delete target changed while being observed");
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64_000, maxBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
      if (totalBytes > maxBytes) throw new Error("file.delete target exceeds max_bytes");
    }
    contents = Buffer.concat(chunks, totalBytes);
    openedIdentity = fileDeleteStatIdentity(await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(filepath, { bigint: true });
  if (!after.isFile() || fileDeleteStatIdentity(after) !== openedIdentity || contents.length > maxBytes) {
    throw new Error("file.delete target changed while being observed");
  }
  const rootStat = await fs.stat(sandboxRoot, { bigint: true });
  const parentStat = await fs.stat(realParent, { bigint: true });
  const observation = FileDeleteTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.file-delete-target-version.v1",
    target_identity_digest: fileDeleteTargetIdentityDigest(pathArg),
    file_content_digest: createHash("sha256").update(contents).digest("hex"),
    file_identity_digest: openedIdentity,
    canonical_root_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-delete-root-identity.v1", sandboxRoot, rootStat.dev.toString(), rootStat.ino.toString(),
    ]), "utf8").digest("hex"),
    parent_identity_digest: createHash("sha256").update(JSON.stringify([
      "blue-tanuki.file-delete-parent-identity.v1", realParent, parentStat.dev.toString(), parentStat.ino.toString(),
    ]), "utf8").digest("hex"),
    command_digest: opts.command_digest,
    operation_plan_binding_digest: opts.operation_plan_binding_digest,
    target_state: "present",
    used_for_authority: false,
    may_execute: false,
  });
  return { filepath, observation };
}

export async function inspectFileDeleteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileDeleteOptions, "env" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileDeleteTargetVersionObservation> {
  return (await resolveFileDeleteTargetVersion(args, opts)).observation;
}

/** Delete only after a J-selected planned command and its exact pre-delete observation are rechecked. */
export async function invokeFileDelete(
  args: Record<string, unknown>,
  opts: FileDeleteOptions = {},
): Promise<unknown> {
  const expected = FileDeleteTargetVersionObservationSchema.parse(opts.expected_target_version);
  if (!opts.command_digest || !opts.operation_plan_binding_digest ||
      expected.command_digest !== opts.command_digest ||
      expected.operation_plan_binding_digest !== opts.operation_plan_binding_digest) {
    throw new Error("file.delete requires matching J-selected target evidence");
  }
  const resolved = await resolveFileDeleteTargetVersion(args, opts);
  if (canonicalFileDeleteTargetVersionObservation(resolved.observation) !==
      canonicalFileDeleteTargetVersionObservation(expected)) {
    throw new Error("file.delete target version changed; request fresh review");
  }
  await fs.unlink(resolved.filepath);
  // Target identity and prior-content evidence stay in the bound HDS/Broker trace;
  // the ordinary result reports only the effect status for exact J validation.
  return { deleted: true };
}

function assertPlannedFileDeletePath(pathArg: string): void {
  if (pathArg.length === 0 || pathArg.length > 512 || path.isAbsolute(pathArg) || pathArg.includes("\\") ||
      pathArg.includes(":") || pathArg.includes("\0") || pathArg.startsWith("/")) {
    throw new Error("file.delete path must be a bounded relative path");
  }
  const segments = pathArg.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("file.delete path must not contain empty or traversal segments");
  }
}

function fileDeleteStatIdentity(stat: {
  dev: bigint; ino: bigint; size: bigint; mode: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-delete-file-identity.v1", stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
    stat.mode.toString(), stat.nlink.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ]), "utf8").digest("hex");
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve one in-process Broker lock identity for file mutations. The returned
 * value is a digest; filesystem paths remain inside the adapter process.
 */
export async function brokerFileResourceLockDigest(
  toolName: string,
  args: Record<string, unknown>,
  env: Env = process.env,
): Promise<string> {
  const pathArg = stringArg(args, "path")!;
  if (toolName === "file.write" && args.mode === "create") assertPlannedFileWritePath(pathArg);
  else if (toolName === "file.edit") assertPlannedFileEditPath(pathArg);
  else if (toolName === "file.delete") assertPlannedFileDeletePath(pathArg);
  else if (toolName !== "file.write") throw new Error("Broker file resource lock received an unsupported tool");

  try {
    const sandboxRoot = await sandboxRootFromEnv(env);
    const candidate = await resolveSandboxFilePath(pathArg, sandboxRoot);
    const realParent = await fs.realpath(path.dirname(candidate.filepath));
    if (!isPathWithin(sandboxRoot, realParent)) throw new Error("outside sandbox");
    const lexicalTarget = path.join(realParent, path.basename(candidate.filepath));
    let canonicalTarget = lexicalTarget;
    try {
      const realTarget = await fs.realpath(lexicalTarget);
      if (!isPathWithin(sandboxRoot, realTarget)) throw new Error("outside sandbox");
      canonicalTarget = realTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lockTarget = process.platform === "win32" ? canonicalTarget.toLocaleLowerCase("en-US") : canonicalTarget;
    return createHash("sha256").update(JSON.stringify([
      "blue-tanuki.broker-file-resource-lock.v1", lockTarget,
    ]), "utf8").digest("hex");
  } catch {
    // Do not leak filesystem paths through the Broker error projection.
    throw new Error("Broker file target resource could not be resolved");
  }
}

function assertPlannedFileWritePath(pathArg: string): void {
  if (pathArg.length === 0 || pathArg.length > 512 || path.isAbsolute(pathArg) || pathArg.includes("\\") ||
      pathArg.includes(":") || pathArg.includes("\0") || pathArg.startsWith("/")) {
    throw new Error("file.write plan path must be a bounded relative path");
  }
  const segments = pathArg.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("file.write plan path must not contain empty or traversal segments");
  }
}

interface ResolvedFileEditTargetVersion {
  readonly sandbox_root: string;
  readonly filepath: string;
  readonly relative_path: string;
  readonly before_buffer: Buffer;
  readonly after_buffer: Buffer;
  readonly observation: FileEditTargetVersionObservation;
}

async function readBoundedFileHandle(handle: Awaited<ReturnType<typeof fs.open>>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const length = Math.min(64_000, maxBytes + 1 - total);
    if (length <= 0) break;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) throw new Error("file.edit input exceeds max_bytes");
  }
  return Buffer.concat(chunks, total);
}

function fileEditStatIdentity(stat: {
  dev: bigint; ino: bigint; size: bigint; mode: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-edit-file-identity.v1", stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
    stat.mode.toString(), stat.nlink.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ]), "utf8").digest("hex");
}

function sameFileEditInode(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPlannedFileEditPath(pathArg: string): void {
  if (pathArg.length === 0 || pathArg.length > 512 || path.isAbsolute(pathArg) || pathArg.includes("\\") ||
      pathArg.includes(":") || pathArg.includes("\0") || pathArg.startsWith("/")) {
    throw new Error("file.edit plan path must be a bounded relative path");
  }
  if (pathArg.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("file.edit plan path must not contain empty or traversal segments");
  }
}

async function resolveFileEditTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileEditOptions, "env" | "command_digest" | "operation_plan_binding_digest">,
): Promise<ResolvedFileEditTargetVersion> {
  const pathArg = stringArg(args, "path")!;
  const search = stringArg(args, "search")!;
  const replace = stringArg(args, "replace")!;
  if (search.length === 0 || search === replace || search.length > 1_000_000 || replace.length > 1_000_000 ||
      !opts.command_digest || !/^[a-f0-9]{64}$/.test(opts.command_digest) ||
      !opts.operation_plan_binding_digest || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest) ||
      Object.keys(args).some((key) => !["path", "search", "replace", "expected_replacements", "max_bytes"].includes(key))) {
    throw new Error("file.edit target resolver requires a bounded planned command");
  }
  assertPlannedFileEditPath(pathArg);
  const expectedReplacements = positiveIntArg(args, "expected_replacements", 1, 100);
  const maxBytes = positiveIntArg(args, "max_bytes", 512_000, 1_000_000);
  const sandboxRoot = await sandboxRootFromEnv(opts.env ?? process.env);
  const requested = await resolveSandboxFilePath(pathArg, sandboxRoot);
  const realParent = await fs.realpath(path.dirname(requested.filepath));
  if (!isPathWithin(sandboxRoot, realParent)) throw new Error("file.edit parent escapes BLUE_TANUKI_FILE_ROOT");
  const filepath = path.join(realParent, path.basename(requested.filepath));
  const beforeStat = await fs.lstat(filepath, { bigint: true });
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink() || beforeStat.nlink !== 1n) {
    throw new Error("file.edit target must be a regular, non-symlink, single-link file");
  }
  if (beforeStat.size > BigInt(maxBytes)) throw new Error("file.edit input exceeds max_bytes");
  const realFile = await fs.realpath(filepath);
  if (!isPathWithin(sandboxRoot, realFile)) throw new Error("file.edit target escapes BLUE_TANUKI_FILE_ROOT");

  const handle = await fs.open(filepath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let beforeBuffer: Buffer;
  let observation: FileEditTargetVersionObservation;
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || fileEditStatIdentity(openedStat) !== fileEditStatIdentity(beforeStat)) {
      throw new Error("file.edit target changed while being observed");
    }
    beforeBuffer = await readBoundedFileHandle(handle, maxBytes);
    if (beforeBuffer.includes(0)) throw new Error("file.edit refuses binary-looking files");
    const before = beforeBuffer.toString("utf8");
    if (!Buffer.from(before, "utf8").equals(beforeBuffer)) throw new Error("file.edit requires valid UTF-8 input");
    const parts = before.split(search);
    const replacements = parts.length - 1;
    if (replacements !== expectedReplacements) {
      throw new Error(`file.edit expected ${expectedReplacements} replacement(s), found ${replacements}`);
    }
    const afterBuffer = Buffer.from(parts.join(replace), "utf8");
    if (afterBuffer.length > maxBytes) throw new Error("file.edit output exceeds max_bytes");

    const afterReadStat = await handle.stat({ bigint: true });
    const afterReadPathStat = await fs.lstat(filepath, { bigint: true });
    if (fileEditStatIdentity(afterReadStat) !== fileEditStatIdentity(openedStat) ||
        fileEditStatIdentity(afterReadPathStat) !== fileEditStatIdentity(openedStat)) {
      throw new Error("file.edit target changed while being observed");
    }
    const rootStat = await fs.stat(sandboxRoot, { bigint: true });
    const parentStat = await fs.stat(realParent, { bigint: true });
    observation = FileEditTargetVersionObservationSchema.parse({
      schema_version: "blue-tanuki.file-edit-target-version.v1",
      target_identity_digest: fileEditTargetIdentityDigest(pathArg),
      before_content_digest: createHash("sha256").update(beforeBuffer).digest("hex"),
      after_content_digest: createHash("sha256").update(afterBuffer).digest("hex"),
      file_identity_digest: fileEditStatIdentity(openedStat),
      canonical_root_digest: createHash("sha256").update(JSON.stringify([
        "blue-tanuki.file-edit-root-identity.v1", sandboxRoot, rootStat.dev.toString(), rootStat.ino.toString(),
      ]), "utf8").digest("hex"),
      parent_identity_digest: createHash("sha256").update(JSON.stringify([
        "blue-tanuki.file-edit-parent-identity.v1", realParent, parentStat.dev.toString(), parentStat.ino.toString(),
      ]), "utf8").digest("hex"),
      edit_payload_digest: fileEditPayloadDigest({ search, replace, expected_replacements: expectedReplacements, max_bytes: maxBytes }),
      command_digest: opts.command_digest,
      operation_plan_binding_digest: opts.operation_plan_binding_digest,
      replacement_count: replacements,
      target_state: "present",
      used_for_authority: false,
      may_execute: false,
    });
    return { sandbox_root: sandboxRoot, filepath, relative_path: requested.relative_path, before_buffer: beforeBuffer,
      after_buffer: afterBuffer, observation };
  } finally {
    await handle.close();
  }
}

export async function inspectFileEditTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileEditOptions, "env" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileEditTargetVersionObservation> {
  return (await resolveFileEditTargetVersion(args, opts)).observation;
}

const MAX_FILE_EDIT_REVIEW_DIFF_BYTES = 128_000;

function diffLines(prefix: "-" | "+", value: string): string {
  return value.split("\n").map((line) => `${prefix}${line.replace(/\r/g, "\\r").replace(/\u001b/g, "\\x1b")}`).join("\n") + "\n";
}

function fileEditReplacementDiff(relativePath: string, before: string, search: string, replace: string,
  replacementCount: number): string {
  const safePath = JSON.stringify(relativePath);
  let diff = `--- a/${safePath}\n+++ b/${safePath}\n`;
  let sourceOffset = 0;
  let lineDelta = 0;
  const oldLines = search.split("\n");
  const newLines = replace.split("\n");
  for (let index = 0; index < replacementCount; index += 1) {
    const matchAt = before.indexOf(search, sourceOffset);
    if (matchAt < 0) throw new Error("file.edit review could not reconstruct the observed replacement diff");
    const oldLine = before.slice(0, matchAt).split("\n").length;
    const newLine = oldLine + lineDelta;
    diff += `@@ -${oldLine},${oldLines.length} +${newLine},${newLines.length} @@ replacement ${index + 1}/${replacementCount}\n`;
    diff += diffLines("-", search) + diffLines("+", replace);
    if (Buffer.byteLength(diff, "utf8") > MAX_FILE_EDIT_REVIEW_DIFF_BYTES) {
      throw new Error("file.edit diff exceeds the owner-review size limit");
    }
    sourceOffset = matchAt + search.length;
    lineDelta += newLines.length - oldLines.length;
  }
  return diff;
}

export async function inspectFileEditContentReview(
  args: Record<string, unknown>,
  opts: Pick<FileEditOptions, "env" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileEditDiffContentReview> {
  if (!opts.command_digest || !/^[a-f0-9]{64}$/.test(opts.command_digest) ||
      !opts.operation_plan_binding_digest || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest)) {
    throw new Error("file.edit content review requires a bound command and Operation Plan source");
  }
  const resolved = await resolveFileEditTargetVersion(args, opts);
  const search = stringArg(args, "search")!;
  const replace = stringArg(args, "replace")!;
  const diff = fileEditReplacementDiff(resolved.relative_path, resolved.before_buffer.toString("utf8"), search, replace,
    resolved.observation.replacement_count);
  const targetVersionDigest = createHash("sha256").update(
    canonicalFileEditTargetVersionObservation(resolved.observation), "utf8").digest("hex");
  const reviewDigest = createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-edit-diff-review.v1", opts.command_digest, opts.operation_plan_binding_digest,
    targetVersionDigest, diff,
  ]), "utf8").digest("hex");
  return Object.freeze({ path: resolved.relative_path, diff,
    replacement_count: resolved.observation.replacement_count,
    before_content_digest: resolved.observation.before_content_digest,
    after_content_digest: resolved.observation.after_content_digest,
    target_version_digest: targetVersionDigest,
    operation_plan_binding_digest: opts.operation_plan_binding_digest,
    request_payload_digest: resolved.observation.edit_payload_digest,
    command_digest: opts.command_digest,
    review_digest: reviewDigest,
    used_for_authority: false, may_execute: false });
}

/** Edit only the exact J-selected file version and payload; raw content stays out of the observation. */
export async function invokeFileEdit(
  args: Record<string, unknown>,
  opts: FileEditOptions = {},
): Promise<unknown> {
  if (!opts.expected_target_version || !opts.command_digest || !opts.operation_plan_binding_digest) {
    throw new Error("file.edit requires matching J-selected target evidence");
  }
  const expected = FileEditTargetVersionObservationSchema.parse(opts.expected_target_version);
  if (!/^[a-f0-9]{64}$/.test(opts.command_digest) || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest) ||
      expected.command_digest !== opts.command_digest ||
      expected.operation_plan_binding_digest !== opts.operation_plan_binding_digest) {
    throw new Error("file.edit target evidence does not match the approved command or plan source");
  }
  const resolved = await resolveFileEditTargetVersion(args, opts);
  if (canonicalFileEditTargetVersionObservation(resolved.observation) !==
      canonicalFileEditTargetVersionObservation(expected)) {
    throw new Error("file.edit target version changed; request fresh review");
  }

  const handle = await fs.open(resolved.filepath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat({ bigint: true });
    const pathStat = await fs.lstat(resolved.filepath, { bigint: true });
    if (!openedStat.isFile() || fileEditStatIdentity(openedStat) !== expected.file_identity_digest ||
        fileEditStatIdentity(pathStat) !== expected.file_identity_digest) {
      throw new Error("file.edit target version changed; request fresh review");
    }
    const currentBuffer = await readBoundedFileHandle(handle, positiveIntArg(args, "max_bytes", 512_000, 1_000_000));
    if (createHash("sha256").update(currentBuffer).digest("hex") !== expected.before_content_digest ||
        !currentBuffer.equals(resolved.before_buffer)) {
      throw new Error("file.edit target version changed; request fresh review");
    }
    const beforeWriteStat = await handle.stat({ bigint: true });
    const beforeWritePathStat = await fs.lstat(resolved.filepath, { bigint: true });
    if (fileEditStatIdentity(beforeWriteStat) !== expected.file_identity_digest ||
        fileEditStatIdentity(beforeWritePathStat) !== expected.file_identity_digest) {
      throw new Error("file.edit target version changed; request fresh review");
    }
    let offset = 0;
    while (offset < resolved.after_buffer.length) {
      const { bytesWritten } = await handle.write(resolved.after_buffer, offset,
        resolved.after_buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error("file.edit write did not make progress");
      offset += bytesWritten;
    }
    await handle.truncate(resolved.after_buffer.length);
    await handle.sync();
    const finalBuffer = await readBoundedFileHandle(handle, Math.max(resolved.after_buffer.length, 1));
    if (createHash("sha256").update(finalBuffer).digest("hex") !== expected.after_content_digest) {
      throw new Error("file.edit result could not be confirmed; request fresh review");
    }
    const finalStat = await handle.stat({ bigint: true });
    const finalPathStat = await fs.lstat(resolved.filepath, { bigint: true });
    if (!sameFileEditInode(finalStat, finalPathStat) || !finalPathStat.isFile() || finalPathStat.isSymbolicLink()) {
      throw new Error("file.edit target changed during commit; result is uncertain");
    }
    return { edited: true, replacements: expected.replacement_count, bytes_written: resolved.after_buffer.length };
  } finally {
    await handle.close();
  }
}

export const fileSearchTool: Tool = {
  name: "file.search",
  description: "Read-only text search under a requested root directory, optionally limited to one exact relative file. After an explicitly requested workspace test, use the same relative file path to reread current state and return the saved result to the owner.",
  required_capabilities: requireToolOperationDescriptor("file.search").required_capabilities,
  async inspect_target_version(args: Record<string, unknown>, options?: {
    env?: Env; operation_plan_binding_digest?: string; command_digest?: string;
  }): Promise<FileSearchTargetVersionObservation> {
    return await inspectFileSearchTargetVersion(args, options);
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const targetVersion = context.target_version_observation;
    if (targetVersion !== undefined && targetVersion.schema_version !== "blue-tanuki.file-search-target-version.v1") {
      throw new Error("file.search received unsupported Broker target version evidence");
    }
    return await invokeFileSearch(args, { expected_target_version: targetVersion,
      include_target_version_observation: targetVersion !== undefined });
  },
};

export const fileWriteTool: Tool = {
  name: "file.write",
  description: "Create, overwrite, or append a UTF-8 file under BLUE_TANUKI_FILE_ROOT.",
  required_capabilities: requireToolOperationDescriptor("file.write").required_capabilities,
  async inspect_target_version(args: Record<string, unknown>, options?: {
    env?: Env; operation_plan_binding_digest?: string; command_digest?: string;
  }): Promise<FileWriteTargetVersionObservation> {
    return await inspectFileWriteTargetVersion(args, options);
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const targetVersion = context.target_version_observation;
    if (targetVersion === undefined) return await invokeFileWrite(args);
    if (targetVersion.schema_version !== "blue-tanuki.file-write-target-version.v1") {
      throw new Error("file.write received unsupported Broker target version evidence");
    }
    if (typeof context.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(context.command_digest)) {
      throw new Error("file.write requires an approved Executor command identity");
    }
    return await invokeFileWrite(args, {
      expected_target_version: targetVersion,
      command_digest: targetVersion.command_digest,
      operation_plan_binding_digest: targetVersion.operation_plan_binding_digest,
    });
  },
};

export const fileDeleteTool: Tool = {
  name: "file.delete",
  description: "Delete one regular file under BLUE_TANUKI_FILE_ROOT after final review and target recheck.",
  required_capabilities: requireToolOperationDescriptor("file.delete").required_capabilities,
  async inspect_target_version(args: Record<string, unknown>, options?: {
    env?: Env; operation_plan_binding_digest?: string; command_digest?: string;
  }): Promise<FileDeleteTargetVersionObservation> {
    return await inspectFileDeleteTargetVersion(args, options);
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const targetVersion = context.target_version_observation;
    if (targetVersion?.schema_version !== "blue-tanuki.file-delete-target-version.v1") {
      throw new Error("file.delete requires Broker target version evidence");
    }
    if (typeof context.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(context.command_digest)) {
      throw new Error("file.delete requires an approved Executor command identity");
    }
    return await invokeFileDelete(args, {
      expected_target_version: targetVersion,
      command_digest: targetVersion.command_digest,
      operation_plan_binding_digest: targetVersion.operation_plan_binding_digest,
    });
  },
};

export const fileEditTool: Tool = {
  name: "file.edit",
  description: "Perform an exact UTF-8 text replacement under BLUE_TANUKI_FILE_ROOT. After an owner-reviewed edit, run only a requested test with shell.exec using same_workspace_as_file_root=true and summary_only=true, then reread the same path with file.search. A failed test never triggers automatic restoration; recovery requires a fresh owner-reviewed inverse edit against the current file version.",
  required_capabilities: requireToolOperationDescriptor("file.edit").required_capabilities,
  async inspect_target_version(args: Record<string, unknown>, options?: {
    env?: Env; operation_plan_binding_digest?: string; command_digest?: string;
  }): Promise<FileEditTargetVersionObservation> {
    return await inspectFileEditTargetVersion(args, options);
  },
  async inspect_content_review(args, options): Promise<FileEditDiffContentReview> {
    return await inspectFileEditContentReview(args, options);
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const targetVersion = context.target_version_observation;
    if (targetVersion?.schema_version !== "blue-tanuki.file-edit-target-version.v1") {
      throw new Error("file.edit requires Broker target version evidence");
    }
    if (typeof context.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(context.command_digest)) {
      throw new Error("file.edit requires an approved Executor command identity");
    }
    return await invokeFileEdit(args, {
      ...(context.target_version_observation ? {} : {}),
      expected_target_version: targetVersion,
      command_digest: targetVersion.command_digest,
      operation_plan_binding_digest: targetVersion.operation_plan_binding_digest,
    });
  },
};

export const httpFetchTool: Tool = {
  name: "http.fetch",
  description: "GET or HEAD an HTTP(S) URL and return a bounded response body.",
  required_capabilities: requireToolOperationDescriptor("http.fetch").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeHttpFetch(args, { signal: context.signal });
  },
};

export const webSearchTool: Tool = {
  name: "web.search",
  description: "Provider-neutral web search via BLUE_TANUKI_WEB_SEARCH_ENDPOINT.",
  required_capabilities: requireToolOperationDescriptor("web.search").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeWebSearch(args, { signal: context.signal });
  },
};

export const githubReadTool: Tool = {
  name: "github.read",
  description: "Read public GitHub repo, issue, and pull request metadata from api.github.com.",
  required_capabilities: requireToolOperationDescriptor("github.read").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeGitHubRead(args, { signal: context.signal });
  },
};

export const githubWriteTool: Tool = {
  name: "github.write",
  description: "Create/update GitHub issues, pull requests, and comments on allowlisted repositories.",
  required_capabilities: requireToolOperationDescriptor("github.write").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeGitHubWrite(args, { signal: context.signal });
  },
};

export const browserReadTool: Tool = {
  name: "browser.read",
  description: "Fetch a public web page through the SSRF guard and extract bounded readable text.",
  required_capabilities: requireToolOperationDescriptor("browser.read").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeBrowserRead(args, { signal: context.signal });
  },
};

export const browserSnapshotTool: Tool = {
  name: "browser.snapshot",
  description: "Disabled-by-default preview: capture a bounded headless page snapshot without credentials.",
  required_capabilities: requireToolOperationDescriptor("browser.snapshot").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeBrowserSnapshot(args);
  },
};

export const browserAutomationTool: Tool = {
  name: "browser.automation",
  description: "Disabled-by-default preview for guarded headless browser actions.",
  required_capabilities: requireToolOperationDescriptor("browser.automation").required_capabilities,
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
  registry.register(fileDeleteTool);
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
  registry.register(composioAccountsTool);
  registry.register(composioScopesTool);
  registry.register(composioExecuteTool);
  registry.register(browserReadTool);
  registry.register(browserSnapshotTool);
  registry.register(browserAutomationTool);
  registry.register(shellExecTool);
}
