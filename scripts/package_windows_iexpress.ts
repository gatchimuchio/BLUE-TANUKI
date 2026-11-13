import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hashEmbeddedBase64PayloadSync } from "./embedded_payload.js";
import { sha256File } from "./package_windows.ts";
import { windowsShortPath } from "./windows_short_path.js";
import { windowsArtifactDir } from "./windows_artifact_dir.js";

interface PackageJson {
  version?: string;
}

interface ProductInstallerManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  package_type?: string;
  installer?: { file?: string; size_bytes?: number; sha256?: string };
  archive?: { file?: string; size_bytes?: number; sha256?: string };
  payload?: { file?: string; package_type?: string; size_bytes?: number; sha256?: string };
}

interface WindowsExeManifest {
  schema_version: 1;
  name: "blue-tanuki";
  version: string;
  package_type: "windows-x64-iexpress-self-extracting-exe-installer";
  created_at: string;
  installer: { file: string; size_bytes: number; sha256: string };
  bootstrapper: { file: string; size_bytes: number; sha256: string; implementation: "Windows IExpress" };
  payload: { file: string; package_type: string; size_bytes: number; sha256: string };
  user_experience: {
    normal_user_runs_single_file: true;
    extracts_payload_internally: true;
    launches_after_install_by_default: true;
    requires_node_pnpm_git_from_user: false;
    requires_manual_nested_extraction: false;
    requires_source_build: false;
    gui_entry: "http://127.0.0.1:8787/app";
  };
  boundaries: {
    unsigned_installer: true;
    signed_native_installer: false;
    secrets_included: false;
    gui_shell_modified: false;
    hds_authority_modified: false;
    installer_autostart: false;
  };
}

const root = process.cwd();
const PAYLOAD_MARKER = "__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__";

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

function readSha256Sidecar(filepath: string): string {
  if (!existsSync(filepath)) throw new Error(`missing SHA-256 sidecar: ${filepath}`);
  const value = readFileSync(filepath, "utf8").trim().split(/\s+/u)[0]?.toLowerCase();
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid SHA-256 sidecar: ${filepath}`);
  return value;
}

function assertPeWithEmbeddedCabinet(filepath: string): void {
  const fd = openSync(filepath, "r");
  try {
    if (statSync(filepath).size < 1024) throw new Error("IExpress output does not have a Windows PE header");
    const header = Buffer.alloc(65_536);
    const headerSize = readSync(fd, header, 0, header.length, 0);
    const prefix = header.subarray(0, headerSize);
    if (prefix.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("IExpress output does not have a Windows PE header");
    const peOffset = prefix.readUInt32LE(0x3c);
    if (peOffset + 4 > prefix.length || prefix.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\u0000\u0000") {
      throw new Error("IExpress output PE signature is missing");
    }
    const chunk = Buffer.alloc(1024 * 1024);
    let position = peOffset + 4;
    let carry = Buffer.alloc(0);
    let found = false;
    while (!found) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      position += count;
      const combined = carry.length === 0 ? chunk.subarray(0, count) : Buffer.concat([carry, chunk.subarray(0, count)]);
      found = combined.indexOf("MSCF", "ascii") >= 0;
      carry = Buffer.from(combined.subarray(Math.max(0, combined.length - 3)));
    }
    if (!found) throw new Error("IExpress output does not contain an embedded Cabinet payload");
  } finally {
    closeSync(fd);
  }
}

function buildSed(targetExeShortPath: string, stageDirShortPath: string): string {
  const stageDir = path.win32.join(stageDirShortPath, "");
  return [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=1",
    "HideExtractAnimation=1",
    "UseLongFileName=1",
    "InsideCompressed=0",
    "Compress=0",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=",
    "TargetName=%TargetName%",
    "FriendlyName=%FriendlyName%",
    "AppLaunched=%AppLaunched%",
    "PostInstallCmd=<None>",
    "AdminQuietInstCmd=",
    "UserQuietInstCmd=",
    "SourceFiles=SourceFiles",
    "[Strings]",
    `TargetName=${targetExeShortPath}`,
    "FriendlyName=BLUE-TANUKI Setup",
    "AppLaunched=cmd.exe /D /C BlueTanukiSetup.cmd",
    'FILE0="BlueTanukiSetup.cmd"',
    "[SourceFiles]",
    `SourceFiles0=${stageDir}`,
    "[SourceFiles0]",
    "%FILE0%=",
    "",
  ].join("\r\n");
}

function main(): void {
  if (process.platform !== "win32") throw new Error("The Windows .exe installer must be built on a Windows host");

  const version = readPackage().version;
  if (!version || !/^[0-9A-Za-z.+-]+$/u.test(version)) throw new Error("package.json version is missing or invalid");
  const releaseDir = windowsArtifactDir(root);
  const sourceCmd = path.join(releaseDir, `BlueTanukiSetup-${version}-windows-x64.cmd`);
  const sourceCmdManifestPath = `${sourceCmd}.manifest.json`;
  const sourceCmdShaPath = `${sourceCmd}.sha256`;
  const payload = path.join(releaseDir, `blue-tanuki-${version}-windows-x64-installer.zip`);
  const payloadManifestPath = `${payload}.manifest.json`;
  const payloadShaPath = `${payload}.sha256`;
  const outputExe = path.join(releaseDir, `BlueTanukiSetup-${version}-windows-x64.exe`);

  for (const filepath of [sourceCmd, sourceCmdManifestPath, sourceCmdShaPath, payload, payloadManifestPath, payloadShaPath]) {
    if (!existsSync(filepath)) throw new Error(`required Windows package input is missing: ${filepath}`);
  }

  const sourceCmdStat = statSync(sourceCmd);
  const sourceCmdHash = sha256File(sourceCmd);
  const expectedSourceCmdHash = readSha256Sidecar(sourceCmdShaPath);
  if (sourceCmdHash !== expectedSourceCmdHash) throw new Error("source setup command SHA-256 mismatch");
  const sourceCmdManifest = JSON.parse(readFileSync(sourceCmdManifestPath, "utf8")) as ProductInstallerManifest;
  if (sourceCmdManifest.name !== "blue-tanuki" || sourceCmdManifest.version !== version ||
      sourceCmdManifest.package_type !== "windows-x64-self-extracting-cmd-installer" ||
      sourceCmdManifest.installer?.sha256?.toLowerCase() !== sourceCmdHash) {
    throw new Error("source setup command manifest does not match the current Windows installer");
  }

  const payloadHash = sha256File(payload);
  if (payloadHash !== readSha256Sidecar(payloadShaPath)) throw new Error("Windows payload ZIP SHA-256 mismatch");
  const payloadManifest = JSON.parse(readFileSync(payloadManifestPath, "utf8")) as ProductInstallerManifest;
  if (payloadManifest.name !== "blue-tanuki" || payloadManifest.version !== version ||
      payloadManifest.package_type !== "windows-x64-zip-installer" ||
      payloadManifest.archive?.file !== path.basename(payload) ||
      payloadManifest.archive.size_bytes !== statSync(payload).size ||
      payloadManifest.archive.sha256?.toLowerCase() !== payloadHash) {
    throw new Error("Windows payload manifest does not match the current ZIP installer");
  }
  const payloadStat = statSync(payload);
  const wrapperPayload = sourceCmdManifest.payload;
  if (wrapperPayload?.file !== path.basename(payload) ||
      wrapperPayload.package_type !== payloadManifest.package_type ||
      wrapperPayload.size_bytes !== payloadStat.size ||
      wrapperPayload.sha256?.toLowerCase() !== payloadHash) {
    throw new Error("Windows command wrapper manifest does not bind to the current ZIP installer");
  }
  const embeddedPayload = hashEmbeddedBase64PayloadSync(sourceCmd, PAYLOAD_MARKER);
  if (embeddedPayload.sha256 !== payloadHash || embeddedPayload.sizeBytes !== payloadStat.size) {
    throw new Error("Windows command wrapper embeds a different or invalid ZIP payload");
  }

  const stageDir = mkdtempSync(path.join(tmpdir(), "blue-tanuki-iexpress-"));
  let stageRetained = true;
  try {
    const stageCmd = path.join(stageDir, "BlueTanukiSetup.cmd");
    const sedPath = path.join(stageDir, "BlueTanukiSetup.sed");
    const stagedExe = path.join(stageDir, "BlueTanukiSetup.exe");
    copyFileSync(sourceCmd, stageCmd);

    const stageShort = windowsShortPath(stageDir);
    const stagedExeShort = path.win32.join(stageShort, "BlueTanukiSetup.exe");
    const sedShort = path.win32.join(stageShort, "BlueTanukiSetup.sed");
    writeFileSync(sedPath, buildSed(stagedExeShort, stageShort), { encoding: "utf8" });

    const iexpress = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "iexpress.exe");
    if (!existsSync(iexpress)) throw new Error("Windows IExpress is not available on this host");
    const result = spawnSync(iexpress, ["/N", "/Q", sedShort], {
      cwd: stageDir,
      encoding: "utf8",
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`IExpress failed with ${result.status ?? result.error?.message}: ${result.stderr || result.stdout}`);
    }
    if (!existsSync(stagedExe)) throw new Error("IExpress completed without producing the Windows installer .exe");
    assertPeWithEmbeddedCabinet(stagedExe);

    mkdirSync(releaseDir, { recursive: true });
    copyFileSync(stagedExe, outputExe);
    const installerHash = sha256File(outputExe);
    const installerStat = statSync(outputExe);
    const manifest: WindowsExeManifest = {
      schema_version: 1,
      name: "blue-tanuki",
      version,
      package_type: "windows-x64-iexpress-self-extracting-exe-installer",
      created_at: new Date().toISOString(),
      installer: { file: path.basename(outputExe), size_bytes: installerStat.size, sha256: installerHash },
      bootstrapper: {
        file: "BlueTanukiSetup.cmd",
        size_bytes: sourceCmdStat.size,
        sha256: sourceCmdHash,
        implementation: "Windows IExpress",
      },
      payload: {
        file: path.basename(payload),
        package_type: payloadManifest.package_type ?? "windows-x64-zip-installer",
        size_bytes: payloadStat.size,
        sha256: payloadHash,
      },
      user_experience: {
        normal_user_runs_single_file: true,
        extracts_payload_internally: true,
        launches_after_install_by_default: true,
        requires_node_pnpm_git_from_user: false,
        requires_manual_nested_extraction: false,
        requires_source_build: false,
        gui_entry: "http://127.0.0.1:8787/app",
      },
      boundaries: {
        unsigned_installer: true,
        signed_native_installer: false,
        secrets_included: false,
        gui_shell_modified: false,
        hds_authority_modified: false,
        installer_autostart: false,
      },
    };
    writeFileSync(`${outputExe}.sha256`, `${installerHash}  ${path.basename(outputExe)}\n`, "utf8");
    writeFileSync(`${outputExe}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    console.log(`windows_product_installer=${outputExe}`);
    console.log(`package_type=${manifest.package_type}`);
    console.log(`installer_sha256=${installerHash}`);
    console.log(`payload_sha256=${payloadHash}`);
    console.log("signature=unsigned");
    console.log("public_distribution=HOLD_owner_GO_and_signing_required");
    rmSync(stageDir, { recursive: true, force: true });
    stageRetained = false;
  } catch (error) {
    console.error(`IExpress staging retained for diagnosis: ${stageDir}`);
    throw error;
  } finally {
    if (!stageRetained && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  }
}

main();
