import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["apps", "packages", "install"];
const MIN_TEST_FILES = 50;
const MIN_TEST_CASES = 650;

function walk(dir) {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "dist") return [];
        return walk(full);
      }
      return full.endsWith(".test.ts") ? [full] : [];
    });
  } catch {
    return [];
  }
}

const files = ROOTS.flatMap((root) => walk(path.resolve(root)));
const cases = files.reduce((count, file) => {
  const text = readFileSync(file, "utf8");
  return count + (text.match(/\b(?:it|test)\s*\(/g) ?? []).length;
}, 0);

if (files.length < MIN_TEST_FILES || cases < MIN_TEST_CASES) {
  console.error(
    `test inventory below product gate minimum: files=${files.length}/${MIN_TEST_FILES} cases=${cases}/${MIN_TEST_CASES}`,
  );
  process.exit(1);
}

console.log(`test inventory ok: files=${files.length} cases=${cases}`);
