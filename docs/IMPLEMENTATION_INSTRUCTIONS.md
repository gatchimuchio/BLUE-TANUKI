# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。owner指定の最新版QE三点全文、適用AGENTS.md、作業標準要領、直前のactive指示、HEAD・差分、D08.01原文と対象producer／consumerを再読した。Windows上のBLUE本体だけを対象にする。

## 今回の施工単位

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-D08.01-LOCAL-EXTERNAL-RESULT-PATH。関連単位=D08.01（部分接続）。開始HEAD=`588c5471eccea558ce75772bf0aa868097cce82c`、clean。編集前にlocal backup branch二世代とremote backup tag二世代が開始HEAD／直前HEADへ一致することを確認した。参照移行状態は`MIGRATION_COMPLETE`。

D08.01はC候補→J選択→本人確認→Broker→非冪等外部作用→結果照合までを通常経路へ接続する。現物ではOperationPlanの対象resolverがfile.searchだけで、Gmail writeの候補をJの計画stepからcommandへ結べず、一般tool-action結果もExecutorの耐久J outboxへ配送できなかった。次の限定consumerとして、単一宛先の`gmail.write`／`message.send`だけを計画stepへ接続し、Brokerが発行した`command_key`と`command_digest`を承認済みExecutor contextからGmail adapterへ渡す。idempotency keyは照合用hintであり、providerが保証する冪等性とは扱わない。必要なticket identityがないadapter呼出しは送信前に拒否する。

Executor結果配送を既存file.search専用profileと、登録済みtool adapterの最小result profileに分けた。Gatewayはticket、adapter descriptor、tool invocation境界、実結果digestを検証し、Jは既存のOperationPlan binding・admission・payload digestを再照合して結果不明を受領する。配送・外部receiptは権限や成功を生成しない。

合成C候補だけを使うlocal integrationでは、JがGmail stepを保持・選択し、L3 `human_final_review` proof、Brokerの単回実行、loopback検査serverへつないだ。検査serverは同じkeyのPOSTも毎回別作用になる非冪等実装で、受理直後に最初の応答を破棄する。結果不明をJへ耐久配送し、3回のstore再起動後にread-only照会APIが同じreceiptを返すこと、作用数が1件のまま、J状態が`outcome_unknown`のまま、同commandの再承認と再審査が拒否されることを確認した。

## 確認状態

型検査、15 workspace projectsのbuild、HDS standalone、対象testを確認する。全suite／QC／QAを先行実行しない。

- `pnpm exec vitest run apps/gateway/test/external_action_reconciliation.test.ts apps/gateway/test/execution_result_reconciliation.test.ts apps/gateway/test/operation_plan_runtime.test.ts packages/blue-tanuki/test/tools_builtin.test.ts`: 最終82/82 PASS。
- `pnpm typecheck`: PASS。
- `pnpm build`: 型検査のartifact cleanupと同時実行した初回はworkspace distが競合して失敗。型検査終了後の単独実行で15/15 projects PASS。
- `pnpm hds:standalone`: health=ok、audit chain valid、Runtime Invariants all_ok=true、`hds_calls_llm=false`。
- `pnpm docs:check`と`git diff --check`: 最終文書・台帳更新後に実行する。

## 成立範囲・残るconsumer

このバッチでCODE_PRESENT／WIREDになったのは、合成C候補→J計画保持・明示選択→単一宛先Gmail write command→L3／Broker→adapter invocation→durable unknown result→再起動J result consumer、およびtest-only inspection APIの読取照合である。これはD08.01全体や実provider経路の成立ではない。C候補とowner proofはfixtureで、GUI画面操作は通していない。read-only reconciliation APIはtest-onlyで、そのreceiptをHDS/J/Mやoperator UIへ外部evidenceとして返すproduct consumerは未接続である。照会がacceptedでも元の結果不明は維持し、自動成功・再送へ変えない。D08.01全体は`BUILD_GAP`。

次consumerは、実装対象と権限を絞ったread-only external receipt adapterから、出所・digest・command bindingを保った非権威evidenceをJへ渡し、操作者が確認できる既存surfaceへ表示する経路。C08.03実provider試験は引き続き保留し、実credential・実業務送信は行わない。独立Broker Permission、他の外部作用、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、5OS installed対応はBUILD_GAP。D4Pocket／ミニドラ別repoは変更しない。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
