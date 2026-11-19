import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("downloadable product installer packages", () => {
  it("declares a release target for one-file normal-user installers", () => {
    const pkg = read("package.json");
    expect(pkg).toContain("\"package:installers\"");
    expect(pkg).toContain("\"package:installers:verify\"");
    expect(pkg).toContain("\"installer:product\"");
    expect(pkg).toContain("\"installer:product:verify\"");
  });

  it("wraps verified payload archives without exposing source-build work to users", () => {
    const pack = read("scripts/package_product_installers.ts");
    const verify = read("scripts/verify_product_installers.ts");
    for (const source of [pack, verify]) {
      expect(source).toContain("normal_user_runs_single_file");
      expect(source).toContain("requires_manual_nested_extraction");
      expect(source).toContain("requires_node_pnpm_git_from_user");
      expect(source).toContain("requires_source_build");
      expect(source).toContain("extracts_payload_internally");
      expect(source).toContain("launches_after_install_by_default");
      expect(source).toContain("signed_native_installer");
      expect(source).toContain("hds_authority_modified");
      expect(source).toContain("gui_shell_modified");
    }
    expect(pack).toContain("BlueTanukiSetup-${version}-windows-x64.cmd");
    expect(pack).toContain("BlueTanukiSetup-${version}-linux-x64.run");
    expect(pack).toContain("BlueTanukiSetup-${version}-macos-x64.command");
    expect(pack).toContain("BlueTanukiSetup-${version}-macos-arm64.command");
    expect(pack).toContain("__BLUE_TANUKI_INSTALLER_PAYLOAD_BASE64_BELOW__");
    expect(pack).toContain("Expand-Archive");
    expect(pack).toContain("tar -xzf");
    expect(verify).toContain("embedded payload sha256 mismatch");
    expect(verify).toContain("forbidden normal-user path text present");
  });

  it("documents product installers as the normal path and archives as payload/recovery", () => {
    for (const rel of [
      "README.md",
      "QUICKSTART.md",
      "install/README.md",
      "docs/INSTALLER_GUIDE.md",
    ]) {
      const text = read(rel);
      expect(text).toContain("BlueTanukiSetup-<version>-windows-x64.cmd");
      expect(text).toContain("BlueTanukiSetup-<version>-linux-x64.run");
      expect(text).toContain("BlueTanukiSetup-<version>-macos-<arch>.command");
      expect(text).toContain("normal user");
      expect(text).toContain("single-file");
      expect(text).toContain("payload/recovery");
      expect(text).toContain("signed native installer");
    }
  });

  it("blocks Unix packaged updates before app mutation and stops only for uninstall", () => {
    const setup = read("install/unix/product/BlueTanukiSetup.sh");
    const uninstall = read("install/unix/product/BlueTanukiUninstall.sh");
    const launcher = read("install/unix/product/BlueTanukiLauncher.sh");
    const updateGate = setup.indexOf("in-place product replacement is unsupported");
    const stageCreation = setup.indexOf('mkdir "$INSTALL_STAGE"');

    expect(launcher).toContain("process_identity_state");
    expect(launcher).toContain("list_owned_process_pids");
    expect(launcher).toContain("resident-watchdog");
    expect(launcher).toContain("did not stop within 10 seconds");
    expect(updateGate).toBeGreaterThanOrEqual(0);
    expect(stageCreation).toBeGreaterThan(updateGate);
    expect(setup.slice(updateGate)).not.toContain("resident-stop");
    expect(setup).toContain("assert_product_data_compatibility");
    expect(setup).toContain("write_product_data_compatibility_marker");
    expect(uninstall).toContain("resident shutdown was not confirmed");
    expect(setup).not.toMatch(/resident-stop[^\n]*\|\|\s*true/);
    expect(uninstall).not.toMatch(/resident-stop[^\n]*\|\|\s*true/);
    expect(uninstall).not.toContain("resident-autostart-disable");

    for (const rel of ["install/linux/install.sh", "install/macos/install.sh"]) {
      const sourceSetup = read(rel);
      expect(sourceSetup).toContain("blue-tanuki-product-data.json");
      expect(sourceSetup.indexOf("blue-tanuki-product-data.json")).toBeLessThan(sourceSetup.indexOf('rm -rf "$INSTALL_ROOT"'));
    }
  });

  it("keeps Unix runtime state under the retained data root", () => {
    const setup = read("install/unix/product/BlueTanukiSetup.sh");
    const launcher = read("install/unix/product/BlueTanukiLauncher.sh");

    expect(setup).toContain('printf \'STATE_ROOT=%s\\n\' "$(quote_sh "$DATA_ROOT/data")"');
    expect(launcher).toContain('STATE_ROOT="${STATE_ROOT:-$DATA_ROOT/data}"');
    expect(launcher).toContain('[ "$STATE_ROOT" = "$DATA_ROOT/data" ]');
    expect(launcher).toContain('BLUE_TANUKI_STATE_ROOT="$STATE_ROOT"');
    expect(launcher).toContain("export BLUE_TANUKI_STATE_ROOT");
  });

  it("connects macOS native recovery diagnosis to the installed read-only command", () => {
    const app = read("install/macos/app/BlueTanukiApp.swift");
    const pack = read("scripts/package_macos_app.ts");
    const launcher = read("install/unix/product/BlueTanukiLauncher.sh");
    const start = app.indexOf("@objc private func inspectRecovery()");
    const end = app.indexOf("private func confirmRecoveryReconciliation(", start);
    expect(pack).toContain('"install/macos/app/BlueTanukiApp.swift"');
    expect(app).toContain('makeButton("復旧診断", action: #selector(inspectRecovery))');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const action = app.slice(start, end);
    expect(action).toMatch(/validateInstalledProduct\(\)[\s\S]+arguments: \["recovery-inspect", "--json"\], captureOutput: true, accepting: \[0, 2\]/);
    expect(action).toContain('report.mode == "read_only"');
    expect(action).toContain("!report.used_for_authority, !report.may_execute");
    expect(action).toContain("exitCode == (report.status == .verified && report.runtime_recovery_fence.status == .clear ? 0 : 2)");
    expect(action).not.toMatch(/recovery-reconcile|resident-start|\.next_safe_action/);
    expect(launcher).toMatch(/recovery-inspect\)[\s\S]*?--recovery-inspect --env-file "\$ENV_FILE" "\$@"/);
  });

  it("binds macOS factory reset and goal-purpose repair to confirmed evidence and the offline CLI", () => {
    const app = read("install/macos/app/BlueTanukiApp.swift");
    const owner = read("apps/gateway/src/runtime_owner_lease.ts");
    const launcher = read("install/unix/product/BlueTanukiLauncher.sh");
    const diagnostic = app.indexOf("@objc private func inspectRecovery()");
    const reconciliation = app.indexOf("private func confirmRecoveryReconciliation(", diagnostic);
    const next = app.indexOf("@objc private func restartNormally()", reconciliation);
    expect(diagnostic).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeGreaterThan(diagnostic);
    expect(next).toBeGreaterThan(reconciliation);
    expect(app.slice(diagnostic, reconciliation)).toMatch(
      /case \.pending:\s+guard let evidence = report\.runtime_recovery_fence\.pendingEvidence else \{[\s\S]+?return\s+\}[\s\S]+?confirmRecoveryReconciliation\(evidence\)/,
    );
    const action = app.slice(reconciliation, next);
    expect(action).toMatch(
      /guard alert\.runModal\(\) == \.alertSecondButtonReturn else \{ return \}[\s\S]+?validateInstalledProduct\(\)[\s\S]+?"recovery-reconcile", "--backup-id", evidence\.backupID,\s+"--manifest-sha256", evidence\.manifestSHA256,\s+"--command-sha256", evidence\.commandSHA256, "--json"/,
    );
    expect(action).toContain("let operation = evidence.operation.label");
    expect(action).toContain("!report.used_for_authority, exitCode == report.status.expectedExitCode");
    expect(action).toContain("case .success(.unresolved):");
    expect(action).not.toMatch(/resident-start|resident-open|factory-reset|recovery-apply-goal-purpose/);
    expect(app).toContain('case factoryReset = "recovery.factory_reset"');
    expect(app).toContain('case goalPurposeRepair = "recovery.goal_purpose_repair"');
    expect(app).toMatch(/guard status == \.pending,\s+let operation, let kind = PendingEvidence\.Operation\(rawValue: operation\)/);
    expect(app).toMatch(/let commandSHA256 = command_digest,\s+commandSHA256\.range\(of: digestPattern, options: \.regularExpression\) != nil else \{ return nil \}/);
    expect(app).toMatch(/case \.goalPurposeRepair:\s+guard backupID\.range\([^\r\n]+!= nil,\s+let repairSHA256 = repair_sha256,\s+repairSHA256\.range\(of: digestPattern, options: \.regularExpression\) != nil else \{ return nil \}/);
    for (const name of ["FACTORY_BACKUP_ID", "EXPLICIT_BACKUP_ID", "DIGEST"]) {
      const pattern = new RegExp(`^const ${name} = /\\^(.+)\\$/;`, "m").exec(owner)?.[1];
      expect(pattern).toBeTruthy();
      expect(app).toContain(String.raw`#"\A${pattern}\z"#`);
    }
    expect(app).toContain("case .pre_action_state_matched, .postconditions_matched, .no_pending: return 0");
    expect(app).toContain("case .unresolved, .invalid_arguments, .configuration_unavailable: return 2");
    expect(launcher).toMatch(/recovery-reconcile\)[\s\S]*?--recovery-reconcile --env-file "\$ENV_FILE" "\$@"/);
  });
});
