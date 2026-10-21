import { randomUUID } from "node:crypto";
import type { InboundChannel, OutboundChannel } from "@blue-tanuki/channel-base";
import { buildLLMBackendFromEnv, describeLLMConfig } from "./llm_config.js";
import { GatewayDiscordEventStore } from "./discord_event_store.js";
import { loadPluginRuntime, type PluginRuntime } from "./plugin_loader.js";

const LIVE_REQUIRED = process.env.BLUE_TANUKI_LIVE_REQUIRED === "1";
const TIMEOUT_MS = parsePositiveInt(process.env.BLUE_TANUKI_LIVE_TIMEOUT_MS, 30_000);
const SLACK_PACKAGE = "@blue-tanuki/channel-slack";
const DISCORD_PACKAGE = "@blue-tanuki/channel-discord";
const TEAMS_PACKAGE = "@blue-tanuki/channel-teams";
const LINE_PACKAGE = "@blue-tanuki/channel-line";
const SLACK_LIVE_PERMISSIONS = [
  "network:slack.com",
  "secrets:SLACK_BOT_TOKEN",
  "secrets:SLACK_APP_TOKEN",
] as const;
const DISCORD_LIVE_PERMISSIONS = [
  "network:discord.com",
  "secrets:DISCORD_BOT_TOKEN",
] as const;
const TEAMS_LIVE_PERMISSIONS = [
  "network:graph.microsoft.com",
  "secrets:MICROSOFT_GRAPH_ACCESS_TOKEN",
] as const;
const LINE_LIVE_PERMISSIONS = [
  "network:api.line.me",
  "secrets:LINE_CHANNEL_ACCESS_TOKEN",
] as const;

interface SmokeResult {
  name: string;
  status: "pass" | "skip" | "fail";
  detail: string;
}

async function main(): Promise<void> {
  const plugins = await loadPluginRuntime();
  const results: SmokeResult[] = [];

  results.push(await runSmoke("llm", () => smokeLLM(plugins)));
  results.push(await runSmoke("slack", () => smokeSlack(plugins)));
  results.push(await runSmoke("discord", () => smokeDiscord(plugins)));
  results.push(await runSmoke("teams", () => smokeTeams(plugins)));
  results.push(await runSmoke("line", () => smokeLine(plugins)));

  for (const r of results) {
    console.log(`[live:${r.name}] ${r.status.toUpperCase()} ${r.detail}`);
  }

  const ran = results.filter((r) => r.status !== "skip").length;
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    process.exit(1);
  }
  if (LIVE_REQUIRED && ran === 0) {
    console.error(
      "[live] FAIL no live smoke was configured; unset BLUE_TANUKI_LIVE_REQUIRED or provide live credentials",
    );
    process.exit(1);
  }
  console.log(`[live] complete ran=${ran} skipped=${results.length - ran}`);
}

async function runSmoke(
  name: string,
  fn: () => Promise<string | null>,
): Promise<SmokeResult> {
  try {
    const detail = await fn();
    if (detail === null) {
      return { name, status: "skip", detail: "credentials/target not configured" };
    }
    return { name, status: "pass", detail };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function smokeLLM(plugins: PluginRuntime): Promise<string | null> {
  plugins.enforceLLMConfig(process.env);
  const cfg = describeLLMConfig();
  if (cfg.default_backend === "stub") return null;

  const backend = buildLLMBackendFromEnv();
  const res = await withTimeout(
    "llm call",
    backend.call({
      max_tokens: 24,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Reply with exactly: BLUE-TANUKI-LIVE-OK",
        },
        { role: "user", content: "live smoke" },
      ],
    }),
    parsePositiveInt(
      process.env.BLUE_TANUKI_LIVE_LLM_TIMEOUT_MS ??
        process.env.BLUE_TANUKI_LLM_TIMEOUT_MS,
      TIMEOUT_MS,
    ),
  );
  if (!res.content.includes("BLUE-TANUKI-LIVE-OK")) {
    throw new Error(`unexpected response from ${res.model}: ${JSON.stringify(res.content)}`);
  }
  return `model=${res.model} tokens=${res.tokens_used}`;
}

async function smokeSlack(plugins: PluginRuntime): Promise<string | null> {
  const target = process.env.SLACK_LIVE_TARGET;
  if (!target) return null;

  plugins.requirePermissions(
    SLACK_PACKAGE,
    SLACK_LIVE_PERMISSIONS,
    "live smoke slack",
  );
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken || !target) return null;

  const slack = plugins.createChannel<InboundChannel & OutboundChannel>({
    package_name: SLACK_PACKAGE,
    required_permissions: SLACK_LIVE_PERMISSIONS,
    action: "live smoke slack",
    constructor_args: [{
      bot_token: botToken,
      app_token: appToken,
      log: (line: string) => console.log(`[live:slack:transport] ${line}`),
    }],
  });
  try {
    await withTimeout("slack start", slack.start(async () => undefined), TIMEOUT_MS);
    const result = await withTimeout(
      "slack send",
      slack.send(
        {
          channel: "slack",
          target,
          content: `BLUE-TANUKI live smoke ${new Date().toISOString()}`,
        },
        {
          command_id: `live-${randomUUID()}`,
          upstream_commit_hash: "live-smoke",
        },
      ),
      TIMEOUT_MS,
    );
    if (!result.delivered) {
      throw new Error(formatDeliveryFailure(result));
    }
    return `target=${target} external_id=${result.external_id ?? "unknown"}`;
  } finally {
    await slack.stop();
  }
}

async function smokeDiscord(plugins: PluginRuntime): Promise<string | null> {
  const target = process.env.DISCORD_LIVE_TARGET;
  if (!target) return null;

  plugins.requirePermissions(
    DISCORD_PACKAGE,
    DISCORD_LIVE_PERMISSIONS,
    "live smoke discord",
  );
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken || !target) return null;

  const inbox = GatewayDiscordEventStore.fromEnvironment(process.env, botToken);
  let discord: (InboundChannel & OutboundChannel) | null = null;
  try {
    discord = plugins.createChannel<InboundChannel & OutboundChannel>({
      package_name: DISCORD_PACKAGE,
      required_permissions: DISCORD_LIVE_PERMISSIONS,
      action: "live smoke discord",
      constructor_args: [{
        bot_token: botToken,
        // This smoke only sends a message; never admit inbound events here.
        inbound_grants: [],
        inbox,
        log: (line: string) => console.log(`[live:discord:transport] ${line}`),
      }],
    });
    await withTimeout("discord start", discord.start(async () => undefined), TIMEOUT_MS);
    const result = await withTimeout(
      "discord send",
      discord.send(
        {
          channel: "discord",
          target,
          content: `BLUE-TANUKI live smoke ${new Date().toISOString()}`,
        },
        {
          command_id: `live-${randomUUID()}`,
          upstream_commit_hash: "live-smoke",
        },
      ),
      TIMEOUT_MS,
    );
    if (!result.delivered) {
      throw new Error(formatDeliveryFailure(result));
    }
    return `target=${target} external_id=${result.external_id ?? "unknown"}`;
  } finally {
    try {
      await discord?.stop();
    } finally {
      inbox.close();
    }
  }
}

async function smokeTeams(plugins: PluginRuntime): Promise<string | null> {
  const target = process.env.TEAMS_LIVE_TARGET;
  if (!target) return null;

  plugins.requirePermissions(
    TEAMS_PACKAGE,
    TEAMS_LIVE_PERMISSIONS,
    "live smoke teams",
  );
  const accessToken = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
  if (!accessToken || !target) return null;

  const teams = plugins.createChannel<InboundChannel & OutboundChannel>({
    package_name: TEAMS_PACKAGE,
    required_permissions: TEAMS_LIVE_PERMISSIONS,
    action: "live smoke teams",
    constructor_args: [{
      access_token: accessToken,
      log: (line: string) => console.log(`[live:teams:transport] ${line}`),
    }],
  });
  try {
    await withTimeout("teams start", teams.start(async () => undefined), TIMEOUT_MS);
    const result = await withTimeout(
      "teams send",
      teams.send(
        {
          channel: "teams",
          target,
          content: `BLUE-TANUKI live smoke ${new Date().toISOString()}`,
        },
        {
          command_id: `live-${randomUUID()}`,
          upstream_commit_hash: "live-smoke",
        },
      ),
      TIMEOUT_MS,
    );
    if (!result.delivered) {
      throw new Error(formatDeliveryFailure(result));
    }
    return `target=${target} external_id=${result.external_id ?? "unknown"}`;
  } finally {
    await teams.stop();
  }
}

async function smokeLine(plugins: PluginRuntime): Promise<string | null> {
  const target = process.env.LINE_LIVE_TARGET;
  if (!target) return null;

  plugins.requirePermissions(
    LINE_PACKAGE,
    LINE_LIVE_PERMISSIONS,
    "live smoke line",
  );
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelAccessToken || !target) return null;

  const line = plugins.createChannel<InboundChannel & OutboundChannel>({
    package_name: LINE_PACKAGE,
    required_permissions: LINE_LIVE_PERMISSIONS,
    action: "live smoke line",
    constructor_args: [{
      channel_access_token: channelAccessToken,
      log: (lineText: string) => console.log(`[live:line:transport] ${lineText}`),
    }],
  });
  try {
    await withTimeout("line start", line.start(async () => undefined), TIMEOUT_MS);
    const result = await withTimeout(
      "line send",
      line.send(
        {
          channel: "line",
          target,
          content: `BLUE-TANUKI live smoke ${new Date().toISOString()}`,
        },
        {
          command_id: `live-${randomUUID()}`,
          upstream_commit_hash: "live-smoke",
        },
      ),
      TIMEOUT_MS,
    );
    if (!result.delivered) {
      throw new Error(formatDeliveryFailure(result));
    }
    return `target=${target} external_id=${result.external_id ?? "unknown"}`;
  } finally {
    await line.stop();
  }
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatDeliveryFailure(result: {
  error?: string;
  error_kind?: string;
  error_code?: string;
  retry_after_ms?: number;
  next_action?: string;
}): string {
  const parts = [
    result.error ?? "send_not_delivered",
    result.error_kind ? `kind=${result.error_kind}` : null,
    result.error_code ? `code=${result.error_code}` : null,
    result.retry_after_ms ? `retry_after_ms=${result.retry_after_ms}` : null,
    result.next_action ? `next_action=${result.next_action}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

main().catch((e) => {
  console.error("[live] crashed:", e);
  process.exit(1);
});
