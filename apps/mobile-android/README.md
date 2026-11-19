# BLUE-TANUKI Android

BLUE-TANUKIのAndroidネイティブ製品入口である。Desktop Device Link broker contractを使う。Android clientは下流のoperator surfaceであり、ownerの判断を代行せず、承認を付与せず、BLUE-TANUKI Gatewayを直接呼び出さない。

## ワークスペースのpackage入口

リポジトリのルートから次を実行すると、Android release variantのAPKとAABを生成し、ZIP構造・source SHA-256・artifact SHA-256を検証する。

    corepack pnpm package:android
    corepack pnpm package:android:verify

生成物とsource-bound manifestはrelease/androidへ保存する。APK/AABは署名設定なしのsource buildで、install、実行、実Broker接続、Store提出、配布準備を証明しない。署名資格は使用せず、署名設定がGradleへ追加された場合はこのbuilderを停止する。manifestのsecrets_reviewはnot_performedであり、秘密を含まないという監査結果ではない。

## 現在の実装

- ownerがDesktopで一回限りの招待を発行するときに使う128-bit device IDを生成・保存する。起動時に保存値を再読込し、旧形式の資格情報を移行するときはそのdevice IDを引き継ぐ。資格情報が保存されている間はdevice IDを変更できない。
- native Android画面で招待情報を入力し、招待のdevice IDがこの端末のIDと一致することを確認する。pairingの前にDesktop hostと証明書fingerprintをownerが目視確認する。
- privateまたはloopbackのIPv4へTLSで接続する。固定する証明書は招待に含まれるfingerprintと一致し、有効期間内でなければならない。
- Android 17 / API 37では、手動確認したDesktop Brokerへ接続する目的を説明した後に限り、OSのlocal-network runtime permissionを要求する。拒否時はDesktopへの全network accessを無効のままにする。
- TLS接続ごとに、上限とtimeoutを定めたDevice Link requestを一度だけ送る。requestがDesktopへ届いた可能性がある場合、招待を再送しない。
- 返却されたdevice credentialはAndroid Keystore鍵で保護するAES-GCM ciphertextとしてのみ保存する。secure storageへの保存またはreadbackに失敗した場合、pairing完了と扱わない。
- アプリがforegroundへ戻ったときに保存済みcredentialを確認し、Desktop確認に成功した場合はこの端末のTask申請一覧を一度だけread-onlyで再取得する。backgroundへ移る際は接続socketを閉じる。
- 通常の解除では、保存資格に結び付いた保留記録をKeystoreで保護して保存・再読込してから、Desktopへ `端末離脱` を一度送る。同じ要求nonceの認証済み `INTERNAL_STATE` 応答が `失効` を示したら端末内資格と保留記録を削除し、保存状態を再読込する。送信前に止まったと確定できる場合は保留記録だけを外す。
- 応答不明や中断時は再起動後も資格と保留記録を保持し、Desktop通信を停止する。Desktop側の状態を確認し、必要な場合は明示確認のある端末内資格削除を使う。Desktopでの実行中の仕事の停止は別途確認する。
- 通信不能時の端末内資格削除は、Desktop側の失効と別の回復操作として明示する。資格の削除と、Desktop失効未確認・権限影響なしを固定した最大32件の非権威回復記録を同じKeystore保護状態へ保存し、両方のreadback後にだけ完了表示する。
- foreground世代が変わった場合、TLS handshake後・要求送信前に再確認し、backgroundから新しい要求を送らない。
- Desktop Brokerから実行系・登録Workspace・この端末の申請を取得し、MCPはsnapshot hash・件数・利用可否だけを取得する。能力名・schema・credentialは表示しない。
- Task申請はDesktopの実行系と作業領域を送信直前に再照合し、新しい対話セッションを作成する。申請POSTの前に、同じDesktop・端末、選択した実行系・作業領域、セッションID、送信するUTF-8のSHA-256に結び付いた照合記録をAndroid Keystoreで暗号化保存し、読戻す。受付の指示hashも送信した値に照合する。本文は保存しない。
- 申請一覧の同じセッションに一件だけ申請があり、照合記録と一致した場合に新規申請の保留を解除する。不一致、複数、照合に必要な情報がない旧形式の記録では保留を維持する。開始・取消は最新Task状態を再取得し、開始候補／`pending`／`running`に合致する場合だけ一度要求する。開始許可はBroker側の再検査に委ね、取消要求を実停止と扱わない。
- Task一覧は申請ID・指示hash・状態・結果hash・結果本文の有無だけを扱い、結果本文・監査識別子をMobileへ返さない。
- アプリがforegroundを離れると未送信の依頼本文を入力欄から消去し、次回起動・再表示で復元しない。申請中の本文は新しいTaskとして自動再送しない。

Task一覧の再取得では既存Taskの状態を読み取り、開始・取消の保留記録と一致する申請を先に照会する。D4 Brokerの認証済み `INTERNAL_STATE` は対応するTaskの台帳状態を表す。開始・取消への応答からは保留を解除せず、同じTaskの状態を別の照会で確認する。取消の保留は終端状態を再確認するまで維持する。個別応答を確認できない行は不明と表示し、他の行の状態は引き続き照会できる。通信断やbackground移行で照会を止め、自動再申請・開始・取消は行わない。通知を明示有効化した場合は、同一プロセス内で前回確認済みTaskの状態変化を再照会で観測したときだけ、Task本文・IDを含まない端末内通知を出す。初回観測・未照会状態では通知せず、background通信やpush受信はしない。Task操作はDevice Link APIに接続するsourceまでであり、実Desktop BrokerからBLUE Runtime Adapter／Gateway／C/J/Mを通る一仕事の実動は未確認。更新、installed package削除は未成立。Android emulator・実機、Keystore実動は未確認。

未照合のTask申請checkpointが残る間は、資格がローカル削除された後も端末IDの再生成を停止する。Desktop一覧で同じsessionを照合してcheckpointが消えるまで、旧端末との対応を維持する。

## ビルドと限定確認

JDK 17、Android SDK Platform 37、Build Tools 36.0.0を使う。OneDrive外かつASCII文字だけのpathにあるWindows checkoutで、次を実行する。

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

2026-11-17の限定確認では、OneDrive外・ASCII pathの新規`%TEMP%`コピーで`:app:testDebugUnitTest :app:assembleDebug`が成功し、unit test 21件がすべてPASSした。Task契約parse／入力制約／結果本文拒否／evidence-source制限を含む。debug APKは検証コピー内だけに生成した。最初のコピーは既存`app/build`出力を含みGradleが出力先を削除できず失敗したため、既生成物を除いたコピーで再実行した。OneDrive checkoutでの失敗原因が日本語pathか同期・ACLのどちらかは切り分けていない。

2026-11-17のrelease variant限定生成では、commit `c798362ddfbb0a6c8c87de81c3c4f2e3243dd1d9`をgit archiveからOneDrive外・ASCII pathの新規`%TEMP%`コピーへ展開し、`:app:assembleRelease :app:bundleRelease`が成功した。生成物は未署名で、APKは689,754 bytes（SHA-256 `c3c4ee10592b673005531b3ece25026b62e788663dc592879981e15a9f483648`）、AABは691,409 bytes（SHA-256 `c6f2625b17178333187c9d160d4100576438d3701a343b07fdbb7031d16eb79d`）。生成物は一時検証コピー内にのみ保持し、署名、install、起動、Android emulator／実機、実Desktop Broker接続は行っていない。この限定生成はinstalled product、実動、配布準備の証拠ではない。

debug APKも一時検証コピーにのみ生成したローカル開発用成果物である。署名鍵とPlay Store設定は含まない。
