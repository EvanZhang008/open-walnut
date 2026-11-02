import XCTest
@testable import Walnut

/// `AppearanceSettle`: a disappear SwiftUI takes straight back with an appear does
/// no work, and one that stands still runs (2026-11-02: the Chat composer's appear
/// and disappear churned about 100 times a second, each edge's work feeding it).
@MainActor
final class AppearanceSettleTests: XCTestCase {

    private func wait() async {
        try? await Task.sleep(for: AppearanceSettle.settle * 3)
    }

    func testADisappearTakenBackDoesNoWork() async {
        let settle = AppearanceSettle()
        var ran = 0
        for _ in 0..<20 {
            settle.disappeared { ran += 1 }
            XCTAssertTrue(settle.appeared(), "the appear took the disappear back")
        }
        await wait()
        XCTAssertEqual(ran, 0)
    }

    func testADisappearThatStandsRunsOnce() async {
        let settle = AppearanceSettle()
        var ran = 0
        settle.disappeared { ran += 1 }
        settle.disappeared { ran += 1 }
        await wait()
        XCTAssertEqual(ran, 1, "a second disappear replaces the first")
        XCTAssertFalse(settle.appeared(), "nothing left to take back")
    }

    /// A covered or uncovered composer acts at once; nothing stale runs later.
    func testCancelDropsThePendingWork() async {
        let settle = AppearanceSettle()
        var ran = 0
        settle.disappeared { ran += 1 }
        settle.cancel()
        await wait()
        XCTAssertEqual(ran, 0)
    }

    /// The app leaving the foreground runs a disappear on its way at once, once.
    func testFlushRunsThePendingWorkNow() async {
        let settle = AppearanceSettle()
        var ran = 0
        settle.disappeared { ran += 1 }
        settle.flush()
        XCTAssertEqual(ran, 1)
        settle.flush()
        await wait()
        XCTAssertEqual(ran, 1, "flushed work never runs again")
    }

    /// A view that really went away still runs its disappear: the work holds the box.
    func testTheWorkRunsAfterTheViewIsGone() async {
        var ran = 0
        do {
            let settle = AppearanceSettle()
            settle.disappeared { ran += 1 }
        }
        await wait()
        XCTAssertEqual(ran, 1)
    }
}
