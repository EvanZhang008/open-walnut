import SwiftUI
import UIKit

/// Walnut design system — a warm walnut-brown tint over standard iOS system
/// layering. Colors adapt to light/dark automatically via dynamic providers.
enum Theme {
    /// Primary walnut-brown tint (light #8B5A2B / dark #C99659).
    static let tint = Color(dynamic: UIColor(light: 0x8B5A2B, dark: 0xC99659))
    /// Text/icon color drawn on top of the tint.
    static let onTint = Color(dynamic: UIColor(light: 0xFFFFFF, dark: 0x1C1207))
    /// Soft tinted fill for chips, hero icons, selected rows.
    static let tintSoft = Color(dynamic: UIColor(light: 0xF4ECE3, dark: 0x2E2418))

    static let success = Color(dynamic: UIColor(light: 0x34C759, dark: 0x30D158))
    static let warning = Color(dynamic: UIColor(light: 0xFF9F0A, dark: 0xFFD60A))
    static let danger = Color(dynamic: UIColor(light: 0xFF3B30, dark: 0xFF453A))
}

private extension UIColor {
    convenience init(rgb: Int) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }

    convenience init(light: Int, dark: Int) {
        self.init { traits in
            traits.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light)
        }
    }
}

private extension Color {
    init(dynamic uiColor: UIColor) {
        self.init(uiColor: uiColor)
    }
}
