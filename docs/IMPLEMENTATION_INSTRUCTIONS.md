# BLUE-TANUKI 現行QE_BUILD指示

ownerの2026-10-21再確認：QE_BUILDで全体の一気通貫接続を進め、`SYSTEM_SHAPED`／`BUILD_COVERED`の後に実物QE_QC、改善・再検査、対象別QE_QAを行う。現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するrev2.3三点。各バッチで関係節、適用AGENTS、HEAD・差分、今回の要求と対象consumerだけを確認する。完了履歴は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) に保持し、依存・系譜・矛盾の確認時だけ読む。

### 最新BUILD_BATCH：`QEB-12-E03.03-OPERATION-PLAN-SCOPED-RECOVERY`

開始HEAD／`main`／`origin/main`=`30e8171294a93d211afd83664b0d6fa930c825e1`。tracked worktreeはclean。`packages/blue-tanuki/native/linux-isolation/target/`は保護対象の既存untrackedであり、変更・stage・削除しない。local recovery branch／tag二世代を確認済みで、backup ref移行状態=`MIGRATION_COMPLETE`。E03.03／QEB-12対象consumerは`BUILD_GAP`。

対象単位はE03.03「破損範囲の隔離復旧」。RecoveryのL3承認済み `operation_plan` scope digestを、archiveから同じplanのcheckpointへ結び付け、単一SQLite CASで当該planとそのplan_id_digestに束縛されたwaitだけを復元する。非対象plan、非対象wait、現在のunbound shell observation、他planのrecovery holdを保持し、復元後HDS refreshも要求planだけを変更・再評価する。

新しい成功結果は固定enum `restore_scope_mode=plan_scoped_merge_v1`で履歴に記録し、旧履歴の全store置換と区別する。旧または範囲不明の履歴は従来どおり全対象をfail-closedに扱う。schema／digest／target相関／CAS／容量のいずれかが確認できなければ選択storeを書き換えず停止する。選択planの依存残差・復元pointは既存のdigest-only evidenceでHDS holdへ接続し、復元を自動再開・承認・実行の根拠にしない。

境界：HDS-J、Approval Gate、L3、監査、M非権限、Broker、fail-closedを維持。J/M/Broker/cronの他store、provider、credential、実外部作用、D4Pocket・ミニドラ別repo、公開・出荷判断は変更しない。`cross_store_atomic=false`を維持し、job全体のatomicityや自動resumeを主張しない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

主な対象はGateway Recovery restore、Operation Plan SQLite store、Recovery post-action evidence、HDS recovery refreshと、それらの直接consumer test。受入は合成DBで、requested planだけarchive値へ戻り、兄弟plan/wait/unbound観測/holdが不変であること、古い全store履歴が新方式扱いされないこと、無効scope・破損archive・CAS競合・容量超過が書込み前に拒否されること。

### QE_BUILDの必要最小確認

対象focused tests、`pnpm typecheck`、`pnpm build`、`git diff --check`を実行する。既存のdocs・repo-health gateが影響する場合のみ追加する。全workspace suite、QE_QC／QE_QA、実provider・credential・外部作用、5OS実機は本バッチで実施しない。

### 履歴参照

閉じたBUILD_BATCHの詳細は必要時のみ[IMPLEMENTATION_HISTORY.md](IMPLEMENTATION_HISTORY.md)から参照する。
