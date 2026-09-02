import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SOFTWARE_LICENSE = "Apache-2.0";
const DOCUMENTATION_LICENSE = "CC-BY-4.0";
const APACHE_2_TEXT_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";
const EXCLUDED_DIRECTORIES = new Set([
  ".codex-tmp",
  ".git",
  "coverage",
  "node_modules",
  "release",
]);

export interface LicensingGateReport {
  status: "pass";
  software_license: "Apache-2.0";
  documentation_license: "CC-BY-4.0";
  package_manifests: number;
  apache_text_sha256: string;
}

function fail(message: string): never {
  throw new Error(`licensing gate failed: ${message}`);
}

function readRequired(root: string, rel: string): string {
  const fullPath = path.join(root, rel);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    fail(`必須ファイルが存在しない: ${rel}`);
  }
  return readFileSync(fullPath, "utf8");
}

function requireIncludes(rel: string, text: string, needle: string): void {
  if (!text.includes(needle)) fail(`${rel}: 必須記述を欠く: ${needle}`);
}

function packageManifestPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name === "package.json") {
        paths.push(path.relative(root, path.join(directory, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  visit(root);
  return paths.sort();
}

function assertPackageLicenses(root: string): number {
  const manifests = packageManifestPaths(root);
  if (manifests.length === 0) fail("package.json が存在しない");
  for (const rel of manifests) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readRequired(root, rel));
    } catch (error) {
      fail(`${rel}: JSON を解析できない: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${rel}: JSON object ではない`);
    }
    const license = (parsed as { license?: unknown }).license;
    if (license !== SOFTWARE_LICENSE) {
      fail(`${rel}: license は ${SOFTWARE_LICENSE} でなければならない（観測値=${String(license)}）`);
    }
  }
  return manifests.length;
}

export function validateLicensing(rootDir = process.cwd()): LicensingGateReport {
  const root = path.resolve(rootDir);
  const scope = readRequired(root, "LICENSE");
  for (const needle of [
    "成果物の種類ごとにライセンスを分離",
    "デュアルライセンスではない",
    "LICENSE-APACHE-2.0",
    "LICENSE-CC-BY-4.0",
    "MIT License",
    "第三者由来",
  ]) {
    requireIncludes("LICENSE", scope, needle);
  }

  const apacheText = readRequired(root, "LICENSE-APACHE-2.0");
  const apacheTextSha256 = createHash("sha256").update(apacheText).digest("hex");
  if (apacheTextSha256 !== APACHE_2_TEXT_SHA256) {
    fail(`LICENSE-APACHE-2.0: 法的原文の sha256 が不一致（観測値=${apacheTextSha256}）`);
  }

  const ccText = readRequired(root, "LICENSE-CC-BY-4.0");
  for (const needle of [
    `SPDX-License-Identifier: ${DOCUMENTATION_LICENSE}`,
    "https://creativecommons.org/licenses/by/4.0/legalcode",
    "https://creativecommons.org/licenses/by/4.0/deed.ja",
    "正式な法的条件が優先",
  ]) {
    requireIncludes("LICENSE-CC-BY-4.0", ccText, needle);
  }

  const notice = readRequired(root, "NOTICE");
  for (const needle of [
    "BLUE-TANUKI",
    SOFTWARE_LICENSE,
    DOCUMENTATION_LICENSE,
    "デュアルライセンスではない",
    "第三者由来",
  ]) {
    requireIncludes("NOTICE", notice, needle);
  }

  const readme = readRequired(root, "README.md");
  for (const needle of [
    "[LICENSE](LICENSE)",
    "[LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)",
    "[LICENSE-CC-BY-4.0](LICENSE-CC-BY-4.0)",
    "[NOTICE](NOTICE)",
  ]) {
    requireIncludes("README.md", readme, needle);
  }

  return {
    status: "pass",
    software_license: SOFTWARE_LICENSE,
    documentation_license: DOCUMENTATION_LICENSE,
    package_manifests: assertPackageLicenses(root),
    apache_text_sha256: apacheTextSha256,
  };
}

function main(): void {
  const report = validateLicensing();
  process.stdout.write("licensing=pass\n");
  process.stdout.write(`software_license=${report.software_license}\n`);
  process.stdout.write(`documentation_license=${report.documentation_license}\n`);
  process.stdout.write(`package_manifests=${report.package_manifests}\n`);
  process.stdout.write(`apache_text_sha256=${report.apache_text_sha256}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
