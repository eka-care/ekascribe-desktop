import Foundation

/// Persisted user preferences that decide which overlay types the helper is
/// allowed to display. Mirrors the `OverlayNotificationPreferences` contract
/// shared with Electron; Electron is the source-of-truth for toggles, this
/// store is the source-of-truth for local persistence across launches.
struct OverlayNotificationPreferences: Equatable {
  var joinVideoConferencingAndStartTranscribing: Bool
  var meetingIsBeingRecorded: Bool
  var meetingIsSummarized: Bool

  static let defaults = OverlayNotificationPreferences(
    joinVideoConferencingAndStartTranscribing: true,
    meetingIsBeingRecorded: true,
    meetingIsSummarized: true
  )

  func asDictionary() -> [String: Any] {
    [
      "joinVideoConferencingAndStartTranscribing": joinVideoConferencingAndStartTranscribing,
      "meetingIsBeingRecorded": meetingIsBeingRecorded,
      "meetingIsSummarized": meetingIsSummarized
    ]
  }

  static func fromDictionary(_ raw: [String: Any], fallback: OverlayNotificationPreferences = .defaults) -> OverlayNotificationPreferences {
    func readBool(_ key: String, _ fallbackValue: Bool) -> Bool {
      if let value = raw[key] as? Bool { return value }
      if let value = raw[key] as? NSNumber { return value.boolValue }
      if let value = raw[key] as? String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "true" { return true }
        if normalized == "false" { return false }
      }
      return fallbackValue
    }
    return OverlayNotificationPreferences(
      joinVideoConferencingAndStartTranscribing: readBool(
        "joinVideoConferencingAndStartTranscribing",
        fallback.joinVideoConferencingAndStartTranscribing
      ),
      meetingIsBeingRecorded: readBool(
        "meetingIsBeingRecorded",
        fallback.meetingIsBeingRecorded
      ),
      meetingIsSummarized: readBool(
        "meetingIsSummarized",
        fallback.meetingIsSummarized
      )
    )
  }
}

final class OverlayNotificationPreferencesStore {
  private static let userDefaultsKey = "overlay.notificationPrefs.v1"

  private let defaults: UserDefaults
  private let lock = NSLock()
  private var cached: OverlayNotificationPreferences

  /// Notified whenever the persisted preferences change. Invoked on an
  /// unspecified queue; dispatch to the main queue before touching UI state.
  var onChange: ((OverlayNotificationPreferences) -> Void)?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.cached = Self.load(from: defaults) ?? .defaults
  }

  var current: OverlayNotificationPreferences {
    lock.lock()
    defer { lock.unlock() }
    return cached
  }

  @discardableResult
  func update(_ partial: [String: Any]) -> OverlayNotificationPreferences {
    lock.lock()
    let merged = OverlayNotificationPreferences.fromDictionary(partial, fallback: cached)
    cached = merged
    persist(merged)
    lock.unlock()
    onChange?(merged)
    return merged
  }

  private func persist(_ prefs: OverlayNotificationPreferences) {
    defaults.set(prefs.asDictionary(), forKey: Self.userDefaultsKey)
  }

  private static func load(from defaults: UserDefaults) -> OverlayNotificationPreferences? {
    guard let dict = defaults.dictionary(forKey: userDefaultsKey) else { return nil }
    return OverlayNotificationPreferences.fromDictionary(dict)
  }
}
