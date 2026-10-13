import { mkdirSync, realpathSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { operationPlanDigest, type OperationPlanStatePort } from "@blue-tanuki/hds-brain";
import { OperationPlanCheckpointSchema, type OperationPlanCheckpoint } from "@blue-tanuki/protocol";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
/** 私有runtime回復状態。原子的CASで別processの古いwriterを拒否する。 */
export class OperationPlanStateStore implements OperationPlanStatePort {
  private readonly db: DatabaseType;
  constructor(filepath: string) {
    mkdirSync(dirname(resolve(filepath)), { recursive: true });
    this.db = new DatabaseSync(filepath);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA");
    this.db.exec("CREATE TABLE IF NOT EXISTS operation_plan_state (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT");
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): OperationPlanStateStore {
    const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
    mkdirSync(stateRoot, { recursive: true });
    const privateRoot = join(realpathSync(stateRoot), "private-state");
    const directory = join(privateRoot, "operation-plans");
    for (const dir of [privateRoot, directory]) {
      mkdirSync(dir, { recursive: true });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("plan_state_directory_must_not_be_symlink");
    }
    const filepath = join(directory, "j-state.sqlite");
    try {
      if (lstatSync(filepath).isSymbolicLink()) throw new Error("plan_state_file_must_not_be_symlink");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new OperationPlanStateStore(filepath);
  }
  load(): OperationPlanCheckpoint | null {
    const row = this.db.prepare("SELECT checkpoint_json, digest FROM operation_plan_state WHERE id=1").get() as
      { checkpoint_json: string; digest: string } | undefined;
    if (!row) return null;
    const value = OperationPlanCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
    if (operationPlanDigest(value) !== row.digest) throw new Error("plan_checkpoint_integrity_failed");
    return value;
  }
  compareAndSet(expected_digest: string | null, checkpoint: OperationPlanCheckpoint): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.load();
      if ((current ? operationPlanDigest(current) : null) !== expected_digest) throw new Error("plan_checkpoint_concurrent_update");
      const checked = OperationPlanCheckpointSchema.parse(checkpoint);
      this.db.prepare("INSERT INTO operation_plan_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,digest=excluded.digest")
        .run(JSON.stringify(checked), operationPlanDigest(checked));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 元の保存失敗を保持する。 */ }
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
