# BLUE-TANUKI 有効な実装指示

現単位: **B02.04 — ミニドラ変更の限定委任案**。資料工程、文書 profile。有限資料条件と必須6検証は受入済み。test初回timeoutと変更なしの全件再実行PASSは開発進捗に保持。Git 完結は該当 main commit の remote・backup・clean 照合を要する。作業基点は main `d8f988a9f2d90a37219572873a063b3b86d7fad8`。

owner の全工程委任と、GitHub を履歴・成果物保管庫として使う明示指示に基づく。今回の対象は公開ソースに基づく限定提案と作業記録。私有原典・核心の封印詳細を掲載する許可ではない。

J0 は完了、J1 は未承認。旧 J0 指示は編集前 commit の Git 履歴に保持する。P13 は凍結、`PENDING_OWNER_GO`、`public_claim_allowed=false`、版 `1.0.0-rc.1` を維持する。

## 1. 目的

ミニドラ側の必要な最小差分または変更不要の条件を C 契約へ結ぶ。公開ソースから限定案と実consumer・受入・復元条件を作り、成果と履歴を GitHub に保存する。資料受入と製品実接続を区別する。

## 2. Phase 境界

一つの資料単位を検証・整理・編集前二世代保存・commit・push・remote 照合まで閉じる。B02.02 の取得済みミニドラソースを固定版と現在の API main へ照合して使う。資料受入を接続実装や製品承認と混同しない。

## 3. Scope

- `docs/ミニドラ接続変更案.md`、`docs/開発進捗.md`
- 本指示、`docs/ROADMAP.md`、`docs/INDEX.md`、`CHANGELOG.md`
- `規定/移行台帳.json` の審査済み CHANGELOG hash のみ

## 4. Non-goals

実ミニドラの実装・推論・接続、別 repo 書込み、全面改修、内部保護の撤去、核心モデルの公開、規定案全体の適用、製品名・言語刷新、J1、GA、owner GO、実資格による業務作用。

## 5. 最初に確認する files / symbols

`AGENTS.md`、日本語基底正本、作業標準要領、ROADMAP、SECURITY／AUDIT／CONFIG／README／CHANGELOG、現指示と進捗。固定版ミニドラの製品版API、HDS運用の製品／セッション、要求・出力束、実模型状態、通信と監査、既存試験定義、root AGENTSと公開境界。

## 6. 必須 grep

固定 archive を展開・実行せず、対象本文から `応答`、`停止要求`、`期限秒`、`外部読取許可`、`状態sha256`、`APPROVE`、`監査` の実consumerを検索する。候補pathの不存在は未観測として残し、同名機能の保護を別入口へ転記しない。

## 7. 既存 anchor

[ミニドラ接続変更案](ミニドラ接続変更案.md) の固定版・実入口に正確な path と観測範囲を記録する。存在しない API や参照用 Adapter の実通信を発明しない。

## 8. 実装要件

変更候補ごとに実 consumer、不足、最小 path、契約、正負試験、後継、復元条件を記す。不変更判断には既存保護の根拠を付ける。公開ソースと工程記録だけを掲載し、私有の原典・完全対応表・秘密・運転状態・raw 証拠を stage しない。

## 9. Safety invariants

HDS-BRAIN、Approval Gate、final review、hash-chain audit、Runtime Invariants は変更しない。ミニドラ内部の局所採否・P状態をBLUEの採否・正本状態・外部作用権限へ昇格させない。既存保護と情報境界を維持し、timeoutを停止に、sourceを実証に読み替えない。

## 10. Operator usability

利用者が GitHub 上で成果、実装していない部分、検証結果、次の条件、復元点を確認できること。私有記録だけで通常の成果保管を不要と判定しない。

## 11. Tests

有限受入は6不足について実consumer、必要時だけの最小path、変更不要条件、正負受入、後継、復元条件が具体化すること。負例は本案件から別repo全面改修の承認を導かないこと。局所の資料・source照合と独立読取監査を行う。後続の製品試験は NOT_RUN のまま。

## 12. Validation commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

文書工程のため doctor、packaging、release 生成、installed／live smoke は対象外。検査の省略・弱化は行わない。通常の日本語 gate は docs:check に含む。全移行・GO を扱わないため厳格 gate 成功は今回の条件に追加しない。

## 13. Manual smoke

索引→進捗→変更案の参照、固定版の path、未実施表示、公開除外、後継と復元条件を読取監査する。製品 UI・新しい接続の起動は対象外。

## 14. Permanent-use check

今回の成果保管を恒久利用の証拠にしない。実接続、版変更、切断、取消、結果不明、秘密、更新・復元は後継の実 consumer と各 profile で受入する。

## 15. Final report format

有限成果、変更ファイル、リスクと証拠分類、実行コマンド・結果・全失敗、未実施、P13、main commit、push／remote、二世代 refs と復元点を簡潔に示す。検証・commit・push の未完了を完了扱いしない。

## 16. Next-phase dependency

次候補は B03.01。この単位の局所受入と Git 完結・引継ぎで境界停止する。全工程の範囲委任に従い、次単位は現指示、依存、版、変更範囲、未決作用を新しい入口で再同期する。別repo変更・実業務作用・出荷GOは別判断。
