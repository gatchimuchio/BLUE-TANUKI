import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GA_REQUIRED_FILES,
  JAPANESE_BASE_AUDIT_KEY,
  OWNER_DECISION_PATH,
  readGaPromotionFiles,
  validateGaPromotionGate,
} from "../../../scripts/ga_promotion_gate.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function currentFiles(): Record<string, string> {
  return readGaPromotionFiles(repoRoot);
}

function withMutation(
  files: Record<string, string>,
  rel: string,
  mutate: (text: string) => string,
): Record<string, string> {
  return {
    ...files,
    [rel]: mutate(files[rel] ?? readFileSync(path.join(repoRoot, rel), "utf8")),
  };
}

describe("GA promotion gate", () => {
  it("accepts the current repository as pre-GO ready without allowing public claims", () => {
    const result = validateGaPromotionGate(currentFiles());

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pre_go_ready");
    expect(result.owner_go).toBe(false);
    expect(result.public_claim_allowed).toBe(false);
    expect(result.japanese_base_strict_ready).toBe(false);
    expect(result.package_version).toBe("1.0.0-rc.1");
    expect(result.bar_results).toMatchObject({
      A: "pass",
      B: "pass",
      C: "pass",
      D: "pass",
      E: "pass",
      F: "pass",
      G: "pending_owner_go",
    });
  });

  it("requires every declared GA evidence file to be readable", () => {
    const files = currentFiles();
    const rel = GA_REQUIRED_FILES[0];
    delete files[rel];

    const result = validateGaPromotionGate(files);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain(`${rel}: missing required GA evidence file`);
  });

  it("rejects pre-GO public complete-superiority claims in external docs", () => {
    const files = withMutation(
      currentFiles(),
      "README.md",
      (text) => `${text}\nBLUE-TANUKI claims complete superiority now.\n`,
    );

    const result = validateGaPromotionGate(files);
    expect(result.ok).toBe(false);
    expect(result.bar_results.G).toBe("fail");
    expect(result.failures.join("\n")).toContain("public claim boundary");
  });

  it("rejects version 1.0.0 without explicit owner GO", () => {
    const files = withMutation(
      currentFiles(),
      "package.json",
      (text) => text.replace('"version": "1.0.0-rc.1"', '"version": "1.0.0"'),
    );

    const result = validateGaPromotionGate(files);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("version 1.0.0 requires explicit owner GO");
  });

  it("fails actual promotion mode until owner GO evidence exists", () => {
    const result = validateGaPromotionGate(currentFiles(), { require_owner_go: true });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("owner GO decision is required");
  });

  it("allows public claim activation only after valid owner GO and version promotion", () => {
    const files = withMutation(
      currentFiles(),
      "package.json",
      (text) => text.replace('"version": "1.0.0-rc.1"', '"version": "1.0.0"'),
    );
    files[OWNER_DECISION_PATH] = JSON.stringify({
      schema_version: 1,
      decision: "GO",
      version: "1.0.0",
      decided_at: "2026-05-19T00:00:00.000Z",
      ga_bar_reviewed: true,
      technical_validation_reviewed: true,
      public_claim_authorized: true,
    });
    const migration = JSON.parse(files["規定/移行台帳.json"] ?? "{}") as Record<string, unknown>;
    files["規定/移行台帳.json"] = JSON.stringify({
      ...migration,
      strict_ready: true,
      debts: [],
    });
    files[JAPANESE_BASE_AUDIT_KEY] = JSON.stringify({
      ok: true,
      migration_debts: 0,
      failures: [],
    });

    const result = validateGaPromotionGate(files, { require_owner_go: true });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("go_ready");
    expect(result.owner_go).toBe(true);
    expect(result.public_claim_allowed).toBe(true);
    expect(result.japanese_base_strict_ready).toBe(true);
    expect(result.bar_results.G).toBe("pass");
  });

  it("日本語基底の移行負債が残る owner GO を拒否する", () => {
    const files = withMutation(
      currentFiles(),
      "package.json",
      (text) => text.replace('"version": "1.0.0-rc.1"', '"version": "1.0.0"'),
    );
    files[OWNER_DECISION_PATH] = JSON.stringify({
      schema_version: 1,
      decision: "GO",
      version: "1.0.0",
      decided_at: "2026-05-19T00:00:00.000Z",
      ga_bar_reviewed: true,
      technical_validation_reviewed: true,
      public_claim_authorized: true,
    });

    const result = validateGaPromotionGate(files, { require_owner_go: true });
    expect(result.ok).toBe(false);
    expect(result.public_claim_allowed).toBe(false);
    expect(result.bar_results.G).toBe("fail");
    expect(result.failures.join("\n")).toContain("japanese base strict boundary");
  });
});
