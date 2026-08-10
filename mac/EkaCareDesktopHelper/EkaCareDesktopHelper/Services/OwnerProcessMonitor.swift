import Foundation

final class OwnerProcessMonitor {
  private let ownerPidFilePath: String
  private let queue = DispatchQueue(label: "com.ekacare.mac-helper.owner-monitor")
  private var timer: DispatchSourceTimer?
  var onOwnerMissing: (() -> Void)?

  init(ownerPidFilePath: String) {
    self.ownerPidFilePath = ownerPidFilePath
  }

  func start() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .seconds(2))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      guard let pid = readOwnerPid() else {
        return
      }
      if kill(pid, 0) != 0 {
        print("[MacHelper] owner pid missing -> \(pid), terminating helper")
        onOwnerMissing?()
      }
    }
    timer.resume()
    self.timer = timer
  }

  func stop() {
    timer?.cancel()
    timer = nil
  }

  private func readOwnerPid() -> pid_t? {
    guard FileManager.default.fileExists(atPath: ownerPidFilePath) else {
      return nil
    }
    guard
      let data = try? Data(contentsOf: URL(fileURLWithPath: ownerPidFilePath)),
      let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
      let value = Int32(raw),
      value > 1
    else {
      return nil
    }
    return value
  }
}
