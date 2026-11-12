import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  closeSync,
} from "node:fs";
import * as path from "node:path";
import { windowsShortPath } from "./windows_short_path.js";

interface WindowsExeManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  package_type?: string;
  installer?: { file?: string; size_bytes?: number; sha256?: string };
  bootstrapper?: { file?: string; size_bytes?: number; sha256?: string; implementation?: string };
  payload?: { file?: string; package_type?: string; size_bytes?: number; sha256?: string };
  user_experience?: Record<string, unknown>;
  boundaries?: Record<string, unknown>;
}

const PAYLOAD_MARKER = "__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__";

export interface WindowsIExpressVerification {
  commandPath: string;
  installerSha256: string;
  payloadSha256: string;
  bootstrapperSha256: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(filepath: string): string {
  return sha256(readFileSync(filepath));
}

function readSha256Sidecar(filepath: string): string {
  if (!existsSync(filepath)) throw new Error(`missing SHA-256 sidecar: ${filepath}`);
  const value = readFileSync(filepath, "utf8").trim().split(/\s+/u)[0]?.toLowerCase();
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid SHA-256 sidecar: ${filepath}`);
  return value;
}

function assertPeAndEmbeddedCabinet(filepath: string): void {
  const fd = openSync(filepath, "r");
  try {
    const head = Buffer.alloc(65_536);
    const read = readSync(fd, head, 0, head.length, 0);
    const prefix = head.subarray(0, read);
    if (prefix.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("installer lacks a Windows PE header");
    const peOffset = prefix.readUInt32LE(0x3c);
    if (peOffset + 4 > prefix.length || prefix.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\u0000\u0000") {
      throw new Error("installer PE signature is invalid");
    }

    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    let carry = Buffer.alloc(0);
    let found = false;
    while (!found) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      position += count;
      const combined = Buffer.concat([carry, chunk.subarray(0, count)]);
      found = combined.indexOf("MSCF", "ascii") >= 0;
      carry = combined.subarray(Math.max(0, combined.length - 3));
    }
    if (!found) throw new Error("installer has no embedded IExpress Cabinet");
  } finally {
    closeSync(fd);
  }
}

function assertManifest(
  manifest: WindowsExeManifest,
  version: string,
  installerPath: string,
  installerHash: string,
  payloadPath: string,
  payloadHash: string,
): void {
  if (manifest.schema_version !== 1 || manifest.name !== "blue-tanuki" || manifest.version !== version ||
      manifest.package_type !== "windows-x64-iexpress-self-extracting-exe-installer") {
    throw new Error("Windows .exe installer manifest identity mismatch");
  }
  if (manifest.installer?.file !== path.basename(installerPath) ||
      manifest.installer.size_bytes !== statSync(installerPath).size || manifest.installer.sha256 !== installerHash) {
    throw new Error("Windows .exe installer manifest does not match the executable");
  }
  if (manifest.bootstrapper?.file !== "BlueTanukiSetup.cmd" ||
      !Number.isSafeInteger(manifest.bootstrapper.size_bytes) || (manifest.bootstrapper.size_bytes ?? 0) <= 0 ||
      !/^[a-f0-9]{64}$/u.test(manifest.bootstrapper.sha256 ?? "") ||
      manifest.bootstrapper.implementation !== "Windows IExpress") {
    throw new Error("Windows .exe bootstrapper manifest is invalid");
  }
  if (manifest.payload?.file !== path.basename(payloadPath) ||
      !Number.isSafeInteger(manifest.payload.size_bytes) || manifest.payload.size_bytes !== statSync(payloadPath).size ||
      manifest.payload.sha256 !== payloadHash ||
      manifest.payload.package_type !== "windows-x64-zip-installer") {
    throw new Error("Windows .exe payload manifest does not match the selected ZIP");
  }
  if (manifest.user_experience?.normal_user_runs_single_file !== true ||
      manifest.user_experience?.extracts_payload_internally !== true ||
      manifest.user_experience?.launches_after_install_by_default !== true ||
      manifest.user_experience?.requires_manual_nested_extraction !== false ||
      manifest.user_experience?.requires_node_pnpm_git_from_user !== false ||
      manifest.user_experience?.requires_source_build !== false ||
      manifest.user_experience?.gui_entry !== "http://127.0.0.1:8787/app" ||
      manifest.boundaries?.unsigned_installer !== true || manifest.boundaries?.signed_native_installer !== false ||
      manifest.boundaries?.secrets_included !== false || manifest.boundaries?.installer_autostart !== false) {
    throw new Error("Windows .exe installer manifest weakens or misstates its delivery boundary");
  }
}

/** Verify the IExpress artifact against its sidecars and payload, then extract only its embedded command. */
export function verifyAndExtractWindowsIExpressCommand(
  installerInput: string,
  payloadInput: string,
  extractionRootInput: string,
  expectedVersion: string,
): WindowsIExpressVerification {
  if (process.platform !== "win32") throw new Error("The Windows .exe installer verifier must run on Windows");
  if (!/^[0-9A-Za-z.+-]+$/u.test(expectedVersion)) throw new Error("expected Windows package version is invalid");

  const installer = path.resolve(installerInput);
  const payload = path.resolve(payloadInput);
  const extractionRoot = path.resolve(extractionRootInput);
  for (const filepath of [installer, `${installer}.sha256`, `${installer}.manifest.json`, payload, `${payload}.sha256`]) {
    if (!existsSync(filepath)) throw new Error(`required Windows .exe verification input is missing: ${filepath}`);
  }
  const installerStat = lstatSync(installer);
  const payloadStat = lstatSync(payload);
  if (!installerStat.isFile() || installerStat.isSymbolicLink() || !payloadStat.isFile() || payloadStat.isSymbolicLink()) {
    throw new Error("Windows .exe verification inputs must be regular files");
  }

  const installerHash = sha256File(installer);
  if (readSha256Sidecar(`${installer}.sha256`) !== installerHash) throw new Error("Windows .exe SHA-256 sidecar mismatch");
  const payloadHash = sha256File(payload);
  if (readSha256Sidecar(`${payload}.sha256`) !== payloadHash) throw new Error("Windows .exe selected ZIP SHA-256 sidecar mismatch");
  const manifest = JSON.parse(readFileSync(`${installer}.manifest.json`, "utf8")) as WindowsExeManifest;
  assertManifest(manifest, expectedVersion, installer, installerHash, payload, payloadHash);
  assertPeAndEmbeddedCabinet(installer);

  if (existsSync(extractionRoot)) throw new Error(`IExpress extraction directory already exists: ${extractionRoot}`);
  mkdirSync(extractionRoot);
  const extractShortPath = windowsShortPath(extractionRoot);
  const result = spawnSync(installer, ["/Q", `/T:${extractShortPath}`, "/C"], {
    cwd: extractionRoot,
    encoding: "utf8",
    timeout: 3 * 60_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`IExpress extraction check failed with ${result.status ?? result.error?.message}: ${result.stderr || result.stdout}`);
  }

  const entries = readdirSync(extractionRoot);
  if (entries.length !== 1 || entries[0] !== "BlueTanukiSetup.cmd") {
    throw new Error(`IExpress extracted an unexpected file set: ${entries.join(", ") || "empty"}`);
  }
  const commandPath = path.join(extractionRoot, "BlueTanukiSetup.cmd");
  const commandStat = lstatSync(commandPath);
  if (!commandStat.isFile() || commandStat.isSymbolicLink()) throw new Error("IExpress command payload is not a regular file");
  const commandBytes = readFileSync(commandPath);
  const bootstrapperHash = sha256(commandBytes);
  if (commandBytes.length !== manifest.bootstrapper?.size_bytes || bootstrapperHash !== manifest.bootstrapper?.sha256) {
    throw new Error("IExpress extracted command payload differs from the manifest");
  }

  const commandText = commandBytes.toString("utf8");
  const markerIndex = commandText.lastIndexOf(PAYLOAD_MARKER);
  if (markerIndex < 0) throw new Error("extracted command wrapper has no embedded ZIP marker");
  const embeddedText = commandText.slice(markerIndex + PAYLOAD_MARKER.length).replace(/\s/gu, "");
  if (!embeddedText || !/^[A-Za-z0-9+/]*={0,2}$/u.test(embeddedText)) {
    throw new Error("extracted command wrapper contains invalid Base64 payload text");
  }
  const embeddedZip = Buffer.from(embeddedText, "base64");
  if (embeddedZip.length !== manifest.payload?.size_bytes || sha256(embeddedZip) !== payloadHash) {
    throw new Error("IExpress command payload embeds a different Windows ZIP");
  }

  return { commandPath, installerSha256: installerHash, payloadSha256: payloadHash, bootstrapperSha256: bootstrapperHash };
}
