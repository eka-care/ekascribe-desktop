import Foundation
import Combine

enum OverlayPresentation: Equatable {
  case hidden
  case prompt
  case recording
  case processing
  case processed(transactionId: String?)
  case error(message: String?)
}

@MainActor
final class OverlayStateStore: ObservableObject {
  @Published private(set) var presentation: OverlayPresentation = .hidden
  @Published private(set) var promptTriggeringApp: String?

  func set(_ next: OverlayPresentation, source: String) {
    if presentation == next {
      return
    }
    presentation = next
    if case .prompt = next { /* keep promptTriggeringApp; caller sets it before calling set */ }
    else { promptTriggeringApp = nil }
    print("[MacHelper] overlay presentation source=\(source) next=\(debugDescription(next))")
  }

  func setPrompt(appName: String?, source: String) {
    promptTriggeringApp = appName
    set(.prompt, source: source)
  }

  private func debugDescription(_ value: OverlayPresentation) -> String {
    switch value {
    case .hidden:
      return "hidden"
    case .prompt:
      return "prompt"
    case .recording:
      return "recording"
    case .processing:
      return "processing"
    case .processed(let transactionId):
      return "processed(\(transactionId ?? "nil"))"
    case .error(let message):
      return "error(\(message ?? "nil"))"
    }
  }
}
