import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackage, root, sha256File } from "./package_windows.ts";

type ProductInstallerKind =
  | "windows-x64-self-extracting-cmd-installer"
  | "linux-x64-self-extracting-run-installer"
  | "macos-x64-self-extracting-command-installer"
  | "macos-arm64-self-extracting-command-installer";

interface ProductInstallerManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  package_type?: ProductInstallerKind;
  installer?: {
    file?: string;
    size_bytes?: number;
    sha256?: string;
  };
  payload?: {
    file?: string;
    package_type?: string;
    size_bytes?: number;
    sha256?: string;
  };
  user_experience?: {
    normal_user_runs_single_file?: boolean;
    extracts_payload_internally?: boolean;
    launches_after_install_by_default?: boolean;
    requires_node_pnpm_git_from_user?: boolean;
    requires_manual_nested_extraction?: boolean;
    requires_source_build?: boolean;
    gui_entry?: string;
  };
  boundaries?: {
    unsigned_installer?: boolean;
    signed_native_installer?: boolean;
    secrets_included?: boolean;
    gui_shell_modified?: boolean;
    hds_authority_modified?: boolean;
    installer_autostart?: boolean;
  };
}

interface ProductInstallerTarget {
  os: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  packageType: ProductInstallerKind;
  installerPath: string;
  payloadPath: string;
}

const PAYLOAD_MARKER = "__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__";

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

function targetsFromArgs(): ProductInstallerTarget[] {
  const version = readPackage().version;
  const windows: ProductInstallerTarget = {
    os: "windows",
    arch: "x64",
    packageType: "windows-x64-self-extracting-cmd-installer",
    installerPath: path.join(root, "release/windows", `BlueTanukiSetup-${version}-windows-x64.cmd`),
    payloadPath: path.join(root, "release/windows", `blue-tanuki-${version}-windows-x64-installer.zip`),
  };
  const linux: ProductInstallerTarget = {
    os: "linux",
    arch: "x64",
    packageType: "linux-x64-self-extracting-run-installer",
    installerPath: path.join(root, "release/linux", `BlueTanukiSetup-${version}-linux-x64.run`),
    payloadPath: path.join(root, "release/linux", `blue-tanuki-${version}-linux-x64-installer.tar.gz`),
  };
  const macosX64: ProductInstallerTarget = {
    os: "macos",
    arch: "x64",
    packageType: "macos-x64-self-extracting-command-installer",
    installerPath: path.join(root, "release/macos", `BlueTanukiSetup-${version}-macos-x64.command`),
    payloadPath: path.join(root, "release/macos", `blue-tanuki-${version}-macos-x64-installer.tar.gz`),
  };
  const macosArm64: ProductInstallerTarget = {
    os: "macos",
    arch: "arm64",
    packageType: "macos-arm64-self-extracting-command-installer",
    installerPath: path.join(root, "release/macos", `BlueTanukiSetup-${version}-macos-arm64.command`),
    payloadPath: path.join(root, "release/macos", `blue-tanuki-${version}-macos-arm64-installer.tar.gz`),
  };
  if (hasArg("--all")) return [windows, linux, macosX64, macosArm64];
  const platform = argValue("--platform") ?? "all";
  const arch = argValue("--arch");
  if (platform === "windows") return [windows];
  if (platform === "linux") return [linux];
  if (platform === "macos") return arch === "arm64" ? [macosArm64] : arch === "x64" ? [macosX64] : [macosX64, macosArm64];
  return [windows, linux, macosX64, macosArm64];
}

function readSha256Sidecar(file: string): string {
  const first = readFileSync(file, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  if (!first || !/^[a-f0-9]{64}$/.test(first)) {
    throw new Error(`invalid sha256 sidecar: ${file}`);
  }
  return first;
}

function readManifest(file: string): ProductInstallerManifest {
  return JSON.parse(readFileSync(file, "utf8")) as ProductInstallerManifest;
}

function decodeEmbeddedPayload(installerPath: string): Buffer {
  const text = readFileSync(installerPath, "utf8");
  const markerIndex = text.lastIndexOf(PAYLOAD_MARKER);
  if (markerIndex < 0) {
    throw new Error(`payload marker missing: ${installerPath}`);
  }
  const payloadText = text.slice(markerIndex + PAYLOAD_MARKER.length).replace(/\s/g, "");
  if (!payloadText) {
    throw new Error(`embedded payload missing: ${installerPath}`);
  }
  return Buffer.from(payloadText, "base64");
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertManifest(
  target: ProductInstallerTarget,
  manifest: ProductInstallerManifest,
  installerSha: string,
  payloadSha: string,
): void {
  const version = readPackage().version;
  if (manifest.schema_version !== 1) throw new Error("manifest schema_version must be 1");
  if (manifest.name !== "blue-tanuki") throw new Error("manifest name must be blue-tanuki");
  if (manifest.version !== version) throw new Error("manifest version mismatch");
  if (manifest.package_type !== target.packageType) throw new Error("manifest package_type mismatch");
  if (manifest.installer?.file !== path.basename(target.installerPath)) throw new Error("manifest installer.file mismatch");
  if (manifest.installer?.size_bytes !== statSync(target.installerPath).size) throw new Error("manifest installer size mismatch");
  if (manifest.installer?.sha256 !== installerSha) throw new Error("manifest installer sha256 mismatch");
  if (manifest.payload?.file !== path.basename(target.payloadPath)) throw new Error("manifest payload.file mismatch");
  if (manifest.payload?.size_bytes !== statSync(target.payloadPath).size) throw new Error("manifest payload size mismatch");
  if (manifest.payload?.sha256 !== payloadSha) throw new Error("manifest payload sha256 mismatch");
  if (manifest.user_experience?.normal_user_runs_single_file !== true) {
    throw new Error("manifest must declare normal_user_runs_single_file=true");
  }
  if (manifest.user_experience?.extracts_payload_internally !== true) {
    throw new Error("manifest must declare extracts_payload_internally=true");
  }
  if (manifest.user_experience?.launches_after_install_by_default !== true) {
    throw new Error("manifest must declare launches_after_install_by_default=true");
  }
  if (manifest.user_experience?.requires_node_pnpm_git_from_user !== false) {
    throw new Error("manifest must declare requires_node_pnpm_git_from_user=false");
  }
  if (manifest.user_experience?.requires_manual_nested_extraction !== false) {
    throw new Error("manifest must declare requires_manual_nested_extraction=false");
  }
  if (manifest.user_experience?.requires_source_build !== false) {
    throw new Error("manifest must declare requires_source_build=false");
  }
  if (manifest.user_experience?.gui_entry !== "http://127.0.0.1:8787/app") {
    throw new Error("manifest gui_entry mismatch");
  }
  if (manifest.boundaries?.unsigned_installer !== true) throw new Error("manifest must declare unsigned_installer=true");
  if (manifest.boundaries?.signed_native_installer !== false) throw new Error("manifest must declare signed_native_installer=false");
  if (manifest.boundaries?.secrets_included !== false) throw new Error("manifest must declare secrets_included=false");
  if (manifest.boundaries?.gui_shell_modified !== false) throw new Error("manifest must declare gui_shell_modified=false");
  if (manifest.boundaries?.hds_authority_modified !== false) throw new Error("manifest must declare hds_authority_modified=false");
  if (manifest.boundaries?.installer_autostart !== false) throw new Error("manifest must declare installer_autostart=false");
}

function assertNoNormalUserBuildPath(target: ProductInstallerTarget): void {
  const fullText = readFileSync(target.installerPath, "utf8");
  const markerIndex = fullText.lastIndexOf(PAYLOAD_MARKER);
  if (markerIndex < 0) {
    throw new Error(`payload marker missing: ${target.installerPath}`);
  }
  const text = fullText.slice(0, markerIndex);
  const forbidden = [
    "corepack",
    "pnpm install",
    "pnpm package",
    "would_run=pnpm",
    "npm install",
    "npm exec",
    "BuildFromSource",
    "build-from-source",
    "would_download_release_installer",
    "github.com/",
    "git clone",
  ];
  for (const needle of forbidden) {
    if (text.includes(needle)) {
      throw new Error(`${target.installerPath}: forbidden normal-user path text present: ${needle}`);
    }
  }
  if (target.os === "windows") {
    for (const needle of ["BlueTanukiSetup.cmd", "Expand-Archive", "requires_manual_nested_extraction=false"]) {
      if (!text.includes(needle)) throw new Error(`${target.installerPath}: missing ${needle}`);
    }
  } else {
    for (const needle of ["BlueTanukiSetup", "tar -xzf", "requires_manual_nested_extraction=false"]) {
      if (!text.includes(needle)) throw new Error(`${target.installerPath}: missing ${needle}`);
    }
    const mode = statSync(target.installerPath).mode & 0o777;
    if ((mode & 0o111) === 0) {
      throw new Error(`${target.installerPath}: installer is not executable`);
    }
  }
}

function verifyTarget(target: ProductInstallerTarget): void {
  if (!existsSync(target.installerPath)) throw new Error(`missing product installer: ${target.installerPath}`);
  if (!existsSync(target.payloadPath)) throw new Error(`missing payload installer: ${target.payloadPath}`);
  const shaFile = `${target.installerPath}.sha256`;
  const manifestFile = `${target.installerPath}.manifest.json`;
  if (!existsSync(shaFile)) throw new Error(`missing product installer sha256 sidecar: ${shaFile}`);
  if (!existsSync(manifestFile)) throw new Error(`missing product installer manifest: ${manifestFile}`);
  const installerSha = sha256File(target.installerPath);
  const sidecarSha = readSha256Sidecar(shaFile);
  if (sidecarSha !== installerSha) throw new Error(`product installer sha256 sidecar mismatch: ${target.installerPath}`);
  const payloadSha = sha256File(target.payloadPath);
  const embeddedSha = sha256Buffer(decodeEmbeddedPayload(target.installerPath));
  if (embeddedSha !== payloadSha) {
    throw new Error(`embedded payload sha256 mismatch: ${target.installerPath}`);
  }
  assertManifest(target, readManifest(manifestFile), installerSha, payloadSha);
  assertNoNormalUserBuildPath(target);
  console.log(`${target.os}_product_installer_verified=${target.installerPath}`);
  console.log(`platform=${target.os}`);
  console.log(`arch=${target.arch}`);
  console.log(`package_type=${target.packageType}`);
  console.log(`sha256=${installerSha}`);
  console.log(`payload_sha256=${payloadSha}`);
  console.log("normal_user_runs_single_file=true");
  console.log("requires_manual_nested_extraction=false");
  console.log("user_requires_node_pnpm_git=false");
  console.log("requires_source_build=false");
}

function main(): void {
  for (const target of targetsFromArgs()) {
    verifyTarget(target);
  }
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
