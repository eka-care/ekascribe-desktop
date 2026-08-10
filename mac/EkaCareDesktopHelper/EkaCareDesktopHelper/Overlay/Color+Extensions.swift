import SwiftUI

extension Color {
    /// Initialize Color with a hex code (e.g., 0x4287f5 or "#4287f5" or "4287f5")
    /// Supports 6-digit (RGB) and 8-digit (RGBA) hex values.
    public init(hex: String) {
        var hexString = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if hexString.hasPrefix("#") {
            hexString.removeFirst()
        }
        
        var hexValue: UInt64 = 0
        Scanner(string: hexString).scanHexInt64(&hexValue)
        self.init(hex: hexValue, includeAlpha: hexString.count > 6)
    }
    
    /// Initialize Color with a numeric hex code, e.g., 0x4287f5 or 0xff4287f5
    /// If includeAlpha is true and hex is 8 digits, treats as AARRGGBB, else as RRGGBB
    public init(hex: UInt64, includeAlpha: Bool = false) {
        let r, g, b, a: Double
        if includeAlpha {
            r = Double((hex & 0x00FF_0000) >> 16) / 255.0
            g = Double((hex & 0x0000_FF00) >> 8) / 255.0
            b = Double(hex & 0x0000_00FF) / 255.0
            a = Double((hex & 0xFF00_0000) >> 24) / 255.0
        } else {
            r = Double((hex & 0xFF00_00) >> 16) / 255.0
            g = Double((hex & 0x00FF_00) >> 8) / 255.0
            b = Double(hex & 0x0000_FF) / 255.0
            a = 1.0
        }
        self.init(red: r, green: g, blue: b, opacity: a)
    }
}
