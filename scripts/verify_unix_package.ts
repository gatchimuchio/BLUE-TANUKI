import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type UnixPlatform = "linux" | "macos";
type UnixArch = "x64" | "arm64";

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
  user_experience?: {
    requires_node_pnpm_git_from_user?: boolean;
    creates_user_launcher?: boolean;
    creates_desktop_or_app_shortcut?: boolean;
    autostart_enabled_by_default?: boolean;
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

const REQUIRED_APP_ENTRIES = [
  "app/package.json",
  "app/pnpm-workspace.yaml",
  "app/LICENSE",
  "app/LICENSE-APACHE-2.0",
  "app/LICENSE-CC-BY-4.0",
  "app/NOTICE",
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
  "app/packages/blue-tanuki/blue-tanuki.plugin.json",
  "app/packages/channel-base/dist/index.js",
  "app/packages/channel-webchat/dist/index.js",
  "app/packages/channel-telegram/dist/index.js",
  "app/packages/operator-writing/dist/index.js",
  "app/packages/operator-daily/dist/index.js",
  "app/packages/operator-developer/dist/index.js",
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
  "app/install/linux/install.sh",
  "app/install/macos/install.sh",
  "app/install/resident/blue-tanuki-resident.sh",
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

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function readPackage(): { version: string } {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
}

function normalizePlatform(value: string | undefined): UnixPlatform {
  if (!value) return process.platform === "darwin" ? "macos" : "linux";
  if (value === "linux" || value === "macos") return value;
  if (value === "darwin") return "macos";
  throw new Error(`unsupported Unix platform: ${value}`);
}

function normalizeArch(value: string | undefined): UnixArch {
  const raw = value ?? (process.arch === "arm64" ? "arm64" : "x64");
  if (raw === "x64" || raw === "arm64") return raw;
  if (raw === "x86_64" || raw === "amd64") return "x64";
  throw new Error(`unsupported Unix arch: ${raw}`);
}

function defaultArtifacts(): Array<{ artifact: string; platform: UnixPlatform; arch: UnixArch }> {
  const pkg = readPackage();
  if (hasArg("--all")) {
    return [
      {
        artifact: path.join(root, "release/linux", `blue-tanuki-${pkg.version}-linux-x64-installer.tar.gz`),
        platform: "linux",
        arch: "x64",
      },
      {
        artifact: path.join(root, "release/macos", `blue-tanuki-${pkg.version}-macos-x64-installer.tar.gz`),
        platform: "macos",
        arch: "x64",
      },
      {
        artifact: path.join(root, "release/macos", `blue-tanuki-${pkg.version}-macos-arm64-installer.tar.gz`),
        platform: "macos",
        arch: "arm64",
      },
    ];
  }
  const platform = normalizePlatform(argValue("--platform"));
  const arch = platform === "linux" ? "x64" : normalizeArch(argValue("--arch"));
  const artifact = argValue("--artifact")
    ? path.resolve(argValue("--artifact")!)
    : path.join(root, `release/${platform}`, `blue-tanuki-${pkg.version}-${platform}-${arch}-installer.tar.gz`);
  return [{ artifact, platform, arch }];
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readManifest(file: string): ExternalManifest {
  return JSON.parse(readFileSync(file, "utf8")) as ExternalManifest;
}

function listTarEntries(archive: string): string[] {
  const result = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar list failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean);
}

function assertSafeEntry(entry: string): void {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`archive contains absolute path: ${entry}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error(`archive contains traversal path: ${entry}`);
  }
  for (const part of parts) {
    if (part === ".git" || part === ".blue-tanuki" || part === ".codex-tmp" || part === "GUI-Shell") {
      throw new Error(`archive contains forbidden directory: ${entry}`);
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
    throw new Error(`archive contains secret-like file: ${entry}`);
  }
}

function requiredRuntime(platform: UnixPlatform, arch: UnixArch): string {
  if (platform === "linux") return "runtime/node-v22.14.0-linux-x64.tar.xz";
  return `runtime/node-v22.14.0-darwin-${arch}.tar.gz`;
}

function assertManifest(
  manifest: ExternalManifest,
  archive: string,
  actualSha: string,
  platform: UnixPlatform,
  arch: UnixArch,
): void {
  if (manifest.schema_version !== 1) throw new Error("manifest schema_version must be 1");
  if (manifest.name !== "blue-tanuki") throw new Error("manifest name must be blue-tanuki");
  if (manifest.package_type !== `${platform}-${arch}-tar-installer`) throw new Error("manifest package_type mismatch");
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
  if (manifest.user_experience?.requires_node_pnpm_git_from_user !== false) {
    throw new Error("manifest must declare no user Node/pnpm/Git requirement");
  }
  if (manifest.user_experience?.creates_user_launcher !== true) {
    throw new Error("manifest must declare user launcher creation");
  }
  if (manifest.user_experience?.creates_desktop_or_app_shortcut !== true) {
    throw new Error("manifest must declare desktop/app shortcut creation");
  }
  if (manifest.user_experience?.autostart_enabled_by_default !== false) {
    throw new Error("manifest must declare autostart disabled by default");
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

export function verifyUnixPackage(
  artifact: string,
  platform: UnixPlatform,
  arch: UnixArch,
): void {
  const archive = path.resolve(artifact);
  if (!existsSync(archive)) {
    throw new Error(`missing ${platform} installer artifact: ${archive}`);
  }
  const shaFile = `${archive}.sha256`;
  const manifestFile = `${archive}.manifest.json`;
  const readmeFile = path.join(path.dirname(archive), platform === "macos" ? "README_INSTALL_MACOS.txt" : "README_INSTALL_LINUX.txt");
  if (!existsSync(shaFile)) throw new Error(`missing sha256 sidecar: ${shaFile}`);
  if (!existsSync(manifestFile)) throw new Error(`missing manifest sidecar: ${manifestFile}`);
  if (!existsSync(readmeFile)) throw new Error(`missing install README: ${readmeFile}`);
  const actualSha = sha256File(archive);
  const sidecarSha = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  if (sidecarSha !== actualSha) throw new Error("sha256 sidecar does not match artifact");
  assertManifest(readManifest(manifestFile), archive, actualSha, platform, arch);

  const readme = readFileSync(readmeFile, "utf8");
  const platformLabel = platform === "macos" ? "macOS" : "Linux";
  const setup = platform === "macos" ? "BlueTanukiSetup.command" : "BlueTanukiSetup.sh";
  for (const needle of [
    `Normal ${platformLabel} users should not run source builds`,
    "Extract the installer archive",
    `Run ${setup}`,
    "user_requires_node_pnpm_git=false",
  ]) {
    if (!readme.includes(needle)) {
      throw new Error(`${path.basename(readmeFile)} missing required text: ${needle}`);
    }
  }

  const entries = listTarEntries(archive);
  const entrySet = new Set(entries);
  for (const entry of entries) assertSafeEntry(entry);
  for (const required of [
    "BlueTanukiSetup.sh",
    "unix-installer-manifest.json",
    requiredRuntime(platform, arch),
    "launcher/BlueTanukiLauncher.sh",
    "launcher/BlueTanukiUninstall.sh",
    ...REQUIRED_APP_ENTRIES,
  ]) {
    if (!entrySet.has(required)) {
      throw new Error(`installer archive missing required entry: ${required}`);
    }
  }
  if (platform === "macos" && !entrySet.has("BlueTanukiSetup.command")) {
    throw new Error("macOS installer archive missing BlueTanukiSetup.command");
  }

  requireSourceText("install/unix/product/BlueTanukiSetup.sh", [
    "This setup script must be run from the packaged",
    "user_requires_node_pnpm_git=false",
    "Autostart: not enabled by installer",
    "Existing env file retained",
    "post-install doctor",
    "install_result=pass",
  ]);
  requireSourceText("install/unix/product/BlueTanukiLauncher.sh", [
    "port_conflict=127.0.0.1:",
    "BLUE_TANUKI_SAFE_MODE",
    "watchdog_restarting_after_exit",
    "resident-autostart-enable",
    "autostart_status=disabled",
    "exec \"$NODE_EXE\" apps/gateway/dist/main.js --serve",
  ]);
  requireSourceText("install/unix/product/BlueTanukiUninstall.sh", [
    "safe_target",
    "Data retained",
    "Config retained",
    "uninstall_result=pass",
  ]);

  console.log(`${platform}_installer_verified=${archive}`);
  console.log(`platform=${platform}`);
  console.log(`arch=${arch}`);
  console.log(`entries=${entries.length}`);
  console.log(`sha256=${actualSha}`);
}

async function main(): Promise<void> {
  for (const target of defaultArtifacts()) {
    verifyUnixPackage(target.artifact, target.platform, target.arch);
  }
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
