import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("downloadable product installer packages", () => {
  it("declares a release target for one-file normal-user installers", () => {
    const pkg = read("package.json");
    expect(pkg).toContain("\"package:installers\"");
    expect(pkg).toContain("\"package:installers:verify\"");
    expect(pkg).toContain("\"installer:product\"");
    expect(pkg).toContain("\"installer:product:verify\"");
  });

  it("wraps verified payload archives without exposing source-build work to users", () => {
    const pack = read("scripts/package_product_installers.ts");
    const verify = read("scripts/verify_product_installers.ts");
    for (const source of [pack, verify]) {
      expect(source).toContain("normal_user_runs_single_file");
      expect(source).toContain("requires_manual_nested_extraction");
      expect(source).toContain("requires_node_pnpm_git_from_user");
      expect(source).toContain("requires_source_build");
      expect(source).toContain("extracts_payload_internally");
      expect(source).toContain("launches_after_install_by_default");
      expect(source).toContain("signed_native_installer");
      expect(source).toContain("hds_authority_modified");
      expect(source).toContain("gui_shell_modified");
    }
    expect(pack).toContain("BlueTanukiSetup-${version}-windows-x64.cmd");
    expect(pack).toContain("BlueTanukiSetup-${version}-linux-x64.run");
    expect(pack).toContain("BlueTanukiSetup-${version}-macos-x64.command");
    expect(pack).toContain("BlueTanukiSetup-${version}-macos-arm64.command");
    expect(pack).toContain("__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__");
    expect(pack).toContain("Expand-Archive");
    expect(pack).toContain("tar -xzf");
    expect(verify).toContain("embedded payload sha256 mismatch");
    expect(verify).toContain("forbidden normal-user path text present");
  });

  it("documents product installers as the normal path and archives as payload/recovery", () => {
    for (const rel of [
      "README.md",
      "QUICKSTART.md",
      "install/README.md",
      "docs/INSTALLER_GUIDE.md",
    ]) {
      const text = read(rel);
      expect(text).toContain("BlueTanukiSetup-<version>-windows-x64.cmd");
      expect(text).toContain("BlueTanukiSetup-<version>-linux-x64.run");
      expect(text).toContain("BlueTanukiSetup-<version>-macos-<arch>.command");
      expect(text).toContain("normal user");
      expect(text).toContain("single-file");
      expect(text).toContain("payload/recovery");
      expect(text).toContain("signed native installer");
    }
  });
});
