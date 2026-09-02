import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseHardeningEvidenceSource = readonly ["CONFIG"];

export interface ReleaseHardeningOptions {
  requireSigning?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ReleaseHardeningReport {
  status: "pass_pre_signing_blocked";
  github_actions_workflows_present: false;
  local_release_validation_commands_present: true;
  signed_native_installer_status:
    | "blocked_missing_credentials"
    | "credentials_configured_static_only";
  automatic_updater_status: "manual_update_only";
  runtime_auto_apply_available: false;
  evidence_source: ReleaseHardeningEvidenceSource;
  missing_signing_credentials: readonly string[];
}

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

function assertNoGitHubActionsWorkflows(root: string): void {
  const workflowsDir = path.join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) return;
  const workflowFiles = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  if (workflowFiles.length > 0) {
    fail(`GitHub Actions workflows must be absent; found ${workflowFiles.join(", ")}`);
  }
}

function assertLocalReleaseValidationCommands(root: string): void {
  const packageJson = read(root, "package.json");
  for (const scriptName of [
    "typecheck",
    "build",
    "test",
    "docs:check",
    "validate:japanese-base",
    "validate:licensing",
    "validate:repo-health",
    "validate:packaging",
    "validate:release-hardening",
    "validate:channels",
    "validate:ga",
    "validate:product",
    "plugin:review",
    "doctor",
    "smoke:serve",
    "smoke:resume",
    "smoke:live",
    "smoke:windows-installed",
    "smoke:linux-installed",
    "smoke:macos-installed",
    "release:bundle",
    "release:verify",
  ]) {
    requireIncludes("package.json", packageJson, `"${scriptName}"`);
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
    "GitHub Actions workflows are intentionally absent",
    "local release validation",
    "--require-signing",
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
  requireIncludes("scripts/verify_release_bundle.ts", verifyBundle, "validate:licensing");
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
  assertNoGitHubActionsWorkflows(root);
  assertLocalReleaseValidationCommands(root);
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
    github_actions_workflows_present: false,
    local_release_validation_commands_present: true,
    signed_native_installer_status:
      missing.length === 0 ? "credentials_configured_static_only" : "blocked_missing_credentials",
    automatic_updater_status: "manual_update_only",
    runtime_auto_apply_available: false,
    evidence_source: ["CONFIG"],
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
  process.stdout.write("github_actions_workflows_present=false\n");
  process.stdout.write("local_release_validation_commands_present=true\n");
  process.stdout.write(
    `signed_native_installer_status=${report.signed_native_installer_status}\n`,
  );
  process.stdout.write("automatic_updater_status=manual_update_only\n");
  process.stdout.write("runtime_auto_apply_available=false\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
