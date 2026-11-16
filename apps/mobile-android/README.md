# BLUE-TANUKI Android

BLUE-TANUKIのAndroidネイティブ製品入口である。Desktop Device Link broker contractを使う。Android clientは下流のoperator surfaceであり、ownerの判断を代行せず、承認を付与せず、BLUE-TANUKI Gatewayを直接呼び出さない。

## 現在の実装

- ownerがDesktopで一回限りの招待を発行するときに使う128-bit device IDを生成・保存する。起動時に保存値を再読込し、旧形式の資格情報を移行するときはそのdevice IDを引き継ぐ。資格情報が保存されている間はdevice IDを変更できない。
- native Android画面で招待情報を入力し、招待のdevice IDがこの端末のIDと一致することを確認する。pairingの前にDesktop hostと証明書fingerprintをownerが目視確認する。
- privateまたはloopbackのIPv4へTLSで接続する。固定する証明書は招待に含まれるfingerprintと一致し、有効期間内でなければならない。
- Android 17 / API 37では、手動確認したDesktop Brokerへ接続する目的を説明した後に限り、OSのlocal-network runtime permissionを要求する。拒否時はDesktopへの全network accessを無効のままにする。
- TLS接続ごとに、上限とtimeoutを定めたDevice Link requestを一度だけ送る。requestがDesktopへ届いた可能性がある場合、招待を再送しない。
- 返却されたdevice credentialはAndroid Keystore鍵で保護するAES-GCM ciphertextとしてのみ保存する。secure storageへの保存またはreadbackに失敗した場合、pairing完了と扱わない。
- アプリがforegroundへ戻ったときに保存済みcredentialを確認し、Desktop確認に成功した場合はこの端末のTask申請一覧を一度だけread-onlyで再取得する。backgroundへ移る際は接続socketを閉じる。
- 通常の解除はDesktopへ`端末離脱`を一度だけ送り、要求nonceと正確な失効応答を確認した後、端末内資格を削除してreadbackする。曖昧な応答では資格を保持し、自動再送しない。
- 通信不能時の端末内資格削除は、Desktop側の失効と別の回復操作として明示する。資格の削除と、Desktop失効未確認・権限影響なしを固定した最大32件の非権威回復記録を同じKeystore保護状態へ保存し、両方のreadback後にだけ完了表示する。
- foreground世代が変わった場合、TLS handshake後・要求送信前に再確認し、backgroundから新しい要求を送らない。
- Desktop Brokerから実行系・登録Workspace・この端末の申請を取得し、MCPはsnapshot hash・件数・利用可否だけを取得する。能力名・schema・credentialは表示しない。
- Task申請はDesktopの作業先を送信直前に再照合し、新しい対話sessionを作成する。申請POSTの前にsession IDだけをAES-GCM／Android Keystoreで暗号化保存・readbackし、応答が不明な場合は再送を止める。
- 申請一覧に同じsessionが現れたことを確認するまで次の申請を拒否する。開始・取消は毎回最新Task状態を再取得し、開始候補／`pending`／`running`に合致する場合だけ一度要求する。開始許可はBroker側の再検査に委ね、取消要求を実停止と扱わない。
- Task一覧は申請ID・指示hash・状態・結果hash・結果本文の有無だけを扱い、結果本文・監査識別子をMobileへ返さない。

Task一覧のforeground再取得は申請checkpointの照合だけに使い、自動再申請・開始・取消は行わない。既存Taskの個別状態は使用者が明示して照会する。Task操作はDevice Link APIに接続するsourceまでであり、実Desktop BrokerからBLUE Runtime Adapter／Gateway／C/J/Mを通る一仕事の実動は未確認。通知、更新、installed package削除も未成立。Android emulator・実機、KeyStore実動、release packageで検査していない。

## ビルドと限定確認

JDK 17、Android SDK Platform 37、Build Tools 36.0.0を使う。OneDrive外かつASCII文字だけのpathにあるWindows checkoutで、次を実行する。

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

2026-11-17の限定確認では、OneDrive外・ASCII pathの新規`%TEMP%`コピーで`:app:testDebugUnitTest :app:assembleDebug`が成功し、unit test 21件がすべてPASSした。Task契約parse／入力制約／結果本文拒否／evidence-source制限を含む。debug APKは検証コピー内だけに生成した。最初のコピーは既存`app/build`出力を含みGradleが出力先を削除できず失敗したため、既生成物を除いたコピーで再実行した。OneDrive checkoutでの失敗原因が日本語pathか同期・ACLのどちらかは切り分けていない。

debug APKは一時検証コピーにのみ生成したローカル開発用成果物であり、release packageではない。署名鍵とPlay Store設定は含まない。この施工時にAndroid emulator／実機は接続していない。
