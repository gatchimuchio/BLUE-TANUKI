import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseHardeningEvidenceSource = readonly ["CONFIG"];

export interface ReleaseHardeningOptions {
  requireSigning?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ReleaseHardeningReport {
  status: "pass_pre_signing_blocked";
  github_actions_workflows_present: boolean;
  github_actions_workflows_manual_dispatch_only: true;
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

function workflowPolicyFailure(file: string, reason: string): never {
  throw new Error(`GitHub Actions workflow policy failed: ${file}: ${reason}`);
}

function isBlankOrComment(line: string): boolean {
  return line.trim() === "" || line.trimStart().startsWith("#");
}

function topLevelBlock(lines: readonly string[], key: string, file: string): number {
  const matches = lines.flatMap((line, index) =>
    new RegExp(`^${key}\\s*:\\s*(?:#.*)?$`).test(line) ? [index] : [],
  );
  if (matches.length !== 1) {
    workflowPolicyFailure(file, `expected exactly one block-style top-level ${key}: key`);
  }
  return matches[0]!;
}

function blockEnd(lines: readonly string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!isBlankOrComment(line) && !/^\s/.test(line)) return index;
  }
  return lines.length;
}

function assertManualDispatchOnly(lines: readonly string[], file: string): void {
  if (lines.some((line) => line.includes("\t"))) {
    workflowPolicyFailure(file, "tabs are not supported in workflow policy declarations");
  }

  const onIndex = topLevelBlock(lines, "on", file);
  const onEnd = blockEnd(lines, onIndex);
  const events: string[] = [];
  for (let index = onIndex + 1; index < onEnd; index += 1) {
    const line = lines[index]!;
    if (isBlankOrComment(line)) continue;
    const match = /^  ([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/.exec(line);
    if (!match) {
      workflowPolicyFailure(file, "unsupported trigger syntax; use a block mapping with workflow_dispatch only");
    }
    events.push(match[1]!);
  }
  if (events.length !== 1 || events[0] !== "workflow_dispatch") {
    workflowPolicyFailure(
      file,
      `only workflow_dispatch is allowed; found ${events.length === 0 ? "no trigger" : events.join(", ")}`,
    );
  }
}

function assertReadOnlyWorkflowPermissions(lines: readonly string[], file: string): void {
  const permissionsIndex = topLevelBlock(lines, "permissions", file);
  const permissionsEnd = blockEnd(lines, permissionsIndex);
  const scopes = new Set<string>();
  const allowedScopes = new Set([
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
  ]);

  for (let index = permissionsIndex + 1; index < permissionsEnd; index += 1) {
    const line = lines[index]!;
    if (isBlankOrComment(line)) continue;
    const match = /^  ([A-Za-z0-9_-]+)\s*:\s*(read|none)\s*(?:#.*)?$/.exec(line);
    if (!match) {
      workflowPolicyFailure(file, "permissions must be a block mapping containing only read or none values");
    }
    const scope = match[1]!;
    if (!allowedScopes.has(scope)) workflowPolicyFailure(file, `unknown token permission scope: ${scope}`);
    if (scopes.has(scope)) workflowPolicyFailure(file, `duplicate token permission scope: ${scope}`);
    scopes.add(scope);
  }
  if (scopes.size === 0) workflowPolicyFailure(file, "explicit read-only token permissions are required");

  const jobsIndex = lines.findIndex((line) => /^jobs\s*:\s*(?:#.*)?$/.test(line));
  if (jobsIndex >= 0) {
    const jobsEnd = blockEnd(lines, jobsIndex);
    for (let index = jobsIndex + 1; index < jobsEnd; index += 1) {
      if (/^\s+permissions\s*:/.test(lines[index]!)) {
        workflowPolicyFailure(file, "job-level permissions are not allowed; use the workflow-level read-only policy");
      }
    }
  }
}

/**
 * Validate the repository's deliberately narrow GitHub Actions policy.
 * The supported YAML subset is fail-closed: manual workflow_dispatch only,
 * explicit workflow-level read/none token permissions, and no job overrides.
 */
export function validateGitHubActionsWorkflows(root: string): readonly string[] {
  const workflowsDir = path.join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) return [];
  const workflowFiles = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  for (const name of workflowFiles) {
    const filePath = path.join(workflowsDir, name);
    if (!lstatSync(filePath).isFile()) workflowPolicyFailure(name, "workflow file must be a regular file");
    const lines = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    assertManualDispatchOnly(lines, name);
    assertReadOnlyWorkflowPermissions(lines, name);
  }
  return workflowFiles;
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
    "GitHub Actions is a manually dispatched auxiliary",
    "workflow_dispatch only",
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
  const workflows = validateGitHubActionsWorkflows(root);
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
    github_actions_workflows_present: workflows.length > 0,
    github_actions_workflows_manual_dispatch_only: true,
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
  process.stdout.write(`github_actions_workflows_present=${report.github_actions_workflows_present}\n`);
  process.stdout.write("github_actions_workflows_manual_dispatch_only=true\n");
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
