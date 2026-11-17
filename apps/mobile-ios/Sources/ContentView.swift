import SwiftUI
import UIKit

struct ContentView: View {
  @ObservedObject var model: DeviceLinkViewModel
  @Environment(\.scenePhase) private var scenePhase
  @State private var invitation = ""
  @State private var confirmDisconnect = false
  @State private var confirmLocalDelete = false
  @State private var copied = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("BLUE-TANUKI")
            .font(.largeTitle.bold())
          Text("iOSネイティブ Device Link")
            .font(.title3)
          Text(model.message)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityIdentifier("device-link-status")

          GroupBox("この端末") {
            VStack(alignment: .leading, spacing: 8) {
              Text("Device ID")
                .font(.caption)
                .foregroundStyle(.secondary)
              Text(model.deviceID.isEmpty ? "準備中" : model.deviceID)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .accessibilityIdentifier("device-link-device-id")
              Button(copied ? "コピーしました" : "Device IDをコピー") {
                UIPasteboard.general.string = model.deviceID
                copied = true
              }
              .disabled(model.deviceID.isEmpty || model.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }

          if let preview = model.hostPreview {
            GroupBox("送信前の接続先確認") {
              VStack(alignment: .leading, spacing: 8) {
                if model.recoveryAuditCount > 0 {
                  Text("以前の端末内資格を削除した記録があります。Desktop側の失効は未確認です。ownerに状態を確認してください。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
                LabeledContent("Host ID", value: preview.hostID)
                LabeledContent("接続先", value: "\(preview.host):\(preview.port)")
                LabeledContent(
                  "招待期限",
                  value: Date(timeIntervalSince1970: Double(preview.expiresAt)).formatted()
                )
                Text("証明書SHA-256")
                  .font(.caption)
                  .foregroundStyle(.secondary)
                Text(preview.certificateHash)
                  .font(.system(.footnote, design: .monospaced))
                  .textSelection(.enabled)
                Text("この値をDesktop ownerが表示した招待元と照合してから結合してください。")
                  .font(.footnote)
                Button("照合してDesktopへ結合要求を送る") {
                  model.confirmPairing()
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy)
                Button("取り消す", role: .cancel) {
                  model.cancelPairing()
                }
                .disabled(model.busy)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          } else if !model.paired {
            GroupBox("Desktop招待") {
              VStack(alignment: .leading, spacing: 10) {
                if model.recoveryAuditCount > 0 {
                  Text("以前の端末内資格を削除しました。Desktop側の失効が確認できるまで、ownerに状態を確認してください。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
                if model.reinstallReviewRequired {
                  Text("再インストールを検知しました。Desktop Agent Centerで旧端末の失効状態と以前のTask状態を確認してください。確認するまで招待の検証を止めています。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                  Button("Desktop側の旧端末状態を確認済み") {
                    model.acknowledgeReinstallReview()
                  }
                  .disabled(model.busy)
                }
                SecureField("招待JSON（1行）", text: $invitation)
                  .textContentType(.none)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .font(.system(.footnote, design: .monospaced))
                  .accessibilityIdentifier("device-link-invitation")
                  .disabled(model.busy || model.reinstallReviewRequired)
                Button("招待を検証して接続先を表示") {
                  var raw = invitation
                  invitation = ""
                  model.preparePairing(rawInvitation: &raw)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy || invitation.isEmpty || model.reinstallReviewRequired)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          } else {
            GroupBox("結合状態") {
              VStack(alignment: .leading, spacing: 10) {
                Label(
                  model.credentialExpired ? "資格期限切れ" : "端末資格をKeychainで保管中",
                  systemImage: model.credentialExpired ? "exclamationmark.triangle" : "key.fill"
                )
                Button("Desktop接続を明示確認") {
                  model.checkConnection()
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy || model.credentialExpired)
                Button("Desktopから端末結合を解除") {
                  confirmDisconnect = true
                }
                .disabled(model.busy || model.credentialExpired)
                Button("端末内資格だけを削除") {
                  confirmLocalDelete = true
                }
                .foregroundStyle(.red)
                .disabled(model.busy)
                Text("端末内回復記録: \(model.recoveryAuditCount)件。内容は権限に使いません。")
                  .font(.footnote)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }

          if model.paired {
            mobileTaskSection
          }

          GroupBox("権限と通信") {
            Text("この画面はBLUE Gatewayを直接呼び出さず、Owner承認・Permission・HDS判断を作りません。TLSと招待記載の証明書指紋を使い、結果不明の要求は自動再送しません。")
              .font(.footnote)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding()
      }
      .navigationTitle("BLUE-TANUKI")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Desktop側で資格を失効してから端末内資格を削除します。",
        isPresented: $confirmDisconnect,
        titleVisibility: .visible
      ) {
        Button("Desktopへ一度だけ解除要求を送る", role: .destructive) {
          model.disconnectFromDesktop()
        }
        Button("キャンセル", role: .cancel) {}
      }
      .confirmationDialog(
        "これは端末内資格だけを削除します。Desktop側の失効は確認しません。後でDesktop ownerへ失効を依頼してください。",
        isPresented: $confirmLocalDelete,
        titleVisibility: .visible
      ) {
        Button("端末内だけ削除", role: .destructive) {
          model.deleteCredentialLocally()
        }
        Button("キャンセル", role: .cancel) {}
      }
      .onChange(of: scenePhase) { phase in
        model.setForeground(phase == .active)
        if phase != .active {
          invitation = ""
          copied = false
        }
      }
      .overlay {
        if scenePhase != .active {
          Color.black.ignoresSafeArea()
        }
      }
    }
  }

  private var mobileTaskSection: some View {
    GroupBox("DesktopへのTask申請") {
      VStack(alignment: .leading, spacing: 10) {
        Text(model.taskMessage)
          .font(.footnote)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("mobile-task-status")

        HStack {
          Button("作業先を更新") { model.refreshTaskCatalog() }
            .disabled(model.busy || model.credentialExpired)
          Button("申請一覧を更新") { model.refreshOwnedTasks() }
            .disabled(model.busy || model.credentialExpired)
        }

        Button(model.taskNotificationsEnabled ? "Task状態通知を無効化" : "Task状態通知を有効化") {
          model.toggleTaskNotifications()
        }
        .disabled(model.busy)
        Text("有効時は、照会で前回観測済みTaskの状態変化を確認した場合だけ、本文を含まない端末通知を表示します。初回観測・未照会状態は通知せず、background通信やpush受信は行いません。")
          .font(.caption)

        if !model.runtimes.isEmpty {
          Picker("実行系", selection: runtimeSelection) {
            ForEach(model.runtimes, id: \.self) { runtime in
              Text(runtime).tag(runtime)
            }
          }
          .disabled(model.busy)
        }

        if matchingWorkspaces.isEmpty {
          Text("この実行系に登録Workspaceがありません。Desktopで登録してください。")
            .font(.footnote)
            .foregroundStyle(.secondary)
        } else {
          Picker("作業領域", selection: $model.selectedWorkspaceID) {
            ForEach(matchingWorkspaces) { workspace in
              Text(workspace.id).tag(workspace.id)
            }
          }
          .disabled(model.busy)
        }

        Button("MCP能力metadataを確認") { model.refreshMCPCapability() }
          .disabled(model.busy || model.credentialExpired)
        if let snapshot = model.mcpSnapshot {
          Text(snapshot.usable
            ? "Brokerが示した能力件数: \(snapshot.toolCount)（名前・接続先・schema・credentialは表示しません）"
            : "Brokerは現在MCP能力を利用できないと報告しました。")
            .font(.footnote)
        }
        Toggle("この能力snapshot hashを申請に含める", isOn: $model.includeMcpCapability)
          .disabled(model.busy || model.mcpSnapshot?.usable != true)

        TextEditor(text: $model.taskInstruction)
          .frame(minHeight: 120, maxHeight: 180)
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
          .accessibilityIdentifier("mobile-task-instruction")
        Text(taskInstructionCountLabel)
          .font(.caption)
          .foregroundStyle(taskInstructionWithinLimit ? Color.secondary : Color.red)
          .accessibilityIdentifier("mobile-task-instruction-count")
        Text("依頼はDesktop owner確認待ちとして送信されます。開始候補の実行時もBrokerが現在の権限と承認を再検査します。")
          .font(.footnote)
        Button("DesktopへTask申請") { model.submitTask() }
          .buttonStyle(.borderedProminent)
          .disabled(model.busy || model.credentialExpired || model.taskSubmissionNeedsReconciliation ||
                    matchingWorkspaces.isEmpty || !taskInstructionWithinLimit)
        if model.taskSubmissionNeedsReconciliation {
          Text("Keychainに申請sessionの照合記録があります。Desktopの申請一覧で同じsessionを確認するまで新規申請を停止しています。")
            .font(.footnote)
            .foregroundStyle(.orange)
        }

        if !model.tasks.isEmpty {
          Divider()
          ForEach(model.tasks) { task in
            taskRow(task)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var runtimeSelection: Binding<String> {
    Binding(
      get: { model.selectedRuntimeID },
      set: { model.selectRuntime($0) }
    )
  }

  private var matchingWorkspaces: [MobileTaskWorkspace] {
    model.workspaces.filter { $0.runtimeID == model.selectedRuntimeID }
  }

  private var taskInstructionScalarCount: Int {
    model.taskInstruction.unicodeScalars.count
  }

  private var taskInstructionWithinLimit: Bool {
    taskInstructionScalarCount <= MobileTaskContract.maximumInstructionUnicodeScalars
  }

  private var taskInstructionCountLabel: String {
    let count = taskInstructionScalarCount.formatted()
    let maximum = MobileTaskContract.maximumInstructionUnicodeScalars.formatted()
    return taskInstructionWithinLimit
      ? "依頼本文: \(count) / \(maximum) Unicode文字"
      : "依頼本文が上限を超えています: \(count) / \(maximum) Unicode文字"
  }

  private func taskRow(_ task: MobileTaskDraft) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("申請ID: \(task.id)")
        .font(.system(.footnote, design: .monospaced))
        .textSelection(.enabled)
      Text("依頼hash: \(task.instructionHash)")
        .font(.system(.caption2, design: .monospaced))
        .textSelection(.enabled)
      Text("期限: \(Date(timeIntervalSince1970: Double(task.expiresAt)).formatted())")
        .font(.caption)
      Text(taskStatusLabel(model.taskStatuses[task.id]))
        .font(.footnote)
      HStack {
        Button("状態を確認") { model.refreshTaskStatus(task) }
          .disabled(model.busy || model.credentialExpired)
        if case .startCandidate? = model.taskStatuses[task.id] {
          Button("開始要求") { model.startTask(task) }
            .disabled(model.busy || model.credentialExpired)
        }
        if case .task(let record)? = model.taskStatuses[task.id],
           ["pending", "running"].contains(record.state) {
          Button("取消要求") { model.cancelTask(task) }
            .disabled(model.busy || model.credentialExpired)
            .foregroundStyle(.red)
        }
      }
      if case .task(let record)? = model.taskStatuses[task.id] {
        Text("Task状態: \(record.state)・結果本文あり: \(record.resultContentAvailable ? "はい" : "いいえ")")
          .font(.caption)
        if let resultHash = record.resultHash {
          Text("結果hash: \(resultHash)")
            .font(.system(.caption2, design: .monospaced))
            .textSelection(.enabled)
        }
        Text("結果本文と監査識別子はMobileへ返しません。取消要求後もworker／外部処理の停止を推定しません。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 6)
  }

  private func taskStatusLabel(_ status: MobileTaskStatus?) -> String {
    guard let status else { return "状態未照会" }
    switch status {
    case .ownerReviewPending:
      return "Desktop owner確認待ち"
    case .startCandidate:
      return "開始候補。開始要求時にBrokerが現行条件を再検査します。"
    case .task(let record):
      return "Task状態: \(record.state)"
    }
  }
}
