import Foundation
import Network
import AppKit

private enum NativeBridgeMode {
  case tcp(NWEndpoint.Host, NWEndpoint.Port)
  case stdio(FileHandle, FileHandle)
}

final class NativeBridgeClient: @unchecked Sendable {
  private let mode: NativeBridgeMode
  private let queue = DispatchQueue(label: "com.ekacare.mac-helper.bridge")
  private let pingIntervalSeconds: TimeInterval = 5
  private let pongTimeoutSeconds: TimeInterval = 15

  private var connection: NWConnection?
  private var reconnectAttempt = 0
  private var reconnectWorkItem: DispatchWorkItem?
  private var receiveBuffer = Data()
  private var lastPongAt = Date()
  private var pingTimer: DispatchSourceTimer?
  private var pendingRequests = [String: CheckedContinuation<Any?, Never>]()
  private var isStarted = false
  private let connectionStateLock = NSLock()
  private var connectionReady = false

  var onEvent: ((String, [String: Any]) -> Void)?
  /// Handler for Electron `request` frames. Return a JSON-serializable reply
  /// payload on success, or `nil` to send an error response.
  var onRequest: ((String, [String: Any]) -> [String: Any]?)?
  var isConnected: Bool {
    connectionStateLock.lock()
    defer { connectionStateLock.unlock() }
    return connectionReady
  }
  var isStdioTransport: Bool {
    if case .stdio = mode { return true }
    return false
  }

  init(host: String, port: Int) {
    let resolvedPort = NWEndpoint.Port(rawValue: UInt16(max(1, min(port, Int(UInt16.max))))) ?? 50505
    self.mode = .tcp(NWEndpoint.Host(host), resolvedPort)
  }

  /// Stdio transport: `input` is the parent's stdout-side pipe (we read framed
  /// messages from it), `output` is the parent's stdin-side pipe (we write
  /// framed messages to it). The parent process owns lifecycle, so EOF on
  /// `input` terminates the helper instead of triggering a reconnect.
  init(stdioInput input: FileHandle, stdioOutput output: FileHandle) {
    self.mode = .stdio(input, output)
  }

  func start() {
    queue.async { [weak self] in
      guard let self else { return }
      guard !isStarted else { return }
      isStarted = true
      connect()
    }
  }

  func stop() {
    queue.async { [weak self] in
      guard let self else { return }
      isStarted = false
      setConnectionReady(false)
      reconnectWorkItem?.cancel()
      reconnectWorkItem = nil
      stopPingTimer()
      connection?.cancel()
      connection = nil
      if case .stdio(let input, _) = mode {
        input.readabilityHandler = nil
      }
      receiveBuffer = Data()
      failAllPending()
    }
  }

  func restart() async {
    stop()
    start()
  }

  func sendEvent(name: String, payload: Any?) async {
    _ = await sendEventWithResult(name: name, payload: payload)
  }

  func sendEventWithResult(name: String, payload: Any?) async -> Bool {
    var message: [String: Any] = [
      "v": 1,
      "id": UUID().uuidString,
      "ts": Int(Date().timeIntervalSince1970 * 1000),
      "kind": "event",
      "name": name
    ]
    if let payload {
      message["payload"] = payload
    }
    return queue.sync { [weak self] in
      guard let self else {
        return false
      }
      return send(message: message)
    }
  }

  func request(name: String, payload: Any?, timeoutMs: Int) async -> Any? {
    let requestId = UUID().uuidString
    var message: [String: Any] = [
      "v": 1,
      "id": requestId,
      "ts": Int(Date().timeIntervalSince1970 * 1000),
      "kind": "request",
      "name": name
    ]
    if let payload {
      message["payload"] = payload
    }
    _ = send(message: message)

    return await withCheckedContinuation { continuation in
      queue.async { [weak self] in
        guard let self else {
          continuation.resume(returning: nil)
          return
        }

        pendingRequests[requestId] = continuation
        let timeout = max(timeoutMs, 100)
        queue.asyncAfter(deadline: .now() + .milliseconds(timeout)) { [weak self] in
          guard let self else { return }
          let pending = pendingRequests.removeValue(forKey: requestId)
          pending?.resume(returning: nil)
        }
      }
    }
  }

  private func connect() {
    switch mode {
    case .tcp(let host, let port):
      setConnectionReady(false)
      let connection = NWConnection(host: host, port: port, using: .tcp)
      self.connection = connection
      logBridge("connect -> \(host):\(port)")

      connection.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        queue.async { [weak self] in
          guard let self else { return }
          switch state {
          case .ready:
            setConnectionReady(true)
            reconnectAttempt = 0
            lastPongAt = Date()
            startPingTimer()
            startReceiveLoop()
            logBridge("connected")
          case .failed(let error):
            setConnectionReady(false)
            logBridge("failed: \(error)")
            handleDisconnectAndReconnect()
          case .cancelled:
            setConnectionReady(false)
            logBridge("cancelled")
          default:
            break
          }
        }
      }
      connection.start(queue: queue)

    case .stdio(let input, _):
      logBridge("connect -> stdio")
      setConnectionReady(true)
      reconnectAttempt = 0
      lastPongAt = Date()
      attachStdioReadHandler(input)
      logBridge("connected (stdio)")
    }
  }

  private func attachStdioReadHandler(_ input: FileHandle) {
    input.readabilityHandler = { [weak self] handle in
      guard let self else { return }
      let chunk = handle.availableData
      if chunk.isEmpty {
        // EOF: parent closed our stdin. Tear down on the bridge queue.
        queue.async { [weak self] in
          guard let self else { return }
          handle.readabilityHandler = nil
          logBridge("stdio EOF; parent has gone away")
          terminateProcessOnParentLoss()
        }
        return
      }
      queue.async { [weak self] in
        guard let self else { return }
        receiveBuffer.append(chunk)
        parseFrames()
      }
    }
  }

  private func terminateProcessOnParentLoss() {
    setConnectionReady(false)
    failAllPending()
    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
  }

  private func logBridge(_ message: String) {
    // Always write diagnostic logs to stderr so stdio framing on stdout stays
    // pristine, regardless of whether the parent process redirected fd 1.
    FileHandle.standardError.write(Data("[MacHelper] NativeBridge \(message)\n".utf8))
  }

  private func handleDisconnectAndReconnect() {
    if case .stdio = mode {
      // Stdio sessions are owned by the parent process. We never reconnect;
      // the parent will respawn us if needed.
      terminateProcessOnParentLoss()
      return
    }
    setConnectionReady(false)
    stopPingTimer()
    connection?.cancel()
    connection = nil
    failAllPending()
    guard isStarted else { return }

    let delayMs = min(5000, 250 * Int(pow(2.0, Double(min(reconnectAttempt, 6)))))
    reconnectAttempt += 1
    let workItem = DispatchWorkItem { [weak self] in
      self?.connect()
    }
    reconnectWorkItem?.cancel()
    reconnectWorkItem = workItem
    logBridge("reconnect in \(delayMs)ms")
    queue.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: workItem)
  }

  private func startReceiveLoop() {
    // Only used by the TCP transport; stdio attaches a readabilityHandler
    // directly in attachStdioReadHandler.
    if case .stdio = mode { return }
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      queue.async { [weak self] in
        guard let self else { return }
        if let error {
          logBridge("receive error: \(error)")
          handleDisconnectAndReconnect()
          return
        }
        if let data, !data.isEmpty {
          receiveBuffer.append(data)
          parseFrames()
        }
        if isComplete {
          logBridge("disconnected by peer")
          handleDisconnectAndReconnect()
          return
        }
        startReceiveLoop()
      }
    }
  }

  private func parseFrames() {
    while receiveBuffer.count >= 4 {
      let headerData = receiveBuffer.subdata(in: 0..<4)
      let frameLength = headerData.withUnsafeBytes { raw -> UInt32 in
        guard let base = raw.baseAddress else { return 0 }
        return base.load(as: UInt32.self).bigEndian
      }
      if frameLength == 0 || frameLength > 16 * 1024 * 1024 {
        print("[MacHelper] NativeBridge invalid frame length: \(frameLength)")
        handleDisconnectAndReconnect()
        return
      }
      let total = 4 + Int(frameLength)
      guard receiveBuffer.count >= total else { return }
      let payload = receiveBuffer.subdata(in: 4..<total)
      receiveBuffer.removeSubrange(0..<total)
      handleFrame(payload)
    }
  }

  private func handleFrame(_ payload: Data) {
    guard
      let decoded = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      let kind = decoded["kind"] as? String
    else {
      return
    }

    if kind == "ping" {
      _ = send(message: [
        "v": 1,
        "id": UUID().uuidString,
        "ts": Int(Date().timeIntervalSince1970 * 1000),
        "kind": "pong"
      ])
      return
    }

    if kind == "pong" {
      lastPongAt = Date()
      return
    }

    if kind == "event", let name = decoded["name"] as? String {
      let payloadDict = decoded["payload"] as? [String: Any] ?? [:]
      onEvent?(name, payloadDict)
      return
    }

    if kind == "request", let name = decoded["name"] as? String, let requestId = decoded["id"] as? String {
      let payloadDict = decoded["payload"] as? [String: Any] ?? [:]
      let replyPayload = onRequest?(name, payloadDict)
      let responseMessage: [String: Any] = {
        var base: [String: Any] = [
          "v": 1,
          "id": UUID().uuidString,
          "ts": Int(Date().timeIntervalSince1970 * 1000),
          "kind": "response",
          "replyTo": requestId,
          "ok": replyPayload != nil
        ]
        if let replyPayload {
          base["payload"] = replyPayload
        } else {
          base["error"] = [
            "code": "REQUEST_UNHANDLED",
            "message": "No handler for request: \(name)"
          ]
        }
        return base
      }()
      _ = send(message: responseMessage)
      return
    }

    if kind == "response", let replyTo = decoded["replyTo"] as? String {
      let continuation = pendingRequests.removeValue(forKey: replyTo)
      if decoded["ok"] as? Bool == true {
        continuation?.resume(returning: decoded["payload"])
      } else {
        continuation?.resume(returning: nil)
      }
    }
  }

  private func startPingTimer() {
    // Stdio liveness is implicit via parent-process pipes; pings would only
    // pollute the framed channel.
    if case .stdio = mode { return }
    stopPingTimer()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + pingIntervalSeconds, repeating: pingIntervalSeconds)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      _ = send(message: [
        "v": 1,
        "id": UUID().uuidString,
        "ts": Int(Date().timeIntervalSince1970 * 1000),
        "kind": "ping"
      ])
      if Date().timeIntervalSince(lastPongAt) > pongTimeoutSeconds {
        logBridge("pong timeout")
        handleDisconnectAndReconnect()
      }
    }
    timer.resume()
    pingTimer = timer
  }

  private func stopPingTimer() {
    pingTimer?.cancel()
    pingTimer = nil
  }

  private func send(message: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(message) else {
      return false
    }
    guard let jsonData = try? JSONSerialization.data(withJSONObject: message) else {
      return false
    }
    var len = UInt32(jsonData.count).bigEndian
    var frame = Data(bytes: &len, count: 4)
    frame.append(jsonData)

    switch mode {
    case .tcp:
      guard let connection else { return false }
      connection.send(content: frame, completion: .contentProcessed({ [weak self] error in
        if let error {
          self?.logBridge("send error: \(error)")
        }
      }))
      return true
    case .stdio(_, let output):
      do {
        try output.write(contentsOf: frame)
        return true
      } catch {
        logBridge("stdio send error: \(error)")
        terminateProcessOnParentLoss()
        return false
      }
    }
  }

  private func failAllPending() {
    let current = pendingRequests
    pendingRequests.removeAll()
    for (_, continuation) in current {
      continuation.resume(returning: nil)
    }
  }

  private func setConnectionReady(_ ready: Bool) {
    connectionStateLock.lock()
    connectionReady = ready
    connectionStateLock.unlock()
  }
}
