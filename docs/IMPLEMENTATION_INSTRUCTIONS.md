# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の単位開始時にowner指定の最新版QE三点全文（rev2.3）、適用AGENTS.md、作業標準、QE再同期規約、active指示、最新HEAD／remote／dirty state、D08.01／D09.01要求、現行J plan・receipt状態を読み直した。Windows上のBLUE-TANUKIだけを対象とし、D4Pocket／ミニドラには変更を加えない。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`。QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-D08.01-D09.01-OWNER-TRIGGERED-LOOPBACK-RECONCILIATION。関連単位=D08.01／D09.01（部分接続）。開始HEAD／origin/main=`41bea5f3c6b37ea097960131dccfbb37cba5e034`、clean。編集前local recovery branchは`41bea5f`／`609d621`、remote backup tagも同世代へlease付きatomic pushで回転した。既存の衝突した古いlocal tagsは変更していない。

### 成立した経路

既存Control CenterのJ plan表示に、`outcome_unknown` step向けの明示的なDeveloper照合ボタンを追加した。要求は既存の認証済み`/operators/developer/invoke`へ送り、HDSがowner/channel、現在のplan revision、step binding、結果不明状態、対象operationを照会前と一回券消費時に再確認する。許可は一回限りで30秒後に破棄し、期限切れ・別identity・別surface・古いrevision・状態変更では照会しない。

現状の対象は合成Gmail `message.send`だけである。任意入力URLを受け取らず、`BLUE_TANUKI_LOCAL_INSPECTION_ENDPOINT`が未設定なら通信しない。設定時もHTTPの明示的`127.0.0.1`とport付きroot URLに限り、固定routeへGETを一回送る。リダイレクトや再送はない。Jは照合結果をdigest-onlyで観測記録し、step状態を`outcome_unknown`のまま保つ。一致は成功・目標達成・再実行許可を意味しない。

## 確認状態

- Gateway照合／計画境界: 3 files／11 tests PASS。合成非冪等作用1回、再起動後のread-only GET 3回、結果不明維持、owner違い、channel違い、Developer以外、古いrevision、endpoint未設定、30秒期限切れ、券の再利用拒否を確認。
- Control Center / WebChat: 74 tests PASS。照合操作が既存Developer入口を使うことと表示境界を確認。
- `pnpm typecheck`: PASS。
- `pnpm build`: PASS、15 workspace projects。
- `pnpm hds:standalone`: PASS。runtime invariants全件、audit chain、standalone healthを確認。
- `pnpm docs:check`: PASS。日本語基底は規定成立・移行中、移行負債77件を維持。
- `git diff --check`: PASS。
- 実provider、credential、外部provider照合、実業務作用、D4Pocket／ミニドラ別repo、全体test／QC／QA、P13公開GOは今回の対象外。

## 成立範囲・次consumer

ownerが現在の結果不明stepを既存Developer画面から明示選択し、HDSが照会前に主体・plan・step・期限を確認して、必要時だけ合成loopbackへ一回GETする経路まで接続した。endpointはownerが用意する合成inspection serviceを前提とし、製品にinspection serverは同梱しない。GET後のJ観測は非権威であり、業務結果は結果不明のままである。D08.01／D09.01は`BUILD_GAP`を維持する。

次consumerは、GatewayのDeveloper HTTP入口からこの経路を一気通貫で通し、結果・未設定・期限切れを既存Control Centerのstatus projectionへ反映する合成runtime smokeである。実providerのlive試験は開始しない。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、外部公開・出荷判断・別repo変更の別途許可条件を維持する。
