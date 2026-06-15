import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORE_RELEASE_ALLOWLIST,
  PREVIEW_PACKAGE_PATHS,
  importEdges,
  validateRepoHealthGate,
} from "../../../scripts/repo_health_gate.ts";

let root: string;

async function writeFile(rel: string, text: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
}

async function writeRepoHealthFixture(opts: {
  cliRouter?: string;
  packageScripts?: Record<string, string>;
  gatewayDependencies?: Record<string, string>;
  releaseAllowlist?: readonly string[];
} = {}): Promise<void> {
  await writeFile(
    "package.json",
    JSON.stringify({
      name: "repo-health-fixture",
      scripts: opts.packageScripts ?? {
        "validate:repo-health": "tsx scripts/repo_health_gate.ts",
      },
    }, null, 2),
  );
  await writeFile(
    "apps/gateway/package.json",
    JSON.stringify({
      name: "@blue-tanuki/gateway",
      dependencies: opts.gatewayDependencies ?? {
        "@blue-tanuki/core": "workspace:*",
      },
    }, null, 2),
  );
  await writeFile(
    "apps/gateway/src/main.ts",
    [
      'import { runGatewayCliRouter } from "./cli_router.js";',
      "void runGatewayCliRouter();",
    ].join("\n"),
  );
  await writeFile(
    "apps/gateway/src/cli_router.ts",
    opts.cliRouter ?? [
      'const diagnosticImportText = "import \\"./doctor.js\\"";',
      '// import "./setup.js"',
      "export async function runGatewayCliRouter(): Promise<void> {",
      '  if (process.argv.includes("--doctor")) await import("./doctor.js");',
      "}",
    ].join("\n"),
  );
  await writeFile(
    "docs/repository-health-inventory.md",
    [...CORE_RELEASE_ALLOWLIST, ...PREVIEW_PACKAGE_PATHS].join("\n"),
  );
  await writeFile("docs/preview-scope.md", PREVIEW_PACKAGE_PATHS.join("\n"));
  const releaseAllowlist = opts.releaseAllowlist ?? CORE_RELEASE_ALLOWLIST;
  await writeFile(
    "scripts/create_release_bundle.ts",
    `const CORE_RELEASE_PATHS = ${JSON.stringify(releaseAllowlist)} as const;\n`,
  );
}

describe("repo health gate", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-repo-health-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses the TypeScript AST instead of matching comments or string content", () => {
    const edges = importEdges([
      '// import "./doctor.js"',
      'const text = "export * from \\"./setup.js\\"";',
      'import type { CheckResult } from "./doctor.js";',
      'export type { DoctorReport } from "./doctor.js";',
      'if (ready) await import("./runtime.js");',
    ].join("\n"));

    expect(edges).toEqual([
      { kind: "import", specifier: "./doctor.js", type_only: true },
      { kind: "export", specifier: "./doctor.js", type_only: true },
      { kind: "dynamic", specifier: "./runtime.js", type_only: false },
    ]);
  });

  it("passes when preview packages are absent but documented and not hard dependencies", async () => {
    await writeRepoHealthFixture();

    expect(() => validateRepoHealthGate(root)).not.toThrow();
  });

  it("rejects an invalid production import graph", async () => {
    await writeRepoHealthFixture({
      cliRouter: [
        'import "./doctor.js";',
        "export async function runGatewayCliRouter(): Promise<void> {}",
      ].join("\n"),
    });

    expect(() => validateRepoHealthGate(root)).toThrow(/forbidden import \.\/doctor\.js/);
  });

  it("rejects non-literal dynamic imports in the production graph", async () => {
    await writeRepoHealthFixture({
      cliRouter: [
        'const target = "./doctor.js";',
        "export async function runGatewayCliRouter(): Promise<void> {",
        "  await import(target);",
        "}",
      ].join("\n"),
    });

    expect(() => validateRepoHealthGate(root)).toThrow(/non-literal dynamic import/);
  });

  it("rejects forbidden pnpm wrapper revival", async () => {
    await writeRepoHealthFixture({
      packageScripts: {
        build: "node scripts/pnpm_exec.mjs build",
      },
    });

    expect(() => validateRepoHealthGate(root)).toThrow(/custom pnpm wrapper/);
  });

  it("rejects passWithNoTests in package scripts", async () => {
    await writeRepoHealthFixture({
      packageScripts: {
        test: "node node_modules/vitest/vitest.mjs run --passWithNoTests",
      },
    });

    expect(() => validateRepoHealthGate(root)).toThrow(/passWithNoTests/);
  });

  it("rejects hard preview dependencies from the gateway package", async () => {
    await writeRepoHealthFixture({
      gatewayDependencies: {
        "@blue-tanuki/core": "workspace:*",
        "@blue-tanuki/channel-slack": "workspace:*",
      },
    });

    expect(() => validateRepoHealthGate(root)).toThrow(/hard preview dependency/);
  });

  it("rejects production fetch calls without an AbortController signal", async () => {
    await writeRepoHealthFixture();
    await writeFile(
      "packages/example/src/external.ts",
      [
        "export async function callExternal(): Promise<Response> {",
        '  return await fetch("https://example.test/api", { method: "GET" });',
        "}",
      ].join("\n"),
    );

    expect(() => validateRepoHealthGate(root)).toThrow(/fetch calls without AbortController signal/);
  });

  it("accepts production fetch calls with an AbortController signal", async () => {
    await writeRepoHealthFixture();
    await writeFile(
      "packages/example/src/external.ts",
      [
        "export async function callExternal(signal: AbortSignal): Promise<Response> {",
        '  return await fetch("https://example.test/api", { method: "GET", signal });',
        "}",
      ].join("\n"),
    );

    expect(() => validateRepoHealthGate(root)).not.toThrow();
  });
});
