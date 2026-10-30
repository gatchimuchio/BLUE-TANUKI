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

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続まで成立した。今回のactive batchはK-B5の限定J projection比較であり、K-B5全体の完了ではない。

### Active batch: K-B5 — 同一合成系列のJ採否・L3記憶遷移比較

- **目的:** 現行TypeScript HDS-BRAINのpolicy採否とM writerをauthorityとして維持したまま、Rust Runtime Kernelが同じscore／weight／thresholdから独立算出するJ projection、停止後の人間復帰、およびL3承認済みM更新の有限な残差状態を比較する。
- **producer／consumer:** `HDSUpperController.decide()`／`resume()`と、Gatewayの意味候補採用・引用判断再評価の成功commit分岐がprojectionを作る。通常inbound、resume、L3 memory approvalの既存observerから同じRust processへ順に渡し、比較receiptをGatewayの非権威ログへ返す。未確定のM再評価数・明示された未評価状態・再評価済み／残存数だけを集計し、IDや個々の参照は渡さない。
- **入力・出力:** 軸名、score、weight、lifecycle状態、policy閾値、TypeScript採否を送る。resume時は元のpolicy SUSPENDと`owner_verdict`、`resume_allowed`、復帰後decision、command有無だけを追加する。L3記憶遷移では承認／適用状態、許可状態ではない固定区分、および上限512の集計数だけを追加する。検証済みのpurpose-bound plan computeに限り、`SHA-256(goal_ref)`・purpose version・purpose digestを追加し、IPCの`goal_id`／`goal_version`との照合結果を`purpose_binding_matches`としてreceiptへ記録する。purpose bindingのない投影ではこの値は`null`、形状不正は拒否し、形式が正しい不一致は非権威の比較残差として返す。raw入力、goal_ref、目的本文、detector evidence、owner identity、source/target/judgment ID、digest、command本文、credential、request identity、M本文は送らない。Rust receiptの操作上の`decision`は常に`hold`で、比較採否は参考値のみ。
- **対象単位:** 同一合成系列でASSERT／FAIL／SUSPEND／OUT_OF_SCOPE、SUSPENDからapprove／reject／blockへの遷移、owner L3記憶採用時の未評価・未再評価残差、および指定J判断の再評価済み／残存数を比較する。軸／閾値を安全に表現できない場合、policy外controller override、または固定小数点化の判断境界付近は`not_comparable`として送らず、既存Gateway判断へ影響させない。
- **継続条件:** Rust shadowは作用権限・M正本writerを持たない。Rust起動・IPC失敗・queue上限・比較不一致はTypeScript authorityへ反映しない。比較不一致は観測し、原因を次の施工へ渡す。
- **この単位で未接続:** J/Mの全体意味比較、Rust shadowのsingle-writer cutover。C08.03実provider・OD-03 live外部作用・他repo書込み・P13公開／出荷GOも保留する。
- **必要最小確認:** HDS／Gateway typecheck・build、Rust compile／test、Rust実processを通す合成4分岐とSUSPEND→resume、IPC拒否・無作用停止。全workspace suite・QE_QC／QE_QA・実provider・実外部作用・5OS実機の成功へ転記しない。

前段では、L3意味採用・引用判断再評価の成功commitを、本文／識別子／digestを含まないv4 projectionとしてRust実processへ接続した。前回、その有限projectionをv5へ更新し、TypeScript側が採用したpolicy rule IDと対象axisを追加した。Rustは同じ数値入力から算出したrule ID／axisと直接比較し、採否が一致してもrule provenanceが異なる場合は`mismatched`を返す。今回、purpose bindingをIPCの`goal_id`／`goal_version`に照合した結果も独立した`purpose_binding_matches`としてreceiptへ返すようにした。形式が正しい不一致はRust shadowを停止せず`mismatched` receiptとし、形式不正だけを拒否する。目的versionとgoal identity digest双方の不一致を実process試験で確認した。Rustの操作判断は`hold`のままで、作用・M正本更新はない。Gatewayの非権威receipt／logにも比較結果を接続した。

この変更の限定確認は、HDS typecheck／build・shadow IPC実process 3件、Gateway typecheck／build・shadow observer 2件、Rust cargo test 2件、cargo fmt check、`pnpm docs:check`がPASS。全workspace suite、QE_QC／QE_QA、実provider、実外部作用、5OS実機の結果ではない。K-B5はJ/Mの全体意味比較とsingle-writer cutoverが未成立のため継続する。purpose版の照合値はobserverが同一projectionからIPCへ設定するため、この一致は独立したcurrent-governance sourceとの比較ではなくtransport整合性の確認に限る。目的本文・task意味との適合や目的に沿ったJ採否全体は未成立。システム全体の`SYSTEM_SHAPED`／`BUILD_COVERED`、`RUST_SHADOW_CUTOVER`、QE_QC／QE_QAは未成立のまま扱う。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。
