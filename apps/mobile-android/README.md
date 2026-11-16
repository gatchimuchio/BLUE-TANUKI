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

現行の実装範囲は初回pairingと接続確認までである。Taskの操作、取消、lifecycleからの復帰、更新、削除は未実装。release buildではなく、Android実機でも検査していない。

## ビルドと限定確認

JDK 17、Android SDK Platform 37、Build Tools 36.0.0を使う。OneDrive外かつASCII文字だけのpathにあるWindows checkoutで、次を実行する。

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

このPCのOneDrive checkoutでは、Gradle Test Workerがtest classを読み込めず、`assembleDebug`も生成済みdex出力を置き換えられずに失敗する。OneDrive外の新しい`%TEMP%` pathへ初回入口sourceを複製した検査では、当時のunit test 10件と`assembleDebug`が成功した。端末ID継続性を加えた現行sourceは`assembleDebug`のみ成功しており、この更新後のunit testは再実行していない。失敗の原因が日本語pathか同期・ACLのどちらかは切り分けていない。

生成されたdebug APKはローカルの開発用成果物であり、release packageではない。署名鍵とPlay Store設定は含まない。この施工時にAndroid emulator／実機は接続していない。
