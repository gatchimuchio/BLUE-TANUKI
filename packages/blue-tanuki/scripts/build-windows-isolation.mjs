import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(packageRoot, "native", "windows-isolation");
const manifest = path.join(nativeRoot, "Cargo.toml");
const binaryName = "blue-tanuki-windows-isolation.exe";
const sourceBinary = path.join(nativeRoot, "target", "release", binaryName);
const outputDirectory = path.join(packageRoot, "dist", "native");
const outputBinary = path.join(outputDirectory, binaryName);
const buildArgs = ["build", "--locked", "--release", "--manifest-path", manifest];
if (process.argv.includes("--fixtures")) {
  buildArgs.push("--features", "test-fixtures", "--bins");
} else {
  buildArgs.push("--bin", "blue-tanuki-windows-isolation");
}

const build = spawnSync(
  "cargo",
  buildArgs,
  { cwd: nativeRoot, stdio: "inherit", shell: false },
);
if (build.error) throw build.error;
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

await mkdir(outputDirectory, { recursive: true });
await copyFile(sourceBinary, outputBinary);
