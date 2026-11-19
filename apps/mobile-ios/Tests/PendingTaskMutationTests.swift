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
    let start = try PendingMobileTaskMutation(kind: .start, credential: desktop, draft: request, taskID: nil)
    let restarted = try PendingMobileTaskMutation(stored: start.storageObject())
    try check(restarted == start, "restart round trip")
    try check(!restarted.isResolved(credential: desktop, draft: request, status: .startCandidate, liveRuntime: true),
              "an unchanged start candidate must hold")
    try check(!restarted.isResolved(credential: desktop, draft: request, status: status("running"), liveRuntime: false),
              "internal state must not clear a hold")
    try check(!restarted.isResolved(credential: credential(hostID: otherID), draft: request,
                                   status: status("running"), liveRuntime: true), "different host")
    try check(!restarted.isResolved(credential: credential(deviceID: otherID), draft: request,
                                   status: status("running"), liveRuntime: true), "different device")
    try check(!restarted.isResolved(credential: credential(pin: String(repeating: "d", count: 64)), draft: request,
                                   status: status("running"), liveRuntime: true), "changed certificate")
    try check(!restarted.isResolved(credential: desktop, draft: draft(id: otherID), status: status("running"),
                                   liveRuntime: true), "different request")
    try check(restarted.isResolved(credential: desktop, draft: draft(selectedTaskID: taskID),
                                  status: status("running"), liveRuntime: true), "verified started task")

    let cancellation = try PendingMobileTaskMutation(kind: .cancel, credential: desktop, draft: request, taskID: taskID)
    for state in ["pending", "running", "blocked", "quarantined"] {
      try check(!cancellation.isResolved(credential: desktop, draft: request, status: status(state),
                                        liveRuntime: true), "unresolved cancellation remains held")
    }
    try check(!cancellation.isResolved(credential: desktop, draft: request, status: status("cancelled", id: otherID),
                                      liveRuntime: true), "different task cannot resolve cancellation")
    try check(!cancellation.isResolved(credential: desktop, draft: request, status: status("cancelled"),
                                      liveRuntime: false), "internal cancellation projection")
    for state in ["cancelled", "completed", "failed"] {
      try check(cancellation.isResolved(credential: desktop, draft: request, status: status(state),
                                       liveRuntime: true), "matching terminal task resolves the hold")
    }

    do {
      _ = try PendingMobileTaskMutation(stored: ["kind": "start", "scope_digest": fingerprint, "extra": true])
      throw SmokeFailure(label: "checkpoint accepted an extra field")
    } catch DeviceLinkFailure.storage {}
    do {
      _ = try PendingMobileTaskMutation(kind: .cancel, credential: desktop, draft: request, taskID: nil)
      throw SmokeFailure(label: "cancellation accepted missing task ID")
    } catch DeviceLinkFailure.invalid {}
    try listRefresh(credential: desktop, pending: cancellation)
    print("PendingTaskMutationTests PASS")
  }

  private static func listRefresh(credential: DeviceLinkCredential, pending: PendingMobileTaskMutation) throws {
    let laterID = String(repeating: "f", count: 32)
    let entries = [draft(id: otherID), draft(selectedTaskID: taskID), draft(id: laterID)]
    var queried: [String] = []
    var resolved: [String] = []
    let observations = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: pending,
                                                               canRead: { true }) { entry in
      queried.append(entry.id)
      if entry.id == otherID { throw DeviceLinkFailure.rejected }
      let observation = entry.id == requestID ? status("cancelled") : .startCandidate
      if pending.isResolved(credential: credential, draft: entry, status: observation, liveRuntime: true) {
        resolved.append(entry.id)
      }
      return observation
    }
    try check(queried == [requestID, otherID, laterID], "prioritize exact pending request")
    try check(resolved == [requestID], "reconcile only the matched live task")
    try check(Set(observations.keys) == Set([requestID, laterID]), "other tasks survive a row rejection")
    try check(!pending.matchesListedRequest(credential: credential, draft: draft(selectedTaskID: otherID)),
              "different task is not prioritized")
    try check(!pending.matchesListedRequest(credential: credential, draft: draft()), "missing task is not prioritized")

    queried.removeAll()
    let stopped = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: nil,
                                                           canRead: { true }) { entry in
      queried.append(entry.id)
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
    }
    try check(stopped.isEmpty && queried == [otherID], "transport failure stops other reads")
    queried.removeAll()
    let background = MobileTaskContract.observeOwnedStatuses(entries, credential: credential, pending: nil,
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
                                 pin: String = fingerprint) -> DeviceLinkCredential {
    DeviceLinkCredential(
      hostID: hostID, host: "127.0.0.1", port: 443, certificateHash: pin,
      deviceID: deviceID, expiresAt: 999, credentialID: otherID, secret: "fixture"
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
