# BLUE-TANUKI エージェント実装・監査規定

この文書は、BLUE-TANUKI で作業する AI 実装エージェントの全リポジトリ共通規定である。通常のアプリ雛形向けの案内ではない。短い規則と後段の詳細が重なる場合は、HDS-BRAIN の権限、承認、監査、復旧、配布整合性、owner の安全をより強く保つ解釈を採る。

実務手順は本規定に従う [`docs/作業標準要領.md`](docs/作業標準要領.md) に定める。D4-POCKET の確認済み版を BLUE-TANUKI 用に翻案したものであり、参照先の変更、技術構成、工程状態を自動採用しない。

## 第I部 共通基底規律

## 0. QE施工の最上位原則と正本

本リポジトリの品質体系は、ownerが定めたQE（品質工学）へ統一する。「QEが開発全体を包含し、完成した実物にQC（品質管理）を適用し、その証拠から個別対象のQA（品質保証）を判定する」という本プロジェクト固有の作用・包含関係を採用する。一般の品質規格や全組織で普遍的に成り立つ階層の主張ではない。

**開発順：全体設計 → 一気通貫で全体実装 → システムの結合形状成立 → 実物へのQC（観測・全体検査・原因分析・改善・再検査） → 対象別QA → ownerの独立した公開・出荷判断。** 先に局所の品質保証を198回完成させて製品を組み上げる方式は採用しない。安全第一・品質第二を維持し、安全・承認・秘密・監査・停止の保護は実装中も常時有効にする。

owner指定の「BLUE-TANUKI QE統合実装仕様書」「BLUE-TANUKI QE工程表」「BLUE-TANUKI Codex QE施工指示書」は、技術完成形・実装順・施工運転の三点正本である。現行版の固定情報は [`docs/QE_CURRENT_AUTHORITY.md`](docs/QE_CURRENT_AUTHORITY.md) 一か所で管理し、ownerが新しい三点を指定したときだけ更新する。旧版・完了した作業記録は履歴ログであり、現行作業の正本として併読しない。内部原典や全要求対応表はPublicリポジトリへ転載しない。作業時に内部正本へアクセスできなければ推測で補わず、現行repoの実物と公開可能な要求から作業可能範囲を確定し、欠落条件を明記する。

本書は「共通基底規律 → BLUE-TANUKI固有規律 → 現行QE施工規律」の順に読む。D4PocketのAGENTS.mdからは安全・証拠・責任境界・通常経路最小化・環境区分・実行主体一本化・Git保全の汎用規律だけを採用する。D4固有のFlutter/Rust/macOSの実装条件、機能状態、完了証拠は自動移植しない。

規定改修だけでは製品実装を再開しない。現行ownerの開発委任に従い、最新正本と現物を再照合してBLUE本体のQE_BUILDを進める。C08.03の実provider検証保留、D4Pocket／ミニドラの別repo変更に必要な別途許可、P13の公開保留を維持する。

## 1. 日本語基底

日本語を唯一の基底規定言語とする。表示上の優先順位ではなく、対象、差異、関係、目的、境界、採否、検証、監査を日本語で先に成立させる。

- 正本: [`規定/00_日本語基底規定.md`](規定/00_日本語基底規定.md)
- 基底語彙: [`規定/01_基底語彙.md`](規定/01_基底語彙.md)
- 資産分類と例外: [`規定/02_資産分類と局所例外.md`](規定/02_資産分類と局所例外.md)
- 機械可読索引: [`規定/正本索引.json`](規定/正本索引.json)

多言語は、外部 API、プロトコル、規格、構文、固定識別子、固有名、原文証拠など、実務上やむを得ない箇所に限り局所例外として認める。例外は `規定/局所例外台帳.json` に記録しなければ成立しない。既存の英語資産は例外へ自動昇格させず、`規定/移行台帳.json` の未解消負債として扱う。

コード、コマンド、API、型、環境変数、パッケージ名、外部製品名など、互換性・正確性のため既存表記が必要なものは維持する。それらは日本語で成立した意味を参照するラベルであり、日本語の意味を逆定義しない。

## 2. 中核規則と全体系の責任分界

BLUE-TANUKIの目標は、目的を持つ仕事を計算・判断・作用・観測・記憶・帰還まで統治するAGIエージェントシステムの成立である。既存HDS-BRAINの独立した制御・認可資産を維持し、C（計算）、J（HDS判断）、M（可変記憶）、作用能力境界、環境帰還を一気通貫の実経路へ接続する。HDSの基底理論とC/J/Mの実装上の責任分離を同一視しない。

- Cは候補生成・推論・計画・計算を担当する。既存LLMを使用でき、同じ計算契約でミニドラへ交換できる。Cの出力は権限ではない。
- J／HDS-BRAINは委任された目的の保持、候補の採否、進行・停止、記憶更新の判断を担当する。上位委任そのものを勝手に変更しない。
- Mは記憶・根拠・失敗・解釈版・残差の保持を担う。Jの判断根拠に利用できるが、過去承認を現在の権限に復活させない。
- 作用能力境界はHDS採否とは独立に、現在の実行環境Permission、対象同一性、期限、単回消費、必要なowner承認を検査する。
- D4Pocket（旧GUI-Shell）は汎用GUI／Runtime／Brokerの外殻として接続する設計対象。BLUE固有のJ／HDS意味機構をD4の汎用Shell Coreへ埋め込まず、認証されたAdapter境界を使う。D4側コードの変更には別repoの限定委任を要する。

**一つの仕事が「目的 → C → J → 環境権限 → 作用 → 結果 → M → 継続・復旧・終了」を通ることを実装目標とする。** 型・schema・fixtureだけで当該仕事が完遂したと報告しない。

判断・権限はHDS-BRAINにあり、人間ownerは最終責任と明示的GOを保持する。LLM、tool、channel、plugin、skill、operator、installer、外部API、memory、history、UI、schedulerは下流装置である。HDS-BRAINのstandalone、Approval Gate、L3最終レビュー、hash-chain audit、Runtime Invariants、capability envelope、Layer A/B、fail-closedは維持する。

## 3. 規則の優先順位と現物照合

1. 上位の安全・実行環境・権限境界。
2. 現在のowner/userの明示指示。工程方法論の変更は指示を反映するが、HDS-BRAIN、Approval、監査、復旧、release gate、owner GO、operator安全を無断で弱めない。
3. 本AGENTS.mdの共通規律および固有規律。近傍AGENTS.override.md／AGENTS.mdは対象固有の安全条件を限定・強化できるが、QEの主従・順序を無言で逆転させない。
4. ownerが最新版と明示した仕様書・工程表・指示書と、適合するactive implementation instruction。日本語の意味正本は規定/00_日本語基底規定.mdを確認する。
5. 契約・コード・試験・現物を観測した進捗。旧版、過去会話、他repoの完成値は履歴や反証材料であり、現行証拠ではない。

毎作業の最新HEAD、dirty state、現行指示を再確認する。rev1.1のNOT_STARTEDや古いSHAで現行成果を上書き・消去しない。既存のdocs/作業標準要領.md、docs/IMPLEMENTATION_INSTRUCTIONS.md、docs/ROADMAP.mdに旧来の「毎小単位の詳細試験・品質保証・Git完結」が残る場合、工程方法は本規定のQEに従い、後続の規定同期対象として差分を記録する。**安全・秘密・実行権限・出荷条件については常に強い保護を維持する。**

「HDSで判断」「品質を高く」などの抽象指示だけを施工命令としない。対象、目的、入力、作用、正本所有、採否、後続consumer、結果観測・帰還、成立条件を操作として特定する。反論・追加形式・定量化は元の対象と因果に関係する場合にだけ要求する。工学的な妥当性は現在の根拠・整合・因果・現実適合と更新可能性で判断し、形式的留保だけを停止理由にしない。

## 4. 不変の優先順位

1. 安全性
2. 堅牢性
3. UX、operator の明瞭性、監査可能性
4. 契約と runtime の整合性
5. 機能・channel・拡張範囲
6. 利便性

機能数や便利さは、安全、権限境界、最終レビュー、監査、復旧、検証証拠を上回らない。安全または堅牢性を弱める機能は拒否するか、無効な preview 境界へ隔離する。

## 5. 作業開始と意図的な切れ目

毎作業の開始・切替・再開、およびセッション・担当の交代時には、[`docs/QE_CURRENT_AUTHORITY.md`](docs/QE_CURRENT_AUTHORITY.md) が示す現行三点セット、適用AGENTS.md、owner指示、active指示、最新HEAD・差分、今回の対象コードを再確認する。三点は今回に関係する節を読み、現行正本として適用する。旧版、完了記録、進捗履歴全体は、依存・変更系譜・矛盾の確認に必要な場合だけ参照する。前回の状態を記憶だけで確定せず、現行正本と現物から再構成する。小単位の切れ目は目的ドリフト防止と実装先の再同期のために作り、毎回QC／QAや全テスト、バックアップ回転を行うためには使わない。

198の小単位は実装漏れ防止の索引であり、工程の主成果は次consumerをつないだBUILD_BATCH単位の実経路である。各小単位はCODE_PRESENT／WIRED／BUILD_GAP／BLOCKED_AUTHORITYの状態と、次に実装すべきproducer・consumerを記録する。小単位の合格票、負例の全数追加、詳細品質保証を先行実装の障害物としない。

作業開始時に対象・目的・到達状態・依存・現在許可された作用を記述し、関連コード、既存検査、契約・責任境界を確認する。関連しないrefactor、依存更新、独自wrapper、実装されないschema増殖、非必要な抽象化を禁止する。read-onlyの調査subagentは並列利用できるが、同一work blockの編集・Git操作・正本確定は単一writerへ集約する。他者の差分をreset、revert、clean、上書きで消さない。

技術的に継続できない構文・型・接続欠陥と、安全・権限・機密の実際の逸脱はその場で修復・遮断する。実物全体の動作後でなければ有意に評価できない詳細欠陥、性能・耐久・境界網羅はQC候補として保持し、委任済みの次の実装へ進む。

## 6. P-Series基準面・検証環境

BLUE-TANUKIでは自動CIを廃止している。.github/workflowsへの新たなworkflowやpush／PR必須checkを無断追加しない。ローカル開発・限定実行・実機証拠を各々の条件で扱い、他環境の成功を転記しない。

ownerの2026-10-19指示により、D4-Pocket現行AGENTS.md §3.1のActions使用条件をBLUE向けに適用する。GitHub ActionsはローカルにないOSのbuild、artifact生成、ローカルでは不足する重い検査・testの補助に必要な場合に限り、`workflow_dispatch`のみで使用できる。push／pull_request／merge_group等の自動trigger、必須status check、自動CI、CI greenによる完成判定は禁止し、ローカル検証を品質基準面とする。

手動Actions検査で一時branchを使う場合は検査対象commitの固定だけに用い、PRや自動triggerを作らない。失敗中のcommitをmainへ入れず、同branchで修正・再検査し、対象検査が閉じた後に成功した正確なcommitだけをmainへfast-forwardする。remote HEAD照合後、一時branchをlocal／remote双方で削除する。必要性、対象commit、trigger、結果、artifact、証明する範囲としない範囲を記録する。workflow追加時はactive ROADMAPまたはphase instructionに目的を置き、手動起動限定をlocal conformanceで検査する。この使用許可はD4のActions条件に限定し、BLUE固有のAuthority、Approval、Audit、秘密、QE段階、release gate、owner GOを変更しない。品質基準面の変更や試験の削除・常時skipはこのQE移行に含めない。

QE_BUILD中は限定した技術疎通と重大な安全欠陥の阻止、QE_QC中は全体品質の観測と改良、QE_QA中は個別対象の保証判定を行う。危険な未接続実行路は有効化せず、合成・隔離端点で全体実装を先行する。

## 7. 工程状態・証拠と完成の射程

QE_BUILDではCODE_PRESENT（コード存在）、WIRED（呼出し接続）、BUILD_GAP（未接続）、SYSTEM_SHAPED（試験用の一仕事が目的から結果・記憶・復帰まで縦断）、BUILD_COVERED（設計で要求された機能群の結合形状）を区別する。各機能の局所PASSは全体品質を証明しない。

BUILD_COVERED後にQE_QCとして実物の機能・安全・故障・性能・資源・OS差・継続性・互換性を検査する。QCが検出した欠陥の原因を設計・実装まで遡って修正し、同じ条件で再検査する。QE_QAはQCの証拠に基づく対象・版・機能・OS・条件別のQA_SCOPED／QA_NOT_ESTABLISHEDである。どの状態もowner GOやAGI理論証明を自動生成しない。

証拠源はCONFIG、INTERNAL_STATE、LIVE_RUNTIME、EXTERNAL_EVIDENCE、FIXTURE。既存テストの数、mockやschema、自己生成のhealth値を実際の統治経路・installed製品の証拠へ昇格させない。BUILD中の最小疎通をQC・QAと呼ばず、QC未開始を理由に実装経路の接続を無期限に止めない。

記録は「何が実際に動いたか」「次consumerはどこか」「未接続・未確認は何か」「実行した確認／未実行と理由」を優先する。取消受付・worker停止・外部作用停止・結果不明を混同しない。証拠不足でも安全のための拒否・SUSPENDは維持する。

## 8. 入力・信頼境界

構造化、parse 済み、schema 形状、別 component 由来という理由で入力を安全とみなさない。権限、permission、execution、approval、audit identity、workspace、command、表示、recovery、release に影響する入力は、必要に応じて次を扱う。

- fail-closed audit 用の raw input 保持
- canonicalization / normalization
- schema / structure validation
- origin validation
- integrity / tamper check
- replay protection
- authority / execution eligibility
- audit emission
- fail-closed / `SUSPEND`

raw invalid input は、独立した fail-closed audit のため HDS-BRAIN へ渡せる場合を除き、gateway history、reply、approval origin、execution に使用しない。外部データ、UI state、adapter/channel/plugin metadata、memory、complete history、diagnostics、tool/LLM output は権限を生成・昇格・置換・迂回できない。

## 9. 実行経路と回避策

通常の production / runtime path は小さく責任限定に保つ。diagnostic、setup、installer、repair、recovery、migration、release verification、fixture、bootstrap、administrative command を黙って混ぜない。追加経路は runtime、control、diagnostic、repair/recovery、build/release、development-only のいずれかへ分類する。

失敗を通ったように見せるための wrapper、shim、別 build path、環境 bypass、host 固有 workaround を導入しない。必要な場合は、元の失敗、根本原因、既存機構で不足する理由、責任範囲、対象環境、検証、恒久性、撤去条件を記録する。

開発環境、local validation、release proof、external runner、対象製品環境を分離する。一環境の成功を別環境の証明にしない。host 制約は product regression と分け、architecture 変更で隠さない。

## 10. Contract と runtime の接続

schema、interface、protocol、adapter contract、capability、manifest、policy、audit/invariant contract、fixture、success profile は、存在するだけでは完成しない。次を特定する。

- 消費する production / runtime / validator / governed execution path
- 実際に通す validation / conformance path
- reject、block、audit、SUSPEND すべき負例
- 意図して未接続または延期した部分

## 11. 禁止事項・開発の包含対象

- custom pnpm wrapper、無関係な依存更新、host制約を隠すbypass、無承認のOS workaroundを導入しない。
- preview packageをgatewayのhard dependencyにしない。doctor／setup／audit／installer／repairを通常runtimeへ静的importしない。
- 無効inboundをhistory/reply/approval origin/executionへ通さず、credential errorをsafe_to_ignoreにせず、未検証を成功へ変換しない。
- agent-driven authority core、emotion機能、WhatsApp first-party core、危険なthird-party skillの無審査実行、権限の隠れた昇格、black-box authorityを追加しない。
- OpenClaw／Museの機能全体を包含する開発目的は保持する。ClawHub等の無審査直接実行型互換は禁止するが、安全・隔離・権限を満たす互換Adapterは将来の個別施工対象として評価する。channel数の誇示を品質指標にせず、未包含機能を黙って要求母集団から削除しない。
- CLI-only最終UX、無審査preview昇格、GA／完全上位互換の未実証公開主張を行わない。
- Public Gitに非公開HDS原典、内部QE施工ZIP・対応表、実資格・秘密・運転状態・raw証拠を入れない。公開可能な規律と非公開の技術詳細を分ける。

実装上の安全・秘密・認可に不足がある機能は無効・保留にするが、設計済み全体目的から消したことにはしない。

## 第II部 BLUE-TANUKI固有の保護規律

## 12. 製品姿勢と HDS-BRAIN 境界

BLUE-TANUKI は local owner operation を前提とする。

```text
Full access may be the default.
Final-review remains non-bypassable.
No black box exists in the HDS authority path.
HDS-BRAIN is a standalone authority control kernel.
```

owner-operated や自己責任を堅牢性低下の理由にしない。first-run success を製品完成とみなさない。

### Standalone

`packages/hds-brain` は `apps/gateway`、`@blue-tanuki/core`、channel/operator packages、plugin loader、Control Center、LLM/browser/GitHub/Google client なしに import、instantiate、test できなければならない。許容依存は Node built-ins、`@blue-tanuki/protocol`、local pure HDS-BRAIN modules に限る。

### 下流装置

下流装置は感知、生成、実行、保存、表示、報告を行えるが、次を行えない。

- 権限判断または承認の代替
- privilege 昇格、risk/actor/process classification の上書き
- final review の迂回
- policy / Runtime Invariants の書換え
- memory/history/session/tool result/external metadata の権限化
- 第二の authority path の作成

### 境界定義ロック

- `tool.call` と `unknown` は high-risk `L3_final_review`
- unknown、ambiguous、unclassified、missing capability、policy-version mismatch、reference/approval ambiguity、external metadata/detector conflict、unknown pattern は自動許可しない
- memory、complete history、session、tool/LLM output、channel/plugin/external metadata、audit viewer、Control Center projection は reference/evidence のみ
- policy、detector、approval、history update は L3 final review
- HDS-BRAIN fail-safe は fallback authority ではなく `SUSPEND`
- self-health fail-safe suspension は human resume で迂回せず、前提を修復して再試行する
- Trinity `M` は deterministic policy であり LLM 等から供給しない

### Output / Result Audit

下流結果は最終表示または外部 handoff 前に HDS-BRAIN output audit を通る。`OutputAudit` は `packages/hds-brain` に置き standalone を保つ。digest と release metadata を記録し raw content を保存しない。output audit は approve、execute、risk classification、final review bypass、第二 authority path を行わない。

### Complete History

`CompleteHistoryStore` は `packages/hds-brain` に置き standalone とする。append / verify / replay / export を提供できるが権限ではない。UI/API projection は digest と metadata に限定し、raw payload、token、credential、command、rendered content を出さない。`used_for_authority=false` と `complete_history_used_for_authority=false` を保つ。

### Runtime Invariants Evidence

Runtime Invariants evidence は `packages/hds-brain` に置き standalone とする。expected/actual、pass/fail、guarantee kind、evidence text、report digest、non-authority flags を含み得るが、approve、policy rewrite、risk classification、consent inference、fallback authority を行わない。失敗時は下流継続ではなく fail-safe inspection/remediation へ戻す。

## 13. 全体不変条件

```json
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "complete_history_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

追加不変条件:

- LLM output、memory、session history、tool output、executor feedback、adapter/channel/plugin/external metadata は権限ではない
- cron / webhook / runtime automation actor は人間ではない
- UI / Control Center / downstream limbs / complete history は第二 authority path を作らない
- unknown / unclassified operation は自動許可しない
- HDS-BRAIN health failure は下流権限へ fallback しない
- Runtime Invariants は外部から検査可能で、audit hash-chain 互換を壊さない
- full access と reusable grant は final review を迂回しない
- onboarding、update、daemon/service restart、dashboard action は Approval Gate を迂回しない

違反が必要に見える場合は作業を停止し、衝突を報告する。

## 14. Approval model と最終レビュー

`ApprovalRisk` を単一軸へ潰さない。

```ts
type ApprovalRisk = "low" | "medium" | "high";
type ApprovalLevel = "L1_observe" | "L2_operate" | "L3_final_review";
```

- `ApprovalRisk` は severity、`ApprovalLevel` は workflow
- high、`tool.call`、`unknown`、全 final-review operation は `L3_final_review`
- full access は L1/L2 を auto-allow できても L3 は不可
- reusable grant は L2 までで L3 を迂回しない
- schedule create/update/delete は L3、schedule list は L1
- `critical` は現 release line に追加しない。必要なら独立 security phase とする

最終レビュー操作の唯一の実装正本は `packages/hds-brain/src/approval_policy.ts` の `FINAL_REVIEW_OPERATION_LIST` である。gateway、UI、channel、plugin、operator などが並行リストを持たない。

少なくとも file delete、`file.edit`、shell exec、external send、credential access、settings write、payment charge、schedule create/update/delete、unknown tool call、GitHub 公開書込み、破壊的 browser 操作、Gmail/Calendar/Drive/Teams/LINE 書込み、daemon/service install、credential 永続化、network exposure、installed code/service metadata/authority policy update を含む。`file.edit`は`tool.file.edit`としてL3最終確認を必須にし、認証済みno-store画面でOperation Plan目的束縛digest・対象版・実差分を確認する。承認前・作用直前の再照合に失敗したら編集しない。差分本文は監査・M・historyへ保存せず、確認projectionは権限ではない。追加時は operation 名、risk、level、full-access containment、reusable-grant non-bypass、audit、docs、rollback/failure を同時に成立させる。

## 15. Operator usability

`first-run success != permanent usability` とする。user-facing operation は setup、normal use、failure、recovery、update、必要な rollback/removal、次 action、audit trace を持つ。

error は「何が失敗したか、なぜか、安全か、owner が次に何をするか、再試行できるか、何が変更されたか、audit/log はどこか」を答える。source knowledge を要求する出力は developer diagnostics と明示する。

「初心者が 5 分で使用可能」は、支援 OS、前提確認、one-command/guided setup、credential check、Control Center、最初の WebChat、optional Telegram、actionable doctor、credential/daemon state、failure rollback の全証拠が揃うまで主張しない。installer は guided first-run を加速するが保証ではなく、secret を表示・log しない。

恒久利用は startup reliability、service clarity、update 時の config 保持、update/rollback runbook、actionable doctor、channel/credential matrix、audit verification、approval/schedule/notification visibility、安全な uninstall/purge、背景 mutation の可視性を要する。

## 16. Runtime automation と外部書込み

- future automation の create/update/delete は L3、list は L1
- pending/rejected/timed-out automation は実行しない
- automation actor は non-human 専用経路から HDS-BRAIN へ入る
- snapshot に payload 内容を出さず digest/hash のみ許容する
- external write は downstream、capability 宣言、Approval Gate、audit を必要とし、public/irreversible は原則 L3
- `browser.read` と browser automation を区別し、sandbox/network/credential/risk/audit/resource/failure/live-smoke が揃うまで automation は preview-only

## 17. Memory / F-reference

memory は context、preference、continuity、audit reference に限る。permission 昇格、approval skip、privileged action、owner consent 推定、current policy override に使わない。append-only、`F:<id>`、hash-chain compatibility、`used_for_authority=false` を保つ。権限化は独立 security phase 以外で行わない。

## 18. Surface、adapter、channel

first-party operator surface は Writing / Daily / Developer の三つで同格とし v1.0 GA 範囲では固定する。各 surface は HDS-BRAIN downstream、既存 tool 利用、operation 単位の L1/L2/L3、audit、containment、Layer A を保つ。追加は owner 決定と別 phase を要する。

adapter / plugin / skill は Layer B の下流装置であり、capability 宣言、canonical inbound/outbound、typed error、audit trace、Runtime Invariants を要する。LLM を authority path から呼ばず、Approval Gate や HDS policy を迂回せず、undeclared filesystem/network/process/credential access を求めない。受入時は `docs/PLUGIN_REVIEW_GATE.md`、`PLUGIN_HIG.md`、`SKILL_LOADER_CONTRACT.md`、`ADAPTER_CONTRACT.md`、`CAPABILITY_ENVELOPE.md`、`CONFORMANCE.md` を確認し、`pnpm plugin:review -- --package <dir>` を通す。その結果も non-authority evidence である。

channel 状態:

- WebChat / Telegram: first-party
- Slack / Discord / Teams / LINE: owner-run credentialed live smoke、回復性、Teams/LINE inbound listener closure 前は `first-party-preview`
- WhatsApp: 意図的な `reserved-third-party`、`core_supported=false`、`warranty=none`

Baileys、WAHA、WhatsApp Web automation、first-party WhatsApp Business API、Twilio WhatsApp の first-party core、hidden hook を実装しない。channel 数を品質指標にしない。昇格には `pnpm validate:channels`、redacted owner evidence、setup/credential/live-smoke/inbound/outbound/backoff/actionable error/conformance/metadata non-authority が必要である。

未完成・実験的・高リスク・第三者的機能は preview へ隔離し、conformance、permission、audit、Runtime Invariants、support level、failure mode が揃うまで昇格しない。

### 最終対応OSの規定（5OS）

BLUE-TANUKIの新AGI製品の完成対象は**Windows／Linux／macOS／Android／iOSの5OS**。Windows-firstは開発順序であって最終製品の対象を減らさない。対応済みという現状主張ではない。

Windows、Linux native、macOSはそれぞれDesktopの導入・通常仕事・権限・復旧を実装する。WSL／WSLg／headlessの証拠をLinux nativeへ転用しない。AndroidとiOSは独立したMobile製品入口とし、native導入／初期設定、OS権限、秘密保管、認証済みDevice Link、仕事の開始・状態観測・Owner承認・取消・中断復帰、更新・削除を各OS別に成立させる。

Mobileの招待・device credential等の秘密はnative境界に置き、Dart、platform-channelの戻り値、ログ、traceへ返さない。TLS以外への自動fallback、切断後の無断再送、Mobile UIがHDS-JまたはD4Pocket Brokerの権限を代行する経路を禁止する。D4Pocketの既存Mobile契約を参照し、別repo変更は限定委任に従う。

「MobileクライアントがDesktop Brokerを経由して仕事を行う」ことと「Mobile端末単独でC/J/Mや実作用を稼働させる」ことは別能力。後者を本規定だけで実装済み・必要条件成立とは扱わない。

従来F16のモバイル入出力だけではOS別製品の成立条件を満たさない。現行の非公開QE rev2.3はAndroid G09とiOS G10の各三単位を含み、旧192単位と合わせて198単位とする。全体実装後にOS別QC、対象別QAを行い、AndroidとiOSの実機証拠を相互代用しない。旧1.0 RCのMobile非搭載の記録と新5OS開発目標を区別する。公開要約はdocs/PLATFORM_TARGETS_QE.md。

## 19. 競合比較・互換性と公開境界

OpenClawとMuseは機能名の数ではなく、実際にできる仕事、接続の深さ、導入・回復・長期運転、統治・互換性を比べる対象とする。旧OpenClaw拒否監査は危険patternの反証材料として保持するが、今回の完全包含という製品目標を縮小するために使わない。既知の未包含を隠したり、安全保護を解除して包含済みと報告したりしない。

P13はPENDING_OWNER_GO、version 1.0.0-rc.1、public_claim_allowed=falseのまま維持する。全体実装・QC・対象別QA・必要なOS／live証拠・ownerの明示GOが揃うまで、GAや完全上位互換・AGI完成を実証済みの対外主張へ昇格させない。

## 第III部 現行QE施工・再同期規律

## 20. QE施工運転・次の実consumer優先

現行工程の設計・順序・施工手順はownerが最新版と指定したQE仕様／工程表／指示書を正本とする。docs/IMPLEMENTATION_INSTRUCTIONS.mdは個別のactive task、docs/ROADMAP.mdは公開要約、docs/開発進捗.mdは観測済み履歴を持つ。これらに残る旧「毎小単位の詳細QA／full test／Git closure」は、本QE規律に反する工程方法として上書きし、規定同期作業へ記録する。安全条件・公開の保留は旧版でも維持する。

工程状態はQE_DESIGN → QE_BUILD → SYSTEM_SHAPED → BUILD_COVERED → QE_QC → QE_QA → QE_RELEASE_REVIEW。QE_QCは全体実装形状の成立後であり、QE_QAは個別対象を限定してQCの証拠から判定する。198施工単位は分解・依存・再同期の索引であって198個のQAゲートではない。

BUILD_BATCHは小単位をいくつかまとめて、目的→C→J→Broker／Executor→結果→M→帰還の実際のproducer／consumerを前進させるまとまりとする。小単位ごとに現行三点セットの該当節、適用AGENTS.md、active指示、現物を再確認する。旧版・閉じた施工記録は必要時だけ参照する。接続済みか未接続かを記録して次へ進み、バッチ末に最低限の技術疎通とGit保全を行う。schema・型・mockだけを積み上げて完了扱いしない。

大きなバッチ指示には、目的・現状・次consumer、対象／非対象、関係単位ID、安全条件、停止条件、必要な技術確認、Git復元点、再同期条件を明示する。旧指示書の16節は利用してよいが、全小単位への品質票作成義務にはしない。

本規定の採用だけで製品作業を再開しない。最新owner停止指示、C08.03実provider試験の保留、別repo・実業務・公開行為の限定承認を維持する。

## 21. QE品質活動とGit閉包

### 1. BUILDとQC・QAの責務

小単位はCODE_PRESENT／WIRED／BUILD_GAP／BLOCKED_AUTHORITYの途中成果であり、全test・QA合格・全体検査・個別のcommit/pushを閉鎖条件にしない。BUILD_BATCHは意味のある縦断機能の接続を一つの施工・保全単位とする。BUILD_COVEREDの後で初めて全体QE_QCへ進み、欠陥を根本原因から修正・再検査する。QAはその結果を個別対象に限定して評価し、owner GOは独立する。

### 2. 安全を維持した実装中の最小確認

QE_BUILD中に必要なのは、構文・型・変更したproducer／consumerの疎通と作業継続を阻む欠陥の除去である。重大なAuthority、Approval、秘密、監査、非冪等外部作用を変更する場合は、無権限実行を防ぐため必要な局所否定確認をその場で行う。危険な作用経路は保護が確認できるまでdisable／SUSPENDとし、実credentialや実外部作用を使用しない。既存test・検査・保護を削除・恒久skipして進行を速くしたことにはしない。

バッチ境界では対象の型検査・必要なbuild・接続部分の短時間smoke・差分チェックを実施する。環境復元または依存変更時はfrozen lockfileを照合する。HDS権限中核を変更したバッチでは関連するstandaloneと安全確認を行う。全体pnpm test、全数conformance、故障注入、耐久、性能、全OS、競合比較は完成した実物を対象とするQE_QCへ配置する。release経路に関する別の必須保護検査・GA／bundle／verify、ownerの実機検査は省略しない。

実行すべき対象確認の例：pnpm typecheck、pnpm build、pnpm exec vitest run <対象のtest file>、pnpm hds:standalone。QE_QCの開始後にpnpm test、pnpm docs:check、pnpm validate:repo-health、pnpm run doctor、pnpm validate:packaging、必要なsmoke／実機を実施する。規定・文書更新では変更に関係するdocs:check／日本語基底監査、release変更ではGA／bundle／verifyを必ず扱う。実行不能ならNOT_RUNと根拠を記録し、公開保証へ昇格させない。

### 3. 実装バッチでの仕上げ

バッチが前進させた実挙動、未接続の残差、次consumerを記録する。関連するcode・contract・必要なdocs／履歴をバッチ単位で整合させ、一小単位ごとの文書更新儀式・全体QC・品質保証を廃止する。無関係なrefactor、不要な抽象化、一時物は除去し、安全を壊す既知欠陥は即修正または遮断する。

### 4. Git運用と復旧点（D4Pocket方式）

mainを唯一の開発正本とし、単一writerがBUILD_BATCHまたは統治改訂の編集前にorigin/main、ローカルHEAD、dirty差分と他writerを確認する。小単位の切替ごとにバックアップ世代を回さない。

**D4Pocketと統一する正規方式は、ローカル復旧用branch二本（refs/heads/codex/backup-main、refs/heads/codex/backup-main-prev）とGitHub上のPR-neutralなtag二本（refs/tags/codex/backup-main、refs/tags/codex/backup-main-prev）。** 現backup-mainをprevへ退避し、編集前mainをbackup-mainへ保存する。確認済みの旧remote tag SHAを期待値とするforce-with-leaseで二本を原子的にpushし、tag二本のremote SHAとmainを照合する。GitHub上の同名backup branchを正規世代として維持しない。

**移行状態はMIGRATION_COMPLETE（2026-10-12）。** remote backup tag二本への保存とSHA照合後、旧remote backup branch二本を期待SHA付きatomic pushで整理した。local recovery branch二本とremote tag二本は同じ二世代に揃っている。完了時SHA、手順、検証証拠はdocs/BACKUP_REF_MIGRATION.mdを参照する。今後もref競合、他writer更新、照合不足があれば変更を止め、完了宣言しない。

BUILD_BATCH終了時に限定commitをmainへpushし、remote HEAD、バックアップrefs、作業ツリーと復元点を照合する。tag移行は2026-10-12に閉鎖した。将来のタグ作成・移行・branch削除・mainのforce pushは、確認・権限なく実施しない。secret、内部HDS/QE原典、credential、実運転状態、debug一時物をGitに混ぜない。reset --hard／cleanで既存作業を消さない。

### 5. 旧規定との移行

本§21は旧§21の「各phaseでfull test、個別QA、毎回backup/commit/push」をQE方式へ正式置換する。これはテスト体系や安全保護の廃止ではなく、適用時期と対象の配置変更である。下位の旧作業標準・指示・進捗に矛盾が残るときは公開可能な差分を記録し、次の認可済み規定同期バッチで改訂する。

### 6. Validation

旧文書のAGENTS.md#6-validationから参照される互換見出し。現行の検証強度・実行時期・未実施の扱いは本§21.2と§21.3を正本とする。小単位ごとにfull suiteの合格を要求する旧文書の手順は、QE_BUILDの方法として適用しない。ただし安全に必要な限定否定確認、出荷時の必須検査、正確な未実施記録は維持する。

### 7. Git closure

旧文書のAGENTS.md#7-git-closureから参照される互換見出し。現行Git規則は本§21.4を正本とし、D4Pocket方式のlocal二世代branch／remote二世代tagとする。旧remote backup branchはtag二本の移行・remote照合まで保全し、移行完了後だけ競合検出付きで整理する。毎小単位の世代回転は行わない。

## 22. 環境

Windows-firstは開発・施工の優先順であり、5OSの最終製品対象を縮退させない。OS別の実装・QC／QAはdocs/PLATFORM_TARGETS_QE.mdを参照する。

owner 指示により、通常の編集・ビルド・テスト・起動・Git 操作は Windows を標準とする。Windows で成立する開発に WSL を必須としない。WSL / native Linux は、Unix 実行属性を必要とする配布生成・検証など、Windows で成立しない作業の補助環境として使用する。再現手順は `docs/開発環境.md` を参照する。

環境条件:

- Corepack pnpm 9.12.0
- Node 22.14.0 以上
- WSL / native Linux で検証するときは ext4 workspace を使用する
- WSL 内の active workspace に `/mnt/c` を使わない。Windows 側の通常開発場所を禁止する意味ではない

`pnpm` がない場合は Node / Corepack / pnpm を確認・復旧し、それでも不可なら環境制約として報告する。product code で隠さない。WSL で `tsx` が Windows の一時パスを掴む場合は、product regression と混同せず安全な Linux 一時ディレクトリを使用する。

`pnpm smoke:serve` / `pnpm smoke:resume` は既知失敗扱いではない。smoke、root workspace、release gate を扱う phase では実行し、通常 phase で省略した場合は scope 上未実行と報告する。credential 不在の `pnpm smoke:live` は SKIP を許容する。

## 23. 文書規則

- internal-design perspective を保ち marketing 最適化しない
- 不要な legal commentary を追加しない
- 安全優先順位を弱めない
- 精密な engineering language を用いる
- unsupported / unsafe path を first-party 外として明示する
- non-goals と gap を完成機能から区別する
- current implementation と target state、first-run と permanent-use を分ける
- private HDS/source-philosophy や sealed core details を公開 process docs へ展開しない
- active docs を日本語正本化し、固定識別子だけを必要範囲で併記する
- 過去文書は現行仕様として無言再利用しない

## 24. 毎タスクでの読み直し・目的再同期

毎作業および小単位を開始・切替・再開するたびに以下を行う。

1. 最新owner指示、最新版の三点正本（仕様書・工程表・施工指示書）すべて、rootと最寄りのAGENTS.md、およびactive指示を読み直す。前回の読取結果・会話要約・記憶で代替せず、旧会話・旧版から現行進捗を推定しない。
2. 現在のmain HEAD、remote、dirty差分、ownerや他writerの作業と未決作用、私有資料の扱いを確認する。
3. 今回の対象、目的、作用、入出力、次consumer、期待する観測、安全保護、停止条件を短く固定する。
4. 関連contract／本番呼出し先／局所testを確認し、必要十分なコードを連結する。次の実装を進められない欠陥は直す。
5. CODE_PRESENT／WIRED／BUILD_GAP／BLOCKED_AUTHORITYと次の接続箇所を残し、切れ目で指示を再読する。小単位ごとのQC・QA・全suite・Git世代回転は挟まない。
6. BUILD_BATCHの終了時だけ、§21の限定技術確認・Git閉包・報告を行う。ownerの停止指示や危険な未承認作用があれば続行しない。

初回には規定/00_日本語基底規定.md、SECURITY.md、AUDIT.md、CONFIG.md、README.md、CHANGELOG.md、docs/作業標準要領.mdも必要に応じて確認する。以後の再読はAGENTS・現行目的と指示・影響コードを必須とし、無関係な全文書の再生成を義務化しない。作業の中断点はモデル内部の消去保証ではなく、正本と現物から状態を作り直すためのものとする。

## 25. 最終報告

BUILD中の報告は次を中心に簡潔にする：QE_STAGE、BUILD_BATCHと単位ID、実際に通るようになった仕事／consumer、未接続のBUILD_GAP、次の接続点、安全境界、行った技術確認と未実施、原因分類、実際のmain HEAD、commit/push、remote HEAD、backup refsと復元点。細分化した小単位のQA合格を成果として報告しない。

QE_QCでは対象実物・版・環境・機能母集団、欠陥と根因、修正と再検査、未観測の範囲を報告する。QE_QAでは個別の対象・版・OS・条件・証拠源と、QA_SCOPED／QA_NOT_ESTABLISHEDを記録する。製品releaseに必要なowner GOは独立に扱う。

残存項目のrelease_blocker／post_v1_scope／known_limitation、原因の今回起因／既存／環境限定／未確定は別軸。未検証・未同期・未接続を隠さず、公開阻害を言い換えて消さない。実際に行っていない試験をPASSとしない。

## 26. 参照元の採否と範囲

- D4Pocket（旧GUI-Shell）のAGENTS.mdの2026-10-12確認版から：正本と現物照合、作業の限定、安全優先、証拠分類、信頼境界、通常経路最小化、環境差、wrapper説明責任、single writer、owner GO独立を抽出した。
- 移植しない：D4固有のFlutter／Rust／Swift／Windows／macOS transport実装、D4の閉鎖済み工程、D4用試験成功値、別repoへの書込権。
- ownerの現行開発方針から：毎タスクAGENTS.md・指示書を再読して目的ドリフトを抑制し、切れ目を意図的に設ける。ただし一気通貫実装を最優先とし、QCと対象別QAを後段に配置する。
- 本文の既存§§12〜18にあるHDS-BRAIN standalone、L3、Approval、audit、memory非権限、Runtime Invariants、channel／plugin／operator境界は継続適用する。原理の非公開詳細をPublic Gitへ持ち込まない。

