# BLUE-TANUKI QE 最終対応OS（5OS）

2026-10-12。**新AGI製品の完成対象はWindows、Linux、macOS、Android、iOS**。旧v1.0 RCではMobile機能が未搭載であり、これを現在の5OS完成証拠に転用しない。OSごとに実装形状を成立させ、詳細なQCは全体実装後、QAはOS別・対象別とする。

## 対応範囲と区分

| OS | 製品入口 | 一気通貫実装で必要な経路 | QC・QAの独立性 |
|---|---|---|---|
| Windows | Desktop本体 | 導入、常駐、C/J/M、Broker作用、結果、更新・復旧・削除 | Windows実機・installed製品として独立 |
| Linux | native Desktop本体 | native導入・常駐／service、実環境権限、Broker作用、復旧・削除 | WSL／WSLg／headlessとは別のLinux native実機 |
| macOS | Desktop本体 | macOS導入、native OS権限・資格、Broker作用、復旧・削除 | macOS実機として独立 |
| Android | Mobile native製品入口 | install・初回起動、Android権限・秘密保管、Device Link、仕事の開始・承認・状態・取消・再接続、更新・削除 | Android端末固有の実動作・QC／QA |
| iOS | Mobile native製品入口 | install・初回起動、Keychain/App Sandbox、Device Link、仕事の開始・承認・状態・取消・再接続、更新・削除 | iOS端末固有の実動作・QC／QA |

## Mobileの構造と安全

AndroidとiOSは一括した「モバイル対応」ではなく、独立した製品要求として管理する。画像・音声入力を扱うF16は共通媒体の責務であって、Android/iOSの製品完成ではない。[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)が指す非公開QE正本の実装索引ではAndroid=G09、iOS=G10。旧G05・G06は別のQC親成果であり上書きしない。

D4Pocket（旧GUI-Shell）は予定するMobile/OS Broker外殻であり、その既存契約を利用する。招待・端末資格・TLSの秘密情報はAndroid/iOS native層で扱い、Dartやplatform-channelの戻り値、アプリログ、監査投影へ露出しない。Mobile画面やC／J／Mの提案から権限を生成せず、Desktop Broker側の現在Permission・対象・Ownerの必要承認を独立に満たす。

MobileクライアントがDesktop Brokerへ安全に接続する能力と、Mobile端末だけでC/J/Mの自律動作を行う能力は別である。後者はこの文書だけで自動的に搭載済み・QC済みとしない。背景制約・通信断・アプリ強制終了・OS権限失効時は、二重実行・無断再送・架空成功なしに現在状態を復元または明示保留する。

OSの最小サポート版、CPU arch、配布方式・ストア要件は、実際の契約・対象端末・配布先が確定してから固める。未確認の版数や配布実績を作らない。D4Pocket側の別repo変更はownerによる対象・path・復元の限定委任が必要である。

## QEの完成と公開

QE_BUILDで5OSすべての必要consumerをつなぎ、BUILD_COVEREDに到達してから全体QE_QCで実物を調べる。QCで検出した欠陥は設計と実装へ還流する。各OSのQE_QAは当該OSの版・機能・端末条件・証拠範囲だけを保証し、別OSの合格で代替しない。

旧v1.0 RCはP13=PENDING_OWNER_GO、public_claim_allowed=false。旧RCのMobile未搭載は新5OS製品目標と矛盾しないが、新5OSへの構築着手・別repo変更・製品公開をこの文書の存在から許可しない。
