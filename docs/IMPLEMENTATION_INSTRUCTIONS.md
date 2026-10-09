# BLUE-TANUKI 有効な実装指示

直近施工単位: **C08.02 — 中核境界ごとの停止・復帰**。この単位の有限受入・必須検証・Git閉鎖を記録し、境界で停止する。Windows / PowerShellを通常の開発環境とし、WSLを必須にしない。GitHubは検証済み成果と履歴の保管先であり、単位ごとに二世代backup、commit、push、remote照合まで行う。環境構築、C08.03、親C08の一括完了、実provider、実資料、外部業務作用、公開主張、release/GA、出荷判断、owner GOは今回の範囲外。

## 1. 目的

C08.01で接続した一時資料整理経路を、C/J/Mの中核境界で中断・再起動しても最後の確認済みJ状態から達成または正当保留へ導く。達成後は追加計算を停止し、未確認のM世代では次のC cycleへ進まない。今回の成立範囲は親C08の部分であり、親全体やOpenClaw/Muse上位互換の成立を意味しない。

## 2. Phase境界

通常Gateway CLI `--organize` とWebChat `/organize`から使うJチェックポイント復帰を対象とする。SQLiteにはactor/source digest、M世代digestと件数、Jの状態・cycle/revision・確定span offset・限定issue/reasonだけを保存する。原文、引用、C応答、分類label、credentialは保存しない。C08.01のM候補読取・capture・Executor session抑止とHDS Approval Gate / Executor / HDS-BRAIN権限境界を維持する。試験は合成入力とtest-owned loopback provider・一時領域だけを使う。

## 3. Scope

開始記録で固定し、有限受入に必要な次のpathだけを変更する。

- `packages/hds-brain/src/document_organization.ts`
- `packages/hds-brain/src/controller.ts`
- `packages/hds-brain/src/output_audit.ts`
- `packages/hds-brain/src/types.ts`
- `packages/hds-brain/src/index.ts`
- `packages/hds-brain/src/long-term-memory/store.ts`
- `packages/hds-brain/src/long-term-memory/types.ts`
- `packages/hds-brain/src/long-term-memory/index.ts`
- `packages/hds-brain/test/document_organization.test.ts`
- `packages/hds-brain/test/output_audit.test.ts`
- `packages/hds-brain/test/long_term_memory.test.ts`
- `apps/gateway/src/document_organization_checkpoint_store.ts`
- `apps/gateway/src/document_organization_runtime.ts`
- `apps/gateway/src/runtime.ts`
- `apps/gateway/src/serve.ts`
- `apps/gateway/test/document_organization_entry.test.ts`
- `AUDIT.md`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`
- `規定/移行台帳.json` — 変更したAUDIT / CHANGELOGの既存負債hashだけを同期

追加のruntime/test scopeはない。別pathが必要になった場合は開始記録をREPLANしてから作業する。

## 4. Non-goals

C08.03の実C縦断、BT-T-C08-01/02/04全体、親C08全体、実資料の意味正しさ、実provider/live/installed、外部業務作用、別repo/channel/surface、製品release/GA/P13/owner GO、私有rev1.1原典・施工packの公開は扱わない。通常の検証済みsourceと作業報告のGitHub保存はownerの明示指示に従い、上記私有物・秘密・raw runtime evidenceは含めない。

## 5. 最初に確認するfiles / symbols

`DocumentOrganizationCoordinator`のsnapshot/checkpoint/restore、`LongTermMemoryStore.stateVersion()`とhash-chain検査、HDS-BRAIN `documentOrganizationMemoryVersion()` / projection output audit、Gateway checkpoint storeのtransaction/CAS/schema、`prepareDocumentOrganizationSession`と`runDocumentOrganizationTask`、CLI `runCli`、WebChat inbound consumer、Approval Gate / Executor / dispatcher、CompleteHistory・audit・sessionの保存payloadを追う。テストが起動するprocess、provider、port、file rootとcleanupも確認する。

## 6. 必須grep

`document_organization`、`j-checkpoints.sqlite`、`compareAndSet`、`stateVersion`、`memory_state_changed`、`memory_state_unverified`、`j_projection_output_audit`、`DOCUMENT_ORGANIZATION_PROMPT_PREFIX`、`memory_capture_suppressed_for`、`recordCompleteHistory`、`used_for_authority`、`may_execute`、`may_commit_to_memory`を検索する。checkpointへのraw本文・quote・C response・section label流入、actor/source binding、span再構成と重複、SQLite integrity/CAS/capacity、M世代の前後比較、terminal restore後のC実行、CLI/WebChat経路差、再表示時のM capture、監査・履歴への本文流入を確認する。

## 7. 既存anchor

C08.01が閉じたGateway CLI/WebChat通常経路、HDS Approval Gate / Executor、HDS-BRAIN Jとhash-chain audit、既存CompleteHistory、通常LongTermMemoryStoreを維持して拡張する。HDS-BRAINだけが権限判断を担う。checkpointは復帰用の非権威状態であり、SQLiteや下流投影を第二authorityにしない。memory世代の照合はHDS-BRAINのdigest-only APIを使う。

## 8. 実装要件

1. 継続中のJ確定状態だけをcheckpointへ保存し、actor/channel/source digestへ束ねる。JSON schema、exact fields、status/cycle/revision/span/reasonの整合、checkpoint digestを検査し、CAS競合・破損・容量上限はfail-closed holdにする。
2. restoreは再送された同一本文をdigest照合し、offsetから引用を再構成する。過去Cのlabelを復活させず、中立な「再起動復旧済み範囲」として表示する。未知status、source差替え、範囲不正、偽completion、未知hold理由は拒否する。
3. Mのhash-chain検証済みgeneration digest/countを記録し、再開時および各C実行の直前・直後に再照合する。未検証・変更済み世代で次cycleを実行せず、理由付きholdを永続checkpointへ反映する。
4. completed/heldのterminal checkpointはCを呼ばず、HDSのdigest-only projection-output auditを通して表示する。再表示のためのHDS要求も一時資料整理のreader/capture/session抑止を維持し、Mを変更しない。
5. CLIとWebChatで同一session準備・restore・runner・rendererを使う。checkpointは上限128、terminal行のみ容量回収の対象とし、進行中taskを黙って削除しない。ownerの既存listener、credential、実ファイル、実providerには触れない。
6. 合成process E2Eでは、J確定後のC実行中にtest-owned Gateway processをkillし、同じ隔離storeで再起動して残りを完了する正例と、再起動前のM generation変更でC未実行のholdとなる負例を確認する。terminal再入力がC/Mを変更しないこと、保存物にsource・quote・C labelがないことを確認する。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、standalone、fail-closedを維持する。checkpoint、memory generation digest、J projection、監査・historyは権限ではない。C出力・履歴・metadataから承認、実行、memory commitを作らない。raw invalid inboundは通常経路へ渡さない。資料本文・引用・C出力を長期記憶、checkpoint、audit、CompleteHistory、sessionへ保存しない。terminal再表示と失敗時holdで新規Cを呼ばない。

## 10. Operator usability

`completed`と`held`を区別し、hold時は`memory_state_changed`、`memory_state_unverified`、checkpoint integrity/capacity等の有限理由、引用済み範囲、未被覆範囲、次 actionを安全に表示する。process再起動は同じactor/sourceをownerが再送したときだけ復帰する。holdを自動再開・M変更の承認・成功へ読み替えない。

## 11. Tests

- HDS正例: `pnpm exec vitest run packages/hds-brain/test/document_organization.test.ts -t BT-U-C08.02-P` — source/C labelを含まないcheckpoint、完全一致offset復旧、残り範囲処理、非権威flag。
- HDS負例: `pnpm exec vitest run packages/hds-brain/test/document_organization.test.ts -t BT-U-C08.02-N` — source/span改変、偽completion、未知hold理由、未検証Mのhold。
- process正例: `pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts -t BT-U-C08.02-P-E2E` — test-owned CLI/provider kill・restart、J span復帰、完了後C停止、M不変、永続物raw不在。
- process負例: `pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts -t BT-U-C08.02-N-E2E` — 再起動間M generation変更、C未実行のholdとraw不在。
- `packages/hds-brain/test/long_term_memory.test.ts`でdigest-only generationと外部ファイル変更検出、`packages/hds-brain/test/output_audit.test.ts`で復旧projectionのhash-chain記録を確認する。
- 証拠はWindows local-integrationの合成FIXTUREとtest-owned process/fileのINTERNAL_STATE。親BT-T-C08-03のprocess境界部分だけを局所的に扱い、BT-T-C08-01/02/04や親全体をPASSにしない。
- E2Eはbuilt artifactを起動する。`pnpm typecheck`後は`pnpm build`を再実行してからE2Eを起動し、並列実行でdistを競合させない。

## 12. Validation commands

commit前に次を順番に実行し、exit値と結果を記録する。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
pnpm run doctor
pnpm validate:packaging
pnpm hds:standalone
pnpm validate:japanese-base
pnpm smoke:serve
pnpm smoke:resume
pnpm exec vitest run packages/hds-brain/test/document_organization.test.ts -t BT-U-C08.02-P
pnpm exec vitest run packages/hds-brain/test/document_organization.test.ts -t BT-U-C08.02-N
pnpm exec vitest run packages/hds-brain/test/long_term_memory.test.ts
pnpm exec vitest run packages/hds-brain/test/output_audit.test.ts
pnpm build
pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts -t BT-U-C08.02-P-E2E
pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts -t BT-U-C08.02-N-E2E
git diff --check
```

doctorでcredential不足や使用中listenerが見えても値を読んだりprocessを停止せず、今回差分・既存host・環境限定に分類する。失敗、timeout、0件、skipはPASSに丸めず、再試行もattemptとして記録する。`pnpm validate:agi`、credentialed live、release/GA/bundle、installed、strict Japanese-baseは今回範囲外。

## 13. Manual smoke

専用process E2Eがtest-owned loopback fake provider、CLI child、SQLite/file rootを使ってkill/restart、再表示、holdを確認する。手動のowner Gateway、listener PID 17740、外部provider、実資料、credentialed channelへは接続しない。実機OS crash耐久性やlive provider適合を主張しない。

## 14. Permanent-use check

C08.02はC08.01の一時資料整理を局所再開可能にする範囲であり、汎用job scheduler、編集・訂正・検索、実C、恒久的記憶化を加えない。起動信頼性、容量整理、schema migration/repair、installed product、長時間運転、他OSはこの単位の証拠外である。完了後も親C08、release gate、P13 owner GOを未完了のまま保つ。

## 15. Final report format

日本語で、成立した正負条件、変更path、HDS/authority境界、経路分類と証拠source分類、実行した正確な検証とexit、失敗・未実施・host制約、残存リスク、P13/public claim状態、branch/commit、pushとremote HEAD、二世代backup refs、rollback pointを記録する。local syntheticをlive/runtime/release readinessへ拡張しない。全Git closure条件が終わるまでは単位をcompleteと報告しない。

## 16. Next-phase dependency

C08.02のfinite acceptance・必須検証・文書整合・二世代backup・commit/push・remote照合の後、この単位で停止する。次候補はC08.03だが、本記録から実providerや次の兄弟単位へ編集を続けない。再開時に最新private state、C08.02のdependency/Git evidence、mode/profile、ownerの委任と公開範囲を新しい入口から再同期する。
