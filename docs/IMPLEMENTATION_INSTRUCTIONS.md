# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。owner指定の最新版QE三点全文、適用AGENTS.md、作業標準要領、直前のactive指示、HEAD・差分・対象producer／consumerを再読した。Windows上のBLUE本体を対象にする。

## 今回の施工単位

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-RECONCILIATION-TEST-FIXTURE。関連単位=C05.02（tool候補 fixture のみ。製品実装状態は変更しない）。前バッチの拡張Gateway結果調停suiteで見つかった1件の失敗原因を確定し、fixture契約を直して次consumerの検証を有効にする。

`apps/gateway/test/execution_result_reconciliation.test.ts`は、`createLLMToolCallCandidate`を`@blue-tanuki/core`の実行時公開APIからimportしていたが、そのexportは存在しない。tool候補の負例を実行した時点で`TypeError`になり、Executorが`llm_failure.kind=unknown`・resultなしを返していた。fixtureをschema_version／call_id／tool_name／arguments／authority_boundaryを備える候補値へ変更した。公開APIや製品コードは変更せず、HDSが候補を意味採用・実行へ昇格しないという既存期待を保つ。

## 確認状態

`pnpm exec vitest run apps/gateway/test/execution_result_reconciliation.test.ts`は29/29 PASS。`pnpm typecheck`、15 workspace projectsの`pnpm build`、`pnpm docs:check`（通常日本語基底・licenseを含む、移行負債77件）もPASS。`git diff --check`もPASS。これは合成fixtureの結果調停・拒否経路だけの証拠であり、製品の新機能成立や全suite PASSを意味しない。

開始HEAD=`bd20d98aefb8c8eaef290631492262a51aefb25c`。編集前local復旧branch二世代とremote backup tag二世代を開始HEAD／直前HEADで照合した。復元世代は`bd20d98aefb8c8eaef290631492262a51aefb25c`／`f85c681eb8ce0b8542b06c111dde354527eeca4c`。backup tagはlease付きatomic push後に同じ世代へ更新した。参照方式の状態はMIGRATION_COMPLETE。

## 維持する境界と次の接続

製品runtimeの欠陥修正ではなく、検証fixtureの誤ったimportを修正した。既存のBroker独立Permission、D02.03移行、D08.01単一外部作用・結果照合、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、5OS installed対応のBUILD_GAPは残る。実provider・credential・業務外部作用、D4Pocket／ミニドラ別repo変更は行わない。C08.03実provider検証は保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。次の製品consumerは次作業の最新正本・active指示・現物再読後に選ぶ。
