import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

interface PackageJson {
  version: string;
}

const root = process.cwd();

const CORE_RELEASE_PATHS = [
  "apps/gateway",
  "packages/hds-brain",
  "packages/protocol",
  "packages/blue-tanuki",
  "packages/channel-base",
  "packages/channel-webchat",
  "packages/channel-telegram",
  "packages/operator-writing",
  "packages/operator-daily",
  "packages/operator-developer",
] as const;

const INCLUDED_PATHS = [
  ".dockerignore",
  ".github",
  ".gitignore",
  "CHANGELOG.md",
  "Dockerfile",
  "INSTALL.sh",
  "INSTALL_LINUX.desktop",
  "INSTALL_LINUX.sh",
  "INSTALL_MACOS.command",
  "INSTALL_MACOS.sh",
  "INSTALL_WINDOWS.cmd",
  "INSTALL_WINDOWS.ps1",
  "README.md",
  "deploy",
  "docker-compose.yml",
  "docs",
  "install/linux",
  "install/macos",
  "install/resident",
  "install/unix",
  "install/windows/product",
  "install/README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts",
  "tooling",
  "tsconfig.base.json",
  ...CORE_RELEASE_PATHS,
] as const;

const REQUIRED_PATHS = [
  "install/README.md",
  "INSTALL.sh",
  "INSTALL_LINUX.desktop",
  "INSTALL_LINUX.sh",
  "INSTALL_MACOS.command",
  "INSTALL_MACOS.sh",
  "INSTALL_WINDOWS.cmd",
  "INSTALL_WINDOWS.ps1",
  "install/linux/install.sh",
  "install/linux/uninstall.sh",
  "install/macos/install.sh",
  "install/macos/uninstall.sh",
  "install/resident/README.md",
  "install/resident/blue-tanuki-resident.ps1",
  "install/resident/blue-tanuki-resident.sh",
  "install/unix/product/BlueTanukiSetup.sh",
  "install/unix/product/BlueTanukiLauncher.sh",
  "install/unix/product/BlueTanukiUninstall.sh",
  "install/windows/product/BlueTanukiSetup.ps1",
  "install/windows/product/BlueTanukiLauncher.ps1",
  "install/windows/product/BlueTanukiUninstall.ps1",
  "apps/gateway/dist/main.js",
  "packages/channel-webchat/dist/webchat.js",
  "packages/channel-telegram/dist/telegram.js",
  "packages/operator-writing/dist/index.js",
  "packages/operator-daily/dist/index.js",
  "packages/operator-developer/dist/index.js",
  "apps/gateway/dist/approval_runtime.js",
  "packages/hds-brain/dist/approval_store.js",
  "docs/history/phase7-s2-approval-gate-execution-bridge.md",
  "docs/history/phase7-s3-full-access-default.md",
  "docs/history/phase7-s4-transparent-full-access-authority.md",
  "docs/CHANNEL_PROMOTION_GATE.md",
  "docs/phase11-s11-channel-first-party-promotion.md",
  "scripts/channel_promotion_gate.ts",
  "apps/gateway/src/plugin_review_gate.ts",
  "scripts/plugin_review_gate.ts",
  "docs/phase11-s12-plugin-review-gate-implementation.md",
  "scripts/ga_promotion_gate.ts",
  "docs/v1.0-ga-promotion-review.md",
  "docs/phase11-s13-v1-ga-promotion-execution.md",
  "docs/WINDOWS_INSTALLER_GUIDE.md",
  "docs/WINDOWS_FIRST_RUN.md",
  "docs/WINDOWS_PACKAGING_AUDIT.md",
  "docs/WINDOWS_UNINSTALL.md",
  "scripts/package_windows.ts",
  "scripts/verify_windows_package.ts",
  "scripts/smoke_windows_installed.ts",
  "scripts/package_unix.ts",
  "scripts/verify_unix_package.ts",
  "scripts/smoke_unix_installed.ts",
  "tooling/windows/assert_windows_oneclick_artifact.py",
] as const;

const INSTALLER_PATHS = [
  "INSTALL_WINDOWS.cmd",
  "INSTALL_WINDOWS.ps1",
  "INSTALL.sh",
  "INSTALL_LINUX.desktop",
  "INSTALL_LINUX.sh",
  "INSTALL_MACOS.command",
  "INSTALL_MACOS.sh",
  "install/linux/install.sh",
  "install/linux/uninstall.sh",
  "install/macos/install.sh",
  "install/macos/uninstall.sh",
  "install/resident/README.md",
  "install/resident/blue-tanuki-resident.ps1",
  "install/resident/blue-tanuki-resident.sh",
  "install/unix/product/BlueTanukiSetup.sh",
  "install/unix/product/BlueTanukiLauncher.sh",
  "install/unix/product/BlueTanukiUninstall.sh",
  "install/windows/product/BlueTanukiSetup.cmd",
  "install/windows/product/BlueTanukiSetup.ps1",
  "install/windows/product/BlueTanukiLauncher.ps1",
  "install/windows/product/BlueTanukiUninstall.ps1",
] as const;

const CORE_ROOT_TSCONFIG_REFERENCES = [
  "./packages/protocol",
  "./packages/channel-base",
  "./packages/hds-brain",
  "./packages/blue-tanuki",
  "./packages/channel-webchat",
  "./packages/channel-telegram",
  "./packages/operator-writing",
  "./packages/operator-daily",
  "./packages/operator-developer",
  "./apps/gateway",
] as const;

const CORE_GATEWAY_TSCONFIG_REFERENCES = [
  "../../packages/protocol",
  "../../packages/hds-brain",
  "../../packages/blue-tanuki",
  "../../packages/channel-base",
  "../../packages/channel-webchat",
  "../../packages/channel-telegram",
] as const;

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".codex-tmp",
  ".blue-tanuki",
  "release",
  ".git",
  ".DS_Store",
  "coverage",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "blue-tanuki.env",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
]);

interface ReleaseManifest {
  schema_version: 1;
  name: "blue-tanuki";
  version: string;
  created_at: string;
  archive: {
    file: string;
    size_bytes: number;
    sha256: string;
  };
  sha256_file: string;
  included_paths: readonly string[];
  core_release_paths: readonly string[];
  required_paths: readonly string[];
  installer_paths: readonly string[];
  windows_installer_artifacts: readonly string[];
  unix_installer_artifacts: readonly string[];
  boundaries: {
    unsigned_source_bundle: true;
    secrets_included: false;
    external_dynamic_imports_included: false;
  };
}

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

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

function assertInside(parent: string, child: string, label: string): void {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes ${parent}`);
  }
}

function checkRequired(): void {
  for (const rel of REQUIRED_PATHS) {
    if (!existsSync(path.join(root, rel))) {
      throw new Error(`release bundle missing required input: ${rel}`);
    }
  }
}

function windowsInstallerArtifactPaths(version: string): string[] {
  const base = `release/windows/blue-tanuki-${version}-windows-x64-installer.zip`;
  return [
    base,
    `${base}.sha256`,
    `${base}.manifest.json`,
    "release/windows/README_INSTALL_WINDOWS.txt",
  ];
}

function hasWindowsInstallerArtifacts(version: string): boolean {
  return windowsInstallerArtifactPaths(version).every((rel) => existsSync(path.join(root, rel)));
}

function unixInstallerArtifactPaths(version: string): string[] {
  const linux = `release/linux/blue-tanuki-${version}-linux-x64-installer.tar.gz`;
  const macosX64 = `release/macos/blue-tanuki-${version}-macos-x64-installer.tar.gz`;
  const macosArm64 = `release/macos/blue-tanuki-${version}-macos-arm64-installer.tar.gz`;
  return [
    linux,
    `${linux}.sha256`,
    `${linux}.manifest.json`,
    "release/linux/README_INSTALL_LINUX.txt",
    macosX64,
    `${macosX64}.sha256`,
    `${macosX64}.manifest.json`,
    macosArm64,
    `${macosArm64}.sha256`,
    `${macosArm64}.manifest.json`,
    "release/macos/README_INSTALL_MACOS.txt",
  ];
}

function hasUnixInstallerArtifacts(version: string): boolean {
  return unixInstallerArtifactPaths(version).every((rel) => existsSync(path.join(root, rel)));
}

function runWorkspaceCommand(args: readonly string[], label: string): void {
  const result = spawnSync("pnpm", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
}

function ensureWindowsInstallerArtifacts(version: string): void {
  if (hasWindowsInstallerArtifacts(version)) return;
  console.log("[release] Windows installer artifacts missing; generating first-class release artifacts");
  runWorkspaceCommand(["package:windows"], "pnpm package:windows");
  runWorkspaceCommand(["package:windows:verify"], "pnpm package:windows:verify");
  for (const rel of windowsInstallerArtifactPaths(version)) {
    if (!existsSync(path.join(root, rel))) {
      throw new Error(
        `release bundle missing Windows installer artifact after package generation: ${rel}`,
      );
    }
  }
}

function ensureUnixInstallerArtifacts(version: string): void {
  if (hasUnixInstallerArtifacts(version)) return;
  console.log("[release] Linux/macOS installer artifacts missing; generating first-class release artifacts");
  runWorkspaceCommand(["package:unix"], "pnpm package:unix");
  runWorkspaceCommand(["package:unix:verify"], "pnpm package:unix:verify");
  for (const rel of unixInstallerArtifactPaths(version)) {
    if (!existsSync(path.join(root, rel))) {
      throw new Error(
        `release bundle missing Linux/macOS installer artifact after package generation: ${rel}`,
      );
    }
  }
}

function isSecretLikeFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXCLUDED_FILE_NAMES.has(name) || EXCLUDED_FILE_NAMES.has(lower)) return true;
  if (lower.startsWith("blue-tanuki.env.") && lower.endsWith(".bak")) return true;
  if (lower.endsWith(".env.bak")) return true;
  if (lower.endsWith(".env.local.bak")) return true;
  if (lower.endsWith(".pem")) return true;
  if (lower.endsWith(".p12")) return true;
  if (lower.endsWith(".pfx")) return true;
  if (lower.endsWith(".key")) return true;
  return false;
}

function shouldIncludeSource(source: string): boolean {
  const base = path.basename(source);
  if (EXCLUDED_DIR_NAMES.has(base)) return false;
  if (isSecretLikeFileName(base)) return false;
  const rel = path.relative(root, source).replace(/\\/g, "/");
  return !rel
    .split("/")
    .filter(Boolean)
    .some((part) => EXCLUDED_DIR_NAMES.has(part) || isSecretLikeFileName(part));
}

async function copyIncluded(staging: string): Promise<void> {
  for (const rel of INCLUDED_PATHS) {
    const src = path.join(root, rel);
    if (!existsSync(src)) continue;
    await cp(src, path.join(staging, rel), {
      recursive: true,
      force: true,
      filter: shouldIncludeSource,
    });
  }
}

async function copyWindowsInstallerArtifacts(staging: string, version: string): Promise<void> {
  for (const rel of windowsInstallerArtifactPaths(version)) {
    const src = path.join(root, rel);
    const dest = path.join(staging, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { force: true });
  }
}

async function copyUnixInstallerArtifacts(staging: string, version: string): Promise<void> {
  for (const rel of unixInstallerArtifactPaths(version)) {
    const src = path.join(root, rel);
    const dest = path.join(staging, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { force: true });
  }
}

async function rewriteCoreTsconfigs(staging: string): Promise<void> {
  await writeFile(
    path.join(staging, "tsconfig.json"),
    `${JSON.stringify({
      extends: "./tsconfig.base.json",
      files: [],
      references: CORE_ROOT_TSCONFIG_REFERENCES.map((ref) => ({ path: ref })),
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(staging, "apps/gateway/tsconfig.json"),
    `${JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        outDir: "./dist",
        rootDir: "./src",
      },
      include: ["src/**/*"],
      exclude: ["dist", "node_modules"],
      references: CORE_GATEWAY_TSCONFIG_REFERENCES.map((ref) => ({ path: ref })),
    }, null, 2)}\n`,
    "utf8",
  );
}

function archive(stagingParent: string, outFile: string): void {
  if (process.platform === "win32") {
    const command =
      "$items=Get-ChildItem -Force -LiteralPath " +
      JSON.stringify(path.join(stagingParent, "blue-tanuki")) +
      "; Compress-Archive -LiteralPath $items.FullName -DestinationPath " +
      JSON.stringify(outFile) +
      " -Force";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Compress-Archive failed: ${result.stderr || result.stdout}`);
    }
    return;
  }

  const result = spawnSync(
    "tar",
    ["-czf", outFile, "-C", stagingParent, "blue-tanuki"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr || result.stdout}`);
  }
}

function artifactBase(outFile: string): string {
  if (outFile.endsWith(".tar.gz")) {
    return outFile.slice(0, -".tar.gz".length);
  }
  return outFile.slice(0, -path.extname(outFile).length);
}

function integrityPaths(outFile: string): { shaFile: string; manifestFile: string } {
  const base = artifactBase(outFile);
  return {
    shaFile: `${base}.sha256`,
    manifestFile: `${base}.manifest.json`,
  };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function writeIntegrityFiles(
  outFile: string,
  version: string,
): Promise<{ shaFile: string; manifestFile: string; sha256: string }> {
  const { shaFile, manifestFile } = integrityPaths(outFile);
  const sha256 = sha256File(outFile);
  const archiveStat = await stat(outFile);
  const archiveName = path.basename(outFile);
  const shaFileName = path.basename(shaFile);
  const manifest: ReleaseManifest = {
    schema_version: 1,
    name: "blue-tanuki",
    version,
    created_at: new Date().toISOString(),
    archive: {
      file: archiveName,
      size_bytes: archiveStat.size,
      sha256,
    },
    sha256_file: shaFileName,
    included_paths: INCLUDED_PATHS,
    core_release_paths: CORE_RELEASE_PATHS,
    required_paths: REQUIRED_PATHS,
    installer_paths: INSTALLER_PATHS,
    windows_installer_artifacts: windowsInstallerArtifactPaths(version),
    unix_installer_artifacts: unixInstallerArtifactPaths(version),
    boundaries: {
      unsigned_source_bundle: true,
      secrets_included: false,
      external_dynamic_imports_included: false,
    },
  };

  await writeFile(shaFile, `${sha256}  ${archiveName}\n`, "utf8");
  await writeFile(`${manifestFile}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(manifestFile, { force: true });
  await cp(`${manifestFile}.tmp`, manifestFile, { force: true });
  await rm(`${manifestFile}.tmp`, { force: true });

  return { shaFile, manifestFile, sha256 };
}

async function main(): Promise<void> {
  checkRequired();
  const pkg = readPackage();
  const dryRun = hasArg("--dry-run");
  const outDir = path.resolve(argValue("--out-dir") ?? "release");
  const stagingParent = path.join(root, ".codex-tmp", "release-stage");
  const staging = path.join(stagingParent, "blue-tanuki");
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  const outFile = path.join(outDir, `blue-tanuki-${pkg.version}-source-bundle.${ext}`);
  const { shaFile, manifestFile } = integrityPaths(outFile);

  assertInside(path.join(root, ".codex-tmp"), staging, "staging path");
  assertInside(root, outDir, "release output");

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: pkg.version,
          output: outFile,
          sha256: shaFile,
          manifest: manifestFile,
          includes: INCLUDED_PATHS,
          required: REQUIRED_PATHS,
          installers: INSTALLER_PATHS,
          windows_installer_artifacts: windowsInstallerArtifactPaths(pkg.version),
          unix_installer_artifacts: unixInstallerArtifactPaths(pkg.version),
        },
        null,
        2,
      ),
    );
    return;
  }

  ensureWindowsInstallerArtifacts(pkg.version);
  ensureUnixInstallerArtifacts(pkg.version);
  await rm(stagingParent, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await copyIncluded(staging);
  await copyWindowsInstallerArtifacts(staging, pkg.version);
  await copyUnixInstallerArtifacts(staging, pkg.version);
  await rewriteCoreTsconfigs(staging);
  archive(stagingParent, outFile);
  await rm(stagingParent, { recursive: true, force: true });
  const integrity = await writeIntegrityFiles(outFile, pkg.version);

  console.log(`[release] wrote ${outFile}`);
  console.log(`[release] wrote ${integrity.shaFile}`);
  console.log(`[release] wrote ${integrity.manifestFile}`);
}

main().catch((e) => {
  console.error(`[release] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
