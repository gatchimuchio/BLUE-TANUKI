import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

export const PLAYWRIGHT_CORE_VERSION = "1.65.0";

export type BrowserRuntimeTarget = {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64";
};

interface PlaywrightPackageMetadata {
  version?: string;
}

interface PlaywrightBrowsersMetadata {
  browsers?: Array<{ name?: string; revision?: string }>;
}

export interface InstalledHeadlessShell {
  revision: string;
  executable: string;
}

export function parseHeadlessShellRevision(metadataText: string): string {
  const metadata = JSON.parse(metadataText) as PlaywrightBrowsersMetadata;
  const shell = metadata.browsers?.find((browser) => browser.name === "chromium-headless-shell");
  if (!shell?.revision || !/^\d+$/u.test(shell.revision)) {
    throw new Error("packaged Playwright metadata has no valid Chromium headless-shell revision");
  }
  return shell.revision;
}

export function assertPackageLocalBrowserRegistrySource(source: string): void {
  if (!source.includes('process.env.PLAYWRIGHT_BROWSERS_PATH = "0"') ||
      !source.includes('PLAYWRIGHT_BROWSERS_PATH: "0"')) {
    throw new Error("packaged browser runtime must select the app-local Playwright registry before import and launch");
  }
}

export function readHeadlessShellRevision(appRoot: string): string {
  const playwrightRoot = path.join(appRoot, "node_modules", "playwright-core");
  const packageJson = JSON.parse(
    readFileSync(path.join(playwrightRoot, "package.json"), "utf8"),
  ) as PlaywrightPackageMetadata;
  if (packageJson.version !== PLAYWRIGHT_CORE_VERSION) {
    throw new Error(`packaged playwright-core must be ${PLAYWRIGHT_CORE_VERSION}`);
  }
  return parseHeadlessShellRevision(readFileSync(path.join(playwrightRoot, "browsers.json"), "utf8"));
}

export function headlessShellExecutableRelativePath(
  target: BrowserRuntimeTarget,
  revision: string,
): string {
  if (!/^\d+$/u.test(revision)) throw new Error("Chromium headless-shell revision must be numeric");
  let browserPlatform: string;
  if (target.platform === "win32" && target.arch === "x64") browserPlatform = "win64";
  else if (target.platform === "linux" && target.arch === "x64") browserPlatform = "linux64";
  else if (target.platform === "darwin" && target.arch === "x64") browserPlatform = "mac-x64";
  else if (target.platform === "darwin" && target.arch === "arm64") browserPlatform = "mac-arm64";
  else throw new Error(`unsupported Playwright headless-shell target: ${target.platform}-${target.arch}`);

  const executable = target.platform === "win32"
    ? "chrome-headless-shell.exe"
    : "chrome-headless-shell";
  return path.posix.join(
    "node_modules/playwright-core/.local-browsers",
    `chromium_headless_shell-${revision}`,
    `chrome-headless-shell-${browserPlatform}`,
    executable,
  );
}

export function findInstalledHeadlessShell(
  appRoot: string,
  target: BrowserRuntimeTarget,
): InstalledHeadlessShell {
  const revision = readHeadlessShellRevision(appRoot);
  const executable = headlessShellExecutableRelativePath(target, revision);
  if (!existsSync(path.join(appRoot, ...executable.split("/")))) {
    throw new Error(`packaged Chromium headless-shell executable is missing: ${executable}`);
  }
  return { revision, executable };
}

export function installHeadlessShell(
  appRoot: string,
  target: BrowserRuntimeTarget,
): InstalledHeadlessShell {
  const cli = path.join(appRoot, "node_modules", "playwright-core", "cli.js");
  if (!existsSync(cli)) throw new Error("packaged Playwright Core CLI is missing");
  const install = spawnSync(process.execPath, [cli, "install", "--only-shell", "chromium"], {
    cwd: appRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    stdio: "inherit",
  });
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new Error(`Playwright Chromium headless-shell install failed (exit=${install.status})`);
  }
  return findInstalledHeadlessShell(appRoot, target);
}
