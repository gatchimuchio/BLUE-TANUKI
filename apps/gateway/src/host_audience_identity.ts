import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DIGEST = /^[a-f0-9]{64}$/;
const MACHINE_GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MACHINE_ID = /^[a-f0-9]{32}$/i;

/** Stable, OS-sourced local identity for binding Gateway-owned state to its host. */
export function currentHostAudienceDigest(platform: NodeJS.Platform = process.platform): string {
  const identifier = readHostIdentifier(platform);
  return deriveHostAudienceDigest(platform, identifier);
}

/** Hashes the OS identifier before it enters persisted runtime state or IPC. */
export function deriveHostAudienceDigest(platform: string, identifier: string): string {
  const normalized = identifier.trim().replace(/^\{(.+)\}$/, "$1").toLowerCase();
  const valid = platform === "linux"
    ? MACHINE_ID.test(normalized) && !/^0+$/.test(normalized)
    : (platform === "win32" || platform === "darwin") && MACHINE_GUID.test(normalized) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(normalized);
  if (!valid) throw new Error("gateway_host_audience_identity_unavailable");
  return createHash("sha256")
    .update(JSON.stringify(["blue-tanuki.host-audience.v1", platform, normalized]), "utf8")
    .digest("hex");
}

function readHostIdentifier(platform: NodeJS.Platform): string {
  if (platform === "linux") {
    for (const filepath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = readFileSync(filepath, "utf8").trim();
        if (MACHINE_ID.test(value) && !/^0+$/.test(value)) return value;
      } catch {
        // Try the standard fallback path; do not include OS identifiers in errors.
      }
    }
    throw new Error("gateway_host_audience_identity_unavailable");
  }

  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const result = spawnSync(join(systemRoot, "System32", "reg.exe"), [
      "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid",
    ], { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
    if (result.status !== 0 || result.error) throw new Error("gateway_host_audience_identity_unavailable");
    const match = /^\s*MachineGuid\s+REG_SZ\s+([a-f0-9-]+)\s*$/im.exec(result.stdout);
    if (!match) throw new Error("gateway_host_audience_identity_unavailable");
    return match[1]!;
  }

  if (platform === "darwin") {
    const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024,
    });
    if (result.status !== 0 || result.error) throw new Error("gateway_host_audience_identity_unavailable");
    const match = /^\s*"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"\s*$/im.exec(result.stdout);
    if (!match) throw new Error("gateway_host_audience_identity_unavailable");
    return match[1]!;
  }

  throw new Error("gateway_host_audience_identity_unavailable");
}

export function isHostAudienceDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
