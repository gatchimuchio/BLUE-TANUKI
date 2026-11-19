import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayRuntimeOwnerLease,
  inspectRuntimeRecoveryFence,
  reconcileRuntimeRecoveryFence,
  type RuntimeRecoveryFenceEvidence,
} from "../src/runtime_owner_lease.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const roots: string[] = [];
const recoveryEvidence: RuntimeRecoveryFenceEvidence = {
  operation: "recovery.factory_reset",
  command_digest: "1".repeat(64),
  backup_id: "2026-11-19T14-18-15-560Z.pre_factory_reset.12345678-1234-4123-8123-123456789abc",
  manifest_sha256: "2".repeat(64),
};
const verification = { before_sha256: "3".repeat(64), after_sha256: "4".repeat(64) };
const verifiableEvidence = { ...recoveryEvidence, verification };
const expectedBackup = { backup_id: recoveryEvidence.backup_id, manifest_sha256: recoveryEvidence.manifest_sha256 };
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
  it.each([
    [verification.before_sha256, "pre_action_state_matched"],
    [verification.after_sha256, "postconditions_matched"],
  ])("settles only twice-matched recovery evidence and retains the result as %s", async (digest, terminalStatus) => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      lease.beginRecoveryMutation(verifiableEvidence);
      let observedWhileActive = false;
      const blocked = await reconcileRuntimeRecoveryFence(env, expectedBackup, async () => {
        observedWhileActive = true;
        return digest;
      });
      expect(blocked).toEqual({ status: "unresolved" });
      expect(observedWhileActive).toBe(false);
    } finally {
      lease.close();
    }
    let observations = 0;
    const result = await reconcileRuntimeRecoveryFence(env, expectedBackup, async (evidence) => {
      observations += 1;
      expect(evidence).toEqual(verifiableEvidence);
      expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_already_active");
      return digest;
    });
    expect(result).toEqual({ status: terminalStatus });
    expect(observations).toBe(2);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, async () => null)).toEqual({ status: "no_pending" });
    const filepath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const state = new DatabaseSync(filepath, { readOnly: true });
    try {
      expect(state.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(state.prepare("SELECT generation,execution_epoch FROM gateway_owner_state").get()).toEqual({
        generation: lease.generation, execution_epoch: lease.executionEpoch,
      });
      expect(state.prepare("SELECT * FROM gateway_recovery_settlements").all()).toEqual([{
        generation: lease.generation, ...recoveryEvidence, observed_sha256: digest, status: terminalStatus,
      }]);
    } finally {
      state.close();
    }
    const restarted = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(restarted.generation).toBe(lease.generation + 1);
      expect(restarted.executionEpoch).not.toBe(lease.executionEpoch);
    } finally {
      restarted.close();
    }
  });

  it("leaves the fence byte-for-byte unchanged for mismatched or unstable observations", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      lease.beginRecoveryMutation(verifiableEvidence);
    } finally {
      lease.close();
    }
    const filepath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const original = readFileSync(filepath);
    let observations = 0;
    const observe = async () => {
      observations += 1;
      return observations === 1 ? verification.after_sha256 : verification.before_sha256;
    };
    expect(await reconcileRuntimeRecoveryFence(env, { ...expectedBackup, manifest_sha256: "a".repeat(64) }, observe))
      .toEqual({ status: "unresolved" });
    expect(observations).toBe(0);
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, observe)).toEqual({ status: "unresolved" });
    expect(observations).toBe(2);
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, async () => { throw new Error("read failure"); }))
      .toEqual({ status: "unresolved" });
    expect(readFileSync(filepath)).toEqual(original);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", ...recoveryEvidence });
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_recovery_pending");
  });

  it("keeps legacy evidence pending and does not create storage for an absent installation", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: join(temporaryStateRoot(), "state") };
    let observations = 0;
    const observe = async () => { observations += 1; return verification.before_sha256; };
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, observe)).toEqual({ status: "no_pending" });
    expect(existsSync(env.BLUE_TANUKI_STATE_ROOT)).toBe(false);
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(() => lease.beginRecoveryMutation({ ...recoveryEvidence, verification: {
        ...verification, after_sha256: "not-a-digest",
      } })).toThrow("gateway_runtime_recovery_fence_invalid");
      lease.beginRecoveryMutation(recoveryEvidence);
    } finally {
      lease.close();
    }
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, observe)).toEqual({ status: "unresolved" });
    expect(observations).toBe(0);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", ...recoveryEvidence });
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_recovery_pending");
  });

  it("surfaces a pending fence read-only and leaves a stopped mutation's generation unchanged", () => {
    const env = { BLUE_TANUKI_STATE_ROOT: join(temporaryStateRoot(), "state") };
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    expect(existsSync(env.BLUE_TANUKI_STATE_ROOT)).toBe(false);
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      lease.beginRecoveryMutation(recoveryEvidence);
      expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_already_active");
    } finally {
      lease.close();
    }
    const directory = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime");
    const filepath = join(directory, "owner-state.sqlite");
    const original = readFileSync(filepath);
    const created = readdirSync(directory).sort();
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", ...recoveryEvidence });
    expect(readdirSync(directory).sort()).toEqual(created);
    expect(readFileSync(filepath)).toEqual(original);
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_recovery_pending");
    expect(() => lease.finishRecoveryMutation(recoveryEvidence)).toThrow("gateway_runtime_owner_lease_lost");
    const db = new DatabaseSync(filepath, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(db.prepare("SELECT generation,execution_epoch FROM gateway_owner_state").get()).toEqual({
        generation: lease.generation, execution_epoch: lease.executionEpoch,
      });
    } finally {
      db.close();
    }
  });

  it("settles only the exact successful mutation on the lease that started it", () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(() => lease.beginRecoveryMutation({ ...recoveryEvidence, backup_id: "latest" }))
        .toThrow("gateway_runtime_recovery_fence_invalid");
      expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
      lease.beginRecoveryMutation(recoveryEvidence);
      expect(() => lease.beginRecoveryMutation(recoveryEvidence)).toThrow("gateway_runtime_recovery_fence_unavailable");
      expect(() => lease.finishRecoveryMutation({ ...recoveryEvidence, manifest_sha256: "3".repeat(64) }))
        .toThrow("gateway_runtime_recovery_fence_mismatch");
      expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", ...recoveryEvidence });
      lease.finishRecoveryMutation(recoveryEvidence);
      expect(() => lease.finishRecoveryMutation(recoveryEvidence)).toThrow("gateway_runtime_recovery_fence_mismatch");
      expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    } finally {
      lease.close();
    }
    const restarted = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(restarted.generation).toBe(lease.generation + 1);
      expect(restarted.executionEpoch).not.toBe(lease.executionEpoch);
    } finally {
      restarted.close();
    }
    const state = new DatabaseSync(join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite"),
      { readOnly: true });
    try {
      expect(state.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(state.prepare("SELECT name FROM sqlite_schema WHERE name='gateway_recovery_fence'").get()).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("fails closed when recovery-fence evidence is corrupted", () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      lease.beginRecoveryMutation(recoveryEvidence);
    } finally {
      lease.close();
    }
    const filepath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const db = new DatabaseSync(filepath);
    try {
      db.prepare("UPDATE gateway_recovery_fence SET digest=? WHERE singleton=1").run("0".repeat(64));
    } finally {
      db.close();
    }
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "unavailable" });
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_state_unavailable");
  });

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
