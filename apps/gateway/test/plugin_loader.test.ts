import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "@blue-tanuki/core";
import {
  loadPluginRuntime,
  parseWorkspacePackagePatterns,
} from "../src/plugin_loader.js";

let root: string;

async function writeWorkspace(): Promise<void> {
  await fs.writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n  - "apps/*"\n',
    "utf8",
  );
}

async function writePackage(
  rel: string,
  opts: {
    name: string;
    version?: string;
    kind?: "core" | "channel" | "tool" | "llm" | "detector";
    exports?: Record<string, string>;
    permissions?: string[];
    module?: string;
  },
): Promise<void> {
  const dir = path.join(root, rel);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: opts.name,
      version: opts.version ?? "0.0.1",
      type: "module",
      main: "./dist/index.js",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "blue-tanuki.plugin.json"),
    JSON.stringify({
      name: opts.name,
      version: opts.version ?? "0.0.1",
      kind: opts.kind ?? "core",
      entry: "./dist/index.js",
      exports: opts.exports ?? { default: "*" },
      permissions: opts.permissions ?? [],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "dist", "index.js"),
    opts.module ?? "export const marker = true;\n",
    "utf8",
  );
}

describe("plugin loader", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-loader-"));
    await writeWorkspace();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("parses pnpm-workspace package patterns", () => {
    expect(parseWorkspacePackagePatterns('packages:\n  - "packages/*"\n  - apps/*\n')).toEqual([
      "packages/*",
      "apps/*",
    ]);
  });

  it("loads workspace manifests and verifies declared exports", async () => {
    await writePackage("packages/core", {
      name: "@blue-tanuki/core",
      exports: { tools: "registerBuiltinTools" },
      permissions: [
        "tool:echo",
        "tool:file.search",
        "fs:read",
        "tool:file.write",
        "tool:file.edit",
        "fs:write",
        "tool:http.fetch",
        "tool:web.search",
        "tool:github.read",
        "tool:github.write",
        "tool:gmail.read",
        "tool:google.calendar.read",
        "tool:google.drive.read",
        "tool:gmail.write",
        "tool:google.calendar.write",
        "tool:google.drive.write",
        "tool:composio.search",
        "tool:composio.execute",
        "tool:browser.read",
        "tool:browser.snapshot",
        "tool:browser.automation",
        "tool:shell.exec",
        "network:http",
        "browser:snapshot",
        "browser:act",
        "network:github.com",
        "network:googleapis.com",
        "network:composio.dev",
        "secrets:GITHUB_TOKEN",
        "secrets:COMPOSIO_API_KEY",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "secrets:GMAIL_ACCESS_TOKEN",
        "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
        "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
        "google:gmail.read",
        "google:calendar.read",
        "google:drive.read",
        "google:gmail.write",
        "google:calendar.write",
        "google:drive.write",
        "external:send",
        "email:send",
        "github:issue.write",
        "github:pr.write",
        "github:comment.write",
        "shell:exec",
      ],
      module: `
        export function registerBuiltinTools(registry) {
          registry.register({
            name: "echo",
            description: "fake",
            required_capabilities: ["tool:echo"],
            async invoke() { return { ok: true }; }
          });
        }
      `,
    });

    const runtime = await loadPluginRuntime({ root });
    const registry = new ToolRegistry();
    runtime.registerTools(registry);

    expect(runtime.plugins).toHaveLength(1);
    expect(registry.get("echo")).toBeDefined();
  });

  it("fails boot when required tool permissions are undeclared", async () => {
    await writePackage("packages/core", {
      name: "@blue-tanuki/core",
      exports: { tools: "registerBuiltinTools" },
      permissions: ["tool:echo"],
      module: "export function registerBuiltinTools() {}\n",
    });

    const runtime = await loadPluginRuntime({ root });
    expect(() => runtime.registerTools(new ToolRegistry())).toThrow(
      /permission denied.*tool:file.search/,
    );
  });

  it("creates channels from manifest-declared workspace modules", async () => {
    await writePackage("packages/webchat", {
      name: "@blue-tanuki/channel-webchat",
      kind: "channel",
      exports: { channel: "WebChatChannel" },
      permissions: [
        "network:listen",
        "secrets:WEBCHAT_TOKEN",
        "secrets:WEBCHAT_RESUME_TOKEN",
      ],
      module: `
        export class WebChatChannel {
          constructor(opts) { this.opts = opts; this.name = "webchat"; }
          async start() {}
          async stop() {}
          async send() { return { delivered: true }; }
        }
      `,
    });

    const runtime = await loadPluginRuntime({ root });
    const channel = runtime.createChannel<{ name: string; opts: { token: string } }>({
      package_name: "@blue-tanuki/channel-webchat",
      required_permissions: [
        "network:listen",
        "secrets:WEBCHAT_TOKEN",
        "secrets:WEBCHAT_RESUME_TOKEN",
      ],
      action: "register webchat channel",
      constructor_args: [{ token: "secret", resume_token: "resume-secret" }],
    });

    expect(channel.name).toBe("webchat");
    expect(channel.opts.token).toBe("secret");
  });

  it("loads first-party surface exports after permission enforcement", async () => {
    await writePackage("packages/operator-writing", {
      name: "@blue-tanuki/operator-writing",
      kind: "core",
      exports: { surface: "getWritingSurfaceSnapshot" },
      permissions: ["tool:file.search", "fs:read"],
      module: `
        export function getWritingSurfaceSnapshot() {
          return { surface: "writing", layer: "A" };
        }
      `,
    });

    const runtime = await loadPluginRuntime({ root });
    const surface = runtime.getSurface<() => { surface: string; layer: string }>({
      package_name: "@blue-tanuki/operator-writing",
      required_permissions: ["tool:file.search", "fs:read"],
      action: "register writing operator surface",
    });

    expect(surface()).toEqual({ surface: "writing", layer: "A" });
  });

  it("loads Daily Operator surface exports after permission enforcement", async () => {
    await writePackage("packages/operator-daily", {
      name: "@blue-tanuki/operator-daily",
      kind: "core",
      exports: { surface: "getDailySurfaceSnapshot" },
      permissions: ["tool:schedule.list", "schedule:read"],
      module: `
        export function getDailySurfaceSnapshot() {
          return { surface: "daily", layer: "A" };
        }
      `,
    });

    const runtime = await loadPluginRuntime({ root });
    const surface = runtime.getSurface<() => { surface: string; layer: string }>({
      package_name: "@blue-tanuki/operator-daily",
      required_permissions: ["tool:schedule.list", "schedule:read"],
      action: "register daily operator surface",
    });

    expect(surface()).toEqual({ surface: "daily", layer: "A" });
  });

  it("fails boot when provider secret env is not declared", async () => {
    await writePackage("packages/core", {
      name: "@blue-tanuki/core",
      exports: { tools: "registerBuiltinTools" },
      permissions: ["network:llm-provider"],
      module: "export function registerBuiltinTools() {}\n",
    });

    const runtime = await loadPluginRuntime({ root });
    expect(() =>
      runtime.enforceLLMConfig({
        LLM_PROVIDERS_JSON: JSON.stringify([
          {
            name: "custom",
            endpoint: "https://example.invalid/v1",
            model: "m",
            api_key_env: "CUSTOM_LLM_KEY",
          },
        ]),
        CUSTOM_LLM_KEY: "secret",
      }),
    ).toThrow(/secrets:CUSTOM_LLM_KEY/);
  });

  it("requires base secret permission when LLM API key is supplied through a secret ref", async () => {
    await writePackage("packages/core", {
      name: "@blue-tanuki/core",
      exports: { tools: "registerBuiltinTools" },
      permissions: ["network:llm-provider", "secrets:OPENROUTER_MODEL"],
      module: "export function registerBuiltinTools() {}\n",
    });

    const runtime = await loadPluginRuntime({ root });
    expect(() =>
      runtime.enforceLLMConfig({
        LLM_BACKEND: "openrouter",
        OPENROUTER_MODEL: "openrouter/model",
        OPENROUTER_API_KEY_REF: "win32-dpapi-current-user:file:abc",
      }),
    ).toThrow(/secrets:OPENROUTER_API_KEY/);
  });

  it("rejects manifest drift from package metadata", async () => {
    await writePackage("packages/core", {
      name: "@blue-tanuki/core",
    });
    await fs.writeFile(
      path.join(root, "packages", "core", "blue-tanuki.plugin.json"),
      JSON.stringify({
        name: "@blue-tanuki/wrong",
        version: "0.0.1",
        kind: "core",
        entry: "./dist/index.js",
      }),
      "utf8",
    );

    await expect(loadPluginRuntime({ root })).rejects.toThrow(/name mismatch/);
  });
});
