# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の単位開始時にowner指定の最新版QE三点全文（rev2.3）、root AGENTS.md、作業標準、QE再同期規約、active指示、実HEAD／remote／dirty state、D08.01／D09.01要求、現行receipt ingestionと縦断fixtureを再読した。Windows上のBLUE-TANUKIだけを変更対象とした。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`（2026-10-12）。

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-D08.01-D09.01-LOOPBACK-INSPECTION-ADAPTER。関連単位=D08.01／D09.01（部分接続）。開始HEAD／origin/main=`609d621918fbcbcd19f43e45e0d8e3097a4aad1f`、clean。編集前のlocal復旧branchは`609d621`／`a343092`、remote backup tagも同SHAへlease付きatomic pushで回転し、mainと照合した。衝突した古いlocal tagは非正本として変更していない。

Gatewayに合成loopback専用の読取照会producerを追加した。許可endpointはHTTP・明示的`127.0.0.1`・port付きroot URLのみで、照会method/pathは`GET /reconcile/<64桁digest>`へ固定する。redirect、credential付きURL、path/query/hash付きURL、範囲外timeout、不正content-type、64 KiB超応答を拒否し、応答を既存の厳格parseへ渡す。D08.01縦断fixtureをこのproducer経由へ切り替え、3回の再起動後照会がread-only GET 3回、合成非冪等作用1回のまま、J状態は`outcome_unknown`を維持することを確認した。

## 確認状態

- 関連Gateway試験: 3 files／10 tests PASS。endpoint制限、redirect不追従、chunked response上限、結果不明後のGET再照会・二重作用なしを含む。
- `pnpm typecheck`: 最終PASS。初回はNode `RequestInit`型に`cache` optionがなく失敗したため、`Cache-Control: no-store` request headerへ置換した。
- `pnpm build`: PASS、15 workspace projects。
- `pnpm docs:check`: 初回はQE現行正本の必須語`MIGRATION_COMPLETE`欠落でFAILし、active指示へ記載して再実行後PASS。Markdown 186、移行負債77件。
- `git diff --check`: PASS。CHANGELOG SHA-256=`4d9387ccf8083951d88ab08b1105b502efc19078886d7f8b4f27d54e230deca0`、移行台帳一致。
- HDS-BRAIN／protocolは変更しておらず、`pnpm hds:standalone`は未実行。実provider、credential、C08.03、実ネットワーク照会、実業務作用は未実施。

## 成立範囲・次consumer

成立範囲はlocal synthetic loopback inspection endpointからの固定read-only照会producerを、既存の結果不明縦断testへ接続したところまで。これはproduct runtime routeではなく、任意endpoint設定や外部providerを受け付けない。HDSは観測記録時にowner/channel・現行plan/revision/step・結果不明bindingを検証するが、production runtimeに照会を開始するowner操作と、照会前の現行認可確認は未接続である。D08.01／D09.01は部分接続・`BUILD_GAP`を維持する。

次はownerが対象stepの照会を明示し、現在のJ binding／owner／channel／照会期限を照会前に検査して、必要時のみread-only照会を開始する合成loopback経路を接続する。実providerのlive実行は別途明示承認なしに行わない。D4Pocket／ミニドラ別repo変更、公開・出荷判断も対象外。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
