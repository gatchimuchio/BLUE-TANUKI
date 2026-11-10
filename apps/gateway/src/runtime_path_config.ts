import * as path from "node:path";

export type RuntimePathEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveRuntimeSchedulesDirectory(
  env: RuntimePathEnvironment = process.env,
): string {
  const configured = env.BLUE_TANUKI_SCHEDULES_DIR?.trim();
  if (configured) return path.resolve(configured);
  const stateRoot = env.BLUE_TANUKI_STATE_ROOT?.trim() || ".blue-tanuki";
  return path.resolve(stateRoot, "schedules");
}
