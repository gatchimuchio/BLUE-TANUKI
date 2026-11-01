# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev3.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.0ではHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。明示された検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 現在のBUILD_BATCH — F05.01 GitHub repository/base commit identity read

`github.read resource=base owner=<owner> repo=<repo> [base_ref=<branch>]`を既存の公開読取経路へ接続する。Repository APIから数値repository ID・canonical `full_name`・owner・default branchを読み、指定branchまたはdefault branchのcommit SHAを取得する。取得結果が要求したrepository／branchと一致しない、JSONでない、切詰められた、途中でrepository ID／名前が変化した場合はidentityを返さず失敗する。branch名はGit ref規則とpath境界を検査し、各path segmentをencodeする。

結果は版付き`blue-tanuki.github.base-identity.v1`の読取観測とSHA-256 digestにし、provider由来の非信頼情報・non-authority・非原子的観測・mutationなしを明記する。これは後続consumerが同じrepo/base commitを参照するための観測であり、`github.write`の承認・実行権限やbase-bound writeはこのBUILD_BATCHの対象外（F05.02以降）とする。

完了境界：Protocol／HDS-BRAIN／core／Gatewayのworkspace typecheckと変更package build、`pnpm docs:check`、`git diff --check`。test suite、Gateway process、browser、GitHub API／credential、外部書込みは実施しない。成功したBUILD_BATCHは`main`へ直接commit／pushし、remote／local SHA・clean状態と二世代復旧refを照合する。F05.01全体、GitHub write、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOへ昇格しない。

## 完了済みBUILD_BATCH — F02.02 Gmail添付identityからcontent-bound draft.create

Ownerが選択した単一の`gmail.read view=attachment_identity`結果だけをsourceとする。message／attachment／part identity・filename・MIME・size・SHA-256を厳密に再照合し、添付bytesは5 MiB以下でprocess memory内だけに保持する。bytesをLLM、plan、command、履歴、audit、Control Center projectionへ渡さず、content reviewは本文・宛先と添付filename／MIME／size／SHA-256をno-store表示する。Owner選択・結果・期限をHDSの同一plan／task／revisionへ結び、添付1件を完全一致で束ねた未実行`gmail.write draft.create`候補だけを許す。`message.send`、`draft.send`、別添付、添付内容由来の目的・宛先・権限推定は拒否する。

添付sourceはreview取得時と作用直前に再取得し、metadata・size・SHA-256の変化、欠損、重複、上限超過、期限切れ、plan／command不一致はfail-closedにする。添付付き`message.send`／`draft.send`、plan選択なしの添付候補を拒否する。既存high／L3 final review・Approval Gate・HDS authority・Brokerを維持し、今回のbatchでは実provider／credential／Gmail読取／draft作成／送信／Gateway process／browserを実行しない。内容bytesの保存、raw内容の表示、二つ目のauthority pathを追加しない。

完了境界：Protocol／HDS-BRAIN／core／WebChat／Gatewayのworkspace typecheckと変更package build、生成Control Center script構文、`pnpm docs:check`、`git diff --check`。test suite／Gateway process／provider／credential／外部作用は実施しない。成功したBUILD_BATCHは`main`へ直接commit／pushし、remote／local SHA・clean状態と二世代復旧refを照合する。F02.02全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOへ昇格しない。

## 前回完了済みBUILD_BATCH — F04.02 Drive所有ファイルの可逆ゴミ箱移動

既存`google.drive.write`に`file.trash`を接続し、Owner taskが明示した単一`file_id`について、認証中アカウント所有・個人My Drive・`text/plain`・未trashであることを確認してから、`PATCH trashed=true`でゴミ箱へ移す。これは復元可能な移動であり、`files.delete`による完全削除は実装しない。Drive共有ドライブ、Workspace native document、folder、binary、他ユーザー所有、曖昧・不完全な対象はfail-closedとする。実provider、credential、Gateway process、外部Drive作用は使わない。

metadata（file ID／name／MIME／parent／version／drive ID／`ownedByMe`／trash状態）と取得可能なpermission scopeを複数回読取り、読取間差異、欠損、不完全pagination、上限超過、所有者不一致、My Drive以外、対象版・scope変化はPATCH前に停止する。target-versionへfile state、scope、payload、command、Operation Plan bindingを結ぶ。Operation Planはhigh/L3、Approval Gate／HDS authorityを要求し、no-store Control Center確認は対象file、所有者、My Drive、現在の全取得permission scope、「復元可能なtrash移動／完全削除なし」を明示する。承認直前とPATCH直前に同一snapshotを再照合し、PATCH responseと同じfile IDのreadbackで`trashed=true`、所有者、MIME、name、parentを確認する。結果不明・readback失敗時は自動再送しない。Drive側の他writerとの原子的排他は保証しない。

完了境界：Protocol／HDS／core／Gateway／WebChatのworkspace typecheckと変更package build、`pnpm docs:check`、生成Control Center script構文、`git diff --check`。test suite、Gateway process、provider／credential／外部作用は実施しない。成功したBUILD_BATCHはmainへ直接commit／pushし、remoteとlocalのSHA・clean状態を閉じる。F04.02全体・F04全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ昇格しない。

## 完了済みBUILD_BATCH — F04.02 Drive個別ユーザー権限付与

既存`google.drive.write`へ`permissions.create`を接続し、Owner taskが明示した単一のtext/plain file ID、単一ユーザーemail、`reader`または`writer`だけを許可した。新規の直接付与だけを扱い、既に有効な直接権限がある対象、権限更新／削除、group／domain／anyone共有、Workspace native document、folder、binary、所有権移転は対象外とし、Drive通知メールは送らない。対象metadataとpermission scopeを再取得し、no-store L3確認、承認前／POST直前の対象版再照合、返却permission ID／type／email／role確認、permissions.getとpost-write scope readbackを接続した。結果不明・readback失敗では自動再送しない。Google APIの並行permission変更を原子的には排除できない旨をUIに示す。実provider／credential／外部共有は未実施。検証とcommit状態は直近の [`開発進捗.md`](開発進捗.md) に記録する。

## 完了済みBUILD_BATCH — F04.02 Drive既存text/plain本文のL3束縛更新

`google.drive.write/file.update`を既存のHDS Operation Plan／Executor Brokerへ接続する。Owner taskに明示された単一の`file_id`と置換後本文だけを対象とし、既存blob fileの`text/plain`に限定する。Google Workspace native document、folder、binary、metadata rename、sharing／permission change、delete、createは対象外。このbatchでは実provider、credential、Gateway process、Drive外部作用を使わない。

変更前のmetadata、現本文、対象fileに対する取得可能なpermission scopeを上限付きで読み、読み取り間の差異、欠損、不完全pagination、上限超過、file ID不一致、trash状態、`mimeType`不一致、byte上限超過はfail-closedにする。target-versionへfile identity／state digest、変更前content digest、permission-scope digest、置換payload digest、command digest、Operation Plan bindingを結合する。既存内容と置換内容はno-storeのL3確認に表示し、本文を監査・M・history・通常結果へ保存しない。

承認直前とPATCH直前に同じsnapshotを再取得してtarget-versionと一致することを要求する。Drive側が原子的な条件付き更新を受理する根拠が確認できないため、read-before-PATCH間の外部同時変更を防げるとは主張しない。その競合窓をL3確認へ明示し、未確認・変化時はPATCHしない。PATCH後は同一file ID、既存name／parent／MIME、置換本文を再読取する。結果不明・readback失敗では自動retryしない。

完了境界：Protocol／HDS／core／Gateway／WebChatのworkspace typecheckと該当package build、`pnpm docs:check`、生成Control Center script構文、`git diff --check`。test suite、Gateway process、provider／credential／外部作用は実施しない。結果は`WIRED`（runtime未確認）または`BUILD_GAP`に記録し、F04.02全体・F04全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ昇格しない。成功したBUILD_BATCHはmainへ直接commit／pushし、remoteとlocalのSHA・clean状態を閉じる。

## 完了済みBUILD_BATCH — F04.02 Drive新規作成のplan束縛・owner L3確認

既存`google.drive.write`から`file.create`一件をHDS Operation Plan／Executor Brokerへ接続する。対象はowner taskに明示された単一の親folder・ファイル名・`text/plain`本文だけ。`file.update`、権限変更／共有、削除はこのbatchで候補化・実行しない。実provider・資格情報・外部作用を使わない。

plan-bound target observationは親folder metadata、親から継承されるものを含むpermission inventory、同名fileの不存在を取得し、上限超過・欠損・取得間の変化をfail-closedにする。effectsは登録descriptorどおりexternal_send+write+credential_access、permissionはhigh/L3_final_review・final_review_required・approval_gate_required・hds_brain_authority_requiredを要求する。parent_id・name・本文はOwner taskに明示された値だけを使い、不足時は候補化しない。no-store L3画面は作成本文と全permission主体・role・継承／期限／公開範囲を表示し、command digest・request digest・Operation Plan binding・target versionへ結ぶ。承認時に同じreviewとtarget versionを再取得し、create request直前にもfolder／scope／同名不存在を再取得して承認済みsnapshotと完全一致しなければ停止する。Drive APIにはnameの一意制約もpermission scopeを固定する条件付き作成もないため、直前snapshotとPOSTの間の外部同時作成・権限変更は排他できない。既存の書込後metadata・本文readbackを維持する。

完了時は、全workspace typecheck、変更package build、`pnpm docs:check`、`git diff --check`を局所確認する。test suite、provider／credential、Gateway process、Drive実作用は実施しない。成功したbatchはmainへ直接commit・pushし、local／remote HEADとclean stateを閉じる。F04.02全体、共有変更・削除、F04全体の成立、QC／QA、owner GOを主張しない。C08.03、OD-03、P13の保留を維持する。
## 前回BUILD_BATCH — F04.01 Driveの単一file metadata・revision・sharing読取

2026-11-02、既存`google.drive.read`の検索経路にexact `file_id`取得を加え、選択したDrive file/folderのID、名称、MIME、作成・更新時刻、親folder、Shared Drive ID、version、取得可能なhead revision ID、共有状態、trash状態、取得可能なpermission範囲を同じreaderから返す。Drive APIの`files.get`へ静的field maskと`supportsAllDrives=true`を使い、file IDは単一path segmentとして検証・encodeし、応答IDも要求IDと一致確認する。検索ではpermission一覧を既定で取得せず、exact file readは取得可能なsharing scopeも既定で含める。Daily Briefはsharing permissionを要求しない。

permission主体のemail・表示名・permission IDは取得・出力しない。permission inventoryは`available`／`not_returned`／`shared_drive_partial`／`shared_drive_not_returned`／`not_requested`と`complete`で区別する。権限情報や`shared`値が返らない状態を「共有なし」と解釈しない。revisionはDriveの`version`と取得可能な`headRevisionId`だけを観測し、履歴一覧・revision本文は読まない。version／head ID欠落は「revisionなし」の証拠にしない。

返却は`content_read=false`、`mutation_sent=false`、provider data untrusted、authority用途不可を明示する。資料本文・指示文は未取得であり、その非信頼本文consumer、形式・byte上限・保持条件は未接続のためF04.01全体は`BUILD_GAP`。今回のmetadata subconsumerだけを`WIRED`（runtime未確認）とする。Google Driveの実provider／credential／データ読取、F04.02 write/share/delete、F04.03 liveは未実施・対象外。

参照した一次資料: [Drive files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)、[Drive files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)、[Drive permissions resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions)。

`corepack pnpm --filter @blue-tanuki/core run typecheck`と同package `build`、`corepack pnpm docs:check`、`git diff --check`はPASS。日本語基底の既存移行負債76件は注意として維持する。test suite、Gateway process、provider、資格、外部読取はNOT_RUN。QE_QC／QE_QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOは未成立。C08.03、OD-03、P13の保留を維持する。

## 前回BUILD_BATCH — F03.02 Calendar更新・削除のplan接続と読取照合

2026-11-02、既存`google.calendar.write`の`event.update`／`event.delete`をHDS Operation Planの通常bind経路へ接続した。primary calendar・本人主催・confirmed snapshot・参加者一覧完全・他参加者0人・event ID／recurrence scope完全一致を必須とし、updateは件名のみ、deleteは対象eventだけを許可する。L3／Approval Gate／HDS authorityとoperation別effectを維持し、同一eventの未解決作用中と同一payloadの重複bindを拒否する。

結果不明時は既存の期限・単回・対象束縛付きpermitからread-only GETを一度だけ行う。updateは正確な対象の現在件名、deleteは同対象の`cancelled`状態だけを「現在状態一致」と記録する。404・不一致・曖昧は結果不明のままとし、自動再送しない。Control Centerは観測と作用結果を区別して表示し、update／deleteから別作成taskへ誤誘導しない。実Calendar読取・書込・実資格・外部作用は行っていない。

Protocol／HDS-BRAIN／core／WebChat／Gateway project build、生成Control Center script構文解析、`pnpm docs:check`はPASS。test suite、Gateway process／browser、実provider／実資格／Calendar作用はNOT_RUN。STATUS=`WIRED`（HDS planから既存adapter／L3経路と読取照合のコード接続、runtime未確認）。F03.02／F03全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。C08.03実provider、OD-03 live外部作用、P13 owner GOは保留する。

## 前回BUILD_BATCH — F03.02既存参加者を保持する招待追加consumer

2026-11-02、既存参加者がいるGoogle Calendar予定へ宛先を追加するconsumerを接続した。現行APIはPATCHで指定した配列を置換し、`attendeesOmitted`は参加者応答だけの更新用途であるため、完全なattendee一覧を読んで保持項目と新規宛先を結合してPATCHする。既存者のemail、RSVP、任意参加、resource、comment、display name、additional guestsを読み取り、未知・不完全・重複・200人超・要求宛先重複・byte上限超過は作用前に拒否する。request前に確認したevent ETagを`If-Match`へ結ぶ。

承認画面はno-storeで既存参加者、新規追加先、通知対象全員を分けて表示する。`sendUpdates=all`は既存参加者も含む全guestへの更新通知を依頼するため、その全宛先をL3 review digestへ束縛した。`event.invite`をGatewayの内容確認・承認必須経路へ追加し、承認時の再読取でも同じreview digestを照合する。providerから読んだ既存参加者の生住所は一時スナップショットとno-store reviewに限り、HDS／M／監査へは渡さない。Ownerが依頼した新規宛先は既存契約どおりtask parametersに残り、これをreview digestと作用要求へ束縛する。系列全体・occurrence・単一予定のscopeは従前どおり分離する。

結果不明後の一回読取は、event存在だけで`event.invite`を一致扱いせず、要求された宛先が全員attendee一覧にいることとrecurrence scope一致を確認する。これは予定上の参加者登録を示すread-only観測であり、通知メールの配信・到達やwrite成功を証明しない。HDS stepは`outcome_unknown`を保ち再送しない。同一eventの未解決招待は別宛先でも遮断し、確定済み同一宛先の重複は順序・大文字小文字を正規化して拒否する。

確認した現行API仕様: [Events: patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)、[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[Calendar notifications](https://developers.google.com/workspace/calendar/api/concepts/reminders)。

HDS／core／WebChat／Gateway typecheck、HDS／core／WebChat／Gateway build、生成Control Center script構文解析、`pnpm docs:check`、`git diff --check`はPASS（日本語基底の移行負債76件は既存注意）。test suite、Gateway process／browser、実provider／実資格、Calendar変更はNOT_RUN。STATUS=`WIRED`（承認・既存参加者保持・再読取のコード接続、runtime未確認）。F03.02／F03全体、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。C08.03実provider、OD-03 live外部作用、P13 owner GOは保留する。

## 前回BUILD_BATCH履歴 — F03.02 Calendar結果不明の照合・再送抑止

2026-11-02、Calendar書込み後に結果が不明となった場合、HDSの一回限り・短期限・対象束縛の照合許可から、対象eventのread-only GET一回を行うconsumerを接続した。`event.create`は要求内容から決定するprovider event IDを使い、同一要求の再登録を防ぐ。Operation Plan経由では、同じ時間枠の結果が未解決の間は内容を変えた再作成も止め、確定済みの場合も同一要求の重複を拒否する。`event.invite`は同じevent・宛先への再送を拒否する。

照合はeventの現在状態とprovider HTTP statusだけをdigest中心で記録し、HDS stepは`outcome_unknown`のまま保つ。Google Calendarの404は不存在と閲覧不能を区別できないため、成功・失敗の判定や再実行許可にしない。eventが見つかっても、招待メールの配信・到達は未確認のまま表示する。別owner taskボタンは新しい入力文を準備するだけで、自動送信・Calendar作用を行わない。次batchで参加者一覧照合を加えたが、この履歴範囲の証拠はevent状態読取までに限る。

## 前回BUILD_BATCH履歴 — F03.02 Calendar参加者追加・招待通知

2026-11-01、Calendar作成にOwner taskが明示した最大20件の参加者を任意で束ね、宛先表示と招待メール作用を同じL3内容確認に結んだ。既存予定への追加は独立した`event.invite`とし、primary calendar・本人主催・完全snapshot・event ID・recurrence scopeを要求する。PATCHによるattendees置換で既存者を落とさないよう、参加者が0人の場合だけ許可する制限を維持する。詳細は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) に記録する。

## repo基点

ownerがrev3.0を指定した時点のmainは`2964db41dc11ddc3057f47447a85f8a49395c377`。前回のCalendar参加者・通知BUILD_BATCHはlocal／remote `main`=`bc8b2ecb6801c93dd06d41eebd81019685ad5373`から開始した。今回のCalendar update/delete実装commit `eaeee0e9861ea535d7198f8e4b762c9607fff729`は`main`へpush済み。push後のGitHub照合は`main=eaeee0e...`、復旧tag current=`c6b2eee...`／previous=`21732e1...`で、local復旧branchも同じ二世代を保持する。後続作業は記録やpackage作成時SHAを現行HEADとみなさず、開始時にlocal／remoteの実値を再照合する。CR-0～CR-3は既存履歴の完了記録を引き継ぎ、現HEADとの差分だけを扱う。

## F02.02 Gmail先行BUILD履歴 — 内容・宛先の承認固定

2026-11-01、F02.01のOwner選択message identityから同一taskのdraft.create候補までの接続を受け、Gmail候補の宛先・本文を既存L3 content review／Approval Gate／Brokerへ結ぶ。

Toは必須、Cc／Bcc／Reply-Toは任意。各欄は表示名なしの最大20件のメールアドレス列に制限し、Protocolの共有正規化でHDS候補検査、Gmail MIME serializer、target identity digest、Gatewayのno-store content reviewを一致させる。serializerはReply-Toを実MIMEへ出し、Approval画面は有効な宛先・件名・本文とrequest payload digestを示す。Owner taskに明記のない値をメール本文・headerから補わない。owner選択identity digestを含む候補はdraft.create一件のみで、message.send／draft.send／複数stepは拒否する。

添付は現行候補経路で未対応。HDS Operation PlanとGateway content projectionは添付フィールドを拒否し、Approval画面は「添付なし」と表示する。既存`gmail.read`は添付metadataのみを返し、現行三点セット・F02.02契約に添付本文の対応形式、明示byte上限、保持期間の規定はない。`gmail.read.max_bytes`はAPI応答上限であり、添付本文の上限として流用しない。このため本文取得を追加せず、`gmail.write` adapterも未知・添付引数を送信前に拒否する。既存draft.send MIME parserもmultipart／添付をfail-closedで拒否する。添付内容のowner選択・読取・表示・送信は未接続であり、F02.02全体は`BUILD_GAP`のまま。

candidate生成・provider読取／書込・実資格・実送信は行わない。C08.03実provider、OD-03 live外部作用、P13 owner GOを保留する。

宛先・本文の接続を含む従前の確認結果は、Protocol build、HDS／core／WebChat／Gatewayのtypecheck・build、生成Control Center script構文解析、`pnpm docs:check`、`git diff --check`がPASS。今回の安全guard施工では`@blue-tanuki/core typecheck`、`pnpm docs:check`、`git diff --check`がPASSし、`packages/blue-tanuki/src/tools/google_write.ts`がoperation別許可引数だけを受け付け、未知・添付引数をcredential取得・request前に拒否する。今回のtest、Gateway process、browser、実provider／実資格、外部作用はNOT_RUN。宛先・本文は`WIRED`（runtime未確認）、添付の選択・読取・内容digest・Owner確認は未接続のためF02.02全体は`BUILD_GAP`。

F02.02の当時の未接続事項: 添付producer／consumerは、対応形式・内容scope・保持期間・byte上限が現行契約で定まるまで`BUILD_GAP`として保持する。Owner選択済み`gmail.read` attachment identityの本文取得、no-store L3 review、同一承認command／Broker作用は未接続のままにする。

### F03.01先行consumer履歴 — Calendar読取・時刻・空き状況

2026-11-01、既存のgoogle.calendar.readを拡張し、既定のview=eventsではcalendar ID／event ID、organizer／attendee identity、start/endのdate・dateTime・timezoneを、正規化値と原表現の両方で返す。イベント本文・説明・参加者コメントは取得しない。200人超またはAPI側省略、欠落identity、次ページ、response byte上限をresult_complete=false／attendees_omittedへ反映する。

view=freebusyは同じHDS tool経路からGoogle Calendarのread-only freeBusy queryを呼び、単一calendar・31日以内のRFC3339時間窓を要求する。応答受領時のobserved_atとobservation_digestを保持し、API範囲不一致、calendar error、部分応答、忙しさ区間上限超過はavailability=unknownとしてbusyを使えない形にする。provider内容は非権威・未信頼として明示し、C／Jの権限やL3承認を置換しない。実資格のprovider呼出し・外部業務作用は行わない。

packages/blue-tanuki/src/tools/google_read.ts、packages/blue-tanuki/src/tools/builtin.ts、packages/blue-tanuki/src/tools/index.ts、packages/hds-brain/src/action_router.tsを変更。core／hds-brain typecheckはPASS。test、Gateway runtime、実provider、browser、外部作用はNOT_RUN。STATUS=WIRED（既存Calendar toolから限定read adapter分岐へのコード接続、runtime未確認）。F03.01のruntime確認、F03.02の登録前再照合、F03親全体、E2E-01、製品全体SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、owner GOは未成立。

F03.02接続の先行状態記録。過去のBUILD_BATCHで`event.create`のread-before-write経路を接続済み。更新・削除のscope境界は上記の最新BUILD_BATCHで追加した。F03.02全体とF03全体は未成立。

## CR-0割込み履歴 — I-06 Windows開発インストーラー


`install/windows/install.ps1 -Force`は、既存の非reparseディレクトリ内にある開発用所有markerが、今回のinstall rootとdata rootの両方へ一致する場合だけ置換する。marker欠落時も、既定のinstall/data rootの完全一致、BLUE workspace manifest、既存runtime／installer入口、秘密を読まないenv-file存在確認、両rootへ結び付く生成済みPowerShell／CMD launcherの一致をすべて満たす従来導入だけを認識する。途中のdirectory／fileがreparse、識別不正、対象不一致なら削除前に拒否し、custom rootへlegacy認識を広げない。既存`DataRoot`は削除しない。これは静的な実装状態であり、Windows上の拒否動作・既存導入からの更新を含む非破壊実行確認は`NOT_RUN`。その経路の動的安全性を検証済みと扱わない。全体の利用者経路を先に成立させるowner指示により、K-B5 shadow比較は一時保留し、次のBUILD_BATCHでWebChat taskの実consumer接続を進める。

## 先行工程ログ — E2E-01／K-B5（F03.02現行BUILD_BATCHより前）

K-B0／K-B1で現行入口と一仕事のproducer／consumer、J/Mの通常・復旧writerをコードで再照合した。公開可能な責任対応は[`OPERATION_CORE_ARCHITECTURE.md`](OPERATION_CORE_ARCHITECTURE.md)に置く。これは`BASELINE_OBSERVED`／`RESPONSIBILITY_MAPPED`の静的確認範囲であり、全OSの実行証拠や全体実装の完成ではない。

I-01のroot直下の二重slashによる広域対象ガードの抜けを修正し、I-03のメイン`/app`にも費用profile・予算policy・timeoutの保存／Verifyを接続した。provider疎通と通常Computeの設定準備を別に表示し、設定変更後の古い準備判定を破棄する。現在の予算消費は仕事ごとの実行時照合が必要であり、設定のreadyは実行許可ではない。I-04の共通試験fixtureには現行Compute／予算／worker lifecycleの依存を渡し、候補生成前の拒否を本番guardの緩和で隠さない。

K-B2では、Jが明示選択・再照合した有限なoperation-result observationをdigestでC候補へ拘束し、owner L3、M解釈更新、次taskの再評価までを限定接続した。`plan:reflect`は採用候補入力から除外する。meaning-update専用J/M storeを含む7-store復旧境界、restore前quiescence、HDS plan hold、restore後の再観測とreconcileも接続済みで、旧5-store snapshotからのrestoreは拒否する。

K-B3のmeaning-update／引用再評価経路では、C候補評価を`meaning_update_candidate.ts`、承認候補からMレコード／解釈投影を作る処理を`meaning_update_semantics.ts`、解釈content digestとJSON正規化・検査を`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在J判断と過去監査・M履歴の整合を評価してowner再評価候補を作る処理を`memory_judgment_reassessment_candidate.ts`へ分離した。controllerは監査検証とM／audit snapshot取得を担当し、候補の意味評価は供給された値だけで行う。L3、監査の書込、J/M writerは現行TypeScript HDS-BRAINに保持する。これらの純粋意味モジュールはGateway／SQLiteをruntime importせず、新processや第二authorityを作らない。

コード上、Gatewayのno-store content reviewからL3承認、同一proposal／candidate／target／source-observation digestの再照合、M適用、最終監査markerまでの既存接続を維持した。HDS 3 files／5 tests、HDS typecheck/build、HDS standalone smoke、Gateway typecheck/buildはPASS。`pnpm docs:check`はこの記録更新後に実行する。Gateway meaning-update process smokeは前バッチで起動後15秒以内にhealthへ到達せず、統合実行の証拠は未成立のまま。今回の経路抽出は既存責任境界の整理であり、新しい利用者仕事や製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。K-B3全体の抽出完了は未確定、QE_QC／QE_QAは未開始。

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続まで成立した。2026-10-31のowner指示「製品全体の成立を品質検証より先に進める」を受け、K-B5の限定J projection比較を一時保留し、WebChat taskの計画受付から結果通知までの実consumer接続を先に進めた。owner task受付状態から同一request IDのplan、同一task identityの計画表示範囲、依頼一致planのM receipt状態までをTasks consumerへread-only表示する差分を追加した。E2E-01全体は未成立のまま、K-B5の残る比較consumer接続は一時保留を維持し、通常Owner経路の次consumerを先に接続する。広域QC／QAは始めない。

**最新接続（2026-11-01）:** verified `file.search`結果に対し、Control Centerからownerがsandbox相対path・置換前後を明示して同一taskの未実行`file.edit`候補を要求できる。保存済み検索本文を自動でCへ添付せず、選択observationはdigest／件数のみとする。synthetic Cは親taskのexact `file.read`またはpath-bound `file.search` path、現行plan／revision／task identity、期限内のverified search observationとpath一致を確認する。HDSの目的binding、J step審査、実差分のowner確認、L3 Approval／Broker、M receiptは既存経路を維持する。core／WebChat／HDS no-emit typecheckと生成Control Center script構文解析はPASS。build、test、Gateway process、browser、実providerはNOT_RUN。状態はコード接続済み・runtime未確認。次consumerは既存file.editの差分確認からApproval／Broker実行・receipt・結果返信まで。

### E2E-01 BUILD接続履歴（2026-10-31〜2026-11-01）— WebChat task一気通貫（durable result outbox後crashの隔離・現行planへのread-only相関・owner媒介の現状態観測を合成Gatewayで確認済み。owner task受付の耐久重複抑止・read-only状態照会・Runtime plan digest相関・同一request IDの非権威な実行証拠表示をコード接続済み。詳細command resultが欠ける場合のgeneric executor feedback fallbackもUI consumerへ接続。保存済みfile.search結果はowner-bound plan:resultで再読でき、verified file.edit/file.write/file.deleteは内容を返さない限定結果要約を同じ経路へ接続した。owner task照会IDは不透明IDのみ複数件をsession横断保持・選択可能で、status照会からRuntime相関まで選択IDの変化時に古い応答を捨てる。WebSocket予期切断後は最大5回再接続し、接続成功時にその切断系列の失敗回数を戻すよう修正（Gateway process／browserでの確認は未実施）。ownerが選択したdigest-only file-state観測から同一taskのread-only `file.search`を審査・L3承認・M receipt・WebChat返信まで合成Gateway processで確認済み。owner指定相対pathのread-only `file.search`も合成Gateway processで実行し、同語を含むdecoyを除外してverified/M receiptとOwner結果返却を確認済み。E2E-01全体は未成立）

- **目的:** `/owner/task-compute`で受理した仕事の応答後、計画状態をControl CenterのTasks／Runtimeへ反映し、plan操作をその所有経路からHDSへ届ける。K-B5 observer比較より先に、通常利用者経路の状態consumerを閉じる。この接続単位の完了は、目的→C→J→Approval／Broker作用→receipt→M→結果返信→再計画／復帰から成るE2E-01全体の成立を意味しない。
- **producer／consumer:** WebChat `/owner/task-compute` → Gateway `InboundHandler` → WebSocket結果frame → Control Center chat表示と、認証済みruntime-tokenが入力済みの場合の`/runtime/snapshot`再読込。Control Centerは安定したUUID `submission_id` をsession storageに保持し、通信結果が不明な再送で同じIDを使う。Gatewayのprivate SQLite inboxはIDとpayloadをそれぞれdigest化し、request ID・delivery stateのみ保持する。同じID／同じpayloadは保存済みrequest IDを返してhandlerを再呼出しせず、同じIDの別payloadは409、再起動時にdispatch中だった依頼は`outcome_unknown`として再実行しない。handler失敗は固定`error` status frameへ接続する。`/owner/task-submission-status`から得た同一request IDを、認証済み`/runtime/snapshot`の`operation_core_execution.latest_results`にある内部実行記録と照合し、条件適合時だけ要約をTasksへ表示する。owner tokenで作成したplanのstep審査・保存結果読取・結果不明receipt照合は、同一plan/revisionを含むowner専用`/owner/inbound`を使う。`plan:result`はverifiedな`file.search`の確認済み保存結果とverifiedな`file.edit`の限定成功要約に加え、verifiedな`file.write`／`file.delete`の非権威要約を、同じplan/revision/stepへowner認証してHDSへ渡す。file.editは相対path・置換数・byte数、file.writeは相対path・書込byte数、file.deleteは相対path・削除時点の報告だけを返す。write本文・file内容・差分・sandbox絶対rootは返さず、保存結果の返却で作用を再実行しない。旧epoch結果は`/recovery/inspection`のdigest-only証拠とverified `command_key_digest`の一意一致、およびBroker correlation matchedを満たすplan bindingに関連付け、ownerが現在sandbox状態を独立に観測・選択した後にだけ同一taskの新しい候補へ進める。owner tokenのDeveloper operator経路はwait／resumeに限定し続ける。起動・停止中などhandler未接続なら202ではなく503を返す。
- **入力・出力:** 失敗通知にtask本文、例外本文、目的本文、credential、HDS判断やcommit hashを含めない。応答にはrequest IDを使い、結果不明時はTasks／Runtimeで状態を確認してから新規依頼するよう案内する。実行記録はhash chain、schema、request ID一致、非権威flagを確認する。nested command resultが一致すればoperation・下流state/action outcome・短縮result digestを表示する。nested resultが欠落または不適合でも、個別entryの非権威flag、内部状態のみの証拠源、generic executor status、result_presentとdigestの整合を確認できた場合は、executor feedbackとして明示して状態・短縮digestだけを表示する。これはstep未結合の内部実行観測で、raw結果本文、例外、HDSの最終回答、仕事全体の完了、owner画面への到達を意味しない。このframeは非権威の運転状態であり、HDSの判断・承認・実行権限として扱わない。
- **到達条件:** 通常handlerが起動した場合は従来どおり202受付、同一submissionの再送は同一request IDで再受付し、handlerを重複起動しない。handler拒否は接続中の返信先へ固定error statusをbest-effort表示し、未接続handlerは503で拒否する。handler起動前の失敗と起動後の結果不明を区別し、前者は安全に新規受付可能、後者は再実行せず状態確認へ誘導する。`channel_send`／`error` frameを受けた際、runtime tokenが入力済みなら最新のruntime snapshotを再取得する。実行要約は`operation_core.execution.v1`の厳格なprojection・非権威flag・有効なhash chain・同一request IDをすべて確認し、nested resultとgeneric executor fallbackを区別する。欠落・不整合・履歴表示制限は未確認と表示する。owner plan操作は認証済みowner inboundとplan/revisionに結び、HDSが現行所有・revision・依存・対象を再照合する。旧世代receiptの関連付けはcommand-key digestとBroker recordが一致し、verified bindingが一件で、表示上限による省略がない場合に限る。既存保存結果の読取と要約表示は再実行を起こさず、旧receiptからJ/M更新・承認復元を起こさない。入力本文と例外詳細をstatus frame・ログへ漏らさず、WebChat package／workspaceのtypecheck・buildが成立する。
- **境界:** 既に切断されたWebSocketへの永続再配送、他channel共通のjob queue、Approval queueの自動更新、HDS判断やOutputAuditを通すassistant回答への変換は対象外。一般chatのraw回答本文は耐久保存・再配信しない。保存内容の再読はHDS承認済みreceiptを持つverified `file.search`に限る。runtime token未入力時は自動更新しない。通知が届かない場合でもfailureを成功扱いせず、再送前の状態確認を案内する。HDSがowner-bound plan/revision/stepを再検証して選択した単一commandに限り、既存process policyのtool区分を適用する。一般chat、C候補、Gateway／metadataによる権限昇格は認めず、L3／Approval／Broker判定を維持する。

**最新BUILD差分（2026-11-01）:** 合成Cがowner指定語句によるsandbox内のread-only `file.search`を計画する既存入力に加え、owner指定の相対ファイルパス＋語句を同じ検索へ渡す入力形を追加した。絶対・親遡り・secret-like・非portableなpathは候補化前に拒否し、`file_path`を既存のtarget observationとHDS `file_search_result_matches`契約へ結合する。verified result、M receipt、owner-bound `plan:result` consumerは既存経路を使う。全workspace typecheck/build/docs:checkはPASS。専用Gateway process test BT-U-E2E-01 path-bound file.searchは1件PASS（同fileの他6件はskip、21.6秒）。同じ語句を持つdecoyを置いて指定相対pathだけが返ること、verified plan／M receipt、保存結果のOwner返却、両file不変を確認した。Gateway typecheck／buildもPASS。対象入力形はWIRED。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QC／QAは未成立。

#### 2026-10-31 E2E-01 BUILD接続 — owner task受付の耐久重複抑止

Control Centerは`sessionStorage`へUUIDv4を保持し、POSTの応答が失われた場合に同じ`submission_id`でのみ再送する。Gatewayは`BLUE_TANUKI_STATE_ROOT/private-state/webchat-owner-task-inbox/owner-task-inbox.sqlite`にsubmission ID digest、payload digest、server request ID、delivery stateだけを保存し、task本文・返信先を永続化しない。同一ID／同一内容の再送は同じrequest IDを返してHDS handlerを再呼出しせず、payload差替えは409 conflict、Gateway再起動で`dispatching`だった記録は`outcome_unknown`へ遷移して再実行を拒む。handler開始前の失敗は再送可能な固定statusに分け、開始後の例外は結果不明として保持する。HDS authority、Approval／L3、Broker、M writer、既存WebSocket deliveryの意味は変更しない。

このbatchでWebChat typecheck/build、Gateway build、`git diff --check`はPASS。Gateway typecheckはWebChat依存をbuildする前に公開型欠落で一度FAILし、WebChat build後にPASSした。test、Gateway processでの重複・restart挙動、全workspace suite、実provider／外部作用、QE_QC／QE_QA、5OS実機はNOT_RUN。静的型・build成立は耐久台帳の実動作やE2E-01全体を証明しない。

#### 2026-10-31 E2E-01 — durable result outbox後のGateway process crash

Windowsの隔離Gateway process試験で、対象planだけのJ checkpoint更新をfixture triggerで停止し、Broker成功結果・execution receipt・result outboxがdurable commitした後、J/M receipt採用・outbox acknowledgement前にGatewayを強制終了した。停止時点でreceiptは`adapter_returned`、receipt／outbox digestは一致し、対象bindingにはdelivery digest・result digest・M commitがなく、合成file.writeの作用は一件、provider callは0件だった。再起動後、execution epochが変わったためstartup reconciliationは旧epoch resultをJ/Mへ直接採用せず、receiptを`stale_generation_evidence`として記録し、outboxを証拠として保持する。同一planは`outcome_unknown`、action-result M未記録のままで、元writeは再実行されない。ownerによる現在sandbox状態のdigest-only非権威観測、その明示選択後の同一task read-only `file.search`、M receipt、明示結果返信までを同じprocess testで確認した。

この経路はrev3.0 E03.02の「旧receiptで新世代の採否や正本を直接更新しない」を実Gateway startupで維持する証拠である。旧epoch outboxのcommand-key digestを、Recovery Inspection上で唯一のverified plan bindingへ結び、Control Centerにplan／step digestと現在J状態を表示するconsumerを接続した。crash process testではownerが既存`plan:reconcile`で現在sandboxをdigest-only観測し、状態を独立に選択した後に同一taskのread-only `file.search`候補・M receipt・明示結果返信まで継続した。旧receiptの直接採用・過去承認の復活・元write再実行は禁止を維持する。E2E-01全体は未成立であり、次のBUILD_BATCHは現行rev3.0正本と実consumerから残る未接続経路を選ぶ。

#### 2026-10-31 E2E-01 Windows合成Gateway実processの接続済み範囲

開発専用backendを通常の4役割agent-delegation経路へ接続した。子候補は固定・非権威の合成markerのみで、親候補は4役割・contract digest・固定task／目的contextが一致した場合だけ生成する。Windowsの実Gateway processで、通常`/owner/task-compute`→Jのfile.write候補→owner tokenによる目的関係L3審査→同一plan/revisionのowner step審査→HDS選択済みcommandのtool process policy→既存Approval Gate／Broker→file.write receiptとM→WebSocket結果返信まで成立した。検証済みreceiptから同一taskのread-only file.search候補を生成し、ownerによる目的関係L3確認・step審査を経て既存read-only Broker workerを実行、検索結果を完全一致検証・M receipt確認後、保存結果を再検索せずWebChatへ返すところまで確認した。file.search候補に必須のpreparation／validationが欠けてHDSが`plan_step_not_ready`で拒否した欠陥を合成backendで修正した。候補は親plan digestに対応する初回の合成file.write pathだけを使い、HDS／ownerの再照合・承認境界は変えていない。試験は隔離stateと一時file rootのみを使い、実provider呼出しは0件、保存結果返却後も作成ファイルが一件のままで、test cleanupが除去した。Gateway実process testはPASS（1 selected、他3件pattern skip）。`pnpm --filter @blue-tanuki/core build`、workspace `pnpm typecheck`／`pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。日本語基底移行負債76件は既存注意として残る。この証拠は限定synthetic taskの`WIRED`接続であり、独立した意味推論、restart recovery、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

**次のproducer／consumer:** file.write実行中の中断・process restart後に、既存writeを重複実行せず、同一taskのcommand intent・execution receipt・M receipt・現在のplan dependencyを再照合する復旧経路を接続する。provider/live外部作用は使わない。

#### 2026-10-31 E2E-01 合成Gateway再起動後のread-only再計画継続

対象の隔離Gateway process testは、Vitestが`apps/gateway`をcwdにする実行経路でrepo root相対のentrypointを二重連結していた。test helperのrepo rootを`import.meta.url`基準で決定するよう直し、同じprocess testを再実行した。固定synthetic taskで目的関係L3確認、owner step審査、既存Approval／Brokerを経てcreate-only `file.write`とM receiptを確認した後、Gateway childを停止・再起動した。新しいWebChat接続のruntime snapshotへ同一plan／revision／task identityとverified `receipt_confirmed` stepが復帰し、そのreceiptから同一taskのread-only `file.search`、M receipt、保存結果返信まで継続した。再起動後・結果返信後もcreate-only fileは一件で、test中のprovider callは0件。`document_organization_entry.test.ts`は1 selected PASS、他3件はpattern skip。test-owned temp rootはcleanup済み。

この確認は完了済みfile.write receiptからのprocess再起動連続性を示す。file.write実行中の中断、Broker作用後かつexecution result／M receipt確定前のcrash window、そこからのcommand intent／outbox／plan dependency再照合は未確認であり、E2E-01全体の復旧成立とは扱わない。

**次のproducer／consumer:** 実行中断時に現在の権限を復元せず、同じtaskのcommand intent・execution receipt／outbox・M receipt・現在のplan dependencyを安全に再照合する。結果不明なら再実行せずholdする。provider/live外部作用は使わない。

#### 2026-10-31 E2E-01 — file.write後のBroker結果receipt保存失敗とGateway再起動

Windowsの隔離Gateway process試験に、実`file.write`の後で`execution_intents`のBroker結果receipt更新だけをSQLite triggerで失敗させる分岐を接続した。Gatewayは合成ファイル本文・trigger理由を返さず、固定のreceipt永続化失敗をWebChatへ返す。J planは`outcome_unknown`を保持し、M receipt未記録のstepから同一taskのfile.search候補を作らない。試験用Gatewayを強制終了・再起動しても、同一plan／revision／task identity・未知step・M未記録状態が復帰し、file.write対象は一つだけ増え、その後重複しない。低層の`execution_result_reconciliation.test.ts`ではpending result outboxが空であること、fresh epoch後も同じcommand keyの再発行を拒否することを確認した。実`file.write`後の永続化失敗を作る合成試験であり、Gatewayをadapter復帰とreceipt開始の厳密な命令間で直接killした証拠ではない。異常後の明示的なowner receipt照合・解決も次工程に残す。

再起動後の同task file.search候補が作成されなかった根因は、開発専用`SyntheticFileWritePlanBackend`がpath対応をprocess内Mapだけへ保持していたことだった。create-only pathを親plan digestから決定的に導出し、Cが再起動後も同じsandbox対象を再生成できるよう接続した。`document_organization_entry.test.ts`の目的L3・Approval／Broker・write・再起動・read-only再計画・receipt失敗・再起動復帰を含む選択実process試験は1 selected PASS（他3件はpattern skip）。`execution_result_reconciliation.test.ts`のreceipt失敗・store reopen試験は1 selected PASS（他47件はpattern skip）。core build、Gateway typecheck、`git diff --check`もPASS。合成ファイル作用以外の外部作用・実provider呼出しは0件。この限定証拠はE2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

2026-10-31再同期時の再検証では、低層store reopen試験は1 selected PASS（他47件はpattern skip）、Gateway実process試験は初回に45秒health timeoutでFAIL（初回helperはstderrのみ出力しstdoutは未確認）、同じ対象の再実行で1 selected PASS（他3件はpattern skip）だった。初回timeoutの原因は未確定であり、再現時に起動出力を確認できるようhealth timeout時の診断へstdout捕捉を加えた。`pnpm --filter @blue-tanuki/core build`、`pnpm --filter @blue-tanuki/gateway typecheck`、`pnpm docs:check`はPASS（日本語基底移行負債76件は既存注意）。この再検証も限定合成環境の証拠である。

#### 2026-10-31 E2E-01追加接続 — create-only file.writeの未知結果状態観測

既存の`plan:reconcile`へ、HDSが所有者・現行revision・step・`outcome_unknown` bindingを再検査して発行する30秒・単回permitを使い、`file.write mode=create`に限るsandbox内読取専用状態観測を追加した。Gatewayは対象の不存在／通常file／非regularを区別し、上限1 MiBで通常fileのSHA-256とroot・parent・file identity digestだけを作り、内容本文・絶対pathをJ、M、WebChatへ返さない。Gmailのloopback receipt照合は従来経路を保持した。新sourceは`local_file_state`とし、command keyは期待値のbindingとして保持するが、file stateをcommand receiptと偽装しない。Jの観測記録・M memory projection・reflection citationはsource別にした。

この状態観測は非権威証拠で、plan bindingを`verified`へ変えず、stepを成功・目標達成とせず、再作用・依存step・後続searchを許可しない。作成fileのhash一致でも誰が書いたかの証明にはしない。実装は`packages/blue-tanuki/src/tools/builtin.ts`、`packages/protocol/src/operation_plan_state.ts`、`packages/hds-brain/src/operation_plan.ts`、`apps/gateway/src/local_inspection_runtime.ts`等。Core file-state観測とGatewayのsource分岐は隔離temp rootで試験したが、新sourceの実HDS persistent store／M receipt再起動復元、通常WebChat process経由の実接続は未実施（NOT_RUN）。所有者の明示結果解決と、それに続くcommand intent／execution receipt／M receipt／plan dependencyの一体再照合が次工程である。

Windowsでprotocol／core／HDS-BRAIN／Gateway build PASS、依存channel build PASS、workspace `node node_modules/typescript/bin/tsc -b` PASS。限定試験は4 file・71 PASS・6 skip。初回`pnpm typecheck`は作業中に修正済みのreflection型エラーを検出し、後段cleanがOneDrive上のGateway `dist`削除でOS `UNKNOWN`拒否となった。そのため再度の削除系cleanを避け、修正後は直接`tsc -b`とpackage buildで確認した。実provider・外部service write・owner GOは未実施。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAを成立扱いしない。

#### 2026-10-31 E2E-01追加接続 — WebChat応答の依頼相関

ExecutorがHDS commandのupstream_decision.request_idを送信metadataへ引き継ぎ、WebChatのchannel_send／owner-task failure frameとControl Centerのchat itemへ接続した。受理表示と返信をrequest IDで相関し、結果返信には同じ依頼IDの末尾を表示する。これは表示・追跡専用で権限を持たず、計画判断・Approval・Broker作用・M更新を変更しない。pnpm typecheck、pnpm build、Control Center script syntax parse、pnpm docs:check、git diff --checkはPASS。test、Gateway実process smoke、実provider、実作用は未実施（NOT_RUN）。この接続だけではE2E-01全体・製品全体SYSTEM_SHAPED／BUILD_COVEREDを成立させない。次は同じtask identity／目的bindingを保つ安全な合成Approval／Broker作用、receipt、M、結果返信、再計画／復帰のproducer→consumer経路である。

#### 2026-10-31 E2E-01追加接続 — 開発限定の合成C計画候補

Gatewayに`BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND=true`かつ非production限定の`synthetic-file-write-plan`を追加した。`LLM_BACKEND=synthetic-file-write-plan`で選択し、`BLUE_TANUKI_FILE_ROOT`を設定する。正確な固定task `BLUE-TANUKI synthetic create-only file-write demonstration`に対してだけ、一意なsandbox内相対pathへ`mode=create`の単一`file.write`計画候補を返し、上書き・削除・外部通信はできない。候補は非権威として既存のHDS候補検査へ入り、目的関係は`unknown`のため所有者の独立確認を省略しない。通常stubとprovider既定値は変更せず、権限・承認・Broker・M writerも追加していない。workspace `pnpm typecheck`／`pnpm build`／`pnpm docs:check`／`git diff --check`はPASS。test、Gateway process、実provider、合成候補からの実作用は未実施（NOT_RUN）。これは候補生成のコード接続であり、E2E-01全体・`SYSTEM_SHAPED`／`BUILD_COVERED`の成立ではない。次は隔離file rootで通常WebChat task入口からpurpose確認、owner Approval／Broker、結果receipt、M、返信、同一task再計画／復帰のproducer→consumer接続を閉じる。

#### 2026-10-31 E2E-01追加接続 — M receiptから同一taskの再計画候補

WebChat Control Centerに、現在の目的版に結び付き、検証済みstepとM receiptを持つfile operation resultから同一taskの候補再計画を依頼するowner-token限定操作を追加した。HDSは親planのowner／channel／現行revision・recovery hold・wait状態・goal-purpose bindingを照合し、指定されたresult observationのM record／receiptとtask identityを再検査する。候補保持時にも同じ条件を再照合し、元のtask goalと`task_identity_digest`を新候補へ継承する。Cへ渡すのはHDSが読み出した元taskと、digest・固定区分だけの非権威result observationである。provider露出では`selected_operation_plan_context`と`selected_operation_result_observations`を独立分類し、alternate providerには各sourceの明示許可が必要となる。新planは未実行であり、既存step review／L3／Approval／Broker経路を迂回しない。`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。test、Gateway実process smoke、実provider、実作用は未実施（NOT_RUN）。この差分は`WIRED`のコード接続であり、E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。次は全体実装の未接続consumerを引き続き埋め、実運転の検証をQE_QCとして先行させない。

#### 2026-10-31 E2E-01追加接続 — 合成Cの通常task入力と一回限りの検証再計画

`plan:compute`はHDS内で制御接頭辞と入力JSONを解析し、Cへはtask本文だけを渡す。合成backendが解析前の制御接頭辞を要求していたため、通常WebChat task入口と入力契約が不一致で候補を返せなかった。開発限定backendを実際のHDS候補専用prompt・目的binding・固定task本文に結び付け、初回のcreate-only `file.write`候補を返す形へ修正した。さらに、同じ元task・task identityに結び付いた検証済み`file.write`結果のM receipt一件だけを入力条件として、一回限りのsandbox内read-only `file.search`候補を返す。親plan／source observationの内容とtask identityを照合し、それ以外のtask、引用依存、他operation、複数観測、追加再計画は拒否する。両候補とも目的関係は`unknown`で、J・owner関係確認・既存Approval／Brokerを省略しない。`pnpm typecheck`／`pnpm build`／`pnpm docs:check`／`git diff --check`はPASS。test、Gateway process、WebChat一気通貫、provider、file.write／file.search実行は未実施（NOT_RUN）。コード接続は`WIRED`だが、E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01追加接続 — owner選択済み状態観測から同一taskの検索結果返信

`plan:reconcile`で既にMへ保存済みの同一command／evidence digestを、ownerが同じ現状態を選んで再計画する際に再登録しようとすると、重複拒否の`null`を認可失敗として扱っていた。単回permit消費、最新Gateway receipt再照合、新しいsandbox状態読取を維持したうえで、同一plan／revision／step／commandに結び付く一致済みdigest-only観測が一件だけ存在し、時刻とdigestを再検証できる場合に限り、既存の耐久観測を再利用するようHDS-BRAINへ接続した。再利用は新しい観測や作用を追加せず、監査上も新規記録と区別する。

Windows隔離Gateway processで、結果不明のcreate-only `file.write`を再実行せず、現状態観測→owner選択→同一task read-only `file.search`候補→目的関係L3確認→owner step審査→既存Approval／Broker worker→execution receipt／M receipt→保存結果のWebChat返信まで対象testを3回PASS（各1 selected、他4件pattern skip）。その前の同一test 1回は初期synthetic file.search review返信待ち15秒でtimeoutしており、3回の成功で変動の原因を解消したとは扱わない。合成Gateway／一時file rootを使い、実provider・外部作用は未使用。workspace `pnpm build`、HDS-BRAIN no-emit `typecheck`、`pnpm docs:check`、`git diff --check`はPASS。workspace `pnpm typecheck`は古いHDS `dist/output_audit.js`のOneDrive `EBUSY`でFAILし、そのscriptによるclean後に個別buildを行った。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD — 受付後の状態照会ID選択

owner task受付後、次回用submission IDを発行した時に状態照会欄まで未送信IDを選択していた。送信IDをPOST前に保持し、受付成功後は新IDを次回送信用に維持しながら、照会欄だけ受付済みIDを選ぶようWebChatへ接続した。依頼本文・token・結果の保存、再送、HDS判断・権限変更はない。

WebChat typecheck／buildはPASS。git diff --checkはPASS。テストsuiteとブラウザー実操作は未実施。E2E-01全体、製品全体SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、owner GOは未成立。
### K-B5保留記録 — 同一合成系列のJ採否・L3記憶遷移・plan採否比較

- **目的:** 現行TypeScript HDS-BRAINのpolicy採否とM writerをauthorityとして維持したまま、Rust Runtime Kernelが同じscore／weight／thresholdから独立算出するJ projection、停止後の人間復帰、L3承認済みM更新の有限な残差状態、およびJが選択したplan stepの目的／criterion採否要約を比較する。
- **producer／consumer:** `HDSUpperController.decide()`／`resume()`と、Gatewayの意味候補採用・引用判断再評価のL3結果（成功commit、明示的なstale再照合、commit blocked）がprojectionを作る。成功した新規M commitでは実`MemoryUpdateReceiptV1`の`previous_revision`／`revision`を保持し、Rust shadow processが1段の版遷移を独立比較する。同一commitの再送など当該操作の新receiptがない場合は版を捏造せず`not_comparable`にする。meaning adoptionでは現行M参照レビューから件数・検証数・scope／target状態を縮約し、Rustが状態と集計値の整合を再計算する。通常inbound、resume、L3 memory approvalの既存observerから同じRust processへ順に渡し、比較receiptをGatewayの非権威ログへ返す。未確定のM再評価数・明示された未評価状態・再評価済み／残存数だけを集計し、IDや個々の参照は渡さない。HDSの`OperationPlanLedger.bind()`は選択時assessmentを保存し、`canExecute()`と`executionSourceBindingDigest()`で再計算・再照合する。通常inbound observerはexact `command` identityでselected bindingを特定し、保存assessment digestをHDS内だけで検証後、同じRust shadow系列へ状態区分とrelation件数だけを渡す。
- **入力・出力:** 軸名、score、weight、lifecycle状態、policy閾値、TypeScript採否を送る。resume時は元のpolicy SUSPENDと`owner_verdict`、`resume_allowed`、復帰後decision、command有無だけを追加する。L3記憶遷移では承認／適用状態、適用commitの前後M revision、許可状態ではない固定区分、および上限512の集計数だけを追加する。meaning adoptionのcurrent-M要約にはsupporting／counterevidence各参照数と検証数、scope／target一致、counterevidence claim、candidate digest可用状態を含め、Rustは件数上限・検証数・scope digest・固定review statusの組合せを独立再計算する。receiptと運転ログへ出すのは`memory_reference_review_matches`の真偽値だけで、件数も個々の参照も出さない。Rustは適用済みの前後revisionが1段進んだかを独立再計算し、差分は`mismatched`とする。検証済みのpurpose-bound plan computeに限り、保存時の`SHA-256(goal_ref)`・purpose version・purpose digestに加え、HDS-BRAINの読取専用`GoalGovernanceLedger` projectionから別途取得した現在目的版のdigest-only値を送る。Rustは保存値と現在値を照合し、`available`／`ledger_unavailable`／`goal_not_found`／`not_bound`状態と目的版一致をreceiptへ返す。plan採否比較ではpurpose／criterionの状態値と上限64のrelation件数を再分類してreceiptへ返す。文章、step／command／criterion ID、目的・criterion個別digest、assessment digest、個々の参照は送らない。旧checkpointのassessment欠落は`not_comparable`、plan未選択は`not_applicable`とし、既存実行許可へ影響させない。raw入力、goal_ref、目的本文、detector evidence、owner identity、source/target/judgment ID、command本文、credential、request identity、M本文は送らない。Rust receiptの操作上の`decision`は常に`hold`で、比較結果は参考値のみ。
- **対象単位:** 同一合成系列でASSERT／FAIL／SUSPEND／OUT_OF_SCOPE、SUSPENDからapprove／reject／blockへの遷移、owner L3記憶採用時の参照レビュー状態・supporting／counterevidence件数整合・未評価／未再評価残差、指定J判断の再評価済み／残存数、および保存済みplan adoption recordの目的review状態・criterion outcome／evidence状態・objective／safety別relation件数を比較する。meaning relation自体の意味評価は`not_assessed`を保つ。軸／閾値を安全に表現できない場合、policy外controller override、または固定小数点化の判断境界付近は`not_comparable`として送らず、既存Gateway判断へ影響させない。
- **継続条件:** Rust shadowは作用権限・M正本writerを持たない。Rust起動・IPC失敗・queue上限・比較不一致はTypeScript authorityへ反映しない。比較不一致は観測し、原因を次の施工へ渡す。
- **この単位で未接続:** J/Mの全体意味比較、Rust shadowのsingle-writer cutover。通常のGateway `serve` inboundからplan採否receiptまでの限定process smokeは別fixtureでPASS済み。2026-10-31、observer process fixtureを拡張し、ASSERT／FAIL／SUSPEND／OUT_OF_SCOPE、approve resume、L3 M遷移、選択plan採否を同じRust sessionへ順に送り、sequence 18のplan receiptまで確認した。これは合成projectionを同一observerへ通す証拠であり、Gateway `serve`全経路、実M適用、実providerの証拠ではない。plan分類の実装間status差を生成するprocess確認は未実施。production配布・他repo書込み・P13公開／出荷GOは保留する。
- **必要最小確認:** HDS／Gateway typecheck・build、Rust compile／test、Rust実processを通す合成4分岐とSUSPEND→resume、IPC拒否・無作用停止。全workspace suite・QE_QC／QE_QA・実provider・実外部作用・5OS実機の成功へ転記しない。

今回のBUILD差分では、L3 meaning adoptionのM参照レビューを固定状態と上限512の件数だけでRust shadowへ渡し、検証数・scope digest・target状態・counterevidence claimとの整合を独立再計算した。非権威receipt／Gateway logには真偽値だけを追加し、参照ID・候補文・件数は出力しない。通常Gateway serveの合成L3 process smokeでmeaning adoption 2件の整合`true`とjudgment reassessment 1件の非該当`null`を確認し、矛盾した検証数はRust processで`mismatched`となった。projection schema v12／request v7。HDS controller／shadow IPC 82 tests、Rust 4 tests、Gateway observer 5 tests、Gateway L3 smoke 1 test、HDS／Gateway typecheck・build、Rust check／fmtがPASS。これは参照整合要約のshadow比較に限られ、意味関係の評価は`not_assessed`、Rustは`hold`、作用・M正本書込みなしを維持する。製品全体BUILD、QE_QC／QE_QA、実provider／外部作用、5OS証拠、single-writer cutoverは未成立。

今回のBUILD差分では、成功したmeaning update／judgment reassessment commitから実M receiptの前後revisionを取得し、projection v10へ追加した。Rustは適用時の安全な整数範囲と`after = before + 1`を独立検査し、版飛びを不一致として返す。stale／blocked／rejectなどM未適用の遷移は前後revisionを明示的`null`にする。同一commitの冪等再送で新しいreceiptがない場合は実revisionを補完せず比較不能にする。Gateway observerはrevision・transition・residual・lifecycleのreceipt整合を再検査し、通常serveの合成L3 smokeで2件の意味採用と1件の引用判断再評価における実M receiptの1段遷移を確認した。HDS／Gateway typecheck・build、HDS controller 78 tests、Rust 4 tests、Gateway shadow observer 3 tests、Gateway M smoke 1 testがPASS。Rustは`hold`、no-effect、no-M-writeのまま。K-B5全体意味比較とsingle-writer cutoverは未成立で継続する。

今回のBUILD差分では、ownerがL3 memory transitionを`reject`／`block`した経路も、Rust shadow observerへ接続した。意味更新の拒否・blockは`not_applied`・pending数なしのまま、再評価拒否・blockは再評価数0・残数=requestedのまま投影し、Rust receiptとGateway observerがowner verdict、適用有無、残差状態を個別に照合する。observer logにもverdictと適用状態を記録する。これは既存TypeScript HDS-BRAINの判定をshadow比較する追加入力であり、M書込・権限・実行能力を加えない。projection schemaはv8。この後、既存Gateway observer fixtureへ拒否／blockと承認後未適用の6状態を追加し、同じ実Rust processでverdict・適用状態・残差・lifecycle receiptの一致を確認した。実行した限定fixtureはPASS。合成projectionをRust shadow consumerへ送る確認であり、実owner/L3操作・Gateway serve全経路の証明ではない。

続くBUILD差分では、ownerがapproveした後のmeaning-update／judgment reassessmentも、直前のstale再照合またはcommit APIの明示的`ok:false`でMが適用されなかった場合をshadowへ投影した。`approve`と`memory_application_status=not_applied`を分離し、meaning updateは`adoption_approved_not_applied`、再評価は未再評価数を全件残す。Rust parserとGateway observerが適用状態・残差を再計算して照合する。例外送出は部分commit後の可能性を排除できないため未分類のままにし、未適用として記録しない。projection schemaはv9。HDS／Gateway typecheckとRust `cargo build`／`cargo test --locked`はPASS。HDS shadow IPC process test 3件、Gateway shadow observer process test 3件もPASSし、後者でmeaning-update／judgment reassessment双方のreject／block／approve-not-applied receiptを確認した。`pnpm docs:check`も記録修正後にPASS。Rustは`hold`、no-effect、no-M-writeのままであり、実owner/L3操作、K-B5全体意味比較、single-writer cutoverは未成立。

前段では、L3意味採用・引用判断再評価の成功commitを、本文／識別子／digestを含まないv4 projectionとしてRust実processへ接続した。前回、その有限projectionをv5へ更新し、TypeScript側が採用したpolicy rule IDと対象axisを追加した。Rustは同じ数値入力から算出したrule ID／axisと直接比較し、採否が一致してもrule provenanceが異なる場合は`mismatched`を返す。今回、purpose bindingをIPCの`goal_id`／`goal_version`に照合した結果も独立した`purpose_binding_matches`としてreceiptへ返すようにした。形式が正しい不一致はRust shadowを停止せず`mismatched` receiptとし、形式不正だけを拒否する。目的versionとgoal identity digest双方の不一致を実process試験で確認した。Rustの操作判断は`hold`のままで、作用・M正本更新はない。Gatewayの非権威receipt／logにも比較結果を接続した。

この変更の限定確認は、HDS typecheck／build・shadow IPC実process 3件、Gateway typecheck／build・shadow observer 2件、Rust cargo test 2件、cargo fmt check、`pnpm docs:check`がPASS。全workspace suite、QE_QC／QE_QA、実provider、実外部作用、5OS実機の結果ではない。K-B5はJ/Mの全体意味比較とsingle-writer cutoverが未成立のため継続する。purpose版の照合値はobserverが同一projectionからIPCへ設定するため、この一致は独立したcurrent-governance sourceとの比較ではなくtransport整合性の確認に限る。目的本文・task意味との適合や目的に沿ったJ採否全体は未成立。システム全体の`SYSTEM_SHAPED`／`BUILD_COVERED`、`RUST_SHADOW_CUTOVER`、QE_QC／QE_QAは未成立のまま扱う。

今回、Rust receiptの実consumerであるGateway observerを補強した。memory transition projectionから遷移一致・残差状態・lifecycleの期待値を再計算し、receiptの各結果と個別に照合する。矛盾したreceiptは`invalid_shadow_receipt`としてobserverを停止し、非権威ログへ整合した比較結果として出さない。検証はHDS／Gateway typecheck・build、Rust `cargo check`、`cargo fmt --check`、`git diff --check`がPASS。テストは未実行であり、この差分の実process結果は未確認として扱う。Rustは引き続き`hold`、no-effect、no-M-writeである。

今回、検証済みpurpose-bound plan computeのSHA-256(goal_ref)・purpose version・purpose digestを、Rust shadow専用WeakMapから`DecisionLog`のdigest-only `goal_purpose_binding`へ移した。SUSPENDと人間復帰の監査記録にも同じ束縛を引き継ぐ。C結果から生成されたmeaning-update候補はsource `DecisionLog.commit.hash`と任意のpurpose bindingをL3 content-review／commit audit markerへ渡し、起動時recovery・replayで唯一のASSERT `DecisionLog`との一致を確認する。欠落・重複・不一致はcommitを拒否するか復旧をfail-closedにする。raw `goal_ref`と目的本文は保持・送信しない。M record v1、その意味内容とinterpretation digestは変更せず、purpose bindingを権限や意味適合の証拠にも使わない。HDS／Gateway typecheck・buildはPASS。テスト、Rust変更、Rust実process／Gateway統合実行は未実施。

今回、`HDSUpperController.runtimeKernelJProjection()`は保存時bindingとは別に現行`GoalGovernanceLedger.project()`を読み、hash済みgoal identityで該当goalの現在version／purpose digestを投影する。Rust projection v6は保存値・現在値の形式と同一goalを検証し、鮮度一致を独立に算出する。Gateway observerはreceiptのstatus／一致値を検証して非権威eventへ記録する。台帳未取得は未比較、goal消失・目的版／digest変更は比較残差として扱う。Version snapshotは比較sourceであり、目的本文の意味適合や権限を判定しない。Rustは引き続き`hold`、no-effect、no-M-write。

今回、既存`OperationPlanManager.goalPurposeRelationIssue()`とrequest-bound criterion gateの結果を、HDS Jが採用した個別plan stepの記録へ結んだ。候補のsupports／conflicts／unknown、引用検査状態、監査済みowner review結果、toolごとの全criterion relation（objective／safety、supports／conflicts）、根拠状態とdigestを保存する。criterion conflictは支持点との加算で相殺せず選択を止める。支持は申告に基づく未検証状態として保持し、目的関係は監査済みownerのsupports判定がなければ採用しない。実行直前に同じ記録を再計算し、選択時digestとの不一致はfail-closedにする。目的本文・task・criterion本文は新しいrecordへ含めない。既存checkpointとの互換性のため記録schemaはoptionalとし、記録のない既存bindingにも従来の鮮度・conflict gateを適用する。

前段のplan adoption recordをRust shadowの同一合成系列へ接続した。HDS controllerは選択中commandのstored bindingを読み、保存assessment digestを内部検証してから目的review状態とcriterionの分類・上限64のrelation件数だけをprojection v7へ渡す。個別ID・文章・assessment digest・criterion digestは送らない。Rustは条件・件数の整合を独立分類し、Gateway observerはreceiptと比較statusを再確認してログへ記録する。legacy record欠落は`not_comparable`、plan未選択は`not_applicable`。全体statusは不一致を優先し、一つも不一致がなくても現行目的台帳または選択済みplan記録が比較不能なら`not_comparable`とする。`matched`は適用対象の全比較軸が比較可能で一致した場合だけ返す。Rustの判断は引き続き`hold`、作用なし、M正本書込みなし。

最新のconsumer修正では、Gateway observerがRustのplan adoption分類をTypeScript側の再計算値と一致する場合だけ受理していた欠陥を解消した。receiptの形・入力echo・`status`と`matches`の自己整合は引き続き厳密に検査するが、意味上整合した分類差は停止理由にせず、Rust receiptとTypeScript分類値を並べて非権威ログへ記録し、比較statusを`mismatched`にする。Rust側の総合statusはRust receipt群から独立に再計算して検証する。HDS／Gateway typecheck・build、Rust `cargo check --locked`／`cargo test --locked`（4件）、HDS shadow IPC（3件）、Gateway observer（3件）、Gatewayの合成L3／plan採否process smoke（1件）、`pnpm docs:check`がPASSした。process smokeはlocalhost fake provider・隔離state・一時file rootを使い、file.deleteはその一時root内のtest専用L3承認後に限る。実provider・実外部作用・全workspace suite・QE_QC／QE_QA・5OS実機は対象外。Rustは`hold`、no-effect、no-M-writeを維持し、K-B5全体比較・製品全体BUILD・cutoverは未成立のまま継続する。

このコード経路は`WIRED`。observer試験では実Rust processのmatched／意図的不一致receiptを確認し、HDS／Gateway typecheckとGateway依存buildもPASSした。続いて既存のGateway process smokeへplan receipt確認を追加し、通常WebChat inboundのplan選択で`matched` receipt、no-effect／no-M-write、および本文・request／plan／step ID・pathの非出力を確認した。同じfixtureはlocal fake provider、隔離state、一時file rootだけを使い、planのfile.deleteは別のtest専用L3承認後にその一時root内で実行・観測した。process smokeはPASS。試験で、meaning-update J/M stageの承認readerへ`source_decision_binding`が渡らず`j_approval_not_verified`となる欠陥も検出し、Jがその出所束縛を保存直前に再照合するよう修正した。stage拒否理由コードも呼出側へ保持する。これらは限定的な実process接続証拠であり、K-B5のJ/M全体意味比較、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`の成立を示さないため継続する。

今回のBUILD差分では、TypeScript HDS-BRAINが既にfail-safe `SUSPEND`を確定した自己健全性停止を、Rust shadowの限定J projectionへ接続した。projection v11／request v6は、失敗条件の名前・根拠・入力本文を送らず、失敗件数と実行禁止／非権威の固定値だけを渡す。Rustは単一の停止軸・固定重み・閾値を検証して`SUSPEND`を再判定する。Windows上の実Rust processで一致receipt、条件名・入力本文の非出力、範囲外件数と不正重みの拒否、安全停止を確認した。HDS controller／shadow IPC 82 tests、Gateway shadow observer 4 tests、Rust `cargo test --locked` 4 tests、Rust `cargo fmt --check`、HDS／Gateway typecheckとbuild、`pnpm docs:check`、`git diff --check`はPASS。テストは合成fixtureと実Rust processに限定され、実provider・外部作用・他OSを通した証拠ではない。Rustは引き続き`hold`、no-effect、no-M-write。K-B5の全体J/M意味比較、single-writer cutover、製品全体BUILD、QE_QC／QE_QAは未成立。

今回、通常のGateway decisionでRust shadowが独立算出したJ判定を、TypeScript HDS-BRAINが実際に生成した`ExecuteCommand`の有無へ接続した。通常decisionに限り、Rust判定が`ASSERT`であることとcommand存在が一致しない場合、observerは停止せず`mismatched`および`command_presence_mismatch`を非権威ログへ返す。resumeは既存のresume遷移比較、memory approvalは既存の非command経路を維持する。TypeScript HDS-BRAINの判断・command・実行権限、Rustの`hold`／no-effect／no-M-writeは変更しない。今回の`git diff --check`はPASS。test、typecheck、build、実process、docs検査は未実施（NOT_RUN）。K-B5の全体比較・single-writer cutoverは未成立。

今回、Gateway observerの比較結果でcommand有無の不一致をRust receiptの`lifecycle_matches`へ混在させていた意味上の混同を解消した。実際のlifecycle一致を独立して保持し、`command_presence_matches`を別項目として通常ログへ出す。不一致時の総合statusは`mismatched`のまま、HDS authority・command実行・Rustの`hold`／no-effect／no-M-writeに影響しない。合成入力で意図的なcommand有無不一致を実Rust processに通し、二軸が分離されることを確認した。Gateway typecheckと対象observer試験（5 tests）、`git diff --check`はPASS。全workspace suite、実provider・外部作用、QE_QC／QE_QA、5OS実機は未実施。K-B5全体比較・single-writer cutover・製品全体BUILDは継続。

今回、ownerがapproveした後に非常停止が有効でM適用されなかったmeaning adoption／judgment reassessmentを、同じRust shadow observerへ接続した。owner verdictはapproveを保ち、停止理由をownerのblockへ誤分類しない。Gateway通常serveのlocalhost合成process smoke（1 test）で両停止枝を通し、M未適用・revision不変・再評価対象全件残存、停止解除後の再発行tokenによる両M更新の完了を確認した。Rust shadowの5 memory-transition eventはすべて`matched`。Gateway typecheck／smokeと`pnpm docs:check`はPASS。HDS TypeScriptが権限・唯一M writerであること、非常停止、再承認要求は変更していない。実provider・外部作用は未使用。K-B5全体意味比較・cutover・製品全体BUILD・QE_QC／QE_QAは継続する。

今回のBUILD差分では、通常decisionに限られていたcommand有無の不一致観測をresumeとL3 memory approvalへ広げた。実HDS結果とprojectionのcommand有無が食い違ってもRust shadow比較を破棄せず、`command_presence_matches=false`と総合`mismatched`を非権威ログへ記録する。比較自体が不可能なprojection形式の拒否は維持する。Rustの`hold`／no-effect／no-M-write、TypeScript HDS判断・command・Approval・唯一M writerは変更していない。Gateway typecheck／build、`pnpm docs:check`、`git diff --check`はPASS。日本語基底監査の移行負債76件は既存注意として残る。testとGateway実process smokeは未実施。K-B5の全体J/M比較・single-writer cutover、製品全体BUILD、QE_QC／QE_QAは未成立のまま継続する。

resume shadow receiptの原因分類には固定enumのowner verdictとresume許可状態だけを使い、owner identity、要求・command ID、本文、秘密はGateway非権威ログへ出さない。今回、実Gateway processの通常入力→HDS `SUSPEND`→WebSocketの一回限りtoken→`/resume` owner rejectを合成入力で通し、同じRust processのreceiptが`matched`となることを確認した。resume比較行にrequest ID・token・入力本文は含まれず、provider呼出し数も増えていない。対象Gateway smokeとGateway typecheckはPASS。Rustは引き続き`hold`／no-effect／no-M-write、TypeScript HDS-BRAINは唯一のauthority／M writer。K-B5全体比較とsingle-writer cutoverは未成立。

今回、Telegramの一時画像・音声を含む入力がHDS `SUSPEND`後にowner approveされた場合、添付bytesが揮発しているのに文章だけで再実行され得るGateway resume経路を閉じた。保持するのは対象request IDの非内容印だけで、添付bytesは保存しない。該当resumeはHDS lifecycleへcancelを記録し、`fresh_request_required`と日本語の再送案内を返す。履歴は実行不可・非権威の状態と理由だけを記録する。全workspace `pnpm typecheck`と`pnpm build`はPASS、`git diff --check`はPASS。test・実process smokeは未実施（NOT_RUN）。実provider・外部作用・QE_QC／QE_QAは未実施で、K-B5全体比較・cutover・製品全体BUILDは継続する。

続くobserver consumer差分では、plan step adoptionのRust receiptとTypeScript分類を同じstatusへ潰さず、`plan_step_adoption_classification_agrees`として分類一致を独立表示する。適用済みplanで両分類が同じ拒否を返した場合と、実装間で分類が割れた場合を運転ログから区別できる。比較値は非権威観測のみで、HDS判断・command・Approval・M writer・Rust `hold`／無作用に影響しない。typecheck／build／docs検査を実施し、test・Rust実processは未実施として記録する。

2026-10-31のBUILD差分では、WebChat Control Centerが委任目的を読み込んだ時点の`purpose_version`を選択肢に保持して`/owner/task-compute`へ送り、Gatewayは現行の選択肢と照合するようにした。版が変わっていればInboundRequestを作らず409で拒否し、目的を再読込して選び直す案内を表示する。digest・目的本文は引き続きUIへ公開しない。版を送らない既存呼出しの互換性は維持する。channel-webchat typecheck、生成Control Center scriptの構文解析、`git diff --check`はPASS。test・Gateway実process・実providerはNOT_RUN。この接続は選択時の目的版固定であり、K-B5全体比較、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、single-writer cutoverを成立させない。

続くK-B5 Gateway consumer差分では、M遷移receiptをTypeScript分類と完全一致させないとobserverが停止する結合を解消した。receiptの型・適用軸に応じたnull可否・内部lifecycle整合は検証し、意味上の差は参照レビュー／M revision／遷移／残差ごとの`*_classification_agrees`と総合`mismatched`で非権威ログへ残す。ログは固定分類と真偽値に限り、M本文・参照ID・集計数を含めない。Gateway typecheckと`git diff --check`はPASS。test、Rust実process、Gateway統合smokeは未実施（NOT_RUN）。Rustは`hold`／no-effect／no-M-write、TypeScript HDS-BRAINは唯一のauthority／M writerを維持する。K-B5全体意味比較、製品全体BUILD、QE_QC／QE_QA、single-writer cutoverは未成立。

今回のK-B5 Gateway observer記録では、意味上の差があった時に原因軸を追えるよう、Rust receiptの分類とTypeScript projection側の期待分類を別々に運転ログへ残す。対象はreference-review／M revision／memory transitionの真偽値と、固定区分のresidual statusだけ。本文・参照ID・集計数・秘密は追加しない。Gateway typecheck／buildはPASS。test、Gateway統合process smoke、実provider・外部作用、K-B5全体比較、cutover、製品全体BUILD、QE_QC／QE_QAは未実施または未成立。

最新のK-B5 BUILD差分では、plan-step adoptionのRust receiptについて、`not_comparable`の固定reason差をIPC不正としてobserver停止させず、Rust／TypeScript双方のstatusとreasonを非権威比較として記録する。未知reason、形状不正、projection echo不一致は引き続きreceipt拒否とする。Gateway typecheck／buildはPASS。testおよびRust／Gateway process確認はNOT_RUN。HDS authority、作用、M writer、Rust `hold`／no-effect／no-M-writeは不変で、K-B5全体・製品全体BUILD・QC／QA・cutoverは未成立。

続くobserver consumer差分では、妥当なRust plan-step adoption receiptがTypeScript側と異なる比較statusを返した場合、Rust側の集約status差だけでobserverを停止させていた結合を解いた。固定enum・receipt形状・projection echo検査は維持し、plan採否分類差がある場合だけ`mismatched`として観測し、TypeScript／Rust双方のstatus・reasonと`plan_step_adoption_classification_agrees=false`を非権威Gateway logへ残す。型チェックはPASS。test、Rust／Gateway process、実provider・外部作用、5OS実機はNOT_RUN。HDS authority／command／Approval／M writerとRust `hold`／no-effect／no-M-writeに変更なし。K-B5全体意味比較、製品全体BUILD、QE_QC／QE_QA、single-writer cutoverは未成立。

今回、Gateway observerがTypeScript分類を`observe()`呼出し時に行い、Rust向けJSONを非同期queue内で後から生成していたため、呼出元がprojectionを変更すると別snapshot同士を比較する隙を修正した。受付時にwire JSONを一度生成し、そのJSONをparseした専用snapshotからJ分類・purpose binding・command有無を導出し、同じbytesをRustへ送る。projection serializationに失敗した場合は先行queueを保ったままobserverを停止する。追加した実Rust process試験では、`observe()`直後に呼出元projectionを変更してもreceiptとTypeScript分類が受付時snapshotに一致することを確認した。Gateway observer 6 tests、HDS／Gateway typecheck・build、Rust `cargo test --locked` 4 tests、`pnpm docs:check`、`git diff --check`はPASS。日本語基底監査の移行負債76件は既存注意として残る。全workspace suite、QE_QC／QE_QA、実provider・外部作用、5OS実機、実装間plan status差を意図的に発生させるprocess確認はNOT_RUN。HDS authority／M writer、Rust `hold`／no-effect／no-M-writeは不変。K-B5全体意味比較・single-writer cutover・製品全体BUILDは未成立。

#### 2026-10-31 E2E-01 BUILD接続 — owner選択と候補保持直前のGateway receipt再照合

create-only `file.write`の結果不明状態観測とGateway永続`ExecutionIntentStore`をつなぎ、owner選択時の現行receipt読取りをHDSの一回限りの読取portとして構成した。HDSは現行plan/revision/step、`outcome_unknown` binding、task identity、command digest、epoch、状態観測の耐久M receiptを再検査し、Gatewayは指定command keyだけで`lookupCommand`する。receiptの不在、状態変化、command/task/epoch不一致、store integrity failureは候補観測の受理前にfail-closedとなる。既存J admission内のcommand keyはlookup bindingとしてだけ使い、Gateway receiptのticket・raw値はprojection・C/M・audit logへ出さない。receiptは非権威証拠のままで、元stepの`outcome_unknown`と新候補の未実行状態を維持する。

C応答後の`retainCandidate`も同じHDS source-inspection consumerを通るため、候補の保持直前にGateway永続receiptをもう一度再取得する。最初のowner受付からC応答までにreceiptが変化した場合も候補を保存しない。GatewayからHDSへ渡す依存は型付き読取callback一つで、HDS standalone境界・単一J/M writer・Approval／Broker権限に変更はない。`pnpm typecheck`、全workspace `pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。test、Gateway実processでのowner選択、実provider、外部作用、全体QC／QAはNOT_RUN。次は同一task候補のowner step reviewから既存Broker、結果/M保存、WebChat返却consumerまでの未接続境界をつなぐ。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

2026-10-31のE2E-01続きでは、開発限定`synthetic-file-write-plan`がowner選択済み`owner_selected_local_file_state`を正確なtask文・同一parent plan/revision/task identity・`outcome_unknown`・観測専用flagで受け、同じ対象に対する既存のread-only `file.search`候補だけを返すよう接続した。元`file.write`の再生成・成功推定・権限付与は行わない。全workspace `pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。test suite、Gateway実processでのowner選択、実provider、外部作用、全体QC／QAはNOT_RUN。次はowner step reviewから既存Approval/Broker、結果/M保存、WebChat返却へつなぐ。E2E-01全体と製品全体BUILD、QE_QC／QE_QA、owner GOは未成立。

#### 2026-10-31 E2E-01 BUILD接続 — owner選択済み未知結果から保存済みread-only結果へ

file.writeのBroker結果receipt永続化失敗後、Gateway processを再起動した同一taskについて、ownerが`plan:reconcile`でsandbox内file stateを非権威・digest-only観測としてMへ記録し、その後`owner_selected_observation=local_file_state`を明示選択して同一taskの`file.search`候補を生成・保持する経路を接続した。目的関係のowner L3審査とstep審査後、既存Brokerでread-only searchを実行し、J planとM receiptを確認した。ownerの明示的`plan:result`で保存済み検索結果をWebChatへ返した。元file.writeは終始`outcome_unknown`で、再実行せず、合成sandboxの対象数も増えていない。

接続時に二つの欠陥を修正した。HDSが認証済みGateway内部要求を`structuredClone`して保持すると内部要求markerが失われ、C応答後のreceipt再照合だけが拒否されていたため、保存前検査を通過した要求を内部要求factoryで再構成する。Gateway projectionは、`outcome_unknown` stepにローカルfile-state観測があるとHDSが返す`external_receipt_observation=not_applicable`を拒否して全planを`unavailable`にしていたため、その状態組合せを限定して許容する。合成sandboxの結果件数を保つため、先行test fixtureの一時fileは検証後にtest root内だけで除去した。

対象Windows Gateway実process testは1 selected PASS、同file内の他3件はpattern skip。HDS typecheck/build、Gateway typecheck/build、`git diff --check`はPASS。実provider呼出し0件、外部業務作用なし。全workspace suite、実provider、全OS、QE_QC／QE_QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOの証拠ではない。

#### 2026-10-31 E2E-01 BUILD接続 — file.write作用後のGateway process crash recovery

直前のSQLite triggerによるreceipt保存拒否を、Broker結果receipt更新中にGateway processそのものを強制終了するfixtureへ置き換えた。合成create-only `file.write`の効果がfile rootに現れた時点で、永続intentが`invocation_attempted`、result receipt digestなし、execution result outboxなしであることを確認してGatewayを停止した。再起動後、SQLite transaction rollbackとstartup recoveryを通し、同じtask identity／plan dependencyを`outcome_unknown`で保持した。元writeのM action-result receipt・依存stepは進めず、ownerのsandbox file-state照合だけをdigest-only observationとしてMへ記録。その観測をownerが選択後、同一taskのread-only `file.search`候補をL3／step review・既存Brokerへ通し、結果M receiptと明示WebChat返却まで続けた。元writeは再発行されず、sandbox fileは一件、対象taskのprovider callは0件。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| `BT-U-C08.01-P-E2E` Gateway process test | PASS。1 selected、同fileの他3件はpattern skip。実Gateway強制終了後の再起動・同task復帰を確認。 |
| crash時の永続状態 | `invocation_attempted`、result receipt digestなし、outbox 0件。作用済みfileは一件。 |
| 再起動後の継続 | 元writeは`outcome_unknown`／action-result M receipt未記録を保持。digest-only local observation→owner選択→read-only search→J/M receipt→明示結果返却まで接続。 |
| Gateway typecheck／build | PASS。 |
| provider／live外部作用／別repo | provider call 0件。外部業務作用・Actions・D4-Pocket／ミニドラ変更なし。 |
| 全workspace suite／QE_QC／QE_QA／5OS実機 | 未実施。 |

この接続は`invocation_attempted`のままGatewayが落ち、result outboxがないcrash窓を閉じるものである。上段の別process testではresult outbox commit後の停止も捕捉したが、旧execution epochの結果はrev3.0 E03.02に従って新J/Mへ直接採用せずarchiveする。現在の到達はowner媒介の現在状態観測からread-only再計画までであり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**前batchの次producer／consumerは本batchで接続済み。**

#### 2026-10-31 E2E-01 BUILD接続 — owner選択後の現sandbox再観測

`plan:compute`にowner選択済み`local_file_state`参照がある場合、GatewayはHDS `decide`前に同じplan／revision／step／command／task／execution epochの照会許可を取得し、現行execution receiptを再照合した後、既存のsandbox内create-only `file.write`状態検査を再実行する。許可は30秒・単回で、HDSが発行・消費し、GatewayからJへ渡すのはdigest-only観測だけ。観測は既存receipt observationとしてJ/Mへ保存し、次のHDS計算はその最新観測を再照合する。対象不在・内容不一致・receipt変化・保存不成立・検査失敗は候補生成前にfail-closedとなる。元`file.write`は`outcome_unknown`を維持し、再送・成功推定・外部provider呼出しはない。

全workspace `tsc -b`相は完了し、Gateway個別`tsc --noEmit`と`git diff --check`はPASSした。一方、typecheck後の生成物掃除、HDS個別typecheck、HDS-BRAIN buildが、原因主体未特定のWindows file lock（`dist/output_audit.js`等への`EBUSY`）で停止または未成立となった。ロック対象は削除・強制終了していないため、全workspace buildは未成立として扱う。テストとGateway実process確認も未実施（NOT_RUN）で、実行時接続の動的証拠はない。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-10-31 E2E-01 BUILD接続 — WebChat承認一覧の返却同期

現行コードの静的追跡ではowner step reviewからHDS-bound command、既存Approval／Executor・Broker、保存済みresult reconciliation、J/M receipt gate、WebChat返却まで接続済みである。L3等で承認待ちとなった場合、Gatewayは`[approval-required]`をWebChatへ通知していたが画面側はRuntime snapshotだけを更新し、Approval一覧は手動再読込まで古い可能性があった。同通知を受信しApproval tokenが入力済みなら`/approval`を再取得するよう接続した。並行取得は最新requestだけ描画し、保留中commandのreview digestは同じcommandが引き続きpendingで内容確認を要求していない場合に限り保持する。これは表示用snapshotの再読込であり、承認・権限・実行経路を追加しない。

channel-webchat `typecheck`と`git diff --check`はPASS。テスト、Gateway実process、外部providerは未実施。ソース上の接続を実行時のE2E証拠へ昇格させず、`SYSTEM_SHAPED`／`BUILD_COVERED`やQE_QC／QE_QAは未成立として保持する。

**次:** rev3.0現行工程から次の未接続producer／consumerを特定し実装を続ける。E2E-01の実行確認は、全体実装後のQE_QC段階で同じtask・承認条件・M receipt・WebChat返却をまとめて検証する。旧epoch result outboxはauthorityにせず、元`file.write`を再発行しない。provider/live外部作用は使わない。

#### 2026-10-31 E2E-01 BUILD接続 — 結果不明時のowner task依頼ID保持

`/owner/task-compute`は同じ`submission_id`と同じpayloadの再送を重複dispatchせず、handler開始後に結果不明となった依頼を`outcome_unknown`として再実行拒否する。一方Control CenterはHTTP 409全般でsession上のIDを消していたため、結果不明・IDと別payloadの衝突後に次の操作が新IDを作り、同じ仕事を重複dispatchできる状態だった。HTTP statusだけから未送信と推定するclient挙動を除去した。

clientがIDを消すのは`owner_task_submission_not_dispatched`、事前にterminal rejectされたsubmission、およびhandler開始前に確定した委任目的不一致だけとする。結果不明・ID/payload conflict・未知の409はIDを保持し、Runtimeの状態を確認するよう案内する。sessionに未解決IDが残っている場合は回復導線を再表示する。先行依頼の状態を確認したownerが明示操作と確認dialogを通った場合だけIDを破棄し、新規依頼を作れる。HDS authority、Approval／L3、Broker、M writer、実行・再実行の判定は変えない。

channel-webchat `typecheck`／build、control-center生成scriptの構文解析、`git diff --check`でこの差分を確認する。Gateway process、tests、実provider／外部作用は実施しない（NOT_RUN）。これはclientの重複再送防止接続であり、E2E-01全体、`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOの成立ではない。

#### 2026-10-31 E2E-01 BUILD接続 — owner task受付状態の耐久照会

WebSocketのtask結果・エラー通知は接続中だけのbest-effort配送で、切断後にControl Centerから照会できる経路がなかった。Gatewayの既存private SQLite inboxにあるcontent-freeな`submission_id`対応状態を、owner token必須の`POST /owner/task-submission-status`からread-onlyで返すよう接続した。APIは`request_id`と`dispatching`／`handler_returned`／`outcome_unknown`／`rejected`だけを返し、task本文・payload digest・実行権限は返さない。Control Centerは受理前の曖昧なID、直近の受理済みIDをsession内に保持して再照会できる。結果不明・記録なしを未送信や仕事完了の証明へ読み替えず、同じ依頼IDを維持してTasks／Runtimeを確認する案内に留める。再照会時のowner tokenは保存せず消去する。

このconsumerは受付inbox状態の観測であり、HDS taskの最終結果・実行receipt・E2E-01・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を証明しない。`pnpm --filter @blue-tanuki/channel-webchat typecheck`／`build`、`pnpm --filter @blue-tanuki/gateway typecheck`／`build`、生成script構文、`git diff --check`はPASS。test、Gateway実process、実provider／外部作用は実施しない（NOT_RUN）。

#### 2026-11-01 E2E-01 — owner task受付とRuntime planのread-only相関

Gatewayの`operation_plan_status` projectionに、HDS planの`request_id`そのものではなく、そのSHA-256 digestを任意項目`request_id_digest`として加えた。Control Centerの受付状態照会はowner tokenで得た`request_id`から既存の`operation-request:<id>`をdigest化し、認証済みRuntime snapshot内のplanと照合する。一致した場合は既存のplan cardと同じ短縮plan digest・revision・step状態を受付表示へ付記する。受付statusとRuntime plan表示は別状態であり、結果 verified表示も仕事全体の完了を意味しない。

Runtime tokenなし、snapshot／projection取得不能、復元照合中、複数一致、表示件数制限、digest計算不能は対応未確認として表示する。一致planなしも仕事の未作成・完了・失敗の根拠へ読み替えない。raw HDS `request_id`の新規露出、追加route、J/M／権限／実行更新はない。既存`renderOperationPlanStatus`が表示するplan cardと`plan_id`／`revision_digest`に結び付いた既存owner操作を利用する。

WebChatとGatewayのtypecheck／build、生成Control Center script構文、`git diff --check`はPASS。unit／process test、Gateway runtime、provider／live外部作用、全体QC／QAはNOT_RUN。限定的な状態表示接続であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOは成立しない。

**次:** E2E-01の残るproducer→consumer断線を最新HEADと現行正本から選び直し、対象path／functionを特定して実装する。owner task状態から一致した既存plan cardへ進む表示・操作境界は接続済み。provider/live外部作用と広域QCは使わない。

#### 2026-11-01 E2E-01 BUILD接続 — Tasksから一致planのRuntime状態・既存owner操作へ

owner task受付状態の照会後、認証済みRuntime snapshotから同一依頼IDに対応するplanを特定できても、実際のOperation Plan cardは`skills`／`developer`画面だけにあり、受付操作のあるTasks画面から続けられなかった。既存の同一Operation Core Plan projectionを`tasks`画面にも表示し、照会したplan状態・revisionと既存のowner操作が同じ画面で利用できるよう接続した。表示は同じread-only snapshotを再利用し、HDS/J、Approval、Broker、M writer、実行経路や権限は変更しない。

WebChat typecheck／build、`git diff --check`はPASS。test、Gateway runtime、実provider／外部作用はNOT_RUN。D09.01／F10.01の当該UI consumer辺は`WIRED`。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

この次工程は、下記2026-11-01の実装記録で処理した。

#### 2026-11-01 E2E-01 BUILD接続 — owner task状態照会へ同一依頼IDの実行証拠を表示

`POST /owner/task-submission-status`が返すrequest IDを、認証済みRuntime snapshotの`operation_core_execution.latest_results`内で完全一致照合する読取専用表示をTasks状態欄へ接続した。表示前にprojection schema、内部状態だけの証拠源、非権威flag、raw payload非露出、hash chain、実行記録とnested command result双方のrequest IDを照合する。条件がそろった場合だけoperation、下流のstate/action outcome、短縮result digestを表示し、`step未結合・非権威・本文非表示`と明記する。履歴範囲外・記録欠落・chain不成立は未確認とし、未送信・未実行・完了へ読み替えない。

既存のTasks内Operation Plan cardには、owner専用`/owner/inbound`を経由する`plan:result`があり、verifiedな`file.search`かつreceipt／digest条件を満たす保存結果だけを、元検索の再実行なしでHDSから読める。Gatewayはその読取commandをno-opとして処理し、既存OutputAudit後に返信する。これは既存経路のコードトレースであり、今回WebSocket再接続後に押下するprocess動作は検証していない。一般chatのraw回答本文は保存・再配信せず、digestと実行証拠を最終回答に読み替えない。

WebChat typecheck／build、生成Control Center script構文、`pnpm docs:check`、`git diff --check`はPASS。unit／process test、WebSocket再接続後の操作、実provider／外部作用、全体QC／QAはNOT_RUN。この状態表示は同一request ID実行観測の`WIRED`であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOを成立させない。

**次:** E2E-01の残る未接続producer→consumerを最新HEAD・現行三点正本・実物から選び、BUILDを続ける。保存済み`file.search`結果の再読と、一般chat回答本文の耐久再配信は別能力として扱う。provider/live外部作用と広域QCは使わない。

#### 2026-11-01 E2E-01 BUILD接続 — generic executor feedbackの安全なfallback表示

Tasks状態欄の同一request ID実行記録について、`command_execution_result`が欠落または照合不適合でも、hash chainが有効で個別entryの`execution_result_projection`非権威flag・`INTERNAL_STATE`証拠源・status・`result_present`／64桁digestの整合・安全なoperation名を確認できる場合に限り、generic executor feedbackを追加表示する。これはGateway executorの一般status観測であり、Operation Core固有のaction outcome、HDS判断、command成功、仕事完了、目的達成を示さない。本文・error理由は表示せず、詳細は引き続き未確認として区別する。

WebChat typecheck／build、生成Control Center script構文、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認。test、Gateway process再接続、実provider／外部作用、全体QC／QAはNOT_RUN。D09.01／F10.01の同一request ID実行要約consumerはgeneric executor feedback fallbackを含め`WIRED`。この接続はE2E-01全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。

#### 2026-11-01 E2E-01 BUILD接続 — Gateway再起動後のowner task受付相関

隔離したWindows Gateway processで、L3審査を経て有効化した合成目的に対するowner taskを1件受付・計画した後、同じ`submission_id`を維持してGatewayを再起動した。owner status APIは同じ`request_id`と`handler_returned`を返し、同一入力の再送は`already_accepted`で閉じ、合成provider呼出し数も増えなかった。復元後のRuntime snapshotは`recovery_refresh_status=ready`で、受付`request_id`に一致するplan digestが1件だった。Runtime／status projectionは引き続き非権威であり、実作用は行っていない。

対象の隔離process test、Gateway typecheck、`git diff --check`はPASS。実provider、外部作用、実ブラウザー再読み込み、handler実行中のprocess killはNOT_RUN。別の既存大型Gateway integration testでは、owner選択済みfile.write状態を使う再計画が`plan_control_denied:plan_compute_source_observation_authorization_failed`で拒否され、同一task file.search候補が作られなかった。所有者選択観測の再確認／認可失敗の根因は未特定で、次に修正する。この結果は受付済みtaskの再起動後照会だけを示し、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

**次のproducer／consumer:** owner選択済みlocal file-state observationの再計画前認可を修復し、既存のGateway receipt再照合・単回観測permit・digest-only M保存・同一task identityを保ったまま次の未実行候補へ接続する。その後、`dispatching`中のprocess killで`outcome_unknown`と再送拒否を確かめ、command intent・execution receipt・M receipt・plan dependencyの再照合を続ける。

#### 2026-11-01 E2E-01 BUILD接続 — owner task照会IDのセッション横断回復

owner taskの状態照会IDは、送信中の重複防止IDとして`sessionStorage`に保持し、成功後は照会用の不透明`submission_id`だけを同一Gateway originの`localStorage`にも記録する。タブ終了・ブラウザー再起動後もowner tokenを再入力して同じGatewayの受付状態を照会できるようにした。task本文、request payload、owner/runtime token、結果本文は永続化しない。localStorageが無効でも現在タブ内の状態照会は維持する。照会結果は受付・Runtimeの非権威観測であり、未確認・結果不明を完了へ読み替えず、WebSocket結果の再配信もしない。

WebChat typecheck/build、生成`control_center_script.js`の構文確認、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認。test、Gateway再起動、WebSocket再接続、provider/live外部作用はNOT_RUN。これはセッション横断の状態回復導線であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

#### 2026-11-01 E2E-01 BUILD接続 — 再起動後の依頼ID再送防止と状態確認後の明示切替

Control Centerは起動時に保存済みの最新`submission_id`を現在の送信IDへ復元し、status照会だけでなく後続送信にも同じIDを使う。`409`や結果不明の応答だけでは新しいIDへの切替を表示せず、現在の送信IDについてGateway statusを照会し、`dispatching`でない受付状態とRuntime相関を読んだ後にだけ専用切替を使える。既知の`rejected`は非dispatch状態としてGateway照会後に切替可能。照会対象の選択またはowner/runtime tokenの変更は切替表示を無効にし、再照会を要求する。明示切替は新しいUUIDをsession/localStorageへ保存してから次の送信に使う。タスク本文・request payload・token・結果は保存せず、自動再送・結果再配信・外部作用を追加しない。

WebChat package typecheck/build、生成`CONTROL_CENTER_SCRIPT`構文解析、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`は日本語基底移行負債76件の既存注意を出した。ブラウザー再起動の実操作、Gateway `dispatching`中のprocess kill、実provider／外部作用はNOT_RUN。この接続は再送防止IDと状態確認後の明示的切替をUIへつないだ`WIRED`であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

#### 2026-11-01 E2E-01 BUILD接続 — 複数owner task照会IDの選択回復

owner task状態照会の保存先を単一の最新IDから不透明`submission_id`一覧へ拡張し、Tasks画面で照会対象を選択できるようにした。IDは送信前に記録して応答消失時の回復を保ち、同一Gateway originの`localStorage`へIDだけを保存する。task本文、payload、owner/runtime token、結果本文は追加保存しない。旧単一IDキーも読み取り候補に残し、既存利用者の回復を維持する。照会は既存のowner-token必須read-only APIを使い、受付status／Runtime相関／非権威証拠の意味は変えない。

この差分は複数依頼を続けて送った場合にも前の照会IDを上書きで失わないためのTasks consumer接続である。WebChat typecheck/build、生成Control Center script構文、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認。test、Gateway process再接続、provider/live外部作用、全体QC／QAはNOT_RUN。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD接続 — WebChat予期切断後の限定再接続

Control CenterのWebSocketが予期せず切れた後、現在の接続で認証したWebChat identityを維持し、1／2／5／10／30秒間隔、最大5回の再接続を行う。再接続後は既存の`hello`とRuntime snapshot読込経路へ戻り、切断中に届かなかったtaskを再送しない。利用者には保存済みの依頼IDとowner tokenで状態照会するよう示す。手動切断は待機中の再接続を取り消し、上限後は手動接続を促す。新たなtoken・task本文・返信本文を永続化せず、既存の返信再配送禁止を維持する。

WebChat package typecheck／build、生成`CONTROL_CENTER_SCRIPT`構文解析、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認。test、実Gateway processの切断／再接続、provider/live外部作用はNOT_RUN。この差分は接続回復の`WIRED`であり、WebSocket動作確認、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

**次のproducer／consumer:** 再接続後のowner task回復では、`/owner/task-submission-status`のread-only受付状態と`ownerTaskRuntimeCorrelation()`のRuntime snapshotを同じ選択済み`submission_id`へ結び続ける。結果本文・未配信frameの再配送やtask再実行は追加しない。Gateway再起動時の合成実process観測は別途未実施である。

#### 2026-11-01 E2E-01 BUILD接続 — status照会中の選択ID固定

owner task状態照会のHTTP応答、Runtime再読込、request ID digest照合の間に別の依頼IDが選択されると、古い応答が現在選択中の依頼へ見える競合を閉じた。照会中はID選択を操作不可にし、並行task受付が選択を更新した場合は古い照会結果・Runtime相関を表示しない。受付記録がある場合は照会対象submission ID末尾とGateway request ID末尾を併記する。照会開始後に利用者がowner token欄を更新した場合、古い要求の終了処理は新しい値を消去しない。owner status API、Runtime snapshotのread-only性、HDS／Approval／Broker権限、task送信・再送動作は変更していない。

WebChat package typecheck／build、生成`CONTROL_CENTER_SCRIPT`構文解析、`git diff --check`はPASS。test、Gateway実processでの再接続からstatus照会までの連続動作、実provider／外部作用はNOT_RUN。この差分は選択済み依頼IDへのUI相関を保護する`WIRED`接続であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOを成立させない。

**次のproducer／consumer:** browser restart後のsubmission ID復元・再送防止とstatus／Runtime確認後の明示切替はコード接続済みだが、実ブラウザーでの連続観測は未実施。次はGatewayが`dispatching`中に失われた場合の`outcome_unknown`回復と同一ID再送拒否をproducer／consumerへつなぎ、返信再配送・task再実行を加えず、QE_BUILDを続ける。

#### 2026-11-01 E2E-01 BUILD接続 — dispatching中のGateway消失からoutcome_unknownへ

既存の耐久owner-task inboxと`/owner/task-submission-status`／`/owner/task-compute`を、隔離Windows Gateway processで強制終了境界まで接続した。合成providerの1要求を応答保留にしてowner taskを`dispatching`で受付け、状態APIが同じ`submission_id`／`request_id`とno-storeを返すことを確認した。その後Gatewayを強制終了し、同じprivate stateで再起動すると`outcome_unknown`へ遷移した。同一submission ID・同一payloadの再送は409 `owner_task_submission_outcome_unknown`となり、provider呼出し数は増えなかった。task内容は耐久inboxへ追加せず、task再実行・返信再配送・実provider・tool作用はない。これは既存durable state/APIのprocess crash consumerを確認したもので、Control Centerの実ブラウザー再起動操作やE2E-01全体を確認したものではない。

対象の`document_organization_entry.test.ts` 1件（同fileの他4件はpattern skip）、Gateway typecheck／build、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`は日本語基底移行負債76件の既存注意を出した。実provider／外部作用、実ブラウザー、workspace suite、全体QC／QAは未実施。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次:** E2E-01の次のproducer→consumer差分を最新HEADと現行正本から選び、既存のcommand intent・execution receipt・M receipt・plan dependencyの関連付けを通る仕事を一気通貫で前進させる。実provider、live外部作用、広域QCは使わない。

#### 2026-11-01 E2E-01 BUILD接続 — owner task受付から同一taskのM receipt状態表示まで

owner task status照会で`request_id` digestに一致したRuntime planについて、既存`task_identity_digest`が同じ計画の表示件数と、依頼一致planのstep bindingにある`memory_status`をTasks consumerへ表示するよう接続した。表示は既存の非権威`operation_plan_status` projectionに限定し、M receipt本文・task本文・raw digestを出さない。planの表示上限、stepの省略、task identityまたはbinding projectionの不備は未確認と表示し、完了・権限・再実行可否を推定しない。

WebChatの対象テスト1件（同fileの他113件pattern skip）、package typecheck/build、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認した。Gateway process、実ブラウザー、全workspace suite、provider／外部作用、QE_QC／QE_QAはNOT_RUN。この接続はowner task受付からplan lineage／M receipt状態への`WIRED`表示であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOを成立させない。

#### 2026-11-01 K-B5 BUILD接続 — 実Rust processのplan adoption分類差receipt

Gateway observer試験に限るclassifier注入を用い、TypeScript側期待分類を`matched`、同じ固定projectionから実Rust processが返す分類を`mismatched`とするreceiptを通した。observerはRust receiptのshape、projection echo、status／matches内部整合を保って受け取り、両側の分類と`plan_step_adoption_classification_agrees=false`、総合`mismatched`を記録した。Rust向けprojection bytesは注入前の同一snapshotのまま。注入は試験だけで、実装間に自然発生する差や実運転のTypeScript分類を示さない。受理にはRust receiptの`hold`・no-effect・no-M-write条件が引き続き必要。

Gateway observer process試験6件とGateway typecheck、`git diff --check`はPASS。全workspace suite、実provider／外部作用、全体BUILD、QE_QC／QE_QA、5OS、single-writer cutoverは未実施または未成立。

**次のproducer／consumer:** 全体実装を優先し、E2E-01の既存command intent・execution receipt・M receipt・plan dependencyを同一task identityでつなぐ。最新HEADで実際に切れている辺と呼出し元／consumerを特定し、既存権限・receipt・M writerを使って合成仕事の実経路を進める。実provider、live外部作用、広域QC／QA、Rust cutoverは行わない。

#### 2026-11-01 E2E-01 BUILD接続 — owner task状態へGateway実行intent receiptを相関表示

Runtime snapshotが既に返していた非権威`execution_receipts` projectionを、Control Centerのowner task状態照会で消費するよう接続した。HDS plan bindingに保存されたexecution admissionのticket IDを一方向digest化し、依頼一致planのticket digestに加えて、receiptのcommand digestとtask identityまで一致する一件だけを結合する。`issued`／`intent_committed`／`invocation_attempted`／`adapter_returned`／`not_attempted`／`outcome_unknown`の状態を表示する。同じcommand digestでも別ticket・別taskのreceiptは結合しない。複数receiptの一致・不正projectionは未確認、snapshot表示範囲に一致がない場合も未実行の証明にせず未観測とする。raw ticket、command digest、結果本文は表示せず、Gateway receiptは非権威・実行不許可の観測に留める。既存のplan lineageとM receipt状態表示、HDS判断・承認・Broker・M writerは変更しない。

HDSのticket digest生成試験1件、Gateway投影試験1件、WebChat相関試験1件（同fileの他113件pattern skip）はPASS。HDS／Gateway／channel-webchatのtypecheckとbuild、`docs:check`、`git diff --check`もPASS（日本語基底の既存移行負債76件）。別Gateway process／実ブラウザー、provider／live外部作用、workspace suite、QE_QC／QE_QAはNOT_RUN。この接続は依頼一致plan内のexecution ticket・command・task identityをGateway receipt snapshotへ表示相関する範囲に限り、E2E-01全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。

**次のproducer／consumer:** E2E-01の残る仕事経路を最新HEADと現行正本から選び、固定合成file.write／file.search系列を越える通常taskの目的・C候補・J採否・結果/M・同一task再計画を既存consumerへ接続する。実provider呼出し、live外部作用、広域QC／QA、Rust cutoverは保留する。

#### 2026-11-01 E2E-01 BUILD接続 — task指定本文からの限定file.write候補

開発用synthetic Cが、従来の固定demoに加えて、owner task本文で明示された単一の相対`.txt`名と一行本文から、sandbox内のcreate-only `file.write`候補を作れるようにした。Cはsandbox内容を先読みせず、本文から書込byte数を決定する。J、Approval Gate、Broker、Executor、M、同一task再計画の契約・権限経路は変更していない。親taskの検証済みwrite receiptまたはownerが選択した不確実状態observationを照合した場合、元taskの同じ名前・本文を使って既存`file.search`候補へ進む。同一task検索は`file_path`で指定した一ファイルだけを読み、承認前のtarget-version証拠で相対pathと内容を再照合する。従来のroot全体検索は維持する。これはproviderを使わないboundedな開発fixtureの入力一般化であり、任意task向けの一般Cや実行済みE2Eの証拠ではない。

Windows隔離Gateway process test `BT-U-C08.01-P-E2E`は1 selected PASS（同fileの他4件はpattern skip）。Ownerから送った動的task本文の相対filename／一行本文がcreate-only `file.write`へ届き、目的関係L3審査・同plan/revisionのstep審査・既存Approval／Broker・write結果／M receiptを通った。Gateway再起動後に同一plan／task identityとwrite receiptを復元し、同一taskの単一file `file.search`候補・M receiptまで進み、二度目のGateway再起動後も同じ検索結果を既存`plan:result`で読み出せた。結果読取後もtest-owned fileは一件で、再検索・再書込みなし。対象task中の実provider呼出しなし。Gateway package typecheck／buildもPASS。初回実行は名前filterがVitestへ渡らず全fileを対象にしたため停止し、正しい`--testNamePattern`で対象一件を再実行した。この証拠はこの限定synthetic taskのruntime経路を`WIRED`とする範囲であり、独立した一般C、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は成立させない。workspace suite、provider／live外部作用、QE_QC／QE_QAはNOT_RUN。

**次のproducer／consumer:** 現行rev3.0の施工順と最新実物を再照合し、QE_BUILDとして次の未接続な通常Owner仕事のproducer／consumerを一件選ぶ。既存権限・Approval／Broker・Mのwriterは維持し、実provider・live外部作用・広域QC／QA・Rust cutoverは行わない。

#### 2026-11-01 E2E-01 BUILD接続 — owner task語句指定のread-only file.search候補

開発用synthetic Cが、固定demo／file.write taskに加えて、`sandbox内のテキストファイルで次の語句を検索してください。\n検索語: <語句>`の厳密なtask形から、sandbox全体を対象に最大5件を返すread-only `file.search`候補を作れるようにした。語句は空文字・前後空白・制御文字を拒み、最大200文字。検索対象は既存`BLUE_TANUKI_FILE_ROOT`境界内で、HDSの`L1_observe`／Approval Gate／Broker経路を使い、外部作用・書込み・削除を行わない。

新しい`file_search_result_matches`契約は、要求とdirectory targetの一致、root・query・上限、bounded match path／行番号／本文長を結び、余分なresult fieldを拒む。Broker target-version observationが含まれる場合はschema、要求root／任意file path、走査件数も照合する。検索の完全性は`unknown`のまま維持する。このvalidatorはHDSのresult確定、checkpoint検証、Gateway recovery inspectionで共用し、既存M receipt／`plan:result` consumerを再利用する。新しい検索結果をruntimeで実行・表示した証拠はまだない。

`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。日本語基底の移行負債76件は既存注意として残る。専用process／WebChat実行、全workspace test suite、実provider／live外部作用、QE_QC／QE_QAはNOT_RUN。したがってこのtask入力形の状態は`CODE_PRESENT`であり、runtime `WIRED`、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。

**次のproducer／consumer:** ownerが指定した一つの相対file pathに対するread-only `file.search`候補を、既存の対象観測・結果/M・`plan:result`へ結ぶ。その後、検索で得た対象を使う変更仕事は明示的な目的束縛、L3 no-store内容審査、Approval／Broker再照合を通す別のBUILD単位として進める。

#### 2026-11-01 F01.01 BUILD接続 — owner指定相対pathのfile.edit候補

合成C入力に厳格な3項目JSON（相対path・置換前・置換後）を追加し、固定sandbox内の安全な相対path、置換一回、512,000 byte上限を持つ単一`file.edit`候補へ接続した。候補は`goal_purpose_relation=unknown`を保ち、Jの明示目的束縛、既存L3 no-store内容審査、Approval／Broker再照合を通らなければ採用・実行できない。operation contractとHDS result validatorに編集結果のpath・置換数・byte上限確認を加えた。既存の編集実行側target／digest再照合を維持し、実ファイル編集は行っていない。

`pnpm typecheck`、`pnpm build`、`pnpm docs:check`はPASS。専用process／WebChat、実LLM、実file.edit、全workspace test suite、実物QC／対象別QAはNOT_RUN。日本語基底の移行負債76件は既存注意として残る。このtask入力形は`CODE_PRESENT`であり、runtime `WIRED`や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。

#### 2026-11-01 F01.01 BUILD接続 — verified file.edit結果のowner-bound `plan:result`

HDS `inspectSavedResultForReturn` が`file.search`専用だったため、verified `file.edit`の結果receiptはMへ記録されてもownerへ返せなかった。既存の同一plan/revision/step、owner再認証、J checkpoint、M commit／receipt／record照合を維持し、file.edit result digestとMのdigest-only action-result observationを照合する読取consumerを追加した。返却projectionはrelative path・置換数・書込byte数・receipt識別子だけで、本文・置換前後の内容・差分を含めない。Gatewayは既存Output Audit後に返信し、Control CenterはJ/M receipt確認済みのstepだけに専用読取ボタンを表示する。再編集・再読込はしない。

HDS／Gateway／WebChat typecheck、HDS build、Windows isolation target向け`cargo check`、Rust `cargo fmt --check`、`pnpm docs:check`、`git diff --check`はPASS。日本語基底移行負債76件は既存注意。**STATUS=WIRED（コード接続）**。Gateway/WebChat実行、実file.edit、browser、workspace suite、QC／QAはNOT_RUN。これはF01.01の限定consumer接続であり、E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。

#### 2026-11-01 F01.02 BUILD接続 — 要求ごとのWindows AppContainer SID

固定AppContainer名が要求間で同じSIDを再利用し、並行requestが別々のroot ACLを同じSIDへ一時付与し得る状態を確認した。Windows native isolation helperは要求ごとに`UuidCreate`で固有profile名を作り、既存profileへのderive/fallbackをせずに失敗させる。root grant更新が失敗した場合もrevokeを試み、process/job後にroot ACLをrevokeしてprofileを削除する。cleanup失敗は成功結果にせず、errorとして返す。既存Job Object制限、J／Approval／Broker経路は変更していない。

**STATUS=WIRED（コード接続・Windows target cargo check PASS）**。実process起動、root ACL付与／撤去、profile削除、並行隔離、異常終了はNOT_RUN。helperを起動せず、OS ACL変更もしていないため、Windows実環境での隔離成立は未証明。これらはF01.02後段の隔離QC候補として保持する。実provider、外部業務作用、D4Pocket変更、Rust authority/cutoverは行わない。

**2026-11-01 F01.03 BUILD接続 — 同一Workspaceの設定・実行境界:** Settings UIへ任意の隔離process rootを追加し、File sandbox rootと同一パスを設定する操作を接続した。shell.execが`same_workspace_as_file_root=true`を要求した場合、Broker target審査時と実行直前の両方で両rootを実resolveし、同一directoryでなければ拒否する。shell root未設定時のfail-closedと既存L3／Approval／Brokerは維持する。setup／Settings／root mismatch拒否の限定test 3件、Gateway／core typecheckはPASS。実process起動、審査済みdiff後のtest、再読取、失敗時復帰はNOT_RUNで、F01.03全体は未成立。

**次のproducer／consumer:** 既存owner審査済み`file.edit`の後続で、同一rootを要求する隔離testを実行し、その結果と同一fileの再読取をGUIへ返すconsumerを接続する。test失敗時は現行file identityを再審査した新しいowner承認済み逆編集へ戻し、競合writerを上書きせず自動復元しない。D4Pocket側は変更しない。実provider、live外部作用、広域QC／QA、Rust cutoverは行わない。

#### 2026-11-01 F01.03 BUILD接続 — 同一Workspace隔離testのsummary結果

`file.edit`／`shell.exec`／`file.search`の既存tool consumerへ順序を明示した。明示依頼がある場合に限り、owner審査済みfile.edit後のtestを`shell.exec`の`same_workspace_as_file_root=true`で実行する。同一Workspace指定時は`summary_only=true`を強制し、省略／falseならtarget review前に拒否する。summaryはexit status・captured textのbyte数／SHA-256・process終了状態だけを返し、stdout／stderr本文を会話へ渡さない。続けて同じ相対pathの`file.search`で現在状態を読み直す。test失敗から自動復元せず、ownerが復帰を選んだ場合は現在対象版へ結び付く新しいfile.edit審査を要求する。

Windows native AppContainerの限定process testで、同一file root内の`reviewed.txt`を`findstr.exe`が読めること、exit code 0／process tree empty、およびsummaryに本文が含まれないことを確認した。summary省略時のpreflight拒否も確認した。core／Gateway typecheck、core build、対象test 1件はPASS。これは隔離shell consumerの限定接続証拠で、WebChat上のfile.edit→test→file.search完全往復、失敗時の新規逆編集、F01.03全体は未確認／未成立。実provider・外部live・全suite・QC／QAはNOT_RUN。

#### 2026-11-01 F01.03 BUILD接続 — Gatewayの同一task edit/test/reread

開発専用の固定synthetic taskを通常Owner task受付からGateway／WebChat processへ通し、同一task identity・plan内でowner審査済み`file.edit`→summary-onlyの同一Workspace `shell.exec`→同じ相対pathの`file.search`を順番に実行した。file.edit差分とshellの各L3 Approvalをowner tokenで審査し、最後の`plan:result`で再読込結果をOwnerへ返した。shell結果はexit status・stdout/stderr byte数とSHA-256・process状態だけを返し、本文を含めない。試験用Node assertionは置換後の文字列を確認し、作業fileは試験専用に作成・削除した。実装は非0終了もexit statusと失敗状態を保持し、成功へ変換しない。今回実行したのはexit code 0の成功経路で、非0／timeoutのruntime経路はNOT_RUN。実provider呼出しは0件。

`pnpm typecheck`、全workspace `pnpm build`、Gateway process test 1件（`BT-U-C08.01-P-E2E`、同fileの他4件をskip）、`git diff --check`はPASS。testから検証できたのは合成taskのexit code 0成功経路であり、非0／timeout実行、失敗時の新規owner-reviewed recovery edit、GUIの一般task全体、F01.03全体は未成立／NOT_RUN。実provider・外部作用・全workspace suite・QE_QC／QE_QA・5OS実機はNOT_RUN。

**次のproducer／consumer:** test失敗後に自動復元せず、同一対象の現在版をownerへ示し、既存Content Review／版再照合／L3を通る新しい逆編集だけを提示する回復経路を接続する。ownerの新規承認なしに復帰編集を実行しない。

#### 2026-11-01 F01.03 BUILD接続 — failed test後のowner-reviewed逆編集候補

同一Workspaceのsummary-only `shell.exec`について、Jの非権威plan projectionへexit code／signal／timeout／process-tree emptyだけを追加した。stdout／stderr・command・file内容は投影しない。WebChatは明示的な非0終了と同一planのM receipt確認済みfile.searchが揃った場合だけ、owner tokenによる逆編集候補計算を提示する。先に保存済み検索結果で状態を確認するよう案内し、C fixtureは同じparent task identity／revisionの検索観測が一件以上ある場合だけ、元の置換を逆にした単一`file.edit`候補を返す。候補は未実行であり、自動復元しない。既存Content Reviewが現行差分を再表示し、target version再照合と新しいL3 Approval／Brokerを通過しなければ編集されない。timeout・中断・終了codeなしは逆編集条件から除外する。

HDS-BRAIN／Gateway／core／WebChatのTypeScript no-emit確認、生成Control Center script構文確認、`git diff --check`はPASS。Gateway process／browser／test suiteはNOT_RUN。STATUS=WIRED（HDS projection→WebChat owner選択→同一task search observation→synthetic逆編集候補のコード経路接続、実consumer未実行）。実provider・実外部作用・本番file編集は未使用。F01.03全体、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次:** QE_BUILDを続け、最新実物から次の未接続producer／consumerを選ぶ。統合形状が揃う前の広域QC／QA、実provider、live外部作用、Rust cutoverは行わない。

#### 2026-11-01 E2E-01 BUILD — owner指定単一file.delete候補

開発専用synthetic Cに、明示された単一sandbox相対pathから`file.delete`の未実行候補を作る入力形を追加した。pathは相対・非secret・traversalなしに限定する。OperationPlanは対象fileとpathを一致させ、`max_bytes=256000`、effect=`delete`、high／`L3_final_review`、HDS authority／Approval Gate必須を固定する。削除後の自動補償は行わず、復元には別の明示依頼を要する。製品の既存file.deleteはsandbox内通常file・サイズ・対象版を再確認し、Broker evidenceと承認済みcommand identityなしに作用しない。

`pnpm --filter @blue-tanuki/core typecheck`はPASS。STATUS=WIRED（synthetic C→file.delete OperationPlanのコード接続。Gateway process、Owner表示、Broker／Executor実行は未確認）。実ファイル削除、test suite、process実行はNOT_RUN。実provider・live外部作用・他repo変更・Rust cutoverは対象外。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次:** 使い捨てroot内のtest専用fileに限定して、Owner表示・L3審査・対象版再照合から既存file.delete consumerまでの実接続を確認する。

#### 2026-11-01 E2E-01 BUILD — file.delete対象のOwner確認とL3接続

既存の認証済みno-store承認内容確認endpointへ`file.delete`対象の表示を接続した。Ownerが確認操作を選んだ時だけsandbox相対path、対象サイズ、上限、対象版digest、Operation Plan束縛digestを表示し、本文・絶対root・秘密内容は返さない。対象版digestはcommand・Operation Plan binding・path・file内容とidentityの観測に束縛する。確認後のL3承認時に同じ対象を再観測し、Gatewayが実行commandを構成する直前にも確認済み対象版と一致しなければ停止する。既存Broker adapterは作用直前にも対象版を再照合する。内容確認前はApproval Gateが承認を受け付けない。

`@blue-tanuki/core` build、WebChat build、Gateway typecheck／build、生成Control Center script構文確認、`git diff --check`はPASS。最初のGateway typecheckで新規review unionに伴うGmail snapshot型の絞り込み漏れを検出し、kind guardを加えて再確認した。Gateway process／Owner画面／Broker実削除の実行、test suiteはNOT_RUN。STATUS=WIRED（認証済みOwner確認→L3 Approval Gate→対象版再照合→既存file.delete Broker adapterのコード接続、runtime未確認）。実ファイル削除、実provider、live外部作用、他repo変更、Rust cutoverは行っていない。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

このruntime確認は、以下の2026-11-01追記で実施した。

#### 2026-11-01 E2E-01 BUILD — file.delete runtimeとOwner統合経路の限定確認

使い捨てtemp root内のsynthetic fixtureで、WebChat Owner taskからfile.delete plan review、L3 content review、Approval Gate、Broker実行、verified plan／M receiptまでを通した。内容確認前の承認は拒否され、確認後にfixture内容を変えるとstale拒否され、変更後の内容を再確認してL3承認した場合だけfixtureが削除された。結果はWebChatへ返った。Gateway process test `BT-U-E2E-01`は1件PASS、同fileの他5件はpattern skip。

同日、長いGateway Owner統合test `holds exact proposal text in memory, requires reviewed L3 approval, commits to J, and replays the new version`を再実行し、選択test 1件PASS（197.2秒、同fileの他5件はskip）。このtest fixtureはraw `cmd`をOperationPlanへ持つshell候補を除き、審査済みfile.edit後の同一path file.searchで確認する形へ修正した。OperationPlanのraw command禁止は維持する。

試験中に見つかった二つの接続欠陥も是正した。Gatewayのfile.delete／file.edit content reviewは、Executor approval digestと異なるHDS Operation Plan command digestを比較していたため、HDS側の正本digest関数で照合する。保存済みOperationPlan結果の検証は、plan result全体のdigestと異なる実行契約digestを比較していたため、commit observationに記録されたresult digestとbinding digestの一致を検査し、その後保存result本体を別途検証する。

HDS-BRAIN／core／Gateway build、Gateway typecheck、`pnpm docs:check`、file.delete process test 1件、長いOwner統合test 1件、`git diff --check`はPASS。実provider、live外部作用、本番データへの作用、全suite、QC／QAはNOT_RUN。確認範囲は合成testに限定し、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**当時の次工程:** 現行rev3.0と当時の最新実装を照合し、残る通常Owner仕事の未接続producer／consumerをQE_BUILDで選定して接続する。広域QC／QA、実provider、live外部作用、Rust cutoverは開始しない。現行次工程は本書冒頭の`最新BUILD_BATCH`に従う。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。

#### 2026-11-01 E2E-01 BUILD接続 — owner指定相対pathのfile.search実consumer

合成Cがowner task本文から指定相対pathと検索語を抽出し、Gateway processのfile.search、verified plan、M receipt、owner-bound plan:resultまで接続することを確認した。隔離rootに指定対象と同じ検索語を含むdecoyを置き、結果が指定対象だけを含み、decoyとrootの絶対pathを露出せず、両fileを変更しないことを確認した。実provider・外部作用は使っていない。

BT-U-E2E-01 path-bound file.search test 1件PASS、同fileの他6件skip（21.6秒）。Gateway typecheck/buildはPASS。対象owner task入力形はWIRED。Control Centerの自動WebSocket再接続はコード接続済みだがGateway process未確認。E2E-01全体、製品全体SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、5OS実機、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD接続 — verified file.write／file.delete結果のowner-bound返却

`plan:result`の既存Owner再認証・plan/revision/step束縛・verified binding・M receipt照合を使い、再起動後に保存済み`file.write`／`file.delete`の要約を読み返せるprojectionを追加した。file.writeは同じ相対path・create mode・UTF-8 byte数をsaved outputと照合して相対pathとbyte数だけを返す。file.deleteは安全な単一file target、成功output、digest-only action observationを照合して、相対pathと削除時点のreported-successだけを返す。どちらも本文、sandbox絶対root、現在のfile状態を返さず、`plan:result`は作用を再実行しない。既存のfile.search本文付き保存結果とfile.edit限定差分要約の境界は維持する。

`apps/gateway/src/serve.ts`はwrite結果を「本文は非表示・現在状態を未再読込」、delete結果を「削除時点の報告・現在の不存在を保証しない」と表示する。HDS-BRAIN／Gateway typecheckとbuild、`pnpm docs:check`、`git diff --check`はPASS。process／browser／test suiteはNOT_RUN。**STATUS=WIRED（コード接続、runtime未確認）**。実provider／live外部作用なし。変更範囲は保存済み結果のOwner返却consumerで、E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`・QE_QC／QE_QA・owner GOは未成立。

**次のproducer／consumer:** 次の独立BUILD作業で現行実物を再同期し、E2E-01の次の未接続な通常Owner仕事consumerを選んで実装する。保存結果から元作用を再実行しない。実provider・live外部作用・広域QC／QA・Rust cutoverは行わない。

#### 2026-11-01 E2E-01 BUILD接続 — owner指定単一fileのbounded preview

`file.read` Developer operationは既存catalogどおり`file.search` adapterを使う。検索語を持たない場合は、ownerが指定したsandbox相対pathが一つある場合だけ`query=""`を受理し、既存のregular-file／secret-like path／symlink／root containment／対象版hash検査を通した上で先頭最大5行のpreview候補を作る。directory-wide empty-query読取は引き続き拒否する。通常の`file.search` OperationPlan validationでも、検索語なしはexact `file_path`結合がある場合だけ許可する。verified receipt／M保存／owner-bound `plan:result`を再利用し、保存時点の行結果として返す。これはbounded previewで、全内容・検索完全性・現在状態を保証しない。

実装は`packages/blue-tanuki/src/tools/builtin.ts`、`packages/hds-brain/src/operation_plan.ts`、`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`、`apps/gateway/src/serve.ts`。workspace全体の`tsc -b --pretty false`（clean副作用なし）はPASS、15 workspace projectの`pnpm build`（Windows isolation Rust release buildを含む）はPASS、`pnpm docs:check`はPASS（日本語基底の移行負債76件の注意を含む）、`git diff --check`はPASS。Gateway process／browser／test suiteはこのBUILDでは未実施（NOT_RUN）。実provider・外部作用なし。STATUSは型／buildと静的経路確認に基づく`WIRED`、runtime確認は未成立。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 F01.01 BUILD接続 — file.read previewの保存結果をOwnerへ返却

既存`file.search`のverified/M receipt済み保存結果返却を拡張し、空query・exact relative path・最大5行が成立した場合だけ、Owner向けprojectionを`file.read` bounded previewとして識別する。projectionは相対path、上限行数、行結果、観測時刻を返し、`used_for_authority=false`／`may_execute=false`を保持する。Gateway返信は「保存時点のpreview」「全内容・完全性・現在状態を保証しない」と示し、空結果を空fileの証明にしない。既存のOwner再認証・plan/revision/step・verified binding・M receipt照合を維持し、作用は再実行しない。

実装は`packages/hds-brain/src/operation_plan.ts`と`apps/gateway/src/serve.ts`。workspace全体の`tsc -b --pretty false`（clean副作用なし）はPASS、15 workspace projectの`pnpm build`（Windows／Linux isolation release buildを含む）はPASS、`pnpm docs:check`はPASS（日本語基底の移行負債76件の注意を含む）、`git diff --check`はPASS。Gateway process／browser／test suiteはこのBUILDでは未実施（NOT_RUN）。実provider・外部作用なし。STATUSは型／buildとprojection条件の静的確認に基づく`WIRED`、runtime確認は未成立。F01.01全体、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD接続 — file.write／file.delete保存結果のControl Center入口

既存`plan:result` backendが返すverified `file.write`／`file.delete`の限定要約に対し、Control Centerで読取操作を選べるようにした。表示条件は`file.search`／`file.edit`と同じく、対象plan/revision/stepの準備、verified状態、M receipt確認、command／result／delivery digestの成立を要求する。writeは「作成結果要約」と明示し本文・現在状態を返さないこと、deleteは削除時点の報告で現在不存在を保証しないことを案内する。作用の再実行はなく、owner再認証とHDS側のreceipt再照合を既存経路で維持する。

`packages/channel-webchat/src/control_center_script.ts`を変更。channel-webchat typecheck／build、build済み`CONTROL_CENTER_SCRIPT`のJavaScript構文解析、`git diff --check`はPASS。test／browser runtimeはNOT_RUN。STATUS=WIRED（owner向けUI入口のコード接続、実操作未確認）。実provider・外部作用なし。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD接続 — 保存済み検索結果の限定preview案内

既存のowner-bound `plan:result`入口が、要求条件に応じて保存済み`file.search`結果または単一file向けの最大5行`file.read` previewを返すことを現行実装で確認した。Control Centerの入口表示と説明を「検索結果／限定preview」に合わせ、previewが全内容・検索完全性・現在状態を示さない境界を明記した。再認証、plan revision、step、verified状態、J/M receipt、digest照合は既存条件のまま。

`packages/channel-webchat/src/control_center_script.ts`を変更。channel-webchat typecheck／build、生成`CONTROL_CENTER_SCRIPT`のJavaScript構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／browser runtimeはNOT_RUN。STATUS=WIRED（owner向け説明の実物出力条件との整合、runtime未確認）。実provider・外部作用なし。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD接続 — WebSocket再接続枠を成功接続ごとに回復

Control CenterのWebSocket再接続回数が接続成功後も残り、別の切断系列で上限を早く使い切る状態を修正した。現在の接続世代を確認した後、WebSocket `open`で再接続失敗数を0へ戻す。自動再接続だったかは接続試行のローカル値で判定し、counter reset後も再接続案内を表示できる。taskを再送せず、切断中のframeを再配送せず、既存のtoken付きruntime snapshot読取も維持する。

`packages/channel-webchat/src/control_center_script.ts`を変更。channel-webchat typecheck／build、生成`CONTROL_CENTER_SCRIPT`構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／browser／Gateway processはNOT_RUN。STATUS=WIRED（静的接続、実接続未確認）。実provider・外部作用なし。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 F01.01 BUILD接続 — exact-path file.read previewの開始行指定

既存の`file.search` adapterによる`file.read` previewを拡張し、同じsandbox相対file pathについて開始行を指定できるようにした。空queryとexact pathのpreviewだけで受理し、開始行は1〜1,000,000、1要求あたり最大5行・各行240文字・既存1 MiB上限を維持する。通常検索へ`start_line`を混在させた候補はTool境界で拒否し、Operation Plan側は開始行が候補・検証期待値・連続した結果行で一致することを照合する。既存のtarget version観測はpathとファイル全体の版へ結び付き、Owner向け保存結果へ要求開始行を示す。既存のL1 observe／Approval Gate／Broker、secret-like path拒否、symlink／root containment、M receipt、非権威saved-result経路は維持し、作用は再実行しない。

`packages/blue-tanuki/src/tools/builtin.ts`、`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`、`packages/hds-brain/src/controller.ts`、`packages/hds-brain/src/operation_plan.ts`、`apps/gateway/src/serve.ts`、`packages/channel-webchat/src/control_center_script.ts`を変更。実装初回のworkspace `pnpm typecheck`と`pnpm build`（Windows isolation release buildを含む）はPASS。controller promptの最終追記後はHDS `tsc --noEmit`とHDS package build、`pnpm docs:check`（日本語基底移行負債76件の注意あり）、`git diff --check`がPASS。最終追記後のworkspace `pnpm typecheck`再実行は、`apps/gateway/dist/active_task_execution_registry.js`を削除するclean段階で`EBUSY`となり停止したため、再掃除・実行中プロセス停止はしていない。Gateway process／browser／test suite／実provider／外部作用はNOT_RUN。STATUS=WIRED（型・build・候補→adapter→HDS検証→Owner返却のコード接続、runtime未確認）。START_HEAD=`ccbd5106784cd5ccbde31e849a110f7c93f28c5f`。F01.01、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 F01.01 BUILD接続 — Owner指定のfile.edit置換数

Control Centerの未実行`file.edit`候補に、完全一致する置換数（1〜100、初期値1）の明示入力を追加した。指定値をOwner task JSONからsynthetic C parser、Operation Planの`file.edit` parameters／result validationまで保持し、実一致数が違う場合は既存toolの実行前照合で拒否する。置換数のない従来taskは1として扱う。既存Content Reviewの実差分・置換数表示、対象版再照合、no-store L3確認、Approval／Broker、M receipt／Owner結果経路を維持し、候補作成自体は作用しない。

`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`、`packages/channel-webchat/src/control_center_script.ts`を変更。core／channel-webchat typecheckとbuild、生成`CONTROL_CENTER_SCRIPT`のJavaScript構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／browser／Gateway runtime／実provider／外部作用はNOT_RUN。STATUS=WIRED（UIからplan parameters／validationまでの静的コード接続、runtime未確認）。START_HEAD=`938b626202eee12d28b2afbbcb98ed5a3042b5dc`。F01.01、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次のproducer／consumer:** 同じ目的を保つOwner taskから、指定置換数を含む候補が既存no-store差分確認・Approval／Broker・execution／M receipt・Owner結果返却へ通る経路を実物で閉じる。preview本文や過去receiptを権限根拠にせず、編集対象の現在版が変われば新しい確認を要求する。

#### 2026-11-01 F01.03 BUILD接続 — test timeout後のowner-reviewed回復候補

同一Workspace `shell.exec`が検証済みtimeoutを返し、process tree emptyを確認できた場合も、失敗後の回復候補を提示できるようにした。timeoutは部分的な作用を残す可能性があるため、既存条件どおり同一planのM receipt確認済み`file.search`で現在状態を確認した後に限る。候補生成は未実行で、新しいContent Review／対象版再照合／L3 Approval／Brokerを要し、自動復元はしない。中断、終了状態不明、process tree未確認には拡張しない。

`packages/channel-webchat/src/control_center_script.ts`を変更。channel-webchat typecheck／buildと`git diff --check`はPASS。生成script構文解析、Gateway process／browser／test suiteはNOT_RUN。STATUS=WIRED（timeout表示とowner選択候補の静的接続、実consumer未確認）。実provider・外部作用なし。F01.03全体、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次のproducer／consumer:** 同一taskのtimeout後に、process-tree確認済みsummary・保存済み検索結果・Owner選択・新規逆編集候補・現行版Content Review・L3 Approval／Broker・M receipt／結果返信が合成Gateway runtimeで連なること。

#### 2026-11-01 F01.03 BUILD接続 — 失敗試験根拠のHDS照合

逆編集候補の入力時に、HDSが親planの3-step形状、編集対象path／置換文字列、同一Workspace root、shell→再読取依存、shell結果のM receiptを照合する。非0終了またはprocess tree emptyを確認したtimeoutだけをfile.search観測へ付与し、synthetic CはこのJ/M確認済み根拠がない回復候補を拒否する。stdout／stderr、raw command、pathはC観測へ追加しない。成功・中断・終了状態不明・未確認のprocess treeは対象外。候補は未実行で、現行版Content Review／対象版再照合／L3 Approval／Brokerを維持する。

`packages/protocol/src/operation_plan_state.ts`、`packages/hds-brain/src/operation_plan.ts`、`packages/hds-brain/src/controller.ts`、`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`を変更。protocol／HDS build、core／Gateway／WebChat typecheck、`git diff --check`はPASS。test／Gateway process／browser／実provider／外部作用はNOT_RUN。STATUS=WIRED（HDS証拠照合からsynthetic C拒否までのコード接続、実consumer未確認）。F01.03全体、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次のproducer／consumer:** timeoutと非0終了の各実行で、HDSの失敗根拠・保存済みfile.search・Owner選択・新規逆編集候補・現行版Content Review・L3 Approval／Broker・M receipt・Owner返信がsynthetic Gateway runtimeで連なること。testは実行せず、runtime実行に進める環境・承認済み手順を先に整える。

#### 2026-11-01 F01.03 BUILD接続 — 逆編集後の結果観測

失敗後のOwner-reviewed `recovery_edit`候補を、単独の逆編集で終えず、同じsandbox・相対path・復元対象文字列を使うread-only `file.search`へ接続した。検索stepは逆編集stepに依存し、別のJ step審査後に実行される。Control Centerでは依存する検索を「編集後確認候補（file.search）」と表示する。逆編集の自動実行、test再実行、自動再復元は加えていない。

`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`と`packages/channel-webchat/src/control_center_script.ts`を変更。core／channel-webchat typecheckとbuildはPASS、`git diff --check`はPASS。test／Gateway process／browser／実provider／外部作用はNOT_RUN。STATUS=WIRED（候補planと表示のコード接続、runtime未確認）。F01.03全体、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

**次のproducer／consumer:** 同一taskの非0終了／確認済みtimeout後に、保存済み検索結果のOwner選択から逆編集候補、現行版Content Review、L3 Approval／Broker、M receipt、依存する編集後確認検索とOwner返信までが隔離Gateway runtimeで連なること。既存のtest未実施条件を維持する。

#### 2026-11-01 F01.03 BUILD境界補強 — 逆編集候補の検索件数上限

失敗後の逆編集候補へ渡すverified `file.search`観測について、既存の「1 file」の条件に加え、実consumerの`max_results=5`と同じ上限を候補化前にも適用する。1〜5件・1 file以外の観測からsynthetic C候補を作らない。これは入力境界の補強であり、失敗の意味・現在状態・目的達成・編集許可を増やさない。

`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`を変更。core typecheckと`git diff --check`はPASS。test／Gateway runtime／browser／実provider／外部作用はNOT_RUN。STATUSは既存のF01.03接続を維持し、実processでのowner選択からOwner返信までの疎通は未確認。
