import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PluginRuntime } from "../src/plugin_loader.js";
import {
  buildSettingsSnapshot,
  createWebChatSettingsSurface,
  settingsSurfaceAllowed,
  updateSettingsEnvFile,
} from "../src/settings_surface.js";
import { verifyLlmProvisioning } from "../src/control_center/setup/api_settings.js";
import {
  createDefaultSetupConfig,
  renderSetupEnvFile,
} from "../src/setup_config.js";

function runtime(): PluginRuntime {
  return new PluginRuntime("/tmp/blue-tanuki", [
    {
      package_dir: "/tmp/blue-tanuki/packages/channel-webchat",
      package_json: {
        name: "@blue-tanuki/channel-webchat",
        version: "0.0.2",
        main: "./dist/index.js",
      },
      manifest: {
        name: "@blue-tanuki/channel-webchat",
        version: "0.0.2",
        kind: "channel",
        entry: "./dist/index.js",
        exports: { channel: "WebChatChannel" },
        permissions: [
          "network:listen",
          "secrets:WEBCHAT_TOKEN",
          "secrets:WEBCHAT_RESUME_TOKEN",
          "secrets:BLUE_TANUKI_SETTINGS_TOKEN",
        ],
      },
    },
  ]);
}

describe("settings surface", () => {
  it("returns a redacted settings snapshot", () => {
    const snapshot = buildSettingsSnapshot(
      {
        LLM_BACKEND: "openai-compatible",
        OPENAI_COMPAT_ENDPOINT: "http://localhost:11434/v1",
        OPENAI_COMPAT_MODEL: "local-model",
        OPENAI_COMPAT_API_KEY: "local-super-secret-xyz",
        OPENROUTER_API_KEY: "openrouter-super-secret-xyz",
        OPENROUTER_MODEL: "openrouter/model",
        COMPOSIO_API_KEY: "composio-super-secret-xyz",
        COMPOSIO_ALLOWED_TOOLKITS: "github,gmail",
        COMPOSIO_DRY_RUN: "true",
        WEBCHAT_TOKEN: "webchat-token-123456",
        WEBCHAT_RESUME_TOKEN: "resume-token-123456",
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        BLUE_TANUKI_FILE_ROOT: "sandbox",
        BLUE_TANUKI_SESSION_DIR: "sessions",
        BLUE_TANUKI_AUDIT_DIR: "audit",
      },
      runtime(),
    );
    expect(snapshot.llm.provider).toBe("openai-compatible");
    expect(snapshot.llm.api_key_set).toBe(true);
    expect(snapshot.integrations.openrouter.configured).toBe(true);
    expect(snapshot.integrations.openrouter.used_for_authority).toBe(false);
    expect(snapshot.integrations.composio.configured).toBe(true);
    expect(snapshot.integrations.composio.dry_run).toBe(true);
    expect(snapshot.integrations.composio.used_for_authority).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("local-super-secret-xyz");
    expect(JSON.stringify(snapshot)).not.toContain("openrouter-super-secret-xyz");
    expect(JSON.stringify(snapshot)).not.toContain("composio-super-secret-xyz");
    expect(snapshot.plugins[0]?.permissions).toContain(
      "secrets:BLUE_TANUKI_SETTINGS_TOKEN",
    );
  });

  it("writes settings updates back to BLUE_TANUKI_ENV_FILE", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-settings-"));
    try {
      const envFile = path.join(dir, "blue-tanuki.env");
      const config = createDefaultSetupConfig({ base_dir: path.join(dir, "data") });
      await fs.writeFile(envFile, renderSetupEnvFile(config), "utf8");

      const result = await updateSettingsEnvFile(
        {
          llm: {
            provider: "openrouter",
            model: "openrouter/model",
            api_key: "openrouter-secret",
            site_url: "https://blue-tanuki.local",
            app_title: "BLUE-TANUKI",
            max_tokens: "512",
          },
          composio: {
            api_key: "composio-secret",
            allowed_toolkits: "github,gmail",
            dry_run: "true",
          },
          webchat: { host: "127.0.0.1", port: "8877" },
          paths: { file_root: path.join(dir, "files") },
        },
        { BLUE_TANUKI_ENV_FILE: envFile },
      );

      expect(result.restart_required).toBe(true);
      expect(result.backup_path).toBeTruthy();
      const raw = await fs.readFile(envFile, "utf8");
      expect(raw).toContain("LLM_BACKEND=openrouter");
      expect(raw).toContain("OPENROUTER_MODEL=openrouter/model");
      expect(raw).toContain("OPENROUTER_API_KEY=openrouter-secret");
      expect(raw).toContain("OPENROUTER_SITE_URL=https://blue-tanuki.local");
      expect(raw).toContain("OPENROUTER_APP_TITLE=BLUE-TANUKI");
      expect(raw).toContain("COMPOSIO_API_KEY=composio-secret");
      expect(raw).toContain("COMPOSIO_ALLOWED_TOOLKITS=github,gmail");
      expect(raw).toContain("COMPOSIO_DRY_RUN=true");
      expect(raw).toContain("WEBCHAT_PORT=8877");
      const backupRaw = await fs.readFile(result.backup_path!, "utf8");
      expect(backupRaw).toContain("LLM_BACKEND=stub");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies candidate stub LLM settings without writing secrets", async () => {
    const result = await verifyLlmProvisioning(
      { llm: { provider: "stub" } },
      {
        WEBCHAT_TOKEN: "webchat-token-123456",
        WEBCHAT_RESUME_TOKEN: "resume-token-123456",
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
      },
      runtime(),
    );
    expect(result.status).toBe("pass");
    expect(result.changed).toBe(false);
    expect(result.secret_exposed).toBe(false);
    expect(result.detail).not.toContain("settings-token-123456");
  });

  it("reports LLM verification failures as safe non-mutating results", async () => {
    const result = await verifyLlmProvisioning(
      {
        llm: {
          provider: "openai-compatible",
          model: "missing-endpoint",
          api_key: "candidate-secret-123456",
        },
      },
      {
        WEBCHAT_TOKEN: "webchat-token-123456",
        WEBCHAT_RESUME_TOKEN: "resume-token-123456",
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
      },
      runtime(),
    );
    expect(result.status).toBe("fail");
    expect(result.changed).toBe(false);
    expect(result.safe).toBe(true);
    expect(result.detail).not.toContain("candidate-secret-123456");
    expect(result.next_action).toContain("Check provider");
  });

  it("exposes settings surface only when a settings token is configured", () => {
    expect(createWebChatSettingsSurface({ env: {}, plugins: runtime() })).toBeUndefined();
    expect(
      createWebChatSettingsSurface({
        env: { BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456" },
        plugins: runtime(),
      })?.token,
    ).toBe("settings-token-123456");
  });

  it("keeps settings loopback-only unless explicitly enabled", () => {
    expect(
      settingsSurfaceAllowed({
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        WEBCHAT_HOST: "127.0.0.1",
      }),
    ).toBe(true);
    expect(
      settingsSurfaceAllowed({
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        WEBCHAT_HOST: "0.0.0.0",
      }),
    ).toBe(false);
    expect(
      settingsSurfaceAllowed({
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        WEBCHAT_HOST: "0.0.0.0",
        BLUE_TANUKI_ENABLE_SETTINGS: "1",
      }),
    ).toBe(true);
  });
});
