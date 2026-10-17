# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の単位開始時にowner指定の最新版QE三点全文（rev2.3）、適用AGENTS.md、作業標準、QE再同期規約、active指示、最新HEAD／remote／dirty state、D08.01／D09.01要求、現行J plan・receipt状態を読み直した。Windows上のBLUE-TANUKIだけを対象とし、D4Pocket／ミニドラには変更を加えない。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`。QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-02-D08.01-D09.01-GATEWAY-HTTP-RECEIPT-RECONCILIATION-SMOKE。関連単位=D08.01／D09.01（部分接続）。開始HEAD／origin/main=`af905abcdd664c6d79ec9a94a45708174aa13ecf`、clean。編集前local recovery branchは`af905ab`／`41bea5f`、remote backup tagも同じ二世代へlease付きatomic pushで回転した。既存の衝突した古いlocal tagsは変更していない。

### 今回の目的と境界

既存Developer HTTP入口から`plan:reconcile`を呼び、HDSの一回券検査、合成loopback inspection serviceへのread-only GET、digest-only観測、既存runtime/status projectionまでを、実際に起動したbuild済みGatewayで通すdevelopment-only smokeを追加する。合成送信fixtureを使う場合も対象はローカルだけとし、実Gmail・credential・外部provider・実業務作用を使わない。endpoint未設定と期限切れ拒否の表示／statusは既存契約で確認し、試験専用の権限迂回やruntime hookを製品へ追加しない。

対象=D08.01／D09.01の実Gateway結線証拠。対象外=C08.03実provider試験、D4Pocket／ミニドラ変更、全体QE_QC／QE_QA、公開・出荷判断。危険な未確認作用は無効のままにし、期限切れ・照合一致・通信失敗を業務成功へ昇格させない。

### 成立した経路

既存Control CenterのJ plan表示に、`outcome_unknown` step向けの明示的なDeveloper照合ボタンを追加した。要求は既存の認証済み`/operators/developer/invoke`へ送り、HDSがowner/channel、現在のplan revision、step binding、結果不明状態、対象operationを照会前と一回券消費時に再確認する。許可は一回限りで30秒後に破棄し、期限切れ・別identity・別surface・古いrevision・状態変更では照会しない。

現状の対象は合成Gmail `message.send`だけである。任意入力URLを受け取らず、`BLUE_TANUKI_LOCAL_INSPECTION_ENDPOINT`が未設定なら通信しない。設定時もHTTPの明示的`127.0.0.1`とport付きroot URLに限り、固定routeへGETを一回送る。リダイレクトや再送はない。Jは照合結果をdigest-onlyで観測記録し、step状態を`outcome_unknown`のまま保つ。一致は成功・目標達成・再実行許可を意味しない。

## 今回の確認状態

- `pnpm typecheck`: PASS。
- `pnpm build`: PASS、15 workspace projects。
- `pnpm exec vitest run apps/gateway/test/external_action_reconciliation.test.ts`: PASS、期限切れ一回券でGETなし・結果不明維持・live routeと共有する拒否文面を確認。
- `pnpm smoke:receipt-reconciliation`: PASS。build済みGatewayのmatched／endpoint未設定をHTTPから検査し、GET回数、digest-only projection、`outcome_unknown`、raw receipt ID非露出を確認。
- `pnpm docs:check`: PASS。日本語基底は規定成立・移行中、移行負債77件を維持。
- `git diff --check`: PASS。
- 実provider、credential、外部provider照合、実業務作用、D4Pocket／ミニドラ別repo、全体test／QC／QA、P13公開GOは今回の対象外。

## 成立範囲・次consumer

build済みGateway processを通すDeveloper HTTP→HDS→合成loopback GET→digest-only観測→既存snapshot/chat projectionが成立した。endpoint未設定では照会しない。期限切れは内部境界試験で明示的に拒否し、同じroute文面と`outcome_unknown`を維持した。証拠範囲は合成runtimeに限り、実provider receipt取得、全体結合、D4Pocket画面は未成立のためD08.01／D09.01の`BUILD_GAP`を維持する。次consumerは最新版QE三点正本と現物から残る結合欠損を選び、作業開始時に全正本を再読する。実providerのlive試験は開始しない。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、外部公開・出荷判断・別repo変更の別途許可条件を維持する。
