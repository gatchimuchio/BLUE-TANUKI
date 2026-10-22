import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMComputeAdapter, LLM_COMPUTE_PROFILE, type ComputeRequest, type LLMRequest } from "@blue-tanuki/core";
import { PluginRuntime } from "../src/plugin_loader.js";
import { GatewayComputeBudgetStore } from "../src/compute_budget_store.js";
import { parseEnvFile } from "../src/env_file.js";
import { buildLLMBackendFromEnv } from "../src/llm_config.js";
import {
  buildSettingsSnapshot,
  createWebChatSettingsSurface,
  renderSettingsHtml,
  settingsSurfaceAllowed,
  updateSettingsEnvFile,
} from "../src/settings_surface.js";
import { assessLlmComputeReadiness, verifyLlmProvisioning } from "../src/control_center/setup/api_settings.js";
import {
  createDefaultSetupConfig,
  renderSetupEnvFile,
} from "../src/setup_config.js";

const fakeSecretProtector = {
  protect: (plaintext: string) => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64url"),
  unprotect: (protectedValue: string) => {
    const decoded = Buffer.from(protectedValue, "base64url").toString("utf8");
    if (!decoded.startsWith("protected:")) throw new Error("bad test secret");
    return decoded.slice("protected:".length);
  },
};

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
          "secrets:BLUE_TANUKI_MAINTENANCE_TOKEN",
          "secrets:BLUE_TANUKI_SETTINGS_TOKEN",
        ],
      },
    },
    {
      package_dir: "/tmp/blue-tanuki/packages/blue-tanuki",
      package_json: {
        name: "@blue-tanuki/core",
        version: "0.0.2",
        main: "./dist/index.js",
      },
      manifest: {
        name: "@blue-tanuki/core",
        version: "0.0.2",
        kind: "core",
        entry: "./dist/index.js",
        exports: {},
        permissions: ["network:llm-provider", "secrets:OPENAI_COMPAT_API_KEY"],
      },
    },
    {
      package_dir: "/tmp/blue-tanuki/packages/channel-slack",
      package_json: {
        name: "@blue-tanuki/channel-slack",
        version: "1.0.0-rc.1",
        main: "./dist/index.js",
      },
      manifest: {
        name: "@blue-tanuki/channel-slack",
        version: "1.0.0-rc.1",
        kind: "channel",
        entry: "./dist/index.js",
        exports: { channel: "SlackChannel" },
        permissions: ["network:slack.com", "secrets:SLACK_BOT_TOKEN", "secrets:SLACK_APP_TOKEN"],
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
        COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
        COMPOSIO_REVOKED_ACTIONS: "github:GITHUB_DELETE_REPO",
        COMPOSIO_USER_ID: "owner-local",
        COMPOSIO_DRY_RUN: "false",
        COMPOSIO_LIVE_EXECUTION: "true",
        WEBCHAT_TOKEN: "webchat-token-123456",
        WEBCHAT_RESUME_TOKEN: "resume-token-123456",
        BLUE_TANUKI_MAINTENANCE_TOKEN: "maintenance-token-123456",
        BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        BLUE_TANUKI_APPROVAL_MODE: "remember_this_decision",
        BLUE_TANUKI_FILE_ROOT: "sandbox",
        BLUE_TANUKI_SESSION_DIR: "sessions",
        BLUE_TANUKI_AUDIT_DIR: "audit",
      },
      runtime(),
    );
    expect(snapshot.llm.provider).toBe("openai-compatible");
    expect(snapshot.approval).toMatchObject({
      mode: "remember_this_decision",
      final_review_remains_required: true,
      used_for_authority: false,
    });
    expect(snapshot.llm.api_key_set).toBe(true);
    expect(snapshot.llm.secret_storage).toMatchObject({
      configured_key: "OPENAI_COMPAT_API_KEY",
      raw_env_present: true,
      os_protected: false,
      used_for_authority: false,
    });
    expect(snapshot.integrations.openrouter.configured).toBe(true);
    expect(snapshot.integrations.openrouter.used_for_authority).toBe(false);
    expect(snapshot.integrations.composio.configured).toBe(true);
    expect(snapshot.integrations.composio.dry_run).toBe(false);
    expect(snapshot.integrations.composio.live_execution_enabled).toBe(true);
    expect(snapshot.integrations.composio.live_execution_available).toBe(true);
    expect(snapshot.integrations.composio.user_id_set).toBe(true);
    expect(snapshot.integrations.composio.connection_revoke_available).toBe(true);
    expect(snapshot.integrations.composio.allowed_actions).toEqual(["github:github_create_an_issue"]);
    expect(snapshot.integrations.composio.revoked_actions).toEqual(["github:github_delete_repo"]);
    expect(snapshot.integrations.composio.used_for_authority).toBe(false);
    expect(snapshot.webchat).toMatchObject({
      token_set: true,
      resume_token_set: true,
      maintenance_token_set: true,
      settings_token_set: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("local-super-secret-xyz");
    expect(JSON.stringify(snapshot)).not.toContain("openrouter-super-secret-xyz");
    expect(JSON.stringify(snapshot)).not.toContain("composio-super-secret-xyz");
    expect(snapshot.plugins[0]?.permissions).toContain(
      "secrets:BLUE_TANUKI_SETTINGS_TOKEN",
    );
    expect(snapshot.plugins[0]?.permissions).toContain(
      "secrets:BLUE_TANUKI_MAINTENANCE_TOKEN",
    );
  });

  it("projects Slack setup state without probing, exposing credentials, or granting authority", () => {
    const unconfigured = buildSettingsSnapshot({}, runtime()).integrations.slack;
    expect(unconfigured).toMatchObject({
      status: "not_configured",
      plugin_available: true,
      bot_token_set: false,
      app_token_set: false,
      inbound_grants: "deny_all",
      preview_only: true,
      live_connection_checked: false,
      used_for_authority: false,
    });

    const partial = buildSettingsSnapshot({ SLACK_BOT_TOKEN_REF: "protected-token-ref" }, runtime()).integrations.slack;
    expect(partial).toMatchObject({
      status: "incomplete_credentials",
      bot_token_set: true,
      app_token_set: false,
    });

    const invalidGrants = buildSettingsSnapshot({
      SLACK_BOT_TOKEN: "xoxb-secret-fixture",
      SLACK_APP_TOKEN: "xapp-secret-fixture",
      SLACK_INBOUND_GRANTS_JSON: "not-json",
    }, runtime()).integrations.slack;
    expect(invalidGrants).toMatchObject({
      status: "invalid_inbound_grants",
      inbound_grants: "invalid",
      live_connection_checked: false,
    });

    const grant = {
      team_id: "T12345",
      channel_id: "C12345",
      user_id: "U12345",
      thread_ts: null,
    };
    const configuredSnapshot = buildSettingsSnapshot({
      SLACK_BOT_TOKEN: "xoxb-secret-fixture",
      SLACK_APP_TOKEN: "xapp-secret-fixture",
      SLACK_INBOUND_GRANTS_JSON: JSON.stringify([grant]),
    }, runtime());
    expect(configuredSnapshot.integrations.slack).toMatchObject({
      status: "configured_unverified",
      inbound_grants: "configured",
      preview_only: true,
      live_connection_checked: false,
      used_for_authority: false,
    });
    expect(JSON.stringify(configuredSnapshot)).not.toContain("xoxb-secret-fixture");
    expect(JSON.stringify(configuredSnapshot)).not.toContain("xapp-secret-fixture");
    expect(JSON.stringify(configuredSnapshot)).not.toContain("T12345");
    expect(JSON.stringify(configuredSnapshot)).not.toContain("C12345");
    expect(JSON.stringify(configuredSnapshot)).not.toContain("U12345");

    const missingPlugin = buildSettingsSnapshot({}, new PluginRuntime("/tmp/blue-tanuki", [])).integrations.slack;
    expect(missingPlugin).toMatchObject({ status: "plugin_unavailable", plugin_available: false });
  });

  it("shows Slack setup guidance as read-only in Control Center Connections", () => {
    const html = renderSettingsHtml();
    expect(html).toContain('id="slack-status"');
    expect(html).toContain('id="slack-next-action"');
    expect(html).toContain("This is configuration status only. It does not test Slack connectivity");
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
            allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
            revoked_actions: "github:GITHUB_DELETE_REPO",
            user_id: "owner-local",
            dry_run: "false",
            live_execution: "true",
          },
          webchat: { host: "127.0.0.1", port: "8877" },
          approval: { mode: "ask_every_time" },
          paths: { file_root: path.join(dir, "files") },
        },
        { BLUE_TANUKI_ENV_FILE: envFile },
        { platform: "linux" },
      );

      expect(result.restart_required).toBe(true);
      expect(result.backup_path).toBeTruthy();
      expect(result.secret_storage.llm_api_key).toMatchObject({
        status: "plaintext_env_fallback",
        key: "OPENROUTER_API_KEY",
        os_protected: false,
        used_for_authority: false,
      });
      const raw = await fs.readFile(envFile, "utf8");
      expect(raw).toContain("LLM_BACKEND=openrouter");
      expect(raw).toContain("OPENROUTER_MODEL=openrouter/model");
      expect(raw).toContain("OPENROUTER_API_KEY=openrouter-secret");
      expect(raw).toContain("OPENROUTER_SITE_URL=https://blue-tanuki.local");
      expect(raw).toContain("OPENROUTER_APP_TITLE=BLUE-TANUKI");
      expect(raw).toContain("COMPOSIO_API_KEY=composio-secret");
      expect(raw).toContain("COMPOSIO_ALLOWED_TOOLKITS=github,gmail");
      expect(raw).toContain("COMPOSIO_ALLOWED_ACTIONS=github:GITHUB_CREATE_AN_ISSUE");
      expect(raw).toContain("COMPOSIO_REVOKED_ACTIONS=github:GITHUB_DELETE_REPO");
      expect(raw).toContain("COMPOSIO_USER_ID=owner-local");
      expect(raw).toContain("COMPOSIO_DRY_RUN=false");
      expect(raw).toContain("COMPOSIO_LIVE_EXECUTION=true");
      expect(raw).toContain("WEBCHAT_PORT=8877");
      expect(raw).toContain("BLUE_TANUKI_APPROVAL_MODE=ask_every_time");
      const backupRaw = await fs.readFile(result.backup_path!, "utf8");
      expect(backupRaw).toContain("LLM_BACKEND=stub");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stores Windows LLM settings secrets as refs without plaintext fallback", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-settings-secret-"));
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
          },
        },
        { BLUE_TANUKI_ENV_FILE: envFile },
        { platform: "win32", protector: fakeSecretProtector },
      );

      expect(result.secret_storage.llm_api_key).toMatchObject({
        status: "stored",
        key: "OPENROUTER_API_KEY",
        storage: "win32_dpapi_current_user",
        os_protected: true,
        used_for_authority: false,
      });
      const raw = await fs.readFile(envFile, "utf8");
      expect(raw).toContain("OPENROUTER_API_KEY_REF=win32-dpapi-current-user:file:");
      expect(raw).not.toContain("OPENROUTER_API_KEY=openrouter-secret");
      expect(raw).not.toContain("openrouter-secret");

      const secretRaw = await fs.readFile(path.join(dir, "secrets", "openrouter_api_key.dpapi"), "utf8");
      expect(secretRaw).not.toContain("openrouter-secret");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("clears Composio connection material and closes live execution", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-settings-"));
    try {
      const envFile = path.join(dir, "blue-tanuki.env");
      const config = createDefaultSetupConfig({ base_dir: path.join(dir, "data") });
      config.composio = {
        api_key: "composio-secret",
        allowed_toolkits: "github",
        allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
        user_id: "owner-local",
        dry_run: false,
        live_execution: true,
      };
      await fs.writeFile(envFile, renderSetupEnvFile(config), "utf8");

      await updateSettingsEnvFile(
        {
          composio: {
            clear_api_key: true,
            live_execution: "true",
            dry_run: "false",
          },
        },
        { BLUE_TANUKI_ENV_FILE: envFile },
      );

      const raw = await fs.readFile(envFile, "utf8");
      expect(raw).not.toContain("COMPOSIO_API_KEY=");
      expect(raw).toContain("COMPOSIO_DRY_RUN=true");
      expect(raw).toContain("COMPOSIO_LIVE_EXECUTION=false");
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
    expect(result.compute_readiness.status).toBe("ready");
    expect(result.compute_readiness.current_window_usage_checked).toBe(false);
  });

  it("keeps provider connectivity separate from normal Compute readiness", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "fixture-verify",
      object: "chat.completion",
      model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content: "BLUE-TANUKI-SETUP-OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const result = await verifyLlmProvisioning(
        { llm: { provider: "openai-compatible", model: "fixture-model", endpoint: "https://fixture.invalid/v1", api_key: "candidate-secret-123456" } },
        {
          WEBCHAT_TOKEN: "webchat-token-123456",
          WEBCHAT_RESUME_TOKEN: "resume-token-123456",
          BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456",
        },
        runtime(),
      );
      expect(result.status, result.detail).toBe("pass");
      expect(result.detail).toContain("provider responded");
      expect(result.compute_readiness.status).toBe("blocked");
      expect(result.compute_readiness.detail).toContain("maximum cost profile");
      expect(result.next_action).toContain("normal Compute is blocked");
      expect(JSON.stringify(result)).not.toContain("candidate-secret-123456");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists GUI cost profiles and budgets for the normal Compute route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-settings-compute-"));
    const profileJson = JSON.stringify({
      "openai-compatible": {
        capabilities: ["llm.text.generate"],
        max_cost_per_attempt: { amount: 0.02, currency: "USD" },
      },
    });
    const policy = {
      window_ms: 86_400_000,
      currency: "USD",
      system: { max_tokens: 1_000_000, max_compute_ms: 86_400_000, max_cost: { amount: 1, currency: "USD" } },
      parent: { max_tokens: 10_000, max_compute_ms: 3_600_000, max_cost: { amount: 0.5, currency: "USD" } },
      task: { max_tokens: 1_000, max_compute_ms: 300_000, max_cost: { amount: 0.1, currency: "USD" } },
    };
    const policyJson = JSON.stringify(policy);
    try {
      const envFile = path.join(dir, "blue-tanuki.env");
      await fs.writeFile(envFile, renderSetupEnvFile(createDefaultSetupConfig({ base_dir: path.join(dir, "data") })), "utf8");
      await updateSettingsEnvFile({
        llm: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1",
          model: "fixture-model",
          api_key: "fixture-key-only",
          max_tokens: "128",
          timeout_ms: "5000",
          provider_cost_profiles_json: profileJson,
          compute_budget_policy_json: policyJson,
        },
      }, { BLUE_TANUKI_ENV_FILE: envFile }, { platform: "linux" });

      const surface = createWebChatSettingsSurface({
        env: { BLUE_TANUKI_ENV_FILE: envFile, BLUE_TANUKI_SETTINGS_TOKEN: "settings-token-123456" },
        plugins: runtime(),
      });
      expect(surface).toBeDefined();
      const snapshot = await surface!.getSnapshot();
      expect(snapshot.llm.provider_cost_profiles_json).toBe(profileJson);
      expect(snapshot.llm.compute_budget_policy_json).toBe(policyJson);
      expect(snapshot.llm.compute_readiness).toMatchObject({
        status: "ready",
        max_tokens: 128,
        max_compute_ms: 5_000,
        max_cost_amount: 0.02,
        currency: "USD",
        maximum_provider_attempts: 1,
        current_window_usage_checked: false,
        evidence_source: ["CONFIG"],
      });
      expect(renderSettingsHtml()).toContain("llm-provider-cost-profiles");
      expect(renderSettingsHtml()).toContain("llm-compute-budget-policy");

      const runtimeEnv = {
        ...parseEnvFile(await fs.readFile(envFile, "utf8")).values,
        BLUE_TANUKI_STATE_ROOT: path.join(dir, "state"),
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
        id: "fixture-compute",
        object: "chat.completion",
        model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "saved GUI settings reached normal Compute" },
          finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const budget = GatewayComputeBudgetStore.fromEnvironment(runtimeEnv);
      try {
        const request: ComputeRequest<LLMRequest> = {
          request_id: "settings-saved-normal-compute",
          current_projection_digest: "a".repeat(64),
          input_digest: "b".repeat(64),
          c_profile: LLM_COMPUTE_PROFILE,
          local_p_version: "blue-tanuki.c-input-rules.v1",
          data_exposure_scope: {
            input_sources: ["accepted_inbound_request"],
            requested_egress_provider: "openai-compatible",
          },
          budget_scope: {
            parent_task_identity_digest: "c".repeat(64),
            task_identity_digest: "d".repeat(64),
          },
          resource_limits: { max_tokens: 128, timeout_ms: 5_000 },
          input: {
            backend_hint: "openai-compatible",
            model: "fixture-model",
            max_tokens: 128,
            messages: [{ role: "user", content: "synthetic saved GUI settings" }],
          },
        };
        const result = await new LLMComputeAdapter(buildLLMBackendFromEnv(runtimeEnv), budget).compute(request);
        expect(result.content).toBe("saved GUI settings reached normal Compute");
        expect(result.compute_resource_use).toMatchObject({
          charged_tokens: 4,
          tokens_usage_status: "provider_reported",
          cost_status: "unknown",
          charged_cost_amount: 0.02,
          currency: "USD",
          charge_basis: "reserved_upper_bound",
          used_for_authority: false,
          may_execute: false,
        });
      } finally {
        budget.close();
        globalThis.fetch = originalFetch;
      }

      const blocked = assessLlmComputeReadiness({
        LLM_BACKEND: "openai-compatible",
        OPENAI_COMPAT_ENDPOINT: "https://fixture.invalid/v1",
        OPENAI_COMPAT_MODEL: "fixture-model",
        OPENAI_COMPAT_API_KEY: "fixture-key-only",
        BLUE_TANUKI_LLM_MAX_TOKENS: "128",
        BLUE_TANUKI_LLM_TIMEOUT_MS: "5000",
        BLUE_TANUKI_LLM_FALLBACK_PROFILES_JSON: profileJson,
        BLUE_TANUKI_COMPUTE_BUDGET_POLICY_JSON: JSON.stringify({
          ...policy,
          task: { ...policy.task, max_cost: { amount: 0.01, currency: "USD" } },
        }),
      });
      expect(blocked.status).toBe("blocked");
      expect(blocked.detail).toContain("task cost limit");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  it("passes candidate timeout_ms into the LLM provider verification fetch", async () => {
    const originalFetch = globalThis.fetch;
    let providerSignalSeen = false;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      providerSignalSeen = init?.signal instanceof AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    try {
      const result = await verifyLlmProvisioning(
        {
          llm: {
            provider: "openai-compatible",
            model: "timeout-model",
            endpoint: "https://example.test/v1",
            timeout_ms: 20,
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
      expect(result.secret_exposed).toBe(false);
      expect(providerSignalSeen).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
