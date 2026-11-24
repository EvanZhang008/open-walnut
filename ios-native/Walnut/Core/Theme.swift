import SwiftUI
import UIKit

/// Walnut design system: Walnut's warm brown accent over standard iOS system layering, and the
/// tokens and shared controls in `ThemeTokens.swift` and `Views/Shared/DesignSystem/`
/// (.claude/skills/walnut-ui-requirements/standard.md, its iOS column). Colors adapt to
/// light/dark automatically via dynamic providers.
enum Theme {
    /// The accent: Walnut's brown (light #8B5A2B, dark the golden #C99659). Links, selected
    /// things, icons that act, the text of a quiet action. The phone keeps it rather than the
    /// web's blue (2026-11-24, the user: the earlier yellow-based look is nicer, "because it's
    /// Walnut").
    static let tint = Color(dynamic: tintColor)
    /// Words and glyphs drawn on a solid `accent` (or `tint`) fill: white on the brown, a dark
    /// brown on the golden dark-mode fill (white on #C99659 reads only 2.2:1).
    static let onTint = Color(dynamic: onTintColor)
    static let onTintColor = UIColor(light: 0xFFFFFF, dark: 0x1C1207)
    /// Soft tinted fill for selected chips, tags and hero icons. Light enough that the tint's own
    /// words on it read at 4.5:1 (`ReadableTextContrastTests`).
    static let tintSoft = Color(dynamic: tintSoftColor)
    /// The two above as UIKit colours, so a test can resolve a scheme and measure
    /// the contrast of text drawn in one over the other.
    static let tintColor = UIColor(light: 0x8B5A2B, dark: 0xC99659)
    static let tintSoftColor = UIColor(light: 0xF4ECE3, dark: 0x2E2418)
    /// A selected chip's fill (`WalnutChipStyle`): a step stronger than `tintSoft`, which on a
    /// white rail read as an empty chip with a tinted line. Primary words only on it.
    static let chipSelected = Color(dynamic: chipSelectedColor)
    static let chipSelectedColor = UIColor(light: 0xEADCCB, dark: 0x4A3920)
    /// The solid fill of the one main action (`WalnutButtonStyle.primary`, a recommended option, a
    /// filled send key): the accent itself, with `onTint` words.
    static let accent = Color(dynamic: accentColor)
    static let accentColor = tintColor
    /// The grey of a quiet control (a secondary button, an unselected chip, a disabled main
    /// action): OPAQUE, so a control drawn twice (a pinned bar and its inline copy) is the same
    /// pixels over any page, and a full step away from a white or grouped card in both
    /// appearances (the system's translucent fills were 16 levels from a white card). Its
    /// pressed state is `controlFillPressedColor`.
    static let controlFill = Color(dynamic: controlFillColor)
    static let controlFillColor = UIColor(light: 0xE5E5EA, dark: 0x343436)
    static let controlFillPressed = Color(dynamic: controlFillPressedColor)
    static let controlFillPressedColor = UIColor(light: 0xD1D1D6, dark: 0x48484A)

    static let success = Color(dynamic: UIColor(light: 0x34C759, dark: 0x30D158))
    static let warning = Color(dynamic: UIColor(light: 0xFF9F0A, dark: 0xFFD60A))
    static let danger = Color(dynamic: dangerColor)
    static let dangerColor = UIColor(light: 0xFF3B30, dark: 0xFF453A)
    /// Words on a button whose fill is the danger tint at about a quarter strength (a bordered
    /// destructive button): 4.5:1 or more on that fill in both appearances, where the bare tint
    /// reaches only about 3.6:1 in dark.
    static let dangerText = Color(dynamic: dangerTextColor)
    static let dangerTextColor = UIColor(light: 0xB0121A, dark: 0xFF7A75)
    /// The user states as words (UserStatePill.textColor): 4.5:1 on the light background and
    /// on the dark one, where the bright tints above only work as dots and washes.
    static let needsText = Color(dynamic: UIColor(light: 0xB23A06, dark: 0xFF9A5C))
    static let workingText = Color(dynamic: workingTextColor)
    /// `workingText` as UIKit, so a test can measure the accent badge's words.
    static let workingTextColor = UIColor(light: 0x1D4FC4, dark: 0x7FA8FF)
    static let doneText = Color(dynamic: UIColor(light: 0x186A2C, dark: 0x4CD964))
    /// A Needs you row's category word (`NeedCategory`): Decide in red and Review in orange,
    /// readable as bold caption text on both backgrounds (Take a look is workingText, Can close
    /// doneText).
    static let decideText = Color(dynamic: UIColor(light: 0xC4161C, dark: 0xFF6B66))
    static let reviewText = Color(dynamic: UIColor(light: 0xA84B00, dark: 0xFFA64D))
    static let stuckText = Color(dynamic: UIColor(light: 0x854E00, dark: 0xFFD60A))
    /// A secondary line at 4.5:1 or more on secondarySystemBackground in both
    /// appearances (the system's secondary label reaches only 3.3:1 there). `ReadableText`
    /// is this grey too; `ReadableTextContrastTests` measures it on every surface it sits on.
    static let secondaryOnCard = Color(dynamic: secondaryOnCardColor)
    static let secondaryOnCardColor = UIColor(light: 0x55555B, dark: 0xB8B8BE)
    /// A text field's placeholder ink (`FieldPlaceholder`, which says why): 4.5:1 or more on a
    /// grouped card in both appearances and deeper under Increase Contrast, still clearly
    /// lighter than typed text. `FieldPlaceholderContrastTests` pins each of the four.
    static let placeholderInkColor = UIColor { traits in
        switch (traits.userInterfaceStyle == .dark, traits.accessibilityContrast == .high) {
        case (false, false): return UIColor(rgb: 0x6E6E76)
        case (false, true): return UIColor(rgb: 0x5A5A62)
        case (true, false): return UIColor(rgb: 0x98989E)
        case (true, true): return UIColor(rgb: 0xB2B2B8)
        }
    }
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

extension UIColor {
    /// An opaque colour from 0xRRGGBB (the design system's colours are written this way, in Theme only).
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

extension Color {
    init(dynamic uiColor: UIColor) {
        self.init(uiColor: uiColor)
    }
}
