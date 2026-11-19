import CoreFoundation
import CryptoKit
import Foundation
import Security

enum DeviceLinkFailure: Error {
  case invalid
  case storage
  case rejected
  case suspended
  case transport(mayHaveReachedDesktop: Bool)
}

enum DeviceLinkJSON {
  static func object(_ data: Data, maximumBytes: Int) throws -> [String: Any] {
    guard !data.isEmpty, data.count <= maximumBytes,
          let value = try? JSONSerialization.jsonObject(with: data, options: []),
          let result = value as? [String: Any],
          JSONDuplicateKeyScanner(data: data).hasUniqueKeys() else {
      throw DeviceLinkFailure.invalid
    }
    return result
  }

  static func encode(_ object: [String: Any], maximumBytes: Int) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
          ),
          !data.isEmpty, data.count <= maximumBytes else {
      throw DeviceLinkFailure.invalid
    }
    return data
  }

  static func integer(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let cfNumber = unsafeBitCast(number, to: CFNumber.self)
    guard !CFNumberIsFloatType(cfNumber) else { return nil }
    return Int64(number.stringValue)
  }

  static func boolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func string(_ value: Any?) -> String? {
    value as? String
  }

  static func exactKeys(_ value: [String: Any], _ keys: Set<String>) -> Bool {
    Set(value.keys) == keys
  }

  static func randomHex(byteCount: Int) throws -> String {
    guard byteCount > 0, byteCount <= 64 else { throw DeviceLinkFailure.invalid }
    var bytes = [UInt8](repeating: 0, count: byteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw DeviceLinkFailure.storage
    }
    defer {
      for index in bytes.indices { bytes[index] = 0 }
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  static func isHex(_ value: String, length: Int) -> Bool {
    value.utf8.count == length &&
      value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
}

private final class JSONDuplicateKeyScanner {
  private let bytes: [UInt8]
  private var index = 0
  private let maximumDepth = 64

  init(data: Data) {
    bytes = Array(data)
  }

  func hasUniqueKeys() -> Bool {
    guard scanValue(depth: 0) else { return false }
    skipWhitespace()
    return index == bytes.count
  }

  private func scanValue(depth: Int) -> Bool {
    guard depth <= maximumDepth else { return false }
    skipWhitespace()
    guard index < bytes.count else { return false }
    switch bytes[index] {
    case 0x7B:
      return scanObject(depth: depth + 1)
    case 0x5B:
      return scanArray(depth: depth + 1)
    case 0x22:
      return skipString()
    default:
      return skipPrimitive()
    }
  }

  private func scanObject(depth: Int) -> Bool {
    index += 1
    skipWhitespace()
    if consume(0x7D) { return true }
    var keys = Set<String>()
    while index < bytes.count {
      skipWhitespace()
      guard index < bytes.count, bytes[index] == 0x22 else { return false }
      let keyStart = index
      guard skipString(),
            let key = decodeString(start: keyStart, end: index),
            keys.insert(key).inserted else { return false }
      skipWhitespace()
      guard consume(0x3A), scanValue(depth: depth) else { return false }
      skipWhitespace()
      if consume(0x7D) { return true }
      guard consume(0x2C) else { return false }
    }
    return false
  }

  private func scanArray(depth: Int) -> Bool {
    index += 1
    skipWhitespace()
    if consume(0x5D) { return true }
    while scanValue(depth: depth) {
      skipWhitespace()
      if consume(0x5D) { return true }
      guard consume(0x2C) else { return false }
    }
    return false
  }

  private func skipString() -> Bool {
    guard index < bytes.count, bytes[index] == 0x22 else { return false }
    index += 1
    while index < bytes.count {
      let byte = bytes[index]
      index += 1
      if byte == 0x22 { return true }
      if byte == 0x5C {
        guard index < bytes.count else { return false }
        index += 1
      }
    }
    return false
  }

  private func skipPrimitive() -> Bool {
    let start = index
    while index < bytes.count, !isDelimiter(bytes[index]) { index += 1 }
    return index > start
  }

  private func decodeString(start: Int, end: Int) -> String? {
    guard start < end else { return nil }
    var wrapped = Data([0x5B])
    wrapped.append(contentsOf: bytes[start..<end])
    wrapped.append(0x5D)
    guard let strings = try? JSONDecoder().decode([String].self, from: wrapped) else {
      return nil
    }
    return strings.first
  }

  private func skipWhitespace() {
    while index < bytes.count,
          bytes[index] == 0x20 || bytes[index] == 0x09 ||
            bytes[index] == 0x0A || bytes[index] == 0x0D {
      index += 1
    }
  }

  private func consume(_ byte: UInt8) -> Bool {
    guard index < bytes.count, bytes[index] == byte else { return false }
    index += 1
    return true
  }

  private func isDelimiter(_ byte: UInt8) -> Bool {
    byte == 0x2C || byte == 0x5D || byte == 0x7D ||
      byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
  }
}

struct DeviceLinkCredential: Equatable {
  let hostID: String
  let host: String
  let port: Int
  let certificateHash: String
  let deviceID: String
  let expiresAt: Int64
  let credentialID: String
  let secret: String

  func isExpired(now: Int64 = Int64(Date().timeIntervalSince1970)) -> Bool {
    expiresAt <= now
  }

  func storageObject() -> [String: Any] {
    [
      "版": 1, "HostID": hostID, "接続先Host": host, "port": port,
      "証明書hash": certificateHash, "端末ID": deviceID, "有効期限": expiresAt,
      "結合ID": credentialID, "端末秘密": secret,
    ]
  }

  static func invitation(
    _ raw: String,
    expectedDeviceID: String,
    now: Int64 = Int64(Date().timeIntervalSince1970)
  ) throws -> DeviceLinkCredential {
    guard let data = raw.data(using: .utf8) else { throw DeviceLinkFailure.invalid }
    let object = try DeviceLinkJSON.object(data, maximumBytes: 8 * 1024)
    let keys: Set<String> = [
      "版", "HostID", "接続先Host", "port", "証明書hash", "端末ID",
      "有効期限", "招待ID", "招待秘密",
    ]
    guard DeviceLinkJSON.exactKeys(object, keys) else { throw DeviceLinkFailure.invalid }
    return try parse(
      object,
      expectedDeviceID: expectedDeviceID,
      idKey: "招待ID",
      secretKey: "招待秘密",
      maximumLifetime: 5 * 60 + 60,
      now: now
    )
  }

  static func paired(
    _ object: [String: Any],
    invitation: DeviceLinkCredential,
    now: Int64 = Int64(Date().timeIntervalSince1970)
  ) throws -> DeviceLinkCredential {
    let keys: Set<String> = [
      "版", "HostID", "接続先Host", "port", "証明書hash", "端末ID",
      "有効期限", "結合ID", "端末秘密",
    ]
    guard DeviceLinkJSON.exactKeys(object, keys) else { throw DeviceLinkFailure.invalid }
    let credential = try parse(
      object,
      expectedDeviceID: invitation.deviceID,
      idKey: "結合ID",
      secretKey: "端末秘密",
      maximumLifetime: 8 * 60 * 60 + 60,
      now: now
    )
    guard credential.hostID == invitation.hostID,
          credential.host == invitation.host,
          credential.port == invitation.port,
          credential.certificateHash == invitation.certificateHash,
          credential.secret != invitation.secret else {
      throw DeviceLinkFailure.invalid
    }
    return credential
  }

  static func stored(
    _ object: [String: Any],
    expectedDeviceID: String,
    now: Int64 = Int64(Date().timeIntervalSince1970)
  ) throws -> DeviceLinkCredential {
    let keys: Set<String> = [
      "版", "HostID", "接続先Host", "port", "証明書hash", "端末ID",
      "有効期限", "結合ID", "端末秘密",
    ]
    guard DeviceLinkJSON.exactKeys(object, keys) else { throw DeviceLinkFailure.invalid }
    return try parse(
      object,
      expectedDeviceID: expectedDeviceID,
      idKey: "結合ID",
      secretKey: "端末秘密",
      maximumLifetime: 8 * 60 * 60 + 60,
      now: now,
      allowExpired: true
    )
  }

  private static func parse(
    _ object: [String: Any],
    expectedDeviceID: String,
    idKey: String,
    secretKey: String,
    maximumLifetime: Int64,
    now: Int64,
    allowExpired: Bool = false
  ) throws -> DeviceLinkCredential {
    guard DeviceLinkJSON.integer(object["版"]) == 1,
          let hostID = DeviceLinkJSON.string(object["HostID"]),
          DeviceLinkJSON.isHex(hostID, length: 32),
          let host = DeviceLinkJSON.string(object["接続先Host"]),
          isPrivateIPv4(host),
          let portValue = DeviceLinkJSON.integer(object["port"]),
          (1...65_535).contains(portValue),
          let certificateHash = DeviceLinkJSON.string(object["証明書hash"]),
          DeviceLinkJSON.isHex(certificateHash, length: 64),
          let deviceID = DeviceLinkJSON.string(object["端末ID"]),
          DeviceLinkJSON.isHex(deviceID, length: 32),
          deviceID == expectedDeviceID,
          let expiresAt = DeviceLinkJSON.integer(object["有効期限"]),
          expiresAt > 0,
          (allowExpired || expiresAt > now),
          expiresAt <= now + maximumLifetime,
          let credentialID = DeviceLinkJSON.string(object[idKey]),
          DeviceLinkJSON.isHex(credentialID, length: 32),
          let secret = DeviceLinkJSON.string(object[secretKey]),
          DeviceLinkJSON.isHex(secret, length: 64) else {
      throw DeviceLinkFailure.invalid
    }
    return DeviceLinkCredential(
      hostID: hostID,
      host: host,
      port: Int(portValue),
      certificateHash: certificateHash,
      deviceID: deviceID,
      expiresAt: expiresAt,
      credentialID: credentialID,
      secret: secret
    )
  }

  static func isPrivateIPv4(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    var octets = [Int]()
    for part in parts {
      guard !part.isEmpty, !(part.count > 1 && part.first == "0"),
            let value = Int(part), (0...255).contains(value),
            String(value) == part else { return false }
      octets.append(value)
    }
    return octets[0] == 127 || octets[0] == 10 ||
      (octets[0] == 172 && (16...31).contains(octets[1])) ||
      (octets[0] == 192 && octets[1] == 168)
  }
}

struct DesktopNotificationSummary: Equatable {
  static let operation = "通知一覧"
  static let maximumEntries = 16

  enum Source: String {
    case runtime = "Runtime", task = "Task", permission = "Permission", approval = "Approval"
    case audit = "Audit", recovery = "Recovery", device = "Device", mcp = "MCP", a2a = "A2A"
    case update = "Update", evaluation = "Evaluation"

    var label: String {
      switch self {
      case .runtime: return "実行系"
      case .task: return "仕事"
      case .permission: return "許可"
      case .approval: return "承認"
      case .audit: return "監査"
      case .recovery: return "復旧"
      case .device: return "端末"
      case .mcp: return "MCP"
      case .a2a: return "A2A"
      case .update: return "更新"
      case .evaluation: return "評価"
      }
    }
  }

  enum Severity: String {
    case info, warning, error, critical

    var label: String {
      switch self {
      case .info: return "情報"
      case .warning: return "注意"
      case .error: return "エラー"
      case .critical: return "重大"
      }
    }
  }

  struct Entry: Equatable {
    let source: Source
    let severity: Severity
    let unread: Bool
  }

  let entries: [Entry]
  let unreadCount: Int
  let criticalCount: Int

  static func read(_ body: [String: Any]) throws -> Self {
    guard DeviceLinkJSON.exactKeys(body, [
      "版", "通知一覧", "件数", "未読件数", "重大件数", "証拠種別", "表示範囲", "権限生成", "操作",
    ]), DeviceLinkJSON.integer(body["版"]) == 1,
      DeviceLinkJSON.string(body["証拠種別"]) == "INTERNAL_STATE",
      DeviceLinkJSON.string(body["表示範囲"]) == "summary",
      DeviceLinkJSON.string(body["権限生成"]) == "なし",
      DeviceLinkJSON.string(body["操作"]) == "navigation_only",
      let rows = body["通知一覧"] as? [[String: Any]], rows.count <= maximumEntries,
      DeviceLinkJSON.integer(body["件数"]) == Int64(rows.count) else {
      throw DeviceLinkFailure.invalid
    }
    var seen = Set<String>()
    let entries: [Entry] = try rows.map { row in
      guard DeviceLinkJSON.exactKeys(row, [
        "版", "通知ID", "source", "severity", "タイトル", "概要", "作成順", "関連監査ID", "関連監査hash",
        "遷移先", "状態", "通知hash", "表示範囲", "権限生成",
      ]), DeviceLinkJSON.integer(row["版"]) == 1,
        DeviceLinkJSON.string(row["表示範囲"]) == "summary",
        DeviceLinkJSON.string(row["権限生成"]) == "なし",
        let order = DeviceLinkJSON.integer(row["作成順"]), order > 0,
        let id = DeviceLinkJSON.string(row["通知ID"]),
        id.range(of: #"^notification-broker-audit-[1-9][0-9]*\z"#, options: .regularExpression) != nil,
        seen.insert(id).inserted,
        validText(row["タイトル"], maximumLength: 128), validText(row["概要"], maximumLength: 512),
        validText(row["関連監査ID"], maximumLength: 128), validHash(row["関連監査hash"]), validHash(row["通知hash"]),
        let destination = DeviceLinkJSON.string(row["遷移先"]),
        ["dashboard", "approval", "permission", "runtime", "audit", "recovery", "device", "agent", "settings", "evaluation"].contains(destination),
        let sourceName = DeviceLinkJSON.string(row["source"]), let source = Source(rawValue: sourceName),
        let severityName = DeviceLinkJSON.string(row["severity"]), let severity = Severity(rawValue: severityName),
        let state = DeviceLinkJSON.string(row["状態"]), ["unread", "read"].contains(state) else {
        throw DeviceLinkFailure.invalid
      }
      return Entry(source: source, severity: severity, unread: state == "unread")
    }
    let unreadCount = entries.filter(\.unread).count
    let criticalCount = entries.filter { $0.severity == .critical }.count
    guard DeviceLinkJSON.integer(body["未読件数"]) == Int64(unreadCount),
          DeviceLinkJSON.integer(body["重大件数"]) == Int64(criticalCount) else {
      throw DeviceLinkFailure.invalid
    }
    return Self(entries: entries, unreadCount: unreadCount, criticalCount: criticalCount)
  }

  private static func validText(_ value: Any?, maximumLength: Int) -> Bool {
    guard let text = DeviceLinkJSON.string(value) else { return false }
    return !text.isEmpty && text.unicodeScalars.count <= maximumLength
  }

  private static func validHash(_ value: Any?) -> Bool {
    guard let text = DeviceLinkJSON.string(value), text.hasPrefix("sha256:") else { return false }
    return DeviceLinkJSON.isHex(String(text.dropFirst(7)), length: 64)
  }
}

struct PendingDeviceLinkRevocation: Equatable {
  let credentialDigest: String

  init(credential: DeviceLinkCredential) throws {
    var bytes = try DeviceLinkJSON.encode([
      "scope": "blue-tanuki.ios.device-link-revocation.v1",
      "credential": credential.storageObject(),
    ], maximumBytes: 4096)
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    credentialDigest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  init(stored: String) throws {
    guard DeviceLinkJSON.isHex(stored, length: 64) else { throw DeviceLinkFailure.storage }
    credentialDigest = stored
  }

  func matches(_ credential: DeviceLinkCredential) throws -> Bool {
    self == (try Self(credential: credential))
  }
}

enum DeviceLinkProtocol {
  static let evidenceSources: Set<String> = [
    "LIVE_RUNTIME", "INTERNAL_STATE", "CONFIG", "EXTERNAL_EVIDENCE", "FIXTURE",
  ]

  static func requireConfirmedRevocation(_ envelope: [String: Any], nonce: String) throws {
    guard DeviceLinkJSON.string(envelope["evidence_source"]) == "INTERNAL_STATE" else {
      throw DeviceLinkFailure.invalid
    }
    let body = try acceptedBody(envelope, nonce: nonce, operation: "端末離脱")
    guard DeviceLinkJSON.exactKeys(body, ["状態"]), DeviceLinkJSON.string(body["状態"]) == "失効" else {
      throw DeviceLinkFailure.invalid
    }
  }

  static func acceptedBody(
    _ envelope: [String: Any],
    nonce: String,
    operation: String
  ) throws -> [String: Any] {
    let keys: Set<String> = [
      "request_id", "operation", "status", "evidence_source", "audit_event_id",
      "error", "health", "body", "shutdown_requested",
    ]
    guard DeviceLinkJSON.exactKeys(envelope, keys),
          DeviceLinkJSON.string(envelope["request_id"]) == nonce,
          DeviceLinkJSON.string(envelope["operation"]) == operation,
          DeviceLinkJSON.boolean(envelope["shutdown_requested"]) == false,
          envelope["health"] is NSNull,
          let evidence = DeviceLinkJSON.string(envelope["evidence_source"]),
          evidenceSources.contains(evidence),
          let auditID = DeviceLinkJSON.string(envelope["audit_event_id"]),
          !auditID.isEmpty, auditID.utf8.count <= 256,
          auditID.unicodeScalars.allSatisfy({
            CharacterSet.alphanumerics.contains($0) || "_.:-".unicodeScalars.contains($0)
          }) else {
      throw DeviceLinkFailure.invalid
    }

    guard let status = DeviceLinkJSON.string(envelope["status"]) else {
      throw DeviceLinkFailure.invalid
    }
    if status == "rejected" || status == "suspended" {
      guard envelope["body"] is NSNull,
            let error = envelope["error"] as? [String: Any],
            DeviceLinkJSON.exactKeys(
              error,
              ["code", "message", "recoverable", "audit_event_required", "fail_closed"]
            ),
            let code = DeviceLinkJSON.string(error["code"]),
            (1...96).contains(code.utf8.count),
            code.unicodeScalars.allSatisfy({
              CharacterSet.alphanumerics.contains($0) || "_.-".unicodeScalars.contains($0)
            }),
            let message = DeviceLinkJSON.string(error["message"]),
            message.utf8.count <= 1_048_576,
            DeviceLinkJSON.boolean(error["recoverable"]) != nil,
            DeviceLinkJSON.boolean(error["audit_event_required"]) != nil,
            DeviceLinkJSON.boolean(error["fail_closed"]) != nil else {
        throw DeviceLinkFailure.invalid
      }
      throw status == "rejected" ? DeviceLinkFailure.rejected : DeviceLinkFailure.suspended
    }
    guard status == "accepted", envelope["error"] is NSNull,
          let body = envelope["body"] as? [String: Any] else {
      throw DeviceLinkFailure.invalid
    }
    return body
  }
}

enum DeviceLinkLocalRecoveryAudit {
  static let maximumEvents = 32
  private static let payloadMarker = "blue-tanuki/ios/local-credential-delete/v1"
  private static let payloadHash = "sha256:" +
    SHA256.hash(data: Data(payloadMarker.utf8))
      .map { String(format: "%02x", $0) }.joined()

  static func event() throws -> [String: Any] {
    let timestamp = ISO8601DateFormatter().string(from: Date())
    return [
      "event_id": try DeviceLinkJSON.randomHex(byteCount: 16),
      "timestamp": timestamp,
      "actor": "shell",
      "action": "mobile_local_credential_delete",
      "target": "mobile_device_link_credential",
      "result": "success",
      "payload_hash": payloadHash,
      "metadata": [
        "audit_scope": "mobile_local_recovery",
        "evidence_source": "INTERNAL_STATE",
        "desktop_revocation": "unconfirmed",
        "authority_effect": "none",
        "operator_identity": "unverified",
      ],
    ]
  }

  static func append(_ events: [[String: Any]], event: [String: Any]) throws -> [[String: Any]] {
    guard events.count <= maximumEvents, events.allSatisfy(isValid),
          isValid(event),
          let eventID = event["event_id"] as? String,
          !events.contains(where: { ($0["event_id"] as? String) == eventID }) else {
      throw DeviceLinkFailure.invalid
    }
    return Array((events + [event]).suffix(maximumEvents))
  }

  static func isValid(_ event: [String: Any]) -> Bool {
    let keys: Set<String> = [
      "event_id", "timestamp", "actor", "action", "target", "result", "payload_hash", "metadata",
    ]
    guard DeviceLinkJSON.exactKeys(event, keys),
          let eventID = event["event_id"] as? String,
          DeviceLinkJSON.isHex(eventID, length: 32),
          let timestamp = event["timestamp"] as? String,
          ISO8601DateFormatter().date(from: timestamp) != nil,
          event["actor"] as? String == "shell",
          event["action"] as? String == "mobile_local_credential_delete",
          event["target"] as? String == "mobile_device_link_credential",
          event["result"] as? String == "success",
          event["payload_hash"] as? String == payloadHash,
          let metadata = event["metadata"] as? [String: Any] else { return false }
    let metadataKeys: Set<String> = [
      "audit_scope", "evidence_source", "desktop_revocation", "authority_effect", "operator_identity",
    ]
    return DeviceLinkJSON.exactKeys(metadata, metadataKeys) &&
      metadata["audit_scope"] as? String == "mobile_local_recovery" &&
      metadata["evidence_source"] as? String == "INTERNAL_STATE" &&
      metadata["desktop_revocation"] as? String == "unconfirmed" &&
      metadata["authority_effect"] as? String == "none" &&
      metadata["operator_identity"] as? String == "unverified"
  }
}
