import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayRuntimeOwnerLease } from "../src/runtime_owner_lease.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const roots: string[] = [];
function temporaryStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-owner-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  const temporaryDirectory = resolve(tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = resolve(root);
    if (dirname(resolved) !== temporaryDirectory || !basename(resolved).startsWith("blue-tanuki-owner-")) {
      throw new Error("refusing to remove owner-lease test path outside its temporary directory");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe("Gateway runtime owner lease", () => {
  it("persists a fresh execution epoch per acquired generation and rejects a second process", () => {
    const root = temporaryStateRoot();
    const env = { BLUE_TANUKI_STATE_ROOT: root };
    const first = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(first.generation).toBe(1);
      expect(first.executionEpoch).toMatch(/^[0-9a-f-]{36}$/i);
      first.assertActive();

      const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/runtime_owner_lease.ts", import.meta.url))).href;
      const childScript = `import { GatewayRuntimeOwnerLease } from ${JSON.stringify(moduleUrl)};
try { GatewayRuntimeOwnerLease.fromEnvironment(process.env); process.exit(0); }
catch (error) { console.log(error instanceof Error ? error.message : "unknown"); process.exit(3); }`;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
        cwd: process.cwd(),
        env: { ...process.env, BLUE_TANUKI_STATE_ROOT: root },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status).toBe(3);
      expect(child.stdout.trim()).toBe("gateway_runtime_owner_already_active");
    } finally {
      first.close();
    }
    expect(() => first.assertActive()).toThrow("gateway_runtime_owner_lease_lost");
    const second = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(second.generation).toBe(2);
      expect(second.executionEpoch).not.toBe(first.executionEpoch);
      second.assertActive();
    } finally {
      second.close();
    }
  });

  it("fails closed when the persisted owner schema version is unsupported", () => {
    const root = temporaryStateRoot();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment({ BLUE_TANUKI_STATE_ROOT: root });
    lease.close();
    const dbPath = join(root, "private-state", "gateway-runtime", "owner-state.sqlite");
    const db = new DatabaseSync(dbPath);
    try { db.exec("PRAGMA user_version=99"); } finally { db.close(); }
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment({ BLUE_TANUKI_STATE_ROOT: root }))
      .toThrow("gateway_runtime_owner_state_unavailable");
  });

  it("rejects persisted owner state on a different host audience", () => {
    const root = temporaryStateRoot();
    const env = { BLUE_TANUKI_STATE_ROOT: root };
    const first = GatewayRuntimeOwnerLease.fromEnvironment(env, "a".repeat(64));
    first.close();
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env, "b".repeat(64)))
      .toThrow("gateway_runtime_owner_host_identity_mismatch");
    const sameHost = GatewayRuntimeOwnerLease.fromEnvironment(env, "a".repeat(64));
    try {
      expect(sameHost.generation).toBe(2);
      expect(sameHost.hostAudienceDigest).toBe("a".repeat(64));
      expect(sameHost.executionEpoch).not.toBe(first.executionEpoch);
      sameHost.assertActive();
    } finally { sameHost.close(); }
  });

  it("migrates v1 state by binding the current host and rotating the execution epoch", () => {
    const root = temporaryStateRoot();
    const runtimeDirectory = join(root, "private-state", "gateway-runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    const dbPath = join(runtimeDirectory, "owner-state.sqlite");
    const legacy = new DatabaseSync(dbPath);
    const oldEpoch = "10000000-0000-4000-8000-000000000001";
    try {
      legacy.exec(`CREATE TABLE gateway_owner_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL CHECK(generation > 0),
        execution_epoch TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO gateway_owner_state(singleton,generation,execution_epoch,updated_at_ms)
        VALUES(1,4,'${oldEpoch}',1);
      PRAGMA user_version=1;`);
    } finally { legacy.close(); }

    const migrated = GatewayRuntimeOwnerLease.fromEnvironment({ BLUE_TANUKI_STATE_ROOT: root }, "c".repeat(64));
    try {
      expect(migrated.generation).toBe(5);
      expect(migrated.executionEpoch).not.toBe(oldEpoch);
      expect(migrated.hostAudienceDigest).toBe("c".repeat(64));
      migrated.assertActive();
    } finally { migrated.close(); }
    const verified = new DatabaseSync(dbPath);
    try {
      expect((verified.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version).toBe(2);
      expect((verified.prepare("SELECT host_audience_digest FROM gateway_owner_state WHERE singleton=1").get() as { host_audience_digest: string })
        .host_audience_digest).toBe("c".repeat(64));
    } finally { verified.close(); }
  });
});
