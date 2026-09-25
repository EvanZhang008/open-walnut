import UIKit
import XCTest
@testable import Walnut

/// The composer pills' text must be readable: WCAG AA (4.5:1) for the enabled
/// pill in light AND dark, and the disabled pill visibly quieter than it.
///
/// The gate measured the old `.secondary` ink at 2.04:1 (light) and 2.44:1
/// (dark) on the device. This resolves the pills' real colors for each
/// appearance and composites them the way the screen does: ink over the capsule
/// fill, over the composer bar's background.
final class ComposerPillContrastTests: XCTestCase {

    private struct RGB { var r: Double; var g: Double; var b: Double }

    private func resolved(_ color: UIColor, _ style: UIUserInterfaceStyle) -> (RGB, Double) {
        let c = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(c.getRed(&r, green: &g, blue: &b, alpha: &a))
        return (RGB(r: r, g: g, b: b), a)
    }

    /// `color` (with its alpha) laid over an opaque `base`.
    private func over(_ color: UIColor, _ base: RGB, _ style: UIUserInterfaceStyle) -> RGB {
        let (c, a) = resolved(color, style)
        return RGB(r: c.r * a + base.r * (1 - a), g: c.g * a + base.g * (1 - a), b: c.b * a + base.b * (1 - a))
    }

    private func luminance(_ c: RGB) -> Double {
        func channel(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    private func contrast(_ a: RGB, _ b: RGB) -> Double {
        let (l1, l2) = (luminance(a), luminance(b))
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    /// Ink on the pill, on each background the composer bar can sit on.
    private func pillContrast(ink: UIColor, _ style: UIUserInterfaceStyle) -> Double {
        [UIColor.systemBackground, .secondarySystemBackground].map { background in
            let base = over(background, RGB(r: 1, g: 1, b: 1), style)
            let capsule = over(ComposerPillInk.capsule, base, style)
            return contrast(over(ink, capsule, style), capsule)
        }.min()!
    }

    func testTheEnabledPillMeetsAAInLightAndDark() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let ratio = pillContrast(ink: ComposerPillInk.enabled, style)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "enabled pill text is \(ratio):1 in \(style == .dark ? "dark" : "light")")
        }
    }

    func testTheOldSecondaryInkWasBelowTheBar() {
        // The regression this fixes, measured the same way: the system's
        // secondary label on the same capsule is under AA.
        XCTAssertLessThan(pillContrast(ink: .secondaryLabel, .light), 4.5)
    }

    /// The pill's UIKit button is its one accessibility element, so it must say
    /// "dimmed" exactly when it is disabled. A stored `.button` trait used to hide
    /// that: the gate's pick test saw a disabled pill reported as enabled.
    @MainActor
    func testADisabledPillIsAnnouncedAsDimmed() {
        let button = PillMenuUIButton(frame: .zero)
        XCTAssertTrue(button.accessibilityTraits.contains(.button))
        XCTAssertFalse(button.accessibilityTraits.contains(.notEnabled))
        button.isEnabled = false
        XCTAssertTrue(button.accessibilityTraits.contains(.notEnabled))
        XCTAssertTrue(button.accessibilityTraits.contains(.button))
        button.isEnabled = true
        XCTAssertFalse(button.accessibilityTraits.contains(.notEnabled))
    }

    /// The pill whose pick is being written names the model the user just chose:
    /// it keeps readable ink (the spinner says busy). It measured 1.69:1 in the
    /// quiet ink (gate r2).
    func testThePillBeingWrittenStaysReadable() {
        typealias State = ComposerControlsModel.PillState
        for state in [State.ready, .writing, .lastKnown] {
            XCTAssertTrue(ComposerPillInk.ink(for: state) === ComposerPillInk.enabled, "\(state) must be readable")
            for style in [UIUserInterfaceStyle.light, .dark] {
                let ratio = pillContrast(ink: ComposerPillInk.ink(for: state), style)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(state) is \(ratio):1 in \(style == .dark ? "dark" : "light")")
            }
        }
        XCTAssertTrue(ComposerPillInk.ink(for: .waiting) === ComposerPillInk.disabled,
                      "a pill that is only waiting (the other pill, a switch) stays quiet")
        XCTAssertTrue(State.ready.takesTaps)
        XCTAssertFalse(State.writing.takesTaps || State.waiting.takesTaps || State.lastKnown.takesTaps)
        XCTAssertTrue(State.writing.spins)
        XCTAssertFalse(State.ready.spins || State.waiting.spins || State.lastKnown.spins)
    }

    func testTheDisabledPillIsQuieterThanTheEnabledOne() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let enabled = pillContrast(ink: ComposerPillInk.enabled, style)
            let disabled = pillContrast(ink: ComposerPillInk.disabled, style)
            XCTAssertLessThan(disabled * 1.5, enabled,
                              "a disabled pill (\(disabled):1) must read clearly quieter than an enabled one (\(enabled):1)")
        }
    }
}
