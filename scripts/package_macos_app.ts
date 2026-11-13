import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { readPackage, root, sha256File } from "./package_windows.ts";

type MacArch = "x64" | "arm64";

interface ProductInstallerManifest {
  version?: string;
  package_type?: string;
  installer?: { file?: string; size_bytes?: number; sha256?: string };
  macos_distribution?: {
    installer_code_signature?: string;
    notarization_submission?: string;
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

function run(command: string, args: readonly string[], label: string): void {
  const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status === 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return;
  }
  const details = [stderr, stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/u)
    .slice(-5)
    .join(" ")
    .slice(0, 800);
  throw new Error(`${label} failed with exit code ${String(result.status)}${details ? `: ${details}` : ""}`);
}

function readVerifiedInstaller(version: string, arch: MacArch): { file: string; sha256: string } {
  const file = path.join(root, "release/macos", `BlueTanukiSetup-${version}-macos-${arch}.command`);
  const sidecar = `${file}.sha256`;
  const manifestFile = `${file}.manifest.json`;
  if (![file, sidecar, manifestFile].every(existsSync)) {
    throw new Error(`macOS ${arch} product installer is missing; build and verify the one-file installer first`);
  }
  const [expected = "", listedName = ""] = readFileSync(sidecar, "utf8").trim().split(/\s+/u);
  if (!/^[a-f0-9]{64}$/iu.test(expected) || listedName !== path.basename(file)) {
    throw new Error(`invalid macOS installer checksum sidecar: ${sidecar}`);
  }
  const actual = sha256File(file);
  if (actual !== expected.toLowerCase()) throw new Error(`macOS installer checksum mismatch: ${file}`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as ProductInstallerManifest;
  if (manifest.version !== version || manifest.package_type !== `macos-${arch}-self-extracting-command-installer`) {
    throw new Error(`macOS installer manifest does not match version/architecture: ${manifestFile}`);
  }
  if (manifest.installer?.file !== path.basename(file) ||
      manifest.installer?.size_bytes !== statSync(file).size ||
      manifest.installer?.sha256 !== actual) {
    throw new Error(`macOS installer manifest integrity fields do not match: ${manifestFile}`);
  }
  if (manifest.macos_distribution?.installer_code_signature !== "unsigned" ||
      manifest.macos_distribution?.notarization_submission !== "not_submitted_by_builder") {
    throw new Error(`macOS installer signing state is not the expected unsigned build state: ${manifestFile}`);
  }
  return { file, sha256: actual };
}

function bundleInfo(version: string): string {
  const numericVersion = version.split("-")[0] ?? version;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>ja</string>
  <key>CFBundleExecutable</key><string>BlueTanuki</string>
  <key>CFBundleIdentifier</key><string>com.blue-tanuki.app</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>BLUE-TANUKI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${numericVersion}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;
}

function readme(version: string, arch: MacArch): string {
  const dmg = `BlueTanuki-${version}-macos-${arch}.dmg`;
  const archive = `blue-tanuki-${version}-macos-${arch}-installer.tar.gz`;
  return [
    `BLUE-TANUKI macOS ${arch} インストーラー`,
    "",
    "インストール手順",
    "1. BlueTanuki.appをApplicationsへドラッグします。",
    "2. ApplicationsからBLUE-TANUKIを起動します。",
    "3.「インストールまたは更新」を選び、完了後に「コントロールセンターを開く」を選びます。",
    "",
    "既存の保護付きSetup／Uninstallを使用します。インストールは利用者の操作で開始し、自動起動は設定しません。データ消去操作は設けず、通常のアンインストールでは設定とユーザーデータを保持します。",
    "",
    "配布状態",
    "このビルドは署名なしで、公証提出もしていません。発行者の真正性や公証済み配布を証明しません。同梱SHA-256は破損・不一致の検知用で、発行者認証ではありません。macOSのセキュリティ設定を変更せず、OSが起動を拒否する場合は、署名・公証済みの正式配布物を利用してください。",
    "",
    `DMG: ${dmg}`,
    `SHA-256: ${dmg}.sha256`,
    `アーカイブ形式の代替: ${archive}`,
    "代替アーカイブも署名なしで、macOSの通常のセキュリティ規則に従います。",
    "",
    "このパッケージが宣言する最小macOS版は11.0です。対象環境での実行互換性は別途確認が必要です。",
    "",
  ].join("\n");
}

async function packageTarget(version: string, arch: MacArch): Promise<void> {
  const installer = readVerifiedInstaller(version, arch);
  const appSource = path.join(root, "install/macos/app/BlueTanukiApp.swift");
  if (!existsSync(appSource)) throw new Error(`missing native macOS app source: ${appSource}`);

  const outputDirectory = path.join(root, "release/macos");
  await mkdir(outputDirectory, { recursive: true });
  const outputFile = path.join(outputDirectory, `BlueTanuki-${version}-macos-${arch}.dmg`);
  const workRoot = await mkdtemp(path.join(tmpdir(), `blue-tanuki-macos-app-${arch}-`));
  try {
    const app = path.join(workRoot, "BlueTanuki.app");
    const contents = path.join(app, "Contents");
    const macOS = path.join(contents, "MacOS");
    const resources = path.join(contents, "Resources");
    const imageRoot = path.join(workRoot, "image");
    await mkdir(macOS, { recursive: true });
    await mkdir(resources, { recursive: true });
    await mkdir(imageRoot, { recursive: true });
    await writeFile(path.join(contents, "Info.plist"), bundleInfo(version), "utf8");
    await copyFile(installer.file, path.join(resources, "BlueTanukiSetup.command"));
    await writeFile(
      path.join(resources, "BlueTanukiSetup.command.sha256"),
      `${installer.sha256}  BlueTanukiSetup.command\n`,
      "utf8",
    );

    const tripleArch = arch === "x64" ? "x86_64" : "arm64";
    const executable = path.join(macOS, "BlueTanuki");
    run("xcrun", [
      "swiftc", "-parse-as-library", "-O",
      "-target", `${tripleArch}-apple-macosx11.0`,
      "-framework", "AppKit",
      "-framework", "CryptoKit",
      appSource,
      "-o", executable,
    ], `compile native macOS app (${arch})`);
    await chmod(executable, 0o755);
    await symlink("/Applications", path.join(imageRoot, "Applications"));
    await cp(app, path.join(imageRoot, "BlueTanuki.app"), { recursive: true, dereference: false });
    await writeFile(path.join(imageRoot, "README_INSTALL_MACOS.txt"), readme(version, arch), "utf8");

    if (existsSync(outputFile) && !lstatSync(outputFile).isFile()) {
      throw new Error(`refusing to replace a non-regular generated artifact: ${outputFile}`);
    }
    const partialDirectory = await mkdtemp(path.join(outputDirectory, ".macos-app-dmg-"));
    const partialOutput = path.join(partialDirectory, path.basename(outputFile));
    try {
      run("hdiutil", [
        "create", "-ov", "-format", "UDZO",
        "-volname", "BLUE-TANUKI",
        "-srcfolder", imageRoot,
        partialOutput,
      ], `create macOS DMG (${arch})`);
      await rename(partialOutput, outputFile);
    } finally {
      await rm(partialDirectory, { recursive: true, force: true });
    }

    const sha256 = sha256File(outputFile);
    const { size } = statSync(outputFile);
    const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (sourceCommit.status !== 0) throw new Error("cannot identify source commit for the macOS app manifest");
    const manifest = {
      schema_version: 1,
      name: "blue-tanuki",
      version,
      package_type: `macos-${arch}-native-app-dmg`,
      created_at: new Date().toISOString(),
      source_commit: sourceCommit.stdout.trim(),
      artifact: { file: path.basename(outputFile), size_bytes: size, sha256 },
      native_app: {
        bundle: "BlueTanuki.app",
        bundle_identifier: "com.blue-tanuki.app",
        architecture: arch,
        minimum_macos: "11.0",
        installer_resource: "BlueTanukiSetup.command",
        installer_sha256: installer.sha256,
        launch_behavior: "explicit_user_action",
      },
      user_experience: {
        normal_user_runs_native_app: true,
        install_requires_user_action: true,
        autostart_enabled_by_default: false,
        uninstall_requires_confirmation: true,
        uninstall_purges_user_data: false,
      },
      boundaries: {
        app_signed: false,
        installer_signed: false,
        notarization_submission: "not_submitted_by_builder",
        secrets_included: false,
        hds_authority_modified: false,
        local_process_actions_require_user_action: true,
        external_write_capability_added: false,
      },
    };
    await writeFile(`${outputFile}.sha256`, `${sha256}  ${path.basename(outputFile)}\n`, "utf8");
    await writeFile(`${outputFile}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`macos_native_app_dmg=${outputFile}`);
    console.log(`architecture=${arch}`);
    console.log(`sha256=${sha256}`);
    console.log("app_signed=false");
    console.log("notarization_submission=not_submitted_by_builder");
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("native macOS .app and DMG packaging requires macOS, Xcode command line tools, and hdiutil");
  }
  const version = readPackage().version;
  for (const arch of targets()) await packageTarget(version, arch);
}

main().catch((error) => {
  console.error(`[macos-app-package] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
