# Windowsのアンインストール

Windows installerは、現在のWindows userのアンインストール登録へBLUE-TANUKIを登録する。

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueTanuki
```

次のいずれかから実行できる。

- Windowsの「アプリ」またはコントロールパネル
- スタートメニューの「Uninstall BLUE-TANUKI」
- `%LOCALAPPDATA%\Programs\BlueTanuki\UninstallBlueTanuki.cmd`

## 通常のアンインストール

既定では、常駐runtimeを停止し、所有を確認できたスタートメニュー項目・任意のデスクトップ項目・アンインストール登録・導入済みapp filesを除去する。登録済みDataRootの内容は保持する。

既定のDataRootは次の場所である。Setup時に別のDataRootを指定した場合は、登録済みの場所を使う。

```text
%APPDATA%\BlueTanuki
```

Windows provider credentialはDPAPI CurrentUserで保護され、DataRoot内の`secrets`へ保存される。通常のアンインストールは、これらのcredential files、保存した本文と履歴、session、log、audit記録、環境設定、DataRootへ追加されたほかのfileを保持する。同じWindows userで再導入すると、残したcredentialを同じDPAPI保護境界で復号できる。

通常表示では、DataRootを保持することと、保持対象に秘密・履歴・audit記録が含まれることを削除前に表示する。`-Quiet`を指定した場合は計画表示を抑制する。

## DataRootの破棄

DataRootも除去する場合は、登録済みのuninstallerへ`-PurgeData`を渡す。

```powershell
%LOCALAPPDATA%\Programs\BlueTanuki\UninstallBlueTanuki.cmd -PurgeData
```

`-PurgeData`はDataRoot全体を完全削除し、ごみ箱は経由しない。DPAPI保護credential、保存本文、履歴、session、log、audit記録、環境設定、DataRootへ追加されたfileをすべて含む一括選択であり、category別の部分保持は行わない。通常表示では、破棄する範囲を削除前に表示する。全DataRootの除去を意図するときだけ指定する。

## 保護

uninstallerは、広いuser directory、filesystem root、または所有を確認できないpathを削除対象にしない。通常のアンインストールで秘密やaudit記録を黙って削除しない。Purge時はDataRootの所有・構造を検証し、検証できない場合はdataを保持して停止する。
