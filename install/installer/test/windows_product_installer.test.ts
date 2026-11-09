import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function runPowerShellFile(
  command: string,
  file: string,
  args: readonly string[],
  cwd: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(command, powerShellFileArgs(command, file, args), {
    cwd,
    env: { ...process.env, BLUE_TANUKI_NO_PAUSE: "1" },
    encoding: "utf8",
  });
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
    expect(uninstall).toContain("Assert-ManagedWindowsProductInstall");
    expect(uninstall).toContain("Assert-ManagedWindowsProductData");
    expect(uninstall).toContain("Test-ShortcutOwnedByInstall");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstall).toContain("GetFullPath($PSCommandPath)");
    expect(uninstall).toContain("^BlueTanukiUninstall-[A-Za-z0-9-]+\\.ps1$");
    expect(uninstall).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstall).toContain("Write-UninstallStatus");
    expect(uninstall).toContain("shutdown was not confirmed");
    expect(uninstall).toContain("$stopFailure -or $stopExitCode -ne 0");
    expect(uninstallCmd).toContain("copy /Y");
    expect(uninstallCmd).toContain("start \"\" /b powershell.exe");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_SAFE_TARGET");
    expect(uninstallCmd).toContain("BLUE_TANUKI_UNINSTALL_STATUS_FILE");
    expect(uninstallCmd).toContain("exit /b 0");
  });

  it("stops before shared-data setup and refuses an update when resident shutdown fails", () => {
    const setup = read("install/windows/product/BlueTanukiSetup.ps1");
    const stopFunctionStart = setup.indexOf("function Stop-ExistingResident($Root) {");
    const stopFunctionEnd = setup.indexOf("\n}\n", stopFunctionStart) + 2;
    const stopCall = setup.indexOf("Stop-ExistingResident $installRootResolved");
    const dataPreparation = setup.indexOf("New-Item -ItemType Directory -Force -Path $dataRootResolved, $dataDir, $logDir");
    const bundledSetup = setup.indexOf("Invoke-BundledSetup $nodeExe $stageRoot $envFile $dataDir");
    expect(stopFunctionStart).toBeGreaterThanOrEqual(0);
    expect(stopFunctionEnd).toBeGreaterThan(stopFunctionStart);
    expect(stopCall).toBeGreaterThanOrEqual(0);
    expect(stopCall).toBeLessThan(dataPreparation);
    expect(stopCall).toBeLessThan(bundledSetup);
    const stopFunction = setup.slice(stopFunctionStart, stopFunctionEnd);
    expect(stopFunction).toContain("$stopExitCode = $LASTEXITCODE");
    expect(stopFunction).toContain("resident shutdown was not confirmed");
    expect(stopFunction).not.toContain("continuing install");

    const command = findPowerShell();
    if (!command) return;

    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-setup-stop-failure-"));
    const install = join(temp, "install");
    const launcher = join(install, "BlueTanukiLauncher.ps1");
    const harness = join(temp, "stop-existing-resident.test.ps1");
    try {
      mkdirSync(install, { recursive: true });
      writeFileSync(launcher, "# isolated stop-failure fixture\n", "utf8");
      const installLiteral = install.replace(/'/gu, "''");
      writeFileSync(harness, [
        "$ErrorActionPreference = 'Stop'",
        "function Fail($Message) { throw [System.InvalidOperationException]::new([string]$Message) }",
        "function powershell.exe { $global:LASTEXITCODE = 23 }",
        stopFunction,
        `try { Stop-ExistingResident '${installLiteral}'; exit 90 } catch {`,
        "  if ($_.Exception.Message -notmatch 'resident shutdown was not confirmed') { Write-Error $_; exit 91 }",
        "  Write-Output 'setup_stop_failure=refused'",
        "  exit 0",
        "}",
      ].join("\n"), "utf8");

      const result = runPowerShellFile(command, harness, [], temp);
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("setup_stop_failure=refused");
      expect(existsSync(launcher)).toBe(true);
      expect(readFileSync(launcher, "utf8")).toBe("# isolated stop-failure fixture\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
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
    writeFileSync(join(install, "blue-tanuki-install.json"), JSON.stringify({ data_root: data }), "utf8");

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
    writeFileSync(join(install, "blue-tanuki-install.json"), JSON.stringify({ data_root: data }), "utf8");

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
    writeFileSync(join(install, "blue-tanuki-install.json"), JSON.stringify({ data_root: data }), "utf8");

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
    writeFileSync(join(install, "blue-tanuki-install.json"), JSON.stringify({ data_root: data }), "utf8");
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
    expect(read("scripts/smoke_windows_installed.ts")).toContain("source_tree_setup_guidance_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("root_source_entrypoint_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("root_source_entrypoint_build_from_source_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("root_source_entrypoint_cmd_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("installer_zip_setup_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("windows_runtime_smoke=skipped");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("port_conflict_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("repair_install_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("crash_recovery_result=pass");
    expect(read("scripts/smoke_windows_installed.ts")).toContain("safe_mode_result=pass");
  });

  it("ships a deterministic Windows one-click artifact audit gate", () => {
    const audit = read("tooling/windows/assert_windows_oneclick_artifact.py");
    expect(audit).toContain("blue-tanuki-*-windows-x64-installer.zip");
    expect(audit).toContain("windows_oneclick_artifact_audit=pass");
    expect(audit).toContain("source_zip_returned_as_user_artifact=false");
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
