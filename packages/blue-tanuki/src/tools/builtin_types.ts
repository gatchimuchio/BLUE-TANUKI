import type { FileSearchTargetVersionObservation, FileWriteTargetVersionObservation,
  FileDeleteTargetVersionObservation, FileEditTargetVersionObservation } from "@blue-tanuki/protocol";

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
  content_disposition?: string | null;
  content_encoding?: string | null;
  location: string | null;
  body: string;
  truncated: boolean;
}

export interface HttpFetchOptions {
  env?: Env;
  signal?: AbortSignal;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (
    target: HttpFetchTarget,
    method: "GET" | "HEAD",
    maxBytes: number,
    signal?: AbortSignal,
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
  /** Used only by the built-in GitHub write preflight to observe a private allowlisted repository. */
  token?: string;
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
  signal?: AbortSignal;
  request?: (target: GitHubReadTarget, signal?: AbortSignal) => Promise<GitHubReadResponse>;
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
  signal?: AbortSignal;
  request?: (target: GitHubWriteTarget, signal?: AbortSignal) => Promise<GitHubWriteResponse>;
  read_request?: (target: GitHubReadTarget, signal?: AbortSignal) => Promise<GitHubReadResponse>;
  expected_target_version_observation?: import("@blue-tanuki/protocol").GitHubWriteTargetVersionObservation;
  command_digest?: string;
  operation_plan_binding_digest?: string;
}

export interface BrowserReadOptions extends HttpFetchOptions {}

export type BrowserAutomationAction =
  | "smoke"
  | "navigate"
  | "click"
  | "form_fill"
  | "form_submit"
  | "download"
  | "upload";

export interface BrowserAutomationRunRequest {
  action: "snapshot" | "navigate" | "click" | "download" | "form_fill" | "form_submit";
  url: string;
  link_name?: string;
  target_url?: string;
  download_max_bytes?: number;
  action_url?: string;
  form_name?: string;
  fields?: readonly { name: string; value: string }[];
  input_receipt_digest?: string;
  expected_form_state_digest?: string;
  before_form_submit?: () => void;
  target: HttpFetchTarget;
  timeout_ms: number;
  max_chars: number;
  env: Env;
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>;
  http_request: NonNullable<HttpFetchOptions["request"]>;
  signal?: AbortSignal;
}

export interface BrowserAutomationRunResult {
  engine: string;
  final_url: string;
  title: string | null;
  text: string;
  truncated: boolean;
  http_status?: number;
  form_state_digest?: string;
  download?: {
    content_type: string;
    content: string;
    content_sha256: string;
    size_bytes: number;
    saved_locally: false;
    content_is_untrusted: true;
    used_for_authority: false;
    may_execute: false;
  };
}

export type BrowserAutomationRunner = (
  request: BrowserAutomationRunRequest,
) => Promise<BrowserAutomationRunResult>;

export interface BrowserAutomationOptions extends HttpFetchOptions {
  runner?: BrowserAutomationRunner;
  before_form_submit?: () => void;
}

export interface BrowserSnapshotOptions extends BrowserAutomationOptions {}

export interface FileSearchOptions {
  env?: Env;
  expected_target_version?: FileSearchTargetVersionObservation;
  operation_plan_binding_digest?: string;
  /** Executor-private evidence channel; omitted from ordinary tool results. */
  include_target_version_observation?: boolean;
}

export interface FileWriteOptions {
  env?: Env;
  expected_target_version?: FileWriteTargetVersionObservation;
  operation_plan_binding_digest?: string;
  command_digest?: string;
}

export interface FileDeleteOptions {
  env?: Env;
  expected_target_version?: FileDeleteTargetVersionObservation;
  operation_plan_binding_digest?: string;
  command_digest?: string;
}

export interface FileEditOptions {
  env?: Env;
  expected_target_version?: FileEditTargetVersionObservation;
  operation_plan_binding_digest?: string;
  command_digest?: string;
}
