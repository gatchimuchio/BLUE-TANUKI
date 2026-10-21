# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

D05.02は部分的に`WIRED`。QEB-38／40で取消signal・native shell worker観測・lifecycle evidence回復を、QEB-41でowner-facing task単位取消を、QEB-42で取消受付・Executor settlement記録のprivate ledger／CompleteHistory回復を、QEB-43でfirst-party adapter requestへのsignal伝播を接続した。QEB-43はcloseout済みで詳細は履歴ログにある。D05.02全体は未成立。remote provider内部の停止確認と、AbortSignal非協調toolの強制停止は未成立のまま記録し、未確認の停止を表示しない。

## 次のBUILD_BATCH

現時点で次のBUILD_BATCHは選定していない。次の独立作業開始時に、QE_CURRENT_AUTHORITYで固定された三点セットの全文を読み直す。現行HEAD／dirty state／実装と照合し、rev2.3の未接続producer→consumerから次の対象を決めて本指示を更新する。実装単位は`CODE_PRESENT`／`WIRED`／`BUILD_GAP`／`BLOCKED_AUTHORITY`で記録する。旧版と完了履歴は全体を再読せず、依存・変更系譜・矛盾の解消に必要な箇所だけ参照する。QE_BUILDを維持し、全体の結合形状成立前にQC／QAを開始しない。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
