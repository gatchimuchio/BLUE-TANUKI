import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  PRODUCT_SCOPE_CORE_RELEASE_PATHS,
  PRODUCT_SCOPE_PREVIEW_PATHS,
} from "../packages/protocol/src/product_scope_contract.js";

export const FORBIDDEN_FILES = [
  "scripts/pnpm_exec.mjs",
  "scripts/pnpm-exec.mjs",
  "scripts/pnpm_exec.js",
] as const;

export const GRAPH_ROOTS = ["apps/gateway/src/main.ts"] as const;
export const PRODUCTION_GRAPH_ALLOWED = new Set([
  "apps/gateway/src/main.ts",
  "apps/gateway/src/cli_router.ts",
  "apps/gateway/src/env_file.ts",
  "apps/gateway/src/audit_config.ts",
]);
export const FORBIDDEN_GRAPH_FILES = [
  "apps/gateway/src/doctor.ts",
  "apps/gateway/src/setup.ts",
  "apps/gateway/src/audit_dump.ts",
  "apps/gateway/src/audit_verify.ts",
  "apps/gateway/src/serve.ts",
  "apps/gateway/src/runtime.ts",
] as const;
export const FORBIDDEN_IMPORT_SPECIFIERS = [
  "./doctor.js",
  "./setup.js",
  "./audit_dump.js",
  "./audit_verify.js",
  "./repair.js",
  "./serve.js",
  "./runtime.js",
  "../install",
  "install/installer",
] as const;

export const COMMAND_GATED_CLI_DYNAMIC_IMPORTS = [
  "./doctor.js",
  "./setup.js",
  "./audit_dump.js",
  "./audit_verify.js",
  "./serve.js",
  "./runtime.js",
] as const;

export const CORE_RELEASE_ALLOWLIST = PRODUCT_SCOPE_CORE_RELEASE_PATHS;

export const PREVIEW_PACKAGE_PATHS = PRODUCT_SCOPE_PREVIEW_PATHS;

export interface ImportEdge {
  kind: "import" | "export" | "dynamic" | "dynamic_nonliteral";
  specifier: string;
  type_only: boolean;
}

function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function fail(message: string): never {
  throw new Error(`repo health gate failed: ${message}`);
}

function assertForbiddenFilesAbsent(root: string): void {
  for (const rel of FORBIDDEN_FILES) {
    if (existsSync(path.join(root, rel))) fail(`forbidden file exists: ${rel}`);
  }
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

export function importEdges(text: string, rel = "source.ts"): ImportEdge[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier) {
        edges.push({
          kind: "import",
          specifier,
          type_only: node.importClause?.isTypeOnly === true,
        });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier) {
        edges.push({
          kind: "export",
          specifier,
          type_only: node.isTypeOnly === true,
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      edges.push({
        kind: specifier ? "dynamic" : "dynamic_nonliteral",
        specifier: specifier ?? "<non-literal>",
        type_only: false,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return edges;
}

function resolveLocalImport(root: string, fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.dirname(fromRel);
  const withoutJs = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
  const candidates = [
    path.normalize(path.join(base, `${withoutJs}.ts`)).replace(/\\/g, "/"),
    path.normalize(path.join(base, withoutJs, "index.ts")).replace(/\\/g, "/"),
  ];
  return candidates.find((candidate) => existsSync(path.join(root, candidate))) ?? null;
}

function assertNoForbiddenProductionImports(root: string): void {
  const checked = new Set<string>();
  const queue = [...GRAPH_ROOTS];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (checked.has(rel)) continue;
    checked.add(rel);
    if (!PRODUCTION_GRAPH_ALLOWED.has(rel)) {
      fail(`production CLI graph reached non-allowed file: ${rel}`);
    }
    const text = read(root, rel);
    for (const edge of importEdges(text)) {
      const commandGatedCliDynamic =
        rel === "apps/gateway/src/cli_router.ts" &&
        edge.kind === "dynamic" &&
        (COMMAND_GATED_CLI_DYNAMIC_IMPORTS as readonly string[]).includes(edge.specifier);
      if (edge.kind === "dynamic_nonliteral") {
        fail(`${rel}: non-literal dynamic import is not allowed in production CLI graph`);
      }
      if (
        !edge.type_only &&
        !commandGatedCliDynamic &&
        FORBIDDEN_IMPORT_SPECIFIERS.some((forbidden) => edge.specifier.includes(forbidden))
      ) {
        fail(`${rel}: forbidden ${edge.kind} ${edge.specifier}`);
      }
      if (edge.kind === "dynamic") continue;
      if (edge.type_only) continue;
      const resolved = resolveLocalImport(root, rel, edge.specifier);
      if (!resolved) continue;
      if (FORBIDDEN_GRAPH_FILES.includes(resolved as (typeof FORBIDDEN_GRAPH_FILES)[number])) {
        fail(`${rel}: ${edge.kind} import reaches forbidden production graph file ${resolved}`);
      }
      queue.push(resolved);
    }
  }
}

function assertPackageScriptsUseNativePnpm(root: string): void {
  for (const rel of packageJsonFiles(root)) {
    const pkg = JSON.parse(read(root, rel)) as { scripts?: Record<string, string> };
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (/pnpm[_-]?exec|scripts\/pnpm/i.test(script)) {
        fail(`${rel} script ${name} uses a custom pnpm wrapper`);
      }
      if (script.includes("--passWithNoTests")) {
        fail(`${rel} script ${name} uses forbidden --passWithNoTests`);
      }
    }
  }
}

function packageJsonFiles(root: string): string[] {
  return [
    ...(existsSync(path.join(root, "package.json")) ? ["package.json"] : []),
    ...walkPackageJsonFiles(root, "apps"),
    ...walkPackageJsonFiles(root, "packages"),
    ...walkPackageJsonFiles(root, "install"),
  ];
}

function walkPackageJsonFiles(root: string, rel: string): string[] {
  const full = path.join(root, rel);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (stat.isFile()) return rel.endsWith("package.json") ? [rel] : [];
  return readdirSync(full).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") return [];
    const childRel = path.join(rel, entry).replace(/\\/g, "/");
    return walkPackageJsonFiles(root, childRel);
  });
}

function assertGatewayCoreDependenciesOnly(root: string): void {
  const pkg = JSON.parse(read(root, "apps/gateway/package.json")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  const forbidden = [
    "@blue-tanuki/channel-slack",
    "@blue-tanuki/channel-discord",
    "@blue-tanuki/channel-teams",
    "@blue-tanuki/channel-line",
  ];
  for (const dep of forbidden) {
    if (deps.includes(dep)) fail(`apps/gateway has hard preview dependency: ${dep}`);
  }
}

function assertPreviewScopeDocumented(root: string): void {
  const inventory = read(root, "docs/repository-health-inventory.md");
  const preview = read(root, "docs/preview-scope.md");
  for (const rel of CORE_RELEASE_ALLOWLIST) {
    if (!inventory.includes(rel)) fail(`inventory missing core release path ${rel}`);
  }
  for (const rel of PREVIEW_PACKAGE_PATHS) {
    if (!inventory.includes(rel) || !preview.includes(rel)) {
      fail(`preview/archive path is not documented in both inventory and preview scope: ${rel}`);
    }
  }
}

function assertReleaseBundleDeclaresCoreBoundary(root: string): void {
  const release = read(root, "scripts/create_release_bundle.ts");
  if (!release.includes("CORE_RELEASE_PATHS")) {
    fail("release bundle creator must declare CORE_RELEASE_PATHS");
  }
  for (const rel of PREVIEW_PACKAGE_PATHS) {
    if (release.includes(`\"${rel}\"`) || release.includes(`'${rel}'`)) {
      fail(`release core bundle allowlist includes preview/archive path: ${rel}`);
    }
  }
}

function sourceTsFiles(root: string, rel: string): string[] {
  const full = path.join(root, rel);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (stat.isFile()) return rel.endsWith(".ts") ? [rel] : [];
  return readdirSync(full).flatMap((entry) => {
    const childRel = path.join(rel, entry).replace(/\\/g, "/");
    const childFull = path.join(root, childRel);
    const childStat = statSync(childFull);
    if (childStat.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") return [];
      return sourceTsFiles(root, childRel);
    }
    return childRel.endsWith(".ts") ? [childRel] : [];
  });
}

function objectLiteralHasSignal(node: ts.Node | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    const name = property.name;
    return (
      (ts.isIdentifier(name) && name.text === "signal") ||
      (ts.isStringLiteral(name) && name.text === "signal")
    );
  });
}

function assertProductionFetchCallsHaveAbortSignal(root: string): void {
  const files = [
    ...sourceTsFiles(root, "apps/gateway/src"),
    ...sourceTsFiles(root, "packages"),
  ].filter((rel) => rel.includes("/src/"));
  const violations: string[] = [];
  for (const rel of files) {
    const text = read(root, rel);
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const called =
          ts.isIdentifier(expression) &&
          (expression.text === "fetch" || expression.text === "fetchImpl");
        if (called && !objectLiteralHasSignal(node.arguments[1])) {
          violations.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (violations.length > 0) {
    fail(`external fetch calls without AbortController signal: ${violations.join(", ")}`);
  }
}

export function validateRepoHealthGate(rootDir = process.cwd()): void {
  const root = path.resolve(rootDir);
  assertForbiddenFilesAbsent(root);
  assertNoForbiddenProductionImports(root);
  assertPackageScriptsUseNativePnpm(root);
  assertGatewayCoreDependenciesOnly(root);
  assertPreviewScopeDocumented(root);
  assertReleaseBundleDeclaresCoreBoundary(root);
  assertProductionFetchCallsHaveAbortSignal(root);
}

function main(): void {
  validateRepoHealthGate(process.cwd());
  process.stdout.write("repo health gate passed\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
