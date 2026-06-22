# Repository Health Phase 4 - Final Commissioning

この文書は repository health phase 4 の竣工前検査レポートである。機能追加ではなく、core release path を完了判定できる状態へ閉じるための punch-list closure を記録する。

## Scope

- fallback content から危険コマンド文字列を除去
- `repo_health_gate` を TypeScript AST ベースの import graph 検査へ更新
- extracted release bundle で install / build / doctor / `validate:repo-health` を実行
- core doctor が extracted core release 内の preview package absence を intentional preview limitation として扱う
- doctor mode / release mode / preview scope の docs 表現を整合
- malformed inbound、missing credential、preview package absent、release bundle extracted、invalid import graph、forbidden wrapper revival の異常系をテストで固定

## Safety Review

HDS-BRAIN authority path、Approval Gate、Runtime Invariants、hash-chain audit、complete history、OutputAudit の authority boundary は変更していない。malformed inbound は raw input を authority source として使わず、gateway boundary metadata と HDS-BRAIN authority-boundary fail-safe で閉じる。

`repo_health_gate` は downstream preview / installer / resident / external adapter を authority に昇格しない。AST import graph gate は production CLI graph の eager import purity を守るための regression gate であり、HDS-BRAIN の判断、ApprovalRisk、ApprovalLevel、final-review operation list は変更しない。

## Phase 4.1 Boundary Semantics

gateway invalid inbound の責務は二段に分かれる。gateway の complete history / reply / execution path は、canonical request または safe fallback request だけを使う。invalid raw input は、HDS-BRAIN が gateway とは独立に authority boundary fail-closed audit を残すためだけに渡す。raw invalid input は execution、reply target、history payload、Approval Gate origin として使ってはならない。

この境界では、HDS-BRAIN が raw unknown を受け取っても command は出さず、`authority_input_boundary` の SUSPEND audit に閉じる。gateway は invalid inbound では dispatch / execute path を発火しない。

## Gate Limits

`pnpm validate:repo-health` は source-level static gate である。Node resolver 全体、外部 package side effect、runtime branch coverage、build output の全 dependency tree は単独では証明しない。これらは `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm release:verify` の extracted bundle commissioning と組み合わせて閉じる。

## Failure Classification

| Class | Release impact |
|---|---|
| environment | host / Corepack / pnpm / archive tooling / external credential availability の問題。原因が環境に閉じる場合は release blocker ではない。 |
| credential | live-smoke credential / target 不在。core release では blocker ではない。owner-declared credentialed promotion gate では blocker。 |
| product regression | validation, docs, import graph, release bundle, doctor, local gate, authority boundary の失敗。release blocker。 |
| intentional preview limitation | core release bundle から除外された preview package / helper source / credential の不在。release blocker ではない。 |

## Local Validation Evidence

Phase closure local validation:

- `pnpm install --frozen-lockfile`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 632 tests
- `pnpm docs:check`: PASS
- `pnpm validate:repo-health`: PASS
- `pnpm validate:packaging`: PASS
- `pnpm validate:ga`: PASS, `public_claim_allowed=false`
- `pnpm run doctor`: PASS with temporary separated core tokens; optional preview credentials WARN / safe_to_ignore
- `pnpm validate:channels`: PASS; Slack / Discord / Teams / LINE remain preview
- `pnpm plugin:review -- --package packages/channel-slack --bundled`: PASS
- `pnpm hds:standalone`: PASS
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS/SKIP, credential limitation
- `pnpm release:bundle -- --dry-run`: PASS
- `pnpm release:bundle`: PASS
- `pnpm release:verify`: PASS, extracted install/build/doctor/`validate:repo-health`

## Known Remaining Risk

Release blocker は残さない。credentialed live smoke と owner-run OS evidence の最終確認は環境 / credential 依存として分類し、core release gate の product regression とは分離する。
