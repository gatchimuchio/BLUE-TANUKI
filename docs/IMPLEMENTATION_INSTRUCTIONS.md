# BLUE-TANUKI 有効な実装指示

現単位: **C02.03 — 解釈訂正と目的変更の分離**。`PRODUCT_BUILD_MODE`、core profile。今回はこの単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて停止する。直接依存C02.02は`e8ec5d2989bd27bb9f1852cab29800607404d125`へcommit/push済み。親C02のscenario全体は未実行である。

ownerは全工程を一単位ずつ委任している。検証済み通常成果をGitHubへ履歴・成果物としてcommit/pushし、remote refsを照合する。公開主張、実業務作用、別repo、出荷判断、owner GOは別境界。私有原典、封印詳細、raw証拠、秘密、runtime stateをrepoへ含めない。

## 1. 目的

BT-R-C02-04/05の範囲で、委任・運用・下位目的の権限を区別し、解釈訂正と目的変更を別eventとして版および適用開始時点へ接続する。誤った内部解釈の修正をowner目的の変更へ付け替えない。

## 2. Phase 境界

protocol契約、HDSの通常Controller decision/audit経路、局所文書、合成正負試験を扱う。イベントの採否はHDS側の明示構築設定だけから行い、inbound metadataやdownstream結果を権限にしない。

## 3. Scope

- `packages/protocol/src/goal_governance.ts`、protocol barrel、対応test
- `packages/hds-brain/src/goal_governance.ts`、`frame.ts`、`types.ts`、`controller.ts`、barrel、対応test
- `docs/GOAL_GOVERNANCE.md`、この指示、`docs/INDEX.md`、`docs/開発進捗.md`、`docs/ROADMAP.md`、`CHANGELOG.md`、`規定/移行台帳.json`
- 他unit、他repo、GUI、external runtime、release pathは変更しない

## 4. Non-goals

自然言語の意味同定、目的本文の保存、署名検証、対話的owner/L3承認経路、動的更新UI、意味的な親範囲証明、実結果の新規Gateway/executor consumer、永続semantic memory、親C02全体受入、live/installed/他OS、release/GA/P13/owner GOを扱わない。親scenario BT-T-C02-01..04は全体としてNOT_RUNのまま維持する。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C02.02と親C02の閉鎖証拠、指定仕様s01/s03/s05/s06/s14/s15/s16、原典D0 §7／H5 第6章／A12 §6.2.1を確認する。現物は`GoalProjectionSchema`、`GoalRelationGraphSchema`、`FrameResult`、`frame()`、`ControllerOptions`、`HDSUpperController.decide()`、`onFeedback()`、`DecisionLog`、`AuditLog.append()`、protocol/HDS export、近傍testsを追う。

## 6. 必須grep

`goal_governance`、`interpretation_correction`、`purpose_change`、`effective_from`、`GoalGovernanceLedger`、`HDSUpperController.decide`、`onFeedback`、`DecisionLog`、`AuditLog.append`を追う。raw目的本文、自由metadata、UI、履歴、tool/LLM outputから権限・eventを作らず、projectionをmodel/commit/Approval Gate/実行へ渡さない。

## 7. 既存anchor

`ControllerOptions`は構築時の明示設定を受け、`frame()`が`FrameResult`を返し、Controllerはdecision logを`AuditLog`へ追加する。`model()`はgoal/protected values/request/actor/process/memoryだけを読む。inflight feedbackは元のcommit hashへ結び付く。既存の動的owner承認consumerは不在である。厳密な目的event ledgerを通常HDS audit経路へ接続し、既存model/commit/approval/execution判定は変えない。

## 8. 実装要件

1. version付きstrict protocolで委任・運用・下位目的、親目的の版、原文参照、purpose/interpretation digest、event、authorization recordを定義する。raw本文・任意自由記述を受け付けない。
2. `interpretation_correction`は同じpurpose digest・同じ目的versionに対するHDS-J解釈更新である。`purpose_change`は前版・前digestを照合して版を一つ進め、委任目的はowner、運用/下位目的はHDS-J authority labelを要求する。
3. authorization recordをevent全体のcanonical SHA-256、event/goal/kind/authority参照へ結び、再使用・不一致・不正な権限・版・親・時刻をfail closedで拒否する。適用前の承認済みeventは`pending_effective`、適用後は`effective`とする。
4. 新purpose versionへ旧interpretationを暗黙継承せず、未同定へ戻す。子目的は親versionへ結合し、上位versionだけが進んだ場合は該当子孫へ`requires_review`を示す。旧purpose versionとevent historyを保持し、event-time resolverで遅延時刻から既知purpose versionを選べるようにする。
5. 構築時設定のみをController通常経路へ接続し、凍結projectionを`FrameResult`、`DecisionLog`、hash-chain `AuditLog`へ運ぶ。inbound metadataは設定を作成・置換できず、未設定時はfieldを省略する。
6. HDS側authorization recordはowner管理下で事前検証された構築設定という前提に限定する。recordやauthority labelだけで本人性を主張せず、未実装のL3/署名承認経路を完成扱いしない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、metadata non-authority、memory/history non-authority、Layer A/Bを変更・迂回しない。projectionは意思決定や実行の下流入力にしない。不明・不一致なauthorizationは自動許可しない。

## 10. Operator usability

`docs/GOAL_GOVERNANCE.md`に目的種別、権限区分、event差、記録/承認/適用時刻、旧版保持、将来event、遅延result resolver、承認経路の現状と限界、復旧挙動を説明する。digest-only projectionは意味を復元しない。対話的更新・実承認consumer・永続保存を保証しない。

## 11. Tests

- `BT-U-C02.03-P`: 委任/運用/下位目的の権限差、解釈訂正が目的版・digestを変えないこと、目的変更が別eventで版を進めること、future effective時刻、旧版保持、遅延時刻の版解決を確認する。
- `BT-U-C02.03-N`: 未承認・偽authority・不一致/再使用digest、source/parent/version/time不整合、unknown/free text、inbound metadata差替えを拒否し、値をerrorへ出さない。
- 実`HDSUpperController.decide()`→`FrameResult`→`DecisionLog`→hash-chain `AuditLog`接続、freeze/verify、governance有無でmodel/commit/command不変を確認する。
- selector: `packages/protocol/test/goal_governance.test.ts` と `packages/hds-brain/test/goal_governance.test.ts`。
- 親scenario BT-T-C02-01..04は本単位で閉じない。

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
pnpm exec vitest run packages/protocol/test/goal_governance.test.ts packages/hds-brain/test/goal_governance.test.ts
```

失敗は今回起因、既存、環境限定、未確定に分類し、exit値と結果を記録する。credentialを表示・変更せず、既存processを止めない。

## 13. Manual smoke

Windows/PowerShellの現在workspaceで局所Vitest selectorを起動し、child process終端、件数、exitを回収する。試験はHDS Controllerの合成requestだけを使い、Gateway、外部service、credential、実データ、installed bundle、別repoを起動・変更しない。

## 14. Permanent-use check

証拠範囲はstrict protocol契約とHDS local decision/auditでの設定検査、版projection、digest-bound authorization recordまで。record発行のowner認証、対話的L3 approval、意味的な親範囲、実際の結果帰属、UI、永続DB、installed配布、他OS、live外部作用、C02親scenario、製品完成、release readinessは証明しない。

## 15. Final report format

C02.03有限受入とBT-R-C02-04/05の成立範囲、変更path・実consumer、リスク/経路/証拠源、selectorと8必須commandのexit・結果、失敗・未実施・profile・限界、親C02/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。local受入、Git統合、製品/release判断を区別する。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまでをC02.03一単位で閉じる。親C02はPARTIAL、BT-T-C02-01..04はNOT_RUN_AS_WHOLE。P13は`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持し、owner GOやGAを推定しない。閉鎖後は系列の最新状態を読み直し、次の一単位だけを新規同期する。
