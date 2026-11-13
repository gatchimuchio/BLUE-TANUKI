import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readPackage, root, sha256File } from "./package_windows.ts";

type MacArch = "x64" | "arm64";

interface MacAppManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  package_type?: string;
  source_commit?: string;
  artifact?: { file?: string; size_bytes?: number; sha256?: string };
  native_app?: {
    bundle?: string;
    bundle_identifier?: string;
    architecture?: MacArch;
    minimum_macos?: string;
    installer_resource?: string;
    installer_sha256?: string;
    launch_behavior?: string;
  };
  user_experience?: {
    normal_user_runs_native_app?: boolean;
    install_requires_user_action?: boolean;
    autostart_enabled_by_default?: boolean;
    uninstall_requires_confirmation?: boolean;
    uninstall_purges_user_data?: boolean;
  };
  boundaries?: {
    app_signed?: boolean;
    installer_signed?: boolean;
    notarization_submission?: string;
    secrets_included?: boolean;
    hds_authority_modified?: boolean;
    local_process_actions_require_user_action?: boolean;
    external_write_capability_added?: boolean;
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

function targets(): MacArch[] {
  const requested = argValue("--arch") ?? (process.arch === "arm64" ? "arm64" : "x64");
  if (requested === "all") return ["x64", "arm64"];
  if (requested === "x64" || requested === "arm64") return [requested];
  throw new Error(`unsupported macOS architecture: ${requested}`);
}

function run(command: string, args: readonly string[], label: string): string {
  const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(-1200);
    throw new Error(`${label} failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function readShaSidecar(file: string, expectedName: string): string {
  const [sha256 = "", listedName = ""] = readFileSync(file, "utf8").trim().split(/\s+/u);
  if (!/^[a-f0-9]{64}$/iu.test(sha256) || listedName !== expectedName) {
    throw new Error(`invalid checksum sidecar: ${file}`);
  }
  return sha256.toLowerCase();
}

function plistValue(plist: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], `read Info.plist ${key}`);
}

function assertManifest(manifest: MacAppManifest, version: string, arch: MacArch, dmg: string, sha: string): void {
  if (manifest.schema_version !== 1 || manifest.name !== "blue-tanuki") throw new Error("DMG manifest identity is invalid");
  if (manifest.version !== version || manifest.package_type !== `macos-${arch}-native-app-dmg`) {
    throw new Error("DMG manifest version or architecture is invalid");
  }
  if (!manifest.source_commit || !/^[a-f0-9]{40}$/iu.test(manifest.source_commit)) {
    throw new Error("DMG manifest source_commit is missing or invalid");
  }
  if (manifest.artifact?.file !== path.basename(dmg) ||
      manifest.artifact?.size_bytes !== statSync(dmg).size ||
      manifest.artifact?.sha256 !== sha) {
    throw new Error("DMG manifest artifact integrity fields do not match");
  }
  if (manifest.native_app?.bundle !== "BlueTanuki.app" ||
      manifest.native_app?.bundle_identifier !== "com.blue-tanuki.app" ||
      manifest.native_app?.architecture !== arch ||
      manifest.native_app?.minimum_macos !== "11.0" ||
      manifest.native_app?.installer_resource !== "BlueTanukiSetup.command" ||
      manifest.native_app?.launch_behavior !== "explicit_user_action") {
    throw new Error("DMG manifest native app contract is invalid");
  }
  if (manifest.user_experience?.normal_user_runs_native_app !== true ||
      manifest.user_experience?.install_requires_user_action !== true ||
      manifest.user_experience?.autostart_enabled_by_default !== false ||
      manifest.user_experience?.uninstall_requires_confirmation !== true ||
      manifest.user_experience?.uninstall_purges_user_data !== false) {
    throw new Error("DMG manifest user experience boundaries are invalid");
  }
  if (manifest.boundaries?.app_signed !== false ||
      manifest.boundaries?.installer_signed !== false ||
      manifest.boundaries?.notarization_submission !== "not_submitted_by_builder" ||
      manifest.boundaries?.secrets_included !== false ||
      manifest.boundaries?.hds_authority_modified !== false ||
      manifest.boundaries?.local_process_actions_require_user_action !== true ||
      manifest.boundaries?.external_write_capability_added !== false) {
    throw new Error("DMG manifest security and authority boundaries are invalid");
  }
}

function verifyMountedImage(mount: string, version: string, arch: MacArch, expectedInstallerSha: string): void {
  const app = path.join(mount, "BlueTanuki.app");
  if (!existsSync(app) || !lstatSync(app).isDirectory()) throw new Error("DMG app bundle is missing or not a directory");
  const infoPlist = path.join(app, "Contents/Info.plist");
  run("plutil", ["-lint", infoPlist], "lint app Info.plist");
  if (plistValue(infoPlist, "CFBundleIdentifier") !== "com.blue-tanuki.app") throw new Error("bundle identifier mismatch");
  if (plistValue(infoPlist, "CFBundlePackageType") !== "APPL") throw new Error("bundle package type mismatch");
  if (plistValue(infoPlist, "CFBundleShortVersionString") !== version) throw new Error("bundle version mismatch");
  if (plistValue(infoPlist, "LSMinimumSystemVersion") !== "11.0") throw new Error("minimum macOS mismatch");

  const executable = path.join(app, "Contents/MacOS/BlueTanuki");
  const lipoArchs = run("lipo", ["-archs", executable], "inspect app architecture").split(/\s+/u).sort();
  const expectedArch = arch === "x64" ? "x86_64" : "arm64";
  if (lipoArchs.length !== 1 || lipoArchs[0] !== expectedArch) {
    throw new Error(`app executable architecture mismatch: ${lipoArchs.join(",")}`);
  }
  const buildMetadata = run("vtool", ["-show-build", executable], "inspect app deployment target");
  if (!/minos\s+11\.0(?:\s|$)/u.test(buildMetadata)) {
    throw new Error("app executable minimum macOS deployment target is not 11.0");
  }

  const resources = path.join(app, "Contents/Resources");
  const installer = path.join(resources, "BlueTanukiSetup.command");
  const installerSidecar = `${installer}.sha256`;
  if (!lstatSync(installer).isFile() || !lstatSync(installerSidecar).isFile()) {
    throw new Error("bundled product installer or checksum sidecar is missing");
  }
  const installerSha = readShaSidecar(installerSidecar, path.basename(installer));
  if (installerSha !== expectedInstallerSha || sha256File(installer) !== installerSha) {
    throw new Error("bundled product installer checksum mismatch");
  }

  const applications = path.join(mount, "Applications");
  if (!lstatSync(applications).isSymbolicLink() || readlinkSync(applications) !== "/Applications") {
    throw new Error("DMG Applications shortcut is missing or incorrect");
  }
  const readme = readFileSync(path.join(mount, "README_INSTALL_MACOS.txt"), "utf8");
  if (!readme.includes("署名なし") || !readme.includes("公証提出もしていません") ||
      !readme.includes("発行者認証ではありません") ||
      !readme.includes("macOSのセキュリティ設定を変更せず")) {
    throw new Error("DMG README does not state the signing and security boundary");
  }
}

async function verifyTarget(version: string, arch: MacArch): Promise<void> {
  const directory = path.join(root, "release/macos");
  const dmg = path.join(directory, `BlueTanuki-${version}-macos-${arch}.dmg`);
  const sidecar = `${dmg}.sha256`;
  const manifestPath = `${dmg}.manifest.json`;
  if (![dmg, sidecar, manifestPath].every(existsSync)) throw new Error(`macOS ${arch} app DMG artifacts are incomplete`);
  const expectedSha = readShaSidecar(sidecar, path.basename(dmg));
  const actualSha = sha256File(dmg);
  if (actualSha !== expectedSha) throw new Error(`DMG checksum mismatch: ${dmg}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MacAppManifest;
  assertManifest(manifest, version, arch, dmg, actualSha);
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (sourceCommit.status !== 0 || manifest.source_commit !== sourceCommit.stdout.trim()) {
    throw new Error("DMG source_commit does not match the currently checked-out source");
  }
  const expectedInstallerSha = manifest.native_app?.installer_sha256;
  if (!expectedInstallerSha || !/^[a-f0-9]{64}$/iu.test(expectedInstallerSha)) {
    throw new Error("DMG manifest installer checksum is missing");
  }

  run("hdiutil", ["verify", dmg], `verify DMG image (${arch})`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), `blue-tanuki-macos-app-verify-${arch}-`));
  const mount = path.join(tempRoot, "mount");
  await mkdir(mount);
  let mounted = false;
  let verificationFailure: unknown;
  try {
    run("hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg], `mount DMG read-only (${arch})`);
    mounted = true;
    verifyMountedImage(mount, version, arch, expectedInstallerSha);
  } catch (error) {
    verificationFailure = error;
  }

  if (mounted) {
    try {
      run("hdiutil", ["detach", "-quiet", mount], `detach verified DMG (${arch})`);
    } catch (error) {
      throw new Error(`could not detach verifier-owned read-only mount at ${mount}: ${String(error)}`);
    }
  }
  await rm(tempRoot, { recursive: true, force: true });
  if (verificationFailure) throw verificationFailure;
  console.log(`macos_native_app_verified=${dmg}`);
  console.log(`architecture=${arch}`);
  console.log(`sha256=${actualSha}`);
  console.log("mounted_read_only=true");
  console.log("app_signed=false");
  console.log("notarization_submission=not_submitted_by_builder");
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("macOS app verification requires macOS and hdiutil");
  const version = readPackage().version;
  for (const arch of targets()) await verifyTarget(version, arch);
}

main().catch((error) => {
  console.error(`[macos-app-verify] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
