# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用AGENTS.md、作業標準要領、現行ownerの継続開発指示、前batch指示、E03.02／E01.01要求、Cron→InboundRouter→Gateway handler→永続cursorの実経路を再読した。前batch `QEB-03-E03.02-CRON-NO-REPLAY-OWNER-RESOLUTION` は実装commit `9522971b73d86a4b2222de6f44a8014fde1fd38e`、閉鎖commit `84860ffdca7f681fd98b00ad325823d65a609929` でpush済み。今回開始HEAD／`origin/main` は `84860ffdca7f681fd98b00ad325823d65a609929`、開始時worktree clean。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-CRON-FAILURE-OUTCOME-PROPAGATION`。関係単位=E03.02「未決作用・M pendingの回復」、E01.01「永続jobと重複event」。BLUE-TANUKI内のみを対象とし、D4Pocket／ミニドラ、実provider／credential、実外部業務作用、公開・出荷判断は対象外。

### 目的と接続先

共有`InboundRouter`はhandler例外を捕捉してログのみ出し、Cron schedulerへ失敗を伝えない。Cron eventのdispatch中にGateway handlerがthrowしてもschedulerは正常returnを受け、永続cursorを`handler_returned`にsettleするため、再起動後に必要な`outcome_unknown`保護が機能しない。GatewayでCron channelだけ例外伝播を有効化し、`CronSchedulerChannel.fire`の既存catch／`GatewayCronEventStore.settle`へ接続する。その他のchannelの例外封じ込めは維持する。

### 安全境界・成立条件

- InboundRouterの一般動作は従来どおり例外を閉じ込める。例外伝播はGatewayが明示した`cron` channelだけに限定する。
- Cron handlerがthrowした場合、cursorには`outcome_unknown`を保存して次eventをブロックする。例外本文やrequest payloadをcursor・通知へ保存しない。handlerが正常returnした場合の`handler_returned`意味は「handlerが戻った」であり、外部作用成功を証明しない。
- HDS／Approval／Broker、operation、既存resume・retry、実外部作用の挙動は変更しない。再送せず、uncaught failureを成功へ読み替えない。
- 検証はrouterのchannel別伝播、Cron→GatewayCronEventStoreの合成疎通、関連focused tests、typecheck、build、docs gate、repo-health、diff check。live/provider、credential、外部業務作用、全suite、QE_QC／QE_QAは実施しない。

### Git保全

復旧状態=`MIGRATION_COMPLETE`。編集前にlocal recovery branch二世代とlocal tagを現状照合し、local／remote main=`84860ffdca7f681fd98b00ad325823d65a609929`、remote tag二世代を期待値付きで再確認した。local backup pairとremote tag pairを現世代=`84860ffdca7f681fd98b00ad325823d65a609929`、前世代=`e57633ca34240db6410af9332808d4fd914205f0`へ期待SHA付きで回転し、local tagも同じ値へ同期した。旧remote backup branchは不在。バッチ途中では世代回転しない。

未接続のpending approvalを含むdurable job lifecycle、実外部receipt／結果とのread-only照合、旧worker／approval世代の回復は`BUILD_GAP`。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。実装commit=`168544c17d101dfd93c094f586a4c98bd7ee23ea`を`main`へpush済み。push後・closeout文書commit前の実測でlocal／remote mainは同SHA、local recovery branch二世代・local tag二世代・remote backup tag二世代は現世代=`84860ffdca7f681fd98b00ad325823d65a609929`、前世代=`e57633ca34240db6410af9332808d4fd914205f0`で一致。次consumerはpending approvalを含むdurable job lifecycleを結果不明のまま明示表示・復帰へつなぎ、実外部結果の照合経路を安全なread-only契約から具体化する。
