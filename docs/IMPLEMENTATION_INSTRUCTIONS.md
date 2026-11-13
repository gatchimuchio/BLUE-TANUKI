# BLUE-TANUKI QE_BUILD指示・作業状態参照

この文書で現行指示として適用するのは先頭の「現行BUILD_BATCH」または「現在の阻害状態」節だけ。先頭に完了記録しかない場合、次の作業開始時に現行三点セットと実物から次のBUILD_BATCHを選定する。後続の前段記録は時点付きログであり、現在の作業範囲や工程順として適用しない。完了作業の詳細履歴は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) に保管する。

## 現行BUILD_BATCH — rev5.0 QE_BUILD / Gateway serve smokeの状態分離と終了確認 (P2 SAFE_MIN, 2026-11-14)

主語はrepo内の既存serve smoke runnerと、そこから起動されるGateway子processである。目的は短時間の全体疎通をstub／loopbackで行い、ユーザーの通常stateを参照せず、Gateway停止後にこの実行が生成した監査証拠を検査すること。これは製品機能の完成や全体品質判定ではない。

開始HEADは`1418247c1a79c783a540277cc43f91070f1d5cd4`。local `main`、`origin/main`、GitHub `main`、recovery current／previousが一致し、tracked差分はなかった。D4 Pocketの別repo main作業木には未commit差分があり、読み取り確認だけに限定した。

- **UNIT_ID:** rev5.0 P2 SAFE_MIN / isolated Gateway serve smoke.
- **STATUS:** CLOSED。`scripts/smoke_serve.ts`が専用Temp root内のprivate state／auditだけを使い、Gatewayが終了した場合に限って監査を読み、終了未確認ならstateを残す。
- **CHECK_SCOPE:** 初回の既存smokeは15秒以内にhealthを確認できずFAILし、inbound要求前に終了した。原因はGateway初期化時間が15秒を超えることと、旧runnerがrepo既定のstate rootを使うことだった。修正後の`pnpm smoke:serve`はPASS（`LLM_BACKEND=stub`、loopback WebSocket hello／inbound／channel_send、監査JSONL 8件、audit-dump chain valid）。`node node_modules/typescript/bin/tsc -b --pretty false`、runner単体strict typecheck、`git diff --check`もPASS。
- **EVIDENCE_LIMIT:** このsmokeはstub応答の起動・配送・監査保存だけを示す。目的達成、J/M結果帰還、D4アプリconsumer、実provider、実外部作用、installed製品、5OS、`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは確認していない。
- **LOCAL_ASSET_STATUS:** runnerの一時rootはGateway終了後に削除済み。別途作成したisolated probe rootは18 files／505,501 bytesで、Windows標準Recycle Binへ移動し格納元Tempをreadback確認した。既存`.blue-tanuki`、添付領域、untracked Linux isolation `target/`は保持。古いworktree metadataはGit pruneのPermission deniedにより変更せず保留。
- **GIT_STATUS:** implementation commit=`e7538c7f606af18e44e75ca42e5d4da2e766db96`はGitHub `main`へpush済み。docs closeout後のlocal／origin／GitHub `main`は一致し、recovery currentはcloseout HEAD、previousはimplementation commitとなるようCAS更新する。
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体施工を継続する。G09.01 Android／G10.01 iOSのD4 Pocket producer・Broker経路は別repo変更の委任待ちとして維持し、次単位ではその権限を要しないBlue内の実未接続consumerを現行sourceから選ぶ。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`前にQC／QAへ移行しない。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / D4 Runtime同一依頼の中止要求をBlue Gatewayへ接続 (P2, 2026-11-14)

主語はBLUE-TANUKI WebChat/GatewayのD4 Runtime ingress、private submission store、HDS Operation Plan、active execution registryである。目的はD4 Runtimeが自sessionの受付済み依頼に限り、実行中Executorへ中止signalを要求できるBlue側producerを成立させること。専用Bearer・登録runtime・session-scoped submissionから内部request IDを得て、D4 Runtime owner digest／WebChat channel digest／plan binding／現在のactive commandを一意照合する。callerからrequest IDやcommand IDは受けず、依頼本文・command ID・結果本文を返さない。これはP2全体施工中の一接続であり、D4アプリ側consumer、製品完成、QC／QA、公開・出荷判断を成立させない。

開始HEADは`171b04d8f6b1144ff78a6ba67bc3a5437ba52901`。開始時のlocal `main`、`origin/main`、GitHub `main`と二世代復旧参照は一致し、worktreeはmainのみ。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`を変更・削除せず保持した。

- **UNIT_ID:** D4 Runtime same-session intent cancellation ingress / P2 QE_BUILD.
- **STATUS:** CLOSED（Blue側source-level `CODE_PRESENT`）。`POST /runtime/intent/cancel`を受付・Gatewayへ接続し、一意に結び付いた未settled commandへ既存AbortSignalを送る。Settled、未登録、別session、plan／binding欠落・曖昧は拒否する。D4アプリ側からの呼出し・D4 Pocket repo変更は未実施。
- **SAFETY_STATUS:** `202`は中止要求受付とExecutor signal abortだけを示し、Executor終了・worker停止・外部処理停止を示さない。settlement監査に実際の`d4_runtime` token種別を保持する。実D4／実provider／外部作用なし。
- **CHECK_SCOPE:** `node node_modules/typescript/bin/tsc -b --pretty false`、`git diff --check`、`pnpm docs:check` PASS。WebChat cancellation endpoint対象1 test PASS、Gateway binding／registry／監査store対象18 tests PASS。WebChat `webchat.test.ts`全135件は132 PASS／3 FAIL。失敗は今回未変更のControl Center recovery scope DOM fixtureが原因（null length、HTML期待文不一致、未定義DOM value）。全workspace test suite、実Gateway＋実D4 client、全5OS、QE_QC／QE_QAはNOT_RUN／未成立。
- **LOCAL_ASSET_STATUS:** TypeScript build後のignored workspace `dist/` 14 directories／1,097 files／13,414,121 bytesを稼働中再生成物として保持。test fixtureは各testで除去済み。添付領域およびLinux isolation `target/`は保護対象として保持。
- **GIT_STATUS:** implementation commit=`2fdc70167b4844625ce4e73407f19c29b5504170`とdocs closeout commit=`1418247c1a79c783a540277cc43f91070f1d5cd4`はGitHub `main`へpush済み。終了時local／origin／GitHub `main`=`1418247...`、recovery current=`1418247...`／previous=`2fdc701...`を確認。旧Windows worktree metadata pruneはPermission denied、metadata／ACLを変更せず保留。
- **NEXT_REQUIRED_CONSUMER:** D4アプリproducer・Desktop Broker接続・切断後回復は未接続で、別repoの限定委任境界を維持する。rev5.0 P2全体施工を継続し、次単位開始時に⓪から現行指示とsourceを読み直して次consumerを選ぶ。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`前にQC／QAへ移行しない。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / GitHub Issue reopenをplan-bound L3へ接続 (F05 follow-up, 2026-11-14)

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / GitHub Issue closeをplan-bound L3へ接続 (F05, 2026-11-14)


## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Control Center初回起動のローカル認証引継ぎ (G02.02, 2026-11-14)

主語はBLUE-TANUKIのWindows／Unix launcher、managed GatewayのWebChat認証、既存Control Centerである。目的は、製品launcherからControl Centerを開いた初回に、手作業で.env内のtokenを転記せず、既存の通常GUIへ接続すること。これはP2全体施工中の初回利用consumer接続であり、G02全体または製品完成の判定ではない。

LauncherはGateway health gate通過後、loopback宛てだけに.env由来の既存WebChat／設定済み役割tokenをheaderで渡し、30秒・単回のopaque ticketを発行する。GatewayはticketのSHA-256だけを短時間保持する。ticketはURL fragmentに限ってブラウザーへ渡し、Control Center scriptは最初の通信より前にfragmentを履歴から消し、same-origin loopbackのno-store交換経路でtokenを受け取る。既存のpassword inputとsessionStorage契約へ接続し、WebChatを開くだけで接続する。owner tokenは既存owner操作用password欄へだけ設定し、sessionStorageへ保存しない。仕事本文の送信、承認、作用は行わず、既存HDS／Approval／L3経路を変更しない。

Launcherの発行通信はWindowsでproxy・redirectを無効化し、UnixではNode built-in HTTPへ専用non-proxy agentと4秒timeoutを指定する。URL・標準出力・固定エラー文にstatic credentialやticketを出さない。非loopback bindにはhandoffを発行しない。発行／交換はloopback client、Host／Origin／portを照合し、交換はOrigin必須とsame-origin fetchを確認する。credentialをブラウザーへ返す応答は`no-store`とする。

| QE_BUILD限定確認 | 結果 |
|---|---|
| WebChat／Gateway typecheck、WebChat build、生成Control Center JavaScript構文 | PASS。 |
| Windows PowerShell AST、Authorization header設定（dummy値のみ・送信なし） | PASS。 |
| POSIX `sh -n`、Unix inline Node構文、`git diff --check` | PASS。 |
| test suite、実Gateway／HTTP handoff、installed Windows／Linux／macOS GUI、全体G02／P2、`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / launcher→WebChat one-use Control Center handoff.
- **STATUS:** launcher→loopback ticket issuer→single-use exchange→既存Control Center認証入力のソース経路を接続。実Gateway／HTTP／installed GUIは未実行のためG02.02全体は`BUILD_GAP`。
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体施工を継続する。次のBUILD_BATCH開始時に現行HEADからC→J→Broker→実結果→J/M帰還の呼出し経路と5OS導入後利用を照合し、最初の実未接続consumerを選ぶ。G09.01 Android native producer→D4 Adapter→BLUE ingressはD4別repo限定委任待ちの`BLOCKED_AUTHORITY`を維持する。
- **SAFETY_STATUS:** tokenはlauncherのloopback request headerと同一originのno-store応答だけを通る。URL fragmentには30秒・単回ticketだけを含み、script実行時に消去する。既存password欄でmasked表示し、owner tokenはstorageへ残さない。実tokenを使うprovider接続、仕事送信、実行承認、外部作用、別repo変更、P13公開／出荷GOなし。
- **LOCAL_ASSET_STATUS:** WebChat packageのignored `dist/`をbuildで再生成し型解決／script syntax確認に使用して保持。新規test fixture／installer artifact／Tempファイルなし。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。
- **GIT_STATUS:** START_HEAD=`d208a0a3ebe2493cd1ad7142f1c3a51099cdb9ea`。implementation commits=`5a97ecfbf536cfc922438a69d58e3f51c4e7d582`／`f45506e6d87b58eadd03eb20798e3fd36db435cb`をGitHub `main`へfast-forward pushしreadback確認。implementation後のrecovery local branch／remote tag current／previous=`f45506e6d87b58eadd03eb20798e3fd36db435cb`／`5a97ecfbf536cfc922438a69d58e3f51c4e7d582`。本記録のcloseout後はcurrentをdocs closeout commit、previousを`f45506e6d87b58eadd03eb20798e3fd36db435cb`へ更新して再照合する。旧Worktree metadataの自動整理はACL拒否のため変更せず保留。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Linux・macOS installed Gateway health-gated Control Center入口 (G02.01/G02.03, 2026-11-13)

主語はLinux／macOS installed productの共通Unix launcher、managed Gateway process、Control Center入口である。目的はprocessが存在するだけの状態をreadyと誤認せず、Gatewayの`/healthz`が200を返した場合だけControl Centerを開くこと。これはG02.01/G02.03に残る通常入口のP2施工であり、Setup・更新・全lifecycleや製品全体の成立判定ではない。

`resident-start`、`launch`／`open`、`restart`、`safe-mode`は既存・新規managed Gatewayの両方で`/healthz`=200を最大15秒確認し、managed process identityも再照合する。`open`／`launch`はControl Centerを開く直前にも最大2秒のhealth照合を行い、`resident-open`もmanaged processとhealthが揃わなければ開かない。health probeはNode built-in HTTPのGET一回を繰り返し、redirect・credential・外部宛先を使わず、200以外をreadyにしない。許可する宛先はlocalhost、loopback、wildcardのloopback変換、またはOS上のlocal interface addressに限る。

health未成立・managed process再確認失敗時は非zeroで停止し、Doctorとログを案内する。起動済みprocess／watchdog、DataRoot、ユーザーデータを自動停止・削除・変更しない。既存`start`／`serve`のforeground運転、Setup／Uninstall、GUI実動作はこの単位の対象外。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Git付属POSIX `sh -n install/unix/product/BlueTanukiLauncher.sh` | PASS。 |
| health probe heredocの`node --check -` | PASS。 |
| `git diff --check`／`corepack pnpm docs:check` | PASS。日本語基底の既存移行負債75件は注意として継続。 |
| tests、Linux／macOS installed runtime・HTTP health・GUI smoke、全G02、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Linux・macOS installed launcher health gate before Control Center open.
- **STATUS:** POSIX launcher sourceからready gateを接続。静的構文確認のみで、Linux／macOS installed Gateway・HTTP・GUI consumerは未実行。G02.01/G02.03全体と製品全体は`BUILD_GAP`のまま。
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体実装を続け、全体経路から次の未接続producer→consumerを選ぶ。G09.01 Android native producer→D4 Adapter→BLUE ingressは別repo限定委任待ちの`BLOCKED_AUTHORITY`を維持する。
- **SAFETY_STATUS:** `/healthz` GETはlocal addressのみに限定し、HTTP 200以外ではGUIを開かない。失敗したprocess／DataRoot／user dataは維持。D4／MINIDORA別repo変更、C08.03 live provider、OD-03無委任live作用、P13公開／出荷GOなし。
- **LOCAL_ASSET_STATUS:** source／docs差分のみ。package artifact、test fixture、Tempデータなし。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。
- **GIT_STATUS:** START_HEAD=`fb50124928eece6914dd216428753734c1866b8a`。開始recovery local branch／remote tag current／previous=`fb50124928eece6914dd216428753734c1866b8a`／`0556f3396711d02bdb71ab51163200ffa1`。implementation commit=`ecba6f9545c8fd912c32425256de90760a14538e`を`main`へfast-forward pushし、local／origin／GitHub main一致をreadback確認。implementation push後recovery current／previous=`ecba6f9545c8fd912c32425256de90760a14538e`／`fb50124928eece6914dd216428753734c1866b8a`。本記録を含むcloseout docs commitもfast-forward pushし、終了時のlocal／origin／GitHub mainとrecovery二世代を再照合する。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Windows installed Gateway health-gated Control Center入口 (G02.01/G02.03, 2026-11-13)

主語はWindows installed product launcher、managed Gateway process、Control Center入口である。目的は、processが存在するだけの状態をreadyと誤認せず、`/healthz`が200を返した場合だけControl Centerを開くこと。これはWindows G02.01/G02.03の導入後通常利用入口を閉じるP2施工であり、全lifecycleや製品全体成立の判定ではない。

`Start-Resident`は既存processと新規起動processの双方で最大15秒healthを確認し、ready状態をbooleanで返す。`open`、`start`、safe modeは未ready時にControl Centerを開かずexit code 2で停止し、Doctorとログを案内する。未readyのprocessは自動停止・再起動せず、DataRootやユーザーデータへ変更を加えない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Windows PowerShell AST `Parser::ParseFile` | PASS。 |
| `git diff --check` | PASS。 |
| `corepack pnpm docs:check` | PASS。日本語基底の既存移行負債75件は注意として継続。 |
| tests、installed runtime／GUI、health failure／existing unhealthy processのsmoke、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Windows installed launcher health gate before Control Center open.
- **STATUS:** Windows launcher sourceのready gateを接続。AST構文確認のみで、installed製品／process／HTTP health consumerは未実行。G02.01/G02.03全体および製品全体は`BUILD_GAP`のまま。
- **NEXT_REQUIRED_CONSUMER:** P2全体実装を続け、次の未接続producer→consumerを全体経路から選ぶ。G09.01 Android native producer→D4 Adapter→BLUE ingressはD4別repo限定委任待ちの`BLOCKED_AUTHORITY`を維持する。
- **SAFETY_STATUS:** health未成立ではGUIを開かず、process・dataを停止／削除しない。D4／MINIDORA別repo変更、C08.03 live provider、OD-03無委任live作用、P13公開／出荷GOなし。
- **LOCAL_ASSET_STATUS:** source/docs差分のみ。test fixture／installer artifactなし。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。
- **GIT_STATUS:** START_HEAD=`06914a6b009b38173027c3cb3f191913198aff91`。実装commit=`0556f3396711d02d13b02bdb71ab51163200ffa1`をGitHub `main`へpushし、local／origin／GitHub main一致をreadback確認。実装push後recovery branch／remote tag current／previous=`0556f3396711d02d13b02bdb71ab51163200ffa1`／`06914a6b009b38173027c3cb3f191913198aff91`。本項を含むdocs closeout後はcurrentをcloseout HEAD、previousを実装commitにする。stale worktree metadata ACL拒否は変更せず保持。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / F06.02フォーム入力と最終GETの二段階L3 (2026-11-13)

主語は既存`browser.automation action=form_fill/form_submit`、Gatewayのcontent-review／Executor境界、Control Center、Browser Adapterである。目的は、一時フォーム入力と最終GET送信を独立したowner L3 reviewへ分け、入力段階の結果だけで送信権限を作らず、送信直前に同じrequest・owner・入力・フォーム状態を照合すること。

`form_fill`は公開IP guard付きのHTTP GETでページを取得し、JavaScript／service worker／credential／Cookie／downloadを使わず、ephemeral DOMのtext/search inputへ値を設定するだけでsubmitしない。Gateway reviewはページ取得の外部効果を`page_read_unclassified`と明示し、送信先と全入力値をno-store表示へ結ぶ。成功後にGatewayはcommand／review／request payload／form markup state／request identity／owner identityのdigestだけを含む10分・最大256件のprocess-local receiptを発行し、呼出し結果へ返す。receiptは一回限りの照合記録であり権限ではない。

後続の`form_submit`はreceiptとstate digestが必須で、Gatewayは同一request・owner・入力payloadの有効receiptを確認し、別のno-store L3 reviewへreceipt/state digest・送信先・値を表示する。Browser Adapterは新しいHTTP GETでform markupを再取得し、state digest、同一origin、GET契約、入力制約、送信先を再検証する。実送信直前にGatewayのfailure-memory／emergency-stop条件を再確認してreceiptを一度だけ消費する。GETは一回だけでredirectを追わず、結果不明の自動再送はしない。外部効果、購入・確定の意味は自動分類しない。receipt消失・期限切れ・不一致・再起動後は送信を閉じる。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Core typecheck／Core TypeScript emit（native isolation build scriptなし） | PASS。 |
| WebChat package build／Gateway typecheck | PASS。 |
| 生成Control Center scriptのJavaScript構文／`git diff --check` | PASS。 |
| test suite、fixture runner、実Playwright／HTTP／Web、実provider、installed製品、F06全域、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F06.02 ephemeral form input → separate final GET review.
- **STATUS:** parser、Gateway content review、Control Center、Executor callback、Browser Adapterをsource-levelで接続し`CODE_PRESENT`。runtime往復・実runnerは未確認のため、F06.02全体および製品全体は`BUILD_GAP`。
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体実装を続け、次consumerを現行実装・工程索引から選び直す。G09.01 Android native producer→D4 Adapter→BLUE ingressはD4別repo限定委任待ちの`BLOCKED_AUTHORITY`を維持する。局所QC／QAへ移らない。
- **SAFETY_STATUS:** 2段階ともL3。入力段階はephemeral DOM fillのみ。最終GETには短期・単回receipt、完全form-state再照合、実送信直前のGateway停止条件確認が必要。HTTP外部効果は未分類、redirect・credential・Cookie・JavaScript・download・自動再送なし。実Web・外部作用・C08.03 live provider・他repo変更・P13公開／出荷GOはHOLD。
- **LOCAL_ASSET_STATUS:** Core／WebChatのignored `dist/`を型解決とscript構文確認の再生成物として保持。新規test fixture・artifact・非Git資料なし。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護して未変更。
- **GIT_STATUS:** START_HEAD=`57de66fadf4b45c85ef9455aff4a3e493153d410`。開始時local／`origin/main`／GitHub `main`は一致、ahead/behind=0/0。実装commit=`2729deeee06f04d5a676d3cccb3d9f0d3cd56098`を`main`へpushし、GitHub SHA一致を確認。実装push後のlocal／remote recovery current／previous=`2729deeee06f04d5a676d3cccb3d9f0d3cd56098`／`57de66fadf4b45c85ef9455aff4a3e493153d410`。本項を含むdocs-only closeout commitも`main`へpushし、そのcommitをcurrent、実装commitをpreviousとして二世代refを再照合した。Gitが古いworktree metadata `.git/worktrees/blue-tanuki-health-2026-11-07-windows`の自動整理にPermission deniedとなったため、metadata／ACLを変更せず保留。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Browser link navigationのL3遷移先束縛 (F06.02限定)

主語は既存`browser.automation action=click`とGatewayの承認コンテンツレビュー、Control Center、Browser Adapterである。目的は、ownerがL3で確認した同一originの遷移先をOperation Planへ結び、実行時の同名リンクが別URLへ変化した場合にGET前で停止すること。

click入力は`url`・完全一致`link_name`・必須`target_url`の組にし、URLのquery/hashとorigin変更を拒否する。Gatewayは同じ要求・command digest・Operation Plan束縛を持つno-store reviewを生成し、Control Centerにページ、リンク名、固定遷移先、GETの外部効果未分類、JavaScript／資格情報／download無効を明示する。ownerが内容を確認したreview digestがcurrent commandと一致しなければL3承認できない。Browser Adapterは実行時にページを再取得し、同名リンクの完全URLが`target_url`と一致したときだけ遷移する。異なる場合はGET前に`target_changed_after_review`で停止する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Core／WebChat typecheck | PASS。 |
| Core TypeScript emit（native isolation build scriptなし）／WebChat build／Gateway typecheck | PASS。Gatewayは新しいworkspace declarationを参照する状態で確認。 |
| 生成Control Center scriptのJavaScript構文／`git diff --check` | PASS。 |
| test suite、fixture runner、実Web、外部HTTP、installed製品、F06全域、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F06.02 browser link target binding slice。
- **STATUS:** L3 review→Control Center→実行時完全URL再照合のコード経路を`WIRED`。実runner／Gateway runtime未実行のためF06.02全体は`BUILD_GAP`。
- **NEXT_REQUIRED_CONSUMER:** F06.02の「入力」と「確定送信・購入」の別承認は未施工。ブラウザー状態を推測で保持せず、独立した入力確認と最終作用のJ／Approval／Broker結線を継続する。並行してrev5.0 P2全体施工を続ける。G09.01 Android native producer→D4 Adapter→BLUE ingressはD4別repo限定委任待ちの`BLOCKED_AUTHORITY`を維持する。
- **SAFETY_STATUS:** 同一origin・query/hashなしの完全URLをL3 reviewに表示し、作用直前のhref差分を拒否。navigation GETの外部効果は未分類のまま。実Web、資格情報、外部作用、downloadなし。C08.03 real provider、他repo変更、P13公開／出荷GOはHOLD。
- **LOCAL_ASSET_STATUS:** `packages/blue-tanuki/dist/`と`packages/channel-webchat/dist/`は型解決・構文確認に使った再生成可能なignored build outputとして保持。新規の非Git資料なし。保護対象`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は未変更。
- **GIT_STATUS:** START_HEAD=`53fcccc1fe5a6f2f44670b71079a9110cb3690b1`。実装commit=`92bc4c17b5828f1dcd2dba0cc8f2e05f3b28293d`を`main`へfast-forward push済み。push直後のlocal／`origin/main`／GitHub `main`の最終照合とrecovery refsの2世代readbackは作業閉包で行う。fetch／commit時のstale `.git/worktrees/blue-tanuki-health-2026-11-07-windows`自動整理はPermission deniedのためmetadata／ACLを変更せず保持。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / release draftの注釈付きtag chain解決 (F05.02)

主語は既存の`github.write release.draft.create`経路と、GitHub上のtag refからcommitまでの参照解決である。目的は、別の注釈付きtagを指すtagも、検証済みcommitを特定したうえで既存の未公開draft作成経路へ通すこと。

新しいresolverは最大16段の注釈付きtag chainを追い、tag SHAの循環、上限超過、不完全・不正な対象、commit以外への終端をfail-closedで停止する。対象版観測と既存L3承認後のreadbackで同じresolverを使い、外側tag refと要求commitの一致を維持する。既存のOperation Plan／L3／Approval／Broker、POST一回、曖昧結果の自動再送なしは変更していない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `corepack pnpm --filter @blue-tanuki/core typecheck` | PASS。 |
| `git diff --check` / `pnpm docs:check` | PASS。日本語基底の既存移行負債75件の注意を維持。 |
| release関連test、workspace full build、実GitHub credential/API、外部作用、全F05、全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA | NOT_RUN／未成立。Linux isolation `target/`を保護するためcore package buildは行っていない。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F05.02 nested annotated tag target resolution。
- **STATUS:** `CODE_PRESENT`（typecheck済み。nested tag fixture／Gateway processでのconsumer確認は未実施）。F05全体・製品全体は未成立。
- **NEXT_REQUIRED_CONSUMER:** P2全体施工を続ける。G09.01 Android native producer→D4 Adapter→BLUE ingressはD4別repo限定委任待ちの`BLOCKED_AUTHORITY`で維持する。Android／iOS、5OS、製品全体へ完了を拡張しない。
- **SAFETY_STATUS:** 不明なtag type・cycle・16段超を拒否。requested commitとの完全一致、既存no-store L3、事前再観測、結果不明時no-retryを維持。実provider・POST・公開releaseなし。
- **LOCAL_ASSET_STATUS:** 新規永続生成物なし。保護対象attachmentsとLinux isolation `target/`は未変更。
- **GIT_STATUS:** START_HEAD=`b0712ae41d99d3e020b82dcaba7ed11834c2cce5`。実装・状態記録commit=`230c9fff17ada14749320f667d1999af5cae32a8`を`main`へfast-forward pushし、local／`origin/main`／GitHub `main`の一致を確認。実装push後のlocal recovery branch／remote backup tag current／previous=`230c9fff17ada14749320f667d1999af5cae32a8`／`b0712ae41d99d3e020b82dcaba7ed11834c2cce5`。その後のdocs-only closeout commitも同batchでfast-forwardする。fetch／commit時にstale `.git/worktrees/blue-tanuki-health-2026-11-07-windows` metadataの自動整理がPermission deniedとなったため保持し、metadata／ACLは変更しない。短縮refはlocal tagと曖昧だったため、すべて完全修飾refで照合した。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Windows installerのMAX_PATH回復 (G02.01, G02.03)

主語はWindows x64のIExpress単一exe→自己展開ZIP→製品Setup→installed Gateway→通常Uninstall経路。目的は、Playwright/Chromium同梱物を含む実パッケージがWindowsの従来パス長制限内で展開・導入・起動・停止・削除へ進めるようにすること。これはG02.01の導入consumerとG02.03の通常削除consumerを短時間観測したBUILD_BATCHであり、更新・中断復旧・データ保持を含むG02全域や製品全体の完成ではない。

初回のIExpress smokeでは、深いTemp配下の自己展開先で`Expand-Archive`が260文字超のChromiumパスに失敗した。展開先を短縮すると、その後Setupの`.i.blue-tanuki-stage-<32 hex>`へのコピーで同じ制限に達した。自己展開Tempを`bt-<16 hex>`、展開子を`i`へ短縮し、Setupのstage/rollback transaction suffixも16 hexにした。中断rollbackの検出は新16 hexと既存32 hexの両方を受け入れ、旧配置からの復旧互換を維持する。パス生成失敗時の`New-Item`は`-Force`で既存先を再利用せず、停止する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `install/installer/test/windows_safe_target.ps1` | PASS。短い新suffixと既存32 hex suffix双方の中断rollback復旧を確認。 |
| `pnpm package:windows` | PASS。ZIP 186,367,695 bytes / SHA-256 `5123884fce70ae9eac3aec1ff66ecfc3ecd43f8265991e9210abf5c03b94eb70`、CMD 255,032,569 bytes / `9a8d4a309d64b26beb5d2639cbf6e2bc41239a175ef11c750cce91b1b6aa1537`、IExpress EXE 255,275,008 bytes / `807981b16e1a94bfaa6b62ffd366e8066e4dae61d2d221fe212505416b0d34b4`。署名なし、公開・配布はHOLD。 |
| `pnpm package:windows:verify` | PASS。ZIP 4,002 entries、manifest/SHA、CMD/EXE埋込payload、EXE単一ファイル展開を照合。Verifier自身の`setup_execution`はNOT_RUN。 |
| `pnpm smoke:windows-installed -- --artifact <ZIP> --iexpress-exe <EXE> --startup-only` | PASS。隔離先へのIExpress展開・Setup・post-install doctor（`provider=stub`）・Gateway手動起動・loopback `/healthz`・停止・通常Uninstallを確認。uninstall/autostart登録とsmoke rootが残らないことを確認。 |
| `pnpm validate:packaging` | PASS。実装はpayload sizeを`embeddedZip.sizeBytes`で検査するため、静的validatorの旧`embeddedZip.length`文字列期待を現行契約へ修正して再実行。 |
| `pnpm docs:check` / `git diff --check` | PASS。 |
| GUI初回利用・既定起動・更新/rollback・再起動・全suite・他OS・実provider・全体SYSTEM_SHAPED/BUILD_COVERED・QE_QC/QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / G02.01 Windows配布物・新規導入、G02.03 Windows更新・復旧・削除。
- **STATUS:** packaged IExpress→Setup→installed stub Gatewayの起動consumerと通常Uninstallを限定`WIRED`確認。Windows製品導線全体、更新/rollback/ユーザーデータ保持、5OS、製品全体は`BUILD_GAP`継続。
- **NEXT_REQUIRED_CONSUMER:** P2全体施工を継続し、現在の実装から未接続consumerを再選定する。現行repoの`apps`/`packages`/`install`にはAndroid/iOS native product entryが見当たらず、G09/G10の入口・Device Link・秘密保管・一仕事consumerは未接続候補。D4-Pocketは読取のみとし変更しない。
- **SAFETY_STATUS:** fixtureと`provider=stub`のみ。実credential/provider、外部送信、公開、署名、owner dataを使わず、製品の通常アンインストールだけを隔離先で実行した。`P13=PENDING_OWNER_GO`を維持。
- **LOCAL_ASSET_STATUS:** Task-generated artifact、展開診断、隔離smoke rootの6パス／18,275 files／2,990,810,866 bytesを通常Windowsゴミ箱へ移動し、各元path消失と6件のRecycle Bin readbackを確認。ownerの最終処分待ちであり、容量回復としては計上しない。protected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は未変更。
- **GIT_STATUS:** 編集前local／`origin/main`／GitHub `main`=`5533a0a6b6539b2bf3f9812bc4179de62b759c2a`、ahead/behind=0/0。編集前recovery local branch／remote tag current/previous=`5533a0a6b6539b2bf3f9812bc4179de62b759c2a`／`bf37238dec7c4bc57c5f0ccafd8838ba72b3bd87`。実装commit=`3f60fef9addc6bd66395988e3b3f27ade6d2076c`とcloseout commit=`3363c8d29950aaf231649fe7909a1ad5a33c3e8e`を含む履歴をGitHub `main`へfast-forward push済み。直後readbackはlocal／origin／GitHub=`3363c8d29950aaf231649fe7909a1ad5a33c3e8e`、recovery current/previous=`3363c8d29950aaf231649fe7909a1ad5a33c3e8e`／`5533a0a6b6539b2bf3f9812bc4179de62b759c2a`。最後の記録訂正を含むdocs-only fast-forwardも同じBUILD_BATCHの閉包としてpushし、current recoveryのみ最終HEADへ進めprevious世代は開始SHAを保持する。stale worktree metadataの自動整理はPermission deniedだったため、metadata／ACLは変更せず保留。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / browser.read 添付・非text応答遮断

主語は`browser.read`とHTTP応答consumer。目的は、添付またはPDF等の非text応答をページ読取結果としてCへ渡さないこと。内部HTTP応答の`Content-Disposition`を使って添付を拒否し、許可MIMEだけを本文処理へ進める。拒否時は本文・ファイル名を含まない固定エラーを返す。`invokeHttpFetch`の外部戻り値契約にはheaderを追加していない。ファイル保存、browser download有効化、実browser実行は行っていない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `tools_builtin.test.ts` | PASS、104 passed／6 skipped。attachment、PDF、Content-Type欠落時に本文・filenameが返らないことをfixture確認。 |
| Core typecheck | PASS。 |
| `pnpm docs:check`／`git diff --check` | PASS。日本語基底の既存移行負債75件は注意表示。 |
| default HTTP、Playwright、実browser、全suite、他OS、installed製品、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F06 browser.read response boundary.
- **STATUS:** `browser.read`の応答処理経路へ拒否判定を接続。`CODE_PRESENT`相当のコード確認であり、実HTTP／installed runtime、F06全域、製品全体の成立を示さない。
- **NEXT_REQUIRED_CONSUMER:** P2全体施工を継続する。現物棚卸しではAndroid／iOS用client・installer treeが見当たらず、rev5.0のG09／G10にあるnative入口、Device Link、秘密保管、一仕事の停止・復旧consumerがBUILD_GAP。D4-Pocketの契約はread-onlyで確認し、同repoは編集しない。
- **SAFETY_STATUS:** 添付・非text本文とfilenameはC向け結果に返さず、自動再試行なし。実credential、ファイル保存、外部業務作用なし。
- **LOCAL_ASSET_STATUS:** 永続生成物なし。test一時物は終了済み。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は未変更。
- **GIT_STATUS:** 編集前local／`origin/main`／GitHub `main`=`bf37238dec7c4bc57c5f0ccafd8838ba72b3bd87`。commit `bdc1d2b300a84248f92e3c088469d0a448e28763`を`main`へpushし、終了時local／origin／GitHub SHA一致を確認。recovery current／previous=`bdc1d2b300a84248f92e3c088469d0a448e28763`／`bf37238dec7c4bc57c5f0ccafd8838ba72b3bd87`でlocal branch／remote tagを照合した。Git commitのstale worktree cleanupはPermission deniedとなったが、commit／pushは成功しACLは変更していない。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / browser form応答のdownload境界

主語は`browser.automation action=form_submit`と、そのHTTP応答を受け取るC向け結果consumer。目的は、添付ダウンロードやPDF等の非テキスト本文を検索結果としてCへ流さず、未対応downloadを結果不明で閉じること。

HTTP transportは`Content-Disposition`を内部応答へ保持する。form GET後は`attachment`を拒否し、HTML／text／JSON／XML系または空の204だけを読取結果として扱う。添付・非テキスト応答は本文・ファイル名を返さず、`outcome_unknown`／`automatic_retry=false`で停止する。ローカル保存・自動実行は行わず、`browser.automation action=download/upload`のquarantineを解除しない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| download／非テキスト応答の拒否境界focused test | PASS、1 selected test（本文・ファイル名をエラーへ含めないことを確認）。 |
| Core typecheck | PASS。 |
| `pnpm docs:check`／`git diff --check` | PASS。日本語基底の移行負債75件は既存注意。 |
| default Playwright／HTTP、実ブラウザ、実provider、ファイル保存、全suite、全体P2、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F06 form response download quarantine.
- **STATUS:** default HTTP response headers→form GET response policy→C向け結果の静的接続を追加。限定`CODE_PRESENT`であり、download保存機能、実ブラウザ経路、F06全域や製品全体の成立を示さない。
- **NEXT_REQUIRED_CONSUMER:** P2全体施工を継続し、downloadを実装する場合はowner L3・対象path・隔離保存・安全な後続consumerを結んだ実経路を作る。現在のdownload/upload quarantineは維持する。
- **SAFETY_STATUS:** GETの外部効果は未分類のまま。添付・非textは未保存・未返却、結果不明、自動再送なし。credential、実browser、live provider、外部作用なし。
- **LOCAL_ASSET_STATUS:** 新たな永続生成物なし。test一時物はtest cleanup。protected attachmentsとLinux isolation `target/`は未変更。
- **GIT_STATUS:** 編集前local／`origin/main`／GitHub `main`=`8a81d0e51eba66e96505255170494333a6b66bbf`、ahead／behind=0/0。編集前recovery current／previous=`8a81d0e51eba66e96505255170494333a6b66bbf`／`a5ac1f6dbf6c85400cc38cb251ad315296603705`。実装commit=`2355bd0bde1b23b24b5c27998264a25c716b3aa6`を`main`へpushし、local／`origin/main`／GitHub `main`の一致をreadback確認した。終了時recovery refsはcloseoutで照合する。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / browser form外部作用の分類とowner review

主語はBLUEの`browser.automation action=form_submit`とControl CenterのL3 content reviewである。目的は、検索フォームの形状をread-only効果と誤認せず、外部効果が未分類のフォーム送信としてowner reviewへ渡すこと。

Gateway reviewに`external_effect_class=form_submission_unclassified`を追加し、review digestに束縛した。Control Centerはこの固定分類がないreviewをfail-closedにし、「GETでも状態変更があり得る」「購入・確定等の効果を自動判別できない」「結果不明時は自動再送しない」を送信先・入力値とともに表示する。tool resultにも同じ非権威分類を付ける。実際の送信先効果を製品側でread-onlyへ昇格しない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| browser form contract／tool／Gateway review focused tests | PASS、27 tests（form contract 23、tool 2、Gateway 2）。 |
| WebChat Control Center review rendering | PASS、1 selected test。 |
| Core／Gateway／WebChat typecheck | PASS。初回Gateway typecheckは古いWebChat `dist`に対して失敗し、WebChat build後に同条件でPASS。 |
| WebChat package build | PASS。 |
| `pnpm docs:check`／`git diff --check` | PASS。日本語基底の既存移行負債75件は注意表示、license gate PASS。 |
| live送信、実ブラウザ、外部効果、全suite、P2全域、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / F06-03 browser form external-effect classification.
- **STATUS:** review projection→authenticated Control CenterのL3表示・承認digestへ外部効果未分類を結び付ける。局所`CODE_PRESENT`に限り、実browser／Gateway approval往復やF06全域・全製品の完了を意味しない。
- **NEXT_REQUIRED_CONSUMER:** F06の未接続producer／consumerを全体P2設計内で続けて選び、全要求・5OSの実consumerを接続する。購入・確定等の効果分類を未確認のまま安全と扱わない。
- **SAFETY_STATUS:** L3 no-store、同一origin、credentialなし、JavaScript／service worker無効、public-address guard、結果不明時の自動再送なしを維持。外部効果は未分類、owner確認なしのlive送信・公開・出荷判断なし。
- **LOCAL_ASSET_STATUS:** 実装・focused test・docs差分。WebChat package buildで`packages/channel-webchat/dist`を再生成し保持。Vitest一時物はtest cleanup済み。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護して未変更。WSL／他repoに触れない。
- **GIT_STATUS:** 編集前local／origin／GitHub `main`=`a5ac1f6dbf6c85400cc38cb251ad315296603705`、ahead／behind=0/0。編集前local recovery branch／remote backup tag current／previous=`a5ac1f6dbf6c85400cc38cb251ad315296603705`／`6722c55b5c9f70aca03e98334afd27faee52770a`。実装commit=`7abe8c372c37f6d3dc1994cdc9d61de7e12f6b1f`を`main`へpushし、直後readbackでlocal `HEAD`／`origin/main`／GitHub `main`の一致と二世代refsを確認した。protected untracked assetsはstageしていない。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / browser.automation送信先束縛付き検索GET

主語はBLUE `browser.automation`とWebChat L3 content reviewである。目的は、ownerが明示した送信元ページ・同一origin送信先・検索項目を、既存の承認境界に結び付けたbounded GET consumerへ接続すること。

`action=form_submit`は明示された`url`／`action_url`、一意なaccessible `search`領域、同一origin、GET、`_self`、標準URL encoding、UTF-8、text/search inputを要求する。hidden／credential-like／unsupported／duplicate field、submit action/method/encoding/target/validation override、`dirname`、pattern、非標準autocomplete、曖昧なform、送信先差替えを拒否する。`minlength`／`maxlength`を手動適用し、必須fieldを確認する。owner再認証UIは送信元、送信先、全入力値をauthenticated no-storeのL3 content reviewで表示し、command digest・OperationPlan binding・内容digestへ結ぶ。

実行時はJavaScript／service workerを無効にしたephemeral contextを使う。送信元と送信先へのHTTP GETはpublic-address／allowlist確認後、DNS解決済みIPへ固定する既存transportを使い、browser cookie／credentialを送らずredirectを追わない。ブラウザの外部networkは遮断し、取得HTMLだけをローカルDOM解析へ渡す。検索queryは返却URL・observationへ含めず、送信後の失敗は結果不明として自動再送しない。previewは既定無効のまま。GETで状態変更するWeb endpointは判定できないため、送信先と値のowner L3確認を維持する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Core form contract／URL builder | PASS、23 tests。GET／送信先・origin／field binding、HTML長制約、encoding・submitter override等の拒否境界をfixtureで確認。 |
| `browser.automation`／Gateway approval review／Control Center表示のfocused tests | PASS、2 + 2 + 1 tests。入力値はno-store reviewのみ、返却URL／observation metadataにquery値を含めない。 |
| Core／Gateway／WebChat TypeScript typecheck | PASS。 |
| Core／Gateway／WebChat TypeScript出力・package build | NOT_RUN（今回の最終差分後）。 |
| `pnpm docs:check`／`git diff --check` | PASS。日本語基底の既存移行負債75件は注意表示。 |
| 実Playwright／HTTP、外部provider／作用、installed runtime、全suite、5OS、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / browser.automation owner-bound same-origin search-form GET.
- **STATUS:** parser→tool→ephemeral runnerとGateway L3 review→WebChat表示の実装経路を追加。focused fixture／typecheck範囲で確認した`CODE_PRESENT`。実Playwright／Gateway owner approval往復は未実行で、`WIRED`／F06完了へ拡張しない。製品全体`SYSTEM_SHAPED=false`／`BUILD_COVERED=false`、QE_QC／QE_QA未開始を維持。
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体の未接続producer／consumerを次作業開始時に再選定し、Windows-firstの全体実装を続ける。品質監査へ工程移行しない。
- **SAFETY_STATUS:** browser preview既定無効、L3、public-address／allowlist guard、credentialなし、download／upload quarantineを維持。form GETはownerが明示したdestinationとfieldを承認する。GETの状態変更性は保証できず、外部送信、実provider、live browser、公開・出荷判断なし。失敗時の結果不明と自動再送禁止を実装。
- **LOCAL_ASSET_STATUS:** 新規ローカル資産はsource／test／docs差分。focused test一時物はtest cleanup。型検査はno-emit。既存TypeScript `dist`、`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。WSL／他repoには触れていない。
- **GIT_STATUS:** 編集前local／origin／GitHub `main`=`6722c55b5c9f70aca03e98334afd27faee52770a`、ahead／behind=0/0。編集前local recovery branch current／previous=`6722c55b5c9f70aca03e98334afd27faee52770a`／`a702c82785dd48da28f4372d82c4f28ac4af3e08`、remote backup tag二世代も同じSHA。実装commit=`3bd65bee5742ac37fc035a598a09ec53ebc15fa4`と閉包docs commitを`main`へpush済み。各push後のreadbackでlocal `HEAD`／`origin/main`／GitHub `main`の一致とrecovery refs二世代を確認した。通常の`fetch --tags`は既存のlocal tag名競合で拒否されたためrefを変更せず、`--no-tags`のmain fetchで同期した。Gitの自動整理は古い`.git/worktrees/blue-tanuki-health-2026-11-07-windows` metadataのACL拒否でcleanup失敗。ACL・metadataを変更せず保留し、protected untracked assetsも維持。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / CLI達成規則からJ/M結果projection・Control Center引継ぎまで

主語はBLUEの通常Gateway CLI task、HDS J OperationPlan、既存Control Center owner再認証実行経路である。目的はCLI起点の明示達成規則を共有private stateのJ/Mへ保持し、owner再認証後の検証済みresult／M receiptを、CLIから後でdigest-only照会できる一続きのconsumerへつなぐこと。規則は同一taskの達成停止だけに使い、permission／approval／外部作用の権限を作らない。

CLIの達成規則stdin入力は非空taskだけを受け、`--organize`との併用、欠落・重複・過大・invalid UTF-8／JSON／schemaを拒否する。規則付きrequestと状態照会だけを`serve`と同じ`BLUE_TANUKI_STATE_ROOT`のOperationPlan／result-M storeへ接続し、通常CLIのprovider経路には状態照会を混ぜない。結果表示はJ/Mの照合後、`--goal-completion-status <request-id-digest>`という独立照会用HDS controlで再取得する。未知ID・追加引数・owner/channel不一致・不整合policyはfail-closed。status controlはno-op commandとoutput auditを通すが、M receipt再照合と監査記録は行う。task本文・規則・result本文を出さない。

既存Control Centerは再起動後も同じprivate stateのplanを読み、owner再認証に束縛したreviewへ渡す。status照会はHDSが一意plan、request digest、owner/channel、task identity、目標本文digest、規則digestを再照合し、M receiptを反映した非権威状態だけを返す。達成・保留・進行中のprojectionは証拠digestと規則件数に限定し、実行権限を付与しない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| CLI達成規則／status引数parser・内部owner request | PASS、6/6 tests。重複・不正digest・未知引数境界を確認。 |
| J/M達成・不一致・曖昧対応付けの再起動後status照会 | PASS、3/3 cases。test-owned workspace／SQLite／fixture Executor。 |
| CLI-origin planの再起動後Control Center owner再認証引継ぎ | PASS、1/1 case。fixture owner review commandまで。作用実行は別のtest条件であり、実人間認証を証明しない。 |
| Protocol／HDS-BRAIN build、Gateway typecheck／build | PASS。 |
| `pnpm docs:check`／`git diff --check` | PASS。日本語基底の既存移行負債75件は注意表示。 |
| focused tests | PASS、CLI parser 6/6、J/M status・Control Center引継ぎ4/4（同test fileの47件はskip）。初回status testで目標digest照合の実装不一致を検出し、既存policy契約のSHA-256照合へ是正後、同じ条件で再実行PASS。 |
| runCli() process全体のinstalled smoke、provider／外部作用、全suite、5OS、QE_QC／QE_QA | NOT_RUN。 |

- STATUS: CLI producer、共有J/M永続状態、既存Control Center再認証consumer、次回CLI status projectionをprovider-free fixtureで接続し、限定`WIRED`。runCli() process全体／installed製品／実人間認証は未確認。QE_BUILDを継続し、SYSTEM_SHAPED=false、BUILD_COVERED=false、QE_QC／QE_QA未成立、P13 PENDING_OWNER_GOを維持。
- NEXT_REQUIRED_CONSUMER: rev5.0 P2全域のproducer→consumer欠損を続け、Windows-firstの全体仕事経路をつなぐ。局所品質検査へ工程を移さず、未実装機能群をconsumer単位で施工する。
- SAFETY_STATUS: C08.03 real provider、実資格情報、live外部作用、別repo変更、P13公開・出荷GOはHOLD。fixtureのfile.searchはtest-owned workspace限定。statusは照会専用no-op command・digest-only・output audit付きで、M receipt再照合と監査記録を行う。rulesによるpermission生成なし。
- LOCAL_ASSET_STATUS: focused testの一時workspace／SQLiteはtest cleanup済み。Gateway／HDS／Protocolのignored build出力は開発用として保持。protected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は未変更。
- GIT_STATUS: 編集前local／origin／GitHub main=`a702c82785dd48da28f4372d82c4f28ac4af3e08`、ahead／behind=0/0。編集前local recovery branch／remote tag current=`a702c82785dd48da28f4372d82c4f28ac4af3e08`、previous=`ebab0c0c6129c68e5d4af100bbe96865bb149933`。実装コミット`48762eb8920e319a90b2dd7986c7f2e907d5b736`はmainへpush済み。閉包記録を含む最新mainはローカルとGitHubで一致し、二世代のrecovery refsも編集前SHAで読み戻し確認済み。stale `.git/worktrees/blue-tanuki-health-2026-11-07-windows` cleanupはACL拒否のため触れず保留。closeout docs commitの最終SHAはpush後のGit readbackで確認する。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / CLI達成規則のGateway ingress

主語はBLUEの通常Gateway CLI one-shot requestとHDS J OperationPlanである。目的はownerが指定した達成規則を、WebChatと同じ決定論的なJ判定へCLIから結び、規則欠落・不正・不一致・曖昧な結果を達成へ誤昇格させないこと。

`--goal-completion-rules-stdin`を一度だけ指定した場合、CLIは標準入力から最大128 KiBのUTF-8 JSONを読み、`blue-tanuki.goal-completion-rules.v1`として検証する。不正入力はtask受付・C計算前に拒否し、規則本文はargv／Gatewayの通常inbound logへ出さない。検証済みrulesをGateway内で認証されたCLI requestに保持してHDSへ渡す。規則は同一taskの停止判定だけを定め、execution permission、approval、公開・外部作用の権限を作らない。flagがない通常CLI requestは従来の入力を保つ。

| QE_BUILD限定確認 | 結果 |
|---|---|
| CLI goal rules parser／stdin chunking／invalid UTF-8・JSON・schema／上限／重複flag | PASS、4 tests。 |
| Internal CLI requestがrulesを保持しGateway内部markerを持つこと、通常requestがrulesを持たないこと | PASS、同上。 |
| `operation_plan_runtime.test.ts` explicit completion result・J/M evidence（正例／不一致／step曖昧） | PASS、3 tests。合成workspace・test-owned state。 |
| Gateway typecheck／build／`docs:check`／`git diff --check` | PASS。日本語基底移行負債75件は既存注意。 |
| 通常CLI one-shot全経路、provider／外部作用、全suite、installed／5OS、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / owner-defined CLI task completion rules ingress.
- **STATUS:** stdin→Gateway内CLI request→`HDSUpperController.decide`のproducer／consumerをコード接続し、request境界とJ/M判定を分離した局所試験で確認。通常CLI one-shotのinstalled/live executionや外部provider接続の証拠ではない。QE_BUILD、`SYSTEM_SHAPED=false`、`BUILD_COVERED=false`、P13 `PENDING_OWNER_GO`を維持。
- **NEXT_REQUIRED_CONSUMER:** 通常CLI one-shotのHDS→Executor→result／M receipt→CLI projection全体接続を、provider liveなしの隔離手段でP2施工対象として進める。並行してW-CORE／W-EFFECT／W-WORK／W-OS／W-INSTALLの未接続を続行する。
- **SAFETY_STATUS:** 規則の不在・誤形式を成功扱いしない。達成判定はpermission／approval／外部作用を生成しない。C08.03 live provider、無委任live外部作用、他repo変更、P13公開・出荷GOはHOLD。
- **LOCAL_ASSET_STATUS:** source/test/README/active instruction/開発進捗ログをGit候補として保持。Gateway build出力はignoredの開発用として保持。focused testのtemp workspaceは試験内cleanup。添付2領域とLinux isolation `target/`は保護・未変更。
- **GIT_STATUS:** 編集前local／origin／GitHub main=`eb521c06cdb1a6d74dd5cd56594d3fefdb0a4980`、ahead／behind=0/0。local復旧branchとremote tag current=`eb521c06cdb1a6d74dd5cd56594d3fefdb0a4980`、previous=`7ce0778257f96f8d367cc6898a805f05aebfb736`。BUILD_BATCH確定後にcommit/pushとremote SHAを照合する。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / desktop package-local Playwright headless-shell

主語はBLUEの`browser.snapshot`／`browser.automation` previewを含むWindows・Linux・macOSの製品packageと、そのPlaywright runtimeである。目的はheadless起動が選ぶChromium Headless Shell、Playwrightの固定revision、manifest path、runtime browser registryを同じapp-local payloadへ結び、Linux／macOS packageで欠けていたbrowser binaryも生成・検証すること。browser起動、HTTP通信、Setup実行、F06全体や製品完成の確認は対象外。

`PLAYWRIGHT_BROWSERS_PATH=0`をPlaywrightのdynamic import前とbrowser child環境へ全対象OSで設定する。共通package helperは固定`playwright-core@1.65.0`の`browsers.json`から`chromium-headless-shell` revisionを読み、OS／architecture別実行pathの存在を確認してから`install --only-shell chromium`を使う。Windows通常Chromium binaryは同梱せず、headless shell、Playwright付属metadata／license、manifest revision/pathを照合する。Linux x64・macOS x64／arm64も同じ契約でpackage builder／verifierへ接続した。Unix workflowへmain SHA固定・`workflow_dispatch` package-only・単一Setup生成／検証を加えた。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `pnpm typecheck` | PASS。typecheckが消去するignored `dist`は直後のworkspace buildで再生成。 |
| `pnpm build` | PASS、15 workspace projects。 |
| Windows browser package／`verify_windows_package.ts` | PASS。ZIP 3,986 entries、manifest／sidecar／Playwright version・revision 1254／OS path／built runtime registry／shell binary・license照合。SHA-256=`3665cabe2494d85f47c84e2d63e138b0fd3b7cb5944da49b514e075cf0d7bf4f`。full Chromium binaryなし。 |
| Windows one-file CMD／verifier・IExpress EXE／verifier | PASS。CMD SHA-256=`df1bc97a11f8bb89e1763706487d12b829d7f0c4bbf1b723c3951a2941a9825c`、EXE SHA-256=`228fb43eab9130c4f8d013edc8188a3b5c40233b53468c338e8de79ab8da224e`。EXEからCAB／CMD／payload ZIPを抽出・hash照合。Setup実行はNOT_RUN。 |
| Linux x64 package-only（WSL2 Ubuntu 24.04、source SHA=`49fb172e172320ff4ef5baafe5a570623c51cc67`） | PASS。workspace build、`package:linux`、archive verifier（4,214 entries、SHA-256=`3de96299b7a7219ff73d71c5315410c4c9e350e90f712f3cff4abcf240300127`）、one-file `.run` installer verifier（SHA-256=`3d4139a23edd5832c9b1aa3f32f0a8ea3ffa53bbbd8c3cbd30b4e99c0223c2fc`）。WSL2限定であり、Linux native hosted proofへ転用しない。 |
| Linux native hosted package-only／macOS x64・arm64 package-only | NOT_RUN。対象SHA=`49fb172e172320ff4ef5baafe5a570623c51cc67`のworkflow runは0件。Windows Computer UseがURL判定を拒否したためdispatch未成立。 |
| `pnpm docs:check`／終端`git diff --check`／workflow YAML parse | PASS。日本語基底の既存移行負債75件は注意表示。 |
| browser launch／HTTP、installed Setup／Uninstall、全suite、5OS実物、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / desktop package-local browser headless-shell consumer closure.
- **STATUS:** Windows archiveは`WIRED`（manifest path・revisionとZIP内binaryを静的照合。起動未確認）。Linux x64 package／archive／one-file installerはWSL2で`WIRED`（native Linux保証ではない）。Linux native hosted buildとmacOS x64／arm64 package proofは未成立。F06全域・Android／iOS preview・製品全体は`BUILD_GAP`。
- **NEXT_REQUIRED_CONSUMER:** Linux native hosted／macOS x64・arm64 package-only runは対象SHAを固定して取得する。dispatch手段が未成立でもrev5.0 P2の他producer／consumer施工を停止せず、全体BUILD_COVERED前に証拠を取り直す。QE_QC／QE_QAへ移らない。
- **SAFETY_STATUS:** Preview既定無効、L3、Chromium sandbox有効、ephemeral context、credential／保存profileなし、GET／HEAD・public-address guardを維持。browser起動、通信、実provider、外部作用なし。unsigned installerは公開・配布保留。
- **LOCAL_ASSET_STATUS:** Windows ZIP／CMD／IExpress EXEと各SHA／manifest sidecar、READMEの10ファイル・696,500,007 bytesを非OneDrive Temp `blue-tanuki-artifacts-20261113-headless-shell`に保持。Linux WSL package／one-file installer／manifest／checksum／READMEに、source snapshot・build／verify script・verification recordを含む11ファイル・421,956,995 bytesを非OneDrive Temp `blue-tanuki-artifacts-20261113-linux-wsl-49fb172`に保持。WSL2 source workspaceと専用pnpm storeは`/home/ohira/.cache/blue-tanuki-linux-package-49fb172`に継続中build用として保持。package staging/cacheはbuilderが一時領域で管理。ignored Windows workspace build outputは開発用として保持。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。
- **GIT_STATUS:** task開始local／`origin/main`／GitHub `main`=`7ce0778257f96f8d367cc6898a805f05aebfb736`、ahead／behind=0/0。package実装commit `49fb172e172320ff4ef5baafe5a570623c51cc67`はmainへpush済み。編集前復旧refをlocal branch／tag・remote tagでcurrent=`49fb172e172320ff4ef5baafe5a570623c51cc67`、previous=`7ce0778257f96f8d367cc6898a805f05aebfb736`へ競合検出付きで更新。closeout後にmain・復旧二世代・保護差分を再照合する。

## 前段完了BUILD_BATCH — rev5.0 QE_BUILD / Windows製品packageへbrowser runtimeを結合

主語はBLUEの`browser.snapshot`／`browser.automation` previewを含むWindows製品packageである。目的はPlaywright依存だけの`CODE_PRESENT`を越え、Windows archive内の実browser binary・対応Playwright revision・installer consumerをhash結合すること。rev5.0 P2全体施工内のWindows限定producer→package consumerであり、browserの実起動や全体製品完成ではない。

`playwright-core`を1.65.0へ固定し、Windows package時に一致するChromium 1254、Headless Shell、付随browser runtimeをapp-local `.local-browsers`へ格納する。manifestはpackage内の実行path、sandbox有効、preview既定無効を束縛する。ZIP verifierはChromiumとHeadless Shellの実在、`ABOUT`／`LICENSE.headless_shell`およびPlaywrightのLICENSE／NOTICE／ThirdPartyNoticesを要求する。Windows自己展開CMDの生成・検証を行単位のstream処理へ変更し、IExpress CABの二重圧縮を無効にして10分timeoutを解消した。

| QE_BUILD限定確認 | 結果 |
|---|---|
| workspace `pnpm typecheck`／`pnpm build` | PASS。typecheckが消去するignored `dist`は直後のworkspace buildで再生成した。 |
| `pnpm package:installers --platform=windows`／installer verifier | PASS。ZIP payloadと550 MB級Base64 CMDのmanifest／SHA／埋込payloadが一致。 |
| `pnpm exec tsx scripts/package_windows_iexpress.ts` | PASS。unsigned IExpress EXEを生成。 |
| `pnpm package:windows:verify` | PASS。ZIP 4,295 entries、manifest／sidecar、browser binary・license entry、CMD、PE/CAB EXE抽出と埋込hashを確認。setup実行はNOT_RUN。 |
| `pnpm docs:check`／`git diff --check` | PASS（この記録を含むcloseout時）。 |
| browser launch／HTTP通信／installed Setup・Uninstall／全suite／5OS実物／QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Windows package-local Playwright Chromium consumer closure.
- **STATUS:** Windows製品archive内のbrowser runtime consumerは`WIRED`（artifact・manifest・license entryを検証）。実起動・installed runtimeは未確認。Linux／macOSのbrowser binary、Android／iOS preview、F06全域および製品全体は`BUILD_GAP`。
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業で⓪→④を再同期し、rev5.0 P2全域から次のproducer→consumer欠損を選定する。QC／QAへ移らない。
- **SAFETY_STATUS:** Preview既定無効、L3、Chromium sandbox有効、ephemeral context、credential／保存profileなしを維持。実browser起動、外部HTTP、実provider、外部作用は行っていない。installerはunsignedで公開・配布保留。
- **LOCAL_ASSET_STATUS:** 検証済みZIP／CMD／EXEとmanifest／SHAは非OneDrive Temp `blue-tanuki-artifacts-20261113-browser-runtime` にpackage artifactとして保持。失敗attemptのIExpress stage 2件、合計1,100,693,745 bytesをWindowsゴミ箱へ移動し、元path消失とRecycle Bin entryを確認。成功stageとbrowser package workrootは既に不在。ignored workspace build outputは再生成し開発用に保持。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護・未変更。
- **GIT_STATUS:** 実装commit `9a1a07d0242643582f6303bc2edf73d5eccb0c6f`を開始main `e56c0880e37cfed4255a44184a01240c39681f0d`からfast-forward pushし、closeout記録もmainへpushした。終了local main／`origin/main`／GitHub `main`は一致し、復旧currentは終了main、previousは開始mainを指す。終了時のHEADはこのactive instructionを含むcommitとしてGit refsから照合済み。ローカルのprotected untracked attachments／Linux isolation `target/`は未変更。Gitの自動worktree整理が`.git/worktrees/blue-tanuki-health-2026-11-07-windows`への削除をACLで拒否したため、metadata／ACLを変更せず保留した。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / browser previewの同一origin link navigation

主語はBLUE `browser.automation` のephemeral browser previewである。目的は、初期URLのsnapshot／navigateに限られていた経路から、公開ページ上の完全一致するaccessible linkを一つ選び、同一originのHTTP(S)先を閲覧consumerへ渡すこと。これはF06の限定`CODE_PRESENT` sliceであり、製品全体やF06全体を`WIRED`にしない。

`action=click`はJavaScript click handlerをdispatchせず、uniqueな`link_name`の`href`を解決して直接navigationする。入力は1–200文字、曖昧な一致・欠落・非HTTP・cross-originは停止する。browser route interceptionを必須とし、全requestをpublic-address guardで再検査し、GET／HEAD以外をabortする。ephemeral context、credential拒否、download無効、preview既定無効、L3 final-reviewを維持する。form submit／download／uploadは未実装のままquarantineする。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Core TypeScript typecheck／package build | PASS。 |
| `git diff --check`／`pnpm docs:check` | PASS。英語runbookの既存移行負債hashを実物と照合して更新。負債数は75のまま。 |
| browser runtime／外部HTTP smoke／負例実行 | NOT_RUN。workspaceにPlaywright package／browserがなく、Previewは既定無効。実際のページ操作はしていない。 |
| 全suite、installed product、5OS、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / browser.automation exact same-origin link navigation.
- **STATUS:** `CODE_PRESENT`。source runner内の限定経路を追加した。Playwright runtime／browserはpackage dependency・installed productへ含まれておらず、製品consumerは`BUILD_GAP`。F06全体・製品全体は未成立。
- **NEXT_REQUIRED_CONSUMER:** P2全体施工を続け、現在の製品packageにおける実consumer欠損を再選定する。browser previewを製品機能に昇格するにはOS別runtime bundlingとPreview isolationの実物確認が別途必要。QC／QAへ移らない。
- **SAFETY_STATUS:** 実行時には既定無効、L3、credential／storage stateなし、同一origin link navigationのみ、GET／HEAD限定、public-address guard、cross-origin停止。POST系、form submit、download、upload、外部ページの実使用は行っていない。
- **LOCAL_ASSET_STATUS:** package buildが生成したignored `dist`／Rust `target`は作業環境として保持。`.codex-attachments/`、`.codex-remote-attachments/`は保護・未変更。browser runtimeやcacheは追加していない。
- **GIT_STATUS:** 開始local／`origin/main`／GitHub `main`=`2e188a97e68df1294d7f781f825b5a731caa6c10`、ahead／behind=0/0。開始recovery pair current／previous=`2e188a97e68df1294d7f781f825b5a731caa6c10`／`96916e543096f7637c3a1b42abe756709242f940`。closeout時にcommit/push後のSHAと二世代を再照合する。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / owner task statusからJ達成根拠への接続

主語はBLUE WebChatのowner-authenticated task submission status、同一requestに束縛されたHDS J task outcome、およびControl Centerである。目的は、明示規則付きowner taskの受付状態照会だけでJの達成状態を確認可能にし、Runtime tokenがない場合も受付状態を最終結果と誤認せず、検証済みdigest-only outcomeをownerへ返すこと。rev5.0 P2全体施工の一接続であり、製品全体の完成やQC／QAではない。

既存D4 Runtime用projectionを共通化し、request ID、owner actor digest、WebChat channel digestが一意に一致するJ planだけを抽出する。Owner status APIは`rejected`でない受付記録に限り、非権威のtask outcomeを返す。operation/result本文は返さず、規則・証拠digestと件数だけを返す。HDS snapshot取得失敗、欠落、曖昧、形状不正、raw追加fieldは`unknown`へ落とす。D4 Runtime actorのplanをowner結果へ投影しない。Control Centerは応答形状と明示規則／証拠digestを再照合し、J達成が確定した場合だけ達成表示と次依頼操作を許す。Runtime tokenが別途ある場合の既存plan／M詳細照合は維持する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| WebChat／Gateway TypeScript型検査・package build | PASS。 |
| Owner task status route・Control Center status表示 | PASS：2 focused tests。owner認証、同一request outcome、raw field除外、Runtime tokenなしの達成表示を確認。同file残り132件はNOT_RUN。 |
| 共通J outcome projection | PASS：4 focused tests。D4／owner actorの分離、明示規則と証拠digest、保留・曖昧・不正のfail-closedを確認。 |
| `git diff --check`／`pnpm docs:check` | PASS（本記録を含むcloseout時に再実施）。 |
| WebChat全fileを誤って無filter実行 | 130 passed／4 failed。当該失敗のうち新status test harness 1件は修正しfocused再実行PASS。残り3件は変更範囲外のRecovery scope projection／app shell copy／owner L3 selectorに関する失敗報告で、本BUILD_BATCHでは原因調査していない。全suiteや全体QCの証拠へ転用しない。 |
| 全suite、実provider／外部作用、5OS、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / owner submission receipt→request-bound J outcome→Control Center status。
- **STATUS:** WIRED（ownerの明示規則・検証済み根拠をstatus consumerまで表示する限定経路）。製品全体はQE_BUILD P2継続、`SYSTEM_SHAPED=false`、`BUILD_COVERED=false`。
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業で⓪→④を再同期し、最新mainとrev5.0全域からproducer→consumer欠損を選ぶ。個別QC／QAへ移らない。
- **SAFETY_STATUS:** HDS-J／Approval／Broker／M authorityは不変。owner tokenで読取のみ、結果は非権威・実行不可。明示規則と検証済みJ outcome以外で達成を表示しない。D4 Runtime task inputは引き続き限定信頼で、owner明示規則を受け取らず、そのtask outcomeは規則設定がない限りheldとなり得る。D4 repo変更、実provider、外部作用、C08.03、OD-03、P13公開／出荷GOは対象外。
- **LOCAL_ASSET_STATUS:** WebChat／Gateway ignored build outputは作業環境として保持。新規persistent fileなし。test専用状態はmemory fixtureで、追加Temp／SQLiteなし。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。rev5 ZIPから作った一時読取copyは削除確認済み。D4 mainは読み取りのみ。
- **GIT_STATUS:** 開始local／`origin/main`／GitHub `main`=`96916e543096f7637c3a1b42abe756709242f940`、ahead／behind=0/0。開始local recovery branchとGitHub recovery tagのcurrent／previousは`96916e543096f7637c3a1b42abe756709242f940`／`0f2842075d0d999c6ea55dbb122c085623d7c7c8`。fetchはstale worktree metadataの削除ACL拒否を報告したため、そのmetadata／ACLには触れず、`ls-remote`でGitHub mainとtag二世代を直接照合した。終了SHA・refs・protected untrackedはcloseoutで再照合する。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / Cron result receiptからJ・M回復consumerへの相関接続

主語はBLUE GatewayのCron handler返却、既存J Operation Planのtask outcome／M receipt参照／最終出力監査digest、およびread-only Recovery Inspector／Operation Plan／Control Centerである。目的は、handlerの返却を成功と誤認せず、同じCron eventに結び付く現在観測可能なJ・M・最終出力状態をdigest-only receiptへ保存し、後続の回復調査consumerへ渡すこと。rev5.0 P2全体施工内の限定接続であり、W-WORK／E01.01全体の完了ではない。

新しい`cron_event_result_receipt` SQLite tableへ、Cron event settleと同一transactionで非権威・実行不能の完了観測receiptを保存する。receiptはrequest-bound J `task_outcome`、current revisionの既存M receipt digest集合、`final_output` historyのrendered-output digest／観測状態だけを保持し、raw source／payload／output、command、tokenを含めない。J projectionのrecovery refreshがreadyでない場合はJ outcomeを未検証、Mが未設定・未観測・利用不能の場合はreceipt不在を成功扱いしない。Mを書き込む新writer、実結果の推測、自動再送を追加しない。`handler_returned`は引き続きhandler lifecycle状態であり、仕事や外部作用の成功を意味しない。旧SQLiteはresult tableがなくてもread-only inspection可能で、結果receiptは未観測として扱う。

Recovery Inspectorはreceipt digestとevent identity／`handler_returned`を検証し、Operation PlanのCron result依存へ接続する。Control Center operator projectionをschema 15へ更新し、receipt status、J outcome、M receipt件数/digest、最終出力状態/digestを読み取り表示データへ含める。異常・上限による未照合は成功に昇格させず、read-only／非権威境界を維持する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Gateway／WebChat typecheck、Gateway／WebChat build | PASS（buildはcloseout前に実行）。 |
| Cron result receipt builder／store／Recovery Inspector／Operation Plan相関 | PASS：対象5 files・61 tests。receipt整合性、raw非保存、J/M未確定時の未観測化、atomic settle、再open、履歴event照合、read-only、schema 15を確認。 |
| Cron channel | PASS：18 tests。handler返却後のreceipt保存と例外時`outcome_unknown`を含む。test fixtureは現行必須event storeを使用。 |
| WebChat Control Center Recovery surface | PASS：1 test。新schema・receipt件数／availability・Cron result項目を含む応答を確認（同fileの他132件はNOT_RUN）。 |
| `git diff --check`／`pnpm docs:check` | PASS。日本語基底移行負債は既存継続。 |
| 合計focused Gateway tests | PASS：79 tests（対象6 files）。 |
| full suite／実Cron仕事の成功・実外部receipt／実provider／5OS全体／SYSTEM_SHAPED／BUILD_COVERED／QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Cron event→digest-only J・M result observation→recovery consumer（W-WORK、E01.01関連接続）。
- **STATUS:** WIRED（限定した観測receiptとread-only inspector／Control Center。新規M更新・仕事成功判定・W-WORK全域は未成立）。
- **NEXT_REQUIRED_CONSUMER:** 次の独立単位で⓪→④を再同期し、rev5.0 P2全体成立に必要な未接続producer→consumerを最新mainと実物から再選定する。局所QC／QAへ移らない。
- **SAFETY_STATUS:** HDS-J／Approval／Broker／Mのauthorityと書込み責任は不変。receiptはdigest-only、非権威、実行不能。`handler_returned`を成功へ読み替えず、自動再送・実provider・外部作用なし。C08.03、OD-03、他repo、P13公開／出荷GOの保留を維持。
- **LOCAL_ASSET_STATUS:** test-owned Temp root／SQLiteは各test後cleanup。ignored Gateway／WebChat build outputは稼働開発物として保持。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。credential／OneDrive資料／owner data／外部artifactなし。
- **GIT_STATUS:** 編集開始local／`origin/main`／GitHub `main`=`0f2842075d0d999c6ea55dbb122c085623d7c7c8`、開始recovery current／previous=`0f2842075d0d999c6ea55dbb122c085623d7c7c8`／`6a92af5208d8bc1408f8282c102eec6d894585e1`。終了HEAD／二世代ref／clean stateはGit closeoutで再照合する。protected untracked pathsはstageしない。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / Cron event履歴から回復consumerへの相関接続

主語はBLUE GatewayのCron inbox/outbox高水位cursor、過去event receipt、Operation Plan回復照合である。目的は、同一sourceの新しいeventでcurrent cursorが進んでも、以前のscheduled eventと計画の関係を保持し、再起動・復旧時に結果状態をdigestだけで再観測できるようにすること。rev5.0のP2全体施工内で、W-WORKとE01.01「永続jobと重複event」に関係するproducer→consumer接続である。

cursorの重複・順序逆転・高水位拒否は維持し、進行前のcursorを`cron_event_archive`へdigest-onlyで保存する。旧schemaでcurrent cursorから外れたままapproval handoffに残るeventは`outcome_unknown`として補助移行し、成功を推定しない。read-only recovery inspectorはcurrent cursorとarchiveを検証し、Operation Plan request digestから過去event receiptへ相関する。Consumerは`not_in_retained_event_history`と`not_in_current_cursor`を区別する。Gateway report/operator projectionはschema 10→11／13→14へ更新し、WebChat Control Centerはarchive集計と`cron_event`未観測依存を受け取る。CLIにもarchive schema/countを表示する。raw task/source/payload、approval権限、再送許可、job成功判定は追加しない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Gateway／WebChat typecheck・Gateway build | PASS（closeout後SHAはfinal reportに照合）。 |
| Gateway Cron store／recovery inspector／Operation Plan recovery tests | PASS：57件。prior event retention、legacy cursor-only read、handoff migration as `outcome_unknown`、archive corruption fail-closed、Operation Plan correlationを確認。 |
| WebChat Recovery surface selector | PASS：1件。new operator schema、verified archive counts、`not_in_retained_event_history`と`cron_event`未観測scopeの受理を確認（同fileの他132件は未実行）。 |
| `git diff --check`／`pnpm docs:check` | PASS。docs check／日本語基底／licensing gateが通過。移行負債75件は既存継続。 |
| 全suite／実Cron job成功・外部receipt／5OS全体／SYSTEM_SHAPED／BUILD_COVERED／QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Cron historical event-to-recovery correlation（関係索引E01.01、縦断W-WORK。E01.01全体の完了を意味しない）
- **STATUS:** WIRED（current cursor→digest archive→read-only recovery inspector→Operation Plan／Control Center。job全体の最終結果receiptとW-WORK全域は未接続）
- **NEXT_REQUIRED_CONSUMER:** P2全域施工を続け、Cron eventから永続jobの実result receipt・M記憶／再判断へ繋がる次consumerを現物で選ぶ。局所QC／QAへ移らない。
- **SAFETY_STATUS:** current high-water、重複抑止、HDS J／Approval／L3／Broker、M非権威、停止／再送境界は維持。archiveはidentity/state/time digestのみ。旧handoffからのevent状態は`outcome_unknown`。`handler_returned`はjob成功を証明せず、inspectionはread-only・非権威。
- **LOCAL_ASSET_STATUS:** unit testsのTemp root／SQLiteは終了時cleanup。ignored Gateway build outputは作業用として保持。`.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保護対象として保持・未変更。実資格情報・外部provider・外部作用・別repoは未使用。
- **GIT_STATUS:** 開始local／`origin/main`／GitHub `main`=`6a92af5208d8bc1408f8282c102eec6d894585e1`、ahead／behind=0/0。開始recovery local branch／remote tag current／previous=`6a92af5208d8bc1408f8282c102eec6d894585e1`／`2236fcf18a8cb5c54133a3c5c1359a4b24ed74ce`。終了後にmain・両世代を再照合する。既存stale worktree metadataのACL／metadataは変更しない。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / Approval Gate restart recovery journal

主語はBLUE Gatewayのprocess-local Approval Gate待ち状態と、Gateway再起動後のowner向け復旧表示である。目的は、監査永続化が無効でも未決承認を失わず、旧tokenやraw仕事を復元・再利用せず、承認処理中断の結果不明を明示すること。既存のHDS/J単独authority、Approval Gate、L3 review、Broker、M非権威境界は変更していない。

`BLUE_TANUKI_STATE_ROOT/private-state/approval-recovery`にdigest-only SQLite journalを接続した。記録するのはdomain-separated command/request SHA-256 digest、状態、時刻だけ。承認token、command/proposal本文、引数、originは保存しない。新しい待ちをtoken提示前に永続化し、owner verdictの処理開始時はSQLiteの一回限りCASで`pending → resolving`へ遷移させる。再起動時に残る`pending`は`interrupted`、`resolving`は`outcome_unknown`にし、どちらも旧承認を実行・再送せず、新しい依頼を要求する。同期処理例外も`outcome_unknown`へ投影する。キャンセル・完了時にjournalを閉じる。

owner向けResident Notifications／Control Centerへdigest参照と回復状態を接続した。`outcome_unknown`は実行結果を推定せず、receipt確認前の再実行を避ける次行動を示す。保存不成立・競合時は旧承認をfail-closedにし、journalは判断権限を持たない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Gateway／WebChat typecheck、package build | PASS。 |
| approval journal／resident notification tests | PASS：29件。raw ID／tokenのDB非保存、restart state回復、原子的one-time resolution、digest-only表示、unknown結果の再実行抑止を確認。 |
| 変更後distによるGateway L3経路 | PASS：`BT-U-E2E-01 keeps synthetic file.delete behind reviewed L3 and stops on a stale target`、1件PASS／7件skip。外部providerなし、隔離fixture。 |
| `pnpm docs:check` | PASS。日本語基底の移行負債75件は既存継続。 |
| `git diff --check` | PASS。 |
| 長時間C08.02統合selector | 変更前のdistで起動し、別のOperationPlan `file.search.parameters` assertionに到達してFAIL。現行変更sourceをロードしていないため、今回の実装評価には数えず履歴へ記録。 |
| 全suite／Gateway再起動を含むserved approval E2E／実provider／外部作用／全OS／SYSTEM_SHAPED／BUILD_COVERED／QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / digest-only Approval Gate restart recovery journal
- **STATUS:** WIRED（pending作成→CAS verdict開始→通常L3 consumer／restart interruption projection。実Gateway process killを跨ぐ新journal E2Eは未実施）
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体施工を継続し、全要求・5OSのC/J/M／Broker／Approval／channel入口から次の未接続consumerを再選定する。局所QAへ移らない。
- **SAFETY_STATUS:** HDS authority／L3／Brokerと仕事実行規則は不変。journalは非権威で旧approvalを復元しない。result unknownで自動再送しない。C08.03 live provider HOLD、D4／MINIDORA別repo、公開・出荷GO境界を維持。
- **LOCAL_ASSET_STATUS:** store／notificationのtest-owned Temp rootとserved Gateway fixtureは終了時cleanup。追加ignored package `dist`は開発実行用に保持。既存`.blue-tanuki/private-state`、protected `.codex-attachments/`／`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。資格情報／OneDrive資料／owner dataは対象外。
- **GIT_STATUS:** 編集開始local／`origin/main`／GitHub `main`=`2236fcf18a8cb5c54133a3c5c1359a4b24ed74ce`、ahead／behind=0/0。開始recovery local branch／remote tag current／previous=`2236fcf18a8cb5c54133a3c5c1359a4b24ed74ce`／`b2d507cc3b48e75ceb3696d811909f571d01e27a`。`git fetch`は既存stale worktree metadataのACL拒否で失敗したためmetadata／ACLを変更せず、`git ls-remote`でmainと両remote recovery tagを直接照合した。closeout後にhead・保護差分・復旧二世代を再照合する。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / MCP restart-safe runtime observation consumer

主語はBLUE Gateway MCP Adapterの通常呼出し観測とConnections SettingsSurface。目的は、Gateway再起動後も保存済み状態を読み、応答未観測のtool dispatchを`outcome_unknown`としてownerへ提示すること。MCP endpointのcanonical SHA-256 digest・状態・時刻だけを最大8件、private-state SQLiteへ保存する。CLI／常駐Gatewayのtool実装とSettingsSurfaceに同じstoreを注入した。SettingsSurfaceはprobe・process起動を行わず、観測はJ／Approval／Brokerに権限を与えない。

再起動時の`dispatching`は`outcome_unknown`へ遷移し、自動再送を拒む案内を表示する。endpoint本文、tool名、引数、response、raw errorは保存しない。live provider／MCP server、health monitor、server process管理、既存server設定migrationは対象外であり、F08.03全体は未成立。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Gateway typecheck | PASS。 |
| `settings_surface.test.ts` | PASS 17/17。永続再open、interrupted dispatchのunknown復旧、設定面consumer、endpoint本文非保存。 |
| `mcp_connection_client.test.ts` | PASS 5/5。既存の合成process経路と未再送。 |
| 全suite／全MCP互換／live provider／全OS／SYSTEM_SHAPED／BUILD_COVERED／QE_QC／QE_QA | NOT_RUN／未成立。 |

- **UNIT_ID:** rev5.0 QE_BUILD / MCP restart-safe runtime observation consumer
- **STATUS:** WIRED（通常呼出し→SQLite→再起動後SettingsSurface。process-local runtime healthではない）
- **NEXT_REQUIRED_CONSUMER:** rev5.0 P2全体施工を継続し、全要求・5OS入口に跨る未接続consumerを現物から再選定する。F08個別QAへ滞留しない。
- **SAFETY_STATUS:** 非権威の観測のみ。J／Approval／Broker、M権限、外部作用、C08.03 live provider、D4／MINIDORA別repo、公開・出荷境界に変更なし。
- **LOCAL_ASSET_STATUS:** Test-owned temp root／SQLiteはcleanup済み。追加build artifactなし。protected attachments／Linux isolation targetは保持。
- **GIT_STATUS:** 開始local／origin／GitHub main=`b2d507cc3b48e75ceb3696d811909f571d01e27a`、ahead／behind=0/0。開始recovery current／previous=`b2d507cc3b48e75ceb3696d811909f571d01e27a`／`8233761b3b533d707e39932e6e442886a4a75c5a`。closeout後のHEAD／ref再照合を実施する。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / synthetic same-workspace edit-test adapter profile

主語はOperationPlanからshell execution adapterへ渡る、開発用の固定失敗test profileである。目的は、plannerへraw commandを持たせず、編集後test・同一Workspace再読取・失敗時の再計画経路で必要な`shell.exec` consumerを成立させること。対象は`packages/blue-tanuki/src/llm/synthetic_file_write_plan.ts`、`packages/blue-tanuki/src/tools/shell_exec.ts`とそのadapter contract／限定testである。

synthetic backendは`cmd`／`args`を含めず、固定profile IDだけをOperationPlanへ出す。shell execution adapterは、その一つの既知profileだけを明示的なsynthetic backend opt-in下かつ非productionで受け、Windows `cmd.exe`／Linux `sh`から終了コード23を返す固定processへ変換する。unknown profile、opt-in不在、production、profileとraw commandの併記は拒否する。既存のraw-command拒否、shell L3、Brokerのroot/cwd照合、same-workspace、summary-only、native process isolationを維持する。

| QE_BUILD限定確認 | 結果 |
|---|---|
| core `typecheck`／`git diff --check` | PASS。 |
| `pnpm docs:check` | PASS。前工程で変更済みの`install/resident/README.md`の登録hashだけを移行台帳へ同期し、移行負債75件は維持。 |
| Operation Coreのclosed profile受理／raw command拒否 | PASS：選択した2 test。 |
| profile opt-in／unknown／raw command併記の拒否 | PASS：選択した2 test。 |
| Windows native isolation profile smoke | PASS：exit code 23、process tree empty、出力本文なし。これはshell adapter単体の検査で、GatewayのHDS／Approval／Broker全経路証拠ではない。 |
| Gateway全経路、Linux native isolation、full suite、5OS実機／QA、QE_QC／QE_QA | 未実行。 |

- **UNIT_ID:** rev5.0 QE_BUILD / synthetic same-workspace edit-test adapter profile
- **STATUS:** WIRED（OperationPlan schemaとWindows shell adapterの固定profile接続。Gateway全経路は未確認）
- **NEXT_REQUIRED_CONSUMER:** 最新mainとrev5.0からP2の全域consumerを再選定し、局所QAへ移らず製品全体のC/J/M／OS入口結線を進める。
- **SAFETY_STATUS:** profileは任意command実行機能ではない。raw command fieldは従来どおり拒否。HDS authority／L3／Approval／Broker／M、実provider、外部作用、他repo、公開・出荷境界に変更なし。
- **LOCAL_ASSET_STATUS:** 選択testが作成した専用Temp directoryはtest終了時に除去。profile processはprocess tree emptyを確認。既存のprotected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は維持・未変更。
- **GIT_STATUS:** 開始local／`origin/main`／GitHub `main`=`8233761b3b533d707e39932e6e442886a4a75c5a`、ahead／behind=0/0。開始recovery current／previous=`8233761b3b533d707e39932e6e442886a4a75c5a`／`063c18c81262962d785ee86dca4a3d6f5ff7b948`、remote tagも一致。closeout push後はlocal／`origin/main`／GitHub `main`を一致させ、recovery current=final main、previous=開始mainとする。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / Windows portable resident PID ownership and stop confirmation

主語はWindows portable installerのresident helper、目的は記録PIDをBLUE-TANUKI Gatewayと照合してから状態表示・停止し、PID再利用による無関係なprocess操作を拒否すること。対象は`install/resident/blue-tanuki-resident.ps1`であり、既存product launcher、HDS authority、Approval、Gateway運転契約は変更していない。

`blue-tanuki.pid`の読込失敗・不正値を空扱いせず停止する。Win32 process executable path、handle path、Gateway entry point、`--serve`、env-file pathを照合し、識別不能または他processならstatus/start/stopをfail-closedにする。停止時は同じprocessのStartTimeを再照合し、process handleへの停止要求後10秒以内の終了を確認する。終了未確認ならPID記録を保持する。portable resident説明書にもこの境界を反映した。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Windows PowerShell AST parser | PASS：resident helper構文解析。 |
| `git diff --check` | PASS。 |
| Windows synthetic process owner-denial smoke | PASS：無関係PowerShell PIDをexit 2で拒否し、process継続とPID record保持を確認。 |
| Windows synthetic owned-process lifecycle smoke | PASS：隔離Node processを所有Gatewayとして認識し、process handle停止・終了待ちの後にPID recordが消えることを確認。 |
| Windows installed smoke、installer tests | 未実行。 |
| product launcher、OS常駐設定、自動起動、owner data、外部作用 | 変更なし。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Windows portable resident PID ownership and stop confirmation
- **STATUS:** WIRED（既存portable resident start/status/stop commandへ接続。isolated synthetic process smokeは確認済み、installed製品は未確認）
- **NEXT_REQUIRED_CONSUMER:** rev5.0と最新mainからP2全体BUILDの次consumerを選ぶ。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA未成立。
- **SAFETY_STATUS:** process identityが不明・不一致ならsignalせずPID recordを保持。C/J/M authority、Approval Gate、秘密、実provider、外部作用、別repo、release／owner GOに変更なし。
- **LOCAL_ASSET_STATUS:** 作業用Temp root 4件をWindowsごみ箱へ移動（元:`C:\Users\ohira\AppData\Local\Temp\blue-tanuki-resident-pid-negative-019c083cc8594a0198ef1eaddfb8bcc0`、`...negative-5509b45cb4ab43a28f699878e94b8b39`、`...negative-9343c8cbcd044b4c85f713d3e0b3e508`、`...positive-adc1c83804a842f9adf600f65ec98ed7`。4 root／7 files／52 bytes、owner最終処分待ち）。各元pathの消失とごみ箱内収容を確認。synthetic PowerShell／Node processは停止確認済み。protected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。
- **GIT_STATUS:** 開始local／GitHub `main`=`6a86ce05ca644c53fcbef4b73510d10a1006581d`、追跡先と一致。開始recovery current／previous=`6a86ce05ca644c53fcbef4b73510d10a1006581d`／`74760dd7496ad4dc5326a9a966ffd8df6b16a3fe`、remote backup tagも同SHA。closeout時に最終SHA／refsを再照合する。

## 完了BUILD_BATCH — rev5.0 QE_BUILD / shell.exec Doctor readiness projection

主語はGateway Doctorの`shell.exec`準備状態projectionとRemediationである。目的は、native isolation providerの有無と`BLUE_TANUKI_SHELL_ROOT`設定の有無を区別し、利用者に対して実際の停止理由と次の設定操作を正確に示すこと。Doctorは秘密やroot pathを読出・表示せず、shell commandも起動しない。

providerが存在しても専用root未設定なら`shell.exec`がdisabledであることを明記する。root設定済みの場合も値を開示せず「未検査」とし、各呼出しでroot・lifecycle制御を再検証することを示す。provider不足時は、root設定だけで有効化できないことと、Linuxで必要なbubblewrap／user systemd／cgroup v2 controlsをRemediationへ表示する。CONFIG.mdは日本語移行負債登録中のため変更せず、Doctor／Remediationとこのactive recordの範囲へ説明を置いた。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `pnpm --filter @blue-tanuki/gateway build` | PASS：Gateway TypeScript build。 |
| `git diff --check` | PASS。 |
| Doctor／Remediation runtime、shell.exec execution、test suite | NOT_RUN。 |
| Shell execution authority／Broker／Approval policy、native provider、root値の検査・表示 | 変更なし。 |

- **UNIT_ID:** rev5.0 QE_BUILD / shell.exec Doctor readiness projection
- **STATUS:** WIRED（Doctor→Remediationへの構成状態射影。runtime未確認）
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業でrev5.0と最新実物からP2全体施工に必要なconsumerを選ぶ。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。
- **SAFETY_STATUS:** HDS authority、L3、Broker、command execution、秘密、外部作用、別repo、公開／出荷判断に変更なし。
- **LOCAL_ASSET_STATUS:** 既存ignored build outputは保持。test専用一時assetなし。protected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。
- **GIT_STATUS:** 編集開始local／`origin/main`／GitHub `main`=`74760dd7496ad4dc5326a9a966ffd8df6b16a3fe`で一致、ahead／behind=0/0。local recovery branch current／previous=`74760dd7496ad4dc5326a9a966ffd8df6b16a3fe`／`01267a1722a862018cf64ac84e806863d2be233c`、remote backup tag current／previousも同SHA。closeout時にcommit／push後のSHAとrefを再照合する。

## 完了BUILD_BATCH — QE_BUILD / rev5.0 Linux x64 hosted installed lifecycle consumer（最新main）

主語はLinux x64の製品installer、installed Gateway／Control Center、既存の手動Actions lifecycle consumerである。目的は、最新main SHAからpackageを生成・検証し、隔離環境のSetup・通常仕事・Repair・update rollback／中断復旧・通常Uninstall時の合成状態保持・再導入・明示Purgeまでをconsumerへ通すこと。これはQE_BUILDのhosted Linux証拠であり、特定distributionのinstalled QA、owner実機、製品全体のQC／QA・完成判定ではない。

既存workflowを`workflow_dispatch`でtarget=`linux`に限定。run [#15](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43316577235)はsource SHA=`37ca041caa573956b3181f11b51032123df2175f`でsuccess（6分25秒）。Ubuntu 24.04.5 LTS／x86_64、runner image `ubuntu-24.04` version `20261111.370.1`、kernel `7.0.0-1017-azure`、glibc 2.39。Linux job [131526056630](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43316577235/job/131526056630) success、macOS jobはselectorによりskip。installer SHA-256=`d1fd47962e4df1dc8abf459990627821ae41034c796eeedfa7936a8bfa9caec3`。

| hosted Linux lifecycle smoke | 結果 |
|---|---|
| source entrypoint／package build・manifest・runtime検証／Setup | PASS。workflowのNode.js 22.23.3、Rust 1.95.0、pnpm 9.12.0でbuildし、隔離rootへ導入。 |
| bundled runtime／Gateway・Control Center起動、synthetic first message、Repair、port conflict、Approval／Audit／crash recovery、stop／restart／safe mode | PASS。healthz／appはHTTP 200。providerはstub、資格情報・実provider・外部作用なし。 |
| update失敗rollback／中断update復旧・再開／通常Uninstall後の合成DataRoot・ConfigRoot・runtime state保持／再導入／明示Purge | PASS。 |
| doctor | PASS。ただしrunnerではLinux isolationに必要な構成要素（provider／bubblewrap／systemd user manager／cgroup limits）のいずれかが利用できず、`shell.exec`は無効のままfail-closed。Linux isolationの稼働証拠ではない。 |
| workflow warning | GitHub Actions annotation 1件：`actions/checkout@v4`と`actions/setup-node@v4`のNode.js 20 runtimeが非推奨となりNode.js 24へ強制移行された。workflowはsuccess。 |
| artifact／ローカル生成物 | GitHub Actions artifactは0件。隔離runner rootは専用prefix確認付き`trap cleanup`で除去。製品build／artifactのローカル生成・取得なし。最終報告用のrun screenshot 69,167 bytesをTempに保持。 |
| docs:check／git diff --check | PASS。日本語基底の移行負債75件は残存。 |
| 複数distribution、OS login／reboot、実system service／Secret Service、owner実機QA、実provider／資格情報、全suite、5OS QA、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / Linux x64 hosted installed lifecycle consumer on current main
- **STATUS:** WIRED（このUbuntu 24.04.5 hosted smoke限定。Linux全distributionや製品全体へ拡張しない）
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業で⓪→④を再実施し、rev5.0と最新実物からP2全体成立に必要な次consumerを選ぶ。
- **SAFETY_STATUS:** synthetic isolated stateのみ。HDS authority、Approval、owner data／資格情報、実provider、外部作用、別repo、署名資格、公開／出荷判断へ変更なし。
- **LOCAL_ASSET_STATUS:** Actions artifactなし、製品build／artifactのローカル生成・取得なし。final report screenshot `C:\Users\ohira\AppData\Local\Temp\blue-tanuki-run-43316577235-proof.png`（69,167 bytes）は証拠表示用に保持。runnerの`/tmp/blue-tanuki-g0301-linux.*`はcleanup済み。protected `.codex-attachments/`、`.codex-remote-attachments/`、Linux isolation `target/`は保持・未変更。
- **PRODUCT_STATE:** QE_BUILD継続。`SYSTEM_SHAPED=false`／`BUILD_COVERED=false`、QE_QC／QE_QA未開始、P13 `PENDING_OWNER_GO`。C08.03実provider、OD-03 live external action、別repo変更は引き続き保留。
- **GIT_STATUS:** run開始時local／origin／GitHub `main`=`37ca041caa573956b3181f11b51032123df2175f`、ahead／behind=0/0。開始recovery current／previous=`37ca041caa573956b3181f11b51032123df2175f`／`4b4f25b7b5becf06c245124b5b64594f3e9dc897`。closeout commit／push後の最終HEADと二世代refは終了時に再照合する。

## 完了BUILD_BATCH — QE_BUILD / rev5.0 G04 macOS x64／arm64 installed lifecycle

主語はmacOS x64／arm64の製品Setup、installed Gateway／Control Center、既存の手動Actions lifecycle smokeである。目的は、固定したmain commitから両architectureのSetup・起動・仕事疎通・update recovery・通常Uninstall時のowner data保持・再導入・明示Purgeまでを既存consumerへ通すこと。これはQE_BUILD内のmacOS hosted runner証拠であり、実owner端末QA、製品全体のQC／QA、完成・公開判定ではない。

GitHub Actions run [#14](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43305145958) は既存workflowを手動workflow_dispatchで起動し、target=macos、scope=installed-lifecycle、対象SHA=4b4f25b7b5becf06c245124b5b64594f3e9dc897を使用。x64 [job](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43305145958/job/131486338920) とarm64 [job](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43305145958/job/131486338509) は両方success、Linux jobはskip、artifact uploadなし。

| macOS hosted lifecycle smoke | 結果 |
|---|---|
| x64／arm64のSetup、bundled Node、doctor、既存environmentを保つRepair、autostart状態・有効化、port conflict拒否 | PASS |
| Gateway／GUI起動、health、synthetic WebSocket first message、approval／audit／crash recovery／restart／safe-mode | PASS。providerはstub、credential／実provider／外部作用なし。 |
| 注入update失敗のrollback、意図的中断後の旧app recoveryとresume | PASS |
| 隔離smokeのsynthetic owner data／configを通常Uninstall後に保持、再導入後も保持、明示Purgeで対象data／logsを除去 | PASS |
| docs:check／git diff --check | PASS。日本語基底の移行負債75件は残存。 |
| macOS host reboot、owner実機QA、署名／notarization、実developer account、full suite、5OS QA、QE_QC／QE_QA | NOT_RUN。 |

- **UNIT_ID:** rev5.0 QE_BUILD / G04 macOS x64／arm64 hosted installed lifecycle consumer
- **STATUS:** WIRED（両architectureのhosted lifecycle smoke限定。owner端末・製品全体へ拡張しない）
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業で⓪→④を再実施し、rev5.0と最新実物からP2全体成立に必要な次consumerを選ぶ。
- **SAFETY_STATUS:** HDS authority、Approval、owner端末のdata／credential、実provider、外部作用、別repo、署名資格、公開／出荷判断へ変更なし。workflowは合成providerを使用しartifactをuploadしていない。
- **LOCAL_ASSET_STATUS:** workflow artifactを取得せず、今回のrunで新規ローカル成果物なし。作業前からあるprotected .codex-attachments/、.codex-remote-attachments/、Linux isolation target/は保持・未変更。
- **GIT_STATUS:** 開始local／origin／GitHub main=4b4f25b7b5becf06c245124b5b64594f3e9dc897、ahead／behind=0/0。workflowはこのSHAを固定使用。recovery current=4b4f25b7b5becf06c245124b5b64594f3e9dc897／previous=7b84ed33872a2631d3351964a109042365c7d196。closeout記録の最終main／復旧refはpush後に再照合する。

## 前段完了BUILD_BATCH — QE_BUILD / Windows x64 IExpress EXE → 隔離Setup → Gateway起動・停止

主語はWindows x64の単一EXE配布入口、埋込Setup CMD、既存の隔離installed smokeである。目的は、生成済みEXEの埋込CMDとZIPを照合したうえで、そのCMDから隔離InstallRoot／DataRootへSetupを通し、installed Gatewayの起動・health・停止、正規Uninstallと隔離状態の回収まで実consumerへ接続すること。通常のGUI起動・default launch、全lifecycle、製品全体の完成判定はこの単位に含めない。

IExpressのPE/CAB・manifest・SHA sidecar・埋込CMD・埋込ZIP照合を共有関数`verifyAndExtractWindowsIExpressCommand`へ集約し、standalone verifierとinstalled smokeで同じ契約を使う。`smoke_windows_installed.ts --iexpress-exe <EXE> --artifact <ZIP> --startup-only`は、別個に指定されたZIPとEXEのmanifest／hash bindingを確認してから、EXEの実CMDを隔離環境で実行する。既存のZIP経路、process／registry preflight、正規Uninstall／Purge cleanupは維持した。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `corepack pnpm typecheck`／`corepack pnpm build` | PASS。型検査がworkspace `dist`を削除する既存動作の後、15 workspace projectsを再build。開始時と同じ14 `dist` directories／1,073 files／12,934,512 bytesへ復元。 |
| `package:windows:verify` | PASS。ZIP 3,553 entries、ZIP SHA=`4d5459784bfbaefe9c2b4126c1b75e08e27b25da9cee7f9cae3503b1e6d68ce1`、CMD SHA=`ae295b7a3ba11da3e0b9c07e7af5b993e6b84859aaa3cc860e78f728bf128dd5`、EXE SHA=`a58658f54d086073bfaa4512082906dfb12f37bc78ae9d596f7e3f26c71e6133`。IExpress抽出PASS。standalone verifier単独ではSetupを起動せず`setup_execution=NOT_RUN`と報告。 |
| Windows `smoke:windows-installed --iexpress-exe ... --startup-only` | PASS。開始時Gateway processなし、既存製品uninstall／autostart登録なし。EXE CMD抽出、CMD→ZIP hash一致、埋込Setup、stub providerで隔離導入とpost-install doctor、Gateway起動・health応答・停止、正規Uninstall/Purge、registry不在を確認。資格情報・外部providerなし。 |
| `validate:packaging`／`validate:release-hardening`／`docs:check`／`git diff --check` | PASS。Actionsはmanual `workflow_dispatch`限定。日本語基底の移行負債75件は残存。 |
| IExpress通常GUI／default launch、full Windows lifecycle smoke、実provider、全suite、他OS QA、QE_QC／QE_QA | NOT_RUN。署名なしcandidateの公開・配布は引き続きHOLD。 |

local assets: 非OneDrive artifact directory `C:\Users\ohira\AppData\Local\Temp\blue-tanuki-windows-artifacts-rev5-20261113`の10 files／174,749,451 bytesを保持。workspace `dist`14 directories／1,073 files／12,934,512 bytesとLinux isolation `target`31 files／10,462,590 bytesを保持。2回の隔離smoke rootとIExpress extraction、outer CMDのTemp payload、InstallRoot／DataRootは成功確認後にcleanupし、root残存0を確認。2回目は`.codex-tmp/windows-install-entrypoint/install.log`のreparse-point pathが前後SHA=`374457099b707771a78bb753f04fdb5b2fbc0dca4341a9ee4ef992d1df9fd043`／更新時刻不変。初回smokeは既定WorkRootで同fileを79-byte開始記録へ更新した。前状態の内容は未記録であり、推測復元せず保留する。後続runが同じpathへ書かないようsmokeにtask-owned WorkRootを設定。OneDrive `release/windows`既存ZIP／manifest／sidecar／READMEは開始hashと一致。protected attachment directoriesは未stage。

- **UNIT_ID:** rev5.0 QE_BUILD / Windows EXE embedded Setup → installed Gateway startup/health/stop → isolated Uninstall cleanup
- **STATUS:** WIRED（このWindows installed consumer限定。通常GUI/default launchと全lifecycleは未確認）
- **NEXT_REQUIRED_CONSUMER:** 次の独立作業開始時に⓪→④を再実施し、最新rev5.0と実物からP2全体成立に必要な次consumerを再選定する。
- **SAFETY_STATUS:** HDS authority、Approval、owner data、秘密、実provider／外部作用、別repo、release／owner GOへ変更なし。隔離smokeだけで作成した製品状態を正規Uninstall経由で除去。
- **GIT_STATUS:** 開始local／origin／GitHub `main`=`f9550b5e01e6867c78895402e57b83e636470fd9`、ahead／behind=0/0。実装commit=`7b84ed33872a2631d3351964a109042365c7d196`を`main`へpush。実装push直後にrecovery current=`7b84ed3`／previous=`f9550b5`をCAS更新。closeout docs commit後の最終HEAD／refsは報告時に直接照合する。

## 前段完了BUILD_BATCH — QE_BUILD / Windows x64単体EXE生成・抽出検証

主語はWindows x64のinstaller package builderとIExpress verifier。目的は、通常利用者が一つの`.exe`からWindows Setupを開始できるpackageを生成し、そのEXEからSetup commandと埋め込みZIPが改変なく抽出されることを検証すること。Setup実行・製品導入・runtime成立をこの工程へ含めない。

`package:windows`はWindows ZIP／CMDを既存payloadとして生成・検証した後、IExpress `.exe`とmanifest／SHA-256 sidecarを追加する。OneDrive checkoutからの生成物は`BLUE_TANUKI_WINDOWS_ARTIFACT_DIR`で非OneDriveの出力先へ置き、builder stage／runtime cacheはOS Tempの一意directoryで処理する。release source bundleにもEXEとbuild／verify sourceを登録した。署名なし候補は配布保留をmanifest・README・verifier出力へ明示した。

| QE_BUILD確認 | 結果 |
|---|---|
| Windows `typecheck`／`build`／`package:windows` | PASS。 |
| `package:windows:verify` | PASS。ZIP 3,553 entries、CMD payload binding、IExpress PE/CAB、EXE SHA／manifest、Setup command抽出、埋め込みZIP hashを確認。EXE `a58658f54d086073bfaa4512082906dfb12f37bc78ae9d596f7e3f26c71e6133`。 |
| focused `windows_product_installer.test.ts` | PASS 21/21。 |
| `validate:packaging`／`validate:release-hardening`／`docs:check`／`git diff --check` | PASS。日本語基底移行負債75件は残存し、strict監査は未成立。manual `workflow_dispatch`限定。 |
| release bundle dry-run | PASS。Windows EXEがproduct installer manifestの対象に含まれることを確認。archive生成・archive verifierはOneDrive `release`／`.codex-tmp`のreparse point保護のため未実行。 |
| EXE Setup実行・isolated install／runtime smoke、full suite、全OS QA、QE_QC／QE_QA | NOT_RUN。 |

local asset classification: `C:\Users\ohira\AppData\Local\Temp\blue-tanuki-windows-artifacts-rev5-20261113`に10 files・174,749,451 bytesを保持。ZIP=`4d5459784bfbaefe9c2b4126c1b75e08e27b25da9cee7f9cae3503b1e6d68ce1`、CMD=`ae295b7a3ba11da3e0b9c07e7af5b993e6b84859aaa3cc860e78f728bf128dd5`、EXE=`a58658f54d086073bfaa4512082906dfb12f37bc78ae9d596f7e3f26c71e6133`。package／IExpress／verifierの成功時一時stageは残存なし。`pnpm build`の開発出力14 `dist` directories（1,073 files・12,934,512 bytes）と既存Linux isolation `target`（31 files・10,462,590 bytes）は保持。OneDrive `release/windows`の開始時に記録した4 artifactsはhash一致。保護添付directoryは未stage、未変更。古いworktree metadataの削除はPermission deniedで保留し、ACL・metadataを変更していない。

- **UNIT_ID:** rev5.0 QE_BUILD / Windows x64 IExpress single-file producer → extraction-only verifier
- **STATUS:** WIRED（EXE生成と内容抽出・hash照合まで。Setup／installed consumerは未接続）
- **NEXT_REQUIRED_CONSUMER:** EXEを隔離InstallRoot／DataRootで実行し、既存Windows installed smokeのSetup・起動・保持・Uninstall consumerへ接続する。
- **SAFETY_STATUS:** HDS authority、Approval、秘密、owner data、外部provider／作用、別repo、公開・配布は変更なし。署名なし・public distribution HOLD。製品全体`SYSTEM_SHAPED=false`／`BUILD_COVERED=false`、QE_QC／QE_QA未成立、P13 `PENDING_OWNER_GO`を維持。
- **GIT_STATUS:** implementation commit `2ea5ad78625956872268f5d65c57af2351ad4851`とcloseout記録をmainへpush済み。closeout後にlocal／`origin/main`／GitHub `main`と復旧ref二世代を照合した。

## 完了BUILD_BATCH — QE_BUILD / G04.01 macOS x64／arm64単体Setup生成・検証

主語はmacOS x64／arm64のarchiveと単体Setupを作るpackage builderである。目的は、macOS実行属性を保った製品installerを両architectureで生成・検証し、Windows hostが実行属性を保持できない条件で無効なUnix installerを成功扱いしないこと。製品の導入・常用・runtime・shell isolation全体の成立を示す作業ではない。

Windows上で作った`.command`は`chmod`後も実行属性が保持されず、product verifierが`installer is not executable`で両architectureとも拒否した。`scripts/package_product_installers.ts`はWindows hostから非Windows installerを要求された時点で書き込み前に停止し、Unix hostでは`chmod`後に実行mode bitを確認する。既存の不正出力は同一hashで残り、OneDrive同期状態を確定できないため移動・削除せず保留した。

GitHub Actionsの既存workflowへ`workflow_dispatch`入力`macos_scope=package-only`を追加し、Mac native build・archive verifier・単体installer verifierだけを走らせる。選択時はinstall／start、update／recovery／uninstall smokeをskipする。automation trigger、artifact upload、公開は追加していない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| Windows host guard | PASS。Windows上でのmacOS installer要求は書き込み前に拒否し、既存2つの`.command`のSHA-256が不変。以前の出力はverifierで`installer is not executable`と確認。 |
| macOS x64 runner build・archive／product verifier | PASS。archive 3,740 entries、SHA-256=`6fe7c6d6533ff5f984d2d53da70eefba73ee3772d7302c21cef3b428bfe22f27`。単体Setup SHA-256=`70df5c9b6c1826e88b7b4f2ec7c683a8c6e74dabcec223a933f25890692c4b02`。 |
| macOS arm64 runner build・archive／product verifier | PASS。archive 3,740 entries、SHA-256=`dd4f36f9815fb60670bd3c7f44d5db6c1aa577728776b1b62d2a99ab8156ab88`。単体Setup SHA-256=`2267a3b49f2d85ba15da9db9e88d2a4ea59fafb91cc2f5a443dd996a6b11b59d`。 |
| GitHub Actions [run #13](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43261840868) | PASS、attempt 2、固定commit=`83393469f2766d63589007b6118575e4ff251af1`。target=`macos`、scope=`package-only`。attempt 1はarm64 hosted runner取得失敗、failed jobだけ同一SHAで再実行。x64は再実行せずsuccess、Linuxはskip。 |
| YAML parse／`git diff --check`／`corepack pnpm docs:check` | PASS。 |
| install／start、update／recovery／uninstall smoke、署名／notarization、shell isolation、実Macでのowner環境利用、full suite、5OS QA、QE_QC／QE_QA | install lifecycle stepsは意図どおりskip。その他はNOT_RUN。生成物はunsigned・未notarized。 |

UNIT_ID: G04.01 macOS x64／arm64 native package producer → archive verifier → single-file product installer verifier
STATUS: WIRED（両Mac runnerでのpackage生成とverifierに限定）
NEXT_REQUIRED_CONSUMER: 次の独立作業で⓪→④を再実行し、現行rev4.0から未成立の実consumerを選ぶ。macOS shell isolationは未接続・無効のまま維持し、architecture choiceが設計され検証されるまで有効化しない。
SAFETY_STATUS: HDS authority、Approval、監査、owner GO、実credential、実利用者データ、別repo、外部作用、署名資格へ変更なし。未署名installerを公開していない。
LOCAL_ASSET_STATUS: task-owned Windows生成物6件（計173,001,743 bytes、2 architectureの`.command`／manifest／checksum）はrelease directory内で保持・保留。Windows product verifierの拒否を確認し、後段host guardは既存出力へ未接触。OneDrive同期状態が未確認のため削除・移動しない。hash一覧は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)に記録。前段で生成済みのMac archive／READMEは未変更で保持。`.codex-attachments/`／`.codex-remote-attachments/`／WSL Linux `target/`、古いworktree metadataは未変更。GitHub Actions artifact uploadなし。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始時local／`origin/main`／GitHub `main`=`9a20133a864d5c2a070cc0acde54a124af2d10ec`。検証済み実装commit=`83393469f2766d63589007b6118575e4ff251af1`をfast-forward pushし、Actionsはこの正確なSHAをcheckout。単位close時local／`origin/main`／GitHub `main`をcloseout記録commitへ一致させ、recovery current=最終main／previous=実装commitにする。temp Actions branchはrun閉鎖後にlocal／remote双方で削除済み。古い`.git/worktrees/blue-tanuki-health-2026-11-07-windows`へのcommit hook cleanupはPermission deniedで失敗したため保護を迂回せず保持。

## 完了BUILD_BATCH — QE_BUILD / Windows・Linux配布物のMCP runtime依存閉包

主語は`copyAppLayout`を使うWindows／Unix package builderと、導入後にMCP接続clientをimportするGatewayである。目的は、package内の`app/node_modules`から実行されるMCP clientとそのruntime依存を閉包し、ソース開発環境のhoisted／pnpm symlinkに依存せずWindows installed Gatewayを起動できるようにすること。

Windows installed smokeで`@modelcontextprotocol/client`の未同梱によりGateway起動が失敗する根因を確認した。builderは現行`apps/gateway`のMCP clientを`2.4.0`に固定し、client／core、transitive module群とMCP用zod v4をBLUEのroot zod v3と分離してpackageへコピーする。Windows／Unix両verifierはentrypointと依存package群を必須化する。Windows smoke runnerにはSetup→Gateway start／health→stopを行う`--startup-only`を追加し、既存`finally`の隔離Purgeで後片付けする。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `corepack pnpm package:windows`／`package:windows:verify` | PASS。installer ZIP SHA-256=`93d271176edd1cbb4945a98d732c2a39e4cb83432f5a2522377d6a309002f238`、3,549 entries。 |
| Windows installed `--startup-only` smoke | PASS。隔離Setup、Gateway health応答、launcher stop後の停止確認、既存finally Purgeとregistry後状態を確認。provider=stub、実provider／credential／外部作用なし。 |
| WSL Ubuntu 24.04 Linux isolation binary build、`corepack pnpm package:linux`／`package:linux:verify` | PASS。Linux tar.gz SHA-256=`a855bcba57a8be87498eadcf50d83ae60f43004aaf0cbc742753a4656ae56b58`、3,750 entries。WSLはLinux用buildにのみ使用し、ソース編集やnative Linux runtime証拠には使っていない。 |
| `git diff --check` | PASS。 |
| Windows full installed lifecycle、native Linux runtime、macOS package／runtime、full suite、5OS QA、QE_QC／QE_QA | NOT_RUN。限定起動確認とpackage verifierを対象外へ拡張しない。 |

UNIT_ID: Windows installed Gateway startup／OS-shared package runtime dependency closure（限定consumer）
STATUS: WIRED（Windows installed Gateway起動とLinux archive内容まで）
NEXT_REQUIRED_CONSUMER: Windows installed update／recovery／通常Uninstallでの保持を含む未接続consumerは、次の独立作業で⓪→④を再実行し現行rev4.0と実物から選ぶ。
SAFETY_STATUS: 変更前のinstalled smokeはSetup後に欠落MCP clientで停止したが、隔離cleanupは成功し install／DataRootとregistry状態を復元。修正版ではstub Gatewayだけを起動し、health確認後に停止。owner data、資格情報、外部provider、別repoへ作用なし。
LOCAL_ASSET_STATUS: Windows ZIP（51,886,120 bytes）とLinux tar.gz（49,032,580 bytes）および各manifest／checksum／READMEを生成物として保持。WSL build由来`packages/blue-tanuki/native/linux-isolation/target`は44 entries／10,462,590 bytesで、OneDrive同期領域への削除伝播を避け保留。`.codex-tmp/windows-install-entrypoint/install.log`は79 bytesだがOneDrive reparse pointのため保留。`git fetch origin`のpruneで既存`.git/worktrees/blue-tanuki-health-2026-11-07-windows`の削除がpermission deniedとなったため、metadata／ACL／attributesを変更せず保留。smokeの隔離rootはcleanup後に残存なし。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始時local／`origin/main`／GitHub `main`=`cb4a49fedcc16f5d1c1a77eb0632997efa4f2b4f`、ahead／behind=0/0、worktreeはmainのみ。実装commit=`1fec12ad17cbe03c26bee706ca268db4a70853aa`を`main`へfast-forward pushし、local／`origin/main`／GitHub `main`一致、ahead／behind=0/0を確認。closeout commit=`e9a22d710c3155ade913ef83e60ad042e4f16b3a`もpushし、その直後のlocal／`origin/main`／GitHub `main`は一致、ahead／behind=0/0。closeout時点のlocal recovery branch／remote tagはcurrent=`e9a22d710c3155ade913ef83e60ad042e4f16b3a`／previous=`1fec12ad17cbe03c26bee706ca268db4a70853aa`。closeout確認後に追加する記録commitもmainへpushし、終了時の復旧refをその最終mainと直前closeout commitへ更新する。

## 完了BUILD_BATCH — QE_BUILD / CR-0 Linux・macOS開発用Uninstall停止確認

主語はLinux／macOSの開発用source Uninstallと、それが呼び出すresident管理scriptである。目的は、resident停止が失敗・未確認・対象不明の場合に、install／launcher／dataを削除しないこと。

Uninstallはresident停止とautostart解除の終了コードを検査する。停止失敗時はautostart解除へ進まず、削除も行わない。管理scriptが欠落していてinstall rootまたはresident PID記録が存在する場合もfail-closedにする。resident helperはPIDの正値・形式、`ps`で観測した`apps/gateway/dist/main.js --serve --env-file <同一ENV_FILE>`のcommand signatureを照合し、一致するprocessだけへSIGTERMを送る。最大10秒終了を待ち、終了を観測してからPID記録を除去する。不正PID、別process、signal失敗、状態観測不能、終了timeoutではPID記録を保持してnonzero終了する。製品packageの別Uninstall実装は変更していない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| WSL Ubuntu 24.04 `sh -n`：resident／Linux Uninstall／macOS Uninstall／Unix fixture | PASS。 |
| WSL `install/installer/test/safe_target_unix.sh` | PASS：`unix_target_guard=pass`。Linux／macOS各scriptで管理script欠落、停止失敗、autostart解除失敗を注入し、PURGE指定下でもinstall／launcher／user dataが残り、停止失敗後にautostartを呼ばないことを確認。resident実processの停止成功、無関係PID拒否、不正PID保持、SIGTERM無視processの10秒timeoutとPID保持も確認。 |
| `corepack pnpm exec vitest run install/installer/test/resident_integration.test.ts install/installer/test/source_entrypoints.test.ts` | PASS：2 files／14 tests。Windows上のsource entrypoint testはUnix実行確認をskipするため、実shell fixtureは上記WSL実行で確認。 |
| `git diff --check` | PASS。 |
| 実macOS host、native installed Linux／macOS product、実ユーザーのresident／autostart／data、full suite、5OS QA、QE_QC／QE_QA | NOT_RUN。WSL fixtureをnative OS／installed productの証拠に拡張しない。 |

UNIT_ID: CR-0 safety interrupt — Linux/macOS development source Uninstall
BUILD_BATCH: resident-stop verification → dev Uninstall removal gate
STATUS: WIRED（source development Uninstallとresident helperの合成実process経路のみ）
NEXT_REQUIRED_CONSUMER: 次の独立作業は⓪→④を再実行し、rev4.0と最新HEADから未接続consumerを選ぶ。G03 installed-linux、G09 Mobile、C08.03実provider、OD-03 live作用、別repo、Rust cutover、P13公開GOへ証拠を拡張しない。
SAFETY_STATUS: stop/autostart異常時に削除しない。PID identity不一致時に他processをsignalしない。10秒で停止を観測できないときはPID記録とinstall／dataを保持する。
LOCAL_ASSET_STATUS: shell fixtureの`/tmp/blue-tanuki-safe-target.*`とprocessはtrap／fixture cleanup後に残存なし。ignored build outputsは保持。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。commit hookは`.git/worktrees/blue-tanuki-health-2026-11-07-windows`削除時にpermission deniedを報告したがcommit自体は成功。reparse metadata／ACL／attributesを変更せず保留。別repo、資格情報、OneDrive資料、owner dataへ作用なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始時local／`origin/main`／GitHub `main`=`be142fc59bc1c7b3aadcd4483a5660f710fe6302`、ahead／behind=0/0、worktreeはmainのみ。実装・fixture・一次記録commit=`e5afe23b3c2b57db98a85ee021e35fb4e0e3bca3`をGitHub `main`へpush。remote復旧tagはCAS更新済みで、一次push後 current=`e5afe23b3c2b57db98a85ee021e35fb4e0e3bca3`／previous=`be142fc59bc1c7b3aadcd4483a5660f710fe6302`。この最終記録push後はlocal／origin／GitHub `main`とlocal `codex/backup-main`／remote current tagが一致し、local `codex/backup-main-prev`／remote previous tagは`e5afe23b3c2b57db98a85ee021e35fb4e0e3bca3`を指す状態を直接再照合する。protected attachmentsは未追跡・未変更。

## 完了BUILD_BATCH — QE_BUILD / F02.02 Gmail返信下書き作成の読み戻し・J/M結果帰還

主語は既存Gmail `draft.create` AdapterからHDS-J/Mを経て、再起動後のowner結果表示へ至る返信下書き経路である。目的は、作成応答だけを成功根拠にせず、作成した下書きのprovider状態を読み戻し、現行Jの専用validatorとdigest-only M receiptが一致する場合に限り、実行を再開せず結果をownerへ返すこと。

Adapterは一回の`drafts.create`後、同じ認証状態で`drafts.get?format=metadata`を一回行い、draft ID／message ID／source threadと`DRAFT` labelを照合する。読み戻し不一致・失敗では`outcome_unknown`を記録して自動再送しない。Jは結果validation v2でrequest／target digest、`gmail.googleapis.com`のprovider state digest、読み戻し確認を再検証する。HDSのexecution-authority target identityにも`reply_source_message_identity_digest`を含め、L3 bindingの対象同一性を修正した。成功結果はIDや本文を含めずdigest-only M receiptとして保存し、Gateway再起動後のowner表示へ投影する。過去のv1 validationは履歴読取り用に残すが、成功M証拠には採用しない。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `packages/hds-brain/test/operation_plan_gmail_reply.test.ts` | PASS：5/5。v2結果validationとdigest束縛を確認。 |
| `packages/blue-tanuki/test/gmail_write_target_version.test.ts` | PASS：28/28。合成transportで作成後のmetadata readback、正確な`DRAFT`状態、不一致時の単回作成・unknown停止を確認。 |
| `apps/gateway/test/execution_result_reconciliation.test.ts` focused | PASS：2 selected、92 skipped。L3 review、実Adapter経路、J検証、M receipt、再起動後owner返却、およびreadback不一致時の返却拒否を合成環境で確認。 |
| `corepack pnpm typecheck`／`corepack pnpm build` | PASS：全workspace typecheck、15/15 workspace projects build。 |
| `corepack pnpm docs:check` | PASS：docs／日本語基底／licensing gates。既存の日本語基底移行負債75件を注意表示。 |
| `git diff --check` | PASS。 |
| 実Gmail／OAuth credential／実provider／mailbox、draft作成・send、全suite、5OS QA、QE_QC／QE_QA | NOT_RUN。合成transportを実provider証拠へ拡張しない。 |

UNIT_ID: F02.02 Gmail reply `draft.create` provider readback → J validation → digest-only M receipt → restart owner result（限定consumer）
STATUS: WIRED（成功結果とreadback mismatchを合成Gateway／Adapter経路で確認）
NEXT_REQUIRED_CONSUMER: 次の独立作業で⓪→④を再実行し、現行rev4.0と最新HEADから次の未接続consumerを選ぶ。実provider／credential／送信、OD-03 live作用、別repo、P13公開GO、QE_QC／QE_QAへ拡張しない。
SAFETY_STATUS: 明示L3 review、単回作成、provider state再照合、結果不明時no-retry、J単一authority、M非権威・digest-only、再起動後も作用を再実行しない表示を維持。
LOCAL_ASSET_STATUS: tracked source／tests／active docsをGitHub mainへ反映。`%TEMP%\blue-result-reconcile-*`のtest-owned残骸6 root（合計884,766 bytes、各rootはsynthetic SQLite 4件と`workspace\blue.txt`）をWindowsごみ箱へ移し、元pathの消失とごみ箱内6件を確認。focused testの今回生成rootを含め残存rootなし。workspace buildが生成したignored `dist`等は開発環境として保持。保留: `.git\worktrees\blue-tanuki-health-2026-11-07-windows`はworktree listには現れないがdirectoryと配下`logs`／`refs`／`ORIG_HEAD`がreparse point。Git commit hookはpermission deniedを返し、metadata／ACL／attributesを変えず保持。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。実資格、実mailbox、別repo、OneDrive資料、外部作用に変更なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始local／`origin/main`／GitHub `main`=`3a554c5f89a6abb16f5cbfcef7a9fe67d0784a2b`、ahead／behind=0/0、worktreeはmainのみ。実装commit=`5bcb74e42e1e0215d1d2e3e8386dd886709e21c0`とcloseout記録commit=`eeb3b06970e7346e152a050c48232f2ed724ee95`をGitHub `main`へpushし、各時点のlocal／remote一致を確認。この保留追記commitをpush後、local／origin／GitHub main一致・ahead／behind=0/0、worktree mainのみ、local `codex/backup-main`／remote tagは最終main、`codex/backup-main-prev`／remote tagは直前closeout commitを指すことを再確認する。

## 完了BUILD_BATCH — QE_BUILD / G02.03 Windows製品Uninstallの動的削除対象再照合

主語はWindows製品packageが導入する`BlueTanukiUninstall.ps1`と、停止中に変化し得るInstallRoot／DataRootである。目的は、Uninstall前に照合した管理対象がresident停止中に追加・差替え・reparse化された場合、対象の所有・構造を再検証し、変更を検知したらInstallRoot／DataRootを削除せずfail-closedで終了すること。通常UninstallはDataRootを保持し、明示`-PurgeData`だけがDataRootを削除対象にする。

現行mainには停止後のInstallRoot managed inventory再検証とPurge DataRoot再検証が接続済みだった。追加実装はせず、Windows上のfocused fixtureで製品Uninstall wrapper／PowerShell経路を再実行した。synthetic launcherが停止中にInstallRootへfileを追加する正例と、Purge対象へjunctionを作る負例がともにexit 1で止まり、InstallRoot／DataRoot／外部sentinelが保持され、fixture cleanupも成功した。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `install/installer/test/windows_product_installer.test.ts` focused | PASS：1 selected test、20 skipped。`windows_dynamic_uninstall.ps1`がowned product fixtureのwrapper／Uninstall scriptを実行し、dynamic InstallRoot変更・DataRoot reparseを検知して削除を止めることを確認。 |
| 実installed product、ownerのInstallRoot／DataRoot、OS reboot、native installed QA、G02.03全体、全suite、QE_QC／QE_QA | NOT_RUN。隔離fixtureをinstalled productや実ユーザーデータの証拠にしない。 |

UNIT_ID: G02.03 Windows product Uninstall dynamic-target protection（限定producer／consumer確認）
STATUS: WIRED（packaged Uninstall code pathと動的target再照合fixtureは存在し、現Windows hostで1/1 PASS）
NEXT_REQUIRED_CONSUMER: 次の独立作業で⓪→④を再実行し、rev4.0と最新HEADから全体接続距離・未接続consumer・安全危険度で選ぶ。Windows dynamic-targetは再観測済み。C08.03実provider、OD-03 live外部作用、D4／MINIDORA別repo変更、P13公開GOへ拡張しない。
SAFETY_STATUS: 所有marker／managed inventory／InstallRoot identity／reparse拒否を維持し、停止後に対象が変化したら削除を中断する。通常UninstallはDataRootを保持し、Purgeは全量完全削除の明示経路に限定。
LOCAL_ASSET_STATUS: dynamic fixtureの一時InstallRoot／DataRoot／外部sentinel／status fileはtest内cleanup PASS。残存 fixture rootなし。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。実ユーザーデータ、provider credential、別repo、OneDrive資料に作用なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`98149ea42a2e5fcbaa34d5cb93e3f33b8ce767e2`、ahead／behind=0/0、worktreeはmainのみ。closeout commit `40ea7d3151bb39d36a65c1f4dd1a2a6e572cd36d`をGitHub `main`へpushし、local／remote main一致を確認した。local recovery branch current=`40ea7d3151bb39d36a65c1f4dd1a2a6e572cd36d`／previous=`98149ea42a2e5fcbaa34d5cb93e3f33b8ce767e2`、remote recovery tagも同じcommitを指す。

## 完了BUILD_BATCH — QE_BUILD / C08.02 明示達成規則・検証済みJ/M根拠と復旧の再同期

主語はowner task受付からHDS-J／M、再起動後の状態投影までの同一task経路である。ownerが指定した明示規則が現行J正本・task・目的digestへ結合され、同一revision上の一意なoperation step、検証済み結果、対応するM receiptがそろう場合だけJが達成sealを記録し、同一taskを停止する。規則・対象・結果・receiptの欠落、不一致、曖昧さ、M revision変更は達成にせず保留する。引用範囲の`completed`はowner目的の達成を意味しない。

現行mainにこのproducer／consumer経路は存在していた。調査でC08.02復旧E2Eの表示期待値だけが旧契約（`状態: completed/held`）のまま残っていたため、引用範囲状態と`目的達成判定: 未判定`を区別する期待値へ修正した。評価器や別authority経路は追加せず、C08.02の限定consumer接続を再確認した。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `apps/gateway/test/operation_plan_runtime.test.ts` focused | PASS：明示規則一致、結果不一致、rule-to-step曖昧の3ケース。J/M根拠がそろう一致だけ達成し、達成後同taskの実行候補を拒否。 |
| `apps/gateway/test/document_organization_entry.test.ts` C08.02 E2E | PASS：process kill／restart復旧の正・負2件。J引用範囲の再開後完了はowner目的未判定と表示し、M変更時はholdしてCを再呼出ししない。 |
| owner-auth Gateway task integration | PASS：owner規則なしの保留／明示規則によるJ/M検証と停止、Canvas `file.write` 一回作用・receipt・Gateway再起動復元の2件。 |
| `corepack pnpm build` | PASS：15 workspace projects。 |
| `corepack pnpm docs:check` | PASS：docs／日本語基底／licensing gates。日本語基底の既存移行負債75件を検出。 |
| `git diff --check` | PASS。 |
| 実provider／実LLM／外部作用、全suite、native 5OS、QE_QC／QE_QA、公開・release／owner GO | NOT_RUN／対象外。合成fixture結果を実providerや製品全体へ拡張しない。 |

UNIT_ID: C08.02（owner明示達成規則、同一revision verified result／M receipt、達成後停止・不成立時保留、再起動後復旧の限定consumer）
STATUS: WIRED（J/M operation-plan、owner-auth Gateway file.write、C08.02 kill/restart経路を合成・隔離環境で確認）
NEXT_REQUIRED_CONSUMER: 次の独立作業で⓪→④を再実行し、rev4.0の優先基準と実callsiteから再選定する。現行指示の高リスク未観測事項であるWindows製品Setup→Uninstall動的対象経路を最初に照合し、未接続consumerが現物にあればその一経路へ限定する。
SAFETY_STATUS: HDS-J単一writer、Approval Gate、L3、M非権威、owner認証済み規則digest、同一task／revision／step／result／receipt束縛、欠落・曖昧時fail-closed、達成後停止を維持。
LOCAL_ASSET_STATUS: test-owned C08.02／Canvas temp rootsはtest cleanupで削除済み。`corepack pnpm build`が生成したignored `dist`／platform build outputsは開発環境として保持。provider credential、外部作用、別repo、OneDrive資料操作なし。`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更で保持。
CURRENT_HEAD_AND_DIRTY_OWNER: 実装／test commit=`37c558be737fd1225850da7bb3671181f25993ef`をpushした時点でlocal／`origin/main`／GitHub `main`一致、ahead／behind=0/0。復旧refはCAS更新しcurrent=`37c558be737fd1225850da7bb3671181f25993ef`、previous=`1728ff07b430211de09d5fbc4b7be40f281e15cd`を確認。closeout記録の追加commit後は最終HEAD／復旧refが進むため、その値は最終報告で照合する。commit成功後に旧`.git/worktrees/blue-tanuki-health-2026-11-07-windows`のmetadata cleanupがPermission deniedを返したが、metadata／ACLを保持して処理を迂回せず、GitHub main pushとremote ref照合は成功した。`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。

## 完了BUILD_BATCH — QE_BUILD / D03.01 D4 Runtime statusへのJ/M task outcome接続

主語はBLUE Gatewayの認証済みD4 Runtime status endpointと、HDS-J/Mがrequest IDごとに返すOperation Plan `task_outcome`である。目的は、dispatch状態の`handler_returned`をgoal達成と誤認させず、同じruntime/session/submissionに束縛した状態照会へ、検証済みの達成・進行・保留状態をcontent-freeで追加すること。

`POST /runtime/intent/status`は従来のdispatch stateを維持したうえで、HDS projection内のrequest ID、D4 Runtime actor digest、WebChat channel digestが一意一致したtaskだけを照合する。`achieved`はHDSが返すJ評価が明示規則を全件満たし、rules/evidence digestと件数が整合し、`used_for_authority=false`／`may_execute=false`である場合だけ返す。HDS plan不在・曖昧・不正は`unknown`、pendingは`in_progress`、古い評価を含むJのholdは`held`とする。task本文、規則本文、結果本文、M receipt IDは返さない。dispatch state、goal outcome、結果本文の配送は別状態のままである。

| QE_BUILD限定確認 | 結果 |
|---|---|
| `packages/channel-webchat/test/webchat.test.ts` D4 Runtime経路 | PASS：1 selected test（同file 132 skipped）。statusのdispatch stateとJ/M task outcomeを別々に返し、不正な拡張projectionのraw fieldを捨てることを確認。 |
| `apps/gateway/test/d4_runtime_task_outcome.test.ts` | PASS：3/3。request/actor/channel束縛、achievement digestとrule count、pending/held、missing/ambiguous/invalidのunknownを確認。 |
| channel-webchat／Gateway typecheck、channel-webchat build、`git diff --check` | PASS。 |
| Gateway served full task、D4 Adapter producer/consumer、Android実機、全suite、実provider／credential／外部作用、5OS QA、QE_QC／QE_QA | NOT_RUN／未成立。 |

このBLUE status projectionだけを`WIRED`とする。D03.01／G09.01全体、D4との実接続、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。D4別repoは読み取りのみで、Android/iOSコード、provider credential、外部作用、公開を変更していない。

NEXT_REQUIRED_CONSUMER: D4 `blue_tanuki_adapter` producerは未接続のまま。別repo変更は対象・委任が独立に成立するまで行わず、現行rev4.0と最新HEADから次のBLUE-owned実consumerを選ぶ。
SAFETY_STATUS: 同一session scope、専用bearer、runtime ID、request ID、HDS owner/channel digest照合を維持。HDS outcomeは表示用projectionであり、権限・Approval・実行・配信確認へ使わない。達成不明はunknown/held。
LOCAL_ASSET_STATUS: channel-webchat source/test、Gateway projector/test、active指示・進捗記録をGit管理候補とした。channel-webchatのignored `dist` build outputは開発環境として保持。test固有temp assetなし。protected attachment directoriesは未追跡・未変更。D4 workspace／OneDrive資料に変更なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始local／origin／GitHub `main`=`8359d86fb368dacbf0b622777d4b808b41c93e78`、ahead／behind=0/0。fetchはstale worktree metadata削除時のACL拒否を報告したが、remote `main`／復旧tagは直接照合済み。既存local recovery branchesとremote tags current／previousは編集前にHEAD／直前mainと一致。

## 完了BUILD_BATCH — QE_BUILD / F02.02 owner選択済みGmail identityから返信draft候補へのJ内束縛

主語はHDS-Jの`OperationPlanLedger.retainCandidate`と、既存のowner選択済み`gmail.read` identity経路である。目的は、ownerが読取結果から選択したmessage identity digestを、Cの候補返却後にJが同じowner／channel／task／revisionの未期限・検証済みread resultと照合し、返信draft候補のsource message IDへ内部束縛すること。C入力、Control Center projection、M receiptへraw provider IDやメール内容を渡さない。候補は単一の`gmail.write draft.create`だけを許し、添付を拒否し、返信draftのthread確認付きresult validationへ置き換える。

Jはsource plan／最新revision／`gmail.read` step／verified bindingのresult・delivery digest／成功結果一件／観測時刻と10分期限を照合する。digestが結果内message identityと一意一致しない、候補がsource IDと矛盾する、source stateが古い・曖昧な場合は保持しない。fixtureに含むprompt-injection風snippetも候補へ複製されない。実Gatewayでの全経路やdraft作成はこのbatchで実行していない。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| `packages/hds-brain/test/operation_plan_gmail_reply.test.ts` | PASS：5/5 tests。HDS内identity解決、誤digest・source ID競合の拒否、owner task明示ID経路、reply draft result validationを確認。 |
| `corepack pnpm --filter @blue-tanuki/hds-brain typecheck` | PASS。 |
| `corepack pnpm hds:standalone` | PASS：health `ok`、audit chain valid、全runtime invariants true。 |
| `git diff --check` | PASS。 |
| served Gateway／実Google provider／credential／draft作成／send、全workspace suite、5OS QA、QE_QC／QE_QA | NOT_RUN。 |

UNIT_ID: F02.02（owner選択済みのbody-free Gmail read identityを、返信draft候補のthread-bound sourceへHDS内で接続する限定consumer）
STATUS: WIRED（HDS `retainCandidate`のowner／channel／task／revision／result receipt照合後にsource IDを候補へ結合。focused helper testと型検査で確認。served Gateway全経路やproviderは未確認）
NEXT_REQUIRED_CONSUMER: 現行rev4.0と最新HEADから次の未接続consumerを再選定する。実provider／credential／draft作成・send、OD-03 live作用、別repo、QE_QC／QE_QA、公開／出荷判断へ拡張しない。
SAFETY_STATUS: source message IDはC／projection／Mへ出さない。メール内容とheadersは未信頼のまま。single-step draft.create、添付拒否、thread-result validation、high/L3／Approval Gateの既存契約を維持。作用・実credential・外部書込みなし。
LOCAL_ASSET_STATUS: source／test／active docsのみ変更候補。focused test固有の一時資産なし。build生成物なし。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。他repo／OneDrive保管操作なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`0b846894bc287a4cc3bdfdfa4dde1d9ae308daf8`、ahead／behind=0/0、worktreeはmainのみ。開始recovery branch／remote tag current=`0b846894bc287a4cc3bdfdfa4dde1d9ae308daf8`、previous=`62bfd2dcbd1a1e86dc5e7ae1740015bb7b8f9e92`。終端main・二世代recovery refはpush後に再照合する。保護添付は未追跡のまま維持する。

## 完了BUILD_BATCH — QE_BUILD / F02.01 Gmail読取identity・信頼境界のAdapter確認

主語はBLUEの既存`gmail.read` production Adapter `invokeGmailRead`である。目的はsynthetic Gmail応答から認証mailbox、message／thread、recipient header claims、添付identityを正しく識別し、メールsubject／snippet／recipient／添付metadataを未信頼データのまま分離すること。人間ownerとmailboxの対応や宛先claimの真実性は確定しない。本文・raw MIME・添付bytesは結果に含めず、本文bytesを含むfull metadata応答はfail-closedに拒否する。

既存Adapterのproducerは既に接続されていたため、別wrapperや新規経路は作らず、実際に使う`invokeGmailRead`へ合成transport fixtureを追加した。正例はprofile由来mailboxとmessage／thread／attachment identity、To/Cc/Bcc/Reply-Toの未検証claim、subject／snippetの未信頼flag、body-free resultを確認する。負例はmessage-part `body.data`の混入を拒否し、read-onlyでmutationなしを確認する。この確認はAdapter fixtureの範囲で、Gateway runtimeやGoogle provider接続の証明ではない。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| `packages/blue-tanuki/test/google_read_gmail.test.ts` | PASS：2/2 tests。mailbox／message／thread／attachment identity、未信頼recipient claimsとsnippet、本文不在、予期しないbody bytesの拒否を合成transportで確認。 |
| `corepack pnpm --filter @blue-tanuki/core typecheck` | PASS。 |
| `corepack pnpm --filter @blue-tanuki/core build` | PASS：Windows／Linux isolation outputsとcore package。 |
| `corepack pnpm docs:check` | PASS：docs／日本語基底／license gates。日本語基底の既存移行負債75件は注意表示。 |
| `git diff --check` | PASS。 |
| Gateway process、実Google provider／credential／mailbox、外部作用、full suite、5OS QA、QE_QC／QE_QA | NOT_RUN。 |

UNIT_ID: F02.01（Gmail read Adapter fixtureでmailbox／message／thread／attachment identityと未信頼メール内容を区別する限定producer確認）
STATUS: WIRED（production `invokeGmailRead`にsynthetic transportを通し、recipient claims／subject／snippet／attachment metadataを非権威として返却。Gatewayの通常C/J/M縦断経路は未確認）
NEXT_REQUIRED_CONSUMER: この単位を閉じた後、現行rev4.0と最新HEAD・実consumerから次のBUILD_BATCHを選定する。実provider、ライブ外部作用、別repo変更、QE_QC／QE_QAへ拡張しない。
SAFETY_STATUS: `gmail.read` read-only、mutationなし、human-owner relationとrecipient claimsは未検証、メール内容から目的・承認・権限を生成しない、unexpected body bytesを拒否、本文／raw MIME／添付bytesを返さない。
LOCAL_ASSET_STATUS: 新規Adapter fixture testのみ。test固有一時資産なし。core build生成のignored `dist`／Windows・Linux isolation outputsは開発環境として保持。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。provider credential・外部作用・OneDrive保管操作なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`62bfd2dcbd1a1e86dc5e7ae1740015bb7b8f9e92`、ahead／behind=0/0、worktreeはmainのみ。開始recovery branch／remote tag current=`62bfd2dcbd1a1e86dc5e7ae1740015bb7b8f9e92`、previous=`41c59cc56e26e14f821093c935b2d08b89f394b5`。閉包時にcommit／push後のlocal・remote main、二世代recovery refs、保護添付状態を再照合する。

## 完了BUILD_BATCH — QE_BUILD / F02.02 通常Gmail message.send結果検証とowner帰還

主語はBLUE Gatewayの通常Gmail `message.send`、Approval Gate、Executor、HDS-J/M、認証済みControl Centerである。目的はowner taskに明示された宛先・Reply-To・件名・本文・選択添付と認証済みmailboxをno-storeのhigh/L3 reviewへ束縛し、一回の送信後に同じmailbox・message・threadの`SENT`状態を再読込で確認した結果だけを、検証済みOperation Plan、digest-only M receipt、再起動後のowner照会へ返すこと。

Control Centerのreview digestはcommand、要求payload、添付内容digest、mailbox identity、provider stateを結ぶ。Approval Gate消費後の作用直前にmailboxと要求digestを再照合する。送信応答が不明・不正、同じmessage/threadを再読込できない、mailboxが違う、または`SENT`を確認できない場合は成功に昇格せず、結果不明として自動再送しない。Mとowner projectionには本文、raw MIME、宛先、添付内容、provider object IDを保存しない。live providerではなく合成transport fixtureの結果である。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| Gmail／Gateway／HDS／WebChat focused Vitest | PASS：5 files、13 selected tests、296 skipped。content review、account／target再照合、単回send、`SENT`／thread readback、不明・不一致時のno-retry、検証済み結果からM receipt・再起動後owner returnまでを合成fixtureで確認。 |
| `node node_modules/typescript/bin/tsc -b --pretty false` | PASS：workspace TypeScript build graph。 |
| `corepack pnpm build` | PASS：15 workspace build projects。 |
| `corepack pnpm docs:check` | PASS：docs／日本語基底／license gates。日本語基底の既存移行負債75件は注意表示。 |
| `git diff --check` | PASS。 |
| 実Gmail credential／API／送信、live Gateway、full suite、5OS QA、QE_QC／QE_QA、release／owner GO | NOT_RUN。 |

UNIT_ID: F02.02（通常message.sendのレビュー済み単回送信、同一message/threadのSENT確認、J/M receiptとowner帰還の限定consumer）
STATUS: WIRED（合成応答でOperation Plan→high/L3 no-store review→作用直前mailbox再照合→単回send→同一message/threadのSENT readback→J検証→digest-only M receipt→再起動後owner projection。実provider／live Gateway未確認）
NEXT_REQUIRED_CONSUMER: このBUILD_BATCHを閉じた後、独立した次作業で現行rev4.0、最新HEAD、実consumerから次のproducer／consumerを選定する。F02.02全体の完成やC08.03実provider、OD-03 live外部作用へ拡張しない。
SAFETY_STATUS: high/L3、Approval Gate、command／宛先／本文／選択添付／認証mailboxのno-store束縛、作用直前再照合、送信後account／message／thread／SENT readback、結果不明時の自動再送禁止、HDS単一writer、M非権威を維持。実credential・Gmail・送信なし。
LOCAL_ASSET_STATUS: source／tests／active docsはGit候補。build生成のworkspace `dist`／platform isolation outputsは開発環境として保持。focused test用rootはtestのfinally／afterAllでcleanupされ、終了後の確認で今回の固有root残存なし。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。他repo／OneDrive保管操作なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`2d3931a1e39457da19185cb7f3094d32ca037864`、ahead／behind=0/0、worktreeはmainのみ。開始recovery branch／remote tag current=`2d3931a1e39457da19185cb7f3094d32ca037864`、previous=`a7882d9b16308889500f84fd6b80cc8b3d1c7a8d`。tested implementation commit=`41c59cc56e26e14f821093c935b2d08b89f394b5`をmainへfast-forward pushし、local／origin／GitHub main一致を確認。コードpush後のlocal recovery branch／remote tag current=`41c59cc56e26e14f821093c935b2d08b89f394b5`、previous=`2d3931a1e39457da19185cb7f3094d32ca037864`へ競合検出付きで回転した。続くcloseout文書commit・push後も終端main／両recovery refを再照合する。古いworktree metadataのACL拒否でfetch／commit cleanupが失敗したため迂回せず、remote SHAは`git ls-remote`で照合した。protected attachmentsは未追跡のまま維持した。

## 完了BUILD_BATCH — QE_BUILD / C08.02 owner達成規則と検証済みJ/M根拠の照合

主語はBLUE-TANUKIのOwner Task受付からHDS-J／M、再起動後のtask状態投影までの経路。ownerの明示規則を同一taskへ束縛し、同一revisionの一意なoperation step、検証済み結果、M receiptがそろう場合だけJが達成を記録し、同一taskを停止する。規則・対象・結果・receiptの欠落、不一致、曖昧さは保留とする。GoalProjectionは規則本文ではなくauthenticated owner request由来のdigest参照だけを示し、その他の未知項目を確定しない。

現行HEADにはこのproducer／consumer経路が既に接続されていたため、並行する評価器は追加せず、owner入力からJ/M判定までの実物を検査した。既存の一致ケースを維持し、同一規則が複数stepへ一致する境界を負例へ追加した。これは実装成立全体や製品完成ではなく、C08.02の明示達成規則consumerに対する限定`WIRED`確認である。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| HDS J/M operation-plan test | PASS：`operation_plan_runtime.test.ts`の一致・不一致・曖昧mapping 3件（同file 47件skip）。全stepのverified resultとM receiptを通し、曖昧mappingではsealなしのheldを確認。 |
| served Gateway owner task path | PASS：`document_organization_entry.test.ts`の選択process test 1件（7件skip）。規則欠落はheld、一致規則はverified M receipt後にachieved、Gateway再起動後も同一taskの達成状態を復元。 |
| owner入力／projection | PASS：WebChat task form 1件、GoalProjection 5件。owner規則を送信し、外部owner風metadataでは規則参照を作らないことを確認。 |
| `corepack pnpm typecheck`／`corepack pnpm build` | PASS：全workspace型検査、15-project build。型検査が消去したignored `dist`はbuildで再生成し、開発環境として保持。 |
| `corepack pnpm docs:check` | PASS：documentation／日本語基底／license gates。既存の日本語基底移行負債75件は注意表示。 |
| `git diff --check` | PASS。 |
| 実provider／live外部作用、full suite、5OS QA、QE_QC／QE_QA、release／owner GO | NOT_RUN。 |

UNIT_ID: C08.02（owner明示達成規則、同一revisionのverified result／M receipt、達成後停止と不成立時保留の限定consumer）
STATUS: WIRED（owner入力→authenticated rule digest→Jの一意step／結果値／receipt照合→達成sealまたはheld→再起動後状態。served synthetic Gateway／file.searchのみ）
NEXT_REQUIRED_CONSUMER: 次の独立単位で現行rev4.0と最新HEADから、外部provider・live外部作用・別repo変更に依存しない最も未接続のproducer／consumerを再選定する。
SAFETY_STATUS: J単一writer、Approval Gate、M非権威、rule digestとtask／revision結合、結果不明・不一致・欠落・曖昧時fail-closedを維持。規則は実行権限、公開、出荷判断を付与しない。
LOCAL_ASSET_STATUS: 変更対象はruntime testと施工状態／roadmap／履歴文書。test-owned temporary rootはfinally cleanupされ、再確認時にこのtest固有prefixの残存なし。build `dist`は再生成・保持。保護添付`.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。他repo・OneDrive保管操作なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`a7882d9b16308889500f84fd6b80cc8b3d1c7a8d`、ahead／behind=0/0、worktreeはmainのみ。開始recovery branch／remote tag current=`a7882d9b16308889500f84fd6b80cc8b3d1c7a8d`、previous=`c8eb174d31574a01c2e92ade57d726fa5843bf50`。protected attachment directoriesは未追跡・未変更。終端SHA／復旧refはGit照合後に更新する。

## 完了BUILD_BATCH — QE_BUILD / F02.02 既存Gmail draft.sendの検証済み結果帰還

主語はBLUE Gatewayの既存Gmail `draft.send`／Approval Gate／Executor／HDS-J/M／認証済みControl Centerである。目的はownerが選択した既存draft一件をthread-boundのno-store L3 review後に一度だけ送信し、送信後の再読込で同じthreadの`SENT`状態を検証した結果だけを、J/M receiptと再起動後のowner照会へ返すこと。通常の`message.send`、live provider／実送信、F02.02全体、製品全体の完成とは扱わない。

draft metadataのaccount／draft message／thread／raw MIME digestと要求digestを結び、作用直前に同じdraft stateを再照合する。`drafts.send`にはreview済みthread IDを渡す。送信応答のthreadが異なる、送信後の`SENT`／thread／account確認が成立しない、または結果が不明な場合は成功へ昇格せず`outcome_unknown`として停止し、自動再送しない。本文、raw MIME、実provider object IDはMに保存せずdigestだけをreceipt・owner projectionへ返す。L3、Approval Gate、HDS単一writer、M非権威を維持する。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| focused Gmail／Gateway／HDS tests | PASS：4 files、8 selected tests（157 skipped）。thread拘束、結果検証、単回停止、M receipt、再起動後owner projectionを合成fixtureで確認。 |
| `corepack pnpm typecheck`／`corepack pnpm build` | PASS：全workspace typecheck、15 build projects。 |
| `corepack pnpm docs:check`／`git diff --check` | PASS：docs／日本語基底監査／license gate。既存の日本語基底移行負債75件は注意表示。 |
| 広範な初回test run | NOT_ESTABLISHED：Gateway runtime全体に含まれる7件の既存5／10秒timeoutで停止し、対象外testを完走しなかった。最終判定には使わず、上記focused selectorを再実行してPASS。 |
| 全workspace suite、実Gmail credential／API／送信、live Gateway／owner browser、5OS QA、QE_QC／QE_QA | NOT_RUN。 |

UNIT_ID: F02.02（既存draft.sendのthread確認付き単回送信結果をJ/M／ownerへ帰還する限定consumer）
STATUS: WIRED（合成応答でOperation Plan→high/L3→draft state再照合→単回send→送信後readback→J検証→digest-only M receipt→再起動後owner projection。実provider／live Gateway未確認）
NEXT_REQUIRED_CONSUMER: owner選択済みC08.02の達成規則consumerを次の独立作業として現行rev4.0と最新HEADから再構成する。現行J正本に結び付く明示規則と検証済み結果・M receiptが揃う場合だけ達成し、規則・根拠の欠落または曖昧さはpendingとする。C08.03実provider、OD-03 live外部作用、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOへ拡張しない。
SAFETY_STATUS: high/L3、Approval Gate、thread-bound request、作用直前draft state再照合、thread／account／SENT readback、結果不明時の自動再送禁止、J/M非権威receiptを維持。実credential・Gmail・送信なし。
LOCAL_ASSET_STATUS: source／tests／active docsはGit候補。`pnpm build`のworkspace `dist`／isolation outputは再生成済み開発環境として保持。focused rerunはtest-owned rootをfinallyで削除。中断済みfixture root `C:\Users\ohira\AppData\Local\Temp\blue-result-reconcile-S0D8tE`（1 directory／5 files／159,749 bytes、synthetic SQLite・workspaceのみ）は非稼働・reparseなしを確認してWindows標準Recycle Binへ移動し、元path不在と収容を確認した。同prefixの他5 rootはこのbatch開始前から存在し、別run所有のため保持。`.codex-attachments/`／`.codex-remote-attachments/`は保護・未変更。他repo変更なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`c8eb174d31574a01c2e92ade57d726fa5843bf50`、ahead／behind=0/0、worktreeはmainのみ。実装commit `76d99e28d8f80adb850599a4d2bb1cf21e556975`をfast-forward pushし、push直後のlocal main／`origin/main`／GitHub `main`一致を確認。`git fetch`／commit時に古い`.git/worktrees/blue-tanuki-health-2026-11-07-windows`のcleanupがPermission deniedとなったため保持し、直接`git ls-remote`でremoteを照合した。attachment directoriesは未追跡・未stageのまま保護。開始復旧branch／tag current=`c8eb174d31574a01c2e92ade57d726fa5843bf50`、previous=`133fc7163b0caedd229e88fba3ce39dad3d74c31`。最終closeout refsと終端状態は閉包時に再照合する。

## 前段完了BUILD_BATCH — QE_BUILD / F02.02 Gmail返信下書きの選択thread結合

主語はBLUE Gatewayの既存Gmail `draft.create`／Approval Gate／Executor／HDS-J/M／認証済みControl Centerである。目的はOwnerが明示したsource message IDへ返信下書きを結び、同じGmail thread内に作成された結果だけを既存のL3・J/M経路へ返すこと。通常下書き、送信、F02.02全体、実provider成立または製品全体の完成とは扱わない。

`reply_to_message_id`はowner task内に完全一致で明記された単一Gmail message IDだけを受け入れる。HDS Operation Planは`draft.create`一件・high/L3・既存Approval Gateを要求し、返信draft専用の結果検証規則を持つ。返信sourceは`format=metadata`で読み、本文／raw MIMEを取得しない。正当なRFC `Message-ID`がなければ停止し、source `threadId`、Subject、`References`をprovider state digestへ結ぶ。Subjectはsourceと完全一致させ、MIMEに`In-Reply-To`／`References`、Gmail draft作成要求に正確な`threadId`を設定する。宛先はOperation Planの明示値だけを使い、From／Reply-Toから補わない。

resume-authenticated no-store L3 reviewはsource message ID／thread ID／sender／Subject、宛先、本文、provider state digestを表示する。作用直前に同一source stateを再照合し、Gmail応答のdraft／message identityとthread一致を検査する。結果はsource／thread／created object／provider stateのdigestだけとし、thread確認なし、状態差異、結果不明時は停止して自動再送しない。実資格・実Gmail・送信は使わない。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| focused Gmail／Gateway／HDS／WebChat tests | PASS：4 files、32 selected tests。返信MIME／thread binding、source state stale／Message-ID欠落拒否、誤thread応答時の単回結果不明、L3 projection、HDS owner-ID／result digest validation、Control Center／no-store reviewを合成transportで確認。 |
| `pnpm typecheck`／`pnpm build` | PASS：全workspace typecheck、15 build projects。 |
| Control Center generated script parse／safety | PASS：source review表示test、script全体parse／raw control-character検査。 |
| `pnpm docs:check`／`git diff --check` | PASS：日本語基底監査PASS、既存移行負債75件を注意表示、license PASS。 |
| 全workspace suite、実Gmail credential／API、実送信、owner browser、QE_QC／QE_QA | NOT_RUN。実providerを使わず合成応答だけで確認した。 |

UNIT_ID: F02.02（Owner明示sourceのthread-aware draft.create限定consumer）
STATUS: WIRED（合成応答でOperation Plan→L3 no-store review→作用前source state照合→thread確認付きdraft作成→digest結果検証のコード経路。実provider／live Gateway未確認）
NEXT_REQUIRED_CONSUMER: 次の独立作業開始時に現行rev4.0と最新HEADからF02.02の残る通常Gmail consumerを選ぶ。C08.03実provider、外部送信、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOへ拡張しない。
SAFETY_STATUS: high/L3、Approval Gate、HDS-J/M、no-store、明示recipient、Owner task内の完全一致source ID、Subject一致、RFC `Message-ID`／thread拘束、作用直前state再照合、thread確認、digest限定result、結果不明時の再送禁止を維持。本文／raw MIME／RFC `Message-ID`／provider object IDをM receiptへ保存しない。実credential・Gmail・送信なし。
LOCAL_ASSET_STATUS: source／tests／本状態文書／roadmap／進捗／履歴はGit候補として保持。workspace buildのignored `dist`／Windows・Linux isolation出力は開発環境として保持。focused testの一時資産は残存なし。`.codex-attachments/`と`.codex-remote-attachments/`は保護対象として未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／`origin/main`／GitHub `main`=`133fc7163b0caedd229e88fba3ce39dad3d74c31`、ahead／behind=0/0、worktreeはmainのみ。開始復旧branch／tag current=`133fc7163b0caedd229e88fba3ce39dad3d74c31`、previous=`b47018e5418027b193cdb850c75c26757b85b441`。protected attachment directoriesは未追跡・未変更。終端SHA・復旧refはcommit／push後にGitから再照合する。

## 前段完了BUILD_BATCH — QE_BUILD / F02.02 Gmail message.trash・message.modifyと検証済み結果帰還

主語はBLUE Gatewayの既存Gmail write／Approval Gate／Executor／HDS-J/M／認証済みControl Centerである。目的は単一messageの復元可能なTrash移動と既存user label変更を、no-store L3確認、作用前再照合、provider後状態の検証、digest限定M receipt、再起動後のowner帰還まで既存writerへ接続すること。Gmail全操作、実provider成立、F02.02全体または製品全体の完成とは扱わない。

`message.trash`は正確な単一message IDとmetadata stateを確認し、本文／raw MIMEを取得せず、既にTrashの対象やreview後の状態変化を拒否する。L3確認後に対象stateを再照合して一回だけTrashへ移し、再読込で`TRASH`を確認する。`message.modify`は単一messageの既存user labelだけを追加・除去し、system label、Trash、thread単位操作を拒否する。両操作とも対象・要求・provider stateをreview digestへ束縛し、provider後状態を再読込して一致を検証する。結果不明時は自動再送しない。実結果はJのplan／request digestに束縛し、M receiptはdigestと検証状態だけを保持する。合成Gateway経路でJ/M再起動後に同一owner taskへ返す。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| focused Gmail／Gateway／WebChat tests | PASS：4 files、10 selected tests。Trash／label対象・digest review、検証済みlabel result→M receipt→restart→owner return、generated script safety／parseを確認。 |
| `pnpm typecheck`／`pnpm build` | PASS：全workspace typecheck、15 build projects。 |
| `pnpm docs:check` | PASS。日本語基底監査はPASS、既存移行負債75件を注意表示。 |
| `git diff --check` | PASS（実装差分確認時）。 |
| 全workspace test suite、実Gmail credential／API／外部作用、他OS QA、QE_QC／QE_QA | NOT_RUN。実providerを使わず合成応答だけで確認した。 |

UNIT_ID: F02.02（単一messageのTrash／user label変更と結果帰還の限定consumer）
STATUS: WIRED（no-store L3 review→再照合→単回provider request→状態再読込→J/M receipt→再起動後owner return。provider実接続は未確認）
NEXT_REQUIRED_CONSUMER: このBUILD_BATCHを閉じた後、次の独立作業開始で現行rev4.0と最新HEADから未接続producer／consumerを選定する。実provider／credential、全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOへ拡張しない。
SAFETY_STATUS: high/L3とApproval Gate、単一message対象、no-store表示、対象・要求・provider state digest拘束、作用前の再照合、後状態検証、結果不明時の自動再送禁止を維持。本文／raw MIME、label値、message IDをM receiptへ保存しない。実資格・実Gmail／外部作用なし。
LOCAL_ASSET_STATUS: ソース／tests／本状態文書／roadmap／履歴をGit候補として保持。buildのignored `dist`／isolation出力は現行開発環境として保持。focused test一時資産は残存なし。`.codex-attachments/`と`.codex-remote-attachments/`は保護対象として未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／origin／GitHub main=`b47018e5418027b193cdb850c75c26757b85b441`、ahead／behind=0/0、worktreeはmainのみ。作業treeのF02.02差分と2 protected untracked attachment directoryを維持。閉包時のremote/local SHA・復旧ref・dirty状態はGitから再照合する。

## 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows配布ZIP内Uninstallの動的対象再検証

Windows packageを現行HEADから新規生成し、配布ZIP内のUninstall wrapper／安全helper／Uninstall scriptを使って、停止後にInstallRootへ追加が生じる場合と、明示Purge中にDataRootがjunctionへ差し替わる場合のfail-closedを実際に確認した。前段で追加した保護がsourceだけでなくWindows配布ZIPにも含まれることを検証した限定consumerである。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| `pnpm package:windows` | PASS：version `1.0.0-rc.1`、Windows x64 installer ZIPを生成。ZIP SHA-256=`a1b14a71a1c1f30ddebe3c1a4aaccda5e8e3271c919925c6e6d93e0d20897d14`。 |
| `pnpm package:windows:verify` | PASS：2,553 entries。 |
| 配布ZIP内Uninstallの同一性 | PASS：source／package展開物の`BlueTanukiUninstall.ps1` SHA-256は双方`E3A088A39C25F70FB0462E524EE2F632D5F4561C66AC8C3811C928BACC9BC2F0`。 |
| 配布ZIP内Uninstallの動的対象harness | PASS：`dynamic_install_change_result`、`dynamic_data_reparse_result`、`dynamic_fixture_cleanup`。InstallRoot、DataRoot、outside sentinelの保持を確認。 |
| `smoke:windows-installed`全体 | NOT_ESTABLISHED：初回Setup／Repair、Gateway／WebSocket、監査、再起動永続性、crash recovery、stop／restart／Safe Modeは進行した。`installed Windows update failure rollback`が10分の`INSTALLER_TRANSACTION_TIMEOUT_MS`を超えて`spawnSync powershell.exe ETIMEDOUT`となり、update rollback以降を判定できなかった。cleanupはInstallRoot／DataRoot／HKCU登録を除去したが、timeoutで残ったstageがあり、smokeは失敗終了。原因は未確定で、製品のupdate rollback成功とは扱わない。 |
| LLM/provider／外部業務作用 | NOT_RUN：providerは`stub`、実資格・外部writeなし。 |

UNIT_ID: G02.03（Windows配布ZIP内Uninstallの停止後動的対象検査に限る）
STATUS: WIRED（生成ZIP内の実Uninstall wrapper／helper／scriptで限定harnessを通過。G02.03全体は未成立）
FULL_INSTALLED_SMOKE: NOT_ESTABLISHED（update failure rollbackのtransaction timeout。停止条件や期待値を緩和しない）
NEXT_REQUIRED_CONSUMER: G02.03残余とrev4.0の未接続consumerを次の独立作業開始時に現行正本・HEADから選定する。長時間installed smokeの未成立を成功へ読み替えない。
SAFETY_STATUS: 配布ZIP内で停止後InstallRoot追加とDataRoot junction差替えを削除開始前に拒否し、全sentinelを保持。timeout後のInstallRoot／DataRoot／registryは不在、active smoke processはなし。外部作用・実資格・HDS権限境界に変更なし。
LOCAL_ASSET_STATUS: failed smokeの固有`%LOCALAPPDATA%\BTsmoke\w-sZv2aE`（10,116 files／284,297,535 bytes）、一時package出力（4 files／48,470,286 bytes）、検査用harness copy 2件（合計19,198 bytes）は内容・非稼働を確認してWindows標準ごみ箱へ移動。元path不在とごみ箱内名称を確認。他の既存ごみ箱項目は変更なし。`.codex-tmp\windows-package-installed-smoke-0ca7186cad2b40b2ba29151081330ce1`はOneDrive同期領域の削除伝播を避けて保留（2,558 files／76,339,993 bytes）。protected attachmentsは保持。
CURRENT_HEAD_AND_DIRTY_OWNER: このbatch開始local／origin／GitHub main=`1f00b894a34eebdf62f6ad2d5b70135e818d07f2`、ahead／behind=0/0。開始local recovery branch current／previous=`1f00b894a34eebdf62f6ad2d5b70135e818d07f2`／`995a1d708e4f852ecaf5b640f701216cef6e0c8d`、remote recovery tag current／previousも同じSHA。worktreeはmainのみ。他branch・protected attachmentは未変更。

## 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows Uninstall動的対象の停止後再検証

Windows製品Uninstallのresident停止後に実行する最終安全検査を補強した。通常Uninstallは既存のInstallRoot inventoryを再検査し、明示`-PurgeData`ではさらにDataRootの所有・構造をアプリファイル除去前に再検査する。停止中に対象が変化した場合はfail-closedで終了し、インストールファイルとユーザーデータを保持する。Setup、通常保持、Purge範囲、HDS権限、provider接続、release状態は変更しない。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| Windows動的Uninstall harness | PASS：停止中のInstallRoot追加を検出し、InstallRoot／DataRootを保持。明示Purge中にDataRoot内へ外部向けjunctionが作られた場合も、削除開始前に拒否し、InstallRoot／DataRoot／outside sentinelを保持。 |
| 対象Vitest | PASS：専用case 1件。 |
| `pnpm docs:check`／`git diff --check` | PASS。 |
| 全installer suite／全workspace suite／installed package再生成／他OS／QE_QC／QE_QA | NOT_RUN。 |

UNIT_ID: G02.03（Windows Uninstallの停止後動的対象再検証に限る）
STATUS: WIRED（停止後のInstallRoot inventoryと、`-PurgeData`時のDataRoot所有・構造検査を実除去前に接続。G02.03全体は未成立）
NEXT_REQUIRED_CONSUMER: G02.03の残余とrev4.0の未接続producer／consumerを次の独立作業開始時に最新HEADから選定する。Windows全lifecycle、他OS、5OS全体の成立へ拡張しない。
SAFETY_STATUS: 非PurgeではDataRootを変更しない。Purge対象の停止中変更はアプリ削除前に拒否。外部sentinelを保持し、結果不明の再実行を追加しない。
LOCAL_ASSET_STATUS: ソース・専用harness・Vitest・現行状態文書・利用者向けUninstall説明はGit候補。成功harnessの一時rootとstatus fileは消失確認済み。以前の失敗試行由来のTemp root 2件（56 files／229,110 bytes）はjunctionを除去し、outside sentinel保持を確認した後、Windows標準ごみ箱へ移動済み。protected attachment directoriesは保持。D4-Pocket／ミニドラは変更なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／origin／GitHub main=`995a1d708e4f852ecaf5b640f701216cef6e0c8d`、ahead／behind=0/0。作業開始local recovery branch current／previous=`995a1d708e4f852ecaf5b640f701216cef6e0c8d`／`9d47d9309c2cf4b004a6dc5617dce3e5a5069512`、remote recovery tag current／previousも同じSHA。worktreeはmainのみ。

## 前段完了BUILD_BATCH — QE_BUILD / F08.03 MCP実行観測のConnections設定consumer

主語はBLUE GatewayのMCP Adapter、process-local観測store、認証済みConnections SettingsSurfaceである。目的は、通常のJ選択・High/L3・Broker／Executor経路から実際に観測したcatalog到達、tool dispatch、MCP応答、結果不明を、ownerが既存「Load」で読める次行動へ接続すること。

観測はloopback endpointのhashで対象を束縛し、状態と時刻だけを現Gateway process内で保持する。endpoint、tool名、arguments、response body、raw errorは保持・表示しない。SettingsSnapshotは設定statusとは別に最終runtime observationを返し、結果不明なら自動再送禁止と対象・service evidence確認を案内する。MCP応答受領は外部作用の独立検証ではない。表示は現在接続中のhealth保証やHDS権限として使わない。

設定画面GET／Loadはnetwork probeやserver起動を行わない。MCP接続・切断は通常runtime呼出しだけで観測する。既存ソースでは`BLUE_TANUKI_MCP_ENDPOINT`を読む単一endpoint設定を確認し、旧server定義の保存・移行元は見つからなかったため、推測した移行形式を追加しない。process management、実資格・provider、外部業務作用は対象外。

| QE_BUILD必要最小確認 | 結果 |
|---|---|
| Gateway MCP実SDK process | PASS 5/5。通常の成功、server error後のoutcome unknown、dispatch前disconnect、別process再起動後の状態遷移。合成noteの隔離rootのみ。 |
| Gateway SettingsSurface | PASS 16/16。endpoint別観測、非権威flag、結果不明の復旧案内、無効endpointの非表示、HTML script parse。 |
| Gateway typecheck | PASS。 |
| `pnpm docs:check` | PASS。 |
| `git diff --check` | PASS。 |
| 全workspace suite／全MCP互換／実資格・provider／外部業務作用／全OS／QE_QC／QE_QA | NOT_RUN。 |

UNIT_ID: F08.03（runtimeの最終観測をowner設定consumerへ表示する限定slice）
STATUS: WIRED（実MCP処理→process-local observation→認証済みSettingsSnapshot／Load。F08.03とBT-R-F08-08全体は未成立）
NEXT_REQUIRED_CONSUMER: repoに存在しない旧MCP設定の移行元は未確認。移行を再開する条件は、対象・version・sourceが特定できる実在設定の発見。runtime observationはGateway再起動で消えるprocess-local表示であり、永続復旧／health monitoring／一覧履歴は未実装。
SAFETY_STATUS: probe・process起動なし。状態storeはendpoint digest・状態・時刻のみ。High/L3、単回実行、結果不明で停止、used_for_authority=false／may_execute=falseを維持。
LOCAL_ASSET_STATUS: 合成MCP child processを終了。test-owned temp rootをfinally削除し消失確認。変更ソース／test／active docsはGit候補。既存ignored build環境とprotected添付2領域を保持。D4-Pocket／ミニドラは読み書きしていない。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／origin／GitHub main=`9d47d9309c2cf4b004a6dc5617dce3e5a5069512`、ahead／behind=0/0。作業開始local backup branch／remote backup tag current／previous=`9d47d9309c2cf4b004a6dc5617dce3e5a5069512`／`77bee6c9d61d2b02879b414a9401920f8ac275d5`。worktreeはmainのみ。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。

## 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows DPAPI資格情報を含むDataRoot保持・再導入・Purge

Windows installed productの通常UninstallはInstallRootと所有確認済みshortcut／registryだけを除去し、DataRoot内の環境設定、本文・履歴、session、log、audit、追加file、DPAPI CurrentUser provider credentialを保持することを実装consumerで確認した。同じWindows userで同じrootへ再導入後もcredential参照が復号可能だった。明示`-PurgeData`は破棄範囲を表示し、隔離DataRootとそのDPAPI fileを完全削除する。production default、権限、HDS、外部provider接続は変更していない。

Windows 11 Home x64（10.0.26300）、合成credentialのみの`corepack pnpm smoke:windows-installed -- --artifact release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip`は最終runでexit 0。markers `uninstall_data_retention_result=pass`、`uninstall_secret_retention_result=pass`、`reinstall_retained_data_result=pass`、`windows_installed_smoke=pass`。最初の試行は既存watchdog回復待ちで失敗し、再実行で回復した。次の再実行は新REFキーを既存の「一件必須」編集helperで更新しようとして失敗したため、smoke testに重複拒否付きappendを追加し、同じpackageで全体を再実行した。これは製品コードの失敗ではない。`corepack pnpm typecheck`、workspace build 15 projects、installer test 20/20、`docs:check`、`git diff --check`はPASS。最終hosted QA、全suite、他OS、再起動後の証拠、QE_QC／QE_QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

UNIT_ID: G02.03（Windows製品Setup／UninstallのDPAPI資格情報保持・同root再導入・明示Purgeに限る）
STATUS: WIRED（Windows installed consumerで合成DPAPI資格情報の暗号化、既定保持、同一user再導入後の復号、表示付き明示Purgeを確認。G02.03全体ではない）
NEXT_REQUIRED_CONSUMER: 現行rev4.0と最新HEADから次の未接続producer／consumerを再選定する。G09.01のD4 Adapter→BLUE Runtime接続阻害、Linux／macOS等のOS別仕事成立は未完了。
SAFETY_STATUS: 合成値だけをDataRootへ保存し、子processへhost credentialsを渡さない既存allowlistを使用。通常Uninstallで資格情報を保持し、explicit purgeでのみ削除。秘密値はtest outputへ出さない。setup／uninstallerの所有・path検証は維持。
LOCAL_ASSET_STATUS: run固有BTsmoke rootはtest cleanupで消失確認。Windows package ZIP／manifestはローカル成果物として保持し、公開していない。workspace `dist`／tsbuildinfoはtypecheckで除去された後buildで再生成して開発環境として保持する。`.codex-tmp`／`release/windows`はOneDrive Cloud Files領域のため保留せず保持。protected添付2領域は未追跡・未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 作業開始local／origin／GitHub `main`=`102808ce80ad91bca63397a8db0c27b7a2a7c230`。開始時recovery branch／remote tag current／previous=`102808ce80ad91bca63397a8db0c27b7a2a7c230`／`9fb57175e854df0cdc2f968018d891a6acf83dcb`。閉鎖時のcommit／復旧refは履歴記録に追記する。worktreeはmainのみ。他repoは変更していない。

## 前段完了BUILD_BATCH — QE_BUILD / D03.01 D4 Runtime冪等受付と状態照会

`POST /runtime/intent`はUUIDv4の`submission_id`を必須とし、既存のprivate SQLite inboxへsession単位のscope digest、submission ID digest、intentを含むpayload HMAC、server request ID、状態だけを保存してからhandlerへ渡す。同じsession・ID・入力の再送は既存request IDと状態を返して再dispatchせず、同じIDで入力が変われば409で拒否する。専用D4 Runtime bearerで認証する`POST /runtime/intent/status`は、同sessionのrequest IDと`dispatching`／`handler_returned`／`outcome_unknown`／`rejected`状態だけを返す。生のintent、session/runtime ID、submission ID、credential、処理結果は保存・状態応答へ含めない。

handler failure時は同sessionへ固定の`kind=error`とrequest IDをbest-effortで通知し、状態は`outcome_unknown`にする。callbackが正常復帰した`handler_returned`は、使用者目標の達成・結果配送・M receiptを意味しない。再起動時の`dispatching`は`outcome_unknown`へ移し、同じsubmissionを再実行しない。処理結果本文の永続化・回復、実D4 producer、D4側status consumerは含まない。

Protocol／WebChat／Gateway build、WebChat D4 Runtime focused test 7/7（同file 125件skip）、owner-task focused regression 3/3、Gateway durable store restart test 1/1はPASS。このBLUE ingress sliceだけをD03.01の限定`WIRED`とする。D4 producer→BLUE ingress未接続のためG09.01／D03.01全体は`BLOCKED_AUTHORITY`／`BUILD_GAP`。全suite、D4実接続、Android実機、製品全体SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは未成立。

UNIT_ID: D03.01（冪等受付・content-free状態照会・handler failure通知のBLUE側限定slice）
STATUS: WIRED（同じsession/submission IDの一回受付、再送抑止、状態照会と接続中の失敗通知。結果回復・実D4 producerを含まない）
NEXT_REQUIRED_CONSUMER: D4 `blue_tanuki_adapter` producerが`submission_id`付きintentを既存BLUE ingressへ送信し、同sessionでstatus／結果を扱う。D4別repo書込みはownerの限定委任待ち。
SAFETY_STATUS: submission IDは冪等性専用で権限ではない。claimを永続化できない時はhandlerを呼ばず503。同じID・異payloadは409、同一payload duplicateはdispatchしない。状態APIは専用D4 Runtime bearerとruntime/session scopeに束縛し、request IDとcallback状態のみ返す。`handler_returned`を目標達成と解釈しない。raw intent／token／session/runtime IDはinboxや状態応答へ保存しない。inboxの保持上限・期限は未設計で、自動pruneを行わない。容量影響は未評価。
LOCAL_ASSET_STATUS: test内SQLite temp rootは終了時削除。Protocol／WebChat／Gateway build生成物は既存開発環境として保持。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始local／origin／GitHub `main`=`9fb57175e854df0cdc2f968018d891a6acf83dcb`。編集前recovery branch／remote tag current／previous=`9fb57175e854df0cdc2f968018d891a6acf83dcb`／`8816fd4f6f77aabbc7a1d69bf1d7f8ddbb198267`。BLUE worktreeはmainのみ。D4 `main`／remoteは`d173657ab1fd2707cd7c7c50cb2b73f40dadcd2e`で一致。D4にはdirty並行worktree `codex/linux-same-source-update`（`0cb7d2e4204e1b32bfd108f9ecda29434c1ac3e5`）とcleanな`codex/linux-mcp-discovery-diagnostic`（`611136525d71234589ded2526483b4fee4cef399`）を観測。別repoは読み取りのみ。

## 前段完了BUILD_BATCH — QE_BUILD / D03.01 D4 Runtime受理後handler failure通知

`POST /runtime/intent`が認証・入力検査後に202受理した依頼について、Gateway handlerが拒否した場合、BLUEが同じ認証済みsessionへ固定の`kind=error`と同一request IDをbest-effortで送る。例外本文、intent、token、runtime/session識別子はerror frameとlogへ含めない。利用側に結果unknownと再送抑止を伝える。これは切断中のdurable通知・再取得やD4側consumerを含まない。

`webchat.test.ts`の該当1件PASS（同file 130件skip）、channel-webchat typecheck PASS、`git diff --check` PASS。この通知経路だけをD03.01の限定BLUE側`WIRED` sliceとする。D4 producer→BLUE ingress未接続のためG09.01／D03.01全体は`BLOCKED_AUTHORITY`／`BUILD_GAP`。全suite、切断時回復、D4実接続、Android実機、QE_QC／QE_QA、製品全体完成は未成立。

UNIT_ID: D03.01（受理後handler failure通知のBLUE側限定slice）
STATUS: WIRED（接続中の同sessionへのbest-effort error通知。永続化・実D4 producerを含まない）
NEXT_REQUIRED_CONSUMER: D4 `blue_tanuki_adapter` producer→既存BLUE Runtime ingress→同session応答consumer。D4別repo書込みはownerの限定委任待ち。
SAFETY_STATUS: 入力は従来どおり専用D4 Runtime bearer・runtime ID・接続中session・既存Gateway handlerを通る。通知は固定内容、request ID相関のみ。例外／intent／credential／caller referenceを出さず、handler failureを成功や拒否へ誤分類しない。
LOCAL_ASSET_STATUS: 専用test temp assetなし。既存依存とtest runner cacheは開発環境として保持。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡・未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始local／origin／GitHub `main`=`8816fd4f6f77aabbc7a1d69bf1d7f8ddbb198267`。編集前recovery branch／remote tag current／previous=`8816fd4f6f77aabbc7a1d69bf1d7f8ddbb198267`／`5cc46537094cd774acf37fa7aa94bda3595adda1`。BLUE worktreeはmainのみ。D4 remoteは読み取りのみ、別repoへの変更なし。

## 前段完了BUILD_BATCH — QE_BUILD / E04.02 calendar／drive読取履歴をFailureReviewへ接続

既存Complete Historyに記録された同一のread-only `google.calendar.read`／`google.drive.read`だけを、検証済みchain、完全な失敗baseline、後続履歴順、正確なoperation・action/input・actor/channel・成功result digestで照合する。条件がそろう場合だけ、既存FailureReview projectionからHDS Cへoperation名と追加hash済みresult digestを渡す。生のカレンダー／Drive内容、metadata、credential、entry ID、raw errorは渡さず、Google APIは呼び出さない。記録済み結果は原因・現在状態・外部条件解消・再開権限を証明しない。

Gateway依存7 workspace project buildと`failure_review_runtime.test.ts` 11/11はPASS。actor不一致・channel不一致の負例は投影なし。`git diff --check`と`docs:check`の結果は同batchの進捗記録を参照する。全suite、実provider／credential／FailureReview往復、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このextensionだけをE04.02の限定`WIRED`とし、工程全体や製品全体完成へ拡張しない。次の独立BUILD_BATCHでは現行rev4.0とHEADからconsumerを再選定する。G09.01はD4 adapter producer→BLUE ingressの別repo権限がないため`BLOCKED_AUTHORITY`のまま保持する。

## 保留中の別経路 — QE_BUILD / G09.01 Android導入・起動・初期設定

主語はAndroid native Mobile入力・認証・仕事ID／結果producerと、Desktop BrokerおよびBLUE Gateway／C／J／M consumerである。目的はD4の既存Device Link契約を通じて一仕事を実consumerまで接続すること。rev4.0のBT-R-G09-01／02に対し、この単位は未完了であり、G09.01全体を`WIRED`または完了と扱わない。

現物の状態:

- BLUE側にAndroid／Mobile製品ソースはなく、`apps/`はGatewayのみ。既存D4 Runtime入力受け口は`packages/channel-webchat/src/webchat.ts`にあり、専用D4 Runtime bearerで`/runtime/ws-ticket`、冪等`/runtime/intent`、content-freeな`/runtime/intent/status`を扱う。入力は永続claim後に既存Gateway handler／HDSへ限定userとして渡す。受け口は存在するが、D4からの接続は未成立で、D4 producerによるstatus／結果consumerも未接続。
- 2026-11-12の読み取り観測でD4 remote／local `main` HEAD=`8da02d7eae0ea518618e9fc322fa81dcfbbd03b3`は一致。Android native `apps/mobile_flutter/lib/services/device_link_client.dart`（blob=`e8c49337127cb7f62fad248988b99707c5e49219`）は対話開始・送信・取得・中止を公開する。一方、同じmainの`packages/blue_tanuki_adapter/adapter.py`（blob=`670cc387862328c5e6ee91a3e6fee4686016ef02`）はhealth／ready／snapshot／audit等の参照応答だけを持ち、BLUE Runtimeへintentを送るproducerや同一session結果consumerを持たない。
- BLUE受け口は、同じsubmissionの一回受付・再送抑止・session scoped状態照会、handler failure時のbest-effort通知を実装した。Protocol／WebChat／Gateway build、WebChat focused test 6件、Gateway SQLite再起動試験1件はPASS。ただしD4による送信／status取得、処理結果本文の回復、Android実機証拠ではない。
- 同日のD4並行作業状態：`C:\d4-qe-main`はHEADが上記remote mainと一致するが、A2A／Broker／launcher等7 tracked filesに未commit変更あり。OneDriveのD4 Pocket worktree `codex/linux-same-source-update`（HEAD=`0cb7d2e4204e1b32bfd108f9ecda29434c1ac3e5`）にはLinux update関連12 staged files、`C:\d4-qe-20261105`の`codex/linux-mcp-discovery-diagnostic`（HEAD=`611136525d71234589ded2526483b4fee4cef399`）はclean。すべて読み取りのみ、D4変更なし。Android端末／AVDは未確認。

`STATUS: BLOCKED_AUTHORITY`。BLUE側receiverは合成入力、重複受付抑止、状態照会、handler failure通知までの限定経路を持つが、D4 native producer→D4 `blue_tanuki_adapter`→BLUE ingress→同session status／結果consumerの実接続がない。次に必要なのは、D4 Adapterが専用のserver-side credentialとsubmission IDを使って既存BLUE ingressへ認証接続し、同じsessionのstatus／結果をBrokerへ返す責任経路の実装・検証である。これはD4別repo変更のため、既存の限定委任がない範囲の書込みは行わない。D4の並行worktreeを避け、BLUE内に第二Mobile／Broker経路を複製せず、G09.01を未完のまま保持する。実provider・実資格・外部業務作用・製品公開・Android実機試験は行わない。

## 直近完了BUILD_BATCH — QE_BUILD / F05.02 GitHubの既存tagへの未公開draft release作成

主語は既存`github.write`と、それを使うHDS-J／Operation Plan／Executor／Gateway／Developer Control Centerである。目的は、既存tagが現在指すcommitに固定したrelease draftの新規作成だけを、独立した`github:release.write`能力とno-storeのL3内容確認へ接続すること。公開release、asset追加、tag作成・変更、実GitHub API送信は含めない。

Protocolはrepository ID／canonical name／visibility、正確なtag object SHA／type、tagが直接指すcommit、release不存在、release name／bodyをdigestへ束縛する。lightweight tagとcommitを直接指すannotated tagを扱い、nested annotated tagは対象外。HDS／Operation Planはrequest／target digestと固定結果形を検査し、Executor／Gatewayはreview kind・対象版・command・plan bindingを照合する。Control Centerはrelease内容、repository visibility、tag／commit、draft／未公開／assetなし、通知の可能性、非原子的観測、結果不明時の自動再送なしを表示する。作用直前にrepository・tag・既存releaseを再観測し、GitHubの作成応答とtag／release readbackが一致した場合だけ受理receiptを返す。明示拒否と結果不明は区別し、結果不明を自動再送しない。

`corepack pnpm typecheck`と全workspace build（15 projects）はPASS。Focused testsはcore `tools_builtin.test.ts` 98 passed／6 skipped、HDS Operation Plan 2 passed、WebChat review 1 passed、Gateway real-process loopback `release.draft.create` 4 passed／84 skipped、Gateway plugin loader 9 passed。Gateway試験は合成GitHub endpointのみを使用し、L3内容review前はPOSTなし、内容承認後のPOST一回、draft readback、受理／拒否／結果不明のJ/M結果照合を確認した。`corepack pnpm docs:check`と`git diff --check`もPASS。日本語基底監査の既存移行負債76件は注意として維持。全workspace test、GitHub実credential／API、実release、owner browser操作、他OS、QE_QC／QE_QAはNOT_RUN。

UNIT_ID: F05.02（GitHub release作成consumerの限定slice）
STATUS: WIRED（HDS／L3／Executor／Gateway／synthetic loopback provider／Operation Plan結果・M receiptまでの限定接続。実GitHub作用の証拠ではない）
NEXT_REQUIRED_CONSUMER: G09.01 Android native product entryの現物確認とD4 mobile contractのread-only照合。D4／MINIDORA別repo編集、C08.03実provider、Rust authority cutover、公開・出荷GOは保留。
SAFETY_STATUS: `draft=true`、`prerelease=false`、`generate_release_notes=false`、assetsなしに固定。既存tagとrelease不存在を再確認する。通知が発生する可能性をL3表示する。POST／readbackは非原子的であり、不確定結果を自動再送しない。
LOCAL_ASSET_STATUS: 全workspace buildとfixtureが使用するignored `dist`／Rust `target`は再生成済みのローカル開発物として保持。test固有temp rootはcleanup済み。外部artifact・実releaseなし。protected `.codex-attachments/`／`.codex-remote-attachments/`は未追跡のまま保持。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始時local／origin／GitHub main=`77b0bd3e449a2bbecc88a3fec9442d14892d7e1f`。編集前local recovery branch／remote backup tag current／previous=`77b0bd3e449a2bbecc88a3fec9442d14892d7e1f`／`bf1297331db32ccb3fb509b66e3b4abcb4bb09a0`。worktreeはmainのみ。他repoに書き込んでいない。閉包後のmain／復旧ref照合は履歴記録を参照。

## 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows installed lifecycleの秘密分離・rollback・中断復旧

主語はWindows installed smoke runnerの子process、およびSetup／Update／Recovery／Uninstallが所有範囲を検証するmanaged product treeである。目的は、ホストcredentialをproduct子processへ継承せず、Windows製品の導入・更新失敗・中断復旧・データ保持・削除を隔離実物でつなぐこと。

`scripts/smoke_windows_installed.ts`にallowlist子環境を接続した。SystemRoot／WINDIR／SystemDrive／ComSpec／PATHEXT／system-only PATH／OSと、run固有APPDATA／LOCALAPPDATA／TEMP／TMP／USERPROFILE／HOME／HOMEDRIVE／HOMEPATHだけを五つのPowerShell／cmd／Node spawn siteへ渡す。`install/windows/safe-target.ps1`の`Get-ManagedTreeInventory`は、各entryごとの`$entries +=`配列複製を`List[object].Add`へ置換した。個別SHA-256、reparse拒否、path正規化、最終sortは維持する。

Windows 11 Home x64（10.0.26300）で`corepack pnpm package:windows`、`corepack pnpm docs:check`、PowerShell parse、`git diff --check`はPASS。更新後packageは2,545 entries、48,412,095 bytes、SHA-256=`1fd8e883a4434065e1d3bf38d30d557473ab93740809ce5e7441cc5dc09be542`。ZIP内`app/install/windows/safe-target.ps1`とsourceのSHA-256=`6c38af470cda2aa9ef58ac4c171804ea5cd3d924486973fb62e8ba878aaed1ad`が一致。installerはunsigned、bundled Node runtimeをhash照合済み。

`corepack pnpm smoke:windows-installed`は終了コード0。source guidance／dry-run、package verify、Setup／Repair、設定保持、HKCU Run enable／disable readback、port-conflict拒否、Gateway health／WebSocket first-message、Approval、Audit valid／tamper rejection、crash recovery、stop／doctor／restart／safe-mode、Windows Setup update failure rollback、rollback後の旧install／設定／DataRoot保持、update中断後に旧installを検証・復元して更新を再開、stage／rollback cleanup、通常Uninstall後のDataRoot保持、同一root再導入、隔離DataRootの明示PurgeまでPASSした。最初の更新failpoint runでは600,000ms ETIMEDOUTが出たが、inventory蓄積を変更した後の同条件再実行では再現せず、rollbackと中断復旧がPASSした。これは単一Windows 11 hostでの限定installed smoke証拠であり、広範な性能評価ではない。

providerはstubで、実LLM/provider secret・外部作用・実ユーザーデータは使用していない。出力中の`reboot_persistence_result=pass`はHKCU Run値のenable／disable検査を指すため、Windows本体の実再起動は未実施。SmartScreenの結果はpackage guidance確認のみで、署名・画面通過・保護解除を示さない。過去のWindows Server 2022 run `42968413273`は別環境の限定証拠として維持する。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOは未成立。

初回smokeの失敗root `%LOCALAPPDATA%\BTsmoke\w-x8Lq7k`は10,092 files／283,305,471 bytesで、synthetic package複製・監査fixture・未完stageと、同rootだけで生成した5つのrandom setup tokenを含むことを確認した。現存process／Uninstall登録／Run登録／reparse pointなし。原因調査と後続PASS後、この正確なrootだけをWindows標準Recycle Binへ移し、元path不在とRecycle Bin metadata内のoriginal path／283,305,471 bytesを照合した。成功run root `%LOCALAPPDATA%\BTsmoke\w-juU7KC`はsmoke cleanup後に不在で、関連processなし。ごみ箱移動分は空き容量回復に数えない。

UNIT_ID: G02.03（Windows installed update／rollback／中断復旧／Uninstallの隔離consumer）
STATUS: WIRED（Windows 11 hostの限定installed smokeで上記consumer PASS。実OS再起動、clean Windows別環境、実provider、5OS QAではない）
NEXT_REQUIRED_CONSUMER: 次の独立BUILD_BATCHでrev4.0と最新HEADを再同期し、全体施工で最も欠けるconsumerを選ぶ。現repo source scanでAndroid／iOS native product entryは見つからなかったため、G09.01 Android entryと既存D4 mobile契約のread-only照合を優先候補とする。D4Pocket／MINIDORAの別repo変更、C08.03実provider、Rust authority cutover、公開・出荷GOは保留。
SAFETY_STATUS: 子processはallowlist envのみ。provider=stub、実外部作用なし。失敗・成功両runのInstallRoot／DataRoot／registry／processを閉鎖。旧失敗rootは正確なRecycle Bin itemとして保管し、OneDrive／別repoは変更なし。
LOCAL_ASSET_STATUS: `release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip` 48,412,095 bytes・上記SHA-256を現行source packageとして保持。成功smoke rootはcleanup済み。失敗smoke root 283,305,471 bytesはRecycle Bin移動済み（復元可能、空き容量回復ではない）。`.codex-attachments/`／`.codex-remote-attachments/`はprotected untracked保持。OneDrive内`.codex-tmp`には触れていない。
CURRENT_HEAD_AND_DIRTY_OWNER: 今回batch開始main=`bf1297331db32ccb3fb509b66e3b4abcb4bb09a0`。編集前local recovery branch／remote tagはcurrent=`bf1297331db32ccb3fb509b66e3b4abcb4bb09a0`／previous=`661102d39e56de6a294a0dd7cc205221ce20f611`へCAS照合して回転。worktreeはmainのみ。protected attachment directoriesは未変更。fetch時のstale `.git/worktrees/blue-tanuki-health-2026-11-07-windows` cleanup ACL拒否は迂回せずmetadataを保持した。

## 前段完了BUILD_BATCH — QE_BUILD / F17.03 Canvasからsynthetic C・J・Broker・M receiptまでのローカル縦断

主語はWebChat Control Centerが表示するCanvas成果物と、その本文を使うowner-authenticated Task経路である。目的は、Canvas生成応答のrequest ID／MIME／UTF-8本文／SHA-256／versionへ束縛したowner意図を一回限り親Cへ送り、既存Jの委任目的関係・plan step審査、Approval Gate、隔離Broker file.write、結果照合、M receipt、ownerの明示達成規則、再起動復元まで同一taskで接続すること。

実行した確認は corepack pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts -t "routes bounded Canvas data only to parent C and verifies an owner-reviewed local file.write receipt" --maxWorkers=1 --minWorkers=1。PASS：1件、同file内7件skip。localhostでGatewayを実起動し、synthetic Canvas／C、fixture owner・resume token、owner review endpoint、隔離temp file rootを使った。実行後、対象fileの本文とbytesを照合し、M receiptとowner明示規則による達成を確認。Gatewayを再起動し、同じplan／receipt／達成状態が復元され、fileを再実行しないことを確認した。

これは既存コードの限定synthetic WIRED consumer確認である。実LLM、実provider、実人間のL3操作、Control Center実ブラウザー操作、外部書込み、実ユーザーデータ、製品全体のSYSTEM_SHAPED／BUILD_COVEREDは含まない。試験はSQLiteのExperimentalWarningを出したが成功。試験が作成するbt-canvas-file-write-* Temp rootはfinally cleanupされ、再確認時に残存なし。

UNIT_ID: F17.03（Canvas由来のowner taskからローカルsandbox作用・M receipt・達成後停止までの限定slice）
STATUS: WIRED（synthetic C→owner-authenticated Task→J purpose/relation/step→Approval→sandbox file.write→verified result/M receipt→明示規則評価→restart restore。実LLMや実ユーザー操作の証拠ではない）
NEXT_REQUIRED_CONSUMER: 次の独立作業でrev4.0・最新HEADを再照合し、P2全体連結から選定する。C08.03実provider、F04.03の専用Drive live作用、実外部作用は個別保留を維持。Windows installed product lifecycleなどローカル隔離で進められる残存consumerを優先候補として現物確認する。
SAFETY_STATUS: file.writeはテスト専用Temp root内だけ。承認はfixture tokenで経路を駆動する合成入力であり、人間ownerの実同意を代行しない。Canvas内容・LLM出力・M receiptは権限を作らない。
LOCAL_ASSET_STATUS: test Temp rootはcleanup済み。新規package／外部artifactなし。既存ignored build outputは変更していない。protected attachment directoriesは保持・未stage。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始時local／origin／GitHub main=f1bfb122d795cdf19101b610ce79180cced6a100。編集前recovery branch／remote tag current／previous=f1bfb122d795cdf19101b610ce79180cced6a100／6e8b9ee1597af12763781b43af5e806860315e0bへ照合付きで回転。作業開始時の未追跡はprotected attachment directoriesのみ。

### 前段完了BUILD_BATCH — QE_BUILD / F04.02 Google Driveの公開リンクreader共有を独立L3 consumerへ接続

主語は既存`google.drive.write`と、その候補を扱うHDS-J／Gateway／Executor／Control Centerである。目的は、私有のfile作成・個別ユーザーgrantから独立した`permissions.create.public_link`を追加し、Ownerが公開範囲と公開される現行本文を確認した場合だけ作用候補・承認へ進めること。実provider共有ではなく、通常consumerのコード接続と合成fixture疎通までを扱う。

公開操作はOwner taskが対象fileと「リンクを知る全員へのreader公開」を明示した場合だけ候補化する。引数は`sharing_scope=anyone_with_link`、`role=reader`、`allow_file_discovery=false`に固定し、既存の非公開作成／共有許可を転用しない。対象は認証中Ownerが所有するMy Driveの単一`text/plain` file、本文はUTF-8 64,000 byte以内。既存の有効な`anyone` permission、非完全なACL取得、対象・版・本文の変化は作用前に拒否する。

HDS C計画文、Jのtarget-version検査、Executor、GatewayのL3 content review経路、Control Center表示を同一operationへ接続した。no-store reviewはfile identity／版／アクセス権一覧／公開範囲と本文全体・byte数・SHA-256を表示し、本文は`textContent`で表示する。Approval Gateのhigh／L3、Executor ticket、作用直前の再照合を維持する。Drive APIへは`type=anyone`／`role=reader`／`allowFileDiscovery=false`だけを送る。通知メール・所有権移転は要求しない。

作用後にpermission ID、アクセス権一覧、対象版と本文を再読する。応答不明・readback不一致は自動再送も自動取消もしない。Google側の並行権限／本文変更を原子的に排除できないため、失敗時は公開アクセスが残る可能性と手動で共有状態を確認する必要を伝える。この時点で実際のGoogle Drive API・credential・外部共有は使用していない。

対象確認：protocol／HDS-BRAIN／core／Gateway／channel-webchat buildはPASS。`packages/blue-tanuki/test/google_drive_public_link.test.ts`の合成request fixture 5件はPASS（許可範囲、既存公開grant拒否、レビュー後本文変更、結果不明の再送抑止、readback、L3区分）。Control Center script parseの選択test 1件PASS。`docs:check`／`git diff --check`はPASS（日本語基底の既存移行負債76件を注意表示）。全workspace suite、実provider、served UI、実外部共有、QE_QC／QE_QAはNOT_RUN。

UNIT_ID: F04.02（公開リンク共有の限定slice）
STATUS: WIRED（HDS計画→J／L3→Broker adapter→合成provider readback→操作結果までのコード経路。実Google Drive動作ではない）
NEXT_REQUIRED_CONSUMER: 次の独立作業開始時にrev4.0と最新HEADから再選定する。F04親成果、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。
SAFETY_STATUS: 公開reader共有専用。非公開許可の転用不可。内容・対象・permission digest不一致時は送信前拒否。送信後の結果不明はpublic accessが残る可能性を明示し、再送・自動取消をしない。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始時local／origin／GitHub main=`6e8b9ee1597af12763781b43af5e806860315e0b`。編集前local recovery branch current／previous=`6e8b9ee1597af12763781b43af5e806860315e0b`／`a5f6e0bec8cc94e54ac25a639d1fe0c0a4299471`、remote backup tagも同じSHA。`git fetch origin main`はmainを取得したが、stale `.git/worktrees/blue-tanuki-health-2026-11-07-windows`整理でpermission deniedを報告。迂回・変更はせず、`git worktree list`ではmainのみを確認。protected `.codex-attachments/`／`.codex-remote-attachments/`は保持。終了SHAはmain push後にgitで照合する。
LOCAL_ASSET_STATUS: buildで更新されたignored workspace `dist`とRust `target`生成物、test runner cacheは稼働中の開発生成物として保持。stale worktree metadataはpermission deniedのため未変更・保留。新規の外部artifact／実Drive dataはなし。protected attachment directoriesは未変更。

## 前段完了BUILD_BATCH — QE_BUILD / F04.01 Google Docsの限定exportを資料整理consumerへ接続

主語は既存`google.drive.read`とGatewayの`/organize-drive file_id=<exact-id>`本文consumerである。目的は、既存の単一`text/plain` blob読取に加え、Google Docs native document一種だけを`text/plain` exportで同じ一時・非信頼資料整理経路へ接続すること。F04.01のfile ID／MIME／version・revision／sharing取得と、文書内指示をownerの目的・権限へ昇格させない境界を維持する。

Drive metadataは一つのexact `file_id`、非trashed、`canDownload=true`、versionあり、sharing情報ありを要求する。blobはmetadata sizeと実bytesを一致させる。Google Docsは`files.export`の`text/plain`だけを使い、元sizeとexport bytesを誤比較せず、実export byte数をconsumer既存上限12,000以内に制限する。両経路とも厳密UTF-8・制御文字検査、本文SHA-256、読取前後の同一file/version/revision/sharing state digest一致を要求する。Slides、Sheets、他Workspace形式、binary、検索結果、Operation Plan、直接本文表示は対象外。

達成表示は資料引用projectionの`completed`から推定しない。ownerが選んだ現行J正本に結び付く明示規則、同一revisionの検証済みoperation result、M receiptが揃う場合のみ達成し、不足・曖昧は保留する既存C08.02経路を維持し、本batchでは判定・J/M・権限・実行・書込みを変更しない。Google API live、実資料、実provider、LLM、外部作用は未実施。

`pnpm --filter @blue-tanuki/core build`と`pnpm --filter @blue-tanuki/gateway... build`はPASS。`pnpm docs:check`はPASS（日本語基底の既存移行負債76件を注意表示）。履歴末尾を整えた後の`git diff --check`もPASS。テストはNOT_RUN。F04.01の限定consumerを`WIRED`とし、F04全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、公開・出荷／owner GOへ拡張しない。

UNIT_ID: F04.01
STATUS: WIRED（既存blob読取とGoogle Docs `text/plain` exportを、版照合付きの一時資料整理consumerへ接続。実providerの動作証拠ではない）
NEXT_REQUIRED_CONSUMER: 次の独立作業開始時に現行rev4.0と最新HEADから再選定する。C08.03実provider、別repo変更、Rust authority cutover、公開・出荷判断は保留。
SAFETY_STATUS: Google Docs exportは単一exact ID・read-only・untrusted input。元revisionの前後照合が崩れた場合は本文をconsumerへ渡さない。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始local／origin／GitHub main=`a5f6e0bec8cc94e54ac25a639d1fe0c0a4299471`。編集前recovery current／previous=`a5f6e0bec8cc94e54ac25a639d1fe0c0a4299471`／`1df2fda3537e92ab58689c20da2d7ea093c94c04`へ照合付き回転済み。protected `.codex-attachments/`と`.codex-remote-attachments/`は保持・未変更。
LOCAL_ASSET_STATUS: core／Gateway buildで再生成したignored `dist`は開発consumer用に保持。test temp・外部artifact・Driveデータは作成していない。

## 前段完了BUILD_BATCH — QE_BUILD / 資料整理projectionの完了表示を引用範囲へ限定

主語はGatewayから利用者へ返す資料整理projectionである。目的は、projection内部の`completed`（全非空白範囲が原文引用で被覆済み）を、owner目的全体の達成と誤読させないこと。`renderDocumentOrganizationProjection`の表示を「資料整理状態（引用範囲）」に限定し、「目的達成判定: 未判定」と、owner明示規則・同一revisionの検証済み結果・M receiptをJが照合する別経路が必要であることを明記した。Gateway呼出し、status schema、J/M判定、権限・実行・記憶更新は変更していない。

`pnpm --filter @blue-tanuki/hds-brain build`、`pnpm docs:check`、`git diff --check`はPASS。日本語基底監査は既存の移行負債76件を注意表示した。テスト、実served Gateway、実資料、実provider、外部作用、他OS、QE_QC／QE_QAはNOT_RUN。既存の資料本文引用保護、`used_for_authority=false`、`may_execute=false`、`may_commit_to_memory=false`を維持する。

UNIT_ID: 横断出力境界（198施工単位への新規要求追加なし）
STATUS: WIRED（既存Gateway→projection renderer経路。変更後のserved runtime表示は未確認）
NEXT_REQUIRED_CONSUMER: 現行rev4.0と次回HEADから製品全体の未接続実consumerを選ぶ。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。
SAFETY_STATUS: ownerの達成判定を代行せず、M・実行・権限・外部作用は変更なし。
CURRENT_HEAD_AND_DIRTY_OWNER: 開始main=`1df2fda3537e92ab58689c20da2d7ea093c94c04`（開始時GitHub main一致）。編集前recovery branch／remote tagはcurrent=`1df2fda3537e92ab58689c20da2d7ea093c94c04`、previous=`4325779dcf3b8d008badaa92ba16ae4ddcc5f5c8`へ照合付きで回転済み。protected `.codex-attachments/`と`.codex-remote-attachments/`は未追跡のまま保持。
LOCAL_ASSET_STATUS: build出力は開発用生成物として保持。新規test fixture・一時領域・外部artifactは生成していない。

## 前段完了BUILD_BATCH — QE_BUILD / G04.03 macOS更新・復旧・削除

主語はmacOS x64／arm64のpackaged `BlueTanukiSetup.sh`、resident launcher／LaunchAgent、`BlueTanukiUninstall.sh`とその実consumerである。目的は、native macOS runner上の隔離installで更新失敗rollback、中断更新からの復旧、resident再起動、権限拒否、ログの読取、通常削除後のDataRoot／ConfigRoot／runtime state／ログ保持、明示Purgeを別結果として確認すること。G04.03の実装接続であり、実機QAやmacOS再起動を証明しない。

既存`scripts/smoke_unix_installed.ts`の更新失敗rollback／中断復旧fixtureはLinuxだけで実行されていたため、実際のmacOS packaged consumerにも接続する。smoke用temp rootは作成後にrealpathで正規化し、`/var`／`/private/var`表記差を製品のpath比較へ持ち込まない。G04.03の反復Setupではpost-install Doctorをskipし、独立したLauncher Doctor probeは残す。macOS向けに専用の書込不可Install parentを使ってpermission-denialを確認し、そのmodeは必ず元へ戻す。`linux-installed-package-build-smoke.yml`は既存の`workflow_dispatch`限定・`contents: read`を維持し、macOS x64／arm64 native jobから同じarchive lifecycle smokeを呼ぶ。user data、credential、実provider、別repoには作用しない。

失敗時は既存InstallRoot／RuntimeRoot／DataRoot／ConfigRootを変えずfail-closedで停止することを確認する。ログ内容は標準出力へ流さず、隔離profile内のlog path・存在・保持だけを検査する。runner内resident restartとtransaction recoveryは確認対象だが、ホストOS reboot、owner実機、署名・notary、実credential／外部作用は対象外であり、`NOT_RUN`として保持する。QE_BUILDの限定consumerであり、G04.03全体、G04親成果、macOS QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOを成立させない。

UNIT_ID: G04.03 macOS update / recovery / uninstall consumer
STATUS: WIRED（workflow_dispatch run `43005886593`／source SHA `f2dc2da5f66836960eff1a76c56bd6c31da57587`のLinux・macOS x64・macOS arm64 hosted consumersが成功。G04.03の限定consumerであり、macOS QAや親成果の完了ではない）
BATCH_STATUS: CLOSED（2026-11-11。限定consumerの実装・hosted疎通と記録を閉じた。G04.03全体、macOS QA、製品全体完成を意味しない）
PREVIOUS_NATIVE_ATTEMPTS: runs `42988683062`／`42992867367`／`42998945466`はそれぞれshim path、fixture HOME干渉、macOS lifecycle timeoutで未完了。詳細はGit履歴に保持。最後の失敗後にprocess inventory／managed-tree inventoryの余分なsubprocessを除去し、macOS両archのtransaction timeoutを900秒へ統一した。
LATEST_NATIVE_ATTEMPT: workflow_dispatch run `43005886593`（#10、source SHA=`f2dc2da5f66836960eff1a76c56bd6c31da57587`）は40m45sで成功。Linux job `130473141429`、macOS arm64 job `130473141790`、macOS x64 job `130473141837`が全てPASSした。両macOS jobで2,646 entryのarchive、one-file Setup／Repair、resident launch・HTTP／WebSocket、process stop、update-failure rollback、中断更新の復旧・再適用、permission-denial、autostart restart、Approval／audit tamper拒否、crash recovery、Doctor／restart／safe mode、通常Uninstall時のstate保持、保持状態の再install、明示Purgeを確認した。全consumer markerはPASS。artifact uploadはなく、署名・notary、host reboot、owner実機、実credential／provider、外部作用は対象外。GitHubはNode.js 20 deprecationのwarningとmacOS arm64 runner capacity noticeを表示したが、全jobは成功した。
NEXT_REQUIRED_CONSUMER: G04.03の限定BUILD_BATCHは閉鎖済み。次の独立作業では作業開始規律を再実行し、rev4.0と現行HEADから未接続consumerを選ぶ。owner指定のC08.02達成規則（明示規則＋同一revisionの検証済み根拠＋M receipt）は既存J/M実経路に限定WIREDであり、重複施工しない。C08.03実provider、D4-Pocket／ミニドラ別repo変更、Rust authority cutover、公開・出荷判断は保留。
MINIMAL_TECH_CHECKS: `pnpm typecheck`、`pnpm build`（15 workspace packages）、`pnpm docs:check`（日本語基底の既存移行負債76件を注意表示）、`pnpm validate:release-hardening`、`pnpm validate:packaging`、`git diff --check`、WSL Ubuntu 24.04で`sh install/installer/test/safe_target_unix.sh`（`unix_target_guard=pass`）がPASS。test fixtureはtrap後にTemp残存なし。run #10で固定SHAのLinux/macOS x64/macOS arm64 packaged consumerが全てPASS。全suite、native owner device／OS reboot、5OS QA、QE_QC／QE_QAはNOT_RUN。
SAFETY_STATUS: 合成package・隔離temp rootのみ。専用permission-denial parentのmodeはfixture内で復元。provider、実資格情報、署名・notary、Keychain、外部作用、別repo変更、host設定変更なし。
LOCAL_ASSET_STATUS: typecheck後にworkspace buildで再生成したignored `dist`／tsbuildinfoは稼働中の開発環境として保持。WSL fixture tempはcleanup後に残存なし。run #10はGitHub hosted runner上のみで動作しartifact uploadなし。protected `.codex-attachments/`／`.codex-remote-attachments/`は保持・未変更。
PROMOTION_AND_DIRTY_OWNER: run #10成功後、検証済みsource commit `f2dc2da5f66836960eff1a76c56bd6c31da57587`をlocal／remote mainへfast-forwardした。編集前recovery refsはcurrent=`cb5ab4d1971b47b6cf9591a845eab525930780a7`／previous=`dd2b6fa743b9b69031b820a598aa445541a494c6`のまま。protected attachment dirsは未追跡・未stage。stale worktree metadata `.git/worktrees/blue-tanuki-health-2026-11-07-windows`はACL拒否のため保持し、迂回・変更しない。別repo・他writerのbranchは変更しない。

### 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows update失敗rollback・中断復旧・DataRoot保持

主語はWindows installed packageのSetupと、更新前InstallRoot／DataRootを引き継ぐ再Setup。目的は、更新失敗で検証済み旧app／bundled runtime・設定・利用者DataRootを復元し、Setup process中断後の次回Setupが旧版を復元して更新を再開する実consumerを接続すること。rev4.0 G02.03の`BT-R-G02-04`を主対象にし、`BT-R-G02-05`の非署名・OS保護境界を変えず、`BT-R-G02-06`の通常保持／明示Purgeを維持する。G02.03全体、実OS再起動、Windows Desktop QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は主張しない。

`install/windows/safe-target.ps1`の中断復旧は、復元した旧managed installを再検証し、同じtransaction GUIDを持つstaging siblingをmanaged inventory・対象InstallRoot/DataRoot・直接親・reparse不在で検証した場合だけ削除する。検証／削除が成立しないstagingは警告付きで保留する。`scripts/smoke_windows_installed.ts`は隔離package複製に合成markerを加え、旧appのbackup移動直後に注入失敗・process停止を行う。次に実Setupをbackup移動直後で停止し、旧app／runtime・設定bytes・DataRoot sentinel・resident process・registryを別々に観測してから、次Setupによる復元・更新再開・staging片付けを確認する経路を追加した。`validate_product.ts`と`validate_packaging.ts`も3つの更新lifecycle markerを必須化した。

ローカル`pnpm typecheck`、`pnpm build`（15 workspace projects）、`safe-target.ps1`／Setup.ps1／smoke内PowerShell hookの構文解析、`git diff --check`はPASS。local installed smokeは既存product install／HKCU登録を触らないためNOT_RUN。Windows Server 2022 workflowは`workflow_dispatch`限定・`refs/heads/main`限定・`contents: read`である。source commit `358ce35be1a4f7e79fc3222ce4d706e2e2af975b`が祖先で、対象code／workflowに後続変更がないことを照合し、owner認証済みGitHub画面からmain SHA `46685ccef0870a9441338e44394dc5b27474d4be`へrun `42968413273`（#10）を一度だけdispatchした。Windows 2022 jobは11m09sで成功し、workspace build、Windows package build／verify、isolated installed smokeの全stepがPASSした。`update_failure_rollback_result=pass`、`interrupted_update_recovery_result=pass`、`interrupted_update_staging_cleanup_result=pass`、`uninstall_data_retention_result=pass`、`reinstall_retained_data_result=pass`を確認し、最終`windows_installed_smoke=pass`。run artifactは0件。これは当該Windows Server 2022 hosted installed consumerの限定BUILD証拠であり、OS再起動後の復帰、clean Windows Desktop、G02.03全体、5OS、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`やQE_QC／QE_QAへ拡張しない。

追加したWindows safe-target fixture確認：`pnpm exec vitest run install/installer/test/windows_safe_target.test.ts` PASS（2/2）。中断rollback fixtureを含む一時directory内の合成install／DataRootだけを使用し、実installed product／HKCU登録／利用者DataRootへ作用しない。テスト終了後、当該fixtureのTemp rootは残っていない。この証拠は実Setupを使うhosted installed smokeの代替ではない。

UNIT_ID: G02.03 Windows installed update-failure rollback／interrupted-update recovery consumer
STATUS: WIRED（run `42968413273`／main SHA `46685ccef0870a9441338e44394dc5b27474d4be`のWindows Server 2022 hosted installed smokeで、失敗rollback・中断復旧／更新再開・staging cleanup・DataRoot保持を確認。G02.03全体は未成立）
NEXT_REQUIRED_CONSUMER: C08.02のC/J/M境界停止・復帰。owner選択に従い、現行J正本へ結び付く明示達成規則、同一revisionの検証済み結果、M receiptが揃う場合だけ達成とする。欠落・曖昧・未確認は保留し、各境界から最後の確認済み保存点へ復帰し、Jの達成判定後に停止する通常consumerを接続する。
SAFETY_STATUS: smokeのInstallRoot／DataRoot／package／markerはrun固有一時root内だけ。更新失敗は旧installを動かさず検証し、interruption helperはmarker内PIDが起動したPowerShell child PIDと一致した場合だけそのchildを停止する。秘密値はログへ出さず、署名・Defender等OS保護を変更せず、実provider／外部作用／releaseは行わない。実ユーザーデータ、保留中local install／registry、別repoには作用しない。
LOCAL_ASSET_STATUS: 今回のWindows packageとsmoke一時領域はhosted runner内だけで生成・cleanupされ、artifact uploadなし・run artifact 0件。local package artifact／smoke Temp rootは生成していない。前回の`pnpm build`で再生成したignored `dist`／tsbuildinfoはWindows開発用に保持。protected `.codex-attachments/`／`.codex-remote-attachments/`は未変更。
CURRENT_HEAD_AND_DIRTY_OWNER: 今回の文書編集前local／`origin/main`／GitHub `main`=`46685ccef0870a9441338e44394dc5b27474d4be`。編集前の復旧ref current=`38ed69c5e0e226d0d12c10a02fe76c59a720d838`／previous=`5ab893bb220e5fdd3e9dabea6cb02b64f24c0eb9`から、意味のある編集前にlocal recovery branch／remote tagをcurrent=`46685ccef0870a9441338e44394dc5b27474d4be`／previous=`38ed69c5e0e226d0d12c10a02fe76c59a720d838`へ照合付きで回転した。worktreeはmainだけ、dirtyはprotected attachment directory二件のみ（未追跡・未stage）。D4-Pocket／ミニドラは変更していない。stale metadata `.git/worktrees/blue-tanuki-health-2026-11-07-windows`はACL拒否のため保持し、metadata／ACLは迂回・変更しない。

### 前段完了BUILD_BATCH — QE_BUILD / G02.01・G02.02 Windows package Setupから通常利用へ接続

主語はWindows配布packageのSetup、Launcher、Gateway、Uninstall。目的は開発toolを前提としない製品導入から通常利用・保護境界までを実際のWindows package経路で接続すること。rev4.0のG02.01／G02.02を対象とし、source起動・fixture・別OS結果をinstalled Windowsの証拠へ読み替えない。

Setup後DoctorはWindows PowerShell 5.1でnative stderrが`$ErrorActionPreference = Stop`によりSetupを中断しないよう、JSON stdoutとstderr logを分離してNode終了コードで判定する。Launcher Doctorにも同じstderr境界を適用した。installed smokeは一意の隔離profile／DataRoot、system-only child PATH、レジストリ事前確認、実行中Gateway PIDの事前検査を使う。実行中の不明Gatewayを停止・更新・削除しない。

Launcherのprocess inventoryは、相対`apps/gateway/dist/main.js --serve`という文字列だけで別processを自install所有と誤認しないよう修正した。実際のNode process名を確認し、相対entryは自installのbundled Node imageまたは一致する`--env-file`に束縛する。絶対entry・同一runtimeなのにDataRoot不明・process image不明は引き続きfail-closedとする。現PID `17528`はworking directoryがrepo root、実行Nodeが別install配下、state/session rootがsmoke DataRoot外、`--env-file`なしと観測した。process自体は変更していない。

ACTIONS_SCOPE: `workflow_dispatch`専用のWindows 2022 hosted runnerを使用する。workflowは`contents: read`のみで、secret／artifact uploadはない。run `42917086029`（SHA `937ea684`）はRust toolchain channel不正でworkspace build FAIL、run `42918832218`（SHA `c3d4f13`）はbuild／package verify PASS後に`tar.exe`展開FAIL。PowerShell `Expand-Archive`へ直したrun `42920784728`（SHA `fb782f3d712717174befdc1c18a0bb16f41dbd12`）はbuild、2,544-entry package verify（SHA-256=`e0092925916bd66b089bb0fc9070d69b275aa23767a60a185f2080929ded0f9c`）、展開、初回Setup、Repair、autostart enable/status/disable、port conflict拒否までPASSした。Launcherはresident PID `6512`／watchdog PID `7304`を返したが、healthzが45秒以内に応答しなかった。停止は両PIDとも確認でき、続くUninstall cleanupもFAILして隔離install rootをrunner内に保全した。run `42920784728`はartifactをuploadしておらずrunner終了後のログを再取得できない。今回smokeのUninstall status fileが製品契約の許す`%TEMP%`配下・所定名の外にあった欠陥を修正し、Gateway stderrの秘密値を伏せた起動段階／TCP診断を加えて再実行する。次のrunでGateway起動根因を確認・是正し、通常利用・first message・Uninstallまでつなぐ。証明範囲は当該runner上の隔離installed smokeに限り、Windows Desktop QA／release GOの代替ではない。

run `42936917811`（main SHA `6264f7c7452b1d4fd40f22799f1273614b9234b1`）とrun `42939695019`（main SHA `89667fcaaf5fe5069236420def9edaa1453c4b66`）では、workspace／package build・verify、展開、Setup、Repair、autostart、port-conflict拒否はPASSした。run `42939695019`のenv file／process port不一致は現行smokeで修正済み。後続run `42944051144`（main SHA `1f94158aba48003bd10d105c84312c15461deeb5`）ではWindows 2022上のworkspace／package build・verify、展開、Setup、Repair、Gateway health、WebSocket first-message、approval照会、監査chain検証・改ざん拒否、resident crash recovery、stop／doctor／restart／safe-modeまでPASSした。Uninstallはstatus `exit_code=0`、install root／DataRoot不在、registry項目不在を確認した一方、wrapperがpath errorを2件出して終了1となり、run全体はFAILした。製品削除・statusと`.cmd`のプロセス終了を分けて扱う。

run `42944051144`ではsmokeの隔離env fileとGateway processのhost／port一致を確認し、Gateway healthとWebSocket first-messageを実行できた。UninstallではPowerShellがInstallRoot内の実行中`.cmd`を削除するため、同じInstallRootから起動した`cmd.exe`が終了時に2件のpath errorを出していた。一物理行の終端chainだけでは解消しなかった。現修正はwrapper自身を`%TEMP%`へstageし、元InstallRootを明示的に渡して同期実行し、child exit codeを親へ返してstage copyを片付ける。focused contract test 1件PASS／19件skip。修正版をmainへ反映し、同じWindows installed smokeでwrapper exit 0、成功status、root不在、registry不在を同時に再確認する。

後続run `42947306975`（main SHA `1acf2c20ac185357d98e97150cb0f104dd7724f6`）はworkspace／package build・verify、Setup、Repair、health、first-message、approval/audit、crash recovery、restart／safe-modeまでPASSした。PowerShell Uninstallはstatus `exit_code=0`を記録し、InstallRoot／DataRoot／registryを削除したが、同じ2件のpath errorとwrapper exit 1が残りrun全体はFAIL。Windows PowerShell 5.1の合成owned-install fixtureで再現・是正し、原因は削除後に親CMDが元`.cmd`へ復帰しようとすることと確定した。現修正は同一CMD process内でラッパーを再入し、PowerShell完了後に`exit 0`／`exit 1`でCMD process自体を終了する。`windows_target_guard=pass`、成功status、InstallRoot削除、通常Uninstall時のDataRoot保持、path errorなしをローカルで確認。関連contract test 1件PASS／19件skip、`docs:check`と`git diff --check`もPASS。hosted Windows rerunでの確認は未実施。

run `42952073483`（main SHA `07dbc1e4b68847280f459e1e94e8f6b55f37f7d4`、Windows Server 2022、workflow_dispatch）はworkspace build、Windows package build／verify、isolated installed smoke全体がPASSした。Setup／Repair、health／first-message、approval、audit tamper拒否、crash recovery、restart／safe-modeを通過し、Uninstallはwrapper exit 0、成功status file（`exit_code=0`）、InstallRoot／Purge対象DataRoot／registry不在を同一runで確認。path errorは出ず`uninstall_result=pass`／`windows_installed_smoke=pass`。secret／artifact uploadなし。対象profileはhosted BUILDに限り、clean Windows Desktop QAや全G02の成立ではない。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| 前commitのWindows package生成／verifier | PASS：2,544 entries、artifact SHA-256=`fedd0e6229f52b6ab8e2e8487fd74ab14336243ccc2ea249bf11e60f4e45dab4`。修正版commitの再生成ではない。 |
| Windows 2022 hosted workspace build（run `42917086029`、SHA `937ea684`） | FAIL：frozen installまでPASS。`packages/blue-tanuki/native/windows-isolation/rust-toolchain.toml`の不正なchannel形式でcore build失敗。package生成／verify／installed smokeはSKIP。 |
| Windows 2022 hosted workspace build／package（run `42918832218`、SHA `c3d4f13`） | PASS：workspace build、package verify 2,544 entries、artifact SHA-256=`e0092925916bd66b089bb0fc9070d69b275aa23767a60a185f2080929ded0f9c`。 |
| 同runのisolated smoke | FAIL：active-Gateway／registry preflightとsource-entrypoint dry-runはPASS。`tar.exe`がZIP entry filenameを読めず展開失敗。product Setup前に停止し、Repair／Launcher／health／first message／UninstallはNOT_RUN。 |
| PowerShell 5.1 ZIP展開経路 | PASS（旧local artifactのみ）：2,481 entries／68,251,120 uncompressed bytesを`Expand-Archive`で展開し`BlueTanukiSetup.cmd`を確認。これはrun `42918832218`の2,544-entry artifactとは異なる。 |
| smoke archive extractor correction | PASS：PowerShell `Expand-Archive`を使い、run `42920784728`で2,544-entry archive展開とinstalled Setupまで到達。 |
| Windows 2022 hosted installed smoke（run `42936917811`、SHA `6264f7c`） | BUILD_GAP：Setup／Repair／autostart／port conflict拒否はPASS。後から同じsmoke sourceを見るとprocess envだけにephemeral `WEBCHAT_PORT`を設定し、Setup `--yes`のenv fileは更新していなかった。Launcher／probeとGatewayが別portになる条件のためhealth結果はlistener欠陥の証拠にならず、後続はNOT_RUN。Uninstallはwrapper path error／終了1だがstatus `exit_code=0`、両root不在、staged script 0。 |
| Windows 2022 hosted installed smoke（run `42939695019`、SHA `89667fc`） | BUILD_GAP：workspace／package build・verify、Setup／Repair／autostart／port conflict拒否はPASS。Gatewayは同梱Node／serve args一致、stdoutにlisten `127.0.0.1:60636`。Launcherとsmokeはenv file由来8787を使い、process環境の60636と不一致。health／first message以降は未検証。Uninstallはstatus `exit_code=0`と両root不在を確認したがwrapper exit 1／path error。 |
| Windows 2022 hosted installed smoke（run `42944051144`、SHA `1f94158`） | BUILD_GAP：workspace／package build・verify、Setup／Repair、Gateway health、WebSocket first-message、approval、audit verify／tamper reject、crash recovery、stop／doctor／restart／safe modeはPASS。Uninstall status `exit_code=0`、両root不在、registry項目不在だが、wrapper exit 1／path error 2件でrunはFAIL。 |
| Windows 2022 hosted installed smoke（run `42947306975`、SHA `1acf2c2`） | BUILD_GAP：workspace／package build・verifyとSetup→通常利用・first-message・Approval／Audit・回復経路はPASS。Uninstallはstatus `exit_code=0`、InstallRoot／DataRoot／registry不在を確認したが、wrapper exit 1／path error 2件でrun全体FAIL。 |
| Windows 2022 hosted installed smoke（run `42952073483`、SHA `07dbc1e`） | PASS：workspace／package build・verifyとSetup→Repair→health／first-message→Approval／Audit→crash recovery→restart／safe-mode→Uninstall。wrapper exit 0、status `exit_code=0`、InstallRoot／Purge対象DataRoot／registry不在、path errorなし。 |
| Windows Uninstall wrapper修正 | run `42947306975`で再現した親CMDの削除済み`.cmd`復帰をsame-process re-entryと終了処理で修正。PowerShell 5.1 synthetic fixtureとrun `42952073483`のisolated installed consumerで一致してPASS。 |
| Windows Uninstall wrapper contract／docs | `windows_product_installer.test.ts` lifecycle contract 1件PASS／19件skip、`windows_safe_target.ps1` integration fixture `windows_target_guard=pass`、`pnpm docs:check`、`git diff --check` PASS。Hosted rerunは未実施。 |
| current source typecheck／workspace build | `pnpm typecheck` exit 0、`pnpm build` PASS（15 workspace projects）。typecheckが削除するignored `dist`／tsbuildinfoはworkspace buildで再生成。 |
| Rust toolchain修正後のWindows local core build／workspace build | PASS：`pnpm --filter @blue-tanuki/core build`、`pnpm build`。hosted修正版runはGitHubへ反映後に実行する。 |
| Setup／Launcher PowerShell 5.1 parser、Doctor stderr分離のsynthetic capture | PASS。 |
| `windows_product_installer.test.ts`のLauncher／Doctor／smoke契約test | PASS：1件、18件skip。 |
| relative Gateway process ownership focused test | PASS：1件、19件skip。別Nodeの相対entryと非Node command-line文字列を無視し、同一runtimeでDataRoot不明／絶対install entryの候補は保留する。これはisolated fixture上のコード確認で、installed smoke証拠ではない。 |
| `windows_product_installer.test.ts`以前の全体実行（watchdog cleanup修正前） | 履歴上FAIL：16/19 pass。resident-stop 2件は`EBUSY` cleanup、watchdog-stop 1件はstatus 2（期待0）。 |
| staged wrapper版の`windows_product_installer.test.ts`全体 | PASS：20/20。親側同期起動／exit伝達を`start /wait /b`へ最終調整する前の作業tree。最新差分はfocused contract 1件PASS／19件skipで確認。 |
| 実Windows package Setup初回導入 | PASS：隔離install／DataRootへ導入し、Doctor JSONとstderr logを記録。ホスト自体はclean profileではなくNode／pnpm等を含むため、開発tool非依存証明ではない。 |
| Repair／Launcher start／WebChat first message／Uninstall smoke | run `42920784728`：RepairとLauncher process startは到達。healthz応答がなくfirst message未到達。cleanup Uninstallも失敗。productの通常利用／first message／完全Uninstallは未成立。 |
| local smoke active-Gateway／registry preflight | BLOCKED：PID `17528`はrepo rootからの相対Gateway process、state/session rootは別の一時領域と確認した。現在のHKCU uninstall registrationは保留中smoke installを指し、新規local isolated smokeはclean registry条件を満たさない。どちらも停止・削除・上書きせず保持。 |
| hosted smoke active-Gateway／registry preflight（run `42920784728`） | PASS：新規Windows 2022 runner上で既存processなし、隔離registry条件を確認。 |
| `docs:check`、`git diff --check` | PASS：docs check／日本語基底監査／license gate、`git diff --check`。日本語基底の移行負債76件は既存注意。 |
| clean Windows user／OS、5OS、QE_QC／QE_QA | 未実施または未成立。 |

UNIT_ID: G02.01／G02.02 Windows package install-to-first-message consumer
STATUS: WIRED（run `42952073483`のWindows 2022 hosted installed smokeでSetupから通常利用・first-message・保護経路・Uninstallまで接続。clean Windows Desktop／全G02の成立には拡張しない）
NEXT_REQUIRED_CONSUMER: C08.02のC/J/M境界停止・復帰。owner選択に従い、現行J正本へ結び付いた明示達成規則、同一revisionの検証済み結果、M receiptが揃う場合だけ達成とし、欠落・曖昧・未確認は保留する。各境界から最後の確認済み保存点へ復帰し、達成後停止を通常consumerで接続する。
SAFETY_STATUS: active processのDataRootが不明な場合は停止・更新・削除しない。現在のsmoke installとHKCU登録は`C:\Users\ohira\AppData\Local\BTsmoke\w-8lYmhG`に残し、別processによる削除を保留する。
LOCAL_ASSET_STATUS: `%LOCALAPPDATA%\Codex\BLUE-TANUKI-smoke\windows-installed-p1o6Yy`は隔離package／Setup stageの生成物（10,143 files／186,848,072 bytes）で、資格情報形式・DataRoot・registry/process参照がないことを確認してWindowsゴミ箱へ移動済み。先行test fixture `%TEMP%\blue-tanuki-watchdog-stop-DSzpzt`（8 files／62,328 bytes、fake Node／ownership manifest／`WEBCHAT_PORT`のみのenv／空log）も内容・非稼働・process非参照・reparse point不在を確認後ゴミ箱へ移動し、元path消失・収容を確認。current artifact `release/windows/codex-8fcd06c9-r2`は保持。今回の`pnpm typecheck`がignored package `dist`／tsbuildinfoを除去した後、成功した`pnpm build`で全package outputを再生成し、開発環境として保持。`windows_safe_target.ps1`の`blue-tanuki-safe-target-*` fixture rootはfinally cleanup後にTemp再確認し残存なし。protected attachmentsおよびOneDrive同期領域内のpackage/probe生成物は保持し、片付け扱いにしない。
CURRENT_HEAD_AND_DIRTY_OWNER: run #8後のlocal／remote main=`07dbc1e4b68847280f459e1e94e8f6b55f37f7d4`で一致。local recovery branchとremote tagはbatch終端反映前のcurrent=`1acf2c2`／previous=`1f94158`。`git fetch origin`およびcommit後処理は古い`.git/worktrees/blue-tanuki-health-2026-11-07-windows` metadata cleanupでPermission deniedとなったため触れず、remote refsを`git ls-remote`で直接照合。Windows installed run `42952073483`はPASS。source／test変更は`07dbc1e`でpush済み、現在の3 active docsにrun結果と限定状態を記録中。protected `.codex-attachments/`／`.codex-remote-attachments/`は未変更・未stage。local pending install／registry、OneDrive package artifacts、別repo、provider、外部業務作用、公開・出荷判断は対象外。

### 前段BUILD_BATCH記録 — F17.03 Owner Task依頼IDの状態照合と明示的な次task切替

Control Centerは送信済みsubmission IDを受付・Runtime照合まで保持し、ownerが結果を確認して明示操作するまで次task用IDへ切り替えない。達成判定はowner明示規則、同一revisionの検証済み結果、M receiptを満たす場合だけHDS-Jが行う。status projectionは非権威。選択した`webchat.test.ts` 2件（127件skip）、WebChat build、`docs:check`（日本語基底の既存移行負債76件の注意あり）、`git diff --check`はPASS。実provider、owner L3、file.write、full suite、5OS、QE_QC／QE_QAはNOT_RUN。

### 前段完了BUILD_BATCH — QE_BUILD / S-02 Unix Setup／Launcher／Uninstall外部ファイル所有保護（限定安全修正）

主語はUnix製品Setupが管理する`~/.local/bin/blue-tanuki`、macOS application command／LaunchAgent、Linux desktop entryと、それらを扱うLauncher／Uninstall。目的は、BLUE-TANUKI生成時の完全な期待bytesと一致する通常ファイルだけを生成・有効・削除対象とし、一致しない内容、対象fileのsymlink、非regular file、macOS LaunchAgentsの親directory symlinkを保持すること。public repoで確認できる契約のみを扱い、HDS権限、ユーザーデータ、他repo、3点セット、公開・出荷判断は変更しない。

共通`safe-target.sh`に外部起動ファイルとmacOS LaunchAgentのrenderer／完全一致predicateを集約した。Setupは部分行一致をやめ、期待ファイル全体を照合し、同一directory stagingとno-clobber作成で既存対象を置換しない。macOS Launcherのautostart enable／status／disableとUninstallは完全一致、通常file／非symlink、正しいinstall root、LaunchAgentsの実directory parentを確認し、変更・他者所有の対象を保持する。Linux existing autostart契約は維持する。

| QE_BUILDの限定確認 | 結果 |
|---|---|
| 5 Unix shell files `sh -n` | PASS。 |
| `install/installer/test/safe_target_unix.sh` | PASS：`unix_target_guard=pass`。既存Linux fixtureに加え、Setupが期待行を含む変更wrapper／desktop entryを保持すること、macOS形式isolated product fixtureでLaunchAgent・application command・launcherの所有一致、変更・foreign install root保全、Uninstall dry-runを確認。 |
| native macOS Setup／launchd／login／reboot、Linux native、全OS、全suite、QE_QC／QE_QA | NOT_RUN。WSLのmacOS形式fixtureはnative macOS挙動の証拠ではない。 |

UNIT_ID: S-02 Unix product external-file ownership safety correction
STATUS: WIRED（Setup／Launcher／Uninstallが共通のbyte-exact ownership contractをfixture経由で使う）
NEXT_REQUIRED_CONSUMER: rev4.0のQE_BUILD順へ戻り、次の実consumerを接続する。native macOS lifecycle、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QC／QA、release／owner GOは未成立。
SAFETY_STATUS: 期待bytesと完全一致しない外部file、対象symlink、非regular file、macOS LaunchAgentsの不安全な親pathは上書き・削除しない。実ユーザー領域は変更していない。

### 先行BUILD_BATCH記録 — QE_BUILD / G03.03 Linux installed lifecycle・retained-state ownership（限定consumer）

主語はLinux製品Setup／Launcher／Gateway runtime／Recovery／Uninstallが共有するinstalled lifecycleと永続状態root。目的は、Setupが選んだDataRoot配下へruntime状態を一貫して置き、install directoryへの状態漏出を防ぎながら、通常Uninstallでは利用者データを保持し、明示Purgeだけを対象にすること。Linux autostartはBLUE-TANUKIが生成した完全一致設定だけを作成・削除し、同じ`Exec`行を含むだけの既存設定、変更済み設定、symlink、非regular fileを保持する。

Setup configは`state_root`を保存し、旧schema-v1設定ではsession directoryの親から互換推定する。Linux product Setupは`DATA_ROOT/data`を`STATE_ROOT`として書き、Launcherはその保持済みrootへの束縛を検査して`BLUE_TANUKI_STATE_ROOT`をexportする。schedule store、runtime health、recovery snapshot／factory resetは共通resolverを使い、明示`BLUE_TANUKI_SCHEDULES_DIR`を保ちながら既定時はstate root配下へ置く。Node 22.14で未定義の`DatabaseSync.isTransaction`をlease喪失と誤認しないよう、明示`false`だけをtransaction中とする。Linux autostartの作成・状態・削除は通常file／非symlink／全bytes一致の所有判定を共用し、Launcherは不在時だけnoclobberで作成する。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| Gateway build | PASS：`corepack pnpm --filter @blue-tanuki/gateway build`。 |
| Gateway lifecycle focused tests | PASS：5 files／59 tests（runtime schedule、runtime health、recovery、Setup config、owner lease）。durable Cron storeを注入するfixtureと、backup完全性assertionが要求するFailureMemory fixtureを整合。 |
| installer／packaging／製品marker | PASS：product installer 5 tests、`validate:packaging`、`docs:check`、`git diff --check`。 |
| Linux package＋installed lifecycle | PASS：WSL Ubuntu 24.04 ext4でfrozen install、build、package、2,653-entry verifier、installed smoke。smoke対象artifact SHA-256=`7bd19bc604c62b41a0da9fd9d453bffb7e018d2c78c852784735f65bf19ab262`。 |
| installed smokeの観測 | PASS：Setup、Launch／GUI／first message、Repair、autostart設定、port conflict、Approval、audit normal／tamper、crash recovery、safe mode、state-root隔離、通常Uninstall後のsentinel／env／owner-state保持、reinstall、明示Purge。通常update失敗後のapp／runtime rollbackと保持状態、SetupをSIGKILLした後の旧app復旧・検証用更新完了、停止process不存在、管理autostart Exec targetからの新resident起動・health・状態保持も確認。 |
| 実OS reboot／login、native Linux、複数distribution、system service／Secret Service実接続、全suite、5OS、QE_QC／QE_QA | NOT_RUN。autostart Exec targetの直接起動は実reboot証拠ではない。WSL限定BUILD evidenceでありnative Linux QAではない。 |

本batchはG03.03のLinux installed lifecycleと保持状態に関する限定consumerを`WIRED`に進める。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、Linux native QA、G03.03全体、release／公開／owner GOを主張しない。

UNIT_ID: G03.03 Linux installed lifecycle and retained-state ownership subconsumer
STATUS: WIRED（Setup→Launcher→Gatewayのstate-root契約、schedule／health／recovery consumer、update failure rollback、SIGKILL後のSetup復旧、通常Uninstall保持／reinstall／明示Purgeを隔離WSL installed smokeで確認）
NEXT_REQUIRED_CONSUMER: Linux desktopの実logout／loginまたはOS reboot後に、管理autostart・resident ownership・永続状態を同じinstalled product経路で確認する。WSL smokeはこの証拠を代替しない。
SAFETY_STATUS: 通常UninstallではDATA_ROOT／STATE_ROOTを保持し、明示Purgeは隔離smoke対象rootだけで確認。未所有・編集済み・symlink・非regular autostartは保持。HDS権限、provider、外部作用、macOS／Windows経路は変更しない。

### 前段完了BUILD_BATCH — QE_BUILD / G03.01 Linux package対象ABI・導入preflight・artifact生成

主語はLinux package builder、installer manifestと`BlueTanukiSetup.sh`。目的は、対象runtimeを正しく同梱したLinux配布物を生成し、実際に含むNode runtimeとLinux host ABIを一致させ、対象外hostに中途半端な導入を開始しないこと。manifestだけの宣言やpackage生成だけでinstalled Linux製品が成立したとは扱わない。

対象はvendor-supported GNU/Linux distribution、x86_64、kernel >= 4.18、glibc >= 2.28。Node.js v22.14.0公式Linux x64 runtimeの条件を根拠にし、musl／非x64を拒否する。manifest schema 2にNode runtimeと導入utility、Secret Service over current-user session D-Busが秘密永続化に必要な条件を記録する。Setupはkernel/libc/architecture/utilityを読み取り、installer manifestのpackage typeとABI項目を照合してから `mkdir`／stage作成へ進む。target-aware package builderは共通成果物とOS専用isolation helperを区別し、Linux package生成時にWindows専用exeを必須入力にしない。Linux package verifierはLinux isolation helperの同梱を要求する。

Node.js v22.14.0 runtimeを含むLinux x64 installerをWSL Ubuntu 24.04のext4作業領域で生成し、package verifierが2649 entryを確認した。artifact SHA-256は`6e4d0f1186288022d33fe4e74a41506496d1ef0299a45a6cd56e2882b7742ed5`、size=45,949,718 bytes。source Git tree=`e283f6eac81a4108c93c49872c6ee2c88c640a95`。同梱Node runtime archive SHA-256 `69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec`は公式`SHASUMS256.txt`と一致し、Setup／Linux isolation helperの実行bitも確認した。

Setupの実導入で、同梱Nodeの公式`npm`／`npx`／`corepack` symlinkがgeneric symlink拒否に阻まれる欠陥と、Linux schema 2 package manifestを共通所有guardがschema 1として拒否する欠陥を是正した。既知の相対link targetがruntime内のregular fileへ解決する3項目だけをstageから除き、未知のsymlink拒否は維持する。共通guardはLinux x64 schema 2とmacOS schema 1を区別する。Setup途中失敗時のstage片付けは、作成directoryのidentity一致を検査してから行う。

修正版artifactをWSL Ubuntu 24.04 ext4上の隔離HOMEへ導入し、`PATH`からNode／pnpm／Gitを除いた環境でSetupを完了した。同梱Node v22.14.0、env file mode 600、autostart disabledを確認し、一時`resident-start`からloopback `/healthz`と`/app`がHTTP 200、`resident-stop`後にportが閉じることを確認した。smoke専用env fileはport 18787に設定した。これはWSL内の限定BUILD疎通であり、native Linux QAではない。Secret Service、system service、distribution別通常利用、外部provider、全suite、全OS、QE_QC／QE_QAはNOT_RUN。

ローカルにnative Linuxがないため追加した`workflow_dispatch`専用workflow `linux-installed-package-build-smoke.yml`を、run `42813081239`／source=`e642a6755f123d72ce785872f4fb8d9bcb4ef614`で実行した。Ubuntu 24.04 hosted runner（kernel `7.0.0-1017-azure`、glibc 2.39）でworkspace build、2,649 entryのLinux package verification、artifact SHA-256 `d9e81a678acec967defdf59ef4323c2804e44a7d136364380127fbe4be87cf44`、隔離temp rootへのSetup、bundled Node、env file mode 600、autostart disabled、resident起動、loopback `/healthz`／`/app` HTTP 200、停止後の疎通断を確認した。初回run `42812303398`はharnessが空のruntime rootを事前作成し、Setupが安全に拒否したため、Setupにroot作成を任せて再実行した。権限は`contents: read`、checkout credentialなし、artifact upload・実provider・外部作用・system service・Secret Serviceなし。このhosted runnerは限定BUILD evidenceであり、対象distributionのQAや製品全体完成を示さない。

UNIT_ID: G03.01 Linux packaged target and host ABI preflight
STATUS: WIRED（WSL隔離環境とGitHub-hosted Ubuntu 24.04でLinux artifact→Setup→bundled Node／Gateway→resident launcherを限定疎通。distribution QAは未成立）
NEXT_REQUIRED_CONSUMER: 対象Linux distribution上の通常利用と実環境権限、service、Secret Service、更新／復旧を観測する。WSL／hosted runnerの証拠を対象distribution QAへ転用しない。
SAFETY_STATUS: 非x64、kernel < 4.18、glibc < 2.28、musl／未知libc、必須installer utility欠落、manifestとruntime target不一致はfilesystem変更前に拒否。秘密保存・service・network・HDS権限はこのsliceで変更しない。

### 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows製品Setup→Launcherのinstall/DataRoot束縛

主語はWindows製品Setupが生成するinstall metadata／DataRoot markerと、それを使う製品Launcher。目的は、Setupが選んだ最終install pathとDataRootだけを後続runtimeが引き継ぎ、欠落・破損・別製品・別pathのmetadataから既定DataRootへ黙って切り替わらないこと。製品全体の導入・更新・Uninstall成立やWindows E2Eの完了を主張しない。

Setupはstage inventoryの格納先とmetadataに記録する最終install pathを分離した。Launcherは同梱`safe-target.ps1`、schema／product ID、実install path一致、`Assert-SafeInstallTargets`、DataRoot ownership markerを確認してからruntimeへ進む。検証できない場合はfail-closedし、APPDATA既定値へfallbackしない。通常起動時はbounded markerとroot identityを確認し、Uninstall側の既存全tree保護検査を弱めない。既存Windows実行fixtureはこの同一install/DataRoot契約に合わせたが、testは実行していない。

source構文確認と文書確認は完了履歴に記録した。test suite、実package Setup、installed Launcher、通常Uninstall／明示Purge、rollback、registry／shortcut、clean WindowsでのNode/Git/pnpm非依存、全OS、QE_QC／QE_QAはNOT_RUN。

### 前段完了BUILD_BATCH — QE_BUILD / Windows Setup・Uninstallのショートカット所有判定を実パスへ束縛（安全修正）

主語はWindows製品Setup／Uninstallが更新・削除するショートカット。目的は、BLUE-TANUKIの生成物と確認できないユーザー項目を保持すること。既存判定はショートカット引数内にLauncherパス文字列が含まれるだけで所有を認定していたため、無関係な項目を上書き・削除し得た。

共通`install/windows/safe-target.ps1`に、Windows PowerShellの実行先、Setupが生成する固定起動引数、Launcherの完全一致パスを要求する判定を追加した。Setupの置換前判定とUninstallの削除前判定は同じ関数を利用し、余分な引数・未知のコマンド・別実行先は非所有として保護する。既存のLauncher／Uninstall直指定の完全一致判定は維持した。

`install/windows/safe-target.ps1`、`BlueTanukiSetup.ps1`、`BlueTanukiUninstall.ps1`のPowerShell構文解析PASS、`git diff --check` PASS。suite、実Setup／Uninstall、installed Windows製品、動的データ保持、全OS、QE_QC／QE_QAはNOT_RUN。実ユーザーデータ・ショートカット・レジストリは操作していない。これは局所的な安全コード修正で、Windows製品E2E、`SYSTEM_SHAPED`、`BUILD_COVERED`の証拠ではない。

UNIT_ID: G02.03 safety defect correction（QE_BUILD中の実安全欠陥修正。QE_QCは未開始）
STATUS: WIRED（Setup置換前・Uninstall削除前の両consumerが共通の完全一致guardを呼ぶ）
NEXT_REQUIRED_CONSUMER: owner L3を要するF17.03の目的関係／step審査は未実施。Windows installed-packageの動的Setup→通常Uninstall／Purge選択→データ保持・残留観測は後段の製品E2Eで扱う。
SAFETY_STATUS: 非一致・曖昧ショートカットを保持。実ファイル操作なし。

### 前段保留記録（2026-11-10時点） — F17.03 Canvas本文から親C・J・Brokerのsandbox作用・M receiptと結果不明復帰へ接続

実際のowner L3による目的関係確認・plan step審査、file.write、M receiptは未実施。Codexは承認・目的適合判断を代行しない。以下は実装とserved候補生成の前回確認記録であり、この保留を解消した証拠ではない。

この節は2026-11-10時点の観測記録。後続の2026-11-11限定synthetic Gateway test結果は本書先頭とIMPLEMENTATION_HISTORY.mdに記録し、この時点の未承認候補状態を現在状態へ流用しない。

主語はWebChat Control CenterのCanvas成果物と、そこからownerが明示した操作意図。目的は一致確認済みの限定本文を一回の親C計算へ渡し、提案されたsandbox内file.writeを既存J／Approval／Brokerへ接続し、検証済み結果とM receiptに基づくowner指定の達成判定まで同じtaskで通すこと。ownerは「明示規則と検証済み根拠」を選択済み。Canvas本文は権限・承認・目的変更の根拠ではなく、child候補へ本文を渡さない。

Canvas source MIME／UTF-8／SHA-256／表示版／返信request IDをowner task referenceと一対一照合し、本文を最大64 KiBに制限する。owner-authenticated `/owner/task-compute`からの一致した一回入力だけをephemeral contextとして親Cへ渡し、handler終了時にbufferをzeroし、Task session historyには追加しない。Jがfile.write候補を作った場合は審査と再起動復元のため本文・保存先をローカルJ Operation Plan SQLiteへ永続保存する。Control Centerはその保持条件とprovider側retentionの適用を送信前に表示する。

合成file.write計画をownerのsandbox内へ限定し、Jが委任目的との関係をowner L3 reviewへ送り、既存Operation Plan review・Approval Gate・Brokerで候補を処理する。明示規則はtarget=`owner-task-note.txt`、operation=`file.write`、検証済み出力`/bytes_written`が本文UTF-8 bytes数と一致する条件とし、Jがcurrent revisionの結果・M receipt・保存値を検証した場合だけ`achieved`へsealして停止する。規則欠落・不一致はheldのまま。これはC08.02の既存達成規則実装をCanvas経路へ使うもので、並行判定機構は作らない。

failure/recoveryでは、sandbox内writeの直後・J/M receipt記録前にGateway processを終了し、再起動後も元stepを`outcome_unknown`、M receiptなし、未達成のまま保持する。自動再実行・重複writeを起こさず、digest-onlyの状態観測をownerが選んだ場合だけ同一taskの次候補へ渡す。次候補の目的関係は別のowner L3 reviewを通し、完全一致pathの`file.search`空queryは実装契約どおり限定`file.read preview`としてJ/M receiptと共に返す。これは保存時点のpreviewであり、元writeの成功・達成・現在状態を証明しない。WebChat応答待受は各HTTP受付が返すrequest IDへ束縛する。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| Canvas入力検査、ephemeral parent-C routing、child本文遮断、通常session履歴除外 | PASS：4 test files中6件、151件skip。 |
| Canvas owner意図→既存Tasks送信payload（artifact参照・選択済み委任目的・明示達成規則） | PASS：`webchat.test.ts`の限定1件。stub経由のpayload検査であり、served UIからの実Owner Task送信ではない。 |
| served Gateway Canvas→synthetic C→J purpose relation review／plan review→sandbox file.write→verified result／M receipt | PASS：owner-authenticated local integration 1件。 |
| 明示file.write規則一致時のJ達成projectionと再起動復元 | PASS：同じserved integrationで1/1規則・結果bytes・M receiptを確認。C08.02の規則判定は既存targeted testで確認済み。 |
| write後・J/M receipt前のprocess kill、再起動、未知結果保持、owner選択観測、同一task再計画、saved-result返却 | PASS：対象served integration 1件（同ファイル内8 tests中1 PASS／7 skipped）。元writeは`outcome_unknown`／receiptなし／未達成、ファイル件数は不変。続くexact-path previewはM receipt確認済みで、別request IDへの誤照合なし。 |
| Canvas送信時の永続化説明とOperation Plan SQLite内の本文保持 | PASS：HTML表示testとserved checkpoint readback。 |
| loopback browser GUIでの合成Canvas生成・表示 | PASS：隔離Gatewayの`synthetic-file-write-plan`で通常WebChatを接続し、text/html応答をCanvasプレビューiframe内に表示。MIME／SHA-256／由来request IDを表示し、見出し・表の実描画を画面で確認。 |
| Gateway依存build／`docs:check`／`git diff --check` | PASS：7 workspace projects。docs check・日本語基底監査（移行負債76件の注意）・license・差分whitespace。 |
| served Control CenterからCanvas Owner Taskを合成Cへ送信 | PASS：表示済みCanvas参照とowner意図、現行委任目的v2、明示規則1件（`file.write`／`owner-task-note.txt`／377 bytes）が同一依頼に入り、合成Cの成功応答から現在の目的版に束縛された1-step plan候補を確認。依頼表示は「計画候補・作用は未承認」。 |
| 実UIからのowner目的関係L3／plan step審査、file.write実行、検証結果・M receipt | NOT_RUN：planは`awaiting_step_review`、目的関係は`unverified`、達成評価は`held`（規則1件・充足0件）、stepは`not_selected`／`may_execute=false`。file.write・L3申請・実provider・外部作用は実施していない。状態照会では送信後に新規発行された次回用ID（末尾`3107d2a76ccb`）を誤選択したため`found=false`となった。実際の送信IDの状態照会は未実施で、これは受付不具合の証拠ではない。 |
| 全suite、全OS、installed製品、QE_QC／QE_QA | NOT_RUN。このsliceのfile.write／process kill／Approvalは隔離された合成local fixtureで実施。 |

初回の永続化確認assertionはJSON文字列内の改行escapeを考慮せずFAILした。SQLite checkpoint実体に本文があることを読取観測し、JSON表現に合わせてassertionを直した後、同じCanvas testをPASSした。追加のfailure/recovery testでは、request IDを指定しない待受が別`channel_send`を捕捉できたため、各owner受付のrequest IDと結合した。空query＋exact pathに対するsaved-resultは既存契約の限定previewであることをstep parametersと返却projectionの両方で確認し、テスト期待値を合わせた。合成planner fixtureのselected-observation context markerも実producer表現に合わせた。これらは検査入口／fixtureの是正で、Jのauthority policy変更ではない。raw `cmd`／`command`をOperation Coreへ埋め込むfile.edit→shell.exec fixtureはcoreのfail-closed拒否が正しいため本sliceから分離し、shell command-generation consumerは未解決として残す。raw-command保護は緩和しない。

このbounded synthetic local route、WebChat生成→Canvasプレビューiframeの実ブラウザー表示、およびserved Control CenterからのOwner Task送信をF17.03の限定`WIRED`証拠に含める。表示物はMIME=`text/html`、SHA-256=`da5ee2f82cc2ca286c0cb0a17fd018ad7772daafb52ef31f4416aaedc7ec8cfa`。生成されたControl Center scriptの制御文字escape不具合も修正し、構文・制御文字検査を追加した。served UIで送ったtaskは現行目的版v2へ結び付き、synthetic Cから`file.write`候補を1件生成した。owner目的関係・plan stepは未審査のため候補はheld／未選択であり、作用は未実行。状態照会は実送信IDではなく次回用IDを誤って選んだので、実送信IDの永続状態照合は未確認。実LLM/provider、外部作用、F17全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QC／QA、公開・出荷判断は未成立。外部作用・他repo変更なし。今回のintegration testは一時workspaceをtest cleanupで削除し、既存`dist`はbuild出力として保持。protected attachment directoriesは未変更。

F17.03 parent BUILD_BATCH開始時のlocal／origin/main／GitHub mainは`e4a74fc57b76c96b5e64a6a12c0b0a7e1b59d979`（履歴上の開始点）。今回のserved UI subunitはlocal／origin/main=`36eefc470bb5383b4645c7a5ede5a346e68e69af`で開始し、local recovery branchとremote backup tagはcurrent=`36eefc470bb5383b4645c7a5ede5a346e68e69af`、previous=`e4a74fc57b76c96b5e64a6a12c0b0a7e1b59d979`で一致。開始時のtracked treeはcleanで、protected `.codex-attachments/`／`.codex-remote-attachments/`だけが未追跡。`git fetch origin main --tags`はmainを取得した後、`.git/worktrees/blue-tanuki-health-2026-11-07-windows`の削除でPermission deniedを報告した。`git worktree list`はmainのみを示したため、残る別worktree metadataには触れていない。今回起動したloopback Gateway PID 22072を停止し、固有のTemp root `bt-canvas-owner-task-live-872008634ec8400f86646b25889452d5`（24 files／625,399 bytes）をWindowsゴミ箱へ移動、元path消失と同名1件の収容を確認した。`dist`とprotected attachment directoriesは変更していない。

**次のproducer／consumer:** この未承認Canvas planを既存Jの目的関係確認・plan step審査consumerへ渡し、owner審査後に限りsandboxed file.write、検証済みbytes結果、M receipt、同一taskの明示規則評価までつなぐ。自動承認・自動実行を追加せず、provider・外部作用・他repo変更を起動しない。

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev4.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## 前段完了BUILD_BATCH — QE_BUILD / C08.02 explicit goal rulesからverified result／M receipt・同一task停止へのserved接続（限定WIRED）

主語はownerが送る同一taskの明示的completion rulesと、HDS-JがGoalProjection／OperationPlanへ束縛する評価・停止経路。目的は、規則が明示されていないtaskを達成扱いせず、現行revision内の検証済みoperation resultとM receiptが全規則を満たす場合だけachievedをsealし、再起動後も同一taskの追加計算を拒否すること。Userが選んだ条件「明示規則と検証済み根拠」を適用する。実provider、外部作用、他repo変更は対象外。

GoalProjectionは未確認のnecessity／target／validity／authorityを`unknown`のまま保ち、GoalProjection全体を`ready`に偽装しない。owner trustを通ったcompletion rulesがある場合だけ`evaluation_rules=referenced`としてdigest／件数／request refを保持する。実規則はJ管理のOperationPlan policyに置き、各stepの結果値、current revision、M receiptと保存値を照合する。外部metadataだけではrulesを投影しない。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| HDS GoalProjection owner rules ref／external metadata偽装拒否 | PASS：2 tests、3 skipped。 |
| OperationPlan explicit rules・verified result／M receipt正例と不一致保留・再起動後停止 | PASS：2 tests、47 skipped。 |
| Served Gateway owner task→synthetic file.search→M receipt→達成projection→Gateway restart restoration | PASS：1 test、6 skipped。規則なしtaskは`goal_completion_rules_missing`でheld、owner規則一致後だけachieved。live providerなし。 |
| `docs:check`／`git diff --check` | 最終記録更新後に実施。 |
| 実LLM／外部provider、外部作用、全suite、installed製品、5OS、QE_QC／QE_QA | NOT_RUN。 |

served testのsnapshot pollingは直接取得でタイムアウトし、既存429-retry helperへ切り替えた同testはPASSした。429自体が原因だったかは記録されていない。production codeは変更していない。このC08.02縦断sliceだけを限定`WIRED`とする。GoalProjectionの他未同定要素、C08.02全状態・全OS・実LLMの長期運転、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。外部provider／作用、QE_QC／QE_QA、公開・出荷判断は行わない。

開始local／remote `main`=`9d2b3b4581bd8c521c124015ff74277e80f38bec`。開始復旧ref local branch／remote tagのcurrent=`9d2b3b4581bd8c521c124015ff74277e80f38bec`、previous=`40822ba7fae2c726563a35342998134d59f285ee`。protected `.codex-attachments/`／`.codex-remote-attachments/`は未変更。E2Eの一時workspaceはtest cleanupで削除した。

**次のproducer／consumer:** 最新mainとrev4.0から、GoalProjectionやOperationPlanで重複済みのJ判定を作らず、製品全体の未接続consumerを選ぶ。明示completion rulesはownerの指定した意味を保持する。

## 前段完了BUILD_BATCH — QE_BUILD / E05.01 Setup管理FailureMemory・開発引継ぎの再起動永続化（限定WIRED）

主語はHDSのFailureMemoryと、FailureMemoryから独立した開発レビュー引継ぎinbox。目的はSetupが管理する保存先をGateway runtime、検証CLI、復旧診断へ同じ規則で接続し、process再起動後も失敗署名・学習lineage・未審査handoffを復元すること。FailureMemoryがHDS-Jの採否や権限を代替する変更ではない。

Setupは`<base-dir>/failure-memory`を`BLUE_TANUKI_FAILURE_MEMORY_DIR`として生成し、directoryを作成する。既存の`BLUE_TANUKI_FAILURE_MEMORY_FILE`を指定した環境ではFILEを優先する。旧Setup envにFILE/DIRがなく`BLUE_TANUKI_SESSION_DIR`だけがある場合は`<session-dir>/failure-memory`へ保存し、セッションdata rootの管理・復旧範囲に留める。明示pathがないdeveloper-only環境は引き続きmemory-only。Runtime、`--failure-memory-verify`、DevelopmentHandoff、runtime health、Recovery snapshotは共通path resolverを使い、`BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE`の明示時を除いてhandoffは実効FailureMemory fileと同じdirectoryへ置く。

`corepack pnpm exec vitest run apps/gateway/test/setup.test.ts apps/gateway/test/setup_config.test.ts apps/gateway/test/development_handoff_store.test.ts apps/gateway/test/recovery_surface.test.ts -t "writes an env file and runtime directories|creates a safe offline default config|builds setup config from runtime env|preserves explicit failure-memory|keeps legacy Setup session data|reports the effective failure-memory path|reports env backup inventory" --maxWorkers=1 --minWorkers=1`はPASS（7件、46件skip）。legacy `SESSION_DIR`からFailureMemory signatureとDevelopmentHandoffを再生成storeへ再読込する合成restart経路を確認した。`corepack pnpm --filter @blue-tanuki/gateway... build`はPASS（7 workspace projects）。初回buildはoptional environment型の不足で失敗したため修正し、同じbuildを再実行してPASS。

`corepack pnpm docs:check`と`git diff --check`はPASS。日本語基底監査PASS（既存移行負債76件の注意継続）、license監査PASS。

学習妥当性・改善・汎化・外部teacher寄与は未評価。実provider、外部作用、installed製品、5OS、全suite、QE_QC／QE_QAはNOT_RUN。限定`WIRED`はSetup設定→FailureMemory／Handoff保存→restart後読込→health／Recovery path表示まで。E05.01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、Jによる学習候補採用、release／owner GOへ拡張しない。

開始local `main`／`origin/main`／GitHub `main`=`633af7fcba726a6e00c05f4388247d20462089cd`。編集前復旧refはCAS回転済みでlocal branch／remote tagともcurrent=`633af7fcba726a6e00c05f4388247d20462089cd`／previous=`73f2608e1347c7df4d4c3ed60563a9fa9a5c8d9f`。protected `.codex-attachments/`／`.codex-remote-attachments/`は保持。現unitの次consumerは最新mainとrev4.0から再選定する。

## 前段完了BUILD_BATCH — QE_BUILD / E05.01 M解釈依存の後続行為・結果receiptをOwner Taskへ接続（限定WIRED）

主語は、Operation Planが保持するM解釈依存と、その依存digestを実行元へ束縛した後続step。目的は、同じplan revisionで結果検証とM receipt確認まで成立した行為の有無だけをOwner Taskへ表示し、妥当性・改善・汎化・学習成立を未評価のまま区別すること。

HDS-Jは計画の依存件数／digestを保持し、各選択行為の`operation_plan_binding_digest`を現行依存群から再計算して一致を確認する。`action_observed`は、現revisionの一意なbinding、検証済み結果（`github.write`はprovider acceptedの保存summary）、実行admission・delivery/result digest、依存を含むsource digest、result-memory commit、receipt、保存済みM値がすべて再照合できる場合だけ返す。証拠不足・複数binding・古いrevision・receipt不一致は`unconfirmed`。依存がない場合は`not_referenced`。各状態はdigest/countのみで、権限・実行可否を持たない。妥当性`not_assessed`、改善`not_measured`、汎化`not_assessed`を固定し、後続行為の観測を因果成立や学習成功へ読み替えない。

Gatewayはprojectionのstatus、digest、件数、固定非権威flagを検証し、Control Centerは行為観測／未確認／依存なしを区別して表示する。個別M record ID、citation judgment、結果本文、候補意味は表示しない。C08.03実provider、別repo、外部作用、公開・出荷判断には触れない。

`corepack pnpm exec vitest run packages/hds-brain/test/operation_plan_interpretation_reassessment.test.ts apps/gateway/test/serve_projection.test.ts packages/channel-webchat/test/webchat.test.ts -t "memory interpretation follow-up|projects versioned J plan and outcome-unknown state|renders a verified result plan beside a held residual plan" --maxWorkers=1 --minWorkers=1`はPASS（3件、同file内の他130件skip）。`corepack pnpm --filter @blue-tanuki/hds-brain... build`はPASS。`corepack pnpm --filter @blue-tanuki/gateway... build`はPASS（依存7 workspace project。channel-webchatも含む）。`corepack pnpm docs:check`と`git diff --check`はPASS。日本語基底監査PASS（既存移行負債76件の注意継続）、license監査PASS。

限定`WIRED`はE05.01のこの依存→後続行為→検証済み結果／M receipt表示sliceだけ。C/J/Mを通る製品仕事全体、E05.01全体、`SYSTEM_SHAPED`／`BUILD_COVERED`、妥当性・改善・汎化、QE_QC／QE_QAを成立扱いしない。実Gateway owner往復、実provider、外部作用、installed製品、5OS、全suite、QE_QC／QE_QAはNOT_RUN。

開始時local `main`／`origin/main`／GitHub `main`は`73f2608e1347c7df4d4c3ed60563a9fa9a5c8d9f`。編集前復旧refはlocal branch／remote tagともcurrent=`73f2608e1347c7df4d4c3ed60563a9fa9a5c8d9f`、previous=`c941c9e8de645294dbd69538a9b856755aa6912e`。添付2領域は保護し未変更。`git fetch origin main`は既存worktree metadataの削除ACL拒否で終了したが、直接の`git ls-remote`でremote mainが同じSHAと確認済み。該当metadata pathには触れていない。次のproducer／consumerは、最新版rev4.0と現物から製品全体の依存順で再選定する。

## 前段完了BUILD_BATCH — QE_BUILD / C08.02 J達成状態をOwner Task結果相関へ接続（限定WIRED）

主語はOwner Task送信後に同じrequest IDへ対応するOperation Plan結果相関。目的は、HDS-Jがowner明示規則・検証済みstep結果・M receiptに基づいて同一taskを達成後停止した状態を、送信結果表示にも結び付けること。C08.02のJ評価ロジックは変更しない。

Control Centerはrequest ID digestで一意なplanを特定する。達成を表示するには、HDS-Jの`goal_completion_rules_satisfied`、`rules_satisfied` assessment、規則／証拠digest、`results_verified`、全stepのverified statusとreceipt-confirmed M bindingを照合する。保留・進行中は別状態で示し、projection欠落・重複・不正・不整合は未確認のまま保持する。達成表示は同一task停止の状態参照であり、実行権限・別taskへの許可・公開／出荷判断を生成しない。

`corepack pnpm exec vitest run packages/channel-webchat/test/webchat.test.ts -t "correlates owner task status" --maxWorkers=1 --minWorkers=1`はPASS（1件、同fileの他122件をskip）。`corepack pnpm --filter @blue-tanuki/channel-webchat... build`はPASS（protocol／channel-base／channel-webchatの3 project）。`corepack pnpm docs:check`と`git diff --check`はPASS。日本語基底監査はPASS、既存移行負債76件の注意が継続。license監査PASS。

owner taskの実served往復、全suite、全workspace build／typecheck、実provider／外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このControl Center相関表示だけを限定`WIRED`とし、C08.02全体または製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

開始mainはlocal／remote一致`c941c9e8de645294dbd69538a9b856755aa6912e`。編集前復旧refはlocal branch／remote tagともcurrent=`c941c9e8de645294dbd69538a9b856755aa6912e`、previous=`8b2ae4dd1cb2ef51d02da4f0cb78a1dba74a19d8`へCAS回転済み。`.codex-attachments/`と`.codex-remote-attachments/`は保護し未変更。fetch／commit時に古いworktree metadata削除のACL拒否が出た場合、そのpathを変更・迂回しない。

**次のproducer／consumer:** 次の独立BUILD_BATCHでは最新mainとrev4.0から、C08.02の既存J判定や本UI表示を重複せず、製品全体で最も不足する実consumerを再選定する。D4 Pocket等の別repo変更、実provider、外部作用、公開／出荷判断は引き続き別許可・後段判定のまま。

## 前段完了BUILD_BATCH — QE_BUILD / E04.02 同一条件read-only履歴をFailureReviewへ接続（限定WIRED）

主語は、FailureMemoryの失敗署名とComplete Historyの後続観測をC/Jへ渡すFailureReview。目的は、署名baselineを後続観測と誤認せず、同じgoal input・action・actor/channelで既に実行済みのread-only `file.search`／`browser.read`／`gmail.read`記録だけを限定観測として接続すること。providerやbrowserへの新しい要求は起こさない。

Complete Historyのhash-chainが有効で、署名baselineの全IDが存在し、各baselineが同じ失敗したexecutor tool callとして署名と一致し、その最後より後に同一operation・action／goal input／actor・channel patternの成功`execution_history`がある場合だけ候補にする。`browser.read`は既存HTTP GET結果の固定schema、credential-free境界、非信頼本文、origin整合、redirect flag、時刻、EXTERNAL_EVIDENCE／FIXTURE分類を確認してdigest-only metadataを渡す。`gmail.read`は保存済みoperation/result digestだけを渡す。完全URL、path、query、links、メール内容・header・宛先・添付metadata、credentialは渡さず、新しいHTTP／Google API要求も発生させない。

C/Jはこれを原因・世界状態・providerの現在状態・外部条件解消の証明や再開／実行権限に使えない。観測がなければ`unavailable`、hash-chain不正なら`invalid`として保持する。`file.search`／`browser.read`／`gmail.read`のdigest-only接続sliceだけを限定`WIRED`とし、E04.02全体、FailureReviewの実往復、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。test suiteは実行しない。実browser／HTTP／Google provider、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。C08.02のowner明示規則・検証済み根拠・M receiptによる既存J達成判定は変更しない。

Gateway依存7 workspace projectのbuildとtypecheck、`docs:check`、`git diff --check`はPASS。日本語基底監査はPASSだが、既存移行負債76件の注意を継続。license監査PASS。test suiteとFailureReview実往復、実browser／HTTP/provider、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。

**次のproducer／consumer:** 次の独立BUILD_BATCHでは最新HEADから製品全体で最も不足する実consumerを選び直す。FailureReviewは他operation／scope、因果束縛、実環境での独立再観測が未成立のまま。`gmail.read`の既存履歴投影からprovider状態を推定したり、新しいprovider要求へ拡張したりしない。

## 前段完了BUILD_BATCH — QE_BUILD / D03.01 D4 Runtime入力と同一session応答transportのBlue側接続（限定WIRED）

主語はBLUE-TANUKIのGateway/`channel-webchat` D4 Runtime Adapter、目的は認証済みRuntimeからの意図入力をHDSへ渡し、同一session宛てにHDSが許可した出力を返すこと。専用`BLUE_TANUKI_D4_RUNTIME_TOKEN`と固定runtime IDを共有する新`POST /runtime/ws-ticket`を追加した。登録runtime IDとsession参照を検証し、session参照はtoken鍵付きHMAC digestへ変換する。返すticketは既存ticket storeの期限・単回消費・user束縛を使い、WebChat一般tokenやowner/resume tokenを共有しない。新しいticket bodyはruntime/session IDだけで、意図・command・path・Approval・Permissionを含まない。

D4 Runtime Adapterは同じsessionでticketを先に要求し、ticketで既存`/ws`へ接続後、既存`POST /runtime/intent`を送る。対応するsession WebSocket接続がない場合は`409 not_dispatched`を返し、handler／HDSへ仕事を渡さない。WebSocketは同じdigest scopeへ既存`channel_send`を配送し、HDSが付けたrequest IDも保持する。`202`は入力受付のみで、仕事達成や応答完了を意味しない。新しい権限経路・出力保存・再送機能は追加していない。

接続状態はBlue側transportの限定`WIRED`。依存3 project buildはPASS。選択testは3件PASS（同fileの他120件skip）で、応答接続なしの未dispatch、未設定時のfail-closed、wrong token、未登録runtime拒否、session digest束縛、接続時のWebSocket channel_send戻りを確認した。`git diff --check`はPASS、`docs:check`はPASS（日本語基底の既存移行負債76件に注意、license PASS）。全suite、実HDS判断→出力監査→D4 Runtime受信のGateway一気通貫、実D4 producer/receiver、workspace登録、disconnect/restart recovery、実provider/外部作用、installed製品、5OS、QE_QC／QE_QAは未実施。D03.01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。D4 Pocket repoは変更していない。

**次のproducer／consumer:** D4側がBlueのsession-scoped WebSocket contractを使うproducer/receiverは未接続。D4側repo変更には別repoの限定委任が必要なため保留し、次回は現行HEADの全体接続距離から、D4変更なしで結べるBlue側consumerを再選定する。runtime/session/workspace registrationがない状態をD03.01完成と扱わない。

## 前段完了BUILD_BATCH — QE_BUILD / E04.02 署名後の同一条件file.search観測をJへ接続（限定WIRED）

主語は、失敗署名を非信頼計算Cへ渡すFailureReviewと、範囲・反例・再開条件を裁定するHDS-J。署名時`evidence_log_ids`はbaselineとして保持し、新しい観測に再利用しない。CompleteHistory hash-chainが有効でbaseline全件が存在する場合のみ、その後に記録された同一の`file.search`成功を探す。対象範囲はfileに限定し、action／goal input／actor・channel patternが署名と完全一致し、read-only結果digestがある記録だけを選ぶ。選択した履歴IDはbaseline IDと異なり、履歴順もbaselineより後である。

JとCへ渡す観測は操作名・結果状態・各digest・記録時刻等だけで、検索本文やpathは渡さない。これは同じ読取操作の後続記録であり、原因の証明、外部条件の解消、再開許可ではない。該当観測がなければ`unavailable`、chain不正なら`invalid`。Jはscope候補のみを限定観測へ束縛でき、原因を採用せず、反例・再開条件を将来観測へ保持し、作用しない。他scope／他read-only操作のproducerと因果束縛は未接続であり、E04.02全体の成立を意味しない。

Gateway依存7 workspace project buildはPASS。`docs:check`／`git diff --check`は本更新後に実行する。test suiteは実行しない。実FailureReview UI往復、外部条件の解消証明、実provider、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このsliceだけを限定`WIRED`とし、E04.02／E04.03全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。C08.02の達成基準はowner回答の明示規則と検証済み根拠に結び付く既存J評価を再確認し、重複実装しなかった。

**次のproducer／consumer:** 現行HEADから全体の最も欠けた実consumerを再選定する。FailureReviewはfile.search以外のsourceを`unavailable`のまま保ち、対象と因果を安全に束縛できる既存read-only producerが見つかるまで拡張しない。実資格・危険な再実行・別repo変更は含めない。

## 前段完了BUILD_BATCH — QE_BUILD / E04.03 FailureMemoryの条件再評価を承認・実行consumerへ接続（限定WIRED）

主語は、条件変化後の同一commandを再監査するFailureMemory gateと、Owner承認後のGateway Executor。初回gate判定digestと元の実行主体をprocess-local pending approvalへ束縛する。Owner承認再開時に同じcommand／contextを再評価し、gateが変化・block・取得不能なら承認を取消して新規要求を求める。承認後もExecutorの`before_execute`およびtool dispatch直前で再評価し、digest不一致なら作用前に停止する。FailureMemory gate由来の承認から再利用可能なgrantを作らず、旧署名を変更・削除しない。承認要求にはgoal／actor／channelの観測差分次元を示す。

現在の差分検出は新しいHDS ASSERTにおけるgoal／actor／channel fingerprintを扱う。外部条件が実際に解消したことを独立証明しないため、根因再観測・実FailureMemory変化の実行時証拠は別途未成立とする。Gateway依存7 workspace project build、`docs:check`、`git diff --check`はPASS。日本語基底監査はPASS（移行負債76件の既存注意）、license監査はPASS。test suite、served Gateway owner承認往復、実作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。

達成判定はownerの明示規則に結び付いたJ評価と、検証済み結果・M receiptの両方を必須とする。現行実装に規則digest／一意なstep／結果値照合／receipt照合があることを確認したため、同じC08.02機能を重複実装しない。

**次のproducer／consumer:** 次の独立BUILD_BATCH開始時に現行HEAD・rev4.0から全体の最も欠けている実consumerを再選定する。E04.03全体の根因・反対仮説consumerや外部条件の独立再観測が未成立なら、依存と安全境界を現物で比較して次を選ぶ。

## 前段完了BUILD_BATCH — QE_BUILD / E03.03 Recoveryのtask lineage復元scopeをControl Centerへ接続（限定WIRED）

主語は、BLUE-TANUKI全体の仕事状態を保全し、破損範囲だけを確認済み復元点から隔離回復するRecovery経路。Control Centerに復元effect scopeを追加し、Operation Planは一planまたはHDS-J task lineage、Brokerは全storeまたはtask lineage、その他のstoreは選択store全体を明示させる。backup内照合projectionはtask identity digest、複数plan digest、lineage integrity／dependencyを非権威表示し、復旧可能性・許可・resumeを判断しない。

GatewayはOperation PlanとBroker task scopeの双方で、同じbackup/task verifierによる事前照合をL3要求作成前に行う。実復元時の既存再照合、L3、実行直前backup、store間非原子性、automatic resumeなしを維持する。Broker task mergeは対象taskの不足receiptのみを加え、現在履歴・無関係taskを維持する。

Gateway依存7 workspace project build、WebChat build、生成Control Center script構文解析、`git diff --check`はPASS。test suite、served Gateway owner L3全往復、実backup／復元、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このコード接続sliceだけを`WIRED`とし、E03.03全体および製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

Commit/push: `da2749d92d599ff12bbca5cd33e9596a32ec8ee0`。開始前復旧二世代はlocal branch／remote tagとも`58d4f1ca07df84dae1a8839fd0fbffb1b1f953fc`、`188b42c12d1c1842481a4a07a120617b91dd77ae`。作業後local／remote main一致。`.codex-attachments/`と`.codex-remote-attachments/`は保護し未変更。commit時にGitが旧worktree metadataへの削除権限拒否を報告したがcommit/pushは成功し、pathは触れていない。

**次のproducer／consumer:** 次の独立BUILD_BATCH開始時に現行HEAD・rev4.0から全体の最も欠けている実consumerを再選定し、機能IDの順番だけで選ばない。

## 前段完了BUILD_BATCH — QE_BUILD / F06.02 browser.read結果を同一taskの次回C計算へ接続

主語は、ownerが明示選択した検証済み`browser.read`結果と、その同一taskの次回計画候補を作るC。目的は、Jの現行plan／revision／step bindingとMの保存record／receiptを再照合したHTTP読取結果だけを、次の候補計算のcontextへ渡すこと。`browser.snapshot`、browser mutation、実provider試験は含めない。

検証済み結果を非権威のM observationへ保存し、Cへ渡す本文は先頭最大8,000文字のexcerptに限定する。excerpt本文はsystem instructionから分離したuser-role data messageにし、元Owner依頼より前に置く。system instructionは本文を非信頼データとして指定し、その内部の指示・役割・権限主張へ追従しないよう明示する。この入力を含む計算では子Cへのdelegationを無効にする。origin・観測時刻・証拠源・excerpt/full-text digest・切詰め・10分期限を維持する。完全URL/path/query、links、credential、raw本文をruntime snapshotへ出さず、Control Centerではoriginとdigest等の要約だけを表示する。Owner trust、M receipt、保存値、excerpt digest、期限のどれかが欠ければJは保留する。このC計算結果からのmeaning-update候補は受け付けない。

Workspace `typecheck`、15 project `build`、`docs:check`、`git diff --check`はPASS。日本語基底監査は移行負債76件の注意を継続。test suite、実ブラウザー／HTTP、実provider、外部作用、owner UI全往復、他OS、QE_QC／QE_QAはNOT_RUN。この同一taskのbrowser-read context経路だけを限定`WIRED`とし、F06.02全体や製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

**次のproducer／consumer:** 次の独立単位開始時に最新HEADとrev4.0正本から通常利用consumerの未接続箇所を再選定する。browser観測をeffect targetへ束縛するconsumerはまだ特定できていないため、推測実装しない。

## 前段完了BUILD_BATCH — QE_BUILD / F06.01 browser観測provenanceの読取consumer接続

主語は、Web観測結果をCへ返す`browser.read`と`browser.snapshot`。目的は、ページ内容を非権威の外部証拠として扱い、要求origin・最終origin・観測時刻・navigation面と、その観測面にtab/frameが存在するかを結果に残すこと。F06.01の読取側に限ったproducer接続であり、将来のeffect targetへの束縛は未成立とする。

両consumerは`observation`を返し、要求／最終origin、origin変更、ISO-8601観測時刻、navigation種別、証拠源、資格情報境界、`page_content_is_untrusted=true`、`used_for_authority=false`、`may_execute=false`を含む。HTTP GETはtab/frameを`not_applicable`とし、snapshotは永続profileを持たない単一ephemeral tabのmain frameとして記録する。snapshot runnerの最終URLは結果返却前に再parseし、既存のpublic-address／allowlist境界で再照合する。ページ本文、URL由来のquery、credentialはobservation metadataへ複製しない。

`browser.snapshot`の既定無効、ephemeral browser、credential再利用なし、download無効を維持する。`browser.automation`はnavigate snapshot以外のclick／form submit／download／uploadをpreview quarantineのままにし、実作用・承認境界・providerへ接続しない。observation metadataは権限・承認・effect targetを作らない。

core package `typecheck`／`build`、`docs:check`、`git diff --check`はPASS。test suite、実HTTP／browser runtime、実provider、外部作用、他OS、QE_QC／QE_QAはNOT_RUN。この読取provenance sliceだけを限定`WIRED`とし、F06.01全体、F06全体、製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

**次のproducer／consumer:** F06.02で同一task候補計算へ接続済み。effect targetへの束縛は、現行J/Brokerが現位置・tab/frame/navigation・観測時刻を再照合する実consumerが特定できた時点で別sliceとして施工する。

## 前段完了BUILD_BATCH — QE_BUILD / F20.01 隔離file-search workerへHDS記憶境界を継承

主語は、親Gatewayが承認した`file.search`を実行する隔離child processと、HDSのM本体・個人化停止台帳。目的は、通常Gatewayと同じHDS記憶対象設定をchildへ渡し、worker経由で停止済みMを検索・引用する別経路を残さないこと。F20.01／BT-R-F20-02／06の次consumer sliceである。

`createFileSearchWorker`はGateway全環境・credential・plugin等をchildへ渡さず、実際に選択される`BLUE_TANUKI_MEMORY_FILE`または`BLUE_TANUKI_MEMORY_DIR/memory.jsonl`だけを絶対path化して渡す。childの`file.search`は前段の通常file境界と同じM本体／`.personalization.jsonl`台帳の保護を適用する。親のtarget observationとchildのfile enumerationは同じeffective設定を使う。保護済みfile内容やpathは結果・receiptへ載せない。

Gateway専用workerを通じ、`BLUE_TANUKI_MEMORY_FILE`と`BLUE_TANUKI_MEMORY_DIR`の両設定で、M本体・停止台帳の合成内容が検索結果へ漏れず、通常ファイルconsumerが使えることを最小疎通する。Gatewayとworkspace依存のtypecheck/build、worker test、`docs:check`、`git diff --check`を実施する。実served Gateway、実ユーザーデータ、全suite、他OS、QE_QC／QE_QAはこのsliceではNOT_RUN。F20.01全体へ状態を拡張しない。

次は最新HEADで通常consumerを再選定する。物理消去・保存契約終了・backup処遇は引き続き保留し、rev4.0の`OD-04` ID衝突を消去許可に読み替えない。

## 前段完了BUILD_BATCH — QE_BUILD / F20.01 設定済みHDS記憶を通常file経路から隔離

主語は、HDSのM本体と個人化停止台帳、および利用者の一般file tool。目的は、HDSが管理する記憶の読取・編集・削除を通常のsandbox file経路から迂回できないようにし、停止台帳を越えた検索と一般file経路からの物理消去を防ぐこと。rev4.0のF20.01、BT-R-F20-02／03／04／06に沿った限定BUILD sliceである。

`buildHDSMemoryStore`と同じ優先順位で、`BLUE_TANUKI_MEMORY_FILE`または`BLUE_TANUKI_MEMORY_DIR/memory.jsonl`を実M本体として識別し、その`.personalization.jsonl`追記台帳も保護する。`file.search`の直接指定・列挙から両方を除外し、`file.write`／`file.edit`／`file.delete`の対象解決でも拒否する。設定パスと実ファイルidentity（hard linkを含む）を照合し、外部保存場所へのsandbox内hard linkも迂回にならない。未構成のin-memory storeには存在しないファイル保護を適用しない。通常ファイルの検索・編集能力は維持する。

この変更は個人化停止のHDS trace経路、J／Approval／Brokerの権限を置換せず、M本体・停止履歴を変更しない。物理消去、保存契約終了、backup/cache/remote copy/鍵の処遇は実装・実行していない。rev4.0本文では`OD-04`がRust single-writer cutoverを指す一方、F20.01の旧`原文詳細`は削除決定を同じIDで参照しており、IDが衝突する。今回の安全な通常file隔離はその解釈に依存しない。物理消去の判断には使わない。

core package `typecheck`／`build`はPASS。設定済みM・停止台帳・sandbox内hard linkを使うbuilt-in file path test 1件はPASS（`tools_builtin.test.ts`の他99件はskip）。実served Gateway、実ユーザーデータ、他OS、全suite、QE_QC／QE_QAはNOT_RUN。この一般file隔離sliceだけを`WIRED`とし、F20.01／F20全体や製品全体の完成へ拡張しない。

次は最新HEADから次の通常consumerを再選定する。F20の物理消去・保存契約終了・backup処遇はID衝突を含む判断が明確化するまで起動しない。

## 前段完了BUILD_BATCH — QE_BUILD / F20.02 記憶引用・個人化利用の停止をHDS/M経路へ接続

主語は、BLUE-TANUKIのHDSが保持する一件のM記録と、その後続引用・個人化consumer。目的は、ownerが明示した正確な`F:`参照について将来の記憶引用と個人化利用を停止し、履歴記録を残したまま有効な参照版・検索scopeを失効すること。rev4.0のF20.02とBT-R-F20-02／06／07に沿い、物理削除・保存契約終了は別作用として行わない。

接続は、CのOperationPlan候補→Jの`memory.personalization.stop` target resolver→対象M版・停止台帳revisionの観測→Executorの登録済み組み込みadapter→settings.write／high／L3 no-store owner review→Gatewayの直前再照合→digest-only hash-chain停止台帳追記→次回HDS memory traceの除外まで。参照IDとentry hashは完全一致し、台帳revision・command・Operation Plan bindingが変われば停止する。M本体は保持し、停止済み記録の`currentReferenceVersions`は`version=null`、有効台帳revisionを検索scopeへ束縛する。不正・不整合台帳では参照をfail-closedにし、履歴内容を台帳へ複製しない。Cへ許可・承認・権限を渡さず、D4／MINIDORA、provider、実ユーザーデータ、公開・出荷には作用しない。

最初のHDS疎通はOperationPlanの対象resolver未登録でFAILとなった。現物で接続欠落を確認し、記録参照・hash・scope・high/L3を固定するresolverとC向け候補契約を追加。同一疎通の再実行でPASSした。合成HDS→J計画→Executor経路でdigest-only review、作用結果・監査を確認。`packages/hds-brain/test/long_term_memory.test.ts` 21/21、`packages/blue-tanuki/test/memory_personalization_tool.test.ts` 2/2、`apps/gateway/test/operation_plan_runtime.test.ts -t "memory.personalization.stop"` 1/1はPASS。`pnpm typecheck`、15 workspaceの`pnpm build`、`pnpm docs:check`、`git diff --check`はPASS。実served GatewayのHTTP承認UI、実ブラウザー、実provider、外部作用、installed製品、5OS、full suite、QE_QC／QE_QAはNOT_RUN。これはこの記憶停止sliceのみの`WIRED`であり、F20全体や製品全体の完成を意味しない。

開始時のlocal main／remote mainは`3c3afbb6a6726d0f1f0f3c308d6507a33262fbe1`。local recovery branch `codex/backup-main=3c3afbb6...`／`codex/backup-main-prev=bfbdc006...`、remote recovery tagも同じ2世代。保護添付は変更していない。`git fetch`はGit管理下の旧worktree候補`blue-tanuki-health-2026-11-07-windows`へのアクセス拒否を出したため触らず保持し、`git ls-remote`でremote main SHAを独立照合した。

**次のproducer／consumer:** 現行HEADから、破壊的OD-04や実provider・別repoに依存しない、未接続の実consumerを再選定する。F20.03の物理削除・backup処遇はowner決定と別作用境界を保ち、今回の停止台帳へ混ぜない。

## 前段完了BUILD_BATCH — QE_BUILD / Windows Setup・Launcher・UninstallでExecutionPolicy保護を尊重

主語は、Windows上でBLUE-TANUKIを導入・起動・停止・更新・削除する製品および開発用entrypoint。対象はrev4.0のG02.01〜G02.03、とくにBT-R-G02-05（署名状態を偽らずOS保護を自動無効化しない）に関係するWindows呼出し経路。製品・開発用PowerShell子プロセス、cmd、生成ショートカット、Run登録、単体Setup wrapperから`ExecutionPolicy Bypass`を除き、現在の有効なOSポリシーに従わせる。SetupとUninstallは既存resident停止失敗時に更新／削除へ進まず、開発用Uninstallも停止・自動起動無効化の双方を確認してからアプリを除去する。

製品Uninstall cmdはtempへ複製したscriptを同期実行し、PowerShellの終了コードとstatus fileの`exit_code=0`を両方確認してから完了を返す。起動失敗・非0・完了記録欠落は成功扱いせず、状態確認前の再試行を促さない。Launcherはwatchdog子processが750ms後も動作していることを確認してからPIDを記録し、失敗時にはGatewayがwatchdogなしで残る可能性と確認方法を伝える。署名・証明書発行、Windows execution policyの変更、実機Setup／Uninstall、実ユーザーデータのPurgeは行っていない。

変更対象：`INSTALL_WINDOWS.cmd`、`install/resident/blue-tanuki-resident.ps1`、`install/windows/install.ps1`、`install/windows/uninstall.ps1`、`install/windows/product/`の起動・Setup・Uninstall入口、`scripts/package_product_installers.ts`、対応するWindows installer試験。

PowerShell parserは変更対象7 scriptでPASS。`install/installer/test/windows_product_installer.test.ts`は19/19 PASS（Windows process ownership、Setup停止拒否、Uninstall ownershipを含む隔離fixture）。製品source／package generatorのExecutionPolicy Bypass scanと`git diff --check`はPASS。これはコード接続と隔離fixtureの限定`WIRED`であり、downloaded package、clean-user install、実Setup→Uninstall、実行ポリシー拒否下の実機挙動、実データPurge、5OS、全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAを証明しない。外部作用、OneDrive操作、D4／MINIDORA変更なし。開始HEAD=`bfbdc00645dd3ec0b6ebe9150b050d86199cfe1b`。

**次のproducer／consumer:** 最新HEADとrev4.0から、Blue repo内で一仕事の到達距離を縮める次の未接続consumerを再選定する。別repo変更が必要なF16.03 mobile native producerは限定委任なしに編集せず、C08.03実provider試験とP13公開・出荷判断も保留する。

## 前段完了BUILD_BATCH — QE_BUILD / F16.02 WebChat owner音声→HDS/J・既存C文字起こし（限定WIRED）

主語は、ownerのWebChat音声依頼を一時入力としてHDS/J判断と既存C文字起こし経路へ渡し、話者音声を本人確認・承認・権限へ昇格させないBLUE-TANUKI。Control Centerに独立した「音声文字起こしを依頼」を追加した。専用owner tokenで`POST /owner/audio-transcribe`を呼び、20 MiB以下のcanonical Base64から形式署名を検査したFLAC/MP3/MP4/M4A/OGG/WAV/WebMだけを1件受け付ける。画像添付／計画作成とは別要求で、音声文字起こしCの戻り値を計画JSONとして誤用しない。ownerは返却された文字起こし候補と不確実性を確認し、計画へ使う場合は計画欄へ明示入力する。

実装経路：Control Center音声選択→owner専用HTTP入口→検証済み一時`ephemeral_audio`→Gatewayのrequest ID／専用projection／actor／operation-core照合→request-bound audio marker→HDS/J→既存`llm_call` Executor/C→既存出力監査・返信。raw audio bytesはInboundRequest本文・metadata・history・Mへ入れず、Router handler終了後にzero化する。HDS内部requestへaudio SHA-256・format・byte lengthを非権威の一時参照として束ね、`used_for_authority=false`を維持する。文字起こしC経路は既存どおり確度未報告を明示し、音声だけで承認・作用を行う経路は追加しない。Telegramと共有するsignature／MIME判定および20 MiB上限をProtocolへ集約した。

`corepack pnpm --filter @blue-tanuki/gateway... build`は対象7 workspace projectとGatewayでPASS。`webchat.test.ts -t "owner task form|audio for owner-reviewed transcription|owner audio file to HDS"`は3 passed／118 skipped（owner token拒否、余分なauthority風field拒否、不正signature拒否、音声request context、handler後のzero化、ブラウザー送信bodyからのtask／approval分離）。`telegram_attachment_ingress.test.ts -t "owner WebChat audio transcription through HDS|Telegram voice through HDS"`は2 passed／3 skipped。HTTP実WebChat音声入口からGateway境界選別・request-bound HDS/J・fixture C・出力監査まで一回を縦断し、transcript uncertainty・memory retrieval抑止・owner voice非権威を確認した。`packages/protocol/test/types.test.ts -t "binds owner WebChat transcription"`は1 passed／37 skipped。最終`git diff --check`はPASS。

この証拠は合成OGG fixture・fixture Cでの限定`WIRED`。実provider／credential／費用、Control Center実ブラウザー、file以外の形式全種、異常網羅、再起動耐久、全suite、5OS、QE_QC／QE_QAはNOT_RUN。QE_BUILDとP13 `PENDING_OWNER_GO`を維持し、外部作用・公開・owner GOを成立させない。F16.02のこのWebChat owner transcription sliceだけを`WIRED`とする。

**次のproducer／consumer:** rev4.0と最新HEADからF16.03のBLUE側native音声入力・Device Link境界を再照合する。D4 Pocket自体の変更は別repo権限範囲外のため行わず、D4のmobile契約は読取参照に限る。

## 前段完了BUILD_BATCH — QE_BUILD / F16.01 WebChat owner画像入力→既存Gateway C（限定WIRED）

主語は、ownerがWebChatで委任した仕事へ画像原媒体を一時添付し、既存Gateway/HDS/C経路へrequest-boundで渡すBLUE-TANUKI。owner認証済み`POST /owner/task-compute`にJPEG/PNGを1枚・最大5 MiBで追加した。厳密なBase64、サイズ、画像署名を確認し、submission identityにはmedia type・長さ・SHA-256を束ねる。同じsubmission IDで画像を変えた再送は競合として拒否する。画像bytesをInboundRequest本文・metadata・history・Mへ入れず、handlerの完了または未引渡し時にゼロ化する。通常WebChat inbound、owner以外、外部metadata由来のowner風入力はGateway側で選択しない。既存LLM registryが選択provider/modelのimage capabilityを確認し、未設定ならC要求を明示拒否する。

実装経路：Control Center file input→owner専用HTTP入口→検証済み一時image context→Gatewayの内部owner-task識別・request ID照合→既存`llm_call` Executor/C。画像の生bytesは不揮発領域へ書き込まない。Telegramと共通のJPEG/PNG署名判定・5 MiB上限をProtocolへ集約した。

`corepack pnpm --filter @blue-tanuki/gateway... build`は対象7 workspace projectとGatewayでPASS。`webchat.test.ts -t "owner task form|routes explicit task intent"`は2 passed／117 skipped（owner認証、1 MiB超画像body、異署名拒否、same-ID画像変更拒否、handler後のzero化を含む）。`telegram_attachment_ingress.test.ts`は4 passed（外部owner風metadata拒否、既存Cへ画像bytes到達を含む）。`git diff --check` PASS。これらは合成画像・fixture Cでの限定WIRED確認。Control Center browser、実provider／model、全suite、全OS、実物QC／QAはNOT_RUN。`webchat.test.ts`全体の一度目実行は117 passed／2 failed。一つは新規画像受渡し確認でNode Bufferの共有viewをcopyと誤認した試験コード不備であり、独立copyへ修正後に該当2件を再実行してPASS。もう一つは変更範囲外のplan待機カード描画assertion（line 1161、検索結果null）で、未調査・基準状態との差未確定として保持する。修正後の全file再実行は行っていない。

F16.01のこのWebChat owner入力sliceだけを`WIRED`とする。画像入力全体、F16全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、provider/runtime success、5OS、owner GOは未成立。

**次のproducer／consumer:** rev4.0と最新HEADを再照合し、端から端までの距離・未接続依存・危険度・既存資産・実行可能性で次の実consumerを選ぶ。実provider、外部作用、全体QC／QA、D4 Pocket等の別repo変更は引き続き対象外。

## 前段完了BUILD_BATCH — QE_BUILD / C08.02 wait再開へ保存済みowner達成規則の参照を継承（限定WIRED）

主語は、ownerが委任した同一仕事の達成規則をwait後の返信・期限再開・中断復旧後も保持し、Cの再計算とJ/M達成判定が同じ規則集合を参照するBLUE-TANUKIのHDS-BRAIN経路。wait台帳から、task identity・goal digest・規則digestを再検証したうえで、規則digest・件数・元request参照だけをGoalProjectionへ渡す。規則本文は再投影しない。返信／metadataで差し替えた規則は使わず、保存規則が欠落または不整合なら再開を保留する。GoalProjectionは非権威の`identifying`状態を保ち、達成には従来どおり明示規則、検証済みoperation result、検証済みM receiptを要する。

HDS-BRAIN buildとGateway typecheckはPASS。`apps/gateway/test/operation_plan_runtime.test.ts`のwait返信／期限再開／中断復旧を通す2ケースはPASS（46件skip）。合成planと一時SQLiteだけを使い、返信中の規則差し替えが保存済み規則digestを変更しないことも確認した。`pnpm docs:check`と`git diff --check`はPASS。日本語基底監査はPASSで既存移行負債76件の注意を表示した。full suite、実provider／live外部作用、Control Center browser、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このC08.02 wait再開sliceのみを`WIRED`とし、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

**次のproducer／consumer:** rev4.0と最新HEADを再照合し、実provider・公開作用・全体QC／QAに依存しない次の未接続consumerを選定する。

## 前段完了BUILD_BATCH — QE_BUILD / C08.02 owner評価規則をGoalProjectionとJ/M判定へ同一digestで結合（限定WIRED）

主語は、ownerが委任した仕事の達成規則を非権威のGoalProjectionから現行J/M判定まで同一性を保って結ぶBLUE-TANUKIのHDS-BRAIN経路。内部認証されたowner規則だけを`evaluation_rules.status=referenced`としてdigest・件数・request参照で投影する。規則本文／期待値はGoalProjectionへ複製せず、projection IDは規則digestへ束縛する。その他のgoal要素が未確定なのでprojectionは`identifying`のままとし、権限や達成判定を付与しない。外部入力のowner風metadataと規則は参照生成に使わない。

JのOperationPlan policyは同じcanonical digestを使う。達成には各明示規則に一意に対応するstep、検証済みoperation result、検証済みM receiptが必要であり、欠落・曖昧・未検証・不一致は保留、達成後は同一taskを停止する既存動作を維持する。protocol／HDS projection testは4／5件PASS、Gateway `operation_plan_runtime.test.ts`の達成・不一致2件PASS（同file 46件skip）。protocolとHDS-BRAINのtypecheck／build、Gateway typecheck、`pnpm docs:check`、`git diff --check`はPASS。日本語基底監査はPASSで、既存移行負債76件の注意を表示した。

これは評価規則のdigest参照sliceだけの限定`WIRED`である。Gateway served process全体、Control Center browser全往復、実provider／live外部作用、installed製品、5OS、full suite、QE_QC／QE_QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、owner GOはこの差分では確認・成立していない。

**次のproducer／consumer:** rev4.0と最新HEADから、実provider・公開作用・全体QC／QAに依存しない次の未接続consumerを選定する。

## 前段完了BUILD_BATCH — QE_BUILD / C08.02 served Gatewayのowner規則入力→J/M達成判定・再起動後状態（限定WIRED）

主語は、ownerが委任した仕事を明示規則と検証済み根拠で評価し、達成または保留を認証済み状態として表示するBLUE-TANUKIの実served Gateway／HDS J／M経路。隔離Gateway processのowner-token付き`/owner/task-compute`へJSON規則を入力し、synthetic `file.search`を既存executor・J/Mへ通した。規則欠落では検索結果とreceiptがあっても`goal_completion_rules_missing`で保留し、規則一致では全stepの検証とM receipt後に`goal_completion_rules_satisfied`で達成した。HDS runtimeの独立runtime testでは誤った期待値を`goal_completion_result_mismatch`として保留し、sealを作らず再起動後も保留する。

Gatewayのserved integrationでは、達成状態を認証済み`/runtime/snapshot` projectionから観測し、Gateway再起動後も同じtask identity・達成状態が復元されることを確認した。直接HDS testでは再起動後の同一step reviewが拒否される。規則はexecution permissionではなく、出荷・owner GOも生成しない。served testは一時file rootとsynthetic backendに限り、Control Center browser全往復や外部providerは使っていない。

`document_organization_entry.test.ts`選択Gateway process test 1 passed／6 skipped、`operation_plan_runtime.test.ts`選択HDS runtime test 2 passed／46 skipped、`pnpm docs:check`と`git diff --check`はPASS（日本語基底の既存移行負債76件の注意あり）。full suite、実provider／live外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このC08.02 owner input→J/M判定・認証状態復元sliceだけを限定`WIRED`とし、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。保護添付は変更していない。OneDriveへのGraph登録・dehydrate・回収操作は行っていない。一時test workspaceはfinally cleanup済み。

**次のproducer／consumer:** rev4.0と現行HEADからQE_BUILDの次の未接続実consumerを選び、同じ有限単位で接続する。実provider検証、live外部作用、全suiteの品質改善、QE_QC／QE_QA、公開・出荷判断は対象に含めない。

## 前段完了BUILD_BATCH — QE_BUILD / Gateway再起動後も同一taskの失敗からOwner確認・回復候補へ継続

主語は、同一Workspaceで編集後test失敗を観測し、Gateway再起動をまたいで状態を復元してOwner確認・回復候補へ進むBLUE-TANUKIのGateway／HDS／WebChat経路。前の合成sliceに続き、固定隔離コマンド（`node -e "process.exitCode = 23"`）後にGatewayを停止・再起動し、同一plan ID・revision・task identityのshell summaryとM receiptが復元されること、ファイルが変更後状態のままで自動復元されないことを接続確認した。再接続後の同一path `file.search` → Ownerへの結果返却 → 同一task／目的bindingの逆編集候補 → no-store内容確認とL3承認 → 逆編集 → `file.search`までを通した。実provider呼出し・外部作用はない。

Control Centerの保存済みOperation Plan projectionでは、current purpose binding、成功receiptを持つ同一Workspaceの3-step plan、失敗summaryがそろう場合だけ逆編集候補ボタンを表示し、保存receiptが欠落した場合は表示しないことを確認するtestを追加した。ボタン操作はowner tokenを使った`plan:compute`候補依頼として同じplan／revision／step／目的bindingへ結び、直接編集を実行しない。

Gatewayの対象隔離testは2 passed／5 skipped、WebChatの対象renderer／action testは2 passed／116 skipped。これは合成fixtureの限定接続確認で、実際の製品test suite、timeout・異常process、実provider、installed製品、他OS、QE_QC／QE_QAではない。C08.02／F01.03のこのrestart回復sliceだけを限定`WIRED`として扱い、E2E-01全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。次単位はrev4.0と現物から再選定する。

## 前段完了BUILD_BATCH — QE_BUILD / E2E-01 同一taskのtest失敗からOwner確認・回復候補・再読込

主語は、同一task内で編集後のtest失敗を観測し、Ownerの現在状態確認を経て復旧候補を再計画するBLUE-TANUKIのGateway／HDS経路。合成fixtureに限り、file.edit → 固定隔離コマンド（`node -e "process.exitCode = 23"`）→ summary-only結果 → 同一path file.search → Ownerへの結果返却 → 同一task／目的bindingの逆編集候補 → 別個のno-store内容確認とL3承認 → 逆編集 → file.searchを接続した。失敗結果はexit code等の境界付き要約に限り、stdout／stderrを含めない。失敗だけで元ファイルを自動復元せず、候補実行にもOwner承認を要求する。

対象Gateway test 1 passed／6 skipped、`pnpm --filter @blue-tanuki/core typecheck`、`pnpm --filter @blue-tanuki/core build`、`pnpm docs:check`、`git diff --check`はPASS。実際の製品test suite、timeout／異常process、実provider、外部作用、installed製品、OS別QAはNOT_RUN。この合成sliceだけを限定`WIRED`とし、E2E-01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAへ拡張しない。次単位はrev4.0と最新実物から次consumerを再選定する。

## 前段完了BUILD_BATCH — QE_BUILD / Windows UninstallのDataRoot所有を削除直前に再確認

`-PurgeData`の開始時検証後、installed app・ショートカット・uninstall登録を除去してからユーザーDataRootを削除する直前に、DataRootのowner markerと再parse点を含む構造をもう一度検証する。検証を`Remove-Target`の削除経路へ束縛したため、対象が差し替わった場合はユーザーデータの再帰削除を拒否する。拒否時点ではapp側の除去が済んでいる可能性をエラー文に明示し、DataRootは保持する。通常Uninstallのユーザーデータ保持と他のmanaged target処理は変えない。

PowerShell parser、`corepack pnpm docs:check`、`git diff --check`はPASS。test／installed Uninstall／DataRoot変更競合の実行はNOT_RUN。この経路の静的接続だけを実装済みとし、Windows lifecycleやSetup→Uninstall全体の実動作へ拡張しない。D4-Pocketは読取専用で契約を確認し、同repo・実ユーザーデータ・実製品へ変更なし。

## 前段完了BUILD_BATCH — QE_BUILD / Windows製品Setupの常駐停止失敗をfail-closed化（限定WIRED）

主語は、既存Windows製品を更新するSetupと、稼働中の製品・共有データを保護する導線。`BlueTanukiLauncher.ps1 stop`の失敗または非0終了をSetupが警告だけで無視していた欠陥を修正した。Setupは停止結果を確認し、停止不成立なら既存installのswap、共有DataRoot／設定へのSetup処理、installed doctor起動へ進まない。対象installを停止した後もmanaged inventoryを再検査してから共有データと更新処理へ進む。

Windows隔離fixtureでLauncher stopをexit 23にし、Setupの停止関数が拒否して後続へ進まないこと、既存fixture launcherが不変であることを確認した。呼出し順もDataRoot作成とconfig Setupより前であることを確認。対象Vitest 1 passed／18 skipped、workspace typecheck、`BlueTanukiSetup.ps1` PowerShell parser、15 workspace build、`docs:check`、`git diff --check`はPASS。全suite、実installed Setup／Uninstall、registry／Start Menu、実package更新、実ユーザーDataRoot、5OS runtime、QE_QC／QE_QAはNOT_RUN。Setupの停止失敗境界だけを限定`WIRED`とし、Windows lifecycle全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

生成したfake install／launcher／harnessはtestのfinally cleanupで回収。ignored workspace build出力は次の開発用として保持。保護された添付領域、D4-Pocket／ミニドラrepo、実ユーザーデータ、OneDrive資料には変更なし。

## 前段完了BUILD_BATCH — QE_BUILD / Unix packaged Setupの更新中断後再起動復旧（限定WIRED）

Linux/macOS共通のpackaged `BlueTanukiSetup.sh`は、同一install parent内の正確なhidden rollback siblingを一意に確認し、rollback app/runtimeのowner marker・package metadata・managed file inventory・Node pathが現在の最終rootへ結び付くことを検証する。active app/runtimeがすでに新側へ切り替わっている場合は、その双方も完全なmanaged installとして検証する。複数候補、対にならないruntime候補、inventory／root不一致、曖昧なactive root、env config rollback backupの存在は全経路を保持してfail-closedする。

復旧前に対象installの`resident-stop`を実行し、停止後にrollback・active inventoryを再確認する。旧appだけが退避されruntimeがactiveに残る状態、旧app/runtimeが退避され新app配置後に停止した状態、新app/runtime両方がactiveの状態から、検証済み旧版を同一rootへ戻す。現activeの検証済み部分は隠しinterrupted siblingへ保全し、削除しない。DataRoot、ConfigRoot、user data、env fileを復旧処理で上書き・削除しない。config backupを伴う中断状態は自動変更せず、保留する。

WSL Ubuntu 24.04のext4一時workspaceで`safe_target_unix.sh`を実行し、Setupを実際に強制終了させるfixtureで旧app退避後、新app配置後、新runtime配置後の三つの状態から次回Setup復旧を確認した。復旧前のresident-stop拒否時は全rollback／active pathが無変更であること、user data／env hash保持、新側部分の保全、複数rollback候補の無変更拒否も確認した。対象shell `sh -n`、Windows `product_installers.test.ts` 4/4、workspace `typecheck`、15 project `build`はPASS。`docs:check`と`git diff --check`はPASS。Linux native／macOS installed製品、実機再起動・更新、全suite、QE_QC／QE_QAはNOT_RUN。この復旧実装・fixture経路のみを限定`WIRED`とし、実installed製品やOS全体へ拡張しない。

次はrev4.0と現行実物から、全体の一気通貫仕事に最も不足するconsumerを再選定してQE_BUILDを続ける。実provider／live外部作用、D4-Pocket／ミニドラ別repo変更、Rust authority cutover、公開・出荷判断は保留する。

## 前段完了BUILD_BATCH — QE_BUILD / Linux/macOS製品Setup・Uninstallの常駐process所有確認（限定WIRED）

Linux/macOS向けpackaged product Launcherは、PID記録の数値だけを根拠にprocessを停止しない。PID recordの通常ファイル性・単一行・数値範囲を確認し、installed Node／Gateway entry／`--serve`／同一installのenv fileでresident identityを照合する。watchdogはinstalled Launcher pathと`resident-watchdog` commandで識別する。record欠落・stale時は同一installのprocess inventoryから復元可能な一意の対象だけを選び、形式不正・複数候補・identity不明・inventory失敗はfail-closedする。SIGTERM後最大10秒待機し、再走査でresidentとwatchdogが残っていない場合に限りPID／stop recordを除去する。Setup updateとUninstallは`resident-stop`失敗時にswap／install tree削除を中断する。Uninstallの無条件autostart削除を除き、既存のownership-checked removalへ集約した。managed product runtime inventory hashがJSONの最終propertyとなる形もvalidatorが受け付ける。

`install/installer/test/safe_target_unix.sh`のWSL Ubuntu 24.04隔離process fixture（install path内の複数連続空白を含む）、対象shellの`sh -n`、Windows上の`product_installers.test.ts` 4/4、`corepack pnpm typecheck`、`corepack pnpm build`（15 projects）、文書同期後の`corepack pnpm docs:check`と`git diff --check`はPASS。実macOS、実installed Setup／Uninstall、実製品更新・削除、全suite、QE_QC／QE_QAはNOT_RUN。このpackaged Unix product-path sliceだけを限定`WIRED`とし、Linux native／macOS製品全体、5OS、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

次はrev4.0と最新実物から全体の一気通貫仕事に最も不足する実consumerを再選定してQE_BUILDを続ける。実provider／live外部作用、D4-Pocket／ミニドラ別repo編集、Rust authority cutover、公開／出荷判断は保留する。

## 前段完了BUILD_BATCH — QE_BUILD / G02.02・G02.03 Windows常駐process所有確認と削除停止境界（限定WIRED）

Windows製品LauncherはPIDファイルの番号だけで停止対象を決めず、実processの実行ファイル、command line、bundled Nodeまたはinstalled Launcher、Gateway entry、`--serve`、同じDataRootのenv fileを照合する。PID recordが欠落・staleの場合はprocess inventoryから同一installのcandidateを探し、一件だけidentityが一致したときだけ記録を復旧または停止する。recordの読取・形式不正、複数candidate、identity不一致・取得不能では重複起動も停止もfail-closedする。Watchdogもinstalled Launcherを`watchdog` modeで実行するPowerShell processであることを確認する。所有確認したprocessだけを停止し、10秒以内の終了と残存processなしを確認してからPID recordを消す。終了未確認・停止失敗ではrecordを保持する。UninstallはLauncher stopが0を返さない場合にinstall treeの削除を中断し、installed filesとuser dataが未削除である旨を返す。既存のDataRoot保持／明示purge契約は変更していない。

全workspace `corepack pnpm typecheck` PASS、`corepack pnpm build` PASS（15 projects）、`windows_product_installer.test.ts` 18/18 PASS、対象PowerShell 2ファイルのParser PASS、`git diff --check` PASS。testは隔離したWindows process fixtureで、無関係processを止めないこと、所有済みresident／watchdogの終了後にだけPID recordを消すこと、resident／watchdogのPID record欠落時に同じinstallのprocessだけを検出・停止することを確認した。実ユーザーのInstallRoot、registry／Start Menu、実package更新／削除、installed製品E2E、他OS、全suite、QE_QC／QE_QAはNOT_RUN。このprocess停止・Uninstall順序のsliceだけを`WIRED`とし、G02、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

次はrev4.0と最新HEADから全体の一気通貫仕事に最も不足する実consumerを再選定してQE_BUILDを続ける。実provider／live外部作用、D4-Pocket／ミニドラ別repo編集、Rust authority cutover、公開／出荷判断は保留する。

## 前段完了BUILD_BATCH — QE_BUILD / G02.03 Windows更新中断からの所有済みinstall復旧（限定WIRED）

Windows製品Setupでinstall rootが見つからない場合、同じinstall parent直下にある、現install名とGUID形式が一致するrollback候補だけを調査する。現在のinstallが存在する場合は介入しない。候補が複数、非directory／reparse、metadata・package manifest・managed-file inventory・data rootの照合不一致なら、既存候補を保持してSetupを停止する。候補が一件で所有と全inventoryを確認できたときだけ同じparent内でactive installへ戻し、戻した後もinventoryを再検査してから通常のpackaged updateを続ける。DataRootは変更・削除せず、候補cleanupや自動再送をしない。

Windows隔離fixtureで「複数候補はすべて保持して停止」「単一の正当候補は復旧し、DataRootのuser dataを保持」を確認した。`windows_safe_target.test.ts` 2件と`windows_product_installer.test.ts` 14件は計16件PASS。実ユーザーのInstallRoot、registry、Start Menu、実package更新／削除、installed runtime、他OS、全suite、QE_QC／QE_QAはNOT_RUN。この復旧sliceだけを限定`WIRED`とし、G02全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

次はrev4.0と最新実物から、一気通貫の仕事経路に最も不足するconsumerを選びQE_BUILDを継続する。製品更新・削除の実機QA、実provider／live外部作用、別repo編集、Rust authority cutover、公開／出荷判断は行わない。

## 前段完了BUILD_BATCH — QE_BUILD / F05.02 GitHubの単一新規ファイルcode.push（限定WIRED）

### 現在の施工状態 — 2026-11-09

`github.write code.push`を、既存のOperation Plan、HDS J target/payload照合、L3 no-store content review、Approval／Broker／Executor、結果receipt、J/M保存、Ownerの`plan:result`へ接続した。作用はallowlist内repositoryの既存non-default branchに対する単一の新規UTF-8 file追加（65,536 bytes以下）に限定する。安全な相対path、観測したbranch HEAD、content／commit messageを同じcommand・Operation Plan binding・digestへ結合し、default branch、既存file、別HEAD、余分な引数は拒否する。Control Centerはrepository可視性、target branch・HEAD、path、正確なfile内容、byte数とdigest、通知可能性、結果不明時に自動再送しないことを示し、内容はHTMLで解釈せずtext nodeへ表示する。

作用はGitHub GraphQL `createCommitOnBranch`の`expectedHeadOid`と単一`FileAddition`を使う。承認後にtargetを再観測し、provider側HEAD条件が不一致ならbranchを更新しない。受理応答はcommit親・更新ref・commit SHA・内容digestを照合し、さらにbranch HEADを再読取する。送信後に結果を確定できない場合は`outcome_unknown`として保持し、自動retryしない。明示的provider拒否は別receiptとしてJ/Mへ保存する。専用`github:code.write` capabilityをprotocol、HDS process、plugin loader／manifestへ追加した。

`corepack pnpm typecheck`と全workspace build（15 projects）はPASS。5ファイルのcode.push選択testは8 passed／309 skippedで、built-inの新規file・stale/default/existing拒否、Executor no-store review、Operation Plan結果照合、Gateway内結果調停を通る受理／明示拒否／結果不明、WebChatの未信頼テキスト表示を確認した。`git diff --check`もPASS。現GitHub API／credential、Gateway `--serve` process、owner browser操作、他OS、全workspace suite、QE_QC／QE_QAはNOT_RUN。実provider用のテスト資格情報や外部作用は使っていない。

この`code.push`接続sliceだけを限定`WIRED`とする。F05.02全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、5OS、公開／出荷GOへ拡張しない。次はrev4.0と最新実物から、全体の一気通貫接続に最も近づく未接続producer／consumerを選ぶ。実provider送信、live外部作用、別repo編集、Rust authority cutover、公開・出荷判断は保留する。

## 前段完了BUILD_BATCH — QE_BUILD / 親planのM解釈依存を子planへ継承（限定WIRED）

### 現在の施工状態 — 2026-11-09

rev4.0のowner採用後、C04.03「依存版の失効」とD01.03「未実行部分の再審査」にまたがる接続欠損を修正した。親OperationPlanを現在性検査するとき、J/Mのmemory interpretation dependencyを返し、`plan:compute`がその依存を新しい計画候補のC入力へ含める。今回のsource citationがある場合は親由来の依存と合わせ、同一judgmentの同一参照だけを重複除去する。単一group内の重複、内容が競合する同一judgment、64件上限超過、再評価要求・現在性不明は拒否する。候補planの保持直前にも統合済み依存を再確認し、子planの状態へ結合する。引用本文・秘密はCへ渡さず、Mは非権威参照のままとする。

`plan:compute`のprompt形状変更に合わせ、memory citation用local P versionをv2へ進め、source observationとmemory citationを併用する形に専用versionを設けた。限定test 4 passed、protocol build、HDS-BRAIN typecheck／build、`hds:standalone`、`docs:check`、`git diff --check`はPASS。全workspace suite、Gatewayの親→子plan runtime経路、実provider／credential／外部作用、5OS、QE_QC／QE_QAはNOT_RUN。これはC04.03／D01.03のコード接続に限る。実runtimeの一仕事、C/J/M全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

次のBUILD_BATCHはrev4.0の全体接続面と現物から、端から端の仕事に最も距離がある実consumerを選び直す。実provider送信、live外部作用、別repo編集、Rust authority cutover、公開・出荷判断は行わない。

## 前段の完了BUILD_BATCH — QE_BUILD / C/J/M cited-memory dependency source binding（限定WIRED）

### 現在の施工状態 — 2026-11-09

`OperationPlanLedger`が保持・現行性確認するM interpretation dependency群を、選択済みstepのexecution source digestにも含める。dependency付きplanは`blue-tanuki.operation-plan-execution-source.v2`として`memory_interpretation_dependencies_digest`を結び、dependencyなしplanは既存v1形式を保持する。Mは引き続きnon-authority evidenceであり、このdigestは権限・承認・意味適合を生成しない。既存v1のdependency付きpending bindingは新digestと一致しないためfail-closedし、再bindを要する。

異なる有効dependency集合のotherwise-identical planでexecution source digestが異なることと、Jが再評価対象にした引用のexecution拒否を対象test 2件で確認。HDS-BRAIN typecheck／build、`hds:standalone`、`corepack pnpm docs:check`、`git diff --check`はPASS。全workspace suite、Gateway process、実provider／credential／外部作用、5OS、QE_QC／QE_QAはNOT_RUN。次のBUILD_BATCHは現行実物からF05.02に残る実producer／consumer gapを選定し、なければ現行工程表の次のC/J/M E2E consumerへ進む。実provider・live外部作用・公開判断を行わない。

## 前回完了BUILD_BATCH — QE_BUILD / F05.02 cross-repository fork-head PR create（限定WIRED）

### 現在の施工状態 — 2026-11-09

既存`github.write pr.create`へ、Ownerが明示した別repositoryのhead branchをつなぐ。base／head repositoryをそれぞれallowlist・identity・可視性・fork network rootまで観測し、headはbaseと同じnetworkのforkだけを受け付ける。head/base branch refとcommit SHAを含むtarget／payload digestをOperation Plan、HDS J、no-store L3、Approval Gate／Broker／Executor、成功／拒否／結果不明receipt、M、Owner結果照会まで同一taskに束縛した。L3画面は両repository・各可視性・fork network・両ref/SHA・通知可能性・非原子競合・作成非可逆性を示す。cross-repository requestだけGitHub APIの`head=owner:branch`と`head_repo=repo`を使い、同一repositoryの旧request形式を保つ。応答不明は自動再送しない。

同一repository回帰を含む合成・test-owned loopback検査では、全workspace typecheck／build、`github.write pr.create`選択test 3 passed／94 skipped、Executor選択test 1 passed／16 skipped、Gateway process選択test 4 passed／75 skippedを確認済み。実GitHub・実資格情報・外部作用、process拒否／結果不明はNOT_RUN。現行差分は前回の同じ選択検査後から変わっていないため、今回test suiteは再実行していない。

このcross-repository `pr.create`経路だけを限定`WIRED`とする。F05.02の他の残差、F05全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、5OS、owner GOへ一般化しない。次のBUILD_BATCHは現行実物からF05.02の残るproducer／consumer gapを選定する。実provider・live外部作用・公開判断は行わない。

## 前回完了BUILD_BATCH — QE_BUILD / F05.02 PR diff範囲review comment consumer（限定WIRED）

### 当時の施工状態 — 2026-11-08

既存5 write操作の結果consumerは、承認済みcommand・Operation Plan binding・target/request digestをHDSで再照合し、Executorで受理receipt／限定拒否receipt／結果不明を区別してJへ配送する。Jは`verified`／`provider_rejected`／`verification_failed`／`outcome_unknown`を記録し、Mには本文やprovider応答本文を置かずdigest-only観測を保存する。Owner結果照会は保存状態とHTTP statusを返し、再送しない。既存5操作の合成受理・明示拒否・結果不明15件と、built Gateway processの5操作受理経路は前段で確認済み。

今回、既存`pr.comment.create`のtimeline commentと単一diff行variantを維持しながら、複数行`pull_request_review_inline`を同じ実consumerへ接続した。`start_line`／`start_side`と終点`line`／`side`を組で扱い、両端が同じunified-diff hunkに一意に存在し、diff上の順序が正しいことを検証する。LEFTとRIGHTの行番号は別座標なので数値の大小で順序を判定しない。PRファイル一覧は最大300 files、patchは256,000文字、no-store review excerptは4,096文字で制限し、選択範囲が上限を超える場合はPOST前に拒否する。target-version／request digest、Operation Plan、HDS、Executor、WebChatのno-store L3 reviewが両端・commit・diff digestを同一束縛し、差分内容は`textContent`で未信頼表示する。作用直前にもPR／diffを再観測し、accepted responseが本文・範囲・head commit・PR URLに一致する時だけ成功summaryを返す。既存の単一行とtimeline経路は維持する。

単一行・複数行inline variantそれぞれの受理／明示拒否／結果不明をin-processで確認し、built Gateway `--serve` processではtimeline・単一行・複数行rangeのaccepted経路をtest-owned loopback fixtureで確認した。process外向き通信はloopback以外を遮断し、実provider・実資格情報・実GitHub送信はない。対象core 2 test fileは107 passed／6 skipped、Gateway `execution_result_reconciliation.test.ts -t "inline diff|pull_request_review_inline"`は8 passed／71 skipped、Control Center scriptを含むWebChat testは1 passed／114 skipped。`corepack pnpm typecheck`、全workspace `corepack pnpm build`（15 project）、`pnpm docs:check`、`git diff --check`はPASS。初回Gateway process試験は更新前のbuild出力で不成立だったが、fresh build後の同一選択試験はPASS。実GitHub runtime、全suite、QE_QC／QE_QA、5OSはNOT_RUN。300-file上限外やdiffを確定できない対象、別repository headの`pr.create`は未成立として保持し、F05全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ昇格しない。

rev3.1の現行指示に従い、F05.01 repository/base identityを既存5 write operationのconsumerへ接続した。`pr.comment.create`はtimeline、単一行inline、同一hunk内の複数行inlineを合成範囲で接続する。Issue／PR targetは作用直前に再読取し、PR commentの位置・head/base commit・diff digestをreviewへ束縛する。通知可能性、非原子的競合、不可逆性をreviewへ示し、結果不明は自動再送しない。processでの拒否・結果不明、実GitHub runtime、別repository head PR、F05全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立として残す。試験専用Temp fixtureはfinallyで回収し、保護添付と別repoは変更していない。

## 保留を維持する健全化残件 — 2026-11-07 follow-up D

追加健全化のA（Windows／WSL環境と依存物）、B（Teams時刻依存の決定論化）、C（複合統合・通常全件suiteの安定性）は当時の条件で検証した。Windows suite 2回連続PASS、WSL suite 1回PASS、Teams suite 5回連続PASS。実測は先頭の[`開発進捗.md`](開発進捗.md)に記録した。この作業は現行F05.02を止めない。

DのWindows実機製品Setup／Uninstall隔離target一連試験は`NOT_RUN`であり、健全化は未完了。Codex自動コマンド審査が試験用harnessを実行前に拒否した。通常のinstaller／guard／dry-run testはPASSだが、実製品の動的Setup／Uninstall証明へ拡張しない。拒否された経路を迂回せず、動的試験を実行できる正規の手段が成立するまでDを未成立として扱う。

作業資産の閉包ではWSL検証cloneを削除済み。Windows一時validation worktreeは正規の解除を試みたがOS ACLで拒否され、残存copyを`保留`として記録した。ACL変更・削除迂回はしていない。詳細と容量は先頭の[`開発進捗.md`](開発進捗.md)にある。

## 前回owner委任 — 2026-11-05 リポジトリ健全化（完了）

一回限りのリポジトリ健全化は、対象commit `1603a10f0f7433a2481d7bc1a79e1f744fb8c633`で実装・検証を完了した。範囲と証拠は先頭の [`開発進捗.md`](開発進捗.md) に記録する。本taskはQE_STAGEやrev3.0三点セットを変更せず、製品機能、別repo、QE_QC／QE_QA、外部provider、公開・出荷判断を開始していない。F05.01は最後に記録されたfeature BUILD_BATCH、F05.02は未着手であり、次のfeature BUILD_BATCHはownerの次指示から再同期する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.1はHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。現行正本が定める検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 直近の完了BUILD_BATCH — F05.01 GitHub repository/base commit identity read

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
