# BLUE-TANUKI 有効な実装指示

現単位: **C01.03 — 受入入口の実試験接続**。`PRODUCT_BUILD_MODE`、tooling profile。直接依存C01.02はmain `20ff76087d86cf12526b11c7b94ede4ee03b500c` に保存済み。今回はC01.03だけを実装し、必須検証、二世代backup、main commit/push、remote照合まで閉じて停止する。

ownerは全工程を一単位ずつ委任している。検証済み単位の通常成果はGitHubへ履歴・成果物としてcommit/pushし、remote refsを照合する。公開主張、実業務作用、他repo変更、出荷判断、owner GOは別境界とする。private原典、封印詳細、raw証拠、秘密、runtime stateはrepoへ含めない。

## 1. 目的

`validate:agi`を追加し、要求IDで登録された実Vitest selectorを起動して、実行結果と終了値を利用者へ返す。未登録、選択0件、実装未接続、test失敗を非成功にする。既存のvalidation commandを維持し、文書検査とruntime試験を混ぜない。

## 2. Phase 境界

開発専用のローカル試験起動器と日本語利用文書を対象とする。fixtureは合成・専用一時領域に限る。Gateway、HDS-BRAIN、Approval Gate、監査、Runtime Invariants、credential、保存済み製品データ、外部service、別repoは変更・起動・接続しない。`validate:product`は既存の製品検証面として維持し、`docs:check`から独立させる。

## 3. Scope

- `package.json`
- `scripts/validate_agi.ts`
- `scripts/validate_agi.test.ts`
- `docs/VALIDATE_AGI.md`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/INDEX.md`
- `docs/開発進捗.md`
- `docs/ROADMAP.md`
- `CHANGELOG.md`
- `規定/移行台帳.json`は今回更新するCHANGELOG hashのみ

## 4. Non-goals

C01親scenario全体の受入、先行単位の仕様・実装変更、製品runtime変更、Rust product consumer、IPC・live・installed・別OS検証、`validate:product`の置換、既存gateの緩和、第三者依存追加、公開claim、GA、P13 owner GOを行わない。HDS内部原典・rev1.1施工パッケージを公開しない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、`SECURITY.md`、`AUDIT.md`、`CONFIG.md`、`README.md`、`CHANGELOG.md`、active指示、C01.03と親C01、C01.02/C01.01の受入証拠、仕様s03/s05/s06/s07/s13/s14/s15/s16、D0 §5–6／A12 §16／H5 §14-24を確認する。現物は`package.json`のscripts、`scripts/validate_product.ts`、`apps/gateway/test/validate_product.test.ts`、Vitest設定、C01.01/.02の実test selectorとする。

## 6. 必須grep

`validate:agi`、`validate:product`、`docs:check`、`BT-U-C01.01`、`BT-U-C01.02`、`BT-T-C01-01`〜`04`、`NOT_IMPLEMENTED`、`testNamePattern`、Vitest JSON reporter、`numPassedTests`、`assert_test_minimums`を登録・起動・test・文書から確認する。status文字列だけをPASS源にしていないことを追跡する。

## 7. 既存anchor

`package.json`に既存の`validate:product`と`docs:check`があり、`validate:agi`はない。製品gate本体は`scripts/validate_product.ts`、既存のその試験は`apps/gateway/test/validate_product.test.ts`。C01.01/.02には実Vitest test fileとID付きselectorがある。これらは接続先の探索・読取専用anchorであり、製品gateを改造しない。

## 8. 実装要件

1. 開発専用の`validate:agi` scriptと、重複ID・未知selector・空選択をfail-closedで扱うcase registry/runnerを追加する。
2. `--unit <ID>`、`--case <ID>`、`--list`を明示検査し、未登録は`UNREGISTERED`、選択0件は`NO_CASES`、selector未実装は`NOT_IMPLEMENTED`として非zero終了する。
3. 実装済みcaseはrepo内Vitest fileとtest-name selectorを子processで実際に起動する。正しいJSON reporter、終了code、1件以上の成功test、失敗0件を確認する。timeout、子process失敗、report欠落・不正・0件を成功扱いしない。
4. ケースstatusや`PASS`という文字列の存在をtest成功の根拠にしない。既存selectorはcase IDと実file/nameへ結ぶ。親scenario全体の受入と単位局所testを分け、部分sliceで親をPASSにしない。
5. `validate:product`、`docs:check`、`pnpm test`等の既存呼出しを維持する。runnerは開発専用としruntime import/exportに接続しない。
6. 出力と一時報告に入力payload・credential・raw製品データを含めず、case ID、test件数、終了code、失敗分類、再実行方法を示す。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval GateとL3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、Layer A/B、metadata non-authorityを変更・迂回しない。runner結果は開発testの証拠に限り、製品権限、runtime健全性、親C01全体、release readiness、P13 GOへ昇格しない。

## 10. Operator usability

CLI usage、case/unit選択、list、exit値、失敗分類、selector再実行方法を`docs/VALIDATE_AGI.md`へ日本語で記す。未登録・0件・未実装の違いを説明し、親scenario未受入を局所testのPASSで隠さない。`validate:product`と役割を混同しない。

## 11. Tests

- `BT-U-C01.03-P`: `validate:agi -- --unit C01.03`が登録済み実Vitest selectorを実行し、1件以上の成功test、失敗0、exit 0を返す。
- `BT-U-C01.03-N`: 未登録unit/case、既知caseのunit不一致による0件、明示NOT_IMPLEMENTED、Vitest failure/0 passed/malformed report/timeoutを非zeroとし、PASS表示しない。
- `BT-T-C01-03`はrunnerがNOT_IMPLEMENTEDと非zeroを返す負例検証に限る。C01親scenario01/02/04はNOT_RUN_AS_WHOLEのまま維持し、局所sliceを親受入へ昇格しない。

## 12. Validation commands

必須:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
pnpm run doctor
pnpm validate:packaging
```

追加selector:

```text
pnpm validate:agi -- --unit C01.03
pnpm validate:agi -- --case BT-T-C01-01
pnpm validate:agi -- --unit C01.03 --case BT-U-C01.02-P
pnpm validate:agi -- --case BT-T-C01-99
```

後三つはそれぞれNOT_IMPLEMENTED、NO_CASES、UNREGISTEREDの非zeroが期待値。`doctor`は現環境で実行して正確な結果を記録する。資格情報を読まず、既存listener/processを停止・再起動しない。smoke:serve/resume、live、installed、release gateは本単位に不要で未実行と報告する。

## 13. Manual smoke

Windows/PowerShellからC01.03正例を実行し、runnerがOS一時領域へ作るJSON reporterを読むことを確認する。各負例のexit code・分類を確認する。Gatewayを起動せず、製品state、credential、外部serviceへ触れない。test子processがすべて終端し、一時報告ファイルを回収したことを確認する。

## 14. Permanent-use check

証明対象は現在のWindows workspaceにおいて登録されたVitest selectorを起動・照合する開発導線まで。`validate:product`、runtime、親scenario、Rust product consumer、IPC、installed配布、別OS、live外部作用、製品完成、release readinessは証明しない。利用文書に対象・限界を明記する。

## 15. Final report format

C01.03有限受入、変更pathと実consumer、証拠源・経路・リスク、全selectorと8必須commandのexit/result、FAIL/未実施/profile/未決process、C01親/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。局所受入・Git統合・製品/release判断を分ける。

## 16. Next-phase dependency

C01.03の実test接続、未登録/0件/未実装の負例、必須検証の分類、整理・review、二世代backup、mainの単一commit/push、remote refs/clean照合、private引継ぎまで終えたら本単位だけを閉じて停止する。次候補C02.01へ惰性で進まない。C01親はPARTIALのまま保つ。
