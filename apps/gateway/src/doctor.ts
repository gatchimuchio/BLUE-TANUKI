import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  manifestPathFor,
  readManifest,
} from "@blue-tanuki/protocol";
import {
  buildLLMCommandRouteFromEnv,
  listConfiguredLLMProviders,
} from "./llm_config.js";
import { cronSchedulesFromEnv } from "./cron_channel.js";
import { parseGoogleServices } from "./google_daily_brief.js";
import { remediationFor } from "./doctor_remediation.js";

/**
 * doctor — environment diagnostic for blue-tanuki gateway.
 *
 * Design goals:
 *   - Zero side effects beyond a brief listen-probe on the configured port.
 *   - Deterministic exit code mapping:
 *       0 = all checks pass
 *       1 = one or more warnings (non-blocking; e.g. optional env unset)
 *       2 = one or more errors (blocks `serve` from starting cleanly)
 *   - Two output formats: human-readable (default) and JSON (--json).
 *
 * What we check:
 *   - Node.js version >= 22.14 (engines.node in root package.json)
 *   - Required env: WEBCHAT_TOKEN / WEBCHAT_RESUME_TOKEN / BLUE_TANUKI_MAINTENANCE_TOKEN present
 *     (length-only; never log values)
 *   - Optional env: WEBHOOK_TOKEN separation when /webhook is enabled
 *   - Optional env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, DISCORD_BOT_TOKEN,
 *                   MICROSOFT_GRAPH_ACCESS_TOKEN, LINE_CHANNEL_ACCESS_TOKEN,
 *                   ANTHROPIC_API_KEY, OPENROUTER_API_KEY, COMPOSIO_API_KEY, GITHUB_TOKEN,
 *                   BLUE_TANUKI_GITHUB_REPOS (presence only)
 *   - Optional Google read source config for Daily Brief
 *   - WEBCHAT_PORT is bindable (probe by binding then closing)
 *   - BLUE_TANUKI_SESSION_DIR (if set) is writable / can be created
 *   - BLUE_TANUKI_AUDIT_DIR   (if set) is writable / can be created
 *   - BLUE_TANUKI_FILE_ROOT and BLUE_TANUKI_SHELL_ROOT (if set) are directories
 *   - BLUE_TANUKI_SCHEDULES_JSON parses as scheduled-message config
 *   - LLM_BACKEND consistency (stub / anthropic / openai-compatible / openrouter)
 *   - Distribution readiness docs, release-bundle gates, channel promotion,
 *     and plugin review gates are present
 *
 * What we do NOT check:
 *   - Live Slack / Discord / Anthropic API connectivity. Those are
 *     side-effecting, slow, and outside doctor's promise of being a
 *     fast, hermetic local probe. Those go in 4-8 (live-fire smoke).
 */

export type CheckLevel = "ok" | "warn" | "error";
export type CheckStatus = "ok" | "warning" | "error";

export interface CheckResult {
  /** Stable identifier used in JSON output and tests. */
  id: string;
  level: CheckLevel;
  status: CheckStatus;
  /** Short label shown in the human-readable header. */
  label: string;
  /** Free-form details (one line preferred). */
  detail: string;
  /** One-line explanation of the condition. */
  cause: string;
  /** What the condition affects for the owner. */
  impact: string;
  /** Concrete next step or local doc reference. */
  next_action: string;
  /** Repository-local documentation reference. */
  doc_ref: string;
  /** Whether an owner may safely ignore this condition for local operation. */
  safe_to_ignore: boolean;
}

export interface DoctorReport {
  ok: boolean;
  exit_code: 0 | 1 | 2;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  checks: CheckResult[];
}

export interface DoctorOptions {
  /** When true, run port-binding probe. Default true; tests pass false. */
  probe_port?: boolean;
  /** Override env source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override Node version. Defaults to process.versions.node. */
  node_version?: string;
  /** Override repo root for manifest validation. Used by tests. */
  manifest_root?: string;
  /** Override repo root for distribution-readiness validation. Used by tests. */
  distribution_root?: string;
  /** core=release health, preview=preview credential readiness, strict=all configured surfaces strict. */
  mode?: DoctorMode;
}

export type DoctorMode = "core" | "preview" | "strict";

export type CheckDraft = Pick<CheckResult, "id" | "level" | "label" | "detail">;

export interface Remediation {
  cause: string;
  impact: string;
  next_action: string;
  doc_ref: string;
  safe_to_ignore: boolean;
}

/**
 * Required minimum Node.js version, mirroring root package.json
 * "engines.node". Kept as a literal here so doctor stays self-contained;
 * a Phase 5+ improvement would read it from package.json at boot.
 */
export const MIN_NODE_VERSION = "22.14.0";

const CORE_MANIFEST_PACKAGES = [
  "packages/hds-brain",
  "packages/protocol",
  "packages/blue-tanuki",
  "packages/channel-base",
  "packages/channel-webchat",
  "packages/channel-telegram",
  "packages/operator-daily",
  "packages/operator-developer",
  "packages/operator-writing",
] as const;

const PREVIEW_MANIFEST_PACKAGES = [
  "packages/channel-slack",
  "packages/channel-discord",
  "packages/channel-teams",
  "packages/channel-line",
] as const;

const EXPECTED_MANIFEST_PACKAGES = [
  ...CORE_MANIFEST_PACKAGES,
  ...PREVIEW_MANIFEST_PACKAGES,
] as const;

interface ChannelCompatibility {
  status?: unknown;
  target_release?: unknown;
  core_supported?: unknown;
  warranty?: unknown;
}

interface CompatibilityMatrix {
  channels?: Record<string, ChannelCompatibility>;
}

interface DistributionRequirement {
  rel: string;
  label: string;
  needles: readonly string[];
  optional_in_core_release?: boolean;
}

const DISTRIBUTION_REQUIREMENTS: readonly DistributionRequirement[] = [
  {
    rel: "install/README.md",
    label: "portable installer docs",
    needles: [
      "Windows",
      "macOS",
      "Linux",
      "pnpm installer:run",
      "guided first-run",
      "Verify LLM",
      "BLUE_TANUKI_SETTINGS_TOKEN",
      "resident-start",
      "resident-autostart-enable",
      "RESET_CONFIG=1",
      "PURGE=1",
      "dry-run",
      "does not build signed native packages yet",
      "Distribution readiness",
    ],
  },
  {
    rel: "install/installer/README.md",
    label: "guided first-run installer docs",
    optional_in_core_release: true,
    needles: [
      "guided first-run",
      "pnpm installer:run",
      "Verify LLM",
      "not a signed native installer",
      "not an automatic updater",
    ],
  },
  {
    rel: "docs/RESIDENT_APP_GUIDE.md",
    label: "resident app guide",
    needles: [
      "resident-start",
      "resident-status",
      "resident-stop",
      "resident-autostart-enable",
      "Autostart is opt-in only",
      "does not provide a signed native app",
      "does not provide an automatic updater",
    ],
  },
  {
    rel: "install/resident/README.md",
    label: "resident helper docs",
    optional_in_core_release: true,
    needles: [
      "resident-start",
      "resident-autostart-enable",
      "does not enable autostart",
    ],
  },
  {
    rel: "docs/INSTALLER_GUIDE.md",
    label: "installer guide",
    needles: [
      "guided first-run",
      "SIM-like LLM API settings",
      "pnpm installer:run",
      "Verify LLM",
      "not a signed native installer",
      "not an automatic updater",
      "RESIDENT_APP_GUIDE.md",
    ],
  },
  {
    rel: "docs/UPDATE_ROLLBACK_RUNBOOK.md",
    label: "update and rollback runbook",
    needles: [
      "does not currently implement an automatic updater",
      "Release Bundle Update",
      "Config Preservation",
      "Rollback",
      "Uninstall / Purge",
      "Distribution readiness gate",
    ],
  },
  {
    rel: "docs/PERMANENT_USE_CHECKLIST.md",
    label: "permanent-use checklist",
    needles: [
      "release bundle",
      "signed native installer",
      "automatic updater",
      "dry-run",
      "resident app docs",
      "validate:channels",
    ],
  },
  {
    rel: "docs/CHANNEL_PROMOTION_GATE.md",
    label: "channel promotion gate",
    needles: [
      "pnpm validate:channels",
      "owner-run evidence",
      "gateway-owned inbound listener closure",
      "reserved-third-party",
      "must not contain token values",
    ],
  },
  {
    rel: "docs/PLUGIN_REVIEW_GATE.md",
    label: "plugin review gate",
    needles: [
      "pnpm plugin:review",
      "blue-tanuki.review.json",
      "used_for_authority=false",
      "no external npm dynamic import",
      "Plugin Review Gate result is review evidence only",
    ],
  },
  {
    rel: "docs/v1.0-ga-promotion-review.md",
    label: "GA promotion review",
    needles: [
      "PENDING_OWNER_GO",
      "pnpm validate:ga",
      "public_claim_allowed=false",
      "status=pre_go_ready",
    ],
  },
  {
    rel: "scripts/channel_promotion_gate.ts",
    label: "channel promotion gate script",
    needles: [
      "validateChannelPromotion",
      "BASELINE_FIRST_PARTY_CHANNELS",
      "PROMOTION_ELIGIBLE_CHANNELS",
      "reserved-third-party",
      "gateway-owned inbound listener",
    ],
  },
  {
    rel: "scripts/plugin_review_gate.ts",
    label: "plugin review gate script",
    needles: [
      "--package",
      "--bundled",
      "plugin-review",
      "reviewPluginPackage",
    ],
  },
  {
    rel: "scripts/ga_promotion_gate.ts",
    label: "GA promotion gate script",
    needles: [
      "validateGaPromotionGate",
      "PENDING_OWNER_GO",
      "public_claim_allowed",
      "OWNER_DECISION_PATH",
    ],
  },
  {
    rel: "apps/gateway/src/plugin_review_gate.ts",
    label: "plugin review gate implementation",
    needles: [
      "reviewPluginPackage",
      "blue-tanuki.review.json",
      "layer_b_review_used_for_authority",
      "external_dynamic_imports",
      "hot_reload",
    ],
  },
  {
    rel: "package.json",
    label: "package scripts",
    needles: ["validate:channels", "plugin:review", "validate:ga"],
  },
  {
    rel: "scripts/create_release_bundle.ts",
    label: "release bundle creator",
    needles: [
      "CORE_RELEASE_PATHS",
      "docs/CHANNEL_PROMOTION_GATE.md",
      "docs/phase11-s12-plugin-review-gate-implementation.md",
      "docs/v1.0-ga-promotion-review.md",
      "docs/phase11-s13-v1-ga-promotion-execution.md",
      "scripts/ga_promotion_gate.ts",
      "scripts/plugin_review_gate.ts",
      "apps/gateway/src/plugin_review_gate.ts",
      "install/linux/install.sh",
      ".sha256",
      ".manifest.json",
      "isSecretLikeFileName",
    ],
  },
  {
    rel: "scripts/verify_release_bundle.ts",
    label: "release bundle verifier",
    needles: [
      "sha256",
      "manifest",
      "core_release_paths",
      "EXTRACTED_RELEASE_COMMANDS",
      "pnpm\", \"run\", \"doctor",
      "validate:repo-health",
      "isForbiddenFileName",
      "docs/CHANNEL_PROMOTION_GATE.md",
      "scripts/plugin_review_gate.ts",
      "scripts/ga_promotion_gate.ts",
      "docs/v1.0-ga-promotion-review.md",
      "apps/gateway/src/plugin_review_gate.ts",
    ],
  },
  {
    rel: "scripts/validate_packaging.ts",
    label: "packaging validator",
    needles: [
      "Distribution readiness",
      "does not build signed native packages yet",
      "does not currently implement an automatic updater",
      "plugin:review",
      "validate:ga",
    ],
  },
  {
    rel: "install/windows/uninstall.ps1",
    label: "Windows uninstaller",
    optional_in_core_release: true,
    needles: ["Purge", "DryRun", "Assert-SafeTarget", "resident-autostart-disable", "Data retained"],
  },
  {
    rel: "install/macos/uninstall.sh",
    label: "macOS uninstaller",
    optional_in_core_release: true,
    needles: ["PURGE", "DRY_RUN", "safe_target", "resident-autostart-disable", "Data retained"],
  },
  {
    rel: "install/linux/uninstall.sh",
    label: "Linux uninstaller",
    needles: ["PURGE", "DRY_RUN", "safe_target", "resident-autostart-disable", "Config retained"],
  },
];

/** Compare two semver-like strings. Returns -1/0/1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function checkNodeVersion(actual: string): CheckDraft {
  const ok = compareSemver(actual, MIN_NODE_VERSION) >= 0;
  return {
    id: "node_version",
    level: ok ? "ok" : "error",
    label: "Node.js version",
    detail: ok
      ? `${actual} (>= ${MIN_NODE_VERSION})`
      : `${actual} is below required ${MIN_NODE_VERSION}`,
  };
}

function checkRequiredEnv(env: NodeJS.ProcessEnv, name: string): CheckDraft {
  const v = env[name];
  if (!v) {
    return {
      id: `env:${name}`,
      level: "error",
      label: `env ${name}`,
      detail: "missing (required)",
    };
  }
  if (v.length < 8) {
    return {
      id: `env:${name}`,
      level: "warn",
      label: `env ${name}`,
      detail: `present but suspiciously short (length=${v.length})`,
    };
  }
  return {
    id: `env:${name}`,
    level: "ok",
    label: `env ${name}`,
    detail: `present (length=${v.length})`,
  };
}

function checkOptionalEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  opts: { required?: boolean } = {},
): CheckDraft {
  const v = env[name];
  if (!v) {
    return {
      id: `env:${name}`,
      level: opts.required ? "error" : "warn",
      label: `env ${name}`,
      detail: opts.required ? "missing (required for selected doctor mode)" : "unset (optional)",
    };
  }
  return {
    id: `env:${name}`,
    level: "ok",
    label: `env ${name}`,
    detail: `present (length=${v.length})`,
  };
}

function checkWebchatTokenSeparation(env: NodeJS.ProcessEnv): CheckDraft {
  if (!env.WEBCHAT_TOKEN || !env.WEBCHAT_RESUME_TOKEN || !env.BLUE_TANUKI_MAINTENANCE_TOKEN) {
    return {
      id: "webchat_token_separation",
      level: "error",
      label: "WebChat token split",
      detail: "WEBCHAT_TOKEN, WEBCHAT_RESUME_TOKEN, and BLUE_TANUKI_MAINTENANCE_TOKEN are all required",
    };
  }
  if (
    env.WEBCHAT_TOKEN === env.WEBCHAT_RESUME_TOKEN ||
    env.BLUE_TANUKI_MAINTENANCE_TOKEN === env.WEBCHAT_TOKEN ||
    env.BLUE_TANUKI_MAINTENANCE_TOKEN === env.WEBCHAT_RESUME_TOKEN
  ) {
    return {
      id: "webchat_token_separation",
      level: "error",
      label: "WebChat token split",
      detail: "WEBCHAT_RESUME_TOKEN and BLUE_TANUKI_MAINTENANCE_TOKEN must differ from WEBCHAT_TOKEN and each other",
    };
  }
  return {
    id: "webchat_token_separation",
    level: "ok",
    label: "WebChat token split",
    detail: "inbound, resume, and maintenance tokens differ",
  };
}

function checkSettingsToken(env: NodeJS.ProcessEnv): CheckDraft {
  const token = env.BLUE_TANUKI_SETTINGS_TOKEN;
  if (!token) {
    return {
      id: "settings_token",
      level: "ok",
      label: "settings token",
      detail: "unset (settings window disabled)",
    };
  }
  if (token.length < 16) {
    return {
      id: "settings_token",
      level: "error",
      label: "settings token",
      detail: "BLUE_TANUKI_SETTINGS_TOKEN must be at least 16 characters",
    };
  }
  if (
    token === env.WEBCHAT_TOKEN ||
    token === env.WEBCHAT_RESUME_TOKEN ||
    token === env.BLUE_TANUKI_MAINTENANCE_TOKEN ||
    token === env.WEBHOOK_TOKEN
  ) {
    return {
      id: "settings_token",
      level: "error",
      label: "settings token",
      detail: "BLUE_TANUKI_SETTINGS_TOKEN must differ from WebChat tokens",
    };
  }
  return {
    id: "settings_token",
    level: "ok",
    label: "settings token",
    detail: `present (length=${token.length})`,
  };
}

function checkWebhookToken(env: NodeJS.ProcessEnv): CheckDraft {
  const token = env.WEBHOOK_TOKEN;
  if (!token) {
    return {
      id: "webhook_token",
      level: "ok",
      label: "webhook token",
      detail: "unset (/webhook disabled)",
    };
  }
  if (token.length < 8) {
    return {
      id: "webhook_token",
      level: "error",
      label: "webhook token",
      detail: "WEBHOOK_TOKEN must be at least 8 characters",
    };
  }
  if (
    token === env.WEBCHAT_TOKEN ||
    token === env.WEBCHAT_RESUME_TOKEN ||
    token === env.BLUE_TANUKI_MAINTENANCE_TOKEN ||
    token === env.BLUE_TANUKI_SETTINGS_TOKEN
  ) {
    return {
      id: "webhook_token",
      level: "error",
      label: "webhook token",
      detail: "WEBHOOK_TOKEN must differ from WebChat and settings tokens",
    };
  }
  return {
    id: "webhook_token",
    level: "ok",
    label: "webhook token",
    detail: `present (length=${token.length})`,
  };
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = env[name];
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}

function checkLlmBackend(env: NodeJS.ProcessEnv): CheckDraft {
  const backend = (envValue(env, "LLM_BACKEND", "LLM_DEFAULT_BACKEND") ?? "stub")
    .trim()
    .toLowerCase();
  let configuredProviders: string[];
  try {
    configuredProviders = listConfiguredLLMProviders(env).map((name) =>
      name.toLowerCase(),
    );
  } catch (e) {
    return {
      id: "llm_backend",
      level: "error",
      label: "LLM_BACKEND",
      detail: `invalid LLM_PROVIDERS_JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (backend === "stub") {
    return {
      id: "llm_backend",
      level: "ok",
      label: "LLM_BACKEND",
      detail: "stub (offline-safe default)",
    };
  }
  if (backend === "anthropic" || backend === "claude") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: `${backend} but ANTHROPIC_API_KEY is unset`,
      };
    }
    return {
      id: "llm_backend",
      level: "ok",
      label: "LLM_BACKEND",
      detail: `${backend} with API key present`,
    };
  }
  if (backend === "openai" || backend === "openai-compatible") {
    const model = envValue(
      env,
      "OPENAI_COMPAT_MODEL",
      "OPENAI_MODEL",
      "LLM_MODEL",
    );
    const key = envValue(
      env,
      "OPENAI_COMPAT_API_KEY",
      "OPENAI_API_KEY",
      "LLM_API_KEY",
    );
    const endpoint = envValue(
      env,
      "OPENAI_COMPAT_ENDPOINT",
      "OPENAI_ENDPOINT",
      "LLM_ENDPOINT",
    );
    if (!model) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: `${backend} but no model is set (OPENAI_COMPAT_MODEL/OPENAI_MODEL/LLM_MODEL)`,
      };
    }
    if (backend === "openai-compatible" && !endpoint) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: "openai-compatible but no endpoint is set (OPENAI_COMPAT_ENDPOINT/LLM_ENDPOINT)",
      };
    }
    if (backend === "openai" && !key) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: "openai but no API key is set (OPENAI_API_KEY/LLM_API_KEY)",
      };
    }
    return {
      id: "llm_backend",
      level: "ok",
      label: "LLM_BACKEND",
      detail:
        backend === "openai"
          ? "openai with model/API key present"
          : "openai-compatible with model/endpoint present",
    };
  }
  if (backend === "openrouter") {
    const model = envValue(env, "OPENROUTER_MODEL", "LLM_MODEL");
    const key = envValue(env, "OPENROUTER_API_KEY");
    if (!model) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: "openrouter but no model is set (OPENROUTER_MODEL/LLM_MODEL)",
      };
    }
    if (!key) {
      return {
        id: "llm_backend",
        level: "error",
        label: "LLM_BACKEND",
        detail: "openrouter but OPENROUTER_API_KEY is unset",
      };
    }
    return {
      id: "llm_backend",
      level: "ok",
      label: "LLM_BACKEND",
      detail: "openrouter with model/API key present",
    };
  }
  if (configuredProviders.includes(backend)) {
    return {
      id: "llm_backend",
      level: "ok",
      label: "LLM_BACKEND",
      detail: `${backend} registered via LLM_PROVIDERS_JSON`,
    };
  }
  return {
    id: "llm_backend",
    level: "error",
    label: "LLM_BACKEND",
    detail: `unknown value '${backend}' (expected stub | anthropic | openai | openai-compatible | openrouter | LLM_PROVIDERS_JSON name/alias)`,
  };
}

function checkLlmCommandRoute(env: NodeJS.ProcessEnv): CheckDraft {
  try {
    const route = buildLLMCommandRouteFromEnv(env);
    const providers = listConfiguredLLMProviders(env).map((name) =>
      name.toLowerCase(),
    );
    const hint = route.backend_hint?.trim().toLowerCase();
    if (hint && !providers.includes(hint)) {
      return {
        id: "llm_command_route",
        level: "error",
        label: "LLM command route",
        detail: `backend_hint '${route.backend_hint}' is not registered`,
      };
    }
    return {
      id: "llm_command_route",
      level: "ok",
      label: "LLM command route",
      detail:
        `backend=${route.backend_hint ?? "(registry default)"}, ` +
        `model=${route.model ?? "(provider default)"}, ` +
        `max_tokens=${route.max_tokens ?? 1024}, ` +
        `timeout_ms=${route.timeout_ms ?? 30_000}`,
    };
  } catch (e) {
    return {
      id: "llm_command_route",
      level: "error",
      label: "LLM command route",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkComposioConnector(env: NodeJS.ProcessEnv): CheckDraft {
  const key = envValue(env, "COMPOSIO_API_KEY");
  const allowed = envValue(env, "COMPOSIO_ALLOWED_TOOLKITS");
  const dryRun = (env.COMPOSIO_DRY_RUN ?? "true").trim().toLowerCase();
  if (!key) {
    return {
      id: "composio_connector",
      level: "warn",
      label: "Composio connector",
      detail: "COMPOSIO_API_KEY unset (optional; connector disabled)",
    };
  }
  if (!allowed) {
    return {
      id: "composio_connector",
      level: "warn",
      label: "Composio connector",
      detail: "COMPOSIO_API_KEY present but COMPOSIO_ALLOWED_TOOLKITS unset; connector will fail closed",
    };
  }
  return {
    id: "composio_connector",
    level: "ok",
    label: "Composio connector",
    detail: `configured; dry_run=${dryRun === "false" ? "false" : "true"}; allowed_toolkits=${allowed}`,
  };
}

async function probePort(port: number, host: string): Promise<CheckDraft> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const finish = (level: CheckLevel, detail: string): void => {
      srv.close(() => resolve({
        id: "port",
        level,
        label: `port ${host}:${port}`,
        detail,
      }));
    };
    srv.once("error", (e: NodeJS.ErrnoException) => {
      const reason = e.code ?? e.message;
      // Don't keep listening if we never bound; close is harmless on
      // an unbound server but we resolve directly to be explicit.
      resolve({
        id: "port",
        level: "error",
        label: `port ${host}:${port}`,
        detail: `cannot bind: ${reason}`,
      });
    });
    srv.listen(port, host, () => {
      finish("ok", "bindable");
    });
  });
}

async function checkSessionDir(env: NodeJS.ProcessEnv): Promise<CheckDraft> {
  const dir = env.BLUE_TANUKI_SESSION_DIR;
  if (!dir) {
    return {
      id: "session_dir",
      level: "ok",
      label: "BLUE_TANUKI_SESSION_DIR",
      detail: "unset (memory-only sessions)",
    };
  }
  const resolved = path.resolve(dir);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (e) {
    return {
      id: "session_dir",
      level: "error",
      label: "BLUE_TANUKI_SESSION_DIR",
      detail: `cannot create '${resolved}': ${(e as Error).message}`,
    };
  }
  // Probe writability with a tmp file.
  const probe = path.join(resolved, `.btnk-doctor-${process.pid}.tmp`);
  try {
    await fs.writeFile(probe, "doctor-probe", "utf8");
    await fs.unlink(probe);
  } catch (e) {
    return {
      id: "session_dir",
      level: "error",
      label: "BLUE_TANUKI_SESSION_DIR",
      detail: `not writable at '${resolved}': ${(e as Error).message}`,
    };
  }
  return {
    id: "session_dir",
    level: "ok",
    label: "BLUE_TANUKI_SESSION_DIR",
    detail: `${resolved} (writable)`,
  };
}

/**
 * Audit log directory (Phase 4-S3). Same probe pattern as session_dir:
 * unset is OK (in-memory audit), set must be creatable + writable.
 *
 * We do NOT verify chain integrity here. doctor's promise is fast hermetic
 * environment checks; chain verification is what `--audit-dump` is for.
 * Keeping the two separate avoids a slow doctor on long-running deployments.
 */
async function checkAuditDir(env: NodeJS.ProcessEnv): Promise<CheckDraft> {
  const dir = env.BLUE_TANUKI_AUDIT_DIR;
  if (!dir) {
    return {
      id: "audit_dir",
      level: "ok",
      label: "BLUE_TANUKI_AUDIT_DIR",
      detail: "unset (in-memory audit only)",
    };
  }
  const resolved = path.resolve(dir);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (e) {
    return {
      id: "audit_dir",
      level: "error",
      label: "BLUE_TANUKI_AUDIT_DIR",
      detail: `cannot create '${resolved}': ${(e as Error).message}`,
    };
  }
  const probe = path.join(resolved, `.btnk-doctor-audit-${process.pid}.tmp`);
  try {
    await fs.writeFile(probe, "doctor-probe", "utf8");
    await fs.unlink(probe);
  } catch (e) {
    return {
      id: "audit_dir",
      level: "error",
      label: "BLUE_TANUKI_AUDIT_DIR",
      detail: `not writable at '${resolved}': ${(e as Error).message}`,
    };
  }
  return {
    id: "audit_dir",
    level: "ok",
    label: "BLUE_TANUKI_AUDIT_DIR",
    detail: `${resolved} (writable)`,
  };
}

function checkCronSchedules(env: NodeJS.ProcessEnv): CheckDraft {
  try {
    const tasks = cronSchedulesFromEnv(env);
    const enabled = tasks.filter((task) => task.enabled !== false).length;
    return {
      id: "cron_schedules",
      level: "ok",
      label: "cron schedules",
      detail: tasks.length === 0
        ? "none configured"
        : `${tasks.length} configured (${enabled} enabled)`,
    };
  } catch (e) {
    return {
      id: "cron_schedules",
      level: "error",
      label: "cron schedules",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function checkGoogleDailyBriefSource(env: NodeJS.ProcessEnv): CheckDraft {
  const sourceEnabled = truthyEnv(env.BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED);
  if (!sourceEnabled) {
    return {
      id: "google_daily_brief_source",
      level: "ok",
      label: "Google Daily Brief source",
      detail: "disabled",
    };
  }
  if (!truthyEnv(env.BLUE_TANUKI_DAILY_BRIEF_ENABLED)) {
    return {
      id: "google_daily_brief_source",
      level: "warn",
      label: "Google Daily Brief source",
      detail: "enabled but BLUE_TANUKI_DAILY_BRIEF_ENABLED is disabled",
    };
  }
  let services: ReturnType<typeof parseGoogleServices>;
  try {
    services = parseGoogleServices(env.BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES);
  } catch (e) {
    return {
      id: "google_daily_brief_source",
      level: "error",
      label: "Google Daily Brief source",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const missing = services.filter((service) => {
    if (service === "gmail") return !env.GMAIL_ACCESS_TOKEN && !env.GOOGLE_ACCESS_TOKEN;
    if (service === "calendar") return !env.GOOGLE_CALENDAR_ACCESS_TOKEN && !env.GOOGLE_ACCESS_TOKEN;
    if (service === "drive") return !env.GOOGLE_DRIVE_ACCESS_TOKEN && !env.GOOGLE_ACCESS_TOKEN;
    return true;
  });
  if (missing.length > 0) {
    return {
      id: "google_daily_brief_source",
      level: "error",
      label: "Google Daily Brief source",
      detail: `missing read token for ${missing.join(", ")}; set service token or GOOGLE_ACCESS_TOKEN`,
    };
  }
  return {
    id: "google_daily_brief_source",
    level: "ok",
    label: "Google Daily Brief source",
    detail: `enabled services=${services.join(",")} token_status=present read_only=true`,
  };
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function checkFileRoot(env: NodeJS.ProcessEnv): Promise<CheckDraft> {
  const dir = env.BLUE_TANUKI_FILE_ROOT;
  if (!dir) {
    return {
      id: "file_root",
      level: "ok",
      label: "BLUE_TANUKI_FILE_ROOT",
      detail: "unset (file tools disabled until configured)",
    };
  }
  const resolved = path.resolve(dir);
  try {
    const real = await fs.realpath(resolved);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      return {
        id: "file_root",
        level: "error",
        label: "BLUE_TANUKI_FILE_ROOT",
        detail: `${real} is not a directory`,
      };
    }
    const probe = path.join(real, `.btnk-doctor-file-${process.pid}.tmp`);
    await fs.writeFile(probe, "doctor-probe", { flag: "wx" });
    await fs.unlink(probe);
    return {
      id: "file_root",
      level: "ok",
      label: "BLUE_TANUKI_FILE_ROOT",
      detail: `${real} (directory, writable)`,
    };
  } catch (e) {
    return {
      id: "file_root",
      level: "error",
      label: "BLUE_TANUKI_FILE_ROOT",
      detail: `invalid or not writable at '${resolved}': ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function checkShellRoot(env: NodeJS.ProcessEnv): Promise<CheckDraft> {
  const dir = env.BLUE_TANUKI_SHELL_ROOT;
  if (!dir) {
    return {
      id: "shell_root",
      level: "ok",
      label: "BLUE_TANUKI_SHELL_ROOT",
      detail: "unset (shell.exec disabled until configured)",
    };
  }
  const resolved = path.resolve(dir);
  try {
    const real = await fs.realpath(resolved);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      return {
        id: "shell_root",
        level: "error",
        label: "BLUE_TANUKI_SHELL_ROOT",
        detail: `${real} is not a directory`,
      };
    }
    return {
      id: "shell_root",
      level: "ok",
      label: "BLUE_TANUKI_SHELL_ROOT",
      detail: `${real} (directory)`,
    };
  } catch (e) {
    return {
      id: "shell_root",
      level: "error",
      label: "BLUE_TANUKI_SHELL_ROOT",
      detail: `invalid at '${resolved}': ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function locateRepoRoot(): Promise<string | null> {
  // Locate the repo by walking up from this module to find pnpm-workspace.yaml.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8; i++) {
    if (
      await fs
        .stat(path.join(cur, "pnpm-workspace.yaml"))
        .then(() => true)
        .catch(() => false)
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

async function pathExists(filepath: string): Promise<boolean> {
  return await fs
    .stat(filepath)
    .then(() => true)
    .catch(() => false);
}

async function isCoreReleaseExtraction(root: string): Promise<boolean> {
  const previewImplementationMarkers = [
    ...PREVIEW_MANIFEST_PACKAGES.map((rel) => path.join(rel, "package.json")),
    "install/installer/package.json",
  ];
  const markerPresence = await Promise.all(
    previewImplementationMarkers.map((rel) => pathExists(path.join(root, rel))),
  );
  return markerPresence.every((present) => !present);
}

async function validateManifestPackage(root: string, rel: string): Promise<string[]> {
  const failures: string[] = [];
  const pkgDir = path.join(root, rel);
  try {
    const manifest = await readManifest(manifestPathFor(pkgDir));
    const pkgRaw = await fs.readFile(path.join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as {
      name?: unknown;
      version?: unknown;
      main?: unknown;
    };

    if (manifest.name !== pkg.name) {
      failures.push(`${rel}: name mismatch (${manifest.name} != ${String(pkg.name)})`);
    }
    if (manifest.version !== pkg.version) {
      failures.push(
        `${rel}: version mismatch (${manifest.version} != ${String(pkg.version)})`,
      );
    }
    if (manifest.entry !== "./dist/index.js") {
      failures.push(`${rel}: entry must be ./dist/index.js`);
    }
    if (typeof pkg.main === "string" && manifest.entry !== pkg.main) {
      failures.push(`${rel}: entry mismatch with package main`);
    }
  } catch (e) {
    failures.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return failures;
}

async function checkBundledManifests(rootOverride?: string): Promise<CheckDraft> {
  const root = rootOverride ? path.resolve(rootOverride) : await locateRepoRoot();
  if (!root) {
    return {
      id: "manifests",
      level: "warn",
      label: "plugin manifests",
      detail: "repo root not located; manifest check skipped",
    };
  }

  const failures: string[] = [];
  const skipped: string[] = [];
  const coreReleaseExtraction = await isCoreReleaseExtraction(root);
  for (const rel of CORE_MANIFEST_PACKAGES) {
    failures.push(...await validateManifestPackage(root, rel));
  }
  for (const rel of PREVIEW_MANIFEST_PACKAGES) {
    if (coreReleaseExtraction && !(await pathExists(path.join(root, rel)))) {
      skipped.push(rel);
      continue;
    }
    failures.push(...await validateManifestPackage(root, rel));
  }

  if (failures.length > 0) {
    return {
      id: "manifests",
      level: "error",
      label: "plugin manifests",
      detail: failures.join("; "),
    };
  }
  return {
    id: "manifests",
    level: "ok",
    label: "plugin manifests",
    detail: skipped.length === 0
      ? `${EXPECTED_MANIFEST_PACKAGES.length} manifests valid`
      : `${CORE_MANIFEST_PACKAGES.length} core manifests valid; preview manifests absent in core release: ${skipped.join(", ")}`,
  };
}

async function checkCompatibilityMatrix(rootOverride?: string): Promise<CheckDraft> {
  const root = rootOverride ? path.resolve(rootOverride) : await locateRepoRoot();
  if (!root) {
    return {
      id: "compatibility_matrix",
      level: "warn",
      label: "compatibility matrix",
      detail: "repo root not located; compatibility check skipped",
    };
  }

  const failures: string[] = [];
  const skippedPreviewManifests: string[] = [];
  const coreReleaseExtraction = await isCoreReleaseExtraction(root);
  let matrix: CompatibilityMatrix;
  try {
    matrix = JSON.parse(
      await fs.readFile(
        path.join(root, "docs", "compatibility-matrix.json"),
        "utf8",
      ),
    ) as CompatibilityMatrix;
  } catch (e) {
    return {
      id: "compatibility_matrix",
      level: "error",
      label: "compatibility matrix",
      detail: `cannot read docs/compatibility-matrix.json: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const channels = matrix.channels ?? {};
  const whatsapp = channels.whatsapp;
  if (
    !whatsapp ||
    whatsapp.status !== "reserved-third-party" ||
    whatsapp.target_release !== null ||
    whatsapp.core_supported !== false ||
    whatsapp.warranty !== "none"
  ) {
    failures.push("whatsapp must remain reserved-third-party with core_supported=false");
  }

  const packageEntries = await fs
    .readdir(path.join(root, "packages"))
    .catch(() => [] as string[]);
  if (packageEntries.some((name) => /whatsapp/i.test(name))) {
    failures.push("packages/ must not contain a first-party WhatsApp adapter");
  }

  for (const channel of ["webchat", "telegram"]) {
    const entry = channels[channel];
    if (entry?.status !== "first-party" || entry?.target_release !== "v1.0") {
      failures.push(`${channel} must be first-party target_release=v1.0`);
      continue;
    }
    try {
      const manifest = await readManifest(
        manifestPathFor(path.join(root, "packages", `channel-${channel}`)),
      );
      if (manifest.kind !== "channel") {
        failures.push(`${channel}: manifest kind must be channel`);
      }
      if (!manifest.exports.channel) {
        failures.push(`${channel}: manifest must export channel`);
      }
    } catch (e) {
      failures.push(`${channel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const previewTargets: Record<string, string> = {
    discord: "v1.0-preview",
    slack: "v1.0-preview",
    teams: "v1.0-preview",
    line: "v1.0-preview",
  };
  for (const [channel, targetRelease] of Object.entries(previewTargets)) {
    const entry = channels[channel];
    if (
      entry?.status !== "first-party-preview" ||
      entry?.target_release !== targetRelease
    ) {
      failures.push(
        `${channel} must remain first-party-preview target_release=${targetRelease}`,
      );
    }
  }

  for (const channel of ["webchat", "telegram", "discord", "slack", "teams", "line"]) {
    const channelPackage = path.join(root, "packages", `channel-${channel}`);
    if (
      coreReleaseExtraction &&
      ["discord", "slack", "teams", "line"].includes(channel) &&
      !(await pathExists(channelPackage))
    ) {
      skippedPreviewManifests.push(channel);
      continue;
    }
    try {
      const manifest = await readManifest(
        manifestPathFor(channelPackage),
      );
      for (const permission of manifest.permissions) {
        if (permission === "*" || permission.includes(":*")) {
          failures.push(`${channel}: wildcard permission is not allowed`);
        }
      }
    } catch (e) {
      failures.push(`${channel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (failures.length > 0) {
    return {
      id: "compatibility_matrix",
      level: "error",
      label: "compatibility matrix",
      detail: failures.join("; "),
    };
  }

  return {
    id: "compatibility_matrix",
    level: "ok",
    label: "compatibility matrix",
    detail: skippedPreviewManifests.length === 0
      ? "channel scope, preview quarantine, and promotion gate boundary verified"
      : `channel scope, preview quarantine, and promotion gate boundary verified; preview manifests absent in core release: ${skippedPreviewManifests.join(", ")}`,
  };
}

async function checkDistributionReadiness(rootOverride?: string): Promise<CheckDraft> {
  const root = rootOverride ? path.resolve(rootOverride) : await locateRepoRoot();
  if (!root) {
    return {
      id: "distribution_readiness",
      level: "warn",
      label: "distribution readiness",
      detail: "repo root not located; distribution readiness check skipped",
    };
  }

  const failures: string[] = [];
  const skipped: string[] = [];
  const coreReleaseExtraction = await isCoreReleaseExtraction(root);
  for (const req of DISTRIBUTION_REQUIREMENTS) {
    const file = path.join(root, req.rel);
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if (req.optional_in_core_release && coreReleaseExtraction) {
        skipped.push(req.rel);
        continue;
      }
      failures.push(
        `${req.rel}: cannot read ${req.label}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    for (const needle of req.needles) {
      if (!text.includes(needle)) {
        failures.push(`${req.rel}: missing ${needle}`);
      }
    }
  }

  if (failures.length > 0) {
    return {
      id: "distribution_readiness",
      level: "error",
      label: "distribution readiness",
      detail: failures.join("; "),
    };
  }

  return {
    id: "distribution_readiness",
    level: "ok",
    label: "distribution readiness",
    detail: skipped.length === 0
      ? `${DISTRIBUTION_REQUIREMENTS.length} install/update/uninstall/channel-promotion/plugin-review/ga-promotion surfaces verified`
      : `${DISTRIBUTION_REQUIREMENTS.length - skipped.length} core distribution surfaces verified; preview-only paths absent in core release: ${skipped.join(", ")}`,
  };
}

function statusFromLevel(level: CheckLevel): CheckStatus {
  return level === "warn" ? "warning" : level;
}

function enrichCheck(check: CheckDraft): CheckResult {
  const remediation = remediationFor(check);
  return {
    ...check,
    status: statusFromLevel(check.level),
    ...remediation,
  };
}

/**
 * Run all checks and return a structured report.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const node_version = opts.node_version ?? process.versions.node;
  const mode = opts.mode ?? "core";
  const previewRequired = mode === "preview" || mode === "strict";
  const strictRequired = mode === "strict";

  const draftChecks: CheckDraft[] = [];
  draftChecks.push(checkNodeVersion(node_version));
  draftChecks.push(checkRequiredEnv(env, "WEBCHAT_TOKEN"));
  draftChecks.push(checkRequiredEnv(env, "WEBCHAT_RESUME_TOKEN"));
  draftChecks.push(checkRequiredEnv(env, "BLUE_TANUKI_MAINTENANCE_TOKEN"));
  draftChecks.push(checkWebchatTokenSeparation(env));
  draftChecks.push(checkWebhookToken(env));
  draftChecks.push(checkSettingsToken(env));
  draftChecks.push(checkOptionalEnv(env, "SLACK_BOT_TOKEN", { required: previewRequired }));
  draftChecks.push(checkOptionalEnv(env, "SLACK_APP_TOKEN", { required: previewRequired }));
  draftChecks.push(checkOptionalEnv(env, "DISCORD_BOT_TOKEN", { required: previewRequired }));
  draftChecks.push(checkOptionalEnv(env, "MICROSOFT_GRAPH_ACCESS_TOKEN", { required: previewRequired }));
  draftChecks.push(checkOptionalEnv(env, "LINE_CHANNEL_ACCESS_TOKEN", { required: previewRequired }));
  draftChecks.push(checkOptionalEnv(env, "ANTHROPIC_API_KEY", { required: strictRequired }));
  draftChecks.push(checkOptionalEnv(env, "OPENROUTER_API_KEY", { required: strictRequired }));
  draftChecks.push(checkOptionalEnv(env, "COMPOSIO_API_KEY", { required: strictRequired }));
  draftChecks.push(checkOptionalEnv(env, "GITHUB_TOKEN", { required: strictRequired }));
  draftChecks.push(checkOptionalEnv(env, "BLUE_TANUKI_GITHUB_REPOS", { required: strictRequired }));
  draftChecks.push(checkLlmBackend(env));
  draftChecks.push(checkLlmCommandRoute(env));
  draftChecks.push(checkComposioConnector(env));
  draftChecks.push(checkCronSchedules(env));
  draftChecks.push(checkGoogleDailyBriefSource(env));
  draftChecks.push(await checkSessionDir(env));
  draftChecks.push(await checkAuditDir(env));
  draftChecks.push(await checkFileRoot(env));
  draftChecks.push(await checkShellRoot(env));
  draftChecks.push(await checkBundledManifests(opts.manifest_root));
  draftChecks.push(await checkCompatibilityMatrix(opts.manifest_root));
  draftChecks.push(await checkDistributionReadiness(opts.distribution_root));

  if (opts.probe_port !== false) {
    const port = parseInt(env.WEBCHAT_PORT ?? "8787", 10);
    const host = env.WEBCHAT_HOST ?? "127.0.0.1";
    draftChecks.push(await probePort(port, host));
  }

  const checks = draftChecks.map(enrichCheck);
  const has_error = checks.some((c) => c.level === "error");
  const has_warn = checks.some((c) => c.level === "warn" && !c.safe_to_ignore);
  const exit_code: 0 | 1 | 2 = has_error ? 2 : has_warn ? 1 : 0;

  return {
    ok: !has_error,
    exit_code,
    timestamp: new Date().toISOString(),
    checks,
  };
}

/** Render a report in human-readable text form. */
export function formatTextReport(report: DoctorReport): string {
  const lines: string[] = [];
  const status =
    report.exit_code === 0
      ? "OK"
      : report.exit_code === 1
      ? "WARN"
      : "ERROR";
  lines.push(`blue-tanuki doctor - ${status} (${report.timestamp})`);
  lines.push("");
  for (const c of report.checks) {
    const mark = c.level === "ok" ? "OK" : c.level === "warn" ? "WARN" : "ERROR";
    lines.push(`  ${mark.padEnd(5)} ${c.label.padEnd(28)} ${c.detail}`);
    if (c.level !== "ok") {
      lines.push(`        status: ${c.status}`);
      lines.push(`        cause: ${c.cause}`);
      lines.push(`        impact: ${c.impact}`);
      lines.push(`        next_action: ${c.next_action}`);
      lines.push(`        doc_ref: ${c.doc_ref}`);
      lines.push(`        safe_to_ignore: ${String(c.safe_to_ignore)}`);
    }
  }
  lines.push("");
  lines.push(
    `Summary: ${report.checks.filter((c) => c.level === "ok").length} ok, ` +
      `${report.checks.filter((c) => c.level === "warn").length} warn, ` +
      `${report.checks.filter((c) => c.level === "error").length} error.`,
  );
  lines.push(`Exit code: ${report.exit_code}`);
  return lines.join(os.EOL);
}

/** Render a report as JSON suitable for machine pipes. */
export function formatJsonReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
