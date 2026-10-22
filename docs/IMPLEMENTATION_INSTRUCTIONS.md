# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするowner指定の最新版三点セットである。独立作業の開始・切替・再開では、三点セットの全文を読み直す。ただし読むのは現行pinが指すこの一組だけとし、適用`AGENTS.md`、active指示、最新HEAD・dirty差分も再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) のログとして保持し、今回の依存・変更系譜・矛盾に必要な箇所だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計→一気通貫の実装→結合形状成立を進める。製品全体の実装が未完了の間は詳細QC／QAを先行させない。型・build・現在の次consumerを通す限定確認と、安全・権限・秘密の保護は継続する。

## 現在確認できる結合形状

D05.02とD08.01は局所経路のみ部分`WIRED`で、remote providerやowner実操作を含む全体は`BUILD_GAP`。各channelの合成fixtureで成立した経路・未確認範囲は履歴に置く。Slack／Discord／Teams／LINEを`first-party-preview`のまま維持し、credentialed live、実provider、実HDS運転をfixture証拠から推定しない。

F14.02では、LINE admitted inboundからGateway reply、SQLite durable outbox、429待機、同じretry keyによる再試行、409 accepted結果までのsynthetic served subpathを接続した。実LINE credential/API送信、実HDS、外部作用は未実施。F14.03のlive受入はOD-03条件が具体化するまで進めない。実装・限定確認・未確認範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)を参照する。

製品全体は`SYSTEM_SHAPED`／`BUILD_COVERED`未成立、QE_QC／QE_QA未開始。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`、公開・出荷保留を維持する。

## 直近BUILD_BATCH：rev2.4 CR-3

CR-0でI-01 Unix install／uninstall対象ガードを共通実装し、配布物へ含めた。物理親解決、二重slash／dot traversal／広域root／親子重複の拒否を各入口へ接続した。I-06 Windows開発用Force installは、広域・source/data重複・reparse対象を変更前に拒否し、処理計画確認と`-WhatIf`を追加した。Windows fixtureとWSL Unix fixtureで非破壊確認済み。詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の`QEB-73-CR0-UNIX-WINDOWS-INSTALL-TARGET-SAFETY`に記録する。root／HOME等への実削除・実OS導入は行っていない。

CR-1で`release_hardening_gate`と`validate:packaging`を同一のfail-closed workflow検査へ接続した。許可条件はblock形式の`workflow_dispatch`一つ、明示的なworkflow-level `read`／`none`権限、job-level権限上書きなし。既存workflowを維持し、自動trigger・write権限・未対応YAML形状を拒否する。release／packaging gate、関連10 tests、docs監査、変更対象strict型検査、強制project-reference型検査、workspace buildはPASS。詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の`QEB-73-CR1-MANUAL-ACTIONS-GATE-SYNC`に記録する。GitHub Actions自体は未実行。

CR-2でGUIのprovider設定・費用profile／budgetをenv-fileへ保存し、設定再読込後の通常Compute予約へ接続した。provider疎通と通常Compute準備状態を分け、Computeの準備表示は設定根拠だけとし、現在window使用量を確認したとは示さない。loopback合成providerのserved jobは、保存設定でGatewayを再起動し、待機job再開→C候補→J review→合成file.search→receipt／M→WebChat再接続後の保存結果返却まで通る。費用予約・上限計上は通常Compute adapterでも別途確認した。詳細と未確認範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の`QEB-73-CR2-GUI-COMPUTE-RESERVATION-SERVED-JOB`に記録する。

CR-3ではI-04に関係する現行Compute／budget／Executor delegation 47 testsと5種channel-grant consumerを再観測し、選定範囲でfixture契約の失敗は再現しなかったためI-04によるコード変更は行っていない。旧83 FAILはc86時点の診断値であり現HEADの結果へ転記しない。I-05はLINE transport／durable outbox／Gatewayでcaller cancel、内部timeout、配送未確定、明示的未配送、配送成功を分離し、配送未確定の再送を有効な冪等key・同一内容・期限の条件内に保った。合成経路でconsumer状態まで確認し、全case網羅や詳細QCは行っていない。CR-2はseed済みwaitからの合成再開served subpathであり、ownerの新規仕事全体、全機能群、全体`SYSTEM_SHAPED`を成立したとは扱わない。

CR-3ではCompute／budget／Executor delegationの現行consumer関連47 testsと5 channel-grant consumerを再観測し、現HEADでI-04の失敗を再現しなかった。c86時点の83 FAILは歴史診断のまま保持した。I-05はLINE transportでcaller cancelと内部timeoutを別原因として分類し、caller cancel後の結果をunknownとしてdurable outboxへ保存して再送を止める。成功HTTP statusを本文読取へ依存させず、合成Gateway経路で保存状態まで確認した。詳細な試験射程は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の`QEB-73-CR3-COMPUTE-REOBSERVATION-LINE-CANCEL-CLASSIFICATION`に記録する。CR-2／CR-3はいずれも部分subpathであり、ownerの新規仕事全体、全機能群、全体`SYSTEM_SHAPED`を成立したとは扱わない。

## 次のBUILD_BATCH：rev2.4 E2E-01

WebChatで同一task IDとrevisionを保持し、目的→C→J→安全な合成Approval／Broker作用→receipt→M→結果返信→再計画・復帰までの既存producer／consumer接続を進める。stub、projection、旧planなど実経路が切れる箇所を先に追う。一仕事の試験経路は`SYSTEM_SHAPED`候補に限り、`BUILD_COVERED`や製品全体完成とは扱わない。QE_BUILDを継続し、詳細QC／QAは全体実装形状後に行う。E2E-02の全能力群とF15の具体service接続は現行工程順で保持する。C08.03実provider、OD-03 live、D4-Pocket／ミニドラの別repo変更、P13公開GOは保留する。

## 保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。D4-Pocket／ミニドラへの変更は別repoの限定委任を要する。C08.03とP13の保留を維持する。

main一本・単一writer・通常Windows開発。batch開始前にmain／remote・dirty差分・同時writer・復元点を確認し、意味あるbatch終端で限定commit／pushする。closeout時はremote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migration=`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行`AGENTS.md`のowner許可条件内だけで使用する。
