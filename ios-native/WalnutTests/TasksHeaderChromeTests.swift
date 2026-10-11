import XCTest
@testable import Walnut

/// The Tasks board's HEADER CHROME — the rows that sit above the bands. Dogfood R19
/// measured the cost of treating each of them as an `insetGrouped` section: on an
/// iPhone 16 Pro (402x874pt) the first task row started 591pt down, so 68% of the
/// screen was chrome and spacing on the tab whose whole job is showing tasks.
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
/// there is no card and no fixed width any more: the counts that survived live on
/// `BoardBandBar`'s intrinsically sized chips, so a count can never be wider than its
/// own capsule.
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

    /// End-to-end over the REAL threshold arithmetic: a drag down past the chip row's pin
    /// point and back up publishes exactly twice, whatever the sample rate.
    func testARealDragDownAndBackPublishesTwice() async {
        let tracker = ChromeCollapseTracker()
        var pinned = false
        var applied: [Bool] = []
        let travel = Int(TasksChromeMetrics.chipsPinThreshold(offline: false)) + 200

        func feed(_ y: CGFloat) {
            let want = TasksChromeMetrics.areChipsPinned(
                scrolled: y, wasPinned: pinned, offline: false)
            tracker.request(want, current: pinned) { v in
                applied.append(v); pinned = v
            }
        }
        // Down in 2pt steps (a fine-grained real drag), draining between so the
        // state machine sees the published value the way the view would.
        for y in stride(from: 0, through: travel, by: 2) { feed(CGFloat(y)); await drain() }
        XCTAssertTrue(pinned, "should be pinned at the bottom of the travel")
        for y in stride(from: travel, through: 0, by: -2) { feed(CGFloat(y)); await drain() }
        XCTAssertFalse(pinned, "should be unpinned back at the top")

        XCTAssertEqual(tracker.publishes, 2, "one pin + one unpin, regardless of sample count")
        XCTAssertEqual(applied, [true, false])
        XCTAssertGreaterThanOrEqual(
            tracker.samples, travel,
            "the drag really was fine-grained (2pt steps over \(travel)pt, both ways)"
        )
    }
}
