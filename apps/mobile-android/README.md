# BLUE-TANUKI Android

BLUE-TANUKIのAndroidネイティブ製品入口である。Desktop Device Link broker contractを使う。Android clientは下流のoperator surfaceであり、ownerの判断を代行せず、承認を付与せず、BLUE-TANUKI Gatewayを直接呼び出さない。

## 現在の実装

- ownerがDesktopで一回限りの招待を発行するときに使う128-bit device IDを生成・保存する。起動時に保存値を再読込し、旧形式の資格情報を移行するときはそのdevice IDを引き継ぐ。資格情報が保存されている間はdevice IDを変更できない。
- native Android画面で招待情報を入力し、招待のdevice IDがこの端末のIDと一致することを確認する。pairingの前にDesktop hostと証明書fingerprintをownerが目視確認する。
- privateまたはloopbackのIPv4へTLSで接続する。固定する証明書は招待に含まれるfingerprintと一致し、有効期間内でなければならない。
- Android 17 / API 37では、手動確認したDesktop Brokerへ接続する目的を説明した後に限り、OSのlocal-network runtime permissionを要求する。拒否時はDesktopへの全network accessを無効のままにする。
- TLS接続ごとに、上限とtimeoutを定めたDevice Link requestを一度だけ送る。requestがDesktopへ届いた可能性がある場合、招待を再送しない。
- 返却されたdevice credentialはAndroid Keystore鍵で保護するAES-GCM ciphertextとしてのみ保存する。secure storageへの保存またはreadbackに失敗した場合、pairing完了と扱わない。
- アプリがforegroundへ戻ったときに保存済みcredentialを確認する。backgroundへ移る際は接続socketを閉じる。
- 通常の解除はDesktopへ`端末離脱`を一度だけ送り、要求nonceと正確な失効応答を確認した後、端末内資格を削除してreadbackする。曖昧な応答では資格を保持し、自動再送しない。
- 通信不能時の端末内資格削除は、Desktop側の失効と別の回復操作として明示する。資格の削除と、Desktop失効未確認・権限影響なしを固定した最大32件の非権威回復記録を同じKeystore保護状態へ保存し、両方のreadback後にだけ完了表示する。
- foreground世代が変わった場合、TLS handshake後・要求送信前に再確認し、backgroundから新しい要求を送らない。

現行の実装範囲はpairing、接続確認、Desktop失効、通信不能時の端末内回復までである。通常Taskの操作・取消、lifecycleからのTask復帰、更新、package削除は未実装。D4のDevice Link contractへの接続sourceがある状態であり、実Desktop Broker／BLUE Gateway／C/J/Mを通る一仕事の実動は未確認。release buildではなく、Android実機でも検査していない。

## ビルドと限定確認

JDK 17、Android SDK Platform 37、Build Tools 36.0.0を使う。OneDrive外かつASCII文字だけのpathにあるWindows checkoutで、次を実行する。

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

2026-11-17の限定確認では、OneDrive外・ASCII pathの新規`%TEMP%`コピー（既存`.gradle`と全`build`生成物を除外）で`:app:testDebugUnitTest :app:assembleDebug`が成功し、unit test 14件がすべてPASSした。最初のコピーは`app/build`の既存生成物を含み、Gradleが出力先を削除できず失敗したため、生成物なしの新規コピーで再実行した。OneDrive checkoutでの失敗原因が日本語pathか同期・ACLのどちらかは切り分けていない。

debug APKは一時検証コピーにのみ生成したローカル開発用成果物であり、release packageではない。署名鍵とPlay Store設定は含まない。この施工時にAndroid emulator／実機は接続していない。
