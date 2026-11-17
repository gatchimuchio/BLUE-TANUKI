import Combine
import Foundation

struct DeviceLinkHostPreview: Equatable {
  let hostID: String
  let host: String
  let port: Int
  let certificateHash: String
  let expiresAt: Int64
}

private struct MobileTaskCatalog {
  let runtimeIDs: [String]
  let workspaces: [MobileTaskWorkspace]
}

private struct MobileTaskListResult {
  let entries: [MobileTaskDraft]
  let pendingSessionID: String?
  let didReconcilePendingRequest: Bool
}

private struct MobileTaskCancellationResult {
  let status: MobileTaskStatus
  let requestSent: Bool
}

private final class DeviceLinkLifecycleGate {
  private let lock = NSLock()
  private var foreground = true
  private var generation: UInt64 = 0

  func setForeground(_ value: Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard foreground != value else { return false }
    foreground = value
    generation &+= 1
    return true
  }

  func capture() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return generation
  }

  func isForeground() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return foreground
  }

  func isCurrent(_ candidate: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return foreground && generation == candidate
  }
}

private final class DeviceLinkAttemptEvidence {
  var requestMayHaveReachedDesktop = false
  var responseReceived = false
  var remoteAccepted = false
  var taskSubmissionMayHaveReachedDesktop = false
  var taskSubmissionPendingRecorded = false
  var taskSubmissionPendingCleared = false
  var taskSessionID: String?
  var taskSessionCloseConfirmed = false
}

final class DeviceLinkViewModel: ObservableObject {
  @Published private(set) var deviceID = ""
  @Published private(set) var paired = false
  @Published private(set) var credentialExpired = false
  @Published private(set) var recoveryAuditCount = 0
  @Published private(set) var hostPreview: DeviceLinkHostPreview?
  @Published private(set) var busy = false
  @Published private(set) var message = "端末内状態を確認しています。"
  @Published private(set) var taskMessage = "Desktop Brokerから作業先を読み込んでください。"
  @Published private(set) var runtimes: [String] = []
  @Published private(set) var workspaces: [MobileTaskWorkspace] = []
  @Published private(set) var tasks: [MobileTaskDraft] = []
  @Published private(set) var taskStatuses: [String: MobileTaskStatus] = [:]
  @Published private(set) var mcpSnapshot: MobileMCPCapabilitySnapshot?
  @Published private(set) var taskSubmissionNeedsReconciliation = false
  @Published private(set) var reinstallReviewRequired = false
  @Published var selectedRuntimeID = ""
  @Published var selectedWorkspaceID = ""
  @Published var taskInstruction = ""
  @Published var includeMcpCapability = false

  private let store = DeviceLinkStore()
  private let transport = DeviceLinkTransport()
  private let lifecycle = DeviceLinkLifecycleGate()
  private var pendingInvitation: DeviceLinkCredential?
  private var pendingTaskSessionID: String?
  private var refreshOwnedTasksAfterForeground = false

  func loadLocalState() {
    guard !busy else { return }
    do {
      publish(try store.loadOrCreate())
      if paired {
        message = credentialExpired
          ? "端末資格の期限が切れています。自動接続・再送は行いません。"
          : "資格はこの端末のKeychainにあります。接続確認は明示操作で行います。"
      } else {
        message = recoveryAuditCount > 0
          ? "未結合です。端末内資格の削除記録がありますが、Desktop側の失効は未確認です。ownerへ確認してから再結合してください。"
          : "未結合です。Desktopで一回限りの招待を発行してください。"
      }
      if reinstallReviewRequired {
        message = "再インストールを検知しました。旧端末資格は利用せず、Desktop側の失効状態をownerに確認してから再結合してください。"
        taskMessage = "以前のTaskが残っている可能性があります。Desktop Agent Centerで状態を確認してから新しい申請を送ってください。"
      }
      if taskSubmissionNeedsReconciliation {
        taskMessage = "前回のTask申請をDesktop一覧と照合するまで新規申請を停止しています。"
      }
    } catch {
      message = "端末内の安全な状態を確認できません。ネットワーク操作を停止しています。"
    }
  }

  func setForeground(_ value: Bool) {
    let changed = lifecycle.setForeground(value)
    guard changed else { return }
    if value {
      loadLocalState()
      resumeTaskState()
    } else {
      pendingInvitation = nil
      hostPreview = nil
      taskInstruction = ""
      mcpSnapshot = nil
      includeMcpCapability = false
      transport.cancelActive()
    }
  }

  func resumeTaskState() {
    guard lifecycle.isForeground(), paired, !credentialExpired else { return }
    guard !busy else {
      refreshOwnedTasksAfterForeground = true
      return
    }
    refreshOwnedTasksAfterForeground = false
    refreshOwnedTasks()
  }

  func selectRuntime(_ runtimeID: String) {
    guard runtimes.contains(runtimeID) else { return }
    selectedRuntimeID = runtimeID
    selectedWorkspaceID = workspaces.first(where: { $0.runtimeID == runtimeID })?.id ?? ""
  }

  func refreshTaskCatalog() {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "Desktop Brokerから実行系と登録Workspaceを読み込んでいます。",
      failureMessage: { _, _ in "作業先を確認できません。Desktop側の状態を確認してから再試行してください。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let runtimeBody = try self.mobileTaskBody(
          credential, operation: "実行系列挙", payload: [:], allowedEvidence: ["INTERNAL_STATE", "LIVE_RUNTIME"],
          epoch: epoch, evidence: evidence
        )
        let runtimeIDs = try MobileTaskContract.runtimes(runtimeBody)
        let workspaceBody = try self.mobileTaskBody(
          credential, operation: "作業領域一覧", payload: [:], allowedEvidence: ["INTERNAL_STATE"],
          epoch: epoch, evidence: evidence
        )
        let entries = try MobileTaskContract.workspaces(workspaceBody)
        guard entries.allSatisfy({ runtimeIDs.contains($0.runtimeID) }) else { throw DeviceLinkFailure.invalid }
        return MobileTaskCatalog(runtimeIDs: runtimeIDs, workspaces: entries)
      },
      onSuccess: { catalog in
        self.runtimes = catalog.runtimeIDs
        self.workspaces = catalog.workspaces
        if !catalog.runtimeIDs.contains(self.selectedRuntimeID) {
          self.selectedRuntimeID = catalog.runtimeIDs.first ?? ""
        }
        let available = catalog.workspaces.filter { $0.runtimeID == self.selectedRuntimeID }
        if !available.contains(where: { $0.id == self.selectedWorkspaceID }) {
          self.selectedWorkspaceID = available.first?.id ?? ""
        }
        self.taskMessage = available.isEmpty
          ? "登録Workspaceがありません。DesktopでWorkspaceを登録してください。"
          : "Desktopの作業先を読み込みました。申請はDesktop ownerの確認待ちになります。"
      }
    )
  }

  func refreshOwnedTasks() {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "この端末のTask申請をDesktop Brokerへ照会しています。",
      failureMessage: { _, _ in "Task一覧を確認できません。結果不明の操作は再送せず、Desktop側の申請一覧を確認してください。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let body = try self.mobileTaskBody(
          credential, operation: "AgentTask端末申請一覧", payload: [:], allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"],
          epoch: epoch, evidence: evidence
        )
        let entries = try MobileTaskContract.ownRequests(body)
        let pendingSessionID = state.pendingTaskSessionID
        let didReconcile = pendingSessionID.map { sessionID in
          entries.contains(where: { $0.sessionID == sessionID })
        } ?? false
        if didReconcile, let pendingSessionID {
          _ = try self.store.clearTaskSubmissionPending(sessionID: pendingSessionID)
        }
        return MobileTaskListResult(
          entries: entries,
          pendingSessionID: didReconcile ? nil : pendingSessionID,
          didReconcilePendingRequest: didReconcile
        )
      },
      onSuccess: { result in
        self.tasks = result.entries
        self.pendingTaskSessionID = result.pendingSessionID
        self.taskSubmissionNeedsReconciliation = result.pendingSessionID != nil
        if result.didReconcilePendingRequest {
          self.taskMessage = "保留中の申請をDesktop一覧で照合しました。新規申請ができます。"
        } else if result.pendingSessionID != nil {
          self.taskMessage = "申請を一覧で照合できません。Desktop ownerがAgent Centerで確認するまで新規申請を停止しています。"
        } else {
          self.taskMessage = "この端末に紐づく申請を読み込みました。本文や権限情報は取得していません。"
        }
      }
    )
  }

  func refreshMCPCapability() {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "BrokerのMCP能力件数とsnapshot hashだけを確認しています。",
      failureMessage: { _, _ in "MCP能力のmetadataを確認できません。通常のMCPなし申請は利用できます。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let body = try self.mobileTaskBody(
          credential, operation: "AgentTask端末MCP能力取得", payload: [:], allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"],
          epoch: epoch, evidence: evidence
        )
        return try MobileTaskContract.mcpSnapshot(body)
      },
      onSuccess: { snapshot in
        self.mcpSnapshot = snapshot
        if !snapshot.usable { self.includeMcpCapability = false }
        self.taskMessage = snapshot.usable
          ? "Brokerの能力metadataを確認しました。Task申請時に含めるか選択できます。"
          : "MCP能力が利用できないため、MCPなしの申請だけを利用できます。"
      }
    )
  }

  func submitTask() {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy,
          !taskSubmissionNeedsReconciliation,
          let workspace = workspaces.first(where: { $0.id == selectedWorkspaceID && $0.runtimeID == selectedRuntimeID }) else {
      taskMessage = taskSubmissionNeedsReconciliation
        ? "申請をDesktop一覧と照合するまで新規申請を停止しています。再送せず、一覧を更新してください。"
        : "Desktopから作業先を取得し、Workspaceを選択してください。"
      return
    }
    let instruction = taskInstruction
    guard !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          instruction.unicodeScalars.count <= 32_768 else {
      taskMessage = "依頼本文は空でない32,768文字以内にしてください。"
      return
    }
    let runtimeID = selectedRuntimeID
    let workspaceID = workspace.id
    let includeMcp = includeMcpCapability
    if includeMcp {
      guard let snapshot = mcpSnapshot, snapshot.usable else {
        taskMessage = "Brokerの最新能力metadataを明示取得してください。"
        return
      }
    }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "新しい対話sessionを作成し、Task申請を一度だけ送信しています。",
      failureMessage: { error, evidence in
        if evidence.taskSubmissionMayHaveReachedDesktop && Self.isDefinitiveRejection(error) {
          return "BrokerがTask申請を受理しませんでした。新しい申請は送っていません。"
        }
        if evidence.taskSubmissionMayHaveReachedDesktop {
          return "Task申請の結果が不明です。自動再送しません。端末一覧を更新し、見つからない場合はDesktop Agent Centerで確認してください。"
        }
        if evidence.taskSessionID != nil {
          return evidence.taskSessionCloseConfirmed
            ? "Task申請前に停止しました。空の対話sessionを終了しました。"
            : "Task申請前に停止しました。空の対話session終了は未確認です。Taskは送信していません。"
        }
        if Self.isDefinitiveRejection(error) {
          return "BrokerがTask申請を受理しませんでした。依頼はDesktop側で確認してください。"
        }
        return Self.safeFailure(error, fallback: "Task申請を確認できません。送信済みか不明なら再送せずDesktop側を確認してください。")
      },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        var sessionID: String?
        do {
          let runtimeBody = try self.mobileTaskBody(
            credential, operation: "実行系列挙", payload: [:], allowedEvidence: ["INTERNAL_STATE", "LIVE_RUNTIME"],
            epoch: epoch, evidence: evidence
          )
          let runtimeIDs = try MobileTaskContract.runtimes(runtimeBody)
          let workspaceBody = try self.mobileTaskBody(
            credential, operation: "作業領域一覧", payload: [:], allowedEvidence: ["INTERNAL_STATE"],
            epoch: epoch, evidence: evidence
          )
          let currentWorkspaces = try MobileTaskContract.workspaces(workspaceBody)
          guard runtimeIDs.contains(runtimeID),
                currentWorkspaces.contains(where: { $0.id == workspaceID && $0.runtimeID == runtimeID }) else {
            throw DeviceLinkFailure.rejected
          }
          var currentMcpHash: String?
          if includeMcp {
            let capabilityBody = try self.mobileTaskBody(
              credential, operation: "AgentTask端末MCP能力取得", payload: [:],
              allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"], epoch: epoch, evidence: evidence
            )
            let snapshot = try MobileTaskContract.mcpSnapshot(capabilityBody)
            guard snapshot.usable else { throw DeviceLinkFailure.rejected }
            currentMcpHash = snapshot.hash
          }
          let sessionBody = try self.mobileTaskBody(
            credential, operation: "対話開始", payload: ["実行系ID": runtimeID],
            allowedEvidence: ["LIVE_RUNTIME"], epoch: epoch, evidence: evidence
          )
          let createdSessionID = try MobileTaskContract.sessionID(sessionBody, runtimeID: runtimeID)
          sessionID = createdSessionID
          evidence.taskSessionID = createdSessionID
          let payload = try MobileTaskContract.requestPayload(
            runtimeID: runtimeID,
            sessionID: createdSessionID,
            workspaceID: workspaceID,
            instruction: instruction,
            mcpCapabilityHash: currentMcpHash
          )
          _ = try self.store.markTaskSubmissionPending(sessionID: createdSessionID)
          evidence.taskSubmissionPendingRecorded = true
          let body = try self.mobileTaskBody(
            credential, operation: "AgentTask端末申請", payload: payload, allowedEvidence: ["LIVE_RUNTIME"],
            epoch: epoch, evidence: evidence
          )
          return try MobileTaskContract.submission(
            body, runtimeID: runtimeID, sessionID: createdSessionID, workspaceID: workspaceID
          )
        } catch {
          if let sessionID,
             self.lifecycle.isCurrent(epoch),
             (!evidence.taskSubmissionMayHaveReachedDesktop || Self.isDefinitiveRejection(error)) {
            do {
              let closeBody = try self.mobileTaskBody(
                credential, operation: "対話終了", payload: ["対話セッションID": sessionID],
                allowedEvidence: ["LIVE_RUNTIME"], epoch: epoch, evidence: evidence
              )
              guard DeviceLinkJSON.exactKeys(closeBody, ["対話セッションID", "状態"]),
                    DeviceLinkJSON.string(closeBody["対話セッションID"]) == sessionID,
                    DeviceLinkJSON.string(closeBody["状態"]) == "終了" else {
                throw DeviceLinkFailure.invalid
              }
              evidence.taskSessionCloseConfirmed = true
            } catch {
              evidence.taskSessionCloseConfirmed = false
            }
          }
          if evidence.taskSubmissionPendingRecorded, let sessionID,
             (!evidence.taskSubmissionMayHaveReachedDesktop || Self.isDefinitiveRejection(error)) {
            do {
              _ = try self.store.clearTaskSubmissionPending(sessionID: sessionID)
              evidence.taskSubmissionPendingCleared = true
            } catch {
              evidence.taskSubmissionPendingCleared = false
            }
          }
          throw error
        }
      },
      onSuccess: { draft in
        self.taskInstruction = ""
        self.tasks = [draft] + self.tasks.filter { $0.id != draft.id }
        self.taskStatuses[draft.id] = .ownerReviewPending
        self.taskSubmissionNeedsReconciliation = true
        self.pendingTaskSessionID = draft.sessionID
        self.taskMessage = "申請をDesktopへ渡しました。端末申請一覧との照合まで次の申請を停止します。Desktop ownerが内容を確認してPermission／Approvalを別途判断し、Brokerが開始直前に再検査します。"
      }
    )
  }

  func refreshTaskStatus(_ draft: MobileTaskDraft) {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "申請状態をDesktop Brokerへ照会しています。",
      failureMessage: { _, _ in "Task状態を確認できません。実行結果を推測せず、再送しません。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let body = try self.mobileTaskBody(
          credential, operation: "AgentTask端末状態", payload: ["申請ID": draft.id],
          allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"], epoch: epoch, evidence: evidence
        )
        return try MobileTaskContract.status(body, draft: draft)
      },
      onSuccess: { status in
        self.taskStatuses[draft.id] = status
        self.taskMessage = "Task状態を更新しました。結果本文はMobileへ返していません。"
      }
    )
  }

  func startTask(_ draft: MobileTaskDraft) {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "申請状態を再確認してからBrokerへ開始要求を一度だけ送ります。",
      failureMessage: { _, _ in "開始結果を確認できません。再送せず、状態を更新してください。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let statusBody = try self.mobileTaskBody(
          credential, operation: "AgentTask端末状態", payload: ["申請ID": draft.id],
          allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"], epoch: epoch, evidence: evidence
        )
        let status = try MobileTaskContract.status(statusBody, draft: draft)
        guard case .startCandidate = status else { return (status, false) }
        let body = try self.mobileTaskBody(
          credential, operation: "AgentTask端末実行", payload: ["申請ID": draft.id],
          allowedEvidence: ["LIVE_RUNTIME"], epoch: epoch, evidence: evidence
        )
        return (.task(try MobileTaskContract.started(body, draft: draft)), true)
      },
      onSuccess: { result in
        let status = result.0
        self.taskStatuses[draft.id] = status
        self.taskMessage = result.1
          ? "Brokerが開始要求を処理しました。権限はBrokerで再検査され、Task本文は表示しません。"
          : "開始候補ではなくなりました。開始要求は送信せず、最新状態を表示しています。"
      }
    )
  }

  func cancelTask(_ draft: MobileTaskDraft) {
    guard lifecycle.isForeground(), paired, !credentialExpired, !busy else { return }
    let epoch = lifecycle.capture()
    runTaskOperation(
      progressMessage: "申請状態を照合してから取消要求を一度だけ送ります。",
      failureMessage: { _, _ in "取消結果を確認できません。再送せず、Task状態を更新してください。" },
      action: { evidence in
        let state = try self.store.loadOrCreate()
        guard let credential = state.credential, !credential.isExpired() else { throw DeviceLinkFailure.invalid }
        let statusBody = try self.mobileTaskBody(
          credential, operation: "AgentTask端末状態", payload: ["申請ID": draft.id],
          allowedEvidence: ["LIVE_RUNTIME", "INTERNAL_STATE"], epoch: epoch, evidence: evidence
        )
        let status = try MobileTaskContract.status(statusBody, draft: draft)
        guard case .task(let record) = status,
              ["pending", "running"].contains(record.state) else {
          return MobileTaskCancellationResult(status: status, requestSent: false)
        }
        let body = try self.mobileTaskBody(
          credential, operation: "AgentTask端末取消", payload: ["申請ID": draft.id],
          allowedEvidence: ["LIVE_RUNTIME"], epoch: epoch, evidence: evidence
        )
        return MobileTaskCancellationResult(
          status: .task(try MobileTaskContract.cancellationRequested(body, draft: draft)),
          requestSent: true
        )
      },
      onSuccess: { result in
        self.taskStatuses[draft.id] = result.status
        self.taskMessage = result.requestSent
          ? "取消要求の記録を照会しました。workerまたは外部処理の停止は別途確認されるまで不明です。"
          : "最新状態は取消対象外です。取消要求は送信していません。"
      }
    )
  }

  private func mobileTaskBody(
    _ credential: DeviceLinkCredential,
    operation: String,
    payload: [String: Any],
    allowedEvidence: Set<String>,
    epoch: UInt64,
    evidence: DeviceLinkAttemptEvidence
  ) throws -> [String: Any] {
    let allowedOperations: Set<String> = [
      "実行系列挙", "作業領域一覧", "対話開始", "対話終了", "AgentTask端末申請", "AgentTask端末申請一覧",
      "AgentTask端末MCP能力取得", "AgentTask端末状態", "AgentTask端末実行", "AgentTask端末取消",
    ]
    guard allowedOperations.contains(operation) else { throw DeviceLinkFailure.invalid }
    let exchange = try self.exchange(
      credential, operation: operation, payload: payload, epoch: epoch, evidence: evidence
    )
    guard let source = DeviceLinkJSON.string(exchange.envelope["evidence_source"]),
          allowedEvidence.contains(source) else {
      throw DeviceLinkFailure.invalid
    }
    let body = try DeviceLinkProtocol.acceptedBody(
      exchange.envelope, nonce: exchange.nonce, operation: operation
    )
    evidence.remoteAccepted = true
    guard lifecycle.isCurrent(epoch) else {
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: true)
    }
    return body
  }

  private func runTaskOperation<Value>(
    progressMessage: String,
    failureMessage: @escaping (Error, DeviceLinkAttemptEvidence) -> String,
    action: @escaping (DeviceLinkAttemptEvidence) throws -> Value,
    onSuccess: @escaping (Value) -> Void
  ) {
    guard lifecycle.isForeground(), !busy else { return }
    let epoch = lifecycle.capture()
    busy = true
    taskMessage = progressMessage
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let evidence = DeviceLinkAttemptEvidence()
      let result = Result { try action(evidence) }
      DispatchQueue.main.async {
        self.busy = false
        defer { self.scheduleOwnedTaskRefreshAfterForeground() }
        guard self.lifecycle.isCurrent(epoch) else {
          if evidence.taskSubmissionMayHaveReachedDesktop {
            self.taskInstruction = ""
            self.taskSubmissionNeedsReconciliation = true
            self.pendingTaskSessionID = evidence.taskSessionID
            self.taskMessage = "Task申請中に画面が非表示になりました。再送せず、Desktop側の申請一覧を照合してください。"
          } else if evidence.taskSubmissionPendingCleared {
            self.taskSubmissionNeedsReconciliation = false
            self.pendingTaskSessionID = nil
          } else if evidence.taskSubmissionPendingRecorded {
            self.taskSubmissionNeedsReconciliation = true
            self.pendingTaskSessionID = evidence.taskSessionID
          } else {
            self.taskMessage = evidence.requestMayHaveReachedDesktop
              ? "要求がDesktopへ届いた可能性があります。自動再送せず、必要なら状態を照会してください。"
              : "画面が非表示になったため操作を停止しました。"
          }
          return
        }
        switch result {
        case .success(let value):
          onSuccess(value)
        case .failure(let error):
          if evidence.taskSubmissionMayHaveReachedDesktop && !Self.isDefinitiveRejection(error) {
            self.taskInstruction = ""
            self.taskSubmissionNeedsReconciliation = true
            self.pendingTaskSessionID = evidence.taskSessionID
          } else if evidence.taskSubmissionPendingCleared {
            self.taskSubmissionNeedsReconciliation = false
            self.pendingTaskSessionID = nil
          } else if evidence.taskSubmissionPendingRecorded {
            self.taskSubmissionNeedsReconciliation = true
            self.pendingTaskSessionID = evidence.taskSessionID
          }
          self.taskMessage = failureMessage(error, evidence)
        }
      }
    }
  }

  private func scheduleOwnedTaskRefreshAfterForeground() {
    guard refreshOwnedTasksAfterForeground, lifecycle.isForeground(), !busy else { return }
    refreshOwnedTasksAfterForeground = false
    DispatchQueue.main.async { [weak self] in
      self?.refreshOwnedTasks()
    }
  }

  func preparePairing(rawInvitation: inout String) {
    defer { rawInvitation.removeAll(keepingCapacity: false) }
    guard lifecycle.isForeground(), !busy, !paired, !reinstallReviewRequired else { return }
    do {
      let state = try store.loadOrCreate()
      guard state.credential == nil else {
        publish(state)
        message = "既にDesktop資格があります。先に状態を確認してください。"
        return
      }
      let invitation = try DeviceLinkCredential.invitation(
        rawInvitation,
        expectedDeviceID: state.deviceID
      )
      pendingInvitation = invitation
      hostPreview = DeviceLinkHostPreview(
        hostID: invitation.hostID,
        host: invitation.host,
        port: invitation.port,
        certificateHash: invitation.certificateHash,
        expiresAt: invitation.expiresAt
      )
      message = "招待を検証しました。送信前にHost ID・接続先・証明書指紋を照合してください。"
    } catch {
      pendingInvitation = nil
      hostPreview = nil
      message = "招待を確認できません。端末ID・接続先・形式・有効期限を確認してください。"
    }
  }

  func cancelPairing() {
    pendingInvitation = nil
    hostPreview = nil
    message = "結合を取り消しました。Desktopへ要求は送っていません。"
  }

  func acknowledgeReinstallReview() {
    guard lifecycle.isForeground(), !busy, reinstallReviewRequired else { return }
    do {
      try store.acknowledgeReinstallReview()
      reinstallReviewRequired = store.reinstallReviewRequired
      message = "Desktop ownerが旧端末状態を確認しました。新しい招待の接続先と証明書指紋も照合してください。"
    } catch {
      message = "再インストール後の端末状態を安全に更新できません。ネットワーク操作を停止しています。"
    }
  }

  func confirmPairing() {
    guard lifecycle.isForeground(), !busy, !reinstallReviewRequired,
          let invitation = pendingInvitation else { return }
    pendingInvitation = nil
    hostPreview = nil
    let epoch = lifecycle.capture()
    run(
      epoch: epoch,
      successMessage: "Desktop資格をKeychainへ保存し、readbackを確認しました。",
      failureMessage: { error, evidence in
        if let brokerFailure = Self.brokerFailure(error) {
          return brokerFailure
        }
        if evidence.remoteAccepted {
          return "Desktopは結合を受理しましたが、端末内資格を確定できませんでした。自動再送せず、Desktop側の端末一覧を確認して必要なら失効してください。"
        }
        if evidence.requestMayHaveReachedDesktop {
          return "結合要求の結果を確認できません。自動再送せず、Desktop側の端末一覧を確認してください。"
        }
        return Self.safeFailure(error, fallback: "結合要求を送れませんでした。端末状態を確認してください。")
      }
    ) { evidence in
      let exchange = try self.exchange(
        invitation,
        operation: "端末結合",
        payload: [:],
        epoch: epoch,
        evidence: evidence
      )
      guard DeviceLinkJSON.string(exchange.envelope["evidence_source"]) == "LIVE_RUNTIME" else {
        throw DeviceLinkFailure.invalid
      }
      let body = try DeviceLinkProtocol.acceptedBody(
        exchange.envelope,
        nonce: exchange.nonce,
        operation: "端末結合"
      )
      evidence.remoteAccepted = true
      guard self.lifecycle.isCurrent(epoch) else {
        throw DeviceLinkFailure.transport(mayHaveReachedDesktop: true)
      }
      let credential = try DeviceLinkCredential.paired(body, invitation: invitation)
      return try self.store.storeCredential(credential)
    }
  }

  func checkConnection() {
    guard lifecycle.isForeground(), !busy else { return }
    let epoch = lifecycle.capture()
    run(
      epoch: epoch,
      successMessage: "Desktop端末資格を確認しました。これは仕事の完了や実行許可を示しません。",
      failureMessage: { error, evidence in
        if let brokerFailure = Self.brokerFailure(error) {
          return brokerFailure
        }
        if evidence.responseReceived {
          return "Desktop応答を受信しましたが、Device Link契約に適合しません。状態は不明のまま保持し、自動再送しません。"
        }
        if evidence.requestMayHaveReachedDesktop {
          return "接続確認要求の結果を確認できません。資格は保持し、自動再送しません。"
        }
        return Self.safeFailure(error, fallback: "Desktop接続を確認できません。資格は保持しています。")
      }
    ) { evidence in
      let state = try self.store.loadOrCreate()
      guard let credential = state.credential else { throw DeviceLinkFailure.invalid }
      guard !credential.isExpired() else { throw DeviceLinkFailure.invalid }
      let exchange = try self.exchange(
        credential,
        operation: "端末確認",
        payload: [:],
        epoch: epoch,
        evidence: evidence
      )
      guard DeviceLinkJSON.string(exchange.envelope["evidence_source"]) == "INTERNAL_STATE" else {
        throw DeviceLinkFailure.invalid
      }
      let body = try DeviceLinkProtocol.acceptedBody(
        exchange.envelope,
        nonce: exchange.nonce,
        operation: "端末確認"
      )
      guard DeviceLinkJSON.exactKeys(body, ["状態"]),
            DeviceLinkJSON.string(body["状態"]) == "接続中" else {
        throw DeviceLinkFailure.invalid
      }
      evidence.remoteAccepted = true
      guard self.lifecycle.isCurrent(epoch) else {
        throw DeviceLinkFailure.transport(mayHaveReachedDesktop: true)
      }
      return state
    }
  }

  func disconnectFromDesktop() {
    guard lifecycle.isForeground(), !busy else { return }
    let epoch = lifecycle.capture()
    run(
      epoch: epoch,
      successMessage: "Desktop失効応答と端末内資格の削除を確認しました。",
      failureMessage: { error, evidence in
        if let brokerFailure = Self.brokerFailure(error) {
          return brokerFailure
        }
        if evidence.remoteAccepted {
          return "Desktop失効は確認しましたが、端末内資格の削除を確認できません。資格を再送せず、端末内だけの削除を使ってください。"
        }
        if evidence.responseReceived {
          return "Desktop応答を受信しましたが、失効結果を確認できません。資格を保持し、自動再送しません。"
        }
        if evidence.requestMayHaveReachedDesktop {
          return "離脱要求がDesktopへ届いた可能性があります。自動再送しません。Desktop側を確認してから端末内状態を整理してください。"
        }
        return Self.safeFailure(error, fallback: "Desktopから解除できません。資格を保持しました。")
      }
    ) { evidence in
      let state = try self.store.loadOrCreate()
      guard let credential = state.credential else { return state }
      guard !credential.isExpired() else { throw DeviceLinkFailure.invalid }
      let exchange = try self.exchange(
        credential,
        operation: "端末離脱",
        payload: [:],
        epoch: epoch,
        evidence: evidence
      )
      guard DeviceLinkJSON.string(exchange.envelope["evidence_source"]) == "LIVE_RUNTIME" else {
        throw DeviceLinkFailure.invalid
      }
      let body = try DeviceLinkProtocol.acceptedBody(
        exchange.envelope,
        nonce: exchange.nonce,
        operation: "端末離脱"
      )
      guard DeviceLinkJSON.exactKeys(body, ["状態"]),
            DeviceLinkJSON.string(body["状態"]) == "失効" else {
        throw DeviceLinkFailure.invalid
      }
      evidence.remoteAccepted = true
      guard self.lifecycle.isCurrent(epoch) else {
        throw DeviceLinkFailure.transport(mayHaveReachedDesktop: true)
      }
      return try self.store.clearConfirmedRevocation()
    }
  }

  func deleteCredentialLocally() {
    guard lifecycle.isForeground(), !busy else { return }
    run(
      epoch: lifecycle.capture(),
      successMessage: "端末内資格を削除し、非権威の回復記録を保存・再読込しました。Desktop失効は未確認です。",
      failureMessage: { _, _ in
        "端末内資格と回復記録の保存状態を確認できません。状態を照合するまで通信を停止しています。"
      }
    ) { _ in
      try self.store.deleteCredentialLocallyWithAudit()
    }
  }

  private func exchange(
    _ credential: DeviceLinkCredential,
    operation: String,
    payload: [String: Any],
    epoch: UInt64,
    evidence: DeviceLinkAttemptEvidence
  ) throws -> (nonce: String, envelope: [String: Any]) {
    do {
      let result = try transport.exchange(
        credential,
        operation: operation,
        payload: payload,
        canSend: { [weak self] in self?.lifecycle.isCurrent(epoch) ?? false }
      )
      evidence.requestMayHaveReachedDesktop = true
      evidence.responseReceived = true
      if operation == "AgentTask端末申請" {
        evidence.taskSubmissionMayHaveReachedDesktop = true
      }
      return result
    } catch {
      if let failure = error as? DeviceLinkFailure,
         case let .transport(mayHaveReachedDesktop) = failure {
        evidence.requestMayHaveReachedDesktop = mayHaveReachedDesktop
        if operation == "AgentTask端末申請" {
          evidence.taskSubmissionMayHaveReachedDesktop = mayHaveReachedDesktop
        }
      }
      throw error
    }
  }

  private func run(
    epoch: UInt64,
    successMessage: String,
    failureMessage: @escaping (Error, DeviceLinkAttemptEvidence) -> String,
    action: @escaping (DeviceLinkAttemptEvidence) throws -> DeviceLinkStoredState
  ) {
    guard lifecycle.isCurrent(epoch), !busy else { return }
    busy = true
    message = "Desktop Brokerを確認しています。通信結果不明時は再送しません。"
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let evidence = DeviceLinkAttemptEvidence()
      let result = Result { try action(evidence) }
      DispatchQueue.main.async {
        self.busy = false
        guard self.lifecycle.isCurrent(epoch) else {
          self.pendingInvitation = nil
          self.hostPreview = nil
          if evidence.remoteAccepted {
            self.message = "Desktop応答を受け取りましたが、画面が非表示になったため端末状態への反映を停止しました。Desktop側を確認してください。"
          } else if evidence.requestMayHaveReachedDesktop {
            self.message = "要求がDesktopへ届いた可能性があります。自動再送しません。Desktop側の状態を確認してください。"
          } else {
            self.message = "画面が非表示になったため操作を停止しました。Desktopへ要求は送っていません。"
          }
          return
        }
        switch result {
        case .success(let state):
          self.publish(state)
          self.message = successMessage
        case .failure(let error):
          do { self.publish(try self.store.loadOrCreate()) } catch { }
          self.message = failureMessage(error, evidence)
        }
      }
    }
  }

  private func publish(_ state: DeviceLinkStoredState) {
    deviceID = state.deviceID
    paired = state.credential != nil
    credentialExpired = state.credential?.isExpired() ?? false
    recoveryAuditCount = state.recoveryAudit.count
    pendingTaskSessionID = state.pendingTaskSessionID
    taskSubmissionNeedsReconciliation = state.pendingTaskSessionID != nil
    reinstallReviewRequired = store.reinstallReviewRequired
  }

  private static func safeFailure(_ error: Error, fallback: String) -> String {
    brokerFailure(error) ?? fallback
  }

  private static func isDefinitiveRejection(_ error: Error) -> Bool {
    guard let failure = error as? DeviceLinkFailure else { return false }
    if case .rejected = failure { return true }
    if case .transport(let mayHaveReachedDesktop) = failure { return !mayHaveReachedDesktop }
    return false
  }

  private static func brokerFailure(_ error: Error) -> String? {
    if let failure = error as? DeviceLinkFailure {
      switch failure {
      case .rejected:
        return "Desktop Brokerが要求を拒否しました。資格と状態を保持し、再送しません。"
      case .suspended:
        return "Desktop Brokerが安全停止中です。別経路で再開せず、資格と状態を保持します。"
      default:
        return nil
      }
    }
    return nil
  }
}
