# BLUE-TANUKI Product Owner Decisions

本記録は製品ロードマップP系列のowner決定台帳であり、`docs/ga-owner-decision.json`（Bar G機構）とは独立。Bar Gは旧基準のGOを発行せずP13判定に吸収する（D2）。

| ID | 決定内容 | 決定日 | 決定者 |
|---|---|---|---|
| D1 | 本書採用をもって2026-05-23凍結を解除（2026-06-11発効済） | 2026-06-11 | owner |
| D2 | 1.0.0を「Windows製品完成」に再定義。現1.0.0-rc.1は新基準下でrc継続（rc.2…）、旧Bar GのGOは発行せずP13基準に吸収。代替案（Linux core GAを1.0で先行）はclaim二重管理コストのため非推奨 | 2026-06-11 | owner |
| D3 | v1は非署名維持（CLAIM.md「Signed native installer and automatic updater: not shipped」と一致）。代わりにP3でSmartScreen通過手順とsha256検証手順を製品文書化。署名はpost-v1の調達課題（証明書取得・身元検証は外部依存、Codexスコープ外） | 2026-06-11 | owner |
| D4 | 公開repoのGitHub Actionsに windows-latest job を追加し `package:windows`→`smoke:windows-installed` を自動化（公開repoは無料枠）。加えてGO前にowner実機E2Eを最低1回 | 2026-06-11 | owner |
| D5 | アーキテクチャ既定（full_access）は維持し、first-runセットアップでownerにmode（ask_every_time / remember_this_decision / full_access）を明示選択させる。authority_model="owner_operated_full_access" 系のclaim・テストへの波及を避けつつ「ユーザーが何を許可したか理解できる」を満たす | 2026-06-11 | owner |
| D6 | 含める。ただし範囲は「既存資産（SKILL_LOADER_CONTRACT / PLUGIN_HIG / plugin:review gate）の整合確認とAPI安定度宣言」まで。エコシステム拡張はpost-v1。2026-05-13戦略フレーム「最初から公開品質」と両立 | 2026-06-11 | owner |
| D7 | first-party確定（package.jsonは既に "First-party … Operator" を自称しており、killer-app戦略フレームとも整合）。条件: validate:productに3 operator smokeを含めPASSすること。preview降格を選ぶ場合はpackage.json記述修正が必須 | 2026-06-11 | owner |
