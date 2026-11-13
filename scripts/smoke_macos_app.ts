import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type MacArch = "x64" | "arm64";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value?.slice(prefix.length);
}

function run(command: string, args: readonly string[], context: string): string {
  try {
    return execFileSync(command, [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const failure = typeof error === "object" && error !== null
      ? error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number | null; signal?: string | null }
      : {};
    const output = [failure.stderr, failure.stdout]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .split(/\r?\n/u)
      .slice(-3)
      .join(" ")
      .slice(0, 400);
    const exit = typeof failure.status === "number" ? ` (exit code ${failure.status})`
      : failure.signal ? ` (signal ${failure.signal})` : "";
    throw new Error(`${context} failed${exit}${output ? `: ${output}` : ""}`);
  }
}

function appProcessIds(executable: string): number[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== "string") throw new Error("cannot inspect macOS app process state");
  const ids: number[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[2]?.includes(executable)) ids.push(Number(match[1]));
  }
  return ids;
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}

function mountOpenProcessSummary(mount: string): string {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-w", "-Fpc", "+D", mount], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (result.error) return result.error.message === "spawnSync /usr/sbin/lsof ETIMEDOUT" ? "timed-out" : "unavailable";
  if (typeof result.stdout !== "string") return `unavailable-exit-${String(result.status)}`;

  const processes: Array<{ pid: string; command: string }> = [];
  let current: { pid: string; command: string } | undefined;
  for (const field of result.stdout.split(/\r?\n/u)) {
    if (field.startsWith("p")) {
      if (current?.pid && current.command) processes.push(current);
      current = { pid: field.slice(1), command: "" };
    } else if (field.startsWith("c") && current) {
      current.command = field.slice(1);
    }
  }
  if (current?.pid && current.command) processes.push(current);
  const unique = [...new Map(processes.map((process) => [`${process.pid}:${process.command}`, process])).values()];
  if (unique.length === 0) return result.status === 0 ? "none-reported" : `none-reported-exit-${String(result.status)}`;
  return unique.slice(0, 12).map(({ pid, command }) => `${command}:${pid}`).join(",");
}

async function detachReadOnlyImage(mount: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      run("/usr/bin/hdiutil", ["detach", mount], "native app DMG detach");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "native app DMG detach failed after five normal attempts";
  throw new Error(`${detail}; mount open processes=${mountOpenProcessSummary(mount)}`);
}

function minimalAppEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    USER: process.env.USER ?? os.userInfo().username,
    LOGNAME: process.env.LOGNAME ?? os.userInfo().username,
    HOME: os.homedir(),
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

async function smoke(arch: MacArch): Promise<void> {
  if (process.platform !== "darwin") throw new Error("native macOS app smoke requires a macOS runner");
  const expectedNodeArch = arch === "x64" ? "x64" : "arm64";
  if (process.arch !== expectedNodeArch) throw new Error(`runner architecture mismatch: expected=${expectedNodeArch}`);

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(pkg.version)) throw new Error("package version is invalid");
  const dmg = path.join(root, "release/macos", `BlueTanuki-${pkg.version}-macos-${arch}.dmg`);
  if (!existsSync(dmg) || !lstatSync(dmg).isFile()) throw new Error(`native app DMG is missing for ${arch}`);

  const tempBase = path.resolve(os.tmpdir());
  const workRoot = mkdtempSync(path.join(tempBase, `blue-tanuki-macos-app-smoke-${arch}-`));
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(workRoot);
    if (path.dirname(resolvedRoot) !== realpathSync(tempBase)) throw new Error("smoke temp root escaped the OS temp directory");
  } catch {
    console.error(`native_app_smoke_cleanup=held path=${workRoot} mounted=false`);
    throw new Error("cannot confirm the generated smoke temp root is contained by the OS temp directory");
  }
  const mount = path.join(resolvedRoot, "mount");
  const sourceApp = path.join(mount, "BlueTanuki.app");
  const isolatedApplications = path.join(resolvedRoot, "Applications");
  const app = path.join(isolatedApplications, "BlueTanuki.app");
  const executable = path.join(app, "Contents", "MacOS", "BlueTanuki");
  const productDataRoot = path.join(os.homedir(), "Library", "Application Support", "BlueTanuki");
  const installedStateBefore = {
    data_root: existsSync(productDataRoot),
    install_root: existsSync(path.join(productDataRoot, "app")),
  };
  let mounted = false;
  let child: ChildProcess | undefined;
  let canonicalExecutable: string | undefined;
  const spawnedAppPids = new Set<number>();
  let cleanupSafe = true;

  try {
    mkdirSync(mount);
    mkdirSync(isolatedApplications);
    run("/usr/bin/hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg],
      "read-only native app DMG mount");
    mounted = true;
    const sourceExecutable = path.join(sourceApp, "Contents", "MacOS", "BlueTanuki");
    if (!existsSync(sourceApp) || !lstatSync(sourceApp).isDirectory() ||
        !existsSync(sourceExecutable) || !lstatSync(sourceExecutable).isFile()) {
      throw new Error("native app bundle or executable is missing from the mounted DMG");
    }
    cpSync(sourceApp, app, { recursive: true, dereference: false, errorOnExist: true });
    if (!existsSync(app) || !lstatSync(app).isDirectory() || !existsSync(executable) || !lstatSync(executable).isFile()) {
      throw new Error("native app bundle copy or executable is missing from the isolated Applications directory");
    }
    const canonicalAppRoot = realpathSync(app);
    const canonicalAppExecutable = realpathSync(executable);
    if (!canonicalAppExecutable.startsWith(`${canonicalAppRoot}${path.sep}`)) {
      throw new Error("copied native app executable escaped the isolated Applications directory");
    }
    canonicalExecutable = canonicalAppExecutable;
    await detachReadOnlyImage(mount);
    mounted = false;
    console.log(`native_app_dmg_detached=before_launch architecture=${arch}`);
    if (appProcessIds(canonicalAppExecutable).length !== 0) throw new Error("a matching app process is already running");

    child = spawn("/usr/bin/open", ["-n", "-W", app], {
      cwd: root,
      env: minimalAppEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", () => resolve());
      child!.once("error", () => reject(new Error("macOS Launch Services could not start the app")));
    });

    const started = await waitUntil(() => {
      const ids = appProcessIds(canonicalAppExecutable);
      for (const pid of ids) spawnedAppPids.add(pid);
      return ids.length > 0;
    }, 20_000);
    const runningIds = appProcessIds(canonicalAppExecutable);
    for (const pid of runningIds) spawnedAppPids.add(pid);
    if (!started || runningIds.length !== 1) throw new Error("native app did not start as exactly one process");
    if (!isChildRunning(child)) throw new Error("macOS Launch Services exited before the app smoke completed");
    console.log(`native_app_process=started architecture=${arch} source=isolated_app_copy`);

    process.kill(runningIds[0], "SIGTERM");
    const stopped = await waitUntil(() => {
      const ids = appProcessIds(canonicalAppExecutable);
      for (const pid of ids) spawnedAppPids.add(pid);
      return ids.length === 0;
    }, 10_000);
    if (!stopped) {
      cleanupSafe = false;
      throw new Error("native app did not stop after the smoke process was signaled");
    }
    spawnedAppPids.clear();
    const launcherReturned = await waitUntil(() => !isChildRunning(child!), 10_000);
    if (!launcherReturned || child.exitCode !== 0) throw new Error("macOS Launch Services did not return a successful app exit");
    child = undefined;
    if (appProcessIds(canonicalAppExecutable).length !== 0) throw new Error("native app restarted after the smoke process stopped");
    if (existsSync(productDataRoot) !== installedStateBefore.data_root ||
        existsSync(path.join(productDataRoot, "app")) !== installedStateBefore.install_root) {
      throw new Error("native app startup changed installed product state without an explicit user action");
    }
    console.log(`native_app_process=stopped architecture=${arch}`);
  } finally {
    if (canonicalExecutable !== undefined) {
      try {
        let ids = appProcessIds(canonicalExecutable);
        for (const pid of ids) spawnedAppPids.add(pid);
        for (const pid of spawnedAppPids) {
          if (ids.includes(pid)) process.kill(pid, "SIGTERM");
        }
        const stopped = await waitUntil(() => {
          ids = appProcessIds(canonicalExecutable!);
          for (const pid of ids) spawnedAppPids.add(pid);
          return ids.length === 0;
        }, 5_000);
        if (!stopped) cleanupSafe = false;
      } catch { cleanupSafe = false; }
    }
    if (child && isChildRunning(child)) {
      child.kill("SIGTERM");
      const returned = await waitUntil(() => !isChildRunning(child!), 5_000);
      if (!returned) cleanupSafe = false;
    }
    if (canonicalExecutable !== undefined) {
      try {
        if (appProcessIds(canonicalExecutable).length !== 0) cleanupSafe = false;
      } catch { cleanupSafe = false; }
    }
    if (mounted && cleanupSafe) {
      try {
        await detachReadOnlyImage(mount);
        mounted = false;
      } catch (error) {
        cleanupSafe = false;
        console.error(`native_app_dmg_detach=failed reason=${error instanceof Error ? error.message : "unknown failure"}`);
      }
    }
    if (cleanupSafe && !mounted) {
      rmSync(resolvedRoot, { recursive: true, force: true });
      if (existsSync(resolvedRoot)) throw new Error("isolated app smoke temp root remains after cleanup");
    } else {
      console.error(`native_app_smoke_cleanup=held path=${resolvedRoot} mounted=${mounted}`);
      throw new Error("native app smoke left an active process or mounted image; isolated evidence was retained");
    }
  }
}

async function main(): Promise<void> {
  const arch = argument("arch");
  if (arch !== "x64" && arch !== "arm64") throw new Error("--arch must be x64 or arm64");
  await smoke(arch);
  console.log(`native_app_start_quit_smoke=pass architecture=${arch}`);
}

main().catch((error) => {
  console.error(`[macos-app-smoke] FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
