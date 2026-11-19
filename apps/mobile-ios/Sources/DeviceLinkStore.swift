import Foundation
import Security

struct DeviceLinkStoredState {
  let deviceID: String
  let credential: DeviceLinkCredential?
  let recoveryAudit: [[String: Any]]
  let pendingTaskSubmission: PendingMobileTaskSubmission?
  let pendingTaskMutations: [PendingMobileTaskMutation]
  let pendingRevocation: PendingDeviceLinkRevocation?
  let installScopeID: String?

  var usableCredential: DeviceLinkCredential? {
    guard pendingRevocation == nil, let credential, !credential.isExpired() else { return nil }
    return credential
  }
}

final class DeviceLinkStore {
  private let service = "com.bluetanuki.ios.device-link.v1"
  private let account = "native-state"
  private let installMarker = DeviceLinkInstallMarker()
  private(set) var reinstallReviewRequired = false

  func loadOrCreate() throws -> DeviceLinkStoredState {
    let install = try installMarker.loadOrCreate()
    reinstallReviewRequired = install.reinstallDetected && !install.reinstallReviewAcknowledged
    if let stored = try read() {
      if let storedInstallScopeID = stored.installScopeID {
        if storedInstallScopeID == install.id {
          if install.pending { try installMarker.markReady(id: install.id) }
          return stored
        }
        guard install.pending else { throw DeviceLinkFailure.storage }
        try installMarker.markReinstallDetected(id: install.id)
        reinstallReviewRequired = true
        let recovered = try recoveryStateAfterReinstall(stored, installScopeID: install.id)
        try write(recovered)
        guard let verified = try read(), equivalent(verified, recovered) else {
          throw DeviceLinkFailure.storage
        }
        try installMarker.markReady(id: install.id)
        return verified
      }
      if install.reinstallDetected {
        guard install.pending else { throw DeviceLinkFailure.storage }
        try installMarker.markReinstallDetected(id: install.id)
        reinstallReviewRequired = true
        let recovered = try recoveryStateAfterReinstall(stored, installScopeID: install.id)
        try write(recovered)
        guard let verified = try read(), equivalent(verified, recovered) else {
          throw DeviceLinkFailure.storage
        }
        try installMarker.markReady(id: install.id)
        return verified
      }
      let migrated = DeviceLinkStoredState(
        deviceID: stored.deviceID,
        credential: stored.credential,
        recoveryAudit: stored.recoveryAudit,
        pendingTaskSubmission: stored.pendingTaskSubmission,
        pendingTaskMutations: stored.pendingTaskMutations,
        pendingRevocation: stored.pendingRevocation,
        installScopeID: install.id
      )
      try write(migrated)
      guard let verified = try read(), equivalent(verified, migrated) else {
        throw DeviceLinkFailure.storage
      }
      try installMarker.markReady(id: install.id)
      return verified
    }
    let initial = try initialState(installScopeID: install.id)
    try write(initial)
    guard let verified = try read(), equivalent(verified, initial) else {
      throw DeviceLinkFailure.storage
    }
    try installMarker.markReady(id: install.id)
    return verified
  }

  private func initialState(installScopeID: String) throws -> DeviceLinkStoredState {
    DeviceLinkStoredState(
      deviceID: try DeviceLinkJSON.randomHex(byteCount: 16),
      credential: nil,
      recoveryAudit: [],
      pendingTaskSubmission: nil,
      pendingTaskMutations: [],
      pendingRevocation: nil,
      installScopeID: installScopeID
    )
  }

  private func recoveryStateAfterReinstall(
    _ stored: DeviceLinkStoredState,
    installScopeID: String
  ) throws -> DeviceLinkStoredState {
    let audit: [[String: Any]]
    if stored.credential == nil {
      audit = stored.recoveryAudit
    } else {
      audit = try DeviceLinkLocalRecoveryAudit.append(
        stored.recoveryAudit,
        event: DeviceLinkLocalRecoveryAudit.event()
      )
    }
    return DeviceLinkStoredState(
      deviceID: stored.deviceID,
      credential: nil,
      recoveryAudit: audit,
      pendingTaskSubmission: stored.pendingTaskSubmission,
      pendingTaskMutations: stored.pendingTaskMutations,
      pendingRevocation: stored.pendingRevocation,
      installScopeID: installScopeID
    )
  }

  func acknowledgeReinstallReview() throws {
    let install = try installMarker.loadOrCreate()
    guard !install.pending, install.reinstallDetected, !install.reinstallReviewAcknowledged else {
      throw DeviceLinkFailure.storage
    }
    guard let state = try read(), state.installScopeID == install.id, state.credential == nil else {
      throw DeviceLinkFailure.storage
    }
    if state.pendingRevocation != nil {
      // 再インストール時に発行した端末内削除記録を、明示確認後に保留と結び付けて閉じる。
      guard !state.recoveryAudit.isEmpty else { throw DeviceLinkFailure.storage }
      _ = try updateRevocation(nil, credential: nil, from: state)
    }
    try installMarker.markReinstallReviewAcknowledged(id: install.id)
    reinstallReviewRequired = false
  }

  func storeCredential(_ credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard !reinstallReviewRequired, before.credential == nil, before.pendingRevocation == nil,
          before.deviceID == credential.deviceID else {
      throw DeviceLinkFailure.storage
    }
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSubmission: before.pendingTaskSubmission,
      pendingTaskMutations: before.pendingTaskMutations,
      pendingRevocation: nil,
      installScopeID: before.installScopeID
    )
    try write(next)
    guard let verified = try read(), equivalent(verified, next) else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func markRevocationPending(_ credential: DeviceLinkCredential) throws -> PendingDeviceLinkRevocation {
    let before = try loadOrCreate()
    guard !reinstallReviewRequired, before.credential == credential, !credential.isExpired(),
          before.pendingRevocation == nil else { throw DeviceLinkFailure.storage }
    let pending = try PendingDeviceLinkRevocation(credential: credential)
    _ = try updateRevocation(pending, credential: credential, from: before)
    return pending
  }

  func canUseCredential(_ credential: DeviceLinkCredential,
                        pendingRevocation: PendingDeviceLinkRevocation? = nil) throws -> Bool {
    guard let current = try read() else { return false }
    return current.credential == credential && current.pendingRevocation == pendingRevocation
  }

  func canUseInvitation(_ invitation: DeviceLinkCredential) throws -> Bool {
    guard !reinstallReviewRequired, let current = try read() else { return false }
    return current.deviceID == invitation.deviceID && current.credential == nil && current.pendingRevocation == nil
  }

  func clearUnsentRevocation(_ pending: PendingDeviceLinkRevocation,
                             credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    guard let before = try read(), before.credential == credential,
          before.pendingRevocation == pending else { throw DeviceLinkFailure.storage }
    return try updateRevocation(nil, credential: credential, from: before)
  }

  func clearConfirmedRevocation(_ pending: PendingDeviceLinkRevocation,
                                credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    guard let before = try read(), before.credential == credential,
          before.pendingRevocation == pending else { throw DeviceLinkFailure.storage }
    return try updateRevocation(nil, credential: nil, from: before)
  }

  private func updateRevocation(_ pending: PendingDeviceLinkRevocation?, credential: DeviceLinkCredential?,
                                from before: DeviceLinkStoredState) throws -> DeviceLinkStoredState {
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSubmission: before.pendingTaskSubmission,
      pendingTaskMutations: before.pendingTaskMutations,
      pendingRevocation: pending,
      installScopeID: before.installScopeID
    )
    try write(next)
    guard let verified = try read(), equivalent(verified, next) else {
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
      pendingTaskSubmission: before.pendingTaskSubmission,
      pendingTaskMutations: before.pendingTaskMutations,
      pendingRevocation: nil,
      installScopeID: before.installScopeID
    )
    try write(next)
    guard let verified = try read(), equivalent(verified, next),
          let recorded = verified.recoveryAudit.last,
          NSDictionary(dictionary: recorded).isEqual(to: event) else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func markTaskSubmissionPending(_ pending: PendingMobileTaskSubmission,
                                 credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard !reinstallReviewRequired, before.pendingRevocation == nil,
          before.credential == credential, !credential.isExpired(),
          !pending.isLegacy, before.pendingTaskSubmission == nil else {
      throw DeviceLinkFailure.storage
    }
    return try updateTaskSubmission(pending, from: before)
  }

  func clearTaskSubmissionPending(_ expected: PendingMobileTaskSubmission,
                                  credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    guard let before = try read(), before.pendingRevocation == nil,
          before.credential == credential, !credential.isExpired(),
          !expected.isLegacy, before.pendingTaskSubmission == expected else { throw DeviceLinkFailure.storage }
    return try updateTaskSubmission(nil, from: before)
  }

  private func updateTaskSubmission(_ pending: PendingMobileTaskSubmission?,
                                    from before: DeviceLinkStoredState) throws -> DeviceLinkStoredState {
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: before.credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSubmission: pending,
      pendingTaskMutations: before.pendingTaskMutations,
      pendingRevocation: before.pendingRevocation,
      installScopeID: before.installScopeID
    )
    try write(next)
    guard let verified = try read(), equivalent(verified, next) else {
      throw DeviceLinkFailure.storage
    }
    return verified
  }

  func markTaskMutationPending(_ mutation: PendingMobileTaskMutation,
                               credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    let before = try loadOrCreate()
    guard !reinstallReviewRequired, before.pendingRevocation == nil,
          before.credential == credential, !credential.isExpired(),
          let digest = mutation.requestDigest,
          !PendingMobileTaskMutation.blocksRequest(before.pendingTaskMutations, digest: digest) else {
      throw DeviceLinkFailure.storage
    }
    return try updateTaskMutations(before.pendingTaskMutations + [mutation], from: before)
  }

  func clearTaskMutationPending(_ expected: PendingMobileTaskMutation,
                                credential: DeviceLinkCredential) throws -> DeviceLinkStoredState {
    guard let before = try read(), before.pendingRevocation == nil, before.credential == credential,
          let index = before.pendingTaskMutations.firstIndex(of: expected) else {
      throw DeviceLinkFailure.storage
    }
    var mutations = before.pendingTaskMutations
    mutations.remove(at: index)
    return try updateTaskMutations(mutations, from: before)
  }

  private func updateTaskMutations(_ mutations: [PendingMobileTaskMutation],
                                   from before: DeviceLinkStoredState) throws -> DeviceLinkStoredState {
    let next = DeviceLinkStoredState(
      deviceID: before.deviceID,
      credential: before.credential,
      recoveryAudit: before.recoveryAudit,
      pendingTaskSubmission: before.pendingTaskSubmission,
      pendingTaskMutations: mutations,
      pendingRevocation: before.pendingRevocation,
      installScopeID: before.installScopeID
    )
    try write(next)
    guard let verified = try read(), equivalent(verified, next) else {
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

  func read() throws -> DeviceLinkStoredState? {
    guard var data = try readData() else { return nil }
    defer { data.resetBytes(in: 0..<data.count) }
    let object = try DeviceLinkJSON.object(data, maximumBytes: 16 * 1024)
    guard let version = DeviceLinkJSON.integer(object["version"]) else {
      throw DeviceLinkFailure.storage
    }
    let versionOneKeys: Set<String> = ["version", "device_id", "credential", "local_recovery_audit"]
    let versionTwoKeys = versionOneKeys.union(["pending_task_session_id"])
    let versionThreeKeys = versionTwoKeys.union(["install_scope_id"])
    let versionFourKeys = versionThreeKeys.union(["pending_task_mutation"])
    let versionFiveKeys = versionFourKeys.subtracting(["pending_task_session_id"]).union(["pending_task_submission"])
    let versionSixKeys = versionFiveKeys.union(["pending_revocation"])
    let versionSevenKeys = versionSixKeys.subtracting(["pending_task_mutation"]).union(["pending_task_mutations"])
    let validShape = (version == 1 && DeviceLinkJSON.exactKeys(object, versionOneKeys)) ||
      (version == 2 && DeviceLinkJSON.exactKeys(object, versionTwoKeys)) ||
      (version == 3 && DeviceLinkJSON.exactKeys(object, versionThreeKeys)) ||
      (version == 4 && DeviceLinkJSON.exactKeys(object, versionFourKeys)) ||
      (version == 5 && DeviceLinkJSON.exactKeys(object, versionFiveKeys)) ||
      (version == 6 && DeviceLinkJSON.exactKeys(object, versionSixKeys)) ||
      (version == 7 && DeviceLinkJSON.exactKeys(object, versionSevenKeys))
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
    let pendingTaskSubmission: PendingMobileTaskSubmission?
    if version >= 5 {
      let raw = object["pending_task_submission"]
      if let saved = raw as? [String: Any] {
        pendingTaskSubmission = try PendingMobileTaskSubmission(stored: saved)
      } else if version >= 6, let sessionID = raw as? String {
        pendingTaskSubmission = try PendingMobileTaskSubmission(legacySessionID: sessionID)
      } else if version >= 6, raw is NSNull {
        pendingTaskSubmission = nil
      } else {
        throw DeviceLinkFailure.storage
      }
    } else if version == 1 || object["pending_task_session_id"] is NSNull {
      pendingTaskSubmission = nil
    } else if let value = object["pending_task_session_id"] as? String {
      pendingTaskSubmission = try PendingMobileTaskSubmission(legacySessionID: value)
    } else {
      throw DeviceLinkFailure.storage
    }
    let installScopeID: String?
    if version < 3 {
      installScopeID = nil
    } else if let value = object["install_scope_id"] as? String, DeviceLinkJSON.isHex(value, length: 32) {
      installScopeID = value
    } else {
      throw DeviceLinkFailure.storage
    }
    let pendingTaskMutations: [PendingMobileTaskMutation]
    if version == 7 {
      pendingTaskMutations = try PendingMobileTaskMutation.readCollection(object["pending_task_mutations"])
    } else if version < 4 || object["pending_task_mutation"] is NSNull {
      pendingTaskMutations = []
    } else if let raw = object["pending_task_mutation"] as? [String: Any] {
      pendingTaskMutations = [try PendingMobileTaskMutation(stored: raw, scoped: false)]
    } else {
      throw DeviceLinkFailure.storage
    }
    let pendingRevocation: PendingDeviceLinkRevocation?
    if version <= 5 || (version == 7 && object["pending_revocation"] is NSNull) {
      pendingRevocation = nil
    } else if let raw = object["pending_revocation"] as? String {
      let saved = try PendingDeviceLinkRevocation(stored: raw)
      if let credential {
        guard try saved.matches(credential) else { throw DeviceLinkFailure.storage }
      } else {
        guard !rawAudit.isEmpty else { throw DeviceLinkFailure.storage }
      }
      pendingRevocation = saved
    } else {
      throw DeviceLinkFailure.storage
    }
    return DeviceLinkStoredState(
      deviceID: deviceID,
      credential: credential,
      recoveryAudit: rawAudit,
      pendingTaskSubmission: pendingTaskSubmission,
      pendingTaskMutations: pendingTaskMutations,
      pendingRevocation: pendingRevocation,
      installScopeID: installScopeID
    )
  }

  private func write(_ state: DeviceLinkStoredState) throws {
    guard let installScopeID = state.installScopeID, DeviceLinkJSON.isHex(installScopeID, length: 32) else {
      throw DeviceLinkFailure.storage
    }
    var object: [String: Any] = [
      "version": 3,
      "device_id": state.deviceID,
      "credential": state.credential.map { $0.storageObject() as Any } ?? NSNull(),
      "local_recovery_audit": state.recoveryAudit,
      "pending_task_session_id": state.pendingTaskSubmission.map { $0.sessionID as Any } ?? NSNull(),
      "install_scope_id": installScopeID,
    ]
    // 照合後に旧形式へ戻す。保留中の照合範囲を旧版へ渡さない。
    let pendingSubmission = state.pendingTaskSubmission?.storageObject()
    let mutations = state.pendingTaskMutations.map { $0.storageObject() }
    _ = try PendingMobileTaskMutation.readCollection(mutations)
    if state.pendingRevocation != nil || state.pendingTaskMutations.contains(where: { $0.requestDigest != nil }) {
      object["version"] = 7
      object.removeValue(forKey: "pending_task_session_id")
      object["pending_task_submission"] = pendingSubmission.map { $0 as Any }
        ?? state.pendingTaskSubmission.map { $0.sessionID as Any } ?? NSNull()
      object["pending_task_mutations"] = mutations
      object["pending_revocation"] = state.pendingRevocation.map { $0.credentialDigest as Any } ?? NSNull()
    } else if let pending = pendingSubmission {
      object["version"] = 5
      object.removeValue(forKey: "pending_task_session_id")
      object["pending_task_submission"] = pending
      object["pending_task_mutation"] = state.pendingTaskMutations.first.map { $0.storageObject() as Any } ?? NSNull()
    } else if let pending = state.pendingTaskMutations.first {
      object["version"] = 4
      object["pending_task_mutation"] = pending.storageObject()
    }
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

  private func equivalent(_ left: DeviceLinkStoredState, _ right: DeviceLinkStoredState) -> Bool {
    left.deviceID == right.deviceID && left.credential == right.credential &&
      auditEquals(left.recoveryAudit, right.recoveryAudit) &&
      left.pendingTaskSubmission == right.pendingTaskSubmission &&
      left.pendingTaskMutations == right.pendingTaskMutations &&
      left.pendingRevocation == right.pendingRevocation &&
      left.installScopeID == right.installScopeID
  }

}

private struct DeviceLinkInstallScope {
  let id: String
  let pending: Bool
  let reinstallDetected: Bool
  let reinstallReviewAcknowledged: Bool
}

/** A sandbox marker lets a reinstall discard Keychain state that outlives the app container. */
private final class DeviceLinkInstallMarker {
  private let schema = "blue-tanuki.ios.install-scope.v1"
  private let filename = ".blue-tanuki-install-scope-v1.json"

  func loadOrCreate() throws -> DeviceLinkInstallScope {
    let url = try markerURL()
    if FileManager.default.fileExists(atPath: url.path) {
      return try read(url)
    }
    let scope = DeviceLinkInstallScope(
      id: try DeviceLinkJSON.randomHex(byteCount: 16), pending: true,
      reinstallDetected: false, reinstallReviewAcknowledged: false
    )
    try write(scope, to: url)
    return scope
  }

  func markReinstallDetected(id: String) throws {
    let url = try markerURL()
    let current = try read(url)
    guard current.id == id, current.pending else { throw DeviceLinkFailure.storage }
    if !current.reinstallDetected || current.reinstallReviewAcknowledged {
      try write(DeviceLinkInstallScope(
        id: id, pending: true, reinstallDetected: true, reinstallReviewAcknowledged: false
      ), to: url)
    }
  }

  func markReinstallReviewAcknowledged(id: String) throws {
    let url = try markerURL()
    let current = try read(url)
    guard current.id == id, !current.pending, current.reinstallDetected else {
      throw DeviceLinkFailure.storage
    }
    try write(DeviceLinkInstallScope(
      id: id, pending: false, reinstallDetected: true, reinstallReviewAcknowledged: true
    ), to: url)
  }

  func markReady(id: String) throws {
    let url = try markerURL()
    let current = try read(url)
    guard current.id == id else { throw DeviceLinkFailure.storage }
    guard current.pending else { return }
    try write(DeviceLinkInstallScope(
      id: id, pending: false, reinstallDetected: current.reinstallDetected,
      reinstallReviewAcknowledged: current.reinstallReviewAcknowledged
    ), to: url)
  }

  private func markerURL() throws -> URL {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw DeviceLinkFailure.storage
    }
    let directory = support.appendingPathComponent("BlueTanuki", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      return directory.appendingPathComponent(filename, isDirectory: false)
    } catch {
      throw DeviceLinkFailure.storage
    }
  }

  private func read(_ url: URL) throws -> DeviceLinkInstallScope {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
            let size = attributes[.size] as? NSNumber, size.intValue <= 512 else {
        throw DeviceLinkFailure.storage
      }
      let data = try Data(contentsOf: url, options: [.mappedIfSafe])
      let object = try DeviceLinkJSON.object(data, maximumBytes: 512)
      guard DeviceLinkJSON.exactKeys(object, ["schema_version", "install_scope_id", "state",
        "reinstall_detected", "reinstall_review_acknowledged"]),
            object["schema_version"] as? String == schema,
            let id = object["install_scope_id"] as? String, DeviceLinkJSON.isHex(id, length: 32),
            let state = object["state"] as? String, state == "pending" || state == "ready",
            let reinstallDetected = DeviceLinkJSON.boolean(object["reinstall_detected"]),
            let reinstallReviewAcknowledged = DeviceLinkJSON.boolean(object["reinstall_review_acknowledged"]),
            (!reinstallReviewAcknowledged || (reinstallDetected && state == "ready")) else {
        throw DeviceLinkFailure.storage
      }
      try ensureExcludedFromBackup(url)
      return DeviceLinkInstallScope(
        id: id, pending: state == "pending", reinstallDetected: reinstallDetected,
        reinstallReviewAcknowledged: reinstallReviewAcknowledged
      )
    } catch let error as DeviceLinkFailure {
      throw error
    } catch {
      throw DeviceLinkFailure.storage
    }
  }

  private func write(_ scope: DeviceLinkInstallScope, to url: URL) throws {
    do {
      let object: [String: Any] = [
        "schema_version": schema,
        "install_scope_id": scope.id,
        "state": scope.pending ? "pending" : "ready",
        "reinstall_detected": scope.reinstallDetected,
        "reinstall_review_acknowledged": scope.reinstallReviewAcknowledged,
      ]
      let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
      try data.write(to: url, options: [.atomic])
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
      try ensureExcludedFromBackup(url)
      let verified = try read(url)
      guard verified.id == scope.id, verified.pending == scope.pending,
            verified.reinstallDetected == scope.reinstallDetected,
            verified.reinstallReviewAcknowledged == scope.reinstallReviewAcknowledged else {
        throw DeviceLinkFailure.storage
      }
    } catch let error as DeviceLinkFailure {
      throw error
    } catch {
      throw DeviceLinkFailure.storage
    }
  }

  private func ensureExcludedFromBackup(_ url: URL) throws {
    do {
      try (url as NSURL).setResourceValue(true, forKey: .isExcludedFromBackupKey)
      let excluded = try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
      guard excluded else { throw DeviceLinkFailure.storage }
    } catch let error as DeviceLinkFailure {
      throw error
    } catch {
      throw DeviceLinkFailure.storage
    }
  }
}
