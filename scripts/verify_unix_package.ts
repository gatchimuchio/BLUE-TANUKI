import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPackageLocalBrowserRegistrySource,
  headlessShellExecutableRelativePath,
  parseHeadlessShellRevision,
  PLAYWRIGHT_CORE_VERSION,
} from "./playwright_browser_runtime.ts";

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
  linux_runtime?: {
    distribution?: string;
    architecture?: string;
    minimum_kernel?: string;
    libc?: string;
    minimum_libc?: string;
    musl_supported?: boolean;
    installer_dependencies?: string[];
    credential_storage?: "Linux Secret Service over the current-user session D-Bus is required only when persisting credentials";
    compatibility_source?: string;
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

function requiredKeyringEntries(platform: UnixPlatform, arch: UnixArch): string[] {
  const packages = platform === "linux"
    ? ["@napi-rs/keyring-linux-x64-gnu", "@napi-rs/keyring-linux-x64-musl"]
    : [`@napi-rs/keyring-darwin-${arch}`];
  return packages.flatMap((packageName) => {
    const suffix = packageName.replace("@napi-rs/keyring-", "");
    const base = `app/node_modules/${packageName}`;
    return [
      `${base}/package.json`,
      `${base}/keyring.${suffix}.node`,
      `${base}/LICENSE.third-party.md`,
    ];
  });
}

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
  "app/packages/blue-tanuki/dist/tools/builtin.js",
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
  "app/node_modules/playwright-core/package.json",
  "app/node_modules/playwright-core/browsers.json",
  "app/node_modules/playwright-core/LICENSE",
  "app/node_modules/playwright-core/NOTICE",
  "app/node_modules/playwright-core/ThirdPartyNotices.txt",
  "app/node_modules/zod/package.json",
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
  "app/install/linux/install.sh",
  "app/install/macos/install.sh",
  "app/install/unix/safe-target.sh",
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

function readTarEntryText(archive: string, entry: string): string {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  let lastFailure = "";
  for (const archiveEntry of [normalized, `./${normalized}`]) {
    const result = spawnSync("tar", ["-xOzf", archive, archiveEntry], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout;
    }
    lastFailure = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
  }
  throw new Error(`tar read failed for ${entry}: ${lastFailure}`);
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
  const expectedSchemaVersion = platform === "linux" ? 2 : 1;
  if (manifest.schema_version !== expectedSchemaVersion) {
    throw new Error(`manifest schema_version must be ${expectedSchemaVersion}`);
  }
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
  const browserRuntime = manifest.browser_runtime;
  if (browserRuntime?.bundled !== true || browserRuntime.package !== "playwright-core" ||
      browserRuntime.package_version !== PLAYWRIGHT_CORE_VERSION || browserRuntime.engine !== "chromium" ||
      !/^\d+$/u.test(browserRuntime.revision ?? "") || browserRuntime.chromium_sandbox !== true ||
      browserRuntime.preview_enabled_by_default !== false) {
    throw new Error("manifest browser runtime boundary mismatch");
  }
  const expectedExecutable = `app/${headlessShellExecutableRelativePath(
    { platform: platform === "macos" ? "darwin" : "linux", arch },
    browserRuntime.revision!,
  )}`;
  if (browserRuntime.executable !== expectedExecutable) {
    throw new Error("manifest browser executable does not match the target headless-shell path");
  }
  if (platform === "linux") {
    const linux = manifest.linux_runtime;
    if (linux?.distribution !== "vendor-supported GNU/Linux releases using glibc") {
      throw new Error("Linux manifest must identify vendor-supported glibc GNU/Linux distributions");
    }
    if (linux.architecture !== "x64") throw new Error("Linux manifest architecture must be x64");
    if (linux.minimum_kernel !== "4.18") throw new Error("Linux manifest minimum kernel must be 4.18");
    if (linux.libc !== "glibc" || linux.minimum_libc !== "2.28" || linux.musl_supported !== false) {
      throw new Error("Linux manifest must identify the glibc 2.28 floor and reject musl");
    }
    if (JSON.stringify(linux.installer_dependencies) !== JSON.stringify([
      "POSIX sh and utilities", "getconf", "tar", "mktemp", "find", "ps", "awk", "sha256sum or shasum",
    ])) {
      throw new Error("Linux manifest installer dependencies mismatch");
    }
    if (linux.credential_storage !== "Linux Secret Service over the current-user session D-Bus is required only when persisting credentials") {
      throw new Error("Linux manifest credential storage requirement mismatch");
    }
    if (linux.compatibility_source !== "https://github.com/nodejs/node/blob/v22.14.0/BUILDING.md") {
      throw new Error("Linux manifest compatibility source mismatch");
    }
  } else if (manifest.linux_runtime !== undefined) {
    throw new Error("macOS manifest must not declare Linux runtime requirements");
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
  const manifest = readManifest(manifestFile);
  assertManifest(manifest, archive, actualSha, platform, arch);

  const readme = readFileSync(readmeFile, "utf8");
  const platformLabel = platform === "macos" ? "macOS" : "Linux";
  const setup = platform === "macos" ? "BlueTanukiSetup.command" : "BlueTanukiSetup.sh";
  const platformNeedles = platform === "linux" ? [
    "Target: vendor-supported GNU/Linux releases with x86_64, kernel >= 4.18, and glibc >= 2.28.",
    "musl-based distributions and non-x64 Linux are not supported by this package.",
    "Installer dependencies: POSIX sh and utilities, getconf, tar, mktemp, find, ps, awk, and sha256sum or shasum.",
    "Saving credentials requires Linux Secret Service over the user's session D-Bus; install and launch do not claim that credential service is available.",
  ] : [];
  const commonReadmeNeedles = platform === "macos" ? [
    "通常利用者はソースビルドを行わないでください",
    "ネイティブアプリ入口には",
    `展開先で${setup}を実行します。`,
    "利用者側にNode.js／pnpm／Gitの導入は不要です。",
    "署名なし",
    "公証提出もしていません",
    "macOSのセキュリティ設定を変更せず",
  ] : [
    `Normal ${platformLabel} users should not run source builds`,
    "Extract the installer archive",
    `Run ${setup}`,
    "user_requires_node_pnpm_git=false",
  ];
  for (const needle of [...commonReadmeNeedles, ...platformNeedles]) {
    if (!readme.includes(needle)) {
      throw new Error(`${path.basename(readmeFile)} missing required text: ${needle}`);
    }
  }

  const entries = listTarEntries(archive);
  const entrySet = new Set(entries);
  for (const entry of entries) assertSafeEntry(entry);
  const packagedPlaywright = JSON.parse(
    readTarEntryText(archive, "app/node_modules/playwright-core/package.json"),
  ) as { version?: string };
  if (packagedPlaywright.version !== PLAYWRIGHT_CORE_VERSION) {
    throw new Error("archive Playwright Core version does not match the browser runtime contract");
  }
  const archiveRevision = parseHeadlessShellRevision(
    readTarEntryText(archive, "app/node_modules/playwright-core/browsers.json"),
  );
  if (archiveRevision !== manifest.browser_runtime?.revision) {
    throw new Error("archive Playwright headless-shell revision does not match the manifest");
  }
  assertPackageLocalBrowserRegistrySource(
    readTarEntryText(archive, "app/packages/blue-tanuki/dist/tools/builtin.js"),
  );
  const shellExecutable = manifest.browser_runtime?.executable;
  const shellPlatform = platform === "linux" ? "linux64" : arch === "x64" ? "mac-x64" : "mac-arm64";
  const shellLicense = `app/node_modules/playwright-core/.local-browsers/chromium_headless_shell-${archiveRevision}/chrome-headless-shell-${shellPlatform}/LICENSE.headless_shell`;
  for (const required of [shellExecutable, shellLicense]) {
    if (!required || !entrySet.has(required)) {
      throw new Error(`installer archive missing browser runtime or notice entry: ${required}`);
    }
  }
  if (entries.some((entry) => entry.includes(`/chromium-${archiveRevision}/`))) {
    throw new Error("installer archive contains unused full Chromium binaries; only headless shell is required");
  }
  const platformNativeEntries = platform === "linux"
    ? ["app/node_modules/@blue-tanuki/core/dist/native/blue-tanuki-linux-isolation"]
    : [];
  for (const required of [
    "BlueTanukiSetup.sh",
    "safe-target.sh",
    "unix-installer-manifest.json",
    requiredRuntime(platform, arch),
    "launcher/BlueTanukiLauncher.sh",
    "launcher/BlueTanukiUninstall.sh",
    ...REQUIRED_APP_ENTRIES,
    ...platformNativeEntries,
    ...requiredKeyringEntries(platform, arch),
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
    '"$PACKAGE_ROOT/safe-target.sh"',
    "assert_not_ancestor_target",
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
    "safe_destructive_target",
    "install/unix/safe-target.sh",
    "assert_not_ancestor_target",
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
