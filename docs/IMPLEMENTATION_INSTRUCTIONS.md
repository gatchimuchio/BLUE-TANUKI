# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするowner指定の最新版三点セットである。独立作業の開始・切替・再開では、三点セットの全文を読み直す。ただし読むのは現行pinが指すこの一組だけとし、適用`AGENTS.md`、active指示、最新HEAD・dirty差分も再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) のログとして保持し、今回の依存・変更系譜・矛盾に必要な箇所だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計→一気通貫の実装→結合形状成立を進める。製品全体の実装が未完了の間は詳細QC／QAを先行させない。型・build・現在の次consumerを通す限定確認と、安全・権限・秘密の保護は継続する。

## 現在確認できる結合形状

D05.02とD08.01は局所経路のみ部分`WIRED`で、remote providerやowner実操作を含む全体は`BUILD_GAP`。各channelの合成fixtureで成立した経路・未確認範囲は履歴に置く。Slack／Discord／Teams／LINEを`first-party-preview`のまま維持し、credentialed live、実provider、実HDS運転をfixture証拠から推定しない。

F14.02では、LINE admitted inboundからGateway reply、SQLite durable outbox、429待機、同じretry keyによる再試行、409 accepted結果までのsynthetic served subpathを接続した。実LINE credential/API送信、実HDS、外部作用は未実施。F14.03のlive受入はOD-03条件が具体化するまで進めない。実装・限定確認・未確認範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)を参照する。

製品全体は`SYSTEM_SHAPED`／`BUILD_COVERED`未成立、QE_QC／QE_QA未開始。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`、公開・出荷保留を維持する。

## 次のBUILD_BATCH

F15.01は未収容43要求の非公開登録consumerまで`WIRED`。Composioの`search`／`accounts`／`scopes`／`execute`はHDS・operation catalog・tool registryに接続済みだが、実provider・実資格・外部業務作用は未使用。PostHogは`accounts`の限定projectionからauth schemeと接続regionを観測し、live `execute`で明示`expected_provider_region=us|eu`との一致と`API_KEY`を再照合する。欠落・不明・競合は送信前に拒否する。Composio公式資料間にregion／subdomain／self-hosted接続契約の記述差が残るため、この経路は観測できた`us`／`eu`だけを扱い、その他を対応済みとしない。接続状態・scope推薦・provider metadataはtask consentや権限の証拠ではなく、HDS Approval Gate L3を維持する。

次はF15.03として、非公開登録済み要求から公式契約で有限化できる実consumerを選び、目的→判断→既存制御／作用→結果観測へ接続する。動的provider/plugin/Muse catalogと形式移行は具体的なconsumerが成立するまで`BUILD_GAP`。F15.02全体、接続setup上のowner consent、付与済みscopeの観測、43件のservice実装は未成立。C08.03実provider保留、P13公開GO保留、QE_QC／QE_QA未開始を維持する。

## 保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。D4-Pocket／ミニドラへの変更は別repoの限定委任を要する。C08.03とP13の保留を維持する。

main一本・単一writer・通常Windows開発。batch開始前にmain／remote・dirty差分・同時writer・復元点を確認し、意味あるbatch終端で限定commit／pushする。closeout時はremote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migration=`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行`AGENTS.md`のowner許可条件内だけで使用する。
