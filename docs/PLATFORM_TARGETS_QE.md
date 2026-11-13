# BLUE-TANUKI QE 最終対応OS（5OS）

2026-11-13 rev5.0。**新AGI製品の完成対象はWindows、Linux、macOS、Android、iOS**。旧v1.0 RCではMobile機能が未搭載であり、これを現在の5OS完成証拠に転用しない。全OS入口と必要な機能を一つの全体実装で結び、`BUILD_COVERED`後にOS別QCを行う。

## 対応範囲と区分

| OS | 製品入口 | 一気通貫実装で必要な経路 | QC・QAの独立性 |
|---|---|---|---|
| Windows | Desktop本体 | 導入、常駐、C/J/M、Broker作用、結果、更新・復旧・削除 | 所有Windows PC上のinstalled製品で最終確認 |
| Linux | native Desktop本体 | native導入・常駐／service、OS権限、Broker作用、復旧・削除 | Linux VM／native hosted runner。WSLのみでnative適合を代用しない |
| macOS | Desktop本体 | macOS導入、native OS権限・資格、Broker作用、復旧・削除 | macOS hosted runner／OS忠実な仮想実行環境 |
| Android | Mobile native製品入口 | install・初回起動、Android権限・秘密保管、Device Link、仕事の開始・承認・状態・取消・再接続、更新・削除 | Android Emulator／仮想device API imageで独立確認 |
| iOS | Mobile native製品入口 | install・初回起動、Keychain/App Sandbox、Device Link、仕事の開始・承認・状態・取消・再接続、更新・削除 | iOS Simulator／仮想OSで独立確認 |

## OS試験媒体と保証境界

Windowsの最終確認は所有Windows PCで実施する。Linux、macOS、Android、iOSはOSの版・API／ABI・権限・配布契約を再現するVM、公式simulator／emulator、または該当OSを実行するHosted runnerで個別に確認できる。各証拠にOS image／runner、版・architecture、API／ABI、installer hash、実行条件を記録し、別OSやmockの結果を流用しない。仮想環境で再現できない物理hardware、実署名・Store配布、使用者本人のlive資格は別の未確認範囲として扱う。

## Linux packageの現在の対象契約

現在のLinux installer sourceはx86_64専用で、vendor-supportedなGNU/Linux distributionのうちglibcを使い、Linux kernel 4.18以上・glibc 2.28以上を満たす環境を対象とする。musl-based Linuxはこのpackageの対象外。Node.js v22.14.0の公式build基準は[Node.js v22.14.0 BUILDING.md](https://github.com/nodejs/node/blob/v22.14.0/BUILDING.md)を参照する。これはNode runtimeとの互換条件であり、BLUE-TANUKIのdistribution別installed QAを意味しない。

installerはNode runtimeを同梱する。導入側にはPOSIX shell／標準utility、`getconf`、`tar`、`mktemp`、`find`、`ps`、`awk`、`sha256sum`または`shasum`を要求する。Secret Service over session D-Busは秘密情報を永続化する場合の依存であり、installerの導入成功からその稼働を推定しない。配布manifestとREADMEに同じ境界を出し、対応外のarchitecture、kernel、libcではファイル変更前に停止する。

manifest・preflightとx64 package builderのsource接続はQE_BUILDの一部。2026-11-13、source SHA=`49fb172e172320ff4ef5baafe5a570623c51cc67`をWSL2 Ubuntu 24.04上でpackage-only生成し、Linux x64 tar installerの4,214 entriesとsingle-file `.run` installerを検証した。archive SHA-256=`3de96299b7a7219ff73d71c5315410c4c9e350e90f712f3cff4abcf240300127`、`.run` SHA-256=`3d4139a23edd5832c9b1aa3f32f0a8ea3ffa53bbbd8c3cbd30b4e99c0223c2fc`。WSL証拠はnative Linux runtimeへ転用しない。別時点のmain SHA=`37ca041caa573956b3181f11b51032123df2175f`に対する手動workflow_dispatch [run #15](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43316577235)はUbuntu 24.04.5 LTS x86_64 hosted runner上でpackage生成・manifest／runtime verify、隔離Setup、bundled runtime、Gateway／Control Center health／app、通常利用・Repair、port conflict、Approval／Audit／crash recovery、update失敗rollback、中断update復旧・再開、通常Uninstall後の合成state保持、再導入、明示PurgeまでPASSした。installer SHA-256=`d1fd47962e4df1dc8abf459990627821ae41034c796eeedfa7936a8bfa9caec3`。この過去runは今回のheadless-shell変更より前の限定hosted BUILD証拠であり、current packageの証明にはしない。2026-11-14、source SHA=`8f09f9c6f752c375f6547e087bc6b49a7978e21f`に対する手動workflow_dispatch [run #16](https://github.com/gatchimuchio/BLUE-TANUKI/actions/runs/43483838295)は、Ubuntu 24.04 x64とmacOS 15 x64／arm64 hosted runnerでnative package生成およびinstaller verifierをPASSした。各OSのinstalled lifecycle 2 stepはすべてskip、Actions artifactは保存されず、package成果物はrunner上のみであった。したがってこれはpackage-only BUILD証拠であり、installed製品、runtime、UI、復旧・削除、署名・notarization、OS対応完成を証明しない。runnerではLinux isolationに必要な構成要素（provider／bubblewrap／systemd user manager／cgroup limits）のいずれかが利用できず、`shell.exec`は無効・fail-closed。複数distribution、OS login／reboot、実system service／Secret Service、owner実機、実provider／credential、製品全体BUILD_COVERED／QC／QAは未確認のままで、全体BUILD_COVERED後に対象hostごとに評価する。

## Mobileの構造と安全

AndroidとiOSは一括した「モバイル対応」ではなく、独立した製品要求として管理する。画像・音声入力を扱うF16は共通媒体の責務であって、Android/iOSの製品完成ではない。[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)が指す非公開QE正本の実装索引ではAndroid=G09、iOS=G10。旧G05・G06は別のQC親成果であり上書きしない。

D4Pocket（旧GUI-Shell）は予定するMobile/OS Broker外殻であり、その既存契約を利用する。招待・端末資格・TLSの秘密情報はAndroid/iOS native層で扱い、Dartやplatform-channelの戻り値、アプリログ、監査投影へ露出しない。Mobile画面やC／J／Mの提案から権限を生成せず、Desktop Broker側の現在Permission・対象・Ownerの必要承認を独立に満たす。

MobileクライアントがDesktop Brokerへ安全に接続する能力と、Mobile端末だけでC/J/Mの自律動作を行う能力は別である。後者はこの文書だけで自動的に搭載済み・QC済みとしない。背景制約・通信断・アプリ強制終了・OS権限失効時は、二重実行・無断再送・架空成功なしに現在状態を復元または明示保留する。

OSの最小サポート版、CPU arch、配布方式・ストア要件は、実際の契約・対象端末・配布先が確定してから固める。未確認の版数や配布実績を作らない。D4Pocket側の別repo変更はownerによる対象・path・復元の限定委任が必要である。

## QEの完成と公開

QE_BUILDで5OSすべての必要consumerを一括施工でつなぎ、BUILD_COVEREDに到達してから全体QE_QCで実物を調べる。QCで検出した欠陥は設計と実装へ還流する。各OSのQE_QAは当該OSの版・機能・環境忠実度・証拠範囲だけを保証し、別OSの合格で代替しない。仮想環境で再現できない物理条件は必要な場合だけ個別にHOLDする。

旧v1.0 RCはP13=PENDING_OWNER_GO、public_claim_allowed=false。旧RCのMobile未搭載は新5OS製品目標と矛盾しないが、新5OSへの構築着手・別repo変更・製品公開をこの文書の存在から許可しない。
