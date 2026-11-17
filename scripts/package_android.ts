import { constants, lstatSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  androidReleaseDirectory,
  androidRoot,
  assertSafeAndroidReleaseDirectory,
  packageManifestPath,
  readAndroidBuildIdentity,
  regularFileSize,
  sha256File,
  sourceCommit,
  validateManifestAgainstSource,
  workspaceRoot,
  type AndroidArtifact,
  type AndroidPackageManifest,
} from "./android_package_common.js";

function runGradleReleaseBuild(): void {
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", "gradlew.bat :app:assembleRelease :app:bundleRelease --no-daemon"],
          { cwd: androidRoot, stdio: "inherit", windowsHide: true },
        )
      : spawnSync(
          "sh",
          ["./gradlew", ":app:assembleRelease", ":app:bundleRelease", "--no-daemon"],
          { cwd: androidRoot, stdio: "inherit" },
        );
  if (result.error) throw new Error("Android Gradle release build could not start: " + result.error.message);
  if (result.status !== 0) throw new Error("Android Gradle release build failed with exit code " + String(result.status));
}

function assertAbsentOrSame(file: string, expectedSha256: string): boolean {
  try {
    const size = regularFileSize(file);
    if (size < 1 || sha256File(file) !== expectedSha256) {
      throw new Error("refusing to replace a different existing Android package artifact: " + file);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing to replace")) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function preserveOrCopy(source: string, destination: string, expectedSha256: string): Promise<AndroidArtifact> {
  if (!assertAbsentOrSame(destination, expectedSha256)) await copyFile(source, destination, constants.COPYFILE_EXCL);
  return {
    file: path.basename(destination),
    size_bytes: regularFileSize(destination),
    sha256: sha256File(destination),
  };
}

async function ensureSafeOutputDirectory(): Promise<void> {
  const outputDirectories = [path.join(workspaceRoot, "release"), androidReleaseDirectory];
  for (const directory of outputDirectories) {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("refusing an Android package output path that is not a regular directory: " + directory);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await mkdir(directory);
      } else {
        throw error;
      }
    }
  }
  assertSafeAndroidReleaseDirectory();
}

async function main(): Promise<void> {
  const identity = readAndroidBuildIdentity();
  await ensureSafeOutputDirectory();
  runGradleReleaseBuild();

  const apkSource = path.join(androidRoot, "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk");
  const aabSource = path.join(androidRoot, "app", "build", "outputs", "bundle", "release", "app-release.aab");
  const apkSourceSize = regularFileSize(apkSource);
  const aabSourceSize = regularFileSize(aabSource);
  if (apkSourceSize < 1 || aabSourceSize < 1) throw new Error("Android Gradle release outputs are empty");

  const apkName = identity.stem + "-unsigned.apk";
  const aabName = identity.stem + "-unsigned.aab";
  const apkSha256 = sha256File(apkSource);
  const aabSha256 = sha256File(aabSource);
  const apk = await preserveOrCopy(apkSource, path.join(androidReleaseDirectory, apkName), apkSha256);
  const aab = await preserveOrCopy(aabSource, path.join(androidReleaseDirectory, aabName), aabSha256);
  const manifest: AndroidPackageManifest = {
    schema_version: 1,
    name: "blue-tanuki-android",
    version: identity.versionName,
    version_code: identity.versionCode,
    package_type: "android-native-release-source-build",
    source_commit: sourceCommit(),
    source_sha256: identity.sourceSha256,
    application_id: identity.applicationId,
    min_sdk: identity.minSdk,
    target_sdk: identity.targetSdk,
    compile_sdk: identity.compileSdk,
    artifacts: { apk, aab },
    boundaries: {
      release_signing_config_present: false,
      store_submission: "not_submitted_by_builder",
      install_or_runtime_verified: false,
      secrets_review: "not_performed",
      hds_authority_modified: false,
      external_write_capability_added: false,
    },
  };
  const manifestFile = packageManifestPath(identity);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try {
    const manifestStat = lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error("refusing a non-regular Android package manifest: " + manifestFile);
    }
    const existingBytes = await readFile(manifestFile);
    if (!existingBytes.equals(manifestBytes)) {
      const existingManifest = JSON.parse(existingBytes.toString("utf8")) as AndroidPackageManifest;
      const normalized = { ...existingManifest, source_commit: manifest.source_commit };
      validateManifestAgainstSource(normalized, identity);
      if (JSON.stringify(normalized) !== JSON.stringify(manifest)) {
        throw new Error("refusing to replace a different Android package manifest: " + manifestFile);
      }
      await writeFile(manifestFile, manifestBytes);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing to replace")) throw error;
    if (error instanceof Error && error.message.startsWith("refusing a non-regular")) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeFile(manifestFile, manifestBytes, { flag: "wx" });
    } else {
      throw error;
    }
  }
  process.stdout.write("Android unsigned source packages created:\n");
  process.stdout.write("  APK: " + path.join(androidReleaseDirectory, apkName) + " (" + apk.size_bytes + " bytes, SHA-256 " + apk.sha256 + ")\n");
  process.stdout.write("  AAB: " + path.join(androidReleaseDirectory, aabName) + " (" + aab.size_bytes + " bytes, SHA-256 " + aab.sha256 + ")\n");
  process.stdout.write("  Manifest: " + manifestFile + "\n");
  process.stdout.write("Signing, store submission, install, and runtime verification were not performed.\n");
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
