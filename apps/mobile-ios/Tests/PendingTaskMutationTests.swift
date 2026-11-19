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
    print("PendingTaskMutationTests PASS")
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
