import { createHash } from "node:crypto";
import * as https from "node:https";
import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { Tool } from "./registry.js";

type Env = Record<string, string | undefined>;

export type GoogleWriteService = "gmail" | "calendar" | "drive";
export type GoogleWriteMethod = "POST" | "PATCH" | "DELETE";

export interface GoogleWriteTarget {
  service: GoogleWriteService;
  hostname: "gmail.googleapis.com" | "www.googleapis.com";
  path: string;
  method: GoogleWriteMethod;
  maxBytes: number;
  token: string;
  body?: string;
  contentType?: string;
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
  request?: (target: GoogleWriteTarget) => Promise<GoogleWriteResponse>;
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

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function safeHeaderValue(value: string, label: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} must not contain CR/LF header control characters; mutation_sent=false`);
  }
  return value;
}

function encodedSubject(value: string): string {
  const safe = safeHeaderValue(value, "subject");
  return /^[\x20-\x7e]*$/.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function encodedMimeMessage(args: Record<string, unknown>): string {
  const to = safeHeaderValue(stringArg(args, "to")!, "to");
  const subject = encodedSubject(stringArg(args, "subject")!);
  const bodyText = stringArg(args, "body_text", false) ?? stringArg(args, "body", false) ?? "";
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const cc = stringArg(args, "cc", false);
  if (cc) headers.splice(1, 0, `Cc: ${safeHeaderValue(cc, "cc")}`);
  const bcc = stringArg(args, "bcc", false);
  if (bcc) headers.splice(cc ? 2 : 1, 0, `Bcc: ${safeHeaderValue(bcc, "bcc")}`);
  const from = stringArg(args, "from", false);
  if (from) headers.unshift(`From: ${safeHeaderValue(from, "from")}`);
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
): Promise<unknown> {
  const operation = operationArg(args, ["draft.create", "message.send", "draft.send"]);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const env = opts.env ?? process.env;
  const token = googleToken(env, ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.write");
  const request = opts.request ?? defaultGoogleWriteRequest;

  let path: string;
  let body: Record<string, unknown>;
  if (operation === "draft.create") {
    path = "/gmail/v1/users/me/drafts";
    body = { message: { raw: encodedMimeMessage(args) } };
  } else if (operation === "message.send") {
    path = "/gmail/v1/users/me/messages/send";
    body = { raw: encodedMimeMessage(args) };
  } else {
    path = "/gmail/v1/users/me/drafts/send";
    body = { id: stringArg(args, "draft_id")! };
  }

  const target = {
    service: "gmail" as const,
    hostname: "gmail.googleapis.com" as const,
    path,
    method: "POST" as const,
    maxBytes,
    token,
    body: jsonBody(body),
  };
  const response = await request(target);
  if (!response.ok) throw googleWriteResponseError("gmail.write", response);
  return mutationResult("gmail.write", "gmail", operation, target, response);
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
  const response = await request(target);
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
  const response = await request(target);
  if (!response.ok) throw googleWriteResponseError("google.drive.write", response);
  return mutationResult("google.drive.write", "drive", operation, target, response);
}

export const gmailWriteTool: Tool = {
  name: "gmail.write",
  description: "Create Gmail drafts or send Gmail messages with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("gmail.write").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGmailWrite(args);
  },
};

export const googleCalendarWriteTool: Tool = {
  name: "google.calendar.write",
  description: "Create, update, or delete Google Calendar events with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.calendar.write").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGoogleCalendarWrite(args);
  },
};

export const googleDriveWriteTool: Tool = {
  name: "google.drive.write",
  description: "Create or update bounded Google Drive text files with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.drive.write").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGoogleDriveWrite(args);
  },
};
