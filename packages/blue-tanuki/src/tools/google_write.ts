import { createHash } from "node:crypto";
import * as https from "node:https";
import { GmailWriteTargetVersionObservationSchema, normalizeGmailAddressList, requireToolOperationDescriptor,
  type GmailWriteTargetVersionObservation } from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { assertToolExecutionNotCancelled, type GmailDraftContentReview, type Tool } from "./registry.js";

type Env = Record<string, string | undefined>;

export type GoogleWriteService = "gmail" | "calendar" | "drive";
export type GoogleWriteMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GoogleWriteTarget {
  service: GoogleWriteService;
  hostname: "gmail.googleapis.com" | "www.googleapis.com";
  path: string;
  method: GoogleWriteMethod;
  maxBytes: number;
  token: string;
  body?: string;
  contentType?: string;
  /** Digest-only identity from an approved Executor ticket; not an authority token. */
  idempotency_key?: string;
  command_digest?: string;
}

export interface GoogleWriteResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  truncated: boolean;
  request_id: string | null;
}

export interface GoogleWriteOptions {
  env?: Env;
  signal?: AbortSignal;
  request?: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  idempotency_key?: string;
  command_digest?: string;
}

const GOOGLE_WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 128_000;
const MAX_MAX_BYTES = 512_000;
const DEFAULT_MAX_CONTENT_BYTES = 64_000;
const MAX_CONTENT_BYTES = 512_000;
const DRIVE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink";

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
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

function headerString(value: string | string[] | number | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "number") return String(value);
  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface GmailDraftSnapshot {
  draft_id: string;
  raw: string;
  state_digest: string;
  raw_digest: string;
  request_payload_digest: string;
  content_review: GmailDraftContentReview;
}

function decodeMimeHeaderValue(value: string): string {
  const decoded = value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset: string, encoding: string, payload: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b"
        ? Buffer.from(payload, "base64")
        : Buffer.from(payload.replace(/_/g, " ").replace(/=([a-f0-9]{2})/gi,
          (_hexMatch, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "binary");
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      throw new Error("gmail_draft_header_encoding_unsupported");
    }
  });
  if (decoded.includes("=?")) throw new Error("gmail_draft_header_encoding_unsupported");
  return decoded;
}

function decodeQuotedPrintable(value: string): Buffer {
  if (/=(?![a-f0-9]{2}|\r?\n)/i.test(value)) throw new Error("gmail_draft_body_encoding_unsupported");
  const unescaped = value.replace(/=\r?\n/g, "").replace(/=([a-f0-9]{2})/gi,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(unescaped, "binary");
}

function decodeGmailDraftMime(raw: string): Omit<GmailDraftContentReview, "account_email" | "provider_state_digest" |
  "provider_raw_digest" | "request_payload_digest"> {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("gmail_draft_raw_message_invalid");
  const bytes = Buffer.from(raw, "base64url");
  if (!bytes.length || bytes.length > MAX_CONTENT_BYTES || bytes.toString("base64url") !== raw) {
    throw new Error("gmail_draft_raw_message_invalid");
  }
  let message: string;
  try { message = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("gmail_draft_message_encoding_unsupported"); }
  const crlfSeparator = message.indexOf("\r\n\r\n");
  const lfSeparator = message.indexOf("\n\n");
  const separator = crlfSeparator >= 0 && (lfSeparator < 0 || crlfSeparator <= lfSeparator)
    ? crlfSeparator : lfSeparator;
  if (separator < 0) throw new Error("gmail_draft_mime_headers_missing");
  const separatorLength = message.startsWith("\r\n\r\n", separator) ? 4 : 2;
  const headerText = message.slice(0, separator);
  const bodySource = message.slice(separator + separatorLength);
  const unfolded: string[] = [];
  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const previous = unfolded.at(-1);
      if (!previous) throw new Error("gmail_draft_mime_headers_invalid");
      unfolded[unfolded.length - 1] = `${previous} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  const headers = new Map<string, string[]>();
  const supportedHeaders = new Set([
    "from", "to", "cc", "bcc", "reply-to", "subject", "mime-version",
    "content-type", "content-transfer-encoding", "content-disposition",
  ]);
  for (const line of unfolded) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error("gmail_draft_mime_headers_invalid");
    const name = match[1]!.toLowerCase();
    if (!supportedHeaders.has(name)) throw new Error("gmail_draft_mime_header_unsupported");
    headers.set(name, [...(headers.get(name) ?? []), decodeMimeHeaderValue(match[2]!.trim())]);
  }
  const single = (name: string): string | undefined => {
    const values = headers.get(name);
    if (!values?.length) return undefined;
    if (values.length !== 1) throw new Error("gmail_draft_mime_header_ambiguous");
    return values[0];
  };
  const mimeVersion = single("mime-version");
  if (mimeVersion !== undefined && mimeVersion !== "1.0") {
    throw new Error("gmail_draft_mime_version_unsupported");
  }
  const contentType = single("content-type") ?? "text/plain; charset=utf-8";
  const contentTypeParts = contentType.split(";").map((part) => part.trim());
  const mediaType = contentTypeParts.shift()?.toLowerCase();
  const charsetParams = contentTypeParts.filter((part) => /^charset\s*=/i.test(part));
  if (mediaType !== "text/plain" || charsetParams.length !== contentTypeParts.length || charsetParams.length > 1) {
    throw new Error("gmail_draft_mime_content_unsupported");
  }
  const disposition = single("content-disposition");
  if (disposition !== undefined && disposition.toLowerCase() !== "inline") {
    throw new Error("gmail_draft_mime_content_unsupported");
  }
  const charset = charsetParams.length === 1
    ? /^charset\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^;\s]+))$/i.exec(charsetParams[0]!)
    : null;
  if (charsetParams.length === 1 && !charset) throw new Error("gmail_draft_mime_content_unsupported");
  const charsetName = (charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "utf-8").toLowerCase();
  const transferEncoding = (single("content-transfer-encoding") ?? "7bit").toLowerCase();
  let bodyBytes: Buffer;
  if (transferEncoding === "base64") {
    const compact = bodySource.replace(/[\r\n\t ]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new Error("gmail_draft_body_encoding_unsupported");
    }
    bodyBytes = Buffer.from(compact, "base64");
    if (bodyBytes.toString("base64") !== compact) throw new Error("gmail_draft_body_encoding_unsupported");
  } else if (transferEncoding === "quoted-printable") {
    bodyBytes = decodeQuotedPrintable(bodySource);
  } else if (["7bit", "8bit", "binary"].includes(transferEncoding)) {
    bodyBytes = Buffer.from(bodySource, "utf8");
  } else {
    throw new Error("gmail_draft_body_encoding_unsupported");
  }
  if (bodyBytes.length > MAX_CONTENT_BYTES) throw new Error("gmail_draft_content_size_unsupported");
  let bodyText: string;
  try { bodyText = new TextDecoder(charsetName, { fatal: true }).decode(bodyBytes); }
  catch { throw new Error("gmail_draft_body_charset_unsupported"); }
  const from = single("from");
  if (!from) throw new Error("gmail_draft_sender_unresolved");
  const to = single("to");
  const cc = single("cc");
  const bcc = single("bcc");
  if (!to && !cc && !bcc) throw new Error("gmail_draft_recipients_missing");
  return {
    from,
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(single("reply-to") ? { reply_to: single("reply-to") } : {}),
    subject: single("subject") ?? "",
    body_text: bodyText,
  };
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

function parseJsonOrEmpty(body: string, label: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON response; mutation_status=not_confirmed`);
  }
}

function googleToken(
  env: Env,
  names: readonly string[],
  toolName: string,
): string {
  for (const name of names) {
    const token = env[name]?.trim();
    if (token) return token;
  }
  throw new Error(
    `${names.join(" or ")} is required for ${toolName}; request_sent=false; mutation_sent=false`,
  );
}

async function defaultGoogleWriteRequest(
  target: GoogleWriteTarget,
  signal?: AbortSignal,
): Promise<GoogleWriteResponse> {
  return await new Promise((resolve, reject) => {
    const requestBody = target.body === undefined ? null : Buffer.from(target.body, "utf8");
    let finished = false;
    const finish = (result: GoogleWriteResponse): void => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${target.token}`,
      "User-Agent": `BLUE-TANUKI/0.1 ${target.service}.write`,
    };
    // The provider may ignore this header. It is a lookup hint only; Executor never retries an unknown write.
    if (target.idempotency_key) headers["Idempotency-Key"] = target.idempotency_key;
    if (requestBody) {
      headers["Content-Type"] = target.contentType ?? "application/json";
      headers["Content-Length"] = String(requestBody.length);
    }
    const req = https.request(
      {
        protocol: "https:",
        hostname: target.hostname,
        path: target.path,
        method: target.method,
        headers,
        timeout: GOOGLE_WRITE_TIMEOUT_MS,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerString(res.headers["content-type"]);
        const requestId =
          headerString(res.headers["x-request-id"]) ??
          headerString(res.headers["x-guploader-uploadid"]);
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
            request_id: requestId,
          });
        });
        res.on("error", (error) => {
          if (!finished) fail(error);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `${target.service}.write timed out after ${GOOGLE_WRITE_TIMEOUT_MS}ms; mutation_status=not_confirmed`,
        ),
      );
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function readGmailDraftSnapshot(
  args: Record<string, unknown>,
  options: GoogleWriteOptions = {},
  tokenOverride?: string,
): Promise<GmailDraftSnapshot> {
  const draftId = stringArg(args, "draft_id")!;
  if (draftId.length > 256 || /[\r\n]/.test(draftId)) throw new Error("gmail_draft_id_invalid");
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = options.env ?? process.env;
  const token = tokenOverride ?? googleToken(env, ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.write draft review");
  const request = options.request ?? defaultGoogleWriteRequest;
  const get = async (path: string): Promise<unknown> => {
    let response: GoogleWriteResponse;
    try {
      assertToolExecutionNotCancelled(options.signal, "gmail.write draft review");
      response = await request({ service: "gmail", hostname: "gmail.googleapis.com", path, method: "GET",
        maxBytes, token }, options.signal);
    } catch {
      if (options.signal?.aborted) {
        throw new Error("gmail_draft_read_cancelled; request_status=not_confirmed; mutation_sent=false");
      }
      throw new Error("gmail_draft_read_unavailable; request_sent=false; mutation_sent=false");
    }
    if (!response.ok || response.truncated) {
      throw new Error(`gmail_draft_read_unavailable; http_status=${response.status}; request_sent=false; mutation_sent=false`);
    }
    try { return JSON.parse(response.body) as unknown; }
    catch { throw new Error("gmail_draft_read_response_invalid; request_sent=false; mutation_sent=false"); }
  };
  const profile = await get("/gmail/v1/users/me/profile");
  if (!isRecord(profile) || typeof profile.emailAddress !== "string" || !profile.emailAddress.trim() ||
      profile.emailAddress.trim().length > 320 || /[\r\n]/.test(profile.emailAddress)) {
    throw new Error("gmail_account_identity_unavailable; request_sent=false; mutation_sent=false");
  }
  const accountEmail = profile.emailAddress.trim();
  const resource = await get(`/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`);
  if (!isRecord(resource) || resource.id !== draftId || !isRecord(resource.message) ||
      typeof resource.message.id !== "string" || !resource.message.id.trim() ||
      typeof resource.message.raw !== "string") {
    throw new Error("gmail_draft_resource_invalid; request_sent=false; mutation_sent=false");
  }
  const raw = resource.message.raw;
  const content = decodeGmailDraftMime(raw);
  const rawDigest = sha256String(raw);
  const accountIdentityDigest = sha256String(accountEmail.toLowerCase());
  const stateDigest = operationPlanDigest({
    schema_version: "blue-tanuki.gmail-draft-provider-state.v1",
    account_identity_digest: accountIdentityDigest,
    draft_id: draftId,
    message_id: resource.message.id,
    raw_digest: rawDigest,
  });
  const requestPayloadDigest = gmailDraftSendRequestPayloadDigest({ operation: "draft.send", draft_id: draftId }, rawDigest);
  return {
    draft_id: draftId,
    raw,
    state_digest: stateDigest,
    raw_digest: rawDigest,
    request_payload_digest: requestPayloadDigest,
    content_review: {
      account_email: accountEmail,
      ...content,
      provider_state_digest: stateDigest,
      provider_raw_digest: rawDigest,
      request_payload_digest: requestPayloadDigest,
    },
  };
}

function googleWriteResponseError(toolName: string, response: GoogleWriteResponse): Error {
  let message = "";
  try {
    const parsed = JSON.parse(response.body) as unknown;
    if (isRecord(parsed)) {
      const error = parsed.error;
      const nested = isRecord(error) ? optionalString(error.message) : null;
      message = nested ?? optionalString(parsed.message) ?? "";
    }
  } catch {
    // Keep error output bounded and token-free.
  }
  return new Error(
    `${toolName} returned HTTP ${response.status}; mutation_status=not_confirmed; next_action=check Google/audit before retrying${message ? `; message=${message}` : ""}`,
  );
}

function operationArg(args: Record<string, unknown>, allowed: readonly string[]): string {
  const operation = stringArg(args, "operation")!.toLowerCase();
  if (!allowed.includes(operation)) {
    throw new Error(`operation must be ${allowed.join(", ")}`);
  }
  return operation;
}

function executionRequestIdentity(options: GoogleWriteOptions): Pick<GoogleWriteTarget, "idempotency_key" | "command_digest"> {
  const key = options.idempotency_key;
  const commandDigest = options.command_digest;
  if (key === undefined && commandDigest === undefined) return {};
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) ||
      typeof commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(commandDigest)) {
    throw new Error("approved execution request identity is invalid; mutation_sent=false");
  }
  return { idempotency_key: key, command_digest: commandDigest };
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function safeHeaderValue(value: string, label: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} must not contain CR/LF header control characters; mutation_sent=false`);
  }
  return value;
}

function safeAddressList(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const raw = args[name];
  if (raw === undefined && !required) return undefined;
  const value = normalizeGmailAddressList(raw);
  if (!value) {
    throw new Error(`${name} must be a bounded comma-separated list of bare email addresses; mutation_sent=false`);
  }
  return safeHeaderValue(value, name);
}

function encodedSubject(value: string): string {
  const safe = safeHeaderValue(value, "subject");
  return /^[\x20-\x7e]*$/.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function encodedMimeMessage(args: Record<string, unknown>): string {
  const to = safeAddressList(args, "to", true)!;
  const subject = encodedSubject(stringArg(args, "subject")!);
  const bodyText = stringArg(args, "body_text", false) ?? stringArg(args, "body", false) ?? "";
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const cc = safeAddressList(args, "cc");
  if (cc) headers.splice(1, 0, `Cc: ${safeHeaderValue(cc, "cc")}`);
  const bcc = safeAddressList(args, "bcc");
  if (bcc) headers.splice(cc ? 2 : 1, 0, `Bcc: ${safeHeaderValue(bcc, "bcc")}`);
  const from = stringArg(args, "from", false);
  if (from) headers.unshift(`From: ${safeHeaderValue(from, "from")}`);
  const replyTo = safeAddressList(args, "reply_to");
  if (replyTo) headers.splice(headers.indexOf(`Subject: ${subject}`), 0, `Reply-To: ${replyTo}`);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${bodyText}`, "utf8").toString("base64url");
}

function googleResultSummary(data: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!isRecord(data)) return { ...fallback };
  const summary: Record<string, unknown> = { ...fallback };
  for (const key of ["id", "threadId", "name", "mimeType", "modifiedTime", "webViewLink", "htmlLink", "status", "summary"] as const) {
    if (data[key] !== undefined) summary[key] = data[key];
  }
  const message = data.message;
  if (isRecord(message)) {
    if (message.id !== undefined) summary.message_id = message.id;
    if (message.threadId !== undefined) summary.message_thread_id = message.threadId;
  }
  return summary;
}

function mutationResult(
  toolName: string,
  service: GoogleWriteService,
  operation: string,
  target: Pick<GoogleWriteTarget, "hostname" | "path" | "method">,
  response: GoogleWriteResponse,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  const data = parseJsonOrEmpty(response.body, toolName);
  const result = googleResultSummary(data, fallback);
  return {
    service,
    mode: "write",
    operation,
    api_host: target.hostname,
    path: target.path,
    method: target.method,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    google_request_id: response.request_id,
    request_status: "ok",
    mutation_sent: true,
    mutation_status: "confirmed",
    result_digest: sha256Hex(result),
    result,
  };
}

export async function invokeGmailWrite(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions = {},
  expectedDraftObservation?: GmailWriteTargetVersionObservation,
): Promise<unknown> {
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.write");
  const sendRequest = opts.request ?? defaultGoogleWriteRequest;

  let draftSnapshot: GmailDraftSnapshot | undefined;
  if (operation === "draft.send") {
    if (!expectedDraftObservation || expectedDraftObservation.provider_state_digest === undefined ||
        expectedDraftObservation.provider_raw_digest === undefined) {
      throw new Error("gmail.write draft.send target state evidence is required; request_sent=false; mutation_sent=false");
    }
    draftSnapshot = await readGmailDraftSnapshot(args, opts, token);
    if (draftSnapshot.state_digest !== expectedDraftObservation.provider_state_digest ||
        draftSnapshot.raw_digest !== expectedDraftObservation.provider_raw_digest ||
        draftSnapshot.request_payload_digest !== expectedDraftObservation.request_payload_digest ||
        gmailWriteTargetIdentityDigest(args) !== expectedDraftObservation.target_identity_digest) {
      throw new Error("gmail.write draft.send content or provider version changed; request_sent=false; mutation_sent=false");
    }
  }
  const builtRequest = gmailWriteRequest(args, draftSnapshot?.raw);
  const { path, body } = builtRequest;

  const target = {
    service: "gmail" as const,
    hostname: "gmail.googleapis.com" as const,
    path,
    method: "POST" as const,
    maxBytes,
    token,
    body,
    ...executionRequestIdentity(opts),
  };
  assertToolExecutionNotCancelled(opts.signal, "gmail.write");
  const response = await sendRequest(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("gmail.write", response);
  return mutationResult("gmail.write", "gmail", operation, target, response);
}

/** Gmailのdraft.create / message.sendで送る正確なrequest body digest。資格情報の読取り・送信は行わない。 */
export function gmailWriteRequestPayloadDigest(args: Record<string, unknown>): string {
  const operation = operationArg(args, ["draft.create", "message.send"]);
  const request = gmailWriteRequest(args);
  if ((operation === "draft.create" && request.path !== "/gmail/v1/users/me/drafts") ||
      (operation === "message.send" && request.path !== "/gmail/v1/users/me/messages/send")) {
    throw new Error("gmail_target_version_operation_unsupported");
  }
  return createHash("sha256").update(request.body, "utf8").digest("hex");
}

/** draft.sendの正確なrequest intentをdraft IDとprovider MIME digestで束ねる。MIME本文は保持しない。 */
export function gmailDraftSendRequestPayloadDigest(args: Record<string, unknown>, rawDigest: string): string {
  if (operationArg(args, ["draft.send"]) !== "draft.send" || !/^[a-f0-9]{64}$/.test(rawDigest)) {
    throw new Error("gmail_target_version_operation_unsupported");
  }
  return operationPlanDigest({
    schema_version: "blue-tanuki.gmail-draft-send-payload.v1",
    draft_id: stringArg(args, "draft_id")!,
    provider_raw_digest: rawDigest,
  });
}

/** 送信先文字列を観測へ保持せず、operationと宛先一式の同一性digestを作る。 */
export function gmailWriteTargetIdentityDigest(args: Record<string, unknown>): string {
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  if (operation === "draft.send") {
    return operationPlanDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v3",
      service: "gmail", operation, draft_id: stringArg(args, "draft_id")! });
  }
  const recipients: Record<string, string> = { to: safeAddressList(args, "to", true)! };
  for (const name of ["cc", "bcc", "reply_to"] as const) {
    const recipient = safeAddressList(args, name);
    if (recipient) recipients[name] = recipient;
  }
  return operationPlanDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v4",
    service: "gmail", operation, recipients });
}

async function inspectGmailWriteTargetVersion(args: Record<string, unknown>, options: {
  env?: Readonly<Record<string, string | undefined>>;
  request?: (target: GoogleWriteTarget) => Promise<GoogleWriteResponse>;
  operation_plan_binding_digest?: string;
  command_digest?: string;
}): Promise<GmailWriteTargetVersionObservation> {
  const commandDigest = options.command_digest;
  if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest)) {
    throw new Error("gmail.write target resolver requires an exact HDS command digest");
  }
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  const observation: Record<string, unknown> = {
    schema_version: "blue-tanuki.gmail-write-target-version.v1",
    target_identity_digest: gmailWriteTargetIdentityDigest(args),
    command_digest: commandDigest,
    ...(options.operation_plan_binding_digest
      ? { operation_plan_binding_digest: options.operation_plan_binding_digest } : {}),
    used_for_authority: false,
    may_execute: false,
  };
  if (operation === "draft.send") {
    const snapshot = await readGmailDraftSnapshot(args, {
      ...(options.env ? { env: { ...options.env } } : {}),
      ...(options.request ? { request: options.request } : {}),
    });
    observation.request_payload_digest = snapshot.request_payload_digest;
    observation.provider_state_digest = snapshot.state_digest;
    observation.provider_raw_digest = snapshot.raw_digest;
  } else {
    observation.request_payload_digest = gmailWriteRequestPayloadDigest(args);
  }
  return GmailWriteTargetVersionObservationSchema.parse(observation);
}

function assertGmailWriteTargetVersion(args: Record<string, unknown>, value: unknown): GmailWriteTargetVersionObservation {
  let observation: GmailWriteTargetVersionObservation;
  try { observation = GmailWriteTargetVersionObservationSchema.parse(value); }
  catch { throw new Error("gmail.write target version evidence is required; request_sent=false; mutation_sent=false"); }
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  if (observation.target_identity_digest !== gmailWriteTargetIdentityDigest(args) ||
      (operation === "draft.send"
        ? !observation.provider_state_digest || !observation.provider_raw_digest
          || observation.request_payload_digest !== gmailDraftSendRequestPayloadDigest(args, observation.provider_raw_digest)
        : observation.request_payload_digest !== gmailWriteRequestPayloadDigest(args))) {
    throw new Error("gmail.write target version changed; request_sent=false; mutation_sent=false");
  }
  return observation;
}

function gmailWriteRequest(args: Record<string, unknown>, draftRaw?: string): { path: string; body: string } {
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  if (operation === "draft.create") return { path: "/gmail/v1/users/me/drafts", body: jsonBody({ message: { raw: encodedMimeMessage(args) } }) };
  if (operation === "message.send") return { path: "/gmail/v1/users/me/messages/send", body: jsonBody({ raw: encodedMimeMessage(args) }) };
  if (!draftRaw) throw new Error("gmail.write draft.send requires a reviewed provider snapshot; mutation_sent=false");
  return { path: "/gmail/v1/users/me/drafts/send", body: jsonBody({
    id: stringArg(args, "draft_id")!, message: { raw: draftRaw },
  }) };
}

function calendarEventBody(args: Record<string, unknown>, requireTime: boolean): Record<string, unknown> {
  if (args.attendees !== undefined) {
    throw new Error("calendar attendees are deferred to avoid implicit external invites; mutation_sent=false");
  }
  const body: Record<string, unknown> = {};
  const summary = stringArg(args, "summary", false);
  const description = stringArg(args, "description", false);
  const location = stringArg(args, "location", false);
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;
  const start = stringArg(args, "start", requireTime);
  const end = stringArg(args, "end", requireTime);
  const timeZone = stringArg(args, "time_zone", false);
  if (start !== undefined) body.start = timeZone ? { dateTime: start, timeZone } : { dateTime: start };
  if (end !== undefined) body.end = timeZone ? { dateTime: end, timeZone } : { dateTime: end };
  return body;
}

export async function invokeGoogleCalendarWrite(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions = {},
): Promise<unknown> {
  const operation = operationArg(args, ["event.create", "event.update", "event.delete"]);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const calendarId = stringArg(args, "calendar_id", false) ?? "primary";
  const params = new URLSearchParams({ sendUpdates: "none" });

  let path: string;
  let method: GoogleWriteMethod;
  let body: string | undefined;
  const fallback: Record<string, unknown> = { calendar_id: calendarId };
  if (operation === "event.create") {
    const eventBody = calendarEventBody(args, true);
    if (Object.keys(eventBody).length === 0) {
      throw new Error("event.create requires event fields; mutation_sent=false");
    }
    path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    method = "POST";
    body = jsonBody(eventBody);
  } else {
    const eventId = stringArg(args, "event_id")!;
    fallback.id = eventId;
    path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`;
    if (operation === "event.update") {
      const eventBody = calendarEventBody(args, false);
      if (Object.keys(eventBody).length === 0) {
        throw new Error("event.update requires at least one mutable event field; mutation_sent=false");
      }
      method = "PATCH";
      body = jsonBody(eventBody);
    } else {
      method = "DELETE";
    }
  }

  const target = {
    service: "calendar" as const,
    hostname: "www.googleapis.com" as const,
    path,
    method,
    maxBytes,
    token,
    body,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.calendar.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.calendar.write", response);
  return mutationResult("google.calendar.write", "calendar", operation, target, response, fallback);
}

function boundedContent(args: Record<string, unknown>, maxContentBytes: number, required: boolean): string | undefined {
  const content = stringArg(args, "content", required);
  if (content === undefined) return undefined;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxContentBytes) {
    throw new Error(`content exceeds max_content_bytes (${maxContentBytes}); mutation_sent=false`);
  }
  return content;
}

function driveMetadata(args: Record<string, unknown>, requireName: boolean): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const name = stringArg(args, "name", requireName);
  const mimeType = stringArg(args, "mime_type", false);
  const parentId = stringArg(args, "parent_id", false);
  if (name !== undefined) metadata.name = name;
  if (mimeType !== undefined) metadata.mimeType = mimeType;
  if (parentId !== undefined) metadata.parents = [parentId];
  return metadata;
}

function multipartBody(metadata: Record<string, unknown>, content: string, mimeType: string): { body: string; contentType: string } {
  const boundary = `blue_tanuki_${sha256Hex({ metadata, content }).slice(0, 16)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

export async function invokeGoogleDriveWrite(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions = {},
): Promise<unknown> {
  const operation = operationArg(args, ["file.create", "file.update"]);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const maxContentBytes = positiveIntArg(args, "max_content_bytes", DEFAULT_MAX_CONTENT_BYTES, MAX_CONTENT_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const mimeType = stringArg(args, "mime_type", false) ?? "text/plain";

  let path: string;
  let method: GoogleWriteMethod;
  let body: string;
  let contentType = "application/json";
  if (operation === "file.create") {
    const metadata = driveMetadata(args, true);
    const content = boundedContent(args, maxContentBytes, true)!;
    const multipart = multipartBody(metadata, content, mimeType);
    path = `/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FIELDS)}`;
    method = "POST";
    body = multipart.body;
    contentType = multipart.contentType;
  } else {
    const fileId = stringArg(args, "file_id")!;
    const metadata = driveMetadata(args, false);
    const content = boundedContent(args, maxContentBytes, false);
    method = "PATCH";
    if (content !== undefined) {
      const multipart = multipartBody(metadata, content, mimeType);
      path = `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FIELDS)}`;
      body = multipart.body;
      contentType = multipart.contentType;
    } else {
      if (Object.keys(metadata).length === 0) {
        throw new Error("file.update requires name, mime_type, parent_id, or content; mutation_sent=false");
      }
      path = `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`;
      body = jsonBody(metadata);
    }
  }

  const target = {
    service: "drive" as const,
    hostname: "www.googleapis.com" as const,
    path,
    method,
    maxBytes,
    token,
    body,
    contentType,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.drive.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.drive.write", response);
  return mutationResult("google.drive.write", "drive", operation, target, response);
}

export function createGmailWriteTool(options: Omit<GoogleWriteOptions, "idempotency_key" | "command_digest"> = {}): Tool {
  return {
    name: "gmail.write",
    description: "Create Gmail drafts or send Gmail messages with an operator-provided OAuth token.",
    required_capabilities: requireToolOperationDescriptor("gmail.write").required_capabilities,
    async inspect_target_version(args, resolverOptions = {}): Promise<GmailWriteTargetVersionObservation> {
      return await inspectGmailWriteTargetVersion(args, {
        ...options,
        ...resolverOptions,
        env: resolverOptions.env ? { ...resolverOptions.env } : options.env,
      });
    },
    async inspect_content_review(args, reviewOptions = {}): Promise<GmailDraftContentReview> {
      const snapshot = await readGmailDraftSnapshot(args, {
        ...options,
        ...(reviewOptions.env ? { env: { ...reviewOptions.env } } : {}),
      });
      return snapshot.content_review;
    },
    async invoke(args, context): Promise<unknown> {
      if (typeof context.idempotency_key !== "string" || !/^[a-f0-9]{64}$/.test(context.idempotency_key) ||
          typeof context.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(context.command_digest)) {
        throw new Error("gmail.write requires an approved Executor identity; mutation_sent=false");
      }
      const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
      const observation = assertGmailWriteTargetVersion(args, context.target_version_observation);
      return await invokeGmailWrite(args, { ...options, idempotency_key: context.idempotency_key,
        command_digest: context.command_digest, signal: context.signal }, operation === "draft.send" ? observation : undefined);
    },
  };
}

export const gmailWriteTool: Tool = createGmailWriteTool();

export const googleCalendarWriteTool: Tool = {
  name: "google.calendar.write",
  description: "Create, update, or delete Google Calendar events with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.calendar.write").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeGoogleCalendarWrite(args, { signal: context.signal });
  },
};

export const googleDriveWriteTool: Tool = {
  name: "google.drive.write",
  description: "Create or update bounded Google Drive text files with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.drive.write").required_capabilities,
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    return await invokeGoogleDriveWrite(args, { signal: context.signal });
  },
};
