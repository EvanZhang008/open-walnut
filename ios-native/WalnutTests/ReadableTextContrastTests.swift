import XCTest
import UIKit
@testable import Walnut

/// The live region's ink, held to the TEXT bar.
///
/// Measured on the phone before this: the activity row — the tool name the user
/// asked to be able to see — shimmered between **1.85:1 and 3.39:1** and never
/// reached 4.5:1, because the whole row (text included) was faded to 0.35 on a
/// forever-repeating animation; and the expanded tool card's INPUT / RESULT
/// labels came out at **1.70:1 light / 2.48:1 dark** from `.tertiary`.
///
/// Every ratio here is COMPUTED from the colour the app actually draws. The
/// surfaces are the three these rows really sit on, because measuring an inset
/// card's ink against the page behind it flatters the number in light mode and
/// punishes it in dark.
final class ReadableTextContrastTests: XCTestCase {

    /// WCAG AA for text.
    private let textMinimum = 4.5
    /// WCAG AA for a meaningful non-text glyph.
    private let glyphMinimum = 3.0

    private func traits(dark: Bool) -> UITraitCollection {
        UITraitCollection { $0.userInterfaceStyle = dark ? .dark : .light }
    }

    private func rgba(_ color: UIColor, _ traits: UITraitCollection)
        -> (r: Double, g: Double, b: Double, a: Double) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b), Double(a))
    }

    /// WCAG 2.x relative luminance.
    private func luminance(_ c: (r: Double, g: Double, b: Double, a: Double)) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
    }

    /// `ink` over `paper`, compositing BOTH alphas — a translucent fill (the chip
    /// capsule) and a faded glyph are exactly the cases that get flattered by a
    /// measurement that ignores alpha.
    private func contrast(_ ink: UIColor, over paper: UIColor,
                          inkAlpha: Double = 1, dark: Bool) -> Double {
        let traits = traits(dark: dark)
        let page = rgba(dark ? .black : .white, traits)
        var sheet = rgba(paper, traits)
        sheet = (r: sheet.r * sheet.a + page.r * (1 - sheet.a),
                 g: sheet.g * sheet.a + page.g * (1 - sheet.a),
                 b: sheet.b * sheet.a + page.b * (1 - sheet.a), a: 1)
        var pen = rgba(ink, traits)
        let alpha = pen.a * inkAlpha
        pen = (r: pen.r * alpha + sheet.r * (1 - alpha),
               g: pen.g * alpha + sheet.g * (1 - alpha),
               b: pen.b * alpha + sheet.b * (1 - alpha), a: 1)
        let a = luminance(pen)
        let b = luminance(sheet)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// The three surfaces the live region draws on: the page (activity row), the
    /// expanded card, and a chip capsule.
    private var surfaces: [(String, UIColor)] {
        [("systemBackground", .systemBackground),
         ("secondarySystemBackground", .secondarySystemBackground),
         ("tertiarySystemFill capsule", .tertiarySystemFill)]
    }

    // MARK: - The bar

    func testReadableSecondaryClearsAAOnEverySurfaceInBothSchemes() {
        for dark in [false, true] {
            for (name, paper) in surfaces {
                let ratio = contrast(ReadableText.secondaryUIColor, over: paper, dark: dark)
                XCTAssertGreaterThanOrEqual(
                    ratio, textMinimum,
                    "\(name) \(dark ? "dark" : "light"): \(String(format: "%.2f", ratio)):1")
            }
        }
    }

    /// The defaults this replaces, as the control: a token that measured no better
    /// than `.secondary` / `.tertiary` would be pointless.
    ///
    /// `.secondary` is asserted in LIGHT only, and that is the honest scope: over
    /// dark mode's near-black page it measures ~6.3:1 and is fine. Light is the
    /// mode it fails in (~3.4:1), and the fade to 0.35 is what dragged the dark
    /// side under the bar too — which the shimmer case below covers.
    func testTheSystemDefaultsItReplacesDoNotClearAA() {
        XCTAssertLessThan(
            contrast(.secondaryLabel, over: .systemBackground, dark: false), textMinimum,
            "`.secondary` now clears AA on the light page — re-check whether this token is needed")
        for dark in [false, true] {
            XCTAssertLessThan(
                contrast(.tertiaryLabel, over: .secondarySystemBackground, dark: dark),
                textMinimum,
                "`.tertiary` now clears AA on the card — re-check the INPUT/RESULT labels")
        }
    }

    /// The tool row's two quiet roles, on the CAPSULE they are drawn on.
    ///
    /// Both were `.tertiary` (1.69:1 light / 2.34:1 dark on the phone) and neither
    /// could afford it: the subtitle is the only thing telling eight stacked
    /// `Bash` rows apart, so it is TEXT and owes 4.5:1, and the chevron is the
    /// affordance that says the row opens at all, so it owes the 3:1 non-text
    /// minimum. This pins the ink they are given; `ToolChipInkContrastTests`
    /// measures the pixels the row actually draws with it.
    func testToolChipSubtitleAndChevronInkClearTheirBars() {
        for dark in [false, true] {
            let ratio = contrast(ReadableText.secondaryUIColor,
                                 over: .tertiarySystemFill, dark: dark)
            let where_ = "\(dark ? "dark" : "light"): \(String(format: "%.2f", ratio)):1"
            XCTAssertGreaterThanOrEqual(ratio, textMinimum, "tool subtitle \(where_)")
            XCTAssertGreaterThanOrEqual(ratio, glyphMinimum, "expand chevron \(where_)")
        }
    }

    /// The control for the pair above: what those two roles shipped as. `.tertiary`
    /// misses even the GLYPH bar in both schemes, which is why the chevron counted
    /// as invisible and not merely quiet; and the capsule's `.secondary` name,
    /// asserted in light only for the same reason as above, misses the text bar,
    /// which is why the row now draws one readable ink throughout.
    func testTheToolChipInkItReplacesMissesBothBars() {
        for dark in [false, true] {
            let tertiary = contrast(.tertiaryLabel, over: .tertiarySystemFill, dark: dark)
            XCTAssertLessThan(
                tertiary, glyphMinimum,
                "`.tertiary` now clears the glyph bar on the capsule "
                    + "(\(dark ? "dark" : "light")) — re-check the chevron")
            XCTAssertLessThan(
                tertiary, textMinimum,
                "`.tertiary` now clears AA on the capsule "
                    + "(\(dark ? "dark" : "light")) — re-check the subtitle")
        }
        XCTAssertLessThan(
            contrast(.secondaryLabel, over: .tertiarySystemFill, dark: false), textMinimum,
            "`.secondary` now clears AA on the light capsule — re-check the tool name")
    }

    /// The shimmer's dim end. It rides a DECORATIVE glyph only (the row's text is
    /// never faded now), so it is held to the non-text bar rather than 4.5:1 — but
    /// it is held to something, which the 0.35 it replaces was not.
    func testShimmerFloorKeepsTheGlyphAboveTheNonTextBar() {
        for dark in [false, true] {
            let ratio = contrast(ReadableText.secondaryUIColor, over: .systemBackground,
                                 inkAlpha: ReadableText.shimmerFloor, dark: dark)
            XCTAssertGreaterThanOrEqual(
                ratio, glyphMinimum,
                "glyph at \(ReadableText.shimmerFloor) \(dark ? "dark" : "light"): "
                    + "\(String(format: "%.2f", ratio)):1")
        }
        // And the old floor is what a regression would look like.
        for dark in [false, true] {
            XCTAssertLessThan(
                contrast(.secondaryLabel, over: .systemBackground, inkAlpha: 0.35, dark: dark),
                glyphMinimum, "the shipped 0.35 shimmer should measure as unreadable")
        }
    }
}
