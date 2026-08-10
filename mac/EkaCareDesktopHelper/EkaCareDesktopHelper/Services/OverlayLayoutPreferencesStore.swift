import Foundation
import AppKit
import Combine

/// Orientation of the compact recording widget. Horizontal is the default.
enum OverlayOrientation: String {
  case horizontal
  case vertical

  var toggled: OverlayOrientation {
    self == .horizontal ? .vertical : .horizontal
  }
}

/// Persisted layout for the floating overlay: where the user dragged it and the
/// recording-widget orientation. Position is stored as the window's **left edge**
/// (`left`) plus the **top edge** (`top`) in AppKit global coordinates (y grows
/// upward, so `top` is the frame's `maxY`). Anchoring by the top-left keeps the
/// visual top consistent across differently-sized overlay states.
struct OverlayLayoutPreferences: Equatable {
  var hasCustomPosition: Bool
  var left: Double
  var top: Double
  var orientation: OverlayOrientation

  static let defaults = OverlayLayoutPreferences(
    hasCustomPosition: false,
    left: 0,
    top: 0,
    orientation: .horizontal
  )

  func asDictionary() -> [String: Any] {
    [
      "hasCustomPosition": hasCustomPosition,
      "left": left,
      "top": top,
      "orientation": orientation.rawValue
    ]
  }

  static func fromDictionary(
    _ raw: [String: Any],
    fallback: OverlayLayoutPreferences = .defaults
  ) -> OverlayLayoutPreferences {
    func readDouble(_ key: String, _ fallbackValue: Double) -> Double {
      if let value = raw[key] as? Double { return value }
      if let value = raw[key] as? NSNumber { return value.doubleValue }
      return fallbackValue
    }

    let hasCustom: Bool
    if let value = raw["hasCustomPosition"] as? Bool {
      hasCustom = value
    } else if let value = raw["hasCustomPosition"] as? NSNumber {
      hasCustom = value.boolValue
    } else {
      hasCustom = fallback.hasCustomPosition
    }

    let orientation: OverlayOrientation
    if let rawValue = raw["orientation"] as? String,
       let parsed = OverlayOrientation(rawValue: rawValue.lowercased()) {
      orientation = parsed
    } else {
      orientation = fallback.orientation
    }

    return OverlayLayoutPreferences(
      hasCustomPosition: hasCustom,
      left: readDouble("left", readDouble("leftX", fallback.left)),
      top: readDouble("top", readDouble("topY", fallback.top)),
      orientation: orientation
    )
  }
}

@MainActor
final class OverlayLayoutPreferencesStore: ObservableObject {
  private static let userDefaultsKey = "overlay.layoutPrefs.v1"

  private let defaults: UserDefaults
  @Published private(set) var current: OverlayLayoutPreferences

  /// Notified whenever the persisted preferences change (e.g. drag end or
  /// orientation flip). Invoked on the main actor.
  var onChange: ((OverlayLayoutPreferences) -> Void)?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.current = Self.load(from: defaults) ?? .defaults
  }

  /// Persists a new top-left anchor after a drag. `left`/`top` are in AppKit
  /// global coordinates (`top` == window frame `maxY`).
  func updatePosition(left: Double, top: Double) {
    var next = current
    next.hasCustomPosition = true
    next.left = left
    next.top = top
    apply(next)
  }

  func updateOrientation(_ orientation: OverlayOrientation) {
    var next = current
    next.orientation = orientation
    apply(next)
  }

  func toggleOrientation() {
    updateOrientation(current.orientation.toggled)
  }

  private func apply(_ next: OverlayLayoutPreferences) {
    guard next != current else { return }
    current = next
    persist(next)
    onChange?(next)
  }

  private func persist(_ prefs: OverlayLayoutPreferences) {
    defaults.set(prefs.asDictionary(), forKey: Self.userDefaultsKey)
  }

  private static func load(from defaults: UserDefaults) -> OverlayLayoutPreferences? {
    guard let dict = defaults.dictionary(forKey: userDefaultsKey) else { return nil }
    return OverlayLayoutPreferences.fromDictionary(dict)
  }
}

/// Geometry helpers for keeping the overlay fully on-screen.
enum OverlayGeometry {
  static let edgeMargin: CGFloat = 8

  /// Clamps a desired window origin (AppKit bottom-left) so the whole window of
  /// `size` stays inside `visibleFrame`, leaving a small margin. If the window
  /// is larger than the available area on an axis, it is pinned to the min edge.
  static func clampOrigin(
    _ origin: NSPoint,
    size: NSSize,
    visibleFrame: NSRect,
    margin: CGFloat = edgeMargin
  ) -> NSPoint {
    let minX = visibleFrame.minX + margin
    let maxX = visibleFrame.maxX - size.width - margin
    let minY = visibleFrame.minY + margin
    let maxY = visibleFrame.maxY - size.height - margin

    let clampedX = maxX >= minX ? min(max(origin.x, minX), maxX) : minX
    let clampedY = maxY >= minY ? min(max(origin.y, minY), maxY) : minY
    return NSPoint(x: clampedX, y: clampedY)
  }
}
