# BLUE-TANUKI Active Implementation Instructions

Active phase: **J0 — 日本語基底規定成立**

状態: **完了（J1 未承認）**

Product release boundary: **P13 凍結 / `PENDING_OWNER_GO` / `public_claim_allowed=false`**

作業基点: `main@703fe34600036ec76335f0756178296981e55ee4`

この文書は現在の実装権限を限定する active instruction である。過去 phase の詳細は Git 履歴と `docs/history/` の証拠であり、現行の実装権限ではない。

作業規律は [作業標準要領](作業標準要領.md) に従う。2026-10-08 の owner 指示による D4-POCKET 作業規律の翻案は、規定・参照・台帳の局所更新である。J0 の再開、J1 の着手、P13 の公開判断を許可しない。工程内の有限受入条件と最終品質保証を分け、既存の安全要件と必須検証を維持する。

## 1. 目的

BLUE-TANUKI リポジトリ全体について、日本語を唯一の基底規定言語として成立させる。多言語は実務上やむを得ない箇所に限る局所例外とし、既存の英語資産を例外へ自動昇格させず、監査可能な移行負債として固定する。

系列リポジトリの確認済み版を参照し、BLUE-TANUKI の HDS-BRAIN、Approval Gate、監査、Runtime Invariants、Layer A/B、P13 pre-GO 境界へ局所投影する。

## 2. Phase 境界

J0 が行うのは言語規定、正本索引、基底語彙、資産分類、局所例外台帳、移行台帳、機械監査、active governance 文書の日本語正本化である。

J0 は全既存文書、UI、installer 表示、コードコメントを翻訳し終える phase ではない。規定成立と全資産移行完了を区別する。P13 の owner GO、version promotion、公開主張、機能追加は凍結する。

## 3. Scope

- `AGENTS.md`
- `規定/`
- `scripts/japanese_base_gate.ts`
- `packages/protocol/test/japanese_base_gate.test.ts`
- `package.json`
- `scripts/check_docs.mjs`
- release bundle / GA gate の日本語基底接続点
- `README.md`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/INDEX.md`
- `docs/P13_OWNER_GO_READINESS.md`
- `docs/v1.0-ga-promotion-review.md`
- `CHANGELOG.md`

## 4. Non-goals

- 全 522 tracked assets の逐語翻訳
- TypeScript、API、環境変数、CLI、package 名の日本語識別子化
- HDS-BRAIN、Approval Gate、risk/level、audit schema の意味変更
- UI、channel、operator、installer の機能変更
- preview の first-party 昇格
- `1.0.0` への version promotion
- `docs/ga-owner-decision.json` の作成または owner GO の推定
- GA、完全優位、release readiness の新規公開主張
- GitHub Actions / CI workflow の追加
- J1 以降への自動着手

## 5. 最初に確認する files / symbols

```text
AGENTS.md
規定/00_日本語基底規定.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/ROADMAP.md
SECURITY.md
AUDIT.md
CONFIG.md
README.md
CHANGELOG.md
package.json
scripts/check_docs.mjs
scripts/repo_health_gate.ts
scripts/ga_promotion_gate.ts
scripts/create_release_bundle.ts
scripts/verify_release_bundle.ts
packages/protocol/src/product_scope_contract.ts
```

確認する主要 symbol:

```text
FINAL_REVIEW_OPERATION_LIST
PRODUCT_SCOPE_CORE_RELEASE_PATHS
GA_REQUIRED_FILES
validateGaPromotionGate
CORE_RELEASE_PATHS
INCLUDED_PATHS
REQUIRED_PATHS
```

## 6. 必須 grep

```bash
rg -n "Language Policy|Primary documentation language|日本語|IMPLEMENTATION_INSTRUCTIONS|public_claim_allowed|validate:ga|docs:check|validate:repo-health" AGENTS.md README.md package.json scripts docs
rg -n "FINAL_REVIEW_OPERATION_LIST|Runtime Invariants|used_for_authority|complete_history_used_for_authority" packages apps docs
find . -path './node_modules' -prune -o -path './.git' -prune -o -name '*.md' -type f -print
git status --short
git rev-list --left-right --count HEAD...origin/main
```

## 7. 既存 anchor

- HDS-BRAIN が upstream authority である
- human owner が最終責任と GO を保持する
- LLM、tool、channel、memory、history、UI は downstream / non-authority
- `ApprovalRisk` と `ApprovalLevel` を別軸に保つ
- final-review operation は `FINAL_REVIEW_OPERATION_LIST` を唯一の実装源とする
- hash-chain audit と Runtime Invariants を保つ
- `used_for_authority=false`
- `complete_history_used_for_authority=false`
- P13 は `PENDING_OWNER_GO`
- `public_claim_allowed=false`
- `.github/workflows` 不在を保つ
- direct-main と、編集前に保存する二世代の local recovery branch / remote backup tag を保つ（順序は `AGENTS.md` §21.7）

## 8. 実装要件

1. 日本語を唯一の基底規定言語として明記する。
2. 日本語で対象・差異・関係・境界を先に成立させ、翻訳先から逆定義しない。
3. 系列参照を exact commit で固定し、将来版を自動採用しない。
4. 既存機械識別子を日本語概念の参照ラベルとして基底語彙へ接続する。
5. 局所例外に path、region、不可避理由、日本語参照、authority effect、review trigger を要求する。
6. 既存非日本語資産を例外とせず、hash 付き移行負債として固定する。
7. 未登録負債、登録済み負債の無審査変更、解消済み負債の台帳残存を通常 gate で拒否する。
8. `--strict` は負債が残る限り失敗させる。
9. 文字比率を discovery signal に限定し、意味・権限・不可避性の監査を正本とする。
10. 正本群と監査 script を source release bundle に含める。
11. owner GO を含む実 GA promotion は日本語基底 strict 成立なしに許可しない。
12. 通常の pre-GO `pnpm validate:ga` は `public_claim_allowed=false` のまま通せる。

## 9. Safety invariants

```json
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "complete_history_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

言語移行は authority path、Approval Gate、audit schema、Runtime Invariants、capability、channel status、release version を変更しない。意味が不明になる翻訳は採用せず、移行負債として止める。

## 10. Operator usability

- 日本語正本と未移行資産を一目で区別できること
- 通常 gate と strict gate の意味を日本語で表示すること
- strict failure が product/runtime failure や owner GO 不在と混同されないこと
- 固定 CLI・API 名を壊さないこと
- 現在の UI 日本語化を未完了として明示すること

## 11. Tests

- 日本語散文を候補として検出する
- 英語だけの散文を日本語正本と誤認しない
- code fence / fixed identifier を文字率へ混入させない
- 正本、系列 commit、例外 schema、P13 境界を検証する
- current repository の通常 gate が登録台帳と一致する
- strict gate が移行負債を fail-closed する
- owner GO fixture は debt-free ledger なしに実 GA promotion できない
- source release bundle が `規定/` を含む

## 12. Validation commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:japanese-base
pnpm validate:japanese-base -- --strict
pnpm validate:repo-health
pnpm run doctor
pnpm validate:packaging
pnpm validate:ga
pnpm release:bundle
pnpm release:verify
```

J0 では strict gate の失敗が、登録済み移行負債だけを理由としていることを確認する。通常 gate は合格しなければならない。WSL で `tsx` が Windows 一時パスを参照する場合は `TMPDIR=/tmp` を用い、製品不具合と混同しない。

## 13. Manual smoke

runtime behavior は変更しないため credentialed live smoke を完成証拠にしない。release bundle を展開した検証で正本群の存在と通常 gate 接続を確認する。`pnpm smoke:live` は credentials がなければ SKIP とする。

## 14. Permanent-use check

- 新規非日本語 Markdown が通常 gate をすり抜けない
- 登録済み負債を無審査で変更できない
- 履歴原文が現行 authority へ昇格しない
- release artifact に日本語正本が同梱される
- P13 owner GO 前は strict debt、Windows 実機 evidence、owner decision の各 blocker が独立して残る

## 15. Final report format

1. 日本語基底の成立範囲
2. 変更ファイル
3. 移行負債の正確な件数
4. 局所例外の正確な件数と範囲
5. authority / Approval / audit / Runtime Invariants 影響
6. 実行した検証と結果
7. strict gate の期待失敗理由
8. P13 / GA 状態
9. branch / commit / push / remote HEAD
10. backup refs と rollback point
11. 未移行・未検証・残存リスク

## 16. Next-phase dependency

J0 の通常 gate、全 required validation、Git closure が完了した後にだけ、J1「活正文書の日本語正本化」を提案できる。J1 は owner の次の指示なしに開始しない。J1 完了だけでも UI・code prose は完了しないため、strict 成立や owner GO を主張しない。
