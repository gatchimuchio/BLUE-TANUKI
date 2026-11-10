import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { probeGatewaySelfHealth } from "../src/runtime_health.js";

describe("Gateway runtime health paths", () => {
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
