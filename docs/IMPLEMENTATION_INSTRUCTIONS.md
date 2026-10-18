# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。新しいBUILD_BATCH開始時に、owner指定のQE rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、直前指示、最新HEAD／差分、E03.03原文とJ/Broker ledger producer／consumerを読み直した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-PLAN-BROKER-LEDGER-CORRELATION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`0456640657249b5d641044274abee05eb8236747`、開始時clean。作業前にlocal復旧branchとremote backup tagを現世代`0456640657249b5d641044274abee05eb8236747`、前世代`fda958820347762271ee9cd0d54ae78ac78f973e`へCAS／期待SHA付きで回転し、local二branch・remote二tag・mainのSHA一致を確認した。backup ref移行=`MIGRATION_COMPLETE`。

### 目的と到達状態

既存Gateway `--recovery-inspect`へ、J OperationPlan checkpointの厳密なread-only inspectionと、J binding／Broker execution-intent recordのadmission digest相関を接続する。J checkpointの行digest・schema・plan revision／step／result binding／command key／ticket uniquenessを検査し、既存Brokerのhash-chain／projection／outbox検査結果と照合する。J/M間のresult-memory commit／receiptは未照合として残す。正常・欠損・不一致・破損・記録上限による未観測を区別したopaque digest／固定enumの残差を返す。

### 対象と境界

- 対象：J plan-state read-only inspector、新しい`--recovery-inspect` report／text summaryへの接続、focused test、`docs/開発進捗.md`、`docs/ROADMAP.md`、本指示。
- Jの書込store constructor、`OperationPlanLedger`、通常Gateway起動／lease、HDS判断・Approval、Broker書込・Executor・M保存・再生・repair／restore／resume／retryは呼ばない。
- reportにraw plan／step／command／ticket／goal／owner／channel／target／arguments／output／worker／delivery本文、DB絶対pathを出さない。含めるのはopaque digest、固定状態enum、照合区分、残差件数のみ。すべて`used_for_authority=false`、`may_execute=false`を保つ。
- J checkpoint digestは同一DB内の整合検査であり、認証済anchor・独立backup・restore pointではない。Broker record未観測はrecord上限を考慮する。未検証BrokerをJ binding不一致として断定しない。
- 読取は既存DBに限定し、symlink・SQLite sidecar・schema違い・journal不適合はfail-closedで開かない。検査によってDB／parent dir／sidecarを作成・変更しない。依存追加、外部provider／資格情報／外部業務作用、他repo変更は行わない。
- 独立backupの存在・完全性・restore可能性、実restore、operator recovery UI、全体QE_QC／QE_QA、SYSTEM_SHAPED／BUILD_COVEREDは今回の対象外。E03.03／QEB-03は`BUILD_GAP`を維持する。

### 最小確認

合成J checkpointとBroker ledgerで一致・不一致・上限未観測・破損時のfail-closedを確認する。valid sibling bindingを不一致の影響で捨てない。J checkpoint／Broker DB bytesが検査前後で不変であり、空state rootを作らず、sidecar検出時に開かないことをfocused testで確認する。Gateway focused suite、`pnpm typecheck`→`pnpm build`、built CLIの一回の未作成root smoke、`pnpm docs:check`、`git diff --check`を行う。

### 実装・限定確認の結果

- Gateway recovery focused suite（repo root、2 workers固定）：PASS、2 files／11 tests。J/Broker admission完全一致、異ticket不一致、健全binding保持、checkpoint digest破損時の全件抑止、bindingなしplanのrevision残差、sidecar時open抑止、検査前後のDB bytes不変を確認。
- `pnpm typecheck`：PASS、exit 0。初回はreport型の追加field漏れで失敗し型修正後に再実行した。
- `pnpm build`：PASS、exit 0、15 workspace projects。
- build済み`--recovery-inspect --json`／text：未作成state rootでいずれもexit 2の残差報告。J Operation Plans unavailableを表示しrootは作られない。
- `pnpm docs:check`：PASS。文書、日本語基底通常gate、license。Markdown 186、移行負債77件。
- `git diff --check`：PASS。

このread-only検査は独立backup／restore pointではなく、J/M result-memory相関も未実装で、権限・resume・retry・repair・restoreを発行しない。E03.03／QEB-03=`BUILD_GAP`、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。実state root、外部作用、他repo変更は対象外。

### Git閉包

編集前復旧参照はlocal branch `codex/backup-main`=`0456640657249b5d641044274abee05eb8236747`、`codex/backup-main-prev`=`fda958820347762271ee9cd0d54ae78ac78f973e`、remote tagも同名・同SHAで一致。focused suite 11/11、typecheck、15-workspace build、JSON／text CLI smoke、docs gate、diff checkはPASS。実装commit=`a127b8bc4fb13f1cf52645dea87989e7aea1eefb`を`main`へpush済み。push前remote main=`0456640657249b5d641044274abee05eb8236747`からfast-forwardし、再fetch後local／remote main同SHA、二世代ref一致、clean treeを確認した。記録閉包の文書commit／push後に最終同期状態を確認する。remoteに他writerの進行があれば上書きせず再同期する。
