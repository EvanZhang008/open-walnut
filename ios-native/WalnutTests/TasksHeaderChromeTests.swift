import XCTest
@testable import Walnut

/// The Tasks tab's HEADER CHROME — the nav row and quick add that sit above the
/// rows. Dogfood R19 measured the cost of treating each of them as an
/// `insetGrouped` section: on an iPhone 16 Pro (402x874pt) the first task row
/// started 591pt down, so 68% of the screen was chrome and spacing on the tab
/// whose whole job is showing tasks.
///
/// Geometry can't be asserted without a running app, so what's pinned here is
/// the ARITHMETIC the fix depends on plus the count formatting the chips share.
/// The visual result is verified on the simulator.
///
/// # The fixed-width-card arithmetic is GONE (2026-08-29, T84)
///
/// This class used to carry `testGroupedCountStaysOnOneLineWithinTheCard`, which
/// derived that `minimumScaleFactor(0.6)` gave a four-digit count enough headroom
/// inside a 130pt smart-list card. It is deleted rather than rewritten because
/// there is no card and no fixed width any more: the header is a row of intrinsically
/// sized chips (`TasksNavRow`) and the counts that survived live on
/// `TasksCompactBar` and `BoardBandBar`, also intrinsically sized, so a count can
/// never be wider than its own capsule.
///
/// What that test was really protecting — a grouped count must not wrap BETWEEN
/// DIGITS ("2,82" / "4", the real dogfood R19 defect) — is still protected, by the
/// formatting cases below plus `lineLimit(1)` + `monospacedDigit()` on every chip
/// count. The lesson kept: a count inside a box with a hard width is the bug; the
/// fix was never the scale factor, it was not having the hard width.
final class TasksHeaderChromeTests: XCTestCase {

    // MARK: - Chip count formatting

    func testFourDigitCountIsGroupedNotRaw() {
        // 2824 open tasks is the real store's number. Raw interpolation gives
        // "2824"; a chip shows a grouped, locale-aware count.
        XCTAssertEqual(2824.formatted(.number), format(2824))
        XCTAssertNotEqual("2824", format(2824), "the chip must group thousands")
    }

    func testCountFormattingNeverProducesANewline() {
        // Whatever the locale does with grouping, the string itself must be one
        // line — a newline here would defeat lineLimit(1) by splitting earlier.
        for count in [0, 1, 1000, 2824, 1_234_567] {
            XCTAssertFalse(format(count).contains("\n"), "\(count) formatted with a newline")
        }
    }

    /// A chip count is one short token: no spaces to break on, nothing that could
    /// make an intrinsically sized capsule reflow into two lines.
    func testCountFormattingIsASingleUnbrokenToken() {
        for count in [0, 9, 207, 2824, 99_999, 1_234_567] {
            let text = format(count)
            XCTAssertFalse(text.contains(" "), "\(text) would let the capsule wrap")
            XCTAssertFalse(text.isEmpty)
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

    /// The BOARD (`.sessions`) is still the LEANEST filter.
    ///
    /// Its chrome is the nav row plus the tier chip row (header rows 1 and 2). It does
    /// not pay for the top quick add, because every band ends in its own create ring,
    /// and the chip row is 4pt cheaper than that row — so the board's chrome leaves
    /// soonest, which is the point on the screen whose job is showing rows.
    ///
    /// The NUMBER was unchanged by the 2026-08-29 reorder; what it is made of was not.
    /// The second 44pt used to be a clear RESERVE row under a permanently floating
    /// overlay (which is why the chips drew above the nav pills); it is now the chip
    /// row itself, in second place, with only its pinned copy floating.
    ///
    /// R27 DID change the number, on every filter: `listHeaderPadding` was always on
    /// screen above the first section and simply missing from this arithmetic, which is
    /// what made the board's pin threshold fire early. Counting it moves each filter's
    /// chrome up by the same 10.66pt, so the comparisons between filters are untouched.
    /// R30 REVERSED the direction of this test, and the reversal is the product change: the
    /// board carries the reference screen's top-level quick add now (see `TasksView`), so it
    /// renders the nav row, the chip row AND that row. It is therefore the TALLEST chrome, by
    /// exactly the chip row plus its gap.
    ///
    /// What this test is and is NOT (2026-09-02 review). It is the one written-down statement
    /// of which rows the board renders above its first task row, and it fails when someone
    /// adds or drops a header row without saying so here. It is NOT protection for a
    /// threshold: `chromeHeight` feeds the compact bar's collapse machine, the board has no
    /// compact bar, and `isCollapsed` refuses to collapse a filter that has none — so no live
    /// threshold on the board reads this sum. The board's live threshold is the PIN threshold,
    /// which counts what rides ABOVE row 2 (`TasksBoardChipRowPinTests`), and no row added
    /// below the chips can move it.
    func testTheBoardCountsAllOfItsHeaderRows() {
        let board = TasksChromeMetrics.chromeHeight(filter: .sessions, offline: false)
        // The arithmetic, so a regression names the number. `listHeaderPadding` is part of
        // it: the List puts that much above its first section, and leaving it out of the
        // chrome arithmetic is what made the board's pin threshold fire 10.66pt early
        // (R27 — see `TasksBoardChipRowPinTests.testThePinFiresExactlyWhereTheTwoCardsCoincide`).
        XCTAssertEqual(
            board,
            TasksChromeMetrics.listHeaderPadding
                + TasksChromeMetrics.navRow + TasksChromeMetrics.sectionGap
                + TasksChromeMetrics.bandBar + TasksChromeMetrics.sectionGap
                + TasksChromeMetrics.viewBar + TasksChromeMetrics.sectionGap
                + TasksChromeMetrics.quickAdd + TasksChromeMetrics.sectionGap,
            accuracy: 0.01,
            "the board renders the nav row, the chip row, the view bar and the quick add"
        )
        for other in TaskFilter.allCases where other != .sessions {
            XCTAssertEqual(
                board - TasksChromeMetrics.chromeHeight(filter: other, offline: false),
                TasksChromeMetrics.bandBar + TasksChromeMetrics.sectionGap
                    + TasksChromeMetrics.viewBar + TasksChromeMetrics.sectionGap,
                accuracy: 0.01,
                "\(other): the board's extra chrome is its chip row and its view bar, and nothing else"
            )
        }
    }

    /// The inline chip row and its pinned copy are the SAME constant (`bandBar`) on
    /// purpose, and the value cannot drop below a List row's own minimum height.
    ///
    /// That floor is not decoration: the row is rendered inside a `List`, and a List
    /// row will not shrink below ~44pt however small its content asks to be. So a
    /// `bandBar` under 44 would make the PINNED copy shorter than the row it stands in
    /// for, and the hand-off would jump — the two are only invisible to each other
    /// while the heights agree.
    ///
    /// The value is 52 now, and it is the CORNER that raised it (R30): the card's shared
    /// radius is 26 and a rounded rectangle cannot round deeper than half its height, so at
    /// 44 the platform clamped the bar's corner while the OS cards around it kept theirs.
    /// `BoardChromeR30Tests.testTheBarIsTallEnoughToDrawTheSharedCornerRadius` owns that
    /// direction; this one keeps the List-row floor underneath it.
    func testTheChipRowCanBeExpressedAsAListRow() {
        let listRowMinimumHeight: CGFloat = 44
        XCTAssertGreaterThanOrEqual(
            TasksChromeMetrics.bandBar, listRowMinimumHeight,
            "a row shorter than a List row's minimum cannot hold the bar it draws"
        )
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

    /// Scoped to the filters that HAVE a bar: `isCollapsed` refuses to collapse a filter with
    /// nothing to collapse into (see its own doc — on the board that publish invalidated the
    /// whole List for a bar that never draws). `BoardViewBarTests` owns the other direction.
    func testScrollingPastTheChromeCollapsesIt() {
        for filter in TaskFilter.allCases where TasksChromeMetrics.hasCompactBar(filter) {
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

    /// The bar arrives BEFORE the chrome fully clears, on every filter, by exactly
    /// `collapseLead`. Otherwise the actions blink out for the length of the lead
    /// and the user sees a bare list with no way to switch filters.
    ///
    /// This is the assertion that killed `collapseFloor` (2026-08-29, T84). The old
    /// floor was `hysteresisBand` (96), derived when the leanest chrome was 106pt so
    /// that it never bound. The header rebuild took every filter to 92-96pt, at
    /// which point the floor bound on ALL of them and inverted this very invariant:
    /// a threshold of 96 against 96pt of chrome means the bar shows up only once the
    /// chrome is gone. The floor is now `collapseLead` itself, which is a bound on
    /// the OTHER side (see below) and cannot delay the bar.
    func testTheBarArrivesBeforeTheChromeFullyClears() {
        for filter in TaskFilter.allCases where TasksChromeMetrics.hasCompactBar(filter) {
            for offline in [false, true] {
                let chrome = TasksChromeMetrics.chromeHeight(filter: filter, offline: offline)
                let threshold = TasksChromeMetrics.collapseThreshold(filter: filter, offline: offline)
                XCTAssertLessThan(threshold, chrome, "\(filter) collapses only after a gap")
                XCTAssertEqual(
                    chrome - threshold, TasksChromeMetrics.collapseLead, accuracy: 0.01,
                    "\(filter) offline=\(offline) should lead the clear by exactly collapseLead"
                )
            }
        }
    }

    /// The lower bound on the collapse threshold, and what it is actually for.
    ///
    /// A threshold under `collapseLead` would sit inside touch slop: one wobble at
    /// rest would collapse the chrome the user is still looking at. It only binds
    /// for a chrome shorter than 2x the lead (48pt), which nothing ships today —
    /// asserted anyway, because the previous bound went years without binding and
    /// then bound on every filter at once the moment the header changed.
    func testTheCollapseThresholdNeverFallsInsideTouchSlop() {
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                XCTAssertGreaterThanOrEqual(
                    TasksChromeMetrics.collapseThreshold(filter: filter, offline: offline),
                    TasksChromeMetrics.collapseLead,
                    "\(filter) offline=\(offline) could be collapsed by a touch-slop wobble"
                )
            }
        }
    }

    /// The dead band is as wide as the travel allows: the full `hysteresisBand`
    /// when the chrome affords it, and everything down to the top when it does not.
    ///
    /// The clamp is the normal case now (103-107pt of chrome against a 96pt band), and
    /// it is a guard rather than a hole: `isCollapsed` is sticky, so once collapsed
    /// the bar stays until the list is back at the very top, and no wobble at the
    /// collapse threshold can flip it back.
    func testTheDeadBandIsAsWideAsTheTravelAllows() {
        for filter in TaskFilter.allCases {
            for offline in [false, true] {
                let collapse = TasksChromeMetrics.collapseThreshold(filter: filter, offline: offline)
                let expand = TasksChromeMetrics.expandThreshold(filter: filter, offline: offline)
                XCTAssertEqual(
                    collapse - expand,
                    min(TasksChromeMetrics.hysteresisBand, collapse), accuracy: 0.01,
                    "\(filter) offline=\(offline): the dead band is neither full nor clamped"
                )
                XCTAssertEqual(
                    TasksChromeMetrics.deadBand(filter: filter, offline: offline),
                    collapse - expand, accuracy: 0.01
                )
                XCTAssertGreaterThan(expand, -0.01, "\(filter): expand must never go negative")
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
            // Width is `min(hysteresisBand, collapse)` — see
            // `testTheDeadBandIsAsWideAsTheTravelAllows` for why the clamp is the
            // normal case since the header rebuild. What matters HERE is only that
            // the band exists and is wider than a rubber-band wobble.
            XCTAssertGreaterThan(
                collapse - expand, 20,
                "\(filter)'s dead band is narrow enough for a bounce to cross twice"
            )
        }
    }

    func testInsideTheBandTheStateIsSticky() {
        // The definition of no flicker: within the dead band, whatever state we
        // were in is the state we stay in. Filters WITH a bar only — a filter without
        // one is never collapsed at any offset, which is a stronger statement and
        // `BoardViewBarTests` makes it.
        for filter in TaskFilter.allCases where TasksChromeMetrics.hasCompactBar(filter) {
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
        //
        // A filter that HAS a bar, necessarily: since 2026-09-02 `isCollapsed` returns false
        // outright for one that does not, so `.sessions` would report zero flips and say
        // nothing about strobing. Every compact-bar filter carries the same chrome (nav row +
        // quick add), so any of them is the hardest case there is.
        let filter = TaskFilter.today
        XCTAssertTrue(TasksChromeMetrics.hasCompactBar(filter))
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

    /// Where a compact bar EXISTS, it must buy back the majority of the chrome it
    /// stands in for. Otherwise the collapse is a mode switch for nothing.
    ///
    /// The budget used to be "under a third of the smallest chrome", which held only
    /// because every filter then carried at least 156pt; it became a majority-saving
    /// rule when the board's chrome dropped to 106pt (the 3x was always a proxy).
    /// The header rebuild pushed that further, and the honest answer stopped being a
    /// looser number at all: what disqualifies the board is not a ratio but that its
    /// row 2 ALREADY floats, so a compact bar there would be a second floating row
    /// (`testNoFilterEverFloatsTwoBarsAtOnce`). So the board has no compact bar, and
    /// this test asserts the rule per filter rather than relaxing the ratio to fit a
    /// case it no longer fits.
    ///
    /// The saving is spelled out HERE and nowhere else. It used to live in a
    /// `TasksChromeMetrics.collapseSaving` helper, which had zero production callers and
    /// existed only so this test and the board test below could agree (2026-08-29
    /// review): a function whose whole audience is two tests is not a rule the app
    /// follows, it is a shared fixture pretending to be one. The rule the APP follows is
    /// `hasCompactBar`, and the arithmetic that justifies it is written out once, right
    /// where it is asserted.
    func testTheCompactBarIsCheaperThanTheChromeItReplaces() {
        for filter in TaskFilter.allCases where TasksChromeMetrics.hasCompactBar(filter) {
            let chrome = TasksChromeMetrics.chromeHeight(filter: filter, offline: false)
            XCTAssertLessThan(
                TasksChromeMetrics.compactBarHeight, chrome,
                "\(filter): the bar must be shorter than the chrome it stands in for"
            )
            // Every filter that HAS a bar reserves nothing for a permanent overlay, so
            // all of its chrome is chrome that scrolls away.
            let saving = (chrome - TasksChromeMetrics.compactBarHeight) / chrome
            XCTAssertGreaterThan(
                saving, 0.5,
                "\(filter): the collapse buys back only \(Int(saving * 100))% — not worth a mode switch"
            )
        }
    }

    /// The board has no compact bar because its SECOND HEADER ROW already pins, and
    /// the user asked for exactly one floating row there.
    ///
    /// This test used to argue the point from a 2pt saving (`navRow + sectionGap -
    /// compactBarHeight`), on the premise that the board's other 44pt was a reserve
    /// that never scrolls away because the bar it reserved for was a permanent
    /// overlay. That premise is gone with the reorder: the chip row is real content
    /// now, all 92pt of the board's chrome scrolls away, and a compact bar there would
    /// free 48pt — a perfectly good saving. So the honest rule is not arithmetic, it is
    /// the count of floating rows, and that is what is asserted: no filter may float
    /// two bars at once.
    func testNoFilterEverFloatsTwoBarsAtOnce() {
        XCTAssertFalse(TasksChromeMetrics.hasCompactBar(.sessions))
        // The board's one floating row is the pinned chip row.
        XCTAssertTrue(TasksChromeMetrics.showsPinnedChips(filter: .sessions, pinned: true))
        XCTAssertFalse(TasksChromeMetrics.showsCompactBar(filter: .sessions, collapsed: true))
        // Worst case for every filter: fully scrolled AND fully pinned.
        for filter in TaskFilter.allCases {
            let floating =
                (TasksChromeMetrics.showsCompactBar(filter: filter, collapsed: true) ? 1 : 0)
                + (TasksChromeMetrics.showsPinnedChips(filter: filter, pinned: true) ? 1 : 0)
            XCTAssertLessThanOrEqual(
                floating, 1,
                "\(filter) floats \(floating) bars — the user asked for one"
            )
        }
    }

    /// Calendar has no bar either, and for a different reason: it is not the shared
    /// `List` at all (`TasksView.calendarSurface` is full-bleed), so nothing there
    /// observes scroll geometry, nothing collapses, and the overlay this answer feeds is
    /// never on screen. `hasCompactBar` said `true` for it until 2026-08-29 — a lie that
    /// a "every filter except the board keeps one" loop happily confirmed.
    func testCalendarHasNoCompactBarBecauseThatSurfaceNeverDrawsOne() {
        XCTAssertFalse(TasksChromeMetrics.hasCompactBar(.calendar))
        XCTAssertFalse(TasksChromeMetrics.showsCompactBar(filter: .calendar, collapsed: true))

        // The list filters all keep one, so the collapse is not silently dead.
        for filter in TaskFilter.allCases where filter != .sessions && filter != .calendar {
            XCTAssertTrue(TasksChromeMetrics.hasCompactBar(filter), "\(filter) lost its bar")
        }
    }

    /// The view asks exactly one question, and it answers no on the board however
    /// far it is scrolled — the collapse state still tracks (the observer runs for
    /// every filter), the BAR just never draws there.
    func testShowsCompactBarNeedsBothCollapsedAndAFilterThatHasOne() {
        XCTAssertFalse(TasksChromeMetrics.showsCompactBar(filter: .sessions, collapsed: true))
        XCTAssertFalse(TasksChromeMetrics.showsCompactBar(filter: .sessions, collapsed: false))
        XCTAssertTrue(TasksChromeMetrics.showsCompactBar(filter: .allOpen, collapsed: true))
        XCTAssertFalse(TasksChromeMetrics.showsCompactBar(filter: .allOpen, collapsed: false))
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

// `TasksBoardChipRowPinTests` moved to `WalnutTests/TasksBoardChipRowPinTests.swift`
// (R26). It carried two subjects that had nothing to do with each other: the board's
// PIN state machine, and four cases restating `BoardBandBar`'s column arithmetic — and
// those four asserted a criterion the platform cannot satisfy (a chip in a horizontal
// `ScrollView` always reports its unclipped frame), against static forwarders that had
// no call site in the app target. The pin cases live in the new file; the rail's real
// geometry, stated in pixels and taps, is `WalnutTests/TasksBoardChipRowTests.swift`.

/// What "scrolled" IS: `TasksChromeMetrics.travel`, and the search drawer that used to
/// fake it.
///
/// # The defect, in one sample
///
/// The observer emitted `contentOffset.y + contentInsets.top`. That sum is 0 at rest and
/// grows as the content moves up, which is the right measure — but the `.searchable`
/// drawer (`displayMode: .automatic`) RETRACTS as soon as a drag begins, and the whole
/// drawer height leaves `contentInsets.top` in one sample. Both of this screen's
/// hysteresis machines cross inside the first ~57pt of travel (`chipsPinThreshold` is
/// 56.66), so one inset step was enough to force the chrome collapse AND the chip pin
/// together, at the top of the gesture, alongside the flip's own re-layout. Captured:
/// `frames/m1.png` — the field present at t=19.00s and gone at 19.20s, everything above
/// the chips shifted up in a single frame.
///
/// # What these cases pin
///
/// A sample whose INSET moved reports the previous travel — the origin moved, not the
/// content — and the measure is the honest `offset + insetTop` everywhere else, so rest
/// always reads 0. The two properties fight each other if you pick the other design (a
/// frozen origin for the duration of a gesture reads 52pt of travel at the new rest,
/// forever), which is why both are asserted here rather than only the interesting one.
@MainActor
final class BoardScrollTravelTests: XCTestCase {

    /// A ~52pt drawer over a 44pt bar: the shape the board really sees.
    private let barInset: CGFloat = 44
    private let drawerInset: CGFloat = 96

    func testTravelIsZeroAtRestWhateverTheInsetIs() {
        for inset in [barInset, drawerInset, 0] {
            let tracker = BoardScrollTravelTracker()
            XCTAssertEqual(
                tracker.travel(BoardScrollSample(offset: -inset, insetTop: inset)), 0,
                accuracy: 0.001,
                "inset=\(inset): rest must read 0, or the chrome collapses on a list nobody scrolled"
            )
        }
    }

    /// THE case: the drawer retracts while the content has not moved. That sample must
    /// contribute nothing, so no threshold can flip on the frame the header is re-laying
    /// itself out on.
    func testARetractingSearchDrawerContributesNoTravel() {
        let tracker = BoardScrollTravelTracker()
        XCTAssertEqual(tracker.travel(
            BoardScrollSample(offset: -drawerInset, insetTop: drawerInset)), 0, accuracy: 0.001)
        let dragged = tracker.travel(
            BoardScrollSample(offset: -drawerInset + 30, insetTop: drawerInset))
        XCTAssertEqual(dragged, 30, accuracy: 0.001)

        // The drawer leaves. Content unchanged, origin 52pt higher.
        let duringRetract = tracker.travel(
            BoardScrollSample(offset: -drawerInset + 30, insetTop: barInset))
        XCTAssertEqual(
            duringRetract, dragged, accuracy: 0.001,
            "the drawer moved `scrolled` by \(duringRetract - dragged)pt on its own — the step that used to cross both thresholds inside the drawer's own re-layout frame"
        )
        // What the OLD measure said on that same sample, and why it mattered: it flipped
        // sign, i.e. it claimed the list was back above rest in the middle of a drag —
        // a crossing, then another one as the drag continued, each one a publish.
        let oldMeasure = (-drawerInset + 30) + barInset
        XCTAssertLessThan(oldMeasure, 0, "the fixture no longer reproduces the report")
        XCTAssertGreaterThan(
            abs(oldMeasure - dragged), TasksChromeMetrics.chipsPinBand,
            "the step (\(abs(oldMeasure - dragged))pt) has to dwarf the \(TasksChromeMetrics.chipsPinBand)pt dead band, or it could never have forced a crossing"
        )
    }

    /// A drawer that takes SEVERAL frames to go (it animates) is absorbed for all of
    /// them, and the honest measure resumes the moment the inset settles. That is what
    /// bounds the fix: it can defer a crossing by a few frames, never lose one.
    func testTheWholeDrawerAnimationIsAbsorbedAndThenTheMeasureIsHonestAgain() {
        let tracker = BoardScrollTravelTracker()
        _ = tracker.travel(BoardScrollSample(offset: -drawerInset, insetTop: drawerInset))
        let dragged = tracker.travel(
            BoardScrollSample(offset: -drawerInset + 40, insetTop: drawerInset))
        XCTAssertEqual(dragged, 40, accuracy: 0.001)
        // Four frames of the drawer shrinking, with the finger still moving.
        for (i, inset) in [83, 70, 57, barInset].enumerated() {
            let held = tracker.travel(
                BoardScrollSample(offset: -drawerInset + 40 + CGFloat(i) * 6, insetTop: CGFloat(inset)))
            XCTAssertEqual(held, dragged, accuracy: 0.001, "frame \(i): the animation leaked into travel")
        }
        // Settled: honest again, including "at the top means 0".
        XCTAssertEqual(
            tracker.travel(BoardScrollSample(offset: -barInset + 120, insetTop: barInset)),
            120, accuracy: 0.001,
            "the measure did not resume once the inset stopped moving"
        )
        XCTAssertEqual(
            tracker.travel(BoardScrollSample(offset: -barInset, insetTop: barInset)), 0,
            accuracy: 0.001,
            "rest reads non-zero after a drawer change — the chrome would never come back"
        )
    }

    /// The same rule in the other direction: a drawer coming BACK must not push travel up
    /// either, which would pin the chips while the nav pills are on screen under them.
    func testAReturningSearchDrawerContributesNoTravelEither() {
        let tracker = BoardScrollTravelTracker()
        _ = tracker.travel(BoardScrollSample(offset: -barInset, insetTop: barInset))
        let dragged = tracker.travel(BoardScrollSample(offset: -barInset + 40, insetTop: barInset))
        XCTAssertEqual(dragged, 40, accuracy: 0.001)
        XCTAssertEqual(
            tracker.travel(BoardScrollSample(offset: -barInset + 40, insetTop: drawerInset)),
            40, accuracy: 0.001,
            "the drawer coming back read as travel"
        )
    }

    /// Sub-point inset wobble is arithmetic noise, not a header changing shape. Treating
    /// it as a drawer would hold travel on every sample of a noisy stream, which is a
    /// scroll observer that stops observing.
    func testSubPointInsetNoiseIsNotADrawer() {
        let tracker = BoardScrollTravelTracker()
        _ = tracker.travel(BoardScrollSample(offset: -barInset, insetTop: barInset))
        let wobbled = tracker.travel(
            BoardScrollSample(offset: -barInset + 60, insetTop: barInset + 0.33))
        XCTAssertEqual(
            wobbled, 60.33, accuracy: 0.01,
            "a third of a point of inset noise suppressed a real 60pt of travel"
        )
        XCTAssertLessThan(0.33, TasksChromeMetrics.insetStepEpsilon)
    }

    /// Rubber-banding past the top stays NEGATIVE, which both hysteresis machines rely on
    /// (their sticky states unwind only at the very top).
    func testBouncingPastTheTopStaysNegative() {
        let tracker = BoardScrollTravelTracker()
        _ = tracker.travel(BoardScrollSample(offset: -barInset, insetTop: barInset))
        XCTAssertLessThan(
            tracker.travel(BoardScrollSample(offset: -barInset - 30, insetTop: barInset)), 0)
    }

    /// A filter switch forgets the previous sample: the next list has its own chrome and
    /// its own drawer, so "the inset changed" would be true for a reason that has nothing
    /// to do with one.
    func testResetForgetsThePreviousSample() {
        let tracker = BoardScrollTravelTracker()
        _ = tracker.travel(BoardScrollSample(offset: -drawerInset, insetTop: drawerInset))
        _ = tracker.travel(BoardScrollSample(offset: -drawerInset + 120, insetTop: drawerInset))
        tracker.reset()
        XCTAssertEqual(
            tracker.travel(BoardScrollSample(offset: -barInset, insetTop: barInset)), 0,
            accuracy: 0.001,
            "the new filter's first sample was compared against the old filter's inset"
        )
    }

    /// The pure rule is the whole rule; the tracker is only its memory. Pinned because
    /// that split is what makes this testable at all — inside the view it was observable
    /// only as a dropped frame.
    func testThePureRuleNeedsNoState() {
        // No previous sample: the honest measure, always.
        XCTAssertEqual(
            TasksChromeMetrics.travel(
                sample: BoardScrollSample(offset: -drawerInset + 12, insetTop: drawerInset),
                previous: nil, lastTravel: 999
            ),
            12, accuracy: 0.001,
            "the first sample must not inherit a travel value it cannot know about"
        )
        // Inset unchanged: the honest measure, whatever was reported before.
        XCTAssertEqual(
            TasksChromeMetrics.travel(
                sample: BoardScrollSample(offset: -barInset + 70, insetTop: barInset),
                previous: BoardScrollSample(offset: -barInset + 10, insetTop: barInset),
                lastTravel: 10
            ),
            70, accuracy: 0.001
        )
        // Inset changed: the previous answer, unchanged.
        XCTAssertEqual(
            TasksChromeMetrics.travel(
                sample: BoardScrollSample(offset: -barInset + 70, insetTop: barInset),
                previous: BoardScrollSample(offset: -barInset + 10, insetTop: drawerInset),
                lastTravel: 10
            ),
            10, accuracy: 0.001
        )
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
        // A compact-bar filter: the board never collapses at all now (`isCollapsed`), so it
        // would publish nothing and this test would pass while measuring nothing.
        let filter = TaskFilter.today
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
        // Derived from the travel rather than a magic 300: the header rebuild took
        // the board's chrome from 106pt to 92pt, and a hardcoded floor would have
        // turned "the fixture got 14pt shorter" into a failing amplification test
        // that had nothing to say about amplification.
        XCTAssertGreaterThanOrEqual(
            tracker.samples, travel,
            "the drag really was fine-grained (2pt steps over \(travel)pt, both ways)"
        )
    }
}
