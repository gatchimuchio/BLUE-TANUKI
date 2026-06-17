import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("resident application integration", () => {
  it("exposes resident lifecycle commands from portable launchers", () => {
    const win = read("install/windows/install.ps1");
    const mac = read("install/macos/install.sh");
    const linux = read("install/linux/install.sh");

    for (const text of [win, mac, linux]) {
      expect(text).toContain("resident-start");
      expect(text).toContain("resident-status");
      expect(text).toContain("resident-stop");
      expect(text).toContain("resident-open");
      expect(text).toContain("resident-logs");
      expect(text).toContain("resident-autostart-enable");
      expect(text).toContain("resident-autostart-disable");
      expect(text).toContain("resident-autostart-status");
    }
    expect(mac).toContain("LAUNCH_AFTER_INSTALL");
    expect(mac).toContain("resident-open");
    expect(linux).toContain("LAUNCH_AFTER_INSTALL");
    expect(linux).toContain("resident-open");
  });

  it("keeps autostart explicit and current-user scoped", () => {
    const ps = read("install/resident/blue-tanuki-resident.ps1");
    const sh = read("install/resident/blue-tanuki-resident.sh");

    expect(ps).toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(ps).toContain("resident-autostart-enable");
    expect(ps).toContain("resident-autostart-disable");
    expect(sh).toContain("LaunchAgents");
    expect(sh).toContain("systemctl --user");
    expect(sh).toContain("X-GNOME-Autostart-enabled=true");
    expect(sh).toContain("resident-autostart-enable");
    expect(sh).toContain("resident-autostart-disable");
  });

  it("cleans resident lifecycle on uninstall without purging retained data by default", () => {
    const win = read("install/windows/uninstall.ps1");
    const mac = read("install/macos/uninstall.sh");
    const linux = read("install/linux/uninstall.sh");

    for (const text of [win, mac, linux]) {
      expect(text).toContain("resident-stop");
      expect(text).toContain("resident-autostart-disable");
      expect(text).toContain("Data retained");
    }
    expect(linux).toContain("Config retained");
  });

  it("documents resident app boundaries without native-app or updater claims", () => {
    const guide = read("docs/RESIDENT_APP_GUIDE.md");
    const phase = read("docs/phase11-s10-resident-application-integration.md");

    expect(guide).toContain("Autostart is opt-in only");
    expect(guide).toContain("does not provide a signed native app");
    expect(guide).toContain("does not provide an automatic updater");
    expect(phase).toContain("does not provide a signed native installer");
    expect(phase).toContain("does not provide an automatic updater");
  });
});
