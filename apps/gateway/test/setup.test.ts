import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSetupConfigFromOptions,
  parseSetupArgs,
  runSetupCommand,
} from "../src/setup.js";

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
