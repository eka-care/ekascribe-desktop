import Foundation

final class DisabledAppsPreferencesStore {
  static let shared = DisabledAppsPreferencesStore()

  private let key = "overlay.disabledApps.v1"

  private init() {}

  var disabledApps: Set<String> {
    Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
  }

  func isDisabled(_ name: String) -> Bool {
    guard !name.isEmpty else { return false }
    return disabledApps.contains(name)
  }

  func disable(_ name: String) {
    guard !name.isEmpty else { return }
    var apps = disabledApps
    apps.insert(name)
    UserDefaults.standard.set(Array(apps), forKey: key)
    print("[MacHelper] disabled prompt overlay for app: \(name)")
  }

  func resetAll() {
    UserDefaults.standard.removeObject(forKey: key)
    print("[MacHelper] reset all disabled apps")
  }
}
