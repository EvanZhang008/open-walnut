import XCTest
import UIKit
@testable import Walnut

/// The quick-add placeholder's ink, held to the TEXT bar.
///
/// The platform draws a `TextField`'s label in `UIColor.placeholderText` (`label` at 30%
/// alpha), which over the card these rows sit on measured **2.48:1** in dark mode off a
/// real screenshot, and about **1.7:1** in light. Both are under WCAG AA's 4.5:1, and
/// light is the worse of the two even though dark is the one that gets noticed by eye.
///
/// That default is defensible for a placeholder that only repeats the field's name. It is
/// not defensible here: this placeholder is the ONLY statement of where the typed task
/// gets filed ("Add to Focus…", "Add to <project>…", "Add task on Tuesday…"), so it is
/// information presented as text and gets the text bar.
///
/// The ratio is computed against `BoardBandCard.surfaceColor` — the CARD, because these
/// rows are inset-grouped cells, not the page behind them. Measuring against the page
/// would flatter the number in light mode and punish it in dark.
final class FieldPlaceholderContrastTests: XCTestCase {

    private func traits(dark: Bool, boosted: Bool = false) -> UITraitCollection {
        UITraitCollection { mutable in
            mutable.userInterfaceStyle = dark ? .dark : .light
            mutable.accessibilityContrast = boosted ? .high : .normal
        }
    }

    /// WCAG 2.x relative luminance of an OPAQUE colour resolved for a trait collection.
    private func luminance(_ color: UIColor, _ traits: UITraitCollection) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        func linear(_ channel: CGFloat) -> Double {
            let c = Double(channel)
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    private func contrast(_ ink: UIColor, over paper: UIColor, _ traits: UITraitCollection) -> Double {
        let a = luminance(ink, traits)
        let b = luminance(paper, traits)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    // MARK: - The bar

    func testThePlaceholderClearsAAOverTheCardInBothSchemes() {
        for dark in [false, true] {
            let ratio = contrast(
                FieldPlaceholder.inkColor, over: BoardBandCard.surfaceColor, traits(dark: dark)
            )
            XCTAssertGreaterThanOrEqual(
                ratio, 4.5,
                "dark=\(dark): the placeholder measured \(ratio) — the platform default is "
                    + "~1.7 light / 2.48 dark, which is what this replaces"
            )
        }
    }

    func testIncreasedContrastAsksForMoreAndGetsIt() {
        for dark in [false, true] {
            let normal = contrast(
                FieldPlaceholder.inkColor, over: BoardBandCard.surfaceColor, traits(dark: dark)
            )
            let boosted = contrast(
                FieldPlaceholder.inkColor, over: BoardBandCard.surfaceColor,
                traits(dark: dark, boosted: true)
            )
            XCTAssertGreaterThan(
                boosted, normal,
                "dark=\(dark): a dynamic colour that ignores `accessibilityContrast` is a "
                    + "setting the user turned on and the app declined to honour"
            )
            XCTAssertGreaterThanOrEqual(boosted, 6, "dark=\(dark): boosted = \(boosted)")
        }
    }

    // MARK: - …and it still has to READ as a placeholder

    func testThePlaceholderIsStillPlainlyQuieterThanTypedText() {
        // The failure mode on the other side of this fix is a placeholder so dark that
        // the field looks filled, and the user deletes text that was never there. Typed
        // text is `label`; the gap between the two has to stay large.
        //
        // Measured as a share of CONTRAST RATIO, not of luminance distance. Luminance is
        // not perceptually linear — grey 110 on white sits 84% of the way from white to
        // black by luminance and nothing like 84% of the way by eye — so a luminance
        // share reads as a failure for an ink that is obviously a hint. The ratio is the
        // quantity WCAG defines for exactly this comparison.
        for dark in [false, true] {
            let t = traits(dark: dark)
            let hint = contrast(FieldPlaceholder.inkColor, over: BoardBandCard.surfaceColor, t)
            let typed = contrast(.label, over: BoardBandCard.surfaceColor, t)
            let share = hint / typed
            XCTAssertLessThan(
                share, 0.5,
                "dark=\(dark): the placeholder spends \(share) of the contrast typed text "
                    + "does — at that strength it reads as content"
            )
        }
    }

    func testTheInkIsOpaqueSoItCannotDependOnWhatIsBehindIt() {
        // A translucent placeholder is how the platform's own gets its number: `label` at
        // 30%, which means the ratio changes with the paper. Every surface this ink is
        // used on would then need its own measurement.
        for dark in [false, true] {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, alpha: CGFloat = 0
            FieldPlaceholder.inkColor.resolvedColor(with: traits(dark: dark))
                .getRed(&r, green: &g, blue: &b, alpha: &alpha)
            XCTAssertEqual(alpha, 1, accuracy: 0.001, "dark=\(dark)")
        }
    }
}
