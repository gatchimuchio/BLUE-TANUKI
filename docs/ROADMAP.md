# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。ownerは2026-11-09にrev4.0を採用し、唯一の現行pinを[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)へ更新した。HDS Frameworkの意味・関係・反証・学習とBLUE Runtimeの有限なJ/M制御を区別する。現行TypeScript HDS-BRAINはrev4.0のsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

### 直近完了BUILD_BATCH — F17.03 CanvasからJ/Broker/sandbox/M receiptまでの限定synthetic consumer

2026-11-11、既存WebChat/GatewayのCanvas経路を合成CからJの委任目的関係・plan step審査、Approval Gate、隔離sandbox file.write、bytes結果照合、M receipt、owner明示達成規則、Gateway再起動後の復元まで一つのtaskで通す統合testを実行しPASSした。実環境はlocalhost Gatewayと固有Temp root、synthetic backend、fixture tokenのみ。試験は1件PASS／同file内7件skip。Temp root cleanupと元path不在を確認した。

これはF17.03の限定synthetic WIRED consumerで、実人間L3操作・実ブラウザー操作・実LLM/provider・外部書込み・実ユーザーデータを証明しない。製品全体SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは未成立。次の独立作業は現行rev4.0とHEADからローカル隔離で進められる全体接続を選ぶ。詳細は[最新の施工状態](IMPLEMENTATION_INSTRUCTIONS.md)と[実装履歴](IMPLEMENTATION_HISTORY.md)。

### 前段完了BUILD_BATCH — F04.02 Google Drive公開リンクreader共有の限定consumer

`google.drive.write`へ専用`permissions.create.public_link`を接続した。Owner taskで対象と「リンクを知る全員へのreader公開」を明示し、`allow_file_discovery=false`を固定する。認証Owner所有のMy Drive `text/plain`一件だけを対象とし、既存公開grant・版／本文／アクセスscope変化は拒否する。no-store L3 reviewで公開本文全体とACLを示し、作用直前と作用後にpermission・版・本文を再読して確認する。失敗時は自動再送／自動取消を行わず、公開状態が残る可能性を返す。

protocol／HDS-BRAIN／core／Gateway／channel-webchat buildはPASS。合成provider fixture 5件PASS。実provider／credential／Drive共有／served UI／全suite／QE_QC／QE_QAはNOT_RUN。これはF04.02の限定`WIRED` sliceであり、F04親成果・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。実装は[最新の施工状態](IMPLEMENTATION_INSTRUCTIONS.md)、詳細証拠は[実装履歴](IMPLEMENTATION_HISTORY.md)に記録する。次の独立作業はrev4.0と最新HEADから選定する。

### 前段完了BUILD_BATCH — F04.01 Google Docs本文を資料整理consumerへ接続

既存`google.drive.read`の単一exact file読取について、`text/plain` blobに加えGoogle Docs native document一種を`files.export`の`text/plain`で既存の一時資料整理consumerへ接続した。元ファイルのsizeとexport sizeを比較せず、実export bytesをconsumer上限12,000以内に制限する。読取前後のfile/version/revision/sharing state digestを照合し、strict UTF-8、SHA-256、untrusted-document境界、直接本文表示・書込みなしを維持する。Slides／Sheets等の他Workspace形式は未対応。

`pnpm --filter @blue-tanuki/core build`と`pnpm --filter @blue-tanuki/gateway... build`はPASS。`pnpm docs:check`はPASS（日本語基底の既存移行負債76件を注意表示）。最終記録の`git diff --check`もPASS。実Google credentials／資料／provider、LLM、外部作用、テスト、QE_QC／QE_QAはNOT_RUN。このF04.01限定consumerを`WIRED`とし、F04全体や製品全体完成へ拡張しない。owner指定の達成判定は既存J経路の明示規則＋同一revisionの検証済み結果＋M receiptを維持し、projectionの引用範囲状態から推定しない。

### 前段完了BUILD_BATCH — G04.03 macOS更新・復旧・削除

G04.03はrev4.0の`BT-R-G04-05`／`BT-R-G04-06`について、packaged `BlueTanukiSetup.sh`、macOS resident launcher／LaunchAgent、`BlueTanukiUninstall.sh`を介した更新失敗rollback、中断更新からの復旧、resident restart、permission-denial、ログ参照、通常削除後のDataRoot／ConfigRoot／runtime state／log保持、明示Purgeを隔離macOS環境で確認し、2026-11-11に限定BUILD_BATCHを閉じた。workflow_dispatch run `43005886593`（source SHA `f2dc2da5f66836960eff1a76c56bd6c31da57587`）でLinux、macOS arm64、macOS x64のconsumerが成功した。OS reboot、owner実機、署名／notary、実provider／credential、外部作用は`NOT_RUN`または保留である。

これはG04.03の限定`WIRED` consumerの閉包であり、G04全体、macOS対象QA、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOを成立させない。C08.02のowner明示規則＋同一revisionの検証済み結果＋M receiptは既存J/M経路に限定WIREDであり、重複実装しない。次の独立BUILD_BATCHは現行rev4.0とHEADから未接続consumerを選定する。D4-Pocket／ミニドラの別repo変更、C08.03実provider、Rust authority cutover、公開・出荷判断は引き続き保留する。

### 前段BUILD_BATCH記録 — G04.02 macOS署名・Gatekeeper保護境界

G04.01ではmacOS x64／arm64のone-file `.command` installerをnative runnerでbuild／verifyし、隔離導入・同梱Node起動・`/healthz`／`/app` HTTP 200・resident停止まで確認済み。G04.02はそのpackage consumerへ署名／notarization状態の事実記録とOS保護の読取確認を結ぶ。product manifestはinstaller code signatureがunsigned、builderはnotary serviceへ未提出と明示し、package verifierがOS対象に応じて検証する。native smokeは`codesign`でinstaller自体の状態を照合し、`spctl --status`でGatekeeper assessment enabledを導入前後に読み、設定を変更しない。resident autostartの既定disabledも確認する。

G04.02は固定source SHA=`13356da4c3af4d1230f89935177de4377c94a139`のGitHub Actions workflow_dispatch run [`42979799381`](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/42979799381)でLinux／macOS x64／arm64 jobがsuccess。x64／arm64ともinstallerはunsigned、builder notary submissionなし、Gatekeeper assessmentは前後enabledで不変。隔離導入、resident autostart disabled、bundled Node、`/healthz`／`/app` HTTP 200、resident停止、一時root cleanupを確認した。これはG04.02の限定`WIRED` consumerであり、G04.02全体、G04親成果、macOS QA、署名配布、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOを成立させない。未実施はnotary ticket確認、quarantined download/Finder起動QA、実provider／利用者secret、全suite。次consumerのG04.03へ接続した。C08.03実providerはBLUE本体の全体成立が先行するまで保留する。

### 前段BUILD_BATCH記録 — G02.03 Windows update失敗rollback・中断復旧・DataRoot保持

### 前段BUILD_BATCH記録 — G02.01・G02.02 Windows package Setupから通常利用へ接続

最新Windows Actions run `42952073483`（main SHA `07dbc1e4b68847280f459e1e94e8f6b55f37f7d4`）はworkspace／Windows package build・verifyと隔離installed smoke全体がPASSした。Windows Server 2022上でSetup／Repair、Gateway health／first-message、approval／audit tamper拒否、crash recovery、restart／safe-modeを通り、Uninstall wrapper exit 0、status `exit_code=0`、InstallRoot／DataRoot／registryの不在、path errorなしを同一runで確認した。`workflow_dispatch`／contents read-only、secret／artifact uploadなし。これは当該hosted BUILDの限定証拠で、clean Windows Desktop・全G02・5OS・QAへ拡張しない。

前段のlocal process ownership確認ではPID `17528`のworking directoryがrepo rootで、smoke installと異なるNode実行fileと一時state/session rootを使い、`--env-file`とsmoke root参照がないことを観測した。この観測に基づきLauncher process inventoryの誤所有判定を修正した。別Node／非Node command-line文字列は無視し、同一runtimeでDataRootが曖昧、絶対install entryを指す、process imageを確認できない場合はfail-closedを維持する。対象PowerShell fixture testは1件PASS／19件skip。これは前段時点の観測であり、その後のPID再利用や現在状態の主張には用いない。

先行run `42917086029`ではRust channel設定不正、run `42918832218`では`tar.exe`のZIP展開失敗を確認し、channel pinとsmoke extractorを修正した。run `42920784728`では修正後の展開とSetup／Repairまで実際に到達し、Gateway healthの実起動欠陥を新たに観測した。

run `42947306975`で確定した根因は、InstallRoot削除後に親CMDが削除済み`.cmd`へ復帰すること。同一CMD process内でwrapperを再入し、PowerShell完了／失敗後に`exit 0`／`exit 1`でprocess自体を終了する修正をmainへ反映した。Windows PowerShell 5.1 synthetic owned-install fixtureは成功status、InstallRoot削除、通常Uninstall時のDataRoot保持、exit 0、path errorなしでPASS。後続run `42952073483`のisolated installed smokeでもwrapper／status／InstallRoot／purge対象DataRoot／registry／path errorを同時確認してPASSした。既存のlocal HKCU uninstall registrationと保留中installは別consumerとして変更せず保持する。G02.01／G02.02の今回のinstalled consumerは限定的に`WIRED`。清浄な一般Windows環境、G02.03の更新・rollback・ユーザーデータ保持、5OS、全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、release／owner GOは未成立。次の実装consumerはowner指定に基づきC08.02の境界中断・復帰へ移る。

### 前段BUILD_BATCH記録 — F17.03 Owner Task依頼IDの状態照合と明示的な次task切替

Control CenterはOwner Taskの受付成功後も送信済みsubmission IDを保持し、Gateway受付記録とRuntimeの同一依頼ID planを照合する。ownerが状態を確認して明示操作するまで次回用IDへ切り替えず、未送信IDは保存status履歴／既定照会先へ入れない。達成判定はowner明示規則、同一revisionの検証済み結果、M receiptを満たした場合だけHDS-Jが行う。現変更はstatus識別子の保持であり、J評価・owner L3・実作用を代行しない。選択した`webchat.test.ts` 2件（127件skip）、WebChat build、`docs:check`（日本語基底の既存移行負債76件の注意あり）、`git diff --check`はPASS。実provider、実owner L3、file.write、full suite、5OS、QE_QC／QE_QAはNOT_RUN。

### 前段BUILD_BATCH — S-02 Unix外部ファイル所有保護の限定安全修正

Unix製品Setup／Launcher／Uninstallは、user-bin launcher、macOS application command／LaunchAgent、Linux desktop entryを生成物全体のbyte一致で判定する。Setupは一致するregular fileだけを採用し、不在時のno-clobber作成を行う。macOS LauncherとUninstallは実install root・親directory・非symlink条件を含めて照合し、変更済み・他者所有の対象を保持する。WSL Ubuntu 24.04 ext4の全Unix safety fixtureはPASS。native macOS／launchd／login／reboot、Linux native、5OS全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未確認。これは局所安全修正であり工程全体の完了を示さない。

### 先行BUILD_BATCH記録 — G03.03 Linux installed lifecycle・retained-state ownership（限定consumer）

Setupが保存する`state_root`をLinux product envへ渡し、Launcherが保持中DataRoot内のrootとして検証して`BLUE_TANUKI_STATE_ROOT`をexportする。旧schema-v1設定はsession directoryの親をstate rootへ互換推定する。schedule store、runtime health、recovery snapshot／factory resetは同一resolverを使用し、明示schedule directoryを維持しつつ既定状態をstate root配下へ置く。Node 22.14の未定義`DatabaseSync.isTransaction`をowner lease喪失と誤認した実導入時のruntime欠陥も是正した。通常Uninstallではsentinel／env／owner-state DBを保持し、再Setup後の保持、隔離rootへの明示Purgeを確認した。Linux autostartのexact-content ownership guardも共通Setup／Launcher／Uninstall consumerで維持する。

Gateway lifecycle focused tests 5 files／59 tests、Gateway build、product installer 5 tests、`validate:packaging`、`docs:check`、`git diff --check`はPASS。WSL Ubuntu 24.04 ext4でfrozen install、build、Linux package生成・2,653 entry検証、installed Setup／Launch／first message／Repair／autostart／Approval／audit／crash recovery／safe mode／state-root隔離／通常Uninstall保持／reinstall／明示Purgeを通した。さらにsynthetic updateのmove failure後に旧app／runtimeと保持データが戻ること、SetupをSIGKILLした後の次回Setupによる復旧・検証用更新、autostart Exec targetの直接起動後に新residentと保持状態が確認できることをPASS。smoke対象artifact SHA-256=`7bd19bc604c62b41a0da9fd9d453bffb7e018d2c78c852784735f65bf19ab262`。これは限定WSL BUILDでありnative Linux QAではない。実logout／login・reboot、native Linux、複数distribution、system service／Secret Service実接続、全suite、5OS、QE_QC／QE_QAは未確認。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。次はLinux desktopの実logout／loginまたはreboot後のautostart・resident ownership・状態継続を確認する。

### 前段完了BUILD_BATCH — G03.01 Linux package対象ABIと導入preflight

Linux package manifest schema 2にx86_64、vendor-supported glibc GNU/Linux、kernel 4.18以上、glibc 2.28以上、Node runtime、導入utility、秘密永続化時のSecret Service依存を固定する。macOS manifest schema 1は維持する。Setupはmanifestと一致するhost条件をファイル作成前に判定し、musl・非x64・古いkernel/libc・必須utility欠落ではfail-closedする。target-aware builderがLinux専用isolation helperを含むtar installerを生成し、Linux package verifierはそれを確認する。SetupはNode公式runtime内の既知`npm`／`npx`／`corepack` symlinkだけを安全に正規化し、ほかのsymlinkを引き続き拒否する。共通guardはLinux schema 2／x64とmacOS schema 1を区別し、部分stage cleanupをdirectory identityへ束縛した。

WSL Ubuntu 24.04 ext4上で生成したpackage verifierは2,649 entryを確認し、artifact SHA-256 `6e4d0f1186288022d33fe4e74a41506496d1ef0299a45a6cd56e2882b7742ed5`、size=45,949,718 bytes、source Git tree `e283f6eac81a4108c93c49872c6ee2c88c640a95`を記録した。同梱Node runtime SHA-256 `69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec`は公式SHASUMS256.txtと一致する。WSL隔離HOMEとNode／pnpm／Gitを除いたPATHでSetup・bundled Node・resident・loopback `/healthz`／`/app`・停止を確認した。さらにworkflow_dispatch run `42813081239`（source=`e642a6755f123d72ce785872f4fb8d9bcb4ef614`）はUbuntu 24.04 hosted runner（kernel `7.0.0-1017-azure`、glibc 2.39）でworkspace buildとpackage verification（2,649 entries）をPASSし、artifact SHA-256 `d9e81a678acec967defdf59ef4323c2804e44a7d136364380127fbe4be87cf44`、隔離Setup、bundled Node、env file mode 600、autostart disabled、loopback `/healthz`／`/app` HTTP 200、停止後の疎通断を確認した。初回runはharnessがruntime rootを先に作りSetupのsafe-target拒否を受けたため、harness修正後に同scopeを再実行した。両者は限定BUILD consumer evidenceで、対象distributionのQAではない。対象distribution通常利用、権限、service／Secret Service、更新／復旧、test suite、全OS、QE_QC／QE_QAは未確認。製品全体完成や5OS完成を主張しない。

### 前段完了BUILD_BATCH — G02.03 Windows製品Setup→Launcherのinstall/DataRoot束縛

Setupの一時stage内inventory格納先とmetadataに記録する最終install pathを分離し、Launcherが同梱safety helper、製品識別子、install path、DataRoot ownership markerを検証してからruntimeへ進むよう接続した。欠落・破損・不一致時は既定APPDATAへfallbackせずfail-closedする。通常起動はbounded markerとroot identityを検査し、Uninstallの既存全tree保護を維持する。既存Windows実行fixtureを新しい所有契約へ合わせた。test suite、実package Setup／Launcher／Uninstall／Purge／rollback、clean WindowsのNode/Git/pnpm非依存、全OS、QE_QC／QE_QAはNOT_RUN。source接続の限定WIREDであり、Windows導入E2E、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を証明しない。

### 前段完了安全修正BUILD_BATCH — Windows Uninstallの削除範囲を作用前に開示

Windows製品Uninstallは、安全なinstall／DataRoot所有検証の後、停止・削除前にresolved pathと予定作用を表示する。既定は登録済みDataRoot以下を全保持し、明示`-PurgeData`時は同root以下の全項目を完全削除してゴミ箱を経由しない。秘密値やファイル本文は表示しない。PowerShell parserと`git diff --check`はPASS。test suite、実installed product、保持／purge実行、registry／shortcut、実ユーザーデータはNOT_RUN／未変更。これは作用前開示の局所BUILDであり、Setup／Uninstall E2EやQE_QCの証拠ではない。

### 前段完了安全修正BUILD_BATCH — Windows Setup／Uninstallショートカット所有判定の完全一致化

Setupの既存ショートカット置換前とUninstallの削除前に、Launcherパスの部分文字列を含むだけで所有扱いする欠陥を修正した。共通guardがWindows PowerShellの実行先、生成済み固定引数、Launcher完全一致パスを照合する。PowerShell構文解析と`git diff --check`はPASS。テストsuite、実Setup／Uninstall、installed製品、実ユーザーデータは未実行・未変更。局所的安全修正であり製品E2EやQE_QCではない。

### 保留中BUILD_BATCH — F17.03 Canvas本文から親C・J・Brokerのsandbox作用・M receiptへ接続（限定WIRED）

WebChat Canvas本文をMIME／UTF-8／SHA-256／version／由来request IDに照合し、owner-authenticated taskから一回限り親Cへ渡す。child候補には本文を渡さず、session履歴に追加しない。C08.02で選択した明示達成規則を再利用し、Jの目的関係確認・plan review、sandbox内file.write、検証済みbytes数・M receiptが揃うと達成状態をGateway再起動後も復元する。file.write候補の本文・保存先は審査・復旧用にローカルJ Operation Plan SQLiteへ保存されることをUIで告知する。

Canvas対象testは4 files／6件PASS（151件skip）。Canvas owner意図→既存Tasks payload（artifact参照・委任目的・owner明示規則）は限定test 1件PASS（127件skip）、served GatewayのCanvas→synthetic C→J purpose／plan review→sandbox file.write→検証結果／M receiptは1件PASS（7件skip）。C08.02明示規則testは2件PASS（47件skip）。Gateway依存build（7 workspace projects）、`docs:check`（日本語基底移行負債76件の注意あり、license PASS）、`git diff --check`もPASS。追加のloopback-only隔離Gateway browser確認では、synthetic Canvasの生成応答（MIME=`text/html`、SHA-256=`da5ee2f82cc2ca286c0cb0a17fd018ad7772daafb52ef31f4416aaedc7ec8cfa`）をControl Centerのプレビューiframeへ実描画した。続いてserved Control Centerから、Canvas参照・owner意図・委任目的v2・明示規則1件を含むOwner Taskを合成Cへ送信し、目的版に束縛された単一`file.write`候補を確認した。候補は目的関係`unverified`／達成`held`／step未選択で作用不可。送信後に生成された次回用UUIDを誤って状態照会し`found=false`だったため、実送信IDの受付状態照合は未実施（受付不具合の証拠ではない）。実L3／file.write／M receiptの実UI経路、実provider／外部作用、全suite／5OS／installed製品／QE_QC／QE_QAはNOT_RUN。これらはserved backend／serialization／Canvas表示／Owner Task送信の限定`WIRED`証拠であり、F17.03全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。次はこの未承認planを既存Jの目的関係確認・plan step審査へ接続し、owner審査の境界を保ったsandbox作用と検証結果／M receiptへ進む。

### 前段完了BUILD_BATCH — E05.01 Setup管理FailureMemory・開発引継ぎの再起動永続化（限定WIRED）

Setupの`<base-dir>/failure-memory`をGateway FailureMemoryへ接続し、既存FILE/DIR優先と旧`SESSION_DIR`環境からの互換fallbackを一元解決する。FailureMemory verify CLI、DevelopmentHandoff、runtime health、Recovery snapshotも同じ実効pathを使う。handoffは`BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE`の明示時を除きFailureMemoryと同じdirectoryへ保存する。legacy session data rootからの合成restartでFailureMemory signatureとhandoffを再読込できることを確認した。保存は状態保持の接続であり、学習の妥当性・改善・汎化、HDS-Jの採否・権限を成立扱いしない。

Setup／設定round-trip／restart／Recoveryの対象test 7件PASS（46件skip）、Gateway依存7 project build PASS、`docs:check`／`git diff --check` PASS。日本語基底監査PASS（移行負債76件の注意）、license PASS。全suite、実provider、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。E05.01全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### 前段完了BUILD_BATCH — E05.01 M解釈依存の後続行為・結果receiptをOwner Taskへ接続（限定WIRED）

既存のOperation Plan memory interpretation dependencyを、実行元digest→検証済み行為→M receiptの非権威projectionへ接続した。現revisionのsource digest一致、唯一のverified binding、実結果または`github.write` accepted summary、delivery/result digest、result-memory commit／receipt、保存M値が揃う場合だけ`action_observed`とdigest/countを返す。依存なしは`not_referenced`、証拠不足・不一致は`unconfirmed`。Gatewayがshapeと固定状態をfail-closedで検査し、Control Centerは三状態を表示する。妥当性・改善・汎化は未評価のまま表示し、学習成立・因果・権限を主張しない。

限定検査：HDSの合成行為＋J/M receipt遷移、Gateway projection、Control Center表示の各test PASS（3件、同file内130件skip）。HDS依存buildとGateway依存7 project build PASS。`docs:check`／`git diff --check` PASS、日本語基底監査PASS（既存移行負債76件の注意）、license PASS。実Gateway往復、実provider／外部作用、installed製品、5OS、全suite、QE_QC／QE_QAはNOT_RUN。E05.01のこのslice以外、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`への拡張はない。

### 前段完了BUILD_BATCH — C08.02 J達成状態をOwner Task結果相関へ接続（限定WIRED）

HDS-Jは既にownerの明示達成規則、検証済みstep結果、M receiptを照合し、達成後に同一taskの計画継続を停止する。今回、その状態をControl CenterのOwner Task送信結果相関へ接続した。依頼ID digestで一意なplanを照合し、`achieved`は`goal_completion_rules_satisfied`、規則／証拠digest、`results_verified`、全step verified、M receipt確認が揃う場合だけ表示する。保留・進行中は別表示し、欠落・不整合は未確認とする。表示は実行権限、別task許可、公開／出荷判断を作らない。

WebChat相関の選択test 1件PASS（他122件skip）、channel-webchat依存3 project build PASS、`docs:check` PASS、日本語基底移行負債76件の注意継続、license PASS、`git diff --check` PASS。全workspace検査、実served owner task全往復、実provider／外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。C08.02判定の重複実装や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`への昇格はない。

### 前段完了BUILD_BATCH — E04.02 同一条件read-only履歴をFailureReviewへ接続（限定WIRED）

既存の`browser.read`／`gmail.read`成功履歴とfile scopeの`file.search`履歴を、FailureReviewへdigest-only観測として接続する。Complete History hash-chainが有効で署名baseline全件が同一の失敗tool callとして照合され、後続entryが同じoperation・action／goal input／actor・channelで成功した場合だけ候補にする。`browser.read`は固定schemaのbrowser provenanceも確認する。新しいHTTP／Google API要求を起こさず、本文・完全URL・path・query・links・メール本文・header・宛先・添付metadata・credentialをC/Jへ渡さない。projectionは限定digestとbrowser origin digest／redirect flag／evidence class／時刻だけを含み、原因やproviderの現在状態、外部条件解消、再開・実行権限の証明には使えない。

これはFailureReview producer/consumerの限定`WIRED` sliceであり、file.searchの既存sliceと合わせてもE04.02全体ではない。Gateway依存7 projectのbuild／typecheck、`docs:check`、`git diff --check`はPASS。日本語基底の既存移行負債76件に注意。test suite、実FailureReview往復、実browser/HTTP/provider、外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。C08.02の明示owner規則・検証済み根拠・M receiptによる達成判定は既存実装を維持する。

### 前段完了BUILD_BATCH — D03.01 D4 Runtimeのsession-scoped intent／response transport（限定WIRED）

Blue Gatewayの専用Runtime credentialで、登録済みruntime IDとsession参照を検証し、sessionをHMAC digest scopeへ変換して単回WebSocket ticketを発行する。ticketで同じsession scopeへ接続した場合だけintentをHDSへ渡し、HDSの既存`channel_send`を同じscopeへ返す。応答経路が未接続なら`409 not_dispatched`でHDS handlerを呼ばない。HTTP `202`は入力受付だけを示す。

この状態はBlue側transportの限定`WIRED`。D4 Runtime側producer／receiver、runtime/session/workspace登録の実結合、切断・再起動後の復帰は未接続であり、D03.01全体・D4接続・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。直近の確認記録は[`開発進捗.md`](開発進捗.md)と[`IMPLEMENTATION_INSTRUCTIONS.md`](IMPLEMENTATION_INSTRUCTIONS.md)を参照する。C08.02の達成判定はowner明示規則・検証済み結果・M receiptを使う既存J経路を確認済みのため重複実装しない。D4 Pocketの他writer差分はそのrepoで保持し、このrepoから変更しない。

### 前段BUILD_BATCH — E04.03 FailureMemory条件変化の再評価を承認・実行consumerへ接続（限定WIRED）

FailureMemory gateの初回判定digestと元の実行主体をprocess-local pending approvalへ束縛する。Ownerの承認再開時に同じcommand／contextを再評価し、gateが変化・block・取得不能ならpendingを取消して新規要求を求める。承認後もExecutorの`before_execute`とtool dispatch直前で同じgateを再評価し、digest不一致を検出した場合は作用前に停止する。gate由来の承認から再利用可能なgrantを作らず、前のFailureMemory署名を変更・削除・置換しない。条件変化が観測された場合は承認要求にgoal／actor／channelのdigest差分次元を表示し、古い承認を再利用しない。

このgateは現在のHDS ASSERTに含まれるgoal／actor／channelの条件fingerprintを再評価する。外部環境の根因が実際に解消したことを独立証明するものではない。該当する承認・executor境界のコード接続だけを限定`WIRED`とし、E04.03全体・実行時作用・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

Gateway依存7 workspace project build、`docs:check`、`git diff --check`はPASS。日本語基底監査はPASS（既存移行負債76件の注意）、license監査はPASS。test suite、実served Gateway／owner approval往復、実FailureMemory状態変化、実外部作用、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。C08.02の達成評価については、owner明示規則のdigest・一意なstep・検証済み結果・M receiptを結んだ既存J評価を現行コードで確認し、追加の重複実装は行わない。

### 前段完了BUILD_BATCH — E03.03 Recoveryのtask lineage復元scopeをControl Centerへ接続（限定WIRED）

Control Centerにbackup内scope照合とは分離した復元effect scopeを追加した。Operation Planは一planまたはHDS-J task lineage、Brokerはstore全体またはtask lineage、その他のstoreは選択store全体を選ぶ。task照合projectionはbackup task identity、複数plan digest、lineage integrity／dependency状態を表示するが、復旧可否・権限・resumeを判定しない。GatewayはOperation Plan scopeとBroker task scopeをL3要求作成前に同じbackup／task scope verifierへ通し、既存の復元作用直前照合を維持する。L3承認、実行直前backup、store間非原子性、automatic resumeなしを維持する。

Gateway依存7 workspace projectのbuild、WebChat build、生成Control Center scriptの構文解析、`git diff --check`はPASS。test suite、served Gatewayでのowner L3全往復、実backup／復元、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このControl Center→Gateway接続のコード経路だけを限定`WIRED`とし、E03.03全体または製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

### 前段完了BUILD_BATCH — F06.02 検証済みbrowser.read結果を同一taskの次回C計算へ接続（限定WIRED）

Ownerが明示選択した同一taskの検証済み`browser.read`結果を、J/M receipt・現行plan binding・record内容・excerpt digest・10分期限で再照合後、Cの次回計画候補だけへ渡す。最大8,000文字の非信頼excerptはsystem指示と分けたuser-role data messageへ置き、Owner依頼より前に配置する。子C delegationは無効。完全URL/path/query、links、credential、raw本文はruntime snapshotへ公開しない。Control Centerはorigin・digest・文字数・期限のみを表示し、このC計算からのmeaning-update提案を無効にする。

Workspace `typecheck`、15 project `build`、`docs:check`、`git diff --check`はPASS。日本語基底監査は移行負債76件の注意を継続する。test suite、実browser/HTTP、実provider、owner UI全往復、外部作用、他OS、QE_QC／QE_QAはNOT_RUN。これは同一task browser-read context経路のみの限定WIREDであり、browser mutationや製品全体の完成を示さない。

### 前段完了BUILD_BATCH — F06.01 browser観測provenanceの読取consumer接続（限定WIRED）

`browser.read`と`browser.snapshot`が、ページ内容を非権威の外部証拠として扱うための観測metadataを返す。要求／最終origin、origin変更、観測時刻、navigation、証拠源、資格情報境界を記録し、HTTPのtab/frame非該当とsnapshotの一時tab／main frameを区別する。内容は`page_content_is_untrusted=true`、`used_for_authority=false`、`may_execute=false`を明示する。

snapshotの最終URLも結果返却前に既存public-address／allowlist検査へ通す。既定無効、ephemeral profile、download無効、click／submit等のpreview quarantineは維持する。core typecheck／build、`docs:check`、`git diff --check`はPASS。test suite、実HTTP／browser、実provider／外部作用、他OS、QE_QC／QE_QAはNOT_RUN。これは読取provenanceの限定WIREDのみで、effect target束縛、F06.01全体、製品全体完成を示さない。

### 前段完了BUILD_BATCH — F20.01 隔離file-search workerへHDS記憶境界を継承（限定WIRED）

Gatewayの親工程が作るtarget observationと専用childの検索対象を同一化するため、worker環境へは実効HDS memory fileのabsolute pathだけを渡す。credentialや親の全environmentは継承しない。`BLUE_TANUKI_MEMORY_FILE`優先と`BLUE_TANUKI_MEMORY_DIR/memory.jsonl` fallbackの双方を子process疎通で通し、M本体・`.personalization.jsonl`停止台帳が検索結果に現れず、通常sandbox file検索は成功することを確認する。

このchild経由のM境界sliceだけを限定`WIRED`とする。Gateway/workspace依存のbuild/typecheckと専用workerのfixture疎通を実施し、全suite・実served Gateway・実ユーザーデータ・他OS・QE_QC／QE_QAはNOT_RUN。F20.01／F20全体、製品全体の完成へ拡張しない。F20の物理消去・保存契約終了・backup処遇は未実装・未実行。

### 前段完了BUILD_BATCH — F20.01 設定済みHDS記憶を通常file経路から隔離（限定WIRED）

設定済み`BLUE_TANUKI_MEMORY_FILE`または`BLUE_TANUKI_MEMORY_DIR/memory.jsonl`と、その`.personalization.jsonl`台帳を通常のsandbox file経路から分離した。`file.search`の直接指定・列挙、`file.write`、`file.edit`、`file.delete`は、設定パス・canonical path・実file identity（hard linkを含む）で保護対象と一致すれば拒否する。停止済みMの直接検索迂回と、一般削除経路によるM／停止台帳の消去を防ぐ。通常ファイルの操作、HDS自身のM read/write、既存の停止台帳処理は維持する。物理消去・保存契約終了・backup/cache/remote copy/鍵処遇は未実装・未実行。`OD-04`はrev4.0本文でRust cutoverを示す一方、施工単位の旧原文詳細で物理削除の決定IDとして重複参照されるため、この変更ではIDに基づく消去許可を推測していない。

core typecheck/buildとsandbox内hard linkを含むbuilt-in境界検査1件はPASS（同file testの他99件はskip）。実served Gateway、全suite、他OS、QE_QC／QE_QAはNOT_RUN。このfile経路保護sliceだけを限定`WIRED`とし、F20全体や製品全体の完成へ拡張しない。

### 前段完了BUILD_BATCH — F20.02 記憶引用・個人化利用の停止をHDS/M経路へ接続（限定WIRED）

ownerが明示した一件のM記録に対し、`memory.personalization.stop`をCの計画候補→Jの正確なtarget/revision照合→登録済みExecutor adapter→settings.write／high／L3 no-store確認→作用直前の再照合→停止台帳追記→後続HDS memory trace除外へ接続した。M履歴は保持し、該当する既存参照版を失効し、停止台帳revisionを次回検索scopeへ反映する。不正な台帳はfail-closed。物理削除・保存契約終了はこの作用に含めない。

最初の疎通は対象resolver未登録でFAILとなり、接続を追加して同じ疎通を再実行した結果PASS。`pnpm typecheck`、15 workspace `pnpm build`、LongTermMemoryStore 21件、built-in tool 2件、HDS→Executor OperationPlan疎通1件、`pnpm docs:check`、`git diff --check`はPASS。合成L3 reviewと監査を確認。実served Gateway HTTP承認、実ブラウザー／provider、外部作用、installed製品、5OS、full suite、QE_QC／QE_QAはNOT_RUN。F20.02の限定`WIRED`だけを記録し、F20全体／製品全体の完成へ拡張しない。Git fetch時の旧worktree候補へのアクセス拒否は保持・未処置、GitHub mainは読取専用`ls-remote`で開始SHA一致を確認。

### 前段完了BUILD_BATCH — C08.02 wait再開へ保存済みowner達成規則の参照を継承（限定WIRED）

wait返信・期限到達・中断復旧の再開時に、検証済みJ wait contextから同一taskの達成規則digest・件数・元request参照だけをGoalProjectionへ渡す。規則本文は渡さず、返信／metadataによる規則差し替えを受け付けない。policyのtask identity・goal digest・規則digestが不整合ならwait再開を保留する。GoalProjectionは非権威の`identifying`状態を保ち、J達成条件は検証済み実行結果とM receiptのまま。

HDS-BRAIN build、Gateway typecheck、`operation_plan_runtime.test.ts`のwait返信／期限／復旧を通す2ケース（46件skip）、`pnpm docs:check`、`git diff --check`はPASS。日本語基底監査はPASSで既存移行負債76件の注意を表示した。full suite、実provider／live外部作用、Control Center browser、installed製品、5OS、QE_QC／QE_QAはNOT_RUN。このwait再開sliceだけを`WIRED`とし、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### 前段完了BUILD_BATCH — C08.02 owner規則のGoalProjection→J/M digest結合（限定WIRED）

内部認証されたowner規則をGoalProjectionへ本文なしの`referenced`（digest・件数・source ref）として投影し、規則digestをJのOperationPlan policyと共通化した。projectionは引き続き`identifying`で、execution authorityや達成判定を持たない。外部metadataは規則参照を発行できない。J/M側は既存どおり各規則を検証済み結果とM receiptで満たした場合のみ達成する。

protocol／HDS projection test 9件とGateway OperationPlan test 2件（46件skip）、protocol／HDS typecheck・build、Gateway typecheck、`docs:check`、`git diff --check`はPASS。日本語基底監査はPASSで、既存移行負債76件の注意を表示した。実provider／live外部作用、Control Center browser、installed製品、5OS、全suite、QE_QC／QE_QAはこのsliceではNOT_RUN。GoalProjection digest参照接続だけを`WIRED`とし、製品全体の完成状態へ拡張しない。

### 前段完了BUILD_BATCH — C08.02 owner規則からserved GatewayのJ/M達成状態復元まで（限定WIRED）

owner-token付き`/owner/task-compute`からbounded JSON達成規則を受け取り、実served Gateway processのHDS C/J/M経路へ接続した。規則欠落ではverified file.search結果とM receiptがあっても保留し、合致する規則ではJが規則digest／根拠digestを持つ達成sealを作成する。別のHDS runtime caseでは期待値不一致を保留し、達成sealを作らない。owner trustなしの入力、曖昧対象、未検証結果、M receipt／保存値不一致は達成条件にしない。外部channelは規則欄を保持せず、規則は権限を付与しない。

served Gateway testでは認証済み`/runtime/snapshot`からachieved projectionを確認し、Gateway再起動後もtask identityと達成状態が復元されることを検証した。直接HDS runtime testで、再起動後の同一step reviewが拒否されることを確認した。`document_organization_entry.test.ts` 1 passed／6 skipped、`operation_plan_runtime.test.ts` 2 passed／46 skipped、`pnpm docs:check`と`git diff --check`はPASS（日本語基底の既存移行負債76件の注意あり）。隔離synthetic backendと一時file rootに限る。Control Center browser全往復、実provider／外部作用、installed製品、5OS、full suite、QE_QC／QE_QAはNOT_RUN。このC08.02 sliceだけを`WIRED`とし、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。次はrev4.0と現行HEADから、実providerや公開作用に依存しないQE_BUILD consumerを選定する。

### 前段完了BUILD_BATCH — Gateway再起動後も同一taskのtest失敗回復をOwnerへ接続（限定WIRED）

前段の合成失敗回復を拡張し、exit code 23のsummaryと`receipt_confirmed`のM bindingを保存した後にGatewayを再起動する。再起動後、同じplan／revision／task identityと失敗結果を復元し、変更済みfileを自動復旧せず、再接続したOwnerから同一path検索・結果確認・同一task／目的bindingの逆編集候補へ進み、別個のno-store内容確認とL3承認後にだけ逆編集、再検索を行うことを隔離Gateway testで確認した。Control Centerはcurrent purpose bindingと有効なfile.search receiptがある場合に限って回復候補ボタンを示し、操作は`plan:compute`へ束縛される。対象Gateway test 2 passed／5 skipped、WebChat renderer／action test 2 passed／116 skipped。実provider／外部作用、実製品全suite、timeout／異常process、installed製品、5OS、全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAはNOT_RUN。このrestart回復sliceだけを限定`WIRED`とする。

### 前段完了BUILD_BATCH — Windows UninstallのDataRoot所有を削除直前に再確認（限定コード接続）

`-PurgeData`は開始時だけでなく、installed app・ショートカット・Uninstall登録を削除した後、DataRootの再帰削除直前にも所有マーカーとパス構造を再検証する。再検証に失敗した場合はDataRootを保持して終了し、app側はすでに除去されている可能性を報告する。PowerShell parser、`docs:check`、`git diff --check`はPASS。test、installed Uninstall、DataRoot差替え時の動作はNOT_RUN。この削除境界だけをコード接続済みとし、Windows lifecycleや製品全体の成立へ拡張しない。

### 前段完了BUILD_BATCH — Windows製品Setupの常駐停止失敗をfail-closed化（限定WIRED）

Windows product Setupが既存Launcherの停止失敗を無視して更新を続行し得る欠陥を修正した。非0／例外時は既存installのswap、DataRoot／config Setup、installed doctorより前に停止する。停止後はmanaged inventoryを再照合してから共有状態へ進む。停止をexit 23にした隔離fixtureで既存launcher保持と拒否を確認。対象test 1 passed／18 skipped、workspace typecheck、PowerShell parser、15 workspace build、`docs:check`、`git diff --check`はPASS。実installed Setup／Uninstall・registry／Start Menu・実ユーザーデータ・5OS・全suite・QE_QC／QE_QAはNOT_RUN。このWindows停止失敗境界だけを`WIRED`とし、製品全体の完成やSetup／Uninstall実物の安全確認へ拡張しない。

### 前段完了BUILD_BATCH — Unix packaged Setupの更新中断後再起動復旧（限定WIRED）

共通packaged `BlueTanukiSetup.sh`が、同一install parentのrollback app/runtime siblingを正確に列挙し、一意性・owner marker・package metadata・managed inventory・Node path・root bindingを検証する。active new installが見つかる停止点ではactive app/runtimeも全inventoryで検証し、resident-stop後に両側を再検証する。検証済みの旧install/runtimeをactive rootへ復帰させ、active new側の検証済み部分はhidden interrupted siblingへ保全する。DataRoot・ConfigRoot・user data・env fileを削除・上書きしない。複数候補、未対runtime、曖昧・改変・symlink、env rollback backupが残る状態は自動変更せずfail-closedする。

WSL Ubuntu 24.04 ext4上の隔離fixtureで、旧app退避後・新app配置後・新runtime配置後の強制プロセス終了から次回Setupの復旧を確認した。resident-stop拒否時の無変更、user data／env hash保持、新側partialの保全、複数候補の保持・拒否も検証した。対象shell `sh -n`、Windows installer test 4/4、workspace typecheck、15 project build、`docs:check`、`git diff --check`はPASS。Linux native／macOS installed product、実機再起動・更新、全suite、QE_QC／QE_QAはNOT_RUN。限定fixture経路を`WIRED`とし、実installed製品やOS全体を保証しない。

### 前段完了BUILD_BATCH — Linux/macOS製品Setup・Uninstallの常駐process所有確認（限定WIRED）

Linux/macOS packaged product Launcherは、数値PIDだけを停止根拠にせず、PID recordの形式とinstalled Node／Gateway entry／`--serve`／同一install env fileを照合する。watchdogはinstalled Launcher pathと専用`resident-watchdog` commandで同定する。欠落・stale recordはinventoryから一意な同一install processを復元できる場合だけ扱い、異常形式・曖昧・複数候補・inventory失敗はfail-closedする。最大10秒の停止待ちと再走査でresident／watchdogの不存在が確認できるまで、PID recordとstop markerを残す。Setup update／Uninstallは停止失敗時にswapまたはinstall tree削除を中断する。Uninstallの無条件autostart削除を除き、既存ownership-checked removalへ委ねる。runtime inventory hashをJSON最終propertyとして受け付ける。

WSL Ubuntu 24.04の隔離process fixture（install path内の複数連続空白を含む）と対象shell構文検査、Windows上の対象test 4/4、workspace typecheck、build 15 projects、`docs:check`、`git diff --check`はPASS。実macOS、実installed Setup／Uninstall、実製品更新・削除、全suite、QE_QC／QE_QAはNOT_RUN。このUnix packaged product-pathだけを限定`WIRED`とし、OS全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。

### 前段完了BUILD_BATCH — G02.02・G02.03 Windows常駐process所有確認と削除停止境界（限定WIRED）

Windows製品LauncherがPID fileだけを根拠に他processを停止しないよう、bundled `node.exe`／installed `BlueTanukiLauncher.ps1`とlaunch arguments／Gateway entry／DataRoot env fileを照合する。PID recordが欠落・staleなら同一installのprocess inventoryを調べ、一件だけ一致すれば記録を復旧または停止する。record不正・判別不能・複数candidateはfail-closedする。所有確認したprocessだけを停止し、最大10秒のexit確認と残存processなしを確認後にrecordを消す。Uninstallも停止が確認できない限りinstall treeの削除へ進まない。既存のuser data保持／明示purge境界は維持する。

全workspace typecheck、15 project build、Windows installer対象test 18件、PowerShell parser、`git diff --check`がPASS。隔離fixtureのprocess境界までを限定`WIRED`とする。実installed Setup／Uninstall、registry／Start Menu、実package更新、他OS、全suite、QE_QC／QE_QAはNOT_RUN。G02の全体E2E、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へは拡張しない。

### 前段完了BUILD_BATCH — G02.03 Windows更新中断からの所有済みinstall復旧（限定WIRED）

Windows製品Setupは、active install rootが無い場合に限り、同一parent内の正確なGUID形式rollback候補を確認する。候補の一意性、managed metadata、package manifest、全file inventory、data-root binding、reparse不在を照合し、一件だけ一致すれば同じparentへ復旧して再検査後にpackaged updateを続行する。複数・不正・未所有候補は保持してfail-closedする。既存install、DataRoot、user dataはこの復旧sliceでは変更しない。

Windows隔離PowerShell fixtureの2 testとinstaller packageの14 testはPASS。実ユーザーprofile、registry／Start Menu、実package更新／削除、installed runtime、他OS、全suite、QE_QC／QE_QAはNOT_RUN。G02.03の復旧sliceだけを`WIRED`とし、Windows lifecycle全体や製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`へ拡張しない。復旧処理はinstall treeだけを戻し、DataRootとuser dataは触れない。検証後、Setupは既存の通常update transactionを続ける。次はrev4.0と現物から一気通貫の仕事経路に不足するconsumerを再選定する。

### 前段完了BUILD_BATCH — F05.02 GitHubの単一新規ファイルcode.push（限定WIRED）

既存`github.write`を、non-default branch上の単一新規UTF-8 file（65,536 bytes以下）に限る`code.push`へ接続した。target branchの現在HEAD・既定branch・repository identity・file不存在を観測し、L3 no-store reviewにbranch／expected HEAD／path／commit message／正確な本文・サイズ・digest・可視性と通知可能性を固定する。作用前に再観測し、GitHub GraphQL `createCommitOnBranch`へ`expectedHeadOid`と一件の`FileAddition`を送る。結果はparent・ref・commit SHAとbranch再読取で照合し、明示拒否・結果不明・受理を区別してJ/MとOwner照会へつなぐ。失敗後に自動再送しない。Control Centerは本文を未信頼text nodeとして表示する。専用`github:code.write` capabilityを追加した。

`corepack pnpm typecheck`／全workspace build（15 projects）／`git diff --check`はPASS。5ファイルの選択合成testは8 passed／309 skipped。Gateway `--serve` process、実GitHub／credential／外部作用、owner browser、全suite、他OS、QE_QC／QE_QAはNOT_RUN。実GitHubへは送信していない。このcode.push経路だけを限定`WIRED`とし、F05.02全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、公開／出荷GOへ拡張しない。

次はrev4.0と最新実物から、一気通貫の仕事経路に最も不足する次consumerを選び、QE_BUILDを続ける。実provider送信、live外部作用、別repo編集、Rust authority cutover、公開・出荷判断は保留する。

### 前段完了BUILD_BATCH — 親planのM解釈依存を子planへ継承（限定WIRED）

親OperationPlanの現行性確認からJ/M memory interpretation dependencyを返し、`plan:compute`のC入力・候補保持まで継承する。source citationと親由来依存の統合は同一judgmentの一致を検査し、重複・競合・上限超過・再評価要求・現在性不明を拒否する。Mは非権威のまま。対象test 4件、protocol build、HDS-BRAIN typecheck／build、`hds:standalone`がPASS。Gateway親→子plan runtime経路、全workspace suite、実provider／外部作用、5OS、QE_QC／QE_QAは未確認。C04.03／D01.03のコード接続だけを限定`WIRED`とする。

次はrev4.0全体と現物から、全体接続に最も不足するconsumerを再選定する。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

### 前段完了BUILD_BATCH — C/J/M cited-memory dependency source binding（限定WIRED）

`OperationPlanLedger`のM解釈依存一覧を、選択済みstepのexecution source digestへ束縛する。依存付きplanはv2 digestに依存一覧digestを含み、依存なしplanのv1形式は維持する。既存のactive interpretation／J judgment再確認はそのまま残る。これは出所束縛の接続であり、Mを権限化せず、意味適合・J採否・外部作用を保証しない。既存v1の依存付きpending bindingはfail-closedし再bindを要する。

異なる有効M依存集合を持つotherwise-identical planのsource digest分離と、J再評価要求後の拒否を確認した。対象test 2 passed、HDS-BRAIN typecheck／build、`hds:standalone`、`corepack pnpm docs:check`、`git diff --check`はPASS。全workspace suite、Gateway process、実provider／credential、外部作用、5OS、QE_QC／QE_QAはNOT_RUN。この限定sliceだけを`WIRED`とする。次はF05.02に残る実producer／consumer gapを現物から選び、残差がなければ工程表に沿う次のC/J/M E2E consumerへ進む。

### 前回の完了BUILD_BATCH — F05.02 cross-repository fork-head PR create（限定WIRED）

#### 現在の施工状態 — 2026-11-09

既存`github.write pr.create`を拡張し、Ownerが`head_repository`を明示した場合に限り、base／head両repositoryがallowlist内で、headがbaseと同じGitHub fork networkに属するforkならcross-repository PRを作成できる経路を、既存Operation Plan／HDS J／no-store L3／Approval Gate／Broker／Executor／receipt／M／Owner結果照会へ接続した。両repositoryの数値ID・canonical name・可視性・fork network root、head/base branch refとcommit SHAを観測し、target／payload digest、計画、承認画面、作用直前再観測、応答照合へ束縛する。Control Centerはbase/head・各可視性・network・ref/SHA、通知可能性、read/writeの非原子性、PR作成の非可逆性を表示する。送信はcross-repository時のみGitHub APIの`head=owner:branch`／`head_repo=repo`形式を用い、同一repository時の既存形式を維持する。結果不明は自動再送しない。

同一repository回帰を含む合成検査とtest-owned loopback Gateway processだけで確認した。`corepack pnpm typecheck`／全workspace `corepack pnpm build`（15 project）はPASS。`tools_builtin.test.ts -t "github.write pr.create"`は3 passed／94 skipped、`executor_approval_content.test.ts -t "GitHub pr.create"`は1 passed／16 skipped、Gateway `execution_result_reconciliation.test.ts -t "pr.create"`は4 passed／75 skipped。実GitHub・実資格情報・外部作用はNOT_RUN。processで確認したのは受理経路で、拒否／結果不明はin-process検査の範囲に限る。

cross-repository fork-head `pr.create`のこの経路を限定`WIRED`とする。F05.02の他の残差、F05全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、5OS、owner GOへ昇格しない。次は現行実装からF05.02の残るproducer／consumer gapを選び、実provider・live外部作用を追加しない。

### 前回の完了BUILD_BATCH — F05.02 PR diff範囲review comment consumer（限定WIRED）

#### 当時の施工状態 — 2026-11-08

既存5操作（`issue.create`、`issue.update`、`issue.comment.create`、`pr.create`、`pr.comment.create`）の合成受理・明示拒否・結果不明15件と、built Gateway `--serve` process受理5経路は直前のBUILD_BATCHで確認済み。今回、既存`pr.comment.create`へ複数行`pull_request_review_inline`を追加し、開始・終点のpath／line／side、PR head/base SHA、bounded patch digest／excerptをtarget version・request digest・Operation Plan・no-store L3 reviewへ束縛した。両端は同一unified-diff hunkの一意な実行行で、diff順序が正しい場合のみ許可する。LEFT／RIGHTは独立座標として扱い、数値降順でもdiff順が正しければ有効。選択excerptが4,096文字を超える場合は作用前に拒否する。Review後と作用直前にPR・diffを再観測し、同一head commitを指定して単回POSTする。従来のtimeline／単一行variantは維持する。inline各形態の合成in-process受理・明示拒否・結果不明6件とbuilt Gateway process accepted 2経路がPASSし、process fixtureはtest-owned loopback以外の外向き通信を遮断した。本文やtokenはM／audit／history／session／process出力へ残らず、保存結果は再送しない。core関連testは107 passed／6 skipped、Gateway選択testは8 passed／71 skipped、WebChat script testは1 passed／114 skipped。`corepack pnpm build`（15 workspace projects）、`corepack pnpm typecheck`、`pnpm docs:check`、`git diff --check`はPASS。実GitHub／実資格情報／外部作用は未実施。rangeを含む`pr.comment.create`だけ合成範囲で`WIRED`とする。

2026-11-08時点のwrite pathは`issue.create`、既存Issueのtitle/body限定`issue.update`、`issue.comment.create`、同一repository内の`pr.create`、`pr.comment.create`のtimeline／単一行inline／複数行inlineをOperation Plan・target-version・no-store L3 content review・Executor/Brokerへ接続していた。inlineは安全な相対path、同一hunk内の順序づけ可能な行範囲、LEFT／RIGHT sideに限定し、差分excerptは未信頼表示としてtext nodeへ出す。合成Gateway processでinline単一行・rangeのacceptedを確認したが、process拒否／結果不明は未確認であった。別repository headの`pr.create`はこの時点では未成立の`BUILD_GAP`だった。F05全体、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、5OS、owner GOへ昇格していない。

### 保留を維持する健全化残件 — 2026-11-07 follow-up D

2026-11-05の一回限りのリポジトリ健全化は対象commit `1603a10f0f7433a2481d7bc1a79e1f744fb8c633`で実装・検証を完了した。追加健全化はA〜Cを限定条件で検証済み、DのWindows製品Setup→Uninstall動的試験は`NOT_RUN`で保留する。詳細は先頭の[`開発進捗.md`](開発進捗.md)を参照する。以下の日付付きBUILD_BATCH記録は当時の開発履歴であり、現在の施工対象を定めない。

2026-11-01、Control CenterのWebSocket再接続枠を成功接続ごとに回復するよう修正した。再接続成功後に失敗回数を0へ戻し、自動再接続であることは接続試行のローカル値で保つ。taskの再送・切断中frameの再配送は行わない。channel-webchat typecheck／build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。browser／Gateway process確認はNOT_RUN、STATUS=WIRED（静的接続、実接続未確認）。

2026-11-01、Gateway再起動後の同一plan `plan:result` consumerへverified `file.write`／`file.delete`保存結果のdigest／M receipt束縛要約を追加した。writeは相対path・byte数のみ、deleteは相対path・削除時点の報告のみを返し、本文・sandbox絶対root・現在状態を返さず再実行もしない。HDS-BRAIN／Gateway typecheck・build、`pnpm docs:check`、`git diff --check`はPASS。process／browser／test suiteはNOT_RUNで、STATUS=WIRED（コード接続、runtime未確認）。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

2026-11-01、F01.01のOwner指定`file.edit`候補に完全一致する置換数（1〜100、初期値1）を通した。Owner入力、synthetic C parser、Operation Plan parameters／validationを結び、実一致数の不一致は既存toolの実行前照合で拒否する。従来の置換数なしtaskは1として扱う。core／channel-webchat typecheck・build、生成Control Center script構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／browser／Gateway runtime／実provider／外部作用はNOT_RUN。STATUS=WIRED（静的接続、runtime未確認）。

2026-11-01、Control Centerの保存結果consumerをverified `file.write`／`file.delete`にも表示するよう接続した。既存のowner再認証・plan/revision/step・verified binding・receipt確認条件を維持し、writeは本文／現在状態を返さず、deleteは削除時点の報告として表示する。channel-webchat typecheck／build、生成Control Center script構文解析、`git diff --check`はPASS。test／browser runtimeはNOT_RUN。STATUS=WIRED（UI接続、owner画面での実操作未確認）。

2026-11-01、保存済み`file.search`結果のowner入口を、条件に応じた最大5行`file.read` previewも含む表示に合わせた。全内容・検索完全性・現在状態を示さないことを案内。channel-webchat typecheck／build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。runtime／browser／test suiteはNOT_RUN。

2026-11-01、単一fileのbounded `file.read` previewに開始行指定を接続した。exact sandbox相対pathと空queryの組合せに限定し、開始行は1〜1,000,000、返却は最大5行のまま。候補の開始行をOperation Plan validationへ結び、返却行番号の連続性を照合する。保存済みOwner結果にも開始行を表示し、既存のroot／file version確認、Approval／Broker、M receipt、非権威projectionを維持する。実装初回のworkspace `pnpm typecheck`／`pnpm build`はPASS。controller promptの最終追記後はHDS no-emit typecheck／package build、`pnpm docs:check`、`git diff --check`がPASS。workspace typecheck再実行は`apps/gateway/dist/active_task_execution_registry.js`の削除時`EBUSY`でclean段階停止。test／Gateway process／browser／provider／外部作用はNOT_RUN。STATUS=WIRED（型・build・実consumer接続の静的確認）、runtime未確認。F01.01、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。

## 最後に記録されたBUILD_BATCH — F02.02 Gmail添付identityからcontent-bound draft.create

OwnerがUIで明示選択した、期限内の`gmail.read view=attachment_identity`結果だけをsourceにする。message／attachment／part identity・filename・MIME・size・SHA-256を厳密再照合し、最大5 MiBの添付bytesはprocess memoryだけで取得する。C、plan、command、履歴、audit、Control Center projectionにはbytesを渡さず、no-store L3 reviewへ宛先・件名・本文とfilename／MIME／size／SHA-256を表示する。HDSは選択結果を同一task／plan／revisionへ再照合し、添付一件のidentity・content hashが完全一致する未実行`gmail.write draft.create`候補だけを受理する。添付付き`message.send`／`draft.send`、Owner選択なし、別添付、内容からの目的・宛先・権限推定は拒否する。

Review時と作用直前にsource bytesを再取得し、metadata・size・SHA-256の変化、欠損、期限切れ、重複、上限超過、plan／command不一致はfail-closedにする。Protocol／HDS-BRAIN／core／WebChat／Gatewayのworkspace typecheckと全workspace buildはPASS。最終Control Center修正後のWebChat依存buildと生成script構文、`pnpm docs:check`、`git diff --check`もPASS。test suite／Gateway process／browser／provider／資格情報／外部作用はNOT_RUN。STATUS=`WIRED`（コード接続、runtime未確認）。F02.02全体、実provider、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。

## 前回BUILD_BATCH — F04.02 Drive所有ファイルの可逆ゴミ箱移動

2026-11-02、`google.drive.write/file.trash`を既存HDS Operation Plan／Executor Broker／Gateway承認／Control Centerへ接続した。Owner taskに明示された個人My Drive内の単一`file_id`に限定し、認証中アカウント所有、未trash、`text/plain`を必須にする。実行は`PATCH trashed=true`による復元可能なゴミ箱移動で、`files.delete`による完全削除は行わない。共有ドライブ、Workspace native document、folder、binary、非所有・曖昧・未取得の対象は拒否する。全workspace typecheck/build、`pnpm docs:check`、build済みControl Center script構文、`git diff --check`はPASS。test suite／Gateway process／browser／provider／資格情報／外部作用はNOT_RUN。STATUS=`WIRED`（runtime未確認）。

対象metadataと取得可能なpermission scopeを複数回読み、file state／scope／payload／command／Plan bindingのdigestをtarget-versionへ結合する。Operation PlanとApproval Gateでhigh/L3を要求し、no-store画面に対象、所有者、保存先、全取得permission scope、復元可能／完全削除なしを表示する。承認直前・PATCH直前に同じsnapshotを再照合し、PATCH responseと同じfile IDのreadbackで`trashed=true`、所有者、MIME、name、parentを確認する。結果不明・readback失敗では再送しない。Drive側他writerとの原子的排他は保証しない。実provider／資格情報／外部Drive作用は未実施。

全workspace `pnpm typecheck`／`pnpm build`、`pnpm docs:check`、build済みControl Center script構文、`git diff --check`はPASS（日本語基底の既存移行負債76件の注意あり）。test suite／Gateway process／browser／実provider／資格情報／外部作用はNOT_RUN。STATUS=`WIRED`（runtime未確認）。F04.02全体、F04、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。C08.03、OD-03、P13を保留する。

## 前回BUILD_BATCH — F04.02 Drive個別ユーザー権限付与

`google.drive.write/permissions.create`を既存HDS Operation Plan／Executor Brokerへ接続し、Owner taskに明示された単一のtext/plain file ID、単一ユーザーemail、`reader`または`writer`だけを許可した。既存直接付与、権限更新／削除、group／domain／anyone共有、Workspace native document、folder／binary、所有権移転を対象外とし、Drive通知emailは送らない。metadataと取得可能なpermission scopeを複数回照合し、no-store L3確認、承認前／POST直前の再照合、返却permission ID確認、permissions.getとpost-write scope readbackを接続した。結果不明では自動再送しない。Google APIの他writerとの原子的排他は保証しない。実provider／資格情報／外部共有は未実施。

全workspace `pnpm typecheck`、変更package build、`pnpm docs:check`、build済みControl Center script構文、`git diff --check`はPASS。test suite／Gateway process／browser／実provider／資格情報／外部作用はNOT_RUN。STATUS=`WIRED`（runtime未確認）。F04.02全体は`BUILD_GAP`のまま。

## 前回BUILD_BATCH — F04.02 Drive既存text/plain本文のL3束縛更新

`google.drive.write/file.update`をHDS Operation Plan／Executor Brokerへ接続し、Owner taskに明示された既存blobの単一`file_id`と置換本文、MIME=`text/plain`だけを扱った。metadata、現本文、取得可能なpermission scopeを二重読取し、file state／本文／scope／payload／command／Plan bindingをtarget-versionに結合した。no-store L3確認に変更前後本文とscopeを表示し、承認時・PATCH直前にsnapshotを再照合する。PATCH後は既存identity／MIME／parent／nameと本文をreadbackし、結果不明で自動再送しない。Drive APIの原子的条件付き更新を確認できていないため、最終照合後の外部競合を排除できるとは主張しない。実provider／資格情報／外部Drive作用は未実施。

全workspace typecheck、変更package build、`pnpm docs:check`、build済みControl Center script構文、`git diff --check`はPASS。test suite／Gateway process／browser／実provider／資格情報／外部作用はNOT_RUN。STATUS=`WIRED`（runtime未確認）。

## 前回BUILD_BATCH — F04.01 Driveの単一file metadata・revision・sharing読取

2026-11-02、既存`google.drive.read`をexact `file_id`単件metadata取得へ拡張し、file/folder identity、MIME、親folder、Shared Drive、version／取得可能なhead revision、共有状態、trash状態、取得可能なpermission scopeを返す。`files.get`は静的field maskと`supportsAllDrives=true`を使い、応答file IDを要求値と照合する。permission主体のemail・表示名・permission IDは返さない。検索ではpermission inventoryを既定で取得せず、exact file readはsharing scopeを既定で含め、取得不能・未要求・Shared Driveで部分／未提供を区別する。Daily Briefはpermission inventoryを取得しない。

返却はprovider由来の非信頼metadataとして明示し、`content_read=false`／`mutation_sent=false`を維持する。version／head revision metadataは変更履歴一覧やrevision本文を意味しない。資料本文と内包指示のconsumerは未接続のため、F04.01全体は`BUILD_GAP`、metadata subconsumerのみ`WIRED`（runtime未確認）。本文形式・byte上限・保持条件が未定義のため本文読取を追加していない。F04.02 write/share/delete、F04.03 live、実provider／credential／外部読取は未実施。一次仕様は[Drive files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)、[files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)、[permissions resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions)。

`@blue-tanuki/core` typecheck／build、`pnpm docs:check`、`git diff --check`はPASS（日本語基底の既存移行負債76件）。test suite、Gateway process、実provider／実資格／Drive読取はNOT_RUN。製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。C08.03、OD-03、P13の保留を維持する。保護対象`.codex-remote-attachments/`は変更していない。

## 前回BUILD_BATCH — F03.02既存参加者を保持する招待追加consumer

2026-11-02、F03.02の`event.invite`を既存attendee保持consumer、no-store L3確認、Gateway必須承認経路へ接続した。Google Calendar PATCHはattendees配列を置換するため、完全一覧を読み、既存のRSVP等の書込可能項目と新規宛先を合わせて送る。重複宛先、完全性不明、200人超、max_bytes超は作用前にfail-closed。reviewは既存参加者・新規追加先・`sendUpdates=all`の全通知対象を表示し、digestとfresh ETagへ束縛する。既存参加者への更新通知を含むことも明示した。結果不明後のread-only照合はevent存在だけで一致扱いせず、要求宛先全員のattendee登録とscopeを確認する。通知メール到達は未確認、HDSは`outcome_unknown`、自動再送なし。同じeventの未解決招待は異なる宛先でも遮断し、確定済み同一宛先は順序・大文字小文字を正規化して重複拒否する。

HDS／core／WebChat／Gateway typecheck、HDS／core／WebChat／Gateway build、生成Control Center script構文解析、`pnpm docs:check`、`git diff --check`はPASS（日本語基底の移行負債76件は既存注意）。test suite／Gateway process／browser／実provider／実資格／Calendar変更はNOT_RUN。STATUS=`WIRED`（既存attendee保持・review承認・結果照合のコード接続、runtime未確認）。F03.02／F03全体、E2E-01、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、owner GOは未成立。C08.03実provider、OD-03 live外部作用、P13 owner GOは保留する。

## 直近のBUILD_BATCH履歴

2026-11-02、Calendar書込み後の結果不明を、HDSから許可された一回限りの読取照合へ接続した。`event.create`は要求内容から決定するprovider event IDを使い、同じ時間枠の未解決再作成と同一要求の重複を抑止する。`event.invite`は同じevent・宛先への再送を拒否する。404は不存在と閲覧不能を区別できず、eventの存在は招待メール到達を証明しない。HDS stepは`outcome_unknown`を保ち、owner継続ボタンは別task入力欄を準備するだけで自動送信・Calendar作用を行わない。参加者一覧の照合は次のBUILD_BATCHで接続した。

2026-11-01、F03.02 Calendarの単一予定・繰返し系列・単一occurrenceを別scopeにし、系列規則とoccurrenceの親系列ID／`originalStartTime`をsnapshot／write target-version／Operation Plan／Owner確認へ結んだ。更新は件名のみ、削除は指定event IDのみとし、primary calendar・本人主催・完全参加者観測・他参加者0人・通知なし・fresh ETag `If-Match`を維持する。typecheck／build、script構文、docs gate、diff checkはPASS。test／runtime／browser／実provider／Calendar変更はNOT_RUN。STATUS=WIRED（runtime未確認）。

2026-11-01、F02.02のGmail候補をTo/Cc/Bcc/Reply-To・件名・本文から実MIME要求、target identity、no-store Owner content review、既存L3／Approval Gate／Brokerへ結んだ。宛先列は共有Protocol正規化で表示名なし・最大20件に限定し、Owner taskにない宛先をメールheaderから補わない。Control CenterはReply-Toとrequest digestを表示し、添付は未対応としてなしと明示、添付フィールドは候補検査で拒否する。Protocol build、HDS／core／WebChat／Gatewayのtypecheck・build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。test／Gateway process／browser／実provider／外部作用はNOT_RUN。STATUS=WIRED（宛先・本文のコード接続、runtime未確認）。添付の選択・読取・内容digest・Owner確認が未接続のためF02.02全体=`BUILD_GAP`。C08.03実provider、OD-03 live外部作用、P13 owner GOは保留する。次は添付identityから内容を正確に確認・結合するproducer／consumerを実装する。

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

2026-11-01、別の安全consumerとしてF03.01 Calendar読取を接続した。google.calendar.readはevent identity／organizer／attendee／date-time・timezoneの正規化値と原表現を保持し、view=freebusyは31日以内の単一calendar照会と応答受領時刻・observed digestを返す。部分取得・provider error・不整合はavailability=unknownへ閉じる。core／hds-brain typecheckはPASS。test／Gateway runtime／実provider／browser／外部作用はNOT_RUN。これはadapter経路のコード接続で、F03.01 runtime、F03.02 read-before-write、F03全体、E2E-01、製品全体BUILD、QC／QAやowner GOの証拠ではない。

2026-11-01、F03.02の最初のwrite consumerとしてGoogle Calendar `event.create`を既存Approval／HDS execution binding／Brokerへ接続した。作成には同一calendar・対象時間を含む完全freebusy観測が必要で、target-version取得・Owner内容確認・承認後・POST直前に同じ範囲を再読取する。busy結果変更、unknown／部分観測、非対応引数では外部write前に停止する。Owner確認画面は予定内容、busy区間、重複を示し、busy結果を権限へ昇格しない。更新・削除・繰返し・参加者／招待通知は未接続で拒否する。限定TypeScript buildはPASS、test／Gateway process／browser／実provider／実資格／Calendar変更はNOT_RUN。`event.create`は`WIRED`（runtime未確認）、F03.02とF03全体は`BUILD_GAP`、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QC／QA、owner GOは未成立。

2026-11-01、F03.02の次consumerとして、単一の確定済み非繰返しCalendar eventの件名更新だけを追加した。`google.calendar.read view=event event_id=...`が返す単件snapshotからevent ID／state digest／ETag digestを確認し、target-version、Ownerのno-store review、承認時再検査、承認後実行の各境界で同じ状態を再読取する。PATCHはfresh ETagの`If-Match`条件付きとし、summary以外を変更せず、通知なしを明示する。繰返し・本文・時刻・場所・参加者・通知の更新は拒否する。Protocol／HDS／core／WebChat／Gatewayの限定TypeScript build、Control Center script構文解析、`git diff --check`はPASS。test／Gateway process／browser／provider／外部作用はNOT_RUN。`event.update`件名変更は`WIRED`（runtime未確認）、F03.02残要求、F03全体、製品全体BUILD、QC／QA、owner GOは未成立。

2026-11-01、F03.02の単件Calendar対象をv2へ拡張し、主催者本人、完全な参加者一覧、他参加者0人、日時・timezoneを read-before-write の状態digestへ結んだ。参加者識別子は取得・返却しない。作成・更新に続いて、primary calendar上の確定済み非繰返し予定一件だけを対象にした`event.delete`を既存L3／Approval／HDS binding／Brokerへ接続した。Ownerのno-store reviewで予定ID・件名・日時・所有・参加者数を提示し、承認前後に再読取、fresh ETagを`If-Match`、`sendUpdates=none`で単件DELETEする。Protocol／HDS／core／WebChat／Gateway TypeScript build、生成script構文解析、`git diff --check`はPASS。test／Gateway process／browser／実provider／実資格／外部作用はNOT_RUN。三操作は`WIRED`（runtime未確認）、繰返し系列／occurrence、参加者・招待効果は`BUILD_GAP`、F03全体と製品全体BUILD・QC／QA・owner GOは未成立。

2026-11-01、F03.02の参加者・通知consumerを接続した。`event.create`はOwner taskに明示された最大20件の参加者を要求本文へ束ね、no-store L3確認に宛先と招待メール作用を出す。宛先がある場合だけ`sendUpdates=all`を指定し、ない場合は`none`。既存予定の`event.invite`は別operationとして、primary calendar・本人主催・完全なread snapshot・event ID・明示recurrence scopeを確認し、対象に既存attendeeが一人もいない場合に限りPATCHする。Calendar APIのattendees配列置換で既存者を落とさないため、owner本人のattendeeも含め既存参加者がある対象は拒否する。request payload／target version／状態digest／ETag `If-Match`を結び、取得・L3確認・実行直前に同じ対象を再読取する。Operation Planは招待時だけ`external_send`を必須化し、high／L3／Approval Gate／HDS authorityを固定する。Protocol／HDS-BRAIN／core／WebChat／Gateway build、生成script構文解析、`pnpm docs:check`、`git diff --check`はPASS。日本語基底移行負債76件は既存注意。test／Gateway process／browser／実provider／実資格／外部作用はNOT_RUN。これは`WIRED`（コード接続）であり、既存参加者を保った招待、結果不明時の照合・復旧、F03.02／F03全体、製品全体BUILD、QC／QA、owner GOの成立ではない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
