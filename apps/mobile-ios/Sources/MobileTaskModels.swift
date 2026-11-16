import Foundation

struct MobileTaskWorkspace: Identifiable, Equatable {
  let id: String
  let runtimeID: String
}

struct MobileTaskDraft: Identifiable, Equatable {
  let id: String
  let runtimeID: String
  let sessionID: String
  let workspaceID: String
  let instructionHash: String
  let createdAt: Int64
  let expiresAt: Int64
  let taskID: String?
}

struct MobileTaskRecord: Equatable {
  let taskID: String
  let runtimeID: String
  let sessionID: String
  let workspaceID: String
  let instructionHash: String
  let state: String
  let resultHash: String?
  let resultContentAvailable: Bool
}

enum MobileTaskStatus: Equatable {
  case ownerReviewPending
  case startCandidate
  case task(MobileTaskRecord)
}

struct MobileMCPCapabilitySnapshot: Equatable {
  let hash: String?
  let toolCount: Int
  let state: String

  var usable: Bool { state == "available" && hash != nil && toolCount > 0 }
}

enum MobileTaskContract {
  private static let requestIDPattern = #"^[a-f0-9]{32}$"#
  private static let hashPattern = #"^sha256:[a-f0-9]{64}$"#

  static func requestPayload(
    runtimeID: String,
    sessionID: String,
    workspaceID: String,
    instruction: String,
    mcpCapabilityHash: String?
  ) throws -> [String: Any] {
    guard validAgentTaskIdentifier(runtimeID),
          validAgentTaskIdentifier(workspaceID),
          validRequestID(sessionID),
          !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          instruction.unicodeScalars.count <= 32_768,
          mcpCapabilityHash.map({ matches($0, pattern: hashPattern) }) ?? true else {
      throw DeviceLinkFailure.invalid
    }
    var payload: [String: Any] = [
      "agent_runtime_id": runtimeID,
      "session_id": sessionID,
      "workspace_id": workspaceID,
      "instruction": instruction,
    ]
    if let mcpCapabilityHash {
      payload["mcp_capability_snapshot_hash"] = mcpCapabilityHash
    }
    return payload
  }

  static func runtimes(_ body: [String: Any]) throws -> [String] {
    guard DeviceLinkJSON.exactKeys(body, ["実行系"]),
          let values = body["実行系"] as? [String], values.count <= 128,
          values.allSatisfy(validRegisteredIdentifier), Set(values).count == values.count else {
      throw DeviceLinkFailure.invalid
    }
    return values
  }

  static func workspaces(_ body: [String: Any]) throws -> [MobileTaskWorkspace] {
    guard DeviceLinkJSON.exactKeys(body, ["作業領域"]),
          let rows = body["作業領域"] as? [[String: Any]], rows.count <= 16 else {
      throw DeviceLinkFailure.invalid
    }
    var seen = Set<String>()
    return try rows.map { row in
      guard DeviceLinkJSON.exactKeys(row, ["作業領域ID", "実行系ID"]),
            let workspaceID = DeviceLinkJSON.string(row["作業領域ID"]),
            validRegisteredIdentifier(workspaceID),
            let runtimeID = DeviceLinkJSON.string(row["実行系ID"]),
            validRegisteredIdentifier(runtimeID),
            seen.insert(workspaceID).inserted else {
        throw DeviceLinkFailure.invalid
      }
      return MobileTaskWorkspace(id: workspaceID, runtimeID: runtimeID)
    }
  }

  static func sessionID(_ body: [String: Any], runtimeID: String) throws -> String {
    guard DeviceLinkJSON.exactKeys(body, ["実行系ID", "状態", "対話セッションID"]),
          DeviceLinkJSON.string(body["実行系ID"]) == runtimeID,
          DeviceLinkJSON.string(body["状態"]) == "利用中",
          let sessionID = DeviceLinkJSON.string(body["対話セッションID"]),
          validRequestID(sessionID) else {
      throw DeviceLinkFailure.invalid
    }
    return sessionID
  }

  static func submission(
    _ body: [String: Any],
    runtimeID: String,
    sessionID: String,
    workspaceID: String
  ) throws -> MobileTaskDraft {
    let keys: Set<String> = [
      "版", "申請ID", "状態", "実行系ID", "対話セッションID", "作業領域ID", "指示hash", "期限",
    ]
    guard DeviceLinkJSON.exactKeys(body, keys),
          DeviceLinkJSON.integer(body["版"]) == 1,
          DeviceLinkJSON.string(body["状態"]) == "Owner確認待ち",
          DeviceLinkJSON.string(body["実行系ID"]) == runtimeID,
          DeviceLinkJSON.string(body["対話セッションID"]) == sessionID,
          DeviceLinkJSON.string(body["作業領域ID"]) == workspaceID,
          let requestID = DeviceLinkJSON.string(body["申請ID"]), validRequestID(requestID),
          let instructionHash = DeviceLinkJSON.string(body["指示hash"]), matches(instructionHash, pattern: hashPattern),
          let expiresAt = DeviceLinkJSON.integer(body["期限"]), expiresAt > 900 else {
      throw DeviceLinkFailure.invalid
    }
    return MobileTaskDraft(
      id: requestID,
      runtimeID: runtimeID,
      sessionID: sessionID,
      workspaceID: workspaceID,
      instructionHash: instructionHash,
      createdAt: expiresAt - 900,
      expiresAt: expiresAt,
      taskID: nil
    )
  }

  static func ownRequests(_ body: [String: Any]) throws -> [MobileTaskDraft] {
    guard DeviceLinkJSON.exactKeys(body, ["申請"]),
          let rows = body["申請"] as? [[String: Any]], rows.count <= 16 else {
      throw DeviceLinkFailure.invalid
    }
    let drafts = try rows.map(parseOwnRequest)
    guard Set(drafts.map(\.id)).count == drafts.count else { throw DeviceLinkFailure.invalid }
    return drafts
  }

  static func status(_ body: [String: Any], draft: MobileTaskDraft) throws -> MobileTaskStatus {
    guard DeviceLinkJSON.string(body["申請ID"]) == draft.id,
          let state = DeviceLinkJSON.string(body["状態"]) else {
      throw DeviceLinkFailure.invalid
    }
    switch state {
    case "Owner確認待ち":
      guard DeviceLinkJSON.exactKeys(body, ["申請ID", "状態"]) else { throw DeviceLinkFailure.invalid }
      return .ownerReviewPending
    case "開始候補":
      guard DeviceLinkJSON.exactKeys(body, ["申請ID", "状態"]) else { throw DeviceLinkFailure.invalid }
      return .startCandidate
    case "Task状態":
      guard DeviceLinkJSON.exactKeys(body, ["申請ID", "状態", "Task"]),
            let raw = body["Task"] as? [String: Any] else {
        throw DeviceLinkFailure.invalid
      }
      let record = try taskRecord(raw)
      guard matches(record, draft: draft) else { throw DeviceLinkFailure.invalid }
      return .task(record)
    default:
      throw DeviceLinkFailure.invalid
    }
  }

  static func started(_ body: [String: Any], draft: MobileTaskDraft) throws -> MobileTaskRecord {
    guard DeviceLinkJSON.exactKeys(body, ["申請ID", "状態", "Task"]),
          DeviceLinkJSON.string(body["申請ID"]) == draft.id,
          DeviceLinkJSON.string(body["状態"]) == "Task開始済み",
          let raw = body["Task"] as? [String: Any] else {
      throw DeviceLinkFailure.invalid
    }
    let record = try taskRecord(raw)
    guard matches(record, draft: draft) else { throw DeviceLinkFailure.invalid }
    return record
  }

  static func cancellationRequested(_ body: [String: Any], draft: MobileTaskDraft) throws -> MobileTaskRecord {
    guard DeviceLinkJSON.exactKeys(body, ["申請ID", "状態", "Task"]),
          DeviceLinkJSON.string(body["申請ID"]) == draft.id,
          DeviceLinkJSON.string(body["状態"]) == "Task取消要求済み",
          let raw = body["Task"] as? [String: Any] else {
      throw DeviceLinkFailure.invalid
    }
    let record = try taskRecord(raw)
    guard matches(record, draft: draft) else { throw DeviceLinkFailure.invalid }
    return record
  }

  static func mcpSnapshot(_ body: [String: Any]) throws -> MobileMCPCapabilitySnapshot {
    let keys: Set<String> = ["版", "Agent能力hash", "Agent能力件数", "Agent能力状態", "公開範囲"]
    guard DeviceLinkJSON.exactKeys(body, keys),
          DeviceLinkJSON.integer(body["版"]) == 1,
          DeviceLinkJSON.string(body["公開範囲"]) == "metadata_only",
          let countValue = DeviceLinkJSON.integer(body["Agent能力件数"]),
          (Int64(0)...Int64(128)).contains(countValue),
          let state = DeviceLinkJSON.string(body["Agent能力状態"]) else {
      throw DeviceLinkFailure.invalid
    }
    let hash: String?
    if body["Agent能力hash"] is NSNull {
      hash = nil
    } else if let rawHash = DeviceLinkJSON.string(body["Agent能力hash"]), matches(rawHash, pattern: hashPattern) {
      hash = rawHash
    } else {
      throw DeviceLinkFailure.invalid
    }
    if state == "available" {
      guard hash != nil else { throw DeviceLinkFailure.invalid }
    } else if state == "unsupported" {
      guard hash == nil, countValue == 0 else { throw DeviceLinkFailure.invalid }
    } else {
      throw DeviceLinkFailure.invalid
    }
    return MobileMCPCapabilitySnapshot(hash: hash, toolCount: Int(countValue), state: state)
  }

  static func validRuntimeIdentifier(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard (1...128).contains(scalars.count), let first = scalars.first,
          isAsciiAlphaNumeric(first.value) else { return false }
    return scalars.dropFirst().allSatisfy { scalar in
      isAsciiAlphaNumeric(scalar.value) || scalar.value == 0x5F || scalar.value == 0x2E ||
        scalar.value == 0x3A || scalar.value == 0x2D
    }
  }

  static func validSessionIdentifier(_ value: String) -> Bool {
    validRequestID(value)
  }

  private static func validRegisteredIdentifier(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard (1...128).contains(scalars.count), let first = scalars.first,
          isAsciiAlphaNumeric(first.value) else { return false }
    return scalars.dropFirst().allSatisfy { scalar in
      isAsciiAlphaNumeric(scalar.value) || scalar.value == 0x5F || scalar.value == 0x2E ||
        scalar.value == 0x2D
    }
  }

  private static func validAgentTaskIdentifier(_ value: String) -> Bool {
    guard validRuntimeIdentifier(value) else { return false }
    return true
  }

  private static func parseOwnRequest(_ row: [String: Any]) throws -> MobileTaskDraft {
    let keys: Set<String> = [
      "申請ID", "実行系ID", "対話セッションID", "作業領域ID", "指示hash", "作成時刻", "期限", "task_id",
    ]
    guard DeviceLinkJSON.exactKeys(row, keys),
          let requestID = DeviceLinkJSON.string(row["申請ID"]), validRequestID(requestID),
          let runtimeID = DeviceLinkJSON.string(row["実行系ID"]), validRegisteredIdentifier(runtimeID),
          let sessionID = DeviceLinkJSON.string(row["対話セッションID"]), validRequestID(sessionID),
          let workspaceID = DeviceLinkJSON.string(row["作業領域ID"]), validRegisteredIdentifier(workspaceID),
          let instructionHash = DeviceLinkJSON.string(row["指示hash"]), matches(instructionHash, pattern: hashPattern),
          let createdAt = DeviceLinkJSON.integer(row["作成時刻"]), createdAt > 0,
          let expiresAt = DeviceLinkJSON.integer(row["期限"]), expiresAt > createdAt else {
      throw DeviceLinkFailure.invalid
    }
    let taskID: String?
    if row["task_id"] is NSNull {
      taskID = nil
    } else if let value = DeviceLinkJSON.string(row["task_id"]), validRequestID(value) {
      taskID = value
    } else {
      throw DeviceLinkFailure.invalid
    }
    return MobileTaskDraft(
      id: requestID,
      runtimeID: runtimeID,
      sessionID: sessionID,
      workspaceID: workspaceID,
      instructionHash: instructionHash,
      createdAt: createdAt,
      expiresAt: expiresAt,
      taskID: taskID
    )
  }

  private static func taskRecord(_ body: [String: Any]) throws -> MobileTaskRecord {
    let keys: Set<String> = [
      "task_id", "実行系ID", "対話セッションID", "作業領域ID", "指示hash", "状態", "結果hash", "結果本文あり",
    ]
    guard DeviceLinkJSON.exactKeys(body, keys),
          let taskID = DeviceLinkJSON.string(body["task_id"]), validRequestID(taskID),
          let runtimeID = DeviceLinkJSON.string(body["実行系ID"]), validRegisteredIdentifier(runtimeID),
          let sessionID = DeviceLinkJSON.string(body["対話セッションID"]), validRequestID(sessionID),
          let workspaceID = DeviceLinkJSON.string(body["作業領域ID"]), validRegisteredIdentifier(workspaceID),
          let instructionHash = DeviceLinkJSON.string(body["指示hash"]), matches(instructionHash, pattern: hashPattern),
          let state = DeviceLinkJSON.string(body["状態"]),
          ["pending", "running", "blocked", "completed", "failed", "cancelled", "quarantined"].contains(state),
          let resultContentAvailable = DeviceLinkJSON.boolean(body["結果本文あり"]) else {
      throw DeviceLinkFailure.invalid
    }
    let resultHash: String?
    if body["結果hash"] is NSNull {
      resultHash = nil
    } else if let value = DeviceLinkJSON.string(body["結果hash"]), matches(value, pattern: hashPattern) {
      resultHash = value
    } else {
      throw DeviceLinkFailure.invalid
    }
    return MobileTaskRecord(
      taskID: taskID,
      runtimeID: runtimeID,
      sessionID: sessionID,
      workspaceID: workspaceID,
      instructionHash: instructionHash,
      state: state,
      resultHash: resultHash,
      resultContentAvailable: resultContentAvailable
    )
  }

  private static func matches(_ record: MobileTaskRecord, draft: MobileTaskDraft) -> Bool {
    record.runtimeID == draft.runtimeID && record.sessionID == draft.sessionID &&
      record.workspaceID == draft.workspaceID && record.instructionHash == draft.instructionHash &&
      (draft.taskID == nil || draft.taskID == record.taskID)
  }

  private static func validRequestID(_ value: String) -> Bool {
    matches(value, pattern: requestIDPattern)
  }

  private static func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }

  private static func isAsciiAlphaNumeric(_ value: UInt32) -> Bool {
    (0x30...0x39).contains(value) || (0x41...0x5A).contains(value) || (0x61...0x7A).contains(value)
  }
}
