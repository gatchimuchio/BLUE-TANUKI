import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateReleaseHardeningGate } from "../../../scripts/release_hardening_gate.ts";

let root: string;

async function writeFile(rel: string, text: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
}

function releaseHardeningDoc(): string {
  return [
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
    "BLUE_TANUKI_WINDOWS_SIGNING_CERT_PFX",
    "BLUE_TANUKI_WINDOWS_SIGNING_CERT_PASSWORD",
    "APPLE_DEVELOPER_ID_APPLICATION",
    "APPLE_DEVELOPER_ID_INSTALLER",
    "APPLE_NOTARIZATION_APPLE_ID",
    "APPLE_NOTARIZATION_TEAM_ID",
    "APPLE_NOTARIZATION_PASSWORD",
    "BLUE_TANUKI_LINUX_GPG_PRIVATE_KEY",
    "BLUE_TANUKI_LINUX_GPG_KEY_ID",
  ].join("\n");
}

async function writeFixture(opts: {
  updateSurface?: string;
  env?: Record<string, string>;
  workflow?: string;
} = {}): Promise<Record<string, string>> {
  await writeFile(
    "package.json",
    JSON.stringify({
      scripts: {
        typecheck: "node scripts/typecheck.mjs",
        build: "pnpm -r build",
        test: "node node_modules/vitest/vitest.mjs run",
        "docs:check": "node scripts/check_docs.mjs",
        "validate:japanese-base": "tsx scripts/japanese_base_gate.ts",
        "validate:licensing": "tsx scripts/licensing_gate.ts",
        "validate:repo-health": "tsx scripts/repo_health_gate.ts",
        "validate:packaging": "tsx scripts/validate_packaging.ts",
        "validate:release-hardening": "tsx scripts/release_hardening_gate.ts",
        "validate:channels": "tsx scripts/channel_promotion_gate.ts",
        "validate:ga": "tsx scripts/ga_promotion_gate.ts",
        "validate:product": "tsx scripts/validate_product.ts",
        "plugin:review": "tsx scripts/plugin_review_gate.ts",
        doctor: "pnpm --filter @blue-tanuki/gateway run doctor",
        "smoke:serve": "tsx scripts/smoke_serve.ts",
        "smoke:resume": "tsx scripts/smoke_resume.ts",
        "smoke:live": "tsx apps/gateway/src/smoke_live.ts",
        "smoke:windows-installed": "tsx scripts/smoke_windows_installed.ts",
        "smoke:linux-installed": "tsx scripts/smoke_unix_installed.ts --platform=linux",
        "smoke:macos-installed": "tsx scripts/smoke_unix_installed.ts --platform=macos",
        "release:bundle": "tsx scripts/create_release_bundle.ts",
        "release:verify": "tsx scripts/verify_release_bundle.ts",
      },
    }, null, 2),
  );
  await writeFile(
    "scripts/package_product_installers.ts",
    [
      "export const manifest = {",
      "  unsigned_installer: true,",
      "  signed_native_installer: false,",
      "  requires_node_pnpm_git_from_user: false,",
      "  requires_manual_nested_extraction: false,",
      "};",
    ].join("\n"),
  );
  await writeFile(
    "apps/gateway/src/update_surface.ts",
    opts.updateSurface ?? [
      "export const distribution = {",
      "  automatic_updater_shipped: false,",
      "  runtime_auto_apply_available: false,",
      "  manual_update_only: true,",
      "};",
    ].join("\n"),
  );
  await writeFile("docs/RELEASE_HARDENING.md", releaseHardeningDoc());
  if (opts.workflow !== undefined) {
    await writeFile(".github/workflows/manual.yml", opts.workflow);
  }
  await writeFile(
    "scripts/create_release_bundle.ts",
    [
      '"docs/RELEASE_HARDENING.md";',
      '"scripts/release_hardening_gate.ts";',
    ].join("\n"),
  );
  await writeFile(
    "scripts/verify_release_bundle.ts",
    [
      '"docs/RELEASE_HARDENING.md";',
      '"scripts/release_hardening_gate.ts";',
      '"validate:release-hardening";',
      '"validate:licensing";',
    ].join("\n"),
  );
  return opts.env ?? {};
}

describe("release hardening gate", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-release-hardening-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("passes the pre-signing release hardening boundary", async () => {
    const env = await writeFixture();

    const report = validateReleaseHardeningGate(root, { env });

    expect(report).toMatchObject({
      github_actions_workflows_present: false,
      github_actions_workflows_manual_dispatch_only: true,
      local_release_validation_commands_present: true,
      signed_native_installer_status: "blocked_missing_credentials",
      automatic_updater_status: "manual_update_only",
      runtime_auto_apply_available: false,
    });
  });

  it("allows the manual read-only workflow policy", async () => {
    const env = await writeFixture({
      workflow: [
        "name: Native Linux helper",
        "on:",
        "  workflow_dispatch:",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  verify:",
        "    runs-on: ubuntu-24.04",
      ].join("\n"),
    });

    expect(validateReleaseHardeningGate(root, { env })).toMatchObject({
      github_actions_workflows_present: true,
      github_actions_workflows_manual_dispatch_only: true,
    });
  });

  it.each([
    ["automatic push trigger", "name: CI\non:\n  push:\npermissions:\n  contents: read\n"],
    ["mixed manual and automatic triggers", "name: CI\non:\n  workflow_dispatch:\n  pull_request:\npermissions:\n  contents: read\n"],
    ["flow-style trigger list", "name: CI\non: [workflow_dispatch, push]\npermissions:\n  contents: read\n"],
    ["missing permissions", "name: CI\non:\n  workflow_dispatch:\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n"],
    ["write permission", "name: CI\non:\n  workflow_dispatch:\npermissions:\n  contents: write\n"],
    ["job-level permission override", "name: CI\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  verify:\n    permissions:\n      contents: write\n"],
  ])("rejects unsafe workflow policy: %s", async (_name, workflow) => {
    await writeFixture({ workflow });

    expect(() => validateReleaseHardeningGate(root, { env: {} })).toThrow(
      /GitHub Actions workflow policy failed/,
    );
  });

  it("fails closed when signing is required but credentials are missing", async () => {
    const env = await writeFixture();

    expect(() => validateReleaseHardeningGate(root, { env, requireSigning: true })).toThrow(
      /signed native installer credentials missing/,
    );
  });

  it("accepts require-signing only after every signing credential is configured", async () => {
    const env = await writeFixture({
      env: {
        BLUE_TANUKI_WINDOWS_SIGNING_CERT_PFX: "cert",
        BLUE_TANUKI_WINDOWS_SIGNING_CERT_PASSWORD: "password",
        APPLE_DEVELOPER_ID_APPLICATION: "app-id",
        APPLE_DEVELOPER_ID_INSTALLER: "installer-id",
        APPLE_NOTARIZATION_APPLE_ID: "apple-id",
        APPLE_NOTARIZATION_TEAM_ID: "team-id",
        APPLE_NOTARIZATION_PASSWORD: "notary-password",
        BLUE_TANUKI_LINUX_GPG_PRIVATE_KEY: "private-key",
        BLUE_TANUKI_LINUX_GPG_KEY_ID: "key-id",
      },
    });

    const report = validateReleaseHardeningGate(root, { env, requireSigning: true });

    expect(report.signed_native_installer_status).toBe("credentials_configured_static_only");
  });
});
