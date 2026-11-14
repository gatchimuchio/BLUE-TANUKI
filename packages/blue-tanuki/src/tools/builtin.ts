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
  GitHubIssueCreateTargetVersionObservationSchema,
  GitHubIssueUpdateTargetVersionObservationSchema,
  GitHubIssueCloseTargetVersionObservationSchema,
  GitHubIssueReopenTargetVersionObservationSchema,
  GitHubIssueCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCommentCreateTargetVersionObservationSchema,
  GitHubPullRequestCreateTargetVersionObservationSchema,
  GitHubPullRequestMergeTargetVersionObservationSchema,
  GitHubCodePushTargetVersionObservationSchema,
  GitHubReleaseDraftCreateTargetVersionObservationSchema,
  GitHubWriteTargetVersionObservationSchema,
  fileDeleteTargetIdentityDigest,
  fileWritePayloadDigest,
  fileWriteTargetIdentityDigest,
  fileEditPayloadDigest,
  fileEditTargetIdentityDigest,
  githubIssueCreateRequestPayloadDigest,
  githubIssueCreateTargetIdentityDigest,
  githubIssueUpdateRequestPayloadDigest,
  githubIssueUpdateTargetIdentityDigest,
  githubIssueCloseRequestPayloadDigest,
  githubIssueCloseTargetIdentityDigest,
  githubIssueReopenRequestPayloadDigest,
  githubIssueReopenTargetIdentityDigest,
  githubIssueCommentCreateRequestPayloadDigest,
  githubIssueCommentCreateTargetIdentityDigest,
  githubPullRequestCommentCreateRequestPayloadDigest,
  githubPullRequestCommentCreateTargetIdentityDigest,
  githubPullRequestCreateRequestPayloadDigest,
  githubPullRequestCreateTargetIdentityDigest,
  githubPullRequestMergeRequestPayloadDigest,
  githubPullRequestMergeTargetIdentityDigest,
  githubCodePushRequestPayloadDigest,
  githubCodePushTargetIdentityDigest,
  githubReleaseDraftCreateRequestPayloadDigest,
  githubReleaseDraftCreateTargetIdentityDigest,
  canonicalGitHubWriteTargetVersionObservation,
  requireToolOperationDescriptor,
  type FileSearchTargetVersionObservation,
  type FileWriteTargetVersionObservation,
  type FileDeleteTargetVersionObservation,
  type FileEditTargetVersionObservation,
  type GitHubIssueCreateTargetVersionObservation,
  type GitHubIssueUpdateTargetVersionObservation,
  type GitHubIssueCloseTargetVersionObservation,
  type GitHubIssueReopenTargetVersionObservation,
  type GitHubIssueCommentCreateTargetVersionObservation,
  type GitHubPullRequestCommentCreateTargetVersionObservation,
  type GitHubPullRequestCreateTargetVersionObservation,
  type GitHubPullRequestMergeTargetVersionObservation,
  type GitHubCodePushTargetVersionObservation,
  type GitHubReleaseDraftCreateTargetVersionObservation,
  type GitHubWriteTargetVersionObservation,
} from "@blue-tanuki/protocol";
import { assertToolExecutionNotCancelled, echoTool, type FileDeleteTargetContentReview,
  type FileEditDiffContentReview, type GitHubIssueCreateContentReview, type GitHubIssueUpdateContentReview,
  type GitHubIssueCloseContentReview,
  type GitHubIssueReopenContentReview,
  type GitHubIssueCommentCreateContentReview, type GitHubPullRequestCommentCreateContentReview,
  type GitHubPullRequestCreateContentReview, type GitHubCodePushContentReview,
  type GitHubPullRequestMergeContentReview,
  type GitHubReleaseDraftCreateContentReview, type Tool } from "./registry.js";
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
  isHdsMemoryArtifact,
  resolveFileSearchRoot,
  resolveSandboxFilePath,
  sandboxRootFromEnv,
  walkFiles,
} from "./file_safety.js";
import { shellExecTool } from "./shell_exec.js";
import {
  BROWSER_SEARCH_FORM_EDITABLE_INPUT_TYPES,
  browserFormStateDigest,
  buildBrowserSearchFormGetUrl,
  parseBrowserFormInputArguments,
  parseBrowserFormGetArguments,
  parseBrowserLinkNavigationArguments,
  parseBrowserDownloadArguments,
  type BrowserFormGetArguments,
  type BrowserFormInputArguments,
  type BrowserLinkNavigationArguments,
  type BrowserDownloadArguments,
  type BrowserSearchFormSnapshot,
} from "./browser_form_submission.js";
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
  readGoogleCalendarEventReceipt,
  invokeGoogleDriveRead,
  type GmailAttachmentIdentity,
  type GmailReadMessage,
  type GoogleCalendarIdentityValue,
  type GoogleCalendarEvent,
  type GoogleCalendarEventReceiptLookup,
  type GoogleCalendarFreeBusyInterval,
  type GoogleCalendarParticipantIdentity,
  type GoogleCalendarTimeIdentity,
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
  gmailWriteTargetIdentityDigest,
  invokeGoogleCalendarWrite,
  googleCalendarCreateEventId,
  googleCalendarWriteRequestPayloadDigest,
  googleCalendarWriteTargetIdentityDigest,
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
const BROWSER_FORM_RESPONSE_MAX_BYTES = 512_000;
const BROWSER_DOWNLOAD_DEFAULT_MAX_BYTES = 64_000;
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

function unambiguousHeaderString(value: string | string[] | number | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0] ?? null : null;
  return headerString(value);
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
    raw === "form_fill" ||
    raw === "form_submit" ||
    raw === "download" ||
    raw === "upload"
  ) {
    return raw;
  }
  throw new Error("action must be smoke, navigate, click, form_fill, form_submit, download, or upload");
}

function isWellFormedBrowserLinkName(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
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
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return value;
}

function githubRepositoryFullNameArg(value: unknown, name: string): { owner: string; repo: string; fullName: string } {
  if (typeof value !== "string" || value.length > 201 || value !== value.trim()) {
    throw new Error(`${name} must be an owner/repo name`);
  }
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error(`${name} must be an owner/repo name`);
  const [owner, repo] = parts;
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) ||
      owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error(`${name} must be an owner/repo name`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function githubBaseRefArg(value: string): string {
  return githubBranchRefArg(value, "base_ref");
}

function githubBranchRefArg(value: string, name: string): string {
  const segments = value.split("/");
  if (value.length > 255 || value !== value.trim() || value === "@" ||
      value.startsWith("/") || value.endsWith("/") || value.includes("//") ||
      value.includes("..") || value.includes("@{") || /[\u0000-\u0020\u007f~^:?*\\\[]/.test(value) ||
      value.endsWith(".") || segments.some((segment) => !segment || segment === "." || segment === ".." ||
        segment.startsWith(".") || segment.endsWith(".lock") || segment.endsWith("."))) {
    throw new Error(`${name} is not a valid GitHub branch name`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
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
  if (resource === "base") {
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
  throw new Error("resource must be repo, base, issue, issues, pr, or prs");
}

function requireGitHubJsonRecord(response: GitHubReadResponse, label: string): Record<string, unknown> {
  if (response.status !== 200 || !response.ok || response.truncated ||
      !response.content_type?.toLowerCase().includes("json")) {
    throw new Error(`github.read ${label} identity is incomplete; base_identity=unavailable`);
  }
  const value = parseJsonOrText(response.body);
  if (!isRecord(value)) {
    throw new Error(`github.read ${label} identity is invalid; base_identity=unavailable`);
  }
  return value;
}

function requireGitHubJsonArray(response: GitHubReadResponse, label: string): unknown[] {
  if (response.status !== 200 || !response.ok || response.truncated ||
      !response.content_type?.toLowerCase().includes("json")) {
    throw new Error(`github.read ${label} is incomplete; target_version=unavailable`);
  }
  const value = parseJsonOrText(response.body);
  if (!Array.isArray(value)) throw new Error(`github.read ${label} is invalid; target_version=unavailable`);
  return value;
}

async function readGitHubBaseIdentity(
  args: Record<string, unknown>,
  request: NonNullable<GitHubReadOptions["request"]>,
  maxBytes: number,
  signal?: AbortSignal,
  token?: string,
): Promise<unknown> {
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const requestedBaseRefValue = args.base_ref;
  if (requestedBaseRefValue !== undefined &&
      (typeof requestedBaseRefValue !== "string" || requestedBaseRefValue.length === 0)) {
    throw new Error("base_ref must be a non-empty branch name when provided");
  }
  const requestedBaseRef = requestedBaseRefValue as string | undefined;
  const encodedRequestedBaseRef = requestedBaseRef === undefined ? undefined : githubBaseRefArg(requestedBaseRef);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  assertToolExecutionNotCancelled(signal, "github.read");
  const repositoryResponse = await request({ path: repoPath, maxBytes, ...(token ? { token } : {}) }, signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerRecord = isRecord(repository.owner) ? repository.owner : null;
  const ownerLogin = ownerRecord && typeof ownerRecord.login === "string" ? ownerRecord.login : "";
  const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch : "";
  const sameRequestedRepository = fullName.toLocaleLowerCase("en-US") === `${owner}/${repo}`.toLocaleLowerCase("en-US") &&
    repositoryName.toLocaleLowerCase("en-US") === repo.toLocaleLowerCase("en-US") &&
    ownerLogin.toLocaleLowerCase("en-US") === owner.toLocaleLowerCase("en-US");
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !sameRequestedRepository || !defaultBranch) {
    throw new Error("github.read repository identity did not match the requested owner/repo; base_identity=unavailable");
  }

  const baseRef = requestedBaseRef ?? defaultBranch;
  const encodedBaseRef = encodedRequestedBaseRef ?? githubBaseRefArg(baseRef);
  assertToolExecutionNotCancelled(signal, "github.read");
  const branchPath = `${repoPath}/branches/${encodedBaseRef}`;
  const branchResponse = await request({ path: branchPath, maxBytes, ...(token ? { token } : {}) }, signal);
  const branch = requireGitHubJsonRecord(branchResponse, "base branch");
  const commit = isRecord(branch.commit) ? branch.commit : null;
  const commitSha = commit && typeof commit.sha === "string" ? commit.sha.toLowerCase() : "";
  if (branch.name !== baseRef || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) {
    throw new Error("github.read base branch did not resolve to the requested ref and an exact commit; base_identity=unavailable");
  }

  assertToolExecutionNotCancelled(signal, "github.read");
  const confirmationResponse = await request({ path: repoPath, maxBytes, ...(token ? { token } : {}) }, signal);
  const confirmation = requireGitHubJsonRecord(confirmationResponse, "repository confirmation");
  const confirmationOwner = isRecord(confirmation.owner) && typeof confirmation.owner.login === "string"
    ? confirmation.owner.login : "";
  if (confirmation.id !== repositoryId || confirmation.full_name !== fullName ||
      confirmationOwner.toLocaleLowerCase("en-US") !== ownerLogin.toLocaleLowerCase("en-US") ||
      (!requestedBaseRef && confirmation.default_branch !== defaultBranch)) {
    throw new Error("github.read repository identity changed during base resolution; base_identity=unavailable");
  }

  const identity = {
    schema_version: "blue-tanuki.github.base-identity.v1",
    repository_id: repositoryId,
    full_name: fullName,
    requested_owner: owner,
    requested_repo: repo,
    default_branch: defaultBranch,
    base_ref: baseRef,
    base_commit_sha: commitSha,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    used_for_authority: false,
    mutation_sent: false,
  };
  return {
    resource: "base",
    api_host: "api.github.com",
    paths: [repoPath, branchPath, repoPath],
    status: confirmationResponse.status,
    content_type: confirmationResponse.content_type,
    truncated: false,
    rate_limit_remaining: confirmationResponse.rate_limit_remaining,
    requests: 3,
    data: identity,
    identity_digest: sha256Hex(identity),
  };
}

async function readGitHubRepositoryNetworkIdentity(input: {
  owner: string;
  repo: string;
  request: NonNullable<GitHubReadOptions["request"]>;
  max_bytes: number;
  signal?: AbortSignal;
  token: string;
}): Promise<{ id: number; full_name: string; visibility: "public" | "private"; is_fork: boolean; network_root_id: number }> {
  const requested = `${input.owner}/${input.repo}`;
  assertToolExecutionNotCancelled(input.signal, "github.write pr.create repository network inspection");
  const response = await input.request({ path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
    maxBytes: input.max_bytes, token: input.token }, input.signal);
  const repository = requireGitHubJsonRecord(response, "pull request repository network");
  const owner = isRecord(repository.owner) && typeof repository.owner.login === "string" ? repository.owner.login : "";
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const name = typeof repository.name === "string" ? repository.name : "";
  const isFork = repository.fork;
  if (typeof repository.id !== "number" || !Number.isSafeInteger(repository.id) || repository.id <= 0 ||
      typeof repository.private !== "boolean" || typeof isFork !== "boolean" ||
      owner.toLowerCase() !== input.owner.toLowerCase() || name.toLowerCase() !== input.repo.toLowerCase() ||
      fullName.toLowerCase() !== requested.toLowerCase()) {
    throw new Error("github.write pr.create repository network identity is incomplete or mismatched; mutation_sent=false");
  }
  let networkRootId = repository.id;
  if (isFork) {
    const source = isRecord(repository.source) ? repository.source : null;
    const sourceId = source?.id;
    if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId === repository.id) {
      throw new Error("github.write pr.create fork network root is unavailable; mutation_sent=false; status=BUILD_GAP");
    }
    networkRootId = sourceId;
  }
  return { id: repository.id, full_name: fullName, visibility: repository.private ? "private" : "public",
    is_fork: isFork, network_root_id: networkRootId };
}

const GITHUB_ANNOTATED_TAG_CHAIN_MAX_DEPTH = 16;

async function resolveGitHubTagTargetCommit(input: {
  repository_path: string;
  target_sha: string;
  target_type: "commit" | "tag";
  read_request: NonNullable<GitHubWriteOptions["read_request"]>;
  max_bytes: number;
  token: string;
  signal?: AbortSignal;
  context: string;
}): Promise<string> {
  let targetSha = input.target_sha;
  let targetType = input.target_type;
  const visited = new Set<string>();
  for (let depth = 0; targetType === "tag"; depth += 1) {
    if (depth >= GITHUB_ANNOTATED_TAG_CHAIN_MAX_DEPTH) {
      throw new Error(`${input.context} annotated tag chain exceeds the supported depth; mutation_sent=false; status=BUILD_GAP`);
    }
    if (visited.has(targetSha)) {
      throw new Error(`${input.context} annotated tag chain contains a cycle; mutation_sent=false`);
    }
    visited.add(targetSha);
    assertToolExecutionNotCancelled(input.signal, `${input.context} annotated tag inspection`);
    const response = await input.read_request({
      path: `${input.repository_path}/git/tags/${targetSha}`,
      maxBytes: input.max_bytes,
      token: input.token,
    }, input.signal);
    const annotatedTag = requireGitHubJsonRecord(response, input.context + " annotated tag");
    const target = isRecord(annotatedTag.object) ? annotatedTag.object : null;
    if (typeof target?.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.sha) ||
        (target.type !== "commit" && target.type !== "tag")) {
      throw new Error(`${input.context} annotated tag target is incomplete or unsupported; mutation_sent=false; status=BUILD_GAP`);
    }
    targetSha = target.sha;
    targetType = target.type;
  }
  if (targetType !== "commit") {
    throw new Error(`${input.context} tag does not resolve to a commit; mutation_sent=false; status=BUILD_GAP`);
  }
  return targetSha;
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

type GitHubPullRequestInlineCommentLocation = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
};

function githubPullRequestInlineCommentLocation(args: Record<string, unknown>): GitHubPullRequestInlineCommentLocation | undefined {
  const kind = args.comment_kind;
  const hasLocation = args.path !== undefined || args.start_line !== undefined || args.start_side !== undefined ||
    args.line !== undefined || args.side !== undefined;
  if (kind !== undefined && kind !== "pull_request_timeline" && kind !== "pull_request_review_inline") {
    throw new Error("comment_kind must be pull_request_timeline or pull_request_review_inline");
  }
  if (kind !== "pull_request_review_inline") {
    if (hasLocation) throw new Error("inline review path, line, and side require comment_kind=pull_request_review_inline");
    return undefined;
  }
  const path = args.path;
  const line = args.line;
  const side = args.side;
  const startLine = args.start_line;
  const startSide = args.start_side;
  if (typeof path !== "string" || path.length === 0 || path.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000 ||
      (side !== "LEFT" && side !== "RIGHT") ||
      (startLine === undefined) !== (startSide === undefined) ||
      (startLine !== undefined && (typeof startLine !== "number" || !Number.isSafeInteger(startLine) ||
        startLine < 1 || (startLine === line && startSide === side) || startLine > 1_000_000 ||
        (startSide !== "LEFT" && startSide !== "RIGHT")))) {
    throw new Error("inline review comment requires a safe relative path, positive line, and LEFT or RIGHT side");
  }
  return { path, line, side,
    ...(typeof startLine === "number" && (startSide === "LEFT" || startSide === "RIGHT")
      ? { start_line: startLine, start_side: startSide } : {}) };
}

function githubWriteRoute(args: Record<string, unknown>, inlineCommitSha?: string): {
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
    const commentBody = stringArg(args, "body")!;
    if (commentBody.length > 500_000) throw new Error("body exceeds the 500000-character application limit");
    if (operation === "pr.comment.create") {
      const location = githubPullRequestInlineCommentLocation(args);
      if (location) {
        if (inlineCommitSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inlineCommitSha)) {
          throw new Error("inline review comment requires the observed pull request head commit SHA");
        }
        return {
          operation,
          method: "POST",
          path: `/repos/${ownerPath}/${repoPath}/pulls/${number}/comments`,
          body: { body: commentBody, path: location.path, line: location.line, side: location.side,
            ...(location.start_line === undefined || location.start_side === undefined ? {} : {
              start_line: location.start_line, start_side: location.start_side,
            }),
            ...(inlineCommitSha ? { commit_id: inlineCommitSha } : {}) },
          repo,
        };
      }
      if (args.comment_kind !== undefined && args.comment_kind !== "pull_request_timeline") {
        throw new Error("unsupported pull request comment kind");
      }
    }
    return {
      operation,
      method: "POST",
      path: `/repos/${ownerPath}/${repoPath}/issues/${number}/comments`,
      body: { body: commentBody },
      repo,
    };
  }

  if (operation === "issue.close") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key))) {
      throw new Error("issue.close only accepts the exact repository and issue number; mutation_sent=false");
    }
    return {
      operation,
      method: "PATCH",
      path: `/repos/${ownerPath}/${repoPath}/issues/${number}`,
      body: { state: "closed" },
      repo,
    };
  }

  if (operation === "issue.reopen") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key))) {
      throw new Error("issue.reopen only accepts the exact repository and issue number; mutation_sent=false");
    }
    return {
      operation,
      method: "PATCH",
      path: `/repos/${ownerPath}/${repoPath}/issues/${number}`,
      body: { state: "open" },
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
      throw new Error("issue.update requires title or body; close/reopen are separate operations");
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
    const head = stringArg(args, "head")!;
    const base = stringArg(args, "base")!;
    githubBranchRefArg(head, "head");
    githubBranchRefArg(base, "base");
    const baseFullName = `${owner}/${repoName}`;
    const headRepository = args.head_repository === undefined
      ? { owner, repo: repoName, fullName: baseFullName }
      : githubRepositoryFullNameArg(args.head_repository, "head_repository");
    const crossRepository = headRepository.fullName.toLowerCase() !== baseFullName.toLowerCase();
    if (!crossRepository && head === base) {
      throw new Error("pr.create head and base must identify different branches in the same repository; mutation_sent=false");
    }
    const body: Record<string, unknown> = {
      title: stringArg(args, "title")!,
      head: crossRepository ? `${headRepository.owner}:${head}` : head,
      base,
      draft: githubBoolArg(args, "draft", false),
    };
    if (crossRepository) body.head_repo = headRepository.repo;
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

  if (operation === "pr.merge") {
    const number = requiredPositiveIntArg(args, "number", 1_000_000);
    const expectedHeadSha = stringArg(args, "expected_head_sha")!;
    const mergeMethod = stringArg(args, "merge_method")!;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHeadSha) ||
        (mergeMethod !== "merge" && mergeMethod !== "squash" && mergeMethod !== "rebase") ||
        Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "expected_head_sha",
          "merge_method", "max_bytes"].includes(key))) {
      throw new Error("github.write pr.merge requires an exact expected head SHA and explicit merge method; mutation_sent=false");
    }
    return {
      operation,
      method: "PUT",
      path: `/repos/${ownerPath}/${repoPath}/pulls/${number}/merge`,
      body: { sha: expectedHeadSha, merge_method: mergeMethod },
      repo,
    };
  }

  if (operation === "code.push") {
    const branch = stringArg(args, "branch")!;
    githubBranchRefArg(branch, "branch");
    const expectedHeadSha = stringArg(args, "expected_head_sha")!;
    const filePath = stringArg(args, "path")!;
    const content = stringArg(args, "content")!;
    const commitMessage = stringArg(args, "commit_message")!;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHeadSha) ||
        filePath.length > 4_096 || filePath.startsWith("/") || filePath.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(filePath) ||
        filePath.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        content.includes("\u0000") || Buffer.from(content, "utf8").toString("utf8") !== content ||
        Buffer.byteLength(content, "utf8") > 65_536 || commitMessage.length > 256 || commitMessage.trim() !== commitMessage ||
        /[\u0000-\u001f\u007f]/.test(commitMessage) ||
        Object.keys(args).some((key) => !["operation", "owner", "repo", "branch", "expected_head_sha",
          "path", "content", "commit_message", "max_bytes"].includes(key))) {
      throw new Error("github.write code.push requires one bounded new UTF-8 file and exact expected branch head; mutation_sent=false");
    }
    return {
      operation,
      method: "POST",
      path: "/graphql",
      body: { branch, expected_head_sha: expectedHeadSha, path: filePath, content, commit_message: commitMessage },
      repo,
    };
  }

  if (operation === "release.draft.create") {
    const tagName = stringArg(args, "tag_name")!;
    githubBranchRefArg(tagName, "tag_name");
    const targetCommitSha = stringArg(args, "target_commit_sha")!;
    const name = stringArg(args, "name")!;
    const releaseBody = githubOptionalBody(args);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(targetCommitSha) || name.length > 256 ||
        name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name) ||
        Object.keys(args).some((key) => !["operation", "owner", "repo", "tag_name", "target_commit_sha",
          "name", "body", "max_bytes"].includes(key))) {
      throw new Error("github.write release.draft.create requires one existing exact tag, target commit, and bounded name; mutation_sent=false");
    }
    const body: Record<string, unknown> = {
      tag_name: tagName,
      target_commitish: targetCommitSha,
      name,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
    };
    if (releaseBody !== undefined) body.body = releaseBody;
    return {
      operation,
      method: "POST",
      path: `/repos/${ownerPath}/${repoPath}/releases`,
      body,
      repo,
    };
  }

  throw new Error(
    "operation must be issue.create, issue.update, issue.close, issue.reopen, issue.comment.create, pr.create, pr.merge, pr.comment.create, code.push, or release.draft.create",
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
        const contentType = unambiguousHeaderString(res.headers["content-type"]);
        const contentDisposition = unambiguousHeaderString(res.headers["content-disposition"]);
        const rawContentEncoding = res.headers["content-encoding"];
        const contentEncoding = Array.isArray(rawContentEncoding) && rawContentEncoding.length > 1
          ? "multiple-values" : unambiguousHeaderString(rawContentEncoding);
        const location = headerString(res.headers.location);
        if (method === "HEAD") {
          res.resume();
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            content_disposition: contentDisposition,
            content_encoding: contentEncoding,
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
              content_disposition: contentDisposition,
              content_encoding: contentEncoding,
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
            content_disposition: contentDisposition,
            content_encoding: contentEncoding,
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
          ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
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

interface HttpFetchResult extends Omit<HttpFetchResponse, "location"> {
  url: string;
}

async function fetchHttpResponse(
  args: Record<string, unknown>,
  opts: HttpFetchOptions = {},
  allowRedirect?: (from: URL, to: URL) => boolean,
): Promise<HttpFetchResult> {
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
      const nextUrl = parseHttpUrl(new URL(res.location, url).href);
      if (allowRedirect && !allowRedirect(url, nextUrl)) {
        throw new Error("http.fetch redirect target rejected by request policy");
      }
      url = nextUrl;
      continue;
    }
    return {
      url: url.href,
      status: res.status,
      ok: res.ok,
      content_type: res.content_type,
      content_disposition: res.content_disposition,
      content_encoding: res.content_encoding,
      body: res.body,
      truncated: res.truncated,
    };
  }
}

export async function invokeHttpFetch(
  args: Record<string, unknown>,
  opts: HttpFetchOptions = {},
): Promise<unknown> {
  const fetched = await fetchHttpResponse(args, opts);
  return {
    url: fetched.url,
    status: fetched.status,
    ok: fetched.ok,
    content_type: fetched.content_type,
    body: fetched.body,
    truncated: fetched.truncated,
  };
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
  if (route.resource === "base") {
    return await readGitHubBaseIdentity(args, request, maxBytes, opts.signal);
  }
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
  if (route.operation === "issue.close") return await invokeGitHubIssueClose(args, opts);
  if (route.operation === "issue.reopen") return await invokeGitHubIssueReopen(args, opts);
  if (route.operation === "issue.update") return await invokeGitHubIssueUpdate(args, opts);
  if (route.operation === "issue.comment.create") return await invokeGitHubIssueCommentCreate(args, opts);
  if (route.operation === "pr.comment.create") return await invokeGitHubPullRequestCommentCreate(args, opts);
  if (route.operation === "pr.create") return await invokeGitHubPullRequestCreate(args, opts);
  if (route.operation === "pr.merge") return await invokeGitHubPullRequestMerge(args, opts);
  if (route.operation === "code.push") return await invokeGitHubCodePush(args, opts);
  if (route.operation === "release.draft.create") return await invokeGitHubReleaseDraftCreate(args, opts);
  if (route.operation !== "issue.create") {
    throw new Error(`github.write ${route.operation} is not connected to a plan-bound review path; mutation_sent=false; status=BUILD_GAP`);
  }
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write issue.create requires a command and Operation Plan binding; mutation_sent=false");
  }
  if (!opts.expected_target_version_observation) {
    throw new Error("github.write issue.create requires an approved target version observation; mutation_sent=false");
  }
  const expected = assertGitHubIssueCreateTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubIssueCreateTargetVersion(args, {
    env,
    signal: opts.signal,
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !==
      canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write issue.create repository target changed after review; mutation_sent=false; outcome=stale");
  }
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: route.method, path: route.path, body: route.body, maxBytes, token }, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_request_failed";
    throw new Error(`github.write issue.create outcome_unknown; do not retry automatically; check GitHub before a new Owner decision; ${message}`);
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 201 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "issue.create",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: route.method,
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    const message = typeof data === "object" && data !== null && !Array.isArray(data)
      ? optionalString((data as Record<string, unknown>).message)
      : null;
    throw new Error(
      `github.write issue.create outcome_unknown; HTTP ${response.status}; do not retry automatically; check GitHub before a new Owner decision${message ? `; message=${message}` : ""}`,
    );
  }
  const issue = isRecord(data) ? data : null;
  const expectedBody = typeof args.body === "string" ? args.body : undefined;
  const returnedBody = issue?.body;
  if (!issue || typeof issue.id !== "number" || !Number.isSafeInteger(issue.id) || issue.id <= 0 ||
      typeof issue.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number <= 0 ||
      issue.title !== args.title || returnedBody !== (expectedBody ?? null)) {
    throw new Error("github.write issue.create response did not confirm the exact created issue; outcome_unknown; do not retry automatically");
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "issue.create",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: route.method,
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: { id: issue.id, number: issue.number, title: issue.title },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

export async function inspectGitHubCodePushTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubCodePushTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "code.push") throw new Error("github.write code.push target operation mismatch");
  const allowedKeys = ["operation", "owner", "repo", "branch", "expected_head_sha", "path", "content",
    "commit_message", "max_bytes"];
  if (Object.keys(args).some((key) => !allowedKeys.includes(key))) {
    throw new Error("github.write code.push contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write code.push target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const branch = stringArg(args, "branch")!;
  const expectedHeadSha = stringArg(args, "expected_head_sha")!;
  const pathValue = stringArg(args, "path")!;
  const content = stringArg(args, "content")!;
  const commitMessage = stringArg(args, "commit_message")!;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHeadSha) ||
      pathValue.length > 4_096 || pathValue.startsWith("/") || pathValue.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(pathValue) ||
      pathValue.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      content.includes("\u0000") || Buffer.from(content, "utf8").toString("utf8") !== content ||
      Buffer.byteLength(content, "utf8") > 65_536 || commitMessage.length > 256 || commitMessage.trim() !== commitMessage ||
      /[\u0000-\u001f\u007f]/.test(commitMessage)) {
    throw new Error("github.write code.push parameters are invalid or exceed the bounded create-only contract; mutation_sent=false");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const repositoryResponse = await readRequest({ path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    maxBytes, token }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "code push repository");
  const repositoryOwner = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch : "";
  if (typeof repository.id !== "number" || !Number.isSafeInteger(repository.id) || repository.id <= 0 ||
      repositoryOwner.toLowerCase() !== owner.toLowerCase() ||
      fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase() || typeof repository.private !== "boolean" ||
      !defaultBranch || defaultBranch === branch) {
    throw new Error("github.write code.push requires the requested repository and a non-default branch; mutation_sent=false");
  }
  const branchSnapshot = await readGitHubBaseIdentity({ owner, repo, base_ref: branch }, readRequest, maxBytes,
    opts.signal, token);
  const base = isRecord(branchSnapshot) && isRecord(branchSnapshot.data) ? branchSnapshot.data : null;
  if (!base || base.schema_version !== "blue-tanuki.github.base-identity.v1" ||
      base.repository_id !== repository.id || base.full_name !== fullName || base.default_branch !== defaultBranch ||
      base.base_ref !== branch || base.base_commit_sha !== expectedHeadSha) {
    throw new Error("github.write code.push expected branch HEAD is stale or the repository identity changed; mutation_sent=false");
  }
  const encodedPath = pathValue.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const fileObservation = await readRequest({ path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, maxBytes, token }, opts.signal);
  if (fileObservation.status !== 404 || fileObservation.ok || fileObservation.truncated) {
    throw new Error("github.write code.push only creates a file that is absent at the reviewed branch head; mutation_sent=false");
  }
  const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
  return GitHubCodePushTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "code.push",
    repository_id: repository.id,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: repository.private ? "private" : "public",
    default_branch: defaultBranch,
    branch,
    expected_head_sha: expectedHeadSha,
    path: pathValue,
    target_identity_digest: githubCodePushTargetIdentityDigest({ repository_id: repository.id,
      canonical_full_name: fullName, default_branch: defaultBranch, branch, expected_head_sha: expectedHeadSha,
      path: pathValue }),
    request_payload_digest: githubCodePushRequestPayloadDigest({ owner, repo, branch, expected_head_sha: expectedHeadSha,
      path: pathValue, content, commit_message: commitMessage }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubCodePushTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubCodePushTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "code.push") throw new Error("github.write code.push target operation mismatch");
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const branch = stringArg(args, "branch")!;
  const expectedHeadSha = stringArg(args, "expected_head_sha")!;
  const pathValue = stringArg(args, "path")!;
  const content = stringArg(args, "content")!;
  const commitMessage = stringArg(args, "commit_message")!;
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "branch", "expected_head_sha", "path",
        "content", "commit_message", "max_bytes"].includes(key)) || route.operation !== "code.push" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      observation.branch !== branch || observation.expected_head_sha !== expectedHeadSha || observation.path !== pathValue ||
      observation.branch === observation.default_branch || observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== githubCodePushRequestPayloadDigest({ owner, repo, branch,
        expected_head_sha: expectedHeadSha, path: pathValue, content, commit_message: commitMessage }) ||
      observation.target_identity_digest !== githubCodePushTargetIdentityDigest({ repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name, default_branch: observation.default_branch, branch,
        expected_head_sha: expectedHeadSha, path: pathValue }) || observation.mutation_sent ||
      observation.used_for_authority || observation.may_execute || observation.provider_observation_is_atomic ||
      !observation.provider_data_is_untrusted) {
    throw new Error("github.write code.push target observation does not match the reviewed command and plan");
  }
  return observation;
}

export async function inspectGitHubCodePushContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubCodePushContentReview> {
  const observation = await inspectGitHubCodePushTargetVersion(args, opts);
  const route = githubWriteRoute(args);
  const content = String(route.body.content);
  const base = {
    kind: "github_code_push" as const,
    operation: "github.write.code.push" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    default_branch: observation.default_branch,
    branch: observation.branch,
    expected_head_sha: observation.expected_head_sha,
    path: observation.path,
    content,
    content_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    commit_message: String(route.body.commit_message),
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    publication_effect: "visible_to_repository_audience" as const,
    notification_effect: "github_api_may_trigger_notifications" as const,
    branch_update_is_conditional: true as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

async function invokeGitHubCodePush(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const route = githubWriteRoute(args);
  if (route.operation !== "code.push" || route.path !== "/graphql" || route.method !== "POST") {
    throw new Error("github.write code.push route mismatch; branch_update_sent=false");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write code.push requires a command, Operation Plan binding, and reviewed target; branch_update_sent=false");
  }
  const expected = assertGitHubCodePushTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const current = await inspectGitHubCodePushTargetVersion(args, { env, signal: opts.signal,
    command_digest: commandDigest, operation_plan_binding_digest: operationPlanBindingDigest, read_request: readRequest });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write code.push branch or file changed after review; branch_update_sent=false; outcome=stale");
  }

  const content = String(route.body.content);
  const graphQlQuery = "mutation BlueTanukiCreateCommitOnBranch($input: CreateCommitOnBranchInput!) { " +
    "createCommitOnBranch(input: $input) { " +
    "commit { oid parents(first: 2) { nodes { oid } } } " +
    "ref { name target { oid } } } }";
  const graphQlInput = {
    branch: { repositoryNameWithOwner: expected.canonical_full_name, branchName: expected.branch },
    expectedHeadOid: expected.expected_head_sha,
    fileChanges: { additions: [{ path: expected.path, contents: Buffer.from(content, "utf8").toString("base64") }] },
    message: { headline: String(route.body.commit_message) },
  };
  const request = opts.request ?? defaultGitHubWriteRequest;
  let response: GitHubWriteResponse;
  try {
    assertToolExecutionNotCancelled(opts.signal, "github.write code.push conditional branch commit");
    response = await request({ method: "POST", path: "/graphql",
      body: { query: graphQlQuery, variables: { input: graphQlInput } }, maxBytes, token }, opts.signal);
  } catch {
    throw new Error("github.write code.push conditional commit outcome_unknown; branch_update_sent=true; do not retry automatically");
  }

  const responseData = parseJsonOrText(response.body);
  const envelope = isRecord(responseData) ? responseData : null;
  const payload = envelope && isRecord(envelope.data) && isRecord(envelope.data.createCommitOnBranch)
    ? envelope.data.createCommitOnBranch : null;
  const explicitRejection = !response.ok && !response.truncated &&
    [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
  if (explicitRejection) {
    return {
      schema_version: "blue-tanuki.github-write-result.v1", operation: "code.push", api_host: "api.github.com",
      repo: route.repo, repository_id: expected.repository_id, target_identity_digest: expected.target_identity_digest,
      request_payload_digest: expected.request_payload_digest, command_digest: expected.command_digest,
      operation_plan_binding_digest: expected.operation_plan_binding_digest, method: route.method, path: route.path,
      status: response.status, mutation_status: "provider_rejected", result_digest: sha256Hex(responseData),
      retry_permitted: false,
      next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
      provider_data_is_untrusted: true, used_for_authority: false, may_execute: false,
    };
  }
  if (!response.ok || response.status !== 200 || response.truncated ||
      !response.content_type?.toLowerCase().includes("json") || !payload ||
      (Array.isArray(envelope?.errors) && envelope.errors.length > 0)) {
    throw new Error(`github.write code.push conditional commit outcome_unknown; HTTP ${response.status}; ` +
      "do not retry automatically; inspect the branch before a new Owner decision");
  }
  const commit = isRecord(payload.commit) ? payload.commit : null;
  const commitOid = commit?.oid;
  const parents = commit && isRecord(commit.parents) && Array.isArray(commit.parents.nodes) ? commit.parents.nodes : [];
  const parentOid = parents.length === 1 && isRecord(parents[0]) ? parents[0].oid : undefined;
  const updatedRef = isRecord(payload.ref) ? payload.ref : null;
  const updatedRefTarget = updatedRef && isRecord(updatedRef.target) ? updatedRef.target : null;
  if (typeof commitOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitOid) ||
      parentOid !== expected.expected_head_sha || updatedRefTarget?.oid !== commitOid ||
      (updatedRef?.name !== expected.branch && updatedRef?.name !== `refs/heads/${expected.branch}`)) {
    throw new Error("github.write code.push conditional commit response did not confirm the reviewed parent and ref; outcome_unknown; do not retry automatically");
  }
  const afterSnapshot = await readGitHubBaseIdentity({ owner: args.owner, repo: args.repo, base_ref: args.branch },
    readRequest, maxBytes, opts.signal, token);
  const after = isRecord(afterSnapshot) && isRecord(afterSnapshot.data) ? afterSnapshot.data : null;
  if (!after || after.base_commit_sha !== commitOid || after.repository_id !== expected.repository_id ||
      after.full_name !== expected.canonical_full_name || after.default_branch !== expected.default_branch) {
    throw new Error("github.write code.push result could not be independently confirmed; outcome_unknown; do not retry automatically");
  }
  const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
  const result = { branch: args.branch, commit_sha: commitOid, parent_sha: expected.expected_head_sha,
    path: expected.path, content_sha256: contentDigest };
  return {
    schema_version: "blue-tanuki.github-write-result.v1", operation: "code.push", api_host: "api.github.com",
    repo: route.repo, repository_id: expected.repository_id, target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest, command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest, method: route.method, path: route.path,
    status: response.status, mutation_status: "provider_accepted", content_type: response.content_type,
    truncated: response.truncated, rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id, result_digest: sha256Hex(result), result,
    provider_data_is_untrusted: true, used_for_authority: false, may_execute: false,
  };
}
async function invokeGitHubPullRequestCreate(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  if (route.operation !== "pr.create") throw new Error("github.write pr.create route mismatch; mutation_sent=false");
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write pr.create requires a command, Operation Plan binding, and approved target observation; mutation_sent=false");
  }
  const expected = assertGitHubPullRequestCreateTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubPullRequestCreateTargetVersion(args, {
    env,
    signal: opts.signal,
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write pr.create repository or branch target changed after review; mutation_sent=false; outcome=stale");
  }

  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write pr.create");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: route.method, path: route.path, body: route.body, maxBytes, token }, opts.signal);
  } catch {
    throw new Error("github.write pr.create outcome_unknown; do not retry automatically; check GitHub before a new Owner decision");
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 201 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "pr.create",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: route.method,
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    throw new Error("github.write pr.create outcome_unknown; HTTP " + response.status +
      "; do not retry automatically; check GitHub before a new Owner decision");
  }

  const pull = isRecord(data) ? data : null;
  const head = pull && isRecord(pull.head) ? pull.head : null;
  const base = pull && isRecord(pull.base) ? pull.base : null;
  const headRepo = head && isRecord(head.repo) ? head.repo : null;
  const baseRepo = base && isRecord(base.repo) ? base.repo : null;
  const expectedBody = typeof route.body.body === "string" ? route.body.body : null;
  const maintainerCanModify = route.body.maintainer_can_modify;
  if (!pull || typeof pull.id !== "number" || !Number.isSafeInteger(pull.id) || pull.id <= 0 ||
      typeof pull.number !== "number" || !Number.isSafeInteger(pull.number) || pull.number <= 0 ||
      pull.title !== route.body.title || pull.body !== expectedBody || pull.state !== "open" ||
      pull.draft !== expected.draft ||
      (typeof maintainerCanModify === "boolean" && pull.maintainer_can_modify !== maintainerCanModify) ||
      !head || !base || head.ref !== expected.head_ref || head.sha !== expected.head_commit_sha ||
      base.ref !== expected.base_ref || base.sha !== expected.base_commit_sha ||
      !headRepo || !baseRepo || headRepo.id !== expected.head_repository_id || baseRepo.id !== expected.repository_id ||
      typeof headRepo.full_name !== "string" ||
      headRepo.full_name.toLowerCase() !== expected.head_canonical_full_name.toLowerCase() ||
      typeof baseRepo.full_name !== "string" ||
      baseRepo.full_name.toLowerCase() !== expected.canonical_full_name.toLowerCase()) {
    throw new Error("github.write pr.create response did not confirm the reviewed pull request and branch tips; outcome_unknown; do not retry automatically");
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "pr.create",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: route.method,
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      head_repository_id: expected.head_repository_id,
      head_canonical_full_name: expected.head_canonical_full_name,
      head_ref: expected.head_ref,
      head_commit_sha: expected.head_commit_sha,
      base_ref: expected.base_ref,
      base_commit_sha: expected.base_commit_sha,
      draft: expected.draft,
      ...(typeof pull.maintainer_can_modify === "boolean"
        ? { maintainer_can_modify: pull.maintainer_can_modify } : {}),
    },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

async function invokeGitHubPullRequestMerge(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const route = githubWriteRoute(args);
  if (route.operation !== "pr.merge" || route.method !== "PUT") {
    throw new Error("github.write pr.merge route mismatch; mutation_sent=false");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write pr.merge requires a command, Operation Plan binding, and approved target observation; mutation_sent=false");
  }
  const expected = assertGitHubPullRequestMergeTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubPullRequestMergeTargetVersion(args, {
    env,
    signal: opts.signal,
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write pr.merge pull request or base branch changed after review; mutation_sent=false; outcome=stale");
  }

  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write pr.merge");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: route.method, path: route.path, body: route.body, maxBytes, token }, opts.signal);
  } catch {
    throw new Error("github.write pr.merge outcome_unknown; request may have reached GitHub; do not retry automatically; verify the pull request before a new Owner decision");
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 200 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 409, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "pr.merge",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: route.method,
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    throw new Error(`github.write pr.merge outcome_unknown; HTTP ${response.status}; do not retry automatically`);
  }

  const mergeResponse = isRecord(data) ? data : null;
  const mergeCommitSha = mergeResponse && typeof mergeResponse.sha === "string" ? mergeResponse.sha : "";
  if (!mergeResponse || mergeResponse.merged !== true ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeCommitSha)) {
    throw new Error("github.write pr.merge response did not confirm a merged commit; outcome_unknown; do not retry automatically");
  }

  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  let after: Record<string, unknown>;
  try {
    assertToolExecutionNotCancelled(opts.signal, "github.write pr.merge readback");
    const readResponse = await readRequest({
      path: `/repos/${encodeURIComponent(expected.requested_owner)}/${encodeURIComponent(expected.requested_repo)}/pulls/${expected.pull_request_number}`,
      maxBytes,
      token,
    }, opts.signal);
    after = requireGitHubJsonRecord(readResponse, "pr.merge result readback");
  } catch {
    throw new Error("github.write pr.merge outcome_unknown; readback could not confirm the merge; do not retry automatically");
  }
  const afterHead = isRecord(after.head) ? after.head : null;
  const afterHeadRepository = afterHead && isRecord(afterHead.repo) ? afterHead.repo : null;
  const afterBase = isRecord(after.base) ? after.base : null;
  const afterBaseRepository = afterBase && isRecord(afterBase.repo) ? afterBase.repo : null;
  if (after.id !== expected.pull_request_id || after.number !== expected.pull_request_number ||
      after.state !== "closed" || after.merged !== true || after.merge_commit_sha !== mergeCommitSha ||
      !afterHead || afterHead.ref !== expected.head_ref || afterHead.sha !== expected.head_sha ||
      !afterHeadRepository || afterHeadRepository.id !== expected.head_repository_id ||
      typeof afterHeadRepository.full_name !== "string" ||
      afterHeadRepository.full_name.toLowerCase() !== expected.head_canonical_full_name.toLowerCase() ||
      !afterBase || afterBase.ref !== expected.base_ref || !afterBaseRepository ||
      afterBaseRepository.id !== expected.repository_id ||
      typeof afterBaseRepository.full_name !== "string" ||
      afterBaseRepository.full_name.toLowerCase() !== expected.canonical_full_name.toLowerCase()) {
    throw new Error("github.write pr.merge readback did not confirm the exact reviewed pull request merge; outcome_unknown; do not retry automatically");
  }
  const result = {
    id: expected.pull_request_id,
    number: expected.pull_request_number,
    merge_commit_sha: mergeCommitSha,
    head_repository_id: expected.head_repository_id,
    head_canonical_full_name: expected.head_canonical_full_name,
    head_ref: expected.head_ref,
    head_sha: expected.head_sha,
    base_ref: expected.base_ref,
    merge_method: expected.merge_method,
  };
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "pr.merge",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: route.method,
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(result),
    result,
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

export async function inspectGitHubIssueCreateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubIssueCreateTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.create") {
    throw new Error(`github.write ${route.operation} target observation is not implemented; status=BUILD_GAP`);
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "title", "body", "max_bytes"].includes(key))) {
    throw new Error("github.write issue.create contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write issue.create target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write target inspection");
  const response = await readRequest({ path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    maxBytes: positiveIntArg(args, "max_bytes", 128_000, 512_000), token }, opts.signal);
  const repository = requireGitHubJsonRecord(response, "write target repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  const isPrivate = repository.private;
  const sameRepository = fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase() &&
    repositoryName.toLowerCase() === repo.toLowerCase() && ownerLogin.toLowerCase() === owner.toLowerCase();
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !sameRepository || typeof isPrivate !== "boolean") {
    throw new Error("github.write issue.create repository identity or visibility is incomplete or mismatched");
  }
  return GitHubIssueCreateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "issue.create",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    target_identity_digest: githubIssueCreateTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: fullName }),
    request_payload_digest: githubIssueCreateRequestPayloadDigest({ owner, repo,
      title: String(route.body.title), ...(typeof route.body.body === "string" ? { body: route.body.body } : {}) }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubIssueCreateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubIssueCreateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "issue.create") {
    throw new Error("github.write issue.create target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const payloadDigest = githubIssueCreateRequestPayloadDigest({ owner, repo, title: String(route.body.title),
    ...(typeof route.body.body === "string" ? { body: route.body.body } : {}) });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "title", "body", "max_bytes"].includes(key)) ||
      route.operation !== "issue.create" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest ||
      observation.target_identity_digest !== githubIssueCreateTargetIdentityDigest({
        repository_id: observation.repository_id, canonical_full_name: observation.canonical_full_name,
      }) || observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write issue.create target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubIssueCreateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubIssueCreateContentReview> {
  const observation = await inspectGitHubIssueCreateTargetVersion(args, opts);
  const route = githubWriteRoute(args);
  const base = {
    kind: "github_issue_create" as const,
    operation: "github.write.issue.create" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    title: String(route.body.title),
    ...(typeof route.body.body === "string" ? { body: route.body.body } : {}),
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export async function inspectGitHubReleaseDraftCreateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubReleaseDraftCreateTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "release.draft.create") {
    throw new Error(`github.write ${route.operation} target observation is not implemented; status=BUILD_GAP`);
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "tag_name", "target_commit_sha", "name", "body", "max_bytes"].includes(key))) {
    throw new Error("github.write release.draft.create contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write release.draft.create target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const tagName = stringArg(args, "tag_name")!;
  githubBranchRefArg(tagName, "tag_name");
  const encodedTag = encodeURIComponent(tagName);
  const requestedCommit = stringArg(args, "target_commit_sha")!;
  const name = stringArg(args, "name")!;
  const body = githubOptionalBody(args);
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  assertToolExecutionNotCancelled(opts.signal, "github.write release.draft.create target inspection");
  const repositoryResponse = await readRequest({ path: repositoryPath, maxBytes, token }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "release draft target repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  const isPrivate = repository.private;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase() || repositoryName.toLowerCase() !== repo.toLowerCase() ||
      ownerLogin.toLowerCase() !== owner.toLowerCase() || typeof isPrivate !== "boolean") {
    throw new Error("github.write release.draft.create repository identity or visibility is incomplete or mismatched");
  }

  assertToolExecutionNotCancelled(opts.signal, "github.write release.draft.create tag inspection");
  const tagResponse = await readRequest({ path: `${repositoryPath}/git/ref/tags/${encodedTag}`, maxBytes, token }, opts.signal);
  const tagRecord = requireGitHubJsonRecord(tagResponse, "release draft tag");
  const tagObject = isRecord(tagRecord.object) ? tagRecord.object : null;
  const tagRefSha = tagObject?.sha;
  const tagRefType = tagObject?.type;
  if (typeof tagRefSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tagRefSha) ||
      (tagRefType !== "commit" && tagRefType !== "tag")) {
    throw new Error("github.write release.draft.create tag target is incomplete or unsupported; mutation_sent=false");
  }
  const targetCommitSha = await resolveGitHubTagTargetCommit({
    repository_path: repositoryPath,
    target_sha: tagRefSha,
    target_type: tagRefType,
    read_request: readRequest,
    max_bytes: maxBytes,
    token,
    signal: opts.signal,
    context: "github.write release.draft.create",
  });
  if (targetCommitSha !== requestedCommit) {
    throw new Error("github.write release.draft.create requested commit does not match the exact tag target; mutation_sent=false; outcome=stale");
  }

  assertToolExecutionNotCancelled(opts.signal, "github.write release.draft.create existing release inspection");
  const existingRelease = await readRequest({ path: `${repositoryPath}/releases/tags/${encodedTag}`, maxBytes, token }, opts.signal);
  if (existingRelease.status !== 404 || existingRelease.ok || existingRelease.truncated ||
      !existingRelease.content_type?.toLowerCase().includes("json")) {
    throw new Error("github.write release.draft.create requires the exact tag to have no existing release; mutation_sent=false");
  }

  return GitHubReleaseDraftCreateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "release.draft.create",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    tag_name: tagName,
    tag_ref_sha: tagRefSha,
    tag_ref_type: tagRefType,
    target_commit_sha: targetCommitSha,
    release_absent: true,
    target_identity_digest: githubReleaseDraftCreateTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: fullName, tag_name: tagName, tag_ref_sha: tagRefSha, tag_ref_type: tagRefType,
      target_commit_sha: targetCommitSha }),
    request_payload_digest: githubReleaseDraftCreateRequestPayloadDigest({ owner, repo, tag_name: tagName,
      target_commit_sha: targetCommitSha, name, ...(body === undefined ? {} : { body }) }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubReleaseDraftCreateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubReleaseDraftCreateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "release.draft.create") {
    throw new Error("github.write release.draft.create target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const tagName = stringArg(args, "tag_name")!;
  const targetCommitSha = stringArg(args, "target_commit_sha")!;
  const name = stringArg(args, "name")!;
  const body = githubOptionalBody(args);
  const targetDigest = githubReleaseDraftCreateTargetIdentityDigest({ repository_id: observation.repository_id,
    canonical_full_name: observation.canonical_full_name, tag_name: observation.tag_name,
    tag_ref_sha: observation.tag_ref_sha, tag_ref_type: observation.tag_ref_type,
    target_commit_sha: observation.target_commit_sha });
  const payloadDigest = githubReleaseDraftCreateRequestPayloadDigest({ owner, repo, tag_name: tagName,
    target_commit_sha: targetCommitSha, name, ...(body === undefined ? {} : { body }) });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "tag_name", "target_commit_sha", "name", "body", "max_bytes"].includes(key)) ||
      route.operation !== "release.draft.create" || observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      observation.tag_name !== tagName || observation.target_commit_sha !== targetCommitSha || !observation.release_absent ||
      observation.command_digest !== commandDigest || observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest || observation.target_identity_digest !== targetDigest ||
      observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write release.draft.create target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubReleaseDraftCreateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubReleaseDraftCreateContentReview> {
  const observation = await inspectGitHubReleaseDraftCreateTargetVersion(args, opts);
  const route = githubWriteRoute(args);
  const base = {
    kind: "github_release_draft_create" as const,
    operation: "github.write.release.draft.create" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    tag_name: observation.tag_name,
    tag_ref_sha: observation.tag_ref_sha,
    tag_ref_type: observation.tag_ref_type,
    target_commit_sha: observation.target_commit_sha,
    release_name: String(route.body.name),
    ...(typeof route.body.body === "string" ? { body: route.body.body } : {}),
    draft: true as const,
    prerelease: false as const,
    assets_added: false as const,
    release_published: false as const,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

async function invokeGitHubReleaseDraftCreate(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const route = githubWriteRoute(args);
  if (route.operation !== "release.draft.create" || route.method !== "POST" ||
      route.path !== `/repos/${encodeURIComponent(githubNameArg(args, "owner"))}/${encodeURIComponent(githubNameArg(args, "repo"))}/releases`) {
    throw new Error("github.write release.draft.create route mismatch; mutation_sent=false");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write release.draft.create requires a command, Operation Plan binding, and reviewed target; mutation_sent=false");
  }
  const expected = assertGitHubReleaseDraftCreateTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const before = await inspectGitHubReleaseDraftCreateTargetVersion(args, { env, signal: opts.signal,
    command_digest: commandDigest, operation_plan_binding_digest: operationPlanBindingDigest, read_request: readRequest });
  if (canonicalGitHubWriteTargetVersionObservation(before) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write release.draft.create repository, tag, or release state changed after review; mutation_sent=false; outcome=stale");
  }

  const request = opts.request ?? defaultGitHubWriteRequest;
  let response: GitHubWriteResponse;
  try {
    assertToolExecutionNotCancelled(opts.signal, "github.write release.draft.create create draft");
    response = await request({ method: "POST", path: route.path, body: route.body, maxBytes, token }, opts.signal);
  } catch {
    throw new Error("github.write release.draft.create outcome_unknown; request may have reached GitHub; do not retry automatically");
  }

  const responseData = parseJsonOrText(response.body);
  const explicitRejection = !response.ok && !response.truncated &&
    [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
  if (explicitRejection) {
    return {
      schema_version: "blue-tanuki.github-write-result.v1", operation: "release.draft.create", api_host: "api.github.com",
      repo: route.repo, repository_id: expected.repository_id, target_identity_digest: expected.target_identity_digest,
      request_payload_digest: expected.request_payload_digest, command_digest: expected.command_digest,
      operation_plan_binding_digest: expected.operation_plan_binding_digest, method: route.method, path: route.path,
      status: response.status, mutation_status: "provider_rejected", result_digest: sha256Hex(responseData),
      retry_permitted: false,
      next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
      provider_data_is_untrusted: true, used_for_authority: false, may_execute: false,
    };
  }
  if (!response.ok || response.status !== 201 || response.truncated ||
      !response.content_type?.toLowerCase().includes("json")) {
    throw new Error(`github.write release.draft.create outcome_unknown; HTTP ${response.status}; do not retry automatically`);
  }
  const created = isRecord(responseData) ? responseData : null;
  const requestedBody = typeof route.body.body === "string" ? route.body.body : undefined;
  const bodyMatches = created?.body === requestedBody ||
    (requestedBody === undefined || requestedBody === "") && (created?.body === null || created?.body === "");
  if (!created || typeof created.id !== "number" || !Number.isSafeInteger(created.id) || created.id <= 0 ||
      created.tag_name !== expected.tag_name || created.name !== route.body.name || !bodyMatches ||
      created.draft !== true || created.prerelease !== false || !Array.isArray(created.assets) || created.assets.length !== 0) {
    throw new Error("github.write release.draft.create response did not confirm the exact draft release; outcome_unknown; do not retry automatically");
  }

  try {
    assertToolExecutionNotCancelled(opts.signal, "github.write release.draft.create readback");
    const repositoryPath = `/repos/${encodeURIComponent(expected.requested_owner)}/${encodeURIComponent(expected.requested_repo)}`;
    const repositoryResponse = await readRequest({ path: repositoryPath, maxBytes, token }, opts.signal);
    const repository = requireGitHubJsonRecord(repositoryResponse, "draft release repository readback");
    if (repository.id !== expected.repository_id || repository.full_name !== expected.canonical_full_name ||
        repository.private !== (expected.repository_visibility === "private")) {
      throw new Error("repository identity or visibility changed");
    }

    const tagPath = `${repositoryPath}/git/ref/tags/${encodeURIComponent(expected.tag_name)}`;
    const tagResponse = await readRequest({ path: tagPath, maxBytes, token }, opts.signal);
    const tagRecord = requireGitHubJsonRecord(tagResponse, "draft release tag readback");
    const tagObject = isRecord(tagRecord.object) ? tagRecord.object : null;
    if (tagObject?.sha !== expected.tag_ref_sha || tagObject?.type !== expected.tag_ref_type) {
      throw new Error("tag reference changed");
    }
    const targetCommitSha = await resolveGitHubTagTargetCommit({
      repository_path: repositoryPath,
      target_sha: expected.tag_ref_sha,
      target_type: expected.tag_ref_type,
      read_request: readRequest,
      max_bytes: maxBytes,
      token,
      signal: opts.signal,
      context: "draft release readback",
    });
    if (targetCommitSha !== expected.target_commit_sha) throw new Error("tag target commit changed");

    const releasePath = `${repositoryPath}/releases/tags/${encodeURIComponent(expected.tag_name)}`;
    const releaseResponse = await readRequest({ path: releasePath, maxBytes, token }, opts.signal);
    const release = requireGitHubJsonRecord(releaseResponse, "draft release readback");
    const readbackBodyMatches = release.body === requestedBody ||
      (requestedBody === undefined || requestedBody === "") && (release.body === null || release.body === "");
    if (release.id !== created.id || release.tag_name !== expected.tag_name || release.name !== route.body.name ||
        !readbackBodyMatches || release.draft !== true || release.prerelease !== false ||
        !Array.isArray(release.assets) || release.assets.length !== 0) {
      throw new Error("release readback differs from the reviewed draft");
    }
  } catch {
    throw new Error("github.write release.draft.create readback could not confirm the exact draft and tag; outcome_unknown; do not retry automatically");
  }

  const result = { id: created.id, tag_name: expected.tag_name, target_commit_sha: expected.target_commit_sha,
    name: String(route.body.name), draft: true, prerelease: false };
  return {
    schema_version: "blue-tanuki.github-write-result.v1", operation: "release.draft.create", api_host: "api.github.com",
    repo: route.repo, repository_id: expected.repository_id, target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest, command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest, method: route.method, path: route.path,
    status: response.status, mutation_status: "provider_accepted", content_type: response.content_type,
    truncated: response.truncated, rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id, result_digest: sha256Hex(result), result,
    provider_data_is_untrusted: true, used_for_authority: false, may_execute: false,
  };
}

export async function inspectGitHubPullRequestCreateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubPullRequestCreateTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "pr.create") {
    throw new Error("github.write " + route.operation + " target observation is not implemented; status=BUILD_GAP");
  }
  const allowedArgs = ["operation", "owner", "repo", "title", "body", "head", "head_repository", "base", "draft",
    "maintainer_can_modify", "max_bytes"];
  if (Object.keys(args).some((key) => !allowedArgs.includes(key))) {
    throw new Error("github.write pr.create contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write pr.create target observation requires a command and Operation Plan binding");
  }

  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const headRef = stringArg(args, "head")!;
  const baseRef = stringArg(args, "base")!;
  const headRepository = args.head_repository === undefined
    ? { owner, repo, fullName: `${owner}/${repo}` }
    : githubRepositoryFullNameArg(args.head_repository, "head_repository");
  const crossRepository = headRepository.fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase();
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  if (crossRepository) assertGitHubRepoAllowed(env, headRepository.fullName);

  const baseSnapshot = await readGitHubBaseIdentity({ owner, repo, base_ref: baseRef }, readRequest,
    maxBytes, opts.signal, token);
  const headSnapshot = await readGitHubBaseIdentity({ owner: headRepository.owner, repo: headRepository.repo,
    base_ref: headRef }, readRequest,
    maxBytes, opts.signal, token);
  const baseIdentity = isRecord(baseSnapshot) && isRecord(baseSnapshot.data) ? baseSnapshot.data : null;
  const headIdentity = isRecord(headSnapshot) && isRecord(headSnapshot.data) ? headSnapshot.data : null;
  if (!baseIdentity || !headIdentity || baseIdentity.schema_version !== "blue-tanuki.github.base-identity.v1" ||
      headIdentity.schema_version !== "blue-tanuki.github.base-identity.v1" ||
      baseIdentity.base_ref !== baseRef || headIdentity.base_ref !== headRef ||
      typeof baseIdentity.base_commit_sha !== "string" || typeof headIdentity.base_commit_sha !== "string") {
    throw new Error("github.write pr.create branch observations did not identify the requested repositories and refs");
  }

  const baseRepository = await readGitHubRepositoryNetworkIdentity({ owner, repo, request: readRequest,
    max_bytes: maxBytes, signal: opts.signal, token });
  const headRepositoryIdentity = crossRepository
    ? await readGitHubRepositoryNetworkIdentity({ owner: headRepository.owner, repo: headRepository.repo,
      request: readRequest, max_bytes: maxBytes, signal: opts.signal, token })
    : baseRepository;
  if (baseRepository.id !== baseIdentity.repository_id || baseRepository.full_name !== baseIdentity.full_name ||
      headRepositoryIdentity.id !== headIdentity.repository_id || headRepositoryIdentity.full_name !== headIdentity.full_name) {
    throw new Error("github.write pr.create repository identity or visibility changed during branch observation");
  }
  if (crossRepository && (!headRepositoryIdentity.is_fork ||
      headRepositoryIdentity.network_root_id !== baseRepository.network_root_id)) {
    throw new Error("github.write pr.create head repository must be a fork in the base repository's GitHub network; mutation_sent=false; status=BUILD_GAP");
  }

  const body = typeof route.body.body === "string" ? route.body.body : undefined;
  const maintainerCanModify = typeof route.body.maintainer_can_modify === "boolean"
    ? route.body.maintainer_can_modify : null;
  return GitHubPullRequestCreateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "pr.create",
    repository_id: baseRepository.id,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: baseRepository.full_name,
    repository_visibility: baseRepository.visibility,
    head_repository_id: headRepositoryIdentity.id,
    head_canonical_full_name: headRepositoryIdentity.full_name,
    head_repository_visibility: headRepositoryIdentity.visibility,
    repository_network_root_id: baseRepository.network_root_id,
    head_repository_network_root_id: headRepositoryIdentity.network_root_id,
    head_repository_is_fork: headRepositoryIdentity.is_fork,
    head_ref: headRef,
    head_commit_sha: headIdentity.base_commit_sha,
    base_ref: baseRef,
    base_commit_sha: baseIdentity.base_commit_sha,
    draft: route.body.draft === true,
    maintainer_can_modify: maintainerCanModify,
    target_identity_digest: githubPullRequestCreateTargetIdentityDigest({
      repository_id: baseRepository.id, canonical_full_name: baseRepository.full_name, head_ref: headRef, base_ref: baseRef,
      head_repository_id: headRepositoryIdentity.id, head_canonical_full_name: headRepositoryIdentity.full_name,
      repository_network_root_id: baseRepository.network_root_id,
      head_repository_network_root_id: headRepositoryIdentity.network_root_id,
      head_repository_is_fork: headRepositoryIdentity.is_fork,
    }),
    request_payload_digest: githubPullRequestCreateRequestPayloadDigest({
      owner, repo, title: String(route.body.title), ...(body !== undefined ? { body } : {}),
      head_ref: headRef, base_ref: baseRef, ...(crossRepository ? { head_repository: headRepository.fullName } : {}),
      draft: route.body.draft === true,
      ...(maintainerCanModify !== null ? { maintainer_can_modify: maintainerCanModify } : {}),
    }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export async function inspectGitHubPullRequestMergeTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubPullRequestMergeTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "pr.merge" || route.method !== "PUT") {
    throw new Error("github.write " + route.operation + " target observation is not implemented; status=BUILD_GAP");
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "expected_head_sha",
    "merge_method", "max_bytes"].includes(key))) {
    throw new Error("github.write pr.merge contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write pr.merge target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const number = requiredPositiveIntArg(args, "number", 1_000_000);
  const expectedHeadSha = String(route.body.sha);
  const mergeMethod = route.body.merge_method as "merge" | "squash" | "rebase";
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  assertToolExecutionNotCancelled(opts.signal, "github.write pr.merge target inspection");
  const repositoryResponse = await readRequest({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, maxBytes, token,
  }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "pr.merge target repository");
  const repositoryId = repository.id;
  const canonicalFullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const repositoryOwner = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      canonicalFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      repositoryName.toLowerCase() !== repo.toLowerCase() || repositoryOwner.toLowerCase() !== owner.toLowerCase() ||
      typeof repository.private !== "boolean") {
    throw new Error("github.write pr.merge repository identity or visibility is incomplete or mismatched; mutation_sent=false");
  }
  assertToolExecutionNotCancelled(opts.signal, "github.write pr.merge pull request inspection");
  const pullResponse = await readRequest({ path: route.path, maxBytes, token }, opts.signal);
  const pull = requireGitHubJsonRecord(pullResponse, "pr.merge pull request");
  const head = isRecord(pull.head) ? pull.head : null;
  const headRepository = head && isRecord(head.repo) ? head.repo : null;
  const base = isRecord(pull.base) ? pull.base : null;
  const baseRepository = base && isRecord(base.repo) ? base.repo : null;
  const headRef = head && typeof head.ref === "string" ? head.ref : "";
  const headSha = head && typeof head.sha === "string" ? head.sha : "";
  const headRepositoryId = headRepository?.id;
  const headCanonicalFullName = typeof headRepository?.full_name === "string" ? headRepository.full_name : "";
  const headRepositoryName = typeof headRepository?.name === "string" ? headRepository.name : "";
  const headRepositoryOwner = headRepository && isRecord(headRepository.owner) && typeof headRepository.owner.login === "string"
    ? headRepository.owner.login : "";
  const headRepositoryPrivate = headRepository?.private;
  const baseRef = base && typeof base.ref === "string" ? base.ref : "";
  const baseSha = base && typeof base.sha === "string" ? base.sha : "";
  const updatedAt = pull.updated_at;
  if (typeof pull.id !== "number" || !Number.isSafeInteger(pull.id) || pull.id <= 0 || pull.number !== number ||
      pull.state !== "open" || pull.locked !== false || pull.merged !== false || pull.draft !== false ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof pull.title !== "string" || pull.title.length === 0 || pull.title.length > 65_536 ||
      pull.mergeable !== true || pull.mergeable_state !== "clean" ||
      !headRef || headRef.length > 255 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha) ||
      !headRepository || typeof headRepositoryId !== "number" || !Number.isSafeInteger(headRepositoryId) || headRepositoryId <= 0 ||
      typeof headRepositoryPrivate !== "boolean" ||
      headCanonicalFullName.toLowerCase() !== `${headRepositoryOwner}/${headRepositoryName}`.toLowerCase() ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(headRepositoryOwner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(headRepositoryName) ||
      headRepositoryOwner === "." || headRepositoryOwner === ".." || headRepositoryName === "." || headRepositoryName === ".." ||
      !baseRef || baseRef.length > 255 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha) ||
      !baseRepository || baseRepository.id !== repositoryId ||
      typeof baseRepository.full_name !== "string" || baseRepository.full_name.toLowerCase() !== canonicalFullName.toLowerCase()) {
    throw new Error("github.write pr.merge requires the exact open, unlocked, non-draft, clean pull request; mutation_sent=false; status=BLOCKED_AUTHORITY");
  }
  if (headSha !== expectedHeadSha) {
    throw new Error("github.write pr.merge head SHA changed from the explicitly reviewed expected SHA; mutation_sent=false; outcome=stale");
  }
  return GitHubPullRequestMergeTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "pr.merge",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: canonicalFullName,
    repository_visibility: repository.private ? "private" : "public",
    pull_request_id: pull.id,
    pull_request_number: number,
    pull_request_state: "open",
    pull_request_locked: false,
    pull_request_draft: false,
    pull_request_updated_at: updatedAt,
    pull_request_title: pull.title,
    head_repository_id: headRepositoryId,
    head_canonical_full_name: headCanonicalFullName,
    head_repository_visibility: headRepositoryPrivate ? "private" : "public",
    mergeable: true,
    mergeable_state: "clean",
    head_ref: headRef,
    head_sha: headSha,
    base_ref: baseRef,
    base_sha: baseSha,
    merge_method: mergeMethod,
    target_identity_digest: githubPullRequestMergeTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: canonicalFullName, pull_request_id: pull.id, pull_request_number: number,
      head_repository_id: headRepositoryId, head_canonical_full_name: headCanonicalFullName,
      head_ref: headRef, head_sha: headSha, base_ref: baseRef, base_sha: baseSha }),
    request_payload_digest: githubPullRequestMergeRequestPayloadDigest({ owner, repo,
      pull_request_number: number, expected_head_sha: expectedHeadSha, merge_method: mergeMethod }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubPullRequestMergeTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubPullRequestMergeTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "pr.merge") throw new Error("github.write pr.merge target observation has another operation");
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const number = requiredPositiveIntArg(args, "number", 1_000_000);
  const expectedHeadSha = stringArg(args, "expected_head_sha")!;
  const mergeMethod = stringArg(args, "merge_method")!;
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "expected_head_sha",
        "merge_method", "max_bytes"].includes(key)) || route.operation !== "pr.merge" || route.method !== "PUT" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      observation.pull_request_number !== number || observation.pull_request_state !== "open" ||
      observation.pull_request_locked || observation.pull_request_draft || !observation.mergeable ||
      observation.mergeable_state !== "clean" || observation.head_sha !== expectedHeadSha ||
      observation.merge_method !== mergeMethod || observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== githubPullRequestMergeRequestPayloadDigest({ owner, repo,
        pull_request_number: number, expected_head_sha: expectedHeadSha,
        merge_method: mergeMethod as "merge" | "squash" | "rebase" }) ||
      observation.target_identity_digest !== githubPullRequestMergeTargetIdentityDigest({ repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name, pull_request_id: observation.pull_request_id,
        head_repository_id: observation.head_repository_id, head_canonical_full_name: observation.head_canonical_full_name,
        pull_request_number: observation.pull_request_number, head_ref: observation.head_ref,
        head_sha: observation.head_sha, base_ref: observation.base_ref, base_sha: observation.base_sha }) ||
      observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write pr.merge target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubPullRequestMergeContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubPullRequestMergeContentReview> {
  const observation = await inspectGitHubPullRequestMergeTargetVersion(args, opts);
  const base = {
    kind: "github_pull_request_merge" as const,
    operation: "github.write.pr.merge" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    pull_request_id: observation.pull_request_id,
    pull_request_number: observation.pull_request_number,
    pull_request_state: observation.pull_request_state,
    pull_request_locked: observation.pull_request_locked,
    pull_request_draft: observation.pull_request_draft,
    pull_request_updated_at: observation.pull_request_updated_at,
    pull_request_title: observation.pull_request_title,
    head_repository_id: observation.head_repository_id,
    head_canonical_full_name: observation.head_canonical_full_name,
    head_repository_visibility: observation.head_repository_visibility,
    mergeable: observation.mergeable,
    mergeable_state: observation.mergeable_state,
    head_ref: observation.head_ref,
    head_sha: observation.head_sha,
    base_ref: observation.base_ref,
    base_sha: observation.base_sha,
    expected_head_sha: String(args.expected_head_sha),
    merge_method: observation.merge_method,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    merge_effect: "merge_reviewed_head_into_base_branch" as const,
    workflow_effect: "repository_workflows_may_run" as const,
    notification_effect: "github_api_may_trigger_notifications" as const,
    publication_effect: "visible_to_repository_audience" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export function assertGitHubPullRequestCreateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubPullRequestCreateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "pr.create") {
    throw new Error("github.write pr.create target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const headRepository = args.head_repository === undefined
    ? { owner, repo, fullName: `${owner}/${repo}` }
    : githubRepositoryFullNameArg(args.head_repository, "head_repository");
  const headRef = stringArg(args, "head")!;
  const baseRef = stringArg(args, "base")!;
  const body = typeof route.body.body === "string" ? route.body.body : undefined;
  const maintainerCanModify = typeof route.body.maintainer_can_modify === "boolean"
    ? route.body.maintainer_can_modify : null;
  const payloadDigest = githubPullRequestCreateRequestPayloadDigest({
    owner, repo, title: String(route.body.title), ...(body !== undefined ? { body } : {}),
    head_repository: headRepository.fullName, head_ref: headRef, base_ref: baseRef, draft: route.body.draft === true,
    ...(maintainerCanModify !== null ? { maintainer_can_modify: maintainerCanModify } : {}),
  });
  const targetDigest = githubPullRequestCreateTargetIdentityDigest({
    repository_id: observation.repository_id, canonical_full_name: observation.canonical_full_name,
    head_repository_id: observation.head_repository_id, head_canonical_full_name: observation.head_canonical_full_name,
    repository_network_root_id: observation.repository_network_root_id,
    head_repository_network_root_id: observation.head_repository_network_root_id,
    head_repository_is_fork: observation.head_repository_is_fork, head_ref: headRef, base_ref: baseRef,
  });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "title", "body", "head", "head_repository", "base", "draft", "maintainer_can_modify", "max_bytes"].includes(key)) ||
      route.operation !== "pr.create" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      observation.head_canonical_full_name.toLowerCase() !== headRepository.fullName.toLowerCase() ||
      observation.head_ref !== headRef || observation.base_ref !== baseRef ||
      observation.draft !== (route.body.draft === true) || observation.maintainer_can_modify !== maintainerCanModify ||
      observation.command_digest !== commandDigest || observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest || observation.target_identity_digest !== targetDigest ||
      observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write pr.create target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubPullRequestCreateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubPullRequestCreateContentReview> {
  const observation = await inspectGitHubPullRequestCreateTargetVersion(args, opts);
  const route = githubWriteRoute(args);
  const base = {
    kind: "github_pull_request_create" as const,
    operation: "github.write.pr.create" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    head_repository_id: observation.head_repository_id,
    head_canonical_full_name: observation.head_canonical_full_name,
    head_repository_visibility: observation.head_repository_visibility,
    repository_network_root_id: observation.repository_network_root_id,
    head_repository_network_root_id: observation.head_repository_network_root_id,
    head_repository_is_fork: observation.head_repository_is_fork,
    head_ref: observation.head_ref,
    head_commit_sha: observation.head_commit_sha,
    base_ref: observation.base_ref,
    base_commit_sha: observation.base_commit_sha,
    title: String(route.body.title),
    ...(typeof route.body.body === "string" ? { body: route.body.body } : {}),
    draft: observation.draft,
    draft_was_defaulted: args.draft === undefined,
    maintainer_can_modify: observation.maintainer_can_modify,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    publication_effect: "visible_to_repository_audience" as const,
    creation_is_reversible: false as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export async function inspectGitHubIssueUpdateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubIssueUpdateTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.update") {
    throw new Error("github.write " + route.operation + " target observation is not implemented; status=BUILD_GAP");
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "title", "body", "max_bytes"].includes(key))) {
    throw new Error("github.write issue.update contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write issue.update target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.update target inspection");
  const repositoryResponse = await readRequest({
    path: "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo),
    maxBytes,
    token,
  }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "issue.update target repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  const isPrivate = repository.private;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      fullName.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      repositoryName.toLowerCase() !== repo.toLowerCase() || ownerLogin.toLowerCase() !== owner.toLowerCase() ||
      typeof isPrivate !== "boolean") {
    throw new Error("github.write issue.update repository identity or visibility is incomplete or mismatched");
  }
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.update target inspection");
  const issueResponse = await readRequest({ path: route.path, maxBytes, token }, opts.signal);
  const issue = requireGitHubJsonRecord(issueResponse, "issue.update target issue");
  const issueId = issue.id;
  const observedNumber = issue.number;
  const state = issue.state;
  const locked = issue.locked;
  const updatedAt = issue.updated_at;
  const title = issue.title;
  const body = issue.body;
  if ("pull_request" in issue) {
    throw new Error("github.write issue.update target is a pull request; mutation_sent=false; status=BUILD_GAP");
  }
  if (typeof issueId !== "number" || !Number.isSafeInteger(issueId) || issueId <= 0 ||
      observedNumber !== issueNumber || (state !== "open" && state !== "closed") || typeof locked !== "boolean" ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof title !== "string" || title.length === 0 || title.length > 65_536 ||
      (body !== null && typeof body !== "string") || (typeof body === "string" && body.length > 500_000)) {
    throw new Error("github.write issue.update target state is incomplete or mismatched; mutation_sent=false");
  }
  return GitHubIssueUpdateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "issue.update",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    issue_id: issueId,
    issue_number: observedNumber,
    issue_state: state,
    issue_locked: locked,
    issue_updated_at: updatedAt,
    issue_title: title,
    issue_body: body,
    target_identity_digest: githubIssueUpdateTargetIdentityDigest({
      repository_id: repositoryId, canonical_full_name: fullName, issue_id: issueId, issue_number: observedNumber,
    }),
    request_payload_digest: githubIssueUpdateRequestPayloadDigest({
      owner, repo, issue_number: issueNumber,
      ...(typeof route.body.title === "string" ? { title: route.body.title } : {}),
      ...(typeof route.body.body === "string" ? { body: route.body.body } : {}),
    }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubIssueUpdateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubIssueUpdateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "issue.update") {
    throw new Error("github.write issue.update target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const payloadDigest = githubIssueUpdateRequestPayloadDigest({
    owner, repo, issue_number: issueNumber,
    ...(typeof route.body.title === "string" ? { title: route.body.title } : {}),
    ...(typeof route.body.body === "string" ? { body: route.body.body } : {}),
  });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "title", "body", "max_bytes"].includes(key)) ||
      route.operation !== "issue.update" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      observation.issue_number !== issueNumber || observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest ||
      observation.target_identity_digest !== githubIssueUpdateTargetIdentityDigest({
        repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name,
        issue_id: observation.issue_id,
        issue_number: observation.issue_number,
      }) || observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write issue.update target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubIssueUpdateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubIssueUpdateContentReview> {
  const observation = await inspectGitHubIssueUpdateTargetVersion(args, opts);
  const route = githubWriteRoute(args);
  const base = {
    kind: "github_issue_update" as const,
    operation: "github.write.issue.update" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    issue_id: observation.issue_id,
    issue_number: observation.issue_number,
    issue_state: observation.issue_state,
    issue_locked: observation.issue_locked,
    issue_updated_at: observation.issue_updated_at,
    current_title: observation.issue_title,
    current_body: observation.issue_body,
    ...(typeof route.body.title === "string" ? { requested_title: route.body.title } : {}),
    ...(typeof route.body.body === "string" ? { requested_body: route.body.body } : {}),
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export async function inspectGitHubIssueCloseTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubIssueCloseTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.close") {
    throw new Error("github.write " + route.operation + " target observation is not implemented; status=BUILD_GAP");
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key))) {
    throw new Error("github.write issue.close contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write issue.close target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.close target inspection");
  const repositoryResponse = await readRequest({
    path: "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo), maxBytes, token,
  }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "issue.close target repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string" ? repository.owner.login : "";
  const isPrivate = repository.private;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      fullName.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      repositoryName.toLowerCase() !== repo.toLowerCase() || ownerLogin.toLowerCase() !== owner.toLowerCase() ||
      typeof isPrivate !== "boolean") {
    throw new Error("github.write issue.close repository identity or visibility is incomplete or mismatched");
  }
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.close target inspection");
  const issueResponse = await readRequest({ path: route.path, maxBytes, token }, opts.signal);
  const issue = requireGitHubJsonRecord(issueResponse, "issue.close target issue");
  if ("pull_request" in issue) {
    throw new Error("github.write issue.close target is a pull request; mutation_sent=false");
  }
  const issueId = issue.id;
  const observedNumber = issue.number;
  const state = issue.state;
  const locked = issue.locked;
  const updatedAt = issue.updated_at;
  const title = issue.title;
  if (typeof issueId !== "number" || !Number.isSafeInteger(issueId) || issueId <= 0 || observedNumber !== issueNumber ||
      state !== "open" || locked !== false || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof title !== "string" || title.length === 0 || title.length > 65_536) {
    throw new Error("github.write issue.close requires the exact open, unlocked issue; mutation_sent=false");
  }
  return GitHubIssueCloseTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "issue.close",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    issue_id: issueId,
    issue_number: observedNumber,
    issue_state: "open",
    issue_locked: false,
    issue_updated_at: updatedAt,
    issue_title: title,
    target_identity_digest: githubIssueCloseTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: fullName, issue_id: issueId, issue_number: observedNumber }),
    request_payload_digest: githubIssueCloseRequestPayloadDigest({ owner, repo, issue_number: issueNumber }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubIssueCloseTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubIssueCloseTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "issue.close") {
    throw new Error("github.write issue.close target observation has another operation");
  }
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key)) ||
      githubWriteRoute(args).operation !== "issue.close" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      observation.issue_number !== issueNumber || observation.issue_state !== "open" || observation.issue_locked ||
      observation.command_digest !== commandDigest || observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== githubIssueCloseRequestPayloadDigest({ owner, repo, issue_number: issueNumber }) ||
      observation.target_identity_digest !== githubIssueCloseTargetIdentityDigest({ repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name, issue_id: observation.issue_id,
        issue_number: observation.issue_number }) || observation.mutation_sent || observation.used_for_authority ||
      observation.may_execute || observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write issue.close target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubIssueReopenTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubIssueReopenTargetVersionObservation> {
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.reopen") {
    throw new Error("github.write " + route.operation + " target observation is not implemented; status=BUILD_GAP");
  }
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key))) {
    throw new Error("github.write issue.reopen contains unsupported arguments; mutation_sent=false");
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error("github.write issue.reopen target observation requires a command and Operation Plan binding");
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.reopen target inspection");
  const repositoryResponse = await readRequest({
    path: "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo), maxBytes, token,
  }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, "issue.reopen target repository");
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string" ? repository.owner.login : "";
  const isPrivate = repository.private;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      fullName.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      repositoryName.toLowerCase() !== repo.toLowerCase() || ownerLogin.toLowerCase() !== owner.toLowerCase() ||
      typeof isPrivate !== "boolean") {
    throw new Error("github.write issue.reopen repository identity or visibility is incomplete or mismatched");
  }
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.reopen target inspection");
  const issueResponse = await readRequest({ path: route.path, maxBytes, token }, opts.signal);
  const issue = requireGitHubJsonRecord(issueResponse, "issue.reopen target issue");
  if ("pull_request" in issue) {
    throw new Error("github.write issue.reopen target is a pull request; mutation_sent=false");
  }
  const issueId = issue.id;
  const observedNumber = issue.number;
  const state = issue.state;
  const locked = issue.locked;
  const updatedAt = issue.updated_at;
  const title = issue.title;
  if (typeof issueId !== "number" || !Number.isSafeInteger(issueId) || issueId <= 0 || observedNumber !== issueNumber ||
      state !== "closed" || locked !== false || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof title !== "string" || title.length === 0 || title.length > 65_536) {
    throw new Error("github.write issue.reopen requires the exact closed, unlocked issue; mutation_sent=false");
  }
  return GitHubIssueReopenTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation: "issue.reopen",
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    issue_id: issueId,
    issue_number: observedNumber,
    issue_state: "closed",
    issue_locked: false,
    issue_updated_at: updatedAt,
    issue_title: title,
    target_identity_digest: githubIssueReopenTargetIdentityDigest({ repository_id: repositoryId,
      canonical_full_name: fullName, issue_id: issueId, issue_number: observedNumber }),
    request_payload_digest: githubIssueReopenRequestPayloadDigest({ owner, repo, issue_number: issueNumber }),
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  });
}

export function assertGitHubIssueReopenTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubIssueReopenTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "issue.reopen") {
    throw new Error("github.write issue.reopen target observation has another operation");
  }
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "max_bytes"].includes(key)) ||
      githubWriteRoute(args).operation !== "issue.reopen" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      observation.issue_number !== issueNumber || observation.issue_state !== "closed" || observation.issue_locked ||
      observation.command_digest !== commandDigest || observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== githubIssueReopenRequestPayloadDigest({ owner, repo, issue_number: issueNumber }) ||
      observation.target_identity_digest !== githubIssueReopenTargetIdentityDigest({ repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name, issue_id: observation.issue_id,
        issue_number: observation.issue_number }) || observation.mutation_sent || observation.used_for_authority ||
      observation.may_execute || observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write issue.reopen target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubIssueCloseContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubIssueCloseContentReview> {
  const observation = await inspectGitHubIssueCloseTargetVersion(args, opts);
  const base = {
    kind: "github_issue_close" as const,
    operation: "github.write.issue.close" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    issue_id: observation.issue_id,
    issue_number: observation.issue_number,
    issue_state: observation.issue_state,
    issue_locked: observation.issue_locked,
    issue_updated_at: observation.issue_updated_at,
    issue_title: observation.issue_title,
    requested_state: "closed" as const,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export async function inspectGitHubIssueReopenContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubIssueReopenContentReview> {
  const observation = await inspectGitHubIssueReopenTargetVersion(args, opts);
  const base = {
    kind: "github_issue_reopen" as const,
    operation: "github.write.issue.reopen" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    issue_id: observation.issue_id,
    issue_number: observation.issue_number,
    issue_state: observation.issue_state,
    issue_locked: observation.issue_locked,
    issue_updated_at: observation.issue_updated_at,
    issue_title: observation.issue_title,
    requested_state: "open" as const,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

type GitHubCommentCreateOperation = "issue.comment.create" | "pr.comment.create";
type GitHubCommentCreateTargetObservation = GitHubIssueCommentCreateTargetVersionObservation |
  GitHubPullRequestCommentCreateTargetVersionObservation;

function githubApiResourceUrlMatches(value: unknown, owner: string, repo: string, resource: "issues" | "pulls", number: number): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.github.com" &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      url.pathname.toLowerCase() === (`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${resource}/${number}`).toLowerCase();
  } catch {
    return false;
  }
}

function githubPullRequestIssueUrlMatches(value: unknown, owner: string, repo: string, number: number): boolean {
  return githubApiResourceUrlMatches(value, owner, repo, "pulls", number);
}

type GitHubPullRequestDiffSnapshot = {
  id: number;
  number: number;
  state: "open" | "closed";
  head_sha: string;
  base_sha: string;
};

type GitHubInlineDiffLine = {
  hunk_index: number;
  hunk_header: string;
  old_line: number | null;
  new_line: number | null;
  marker: " " | "+" | "-";
  text: string;
};

const GITHUB_INLINE_DIFF_MAX_PAGES = 3;
const GITHUB_INLINE_DIFF_PAGE_SIZE = 100;
const GITHUB_INLINE_DIFF_MAX_PATCH_CHARS = 256_000;
const GITHUB_INLINE_DIFF_MAX_EXCERPT_CHARS = 4_096;

function readGitHubPullRequestDiffSnapshot(
  response: GitHubReadResponse,
  label: string,
  expected: { id: number; number: number; state: "open" | "closed" },
): GitHubPullRequestDiffSnapshot {
  const pullRequest = requireGitHubJsonRecord(response, label);
  const head = isRecord(pullRequest.head) ? pullRequest.head : null;
  const base = isRecord(pullRequest.base) ? pullRequest.base : null;
  const headSha = head && typeof head.sha === "string" ? head.sha.toLowerCase() : "";
  const baseSha = base && typeof base.sha === "string" ? base.sha.toLowerCase() : "";
  if (pullRequest.id !== expected.id || pullRequest.number !== expected.number || pullRequest.state !== expected.state ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) {
    throw new Error(`github.read ${label} did not preserve the requested pull request and commit identities`);
  }
  return { id: expected.id, number: expected.number, state: expected.state, head_sha: headSha, base_sha: baseSha };
}

function parseGitHubInlineDiff(patch: string, location: GitHubPullRequestInlineCommentLocation): { excerpt: string } {
  if (patch.length === 0 || patch.length > GITHUB_INLINE_DIFF_MAX_PATCH_CHARS) {
    throw new Error("github.read selected pull request patch is missing or exceeds the inline review limit");
  }
  const sourceLines = patch.replace(/\r\n/g, "\n").split("\n");
  const parsed: GitHubInlineDiffLine[] = [];
  let hunk: { index: number; header: string; old_line: number; new_line: number; old_expected: number; new_expected: number;
    old_seen: number; new_seen: number } | undefined;
  let nextHunkIndex = 0;
  const finishHunk = (): void => {
    if (hunk && (hunk.old_seen !== hunk.old_expected || hunk.new_seen !== hunk.new_expected)) {
      throw new Error("github.read selected pull request patch has inconsistent hunk bounds");
    }
  };
  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index]!;
    if (sourceLine.length === 0 && index === sourceLines.length - 1) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(sourceLine);
    if (header) {
      finishHunk();
      hunk = {
        index: nextHunkIndex++,
        header: sourceLine,
        old_line: Number(header[1]),
        new_line: Number(header[3]),
        old_expected: header[2] === undefined ? 1 : Number(header[2]),
        new_expected: header[4] === undefined ? 1 : Number(header[4]),
        old_seen: 0,
        new_seen: 0,
      };
      if (![hunk.old_line, hunk.new_line, hunk.old_expected, hunk.new_expected].every(Number.isSafeInteger)) {
        throw new Error("github.read selected pull request patch contains invalid hunk bounds");
      }
      continue;
    }
    if (sourceLine === "\\ No newline at end of file") continue;
    if (!hunk) throw new Error("github.read selected pull request patch is not a unified diff");
    const marker = sourceLine[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      throw new Error("github.read selected pull request patch contains an unsupported diff line");
    }
    const oldLine = marker === "+" ? null : hunk.old_line;
    const newLine = marker === "-" ? null : hunk.new_line;
    parsed.push({ hunk_index: hunk.index, hunk_header: hunk.header, old_line: oldLine, new_line: newLine,
      marker, text: sourceLine.slice(1) });
    if (marker !== "+") {
      hunk.old_line += 1;
      hunk.old_seen += 1;
    }
    if (marker !== "-") {
      hunk.new_line += 1;
      hunk.new_seen += 1;
    }
    if (hunk.old_seen > hunk.old_expected || hunk.new_seen > hunk.new_expected) {
      throw new Error("github.read selected pull request patch exceeds its hunk bounds");
    }
  }
  finishHunk();

  const locate = (lineNumber: number, side: "LEFT" | "RIGHT") => parsed.map((line, index) => ({ line, index })).filter(({ line }) =>
    side === "LEFT"
      ? line.old_line === lineNumber && line.marker !== "+"
      : line.new_line === lineNumber && line.marker !== "-");
  const endMatches = locate(location.line, location.side);
  const startMatches = location.start_line === undefined || location.start_side === undefined
    ? endMatches
    : locate(location.start_line, location.start_side);
  if (endMatches.length !== 1 || startMatches.length !== 1) {
    throw new Error("requested inline review location is not a unique line in the current pull request diff");
  }
  const selectedStart = startMatches[0]!;
  const selectedEnd = endMatches[0]!;
  const hasRange = location.start_line !== undefined && location.start_side !== undefined;
  if (selectedStart.line.hunk_index !== selectedEnd.line.hunk_index ||
      (hasRange ? selectedStart.index >= selectedEnd.index : selectedStart.index > selectedEnd.index)) {
    throw new Error("requested inline review range is reversed or crosses pull request diff hunks");
  }
  const nearby = parsed.map((line, index) => ({ line, index }))
    .filter(({ line, index }) => line.hunk_index === selectedStart.line.hunk_index &&
      index >= selectedStart.index - 2 && index <= selectedEnd.index + 2);
  const selectedLines = nearby.filter(({ index }) => index >= selectedStart.index && index <= selectedEnd.index);
  const renderLines = (entries: typeof nearby): string[] => entries.map((entry) => {
    const oldText = entry.line.old_line === null ? "-" : String(entry.line.old_line);
    const newText = entry.line.new_line === null ? "-" : String(entry.line.new_line);
    const safeText = entry.line.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
    const boundedText = safeText.length > 600 ? `${safeText.slice(0, 597)}...` : safeText;
    const inSelectedRange = entry.index >= selectedStart.index && entry.index <= selectedEnd.index;
    return `${inSelectedRange ? ">" : " "} ${oldText} | ${newText} | ${entry.line.marker}${boundedText}`;
  });
  let excerpt = [selectedStart.line.hunk_header, ...renderLines(nearby)].join("\n");
  if (excerpt.length > GITHUB_INLINE_DIFF_MAX_EXCERPT_CHARS) {
    excerpt = [selectedStart.line.hunk_header, ...renderLines(selectedLines)].join("\n");
  }
  if (excerpt.length > GITHUB_INLINE_DIFF_MAX_EXCERPT_CHARS) {
    throw new Error("requested inline review range exceeds the bounded Owner review excerpt; choose a shorter range");
  }
  return { excerpt };
}

async function inspectGitHubPullRequestInlineDiff(input: {
  owner: string;
  repo: string;
  number: number;
  id: number;
  state: "open" | "closed";
  location: GitHubPullRequestInlineCommentLocation;
  maxBytes: number;
  token: string;
  signal?: AbortSignal;
  readRequest: NonNullable<GitHubWriteOptions["read_request"]>;
}): Promise<{ snapshot: GitHubPullRequestDiffSnapshot; diff_digest: string; excerpt: string }> {
  const pathPrefix = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`;
  assertToolExecutionNotCancelled(input.signal, "github.write pr.comment.create diff inspection");
  const beforeResponse = await input.readRequest({ path: pathPrefix, maxBytes: input.maxBytes, token: input.token }, input.signal);
  const before = readGitHubPullRequestDiffSnapshot(beforeResponse, "pull request before diff read", input);
  let selectedFile: Record<string, unknown> | undefined;
  for (let page = 1; page <= GITHUB_INLINE_DIFF_MAX_PAGES; page += 1) {
    assertToolExecutionNotCancelled(input.signal, "github.write pr.comment.create diff inspection");
    const response = await input.readRequest({
      path: `${pathPrefix}/files?per_page=${GITHUB_INLINE_DIFF_PAGE_SIZE}&page=${page}`,
      maxBytes: input.maxBytes,
      token: input.token,
    }, input.signal);
    const files = requireGitHubJsonArray(response, "pull request files");
    if (files.length > GITHUB_INLINE_DIFF_PAGE_SIZE) {
      throw new Error("github.read pull request files exceeded the requested page size");
    }
    for (const fileValue of files) {
      if (!isRecord(fileValue) || typeof fileValue.filename !== "string") {
        throw new Error("github.read pull request files contained an invalid file identity");
      }
      if (fileValue.filename === input.location.path) {
        if (selectedFile) throw new Error("github.read pull request diff contains an ambiguous target path");
        selectedFile = fileValue;
      }
    }
    if (selectedFile) break;
    if (files.length < GITHUB_INLINE_DIFF_PAGE_SIZE) break;
    if (page === GITHUB_INLINE_DIFF_MAX_PAGES) {
      throw new Error("requested path is outside the bounded 300-file pull request diff inspection window");
    }
  }
  if (!selectedFile) throw new Error("requested path is not changed in the current pull request diff");
  if ((selectedFile.status !== "added" && selectedFile.status !== "modified" && selectedFile.status !== "removed") ||
      (selectedFile.previous_filename !== undefined && selectedFile.previous_filename !== input.location.path) ||
      typeof selectedFile.patch !== "string") {
    throw new Error("requested pull request file is renamed, binary, truncated, or unsupported for inline review");
  }
  const patch = selectedFile.patch;
  const { excerpt } = parseGitHubInlineDiff(patch, input.location);
  assertToolExecutionNotCancelled(input.signal, "github.write pr.comment.create diff recheck");
  const afterResponse = await input.readRequest({ path: pathPrefix, maxBytes: input.maxBytes, token: input.token }, input.signal);
  const after = readGitHubPullRequestDiffSnapshot(afterResponse, "pull request after diff read", input);
  if (before.head_sha !== after.head_sha || before.base_sha !== after.base_sha || before.state !== after.state) {
    throw new Error("pull request head or base changed during inline diff inspection; target_version=stale");
  }
  return {
    snapshot: before,
    excerpt,
    diff_digest: sha256Hex({
      schema_version: input.location.start_line === undefined
        ? "blue-tanuki.github-pull-request-inline-diff.v1"
        : "blue-tanuki.github-pull-request-inline-diff-range.v1",
      path: input.location.path,
      ...(input.location.start_line === undefined || input.location.start_side === undefined ? {} : {
        start_line: input.location.start_line,
        start_side: input.location.start_side,
      }),
      line: input.location.line,
      side: input.location.side,
      head_sha: before.head_sha,
      base_sha: before.base_sha,
      file_status: selectedFile.status,
      patch,
    }),
  };
}

async function inspectGitHubCommentCreateTargetDetails(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
  operation: GitHubCommentCreateOperation,
): Promise<{ observation: GitHubCommentCreateTargetObservation; issue_title: string;
  inline_diff?: { head_sha: string; base_sha: string; diff_digest: string; excerpt: string } }> {
  const route = githubWriteRoute(args);
  if (route.operation !== operation) {
    throw new Error(`github.write ${route.operation} comment target observation does not match ${operation}; status=BUILD_GAP`);
  }
  const allowedArgumentKeys = operation === "pr.comment.create"
    ? ["operation", "owner", "repo", "number", "body", "max_bytes", "comment_kind", "path", "start_line", "start_side", "line", "side"]
    : ["operation", "owner", "repo", "number", "body", "max_bytes"];
  if (Object.keys(args).some((key) => !allowedArgumentKeys.includes(key))) {
    throw new Error(`github.write ${operation} contains unsupported arguments; mutation_sent=false`);
  }
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest)) {
    throw new Error(`github.write ${operation} target observation requires a command and Operation Plan binding`);
  }
  const env = opts.env ?? process.env;
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const readRequest = opts.read_request ?? defaultGitHubReadRequest;
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  assertToolExecutionNotCancelled(opts.signal, `github.write ${operation} target inspection`);
  const repositoryResponse = await readRequest({
    path: "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo), maxBytes, token,
  }, opts.signal);
  const repository = requireGitHubJsonRecord(repositoryResponse, `${operation} target repository`);
  const repositoryId = repository.id;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const repositoryName = typeof repository.name === "string" ? repository.name : "";
  const ownerLogin = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login : "";
  const isPrivate = repository.private;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      fullName.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      repositoryName.toLowerCase() !== repo.toLowerCase() || ownerLogin.toLowerCase() !== owner.toLowerCase() ||
      typeof isPrivate !== "boolean") {
    throw new Error(`github.write ${operation} repository identity or visibility is incomplete or mismatched`);
  }
  assertToolExecutionNotCancelled(opts.signal, `github.write ${operation} target inspection`);
  const issueResponse = await readRequest({
    path: "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/issues/" + issueNumber,
    maxBytes,
    token,
  }, opts.signal);
  const issue = requireGitHubJsonRecord(issueResponse, `${operation} target item`);
  const pullRequestLink = issue.pull_request;
  if (operation === "issue.comment.create" && "pull_request" in issue) {
    throw new Error("github.write issue.comment.create target is a pull request; mutation_sent=false; status=BUILD_GAP");
  }
  if (operation === "pr.comment.create" &&
      (!isRecord(pullRequestLink) || !githubPullRequestIssueUrlMatches(pullRequestLink.url, owner, repo, issueNumber))) {
    throw new Error("github.write pr.comment.create target is not the requested pull request; mutation_sent=false; status=BUILD_GAP");
  }
  const issueId = issue.id;
  const observedNumber = issue.number;
  const state = issue.state;
  const locked = issue.locked;
  const updatedAt = issue.updated_at;
  const title = issue.title;
  if (typeof issueId !== "number" || !Number.isSafeInteger(issueId) || issueId <= 0 ||
      observedNumber !== issueNumber || (state !== "open" && state !== "closed") || typeof locked !== "boolean" ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof title !== "string" || title.length === 0 || title.length > 65_536) {
    throw new Error(`github.write ${operation} target state is incomplete or mismatched; mutation_sent=false`);
  }
  if (locked) {
    throw new Error(`github.write ${operation} target is locked; mutation_sent=false; status=BLOCKED_AUTHORITY`);
  }
  let inlineDiff: { snapshot: GitHubPullRequestDiffSnapshot; diff_digest: string; excerpt: string } | undefined;
  const inlineLocation = operation === "pr.comment.create" ? githubPullRequestInlineCommentLocation(args) : undefined;
  if (inlineLocation) {
    inlineDiff = await inspectGitHubPullRequestInlineDiff({
      owner,
      repo,
      number: issueNumber,
      id: issueId,
      state,
      location: inlineLocation,
      maxBytes,
      token,
      ...(opts.signal ? { signal: opts.signal } : {}),
      readRequest,
    });
    assertToolExecutionNotCancelled(opts.signal, "github.write pr.comment.create issue target recheck");
    const issueConfirmationResponse = await readRequest({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      maxBytes,
      token,
    }, opts.signal);
    const issueConfirmation = requireGitHubJsonRecord(issueConfirmationResponse, "inline comment target confirmation");
    if (issueConfirmation.id !== issueId || issueConfirmation.number !== issueNumber ||
        issueConfirmation.state !== state || issueConfirmation.locked !== locked ||
        issueConfirmation.updated_at !== updatedAt || issueConfirmation.title !== title ||
        !isRecord(issueConfirmation.pull_request) ||
        !githubPullRequestIssueUrlMatches(issueConfirmation.pull_request.url, owner, repo, issueNumber)) {
      throw new Error("pull request target changed during inline diff inspection; target_version=stale");
    }
  }
  const sharedObservation = {
    schema_version: "blue-tanuki.github-write-target-version.v1",
    operation,
    repository_id: repositoryId,
    requested_owner: owner,
    requested_repo: repo,
    canonical_full_name: fullName,
    repository_visibility: isPrivate ? "private" : "public",
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    provider_observation_is_atomic: false,
    provider_data_is_untrusted: true,
    mutation_sent: false,
    used_for_authority: false,
    may_execute: false,
  } as const;
  const observation = operation === "issue.comment.create"
    ? GitHubIssueCommentCreateTargetVersionObservationSchema.parse({
      ...sharedObservation,
      issue_id: issueId,
      issue_number: observedNumber,
      issue_state: state,
      issue_locked: locked,
      issue_updated_at: updatedAt,
      target_identity_digest: githubIssueCommentCreateTargetIdentityDigest({
        repository_id: repositoryId, canonical_full_name: fullName, issue_id: issueId, issue_number: observedNumber,
      }),
      request_payload_digest: githubIssueCommentCreateRequestPayloadDigest({
        owner, repo, issue_number: issueNumber, body: stringArg(args, "body")!,
      }),
    })
    : GitHubPullRequestCommentCreateTargetVersionObservationSchema.parse({
      ...sharedObservation,
      pull_request_id: issueId,
      pull_request_number: observedNumber,
      pull_request_state: state,
      pull_request_locked: locked,
      pull_request_updated_at: updatedAt,
      ...(inlineDiff && inlineLocation ? {
        comment_kind: "pull_request_review_inline",
        path: inlineLocation.path,
        ...(inlineLocation.start_line === undefined || inlineLocation.start_side === undefined ? {} : {
          start_line: inlineLocation.start_line,
          start_side: inlineLocation.start_side,
        }),
        line: inlineLocation.line,
        side: inlineLocation.side,
        pull_request_head_sha: inlineDiff.snapshot.head_sha,
        pull_request_base_sha: inlineDiff.snapshot.base_sha,
        pull_request_diff_digest: inlineDiff.diff_digest,
      } : {}),
      target_identity_digest: githubPullRequestCommentCreateTargetIdentityDigest({
        repository_id: repositoryId, canonical_full_name: fullName,
        pull_request_id: issueId, pull_request_number: observedNumber,
      }),
      request_payload_digest: githubPullRequestCommentCreateRequestPayloadDigest({
        owner, repo, pull_request_number: issueNumber, body: stringArg(args, "body")!,
        ...(inlineLocation ? inlineLocation : {}),
      }),
    });
  return {
    observation,
    issue_title: title,
    ...(inlineDiff ? { inline_diff: { head_sha: inlineDiff.snapshot.head_sha, base_sha: inlineDiff.snapshot.base_sha,
      diff_digest: inlineDiff.diff_digest, excerpt: inlineDiff.excerpt } } : {}),
  };
}

export async function inspectGitHubIssueCommentCreateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubIssueCommentCreateTargetVersionObservation> {
  const { observation } = await inspectGitHubCommentCreateTargetDetails(args, opts, "issue.comment.create");
  if (observation.operation !== "issue.comment.create") throw new Error("GitHub issue comment target operation mismatch");
  return observation;
}

export async function inspectGitHubPullRequestCommentCreateTargetVersion(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions = {},
): Promise<GitHubPullRequestCommentCreateTargetVersionObservation> {
  const { observation } = await inspectGitHubCommentCreateTargetDetails(args, opts, "pr.comment.create");
  if (observation.operation !== "pr.comment.create") throw new Error("GitHub pull request comment target operation mismatch");
  return observation;
}

export function assertGitHubIssueCommentCreateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubIssueCommentCreateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "issue.comment.create") {
    throw new Error("github.write issue.comment.create target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const issueNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const payloadDigest = githubIssueCommentCreateRequestPayloadDigest({
    owner, repo, issue_number: issueNumber, body: stringArg(args, "body")!,
  });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "body", "max_bytes"].includes(key)) ||
      route.operation !== "issue.comment.create" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      observation.issue_number !== issueNumber || observation.issue_locked ||
      observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest ||
      observation.target_identity_digest !== githubIssueCommentCreateTargetIdentityDigest({
        repository_id: observation.repository_id,
        canonical_full_name: observation.canonical_full_name,
        issue_id: observation.issue_id,
        issue_number: observation.issue_number,
      }) || observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write issue.comment.create target observation does not match the approved command and plan");
  }
  return observation;
}

export function assertGitHubPullRequestCommentCreateTargetVersion(args: Record<string, unknown>, value: unknown,
  commandDigest: string, operationPlanBindingDigest: string): GitHubPullRequestCommentCreateTargetVersionObservation {
  const observation = GitHubWriteTargetVersionObservationSchema.parse(value);
  if (observation.operation !== "pr.comment.create") {
    throw new Error("github.write pr.comment.create target observation has another operation");
  }
  const route = githubWriteRoute(args);
  const owner = githubNameArg(args, "owner");
  const repo = githubNameArg(args, "repo");
  const pullRequestNumber = requiredPositiveIntArg(args, "number", 1_000_000);
  const inlineLocation = githubPullRequestInlineCommentLocation(args);
  const payloadDigest = githubPullRequestCommentCreateRequestPayloadDigest({
    owner, repo, pull_request_number: pullRequestNumber, body: stringArg(args, "body")!,
    ...(inlineLocation ? inlineLocation : {}),
  });
  const targetDigest = githubPullRequestCommentCreateTargetIdentityDigest({
    repository_id: observation.repository_id,
    canonical_full_name: observation.canonical_full_name,
    pull_request_id: observation.pull_request_id,
    pull_request_number: observation.pull_request_number,
  });
  if (Object.keys(args).some((key) => !["operation", "owner", "repo", "number", "body", "max_bytes", "comment_kind",
      "path", "start_line", "start_side", "line", "side"].includes(key)) ||
      route.operation !== "pr.comment.create" ||
      observation.requested_owner.toLowerCase() !== owner.toLowerCase() ||
      observation.requested_repo.toLowerCase() !== repo.toLowerCase() ||
      observation.canonical_full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
      observation.pull_request_number !== pullRequestNumber || observation.pull_request_locked ||
      (inlineLocation === undefined) !== (observation.comment_kind === undefined) ||
      (inlineLocation !== undefined && (observation.comment_kind !== "pull_request_review_inline" ||
        observation.path !== inlineLocation.path || observation.line !== inlineLocation.line ||
        observation.side !== inlineLocation.side || observation.start_line !== inlineLocation.start_line ||
        observation.start_side !== inlineLocation.start_side)) ||
      observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.request_payload_digest !== payloadDigest || observation.target_identity_digest !== targetDigest ||
      observation.mutation_sent || observation.used_for_authority || observation.may_execute ||
      observation.provider_observation_is_atomic || !observation.provider_data_is_untrusted) {
    throw new Error("github.write pr.comment.create target observation does not match the approved command and plan");
  }
  return observation;
}

export async function inspectGitHubIssueCommentCreateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubIssueCommentCreateContentReview> {
  const { observation, issue_title } = await inspectGitHubCommentCreateTargetDetails(args, opts, "issue.comment.create");
  if (observation.operation !== "issue.comment.create") throw new Error("GitHub issue comment review target mismatch");
  const base = {
    kind: "github_issue_comment_create" as const,
    operation: "github.write.issue.comment.create" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    issue_id: observation.issue_id,
    issue_number: observation.issue_number,
    issue_state: observation.issue_state,
    issue_locked: observation.issue_locked,
    issue_updated_at: observation.issue_updated_at,
    issue_title,
    body: stringArg(args, "body")!,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

export async function inspectGitHubPullRequestCommentCreateContentReview(args: Record<string, unknown>, opts: GitHubWriteOptions = {})
  : Promise<GitHubPullRequestCommentCreateContentReview> {
  const { observation, issue_title: pullRequestTitle, inline_diff: inlineDiff } =
    await inspectGitHubCommentCreateTargetDetails(args, opts, "pr.comment.create");
  if (observation.operation !== "pr.comment.create") throw new Error("GitHub pull request comment review target mismatch");
  const base = {
    kind: "github_pull_request_comment_create" as const,
    operation: "github.write.pr.comment.create" as const,
    requested_owner: observation.requested_owner,
    requested_repo: observation.requested_repo,
    canonical_full_name: observation.canonical_full_name,
    repository_id: observation.repository_id,
    repository_visibility: observation.repository_visibility,
    pull_request_id: observation.pull_request_id,
    pull_request_number: observation.pull_request_number,
    pull_request_state: observation.pull_request_state,
    pull_request_locked: observation.pull_request_locked,
    pull_request_updated_at: observation.pull_request_updated_at,
    pull_request_title: pullRequestTitle,
    comment_kind: inlineDiff ? "pull_request_review_inline" as const : "pull_request_timeline" as const,
    ...(inlineDiff ? {
      path: observation.operation === "pr.comment.create" ? observation.path : undefined,
      ...(observation.operation === "pr.comment.create" && observation.start_line !== undefined &&
          observation.start_side !== undefined ? {
        start_line: observation.start_line,
        start_side: observation.start_side,
      } : {}),
      line: observation.operation === "pr.comment.create" ? observation.line : undefined,
      side: observation.operation === "pr.comment.create" ? observation.side : undefined,
      head_commit_sha: inlineDiff.head_sha,
      base_commit_sha: inlineDiff.base_sha,
      diff_digest: inlineDiff.diff_digest,
      diff_excerpt: inlineDiff.excerpt,
    } : {}),
    body: stringArg(args, "body")!,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: createHash("sha256").update(
      canonicalGitHubWriteTargetVersionObservation(observation), "utf8").digest("hex"),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    command_digest: observation.command_digest,
    notification_effect: "github_api_may_trigger_notifications" as const,
    publication_effect: "visible_to_repository_audience" as const,
    comment_removal_retracts_notifications: false as const,
    provider_observation_is_atomic: false as const,
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...base, review_digest: sha256Hex(base) };
}

async function invokeGitHubIssueCommentCreate(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  return await invokeGitHubCommentCreate(args, opts, "issue.comment.create");
}

async function invokeGitHubPullRequestCommentCreate(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  return await invokeGitHubCommentCreate(args, opts, "pr.comment.create");
}

async function invokeGitHubCommentCreate(
  args: Record<string, unknown>,
  opts: GitHubWriteOptions,
  operation: GitHubCommentCreateOperation,
): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  if (route.operation !== operation) {
    throw new Error(`github.write ${operation} route mismatch; mutation_sent=false`);
  }
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error(`github.write ${operation} requires a command, Operation Plan binding, and approved target observation; mutation_sent=false`);
  }
  const expected: GitHubCommentCreateTargetObservation = operation === "issue.comment.create"
    ? assertGitHubIssueCommentCreateTargetVersion(args, opts.expected_target_version_observation,
      commandDigest, operationPlanBindingDigest)
    : assertGitHubPullRequestCommentCreateTargetVersion(args, opts.expected_target_version_observation,
      commandDigest, operationPlanBindingDigest);
  const current = operation === "issue.comment.create"
    ? await inspectGitHubIssueCommentCreateTargetVersion(args, {
      env,
      signal: opts.signal,
      command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      ...(opts.read_request ? { read_request: opts.read_request } : {}),
    })
    : await inspectGitHubPullRequestCommentCreateTargetVersion(args, {
    env,
    signal: opts.signal,
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error(`github.write ${operation} target changed after review; mutation_sent=false; outcome=stale`);
  }
  const inlineReviewObservation = operation === "pr.comment.create" && expected.operation === "pr.comment.create" &&
    expected.comment_kind === "pull_request_review_inline" ? expected : undefined;
  const actionRoute = inlineReviewObservation
    ? githubWriteRoute(args, inlineReviewObservation.pull_request_head_sha!)
    : route;
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, `github.write ${operation}`);
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: actionRoute.method, path: actionRoute.path, body: actionRoute.body, maxBytes, token }, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_request_failed";
    throw new Error(`github.write ${operation} outcome_unknown; do not retry automatically; check GitHub before a new Owner decision` +
      (operation === "issue.comment.create" ? "; " + message : ""));
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 201 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation,
        api_host: "api.github.com",
        repo: actionRoute.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: actionRoute.method,
        path: actionRoute.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    const message = isRecord(data) ? optionalString(data.message) : null;
    throw new Error(`github.write ${operation} outcome_unknown; HTTP ${response.status}; do not retry automatically; check GitHub before a new Owner decision` +
      (operation === "issue.comment.create" && message ? "; message=" + message : ""));
  }
  const comment = isRecord(data) ? data : null;
  const inlineRangeMatches = inlineReviewObservation
    ? inlineReviewObservation.start_line === undefined
      ? (comment?.start_line === undefined || comment.start_line === null || comment.start_line === inlineReviewObservation.line) &&
        (comment?.start_side === undefined || comment.start_side === null || comment.start_side === inlineReviewObservation.side)
      : comment?.start_line === inlineReviewObservation.start_line &&
        comment.start_side === inlineReviewObservation.start_side
    : true;
  const inlineResponseMatches = inlineReviewObservation
    ? !!comment && comment.path === inlineReviewObservation.path && comment.line === inlineReviewObservation.line &&
      comment.side === inlineReviewObservation.side && inlineRangeMatches &&
      comment.commit_id === inlineReviewObservation.pull_request_head_sha &&
      githubPullRequestIssueUrlMatches(comment.pull_request_url, githubNameArg(args, "owner"),
        githubNameArg(args, "repo"), requiredPositiveIntArg(args, "number", 1_000_000))
    : true;
  if (!comment || typeof comment.id !== "number" || !Number.isSafeInteger(comment.id) || comment.id <= 0 ||
      comment.body !== actionRoute.body.body || !inlineResponseMatches ||
      (operation === "pr.comment.create" && !inlineReviewObservation && !githubApiResourceUrlMatches(comment.issue_url,
        githubNameArg(args, "owner"), githubNameArg(args, "repo"), "issues", requiredPositiveIntArg(args, "number", 1_000_000)))) {
    throw new Error(`github.write ${operation} response did not confirm the exact comment and target; outcome_unknown; do not retry automatically`);
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation,
    api_host: "api.github.com",
    repo: actionRoute.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: actionRoute.method,
    path: actionRoute.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: { id: comment.id },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

async function invokeGitHubIssueUpdate(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.update") throw new Error("github.write issue.update route mismatch; mutation_sent=false");
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write issue.update requires a command, Operation Plan binding, and approved target observation; mutation_sent=false");
  }
  const expected = assertGitHubIssueUpdateTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubIssueUpdateTargetVersion(args, {
    env,
    signal: opts.signal,
    command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write issue.update target changed after review; mutation_sent=false; outcome=stale");
  }
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.update");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: route.method, path: route.path, body: route.body, maxBytes, token }, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_request_failed";
    throw new Error("github.write issue.update outcome_unknown; do not retry automatically; check GitHub before a new Owner decision; " + message);
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 200 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "issue.update",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: route.method,
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    const message = isRecord(data) ? optionalString(data.message) : null;
    throw new Error("github.write issue.update outcome_unknown; HTTP " + response.status +
      "; do not retry automatically; check GitHub before a new Owner decision" + (message ? "; message=" + message : ""));
  }
  const issue = isRecord(data) ? data : null;
  const desiredTitle = typeof route.body.title === "string" ? route.body.title : expected.issue_title;
  const desiredBody = typeof route.body.body === "string" ? route.body.body : expected.issue_body;
  if (!issue || "pull_request" in issue || issue.id !== expected.issue_id || issue.number !== expected.issue_number ||
      issue.title !== desiredTitle || issue.body !== desiredBody || issue.state !== expected.issue_state ||
      issue.locked !== expected.issue_locked || typeof issue.updated_at !== "string" ||
      !Number.isFinite(Date.parse(issue.updated_at))) {
    throw new Error("github.write issue.update response did not confirm the reviewed issue and exact content; outcome_unknown; do not retry automatically");
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "issue.update",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: route.method,
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: { id: issue.id, number: issue.number, title: issue.title, state: issue.state, locked: issue.locked },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

async function invokeGitHubIssueClose(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.close") throw new Error("github.write issue.close route mismatch; mutation_sent=false");
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write issue.close requires a command, Operation Plan binding, and reviewed target; mutation_sent=false");
  }
  const expected = assertGitHubIssueCloseTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubIssueCloseTargetVersion(args, {
    env, signal: opts.signal, command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write issue.close target changed after review; mutation_sent=false; outcome=stale");
  }
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.close");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: "PATCH", path: route.path, body: { state: "closed" }, maxBytes, token }, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_request_failed";
    throw new Error("github.write issue.close outcome_unknown; do not retry automatically; check GitHub before a new Owner decision; " + message);
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 200 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "issue.close",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: "PATCH",
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    throw new Error("github.write issue.close outcome_unknown; HTTP " + response.status +
      "; do not retry automatically; check GitHub before a new Owner decision");
  }
  const issue = isRecord(data) ? data : null;
  if (!issue || "pull_request" in issue || issue.id !== expected.issue_id || issue.number !== expected.issue_number ||
      issue.state !== "closed" || issue.locked !== false || issue.title !== expected.issue_title ||
      typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
    throw new Error("github.write issue.close response did not confirm the exact reviewed issue closed; outcome_unknown; do not retry automatically");
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "issue.close",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: "PATCH",
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: { id: issue.id, number: issue.number, state: issue.state, locked: issue.locked },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

async function invokeGitHubIssueReopen(args: Record<string, unknown>, opts: GitHubWriteOptions): Promise<unknown> {
  const maxBytes = positiveIntArg(args, "max_bytes", 128_000, 512_000);
  const env = opts.env ?? process.env;
  const route = githubWriteRoute(args);
  if (route.operation !== "issue.reopen") throw new Error("github.write issue.reopen route mismatch; mutation_sent=false");
  assertGitHubRepoAllowed(env, route.repo);
  const token = githubWriteToken(env);
  const commandDigest = opts.command_digest;
  const operationPlanBindingDigest = opts.operation_plan_binding_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest) ||
      !operationPlanBindingDigest || !/^[a-f0-9]{64}$/.test(operationPlanBindingDigest) ||
      !opts.expected_target_version_observation) {
    throw new Error("github.write issue.reopen requires a command, Operation Plan binding, and reviewed target; mutation_sent=false");
  }
  const expected = assertGitHubIssueReopenTargetVersion(args, opts.expected_target_version_observation,
    commandDigest, operationPlanBindingDigest);
  const current = await inspectGitHubIssueReopenTargetVersion(args, {
    env, signal: opts.signal, command_digest: commandDigest,
    operation_plan_binding_digest: operationPlanBindingDigest,
    ...(opts.read_request ? { read_request: opts.read_request } : {}),
  });
  if (canonicalGitHubWriteTargetVersionObservation(current) !== canonicalGitHubWriteTargetVersionObservation(expected)) {
    throw new Error("github.write issue.reopen target changed after review; mutation_sent=false; outcome=stale");
  }
  const request = opts.request ?? defaultGitHubWriteRequest;
  assertToolExecutionNotCancelled(opts.signal, "github.write issue.reopen");
  let response: GitHubWriteResponse;
  try {
    response = await request({ method: "PATCH", path: route.path, body: { state: "open" }, maxBytes, token }, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_request_failed";
    throw new Error("github.write issue.reopen outcome_unknown; do not retry automatically; check GitHub before a new Owner decision; " + message);
  }
  const data = parseJsonOrText(response.body);
  if (!response.ok || response.status !== 200 || response.truncated || !response.content_type?.toLowerCase().includes("json")) {
    const explicitRejection = !response.ok && !response.truncated &&
      [400, 401, 403, 404, 405, 410, 415, 422].includes(response.status);
    if (explicitRejection) {
      return {
        schema_version: "blue-tanuki.github-write-result.v1",
        operation: "issue.reopen",
        api_host: "api.github.com",
        repo: route.repo,
        repository_id: expected.repository_id,
        target_identity_digest: expected.target_identity_digest,
        request_payload_digest: expected.request_payload_digest,
        command_digest: expected.command_digest,
        operation_plan_binding_digest: expected.operation_plan_binding_digest,
        method: "PATCH",
        path: route.path,
        status: response.status,
        mutation_status: "provider_rejected",
        result_digest: sha256Hex(data),
        retry_permitted: false,
        next_action: "Do not retry automatically. Preserve the rejection receipt and make a new Owner decision.",
        provider_data_is_untrusted: true,
        used_for_authority: false,
        may_execute: false,
      };
    }
    throw new Error("github.write issue.reopen outcome_unknown; HTTP " + response.status +
      "; do not retry automatically; check GitHub before a new Owner decision");
  }
  const issue = isRecord(data) ? data : null;
  if (!issue || "pull_request" in issue || issue.id !== expected.issue_id || issue.number !== expected.issue_number ||
      issue.state !== "open" || issue.locked !== false || issue.title !== expected.issue_title ||
      typeof issue.updated_at !== "string" || !Number.isFinite(Date.parse(issue.updated_at))) {
    throw new Error("github.write issue.reopen response did not confirm the exact reviewed issue open; outcome_unknown; do not retry automatically");
  }
  return {
    schema_version: "blue-tanuki.github-write-result.v1",
    operation: "issue.reopen",
    api_host: "api.github.com",
    repo: route.repo,
    repository_id: expected.repository_id,
    target_identity_digest: expected.target_identity_digest,
    request_payload_digest: expected.request_payload_digest,
    command_digest: expected.command_digest,
    operation_plan_binding_digest: expected.operation_plan_binding_digest,
    method: "PATCH",
    path: route.path,
    status: response.status,
    mutation_status: "provider_accepted",
    content_type: response.content_type,
    truncated: response.truncated,
    rate_limit_remaining: response.rate_limit_remaining,
    github_request_id: response.request_id,
    result_digest: sha256Hex(data),
    result: { id: issue.id, number: issue.number, state: issue.state, locked: issue.locked },
    provider_data_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

export async function invokeBrowserRead(
  args: Record<string, unknown>,
  opts: BrowserReadOptions = {},
): Promise<unknown> {
  const requestedUrl = parseHttpUrl(stringArg(args, "url")!);
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 512_000);
  const maxChars = positiveIntArg(args, "max_chars", 8_000, 50_000);
  const fetched = await fetchHttpResponse(
    { url: requestedUrl.href, method: "GET", max_bytes: maxBytes },
    opts,
  );
  if (!fetched.ok) {
    throw new Error(`browser.read returned HTTP ${fetched.status}`);
  }
  assertBrowserReadableResponseIsText(fetched, {
    attachment: "browser_read_attachment_response_rejected; response_not_exposed; automatic_retry=false; next_action=inspect_without_resubmitting",
    nonText: "browser_read_non_text_response_rejected; response_not_exposed; automatic_retry=false; next_action=inspect_without_resubmitting",
  });
  const finalUrl = parseHttpUrl(fetched.url);
  const body = fetched.body;
  const isHtml =
    fetched.content_type === null ||
    fetched.content_type.toLowerCase().includes("html") ||
    /<\/?[a-z][\s\S]*>/i.test(body);
  const text = isHtml
    ? htmlToText(body, maxChars)
    : truncateText(body.replace(/\s+/g, " ").trim(), maxChars);
  return {
    url: finalUrl.href,
    status: fetched.status,
    content_type: fetched.content_type,
    title: isHtml ? htmlTitle(body) : null,
    text,
    links: isHtml ? htmlLinks(body, finalUrl.href, 20) : [],
    truncated: fetched.truncated || text.length >= maxChars,
    observation: createBrowserObservation({
      requestedUrl,
      finalUrl,
      observedAt: new Date(),
      navigation: "http_get",
      tabScope: "not_applicable",
      frameScope: "not_applicable",
      credentialContext: "no_tool_supplied_credentials",
      evidenceSource: opts.request ? "FIXTURE" : "EXTERNAL_EVIDENCE",
    }),
  };
}

type BrowserObservationNavigation = "http_get" | "browser_snapshot" | "browser_download";
type BrowserObservationEvidenceSource = "EXTERNAL_EVIDENCE" | "FIXTURE";

function createBrowserObservation(input: {
  requestedUrl: URL;
  finalUrl: URL;
  observedAt: Date;
  navigation: BrowserObservationNavigation;
  tabScope: "not_applicable" | "single_ephemeral_tab";
  frameScope: "not_applicable" | "main_frame";
  credentialContext: "no_tool_supplied_credentials" | "ephemeral_no_persistent_profile";
  evidenceSource: BrowserObservationEvidenceSource;
}): Record<string, unknown> {
  return {
    schema_version: "blue-tanuki.browser-observation.v1",
    observed_at: input.observedAt.toISOString(),
    requested_origin: input.requestedUrl.origin,
    final_origin: input.finalUrl.origin,
    origin_changed: input.requestedUrl.origin !== input.finalUrl.origin,
    navigation: input.navigation,
    tab_scope: input.tabScope,
    frame_scope: input.frameScope,
    credential_context: input.credentialContext,
    evidence_source: input.evidenceSource,
    page_content_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
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
  clearCookies(): Promise<void>;
  close(): Promise<void>;
}

interface PageLike {
  route?(
    pattern: string,
    handler: (route: RouteLike, request: RequestLike) => Promise<void>,
  ): Promise<void>;
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  setContent(html: string, options: Record<string, unknown>): Promise<void>;
  title(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  url(): string;
  getByRole?(role: "link" | "search", options: { name: string; exact: true }): LocatorLike;
}

interface LocatorLike {
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  evaluate<Result>(expression: string): Promise<Result>;
}

interface RouteLike {
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface RequestLike {
  url(): string;
  method(): string;
  isNavigationRequest(): boolean;
}

function isBrowserHtmlContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isBrowserTextResultContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType !== undefined && (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" || mediaType.endsWith("+json") ||
    mediaType === "application/xml" || mediaType === "application/xhtml+xml" || mediaType.endsWith("+xml")
  );
}

function isBrowserDownloadContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/plain" || mediaType === "text/csv" || mediaType === "text/xml" ||
    mediaType === "application/json" || mediaType === "application/xml" ||
    Boolean(mediaType?.endsWith("+json") || mediaType?.endsWith("+xml"));
}

export function assertBrowserFormResponseIsReadableText(response: Pick<
  HttpFetchResponse,
  "status" | "content_type" | "content_disposition" | "body"
>): void {
  assertBrowserReadableResponseIsText(response, {
    attachment: "browser_form_get_download_not_saved; outcome_unknown; automatic_retry=false; next_action=inspect_without_resubmitting",
    nonText: "browser_form_get_non_text_result_rejected; download_not_saved; outcome_unknown; automatic_retry=false; next_action=inspect_without_resubmitting",
  });
}

export function assertBrowserDownloadResponseIsBoundedTextAttachment(
  response: Pick<HttpFetchResponse, "status" | "ok" | "content_type" | "content_disposition" | "content_encoding" | "body" | "truncated">,
  limits: { max_bytes: number; max_chars: number },
): NonNullable<BrowserAutomationRunResult["download"]> {
  const disposition = response.content_disposition?.trim().toLowerCase() ?? "";
  if (!response.ok || response.status !== 200) {
    throw new Error("browser_download_http_response_rejected; content_not_exposed; saved_locally=false; automatic_retry=false");
  }
  if (disposition.includes(",") || !/^attachment(?:\s*;|$)/.test(disposition)) {
    throw new Error("browser_download_response_is_not_an_attachment; content_not_exposed; saved_locally=false");
  }
  const contentEncoding = response.content_encoding?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error("browser_download_encoded_content_not_supported; content_not_exposed; saved_locally=false");
  }
  if (!isBrowserDownloadContentType(response.content_type)) {
    throw new Error("browser_download_content_type_not_supported; only_plain_text_csv_json_or_xml; content_not_exposed; saved_locally=false");
  }
  if (response.truncated || response.body.includes("\uFFFD")) {
    throw new Error("browser_download_content_incomplete_or_invalid_utf8; content_not_exposed; saved_locally=false; automatic_retry=false");
  }
  const sizeBytes = Buffer.byteLength(response.body, "utf8");
  if (sizeBytes > limits.max_bytes || response.body.length > limits.max_chars) {
    throw new Error("browser_download_size_limit_exceeded; partial_content_not_exposed; saved_locally=false; automatic_retry=false");
  }
  return {
    content_type: response.content_type!.split(";", 1)[0]!.trim().toLowerCase(),
    content: response.body,
    content_sha256: createHash("sha256").update(response.body, "utf8").digest("hex"),
    size_bytes: sizeBytes,
    saved_locally: false,
    content_is_untrusted: true,
    used_for_authority: false,
    may_execute: false,
  };
}

function assertBrowserReadableResponseIsText(response: Pick<
  HttpFetchResponse,
  "status" | "content_type" | "content_disposition" | "body"
>, errors: { attachment: string; nonText: string }): void {
  const disposition = response.content_disposition?.trim();
  const dispositionValues = disposition?.split(",").map((value) => value.split(";", 1)[0]?.trim().toLowerCase()) ?? [];
  if (dispositionValues.includes("attachment")) {
    throw new Error(errors.attachment);
  }
  if (response.status === 204 && response.body.length === 0) return;
  if (!isBrowserTextResultContentType(response.content_type)) {
    throw new Error(errors.nonText);
  }
}

async function setBrowserDocumentContent(page: PageLike, html: string, baseUrl: string, timeoutMs: number): Promise<void> {
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.evaluate(`(() => {
    const requestedBase = ${JSON.stringify(baseUrl)};
    const root = document.documentElement;
    if (!root) return;
    let head = document.head;
    if (!head) {
      head = document.createElement("head");
      root.insertBefore(head, root.firstChild);
    }
    for (const existing of head.querySelectorAll("base")) existing.remove();
    const base = document.createElement("base");
    base.href = requestedBase;
    head.prepend(base);
  })()`);
}

async function importPlaywright(): Promise<PlaywrightLike> {
  try {
    // Playwright selects its browser registry during module initialization; package-local binaries use path "0".
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    const specifier = "playwright-core";
    const imported = await import(specifier);
    if (!isRecord(imported)) {
      throw new Error("playwright module did not load as an object");
    }
    return imported as PlaywrightLike;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      "browser automation preview engine unavailable; mutation_sent=false; " +
        "next_action=repair the packaged Playwright Core runtime or keep the preview disabled; " +
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
      chromiumSandbox: true,
      env: {
        ...safeProcessEnv(),
        PLAYWRIGHT_BROWSERS_PATH: "0",
      },
    });
    context = await browser.newContext({
      viewport: { ...BROWSER_AUTOMATION_VIEWPORT },
      acceptDownloads: false,
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    if (!page.route) throw new Error("browser network interception unavailable; mutation_sent=false");
    await page.route("**/*", async (route, browserRequest) => {
      try {
        if (request.action === "form_submit" || request.action === "form_fill") {
          await route.abort();
          return;
        }
        const requestUrl = browserRequest.url();
        const method = browserRequest.method().toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          await route.abort();
          return;
        }
        const parsedRequestUrl = parseHttpUrl(requestUrl);
        if ((request.action === "click" || request.action === "download") && browserRequest.isNavigationRequest() &&
            parsedRequestUrl.origin !== new URL(request.url).origin) {
          await route.abort();
          return;
        }
        await resolvePublicTarget(parsedRequestUrl, request.env, request.resolveHost);
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    let formFinalUrl: URL | null = null;
    let formHttpStatus: number | undefined;
    let formText: string | null = null;
    let formResponseTruncated = false;
    let formRequestDispatched = false;
    let formStateDigest: string | undefined;
    let downloadResult: BrowserAutomationRunResult["download"];
    let finalUrlOverride: URL | null = null;
    if (request.action === "form_submit" || request.action === "form_fill") {
      if (!request.action_url || !request.form_name || !request.fields || !page.getByRole) {
        throw new Error("browser_form_get_request_unavailable; form_submission_sent=false");
      }
      let sourceResponse;
      try {
        sourceResponse = await request.http_request(request.target, "GET", BROWSER_FORM_RESPONSE_MAX_BYTES, request.signal);
      } catch {
        throw new Error("browser_form_get_source_unavailable; form_submission_sent=false");
      }
      if (isRedirect(sourceResponse.status) || sourceResponse.location) {
        throw new Error("browser_form_get_source_redirect_denied; form_submission_sent=false");
      }
      if (!sourceResponse.ok || sourceResponse.truncated ||
          !isBrowserHtmlContentType(sourceResponse.content_type)) {
        throw new Error("browser_form_get_source_unusable; form_submission_sent=false");
      }
      formHttpStatus = sourceResponse.status;
      formResponseTruncated = sourceResponse.truncated;
      await setBrowserDocumentContent(page, sourceResponse.body, request.url, request.timeout_ms);
    } else {
      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: request.timeout_ms,
      });
    }
    if (request.action === "click" || request.action === "download") {
      if (!request.link_name || !request.target_url || !page.getByRole) {
        throw new Error(request.action === "download"
          ? "browser_download_link_unavailable; saved_locally=false"
          : "browser_link_navigation_unavailable; mutation_sent=false");
      }
      const link = page.getByRole("link", { name: request.link_name, exact: true });
      if (await link.count() !== 1) {
        throw new Error(request.action === "download"
          ? "browser_download_link_not_unique; saved_locally=false"
          : "browser_link_navigation_not_unique; mutation_sent=false");
      }
      const href = await link.getAttribute("href");
      if (!href) throw new Error(request.action === "download"
        ? "browser_download_link_target_missing; saved_locally=false"
        : "browser_link_navigation_target_missing; mutation_sent=false");
      let linkUrl: URL;
      try {
        linkUrl = parseHttpUrl(new URL(href, page.url()).href);
      } catch {
        throw new Error(request.action === "download"
          ? "browser_download_link_target_invalid; saved_locally=false"
          : "browser_link_navigation_target_invalid; mutation_sent=false");
      }
      if (linkUrl.origin !== new URL(request.url).origin) {
        throw new Error(request.action === "download"
          ? "browser_download_cross_origin_denied; saved_locally=false"
          : "browser_link_navigation_cross_origin_denied; mutation_sent=false");
      }
      let expectedLinkUrl: URL;
      try {
        expectedLinkUrl = parseHttpUrl(request.target_url);
      } catch {
        throw new Error(request.action === "download"
          ? "browser_download_reviewed_target_invalid; saved_locally=false"
          : "browser_link_navigation_expected_target_invalid; mutation_sent=false");
      }
      if (linkUrl.href !== expectedLinkUrl.href) {
        throw new Error(request.action === "download"
          ? "browser_download_link_target_changed_after_review; saved_locally=false"
          : "browser_link_navigation_target_changed_after_review; mutation_sent=false");
      }
      if (request.action === "download") {
        const maxBytes = request.download_max_bytes ?? BROWSER_DOWNLOAD_DEFAULT_MAX_BYTES;
        let fetched: HttpFetchResult;
        try {
          fetched = await fetchHttpResponse({ url: linkUrl.href, method: "GET", max_bytes: maxBytes }, {
            env: request.env,
            resolveHost: request.resolveHost,
            request: request.http_request,
            signal: request.signal,
          }, () => false);
        } catch {
          if (request.signal?.aborted) {
            throw new Error("browser_download_cancelled; content_not_exposed; saved_locally=false; automatic_retry=false");
          }
          throw new Error("browser_download_request_unavailable; content_not_exposed; saved_locally=false; automatic_retry=false");
        }
        if (request.signal?.aborted) {
          throw new Error("browser_download_cancelled; content_not_exposed; saved_locally=false; automatic_retry=false");
        }
        downloadResult = assertBrowserDownloadResponseIsBoundedTextAttachment(fetched, {
          max_bytes: maxBytes,
          max_chars: request.max_chars,
        });
        finalUrlOverride = parseHttpUrl(fetched.url);
      } else {
        await resolvePublicTarget(linkUrl, request.env, request.resolveHost);
        await page.goto(linkUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: request.timeout_ms,
        });
      }
    } else if (request.action === "form_submit" || request.action === "form_fill") {
      if (!request.action_url || !request.form_name || !request.fields || !page.getByRole) {
        throw new Error("browser_form_get_request_unavailable; form_submission_sent=false");
      }
      const searchRegion = page.getByRole("search", { name: request.form_name, exact: true });
      if (await searchRegion.count() !== 1) {
        throw new Error("browser_form_get_search_region_not_unique; form_submission_sent=false");
      }
      const form = await searchRegion.evaluate<BrowserSearchFormSnapshot>(`element => {
        const forms = element.matches("form") ? [element] : Array.from(element.querySelectorAll("form"));
        if (forms.length !== 1) return { form_count: forms.length, control_count: 0, controls: [], method: "", action: "", target: "", enctype: "", accept_charset: "", form_markup: "" };
        const current = forms[0];
        const controls = Array.from(current.elements);
        return {
          form_count: 1,
          control_count: controls.length,
          method: current.method || "",
          action: current.action || "",
          target: current.target || "",
          enctype: current.enctype || "",
          accept_charset: current.acceptCharset || "",
          form_markup: current.outerHTML,
          controls: controls.slice(0, 16).map(control => ({
            tag: control.tagName.toLowerCase(),
            type: "type" in control ? String(control.type || "").toLowerCase() : "",
            name: "name" in control ? String(control.name || "") : "",
            disabled: "disabled" in control ? Boolean(control.disabled) : false,
            required: "required" in control ? Boolean(control.required) : false,
            read_only: "readOnly" in control ? Boolean(control.readOnly) : false,
            min_length: "minLength" in control ? Number(control.minLength) : -1,
            max_length: "maxLength" in control ? Number(control.maxLength) : -1,
            has_pattern: control.hasAttribute("pattern"),
            autocomplete: "autocomplete" in control ? String(control.autocomplete || "") : "",
            has_formaction: control.hasAttribute("formaction"),
            has_formmethod: control.hasAttribute("formmethod"),
            has_formenctype: control.hasAttribute("formenctype"),
            has_formtarget: control.hasAttribute("formtarget"),
            has_formnovalidate: control.hasAttribute("formnovalidate"),
            dirname: "dirname" in control ? String(control.dirname || "") : ""
          }))
        };
      }`);
      const submissionUrl = buildBrowserSearchFormGetUrl({
        source_url: request.url,
        expected_action_url: request.action_url,
        form,
        fields: request.fields,
        ...(request.action === "form_submit" && request.expected_form_state_digest
          ? { expected_form_state_digest: request.expected_form_state_digest } : {}),
      });
      formStateDigest = browserFormStateDigest(form);
      const fieldsBase64 = Buffer.from(JSON.stringify(request.fields), "utf8").toString("base64");
      const fillResult = await searchRegion.evaluate<{ ok: boolean; filled_count: number; valid: boolean }>(`element => {
        const bytes = Uint8Array.from(atob("${fieldsBase64}"), value => value.charCodeAt(0));
        const fields = JSON.parse(new TextDecoder().decode(bytes));
        const forms = element.matches("form") ? [element] : Array.from(element.querySelectorAll("form"));
        if (forms.length !== 1 || !Array.isArray(fields)) return { ok: false, filled_count: 0, valid: false };
        const form = forms[0];
        const editableInputTypes = new Set(${JSON.stringify(BROWSER_SEARCH_FORM_EDITABLE_INPUT_TYPES)});
        let filledCount = 0;
        for (const field of fields) {
          if (!field || typeof field.name !== "string" || typeof field.value !== "string") {
            return { ok: false, filled_count: filledCount, valid: false };
          }
          const matches = Array.from(form.elements).filter(control => {
            const tag = control.tagName.toLowerCase();
            const type = "type" in control ? String(control.type || "").toLowerCase() : "";
            return ((tag === "input" && editableInputTypes.has(type)) || (tag === "textarea" && type === "")) &&
              String(control.name || "") === field.name;
          });
          if (matches.length !== 1) return { ok: false, filled_count: filledCount, valid: false };
          const control = matches[0];
          const value = control.tagName.toLowerCase() === "textarea"
            ? field.value.replace(/\\r\\n?/g, "\\n") : field.value;
          control.value = value;
          if (control.value !== value) return { ok: false, filled_count: filledCount, valid: false };
          filledCount += 1;
        }
        return { ok: true, filled_count: filledCount, valid: form.checkValidity() };
      }`);
      if (!fillResult?.ok || fillResult.filled_count !== request.fields.length) {
        throw new Error(request.action === "form_submit"
          ? "browser_form_get_input_fill_failed; form_submission_sent=false"
          : "browser_form_input_fill_failed; final_submit_sent=false");
      }
      if (!fillResult.valid) {
        throw new Error(request.action === "form_submit"
          ? "browser_form_get_native_validation_failed; form_submission_sent=false"
          : "browser_form_input_native_validation_failed; final_submit_sent=false");
      }
      if (request.action === "form_fill") {
        formFinalUrl = new URL(request.url);
      } else {
        if (!request.input_receipt_digest || !request.expected_form_state_digest) {
          throw new Error("browser_form_get_input_stage_receipt_required; form_submission_sent=false");
        }
        const submissionTarget = await resolvePublicTarget(submissionUrl, request.env, request.resolveHost);
        if (!request.before_form_submit) {
          throw new Error("browser_form_get_gateway_gate_unavailable; form_submission_sent=false");
        }
        assertToolExecutionNotCancelled(request.signal, "browser.automation form_submit");
        request.before_form_submit();
        let submissionResponse;
        formRequestDispatched = true;
        try {
          submissionResponse = await request.http_request(
            submissionTarget,
            "GET",
            BROWSER_FORM_RESPONSE_MAX_BYTES,
            request.signal,
          );
        } catch {
          throw new Error("browser_form_get_outcome_unknown; automatic_retry=false");
        }
        if (isRedirect(submissionResponse.status) || submissionResponse.location) {
          throw new Error("browser_form_get_redirect_blocked; outcome_unknown; automatic_retry=false");
        }
        assertBrowserFormResponseIsReadableText(submissionResponse);
        formFinalUrl = submissionUrl;
        formHttpStatus = submissionResponse.status;
        formResponseTruncated = submissionResponse.truncated;
        if (isBrowserHtmlContentType(submissionResponse.content_type)) {
          try {
            await setBrowserDocumentContent(page, submissionResponse.body, submissionUrl.href, request.timeout_ms);
          } catch {
            throw new Error("browser_form_get_result_parse_failed; outcome_unknown; automatic_retry=false");
          }
        } else {
          formText = submissionResponse.body;
        }
      }
    }
    const finalUrl = formFinalUrl?.href ?? finalUrlOverride?.href ?? page.url();
    const parsedFinalUrl = parseHttpUrl(finalUrl);
    if ((request.action === "click" || request.action === "download") &&
        parsedFinalUrl.origin !== new URL(request.url).origin) {
      throw new Error("browser_link_navigation_cross_origin_denied; mutation_sent=false");
    }
    if (request.action !== "form_submit" && request.action !== "download") {
      await resolvePublicTarget(parsedFinalUrl, request.env, request.resolveHost);
    }
    let title: string;
    let bodyText: unknown;
    try {
      title = downloadResult || formText !== null ? "" : await page.title();
      bodyText = downloadResult ? "" : formText ?? await page.evaluate("document.body ? document.body.innerText : ''");
    } catch (error) {
      if (request.action === "form_submit" && formRequestDispatched) {
        throw new Error("browser_form_get_result_parse_failed; outcome_unknown; automatic_retry=false");
      }
      throw error;
    }
    const text = typeof bodyText === "string" ? bodyText.replace(/\s+/g, " ").trim() : "";
    return {
      engine: "playwright.chromium",
      final_url: finalUrl,
      title: title.trim().length > 0 ? title : null,
      text: truncateText(text, request.max_chars),
      truncated: formResponseTruncated || text.length > request.max_chars,
      ...(formHttpStatus === undefined ? {} : { http_status: formHttpStatus }),
      ...(formStateDigest ? { form_state_digest: formStateDigest } : {}),
      ...(downloadResult ? { download: downloadResult } : {}),
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
  return await invokeBrowserPreview(args, opts, "snapshot");
}

async function invokeBrowserPreview(
  args: Record<string, unknown>,
  opts: BrowserSnapshotOptions,
  action: BrowserAutomationRunRequest["action"],
  linkName?: string,
  formSubmission?: BrowserFormGetArguments | BrowserFormInputArguments,
  linkNavigation?: BrowserLinkNavigationArguments | BrowserDownloadArguments,
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
    action,
    url: url.href,
    ...(linkName || linkNavigation ? { link_name: linkName ?? linkNavigation?.link_name } : {}),
    ...(linkNavigation ? { target_url: linkNavigation.target_url } : {}),
    ...(linkNavigation?.action === "download" ? {
      download_max_bytes: linkNavigation.max_bytes ?? BROWSER_DOWNLOAD_DEFAULT_MAX_BYTES,
    } : {}),
    ...(formSubmission ? { action_url: formSubmission.action_url } : {}),
    ...(formSubmission ? { form_name: formSubmission.form_name, fields: formSubmission.fields } : {}),
    ...(formSubmission?.action === "form_submit" ? {
      ...(formSubmission.input_receipt_digest ? { input_receipt_digest: formSubmission.input_receipt_digest } : {}),
      ...(formSubmission.expected_form_state_digest ? { expected_form_state_digest: formSubmission.expected_form_state_digest } : {}),
    } : {}),
    ...(action === "form_submit" && opts.before_form_submit
      ? { before_form_submit: opts.before_form_submit } : {}),
    http_request: opts.request ?? defaultHttpRequest,
    ...(opts.signal ? { signal: opts.signal } : {}),
    target,
    timeout_ms: timeoutMs,
    max_chars: maxChars,
    env,
    resolveHost,
  });
  let finalUrl: URL;
  try {
    finalUrl = parseHttpUrl(snapshot.final_url);
  } catch (error) {
    if (action === "form_submit") {
      throw new Error("browser_form_get_outcome_unknown; automatic_retry=false");
    }
    throw error;
  }
  if (action === "form_submit" && (!formSubmission || finalUrl.origin !== url.origin ||
      finalUrl.pathname !== new URL(formSubmission.action_url).pathname)) {
    throw new Error("browser_form_get_outcome_unknown; automatic_retry=false");
  }
  if (action === "form_fill" && (!formSubmission || finalUrl.href !== url.href ||
      !snapshot.form_state_digest || !/^[a-f0-9]{64}$/.test(snapshot.form_state_digest))) {
    throw new Error("browser_form_input_result_unavailable; final_submit_sent=false");
  }
  if ((action === "click" || action === "download") && finalUrl.origin !== url.origin) {
    throw new Error(action === "download"
      ? "browser_download_cross_origin_denied; saved_locally=false"
      : "browser_link_navigation_cross_origin_denied; mutation_sent=false");
  }
  if (action !== "form_submit") {
    await resolvePublicTarget(finalUrl, env, resolveHost);
  }
  const displayedUrl = new URL(url.href);
  const displayedFinalUrl = new URL(finalUrl.href);
  if (action === "form_submit" || action === "form_fill" || action === "download") {
    displayedUrl.search = "";
    displayedUrl.hash = "";
    displayedFinalUrl.search = "";
    displayedFinalUrl.hash = "";
  }

  return {
    preview: "browser.automation",
    enabled: true,
    action,
    engine: snapshot.engine,
    url: displayedUrl.href,
    final_url: displayedFinalUrl.href,
    title: snapshot.title,
    text: truncateText(snapshot.text, maxChars),
    truncated: snapshot.truncated || snapshot.text.length > maxChars,
    ...(snapshot.download ? { download: snapshot.download } : {}),
    observation: createBrowserObservation({
      requestedUrl: url,
      finalUrl,
      observedAt: new Date(),
      navigation: action === "download" ? "browser_download" : "browser_snapshot",
      tabScope: "single_ephemeral_tab",
      frameScope: "main_frame",
      credentialContext: "ephemeral_no_persistent_profile",
      evidenceSource: opts.runner ? "FIXTURE" : "EXTERNAL_EVIDENCE",
    }),
    sandbox: {
      persistent_profile: false,
      downloads: "disabled",
      credential_reuse: false,
      javascript_enabled: false,
      service_workers: "blocked",
    },
    ...(action === "form_submit" ? {
      submission: {
        method: "GET",
        scope: "same_origin_search_form",
        external_effect_class: "form_submission_unclassified",
        target_url: formSubmission?.action_url,
        ...(snapshot.http_status === undefined ? {} : { response_status: snapshot.http_status }),
        query_values_in_result_url: false,
      },
    } : {}),
    ...(action === "form_fill" ? {
      form_input: {
        effect: "ephemeral_dom_fill_only",
        form_state_digest: snapshot.form_state_digest,
        field_names: formSubmission?.fields.map((field) => field.name) ?? [],
        final_submit: false,
        used_for_authority: false,
      },
    } : {}),
    network_policy: {
      protocol: url.protocol.replace(":", ""),
      host: target.hostname,
      allowlist_configured: Boolean(env.BLUE_TANUKI_HTTP_ALLOWLIST?.trim()),
      ssrf_guard: "public_address_required",
    },
    resource_limits: {
      timeout_ms: timeoutMs,
      max_chars: maxChars,
      ...(linkNavigation?.action === "download" ? {
        download_max_bytes: linkNavigation.max_bytes ?? BROWSER_DOWNLOAD_DEFAULT_MAX_BYTES,
      } : {}),
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
  const acceptedKeys = action === "form_submit"
    ? new Set(["action", "url", "action_url", "form_name", "fields", "input_receipt_digest", "expected_form_state_digest", "max_chars", "timeout_ms"])
    : action === "form_fill"
      ? new Set(["action", "url", "action_url", "form_name", "fields", "max_chars", "timeout_ms"])
    : action === "click"
      ? new Set(["action", "url", "max_chars", "timeout_ms", "link_name", "target_url"])
      : action === "download"
        ? new Set(["action", "url", "max_chars", "max_bytes", "timeout_ms", "link_name", "target_url"])
      : new Set(["action", "url", "max_chars", "timeout_ms"]);
  if (Object.keys(args).some((key) => !acceptedKeys.has(key))) {
    throw new Error("browser.automation received an unsupported argument; mutation_sent=false");
  }

  if (action !== "navigate" && action !== "click" && action !== "download" &&
      action !== "form_fill" && action !== "form_submit") {
    throw new Error(
      `browser.automation action ${action} is preview-quarantined and not implemented; ` +
        "approval_level=L3_final_review; mutation_sent=false",
    );
  }
  const formSubmission = action === "form_submit"
    ? parseBrowserFormGetArguments({ ...args, action })
    : action === "form_fill" ? parseBrowserFormInputArguments({ ...args, action }) : undefined;
  if (action === "form_submit" && !opts.runner &&
      (!formSubmission || !formSubmission.input_receipt_digest || !formSubmission.expected_form_state_digest)) {
    throw new Error("browser_form_get_input_stage_receipt_required; form_submission_sent=false");
  }
  if (action === "form_submit" && !opts.runner && !opts.before_form_submit) {
    throw new Error("browser_form_get_gateway_gate_unavailable; form_submission_sent=false");
  }
  const linkNavigation = action === "click"
    ? parseBrowserLinkNavigationArguments(args)
    : action === "download" ? parseBrowserDownloadArguments(args)
    : undefined;
  const linkName = linkNavigation?.link_name;
  if (action === "click" && (!linkName || !isWellFormedBrowserLinkName(linkName))) {
    throw new Error("browser.automation click requires an exact link_name and target_url; mutation_sent=false");
  }
  if (action !== "click" && action !== "download" && action !== "form_submit" && action !== "form_fill" &&
      (args.link_name !== undefined || args.target_url !== undefined)) {
    throw new Error("browser.automation navigation does not accept link_name; mutation_sent=false");
  }
  const snapshot = await invokeBrowserPreview(args, opts, action, linkName, formSubmission, linkNavigation);
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
  env: Record<string, string | undefined>,
): Promise<ExactFileSearchTarget> {
  assertExactFileSearchPath(filePath);
  const resolved = await resolveSandboxFilePath(filePath, sandboxRoot, env);
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
  const query = args.query === "" && requestedFilePath !== undefined ? "" : stringArg(args, "query")!;
  if (query.length === 0 && requestedFilePath === undefined) {
    throw new Error("file.search requires a query unless an exact relative file path is selected");
  }
  const startLineValue = args.start_line;
  if (startLineValue !== undefined && (typeof startLineValue !== "number" || !Number.isSafeInteger(startLineValue) ||
      startLineValue < 1 || startLineValue > 1_000_000 || query.length !== 0 || requestedFilePath === undefined)) {
    throw new Error("file.search start_line requires an exact-file preview and must be between 1 and 1000000");
  }
  const startLine = startLineValue === undefined ? 1 : startLineValue;
  const maxResults = positiveIntArg(args, "max_results", 20, 100);
  if (query.length === 0 && maxResults > 5) {
    throw new Error("file.search exact-file preview is limited to five lines");
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("root must be a directory");
  }

  const targetVersionHasher = createHash("sha256").update("blue-tanuki.file-search-resource-version.v1\n", "utf8");
  const matches: Array<{ path: string; line_number: number; line: string }> = [];
  let visited = 0;
  const appendMatches = (relativeFilePath: string, data: Buffer, firstLine = 1) => {
    if (matches.length >= maxResults || data.includes(0)) return;
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = firstLine - 1; i < lines.length; i++) {
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
    const target = await readExactFileSearchTarget(requestedFilePath, root, sandboxRoot, env);
    visited = 1;
    appendFileSearchVersionEntry(targetVersionHasher, root, target.filepath, target.data);
    appendMatches(target.relative_path, target.data, query.length === 0 ? startLine : 1);
  } else {
    for await (const file of walkFiles(root, sandboxRoot, env)) {
      if (visited >= 1_000) break;
      if (await isHdsMemoryArtifact(file, env)) continue;
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
    const target = await readExactFileSearchTarget(requestedFilePath, root, sandboxRoot, env);
    appendFileSearchVersionEntry(hasher, root, target.filepath, target.data);
    filesExamined = 1;
  } else {
    for await (const file of walkFiles(root, sandboxRoot, env)) {
      if (filesExamined >= 1_000) break;
      if (await isHdsMemoryArtifact(file, env)) continue;
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
    const resolved = await resolveSandboxFilePath(stringArg(args, "path")!, sandboxRoot, env);
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
  const { filepath: resolvedPath, relative_path } = await resolveSandboxFilePath(pathArg, sandboxRoot, env);
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
  const resolved = await resolveSandboxFilePath(pathArg, sandboxRoot, opts.env ?? process.env);
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
  size_bytes: number;
  max_bytes: number;
  observation: FileDeleteTargetVersionObservation;
}

/** J計画で選ばれた、sandbox内の単一regular file削除対象をdigestだけで観測する。 */
async function resolveFileDeleteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileDeleteOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest">,
): Promise<ResolvedFileDeleteTargetVersion> {
  assertToolExecutionNotCancelled(opts.signal, "file.delete target inspection");
  const pathArg = stringArg(args, "path")!;
  if (!opts.command_digest || !opts.operation_plan_binding_digest ||
      !/^[a-f0-9]{64}$/.test(opts.command_digest) || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest) ||
      Object.keys(args).some((key) => !["path", "max_bytes"].includes(key))) {
    throw new Error("file.delete target resolver requires a bounded planned command");
  }
  assertPlannedFileDeletePath(pathArg);
  const maxBytes = positiveIntArg(args, "max_bytes", 256_000, 1_000_000);
  const sandboxRoot = await sandboxRootFromEnv(opts.env ?? process.env);
  const resolved = await resolveSandboxFilePath(pathArg, sandboxRoot, opts.env ?? process.env);
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
      assertToolExecutionNotCancelled(opts.signal, "file.delete target inspection");
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
  assertToolExecutionNotCancelled(opts.signal, "file.delete target inspection");
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
  return { filepath, size_bytes: contents.length, max_bytes: maxBytes, observation };
}

export async function inspectFileDeleteTargetVersion(
  args: Record<string, unknown>,
  opts: Pick<FileDeleteOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileDeleteTargetVersionObservation> {
  return (await resolveFileDeleteTargetVersion(args, opts)).observation;
}

/** No-store owner projection for the exact sandbox-relative file selected for deletion. */
export async function inspectFileDeleteContentReview(
  args: Record<string, unknown>,
  opts: Pick<FileDeleteOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileDeleteTargetContentReview> {
  assertToolExecutionNotCancelled(opts.signal, "file.delete content review");
  if (!opts.command_digest || !opts.operation_plan_binding_digest) {
    throw new Error("file.delete content review requires the selected Operation Plan binding");
  }
  const resolved = await resolveFileDeleteTargetVersion(args, opts);
  const pathArg = stringArg(args, "path")!;
  const targetVersionDigest = createHash("sha256")
    .update(canonicalFileDeleteTargetVersionObservation(resolved.observation), "utf8").digest("hex");
  const requestPayloadDigest = createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-delete-content-review-request.v1", pathArg, resolved.max_bytes,
  ]), "utf8").digest("hex");
  const reviewDigest = createHash("sha256").update(JSON.stringify([
    "blue-tanuki.file-delete-content-review.v1", opts.command_digest,
    opts.operation_plan_binding_digest, requestPayloadDigest, targetVersionDigest,
  ]), "utf8").digest("hex");
  return {
    kind: "file_delete_target",
    path: pathArg,
    size_bytes: resolved.size_bytes,
    max_bytes: resolved.max_bytes,
    target_version_digest: targetVersionDigest,
    operation_plan_binding_digest: opts.operation_plan_binding_digest,
    request_payload_digest: requestPayloadDigest,
    command_digest: opts.command_digest,
    review_digest: reviewDigest,
    used_for_authority: false,
    may_execute: false,
  };
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
    const candidate = await resolveSandboxFilePath(pathArg, sandboxRoot, env);
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

async function readBoundedFileHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    assertToolExecutionNotCancelled(signal, "file target inspection");
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
  opts: Pick<FileEditOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest">,
): Promise<ResolvedFileEditTargetVersion> {
  assertToolExecutionNotCancelled(opts.signal, "file.edit target inspection");
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
  const requested = await resolveSandboxFilePath(pathArg, sandboxRoot, opts.env ?? process.env);
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
    beforeBuffer = await readBoundedFileHandle(handle, maxBytes, opts.signal);
    assertToolExecutionNotCancelled(opts.signal, "file.edit target inspection");
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
  opts: Pick<FileEditOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest"> = {},
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
  opts: Pick<FileEditOptions, "env" | "signal" | "command_digest" | "operation_plan_binding_digest"> = {},
): Promise<FileEditDiffContentReview> {
  assertToolExecutionNotCancelled(opts.signal, "file.edit content review");
  if (!opts.command_digest || !/^[a-f0-9]{64}$/.test(opts.command_digest) ||
      !opts.operation_plan_binding_digest || !/^[a-f0-9]{64}$/.test(opts.operation_plan_binding_digest)) {
    throw new Error("file.edit content review requires a bound command and Operation Plan source");
  }
  const resolved = await resolveFileEditTargetVersion(args, opts);
  assertToolExecutionNotCancelled(opts.signal, "file.edit content review");
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
  description: "Read-only text search under a requested root directory, optionally limited to one exact relative file. With an exact file path, an empty query returns at most five lines from start_line (default 1); start_line is accepted only for this exact-file preview. After an explicitly requested workspace test, use the same relative file path to reread current state and return the saved result to the owner.",
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
    env?: Env; signal?: AbortSignal; operation_plan_binding_digest?: string; command_digest?: string;
  }): Promise<FileDeleteTargetVersionObservation> {
    return await inspectFileDeleteTargetVersion(args, options);
  },
  async inspect_content_review(args, options): Promise<FileDeleteTargetContentReview> {
    return await inspectFileDeleteContentReview(args, options);
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
    env?: Env; signal?: AbortSignal; operation_plan_binding_digest?: string; command_digest?: string;
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
  description: "Read public GitHub repository, branch/base commit, issue, and pull request metadata from api.github.com. Base identity is an untrusted read observation, never authority.",
  required_capabilities: requireToolOperationDescriptor("github.read").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeGitHubRead(args, { signal: context.signal });
  },
};

export const githubWriteTool: Tool = {
  name: "github.write",
  description: "Create plan-bound GitHub issues, comments, pull requests, one new file on an existing non-default branch at an exact expected HEAD, and unpublished draft releases on an existing exact tag. Issue close and reopen are separate, each limited to one exact unlocked issue. Repository writes require target recheck and no-store L3 content review. Pull request creation binds repositories and branch tips. Inline comments bind exact diff lines. Issue updates are limited to the reviewed title/body.",
  required_capabilities: requireToolOperationDescriptor("github.write").required_capabilities,
  async inspect_target_version(args, options = {}): Promise<GitHubWriteTargetVersionObservation> {
    if (githubOperation(args) === "release.draft.create") {
      return await inspectGitHubReleaseDraftCreateTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "code.push") {
      return await inspectGitHubCodePushTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.create") {
      return await inspectGitHubPullRequestCreateTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.merge") {
      return await inspectGitHubPullRequestMergeTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.update") {
      return await inspectGitHubIssueUpdateTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.close") {
      return await inspectGitHubIssueCloseTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.reopen") {
      return await inspectGitHubIssueReopenTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.comment.create") {
      return await inspectGitHubIssueCommentCreateTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.comment.create") {
      return await inspectGitHubPullRequestCommentCreateTargetVersion(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) !== "issue.create") {
      throw new Error(`github.write ${githubOperation(args)} target observation is not implemented; status=BUILD_GAP`);
    }
    return await inspectGitHubIssueCreateTargetVersion(args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.command_digest ? { command_digest: options.command_digest } : {}),
      ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
    });
  },
  async inspect_content_review(args, options = {}): Promise<GitHubIssueCreateContentReview | GitHubIssueUpdateContentReview |
    GitHubIssueCloseContentReview | GitHubIssueReopenContentReview | GitHubIssueCommentCreateContentReview | GitHubPullRequestCommentCreateContentReview | GitHubPullRequestCreateContentReview |
    GitHubPullRequestMergeContentReview | GitHubCodePushContentReview | GitHubReleaseDraftCreateContentReview> {
    if (githubOperation(args) === "release.draft.create") {
      return await inspectGitHubReleaseDraftCreateContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "code.push") {
      return await inspectGitHubCodePushContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.create") {
      return await inspectGitHubPullRequestCreateContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.merge") {
      return await inspectGitHubPullRequestMergeContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.update") {
      return await inspectGitHubIssueUpdateContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.close") {
      return await inspectGitHubIssueCloseContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.reopen") {
      return await inspectGitHubIssueReopenContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "issue.comment.create") {
      return await inspectGitHubIssueCommentCreateContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) === "pr.comment.create") {
      return await inspectGitHubPullRequestCommentCreateContentReview(args, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.command_digest ? { command_digest: options.command_digest } : {}),
        ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
      });
    }
    if (githubOperation(args) !== "issue.create") {
      throw new Error(`github.write ${githubOperation(args)} content review is not implemented; status=BUILD_GAP`);
    }
    return await inspectGitHubIssueCreateContentReview(args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.command_digest ? { command_digest: options.command_digest } : {}),
      ...(options.operation_plan_binding_digest ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
    });
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const observation = context.target_version_observation?.schema_version === "blue-tanuki.github-write-target-version.v1"
      ? context.target_version_observation : undefined;
    // Target observations bind operationPlanDigest(command); context.command_digest is the Executor ticket digest.
    return await invokeGitHubWrite(args, { signal: context.signal,
      command_digest: observation?.command_digest ?? context.command_digest,
      expected_target_version_observation: observation,
      operation_plan_binding_digest: observation?.operation_plan_binding_digest });
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
  description: "既定で無効なpreview用headless browser操作。リンク移動とテキスト添付取得はL3確認済みの同一origin完全URLへ固定する。downloadはtext/plain・text/csv・JSON・XMLだけを上限付きで非信頼入力としてCへ返し、ローカル保存はしない。保存する場合は別のfile.write提案とL3確認を使う。form_fillはL3確認後に一時DOMへ値を入れるだけで送信しない。入力はtext/search/email/url/tel/number/date/time/month/week/datetime-localとtextareaに限定し、他のcontrolは拒否する。form_submitは短期receipt・別L3・実行直前のform-state再照合後に同一originへGETを一回だけ送る。GETの外部効果は未分類とし、結果不明時に自動再送しない。",
  required_capabilities: requireToolOperationDescriptor("browser.automation").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeBrowserAutomation(args, {
      ...(context.before_browser_form_submit
        ? { before_form_submit: context.before_browser_form_submit } : {}),
    });
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
