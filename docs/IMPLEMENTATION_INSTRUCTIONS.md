# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。rev2.3 pinとbackup ref移行=`MIGRATION_COMPLETE`。`QEB-34-E06.03-GOAL-CHANGE-PROPOSAL-BOUNDED-REOPEN`では、Cの未信頼目的変更提案を実発行済みLLM command・成功feedback・監査鎖・一致したconflict scope・現行delegated goalへ照合し、条件を満たすものだけowner候補として保持する。owner専用no-store入口から候補と完全一致する内容を明示選択した場合だけ既存goal変更のL3 reviewへ送る。L3前にJ/Mの目的正本を変更せず、自動再計算・実行もしない。raw提案文はHDS auditに保存せず、候補はprocess-localで64件に制限し、goal版・audit・source traceの変化で無効化する。この限定経路を`WIRED`とするが、E06親全体と製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

workspace `pnpm typecheck`／`pnpm build`、HDS goal governance 15 tests、Executor/OpenAI 23 tests、WebChat 105 tests、Gateway owner L3経路1 testはPASS。Gateway fileの残る3 testsは今回の対象filterで未実行。全workspace suite、実provider／credential／外部業務作用、5OS実機、QE_QC／QE_QAは未実施。製品全体は`BUILD_GAP`のまま。C08.03実provider保留、D4Pocket／ミニドラ別repo変更なし、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
## 次のBUILD_BATCH

`QEB-35-E07.01-PARENT-GOAL-DELEGATION`として、agent分担・比較・監査roleを親goal・criteria・終了条件へ結ぶ実consumerを調査・接続する。child budgetと再帰深度は親へ予約したresource/capability契約で制御し、agent出力はC候補に留める。対象・現consumer・停止条件は最新版三点セットのE07.01と現行コードから組み立てる。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
