# BLUE-TANUKI 有効な実装指示

現単位: **C03.03 — JとMの受領照合**。この単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて境界停止する。ownerはrev1.1系列を一単位ずつ委任し、通常の検証済み成果をGitHubへ履歴・成果物として保存することを指示している。外部作用、別repo、公開主張、出荷判断、owner GOは別境界である。

## 1. 目的

BT-R-C03-04の限定範囲として、Mが確定した後、Jがreceiptを受け取る前に通信が切れても、Jの永続 `memory_commit_pending` とreceipt照会から復帰できるようにする。M更新を重複反映せず、receipt未確認のままJを進行させない。

## 2. Phase 境界

HDS-BRAIN内にJ所有の永続pending記録とreceipt再照合経路を実装し、C03.02のM所有SQLite保存取引へ局所接続する。J/Mの論理所有と名前空間を分ける。試験はWindows上の一時file-backed SQLiteと合成J承認参照を使う。新しいJ storeはHDS-BRAIN package barrel、Controller、Gateway、UI、installerから未接続のままとし、owner/L3承認のproduction consumerを作らない。

## 3. Scope

- `packages/hds-brain/src/保存取引.ts`
- `packages/hds-brain/src/制御状態.ts`
- `packages/hds-brain/test/制御状態.test.ts`
- `docs/状態所有と保存取引.md`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`
- `規定/移行台帳.json`

上記以外のsource/test/docs、protocol schema、HDS barrel、Controller/Gateway、GUI、installer、release path、他repoは変更しない。範囲拡大が必要ならREPLANし、現差分へ混ぜない。

## 4. Non-goals

C03.04の破損・容量・同期障害・再構築、稼働DB migration、複数process/OSの排他保証、crash/power-loss耐久性、production J authority source、Controller/Gateway統合、UI表示、実ユーザーデータ、外部業務作用、live/installed/release/GA/P13/owner GOを扱わない。J pendingへMemoryCommit本文・変更値を複製せず、receipt不在時にM更新を自動再送しない。合成承認readerは実承認の証拠ではない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底規定、`docs/作業標準要領.md`、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C03.02受入証拠、B03.01配置決定、C03.03要求を読む。`MTransactionStore`、`MemoryUpdateLedger`、`JMemoryApprovalReader`、`readReceipt`、`verifyDatabase`、保存先境界helper、`HDSUpperController`、Gateway runtime、HDS package barrel、standalone import境界を追う。既存のApproval Gate、AuditLog、CompleteHistory、旧JSONLをJ制御正本へ転用しない。

## 6. 必須grep

`memory_commit_pending`、`j_events`、`j_state`、`j_pending`、`readReceipt`、`content_digest`、`expected_version`、`receipt_confirmed`、`memory_used_for_authority`を追う。approvalのboolean、UI/metadata/history/LLM/tool結果からの権限生成、M receiptを使った自動再送、J/M共有の汎用更新口、raw MemoryCommitのJ側複製を導入しない。

## 7. 既存anchor

`packages/hds-brain/src/保存取引.ts` のM transactionとprivate state root境界を再利用し、同じDB上でJ名前空間のみを操作する。`packages/hds-brain/src/記憶更新.ts` の `MemoryUpdateLedger.receipt()` / `verify()` をreceipt読取consumerとする。新規 `packages/hds-brain/src/制御状態.ts` はJ所有state/event/pendingと再照合だけを持ち、DB handleや汎用SQLを公開しない。`controller.ts` と `apps/gateway/src/runtime.ts` は現状把握専用で今回変更しない。

## 8. 実装要件

1. 保存先は既存private-state-root内に解決し、C03.02と同じNode SQLite保護設定を読み戻す。M/J schemaの不足や不一致を自動修復・migrationしない。
2. Jは `j_events`、`j_state`、`j_pending` の専用名前空間を持つ。J event、状態projection、pending更新は一つの局所SQLite取引で確定する。現HEADに既存J schemaがないため、初期状態からの単一versionだけを扱う。
3. `memory_commit_pending` を書く前に、J-owned readerから `update_id`、`j_event_id`、canonical `content_digest` が一致する参照を検証する。独立booleanを受け取らない。承認参照不一致や同ID異内容は状態を書かず拒否する。
4. J pendingはopaque ID、event ID、digest、expected M versionなど回復に必要な最小metadataだけを持つ。MemoryCommit本文、意味記憶値、credential、tool出力を保存しない。
5. Mへの初回反映はC03.02 `MemoryUpdateLedger.apply()` がJ pendingを再照合して行う。J storeのreceipt再照合APIはM `verify()` と `receipt()` を読むだけで、M apply/retry/writeを呼ばない。
6. receiptはupdate ID、content digest、previous revision、result revisionとexpected versionの関係をすべて検証する。receipt不在ならJをpendingのまま保つ。不一致・不正はfail-closedでblockedとし、readyへ進めない。
7. 有効receiptの確定、J event、J state `ready`、pending receipt記録は一つのJ transactionで行う。同じreceiptの再照合は同じ保存結果を返しrevision/eventを増やさない。
8. `memory_commit_pending` は「JがM receiptを待つ」状態であり、M未確認receiptを成功扱いしない。M記憶、J event、receiptのいずれもpermission、approval、risk分類、final review、policyを生成しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、memory/history/metadata non-authority、Layer A/B、standalone境界を保つ。J storeは承認を生成せず、検証済みJ参照を永続化する。Mは採否せず、receiptはJ/Mの更新照合に限る。fixtureを実承認扱いしない。

## 10. Operator usability

`docs/状態所有と保存取引.md` と開発進捗へ、J pendingの状態遷移、receipt不在・不一致、再照合、close/reopen後の復帰、raw payloadを保存しないこと、M再送を起こさないことを記録する。Controller/Gateway/UIへの接続、doctorの新表示、production復帰経路があると誤認させない。

## 11. Tests

- `BT-U-C03.03-P`: J pendingを永続化し、Mが実SQLiteでcommitした後、J receipt受領前に両storeをclose/reopenする。M receipt照会からJが一度だけreadyへ復帰し、M revisionとreceiptは一回分のまま。
- `BT-U-C03.03-N`: receipt不在はpendingを保ち、receipt不一致・承認参照不一致・同ID異内容は拒否またはblockedとし、M再更新やJ進行を起こさない。反復照合はread-only/idempotent。
- Selector: `packages/hds-brain/test/制御状態.test.ts` と `packages/hds-brain/test/記憶更新.test.ts`。
- 一時DBと合成値だけを使い、実Gateway、既存listener、credentials、製品データ、外部service、別repo、crash/power-lossを使わない。

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
pnpm exec vitest run packages/hds-brain/test/制御状態.test.ts packages/hds-brain/test/記憶更新.test.ts
```

失敗は今回起因、既存、環境限定、未確定に分類し、exit値・test件数・ログ参照を記録する。credentialsを表示・変更せず、既存processを止めない。CHANGELOG変更後は移行台帳hashを同期する。

## 13. Manual smoke

Windows/PowerShellの現在workspaceで局所selectorを実行し、実 `node:sqlite` file DB、子process終了値、正例のcommit・receipt再照合、close/reopen後のJ/M revisionと件数、receipt不在時のpending維持を確認する。一時fixture DBは試験終了後に破棄する。Gateway、external service、credential、既存port、実データ、live/installed/release smokeは起動・変更しない。

## 14. Permanent-use check

証拠範囲は現在のWindows Node hostでのJ pending保存、C03.02 M SQLite receiptの読取、合成承認参照、receipt照合とclose/reopen復帰である。証拠源は `FIXTURE` / `INTERNAL_STATE`。実J authority、production consumer、OS crash durability、複数process、DB migration/repair、installed配布、release readinessは証明しない。

## 15. Final report format

C03.03有限受入とBT-R-C03-04の成立範囲、変更path・consumer・risk/route/evidence source、selectorと8必須commandのexit/結果、失敗・未実施・profile制限、親C03/P13状態、branch/commit/push/remote HEAD、二世代backup refs、復元点を日本語で記録する。局所受入、Git統合、production/runtime/release判断を分ける。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎをC03.03一単位で閉じる。ここで施工編集を止め、C03.04の破損・容量・同期障害・再構成は開始しない。親C03全体は部分状態のまま。P13は `PENDING_OWNER_GO`、`public_claim_allowed=false` を維持し、owner GO/GAを推定しない。
