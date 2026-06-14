import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDoctor,
  formatTextReport,
  formatJsonReport,
  compareSemver,
  MIN_NODE_VERSION,
} from "../src/doctor.js";

/** Pick an unused TCP port for binding probes. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
    srv.on("error", reject);
  });
}

const baseEnv = (): NodeJS.ProcessEnv => ({
  WEBCHAT_TOKEN: "abcdefghijkl",
  WEBCHAT_RESUME_TOKEN: "resume-abcdefghijkl",
  LLM_BACKEND: "stub",
});

const manifestPackages = [
  ["packages/hds-brain", "@blue-tanuki/hds-brain"],
  ["packages/protocol", "@blue-tanuki/protocol"],
  ["packages/blue-tanuki", "@blue-tanuki/core"],
  ["packages/channel-base", "@blue-tanuki/channel-base"],
  ["packages/channel-webchat", "@blue-tanuki/channel-webchat"],
  ["packages/channel-slack", "@blue-tanuki/channel-slack"],
  ["packages/channel-discord", "@blue-tanuki/channel-discord"],
  ["packages/channel-telegram", "@blue-tanuki/channel-telegram"],
  ["packages/channel-teams", "@blue-tanuki/channel-teams"],
  ["packages/channel-line", "@blue-tanuki/channel-line"],
  ["packages/operator-daily", "@blue-tanuki/operator-daily"],
  ["packages/operator-developer", "@blue-tanuki/operator-developer"],
  ["packages/operator-writing", "@blue-tanuki/operator-writing"],
] as const;

async function writeManifestFixture(root: string): Promise<void> {
  for (const [rel, name] of manifestPackages) {
    const pkgDir = path.join(root, rel);
    const isChannel = rel.includes("/channel-");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name,
        version: "0.0.1",
        main: "./dist/index.js",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pkgDir, "blue-tanuki.plugin.json"),
      JSON.stringify({
        name,
        version: "0.0.1",
        kind: isChannel ? "channel" : "core",
        entry: "./dist/index.js",
        exports: isChannel ? { channel: "FakeChannel" } : {},
        permissions: isChannel ? ["network:example.test"] : [],
      }),
      "utf8",
    );
  }
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "docs", "compatibility-matrix.json"),
    JSON.stringify({
      channels: {
        webchat: { status: "first-party", target_release: "v1.0" },
        telegram: { status: "first-party", target_release: "v1.0" },
        discord: { status: "first-party-preview", target_release: "v1.0-preview" },
        slack: { status: "first-party-preview", target_release: "v1.0-preview" },
        teams: { status: "first-party-preview", target_release: "v1.0-preview" },
        line: { status: "first-party-preview", target_release: "v1.0-preview" },
        whatsapp: {
          status: "reserved-third-party",
          target_release: null,
          core_supported: false,
          warranty: "none",
        },
      },
    }),
    "utf8",
  );
  await writeDistributionFixture(root);
}

async function writeFixtureFile(root: string, rel: string, text: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
}

async function writeDistributionFixture(root: string): Promise<void> {
  await writeFixtureFile(
    root,
    "install/README.md",
    [
      "# Install",
      "Distribution readiness",
      "Windows macOS Linux",
      "pnpm installer:run",
      "guided first-run",
      "Verify LLM",
      "BLUE_TANUKI_SETTINGS_TOKEN",
      "resident-start",
      "resident-autostart-enable",
      "RESET_CONFIG=1 PURGE=1 dry-run",
      "does not build signed native packages yet",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "install/installer/README.md",
    [
      "# Guided Installer",
      "guided first-run",
      "pnpm installer:run",
      "Verify LLM",
      "not a signed native installer",
      "not an automatic updater",
      "RESIDENT_APP_GUIDE.md",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/INSTALLER_GUIDE.md",
    [
      "# Installer Guide",
      "guided first-run",
      "SIM-like LLM API settings",
      "pnpm installer:run",
      "Verify LLM",
      "not a signed native installer",
      "not an automatic updater",
      "RESIDENT_APP_GUIDE.md",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/RESIDENT_APP_GUIDE.md",
    [
      "# Resident App Guide",
      "resident-start",
      "resident-status",
      "resident-stop",
      "resident-autostart-enable",
      "Autostart is opt-in only",
      "does not provide a signed native app",
      "does not provide an automatic updater",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "install/resident/README.md",
    [
      "# Resident Helpers",
      "resident-start",
      "resident-autostart-enable",
      "does not enable autostart",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/UPDATE_ROLLBACK_RUNBOOK.md",
    [
      "# Runbook",
      "BLUE-TANUKI does not currently implement an automatic updater.",
      "Release Bundle Update",
      "Config Preservation",
      "Rollback",
      "Uninstall / Purge",
      "Distribution readiness gate",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/PERMANENT_USE_CHECKLIST.md",
    [
      "# Permanent Use",
      "release bundle",
      "signed native installer",
      "automatic updater",
      "resident app docs",
      "validate:channels",
      "dry-run",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/CHANNEL_PROMOTION_GATE.md",
    [
      "# Channel Promotion Gate",
      "pnpm validate:channels",
      "owner-run evidence",
      "gateway-owned inbound listener closure",
      "reserved-third-party",
      "must not contain token values",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/PLUGIN_REVIEW_GATE.md",
    [
      "# Plugin Review Gate",
      "pnpm plugin:review",
      "blue-tanuki.review.json",
      "used_for_authority=false",
      "no external npm dynamic import",
      "Plugin Review Gate result is review evidence only",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/v1.0-ga-promotion-review.md",
    [
      "# GA Promotion Review",
      "PENDING_OWNER_GO",
      "pnpm validate:ga",
      "public_claim_allowed=false",
      "status=pre_go_ready",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "scripts/channel_promotion_gate.ts",
    [
      "validateChannelPromotion",
      "BASELINE_FIRST_PARTY_CHANNELS",
      "PROMOTION_ELIGIBLE_CHANNELS",
      "reserved-third-party",
      "gateway-owned inbound listener",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "scripts/plugin_review_gate.ts",
    [
      "--package",
      "--bundled",
      "plugin-review",
      "reviewPluginPackage",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "scripts/ga_promotion_gate.ts",
    [
      "validateGaPromotionGate",
      "PENDING_OWNER_GO",
      "public_claim_allowed",
      "OWNER_DECISION_PATH",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "apps/gateway/src/plugin_review_gate.ts",
    [
      "reviewPluginPackage",
      "blue-tanuki.review.json",
      "layer_b_review_used_for_authority",
      "external_dynamic_imports",
      "hot_reload",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "package.json",
    '{"scripts":{"validate:channels":"x","plugin:review":"x","validate:ga":"x"}}',
  );
  await writeFixtureFile(
    root,
    "scripts/create_release_bundle.ts",
    [
      "CORE_RELEASE_PATHS",
      "docs/CHANNEL_PROMOTION_GATE.md",
      "docs/phase11-s12-plugin-review-gate-implementation.md",
      "docs/v1.0-ga-promotion-review.md",
      "docs/phase11-s13-v1-ga-promotion-execution.md",
      "scripts/ga_promotion_gate.ts",
      "scripts/plugin_review_gate.ts",
      "apps/gateway/src/plugin_review_gate.ts",
      "install/windows/install.ps1",
      "install/resident/README.md",
      "install/macos/install.sh",
      "install/linux/install.sh",
      ".sha256",
      ".manifest.json",
      "isSecretLikeFileName",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "scripts/verify_release_bundle.ts",
    [
      "sha256",
      "manifest",
      "core_release_paths",
      "EXTRACTED_RELEASE_COMMANDS",
      "pnpm\", \"run\", \"doctor",
      "validate:repo-health",
      "isForbiddenFileName",
      "install/resident/README.md",
      "docs/CHANNEL_PROMOTION_GATE.md",
      "scripts/plugin_review_gate.ts",
      "scripts/ga_promotion_gate.ts",
      "docs/v1.0-ga-promotion-review.md",
      "apps/gateway/src/plugin_review_gate.ts",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "scripts/validate_packaging.ts",
    [
      "Distribution readiness",
      "does not build signed native packages yet",
      "does not currently implement an automatic updater",
      "plugin:review",
      "validate:ga",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "install/windows/uninstall.ps1",
    "Purge DryRun Assert-SafeTarget resident-autostart-disable Data retained",
  );
  await writeFixtureFile(
    root,
    "install/macos/uninstall.sh",
    "PURGE DRY_RUN safe_target resident-autostart-disable Data retained",
  );
  await writeFixtureFile(
    root,
    "install/linux/uninstall.sh",
    "PURGE DRY_RUN safe_target resident-autostart-disable Config retained",
  );
}

describe("compareSemver", () => {
  it("orders versions correctly", () => {
    expect(compareSemver("22.14.0", "22.14.0")).toBe(0);
    expect(compareSemver("22.15.0", "22.14.0")).toBe(1);
    expect(compareSemver("22.14.0", "22.15.0")).toBe(-1);
    expect(compareSemver("23.0.0", "22.99.0")).toBe(1);
    expect(compareSemver("22.13.999", MIN_NODE_VERSION)).toBe(-1);
  });
});

describe("runDoctor — happy paths", () => {
  it("returns exit_code=0 when all required env present and node OK", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    // Optional preview env unset still emits WARN, but core doctor stays green.
    const r2 = await runDoctor({
      env: {
        ...baseEnv(),
        SLACK_BOT_TOKEN: "xoxb-aaa-bbb",
        SLACK_APP_TOKEN: "xapp-aaa-bbb",
        DISCORD_BOT_TOKEN: "discord-bot-token",
        MICROSOFT_GRAPH_ACCESS_TOKEN: "microsoft-graph-token",
        LINE_CHANNEL_ACCESS_TOKEN: "line-channel-token",
        ANTHROPIC_API_KEY: "sk-ant-abcdefghijkl",
        OPENROUTER_API_KEY: "sk-or-doctor-token",
        OPENROUTER_MODEL: "openrouter/model",
        COMPOSIO_API_KEY: "composio-doctor-token",
        COMPOSIO_ALLOWED_TOOLKITS: "github,gmail",
        COMPOSIO_DRY_RUN: "true",
        GITHUB_TOKEN: "ghp-doctor-token",
        BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r2.exit_code).toBe(0);
    expect(r2.ok).toBe(true);
    expect(r.exit_code).toBe(0);
  });

  it("emits safe-to-ignore warns for unset optional preview envs in core mode", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(0);
    expect(r.ok).toBe(true);
    const warned = r.checks.filter((c) => c.level === "warn").map((c) => c.id);
    expect(warned).toEqual(
      expect.arrayContaining([
        "env:SLACK_BOT_TOKEN",
        "env:DISCORD_BOT_TOKEN",
        "env:MICROSOFT_GRAPH_ACCESS_TOKEN",
        "env:LINE_CHANNEL_ACCESS_TOKEN",
        "env:OPENROUTER_API_KEY",
        "env:COMPOSIO_API_KEY",
        "composio_connector",
      ]),
    );
  });

  it("fails preview mode when preview channel credentials are missing", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
      mode: "preview",
    });
    expect(r.exit_code).toBe(2);
    expect(r.ok).toBe(false);
    const json = JSON.parse(formatJsonReport(r)) as typeof r;
    expect(json.checks.find((c) => c.id === "env:SLACK_BOT_TOKEN")).toMatchObject({
      level: "error",
      safe_to_ignore: false,
    });
  });

  it("marks strict-mode required optional credentials as not safe to ignore", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
      mode: "strict",
    });
    const json = JSON.parse(formatJsonReport(r)) as typeof r;
    expect(json.exit_code).toBe(2);
    expect(json.checks.find((c) => c.id === "env:ANTHROPIC_API_KEY")).toMatchObject({
      level: "error",
      safe_to_ignore: false,
    });
  });

  it("accepts configured read-only Google Daily Brief source", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_TARGET: "local-user",
        BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES: "gmail,calendar,drive",
        GOOGLE_ACCESS_TOKEN: "google-read-token",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "google_daily_brief_source")).toMatchObject({
      level: "ok",
      detail: "enabled services=gmail,calendar,drive token_status=present read_only=true",
    });
  });

  it("accepts a custom LLM backend registered by LLM_PROVIDERS_JSON", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        LLM_BACKEND: "fast",
        LLM_PROVIDERS_JSON: JSON.stringify([
          {
            name: "local-fast",
            endpoint: "http://localhost:11434/v1",
            model: "llama-local",
            aliases: ["fast"],
          },
        ]),
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "llm_backend")?.level).toBe("ok");
    expect(r.checks.find((c) => c.id === "llm_backend")?.detail).toContain(
      "fast",
    );
  });

  it("accepts an upstream LLM command route to a registered alias", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        LLM_PROVIDERS_JSON: JSON.stringify([
          {
            name: "local-fast",
            endpoint: "http://localhost:11434/v1",
            model: "llama-local",
            aliases: ["fast"],
          },
        ]),
        BLUE_TANUKI_LLM_BACKEND_HINT: "fast",
        BLUE_TANUKI_LLM_MODEL: "route-model",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.ok).toBe(true);
    expect(
      r.checks.find((c) => c.id === "llm_command_route")?.detail,
    ).toContain("backend=fast");
  });
});

describe("runDoctor — error paths", () => {
  it("exit_code=2 when WEBCHAT_TOKEN is missing", async () => {
    const env = baseEnv();
    delete env.WEBCHAT_TOKEN;
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.ok).toBe(false);
    expect(
      r.checks.find((c) => c.id === "env:WEBCHAT_TOKEN")?.level,
    ).toBe("error");
  });

  it("exit_code=2 when WEBCHAT_RESUME_TOKEN is missing", async () => {
    const env = baseEnv();
    delete env.WEBCHAT_RESUME_TOKEN;
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.ok).toBe(false);
    expect(
      r.checks.find((c) => c.id === "env:WEBCHAT_RESUME_TOKEN")?.level,
    ).toBe("error");
  });

  it("errors when Google Daily Brief source is enabled without read tokens", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        BLUE_TANUKI_DAILY_BRIEF_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_TARGET: "local-user",
        BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED: "1",
        BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES: "gmail,drive",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "google_daily_brief_source")).toMatchObject({
      level: "error",
      detail: "missing read token for gmail, drive; set service token or GOOGLE_ACCESS_TOKEN",
    });
  });

  it("exit_code=2 when WebChat tokens are not separated", async () => {
    const env = {
      ...baseEnv(),
      WEBCHAT_RESUME_TOKEN: baseEnv().WEBCHAT_TOKEN,
    };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "webchat_token_separation")?.level).toBe("error");
  });

  it("exit_code=2 when settings token reuses a WebChat token", async () => {
    const env = {
      ...baseEnv(),
      BLUE_TANUKI_SETTINGS_TOKEN: baseEnv().WEBCHAT_TOKEN,
    };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "settings_token")?.level).toBe("error");
  });

  it("exit_code=2 when webhook token is short or reuses a privileged token", async () => {
    const short = await runDoctor({
      env: { ...baseEnv(), WEBHOOK_TOKEN: "short" },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(short.exit_code).toBe(2);
    expect(short.checks.find((c) => c.id === "webhook_token")?.level).toBe("error");

    const reused = await runDoctor({
      env: { ...baseEnv(), WEBHOOK_TOKEN: baseEnv().WEBCHAT_TOKEN },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(reused.exit_code).toBe(2);
    expect(reused.checks.find((c) => c.id === "webhook_token")?.level).toBe("error");
  }, 10_000);

  it("exit_code=2 when generic schedule JSON is malformed", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        BLUE_TANUKI_SCHEDULES_JSON: "{not-json",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "cron_schedules")?.level).toBe("error");
  });

  it("exit_code=2 when Node.js is below MIN_NODE_VERSION", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "20.0.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "node_version")?.level).toBe("error");
  });

  it("exit_code=2 when LLM_BACKEND=anthropic but no key", async () => {
    const env = { ...baseEnv(), LLM_BACKEND: "anthropic" };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "llm_backend")?.level).toBe("error");
  });

  it("exit_code=2 when LLM_BACKEND=openrouter but no key", async () => {
    const env = { ...baseEnv(), LLM_BACKEND: "openrouter", OPENROUTER_MODEL: "openrouter/model" };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "llm_backend")?.detail).toContain(
      "OPENROUTER_API_KEY",
    );
  });

  it("exit_code=2 on unknown LLM_BACKEND value", async () => {
    const env = { ...baseEnv(), LLM_BACKEND: "made-up" };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "llm_backend")?.detail).toContain(
      "made-up",
    );
  });

  it("exit_code=2 on malformed LLM_PROVIDERS_JSON", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        LLM_BACKEND: "fast",
        LLM_PROVIDERS_JSON: JSON.stringify([{ name: "fast", model: "m" }]),
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "llm_backend")?.detail).toContain(
      "LLM_PROVIDERS_JSON",
    );
  });

  it("exit_code=2 when upstream LLM command route targets an unregistered backend", async () => {
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        BLUE_TANUKI_LLM_BACKEND_HINT: "missing",
      },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.exit_code).toBe(2);
    expect(r.checks.find((c) => c.id === "llm_command_route")?.detail).toContain(
      "missing",
    );
  });
});

describe("runDoctor — session_dir probe", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-doc-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ok when session_dir is writable", async () => {
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_SESSION_DIR: dir },
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "session_dir");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain(dir);
  });

  it("creates the directory if it does not exist", async () => {
    const sub = path.join(dir, "deep", "nest");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_SESSION_DIR: sub },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "session_dir")?.level).toBe("ok");
    const stat = await fs.stat(sub);
    expect(stat.isDirectory()).toBe(true);
  });

  it("error when session_dir cannot be created (path collides with file)", async () => {
    const file = path.join(dir, "conflict");
    await fs.writeFile(file, "x", "utf8");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_SESSION_DIR: file },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "session_dir")?.level).toBe("error");
    expect(r.exit_code).toBe(2);
  });
});

describe("runDoctor — audit_dir probe", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-aud-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ok when unset (in-memory audit only)", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "audit_dir");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toMatch(/in-memory/);
  });

  it("ok when audit_dir is writable", async () => {
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_AUDIT_DIR: dir },
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "audit_dir");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain(dir);
  });

  it("creates the directory if it does not exist", async () => {
    const sub = path.join(dir, "audit", "deep");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_AUDIT_DIR: sub },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "audit_dir")?.level).toBe("ok");
    const stat = await fs.stat(sub);
    expect(stat.isDirectory()).toBe(true);
  });

  it("error when path collides with a file", async () => {
    const file = path.join(dir, "conflict");
    await fs.writeFile(file, "x", "utf8");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_AUDIT_DIR: file },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "audit_dir")?.level).toBe("error");
    expect(r.exit_code).toBe(2);
  });
});

describe("runDoctor — file_root probe", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-file-root-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ok when unset (file tools disabled until configured)", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "file_root");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("unset");
  });

  it("ok when BLUE_TANUKI_FILE_ROOT is an existing writable directory", async () => {
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_FILE_ROOT: dir },
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "file_root");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("writable");
  });

  it("errors when BLUE_TANUKI_FILE_ROOT is not a directory", async () => {
    const filepath = path.join(dir, "not-dir");
    await fs.writeFile(filepath, "x", "utf8");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_FILE_ROOT: filepath },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "file_root")?.level).toBe("error");
    expect(r.exit_code).toBe(2);
  });
});

describe("runDoctor — shell_root probe", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-root-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ok when unset (shell.exec disabled until configured)", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "shell_root");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("unset");
  });

  it("ok when BLUE_TANUKI_SHELL_ROOT is an existing directory", async () => {
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_SHELL_ROOT: dir },
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "shell_root");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("directory");
  });

  it("errors when BLUE_TANUKI_SHELL_ROOT is not a directory", async () => {
    const filepath = path.join(dir, "not-dir");
    await fs.writeFile(filepath, "x", "utf8");
    const r = await runDoctor({
      env: { ...baseEnv(), BLUE_TANUKI_SHELL_ROOT: filepath },
      probe_port: false,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "shell_root")?.level).toBe("error");
    expect(r.exit_code).toBe(2);
  });
});

describe("runDoctor — port probe", () => {
  it("ok on a free port", async () => {
    const port = await freePort();
    const r = await runDoctor({
      env: {
        ...baseEnv(),
        WEBCHAT_PORT: String(port),
        WEBCHAT_HOST: "127.0.0.1",
      },
      probe_port: true,
      node_version: "22.14.0",
    });
    expect(r.checks.find((x) => x.id === "port")?.level).toBe("ok");
  });

  it("error when port is already in use", async () => {
    // Hold a port open during the probe.
    const holder = net.createServer();
    await new Promise<void>((res, rej) => {
      holder.listen(0, "127.0.0.1", res);
      holder.on("error", rej);
    });
    const addr = holder.address();
    const port = (addr as net.AddressInfo).port;
    try {
      const r = await runDoctor({
        env: {
          ...baseEnv(),
          WEBCHAT_PORT: String(port),
          WEBCHAT_HOST: "127.0.0.1",
        },
        probe_port: true,
        node_version: "22.14.0",
      });
      expect(r.checks.find((x) => x.id === "port")?.level).toBe("error");
      expect(r.exit_code).toBe(2);
    } finally {
      await new Promise<void>((res) => holder.close(() => res()));
    }
  });
});

describe("runDoctor — bundled manifests", () => {
  it("locates and reports manifests as ok in this repo", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "manifests");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("13 manifests valid");
  });

  it("validates manifest schemas from an explicit root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-mf-doc-"));
    try {
      await writeManifestFixture(root);
      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        manifest_root: root,
      });
      const c = r.checks.find((x) => x.id === "manifests");
      expect(c?.level).toBe("ok");
      expect(
        r.exit_code,
        JSON.stringify(r.checks.filter((c) => c.level === "error"), null, 2),
      ).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes core doctor in an extracted core release when preview packages are absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-core-release-doc-"));
    try {
      await writeManifestFixture(root);
      for (const rel of [
        "packages/channel-slack",
        "packages/channel-discord",
        "packages/channel-teams",
        "packages/channel-line",
        "install/installer",
        "install/resident",
        "install/windows",
        "install/macos",
      ]) {
        await fs.rm(path.join(root, rel), { recursive: true, force: true });
      }

      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        manifest_root: root,
        distribution_root: root,
      });

      expect(
        r.exit_code,
        JSON.stringify(r.checks.filter((c) => c.level === "error"), null, 2),
      ).toBe(0);
      expect(r.checks.find((c) => c.id === "manifests")?.detail).toContain(
        "preview manifests absent in core release",
      );
      expect(r.checks.find((c) => c.id === "distribution_readiness")?.detail).toContain(
        "preview-only paths absent in core release",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("errors when a manifest fails schema validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-mf-doc-"));
    try {
      await writeManifestFixture(root);
      await fs.writeFile(
        path.join(root, "packages", "protocol", "blue-tanuki.plugin.json"),
        JSON.stringify({
          name: "@blue-tanuki/protocol",
          version: "0.0.1",
          kind: "unknown",
          entry: "./dist/index.js",
        }),
        "utf8",
      );
      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        manifest_root: root,
      });
      const c = r.checks.find((x) => x.id === "manifests");
      expect(c?.level).toBe("error");
      expect(c?.detail).toContain("schema mismatch");
      expect(r.exit_code).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("errors when manifest name/version/entry drifts from package metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-mf-doc-"));
    try {
      await writeManifestFixture(root);
      await fs.writeFile(
        path.join(root, "packages", "hds-brain", "blue-tanuki.plugin.json"),
        JSON.stringify({
          name: "@blue-tanuki/wrong",
          version: "9.9.9",
          kind: "core",
          entry: "./dist/wrong.js",
        }),
        "utf8",
      );
      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        manifest_root: root,
      });
      const detail = r.checks.find((x) => x.id === "manifests")?.detail ?? "";
      expect(detail).toContain("name mismatch");
      expect(detail).toContain("version mismatch");
      expect(detail).toContain("entry must be ./dist/index.js");
      expect(r.exit_code).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — compatibility matrix gate", () => {
  it("locates and reports the compatibility matrix as ok in this repo", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "compatibility_matrix");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("promotion gate boundary verified");
  });

  it("errors when WhatsApp is promoted into first-party core scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-compat-doc-"));
    try {
      await writeManifestFixture(root);
      await fs.writeFile(
        path.join(root, "docs", "compatibility-matrix.json"),
        JSON.stringify({
          channels: {
            webchat: { status: "first-party", target_release: "v1.0" },
            telegram: { status: "first-party", target_release: "v1.0" },
            discord: { status: "first-party-preview", target_release: "v1.0-preview" },
            slack: { status: "first-party-preview", target_release: "v1.0-preview" },
            teams: { status: "first-party-preview", target_release: "v1.0-preview" },
            line: { status: "first-party-preview", target_release: "v1.0-preview" },
            whatsapp: {
              status: "first-party",
              target_release: "v1.0",
              core_supported: true,
              warranty: "none",
            },
          },
        }),
        "utf8",
      );
      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        manifest_root: root,
      });
      const detail = r.checks.find((x) => x.id === "compatibility_matrix")?.detail ?? "";
      expect(detail).toContain("whatsapp must remain reserved-third-party");
      expect(r.exit_code).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("runDoctor - distribution readiness gate", () => {
  it("locates and reports distribution readiness as ok in this repo", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const c = r.checks.find((x) => x.id === "distribution_readiness");
    expect(c?.level).toBe("ok");
    expect(c?.detail).toContain("install/update/uninstall/channel-promotion/plugin-review/ga-promotion surfaces verified");
  });

  it("errors when required installer docs are missing from an explicit root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-dist-doc-"));
    try {
      await writeManifestFixture(root);
      await fs.rm(path.join(root, "install", "README.md"), { force: true });
      const r = await runDoctor({
        env: baseEnv(),
        probe_port: false,
        node_version: "22.14.0",
        distribution_root: root,
      });
      const detail = r.checks.find((x) => x.id === "distribution_readiness")?.detail ?? "";
      expect(detail).toContain("install/README.md");
      expect(detail).toContain("cannot read portable installer docs");
      expect(r.exit_code).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Output formatters", () => {
  it("adds actionable remediation fields to every check", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    for (const c of r.checks) {
      expect(c.status).toMatch(/^(ok|warning|error)$/);
      expect(c.cause.length).toBeGreaterThan(0);
      expect(c.impact.length).toBeGreaterThan(0);
      expect(c.next_action.length).toBeGreaterThan(0);
      expect(c.doc_ref.length).toBeGreaterThan(0);
      expect(typeof c.safe_to_ignore).toBe("boolean");
    }
    expect(r.checks.find((c) => c.id === "env:SLACK_BOT_TOKEN")).toMatchObject({
      level: "warn",
      status: "warning",
      safe_to_ignore: true,
      doc_ref: "docs/CREDENTIAL_READINESS_MATRIX.md",
    });
  });

  it("formatTextReport contains all check labels", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const text = formatTextReport(r);
    for (const c of r.checks) {
      expect(text).toContain(c.label);
    }
    expect(text).toMatch(/^blue-tanuki doctor - /);
    expect(text).toContain("next_action:");
    expect(text).toContain("safe_to_ignore:");
    expect(text).toContain(`Exit code: ${r.exit_code}`);
  });

  it("formatJsonReport produces parseable JSON with all fields", async () => {
    const r = await runDoctor({
      env: baseEnv(),
      probe_port: false,
      node_version: "22.14.0",
    });
    const json = formatJsonReport(r);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(r.ok);
    expect(parsed.exit_code).toBe(r.exit_code);
    expect(parsed.timestamp).toBe(r.timestamp);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBe(r.checks.length);
    expect(parsed.checks[0]).toHaveProperty("status");
    expect(parsed.checks[0]).toHaveProperty("next_action");
  });

  it("never logs the WebChat token values (length only)", async () => {
    const env = {
      ...baseEnv(),
      WEBCHAT_TOKEN: "SECRET-VALUE-XYZ",
      WEBCHAT_RESUME_TOKEN: "RESUME-SECRET-VALUE-XYZ",
    };
    const r = await runDoctor({
      env,
      probe_port: false,
      node_version: "22.14.0",
    });
    const text = formatTextReport(r);
    expect(text).not.toContain("SECRET-VALUE-XYZ");
    expect(text).not.toContain("RESUME-SECRET-VALUE-XYZ");
    const json = formatJsonReport(r);
    expect(json).not.toContain("SECRET-VALUE-XYZ");
    expect(json).not.toContain("RESUME-SECRET-VALUE-XYZ");
  });
});
