import { describe, expect, it } from "vitest";
import {
  analyzeMarkdownLanguage,
  auditJapaneseBase,
  listJapaneseBaseMarkdownFiles,
} from "../../../scripts/japanese_base_gate.ts";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("日本語基底監査", () => {
  it("日本語で意味が成立した散文を候補として識別する", () => {
    const signal = analyzeMarkdownLanguage(
      "# 判断境界\n\n権限は判断基盤にあり、外部識別子から意味を逆定義しない。",
    );
    expect(signal.japanese_base_candidate).toBe(true);
    expect(signal.japanese_ratio).toBeGreaterThan(0.9);
  });

  it("英語だけの散文を日本語正本と誤認しない", () => {
    const signal = analyzeMarkdownLanguage(
      "# Authority boundary\n\nExternal metadata must never define authority.",
    );
    expect(signal.japanese_base_candidate).toBe(false);
    expect(signal.japanese_characters).toBe(0);
  });

  it("文字比率の信号からコードフェンスと固定識別子を除外する", () => {
    const signal = analyzeMarkdownLanguage(
      "安全境界を日本語で定める。`public_claim_allowed=false`\n```ts\nconst authority = false;\n```",
    );
    expect(signal.japanese_base_candidate).toBe(true);
  });

  it("検証用生成領域をリポジトリ資産として走査しない", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blue-tanuki-ja-base-"));
    try {
      await fs.mkdir(path.join(root, ".codex-tmp", "generated"), { recursive: true });
      await fs.writeFile(path.join(root, "active.md"), "# Active\n", "utf8");
      await fs.writeFile(
        path.join(root, ".codex-tmp", "generated", "copy.md"),
        "# Generated copy\n",
        "utf8",
      );

      expect(listJapaneseBaseMarkdownFiles(root)).toEqual(["active.md"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("現行リポジトリの正本・例外・hash 付き移行台帳が一致する", () => {
    const result = auditJapaneseBase(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.canonical_files).toBe(7);
    expect(result.exceptions).toBe(4);
    expect(result.exception_assets).toBe(74);
    expect(result.migration_debts).toBe(78);
    expect(result.detected_debts.some((debt) => debt.path === "AUDIT.md")).toBe(true);
  });

  it("移行負債が残る間は厳格成立を拒否する", () => {
    const result = auditJapaneseBase(repoRoot, { strict: true });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("厳格監査");
  });
});
