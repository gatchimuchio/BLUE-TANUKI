# BLUE-TANUKI iOS

BLUE-TANUKIが所有するiOSネイティブ入口である。Desktop Device Linkのwire contractを使用し、BLUEのHDS判断や承認権限をモバイルアプリへ移さない。

## 現在のsource

- Device IDをランダム生成し、Device Link資格とともにiOS Keychainの`WhenUnlockedThisDeviceOnly`へ保存する。iCloud Keychain同期は無効にする。
- この端末IDに一致する、上限付き・厳密形式のDesktop招待だけを受け付ける。送信前にHost ID、private IPv4、port、証明書SHA-256指紋を表示し、使用者が照合する。
- TLS 1.2／1.3で招待されたleaf証明書をpinし、有効性を確認する。接続ごとにnewline-framed requestを一度だけ送り、5秒の期限を設け、不正形式や余分な応答データを拒否する。
- 明示的なpairing、接続確認、Desktop側の資格失効、および分離された端末内だけの資格削除を提供する。端末内削除では、上限付き・非権威の回復記録を保存し、readbackを確認する。
- アプリがforegroundを離れるとactive transportをcancelする。申請送信前にKeychainへsession IDだけを`WhenUnlockedThisDeviceOnly`で記録し、結果不明時はアプリ再起動後も端末申請一覧との照合まで新規申請を止める。依頼本文やTask本文は端末へ永続保存しない。
- Desktop Brokerから実行系と登録Workspaceを読み、Workspaceに束縛した新しい対話sessionからTask申請を一度だけ送る。申請はDesktop owner確認待ちとして扱う。
- この端末のTask申請一覧とrequest-bound状態を明示照会できる。開始候補の場合だけ直前に状態を再照会して開始要求を出し、Broker側のApproval／Permission再検査に委ねる。
- 取消はTaskの現在状態を照会してから一度だけ要求する。取消要求受付をworker停止・外部処理停止と同一視しない。
- Task投影は識別子・状態・hash・結果本文の有無に限り、依頼本文・結果本文・Tool名・schema・credential・Approval情報・監査識別子を表示しない。
- MCPを使う申請は明示取得した`metadata_only`能力snapshot hashを任意で添付する。能力名・接続先・schema・credential・結果はMobileへ返さず、hashは権限にならない。
- BLUE Gatewayを直接呼び出さず、Owner承認やPermissionを発行せず、device metadataを権限へ変換しない。

## 未成立の製品経路

Mobile側にはDevice Link契約に沿ったTask申請・状態照会・開始要求・取消要求のsourceを追加した。D4 BrokerとBLUE Runtime Adapterを通る一仕事が、BLUE Gateway／C/J/Mへ実際に届き、承認・作用・結果・M・復帰まで一気通貫に動いたことは未確認である。公開repoではD4のDevice Link／AgentTask契約を確認できるが、D4側の`blue_tanuki_adapter`は参照READMEのみで、実装sourceは見つかっていない。Gatewayの既存runtime-intent経路とこのBroker操作を結ぶ実consumerも未確認である。

通知、lifecycleからのTask復帰、更新・rollback、package削除処理も未実装である。結果不明の申請はKeychain内のsession ID checkpointで再起動後も新規送信を停止し、Desktop一覧で一致した場合だけ保留を解除する。照合できない場合はDesktop ownerがAgent Centerで確認するまで停止を維持する。このsource変更だけではG10、`SYSTEM_SHAPED`、`BUILD_COVERED`、installed product、iOS QA、署名やApp Store準備の成立を示さない。

iOS targetはunsigned source段階であり、Simulatorまたは実機へのinstall・起動は未実施。local-network permission、Keychainの実動、実Desktop Brokerとのpairing、Task操作およびBLUEのC/J/Mを通る仕事は未確認である。

## Build

WindowsにはXcodeがない。iOS Simulator source buildは手動の[ios-native-build workflow](../../.github/workflows/ios-native-build.yml)で補助確認する。workflowは`workflow_dispatch`だけを受け付け、選択したcommitを署名せずbuildし、artifactを保存しない。

XcodeのあるmacOSでは次を実行する。

<pre><code>xcodebuild -project apps/mobile-ios/BlueTanuki.xcodeproj -scheme BlueTanuki -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$TMPDIR/blue-tanuki-ios-derived" CODE_SIGNING_ALLOWED=NO build</code></pre>
