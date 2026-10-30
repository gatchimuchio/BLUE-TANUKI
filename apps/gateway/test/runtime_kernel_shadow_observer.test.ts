import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startRuntimeKernelShadowObserver,
  type RuntimeKernelShadowObserverEvent,
} from "../src/runtime_kernel_shadow_observer.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(repositoryRoot, "packages", "hds-brain", "runtime-kernel-rust", "Cargo.toml");

describe("Gateway Runtime Kernel shadow observer", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--locked", "--manifest-path", manifestPath], {
      cwd: repositoryRoot,
      stdio: "pipe",
      timeout: 600_000,
    });
  }, 600_000);

  it("productionでは明示設定があっても起動しない", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: true,
      onEvent: (event) => events.push(event),
    });

    expect(observer).toBeUndefined();
    expect(events).toEqual([{ kind: "disabled", reason: "production_environment" }]);
  });

  it("通常consumer向けに合成判断要約を送り、安全receiptを検証して停止する", async () => {
    const events: RuntimeKernelShadowObserverEvent[] = [];
    const observer = await startRuntimeKernelShadowObserver({
      enabled: true,
      production: false,
      onEvent: (event) => events.push(event),
    });
    expect(observer).toBeDefined();

    try {
      observer!.observe({ decision: "ASSERT", command_present: true });
    } finally {
      await observer!.shutdown();
    }

    expect(events).toEqual([
      { kind: "ready" },
      { kind: "observation", sequence: 1, shadow_revision: 1 },
    ]);
  }, 120_000);
});
