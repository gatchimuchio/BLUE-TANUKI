# QE 現行三点正本

BLUE-TANUKIの製品設計・全体工程・施工命令は、このページが指す三点一組のみを現行正本とする。AGENTS.mdは施工方法・安全・権限・Gitの共通規律であり、実装状態は最新GitHub mainと現物から再観測する。

## 現行セット｜rev6.0仕様書・工程表＋rev6.1指示書

- [仕様書：BLUE-TANUKI統合仕様書](qe/現行/01_BLUE-TANUKI_統合仕様書_rev6_0_確定.json) — SHA-256 `956373347dd68d460f08e1f8737a118f2dd48a9b56f8b54712f6d92f7094e47e`
- [工程表：BLUE-TANUKI全体施工工程表](qe/現行/02_BLUE-TANUKI_全体施工工程表_rev6_0_確定.json) — SHA-256 `88a86ab48cd22d7d49f9a3f4d8d41a89d0473a05dfdb68d84a08639298edee85`
- [指示書：BLUE-TANUKI Codex全域施工指示書 rev6.1](qe/現行/03_BLUE-TANUKI_指示書_rev6_1_LLM日本語意味圧縮.json) — 添付原本SHA-256 `dd912e82f856895978ea1132c932ad313d064ac9f2dd31eb25e56932cd001c6d`、復号SHA-256 `131161ad5bf7264686bfd7c5b8f7fc64a2a4a646c848a8b0938ac366d82a0795`
- [現行MANIFEST・前版のSHA・要求母集団](qe/現行/MANIFEST.json)

指示書は添付の圧縮原本を保管する。`node scripts/check_docs.mjs` が上位二文書への参照を復号し、原本・復号結果のSHA-256、文書版、工程・要求IDを照合する。復号処理は [decodeQeInstruction](../scripts/decode_qe_instruction.mjs) を参照する。

## 対象・権限

1. 主語はBLUE-TANUKI製品全体。目的は使用者から委任された仕事を目的保持・計算・HDS判断・現在権限・作用・実結果・M記憶・再評価・復旧・停止まで同一仕事として成立させること。
2. 母集団は431要求、65親成果、198施工索引、63詳細条項、34不変契約、61競合基準、396局所QC、260親QC、最終5OS。開発中は全域P2一括施工を進め、198索引を個別完了・品質ゲートへ変換しない。
3. 順序はP0現物測量→P1全体設計→P2全域接続施工→P3実システム通水→P4欠損0照合→P5/P6 QC→P7根因是正・再検査→P8対象別QA→P9 owner独立GO。現行段階はQE_BUILD。SYSTEM_SHAPED、BUILD_COVERED、QC/QAは独立証拠が成立するまで未完。
4. rev6.1指示書の採用と開発継続はownerの2026-11-19明示指示に基づく。実provider接続、実資格・実データ、本番外部作用、別repo編集、OS署名・Store、製品の一般公開・出荷GOはそれぞれの独立した権限・証拠を要する。C08.03のlive provider検証はHOLDのまま、隔離fixture実装と他系統の施工は継続する。
5. rev6.1では各差分の派生出力と実consumerをたどり、影響に応じて生成物の構文・読込、保護ゲート、必要な拒否例をP2で確認する。正式な全数QCとOS別QAは工程表の所定段階で行う。

## 履歴・適用

2026-11-16に採用されたrev6.0の仕様書・工程表を上位原典として引き続き適用する。旧rev6.0指示書は[履歴](qe/履歴/rev6.0/03_BLUE-TANUKI_Codex全域施工指示書_rev6_0_確定.json)に保管した。rev6.1原本中の「未採用」「未反映」は作成時点の記録であり、2026-11-19のowner採用をここに記録する。

独立作業の開始・切替・再開では、AGENTS.md、ownerの最新指示、ここにpinされた三文書、main/作業差分、現行consumerを確認する。旧版・完了作業は履歴として保持し、変更系譜や矛盾解消に必要な場合だけ該当箇所を参照する。
