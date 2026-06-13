import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface EvidenceManifest {
  schema_version: 1;
  generated_at: string;
  manifest_excludes_self: true;
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

export async function writeEvidenceManifest(
  evidenceDir: string,
): Promise<EvidenceManifest> {
  const files = await listEvidenceFiles(evidenceDir);
  const entries: EvidenceManifest["files"] = [];
  for (const file of files) {
    const rel = path.relative(evidenceDir, file).replace(/\\/g, "/");
    if (rel === "manifest.json") continue;
    const buf = await readFile(file);
    entries.push({
      path: rel,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.byteLength,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: EvidenceManifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    manifest_excludes_self: true,
    files: entries,
  };
  await writeFile(
    path.join(evidenceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function listEvidenceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listEvidenceFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}
