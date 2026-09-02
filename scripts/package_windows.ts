import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  version: string;
}

interface WindowsInstallerManifest {
  schema_version: 1;
  name: "blue-tanuki";
  version: string;
  package_type: "windows-x64-zip-installer";
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
    creates_start_menu_shortcuts: true;
    optional_desktop_shortcut: true;
    autostart_enabled_by_default: false;
    uninstall_registered: true;
    gui_entry: "http://127.0.0.1:8787/app";
  };
  windows_locations: {
    install_root: "%LOCALAPPDATA%\\Programs\\BlueTanuki";
    data_root: "%APPDATA%\\BlueTanuki";
    logs: "%APPDATA%\\BlueTanuki\\logs";
    env_file: "%APPDATA%\\BlueTanuki\\blue-tanuki.env";
  };
  boundaries: {
    unsigned_installer: true;
    secrets_included: false;
    gui_shell_modified: false;
    hds_authority_modified: false;
    installer_autostart: false;
  };
}

export const root = process.cwd();
export const DEFAULT_NODE_VERSION = "22.14.0";

const RUNTIME_PACKAGES = [
  { rel: "packages/protocol", module: "@blue-tanuki/protocol" },
  { rel: "packages/hds-brain", module: "@blue-tanuki/hds-brain" },
  { rel: "packages/blue-tanuki", module: "@blue-tanuki/core" },
  { rel: "packages/channel-base", module: "@blue-tanuki/channel-base" },
  { rel: "packages/channel-webchat", module: "@blue-tanuki/channel-webchat" },
  { rel: "packages/channel-telegram", module: "@blue-tanuki/channel-telegram" },
  { rel: "packages/operator-writing", module: "@blue-tanuki/operator-writing" },
  { rel: "packages/operator-daily", module: "@blue-tanuki/operator-daily" },
  { rel: "packages/operator-developer", module: "@blue-tanuki/operator-developer" },
] as const;

const ROOT_TEXT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "LICENSE",
  "LICENSE-APACHE-2.0",
  "LICENSE-CC-BY-4.0",
  "NOTICE",
  "README.md",
  "QUICKSTART.md",
  "CLAIM.md",
  "SECURITY.md",
  "AUDIT.md",
  "CONFIG.md",
  "TROUBLESHOOTING.md",
  "CHANGELOG.md",
] as const;

const REQUIRED_BUILT_FILES = [
  "apps/gateway/dist/main.js",
  "apps/gateway/dist/plugin_review_gate.js",
  "packages/protocol/dist/index.js",
  "packages/hds-brain/dist/index.js",
  "packages/blue-tanuki/dist/index.js",
  "packages/channel-base/dist/index.js",
  "packages/channel-webchat/dist/index.js",
  "packages/channel-telegram/dist/index.js",
  "packages/operator-writing/dist/index.js",
  "packages/operator-daily/dist/index.js",
  "packages/operator-developer/dist/index.js",
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

export function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

function assertExists(rel: string): void {
  if (!existsSync(path.join(root, rel))) {
    throw new Error(`missing required input: ${rel}`);
  }
}

export function assertBuilt(): void {
  for (const rel of REQUIRED_BUILT_FILES) {
    assertExists(rel);
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    throw new Error(`missing directory: ${src}`);
  }
  await cp(src, dest, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (source) => {
      const base = path.basename(source);
      if (base === "node_modules" || base === ".git" || base === ".blue-tanuki") return false;
      if (base === ".codex-tmp" || base === "release" || base === "dist-windows") return false;
      return !isSecretLike(path.basename(source));
    },
  });
}

function isSecretLike(name: string): boolean {
  const lower = name.toLowerCase();
  if ([".env", ".env.local", ".npmrc", "blue-tanuki.env"].includes(lower)) return true;
  if (lower.startsWith("blue-tanuki.env.") && lower.endsWith(".bak")) return true;
  if (lower.endsWith(".env.bak") || lower.endsWith(".env.local.bak")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".p12") || lower.endsWith(".pfx") || lower.endsWith(".key")) return true;
  return false;
}

export async function copyFileIfExists(rel: string, destRoot: string): Promise<void> {
  const src = path.join(root, rel);
  if (!existsSync(src)) return;
  const dest = path.join(destRoot, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { force: true, dereference: true });
}

async function copyRuntimePackage(rel: string, destRoot: string): Promise<void> {
  const sourceDir = path.join(root, rel);
  const destDir = path.join(destRoot, rel);
  await mkdir(destDir, { recursive: true });
  for (const name of ["package.json", "blue-tanuki.plugin.json"]) {
    await copyFileIfExists(path.join(rel, name), destRoot);
  }
  await copyDir(path.join(sourceDir, "dist"), path.join(destDir, "dist"));
}

async function copyWorkspaceModuleFixed(rel: string, moduleName: string, appRoot: string): Promise<void> {
  const destDir = path.join(appRoot, "node_modules", ...moduleName.split("/"));
  await mkdir(destDir, { recursive: true });
  await cp(path.join(root, rel, "package.json"), path.join(destDir, "package.json"), {
    force: true,
    dereference: true,
  });
  await copyDir(path.join(root, rel, "dist"), path.join(destDir, "dist"));
}

async function copyExternalModule(name: string, candidates: readonly string[], appRoot: string): Promise<void> {
  let source: string | null = null;
  for (const rel of candidates) {
    const candidate = path.join(root, rel);
    if (existsSync(candidate)) {
      source = candidate;
      break;
    }
  }
  if (!source) {
    throw new Error(`missing runtime dependency: ${name}`);
  }
  const real = await import("node:fs/promises").then((fs) => fs.realpath(source!));
  const dest = path.join(appRoot, "node_modules", name);
  await copyDir(real, dest);
}

async function copyGateway(appRoot: string): Promise<void> {
  await mkdir(path.join(appRoot, "apps/gateway"), { recursive: true });
  await cp(path.join(root, "apps/gateway/package.json"), path.join(appRoot, "apps/gateway/package.json"), {
    force: true,
    dereference: true,
  });
  await copyDir(path.join(root, "apps/gateway/dist"), path.join(appRoot, "apps/gateway/dist"));
  await mkdir(path.join(appRoot, "apps/gateway/src"), { recursive: true });
  await cp(
    path.join(root, "apps/gateway/src/plugin_review_gate.ts"),
    path.join(appRoot, "apps/gateway/src/plugin_review_gate.ts"),
    { force: true },
  );
}

export async function copyAppLayout(appRoot: string): Promise<void> {
  await mkdir(appRoot, { recursive: true });
  for (const rel of ROOT_TEXT_FILES) {
    await copyFileIfExists(rel, appRoot);
  }
  await copyDir(path.join(root, "assets"), path.join(appRoot, "assets"));
  await copyDir(path.join(root, "docs"), path.join(appRoot, "docs"));
  await copyDir(path.join(root, "scripts"), path.join(appRoot, "scripts"));
  await copyDir(path.join(root, "install/linux"), path.join(appRoot, "install/linux"));
  await copyDir(path.join(root, "install/macos"), path.join(appRoot, "install/macos"));
  await copyDir(path.join(root, "install/resident"), path.join(appRoot, "install/resident"));
  await copyDir(path.join(root, "install/windows"), path.join(appRoot, "install/windows"));
  await copyFileIfExists("install/README.md", appRoot);
  await copyGateway(appRoot);
  for (const item of RUNTIME_PACKAGES) {
    await copyRuntimePackage(item.rel, appRoot);
    await copyWorkspaceModuleFixed(item.rel, item.module, appRoot);
  }
  await copyExternalModule("ws", [
    "node_modules/ws",
    "packages/channel-webchat/node_modules/ws",
  ], appRoot);
  await copyExternalModule("zod", [
    "node_modules/zod",
    "packages/protocol/node_modules/zod",
    "node_modules/.pnpm/node_modules/zod",
  ], appRoot);
}

async function copyProductLaunchers(packageRoot: string): Promise<void> {
  const sourceRoot = path.join(root, "install/windows/product");
  const entries = await readdir(sourceRoot);
  await mkdir(path.join(packageRoot, "launcher"), { recursive: true });
  for (const entry of entries) {
    const src = path.join(sourceRoot, entry);
    if (entry.startsWith("BlueTanukiSetup.")) {
      await cp(src, path.join(packageRoot, entry), { force: true });
    } else {
      await cp(src, path.join(packageRoot, "launcher", entry), { force: true });
    }
  }
}

export async function downloadBuffer(url: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const output: Buffer[] = [];
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        response.resume();
        return;
      }
      response.on("data", (chunk: Buffer) => output.push(chunk));
      response.on("end", () => resolve(Buffer.concat(output)));
    }).on("error", reject);
  });
}

async function downloadNodeRuntime(
  nodeVersion: string,
  cacheDir: string,
): Promise<{ zipPath: string; url: string; file: string; sha256: string; shasumsUrl: string }> {
  const file = `node-v${nodeVersion}-win-x64.zip`;
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const url = `${baseUrl}/${file}`;
  const shasumsUrl = `${baseUrl}/SHASUMS256.txt`;
  const zipPath = path.join(cacheDir, file);
  await mkdir(cacheDir, { recursive: true });
  const shasums = (await downloadBuffer(shasumsUrl)).toString("utf8");
  const expectedSha = shasums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === file)?.[0]?.toLowerCase();
  if (!expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error(`Node runtime SHA-256 not found in ${shasumsUrl} for ${file}`);
  }
  if (existsSync(zipPath) && (await stat(zipPath)).size > 0) {
    const cachedSha = sha256File(zipPath);
    if (cachedSha === expectedSha) {
      return { zipPath, url, file, sha256: expectedSha, shasumsUrl };
    }
    await rm(zipPath, { force: true });
  }
  await writeFile(zipPath, await downloadBuffer(url));
  const actualSha = sha256File(zipPath);
  if (actualSha !== expectedSha) {
    await rm(zipPath, { force: true });
    throw new Error(`Node runtime SHA-256 mismatch for ${file}`);
  }
  return { zipPath, url, file, sha256: expectedSha, shasumsUrl };
}

export function commandExists(command: string): boolean {
  const result = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf8" })
    : spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function zipDirectory(sourceDir: string, outFile: string): void {
  const py = commandExists("python3") ? "python3" : commandExists("python") ? "python" : null;
  if (py) {
    const script =
      "import os,sys,zipfile\n" +
      "src,out=sys.argv[1],sys.argv[2]\n" +
      "with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n" +
      "  for root,dirs,files in os.walk(src):\n" +
      "    dirs[:] = [d for d in dirs if d not in {'.git','.blue-tanuki','.codex-tmp','release'}]\n" +
      "    for f in files:\n" +
      "      p=os.path.join(root,f)\n" +
      "      rel=os.path.relpath(p,src).replace(os.sep,'/')\n" +
      "      z.write(p,rel)\n";
    const result = spawnSync(py, ["-c", script, sourceDir, outFile], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`python zip failed: ${result.stderr || result.stdout}`);
    }
    return;
  }
  if (process.platform === "win32") {
    const command =
      "$items=Get-ChildItem -Force -LiteralPath " +
      JSON.stringify(sourceDir) +
      "; Compress-Archive -LiteralPath $items.FullName -DestinationPath " +
      JSON.stringify(outFile) +
      " -Force";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`Compress-Archive failed: ${result.stderr || result.stdout}`);
    }
    return;
  }
  throw new Error("python3/python is required to create Windows installer zip on this platform");
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function windowsReadmeInstallText(version: string): string {
  const archive = `blue-tanuki-${version}-windows-x64-installer.zip`;
  return [
    "BLUE-TANUKI Windows install",
    "",
    "Normal Windows users should not run source builds. Download this installer zip, extract it, and run BlueTanukiSetup.cmd.",
    "",
    "1. Extract the installer zip.",
    "2. Run BlueTanukiSetup.cmd from the extracted installer folder.",
    "3. Do not run install/windows/product/BlueTanukiSetup.cmd from the source tree.",
    "4. If Microsoft Defender SmartScreen appears, verify the SHA-256 sidecar first, then choose More info > Run anyway only when the hash matches.",
    "",
    `Installer zip: ${archive}`,
    `SHA-256 sidecar: ${archive}.sha256`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const pkg = readPackage();
  const nodeVersion = argValue("--node-version") ?? DEFAULT_NODE_VERSION;
  const defaultOut = path.join(root, "release/windows", `blue-tanuki-${pkg.version}-windows-x64-installer.zip`);
  const outFile = path.resolve(argValue("--out") ?? defaultOut);
  const workRoot = path.join(root, ".codex-tmp/windows-package");
  const packageRoot = path.join(workRoot, "package");
  const appRoot = path.join(packageRoot, "app");
  const cacheDir = path.join(root, ".codex-tmp/windows-runtime-cache");

  assertBuilt();
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.dirname(outFile), { recursive: true });
  await copyProductLaunchers(packageRoot);
  await copyAppLayout(appRoot);

  const runtime = await downloadNodeRuntime(nodeVersion, cacheDir);
  await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
  await cp(runtime.zipPath, path.join(packageRoot, "runtime", runtime.file), { force: true });

  const manifest: WindowsInstallerManifest = {
    schema_version: 1,
    name: "blue-tanuki",
    version: pkg.version,
    package_type: "windows-x64-zip-installer",
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
      creates_start_menu_shortcuts: true,
      optional_desktop_shortcut: true,
      autostart_enabled_by_default: false,
      uninstall_registered: true,
      gui_entry: "http://127.0.0.1:8787/app",
    },
    windows_locations: {
      install_root: "%LOCALAPPDATA%\\Programs\\BlueTanuki",
      data_root: "%APPDATA%\\BlueTanuki",
      logs: "%APPDATA%\\BlueTanuki\\logs",
      env_file: "%APPDATA%\\BlueTanuki\\blue-tanuki.env",
    },
    boundaries: {
      unsigned_installer: true,
      secrets_included: false,
      gui_shell_modified: false,
      hds_authority_modified: false,
      installer_autostart: false,
    },
  };
  await writeFile(path.join(packageRoot, "windows-installer-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await rm(outFile, { force: true });
  zipDirectory(packageRoot, outFile);
  const sha256 = sha256File(outFile);
  const archiveStat = await stat(outFile);
  const legacyBase = outFile.slice(0, -".zip".length);
  const shaFile = `${outFile}.sha256`;
  const manifestFile = `${outFile}.manifest.json`;
  await rm(`${legacyBase}.sha256`, { force: true });
  await rm(`${legacyBase}.manifest.json`, { force: true });
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
  const readmeInstall = path.join(path.dirname(outFile), "README_INSTALL_WINDOWS.txt");
  await writeFile(readmeInstall, windowsReadmeInstallText(pkg.version), "utf8");
  console.log(`windows_installer=${outFile}`);
  console.log(`sha256=${sha256}`);
  console.log(`sha256_file=${shaFile}`);
  console.log(`manifest_file=${manifestFile}`);
  console.log(`windows_install_readme=${readmeInstall}`);
  console.log("unsigned_installer=true");
  console.log("bundled_node_runtime=true");
  console.log("runtime_sha256_verified=true");
  console.log("user_requires_node_pnpm_git=false");
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
