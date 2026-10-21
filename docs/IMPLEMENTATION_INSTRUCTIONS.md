# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。QEB-46で合成Executor→分離inspection service→結果照合→digest-only M記録、QEB-47でDeveloper HTTP ingressから既存`outcome_unknown`のread-only照合consumer、QEB-48で一つのbuild済みGateway serveを通るlocal C→HDS候補保持→Jの`plan:review`→WebChat L3内容確認・単回token→Broker/Gmail adapter→結果不明→2回のGateway再起動→read-only照合を接続した。Cは最大5件のloopback fixture要求、作用は合成inspection server上の1件だけで、応答喪失後もJ/Mの`outcome_unknown`を保ち、照合GETは1回、receipt IDは非表示。endpoint未設定は通信0回。ownerの実際の操作、実provider・実資格・業務送信、browser UI経路は試していないため、D08.01全体は`BUILD_GAP`。QEB-49でTelegramの安定actor IDと同一process内の重複update抑止をadapter handlerまで接続したが、再起動をまたぐdedupe、複数入口の権限再評価、添付・分割返信は未接続でF10.02全体は`BUILD_GAP`。F10.01の実装状態・served job縦断は未確定。詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)のQEB-48／49記録にある。

## 次のBUILD_BATCH

次のBUILD_BATCHは`F10.01-WEBCHAT-TO-GOVERNED-JOB`。F10.02の明示依存F10.01について、authenticated WebChat input→Gateway/HDS→Jの採否→既存job/operation consumer→観測・返信の実producer→consumerをserved local fixtureで追い、未接続なら同一バッチで必要な実装を接続する。実provider・実資格・外部業務作用は使わず、依存の完成QAや全workspace suiteを先行条件にしない。次の独立した作業・切替・再開時は`QE_CURRENT_AUTHORITY.md`が固定する三点セットの全文を読み直す。適用`AGENTS.md`も読み直す。QE_BUILDを維持し、全体の結合形状成立前に詳細QC／QAを開始しない。旧版と閉じた作業はログとして保持し、今回の依存・変更系譜・矛盾を解く必要がある場合だけ該当箇所を参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
