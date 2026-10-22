# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。Windows-firstで全体の実consumer接続を進めている。最終対象OSはWindows／Linux／macOS／Android／iOSの5OSであり、現時点で対応済みという意味ではない。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。

## 次の接続

Composioの`search`／`accounts`／`scopes`／`execute`を既存のHDS・operation catalog・tool registryへ接続済み。PostHogではconnected accountから限定投影した認証方式とregionを実行直前に照合し、明示された`us`／`eu`と一致しない場合は外部POSTを止める。provider metadata、scope推薦、connection stateはtask consentや権限にならない。実provider・実資格・外部業務作用は未使用。

次はF15.03として、非公開登録済みの未包含要求から公式契約に基づく有限な実consumerを展開する。Composio資料間にsubdomain／self-hosted契約の記述差が残るため、観測不能な接続条件は実行可能と推測しない。dynamic provider/plugin catalogと形式移行は`BUILD_GAP`。

## 維持する境界

独立作業の開始・切替・再開では、固定された現行三点セット全文を読み直す。J4 strict closureは通常のdocs gateから推定しない。Git復旧refsは`MIGRATION_COMPLETE`で、local二世代branch／remote二世代tagを使う（例：`refs/tags/codex/backup-main`）。

HDS-BRAINの判断・Approval Gate L3、Broker permission、M非権限、監査、秘密保護、fail-closedを維持する。C08.03実provider試験は保留、P13は`PENDING_OWNER_GO`／`public_claim_allowed=false`。実装完了後に全体QC、対象別QA、ownerの独立した公開・出荷判断へ進む。

詳細な完了バッチと観測証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)および[`開発進捗.md`](開発進捗.md)に保存する。完了ログや旧版仕様は、現行の依存・変更系譜・矛盾を解く場合だけ参照する。
