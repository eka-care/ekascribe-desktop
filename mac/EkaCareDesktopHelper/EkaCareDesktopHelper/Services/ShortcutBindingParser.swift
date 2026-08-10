import Carbon
import Foundation

/// Represents a parsed Carbon hotkey binding shaped for `RegisterEventHotKey`:
/// a combination of modifier flags and a virtual key code.
struct ShortcutBinding: Equatable {
  let modifiers: UInt32
  let keyCode: UInt32
  let normalizedDisplay: String
}

enum ShortcutBindingParser {
  static func parse(_ input: String?) -> ShortcutBinding? {
    guard let input, !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    let tokens = input
      .split(separator: "+", omittingEmptySubsequences: true)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard tokens.count >= 2 else { return nil }

    var modifiers: UInt32 = 0
    var keyCode: UInt32?
    var normalizedParts: [String] = []

    for token in tokens {
      if let modifier = Self.modifierForToken(token) {
        if modifiers & modifier.0 != 0 { return nil }
        modifiers |= modifier.0
        normalizedParts.append(modifier.1)
        continue
      }

      if keyCode != nil {
        return nil
      }

      guard let parsed = Self.parseMainKey(token) else {
        return nil
      }
      keyCode = parsed.0
      normalizedParts.append(parsed.1)
    }

    guard modifiers != 0, let resolvedKey = keyCode else { return nil }

    return ShortcutBinding(
      modifiers: modifiers,
      keyCode: resolvedKey,
      normalizedDisplay: normalizedParts.joined(separator: " + ")
    )
  }

  private static func modifierForToken(_ token: String) -> (UInt32, String)? {
    switch token.lowercased() {
    case "ctrl", "control":
      return (UInt32(controlKey), "Ctrl")
    case "alt", "option", "opt":
      return (UInt32(optionKey), "Alt")
    case "shift":
      return (UInt32(shiftKey), "Shift")
    case "cmd", "command", "meta", "super", "win":
      return (UInt32(cmdKey), "Cmd")
    default:
      return nil
    }
  }

  private static func parseMainKey(_ token: String) -> (UInt32, String)? {
    if token.count == 1 {
      let ch = token.uppercased().first!
      if let code = Self.letterKeyCode(ch) {
        return (code, String(ch))
      }
      if let code = Self.digitKeyCode(ch) {
        return (code, String(ch))
      }
      if let code = Self.punctuationKeyCode(ch) {
        return (code, String(ch))
      }
    }

    if token.count >= 2, let first = token.first, first == "F" || first == "f" {
      let suffix = token.dropFirst()
      if let number = Int(suffix), (1 ... 20).contains(number),
         let code = Self.functionKeyCode(number) {
        return (code, "F\(number)")
      }
    }

    switch token.lowercased() {
    case "space":
      return (UInt32(kVK_Space), "Space")
    case "tab":
      return (UInt32(kVK_Tab), "Tab")
    case "enter", "return":
      return (UInt32(kVK_Return), "Return")
    case "escape", "esc":
      return (UInt32(kVK_Escape), "Escape")
    case "delete", "backspace":
      return (UInt32(kVK_Delete), "Delete")
    case "forwarddelete":
      return (UInt32(kVK_ForwardDelete), "ForwardDelete")
    case "home":
      return (UInt32(kVK_Home), "Home")
    case "end":
      return (UInt32(kVK_End), "End")
    case "pageup":
      return (UInt32(kVK_PageUp), "PageUp")
    case "pagedown":
      return (UInt32(kVK_PageDown), "PageDown")
    case "left":
      return (UInt32(kVK_LeftArrow), "Left")
    case "right":
      return (UInt32(kVK_RightArrow), "Right")
    case "up":
      return (UInt32(kVK_UpArrow), "Up")
    case "down":
      return (UInt32(kVK_DownArrow), "Down")
    default:
      return nil
    }
  }

  private static func letterKeyCode(_ ch: Character) -> UInt32? {
    switch ch {
    case "A": return UInt32(kVK_ANSI_A)
    case "B": return UInt32(kVK_ANSI_B)
    case "C": return UInt32(kVK_ANSI_C)
    case "D": return UInt32(kVK_ANSI_D)
    case "E": return UInt32(kVK_ANSI_E)
    case "F": return UInt32(kVK_ANSI_F)
    case "G": return UInt32(kVK_ANSI_G)
    case "H": return UInt32(kVK_ANSI_H)
    case "I": return UInt32(kVK_ANSI_I)
    case "J": return UInt32(kVK_ANSI_J)
    case "K": return UInt32(kVK_ANSI_K)
    case "L": return UInt32(kVK_ANSI_L)
    case "M": return UInt32(kVK_ANSI_M)
    case "N": return UInt32(kVK_ANSI_N)
    case "O": return UInt32(kVK_ANSI_O)
    case "P": return UInt32(kVK_ANSI_P)
    case "Q": return UInt32(kVK_ANSI_Q)
    case "R": return UInt32(kVK_ANSI_R)
    case "S": return UInt32(kVK_ANSI_S)
    case "T": return UInt32(kVK_ANSI_T)
    case "U": return UInt32(kVK_ANSI_U)
    case "V": return UInt32(kVK_ANSI_V)
    case "W": return UInt32(kVK_ANSI_W)
    case "X": return UInt32(kVK_ANSI_X)
    case "Y": return UInt32(kVK_ANSI_Y)
    case "Z": return UInt32(kVK_ANSI_Z)
    default: return nil
    }
  }

  private static func digitKeyCode(_ ch: Character) -> UInt32? {
    switch ch {
    case "0": return UInt32(kVK_ANSI_0)
    case "1": return UInt32(kVK_ANSI_1)
    case "2": return UInt32(kVK_ANSI_2)
    case "3": return UInt32(kVK_ANSI_3)
    case "4": return UInt32(kVK_ANSI_4)
    case "5": return UInt32(kVK_ANSI_5)
    case "6": return UInt32(kVK_ANSI_6)
    case "7": return UInt32(kVK_ANSI_7)
    case "8": return UInt32(kVK_ANSI_8)
    case "9": return UInt32(kVK_ANSI_9)
    default: return nil
    }
  }

  private static func punctuationKeyCode(_ ch: Character) -> UInt32? {
    switch ch {
    case "-": return UInt32(kVK_ANSI_Minus)
    case "=": return UInt32(kVK_ANSI_Equal)
    case "[": return UInt32(kVK_ANSI_LeftBracket)
    case "]": return UInt32(kVK_ANSI_RightBracket)
    case "\\": return UInt32(kVK_ANSI_Backslash)
    case ";": return UInt32(kVK_ANSI_Semicolon)
    case "'": return UInt32(kVK_ANSI_Quote)
    case "`": return UInt32(kVK_ANSI_Grave)
    case ",": return UInt32(kVK_ANSI_Comma)
    case ".": return UInt32(kVK_ANSI_Period)
    case "/": return UInt32(kVK_ANSI_Slash)
    default: return nil
    }
  }

  private static func functionKeyCode(_ index: Int) -> UInt32? {
    switch index {
    case 1: return UInt32(kVK_F1)
    case 2: return UInt32(kVK_F2)
    case 3: return UInt32(kVK_F3)
    case 4: return UInt32(kVK_F4)
    case 5: return UInt32(kVK_F5)
    case 6: return UInt32(kVK_F6)
    case 7: return UInt32(kVK_F7)
    case 8: return UInt32(kVK_F8)
    case 9: return UInt32(kVK_F9)
    case 10: return UInt32(kVK_F10)
    case 11: return UInt32(kVK_F11)
    case 12: return UInt32(kVK_F12)
    case 13: return UInt32(kVK_F13)
    case 14: return UInt32(kVK_F14)
    case 15: return UInt32(kVK_F15)
    case 16: return UInt32(kVK_F16)
    case 17: return UInt32(kVK_F17)
    case 18: return UInt32(kVK_F18)
    case 19: return UInt32(kVK_F19)
    case 20: return UInt32(kVK_F20)
    default: return nil
    }
  }
}
