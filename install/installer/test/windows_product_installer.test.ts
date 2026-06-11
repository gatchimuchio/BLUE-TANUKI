import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("Windows product installer package", () => {
  it("uses bundled runtime and does not require end-user pnpm/node/git commands", () => {
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    expect(setup).toContain("Expand-BundledNode");
    expect(setup).toContain("Find-NodeExe");
    expect(setup).toContain("Start Menu");
    expect(setup).toContain("Register-Uninstaller");
    expect(setup).toContain("Autostart: not enabled by installer");
    expect(setup).not.toContain("pnpm install");
    expect(setup).not.toContain("corepack");
    expect(setup).not.toContain("Require-Command \"node\"");
  });

  it("exposes launcher lifecycle, doctor, logs, and uninstall without authority shortcuts", () => {
    const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
    const uninstall = read("install/windows/product/BlueTanukiUninstall.ps1");
    const uninstallCmd = read("install/windows/product/UninstallBlueTanuki.cmd");
    expect(launcher).toContain("Start-Resident");
    expect(launcher).toContain("Run-Doctor");
    expect(launcher).toContain("http://127.0.0.1:8787/app");
    expect(launcher).toContain("Autostart is opt-in only");
    expect(uninstall).toContain("PurgeData");
    expect(uninstall).toContain("User data retained");
    expect(uninstall).toContain("Assert-SafeTarget");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT");
    expect(uninstallCmd).toContain("EnableDelayedExpansion");
    expect(uninstallCmd).toContain("copy /Y");
    expect(uninstallCmd).toContain("cd /d \"%TEMP%\"");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstallCmd).toContain("exit /b !ERRORLEVEL!");
  });

  it("declares real package, verify, installer, and installed smoke scripts", () => {
    const pkg = read("package.json");
    expect(pkg).toContain("\"package:windows\"");
    expect(pkg).toContain("\"package:windows:verify\"");
    expect(pkg).toContain("\"installer:windows\"");
    expect(pkg).toContain("\"installer:windows:verify\"");
    expect(pkg).toContain("\"smoke:windows-installed\"");
    expect(read("scripts/package_windows.ts")).toContain("windows-x64-zip-installer");
    expect(read("scripts/verify_windows_package.ts")).toContain("verifyWindowsPackage");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("windows_runtime_smoke=skipped");
  });
});
