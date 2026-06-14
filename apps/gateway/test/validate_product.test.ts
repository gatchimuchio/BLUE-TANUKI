import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRODUCT_CHECKS,
  exitCodeFromProductValidation,
  filterProductChecks,
  listProductChecks,
  pnpmCommandSpec,
  productSummaryLine,
  runProductValidation,
  type CommandRunner,
  type ProductCheck,
} from "../../../scripts/validate_product.ts";

let root: string;

const metadataRunner: CommandRunner = async (spec) => ({
  exit_code: 0,
  stdout: spec.command === "pnpm" ? "9.12.0\n" : "test-git-rev\n",
  stderr: "",
  timed_out: false,
  duration_ms: 1,
});

function check(
  id: string,
  opts: Partial<Pick<ProductCheck, "phase" | "platform" | "required">> & {
    status?: "pass" | "fail";
    raw_log?: string;
  } = {},
): ProductCheck {
  return {
    id,
    phase: opts.phase ?? "P2",
    platform: opts.platform ?? "any",
    required: opts.required ?? true,
    run: async () => ({
      status: opts.status ?? "pass",
      summary: `${id} ${opts.status ?? "pass"}`,
      raw_log: opts.raw_log ?? `${id} raw log`,
    }),
  };
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(root, rel), "utf8")) as T;
}

describe("validate_product gate", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-validate-product-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("filters checks by reached phase while reporting future and platform skips", async () => {
    const checks = [
      check("p2.pass"),
      check("p3.future", { phase: "P3" }),
      check("p2.win", { platform: "win32" }),
    ];

    const result = await runProductValidation({
      rootDir: root,
      evidenceDir: path.join(root, "evidence"),
      phase: "P2",
      platform: "linux",
      checks,
      runner: metadataRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.required).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.checks.map((item) => [item.id, item.status])).toEqual([
      ["p2.pass", "pass"],
      ["p3.future", "skipped"],
      ["p2.win", "skipped"],
    ]);
    expect(filterProductChecks(checks, "P2").map((item) => item.id)).toEqual(["p2.pass", "p2.win"]);
  });

  it("propagates a failed check into a non-zero gate result", async () => {
    const result = await runProductValidation({
      rootDir: root,
      evidenceDir: path.join(root, "evidence"),
      phase: "P2",
      checks: [check("p2.fail", { status: "fail" })],
      runner: metadataRunner,
    });

    expect(result.ok).toBe(false);
    expect(exitCodeFromProductValidation(result)).toBe(1);
    expect(productSummaryLine(result)).toContain("[product] FAIL phase=P2 required=1 passed=0 failed=1 skipped=0");
  });

  it("writes evidence logs, checks, environment, and matching sha256 manifest entries", async () => {
    const evidenceDir = path.join(root, "evidence");
    const result = await runProductValidation({
      rootDir: root,
      evidenceDir,
      phase: "P2",
      checks: [
        check("p2.evidence", {
          raw_log: 'token=secret-value {"content":"do not persist"}',
        }),
      ],
      runner: metadataRunner,
      now: new Date("2026-06-11T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    const manifest = await readJson<{
      manifest_excludes_self: true;
      files: Array<{ path: string; sha256: string; bytes: number }>;
    }>("evidence/manifest.json");
    expect(manifest.manifest_excludes_self).toBe(true);
    const logRel = "logs/p2.evidence.log";
    const logText = await fs.readFile(path.join(evidenceDir, logRel), "utf8");
    expect(logText).toContain("token=[redacted]");
    expect(logText).toContain('"content":"[redacted]"');
    expect(logText).not.toContain("secret-value");
    expect(logText).not.toContain("do not persist");

    const checksEntry = manifest.files.find((file) => file.path === "checks.json");
    expect(checksEntry).toBeDefined();
    const checksBytes = await fs.readFile(path.join(evidenceDir, "checks.json"));
    expect(checksEntry?.sha256).toBe(createHash("sha256").update(checksBytes).digest("hex"));
  });

  it("keeps child process execution mockable through CheckContext.runner", async () => {
    const checks: ProductCheck[] = [
      {
        id: "p2.runner",
        phase: "P2",
        platform: "any",
        required: true,
        run: async (ctx) => {
          const run = await ctx.runner(
            { command: "mock-command", args: ["--ok"], cwd: ctx.rootDir },
            ctx.timeoutMs,
          );
          return {
            status: run.exit_code === 0 ? "pass" : "fail",
            summary: `exit=${String(run.exit_code)}`,
            raw_log: run.stdout,
          };
        },
      },
    ];
    const runner: CommandRunner = async (spec) => ({
      exit_code: spec.command === "mock-command" ? 7 : 0,
      stdout: "mock stdout",
      stderr: "",
      timed_out: false,
      duration_ms: 1,
    });

    const result = await runProductValidation({
      rootDir: root,
      evidenceDir: path.join(root, "evidence"),
      phase: "P2",
      checks,
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.summary).toBe("exit=7");
  });

  it("lists registered product checks with id and phase metadata", () => {
    expect(listProductChecks([check("p2.list")])).toContain("p2.list\tphase=P2\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p2.test_suite\tphase=P2\tplatform=linux\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p3.package_windows_verify\tphase=P3\tplatform=win32\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p3.windows_installed_smoke\tphase=P3\tplatform=win32\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p4.control_center_settings_api\tphase=P4\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p5.llm_resilience_health\tphase=P5\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p6.approval_authority_controls\tphase=P6\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p7.evidence_pack_redaction\tphase=P7\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p8.composio_safety_closure\tphase=P8\tplatform=any\trequired=true");
    expect(listProductChecks(PRODUCT_CHECKS)).toContain("p9.channel_operator_extension_boundary\tphase=P9\tplatform=any\trequired=true");
  });

  it("builds a Windows-safe pnpm command spec without relying on extension resolution", () => {
    expect(pnpmCommandSpec(["test"], root, {}, "win32")).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm", "test"],
      cwd: root,
    });
    expect(pnpmCommandSpec(["test"], root, { npm_execpath: "C:\\pnpm\\pnpm.cjs" }, "win32")).toMatchObject({
      command: process.execPath,
      args: ["C:\\pnpm\\pnpm.cjs", "test"],
      cwd: root,
    });
  });
});
