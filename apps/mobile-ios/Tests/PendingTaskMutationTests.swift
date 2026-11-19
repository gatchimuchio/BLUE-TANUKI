import Foundation

@main
struct PendingTaskMutationTests {
  private static let requestID = String(repeating: "a", count: 32)
  private static let sessionID = String(repeating: "b", count: 32)
  private static let taskID = String(repeating: "c", count: 32)
  private static let otherID = String(repeating: "d", count: 32)
  private static let fingerprint = String(repeating: "e", count: 64)
  private static let instructionHash = "sha256:" + String(repeating: "f", count: 64)

  static func main() throws {
    let desktop = credential()
    let request = draft()
    try sessionStartScope()
    try submissionReceiptScope(credential: desktop)
    try deviceRevocation(credential: desktop)
    let start = try PendingMobileTaskMutation(kind: .start, credential: desktop, draft: request, taskID: nil)
    let restarted = try PendingMobileTaskMutation(stored: start.storageObject())
    try check(restarted == start, "restart round trip")
    try check(!restarted.isResolved(credential: desktop, draft: request, status: .startCandidate, evidenceSource: "INTERNAL_STATE"),
              "an unchanged start candidate must hold")
    for state in ["pending", "blocked", "quarantined"] {
      try check(!restarted.isResolved(credential: desktop, draft: request, status: status(state),
                                      evidenceSource: "INTERNAL_STATE"), "start is unresolved")
    }
    try check(!restarted.isResolved(credential: desktop, draft: request, status: status("running"), evidenceSource: "FIXTURE"),
              "untrusted evidence may not clear a hold")
    try check(!restarted.isResolved(credential: credential(hostID: otherID), draft: request,
                                   status: status("running"), evidenceSource: "INTERNAL_STATE"), "different host")
    try check(!restarted.isResolved(credential: credential(deviceID: otherID), draft: request,
                                   status: status("running"), evidenceSource: "INTERNAL_STATE"), "different device")
    try check(!restarted.isResolved(credential: credential(pin: String(repeating: "d", count: 64)), draft: request,
                                   status: status("running"), evidenceSource: "INTERNAL_STATE"), "changed certificate")
    try check(!restarted.isResolved(credential: desktop, draft: draft(id: otherID), status: status("running"),
                                   evidenceSource: "INTERNAL_STATE"), "different request")
    try check(restarted.isResolved(credential: desktop, draft: draft(selectedTaskID: taskID),
                                  status: status("running"), evidenceSource: "INTERNAL_STATE"), "verified started task")
    try check(restarted.isResolved(credential: desktop, draft: draft(selectedTaskID: taskID),
                                  status: status("completed"), evidenceSource: "LIVE_RUNTIME"), "verified terminal task")

    let cancellation = try PendingMobileTaskMutation(kind: .cancel, credential: desktop, draft: request, taskID: taskID)
    for state in ["pending", "running", "blocked", "quarantined"] {
      try check(!cancellation.isResolved(credential: desktop, draft: request, status: status(state),
                                        evidenceSource: "INTERNAL_STATE"), "unresolved cancellation remains held")
    }
    try check(!cancellation.isResolved(credential: desktop, draft: request, status: status("cancelled", id: otherID),
                                      evidenceSource: "INTERNAL_STATE"), "different task cannot resolve cancellation")
    try check(!cancellation.isResolved(credential: desktop, draft: request, status: status("cancelled"),
                                      evidenceSource: "FIXTURE"), "untrusted evidence may not resolve cancellation")
    for state in ["cancelled", "completed", "failed"] {
      try check(cancellation.isResolved(credential: desktop, draft: request, status: status(state),
                                       evidenceSource: "INTERNAL_STATE"), "matching terminal task resolves the hold")
    }
    try acceptedCancellation(credential: desktop, draft: draft(selectedTaskID: taskID), pending: cancellation)
    try scopedMutationHolds(credential: desktop, start: start, cancellation: cancellation)

    do {
      _ = try PendingMobileTaskMutation(stored: ["kind": "start", "scope_digest": fingerprint, "extra": true])
      throw SmokeFailure(label: "checkpoint accepted an extra field")
    } catch DeviceLinkFailure.storage {}
    do {
      _ = try PendingMobileTaskMutation(kind: .cancel, credential: desktop, draft: request, taskID: nil)
      throw SmokeFailure(label: "cancellation accepted missing task ID")
    } catch DeviceLinkFailure.invalid {}
    try listRefresh(credential: desktop, pending: cancellation)
    try desktopNotifications()
    print("PendingTaskMutationTests PASS")
  }

  private static func scopedMutationHolds(credential desktop: DeviceLinkCredential,
                                         start: PendingMobileTaskMutation,
                                         cancellation: PendingMobileTaskMutation) throws {
    let request = draft()
    let otherRequest = draft(id: otherID)
    let other = try PendingMobileTaskMutation(kind: .start, credential: desktop, draft: otherRequest, taskID: nil)
    let requestDigest = PendingMobileTaskMutation.requestDigest(credential: desktop, draft: request)
    let otherDigest = PendingMobileTaskMutation.requestDigest(credential: desktop, draft: otherRequest)
    try check(start.requestDigest == cancellation.requestDigest && start.requestDigest == requestDigest,
              "開始の結果不明は同じ申請の取消も保留する")
    try check(PendingMobileTaskMutation.blocksRequest([start], digest: requestDigest), "同一申請を保留する")
    try check(!PendingMobileTaskMutation.blocksRequest([start], digest: otherDigest), "別申請の操作を継続できる")

    let alteredDraft = MobileTaskDraft(id: request.id, runtimeID: request.runtimeID, sessionID: request.sessionID,
      workspaceID: "different-workspace", instructionHash: request.instructionHash, createdAt: request.createdAt,
      expiresAt: request.expiresAt, taskID: otherID)
    try check(PendingMobileTaskMutation.requestDigest(credential: desktop, draft: alteredDraft) == requestDigest,
              "表示情報の変更で同じ申請の保留を回避できない")
    let otherHostDigest = PendingMobileTaskMutation.requestDigest(credential: credential(hostID: otherID), draft: request)
    try check(!PendingMobileTaskMutation.blocksRequest([start], digest: otherHostDigest), "別の結合先へ保留を広げない")

    let restored = try PendingMobileTaskMutation.readCollection([start.storageObject(), other.storageObject()])
    try check(restored == [start, other], "複数保留と順序を復元する")
    let remaining = restored.filter {
      !$0.isResolved(credential: desktop, draft: request, status: status("running"), evidenceSource: "INTERNAL_STATE")
    }
    try check(remaining == [other], "照合済みの申請だけを終結する")

    var legacyObject = start.storageObject()
    legacyObject.removeValue(forKey: "request_digest")
    let legacy = try PendingMobileTaskMutation(stored: legacyObject, scoped: false)
    try check(try PendingMobileTaskMutation.readCollection([legacyObject]) == [legacy], "旧形式を保持する")
    try check(PendingMobileTaskMutation.blocksRequest([legacy], digest: otherDigest), "旧形式の保留を安全側で保持する")
    try check(legacy.isResolved(credential: desktop, draft: request, status: status("running"), evidenceSource: "INTERNAL_STATE"),
              "旧形式は従来の厳密照合で終結できる")
    for invalid in [[start.storageObject(), cancellation.storageObject()], [start.storageObject(), legacyObject]] {
      do {
        _ = try PendingMobileTaskMutation.readCollection(invalid)
        throw SmokeFailure(label: "重複または旧形式混在の保留を受理した")
      } catch DeviceLinkFailure.storage {}
    }
    let full = try (0..<PendingMobileTaskMutation.maximumPendingCount).map { index in
      try PendingMobileTaskMutation(kind: .start, credential: desktop,
        draft: draft(id: String(format: "%032x", UInt32(index))), taskID: nil)
    }
    try check(PendingMobileTaskMutation.blocksRequest(full, digest: otherDigest), "保存上限で既存記録を破棄しない")
  }

  private static func deviceRevocation(credential desktop: DeviceLinkCredential) throws {
    let before = try PendingDeviceLinkRevocation(credential: desktop)
    let after = try PendingDeviceLinkRevocation(stored: before.credentialDigest)
    try check(after == before, "離脱照合記録を復元できる")
    try check(after.matches(desktop), "同じ資格だけを照合できる")
    for other in [credential(hostID: otherID), credential(deviceID: otherID), credential(pin: instructionHash),
                  credential(credentialID: taskID), credential(secret: "different fixture")] {
      try check(!after.matches(other), "異なる接続先・端末・証明書・資格を照合しない")
    }
    do {
      _ = try PendingDeviceLinkRevocation(stored: "invalid")
      throw SmokeFailure(label: "破損した離脱照合記録を受理した")
    } catch DeviceLinkFailure.storage {}

    let accepted: [String: Any] = [
      "request_id": requestID, "operation": "端末離脱", "status": "accepted",
      "evidence_source": "INTERNAL_STATE", "audit_event_id": "synthetic-device-revocation",
      "error": NSNull(), "health": NSNull(), "body": ["状態": "失効"], "shutdown_requested": false,
    ]
    try DeviceLinkProtocol.requireConfirmedRevocation(accepted, nonce: requestID)
    let changedFields: [(String, Any)] = [
      ("request_id", otherID), ("operation", "端末確認"), ("evidence_source", "FIXTURE"),
      ("evidence_source", "LIVE_RUNTIME"), ("body", ["状態": "接続中"]),
      ("body", ["状態": "失効", "未定義": "追加項目"]),
    ]
    for (field, value) in changedFields {
      var other = accepted
      other[field] = value
      do {
        try DeviceLinkProtocol.requireConfirmedRevocation(other, nonce: requestID)
        throw SmokeFailure(label: "一致しない応答を失効済みと判定した: \(field)")
      } catch DeviceLinkFailure.invalid {}
    }
    var rejected = accepted
    rejected["status"] = "rejected"
    rejected["body"] = NSNull()
    rejected["error"] = ["code": "refused", "message": "synthetic", "recoverable": true,
      "audit_event_required": true, "fail_closed": true]
    do {
      try DeviceLinkProtocol.requireConfirmedRevocation(rejected, nonce: requestID)
      throw SmokeFailure(label: "一般拒否を失効済みと判定した")
    } catch DeviceLinkFailure.rejected {}
  }

  private static func submissionReceiptScope(credential desktop: DeviceLinkCredential) throws {
    let instruction = "  依頼\ne\u{301}🤝  "
    let hash = MobileTaskContract.instructionHash(instruction)
    try check(hash == "sha256:20ca4e5469701d1c66bce473616e93ae8e536fc2243f35dc6ab48e18d892a4dd",
              "hash exact UTF-8 including whitespace and decomposed Unicode")
    try check(MobileTaskContract.instructionHash("  依頼\né🤝  ") != hash,
              "canonical-equivalent text must keep distinct input bytes")
    let payload = try MobileTaskContract.requestPayload(runtimeID: "runtime", sessionID: sessionID,
      workspaceID: "workspace", instruction: instruction, mcpCapabilityHash: nil)
    try check((payload["instruction"] as? String).map { Data($0.utf8) } == Data(instruction.utf8),
              "the payload retains the bytes used for the expected hash")

    let pending = try PendingMobileTaskSubmission(credential: desktop, runtimeID: "runtime",
      sessionID: sessionID, workspaceID: "workspace", instructionHash: hash)
    guard let stored = pending.storageObject() else { throw SmokeFailure(label: "missing checkpoint encoding") }
    try check(DeviceLinkJSON.exactKeys(stored, ["session_id", "scope_digest"]), "encoded checkpoint contains no input or credentials")
    let reloaded = try PendingMobileTaskSubmission(stored: stored)
    try check(reloaded == pending, "submission checkpoint round trip")

    let body: [String: Any] = ["版": 1, "申請ID": requestID, "状態": "Owner確認待ち",
      "実行系ID": "runtime", "対話セッションID": sessionID, "作業領域ID": "workspace", "指示hash": hash, "期限": 1_000]
    let receipt = try MobileTaskContract.submission(body, runtimeID: "runtime", sessionID: sessionID,
      workspaceID: "workspace", expectedInstructionHash: hash)
    try check(receipt.instructionHash == hash, "matched submission acknowledgement")
    for (key, mismatch) in [("実行系ID", "other-runtime"), ("対話セッションID", otherID),
                            ("作業領域ID", "other-workspace"), ("指示hash", instructionHash)] {
      var badBody = body
      badBody[key] = mismatch
      do {
        _ = try MobileTaskContract.submission(badBody, runtimeID: "runtime", sessionID: sessionID,
          workspaceID: "workspace", expectedInstructionHash: hash)
        throw SmokeFailure(label: "wrong acknowledgement scope: \(key)")
      } catch DeviceLinkFailure.invalid {}
    }

    let wrongHash = draft(id: otherID)
    let unrelated = MobileTaskDraft(id: taskID, runtimeID: "runtime", sessionID: otherID,
      workspaceID: "workspace", instructionHash: hash, createdAt: 10, expiresAt: 20, taskID: nil)
    try check(!reloaded.hasUniqueReceipt(in: [], credential: desktop), "missing receipt keeps an uncertain submission held")
    try check(!reloaded.hasUniqueReceipt(in: [wrongHash], credential: desktop), "same session is insufficient")
    try check(!reloaded.hasUniqueReceipt(in: [receipt, wrongHash], credential: desktop), "two receipts for the session are ambiguous")
    try check(reloaded.hasUniqueReceipt(in: [unrelated, receipt], credential: desktop), "one exact receipt reconciles the submission")
    for otherIssuer in [credential(hostID: otherID), credential(pin: String(repeating: "d", count: 64)),
                        credential(deviceID: otherID)] {
      try check(!reloaded.hasUniqueReceipt(in: [receipt], credential: otherIssuer), "another pairing scope cannot reconcile")
    }
    let renewed = credential(credentialID: requestID, secret: "new fixture")
    try check(reloaded.hasUniqueReceipt(in: [receipt], credential: renewed), "renamed credential token leaves issuer scope intact")

    let legacy = try PendingMobileTaskSubmission(legacySessionID: sessionID)
    try check(legacy.isLegacy && legacy.sessionID == sessionID && legacy.storageObject() == nil &&
              !legacy.hasUniqueReceipt(in: [receipt], credential: desktop), "legacy checkpoint remains readable and held")
    var malformed = stored
    malformed["scope_digest"] = "malformed"
    do {
      _ = try PendingMobileTaskSubmission(stored: malformed)
      throw SmokeFailure(label: "malformed checkpoint accepted")
    } catch DeviceLinkFailure.storage {}
  }

  private static func sessionStartScope() throws {
    let body = try MobileTaskContract.sessionStartPayload(runtimeID: "runtime", workspaceID: "workspace")
    try check(DeviceLinkJSON.exactKeys(body, ["実行系ID", "作業領域ID"]) &&
              DeviceLinkJSON.string(body["実行系ID"]) == "runtime" && DeviceLinkJSON.string(body["作業領域ID"]) == "workspace",
              "session start binds both registered identifiers")
    for invalid in ["", "../workspace"] {
      do {
        _ = try MobileTaskContract.sessionStartPayload(runtimeID: "runtime", workspaceID: invalid)
        throw SmokeFailure(label: "invalid workspace accepted")
      } catch DeviceLinkFailure.invalid {}
    }
  }

  private static func acceptedCancellation(credential: DeviceLinkCredential, draft: MobileTaskDraft,
                                           pending: PendingMobileTaskMutation) throws {
    let record: [String: Any] = [
      "task_id": taskID, "実行系ID": "runtime", "対話セッションID": sessionID, "作業領域ID": "workspace",
      "指示hash": instructionHash, "状態": "running", "結果hash": NSNull(), "結果本文あり": false,
    ]
    let body: [String: Any] = ["申請ID": requestID, "状態": "Task取消要求済み", "Task": record]
    let envelope: [String: Any] = [
      "request_id": sessionID, "operation": "AgentTask端末取消", "status": "accepted",
      "evidence_source": "INTERNAL_STATE", "audit_event_id": "fixture-audit", "error": NSNull(),
      "health": NSNull(), "body": body, "shutdown_requested": false,
    ]
    let accepted = try DeviceLinkProtocol.acceptedBody(envelope, nonce: sessionID, operation: "AgentTask端末取消")
    let acknowledgement = try MobileTaskContract.cancellationRequested(accepted, draft: draft)
    try check(!pending.isResolved(credential: credential, draft: draft, status: .task(acknowledgement),
                                  evidenceSource: "INTERNAL_STATE"),
              "accepted cancellation still awaits a terminal state")
    let restored = try PendingMobileTaskMutation(stored: pending.storageObject())
    try check(!restored.isResolved(credential: credential, draft: draft, status: .task(acknowledgement),
                                   evidenceSource: "INTERNAL_STATE"),
              "accepted cancellation stays held after reload")
    try check(restored.isResolved(credential: credential, draft: draft, status: status("cancelled"),
                                  evidenceSource: "INTERNAL_STATE"),
              "a matching terminal state resolves an accepted cancellation")
    for (nonce, operation) in [(otherID, "AgentTask端末取消"), (sessionID, "AgentTask端末状態")] {
      do {
        _ = try DeviceLinkProtocol.acceptedBody(envelope, nonce: nonce, operation: operation)
        throw SmokeFailure(label: "foreign cancellation envelope")
      } catch DeviceLinkFailure.invalid {}
    }
    let mismatches: [(String, Any)] = [
      ("task_id", otherID), ("実行系ID", "other-runtime"), ("対話セッションID", otherID),
      ("作業領域ID", "other-workspace"), ("指示hash", "sha256:" + fingerprint), ("余分", NSNull()),
    ]
    for (key, value) in mismatches {
      var alteredRecord = record
      alteredRecord[key] = value
      var alteredBody = body
      alteredBody["Task"] = alteredRecord
      do {
        _ = try MobileTaskContract.cancellationRequested(alteredBody, draft: draft)
        throw SmokeFailure(label: "invalid cancellation response was accepted for \(key)")
      } catch DeviceLinkFailure.invalid {}
    }
  }

  private static func desktopNotifications() throws {
    func row(_ order: Int, source: String, severity: String, state: String) -> [String: Any] {
      [
        "版": 1, "通知ID": "notification-broker-audit-\(order)", "source": source, "severity": severity,
        "タイトル": "fixture title suppressed", "概要": "fixture body suppressed", "作成順": order,
        "関連監査ID": "broker-audit-\(order)", "関連監査hash": instructionHash, "遷移先": "approval",
        "状態": state, "通知hash": instructionHash, "表示範囲": "summary", "権限生成": "なし",
      ]
    }
    let rows = [row(4, source: "Approval", severity: "critical", state: "unread"),
                row(3, source: "Task", severity: "info", state: "read")]
    let body: [String: Any] = [
      "版": 1, "通知一覧": rows, "件数": 2, "未読件数": 1, "重大件数": 1,
      "証拠種別": "INTERNAL_STATE", "表示範囲": "summary", "権限生成": "なし", "操作": "navigation_only",
    ]
    let summary = try DesktopNotificationSummary.read(body)
    try check(summary.entries == [.init(source: .approval, severity: .critical, unread: true),
                                  .init(source: .task, severity: .info, unread: false)] &&
              summary.unreadCount == 1 && summary.criticalCount == 1,
              "retain only bounded notification categories, severity, and read state")
    var empty = body
    empty["通知一覧"] = [[String: Any]]()
    for key in ["件数", "未読件数", "重大件数"] { empty[key] = 0 }
    let emptySummary = try DesktopNotificationSummary.read(empty)
    try check(emptySummary.entries.isEmpty, "empty authenticated list is observed")

    var oversized = empty
    let tooMany = DesktopNotificationSummary.maximumEntries + 1
    oversized["通知一覧"] = (1...tooMany).map { row($0, source: "Task", severity: "info", state: "read") }
    oversized["件数"] = tooMany
    do {
      _ = try DesktopNotificationSummary.read(oversized)
      throw SmokeFailure(label: "list exceeded requested entry limit")
    } catch DeviceLinkFailure.invalid {}

    var extra = rows[0]
    extra["approval_token"] = "synthetic discarded token"
    let mismatches: [(String, Any)] = [
      ("証拠種別", "LIVE_RUNTIME"), ("権限生成", "付与"), ("操作", "execute"), ("未読件数", 0), ("件数", true),
      ("通知一覧", [extra, rows[1]]), ("通知一覧", [rows[0], rows[0]]),
      ("通知一覧", [row(4, source: "unknown", severity: "critical", state: "unread"), rows[1]]),
    ]
    for (key, value) in mismatches {
      var altered = body
      altered[key] = value
      do {
        _ = try DesktopNotificationSummary.read(altered)
        throw SmokeFailure(label: "invalid notification response was accepted for \(key)")
      } catch DeviceLinkFailure.invalid {}
    }
  }

  private static func listRefresh(credential: DeviceLinkCredential, pending: PendingMobileTaskMutation) throws {
    let laterID = String(repeating: "f", count: 32)
    let entries = [draft(id: otherID), draft(selectedTaskID: taskID), draft(id: laterID)]
    var queried: [String] = []
    var resolved: [String] = []
    let observations = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: [pending],
                                                               canRead: { true }) { entry in
      queried.append(entry.id)
      if entry.id == otherID { throw DeviceLinkFailure.rejected }
      let observation = entry.id == requestID ? status("cancelled") : .startCandidate
      if pending.isResolved(credential: credential, draft: entry, status: observation, evidenceSource: "INTERNAL_STATE") {
        resolved.append(entry.id)
      }
      return observation
    }
    try check(queried == [requestID, otherID, laterID], "prioritize exact pending request")
    try check(resolved == [requestID], "reconcile only the matched broker task")
    try check(Set(observations.keys) == Set([requestID, laterID]), "other tasks survive a row rejection")
    try check(!pending.matchesListedRequest(credential: credential, draft: draft(selectedTaskID: otherID)),
              "different task is not prioritized")
    try check(!pending.matchesListedRequest(credential: credential, draft: draft()), "missing task is not prioritized")

    let later = try PendingMobileTaskMutation(kind: .start, credential: credential,
      draft: draft(id: laterID), taskID: nil)
    queried.removeAll()
    _ = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: [pending, later],
                                               canRead: { true }) { entry in
      queried.append(entry.id)
      return .startCandidate
    }
    try check(queried == [requestID, laterID, otherID], "複数の保留中の申請を先に照合する")

    queried.removeAll()
    let stopped = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: [],
                                                           canRead: { true }) { entry in
      queried.append(entry.id)
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
    }
    try check(stopped.isEmpty && queried == [otherID], "transport failure stops other reads")
    queried.removeAll()
    let background = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: [],
                                                              canRead: { false }) { entry in
      queried.append(entry.id)
      return .startCandidate
    }
    try check(background.isEmpty && queried.isEmpty, "background cannot read task status")
  }

  private static func check(_ value: Bool, _ label: String) throws {
    guard value else { throw SmokeFailure(label: label) }
  }

  private struct SmokeFailure: Error {
    let label: String
  }

  private static func credential(hostID: String = requestID, deviceID: String = requestID,
                                 pin: String = fingerprint, credentialID: String = otherID,
                                 secret: String = "fixture") -> DeviceLinkCredential {
    DeviceLinkCredential(
      hostID: hostID, host: "127.0.0.1", port: 443, certificateHash: pin,
      deviceID: deviceID, expiresAt: 999, credentialID: credentialID, secret: secret
    )
  }

  private static func draft(id: String = requestID, selectedTaskID: String? = nil) -> MobileTaskDraft {
    MobileTaskDraft(
      id: id, runtimeID: "runtime", sessionID: sessionID, workspaceID: "workspace",
      instructionHash: instructionHash, createdAt: 10, expiresAt: 20, taskID: selectedTaskID
    )
  }

  private static func status(_ state: String, id: String = taskID) -> MobileTaskStatus {
    .task(MobileTaskRecord(
      taskID: id, runtimeID: "runtime", sessionID: sessionID, workspaceID: "workspace",
      instructionHash: instructionHash, state: state, resultHash: nil, resultContentAvailable: false
    ))
  }
}
