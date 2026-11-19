import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { probeGatewaySelfHealth } from "../src/runtime_health.js";

describe("Gateway runtime health paths", () => {
  it("checks write readiness without creating a missing HDS memory file", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bt-runtime-health-memory-"));
    const memoryFile = path.join(stateRoot, "private-state", "memory.jsonl");
    const env = { BLUE_TANUKI_MEMORY_FILE: memoryFile };
    try {
      const readOnly = await probeGatewaySelfHealth(env, { mode: "read_only" });
      expect(readOnly.storage_paths).toContainEqual({ path: memoryFile, readable: false, writable: false });
      const startup = await probeGatewaySelfHealth(env);
      expect(startup.storage_paths).toContainEqual({ path: memoryFile, readable: true, writable: true });
      expect(await fs.readdir(path.dirname(memoryFile))).toEqual([]);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("probes schedule storage beneath the configured runtime state root", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bt-runtime-health-state-root-"));
    try {
      const report = await probeGatewaySelfHealth({ BLUE_TANUKI_STATE_ROOT: stateRoot });
      const schedulesDirectory = path.join(stateRoot, "schedules");

      expect(report.required_directories).toContainEqual({
        path: schedulesDirectory,
        readable: true,
        writable: true,
      });
      expect((await fs.stat(schedulesDirectory)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });
});
