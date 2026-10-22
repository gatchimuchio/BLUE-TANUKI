# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 次のBUILD_BATCH

rev3.0 K-B0／K-B1のコード再照合で、現在の入口とJ/Mの通常・復旧writerを一仕事に沿って対応付けた。責任対応は[`OPERATION_CORE_ARCHITECTURE.md`](OPERATION_CORE_ARCHITECTURE.md)。I-01のUnix root直下のガード欠陥を修正し、I-03のメイン`/app`から費用・予算・timeoutの設定を通常Computeの既存consumerへ渡す。これは限定した接続と静的な責任対応であり、全体実行や全OSの成立ではない。

E2E-01の同一owner WebChat synthetic経路は、委任目的のL3確認・J/M反映、再起動後の再読込、検索・receipt/M、同一taskの返信・再計画まで局所確認した。K-B2では現行M引用付き`plan:compute`から、固定4 worker＋親C計算、Jの未実行計画、別L3確認、隔離file.delete、結果receipt/Mまでのconsumer接続を加えた。Executorは選択済み引用／観測のlocal P版を保持して有限agent delegationを実行する。これは合成fixtureによる一経路の証拠で、実Provider・製品全体の結合形状・品質保証を示さない。

次は有限なoperation-result observationを意味更新候補へ結び、既存L3採否→M解釈版→次の仕事へ通す。`plan:reflect`の非採用境界を維持し、反映候補から意味更新採用や権限を生成しない。目的／意味専用J/M storeのbackup収容と、観測APIにも含まれるpending reconcileは未解消の接続・移管条件として扱う。Rustのsingle-writer cutoverは比較、停止、未決作用、rollback、権限境界が成立するまで行わない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
