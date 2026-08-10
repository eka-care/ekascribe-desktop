import Foundation

/// Persisted user preferences for the global quick-access shortcut that
/// triggers recording. The Settings UI in Electron is authoritative for user
/// intent; this store persists the last synced values locally so the helper
/// survives Electron restarts and Settings can rehydrate on next open.
struct OverlayShortcutPreferences: Equatable {
  var enabled: Bool
  var shortcut: String

  static let defaultShortcut = "Ctrl + S"

  static let defaults = OverlayShortcutPreferences(
    enabled: true,
    shortcut: defaultShortcut
  )

  func asDictionary() -> [String: Any] {
    [
      "enabled": enabled,
      "shortcut": shortcut
    ]
  }

  static func fromDictionary(
    _ raw: [String: Any],
    fallback: OverlayShortcutPreferences = .defaults
  ) -> OverlayShortcutPreferences {
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

    let resolvedShortcut: String
    if let raw = raw["shortcut"] as? String, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      resolvedShortcut = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      resolvedShortcut = fallback.shortcut
    }

    return OverlayShortcutPreferences(
      enabled: readBool("enabled", fallback.enabled),
      shortcut: resolvedShortcut
    )
  }
}

final class OverlayShortcutPreferencesStore {
  private static let userDefaultsKey = "overlay.shortcutPrefs.v1"

  private let defaults: UserDefaults
  private let lock = NSLock()
  private var cached: OverlayShortcutPreferences

  /// Notified whenever the persisted preferences change. Invoked on an
  /// unspecified queue; dispatch to the main queue before touching UI state.
  var onChange: ((OverlayShortcutPreferences) -> Void)?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.cached = Self.load(from: defaults) ?? .defaults
  }

  var current: OverlayShortcutPreferences {
    lock.lock()
    defer { lock.unlock() }
    return cached
  }

  @discardableResult
  func update(_ partial: [String: Any]) -> OverlayShortcutPreferences {
    lock.lock()
    let merged = OverlayShortcutPreferences.fromDictionary(partial, fallback: cached)
    let didChange = merged != cached
    cached = merged
    persist(merged)
    lock.unlock()
    if didChange {
      onChange?(merged)
    }
    return merged
  }

  private func persist(_ prefs: OverlayShortcutPreferences) {
    defaults.set(prefs.asDictionary(), forKey: Self.userDefaultsKey)
  }

  private static func load(from defaults: UserDefaults) -> OverlayShortcutPreferences? {
    guard let dict = defaults.dictionary(forKey: userDefaultsKey) else { return nil }
    return OverlayShortcutPreferences.fromDictionary(dict)
  }
}
