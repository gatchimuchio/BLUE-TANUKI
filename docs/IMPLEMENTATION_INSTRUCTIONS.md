# BLUE-TANUKI 有効な実装指示

現単位: **C07.02 — J承認とM反映の内容結合**。owner が委任した範囲から一単位だけを扱う。Windows / PowerShell を通常の開発環境とし、WSL を必須にしない。GitHub は検証済み成果と履歴の保管先として、単位ごとに二世代backup、commit、push、remote照合まで行う。公開主張、外部業務作用、出荷判断、owner GO はこの委任に含まれない。

## 1. 目的

承認済みのMemoryCommit内容をJとMの保存境界へ結び、承認・M反映・receipt確認を別状態として観測できるようにする。承認後の内容変更は同じ承認で反映させない。

## 2. Phase 境界

HDS-BRAIN内の既存J/M persistence pathと専用SQLite fixtureに限定する。J pending記録、M transaction/receipt、J receipt再照合をつなぐ。合成readerをowner承認や実アプリ接続の証拠として扱わない。

## 3. Scope

- packages/hds-brain/src/制御状態.ts
- packages/hds-brain/test/制御状態.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（既存CHANGELOG debtのSHA-256だけを同期）

この一覧以外を変更しない。追加pathが必要なら編集前にprivate施工記録をREPLANし、stateとtask packetを更新・再照合する。

## 4. Non-goals

C07.01のobservation/proposal、C07.03の誤記憶隔離・再解釈・復元、proposalからMemoryCommitへの変換、Gateway/UI/Control Center統合、実owner承認producer、外部業務作用、cross-repo、credential、release/GA/P13/owner GOを扱わない。標準HDS package barrelに未接続APIを公開しない。

## 5. 最初に確認する files / symbols

JMemoryCommitCoordinatorのstage/apply/reconcile/snapshot、JControlStateStore.stage/readVerifiedMemoryApproval/reconcile、MemoryUpdateLedger、MTransactionStore.applyApprovedMemoryCommit/readReceipt、parseMemoryCommitV2、receiptMatchesPending、packages/hds-brain/test/制御状態.test.ts、packages/hds-brain/test/記憶更新.test.tsを確認する。repo-wide caller検索でproduction consumerの有無を明示する。

## 6. 必須grep

JMemoryApprovalReader、JMemoryCommitCoordinator、MemoryUpdateLedger、applyApprovedMemoryCommit、readVerifiedMemoryApproval、MemoryCommit、receipt、expected_version、content_digest、lifecycle_state、BT-U-C07.02を検索する。未知・不一致・承認後の内容差替え、M receipt不在/不一致、J/M保存障害が自動許可や成功表示にならないことを確認する。

## 7. 既存 anchor

JControlStateStoreは検証済み承認参照のupdate_id、J event ID、content digest、expected M versionだけをpendingへ保存する。Mは自身のtransaction内でJ pending参照を再照合し、state/event/update ID消費/receiptを確定する。J reconcileはM receiptを読み取り、J event chainへ確認結果を追記する。現在、通常production callerと実owner承認producerは未接続である。

## 8. 実装要件

1. cross-store snapshotで承認済み、M反映済み、receipt確認済みをそれぞれapproved、applied、effect_confirmedとして区別する。保存系の不整合・利用不能は別状態にする。
2. J承認参照とMemoryCommitのupdate ID、J event ID、canonical content digest、expected versionを完全一致させる。
3. 承認後に異内容で再計算したdigestを持つcommit、booleanだけの承認、unknown field、古い期待版を拒否しM状態/receiptを変えない。
4. M receiptはevent/stateと同一transactionの結果だけをappliedとして扱う。J receipt確認eventがなく、またはM receiptの一致がない状態をeffect_confirmedとしない。
5. J auditにraw memory contentを保存せず、existing hash-chain、復旧、standalone境界を維持する。
6. proposal消費、通常アプリ接続、public API追加、別store schema変更を今回へ持ち込まない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、HDS standalone、fail-closedを維持する。C出力、UI、metadata、履歴、fixtureは承認ではない。snapshotは照合用投影であり権限を生成しない。

## 10. Operator usability

状態名は承認済み/反映済み/後続receipt確認済みを区別し、receipt mismatchとstore unavailableを成功状態へ丸めない。snapshotには既存のdigest/metadataのみを出し、raw memory contentやcredentialを出さない。実consumer未接続とfixture範囲を明示する。

## 11. Tests

- BT-U-C07.02-P: packages/hds-brain/test/制御状態.test.ts の専用SQLiteでapproved -> applied -> effect_confirmedを観測し、J/M整合、再起動後receipt照合、J eventのraw content非保持を確認。
- BT-U-C07.02-N: 承認後、同じupdate ID/J event IDで異なるchangesと正しい新digestを持つcommitへ差し替え、j_approval_not_verified、M event/receipt不変、元commitの継続可を確認。
- 既存のreceipt mismatch、expected version、boolean-only、hash-chain/recovery負例を保持する。

selector: pnpm exec vitest run packages/hds-brain/test/制御状態.test.ts -t 'BT-U-C07\.02-[PN]'。選択された2件とskip数を記録し、0件実行をPASS扱いしない。

## 12. Validation commands

commit前に現行repoの必須検証を実行する。

~~~
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
~~~

失敗は今回起因、既存、環境限定、未確定に分類する。doctorで既存Gatewayやcredentialを停止・読取りしない。smoke:serve/resumeはこの単位のscope外。release/bundle gate、strict Japanese-base gate、credentialed live smokeは受入範囲外と記録する。

## 13. Manual smoke

実test selectorを合成MemoryCommitとtest-owned一時SQLiteで実行する。実provider、実owner承認、既存runtime store、外部送信先、credential、実toolを使用しない。positive/negativeのほか、既存故障・復旧selectorを対象とする。

## 14. Permanent-use check

この単位で成立するのはHDS内部のJ/M persistence path、content binding、M receipt読取、J receipt確認eventと合成SQLite証拠まで。通常production caller、実owner承認producer、Gateway/UI統合、installed/live、親C07、release readinessは未成立のまま維持する。

## 15. Final report format

C07.02局所受入、変更path、実consumerと未接続境界、positive/negative selector、各必須commandの正確な結果、証拠源/経路、doctorまたはhost制約、未実行、authority/release/P13状態、main commit、push/remote HEAD、二世代backup refs、rollback pointを日本語で報告する。fixture/local evidenceをlive/installed/external evidenceに読み替えない。

## 16. Next-phase dependency

この単位の局所受入とGit閉鎖を記録して停止する。親C07完了やC07.03開始を推定しない。次単位は最新private state・ledger・repo状態から別の入口で依存、profile、許可scopeを再照合する。