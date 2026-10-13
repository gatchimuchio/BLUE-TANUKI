# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。毎作業・切替・再開時に、最新版非公開QE rev2.3の三点全文と適用AGENTS.md、active、現物を再読する。現在のowner開発委任に従う。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-RESULT-MEMORY。C03.01–C03.03の既存取引とreceiptを、実plan file.search結果から私有Mへ接続する。元実結果→Jの限定観測記録→内容固定MemoryCommit→M保存→receipt再照合→後続stepを通す。任意の意味更新・知識昇格は対象外。

開始HEADは5f6659acf42d9cc221bbdfe141b48f18305f1164、local/remote main一致・clean。local復元branch二世代とremote tag二世代を5f6659acf42d9cc221bbdfe141b48f18305f1164／72167f81155a24d6b8a3921ee0fe2380340769fbへCAS・leased atomic pushで保全した。旧D01.03 stashは保持。backup ref移行はMIGRATION_COMPLETE。親単一writer、subagent read-only。

Jは実admission・配送digest・verified bindingと元結果から限定観測だけを固定する。MemoryCommit本文・expected_versionを先にJ checkpointへCAS保存し、Jの読取専用同内容参照で既存coordinatorをstage→apply→receipt照合する。新runtimeのJ/Mは別SQLite取引。再起動で同保存commitを使い、receipt確認まで後続stepを保留する。M recordを読取照合する実consumerを依存準備へつなぐ。

## 安全・未接続

Mは非権限・観測限定・世界真理未採用。元plan requestとstep審査requestを分け、旧計画版・元観測時刻・期限を保持する。過去L3を任意M変更や新作用へ再利用せず、同検索結果の内部記録だけ扱う。候補提案、C案、delete、任意上書きは入口を作らない。raw出力・ticket・資格をUI/C/Complete Historyへ出さない。保存故障・receipt不一致はfail-closed。既存Approval/L3/output audit/standalone/監査を維持。

Mの一般意味採用・反証・長期学習、全体writer lease、OS別保護・容量回復、D4独立Permission、実外部受理照合、5OS製品はBUILD_GAP。実provider・実資格・業務作用、D4Pocket/ミニドラ別repo変更、公開・出荷は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部原典・ZIP・対応表・raw運転証拠はPublic Gitへ入れない。

## 技術確認・保全

typecheck→build、実worker結果→M→再起動後続の限定testと、未承認入力・異内容・J/M中断窓の必要な否定確認を行う。built Gatewayの隔離HTTP smoke、HDS standalone、変更文書検査・差分確認を実施する。全suite/QC/QA/耐久/全OS/providerは後段。結果と未接続を記録し、限定commitをmainへpushしてremote refs・dirty・stashを再照合する。他writer・重大保護逸脱・owner停止では再同期する。

STATUS=WIRED（通常HTTPの計画file.search観測保存と既存J依存consumerの限定範囲）。次consumerはM受領確認済み観測を使うJの依存step準備。一般意味採用や任意M更新の承認経路は別施工。

最終typecheck→build、限定8 files／86 tests（2 workers固定）、built GatewayのM受領保存故障・再起動HTTP smoke、HDS standaloneはPASS。docs:check（通常日本語基底・license）と差分確認もPASS。mainへ限定commit/pushしてremoteを照合する。初回HTTP smokeの試験側assertionとack確認欠陥の修正は開発進捗に保持する。
