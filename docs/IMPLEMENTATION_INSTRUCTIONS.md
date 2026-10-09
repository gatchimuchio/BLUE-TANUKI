# BLUE-TANUKI 有効な実装指示

現単位: **C02.01 — 原文・委任・目的射影**。`PRODUCT_BUILD_MODE`、contract profile。直接依存C01.03はmain `3a23c1ea6fcc037d94b622cd875fea3088341184` に保存済みだが、tooling受入は本単位の契約・HDS実consumer証拠を代替しない。今回はC02.01だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて停止する。

ownerは全工程を一単位ずつ委任している。検証済み通常成果はGitHubへ履歴・成果物としてcommit/pushし、remote refsを照合する。公開主張、実業務作用、他repo変更、出荷判断、owner GOは別境界とする。私有原典、封印詳細、raw証拠、秘密、runtime stateはrepoへ含めない。

## 1. 目的

原文参照と目的射影を別recordとしてHDSの通常decision/audit経路へ接続する。必要性、対象・到達条件・範囲、評価規則、適用期間、委任権限が確認されていないときは`unknown`のまま保持し、入力文面やmetadataから推測しない。

## 2. Phase 境界

対象はprotocolのgoal projection契約、HDS `frame()`の生成、Controller decision log/auditへの実接続、局所利用文書である。合成requestだけを使う。LLMや外部serviceを起動せず、credential、保存済み製品state、別repo、外部業務作用に触れない。

## 3. Scope

- `packages/protocol/src/goal_projection.ts`、`packages/protocol/src/index.ts`
- `packages/protocol/test/goal_projection.test.ts`
- `packages/hds-brain/src/goal_projection.ts`、`frame.ts`、`types.ts`、`index.ts`
- `packages/hds-brain/test/goal_projection.test.ts`
- `docs/GOAL_PROJECTION.md`、`docs/IMPLEMENTATION_INSTRUCTIONS.md`、`docs/INDEX.md`、`docs/開発進捗.md`、`docs/ROADMAP.md`、`CHANGELOG.md`

## 4. Non-goals

C02親scenario全体、C02.02/C02.03、目的graph、解釈訂正や版変更、自然言語からのgoal同定、owner/delegatorの推定、goalを根拠にした許可・実行、Gateway/Operator UI、永続database移行、credential/live/installed/別OS検証、release/GA/P13/owner GOを扱わない。私有原典・施工パッケージ・raw証拠をrepoへ複写しない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C02.01と親C02、C01.03の閉鎖証拠、指定仕様s01/s03/s05/s06/s14/s15/s16、原典D0 §7／H5 第6章／A12 §6.2.1を確認する。現物は`InboundRequestSchema`、`FrameResult`、`frame()`、`HDSUpperController.decide()`、`DecisionLog`、`AuditLog.append()`、既存normalization/controller tests、protocol exportを追う。

## 6. 必須grep

`GoalProjectionSchema`、`goal_projection`、`original_request_ref`、`necessity`、`target_state`、`evaluation_rules`、`validity_period`、`authority`、`status: "unknown"`、`FrameResult`、`frame(`、`AuditLog.append`、`raw_content`を追跡する。UI/external metadataから射影を昇格する別経路、raw本文を射影recordへ複写する経路、frame以外の別authority ownerを追加しない。

## 7. 既存anchor

`frame()`は既存`goal`へ本文先頭200文字を置く。Controllerはboundary通過後のraw本文を`DecisionLog.input`へ保持し、正規化本文をF→M→Cへ渡し、decision logをaudit hash-chainへ追加する。今回追加する射影はこの既存経路に別fieldとして接続し、legacy `goal`、normalization、decision、既存audit形式の意味を変更しない。

## 8. 実装要件

1. strict protocol schemaで、request参照/digest、必要性、対象・条件・範囲、評価規則、適用期間、権限参照、同定状態を別fieldとして定義する。
2. 値のない項目は`unknown`の形だけを受理する。identified項目には根拠参照を要求し、`ready`は必要項目すべてがidentifiedの場合だけ受理する。
3. HDSはaccepted raw request本文を一時的にdigest化し、参照と射影をframeへ配置する。raw本文を射影recordへ重複保存しない。invalid boundary fallbackはsynthetic placeholderと明示し、raw invalid inputを読まない。
4. current runtimeはsemantic extraction/adoptionを行わず、各意味項目を`unknown`として開始する。自然言語、LLM、memory、session、metadata、historyはauthorityを作れない。
5. projectionとimmutable original referenceをruntimeでfreezeし、`DecisionLog`/`AuditLog`に実際に接続する。射影はmodel/commit/approval/execution decisionの入力にしない。
6. schema拒否理由はissue codeだけに制限し、不正本文や値を返さない。既存のlegacy goal、HDS standalone、audit hash-chain、Runtime Invariantsを保つ。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、metadata non-authority、memory/history non-authority、Layer A/Bを変更・迂回しない。goal projectionの`ready`は実行承認ではない。本単位の全証拠はcontract/local runtimeの範囲に限り、親scenario・製品全体・release readinessへ昇格しない。

## 10. Operator usability

`docs/GOAL_PROJECTION.md`にrecordの各項目、digest参照、unknown/identified/ready条件、invalid-input placeholder、非権限性、現在未実装の意味同定、検証方法と限界を日本語で説明する。未知を勝手に既定値で埋めず、再同定には何のowner evidenceが必要かを示す。

## 11. Tests

- `BT-U-C02.01-P`: Controllerの実`decide()`経路で原文request IDとraw-content SHA-256を別immutable referenceへ結び、必要性・target・evaluation・期間・authorityを`unknown`のまま`DecisionLog`/auditへ記録する。legacy `goal`と既存raw/normalized監査を維持する。
- `BT-U-C02.01-N`: unknownに値を付加した構造、全項目未同定の`ready`、未知field、空評価規則、逆転した期間を拒否する。不正入力値を失敗理由へ含めない。
- 明示的な自然文と非権限metadataを加えても射影状態が変わらず、同一request条件の決定を射影が変えないことを合成入力で確認する。
- 親scenario BT-T-C02-01..04は今回一括実行せず、全体受入をNOT_RUNのまま維持する。

## 12. Validation commands

必須:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
pnpm run doctor
pnpm validate:packaging
```

追加局所試験:

```text
pnpm exec vitest run packages/protocol/test/goal_projection.test.ts packages/hds-brain/test/goal_projection.test.ts
```

`validate:agi`の登録selectorはC02.01にまだ無いため、勝手に成功根拠として使わない。doctorが既存設定/資格情報の不足を報告した場合は、内容を隠さず今回差分との関係を分類し、秘密を表示・変更しない。

## 13. Manual smoke

Windows/PowerShell上で追加Vitest selectorを実行する。テスト内でHDS Controllerのsynthetic requestを処理し、audit hash-chainと未知値保持を確認する。Gateway、外部service、credential、実データ、別repoは起動・変更しない。child processが終端し、Vitest報告を回収したことを確認する。

## 14. Permanent-use check

証明対象は現在のWindows workspaceでprotocol contractを検証し、HDS Controllerのlocal decision/audit経路に未同定goal projectionを保存することまで。意味同定、明示採用、永続database、UI閲覧、parent scenario、installed配布、別OS、live外部作用、製品完成、release readinessは証明しない。

## 15. Final report format

C02.01有限受入、BT-R-C02-01/02/06の成立範囲、変更pathと実consumer、証拠源・経路・リスク、局所selectorと8必須commandのexit/result、FAIL/未実施/profile/未決process、C02親/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。局所受入・Git統合・製品/release判断を分ける。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、mainの単一commit/push、remote refs/clean照合、private引継ぎまで終えたら本単位だけを閉じて停止する。親C02はPARTIALのまま保ち、C02.02を自動開始しない。
