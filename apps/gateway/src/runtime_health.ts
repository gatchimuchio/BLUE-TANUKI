import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import type { HDSBrainHealthOptions, RuntimePathCheck } from "@blue-tanuki/hds-brain";
import { AUDIT_FILENAME } from "./audit_config.js";

type Env = Record<string, string | undefined>;
export type RuntimeHealthProbeMode = "read_only" | "repair_capable";

export async function probeGatewaySelfHealth(
  env: Env = process.env,
  opts: { mode?: RuntimeHealthProbeMode } = {},
): Promise<HDSBrainHealthOptions> {
  const mode = opts.mode ?? "repair_capable";
  const requiredDirectories = [
    env.BLUE_TANUKI_SESSION_DIR,
    env.BLUE_TANUKI_SCHEDULES_DIR ?? ".blue-tanuki/schedules",
  ].filter((item): item is string => Boolean(item && item.trim().length > 0));

  const storagePaths = [
    memoryFileFromEnv(env),
  ].filter((item): item is string => Boolean(item));

  const required_directories = await Promise.all(
    requiredDirectories.map((dir) => probeDirectory(dir, mode)),
  );
  const storage_paths = await Promise.all(
    storagePaths.map((file) => probeAppendableFile(file, mode)),
  );
  const audit_appendable = env.BLUE_TANUKI_AUDIT_DIR
    ? (await probeAppendableFile(path.join(path.resolve(env.BLUE_TANUKI_AUDIT_DIR), AUDIT_FILENAME), mode)).writable === true
    : "memory_only";

  return {
    required_directories,
    storage_paths,
    audit_appendable,
    optional_dependencies: [
      { name: "telegram", available: Boolean(env.TELEGRAM_BOT_TOKEN) },
      { name: "slack_preview", available: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) },
      { name: "discord_preview", available: Boolean(env.DISCORD_BOT_TOKEN) },
      { name: "teams_preview", available: Boolean(env.MICROSOFT_GRAPH_ACCESS_TOKEN) },
      { name: "line_preview", available: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN) },
      { name: "openrouter", available: Boolean(env.OPENROUTER_API_KEY && (env.OPENROUTER_MODEL || env.LLM_MODEL)) },
      { name: "composio", available: Boolean(env.COMPOSIO_API_KEY && env.COMPOSIO_ALLOWED_TOOLKITS) },
    ],
  };
}

async function probeDirectory(dir: string, mode: RuntimeHealthProbeMode): Promise<RuntimePathCheck> {
  const resolved = path.resolve(dir);
  try {
    if (mode === "repair_capable") {
      await fs.mkdir(resolved, { recursive: true });
      await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
      const probe = path.join(resolved, `.btnk-health-${process.pid}-${Date.now()}.tmp`);
      await fs.writeFile(probe, "health-probe", { flag: "wx" });
      await fs.readFile(probe, "utf8");
      await fs.unlink(probe);
      return { path: resolved, readable: true, writable: true };
    }
    await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    return { path: resolved, readable: true, writable: true };
  } catch {
    return { path: resolved, readable: false, writable: false };
  }
}

async function probeAppendableFile(file: string, mode: RuntimeHealthProbeMode): Promise<RuntimePathCheck> {
  const resolved = path.resolve(file);
  try {
    if (mode === "repair_capable") {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const handle = await fs.open(resolved, "a");
      await handle.close();
      await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
      return { path: resolved, readable: true, writable: true };
    }
    await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    return { path: resolved, readable: true, writable: true };
  } catch {
    return { path: resolved, readable: false, writable: false };
  }
}

function memoryFileFromEnv(env: Env): string | null {
  if (env.BLUE_TANUKI_MEMORY_FILE) return env.BLUE_TANUKI_MEMORY_FILE;
  if (env.BLUE_TANUKI_MEMORY_DIR) {
    return path.join(env.BLUE_TANUKI_MEMORY_DIR, "memory.jsonl");
  }
  return null;
}
