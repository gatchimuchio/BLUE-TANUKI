# BLUE-TANUKI iOS

BLUE-TANUKIが所有するiOSネイティブ入口である。Desktop Device Linkのwire contractを使用し、BLUEのHDS判断や承認権限をモバイルアプリへ移さない。

## 現在のsource

- Device IDをランダム生成し、Device Link資格とともにiOS Keychainの`WhenUnlockedThisDeviceOnly`へ保存する。iCloud Keychain同期は無効にする。
- Keychain状態はversion 3以降でApplication Support内のinstallation scope IDに束縛する。scope markerはアプリのcontainer内に置き、backup除外属性を読戻しで確認する。version 4は開始・取消の保留、version 5は申請の照合記録を保持する。旧version 1/2状態は初回upgrade時に資格・Device ID・保留sessionを維持したまま移行する。
- アプリを削除した瞬間のKeychain消去処理はiOSアプリから実行できないため、marker導入後の再インストールでは、初回起動時にcontainer marker欠落と旧Keychain scopeの不一致を検出する。旧資格だけを同じアプリ固有Keychain itemから除去し、Device ID・非権威回復記録・Task申請session checkpointはreadback確認後も保持する。Desktop Agent Centerで旧端末・Task状態を確認したというownerの明示操作まで招待検証を止め、結果不明Taskは申請一覧と一致するまで再送しない。状態不正や保存未確認では通信を開始しない。marker導入前に削除された旧version 1/2状態は、初回upgradeと区別できないため自動検出できない。これは削除時点での即時消去やiOS package deletionの完了証明ではない。
- この端末IDに一致する、上限付き・厳密形式のDesktop招待だけを受け付ける。送信前にHost ID、private IPv4、port、証明書SHA-256指紋を表示し、使用者が照合する。
- TLS 1.2／1.3で招待されたleaf証明書をpinし、有効性を確認する。接続ごとにnewline-framed requestを一度だけ送り、5秒の期限を設け、不正形式や余分な応答データを拒否する。
- 明示的なpairing、接続確認、Desktop側の資格失効、および分離された端末内だけの資格削除を提供する。端末内削除では、上限付き・非権威の回復記録を保存し、readbackを確認する。
- Desktopへ `端末離脱` を送る前に、資格に結び付いた保留記録をKeychainへ保存して再読込する。同じ要求nonceの認証済み `INTERNAL_STATE` 応答が `失効` を示したら、端末内資格と保留記録を削除して再読込する。送信前に止まったと確定できる場合は保留記録だけを外す。
- 応答不明や中断時は再起動後も保留を引き継ぎ、Desktop通信を停止する。Desktop側を確認し、必要な場合は明示確認のある端末内資格削除を使う。Desktopでの実行中の仕事の停止は別途確認する。
- アプリがforegroundを離れるとactive transportをcancelする。申請送信前に、同じDesktop・端末、選択した実行系・作業領域、セッションID、送信するUTF-8のSHA-256に結び付いた照合記録をKeychainへ`WhenUnlockedThisDeviceOnly`で保存し、読戻す。受付の指示hashも送信した値に照合する。依頼本文やTask本文は永続保存しない。
- Desktop Brokerから実行系と登録Workspaceを読み、Workspaceに束縛した新しい対話sessionからTask申請を一度だけ送る。申請はDesktop owner確認待ちとして扱う。
- この端末のTask申請一覧とrequest-bound状態を明示照会できる。開始候補の場合だけ直前に状態を再照会して開始要求を出し、Broker側のApproval／Permission再検査に委ねる。
- アプリ起動時とbackgroundからforegroundへ戻ったときにTask申請一覧をread-onlyで取得する。同じセッションに一件だけ申請があり、照合記録と一致した場合に新規申請の保留を解除する。不一致、複数、照合に必要な情報がない旧形式の記録では保留を維持する。既存Taskの状態は開始・取消の保留記録と一致する申請から先に照会する。確認できない個別応答は不明と表示し、他の申請は引き続き照会できる。通信断やbackground移行で照会を止め、自動再申請・開始・取消は行わない。
- 取消はTaskの現在状態を照会してから一度だけ要求する。D4 Brokerの認証済み `INTERNAL_STATE` は対応するTaskの台帳状態を表す。開始・取消への応答を受けたあとも保留を維持し、同じTaskを別の状態照会で確認する。取消は終端状態を再確認するまで保留し、外部処理が停止したかは未確認とする。
- Task投影は識別子・状態・hash・結果本文の有無に限り、依頼本文・結果本文・Tool名・schema・credential・Approval情報・監査識別子を表示しない。
- MCPを使う申請は明示取得した`metadata_only`能力snapshot hashを任意で添付する。能力名・接続先・schema・credential・結果はMobileへ返さず、hashは権限にならない。
- BLUE Gatewayを直接呼び出さず、Owner承認やPermissionを発行せず、device metadataを権限へ変換しない。

## 未成立の製品経路

Mobile側にはDevice Link契約に沿ったTask申請・状態照会・開始要求・取消要求のsourceを追加した。D4 BrokerとBLUE Runtime Adapterを通る一仕事が、BLUE Gateway／C/J/Mへ実際に届き、承認・作用・結果・M・復帰まで一気通貫に動いたことは未確認である。公開D4-POCKET mainには`packages/blue_tanuki_adapter`のPython sourceがあるが、現在のcontract／adapter sourceで確認できるのはhealth・状態・通知・approval・audit・diagnostics・recoveryの参照投影である。このpackageからMobile Device LinkのAgentTask申請・実行をGatewayの`/runtime/intent`へ渡すconsumerは確認できていない。Gateway側のruntime-intent・status・cancel APIは存在するが、Broker操作から同APIへ届く一仕事のconsumerと実動は未確認である。

Task状態通知は使用者がiOS通知許可を明示した場合に限り、同一プロセス内で前回確認済みTaskの状態変化を再照会で観測したとき、Task本文・IDを含まない端末内通知を出す。初回観測・未照会状態では通知せず、background通信やpush受信はしない。更新・rollbackは未実装である。package削除後の初回起動では旧資格を使わず、Desktop側の旧端末・Task状態をownerが確認するまで招待検証を止める。結果不明Taskのsession checkpointは保持し、再結合後にDesktop申請一覧と一致するまで新規申請を止める。このsource変更だけではD4 BrokerとBLUE Gateway／C/J/Mを通る実経路、G10、`SYSTEM_SHAPED`、`BUILD_COVERED`、installed product、iOS QA、署名やApp Store準備の成立を示さない。

iOS targetはunsigned source段階であり、Simulatorまたは実機へのinstall・起動は未実施。local-network permission、Keychainの実動、実Desktop Brokerとのpairing、Task操作およびBLUEのC/J/Mを通る仕事は未確認である。

## Build

WindowsにはXcodeがない。iOS Simulator source buildは手動の[ios-native-build workflow](../../.github/workflows/ios-native-build.yml)で補助確認する。workflowは`workflow_dispatch`だけを受け付け、選択したcommitを署名せずbuildする。bundle ID・local-network purpose・ZIP内のInfo.plist／実行ファイルを確認したunsigned `.app` ZIPとsource SHA／Xcode／SDK／artifact SHA-256を含むmanifestを、GitHub Actions artifactへ7日間保存する。

XcodeのあるmacOSでは次を実行する。

<pre><code>xcodebuild -project apps/mobile-ios/BlueTanuki.xcodeproj -scheme BlueTanuki -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$TMPDIR/blue-tanuki-ios-derived" CODE_SIGNING_ALLOWED=NO build</code></pre>

生成artifactはiOS Simulator専用のbuild出力であり、実機用IPA、署名、インストール・起動、実Desktop Broker接続、App Store提出、配布準備を証明しない。
