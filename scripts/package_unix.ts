import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  DEFAULT_NODE_VERSION,
  assertBuilt,
  commandExists,
  copyAppLayout,
  downloadBuffer,
  readPackage,
  root,
  sha256File,
} from "./package_windows.ts";

type UnixPlatform = "linux" | "macos";
type UnixArch = "x64" | "arm64";

const SUPPORTED_PACKAGE_TYPES = [
  "linux-x64-tar-installer",
  "macos-x64-tar-installer",
  "macos-arm64-tar-installer",
] as const;

interface UnixTarget {
  platform: UnixPlatform;
  arch: UnixArch;
}

interface UnixInstallerManifest {
  schema_version: 1;
  name: "blue-tanuki";
  version: string;
  package_type: `${UnixPlatform}-${UnixArch}-tar-installer`;
  created_at: string;
  node_runtime: {
    bundled: true;
    version: string;
    archive: string;
    source: string;
    sha256: string;
    shasums_source: string;
  };
  user_experience: {
    requires_node_pnpm_git_from_user: false;
    creates_user_launcher: true;
    creates_desktop_or_app_shortcut: true;
    autostart_enabled_by_default: false;
    gui_entry: "http://127.0.0.1:8787/app";
  };
  unix_locations: {
    install_root: string;
    data_root: string;
    config_root: string;
    bin_launcher: string;
  };
  boundaries: {
    unsigned_installer: true;
    secrets_included: false;
    gui_shell_modified: false;
    hds_authority_modified: false;
    installer_autostart: false;
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

function normalizePlatform(value: string | undefined): UnixPlatform {
  if (!value) {
    return process.platform === "darwin" ? "macos" : "linux";
  }
  if (value === "linux" || value === "macos") return value;
  if (value === "darwin") return "macos";
  throw new Error(`unsupported Unix package platform: ${value}`);
}

function normalizeArch(value: string | undefined): UnixArch {
  const raw = value ?? (process.arch === "arm64" ? "arm64" : "x64");
  if (raw === "x64" || raw === "arm64") return raw;
  if (raw === "x86_64" || raw === "amd64") return "x64";
  throw new Error(`unsupported Unix package arch: ${raw}`);
}

function targetsFromArgs(): UnixTarget[] {
  if (hasArg("--all")) {
    return [
      { platform: "linux", arch: "x64" },
      { platform: "macos", arch: "x64" },
      { platform: "macos", arch: "arm64" },
    ];
  }
  const platform = normalizePlatform(argValue("--platform"));
  if (platform === "linux") {
    return [{ platform, arch: "x64" }];
  }
  return [{ platform, arch: normalizeArch(argValue("--arch")) }];
}

function nodeRuntimeFile(nodeVersion: string, target: UnixTarget): string {
  if (target.platform === "linux") {
    if (target.arch !== "x64") throw new Error("Linux installer currently supports x64 only");
    return `node-v${nodeVersion}-linux-x64.tar.xz`;
  }
  const nodeArch = target.arch === "arm64" ? "arm64" : "x64";
  return `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
}

async function downloadNodeRuntime(
  nodeVersion: string,
  target: UnixTarget,
  cacheDir: string,
): Promise<{ archivePath: string; url: string; file: string; sha256: string; shasumsUrl: string }> {
  const file = nodeRuntimeFile(nodeVersion, target);
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const url = `${baseUrl}/${file}`;
  const shasumsUrl = `${baseUrl}/SHASUMS256.txt`;
  const archivePath = path.join(cacheDir, file);
  await mkdir(cacheDir, { recursive: true });
  const shasums = (await downloadBuffer(shasumsUrl)).toString("utf8");
  const expectedSha = shasums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === file)?.[0]?.toLowerCase();
  if (!expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error(`Node runtime SHA-256 not found in ${shasumsUrl} for ${file}`);
  }
  if (existsSync(archivePath) && (await stat(archivePath)).size > 0) {
    const cachedSha = sha256File(archivePath);
    if (cachedSha === expectedSha) {
      return { archivePath, url, file, sha256: expectedSha, shasumsUrl };
    }
    await rm(archivePath, { force: true });
  }
  await writeFile(archivePath, await downloadBuffer(url));
  const actualSha = sha256File(archivePath);
  if (actualSha !== expectedSha) {
    await rm(archivePath, { force: true });
    throw new Error(`Node runtime SHA-256 mismatch for ${file}`);
  }
  return { archivePath, url, file, sha256: expectedSha, shasumsUrl };
}

async function copyUnixLaunchers(packageRoot: string, target: UnixTarget): Promise<void> {
  const sourceRoot = path.join(root, "install/unix/product");
  await cp(path.join(sourceRoot, "BlueTanukiSetup.sh"), path.join(packageRoot, "BlueTanukiSetup.sh"), { force: true });
  await chmod(path.join(packageRoot, "BlueTanukiSetup.sh"), 0o755);
  if (target.platform === "macos") {
    await writeFile(
      path.join(packageRoot, "BlueTanukiSetup.command"),
      "#!/usr/bin/env sh\nset -eu\ncd \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\nexec sh ./BlueTanukiSetup.sh \"$@\"\n",
      "utf8",
    );
    await chmod(path.join(packageRoot, "BlueTanukiSetup.command"), 0o755);
  }
  await mkdir(path.join(packageRoot, "launcher"), { recursive: true });
  for (const name of ["BlueTanukiLauncher.sh", "BlueTanukiUninstall.sh"]) {
    const dest = path.join(packageRoot, "launcher", name);
    await cp(path.join(sourceRoot, name), dest, { force: true });
    await chmod(dest, 0o755);
  }
}

function tarDirectory(sourceDir: string, outFile: string): void {
  const result = spawnSync("tar", ["-czf", outFile, "-C", sourceDir, "."], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr || result.stdout}`);
  }
}

function defaultLocations(target: UnixTarget): UnixInstallerManifest["unix_locations"] {
  if (target.platform === "macos") {
    return {
      install_root: "$HOME/Library/Application Support/BlueTanuki/app",
      data_root: "$HOME/Library/Application Support/BlueTanuki",
      config_root: "$HOME/Library/Application Support/BlueTanuki",
      bin_launcher: "$HOME/.local/bin/blue-tanuki",
    };
  }
  return {
    install_root: "$HOME/.local/share/blue-tanuki/app",
    data_root: "$HOME/.local/share/blue-tanuki",
    config_root: "$HOME/.config/blue-tanuki",
    bin_launcher: "$HOME/.local/bin/blue-tanuki",
  };
}

function packageReadmeText(version: string, target: UnixTarget): string {
  const platformLabel = target.platform === "macos" ? "macOS" : "Linux";
  const setup = target.platform === "macos" ? "BlueTanukiSetup.command" : "BlueTanukiSetup.sh";
  const archive = `blue-tanuki-${version}-${target.platform}-${target.arch}-installer.tar.gz`;
  return [
    `BLUE-TANUKI ${platformLabel} install`,
    "",
    `Normal ${platformLabel} users should not run source builds. Download this installer archive, extract it, and run ${setup}.`,
    "",
    "1. Extract the installer archive.",
    `2. Run ${setup} from the extracted installer folder.`,
    "3. The installed launcher opens http://127.0.0.1:8787/app.",
    "",
    `Installer archive: ${archive}`,
    `SHA-256 sidecar: ${archive}.sha256`,
    "user_requires_node_pnpm_git=false",
    "",
  ].join("\n");
}

async function packageTarget(target: UnixTarget): Promise<void> {
  const pkg = readPackage();
  const nodeVersion = argValue("--node-version") ?? DEFAULT_NODE_VERSION;
  const defaultOut = path.join(
    root,
    "release",
    target.platform,
    `blue-tanuki-${pkg.version}-${target.platform}-${target.arch}-installer.tar.gz`,
  );
  const outFile = path.resolve(argValue("--out") ?? defaultOut);
  const workRoot = path.join(root, ".codex-tmp", `${target.platform}-${target.arch}-package`);
  const packageRoot = path.join(workRoot, "package");
  const appRoot = path.join(packageRoot, "app");
  const cacheDir = path.join(root, ".codex-tmp", "unix-runtime-cache");

  assertBuilt();
  if (!commandExists("tar")) {
    throw new Error("tar is required to create Unix installer archives");
  }
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.dirname(outFile), { recursive: true });
  await copyUnixLaunchers(packageRoot, target);
  await copyAppLayout(appRoot);

  const runtime = await downloadNodeRuntime(nodeVersion, target, cacheDir);
  await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
  await cp(runtime.archivePath, path.join(packageRoot, "runtime", runtime.file), { force: true });
  const packageType = `${target.platform}-${target.arch}-tar-installer` as UnixInstallerManifest["package_type"];
  if (!(SUPPORTED_PACKAGE_TYPES as readonly string[]).includes(packageType)) {
    throw new Error(`unsupported Unix package type: ${packageType}`);
  }

  const manifest: UnixInstallerManifest = {
    schema_version: 1,
    name: "blue-tanuki",
    version: pkg.version,
    package_type: packageType,
    created_at: new Date().toISOString(),
    node_runtime: {
      bundled: true,
      version: nodeVersion,
      archive: runtime.file,
      source: runtime.url,
      sha256: runtime.sha256,
      shasums_source: runtime.shasumsUrl,
    },
    user_experience: {
      requires_node_pnpm_git_from_user: false,
      creates_user_launcher: true,
      creates_desktop_or_app_shortcut: true,
      autostart_enabled_by_default: false,
      gui_entry: "http://127.0.0.1:8787/app",
    },
    unix_locations: defaultLocations(target),
    boundaries: {
      unsigned_installer: true,
      secrets_included: false,
      gui_shell_modified: false,
      hds_authority_modified: false,
      installer_autostart: false,
    },
  };
  await writeFile(path.join(packageRoot, "unix-installer-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await rm(outFile, { force: true });
  tarDirectory(packageRoot, outFile);
  const sha256 = sha256File(outFile);
  const archiveStat = await stat(outFile);
  const shaFile = `${outFile}.sha256`;
  const manifestFile = `${outFile}.manifest.json`;
  await writeFile(shaFile, `${sha256}  ${path.basename(outFile)}\n`, "utf8");
  await writeFile(
    manifestFile,
    `${JSON.stringify({
      ...manifest,
      archive: {
        file: path.basename(outFile),
        size_bytes: archiveStat.size,
        sha256,
      },
      sha256_file: `${path.basename(outFile)}.sha256`,
    }, null, 2)}\n`,
    "utf8",
  );
  const readmeName = target.platform === "macos" ? "README_INSTALL_MACOS.txt" : "README_INSTALL_LINUX.txt";
  const readmeFile = path.join(path.dirname(outFile), readmeName);
  await writeFile(readmeFile, packageReadmeText(pkg.version, target), "utf8");

  console.log(`${target.platform}_installer=${outFile}`);
  console.log(`platform=${target.platform}`);
  console.log(`arch=${target.arch}`);
  console.log(`sha256=${sha256}`);
  console.log(`sha256_file=${shaFile}`);
  console.log(`manifest_file=${manifestFile}`);
  console.log(`install_readme=${readmeFile}`);
  console.log("unsigned_installer=true");
  console.log("bundled_node_runtime=true");
  console.log("runtime_sha256_verified=true");
  console.log("user_requires_node_pnpm_git=false");
}

async function main(): Promise<void> {
  for (const target of targetsFromArgs()) {
    await packageTarget(target);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
