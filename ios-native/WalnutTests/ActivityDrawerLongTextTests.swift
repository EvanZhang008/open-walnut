import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// THE DRAWER HAS TO DRAW THE TEXT IT SAYS IT IS SHOWING.
///
/// At accessibility XXXL a section the size of the drawer's render window (20,000
/// characters) drew NOTHING on the phone: the footer read "Showing the first 20,000 of
/// 30,000 characters", `Show more` sat under it, and the text area was white at the
/// large detent and see-through at the medium one (2026-09-12, iPhone 16 Pro
/// simulator). The same 20,000 characters at the default text size drew fine.
///
/// It takes TWO things, found by elimination ON THE DEVICE (each tried alone, each still
/// blank): no single `Text` may be that tall, and no selection overlay may span a block
/// that tall. `.textSelection(.disabled)` does not count as removing the overlay. Both
/// are decided from one TextKit measurement of the block.
///
/// WHAT THIS FILE CAN AND CANNOT PROVE. The painting itself is the render server's
/// behaviour and no in-process seam sees it: `sizeThatFits` answers a plausible height
/// for text that never paints, and a `drawHierarchy` raster of the real sheet at XXXL
/// came back with the same inked-row count for a 600-character section and a
/// 20,000-character one (1,563 rows), i.e. it re-renders on the CPU and cannot
/// reproduce the bug at all. Both were tried. So the device screenshots are the
/// evidence for the paint, and this file pins the RULE the fix turns on — the height
/// measurement and the decision it feeds — which is the part that can silently drift.
@MainActor
final class ActivityDrawerLongTextTests: XCTestCase {
    /// Prose of an exact length: sentences, so wrapping behaves like real reasoning
    /// rather than like one unbreakable word.
    private func prose(_ count: Int) -> String {
        var out = ""
        var i = 1
        while out.count < count {
            out += "Reasoning step \(String(format: "%03d", i)) of the run held its "
                + "budget and the next one is queued behind it. "
            i += 1
        }
        return String(out.prefix(count))
    }

    /// The case that shipped blank stays out of the selectable path, and the case that
    /// was fine stays in it. Both measured, so the numbers are the test.
    func testAFullRenderWindowIsSelectableAtTheDefaultSizeAndNotAtXXXL() {
        let window = prose(TimelineDrawerSection.renderWindow)
        let atDefault = TimelineLongText.measuredHeight(
            window, uiFont: TimelineLongText.resolvedFont(style: .callout,
                                                          monospaced: false, size: .large))
        let atXXXL = TimelineLongText.measuredHeight(
            window, uiFont: TimelineLongText.resolvedFont(style: .callout,
                                                          monospaced: false,
                                                          size: .accessibility5))
        print("PROBE-SELECTABLE window default=\(atDefault)pt xxxl=\(atXXXL)pt "
              + "ceiling=\(TimelineLongText.selectableHeight)pt")
        // The two heights are the whole reason the bug depends on text size.
        XCTAssertGreaterThan(atXXXL, atDefault * 3,
                             "the same text has to be far taller at XXXL, or the rule "
                                 + "below is guarding nothing")
        XCTAssertTrue(
            TimelineLongText.isSelectable(window, style: .callout, size: .large),
            "20,000 characters at the default size measured \(atDefault)pt and paints "
                + "on the device — dropping selection there would take a working "
                + "capability away")
        XCTAssertFalse(
            TimelineLongText.isSelectable(window, style: .callout, size: .accessibility5),
            "20,000 characters at XXXL measured \(atXXXL)pt, which is the shape that "
                + "painted an empty page")
    }

    /// EVERY SECTION A LIVE SERVER SENDS TODAY KEEPS SELECTION, at every text size.
    /// The excerpt lengths are the server's own caps (a reasoning block clipped at
    /// 2,000 characters, a tool result at 700), so this is the case a reader meets.
    func testTodaysExcerptsStaySelectableAtEveryTextSize() {
        let reasoning = prose(2_001)
        let result = prose(700)
        for size in DynamicTypeSize.allCases {
            XCTAssertTrue(
                TimelineLongText.isSelectable(reasoning, style: .callout, size: size),
                "a 2,001-character reasoning excerpt lost selection at \(size)")
            XCTAssertTrue(
                TimelineLongText.isSelectable(result, style: .caption2,
                                              monospaced: true, size: size),
                "a 700-character tool result lost selection at \(size)")
        }
    }

    /// The cheap path is a SHORTCUT, not a different answer: below the skip threshold
    /// nothing is measured, so that threshold has to be somewhere the measurement would
    /// have said yes anyway — at the largest size and the tallest-measuring style.
    ///
    /// RED PROOF: the first version of this rule skipped at 4,000 characters, which this
    /// case measured at 22,860pt against a then-8,192pt ceiling.
    func testTheSkipThresholdCannotHideATooTallBlock() {
        let atThreshold = prose(TimelineLongText.alwaysSelectable)
        let height = TimelineLongText.measuredHeight(
            atThreshold,
            uiFont: TimelineLongText.resolvedFont(style: .caption2, monospaced: true,
                                                  size: .accessibility5))
        print("PROBE-SELECTABLE threshold=\(TimelineLongText.alwaysSelectable) "
              + "height=\(height)pt")
        XCTAssertLessThanOrEqual(
            height, TimelineLongText.selectableHeight,
            "\(TimelineLongText.alwaysSelectable) characters measure \(height)pt at XXXL, "
                + "past the \(TimelineLongText.selectableHeight)pt ceiling — so the skip "
                + "is waving through exactly the block the ceiling exists to catch")
    }

    /// The monospaced body is measured with a MONOSPACED face. A proportional face of
    /// the same point size fits more characters per line, so measuring the wrong one
    /// understates a tool result's height — the direction that leads back to a blank
    /// page.
    func testAMonospacedSectionIsMeasuredWithAMonospacedFace() {
        let text = prose(20_000)
        let mono = TimelineLongText.measuredHeight(
            text, uiFont: TimelineLongText.resolvedFont(style: .caption2, monospaced: true,
                                                        size: .accessibility5))
        let proportional = TimelineLongText.measuredHeight(
            text, uiFont: TimelineLongText.resolvedFont(style: .caption2, monospaced: false,
                                                        size: .accessibility5))
        print("PROBE-SELECTABLE mono=\(mono)pt proportional=\(proportional)pt")
        XCTAssertGreaterThan(mono, proportional,
                             "a monospaced face has to measure taller for the same text")
        XCTAssertFalse(
            TimelineLongText.isSelectable(text, style: .caption2, monospaced: true,
                                          size: .accessibility5),
            "a 20,000-character tool result at XXXL is the same blank page")
    }

    /// One unbroken token is the shape that character arithmetic gets wrong: 20,000
    /// characters with no space in them wrap to the same height as prose, and a rule
    /// counting words or lines would have said "one line, fine".
    func testAnUnbrokenTokenIsJudgedByItsHeightNotItsShape() {
        let blob = String(repeating: "A", count: 20_000)
        let height = TimelineLongText.measuredHeight(
            blob, uiFont: TimelineLongText.resolvedFont(style: .caption2, monospaced: true,
                                                        size: .accessibility5))
        print("PROBE-SELECTABLE blob=\(height)pt")
        XCTAssertGreaterThan(height, TimelineLongText.selectableHeight,
                             "a 20,000-character blob measured \(height)pt")
        XCTAssertFalse(TimelineLongText.isSelectable(blob, style: .caption2,
                                                     monospaced: true, size: .accessibility5))
    }

    /// SPLITTING MAY NOT LOSE OR REORDER A CHARACTER. The pieces are a drawing detail;
    /// joined back together they have to be the string the server sent, or the drawer is
    /// quietly editing the reasoning it exists to show.
    func testThePiecesJoinBackIntoTheOriginalText() {
        for text in [prose(20_000), prose(4_321),
                     String(repeating: "A", count: 20_000),
                     (1...400).map { "line \($0) of the log" }.joined(separator: "\n")] {
            let pieces = TimelineLongText.split(text, limit: 2_000)
            XCTAssertEqual(pieces.joined(), text,
                           "\(pieces.count) pieces did not join back into "
                               + "\(text.count) characters")
            XCTAssertFalse(pieces.contains(where: \.isEmpty), "no empty piece")
        }
    }

    /// EVERY PIECE IS SHORT ENOUGH TO PAINT, at the size that decided the split. This is
    /// the property the fix rests on: the plan measures once and divides, so a rounding
    /// error in that division would leave pieces over the ceiling and the page blank
    /// again.
    func testEveryPieceOfALongSectionFitsThePaintingCeiling() {
        for (style, mono) in [(UIFont.TextStyle.callout, false),
                              (UIFont.TextStyle.caption2, true)] {
            let plan = TimelineLongText.plan(prose(30_000), style: style,
                                             monospaced: mono, size: .accessibility5)
            XCTAssertGreaterThan(plan.pieces.count, 1, "this case has to split")
            XCTAssertFalse(plan.selectable, "…and cannot carry a selection overlay")
            let font = TimelineLongText.resolvedFont(style: style, monospaced: mono,
                                                     size: .accessibility5)
            let tallest = plan.pieces
                .map { TimelineLongText.measuredHeight($0, uiFont: font) }.max() ?? 0
            print("PROBE-SELECTABLE pieces=\(plan.pieces.count) tallest=\(tallest)pt "
                  + "ceiling=\(TimelineLongText.pieceHeight)pt style=\(style.rawValue)")
            XCTAssertLessThanOrEqual(
                tallest, TimelineLongText.pieceHeight * 1.1,
                "the tallest of \(plan.pieces.count) pieces measured \(tallest)pt against "
                    + "a \(TimelineLongText.pieceHeight)pt ceiling")
        }
    }

    /// ORDINARY CONTENT IS DRAWN EXACTLY AS BEFORE: one piece, selectable. Both the
    /// live-server excerpts and a full render window at the default text size — the
    /// shapes that already painted — must not acquire a break they never had.
    func testOrdinaryContentIsStillOneSelectablePiece() {
        let cases: [(String, UIFont.TextStyle, Bool, DynamicTypeSize)] = [
            (prose(2_001), .callout, false, .accessibility5),
            (prose(700), .caption2, true, .accessibility5),
            (prose(TimelineDrawerSection.renderWindow), .callout, false, .large),
        ]
        for (text, style, mono, size) in cases {
            let plan = TimelineLongText.plan(text, style: style, monospaced: mono, size: size)
            XCTAssertEqual(plan.pieces, [text],
                           "\(text.count) characters at \(size) were split into "
                               + "\(plan.pieces.count) pieces")
            XCTAssertTrue(plan.selectable,
                          "\(text.count) characters at \(size) lost selection")
        }
    }

    /// The two spellings of the text size have to name the same thing, or the face the
    /// measurement resolves is not the face the sheet draws with.
    func testEveryDynamicTypeSizeMapsToItsOwnCategory() {
        var seen: Set<String> = []
        for size in DynamicTypeSize.allCases {
            let category = TimelineChipLayout.category(size)
            XCTAssertTrue(seen.insert(category.rawValue).inserted,
                          "\(size) shares a category with an earlier size")
            XCTAssertEqual(category.isAccessibilityCategory, size.isAccessibilitySize,
                           "\(size) and \(category.rawValue) disagree about being an "
                               + "accessibility size")
        }
        XCTAssertEqual(seen.count, DynamicTypeSize.allCases.count)
    }
}
