import Foundation
import Security

struct DeviceLinkStoredState {
  let deviceID: String
  let credential: DeviceLinkCredential?
  let recoveryAudit: [[String: Any]]
  let pendingTaskSessionID: String?
}

final class DeviceLinkStore {
  private let service = "com.bluetanuki.ios.device-link.v1"
  private let account = "native-state"

  func loadOrCreate() throws -> DeviceLinkStoredState {
    if let stored = try read() { return stored }
    let initial = DeviceLinkStoredState(
      deviceID: try DeviceLinkJSON.randomHex(byteCount: 16),
      credential: nil,
      recoveryAudit: [],
      pendingTaskSessionID: nil
    )
    try write(initial)
    guard let verified = try read(), verified.deviceID == initial.deviceID,
          verified.credential == nil, verified.recoveryAudit.isEmpty,
          verified.pendingTaskSessionID == nil else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func storeCredential(_ credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard before.credential == nil, before.deviceID == credential.deviceID else {
      throw DeviceLinkFailure.storage
    }
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSessionID: before.pendingTaskSessionID
    )
    try write(next)
    guard let verified = try read(), verified.deviceID == next.deviceID,
          verified.credential == next.credential,
          auditEquals(verified.recoveryAudit, next.recoveryAudit),
          verified.pendingTaskSessionID == next.pendingTaskSessionID else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func clearConfirmedRevocation() throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard before.credential != nil else { throw DeviceLinkFailure.storage }
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: nil,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSessionID: before.pendingTaskSessionID
    )
    try write(next)
    guard let verified = try read(), verified.deviceID == next.deviceID,
          verified.credential == nil,
          auditEquals(verified.recoveryAudit, next.recoveryAudit),
          verified.pendingTaskSessionID == next.pendingTaskSessionID else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func deleteCredentialLocallyWithAudit() throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard before.credential != nil else { throw DeviceLinkFailure.storage }
    let event = try DeviceLinkLocalRecoveryAudit.event()
    let nextAudit = try DeviceLinkLocalRecoveryAudit.append(before.recoveryAudit, event: event)
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: nil,
      recoveryAudit: nextAudit,
      pendingTaskSessionID: before.pendingTaskSessionID
    )
    try write(next)
    guard let verified = try read(), verified.deviceID == next.deviceID,
          verified.credential == nil,
          auditEquals(verified.recoveryAudit, nextAudit),
          verified.pendingTaskSessionID == next.pendingTaskSessionID,
          let recorded = verified.recoveryAudit.last,
          NSDictionary(dictionary: recorded).isEqual(to: event) else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func markTaskSubmissionPending(sessionID: String) throws -> DeviceLinkStoredState {
    guard MobileTaskContract.validSessionIdentifier(sessionID) else { throw DeviceLinkFailure.storage }
    let before = try loadOrCreate()
    guard before.credential != nil, before.pendingTaskSessionID == nil else {
      throw DeviceLinkFailure.storage
    }
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: before.credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSessionID: sessionID
    )
    try write(next)
    guard let verified = try read(), verified.deviceID == next.deviceID,
          verified.credential == next.credential,
          auditEquals(verified.recoveryAudit, next.recoveryAudit),
          verified.pendingTaskSessionID == sessionID else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func clearTaskSubmissionPending(sessionID: String) throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard before.pendingTaskSessionID == sessionID else { throw DeviceLinkFailure.storage }
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: before.credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSessionID: nil
    )
    try write(next)
    guard let verified = try read(), verified.deviceID == next.deviceID,
          verified.credential == next.credential,
          auditEquals(verified.recoveryAudit, next.recoveryAudit),
          verified.pendingTaskSessionID == nil else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  private var identityQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
  }

  private func readData() throws -> Data? {
    var query = identityQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw DeviceLinkFailure.storage
    }
    return data
  }

  private func read() throws -> DeviceLinkStoredState? {
    guard var data = try readData() else { return nil }
    defer { data.resetBytes(in: 0..<data.count) }
    let object = try DeviceLinkJSON.object(data, maximumBytes: 16 * 1024)
    let version = DeviceLinkJSON.integer(object["version"])
    let versionOneKeys: Set<String> = ["version", "device_id", "credential", "local_recovery_audit"]
    let versionTwoKeys: Set<String> = versionOneKeys.union(["pending_task_session_id"])
    let validShape = (version == 1 && DeviceLinkJSON.exactKeys(object, versionOneKeys)) ||
      (version == 2 && DeviceLinkJSON.exactKeys(object, versionTwoKeys))
    guard validShape,
          let deviceID = object["device_id"] as? String,
          DeviceLinkJSON.isHex(deviceID, length: 32),
          let rawAudit = object["local_recovery_audit"] as? [[String: Any]],
          rawAudit.count <= DeviceLinkLocalRecoveryAudit.maximumEvents,
          rawAudit.allSatisfy(DeviceLinkLocalRecoveryAudit.isValid) else {
      throw DeviceLinkFailure.storage
    }
    let credential: DeviceLinkCredential?
    if object["credential"] is NSNull {
      credential = nil
    } else if let rawCredential = object["credential"] as? [String: Any] {
      credential = try DeviceLinkCredential.stored(rawCredential, expectedDeviceID: deviceID)
    } else {
      throw DeviceLinkFailure.storage
    }
    let pendingTaskSessionID: String?
    if version == 1 || object["pending_task_session_id"] is NSNull {
      pendingTaskSessionID = nil
    } else if let value = object["pending_task_session_id"] as? String,
              MobileTaskContract.validSessionIdentifier(value) {
      pendingTaskSessionID = value
    } else {
      throw DeviceLinkFailure.storage
    }
    return DeviceLinkStoredState(
      deviceID: deviceID,
      credential: credential,
      recoveryAudit: rawAudit,
      pendingTaskSessionID: pendingTaskSessionID
    )
  }

  private func write(_ state: DeviceLinkStoredState) throws {
    let object: [String: Any] = [
      "version": 2,
      "device_id": state.deviceID,
      "credential": state.credential.map { $0.storageObject() as Any } ?? NSNull(),
      "local_recovery_audit": state.recoveryAudit,
      "pending_task_session_id": state.pendingTaskSessionID.map { $0 as Any } ?? NSNull(),
    ]
    var data = try DeviceLinkJSON.encode(object, maximumBytes: 16 * 1024)
    defer { data.resetBytes(in: 0..<data.count) }
    var attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
    let updateStatus = SecItemUpdate(identityQuery as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecItemNotFound {
      attributes[kSecClass as String] = kSecClassGenericPassword
      attributes[kSecAttrService as String] = service
      attributes[kSecAttrAccount as String] = account
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let addStatus = SecItemAdd(attributes as CFDictionary, nil)
      guard addStatus == errSecSuccess else { throw DeviceLinkFailure.storage }
      return
    }
    guard updateStatus == errSecSuccess else { throw DeviceLinkFailure.storage }
  }

  private func auditEquals(_ left: [[String: Any]], _ right: [[String: Any]]) -> Bool {
    NSDictionary(dictionary: ["events": left]).isEqual(to: ["events": right])
  }
}
