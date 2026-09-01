import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const JAPANESE_BASE_CANONICAL_FILES = [
  "規定/README.md",
  "規定/00_日本語基底規定.md",
  "規定/01_基底語彙.md",
  "規定/02_資産分類と局所例外.md",
  "規定/正本索引.json",
  "規定/局所例外台帳.json",
  "規定/移行台帳.json",
] as const;

export const JAPANESE_BASE_SERIES_REFS = {
  "gatchimuchio/cognitive-engineering-foundations":
    "60131da52ba7931ed7f82c7648a74ac790f50d08",
  "gatchimuchio/LLM-Constitutive-Specification":
    "3f5eb7b704dba5a06c717399c3400405b5e8944e",
  "gatchimuchio/NOTNN-LLM-MINIDORA":
    "061d81244058703c1b28ac33191ced83d7381be3",
} as const;

interface CanonicalIndex {
  schema_version?: unknown;
  base_language?: unknown;
  normative_language_count?: unknown;
  status?: unknown;
  canonical_documents?: unknown;
  canonical_document_hashes?: unknown;
  registries?: unknown;
  series_references?: unknown;
  release_boundary?: unknown;
}

export interface JapaneseBaseException {
  id?: unknown;
  scope?: unknown;
  region?: unknown;
  external_form?: unknown;
  category?: unknown;
  unavoidable_reason_japanese?: unknown;
  japanese_reference?: unknown;
  authority_effect?: unknown;
  review_trigger?: unknown;
}

interface ExceptionLedger {
  schema_version?: unknown;
  policy?: unknown;
  entries?: unknown;
  frozen_assets?: unknown;
}

interface FrozenExceptionAsset {
  path?: unknown;
  sha256?: unknown;
  exception_id?: unknown;
}

export interface JapaneseBaseDebt {
  path: string;
  sha256: string;
  classification: "日本語基底未成立";
  reason_japanese: string;
  next_action: string;
}

interface MigrationLedger {
  schema_version?: unknown;
  state?: unknown;
  strict_ready?: unknown;
  debt_count?: unknown;
  generated_from_commit?: unknown;
  method?: unknown;
  classification?: unknown;
  reason_japanese?: unknown;
  next_action?: unknown;
  debts?: unknown;
}

interface RegisteredJapaneseBaseDebt {
  path: string;
  sha256: string;
}

export interface ProseLanguageSignal {
  japanese_characters: number;
  latin_characters: number;
  japanese_ratio: number;
  japanese_base_candidate: boolean;
}

export interface JapaneseBaseAuditOptions {
  strict?: boolean;
  inventory_only?: boolean;
}

export interface JapaneseBaseAuditResult {
  ok: boolean;
  state: "規定成立・移行中" | "厳格成立" | "不整合";
  strict: boolean;
  canonical_files: number;
  exceptions: number;
  exception_assets: number;
  markdown_files_scanned: number;
  migration_debts: number;
  detected_debts: JapaneseBaseDebt[];
  failures: string[];
  warnings: string[];
}

const JAPANESE_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN_PATTERN = /[A-Za-z]/g;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".blue-tanuki",
  ".codex-tmp",
  "node_modules",
  "dist",
  "coverage",
  "release",
]);

function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function parseJson<T>(root: string, rel: string, failures: string[]): T | undefined {
  try {
    return JSON.parse(read(root, rel)) as T;
  } catch (error) {
    failures.push(`${rel}: JSON を解析できない: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stripNonProse(markdown: string): string {
  const prose: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(line)) continue;
    const withoutMachineReferences = line
      .replace(/`[^`]*`/gu, " ")
      .replace(/https?:\/\/\S+/gu, " ")
      .replace(/\[[^\]]*\]\([^)]*\)/gu, (match) => match.replace(/\([^)]*\)/u, ""));
    prose.push(withoutMachineReferences);
  }
  return prose.join("\n");
}

export function analyzeMarkdownLanguage(markdown: string): ProseLanguageSignal {
  const prose = stripNonProse(markdown);
  const japanese = (prose.match(JAPANESE_PATTERN) ?? []).length;
  const latin = (prose.match(LATIN_PATTERN) ?? []).length;
  const total = japanese + latin;
  const ratio = total === 0 ? 0 : japanese / total;
  return {
    japanese_characters: japanese,
    latin_characters: latin,
    japanese_ratio: ratio,
    japanese_base_candidate: japanese >= 8 && ratio >= 0.2,
  };
}

export function listJapaneseBaseMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(path.relative(root, child).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return found.sort((a, b) => a.localeCompare(b, "ja"));
}

function globRegex(scope: string): RegExp {
  const escaped = scope
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "\u0000")
    .replace(/\*/gu, "[^/]*")
    .replace(/\u0000/gu, ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function matchesScope(rel: string, scope: string): boolean {
  return globRegex(scope).test(rel);
}

function hasJapanese(text: string): boolean {
  return (text.match(JAPANESE_PATTERN) ?? []).length >= 4;
}

function validateExceptionEntries(raw: unknown, failures: string[]): JapaneseBaseException[] {
  if (!Array.isArray(raw)) {
    failures.push("規定/局所例外台帳.json: entries は配列でなければならない");
    return [];
  }
  const entries = raw as JapaneseBaseException[];
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const label = `規定/局所例外台帳.json: entries[${index}]`;
    for (const key of [
      "id",
      "scope",
      "region",
      "external_form",
      "category",
      "unavoidable_reason_japanese",
      "japanese_reference",
      "authority_effect",
      "review_trigger",
    ] as const) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        failures.push(`${label}.${key} が空または文字列ではない`);
      }
    }
    if (typeof entry.id === "string") {
      if (ids.has(entry.id)) failures.push(`${label}: 重複 id ${entry.id}`);
      ids.add(entry.id);
    }
    if (typeof entry.scope === "string") {
      if (entry.scope === "**" || entry.scope === "**/*" || path.isAbsolute(entry.scope) || entry.scope.includes("..")) {
        failures.push(`${label}: scope が局所化されていない: ${entry.scope}`);
      }
    }
    if (entry.authority_effect !== "none") {
      failures.push(`${label}: authority_effect は none でなければならない`);
    }
    for (const key of ["unavoidable_reason_japanese", "japanese_reference", "review_trigger"] as const) {
      if (typeof entry[key] === "string" && !hasJapanese(entry[key])) {
        failures.push(`${label}.${key} は日本語で記録しなければならない`);
      }
    }
  }
  return entries;
}

function validateFrozenExceptionAssets(
  root: string,
  raw: unknown,
  entries: JapaneseBaseException[],
  failures: string[],
): FrozenExceptionAsset[] {
  if (!Array.isArray(raw)) {
    failures.push("規定/局所例外台帳.json: frozen_assets は配列でなければならない");
    return [];
  }
  const assets = raw as FrozenExceptionAsset[];
  const paths = new Set<string>();
  const entriesById = new Map(
    entries
      .filter((entry): entry is JapaneseBaseException & { id: string; scope: string } =>
        typeof entry.id === "string" && typeof entry.scope === "string"
      )
      .map((entry) => [entry.id, entry]),
  );
  for (const [index, asset] of assets.entries()) {
    const label = `規定/局所例外台帳.json: frozen_assets[${index}]`;
    if (typeof asset.path !== "string" || asset.path.length === 0 || path.isAbsolute(asset.path) || asset.path.includes("..")) {
      failures.push(`${label}.path が不正`);
      continue;
    }
    if (paths.has(asset.path)) failures.push(`${label}: 重複 path ${asset.path}`);
    paths.add(asset.path);
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(asset.sha256)) {
      failures.push(`${label}.sha256 が不正`);
    }
    const entry = typeof asset.exception_id === "string"
      ? entriesById.get(asset.exception_id)
      : undefined;
    if (!entry) {
      failures.push(`${label}.exception_id が局所例外を参照していない`);
    } else if (!matchesScope(asset.path, entry.scope)) {
      failures.push(`${label}.path が ${entry.id} の scope 外: ${asset.path}`);
    }
    const absolute = path.join(root, asset.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(`${label}: 固定した例外資産が存在しない: ${asset.path}`);
    } else if (typeof asset.sha256 === "string" && sha256(readFileSync(absolute, "utf8")) !== asset.sha256) {
      failures.push(`${label}: 局所例外の原文同一性が変化した: ${asset.path}`);
    }
  }
  return assets;
}

function debtFromFile(root: string, rel: string): JapaneseBaseDebt {
  return {
    path: rel,
    sha256: sha256(read(root, rel)),
    classification: "日本語基底未成立",
    reason_japanese: "規範的散文が日本語基底の候補条件を満たさず、不可避な局所例外にも該当しない。",
    next_action: "意味と境界を日本語で再成立させ、監査後に移行台帳から除く。",
  };
}

function parseMigrationDebts(raw: unknown, failures: string[]): RegisteredJapaneseBaseDebt[] {
  if (!Array.isArray(raw)) {
    failures.push("規定/移行台帳.json: debts は配列でなければならない");
    return [];
  }
  const debts = raw as RegisteredJapaneseBaseDebt[];
  const paths = new Set<string>();
  for (const [index, debt] of debts.entries()) {
    const label = `規定/移行台帳.json: debts[${index}]`;
    if (typeof debt.path !== "string" || debt.path.length === 0 || path.isAbsolute(debt.path) || debt.path.includes("..")) {
      failures.push(`${label}.path が不正`);
    } else if (paths.has(debt.path)) {
      failures.push(`${label}: 重複 path ${debt.path}`);
    } else {
      paths.add(debt.path);
    }
    if (typeof debt.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(debt.sha256)) {
      failures.push(`${label}.sha256 が不正`);
    }
  }
  return debts;
}

function validateCanonicalState(root: string, failures: string[]): {
  exceptions: JapaneseBaseException[];
  frozenExceptionAssets: FrozenExceptionAsset[];
  migration: MigrationLedger | undefined;
} {
  for (const rel of JAPANESE_BASE_CANONICAL_FILES) {
    if (!existsSync(path.join(root, rel)) || !statSync(path.join(root, rel)).isFile()) {
      failures.push(`${rel}: 必須正本が存在しない`);
    }
  }

  const policy = existsSync(path.join(root, "規定/00_日本語基底規定.md"))
    ? read(root, "規定/00_日本語基底規定.md")
    : "";
  for (const phrase of [
    "唯一の基底規定言語",
    "実務上やむを得ない場合",
    "外部語から日本語の意味を逆定義してはならない",
    "public_claim_allowed=false",
    "文字比率は未確認資産を発見するための信号に限る",
  ]) {
    if (!policy.includes(phrase)) failures.push(`規定/00_日本語基底規定.md: 必須規定を欠く: ${phrase}`);
  }

  const index = parseJson<CanonicalIndex>(root, "規定/正本索引.json", failures);
  if (index?.schema_version !== 1) failures.push("規定/正本索引.json: schema_version は 1 でなければならない");
  if (index?.base_language !== "日本語") failures.push("規定/正本索引.json: base_language は日本語でなければならない");
  if (index?.normative_language_count !== 1) failures.push("規定/正本索引.json: 規定言語は一つでなければならない");
  const canonicalDocuments = [
    "規定/00_日本語基底規定.md",
    "規定/01_基底語彙.md",
    "規定/02_資産分類と局所例外.md",
  ];
  const indexedDocuments = Array.isArray(index?.canonical_documents)
    ? index.canonical_documents
    : [];
  if (canonicalDocuments.some((rel) => !indexedDocuments.includes(rel))) {
    failures.push("規定/正本索引.json: canonical_documents が不完全");
  }
  const canonicalHashes = index?.canonical_document_hashes;
  if (!canonicalHashes || typeof canonicalHashes !== "object") {
    failures.push("規定/正本索引.json: canonical_document_hashes を欠く");
  } else {
    const hashes = canonicalHashes as Record<string, unknown>;
    for (const rel of canonicalDocuments) {
      const expected = hashes[rel];
      if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
        failures.push(`規定/正本索引.json: ${rel} の正本 hash が不正`);
      } else if (existsSync(path.join(root, rel)) && sha256(read(root, rel)) !== expected) {
        failures.push(`規定/正本索引.json: ${rel} の正本 hash が一致しない`);
      }
    }
  }
  const refs = Array.isArray(index?.series_references) ? index.series_references : [];
  for (const [repository, commit] of Object.entries(JAPANESE_BASE_SERIES_REFS)) {
    const matched = refs.some((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return record.repository === repository && record.commit === commit;
    });
    if (!matched) failures.push(`規定/正本索引.json: 系列参照 ${repository}@${commit} を欠く`);
  }
  const releaseBoundary = index?.release_boundary;
  if (!releaseBoundary || typeof releaseBoundary !== "object") {
    failures.push("規定/正本索引.json: release_boundary を欠く");
  } else {
    const boundary = releaseBoundary as Record<string, unknown>;
    if (boundary.state !== "PENDING_OWNER_GO" || boundary.public_claim_allowed !== false) {
      failures.push("規定/正本索引.json: P13 pre-GO 境界が維持されていない");
    }
  }

  const exceptionLedger = parseJson<ExceptionLedger>(root, "規定/局所例外台帳.json", failures);
  if (exceptionLedger?.schema_version !== 1) {
    failures.push("規定/局所例外台帳.json: schema_version は 1 でなければならない");
  }
  if (exceptionLedger?.policy !== "規定/00_日本語基底規定.md") {
    failures.push("規定/局所例外台帳.json: policy が日本語基底規定を参照していない");
  }
  const exceptions = validateExceptionEntries(exceptionLedger?.entries, failures);
  const frozenExceptionAssets = validateFrozenExceptionAssets(
    root,
    exceptionLedger?.frozen_assets,
    exceptions,
    failures,
  );

  const migration = parseJson<MigrationLedger>(root, "規定/移行台帳.json", failures);
  if (migration?.schema_version !== 1) {
    failures.push("規定/移行台帳.json: schema_version は 1 でなければならない");
  }
  if (typeof migration?.method !== "string" || !hasJapanese(migration.method)) {
    failures.push("規定/移行台帳.json: method は日本語でなければならない");
  }
  if (migration?.classification !== "日本語基底未成立") {
    failures.push("規定/移行台帳.json: classification が不正");
  }
  if (typeof migration?.reason_japanese !== "string" || !hasJapanese(migration.reason_japanese)) {
    failures.push("規定/移行台帳.json: reason_japanese は日本語でなければならない");
  }
  if (typeof migration?.next_action !== "string" || !hasJapanese(migration.next_action)) {
    failures.push("規定/移行台帳.json: next_action は日本語でなければならない");
  }

  return { exceptions, frozenExceptionAssets, migration };
}

export function auditJapaneseBase(
  root: string,
  options: JapaneseBaseAuditOptions = {},
): JapaneseBaseAuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const { exceptions, frozenExceptionAssets, migration } = validateCanonicalState(root, failures);
  const markdownFiles = listJapaneseBaseMarkdownFiles(root);
  const frozenExceptionPaths = new Set(
    frozenExceptionAssets
      .map((asset) => asset.path)
      .filter((assetPath): assetPath is string => typeof assetPath === "string"),
  );
  const detectedDebts = markdownFiles
    .filter((rel) => !frozenExceptionPaths.has(rel))
    .filter((rel) => !analyzeMarkdownLanguage(read(root, rel)).japanese_base_candidate)
    .map((rel) => debtFromFile(root, rel));

  const registeredDebts = parseMigrationDebts(migration?.debts, failures);
  if (!options.inventory_only) {
    const detectedByPath = new Map(detectedDebts.map((debt) => [debt.path, debt]));
    const registeredByPath = new Map(registeredDebts.map((debt) => [debt.path, debt]));
    for (const debt of detectedDebts) {
      const registered = registeredByPath.get(debt.path);
      if (!registered) {
        failures.push(`未登録の日本語基底移行負債: ${debt.path}`);
      } else if (registered.sha256 !== debt.sha256) {
        failures.push(`登録済み移行負債が無審査で変更された: ${debt.path}`);
      }
    }
    for (const debt of registeredDebts) {
      if (!detectedByPath.has(debt.path)) {
        failures.push(`解消済みまたは消失した負債が移行台帳に残っている: ${debt.path}`);
      }
    }
    if (migration?.strict_ready !== (registeredDebts.length === 0)) {
      failures.push("規定/移行台帳.json: strict_ready と負債件数が一致しない");
    }
    if (migration?.debt_count !== registeredDebts.length) {
      failures.push("規定/移行台帳.json: debt_count と負債件数が一致しない");
    }
  }

  if (detectedDebts.length > 0) {
    warnings.push(`日本語基底の移行負債が ${detectedDebts.length} 件残っている`);
  }
  if (options.strict && detectedDebts.length > 0) {
    failures.push(`厳格監査: 移行負債 ${detectedDebts.length} 件が未解消`);
  }

  const ok = failures.length === 0;
  return {
    ok,
    state: ok ? detectedDebts.length === 0 ? "厳格成立" : "規定成立・移行中" : "不整合",
    strict: options.strict === true,
    canonical_files: JAPANESE_BASE_CANONICAL_FILES.length,
    exceptions: exceptions.length,
    exception_assets: frozenExceptionAssets.length,
    markdown_files_scanned: markdownFiles.length,
    migration_debts: detectedDebts.length,
    detected_debts: detectedDebts,
    failures,
    warnings,
  };
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) return process.argv[index + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function printText(result: JapaneseBaseAuditResult): void {
  console.log(
    `[日本語基底監査] ${result.ok ? "PASS" : "FAIL"} 状態=${result.state} ` +
      `正本=${result.canonical_files} 例外=${result.exceptions} ` +
      `例外資産=${result.exception_assets} Markdown=${result.markdown_files_scanned} ` +
      `移行負債=${result.migration_debts}`,
  );
  for (const warning of result.warnings) console.log(`  注意 ${warning}`);
  for (const failure of result.failures) console.error(`  失敗 ${failure}`);
}

function main(): void {
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const result = auditJapaneseBase(root, {
    strict: hasArg("--strict"),
    inventory_only: hasArg("--inventory"),
  });
  if (hasArg("--json")) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
