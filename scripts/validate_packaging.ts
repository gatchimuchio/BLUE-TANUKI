import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel: string): string {
  const path = join(root, rel);
  if (!existsSync(path)) {
    throw new Error(`missing required packaging file: ${rel}`);
  }
  return readFileSync(path, "utf8");
}

function requireIncludes(file: string, text: string, needle: string): void {
  if (!text.includes(needle)) {
    throw new Error(`${file}: missing required text: ${needle}`);
  }
}

function requireNotIncludes(file: string, text: string, needle: string): void {
  if (text.includes(needle)) {
    throw new Error(`${file}: forbidden text present: ${needle}`);
  }
}

function requireNotMatches(file: string, text: string, pattern: RegExp, label: string): void {
  if (pattern.test(text)) {
    throw new Error(`${file}: forbidden pattern present: ${label}`);
  }
}

function main(): void {
  const installReadme = read("install/README.md");
  requireIncludes("install/README.md", installReadme, "Windows");
  requireIncludes("install/README.md", installReadme, "macOS");
  requireIncludes("install/README.md", installReadme, "Linux");
  requireIncludes("install/README.md", installReadme, "pnpm installer:run");
  requireIncludes("install/README.md", installReadme, "guided first-run");
  requireIncludes("install/README.md", installReadme, "Verify LLM");
  requireIncludes("install/README.md", installReadme, "BLUE_TANUKI_SETTINGS_TOKEN");
  requireIncludes("install/README.md", installReadme, "doctor");
  requireIncludes("install/README.md", installReadme, "settings");
  requireIncludes("install/README.md", installReadme, "resident-start");
  requireIncludes("install/README.md", installReadme, "resident-autostart-enable");
  requireIncludes("install/README.md", installReadme, "uninstall");
  requireIncludes("install/README.md", installReadme, "PURGE=1");
  requireIncludes("install/README.md", installReadme, "RESET_CONFIG=1");
  requireIncludes("install/README.md", installReadme, "preserves");
  requireIncludes("install/README.md", installReadme, ".bak");
  requireIncludes("install/README.md", installReadme, "Distribution readiness");
  requireIncludes(
    "install/README.md",
    installReadme,
    "does not build signed native packages yet",
  );
  requireIncludes("install/README.md", installReadme, "pnpm package:windows");
  requireIncludes("install/README.md", installReadme, "bundles Windows Node.js");
  requireIncludes("install/README.md", installReadme, "Start Menu shortcuts");
  requireIncludes("install/README.md", installReadme, "does not silently enable autostart");
  requireIncludes("install/README.md", installReadme, "INSTALL.sh");
  requireIncludes("install/README.md", installReadme, "INSTALL_MACOS.command");
  requireIncludes("install/README.md", installReadme, "INSTALL_LINUX.desktop");
  requireIncludes("install/README.md", installReadme, "INSTALL_LINUX.sh");
  requireIncludes("install/README.md", installReadme, "LAUNCH_AFTER_INSTALL=0");
  requireIncludes("install/README.md", installReadme, "INSTALL_WINDOWS.cmd");
  requireIncludes("install/README.md", installReadme, "Do not run `install/windows/product/BlueTanukiSetup.cmd` from the source tree");

  const rootUnix = read("INSTALL.sh");
  requireIncludes("INSTALL.sh", rootUnix, "INSTALL_MACOS.sh");
  requireIncludes("INSTALL.sh", rootUnix, "INSTALL_LINUX.sh");
  requireIncludes("INSTALL.sh", rootUnix, "INSTALL_WINDOWS.cmd");

  const rootLinuxDesktop = read("INSTALL_LINUX.desktop");
  requireIncludes("INSTALL_LINUX.desktop", rootLinuxDesktop, "Type=Application");
  requireIncludes("INSTALL_LINUX.desktop", rootLinuxDesktop, "Terminal=true");
  requireIncludes("INSTALL_LINUX.desktop", rootLinuxDesktop, "INSTALL_LINUX.sh");

  const rootMacCommand = read("INSTALL_MACOS.command");
  requireIncludes("INSTALL_MACOS.command", rootMacCommand, "cd \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"");
  requireIncludes("INSTALL_MACOS.command", rootMacCommand, "exec sh ./INSTALL_MACOS.sh");

  const rootMac = read("INSTALL_MACOS.sh");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "install/macos/install.sh");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "LAUNCH_AFTER_INSTALL");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "NO_LAUNCH");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "macos_source_entrypoint_dry_run=pass");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "Repository root:");
  requireIncludes("INSTALL_MACOS.sh", rootMac, "Log:");

  const rootLinux = read("INSTALL_LINUX.sh");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "install/linux/install.sh");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "LAUNCH_AFTER_INSTALL");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "NO_LAUNCH");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "linux_source_entrypoint_dry_run=pass");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "Repository root:");
  requireIncludes("INSTALL_LINUX.sh", rootLinux, "Log:");

  const rootWindowsCmd = read("INSTALL_WINDOWS.cmd");
  requireIncludes("INSTALL_WINDOWS.cmd", rootWindowsCmd, "INSTALL_WINDOWS.ps1");
  requireIncludes("INSTALL_WINDOWS.cmd", rootWindowsCmd, "cd /d \"%~dp0\"");

  const rootWindowsPs = read("INSTALL_WINDOWS.ps1");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "blue-tanuki-*-windows-x64-installer.zip");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "[string]$ReleaseDir,");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "[string]$WorkRoot,");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "$ScriptRoot = if ($PSScriptRoot)");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Join-Path $ScriptRoot \"release\\windows\"");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Join-Path $ScriptRoot \".codex-tmp\\windows-install-entrypoint\"");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Push-Location $ScriptRoot");
  requireNotIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "[string]$ReleaseDir = (Join-Path $PSScriptRoot");
  requireNotIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "[string]$WorkRoot = (Join-Path $PSScriptRoot");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "[switch]$BuildFromSource");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "missing_installer_artifact=fail");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "wrong_asset=source_zip");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "would_download_release_installer=");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Developer build only: run INSTALL_WINDOWS.cmd -BuildFromSource.");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Resolve-PnpmRunner");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "npm exec");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "corepack prepare");
  requireNotIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "corepack enable");
  requireNotIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "would_build_installer=true");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "pnpm install");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "pnpm package:windows");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "pnpm package:windows:verify");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "root_source_entrypoint_build_from_source_dry_run=pass");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "root_source_entrypoint_dry_run=pass");
  requireIncludes("INSTALL_WINDOWS.ps1", rootWindowsPs, "Log:");

  const windowsWorkflow = read(".github/workflows/ci.yml");
  requireIncludes(".github/workflows/ci.yml", windowsWorkflow, "windows-product");
  requireIncludes(".github/workflows/ci.yml", windowsWorkflow, "pnpm validate:product -- --phase P3");
  requireIncludes(".github/workflows/ci.yml", windowsWorkflow, "Upload Windows product evidence");
  requireIncludes(".github/workflows/ci.yml", windowsWorkflow, "if: always()");
  requireIncludes(".github/workflows/ci.yml", windowsWorkflow, "validate-product-windows-evidence");

  const windowsInstallerGuide = read("docs/WINDOWS_INSTALLER_GUIDE.md");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "pnpm package:windows");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "BlueTanukiSetup.cmd");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "%LOCALAPPDATA%\\Programs\\BlueTanuki");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "%APPDATA%\\BlueTanuki");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "Autostart is not enabled");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "not a signed MSI/EXE");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "Get-FileHash");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "Repair / Reinstall");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "INSTALL_WINDOWS.cmd");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "README_INSTALL_WINDOWS.txt");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "GitHub Release Artifact Policy");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "GitHub source zip is developer source");
  requireIncludes("docs/WINDOWS_INSTALLER_GUIDE.md", windowsInstallerGuide, "Do not run `install/windows/product/BlueTanukiSetup.cmd` from the source tree");

  const windowsFirstRun = read("docs/WINDOWS_FIRST_RUN.md");
  requireIncludes("docs/WINDOWS_FIRST_RUN.md", windowsFirstRun, "Conversation / WebChat");
  requireIncludes("docs/WINDOWS_FIRST_RUN.md", windowsFirstRun, "stub LLM mode");
  requireIncludes("docs/WINDOWS_FIRST_RUN.md", windowsFirstRun, "Doctor / Health");
  requireIncludes("docs/WINDOWS_FIRST_RUN.md", windowsFirstRun, "%APPDATA%\\BlueTanuki\\logs");
  requireIncludes("docs/WINDOWS_FIRST_RUN.md", windowsFirstRun, "Get-FileHash");

  const windowsPackagingAudit = read("docs/WINDOWS_PACKAGING_AUDIT.md");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "bundled Windows Node runtime");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "GUI Shell not modified");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "HDS authority not modified");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "Windows runtime install smoke must be run on Windows");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, ".sha256");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "README_INSTALL_WINDOWS.txt");
  requireIncludes("docs/WINDOWS_PACKAGING_AUDIT.md", windowsPackagingAudit, "Source zip is developer source");

  const windowsUninstall = read("docs/WINDOWS_UNINSTALL.md");
  requireIncludes("docs/WINDOWS_UNINSTALL.md", windowsUninstall, "Uninstall\\BlueTanuki");
  requireIncludes("docs/WINDOWS_UNINSTALL.md", windowsUninstall, "User data retained");
  requireIncludes("docs/WINDOWS_UNINSTALL.md", windowsUninstall, "PurgeData");

  const guidedInstallerReadme = read("install/installer/README.md");
  requireIncludes("install/installer/README.md", guidedInstallerReadme, "guided first-run");
  requireIncludes("install/installer/README.md", guidedInstallerReadme, "pnpm installer:run");
  requireIncludes("install/installer/README.md", guidedInstallerReadme, "Verify LLM");
  requireIncludes("install/installer/README.md", guidedInstallerReadme, "not a signed native installer");
  requireIncludes("install/installer/README.md", guidedInstallerReadme, "not an automatic updater");

  const residentReadme = read("install/resident/README.md");
  requireIncludes("install/resident/README.md", residentReadme, "resident-start");
  requireIncludes("install/resident/README.md", residentReadme, "resident-autostart-enable");
  requireIncludes("install/resident/README.md", residentReadme, "does not enable autostart");

  const residentPs = read("install/resident/blue-tanuki-resident.ps1");
  requireIncludes("install/resident/blue-tanuki-resident.ps1", residentPs, "resident-start");
  requireIncludes("install/resident/blue-tanuki-resident.ps1", residentPs, "resident-autostart-enable");
  requireIncludes("install/resident/blue-tanuki-resident.ps1", residentPs, "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");

  const residentSh = read("install/resident/blue-tanuki-resident.sh");
  requireIncludes("install/resident/blue-tanuki-resident.sh", residentSh, "resident-start");
  requireIncludes("install/resident/blue-tanuki-resident.sh", residentSh, "resident-autostart-enable");
  requireIncludes("install/resident/blue-tanuki-resident.sh", residentSh, "LaunchAgents");
  requireIncludes("install/resident/blue-tanuki-resident.sh", residentSh, "systemctl --user");

  const guidedInstallerIndex = read("install/installer/src/index.ts");
  requireIncludes("install/installer/src/index.ts", guidedInstallerIndex, "runInstallerCli");
  requireIncludes("install/installer/src/index.ts", guidedInstallerIndex, "--provider");
  requireIncludes("install/installer/src/index.ts", guidedInstallerIndex, "--no-serve");

  const guidedInstallerFlow = read("install/installer/src/setup_flow.ts");
  requireIncludes("install/installer/src/setup_flow.ts", guidedInstallerFlow, "runInstallerFlow");
  requireIncludes("install/installer/src/setup_flow.ts", guidedInstallerFlow, "runSetupCommand");
  requireIncludes("install/installer/src/setup_flow.ts", guidedInstallerFlow, "runDoctor");

  const guidedInstallerProvisioning = read("install/installer/src/api_provisioning.ts");
  requireIncludes("install/installer/src/api_provisioning.ts", guidedInstallerProvisioning, "llmSetupArgs");
  requireIncludes("install/installer/src/api_provisioning.ts", guidedInstallerProvisioning, "--api-key-env");

  const guidedInstallerVerify = read("install/installer/src/verify.ts");
  requireIncludes("install/installer/src/verify.ts", guidedInstallerVerify, "runInstallerPreflight");
  requireIncludes("install/installer/src/verify.ts", guidedInstallerVerify, "pnpm installer:run");

  const winInstall = read("install/windows/install.ps1");
  requireIncludes("install/windows/install.ps1", winInstall, "Node.js 22.14.0");
  requireIncludes("install/windows/install.ps1", winInstall, "pnpm@9.12.0");
  requireIncludes("install/windows/install.ps1", winInstall, "\"--setup\"");
  requireIncludes("install/windows/install.ps1", winInstall, "\"--yes\"");
  requireIncludes("install/windows/install.ps1", winInstall, "blue-tanuki.ps1");
  requireIncludes("install/windows/install.ps1", winInstall, "SkipDoctor");
  requireIncludes("install/windows/install.ps1", winInstall, "ResetConfig");
  requireIncludes("install/windows/install.ps1", winInstall, "Invoke-SetupIfNeeded");
  requireIncludes("install/windows/install.ps1", winInstall, "Existing env file retained");
  requireIncludes("install/windows/install.ps1", winInstall, "Add -ResetConfig only");
  requireIncludes("install/windows/install.ps1", winInstall, "Invoke-PostInstallDoctor");
  requireIncludes("install/windows/install.ps1", winInstall, "post-install doctor");
  requireIncludes("install/windows/install.ps1", winInstall, "\"doctor\"");
  requireIncludes("install/windows/install.ps1", winInstall, "resident-start");
  requireIncludes("install/windows/install.ps1", winInstall, "resident-autostart-enable");
  requireIncludes("install/windows/install.ps1", winInstall, "/settings");

  const winUninstall = read("install/windows/uninstall.ps1");
  requireIncludes("install/windows/uninstall.ps1", winUninstall, "Purge");
  requireIncludes("install/windows/uninstall.ps1", winUninstall, "DryRun");
  requireIncludes("install/windows/uninstall.ps1", winUninstall, "Assert-SafeTarget");
  requireIncludes("install/windows/uninstall.ps1", winUninstall, "resident-autostart-disable");
  requireIncludes("install/windows/uninstall.ps1", winUninstall, "Data retained");

  const winProductSetup = read("install/windows/product/BlueTanukiSetup.ps1");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "Start Menu");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "Register-Uninstaller");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "Autostart: not enabled by installer");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "post-install doctor");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "Expand-Archive");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "BLUE-TANUKI Safe Mode");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "This setup script must be run from the packaged Windows installer zip.");
  requireIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "INSTALL_WINDOWS.cmd -BuildFromSource");
  requireNotIncludes("install/windows/product/BlueTanukiSetup.ps1", winProductSetup, "required package directory missing");

  const winProductLauncher = read("install/windows/product/BlueTanukiLauncher.ps1");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "Get-ControlCenterUrl");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "Start-Resident");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "Assert-PortAvailable");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "port_conflict=");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "Start-Watchdog");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "watchdog_restarted=pass");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "safe-mode");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "BLUE_TANUKI_SAFE_MODE");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "Run-Doctor");
  requireIncludes("install/windows/product/BlueTanukiLauncher.ps1", winProductLauncher, "bundled node.exe");

  const winProductUninstall = read("install/windows/product/BlueTanukiUninstall.ps1");
  requireIncludes("install/windows/product/BlueTanukiUninstall.ps1", winProductUninstall, "PurgeData");
  requireIncludes("install/windows/product/BlueTanukiUninstall.ps1", winProductUninstall, "User data retained");
  requireIncludes("install/windows/product/BlueTanukiUninstall.ps1", winProductUninstall, "Assert-SafeTarget");

  const packageWindows = read("scripts/package_windows.ts");
  requireIncludes("scripts/package_windows.ts", packageWindows, "windows-x64-zip-installer");
  requireIncludes("scripts/package_windows.ts", packageWindows, "win-x64.zip");
  requireIncludes("scripts/package_windows.ts", packageWindows, "requires_node_pnpm_git_from_user: false");
  requireIncludes("scripts/package_windows.ts", packageWindows, "installer_autostart: false");
  requireIncludes("scripts/package_windows.ts", packageWindows, "README_INSTALL_WINDOWS.txt");
  requireIncludes("scripts/package_windows.ts", packageWindows, "const shaFile = `${outFile}.sha256`");
  requireIncludes("scripts/package_windows.ts", packageWindows, "SHASUMS256.txt");
  requireIncludes("scripts/package_windows.ts", packageWindows, "runtime_sha256_verified=true");

  const verifyWindowsPackage = read("scripts/verify_windows_package.ts");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "verifyWindowsPackage");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "GUI-Shell");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "Start Menu");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "README_INSTALL_WINDOWS.txt");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "const shaFile = `${archive}.sha256`");
  requireIncludes("scripts/verify_windows_package.ts", verifyWindowsPackage, "shasums_source");

  const smokeWindowsInstalled = read("scripts/smoke_windows_installed.ts");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "windows_runtime_smoke=skipped");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "source_tree_setup_guidance_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "root_source_entrypoint_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "root_source_entrypoint_build_from_source_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "root_source_entrypoint_cmd_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "installer_zip_setup_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "first_message_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "repair_install_result=pass");
  requireIncludes("scripts/smoke_windows_installed.ts", smokeWindowsInstalled, "crash_recovery_result=pass");

  const macInstall = read("install/macos/install.sh");
  requireIncludes("install/macos/install.sh", macInstall, "Node.js 22.14.0");
  requireIncludes("install/macos/install.sh", macInstall, "pnpm@");
  requireIncludes("install/macos/install.sh", macInstall, "--setup --yes");
  requireIncludes("install/macos/install.sh", macInstall, "RUN_DOCTOR");
  requireIncludes("install/macos/install.sh", macInstall, "RESET_CONFIG");
  requireIncludes("install/macos/install.sh", macInstall, "LAUNCH_AFTER_INSTALL");
  requireIncludes("install/macos/install.sh", macInstall, "NO_LAUNCH");
  requireIncludes("install/macos/install.sh", macInstall, "Existing env file retained");
  requireIncludes("install/macos/install.sh", macInstall, "Add RESET_CONFIG=1 only");
  requireIncludes("install/macos/install.sh", macInstall, "post-install doctor");
  requireIncludes("install/macos/install.sh", macInstall, "doctor)");
  requireIncludes("install/macos/install.sh", macInstall, "resident-start");
  requireIncludes("install/macos/install.sh", macInstall, "resident-open");
  requireIncludes("install/macos/install.sh", macInstall, "resident-autostart-enable");
  requireIncludes("install/macos/install.sh", macInstall, "Control:");
  requireIncludes("install/macos/install.sh", macInstall, "/settings");

  const macUninstall = read("install/macos/uninstall.sh");
  requireIncludes("install/macos/uninstall.sh", macUninstall, "PURGE");
  requireIncludes("install/macos/uninstall.sh", macUninstall, "DRY_RUN");
  requireIncludes("install/macos/uninstall.sh", macUninstall, "safe_target");
  requireIncludes("install/macos/uninstall.sh", macUninstall, "resident-autostart-disable");
  requireIncludes("install/macos/uninstall.sh", macUninstall, "Data retained");

  const linuxInstall = read("install/linux/install.sh");
  requireIncludes("install/linux/install.sh", linuxInstall, "Node.js 22.14.0");
  requireIncludes("install/linux/install.sh", linuxInstall, "pnpm@");
  requireIncludes("install/linux/install.sh", linuxInstall, "--setup --yes");
  requireIncludes("install/linux/install.sh", linuxInstall, "RUN_DOCTOR");
  requireIncludes("install/linux/install.sh", linuxInstall, "RESET_CONFIG");
  requireIncludes("install/linux/install.sh", linuxInstall, "LAUNCH_AFTER_INSTALL");
  requireIncludes("install/linux/install.sh", linuxInstall, "NO_LAUNCH");
  requireIncludes("install/linux/install.sh", linuxInstall, "Existing env file retained");
  requireIncludes("install/linux/install.sh", linuxInstall, "Add RESET_CONFIG=1 only");
  requireIncludes("install/linux/install.sh", linuxInstall, "post-install doctor");
  requireIncludes("install/linux/install.sh", linuxInstall, "doctor)");
  requireIncludes("install/linux/install.sh", linuxInstall, "resident-start");
  requireIncludes("install/linux/install.sh", linuxInstall, "resident-open");
  requireIncludes("install/linux/install.sh", linuxInstall, "resident-autostart-enable");
  requireIncludes("install/linux/install.sh", linuxInstall, "Control:");
  requireIncludes("install/linux/install.sh", linuxInstall, "/settings");

  const linuxUninstall = read("install/linux/uninstall.sh");
  requireIncludes("install/linux/uninstall.sh", linuxUninstall, "PURGE");
  requireIncludes("install/linux/uninstall.sh", linuxUninstall, "DRY_RUN");
  requireIncludes("install/linux/uninstall.sh", linuxUninstall, "safe_target");
  requireIncludes("install/linux/uninstall.sh", linuxUninstall, "resident-autostart-disable");
  requireIncludes("install/linux/uninstall.sh", linuxUninstall, "Config retained");

  const releaseBundle = read("scripts/create_release_bundle.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "CORE_RELEASE_PATHS");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_LINUX.desktop");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_MACOS.command");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_MACOS.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_LINUX.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_WINDOWS.cmd");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "INSTALL_WINDOWS.ps1");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "windows_installer_artifacts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "ensureWindowsInstallerArtifacts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "copyWindowsInstallerArtifacts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "release/windows/blue-tanuki-${version}-windows-x64-installer.zip");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "packages/hds-brain");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "packages/channel-webchat");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "packages/channel-telegram");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/CHANNEL_PROMOTION_GATE.md");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/phase11-s11-channel-first-party-promotion.md");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "scripts/channel_promotion_gate.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "apps/gateway/src/plugin_review_gate.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "scripts/plugin_review_gate.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/phase11-s12-plugin-review-gate-implementation.md");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "scripts/ga_promotion_gate.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/v1.0-ga-promotion-review.md");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/phase11-s13-v1-ga-promotion-execution.md");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/linux/install.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/linux/uninstall.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/macos/install.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/macos/uninstall.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/resident/blue-tanuki-resident.sh");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/resident/blue-tanuki-resident.ps1");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/windows/product");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "install/windows/product/BlueTanukiSetup.ps1");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "scripts/package_windows.ts");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "docs/WINDOWS_INSTALLER_GUIDE.md");
  requireNotIncludes("scripts/create_release_bundle.ts", releaseBundle, "\"packages/channel-slack\"");
  requireNotIncludes("scripts/create_release_bundle.ts", releaseBundle, "\"install/installer\"");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, ".sha256");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, ".manifest.json");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "isSecretLikeFileName");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, "blue-tanuki.env.");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, ".env.bak");
  requireIncludes("scripts/create_release_bundle.ts", releaseBundle, ".pem");

  const releaseVerify = read("scripts/verify_release_bundle.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "sha256");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_LINUX.desktop");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_MACOS.command");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_MACOS.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_LINUX.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_WINDOWS.cmd");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "INSTALL_WINDOWS.ps1");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "windows_installer_artifacts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "release/windows/blue-tanuki-${version}-windows-x64-installer.zip");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "manifest");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "core_release_paths");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "EXTRACTED_RELEASE_COMMANDS");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "pnpm\", \"run\", \"doctor");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "validate:repo-health");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "tar");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/CHANNEL_PROMOTION_GATE.md");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/phase11-s11-channel-first-party-promotion.md");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "scripts/channel_promotion_gate.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "apps/gateway/src/plugin_review_gate.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "scripts/plugin_review_gate.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/phase11-s12-plugin-review-gate-implementation.md");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "scripts/ga_promotion_gate.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/v1.0-ga-promotion-review.md");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/phase11-s13-v1-ga-promotion-execution.md");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/linux/uninstall.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/macos/install.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/macos/uninstall.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/resident/blue-tanuki-resident.sh");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/resident/blue-tanuki-resident.ps1");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "install/windows/product/BlueTanukiSetup.ps1");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "scripts/verify_windows_package.ts");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "docs/WINDOWS_PACKAGING_AUDIT.md");
  requireNotIncludes("scripts/verify_release_bundle.ts", releaseVerify, "\"packages/channel-slack\"");
  requireNotIncludes("scripts/verify_release_bundle.ts", releaseVerify, "\"install/installer\"");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "isForbiddenFileName");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, "blue-tanuki.env.");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, ".env.bak");
  requireIncludes("scripts/verify_release_bundle.ts", releaseVerify, ".pem");

  const doctor = read("apps/gateway/src/doctor.ts");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "distribution_readiness");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "Distribution readiness");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "guided first-run installer docs");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "resident app guide");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "plugin review gate");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "pnpm plugin:review");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "GA promotion review");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "pnpm validate:ga");
  requireIncludes("apps/gateway/src/doctor.ts", doctor, "does not build signed native packages yet");
  requireIncludes(
    "apps/gateway/src/doctor.ts",
    doctor,
    "does not currently implement an automatic updater",
  );

  const runbook = read("docs/UPDATE_ROLLBACK_RUNBOOK.md");
  requireIncludes(
    "docs/UPDATE_ROLLBACK_RUNBOOK.md",
    runbook,
    "does not currently implement an automatic updater",
  );
  requireIncludes(
    "docs/UPDATE_ROLLBACK_RUNBOOK.md",
    runbook,
    "Distribution readiness gate",
  );

  const phase10s3 = read("docs/phase10-s3-distribution-ux-hardening.md");
  requireIncludes(
    "docs/phase10-s3-distribution-ux-hardening.md",
    phase10s3,
    "No signed native installer",
  );
  requireIncludes(
    "docs/phase10-s3-distribution-ux-hardening.md",
    phase10s3,
    "No automatic updater",
  );

  const packageJson = read("package.json");
  requireIncludes("package.json", packageJson, "\"installer:run\"");
  requireIncludes("package.json", packageJson, "\"installer:verify\"");
  requireIncludes("package.json", packageJson, "\"package:windows\"");
  requireIncludes("package.json", packageJson, "\"package:windows:verify\"");
  requireIncludes("package.json", packageJson, "\"installer:windows\"");
  requireIncludes("package.json", packageJson, "\"installer:windows:verify\"");
  requireIncludes("package.json", packageJson, "\"smoke:windows-installed\"");
  requireIncludes("package.json", packageJson, "\"validate:repo-health\"");
  requireIncludes("package.json", packageJson, "\"validate:channels\"");
  requireIncludes("package.json", packageJson, "\"validate:ga\"");
  requireIncludes("package.json", packageJson, "\"plugin:review\"");
  requireIncludes("package.json", packageJson, "\"release:verify\"");
  requireIncludes("package.json", packageJson, "\"version\": \"1.0.0-rc.1\"");

  const docsIndex = read("docs/INDEX.md");
  requireIncludes("docs/INDEX.md", docsIndex, "CHANNEL_PROMOTION_GATE.md");
  requireIncludes("docs/INDEX.md", docsIndex, "PLUGIN_REVIEW_GATE.md");
  requireIncludes("docs/INDEX.md", docsIndex, "INSTALLER_GUIDE.md");
  requireIncludes("docs/INDEX.md", docsIndex, "RESIDENT_APP_GUIDE.md");
  requireIncludes("docs/INDEX.md", docsIndex, "phase11-s9-installer-setup-ux.md");
  requireIncludes("docs/INDEX.md", docsIndex, "phase11-s10-resident-application-integration.md");
  requireIncludes("docs/INDEX.md", docsIndex, "phase11-s11-channel-first-party-promotion.md");
  requireIncludes("docs/INDEX.md", docsIndex, "phase11-s12-plugin-review-gate-implementation.md");
  requireIncludes("docs/INDEX.md", docsIndex, "phase11-s13-v1-ga-promotion-execution.md");
  requireIncludes("docs/INDEX.md", docsIndex, "v1.0-release-candidate.md");
  requireIncludes("docs/INDEX.md", docsIndex, "v1.0-post-rc-closure-review.md");
  requireIncludes("docs/INDEX.md", docsIndex, "v1.0-ga-promotion-review.md");
  requireIncludes("docs/INDEX.md", docsIndex, "v1.0-security-and-permanent-use-review.md");

  const releaseCandidate = read("docs/v1.0-release-candidate.md");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "1.0.0-rc.1");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "generated `.sha256`");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "No hard-coded archive SHA");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "first-party-preview");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "validate:channels");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "plugin:review");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "Plugin Review Gate");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "validate:ga");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "reserved-third-party");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "No signed native installer");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "resident app path");
  requireIncludes("docs/v1.0-release-candidate.md", releaseCandidate, "No automatic updater");
  requireNotMatches(
    "docs/v1.0-release-candidate.md",
    releaseCandidate,
    /SHA-256: `?[a-f0-9]{64}`?/i,
    "hard-coded release bundle SHA",
  );

  const postRcReview = read("docs/v1.0-post-rc-closure-review.md");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "Credentialed Live Smoke");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "Channel Promotion Gate");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "Plugin Review Gate");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "pnpm plugin:review");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "GA Promotion Gate");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "pnpm validate:ga");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "Status: PASS");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "cannot be completed in this workspace");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "remain `first-party-preview`");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "No signed native installer");
  requireIncludes("docs/v1.0-post-rc-closure-review.md", postRcReview, "No automatic updater");

  const compatibilityMatrix = read("docs/compatibility-matrix.json");
  requireIncludes("docs/compatibility-matrix.json", compatibilityMatrix, "\"target_release\": \"v1.0\"");
  requireIncludes("docs/compatibility-matrix.json", compatibilityMatrix, "\"target_release\": \"v1.0-preview\"");

  const gitignore = read(".gitignore");
  requireIncludes(".gitignore", gitignore, "*.env.*.bak");
  requireIncludes(".gitignore", gitignore, "blue-tanuki.env.*.bak");
  requireIncludes(".gitignore", gitignore, "*.pem");

  const envFile = read("apps/gateway/src/env_file.ts");
  requireIncludes("apps/gateway/src/env_file.ts", envFile, "writeEnvFileAtomic");
  requireIncludes("apps/gateway/src/env_file.ts", envFile, "backupEnvFileIfExists");
  requireIncludes("apps/gateway/src/env_file.ts", envFile, ".bak");

  const settingsSurface = read("apps/gateway/src/settings_surface.ts");
  requireIncludes("apps/gateway/src/settings_surface.ts", settingsSurface, "writeEnvFileAtomic");
  requireIncludes("apps/gateway/src/settings_surface.ts", settingsSurface, "backup_label: \"settings\"");
  requireIncludes("apps/gateway/src/settings_surface.ts", settingsSurface, "verifyLlmProvisioning");
  requireIncludes("apps/gateway/src/settings_surface.ts", settingsSurface, "Verify LLM");

  const settingsApi = read("apps/gateway/src/control_center/setup/api_settings.ts");
  requireIncludes("apps/gateway/src/control_center/setup/api_settings.ts", settingsApi, "verifyLlmProvisioning");
  requireIncludes("apps/gateway/src/control_center/setup/api_settings.ts", settingsApi, "secret_exposed: false");

  const settingsSetupPage = read("apps/gateway/src/control_center/setup/setup_page.ts");
  requireIncludes("apps/gateway/src/control_center/setup/setup_page.ts", settingsSetupPage, "/settings/llm/verify");

  const webchat = read("packages/channel-webchat/src/webchat.ts");
  requireIncludes("packages/channel-webchat/src/webchat.ts", webchat, "/settings/llm/verify");
  requireIncludes("packages/channel-webchat/src/webchat.ts", webchat, "verifyLlm");

  const setup = read("apps/gateway/src/setup.ts");
  requireIncludes("apps/gateway/src/setup.ts", setup, "writeEnvFileAtomic");
  requireIncludes("apps/gateway/src/setup.ts", setup, "backup_label: \"setup\"");

  const dockerfile = read("Dockerfile");
  requireIncludes("Dockerfile", dockerfile, "USER blue-tanuki");
  requireIncludes("Dockerfile", dockerfile, "HEALTHCHECK");
  requireIncludes("Dockerfile", dockerfile, "apps/gateway/dist/main.js");
  requireIncludes("Dockerfile", dockerfile, "--serve");

  const compose = read("docker-compose.yml");
  requireIncludes("docker-compose.yml", compose, "WEBCHAT_TOKEN is required");
  requireIncludes(
    "docker-compose.yml",
    compose,
    "WEBCHAT_RESUME_TOKEN is required",
  );
  requireIncludes("docker-compose.yml", compose, "BLUE_TANUKI_AUDIT_DIR");
  requireIncludes("docker-compose.yml", compose, "BLUE_TANUKI_SESSION_DIR");
  requireIncludes("docker-compose.yml", compose, "BLUE_TANUKI_SETTINGS_TOKEN");

  const workflow = read(".github/workflows/ci.yml");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm typecheck");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm build");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm test");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm docs:check");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm validate:packaging");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm validate:channels");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm plugin:review");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm validate:ga");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm smoke:serve");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm smoke:resume");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm run doctor");
  requireIncludes(".github/workflows/ci.yml", workflow, "docker build");
  requireIncludes(".github/workflows/ci.yml", workflow, "WEBCHAT_RESUME_TOKEN");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm release:bundle -- --dry-run");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm release:verify");

  const unit = read("deploy/systemd/blue-tanuki.service");
  requireIncludes("deploy/systemd/blue-tanuki.service", unit, "User=blue-tanuki");
  requireIncludes(
    "deploy/systemd/blue-tanuki.service",
    unit,
    "EnvironmentFile=/etc/blue-tanuki/blue-tanuki.env",
  );
  requireIncludes("deploy/systemd/blue-tanuki.service", unit, "ExecStartPre=");
  requireIncludes("deploy/systemd/blue-tanuki.service", unit, "--doctor");
  requireIncludes("deploy/systemd/blue-tanuki.service", unit, "--serve");
  requireIncludes("deploy/systemd/blue-tanuki.service", unit, "NoNewPrivileges=true");
  requireNotIncludes(
    "deploy/systemd/blue-tanuki.service",
    unit,
    "WEBCHAT_TOKEN=replace",
  );

  const env = read("deploy/systemd/blue-tanuki.env.example");
  requireIncludes("deploy/systemd/blue-tanuki.env.example", env, "WEBCHAT_TOKEN=");
  requireIncludes(
    "deploy/systemd/blue-tanuki.env.example",
    env,
    "WEBCHAT_RESUME_TOKEN=",
  );
  requireIncludes(
    "deploy/systemd/blue-tanuki.env.example",
    env,
    "BLUE_TANUKI_SETTINGS_TOKEN=",
  );
  requireIncludes(
    "deploy/systemd/blue-tanuki.env.example",
    env,
    "BLUE_TANUKI_AUDIT_DIR=/var/lib/blue-tanuki/audit",
  );
  requireIncludes(
    "deploy/systemd/blue-tanuki.env.example",
    env,
    "BLUE_TANUKI_DAILY_BRIEF_CONTENT=Daily Brief: scheduled smoke from BLUE-TANUKI v1.0 RC",
  );
  requireNotIncludes("deploy/systemd/blue-tanuki.env.example", env, "v0.1");
  requireNotIncludes("deploy/systemd/blue-tanuki.env.example", env, "v0.2+");

  const cronChannel = read("apps/gateway/src/cron_channel.ts");
  requireIncludes("apps/gateway/src/cron_channel.ts", cronChannel, "Runtime cron source.");
  requireIncludes(
    "apps/gateway/src/cron_channel.ts",
    cronChannel,
    "\"Daily Brief: scheduled smoke from BLUE-TANUKI v1.0 RC.\"",
  );
  requireNotIncludes("apps/gateway/src/cron_channel.ts", cronChannel, "v0.1");

  const pluginReviewGate = read("docs/PLUGIN_REVIEW_GATE.md");
  requireIncludes("docs/PLUGIN_REVIEW_GATE.md", pluginReviewGate, "pnpm plugin:review");
  requireIncludes("docs/PLUGIN_REVIEW_GATE.md", pluginReviewGate, "blue-tanuki.review.json");
  requireIncludes("docs/PLUGIN_REVIEW_GATE.md", pluginReviewGate, "used_for_authority=false");

  const phase11s12 = read("docs/phase11-s12-plugin-review-gate-implementation.md");
  requireIncludes("docs/phase11-s12-plugin-review-gate-implementation.md", phase11s12, "Plugin Review Gate");
  requireIncludes("docs/phase11-s12-plugin-review-gate-implementation.md", phase11s12, "pnpm plugin:review");
  requireIncludes("docs/phase11-s12-plugin-review-gate-implementation.md", phase11s12, "layer_b_review_used_for_authority=false");

  const gaReview = read("docs/v1.0-ga-promotion-review.md");
  requireIncludes("docs/v1.0-ga-promotion-review.md", gaReview, "PENDING_OWNER_GO");
  requireIncludes("docs/v1.0-ga-promotion-review.md", gaReview, "pnpm validate:ga");
  requireIncludes("docs/v1.0-ga-promotion-review.md", gaReview, "public_claim_allowed=false");

  const phase11s13 = read("docs/phase11-s13-v1-ga-promotion-execution.md");
  requireIncludes("docs/phase11-s13-v1-ga-promotion-execution.md", phase11s13, "v1.0 GA Promotion Execution");
  requireIncludes("docs/phase11-s13-v1-ga-promotion-execution.md", phase11s13, "pnpm validate:ga");
  requireIncludes("docs/phase11-s13-v1-ga-promotion-execution.md", phase11s13, "PENDING_OWNER_GO");

  console.log("[packaging] PASS");
}

main();
