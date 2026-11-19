import AppKit
import CryptoKit
import Foundation

@main
private enum BlueTanukiAppMain {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = BlueTanukiAppDelegate()
        application.delegate = delegate
        application.run()
    }
}

private final class BlueTanukiAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var detailLabel: NSTextField!
    private var actionButtons: [NSButton] = []
    private var operationInProgress = false

    private let fileManager = FileManager.default
    private var home: URL { fileManager.homeDirectoryForCurrentUser }
    private var installRoot: URL {
        home.appendingPathComponent("Library/Application Support/BlueTanuki/app", isDirectory: true)
    }
    private var dataRoot: URL {
        home.appendingPathComponent("Library/Application Support/BlueTanuki", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        operationInProgress ? .terminateCancel : .terminateNow
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        !operationInProgress
    }

    @objc private func installOrUpdate() {
        guard let installer = resource("BlueTanukiSetup.command"),
              let sidecar = resource("BlueTanukiSetup.command.sha256") else {
            setStatus("インストーラーが見つかりません。", detail: "このアプリの配布物を確認してください。")
            return
        }

        let isInstalled = fileManager.fileExists(atPath: installRoot.path)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = isInstalled ? "BLUE-TANUKIを更新しますか？" : "BLUE-TANUKIをインストールしますか？"
        alert.informativeText = isInstalled
            ? "この配布物の製品data-schemaが現在の設定と一致し、現在版より新しい場合だけ更新します。常駐を停止し、既存の設定とユーザーデータを保持します。"
            : "製品を現在のユーザーへインストールします。設定とユーザーデータは既定で保持されます。"
        alert.addButton(withTitle: "キャンセル")
        alert.addButton(withTitle: isInstalled ? "更新" : "インストール")
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        beginOperation(isInstalled ? "更新しています。" : "インストールしています。", detail: "完了するまでアプリを終了できません。") {
            try self.verifyInstaller(installer, sidecar: sidecar)
            let arguments = isInstalled ? ["--no-launch", "--update"] : ["--no-launch"]
            try self.runShell(installer, arguments: arguments)
        } completion: { result in
            switch result {
            case .success:
                self.setStatus(isInstalled ? "更新処理が完了しました。" : "インストール処理が完了しました。", detail: "「コントロールセンターを開く」を選ぶと製品を起動します。")
            case .failure(let error):
                self.showFailure(isInstalled ? "更新" : "インストール", error: error)
            }
        }
    }

    @objc private func rollbackProduct() {
        guard let installer = resource("BlueTanukiSetup.command"),
              let sidecar = resource("BlueTanukiSetup.command.sha256") else {
            setStatus("インストーラーが見つかりません。", detail: "このアプリの配布物を確認してください。")
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "前のBLUE-TANUKIへ戻しますか？"
        alert.informativeText = "保持されている前版と現在版のdata-schemaが一致し、両方の管理対象treeを検証できた場合だけ戻します。常駐を停止し、設定とユーザーデータは変更しません。"
        alert.addButton(withTitle: "キャンセル")
        alert.addButton(withTitle: "前の版へ戻す")
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        beginOperation("前の版へ戻しています。", detail: "保持版と現在版を検証し、完了するまでアプリを終了できません。") {
            try self.verifyInstaller(installer, sidecar: sidecar)
            try self.runShell(installer, arguments: ["--no-launch", "--rollback"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("rollbackが完了しました。", detail: "「コントロールセンターを開く」を選ぶと製品を起動します。")
            case .failure(let error):
                self.showFailure("前の版へのrollback", error: error)
            }
        }
    }

    @objc private func openControlCenter() {
        beginOperation("インストール状態を確認しています。", detail: "既存データを変更せず、所有マーカーと管理対象を照合します。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            try self.runShell(launcher, arguments: ["resident-start"])
            try self.runShell(launcher, arguments: ["resident-open"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("起動コマンドが完了しました。", detail: "実際の稼働状態は、開いたコントロールセンターとローカル状態で確認してください。")
            case .failure(let error):
                self.showFailure("起動", error: error)
            }
        }
    }

    @objc private func stopProduct() {
        beginOperation("インストール状態を確認しています。", detail: "所有マーカーを確認してから常駐プロセスへ停止を依頼します。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            try self.runShell(launcher, arguments: ["resident-stop"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("停止コマンドが完了しました。", detail: "サービス状態は「起動」を選ぶか、ログで確認してください。")
            case .failure(let error):
                self.showFailure("停止", error: error)
            }
        }
    }

    @objc private func checkProductStatus() {
        beginOperation("インストール状態を確認しています。", detail: "管理対象の常駐プロセスだけを読み取り確認します。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            let (data, _) = try self.runShell(launcher, arguments: ["resident-status"], captureOutput: true)
            guard let output = String(data: data, encoding: .utf8) else {
                throw AppError.invalidResidentStatus
            }
            let lines = output.split(whereSeparator: { $0.isNewline }).map(String.init)
            let statusLine = lines.first
            let healthLine = lines.first(where: { $0.hasPrefix("resident_health=") })
            if statusLine == "resident_status=stopped" {
                return ResidentProductStatus.stopped
            }
            if let statusLine,
               statusLine.hasPrefix("resident_status=running pid="),
               let pid = Int(statusLine.dropFirst("resident_status=running pid=".count)),
               pid >= 2,
               pid <= 2_147_483_647 {
                if healthLine == "resident_health=ready" {
                    return ResidentProductStatus.running
                }
                if healthLine == "resident_health=not_ready" {
                    return ResidentProductStatus.runningNotReady
                }
                if healthLine == "resident_health=unobserved_non_loopback_binding" {
                    return ResidentProductStatus.runningHealthUnobserved
                }
                throw AppError.invalidResidentStatus
            }
            if let statusLine,
               statusLine.hasPrefix("resident_status=starting watchdog_pid="),
               let pid = Int(statusLine.dropFirst("resident_status=starting watchdog_pid=".count)),
               pid >= 2,
               pid <= 2_147_483_647 {
                return ResidentProductStatus.starting
            }
            throw AppError.invalidResidentStatus
        } completion: { result in
            switch result {
            case .success(.running):
                self.setStatus("Gatewayのヘルス応答を確認しました。", detail: "これはローカルのhealthz応答です。実際のSafe Mode、接続、schedule状態はコントロールセンターで確認してください。")
            case .success(.runningNotReady):
                self.setStatus("Gatewayプロセスは稼働中ですが、healthz応答を確認できません。", detail: "プロセスは自動停止・再起動していません。ログとDoctorを確認してから再操作してください。")
            case .success(.runningHealthUnobserved):
                self.setStatus("Gatewayプロセスは稼働中です。", detail: "WEBCHAT_HOSTがloopback以外のため、この画面ではhealthzを確認していません。実際の応答は接続先のControl Centerで確認してください。")
            case .success(.starting):
                self.setStatus("Gatewayを起動中です。", detail: "起動完了後の実際の稼働状態はコントロールセンターで確認してください。")
            case .success(.stopped):
                self.setStatus("Gatewayは停止中です。", detail: "保存済みの設定とscheduleは変更していません。起動するには「コントロールセンターを開く」を選んでください。")
            case .failure(let error):
                self.showFailure("稼働状態の確認", error: error)
            }
        }
    }

    @objc private func inspectRecovery() {
        beginOperation("復旧状態を確認しています。", detail: "保存済みの台帳と復旧保護の状態を読み取ります。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            let (data, exitCode) = try self.runShell(
                launcher, arguments: ["recovery-inspect", "--json"], captureOutput: true, accepting: [0, 2]
            )
            guard let report = try? JSONDecoder().decode(RecoveryDiagnostic.self, from: data),
                  report.schema_version == 11, report.surface == "recovery_inspection", report.mode == "read_only",
                  !report.used_for_authority, !report.may_execute,
                  exitCode == (report.status == .verified && report.runtime_recovery_fence.status == .clear ? 0 : 2) else {
                throw AppError.invalidRecoveryDiagnostic
            }
            return report
        } completion: { result in
            switch result {
            case .success(let report):
                switch report.runtime_recovery_fence.status {
                case .pending:
                    guard let evidence = report.runtime_recovery_fence.pendingEvidence else {
                        self.setStatus("初期化結果の照合が保留中です。", detail: "事前バックアップの識別情報を確認できません。現在のデータを保持してください。")
                        return
                    }
                    self.setStatus("初期化結果の照合が保留中です。", detail: "事前バックアップの識別情報を確認しました。")
                    self.confirmRecoveryReconciliation(evidence)
                case .unavailable:
                    self.setStatus("復旧保護の状態を確認できません。", detail: "データを保持し、ログと復旧手順を確認してください。")
                case .clear where report.status == .residuals_present:
                    self.setStatus("台帳に未照合項目があります。", detail: "データを保持し、確認済みのバックアップと照合してください。")
                case .clear:
                    self.setStatus("台帳の読み取り検査が完了しました。", detail: "復元の可否とGatewayの稼働状態は別途確認してください。")
                }
            case .failure(let error):
                self.showFailure("復旧診断", error: error)
            }
        }
    }

    private func confirmRecoveryReconciliation(_ evidence: RecoveryDiagnostic.PendingEvidence) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "中断した初期化の結果を照合しますか？"
        alert.informativeText = "Gatewayが停止している場合に、診断で確認した事前バックアップと現在の状態を照合します。初期化前か予定どおりの初期化後に一致した場合のみ起動保留を解除します。運転再開は別の操作です。"
        alert.addButton(withTitle: "閉じる")
        alert.addButton(withTitle: "照合する")
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        beginOperation("初期化結果を照合しています。", detail: "診断で確認した事前バックアップを使用します。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            let (data, exitCode) = try self.runShell(
                launcher, arguments: [
                    "recovery-reconcile", "--backup-id", evidence.backupID,
                    "--manifest-sha256", evidence.manifestSHA256, "--json",
                ], captureOutput: true, accepting: [0, 2]
            )
            guard let report = try? JSONDecoder().decode(RecoveryReconciliation.self, from: data),
                  !report.used_for_authority, exitCode == report.status.expectedExitCode else {
                throw AppError.invalidRecoveryReconciliation
            }
            return report.status
        } completion: { result in
            switch result {
            case .success(.pre_action_state_matched):
                self.setStatus("初期化前の状態と一致しました。", detail: "照合結果を記録し、起動保留を解除しました。")
            case .success(.postconditions_matched):
                self.setStatus("予定どおりの初期化後の状態と一致しました。", detail: "照合結果を記録し、起動保留を解除しました。")
            case .success(.no_pending):
                self.setStatus("現在、照合保留はありません。", detail: "復旧診断から最新の台帳と復旧保護の状態を確認できます。")
            case .success(.unresolved):
                self.setStatus("初期化結果を照合できませんでした。", detail: "現在のデータを保持し、復旧診断で状態を確認してください。")
            case .success(.invalid_arguments), .success(.configuration_unavailable):
                self.setStatus("初期化結果の照合を開始できませんでした。", detail: "現在のデータを保持し、復旧診断で状態を確認してください。")
            case .failure(let error):
                self.showFailure("初期化結果の照合", error: error)
            }
        }
    }

    @objc private func restartNormally() {
        beginOperation("通常モードで再起動しています。", detail: "Safe Modeのプロセスを停止し、保存済みの設定からGatewayを起動します。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            try self.runShell(launcher, arguments: ["restart"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("通常モードへの再起動が完了しました。", detail: "実際の稼働状態とscheduleはコントロールセンターで確認してください。")
            case .failure(let error):
                self.showFailure("通常モードへの再起動", error: error)
            }
        }
    }

    @objc private func startSafeMode() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Safe Modeで起動しますか？"
        alert.informativeText = "常駐Gatewayを停止してSafe Modeで再起動します。実行中の仕事は中断される場合があります。LLM provider・外部connectorとruntime scheduleは停止し、保存済みの設定・scheduleは変更しません。通常モードへ戻すには「通常モードで再起動」を選んでください。"
        alert.addButton(withTitle: "キャンセル")
        alert.addButton(withTitle: "Safe Modeで起動")
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        beginOperation("Safe Modeで再起動しています。", detail: "保存済みの設定・scheduleは変更しません。") {
            try self.validateInstalledProduct()
            let launcher = self.installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
            try self.runShell(launcher, arguments: ["safe-mode"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("Safe Modeで起動しました。", detail: "LLM provider・外部connectorは停止し、runtime scheduleは一時停止しています。通常モードへ戻すには「通常モードで再起動」を選んでください。")
            case .failure(let error):
                self.showFailure("Safe Modeへの切替", error: error)
            }
        }
    }

    @objc private func uninstallProduct() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "BLUE-TANUKIをアンインストールしますか？"
        alert.informativeText = "管理対象のアプリ本体・同梱ランタイム・ランチャーを削除します。設定とユーザーデータは保持されます。Purgeは実行しません。この.appはApplicationsフォルダーに残ります。"
        alert.addButton(withTitle: "キャンセル")
        alert.addButton(withTitle: "アンインストール")
        guard alert.runModal() == .alertSecondButtonReturn else { return }

        beginOperation("アンインストールしています。", detail: "所有・内容を検証し、既定の非Purgeアンインストーラーを実行します。") {
            let uninstaller = self.installRoot.appendingPathComponent("BlueTanukiUninstall.sh")
            try self.runShell(uninstaller, arguments: [])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("アンインストール処理が完了しました。", detail: "設定とユーザーデータは保持されました。この.appはApplicationsフォルダーに残っています。")
            case .failure(let error):
                self.showFailure("アンインストール", error: error)
            }
        }
    }

    @objc private func showLogs() {
        let logDirectory = dataRoot.appendingPathComponent("logs", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: logDirectory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            setStatus("ログフォルダーがありません。", detail: "製品をインストールして起動すると、必要なログが作成されます。")
            return
        }
        NSWorkspace.shared.open(logDirectory)
        setStatus("ログフォルダーをFinderで開きました。", detail: "ログには秘密情報が含まれないように設計されています。共有前に内容を確認してください。")
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 505),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BLUE-TANUKI"
        window.delegate = self
        window.isReleasedWhenClosed = false

        let title = NSTextField(labelWithString: "BLUE-TANUKI")
        title.font = .systemFont(ofSize: 27, weight: .semibold)

        let subtitle = NSTextField(wrappingLabelWithString: "ローカルで動作する製品アプリです。インストール、状態確認、起動、停止、アンインストールをここから行えます。")
        subtitle.font = .systemFont(ofSize: 13)
        subtitle.textColor = .secondaryLabelColor

        statusLabel = NSTextField(wrappingLabelWithString: "「稼働状態を確認」を選ぶと、管理対象Gatewayの状態を表示します。")
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)

        detailLabel = NSTextField(wrappingLabelWithString: "初回は「インストールまたは更新」を選んでください。自動起動やPurgeは行いません。")
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor

        let firstRow = NSStackView(views: [
            makeButton("インストールまたは更新", action: #selector(installOrUpdate)),
            makeButton("前の版へ戻す…", action: #selector(rollbackProduct)),
            makeButton("コントロールセンターを開く", action: #selector(openControlCenter)),
        ])
        firstRow.orientation = .horizontal
        firstRow.alignment = .centerY
        firstRow.distribution = .fillEqually
        firstRow.spacing = 10

        let secondRow = NSStackView(views: [
            makeButton("Safe Modeで起動", action: #selector(startSafeMode)),
            makeButton("通常モードで再起動", action: #selector(restartNormally)),
            makeButton("停止", action: #selector(stopProduct)),
        ])
        secondRow.orientation = .horizontal
        secondRow.alignment = .centerY
        secondRow.distribution = .fillEqually
        secondRow.spacing = 10

        let thirdRow = NSStackView(views: [
            makeButton("稼働状態を確認", action: #selector(checkProductStatus)),
            makeButton("復旧診断", action: #selector(inspectRecovery)),
            makeButton("ログを表示", action: #selector(showLogs)),
        ])
        thirdRow.orientation = .horizontal
        thirdRow.alignment = .centerY
        thirdRow.distribution = .fillEqually
        thirdRow.spacing = 10

        let footer = NSTextField(wrappingLabelWithString: "配布状態: 署名なし・公証未提出。署名・公証済みの製品リリースではありません。")
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor

        let uninstallButton = makeButton("アンインストール…", action: #selector(uninstallProduct))
        let stack = NSStackView(views: [title, subtitle, statusLabel, detailLabel, firstRow, secondRow, thirdRow, uninstallButton, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        window.contentView = NSView()
        window.contentView?.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -26),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -24),
            firstRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            secondRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            thirdRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            firstRow.heightAnchor.constraint(equalToConstant: 36),
            secondRow.heightAnchor.constraint(equalToConstant: 36),
            thirdRow.heightAnchor.constraint(equalToConstant: 36),
        ])

        self.window = window
    }

    private func makeButton(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        actionButtons.append(button)
        return button
    }

    private func resource(_ name: String) -> URL? {
        Bundle.main.resourceURL?.appendingPathComponent(name, isDirectory: false)
    }

    private func verifyInstaller(_ installer: URL, sidecar: URL) throws {
        let attributes = try fileManager.attributesOfItem(atPath: installer.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw AppError.invalidInstaller
        }
        let sidecarText = try String(contentsOf: sidecar, encoding: .utf8)
        let fields = sidecarText.split(whereSeparator: { $0.isWhitespace })
        guard fields.count >= 2,
              fields[0].count == 64,
              fields[0].allSatisfy({ $0.isHexDigit }),
              String(fields[1]) == installer.lastPathComponent else {
            throw AppError.invalidInstaller
        }
        let expected = fields[0].lowercased()
        var hasher = SHA256()
        let handle = try FileHandle(forReadingFrom: installer)
        defer { try? handle.close() }
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { throw AppError.invalidInstaller }
    }

    private func validateInstalledProduct() throws {
        let uninstaller = installRoot.appendingPathComponent("BlueTanukiUninstall.sh")
        let launcher = installRoot.appendingPathComponent("BlueTanukiLauncher.sh")
        guard fileManager.fileExists(atPath: uninstaller.path),
              fileManager.fileExists(atPath: launcher.path) else {
            throw AppError.notInstalled
        }
        try runShell(uninstaller, arguments: ["--dry-run", "--quiet"])
    }

    @discardableResult
    private func runShell(
        _ script: URL, arguments: [String], captureOutput: Bool = false, accepting acceptedExitCodes: Set<Int32> = [0]
    ) throws -> (Data, Int32) {
        guard fileManager.fileExists(atPath: script.path) else { throw AppError.missingComponent }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [script.path] + arguments
        process.currentDirectoryURL = script.deletingLastPathComponent()
        let user = NSUserName()
        process.environment = [
            "HOME": home.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "USER": user,
            "LOGNAME": user,
        ]
        process.standardInput = FileHandle.nullDevice
        let output = captureOutput ? Pipe() : nil
        if let output = output {
            process.standardOutput = output
        } else {
            process.standardOutput = FileHandle.nullDevice
        }
        process.standardError = FileHandle.nullDevice
        try process.run()
        var captured = Data()
        var oversized = false
        if let output = output {
            do {
                while let bytes = try output.fileHandleForReading.read(upToCount: 8192), !bytes.isEmpty {
                    if oversized || captured.count + bytes.count > 1_048_576 {
                        oversized = true
                    } else {
                        captured.append(bytes)
                    }
                }
            } catch {
                if process.isRunning { process.terminate() }
                process.waitUntilExit()
                throw error
            }
        }
        process.waitUntilExit()
        guard process.terminationReason == .exit, acceptedExitCodes.contains(process.terminationStatus) else {
            throw AppError.commandFailed(process.terminationStatus)
        }
        guard !oversized else { throw AppError.commandOutputTooLarge }
        return (captured, process.terminationStatus)
    }

    private func beginOperation<Output>(
        _ status: String,
        detail: String,
        operation: @escaping () throws -> Output,
        completion: @escaping (Result<Output, Error>) -> Void
    ) {
        guard !operationInProgress else { return }
        operationInProgress = true
        actionButtons.forEach { $0.isEnabled = false }
        setStatus(status, detail: detail)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try operation() }
            DispatchQueue.main.async {
                self.operationInProgress = false
                self.actionButtons.forEach { $0.isEnabled = true }
                completion(result)
            }
        }
    }

    private func showFailure(_ action: String, error: Error) {
        let reason: String
        if case AppError.commandFailed(let status) = error {
            reason = "終了コード \(status)"
        } else if let appError = error as? AppError {
            reason = appError.description
        } else {
            reason = "必要なファイルを読み取れませんでした"
        }
        setStatus("\(action)を完了できませんでした。", detail: "\(reason)。自動再試行はしていません。既存状態とログを確認してから再操作してください。")
    }

    private func setStatus(_ status: String, detail: String) {
        statusLabel.stringValue = status
        detailLabel.stringValue = detail
    }
}

private enum AppError: Error, CustomStringConvertible {
    case invalidInstaller
    case invalidResidentStatus
    case invalidRecoveryDiagnostic
    case invalidRecoveryReconciliation
    case commandOutputTooLarge
    case missingComponent
    case notInstalled
    case commandFailed(Int32)

    var description: String {
        switch self {
        case .invalidInstaller: return "同梱インストーラーの完全性を確認できません"
        case .invalidResidentStatus: return "常駐プロセスの状態応答を確認できません"
        case .invalidRecoveryDiagnostic: return "復旧診断の応答を確認できません"
        case .invalidRecoveryReconciliation: return "初期化結果の照合応答を確認できません"
        case .commandOutputTooLarge: return "診断出力が画面で確認できる上限を超えました"
        case .missingComponent: return "必要な製品ファイルが見つかりません"
        case .notInstalled: return "製品が未インストールか、管理ファイルがありません"
        case .commandFailed: return "管理処理が正常終了しませんでした"
        }
    }
}

private struct RecoveryDiagnostic: Decodable {
    enum Status: String, Decodable { case verified, residuals_present }
    struct PendingEvidence {
        let backupID: String
        let manifestSHA256: String
    }

    struct Fence: Decodable {
        enum Status: String, Decodable { case clear, pending, unavailable }
        let status: Status
        let operation: String?
        let backup_id: String?
        let manifest_sha256: String?

        var pendingEvidence: PendingEvidence? {
            guard status == .pending, operation == "recovery.factory_reset",
                  let backupID = backup_id,
                  backupID.range(of: #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.pre_factory_reset\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z"#, options: .regularExpression) != nil,
                  let manifestSHA256 = manifest_sha256,
                  manifestSHA256.range(of: #"\A[a-f0-9]{64}\z"#, options: .regularExpression) != nil else { return nil }
            return PendingEvidence(backupID: backupID, manifestSHA256: manifestSHA256)
        }
    }

    let schema_version: Int
    let surface: String
    let mode: String
    let status: Status
    let runtime_recovery_fence: Fence
    let used_for_authority: Bool
    let may_execute: Bool
}

private struct RecoveryReconciliation: Decodable {
    enum Status: String, Decodable {
        case pre_action_state_matched, postconditions_matched, no_pending
        case unresolved, invalid_arguments, configuration_unavailable

        var expectedExitCode: Int32 {
            switch self {
            case .pre_action_state_matched, .postconditions_matched, .no_pending: return 0
            case .unresolved, .invalid_arguments, .configuration_unavailable: return 2
            }
        }
    }

    let status: Status
    let used_for_authority: Bool
}

private enum ResidentProductStatus {
    case running
    case runningNotReady
    case runningHealthUnobserved
    case starting
    case stopped
}
