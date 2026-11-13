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

        beginOperation("インストールまたは更新を実行しています。", detail: "完了するまでアプリを終了できません。") {
            try self.verifyInstaller(installer, sidecar: sidecar)
            try self.runShell(installer, arguments: ["--no-launch"])
        } completion: { result in
            switch result {
            case .success:
                self.setStatus("インストール処理が完了しました。", detail: "「コントロールセンターを開く」を選ぶと製品を起動します。")
            case .failure(let error):
                self.showFailure("インストール処理", error: error)
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
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 390),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BLUE-TANUKI"
        window.delegate = self
        window.isReleasedWhenClosed = false

        let title = NSTextField(labelWithString: "BLUE-TANUKI")
        title.font = .systemFont(ofSize: 27, weight: .semibold)

        let subtitle = NSTextField(wrappingLabelWithString: "ローカルで動作する製品アプリです。インストール、起動、停止、アンインストールをここから行えます。")
        subtitle.font = .systemFont(ofSize: 13)
        subtitle.textColor = .secondaryLabelColor

        statusLabel = NSTextField(wrappingLabelWithString: "インストール状態は、起動・停止の操作時に検証します。")
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)

        detailLabel = NSTextField(wrappingLabelWithString: "初回は「インストールまたは更新」を選んでください。自動起動やPurgeは行いません。")
        detailLabel.font = .systemFont(ofSize: 12)
        detailLabel.textColor = .secondaryLabelColor

        let firstRow = NSStackView(views: [
            makeButton("インストールまたは更新", action: #selector(installOrUpdate)),
            makeButton("コントロールセンターを開く", action: #selector(openControlCenter)),
        ])
        firstRow.orientation = .horizontal
        firstRow.alignment = .centerY
        firstRow.distribution = .fillEqually
        firstRow.spacing = 10

        let secondRow = NSStackView(views: [
            makeButton("停止", action: #selector(stopProduct)),
            makeButton("ログを表示", action: #selector(showLogs)),
            makeButton("アンインストール…", action: #selector(uninstallProduct)),
        ])
        secondRow.orientation = .horizontal
        secondRow.alignment = .centerY
        secondRow.distribution = .fillEqually
        secondRow.spacing = 10

        let footer = NSTextField(wrappingLabelWithString: "配布状態: 署名なし・公証未提出。署名・公証済みの製品リリースではありません。")
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [title, subtitle, statusLabel, detailLabel, firstRow, secondRow, footer])
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
            firstRow.heightAnchor.constraint(equalToConstant: 36),
            secondRow.heightAnchor.constraint(equalToConstant: 36),
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

    private func runShell(_ script: URL, arguments: [String]) throws {
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
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw AppError.commandFailed(process.terminationStatus)
        }
    }

    private func beginOperation(
        _ status: String,
        detail: String,
        operation: @escaping () throws -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
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
    case missingComponent
    case notInstalled
    case commandFailed(Int32)

    var description: String {
        switch self {
        case .invalidInstaller: return "同梱インストーラーの完全性を確認できません"
        case .missingComponent: return "必要な製品ファイルが見つかりません"
        case .notInstalled: return "製品が未インストールか、管理ファイルがありません"
        case .commandFailed: return "管理処理が正常終了しませんでした"
        }
    }
}
