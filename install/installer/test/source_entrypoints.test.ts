import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function runShell(rel: string, args: readonly string[], cwd: string) {
  return spawnSync("sh", [join(root, rel), ...args], {
    cwd,
    env: { ...process.env, NO_LAUNCH: "1" },
    encoding: "utf8",
  });
}

describe("source and release-bundle install entrypoints", () => {
  it("exposes OS-specific root entrypoints", () => {
    expect(existsSync(join(root, "INSTALL_WINDOWS.cmd"))).toBe(true);
    expect(existsSync(join(root, "INSTALL_MACOS.command"))).toBe(true);
    expect(existsSync(join(root, "INSTALL_MACOS.sh"))).toBe(true);
    expect(existsSync(join(root, "INSTALL_LINUX.desktop"))).toBe(true);
    expect(existsSync(join(root, "INSTALL_LINUX.sh"))).toBe(true);
    expect(existsSync(join(root, "INSTALL.sh"))).toBe(true);

    const dispatch = read("INSTALL.sh");
    expect(dispatch).toContain("INSTALL_MACOS.sh");
    expect(dispatch).toContain("INSTALL_LINUX.sh");
    expect(dispatch).toContain("INSTALL_WINDOWS.cmd");

    const macCommand = read("INSTALL_MACOS.command");
    expect(macCommand).toContain("cd \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"");
    expect(macCommand).toContain("exec sh ./INSTALL_MACOS.sh");

    const linuxDesktop = read("INSTALL_LINUX.desktop");
    expect(linuxDesktop).toContain("Type=Application");
    expect(linuxDesktop).toContain("Terminal=true");
    expect(linuxDesktop).toContain("INSTALL_LINUX.sh");
  });

  it("dry-runs the Linux source entrypoint from another current directory", () => {
    if (process.platform === "win32") {
      expect(read("INSTALL_LINUX.sh")).toContain("linux_source_entrypoint_dry_run=pass");
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-linux-entrypoint-"));
    try {
      const result = runShell("INSTALL_LINUX.sh", ["--dry-run"], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Repository root:");
      expect(output).toContain(root);
      expect(output).toContain("would_run=sh ./install/linux/install.sh");
      expect(output).toContain("would_launch_after_install=0");
      expect(output).toContain("linux_source_entrypoint_dry_run=pass");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dry-runs the macOS source entrypoint without requiring a Darwin host", () => {
    if (process.platform === "win32") {
      expect(read("INSTALL_MACOS.sh")).toContain("macos_source_entrypoint_dry_run=pass");
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-macos-entrypoint-"));
    try {
      const result = runShell("INSTALL_MACOS.sh", ["--dry-run"], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toContain("Repository root:");
      expect(output).toContain(root);
      expect(output).toContain("would_run=sh ./install/macos/install.sh");
      expect(output).toContain("would_launch_after_install=0");
      expect(output).toContain("macos_source_entrypoint_dry_run=pass");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dispatches INSTALL.sh to the current Unix platform in dry-run mode", () => {
    if (process.platform === "win32") {
      expect(read("INSTALL.sh")).toContain("INSTALL_WINDOWS.cmd");
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "blue-tanuki-unix-entrypoint-"));
    try {
      const result = runShell("INSTALL.sh", ["--dry-run"], tmp);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      if (process.platform === "darwin") {
        expect(output).toContain("macos_source_entrypoint_dry_run=pass");
      } else {
        expect(output).toContain("linux_source_entrypoint_dry_run=pass");
      }
      expect(output).toContain("would_launch_after_install=0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("makes macOS and Linux installers launch the resident app by default with opt-out", () => {
    const mac = read("install/macos/install.sh");
    const linux = read("install/linux/install.sh");
    for (const text of [mac, linux]) {
      expect(text).toContain("LAUNCH_AFTER_INSTALL=\"${LAUNCH_AFTER_INSTALL:-1}\"");
      expect(text).toContain("NO_LAUNCH");
      expect(text).toContain("resident-start");
      expect(text).toContain("resident-open");
      expect(text).toContain("BLUE_TANUKI_CONTROL_CENTER_URL");
      expect(text).toContain("LAUNCH_AFTER_INSTALL=0");
    }
  });

  it("includes OS-specific root entrypoints in release-bundle policy", () => {
    const create = read("scripts/create_release_bundle.ts");
    const verify = read("scripts/verify_release_bundle.ts");
    for (const text of [create, verify]) {
      expect(text).toContain("INSTALL.sh");
      expect(text).toContain("INSTALL_LINUX.desktop");
      expect(text).toContain("INSTALL_MACOS.command");
      expect(text).toContain("INSTALL_MACOS.sh");
      expect(text).toContain("INSTALL_LINUX.sh");
      expect(text).toContain("install/macos/install.sh");
      expect(text).toContain("install/macos/uninstall.sh");
      expect(text).toContain("install/resident/blue-tanuki-resident.sh");
      expect(text).toContain("install/resident/blue-tanuki-resident.ps1");
      expect(text).toContain("install/linux/install.sh");
      expect(text).toContain("install/linux/uninstall.sh");
    }
  });
});
