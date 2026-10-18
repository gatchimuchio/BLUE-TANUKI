# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。E03.03の次BUILD_BATCH開始時に、owner指定のQE rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、直前指示、最新HEAD／差分、E03.03原文と実行台帳consumerを読み直した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-EXECUTION-LEDGER-READONLY-INSPECTION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`fda958820347762271ee9cd0d54ae78ac78f973e`、開始時clean。編集前のlocal recovery branch／remote backup tagは現世代`fda958820347762271ee9cd0d54ae78ac78f973e`、直前`06474e29ee965f90adbae135b533a1bcb2fb0334`へCAS／期待SHA付きatomic pushで回転し、local branch pair・remote tag pair・mainの実SHA一致を確認した。backup ref移行=`MIGRATION_COMPLETE`。

### 目的と到達状態

前バッチで接続したGateway `--recovery-inspect`へ、Brokerの私有execution-intent SQLite台帳の読取専用検査を接続する。実行event hash chain、receipt projection、result outboxを既存runtime検査と同じ契約で照合し、健全な台帳の非権威なdigest／状態要約、または再生可能prefix・未検証suffix・未照合残差を返す。Gateway通常起動、Owner lease、HDS生成に依存しない診断経路とする。

破損／未検証suffixがあるときは、suffix由来のticketや状態を信頼済み仕事として表示しない。診断はJ/Mの検査・照合と同じreportへ統合し、権限・承認・実行可否を生成しない。検査によるDB byte変更・schema作成・journal mode変更がないことを合成DBで確認する。

このバッチだけでE03.03、回復可能な仕事の再開、確認済みbackup、実restore、SYSTEM_SHAPED、BUILD_COVERED、QE_QC／QE_QAは成立しない。E03.03は`BUILD_GAP`のまま保つ。

### 対象と境界

- 対象：Gateway execution-intent台帳のread-only inspector、Gateway `--recovery-inspect`への統合、限定test、`docs/開発進捗.md`、`docs/ROADMAP.md`、本指示。
- 既存のSQLite schema、write-side execution lifecycle、J/M ledger、Approval、Broker authority、通常startup、外部作用は変更しない。
- outputは台帳status、verified／unverified event件数、first unverified ordinal、verified event digest、opaque ticket／command／epoch digest、状態enum、outbox検査残差の数に限る。raw receipt、ticket、command、worker識別、delivery本文、credential、保存先絶対pathを出さない。`used_for_authority=false`、`execution_eligible=false`を保つ。
- 既存のSQLite read-only openとrecovery sidecar拒否を使う。検査のために書込store constructorを呼ばず、DB、親dir、sidecarを作らない。Node最小版`22.14.0`を維持し、依存追加をしない。
- 実環境DB／service、資格情報/provider、実作用、D4Pocket／ミニドラ別repo、truncate／rebuild／restore／retry／resume、独立backupの作成・検証、OS ACL/network filesystem保証、全体QE_QC／QE_QA、P13公開・出荷判断は対象外。

### 最小確認

合成SQLiteで健全なreceipt event、projection mismatch、破損suffix、WAL／journal等sidecar時のopen抑止を確認し、read-only検査前後のDB bytesを比較する。Gateway focused test、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`を実行する。変更した既存動作はfocused selectorで疎通し、実state rootは参照しない。

### 実装・検証結果

| 確認 | 実測結果 |
|---|---|
| Gateway recovery／Executor／result reconciliation focused suite（repo root、`--no-file-parallelism --maxWorkers=2`） | PASS。3 files／43 tests（`execution_result_reconciliation.test.ts` 30、`execution_intent_runtime.test.ts` 6、`recovery_inspection.test.ts` 7）。健全receipt、projection／outbox差異、破損suffix、sidecar時open抑止、DB不変、既存実行・調停動作を確認。 |
| `pnpm typecheck` | PASS、exit 0。 |
| `pnpm build` | PASS、exit 0。15 workspace projects。 |
| built Gateway `--recovery-inspect --json`、未作成一時state root | exit 2で`residuals_present`。J／M／Broker台帳 unavailable、checkpointなし。一時state rootは作成されず、repair／restore／retry／resumeなし。 |
| `pnpm docs:check` | PASS、文書・日本語基底通常gate・license。日本語基底移行負債77件を維持。 |
| `git diff --check` | PASS。 |

最初のprocess fixture付きfocused suiteは`apps/gateway`をcwdにして起動したため、repo-root基準fixture pathが解決されずtimeout／派生失敗になった。製品コード・timeoutを変更せずrepo rootから2 workersで再実行し43 testsがPASSした。これはtest harnessの起動位置差として記録し、実行経路の合格証拠へ混同しない。

実state root、独立backupの検証、restore／修復、credentialed provider、実外部作用、5OS実機、全体QE_QC／QE_QAは未実施。この検査は稼働中データや独立backupの復元可能性を証明しない。

### Git・停止条件

実装・記録commitを`main`へpushし、remote HEAD、local二世代recovery branch、remote二世代backup tag、clean stateを照合して実測を追記する。inspectionが書込み可能な接続を使う、破損suffixから現行状態を推定する、raw ticket／command／worker／deliveryを露出する、または診断からretry／resumeを起動する場合は、その実装を停止してfail-closedを維持する。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。次のE03.03接続はJ operation-plan bindingとの照合、および独立backup／復元可能性の証明であり、このバッチでは未着手とする。
