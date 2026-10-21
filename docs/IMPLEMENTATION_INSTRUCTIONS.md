# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。QEB-46で合成Executor→分離inspection service→結果照合→digest-only M記録、QEB-47でDeveloper HTTP ingressから既存`outcome_unknown`のread-only照合consumer、QEB-48で一つのbuild済みGateway serveを通るlocal C→HDS候補保持→Jの`plan:review`→WebChat L3内容確認・単回token→Broker/Gmail adapter→結果不明→2回のGateway再起動→read-only照合を接続した。Cは最大5件のloopback fixture要求、作用は合成inspection server上の1件だけで、応答喪失後もJ/Mの`outcome_unknown`を保ち、照合GETは1回、receipt IDは非表示。endpoint未設定は通信0回。ownerの実際の操作、実provider・実資格・業務送信、browser UI経路は試していないため、D08.01全体は`BUILD_GAP`。QEB-49でTelegramの安定actor IDと同一process内の重複update抑止を接続した。QEB-51でGateway private SQLite cursorによる再起動後の重複抑止と処理途中の`outcome_unknown`保持、Telegram private/group/forum-topic単位のactor／返信先分離、4096 UTF-16単位の分割返信と部分送信結果不明をlocal fixtureで接続した。cursorにはbot tokenのSHA-256、update ID、本文digest、処理状態だけを保持し、raw message／file ID／filenameは保存しない。添付本文の取り込みは既存Inbound契約にconsumerがないため明示的な未読取案内までであり、F10.02全体は`BUILD_GAP`。QEB-50でowner-only WebChat task入口からlocal C fixture、HDS/Jの計画・L3関係審査、隔離領域のread-only実行、M receipt、WebChat返信までのserved経路を接続し、このF10.01経路を`WIRED`とした。通常inbound tokenの`plan:review`をtool processへ昇格させない。全F10.01要求の品質保証や製品全体の成立は主張しない。詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)のQEB-48〜51記録にある。

## 次のBUILD_BATCH

次のBUILD_BATCHはF10.02の未接続経路`F10.02-TELEGRAM-ATTACHMENT-CONTENT-CONSUMER`。Telegram attachment bytesを受け取った後の現行安全なproducer／consumer契約を特定し、隔離fixtureでHDSが未読取を超えて内容を扱える経路を接続する。raw file ID・filename・credentialを監査や通常metadataへ持ち込まず、未対応形式／サイズ／解析失敗を成功扱いしない。実Telegram API・実資格・外部業務作用は使わない。依存の完成QAや全workspace suiteを先行条件にせず、QE_BUILDを維持して製品全体の結合形状成立前に詳細QC／QAを開始しない。次の独立した作業・切替・再開時は`QE_CURRENT_AUTHORITY.md`の現行pinが固定する仕様書・工程表・施工指示書の三点セットの全文を読み直す。適用`AGENTS.md`も読み直す。旧版・完了記録は依存・変更系譜・矛盾の解消に必要な箇所だけ参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
