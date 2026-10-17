# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定の最新版QE三点全文（rev2.3）、root AGENTS.md、作業標準、QE再同期規約、前回active指示、actual HEAD／remote／dirty state、D08.01／D09.01要求、JのOperationPlan checkpoint／projectionとloopback inspection serverの現行経路を再読した。Windows上のBLUE-TANUKIだけを変更対象とする。

## 今回の施工単位

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-D08.01-D09.01-RECEIPT-OBSERVATION-INGESTION。関連単位=D08.01（部分接続）・D09.01（部分接続）。開始HEAD=`a343092b92c31afe3bd7af0f60831c74a3fe189e`、clean。編集前のlocal復旧branchは`a343092`／`d305081`、remote backup tagも同SHAへ原子的に回転し、remote mainと照合した。短縮refに衝突する古いlocal tagは非正本として変更しない。

backup ref移行状態=`MIGRATION_COMPLETE`（2026-10-12）。

loopback inspection serverが返す合成receiptを厳格に照合し、plan/revision/step/command digestとpayload digestが合致したことを、秘密・raw receipt IDを含まない非権威観測としてJの永続OperationPlan状態へ記録する。既存Control Centerは観測状態とevidence digestを表示する。観測が一致してもplan/step status、成功、goal達成、再実行権限は変えない。

許可範囲は隔離した127.0.0.1 inspection serverと合成値のみ。Gmail/外部provider、実credential、実業務作用、実network lookup、C08.03、D4Pocket／ミニドラ別repo、公開・出荷判断は対象外。raw receipt、宛先、本文、外部IDをJ projection/UIへ出さない。

## 確認状態

- `pnpm exec vitest run apps/gateway/test/external_receipt_observation.test.ts apps/gateway/test/external_action_reconciliation.test.ts apps/gateway/test/serve_projection.test.ts apps/gateway/test/operation_plan_runtime.test.ts packages/channel-webchat/test/webchat.test.ts`: 5 files／92 tests PASS。receipt配列を持たない旧checkpointのdigest検証後移行を含む。
- `pnpm typecheck`: PASS。`pnpm build`: PASS、15 workspace projects。`pnpm hds:standalone`: PASS、health=ok、audit chain valid、Runtime Invariants all_ok=true、`hds_calls_llm=false`。
- `pnpm docs:check`: PASS。docs、日本語基底通常gate、license。Markdown 186、移行負債77件。`git diff --check`: PASS。

## 成立範囲・次consumer

今回の接続先はlocal loopback inspection fixture response→厳格parse・command key／Executor command／request payload digest照合→非権威・digest-only J checkpoint→版付きruntime snapshot→既存Control Center。再起動後の状態保持と再送禁止表示を確認した。raw receipt取得のproduct runtime route、実サービス向け照会adapter、provider照会権限は実装・実行していない。D08.01／D09.01とも全体成立ではなく`BUILD_GAP`を維持する。

次はowner操作と現在の認可・観測権限を通す、必要時だけ起動する読取専用照合adapterのproducer。実providerのlive実行は別承認がない限り行わない。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
