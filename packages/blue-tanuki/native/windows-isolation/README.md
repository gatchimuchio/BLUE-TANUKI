# Windowsシェル隔離provider

`blue-tanuki-windows-isolation`は、`shell.exec`が使うWindows専用のnative helperである。ネットワークcapabilityを持たないAppContainerで対象commandを起動し、Job Objectへ割り当ててから実行を再開する。Jobのprocess数とmemory、実行時間、標準出力・標準エラーの上限を設定し、結果を返す前にJobが空であることを確認する。

helperは、1回の呼出し中だけAppContainer SIDに`BLUE_TANUKI_SHELL_ROOT`のread/write/execute accessを与え、Jobが空になった後で権限を戻す。root配下にsecret-likeなpath componentまたはreparse pointがあれば拒否する。親からhelperへ渡す環境変数は`PATH`、`SystemRoot`、root内を指すtemporary/home pathに限り、対象commandにはその縮小済み環境を渡す。

Rust `1.95.0-x86_64-pc-windows-msvc`と固定`Cargo.lock`からWindows上でbuildし、`pnpm --filter @blue-tanuki/core build`が成果物を`dist/native`へコピーする。他OSではbuildも有効化もしない。ACL復元またはprocess tree終了を確認できないとき、helperは成功結果を返さない。

AppContainer profileは`BlueTanukiShellExecWindowsV1`というWindows user単位のprofileであり、アプリ終了後もWindows側に残る。通常の取消経路外でhelperを強制終了すると、rootにAppContainer SIDのACEが残る可能性がある。次回helper呼出しは終了時にそのACEを削除する。このproviderはreleaseや5OS完成を示さない。
