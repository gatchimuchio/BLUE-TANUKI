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
