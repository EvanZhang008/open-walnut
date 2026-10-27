import SwiftUI
import UIKit

/// Walnut design system — a warm walnut-brown tint over standard iOS system
/// layering. Colors adapt to light/dark automatically via dynamic providers.
enum Theme {
    /// Primary walnut-brown tint (light #8B5A2B / dark #C99659).
    static let tint = Color(dynamic: tintColor)
    /// Text/icon color drawn on top of the tint.
    static let onTint = Color(dynamic: UIColor(light: 0xFFFFFF, dark: 0x1C1207))
    /// Soft tinted fill for chips, hero icons, selected rows.
    static let tintSoft = Color(dynamic: tintSoftColor)
    /// The two above as UIKit colours, so a test can resolve a scheme and measure
    /// the contrast of text drawn in one over the other.
    static let tintColor = UIColor(light: 0x8B5A2B, dark: 0xC99659)
    static let tintSoftColor = UIColor(light: 0xF4ECE3, dark: 0x2E2418)

    static let success = Color(dynamic: UIColor(light: 0x34C759, dark: 0x30D158))
    static let warning = Color(dynamic: UIColor(light: 0xFF9F0A, dark: 0xFFD60A))
    static let danger = Color(dynamic: dangerColor)
    static let dangerColor = UIColor(light: 0xFF3B30, dark: 0xFF453A)
    /// The user states as words (UserStatePill.textColor): 4.5:1 on the light background and
    /// on the dark one, where the bright tints above only work as dots and washes.
    static let needsText = Color(dynamic: UIColor(light: 0xB23A06, dark: 0xFF9A5C))
    static let workingText = Color(dynamic: UIColor(light: 0x1D4FC4, dark: 0x7FA8FF))
    static let doneText = Color(dynamic: UIColor(light: 0x186A2C, dark: 0x4CD964))
    static let stuckText = Color(dynamic: UIColor(light: 0x854E00, dark: 0xFFD60A))
    /// A secondary line at 4.5:1 or more on secondarySystemBackground in both
    /// appearances (the system's secondary label reaches only 3.3:1 there).
    static let secondaryOnCard = Color(dynamic: UIColor(light: 0x55555B, dark: 0xB8B8BE))
    /// Whole-row wash for "this needs a human" (a task at NEED_ACTION).
    ///
    /// Deliberately the same recipe the desktop uses — `rgba(255,59,48,0.08)` in
    /// `.todo-panel-item-needs-action` — so a row that reads as urgent on the Mac
    /// reads the same on the phone. Dark mode gets a touch more alpha because the
    /// same wash over a near-black background is almost invisible at 8%.
    static let dangerSoft = Color(dynamic: UIColor(
        light: UIColor(rgb: 0xFF3B30).withAlphaComponent(0.08),
        dark: UIColor(rgb: 0xFF453A).withAlphaComponent(0.16)
    ))
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

    /// Same dynamic pairing for colours that already carry alpha — the RGB
    /// initializer above is opaque by construction, so a translucent wash has to
    /// be built first and paired second.
    convenience init(light: UIColor, dark: UIColor) {
        self.init { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
    }
}

private extension Color {
    init(dynamic uiColor: UIColor) {
        self.init(uiColor: uiColor)
    }
}
