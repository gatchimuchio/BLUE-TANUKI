# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。QEB-46で合成Executor→分離inspection service→結果照合→digest-only M記録を接続し、QEB-47でbuild済みGatewayのDeveloper HTTP ingressから既存`outcome_unknown`のread-only照合consumerを接続した。D08.01全体は`BUILD_GAP`であり、初期の計画・J確認・合成作用を同じGateway serve経路で通すことと、owner-facing確認経路は未成立。F10.02も`BUILD_GAP`。今回の範囲・証拠・制限は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)のQEB-47記録にある。

## 次のBUILD_BATCH

次のBUILD_BATCHは未選定。次の独立した作業・切替・再開時は`QE_CURRENT_AUTHORITY.md`が固定する三点セットの全文を読み直す。適用`AGENTS.md`も読み直す。最新HEAD／dirty state／実装から、残るproducer→consumerを一つ選ぶ。QE_BUILDを維持し、全体の結合形状成立前に詳細QC／QAを開始しない。旧版と閉じた作業はログとして保持し、今回の依存・変更系譜・矛盾を解く必要がある場合だけ該当箇所を参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
