# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするowner指定の最新版三点セットである。独立作業の開始・切替・再開では、三点セットの全文を読み直す。ただし読むのは現行pinが指すこの一組だけとし、適用`AGENTS.md`、active指示、最新HEAD・dirty差分も再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) のログとして保持し、今回の依存・変更系譜・矛盾に必要な箇所だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計→一気通貫の実装→結合形状成立を進める。製品全体の実装が未完了の間は詳細QC／QAを先行させない。型・build・現在の次consumerを通す限定確認と、安全・権限・秘密の保護は継続する。

## 現在確認できる結合形状

D05.02とD08.01は局所経路のみ部分`WIRED`で、remote providerやowner実操作を含む全体は`BUILD_GAP`。各channelの合成fixtureで成立した経路・未確認範囲は履歴に置く。Slack／Discord／Teams／LINEを`first-party-preview`のまま維持し、credentialed live、実provider、実HDS運転をfixture証拠から推定しない。

F14.02では、LINE admitted inboundからGateway reply、SQLite durable outbox、429待機、同じretry keyによる再試行、409 accepted結果までのsynthetic served subpathを接続した。実LINE credential/API送信、実HDS、外部作用は未実施。F14.03のlive受入はOD-03条件が具体化するまで進めない。実装・限定確認・未確認範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)を参照する。

製品全体は`SYSTEM_SHAPED`／`BUILD_COVERED`未成立、QE_QC／QE_QA未開始。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`、公開・出荷保留を維持する。

## 次のBUILD_BATCH

QEB-73のA03.03で比較基準面の固定61 IDを担当consumer群または未確認理由・次consumerへ割り当て、QEB-74のF15.01で未収容43件（OpenClaw入口23、Muse入口2、Muse service18）をowner管理の非公開差分登録consumerへ接続した。個別IDとサービス別scope候補は非公開記録に保持し、Public Gitには内部QE全要求対応表を置かない。QEB-75／76ではComposioのtool catalog `composio.search`、owner private account一覧`composio.accounts`、live execution前の明示account再照合を既存consumerへ接続した。QEB-77ではowner allowlist内actionについて公式v3.1のbeta scope recommendationを`composio.scopes`としてHDS／operation catalog／tool registryへ接続した。推薦scopeは既存accountの付与済みscopeを観測せず、権限にもならない。いずれもfixture限定で、実provider／実資格／外部業務作用は未実施。F15.02全体、Composio地域境界、付与済みscope確認、43件のservice実装は未成立。次は公式契約で確認できた未収容要求を有限なF15.03実装consumerへ展開し、接続setup側で必要なscope・region・owner consentの観測を続ける。動的provider/plugin/Muse catalogと形式移行は`BUILD_GAP`を維持する。P13公開GOは含まない。

## 保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。D4-Pocket／ミニドラへの変更は別repoの限定委任を要する。C08.03とP13の保留を維持する。

main一本・単一writer・通常Windows開発。batch開始前にmain／remote・dirty差分・同時writer・復元点を確認し、意味あるbatch終端で限定commit／pushする。closeout時はremote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migration=`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行`AGENTS.md`のowner許可条件内だけで使用する。
