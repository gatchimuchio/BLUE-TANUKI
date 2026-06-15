import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function findPowerShell(): string | undefined {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh"] : ["pwsh"];
  for (const command of candidates) {
    const result = spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
    });
    if (result.status === 0) return command;
  }
  return undefined;
}

function powerShellFileArgs(command: string, file: string, args: readonly string[]): string[] {
  const base = command.toLowerCase();
  if (base.endsWith("powershell.exe")) {
    return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args];
  }
  return ["-NoProfile", "-File", file, ...args];
}

describe("Windows product installer package", () => {
  it("uses bundled runtime and gives source-tree mislaunch guidance", () => {
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    expect(setup).toContain("Expand-BundledNode");
    expect(setup).toContain("Find-NodeExe");
    expect(setup).toContain("Start Menu");
    expect(setup).toContain("Register-Uninstaller");
    expect(setup).toContain("Autostart: not enabled by installer");
    expect(setup).toContain("This setup script must be run from the packaged Windows installer zip.");
    expect(setup).toContain("Run INSTALL_WINDOWS.cmd from the repository root.");
    expect(setup).toContain("corepack prepare pnpm@9.12.0 --activate");
    expect(setup).not.toContain("required package directory missing");
    expect(setup).not.toContain("Require-Command \"node\"");
  });

  it("exposes a source-root Windows entrypoint that builds or runs the installer zip", () => {
    const cmd = read("INSTALL_WINDOWS.cmd");
    const ps1 = read("INSTALL_WINDOWS.ps1");
    expect(cmd).toContain("INSTALL_WINDOWS.ps1");
    expect(ps1).toContain("blue-tanuki-*-windows-x64-installer.zip");
    expect(ps1).toContain("corepack prepare pnpm@$script:PnpmVersion --activate");
    expect(ps1).toContain("pnpm install --frozen-lockfile");
    expect(ps1).toContain("pnpm package:windows");
    expect(ps1).toContain("pnpm package:windows:verify");
    expect(ps1).toContain("root_source_entrypoint_dry_run=pass");
    expect(ps1).toContain("BlueTanukiSetup.cmd");
  });

  it("fails direct source-tree product setup with friendly guidance when PowerShell is available", () => {
    const command = findPowerShell();
    const setup = join(root, "install/windows/product/BlueTanukiSetup.ps1");
    if (!command) {
      expect(read("install/windows/product/BlueTanukiSetup.ps1")).toContain("Fail-SourceTreeSetup");
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-source-setup-test-"));
    try {
      const result = spawnSync(command, powerShellFileArgs(command, setup, [
        "-InstallRoot",
        join(tmp, "InstallRoot"),
        "-DataRoot",
        join(tmp, "DataRoot"),
        "-NoLaunch",
      ]), {
        cwd: root,
        env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("This setup script must be run from the packaged Windows installer zip.");
      expect(output).toContain("INSTALL_WINDOWS.cmd");
      expect(output).not.toContain("required package directory missing");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dry-runs the root source entrypoint build path when no installer zip exists", () => {
    const command = findPowerShell();
    const entrypoint = join(root, "INSTALL_WINDOWS.ps1");
    if (!command) {
      expect(read("INSTALL_WINDOWS.ps1")).toContain("would_build_installer=true");
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-root-entrypoint-test-"));
    const emptyReleaseDir = join(tmp, "release");
    try {
      const result = spawnSync(command, powerShellFileArgs(command, entrypoint, [
        "-DryRun",
        "-ReleaseDir",
        emptyReleaseDir,
        "-WorkRoot",
        join(tmp, "work"),
        "-NoLaunch",
      ]), {
        cwd: root,
        env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("would_build_installer=true");
      expect(output).toContain("would_run=pnpm package:windows");
      expect(output).toContain("root_source_entrypoint_dry_run=pass");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
    expect(launcher).toContain("Start-Watchdog");
    expect(launcher).toContain("watchdog_restarted=pass");
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
    expect(read("scripts/package_windows.ts")).toContain("README_INSTALL_WINDOWS.txt");
    expect(read("scripts/package_windows.ts")).toContain("const shaFile = `${outFile}.sha256`");
    expect(read("scripts/verify_windows_package.ts")).toContain("verifyWindowsPackage");
    expect(read("scripts/verify_windows_package.ts")).toContain("README_INSTALL_WINDOWS.txt");
    expect(read("scripts/verify_windows_package.ts")).toContain("const shaFile = `${archive}.sha256`");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("source_tree_setup_guidance_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("root_source_entrypoint_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("installer_zip_setup_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("windows_runtime_smoke=skipped");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("port_conflict_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("repair_install_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("crash_recovery_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("safe_mode_result=pass");
  });

  it("does not tell source-zip users to run the product setup from the source tree", () => {
    const docs = [
      "README.md",
      "QUICKSTART.md",
      "install/README.md",
      "docs/WINDOWS_INSTALLER_GUIDE.md",
      "docs/WINDOWS_FIRST_RUN.md",
      "docs/WINDOWS_PACKAGING_AUDIT.md",
      "docs/VALIDATE_PRODUCT.md",
    ];
    for (const rel of docs) {
      if (!existsSync(join(root, rel))) continue;
      const lines = read(rel).split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes("install/windows/product/BlueTanukiSetup.cmd")) continue;
        expect(/not|しない|禁止/i.test(line)).toBe(true);
      }
    }
  });
});
