# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。owner指定の最新版QE三点全文（rev2.3）、適用AGENTS.md、作業標準、QE再同期規約、前回active指示、actual HEAD・差分、D08.01／D09.01原文、HDS plan projectionからWebChat runtime snapshot・Control Centerへの現行経路を再読した。Windows上のBLUE-TANUKIだけを変更対象とする。

## 今回の施工単位

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-D08.01-D09.01-PLAN-STATUS-PROJECTION。関連単位=D08.01（部分接続）・D09.01（部分接続）。開始HEAD=`d3050810c378917b5b10889020cfadc2027fb415`、clean。編集前にlocal復旧branch二世代とremote backup tag二世代を`d305081`／`588c547`で照合し、`MIGRATION_COMPLETE`を確認した。

HDSの`operation_plans.projection()`から認証済みGatewayの`/runtime/snapshot`を通り、既存WebChat Control Centerへ版付きJ plan/statusを表示する。表示用projectionはplan/revision/step ID digest、operation/status、command/result/delivery digest、M receipt statusだけに限定する。goal、target、recipient、本文、raw command/resultを含めず、`used_for_authority=false`／`raw_payload_exposed=false`を維持する。不正なauthority flagsやdigest形状は表示不可とする。

`outcome_unknown`を「結果不明」、receipt観測未記録、receipt照合まで再送しない状態として表示する。これはJ状態の読取projectionであり、外部receiptを照会するproduct adapter、そのreceiptをJへ記録する経路、D4Pocket画面との実接続はまだない。D4Pocket／ミニドラ別repo変更、C08.03実provider検証、実credential・実業務作用、公開GOは対象外。

## 確認状態

- `pnpm exec vitest run apps/gateway/test/serve_projection.test.ts packages/channel-webchat/test/webchat.test.ts`: 78/78 PASS。
- `pnpm typecheck`: 修正後PASS。
- `pnpm build`: PASS、exit 0、15 workspace projects。
- `pnpm docs:check`: PASS。docs、日本語基底通常gate、license。Markdown 186、移行負債77件。
- `git diff --check`: PASS。

## 成立範囲・次consumer

D09.01の版付きJ plan/statusのControl Center投影は部分接続。これはD4Pocketの既存画面への統合やD09.01全体成立を示さない。D08.01は結果不明をJが保持しUIで確認できるが、外部receipt lookupの正規producerと、その出所・command/payload digestを検証して非権威観測としてJへ記録するconsumerが未接続なので`BUILD_GAP`。

次は対象・権限を絞ったread-only external receipt adapterを接続し、合致／不一致／不在／複数一致を区別した観測をJへ記録・表示する。どの結果も権限やgoal達成を発行せず、元の`outcome_unknown`や再送禁止を自動解除しない。C08.03実provider試験は保留、D4Pocket／ミニドラ別repoは変更しない。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
