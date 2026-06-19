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

function workflow(actionMajorOverrides: Record<string, string> = {}): string {
  const checkout = actionMajorOverrides.checkout ?? "v7";
  const pnpm = actionMajorOverrides.pnpm ?? "v6";
  const setupNode = actionMajorOverrides.setupNode ?? "v6";
  const uploadArtifact = actionMajorOverrides.uploadArtifact ?? "v7";
  return [
    "name: CI",
    "jobs:",
    "  verify:",
    "    steps:",
    `      - uses: actions/checkout@${checkout}`,
    `      - uses: pnpm/action-setup@${pnpm}`,
    `      - uses: actions/setup-node@${setupNode}`,
    "      - run: pnpm validate:release-hardening",
    "  windows-product:",
    "    steps:",
    `      - uses: actions/upload-artifact@${uploadArtifact}`,
  ].join("\n");
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
    "--require-signing",
    "actions/checkout@v7",
    "actions/setup-node@v6",
    "pnpm/action-setup@v6",
    "actions/upload-artifact@v7",
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
  workflow?: string;
  updateSurface?: string;
  env?: Record<string, string>;
} = {}): Promise<Record<string, string>> {
  await writeFile(
    "package.json",
    JSON.stringify({
      scripts: {
        "validate:release-hardening": "tsx scripts/release_hardening_gate.ts",
      },
    }, null, 2),
  );
  await writeFile(".github/workflows/ci.yml", opts.workflow ?? workflow());
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
      ci_node20_deprecated_actions_present: false,
      signed_native_installer_status: "blocked_missing_credentials",
      automatic_updater_status: "manual_update_only",
      runtime_auto_apply_available: false,
    });
  });

  it("rejects Node 20-deprecated action majors", async () => {
    await writeFixture({
      workflow: workflow({ checkout: "v4", setupNode: "v4", pnpm: "v4", uploadArtifact: "v4" }),
    });

    expect(() => validateReleaseHardeningGate(root, { env: {} })).toThrow(/actions\/checkout/);
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
