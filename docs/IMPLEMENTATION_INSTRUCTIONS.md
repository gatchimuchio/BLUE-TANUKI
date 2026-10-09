# BLUE-TANUKI 有効な実装指示

現単位: **C07.03 — 誤記憶の隔離・旧解釈・再帰還**。ownerが委任した範囲から一単位だけを扱う。Windows / PowerShellを通常の開発環境とし、WSLを必須にしない。GitHubは検証済み成果と履歴の保管庫として、単位ごとに二世代backup、commit、push、remote照合まで行う。外部業務作用、cross-repo、公開主張、出荷判断、owner GOは今回の範囲外。

## 1. 目的

承認済みのJ/M persistence path上で、汚染が確認された記憶の適用停止、再解釈の追加、過去判断の再評価要求を追記イベントとして保持する。旧解釈・根拠・失敗履歴を消さず、Mの記憶や履歴が権限・実行許可を生まないことを保つ。

## 2. Phase境界

HDS-BRAIN内のpackage-internal J/M persistence pathとtest-owned一時SQLiteに限定する。C07.02のJ承認参照・M commit・receipt再照合を通し、正例は隔離後にstoreを再openして再解釈を復元する。synthetic readerは実owner承認ではない。通常Gateway consumer、実owner承認producer、Control Center、外部業務作用は未接続のままとする。

## 3. Scope

- `packages/hds-brain/src/制御状態.ts` — target memory recordの読取専用 projectionを追加し、non-authority flagを固定
- `packages/hds-brain/src/記憶再解釈.ts` — 厳密なlineage/state parser、追記専用quarantine/restore transition、承認済みJ/M consumer
- `packages/hds-brain/test/記憶再解釈.test.ts` — 専用positive/negative SQLite検証
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`
- `規定/移行台帳.json` — 既存CHANGELOG負債のSHA-256だけを同期

この一覧以外は変更しない。追加が必要なら編集前にprivate施工記録をREPLANし、state・scope・参照の鮮度を再照合する。

## 4. Non-goals

C07.01の取得・proposal、C07.02のJ/M内容結合の再設計、proposalからMemoryCommitへの変換、一般memory migration、旧`LongTermMemoryStore`/Gatewayへの接続、判断の自動再実行、UI、実owner承認producer、cross-repo、credential、release/GA/P13/owner GOを扱わない。HDS package barrelへ未接続APIを公開しない。

## 5. 最初に確認するfiles / symbols

`JMemoryCommitCoordinator.stage/apply/reconcile/snapshot`、`JControlStateStore`のapproval参照・M receipt照合、`MemoryUpdateLedger`、`MTransactionStore`のevent replay/derived projection/recovery、`MemoryCommitV2`、`packages/hds-brain/test/制御状態.test.ts`と`記憶更新.test.ts`を確認する。`LongTermMemoryStore`とGatewayの実呼出し元も検索し、今回のconsumerと未接続のproduction経路を区別する。

## 6. 必須grep

`BT-R-C07-04`、`BT-R-C07-05`、`BT-U-C07.03`、`BT-T-C07-04`、`MemoryInterpretationConsumer`、`MemoryCommitV2`、`JMemoryCommitCoordinator`、`readMemoryRecord`、`m_events`、`expected_version`、`content_digest`、`used_for_authority`、`may_execute`、`LongTermMemoryStore`を検索する。unknown/malformed input、旧根拠の削除、二重/古いevent、期待版不一致、J未承認、receipt不一致、store障害が成功・権限・実行へ丸められないことを確認する。

## 7. 既存anchor

Mの`m_events`はappend-onlyで、`m_records`はevent replayから復元するcurrent projectionである。generic upsert/deleteだけでは誤記憶の状態遷移や過去判断への影響返却を保証しない。C07.02のcoordinatorはJの正確なapproval referenceをstageし、M transaction内で再照合してからcommit・receiptを保存し、その後Jへ確認eventを追記する。C07.02経路とlegacy JSONL/Gateway経路は別物であり、通常production callerと実owner承認producerは未接続。

## 8. 実装要件

### 実装前に固定する観測と受入入力

比較対象: 初期記憶`lineage:test-policy`、旧解釈`interpretation:v1`、basis `source:policy-v1`、依存する過去判断`judgment:trip-001`と`judgment:trip-002`。正例は旧解釈をquarantineして現在適用先を空にし、追加eventで`interpretation:v2` / `source:verified-v2`をrestoreする。両解釈と旧basisを残し、両過去判断へ`reassessment_required`を返す。専用selectorは`packages/hds-brain/test/記憶再解釈.test.ts -t 'BT-U-C07\\.03-[PN]'`。比較先は各M revision/event digestと、J lifecycle snapshot・event/receipt件数。故障点はquarantine後のclose/reopenで、restore後に同じlineage/historyが検証可能なこと。

### 必須要件

1. lineage recordはschema versionと固定record IDを持ち、本文・basis・digestを含む解釈、event、依存judgmentを厳密検査する。未知field、重複ID、参照不一致、invalid digestは拒否する。
2. quarantineは汚染対象の現在解釈とその依存判断だけを指定し、適用pointerを空にする。原因/evidenceはdigest・参照として追加eventに記録する。
3. restoreはquarantine状態から新しい解釈を追加し、旧解釈・旧basis・quarantine eventを保持したままcurrent pointerを新解釈へ移す。影響を受けた過去判断は再評価要求のまま返す。
4. 受入consumerは一つの承認済みMemoryCommitV2による一つのupsertだけを受け、現在M recordからtransitionを再計算して完全一致を確認する。delete、上書き型履歴、古い期待版、未知fieldはJ/M write前に拒否する。
5. 正当なcommitはJ stage、M transaction/receipt、J reconcileを通す。旧・新の意味本文は承認済みM event/current projectionへ保持し、J audit・診断には本文を出さずdigest/参照だけを残す。M recordは`used_for_authority=false`、`may_execute=false`を保持する。
6. APIはpackage-internalのままにし、既存Gateway memory consumerへ静的importしない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、J Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、standalone、fail-closedを維持する。C出力、metadata、memory、CompleteHistory、fixtureは承認でない。過去判断の再評価要求は自動再実行・自動承認を行わず、M内の状態投影は権限を生成しない。

## 10. Operator usability

snapshot/readは「適用中」「隔離中」「再評価要求」を明確に分ける。quarantine中にcurrent interpretationを返さず、restore後もaffected judgment refsを未解決として可視化する。失敗時はJ/M stateを成功表示せず、原因分類と再試行・復旧の境界を返す。raw memory content、credential、外部metadataを診断出力へ含めない。

## 11. Tests

- `BT-U-C07.03-P`: 合成J approval readerとtest-owned SQLiteで初期旧解釈を保存し、quarantine event、store再open、restore eventを通す。両解釈、旧basis/event、再評価対象、J/M hash/receipt整合、non-authority flagを観測する。
- `BT-U-C07.03-N`: 正しいdigestを再計算した改ざんcandidateで旧解釈を消去、またはnon-authority flagをtrueへ変更する。J/Mへ一切writeせず拒否し、元record/event/receiptとJ ready stateが不変であることを観測する。
- selector: `pnpm exec vitest run packages/hds-brain/test/記憶再解釈.test.ts -t 'BT-U-C07\\.03-[PN]'`。実行件数・skip数を記録し、0件はPASSにしない。
- 親scenarioはBT-T-C07-04の局所的な復帰条件だけを接続する。BT-T-C07-01/02/03とBT-T-C07-04全体の受入は未実施として保持する。

## 12. Validation commands

commit前の必須検証:

```text
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
```

正負selectorと関連するJ/M persistence testを追加実行する。失敗は今回起因・既存・環境限定・未確定に分けて保持する。credentialを読まず、既存processを停止しない。`smoke:serve` / `smoke:resume`はgateway/runtimeを変更しない本単位ではscope外として扱い、release gate・strict Japanese-base・credentialed live smokeも未実行と記録する。

## 13. Manual smoke

実test selectorを合成MemoryCommit、synthetic approval reader、test-owned一時SQLiteで実行する。quarantine後にclose/reopenして状態を再読し、J承認照合を経る別commitでrestoreする。production credential、既存runtime store、Gateway、UI、外部送信先、実toolは使用しない。

## 14. Permanent-use check

この単位で成立するのはHDS内部の追記型解釈lineage、quarantine/restore投影、依存判断への再評価要求、J/M persistence pathを通る局所合成証拠まで。通常production caller、実owner承認producer、Gateway/UI統合、installed/live、親C07全scenario、release readinessは成立しない。記憶が意思決定や実行権限を付与するものではない。

## 15. Final report format

C07.03の局所受入、変更path、実consumerと未接続境界、正負selector、必須commandの正確な結果、証拠源/経路、doctorまたはhost制約、未実行、authority/release/P13状態、main commit、push/remote HEAD、二世代backup refs、rollback pointを日本語で報告する。親C07を完了扱いしない。この単位のclosure後は境界停止し、次候補を自動着手しない。

## 16. Next-phase dependency

この単位のclosure後は境界停止し、親C07や次の兄弟単位を完了・開始扱いしない。次候補は最新private state、依存証拠、許可scopeを新しい入口から再照合する。
