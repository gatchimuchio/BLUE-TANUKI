# BLUE-TANUKI 有効な実装指示

現単位: **C03.02 — M更新の期待版と冪等再送**。本単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて停止する。ownerは全工程を一単位ずつ委任している。検証済み通常成果をGitHubへ履歴・成果物としてcommit/pushする。公開主張、実業務作用、別repo、出荷判断、owner GOは別境界である。

## 1. 目的

BT-R-C03-03の範囲で、M更新へ期待版比較と同一要求の冪等再送を加える。同じ更新ID・同じ内容は元receiptを返し、同じIDの異内容と未使用IDの古い期待版は状態を変更せず拒否する。Jの採否権限をMへ移さず、Trinityの決定論的policy `M` と可変意味記憶Mを混同しない。

## 2. Phase 境界

protocol契約、HDS-BRAIN内のM更新API、M所有SQLite取引、合成fixtureと局所試験、状態所有・工程文書を扱う。新APIはHDS-BRAIN package barrel、Controller、Gateway、UI、installerから未接続のままとする。J照会は合成readerを注入する内部portの試験であり、実J承認consumerではない。

## 3. Scope

- `packages/protocol/src/状態更新契約.ts` と `packages/protocol/test/状態更新契約.test.ts`
- `packages/hds-brain/src/保存取引.ts` と `packages/hds-brain/test/記憶更新.test.ts`
- `docs/状態所有と保存取引.md`、この指示、`docs/ROADMAP.md`、`docs/開発進捗.md`、`CHANGELOG.md`、`規定/移行台帳.json`
- 他unit、別repo、GUI、production consumer、J/Gateway統合、schema移行、release pathは変更しない

## 4. Non-goals

Jの永続化・採否・pending管理、J/M間の帰還、破損時の再構築、稼働DB移行、OS/保存媒体crash検証、停止Broker、実ユーザーデータ、installed/live/release/GA/P13/owner GOを扱わない。期待版照合とM内retryは外部作用のexactly-once、Jの承認継続性、再起動を跨ぐJ帰還を保証しない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C03.01閉鎖証拠、B03.01配置決定、C03.02固定要求を確認する。`MemoryCommit`、`MemoryUpdateLedger`、`MTransactionStore`、`JMemoryApprovalReader`、`verifyDatabase`、protocol barrel、HDS-BRAIN barrel、package standalone境界を読む。旧JSONL、CompleteHistory、Decision Audit、Approval Grant、sessionを新M正本として転用しない。

## 6. 必須grep

`expected_version`、`content_digest`、`update_id`、`receipt`、`BEGIN IMMEDIATE`、`m_events`、`m_updates`、`m_receipts`、`memory_used_for_authority`、`parseMemoryCommit`、`JMemoryApprovalReader`を追う。raw入力、J/Gateway/UI/metadata、memory/history、fixture、LLM/tool結果から承認やauthorityを作らない。DB handleや汎用SQLを下流へ公開しない。

## 7. 既存anchor

`packages/protocol/src/状態更新契約.ts` はC03.01のV1契約とcanonical digestを保持し、期待M版をdigestへ結ぶV2契約を加える。V1は既存保存履歴の検証・再生専用とし、新規M書込みには使わない。`packages/hds-brain/src/保存取引.ts` は既存V1 event履歴を引き続き検証し、新規V2 eventへ期待版を記録する。M更新APIはinternalのままとし、gateway、J永続状態、Mのproduction consumerを追加しない。

## 8. 実装要件

1. V2 `MemoryCommit` に安全な非負整数 `expected_version` を必須化し、canonical content digestへ含める。V1のparse/digestは過去データ互換のため維持するが、Mの新規書込みはV2のみ受ける。
2. `BEGIN IMMEDIATE`内でDB integrityを検証し、更新ID・J event ID・内容digestに対するJ readerの完全一致を毎回確認する。J不一致なら、保存済みreceiptの有無にかかわらず拒否する。
3. 消費済みIDでdigestが一致すれば保存済みreceiptを検証して返し、transactionをrollbackしてM状態を一切進めない。digest不一致は `update_id_content_conflict` で拒否する。
4. 未使用IDはtransaction内で読んだ現在M revisionと `expected_version` が一致する場合だけ反映する。不一致は `expected_version_conflict` とし、event・record・revision・更新ID・receiptを変更しない。
5. 成功eventはV2として期待版を含み、`event.revision = expected_version + 1` を満たす。event、record差分、revision/event head、update ID消費、receiptは従来どおり単一SQLite transactionで確定する。
6. integrity検査は既存V1 eventのcontent digestとevent hashを従来形式で検証し、V2 eventでは期待版・V2 digest・hashを検証する。V1/V2の混在履歴を再生できる。
7. M APIはJ-owned approval readerを必須依存とし、単独booleanや `approved=true` 入力は受けない。snapshotは `used_for_authority=false`。記憶をapproval、permission、risk分類、final review、policyへ戻さない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、metadata non-authority、memory/history non-authority、Layer A/Bを変更・迂回しない。Jは採否責任を保ち、Mは照合済み参照以上の権限を得ない。fixtureは実承認扱いしない。storage errorを成功receiptや部分成功へ読み替えない。

## 10. Operator usability

`docs/状態所有と保存取引.md` に、期待版、同ID同内容retry、異内容ID再利用、J再照合、V1履歴互換、V2 event、M状態非変更の結果を記録する。実J承認・J帰還・production consumerや外部作用が接続済みであると誤認させない。今回はUI/doctor/runtime操作を追加しない。

## 11. Tests

- `BT-U-C03.02-P`: 新規V2更新をcommitし、同一要求の再送が保存済みreceiptを返し、revision/stateが一度しか進まない。
- `BT-U-C03.02-N`: 古い期待版と同ID異内容・期待版改変を拒否し、状態・receiptが不変である。
- 再送ごとにJ参照を再照合し、不一致時は既存receiptを返さない。第二handle/reopenからもreceiptを同じ値で返す。
- 既存V1 event履歴を検証・再生した後、V2 eventを追記できる。
- C03.01の全write fault rollback条件を維持する。
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

Windows/PowerShellの現在workspaceで局所Vitest selectorを起動し、SQLite実API、子process終了値、件数、正常commit・同内容retry・拒否後不変・close/reopenを回収する。一時fixture DBだけを使い終了後に破棄する。Gateway、external service、credential、実データ、live/installed/release smokeは起動しない。

## 14. Permanent-use check

証拠範囲はV2 protocol parse/digest、現在Node host上のSQLite取引、期待版競合、同ID retry、J再照合、旧V1履歴からの再生、C03.01 write fault rollbackである。合成J readerは `FIXTURE`。製品のJ承認consumer、OS crash durability、最小Node版、保存媒体、稼働DB移行、multi-writer運用、J帰還・外部作用、installed配布、release readinessは証明しない。

## 15. Final report format

C03.02有限受入とBT-R-C03-03の成立範囲、変更path・実SQLite test path、risk/route/evidence source、selectorと8必須commandのexit・結果、失敗/未実行/profile/制限、親C03/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。局所受入、Git統合、製品/runtime/release判断を区別する。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまでをC03.02一単位で閉じる。C03.03のJ pending/receipt帰還とC03.04のcorruption/rebuildは開始しない。親C03全体は部分状態のままにする。P13は `PENDING_OWNER_GO`、`public_claim_allowed=false` を維持し、owner GO/GAを推定しない。
