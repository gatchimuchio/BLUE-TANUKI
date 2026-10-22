# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 次のBUILD_BATCH

rev3.0 K-B0／K-B1のコード再照合で、現在の入口とJ/Mの通常・復旧writerを一仕事に沿って対応付けた。責任対応は[`OPERATION_CORE_ARCHITECTURE.md`](OPERATION_CORE_ARCHITECTURE.md)。I-01のUnix root直下のガード欠陥を修正し、I-03のメイン`/app`から費用・予算・timeoutの設定を通常Computeの既存consumerへ渡す。これは限定した接続と静的な責任対応であり、全体実行や全OSの成立ではない。

E2E-01の同一owner WebChat synthetic経路は、委任目的のL3確認・J/M反映、再起動後の再読込、検索・receipt/M、同一taskの返信・再計画まで局所確認した。K-B2では現行M引用付き`plan:compute`から、固定4 worker＋親C計算、Jの未実行計画、別L3確認、隔離file.delete、結果receipt/Mまでのconsumer接続を加えた。Executorは選択済み引用／観測のlocal P版を保持して有限agent delegationを実行する。これは合成fixtureによる一経路の証拠で、実Provider・製品全体の結合形状・品質保証を示さない。

K-B2では、Jが明示選択・再照合した有限なoperation-result observationから、digest拘束されたC意味更新候補、J再照合、owner L3、M解釈更新、次taskの再評価までを限定接続した。`plan:reflect`は除外し、意味更新候補から採用や権限を自動生成しない。meaning-update専用J/M storeを7-store canonical snapshotとinspectionに含め、実Gateway復元経路でrestore前quiescence、HDSのplan hold、L3後のselected-store restore、Complete Historyによるpost-action再観測、J/M reopen・reconcileを接続した。合成Gateway試験では通常J/M・meaning-update J/Mの4 storeを個別復元し、既存planをholdした。旧5-store snapshotはpartial read-only inspectionだけを許しrestoreを拒否する。QEB-KB03では、意味更新のJ/M適用後・最終監査記録前の停止窓から、content-review、L3承認、同一proposal／candidate／source-observation digestを持つ適用済みM記録だけを照合して監査完了記録を再構成するconsumerを接続した。候補・承認待ち・作用の再生成はせず、証跡が曖昧な場合やblocked記録と衝突する場合はfail-closedとする。C03.04ではJ/Mの再open時にverified canonical event ledgerから派生像を再構成し、J schema v1移行を事前検証付きwriterへ揃えた。K-B3ではC提案の意味評価・M参照照合・owner-review適格性を`meaning_update_candidate.ts`へ分離し、初回候補生成とowner review直前の再評価を同一の純粋評価へ接続した。HDS 4 files／82 tests、typecheck、build、standalone smokeを確認した。次はcontent review→L3→J/M適用のproposal／candidate／source-observation digest拘束を追い、残る実装未接続をBUILD_BATCHで結ぶ。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立で、QE_QC／QE_QAは未開始。Rustのsingle-writer cutoverは比較、停止、未決作用、rollback、権限境界が成立するまで行わない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
