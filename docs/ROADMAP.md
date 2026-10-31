# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 現在のBUILD_BATCH

### E2E-01 接続単位 — WebChat結果から同一taskの再計画候補まで

`/owner/task-compute`のhandler失敗時はtask本文・例外詳細・目的・credential・HDS commitを含まない固定`error` status frameを返信先へbest-effort通知し、handler未接続時は受付前に503で拒否する。またControl Centerは`channel_send`／`error`結果frame受信後、runtime tokenが入力済みなら`/runtime/snapshot`を再読込し、計画一覧を更新する。owner tokenで作成されたplanのstep審査・保存結果読取・結果不明receipt照合は、同一plan/revisionを付けたowner専用`/owner/inbound`へ接続済みである。今回、現在の目的版に結び付き、検証済みstepとM receiptを持つfile operation resultから、owner token限定で同一taskの次候補を依頼するControl Center操作を接続した。HDSは親planのowner／channel／現行revision、待機・復旧hold、目的版、結果観測とtask identityを入口および候補保持時に再照合し、親の原taskとtask identityを次候補へ引き継ぐ。候補は未実行で、既存step審査・Approval／Brokerを経る。親task contextとresult observationのprovider露出分類を分け、alternate providerは両sourceを明示許可した場合だけ使う。owner tokenのDeveloper operator経路は既存のwait／resume限定を維持し、HDSの権限・L3／Approval／Broker判定は変更しない。失敗statusは非権威の運転状態で、HDS判断・最終出力・Approval・実行receiptではない。通知は接続中WebSocketへのbest-effortまでで、切断後の永続再配送・Approval queue自動更新・runtime token未入力時の自動更新は未接続。今回の`pnpm typecheck`／`pnpm build`／`pnpm docs:check`／`git diff --check`はPASS。test、Gateway実process smoke、実provider、実作用は未実施。コード経路は`WIRED`だが実行経路の一気通貫は未確認であり、目的→C→J→安全な合成Approval／Broker作用→receipt→M→結果返信→再計画・復帰、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立のまま。

最新接続の実process evidenceは下記「2026-10-31 E2E-01 現行接続点」に記録する。実WebChat相当の限定synthetic taskでcreate-only `file.write`から同一task read-only `file.search`のowner審査・Broker結果・M receipt・保存結果returnまでPASSした。実provider／実LLMは呼び出していない。E2E-01全体・製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

### 2026-10-31 E2E-01 現行接続点

Windows上の隔離合成Gateway実processで、固定4役割delegation、目的関係のowner L3審査、同一plan/revisionのstep審査、HDSによる選択済みcommandのtool区分、既存process policy／Approval Gate／Broker、create-only file.write、検証済みM receipt、WebSocket replyまで接続した。receiptを根拠にした同一task read-only file.search候補は、owner L3関係確認・step審査後にBroker workerで検索し、完全一致検証とM receipt確認を通過した。ownerの保存結果returnは再検索を行わず、保存時点・検索完全性不明の注意を付けてWebChatへ返した。対象test 1件PASS、他3件はpatternで未実施。provider呼出しなし、作成物はtestの一時file rootに限定しcleanup済み。HDSの一般chat／候補入力はtool権限を得ず、L3／Approval／Broker境界は維持されている。

この限定synthetic経路はE2E-01全体の完成ではない。次は処理中断・process restart後に既存writeを重複実行せず、同一taskのcommand intent・execution receipt・M receipt・plan dependencyを再照合する復旧consumerを接続する。全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QA、OS別QA、owner GOは未達。実provider／公開／外部作用なし。

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
