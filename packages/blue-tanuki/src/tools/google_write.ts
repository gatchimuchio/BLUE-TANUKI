import { createHash } from "node:crypto";
import * as https from "node:https";
import { GmailWriteTargetVersionObservationSchema, GoogleCalendarEventTargetObservationSchema,
  GoogleCalendarWriteTargetVersionObservationSchema,
  GoogleDriveWriteTargetVersionObservationSchema, GoogleDriveUpdateTargetVersionObservationSchema,
  GoogleDrivePermissionCreateTargetVersionObservationSchema, GoogleDriveTrashTargetVersionObservationSchema,
  googleDriveWriteRequestPayloadDigest, googleDriveWriteTargetIdentityDigest,
  googleDriveUpdateRequestPayloadDigest, googleDriveUpdateTargetIdentityDigest,
  googleDrivePermissionCreateRequestPayloadDigest, googleDrivePermissionCreateTargetIdentityDigest,
  googleDriveTrashRequestPayloadDigest, googleDriveTrashTargetIdentityDigest,
  normalizeGmailAddressList, requireToolOperationDescriptor,
  type GmailWriteTargetVersionObservation, type GoogleCalendarEventTargetObservation,
  type GoogleCalendarWriteTargetVersionObservation, type GoogleDriveWriteTargetVersionObservation,
  type GoogleDriveUpdateTargetVersionObservation, type GoogleDrivePermissionCreateTargetVersionObservation,
  type GoogleDriveTrashTargetVersionObservation } from "@blue-tanuki/protocol";
import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import { invokeGoogleCalendarRead, MAX_CALENDAR_EVENT_ATTENDEES, MAX_GMAIL_ATTACHMENT_BYTES,
  readGmailAttachmentContent, readGoogleCalendarEventTarget,
  type GoogleCalendarEventTargetSnapshot } from "./google_read.js";
import { assertToolExecutionNotCancelled, type GmailAttachmentContentReview, type GmailDraftContentReview,
  type GmailWriteContentReview, type GoogleCalendarEventCreateContentReview,
  type GoogleCalendarEventUpdateContentReview, type GoogleCalendarEventDeleteContentReview,
  type GoogleCalendarEventInviteContentReview, type GoogleDriveFileCreateContentReview,
  type GoogleDriveFileUpdateContentReview, type GoogleDrivePermissionCreateContentReview,
  type GoogleDriveFileTrashContentReview, type GoogleDrivePermissionReview,
  type Tool, type ToolContentReview, type ToolContext } from "./registry.js";

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
  if_match?: string;
  /** Digest-only identity from an approved Executor ticket; not an authority token. */
  idempotency_key?: string;
  command_digest?: string;
}

export interface GoogleWriteResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  body_utf8_valid?: boolean;
  truncated: boolean;
  request_id: string | null;
}

export interface GoogleWriteOptions {
  env?: Env;
  signal?: AbortSignal;
  request?: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  idempotency_key?: string;
  command_digest?: string;
  calendar_availability_observation_digest?: string;
  calendar_availability_result_digest?: string;
  calendar_availability_observed_at?: string;
  target_version_observation?: GoogleDriveWriteTargetVersionObservation | GoogleDriveUpdateTargetVersionObservation |
    GoogleDrivePermissionCreateTargetVersionObservation | GoogleDriveTrashTargetVersionObservation;
}

interface CalendarAvailabilityObservation {
  calendar_id: string;
  calendar_id_original: string;
  time_min: string;
  time_max: string;
  time_zone: string;
  observed_at: string;
  availability_status: "observed";
  busy: readonly { start: string; end: string }[];
  result_digest: string;
  observation_digest: string;
}

interface CalendarEventCreatePlan {
  calendar_id: string;
  event_body: Record<string, unknown>;
  event_start: string;
  event_end: string;
  event_start_ms: number;
  event_end_ms: number;
  attendee_emails: readonly string[];
  source_observation: CalendarAvailabilityObservation;
  request_payload_digest: string;
  target_identity_digest: string;
}

interface CalendarEventUpdatePlan {
  operation: "event.update";
  target_scope: GoogleCalendarEventTargetObservation["recurrence_scope"];
  calendar_id: string;
  event_id: string;
  summary: string;
  source_event: GoogleCalendarEventTargetObservation;
  request_payload_digest: string;
  target_identity_digest: string;
}

interface CalendarEventDeletePlan {
  operation: "event.delete";
  target_scope: GoogleCalendarEventTargetObservation["recurrence_scope"];
  calendar_id: string;
  event_id: string;
  max_bytes: number;
  source_event: GoogleCalendarEventTargetObservation;
  request_payload_digest: string;
  target_identity_digest: string;
}

interface CalendarEventInvitePlan {
  operation: "event.invite";
  target_scope: GoogleCalendarEventTargetObservation["recurrence_scope"];
  calendar_id: string;
  event_id: string;
  attendee_emails: readonly string[];
  max_bytes: number;
  source_event: GoogleCalendarEventTargetObservation;
  request_payload_digest: string;
  target_identity_digest: string;
}

type CalendarEventMutationPlan = CalendarEventUpdatePlan | CalendarEventDeletePlan | CalendarEventInvitePlan;

const GOOGLE_WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 128_000;
const MAX_MAX_BYTES = 512_000;
const DEFAULT_MAX_CONTENT_BYTES = 64_000;
const MAX_CONTENT_BYTES = 512_000;
const MAX_GMAIL_WRITE_ATTACHMENTS = 5;
const MAX_GMAIL_WRITE_ATTACHMENTS_TOTAL_BYTES = 8 * 1024 * 1024;
const GMAIL_WRITE_ATTACHMENT_RESPONSE_MAX_BYTES = Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES * 4 / 3) + 64_000;
const DRIVE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,parents,driveId,version,headRevisionId,shared,trashed";

interface GmailWriteAttachmentReference {
  message_id: string;
  attachment_id: string;
  part_id: string;
  part_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_sha256: string;
}

interface GmailResolvedWriteAttachment extends GmailWriteAttachmentReference {
  bytes: Buffer;
}

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
    if (target.if_match) headers["If-Match"] = target.if_match;
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
            const bytes = Buffer.concat(chunks);
            let bodyUtf8Valid = true;
            try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
            catch { bodyUtf8Valid = false; }
            finish({
              status,
              ok: status >= 200 && status < 300,
              content_type: contentType,
              body: bytes.toString("utf8"),
              body_utf8_valid: bodyUtf8Valid,
              truncated,
              request_id: requestId,
            });
          }
        });
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          let bodyUtf8Valid = true;
          try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { bodyUtf8Valid = false; }
          finish({
            status,
            ok: status >= 200 && status < 300,
            content_type: contentType,
            body: bytes.toString("utf8"),
            body_utf8_valid: bodyUtf8Valid,
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

function gmailWriteAttachmentReferences(args: Record<string, unknown>): GmailWriteAttachmentReference[] {
  if (args.attachments === undefined) return [];
  if (!Array.isArray(args.attachments) || args.attachments.length > MAX_GMAIL_WRITE_ATTACHMENTS) {
    throw new Error("gmail.write attachments must contain at most five exact source references; mutation_sent=false");
  }
  const allowed = new Set(["message_id", "attachment_id", "part_id", "part_path", "filename", "mime_type", "size_bytes", "content_sha256"]);
  const seen = new Set<string>();
  let totalBytes = 0;
  const references: GmailWriteAttachmentReference[] = [];
  for (const raw of args.attachments) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new Error("gmail.write attachment source reference is invalid; mutation_sent=false");
    }
    const messageId = stringArg(raw, "message_id")!;
    const attachmentId = stringArg(raw, "attachment_id")!;
    const partId = stringArg(raw, "part_id")!;
    const partPath = stringArg(raw, "part_path")!;
    const filename = stringArg(raw, "filename")!;
    const mimeType = stringArg(raw, "mime_type")!;
    const sizeBytes = raw.size_bytes;
    const contentSha256 = stringArg(raw, "content_sha256")!;
    const safeOpaqueId = (value: string): boolean => value.length <= 512 && value === value.trim() &&
      !/[\s/?#\\\u0000-\u001f\u007f]/.test(value);
    if (!safeOpaqueId(messageId) || !safeOpaqueId(attachmentId) || !safeOpaqueId(partId) || !/^0(?:\.\d+)*$/.test(partPath) ||
        filename.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(filename) ||
        mimeType.length > 200 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType) ||
        typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
        sizeBytes > MAX_GMAIL_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new Error("gmail.write attachment source identity or content digest is invalid; mutation_sent=false");
    }
    const identityKey = `${messageId}\u0000${attachmentId}`;
    if (seen.has(identityKey)) throw new Error("gmail.write duplicate attachment source is not allowed; mutation_sent=false");
    seen.add(identityKey);
    totalBytes += sizeBytes;
    if (totalBytes > MAX_GMAIL_WRITE_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error("gmail.write attachments exceed the total size bound; mutation_sent=false");
    }
    references.push({ message_id: messageId, attachment_id: attachmentId, part_id: partId, part_path: partPath,
      filename, mime_type: mimeType, size_bytes: sizeBytes, content_sha256: contentSha256 });
  }
  return references;
}

async function resolveGmailWriteAttachments(
  args: Record<string, unknown>,
  options: Pick<GoogleWriteOptions, "env" | "signal" | "request"> = {},
  tokenOverride?: string,
): Promise<GmailResolvedWriteAttachment[]> {
  const references = gmailWriteAttachmentReferences(args);
  if (references.length === 0) return [];
  const token = tokenOverride ?? googleToken(options.env ?? process.env,
    ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.write attachment review");
  const request = options.request ?? defaultGoogleWriteRequest;
  const resolved: GmailResolvedWriteAttachment[] = [];
  for (const reference of references) {
    assertToolExecutionNotCancelled(options.signal, "gmail.write attachment review");
    const content = await readGmailAttachmentContent(reference, {
      env: options.env,
      signal: options.signal,
      token,
      request: async (target, signal) => {
        const response = await request({ service: "gmail", hostname: "gmail.googleapis.com", path: target.path,
          method: "GET", maxBytes: GMAIL_WRITE_ATTACHMENT_RESPONSE_MAX_BYTES, token }, signal);
        if (response.body_utf8_valid === false) {
          throw new Error("gmail attachment response encoding is invalid; content_read=false");
        }
        return { ...response, body_bytes: Buffer.from(response.body, "utf8") };
      },
    });
    if (content.content_sha256 !== reference.content_sha256 || content.identity.part_path !== reference.part_path ||
        content.identity.filename !== reference.filename || content.identity.mime_type !== reference.mime_type ||
        content.identity.size_bytes !== reference.size_bytes || content.identity.part_id !== reference.part_id) {
      throw new Error("gmail.write attachment content changed after identity resolution; mutation_sent=false");
    }
    resolved.push({ ...reference, bytes: Buffer.from(content.bytes) });
  }
  return resolved;
}

function assertSupportedGmailWriteArguments(args: Record<string, unknown>): string {
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  const supported = operation === "draft.send"
    ? new Set(["operation", "draft_id", "max_bytes"])
    : new Set(["operation", "to", "cc", "bcc", "reply_to", "from", "subject", "body_text", "body", "attachments", "max_bytes"]);
  const unsupported = Object.keys(args).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    const attachmentArgument = unsupported.some((key) => /attachment|file/i.test(key));
    throw new Error(attachmentArgument
      ? "gmail.write attachment arguments are unsupported; request_sent=false; mutation_sent=false"
      : "gmail.write arguments are unsupported; request_sent=false; mutation_sent=false");
  }
  if (operation !== "draft.send" && args.body !== undefined && args.body_text !== undefined) {
    throw new Error("gmail.write body and body_text are ambiguous; request_sent=false; mutation_sent=false");
  }
  if (operation !== "draft.create" && args.attachments !== undefined) {
    throw new Error("gmail.write attachments are supported only for draft.create; request_sent=false; mutation_sent=false");
  }
  if (operation !== "draft.send") gmailWriteAttachmentReferences(args);
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

function base64MimeLines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function encodedMimeFilename(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[\\";\r\n]/g, "_").slice(0, 120) || "attachment";
  const extended = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function encodedMimeMessage(args: Record<string, unknown>, attachments: readonly GmailResolvedWriteAttachment[] = []): string {
  const to = safeAddressList(args, "to", true)!;
  const subject = encodedSubject(stringArg(args, "subject")!);
  const bodyText = stringArg(args, "body_text", false) ?? stringArg(args, "body", false) ?? "";
  if (Buffer.byteLength(bodyText, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("gmail.write body exceeds the content bound; mutation_sent=false");
  }
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];
  const cc = safeAddressList(args, "cc");
  if (cc) headers.splice(1, 0, `Cc: ${safeHeaderValue(cc, "cc")}`);
  const bcc = safeAddressList(args, "bcc");
  if (bcc) headers.splice(cc ? 2 : 1, 0, `Bcc: ${safeHeaderValue(bcc, "bcc")}`);
  const from = stringArg(args, "from", false);
  if (from) headers.unshift(`From: ${safeHeaderValue(from, "from")}`);
  const replyTo = safeAddressList(args, "reply_to");
  if (replyTo) headers.splice(headers.indexOf(`Subject: ${subject}`), 0, `Reply-To: ${replyTo}`);
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit");
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${bodyText}`, "utf8").toString("base64url");
  }
  const boundary = `=_blue_tanuki_${gmailWriteRequestPayloadDigest(args).slice(0, 40)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64MimeLines(Buffer.from(bodyText, "utf8"))}`,
    ...attachments.map((attachment) =>
      `--${boundary}\r\nContent-Type: ${attachment.mime_type}\r\nContent-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; ${encodedMimeFilename(attachment.filename)}\r\n\r\n${base64MimeLines(attachment.bytes)}`),
  ];
  parts.push(`--${boundary}--`);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8").toString("base64url");
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
  const operation = assertSupportedGmailWriteArguments(args);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.write");
  const sendRequest = opts.request ?? defaultGoogleWriteRequest;
  const attachments = operation === "draft.send" ? [] : await resolveGmailWriteAttachments(args, { ...opts, env }, token);

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
  const builtRequest = gmailWriteRequest(args, draftSnapshot?.raw, attachments);
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

/** Gmailのdraft.create / message.send intentを、本文と添付source digestまで含めて結ぶ。 */
export function gmailWriteRequestPayloadDigest(args: Record<string, unknown>): string {
  const operation = assertSupportedGmailWriteArguments(args);
  if (operation === "draft.send") throw new Error("gmail_target_version_operation_unsupported");
  const subject = encodedSubject(stringArg(args, "subject")!);
  const bodyText = stringArg(args, "body_text", false) ?? stringArg(args, "body", false) ?? "";
  if (Buffer.byteLength(bodyText, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("gmail.write body exceeds the content bound; mutation_sent=false");
  }
  const from = stringArg(args, "from", false);
  return operationPlanDigest({
    schema_version: "blue-tanuki.gmail-write-intent.v2",
    operation,
    to: safeAddressList(args, "to", true),
    cc: safeAddressList(args, "cc") ?? null,
    bcc: safeAddressList(args, "bcc") ?? null,
    reply_to: safeAddressList(args, "reply_to") ?? null,
    from: from ? safeHeaderValue(from, "from") : null,
    subject,
    body_text: bodyText,
    attachments: gmailWriteAttachmentReferences(args),
  });
}

/** draft.sendの正確なrequest intentをdraft IDとprovider MIME digestで束ねる。MIME本文は保持しない。 */
export function gmailDraftSendRequestPayloadDigest(args: Record<string, unknown>, rawDigest: string): string {
  if (assertSupportedGmailWriteArguments(args) !== "draft.send" || !/^[a-f0-9]{64}$/.test(rawDigest)) {
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
  const operation = assertSupportedGmailWriteArguments(args);
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

function gmailWriteRequest(
  args: Record<string, unknown>,
  draftRaw?: string,
  attachments: readonly GmailResolvedWriteAttachment[] = [],
): { path: string; body: string } {
  const operation = assertSupportedGmailWriteArguments(args);
  if (operation === "draft.create") return { path: "/gmail/v1/users/me/drafts", body: jsonBody({ message: { raw: encodedMimeMessage(args, attachments) } }) };
  if (operation === "message.send") return { path: "/gmail/v1/users/me/messages/send", body: jsonBody({ raw: encodedMimeMessage(args, attachments) }) };
  if (!draftRaw) throw new Error("gmail.write draft.send requires a reviewed provider snapshot; mutation_sent=false");
  return { path: "/gmail/v1/users/me/drafts/send", body: jsonBody({
    id: stringArg(args, "draft_id")!, message: { raw: draftRaw },
  }) };
}

const CALENDAR_EVENT_CREATE_ARGUMENTS = new Set([
  "operation", "calendar_id", "summary", "description", "location", "start", "end", "time_zone",
  "attendees", "availability_observation", "max_bytes",
]);

function parseCalendarAvailabilityObservation(value: unknown): CalendarAvailabilityObservation {
  if (!isRecord(value) || value.service !== "calendar" || value.view !== "freebusy" || value.mode !== "read_only" ||
      typeof value.calendar_id !== "string" || !value.calendar_id.trim() || value.calendar_id.length > 512 ||
      typeof value.calendar_id_original !== "string" || !value.calendar_id_original.trim() ||
      typeof value.time_min !== "string" || typeof value.time_max !== "string" ||
      typeof value.time_zone !== "string" || !value.time_zone ||
      typeof value.observed_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.observed_at) ||
      !Number.isFinite(Date.parse(value.observed_at)) ||
      Date.parse(value.observed_at) > Date.now() || value.observed_at_source !== "client_response_received" ||
      value.availability_status !== "observed" || value.result_complete !== true || value.has_more_results !== false ||
      value.provider_error_count !== 0 || value.truncated !== false || value.mutation_sent !== false ||
      !Array.isArray(value.busy) || value.busy.length > 1_000 ||
      typeof value.result_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.result_digest) ||
      typeof value.observation_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.observation_digest) ||
      !isRecord(value.trust_boundary) || value.trust_boundary.provider_data_is_untrusted !== true ||
      value.trust_boundary.availability_can_authorize_operation !== false ||
      value.trust_boundary.used_for_authority !== false) {
    throw new Error("google.calendar.write requires a complete, observed freebusy result; mutation_sent=false");
  }
  const windowStart = Date.parse(value.time_min);
  const windowEnd = Date.parse(value.time_max);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw new Error("google.calendar.write freebusy window is invalid; mutation_sent=false");
  }
  const busy: { start: string; end: string }[] = [];
  for (const interval of value.busy) {
    if (!isRecord(interval) || !isRecord(interval.start) || !isRecord(interval.end) ||
        !isRecord(interval.start.normalized) || !isRecord(interval.end.normalized) ||
        interval.start.complete !== true || interval.end.complete !== true ||
        typeof interval.start.normalized.instant_utc !== "string" ||
        typeof interval.end.normalized.instant_utc !== "string") {
      throw new Error("google.calendar.write freebusy intervals are incomplete; mutation_sent=false");
    }
    const startMs = Date.parse(interval.start.normalized.instant_utc);
    const endMs = Date.parse(interval.end.normalized.instant_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
        startMs < windowStart || endMs > windowEnd) {
      throw new Error("google.calendar.write freebusy interval is outside the observed window; mutation_sent=false");
    }
    busy.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
  }
  const expectedResultDigest = sha256Hex({
    calendar_id: value.calendar_id,
    calendar_id_original: value.calendar_id_original,
    time_min: value.time_min,
    time_max: value.time_max,
    time_zone: value.time_zone || "UTC",
    availability_status: value.availability_status,
    busy: value.busy,
    provider_error_count: value.provider_error_count,
    result_complete: value.result_complete,
    has_more_results: value.has_more_results,
  });
  const expectedObservationDigest = sha256Hex({ result_digest: value.result_digest, observed_at: value.observed_at });
  if (expectedResultDigest !== value.result_digest || expectedObservationDigest !== value.observation_digest) {
    throw new Error("google.calendar.write freebusy digest is inconsistent; mutation_sent=false");
  }
  return {
    calendar_id: value.calendar_id.trim(),
    calendar_id_original: value.calendar_id_original,
    time_min: value.time_min,
    time_max: value.time_max,
    time_zone: value.time_zone,
    observed_at: value.observed_at,
    availability_status: "observed",
    busy,
    result_digest: value.result_digest,
    observation_digest: value.observation_digest,
  };
}

function calendarAttendeeEmailsArg(args: Record<string, unknown>, operation: string): string[] {
  const value = args.attendees;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some((entry) => typeof entry !== "string" || entry.trim() !== entry || entry.length === 0)) {
    throw new Error(`${operation} attendees must be a non-empty array of at most 20 plain email addresses; mutation_sent=false`);
  }
  const normalized = normalizeGmailAddressList(value.join(", "));
  if (!normalized) throw new Error(`${operation} contains an invalid attendee address; mutation_sent=false`);
  const emails = normalized.split(", ");
  if (new Set(emails.map((email) => email.toLowerCase())).size !== emails.length) {
    throw new Error(`${operation} attendee addresses must be unique; mutation_sent=false`);
  }
  return emails;
}

function calendarEventBody(
  args: Record<string, unknown>,
  requireTime: boolean,
  attendeeEmails: readonly string[] = [],
): Record<string, unknown> {
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
  if (attendeeEmails.length > 0) body.attendees = attendeeEmails.map((email) => ({ email }));
  return body;
}

function calendarEventCreatePlan(args: Record<string, unknown>): CalendarEventCreatePlan {
  if (Object.keys(args).some((key) => !CALENDAR_EVENT_CREATE_ARGUMENTS.has(key))) {
    throw new Error("google.calendar.write received an unsupported event.create argument; mutation_sent=false");
  }
  const attendeeEmails = calendarAttendeeEmailsArg(args, "event.create");
  for (const name of ["calendar_id", "summary", "description", "location", "time_zone"] as const) {
    const value = args[name];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`google.calendar.write ${name} must be a non-empty string when supplied; mutation_sent=false`);
    }
  }
  operationArg(args, ["event.create"]);
  const calendarId = stringArg(args, "calendar_id", false) ?? "primary";
  if (calendarId.length > 512 || /[\r\n]/.test(calendarId)) {
    throw new Error("calendar_id is invalid; mutation_sent=false");
  }
  const start = stringArg(args, "start")!;
  const end = stringArg(args, "end")!;
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!rfc3339.test(start) || !rfc3339.test(end)) {
    throw new Error("event.create start/end must be RFC3339 date-times with an explicit offset; mutation_sent=false");
  }
  const eventStartMs = Date.parse(start);
  const eventEndMs = Date.parse(end);
  if (!Number.isFinite(eventStartMs) || !Number.isFinite(eventEndMs) || eventEndMs <= eventStartMs) {
    throw new Error("event.create time window is invalid; mutation_sent=false");
  }
  const timeZone = stringArg(args, "time_zone", false);
  if (timeZone) {
    try { new Intl.DateTimeFormat("en", { timeZone }); }
    catch { throw new Error("event.create time_zone must be a valid IANA time zone; mutation_sent=false"); }
  }
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const body = calendarEventBody(args, true, attendeeEmails);
  const sourceObservation = parseCalendarAvailabilityObservation(args.availability_observation);
  const windowStart = Date.parse(sourceObservation.time_min);
  const windowEnd = Date.parse(sourceObservation.time_max);
  if (sourceObservation.calendar_id !== calendarId || eventStartMs < windowStart || eventEndMs > windowEnd) {
    throw new Error("event.create does not match the supplied freebusy calendar or time window; mutation_sent=false");
  }
  const targetIdentityDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-create-target.v1",
    calendar_id: calendarId,
    start,
    end,
  });
  // Reusing this payload-bound provider ID prevents retry duplicates without conflating
  // distinct events that happen to share a calendar and time window.
  body.id = sha256Hex({ schema_version: "blue-tanuki.google-calendar-event-create-id.v1",
    calendar_id: calendarId, event: body });
  if (Buffer.byteLength(jsonBody(body), "utf8") > maxBytes) {
    throw new Error("event.create payload exceeds max_bytes; mutation_sent=false");
  }
  const requestPayloadDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-create-payload.v1",
    calendar_id: calendarId,
    event: body,
  });
  return {
    calendar_id: calendarId,
    event_body: body,
    event_start: start,
    event_end: end,
    event_start_ms: eventStartMs,
    event_end_ms: eventEndMs,
    attendee_emails: attendeeEmails,
    source_observation: sourceObservation,
    request_payload_digest: requestPayloadDigest,
    target_identity_digest: targetIdentityDigest,
  };
}

const CALENDAR_EVENT_UPDATE_ARGUMENTS = new Set([
  "operation", "target_scope", "calendar_id", "event_id", "summary", "event_observation", "max_bytes",
]);

const CALENDAR_EVENT_DELETE_ARGUMENTS = new Set([
  "operation", "target_scope", "calendar_id", "event_id", "event_observation", "max_bytes",
]);

const CALENDAR_EVENT_INVITE_ARGUMENTS = new Set([
  "operation", "target_scope", "calendar_id", "event_id", "attendees", "event_observation", "max_bytes",
]);

function calendarEventTargetScope(
  args: Record<string, unknown>,
  sourceEvent: GoogleCalendarEventTargetObservation,
  operation: "event.update" | "event.delete" | "event.invite",
): GoogleCalendarEventTargetObservation["recurrence_scope"] {
  const targetScope = args.target_scope;
  if (targetScope === undefined && sourceEvent.recurrence_scope === "single_event") return "single_event";
  if (targetScope !== sourceEvent.recurrence_scope) {
    throw new Error(`${operation} target_scope must explicitly match the observed single event, recurring series, or occurrence; mutation_sent=false`);
  }
  return sourceEvent.recurrence_scope;
}

function assertSafeCalendarEventMutationTarget(
  sourceEvent: GoogleCalendarEventTargetObservation,
  operation: "event.update" | "event.delete" | "event.invite",
  targetScope: GoogleCalendarEventTargetObservation["recurrence_scope"],
): void {
  const observedAt = Date.parse(sourceEvent.observed_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(sourceEvent.observed_at) ||
      sourceEvent.calendar_id !== "primary" || sourceEvent.calendar_id_original !== "primary" ||
      sourceEvent.status !== "confirmed" || sourceEvent.recurrence_scope !== targetScope ||
      sourceEvent.organizer_self !== true || sourceEvent.attendee_inventory_complete !== true ||
      (operation !== "event.invite" && sourceEvent.other_attendee_count !== 0) ||
      !Number.isFinite(observedAt) || observedAt > Date.now()) {
    throw new Error(`${operation} requires a current, confirmed primary-calendar target with an exact recurrence scope and owner status; mutation_sent=false`);
  }
}

function calendarEventUpdatePlan(args: Record<string, unknown>): CalendarEventUpdatePlan {
  if (Object.keys(args).some((key) => !CALENDAR_EVENT_UPDATE_ARGUMENTS.has(key))) {
    throw new Error("google.calendar.write received an unsupported event.update argument; mutation_sent=false");
  }
  operationArg(args, ["event.update"]);
  const eventId = stringArg(args, "event_id")!;
  const summary = stringArg(args, "summary")!;
  if (eventId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(eventId) || summary.length > 8_192) {
    throw new Error("event.update identity or summary exceeds its limit; mutation_sent=false");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const sourceEvent = GoogleCalendarEventTargetObservationSchema.parse(args.event_observation);
  const targetScope = calendarEventTargetScope(args, sourceEvent, "event.update");
  assertSafeCalendarEventMutationTarget(sourceEvent, "event.update", targetScope);
  if (args.calendar_id !== undefined && (typeof args.calendar_id !== "string" || !args.calendar_id.trim())) {
    throw new Error("event.update calendar_id must be a non-empty string when supplied; mutation_sent=false");
  }
  const calendarId = stringArg(args, "calendar_id", false) ?? sourceEvent.calendar_id;
  if (calendarId !== sourceEvent.calendar_id || eventId !== sourceEvent.event_id) {
    throw new Error("event.update target does not match its observed calendar event; mutation_sent=false");
  }
  if (summary === sourceEvent.summary) {
    throw new Error("event.update summary is unchanged; mutation_sent=false");
  }
  if (Buffer.byteLength(jsonBody({ summary }), "utf8") > maxBytes) {
    throw new Error("event.update payload exceeds max_bytes; mutation_sent=false");
  }
  const targetIdentityDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-update-target.v3",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
    event_etag_digest: sourceEvent.event_etag_digest,
  });
  const requestPayloadDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-update-payload.v3",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
    patch: { summary },
  });
  return {
    operation: "event.update",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    summary,
    source_event: sourceEvent,
    request_payload_digest: requestPayloadDigest,
    target_identity_digest: targetIdentityDigest,
  };
}

function calendarEventDeletePlan(args: Record<string, unknown>): CalendarEventDeletePlan {
  if (Object.keys(args).some((key) => !CALENDAR_EVENT_DELETE_ARGUMENTS.has(key))) {
    throw new Error("google.calendar.write received an unsupported event.delete argument; mutation_sent=false");
  }
  operationArg(args, ["event.delete"]);
  const eventId = stringArg(args, "event_id")!;
  if (eventId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(eventId)) {
    throw new Error("event.delete identity exceeds its limit; mutation_sent=false");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const sourceEvent = GoogleCalendarEventTargetObservationSchema.parse(args.event_observation);
  const targetScope = calendarEventTargetScope(args, sourceEvent, "event.delete");
  assertSafeCalendarEventMutationTarget(sourceEvent, "event.delete", targetScope);
  if (args.calendar_id !== undefined && (typeof args.calendar_id !== "string" || !args.calendar_id.trim())) {
    throw new Error("event.delete calendar_id must be a non-empty string when supplied; mutation_sent=false");
  }
  const calendarId = stringArg(args, "calendar_id", false) ?? sourceEvent.calendar_id;
  if (calendarId !== sourceEvent.calendar_id || eventId !== sourceEvent.event_id) {
    throw new Error("event.delete target does not match its observed calendar event; mutation_sent=false");
  }
  const targetIdentityDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-delete-target.v2",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
    event_etag_digest: sourceEvent.event_etag_digest,
  });
  const requestPayloadDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-delete-payload.v2",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
  });
  return {
    operation: "event.delete",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    max_bytes: maxBytes,
    source_event: sourceEvent,
    request_payload_digest: requestPayloadDigest,
    target_identity_digest: targetIdentityDigest,
  };
}

function calendarEventInvitePlan(args: Record<string, unknown>): CalendarEventInvitePlan {
  if (Object.keys(args).some((key) => !CALENDAR_EVENT_INVITE_ARGUMENTS.has(key))) {
    throw new Error("google.calendar.write received an unsupported event.invite argument; mutation_sent=false");
  }
  operationArg(args, ["event.invite"]);
  const eventId = stringArg(args, "event_id")!;
  if (eventId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(eventId)) {
    throw new Error("event.invite identity exceeds its limit; mutation_sent=false");
  }
  const attendeeEmails = calendarAttendeeEmailsArg(args, "event.invite");
  if (attendeeEmails.length === 0) throw new Error("event.invite requires at least one explicit attendee; mutation_sent=false");
  if (args.target_scope === undefined) throw new Error("event.invite requires an explicit recurrence target_scope; mutation_sent=false");
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const sourceEvent = GoogleCalendarEventTargetObservationSchema.parse(args.event_observation);
  const targetScope = calendarEventTargetScope(args, sourceEvent, "event.invite");
  assertSafeCalendarEventMutationTarget(sourceEvent, "event.invite", targetScope);
  if (args.calendar_id !== undefined && (typeof args.calendar_id !== "string" || !args.calendar_id.trim())) {
    throw new Error("event.invite calendar_id must be a non-empty string when supplied; mutation_sent=false");
  }
  const calendarId = stringArg(args, "calendar_id", false) ?? sourceEvent.calendar_id;
  if (calendarId !== sourceEvent.calendar_id || eventId !== sourceEvent.event_id) {
    throw new Error("event.invite target does not match its observed calendar event; mutation_sent=false");
  }
  const patch = { attendees: attendeeEmails.map((email) => ({ email })) };
  if (Buffer.byteLength(jsonBody(patch), "utf8") > maxBytes) {
    throw new Error("event.invite payload exceeds max_bytes; mutation_sent=false");
  }
  const targetIdentityDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-invite-target.v1",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
    event_etag_digest: sourceEvent.event_etag_digest,
  });
  const requestPayloadDigest = sha256Hex({
    schema_version: "blue-tanuki.google-calendar-event-invite-payload.v1",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    event_state_digest: sourceEvent.event_state_digest,
    invitees: attendeeEmails,
    notification_effect: "send_calendar_update_notifications_to_all_attendees",
  });
  return {
    operation: "event.invite",
    target_scope: targetScope,
    calendar_id: calendarId,
    event_id: eventId,
    attendee_emails: attendeeEmails,
    max_bytes: maxBytes,
    source_event: sourceEvent,
    request_payload_digest: requestPayloadDigest,
    target_identity_digest: targetIdentityDigest,
  };
}

export function googleCalendarWriteRequestPayloadDigest(args: Record<string, unknown>): string {
  return args.operation === "event.update"
    ? calendarEventUpdatePlan(args).request_payload_digest
    : args.operation === "event.delete"
      ? calendarEventDeletePlan(args).request_payload_digest
      : args.operation === "event.invite"
        ? calendarEventInvitePlan(args).request_payload_digest
    : calendarEventCreatePlan(args).request_payload_digest;
}

/** Stable client-generated Google event ID for the exact calendar/time target. */
export function googleCalendarCreateEventId(args: Record<string, unknown>): string {
  if (args.operation !== "event.create") throw new Error("google_calendar_event_create_id_operation_unsupported");
  const id = calendarEventCreatePlan(args).event_body.id;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("google_calendar_event_create_id_invalid");
  return id;
}

export function googleCalendarWriteTargetIdentityDigest(args: Record<string, unknown>): string {
  return args.operation === "event.update"
    ? calendarEventUpdatePlan(args).target_identity_digest
    : args.operation === "event.delete"
      ? calendarEventDeletePlan(args).target_identity_digest
      : args.operation === "event.invite"
        ? calendarEventInvitePlan(args).target_identity_digest
    : calendarEventCreatePlan(args).target_identity_digest;
}

export function assertGoogleCalendarWriteTargetVersion(
  args: Record<string, unknown>,
  raw: unknown,
  commandDigest: string,
  operationPlanBindingDigest?: string,
): GoogleCalendarWriteTargetVersionObservation {
  const observation = GoogleCalendarWriteTargetVersionObservationSchema.parse(raw);
  if (!/^[a-f0-9]{64}$/.test(commandDigest) || observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.used_for_authority !== false || observation.may_execute !== false) {
    throw new Error("google.calendar.write target version does not match the command or current source; mutation_sent=false");
  }
  if ((args.operation === "event.update" && observation.operation === "event.update") ||
      (args.operation === "event.delete" && observation.operation === "event.delete") ||
      (args.operation === "event.invite" && observation.operation === "event.invite")) {
    const plan = args.operation === "event.update" ? calendarEventUpdatePlan(args)
      : args.operation === "event.delete" ? calendarEventDeletePlan(args) : calendarEventInvitePlan(args);
    if (observation.target_identity_digest !== plan.target_identity_digest ||
        observation.request_payload_digest !== plan.request_payload_digest ||
        observation.calendar_id !== plan.calendar_id || observation.event_id !== plan.event_id ||
        observation.target_scope !== plan.target_scope ||
        observation.event_state_digest !== plan.source_event.event_state_digest ||
        observation.event_etag_digest !== plan.source_event.event_etag_digest) {
      throw new Error("google.calendar.write target version does not match the current event; mutation_sent=false");
    }
    return observation;
  }
  if (args.operation !== "event.create" || observation.operation !== "event.create") {
    throw new Error("google.calendar.write target version operation does not match the command; mutation_sent=false");
  }
  const plan = calendarEventCreatePlan(args);
  if (observation.target_identity_digest !== plan.target_identity_digest ||
      observation.request_payload_digest !== plan.request_payload_digest ||
      observation.availability_observation_digest !== plan.source_observation.observation_digest ||
      observation.availability_result_digest !== plan.source_observation.result_digest ||
      observation.availability_window_start !== plan.source_observation.time_min ||
      observation.availability_window_end !== plan.source_observation.time_max ||
      observation.event_start !== plan.event_start || observation.event_end !== plan.event_end) {
    throw new Error("google.calendar.write target version does not match the command or current source; mutation_sent=false");
  }
  return observation;
}

async function recheckCalendarAvailability(
  args: Record<string, unknown>,
  plan: CalendarEventCreatePlan,
  options: GoogleWriteOptions,
): Promise<CalendarAvailabilityObservation> {
  const source = plan.source_observation;
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const read = await invokeGoogleCalendarRead({
    view: "freebusy",
    calendar_id: source.calendar_id_original,
    time_min: source.time_min,
    time_max: source.time_max,
    time_zone: source.time_zone,
    max_bytes: maxBytes,
  }, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.request ? { request: (target, signal) => options.request!({
      service: target.service,
      hostname: target.hostname,
      path: target.path,
      method: target.method ?? "GET",
      maxBytes: target.maxBytes,
      token: target.token,
      ...(target.body === undefined ? {} : { body: target.body }),
    }, signal) } : {}),
  });
  const current = parseCalendarAvailabilityObservation(read);
  if (current.calendar_id !== source.calendar_id || current.time_min !== source.time_min ||
      current.time_max !== source.time_max || current.result_digest !== source.result_digest) {
    throw new Error("google.calendar.write freebusy observation changed; refresh availability and review again; mutation_sent=false");
  }
  return current;
}

async function recheckCalendarEventTarget(
  plan: CalendarEventMutationPlan,
  options: GoogleWriteOptions,
): Promise<Awaited<ReturnType<typeof readGoogleCalendarEventTarget>>> {
  const current = await readGoogleCalendarEventTarget(plan.calendar_id, plan.event_id, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.request ? { request: (target, signal) => options.request!({
      service: target.service,
      hostname: target.hostname,
      path: target.path,
      method: target.method ?? "GET",
      maxBytes: target.maxBytes,
      token: target.token,
      ...(target.body === undefined ? {} : { body: target.body }),
    }, signal) } : {}),
  });
  assertSafeCalendarEventMutationTarget(current.observation, plan.operation, plan.target_scope);
  if (current.observation.status !== "confirmed" || current.observation.recurrence_scope !== plan.target_scope ||
      current.observation.event_state_digest !== plan.source_event.event_state_digest ||
      current.observation.event_etag_digest !== plan.source_event.event_etag_digest) {
    throw new Error("google.calendar.write event or recurrence scope changed, or is no longer confirmed; mutation_sent=false");
  }
  return current;
}

function calendarUpdateContentReview(
  plan: CalendarEventUpdatePlan,
  current: GoogleCalendarEventTargetObservation,
  commandDigest: string,
): GoogleCalendarEventUpdateContentReview {
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.google-calendar-event-update-review.v2",
    command_digest: commandDigest,
    target_scope: plan.target_scope,
    request_payload_digest: plan.request_payload_digest,
    event_state_digest: current.event_state_digest,
    event_etag_digest: current.event_etag_digest,
  });
  return {
    kind: "google_calendar_event_update",
    operation: "google.calendar.write.event.update",
    target_scope: plan.target_scope,
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    current_summary: current.summary,
    new_summary: plan.summary,
    event_start: current.event_start,
    event_end: current.event_end,
    event_time_kind: current.event_time_kind,
    event_time_zone: current.event_time_zone,
    recurrence_rules: current.recurrence_rules,
    recurring_event_id: current.recurring_event_id,
    original_start: current.original_start,
    organizer_self: true,
    other_attendee_count: 0,
    attendee_inventory_complete: true,
    event_state_digest: current.event_state_digest,
    observed_at: current.observed_at,
    request_payload_digest: plan.request_payload_digest,
    command_digest: commandDigest,
    review_digest: reviewDigest,
    used_for_authority: false,
    may_execute: false,
  };
}

function calendarDeleteContentReview(
  plan: CalendarEventDeletePlan,
  current: GoogleCalendarEventTargetObservation,
  commandDigest: string,
): GoogleCalendarEventDeleteContentReview {
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.google-calendar-event-delete-review.v2",
    command_digest: commandDigest,
    target_scope: plan.target_scope,
    request_payload_digest: plan.request_payload_digest,
    event_state_digest: current.event_state_digest,
    event_etag_digest: current.event_etag_digest,
  });
  return {
    kind: "google_calendar_event_delete",
    operation: "google.calendar.write.event.delete",
    target_scope: plan.target_scope,
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    current_summary: current.summary,
    event_start: current.event_start,
    event_end: current.event_end,
    event_time_kind: current.event_time_kind,
    event_time_zone: current.event_time_zone,
    recurrence_rules: current.recurrence_rules,
    recurring_event_id: current.recurring_event_id,
    original_start: current.original_start,
    organizer_self: true,
    other_attendee_count: 0,
    attendee_inventory_complete: true,
    event_state_digest: current.event_state_digest,
    observed_at: current.observed_at,
    request_payload_digest: plan.request_payload_digest,
    command_digest: commandDigest,
    review_digest: reviewDigest,
    used_for_authority: false,
    may_execute: false,
  };
}

function calendarInviteContentReview(
  plan: CalendarEventInvitePlan,
  current: GoogleCalendarEventTargetSnapshot,
  commandDigest: string,
): GoogleCalendarEventInviteContentReview {
  const mergedAttendeePayload = calendarMergedAttendeePayload(plan, current);
  if (Buffer.byteLength(jsonBody({ attendees: mergedAttendeePayload }), "utf8") > plan.max_bytes) {
    throw new Error("event.invite attendee inventory exceeds max_bytes; mutation_sent=false");
  }
  const retainedAttendees = current.attendees.map((attendee) => attendee.email);
  const notificationRecipients = [
    ...current.attendees.filter((attendee) => !attendee.organizer && !attendee.self).map((attendee) => attendee.email),
    ...plan.attendee_emails,
  ];
  if (new Set(notificationRecipients.map((email) => email.toLowerCase())).size !== notificationRecipients.length) {
    throw new Error("event.invite notification recipient inventory is ambiguous; mutation_sent=false");
  }
  const observed = current.observation;
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.google-calendar-event-invite-review.v1",
    command_digest: commandDigest,
    target_scope: plan.target_scope,
    request_payload_digest: plan.request_payload_digest,
    event_state_digest: observed.event_state_digest,
    event_etag_digest: observed.event_etag_digest,
    retained_attendees: retainedAttendees,
    invitees: plan.attendee_emails,
    notification_recipients: notificationRecipients,
    notification_effect: "send_calendar_update_notifications_to_all_attendees",
  });
  return {
    kind: "google_calendar_event_invite",
    operation: "google.calendar.write.event.invite",
    target_scope: plan.target_scope,
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    current_summary: observed.summary,
    event_start: observed.event_start,
    event_end: observed.event_end,
    event_time_kind: observed.event_time_kind,
    event_time_zone: observed.event_time_zone,
    recurrence_rules: observed.recurrence_rules,
    recurring_event_id: observed.recurring_event_id,
    original_start: observed.original_start,
    organizer_self: true,
    other_attendee_count: observed.other_attendee_count,
    attendee_inventory_complete: true,
    retained_attendees: retainedAttendees,
    retained_attendee_count: retainedAttendees.length,
    invitees: plan.attendee_emails,
    notification_recipients: notificationRecipients,
    notification_recipient_count: notificationRecipients.length,
    notification_effect: "send_calendar_update_notifications_to_all_attendees",
    event_state_digest: observed.event_state_digest,
    observed_at: observed.observed_at,
    request_payload_digest: plan.request_payload_digest,
    command_digest: commandDigest,
    review_digest: reviewDigest,
    used_for_authority: false,
    may_execute: false,
  };
}

function calendarMergedAttendeePayload(
  plan: CalendarEventInvitePlan,
  current: GoogleCalendarEventTargetSnapshot,
): Array<Record<string, unknown>> {
  const existingIdentities = new Set(current.attendees.map((attendee) => attendee.email.toLowerCase()));
  if (plan.attendee_emails.some((email) => existingIdentities.has(email.toLowerCase()))) {
    throw new Error("event.invite includes an address that is already an attendee; mutation_sent=false");
  }
  if (current.attendees.length + plan.attendee_emails.length > MAX_CALENDAR_EVENT_ATTENDEES) {
    throw new Error("event.invite would exceed the complete attendee inventory limit; mutation_sent=false");
  }
  return [
    ...current.attendees.map((attendee) => ({
      email: attendee.email,
      ...(attendee.optional === undefined ? {} : { optional: attendee.optional }),
      ...(attendee.resource === undefined ? {} : { resource: attendee.resource }),
      ...(attendee.response_status === undefined ? {} : { responseStatus: attendee.response_status }),
      ...(attendee.comment === undefined ? {} : { comment: attendee.comment }),
      ...(attendee.display_name === undefined ? {} : { displayName: attendee.display_name }),
      ...(attendee.additional_guests === undefined ? {} : { additionalGuests: attendee.additional_guests }),
    })),
    ...plan.attendee_emails.map((email) => ({ email })),
  ];
}

async function invokeGoogleCalendarEventUpdate(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions,
  plan = calendarEventUpdatePlan(args),
  current?: Awaited<ReturnType<typeof readGoogleCalendarEventTarget>>,
): Promise<unknown> {
  const snapshot = current ?? await recheckCalendarEventTarget(plan, opts);
  if (snapshot.observation.event_state_digest !== plan.source_event.event_state_digest) {
    throw new Error("google.calendar.write event target changed immediately before update; mutation_sent=false");
  }
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const params = new URLSearchParams({ sendUpdates: "none" });
  const target: GoogleWriteTarget = {
    service: "calendar",
    hostname: "www.googleapis.com",
    path: `/calendar/v3/calendars/${encodeURIComponent(plan.calendar_id)}/events/${encodeURIComponent(plan.event_id)}?${params}`,
    method: "PATCH",
    maxBytes,
    token,
    body: jsonBody({ summary: plan.summary }),
    if_match: snapshot.etag,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.calendar.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.calendar.write", response);
  return mutationResult("google.calendar.write", "calendar", "event.update", target, response, {
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    target_scope: plan.target_scope,
    event_state_digest: snapshot.observation.event_state_digest,
    event_summary_digest: sha256String(plan.summary),
    invite_notifications_requested: false,
  });
}

async function invokeGoogleCalendarEventDelete(
  plan: CalendarEventDeletePlan,
  opts: GoogleWriteOptions,
  current?: Awaited<ReturnType<typeof readGoogleCalendarEventTarget>>,
): Promise<unknown> {
  const snapshot = current ?? await recheckCalendarEventTarget(plan, opts);
  if (snapshot.observation.event_state_digest !== plan.source_event.event_state_digest ||
      snapshot.observation.event_etag_digest !== plan.source_event.event_etag_digest) {
    throw new Error("google.calendar.write event target changed immediately before deletion; mutation_sent=false");
  }
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const params = new URLSearchParams({ sendUpdates: "none" });
  const target: GoogleWriteTarget = {
    service: "calendar",
    hostname: "www.googleapis.com",
    path: `/calendar/v3/calendars/${encodeURIComponent(plan.calendar_id)}/events/${encodeURIComponent(plan.event_id)}?${params}`,
    method: "DELETE",
    maxBytes: plan.max_bytes,
    token,
    if_match: snapshot.etag,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.calendar.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.calendar.write", response);
  return mutationResult("google.calendar.write", "calendar", "event.delete", target, response, {
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    target_scope: plan.target_scope,
    event_state_digest: snapshot.observation.event_state_digest,
    invite_notifications_requested: false,
    other_attendee_count: 0,
  });
}

async function invokeGoogleCalendarEventInvite(
  plan: CalendarEventInvitePlan,
  opts: GoogleWriteOptions,
  current?: Awaited<ReturnType<typeof readGoogleCalendarEventTarget>>,
): Promise<unknown> {
  const snapshot = current ?? await recheckCalendarEventTarget(plan, opts);
  if (snapshot.observation.event_state_digest !== plan.source_event.event_state_digest ||
      snapshot.observation.event_etag_digest !== plan.source_event.event_etag_digest) {
    throw new Error("google.calendar.write event or attendee state changed after invitation review; mutation_sent=false");
  }
  const attendees = calendarMergedAttendeePayload(plan, snapshot);
  const body = jsonBody({ attendees });
  if (Buffer.byteLength(body, "utf8") > plan.max_bytes) {
    throw new Error("event.invite attendee inventory exceeds max_bytes; mutation_sent=false");
  }
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const params = new URLSearchParams({ sendUpdates: "all" });
  const target: GoogleWriteTarget = {
    service: "calendar",
    hostname: "www.googleapis.com",
    path: `/calendar/v3/calendars/${encodeURIComponent(plan.calendar_id)}/events/${encodeURIComponent(plan.event_id)}?${params}`,
    method: "PATCH",
    maxBytes: plan.max_bytes,
    token,
    body,
    if_match: snapshot.etag,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.calendar.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.calendar.write", response);
  return mutationResult("google.calendar.write", "calendar", "event.invite", target, response, {
    calendar_id: plan.calendar_id,
    event_id: plan.event_id,
    target_scope: plan.target_scope,
    event_state_digest: snapshot.observation.event_state_digest,
    invitee_count: plan.attendee_emails.length,
    invitees_digest: sha256String(plan.attendee_emails.join("\n")),
    retained_attendee_count: snapshot.attendees.length,
    notification_recipient_count: snapshot.attendees.filter((attendee) => !attendee.organizer && !attendee.self).length +
      plan.attendee_emails.length,
    notification_recipients_digest: sha256String([
      ...snapshot.attendees.filter((attendee) => !attendee.organizer && !attendee.self).map((attendee) => attendee.email),
      ...plan.attendee_emails,
    ].join("\n")),
    invite_notifications_requested: true,
    notification_effect: "send_calendar_update_notifications_to_all_attendees",
  });
}

function overlappingBusyIntervals(
  plan: CalendarEventCreatePlan,
  observation: CalendarAvailabilityObservation,
): { start: string; end: string }[] {
  return observation.busy.filter((interval) => Date.parse(interval.start) < plan.event_end_ms &&
    Date.parse(interval.end) > plan.event_start_ms);
}

function calendarCreateContentReview(
  args: Record<string, unknown>,
  plan: CalendarEventCreatePlan,
  current: CalendarAvailabilityObservation,
  commandDigest: string,
): GoogleCalendarEventCreateContentReview {
  const requestPayloadDigest = plan.request_payload_digest;
  const reviewDigest = operationPlanDigest({
    schema_version: "blue-tanuki.google-calendar-event-create-review.v1",
    command_digest: commandDigest,
    request_payload_digest: requestPayloadDigest,
    source_observation_digest: plan.source_observation.observation_digest,
    availability_result_digest: current.result_digest,
  });
  const summary = stringArg(args, "summary", false);
  const description = stringArg(args, "description", false);
  const location = stringArg(args, "location", false);
  const timeZone = stringArg(args, "time_zone", false);
  return {
    kind: "google_calendar_event_create",
    operation: "google.calendar.write.event.create",
    calendar_id: plan.calendar_id,
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    start: plan.event_start,
    end: plan.event_end,
    ...(timeZone ? { time_zone: timeZone } : {}),
    source_observation_digest: plan.source_observation.observation_digest,
    availability_result_digest: current.result_digest,
    availability_observed_at: current.observed_at,
    availability_window_start: current.time_min,
    availability_window_end: current.time_max,
    busy_intervals: current.busy,
    overlapping_busy_intervals: overlappingBusyIntervals(plan, current),
    attendees: plan.attendee_emails,
    invite_notifications_requested: plan.attendee_emails.length > 0,
    request_payload_digest: requestPayloadDigest,
    command_digest: commandDigest,
    review_digest: reviewDigest,
    used_for_authority: false,
    may_execute: false,
  };
}

export async function invokeGoogleCalendarWrite(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions = {},
): Promise<unknown> {
  const operation = operationArg(args, ["event.create", "event.update", "event.delete", "event.invite"]);
  if (operation === "event.update") return await invokeGoogleCalendarEventUpdate(args, opts);
  if (operation === "event.delete") {
    return await invokeGoogleCalendarEventDelete(calendarEventDeletePlan(args), opts);
  }
  if (operation === "event.invite") return await invokeGoogleCalendarEventInvite(calendarEventInvitePlan(args), opts);
  const plan = calendarEventCreatePlan(args);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const calendarId = plan.calendar_id;
  const params = new URLSearchParams({ sendUpdates: plan.attendee_emails.length > 0 ? "all" : "none" });
  const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const method: GoogleWriteMethod = "POST";
  const body = jsonBody(plan.event_body);
  const fallback: Record<string, unknown> = {
    calendar_id: calendarId,
    invite_notifications_requested: plan.attendee_emails.length > 0,
    invited_attendee_count: plan.attendee_emails.length,
    ...(plan.attendee_emails.length > 0
      ? { invitees_digest: sha256String(plan.attendee_emails.join("\n")),
        notification_effect: "send_invitation_emails_to_listed_attendees" } : {}),
    ...(opts.calendar_availability_observation_digest
      ? { availability_observation_digest: opts.calendar_availability_observation_digest } : {}),
    ...(opts.calendar_availability_result_digest
      ? { availability_result_digest: opts.calendar_availability_result_digest } : {}),
    ...(opts.calendar_availability_observed_at
      ? { availability_observed_at: opts.calendar_availability_observed_at } : {}),
  };

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
  return mutationResult("google.calendar.write", "calendar", "event.create", target, response, fallback);
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

const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_PERMISSION_PAGE_SIZE = 100;
const GOOGLE_DRIVE_PERMISSION_MAX_PAGES = 5;
const GOOGLE_DRIVE_PERMISSION_MAX_ENTRIES = 500;
const GOOGLE_DRIVE_SCOPE_PAGE_MAX_BYTES = 64_000;
const GOOGLE_DRIVE_CREATE_PERMISSION_FIELDS =
  "permissions(type,emailAddress,domain,role,allowFileDiscovery,expirationTime,deleted,permissionDetails(permissionType,inheritedFrom,role,inherited))";

interface GoogleDriveCreateArguments {
  operation: "file.create";
  parent_id: string;
  name: string;
  mime_type: "text/plain";
  content: string;
  max_bytes: number;
  max_content_bytes: number;
}

interface GoogleDriveUpdateArguments {
  operation: "file.update";
  file_id: string;
  mime_type: "text/plain";
  content: string;
  max_bytes: number;
  max_content_bytes: number;
}

interface GoogleDrivePermissionCreateArguments {
  operation: "permissions.create";
  file_id: string;
  email_address: string;
  role: "reader" | "writer";
}

interface GoogleDriveTrashArguments {
  operation: "file.trash";
  file_id: string;
}

interface GoogleDriveFolderMetadata {
  id: string;
  name: string;
  mime_type: string;
  modified_time: string | null;
  parents: readonly string[] | null;
  drive_id: string | null;
  version: string | null;
  head_revision_id: string | null;
  shared: boolean | null;
  trashed: boolean;
  inherited_permissions_disabled: boolean | null;
}

interface GoogleDriveFolderScopeSnapshot {
  folder: GoogleDriveFolderMetadata;
  folder_state_digest: string;
  access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
  target_name_absent: true;
}

interface GoogleDriveUpdateFileMetadata {
  id: string;
  name: string;
  mime_type: "text/plain";
  modified_time: string | null;
  parent_ids: readonly string[];
  drive_id: string | null;
  version: string;
  head_revision_id: string | null;
  shared: boolean | null;
  trashed: false;
  inherited_permissions_disabled: boolean | null;
  owned_by_me: boolean | null;
}

interface GoogleDriveUpdateSnapshot {
  file: GoogleDriveUpdateFileMetadata;
  file_state_digest: string;
  access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
  current_content: string;
  current_content_digest: string;
  current_content_bytes: number;
}

interface GoogleDrivePermissionCreateSnapshot {
  file: GoogleDriveUpdateFileMetadata;
  file_state_digest: string;
  access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
}

interface GoogleDriveTrashSnapshot {
  file: GoogleDriveUpdateFileMetadata;
  file_state_digest: string;
  access_scope_digest: string;
  permissions: readonly GoogleDrivePermissionReview[];
}

function normalizeGoogleDriveCreateArguments(args: Record<string, unknown>): GoogleDriveCreateArguments {
  if (operationArg(args, ["file.create"]) !== "file.create") {
    throw new Error("google.drive.write only supports plan-bound file.create; mutation_sent=false");
  }
  const allowed = new Set(["operation", "parent_id", "name", "mime_type", "content", "max_bytes", "max_content_bytes"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new Error("google.drive.write file.create contains unsupported fields; mutation_sent=false");
  }
  const parentId = stringArg(args, "parent_id")!;
  const name = stringArg(args, "name")!;
  if (args.parent_id !== parentId || args.name !== name || parentId.length > 512 ||
      /[\s/?#\\\u0000-\u001f\u007f]/.test(parentId) || name.length > 255 ||
      /[\/\\\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..") {
    throw new Error("google.drive.write parent_id or name is invalid; mutation_sent=false");
  }
  const mimeType = stringArg(args, "mime_type", false) ?? "text/plain";
  if (mimeType !== "text/plain") {
    throw new Error("google.drive.write plan-bound file.create currently requires text/plain; mutation_sent=false");
  }
  const content = boundedContent(args, positiveIntArg(args, "max_content_bytes", DEFAULT_MAX_CONTENT_BYTES, MAX_CONTENT_BYTES), true)!;
  const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
  const maxContentBytes = args.max_content_bytes ?? DEFAULT_MAX_CONTENT_BYTES;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES ||
      typeof maxContentBytes !== "number" || !Number.isSafeInteger(maxContentBytes) ||
      maxContentBytes < 1 || maxContentBytes > MAX_CONTENT_BYTES || Buffer.byteLength(content, "utf8") > maxContentBytes) {
    throw new Error("google.drive.write file.create byte bounds are invalid; mutation_sent=false");
  }
  return { operation: "file.create", parent_id: parentId, name, mime_type: "text/plain", content,
    max_bytes: maxBytes, max_content_bytes: maxContentBytes };
}

function normalizeGoogleDriveUpdateArguments(args: Record<string, unknown>): GoogleDriveUpdateArguments {
  if (operationArg(args, ["file.update"]) !== "file.update") {
    throw new Error("google.drive.write only supports plan-bound file.create or file.update; mutation_sent=false");
  }
  const allowed = new Set(["operation", "file_id", "mime_type", "content", "max_bytes", "max_content_bytes"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new Error("google.drive.write file.update contains unsupported fields; mutation_sent=false");
  }
  const fileId = stringArg(args, "file_id")!;
  if (args.file_id !== fileId || fileId.length > 512 ||
      /[\s/?#\\\u0000-\u001f\u007f]/.test(fileId)) {
    throw new Error("google.drive.write file.update identity is invalid; mutation_sent=false");
  }
  const mimeType = stringArg(args, "mime_type", false) ?? "text/plain";
  if (mimeType !== "text/plain") {
    throw new Error("google.drive.write plan-bound file.update currently requires text/plain; mutation_sent=false");
  }
  const maxContentBytes = positiveIntArg(args, "max_content_bytes", DEFAULT_MAX_CONTENT_BYTES, MAX_CONTENT_BYTES);
  const content = boundedContent(args, maxContentBytes, true)!;
  const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES ||
      typeof args.max_content_bytes !== "undefined" &&
        (typeof args.max_content_bytes !== "number" || !Number.isSafeInteger(args.max_content_bytes) ||
          args.max_content_bytes < 1 || args.max_content_bytes > MAX_CONTENT_BYTES) ||
      Buffer.byteLength(content, "utf8") > maxContentBytes) {
    throw new Error("google.drive.write file.update byte bounds are invalid; mutation_sent=false");
  }
  return { operation: "file.update", file_id: fileId, mime_type: "text/plain", content,
    max_bytes: maxBytes, max_content_bytes: maxContentBytes };
}

function normalizeGoogleDrivePermissionCreateArguments(args: Record<string, unknown>): GoogleDrivePermissionCreateArguments {
  if (operationArg(args, ["permissions.create"]) !== "permissions.create") {
    throw new Error("google.drive.write only supports plan-bound file.create, file.update, or permissions.create; mutation_sent=false");
  }
  const allowed = new Set(["operation", "file_id", "email_address", "role"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new Error("google.drive.write permissions.create contains unsupported fields; mutation_sent=false");
  }
  const fileId = stringArg(args, "file_id")!;
  if (args.file_id !== fileId || fileId.length > 512 || /[\s/?#\\\u0000-\u001f\u007f]/.test(fileId)) {
    throw new Error("google.drive.write permissions.create identity is invalid; mutation_sent=false");
  }
  const emailAddress = stringArg(args, "email_address")!;
  const normalizedEmail = normalizeGmailAddressList(emailAddress);
  if (args.email_address !== emailAddress || !normalizedEmail || normalizedEmail.includes(",") ||
      normalizedEmail !== emailAddress || emailAddress.length > 320) {
    throw new Error("google.drive.write permissions.create requires one exact user email; mutation_sent=false");
  }
  const role = stringArg(args, "role")!;
  if (role !== "reader" && role !== "writer") {
    throw new Error("google.drive.write permissions.create only supports reader or writer; mutation_sent=false");
  }
  return { operation: "permissions.create", file_id: fileId, email_address: emailAddress, role };
}

function normalizeGoogleDriveTrashArguments(args: Record<string, unknown>): GoogleDriveTrashArguments {
  if (operationArg(args, ["file.trash"]) !== "file.trash") {
    throw new Error("google.drive.write only supports plan-bound file.trash; mutation_sent=false");
  }
  if (Object.keys(args).some((key) => key !== "operation" && key !== "file_id")) {
    throw new Error("google.drive.write file.trash contains unsupported fields; mutation_sent=false");
  }
  const fileId = stringArg(args, "file_id")!;
  if (args.file_id !== fileId || fileId.length > 512 || /[\s/?#\\\u0000-\u001f\u007f]/.test(fileId)) {
    throw new Error("google.drive.write file.trash identity is invalid; mutation_sent=false");
  }
  return { operation: "file.trash", file_id: fileId };
}

function googleDriveFolderMetadataProjection(value: unknown, expectedFolderId: string): GoogleDriveFolderMetadata {
  if (!isRecord(value) || value.id !== expectedFolderId || value.mimeType !== GOOGLE_DRIVE_FOLDER_MIME ||
      typeof value.name !== "string" || value.name.length === 0 || value.name.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(value.name) || value.trashed !== false ||
      (value.parents !== undefined && (!Array.isArray(value.parents) ||
        value.parents.some((parent) => typeof parent !== "string" || parent.length === 0 || parent.length > 512)))) {
    throw new Error("google.drive.write parent folder identity or state is unavailable; mutation_sent=false");
  }
  const optional = (key: string): string | null => {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error("google.drive.write parent folder state is malformed; mutation_sent=false");
    }
    return candidate;
  };
  const shared = value.shared === undefined ? null : typeof value.shared === "boolean" ? value.shared : undefined;
  const inheritedDisabled = value.inheritedPermissionsDisabled === undefined
    ? null : typeof value.inheritedPermissionsDisabled === "boolean" ? value.inheritedPermissionsDisabled : undefined;
  if (shared === undefined || inheritedDisabled === undefined) {
    throw new Error("google.drive.write parent folder state is malformed; mutation_sent=false");
  }
  return {
    id: expectedFolderId,
    name: value.name,
    mime_type: GOOGLE_DRIVE_FOLDER_MIME,
    modified_time: optional("modifiedTime"),
    parents: Array.isArray(value.parents) ? value.parents as string[] : null,
    drive_id: optional("driveId"),
    version: optional("version"),
    head_revision_id: optional("headRevisionId"),
    shared,
    trashed: false,
    inherited_permissions_disabled: inheritedDisabled,
  };
}

async function readGoogleDriveFolderMetadata(input: {
  folderId: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDriveFolderMetadata> {
  const path = `/drive/v3/files/${encodeURIComponent(input.folderId)}?${new URLSearchParams({
    supportsAllDrives: "true",
    fields: "id,name,mimeType,modifiedTime,parents,driveId,version,headRevisionId,shared,trashed,inheritedPermissionsDisabled",
  })}`;
  assertToolExecutionNotCancelled(input.signal, "google.drive.write parent folder read");
  let response: GoogleWriteResponse;
  try {
    response = await input.request({ service: "drive", hostname: "www.googleapis.com", path,
      method: "GET", maxBytes: 32_000, token: input.token }, input.signal);
  } catch {
    throw new Error("google.drive.write parent folder read failed; mutation_sent=false");
  }
  if (!response.ok || response.truncated) {
    throw new Error("google.drive.write parent folder read was unavailable or truncated; mutation_sent=false");
  }
  let value: unknown;
  try { value = JSON.parse(response.body) as unknown; }
  catch { throw new Error("google.drive.write parent folder metadata was invalid; mutation_sent=false"); }
  return googleDriveFolderMetadataProjection(value, input.folderId);
}

function googleDrivePermissionReview(value: unknown): GoogleDrivePermissionReview {
  if (!isRecord(value) || (value.type !== "user" && value.type !== "group" && value.type !== "domain" && value.type !== "anyone") ||
      typeof value.role !== "string" || value.role.length === 0 || value.role.length > 64) {
    throw new Error("google.drive.write parent permission scope is incomplete; mutation_sent=false");
  }
  const optional = (record: Record<string, unknown>, key: string, maxLength: number): string | null => {
    const candidate = record[key];
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error("google.drive.write parent permission scope is malformed; mutation_sent=false");
    }
    return candidate;
  };
  const email = optional(value, "emailAddress", 320);
  const domain = optional(value, "domain", 320);
  if (((value.type === "user" || value.type === "group") && !email) || (value.type === "domain" && !domain)) {
    throw new Error("google.drive.write parent permission identity is incomplete; mutation_sent=false");
  }
  const allowFileDiscovery = value.allowFileDiscovery === undefined
    ? null : typeof value.allowFileDiscovery === "boolean" ? value.allowFileDiscovery : undefined;
  const deleted = value.deleted === undefined ? false : typeof value.deleted === "boolean" ? value.deleted : undefined;
  if (allowFileDiscovery === undefined || deleted === undefined) {
    throw new Error("google.drive.write parent permission scope is malformed; mutation_sent=false");
  }
  const expirationTime = optional(value, "expirationTime", 128);
  const rawDetails = value.permissionDetails;
  if (rawDetails !== undefined && (!Array.isArray(rawDetails) || rawDetails.length > 32)) {
    throw new Error("google.drive.write parent permission inheritance is malformed; mutation_sent=false");
  }
  const permissionDetails = (Array.isArray(rawDetails) ? rawDetails : []).map((entry) => {
    if (!isRecord(entry)) throw new Error("google.drive.write parent permission inheritance is malformed; mutation_sent=false");
    const inherited = entry.inherited === undefined || entry.inherited === null
      ? null : typeof entry.inherited === "boolean" ? entry.inherited : undefined;
    if (inherited === undefined) throw new Error("google.drive.write parent permission inheritance is malformed; mutation_sent=false");
    return {
      permission_type: optional(entry, "permissionType", 128),
      role: optional(entry, "role", 128),
      inherited,
      inherited_from: optional(entry, "inheritedFrom", 512),
    };
  }).sort((a, b) => operationPlanDigest(a).localeCompare(operationPlanDigest(b)));
  return {
    type: value.type,
    role: value.role,
    email_address: email,
    domain,
    allow_file_discovery: allowFileDiscovery,
    expiration_time: expirationTime,
    deleted,
    permission_details: permissionDetails,
  };
}

async function readGoogleDrivePermissionScopePass(input: {
  folderId: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<readonly GoogleDrivePermissionReview[]> {
  const permissions: GoogleDrivePermissionReview[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < GOOGLE_DRIVE_PERMISSION_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      supportsAllDrives: "true",
      pageSize: String(GOOGLE_DRIVE_PERMISSION_PAGE_SIZE),
      fields: `${GOOGLE_DRIVE_CREATE_PERMISSION_FIELDS},nextPageToken`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const path = `/drive/v3/files/${encodeURIComponent(input.folderId)}/permissions?${params}`;
    assertToolExecutionNotCancelled(input.signal, "google.drive.write parent permission read");
    let response: GoogleWriteResponse;
    try {
      response = await input.request({ service: "drive", hostname: "www.googleapis.com", path,
        method: "GET", maxBytes: GOOGLE_DRIVE_SCOPE_PAGE_MAX_BYTES, token: input.token }, input.signal);
    } catch {
      throw new Error("google.drive.write parent permission read failed; mutation_sent=false");
    }
    if (!response.ok || response.truncated) {
      throw new Error("google.drive.write parent permission scope was unavailable or truncated; mutation_sent=false");
    }
    let value: unknown;
    try { value = JSON.parse(response.body) as unknown; }
    catch { throw new Error("google.drive.write parent permission response was invalid; mutation_sent=false"); }
    if (!isRecord(value) || !Array.isArray(value.permissions)) {
      throw new Error("google.drive.write parent permission scope was incomplete; mutation_sent=false");
    }
    permissions.push(...value.permissions.map(googleDrivePermissionReview));
    if (permissions.length > GOOGLE_DRIVE_PERMISSION_MAX_ENTRIES) {
      throw new Error("google.drive.write parent permission scope exceeds the review limit; mutation_sent=false");
    }
    if (value.nextPageToken !== undefined && value.nextPageToken !== null &&
        (typeof value.nextPageToken !== "string" || value.nextPageToken.length === 0 || value.nextPageToken.length > 4_096)) {
      throw new Error("google.drive.write parent permission pagination state was malformed; mutation_sent=false");
    }
    pageToken = typeof value.nextPageToken === "string" ? value.nextPageToken : undefined;
    if (!pageToken) break;
    if (page === GOOGLE_DRIVE_PERMISSION_MAX_PAGES - 1) {
      throw new Error("google.drive.write parent permission scope exceeds the pagination limit; mutation_sent=false");
    }
  }
  if (permissions.length === 0) {
    throw new Error("google.drive.write parent permission scope was empty; mutation_sent=false");
  }
  return permissions.sort((a, b) => operationPlanDigest(a).localeCompare(operationPlanDigest(b)));
}

function googleDriveUpdateFileMetadataProjection(value: unknown, expectedFileId: string): GoogleDriveUpdateFileMetadata {
  if (!isRecord(value) || value.id !== expectedFileId || value.mimeType !== "text/plain" ||
      typeof value.name !== "string" || value.name.length === 0 || value.name.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(value.name) || value.trashed !== false ||
      typeof value.version !== "string" || value.version.length === 0 || value.version.length > 128 ||
      !Array.isArray(value.parents) || value.parents.length === 0 ||
      value.parents.some((parent) => typeof parent !== "string" || parent.length === 0 || parent.length > 512) ||
      new Set(value.parents).size !== value.parents.length) {
    throw new Error("google.drive.write update target identity, text MIME, version, or state is unavailable; mutation_sent=false");
  }
  const optional = (key: string, maxLength: number): string | null => {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error("google.drive.write update target metadata is malformed; mutation_sent=false");
    }
    return candidate;
  };
  const shared = value.shared === undefined ? null : typeof value.shared === "boolean" ? value.shared : undefined;
  const inheritedDisabled = value.inheritedPermissionsDisabled === undefined
    ? null : typeof value.inheritedPermissionsDisabled === "boolean" ? value.inheritedPermissionsDisabled : undefined;
  const ownedByMe = value.ownedByMe === undefined ? null : typeof value.ownedByMe === "boolean" ? value.ownedByMe : undefined;
  if (shared === undefined || inheritedDisabled === undefined || ownedByMe === undefined) {
    throw new Error("google.drive.write update target metadata is malformed; mutation_sent=false");
  }
  return {
    id: expectedFileId,
    name: value.name,
    mime_type: "text/plain",
    modified_time: optional("modifiedTime", 128),
    parent_ids: (value.parents as string[]).slice().sort(),
    drive_id: optional("driveId", 512),
    version: value.version,
    head_revision_id: optional("headRevisionId", 512),
    shared,
    trashed: false,
    inherited_permissions_disabled: inheritedDisabled,
    owned_by_me: ownedByMe,
  };
}

async function readGoogleDriveUpdateFileMetadata(input: {
  fileId: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDriveUpdateFileMetadata> {
  const path = `/drive/v3/files/${encodeURIComponent(input.fileId)}?${new URLSearchParams({
    supportsAllDrives: "true",
    fields: "id,name,mimeType,modifiedTime,parents,driveId,version,headRevisionId,shared,trashed,inheritedPermissionsDisabled,ownedByMe",
  })}`;
  assertToolExecutionNotCancelled(input.signal, "google.drive.write update target read");
  let response: GoogleWriteResponse;
  try {
    response = await input.request({ service: "drive", hostname: "www.googleapis.com", path,
      method: "GET", maxBytes: 32_000, token: input.token }, input.signal);
  } catch {
    throw new Error("google.drive.write update target read failed; mutation_sent=false");
  }
  if (!response.ok || response.truncated) {
    throw new Error("google.drive.write update target read was unavailable or truncated; mutation_sent=false");
  }
  let value: unknown;
  try { value = JSON.parse(response.body) as unknown; }
  catch { throw new Error("google.drive.write update target metadata was invalid; mutation_sent=false"); }
  return googleDriveUpdateFileMetadataProjection(value, input.fileId);
}

async function readGoogleDriveUpdateContent(input: {
  fileId: string;
  maxContentBytes: number;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<{ content: string; digest: string; bytes: number }> {
  const path = `/drive/v3/files/${encodeURIComponent(input.fileId)}?${new URLSearchParams({
    alt: "media",
    supportsAllDrives: "true",
  })}`;
  assertToolExecutionNotCancelled(input.signal, "google.drive.write update content read");
  let response: GoogleWriteResponse;
  try {
    response = await input.request({ service: "drive", hostname: "www.googleapis.com", path,
      method: "GET", maxBytes: input.maxContentBytes + 1, token: input.token }, input.signal);
  } catch {
    throw new Error("google.drive.write update content read failed; mutation_sent=false");
  }
  const contentType = response.content_type?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || response.truncated || response.body_utf8_valid === false || contentType !== "text/plain") {
    throw new Error("google.drive.write update content was unavailable, invalid UTF-8, non-text, or exceeded its limit; mutation_sent=false");
  }
  const bytes = Buffer.byteLength(response.body, "utf8");
  if (bytes > input.maxContentBytes) {
    throw new Error("google.drive.write update content exceeded its limit; mutation_sent=false");
  }
  return { content: response.body, digest: sha256String(response.body), bytes };
}

async function inspectGoogleDriveUpdateSnapshot(input: {
  fileId: string;
  maxContentBytes: number;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDriveUpdateSnapshot> {
  const before = await readGoogleDriveUpdateFileMetadata({ fileId: input.fileId, token: input.token,
    request: input.request, signal: input.signal });
  const permissionsBefore = await readGoogleDrivePermissionScopePass({ folderId: input.fileId,
    token: input.token, request: input.request, signal: input.signal });
  const firstContent = await readGoogleDriveUpdateContent({ fileId: input.fileId,
    maxContentBytes: input.maxContentBytes, token: input.token, request: input.request, signal: input.signal });
  const secondContent = await readGoogleDriveUpdateContent({ fileId: input.fileId,
    maxContentBytes: input.maxContentBytes, token: input.token, request: input.request, signal: input.signal });
  const permissionsAfter = await readGoogleDrivePermissionScopePass({ folderId: input.fileId,
    token: input.token, request: input.request, signal: input.signal });
  const after = await readGoogleDriveUpdateFileMetadata({ fileId: input.fileId, token: input.token,
    request: input.request, signal: input.signal });
  if (operationPlanDigest(before) !== operationPlanDigest(after) ||
      firstContent.digest !== secondContent.digest || firstContent.bytes !== secondContent.bytes ||
      operationPlanDigest(permissionsBefore) !== operationPlanDigest(permissionsAfter)) {
    throw new Error("google.drive.write update target changed or permission/content scope was inconsistent; mutation_sent=false");
  }
  return {
    file: before,
    file_state_digest: operationPlanDigest(before),
    access_scope_digest: operationPlanDigest(permissionsBefore),
    permissions: permissionsBefore,
    current_content: firstContent.content,
    current_content_digest: firstContent.digest,
    current_content_bytes: firstContent.bytes,
  };
}

async function inspectGoogleDrivePermissionCreateSnapshot(input: {
  args: GoogleDrivePermissionCreateArguments;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDrivePermissionCreateSnapshot> {
  const before = await readGoogleDriveUpdateFileMetadata({ fileId: input.args.file_id, token: input.token,
    request: input.request, signal: input.signal });
  const permissionsBefore = await readGoogleDrivePermissionScopePass({ folderId: input.args.file_id,
    token: input.token, request: input.request, signal: input.signal });
  const permissionsAfter = await readGoogleDrivePermissionScopePass({ folderId: input.args.file_id,
    token: input.token, request: input.request, signal: input.signal });
  const after = await readGoogleDriveUpdateFileMetadata({ fileId: input.args.file_id, token: input.token,
    request: input.request, signal: input.signal });
  if (operationPlanDigest(before) !== operationPlanDigest(after) ||
      operationPlanDigest(permissionsBefore) !== operationPlanDigest(permissionsAfter)) {
    throw new Error("google.drive.write permission target or access scope changed during observation; mutation_sent=false");
  }
  const alreadyGranted = permissionsBefore.some((permission) => permission.type === "user" &&
    permission.email_address?.toLowerCase() === input.args.email_address.toLowerCase() && !permission.deleted);
  if (alreadyGranted) {
    throw new Error("google.drive.write direct user permission already exists; permissions.update is unavailable; mutation_sent=false");
  }
  return { file: before, file_state_digest: operationPlanDigest(before),
    access_scope_digest: operationPlanDigest(permissionsBefore), permissions: permissionsBefore };
}

async function inspectGoogleDriveTrashSnapshot(input: {
  fileId: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDriveTrashSnapshot> {
  const before = await readGoogleDriveUpdateFileMetadata({ fileId: input.fileId, token: input.token,
    request: input.request, signal: input.signal });
  if (before.drive_id !== null || before.owned_by_me !== true) {
    throw new Error("google.drive.write file.trash requires an untrashed My Drive text file owned by this account; mutation_sent=false");
  }
  const permissionsBefore = await readGoogleDrivePermissionScopePass({ folderId: input.fileId,
    token: input.token, request: input.request, signal: input.signal });
  const permissionsAfter = await readGoogleDrivePermissionScopePass({ folderId: input.fileId,
    token: input.token, request: input.request, signal: input.signal });
  const after = await readGoogleDriveUpdateFileMetadata({ fileId: input.fileId, token: input.token,
    request: input.request, signal: input.signal });
  if (operationPlanDigest(before) !== operationPlanDigest(after) ||
      operationPlanDigest(permissionsBefore) !== operationPlanDigest(permissionsAfter) ||
      after.drive_id !== null || after.owned_by_me !== true) {
    throw new Error("google.drive.write file.trash target or access scope changed during observation; mutation_sent=false");
  }
  return { file: before, file_state_digest: operationPlanDigest(before),
    access_scope_digest: operationPlanDigest(permissionsBefore), permissions: permissionsBefore };
}

async function googleDriveCreateTargetNameIsAbsent(input: {
  parentId: string;
  driveId: string | null;
  name: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const escapeQuery = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    pageSize: "2",
    q: `'${escapeQuery(input.parentId)}' in parents and name = '${escapeQuery(input.name)}' and trashed = false`,
    fields: "files(id),nextPageToken",
  });
  if (input.driveId) {
    params.set("corpora", "drive");
    params.set("driveId", input.driveId);
  } else {
    params.set("corpora", "user");
  }
  const path = `/drive/v3/files?${params}`;
  assertToolExecutionNotCancelled(input.signal, "google.drive.write target preflight");
  let response: GoogleWriteResponse;
  try {
    response = await input.request({ service: "drive", hostname: "www.googleapis.com", path,
      method: "GET", maxBytes: 16_000, token: input.token }, input.signal);
  } catch {
    throw new Error("google.drive.write target name preflight failed; mutation_sent=false");
  }
  if (!response.ok || response.truncated) {
    throw new Error("google.drive.write target name preflight was unavailable or truncated; mutation_sent=false");
  }
  let value: unknown;
  try { value = JSON.parse(response.body) as unknown; }
  catch { throw new Error("google.drive.write target name preflight was invalid; mutation_sent=false"); }
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length > 0 ||
      value.nextPageToken !== undefined && value.nextPageToken !== null &&
        (typeof value.nextPageToken !== "string" || value.nextPageToken.length === 0 || value.nextPageToken.length > 4_096)) {
    return false;
  }
  if (typeof value.nextPageToken === "string") return false;
  return true;
}

async function inspectGoogleDriveFolderScope(input: {
  parentId: string;
  name: string;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  signal?: AbortSignal;
}): Promise<GoogleDriveFolderScopeSnapshot> {
  const before = await readGoogleDriveFolderMetadata({ folderId: input.parentId, token: input.token,
    request: input.request, signal: input.signal });
  const firstPermissions = await readGoogleDrivePermissionScopePass({ folderId: input.parentId,
    token: input.token, request: input.request, signal: input.signal });
  const secondPermissions = await readGoogleDrivePermissionScopePass({ folderId: input.parentId,
    token: input.token, request: input.request, signal: input.signal });
  const after = await readGoogleDriveFolderMetadata({ folderId: input.parentId, token: input.token,
    request: input.request, signal: input.signal });
  const folderStateDigest = operationPlanDigest(before);
  const accessScopeDigest = operationPlanDigest(firstPermissions);
  if (operationPlanDigest(after) !== folderStateDigest || operationPlanDigest(secondPermissions) !== accessScopeDigest) {
    throw new Error("google.drive.write parent folder or access scope changed during observation; mutation_sent=false");
  }
  if (!await googleDriveCreateTargetNameIsAbsent({ parentId: input.parentId, driveId: before.drive_id,
    name: input.name, token: input.token, request: input.request, signal: input.signal })) {
    throw new Error("google.drive.write target name already exists or cannot be confirmed absent; mutation_sent=false");
  }
  return { folder: before, folder_state_digest: folderStateDigest, access_scope_digest: accessScopeDigest,
    permissions: firstPermissions, target_name_absent: true };
}

function googleDriveCreateObservation(input: {
  args: GoogleDriveCreateArguments;
  snapshot: GoogleDriveFolderScopeSnapshot;
  commandDigest: string;
  operationPlanBindingDigest: string;
}): GoogleDriveWriteTargetVersionObservation {
  return GoogleDriveWriteTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.google-drive-write-target-version.v1",
    operation: "file.create",
    target_identity_digest: googleDriveWriteTargetIdentityDigest(input.args.parent_id, input.args.name),
    request_payload_digest: googleDriveWriteRequestPayloadDigest(input.args),
    parent_folder_id: input.args.parent_id,
    parent_folder_state_digest: input.snapshot.folder_state_digest,
    parent_access_scope_digest: input.snapshot.access_scope_digest,
    parent_access_scope_complete: true,
    parent_access_scope_entry_count: input.snapshot.permissions.length,
    target_name_absent: true,
    command_digest: input.commandDigest,
    operation_plan_binding_digest: input.operationPlanBindingDigest,
    used_for_authority: false,
    may_execute: false,
  });
}

function googleDriveUpdateObservation(input: {
  args: GoogleDriveUpdateArguments;
  snapshot: GoogleDriveUpdateSnapshot;
  commandDigest: string;
  operationPlanBindingDigest: string;
}): GoogleDriveUpdateTargetVersionObservation {
  return GoogleDriveUpdateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.google-drive-update-target-version.v1",
    operation: "file.update",
    target_identity_digest: googleDriveUpdateTargetIdentityDigest(input.args.file_id),
    request_payload_digest: googleDriveUpdateRequestPayloadDigest(input.args),
    file_id: input.args.file_id,
    file_state_digest: input.snapshot.file_state_digest,
    current_content_digest: input.snapshot.current_content_digest,
    current_content_bytes: input.snapshot.current_content_bytes,
    target_mime_type: "text/plain",
    target_access_scope_digest: input.snapshot.access_scope_digest,
    target_access_scope_complete: true,
    target_access_scope_entry_count: input.snapshot.permissions.length,
    command_digest: input.commandDigest,
    operation_plan_binding_digest: input.operationPlanBindingDigest,
    used_for_authority: false,
    may_execute: false,
  });
}

function googleDrivePermissionCreateObservation(input: {
  args: GoogleDrivePermissionCreateArguments;
  snapshot: GoogleDrivePermissionCreateSnapshot;
  commandDigest: string;
  operationPlanBindingDigest: string;
}): GoogleDrivePermissionCreateTargetVersionObservation {
  return GoogleDrivePermissionCreateTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.google-drive-permission-create-target-version.v1",
    operation: "permissions.create",
    target_identity_digest: googleDrivePermissionCreateTargetIdentityDigest(input.args.file_id, input.args.email_address),
    request_payload_digest: googleDrivePermissionCreateRequestPayloadDigest(input.args),
    file_id: input.args.file_id,
    file_state_digest: input.snapshot.file_state_digest,
    target_access_scope_digest: input.snapshot.access_scope_digest,
    target_access_scope_complete: true,
    target_access_scope_entry_count: input.snapshot.permissions.length,
    command_digest: input.commandDigest,
    operation_plan_binding_digest: input.operationPlanBindingDigest,
    used_for_authority: false,
    may_execute: false,
  });
}

function googleDriveTrashObservation(input: {
  args: GoogleDriveTrashArguments;
  snapshot: GoogleDriveTrashSnapshot;
  commandDigest: string;
  operationPlanBindingDigest: string;
}): GoogleDriveTrashTargetVersionObservation {
  return GoogleDriveTrashTargetVersionObservationSchema.parse({
    schema_version: "blue-tanuki.google-drive-trash-target-version.v1",
    operation: "file.trash",
    target_identity_digest: googleDriveTrashTargetIdentityDigest(input.args.file_id),
    request_payload_digest: googleDriveTrashRequestPayloadDigest(input.args.file_id),
    file_id: input.args.file_id,
    file_state_digest: input.snapshot.file_state_digest,
    target_access_scope_digest: input.snapshot.access_scope_digest,
    target_access_scope_complete: true,
    target_access_scope_entry_count: input.snapshot.permissions.length,
    owner_confirmed: true,
    reversible_trash_only: true,
    command_digest: input.commandDigest,
    operation_plan_binding_digest: input.operationPlanBindingDigest,
    used_for_authority: false,
    may_execute: false,
  });
}

export async function inspectGoogleDriveWriteTargetVersion(
  rawArgs: Record<string, unknown>,
  options: GoogleWriteOptions & { operation_plan_binding_digest?: string; command_digest?: string } = {},
): Promise<GoogleDriveWriteTargetVersionObservation | GoogleDriveUpdateTargetVersionObservation |
    GoogleDrivePermissionCreateTargetVersionObservation | GoogleDriveTrashTargetVersionObservation> {
  if (!options.operation_plan_binding_digest || !/^[a-f0-9]{64}$/.test(options.operation_plan_binding_digest) ||
      !options.command_digest || !/^[a-f0-9]{64}$/.test(options.command_digest)) {
    throw new Error("google.drive.write requires a current Operation Plan command binding; mutation_sent=false");
  }
  const token = googleToken(options.env ?? process.env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = options.request ?? defaultGoogleWriteRequest;
  if (rawArgs.operation === "file.trash") {
    const args = normalizeGoogleDriveTrashArguments(rawArgs);
    const snapshot = await inspectGoogleDriveTrashSnapshot({ fileId: args.file_id, token, request, signal: options.signal });
    return googleDriveTrashObservation({ args, snapshot, commandDigest: options.command_digest,
      operationPlanBindingDigest: options.operation_plan_binding_digest });
  }
  if (rawArgs.operation === "permissions.create") {
    const args = normalizeGoogleDrivePermissionCreateArguments(rawArgs);
    const snapshot = await inspectGoogleDrivePermissionCreateSnapshot({ args, token, request, signal: options.signal });
    return googleDrivePermissionCreateObservation({ args, snapshot, commandDigest: options.command_digest,
      operationPlanBindingDigest: options.operation_plan_binding_digest });
  }
  if (rawArgs.operation === "file.update") {
    const args = normalizeGoogleDriveUpdateArguments(rawArgs);
    const snapshot = await inspectGoogleDriveUpdateSnapshot({ fileId: args.file_id,
      maxContentBytes: args.max_content_bytes, token, request, signal: options.signal });
    return googleDriveUpdateObservation({ args, snapshot, commandDigest: options.command_digest,
      operationPlanBindingDigest: options.operation_plan_binding_digest });
  }
  const args = normalizeGoogleDriveCreateArguments(rawArgs);
  const snapshot = await inspectGoogleDriveFolderScope({ parentId: args.parent_id, name: args.name,
    token, request, signal: options.signal });
  return googleDriveCreateObservation({ args, snapshot, commandDigest: options.command_digest,
    operationPlanBindingDigest: options.operation_plan_binding_digest });
}

export function assertGoogleDriveWriteTargetVersion(
  rawArgs: Record<string, unknown>,
  rawObservation: unknown,
  commandDigest: string,
  operationPlanBindingDigest: string | undefined,
): GoogleDriveWriteTargetVersionObservation | GoogleDriveUpdateTargetVersionObservation |
    GoogleDrivePermissionCreateTargetVersionObservation | GoogleDriveTrashTargetVersionObservation {
  if (rawArgs.operation === "file.trash") {
    const observation = GoogleDriveTrashTargetVersionObservationSchema.parse(rawObservation);
    const args = normalizeGoogleDriveTrashArguments(rawArgs);
    if (!operationPlanBindingDigest || observation.command_digest !== commandDigest ||
        observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
        observation.operation !== args.operation || observation.file_id !== args.file_id ||
        observation.target_identity_digest !== googleDriveTrashTargetIdentityDigest(args.file_id) ||
        observation.request_payload_digest !== googleDriveTrashRequestPayloadDigest(args.file_id)) {
      throw new Error("google.drive.write trash target version does not match command or Operation Plan source");
    }
    return observation;
  }
  if (rawArgs.operation === "permissions.create") {
    const observation = GoogleDrivePermissionCreateTargetVersionObservationSchema.parse(rawObservation);
    const args = normalizeGoogleDrivePermissionCreateArguments(rawArgs);
    if (!operationPlanBindingDigest || observation.command_digest !== commandDigest ||
        observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
        observation.operation !== args.operation || observation.file_id !== args.file_id ||
        observation.target_identity_digest !== googleDrivePermissionCreateTargetIdentityDigest(args.file_id, args.email_address) ||
        observation.request_payload_digest !== googleDrivePermissionCreateRequestPayloadDigest(args)) {
      throw new Error("google.drive.write permission target version does not match command or Operation Plan source");
    }
    return observation;
  }
  if (rawArgs.operation === "file.update") {
    const observation = GoogleDriveUpdateTargetVersionObservationSchema.parse(rawObservation);
    const args = normalizeGoogleDriveUpdateArguments(rawArgs);
    if (!operationPlanBindingDigest || observation.command_digest !== commandDigest ||
        observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
        observation.operation !== args.operation || observation.file_id !== args.file_id ||
        observation.target_identity_digest !== googleDriveUpdateTargetIdentityDigest(args.file_id) ||
        observation.request_payload_digest !== googleDriveUpdateRequestPayloadDigest(args)) {
      throw new Error("google.drive.write update target version does not match command or Operation Plan source");
    }
    return observation;
  }
  const observation = GoogleDriveWriteTargetVersionObservationSchema.parse(rawObservation);
  const args = normalizeGoogleDriveCreateArguments(rawArgs);
  if (!operationPlanBindingDigest || observation.command_digest !== commandDigest ||
      observation.operation_plan_binding_digest !== operationPlanBindingDigest ||
      observation.operation !== args.operation || observation.parent_folder_id !== args.parent_id ||
      observation.target_identity_digest !== googleDriveWriteTargetIdentityDigest(args.parent_id, args.name) ||
      observation.request_payload_digest !== googleDriveWriteRequestPayloadDigest(args)) {
    throw new Error("google.drive.write target version does not match command or Operation Plan source");
  }
  return observation;
}

export async function inspectGoogleDriveWriteContentReview(
  rawArgs: Record<string, unknown>,
  options: GoogleWriteOptions & { operation_plan_binding_digest?: string; command_digest?: string } = {},
): Promise<GoogleDriveFileCreateContentReview | GoogleDriveFileUpdateContentReview | GoogleDrivePermissionCreateContentReview |
    GoogleDriveFileTrashContentReview> {
  if (!options.operation_plan_binding_digest || !options.command_digest) {
    throw new Error("google.drive.write content review requires an Operation Plan binding");
  }
  const token = googleToken(options.env ?? process.env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = options.request ?? defaultGoogleWriteRequest;
  if (rawArgs.operation === "file.trash") {
    const args = normalizeGoogleDriveTrashArguments(rawArgs);
    const snapshot = await inspectGoogleDriveTrashSnapshot({ fileId: args.file_id, token, request, signal: options.signal });
    const observation = googleDriveTrashObservation({ args, snapshot, commandDigest: options.command_digest,
      operationPlanBindingDigest: options.operation_plan_binding_digest });
    const review = {
      kind: "google_drive_file_trash" as const,
      operation: "google.drive.write.file.trash" as const,
      command_digest: options.command_digest,
      request_payload_digest: observation.request_payload_digest,
      target_version_digest: operationPlanDigest(observation),
      operation_plan_binding_digest: observation.operation_plan_binding_digest,
      file_id: snapshot.file.id,
      file_name: snapshot.file.name,
      parent_ids: snapshot.file.parent_ids,
      drive_id: null,
      file_version: snapshot.file.version,
      file_modified_time: snapshot.file.modified_time,
      file_mime_type: snapshot.file.mime_type,
      owner_confirmed: true as const,
      file_shared: snapshot.file.shared,
      inherited_permissions_disabled: snapshot.file.inherited_permissions_disabled,
      target_access_scope_complete: true as const,
      target_access_scope_digest: snapshot.access_scope_digest,
      permissions: snapshot.permissions,
      reversible_trash_only: true as const,
      permanently_deletes: false as const,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    return { ...review, review_digest: operationPlanDigest(review) };
  }
  if (rawArgs.operation === "permissions.create") {
    const args = normalizeGoogleDrivePermissionCreateArguments(rawArgs);
    const snapshot = await inspectGoogleDrivePermissionCreateSnapshot({ args, token, request, signal: options.signal });
    const observation = googleDrivePermissionCreateObservation({ args, snapshot,
      commandDigest: options.command_digest, operationPlanBindingDigest: options.operation_plan_binding_digest });
    const review = {
      kind: "google_drive_permission_create" as const,
      operation: "google.drive.write.permissions.create" as const,
      command_digest: options.command_digest,
      request_payload_digest: observation.request_payload_digest,
      target_version_digest: operationPlanDigest(observation),
      operation_plan_binding_digest: observation.operation_plan_binding_digest,
      file_id: snapshot.file.id,
      file_name: snapshot.file.name,
      parent_ids: snapshot.file.parent_ids,
      drive_id: snapshot.file.drive_id,
      file_version: snapshot.file.version,
      file_modified_time: snapshot.file.modified_time,
      file_mime_type: snapshot.file.mime_type,
      file_shared: snapshot.file.shared,
      inherited_permissions_disabled: snapshot.file.inherited_permissions_disabled,
      target_access_scope_complete: true as const,
      target_access_scope_digest: snapshot.access_scope_digest,
      permissions: snapshot.permissions,
      recipient_email: args.email_address,
      recipient_role: args.role,
      notification_email_sent: false as const,
      ownership_transfer: false as const,
      used_for_authority: false as const,
      may_execute: false as const,
    };
    return { ...review, review_digest: operationPlanDigest(review) };
  }
  if (rawArgs.operation === "file.update") {
    const args = normalizeGoogleDriveUpdateArguments(rawArgs);
    const snapshot = await inspectGoogleDriveUpdateSnapshot({ fileId: args.file_id,
      maxContentBytes: args.max_content_bytes, token, request, signal: options.signal });
    const observation = googleDriveUpdateObservation({ args, snapshot, commandDigest: options.command_digest,
      operationPlanBindingDigest: options.operation_plan_binding_digest });
    const review = {
      kind: "google_drive_file_update" as const,
      operation: "google.drive.write.file.update" as const,
      command_digest: options.command_digest,
      request_payload_digest: observation.request_payload_digest,
      target_version_digest: operationPlanDigest(observation),
      operation_plan_binding_digest: observation.operation_plan_binding_digest,
      file_id: snapshot.file.id,
      file_name: snapshot.file.name,
      parent_ids: snapshot.file.parent_ids,
      drive_id: snapshot.file.drive_id,
      file_version: snapshot.file.version,
      file_modified_time: snapshot.file.modified_time,
      file_shared: snapshot.file.shared,
      inherited_permissions_disabled: snapshot.file.inherited_permissions_disabled,
      file_mime_type: snapshot.file.mime_type,
      target_access_scope_complete: true as const,
      target_access_scope_digest: snapshot.access_scope_digest,
      permissions: snapshot.permissions,
      current_content_digest: snapshot.current_content_digest,
      current_content: snapshot.current_content,
      current_content_bytes: snapshot.current_content_bytes,
      replacement_content: args.content,
      replacement_content_bytes: Buffer.byteLength(args.content, "utf8"),
      used_for_authority: false as const,
      may_execute: false as const,
    };
    return { ...review, review_digest: operationPlanDigest(review) };
  }
  const args = normalizeGoogleDriveCreateArguments(rawArgs);
  const snapshot = await inspectGoogleDriveFolderScope({ parentId: args.parent_id, name: args.name,
    token, request, signal: options.signal });
  const observation = googleDriveCreateObservation({ args, snapshot, commandDigest: options.command_digest,
    operationPlanBindingDigest: options.operation_plan_binding_digest });
  const review = {
    kind: "google_drive_file_create" as const,
    operation: "google.drive.write.file.create" as const,
    command_digest: options.command_digest,
    request_payload_digest: observation.request_payload_digest,
    target_version_digest: operationPlanDigest(observation),
    operation_plan_binding_digest: observation.operation_plan_binding_digest,
    parent_folder_id: snapshot.folder.id,
    parent_folder_name: snapshot.folder.name,
    parent_folder_drive_id: snapshot.folder.drive_id,
    parent_folder_version: snapshot.folder.version,
    parent_folder_modified_time: snapshot.folder.modified_time,
    parent_folder_shared: snapshot.folder.shared,
    parent_inherited_permissions_disabled: snapshot.folder.inherited_permissions_disabled,
    parent_access_scope_complete: true as const,
    parent_access_scope_digest: snapshot.access_scope_digest,
    target_name_absent: true as const,
    permissions: snapshot.permissions,
    name: args.name,
    mime_type: args.mime_type,
    content: args.content,
    content_bytes: Buffer.byteLength(args.content, "utf8"),
    used_for_authority: false as const,
    may_execute: false as const,
  };
  return { ...review, review_digest: operationPlanDigest(review) };
}

async function verifyGoogleDriveWriteReadback(input: {
  args: Record<string, unknown>;
  operation: string;
  fileId: string;
  content: string | undefined;
  expectedMimeType: string | undefined;
  expectedUpdateMetadata?: GoogleDriveUpdateFileMetadata;
  token: string;
  request: (target: GoogleWriteTarget, signal?: AbortSignal) => Promise<GoogleWriteResponse>;
  maxContentBytes: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const fail = (reason: string): never => {
    throw new Error(`google.drive.write readback ${reason}; mutation_sent=true; mutation_status=verification_failed; retry=false`);
  };
  const metadataPath = `/drive/v3/files/${encodeURIComponent(input.fileId)}?${new URLSearchParams({
    supportsAllDrives: "true",
    fields: DRIVE_FIELDS,
  })}`;
  let metadataResponse: GoogleWriteResponse;
  try {
    assertToolExecutionNotCancelled(input.signal, "google.drive.write readback");
    metadataResponse = await input.request({
      service: "drive",
      hostname: "www.googleapis.com",
      path: metadataPath,
      method: "GET",
      maxBytes: 16_384,
      token: input.token,
    }, input.signal);
  } catch {
    return fail("metadata request failed");
  }
  if (!metadataResponse.ok || metadataResponse.truncated) return fail("metadata unavailable or truncated");
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataResponse.body) as unknown;
  } catch {
    return fail("metadata was not valid JSON");
  }
  if (!isRecord(metadata) || metadata.id !== input.fileId || metadata.trashed !== false) {
    return fail("metadata identity or state did not match");
  }

  const expectedName = stringArg(input.args, "name", input.operation === "file.create");
  if (expectedName !== undefined && metadata.name !== expectedName) return fail("name did not match");
  if (input.expectedMimeType !== undefined && metadata.mimeType !== input.expectedMimeType) {
    return fail("MIME type did not match");
  }
  if (input.expectedUpdateMetadata) {
    const expected = input.expectedUpdateMetadata;
    const parents = Array.isArray(metadata.parents) && metadata.parents.every((parent) => typeof parent === "string")
      ? (metadata.parents as string[]).slice().sort() : null;
    if (metadata.name !== expected.name || metadata.mimeType !== expected.mime_type ||
        !parents || operationPlanDigest(parents) !== operationPlanDigest(expected.parent_ids) ||
        (metadata.driveId ?? null) !== expected.drive_id) {
      return fail("target metadata changed during content update");
    }
  }
  const expectedParentId = stringArg(input.args, "parent_id", false);
  if (expectedParentId !== undefined &&
      (!Array.isArray(metadata.parents) || !metadata.parents.includes(expectedParentId))) {
    return fail("parent folder did not match");
  }

  let contentDigest: string | undefined;
  if (input.content !== undefined) {
    const contentPath = `/drive/v3/files/${encodeURIComponent(input.fileId)}?${new URLSearchParams({
      alt: "media",
      supportsAllDrives: "true",
    })}`;
    let contentResponse: GoogleWriteResponse;
    try {
      assertToolExecutionNotCancelled(input.signal, "google.drive.write content readback");
      contentResponse = await input.request({
        service: "drive",
        hostname: "www.googleapis.com",
        path: contentPath,
        method: "GET",
        maxBytes: input.maxContentBytes,
        token: input.token,
      }, input.signal);
    } catch {
      return fail("content request failed");
    }
    if (!contentResponse.ok || contentResponse.truncated || contentResponse.body_utf8_valid === false ||
        contentResponse.body !== input.content) {
      return fail("content did not match or exceeded the readback limit");
    }
    contentDigest = sha256String(contentResponse.body);
  }

  const observed = {
    file_id: input.fileId,
    name: typeof metadata.name === "string" ? metadata.name : null,
    mime_type: typeof metadata.mimeType === "string" ? metadata.mimeType : null,
    parent_ids: Array.isArray(metadata.parents) && metadata.parents.every((parent) => typeof parent === "string")
      ? metadata.parents : null,
    drive_id: typeof metadata.driveId === "string" ? metadata.driveId : null,
    version: typeof metadata.version === "string" ? metadata.version : null,
    head_revision_id: typeof metadata.headRevisionId === "string" ? metadata.headRevisionId : null,
    shared: typeof metadata.shared === "boolean" ? metadata.shared : null,
    trashed: typeof metadata.trashed === "boolean" ? metadata.trashed : null,
    metadata_verified: true,
    content_verified: input.content !== undefined,
    ...(contentDigest ? { content_digest: contentDigest } : {}),
  };
  return { ...observed, verification_digest: sha256Hex(observed) };
}

async function invokeGoogleDriveFileUpdate(args: Record<string, unknown>, opts: GoogleWriteOptions): Promise<unknown> {
  const updateArgs = normalizeGoogleDriveUpdateArguments(args);
  if (!opts.target_version_observation || !opts.command_digest || !/^[a-f0-9]{64}$/.test(opts.command_digest)) {
    throw new Error("google.drive.write file.update requires an approved Operation Plan command; mutation_sent=false");
  }
  const expectedObservation = assertGoogleDriveWriteTargetVersion(args, opts.target_version_observation,
    opts.command_digest, opts.target_version_observation.operation_plan_binding_digest);
  if (!("file_id" in expectedObservation) || expectedObservation.operation !== "file.update") {
    throw new Error("google.drive.write file.update target observation has the wrong operation; mutation_sent=false");
  }
  const token = googleToken(opts.env ?? process.env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const currentSnapshot = await inspectGoogleDriveUpdateSnapshot({ fileId: updateArgs.file_id,
    maxContentBytes: updateArgs.max_content_bytes, token, request, signal: opts.signal });
  const currentObservation = googleDriveUpdateObservation({ args: updateArgs, snapshot: currentSnapshot,
    commandDigest: expectedObservation.command_digest,
    operationPlanBindingDigest: expectedObservation.operation_plan_binding_digest });
  if (operationPlanDigest(currentObservation) !== operationPlanDigest(expectedObservation)) {
    throw new Error("google.drive.write update target or prior content changed after owner review; mutation_sent=false");
  }

  const multipart = multipartBody({}, updateArgs.content, updateArgs.mime_type);
  const path = `/upload/drive/v3/files/${encodeURIComponent(updateArgs.file_id)}?${new URLSearchParams({
    uploadType: "multipart",
    supportsAllDrives: "true",
    fields: DRIVE_FIELDS,
  })}`;
  const target: GoogleWriteTarget = {
    service: "drive",
    hostname: "www.googleapis.com",
    path,
    method: "PATCH",
    maxBytes: updateArgs.max_bytes,
    token,
    body: multipart.body,
    contentType: multipart.contentType,
    idempotency_key: opts.idempotency_key,
    command_digest: opts.command_digest,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.drive.write file.update");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.drive.write", response);
  if (response.truncated) {
    throw new Error("google.drive.write update response truncated; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let responseData: unknown;
  try { responseData = JSON.parse(response.body) as unknown; }
  catch {
    throw new Error("google.drive.write update response was not valid JSON; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  if (!isRecord(responseData) || responseData.id !== updateArgs.file_id) {
    throw new Error("google.drive.write update response identity did not match; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  const verification = await verifyGoogleDriveWriteReadback({
    args,
    operation: "file.update",
    fileId: updateArgs.file_id,
    content: updateArgs.content,
    expectedMimeType: updateArgs.mime_type,
    expectedUpdateMetadata: currentSnapshot.file,
    token,
    request,
    maxContentBytes: updateArgs.max_content_bytes + 1,
    signal: opts.signal,
  });
  return mutationResult("google.drive.write", "drive", "file.update", target, {
    ...response,
    body: JSON.stringify({ id: updateArgs.file_id }),
  }, { verification });
}

async function invokeGoogleDriveFileTrash(rawArgs: Record<string, unknown>, opts: GoogleWriteOptions): Promise<unknown> {
  const args = normalizeGoogleDriveTrashArguments(rawArgs);
  if (!opts.target_version_observation ||
      opts.target_version_observation.schema_version !== "blue-tanuki.google-drive-trash-target-version.v1" ||
      typeof opts.idempotency_key !== "string" || !/^[a-f0-9]{64}$/.test(opts.idempotency_key) ||
      typeof opts.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(opts.command_digest)) {
    throw new Error("google.drive.write file.trash requires approved command and target bindings; mutation_sent=false");
  }
  const expectedObservation = assertGoogleDriveWriteTargetVersion(rawArgs, opts.target_version_observation,
    opts.command_digest, opts.target_version_observation.operation_plan_binding_digest);
  if (expectedObservation.schema_version !== "blue-tanuki.google-drive-trash-target-version.v1" ||
      expectedObservation.owner_confirmed !== true || expectedObservation.reversible_trash_only !== true) {
    throw new Error("google.drive.write file.trash target is not an owner-confirmed reversible trash operation; mutation_sent=false");
  }
  const token = googleToken(opts.env ?? process.env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const currentSnapshot = await inspectGoogleDriveTrashSnapshot({ fileId: args.file_id, token, request, signal: opts.signal });
  const currentObservation = googleDriveTrashObservation({ args, snapshot: currentSnapshot,
    commandDigest: expectedObservation.command_digest,
    operationPlanBindingDigest: expectedObservation.operation_plan_binding_digest });
  if (operationPlanDigest(currentObservation) !== operationPlanDigest(expectedObservation)) {
    throw new Error("google.drive.write file.trash target or access scope changed after owner review; mutation_sent=false");
  }

  const path = `/drive/v3/files/${encodeURIComponent(args.file_id)}?${new URLSearchParams({
    supportsAllDrives: "true",
    fields: "id,trashed",
  })}`;
  const target: GoogleWriteTarget = {
    service: "drive",
    hostname: "www.googleapis.com",
    path,
    method: "PATCH",
    maxBytes: 16_384,
    token,
    body: JSON.stringify({ trashed: true }),
    contentType: "application/json; charset=UTF-8",
    idempotency_key: opts.idempotency_key,
    command_digest: opts.command_digest,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.drive.write file.trash");
  let response: GoogleWriteResponse;
  try {
    response = await request(target, opts.signal);
  } catch {
    throw new Error("google.drive.write file.trash result is uncertain; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  if (!response.ok || response.truncated) {
    throw new Error("google.drive.write file.trash response was unavailable or truncated; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let responseData: unknown;
  try { responseData = JSON.parse(response.body) as unknown; }
  catch {
    throw new Error("google.drive.write file.trash response was invalid; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  if (!isRecord(responseData) || responseData.id !== args.file_id || responseData.trashed !== true) {
    throw new Error("google.drive.write file.trash response did not confirm the target; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }

  let readback: GoogleWriteResponse;
  try {
    const readbackPath = `/drive/v3/files/${encodeURIComponent(args.file_id)}?${new URLSearchParams({
      supportsAllDrives: "true",
      fields: "id,name,mimeType,parents,driveId,ownedByMe,trashed",
    })}`;
    readback = await request({ service: "drive", hostname: "www.googleapis.com", path: readbackPath,
      method: "GET", maxBytes: 16_384, token }, opts.signal);
  } catch {
    throw new Error("google.drive.write file.trash readback is unavailable; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let readbackData: unknown;
  try { readbackData = JSON.parse(readback.body) as unknown; }
  catch {
    throw new Error("google.drive.write file.trash readback is invalid; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  const readbackParents = isRecord(readbackData) && Array.isArray(readbackData.parents) &&
    readbackData.parents.every((parent) => typeof parent === "string")
    ? [...readbackData.parents].sort() : null;
  if (!readback.ok || readback.truncated || !isRecord(readbackData) || readbackData.id !== args.file_id ||
      readbackData.name !== currentSnapshot.file.name || readbackData.mimeType !== "text/plain" ||
      readbackData.trashed !== true || readbackData.ownedByMe !== true || readbackData.driveId != null ||
      !readbackParents || operationPlanDigest(readbackParents) !== operationPlanDigest(currentSnapshot.file.parent_ids)) {
    throw new Error("google.drive.write file.trash readback did not confirm the exact owned My Drive file; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  return mutationResult("google.drive.write", "drive", "file.trash", target, {
    ...response,
    body: JSON.stringify({ id: args.file_id }),
  }, { verification: {
    status: "confirmed",
    target_identity_digest: googleDriveTrashTargetIdentityDigest(args.file_id),
    file_trashed: true,
    reversible_trash_only: true,
    permanently_deletes: false,
  } });
}

async function invokeGoogleDrivePermissionCreate(
  rawArgs: Record<string, unknown>,
  opts: GoogleWriteOptions,
): Promise<unknown> {
  const args = normalizeGoogleDrivePermissionCreateArguments(rawArgs);
  if (!opts.target_version_observation ||
      opts.target_version_observation.schema_version !== "blue-tanuki.google-drive-permission-create-target-version.v1" ||
      typeof opts.idempotency_key !== "string" || !/^[a-f0-9]{64}$/.test(opts.idempotency_key) ||
      typeof opts.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(opts.command_digest)) {
    throw new Error("google.drive.write permissions.create requires approved command and target bindings; mutation_sent=false");
  }
  const expectedObservation = assertGoogleDriveWriteTargetVersion(rawArgs, opts.target_version_observation,
    opts.command_digest, opts.target_version_observation.operation_plan_binding_digest);
  if (expectedObservation.schema_version !== "blue-tanuki.google-drive-permission-create-target-version.v1") {
    throw new Error("google.drive.write permissions.create target version did not match; mutation_sent=false");
  }
  const token = googleToken(opts.env ?? process.env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const currentSnapshot = await inspectGoogleDrivePermissionCreateSnapshot({ args, token, request, signal: opts.signal });
  const currentObservation = googleDrivePermissionCreateObservation({ args, snapshot: currentSnapshot,
    commandDigest: expectedObservation.command_digest,
    operationPlanBindingDigest: expectedObservation.operation_plan_binding_digest });
  if (operationPlanDigest(currentObservation) !== operationPlanDigest(expectedObservation)) {
    throw new Error("google.drive.write permission target or access scope changed after owner review; mutation_sent=false");
  }

  const path = `/drive/v3/files/${encodeURIComponent(args.file_id)}/permissions?${new URLSearchParams({
    supportsAllDrives: "true",
    sendNotificationEmail: "false",
    fields: "id,type,emailAddress,role",
  })}`;
  const target: GoogleWriteTarget = {
    service: "drive",
    hostname: "www.googleapis.com",
    path,
    method: "POST",
    maxBytes: 16_384,
    token,
    body: JSON.stringify({ type: "user", emailAddress: args.email_address, role: args.role }),
    contentType: "application/json; charset=UTF-8",
    idempotency_key: opts.idempotency_key,
    command_digest: opts.command_digest,
  };
  assertToolExecutionNotCancelled(opts.signal, "google.drive.write permissions.create");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.drive.write", response);
  if (response.truncated) {
    throw new Error("google.drive.write permissions.create response truncated; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let responseData: unknown;
  try { responseData = JSON.parse(response.body) as unknown; }
  catch {
    throw new Error("google.drive.write permissions.create response was not valid JSON; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  if (!isRecord(responseData) || typeof responseData.id !== "string" || responseData.id.length === 0 ||
      responseData.type !== "user" || typeof responseData.emailAddress !== "string" ||
      responseData.emailAddress.toLowerCase() !== args.email_address.toLowerCase() || responseData.role !== args.role) {
    throw new Error("google.drive.write permissions.create response did not match the approved permission; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let permissionReadback: GoogleWriteResponse;
  try {
    const permissionPath = `/drive/v3/files/${encodeURIComponent(args.file_id)}/permissions/${encodeURIComponent(responseData.id)}?${new URLSearchParams({
      supportsAllDrives: "true",
      fields: "id,type,emailAddress,role",
    })}`;
    permissionReadback = await request({ service: "drive", hostname: "www.googleapis.com", path: permissionPath,
      method: "GET", maxBytes: 8_192, token }, opts.signal);
  } catch {
    throw new Error("google.drive.write permissions.create permission-ID readback unavailable; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let readbackData: unknown;
  try { readbackData = JSON.parse(permissionReadback.body) as unknown; }
  catch {
    throw new Error("google.drive.write permissions.create permission-ID readback invalid; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  if (!permissionReadback.ok || permissionReadback.truncated || !isRecord(readbackData) ||
      readbackData.id !== responseData.id || readbackData.type !== "user" ||
      typeof readbackData.emailAddress !== "string" ||
      readbackData.emailAddress.toLowerCase() !== args.email_address.toLowerCase() || readbackData.role !== args.role) {
    throw new Error("google.drive.write permissions.create permission-ID readback did not match the approved permission; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let afterPermissions: readonly GoogleDrivePermissionReview[];
  let afterFile: GoogleDriveUpdateFileMetadata;
  try {
    afterPermissions = await readGoogleDrivePermissionScopePass({ folderId: args.file_id,
      token, request, signal: opts.signal });
    afterFile = await readGoogleDriveUpdateFileMetadata({ fileId: args.file_id, token, request, signal: opts.signal });
  } catch {
    throw new Error("google.drive.write permissions.create readback unavailable; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  const beforePermissionDigests = new Set(currentSnapshot.permissions.map((permission) => operationPlanDigest(permission)));
  const beforePermissionsPreserved = [...beforePermissionDigests].every((digest) =>
    afterPermissions.some((permission) => operationPlanDigest(permission) === digest));
  const grantedPermissions = afterPermissions.filter((permission) => permission.type === "user" &&
    permission.email_address?.toLowerCase() === args.email_address.toLowerCase() && !permission.deleted);
  if (!beforePermissionsPreserved || grantedPermissions.length !== 1 || grantedPermissions[0]?.role !== args.role ||
      afterFile.id !== currentSnapshot.file.id || afterFile.name !== currentSnapshot.file.name ||
      afterFile.mime_type !== currentSnapshot.file.mime_type ||
      operationPlanDigest(afterFile.parent_ids) !== operationPlanDigest(currentSnapshot.file.parent_ids) ||
      afterFile.drive_id !== currentSnapshot.file.drive_id) {
    throw new Error("google.drive.write permissions.create readback did not confirm the approved target and permission; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  return mutationResult("google.drive.write", "drive", "permissions.create", target, {
    ...response,
    body: JSON.stringify({ id: responseData.id }),
  }, { verification: {
    status: "confirmed",
    target_identity_digest: googleDrivePermissionCreateTargetIdentityDigest(args.file_id, args.email_address),
    permission_role: args.role,
    notification_email_sent: false,
    access_scope_digest: operationPlanDigest(afterPermissions),
  } });
}

export async function invokeGoogleDriveWrite(
  args: Record<string, unknown>,
  opts: GoogleWriteOptions = {},
): Promise<unknown> {
  if (args.operation === "file.trash") {
    return await invokeGoogleDriveFileTrash(args, opts);
  }
  if (args.operation === "permissions.create") {
    return await invokeGoogleDrivePermissionCreate(args, opts);
  }
  if (args.operation === "file.update") {
    return await invokeGoogleDriveFileUpdate(args, opts);
  }
  const createArgs = normalizeGoogleDriveCreateArguments(args);
  const operation = createArgs.operation;
  if (!opts.target_version_observation) {
    throw new Error("google.drive.write requires a reviewed Operation Plan target version; mutation_sent=false");
  }
  const expectedObservation = assertGoogleDriveWriteTargetVersion(args, opts.target_version_observation,
    opts.target_version_observation.command_digest, opts.target_version_observation.operation_plan_binding_digest);
  const maxBytes = createArgs.max_bytes;
  const maxContentBytes = createArgs.max_content_bytes;
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.write");
  const request = opts.request ?? defaultGoogleWriteRequest;
  const mimeType = createArgs.mime_type;
  const content = createArgs.content;
  const expectedMimeType = createArgs.mime_type;
  const multipart = multipartBody(driveMetadata(args, true), content, mimeType);
  const path = `/upload/drive/v3/files?${new URLSearchParams({
    uploadType: "multipart",
    supportsAllDrives: "true",
    fields: DRIVE_FIELDS,
  })}`;

  const target = {
    service: "drive" as const,
    hostname: "www.googleapis.com" as const,
    path,
    method: "POST" as const,
    maxBytes,
    token,
    body: multipart.body,
    contentType: multipart.contentType,
    idempotency_key: opts.idempotency_key,
    command_digest: opts.command_digest,
  };
  const currentSnapshot = await inspectGoogleDriveFolderScope({ parentId: createArgs.parent_id,
    name: createArgs.name, token, request, signal: opts.signal });
  const currentObservation = googleDriveCreateObservation({ args: createArgs, snapshot: currentSnapshot,
    commandDigest: expectedObservation.command_digest,
    operationPlanBindingDigest: expectedObservation.operation_plan_binding_digest });
  if (operationPlanDigest(currentObservation) !== operationPlanDigest(expectedObservation)) {
    throw new Error("google.drive.write parent or target changed after owner review; mutation_sent=false");
  }
  assertToolExecutionNotCancelled(opts.signal, "google.drive.write");
  const response = await request(target, opts.signal);
  if (!response.ok) throw googleWriteResponseError("google.drive.write", response);
  if (response.truncated) {
    throw new Error("google.drive.write write response truncated; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  let responseData: unknown;
  try {
    responseData = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("google.drive.write response was not valid JSON after creation; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  const fileId = isRecord(responseData) && typeof responseData.id === "string" ? responseData.id : null;
  if (!fileId || fileId.length > 512) {
    throw new Error("google.drive.write response omitted a usable file identity; mutation_sent=true; mutation_status=verification_failed; retry=false");
  }
  const verification = await verifyGoogleDriveWriteReadback({
    args,
    operation,
    fileId,
    content,
    expectedMimeType,
    token,
    request,
    maxContentBytes,
    signal: opts.signal,
  });
  return mutationResult("google.drive.write", "drive", operation, target, {
    ...response,
    body: JSON.stringify({ id: fileId }),
  }, { verification });
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
    async inspect_content_review(args, reviewOptions = {}): Promise<ToolContentReview> {
      const operation = assertSupportedGmailWriteArguments(args);
      if (operation === "draft.send") {
        const snapshot = await readGmailDraftSnapshot(args, {
          ...options,
          ...(reviewOptions.env ? { env: { ...reviewOptions.env } } : {}),
        });
        return snapshot.content_review;
      }
      const commandDigest = reviewOptions.command_digest;
      if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest)) {
        throw new Error("gmail.write content review requires the exact command digest; content_review=unavailable");
      }
      const effectiveOptions: GoogleWriteOptions = {
        ...options,
        ...(reviewOptions.env ? { env: { ...reviewOptions.env } } : {}),
      };
      const resolved = await resolveGmailWriteAttachments(args, effectiveOptions);
      const requestPayloadDigest = gmailWriteRequestPayloadDigest(args);
      const attachments: GmailAttachmentContentReview[] = resolved.map((attachment) => ({
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        content_sha256: attachment.content_sha256,
        used_for_authority: false,
      }));
      const reviewDigest = operationPlanDigest({
        schema_version: "blue-tanuki.gmail-write-content-review.v2",
        command_digest: commandDigest,
        request_payload_digest: requestPayloadDigest,
        attachment_content_digests: attachments.map((attachment) => attachment.content_sha256),
      });
      const review: GmailWriteContentReview = {
        kind: "gmail_write_content",
        operation: operation === "draft.create" ? "gmail.write.draft.create" : "gmail.write.message.send",
        to: safeAddressList(args, "to", true)!,
        ...(safeAddressList(args, "cc") ? { cc: safeAddressList(args, "cc") } : {}),
        ...(safeAddressList(args, "bcc") ? { bcc: safeAddressList(args, "bcc") } : {}),
        ...(safeAddressList(args, "reply_to") ? { reply_to: safeAddressList(args, "reply_to") } : {}),
        ...(stringArg(args, "from", false) ? { from: stringArg(args, "from", false) } : {}),
        subject: stringArg(args, "subject")!,
        body_text: stringArg(args, "body_text", false) ?? stringArg(args, "body", false) ?? "",
        ...(attachments.length > 0 ? { attachments } : {}),
        request_payload_digest: requestPayloadDigest,
        command_digest: commandDigest,
        review_digest: reviewDigest,
        used_for_authority: false,
        may_execute: false,
      };
      return review;
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

export function createGoogleCalendarWriteTool(
  options: Omit<GoogleWriteOptions, "signal" | "idempotency_key" | "command_digest"> = {},
): Tool {
  const resolverOptions = (env?: Readonly<Record<string, string | undefined>>): GoogleWriteOptions => ({
    ...options,
    ...(env ? { env: { ...env } } : {}),
  });
  return {
    name: "google.calendar.write",
    description: "Create one non-recurring event after a current freebusy recheck. Explicit attendees on event.create produce invitation emails. event.invite adds up to 20 explicit attendees to a confirmed primary-calendar event, series, or exact occurrence owned by this account while preserving the complete current attendee array and writable RSVP fields. Because Calendar PATCH replaces attendee arrays and sendUpdates=all notifies all guests, no-store Owner review shows retained attendees, new invitees, and every notification recipient before L3 approval. The exact recurrence scope and event version are rechecked before the write. Update the summary or delete a confirmed event as separate operations. Calendar data is non-authoritative.",
    required_capabilities: requireToolOperationDescriptor("google.calendar.write").required_capabilities,
    async inspect_target_version(args, inspectOptions = {}): Promise<GoogleCalendarWriteTargetVersionObservation> {
      const commandDigest = inspectOptions.command_digest;
      if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest)) {
        throw new Error("google.calendar.write target resolver requires an exact HDS command digest");
      }
      if (args.operation === "event.update" || args.operation === "event.delete" || args.operation === "event.invite") {
        const plan = args.operation === "event.update" ? calendarEventUpdatePlan(args)
          : args.operation === "event.delete" ? calendarEventDeletePlan(args) : calendarEventInvitePlan(args);
        const current = await recheckCalendarEventTarget(plan, resolverOptions(inspectOptions.env));
        return GoogleCalendarWriteTargetVersionObservationSchema.parse({
          schema_version: "blue-tanuki.google-calendar-write-target-version.v3",
          operation: plan.operation,
          target_scope: plan.target_scope,
          target_identity_digest: plan.target_identity_digest,
          request_payload_digest: plan.request_payload_digest,
          calendar_id: plan.calendar_id,
          event_id: plan.event_id,
          event_state_digest: current.observation.event_state_digest,
          event_etag_digest: current.observation.event_etag_digest,
          command_digest: commandDigest,
          ...(inspectOptions.operation_plan_binding_digest
            ? { operation_plan_binding_digest: inspectOptions.operation_plan_binding_digest } : {}),
          used_for_authority: false,
          may_execute: false,
        });
      }
      const plan = calendarEventCreatePlan(args);
      const current = await recheckCalendarAvailability(args, plan, resolverOptions(inspectOptions.env));
      return GoogleCalendarWriteTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.google-calendar-write-target-version.v3",
        operation: "event.create",
        target_identity_digest: plan.target_identity_digest,
        request_payload_digest: plan.request_payload_digest,
        availability_observation_digest: plan.source_observation.observation_digest,
        availability_result_digest: current.result_digest,
        availability_observed_at: current.observed_at,
        availability_window_start: current.time_min,
        availability_window_end: current.time_max,
        event_start: plan.event_start,
        event_end: plan.event_end,
        command_digest: commandDigest,
        ...(inspectOptions.operation_plan_binding_digest
          ? { operation_plan_binding_digest: inspectOptions.operation_plan_binding_digest } : {}),
        used_for_authority: false,
        may_execute: false,
      });
    },
    async inspect_content_review(args, inspectOptions = {}): Promise<GoogleCalendarEventCreateContentReview | GoogleCalendarEventUpdateContentReview | GoogleCalendarEventDeleteContentReview | GoogleCalendarEventInviteContentReview> {
      const commandDigest = inspectOptions.command_digest;
      if (!commandDigest || !/^[a-f0-9]{64}$/.test(commandDigest)) {
        throw new Error("google.calendar.write content review requires an exact HDS command digest");
      }
      if (args.operation === "event.update") {
        const plan = calendarEventUpdatePlan(args);
        const current = await recheckCalendarEventTarget(plan, resolverOptions(inspectOptions.env));
        return calendarUpdateContentReview(plan, current.observation, commandDigest);
      }
      if (args.operation === "event.delete") {
        const plan = calendarEventDeletePlan(args);
        const current = await recheckCalendarEventTarget(plan, resolverOptions(inspectOptions.env));
        return calendarDeleteContentReview(plan, current.observation, commandDigest);
      }
      if (args.operation === "event.invite") {
        const plan = calendarEventInvitePlan(args);
        const current = await recheckCalendarEventTarget(plan, resolverOptions(inspectOptions.env));
        return calendarInviteContentReview(plan, current, commandDigest);
      }
      const plan = calendarEventCreatePlan(args);
      const current = await recheckCalendarAvailability(args, plan, resolverOptions(inspectOptions.env));
      return calendarCreateContentReview(args, plan, current, commandDigest);
    },
    async invoke(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
      if (typeof context.idempotency_key !== "string" || !/^[a-f0-9]{64}$/.test(context.idempotency_key) ||
          typeof context.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(context.command_digest)) {
        throw new Error("google.calendar.write requires an approved Executor identity; mutation_sent=false");
      }
      const rawObservation = context.target_version_observation;
      if (!rawObservation || rawObservation.schema_version !== "blue-tanuki.google-calendar-write-target-version.v3") {
        throw new Error("google.calendar.write requires a bound target version; mutation_sent=false");
      }
      const observation = assertGoogleCalendarWriteTargetVersion(args, rawObservation, context.command_digest,
        rawObservation.operation_plan_binding_digest);
      if ((args.operation === "event.update" && observation.operation === "event.update") ||
          (args.operation === "event.delete" && observation.operation === "event.delete") ||
          (args.operation === "event.invite" && observation.operation === "event.invite")) {
        const plan = args.operation === "event.update" ? calendarEventUpdatePlan(args)
          : args.operation === "event.delete" ? calendarEventDeletePlan(args) : calendarEventInvitePlan(args);
        const writeOptions = { ...options, signal: context.signal };
        const current = await recheckCalendarEventTarget(plan, writeOptions);
        if (current.observation.event_state_digest !== observation.event_state_digest ||
            current.observation.event_etag_digest !== observation.event_etag_digest) {
          throw new Error("google.calendar.write event changed after approval; mutation_sent=false");
        }
        return plan.operation === "event.update"
          ? await invokeGoogleCalendarEventUpdate(args, writeOptions, plan, current)
          : plan.operation === "event.delete"
            ? await invokeGoogleCalendarEventDelete(plan, writeOptions, current)
            : await invokeGoogleCalendarEventInvite(plan, writeOptions, current);
      }
      if (observation.operation !== "event.create") {
        throw new Error("google.calendar.write target version operation does not match the command; mutation_sent=false");
      }
      const plan = calendarEventCreatePlan(args);
      const current = await recheckCalendarAvailability(args, plan, {
        ...options,
        signal: context.signal,
      });
      if (current.result_digest !== observation.availability_result_digest) {
        throw new Error("google.calendar.write freebusy result changed before write; mutation_sent=false");
      }
      return await invokeGoogleCalendarWrite(args, {
        ...options,
        idempotency_key: context.idempotency_key,
        command_digest: context.command_digest,
        signal: context.signal,
        calendar_availability_observation_digest: observation.availability_observation_digest,
        calendar_availability_result_digest: current.result_digest,
        calendar_availability_observed_at: current.observed_at,
      });
    },
  };
}

export const googleCalendarWriteTool: Tool = createGoogleCalendarWriteTool();

export const googleDriveWriteTool: Tool = {
  name: "google.drive.write",
  description: "Create one bounded text file, replace one existing text/plain blob, grant one direct Drive user reader/writer access, or move one owner-owned My Drive text/plain file to reversible trash. Update, permission, and trash operations require separate current L3 review; trash never permanently deletes.",
  required_capabilities: requireToolOperationDescriptor("google.drive.write").required_capabilities,
  async inspect_target_version(args, resolverOptions = {}): Promise<GoogleDriveWriteTargetVersionObservation | GoogleDriveUpdateTargetVersionObservation |
      GoogleDrivePermissionCreateTargetVersionObservation | GoogleDriveTrashTargetVersionObservation> {
    return await inspectGoogleDriveWriteTargetVersion(args, {
      ...(resolverOptions.env ? { env: { ...resolverOptions.env } } : {}),
      ...(resolverOptions.operation_plan_binding_digest
        ? { operation_plan_binding_digest: resolverOptions.operation_plan_binding_digest } : {}),
      ...(resolverOptions.command_digest ? { command_digest: resolverOptions.command_digest } : {}),
    });
  },
  async inspect_content_review(args, resolverOptions = {}): Promise<GoogleDriveFileCreateContentReview | GoogleDriveFileUpdateContentReview |
      GoogleDrivePermissionCreateContentReview | GoogleDriveFileTrashContentReview> {
    return await inspectGoogleDriveWriteContentReview(args, {
      ...(resolverOptions.env ? { env: { ...resolverOptions.env } } : {}),
      ...(resolverOptions.operation_plan_binding_digest
        ? { operation_plan_binding_digest: resolverOptions.operation_plan_binding_digest } : {}),
      ...(resolverOptions.command_digest ? { command_digest: resolverOptions.command_digest } : {}),
    });
  },
  async invoke(args: Record<string, unknown>, context): Promise<unknown> {
    const observation = args.operation === "file.trash"
      ? GoogleDriveTrashTargetVersionObservationSchema.parse(context.target_version_observation)
      : args.operation === "file.update"
        ? GoogleDriveUpdateTargetVersionObservationSchema.parse(context.target_version_observation)
        : args.operation === "permissions.create"
          ? GoogleDrivePermissionCreateTargetVersionObservationSchema.parse(context.target_version_observation)
          : GoogleDriveWriteTargetVersionObservationSchema.parse(context.target_version_observation);
    return await invokeGoogleDriveWrite(args, { signal: context.signal,
      idempotency_key: context.idempotency_key, command_digest: context.command_digest,
      target_version_observation: observation });
  },
};
