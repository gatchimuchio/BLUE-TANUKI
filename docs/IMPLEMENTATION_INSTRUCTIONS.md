# BLUE-TANUKI 有効な実装指示

現単位: **C03.01 — M更新の原子的な確定**。`PRODUCT_BUILD_MODE`、persistence profile。本単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて停止する。ownerは全工程を一単位ずつ委任している。検証済み通常成果をGitHubへ履歴・成果物としてcommit/pushする。公開主張、実業務作用、別repo、出荷判断、owner GOは別境界である。

## 1. 目的

BT-R-C03-01/02の範囲で、厳密な版付き `MemoryCommit` とreceiptを定義し、Mがイベント、次状態、更新ID消費、receiptを**すべて反映するか、すべて反映しない**一つのSQLite取引を実装する。Jの採否権限をMへ移さず、Trinityの決定論的policy `M` と可変意味記憶Mを混同しない。

## 2. Phase 境界

protocol契約、HDS-BRAIN内のM更新API、M所有SQLite取引、合成fixtureと局所fault injection、状態所有・工程文書を扱う。新APIはHDS-BRAIN package barrel、Controller、Gateway、UI、installerから未接続のままとする。今回のテスト用J照会は、合成readerを注入する内部portの契約検査であり、実J承認consumerではない。

## 3. Scope

- `packages/protocol/src/状態更新契約.ts`、`packages/protocol/src/index.ts`、対応test
- `packages/hds-brain/src/保存取引.ts`、`packages/hds-brain/src/記憶更新.ts`、対応test
- `docs/状態所有と保存取引.md`、この指示、`docs/INDEX.md`、`docs/ROADMAP.md`、`docs/開発進捗.md`、`CHANGELOG.md`、`規定/移行台帳.json`
- 他unit、別repo、GUI、production consumer、schema migration、J/Gateway統合、release pathは変更しない

## 4. Non-goals

Jの永続化・採否・pending管理、J/M間の帰還、expected revision・再試行・同ID同内容のreceipt返却、異内容再利用時の最終contract、破損時の再構築、稼働DB移行、複数processの運用証明、OS/保存媒体crash検証、停止Broker、実ユーザーデータ、installed/live/release/GA/P13/owner GOを扱わない。重複update IDは本単位でfail closedに拒否する。重複排除の完了保証へ読み替えない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C02閉鎖証拠、B03.01配置決定、C03.01仕様を確認する。`LongTermMemoryStore.capture`、`MemoryCommitSnapshot`、protocol `index.ts`、HDS-BRAIN barrel、package standalone境界、workspace Node/pnpm pin、`node:sqlite`導入版と現host APIを読む。旧JSONL、CompleteHistory、Decision Audit、Approval Grant、sessionを新M正本として転用しない。

## 6. 必須grep

`MemoryCommit`、`MemoryUpdateReceipt`、`MemoryUpdateLedger`、`MTransactionStore`、`JMemoryApprovalReader`、`node:sqlite`、`m_events`、`m_state`、`m_updates`、`m_receipts`、`memory_used_for_authority`、`LongTermMemoryStore.capture`、`Approval Gate`を追う。raw入力、J/Gateway/UI/metadata、memory/history、fixture、LLM/tool結果から承認やauthorityを作らない。DB handleや汎用SQLを下流へ公開しない。

## 7. 既存anchor

`packages/hds-brain/src/long-term-memory/store.ts` の既存 `MemoryCommitSnapshot` は過去decision参照用であり、新しい承認済み意味記憶更新 `MemoryCommit` ではない。`packages/hds-brain/src/audit.ts`、CompleteHistory、approval store、sessionは独立保存責任を持つ。C03.01はprotocol barrelへ契約型をexportするが、HDS-BRAIN public barrelにはM更新APIをexportしない。gateway、J永続状態、Mのproduction consumerはいずれも追加しない。

## 8. 実装要件

1. strict・version付き `MemoryCommit` とreceipt schema、canonical JSON SHA-256、サイズ/深度/件数、危険key、重複record ID、digest一致を検査する。schemaは承認者を自称するfieldを持たない。
2. M APIはJ-owned approval readerを必須依存とし、update ID、J event ID、内容digestが完全一致する読取結果だけを受ける。単独booleanや `approved=true` 入力は受けない。今回は合成reader試験のみで、実J承認・本人性・L3承認を証明しない。
3. `node:sqlite` `DatabaseSync` を使い、明示絶対pathを指定された私有rootへ閉じ込め、実path/親directoryのsymlink後もroot外へ出ないことを検査する。`journal_mode=DELETE`、`synchronous=EXTRA`、`foreign_keys=ON`、`busy_timeout=0`、extension無効を設定・読戻し検査する。implicit env、旧JSONL fallback、schema自動移行、Gateway設定、driver dependencyを追加しない。
4. SQLite単一transaction内で、M event、record差分、revision/event head、update ID消費、receiptを確定する。取引前に保存chainと再生stateを照合する。COMMIT結果不明またはrollback不能なら当該instanceを停止状態にする。途中write失敗後の全rollbackを各書込点で試験する。
5. M eventは再生用に確定した更新差分とsemantic valueを保持し、ID・revision・J event参照・digest・UTC時刻へ結ぶ。これはM状態の正本eventで、HDS一般AuditLogやraw会話historyへのprojectionではない。DB全体を書換える攻撃や認証済み末尾anchorのないhash-chain完全置換を検出できるとは主張しない。DB外のaudit、J状態、履歴を複製しない。
6. `MemoryUpdateLedger` / `MTransactionStore` はinternal moduleに留める。snapshotは `used_for_authority=false`。記憶をapproval、permission、risk分類、final review、policyへ戻さない。

Vitest 2.1.9/Viteは静的 `node:sqlite` importを `sqlite` として解決しload errorになった。`createRequire(import.meta.url)`は同じNode built-inだけを読み込む。別backendやfallbackではない。Node直接実行でもtest selectorでも同一driverを通し、test runnerがNode built-in specifierを通常解決できる版へ移行した時はこの接続方法を再評価する。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、metadata non-authority、memory/history non-authority、Layer A/Bを変更・迂回しない。Jは採否責任を保ち、Mは一致照会以上の権限を得ない。fixtureは実承認扱いしない。storage errorを成功receiptや部分成功へ読み替えない。

## 10. Operator usability

`docs/状態所有と保存取引.md` に、J/Mの所有差、既存JSONLとの違い、API未接続箇所、DB/transaction構造、検査設定、拒否と結果不明、receiptの意味、重複IDは後続であること、Node SQLiteがexperimentalであること、再起動fixtureと未実施のcrash証明、後続工程を記録する。operatorに「M更新済み」「J帰還済み」「再試行安全」と誤認させない。今回はUI/doctor/runtime操作を追加しない。

## 11. Tests

- `BT-U-C03.01-P`: strict contractから実SQLite file-backed transactionへ進み、event/state/records/update consumption/receiptを一括commitし、close/reopen後にchainとreceiptを照合する。
- `BT-U-C03.01-N`: 不正schema/digest/重複record/危険key、J照会不一致、update ID再使用を拒否し、raw値をエラーへ出さない。
- `m_events`、records insert/delete、`m_state`、`m_updates`、`m_receipts` 各write pointでtrigger faultを注入し、変更一式が全rollbackされ、以前のstate/chain/receiptを保つ。
- Selector: `packages/protocol/test/状態更新契約.test.ts` と `packages/hds-brain/test/記憶更新.test.ts`。
- 外部listener、credentials、Gateway、別repo、製品データ、crash kill、installed bundleを試験に使わない。

## 12. Validation commands

commit前必須:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

実装単位追加:

```text
pnpm run doctor
pnpm validate:packaging
pnpm exec vitest run packages/protocol/test/状態更新契約.test.ts packages/hds-brain/test/記憶更新.test.ts
```

失敗は今回起因、既存、環境限定、未確定に分類し、exit値と正確なselector結果を記録する。credentialを表示・変更せず、既存processを止めない。migration debt hashを検査し、台帳と文書を同期する。

## 13. Manual smoke

Windows/PowerShellの現在workspaceで局所Vitest selectorを起動し、SQLite実API、child process終了値、件数、close/reopenを回収する。transaction triggerは一時fixture DBだけへ設置し、終了後にfixture directoryを破棄する。Gateway、external service、credential、実データ、live/installed/release smokeは起動しない。

## 14. Permanent-use check

証拠範囲はversioned protocol parse、現在Node host上のSQLite API transaction、trigger faultでの局所全rollback、正常close/reopen後のM chain/state/receipt照合である。合成J readerは `FIXTURE`。製品のJ承認consumer、OS crash durability、最小Node版、保存媒体、稼働DB移行、multi-writer、J帰還・再送・復旧、production authority接続、installed配布、外部作用、release readinessは証明しない。

## 15. Final report format

C03.01有限受入とBT-R-C03-01/02の成立範囲、変更path・実SQLite test path、risk/route/evidence source、selectorと8必須commandのexit・結果、失敗/未実行/profile/制限、親C03/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。局所受入、Git統合、製品/runtime/release判断を区別する。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまでをC03.01一単位で閉じる。C03.02は期待版・競合・再試行・重複ID receipt意味を担うため、本単位では開始しない。J pending/receipt帰還はC03.03、corruption/rebuildはC03.04。親C03全体は部分状態のままにする。P13は `PENDING_OWNER_GO`、`public_claim_allowed=false` を維持し、owner GO/GAを推定しない。
