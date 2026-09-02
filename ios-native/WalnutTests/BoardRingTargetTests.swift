import XCTest
@testable import Walnut

/// The board row's leading column: the done ring's TAP AREA versus its DRAWN size.
///
/// The ring used to be tapped through its glyph box, 34x30 — under the platform's 44pt
/// minimum in both axes. That is worse here than on an ordinary control because the
/// ring's neighbour is not empty space: everything to its right opens the session. A
/// thumb that misses the ring does not do nothing, it goes somewhere else. And because
/// the box was top-aligned, on a two-line row the lower half of the ring's own column hit
/// nothing at all.
///
/// The fix had to cost NO pixels — the title, the hairline and the band headings all line
/// up on this column — so the target grew and the extra width was given back to the
/// layout. That is a relationship between four numbers, which is why they are constants
/// with a derived inset rather than one literal with a comment explaining the arithmetic.
final class BoardRingTargetTests: XCTestCase {

    func testTheTapTargetMeetsThePlatformMinimumWidth() {
        XCTAssertGreaterThanOrEqual(
            TaskBoardRow.ringTargetWidth, 44,
            "44pt is the documented minimum; the shipped ring was 34"
        )
    }

    func testTheTargetIsWiderThanTheGlyphItIsDrawnFrom() {
        XCTAssertGreaterThan(
            TaskBoardRow.ringTargetWidth, TaskBoardRow.ringGlyphSize.width,
            "if these are ever equal again the target has silently gone back to the glyph"
        )
    }

    func testGrowingTheTargetMovedNothing() {
        // 28pt is what the 34pt glyph box with -6 leading padding occupied before, and it
        // is what the whole column has to keep occupying: `separatorLeadingInset`, the
        // band headings' content inset and the title's leading edge are all this number.
        XCTAssertEqual(
            TaskBoardRow.ringLayoutWidth, 28, accuracy: 0.001,
            "the ring's LAYOUT width changed, so the title and the hairline moved with it"
        )
        XCTAssertEqual(
            TaskBoardRow.separatorLeadingInset, 39, accuracy: 0.001,
            "28pt of ring column + 11pt of HStack spacing"
        )
    }

    func testTheTwoTapTargetsDoNotTouch() {
        // The hit box reaches `ringTargetWidth - ringLeadingBleed` into the row; the text
        // column's own tap target (which opens the session) starts at the separator inset.
        // An overlap would make one of them unreachable in a strip, and which one wins is
        // a SwiftUI implementation detail rather than a decision anybody made.
        let ringTrailingEdge = TaskBoardRow.ringTargetWidth - TaskBoardRow.ringLeadingBleed
        XCTAssertLessThan(
            ringTrailingEdge, TaskBoardRow.separatorLeadingInset,
            "the ring's hit area runs into the session tap target"
        )
        XCTAssertGreaterThanOrEqual(
            TaskBoardRow.separatorLeadingInset - ringTrailingEdge, 1,
            "leave at least a point between two targets that do different things"
        )
    }

    func testTheGiveBackCannotExceedTheGapItRidesIn() {
        // The extra width is absorbed by the HStack's own spacing. Give back more than
        // that gap and the ring's hit box would be pulled UNDER the title's, which is the
        // overlap the row already shipped once (the retired accent capsule).
        XCTAssertLessThanOrEqual(
            TaskBoardRow.ringTrailingBleed, TaskBoardRow.rowSpacing,
            "the give-back is larger than the gap that has to absorb it"
        )
    }
}
