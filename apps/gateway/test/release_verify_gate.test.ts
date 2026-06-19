import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXTRACTED_RELEASE_COMMANDS,
  resolveExtractedRoot,
} from "../../../scripts/verify_release_bundle.ts";

describe("release bundle verification", () => {
  it("commissions an extracted bundle with install, build, doctor, repo-health, and release hardening", () => {
    const commands = EXTRACTED_RELEASE_COMMANDS.map((step) =>
      [step.command, ...step.args].join(" "),
    );

    expect(commands).toEqual([
      "corepack pnpm install --frozen-lockfile",
      "corepack pnpm build",
      "corepack pnpm run doctor",
      "corepack pnpm validate:repo-health",
      "corepack pnpm validate:release-hardening",
    ]);
    expect(EXTRACTED_RELEASE_COMMANDS[2]?.env).toMatchObject({
      WEBCHAT_TOKEN: expect.any(String),
      WEBCHAT_RESUME_TOKEN: expect.any(String),
      LLM_BACKEND: "stub",
    });
  });

  it("resolves either root-level or blue-tanuki-prefixed extracted bundles", () => {
    const base = path.join(tmpdir(), `blue-tanuki-release-verify-${process.pid}-${Date.now()}`);
    const direct = path.join(base, "direct");
    const nested = path.join(base, "nested");
    const empty = path.join(base, "empty");
    try {
      mkdirSync(direct, { recursive: true });
      writeFileSync(path.join(direct, "package.json"), "{}");
      mkdirSync(path.join(nested, "blue-tanuki"), { recursive: true });
      writeFileSync(path.join(nested, "blue-tanuki", "package.json"), "{}");
      mkdirSync(empty, { recursive: true });

      expect(resolveExtractedRoot(direct)).toBe(direct);
      expect(resolveExtractedRoot(nested)).toBe(path.join(nested, "blue-tanuki"));
      expect(() => resolveExtractedRoot(empty)).toThrow(/missing package\.json/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
