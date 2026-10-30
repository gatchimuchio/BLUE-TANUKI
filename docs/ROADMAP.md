# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 現在のBUILD_BATCH

K-B0／K-B1で現行入口、通常・復旧writer、I-01対象guard、I-03 main appから通常Computeへのbudget設定を照合・接続した。E2E-01とK-B2では、合成仕事のC→J→L3→M→次task再評価を限定接続し、meaning-update専用J/Mを7-store復旧経路へ接続した。これらは部分経路の証拠であり、製品全体の結合形状を示さない。

K-B3ではC候補評価を`meaning_update_candidate.ts`、承認済み候補からM record／interpretationを作る純粋処理を`meaning_update_semantics.ts`へ、解釈JSON正規化・検査・content digestを`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在Mと検証済み監査履歴から再評価候補を導出する意味処理を`memory_judgment_reassessment_candidate.ts`へ移した。controllerが監査・現在Mを取得し、Approval Gate／L3／監査書込／J-M writerはTypeScript HDS-BRAINに残る。HDS focused 3 files／5 tests、HDS typecheck/build/standalone、Gateway typecheck/buildはPASS。Gateway process smokeは前バッチでhealth readyに至らず統合実行未確認。今回の抽出で新しい利用者仕事や全体`SYSTEM_SHAPED`／`BUILD_COVERED`は成立しない。K-B3全体の責任抽出完了、C08.03、OD-03、他repo変更、P13 GOは未成立／保留。

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続を行い、K-B5では数値policy採否・rule provenance・purpose binding・SUSPEND後の人間復帰に加え、GatewayのL3承認後に発生する二種のM更新遷移と残差集計を同じRust実processへ接続している。HDS controllerはTypeScript commitのdecision・reason・triggered thresholdを通常policy評価と照合し、同じ出所と確認できる場合だけscore／weight／lifecycle／thresholdを固定小数点化してRustへ渡す。Rustは独立評価した結果を非権威receiptへ返す。保存時の`DecisionLog.goal_purpose_binding`と`GoalGovernanceLedger.project()`から別途取得した現在の目的版・digestをRust shadow projectionへ載せ、Rustは保存版と現在値を照合して鮮度状態を非権威receiptへ返す。現行projection schemaはv11。

直近のBUILD差分で、L3後のM遷移比較に`MemoryUpdateReceiptV1`の実`previous_revision`／`revision`を接続した。Rust shadowは適用時の1段増分を独立比較し、版飛びを不一致として分類する。未適用はrevisionを明示的`null`とし、冪等再送で新receiptを得ない場合に版を推測しない。Gateway observerはrevisionとtransition／residual／lifecycleのreceipt整合を再検査する。通常Gateway serveを通る合成L3 smokeで意味採用2件・引用再評価1件の実receiptから各1段増分を確認した。HDS/Gateway typecheck・build、HDS controller 78 tests、Rust 4 tests、Gateway observer 3 tests、Gateway M smoke 1 testがPASS。これはM commitの版遷移だけの比較証拠であり、M内容の意味評価、K-B5全体意味比較、single-writer cutoverを成立させない。Rustの操作判断は`hold`、作用・M正本書込みなしを維持する。

今回、L3 memory transitionのowner `reject`／`block`と承認後`not_applied`も同じRust shadow系列で照合する合成ケースを、既存Gateway observer process fixtureへ追加した。meaning-updateとjudgment reassessmentそれぞれのreject／block／approve-not-appliedで、owner verdict・M適用状態・残差・lifecycleを実Rust process receiptと照合しPASS。HDS／Gateway typecheck、Rust `cargo build`／`cargo test --locked`、HDS shadow IPC process、Gateway shadow observer process、`git diff --check`もPASS。fixtureは合成projectionを直接shadow consumerへ渡す限定確認で、Gateway `serve`上の実owner/L3操作や実M適用を通した証拠ではない。TypeScript authority、M writer、Approval Gate、実行権限は変更していない。K-B5のJ/M全体意味比較、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは引き続き未成立。

今回の実consumer修正では、Gateway observerがmemory transitionのreceiptから遷移一致・残差状態・lifecycleを元projectionより再計算して照合するようにした。相互に矛盾するreceiptは採用せずobserverをfail-closeする。今回のコード確認はHDS／Gateway typecheck・build、Rust `cargo check`、`cargo fmt --check`、差分空白検査がPASS。テストおよびこの差分のRust実processは未実行。先行する実process・test結果は先行commitの証拠としてのみ保持する。

続くBUILD差分では、ownerがapproveした後のmeaning-update／judgment reassessmentも、直前のstale再照合またはcommit APIの明示的`ok:false`でMが適用されなかった場合をshadowへ投影した。`approve`と`memory_application_status=not_applied`を分離し、meaning updateは`adoption_approved_not_applied`、再評価は未再評価数を全件残す。Rust parserとGateway observerが適用状態・残差を再計算して照合する。例外送出は部分commit後の可能性を排除できないため未分類のままにし、未適用として記録しない。projection schemaはv9。HDS／Gateway typecheck・build、Rust `cargo check`／`cargo fmt --check`、`pnpm docs:check`、`git diff --check`はPASS。test・Gateway/Rust実processは未実施。Rustは`hold`、no-effect、no-M-writeのままである。

今回、purpose-bound computeのdigest-only bindingを`DecisionLog`へ記録し、SUSPEND／resume記録へ引き継いだ。承認済みmeaning-updateのcontent-review／commit audit markerはsource DecisionLog hashとpurpose bindingを持ち、recovery／replayは唯一のASSERT source recordと照合する。M record v1と意味digestは維持する。HDS／Gateway typecheck・buildはPASS。テスト、Rust変更、実processは未実施。これは監査上の出所連結であり、目的適合やRust authorityを成立させない。

Rustの`decision`は常に`hold`、作用権限・M正本writerなし。HDS Jのplan step採用記録を、選択commandに一致するstored bindingから取得し、ローカルでassessment digestを検証した後、目的review／criterion状態と上限64のrelation件数だけに縮約してRust shadowの同一系列へ渡すコード経路を追加した。文章・ID・purpose／criterion／assessment digestはRustへ渡さない。Rustは採否に関係する状態・件数の整合を独立分類し、Gateway observerはnested receiptと比較statusを再照合して非権威ログへ返す。旧checkpoint記録欠落は`not_comparable`、plan未選択は`not_applicable`。全体statusは不一致を優先し、比較可能な全軸の一致時だけ`matched`とする。現行目的台帳または選択済みplan記録が比較不能なら`not_comparable`を返す。この経路は`WIRED`。observer試験で実Rust processのmatched／意図的不一致receiptを確認した後、Gateway process smokeで通常WebChat inbound→選択済みplan→Rust shadow receiptの`matched`を確認した。local fake provider・隔離state・一時file rootを使い、本文・request／plan／step ID・pathがreceiptへ出ないことを確認し、file.deleteはtest専用L3承認後に一時root内だけで実行・観測した。HDS／Gateway typecheck・依存buildとprocess smokeはPASS。smokeが検出した`source_decision_binding`の承認context欠落を修正し、J/M stageで同じ束縛を再検証する。K-B5のJ/M全体意味比較、`RUST_SHADOW_WIRED`／single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。C08.03、OD-03、他repo変更、P13 GOも保留する。

最新のGateway observer修正では、Rustのplan adoption receiptをTypeScriptの同じ採否分類と厳密一致させて停止する挙動を除いた。receipt構造、projection echo、Rust内のstatus／matches整合は引き続き検証し、意味分類差は双方の値を非権威ログへ残して総合`mismatched`として観測する。Rust側総合statusはRust receiptから再計算して照合する。HDS／Gateway typecheck・build、Rust `cargo check --locked`／`cargo test --locked`（4件）、HDS shadow IPC（3件）、Gateway observer（3件）、Gateway合成L3／plan採否process smoke（1件）、`pnpm docs:check`がPASS。smokeはlocalhost fake provider・隔離state・一時file rootを使用し、test専用L3承認後のfile.deleteも一時root内に限定した。実provider・実外部作用・全workspace suite・QE_QC／QE_QA・5OS実機の証拠ではない。K-B5全体比較、製品全体BUILD、QC／QA、cutoverは未成立。

今回、HDS-BRAINが既に確定した自己健全性fail-safe `SUSPEND`をRust shadowへ限定投影するconsumerを接続した。projection v11／request v6では失敗条件名・根拠・入力本文を除外し、失敗件数と実行禁止／非権威の固定値だけを渡す。Rustは単一の`self_health`停止軸、その重みと閾値、gate形状を検証して同じ停止を再判定し、運転判断は`hold`のまま維持する。Windows上の実Rust processで一致receipt、不正件数／重みの拒否、停止時の無作用・no-M-writeを確認した。HDS controller／shadow IPC 82 tests、Gateway shadow observer 4 tests、Rust `cargo test --locked` 4 tests、`cargo fmt --check`、HDS／Gateway typecheck・build、`pnpm docs:check`、`git diff --check`はPASS。fixtureは合成入力で、実provider・外部作用・他OS実行の証拠ではない。これはfail-safe停止の比較consumer接続を示すだけであり、K-B5全体意味比較、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAを成立させない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
