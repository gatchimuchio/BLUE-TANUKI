# BLUE-TANUKI 日本語基底刷新ロードマップ

この文書は全体順序を示す圧縮案内である。実装権限と詳細な acceptance criteria は `AGENTS.md`、`規定/`、`docs/IMPLEMENTATION_INSTRUCTIONS.md` にある。

作業手順は [作業標準要領](作業標準要領.md) に従う。有限の受入条件と必須検証・Git 完結が成立した工程は閉じ、範囲外の追加保証は理由と公開への影響を記録して最終品質保証または承認済み後工程へ送る。移送だけで後工程を開始せず、公開阻害や必要証拠を免除しない。D4-POCKET の工程番号・完了状態・QA 結果は移植しない。

## 現在の開発工程

ownerが委任した施工系列は、一単位ずつ有限受入とGit完結を行う。C01.03では要求ID付き`validate:agi`を実Vitest selectorへ接続し、C02.01–03では目的の射影・関係・権限版をHDS decision/auditへ局所接続した。C03.01でM SQLite原子取引、C03.02で期待版比較・同ID冪等再送・V1履歴互換、C03.03でJ pendingの永続化とM receipt再照合からの局所復帰を実装し、一時SQLite fixtureで確認した。実J承認source、Controller/Gateway production consumer、C03.04破損復旧、OS crash/installed証拠は未成立である。全体testとdoctorの各単位の結果は[開発進捗](開発進捗.md)へ記録する。親C01/C02/C03の全scenarioと製品runtime全体、自然言語意味同定、owner/L3承認経路、release readinessは未成立である。GitHubは検証済み成果と履歴の保管面であり、通常の単位ごとのcommit・push・remote照合を完結に含む。次単位は最新状態を新規同期し、工程境界で停止する。

以下の日本語移行と P13 状態は独立して維持する。

## 現在状態

| 面 | 状態 | 意味 |
|---|---|---|
| Product version | `1.0.0-rc.1` | 技術 release candidate。GA ではない。 |
| Product phase | P13 凍結 | `PENDING_OWNER_GO`、`public_claim_allowed=false`。 |
| Language phase | J0 完了 | 日本語基底規定、台帳、gate、active governance が成立。J1 は未承認。 |
| Strict language gate | 未成立 | 既存の非日本語 active assets が移行負債として残る。 |
| Runtime / authority | 変更なし | HDS-BRAIN、Approval Gate、audit、Runtime Invariants を維持する。 |

## 系列

J 系列は次の確認済み版を参照し、BLUE-TANUKI の日本語正本として局所成立させる。

- cognitive-engineering-foundations `60131da52ba7931ed7f82c7648a74ac790f50d08`
- LLM-Constitutive-Specification `3f5eb7b704dba5a06c717399c3400405b5e8944e`
- NOTNN-LLM-MINIDORA `061d81244058703c1b28ac33191ced83d7381be3`

参照先の更新は自動採用しない。変更時は再確認、差分監査、日本語での局所採否を要する。

## J 系列

### J0 — 日本語基底規定成立

状態: **完了**

到達状態:

- 日本語を唯一の基底規定言語として正本化
- 基底語彙、資産分類、正本索引を追加
- 実務上不可避な多言語だけを局所例外台帳へ記録
- 既存非日本語資産を hash 付き移行負債として固定
- 未登録増加と無審査変更を通常 gate で拒否
- 全負債を strict gate で拒否
- AGENTS、active instruction、roadmap、README、docs index を日本語正本化
- source release bundle と GA owner-GO 境界へ接続

非到達:

- 全文書、UI、installer、code prose の移行完了
- GA / owner GO / version promotion

### J1 — 活正文書の日本語正本化

候補範囲: SECURITY、AUDIT、CONFIG、QUICKSTART、CLAIM、SUPPORT、KNOWN LIMITATIONS、GA bar、operator / adapter / installer の現行仕様。

各文書を逐語訳せず、日本語で対象・境界・反例・検証を再成立させる。機械 validator が依存する固定文字列は局所参照として保持し、意味を日本語正本へ接続する。

状態: **未承認・未着手**

### J2 — Operator / installer / UI 散文

候補範囲: Control Center の `lang`、表示文言、警告、remediation、installer / resident helper、OS 固有案内。

状態: **未承認・未着手**

### J3 — Source / test / machine-readable prose

候補範囲: comment、JSDoc、test specification 名、人間向け JSON description、diagnostic output。syntax、API、型、環境変数は互換識別子として維持する。

状態: **未承認・未着手**

### J4 — Strict closure

条件:

- `pnpm validate:japanese-base -- --strict` PASS
- 移行台帳 `debts=[]` / `strict_ready=true`
- 局所例外の不可避性を再監査
- release bundle 内でも同じ正本・gate を検証
- UI / docs / code prose の未監査領域なし

状態: **未承認・未着手**

## Product P 系列との関係

既存 P1-P12 の実装・検証記録は Git 履歴、`docs/history/`、phase reports に残る。J 系列はそれらの product behavior を再実装せず、言語上の正本性と監査経路を刷新する。

P13 Owner GO / Product Release は次がすべて揃うまで凍結する。

- owner の明示決定記録
- Windows実機E2E と必要な live evidence
- `pnpm validate:ga -- --require-owner-go` PASS
- 日本語基底 strict gate PASS
- 最終 version / claim 変更後の release bundle 再生成・検証

J0 の通常 gate PASS は P13 GO を意味しない。

## 実行順序

```text
J0 規定成立
  -> audit / validation / Git closure
  -> owner が次 phase を指示
  -> J1
  -> J2
  -> J3
  -> J4 strict closure
  -> P13 を独立に再評価
```

各矢印は自動進行ではなく監査境界である。
