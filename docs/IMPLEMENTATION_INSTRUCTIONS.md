# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、直前active指示、E04.01／E04要求、実際のHEAD／差分／producer・consumerを再読した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラrepo、実provider／資格、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E04.01-CONDITIONED-FAILURE-GATE`。関連単位=E04.01「失敗観測と条件付き署名」。開始HEAD／`origin/main`=`9fb09257c8ec156fb609bc4cd391d964bce5f21c`、clean。編集前にlocal復旧branch二世代とremote backup tag二世代を、現世代=`9fb09257c8ec156fb609bc4cd391d964bce5f21c`、前世代=`eb3a52a232cc62556af75b726fb494b157d5f59a`へ期待値付きで回転し、local／remote SHA一致を確認した。backup-ref状態=`MIGRATION_COMPLETE`。実装commit=`a96ac6d`、`main`への最終同期はbatch閉鎖時に検証する。

### 目的

GatewayのCLI／WebChatで観測した失敗を、症状digest・原因候補・unknown・J goal・action/target・actor/channel条件に分けてFailureMemoryへ保存し、同じ条件の次回command gateへ接続する。request IDなど実行ごとの値を除き、似たoperationでも別target／goalへ誤適用しない。

### 対象と境界

- 対象：`packages/hds-brain/src/failure-memory/{types,normalize,extractor,store,verifier,index}.ts`、package barrel、`apps/gateway/src/{runtime,serve,serve_projection}.ts`、HDS-BRAIN／Gateway focused tests、failure-memory control doc、ROADMAP、開発進捗、移行台帳。
- 新規signatureにraw goal／arguments／LLM messages／channel target・content／error本文を保存しない。failure history producerとCLI直接producerで同じcanonical digest patternsを使い、FailureMemory dedupe／verifier identityにもgoal・action・context・symptomを含める。
- structured command gateはinput／action／context patternが完全一致したときだけ照合し、operation-only Level 2／semantic Level 3 fallbackを通さない。actor／channelはdigest／固定値、request ID／command ID／surfaceは照合から除外する。
- Causeは未確定候補として保存し、root cause／予測差は取得できないためunknownを維持する。Existing `failure-memory-v2` snapshotsはload互換を保つ。conditioned patternのない旧command signatureは新gateでは適用しない。旧snapshotやComplete Historyのraw errorを遡及変換・削除しない。
- FailureMemory／Complete History／UI projectionはreference/evidenceであり、J採否、permission、Approval Gate、L3、Broker、監査、外部作用を置換しない。provider／資格、外部送信・変更、D4Pocket／ミニドラ、実OS、QE_QC／QE_QA、owner GOは対象外。

### 限定確認

| 確認 | 結果 |
|---|---|
| HDS-BRAIN／Gateway focused suite | PASS、4 files／27 tests。条件一致、target／goal／actor／channel差、legacy v2、raw sentinel非保存を確認。 |
| `pnpm typecheck` | PASS、exit 0。 |
| `pnpm build` | PASS、15 workspace projects。 |
| `pnpm docs:check` | PASS。Markdown 186、日本語基底移行負債76件、license gate PASS。 |
| `git diff --check` | PASS。 |

### 到達状態と残差

実行後producer／Complete History→digest-only failure signature→同一goal／action／target／actor／channelの次回pre-execution gateは`WIRED`。異なる条件は適用されない。E04.01／QEB-03全体は、予測差のproducerとJ原因・反対仮説の採否consumerが未接続のため`BUILD_GAP`。`cause_candidates`はerror分類候補であり、根因確定ではない。実failure-memory保存先とComplete Historyの既存raw内容は検査・移行していない。`pnpm test`、`smoke:serve`／`smoke:resume`、live serve、実state、資格／provider、外部作用、別repo、実機、QE_QC／QE_QAは未実施。

C08.03実provider試験保留、D4Pocket／ミニドラの別repo変更禁止、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。次のBUILD_BATCHはowner指示・rev2.3三点正本・この指示・HEAD／差分・E04.01の残差を再同期して選定する。

### Git閉鎖

限定commitを`main`へfast-forward pushし、push後にlocal／remote main、作業tree、local復旧branch二世代、remote backup tag二世代を実SHAで照合する。今回保全した復旧点は現世代=`9fb09257c8ec156fb609bc4cd391d964bce5f21c`、前世代=`eb3a52a232cc62556af75b726fb494b157d5f59a`。remote更新・ref競合があれば上書きせず停止する。

backup-ref state=`MIGRATION_COMPLETE`。GitHub上の正本はbackup tag二世代であり、同名remote backup branchを維持しない。
