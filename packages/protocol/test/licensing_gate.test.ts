import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateLicensing } from "../../../scripts/licensing_gate.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("成果物別ライセンス監査", () => {
  it("現行リポジトリの実装・文書ライセンスと package metadata が一致する", () => {
    const report = validateLicensing(repoRoot);

    expect(report).toMatchObject({
      status: "pass",
      software_license: "Apache-2.0",
      documentation_license: "CC-BY-4.0",
    });
    expect(report.package_manifests).toBeGreaterThan(0);
  });

  it("MIT の package metadata が残る場合は拒否する", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blue-tanuki-license-"));
    try {
      for (const rel of ["LICENSE", "LICENSE-APACHE-2.0", "LICENSE-CC-BY-4.0", "NOTICE", "README.md"]) {
        await fs.copyFile(path.join(repoRoot, rel), path.join(root, rel));
      }
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "fixture", private: true, license: "MIT" }),
        "utf8",
      );

      expect(() => validateLicensing(root)).toThrow(/license は Apache-2\.0/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
