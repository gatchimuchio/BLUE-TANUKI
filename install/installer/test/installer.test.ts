import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseInstallerArgs } from "../src/index.js";
import { llmSetupArgs } from "../src/api_provisioning.js";
import { runInstallerPreflight } from "../src/verify.js";

describe("guided installer", () => {
  it("parses bounded first-run options without exposing secrets", () => {
    const opts = parseInstallerArgs([
      "--",
      "--provider",
      "openai-compatible",
      "--endpoint=http://localhost:11434/v1",
      "--model",
      "llama-local",
      "--api-key",
      "local-secret",
      "--temperature=0.2",
      "--max-tokens",
      "64",
      "--timeout-ms=15000",
      "--no-serve",
      "--skip-install",
      "--skip-build",
    ]);
    expect(opts.provider).toBe("openai-compatible");
    expect(opts.endpoint).toBe("http://localhost:11434/v1");
    expect(opts.model).toBe("llama-local");
    expect(opts.api_key).toBe("local-secret");
    expect(opts.temperature).toBe(0.2);
    expect(opts.max_tokens).toBe(64);
    expect(opts.timeout_ms).toBe(15000);
    expect(opts.no_serve).toBe(true);
  });

  it("builds setup args for LLM provisioning", () => {
    expect(llmSetupArgs({
      provider: "openai",
      model: "gpt-test",
      api_key_env: "OPENAI_API_KEY",
      max_tokens: 256,
    })).toEqual([
      "--provider",
      "openai",
      "--model",
      "gpt-test",
      "--api-key-env",
      "OPENAI_API_KEY",
      "--max-tokens",
      "256",
    ]);
    expect(llmSetupArgs({
      provider: "openrouter",
      model: "openrouter/auto",
      api_key: "openrouter-secret",
    })).toContain("openrouter");
  });

  it("preflight reports missing repository roots with owner next action", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-installer-"));
    try {
      const result = runInstallerPreflight(dir);
      expect(result.ok).toBe(false);
      expect(result.issues.join(" ")).toContain("package.json");
      expect(result.next_action).toContain("rerun installer verification");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
