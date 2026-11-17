import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  androidReleaseDirectory,
  assertSafeAndroidReleaseDirectory,
  packageManifestPath,
  readAndroidBuildIdentity,
  regularFileSize,
  sha256File,
  validateManifestAgainstSource,
  verifyZipEntries,
  type AndroidPackageManifest,
} from "./android_package_common.js";

function assertArtifact(
  label: "apk" | "aab",
  file: string,
  expectedName: string,
  expectedEntries: readonly string[],
): void {
  if (path.basename(file) !== expectedName || path.dirname(path.resolve(file)) !== path.resolve(androidReleaseDirectory)) {
    throw new Error("Android " + label.toUpperCase() + " manifest path is outside the package output or has an unexpected name");
  }
  const size = regularFileSize(file);
  if (size < 1) throw new Error("Android " + label.toUpperCase() + " is empty");
  const entries = verifyZipEntries(file);
  for (const required of expectedEntries) {
    if (!entries.includes(required)) throw new Error("Android " + label.toUpperCase() + " is missing ZIP entry " + required);
  }
  const signedEntries = entries.filter((entry) => /^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/iu.test(entry));
  if (signedEntries.length > 0) throw new Error("Android " + label.toUpperCase() + " unexpectedly contains JAR signing entries");
}

async function main(): Promise<void> {
  assertSafeAndroidReleaseDirectory();
  const identity = readAndroidBuildIdentity();
  const manifestFile = packageManifestPath(identity);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as AndroidPackageManifest;
  validateManifestAgainstSource(manifest, identity);
  const apkName = identity.stem + "-unsigned.apk";
  const aabName = identity.stem + "-unsigned.aab";
  const apkFile = path.join(androidReleaseDirectory, apkName);
  const aabFile = path.join(androidReleaseDirectory, aabName);
  assertArtifact("apk", apkFile, apkName, ["AndroidManifest.xml", "classes.dex"]);
  assertArtifact("aab", aabFile, aabName, ["base/manifest/AndroidManifest.xml", "base/dex/classes.dex"]);

  for (const [label, file, artifact] of [
    ["APK", apkFile, manifest.artifacts.apk],
    ["AAB", aabFile, manifest.artifacts.aab],
  ] as const) {
    if (artifact.file !== path.basename(file) || artifact.size_bytes !== regularFileSize(file) || artifact.sha256 !== sha256File(file)) {
      throw new Error("Android " + label + " does not match its source-bound manifest");
    }
    process.stdout.write(label + " package verified: " + artifact.file + " (" + artifact.size_bytes + " bytes, SHA-256 " + artifact.sha256 + ")\n");
  }
  process.stdout.write("Package structure and source-bound manifest are valid. Signing, store readiness, installation, and runtime remain unverified.\n");
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
