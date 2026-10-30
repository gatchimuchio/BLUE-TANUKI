# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev3.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.0ではHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。明示された検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 現在のrepo基点

ownerがrev3.0を指定した時点のlocal／remote `main`は`2964db41dc11ddc3057f47447a85f8a49395c377`だった。パッケージ内の`e28a73f330cb155f46aea00e58cffd3a6b005ae8`はパッケージ作成時の観測値であり、現行HEADではない。CR-0～CR-3の完了根拠は既存履歴にあるが、K-B0で実際の最新HEADと入口を再照合し、古い監査結果を現行状態として転記しない。既に現HEADで成立していれば再実装しない。

## 現行接続状態と次のBUILD_BATCH

K-B0／K-B1で現行入口と一仕事のproducer／consumer、J/Mの通常・復旧writerをコードで再照合した。公開可能な責任対応は[`OPERATION_CORE_ARCHITECTURE.md`](OPERATION_CORE_ARCHITECTURE.md)に置く。これは`BASELINE_OBSERVED`／`RESPONSIBILITY_MAPPED`の静的確認範囲であり、全OSの実行証拠や全体実装の完成ではない。

I-01のroot直下の二重slashによる広域対象ガードの抜けを修正し、I-03のメイン`/app`にも費用profile・予算policy・timeoutの保存／Verifyを接続した。provider疎通と通常Computeの設定準備を別に表示し、設定変更後の古い準備判定を破棄する。現在の予算消費は仕事ごとの実行時照合が必要であり、設定のreadyは実行許可ではない。I-04の共通試験fixtureには現行Compute／予算／worker lifecycleの依存を渡し、候補生成前の拒否を本番guardの緩和で隠さない。

K-B2では、Jが明示選択・再照合した有限なoperation-result observationをdigestでC候補へ拘束し、owner L3、M解釈更新、次taskの再評価までを限定接続した。`plan:reflect`は採用候補入力から除外する。meaning-update専用J/M storeを含む7-store復旧境界、restore前quiescence、HDS plan hold、restore後の再観測とreconcileも接続済みで、旧5-store snapshotからのrestoreは拒否する。

K-B3のmeaning-update／引用再評価経路では、C候補評価を`meaning_update_candidate.ts`、承認候補からMレコード／解釈投影を作る処理を`meaning_update_semantics.ts`、解釈content digestとJSON正規化・検査を`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在J判断と過去監査・M履歴の整合を評価してowner再評価候補を作る処理を`memory_judgment_reassessment_candidate.ts`へ分離した。controllerは監査検証とM／audit snapshot取得を担当し、候補の意味評価は供給された値だけで行う。L3、監査の書込、J/M writerは現行TypeScript HDS-BRAINに保持する。これらの純粋意味モジュールはGateway／SQLiteをruntime importせず、新processや第二authorityを作らない。

コード上、Gatewayのno-store content reviewからL3承認、同一proposal／candidate／target／source-observation digestの再照合、M適用、最終監査markerまでの既存接続を維持した。HDS 3 files／5 tests、HDS typecheck/build、HDS standalone smoke、Gateway typecheck/buildはPASS。`pnpm docs:check`はこの記録更新後に実行する。Gateway meaning-update process smokeは前バッチで起動後15秒以内にhealthへ到達せず、統合実行の証拠は未成立のまま。今回の経路抽出は既存責任境界の整理であり、新しい利用者仕事や製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を成立させない。K-B3全体の抽出完了は未確定、QE_QC／QE_QAは未開始。

K-B4のRust最小核はWindowsでcompile／testされ、HMAC認証付きcanonical IPC、sequence／expected revision／期限／budget／digest検査、no-effect hold receipt、専用shadow SQLite記録を実プロセスで往復した。TypeScript側は`runStandaloneHDSBrain()`が合成要求から返す判断要約と非権威flagだけを入力し、生入力本文やcredentialをRustへ渡さない。重複sequence・古いrevision・期限切れは拒否し、署名改ざんはfail-closed停止、shutdownは安全停止receiptを返す。RustはeffectもM正本も書かない。`cargo fmt --check`、`cargo metadata --locked --no-deps`、`cargo test --locked`（2 unit tests）、Rust実process Vitest（2 tests）、HDS typecheckはPASS。実コンパイルで発見したHMAC `KeyInit` import欠落を修正した。K-B4のprocess prototypeは合成standalone pathで`WIRED`だが、通常Gateway requestからの起動・判断比較は未接続で`BUILD_GAP`。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`や`RUST_SHADOW_CUTOVER`は成立しない。次consumerは`apps/gateway/src/serve.ts`の通常inbound `hds.decide`経路（約4808行）で、Rust shadowへ渡す非権威要約と停止・故障時の既存TypeScript継続境界を接続する。C08.03実provider・外部作用・他repo書込み・公開は保留。

旧Jの現writerは確認なしに二重化・移管しない。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラ別repo変更、P13公開・出荷GOは保留する。試験用一仕事は製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を自動成立させず、限定testを全suiteや実機の成功へ転記しない。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。
