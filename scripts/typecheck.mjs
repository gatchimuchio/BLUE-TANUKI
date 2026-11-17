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

// project referencesは参照先の宣言出力を必要とするため、build modeでは--noEmitを渡さない。
const tsc = run([join(root, "node_modules/typescript/bin/tsc"), "-b", "--pretty", "false"]);

if (tsc.error) {
  console.error(`[typecheck] ${tsc.error.message}`);
  process.exit(1);
}

process.exit(tsc.status ?? 1);
