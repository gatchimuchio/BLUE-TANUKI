import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRODUCT_SCOPE_CORE_RELEASE_PATHS,
} from "../packages/protocol/src/product_scope_contract.js";

interface PackageJson {
  version: string;
}

interface ReleaseManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  archive?: {
    file?: string;
    size_bytes?: number;
    sha256?: string;
  };
  sha256_file?: string;
  core_release_paths?: string[];
  required_paths?: string[];
  installer_paths?: string[];
  windows_installer_artifacts?: string[];
  unix_installer_artifacts?: string[];
  product_installer_artifacts?: string[];
  boundaries?: {
    unsigned_source_bundle?: boolean;
    secrets_included?: boolean;
    external_dynamic_imports_included?: boolean;
  };
}

const root = process.cwd();
const VERIFY_WORK_DIR = path.join(root, ".codex-tmp", "release-verify");

export interface ExtractedReleaseCommand {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
}

export const EXTRACTED_RELEASE_COMMANDS: readonly ExtractedReleaseCommand[] = [
  { command: "corepack", args: ["pnpm", "install", "--frozen-lockfile"] },
  { command: "corepack", args: ["pnpm", "build"] },
  {
    command: "corepack",
    args: ["pnpm", "run", "doctor"],
    env: {
      WEBCHAT_TOKEN: "release-verify-webchat-token-123456",
      WEBCHAT_RESUME_TOKEN: "release-verify-resume-token-123456",
      BLUE_TANUKI_MAINTENANCE_TOKEN: "release-verify-maintenance-token-123456",
      BLUE_TANUKI_SETTINGS_TOKEN: "release-verify-settings-token-123456",
      LLM_BACKEND: "stub",
    },
  },
  { command: "corepack", args: ["pnpm", "validate:repo-health"] },
  { command: "corepack", args: ["pnpm", "validate:release-hardening"] },
] as const;

const REQUIRED_ARCHIVE_PATHS = [
  "INSTALL.sh",
  "INSTALL_LINUX.desktop",
  "INSTALL_LINUX.sh",
  "INSTALL_MACOS.command",
  "INSTALL_MACOS.sh",
  "INSTALL_WINDOWS.cmd",
  "INSTALL_WINDOWS.ps1",
  "install/README.md",
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
  "assets/aotanu/spritesheets/aotanu_idle_2x2.png",
  "assets/aotanu/spritesheets/aotanu_walk_2x2.png",
  "assets/aotanu/spritesheets/aotanu_working_2x2.png",
  "assets/aotanu/spritesheets/aotanu_happy_2x2.png",
  "assets/aotanu/spritesheets/aotanu_error_2x2.png",
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
  "docs/RELEASE_HARDENING.md",
  "scripts/package_windows.ts",
  "scripts/verify_windows_package.ts",
  "scripts/smoke_windows_installed.ts",
  "scripts/package_unix.ts",
  "scripts/verify_unix_package.ts",
  "scripts/smoke_unix_installed.ts",
  "scripts/package_product_installers.ts",
  "scripts/verify_product_installers.ts",
  "scripts/release_hardening_gate.ts",
  "tooling/windows/assert_windows_oneclick_artifact.py",
] as const;

const FORBIDDEN_SEGMENTS = new Set([
  "node_modules",
  ".codex-tmp",
  ".blue-tanuki",
  ".git",
]);

const FORBIDDEN_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "blue-tanuki.env",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
]);

function isForbiddenFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_BASENAMES.has(name) || FORBIDDEN_BASENAMES.has(lower)) return true;
  if (lower.startsWith("blue-tanuki.env.") && lower.endsWith(".bak")) return true;
  if (lower.endsWith(".env.bak")) return true;
  if (lower.endsWith(".env.local.bak")) return true;
  if (lower.endsWith(".pem")) return true;
  if (lower.endsWith(".p12")) return true;
  if (lower.endsWith(".pfx")) return true;
  if (lower.endsWith(".key")) return true;
  return false;
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

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

function defaultArchivePath(): string {
  const pkg = readPackage();
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return path.join(root, "release", `blue-tanuki-${pkg.version}-source-bundle.${ext}`);
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

function readSha256File(file: string): string {
  const firstToken = readFileSync(file, "utf8").trim().split(/\s+/)[0];
  if (!firstToken || !/^[a-f0-9]{64}$/i.test(firstToken)) {
    throw new Error(`${file}: invalid sha256 file`);
  }
  return firstToken.toLowerCase();
}

function readManifest(file: string): ReleaseManifest {
  return JSON.parse(readFileSync(file, "utf8")) as ReleaseManifest;
}

function assertExists(file: string): void {
  if (!existsSync(file)) {
    throw new Error(`missing release file: ${file}`);
  }
}

function assertManifest(
  manifest: ReleaseManifest,
  archiveFile: string,
  shaFile: string,
  actualSha: string,
): void {
  const archiveName = path.basename(archiveFile);
  const shaName = path.basename(shaFile);
  const sizeBytes = statSync(archiveFile).size;

  if (manifest.schema_version !== 1) {
    throw new Error("manifest schema_version must be 1");
  }
  if (manifest.name !== "blue-tanuki") {
    throw new Error("manifest name must be blue-tanuki");
  }
  if (manifest.archive?.file !== archiveName) {
    throw new Error("manifest archive file does not match release file");
  }
  if (manifest.archive?.size_bytes !== sizeBytes) {
    throw new Error("manifest archive size does not match release file");
  }
  if (manifest.archive?.sha256?.toLowerCase() !== actualSha) {
    throw new Error("manifest archive sha256 does not match release file");
  }
  if (manifest.sha256_file !== shaName) {
    throw new Error("manifest sha256_file does not match checksum file");
  }
  if (manifest.boundaries?.unsigned_source_bundle !== true) {
    throw new Error("manifest must declare unsigned_source_bundle=true");
  }
  if (manifest.boundaries?.secrets_included !== false) {
    throw new Error("manifest must declare secrets_included=false");
  }
  if (manifest.boundaries?.external_dynamic_imports_included !== false) {
    throw new Error("manifest must declare external_dynamic_imports_included=false");
  }
  for (const required of PRODUCT_SCOPE_CORE_RELEASE_PATHS) {
    if (!manifest.core_release_paths?.includes(required)) {
      throw new Error(`manifest core_release_paths missing ${required}`);
    }
  }
  for (const artifact of windowsInstallerArtifactPaths(manifest.version ?? readPackage().version)) {
    if (!manifest.windows_installer_artifacts?.includes(artifact)) {
      throw new Error(`manifest windows_installer_artifacts missing ${artifact}`);
    }
  }
  for (const artifact of unixInstallerArtifactPaths(manifest.version ?? readPackage().version)) {
    if (!manifest.unix_installer_artifacts?.includes(artifact)) {
      throw new Error(`manifest unix_installer_artifacts missing ${artifact}`);
    }
  }
  for (const artifact of productInstallerArtifactPaths(manifest.version ?? readPackage().version)) {
    if (!manifest.product_installer_artifacts?.includes(artifact)) {
      throw new Error(`manifest product_installer_artifacts missing ${artifact}`);
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

function productInstallerArtifactPaths(version: string): string[] {
  const windows = `release/windows/BlueTanukiSetup-${version}-windows-x64.cmd`;
  const linux = `release/linux/BlueTanukiSetup-${version}-linux-x64.run`;
  const macosX64 = `release/macos/BlueTanukiSetup-${version}-macos-x64.command`;
  const macosArm64 = `release/macos/BlueTanukiSetup-${version}-macos-arm64.command`;
  return [
    windows,
    `${windows}.sha256`,
    `${windows}.manifest.json`,
    linux,
    `${linux}.sha256`,
    `${linux}.manifest.json`,
    macosX64,
    `${macosX64}.sha256`,
    `${macosX64}.manifest.json`,
    macosArm64,
    `${macosArm64}.sha256`,
    `${macosArm64}.manifest.json`,
  ];
}

function parseArchiveList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function listTarEntries(archiveFile: string): string[] {
  const result = spawnSync("tar", ["-tf", archiveFile], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar list failed: ${result.stderr || result.stdout}`);
  }
  return parseArchiveList(result.stdout);
}

function listZipEntries(archiveFile: string): string[] {
  const unzip = spawnSync("unzip", ["-Z1", archiveFile], { encoding: "utf8" });
  if (unzip.status === 0) {
    return parseArchiveList(unzip.stdout);
  }

  const pyScript =
    "import sys,zipfile\n" +
    "with zipfile.ZipFile(sys.argv[1]) as z:\n" +
    "    sys.stdout.write('\\n'.join(z.namelist()))\n";
  for (const py of ["python3", "python"]) {
    const result = spawnSync(py, ["-c", pyScript, archiveFile], { encoding: "utf8" });
    if (result.status === 0) {
      return parseArchiveList(result.stdout);
    }
  }

  // On Windows, bsdtar commonly supports zip listing even though GNU tar on
  // Linux does not. Keep it as a final cross-platform fallback.
  const tar = spawnSync("tar", ["-tf", archiveFile], { encoding: "utf8" });
  if (tar.status === 0) {
    return parseArchiveList(tar.stdout);
  }

  throw new Error(
    `zip list failed: ${unzip.stderr || unzip.stdout || tar.stderr || tar.stdout}`,
  );
}

function listArchiveEntries(archiveFile: string): string[] {
  if (archiveFile.endsWith(".tar.gz") || archiveFile.endsWith(".tgz")) {
    return listTarEntries(archiveFile);
  }
  if (archiveFile.endsWith(".zip")) {
    return listZipEntries(archiveFile);
  }
  throw new Error(`unsupported archive extension: ${archiveFile}`);
}

function entryMatches(entries: string[], required: string): boolean {
  return entries.some((entry) => entry === required || entry === `blue-tanuki/${required}`);
}

function assertRequiredEntries(entries: string[]): void {
  for (const required of REQUIRED_ARCHIVE_PATHS) {
    if (!entryMatches(entries, required)) {
      throw new Error(`archive missing required entry: ${required}`);
    }
  }
  for (const required of windowsInstallerArtifactPaths(readPackage().version)) {
    if (!entryMatches(entries, required)) {
      throw new Error(`archive missing Windows installer artifact: ${required}`);
    }
  }
  for (const required of unixInstallerArtifactPaths(readPackage().version)) {
    if (!entryMatches(entries, required)) {
      throw new Error(`archive missing Linux/macOS installer artifact: ${required}`);
    }
  }
  for (const required of productInstallerArtifactPaths(readPackage().version)) {
    if (!entryMatches(entries, required)) {
      throw new Error(`archive missing product installer artifact: ${required}`);
    }
  }
}

function assertSafeEntries(entries: string[]): void {
  for (const entry of entries) {
    if (entry.startsWith("/") || /^[A-Za-z]:\//.test(entry)) {
      throw new Error(`archive contains absolute entry: ${entry}`);
    }
    const parts = entry.split("/").filter(Boolean);
    if (parts.includes("..")) {
      throw new Error(`archive contains traversal entry: ${entry}`);
    }
    for (const part of parts) {
      if (FORBIDDEN_SEGMENTS.has(part)) {
        throw new Error(`archive contains forbidden directory: ${entry}`);
      }
    }
    const base = parts.at(-1);
    if (base && isForbiddenFileName(base)) {
      throw new Error(`archive contains forbidden secret-like file: ${entry}`);
    }
  }
}

function extractArchive(archiveFile: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  if (archiveFile.endsWith(".tar.gz") || archiveFile.endsWith(".tgz")) {
    const result = spawnSync("tar", ["-xzf", archiveFile, "-C", destination], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`tar extract failed: ${result.stderr || result.stdout}`);
    }
    return;
  }
  if (archiveFile.endsWith(".zip")) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(archiveFile)} -DestinationPath ${JSON.stringify(destination)} -Force`,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`zip extract failed: ${result.stderr || result.stdout}`);
    }
    return;
  }
  throw new Error(`unsupported archive extension: ${archiveFile}`);
}

export function resolveExtractedRoot(destination: string): string {
  if (existsSync(path.join(destination, "package.json"))) {
    return destination;
  }
  const nested = path.join(destination, "blue-tanuki");
  if (existsSync(path.join(nested, "package.json"))) {
    return nested;
  }
  throw new Error("extracted release bundle missing package.json");
}

function runInExtractedBundle(step: ExtractedReleaseCommand, cwd: string): void {
  const command =
    process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : step.command;
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", step.command, ...step.args]
      : [...step.args];
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
      ...step.env,
    },
  });
  if (result.status !== 0) {
    const diagnostic = result.error?.message ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `extracted release command failed: ${step.command} ${step.args.join(" ")}\n` +
        diagnostic,
    );
  }
  console.log(`[release:verify] extracted PASS ${step.command} ${step.args.join(" ")}`);
}

function assertExtractedInstallability(archiveFile: string): void {
  extractArchive(archiveFile, VERIFY_WORK_DIR);
  const extractedRoot = resolveExtractedRoot(VERIFY_WORK_DIR);
  for (const step of EXTRACTED_RELEASE_COMMANDS) {
    runInExtractedBundle(step, extractedRoot);
  }
  rmSync(VERIFY_WORK_DIR, { recursive: true, force: true });
}

function main(): void {
  const archiveFile = path.resolve(argValue("--file") ?? defaultArchivePath());
  const { shaFile, manifestFile } = integrityPaths(archiveFile);

  assertExists(archiveFile);
  assertExists(shaFile);
  assertExists(manifestFile);

  const actualSha = sha256File(archiveFile);
  const expectedSha = readSha256File(shaFile);
  if (actualSha !== expectedSha) {
    throw new Error("release archive sha256 does not match checksum file");
  }

  const manifest = readManifest(manifestFile);
  assertManifest(manifest, archiveFile, shaFile, actualSha);

  const entries = listArchiveEntries(archiveFile);
  assertRequiredEntries(entries);
  assertSafeEntries(entries);
  assertExtractedInstallability(archiveFile);

  console.log(`[release:verify] PASS ${archiveFile}`);
  console.log(`[release:verify] sha256 ${actualSha}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
