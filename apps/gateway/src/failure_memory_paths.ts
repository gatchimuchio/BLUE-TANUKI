import * as path from "node:path";

export interface FailureMemoryEnvironment {
  BLUE_TANUKI_FAILURE_MEMORY_FILE?: string;
  BLUE_TANUKI_FAILURE_MEMORY_DIR?: string;
  BLUE_TANUKI_SESSION_DIR?: string;
  BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE?: string;
}

/** Resolve the one FailureMemory file shared by runtime, verification, and recovery views. */
export function resolveFailureMemoryFilePath(env: FailureMemoryEnvironment): string | undefined {
  const file = env.BLUE_TANUKI_FAILURE_MEMORY_FILE?.trim();
  if (file) return path.resolve(file);

  const dir = env.BLUE_TANUKI_FAILURE_MEMORY_DIR?.trim();
  if (dir) return path.join(path.resolve(dir), "failure-memory.json");

  // Older Setup env files already provide a durable session directory. Keep their
  // failure memory under that managed data root until Setup writes an explicit path.
  const sessionDir = env.BLUE_TANUKI_SESSION_DIR?.trim();
  if (sessionDir) return path.join(path.resolve(sessionDir), "failure-memory", "failure-memory.json");
  return undefined;
}

/** Resolve an explicit development inbox or place it beside the effective FailureMemory file. */
export function resolveDevelopmentHandoffFilePath(env: FailureMemoryEnvironment): string | undefined {
  const explicitFile = env.BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE?.trim();
  if (explicitFile) return path.resolve(explicitFile);

  const failureMemoryFile = resolveFailureMemoryFilePath(env);
  return failureMemoryFile
    ? path.join(path.dirname(failureMemoryFile), "development-handoffs.json")
    : undefined;
}
