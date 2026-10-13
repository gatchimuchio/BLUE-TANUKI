import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OperationPlanMemoryStorage } from "@blue-tanuki/hds-brain";

/** 私有保存先だけを組み立てる。記憶採否・書込みはJの限定consumerが所有する。 */
export function operationResultMemoryStorage(env: NodeJS.ProcessEnv = process.env): OperationPlanMemoryStorage {
  const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
  mkdirSync(stateRoot, { recursive: true });
  const privateRoot = join(realpathSync(stateRoot), "private-state");
  const directory = join(privateRoot, "result-memory");
  for (const path of [privateRoot, directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink()) throw new Error("result_memory_directory_must_not_be_symlink");
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  const file = (name: string) => {
    const path = join(directory, name);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("result_memory_file_must_not_be_symlink");
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      closeSync(openSync(path, "wx", 0o600));
    }
    return path;
  };
  return { private_state_root: privateRoot, database_path: file("j-control.sqlite"), memory_database_path: file("m-state.sqlite") };
}
