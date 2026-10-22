# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直すが、読むのは現行pinが指す一組だけとする。旧版・完了作業と実装は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、通常は一覧化・再読せず、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。本指示は現在のactive BUILD_BATCHだけを扱う。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。合成served経路から結果不明・再起動後照合までのlocal subpathを接続したが、実providerやowner実操作を含む全体は`BUILD_GAP`。F10.01 owner WebChat入口とF10.02 Telegram durable admission・entry identity・返信分割・UTF-8 text attachment consumerはそれぞれ局所経路を部分的に`WIRED`とする。Telegram inboundはowner設定の数値`user_id`・`chat_id`・`message_thread_id`の完全一致grantをadapterで照合し、grantなしを既定拒否、未許可添付をfile API呼出し前に拒否する。QEB-56でadmitted Telegram requestをGateway boundaryからHDS wait consumerまでfixture接続し、同一owner・chatの別topicは待機jobを再開せず、登録元topicだけが再開する経路を部分的に`WIRED`とした。Telegram grantはHDS判断・操作許可・Approval Gate・L3 final reviewの代替ではなく、Developer限定の`plan:`操作をTelegramへ開放しない。F16.01のTelegram JPEG／PNG画像とF16.02の音声文字起こしは、QEB-59で合成Telegram admissionから実served Gateway、request-bound media、C consumer、HDS出力監査、Telegram返信までを接続した。QEB-60でUTF-8 text attachmentのserved C consumerを接続し、QEB-61では同じ合成添付updateを重複配送したときも特定topic-bound waitだけを再開し、添付取得・返信各1回、HDS候補と同一jobのWebChat保存結果返却までをserved Gatewayで接続した。いずれもfixture上の経路で、実Telegram API／credential／実providerを証明しない。音声はGatewayが実media contextとrequest identityを照合した時だけM引用取得を抑止し、文字起こしは承認・権限にならない。添付本文は未信頼の依頼contentとしてCへ送られ、通常の会話保持領域にも現れ得る。F10.02全体はcredentialed-live等が残るため`BUILD_GAP`。C08.03実provider試験は保留。接続範囲は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)に記録し、閉じたBUILD_BATCHの詳細をactive指示に複製しない。

F10.03は、cross-channel plan review／read-only result gate／interrupted wait resumeをWebChat owner tokenと厳密なorigin owner/channel digestへ束縛し、disconnectとtask cancellationを分離する経路を部分的に`WIRED`とする。QEB-58で合成Telegram admission→共有HDS plan/wait→served WebChat owner control→保存結果consumerを一つのGateway process内で接続した。QEB-62では、WebChat socket切断後も同じjobのread-only検索がverified／M receiptまで進み、同じowner identityで再接続した後、保存済み結果を返せることをserved Gatewayで確認した。socket切断はtask cancellationを呼ばず、保存結果の再読取でC providerを再呼出ししない。合成fixture以外のcredentialed-live操作は未実施のためF10.03全体=`BUILD_GAP`を維持する。

F11.01は部分的に`WIRED`。Bolt Socket Modeの認証済み接続から得た外側Events API payloadのworkspace／event IDを必須化し、owner設定のteam・channel・user・thread完全一致grant、event ID＋payload digestのGateway private SQLite Inboxを通った入力だけをGateway inboundへ渡す。重複・同一event IDのpayload競合は拒否し、再起動時にdispatchingだったeventは`outcome_unknown`として再実行しない。HDS actorはteam／user／channel／threadのdigestへ束縛し、display nameはidentityに使わない。grantとchannel metadataは権限・承認ではなく、Slack previewのまま。owner設定形式は[`SLACK_INBOUND_ADMISSION.md`](SLACK_INBOUND_ADMISSION.md)。synthetic transportで境界を確認したが、実Socket Mode／credentialed Slack／実HDS runtimeは未実施。Inboxの長期event数・容量上限・回転は、全体実装後のQE_QCで運転量を基に定める。

F11.02は部分的に`WIRED`。Slack inbound handlerがGateway consumerで失敗した場合は例外を握りつぶさず、durable Inboxを`outcome_unknown`に保って自動再実行しない。admitted messageの返信は元messageの`ts`を`thread_ts`としてSlackへ返す。Gateway private SQLite outboxは送信pending中だけ返信本文・対象・threadを保持し、terminal settlementで本文を消去する。明示的に未配送と確認できた429だけを`Retry-After`までdurable waitし、再起動後に同じthread replyを再開する。Retry-Afterが不正／安全な日時範囲外の場合と、配送結果が曖昧なtimeout／通信例外は再送せず終端化する。synthetic transport／served Gateway fixture範囲で、実Slack credential／API／Socket Mode／実HDS runtimeは未実施。Slackは`first-party-preview`を維持する。

F11.03の設定consumerを部分的に`WIRED`。Control Center ConnectionsはSlack plugin有無、Bot／App tokenの有無、inbound grantのdeny-all／invalid／configuredを値や対象IDを漏らさず表示し、状態別の次行動を案内する。これはprocess設定の投影だけで、接続・受信・返信・障害回復・切断のlive受入を行わず、preview状態・権限・承認を変えない。専用Slack試験workspaceの資格・recipient・scope・budget等のOD-03条件がないため、実credential/API受入と昇格判定は未実施で、Slackは`first-party-preview`、F11.03全体は`BUILD_GAP`を維持する。

F12.01 Discord inbound identity/admissionは、authenticated Gateway eventのguild/channel/user/message identity、owner設定の完全一致grant、Gateway durable Inboxを通す局所consumerまで部分的に`WIRED`。stable actorにmutable display nameを使わず、Inboxにはidentity／payload digestとdelivery stateのみを保持する。Discord実credential／Gateway接続／HDS運転は未実施のため、Discordは`first-party-preview`、F12.01全体の実環境受入は未成立。受入結果の詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)に記録する。

F12.02はsynthetic fixture上で部分的に`WIRED`。admitted Discord inputからGateway inbound boundary、`replyPayload`、OutboundDispatcher、Discord channel、Gateway private SQLite outboxまでを接続し、元message IDをnative reply referenceとしてconsumerへ渡す。outbox本文はpending中だけ保存してterminal settlementで消去する。確認済みrate-limit拒否と有効Retry-Afterのみをdurable wait後に再試行し、dispatch中断・timeout・通信例外等の結果不明は自動再送しない。discord.jsのchannel-route rate-limit rejectionをoutboxへ返し、REST SDK内の自動再送を無効化した。これはsynthetic transport／Gateway boundaryの接続証拠で、実Discord API／credential／HDS運転を証明しない。Discordは`first-party-preview`、F12.02全体とF12.03のlive受入は未成立。

F13.01 Teams入口認証・同一性consumerは部分的に`WIRED`。Microsoft 365 Agents SDKのJWT endpointはapplication audience／issuer／serviceUrlを検証し、loopback bindのみを許可する。tenant／conversation／conversation type／platform user／channel scopeを抽出し、ownerの完全一致grantとGateway private SQLiteのdigest-only replay inboxを通ったtext messageだけをGateway inboundへ渡す。display nameやraw event本文をidentity／inboxへ保存しない。ローカルの未認証HTTP拒否、synthetic activity mapping、grant・重複抑止・Gateway boundaryを確認したが、有効JWTのtenant受信、実Teams tenant／credential／HDS運転／API作用は未確認。Teamsは`first-party-preview`を維持し、F13.01のcredentialed live受入は未成立。

F13.02 Teams inbound→reply/outbox consumerはsynthetic served subpathを部分的に`WIRED`。admitted requestのTeams reply targetを既存の`replyPayload`／OutboundDispatcherへ渡し、Gateway private SQLite outboxからTeams channel／Microsoft Graph senderへ接続した。pending中のみtarget／本文を保持し、terminal settlementで消去する。明示的なGraph 429拒否と有効な`Retry-After`だけを永続待機して再試行する。timeout、通信例外、5xx、dispatch中断など結果不明は自動再送せず、再起動時にpayloadを消して`outcome_unknown`にする。合成served経路でchannel reply route、durable retry、重複admission抑止、終端後のraw payload消去を確認した。実Teams credential／Graph API／有効JWT／HDS runtime／外部送信は未実施でTeamsは`first-party-preview`を維持する。

F14.01 LINE入口認証・同一性は、raw-body署名検証、destination／source／userの完全一致grant、Gateway digest-only replay inboxから既存InboundRouterまでをsynthetic local経路で接続した。focused testsで署名拒否、identity拒否、重複・競合抑止、再起動時のoutcome_unknownを確認する。実LINE callback／credential／API／HDS運転は未実施で、LINEはfirst-party-previewを維持する。詳細はLINE_INBOUND_ADMISSION.mdとIMPLEMENTATION_HISTORY.md。

## 次のBUILD_BATCH

DiscordのF12.01 admissionとF12.02 inbound→Gateway→reply/outbox subpathはsynthetic fixture上で部分的に`WIRED`だが、実credential／API／HDS運転は未確認で`first-party-preview`を維持する。F12.03 live受入・昇格判定は製品全体の実装成立と別途OD-03条件まで延期する。F13.01 Teams入口認証・identity/admissionとF13.02 reply/outbox consumerはそれぞれsynthetic subpathを部分的に`WIRED`とするが、有効JWT・実tenant・Graph API・実HDS運転は未確認でTeamsの`first-party-preview`を維持する。F13.03のlive受入はcredential・専用target等のOD-03条件が整うまで実施しない。F14.01はsynthetic local subpathのみ部分`WIRED`。次の実装BUILD_BATCHは`F14.02 LINE inbound→reply/outbox`とする。F11.03 Slack live受入もOD-03条件が明示された場合だけ別途実施する。F16.03はD4-Pocket側native producer変更を要するため`BLOCKED_AUTHORITY`のまま別repoへ書き込まない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。QE_BUILDを継続し、製品全体の結合形状成立前に詳細QC／QAを開始しない。新しい独立作業の開始・切替・再開時は`QE_CURRENT_AUTHORITY.md`がpinする現行三点セット全文と適用`AGENTS.md`、active指示、最新HEAD・dirty差分を再同期する。旧版・完了ログは今回の依存・変更系譜・矛盾を解く必要がある場合だけ参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
