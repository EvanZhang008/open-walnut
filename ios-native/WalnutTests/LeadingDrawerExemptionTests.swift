import XCTest
@testable import Walnut

/// A drag a scroller inside the drawer is driving (the board's chip rail) is that
/// scroller's, never a close. The drawer reads the scrollers' phase, so the answer does
/// not depend on where a frame was measured or how far the drawer was out at the time.
final class LeadingDrawerExemptionTests: XCTestCase {

    @MainActor
    func testARailBeingScrolledHoldsTheDrawerOpen() {
        let model = LeadingDrawerModel()
        model.track(1)
        XCTAssertFalse(model.innerScrollActive, "nothing scrolls at rest")
        model.setInnerScroll("board.bandBar.inline", active: true)
        XCTAssertTrue(model.innerScrollActive)
    }

    @MainActor
    func testTheDrawerIsFreeAgainOnlyOnceEveryScrollerStopped() {
        let model = LeadingDrawerModel()
        model.track(1)
        model.setInnerScroll("board.bandBar.inline", active: true)
        model.setInnerScroll("board.viewBar", active: true)
        model.setInnerScroll("board.bandBar.inline", active: false)
        XCTAssertTrue(model.innerScrollActive, "the view bar still scrolls")
        model.setInnerScroll("board.viewBar", active: false)
        XCTAssertFalse(model.innerScrollActive)
    }

    @MainActor
    func testAStopForAScrollerThatNeverStartedChangesNothing() {
        let model = LeadingDrawerModel()
        model.setInnerScroll("board.viewBar", active: false)
        XCTAssertFalse(model.innerScrollActive)
    }

    // MARK: - The composer's room while the tab bar is away

    /// The Tasks tab reports the whole window once before its safe area is applied: that
    /// sample is no page with a tab bar, and the bar's room is still handed back.
    @MainActor
    func testTheWholeWindowSampleIsNoPageWithATabBar() {
        let seen = [CGFloat(874), 705]
        XCTAssertEqual(LeadingDrawerModel.tabBarCompensation(pageHeight: 754, heightsWithTabBar: seen), 49)
    }

    @MainActor
    func testAKeyboardShrunkSampleNeverSetsTheRoom() {
        let seen = [CGFloat(705), 369]
        XCTAssertEqual(LeadingDrawerModel.tabBarCompensation(pageHeight: 754, heightsWithTabBar: seen), 49)
        XCTAssertEqual(
            LeadingDrawerModel.tabBarCompensation(pageHeight: 418, heightsWithTabBar: [705]), 0,
            "the keyboard is up while the bar is away: nothing to hand back"
        )
        XCTAssertEqual(LeadingDrawerModel.tabBarCompensation(pageHeight: 754, heightsWithTabBar: []), 0)
    }

    @MainActor
    func testTheHeightsSeenWithTheBarStayFewAndDistinct() {
        var seen: [CGFloat] = []
        for h in [705, 705.2, 400, 705, 874] as [CGFloat] { seen = LeadingDrawerModel.remembering(h, in: seen) }
        XCTAssertEqual(seen, [400, 705, 874], "a repeat moves to the end, a sub-point twin is the same height")
        for h in 0..<20 { seen = LeadingDrawerModel.remembering(CGFloat(100 + h), in: seen) }
        XCTAssertEqual(seen.count, 8)
        XCTAssertEqual(seen.last, 119)
    }
}
