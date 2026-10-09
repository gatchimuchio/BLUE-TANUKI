import { describe, expect, it, vi } from "vitest";
import {
  AGI_TEST_CASES,
  parseAgiArgs,
  resolveAgiCases,
  runAgiValidation,
  type AgiExecution,
  type AgiTestCase,
} from "./validate_agi.ts";

function successfulExecution(): AgiExecution {
  return {
    exitCode: 0,
    passedTests: 1,
    failedTests: 0,
    totalTests: 1,
    reportValid: true,
    timedOut: false,
    cleanupSucceeded: true,
  };
}

describe("BT-U-C01.03-P validate:agi real test selector contract", () => {
  it("runs every implemented case for C01.03 and requires measured Vitest results", async () => {
    const selectors: string[] = [];
    const result = await runAgiValidation({
      selection: { unitId: "C01.03" },
      cases: AGI_TEST_CASES,
      runSelector: async (selector) => {
        selectors.push(selector.testNamePattern);
        return successfulExecution();
      },
    });

    expect(selectors).toEqual(["BT-U-C01.03-P", "BT-U-C01.03-N"]);
    expect(result).toMatchObject({ exitCode: 0, outcomes: [{ status: "PASS" }, { status: "PASS" }] });
  });

  it("rejects a zero-test report even when the child process exits successfully", async () => {
    const zeroTests: AgiExecution = { ...successfulExecution(), passedTests: 0, totalTests: 0 };
    const result = await runAgiValidation({
      selection: { caseId: "BT-U-C01.03-P" },
      runSelector: async () => zeroTests,
    });

    expect(result.exitCode).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ id: "BT-U-C01.03-P", status: "FAIL", passedTests: 0 });
  });
});

describe("BT-U-C01.03-N validate:agi fail-closed selection", () => {
  it("returns UNREGISTERED for unknown units and case IDs", () => {
    expect(resolveAgiCases({ unitId: "C99.99" })).toMatchObject({ failureCode: "UNREGISTERED" });
    expect(resolveAgiCases({ caseId: "BT-T-C99-99" })).toMatchObject({ failureCode: "UNREGISTERED" });
  });

  it("returns NO_CASES when a registered case does not belong to the selected unit", () => {
    expect(resolveAgiCases({ unitId: "C01.03", caseId: "BT-U-C01.02-P" })).toMatchObject({
      failureCode: "NO_CASES",
    });
  });

  it("returns NOT_IMPLEMENTED without launching a test for an unimplemented parent scenario", async () => {
    const runSelector = vi.fn(async () => successfulExecution());
    const result = await runAgiValidation({
      selection: { caseId: "BT-T-C01-01" },
      runSelector,
    });

    expect(result).toMatchObject({
      exitCode: 1,
      outcomes: [{ id: "BT-T-C01-01", status: "NOT_IMPLEMENTED", passedTests: 0 }],
    });
    expect(runSelector).not.toHaveBeenCalled();
  });

  it("rejects failed, timed-out, malformed, and uncleaned Vitest runs", async () => {
    const failures: AgiExecution[] = [
      { ...successfulExecution(), exitCode: 1 },
      { ...successfulExecution(), timedOut: true },
      { ...successfulExecution(), reportValid: false },
      { ...successfulExecution(), cleanupSucceeded: false },
      { ...successfulExecution(), failedTests: 1 },
    ];
    for (const failure of failures) {
      const result = await runAgiValidation({
        selection: { caseId: "BT-U-C01.03-P" },
        runSelector: async () => failure,
      });
      expect(result.exitCode).toBe(1);
      expect(result.outcomes[0]?.status).toBe("FAIL");
    }
  });

  it("rejects duplicate case IDs in the registry", () => {
    const duplicate: AgiTestCase[] = [AGI_TEST_CASES[0]!, AGI_TEST_CASES[0]!];
    expect(resolveAgiCases({ unitId: "C01.01" }, duplicate)).toMatchObject({ failureCode: "INVALID_REGISTRY" });
  });

  it("parses only explicit unit, case, list, and help options", () => {
    expect(parseAgiArgs(["--", "--unit", "C01.03"])).toEqual({ kind: "run", selection: { unitId: "C01.03" } });
    expect(parseAgiArgs(["--list"])).toEqual({ kind: "list" });
    expect(() => parseAgiArgs(["--unknown"])).toThrow("unknown argument");
    expect(() => parseAgiArgs(["--list", "--unit", "C01.03"])).toThrow("cannot be combined");
  });
});
