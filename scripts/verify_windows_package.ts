import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  "app/apps/gateway/dist/main.js",
  "app/apps/gateway/dist/plugin_review_gate.js",
  "app/apps/gateway/src/plugin_review_gate.ts",
  "app/packages/protocol/dist/index.js",
  "app/packages/protocol/blue-tanuki.plugin.json",
  "app/packages/hds-brain/dist/index.js",
  "app/packages/hds-brain/blue-tanuki.plugin.json",
  "app/packages/blue-tanuki/dist/index.js",
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
  "app/node_modules/@blue-tanuki/channel-base/package.json",
  "app/node_modules/@blue-tanuki/channel-webchat/package.json",
  "app/node_modules/@blue-tanuki/channel-telegram/package.json",
  "app/node_modules/@blue-tanuki/operator-writing/package.json",
  "app/node_modules/@blue-tanuki/operator-daily/package.json",
  "app/node_modules/@blue-tanuki/operator-developer/package.json",
  "app/node_modules/ws/package.json",
  "app/node_modules/zod/package.json",
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
  return path.join(root, "release/windows", `blue-tanuki-${pkg.version}-windows-x64-installer.zip`);
}

function artifactBase(file: string): string {
  return file.slice(0, -path.extname(file).length);
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

function assertManifest(manifest: ExternalManifest, archive: string, actualSha: string): void {
  if (manifest.schema_version !== 1) throw new Error("manifest schema_version must be 1");
  if (manifest.name !== "blue-tanuki") throw new Error("manifest name must be blue-tanuki");
  if (manifest.package_type !== "windows-x64-zip-installer") throw new Error("manifest package_type mismatch");
  if (manifest.archive?.file !== path.basename(archive)) throw new Error("manifest archive file mismatch");
  if (manifest.archive?.sha256 !== actualSha) throw new Error("manifest archive sha256 mismatch");
  if (manifest.node_runtime?.bundled !== true) throw new Error("manifest must declare bundled Node runtime");
  if (manifest.node_runtime?.version !== "22.14.0") throw new Error("manifest Node runtime version must be 22.14.0");
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
  const base = artifactBase(archive);
  const shaFile = `${base}.sha256`;
  const manifestFile = `${base}.manifest.json`;
  if (!existsSync(shaFile)) throw new Error(`missing sha256 sidecar: ${shaFile}`);
  if (!existsSync(manifestFile)) throw new Error(`missing manifest sidecar: ${manifestFile}`);
  const actualSha = sha256File(archive);
  const sidecarSha = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  if (sidecarSha !== actualSha) throw new Error("sha256 sidecar does not match artifact");
  assertManifest(readManifest(manifestFile), archive, actualSha);

  const entries = listZipEntries(archive);
  const entrySet = new Set(entries);
  for (const entry of entries) assertSafeEntry(entry);
  for (const required of REQUIRED_ENTRIES) {
    if (!entrySet.has(required)) {
      throw new Error(`installer zip missing required entry: ${required}`);
    }
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
    "Assert-SafeTarget",
    "blue-tanuki-install.json",
    "Split-Path -Parent $PSCommandPath",
    "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT",
    "BLUE_TANUKI_UNINSTALL_TEMP_SCRIPT",
    "BLUE_TANUKI_UNINSTALL_STATUS_FILE",
    "Write-UninstallStatus",
  ]);
  requireSourceText("install/windows/product/UninstallBlueTanuki.cmd", [
    "copy /Y",
    "start \"\" /b powershell.exe",
    "BLUE_TANUKI_UNINSTALL_DEFAULT_INSTALL_ROOT",
    "BLUE_TANUKI_UNINSTALL_STATUS_FILE",
    "exit /b 0",
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
