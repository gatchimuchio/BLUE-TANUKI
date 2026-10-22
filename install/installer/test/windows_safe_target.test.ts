import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Windows developer installer target guard", () => {
  it("rejects broad, overlapping, and reparse-point targets without touching them", () => {
    if (process.platform !== "win32") return;

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "install/installer/test/windows_safe_target.ps1"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("windows_target_guard=pass");
    expect(result.status).toBe(0);
  });

  it("shows the install plan before changes and leaves WhatIf targets untouched", () => {
    if (process.platform !== "win32") return;

    const temp = mkdtempSync(join(tmpdir(), "blue-tanuki-windows-whatif-"));
    const install = join(temp, "app");
    const data = join(temp, "data");
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "install/windows/install.ps1"),
          "-InstallRoot",
          install,
          "-DataRoot",
          data,
          "-WhatIf",
        ],
        { cwd: root, encoding: "utf8" },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("Install plan:");
      expect(output).toContain("What if:");
      expect(existsSync(install)).toBe(false);
      expect(existsSync(data)).toBe(false);

      mkdirSync(install);
      const marker = join(install, "keep.txt");
      writeFileSync(marker, "fixture marker\n", "utf8");
      const forceWhatIf = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "install/windows/install.ps1"),
          "-InstallRoot",
          install,
          "-DataRoot",
          data,
          "-Force",
          "-WhatIf",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(forceWhatIf.status, `${forceWhatIf.stdout}\n${forceWhatIf.stderr}`).toBe(0);
      expect(`${forceWhatIf.stdout}\n${forceWhatIf.stderr}`).toContain("What if:");
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(data)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
