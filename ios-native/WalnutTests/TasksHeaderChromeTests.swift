import XCTest
@testable import Walnut

/// The Tasks tab's HEADER CHROME — the smart-list cards, quick add, and scope
/// picker that sit above the rows. Dogfood R19 measured the cost of treating
/// each of them as an `insetGrouped` section: on an iPhone 16 Pro (402x874pt)
/// the first task row started 591pt down, so 68% of the screen was chrome and
/// spacing on the tab whose whole job is showing tasks.
///
/// Geometry can't be asserted without a running app, so what's pinned here is
/// the ARITHMETIC the fix depends on plus the count formatting that shares the
/// same fixed-width card. The visual result is verified on the simulator (see
/// the round's screenshots) and by `TasksHeaderChromeUITests`.
final class TasksHeaderChromeTests: XCTestCase {

    /// Every card is a fixed 130pt box, so a long count has nowhere to grow.
    /// This is the width the view hard-codes; if it changes, the scale factor
    /// below needs re-deriving.
    private let cardWidth: CGFloat = 130
    private let cardHorizontalPadding: CGFloat = 12

    // MARK: - Card count formatting

    func testFourDigitCountIsGroupedNotRaw() {
        // 2824 open tasks is the real store's number. Raw interpolation gives
        // "2824"; the card shows a grouped, locale-aware count.
        XCTAssertEqual(2824.formatted(.number), format(2824))
        XCTAssertNotEqual("2824", format(2824), "the card must group thousands")
    }

    func testGroupedCountStaysOnOneLineWithinTheCard() {
        // The bug: `Text` wrapped "2,824" BETWEEN DIGITS ("2,82" / "4") because
        // the grouped string is wider than the card's content box. The fix pairs
        // lineLimit(1) with minimumScaleFactor(0.6); this asserts 0.6 is enough
        // headroom for the widest count the app can show.
        let content = cardWidth - cardHorizontalPadding * 2   // 106pt
        // .title is 28pt; monospaced digits are ~0.6em wide, separators ~0.28em.
        let digitWidth = 28.0 * 0.6
        let separatorWidth = 28.0 * 0.28
        for count in [0, 9, 15, 207, 500, 2824, 99_999] {
            let s = format(count)
            let digits = s.filter(\.isNumber).count
            let separators = s.count - digits
            let natural = Double(digits) * digitWidth + Double(separators) * separatorWidth
            let scaled = natural * 0.6
            XCTAssertLessThanOrEqual(
                scaled, Double(content),
                "count \(s) still overflows the card at the 0.6 floor"
            )
        }
    }

    func testCountFormattingNeverProducesANewline() {
        // Whatever the locale does with grouping, the string itself must be one
        // line — a newline here would defeat lineLimit(1) by splitting earlier.
        for count in [0, 1, 1000, 2824, 1_234_567] {
            XCTAssertFalse(format(count).contains("\n"), "\(count) formatted with a newline")
        }
    }

    // MARK: - The spacing budget the fix buys back

    /// The four chrome sections the Tasks list stacks before its first row.
    /// `insetGrouped`'s default inter-section gap is what the fix collapses.
    func testCollapsingChromeSectionSpacingBuysBackMoreThanARow() {
        let measuredDefaultGaps = [61.0, 87.0, 59.0, 70.0]   // dogfood R19, hierarchy dump
        let tightGap = 2.0
        let before = measuredDefaultGaps.reduce(0, +)
        let after = Double(measuredDefaultGaps.count) * tightGap
        let reclaimed = before - after
        XCTAssertEqual(before, 277, accuracy: 0.5, "the measured baseline this fix targets")
        XCTAssertGreaterThan(
            reclaimed, 93,
            "must reclaim at least one task row (a two-line row measured 93pt)"
        )
        // And the rows must still be the majority use of the screen afterwards.
        let screenHeight = 874.0
        let firstRowBefore = 591.0
        let firstRowAfter = firstRowBefore - reclaimed
        XCTAssertLessThan(firstRowAfter / screenHeight, 0.6, "first row should sit above 60% down")
    }

    /// A section gap of ZERO would weld the cards to the quick-add row; the
    /// point is a tight toolbar, not a seamless one.
    func testChromeGapIsTightButNotZero() {
        let chromeGap = 2.0
        XCTAssertGreaterThan(chromeGap, 0)
        XCTAssertLessThan(chromeGap, 8, "anything bigger reads as a settings group again")
    }

    private func format(_ count: Int) -> String { count.formatted(.number) }
}

/// The scroll-away rule (`TasksChromeMetrics`). Collapsing the section gaps was
/// compression; this is the behavior that actually gives the screen back — the
/// chrome rides the content off the top, and a compact bar keeps its two actions
/// (switch filter, add a task) reachable so the collapse is not a one-way door.
///
/// Only the ARITHMETIC is asserted here. Whether SwiftUI draws the overlay is the
/// simulator's job, not a unit test's.
final class TasksChromeCollapseTests: XCTestCase {

    // MARK: - Chrome height per filter

    func testSessionsFilterCarriesTheTallestChrome() {
        // Sessions is the DEFAULT filter and the only one with a scope picker, so
        // it is the worst case the thresholds have to cover.
        let sessions = TasksChromeMetrics.chromeHeight(filter: .sessions, offline: false)
        for other in TaskFilter.allCases where other != .sessions {
            XCTAssertGreaterThan(
                sessions, TasksChromeMetrics.chromeHeight(filter: other, offline: false),
                "\(other) should not carry more chrome than Sessions"
            )
        }
    }

    func testOfflineBannerCountsTowardsTheChrome() {
        // The banner is another scrollable row; if it didn't count, the bar would
        // appear a banner-height too early while offline.
        for filter in TaskFilter.allCases {
            XCTAssertEqual(
                TasksChromeMetrics.chromeHeight(filter: filter, offline: true)
                    - TasksChromeMetrics.chromeHeight(filter: filter, offline: false),
                TasksChromeMetrics.offlineBanner + TasksChromeMetrics.sectionGap,
                accuracy: 0.01
            )
        }
    }

    // MARK: - The collapse rule

    func testAtRestTheChromeIsNeverCollapsed() {
        // The whole point is that the full header is there when you arrive. A
        // rubber-band bounce past the top (negative offset) counts as "at rest".
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                for scrolled in [CGFloat(-140), -40, 0, 1] {
                    XCTAssertFalse(
                        TasksChromeMetrics.isCollapsed(
                            scrolled: scrolled, wasCollapsed: false,
                            filter: filter, offline: offline),
                        "\(filter) offline=\(offline) collapsed at scrolled=\(scrolled)"
                    )
                }
            }
        }
    }

    func testScrollingPastTheChromeCollapsesIt() {
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                let chrome = TasksChromeMetrics.chromeHeight(filter: filter, offline: offline)
                XCTAssertTrue(
                    TasksChromeMetrics.isCollapsed(
                        scrolled: chrome + 1, wasCollapsed: false,
                        filter: filter, offline: offline),
                    "\(filter) offline=\(offline) still expanded after the chrome cleared"
                )
            }
        }
    }

    func testTheBarArrivesBeforeTheChromeFullyClears() {
        // Otherwise the actions blink out for the length of `collapseLead` and the
        // user sees a bare list with no way to switch filters.
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                let chrome = TasksChromeMetrics.chromeHeight(filter: filter, offline: offline)
                let threshold = TasksChromeMetrics.collapseThreshold(filter: filter, offline: offline)
                XCTAssertLessThan(threshold, chrome, "\(filter) collapses only after a gap")
                XCTAssertEqual(
                    chrome - threshold, TasksChromeMetrics.collapseLead, accuracy: 0.01,
                    "\(filter) should lead the clear by exactly collapseLead"
                )
            }
        }
    }

    func testScrollingBackToTheTopRestoresTheFullHeader() {
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                XCTAssertFalse(
                    TasksChromeMetrics.isCollapsed(
                        scrolled: 0, wasCollapsed: true, filter: filter, offline: offline),
                    "\(filter) offline=\(offline) kept the bar at the top of the list"
                )
            }
        }
    }

    // MARK: - Hysteresis (the flicker guard)

    func testHysteresisBandIsWiderThanATaskRow() {
        // A two-line task row measured 92pt (dogfood R19). With a band narrower
        // than one row, momentum settling by one row could strobe the bar.
        XCTAssertGreaterThan(TasksChromeMetrics.hysteresisBand, 92)
    }

    func testTheBandIsAsymmetric() {
        for filter in TaskFilter.allCases {
            let collapse = TasksChromeMetrics.collapseThreshold(filter: filter, offline: false)
            let expand = TasksChromeMetrics.expandThreshold(filter: filter, offline: false)
            XCTAssertLessThan(expand, collapse, "\(filter) has no dead band")
            XCTAssertEqual(
                collapse - expand, TasksChromeMetrics.hysteresisBand, accuracy: 0.01,
                "\(filter)'s dead band should be exactly hysteresisBand wide"
            )
        }
    }

    func testInsideTheBandTheStateIsSticky() {
        // The definition of no flicker: within the dead band, whatever state we
        // were in is the state we stay in.
        for filter in TaskFilter.allCases {
            let collapse = TasksChromeMetrics.collapseThreshold(filter: filter, offline: false)
            let expand = TasksChromeMetrics.expandThreshold(filter: filter, offline: false)
            let mid = (collapse + expand) / 2
            for scrolled in [expand + 1, mid, collapse - 1] {
                XCTAssertTrue(
                    TasksChromeMetrics.isCollapsed(
                        scrolled: scrolled, wasCollapsed: true, filter: filter, offline: false),
                    "\(filter) expanded inside the band at \(scrolled)"
                )
                XCTAssertFalse(
                    TasksChromeMetrics.isCollapsed(
                        scrolled: scrolled, wasCollapsed: false, filter: filter, offline: false),
                    "\(filter) collapsed inside the band at \(scrolled)"
                )
            }
        }
    }

    func testASlowDragNeverStrobesTheBar() {
        // Walk the whole travel one point at a time, then back, and count the
        // transitions. A monotone drag must produce exactly ONE each way.
        let filter = TaskFilter.sessions
        let top = Int(TasksChromeMetrics.chromeHeight(filter: filter, offline: false)) + 200
        var collapsed = false
        var flips = 0
        for y in 0...top {
            let next = TasksChromeMetrics.isCollapsed(
                scrolled: CGFloat(y), wasCollapsed: collapsed, filter: filter, offline: false)
            if next != collapsed { flips += 1; collapsed = next }
        }
        XCTAssertEqual(flips, 1, "scrolling down should collapse exactly once")
        for y in stride(from: top, through: 0, by: -1) {
            let next = TasksChromeMetrics.isCollapsed(
                scrolled: CGFloat(y), wasCollapsed: collapsed, filter: filter, offline: false)
            if next != collapsed { flips += 1; collapsed = next }
        }
        XCTAssertEqual(flips, 2, "scrolling back up should expand exactly once")
        XCTAssertFalse(collapsed, "back at the top the full header is showing")
    }

    // MARK: - What the bar costs

    func testTheCompactBarIsCheaperThanTheChromeItReplaces() {
        // If the survivor were as tall as the header, the collapse would buy
        // nothing. Budget: under a third of the smallest chrome it stands in for.
        let smallest = TaskFilter.allCases
            .map { TasksChromeMetrics.chromeHeight(filter: $0, offline: false) }
            .min()!
        XCTAssertLessThan(TasksChromeMetrics.compactBarHeight, smallest / 3)
    }

    func testCollapsedStateGivesRowsTheMajorityOfTheScreen() {
        // The user's actual complaint, as arithmetic. iPhone 16 Pro: 874pt tall,
        // tab bar top at 791pt, and after the collapse only the inline nav bar
        // (~54pt incl. the status bar) plus the compact bar sit above the rows.
        let screen = 874.0
        let tabBarTop = 791.0
        let inlineNavBar = 54.0
        let firstRow = inlineNavBar + Double(TasksChromeMetrics.compactBarHeight)
        XCTAssertLessThan(firstRow / screen, 0.15, "chrome should be under 15% after the collapse")
        // Baseline measured at HEAD (commit 9932bb2c): the first row sat at 476pt
        // and never moved no matter how far you scrolled.
        XCTAssertLessThan(firstRow, 476.0 / 2, "must at least halve the measured 476pt baseline")
        // Two shares, because they answer different questions. Of the area a list
        // can actually use (above the tab bar, which is not ours to reclaim) the
        // rows should get the overwhelming majority; of the whole panel they still
        // get more than three quarters.
        XCTAssertGreaterThan((tabBarTop - firstRow) / tabBarTop, 0.85, "rows should get 85%+ of the usable area")
        XCTAssertGreaterThan((tabBarTop - firstRow) / screen, 0.75, "rows should get 75%+ of the whole screen")
    }
}

/// `ChromeCollapseTracker` — the gate between the geometry stream and the one
/// `@State` write a crossing needs. Its whole reason to exist is that publishing
/// from inside `onScrollGeometryChange`'s action re-invalidates the subtree being
/// measured (the P0-2 non-convergent-layout bug documented in
/// `ScrollBottomTracking`), so the contract under test is the amplification bound:
/// N crossings produce at most N publishes, and a stream that crosses nothing
/// publishes nothing.
@MainActor
final class ChromeCollapseTrackerTests: XCTestCase {

    /// The tracker hops its publish to the next runloop on purpose. Drain it.
    /// Yields only — a sleep per sample would put the fine-grained drag test into
    /// tens of seconds without testing anything the yields don't.
    private func drain() async {
        for _ in 0..<4 { await Task.yield() }
    }

    func testASteadyStreamThatCrossesNothingPublishesNothing() async {
        let tracker = ChromeCollapseTracker()
        var applied: [Bool] = []
        for _ in 0..<300 {
            tracker.request(false, current: false) { applied.append($0) }
        }
        await drain()
        XCTAssertEqual(tracker.samples, 300)
        XCTAssertEqual(tracker.publishes, 0)
        XCTAssertTrue(applied.isEmpty, "no crossing should reach the view graph")
    }

    func testOneCrossingPublishesExactlyOnce() async {
        let tracker = ChromeCollapseTracker()
        var applied: [Bool] = []
        // A real flick delivers many samples on the far side of the threshold.
        for _ in 0..<50 {
            tracker.request(true, current: false) { applied.append($0) }
        }
        await drain()
        XCTAssertEqual(tracker.publishes, 1, "50 samples past one threshold = one publish")
        XCTAssertEqual(applied, [true])
    }

    func testABounceThatRecrossesBeforeTheHopPublishesNothing() async {
        // Rubber-band: the value goes over the line and comes straight back within
        // the same layout pass. Publishing the intermediate state would flash the
        // bar for one frame.
        let tracker = ChromeCollapseTracker()
        var applied: [Bool] = []
        tracker.request(true, current: false) { applied.append($0) }
        tracker.request(false, current: false) { applied.append($0) }
        await drain()
        XCTAssertEqual(tracker.publishes, 0)
        XCTAssertTrue(applied.isEmpty, "a bounce that settles back must not publish")
    }

    func testNCrossingsProduceAtMostNPublishes() async {
        // The amplification bound, stated as the test that would catch a
        // regression to a per-sample write.
        let tracker = ChromeCollapseTracker()
        var applied: [Bool] = []
        var current = false
        for _ in 0..<6 {
            let want = !current
            // Each crossing arrives as a burst of samples, as a real drag does.
            for _ in 0..<25 { tracker.request(want, current: current) { applied.append($0) } }
            await drain()
            current = want
        }
        XCTAssertEqual(tracker.samples, 150)
        XCTAssertLessThanOrEqual(tracker.publishes, 6)
        XCTAssertEqual(applied, [true, false, true, false, true, false])
    }

    func testTheLastValueWinsWhenCrossingsArriveFasterThanTheHop() async {
        // Two crossings inside one layout pass: the queued publish is REPLACED,
        // never stacked, so the view lands on the latest truth.
        let tracker = ChromeCollapseTracker()
        var applied: [Bool] = []
        tracker.request(true, current: false) { applied.append($0) }
        tracker.request(false, current: false) { applied.append($0) }
        tracker.request(true, current: false) { applied.append($0) }
        await drain()
        XCTAssertEqual(tracker.publishes, 1)
        XCTAssertEqual(applied, [true])
    }

    /// End-to-end over the REAL threshold arithmetic: a drag down past the chrome
    /// and back up publishes exactly twice, whatever the sample rate.
    func testARealDragDownAndBackPublishesTwice() async {
        let tracker = ChromeCollapseTracker()
        var collapsed = false
        var applied: [Bool] = []
        let filter = TaskFilter.sessions
        let travel = Int(TasksChromeMetrics.chromeHeight(filter: filter, offline: false)) + 200

        func feed(_ y: CGFloat) {
            let want = TasksChromeMetrics.isCollapsed(
                scrolled: y, wasCollapsed: collapsed, filter: filter, offline: false)
            tracker.request(want, current: collapsed) { v in
                applied.append(v); collapsed = v
            }
        }
        // Down in 2pt steps (a fine-grained real drag), draining between so the
        // state machine sees the published value the way the view would.
        for y in stride(from: 0, through: travel, by: 2) { feed(CGFloat(y)); await drain() }
        XCTAssertTrue(collapsed, "should be collapsed at the bottom of the travel")
        for y in stride(from: travel, through: 0, by: -2) { feed(CGFloat(y)); await drain() }
        XCTAssertFalse(collapsed, "should be expanded back at the top")

        XCTAssertEqual(tracker.publishes, 2, "one collapse + one expand, regardless of sample count")
        XCTAssertEqual(applied, [true, false])
        XCTAssertGreaterThan(tracker.samples, 300, "the drag really was fine-grained")
    }
}
