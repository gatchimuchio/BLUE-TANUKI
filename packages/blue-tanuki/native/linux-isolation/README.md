# Linux shell隔離helper

`blue-tanuki-linux-isolation`は、production adapterの`shell.exec`が使うLinux native providerである。許可されたcommand形状だけをBubblewrapのnamespaceと一時systemd user serviceの中で起動する。対象workspaceはread-only bind mountで`/workspace`へ渡し、その上にBubblewrapの一時overlayを重ねる。commandのworkspace書込みは隔離中だけ見え、終了時に破棄される。network namespaceも分離し、host loopbackと外部networkへの接続を防ぐ。

起動には`--tmp-overlay`を備えるBubblewrap 0.12以降、またはCVE-2026-87766修正済みのdistribution package（Ubuntu 26.04では`0.11.1-1ubuntu0.2`以降）が必要であり、setuid binaryは拒否する。稼働中のsystemd user managerと`cpu`・`memory`・`pids` controllerを持つcgroup v2も必要である。workspaceの一時overlayが実際にread-write `overlay` mountであることをcommand起動前に確認する。systemdが完了を返し、service cgroupが空であることを確認するまで通常結果を返さない。実行時間、CPU、memory（`MemoryMax=512M`）、swap（`MemorySwapMax=0`）、process数、出力、単一fileサイズを制限し、`/tmp`は64 MiB tmpfsとする。workspace overlayのtmpfs書込みは同じ512 MiB memory上限を共有し、独立した追加容量ではない。command環境は小さなallowlistから構成し、Gatewayのcredentialを継承しない。shell root内の通常fileはhard linkを拒否し、root外のinodeを共有するfileの読取・変更を防ぐ。

中止要求時はsystemd unitの停止を依頼し、helperはunitの終了とservice cgroupの空を確認してから応答する。TypeScript側はLinux helperだけを強制終了してunitから切り離さず、停止確認を待つ。systemd unitには要求ごとの`RuntimeMaxSec`が設定され、最大実行時間後も結果が確認できなければ状態不明として扱う。

一時overlayまたはswap上限を確認できないLinux profileでは対象commandを起動せず、read-write host bindへfallbackしない。workspaceへの永続変更は`shell.exec`では行わず、既存の`file.write`／`file.edit`操作へ分ける。overlayの書込み領域は一時tmpfsで、service cgroupのmemory上限とswap禁止に拘束されるため、複数file書込みがhost diskを消費しない。容量はcommand本体のmemory使用と共有され、制限到達時はcommandが失敗し得る。これはLinux provider内の一時workspace保護であり、他OSの隔離成立やD07.02全体の完了を意味しない。

既存Linux providerのruntime確認は過去にWSL2で行った。今回追加した一時overlay経路はnative Linuxで未実行であり、その成立は未確認である。WSL2の結果をnative Linuxと同一視しない。手動GitHub Actionsによるhosted Ubuntuのbuildとfocused testも補助証拠に限定し、installed Linux製品、native実機QA、release readinessを示すものではない。

実装が依存するBubblewrap optionは[upstreamのBubblewrap manual](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)、tmpfsを含むmemory accountingとswap上限は[Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)に従う。
