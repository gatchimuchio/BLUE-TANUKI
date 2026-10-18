# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。E03.02の新BUILD_BATCH開始時に、owner指定のrev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、直前active指示、最新HEAD／差分、E03.02要求、Gateway result outbox→HDS J/M経路を読み直した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-OLD-GENERATION-RESULT-ARCHIVE`。関連単位=E03.02「未決作用・M pendingの回復」。開始HEAD／`origin/main`=`89825a413eb4d23463243dbf26da79040e1fcd0e`、clean。backup ref移行=`MIGRATION_COMPLETE`。編集前のlocal recovery branch／remote backup tagは現世代`89825a4`、直前`e4344ee`へCAS／lease付き更新し、SHA一致を確認した。

### 目的と到達状態

Gateway startupおよび実行後reconciliationにcurrent persisted execution epochを必須入力として渡す。pending resultのepochがcurrentと一致する場合だけ既存HDS J/M reconciliationへ進める。旧generation resultはHDS・Mの正本更新へ通さず、private ExecutionIntentのdigest-only履歴へ`stale_generation_evidence`として記録し、同じoutbox receiptを繰返し適用しない。現行epoch resultと既存のM pending recoveryは現在の同一receipt／保存済みJ commitで継続する。

各関連単位の途中状態は`CODE_PRESENT`／`WIRED`／`BUILD_GAP`／`BLOCKED_AUTHORITY`で記録する。E03.02は旧世代receipt隔離の実装と接続が完了するまで`BUILD_GAP`として扱い、局所testの成功をSYSTEM_SHAPED、BUILD_COVERED、QE_QCまたはQE_QAへ昇格しない。

### 対象と境界

- 対象：`apps/gateway/src/execution_intent_store.ts`、`apps/gateway/src/reconcile_execution_results.ts`、`apps/gateway/src/serve.ts`、`packages/blue-tanuki/src/execution_intent.ts`、関連限定test、`docs/開発進捗.md`、`docs/ROADMAP.md`。
- 保存する履歴は既存private result outboxに保持された内容、旧execution epoch digest、archive時current epoch digest、固定dispositionだけ。Control Center snapshotにはdigestと非権威dispositionのみを出し、raw result、command、ticketを追加しない。
- 旧epoch receiptがpendingでもHDS OperationPlan結果／Memory commitを新たに生成しない。すでにJが保存した同一commitのM recoveryとは分離し、既存起動障壁のfail-closedを維持する。
- 実credential／provider／外部業務作用、C08.03、D4Pocket／ミニドラ別repo、Windows ACL／network filesystem保証、旧binaryを強制停止する配布制御、全体QE_QC／QE_QA、P13公開・出荷判断は対象外。外部作用が既に開始した結果の取消を主張しない。

### 最小確認

現行epoch resultの既存J/M reconciliationを維持する確認、旧epoch resultがdigest-only履歴化されJ/Mを変えずpendingを解放する限定test、snapshotの非漏えい、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`を実行する。live serve／実credential／外部作用は実行しない。

### 実施結果

- 3-file限定Vitestは35 tests PASS。続く旧generation隔離focused testは1 test PASS、`startup_execution_reconciliation.test.ts`全5 testsもPASS。現行epochのJ/M配送、旧epoch結果のJ/M非到達・snapshot非漏えい・outbox保持・hash-chain検証、archive failure時のstartup fail-closedを確認した。
- `pnpm typecheck` PASS。`pnpm build` PASS（15 workspace projects）。
- `pnpm docs:check` PASS。日本語基底・license gateもPASS、日本語基底移行負債77件を維持。`git diff --check` PASS。
- 実装commit=`e430ab4c01ede5f36e4aef391365c41e2ddb567b`を`origin/main`へpush済み。local／remote main SHA一致を確認した。remote backup tagは現世代`89825a413eb4d23463243dbf26da79040e1fcd0e`／直前`e4344ee0ad06faa12c05b0b8beae3fcffb1f0eb0`で、local branch／tagも同じ値に照合した。
- E03.02／QEB-03は`BUILD_GAP`。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。live serve、credential、実provider、外部作用、QE_QC／QE_QA、公開・出荷判断は行っていない。

### Git・停止条件

通常成果を限定commitとして`main`へpushし、push後にremote HEAD、local二世代recovery branch、remote二世代backup tag、clean stateを再照合する。旧epoch resultを現行J/Mへ適用する経路またはraw contentをControl Centerへ出す経路が残る場合はstartupをfail-closedのままにする。E03.02／QEB-03全体の完成宣言は行わない。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
