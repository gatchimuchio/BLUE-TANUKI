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
    expect(launcher).toContain("Get-ControlCenterUrl");
    expect(launcher).toContain("Assert-PortAvailable");
    expect(launcher).toContain("port_conflict=");
    expect(launcher).toContain("safe-mode");
    expect(launcher).toContain("BLUE_TANUKI_SAFE_MODE");
    expect(launcher).toContain("Autostart is opt-in only");
    expect(read("install/windows/product/BlueTanukiSafeMode.cmd")).toContain("safe-mode");
    expect(uninstall).toContain("PurgeData");
    expect(uninstall).toContain("User data retained");
    expect(uninstall).toContain("Assert-SafeTarget");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstall).toContain("Write-UninstallStatus");
    expect(uninstallCmd).toContain("copy /Y");
    expect(uninstallCmd).toContain("start \"\" /b powershell.exe");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstallCmd).toContain("exit /b 0");
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
    expect(read("scripts/smoke_windows_installed.ts")).toContain("port_conflict_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("repair_install_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("safe_mode_result=pass");
  });
});
