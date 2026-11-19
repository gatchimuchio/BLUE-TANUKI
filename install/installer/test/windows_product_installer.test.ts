import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function writeProductOwnershipFixture(install: string, data: string): void {
  const guard = join(install, "install", "windows", "safe-target.ps1");
  mkdirSync(join(install, "install", "windows"), { recursive: true });
  writeFileSync(guard, read("install/windows/safe-target.ps1"), "utf8");
  writeFileSync(join(install, "blue-tanuki-install.json"), JSON.stringify({
    schema_version: 3,
    product_id: "blue-tanuki-product-install",
    install_root: install,
    data_root: data,
  }), "utf8");
  writeFileSync(join(data, "blue-tanuki-product-data.json"), JSON.stringify({
    schema_version: 1,
    product_id: "blue-tanuki-product-data",
    install_root: install,
    data_root: data,
  }), "utf8");
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
    return ["-NoProfile", "-File", file, ...args];
  }
  return ["-NoProfile", "-File", file, ...args];
}

function runPowerShellFile(
  command: string,
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof spawnSync> {
  return spawnSync(command, powerShellFileArgs(command, file, args), {
    cwd,
    env: { ...env, BLUE_TANUKI_NO_PAUSE: "1" },
    encoding: "utf8",
  });
}

function windowsFixtureEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(systemroot|systemdrive|windir|path|pathext|comspec|temp|tmp|userprofile|localappdata|appdata)$/iu.test(name)));
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(path);
}

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function isProcessRunning(command: string, pid: number): boolean {
  const result = spawnSync(command, [
    "-NoProfile",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 }; exit 1`,
  ], { encoding: "utf8" });
  return result.status === 0;
}

describe("Windows product installer package", () => {
  it("keeps legacy allowance confined to the development install guard", () => {
    const safeTarget = read("install/windows/safe-target.ps1");
    const productGuardStart = safeTarget.indexOf("function Assert-ManagedWindowsProductInstall {");
    const productGuardEnd = safeTarget.indexOf("function Assert-ManagedWindowsProductData {", productGuardStart);
    const developmentGuardStart = safeTarget.indexOf("function Assert-ManagedWindowsDevelopmentInstall {");
    const developmentGuardEnd = safeTarget.indexOf("function Assert-SafeInstallTargets {", developmentGuardStart);
    expect(productGuardStart).toBeGreaterThanOrEqual(0);
    expect(productGuardEnd).toBeGreaterThan(productGuardStart);
    expect(developmentGuardStart).toBeGreaterThanOrEqual(0);
    expect(developmentGuardEnd).toBeGreaterThan(developmentGuardStart);

    const productGuard = safeTarget.slice(productGuardStart, productGuardEnd);
    const developmentGuard = safeTarget.slice(developmentGuardStart, developmentGuardEnd);
    expect(productGuard).not.toContain("AllowLegacy");
    expect(developmentGuard).toContain("[switch]$AllowLegacy");
    expect(developmentGuard).toContain("if ($AllowLegacy)");

    for (const rel of ["install/windows/product/BlueTanukiSetup.ps1", "install/windows/product/BlueTanukiUninstall.ps1"]) {
      expect(read(rel)).not.toMatch(/Assert-ManagedWindowsProductInstall[^\r\n]*-AllowLegacy/u);
    }
  });

  it("uses bundled runtime and gives source-tree mislaunch guidance", () => {
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    const recoveryCall = setup.indexOf("Restore-InterruptedWindowsProductUpdate -InstallRoot");
    const installPresenceCheck = setup.indexOf("$existingProductInstall = Test-Path -LiteralPath $installRootResolved");
    expect(setup).toContain("Expand-BundledNode");
    expect(setup).toContain("Find-NodeExe");
    expect(recoveryCall).toBeGreaterThanOrEqual(0);
    expect(installPresenceCheck).toBeGreaterThan(recoveryCall);
    expect(setup).toContain("Start Menu");
    expect(setup).toContain("Register-Uninstaller");
    expect(setup).toContain("Autostart: not enabled by installer");
    expect(setup).toContain("This setup script must be run from the packaged Windows installer zip.");
    expect(setup).toContain("INSTALL_WINDOWS.cmd -BuildFromSource");
    expect(setup).not.toContain("required package directory missing");
    expect(setup).not.toContain("Require-Command \"node\"");
  });

  it("exposes a source-root Windows entrypoint that runs a verified installer or explicit developer build", () => {
    const cmd = read("INSTALL_WINDOWS.cmd");
    const ps1 = read("INSTALL_WINDOWS.ps1");
    expect(cmd).toContain("cd /d \"%~dp0\"");
    expect(cmd).toContain("INSTALL_WINDOWS.ps1");
    expect(ps1).toContain("blue-tanuki-*-windows-x64-installer.zip");
    expect(ps1).toContain("[string]$ReleaseDir,");
    expect(ps1).toContain("[string]$WorkRoot,");
    expect(ps1).toContain("$ScriptRoot = if ($PSScriptRoot)");
    expect(ps1).toContain("Join-Path $ScriptRoot \"release\\windows\"");
    expect(ps1).toContain("Join-Path $ScriptRoot \".codex-tmp\\windows-install-entrypoint\"");
    expect(ps1).toContain("Push-Location $ScriptRoot");
    expect(ps1).not.toContain("[string]$ReleaseDir = (Join-Path $PSScriptRoot");
    expect(ps1).not.toContain("[string]$WorkRoot = (Join-Path $PSScriptRoot");
    expect(ps1).toContain("[switch]$BuildFromSource");
    expect(ps1).toContain("missing_installer_artifact=fail");
    expect(ps1).toContain("wrong_asset=source_zip");
    expect(ps1).toContain("would_download_release_installer=");
    expect(ps1).toContain("Developer build only: run INSTALL_WINDOWS.cmd -BuildFromSource.");
    expect(ps1).toContain("Get-FileSha256");
    expect(ps1).not.toContain("Get-FileHash -Algorithm SHA256");
    expect(ps1).toContain("corepack prepare pnpm@$script:PnpmVersion --activate");
    expect(ps1).not.toContain("corepack enable");
    expect(ps1).toContain("pnpm install --frozen-lockfile");
    expect(ps1).toContain("pnpm package:windows");
    expect(ps1).toContain("pnpm package:windows:verify");
    expect(ps1).toContain("root_source_entrypoint_dry_run=pass");
    expect(ps1).toContain("BlueTanukiSetup.cmd");
  });

  it("dry-runs direct PowerShell invocation with default ReleaseDir and WorkRoot resolution", () => {
    const command = findPowerShell();
    const entrypoint = join(root, "INSTALL_WINDOWS.ps1");
    if (!command) {
      expect(read("INSTALL_WINDOWS.ps1")).toContain("$ScriptRoot = if ($PSScriptRoot)");
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-root-entrypoint-defaults-"));
    try {
      const result = runPowerShellFile(command, entrypoint, [
        "-DryRun",
        "-NoLaunch",
      ], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Repository root:");
      expect(output).toContain(root);
      expect(output).toContain("root_source_entrypoint_dry_run=pass");
      expect(output).not.toContain("Cannot bind argument to parameter 'Path'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      const result = runPowerShellFile(command, setup, [
        "-InstallRoot",
        join(tmp, "InstallRoot"),
        "-DataRoot",
        join(tmp, "DataRoot"),
        "-NoLaunch",
      ], root);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("This setup script must be run from the packaged Windows installer zip.");
      expect(output).toContain("INSTALL_WINDOWS.cmd");
      expect(output).not.toContain("required package directory missing");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dry-runs the root source entrypoint missing-installer path without source build", () => {
    const command = findPowerShell();
    const entrypoint = join(root, "INSTALL_WINDOWS.ps1");
    if (!command) {
      expect(read("INSTALL_WINDOWS.ps1")).toContain("would_download_release_installer=");
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-root-entrypoint-test-"));
    const emptyReleaseDir = join(tmp, "release");
    try {
      const result = runPowerShellFile(command, entrypoint, [
        "-DryRun",
        "-ReleaseDir",
        emptyReleaseDir,
        "-WorkRoot",
        join(tmp, "work"),
        "-NoLaunch",
      ], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("wrong_asset=source_zip");
      expect(output).toContain("would_download_release_installer=");
      expect(output).toContain("root_source_entrypoint_dry_run=pass");
      expect(output).not.toContain("would_build_installer=true");
      expect(output).not.toContain("would_run=pnpm package:windows");
      expect(output).not.toContain("Cannot bind argument to parameter 'Path'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dry-runs explicit Windows developer source build only with BuildFromSource", () => {
    const command = findPowerShell();
    const entrypoint = join(root, "INSTALL_WINDOWS.ps1");
    if (!command) {
      expect(read("INSTALL_WINDOWS.ps1")).toContain("developer_build_from_source=true");
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-root-buildfromsource-test-"));
    try {
      const result = runPowerShellFile(command, entrypoint, [
        "-DryRun",
        "-BuildFromSource",
        "-ReleaseDir",
        join(tmp, "empty-release"),
        "-WorkRoot",
        join(tmp, "work"),
        "-NoLaunch",
      ], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("developer_build_from_source=true");
      expect(output).toContain("would_run=pnpm package:windows");
      expect(output).toContain("root_source_entrypoint_build_from_source_dry_run=pass");
      expect(output).not.toContain("would_run=corepack enable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs the cmd wrapper from another current directory on Windows", () => {
    const cmd = read("INSTALL_WINDOWS.cmd");
    expect(cmd).toContain("cd /d \"%~dp0\"");
    if (process.platform !== "win32") return;

    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-root-cmd-entrypoint-"));
    const emptyReleaseDir = join(tmp, "release");
    try {
      const result = spawnSync("cmd.exe", [
        "/d",
        "/s",
        "/c",
        join(root, "INSTALL_WINDOWS.cmd"),
        "-DryRun",
        "-ReleaseDir",
        emptyReleaseDir,
        "-WorkRoot",
        join(tmp, "work"),
        "-NoLaunch",
      ], {
        cwd: tmp,
        env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Repository root:");
      expect(output).toContain("wrong_asset=source_zip");
      expect(output).toContain("would_download_release_installer=");
      expect(output).toContain("root_source_entrypoint_dry_run=pass");
      expect(output).not.toContain("would_build_installer=true");
      expect(output).not.toContain("Cannot bind argument to parameter 'Path'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exposes launcher lifecycle, doctor, logs, and uninstall without authority shortcuts", () => {
    const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    const uninstall = read("install/windows/product/BlueTanukiUninstall.ps1");
    const uninstallCmd = read("install/windows/product/UninstallBlueTanuki.cmd");
    const developmentUninstall = read("install/windows/uninstall.ps1");
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
    expect(setup).toContain('$doctorErrorLog = Join-Path $LogDir "post-install-doctor.stderr.log"');
    expect(setup).toContain('$ErrorActionPreference = "Continue"');
    expect(setup).toContain('"--json" > $doctorLog 2> $doctorErrorLog');
    expect(launcher).toContain('$doctorErrorLog = Join-Path $logDir "doctor.stderr.log"');
    expect(launcher).toContain('$ErrorActionPreference = "Continue"');
    expect(launcher).toContain('"--json" > $doctorLog 2> $doctorErrorLog');
    expect(read("install/windows/product/BlueTanukiSafeMode.cmd")).toContain("safe-mode");
    expect(uninstall).toContain("PurgeData");
    expect(uninstall).toContain("User data retained");
    expect(uninstall).toContain("Assert-ManagedWindowsProductInstall");
    expect(uninstall).toContain("Assert-ManagedWindowsProductData");
    expect(uninstall).toContain("Test-ManagedWindowsProductShortcut");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstall).toContain("GetFullPath($PSCommandPath)");
    expect(uninstall).toContain("^BlueTanukiUninstall-[A-Za-z0-9-]+\\.ps1$");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstall).toContain("Write-UninstallStatus");
    expect(uninstall).toContain("shutdown was not confirmed");
    expect(uninstall).toContain("$stopFailure -or $stopExitCode -ne 0");
    expect(uninstallCmd).toContain("copy /Y");
    expect(uninstallCmd).toContain('powershell.exe -NoProfile -File "%BT_UNINSTALL_TEMP%" %*');
    expect(uninstallCmd).not.toContain('start "" /b powershell.exe');
    expect(uninstallCmd).toContain('findstr /x /c:"exit_code=0"');
    const uninstallCmdLines = uninstallCmd.split(/\r?\n/);
    const uninstallExecuteLine = uninstallCmdLines.findIndex((line) =>
      line.includes('powershell.exe -NoProfile -File "%BT_UNINSTALL_TEMP%" %*'));
    expect(uninstallExecuteLine).toBeGreaterThanOrEqual(0);
    const uninstallExecuteCommand = uninstallCmdLines[uninstallExecuteLine] ?? "";
    expect(uninstallExecuteCommand).toContain('&& findstr /x /c:"exit_code=0"');
    expect(uninstallExecuteCommand).toContain('&& exit 0 || (');
    expect(uninstallExecuteCommand).toContain('exit 1)');
    expect(uninstallCmdLines.slice(uninstallExecuteLine + 1).every((line) => line.trim() === "")).toBe(true);
    expect(uninstallCmd).toContain("did not complete successfully");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstallCmd).toContain('if /I "%~f0"=="%BLUE_TANUKI_UNINSTALL_WRAPPER_REENTRY%" goto :staged-wrapper');
    expect(uninstallCmd).toContain('set "BLUE_TANUKI_UNINSTALL_WRAPPER_REENTRY="');
    expect(uninstallCmd).toContain('set "BLUE_TANUKI_UNINSTALL_WRAPPER_REENTRY=%~f0"');
    expect(uninstallCmd).toContain('call "%~f0" %*');
    expect(uninstallCmd).toContain('set "BT_UNINSTALL_ROOT=%~dp0."');
    expect(uninstallCmd).toContain('&& exit 0 || (');
    expect(uninstallCmd).toContain('& exit 1)');
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_SAFE_TARGET");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstallCmd).toContain("exit 0");
    const stagedWrapper = uninstallCmd.indexOf(":staged-wrapper");
    const powershellUninstall = uninstallCmd.indexOf('powershell.exe -NoProfile -File "%BT_UNINSTALL_TEMP%" %*');
    expect(stagedWrapper).toBeGreaterThanOrEqual(0);
    expect(powershellUninstall).toBeGreaterThan(stagedWrapper);
    expect(uninstallCmd.slice(stagedWrapper, powershellUninstall)).toContain("BT_UNINSTALL_ROOT");
    expect(uninstall).not.toMatch(/-ExecutionPolicy\s+Bypass/i);
    expect(setup).not.toMatch(/-ExecutionPolicy\s+Bypass/i);
    expect(launcher).not.toMatch(/(?:-ExecutionPolicy\s+Bypass|["']-ExecutionPolicy["']\s*,\s*["']Bypass["'])/i);
    expect(developmentUninstall).toContain("$stopExitCode = $LASTEXITCODE");
    expect(developmentUninstall).toContain("$autostartExitCode = $LASTEXITCODE");
    expect(developmentUninstall).toContain("Refusing to uninstall because resident shutdown was not confirmed");
    expect(developmentUninstall).toContain("Refusing to uninstall because resident autostart could not be disabled");
    const devStop = developmentUninstall.indexOf('& powershell -NoProfile -File $residentScript -Command "resident-stop"');
    const devStopGuard = developmentUninstall.indexOf("if ($stopExitCode -ne 0)", devStop);
    const devAutostartDisable = developmentUninstall.indexOf('& powershell -NoProfile -File $residentScript -Command "resident-autostart-disable"');
    const devAutostartGuard = developmentUninstall.indexOf("if ($autostartExitCode -ne 0)", devAutostartDisable);
    const devRemove = developmentUninstall.indexOf('Remove-Target $installRootResolved "app"');
    expect(devStop).toBeGreaterThanOrEqual(0);
    expect(devStopGuard).toBeGreaterThan(devStop);
    expect(devAutostartDisable).toBeGreaterThan(devStopGuard);
    expect(devAutostartGuard).toBeGreaterThan(devAutostartDisable);
    expect(devRemove).toBeGreaterThan(devAutostartGuard);
    expect(launcher).toContain("$process.WaitForExit(750)");
    expect(launcher).toContain("without automatic recovery");
    for (const rel of [
      "install/windows/product/BlueTanuki.cmd",
      "install/windows/product/BlueTanukiDoctor.cmd",
      "install/windows/product/BlueTanukiLogs.cmd",
      "install/windows/product/BlueTanukiRestart.cmd",
      "install/windows/product/BlueTanukiSafeMode.cmd",
      "install/windows/product/BlueTanukiSetup.cmd",
      "install/windows/product/BlueTanukiStop.cmd",
      "install/resident/blue-tanuki-resident.ps1",
      "INSTALL_WINDOWS.cmd",
      "INSTALL_WINDOWS.ps1",
      "install/windows/install.ps1",
      "install/windows/uninstall.ps1",
      "scripts/package_product_installers.ts",
      "scripts/smoke_windows_installed.ts",
    ]) {
      expect(read(rel), rel).not.toMatch(/(?:-ExecutionPolicy\s+Bypass|["']-ExecutionPolicy["']\s*,\s*["']Bypass["'])/i);
    }
  });

  it("blocks packaged in-place replacement before staging or runtime mutation", () => {
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    const recoveryCall = setup.indexOf("Restore-InterruptedWindowsProductUpdate -InstallRoot");
    const installPresenceCheck = setup.indexOf("$existingProductInstall = Test-Path -LiteralPath $installRootResolved");
    const replacementBlock = setup.indexOf("In-place product replacement is unsupported. A matching product data-schema declaration does not authorize an application update");
    const stageCreation = setup.indexOf("$stageRoot = Join-Path $installParent");
    const compatibilityCheck = setup.indexOf("Assert-DataPackageCompatibility $dataRootResolved $stageRoot");
    const residentStop = setup.indexOf("Stop-ExistingResident");
    expect(recoveryCall).toBeGreaterThanOrEqual(0);
    expect(installPresenceCheck).toBeGreaterThan(recoveryCall);
    expect(replacementBlock).toBeGreaterThan(installPresenceCheck);
    expect(replacementBlock).toBeLessThan(stageCreation);
    expect(compatibilityCheck).toBeGreaterThan(stageCreation);
    expect(residentStop).toBe(-1);
    expect(setup).toContain("managed_files_sha256 = $ManagedFilesSha256.ToLowerInvariant()");
  });

  it("fails closed when a Windows product uninstall target has no ownership marker", () => {
    const command = findPowerShell();
    if (!command) {
      expect(read("install/windows/product/BlueTanukiUninstall.ps1")).toContain("Assert-ManagedWindowsProductInstall");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-uninstall-unowned-"));
    const install = join(temp, "app");
    const guard = join(install, "install", "windows", "safe-target.ps1");
    const keep = join(install, "owner-data.txt");
    try {
      mkdirSync(join(install, "install", "windows"), { recursive: true });
      writeFileSync(guard, read("install/windows/safe-target.ps1"), "utf8");
      writeFileSync(keep, "must remain\n", "utf8");
      const result = runPowerShellFile(command, join(root, "install/windows/product/BlueTanukiUninstall.ps1"), [
        "-InstallRoot",
        install,
        "-DataRoot",
        join(temp, "data"),
      ], temp);
      expect(result.status).not.toBe(0);
      expect(existsSync(keep)).toBe(true);
      expect(readFileSync(keep, "utf8")).toBe("must remain\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rechecks dynamic install and purge targets after resident shutdown", () => {
    const command = findPowerShell();
    const harness = join(root, "install/installer/test/windows_dynamic_uninstall.ps1");
    if (process.platform !== "win32" || !command) {
      expect(read("install/installer/test/windows_dynamic_uninstall.ps1")).toContain("dynamic_data_reparse_result=pass");
      return;
    }
    const result = runPowerShellFile(command, harness, [], root);
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("dynamic_install_change_result=pass");
    expect(`${result.stdout}\n${result.stderr}`).toContain("dynamic_data_reparse_result=pass");
    expect(`${result.stdout}\n${result.stderr}`).toContain("dynamic_fixture_cleanup=pass");
  });

  it("does not dot-source an environment-selected safety helper that differs from the install copy", () => {
    const command = findPowerShell();
    if (!command) {
      expect(read("install/windows/product/BlueTanukiUninstall.ps1")).toContain("Staged shared target safety guard does not match");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-uninstall-helper-"));
    const install = join(temp, "app");
    const guard = join(install, "install", "windows", "safe-target.ps1");
    const malicious = join(temp, "BlueTanukiSafeTarget-attacker.ps1");
    const sentinel = join(temp, "helper-was-executed.txt");
    try {
      mkdirSync(join(install, "install", "windows"), { recursive: true });
      writeFileSync(guard, read("install/windows/safe-target.ps1"), "utf8");
      writeFileSync(malicious, `Set-Content -LiteralPath '${sentinel}' -Value 'executed'\n`, "utf8");
      const result = spawnSync(
        command,
        powerShellFileArgs(command, join(root, "install/windows/product/BlueTanukiUninstall.ps1"), [
          "-InstallRoot",
          install,
          "-DataRoot",
          join(temp, "data"),
        ]),
        {
          cwd: temp,
          env: { ...process.env, BLUE_TANUKI_UNINSTALL_SAFE_TARGET: malicious, BLUE_TANUKI_NO_PAUSE: "1" },
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(malicious)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses the bundled Gateway configuration for installed WebChat routing and withholds unowned handoff", async () => {
    const command = findPowerShell();
    const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
    if (process.platform !== "win32" || !command) {
      expect(launcher).toContain('import { loadEnvFile } from "./apps/gateway/dist/env_file.js";');
      return;
    }
    const helperStart = launcher.indexOf("$script:installedWebChatConfiguration = $null");
    const helperEnd = launcher.indexOf("\nfunction Test-ResidentRunning", helperStart);
    const openStart = launcher.indexOf("function Open-ControlCenter {");
    const openEnd = launcher.indexOf("\nfunction Start-SafeMode", openStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(openEnd).toBeGreaterThan(openStart);

    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-installed-webchat-config-"));
    const harness = join(temp, "check.ps1");
    const envFile = join(temp, "blue-tanuki.env");
    const fixtureChatToken = "synthetic-launch-config-token";
    const psQuote = (value: string) => value.replace(/'/gu, "''");
    try {
      writeFileSync(envFile, [
        'WEBCHAT_HOST="localhost"',
        "WEBCHAT_PORT=41871",
        "WEBCHAT_PORT='41872'",
        "WEBCHAT_TOKEN=" + fixtureChatToken,
      ].join("\n"), "utf8");
      writeFileSync(harness, "\ufeff" + [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `$installRoot = '${psQuote(root)}'`,
        `$envFile = '${psQuote(envFile)}'`,
        `function Find-NodeExe { return '${psQuote(process.execPath)}' }`,
        "function Fail($Message) { throw $Message }",
        "function Read-ResidentPid { return 5001 }",
        "function Get-ManagedProcessSnapshot($PidValue, $Kind) { return @{ state = 'running'; process = [pscustomobject]@{ StartTime = [DateTime]::UtcNow } } }",
        "function Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State); if ($LocalPort -ne $config.port -or $State -ne 'Listen') { throw 'wrong socket query' }; [pscustomobject]@{ LocalAddress = $config.loopbackAddresses[0]; OwningProcess = $script:observedOwner } }",
        "function Start-Resident($SafeMode) { return $true }",
        "function Start-Process($Url) { $script:opened = $Url }",
        launcher.slice(helperStart, helperEnd),
        launcher.slice(openStart, openEnd),
        "$config = Get-InstalledWebChatConfiguration",
        "$script:observedOwner = 5001",
        "$owned = Get-VerifiedControlCenterListener $config",
        "$script:observedOwner = 5002",
        "$foreign = Get-VerifiedControlCenterListener $config",
        "function Invoke-InstalledWebChatHelper($Action, $TargetAddress, $ExpectedDigest) { throw 'unverified listener reached credential handoff' }",
        "Open-ControlCenter",
        "[pscustomobject]@{scheme=$config.scheme; health=(Get-HealthUrl); app=(Get-ControlCenterUrl); owned=$owned.address; foreign=$foreign; opened=$script:opened } | ConvertTo-Json -Compress",
      ].join("\r\n"), "utf8");
      const check = (configEnv: Record<string, string> = {}) => spawnSync(command, powerShellFileArgs(command, harness, []), {
        cwd: temp,
        env: { ...windowsFixtureEnvironment(), ...configEnv },
        encoding: "utf8",
      });
      const http = check();
      expect(http.status, http.stderr).toBe(0);
      const loopback = await new Promise<string>((resolve, reject) =>
        lookup("localhost", (err, addr) => err ? reject(err) : resolve(addr)));
      expect(JSON.parse(http.stdout.trim().split(/\r?\n/u).at(-1)!)).toEqual({
        scheme: "http", health: "http://localhost:41872/healthz", app: "http://localhost:41872/app",
        owned: loopback, foreign: null, opened: "http://localhost:41872/app",
      });
      const tls = check({
        WEBCHAT_HOST: "::1", WEBCHAT_PORT: "41873", WEBCHAT_TLS_CERT_FILE: "fixture.pem",
        WEBCHAT_TLS_KEY_FILE: "fixture.key",
      });
      expect(tls.status, tls.stderr).toBe(0);
      expect(JSON.parse(tls.stdout.trim().split(/\r?\n/u).at(-1)!)).toEqual({
        scheme: "https", health: "https://[::1]:41873/healthz", app: "https://[::1]:41873/app",
        owned: "::1", foreign: null, opened: "https://[::1]:41873/app",
      });
      expect((http.stdout ?? "") + (tls.stdout ?? "")).not.toContain(fixtureChatToken);
      expect(check({ WEBCHAT_TLS_CERT_FILE: "fixture.pem" }).status).not.toBe(0);
      writeFileSync(envFile, 'WEBCHAT_TOKEN="' + fixtureChatToken, "utf8");
      const malformed = check();
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout + malformed.stderr).not.toContain(fixtureChatToken);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("sends the launch ticket request only on the exact established socket owned by the expected resident", async () => {
    const command = findPowerShell();
    const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
    if (process.platform !== "win32" || !command) {
      expect(launcher).toContain("await verifyResidentPeer(socket, residentPid, residentStart);");
      expect(launcher).toContain("agent.createConnection = () => socket;");
      return;
    }
    const start = launcher.indexOf("$script:installedWebChatConfiguration = $null");
    const end = launcher.indexOf("\nfunction Test-ResidentRunning", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-installed-webchat-peer-"));
    const harness = join(temp, "check.ps1");
    const envFile = join(temp, "blue-tanuki.env");
    const psQuote = (value: string) => value.replace(/'/gu, "''");
    const token = "synthetic-peer-test-webchat-token";
    const ticket = "a".repeat(43);
    const received: { path?: string; credential?: string; secondaryCredentialsPresent: boolean }[] = [];
    let accepts = 0;
    const server = createServer((req, res) => {
      received.push({ path: req.url, credential: req.headers.authorization,
        secondaryCredentialsPresent: ["resume", "owner", "settings", "maintenance"]
          .some((name) => req.headers["x-blue-tanuki-launch-" + name] !== undefined) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ticket }));
    });
    server.on("connection", () => { accepts += 1; });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("synthetic listener has no port");
      writeFileSync(envFile, [
        "WEBCHAT_HOST=127.0.0.1", "WEBCHAT_PORT=" + address.port, "WEBCHAT_TOKEN=" + token,
      ].join("\n"), "utf8");
      writeFileSync(harness, "\ufeff" + [
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        `$installRoot = '${psQuote(root)}'`,
        `$envFile = '${psQuote(envFile)}'`,
        `function Find-NodeExe { return '${psQuote(process.execPath)}' }`,
        "function Fail($Message) { throw $Message }",
        `function Read-ResidentPid { return ${process.pid} }`,
        "function Get-ManagedProcessSnapshot($PidValue, $Kind) { return @{ state = 'running'; process = (Get-Process -Id $PidValue) } }",
        launcher.slice(start, end),
        "$config = Get-InstalledWebChatConfiguration",
        "$listener = Get-VerifiedControlCenterListener $config",
        "if (-not $listener) { throw 'the fixture listener was not verified' }",
        "Invoke-InstalledWebChatHelper 'ticket' $listener.address $config.digest $listener.processId '1'",
        "Invoke-InstalledWebChatHelper 'ticket' $listener.address $config.digest $listener.processId $listener.startTime",
      ].join("\r\n"), "utf8");
      const child = spawn(command, powerShellFileArgs(command, harness, []), {
        cwd: temp, env: windowsFixtureEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const completion = once(child, "close");
      let out = "";
      let errors = "";
      try {
        child.stdout.on("data", (chunk) => { out += String(chunk); });
        child.stderr.on("data", (chunk) => { errors += String(chunk); });
        await expect(waitForProcessExit(child, 20_000)).resolves.toBe(true);
        await completion;
        expect(child.exitCode, errors).toBe(0);
        expect(accepts).toBe(2);
        expect(received).toEqual([{ path: "/control-center/launch-handoff", credential: `Bearer ${token}`,
          secondaryCredentialsPresent: false }]);
        expect(out.trim()).toBe(ticket);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
    }
  }, 25_000);

  it("runs recovery inspection, reconciliation, and offline goal repair from the product launcher without resident startup", () => {
    const command = findPowerShell();
    if (process.platform !== "win32" || !command) {
      const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
      expect(launcher).toContain('"recovery-inspect" { Run-RecoveryDiagnostic "--recovery-inspect" }');
      expect(launcher).toContain('"recovery-reconcile" { Run-RecoveryDiagnostic "--recovery-reconcile" }');
      expect(launcher).toContain('"recovery-apply-goal-purpose" { Run-RecoveryDiagnostic "--recovery-apply-goal-purpose" }');
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-product-recovery-inspect-"));
    try {
      const install = join(temp, "app");
      const data = join(temp, "data");
      const launcher = join(install, "BlueTanukiLauncher.ps1");
      const dist = join(install, "apps", "gateway", "dist");
      mkdirSync(join(install, "runtime"), { recursive: true });
      mkdirSync(dist, { recursive: true });
      mkdirSync(data);
      writeProductOwnershipFixture(install, data);
      writeFileSync(launcher, read("install/windows/product/BlueTanukiLauncher.ps1"), "utf8");
      copyFileSync(process.execPath, join(install, "runtime", "node.exe"));
      writeFileSync(join(dist, "main.js"), `
        const { pathToFileURL } = require("node:url");
        void import(pathToFileURL(${JSON.stringify(join(root, "apps", "gateway", "dist", "main.js"))}).href);
      `, "utf8");
      const arguments_ = ["recovery-inspect", "--backup-id", "absent-backup-id", "--json"];
      const env = windowsFixtureEnvironment();
      const unavailable = runPowerShellFile(command, launcher, arguments_, temp, env);
      expect(unavailable.status, unavailable.stderr).toBe(2);
      expect(JSON.parse(unavailable.stdout)).toEqual({ status: "configuration_unavailable" });
      const configPath = join(data, "blue-tanuki.env");
      expect(existsSync(configPath)).toBe(false);
      const config = "BLUE_TANUKI_RECOVERY_DIR=" + JSON.stringify(join(data, "recovery")) + "\n";
      writeFileSync(configPath, config, "utf8");
      const absent = runPowerShellFile(command, launcher, arguments_, temp, env);
      expect(absent.status, absent.stderr).toBe(2);
      expect(JSON.parse(absent.stdout)).toMatchObject({ status: "not_found", mode: "read_only", may_execute: false });
      const planArguments = [
        "recovery-inspect", "--restore-plan", "--backup-id", "absent-backup-id", "--manifest-sha256", "0".repeat(64), "--json",
      ];
      const plan = runPowerShellFile(command, launcher, planArguments, temp, env);
      expect(plan.status, plan.stderr).toBe(2);
      expect(JSON.parse(plan.stdout)).toMatchObject({
        surface: "offline_recovery_restore_plan", status: "invalid", plan_sha256: null, may_execute: false,
      });
      const offline = runPowerShellFile(command, launcher, [...planArguments, "--verify-offline"], temp, env);
      expect(offline.status, offline.stderr).toBe(2);
      expect(JSON.parse(offline.stdout)).toMatchObject({
        surface: "offline_recovery_restore_plan", status: "offline_lease_unverified",
        offline_lease_status: "owner_state_unavailable", offline_lease_verified: false, may_execute: false,
      });
      const repairArguments = ["recovery-apply-goal-purpose", "--backup-id", "absent-backup-id", "--manifest-sha256",
        "1".repeat(64), "--repair-sha256", "2".repeat(64), "--json"];
      const syntheticCode = "a".repeat(64);
      const unowned = spawnSync(command, powerShellFileArgs(command, launcher, repairArguments), {
        cwd: temp, env: { ...env, BLUE_TANUKI_NO_PAUSE: "1" }, input: `${syntheticCode}\n`, encoding: "utf8", timeout: 10_000,
      });
      expect(unowned.status, unowned.stderr).toBe(2);
      expect(JSON.parse(unowned.stdout)).toEqual({ status: "owner_state_unavailable" });
      expect(unowned.stdout + unowned.stderr).not.toContain(syntheticCode);
      writeFileSync(join(dist, "main.js"), "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8");
      const reconcile = runPowerShellFile(command, launcher, ["recovery-reconcile", "--json"], temp, env);
      expect(reconcile.status, reconcile.stderr).toBe(0);
      expect(JSON.parse(reconcile.stdout)).toEqual(["--recovery-reconcile", "--env-file", configPath, "--json"]);
      expect(readFileSync(configPath, "utf8")).toBe(config);
      expect(existsSync(join(data, "blue-tanuki.pid"))).toBe(false);
      expect(existsSync(join(data, "logs"))).toBe(false);
      expect(existsSync(join(data, "recovery"))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses to stop a process when the resident PID does not belong to the installation", async () => {
    const command = findPowerShell();
    if (!command || !command.toLowerCase().endsWith("powershell.exe")) {
      expect(read("install/windows/product/BlueTanukiLauncher.ps1")).toContain("Refusing to stop resident PID");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-resident-pid-owner-"));
    const install = join(temp, "app");
    const data = join(temp, "data");
    const launcher = join(install, "BlueTanukiLauncher.ps1");
    const pidFile = join(data, "blue-tanuki.pid");
    mkdirSync(join(install, "runtime"), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(launcher, read("install/windows/product/BlueTanukiLauncher.ps1"), "utf8");
    writeFileSync(join(install, "runtime", "node.exe"), "not an executable\n", "utf8");
    writeProductOwnershipFixture(install, data);

    const unrelated = spawn(command, ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore" });
    try {
      if (!unrelated.pid) throw new Error("PowerShell test process did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
      writeFileSync(pidFile, `${unrelated.pid}\n`, "ascii");
      const result = runPowerShellFile(command, launcher, ["stop"], temp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(2);
      expect(output).toContain("Refusing to stop resident PID");
      expect(isProcessRunning(command, unrelated.pid)).toBe(true);
      expect(readFileSync(pidFile, "ascii").trim()).toBe(String(unrelated.pid));
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("ignores a foreign relative Gateway process and holds ambiguous install ownership", () => {
    const command = findPowerShell();
    const launcher = read("install/windows/product/BlueTanukiLauncher.ps1");
    if (!command || !command.toLowerCase().endsWith("powershell.exe")) {
      expect(launcher).toContain("$absoluteEntryMatches");
      expect(launcher).toContain("$expectedImageMatches");
      expect(launcher).toContain("a process uses this Gateway entry but its DataRoot could not be verified");
      return;
    }

    const helperStart = launcher.indexOf("function Normalize-ProcessImagePath($Path) {");
    const helperEnd = launcher.indexOf("\nfunction Get-ProcessSnapshot", helperStart);
    const processSetStart = launcher.indexOf("function Get-ManagedProcessSet($Kind) {");
    const processSetEnd = launcher.indexOf("\nfunction Stop-VerifiedProcess", processSetStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(processSetStart).toBeGreaterThanOrEqual(0);
    expect(processSetEnd).toBeGreaterThan(processSetStart);

    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-foreign-gateway-owner-"));
    const harness = join(temp, "process-set.test.ps1");
    const install = join(temp, "app");
    const expectedNode = join(install, "runtime", "node.exe");
    const expectedEntry = join(install, "apps", "gateway", "dist", "main.js");
    const envFile = join(temp, "data", "blue-tanuki.env");
    const psQuote = (value: string) => value.replace(/'/gu, "''");
    try {
      writeFileSync(harness, [
        "$ErrorActionPreference = 'Stop'",
        `$installRoot = '${psQuote(install)}'`,
        `$envFile = '${psQuote(envFile)}'`,
        "function Find-NodeExe { return $env:BT_TEST_EXPECTED_NODE }",
        "function Get-Process { throw 'the foreign process must never be inspected as an owned process' }",
        "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter); return @($script:ProcessRecords) }",
        launcher.slice(helperStart, helperEnd),
        launcher.slice(processSetStart, processSetEnd),
        "$script:ProcessRecords = @([pscustomobject]@{ ProcessId = 41000; Name = 'powershell.exe'; ExecutablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; CommandLine = 'powershell.exe -Command apps/gateway/dist/main.js --serve' })",
        "$result = Get-ManagedProcessSet 'resident'",
        "if ($result.state -ne 'stopped') { throw ('non-Node command line containing Gateway text was not ignored: ' + $result.state + ' ' + $result.reason) }",
        "Write-Output 'non_node_gateway_text=ignored'",
        "$script:ProcessRecords = @([pscustomobject]@{ ProcessId = 41001; Name = 'node.exe'; ExecutablePath = 'C:\\foreign\\node.exe'; CommandLine = 'node.exe apps/gateway/dist/main.js --serve' })",
        "$result = Get-ManagedProcessSet 'resident'",
        "if ($result.state -ne 'stopped') { throw ('foreign relative Gateway process was not ignored: ' + $result.state + ' ' + $result.reason) }",
        "Write-Output 'foreign_relative_gateway=ignored'",
        "$script:ProcessRecords = @([pscustomobject]@{ ProcessId = 41002; Name = 'node.exe'; ExecutablePath = $env:BT_TEST_EXPECTED_NODE; CommandLine = 'node.exe apps/gateway/dist/main.js --serve' })",
        "$result = Get-ManagedProcessSet 'resident'",
        "if ($result.state -ne 'unknown') { throw ('same-runtime process without a verified DataRoot was not held: ' + $result.state) }",
        "Write-Output 'same_runtime_without_data_root=held'",
        `$script:ProcessRecords = @([pscustomobject]@{ ProcessId = 41003; Name = 'node.exe'; ExecutablePath = 'C:\\foreign\\node.exe'; CommandLine = 'node.exe "${psQuote(expectedEntry)}" --serve' })`,
        "$result = Get-ManagedProcessSet 'resident'",
        "if ($result.state -ne 'unknown') { throw ('absolute install entry without a verified DataRoot was not held: ' + $result.state) }",
        "Write-Output 'absolute_install_entry_without_data_root=held'",
      ].join("\n"), "utf8");
      const result = spawnSync(command, ["-NoProfile", "-File", harness], {
        cwd: temp,
        env: { ...process.env, BT_TEST_EXPECTED_NODE: expectedNode },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("foreign_relative_gateway=ignored");
      expect(result.stdout).toContain("non_node_gateway_text=ignored");
      expect(result.stdout).toContain("same_runtime_without_data_root=held");
      expect(result.stdout).toContain("absolute_install_entry_without_data_root=held");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("stops the owned resident process only after matching its executable and launch arguments", async () => {
    const command = findPowerShell();
    if (!command || !command.toLowerCase().endsWith("powershell.exe")) {
      expect(read("install/windows/product/BlueTanukiLauncher.ps1")).toContain("Get-ManagedProcessSnapshot $pidValue \"resident\"");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-resident-stop-"));
    const install = join(temp, "app");
    const data = join(temp, "data");
    const runtime = join(install, "runtime");
    const launcher = join(install, "BlueTanukiLauncher.ps1");
    const node = join(runtime, "node.exe");
    const entry = join(install, "apps", "gateway", "dist", "main.js");
    const envFile = join(data, "blue-tanuki.env");
    const pidFile = join(data, "blue-tanuki.pid");
    mkdirSync(runtime, { recursive: true });
    mkdirSync(join(install, "apps", "gateway", "dist"), { recursive: true });
    mkdirSync(data, { recursive: true });
    linkSync(process.execPath, node);
    writeFileSync(launcher, read("install/windows/product/BlueTanukiLauncher.ps1"), "utf8");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n", "utf8");
    writeFileSync(envFile, "WEBCHAT_PORT=8787\n", "utf8");
    writeProductOwnershipFixture(install, data);

    const resident = spawn(node, ["apps/gateway/dist/main.js", "--serve", "--env-file", envFile], {
      cwd: install,
      stdio: "ignore",
    });
    try {
      if (!resident.pid) throw new Error("resident fixture process did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
      writeFileSync(pidFile, `${resident.pid}\n`, "ascii");
      const result = runPowerShellFile(command, launcher, ["stop"], temp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain(`resident_status=stopped pid=${resident.pid}`);
      expect(await waitForProcessExit(resident, 3000)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      if (resident.exitCode === null && resident.signalCode === null) resident.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15000);

  it("finds and stops the owned resident process when its PID record is missing", async () => {
    const command = findPowerShell();
    if (!command || !command.toLowerCase().endsWith("powershell.exe")) {
      expect(read("install/windows/product/BlueTanukiLauncher.ps1")).toContain("Get-ManagedProcessSet \"resident\"");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-resident-unrecorded-"));
    const install = join(temp, "app");
    const data = join(temp, "data");
    const runtime = join(install, "runtime");
    const launcher = join(install, "BlueTanukiLauncher.ps1");
    const node = join(runtime, "node.exe");
    const entry = join(install, "apps", "gateway", "dist", "main.js");
    const envFile = join(data, "blue-tanuki.env");
    const pidFile = join(data, "blue-tanuki.pid");
    mkdirSync(runtime, { recursive: true });
    mkdirSync(join(install, "apps", "gateway", "dist"), { recursive: true });
    mkdirSync(data, { recursive: true });
    linkSync(process.execPath, node);
    writeFileSync(launcher, read("install/windows/product/BlueTanukiLauncher.ps1"), "utf8");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n", "utf8");
    writeFileSync(envFile, "WEBCHAT_PORT=8787\n", "utf8");
    writeProductOwnershipFixture(install, data);

    const resident = spawn(node, ["apps/gateway/dist/main.js", "--serve", "--env-file", envFile], {
      cwd: install,
      stdio: "ignore",
    });
    try {
      if (!resident.pid) throw new Error("resident fixture process did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(pidFile)).toBe(false);
      const result = runPowerShellFile(command, launcher, ["stop"], temp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain(`resident_status=stopped pid=${resident.pid}`);
      expect(await waitForProcessExit(resident, 3000)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      if (resident.exitCode === null && resident.signalCode === null) resident.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15000);

  it("waits for owned watchdog exit and finds it again when its PID record is missing", async () => {
    const command = findPowerShell();
    if (!command || !command.toLowerCase().endsWith("powershell.exe")) {
      expect(read("install/windows/product/BlueTanukiLauncher.ps1")).toContain("Stop-VerifiedProcess $snapshot.process \"watchdog\"");
      return;
    }
    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-watchdog-stop-"));
    const install = join(temp, "app");
    const data = join(temp, "data");
    const launcher = join(install, "BlueTanukiLauncher.ps1");
    const pidFile = join(data, "blue-tanuki-watchdog.pid");
    mkdirSync(join(install, "runtime"), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(launcher, read("install/windows/product/BlueTanukiLauncher.ps1"), "utf8");
    writeFileSync(join(install, "runtime", "node.exe"), "not an executable\n", "utf8");
    writeProductOwnershipFixture(install, data);
    writeFileSync(join(data, "blue-tanuki.env"), "WEBCHAT_PORT=8787\n", "utf8");

    const watchdog = spawn(command, powerShellFileArgs(command, launcher, ["watchdog"]), { cwd: temp, stdio: "ignore" });
    try {
      if (!watchdog.pid) throw new Error("watchdog fixture process did not start");
      expect(await waitForPath(pidFile, 8000)).toBe(true);
      const result = runPowerShellFile(command, launcher, ["stop"], temp);
      expect(result.status).toBe(0);
      expect(await waitForProcessExit(watchdog, 3000)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);

      const unrecordedWatchdog = spawn(command, powerShellFileArgs(command, launcher, ["watchdog"]), {
        cwd: temp,
        stdio: "ignore",
      });
      try {
        expect(await waitForPath(pidFile, 8000)).toBe(true);
        expect(unrecordedWatchdog.pid).toBeDefined();
        rmSync(pidFile);
        const unrecordedStop = runPowerShellFile(command, launcher, ["stop"], temp);
        expect(unrecordedStop.status).toBe(0);
        expect(await waitForProcessExit(unrecordedWatchdog, 3000)).toBe(true);
        expect(existsSync(pidFile)).toBe(false);
      } finally {
        if (unrecordedWatchdog.exitCode === null && unrecordedWatchdog.signalCode === null) unrecordedWatchdog.kill();
      }
    } finally {
      if (watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15000);

  it("declares real package, verify, installer, and installed smoke scripts", () => {
    const pkg = read("package.json");
    const smoke = read("scripts/smoke_windows_installed.ts");
    const uninstaller = read("install/windows/product/BlueTanukiUninstall.ps1");
    expect(pkg).toContain("\"package:windows\"");
    expect(pkg).toContain("\"package:windows:verify\"");
    expect(pkg).toContain("\"installer:windows\"");
    expect(pkg).toContain("\"installer:windows:verify\"");
    expect(pkg).toContain("\"smoke:windows-installed\"");
    expect(read("scripts/package_windows.ts")).toContain("windows-x64-zip-installer");
    expect(read("scripts/package_windows.ts")).toContain("README_INSTALL_WINDOWS.txt");
    expect(read("scripts/package_windows.ts")).toContain("const shaFile = `${outFile}.sha256`");
    expect(read("scripts/package_windows.ts")).toContain("LICENSE-APACHE-2.0");
    expect(read("scripts/package_windows.ts")).toContain("LICENSE-CC-BY-4.0");
    expect(read("scripts/package_windows.ts")).toContain("NOTICE");
    expect(read("scripts/verify_windows_package.ts")).toContain("verifyWindowsPackage");
    expect(read("scripts/verify_windows_package.ts")).toContain("README_INSTALL_WINDOWS.txt");
    expect(read("scripts/verify_windows_package.ts")).toContain("const shaFile = `${archive}.sha256`");
    expect(read("scripts/verify_windows_package.ts")).toContain("app/LICENSE-APACHE-2.0");
    expect(read("scripts/verify_windows_package.ts")).toContain("app/LICENSE-CC-BY-4.0");
    expect(read("scripts/verify_windows_package.ts")).toContain("app/NOTICE");
    expect(smoke).toContain("source_tree_setup_guidance_result=pass");
    expect(smoke).toContain("root_source_entrypoint_result=pass");
    expect(smoke).toContain("root_source_entrypoint_build_from_source_result=pass");
    expect(smoke).toContain("root_source_entrypoint_cmd_result=pass");
    expect(smoke).toContain("installer_zip_setup_result=pass");
    expect(smoke).toContain("windows_runtime_smoke=skipped");
    expect(smoke).toContain("port_conflict_result=pass");
    expect(smoke).toContain("repair_install_result=pass");
    expect(smoke).toContain("crash_recovery_result=pass");
    expect(smoke).toContain("safe_mode_result=pass");
    expect(smoke).toContain("installed smoke registry preflight");
    expect(smoke).toContain("installed smoke active Gateway preflight");
    expect(smoke).toContain("active Gateway process prevents isolated Setup/Launcher/Uninstall smoke");
    expect(smoke).toContain('const isolatedProductEnv = {');
    expect(smoke).toContain('const smokePort = directIExpressLaunch ? 8787 : await findAvailableLoopbackPort();');
    expect(smoke).toContain('default direct IExpress smoke endpoint is already occupied');
    expect(smoke).toContain('function stopNewEdgeProcesses(preexistingPids: Set<number>, endpointMarker: string)');
    expect(smoke).toContain('CommandLine.IndexOf($endpoint, [StringComparison]::OrdinalIgnoreCase)');
    expect(smoke).toContain('isolated_control_center_browser_cleanup=pass');
    expect(smoke).toContain('path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")');
    expect(smoke).toContain('"installer setup", 600_000, isolatedProductEnv');
    expect(smoke).toContain("Get-CimInstance Win32_Process");
    expect(smoke).toContain("blue-tanuki-stage-");
    expect(smoke).toContain('const installRoot = directIExpressLaunch');
    expect(smoke).toContain(': path.join(work, "i");');
    expect(smoke).toContain("preserving temporary install tree because product cleanup is unconfirmed");
    expect(smoke).toContain('run("powershell.exe"');
    expect(smoke).toContain("Expand-Archive -LiteralPath");
    expect(smoke).not.toContain('spawnSync("tar.exe"');
    expect(smoke).toContain('path.join(isolatedTemp, `BlueTanukiUninstall-${randomUUID()}.status`)');
    expect(smoke).toContain("reportInstalledGatewayStartupFailure");
    expect(smoke).toContain("loopback_tcp_listener");
    expect(smoke).toContain("netstat.exe");
    expect(smoke).toContain("installed_node_matches");
    expect(smoke).toContain("gateway_serve_args_match");
    expect(smoke).toContain("startup_log_lines");
    expect(smoke).toContain("tested_port: port");
    expect(smoke).toContain("env_file_arg_matches");
    expect(smoke).toContain("setEnvFileValue(envFile, \"WEBCHAT_PORT\", isolatedChildEnv.WEBCHAT_PORT!)");
    expect(smoke).toContain("cleanup_uninstall_state");
    expect(uninstaller).toContain("$statusPath.StartsWith($tempRoot");
    expect(uninstaller).toContain("BlueTanukiUninstall-[A-Za-z0-9-]+\\.status$");
  });

  it("ships a deterministic Windows payload artifact audit gate", () => {
    const audit = read("tooling/windows/assert_windows_oneclick_artifact.py");
    expect(audit).toContain("blue-tanuki-*-windows-x64-installer.zip");
    expect(audit).toContain("windows_payload_artifact_audit=pass");
    expect(audit).toContain("source_zip_returned_as_windows_payload=false");
    expect(audit).toContain("user_requires_node_pnpm_git=false");
    expect(audit).toContain("normal_install_invokes_corepack=false");
    expect(audit).toContain("normal_install_invokes_pnpm=false");
    expect(audit).toContain("normal_install_invokes_source_build=false");
    expect(audit).toContain("zipfile.ZipFile");
    expect(audit).toContain("WINDOWS_RUNTIME_RE");
    expect(audit).not.toContain("shell=True");
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
