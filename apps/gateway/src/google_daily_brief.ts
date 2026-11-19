import type { GoogleReadService } from "@blue-tanuki/core";

type Env = Record<string, string | undefined>;

const DEFAULT_SERVICES: GoogleReadService[] = ["gmail", "calendar", "drive"];
const VALID_SERVICES = new Set<GoogleReadService>(DEFAULT_SERVICES);

export function googleDailyBriefSourceConfigured(env: Env): boolean {
  const flag = env.BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function parseGoogleServices(raw: string | undefined): GoogleReadService[] {
  if (!raw || raw.trim().length === 0) return [...DEFAULT_SERVICES];
  const services = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (services.length === 0) return [...DEFAULT_SERVICES];
  for (const service of services) {
    if (!VALID_SERVICES.has(service as GoogleReadService)) {
      throw new Error(
        `BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES contains unsupported service: ${service}`,
      );
    }
  }
  return services as GoogleReadService[];
}

export const DAILY_BRIEF_MAX_RESULTS = 5;

export function dailyBriefReadSpec(service: GoogleReadService, scheduledAtMs: number) {
  const end = new Date(scheduledAtMs).toISOString();
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(scheduledAtMs - day).toISOString();
  if (service === "gmail") {
    const endSeconds = Math.floor(scheduledAtMs / 1000);
    const startSeconds = endSeconds - day / 1000;
    const query = `after:${startSeconds} before:${endSeconds}`;
    return { tool_name: "gmail.read", api_host: "gmail.googleapis.com",
      scope: `メールのヘッダーと概要 ${new Date(startSeconds * 1000).toISOString()} 〜 ${new Date(endSeconds * 1000).toISOString()}。表示は件名と日付のみ`,
      arguments: { query, max_results: DAILY_BRIEF_MAX_RESULTS, include_attachment_metadata: false } };
  }
  if (service === "calendar") {
    const next = new Date(scheduledAtMs + day).toISOString();
    return { tool_name: "google.calendar.read", api_host: "www.googleapis.com", scope: `メインカレンダーの予定と参加者情報 ${end} 〜 ${next}。表示は件名と開始時刻のみ`,
      arguments: { calendar_id: "primary", view: "events", time_min: end, time_max: next, max_results: DAILY_BRIEF_MAX_RESULTS } };
  }
  return { tool_name: "google.drive.read", api_host: "www.googleapis.com", scope: `変更されたファイルの一覧 ${start} 〜 ${end}`,
    arguments: { query: `trashed = false and modifiedTime > '${start}' and modifiedTime <= '${end}'`,
      include_sharing: false, max_results: DAILY_BRIEF_MAX_RESULTS } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function briefText(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .trim().slice(0, 240) || undefined : undefined;
}

/** 既存アダプターの結果から、本人の一時表示に必要な項目だけを取り出す。 */
export function projectDailyBriefRead(service: GoogleReadService, scheduledAtMs: number, result: unknown) {
  const spec = dailyBriefReadSpec(service, scheduledAtMs);
  if (!isRecord(result) || result.service !== service || result.api_host !== spec.api_host || result.mode !== "read_only" ||
      result.request_status !== "ok" || result.mutation_sent !== false || result.max_results !== DAILY_BRIEF_MAX_RESULTS) return null;
  if (service === "calendar" ? (result.calendar_id !== "primary" || result.view !== "events" ||
      result.time_min !== spec.arguments.time_min || result.time_max !== spec.arguments.time_max)
    : result.query !== spec.arguments.query) return null;
  if (service === "drive" && (result.content_read !== false || result.target_mode !== "search")) return null;
  const rawItems = result[service === "gmail" ? "messages" : service === "calendar" ? "events" : "files"];
  if (!Array.isArray(rawItems) || rawItems.length > DAILY_BRIEF_MAX_RESULTS || result.result_count !== rawItems.length) return null;
  const items: { title: string; detail?: string }[] = [];
  for (const item of rawItems) {
    if (!isRecord(item)) return null;
    const title = briefText(item[service === "gmail" ? "subject" : service === "calendar" ? "summary" : "name"]) ?? "（名称なし）";
    const detail = briefText(item[service === "gmail" ? "date" : service === "calendar" ? "start" : "modified_time"]);
    items.push({ title, ...(detail ? { detail } : {}) });
  }
  const incomplete = result.truncated !== false || result.has_more_results === true || result.result_complete === false ||
    Boolean(result.next_page_token) || rawItems.some(item => isRecord(item) && item.truncated === true);
  return { service, items, incomplete, used_for_authority: false as const };
}
