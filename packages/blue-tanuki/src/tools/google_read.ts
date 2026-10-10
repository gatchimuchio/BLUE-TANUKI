import { createHash } from "node:crypto";
import * as https from "node:https";
import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { Tool } from "./registry.js";

type Env = Record<string, string | undefined>;

export type GoogleReadService = "gmail" | "calendar" | "drive";

export interface GoogleReadTarget {
  service: GoogleReadService;
  hostname: "gmail.googleapis.com" | "www.googleapis.com";
  path: string;
  maxBytes: number;
  token: string;
}

export interface GoogleReadResponse {
  status: number;
  ok: boolean;
  content_type: string | null;
  body: string;
  truncated: boolean;
  request_id: string | null;
}

export interface GoogleReadOptions {
  env?: Env;
  now?: () => Date;
  request?: (target: GoogleReadTarget) => Promise<GoogleReadResponse>;
}

export interface GoogleDailyBriefOptions extends GoogleReadOptions {
  services?: GoogleReadService[];
  maxResults?: number;
  gmailQuery?: string;
  calendarId?: string;
  calendarDays?: number;
  driveQuery?: string;
}

export interface GmailReadMessage {
  id: string;
  thread_id: string | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  snippet: string | null;
}

export interface GoogleCalendarEvent {
  id: string;
  status: string | null;
  summary: string | null;
  start: string | null;
  end: string | null;
  html_link: string | null;
}

export interface GoogleDriveFile {
  id: string;
  name: string | null;
  mime_type: string | null;
  modified_time: string | null;
  web_view_link: string | null;
}

const GOOGLE_READ_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 128_000;
const MAX_MAX_BYTES = 512_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const DEFAULT_CALENDAR_DAYS = 1;
const MAX_CALENDAR_DAYS = 31;
const DEFAULT_GMAIL_QUERY = "newer_than:1d";
const DEFAULT_DRIVE_QUERY = "trashed=false";
const GOOGLE_BRIEF_SERVICES: GoogleReadService[] = ["gmail", "calendar", "drive"];

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

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function compactText(value: string, max: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), max);
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

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (e) {
    throw new Error(`${label} returned non-JSON response; request_status=failed; mutation_sent=false`);
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

async function defaultGoogleReadRequest(
  target: GoogleReadTarget,
): Promise<GoogleReadResponse> {
  return await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (result: GoogleReadResponse): void => {
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
        hostname: target.hostname,
        path: target.path,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${target.token}`,
          "User-Agent": `BLUE-TANUKI/0.1 ${target.service}.read`,
        },
        timeout: GOOGLE_READ_TIMEOUT_MS,
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
          `${target.service}.read timed out after ${GOOGLE_READ_TIMEOUT_MS}ms; request_status=failed; mutation_sent=false`,
        ),
      );
    });
    req.on("error", (error) => {
      if (!finished) fail(error);
    });
    req.end();
  });
}

function googleResponseError(toolName: string, response: GoogleReadResponse): Error {
  return new Error(
    `${toolName} returned HTTP ${response.status}; request_status=failed; mutation_sent=false`,
  );
}

function gmailHeader(message: Record<string, unknown>, name: string): string | null {
  const payload = message.payload;
  if (!isRecord(payload) || !Array.isArray(payload.headers)) return null;
  const found = payload.headers.find((header) => {
    if (!isRecord(header)) return false;
    return typeof header.name === "string" && header.name.toLowerCase() === name.toLowerCase();
  });
  if (!isRecord(found)) return null;
  return optionalString(found.value);
}

function gmailMessageFromJson(value: unknown): GmailReadMessage | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    thread_id: optionalString(value.threadId),
    subject: gmailHeader(value, "Subject"),
    from: gmailHeader(value, "From"),
    date: gmailHeader(value, "Date"),
    snippet: optionalString(value.snippet)
      ? compactText(optionalString(value.snippet)!, 240)
      : null,
  };
}

function gmailMessageIds(value: unknown, maxResults: number): string[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  return value.messages
    .map((message) => isRecord(message) && typeof message.id === "string" ? message.id : null)
    .filter((id): id is string => id !== null)
    .slice(0, maxResults);
}

export async function invokeGmailRead(
  args: Record<string, unknown>,
  opts: GoogleReadOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const request = opts.request ?? defaultGoogleReadRequest;
  const query = stringArg(args, "query", false) ?? DEFAULT_GMAIL_QUERY;
  const maxResults = positiveIntArg(args, "max_results", DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const token = googleToken(env, ["GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "gmail.read");
  const listPath =
    `/gmail/v1/users/me/messages?maxResults=${maxResults}` +
    `&q=${encodeURIComponent(query)}`;
  const listResponse = await request({
    service: "gmail",
    hostname: "gmail.googleapis.com",
    path: listPath,
    maxBytes,
    token,
  });
  if (!listResponse.ok) throw googleResponseError("gmail.read", listResponse);

  const listJson = parseJson(listResponse.body, "gmail.read");
  const ids = gmailMessageIds(listJson, maxResults);
  const messages: GmailReadMessage[] = [];
  let truncated = listResponse.truncated;
  for (const id of ids) {
    const path =
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
      "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date";
    const detailResponse = await request({
      service: "gmail",
      hostname: "gmail.googleapis.com",
      path,
      maxBytes,
      token,
    });
    if (!detailResponse.ok) throw googleResponseError("gmail.read", detailResponse);
    truncated = truncated || detailResponse.truncated;
    const message = gmailMessageFromJson(parseJson(detailResponse.body, "gmail.read"));
    if (message) messages.push(message);
  }

  return {
    service: "gmail",
    mode: "read_only",
    api_host: "gmail.googleapis.com",
    query,
    max_results: maxResults,
    status: listResponse.status,
    content_type: listResponse.content_type,
    truncated,
    request_status: "ok",
    mutation_sent: false,
    result_count: messages.length,
    result_digest: sha256Hex(messages),
    messages,
  };
}

function calendarTime(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return optionalString(value.dateTime) ?? optionalString(value.date);
}

function calendarEventFromJson(value: unknown): GoogleCalendarEvent | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    status: optionalString(value.status),
    summary: optionalString(value.summary),
    start: calendarTime(value.start),
    end: calendarTime(value.end),
    html_link: optionalString(value.htmlLink),
  };
}

function calendarEvents(value: unknown, maxResults: number): GoogleCalendarEvent[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items
    .map(calendarEventFromJson)
    .filter((event): event is GoogleCalendarEvent => event !== null)
    .slice(0, maxResults);
}

export async function invokeGoogleCalendarRead(
  args: Record<string, unknown>,
  opts: GoogleReadOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const request = opts.request ?? defaultGoogleReadRequest;
  const calendarId = stringArg(args, "calendar_id", false) ?? "primary";
  const maxResults = positiveIntArg(args, "max_results", DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const days = positiveIntArg(args, "days", DEFAULT_CALENDAR_DAYS, MAX_CALENDAR_DAYS);
  const timeMin = stringArg(args, "time_min", false) ?? now().toISOString();
  const timeMax =
    stringArg(args, "time_max", false) ??
    new Date(new Date(timeMin).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const token = googleToken(env, ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.calendar.read");
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
    timeMin,
    timeMax,
  });
  const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const response = await request({
    service: "calendar",
    hostname: "www.googleapis.com",
    path,
    maxBytes,
    token,
  });
  if (!response.ok) throw googleResponseError("google.calendar.read", response);
  const events = calendarEvents(parseJson(response.body, "google.calendar.read"), maxResults);
  return {
    service: "calendar",
    mode: "read_only",
    api_host: "www.googleapis.com",
    calendar_id: calendarId,
    time_min: timeMin,
    time_max: timeMax,
    max_results: maxResults,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    request_status: "ok",
    mutation_sent: false,
    result_count: events.length,
    result_digest: sha256Hex(events),
    events,
  };
}

function driveFileFromJson(value: unknown): GoogleDriveFile | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: optionalString(value.name),
    mime_type: optionalString(value.mimeType),
    modified_time: optionalString(value.modifiedTime),
    web_view_link: optionalString(value.webViewLink),
  };
}

function driveFiles(value: unknown, maxResults: number): { files: GoogleDriveFile[]; next_page_token: string | null } {
  if (!isRecord(value)) return { files: [], next_page_token: null };
  const files = Array.isArray(value.files)
    ? value.files
        .map(driveFileFromJson)
        .filter((file): file is GoogleDriveFile => file !== null)
        .slice(0, maxResults)
    : [];
  return {
    files,
    next_page_token: optionalString(value.nextPageToken),
  };
}

export async function invokeGoogleDriveRead(
  args: Record<string, unknown>,
  opts: GoogleReadOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const request = opts.request ?? defaultGoogleReadRequest;
  const query = stringArg(args, "query", false) ?? DEFAULT_DRIVE_QUERY;
  const maxResults = positiveIntArg(args, "max_results", DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const maxBytes = positiveIntArg(args, "max_bytes", DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const token = googleToken(env, ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"], "google.drive.read");
  const params = new URLSearchParams({
    pageSize: String(maxResults),
    q: query,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken",
  });
  const pageToken = stringArg(args, "page_token", false);
  if (pageToken) params.set("pageToken", pageToken);
  const path = `/drive/v3/files?${params}`;
  const response = await request({
    service: "drive",
    hostname: "www.googleapis.com",
    path,
    maxBytes,
    token,
  });
  if (!response.ok) throw googleResponseError("google.drive.read", response);
  const result = driveFiles(parseJson(response.body, "google.drive.read"), maxResults);
  return {
    service: "drive",
    mode: "read_only",
    api_host: "www.googleapis.com",
    query,
    max_results: maxResults,
    status: response.status,
    content_type: response.content_type,
    truncated: response.truncated,
    request_status: "ok",
    mutation_sent: false,
    result_count: result.files.length,
    next_page_token: result.next_page_token,
    result_digest: sha256Hex(result.files),
    files: result.files,
  };
}

function safeBriefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compactText(message.replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer [redacted]"), 220);
}

function resultRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function briefItem(value: string | null | undefined, fallback: string): string {
  const text = value ? compactText(value, 96) : "";
  return text || fallback;
}

export async function buildGoogleDailyBriefContent(
  opts: GoogleDailyBriefOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const services = opts.services?.length ? opts.services : GOOGLE_BRIEF_SERVICES;
  const maxResults = Math.min(opts.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const lines = [
    "Daily Brief",
    "source=google_read read_only=true mutation_sent=false",
  ];

  for (const service of services) {
    if (service === "gmail") {
      try {
        const result = resultRecord(await invokeGmailRead(
          {
            query: opts.gmailQuery ?? DEFAULT_GMAIL_QUERY,
            max_results: maxResults,
          },
          opts,
        ));
        const messages = Array.isArray(result.messages) ? result.messages as GmailReadMessage[] : [];
        lines.push(`Gmail: ${messages.length} message(s)`);
        for (const message of messages) {
          lines.push(`- ${briefItem(message.subject, "(no subject)")} / ${briefItem(message.from, "unknown sender")}`);
        }
      } catch (e) {
        lines.push(`Gmail: unavailable; ${safeBriefError(e)}`);
      }
      continue;
    }
    if (service === "calendar") {
      try {
        const result = resultRecord(await invokeGoogleCalendarRead(
          {
            calendar_id: opts.calendarId ?? "primary",
            days: opts.calendarDays ?? DEFAULT_CALENDAR_DAYS,
            max_results: maxResults,
          },
          opts,
        ));
        const events = Array.isArray(result.events) ? result.events as GoogleCalendarEvent[] : [];
        lines.push(`Calendar: ${events.length} event(s)`);
        for (const event of events) {
          lines.push(`- ${briefItem(event.start, "time unknown")} / ${briefItem(event.summary, "(no title)")}`);
        }
      } catch (e) {
        lines.push(`Calendar: unavailable; ${safeBriefError(e)}`);
      }
      continue;
    }
    if (service === "drive") {
      try {
        const result = resultRecord(await invokeGoogleDriveRead(
          {
            query: opts.driveQuery ?? DEFAULT_DRIVE_QUERY,
            max_results: maxResults,
          },
          opts,
        ));
        const files = Array.isArray(result.files) ? result.files as GoogleDriveFile[] : [];
        lines.push(`Drive: ${files.length} file(s)`);
        for (const file of files) {
          lines.push(`- ${briefItem(file.name, "(unnamed file)")} / ${briefItem(file.modified_time, "modified time unknown")}`);
        }
      } catch (e) {
        lines.push(`Drive: unavailable; ${safeBriefError(e)}`);
      }
    }
  }

  return lines.join("\n");
}

export const gmailReadTool: Tool = {
  name: "gmail.read",
  description: "Read a bounded Gmail metadata summary with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("gmail.read").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGmailRead(args);
  },
};

export const googleCalendarReadTool: Tool = {
  name: "google.calendar.read",
  description: "Read a bounded Google Calendar event summary with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.calendar.read").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGoogleCalendarRead(args);
  },
};

export const googleDriveReadTool: Tool = {
  name: "google.drive.read",
  description: "Read a bounded Google Drive metadata summary with an operator-provided OAuth token.",
  required_capabilities: requireToolOperationDescriptor("google.drive.read").required_capabilities,
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return await invokeGoogleDriveRead(args);
  },
};
