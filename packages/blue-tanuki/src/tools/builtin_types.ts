export type Env = Record<string, string | undefined>;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface HttpFetchTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface HttpFetchResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  location: string | null;
  body: string;
  truncated: boolean;
}

export interface HttpFetchOptions {
  env?: Env;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (
    target: HttpFetchTarget,
    method: "GET" | "HEAD",
    maxBytes: number,
  ) => Promise<HttpFetchResponse>;
}

export interface WebSearchOptions extends HttpFetchOptions {}

export interface WebSearchResult {
  title: string;
  url: string | null;
  snippet: string;
}

export interface GitHubReadTarget {
  path: string;
  maxBytes: number;
}

export interface GitHubReadResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  truncated: boolean;
  rate_limit_remaining: string | null;
}

export interface GitHubReadOptions {
  request?: (target: GitHubReadTarget) => Promise<GitHubReadResponse>;
}

export type GitHubWriteMethod = "POST" | "PATCH";

export interface GitHubWriteTarget {
  method: GitHubWriteMethod;
  path: string;
  body: Record<string, unknown>;
  maxBytes: number;
  token: string;
}

export interface GitHubWriteResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  truncated: boolean;
  rate_limit_remaining: string | null;
  request_id: string | null;
}

export interface GitHubWriteOptions {
  env?: Env;
  request?: (target: GitHubWriteTarget) => Promise<GitHubWriteResponse>;
}

export interface BrowserReadOptions extends HttpFetchOptions {}

export type BrowserAutomationAction =
  | "smoke"
  | "navigate"
  | "click"
  | "form_submit"
  | "download"
  | "upload";

export interface BrowserAutomationRunRequest {
  action: "snapshot" | "navigate";
  url: string;
  target: HttpFetchTarget;
  timeout_ms: number;
  max_chars: number;
  env: Env;
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface BrowserAutomationRunResult {
  engine: string;
  final_url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

export type BrowserAutomationRunner = (
  request: BrowserAutomationRunRequest,
) => Promise<BrowserAutomationRunResult>;

export interface BrowserAutomationOptions extends HttpFetchOptions {
  runner?: BrowserAutomationRunner;
}

export interface BrowserSnapshotOptions extends BrowserAutomationOptions {}

export interface FileSearchOptions {
  env?: Env;
}

export interface FileWriteOptions {
  env?: Env;
}
