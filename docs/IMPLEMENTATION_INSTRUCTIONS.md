# BLUE-TANUKI 有効な実装指示

現単位: **C08.01 — 通常経路の資料整理**。ownerが委任した系列から一単位だけを扱う。Windows / PowerShellを通常の開発環境とし、WSLを必須にしない。GitHubは検証済み成果と履歴の保管庫として、単位ごとに二世代backup、commit、push、remote照合まで行う。外部業務作用、cross-repo、公開主張、release/GA、出荷判断、owner GOを今回の範囲外とする。

## 1. 目的

ownerが明示的に与えた資料本文を、通常のGateway CLIとWebChatから一時的に整理し、本文内の引用位置に厳密に結び付いたJ投影を返す。資料の意味、正しさ、完全性、分類の妥当性を保証せず、本文、引用、候補を権限・実行・永続記憶へ変換しない。

## 2. Phase境界

C08.01のbounded ordinary pathに限定する。CLI `--organize` とWebChat `/organize` をGatewayからHDS Approval Gate / Executor / HDS-BRAIN Jへ接続し、Cは指定JSONを返す限定計算手段としてのみ使う。受入fixtureはtest-owned loopback fake providerを用いる。整理中はM候補をCへ読ませず、原文とC応答をM・CompleteHistory・audit・session JSONLへ保存しない。親C08、実provider、実ownerでの意味確認、恒久保存、他surface/channel、公開・releaseは対象外。

## 3. Scope

次の14 pathだけを変更する。

- `packages/hds-brain/src/document_organization.ts`
- `packages/hds-brain/src/controller.ts`
- `packages/hds-brain/src/types.ts`
- `packages/hds-brain/src/index.ts`
- `packages/hds-brain/test/document_organization.test.ts`
- `apps/gateway/src/document_organization_runtime.ts`
- `apps/gateway/src/runtime.ts`
- `apps/gateway/src/serve.ts`
- `apps/gateway/test/document_organization_entry.test.ts`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`
- `規定/移行台帳.json` — 既存CHANGELOG負債のSHA-256だけを同期

一覧外変更が必要なら、編集前にprivate施工記録のREPLANとscope/参照の再照合を行う。

## 4. Non-goals

source fileの読込・書込、M候補の整理計算への提供、資料や引用のM / CompleteHistory / sessionへの保存、引用からの意味確定、文書分類の正しさの保証、memory citation、tool candidate、外部送信・業務更新、追加channel、UI、C08.02以降、親C08、cross-repo、release/GA/P13/owner GOは扱わない。fixtureの結果を実provider/live/installedの証拠に読み替えない。

## 5. 最初に確認するfiles / symbols

`DocumentOrganizationCoordinator`、候補parser、引用renderer、`runDocumentOrganizationTask`、`documentOrganizationSourceFromRequest`、Gateway CLI/serve inbound、`HDSUpperController.decide`、`ApprovalGate`、`Executor`、`OutputAudit`、CompleteHistoryの保存payload、通常の`LongTermMemoryStore`捕捉経路を読む。専用E2Eが起動するbuilt CLI/Gatewayと、テストが隔離する監査・履歴パスも確認する。

## 6. 必須grep

`document_organization`、`--organize`、`/organize`、`memory_capture`、`raw_content_redacted`、`source_content_sha256`、`LongTermMemoryStore`、`recordCompleteHistory`、`OutputAudit`、`used_for_authority`、`may_execute`、`may_commit_to_memory`、`external_side_effect_result`を検索する。原文の監査・履歴・Mへの流入、通常HDS memory captureへの波及、二経路の出力差、未知・重複・偽造引用、重なり、制御文字、過大入力、cycle上限、HDS停止・承認拒否時の継続を調べる。

## 7. 既存anchor

HDS-BRAINだけが判断・権限を持ち、GatewayとCは下流装置である。既存のCLI/WebChat inbound境界、Approval Gate、Executor、OutputAudit、hash-chain audit、CompleteHistory非権威記録を再利用する。資料整理のacceptanceはJの一時射影であり、M captureを抑止する対象は専用prompt prefixを持つこの経路だけとする。通常HDS requestのmemory captureは変えない。

## 8. 実装要件

1. 入力はownerが明示した通常CLI引数またはWebChat本文だけとし、長さ上限12,000 JavaScript UTF-16 code unitsを適用する。空入力とover-limitを拒否する。
2. Jが最大3回のC計算を統括し、元本文に対する完全一致のUTF-16 start/end/quoteだけを採用する。重なり、偽造、未知field、action/tool/authority/completion claimを拒否する。
3. 未被覆範囲だけを次のC cycleへ渡し、Jが停止・継続・保留を決定する。分類意味を`unverified`に固定し、全projectionでauthority/execution/memory-commit flagをfalseにする。
4. CLIとWebChatは同一canonical projectionとrendererを使う。各引用行は安全なblockquoteとして表示し、制御文字やbidi制御を表示内容へ通さない。
5. 全C cycleを既存HDS Approval Gate / Executor経由の`llm_call`に限定する。C出力を直接回答や実行へ通さず、J採否とHDS output auditを通す。
6. 整理専用HDS decisionはM readerを渡さず、既存M候補をCへ提示しない。整理中の原文とC応答をM、CompleteHistory、audit log、Executor session JSONLへ永続化しない。
7. HDS audit normalization/frameは本文でなくdigest・文字数を記録し、M読取・捕捉・session履歴の抑止理由をaudit metadataへ記録する。専用prompt prefixに結び付け、通常requestのmemory/session動作を変えない。
8. 誤ったoption、未知option、入力不正、HDS停止、承認・実行失敗はfail-closedにする。統合fixtureはsynthetic Japanese、test-owned loopback fake provider、一時audit/CompleteHistory/session JSONLを用い、CLI/WebChat双方の出力一致、cycle数、全永続物への原文不在、process/temp cleanupを検証する。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、hash-chain audit、Runtime Invariants、standalone、fail-closedを維持する。資料、C出力、引用、fixture、memory、CompleteHistory、session、channel metadataは権限ではない。整理経路はM候補を読み込まずMへcommitせず、session historyを読まず書かず、tool/external side effectを起こさず、source本文を監査・履歴へ保存しない。抑止はtransient資料整理prompt以外へ波及しない。

## 10. Operator usability

CLIの`--organize <資料本文>`とWebChatの`/organize`は同じ出力契約を使う。成功、継続、保留、入力不正、上限到達、HDS拒否を区別し、意味未検証・権限なし・実行なし・永続記憶反映なしを表示する。本文を環境変数、ファイル、credential、外部serviceへ複製しない。

## 11. Tests

- HDS: `packages/hds-brain/test/document_organization.test.ts` の `BT-U-C08.01-(P|N)` とM/session抑止専用test。完全一致引用、次問/完了、malformed/forged/overlap/action拒否、通常memory/session動作維持、整理時のM候補・capture・session history抑止を検証する。
- Gateway: `apps/gateway/test/document_organization_entry.test.ts` の`BT-U-C08.01-P-E2E`。built CLIとlive WebChat双方を起動し、同一projection、2 cycleずつ、fake provider、監査/CompleteHistory/session JSONLへの原文不在を検証する。
- E2Eは`pnpm build`後に実行する。`pnpm typecheck`はworkspace `dist`を削除するため、typecheck後はbuildを再実行してからE2Eを起動する。
- 0件、skip、built artifact不在をPASS扱いしない。既存listenerやcredentialを変更しない。

## 12. Validation commands

commit前に順次実行し、前工程がworkspace `dist`を削除・生成する場合は順序を守る。

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
pnpm exec vitest run packages/hds-brain/test/document_organization.test.ts
pnpm build
pnpm exec vitest run apps/gateway/test/document_organization_entry.test.ts
git diff --check
```

`pnpm test`が既存doctor timeoutで並列失敗した場合は、そのまま記録した上で`pnpm exec vitest run --no-file-parallelism --maxWorkers=1`を行う。doctorのcredential値を読まず、既存listenerを停止しない。失敗を今回起因、既存、環境限定、未確定に分けて記録する。

## 13. Manual smoke

専用E2EはWindows上のtest-owned fake providerと一時Gateway listenerで通常CLI/WebChatを検証する。既存owner Gateway、live provider、実資料、credentialed channelへの手動送信はしない。E2Eが通常surface全体や実providerを証明したとは主張しない。

## 14. Permanent-use check

C08.01は揮発性の一回資料整理であり、恒久保存・再開・訂正・検索を提供しない。既存M候補を読み込まず、本文・引用をM、CompleteHistory、audit、session JSONLへ残さず、ownerが結果を自分で検証できることだけを局所確認する。長期運用の完成、恒久memory、他surface/channel、installed/live、releaseは別工程である。

## 15. Final report format

日本語で、成立した挙動、変更path、リスクと経路/証拠source分類、HDS/authority影響、実行した正確な検証、失敗・未実施・制約、doctor状態、P13状態、branch/commit、pushとremote HEAD、二世代backup refs、rollback pointを報告する。fixture/local evidenceをproduction/live/release readinessへ拡張しない。Git closureの必須操作が権限境界で未完了ならphase completeと呼ばず、その具体的blockerを報告する。

## 16. Next-phase dependency

C08.01のfinite acceptanceとGit closure後は境界で停止する。C08.02、親C08 scenario、追加channel/surface、意味保証、実provider、release/GA/P13は自動で開始しない。次工程は最新private state、dependency evidence、owner scopeを新しい入口で照合する。
