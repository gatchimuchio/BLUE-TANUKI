# BLUE-TANUKI Development Practice

## 1. Purpose

本書は GUI-Shell の開発規律を参照し、BLUE-TANUKI 用に翻案した作業方法を定義する。

参照元の作法をそのまま移植しない。BLUE-TANUKI では常に次の順序を優先する。

1. HDS-BRAIN authority
2. Approval Gate / final-review
3. hash-chain audit
4. Runtime Invariants
5. downstream adapter / UI / channel / plugin / installer
6. operator UX
7. feature convenience

GUI-Shell は Runtime Operation Shell の参照であり、BLUE-TANUKI の authority source ではない。BLUE-TANUKI 側では HDS-BRAIN が上位であり、Control Center、channels、plugins、tools、installer、resident app、LLM output、memory、history、external metadata は downstream device のまま扱う。

## 2. Adopt / Adapt / Reject / Reserve

| GUI-Shell practice | Classification | BLUE-TANUKI translation |
|---|---|---|
| Safety / robustness / operator clarity before features | Adopt | AGENTS.md の優先順位として維持する。 |
| Completion evidence before completion claim | Adopt | 実装事実、実行 path、validation 結果、未検証範囲、残リスクを報告する。 |
| Schema / conformance first | Adapt | JSON Schema 固定ではなく、protocol / capability envelope / HDS policy / conformance tests を先に固定する。 |
| UI is display / intent surface only | Adopt | Control Center は authority を作らず、HDS-BRAIN と Approval Gate の projection に限定する。 |
| Adapter metadata cannot grant authority | Adopt | channel / plugin / skill / external metadata は authority escalation に使わない。 |
| Evidence source classification | Adapt | BLUE-TANUKI の doctor / Runtime Invariants / release gates に evidence class を明示する。 |
| Contract-to-runtime connection | Adopt | contract 追加時は production / runtime / validator / governed path の接続を示す。 |
| Mutation verification | Adapt | safety-critical な conformance が tautology になり得る場合に、意図的な失敗確認を記録する。 |
| Owner-use and release-ready separation | Adopt | RC / GA / owner GO / public claim の境界を GA Bar に従って分離する。 |
| Remote backup tags instead of branches | Reject | BLUE-TANUKI は AGENTS.md の two-generation backup branches を維持する。 |
| Flutter / Rust helper implementation choices | Reserve | GUI-Shell 固有の技術選択であり、BLUE-TANUKI core 作法には移植しない。 |

## 3. Work Order

新しい機能、adapter、tool、operator surface、installer/release path を追加する場合、次の順序で進める。

1. Active instruction file と関連 docs を読む。
2. 変更が `runtime path`、`control path`、`diagnostic path`、`repair / recovery path`、`build / release path`、`development-only path` のどれに属するか分類する。
3. HDS-BRAIN / Approval Gate / audit / Runtime Invariants に触れるかを確認する。
4. capability envelope、manifest、protocol、policy、docs の contract surface を先に確認する。
5. governed production path か validator path を特定する。
6. reject / suspend / fail-closed すべき negative case を先に決める。
7. 実装は最小形にする。opportunistic refactor や speculative feature は入れない。
8. tests / conformance / docs / changelog を同じ作業単位で更新する。
9. Section Hygiene Rule に従い debris、stale TODO、重複、不要な抽象化を除去する。
10. validation、backup、commit、push、報告を AGENTS.md の順序で閉じる。

## 4. Evidence Source Classes

health check、doctor、Runtime Invariants、conformance、release gate、claim review は、何を実際に観測したかを区別する。

| Class | Meaning | What it can prove |
|---|---|---|
| `CONFIG` | env / manifest / package config / docs matrix | 設定が整合していること。runtime success は証明しない。 |
| `INTERNAL_STATE` | in-memory state / generated snapshot / local store | process 内部の現在値。外部実行や installed path は証明しない。 |
| `LIVE_RUNTIME` | 起動中 gateway / HDS-BRAIN / channel / resident process の実動作 | その runtime path が観測範囲で動いたこと。 |
| `EXTERNAL_EVIDENCE` | extracted bundle、installed path、credentialed live smoke、OS service evidence、owner-run OS evidence | release / distribution / integration の外部証拠。 |
| `FIXTURE` | unit fixture / mock / negative sample | contract logic と reject behavior。production path success は証明しない。 |

Rule:

- `CONFIG`、`INTERNAL_STATE`、`FIXTURE` を `LIVE_RUNTIME` や `EXTERNAL_EVIDENCE` の代わりにしない。
- evidence が不足する場合は、成功推定ではなく `not run`、`environment-limited`、`release_blocker`、または `SUSPEND` として分類する。
- release readiness は required local validation、extracted bundle verification、owner-required OS / live evidence なしに主張しない。

## 5. Contract-to-Runtime Rule

contract、schema、protocol type、capability、manifest、policy、audit record、Runtime Invariants evidence を追加または変更する場合、完了報告前に次を確認する。

- どの production / runtime / validator path がその contract を consume するか。
- どの test / conformance / release gate がそれを exercise するか。
- どの malformed / unauthorized / unknown / ambiguous case を reject、audit、または suspend するか。
- HDS-BRAIN authority に依存する場合、HDS-BRAIN が standalone のままか。
- downstream surface が contract を表示・要求するだけで、authority を作らないこと。

contract が存在するだけでは behavior complete ではない。runtime path と failure path が接続されて初めて完了に近づく。

## 6. Production Path Minimization

通常 runtime path に、doctor、setup、audit dump、repair、release verification、fixture、migration、debug helper を静的 import しない。

例外が必要な場合は、次を文書化する。

- なぜ runtime path から到達する必要があるか。
- その path が authority、Approval Gate、audit、Runtime Invariants を変えないこと。
- credential、filesystem、network、process、external write の権限が広がらないこと。
- tests と validation がどの境界を確認したか。

BLUE-TANUKI の production runtime は小さく、downstream device は bounded に保つ。

## 7. Mutation Verification

safety-critical な conformance test が実装と同じ定数、同じ local helper、同じ fixture だけを読んでいる場合、tautology になる危険がある。

次の領域では、必要に応じて mutation verification を使う。

- authority key stripping
- final-review operation single source
- Approval Gate bypass prevention
- full access L3 containment
- channel / plugin metadata authority escalation prevention
- Runtime Invariants evidence generation
- complete history / replay raw-payload stripping
- release bundle secret exclusion

記録する項目:

- mutation target
- injected mutation
- expected failure
- observed failure
- revert confirmation
- final validation result

壊した mutation code を commit してはならない。記録は docs、phase report、または validation artifact に残す。

## 8. Operator Surface Rule

Control Center、resident app、operator surfaces、history viewer、audit viewer、doctor UI は以下に限定する。

- state display
- digest / metadata projection
- operator intent collection
- next action display
- recovery instruction display

これらは次をしてはならない。

- authority decision
- approval substitution
- permission escalation
- final-review bypass
- raw payload / credential / token projection
- memory / history / external metadata の authority 化

UI から mutation を要求する場合も、HDS-BRAIN / Approval Gate / audit / Runtime Invariants を経由する。

## 9. Release Claim Separation

BLUE-TANUKI は次を分離する。

- implementation exists
- unit tests pass
- conformance passes
- local owner-use path works
- extracted release bundle verifies
- local validation passes
- credentialed live smoke passes
- GA Bar passes
- owner GO exists
- public claim allowed

上位の claim は下位の evidence だけでは成立しない。`pnpm validate:ga` が pre-GO で `public_claim_allowed=false` を返す状態は正常であり、GA claim ではない。

## 10. Final Report Mapping

AGENTS.md の最終報告形式に加え、開発作法の観点では次を明示する。

- 変更が属する path classification
- evidence source class
- contract-to-runtime 接続
- failure / recovery path
- `not run` の理由と release impact
- remaining release blockers

文書だけの変更でも、release claim、operator clarity、HDS authority boundary に影響する場合は risk を明示する。

## 11. Source Reference

本書は GUI-Shell repository の開発規律を参照している。ただし BLUE-TANUKI では AGENTS.md、HDS-BRAIN standalone rule、Approval Model Rule、GA Bar Definition が上位であり、GUI-Shell の技術選択や backup tag policy はそのまま移植しない。
