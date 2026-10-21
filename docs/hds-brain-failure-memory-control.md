# HDS-BRAIN 失敗記憶制御

この文書は、HDS-BRAIN failure memory control v2の境界と運用を定める。

## 目的

失敗記憶は、complete history、command result、tool result、test result、workflow result、LLM output validation、authority boundary decisionから失敗署名を作り、将来の実行前に決定的なgateとして参照する制御資産である。static blacklistを作ることが目的ではなく、失敗の再発を減らしながら探索と条件付き再試行を保つ。

```txt
Complete Log
-> Failure Signature Extraction
-> Failure Memory Store
-> Pre-Execution Failure Gate
-> Execution Result
-> Complete Log
-> Periodic Verification
-> Rule Update / Revalidation / Retirement
-> Pre-Execution Gate
```

## 権限境界

- LLMはfailure logの要約、分類候補、signature候補の説明を補助できる。
- LLM proposalは`draft` signatureとして扱い、`suppression_policy`を直接確定できない。
- HDS-BRAINの決定的なfailure-memory logicが`warn`／`downrank`／`rewrite`／`require_approval`／`block`を選ぶ。
- Complete historyは証拠であり、権限ではない。
- Failure memoryは再利用可能な制御資産だが、Approval Gateやfinal-review境界を置き換えない。

`FailureSeverity`の`critical`はfailure-memory専用の重大度であり、Approval Gateの`ApprovalRisk = low | medium | high`とは別軸である。

## 保存

`FailureMemoryStore`は`packages/hds-brain`内の単独componentであり、gateway／executor／UI／channel／LLM backendに依存しない。

保存先:

- `BLUE_TANUKI_FAILURE_MEMORY_FILE=/path/to/failure-memory.json`
- `BLUE_TANUKI_FAILURE_MEMORY_DIR=/path/to/dir`の場合は`failure-memory.json`
- 未設定時はmemory内だけに保持

signatureはevidence log id、state、confidence、severity、suppression policy、probe policy、再検証予定、TTL／decayを持つ。retired ruleも削除せず履歴として保持する。

## E05.03：開発系への候補引き渡し

明示されたDeveloperのfailure reviewからHDSがrequest-boundで保持した候補は、`DevelopmentHandoffStore`へ別ファイルで渡し、Developer surfaceの読み取り専用inboxに表示する。保存先は`BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE`で個別指定できる。未指定でFailure Memoryのfile／dirが永続設定されている場合は、その隣の`development-handoffs.json`を使う。いずれも未設定ならin-memoryに留まり、再起動後の保持はしない。

このinboxはFailure Memoryの実行前gate、HDS-J、Approval Gate、Brokerから独立した開発レビュー資料である。候補本文はruntime storeやauditへ追加せず、inboxの専用fileと認証済み・no-storeのDeveloper snapshotにだけ含める。妥当性・改善・汎化・内部導出帰属はそれぞれ未評価のまま表示し、候補の承認、実行、コード／Pの版昇格を行わない。開発主体による別の確認・実装判断が必要となる。

## E04.01：条件付き署名

新たに抽出するcommand failureは、目的本文・引数・LLM message・channel宛先／本文・errorをfailure memoryへ保存せず、SHA-256 digestと固定の分類値だけを保持する。署名は`input_pattern`（goal digestとJ decision）、`action_pattern`（operation、制約、target／arguments digest）、`context_pattern`（actor digestとchannel）、`result_pattern`（症状digest）に分ける。`cause_candidates`はerror分類から得た未確定候補、`unknowns`は未観測の原因・予測差などを明示し、原因確定や予測差を捏造しない。

command gateは保存済み署名と新候補の目的・action・actor／channel条件がすべて一致した場合に通常照合する。request ID、command ID、surfaceは条件から除く。commandではpath／hashの正規化、operation名だけのLevel 2一致、Level 3の意味類似を使わず、異なるaction／targetへfailure ruleを広げない。

同じ完全一致`action_pattern`で現在のHDS判断が新たに`ASSERT`し、goal／actor／channelのfingerprintだけが変わった場合、activeな`block`／`require_approval`署名は条件変化の再観測候補として扱う。通常のApproval Gateにfresh approvalを要求し、旧承認は再利用しない。`block`かつ`probe_policy=never`なら引き続きblockする。失敗署名と元の証拠は変更・削除せず、fingerprint差分だけで外部条件の解消を証明したり自動実行したりしない。異なるaction／targetは候補にしない。

Complete Historyの`failure_patterns`は同じhelperが作るdigest-only投影であり、履歴自体は引き続きreference／evidenceに留まる。

`failure-memory-v2`の既存snapshotは読み込み互換を維持し、自動書換え・破棄をしない。旧command signatureに条件付きpatternがない場合、新command gateでは適用せず、`legacy_history_missing_conditioned_patterns`等のunknownを保持する。既存snapshotのraw値をこの変更が遡及消去したとは扱わない。

## 実行前gate

gateway serve／CLI one-shotはexecutorを呼ぶ前にfailure-memory gateを評価する。

| gate結果 | 実行時の扱い |
|---|---|
| `allow` | 通常のApproval Gate／executor経路へ進む |
| `warn`／`downrank`／`rewrite` | gate判定をcomplete historyへ記録する。現在は実行を止めない |
| `require_approval` | WebChat serveは人の承認を要求する。CLI one-shotはfail-closedで停止する |
| `block` | executorを呼ばず、command lifecycleをrejectedとしてauditへ残す |

human approvalから再開する場合も`block` ruleは通過できない。`require_approval`はそのcommandへの人の明示確認で進める。

## 照合水準

- Level 0：完全一致。command／path／test／environment／boundaryを対象にできる。
- Level 1：正規化一致。一般候補ではUUID、timestamp、hash、path、空白を決定的に正規化する。
- Level 2：構造一致。一般候補についてscopeとaction構造が一致する場合に限る。
- Level 3：意味的な近似。tokenの類似だけを使い、自動blockは禁止する。

structured command candidateはLevel 0／1の正規digest一致だけを使い、Level 2／3のfallbackを適用しない。ここでのLevel 1は目的・action・actor／channelの条件一式の厳密一致であり、request IDなど実行ごとに変わる値だけを除外する。Level 3は`warn`／`downrank`までとし、`block`／`require_approval`へ昇格させない。

## 定期検証

manual／daily／startup／after-test-failure／before-release／post-failureのtriggerを`runPeriodicFailureMemoryVerification`が受ける。gateway CLIでは次を使う。

```bash
pnpm gateway -- --failure-memory-verify
pnpm gateway -- --failure-memory-verify --json
pnpm gateway -- --failure-memory-verify --before-release
```

verifierは次を検出する。

- repeated failures
- unconverted failure events
- stale block rulesとold evidence rules
- hit countが高くconfidenceが低いrule
- semantic-only ruleの過剰適用
- stale block ruleの緩和候補
- warningからのpromotion候補
- authority／boundary near-missのreview候補

reportは`PeriodicVerificationReport`として構造化出力する。

## 再検証・減衰・終了

`block` ruleは次のいずれかを持つ。

- `next_revalidation_at`
- `probe_policy = never`と`never_probe_justification:...`
- critical severityに対するpermanent block justification

| probe policy | 意味 |
|---|---|
| `manual` | 人の確認なしにprobeしない |
| `sandbox` | 隔離・安全なcontextで検証できる |
| `shadow_only` | 実行せず、将来候補との照合だけを行う |
| `never` | destructive／credential／security／authority／boundary rule用 |

critical ruleは自動終了しない。low／medium／high ruleはTTLとdecayによりprobation／retiredへ移る場合がある。false positiveはprobationまたはretiredへ移すが、audit historyは保持する。
