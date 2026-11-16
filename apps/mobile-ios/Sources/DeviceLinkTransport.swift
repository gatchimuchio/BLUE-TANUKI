import CryptoKit
import Foundation
import Network
import Security

private final class DeviceLinkResultLatch<Value> {
  private let lock = NSLock()
  private let semaphore = DispatchSemaphore(value: 0)
  private var result: Result<Value, Error>?

  func resolve(_ result: Result<Value, Error>) {
    lock.lock()
    guard self.result == nil else {
      lock.unlock()
      return
    }
    self.result = result
    lock.unlock()
    semaphore.signal()
  }

  func wait(until deadline: DispatchTime) throws -> Value {
    guard semaphore.wait(timeout: deadline) == .success else {
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
    }
    lock.lock()
    let result = self.result
    lock.unlock()
    guard let result else { throw DeviceLinkFailure.invalid }
    return try result.get()
  }
}

final class DeviceLinkTransport {
  private static let connectTimeoutSeconds = 5
  private static let maximumRequestBytes = 64 * 1024
  private static let maximumResponseBytes = 4 * 1024 * 1024
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "com.bluetanuki.ios.device-link.tls")
  private var activeConnection: NWConnection?

  func cancelActive() {
    lock.lock()
    let connection = activeConnection
    activeConnection = nil
    lock.unlock()
    connection?.cancel()
  }

  func exchange(
    _ credential: DeviceLinkCredential,
    operation: String,
    payload: [String: Any],
    canSend: () -> Bool
  ) throws -> (nonce: String, envelope: [String: Any]) {
    guard !credential.isExpired(), canSend(),
          let port = NWEndpoint.Port(rawValue: UInt16(credential.port)) else {
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
    }

    let nonce = try DeviceLinkJSON.randomHex(byteCount: 16)
    let request: [String: Any] = [
      "版": 1,
      "HostID": credential.hostID,
      "端末ID": credential.deviceID,
      "資格ID": credential.credentialID,
      "資格秘密": credential.secret,
      "nonce": nonce,
      "発行時刻": Int64(Date().timeIntervalSince1970),
      "操作": operation,
      "内容": payload,
    ]
    var wire = try DeviceLinkJSON.encode(request, maximumBytes: Self.maximumRequestBytes)
    wire.append(0x0A)
    defer { wire.resetBytes(in: 0..<wire.count) }

    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
    sec_protocol_options_set_tls_resumption_enabled(security, false)
    sec_protocol_options_set_tls_tickets_enabled(security, false)
    sec_protocol_options_set_peer_authentication_required(security, true)
    Self.installCertificatePin(security, expectedHash: credential.certificateHash)

    let connection = NWConnection(
      host: NWEndpoint.Host(credential.host),
      port: port,
      using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    )
    lock.lock()
    guard activeConnection == nil else {
      lock.unlock()
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
    }
    activeConnection = connection
    lock.unlock()
    defer {
      lock.lock()
      if activeConnection === connection { activeConnection = nil }
      lock.unlock()
      connection.cancel()
    }

    let deadline = DispatchTime.now() + .seconds(Self.connectTimeoutSeconds)
    let ready = DeviceLinkResultLatch<Void>()
    connection.stateUpdateHandler = { state in
      switch state {
      case .ready:
        ready.resolve(.success(()))
      case .failed(let error):
        ready.resolve(.failure(error))
      case .cancelled:
        ready.resolve(.failure(DeviceLinkFailure.transport(mayHaveReachedDesktop: false)))
      case .setup, .waiting, .preparing:
        break
      @unknown default:
        ready.resolve(.failure(DeviceLinkFailure.invalid))
      }
    }
    connection.start(queue: queue)

    var dispatchAttempted = false
    do {
      try ready.wait(until: deadline)
      guard canSend(), !credential.isExpired() else {
        throw DeviceLinkFailure.transport(mayHaveReachedDesktop: false)
      }

      let sent = DeviceLinkResultLatch<Void>()
      dispatchAttempted = true
      connection.send(
        content: wire,
        contentContext: .defaultMessage,
        isComplete: true,
        completion: .contentProcessed { error in
          if let error {
            sent.resolve(.failure(error))
          } else {
            sent.resolve(.success(()))
          }
        }
      })
      try sent.wait(until: deadline)

      var responseBytes = try receiveSingleFrame(from: connection, until: deadline)
      defer { responseBytes.resetBytes(in: 0..<responseBytes.count) }
      let envelope = try DeviceLinkJSON.object(
        responseBytes,
        maximumBytes: Self.maximumResponseBytes
      )
      return (nonce: nonce, envelope: envelope)
    } catch {
      connection.cancel()
      throw DeviceLinkFailure.transport(mayHaveReachedDesktop: dispatchAttempted)
    }
  }

  private func receiveSingleFrame(
    from connection: NWConnection,
    until deadline: DispatchTime
  ) throws -> Data {
    var bytes = Data()
    var reachedEnd = false
    while !reachedEnd {
      let received = DeviceLinkResultLatch<(Data?, Bool, NWError?)>()
      connection.receive(
        minimumIncompleteLength: 1,
        maximumLength: Self.maximumResponseBytes + 1
      ) { data, _, isComplete, error in
        received.resolve(.success((data, isComplete, error)))
      }
      let (chunk, isComplete, error) = try received.wait(until: deadline)
      if error != nil { throw DeviceLinkFailure.invalid }
      if let chunk {
        guard bytes.count + chunk.count <= Self.maximumResponseBytes + 1 else {
          throw DeviceLinkFailure.invalid
        }
        bytes.append(chunk)
      }
      reachedEnd = isComplete
    }

    guard let newline = bytes.lastIndex(of: 0x0A),
          newline == bytes.index(before: bytes.endIndex),
          !bytes[..<newline].contains(0x0A),
          !bytes.contains(0x0D) else {
      throw DeviceLinkFailure.invalid
    }
    return Data(bytes[..<newline])
  }

  private static func installCertificatePin(
    _ options: sec_protocol_options_t,
    expectedHash: String
  ) {
    let verifyQueue = DispatchQueue(label: "com.bluetanuki.ios.device-link.pin")
    sec_protocol_options_set_verify_block(options, { metadata, trust, complete in
      var leaf: SecCertificate?
      let available = sec_protocol_metadata_access_peer_certificate_chain(metadata) { certificate in
        if leaf == nil {
          leaf = sec_certificate_copy_ref(certificate).takeRetainedValue()
        }
      }
      guard available, let leaf else {
        complete(false)
        return
      }
      let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
        .map { String(format: "%02x", $0) }.joined()
      guard digest == expectedHash else {
        complete(false)
        return
      }

      let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
      guard SecTrustSetPolicies(secTrust, SecPolicyCreateBasicX509()) == errSecSuccess,
            SecTrustSetAnchorCertificates(secTrust, [leaf] as CFArray) == errSecSuccess,
            SecTrustSetAnchorCertificatesOnly(secTrust, true) == errSecSuccess,
            SecTrustSetNetworkFetchAllowed(secTrust, false) == errSecSuccess else {
        complete(false)
        return
      }
      var trustError: CFError?
      complete(SecTrustEvaluateWithError(secTrust, &trustError))
    }, verifyQueue)
  }
}
