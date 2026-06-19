import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseHardeningEvidenceSource = readonly ["CONFIG", "EXTERNAL_EVIDENCE"];

export interface ReleaseHardeningOptions {
  requireSigning?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ReleaseHardeningReport {
  status: "pass_pre_signing_blocked";
  ci_node20_deprecated_actions_present: false;
  signed_native_installer_status:
    | "blocked_missing_credentials"
    | "credentials_configured_static_only";
  automatic_updater_status: "manual_update_only";
  runtime_auto_apply_available: false;
  evidence_source: ReleaseHardeningEvidenceSource;
  missing_signing_credentials: readonly string[];
}

const ACTION_MAJOR_REQUIREMENTS = [
  { action: "actions/checkout", minimumMajor: 7 },
  { action: "actions/setup-node", minimumMajor: 6 },
  { action: "pnpm/action-setup", minimumMajor: 6 },
  { action: "actions/upload-artifact", minimumMajor: 7 },
] as const;

const SIGNING_CREDENTIALS = [
  "BLUE_TANUKI_WINDOWS_SIGNING_CERT_PFX",
  "BLUE_TANUKI_WINDOWS_SIGNING_CERT_PASSWORD",
  "APPLE_DEVELOPER_ID_APPLICATION",
  "APPLE_DEVELOPER_ID_INSTALLER",
  "APPLE_NOTARIZATION_APPLE_ID",
  "APPLE_NOTARIZATION_TEAM_ID",
  "APPLE_NOTARIZATION_PASSWORD",
  "BLUE_TANUKI_LINUX_GPG_PRIVATE_KEY",
  "BLUE_TANUKI_LINUX_GPG_KEY_ID",
] as const;

function read(root: string, rel: string): string {
  const fullPath = path.join(root, rel);
  if (!existsSync(fullPath)) {
    throw new Error(`release hardening gate failed: missing required file: ${rel}`);
  }
  return readFileSync(fullPath, "utf8");
}

function fail(message: string): never {
  throw new Error(`release hardening gate failed: ${message}`);
}

function requireIncludes(file: string, text: string, needle: string): void {
  if (!text.includes(needle)) fail(`${file}: missing required text: ${needle}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actionMajors(workflow: string, action: string): number[] {
  const pattern = new RegExp(
    String.raw`uses:\s*${escapeRegExp(action)}@v?(\d+)(?:\b|[.\-])`,
    "gi",
  );
  const majors: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(workflow)) !== null) {
    const rawMajor = match[1];
    if (!rawMajor) continue;
    majors.push(Number.parseInt(rawMajor, 10));
  }
  return majors;
}

function assertWorkflowActionsCurrent(root: string): void {
  const workflow = read(root, ".github/workflows/ci.yml");
  requireIncludes(".github/workflows/ci.yml", workflow, "pnpm validate:release-hardening");
  for (const { action, minimumMajor } of ACTION_MAJOR_REQUIREMENTS) {
    const majors = actionMajors(workflow, action);
    if (majors.length === 0) fail(`.github/workflows/ci.yml: missing ${action}`);
    const deprecated = majors.filter((major) => major < minimumMajor);
    if (deprecated.length > 0) {
      fail(
        `.github/workflows/ci.yml: ${action} must be v${minimumMajor}+; found ${deprecated.join(", ")}`,
      );
    }
  }
}

function assertInstallerBoundary(root: string): void {
  const productInstallers = read(root, "scripts/package_product_installers.ts");
  requireIncludes("scripts/package_product_installers.ts", productInstallers, "unsigned_installer: true");
  requireIncludes(
    "scripts/package_product_installers.ts",
    productInstallers,
    "signed_native_installer: false",
  );
  requireIncludes(
    "scripts/package_product_installers.ts",
    productInstallers,
    "requires_node_pnpm_git_from_user: false",
  );
  requireIncludes(
    "scripts/package_product_installers.ts",
    productInstallers,
    "requires_manual_nested_extraction: false",
  );
}

function assertUpdaterBoundary(root: string): void {
  const updateSurface = read(root, "apps/gateway/src/update_surface.ts");
  requireIncludes(
    "apps/gateway/src/update_surface.ts",
    updateSurface,
    "automatic_updater_shipped: false",
  );
  requireIncludes(
    "apps/gateway/src/update_surface.ts",
    updateSurface,
    "runtime_auto_apply_available: false",
  );
  requireIncludes("apps/gateway/src/update_surface.ts", updateSurface, "manual_update_only: true");
}

function assertDocs(root: string): void {
  const doc = read(root, "docs/RELEASE_HARDENING.md");
  for (const needle of [
    "CONFIG",
    "EXTERNAL_EVIDENCE",
    "blocked_missing_credentials",
    "manual_update_only",
    "runtime_auto_apply_available=false",
    "signed native installer",
    "automatic updater",
    "--require-signing",
    "actions/checkout@v7",
    "actions/setup-node@v6",
    "pnpm/action-setup@v6",
    "actions/upload-artifact@v7",
    ...SIGNING_CREDENTIALS,
  ]) {
    requireIncludes("docs/RELEASE_HARDENING.md", doc, needle);
  }
}

function assertPackageScript(root: string): void {
  const packageJson = read(root, "package.json");
  requireIncludes("package.json", packageJson, "\"validate:release-hardening\"");
  requireIncludes("package.json", packageJson, "tsx scripts/release_hardening_gate.ts");
}

function assertReleaseBundleIncludesGate(root: string): void {
  const createBundle = read(root, "scripts/create_release_bundle.ts");
  const verifyBundle = read(root, "scripts/verify_release_bundle.ts");
  for (const required of ["docs/RELEASE_HARDENING.md", "scripts/release_hardening_gate.ts"]) {
    requireIncludes("scripts/create_release_bundle.ts", createBundle, required);
    requireIncludes("scripts/verify_release_bundle.ts", verifyBundle, required);
  }
  requireIncludes(
    "scripts/verify_release_bundle.ts",
    verifyBundle,
    "validate:release-hardening",
  );
}

function missingSigningCredentials(env: NodeJS.ProcessEnv): string[] {
  return SIGNING_CREDENTIALS.filter((name) => !env[name] || env[name]?.trim() === "");
}

export function validateReleaseHardeningGate(
  rootDir = process.cwd(),
  options: ReleaseHardeningOptions = {},
): ReleaseHardeningReport {
  const root = path.resolve(rootDir);
  const env = options.env ?? process.env;
  assertWorkflowActionsCurrent(root);
  assertInstallerBoundary(root);
  assertUpdaterBoundary(root);
  assertDocs(root);
  assertPackageScript(root);
  assertReleaseBundleIncludesGate(root);

  const missing = missingSigningCredentials(env);
  if (options.requireSigning && missing.length > 0) {
    fail(`signed native installer credentials missing: ${missing.join(", ")}`);
  }

  return {
    status: "pass_pre_signing_blocked",
    ci_node20_deprecated_actions_present: false,
    signed_native_installer_status:
      missing.length === 0 ? "credentials_configured_static_only" : "blocked_missing_credentials",
    automatic_updater_status: "manual_update_only",
    runtime_auto_apply_available: false,
    evidence_source: ["CONFIG", "EXTERNAL_EVIDENCE"],
    missing_signing_credentials: missing,
  };
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function main(): void {
  const report = validateReleaseHardeningGate(process.cwd(), {
    requireSigning: hasArg("--require-signing"),
  });
  process.stdout.write("release_hardening=pass_pre_signing_blocked\n");
  process.stdout.write("ci_node20_deprecated_actions_present=false\n");
  process.stdout.write(
    `signed_native_installer_status=${report.signed_native_installer_status}\n`,
  );
  process.stdout.write("automatic_updater_status=manual_update_only\n");
  process.stdout.write("runtime_auto_apply_available=false\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
