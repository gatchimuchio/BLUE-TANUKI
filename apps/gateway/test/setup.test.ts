import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSetupConfigFromOptions,
  parseSetupArgs,
  runSetupCommand,
} from "../src/setup.js";

const fakeSecretProtector = {
  protect: (plaintext: string) => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64url"),
  unprotect: (protectedValue: string) => {
    const decoded = Buffer.from(protectedValue, "base64url").toString("utf8");
    if (!decoded.startsWith("protected:")) throw new Error("bad test secret");
    return decoded.slice("protected:".length);
  },
};

describe("setup CLI", () => {
  it("parses non-interactive provider options", () => {
    const opts = parseSetupArgs([
      "--setup",
      "--yes",
      "--provider",
      "openai-compatible",
      "--endpoint=http://localhost:11434/v1",
      "--model",
      "llama-local",
      "--max-tokens",
      "512",
    ]);
    expect(opts.yes).toBe(true);
    expect(opts.provider).toBe("openai-compatible");
    expect(opts.endpoint).toBe("http://localhost:11434/v1");
    expect(opts.model).toBe("llama-local");
    expect(opts.max_tokens).toBe(512);
  });

  it("parses OpenRouter provider options", () => {
    const opts = parseSetupArgs([
      "--setup",
      "--yes",
      "--provider=openrouter",
      "--model",
      "openrouter/auto",
      "--api-key",
      "openrouter-secret",
    ]);
    expect(opts.provider).toBe("openrouter");
    expect(opts.model).toBe("openrouter/auto");
    expect(opts.api_key).toBe("openrouter-secret");
  });

  it("builds setup config from flags", () => {
    const config = buildSetupConfigFromOptions({
      yes: true,
      provider: "openai-compatible",
      endpoint: "http://localhost:11434/v1",
      model: "llama-local",
      file_root: "sandbox",
    });
    expect(config.llm.provider).toBe("openai-compatible");
    expect(config.paths.file_root).toBe(path.resolve("sandbox"));
  });

  it("writes an env file and runtime directories in --yes mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      const result = await runSetupCommand(
        [
          "--yes",
          "--no-doctor",
          "--output",
          output,
          "--base-dir",
          path.join(dir, "data"),
        ],
        { cwd: dir, env: {} },
      );
      expect(result.output_path).toBe(output);
      expect(result.config.llm.provider).toBe("stub");
      const raw = await fs.readFile(output, "utf8");
      expect(raw).toContain("LLM_BACKEND=stub");
      expect(raw).toContain("WEBCHAT_TOKEN=");
      await expect(fs.stat(path.join(dir, "data", "files"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(dir, "data", "sessions"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(dir, "data", "audit"))).resolves.toBeTruthy();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stores first-run Windows LLM API keys as secret refs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-secret-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      const result = await runSetupCommand(
        [
          "--yes",
          "--no-doctor",
          "--output",
          output,
          "--base-dir",
          path.join(dir, "data"),
          "--provider",
          "openrouter",
          "--model",
          "openrouter/auto",
          "--api-key",
          "openrouter-secret",
        ],
        {
          cwd: dir,
          env: {},
          secret_storage: {
            platform: "win32",
            protector: fakeSecretProtector,
          },
        },
      );

      expect(result.secret_storage.llm_api_key).toMatchObject({
        status: "stored",
        key: "OPENROUTER_API_KEY",
        storage: "win32_dpapi_current_user",
        os_protected: true,
        used_for_authority: false,
      });
      expect(result.env_keys).toContain("OPENROUTER_API_KEY_REF");
      expect(result.env_keys).not.toContain("OPENROUTER_API_KEY");

      const raw = await fs.readFile(output, "utf8");
      expect(raw).toContain("LLM_BACKEND=openrouter");
      expect(raw).toContain("OPENROUTER_MODEL=openrouter/auto");
      expect(raw).toContain("OPENROUTER_API_KEY_REF=win32-dpapi-current-user:file:");
      expect(raw).not.toContain("OPENROUTER_API_KEY=openrouter-secret");
      expect(raw).not.toContain("openrouter-secret");

      const secretRaw = await fs.readFile(path.join(dir, "secrets", "openrouter_api_key.dpapi"), "utf8");
      expect(secretRaw).not.toContain("openrouter-secret");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stores first-run Windows api-key-env material as a secret ref", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-env-secret-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      const result = await runSetupCommand(
        [
          "--yes",
          "--no-doctor",
          "--output",
          output,
          "--base-dir",
          path.join(dir, "data"),
          "--provider",
          "openrouter",
          "--model",
          "openrouter/auto",
          "--api-key-env",
          "TEST_OPENROUTER_KEY",
        ],
        {
          cwd: dir,
          env: { TEST_OPENROUTER_KEY: "openrouter-env-secret" },
          secret_storage: {
            platform: "win32",
            protector: fakeSecretProtector,
          },
        },
      );

      expect(result.secret_storage.llm_api_key.status).toBe("stored");
      const raw = await fs.readFile(output, "utf8");
      expect(raw).toContain("OPENROUTER_API_KEY_REF=win32-dpapi-current-user:file:");
      expect(raw).not.toContain("OPENROUTER_API_KEY=openrouter-env-secret");
      expect(raw).not.toContain("openrouter-env-secret");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed instead of writing plaintext when Windows setup secret storage fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-secret-fail-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      await expect(
        runSetupCommand(
          [
            "--yes",
            "--no-doctor",
            "--output",
            output,
            "--base-dir",
            path.join(dir, "data"),
            "--provider",
            "openrouter",
            "--model",
            "openrouter/auto",
            "--api-key",
            "openrouter-secret",
          ],
          {
            cwd: dir,
            env: {},
            secret_storage: {
              platform: "win32",
              protector: {
                protect: () => {
                  throw new Error("protector unavailable");
                },
                unprotect: (value: string) => value,
              },
            },
          },
        ),
      ).rejects.toThrow(/refusing to write plaintext OPENROUTER_API_KEY/);
      await expect(fs.readFile(output, "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite setup env without --force", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      await fs.writeFile(output, "OLD=1\n", "utf8");
      await expect(
        runSetupCommand(["--yes", "--no-doctor", "--output", output], {
          cwd: dir,
          env: {},
        }),
      ).rejects.toThrow(/already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("backs up an existing setup env when --force overwrites it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-setup-force-"));
    try {
      const output = path.join(dir, "blue-tanuki.env");
      await fs.writeFile(output, "OLD=1\n", "utf8");
      const result = await runSetupCommand(
        [
          "--yes",
          "--force",
          "--no-doctor",
          "--output",
          output,
          "--base-dir",
          path.join(dir, "data"),
        ],
        { cwd: dir, env: {} },
      );
      expect(result.backup_path).toBeTruthy();
      expect(await fs.readFile(result.backup_path!, "utf8")).toBe("OLD=1\n");
      expect(await fs.readFile(output, "utf8")).toContain("LLM_BACKEND=stub");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
