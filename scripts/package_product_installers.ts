import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPackage,
  root,
  sha256File,
} from "./package_windows.ts";

type ProductInstallerKind =
  | "windows-x64-self-extracting-cmd-installer"
  | "linux-x64-self-extracting-run-installer"
  | "macos-x64-self-extracting-command-installer"
  | "macos-arm64-self-extracting-command-installer";

interface ProductInstallerTarget {
  os: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  packageType: ProductInstallerKind;
  payloadPath: string;
  outputPath: string;
}

interface ProductInstallerManifest {
  schema_version: 1;
  name: "blue-tanuki";
  version: string;
  package_type: ProductInstallerKind;
  created_at: string;
  installer: {
    file: string;
    size_bytes: number;
    sha256: string;
  };
  payload: {
    file: string;
    package_type: string;
    size_bytes: number;
    sha256: string;
  };
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

function wrapBase64(value: Buffer): string {
  return value.toString("base64").replace(/.{1,76}/g, "$&\n").trimEnd();
}

function readPayloadPackageType(payloadPath: string): string {
  const manifestPath = `${payloadPath}.manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new Error(`missing payload manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { package_type?: string };
  if (!manifest.package_type) {
    throw new Error(`payload manifest missing package_type: ${manifestPath}`);
  }
  return manifest.package_type;
}

function assertPayload(payloadPath: string): { packageType: string; sha256: string; sizeBytes: number } {
  if (!existsSync(payloadPath)) {
    throw new Error(`missing payload installer archive: ${payloadPath}`);
  }
  const shaFile = `${payloadPath}.sha256`;
  if (!existsSync(shaFile)) {
    throw new Error(`missing payload sha256 sidecar: ${shaFile}`);
  }
  const actualSha = sha256File(payloadPath);
  const sidecarSha = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  if (sidecarSha !== actualSha) {
    throw new Error(`payload sha256 sidecar mismatch: ${payloadPath}`);
  }
  return {
    packageType: readPayloadPackageType(payloadPath),
    sha256: actualSha,
    sizeBytes: statSyncSize(payloadPath),
  };
}

function statSyncSize(file: string): number {
  return statSync(file).size;
}

function targetsFromArgs(): ProductInstallerTarget[] {
  const pkg = readPackage();
  const version = pkg.version;
  const windows: ProductInstallerTarget = {
    os: "windows",
    arch: "x64",
    packageType: "windows-x64-self-extracting-cmd-installer",
    payloadPath: path.join(root, "release/windows", `blue-tanuki-${version}-windows-x64-installer.zip`),
    outputPath: path.join(root, "release/windows", `BlueTanukiSetup-${version}-windows-x64.cmd`),
  };
  const linux: ProductInstallerTarget = {
    os: "linux",
    arch: "x64",
    packageType: "linux-x64-self-extracting-run-installer",
    payloadPath: path.join(root, "release/linux", `blue-tanuki-${version}-linux-x64-installer.tar.gz`),
    outputPath: path.join(root, "release/linux", `BlueTanukiSetup-${version}-linux-x64.run`),
  };
  const macosX64: ProductInstallerTarget = {
    os: "macos",
    arch: "x64",
    packageType: "macos-x64-self-extracting-command-installer",
    payloadPath: path.join(root, "release/macos", `blue-tanuki-${version}-macos-x64-installer.tar.gz`),
    outputPath: path.join(root, "release/macos", `BlueTanukiSetup-${version}-macos-x64.command`),
  };
  const macosArm64: ProductInstallerTarget = {
    os: "macos",
    arch: "arm64",
    packageType: "macos-arm64-self-extracting-command-installer",
    payloadPath: path.join(root, "release/macos", `blue-tanuki-${version}-macos-arm64-installer.tar.gz`),
    outputPath: path.join(root, "release/macos", `BlueTanukiSetup-${version}-macos-arm64.command`),
  };
  if (hasArg("--all")) return [windows, linux, macosX64, macosArm64];
  const os = argValue("--platform") ?? "all";
  const arch = argValue("--arch");
  if (os === "windows") return [windows];
  if (os === "linux") return [linux];
  if (os === "macos") return arch === "arm64" ? [macosArm64] : arch === "x64" ? [macosX64] : [macosX64, macosArm64];
  return [windows, linux, macosX64, macosArm64];
}

function windowsCmdInstaller(target: ProductInstallerTarget, payloadSha: string, payloadBase64: string): string {
  return [
    "@echo off",
    "setlocal EnableExtensions DisableDelayedExpansion",
    "rem normal_user_runs_single_file=true",
    "rem requires_manual_nested_extraction=false",
    "rem user_requires_node_pnpm_git=false",
    "rem requires_source_build=false",
    "set \"BT_SELF=%~f0\"",
    `set "BT_EXPECTED_PAYLOAD_SHA=${payloadSha}"`,
    `set "BT_PAYLOAD_FILE=${path.basename(target.payloadPath)}"`,
    "set \"BT_PS1=%TEMP%\\BlueTanukiSelfExtract-%RANDOM%-%RANDOM%.ps1\"",
    "> \"%BT_PS1%\" echo $ErrorActionPreference = 'Stop'",
    ">> \"%BT_PS1%\" echo $self = $env:BT_SELF",
    ">> \"%BT_PS1%\" echo $expected = $env:BT_EXPECTED_PAYLOAD_SHA",
    ">> \"%BT_PS1%\" echo $payloadFile = $env:BT_PAYLOAD_FILE",
    ">> \"%BT_PS1%\" echo $marker = '__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__'",
    ">> \"%BT_PS1%\" echo $lines = [IO.File]::ReadAllLines($self)",
    ">> \"%BT_PS1%\" echo $markerIndex = [Array]::IndexOf($lines, $marker)",
    ">> \"%BT_PS1%\" echo if (-not ($markerIndex -ge 0)) { throw 'installer payload marker missing' }",
    ">> \"%BT_PS1%\" echo $payloadLines = $lines[($markerIndex + 1)..($lines.Length - 1)]",
    ">> \"%BT_PS1%\" echo $b64 = ($payloadLines -join '') -replace '\\s',''",
    ">> \"%BT_PS1%\" echo $work = Join-Path $env:TEMP ('BlueTanukiSetup-' + [Guid]::NewGuid().ToString('N'))",
    ">> \"%BT_PS1%\" echo New-Item -ItemType Directory -Force -Path $work ^| Out-Null",
    ">> \"%BT_PS1%\" echo $zip = Join-Path $work $payloadFile",
    ">> \"%BT_PS1%\" echo [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($b64))",
    ">> \"%BT_PS1%\" echo $stream = [IO.File]::OpenRead($zip)",
    ">> \"%BT_PS1%\" echo try { $shaObj = [Security.Cryptography.SHA256]::Create(); try { $actual = ([BitConverter]::ToString($shaObj.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $shaObj.Dispose() } } finally { $stream.Dispose() }",
    ">> \"%BT_PS1%\" echo if ($actual -ne $expected) { throw \"payload sha256 mismatch: $actual\" }",
    ">> \"%BT_PS1%\" echo $extract = Join-Path $work 'installer'",
    ">> \"%BT_PS1%\" echo Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force",
    ">> \"%BT_PS1%\" echo $setup = Join-Path $extract 'BlueTanukiSetup.cmd'",
    ">> \"%BT_PS1%\" echo if (-not (Test-Path -LiteralPath $setup)) { throw 'BlueTanukiSetup.cmd missing from extracted installer' }",
    ">> \"%BT_PS1%\" echo Write-Host 'BLUE-TANUKI installer payload verified. Starting setup...'",
    ">> \"%BT_PS1%\" echo ^& $setup @args",
    ">> \"%BT_PS1%\" echo exit $LASTEXITCODE",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%BT_PS1%\" %*",
    "set \"BT_CODE=%ERRORLEVEL%\"",
    "del \"%BT_PS1%\" >nul 2>nul",
    "if not \"%BT_CODE%\"==\"0\" (",
    "  echo.",
    "  echo BLUE-TANUKI setup failed.",
    "  if not \"%BLUE_TANUKI_NO_PAUSE%\"==\"1\" pause",
    "  exit /b %BT_CODE%",
    ")",
    "exit /b 0",
    PAYLOAD_MARKER,
    payloadBase64,
    "",
  ].join("\r\n");
}

function unixSelfExtractingInstaller(
  target: ProductInstallerTarget,
  payloadSha: string,
  payloadBase64: string,
): string {
  const payloadFile = path.basename(target.payloadPath);
  const runLine = target.os === "macos"
    ? "sh \"$extract_dir/BlueTanukiSetup.command\" \"$@\""
    : "sh \"$extract_dir/BlueTanukiSetup.sh\" \"$@\"";
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    "# normal_user_runs_single_file=true",
    "# requires_manual_nested_extraction=false",
    "# user_requires_node_pnpm_git=false",
    "# requires_source_build=false",
    "",
    `EXPECTED_PAYLOAD_SHA='${payloadSha}'`,
    `PAYLOAD_FILE='${payloadFile}'`,
    `PAYLOAD_MARKER='${PAYLOAD_MARKER}'`,
    "",
    "fail() {",
    "  echo \"BLUE-TANUKI setup failed: $*\" >&2",
    "  exit 1",
    "}",
    "",
    "decode_base64() {",
    "  if base64 --help 2>/dev/null | grep -q -- '-d'; then",
    "    base64 -d",
    "  else",
    "    base64 -D",
    "  fi",
    "}",
    "",
    "sha256_file() {",
    "  if command -v sha256sum >/dev/null 2>&1; then",
    "    sha256sum \"$1\" | awk '{print $1}'",
    "    return",
    "  fi",
    "  if command -v shasum >/dev/null 2>&1; then",
    "    shasum -a 256 \"$1\" | awk '{print $1}'",
    "    return",
    "  fi",
    "  if command -v openssl >/dev/null 2>&1; then",
    "    openssl dgst -sha256 \"$1\" | awk '{print $NF}'",
    "    return",
    "  fi",
    "  fail 'cannot verify payload sha256'",
    "}",
    "",
    "tmp_root=\"${TMPDIR:-/tmp}/blue-tanuki-setup.$$\"",
    "payload=\"$tmp_root/$PAYLOAD_FILE\"",
    "extract_dir=\"$tmp_root/installer\"",
    "cleanup() { rm -rf -- \"$tmp_root\"; }",
    "trap cleanup EXIT HUP INT TERM",
    "mkdir -p \"$extract_dir\"",
    "",
    "awk -v marker=\"$PAYLOAD_MARKER\" 'found { print; next } $0 == marker { found = 1 }' \"$0\" | decode_base64 > \"$payload\"",
    "actual_sha=$(sha256_file \"$payload\")",
    "[ \"$actual_sha\" = \"$EXPECTED_PAYLOAD_SHA\" ] || fail \"payload sha256 mismatch: $actual_sha\"",
    "tar -xzf \"$payload\" -C \"$extract_dir\"",
    "",
    "echo 'BLUE-TANUKI installer payload verified. Starting setup...'",
    `${runLine}`,
    "status=$?",
    "exit \"$status\"",
    "",
    PAYLOAD_MARKER,
    payloadBase64,
    "",
  ].join("\n");
}

async function writeProductInstaller(target: ProductInstallerTarget): Promise<void> {
  const pkg = readPackage();
  const payload = assertPayload(target.payloadPath);
  const payloadBuffer = readFileSync(target.payloadPath);
  const payloadBase64 = wrapBase64(payloadBuffer);
  const installerText = target.os === "windows"
    ? windowsCmdInstaller(target, payload.sha256, payloadBase64)
    : unixSelfExtractingInstaller(target, payload.sha256, payloadBase64);

  await mkdir(path.dirname(target.outputPath), { recursive: true });
  await writeFile(target.outputPath, installerText, "utf8");
  if (target.os !== "windows") {
    await chmod(target.outputPath, 0o755);
  }

  const installerSha = sha256File(target.outputPath);
  const installerStat = await stat(target.outputPath);
  const manifest: ProductInstallerManifest = {
    schema_version: 1,
    name: "blue-tanuki",
    version: pkg.version,
    package_type: target.packageType,
    created_at: new Date().toISOString(),
    installer: {
      file: path.basename(target.outputPath),
      size_bytes: installerStat.size,
      sha256: installerSha,
    },
    payload: {
      file: path.basename(target.payloadPath),
      package_type: payload.packageType,
      size_bytes: payload.sizeBytes,
      sha256: payload.sha256,
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
  await writeFile(`${target.outputPath}.sha256`, `${installerSha}  ${path.basename(target.outputPath)}\n`, "utf8");
  await writeFile(`${target.outputPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`${target.os}_product_installer=${target.outputPath}`);
  console.log(`platform=${target.os}`);
  console.log(`arch=${target.arch}`);
  console.log(`package_type=${target.packageType}`);
  console.log(`payload=${target.payloadPath}`);
  console.log(`payload_sha256=${payload.sha256}`);
  console.log(`sha256=${installerSha}`);
  console.log("normal_user_runs_single_file=true");
  console.log("requires_manual_nested_extraction=false");
  console.log("user_requires_node_pnpm_git=false");
  console.log("requires_source_build=false");
  console.log("unsigned_installer=true");
}

async function main(): Promise<void> {
  for (const target of targetsFromArgs()) {
    await writeProductInstaller(target);
  }
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
