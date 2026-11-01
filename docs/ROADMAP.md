# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

2026-11-01、Control CenterのWebSocket再接続枠を成功接続ごとに回復するよう修正した。再接続成功後に失敗回数を0へ戻し、自動再接続であることは接続試行のローカル値で保つ。taskの再送・切断中frameの再配送は行わない。channel-webchat typecheck／build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。browser／Gateway process確認はNOT_RUN、STATUS=WIRED（静的接続、実接続未確認）。

2026-11-01、Gateway再起動後の同一plan `plan:result` consumerへverified `file.write`／`file.delete`保存結果のdigest／M receipt束縛要約を追加した。writeは相対path・byte数のみ、deleteは相対path・削除時点の報告のみを返し、本文・sandbox絶対root・現在状態を返さず再実行もしない。HDS-BRAIN／Gateway typecheck・build、`pnpm docs:check`、`git diff --check`はPASS。process／browser／test suiteはNOT_RUNで、STATUS=WIRED（コード接続、runtime未確認）。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

2026-11-01、F01.01のOwner指定`file.edit`候補に完全一致する置換数（1〜100、初期値1）を通した。Owner入力、synthetic C parser、Operation Plan parameters／validationを結び、実一致数の不一致は既存toolの実行前照合で拒否する。従来の置換数なしtaskは1として扱う。core／channel-webchat typecheck・build、生成Control Center script構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／browser／Gateway runtime／実provider／外部作用はNOT_RUN。STATUS=WIRED（静的接続、runtime未確認）。

2026-11-01、Control Centerの保存結果consumerをverified `file.write`／`file.delete`にも表示するよう接続した。既存のowner再認証・plan/revision/step・verified binding・receipt確認条件を維持し、writeは本文／現在状態を返さず、deleteは削除時点の報告として表示する。channel-webchat typecheck／build、生成Control Center script構文解析、`git diff --check`はPASS。test／browser runtimeはNOT_RUN。STATUS=WIRED（UI接続、owner画面での実操作未確認）。

2026-11-01、保存済み`file.search`結果のowner入口を、条件に応じた最大5行`file.read` previewも含む表示に合わせた。全内容・検索完全性・現在状態を示さないことを案内。channel-webchat typecheck／build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。runtime／browser／test suiteはNOT_RUN。

2026-11-01、単一fileのbounded `file.read` previewに開始行指定を接続した。exact sandbox相対pathと空queryの組合せに限定し、開始行は1〜1,000,000、返却は最大5行のまま。候補の開始行をOperation Plan validationへ結び、返却行番号の連続性を照合する。保存済みOwner結果にも開始行を表示し、既存のroot／file version確認、Approval／Broker、M receipt、非権威projectionを維持する。実装初回のworkspace `pnpm typecheck`／`pnpm build`はPASS。controller promptの最終追記後はHDS no-emit typecheck／package build、`pnpm docs:check`、`git diff --check`がPASS。workspace typecheck再実行は`apps/gateway/dist/active_task_execution_registry.js`の削除時`EBUSY`でclean段階停止。test／Gateway process／browser／provider／外部作用はNOT_RUN。STATUS=WIRED（型・build・実consumer接続の静的確認）、runtime未確認。F01.01、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。

## 現在のBUILD_BATCH

2026-11-01、E2E-01の合成Owner経路を限定実行で確認した。file.deleteではOwner内容確認前のL3承認が拒否され、確認後に対象が変わるとstale拒否され、再確認・L3承認後は隔離temp root内のfixtureだけがBroker経由で削除され、WebChat結果とverified/M receiptまで確認できた（Gateway process test 1件PASS、同fileの他5件はskip）。owner指定相対pathのread-only file.searchも隔離Gateway process test 1件PASS（同fileの他6件はskip、21.6秒）し、同語decoyの除外・verified/M receipt・Owner結果返却・両file不変を確認した。長いOwner統合testも再実行し、目的変更の審査、Jへの確定、保存結果再読込と安全なfile.edit→file.search fixture経路を含む選択test 1件PASS（197秒、同fileの他5件はskip）。HDS-BRAIN／core／Gateway build、Gateway typecheck、`pnpm docs:check`、`git diff --check`もPASS。実provider・live外部作用なし。確認したのは限定synthetic runtime経路であり、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、5OS証拠、owner GOは未成立。次はこの証拠を含めてBUILD_BATCHを継続し、残る通常Owner仕事の未接続consumerを現行rev3.0から選定する。

2026-11-01、失敗後の`recovery_edit`候補planに、逆編集stepへ依存する同じsandbox・相対path・復元対象文字列のread-only `file.search`を追加した。Control Centerでは「編集後確認候補（file.search）」と表示し、実編集・確認検索は別step審査のままとする。core／channel-webchat typecheckとbuild、`git diff --check`はPASS。test／Gateway process／browser／実provider／外部作用はNOT_RUN。STATUS=WIRED（候補planと表示のコード接続、runtime未確認）。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。次はtimeout／非0終了からOwner確認・L3・編集後検索までのruntime consumerが残る。

2026-11-01、`file.delete`の認証済みno-store Owner確認を既存L3 Approval／Broker経路へ接続した。Owner画面はsandbox相対path・対象サイズ・上限・対象版digest・Operation Plan束縛digestを確認操作後にだけ表示し、本文は表示しない。未確認承認をGateで拒否し、approval時と実行command作成直前に対象版を再照合して、Brokerも作用直前に同じ版を確認する。core／WebChat build、Gateway typecheck／build、生成Control Center script parse、`git diff --check`はPASS。Gateway process／browser／test suite／実ファイル削除はNOT_RUN。STATUS=WIRED（コード接続）だがruntime consumerは未確認。次は使い捨てrootの専用fileでOwner表示・stale停止・既存削除consumerを限定確認する。E2E-01全体、製品全体BUILD、QE_QC／QE_QA、owner GOは未成立。

2026-11-01、合成Cからowner指定の単一sandbox相対pathに対する`file.delete`候補計画を生成する入口を追加した。secret-like／絶対／traversal等のpathを拒否し、候補は単一file・最大256,000 bytes・high／L3 final review・Approval／Broker必須とする。実削除は行わず、既存toolのsandbox・通常file・対象版再照合を維持する。`@blue-tanuki/core` typecheckはPASS。Gateway process／Broker実行／test suiteはNOT_RUNのため、実consumerの実行は未確認。次は使い捨てroot内のtest専用fileに限定してOwner表示から既存削除経路までの接続を確認する。

2026-11-01、E2E-01の限定synthetic owner taskを動的なfilename／本文でWebChat入口から実行した。create-only `file.write`、J審査・Approval／Broker、M receipt、Gateway再起動、同一taskの`file.search`、二度目の再起動後の保存結果読取まで、Gateway process test 1件を選択してPASS（同fileの他4件はpattern skip）。Gateway package typecheck／build、`pnpm docs:check`、`git diff --check`もPASS。対象taskの実provider呼出しはなく、このtask経路を`WIRED`とする範囲に限る。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、Rust cutoverは未成立。次のBUILD_BATCHは現行rev3.0の施工順と最新実物から、次の未接続な通常Owner仕事のproducer／consumerを選ぶ。

2026-11-01、F01.03の同一Workspace境界を接続した。Settings UIから任意の`BLUE_TANUKI_SHELL_ROOT`を設定でき、File sandbox rootと同じパスを選べる。通常のshell実行条件は変えず、`same_workspace_as_file_root=true`を要求するshell operationだけ、Broker審査時と起動直前に実resolveしたFile／Shell rootが一致することを必須にした。設定保存・解除、root不一致拒否の限定test 3件とGateway／core typecheckはPASS。実process、編集後test、再読取、失敗時復帰は未接続／未実行でF01.03全体は未成立。次は同じrootで既存審査済みdiff後のtest・再読取をGUIへ戻すconsumerと、失敗時の新規owner-reviewed recovery editを接続する。
2026-11-01、F01.03の隔離test consumerを限定接続した。`file.edit`／`shell.exec`／`file.search`のtool説明へ明示依頼・owner審査・同root・再読取・自動復元禁止の順を反映し、`shell.exec`に`summary_only`を追加した。同一Workspace指定時は省略／falseをtarget review前に拒否し、captured stdout／stderrを返さずexit status・text byte数／SHA-256・process終了状態だけをC／UIへ返す。Windows AppContainer process testで、same-rootの一file read、exit code 0、process tree empty、本文非露出とsummary省略のpreflight拒否を確認。core／Gateway typecheck、core build、target test 1件PASS。WebChat full cycleと失敗時の新規owner-reviewed recovery editは未確認で、F01.03全体および製品全体BUILDは未成立。次は同一taskのfile.edit→shell.exec→file.searchをGateway processへ接続する。

2026-11-01、F01.03の同一task Gateway／WebChat往復を限定接続した。開発専用synthetic taskでOwner審査済み`file.edit`→L3審査済みsummary-only同一Workspace `shell.exec`→同じ相対pathの`file.search`を実行し、再読込結果を`plan:result`でOwnerへ返した。Gateway process test `BT-U-C08.01-P-E2E`は1件PASS、同fileの他4件はpattern skip。`pnpm typecheck`、全workspace `pnpm build`、`git diff --check`もPASS。実provider呼出しは0件。確認したのはexit code 0の合成task成功経路のみで、非0／timeout実行、試験失敗後の新規owner-reviewed recovery edit、F01.03全体、製品全体BUILD、QE_QC／QE_QA、5OS実機は未成立／NOT_RUN。次は自動復元を行わず、現行対象版のowner再審査と新規逆編集承認を通す回復consumerを接続する。
2026-11-01、failed test後の回復consumerを接続した。same-workspace summary-only `shell.exec`の投影はexit code／signal／timeout／process-tree状態に限定し、非0 exitと同一planのM receipt確認済みfile.searchが揃う場合だけWebChatにowner選択の逆編集候補操作を示す。synthetic Cは同じparent task identity／revisionの検索観測がある場合に限り、逆向きの単一`file.edit`候補を返す。自動復元なし。新候補は現行版のContent Review／target version再照合／L3 Approval／Brokerを要する。HDS／Gateway／core／WebChat no-emit typecheck、生成Control Center script構文確認、`git diff --check`はPASS。実process／browser／testはNOT_RUNのため実consumer動作は未確認。STATUS=WIRED（コード接続）、F01.03全体と製品全体BUILD／QC／QAは未成立。

2026-11-01、F01.03のfailed test後回復候補に、process tree emptyを確認した明示的timeoutを追加した。timeoutでは部分作用の可能性を表示し、同一planのM receipt確認済み`file.search`で現状を見た後に限ってowner選択候補を提示する。候補生成は未実行で、新しいContent Review／対象版再照合／L3 Approval／Brokerが必要。中断・不明な終了状態・process tree未確認は対象外、自動復元なし。channel-webchat typecheck／build、`git diff --check`はPASS。script構文解析／Gateway process／browser／testはNOT_RUN。STATUS=WIRED（静的接続、実consumer未確認）。次は同一taskのtimeout後回復consumerを合成Gateway runtimeで閉じる。

2026-11-01、回復候補の根拠をHDS側でも照合するよう接続した。file.searchの観測へ、同じplan内の`file.edit`→summary-only同一Workspace `shell.exec`→同pathの`file.search`、shell→検索の依存、shell結果のM receipt、非0終了またはprocess tree emptyを確認したtimeoutだけをdigest付きで付与する。synthetic Cはこの証拠がない逆編集候補を拒否し、raw output／command／pathは受け取らない。protocol／HDS build、core／Gateway／WebChat typecheck、`git diff --check`はPASS。test／Gateway process／browser／実provider／外部作用はNOT_RUN。STATUS=WIRED（HDS証拠照合のコード接続、実consumer未確認）。次はtimeoutと非0終了の合成Gateway runtimeで回復候補から新規L3編集、M receipt、Owner返信まで閉じる。

2026-11-01、owner task受付後の状態照会欄が未送信の次回IDを選ぶ欠陥を修正し、受付済みIDを選択するよう接続した。WebChat typecheck／buildはPASS。

2026-11-01、動的taskのfilename／一行本文が実Gateway経路のfile.write planへ届くことを、file内容の一致で確認した。二度のGateway再起動を越えて同一task identity、verified write／search receiptを復元し、保存済み検索結果を`plan:result`で読んだ後もfileは一件のまま。これは限定synthetic taskの実経路証拠であり、独立した一般Cや製品全体の成立を示さない。

2026-11-01の前batchでは、Tasksのowner task受付状態からrequest ID一致plan、同一`task_identity_digest`の計画件数、依頼一致plan stepのM receipt状態を既存の非権威Runtime projectionで表示する接続を追加した。WebChat対象テスト1件、package typecheck／build、`pnpm docs:check`、`git diff --check`はPASS。表示上限・step省略・不正bindingは未確認とし、完了や権限へ昇格しない。E2E-01全体と製品全体BUILDは未成立。

2026-11-01、verified `file.search`結果からownerがsandbox相対path・置換前後を明示し、同一taskの未実行`file.edit`候補を作るControl Center consumerとsynthetic C受け口を接続した。保存済み検索本文を自動添付せず、選択observationはdigest／件数のみとする。synthetic Cは親のexact `file.read`またはpath-bound `file.search` path、現行plan／revision／task identity、期限内のverified observationとの一致を候補生成前に確認する。core／WebChat／HDS no-emit typecheckと生成script構文解析はPASS。build／test／Gateway process／browser／providerはNOT_RUNのためruntime未確認。次consumerは実差分のowner確認から既存L3 Approval／Broker、receipt／M、結果返信まで。E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

#### 2026-11-01 E2E-01 BUILD — sandbox内の単一ファイル検索

`file.search`へsandbox内相対`file_path`を指定する経路を追加した。directory全体検索は従来どおり維持し、単一ファイル検索では1 MiB上限、symlink・path traversal拒否、承認時のpath digestと内容digest再照合を行う。これにより合成file.write後の同一task再計画が、sandbox内の他ファイル数に依存しない候補を作れる。Protocol／HDS-BRAIN／core（Windows isolation含む）／Gateway package buildとtypecheck、`git diff --check`はPASS。runtimeとtestはNOT_RUNのため`CODE_PRESENT`に留まり、E2E-01や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### E2E-01 接続単位 — WebChat結果から同一taskの再計画候補まで

`/owner/task-compute`のhandler失敗時はtask本文・例外詳細・目的・credential・HDS commitを含まない固定`error` status frameを返信先へbest-effort通知し、handler未接続時は受付前に503で拒否する。またControl Centerは`channel_send`／`error`結果frame受信後、runtime tokenが入力済みなら`/runtime/snapshot`を再読込し、計画一覧を更新する。owner tokenで作成されたplanのstep審査・保存結果読取・結果不明receipt照合は、同一plan/revisionを付けたowner専用`/owner/inbound`へ接続済みである。現在の目的版・結果観測・task identityを入口および候補保持時に再照合し、未実行候補を既存step審査・Approval／Broker経路へ渡す。親task contextとresult observationのprovider露出分類は別にし、alternate providerは両sourceを明示許可した場合だけ使う。owner tokenのDeveloper operator経路は既存wait／resume限定を維持し、HDSの権限・L3／Approval／Broker判定は変更しない。失敗statusは非権威の運転状態であり、HDS判断・最終出力・Approval・実行receiptではない。通知は接続中WebSocketへのbest-effortまでで、切断後の永続再配送・Approval queue自動更新・runtime token未入力時の自動更新は未接続。2026-11-01のWindows隔離Gateway process testでは、既存M digest-only file-state観測のowner選択再利用から、同一task read-only `file.search`候補の審査・L3・Approval／Broker・receipt／M・WebChat保存結果返信まで3回PASS（各1 selected、他4件pattern skip）。その前の同一test 1回は初期synthetic review返信待ち15秒でtimeoutし、タイミング変動は未解消。同じcommand／evidenceの重複登録だけを既存観測の限定再利用へ変え、単回permit、fresh receipt照合、新規状態読取、元writeの結果不明を維持した。workspace `pnpm build`、HDS-BRAIN no-emit typecheck、`pnpm docs:check`、`git diff --check`はPASS。workspace `pnpm typecheck`は古いHDS `dist/output_audit.js`へのOneDrive `EBUSY`書込失敗でFAILし、その後script clean後のworkspace buildはPASS。実provider・外部作用は未使用。全体の目的→C→J→安全な合成Approval／Broker作用→receipt→M→結果返信→再計画・復帰、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立のまま。

先行するowner task再起動の実process evidenceは下記「2026-11-01 E2E-01 owner task再起動照会」に記録する。`handler_returned`済みのowner taskはGateway再起動後も同じsubmission ID・request IDで照会でき、Runtime plan digestも一致した。同じtaskの再送は受付済みとして閉じ、provider呼出しは増えなかった。追加の強制終了試験では`dispatching`中にGatewayを停止・再起動し、`outcome_unknown`への遷移と同一ID再送拒否を確認した。10月31日の実WebChat相当file.write→同一task file.search証拠は次節に履歴保持する。実provider／実LLMは呼び出していない。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### 2026-11-01 E2E-01 owner task再起動照会

Windows隔離合成Gateway processで、L3目的変更審査を通過した合成目的に紐付くowner taskを受け付け、完了後にGatewayを再起動した。owner status APIは同じsubmission IDに対して同じrequest IDと`handler_returned`をno-storeで返し、再送は`already_accepted`、合成provider追加呼出しなしで閉じた。Runtime snapshotは復元readyで、request ID digestに一致するplanが1件存在した。対象process test 1件とGateway typecheckはPASS。テストの所有する一時stateは終了時に回収。providerは合成端点のみ、tool作用なし。

証拠範囲はhandler完了後の再起動回復に限る。`dispatching`中のprocess killと`outcome_unknown`表示・再送拒否、ブラウザー再起動からのUI操作は未確認。別の既存大型Gateway integration testでは、owner選択済みfile.write状態からの再計画が`plan_control_denied:plan_compute_source_observation_authorization_failed`で拒否され、同一task file.search候補が作られなかった。再確認／認可失敗の根因は未特定である。したがってこのsliceはE2E-01全体や`SYSTEM_SHAPED`／`BUILD_COVERED`を示さない。

### 2026-11-01 E2E-01 dispatching中のGateway強制終了回復

隔離Windows Gateway processで合成provider要求を保留し、owner taskが`dispatching`の間にGatewayを強制終了した。再起動後、耐久status APIは同じsubmission ID／request IDに`outcome_unknown`をno-storeで返し、同一submission ID・payloadの再送を409 `owner_task_submission_outcome_unknown`で拒否した。合成provider呼出し数は増加せず、dispatch中taskを自動再実行しないことを確認した。対象process test 1件PASS（同fileの他4件はpattern skip）。実provider／外部作用／tool作用なし。

この証拠はGateway inboxのcrash recovery・同一ID再送拒否までである。実ブラウザー再起動後の照会操作、実provider、owner taskの最終結果・E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは示さない。次は同じtask identityを保ったままcommand intent、execution receipt、M receipt、plan dependencyの既存consumer接続を進める。

### 2026-11-01 E2E-01 browser再起動後の再送防止UI

Control Centerは保存済みの最新`submission_id`を送信IDとして復元し、status照会前の別ID切替を出さない。現在の依頼IDについてGateway受付状態とRuntime相関を確認してから専用操作を表示する（Gatewayが明示した`rejected`は非dispatch状態としてstatus確認後に切替可能）。照会ID選択、owner token、Runtime tokenを変更すると表示を無効にして再確認を要求する。明示切替時は新UUIDをsession/localStorageへ保存する。依頼本文・結果・tokenの永続化、再送・再配信・外部作用は追加していない。

WebChat package typecheck/build、生成`CONTROL_CENTER_SCRIPT`構文解析、`pnpm docs:check`、`git diff --check`はPASS。`docs:check`では日本語基底移行負債76件の既存注意を確認。実ブラウザー再起動とGateway `dispatching`中のprocess killはNOT_RUN。詳細は`docs/IMPLEMENTATION_INSTRUCTIONS.md`の同日BUILD記録を参照。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### 2026-11-01 E2E-01 owner選択済み状態観測の再利用

前回のowner選択再計画拒否を対象Gateway process testで再現し、`recordExternalReceiptObservation()`は同じcommand／evidence digestが既に保存済みの場合に`null`を返すこと、その重複を呼出元が認可失敗として誤分類することを原因として修正した。Jは単回permitを消費し、最新receiptを再照合し、新しいsandbox状態を読み取る。既存観測が同一plan／revision／step／commandと一致し、digest・時刻の再照合を通過する場合だけ既存の耐久記録を再利用する。新しい観測記録・権限・作用は発生させない。

隔離Gateway process testは3回PASS（各1 selected、他4件pattern skip）。その前の1回は初期synthetic review返信の15秒waitでtimeoutし、タイミング変動は未解消。結果不明file.writeの再実行なしにowner-selected observationからread-only search候補を作り、L3関係確認、owner step審査、既存Approval／Broker、execution／M receipt、WebChat結果返信まで通過した。実provider・外部作用は未使用。`git diff --check`、workspace `pnpm build`、HDS-BRAIN no-emit typecheck、`pnpm docs:check`はPASS。workspace `pnpm typecheck`は古いHDS `dist/output_audit.js`書込み`EBUSY`でFAILし、その後clean後のworkspace buildはPASSした。E2E-01全体、製品全体BUILD、QE_QC／QE_QA、owner GOは未成立。

### 2026-10-31 E2E-01 現行接続点

Windows上の隔離合成Gateway実processで、固定4役割delegation、目的関係のowner L3審査、同一plan/revisionのstep審査、HDSによる選択済みcommandのtool区分、既存process policy／Approval Gate／Broker、create-only file.write、検証済みM receipt、WebSocket replyまで接続した。receiptを根拠にした同一task read-only file.search候補は、owner L3関係確認・step審査後にBroker workerで検索し、完全一致検証とM receipt確認を通過した。ownerの保存結果returnは再検索を行わず、保存時点・検索完全性不明の注意を付けてWebChatへ返した。対象test 1件PASS、他3件はpatternで未実施。provider呼出しなし、作成物はtestの一時file rootに限定しcleanup済み。HDSの一般chat／候補入力はtool権限を得ず、L3／Approval／Broker境界は維持されている。

この限定synthetic経路はE2E-01全体の完成ではない。次はowner選択済みlocal file-state observationの再計画前認可失敗を根因まで追い、Gateway receipt再照合・単回観測permit・digest-only M保存・同一task identityを保って未実行候補へ接続する。その後owner taskの`dispatching`中にprocessが失われた場合の`outcome_unknown`と再送拒否、既存writeの重複防止、command intent・execution receipt・M receipt・plan dependencyの再照合を進める。全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、OS別QA、owner GOは未達。実provider／公開／外部作用なし。

### 直近の過去BUILD_BATCH記録

CR-0/I-06の安全割込みとしてWindows開発用`install.ps1 -Force`に既存install rootの所有確認を加えた。markerが現在のinstall root／data rootの双方に一致する形式を優先し、marker欠落時は既定rootにあるBLUE workspace manifest・runtime／installer入口・env file存在・両rootへ結び付く生成済みlaunchersを確認できる従来導入だけを認識する。途中のreparseや識別不一致、custom rootは削除前に拒否し、既存DataRootを再帰削除しない。実Windowsでの非破壊拒否確認と従来導入からの更新確認は未実施（`NOT_RUN`）であり、動的安全性は未成立のまま記録する。これはK-B5の合成shadow BUILDを止める理由にはしない。

K-B0／K-B1で現行入口、通常・復旧writer、I-01対象guard、I-03 main appから通常Computeへのbudget設定を照合・接続した。E2E-01とK-B2では、合成仕事のC→J→L3→M→次task再評価を限定接続し、meaning-update専用J/Mを7-store復旧経路へ接続した。これらは部分経路の証拠であり、製品全体の結合形状を示さない。

K-B3ではC候補評価を`meaning_update_candidate.ts`、承認済み候補からM record／interpretationを作る純粋処理を`meaning_update_semantics.ts`へ、解釈JSON正規化・検査・content digestを`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在Mと検証済み監査履歴から再評価候補を導出する意味処理を`memory_judgment_reassessment_candidate.ts`へ移した。controllerが監査・現在Mを取得し、Approval Gate／L3／監査書込／J-M writerはTypeScript HDS-BRAINに残る。HDS focused 3 files／5 tests、HDS typecheck/build/standalone、Gateway typecheck/buildはPASS。Gateway process smokeは前バッチでhealth readyに至らず統合実行未確認。今回の抽出で新しい利用者仕事や全体`SYSTEM_SHAPED`／`BUILD_COVERED`は成立しない。K-B3全体の責任抽出完了、C08.03、OD-03、他repo変更、P13 GOは未成立／保留。

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続を行い、K-B5では数値policy採否・rule provenance・purpose binding・SUSPEND後の人間復帰に加え、GatewayのL3承認後に発生する二種のM更新遷移と残差集計を同じRust実processへ接続している。HDS controllerはTypeScript commitのdecision・reason・triggered thresholdを通常policy評価と照合し、同じ出所と確認できる場合だけscore／weight／lifecycle／thresholdを固定小数点化してRustへ渡す。Rustは独立評価した結果を非権威receiptへ返す。保存時の`DecisionLog.goal_purpose_binding`と`GoalGovernanceLedger.project()`から別途取得した現在の目的版・digestをRust shadow projectionへ載せ、Rustは保存版と現在値を照合して鮮度状態を非権威receiptへ返す。今回、meaning adoption時のcurrent-M参照レビューを上限512の件数・検証数と固定scope／target状態へ縮約して同じshadowへ接続し、Rustが件数・claim・scope digest・review statusの組合せを独立分類する。運転receipt／logには比較真偽値だけを出し、参照ID・候補文・集計数は出さない。現行projection schemaはv12、request contractはv7。

最新consumer差分では、Gateway observerがM遷移receiptをTypeScript分類と完全一致させてから受理する挙動を改めた。receiptの型・適用軸とのnull可否・内部lifecycle整合を検証しつつ、参照レビュー／M revision／遷移／残差のRust分類差を軸別の真偽値として保持し、総合結果を`mismatched`へ反映する。ログに追加したのは固定軸名と真偽値だけで、M本文・参照ID・集計数は含めない。Gateway typecheckと`git diff --check`はPASS。test・Rust実process・Gateway統合smokeは未実施（NOT_RUN）。これはK-B5 shadow consumerの比較差分を観測可能にする接続であり、Rust authority／M writer、K-B5全体比較、製品全体BUILD、QE_QC／QE_QA、cutoverは未成立のまま。

今回のBUILD差分で、meaning adoptionのcurrent-M参照レビュー要約をL3 commit結果からRust shadow consumerまで接続した。実Mデータの参照ID・candidate／本文は投影せず、件数・検証数・scope一致・target一致・claim状態だけを渡す。Rust processは上限と状態組合せを独立照合し、整合真偽値をreceiptへ返す。Gateway logも真偽値だけを保持する。通常Gateway serve上の合成L3 process smokeでmeaning adoption 2件の照合一致、judgment reassessment 1件の非該当、および不整合検証数の`mismatched`を確認した。HDS controller／shadow IPC 82 tests、Rust 4 tests、Gateway observer 5 tests、Gateway M smoke 1 test、HDS／Gateway typecheck・build、Rust check／fmtはPASS。これは参照構造のlimited shadow比較のみで、意味関係は`not_assessed`、Rust `hold`、no-effect／no-M-writeを維持する。C08.03実provider、外部作用、他OS証拠、製品全体BUILD、QE_QC／QE_QA、single-writer cutoverを成立させない。

直近のBUILD差分で、L3後のM遷移比較に`MemoryUpdateReceiptV1`の実`previous_revision`／`revision`を接続した。Rust shadowは適用時の1段増分を独立比較し、版飛びを不一致として分類する。未適用はrevisionを明示的`null`とし、冪等再送で新receiptを得ない場合に版を推測しない。Gateway observerはrevisionとtransition／residual／lifecycleのreceipt整合を再検査する。通常Gateway serveを通る合成L3 smokeで意味採用2件・引用再評価1件の実receiptから各1段増分を確認した。HDS/Gateway typecheck・build、HDS controller 78 tests、Rust 4 tests、Gateway observer 3 tests、Gateway M smoke 1 testがPASS。これはM commitの版遷移だけの比較証拠であり、M内容の意味評価、K-B5全体意味比較、single-writer cutoverを成立させない。Rustの操作判断は`hold`、作用・M正本書込みなしを維持する。

今回、L3 memory transitionのowner `reject`／`block`と承認後`not_applied`も同じRust shadow系列で照合する合成ケースを、既存Gateway observer process fixtureへ追加した。meaning-updateとjudgment reassessmentそれぞれのreject／block／approve-not-appliedで、owner verdict・M適用状態・残差・lifecycleを実Rust process receiptと照合しPASS。HDS／Gateway typecheck、Rust `cargo build`／`cargo test --locked`、HDS shadow IPC process、Gateway shadow observer process、`git diff --check`もPASS。fixtureは合成projectionを直接shadow consumerへ渡す限定確認で、Gateway `serve`上の実owner/L3操作や実M適用を通した証拠ではない。TypeScript authority、M writer、Approval Gate、実行権限は変更していない。K-B5のJ/M全体意味比較、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは引き続き未成立。

今回の実consumer修正では、Gateway observerがmemory transitionのreceiptから遷移一致・残差状態・lifecycleを元projectionより再計算して照合するようにした。相互に矛盾するreceiptは採用せずobserverをfail-closeする。今回のコード確認はHDS／Gateway typecheck・build、Rust `cargo check`、`cargo fmt --check`、差分空白検査がPASS。テストおよびこの差分のRust実processは未実行。先行する実process・test結果は先行commitの証拠としてのみ保持する。

続くBUILD差分では、ownerがapproveした後のmeaning-update／judgment reassessmentも、直前のstale再照合またはcommit APIの明示的`ok:false`でMが適用されなかった場合をshadowへ投影した。`approve`と`memory_application_status=not_applied`を分離し、meaning updateは`adoption_approved_not_applied`、再評価は未再評価数を全件残す。Rust parserとGateway observerが適用状態・残差を再計算して照合する。例外送出は部分commit後の可能性を排除できないため未分類のままにし、未適用として記録しない。projection schemaはv9。HDS／Gateway typecheck・build、Rust `cargo check`／`cargo fmt --check`、`pnpm docs:check`、`git diff --check`はPASS。test・Gateway/Rust実processは未実施。Rustは`hold`、no-effect、no-M-writeのままである。

今回、purpose-bound computeのdigest-only bindingを`DecisionLog`へ記録し、SUSPEND／resume記録へ引き継いだ。承認済みmeaning-updateのcontent-review／commit audit markerはsource DecisionLog hashとpurpose bindingを持ち、recovery／replayは唯一のASSERT source recordと照合する。M record v1と意味digestは維持する。HDS／Gateway typecheck・buildはPASS。テスト、Rust変更、実processは未実施。これは監査上の出所連結であり、目的適合やRust authorityを成立させない。

Rustの`decision`は常に`hold`、作用権限・M正本writerなし。HDS Jのplan step採用記録を、選択commandに一致するstored bindingから取得し、ローカルでassessment digestを検証した後、目的review／criterion状態と上限64のrelation件数だけに縮約してRust shadowの同一系列へ渡すコード経路を追加した。文章・ID・purpose／criterion／assessment digestはRustへ渡さない。Rustは採否に関係する状態・件数の整合を独立分類し、Gateway observerはnested receiptと比較statusを再照合して非権威ログへ返す。旧checkpoint記録欠落は`not_comparable`、plan未選択は`not_applicable`。全体statusは不一致を優先し、比較可能な全軸の一致時だけ`matched`とする。現行目的台帳または選択済みplan記録が比較不能なら`not_comparable`を返す。この経路は`WIRED`。observer試験で実Rust processのmatched／意図的不一致receiptを確認した後、Gateway process smokeで通常WebChat inbound→選択済みplan→Rust shadow receiptの`matched`を確認した。local fake provider・隔離state・一時file rootを使い、本文・request／plan／step ID・pathがreceiptへ出ないことを確認し、file.deleteはtest専用L3承認後に一時root内だけで実行・観測した。HDS／Gateway typecheck・依存buildとprocess smokeはPASS。smokeが検出した`source_decision_binding`の承認context欠落を修正し、J/M stageで同じ束縛を再検証する。K-B5のJ/M全体意味比較、`RUST_SHADOW_WIRED`／single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。C08.03、OD-03、他repo変更、P13 GOも保留する。

最新のGateway observer修正では、Rustのplan adoption receiptをTypeScriptの同じ採否分類と厳密一致させて停止する挙動を除いた。receipt構造、projection echo、Rust内のstatus／matches整合は引き続き検証し、意味分類差は双方の値を非権威ログへ残して総合`mismatched`として観測する。Rust側総合statusはRust receiptから再計算して照合する。HDS／Gateway typecheck・build、Rust `cargo check --locked`／`cargo test --locked`（4件）、HDS shadow IPC（3件）、Gateway observer（3件）、Gateway合成L3／plan採否process smoke（1件）、`pnpm docs:check`がPASS。smokeはlocalhost fake provider・隔離state・一時file rootを使用し、test専用L3承認後のfile.deleteも一時root内に限定した。実provider・実外部作用・全workspace suite・QE_QC／QE_QA・5OS実機の証拠ではない。K-B5全体比較、製品全体BUILD、QC／QA、cutoverは未成立。

続くobserver process fixtureでは、ASSERT／FAIL／SUSPEND／OUT_OF_SCOPE、approve resume、L3 M遷移、選択plan採否を同じRust sessionへ順に送り、sequence 18のplan receiptまで確認した。Gateway observer process 5 testsとGateway typecheckはPASS。合成projectionの同一consumer系列の証拠であり、Gateway `serve`全経路・実M適用・plan分類の実装間status差は確認していない。

今回、HDS-BRAINが既に確定した自己健全性fail-safe `SUSPEND`をRust shadowへ限定投影するconsumerを接続した。projection v11／request v6では失敗条件名・根拠・入力本文を除外し、失敗件数と実行禁止／非権威の固定値だけを渡す。Rustは単一の`self_health`停止軸、その重みと閾値、gate形状を検証して同じ停止を再判定し、運転判断は`hold`のまま維持する。Windows上の実Rust processで一致receipt、不正件数／重みの拒否、停止時の無作用・no-M-writeを確認した。HDS controller／shadow IPC 82 tests、Gateway shadow observer 4 tests、Rust `cargo test --locked` 4 tests、`cargo fmt --check`、HDS／Gateway typecheck・build、`pnpm docs:check`、`git diff --check`はPASS。fixtureは合成入力で、実provider・外部作用・他OS実行の証拠ではない。これはfail-safe停止の比較consumer接続を示すだけであり、K-B5全体意味比較、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAを成立させない。

続いて、通常Gateway decisionのRust shadow J判定とTypeScriptが実際に生成した`ExecuteCommand`の有無をobserverのconsumerで照合する接続を追加した。RustのJ判定とcommand有無が食い違う場合は、authority経路を止めず`mismatched`として記録する。今回の`git diff --check`はPASS。test、typecheck、build、実process、docs検査は未実施（NOT_RUN）。Rustは引き続き`hold`、作用・M正本書込みなし。K-B5全体意味比較とsingle-writer cutoverは未成立。

今回、通常Gateway decisionでcommand有無不一致をRust receiptの`lifecycle_matches`へ混ぜず、`command_presence_matches`として独立して記録するようにした。不一致は引き続き非権威の`mismatched`として観測し、HDS authority・実行経路・M writerへ影響しない。合成入力による実Rust process observer試験5件とGateway typecheckがPASS。全workspace suite、実provider・外部作用、QE_QC／QE_QA、5OS実機は未実施。K-B5全体比較・cutover・製品全体BUILDは未成立。

今回、ownerがapproveした後に非常停止が有効でM適用されなかったmeaning adoption／judgment reassessmentを、Rust shadow observerへ接続した。Gateway通常serveの合成L3 process smokeで両停止枝を通し、owner verdict `approve`を保ったままM未適用・revision不変・再評価対象全件残存となること、停止解除後に再発行tokenで両M更新を完了することを確認した。Rust shadowの5 memory-transition eventはすべて`matched`。対象Gateway smoke（1 test）、Gateway typecheck、`pnpm docs:check`がPASS。外部LLM／外部作用は未使用。K-B5全体意味比較・cutover・製品全体BUILD・QE_QC／QE_QAは未成立。

続くGateway consumer確認では、Windows上の実Gateway processへ合成の停止入力を送り、実WebSocketで返された一回限りresume tokenを使って`/resume`のowner rejectを通した。Gateway observerは実Rust processのresume receiptを`matched`として記録し、receiptにrequest ID・token・入力本文が出ないこと、provider呼出し数と外部作用が増えないことを確認した。対象Gateway smokeとGateway typecheckはPASS。これはreject resume一経路の接続証拠であり、approve後の実行、K-B5全体比較、製品全体BUILD、QE_QC／QE_QA、single-writer cutoverの証拠ではない。

続くobserver consumer差分では、plan step adoptionのRust receiptとTypeScript分類が一致したかを`plan_step_adoption_classification_agrees`へ独立出力し、両実装が同じ不採用判定を返した状態と分類差を運転ログで区別可能にする。値は非権威であり、HDS判断・実行・M書込みは変更しない。typecheck/build/docs検査を実施し、test・Rust実processは未実施（NOT_RUN）。K-B5全体比較・cutover・製品全体BUILDは継続する。

2026-10-31のBUILD差分では、WebChat Control Centerが読み込んだ委任目的の`purpose_version`を仕事送信時に渡し、Gatewayが現行版と照合するproducer→consumer接続を追加した。版不一致は仕事をHDSへ投入する前に409で止め、目的の再読込を案内する。目的digest・本文はUIへ出さず、旧API呼出しの版省略も互換維持する。channel-webchat typecheck、生成Control Center scriptの構文解析、`git diff --check`はPASS。test／process smoke／実providerはNOT_RUN。K-B5全体、製品全体BUILD、QC／QA、cutoverの完了根拠にはしない。

最新のK-B5 observer差分では、Rust receiptとHDS/TypeScriptが計算したreference-review／M revision／transitionの真偽値、およびresidual statusを別の非権威ログ項目として保持する。不一致を観測した際に両側の分類を読めるようにし、本文・参照ID・集計数・秘密は追加しない。Gateway typecheckとbuildはPASS。testとGateway統合process smokeはNOT_RUN。Rustは`hold`／no-effect／no-M-writeを維持し、K-B5全体比較、single-writer cutover、製品全体BUILD、QE_QC／QE_QAは未成立。

今回のplan-step adoption observer差分では、Rust receiptの`not_comparable` status／reasonをTypeScript期待分類と分けて構造検査し、双方の固定statusとreasonを記録する。reason差は`mismatched`として観測し、未知reason・receipt形状不正・projection echo不一致は従来どおり拒否する。Gateway typecheck／buildと`pnpm docs:check`はPASS。test・Rust／Gateway process確認はNOT_RUN。HDS authorityと実行経路に影響せず、K-B5全体比較、製品全体BUILD、QC／QA、cutoverは未成立。

2026-10-31、Gateway observerは受付時にRust向けwire JSONを固定し、TypeScript分類とRust process入力を同じsnapshotへ結び付けた。呼出元が`observe()`直後にprojectionを変更する合成条件でも、実Rust receiptとTypeScript分類の一致を確認した。Gateway observer 6 tests、HDS／Gateway typecheck・build、Rust 4 tests、`pnpm docs:check`がPASS。日本語基底監査の移行負債76件は既存注意として残る。これはK-B5の非権威比較入力を同一化する接続であり、K-B5全体比較、製品全体BUILD、QE_QC／QE_QA、実provider、cutoverの成立を示さない。

2026-10-31のE2E-01追加接続では、HDS commandのupstream_decision.request_idをExecutorからWebChat channel_send／owner-task failure frameへ通し、Control Centerの受理表示・結果返信を同じ依頼IDで相関した。結果返信に短い依頼ID末尾を表示し、要求ごとの運転traceを追えるようにした。値は非権威メタデータであり、判断・承認・作用・M書込みへ使わない。pnpm typecheck／pnpm build、Control Center script構文解析、pnpm docs:check、git diff --checkはPASS。test、Gateway実process smoke、実provider、実作用はNOT_RUN。この接続はE2E-01全体や製品全体SYSTEM_SHAPED／BUILD_COVEREDの証拠ではなく、同一task／目的bindingを保つ安全な合成Approval／Broker作用→receipt→M→返信→再計画／復帰を次の接続として残す。

2026-10-31、開発限定の`synthetic-file-write-plan`を通常WebChat task入口へ接続し、隔離Gateway processで目的関係L3確認、owner step審査、既存Approval／Brokerによるcreate-only `file.write`、execution receipt／M receipt、同一taskのread-only `file.search`、保存結果返信までを実行した。`document_organization_entry.test.ts`のtest helperはrepo root相対entrypointを誤解決していたため`import.meta.url`基準へ修正し、対象process testを再実行してPASS（1 selected、他3件pattern skip）。書込みreceipt確定後にGateway processを再起動し、同じplan／revision／task identity／M receiptから再計画・結果返信を継続、fileは一件のまま、test provider call 0件を確認した。workspace `pnpm typecheck`／`pnpm build`／`pnpm docs:check`／`git diff --check`はPASS（日本語基底移行負債76件は既存注意）。これは完了receiptからの再起動連続性に限る。実行中断とBroker作用後・result／M receipt確定前のcrash windowにおけるintent／outbox／dependency復旧はNOT_RUN。E2E-01全体、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA、owner GOは未成立。

2026-10-31の続きでは、owner選択済みdigest-only file-state observationを開発限定synthetic Cが同一taskの候補文脈として受け付ける条件を追加した。親plan ID／revision／task identityと`outcome_unknown`・観測専用flagを照合し、元`file.write`を再生成せず同じ対象に対するread-only `file.search`候補のみを返す。全workspace `pnpm typecheck`／`pnpm build`／`pnpm docs:check`／`git diff --check`はPASS。test suite、Gateway実processでのowner選択、実provider、外部作用、全体QC／QAはNOT_RUN。次は同一task候補のowner step reviewから既存Approval／Broker、結果/M保存、WebChat返却へ接続する。E2E-01全体、製品全体BUILD、QE_QC／QE_QA、owner GOは未成立。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
