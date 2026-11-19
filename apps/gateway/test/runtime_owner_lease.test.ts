import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUnderOfflineGoalPurposeRepairLock,
  GatewayRuntimeOwnerLease,
  inspectRuntimeRecoveryFence,
  observeUnderOfflineGatewayOwnerLock,
  reconcileRuntimeRecoveryFence,
  type OfflineGoalPurposeRepairBinding,
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
const fixtureHandoff = "f".repeat(64);
const goalPurposeRepair = {
  backup_id: "fixture-goal-purpose-backup", manifest_sha256: "8".repeat(64), repair_sha256: "a".repeat(64),
  handoff_digest: createHash("sha256").update(fixtureHandoff).digest("hex"),
};
function goalPurposeRepairBinding(): OfflineGoalPurposeRepairBinding {
  return { ...goalPurposeRepair, command_digest: "9".repeat(64), verification, expires_at_ms: Date.now() + 60_000 };
}
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
  it("consumes exactly one goal-purpose handoff before writing and settles it under the existing exclusive owner lock", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const ownerStatePath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    let observed = verification.before_sha256;
    let applications = 0;
    const prepare = vi.fn(async (reviewed: OfflineGoalPurposeRepairBinding) => {
      expect(reviewed).toEqual(binding);
      return {
        apply: async () => {
          expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_already_active");
          expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", operation: "recovery.goal_purpose_repair",
            command_digest: binding.command_digest, backup_id: binding.backup_id, manifest_sha256: binding.manifest_sha256,
            repair_sha256: binding.repair_sha256 });
          const db = new DatabaseSync(ownerStatePath, { readOnly: true });
          try {
            expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='gateway_goal_purpose_repair_authorization'").get())
              .toBeUndefined();
          } finally {
            db.close();
          }
          applications += 1;
          observed = verification.after_sha256;
        },
        observe: async () => observed,
      };
    });
    try {
      lease.prepareOfflineGoalPurposeRepair(binding);
      expect(() => lease.prepareOfflineGoalPurposeRepair({ ...binding, repair_sha256: "b".repeat(64) }))
        .toThrow("gateway_goal_purpose_repair_authorization_pending");
      const busy = await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, { prepare });
      expect(["owner_lock_busy", "owner_lock_sidecars_present"]).toContain(busy);
      expect(prepare).not.toHaveBeenCalled();
      expect(readFileSync(ownerStatePath).includes(Buffer.from(fixtureHandoff))).toBe(false);
    } finally {
      lease.close();
    }
    for (const selector of [{ ...goalPurposeRepair, handoff_digest: "0".repeat(64) },
      { ...goalPurposeRepair, backup_id: "different-backup" }, { ...goalPurposeRepair, manifest_sha256: "b".repeat(64) },
      { ...goalPurposeRepair, repair_sha256: "b".repeat(64) }]) {
      expect(await applyUnderOfflineGoalPurposeRepairLock(env, selector, { prepare })).toBe("authorization_required");
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, { prepare })).toBe("applied");
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, { prepare })).toBe("authorization_required");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(applications).toBe(1);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    const db = new DatabaseSync(ownerStatePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT generation,execution_epoch FROM gateway_owner_state").get()).toEqual({
        generation: lease.generation, execution_epoch: lease.executionEpoch,
      });
      expect(db.prepare("SELECT * FROM gateway_recovery_settlements").all()).toEqual([{
        generation: lease.generation, operation: "recovery.goal_purpose_repair", command_digest: binding.command_digest,
        backup_id: binding.backup_id, manifest_sha256: binding.manifest_sha256, repair_sha256: binding.repair_sha256,
        observed_sha256: verification.after_sha256, status: "postconditions_matched",
      }]);
    } finally {
      db.close();
    }
  });

  it("settles a rollback only after two observations of the reviewed pre-action state", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try { lease.prepareOfflineGoalPurposeRepair(binding); } finally { lease.close(); }
    let observed = verification.before_sha256;
    const observe = vi.fn(async () => observed);
    const apply = vi.fn(async (assertFenceContinuity: () => void) => {
      assertFenceContinuity();
      expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", command_digest: binding.command_digest });
      observed = verification.after_sha256;
      assertFenceContinuity();
      observed = verification.before_sha256;
      return "rolled_back" as const;
    });
    const callbacks = { prepare: async () => ({ apply, observe }) };
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("rolled_back");
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("authorization_required");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });

    const ownerStatePath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const db = new DatabaseSync(ownerStatePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT status, observed_sha256 FROM gateway_recovery_settlements").get()).toEqual({
        status: "pre_action_state_matched", observed_sha256: verification.before_sha256,
      });
    } finally {
      db.close();
    }
  });

  it("retains the fence when the claimed rollback drifts before settlement", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try { lease.prepareOfflineGoalPurposeRepair(binding); } finally { lease.close(); }
    const observations = [verification.before_sha256, verification.before_sha256, verification.after_sha256];
    const observe = vi.fn(async () => observations.shift() ?? null);
    const apply = vi.fn(async (assertFenceContinuity: () => void) => {
      assertFenceContinuity();
      return "rolled_back" as const;
    });
    const callbacks = { prepare: async () => ({ apply, observe }) };
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("outcome_unknown");
    expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", command_digest: binding.command_digest });
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_recovery_pending");
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("recovery_pending");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("preserves state on rejected preflight or expiry and invalidates the handoff on a fresh owner generation", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try { lease.prepareOfflineGoalPurposeRepair(binding); } finally { lease.close(); }
    const apply = vi.fn(async () => {});
    const beforeMismatch = { prepare: async () => ({ apply, observe: async () => "0".repeat(64) }) };
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, beforeMismatch)).toBe("preflight_changed");
    const clock = vi.spyOn(Date, "now");
    try {
      const expiryAtClaim = { prepare: async () => ({ apply, observe: async () => {
        clock.mockReturnValue(binding.expires_at_ms);
        return verification.before_sha256;
      } }) };
      expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, expiryAtClaim)).toBe("authorization_expired");
    } finally {
      clock.mockRestore();
    }
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    expect(apply).not.toHaveBeenCalled();
    const restarted = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(restarted.generation).toBe(lease.generation + 1);
      expect(restarted.executionEpoch).not.toBe(lease.executionEpoch);
    } finally {
      restarted.close();
    }
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, beforeMismatch)).toBe("authorization_required");
  });

  it("revokes the live handoff without settling another operation or advancing the owner generation", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try { lease.prepareOfflineGoalPurposeRepair({ ...goalPurposeRepairBinding(), expires_at_ms: now + 300_000 }); }
      finally { clock.mockRestore(); }
      lease.revokePreparedOfflineGoalPurposeRepair();
      expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
      lease.beginRecoveryMutation(verifiableEvidence);
      lease.revokePreparedOfflineGoalPurposeRepair();
      expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "pending", ...recoveryEvidence });
      lease.finishRecoveryMutation(verifiableEvidence);
    } finally {
      lease.close();
    }
    const prepare = vi.fn(async () => null);
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, { prepare })).toBe("authorization_required");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retains an interrupted goal-purpose fence until reconciliation separately observes an exact terminal state", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try { lease.prepareOfflineGoalPurposeRepair(binding); } finally { lease.close(); }
    let observed = verification.before_sha256;
    const apply = vi.fn(async () => {
      observed = "0".repeat(64);
      throw new Error("synthetic interruption after writing one store");
    });
    const callbacks = { prepare: async () => ({ apply, observe: async () => observed }) };
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("outcome_unknown");
    expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_recovery_pending");
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, callbacks)).toBe("recovery_pending");
    expect(apply).toHaveBeenCalledTimes(1);
    const observe = vi.fn(async (evidence: RuntimeRecoveryFenceEvidence) => {
      expect(evidence).toEqual({ operation: "recovery.goal_purpose_repair", command_digest: binding.command_digest,
        backup_id: binding.backup_id, manifest_sha256: binding.manifest_sha256, repair_sha256: binding.repair_sha256,
        verification });
      return observed;
    });
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe)).toEqual({ status: "unresolved" });
    expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", repair_sha256: binding.repair_sha256 });
    observed = verification.after_sha256;
    expect(await reconcileRuntimeRecoveryFence(env, { ...goalPurposeRepair, command_digest: "0".repeat(64) }, observe))
      .toEqual({ status: "unresolved" });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", command_digest: binding.command_digest });
    expect(await reconcileRuntimeRecoveryFence(env, { ...goalPurposeRepair, command_digest: binding.command_digest }, observe))
      .toEqual({ status: "postconditions_matched" });
    expect(observe).toHaveBeenCalledTimes(3);
    GatewayRuntimeOwnerLease.fromEnvironment(env).close();
  });

  it("rolls back only the exact interrupted purpose repair and settles its original owner generation", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const binding = goalPurposeRepairBinding();
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try { lease.prepareOfflineGoalPurposeRepair(binding); } finally { lease.close(); }
    const mixed = "0".repeat(64);
    let observed = verification.before_sha256;
    expect(await applyUnderOfflineGoalPurposeRepairLock(env, goalPurposeRepair, {
      prepare: async () => ({
        apply: async () => { observed = mixed; throw new Error("synthetic interruption"); },
        observe: async () => observed,
      }),
    })).toBe("outcome_unknown");

    const observe = vi.fn(async () => observed);
    const exactScope = { command_digest: binding.command_digest, repair_sha256: binding.repair_sha256 };
    const rollback = vi.fn(async (_evidence: RuntimeRecoveryFenceEvidence, initial: string, assertContinuity: () => void) => {
      expect(initial).toBe(mixed);
      assertContinuity();
      expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_already_active");
      assertContinuity();
      observed = verification.before_sha256;
      return true;
    });
    const recovery = { ...exactScope, apply: rollback };
    expect(await reconcileRuntimeRecoveryFence(env, { ...goalPurposeRepair, backup_id: "different-backup" }, observe, recovery))
      .toEqual({ status: "unresolved" });
    expect(await reconcileRuntimeRecoveryFence(env, { ...goalPurposeRepair, manifest_sha256: mixed }, observe, recovery))
      .toEqual({ status: "unresolved" });
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, { ...recovery, command_digest: mixed }))
      .toEqual({ status: "unresolved" });
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, { ...recovery, repair_sha256: mixed }))
      .toEqual({ status: "unresolved" });
    expect(observe).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();

    observe.mockResolvedValueOnce(mixed).mockResolvedValueOnce(verification.after_sha256);
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, recovery)).toEqual({ status: "unresolved" });
    expect(rollback).not.toHaveBeenCalled();
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, { ...exactScope, apply: async () => false }))
      .toEqual({ status: "unresolved" });
    expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", ...exactScope });

    const initialRoot = env.BLUE_TANUKI_STATE_ROOT;
    const otherRoot = temporaryStateRoot();
    const replaceScope = async () => {
      env.BLUE_TANUKI_STATE_ROOT = otherRoot;
      return mixed;
    };
    try {
      expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, replaceScope, recovery)).toEqual({ status: "unresolved" });
    } finally {
      env.BLUE_TANUKI_STATE_ROOT = initialRoot;
    }
    expect(rollback).not.toHaveBeenCalled();

    observe.mockResolvedValueOnce(mixed).mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce(verification.before_sha256).mockResolvedValueOnce(verification.after_sha256);
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, recovery)).toEqual({ status: "unresolved" });
    expect(inspectRuntimeRecoveryFence(env)).toMatchObject({ status: "pending", ...exactScope });
    expect(rollback).toHaveBeenCalledTimes(1);

    observed = mixed;
    rollback.mockClear();
    observe.mockClear();
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, recovery)).toEqual({ status: "rolled_back" });
    expect(observe).toHaveBeenCalledTimes(4);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "clear" });
    expect(await reconcileRuntimeRecoveryFence(env, goalPurposeRepair, observe, recovery)).toEqual({ status: "no_pending" });
    expect(rollback).toHaveBeenCalledTimes(1);
    const filepath = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const state = new DatabaseSync(filepath, { readOnly: true });
    try {
      expect(state.prepare("SELECT generation,execution_epoch FROM gateway_owner_state").get()).toEqual({
        generation: lease.generation, execution_epoch: lease.executionEpoch,
      });
      expect(state.prepare("SELECT * FROM gateway_recovery_settlements").get()).toMatchObject({
        generation: lease.generation, operation: "recovery.goal_purpose_repair", ...exactScope,
        backup_id: binding.backup_id, manifest_sha256: binding.manifest_sha256,
        observed_sha256: verification.before_sha256, status: "pre_action_state_matched",
      });
    } finally {
      state.close();
    }
  });

  it("holds the existing owner lock across an asynchronous offline observation without advancing the generation", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: join(temporaryStateRoot(), "state") };
    const directory = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime");
    const files = [join(directory, "owner-lock.sqlite"), join(directory, "owner-state.sqlite")];
    const unexpectedObservation = async () => { throw new Error("offline observation should not run"); };
    expect(await observeUnderOfflineGatewayOwnerLock(env, unexpectedObservation)).toEqual({ status: "owner_state_unavailable" });
    expect(existsSync(env.BLUE_TANUKI_STATE_ROOT)).toBe(false);

    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      const blocked = await observeUnderOfflineGatewayOwnerLock(env, unexpectedObservation);
      expect(["owner_lock_busy", "owner_lock_sidecars_present"]).toContain(blocked.status);
    } finally {
      lease.close();
    }

    const before = files.map(filepath => readFileSync(filepath));
    let observations = 0;
    const result = await observeUnderOfflineGatewayOwnerLock(env, async (ownerScopeSha256) => {
      await Promise.resolve();
      expect(() => GatewayRuntimeOwnerLease.fromEnvironment(env)).toThrow("gateway_runtime_owner_already_active");
      observations += 1;
      return ownerScopeSha256;
    });
    expect(result).toEqual({ status: "verified", observation: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const scope = async (ownerScopeSha256: string) => ownerScopeSha256;
    expect(await observeUnderOfflineGatewayOwnerLock(env, scope)).toEqual(result);
    expect(observations).toBe(1);
    expect(await observeUnderOfflineGatewayOwnerLock(env, unexpectedObservation)).toEqual({ status: "owner_state_unavailable" });
    expect(files.map(filepath => readFileSync(filepath))).toEqual(before);
    expect(readdirSync(directory).sort()).toEqual(files.map(filepath => basename(filepath)).sort());

    const restarted = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      expect(restarted.generation).toBe(lease.generation + 1);
    } finally {
      restarted.close();
    }
    const laterScope = await observeUnderOfflineGatewayOwnerLock(env, scope);
    expect(laterScope.status).toBe("verified");
    expect(laterScope).not.toEqual(result);
  });

  it.each(["state_root", "owner-lock.sqlite-wal", "owner-state.sqlite-journal"])(
    "rejects an installation scope or sidecar change during offline observation: %s", async (drift) => {
      const originalRoot = temporaryStateRoot();
      const env = { BLUE_TANUKI_STATE_ROOT: originalRoot };
      GatewayRuntimeOwnerLease.fromEnvironment(env).close();
      const directory = join(originalRoot, "private-state", "gateway-runtime");
      const observation = vi.fn(async () => {
        if (drift === "state_root") env.BLUE_TANUKI_STATE_ROOT = temporaryStateRoot();
        else writeFileSync(join(directory, drift), "synthetic sidecar", { flag: "wx" });
        return "stale observation";
      });
      expect(await observeUnderOfflineGatewayOwnerLock(env, observation)).toEqual({ status: "owner_state_unavailable" });
      expect(observation).toHaveBeenCalledOnce();
    });

  it("skips offline observation for a pending fence or a different host binding", async () => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    const lease = GatewayRuntimeOwnerLease.fromEnvironment(env);
    try {
      lease.beginRecoveryMutation(verifiableEvidence);
    } finally {
      lease.close();
    }
    let observations = 0;
    const observe = async () => { observations += 1; };
    const owner = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime", "owner-state.sqlite");
    const before = readFileSync(owner);
    expect(await observeUnderOfflineGatewayOwnerLock(env, observe)).toEqual({ status: "recovery_pending" });
    expect(readFileSync(owner)).toEqual(before);

    const otherHost = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    GatewayRuntimeOwnerLease.fromEnvironment(otherHost, "f".repeat(64)).close();
    expect(await observeUnderOfflineGatewayOwnerLock(otherHost, observe)).toEqual({ status: "owner_state_unavailable" });
    expect(observations).toBe(0);
  });

  it.each(["owner-lock.sqlite", "owner-state.sqlite"])("leaves a sidecar-free WAL database untouched at %s", async (name) => {
    const env = { BLUE_TANUKI_STATE_ROOT: temporaryStateRoot() };
    GatewayRuntimeOwnerLease.fromEnvironment(env).close();
    const directory = join(env.BLUE_TANUKI_STATE_ROOT, "private-state", "gateway-runtime");
    const filepath = join(directory, name);
    const db = new DatabaseSync(filepath);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE wal_fixture(value TEXT) STRICT;");
    } finally {
      db.close();
    }
    const before = readFileSync(filepath);
    expect(before.subarray(18, 20)).toEqual(Buffer.from([2, 2]));
    const names = readdirSync(directory).sort();
    expect(names).toEqual(["owner-lock.sqlite", "owner-state.sqlite"]);

    let observations = 0;
    const observe = async () => { observations += 1; return null; };
    expect(await observeUnderOfflineGatewayOwnerLock(env, observe)).toEqual({ status: "owner_state_unavailable" });
    expect(await reconcileRuntimeRecoveryFence(env, expectedBackup, observe)).toEqual({ status: "unresolved" });
    if (name === "owner-state.sqlite") expect(inspectRuntimeRecoveryFence(env)).toEqual({ status: "unavailable" });
    expect(observations).toBe(0);
    expect(readFileSync(filepath)).toEqual(before);
    expect(readdirSync(directory).sort()).toEqual(names);
  });

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
