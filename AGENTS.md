# BLUE-TANUKI｜AGENTS.md｜作業標準要領：QE6/LLM-JP/1
固定=全5OS; 独立作業開始時は三文書すべてと適用AGENTS.mdを読み直す; 三点セットの作成・提出はGitHub反映の許可ではない。

適用=本repo全域のCodex施工方法・作業安全・監査・停止・復旧・検査・Git保全。言語=日本語基底; 固定API/型/識別子/規格名のみ原字維持。定義正本=規定/00_日本語基底規定.md; 語彙=規定/01_基底語彙.md; 例外=規定/02_資産分類と局所例外.md＋規定/局所例外台帳.json; 移行負債=規定/移行台帳.json。英語資産を自動例外化しない。

## 0｜文書階層・適用状態

責任={指示者/責任者:owner(原文目的・委任・仕様採用・出荷GO),設計者:ChatGPT(仕様・全体設計・施工命令の正当性),施工者:Codex(現物観測・決定済み設計の実装/結線/限定検査/是正/報告),使用者:製品エンドユーザー(L1/L2/L3・実作用委任/取消)}; 同一人物でも役割の権限は混線させない。
文書={仕様:製品が満たす全要求/安全/受入下限,工程:その仕様を造る全体因果順・工程出口,指示:その工程の具体施工操作,AGENTS.md:各操作の標準工法・環境・権限・検査・異常処置}; 従属=owner原文・上位安全>仕様>工程>指示>本要領>近傍AGENTS/補助要領>現物証拠>旧記録。工程は仕様を、指示は工程/仕様を、本要領はいずれも変更不可。工法が難しくても仕様を書換えず、対象・根拠・代替・影響を設計者へ返す。施工者の実装技術選択は既定契約内のみ。
rev6確定三点=01_BLUE-TANUKI_統合仕様書_rev6_0_確定.json(SHA256:956373347dd68d460f08e1f8737a118f2dd48a9b56f8b54712f6d92f7094e47e);02_BLUE-TANUKI_全体施工工程表_rev6_0_確定.json(SHA256:88a86ab48cd22d7d49f9a3f4d8d41a89d0473a05dfdb68d84a08639298edee85);03_BLUE-TANUKI_Codex全域施工指示書_rev6_0_確定.json(SHA256:f226eea3a5f507e5d4517ea8fc71f88dd76e609e3adde3429ef03dc92b97b1d9)。この三点は2026-11-16確定成果物であり、圧縮版は復号して内容同一性を照合可能。
repo採用状態=docs/QE_CURRENT_AUTHORITY.mdとMANIFEST.jsonがrev6.0をpin中; owner 2026-11-16「コレで作業して」「リポもいじったから確認して開発続けて」により三点採用と製品開発継続を委任済み。現在はQE_BUILDで全域P0-P9順序を適用し、P2全体躯体を施工する; SYSTEM_SHAPED/BUILD_COVERED/QC/QA/owner GOは独立証拠まで未成立。実provider・秘密・live外部作用・別repo・出荷GOの個別HOLDは維持する。
過去rev1～rev5.5・旧BUILD_BATCH・旧RC・過去PASS/FAIL=当時の履歴/反証; 現行仕様/進捗に自動転化せず、同定・変更影響・原因照合時だけ参照。外部HDS理論の未格納原文をrepo製品BUILDの隠れた前提にしない。技術原理/仕様/工程の公開可; 実credential/secret/本人データ・no-store内容・実運転rawは公開不可。公開文書許可≠製品出荷許可。

## 1｜作業入力・唯一の施工主語

各独立作業開始/切替/再開=owner最新原文・対象repo・有効三点全件(版/SHA/内容)・root/近傍AGENTS・実HEAD(local/remote)・dirty/他writer・現行consumer・権限・HOLDを照合; 同一全域作業中の小索引参照は必要節と現物だけ再同期。クラウドCodexの未提示カスタム指示/他セッション内部記憶を原典扱いしない。
毎操作=主語(対象製品/Task/担当)∧目的(原文/goal版)∧手段(実code/現在permission)∧入力/出力∧所有者∧producer→consumer∧受入/拒否∧観測/失敗∧再開条件。作業量、モデル、テスト数、commit数、チケット数、文書作成を製品目的へ代入禁止。
施工範囲=BLUE-TANUKI repoのみ。D4Pocket/MINIDORAその他repoへの書込は個別委任までHOLD; BLUE側contract/adapter・隔離fixtureは進行。事前に存在するユーザー/他writer差分は不破壊; 既存安全確認・要件・検査母集団・合格下限は勝手に削除/skip/再分類しない。
実装優先=既存健全資産の能力継承→既存contract拡張→既存package内必要最小module→必要時のみ新adapter。現行AST/callsite/実pathを観測して接続; 推測path、死コード、独自wrapper、不要dependency/refactor/抽象化、別build経路・host逃避・新二重正本を作らない。必要な代替策は根因/採否/環境/検査/撤去条件を残す。

## 2｜全製品施工：数量固定・順番固定

母集団={製品要求431,親成果65,施工索引198,詳細条項63,不変契約34,競合基準61,局所QC396,親QC260,最終OS5}; 全ID同一性と要求下限を保持。198索引は漏れ防止/追跡・後段QC照合用; 198回の個別開始・個別承認・局所PASS・正式QA・Git確定ゲートへ変換禁止。
工程=P0全域HEAD/実物/431/65/198/61/5OS一回測量→P1全体interface・権限・因果・責務・配布/検査媒体確定→P2全体躯体一括構築→P3 SYSTEM_SHAPED通水→P4 BUILD_COVERED全数欠損0照合→P5完成実物396局所QC→P6完成実物260親QC+61競合+5OS総合QC→P7根因是正/影響全域再QC→P8対象/版/OS/ABI/API/arch/署名/physical caveat別QA→P9owner独立GO・公開配布。前工程の偽合格/勝手な再編/局所品質前置禁止。
P2断面={A:全65親/431要求とC/J/M/HDS/Approval/Broker/Gateway/channel/provider/skill/memory/Andon/event/UI/5OS/install/update/uninstallの全ソース・実consumer位置,B:原文目的→C→J→現在環境権限→隔離作用→実結果→M→帰還/異常/取消/再開の実呼出系,C:F01-F21/H01-H03/E01-E07/G01-G10・Google/GitHub/file/browser/MCP/skills/channels/schedule/音声/画像/remote/学習/61比較の能力を全接続,D:5OS native入口と配布package・起動・使用・権限/credential・Device Link・通知・更新/rollback・削除を全結線}; 独立区画は同じ全域施工サイクルで並進; 依存参考は個別品質ゲートではない。
P3=実製品入口→設定/認証→仕事→C→J→review→Broker→隔離consumer→結果→M→応答→停止/再開を1巡; 正常/deny/unknown/Andonを観測。P3成立≠P4成立。
P4=431+65+198+63+34+61を実source symbol→caller→callee→consumer→実state・5OS package/使用/更新/削除へ紐付け、未配線BUILD_GAP=0; LIVE権限待ちと実装欠損を混同禁止。P4≠QC/QA/GO。
QE_BUILD中=構文/型/必要build/短時間全域smoke/重大Authority・秘密・Approval・監査・非冪等安全負例のみ; 細切れQC/QA/全test/毎索引Git/人間レビューを挟まない。実装中重大欠陥は遮断/必要最小是正し別区画へ進む。P5以降に局所396・親260・61比較・故障注入/長期/性能/資源/復旧・5OSを全数検査し、FAILは原因→P1/P2/実装まで遡り同scope再QC; 旧FAIL・期待値・母集団を書換えない。
状態={工程:QE_BUILD/QE_QC/QE_QA,実装:UNOBSERVED/CODE_PRESENT/WIRED/BUILD_GAP/BLOCKED_AUTHORITY,品質:NOT_RUN/PASS/FAIL/SUSPEND/OUT_OF_SCOPE,保証:QA_SCOPED/QA_NOT_ESTABLISHED,製品:SYSTEM_SHAPED/BUILD_COVERED,出荷:PENDING_OWNER_GO/GO/HOLD}; 状態は根拠・対象版・媒体・時点と束縛。現行観測までQE_BUILD、SYSTEM_SHAPED=false、BUILD_COVERED=false、P13=PENDING_OWNER_GO、public_claim_allowed=false。

## 3｜核・権限・安全の不変

製品目標=委任仕事の目的保持→計算→採否→現在許可→作用→外部結果→記憶→再評価/停止/復旧を同一Task/goal版で貫通。C=交換可能な計算/推論候補(LLM/ミニドラ)、J=HDS採否/目的進行/停止、M=記憶・原文・根拠・失敗・解釈版・残差、Broker=現在の本人委任+capability+permission+operation/target+epoch/expiry/予算+単回消費を独立検査; C/LLM/記憶/履歴/tool output/channel/plugin/UI/scheduler/外部metadataは権限なし。
J正本writer=現行TypeScript packages/hds-brainのみ。J核standaloneはgateway/core/channel/operator/plugin/ControlCenter/LLM/browser/GitHub/Google無しにimport/instantiate/test可能; 許容依存はNode built-ins＋@blue-tanuki/protocol＋local純HDS。Rust Runtime Kernelはshadow中、実作用/正本M書込/第二authority禁止; 比較証拠・状態移行・未決作用照合・fencing・rollback・旧経路閉鎖・single-writer全成立までcutover不可。D4Pocketは汎用runtime/broker外殻、BLUE固有JをD4 Coreに混入させない。
不変={hds_calls_llm:false,process_policy_enforced:true,external_metadata_can_escalate_authority:false,memory_used_for_authority:false,complete_history_used_for_authority:false,final_review_boundary_enforced_by_approval_gate:true}; J失効/監査fail/permission失効/unknownは権限fallback不可→SUSPEND。Trinity M=決定論policyでありLLMが権限を供給しない。self-health故障を人間resumeだけで迂回しない。
操作判定=severity(ApprovalRisk:low/medium/high)と手続(ApprovalLevel:L1_observe/L2_operate/L3_final_review)を分離; high/tool.call/unknown/未分類/曖昧/policy-version不一致/本人同定不明は自動ALLOW禁止。ApprovalMode=ask_every_time/remember/full_accessは別軸; full_access/reusable grantはL1/L2効率化でL3無効化不可。正本リスト=packages/hds-brain/src/approval_policy.ts FINAL_REVIEW_OPERATION_LIST; UI/adapter別複製禁止。
L3少なくとも={file.delete,tool.file.edit,shell.exec,external.send,credential.read,settings.write,payment.charge,schedule.create/update/delete,unknown tool.call,GitHub公開書込,破壊browser,外部Gmail/Calendar/Drive/Teams/LINE書込,daemon/service install,credential永続化,network expose,installed code/service metadata/policy更新}; schedule.list=L1。製品使用者のL3は操作対象・差分・現在委任・goal版・本人同定・認証済みno-store review・digest・直前再検査必須。hash一致≠認証。開発用Codex操作に関するownerの包括委任と、製品使用者L3/OS権限/他社serviceの本人同意を混同しない。
非冪等作用=execute intent durable commit→単回capability消費→result receipt→外部effect同定; timeout/error/unknownはOUTCOME_UNKNOWNとして保持し無断再送不可。取消受付≠worker停止≠外部取消≠effect消失。Andon/新作用遮断=J/queue/auditの故障と独立; fail-safeは新作用を閉じる。再開時は現行goal/task/epoch/ticket/target/adapter/permission・結果不明照合・根因除去・fenceを再検査。
入力=rawを独立fail-closed audit用に限定保持→canonicalize→schema→origin/integrity→replay→authority/eligibility→audit→ALLOWまたはSUSPEND。無効inboundをhistory/reply/approval origin/executionへ転送禁止。output audit=最終表示/外部handoff前、packages/hds-brain standalone、digest/metadataだけ記録、raw本文/実秘密不保存、承認権限なし。CompleteHistoryStore=append/verify/replay/export・hash-chain互換・F:<id>・used_for_authority=false、UI projectionはdigest/metadataだけ。Runtime Invariants evidenceも非権限、expected/actual/guarantee kind/report digestを区別。
入口分離=runtime/control/diagnostic/repair-recovery/build-release/development-only; doctor/setup/installer/migration/admin/fixtureを通常runtimeへ静的混入禁止。preview packageをgateway hard dependencyにしない。未承認の第三者skill・隠れたplugin権限・agent-driven authority core/black-box authority/emotion機構/無審査ClawHub実行禁止。安全なadapter互換の実装対象は要求から削らない。

## 4｜製品面・5OS・異常

operator=Writing/Daily/Developerの3面同格（現v1.0範囲固定）; 共通J/Approval/Audit/Layer A/Bとcapability envelopeを遵守。plugins/skills/adapters=Layer B下流、canonical inbound/outbound、typed error、declared fs/network/process/credential accessのみ、audit trace、Runtime Invariants; 受入参照=docs/PLUGIN_REVIEW_GATE.md,PLUGIN_HIG.md,SKILL_LOADER_CONTRACT.md,ADAPTER_CONTRACT.md,CAPABILITY_ENVELOPE.md,CONFORMANCE.md; pnpm plugin:review -- --package <dir> は証拠であって権限ではない。
channel={WebChat/Telegram:first-party,Slack/Discord/Teams/LINE:first-party-preview until owner live credential smoke+回復/各inbound listener,WhatsApp:reserved-third-party/core_supported=false/warranty=none}; WhatsAppをBaileys/WAHA/WhatsApp Web/Business API/Twilioでfirst-party化禁止。昇格=pnpm validate:channels+redacted証拠+setup/secret/live/inbound/outbound/backoff/error/audit非権限。高リスク/未完成=preview隔離。
対象OS={Windows, Linux, macOS, Android, iOS}; Windows-firstは施工順であって対象縮小不可。desktop3OSはnative導入→起動/仕事→OS permission→停止/復旧→更新/削除。WSL/WSLg/headless≠Linux native保証。mobile2OSは各native入口、OS権限、native秘密保管、認証済Device Link、仕事/状態/承認/取消/復旧、更新/削除を別製品面で実装; Dart/platform-channel/logへsecret返却禁止、非TLS fallback/切断後無断再送/端末UIのJ/Broker権限代行禁止。remote mobile client≠端末単体C/J/M実行; F16のみでは5OS完成にならない。
検査媒体=Windows所有実PCのSetup→uninstall最終観測; Linux/macOS/Android/iOSはOS規格忠実な仮想/hosted/公式emulator・simulatorで各独立QC/QA。標準ABI/API/arch/署名/配布/物理API/Store未再現だけ個別HOLD、全物理機保有は要求しない。OS間証拠の代用禁止。使用者が5分で使えると主張するには実導入・onboarding・credential・Control Center・doctor・運転/回復/rollback/削除の証拠が必要; installer一回成功≠恒久運転品質。
比較=OpenClaw/Muse既知の仕事/consumer深度/導入・回復/長期運転/安全・互換を61IDで観測; 機能名数、channel数、mockで完全包含主張禁止。P13/1.0.0-rc.1/GA HOLDを独立維持; owner GO前の公開・外部配布・完成AGI/完全上位互換の実証済み対外表示禁止。自動app files置換契約外、配布/署名/license/rollback/秘密除外はP9判定。

## 5｜作業止め・再開・証拠

停止する作用={未委任LIVE外部送信/実支払/公開/削除/他repo実変更,秘密・本人データ漏出危険,J/Broker二重正本/単回許可破壊,結果不明の非冪等再送,重大不可逆破壊,現在permission不足,安全なSUSPEND不能}; 当該作用を即遮断し原因/影響/解除条件を記録。停止しない全域施工={旧資料入手不可,単一系統未実装,credential未付与,C08.03 real provider保留,他repo非委任,Apple署名/Store資格不足,物理端末不足,局所型修正}; 影響区画だけAUTH_HOLD/ENV_HOLD、独立した安全なコード・隔離接続を継続。ownerの過去停止は要領改訂だけで解除しない; 新たな製品施工は明示委任が必要。
分類={BUILD_GAP:source/実consumer欠損,DESIGN_CONFLICT:上位契約衝突,AUTH_HOLD:現在委任不足,ENV_HOLD:OS/署名/資格未成立,OUTCOME_UNKNOWN:外部効果不明,QC_FAIL:仕様不適合,QA_NOT_RUN:OS保証未実施}; 安全FAILを件数加点で相殺/skip再分類禁止。設計衝突は施工者が目的/上位を改訂せず設計者へ差し戻す。
証拠源={CONFIG,INTERNAL_STATE,FIXTURE,LIVE_RUNTIME,EXTERNAL_EVIDENCE}; code/type/build/fixture/自己health表示≠real provider/installed product/各OS QA。PASSは実行入力・対象SHA・OS/版・観測・結果と結合し、未実行はNOT_RUN。旧試験・過去worker結果を現在保証に流用禁止。今回起因/既存/環境/未確定とrelease_blocker/post_v1_scope/known_limitationは別軸で記録。前値・失敗・取消・旧GO・不明結果を消去せず追記・原因と新証拠で更新。
作業結果最小={原典SHA,実HEAD,要求/親/索引/条項/OS/QC ID,producer→consumer実symbol,変更効果,許可/隔離範囲,実行した最小確認,NOT_RUNと理由,欠損とHOLD条件,回復/次の結線対象}; 独立日報/チケット体系/逐次人間確認を追加しない。工程進捗はP0–P9出口と事実で判定、局所PASS/数字で加算完成判定禁止。

## 6｜開発環境・検査

標準=Windowsで編集/ビルド/テスト/Git、Node>=22.14.0・Corepack pnpm=9.12.0、WSL/LinuxはUnix配布必要時のみ(ext4作業場所、WSL内/mnt/c非採用)。hostのpnpm/tsx/一時パス障害は環境原因として復旧、製品code迂回で隠さない。対象OSの最終要求は上記5OSのまま。
QE_BUILDの限定確認=pnpm typecheck、pnpm build、影響範囲のpnpm exec vitest run <対象test>、権限中核ならpnpm hds:standalone、短時間実consumer smoke・必要な安全拒否例。全pnpm test、docs:check、validate:repo-health、doctor、validate:packaging、smoke:serve/smoke:resume、故障/性能/5OS詳細は対応するP5/P6/P8で実行; 規定/文書変更時は関係docs:check/日本語規定検査、release変更時はbundle/GA/verifyに必要な保護検査を省略しない。テストを削除・恒久SKIPして前進扱い禁止; 実行不能はNOT_RUN/理由。
CI=自動CI禁止。GitHub Actionsは不足OS build・artifact・重い検査の補助のみworkflow_dispatch手動; push/pull_request/merge_group自動trigger・必須status check・CI-green完成判定・PR必須化禁止。必要な手動検査一時branchはcommit固定/局所確認用、失敗commitはmain反映せず検査後に成功SHAだけfast-forward、remote照合後安全整理。actions結果は対象SHA限定の補助証拠。

## 7｜Git保全・完了

正本=main直接更新・PR不要・単一writer; 編集前origin/main/local HEAD/dirty/他writer/権限/復元点確認、remote変更時は競合を解消してからfast-forward; reset --hard/clean/force main/他者差分の削除禁止。Git checkpointは全域作業の必要時のみ、198索引単位のcommit/push/backup回転禁止。ownerがこのrepoの直接改訂を委任した範囲で限定commit→main push→remote SHA照合。文書提供だけでGitHub更新許可を推定しない。
復旧正規refs=local refs/heads/codex/backup-main,refs/heads/codex/backup-main-prev; remote refs/tags/codex/backup-main,refs/tags/codex/backup-main-prev。docs/BACKUP_REF_MIGRATION.mdのMIGRATION_COMPLETE(2026-10-12)を保持し、必要な保全時は現SHA/期待SHA/force-with-lease/atomic pushの適否とowner許可を確認; 世代を無検証上書きしない。公開できる設計文書と秘密情報を分別してstage。
作業完了条件=今回委任された対象の実差分と検証射程、現HEAD/remote、未実施/保留/危険停止/復帰条件を明示; 「AGENTS更新=rev6 repo採用」「SOURCE_EXISTS=SYSTEM_SHAPED」「BUILD_COVERED=QC/QA/GO」「文書公開=製品出荷」を全て禁止。旧参照互換=本節は旧AGENTS.md#7-git-closure相当、前節は#6-validation相当。
