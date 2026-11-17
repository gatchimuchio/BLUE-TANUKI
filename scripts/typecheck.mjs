import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
}

const tsc = run([join(root, "node_modules/typescript/bin/tsc"), "-b", "--noEmit", "--pretty", "false"]);

if (tsc.error) {
  console.error(`[typecheck] ${tsc.error.message}`);
  process.exit(1);
}

process.exit(tsc.status ?? 1);
