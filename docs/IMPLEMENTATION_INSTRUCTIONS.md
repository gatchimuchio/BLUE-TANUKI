# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定のrev2.3 QE三点正本、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、現行active指示、HEAD／remote／dirty state、E03.01とGatewayの常駐／CLI実行・永続ExecutionIntent経路を再読した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.01-GATEWAY-OWNER-LEASE-EXECUTION-EPOCH`。関連単位=E03.01「単一writerと起動世代」、既存E03.02起動時未決作用・M pending障壁への前提接続。開始HEAD／`origin/main`=`e4344ee0ad06faa12c05b0b8beae3fcffb1f0eb0`、clean。backup ref移行=`MIGRATION_COMPLETE`。編集前のlocal recovery branch／remote backup tagは現世代`e4344ee`、直前世代`742b23c`へCAS／lease付き更新し、SHA一致を確認した。

### 目的と到達状態

Gateway常駐とCLIの同一状態rootに、SQLiteのプロセス間exclusive leaseを接続する。lease取得に成功した一processだけが保存済み起動世代／execution epochを進め、永続ExecutionIntentへepochを渡す。owner epochの検査を承認発行、Executorの作用境界、worker観測、結果receipt保存に接続し、lease喪失後の旧processが新しいdispatchや共有receipt更新を始めないようにする。常駐serveはshutdown時に実行中taskを収束させた後でleaseを解放する。

### 対象と境界

- 対象：`apps/gateway/src/runtime_owner_lease.ts`、`apps/gateway/src/serve.ts`、`apps/gateway/src/runtime.ts`、`packages/blue-tanuki/src/execution_intent.ts`、`packages/blue-tanuki/src/executor.ts`、限定test、`docs/開発進捗.md`、`docs/ROADMAP.md`。
- 起動時にowner-state schema version・SQLite integrity・保存epochを検査し、破損・unsupported schema・重複owner・lease喪失ではfail-closedする。秘密・command本文・raw receiptをowner metadataやログへ保存しない。Unix modeはprivate directory/fileへ限定する。Windows ACLの保証範囲は観測可能な既存環境に限り、未確認を明示する。
- 最小の実接続は、同一state rootで別processの二重owner拒否、restart後epoch更新、lease喪失後のExecutor作用拒否。既存HDS／Approval Gate／L3／Broker／M、E03.02起動reconciliationを維持する。
- 外部業務作用、実provider・credential、C08.03、D4Pocket／ミニドラ別repo、分散filesystemを使ったlease保証、全体QE_QC／QE_QA、P13公開・出荷判断は対象外。in-flight外部作用の中断を保証したと主張しない。
- OS単位のACL検査または全production dispatchのfencingが不足する場合は安全保護を弱めず、具体的な`BUILD_GAP`と次consumerを記録する。

### 最小確認

owner leaseのschema／世代／process間排他／喪失後拒否を対象にした限定test、Executor guardの作用非到達確認、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`を実行する。live serve／実credential／外部作用は実行しない。

### 実施結果

`pnpm exec vitest run apps/gateway/test/runtime_owner_lease.test.ts packages/blue-tanuki/test/executor_owner_guard.test.ts --maxWorkers=1 --minWorkers=1`は2 files／3 tests PASS。別Node processでの二重owner拒否、再取得時のgeneration／execution epoch更新、unsupported schema時fail-closed、承認後lease喪失でのtool非dispatchとreceipt非完了を確認した。`pnpm typecheck` PASS、`pnpm build` PASS（15 workspace projects）、`pnpm docs:check` PASS（日本語基底移行負債77件を維持）、`git diff --check` PASS。

E03.01は、Windows local filesystemでのSQLite process exclusionとGateway Executor fenceを接続した部分実装として`BUILD_GAP`を維持する。Windows ACL検査、network filesystemのlock、実行中にすでに外部adapterへ渡った作用の停止、旧generation receiptの分離は未確認・未接続。live serve／実credential／実provider／外部作用は未実施。

### Git・停止条件

通常成果を限定commitとして`main`へpushし、push後にremote HEAD、local二世代recovery branch、remote二世代backup tag、clean stateを再照合する。owner leaseの破損・重複・喪失が作用継続または二重ownerを許す場合はdispatchを無効のままにする。E03.01／QEB-03全体の完成宣言は行わない。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
