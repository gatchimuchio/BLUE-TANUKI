# BLUE-TANUKI 文書索引

日本語正本、現行運用文書、履歴証拠を区別して読む。英語の現行文書は `規定/移行台帳.json` に残る移行負債であり、不可避な局所例外または日本語正本へ自動昇格しない。

## 索引の規範的な読み方

この索引は文書の存在場所を示す案内であり、それ自体が各文書の主張を採用する権限ではない。最初に日本語基底正本で対象、意味、責任境界、例外条件を確認し、その後に実装契約、運用手順、監査証拠を読む。英語名のリンクや固定ファイル名は既存資産へ到達するための参照ラベルであり、日本語で成立した意味を変更しない。

現行運用文書に日本語正本との矛盾、意味欠落、古い状態、未検証の完成主張がある場合は、日本語正本を無言で弱めず、安全側へ停止して移行負債または文書不整合として扱う。履歴証拠は当時の観測を保持するため原文のまま残せるが、現在の仕様、承認、公開判断へ昇格できない。コードや検証結果も観測した範囲しか証明せず、HDS-BRAIN や owner の判断を代替しない。

文書を追加・変更するときは、どの分類に属するか、どの日本語正本へ接続するか、外部語が本当に不可避か、検証経路があるかを先に確定する。新しい非日本語文書を便宜的に追加したり、既存の移行負債へ意味を追記したりして通常 gate を迂回してはならない。

## 日本語基底正本

- [日本語基底規定](../規定/00_日本語基底規定.md) — 唯一の基底規定言語、成立順序、例外、監査
- [基底語彙](../規定/01_基底語彙.md) — 日本語概念と既存識別子
- [資産分類と局所例外](../規定/02_資産分類と局所例外.md) — 全資産分類、局所例外、移行状態
- [正本索引](../規定/正本索引.json) — 系列 commit と正本状態
- [局所例外台帳](../規定/局所例外台帳.json) — 不可避な多言語範囲
- [移行台帳](../規定/移行台帳.json) — 未解消の非日本語資産
- [Agent 規定](../AGENTS.md) — 実装・監査・Git・validation 規律
- [作業標準要領](作業標準要領.md) — 有限受入条件、編集前バックアップ、実装・検証・報告、D4-POCKET からの採否
- [Active Implementation Instructions](IMPLEMENTATION_INSTRUCTIONS.md) — 現在の bounded phase
- [Roadmap](ROADMAP.md) — J 系列と P13 の圧縮順序

## 現行の開発記録

- [共通record境界](../packages/protocol/src/common_record.ts) — JSON境界parser、独立状態schema、fail-closed理由
- [境界交換契約](../packages/protocol/src/境界交換契約.ts) — 制限JSONの版付き境界とcanonical bytes。実行権限は持たない
- [開発進捗](開発進捗.md) — 施工単位の有限成果、未達、検証・Git統合
- [要求ID付き局所試験の実行](VALIDATE_AGI.md) — `validate:agi` の登録ID選択、実試験実行、失敗分類と証明範囲
- [旧新切替と復元の判断記録](旧新切替と復元の判断記録.md) — B03.03の停止・切替・照合・戻し、非作用shadow、非公開差分、現物不足と後継
- [実行分離と接続認証](実行分離と接続認証.md) — 実行分離、C01.02の局所境界契約、外殻接続の未実証と後継
- [B02.03 外殻接続変更案](外殻接続変更案.md) — 公開ソースに基づく限定提案。実装・別 repo 書込みの許可ではない
- [B02.04 ミニドラ接続変更案](ミニドラ接続変更案.md) — 実入口、変更不要条件、最小差分候補、後続の受入・復元。実接続・全面改修の承認ではない
- [B03.01 状態所有と保存取引](状態所有と保存取引.md) — 既存資産の採否、J/Mの所有・更新API・別取引、保存選定と未実証、後続の故障・復元受入

## はじめに読む

- [Windows の開発環境と WSL の配布検証](開発環境.md) — Windows を標準とする開発、固定版の準備、補助環境での配布検証、局所起動
- [README](../README.md) — product surface、境界、local start
- [Quickstart](../QUICKSTART.md) — 最短起動経路
- [Strategy Frame](STRATEGY_FRAME.md) — Layer A/B と対照戦略
- [Product Roadmap](PRODUCT_ROADMAP.md) — P1-P13 product roadmap
- [Product Owner Decisions](product-owner-decisions.md) — D1-D8 と P13 判断台帳
- [Responsibility Substrate Mapping](RESPONSIBILITY_SUBSTRATE_MAPPING.md) — GUI responsibility mapping
- [Authority Model](BLUE_TANUKI_AUTHORITY_MODEL.md) — HDS-BRAIN と owner 境界
- [GA Bar Definition](GA_BAR_DEFINITION.md) — RC から GA への gate
- [First-Run Checklist](FIRST_RUN_CHECKLIST.md) — 最初の局所操作
- [Permanent-Use Checklist](PERMANENT_USE_CHECKLIST.md) — 恒久運用
- [Support Boundary](SUPPORT_BOUNDARY.md) — first-party / preview / reserved / not-shipped
- [Known Limitations](KNOWN_LIMITATIONS.md) — RC evidence gap と延期面
- [v1.0 Release Candidate](v1.0-release-candidate.md) — RC claim と upgrade 境界
- [1.0.0-rc.1 Release Notes](release-notes/1.0.0-rc.1.md) — 発行時原文証拠
- [v1.0 Post-RC Closure Review](v1.0-post-rc-closure-review.md) — post-RC 状態
- [v1.0 GA Promotion Review](v1.0-ga-promotion-review.md) — pre-GO evidence
- [P13 Owner GO Readiness](P13_OWNER_GO_READINESS.md) — actual release blocker
- [Release Hardening Gate](RELEASE_HARDENING.md) — signing と manual-update 境界

## 第一者 surface

- [Operator Surfaces Index](operator-surfaces/INDEX.md) — Writing / Daily / Developer
- [Operation Core Architecture](OPERATION_CORE_ARCHITECTURE.md) — request / plan / adapter
- [Shared Operator Substrate](operator-surfaces/SHARED_SUBSTRATE.md) — 共通下流基盤
- [Writing Operator](operator-surfaces/WRITING_OPERATOR.md)
- [Daily Operator](operator-surfaces/DAILY_OPERATOR.md)
- [Developer Operator](operator-surfaces/DEVELOPER_OPERATOR.md)

## Security、authority、audit

- [Security](../SECURITY.md) — authority と final-review
- [Audit](../AUDIT.md) — hash-chain dump / verify
- [HDS-BRAIN Standalone Boundary](hds-brain-standalone-boundary.md)
- [Risk / Approval Boundary](hds-brain-risk-approval-boundary.md)
- [Reference Boundary](hds-brain-reference-boundary.md)
- [Fail-safe Policy](hds-brain-fail-safe-policy.md)
- [Unknown Escalation Policy](hds-brain-unknown-escalation-policy.md)
- [Detector Lifecycle](hds-brain-detector-lifecycle.md)
- [Trinity M Policy Model](hds-brain-trinity-m-policy-model.md)
- [Output / Result Audit Plane](hds-brain-output-audit-plane.md)
- [Complete History Substrate](hds-brain-complete-history-substrate.md)
- [Failure Memory Control](hds-brain-failure-memory-control.md)
- [Runtime Invariants Evidence](hds-brain-runtime-invariants-evidence.md)
- [v1.0 Security and Permanent-Use Review](v1.0-security-and-permanent-use-review.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [Security Review Checklist](SECURITY_REVIEW_CHECKLIST.md)

## Platform extension

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Plugin HIG](PLUGIN_HIG.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)
- [Adapter Contract](ADAPTER_CONTRACT.md)
- [LLM Development Guide](LLM_DEVELOPMENT_GUIDE.md)
- [旧開発作法からの案内](DEVELOPMENT_PRACTICE.md) — 作業標準要領へ統合済み
- [LLM Extension Surface](LLM_EXTENSION_SURFACE.md)
- [Conformance Targets](CONFORMANCE_TARGETS.md)
- [OpenRouter Backend](OPENROUTER_BACKEND.md)
- [Composio Connector](COMPOSIO_CONNECTOR.md)
- [External Tool Authority Boundary](EXTERNAL_TOOL_AUTHORITY_BOUNDARY.md)

## GUI / Control Center

- [GUI Product Spec](GUI_PRODUCT_SPEC.md)
- [GUI Screen Map](GUI_SCREEN_MAP.md)
- [GUI State Model](GUI_STATE_MODEL.md)
- [GUI Approval UX](GUI_APPROVAL_UX.md)
- [GUI Audit UX](GUI_AUDIT_UX.md)

## Operation

- [Configuration](../CONFIG.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Installer Guide](INSTALLER_GUIDE.md)
- [Resident App Guide](RESIDENT_APP_GUIDE.md)
- [Windows Installer Guide](WINDOWS_INSTALLER_GUIDE.md)
- [Windows First Run](WINDOWS_FIRST_RUN.md)
- [Windows Evidence Pack](WINDOWS_EVIDENCE_PACK.md)
- [Windows Packaging Audit](WINDOWS_PACKAGING_AUDIT.md)
- [Windows Uninstall](WINDOWS_UNINSTALL.md)
- [Credential Readiness Matrix](CREDENTIAL_READINESS_MATRIX.md)
- [Channel Readiness Matrix](CHANNEL_READINESS_MATRIX.md)
- [Channel Promotion Gate](CHANNEL_PROMOTION_GATE.md)
- [Update / Rollback / Recovery Runbook](UPDATE_ROLLBACK_RUNBOOK.md)
- [Known Environment Failures](known-environment-failures.md)
- [Doctor Output](doctor-output.md)
- [Validate Product](VALIDATE_PRODUCT.md)
- [Repository Health Inventory](repository-health-inventory.md)
- [Production Import Graph](production-import-graph.md)
- [Preview Scope](preview-scope.md)

## Distribution

- [Portable Installer Guide](../install/README.md)
- [Resident Helper](../install/resident/README.md)
- [Compatibility Matrix](compatibility-matrix.json)
- [Phase 11-S9 Installer and Setup UX](phase11-s9-installer-setup-ux.md)
- [Phase 11-S10 Resident Application Integration](phase11-s10-resident-application-integration.md)
- [Phase 11-S11 Channel First-Party Promotion](phase11-s11-channel-first-party-promotion.md)
- [Phase 11-S12 Plugin Review Gate](phase11-s12-plugin-review-gate-implementation.md)
- [Phase 11-S13 v1.0 GA Promotion](phase11-s13-v1-ga-promotion-execution.md)

## Design と履歴

- [OpenClaw Rejection Audit](OPENCLAW_REJECTION_AUDIT.md)
- [Non-Goals](NON_GOALS.md)
- [Architecture](architecture.md)
- `docs/history/` — 過去時点の原文証拠。現行 authority ではない
- `docs/phase*.md` — 完了済み phase の原文報告。現行実装権限ではない
