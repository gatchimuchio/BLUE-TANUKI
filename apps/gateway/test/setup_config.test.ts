import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  createDefaultSetupConfig,
  renderSetupEnvFile,
  setupConfigFromEnv,
  setupConfigToEnv,
  validateSetupConfig,
  type BlueTanukiSetupConfig,
} from "../src/setup_config.js";

describe("setup_config", () => {
  it("creates a safe offline default config", () => {
    const config = createDefaultSetupConfig({ base_dir: "local-data" });
    expect(config.schema_version).toBe(1);
    expect(config.llm.provider).toBe("stub");
    expect(config.webchat.token).not.toBe(config.webchat.resume_token);
    expect(config.webchat.maintenance_token).not.toBe(config.webchat.token);
    expect(config.webchat.maintenance_token).not.toBe(config.webchat.resume_token);
    expect(config.settings.token).not.toBe(config.webchat.token);
    expect(config.webchat.token.length).toBeGreaterThanOrEqual(16);

    const env = setupConfigToEnv(config);
    expect(env.LLM_BACKEND).toBe("stub");
    expect(env.BLUE_TANUKI_APPROVAL_MODE).toBe("full_access");
    expect(env.BLUE_TANUKI_FILE_ROOT).toBe(path.resolve("local-data", "files"));
    expect(env.WEBCHAT_TOKEN).toBe(config.webchat.token);
    expect(env.BLUE_TANUKI_MAINTENANCE_TOKEN).toBe(config.webchat.maintenance_token);
    expect(env.BLUE_TANUKI_SETTINGS_TOKEN).toBe(config.settings.token);
  });

  it("renders an OpenAI-compatible provider into runtime env", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "openai-compatible",
      endpoint: "http://localhost:11434/v1",
      model: "llama-local",
      api_key: "local-secret",
      temperature: 0.2,
      max_tokens: 512,
      timeout_ms: 15_000,
    };

    const env = setupConfigToEnv(config);
    expect(env.LLM_BACKEND).toBe("openai-compatible");
    expect(env.OPENAI_COMPAT_ENDPOINT).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_COMPAT_MODEL).toBe("llama-local");
    expect(env.OPENAI_COMPAT_API_KEY).toBe("local-secret");
    expect(env.BLUE_TANUKI_LLM_MAX_TOKENS).toBe("512");

    const file = renderSetupEnvFile(config);
    expect(file).toContain("OPENAI_COMPAT_ENDPOINT=http://localhost:11434/v1");
    expect(file).toContain("WEBCHAT_RESUME_TOKEN=");
    expect(file).toContain("BLUE_TANUKI_MAINTENANCE_TOKEN=");
    expect(file).toContain("BLUE_TANUKI_SETTINGS_TOKEN=");
    expect(file).toContain("BLUE_TANUKI_APPROVAL_MODE=full_access");
  });

  it("round-trips explicit first-run approval mode", () => {
    const config = createDefaultSetupConfig();
    config.approval.mode = "ask_every_time";

    const env = setupConfigToEnv(config);
    expect(env.BLUE_TANUKI_APPROVAL_MODE).toBe("ask_every_time");

    const parsed = setupConfigFromEnv({
      BLUE_TANUKI_APPROVAL_MODE: "remember_this_decision",
      WEBCHAT_TOKEN: "webchat-token-123456",
      WEBCHAT_RESUME_TOKEN: "resume-token-123456",
      BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
    });
    expect(parsed.approval.mode).toBe("remember_this_decision");

    config.approval.mode = "invalid" as never;
    expect(() => validateSetupConfig(config)).toThrow(/approval.mode/);
  });

  it("renders OpenRouter and Composio settings into runtime env", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "openrouter",
      model: "openrouter/model",
      api_key: "openrouter-secret",
      site_url: "https://blue-tanuki.local",
      app_title: "BLUE-TANUKI",
    };
    config.composio = {
      api_key: "composio-secret",
      allowed_toolkits: "github,gmail",
      allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
      revoked_actions: "github:GITHUB_DELETE_REPO",
      user_id: "owner-local",
      api_base_url: "https://backend.composio.dev",
      dry_run: true,
      live_execution: false,
    };

    const env = setupConfigToEnv(config);
    expect(env.LLM_BACKEND).toBe("openrouter");
    expect(env.OPENROUTER_MODEL).toBe("openrouter/model");
    expect(env.OPENROUTER_API_KEY).toBe("openrouter-secret");
    expect(env.OPENROUTER_SITE_URL).toBe("https://blue-tanuki.local");
    expect(env.OPENROUTER_APP_TITLE).toBe("BLUE-TANUKI");
    expect(env.COMPOSIO_API_KEY).toBe("composio-secret");
    expect(env.COMPOSIO_ALLOWED_TOOLKITS).toBe("github,gmail");
    expect(env.COMPOSIO_ALLOWED_ACTIONS).toBe("github:GITHUB_CREATE_AN_ISSUE");
    expect(env.COMPOSIO_REVOKED_ACTIONS).toBe("github:GITHUB_DELETE_REPO");
    expect(env.COMPOSIO_USER_ID).toBe("owner-local");
    expect(env.COMPOSIO_API_BASE_URL).toBe("https://backend.composio.dev");
    expect(env.COMPOSIO_DRY_RUN).toBe("true");
    expect(env.COMPOSIO_LIVE_EXECUTION).toBe("false");
  });

  it("renders LLM secret references without raw API key material", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "openrouter",
      model: "openrouter/model",
      api_key_ref: "win32-dpapi-current-user:file:abc",
    };

    const env = setupConfigToEnv(config);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY_REF).toBe("win32-dpapi-current-user:file:abc");

    const file = renderSetupEnvFile(config);
    expect(file).not.toContain("OPENROUTER_API_KEY=");
    expect(file).toContain("OPENROUTER_API_KEY_REF=win32-dpapi-current-user:file:abc");
  });

  it("builds setup config from LLM secret references", () => {
    const config = setupConfigFromEnv({
      LLM_BACKEND: "openrouter",
      OPENROUTER_API_KEY_REF: "win32-dpapi-current-user:file:abc",
      OPENROUTER_MODEL: "openrouter/model",
      WEBCHAT_TOKEN: "webchat-token-123456",
      WEBCHAT_RESUME_TOKEN: "resume-token-123456",
      BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
    });
    expect(config.llm.provider).toBe("openrouter");
    expect(config.llm.api_key).toBeUndefined();
    expect(config.llm.api_key_ref).toBe("win32-dpapi-current-user:file:abc");
  });

  it("builds setup config from runtime env", () => {
    const config = setupConfigFromEnv({
      LLM_BACKEND: "openai-compatible",
      OPENAI_COMPAT_ENDPOINT: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "model-a",
      WEBCHAT_TOKEN: "webchat-token-123456",
      WEBCHAT_RESUME_TOKEN: "resume-token-123456",
      BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
      BLUE_TANUKI_FILE_ROOT: "sandbox",
      BLUE_TANUKI_SESSION_DIR: "sessions",
      BLUE_TANUKI_AUDIT_DIR: "audit",
    });
    expect(config.llm.provider).toBe("openai-compatible");
    expect(config.llm.model).toBe("model-a");
    expect(config.settings.token).toBe("settings-token-123456");
  });

  it("builds OpenRouter and Composio setup config from runtime env", () => {
    const config = setupConfigFromEnv({
      LLM_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_MODEL: "openrouter/model",
      OPENROUTER_SITE_URL: "https://blue-tanuki.local",
      OPENROUTER_APP_TITLE: "BLUE-TANUKI",
      COMPOSIO_API_KEY: "composio-secret",
      COMPOSIO_ALLOWED_TOOLKITS: "github,gmail",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
      COMPOSIO_REVOKED_ACTIONS: "github:GITHUB_DELETE_REPO",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_API_BASE_URL: "https://backend.composio.dev",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
      WEBCHAT_TOKEN: "webchat-token-123456",
      WEBCHAT_RESUME_TOKEN: "resume-token-123456",
      BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
    });
    expect(config.llm.provider).toBe("openrouter");
    expect(config.llm.model).toBe("openrouter/model");
    expect(config.llm.site_url).toBe("https://blue-tanuki.local");
    expect(config.composio).toEqual({
      api_key: "composio-secret",
      allowed_toolkits: "github,gmail",
      allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
      revoked_actions: "github:GITHUB_DELETE_REPO",
      user_id: "owner-local",
      api_base_url: "https://backend.composio.dev",
      dry_run: false,
      live_execution: true,
    });
  });

  it("resolves api_key_env from the supplied source env", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "anthropic",
      model: "claude-local-test",
      api_key_env: "TEST_ANTHROPIC_KEY",
    };
    const env = setupConfigToEnv(config, {
      source_env: { TEST_ANTHROPIC_KEY: "secret-from-env" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("secret-from-env");
  });

  it("fails closed on incomplete provider setup", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "openai-compatible",
      model: "missing-endpoint",
    };
    expect(() => validateSetupConfig(config)).toThrow(/endpoint/);

    const badTokens: BlueTanukiSetupConfig = createDefaultSetupConfig();
    badTokens.webchat.resume_token = badTokens.webchat.token;
    expect(() => validateSetupConfig(badTokens)).toThrow(/differ/);
  });

  it("fails closed when api_key_env is declared but unavailable", () => {
    const config = createDefaultSetupConfig();
    config.llm = {
      provider: "openai",
      model: "model",
      api_key_env: "MISSING_OPENAI_KEY",
    };
    expect(() => setupConfigToEnv(config, { source_env: {} })).toThrow(
      /MISSING_OPENAI_KEY/,
    );
  });
});
