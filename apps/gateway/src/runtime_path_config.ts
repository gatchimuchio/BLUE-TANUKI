import * as path from "node:path";

export type RuntimePathEnvironment = Readonly<Record<string, string | undefined>>;
export const DPAPI_SECRET_REF_PREFIX = "win32-dpapi-current-user:file:";

export function secretDirForEnvFile(envFilePath: string, env: RuntimePathEnvironment): string {
  const configured = env.BLUE_TANUKI_SECRET_DIR;
  if (configured && configured.trim().length > 0) return path.resolve(configured);
  return path.join(path.dirname(path.resolve(envFilePath)), "secrets");
}

export function dpapiSecretPathFromReference(ref: string): string {
  if (!ref.startsWith(DPAPI_SECRET_REF_PREFIX)) throw new Error("unsupported secret ref format");
  const encoded = ref.slice(DPAPI_SECRET_REF_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("unsupported secret ref format");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (!path.isAbsolute(decoded)) throw new Error("unsupported secret ref path");
  return path.resolve(decoded);
}

export function resolveRuntimeSchedulesDirectory(
  env: RuntimePathEnvironment = process.env,
): string {
  const configured = env.BLUE_TANUKI_SCHEDULES_DIR?.trim();
  if (configured) return path.resolve(configured);
  const stateRoot = env.BLUE_TANUKI_STATE_ROOT?.trim() || ".blue-tanuki";
  return path.resolve(stateRoot, "schedules");
}
