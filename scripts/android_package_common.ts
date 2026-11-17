import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const androidRoot = path.join(workspaceRoot, "apps", "mobile-android");
export const androidGradleFile = path.join(androidRoot, "app", "build.gradle");
export const androidReleaseDirectory = path.join(workspaceRoot, "release", "android");

export interface AndroidBuildIdentity {
  applicationId: string;
  versionCode: number;
  versionName: string;
  minSdk: number;
  targetSdk: number;
  compileSdk: number;
  sourceCommit: string;
  sourceSha256: string;
  stem: string;
}

export interface AndroidArtifact {
  file: string;
  size_bytes: number;
  sha256: string;
}

export interface AndroidPackageManifest {
  schema_version: 1;
  name: "blue-tanuki-android";
  version: string;
  version_code: number;
  package_type: "android-native-release-source-build";
  source_commit: string;
  source_sha256: string;
  application_id: string;
  min_sdk: number;
  target_sdk: number;
  compile_sdk: number;
  artifacts: {
    apk: AndroidArtifact;
    aab: AndroidArtifact;
  };
  boundaries: {
    release_signing_config_present: false;
    store_submission: "not_submitted_by_builder";
    install_or_runtime_verified: false;
    secrets_review: "not_performed";
    hds_authority_modified: false;
    external_write_capability_added: false;
  };
}

function gradleString(source: string, name: string): string {
  const match = source.match(new RegExp("^\\s*" + name + "\\s+['\"]([^'\"]+)['\"]", "m"));
  if (!match?.[1]) throw new Error("Android Gradle configuration is missing " + name);
  return match[1];
}

function gradleNumber(source: string, name: string): number {
  const match = source.match(new RegExp("^\\s*" + name + "\\s+(\\d+)", "m"));
  if (!match?.[1]) throw new Error("Android Gradle configuration is missing " + name);
  return Number(match[1]);
}

function sourceFiles(directory: string, relativeDirectory = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    if (
      entry.name === ".gradle" ||
      entry.name === "build" ||
      entry.name === "local.properties" ||
      /\.(?:jks|keystore|p12|pfx|pem|key)$/iu.test(entry.name)
    ) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Android source tree contains an unsupported symbolic link: " + relative);
    if (entry.isDirectory()) {
      result.push(...sourceFiles(absolute, relative));
    } else if (entry.isFile()) {
      result.push(relative);
    } else {
      throw new Error("Android source tree contains an unsupported filesystem entry: " + relative);
    }
  }
  return result;
}

export function androidSourceSha256(): string {
  const hash = createHash("sha256");
  const files = [
    ...sourceFiles(androidRoot).map((relative) => "apps/mobile-android/" + relative),
    "package.json",
    "scripts/android_package_common.ts",
    "scripts/package_android.ts",
    "scripts/verify_android_package.ts",
  ].sort((a, b) => a.localeCompare(b, "en"));
  for (const relative of files) {
    hash.update(relative.replaceAll(path.sep, "/"), "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(path.join(workspaceRoot, relative)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function sourceCommit(): string {
  const result = spawnSync(
    "git",
    [
      "log",
      "-1",
      "--format=%H",
      "--",
      "apps/mobile-android",
      "package.json",
      "scripts/android_package_common.ts",
      "scripts/package_android.ts",
      "scripts/verify_android_package.ts",
    ],
    { cwd: workspaceRoot, encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error("cannot determine Android package source commit: " + (result.error?.message ?? result.stderr));
  }
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/iu.test(commit)) throw new Error("Git returned an invalid source commit");
  return commit.toLowerCase();
}

export function readAndroidBuildIdentity(): AndroidBuildIdentity {
  const gradle = readFileSync(androidGradleFile, "utf8");
  const applicationId = gradleString(gradle, "applicationId");
  const versionName = gradleString(gradle, "versionName");
  if (!/^[A-Za-z0-9._-]+$/u.test(versionName)) throw new Error("Android versionName cannot be used in an artifact name");
  if (/\bsigningConfig\b/u.test(gradle)) {
    throw new Error("Android release signing configuration is present; unsigned package builder refuses to continue");
  }
  const sourceCommitValue = sourceCommit();
  const sourceSha256 = androidSourceSha256();
  return {
    applicationId,
    versionCode: gradleNumber(gradle, "versionCode"),
    versionName,
    minSdk: gradleNumber(gradle, "minSdk"),
    targetSdk: gradleNumber(gradle, "targetSdk"),
    compileSdk: gradleNumber(gradle, "compileSdk"),
    sourceCommit: sourceCommitValue,
    sourceSha256,
    stem: "blue-tanuki-android-" + versionName + "-" + sourceSha256.slice(0, 16),
  };
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

export function regularFileSize(file: string): number {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error("expected a regular Android package file: " + file);
  return stat.size;
}

export function packageManifestPath(identity = readAndroidBuildIdentity()): string {
  return path.join(androidReleaseDirectory, identity.stem + ".manifest.json");
}

export function assertSafeAndroidReleaseDirectory(): void {
  const relative = path.relative(workspaceRoot, androidReleaseDirectory);
  if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Android package output directory escapes the workspace");
  }
  for (const directory of [path.join(workspaceRoot, "release"), androidReleaseDirectory]) {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("Android package output directory does not exist: " + directory);
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Android package output path contains a non-directory or symbolic link: " + directory);
    }
  }
}

export function verifyZipEntries(file: string): string[] {
  const javaHome = process.env.JAVA_HOME;
  const jarName = process.platform === "win32" ? "jar.exe" : "jar";
  const javaJar = javaHome ? path.join(javaHome, "bin", jarName) : "";
  const jarCommand = javaJar && existsSync(javaJar) ? javaJar : "jar";
  const result = spawnSync(jarCommand, ["tf", file], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Android package is not a readable ZIP/JAR: " + file + ": " + (result.error?.message ?? result.stderr));
  }
  return result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}

export function validateManifestAgainstSource(manifest: AndroidPackageManifest, identity: AndroidBuildIdentity): void {
  if (
    manifest.schema_version !== 1 ||
    manifest.name !== "blue-tanuki-android" ||
    manifest.version !== identity.versionName ||
    manifest.version_code !== identity.versionCode ||
    manifest.package_type !== "android-native-release-source-build"
  ) {
    throw new Error("Android package manifest identity does not match the current Gradle project");
  }
  if (manifest.source_commit !== identity.sourceCommit || manifest.source_sha256 !== identity.sourceSha256) {
    throw new Error("Android package manifest does not match the current source tree");
  }
  if (
    manifest.application_id !== identity.applicationId ||
    manifest.min_sdk !== identity.minSdk ||
    manifest.target_sdk !== identity.targetSdk ||
    manifest.compile_sdk !== identity.compileSdk
  ) {
    throw new Error("Android package manifest platform metadata does not match the current Gradle project");
  }
  if (
    manifest.boundaries?.release_signing_config_present !== false ||
    manifest.boundaries?.store_submission !== "not_submitted_by_builder" ||
    manifest.boundaries?.install_or_runtime_verified !== false ||
    manifest.boundaries?.secrets_review !== "not_performed" ||
    manifest.boundaries?.hds_authority_modified !== false ||
    manifest.boundaries?.external_write_capability_added !== false
  ) {
    throw new Error("Android package manifest boundary declaration is invalid");
  }
}
