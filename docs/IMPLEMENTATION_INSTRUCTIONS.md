# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直すが、読むのは現行pinが指す一組だけとする。旧版・完了作業と実装は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、通常は一覧化・再読せず、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。本指示は現在のactive BUILD_BATCHだけを扱う。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。合成served経路から結果不明・再起動後照合までのlocal subpathを接続したが、実providerやowner実操作を含む全体は`BUILD_GAP`。F10.01 owner WebChat入口とF10.02 Telegram durable admission・entry identity・返信分割・UTF-8 text attachment consumerはそれぞれ局所経路を部分的に`WIRED`とする。Telegram inboundはowner設定の数値`user_id`・`chat_id`・`message_thread_id`の完全一致grantをadapterで照合し、grantなしを既定拒否、未許可添付をfile API呼出し前に拒否する。QEB-56でadmitted Telegram requestをGateway boundaryからHDS wait consumerまでfixture接続し、同一owner・chatの別topicは待機jobを再開せず、登録元topicだけが再開する経路を部分的に`WIRED`とした。Telegram grantはHDS判断・操作許可・Approval Gate・L3 final reviewの代替ではなく、Developer限定の`plan:`操作をTelegramへ開放しない。F16.01のTelegram JPEG／PNG画像とF16.02の音声文字起こしは、QEB-59で合成Telegram admissionから実served Gateway、request-bound media、C consumer、HDS出力監査、Telegram返信までを接続した。QEB-60でUTF-8 text attachmentも合成served Gateway→HDS→C→HDS output audit→Telegram返信へ接続した。いずれもfixture上の経路で、実Telegram API／credential／実providerを証明しない。音声はGatewayが実media contextとrequest identityを照合した時だけM引用取得を抑止し、文字起こしは承認・権限にならない。添付本文は未信頼の依頼contentとしてCへ送られ、通常の会話保持領域にも現れ得る。F10.02全体はcredentialed-live／二入口運用などが残るため`BUILD_GAP`。C08.03実provider試験は保留。接続範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)に記録し、閉じたBUILD_BATCHの詳細をactive指示に複製しない。

F10.03は、cross-channel plan review／read-only result gate／interrupted wait resumeをWebChat owner tokenと厳密なorigin owner/channel digestへ束縛し、disconnectとtask cancellationを分離する経路を部分的に`WIRED`とする。QEB-58で合成Telegram admission→共有HDS plan/wait→served WebChat owner control→保存結果consumerを一つのGateway process内で接続し、同じjobの保存済み結果をWebChatへ返す経路を確認した。保存結果の再読取でC providerを再呼出ししない。credentialed-live操作は未実施のためF10.03全体=`BUILD_GAP`を維持する。

## 次のBUILD_BATCH

QEB-58で合成Telegram admission→共有HDS plan/wait→served WebChat owner control→保存結果consumerを接続し、QEB-59で画像／音声のserved C経路を追加した。QEB-60で既存のUTF-8 text attachment取得結果をserved Gateway→HDS→C→HDS output audit→Telegram返信へ接続した。実Telegram API／credential／実provider／外部作用は使用せず、添付本文は通常依頼contentとして会話保持領域に現れ得る。次のBLUE内BUILD_BATCHは`F10.02-TELEGRAM-TEXT-ATTACHMENT-WAIT-RESUME-CONSUMER`とし、合成添付入力をtopic-bound HDS waitの同一job consumerへ接続する。実credential、C08.03 provider、外部作用は使用しない。F10.03全体はcredentialed-live未確認、F10.02はcredentialed-live／二入口運用の残差により`BUILD_GAP`。現行工程表の`F16.03`はD4-Pocket側native producer変更を要するため`BLOCKED_AUTHORITY`とし、別repoへ書き込まない。Telegram exact grantはadmissionだけで、HDS authorityやDeveloper限定`plan:`操作へ昇格させない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。QE_BUILDを維持し、製品全体の結合形状成立前に詳細QC／QAを開始しない。次の独立作業・切替・再開時は`QE_CURRENT_AUTHORITY.md`の現行pinと現行三点セットを再同期する。旧版・完了記録は必要な依存・変更系譜・矛盾の解消時だけ参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
