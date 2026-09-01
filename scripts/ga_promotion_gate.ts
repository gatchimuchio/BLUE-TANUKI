import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateChannelPromotion,
  type CompatibilityMatrix,
} from "./channel_promotion_gate.ts";
import { auditJapaneseBase } from "./japanese_base_gate.ts";

export type GaBarStatus = "pass" | "fail" | "pending_owner_go";

export interface GaPromotionGateOptions {
  require_owner_go?: boolean;
}

export interface GaPromotionGateResult {
  ok: boolean;
  status: "pre_go_ready" | "go_ready" | "blocked";
  owner_go: boolean;
  public_claim_allowed: boolean;
  japanese_base_strict_ready: boolean;
  package_version: string;
  bar_results: Record<"A" | "B" | "C" | "D" | "E" | "F" | "G", GaBarStatus>;
  failures: string[];
  warnings: string[];
}

interface PackageJson {
  version?: unknown;
  scripts?: Record<string, unknown>;
}

interface OwnerDecision {
  schema_version?: unknown;
  decision?: unknown;
  version?: unknown;
  decided_at?: unknown;
  ga_bar_reviewed?: unknown;
  technical_validation_reviewed?: unknown;
  public_claim_authorized?: unknown;
}

interface RequiredNeedle {
  rel: string;
  bar: "A" | "B" | "C" | "D" | "E" | "F";
  needles: readonly string[];
}

interface JapaneseBaseMigrationLedger {
  schema_version?: unknown;
  strict_ready?: unknown;
  debts?: unknown;
}

interface JapaneseBaseIndex {
  schema_version?: unknown;
  base_language?: unknown;
  normative_language_count?: unknown;
}

interface JapaneseBaseStrictAudit {
  ok?: unknown;
  migration_debts?: unknown;
  failures?: unknown;
}

export const OWNER_DECISION_PATH = "docs/ga-owner-decision.json";
export const JAPANESE_BASE_AUDIT_KEY = "__japanese_base_strict_audit__";

export const GA_REQUIRED_FILES = [
  "AGENTS.md",
  "規定/00_日本語基底規定.md",
  "規定/正本索引.json",
  "規定/局所例外台帳.json",
  "規定/移行台帳.json",
  "README.md",
  "QUICKSTART.md",
  "CLAIM.md",
  "package.json",
  "docs/GA_BAR_DEFINITION.md",
  "docs/STRATEGY_FRAME.md",
  "docs/v1.0-security-and-permanent-use-review.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/compatibility-matrix.json",
  "docs/CHANNEL_PROMOTION_GATE.md",
  "docs/PLUGIN_REVIEW_GATE.md",
  "docs/PLUGIN_HIG.md",
  "docs/SKILL_LOADER_CONTRACT.md",
  "docs/CONFORMANCE.md",
  "docs/INSTALLER_GUIDE.md",
  "docs/RESIDENT_APP_GUIDE.md",
  "docs/operator-surfaces/INDEX.md",
  "docs/operator-surfaces/WRITING_OPERATOR.md",
  "docs/operator-surfaces/DAILY_OPERATOR.md",
  "docs/operator-surfaces/DEVELOPER_OPERATOR.md",
  "packages/hds-brain/src/approval_policy.ts",
  "packages/hds-brain/test/compound_attack_scenarios.test.ts",
  "packages/hds-brain/test/fail_safe_self_health.test.ts",
  "packages/operator-writing/package.json",
  "packages/operator-daily/package.json",
  "packages/operator-developer/package.json",
  "install/README.md",
  "install/resident/README.md",
  "scripts/channel_promotion_gate.ts",
  "scripts/plugin_review_gate.ts",
  "apps/gateway/src/plugin_review_gate.ts",
] as const;

const REQUIRED_NEEDLES: readonly RequiredNeedle[] = [
  {
    rel: "docs/v1.0-security-and-permanent-use-review.md",
    bar: "A",
    needles: [
      "no known final-review bypass",
      "Runtime Invariants",
      "Hash-chain audit",
    ],
  },
  {
    rel: "packages/hds-brain/src/approval_policy.ts",
    bar: "A",
    needles: ["FINAL_REVIEW_OPERATION_LIST", "L3_final_review"],
  },
  {
    rel: "packages/hds-brain/test/compound_attack_scenarios.test.ts",
    bar: "A",
    needles: ["full_access", "L3_final_review"],
  },
  {
    rel: "packages/hds-brain/test/fail_safe_self_health.test.ts",
    bar: "A",
    needles: ["fail-safe", "SUSPEND"],
  },
  {
    rel: "docs/operator-surfaces/INDEX.md",
    bar: "B",
    needles: ["Writing Operator", "Daily Operator", "Developer Operator"],
  },
  {
    rel: "docs/operator-surfaces/WRITING_OPERATOR.md",
    bar: "B",
    needles: ["HDS-BRAIN", "ApprovalLevel"],
  },
  {
    rel: "docs/operator-surfaces/DAILY_OPERATOR.md",
    bar: "B",
    needles: ["Layer A", "ApprovalLevel"],
  },
  {
    rel: "docs/operator-surfaces/DEVELOPER_OPERATOR.md",
    bar: "B",
    needles: ["HDS-BRAIN", "ApprovalLevel"],
  },
  {
    rel: "docs/INSTALLER_GUIDE.md",
    bar: "C",
    needles: ["pnpm installer:run", "Verify LLM", "guided first-run"],
  },
  {
    rel: "install/README.md",
    bar: "C",
    needles: ["Windows", "macOS", "Linux", "doctor"],
  },
  {
    rel: "docs/RESIDENT_APP_GUIDE.md",
    bar: "D",
    needles: ["resident-start", "resident-status", "resident-autostart-enable"],
  },
  {
    rel: "install/resident/README.md",
    bar: "D",
    needles: ["resident-start", "resident-autostart-enable", "does not enable autostart"],
  },
  {
    rel: "docs/CHANNEL_PROMOTION_GATE.md",
    bar: "E",
    needles: ["pnpm validate:channels", "reserved-third-party", "owner-run evidence"],
  },
  {
    rel: "docs/compatibility-matrix.json",
    bar: "E",
    needles: ["first-party", "first-party-preview", "reserved-third-party"],
  },
  {
    rel: "docs/PLUGIN_REVIEW_GATE.md",
    bar: "F",
    needles: ["pnpm plugin:review", "blue-tanuki.review.json", "used_for_authority=false"],
  },
  {
    rel: "docs/PLUGIN_HIG.md",
    bar: "F",
    needles: ["Plugin Review Gate", "Layer B"],
  },
  {
    rel: "docs/SKILL_LOADER_CONTRACT.md",
    bar: "F",
    needles: ["Plugin Review Gate", "hot_reload: false"],
  },
];

const PUBLIC_CLAIM_FILES = ["README.md", "QUICKSTART.md", "CLAIM.md"] as const;
const FORBIDDEN_PUBLIC_CLAIM_PATTERNS = [
  /complete superiority/i,
  /superior to openclaw/i,
  /openclaw[^.\n]{0,80}superior/i,
  /beats openclaw/i,
];

export function readGaPromotionFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of GA_REQUIRED_FILES) {
    files[rel] = readFileSync(path.join(root, rel), "utf8");
  }
  const ownerDecision = path.join(root, OWNER_DECISION_PATH);
  if (existsSync(ownerDecision)) {
    files[OWNER_DECISION_PATH] = readFileSync(ownerDecision, "utf8");
  }
  files[JAPANESE_BASE_AUDIT_KEY] = JSON.stringify(
    auditJapaneseBase(root, { strict: true }),
  );
  return files;
}

export function validateGaPromotionGate(
  files: Record<string, string>,
  opts: GaPromotionGateOptions = {},
): GaPromotionGateResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const barFailures: Record<"A" | "B" | "C" | "D" | "E" | "F", number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
    F: 0,
  };

  for (const rel of GA_REQUIRED_FILES) {
    if (!files[rel]) {
      failures.push(`${rel}: missing required GA evidence file`);
    }
  }

  for (const req of REQUIRED_NEEDLES) {
    const text = files[req.rel] ?? "";
    for (const needle of req.needles) {
      if (!text.includes(needle)) {
        failures.push(`${req.rel}: missing ${needle}`);
        barFailures[req.bar] += 1;
      }
    }
  }

  const pkg = parsePackage(files["package.json"], failures);
  const packageVersion = typeof pkg?.version === "string" ? pkg.version : "(invalid)";
  if (pkg?.scripts?.["validate:ga"] === undefined) {
    failures.push("package.json: missing validate:ga script");
  }
  if (pkg?.scripts?.["validate:japanese-base"] === undefined) {
    failures.push("package.json: missing validate:japanese-base script");
  }

  const ownerDecision = parseOwnerDecision(files[OWNER_DECISION_PATH], failures);
  const ownerGo = ownerDecision?.decision === "GO";
  if (ownerGo) {
    validateOwnerDecision(ownerDecision, failures);
    if (packageVersion !== "1.0.0") {
      failures.push("package.json: owner GO requires version 1.0.0");
    }
  } else {
    if (packageVersion === "1.0.0") {
      failures.push("package.json: version 1.0.0 requires explicit owner GO");
    }
    if (opts.require_owner_go) {
      failures.push("owner GO decision is required for actual GA promotion");
    }
  }

  const japaneseBaseStrictReady = validateJapaneseBaseBoundary(
    files,
    ownerGo || opts.require_owner_go === true,
    failures,
    warnings,
  );

  validatePublicClaimBoundary(files, ownerGo, failures);
  validateChannelMatrix(files, failures, barFailures);
  validateLocalValidationScripts(files, failures);
  validateGaReviewDoc(files, ownerGo, failures, warnings);

  const barResults = {
    A: barFailures.A === 0 ? "pass" as const : "fail" as const,
    B: barFailures.B === 0 ? "pass" as const : "fail" as const,
    C: barFailures.C === 0 ? "pass" as const : "fail" as const,
    D: barFailures.D === 0 ? "pass" as const : "fail" as const,
    E: barFailures.E === 0 ? "pass" as const : "fail" as const,
    F: barFailures.F === 0 ? "pass" as const : "fail" as const,
    G: ownerGo && japaneseBaseStrictReady && failures.length === 0
      ? "pass" as const
      : "pending_owner_go" as const,
  };
  if (failures.some((failure) =>
    failure.startsWith("public claim") || failure.startsWith("japanese base strict boundary")
  )) {
    barResults.G = "fail";
  }

  const allEvidencePass = Object.values(barResults)
    .filter((status, index) => index < 6)
    .every((status) => status === "pass");
  const publicClaimAllowed = ownerGo && japaneseBaseStrictReady && allEvidencePass && failures.length === 0;
  const ok = failures.length === 0 && (ownerGo || !opts.require_owner_go);

  return {
    ok,
    status: ok ? ownerGo ? "go_ready" : "pre_go_ready" : "blocked",
    owner_go: ownerGo,
    public_claim_allowed: publicClaimAllowed,
    japanese_base_strict_ready: japaneseBaseStrictReady,
    package_version: packageVersion,
    bar_results: barResults,
    failures,
    warnings,
  };
}

function validateJapaneseBaseBoundary(
  files: Record<string, string>,
  requireStrict: boolean,
  failures: string[],
  warnings: string[],
): boolean {
  let index: JapaneseBaseIndex;
  let migration: JapaneseBaseMigrationLedger;
  let strictAudit: JapaneseBaseStrictAudit;
  try {
    index = JSON.parse(files["規定/正本索引.json"] ?? "{}") as JapaneseBaseIndex;
  } catch (error) {
    failures.push(`規定/正本索引.json: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  try {
    migration = JSON.parse(files["規定/移行台帳.json"] ?? "{}") as JapaneseBaseMigrationLedger;
  } catch (error) {
    failures.push(`規定/移行台帳.json: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  try {
    strictAudit = JSON.parse(files[JAPANESE_BASE_AUDIT_KEY] ?? "{}") as JapaneseBaseStrictAudit;
  } catch (error) {
    failures.push(`japanese base strict audit: invalid result: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  if (index.schema_version !== 1 || index.base_language !== "日本語" || index.normative_language_count !== 1) {
    failures.push("規定/正本索引.json: Japanese base canonical state is invalid");
  }
  if (migration.schema_version !== 1 || !Array.isArray(migration.debts)) {
    failures.push("規定/移行台帳.json: migration ledger is invalid");
    return false;
  }

  const ledgerReady = migration.strict_ready === true && migration.debts.length === 0;
  const liveReady = strictAudit.ok === true && strictAudit.migration_debts === 0;
  const ready = ledgerReady && liveReady;
  if (!ready) {
    const detail = `ledger_debts=${migration.debts.length} live_debts=${String(strictAudit.migration_debts ?? "unknown")}`;
    if (requireStrict) {
      failures.push(`japanese base strict boundary: strict closure is required for actual GA promotion (${detail})`);
    } else {
      warnings.push(`japanese base strict boundary remains pending (${detail})`);
    }
  }
  return ready;
}

function parsePackage(text: string | undefined, failures: string[]): PackageJson | undefined {
  try {
    const parsed = JSON.parse(text ?? "{}") as PackageJson;
    if (typeof parsed.version !== "string") {
      failures.push("package.json: version must be a string");
    }
    return parsed;
  } catch (e) {
    failures.push(`package.json: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function parseOwnerDecision(
  text: string | undefined,
  failures: string[],
): OwnerDecision | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as OwnerDecision;
  } catch (e) {
    failures.push(`${OWNER_DECISION_PATH}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function validateOwnerDecision(decision: OwnerDecision, failures: string[]): void {
  if (decision.schema_version !== 1) {
    failures.push(`${OWNER_DECISION_PATH}: schema_version must be 1`);
  }
  if (decision.version !== "1.0.0") {
    failures.push(`${OWNER_DECISION_PATH}: version must be 1.0.0`);
  }
  if (decision.ga_bar_reviewed !== true) {
    failures.push(`${OWNER_DECISION_PATH}: ga_bar_reviewed must be true`);
  }
  if (decision.technical_validation_reviewed !== true) {
    failures.push(`${OWNER_DECISION_PATH}: technical_validation_reviewed must be true`);
  }
  if (decision.public_claim_authorized !== true) {
    failures.push(`${OWNER_DECISION_PATH}: public_claim_authorized must be true`);
  }
  if (typeof decision.decided_at !== "string" || Number.isNaN(Date.parse(decision.decided_at))) {
    failures.push(`${OWNER_DECISION_PATH}: decided_at must be an ISO timestamp`);
  }
}

function validatePublicClaimBoundary(
  files: Record<string, string>,
  ownerGo: boolean,
  failures: string[],
): void {
  if (ownerGo) return;
  for (const rel of PUBLIC_CLAIM_FILES) {
    const text = files[rel] ?? "";
    for (const pattern of FORBIDDEN_PUBLIC_CLAIM_PATTERNS) {
      if (pattern.test(text)) {
        failures.push(`public claim boundary: ${rel} contains forbidden pre-GO claim ${pattern}`);
      }
    }
  }
}

function validateChannelMatrix(
  files: Record<string, string>,
  failures: string[],
  barFailures: Record<"A" | "B" | "C" | "D" | "E" | "F", number>,
): void {
  try {
    const matrix = JSON.parse(files["docs/compatibility-matrix.json"] ?? "{}") as CompatibilityMatrix;
    const result = validateChannelPromotion(matrix);
    if (!result.ok) {
      for (const failure of result.failures) failures.push(`channel gate: ${failure}`);
      barFailures.E += result.failures.length || 1;
    }
  } catch (e) {
    failures.push(`docs/compatibility-matrix.json: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    barFailures.E += 1;
  }
}

function validateLocalValidationScripts(files: Record<string, string>, failures: string[]): void {
  const packageJson = files["package.json"] ?? "";
  for (const scriptName of [
    "typecheck",
    "build",
    "test",
    "docs:check",
    "validate:japanese-base",
    "validate:repo-health",
    "validate:packaging",
    "validate:channels",
    "plugin:review",
    "validate:ga",
    "validate:product",
    "smoke:serve",
    "smoke:resume",
    "smoke:live",
    "doctor",
    "release:bundle",
    "release:verify",
  ]) {
    if (!packageJson.includes(`"${scriptName}"`)) {
      failures.push(`package.json: missing local validation script ${scriptName}`);
    }
  }
}

function validateGaReviewDoc(
  files: Record<string, string>,
  ownerGo: boolean,
  failures: string[],
  warnings: string[],
): void {
  const review = files["docs/v1.0-ga-promotion-review.md"] ?? "";
  if (!review.includes("pnpm validate:ga")) {
    failures.push("docs/v1.0-ga-promotion-review.md: missing pnpm validate:ga");
  }
  if (!ownerGo && !review.includes("PENDING_OWNER_GO")) {
    failures.push("docs/v1.0-ga-promotion-review.md: missing PENDING_OWNER_GO state");
  }
  if (!ownerGo && !review.includes("public_claim_allowed=false")) {
    failures.push("docs/v1.0-ga-promotion-review.md: missing public_claim_allowed=false boundary");
  }
  if (ownerGo && review.includes("PENDING_OWNER_GO")) {
    warnings.push("docs/v1.0-ga-promotion-review.md still contains PENDING_OWNER_GO after owner GO");
  }
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function printText(result: GaPromotionGateResult): void {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(
    `[ga] ${status} status=${result.status} version=${result.package_version} ` +
      `owner_go=${result.owner_go ? "GO" : "pending"} ` +
      `public_claim_allowed=${result.public_claim_allowed} ` +
      `japanese_base_strict_ready=${result.japanese_base_strict_ready}`,
  );
  console.log(
    `  bars: A=${result.bar_results.A} B=${result.bar_results.B} C=${result.bar_results.C} ` +
      `D=${result.bar_results.D} E=${result.bar_results.E} F=${result.bar_results.F} G=${result.bar_results.G}`,
  );
  for (const warning of result.warnings) {
    console.log(`  WARN ${warning}`);
  }
  for (const failure of result.failures) {
    console.error(`  FAIL ${failure}`);
  }
}

function main(): void {
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const result = validateGaPromotionGate(readGaPromotionFiles(root), {
    require_owner_go: hasArg("--require-owner-go"),
  });
  if (hasArg("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
