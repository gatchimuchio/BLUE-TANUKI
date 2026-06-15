# BLUE-TANUKI 製品完成ロードマップ v2.1（確定版・実装現状反映）

作成: 2026-06-11 / クロちゃん（独立監査役）
**決定記録: 2026-06-11、ご主人様がD1〜D7をクロちゃん推奨どおり承認・確定。本決定をもって2026-05-23のBLUE-TANUKI凍結を解除する（D1発効）。**
根拠: 同日のリポジトリスナップショット実測監査（install/typecheck/build/test 667/667 green、validate:ga Bar A–F pass・G pending、hds:standalone all_ok=true、smoke:serve/resume/validate:packaging PASS、各ソース直接確認）。本書の「現状」欄はすべて実測ベース。

---

## 0. 文書の位置づけ

- 本書は **製品完成スコープの単一ロードマップ** として、`docs/ROADMAP.md`（v9, Band A–F）の「製品完成」に関する記述を上書きする。
- 実装指示の source of truth は引き続き `docs/IMPLEMENTATION_INSTRUCTIONS.md` + `AGENTS.md`。**本書採用後の最初のCodexタスクは、両文書へのP系列反映と `docs/ROADMAP.md` への置換宣言の追記**とする。
- 命名規則: 製品PhaseはP1〜P13。既存の Phase X-SY 系列・Band A–F とは衝突させない。各P-Phase内のCodex指示は従来通り機能塊単位（Phase Pn-S1, Pn-S2…）で起票する。
- 開発運用は従来原則を維持: single-track（Codexセッションは直列。本書の「並列可」は依存関係上の着手順自由を意味し、同時並走を意味しない）、機能塊間でのみ監査を挟む。

## 1. Owner決定事項（D1–D7。2026-06-11確定済）

| ID | 決定事項 | 確定内容（クロちゃん推奨を採用） | 確信度 |
|---|---|---|---|
| D1 | 凍結解除 | 本書採用をもって2026-05-23凍結を解除（2026-06-11発効済） | — |
| D2 | rc.1/Bar G処遇とバージョン戦略 | 1.0.0を「Windows製品完成」に再定義。現1.0.0-rc.1は新基準下でrc継続（rc.2…）、旧Bar GのGOは発行せずP13基準に吸収。代替案（Linux core GAを1.0で先行）はclaim二重管理コストのため非推奨 | 85% |
| D3 | 署名 | v1は非署名維持（CLAIM.md「Signed native installer and automatic updater: not shipped」と一致）。代わりにP3でSmartScreen通過手順とsha256検証手順を製品文書化。署名はpost-v1の調達課題（証明書取得・身元検証は外部依存、Codexスコープ外） | 80% |
| D4 | Windows検証基盤 | 公開repoのGitHub Actionsに windows-latest job を追加し `package:windows`→`smoke:windows-installed` を自動化（公開repoは無料枠）。加えてGO前にowner実機E2Eを最低1回 | 90% |
| D5 | 製品ビルドのdefault ApprovalMode | アーキテクチャ既定（full_access）は維持し、first-runセットアップでownerにmode（ask_every_time / remember_this_decision / full_access）を明示選択させる。authority_model="owner_operated_full_access" 系のclaim・テストへの波及を避けつつ「ユーザーが何を許可したか理解できる」を満たす | 85% |
| D6 | プラグインAPI / skill loader面のv1スコープ | 含める。ただし範囲は「既存資産（SKILL_LOADER_CONTRACT / PLUGIN_HIG / plugin:review gate）の整合確認とAPI安定度宣言」まで。エコシステム拡張はpost-v1。2026-05-13戦略フレーム「最初から公開品質」と両立 | 85% |
| D7 | Operator 3種の区分 | first-party確定（package.jsonは既に "First-party … Operator" を自称しており、killer-app戦略フレームとも整合）。条件: validate:productに3 operator smokeを含めPASSすること。preview降格を選ぶ場合はpackage.json記述修正が必須 | 85% |

## 2. OS戦略（v1から変更なし・確定）

| OS | 位置づけ | 完成判定での扱い |
|---|---|---|
| Ubuntu/Linux | 開発・常時検証・回帰検出の基準面 | 常時グリーン必須。壊れたらWindows以前にブロック |
| Windows | 最終製品ターゲット・配布ターゲット | 製品完成の最終判定面 |
| macOS | 後続展開（install/macosは現状薄いshellのみ） | v1必須対象外 |

## 3. 製品完成の定義（v1踏襲）

Windowsユーザーが、Node / pnpm / Git / Ubuntu / CLI 知識なしでインストールし、Control CenterからLLM設定・外部API設定・会話・承認・監査・復旧・停止・削除まで操作できる状態。

必須条件: Windows一発インストール／常駐起動／Control Center GUI／初回セットアップ／LLM provider設定（OpenRouter導線＋自前provider層）／WebChat動作／Approval・Permission管理／Audit・Evidence表示／Doctor・Recovery／Stop・Restart・Logs・Uninstall／Linux常時グリーン／Windows実機E2E証跡／owner GO。

## 4. 判定ゲート体系

| ゲート | 役割 | 状態 |
|---|---|---|
| validate:ga | 文書・台帳・主張整合の確認（readFile+includes照合。実行検証なし＝実測確認済） | 既存。製品完成判定には使わない |
| **validate:product**（新設） | 実動作・実UI・実OS・実復旧・実監査の確認 | P2で新設。**増分ゲート**: 各Phase完了時に検査項目を追加し、P13時点でフルセット必須化 |

製品完成判定 = Linux CI full green ＋ validate:product full PASS ＋ Windows実機E2E evidence pack ＋ owner GO。

**validate:product 増分登録表**

| 追加Phase | 検査項目 |
|---|---|
| P2 | ゲート骨格＋Linux系: test一式 / smoke:serve / smoke:resume / hds:standalone / SUSPEND実発火（動的） / approval bypass不能（動的） / audit chain verify / evidence pack生成 |
| P3 | package:windows verify / smoke:windows-installed（win環境） / install→常駐→stop/restart/logs→uninstall往復 |
| P4 | Control Center操作スモーク（API経由） |
| P5 | live LLM smoke（owner資格情報、opt-in→P13でrequired化） / 鍵保護検査 |
| P6 | approval allow・ask・deny・revoke・emergency stopの動的検証 |
| P7 | evidence pack内容検査＋secret redaction検査 |
| P8 | Composio dry-run no-call / live opt-in / toolkit+action allowlist / action revoke / L3 final-review non-bypass / fixture live execution / pre-post audit |
| P9 | channel/operator/package/claim整合 / bundled plugin review / plugin-loader operator surface / Layer B v1 contract-stable境界 |
| P10 | backup→破壊→restore往復 |
| P11 | release bundle verify＋update失敗rollback |

## 5. ロードマップ本体（P1–P13）

各Phaseは「目的／現状（実測）／残差（Codex指示化対象）／完了条件」で構成。**現状欄に挙がった項目は再実装禁止**。

---

### P1 Linux基準面の固定

目的: Ubuntu基準面を常時グリーンに保ち、Windows作業中の回帰を即検出する。

現状（実測）: **実質done**。CI（ubuntu-latest）で install / typecheck / build / test(667) / docs:check / validate:repo-health / validate:packaging / validate:channels / plugin:review / validate:ga / smoke:serve / smoke:resume / smoke:live / doctor（fail-closed検証含む） / release:bundle＋verify / docker build まで自動化済み。

残差: P系列開始時点のCI構成を「P基準面」として凍結宣言し、以後の基準面変更はP-Phase経由のみとするルールをAGENTS.mdに1項追加。

完了条件: 基準面凍結の明文化。CI green維持。

確信度: 98%

---

### P2 実体検証ゲート（validate:product）新設

目的: 台帳PASSではなく実動作PASSで製品判定する。

現状（実測）: **done**。`scripts/validate_product.ts`、増分登録、`--evidence` evidence pack、P2 Linux系check、CI `pnpm validate:product` 組込み済み。

残差:
- P2内の実装残差なし。P13までに増分項目が追加されるたびに `validate:product` へ登録する。

完了条件: §4のP2行がLinux上でPASS。「文書に書いてある」ではなく「実際に動いた」で判定できる。2026-06-12時点のローカル検証では `p2.test_suite` を含む required 7件PASS。

確信度: 95%

---

### P3 Windows導入の完成

目的: Windows上で製品として導入・常駐・停止・削除できる。

現状（実測）: **実装大部分done**。`BlueTanukiSetup.cmd/ps1`、`%LOCALAPPDATA%\Programs\BlueTanuki`＋`%APPDATA%\BlueTanuki`配置、Start Menu・ショートカット登録、Launcher（open/start/stop/restart/status/doctor/logs/safe-mode）、`BlueTanukiDoctor.cmd`、Uninstall 2系統、**Node公式ランタイム同梱**（package_windows.tsがnodejs.org公式zipをbundle。installer testで「end-user pnpm/node/git不要」を検証済）、`package:windows`＋verify、`smoke:windows-installed`、port競合検出、watchdog crash recovery、repair install設定保持、safe mode起動、SmartScreen/SHA-256手順文書化、windows-latest `validate:product --phase P3` job、Windows evidence artifact保持、CI上のP3 evidence artifact確認が実装済み。

残差:
- GO前のowner Windows実機E2E evidence pack（D4）

完了条件: 実機またはwindows-latest上で install→常駐→stop/restart/logs→uninstall がE2E PASSし、evidence取得。CLIなし導入が成立。

確信度: 93%

---

### P4 Control Center 製品化

目的: BLUE-TANUKIを「リポジトリ」ではなく「アプリ」として操作完結させる。

現状（実測）: **partial（高進捗）**。実装方式は確定済み——gatewayが配信するweb UI（`control_center_html.ts` 約1,600行）。ネイティブアプリ化はしない（GUI-Shellは別製品であり本書スコープ外）。既存panel: Dashboard / Conversation(WebChat) / Approval Policy / Approval Queue / Approval Model / Authority Trace / Authority Audit / Runtime Snapshot / Runtime Schedules / Tasks / Memory / Skills / Channels / Connectors / Doctor / Settings / About / Backup / Restore / Developer-Evidence / Notification Center / Complete History-Replay / System / First-Run Next Action / Permanent-Use Status 等。LLM provider設定はControl Center本体のSettingsタブから既存settings token gate経由でload / verify / save可能。Composio connector設定はControl Center本体のConnectorsタブから同じsettings token gate経由でdry-run default / live opt-in / user id / toolkit+action allowlist / revoke / disconnectをload / save可能。AboutはWebChat token gate付きread-only `/app/about` 経由でversion / claim boundary / license / signed installer / automatic updater / authority boundaryを表示可能。Backup / RestoreはWebChat token gate付き`/recovery/snapshot` / `/recovery/backup` / `/recovery/restore` / `/recovery/reset-provider` / `/recovery/reset-connector` / `/recovery/factory-reset` 経由でenv backup inventory・recovery pack・persistent data path・restore/reset/factory reset control・non-authority境界を表示/実行可能。GUI仕様書5本（GUI_PRODUCT_SPEC等）も既存。

残差:
- Update パネル（P11連動）
- Windows実機での描画品質確認

完了条件: §3の必須操作がGUIで完結。env手編集・token手貼り不要。

確信度: 90%

---

### P5 LLM Provider 実運用化

目的: stub依存から脱却し、実LLMで製品として使える。

現状（実測）: **partial（高進捗）**。provider registry（anthropic / openai_compatible / OpenRouter既定endpoint / stub）、CCからのkey・model・endpoint設定、live smoke（`smoke:live`: 実応答 "BLUE-TANUKI-LIVE-OK" 検証、timeout付、資格情報なければskip）。LLM層にはtyped provider error分類、明示retry/fallback設定、non-authority health snapshot、Windows DPAPI CurrentUser secret ref保存、runtime secret ref解決、`validate:product` P5の実HTTP abort timeout / settings verify timeout / Windows DPAPI connector secret roundtrip checkが追加済み。

残差（実測で不在を確認）:
- Windows実機でのDPAPI保存→restart→会話成立 evidence
- Linux/macOS keychain保存（必要性・方式決定含む）
- owner資格情報でのlive smoke PASS証跡（Linux・Windows両方）

完了条件: 両OSでlive smoke PASS。CCから設定→会話成立。鍵がOS保護下にある。

確信度: 90%

---

### P6 Approval / Permission / Authority 閉包

目的: 中核価値（承認・権限・取消・緊急停止）を製品UIで完結させる。

**用語修正（v1からの変更点）**: 本書のL1/L2/L3はコード定義に一致させる。
- ApprovalLevel = **L1_observe / L2_operate / L3_final_review**
- ApprovalMode = **ask_every_time / remember_this_decision / full_access**（既定: full_access）
- v1ロードマップの「L1=毎回確認／L2=条件付き恒久承認」はModeの記述でありLevelではない。混同禁止。

現状（実測）: **実装done（Linux fixture / live route evidence）**。5軸policy（operation×scope×risk×actor×capabilities）、final-review境界（FINAL_REVIEW_OPERATION_LIST）、AuthorityTransparencyTrace、approval bypass検出テスト、composio metadata権限非昇格テスト、CC上のApproval Queue / Policy / Model / Authority Trace / Audit panel。自動SUSPEND（fail-safe 6条件、human resume不可）に加えて、Control Center Approvals上のowner emergency stop、resume-token-gated grant revoke、sanitized approval history、settings / first-run ApprovalMode選択、`validate:product` P6動的checkを追加済み。

残差:
- Windows実機でのControl Center approval/emergency-stop手動証跡
- P8 live外部実行解放前に、P6 `validate:product` PASSを前提条件として再確認

完了条件: 許可・拒否・取消・履歴・緊急停止がGUIで完結。HDS-BRAIN以外がauthority sourceにならないことを動的実証。

確信度: 95%

---

### P7 Audit / Evidence 製品化

目的: 「安全です」ではなく「検証できます」。

現状（実測）: **実装done（Linux fixture / live route evidence）**。hash-chain audit＋verify、audit-dump CLI、runtime/invariant snapshot（payload_hashのみでcontent非露出）、CC内のAuthority Audit / Complete History / Replay panelに加えて、Control Center起点のsanitized evidence pack export、manifest sha256一覧、human-readable report、横断secret redaction、evidence retention policy、`validate:product` P7動的checkを追加済み。

残差:
- Windows実機でのControl Center evidence export手動証跡
- P13前に、owner資格情報を含む環境でsecret redaction scanを再確認

完了条件: export / verify / tamper検知 / redaction / evidence packがGUI起点で成立。製品主張と証跡が一致。

確信度: 94%

---

### P8 Composio / 外部API連携の安全閉包

目的: 便利API統合をHDS承認・監査の内側でlive化する。

現状（実測）: **実装done（Linux fixture / HDS route evidence）**。dry-run実装、approval request生成、toolkit/action discovery、metadata権限非昇格のauthorityテスト、github.write / google.write等のL3境界に加えて、Composio live execution adapter（公式v3.1 tool execution API）、`COMPOSIO_DRY_RUN=false` + `COMPOSIO_LIVE_EXECUTION=true` + `COMPOSIO_USER_ID` + toolkit/action allowlist必須化、action revoke、Control Center Connectors上のuser id / toolkit allowlist / action allowlist / revoked actions / API endpoint / live opt-in / disconnect表示と保存、disconnect時のAPI key clear + dry-run復帰、gatewayのComposio実行pre/post authority event、`validate:product` P8動的checkを追加済み。

残差:
- owner資格情報・実Composio接続アカウントでのlive smoke PASS証跡（Linux・Windows）
- Windows実機でのControl Center Connectors設定・disconnect手動証跡
- Composio側scope / connected-account運用手順の最終文書化（P12）

完了条件: live実行が必ずHDS承認を通る／allowlist外は実行不可／接続解除可／前後監査可／GUIから操作可。

確信度: 92%

---

### P9 Channel / Operator / 拡張面の整理

目的: 製品主張と実体を一致させる。

現状（実測）: **実装done（Linux CONFIG / INTERNAL_STATE / FIXTURE evidence）**。チャネル区分はCLAIM.md・compatibility matrix・`validate:channels`で一致済み——WebChat・Telegram正式／Slack・Discord・Teams・LINE preview（silent fallback付）／WhatsApp reserved-third-party-only。D7反映としてWriting / Daily / Developer Operatorはpackage metadata・manifest・CLAIM・repository inventory・source release bundle・Windows packageでfirst-party Layer A core release surfaceとして一致済み。operator三種はGateway hard dependencyではなく、bundled Plugin Review Gateとplugin-loader manifest permission checkを通って読み込まれる。D6反映としてPlugin Review Gate / Plugin HIG / Skill Loader Contractにv1.0 contract-stable Layer B境界を明記し、`validate:product` P9がchannel/operator/plugin-skill境界を検査する。

残差:
- owner-run credentialed live smoke evidenceがないSlack / Discord / Teams / LINEは引き続きfirst-party-preview
- future Layer B third-party submissionの実案件review evidence
- P12での最終support boundary / claims文言総点検

完了条件: CLAIM・package.json・実装の三点一致。channel/operatorごとに承認・監査・停止導線がある。

確信度: 93%

---

### P10 Recovery / Backup / Rollback

目的: 壊れても戻せる運用製品にする。

現状（実測）: **実装done（Linux WebChat control path / 実ファイルfixture evidence）**。Doctor（CLI＋CC panel＋「資格情報なしでfail-closed」のCI検証）、UPDATE_ROLLBACK_RUNBOOK（手順書）、env/settings atomic write + `.bak` 基盤、Control Center Backup / Restore panel、WebChat token-gated `/recovery/backup` / `/recovery/restore` / `/recovery/reset-provider` / `/recovery/reset-connector` / `/recovery/factory-reset` を実装済み。Recovery packはmanifest＋コピー済み設定/永続path＋digestを持ち、API responseはsecret値を返さない。restoreはpre-restore backupを作成してから復元し、provider resetは`LLM_BACKEND=stub`へ戻し、connector resetはComposio dry-run / live disabledへ戻す。factory resetはsession / memory / failure-memory / schedules / logsを消去し、audit rootとrecovery backup rootを保持する。`validate:product` P10はWebChat経由でbackup→破壊→restore、provider reset、connector reset、factory resetを検証する。

残差（実測で不在を確認）: Windows実機GUIでの「壊す→GUIから復旧」証跡、safe mode/repairとの統合UX強化（P3 launcherと連動）、update前backup自動化とupdate失敗rollback（P11）、audit破損時のguided repair UI。破壊的audit purgeは非目標のまま。

完了条件: 「壊す→GUIから復旧」をWindows実機で実証。設定を失わず修復でき、更新失敗時に戻せる。

確信度: 90%

---

### P11 Update / Release / Signing

目的: 配布・更新・検証可能な製品にする。

現状（実測）: **実装done（Linux WebChat control path / release sidecar fixture evidence）**。release:bundle / release:verify 既存、**.sha256＋.manifest.json生成済**、CI組込済。Control Center Update panel、WebChat token-gated `/update/snapshot` / `/update/verify` / `/update/prepare` を追加済み。P11 update surfaceは候補release bundleのsha256 sidecarとmanifestを検証し、manifest境界（unsigned source bundle / secrets excluded / external dynamic imports excluded）とcompatibility schemaを確認する。Prepare UpdateはP10 recovery backupをpre-update backupとして作成し、current version / git head / candidate digest / backup id / manual app restore requiredを含むrollback planを生成する。release notes `docs/release-notes/1.0.0-rc.1.md` を追加済み。署名・自動更新は「可能性」ではなく**CLAIM.mdに "not shipped" と明記済（確認済事実）**のまま。

残差:
- Windows実機GUIでのmanual update / rollback証跡
- actual manual replacement after prepared update（operator-run手順。runtime auto-applyは非目標）
- migrationが必要になる将来schemaでのmigration実装
- D3=署名する場合のみ: 署名パイプライン（owner調達タスクと分離）

完了条件: 配布物が検証可能／更新で既存設定が壊れない／失敗時に戻せる／release claimとartifactが一致。

確信度: 88%

---

### P12 Docs / Support Boundary / Claims

目的: 製品責任範囲を固定する。

現状（実測）: **実装done**。QUICKSTART / INSTALLER_GUIDE / WINDOWS_INSTALLER_GUIDE / WINDOWS_FIRST_RUN / WINDOWS_UNINSTALL / RESIDENT_APP_GUIDE / OPENROUTER_BACKEND / COMPOSIO_CONNECTOR / SECURITY / TROUBLESHOOTING / NON_GOALS / CLAIM / GA_BAR_DEFINITION / PLUGIN_HIG / SKILL_LOADER_CONTRACT / AGENTS.md 等に加え、P12で `docs/SUPPORT_BOUNDARY.md` と `docs/KNOWN_LIMITATIONS.md` を追加し、README / QUICKSTART / CLAIM / RC docs / release notes / docs indexから参照した。`validate:product` は `p12.docs_support_claims` でsupport boundary、known limitations、preview quarantine、public claim alignmentを検査する。

残差: P13 owner GO判定、Windows実機E2E evidence、owner credentialed live smoke、実機manual update/rollback rehearsal、D1〜D7の最終decision確認。

完了条件: 何ができるか・できないかが分かる。public claimと証跡が一致する。

確信度: 95%

---

### P13 Owner GO / Product Release

目的: 製品主張の解禁。

現状（実測）: **pre-GO boundary実装**。`docs/P13_OWNER_GO_READINESS.md` を追加し、`validate:product` に `p13.owner_go_release_boundary` を登録。現在は `validate:ga` が `pre_go_ready` / `owner_go=pending` / `public_claim_allowed=false` を返し、`validate:ga -- --require-owner-go` はowner decisionなしでfail-closedすることを検査する。実際のGA releaseは未実行。

判定基準（旧Bar Gを置換）:
1. Linux CI full green
2. validate:product full PASS（増分項目すべてrequired）
3. Windows実機E2E PASS＋evidence pack
4. D1〜D7の決定記録
5. preview除外・first-party範囲の最終確認
6. release bundle＋sha256＋manifest生成
7. owner decision記録 → public_claim_allowed=true
8. version確定（D2に従う）
9. release notes公開

残差: owner GO、Windows実機E2E evidence pack、owner credentialed live smoke / redaction evidence review、最終version promotion、public claim activation、final release bundle regeneration。

完了条件: owner GOなしに製品完成を名乗らない。public claimと実体が一致。導入・運用・復旧・削除までWindowsで閉じている。

確信度: 98%

---

## 6. 依存関係

```
P1(凍結宣言) → P2(ゲート骨格)
P2後、着手順自由: P3 / P4 / P5 / P7前半
P6(UI残差) は P4 と連動、P8 live解放の前提（Linux fixtureではP8で再確認済み）
P8 live は P6 完了後（コード解放済み。owner資格情報live smokeはP13前証跡）
P9 / P10 / P11 / P12 は実装済み。P13はowner GOと製品release判定を閉じる。
P12 → P13
```

注: 「着手順自由」は依存なしの意。Codexセッションはsingle-track原則どおり直列で回す。

## 7. 要約表

| P | 名称 | 現状 | 主な残差 |
|---|---|---|---|
| P1 | Linux基準面固定 | done（CI自動化済） | 凍結宣言のみ |
| P2 | validate:product新設 | done | P13までの増分登録継続 |
| P3 | Windows導入 | 実装大部分done | Windows CI evidence確認・GO前owner実機E2E |
| P4 | Control Center | partial高 | Update・実機品質 |
| P5 | LLM実運用 | partial高 | Windows実機DPAPI restart→会話成立証跡・Linux/macOS keychain・live証跡 |
| P6 | Authority閉包 | 実装done | Windows実機GUI証跡 |
| P7 | Audit製品化 | 実装done | Windows実機GUI証跡・owner資格情報環境でのredaction再確認 |
| P8 | Composio閉包 | 実装done | owner資格情報live smoke・Windows実機GUI証跡・scope運用文書 |
| P9 | Channel/Operator整理 | 実装done | owner-run channel promotion evidence・future Layer B submission evidence |
| P10 | Recovery/Backup | 実装done | Windows実機GUI証跡・safe mode/repair UX・P11 update rollback連動 |
| P11 | Update/Release | 実装done | Windows実機GUI証跡・将来migration・署名判断はowner task |
| P12 | Docs/Claims | 実装done | P13 owner GO前の最終decision/evidence確認 |
| P13 | Owner GO | pre-GO boundary実装 | owner GO / Windows実機E2E / final promotion |

## 8. 最終確定方針

Linuxで共通ロジックと安全中核を常時保証し、Windowsで製品体験を完全に閉じる。判定はvalidate:ga（台帳）ではなく、validate:product（実体・増分）＋Windows実機E2E証跡＋owner GOで行う。各Phaseは現状実測を起点とし、既存実装の再実装を禁止、残差のみを機能塊単位でCodexへ起票する。
