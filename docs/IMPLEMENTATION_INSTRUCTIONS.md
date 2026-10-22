# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするowner指定の最新版三点セットである。独立作業の開始・切替・再開では、三点セットの全文を読み直す。ただし読むのは現行pinが指すこの一組だけとし、適用`AGENTS.md`、active指示、最新HEAD・dirty差分も再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) のログとして保持し、今回の依存・変更系譜・矛盾に必要な箇所だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計→一気通貫の実装→結合形状成立を進める。製品全体の実装が未完了の間は詳細QC／QAを先行させない。型・build・現在の次consumerを通す限定確認と、安全・権限・秘密の保護は継続する。

## 現在確認できる結合形状

D05.02とD08.01は局所経路のみ部分`WIRED`で、remote providerやowner実操作を含む全体は`BUILD_GAP`。各channelの合成fixtureで成立した経路・未確認範囲は履歴に置く。Slack／Discord／Teams／LINEを`first-party-preview`のまま維持し、credentialed live、実provider、実HDS運転をfixture証拠から推定しない。

F14.02では、LINE admitted inboundからGateway reply、SQLite durable outbox、429待機、同じretry keyによる再試行、409 accepted結果までのsynthetic served subpathを接続した。実LINE credential/API送信、実HDS、外部作用は未実施。F14.03のlive受入はOD-03条件が具体化するまで進めない。実装・限定確認・未確認範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)を参照する。

製品全体は`SYSTEM_SHAPED`／`BUILD_COVERED`未成立、QE_QC／QE_QA未開始。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`、公開・出荷保留を維持する。

## 次のBUILD_BATCH：rev2.4 CR-1

CR-0でI-01 Unix install／uninstall対象ガードを共通実装し、配布物へ含めた。物理親解決、二重slash／dot traversal／広域root／親子重複の拒否を各入口へ接続した。I-06 Windows開発用Force installは、広域・source/data重複・reparse対象を変更前に拒否し、処理計画確認と`-WhatIf`を追加した。Windows fixtureとWSL Unix fixtureで非破壊確認済み。詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の`QEB-73-CR0-UNIX-WINDOWS-INSTALL-TARGET-SAFETY`に記録する。root／HOME等への実削除・実OS導入は行っていない。

CR-1ではrelease hardening／packaging gateと関連docs/testsを、現行`AGENTS.md`が許可する手動`workflow_dispatch`だけを認め、自動trigger・無断権限を拒否する意味へ同期する。実在workflowを削除してPASSへ見せない。直近の`pnpm validate:packaging`は`.github/workflows/temporary-linux-workspace-quota.yml`を「workflowは存在してはならない」として拒否したため、現行Actions条件との矛盾を解消する。続くCR-2ではGUIのprovider疎通・費用profile・budget・通常Executorを同じ条件で接続する。QE_BUILDの主経路はGUIで設定した合成Cから、費用予約、J採否、合成Broker作用、receipt、M、返信・再計画／復帰までのproduction consumerをつなぐこと。既知fixtureはこのconsumerを止める原因群に限ってCR-3で修復し、旧83 FAILを現HEADの結果として転記しない。

以前のF15.03予定とComposio／PostHogの詳細は作業履歴に残し、現batchの開始点とはしない。F15の具体的なconsumer実装は、CR-0～CR-3および一仕事のSYSTEM_SHAPED候補を前進させた後に工程表へ戻る。C08.03実provider、OD-03 live、D4-Pocket／ミニドラの別repo変更、P13公開GOは保留。製品全体は`SYSTEM_SHAPED`／`BUILD_COVERED`未成立、QE_QC／QE_QA未開始のまま維持する。

## 保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。D4-Pocket／ミニドラへの変更は別repoの限定委任を要する。C08.03とP13の保留を維持する。

main一本・単一writer・通常Windows開発。batch開始前にmain／remote・dirty差分・同時writer・復元点を確認し、意味あるbatch終端で限定commit／pushする。closeout時はremote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migration=`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行`AGENTS.md`のowner許可条件内だけで使用する。
