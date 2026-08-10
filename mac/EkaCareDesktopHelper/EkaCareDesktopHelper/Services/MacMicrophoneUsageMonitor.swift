import Foundation
import CoreAudio
import AppKit

/// Monitors microphone usage by **third-party** applications.
///
/// A naive approach of polling `kAudioDevicePropertyDeviceIsRunningSomewhere`
/// is wrong in two ways: it is system-wide (once our Electron host records on
/// the same device as a third party, the flag can stay `true` after they stop),
/// and it is **not input-specific** — playback through combo in/out hardware
/// looks like “mic on”. We never use that property; detection is anchored on
/// `kAudioProcessPropertyIsRunningInput` plus **active input streams**
/// (`kAudioStreamPropertyIsActive` on input-scoped device streams), with a
/// small legacy path for older macOS.
///
/// Instead we enumerate audio process objects (macOS 14.0+) and exclude any
/// process whose bundle identifier belongs to our Electron host
/// (`care.eka.ekascribe` and its XPC/framework helpers) or to this helper app
/// itself. The emitted `onUsageChanged(Bool)` reflects **only** third-party
/// microphone usage, so the existing state machine in `BridgeAppState` does
/// the right thing in every combination:
///
/// 1. Third-party only                 -> true, prompt is shown.
/// 2. Third-party + our app            -> true, recording overlay is shown.
/// 3. Third-party stops, we keep going -> false (after ~2s sustained idle),
///    triggers our auto-stop.
/// 4. Our app only                     -> false (never fires), no prompt.
/// 5. Third-party stops + we stop together -> false, idempotent.
///
/// Falling edges (`false`) are emitted only after **third-party** input has
/// stayed idle for `thirdPartyMicIdleConfirmationSeconds`, so consumers that
/// stop recording on mic release do not tear down while CoreAudio is still
/// settling.
final class MacMicrophoneUsageMonitor {
  /// Matches `build.appId` in the root `package.json` (electron-builder).
  private static let electronHostBundleIDPrefix = "care.eka.ekascribe"
  private static let helperBundleID = Bundle.main.bundleIdentifier ?? "com.orbi.EkaCareDesktopHelper"
  /// Wall-clock time `isThirdPartyMicInUse()` must stay `false` (while we
  /// still had last emitted `true`) before we notify consumers — aligns with
  /// stopping recording only after mic usage has actually quiesced.
  private static let thirdPartyMicIdleConfirmationSeconds: TimeInterval = 2
  private static let pollInterval: DispatchTimeInterval = .seconds(1)

  private let queue = DispatchQueue(label: "com.ekacare.mac-helper.mic")
  private var timer: DispatchSourceTimer?
  private var lastEmittedState: Bool?
  /// First tick time we saw `!inUse` while the last **emitted** state was still `true`.
  private var thirdPartyMicIdleSince: Date?

  var onUsageChanged: ((Bool) -> Void)?

  func start() {
    stop()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: Self.pollInterval)
    timer.setEventHandler { [weak self] in
      self?.tick()
    }
    timer.resume()
    self.timer = timer
  }

  func stop() {
    timer?.cancel()
    timer = nil
    lastEmittedState = nil
    thirdPartyMicIdleSince = nil
  }

  // MARK: - Polling loop

  private func tick() {
    let inUse = Self.isThirdPartyMicInUse()

    // First sample: emit unconditionally so the app state settles.
    guard let last = lastEmittedState else {
      lastEmittedState = inUse
      thirdPartyMicIdleSince = nil
      print("[MacHelper] mic usage (third-party) initial=\(inUse)")
      onUsageChanged?(inUse)
      return
    }

    if inUse {
      thirdPartyMicIdleSince = nil
      if last == true { return }
      lastEmittedState = true
      print("[MacHelper] mic usage (third-party) changed -> true")
      onUsageChanged?(true)
      return
    }

    // Rising edges are emitted immediately; falling edges require sustained idle.
    if last == false {
      thirdPartyMicIdleSince = nil
      return
    }

    // last == true, !inUse — accumulate idle time; any flap back to inUse clears the clock above.
    if thirdPartyMicIdleSince == nil {
      thirdPartyMicIdleSince = Date()
    }
    guard let since = thirdPartyMicIdleSince,
          Date().timeIntervalSince(since) >= Self.thirdPartyMicIdleConfirmationSeconds
    else {
      return
    }
    thirdPartyMicIdleSince = nil
    lastEmittedState = false
    print("[MacHelper] mic usage (third-party) changed -> false")
    onUsageChanged?(false)
  }

  // MARK: - CoreAudio queries

  private static func isThirdPartyMicInUse() -> Bool {
    for processID in audioProcessObjectIDs() {
      if isOwnProcess(processID) {
        continue
      }
      if isProcessRunningInput(processID) {
        return true
      }
    }
    return false
  }

  /// Returns the display name of the first third-party process actively using
  /// the microphone, or `nil` if none is found.
  static func firstThirdPartyAppName() -> String? {
    for processID in audioProcessObjectIDs() {
      if isOwnProcess(processID) { continue }
      if !isProcessRunningInput(processID) { continue }
      guard let pid = pidProperty(processID) else { continue }

      let directApp = NSRunningApplication(processIdentifier: pid_t(pid))
      let directName = directApp?.localizedName

      // If the direct lookup gives a helper/renderer name (e.g. "Google Chrome
      // Helper (Renderer)"), or if there is no NSApp at all, prefer a bundle-ID
      // parent lookup so the user sees "Google Chrome" instead.
      let looksLikeHelper = directApp == nil || directName?.contains("Helper") == true

      if looksLikeHelper,
         let bundleID = stringProperty(processID, selector: kAudioProcessPropertyBundleID) {
        // Strip last component: com.google.Chrome.helper -> com.google.Chrome
        if let dot = bundleID.range(of: ".", options: .backwards) {
          let parent = String(bundleID[..<dot.lowerBound])
          if let app = NSRunningApplication.runningApplications(withBundleIdentifier: parent).first {
            return app.localizedName ?? parent
          }
        }
        // Exact bundle ID lookup as fallback
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first {
          return app.localizedName ?? bundleID
        }
      }

      // Regular app: use the direct PID lookup result
      if let name = directName ?? directApp?.bundleIdentifier {
        return name
      }
    }
    return nil
  }

  private static func isOwnProcess(_ processID: AudioObjectID) -> Bool {
    if let bundleID = stringProperty(processID, selector: kAudioProcessPropertyBundleID) {
      if bundleID == helperBundleID { return true }
      // electron-builder publishes the main app and all of its XPC helpers
      // (Renderer / GPU / Plugin / Audio) under the same bundle-ID prefix,
      // so a prefix check keeps the Chromium Audio Service out of the
      // "third-party" bucket.
      if bundleID == electronHostBundleIDPrefix { return true }
      if bundleID.hasPrefix(electronHostBundleIDPrefix + ".") { return true }
    }
    // Bundle ID was missing (command-line tools, daemons). Fall back to PID
    // so the helper never flags itself.
    if let pid = pidProperty(processID), pid == ProcessInfo.processInfo.processIdentifier {
      return true
    }
    return false
  }

  private static func audioProcessObjectIDs() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
      return []
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
      return []
    }
    return ids
  }

  private static func isProcessRunningInput(_ processID: AudioObjectID) -> Bool {
    // Prefer the dedicated selector (macOS 14.2+). The constant itself is
    // always available at compile time; older systems simply return an
    // error and we fall through to the explicit device-list probe.
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyIsRunningInput,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    if AudioObjectGetPropertyData(processID, &address, 0, nil, &size, &running) == noErr {
      guard running == 1 else { return false }
      // `kAudioProcessPropertyIsRunningInput` alone can still correlate with
      // shared combo in/out hardware during **output-only** IO. Require an
      // actually-active **input** stream on a device this process is tied to.
      return processHasActiveInputStreamOnAttachedDevices(processID)
    }
    return legacyProcessHasRunningInput(processID)
  }

  /// macOS 14.0 / 14.1 fallback: the process is currently running audio and
  /// at least one of its attached devices has an **active** input stream.
  ///
  /// Older code used `kAudioDevicePropertyDeviceIsRunningSomewhere`, which is
  /// true whenever *any* direction uses the device — so playback through the
  /// built-in path looked like “mic in use”. `kAudioStreamPropertyIsActive` on
  /// input-scoped streams matches real capture.
  private static func legacyProcessHasRunningInput(_ processID: AudioObjectID) -> Bool {
    guard boolProperty(processID, selector: kAudioProcessPropertyIsRunning) else { return false }
    return processHasActiveInputStreamOnAttachedDevices(processID)
  }

  /// Prefer input-scoped device associations so a playback-only client is not
  /// evaluated against unrelated mic elements from a global aggregate list.
  private static func processDeviceIDs(_ processID: AudioObjectID) -> [AudioObjectID] {
    let inputScoped = processDeviceIDs(processID, scope: kAudioObjectPropertyScopeInput)
    if !inputScoped.isEmpty { return inputScoped }
    return processDeviceIDs(processID, scope: kAudioObjectPropertyScopeGlobal)
  }

  private static func processDeviceIDs(_ processID: AudioObjectID, scope: AudioObjectPropertyScope) -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyDevices,
      mScope: scope,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(processID, &address, 0, nil, &size) == noErr, size > 0 else {
      return []
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(processID, &address, 0, nil, &size, &ids) == noErr else {
      return []
    }
    return ids
  }

  private static func processHasActiveInputStreamOnAttachedDevices(_ processID: AudioObjectID) -> Bool {
    for deviceID in processDeviceIDs(processID) where deviceHasActiveInputStreams(deviceID) {
      return true
    }
    return false
  }

  private static func deviceHasActiveInputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
          size >= UInt32(MemoryLayout<AudioObjectID>.size)
    else {
      return false
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var streamIDs = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &streamIDs) == noErr else {
      return false
    }
    return streamIDs.contains { streamIsActive($0) }
  }

  private static func streamIsActive(_ streamID: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioStreamPropertyIsActive,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var active: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(streamID, &address, 0, nil, &size, &active) == noErr else {
      return false
    }
    return active == 1
  }

  // MARK: - Property helpers

  private static func boolProperty(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value) == noErr else {
      return false
    }
    return value == 1
  }

  private static func pidProperty(_ objectID: AudioObjectID) -> pid_t? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyPID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var pid: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &pid) == noErr else {
      return nil
    }
    return pid
  }

  private static func stringProperty(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var cfString: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &cfString) { pointer -> OSStatus in
      AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, pointer)
    }
    guard status == noErr, let cfString else { return nil }
    return cfString.takeRetainedValue() as String
  }
}
