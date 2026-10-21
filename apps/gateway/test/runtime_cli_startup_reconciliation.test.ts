import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  reconcile: vi.fn(),
  loadPluginRuntime: vi.fn(),
}));

vi.mock("../src/reconcile_execution_results.js", () => ({
  reconcileStartupExecutionState: startup.reconcile,
}));
vi.mock("../src/plugin_loader.js", () => ({
  loadPluginRuntime: startup.loadPluginRuntime,
}));

const { runCli } = await import("../src/runtime.js");
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("CLI startup execution recovery", () => {
  it("blocks tool registration and request processing when saved state is unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "blue-cli-recovery-"));
    roots.push(root);
    vi.stubEnv("BLUE_TANUKI_STATE_ROOT", join(root, "state"));
    vi.stubEnv("BLUE_TANUKI_AUDIT_DIR", join(root, "audit"));
    vi.stubEnv("BLUE_TANUKI_MEMORY_FILE", join(root, "memory.jsonl"));
    const pluginRuntime = {
      enforceLLMConfig: vi.fn(),
      enforceSessionConfig: vi.fn(),
      enforceAuditConfig: vi.fn(),
      registerTools: vi.fn(),
    };
    startup.loadPluginRuntime.mockResolvedValue(pluginRuntime);
    startup.reconcile.mockReturnValue({
      ready: false,
      adopted: 0,
      deferred: 1,
      stale_generation_archived: 0,
      memory_ready: true,
      result_store_readable: true,
    });

    await expect(runCli(["synthetic request"])).rejects.toThrow("gateway_startup_reconciliation_unresolved");

    expect(startup.reconcile).toHaveBeenCalledTimes(1);
    expect(startup.loadPluginRuntime).toHaveBeenCalledTimes(1);
    expect(pluginRuntime.registerTools).not.toHaveBeenCalled();
  });
});
