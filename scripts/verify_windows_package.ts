import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { windowsArtifactDir } from "./windows_artifact_dir.js";
import { fileURLToPath } from "node:url";
import {
  assertPackageLocalBrowserRegistrySource,
  headlessShellExecutableRelativePath,
  parseHeadlessShellRevision,
  PLAYWRIGHT_CORE_VERSION,
} from "./playwright_browser_runtime.ts";

interface ExternalManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  package_type?: string;
  archive?: {
    file?: string;
    size_bytes?: number;
    sha256?: string;
  };
  node_runtime?: {
    bundled?: boolean;
    version?: string;
    archive?: string;
    sha256?: string;
    shasums_source?: string;
  };
  browser_runtime?: {
    bundled?: boolean;
    package?: string;
    package_version?: string;
    engine?: string;
    revision?: string;
    executable?: string;
    chromium_sandbox?: boolean;
    preview_enabled_by_default?: boolean;
  };
  user_experience?: {
    requires_node_pnpm_git_from_user?: boolean;
    creates_start_menu_shortcuts?: boolean;
    optional_desktop_shortcut?: boolean;
    autostart_enabled_by_default?: boolean;
    uninstall_registered?: boolean;
    gui_entry?: string;
  };
  boundaries?: {
    unsigned_installer?: boolean;
    secrets_included?: boolean;
    gui_shell_modified?: boolean;
    hds_authority_modified?: boolean;
    installer_autostart?: boolean;
  };
}

const root = process.cwd();

const REQUIRED_ENTRIES = [
  "BlueTanukiSetup.cmd",
  "BlueTanukiSetup.ps1",
  "windows-installer-manifest.json",
  "runtime/node-v22.14.0-win-x64.zip",
  "launcher/BlueTanuki.cmd",
  "launcher/BlueTanukiLauncher.ps1",
  "launcher/BlueTanukiUninstall.ps1",
  "launcher/BlueTanukiDoctor.cmd",
  "launcher/BlueTanukiLogs.cmd",
  "launcher/BlueTanukiRestart.cmd",
  "launcher/BlueTanukiSafeMode.cmd",
  "launcher/BlueTanukiStop.cmd",
  "launcher/UninstallBlueTanuki.cmd",
  "app/package.json",
  "app/pnpm-workspace.yaml",
  "app/LICENSE",
  "app/LICENSE-APACHE-2.0",
  "app/LICENSE-CC-BY-4.0",
  "app/NOTICE",
  "app/node_modules/playwright-core/LICENSE",
  "app/node_modules/playwright-core/NOTICE",
  "app/node_modules/playwright-core/ThirdPartyNotices.txt",
  "app/node_modules/playwright-core/browsers.json",
  "app/assets/aotanu/spritesheets/aotanu_idle_2x2.png",
  "app/assets/aotanu/spritesheets/aotanu_walk_2x2.png",
  "app/assets/aotanu/spritesheets/aotanu_working_2x2.png",
  "app/assets/aotanu/spritesheets/aotanu_happy_2x2.png",
  "app/assets/aotanu/spritesheets/aotanu_error_2x2.png",
  "app/apps/gateway/dist/main.js",
  "app/apps/gateway/dist/plugin_review_gate.js",
  "app/apps/gateway/src/plugin_review_gate.ts",
  "app/packages/protocol/dist/index.js",
  "app/packages/protocol/blue-tanuki.plugin.json",
  "app/packages/hds-brain/dist/index.js",
  "app/packages/hds-brain/blue-tanuki.plugin.json",
  "app/packages/blue-tanuki/dist/index.js",
  "app/packages/blue-tanuki/dist/tools/builtin.js",
  "app/packages/blue-tanuki/blue-tanuki.plugin.json",
  "app/packages/channel-base/dist/index.js",
  "app/packages/channel-webchat/dist/index.js",
  "app/packages/channel-telegram/dist/index.js",
  "app/packages/operator-writing/dist/index.js",
  "app/packages/operator-writing/blue-tanuki.plugin.json",
  "app/packages/operator-daily/dist/index.js",
  "app/packages/operator-daily/blue-tanuki.plugin.json",
  "app/packages/operator-developer/dist/index.js",
  "app/packages/operator-developer/blue-tanuki.plugin.json",
  "app/node_modules/@blue-tanuki/protocol/package.json",
  "app/node_modules/@blue-tanuki/hds-brain/package.json",
  "app/node_modules/@blue-tanuki/core/package.json",
  "app/node_modules/@blue-tanuki/core/dist/native/blue-tanuki-windows-isolation.exe",
  "app/node_modules/@blue-tanuki/channel-base/package.json",
  "app/node_modules/@blue-tanuki/channel-webchat/package.json",
  "app/node_modules/@blue-tanuki/channel-telegram/package.json",
  "app/node_modules/@blue-tanuki/operator-writing/package.json",
  "app/node_modules/@blue-tanuki/operator-daily/package.json",
  "app/node_modules/@blue-tanuki/operator-developer/package.json",
  "app/node_modules/ws/package.json",
  "app/node_modules/zod/package.json",
  "app/node_modules/playwright-core/package.json",
  "app/node_modules/playwright-core/LICENSE",
  "app/node_modules/@modelcontextprotocol/client/package.json",
  "app/node_modules/@modelcontextprotocol/client/dist/index.mjs",
  "app/node_modules/@modelcontextprotocol/core/package.json",
  "app/node_modules/@modelcontextprotocol/core/dist/index.mjs",
  "app/node_modules/@modelcontextprotocol/node_modules/zod/package.json",
  "app/node_modules/cross-spawn/package.json",
  "app/node_modules/eventsource/package.json",
  "app/node_modules/eventsource-parser/package.json",
  "app/node_modules/jose/package.json",
  "app/node_modules/pkce-challenge/package.json",
  "app/node_modules/path-key/package.json",
  "app/node_modules/shebang-command/package.json",
  "app/node_modules/shebang-regex/package.json",
  "app/node_modules/which/package.json",
  "app/node_modules/isexe/package.json",
  "app/node_modules/@napi-rs/keyring/package.json",
  "app/node_modules/@napi-rs/keyring/index.js",
  "app/node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
  "app/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
  "app/node_modules/@napi-rs/keyring-win32-x64-msvc/LICENSE.third-party.md",
  "app/install/unix/safe-target.sh",
  "app/docs/WINDOWS_INSTALLER_GUIDE.md",
  "app/docs/WINDOWS_FIRST_RUN.md",
  "app/docs/WINDOWS_PACKAGING_AUDIT.md",
  "app/docs/WINDOWS_UNINSTALL.md",
] as const;

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function defaultArtifact(): string {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  return path.join(windowsArtifactDir(root), `blue-tanuki-${pkg.version}-windows-x64-installer.zip`);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function commandExists(command: string): boolean {
  const result = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf8" })
    : spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0;
}

function listZipEntries(archive: string): string[] {
  if (commandExists("unzip")) {
    const result = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }
  const py = commandExists("python3") ? "python3" : commandExists("python") ? "python" : null;
  if (py) {
    const script =
      "import sys,zipfile\n" +
      "with zipfile.ZipFile(sys.argv[1]) as z:\n" +
      "  print('\\n'.join(z.namelist()))\n";
    const result = spawnSync(py, ["-c", script, archive], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }
  if (process.platform === "win32") {
    const command =
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      "$z=[IO.Compression.ZipFile]::OpenRead(" + JSON.stringify(archive) + "); " +
      "try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }
  throw new Error("could not list zip entries; install unzip, python, or PowerShell zip support");
}

function readZipEntryText(archive: string, entry: string): string {
  if (commandExists("unzip")) {
    const result = spawnSync("unzip", ["-p", archive, entry], { encoding: "utf8" });
    if (result.status === 0) return result.stdout;
  }
  const py = commandExists("python3") ? "python3" : commandExists("python") ? "python" : null;
  if (py) {
    const script =
      "import sys,zipfile\n" +
      "with zipfile.ZipFile(sys.argv[1]) as z:\n" +
      "  sys.stdout.buffer.write(z.read(sys.argv[2]))\n";
    const result = spawnSync(py, ["-c", script, archive, entry], { encoding: "utf8" });
    if (result.status === 0) return result.stdout;
  }
  if (process.platform === "win32") {
    const command =
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      "$z=[IO.Compression.ZipFile]::OpenRead(" + JSON.stringify(archive) + "); " +
      "try { $e=$z.GetEntry(" + JSON.stringify(entry) + "); if (-not $e) { throw 'entry missing' }; " +
      "$r=[IO.StreamReader]::new($e.Open()); try { $r.ReadToEnd() } finally { $r.Dispose() } } finally { $z.Dispose() }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    if (result.status === 0) return result.stdout;
  }
  throw new Error(`could not read zip entry: ${entry}`);
}

function readManifest(file: string): ExternalManifest {
  return JSON.parse(readFileSync(file, "utf8")) as ExternalManifest;
}

function assertSafeEntry(entry: string): void {
  const normalized = entry.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`zip contains absolute path: ${entry}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error(`zip contains traversal path: ${entry}`);
  }
  for (const part of parts) {
    if (part === ".git" || part === ".blue-tanuki" || part === ".codex-tmp" || part === "GUI-Shell") {
      throw new Error(`zip contains forbidden directory: ${entry}`);
    }
  }
  const base = parts.at(-1)?.toLowerCase() ?? "";
  if (
    base === ".env" ||
    base === ".npmrc" ||
    base === "blue-tanuki.env" ||
    base.endsWith(".pem") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base.endsWith(".key") ||
    (base.startsWith("blue-tanuki.env.") && base.endsWith(".bak")) ||
    base.endsWith(".env.bak")
  ) {
    throw new Error(`zip contains secret-like file: ${entry}`);
  }
}

function assertManifest(manifest: ExternalManifest, archive: string, actualSha: string): string {
  if (manifest.schema_version !== 1) throw new Error("manifest schema_version must be 1");
  if (manifest.name !== "blue-tanuki") throw new Error("manifest name must be blue-tanuki");
  if (manifest.package_type !== "windows-x64-zip-installer") throw new Error("manifest package_type mismatch");
  if (manifest.archive?.file !== path.basename(archive)) throw new Error("manifest archive file mismatch");
  if (manifest.archive?.sha256 !== actualSha) throw new Error("manifest archive sha256 mismatch");
  if (manifest.node_runtime?.bundled !== true) throw new Error("manifest must declare bundled Node runtime");
  if (manifest.node_runtime?.version !== "22.14.0") throw new Error("manifest Node runtime version must be 22.14.0");
  if (!/^[a-f0-9]{64}$/i.test(manifest.node_runtime?.sha256 ?? "")) {
    throw new Error("manifest Node runtime sha256 must be present");
  }
  if (manifest.node_runtime?.shasums_source !== "https://nodejs.org/dist/v22.14.0/SHASUMS256.txt") {
    throw new Error("manifest Node runtime shasums_source mismatch");
  }
  if (manifest.browser_runtime?.bundled !== true || manifest.browser_runtime.package !== "playwright-core" ||
      manifest.browser_runtime.package_version !== PLAYWRIGHT_CORE_VERSION || manifest.browser_runtime.engine !== "chromium" ||
      !/^\d+$/u.test(manifest.browser_runtime.revision ?? "") ||
      manifest.browser_runtime.chromium_sandbox !== true || manifest.browser_runtime.preview_enabled_by_default !== false) {
    throw new Error("manifest browser runtime boundary mismatch");
  }
  const browserExecutable = manifest.browser_runtime.executable?.replace(/\\/gu, "/");
  const expectedBrowserExecutable = `app/${headlessShellExecutableRelativePath(
    { platform: "win32", arch: "x64" },
    manifest.browser_runtime.revision!,
  )}`;
  if (!browserExecutable || browserExecutable !== expectedBrowserExecutable ||
      browserExecutable.startsWith("/") || /^[A-Za-z]:\//u.test(browserExecutable) ||
      browserExecutable.split("/").includes("..") ||
      !browserExecutable.startsWith("app/node_modules/playwright-core/.local-browsers/") ||
      !browserExecutable.toLowerCase().endsWith(".exe")) {
    throw new Error("manifest browser executable path is unsafe");
  }
  if (manifest.user_experience?.requires_node_pnpm_git_from_user !== false) {
    throw new Error("manifest must declare no user Node/pnpm/Git requirement");
  }
  if (manifest.user_experience?.creates_start_menu_shortcuts !== true) {
    throw new Error("manifest must declare Start Menu shortcut creation");
  }
  if (manifest.user_experience?.autostart_enabled_by_default !== false) {
    throw new Error("manifest must declare autostart disabled by default");
  }
  if (manifest.user_experience?.uninstall_registered !== true) {
    throw new Error("manifest must declare Windows uninstall registration");
  }
  if (manifest.boundaries?.unsigned_installer !== true) throw new Error("manifest must declare unsigned installer");
  if (manifest.boundaries?.secrets_included !== false) throw new Error("manifest must declare secrets excluded");
  if (manifest.boundaries?.gui_shell_modified !== false) throw new Error("manifest must declare GUI Shell untouched");
  if (manifest.boundaries?.hds_authority_modified !== false) throw new Error("manifest must declare HDS authority untouched");
  if (manifest.boundaries?.installer_autostart !== false) throw new Error("manifest must declare installer autostart false");
  return browserExecutable;
}

function requireSourceText(rel: string, needles: readonly string[]): void {
  const text = readFileSync(path.join(root, rel), "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(`${rel}: missing ${needle}`);
    }
  }
}

export function verifyWindowsPackage(artifact = defaultArtifact()): void {
  const archive = path.resolve(artifact);
  if (!existsSync(archive)) {
    throw new Error(`missing Windows installer artifact: ${archive}`);
  }
  const shaFile = `${archive}.sha256`;
  const manifestFile = `${archive}.manifest.json`;
  const installReadmeFile = path.join(path.dirname(archive), "README_INSTALL_WINDOWS.txt");
  if (!existsSync(shaFile)) throw new Error(`missing sha256 sidecar: ${shaFile}`);
  if (!existsSync(manifestFile)) throw new Error(`missing manifest sidecar: ${manifestFile}`);
  if (!existsSync(installReadmeFile)) throw new Error(`missing Windows install README: ${installReadmeFile}`);
  const actualSha = sha256File(archive);
  const sidecarSha = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  if (sidecarSha !== actualSha) throw new Error("sha256 sidecar does not match artifact");
  const manifest = readManifest(manifestFile);
  const browserExecutable = assertManifest(manifest, archive, actualSha);
  const installReadme = readFileSync(installReadmeFile, "utf8");
  for (const needle of [
    "Normal Windows users should not run source builds",
    `BlueTanukiSetup-${manifest.version}-windows-x64.exe`,
    "Double-click",
    "payload/recovery archive",
    "not approved for public distribution",
    "Do not run install/windows/product/BlueTanukiSetup.cmd from the source tree",
    "SHA-256",
    "SmartScreen",
  ]) {
    if (!installReadme.includes(needle)) {
      throw new Error(`README_INSTALL_WINDOWS.txt missing required text: ${needle}`);
    }
  }

  const entries = listZipEntries(archive);
  const entrySet = new Set(entries);
  for (const entry of entries) assertSafeEntry(entry);
  for (const required of REQUIRED_ENTRIES) {
    if (!entrySet.has(required)) {
      throw new Error(`installer zip missing required entry: ${required}`);
    }
  }
  const browserRevision = manifest.browser_runtime?.revision;
  if (!browserRevision) throw new Error("manifest browser runtime revision is missing");
  const packagedPlaywright = JSON.parse(
    readZipEntryText(archive, "app/node_modules/playwright-core/package.json"),
  ) as { version?: string };
  if (packagedPlaywright.version !== PLAYWRIGHT_CORE_VERSION) {
    throw new Error("archive Playwright Core version does not match the browser runtime contract");
  }
  const archiveRevision = parseHeadlessShellRevision(
    readZipEntryText(archive, "app/node_modules/playwright-core/browsers.json"),
  );
  if (archiveRevision !== browserRevision) {
    throw new Error("archive Playwright headless-shell revision does not match the manifest");
  }
  assertPackageLocalBrowserRegistrySource(
    readZipEntryText(archive, "app/packages/blue-tanuki/dist/tools/builtin.js"),
  );
  const shellLicense = `app/node_modules/playwright-core/.local-browsers/chromium_headless_shell-${browserRevision}/chrome-headless-shell-win64/LICENSE.headless_shell`;
  if (!entrySet.has(browserExecutable) || !entrySet.has(shellLicense)) {
    throw new Error("installer zip missing bundled Chromium headless-shell or its license");
  }
  if (entries.some((entry) => entry.includes(`/chromium-${browserRevision}/`))) {
    throw new Error("installer zip contains unused full Chromium binaries; only headless shell is required");
  }

  requireSourceText("install/windows/product/BlueTanukiSetup.ps1", [
    "Start Menu",
    "DesktopShortcut",
    "Register-Uninstaller",
    "Autostart: not enabled by installer",
    "Expand-Archive",
    "post-install doctor",
    "blue-tanuki-install.json",
    "data_root",
    "This setup script must be run from the packaged Windows installer zip.",
    "INSTALL_WINDOWS.cmd",
  ]);
  requireSourceText("install/windows/product/BlueTanukiLauncher.ps1", [
    "Get-ControlCenterUrl",
    "Start-Resident",
    "Assert-PortAvailable",
    "port_conflict=",
    "Start-Watchdog",
    "watchdog_restarted=pass",
    "safe-mode",
    "BLUE_TANUKI_SAFE_MODE",
    "Run-Doctor",
    "autostart-enable",
    "autostart-status",
    "BLUE_TANUKI_AUTOSTART_RUN_NAME",
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "Autostart is opt-in only",
    "bundled node.exe",
    "blue-tanuki-install.json",
    "Resolve-DataRoot",
  ]);
  requireSourceText("install/windows/product/BlueTanukiUninstall.ps1", [
    "PurgeData",
    "User data retained",
    "Uninstall\\BlueTanuki",
    "Assert-SafeInstallTargets",
    "Assert-ManagedWindowsProductInstall",
    "Assert-ManagedWindowsProductData",
    "blue-tanuki-install.json",
    "Split-Path -Parent $PSCommandPath",
    "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT",
    "BLUE_TANUKI_UNINSTALL_SAFE_TARGET",
    "BLUE_TANUKI_UNINSTALL_STATUS_FILE",
    "Write-UninstallStatus",
  ]);
  requireSourceText("install/windows/product/UninstallBlueTanuki.cmd", [
    "copy /Y",
    "powershell.exe -NoProfile -File",
    "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT",
    "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT",
    "BLUE_TANUKI_UNINSTALL_TEMP_HELPER",
    "BLUE_TANUKI_UNINSTALL_STATUS_FILE",
    "call \"%~f0\" %*",
    "&& exit 0 || (",
  ]);

  console.log(`windows_installer_verified=${archive}`);
  console.log(`entries=${entries.length}`);
  console.log(`sha256=${actualSha}`);
}

async function main(): Promise<void> {
  verifyWindowsPackage(argValue("--artifact"));
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
