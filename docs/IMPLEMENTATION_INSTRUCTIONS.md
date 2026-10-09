# BLUE-TANUKI 有効な実装指示

現単位: **C03.04 — 保存障害と派生像の再構成**。この単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて境界停止する。ownerはrev1.1系列を一単位ずつ委任し、通常の検証済み成果をGitHubへ履歴・成果物として保存する。外部作用、別repo、公開主張、出荷判断、owner GOは別境界である。環境構築は完了済みとして再実施しない。

## 1. 目的

BT-R-C03-05/06の有限範囲として、M/Jの正本event ledgerが検証不能、保存schema不一致、disk full、write/fsync障害のとき安全側に停止し、正本ledgerだけから派生状態を明示的に再構成できることを局所確認する。

## 2. Phase 境界

対象は既存の内部M transaction、J control-state store、J/M wrapper、および一時SQLite testである。通常constructorでの自動修復・migrationは行わない。修復入口は個別ownerの派生像にだけ作用し、正本event ledgerは検証・再生専用とする。HDS package barrel、Controller、Gateway、UI、installer、production consumerへ接続しない。

## 3. Scope

- packages/hds-brain/src/保存取引.ts
- packages/hds-brain/src/記憶更新.ts
- packages/hds-brain/src/制御状態.ts
- packages/hds-brain/test/記憶更新.test.ts
- packages/hds-brain/test/制御状態.test.ts
- docs/状態所有と保存取引.md
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json

上記以外は変更しない。path追加が必要と判明したらREPLANして新たに再同期する。

## 4. Non-goals

C03.01–03の意味変更、database migration、startup自動修復、production J承認source、HDS barrel/Controller/Gateway/UI/installer接続、複数process・OSの排他保証、物理的な電源断・OS crash耐久性、実ユーザーデータ、外部業務作用、他repo、release/GA/P13/owner GOは扱わない。壊れたledgerを切り詰めたり架空の正常chainへ置換しない。内部原典・private作業証拠・secretはrepoへ含めない。

## 5. 最初に確認する files / symbols

root AGENTSと適用規定、日本語基底、作業標準、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C03.03の受入証拠、rev1.1 C03.04・C03要求・指定仕様章・原典指定節を確認する。MTransactionStore、MemoryUpdateLedger、JControlStateStore、JMemoryCommitCoordinator、verifyDatabase/replayDatabase、private-state path resolver、HDS barrel、Controller/Gatewayの未接続状態と各testを追う。開始時のHEAD、remote、backup refs、dirty stateを記録する。

## 6. 必須grep

追跡語: m_events、j_events、m_state、m_records、m_updates、m_receipts、j_state、j_pending、schema_version、verifyDatabase、replayDatabase、store_unavailable、memory_used_for_authority。自動repair、ledger書換え、別authority path、修復moduleのruntime import、秘密・raw payloadのerror出力がないことを確認する。

## 7. 既存anchor

Mの正本はm_events、派生像はm_state/m_records/m_updates/m_receipts。Jの正本はj_events、派生像はj_state/j_pending。既存M/Jの名前空間、hash-chain、schema version、private state root、SQLite保護PRAGMAを維持する。C03.03のreceipt再照合はMへの自動再送なしを保つ。

## 8. 実装要件

1. 起動時のschema不一致、canonical event破損、派生像不一致を安全な分類で識別し、診断内容にpath/raw SQL/raw payloadを含めない。
2. disk full、SQLite write failure、fsync failureを区別する。保存失敗または整合性failure後は、当該store handleを再使用不可にし新しい更新を拒否する。通常のschema検証、approval mismatch、期待版競合など業務拒否は障害停止と混同しない。
3. M専用とJ専用の明示的rebuild entrypointを設ける。正本ledgerのschema/hash-chain/event payloadを再検証し、transaction内で再検証した後に限り、該当ownerの派生tableを再生成する。他owner領域へ書かない。
4. canonical event row/payloadは一切更新・削除・再採番しない。ledgerの末尾破損、未知event schema、hash不一致はrepair拒否とし、元の破損を維持して停止する。
5. 修復対象ownerの永続SQLite triggerを検査する。派生table書込みからcanonical ledger等へ副作用し得るtriggerがあればschema不一致として修復を拒否する。
6. 修復後に通常storeを新規openして全整合性を再検査する。constructorが自動修復を始めない。外部anchorがないhash chainから末尾切捨て・全履歴差替え検出を主張しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、memory/history/metadata non-authority、Layer A/B、standalone境界を維持する。JとMの所有領域を混ぜず、repairは承認・採否・risk分類・permissionを生成しない。保護措置をaudit成功へ依存させない。修復moduleはpackage barrelやruntime pathからimportしない。

## 10. Operator usability

安全なstatus/errorで原因分類、停止状態、明示repairが可能/不可の区別、次の確認行動を示す。path・秘密・raw event/valueを出力しない。repair成功はlocal fixture範囲の状態でありproduction recoveryやOS耐久性を意味しない。docs/状態所有と保存取引.mdと開発進捗.mdに責任境界、復元条件、限界を記録する。

## 11. Tests

- BT-U-C03.04-P: file-backed SQLiteのM/J派生像を個別に改変し、owner専用の明示repairで正本ledgerから再生する。canonical event bytes/digestsが変わらず、修復後のclose/reopenとverifyが通る。
- BT-U-C03.04-N: 壊れた/未知schema/hash不一致ledgerとcanonicalを書き換え得るowner triggerのrepairを拒否し、正本を変更しない。schema mismatch、disk full、write/fsync failureで停止分類を確認し、障害を受けたhandleの後続更新が拒否される。
- 実test selector: packages/hds-brain/test/記憶更新.test.ts と packages/hds-brain/test/制御状態.test.ts。
- Windows一時file-backed DB・合成値だけを使用し、fixture結果をLIVE_RUNTIME/installed evidenceに読み替えない。

## 12. Validation commands

commit前必須:

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm build
    pnpm test
    pnpm docs:check
    pnpm validate:repo-health

実装単位追加:

    pnpm run doctor
    pnpm validate:packaging
    pnpm exec vitest run packages/hds-brain/test/記憶更新.test.ts packages/hds-brain/test/制御状態.test.ts

失敗は今回起因、既存、環境限定、未確定に分類し、exit値と件数を記録する。実装検証失敗を隠さない。

## 13. Manual smoke

現在のWindows/PowerShell workspace上でselectorを実行する。一時DBで正例repair、破損ledger・trigger schema拒否、容量・write/fsync failureの安全停止、close/reopen後の再検査を確認する。既存Gateway/listener/process、credential、製品DB、external service、別repoは操作しない。物理OS fsync failureを起こしたとは主張せず、注入/合成試験と明記する。

## 14. Permanent-use check

許される証拠主張は現在のWindows Node hostの内部M/J file-backed SQLite fixture、明示された修復entrypoint、失敗時の同handle停止まで。証拠源はFIXTURE/INTERNAL_STATE。production consumer、owner/L3承認、OS crash/power-loss、複数process、installed distribution、release readinessの証明ではない。

## 15. Final report format

C03.04局所受入とBT-R-C03-05/06の成立範囲、変更path、内部consumer、risk/route/evidence source、selectorと全必須commandのexit/結果、失敗・未実施・残存限界、親C03/P13状態、branch/commit/push/remote HEAD、二世代backup refs、復元点を日本語で簡潔に記録する。局所受入、Git統合、production/runtime/release判断を分ける。

## 16. Next-phase dependency

C03.04の有限正負条件、整理、安全review、必須検証、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまで閉じて境界停止する。親C03 scenario全体、production接続、実運用耐久性、release状態は未完了のまま保持する。P13はPENDING_OWNER_GO、public_claim_allowed=falseを維持し、owner GO/GAを推定しない。
