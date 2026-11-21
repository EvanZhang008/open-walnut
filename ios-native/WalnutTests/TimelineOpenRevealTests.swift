import XCTest
@testable import Walnut

/// A fold line opened at the bottom edge shows what it opened (2026-11-21 iOS gate:
/// the lone "> Thinking" line opened into a row below the screen, and at accessibility
/// sizes it never came into view).
final class TimelineOpenRevealTests: XCTestCase {
    func testOpenedRowsAreTheNewRunRightAfterTheTappedRow() {
        XCTAssertEqual(TimelineOpenReveal.openedCount(rowID: "line", old: ["a", "line", "b"],
                                                      new: ["a", "line", "chip", "b"]), 1)
        XCTAssertEqual(TimelineOpenReveal.openedCount(rowID: "line", old: ["a", "line", "b"],
                                                      new: ["a", "line", "x", "y", "b"]), 2)
        XCTAssertEqual(TimelineOpenReveal.openedCount(rowID: "line", old: ["a", "line", "chip"],
                                                      new: ["a", "line"]), 0, "closing opens nothing")
        XCTAssertEqual(TimelineOpenReveal.openedCount(rowID: "gone", old: ["a"], new: ["a", "b"]), 0)
    }

    func testABlockThatFitsDoesNotMove() {
        XCTAssertEqual(TimelineOpenReveal.offset(current: 100, viewportHeight: 800, topInset: 50, bottomInset: 80,
                                                 blockMinY: 500, blockMaxY: 780, maxOffset: 2000), 100)
    }

    func testABlockPastTheBottomEdgeScrollsUpByItsOverflow() {
        // Visible bottom: 100 + 800 - 80 = 820; the block ends at 870: 50 more.
        XCTAssertEqual(TimelineOpenReveal.offset(current: 100, viewportHeight: 800, topInset: 50, bottomInset: 80,
                                                 blockMinY: 790, blockMaxY: 870, maxOffset: 2000), 150)
    }

    func testTheTappedLineNeverLeavesTheTop() {
        // A block taller than the screen: the line stops at the top edge (150 + 50 = 200).
        XCTAssertEqual(TimelineOpenReveal.offset(current: 0, viewportHeight: 800, topInset: 50, bottomInset: 80,
                                                 blockMinY: 200, blockMaxY: 3000, maxOffset: 5000), 150)
    }

    func testNeverPastTheEndOfTheContent() {
        XCTAssertEqual(TimelineOpenReveal.offset(current: 100, viewportHeight: 800, topInset: 50, bottomInset: 80,
                                                 blockMinY: 790, blockMaxY: 870, maxOffset: 120), 120)
    }
}
