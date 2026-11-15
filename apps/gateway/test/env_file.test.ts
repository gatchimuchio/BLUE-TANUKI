import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  envFilePathFromArgv,
  loadEnvFile,
  parseEnvFile,
  stripEnvFileArgs,
  writeEnvFileAtomic,
} from "../src/env_file.js";

describe("env_file", () => {
  it("parses dotenv-like key/value files without shell expansion", () => {
    const parsed = parseEnvFile(`
# comment
WEBCHAT_TOKEN=plain-token
SPACED="value with spaces"
SINGLE='literal value'
BAD LINE
1BAD=value
`);
    expect(parsed.values.WEBCHAT_TOKEN).toBe("plain-token");
    expect(parsed.values.SPACED).toBe("value with spaces");
    expect(parsed.values.SINGLE).toBe("literal value");
    expect(parsed.warnings).toHaveLength(2);
  });

  it("loads values without overriding existing env by default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-env-"));
    try {
      const file = path.join(dir, "local.env");
      await fs.writeFile(file, "A=from-file\nB=two\n", "utf8");
      const env: NodeJS.ProcessEnv = { A: "already-set" };
      const result = await loadEnvFile(file, { env });
      expect(result.applied).toEqual(["B"]);
      expect(result.skipped).toEqual(["A"]);
      expect(env.A).toBe("already-set");
      expect(env.B).toBe("two");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts and strips --env-file args", () => {
    expect(envFilePathFromArgv(["--serve", "--env-file", "local.env"])).toBe(
      "local.env",
    );
    expect(envFilePathFromArgv(["--env-file=inline.env"])).toBe("inline.env");
    expect(
      stripEnvFileArgs(["--serve", "--env-file", "local.env", "hello"]),
    ).toEqual(["--serve", "hello"]);
  });

  it("atomically writes env files and keeps a backup when requested", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-env-write-"));
    try {
      const file = path.join(dir, "local.env");
      await fs.writeFile(file, "OLD=1\n", "utf8");
      const result = await writeEnvFileAtomic(file, "NEW=2\n", {
        backup: true,
        backup_label: "test",
      });
      expect(result.path).toBe(path.resolve(file));
      expect(result.backup_path).toBeTruthy();
      expect(await fs.readFile(file, "utf8")).toBe("NEW=2\n");
      expect(await fs.readFile(result.backup_path!, "utf8")).toBe("OLD=1\n");
      const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
      expect(leftovers).toEqual([]);
      if (process.platform !== "win32") {
        expect((await fs.stat(file)).mode & 0o077).toBe(0);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("flushes the private replacement before the target path is renamed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-env-sync-order-"));
    const file = path.join(dir, "local.env");
    const events: string[] = [];
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (flags === "wx") {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          events.push("sync");
          await sync();
        };
      }
      return handle;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      events.push("rename");
      return originalRename(from, to);
    });
    try {
      await fs.writeFile(file, "OLD=1\n", "utf8");
      await writeEnvFileAtomic(file, "NEW=2\n");
      expect(events).toEqual(["sync", "rename"]);
      expect(await fs.readFile(file, "utf8")).toBe("NEW=2\n");
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the old target and removes its private temporary file when flush fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-env-sync-failure-"));
    const file = path.join(dir, "local.env");
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (flags === "wx") handle.sync = async () => { throw new Error("fixture flush failure"); };
      return handle;
    });
    try {
      await fs.writeFile(file, "OLD=1\n", "utf8");
      await expect(writeEnvFileAtomic(file, "NEW=2\n")).rejects.toThrow("fixture flush failure");
      expect(await fs.readFile(file, "utf8")).toBe("OLD=1\n");
      expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      openSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
