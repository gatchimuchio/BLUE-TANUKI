# Linux shell隔離helper

`blue-tanuki-linux-isolation`は、production adapterの`shell.exec`が使うLinux native providerである。許可されたcommand形状だけをBubblewrapのnamespaceと一時systemd user serviceの中で起動する。対象commandには専用の書込み領域`/workspace`を渡し、hostのfilesystemはnamespaceへmountしない。network namespaceも分離し、host loopbackと外部networkへの接続を防ぐ。

起動にはBubblewrap、稼働中のsystemd user manager、`cpu`・`memory`・`pids` controllerを持つcgroup v2が必要である。systemdが完了を返し、service cgroupが空であることを確認するまで通常結果を返さない。実行時間、CPU、memory、process数、出力、単一fileサイズを制限し、`/tmp`は64 MiB上限のtmpfsとする。helperは起動前に`/usr/bin/bwrap --help`を確認し、`--size`を表示しないCLIでは`linux_bubblewrap_tmpfs_size_unsupported`でfail-closedする。Bubblewrap upstreamでは`--size`は[0.7.0から追加](https://github.com/containers/bubblewrap/releases/tag/v0.7.0)されている。command環境は小さなallowlistから構成し、Gatewayのcredentialを継承しない。shell root内の通常fileはhard linkを拒否し、root外のinodeを共有するfileの読取・変更を防ぐ。

workspaceはread-only lowerと、128 MiB・100,000 inode上限のtmpfs upper/workを使うOverlayFSとしてhelper内で構成する。commandにはoverlay化された`/workspace`だけを見せ、元rootへの反映はhelperが実行後にbaselineと最終treeを照合して行う。専用workspace全体はlogical size・allocated sizeの各1 GiB、100,000 entry、1回の反映file合計128 MiBを越えないよう検査する。これはコード上の制限であり、runtime成立を意味しない。

現在のhosted Linux runでは、Ubuntu 24.04でproduction OverlayFS mountが`EACCES`となり、Ubuntu 22.04のBubblewrap 0.6.1は`--size`未対応で検査がquota処理へ到達しなかった。従ってnative Linux上の実consumerにおけるaggregate quotaはまだ検証されておらず、D07.02全体の成立やrelease evidenceとは扱わない。WSL2のunit testやhosted runnerのbuildだけでnative Linux runtimeの証拠を代替しない。

実装中のruntime確認はWSL2で行った。WSL2の結果をnative Linuxと同一視しない。手動GitHub Actionsによるhosted Ubuntuのbuildとfocused testも補助証拠に限定し、installed Linux製品、native実機QA、release readinessを示すものではない。
