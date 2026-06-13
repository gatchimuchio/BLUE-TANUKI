import { promises as fs } from "node:fs";
import * as path from "node:path";
import { composioStatus } from "@blue-tanuki/core";
import type { WebChatSettingsSurface } from "@blue-tanuki/channel-webchat";
import { parseEnvFile, writeEnvFileAtomic } from "./env_file.js";
import {
  renderSetupEnvFile,
  setupConfigFromEnv,
  setupConfigToEnv,
  type SetupProviderKind,
} from "./setup_config.js";
import {
  describeLLMCommandRoute,
  describeLLMConfig,
} from "./llm_config.js";
import type { PluginRuntime } from "./plugin_loader.js";
import {
  applySettingsPatch,
  protectLlmApiKeyForEnvFile,
  type SettingsSecretStorageResult,
  verifyLlmProvisioning,
} from "./control_center/setup/api_settings.js";
import { LLM_VERIFY_ROUTE } from "./control_center/setup/setup_page.js";
import { llmSecretStorageStatus } from "./secret_store.js";

type Env = Record<string, string | undefined>;

export interface SettingsSurfaceOptions {
  env?: NodeJS.ProcessEnv;
  plugins: PluginRuntime;
}

export interface SettingsSnapshot {
  schema_version: 1;
  env_file: string | null;
  writable: boolean;
  llm: {
    provider: SetupProviderKind;
    model: string | null;
    endpoint: string | null;
    api_key_set: boolean;
    secret_storage: ReturnType<typeof llmSecretStorageStatus>;
    temperature: number | null;
    max_tokens: number | null;
    timeout_ms: number | null;
    site_url: string | null;
    app_title: string | null;
    configured_providers: string[];
    command_route: ReturnType<typeof describeLLMCommandRoute>;
  };
  integrations: {
    native_first: true;
    openrouter: {
      configured: boolean;
      api_key_set: boolean;
      model: string | null;
      site_url: string | null;
      app_title: string | null;
      used_for_authority: false;
    };
    composio: ReturnType<typeof composioStatus> & {
      last_tool_call: null;
    };
  };
  webchat: {
    host: string;
    port: number;
    token_set: boolean;
    resume_token_set: boolean;
    settings_token_set: boolean;
  };
  paths: {
    file_root: string;
    session_dir: string;
    audit_dir: string;
  };
  plugins: Array<{
    name: string;
    kind: string;
    permissions: string[];
  }>;
}


function boolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function settingsSurfaceAllowed(env: Env): boolean {
  if (!envValue(env, "BLUE_TANUKI_SETTINGS_TOKEN")) return false;
  if (isLoopbackHost(env.WEBCHAT_HOST)) return true;
  return boolEnv(env.BLUE_TANUKI_ENABLE_SETTINGS);
}

function envValue(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

async function readEnvFileEnv(filePath: string | undefined): Promise<Env> {
  if (!filePath) return {};
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw ? parseEnvFile(raw).values : {};
}

function envFilePath(env: Env): string | undefined {
  const raw = env.BLUE_TANUKI_ENV_FILE;
  return raw && raw.trim().length > 0 ? path.resolve(raw) : undefined;
}

function apiKeySet(env: Env, provider: SetupProviderKind): boolean {
  if (provider === "anthropic") {
    return Boolean(envValue(env, "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_REF"));
  }
  if (provider === "openai") {
    return Boolean(
      envValue(
        env,
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_REF",
        "LLM_API_KEY",
        "LLM_API_KEY_REF",
      ),
    );
  }
  if (provider === "openai-compatible") {
    return Boolean(
      envValue(
        env,
        "OPENAI_COMPAT_API_KEY",
        "OPENAI_COMPAT_API_KEY_REF",
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_REF",
        "LLM_API_KEY",
        "LLM_API_KEY_REF",
      ),
    );
  }
  if (provider === "openrouter") {
    return Boolean(envValue(env, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_REF"));
  }
  return false;
}

export function buildSettingsSnapshot(
  env: Env,
  plugins: PluginRuntime,
): SettingsSnapshot {
  const config = setupConfigFromEnv(env);
  return {
    schema_version: 1,
    env_file: envFilePath(env) ?? null,
    writable: Boolean(envFilePath(env)),
    llm: {
      provider: config.llm.provider,
      model: config.llm.model ?? null,
      endpoint: config.llm.endpoint ?? null,
      api_key_set: apiKeySet(env, config.llm.provider),
      secret_storage: llmSecretStorageStatus(env, config.llm.provider),
      temperature: config.llm.temperature ?? null,
      max_tokens: config.llm.max_tokens ?? null,
      timeout_ms: config.llm.timeout_ms ?? null,
      site_url: config.llm.site_url ?? null,
      app_title: config.llm.app_title ?? null,
      configured_providers: describeLLMConfig(env).configured_providers,
      command_route: describeLLMCommandRoute(env),
    },
    integrations: {
      native_first: true,
      openrouter: {
        configured: Boolean(
          envValue(env, "OPENROUTER_API_KEY") &&
            envValue(env, "OPENROUTER_MODEL", "LLM_MODEL"),
        ),
        api_key_set: Boolean(envValue(env, "OPENROUTER_API_KEY")),
        model: envValue(env, "OPENROUTER_MODEL", "LLM_MODEL") ?? null,
        site_url: envValue(env, "OPENROUTER_SITE_URL") ?? null,
        app_title: envValue(env, "OPENROUTER_APP_TITLE") ?? null,
        used_for_authority: false,
      },
      composio: {
        ...composioStatus(env),
        last_tool_call: null,
      },
    },
    webchat: {
      host: config.webchat.host,
      port: config.webchat.port,
      token_set: Boolean(envValue(env, "WEBCHAT_TOKEN")),
      resume_token_set: Boolean(envValue(env, "WEBCHAT_RESUME_TOKEN")),
      settings_token_set: Boolean(envValue(env, "BLUE_TANUKI_SETTINGS_TOKEN")),
    },
    paths: {
      file_root: config.paths.file_root,
      session_dir: config.paths.session_dir,
      audit_dir: config.paths.audit_dir,
    },
    plugins: plugins.plugins.map((plugin) => ({
      name: plugin.manifest.name,
      kind: plugin.manifest.kind,
      permissions: [...plugin.manifest.permissions].sort(),
    })),
  };
}

export async function updateSettingsEnvFile(
  body: Record<string, unknown>,
  env: Env,
): Promise<{
  output_path: string;
  backup_path?: string;
  restart_required: true;
  env_keys: string[];
  secret_storage: {
    llm_api_key: SettingsSecretStorageResult;
  };
}> {
  const target = envFilePath(env);
  if (!target) {
    throw new Error("BLUE_TANUKI_ENV_FILE is required to save settings");
  }
  const fileEnv = await readEnvFileEnv(target);
  const baseEnv = { ...env, ...fileEnv };
  const nextConfig = applySettingsPatch(setupConfigFromEnv(baseEnv), body);
  const secretStorage = protectLlmApiKeyForEnvFile(nextConfig, target, baseEnv);
  const writeResult = await writeEnvFileAtomic(target, renderSetupEnvFile(nextConfig), {
    mode: 0o600,
    backup: true,
    backup_label: "settings",
  });
  return {
    output_path: target,
    backup_path: writeResult.backup_path,
    restart_required: true,
    env_keys: Object.keys(setupConfigToEnv(nextConfig)).sort(),
    secret_storage: {
      llm_api_key: secretStorage,
    },
  };
}

export function createWebChatSettingsSurface(
  opts: SettingsSurfaceOptions,
): WebChatSettingsSurface | undefined {
  const env = opts.env ?? process.env;
  const token = env.BLUE_TANUKI_SETTINGS_TOKEN;
  if (!settingsSurfaceAllowed(env) || !token) return undefined;
  return {
    token,
    html: renderSettingsHtml,
    getSnapshot: async () => buildSettingsSnapshot(env, opts.plugins),
    update: async (body) => updateSettingsEnvFile(body, env),
    verifyLlm: async (body) => verifyLlmProvisioning(body, env, opts.plugins),
  };
}

export function renderSettingsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BLUE-TANUKI Settings</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f6;
      --ink: #18201c;
      --muted: #66706a;
      --line: #d9dfd8;
      --panel: #ffffff;
      --accent: #146c5a;
      --accent-2: #234a84;
      --warn: #8a5a00;
      --bad: #9f2b2b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .wrap {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
    }
    header .wrap {
      min-height: 68px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }
    h1 {
      font-size: 22px;
      line-height: 1.2;
      margin: 0;
      letter-spacing: 0;
    }
    main {
      padding: 24px 0 36px;
    }
    .statusbar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .stat {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 12px;
      min-height: 74px;
    }
    .stat b {
      display: block;
      font-size: 12px;
      color: var(--muted);
      font-weight: 650;
    }
    .stat span {
      display: block;
      margin-top: 8px;
      font-size: 15px;
      overflow-wrap: anywhere;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    nav {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 8px;
      position: sticky;
      top: 16px;
    }
    nav button {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--ink);
      text-align: left;
      padding: 10px 12px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    nav button[aria-selected="true"] {
      background: #e5f0eb;
      color: var(--accent);
      font-weight: 700;
    }
    section {
      display: none;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 18px;
    }
    section.active { display: block; }
    h2 {
      margin: 0 0 14px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    label {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    input:focus, select:focus {
      outline: 2px solid #b9d6cc;
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 18px;
      flex-wrap: wrap;
    }
    button.primary, button.secondary {
      min-height: 38px;
      border-radius: 6px;
      padding: 8px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
    }
    button.secondary {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
    }
    .notice {
      min-height: 24px;
      margin-top: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .notice.ok { color: var(--accent); }
    .notice.warn { color: var(--warn); }
    .notice.bad { color: var(--bad); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-size: 12px; }
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 760px) {
      .statusbar, .layout, .grid {
        grid-template-columns: 1fr;
      }
      nav { position: static; }
      header .wrap {
        align-items: flex-start;
        flex-direction: column;
        padding: 14px 0;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>BLUE-TANUKI Settings</h1>
      <label style="width:min(420px,100%)">
        Settings token
        <input id="settings-token" type="password" autocomplete="current-password">
      </label>
    </div>
  </header>
  <main class="wrap">
    <div class="statusbar">
      <div class="stat"><b>Provider</b><span id="stat-provider">-</span></div>
      <div class="stat"><b>Model</b><span id="stat-model">-</span></div>
      <div class="stat"><b>Env File</b><span id="stat-env">-</span></div>
      <div class="stat"><b>Plugins</b><span id="stat-plugins">-</span></div>
    </div>
    <div class="layout">
      <nav aria-label="Settings sections">
        <button type="button" data-tab="llm" aria-selected="true">LLM</button>
        <button type="button" data-tab="connections" aria-selected="false">Connections</button>
        <button type="button" data-tab="paths" aria-selected="false">Paths</button>
        <button type="button" data-tab="plugins" aria-selected="false">Plugins</button>
      </nav>
      <div>
        <section id="tab-llm" class="active">
          <h2>LLM</h2>
          <div class="grid">
            <label>Provider
              <select id="llm-provider">
                <option value="stub">stub</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="openai-compatible">openai-compatible</option>
                <option value="openrouter">openrouter</option>
              </select>
            </label>
            <label>Model
              <input id="llm-model" autocomplete="off">
            </label>
            <label>Endpoint
              <input id="llm-endpoint" autocomplete="off">
            </label>
            <label>API key
              <input id="llm-api-key" type="password" autocomplete="new-password" placeholder="unchanged">
            </label>
            <label>Temperature
              <input id="llm-temperature" type="number" min="0" max="2" step="0.1">
            </label>
            <label>Max tokens
              <input id="llm-max-tokens" type="number" min="1" step="1">
            </label>
            <label>Timeout ms
              <input id="llm-timeout-ms" type="number" min="1" step="1">
            </label>
            <label>OpenRouter site URL
              <input id="llm-site-url" autocomplete="off">
            </label>
            <label>OpenRouter app title
              <input id="llm-app-title" autocomplete="off">
            </label>
          </div>
        </section>
        <section id="tab-connections">
          <h2>Connections</h2>
          <div class="grid">
            <label>Composio API key
              <input id="composio-api-key" type="password" autocomplete="new-password" placeholder="unchanged">
            </label>
            <label>Composio allowed toolkits
              <input id="composio-allowed-toolkits" autocomplete="off" placeholder="github,gmail,calendar">
            </label>
            <label>Composio dry-run
              <select id="composio-dry-run">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label>Composio status
              <input id="composio-status" readonly>
            </label>
            <label>OpenRouter configured
              <input id="openrouter-status" readonly>
            </label>
            <label>Native-first policy
              <input id="native-first-status" readonly>
            </label>
          </div>
        </section>
        <section id="tab-paths">
          <h2>Paths</h2>
          <div class="grid">
            <label>WebChat host
              <input id="webchat-host" autocomplete="off">
            </label>
            <label>WebChat port
              <input id="webchat-port" type="number" min="1" max="65535" step="1">
            </label>
            <label>File sandbox root
              <input id="path-file-root" autocomplete="off">
            </label>
            <label>Session directory
              <input id="path-session-dir" autocomplete="off">
            </label>
            <label>Audit directory
              <input id="path-audit-dir" autocomplete="off">
            </label>
          </div>
        </section>
        <section id="tab-plugins">
          <h2>Plugins</h2>
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Permissions</th></tr></thead>
            <tbody id="plugin-rows"></tbody>
          </table>
        </section>
        <div class="actions">
          <button class="secondary" id="load-btn" type="button">Load</button>
          <button class="secondary" id="verify-llm-btn" type="button">Verify LLM</button>
          <button class="primary" id="save-btn" type="button">Save</button>
        </div>
        <div class="notice" id="notice"></div>
      </div>
    </div>
  </main>
  <script>
    const tokenInput = document.querySelector("#settings-token");
    const notice = document.querySelector("#notice");
    const fields = {
      provider: document.querySelector("#llm-provider"),
      model: document.querySelector("#llm-model"),
      endpoint: document.querySelector("#llm-endpoint"),
      apiKey: document.querySelector("#llm-api-key"),
      temperature: document.querySelector("#llm-temperature"),
      maxTokens: document.querySelector("#llm-max-tokens"),
      timeoutMs: document.querySelector("#llm-timeout-ms"),
      siteUrl: document.querySelector("#llm-site-url"),
      appTitle: document.querySelector("#llm-app-title"),
      composioApiKey: document.querySelector("#composio-api-key"),
      composioAllowedToolkits: document.querySelector("#composio-allowed-toolkits"),
      composioDryRun: document.querySelector("#composio-dry-run"),
      composioStatus: document.querySelector("#composio-status"),
      openrouterStatus: document.querySelector("#openrouter-status"),
      nativeFirstStatus: document.querySelector("#native-first-status"),
      host: document.querySelector("#webchat-host"),
      port: document.querySelector("#webchat-port"),
      fileRoot: document.querySelector("#path-file-root"),
      sessionDir: document.querySelector("#path-session-dir"),
      auditDir: document.querySelector("#path-audit-dir")
    };
    tokenInput.value = sessionStorage.getItem("blueTanukiSettingsToken") || "";
    tokenInput.addEventListener("change", () => {
      sessionStorage.setItem("blueTanukiSettingsToken", tokenInput.value);
    });
    document.querySelectorAll("nav button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("nav button").forEach((b) => b.setAttribute("aria-selected", "false"));
        document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
        button.setAttribute("aria-selected", "true");
        document.querySelector("#tab-" + button.dataset.tab).classList.add("active");
      });
    });
    function setNotice(text, kind = "") {
      notice.textContent = text;
      notice.className = "notice " + kind;
    }
    async function api(path, options = {}) {
      const token = tokenInput.value.trim();
      const res = await fetch(path, {
        ...options,
        headers: {
          "authorization": "Bearer " + token,
          "content-type": "application/json",
          ...(options.headers || {})
        }
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error || "request failed");
      return body;
    }
    function fill(snapshot) {
      document.querySelector("#stat-provider").textContent = snapshot.llm.provider;
      document.querySelector("#stat-model").textContent = snapshot.llm.model || "(provider default)";
      document.querySelector("#stat-env").textContent = snapshot.env_file || "(read-only)";
      document.querySelector("#stat-plugins").textContent = String(snapshot.plugins.length);
      fields.provider.value = snapshot.llm.provider;
      fields.model.value = snapshot.llm.model || "";
      fields.endpoint.value = snapshot.llm.endpoint || "";
      fields.apiKey.value = "";
      fields.apiKey.placeholder = snapshot.llm.api_key_set ? "configured" : "not set";
      fields.temperature.value = snapshot.llm.temperature ?? "";
      fields.maxTokens.value = snapshot.llm.max_tokens ?? "";
      fields.timeoutMs.value = snapshot.llm.timeout_ms ?? "";
      fields.siteUrl.value = snapshot.llm.site_url || "";
      fields.appTitle.value = snapshot.llm.app_title || "";
      fields.composioApiKey.value = "";
      fields.composioApiKey.placeholder = snapshot.integrations.composio.configured ? "configured" : "not set";
      fields.composioAllowedToolkits.value = snapshot.integrations.composio.allowed_toolkits.join(",");
      fields.composioDryRun.value = String(snapshot.integrations.composio.dry_run);
      fields.composioStatus.value =
        (snapshot.integrations.composio.configured ? "configured" : "missing") +
        "; dry_run=" + snapshot.integrations.composio.dry_run;
      fields.openrouterStatus.value =
        (snapshot.integrations.openrouter.configured ? "configured" : "missing") +
        "; key=" + (snapshot.integrations.openrouter.api_key_set ? "set" : "missing");
      fields.nativeFirstStatus.value = snapshot.integrations.native_first ? "native/direct paths remain canonical" : "invalid";
      fields.host.value = snapshot.webchat.host;
      fields.port.value = snapshot.webchat.port;
      fields.fileRoot.value = snapshot.paths.file_root;
      fields.sessionDir.value = snapshot.paths.session_dir;
      fields.auditDir.value = snapshot.paths.audit_dir;
      const rows = document.querySelector("#plugin-rows");
      rows.innerHTML = "";
      for (const plugin of snapshot.plugins) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td><code></code></td><td></td><td><code></code></td>";
        tr.children[0].firstChild.textContent = plugin.name;
        tr.children[1].textContent = plugin.kind;
        tr.children[2].firstChild.textContent = plugin.permissions.join(", ");
        rows.appendChild(tr);
      }
    }
    async function load() {
      try {
        fill(await api("/settings/config"));
        setNotice("Loaded", "ok");
      } catch (e) {
        setNotice(e.message, "bad");
      }
    }
    async function save() {
      const payload = buildPayload();
      try {
        await api("/settings/config", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setNotice("Saved. Restart required.", "warn");
        await load();
      } catch (e) {
        setNotice(e.message, "bad");
      }
    }
    function buildPayload() {
      const llm = {
        provider: fields.provider.value,
        model: fields.model.value,
        endpoint: fields.endpoint.value,
        temperature: fields.temperature.value,
        max_tokens: fields.maxTokens.value,
        timeout_ms: fields.timeoutMs.value
      };
      if (fields.apiKey.value.trim()) llm.api_key = fields.apiKey.value.trim();
      if (fields.siteUrl.value.trim()) llm.site_url = fields.siteUrl.value.trim();
      if (fields.appTitle.value.trim()) llm.app_title = fields.appTitle.value.trim();
      const composio = {
        allowed_toolkits: fields.composioAllowedToolkits.value,
        dry_run: fields.composioDryRun.value
      };
      if (fields.composioApiKey.value.trim()) composio.api_key = fields.composioApiKey.value.trim();
      return {
        llm,
        composio,
        webchat: { host: fields.host.value, port: fields.port.value },
        paths: {
          file_root: fields.fileRoot.value,
          session_dir: fields.sessionDir.value,
          audit_dir: fields.auditDir.value
        }
      };
    }
    async function verifyLlm() {
      try {
        const body = await api("${LLM_VERIFY_ROUTE}", {
          method: "POST",
          body: JSON.stringify(buildPayload())
        });
        const result = body.result;
        const kind = result.status === "pass" ? "ok" : "bad";
        setNotice("LLM verify " + result.status + ": " + result.detail + " Next: " + result.next_action, kind);
      } catch (e) {
        setNotice(e.message, "bad");
      }
    }
    document.querySelector("#load-btn").addEventListener("click", load);
    document.querySelector("#verify-llm-btn").addEventListener("click", verifyLlm);
    document.querySelector("#save-btn").addEventListener("click", save);
    if (tokenInput.value) load();
  </script>
</body>
</html>`;
}
