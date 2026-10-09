import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface AgiTestSelector {
  testFile: string;
  testNamePattern: string;
}

export interface AgiTestCase {
  id: string;
  unitId: string;
  implementation: "IMPLEMENTED" | "NOT_IMPLEMENTED";
  selector?: AgiTestSelector;
  note?: string;
}

export interface AgiExecution {
  exitCode: number | null;
  passedTests: number;
  failedTests: number;
  totalTests: number;
  reportValid: boolean;
  timedOut: boolean;
  cleanupSucceeded: boolean;
  launchError?: string;
  failureReason?: string;
}

export type AgiFailureCode =
  | "UNREGISTERED"
  | "NO_CASES"
  | "NOT_IMPLEMENTED"
  | "INVALID_ARGUMENT"
  | "INVALID_REGISTRY";

export interface AgiCaseOutcome {
  id: string;
  status: "PASS" | "FAIL" | "NOT_IMPLEMENTED";
  passedTests: number;
  failedTests: number;
  message: string;
}

export interface AgiValidationResult {
  exitCode: 0 | 1 | 2;
  failureCode?: AgiFailureCode;
  message?: string;
  outcomes: AgiCaseOutcome[];
}

export interface AgiSelection {
  unitId?: string;
  caseId?: string;
}

export type AgiSelectorRunner = (
  selector: AgiTestSelector,
  rootDir: string,
) => Promise<AgiExecution>;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_CLI = path.join(ROOT_DIR, "node_modules", "vitest", "vitest.mjs");
const DEFAULT_TIMEOUT_MS = 120_000;

export const AGI_UNIT_IDS = ["C01", "C01.01", "C01.02", "C01.03"] as const;

export const AGI_TEST_CASES: readonly AgiTestCase[] = [
  {
    id: "BT-U-C01.01-P",
    unitId: "C01.01",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "packages/protocol/test/common_record.test.ts",
      testNamePattern: "BT-U-C01.01-P",
    },
  },
  {
    id: "BT-U-C01.01-N",
    unitId: "C01.01",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "packages/protocol/test/common_record.test.ts",
      testNamePattern: "BT-U-C01.01-N",
    },
  },
  {
    id: "BT-U-C01.02-P",
    unitId: "C01.02",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "packages/protocol/test/境界交換契約.test.ts",
      testNamePattern: "BT-U-C01.02-P",
    },
  },
  {
    id: "BT-U-C01.02-N",
    unitId: "C01.02",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "packages/protocol/test/境界交換契約.test.ts",
      testNamePattern: "BT-U-C01.02-N",
    },
  },
  {
    id: "BT-U-C01.03-P",
    unitId: "C01.03",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "scripts/validate_agi.test.ts",
      testNamePattern: "BT-U-C01.03-P",
    },
  },
  {
    id: "BT-U-C01.03-N",
    unitId: "C01.03",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "scripts/validate_agi.test.ts",
      testNamePattern: "BT-U-C01.03-N",
    },
  },
  {
    id: "BT-T-C01-01",
    unitId: "C01",
    implementation: "NOT_IMPLEMENTED",
    note: "親scenario全体を実行するconsumerは未接続。C01.01の局所sliceを親PASSへ昇格しない。",
  },
  {
    id: "BT-T-C01-02",
    unitId: "C01",
    implementation: "NOT_IMPLEMENTED",
    note: "親scenario全体の受入selectorは未接続。",
  },
  {
    id: "BT-T-C01-03",
    unitId: "C01",
    implementation: "IMPLEMENTED",
    selector: {
      testFile: "scripts/validate_agi.test.ts",
      testNamePattern: "BT-U-C01.03-N",
    },
    note: "未実装caseを非成功で返すrunner負例の検証。製品runtime証拠ではない。",
  },
  {
    id: "BT-T-C01-04",
    unitId: "C01",
    implementation: "NOT_IMPLEMENTED",
    note: "旧履歴投影の局所testはあるが、親scenario全体の受入selectorは未接続。",
  },
];

export type ParsedAgiArgs =
  | { kind: "run"; selection: AgiSelection }
  | { kind: "list" }
  | { kind: "help" };

export function parseAgiArgs(argv: string[]): ParsedAgiArgs {
  const args = argv.filter((arg) => arg !== "--");
  const selection: AgiSelection = {};
  let list = false;
  let help = false;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--list") {
      if (seen.has(arg)) throw new Error("--list may be specified once");
      seen.add(arg);
      list = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--unit" || arg === "--case") {
      if (seen.has(arg)) throw new Error(`${arg} may be specified once`);
      seen.add(arg);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires an ID`);
      index += 1;
      if (arg === "--unit") selection.unitId = value;
      else selection.caseId = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (help && (list || selection.unitId || selection.caseId)) {
    throw new Error("--help cannot be combined with another option");
  }
  if (help) return { kind: "help" };
  if (list && (selection.unitId || selection.caseId)) {
    throw new Error("--list cannot be combined with --unit or --case");
  }
  if (list) return { kind: "list" };
  if (!selection.unitId && !selection.caseId) {
    throw new Error("specify --unit or --case; use --list to inspect registered cases");
  }
  return { kind: "run", selection };
}

export function resolveAgiCases(
  selection: AgiSelection,
  cases: readonly AgiTestCase[] = AGI_TEST_CASES,
  knownUnitIds: readonly string[] = AGI_UNIT_IDS,
): { cases: AgiTestCase[] } | { failureCode: AgiFailureCode; message: string } {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (!testCase.id || seen.has(testCase.id)) {
      return { failureCode: "INVALID_REGISTRY", message: "case registry contains a missing or duplicate ID" };
    }
    seen.add(testCase.id);
  }

  if (!selection.unitId && !selection.caseId) {
    return { failureCode: "INVALID_ARGUMENT", message: "specify a unit or case ID" };
  }
  if (selection.unitId && !knownUnitIds.includes(selection.unitId)) {
    return { failureCode: "UNREGISTERED", message: `unit is not registered: ${selection.unitId}` };
  }
  if (selection.caseId && !cases.some((testCase) => testCase.id === selection.caseId)) {
    return { failureCode: "UNREGISTERED", message: `case is not registered: ${selection.caseId}` };
  }

  const selected = cases.filter((testCase) =>
    (!selection.unitId || testCase.unitId === selection.unitId) &&
    (!selection.caseId || testCase.id === selection.caseId),
  );
  if (selected.length === 0) {
    return { failureCode: "NO_CASES", message: "selection matched zero registered cases" };
  }
  return { cases: selected };
}

export async function runAgiValidation(options: {
  selection: AgiSelection;
  rootDir?: string;
  cases?: readonly AgiTestCase[];
  knownUnitIds?: readonly string[];
  runSelector?: AgiSelectorRunner;
}): Promise<AgiValidationResult> {
  const cases = options.cases ?? AGI_TEST_CASES;
  const resolution = resolveAgiCases(options.selection, cases, options.knownUnitIds ?? AGI_UNIT_IDS);
  if ("failureCode" in resolution) {
    return {
      exitCode: resolution.failureCode === "INVALID_ARGUMENT" ? 2 : 1,
      failureCode: resolution.failureCode,
      message: resolution.message,
      outcomes: [],
    };
  }

  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const runSelector = options.runSelector ?? runVitestSelector;
  const outcomes: AgiCaseOutcome[] = [];

  for (const testCase of resolution.cases) {
    if (testCase.implementation === "NOT_IMPLEMENTED" || !testCase.selector) {
      outcomes.push({
        id: testCase.id,
        status: "NOT_IMPLEMENTED",
        passedTests: 0,
        failedTests: 0,
        message: testCase.note ?? "no executable test selector is registered",
      });
      continue;
    }

    try {
      const execution = await runSelector(testCase.selector, rootDir);
      const passed = Number.isInteger(execution.passedTests) && execution.passedTests > 0;
      const noFailures = Number.isInteger(execution.failedTests) && execution.failedTests === 0;
      const success =
        execution.exitCode === 0 &&
        execution.reportValid &&
        !execution.timedOut &&
        execution.cleanupSucceeded &&
        passed &&
        noFailures;
      outcomes.push({
        id: testCase.id,
        status: success ? "PASS" : "FAIL",
        passedTests: execution.passedTests,
        failedTests: execution.failedTests,
        message: success
          ? `actual Vitest selector passed (${execution.passedTests} test(s))`
          : `Vitest selector did not prove success (exit=${String(execution.exitCode)}, passed=${execution.passedTests}, failed=${execution.failedTests}, report=${execution.reportValid}, timeout=${execution.timedOut}, cleanup=${execution.cleanupSucceeded}, reason=${execution.failureReason ?? "unknown"}${execution.launchError ? `, launch_error=${execution.launchError}` : ""})`,
      });
    } catch {
      outcomes.push({
        id: testCase.id,
        status: "FAIL",
        passedTests: 0,
        failedTests: 0,
        message: "Vitest selector could not be executed; rerun the printed command directly for diagnostics",
      });
    }
  }

  return {
    exitCode: outcomes.every((outcome) => outcome.status === "PASS") ? 0 : 1,
    outcomes,
  };
}

export function formatAgiValidationResult(result: AgiValidationResult, selection: AgiSelection): string[] {
  const lines: string[] = [];
  if (result.failureCode) {
    lines.push(`[agi] ${result.failureCode} ${result.message ?? "validation could not start"}`);
    lines.push("[agi] RESULT FAIL");
    return lines;
  }

  for (const outcome of result.outcomes) {
    lines.push(
      `[agi] ${outcome.status} ${outcome.id} passed=${outcome.passedTests} failed=${outcome.failedTests} ${outcome.message}`,
    );
    if (outcome.status === "FAIL") {
      const testCase = AGI_TEST_CASES.find((candidate) => candidate.id === outcome.id);
      if (testCase?.selector) {
        lines.push(`[agi] REPRO pnpm exec vitest run ${testCase.selector.testFile} -t ${testCase.selector.testNamePattern}`);
      }
    }
  }
  const selected = selection.unitId ? `unit=${selection.unitId}` : `case=${selection.caseId}`;
  lines.push(`[agi] RESULT ${result.exitCode === 0 ? "PASS" : "FAIL"} ${selected} cases=${result.outcomes.length}`);
  return lines;
}

export function listAgiCases(cases: readonly AgiTestCase[] = AGI_TEST_CASES): string {
  return cases
    .map((testCase) => `${testCase.id}\tunit=${testCase.unitId}\t${testCase.implementation}${testCase.note ? `\t${testCase.note}` : ""}`)
    .join(os.EOL);
}

async function runVitestSelector(selector: AgiTestSelector, rootDir: string): Promise<AgiExecution> {
  const root = path.resolve(rootDir);
  const requestedFile = path.resolve(root, selector.testFile);
  if (
    path.isAbsolute(selector.testFile) ||
    requestedFile === root ||
    !isPathWithin(root, requestedFile) ||
    !selector.testNamePattern.trim()
  ) {
    return failedExecution(false, true, "SELECTOR_PATH_INVALID");
  }

  let actualFile: string;
  try {
    actualFile = await realpath(requestedFile);
    if (!isPathWithin(await realpath(root), actualFile)) {
      return failedExecution(false, true, "SELECTOR_PATH_OUTSIDE_ROOT");
    }
    await access(actualFile);
  } catch {
    return failedExecution(false, true, "SELECTOR_FILE_UNAVAILABLE");
  }

  let reportPath: string | undefined;
  let execution = failedExecution(false, false);
  let stage = "VITEST_CHILD_PROCESS";
  try {
    reportPath = path.join(os.tmpdir(), `blue-tanuki-validate-agi-${randomUUID()}.json`);
    const relativeFile = path.relative(root, actualFile).split(path.sep).join("/");
    const args = [
      VITEST_CLI,
      "run",
      relativeFile,
      "--testNamePattern",
      selector.testNamePattern,
      "--reporter=json",
      "--outputFile",
      reportPath,
    ];
    stage = "VITEST_CHILD_PROCESS";
    const childResult = await runChild(process.execPath, args, root, safeTestEnvironment(), DEFAULT_TIMEOUT_MS);
    if (childResult.timedOut || childResult.exitCode !== 0) {
      execution = {
        ...failedExecution(
          childResult.timedOut,
          false,
          childResult.timedOut ? "VITEST_TIMEOUT" : childResult.exitCode === null ? "VITEST_LAUNCH_FAILED" : "VITEST_EXIT_NONZERO",
        ),
        exitCode: childResult.exitCode,
        ...(childResult.launchError ? { launchError: childResult.launchError } : {}),
      };
    } else {
      stage = "VITEST_JSON_REPORT";
      const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
      const passedTests = report.numPassedTests;
      const failedTests = report.numFailedTests;
      const totalTests = report.numTotalTests;
      const reportValid =
        Number.isInteger(passedTests) &&
        Number.isInteger(failedTests) &&
        Number.isInteger(totalTests) &&
        Number(passedTests) >= 0 &&
        Number(failedTests) >= 0 &&
        Number(totalTests) >= Number(passedTests) + Number(failedTests);
      execution = {
        exitCode: childResult.exitCode,
        passedTests: reportValid ? Number(passedTests) : 0,
        failedTests: reportValid ? Number(failedTests) : 0,
        totalTests: reportValid ? Number(totalTests) : 0,
        reportValid,
        timedOut: false,
        cleanupSucceeded: false,
      };
    }
  } catch (error) {
    execution = failedExecution(false, false, `${stage}_FAILED`);
    if (error instanceof Error) {
      execution.launchError =
        (error as NodeJS.ErrnoException).code ?? `${error.name}:${error.message.slice(0, 120)}`;
    }
  } finally {
    if (reportPath) {
      try {
        await rm(reportPath, { force: true });
        execution.cleanupSucceeded = true;
      } catch {
        execution.cleanupSucceeded = false;
        execution.failureReason = "TEMP_REPORT_CLEANUP_FAILED";
      }
    }
  }
  return execution;
}

function failedExecution(timedOut: boolean, cleanupSucceeded: boolean, failureReason?: string): AgiExecution {
  return {
    exitCode: null,
    passedTests: 0,
    failedTests: 0,
    totalTests: 0,
    reportValid: false,
    timedOut,
    cleanupSucceeded,
    ...(failureReason ? { failureReason } : {}),
  };
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeTestEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
  ];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", NO_COLOR: "1" };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function runChild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean; launchError?: string }> {
  return new Promise((resolve) => {
    let completed = false;
    let timedOut = false;
    let launchError: string | undefined;
    const child = spawn(command, args, { cwd, env, shell: false, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, ...(launchError ? { launchError } : {}) });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      launchError = error.code ?? "SPAWN_ERROR";
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: pnpm validate:agi -- --unit <ID>",
      "       pnpm validate:agi -- --case <ID>",
      "       pnpm validate:agi -- --list",
      "",
      "Options:",
      "  --unit <ID>  Run cases registered to the exact unit ID.",
      "  --case <ID>  Run one exact registered case ID.",
      "  --list       List case IDs and whether an executable test selector exists.",
    ].join(os.EOL) + os.EOL,
  );
}

async function main(): Promise<void> {
  let args: ParsedAgiArgs;
  try {
    args = parseAgiArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[agi] INVALID_ARGUMENT ${error instanceof Error ? error.message : "invalid arguments"}${os.EOL}`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (args.kind === "help") {
    printUsage();
    return;
  }
  if (args.kind === "list") {
    process.stdout.write(`${listAgiCases()}${os.EOL}`);
    return;
  }

  const result = await runAgiValidation({ selection: args.selection, rootDir: ROOT_DIR });
  for (const line of formatAgiValidationResult(result, args.selection)) {
    process.stdout.write(`${line}${os.EOL}`);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`[agi] FAIL runner terminated unexpectedly${os.EOL}`);
    process.exitCode = 1;
  });
}
