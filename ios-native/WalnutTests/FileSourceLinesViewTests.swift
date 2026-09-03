import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// The file viewer's ANCHOR behaviour and its line-number gutter, tested by
/// rendering the real SwiftUI view in a real window and reading pixels back.
///
/// This layer exists because nothing in the suite referenced
/// `FileSourceLinesView`, `anchorLine`, or the flash at all, and a UI gate
/// reported the temporary highlight as never drawing on device. Pure logic tests
/// cannot settle that question: the state can be right while the drawing is
/// missing, so the test has to go all the way to pixels.
///
/// What this proves: that hosting the view, letting its `.task` run, and looking
/// at the screen yields a tinted band on the anchored line — including when the
/// anchor is hundreds of rows down a lazily-realised file — and that the band is
/// temporary.
/// What it cannot prove: anything about the sheet that presents it, or the
/// feel of the scroll. Those stay device checks.
@MainActor
final class FileSourceLinesViewTests: XCTestCase {

    /// Where the visual evidence lands, so a human can look at the same frames
    /// the assertions counted. Under the process temp dir, not a hardcoded
    /// `/tmp/...`: this suite also runs on CI machines that do not have one.
    private static let evidenceDir =
        NSTemporaryDirectory() + "walnut-file-viewer-frames"

    // MARK: - Harness

    /// A window we can actually draw.
    ///
    /// The `windowScene` assignment is the whole harness. Without it the window
    /// belongs to no screen: `drawHierarchy` then returns a blank image and
    /// `layer.render` returns only the window's own background colour, so EVERY
    /// measurement reads 0 warm pixels and the harness "reproduces" any bug you
    /// point it at. That false negative cost a full diagnosis cycle here, which
    /// is why `testTheHarnessCanSeeColourAtAll` runs first.
    private func host<V: View>(_ view: V, height: CGFloat = 700,
                              typeSize: DynamicTypeSize = .large) -> (UIWindow, UIHostingController<some View>) {
        let controller = UIHostingController(rootView: view.dynamicTypeSize(typeSize))
        controller.view.backgroundColor = .white
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: height))
        if let scene = UIApplication.shared.connectedScenes
            .first(where: { $0 is UIWindowScene }) as? UIWindowScene {
            window.windowScene = scene
        }
        window.backgroundColor = .white
        // Light mode pinned: the assertion is about a specific tint over white,
        // and Theme.tint is a dynamic colour with a different dark variant.
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = controller
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return (window, controller)
    }

    /// Hiding a window leaves it attached to the scene, still competing with the
    /// next one for key status. A run of pixel tests in one process needs each
    /// window torn down, or a later test measures an earlier test's screen.
    private func release(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
        window.windowScene = nil
    }

    /// Let main-actor continuations (and CoreAnimation) run. `Task.sleep` in a
    /// test would suspend THIS test's actor without servicing the run loop, so
    /// the view's own task would never get a turn.
    private func pump(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func snapshot(_ window: UIWindow) -> CGImage {
        let renderer = UIGraphicsImageRenderer(size: window.bounds.size)
        let image = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        return image.cgImage!
    }

    /// Keep a frame on disk. The assertions count pixels; a human still has to
    /// be able to look at what was counted.
    private func save(_ image: CGImage, as name: String) {
        try? FileManager.default.createDirectory(atPath: Self.evidenceDir,
                                                 withIntermediateDirectories: true)
        guard let data = UIImage(cgImage: image).pngData() else { return }
        let path = "\(Self.evidenceDir)/\(name).png"
        try? data.write(to: URL(fileURLWithPath: path))
        print("FRAME \(path)")
    }

    /// Count pixels that are meaningfully NOT grey.
    ///
    /// Everything else this view draws is neutral (label text, a tertiary
    /// gutter, a white background), so a warm pixel can only be
    /// `Theme.tint.opacity(0.22)`. Light-mode tint is 0x8B5A2B, which over white
    /// lands at roughly (230, 219, 208) — an r−b of about 21.
    private func warmPixelCount(_ image: CGImage, minRedOverBlue: Int = 8) -> Int {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var warm = 0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = Int(pixels[i]), b = Int(pixels[i + 2])
            if r - b >= minRedOverBlue { warm += 1 }
        }
        return warm
    }

    private func fixture(lines: Int) -> String {
        (1...lines).map { "line \($0) content" }.joined(separator: "\n")
    }

    // MARK: - The harness itself

    /// A control, first, on purpose: a measurement harness that cannot see a
    /// full screen of tint cannot testify about a 15pt band either. Every
    /// assertion below is worthless if this one is.
    func testTheHarnessCanSeeColourAtAll() {
        struct Control: View {
            var body: some View { ZStack { Color.white; Theme.tint.opacity(0.22) } }
        }
        let (window, _) = host(Control())
        defer { release(window) }
        pump(0.3)
        let warm = warmPixelCount(snapshot(window))
        XCTAssertGreaterThan(warm, 500_000,
                             "the harness is blind — every other assertion in this file is meaningless (warm pixels: \(warm))")
    }

    // MARK: - The anchor highlight

    func testAnchoredLineHighlightDrawsDuringTheFlashWindow() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 40), anchorLine: 5))
        defer { release(window) }
        // Past the 60ms pre-scroll delay, far short of the 2.2s fade.
        pump(0.8)
        let image = snapshot(window)
        save(image, as: "flash-short-anchor5")
        let warm = warmPixelCount(image)
        XCTAssertGreaterThan(warm, 200,
                             "the anchored line's highlight never drew (warm pixels: \(warm))")
    }

    /// The shape the device actually had: the anchor is hundreds of rows down, so
    /// its row does not exist until `scrollTo` realises it. A highlight that only
    /// works on rows already on screen would be a highlight that never works,
    /// because a reader who can already see the line does not need to be told
    /// where it is.
    func testAnchoredLineHighlightSurvivesTheLazyScrollDownALongFile() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 400), anchorLine: 349))
        defer { release(window) }
        pump(1.0)
        let image = snapshot(window)
        save(image, as: "flash-long-anchor349")
        let warm = warmPixelCount(image)
        XCTAssertGreaterThan(warm, 200,
                             "line 349 of a 400-line file scrolled into view unhighlighted (warm pixels: \(warm))")
    }

    func testNoHighlightWithoutAnAnchor() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 40), anchorLine: nil))
        defer { release(window) }
        pump(0.8)
        XCTAssertEqual(warmPixelCount(snapshot(window)), 0,
                       "a file opened with no line reference must not paint a highlight")
    }

    func testHighlightFadesAfterTheFlashWindow() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 40), anchorLine: 5))
        defer { release(window) }
        pump(0.8)
        XCTAssertGreaterThan(warmPixelCount(snapshot(window)), 200, "precondition: it drew")
        // 60ms + 250ms + 2.2s flash + 0.5s fade, plus slack.
        pump(3.6)
        let image = snapshot(window)
        save(image, as: "flash-faded")
        let warm = warmPixelCount(image)
        XCTAssertLessThan(warm, 50, "the highlight is meant to be temporary (warm pixels: \(warm))")
    }

    func testAnchorRangeHighlightsEveryLineInTheRange() {
        let (single, _) = host(FileSourceLinesView(content: fixture(lines: 40), anchorLine: 5))
        pump(0.8)
        let oneLine = warmPixelCount(snapshot(single))
        release(single)

        let (range, _) = host(FileSourceLinesView(content: fixture(lines: 40),
                                                  anchorLine: 5, anchorEndLine: 9))
        defer { release(range) }
        pump(0.8)
        let image = snapshot(range)
        save(image, as: "flash-range-5-9")
        let fiveLines = warmPixelCount(image)
        XCTAssertGreaterThan(fiveLines, oneLine * 3,
                             "#L5-L9 must band five rows, not one (\(fiveLines) vs \(oneLine))")
    }

    // MARK: - Gutter at accessibility sizes

    /// The gutter must fit its widest line NUMBER at every type size. Hardcoding
    /// points-per-digit rendered 146 as "1"/"4"/"6" stacked down three separate
    /// body lines at accessibility-XXXL: not ugly, WRONG, because each digit then
    /// sits beside a different line of the file.
    /// Same rule the board's count carries (TaskBoardList.countLabel).
    /// A line number is an identifier, not a quantity.
    ///
    /// `Text("\(number)")` formatted it as an amount, so line 1421 drew as "1,421"
    /// — one glyph more than was measured, which overflowed the trailing-aligned
    /// frame and clipped the leading digit off at accessibility sizes. Both the
    /// drawing and the measurement now go through `lineNumberText`, so they cannot
    /// disagree; this pins the string itself.
    func testLineNumberIsNeverFormattedAsAQuantity() {
        for number in [1, 42, 1_421, 52_310, 1_000_000] {
            let text = FileSourceLinesView.lineNumberText(number)
            XCTAssertEqual(text, String(number))
            XCTAssertTrue(text.allSatisfy { $0.isASCII && $0.isNumber },
                          "line \(number) rendered as \"\(text)\", which is not just digits")
        }
        // The trap, stated: a grouping locale really does insert a separator.
        XCTAssertEqual(1_421.formatted(.number.locale(Locale(identifier: "en_US"))), "1,421")
        XCTAssertNotEqual(FileSourceLinesView.lineNumberText(1_421),
                          1_421.formatted(.number.locale(Locale(identifier: "en_US"))))
    }

    /// The measurement measures the string that is actually drawn, for line counts
    /// on both sides of the first grouping boundary.
    func testGutterFitsTheStringItActuallyDraws() {
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            let traits = UITraitCollection(preferredContentSizeCategory: category)
            let font = FileSourceLinesView.gutterFont(traits: traits)
            for count in [999, 1_000, 1_421, 12_345] {
                let drawn = FileSourceLinesView.lineNumberText(count) as NSString
                let needed = ceil(drawn.size(withAttributes: [.font: font]).width)
                let allowed = FileSourceLinesView.gutterWidth(forLineCount: count, traits: traits)
                XCTAssertGreaterThanOrEqual(
                    allowed, needed,
                    "\(count) lines at \(category.rawValue): \"\(drawn)\" needs \(needed)pt, gutter gives \(allowed)pt"
                )
            }
        }
    }

    func testGutterFitsItsWidestLineNumberAtEveryTypeSize() {
        let categories: [UIContentSizeCategory] = [
            .small, .large, .extraExtraLarge,
            .accessibilityLarge, .accessibilityExtraExtraExtraLarge,
        ]
        for category in categories {
            let traits = UITraitCollection(preferredContentSizeCategory: category)
            for count in [9, 40, 147, 1_421, 4096, 52_310] {
                let allowed = FileSourceLinesView.gutterWidth(forLineCount: count, traits: traits)
                let needed = FileSourceLinesView.numberWidth(forLineCount: count, traits: traits)
                XCTAssertGreaterThanOrEqual(
                    allowed, needed,
                    "\(count) lines at \(category.rawValue): gutter \(allowed)pt cannot fit a \(needed)pt number, so it wraps between digits"
                )
            }
        }
    }

    func testGutterGrowsWithTheTypeSize() {
        let small = FileSourceLinesView.gutterWidth(
            forLineCount: 147, traits: UITraitCollection(preferredContentSizeCategory: .large))
        let huge = FileSourceLinesView.gutterWidth(
            forLineCount: 147,
            traits: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge))
        XCTAssertGreaterThan(huge, small * 1.5,
                             "the gutter is measured at the CURRENT type size, not a constant")
    }

    /// A three-digit number must occupy ONE line at XXXL when given the gutter's
    /// own width — the direct pixel-free statement of the defect.
    func testThreeDigitNumberDoesNotWrapInsideTheGutterAtXXXL() {
        let traits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let width = FileSourceLinesView.gutterWidth(forLineCount: 147, traits: traits)
        let font = FileSourceLinesView.gutterFont(traits: traits)
        let bounds = ("146" as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
        XCTAssertLessThan(bounds.height, font.lineHeight * 1.5,
                          "146 wrapped onto \(bounds.height / font.lineHeight) lines inside a \(width)pt gutter")
    }

    /// The view drawn at accessibility-XXXL, so the digits can be looked at
    /// rather than argued about. The gutter is measured from the environment, so
    /// a mismatch between what `gutterWidth` returns and what the row asks for
    /// would show up here and nowhere else.
    func testGutterRendersItsNumbersOnOneLineAtXXXL() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 147), anchorLine: 146),
                               typeSize: .accessibility5)
        defer { release(window) }
        pump(1.0)
        let image = snapshot(window)
        save(image, as: "gutter-xxxl-147-lines")
        // The highlight lands on line 146, which also proves the anchor works at
        // this type size (row heights are ~3x, so the scroll distance differs).
        XCTAssertGreaterThan(warmPixelCount(image), 200,
                             "no highlighted row at XXXL — the anchor or the scroll broke at large type")
    }

    /// Four digits at accessibility-XXXL, which is where the grouping separator
    /// clipped the leading `1` off "1,421" and left "`,421`" on screen.
    func testGutterRendersFourDigitNumbersOnOneLineAtXXXL() {
        let (window, _) = host(FileSourceLinesView(content: fixture(lines: 1_500), anchorLine: 1_421),
                               typeSize: .accessibility5)
        defer { release(window) }
        pump(1.4)
        let image = snapshot(window)
        save(image, as: "gutter-xxxl-1500-lines")
        XCTAssertGreaterThan(warmPixelCount(image), 200,
                             "line 1421 of a 1500-line file never highlighted at XXXL")
    }
}
