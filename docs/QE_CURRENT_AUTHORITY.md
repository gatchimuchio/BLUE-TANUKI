# QE 現行正本ポインタ

このページがBLUE-TANUKIの現行QE三点正本を一意に指す。三文書は公開リポジトリに実体を置き、Codexはここから直接読み込む。第四の独立した施工指示書は置かない。文書公開は製品の公開・出荷GOや実外部作用の許可ではない。

## 現行セット

- 技術基底：ownerが2026-11-13に採用したQE三点セットrev5.0。
- 公開制約の撤廃：ownerの2026-11-14指示。技術・施工内容と母集団を継承し、文書公開制約と旧正本判定文言だけを改訂したrev5.1を現行とする。
- 公開改訂manifest：[MANIFEST.json](qe/現行/MANIFEST.json)。旧rev5.0原本hash、変更箇所、三文書hash、母集団を保持する。
- 仕様書：[01_BLUE-TANUKI_統合仕様書_rev5_1.json](qe/現行/01_BLUE-TANUKI_統合仕様書_rev5_1.json) — SHA-256 `dc970de3010d0e849efcdb7c36fc2d23ba3f994cfaa2c47650f8e28776f6b955`。
- 工程表：[02_BLUE-TANUKI_全体施工工程表_rev5_1.json](qe/現行/02_BLUE-TANUKI_全体施工工程表_rev5_1.json) — SHA-256 `4af5642800b63ccb9547005dc2ace3123613797f1ba5b8443c22680bddcf21e8`。
- 施工指示書：[03_BLUE-TANUKI_Codex施工指示書_rev5_1.json](qe/現行/03_BLUE-TANUKI_Codex施工指示書_rev5_1.json) — SHA-256 `245c503a6f37929624f50fd18c21b67c7f591ccb17388c1a8e76a7f14992609e`。

旧rev5.0の原本SHA-256は仕様書`9b4e9f8d2183150d6cb3d9c2763cd43bfc21d6218c30b6cd99afaeccf8588961`、工程表`05f46c201fc9176af1aaa0dedf5e0289e439984fe944f25af774e556ee2a253b`、施工指示書`ad6f35bcc99c8c9abac477e0be4dd074eb344ba2e6b395c1df1b733435261439`。旧ZIP・MANIFESTと監査の当時証拠は履歴として保持し、現行技術規範へ自動昇格させない。

## 効力と責任境界

1. 現行の設計・工程・施工命令は上記三文書のみ。`AGENTS.md`は共通の安全・権限・監査規律、`docs/作業標準要領.md`はその運用説明、`docs/ROADMAP.md`と`docs/IMPLEMENTATION_HISTORY.md`は工程要約と履歴であり、独立した第四施工指示を発行しない。
2. rev5.0原本の「公開不可」「三文書・原典・要求をPublic Gitへ転載しない」等の旧制約は2026-11-14指示により失効した。rev5.1の改訂原文対照や施工索引に残る古い文言は当時の履歴証拠であって現在の禁止命令ではない。原典・設計・QE要求対応表を公開できる。
3. 実資格情報、利用者の個人情報・運転状態、no-store review本文は引き続き保護する。HDS権限、Approval、L3、Broker、監査、fail-closed、他repo変更の権限は弱めない。製品公開・配布・GAは独立したowner GO待ち（P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`）。
4. rev5.1は要求431・親成果65・施工索引198・親QC260・局所QC396・競合基準61を継承する。施工は全体躯体・全5OS実入口と相互結線を先行し、`SYSTEM_SHAPED`／`BUILD_COVERED`後にQE_QC・OS別QE_QAへ進む。Windows実PCと他4OSの仮想／公式シミュレータ等で指定された規格適合条件を検査する。

## 作業開始・正本更新

独立した作業の開始・切替・再開時は、この現行ピン、manifest、三文書すべて、適用AGENTS.md、owner最新原文指示、実main HEAD・差分を照合する。過去の完了ログから「次の局所BUILD_BATCH」を独立した施工命令として選ばない。完了済み履歴は依存・変更根拠・矛盾の監査時だけ参照する。

ownerがさらに新しい三点一組を指定した場合、三文書とmanifestのSHA-256を照合してこの唯一の現行ピンを更新する。旧版と履歴は消去・改竄しない。ここに記載した製品工程状態は公開方針改訂時点の認識であり、現在の実装状態は毎回コード・test・実行証拠から再観測する。
