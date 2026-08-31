import XCTest
import SwiftUI
@testable import Walnut

/// HEADER ORDER, the board's pinned chip row, and the hand-off between its two copies.
///
/// The user's spec: row 1 is the `tasks.nav.pin` / `tasks.nav.calendar` pills, at the
/// top, scrolling away with the content; row 2 is the tier chips, and the chips are the
/// ONLY floating row. The shipping build had it upside down at scroll-top — the chips
/// measured y 236..264 and the pills y 290..322 — because the board's content opened
/// with a clear reserve row and the chips were a PERMANENT overlay pinned to the top of
/// the list area, a position that cannot be second in anything.
///
/// Order is geometry, and geometry needs a running app. What is pinned here is the
/// arithmetic that makes the order possible, and each case is written so that restoring
/// the old shape fails it:
///
///  - the chips pin at the top of THEIR OWN ROW (`rowTwoContentTop`, which is
///    `listHeaderPadding + navRow + sectionGap`), not after the whole chrome has cleared.
///    A permanent overlay would be a threshold of 0.
///  - nothing is pinned at rest, so at scroll-top the chips are an inline row BELOW the
///    pills rather than an overlay above them.
///  - while pinned, the nav row is already behind the bar, so the pinned copy never hides
///    a row the user can still reach.
///  - AT THE CROSSING the two copies are the same bar in the same place — on all THREE
///    axes. This is the part that was documentation rather than arithmetic, and it took
///    two rounds of frame audit to finish: R26 fixed X (the copies are handed different
///    containers, so "one configuration" did not stop the flip from shifting every chip
///    16pt left), and R27 fixed Y and STYLE (the pin fired `listHeaderPadding` early, so
///    the bar teleported 10.66pt up between two frames, and the pinned card drew square
///    corners against the inline row's 10pt rounded ones).
///
/// Split out of `TasksHeaderChromeTests.swift` in R26: that file owns the compact-bar
/// collapse machine, this one owns the pin. The rail's own geometry (widths, gaps, the
/// fade, ink) is a third subject and lives in `WalnutTests/TasksBoardChipRowTests.swift`.
final class TasksBoardChipRowPinTests: XCTestCase {

    private let geometry = BoardBandRailGeometry.standard

    /// The two containers, measured on the iPhone 16 Pro (402pt): the inset-grouped row
    /// the inline copy gets, and the List's own bounds the overlay gets.
    private let inlineContainer: CGFloat = 370
    private let pinnedContainer: CGFloat = 402
    /// Where each container starts on screen.
    private let inlineContainerMinX: CGFloat = 16
    private let pinnedContainerMinX: CGFloat = 0

    /// The board's real tier chips, as `BoardModel.chips` builds them.
    private let tierChips: [BoardModel.BandChip] = [
        .init(bandId: nil, label: "All", count: 92),
        .init(bandId: "focus", label: "Focus", count: 12),
        .init(bandId: "satellite", label: "Satellite", count: 8),
        .init(bandId: "backlog", label: "Backlog", count: 23),
        // A custom tier, not the retired "Everything else" tail band. Same 15-character
        // label so the layout arithmetic this file compares is byte-identical.
        .init(bandId: "ct_deepwork", label: "Deep Work Later", count: 49),
    ]

    /// Content offset of the top of the nav row, i.e. how much rides above it.
    ///
    /// `listHeaderPadding` is part of that answer, and leaving it out is exactly the bug
    /// R27 fixed: the List puts it above its first section, so every row below sits that
    /// much lower than the row heights alone predict.
    private func aboveNavRow(offline: Bool) -> CGFloat {
        var total = TasksChromeMetrics.listHeaderPadding
        if offline { total += TasksChromeMetrics.offlineBanner + TasksChromeMetrics.sectionGap }
        return total
    }

    /// SCREEN rect of one copy's card at a given scroll offset: the layout entry point for
    /// the horizontal half, and the List arithmetic the app derives its threshold from for
    /// the vertical half.
    ///
    ///  - inline: it RIDES THE CONTENT, so its card top is `rowTwoContentTop - scrolled`.
    ///  - pinned: it is an overlay resting at `pinnedChipsTopInset`, at every offset.
    ///
    /// Both are stated in the origin `scrolled` is measured in (the top of the List's
    /// content area), which is the same point the overlay's safe area starts at.
    private func cardScreenRect(
        _ placement: BoardBandBarPlacement, scrolled: CGFloat, offline: Bool
    ) -> CGRect {
        let container = placement == .inlineRow ? inlineContainer : pinnedContainer
        let containerMinX = placement == .inlineRow ? inlineContainerMinX : pinnedContainerMinX
        let layout = geometry.layout(
            container: container, placement: placement, chips: tierChips)
        let top: CGFloat
        switch placement {
        case .inlineRow:
            top = TasksChromeMetrics.rowTwoContentTop(offline: offline) - scrolled
        case .pinnedOverlay:
            top = TasksChromeMetrics.pinnedChipsTopInset
        }
        return CGRect(
            x: containerMinX + layout.card.minX, y: top + layout.card.minY,
            width: layout.card.width, height: layout.card.height
        )
    }

    // MARK: - Row 1 above row 2

    func testTheChipsPinAtTheTopOfTheirOwnRowNotAfterTheWholeChrome() {
        for offline in [false, true] {
            let pin = TasksChromeMetrics.chipsPinThreshold(offline: offline)
            XCTAssertEqual(
                pin,
                aboveNavRow(offline: offline) + TasksChromeMetrics.navRow
                    + TasksChromeMetrics.sectionGap,
                accuracy: 0.01,
                "offline=\(offline): the chips are row 2, so exactly row 1 and its gap ride above them"
            )
            // A permanent overlay pins at 0. The pills MUST get the top first.
            XCTAssertGreaterThan(
                pin, TasksChromeMetrics.navRow,
                "offline=\(offline): the chips would pin while the nav pills are still on screen"
            )
            // And the chips are INSIDE the chrome, not after it: their row sits between the
            // pin point and the end of the header. What follows it below the pin point is the
            // chip row itself and (since R30) the board's own top-level quick add — a row
            // ADDED UNDER the chips cannot move the point where the chips reach the top edge,
            // which is the property this pairing exists to state.
            let chrome = TasksChromeMetrics.chromeHeight(filter: .sessions, offline: offline)
            XCTAssertLessThan(pin, chrome, "offline=\(offline): the chip row is part of the chrome")
            XCTAssertEqual(
                pin + TasksChromeMetrics.bandBar + TasksChromeMetrics.sectionGap
                    + TasksChromeMetrics.quickAdd + TasksChromeMetrics.sectionGap,
                chrome,
                accuracy: 0.01,
                "offline=\(offline): only the chip row and the quick add sit below the pin point"
            )
        }
    }

    func testAtRestTheChipsAreAnInlineRowAndNothingFloats() {
        // Scroll-top (and a rubber-band bounce past it) must leave the chips in the
        // content, under the pills. If this ever passes as `true`, the overlay is back on
        // top of the nav row.
        for offline in [false, true] {
            for scrolled in [CGFloat(-140), -40, 0, 1, 20, 45] {
                let pinned = TasksChromeMetrics.areChipsPinned(
                    scrolled: scrolled, wasPinned: false, offline: offline)
                if scrolled <= TasksChromeMetrics.chipsPinThreshold(offline: offline) {
                    XCTAssertFalse(
                        pinned, "offline=\(offline): pinned at scrolled=\(scrolled)")
                }
            }
        }
        XCTAssertFalse(TasksChromeMetrics.showsPinnedChips(filter: .sessions, pinned: false))
    }

    func testScrollingThroughTheChipRowPinsIt() {
        for offline in [false, true] {
            let pin = TasksChromeMetrics.chipsPinThreshold(offline: offline)
            XCTAssertTrue(
                TasksChromeMetrics.areChipsPinned(
                    scrolled: pin + 1, wasPinned: false, offline: offline),
                "offline=\(offline): the chip row reached the top edge and did not pin"
            )
        }
    }

    /// The pinned copy covers the top `bandBar` of the list area, so it must never be on
    /// screen while the nav row still is. Checked at the WORST case: the unpin threshold,
    /// which is the lowest scroll offset at which the bar can still be up.
    func testWhilePinnedTheNavRowIsAlreadyBehindTheBar() {
        for offline in [false, true] {
            let unpin = TasksChromeMetrics.chipsUnpinThreshold(offline: offline)
            let navBottomOnScreen =
                aboveNavRow(offline: offline) + TasksChromeMetrics.navRow - unpin
            XCTAssertLessThanOrEqual(
                navBottomOnScreen, TasksChromeMetrics.bandBar,
                "offline=\(offline): the pinned chips would cover \(navBottomOnScreen)pt of a nav row that is still on screen"
            )
        }
    }

    // MARK: - The Y hand-off (R27)

    /// THE continuity case: at the offset the pin fires, the two copies occupy the SAME
    /// SCREEN RECT — same x (R26), same y, same size — so there is no frame in which the
    /// bar is in two places or in neither.
    ///
    /// Fed the two REAL containers through `BoardBandRailGeometry.layout`, because that is
    /// the function the body places from, and the threshold is derived from the same
    /// numbers the inline row is positioned by. The old rule counted only the ROWS above
    /// the chips, and the audit measured what that costs: a 10.66pt hop straight up, with
    /// no frame in between (8.66 on a fling, which samples past the crossing and therefore
    /// understates it).
    func testThePinFiresExactlyWhereTheTwoCardsCoincide() {
        for offline in [false, true] {
            let pin = TasksChromeMetrics.chipsPinThreshold(offline: offline)
            let inlineAtPin = cardScreenRect(.inlineRow, scrolled: pin, offline: offline)
            let pinnedRect = cardScreenRect(.pinnedOverlay, scrolled: pin, offline: offline)

            XCTAssertEqual(
                inlineAtPin.minY, pinnedRect.minY, accuracy: 0.01,
                "offline=\(offline): the flip teleports the bar \(inlineAtPin.minY - pinnedRect.minY)pt vertically"
            )
            XCTAssertEqual(
                inlineAtPin.minX, pinnedRect.minX, accuracy: 0.01,
                "offline=\(offline): the flip moves the bar sideways (the R26 defect)"
            )
            XCTAssertEqual(inlineAtPin.width, pinnedRect.width, accuracy: 0.01, "offline=\(offline)")
            XCTAssertEqual(inlineAtPin.height, pinnedRect.height, accuracy: 0.01, "offline=\(offline)")

            // Continuity is about the frames EITHER SIDE of the crossing too: one point of
            // scroll may move the bar one point, never more.
            for step in [CGFloat(0.5), 1, 2, 8] {
                let before = cardScreenRect(.inlineRow, scrolled: pin - step, offline: offline)
                XCTAssertEqual(
                    before.minY - pinnedRect.minY, step, accuracy: 0.01,
                    "offline=\(offline): the inline row does not descend continuously into the pin"
                )
            }

            // The defect, so the fixture is measured against the report rather than
            // against itself: the pre-R27 threshold left the inline row's top a whole
            // `listHeaderPadding` below the pinned copy's resting y at the frame it fired.
            let oldThreshold = TasksChromeMetrics.navRow + TasksChromeMetrics.sectionGap
                + (offline
                    ? TasksChromeMetrics.offlineBanner + TasksChromeMetrics.sectionGap
                    : 0)
            let oldHop = cardScreenRect(.inlineRow, scrolled: oldThreshold, offline: offline).minY
                - pinnedRect.minY
            XCTAssertEqual(
                oldHop, TasksChromeMetrics.listHeaderPadding, accuracy: 0.01,
                "offline=\(offline): if this stops reproducing, the fixture no longer describes the measured hop"
            )
            XCTAssertGreaterThan(oldHop, 8, "the audit's own bar for a hop that reads as a jump")
        }
    }

    /// The threshold is DERIVED, and this is the derivation stated once: everything above
    /// row 2 in the content, less whatever inset the pinned copy rests at. Nothing here is
    /// allowed to be a hand-tuned number that happens to look smooth.
    func testThePinThresholdIsTheYCoincidenceOffsetAndNothingElse() {
        for offline in [false, true] {
            XCTAssertEqual(
                TasksChromeMetrics.chipsPinThreshold(offline: offline),
                TasksChromeMetrics.rowTwoContentTop(offline: offline)
                    - TasksChromeMetrics.pinnedChipsTopInset,
                accuracy: 0.01, "offline=\(offline)"
            )
            // `chromeHeight` reads the same "what rides above row 2" answer, which is what
            // stops the two from drifting apart again. What it adds BELOW row 2 (the chip
            // row's own height, and since R30 the board's quick add) is exactly what the pin
            // threshold must NOT include.
            XCTAssertEqual(
                TasksChromeMetrics.chromeHeight(filter: .sessions, offline: offline),
                TasksChromeMetrics.rowTwoContentTop(offline: offline)
                    + TasksChromeMetrics.bandBar + TasksChromeMetrics.sectionGap
                    + TasksChromeMetrics.quickAdd + TasksChromeMetrics.sectionGap,
                accuracy: 0.01, "offline=\(offline)"
            )
        }
        XCTAssertGreaterThan(
            TasksChromeMetrics.listHeaderPadding, 0,
            "the List's padding above its first section is what the pin used to miss"
        )
    }

    /// The style half of "the same bar": one corner radius for both copies, and it rides
    /// the projection the flip tests compare, so a future divergence fails THERE rather
    /// than needing this case to be remembered.
    func testBothCopiesDrawTheSameRoundedCard() {
        let inline = geometry.layout(
            container: inlineContainer, placement: .inlineRow, chips: tierChips)
        let pinned = geometry.layout(
            container: pinnedContainer, placement: .pinnedOverlay, chips: tierChips)
        XCTAssertEqual(inline.cardCornerRadius, pinned.cardCornerRadius, accuracy: 0.01,
            "the pinned copy's corners pop at the flip")
        XCTAssertGreaterThan(
            geometry.cardCornerRadius, 0,
            "the inline row is clipped to a rounded rect by its section whether it asks or not"
        )

        var squaredOff = geometry
        squaredOff.cardCornerRadius = 0
        let squared = squaredOff.layout(
            container: pinnedContainer, placement: .pinnedOverlay, chips: tierChips)
        XCTAssertNotEqual(
            inline.drawnInCardSpace, squared.drawnInCardSpace,
            "a divergent radius must FAIL the flip comparison, not slip past it"
        )
    }

    /// The dead band exists (no publish per touch-slop wobble) but is deliberately NOT
    /// `hysteresisBand`: a sticky-to-the-top band would keep the bar over the nav row all
    /// the way back up, which is the defect above.
    func testTheChipPinBandIsNarrowEnoughToGiveTheNavRowBack() {
        XCTAssertGreaterThan(TasksChromeMetrics.chipsPinBand, 0, "no band = a publish per wobble")
        XCTAssertLessThan(
            TasksChromeMetrics.chipsPinBand, TasksChromeMetrics.hysteresisBand,
            "the compact bar's band would keep the chips pinned over the nav row"
        )
        for offline in [false, true] {
            let pin = TasksChromeMetrics.chipsPinThreshold(offline: offline)
            let unpin = TasksChromeMetrics.chipsUnpinThreshold(offline: offline)
            XCTAssertLessThan(unpin, pin, "offline=\(offline): no dead band at all")
            XCTAssertGreaterThanOrEqual(unpin, 0, "offline=\(offline): a negative threshold")
        }
    }

    /// The band's OTHER cost, which is the one R27 has to keep bounded: since the pin point
    /// is the only offset where the two cards coincide, unpinning a band early brings the
    /// inline row back exactly `chipsPinBand` points below where the pinned copy just was.
    ///
    /// Down-scroll is continuous to the point (asserted above); up-scroll owes this much,
    /// and it must stay under the audit's bar for a hop that reads as a jump. This is why
    /// the band cannot simply be widened for comfort.
    func testTheOnlyResidualHopIsTheUnpinBandAndItStaysUnderTheAuditsBar() {
        for offline in [false, true] {
            let unpin = TasksChromeMetrics.chipsUnpinThreshold(offline: offline)
            let pinnedRect = cardScreenRect(.pinnedOverlay, scrolled: unpin, offline: offline)
            let hop = cardScreenRect(.inlineRow, scrolled: unpin, offline: offline).minY
                - pinnedRect.minY
            XCTAssertEqual(
                hop, TasksChromeMetrics.chipsPinBand, accuracy: 0.01,
                "offline=\(offline): the up-scroll hop is the band, by construction"
            )
            XCTAssertLessThan(
                hop, 8,
                "offline=\(offline): \(hop)pt reads as a jump — the band is the hop, so it cannot be widened for comfort"
            )
        }
    }

    func testAScrollDownAndBackPinsAndUnpinsExactlyOnce() {
        for offline in [false, true] {
            let travel = Int(TasksChromeMetrics.chromeHeight(
                filter: .sessions, offline: offline)) + 200
            var pinned = false
            var flips = 0
            for y in 0...travel {
                let next = TasksChromeMetrics.areChipsPinned(
                    scrolled: CGFloat(y), wasPinned: pinned, offline: offline)
                if next != pinned { flips += 1; pinned = next }
            }
            XCTAssertEqual(flips, 1, "offline=\(offline): scrolling down should pin exactly once")
            for y in stride(from: travel, through: 0, by: -1) {
                let next = TasksChromeMetrics.areChipsPinned(
                    scrolled: CGFloat(y), wasPinned: pinned, offline: offline)
                if next != pinned { flips += 1; pinned = next }
            }
            XCTAssertEqual(flips, 2, "offline=\(offline): scrolling back up should unpin exactly once")
            XCTAssertFalse(pinned, "offline=\(offline): still pinned at the top of the list")
        }
    }

    func testOnlyTheBoardHasChipsToPin() {
        for filter in TaskFilter.allCases where filter != .sessions {
            XCTAssertFalse(
                TasksChromeMetrics.showsPinnedChips(filter: filter, pinned: true),
                "\(filter) has no chip row, so it cannot pin one"
            )
        }
    }

    // MARK: - The crossing frame: the same bar in the same place (review items 1 and 5)

    /// The hand-off, fed the REAL containers rather than one shared width: at the frame
    /// the flip happens, the inline row is laying out in the inset-grouped card's 370pt
    /// and the overlay in the List's 402pt. Both must resolve to the same card, the same
    /// rail, the same chip positions — otherwise the flip is a 16pt jump, which is what
    /// the review measured on the built binary.
    func testTheCrossingFrameShowsTheSameBarAtTheSameX() {
        let inline = geometry.layout(
            container: inlineContainer, placement: .inlineRow, chips: tierChips)
        let pinned = geometry.layout(
            container: pinnedContainer, placement: .pinnedOverlay, chips: tierChips)

        // Everything DRAWN is identical; `card.minX` is the inset each placement owes
        // its own container, so it is compared as screen x on the next line instead.
        XCTAssertEqual(inline.drawnInCardSpace, pinned.drawnInCardSpace,
            "the inline row and the pinned copy are different bars")
        // Screen x of the card: the inline row's container already starts at 16, the
        // overlay's at 0 and insets itself.
        XCTAssertEqual(16 + inline.card.minX, 0 + pinned.card.minX, accuracy: 0.01,
            "the bar moves sideways at the flip")
        // Both are the same height, which is what makes the hand-off read as a sticky
        // header rather than a swap.
        XCTAssertEqual(inline.card.height, TasksChromeMetrics.bandBar)
        XCTAssertEqual(pinned.card.height, TasksChromeMetrics.bandBar)
    }

    /// The flip is invisible only if nothing ELSE is per-copy. `placement` reaches exactly
    /// one number (`cardInset`), so there is nothing for a shadow, a corner radius or a
    /// different material to hang off — a future "the pinned one should look different"
    /// has to add a field here and fail this.
    func testThePinnedCopyAddsNoChromeOfItsOwn() {
        let geometry = BoardBandRailGeometry.standard
        XCTAssertEqual(BoardBandBarPlacement.allCases.count, 2)
        XCTAssertEqual(geometry.cardInset(placement: .inlineRow), 0)
        XCTAssertEqual(geometry.cardInset(placement: .pinnedOverlay), geometry.cardHorizontalInset)
        // Fed the same container, the ONLY difference between the two is that inset.
        for container in [CGFloat(320), 370, 402, 430] {
            let asInline = geometry.layout(container: container, placement: .inlineRow)
            let asPinned = geometry.layout(container: container, placement: .pinnedOverlay)
            XCTAssertEqual(asPinned.card.minX, geometry.cardHorizontalInset, accuracy: 0.01)
            XCTAssertEqual(asInline.card.minX, 0, accuracy: 0.01)
            XCTAssertEqual(
                asInline.card.width - asPinned.card.width,
                2 * geometry.cardHorizontalInset, accuracy: 0.01,
                "container=\(container): the inset is not the only per-copy difference"
            )
            // Same card width in, same everything out — which is the property the flip
            // relies on once each copy is handed its own container.
            let matched = geometry.layout(
                container: container - 2 * geometry.cardHorizontalInset, placement: .inlineRow)
            XCTAssertEqual(matched.rail, asPinned.rail, "container=\(container)")
            XCTAssertEqual(matched.filters, asPinned.filters, "container=\(container)")
            XCTAssertEqual(matched.hairline, asPinned.hairline, "container=\(container)")
        }
    }

    // MARK: - THE EMPTY PINNED BAR (the reported defect, and the shape that caused it)
    //
    // Mid-scroll the floating bar drew its card and its filters button over a
    // mathematically flat 316pt rail: not a clipped capsule, not a partial one, no
    // fade — bare card material (measured on the user's screenshot: rail region mean
    // 250.0, std 0.84). The chips existed and the rail was the right size, so the
    // horizontal `ScrollView` inside it had rendered nothing.
    //
    // Mechanism: the pinned copy was a CONDITIONALLY INSERTED overlay, so every pin
    // crossing constructed a brand-new `ScrollViewReader`/`ScrollView`, and a
    // `GeometryReader` can report 0 on its first pass. `railWidth(cardWidth: 0)` is 0,
    // so that fresh scroll view was laid out into a zero-width viewport — and nothing
    // re-established it afterwards (`reveal()` was wired to selection, grouping and
    // appear, never to a width). The card and the button recovered on the next pass
    // because they are plain frames recomputed from `layout` every time.
    //
    // The old coverage could not reach any of this: it drove `BoardBandRailGeometry
    // .layout` as a pure value at 320/370/402/430 and never a degenerate width. These
    // cases pin the three layers of the fix.

    /// Layer 1: a degenerate measurement is UNRENDERABLE rather than unrecoverable.
    /// Below `minimumUsableContainer` no scroll view is constructed at all, so there is
    /// no instance that can get stuck.
    ///
    /// The floor is PER-PLACEMENT, because the card inset is: `layout` derives the card
    /// as `container - 2 * cardInset(placement:)`, so at one and the same container the
    /// inline copy (inset 0) has 32pt more card than the pinned one (inset 16 a side).
    /// A single placement-agnostic floor is therefore either a lie about one copy or a
    /// needless blackout of the other — measured: with the pinned number (86) as the
    /// shared floor, the inline copy at 85.5pt was refused a rail it had 31.5pt of.
    func testADegenerateContainerBuildsNoRailAtAll() {
        for placement in BoardBandBarPlacement.allCases {
            let floor = BoardBandBar.minimumUsableContainer(placement)
            XCTAssertGreaterThan(floor, 0, "\(placement)")
            for container in [CGFloat(0), 1, 20, floor - 0.5] {
                XCTAssertLessThan(
                    container, floor,
                    "container=\(container)/\(placement) must be below the floor for this case to mean anything"
                )
                // What the arithmetic says about such a width, which is why the view must
                // not hand it to a `UIScrollView`: there is no rail.
                let layout = geometry.layout(
                    container: container, placement: placement, chips: tierChips)
                XCTAssertLessThanOrEqual(
                    layout.rail.width, 0,
                    "container=\(container)/\(placement): a scroll view here is born into a viewport it cannot use"
                )
            }
            // The floor is exactly the width below which THIS copy's rail has nothing
            // left, so it is derived and not a taste number.
            XCTAssertEqual(
                floor,
                2 * geometry.cardInset(placement: placement)
                    + geometry.filtersColumnWidth + geometry.railSpacing,
                accuracy: 0.01
            )
            // One point above its own floor, that copy has a rail again — which is what
            // makes the guard a floor rather than a blackout.
            XCTAssertGreaterThan(
                geometry.layout(
                    container: floor + 1, placement: placement, chips: tierChips
                ).rail.width,
                0, "\(placement)"
            )
        }
        // The pinned copy pays the wider inset, so its floor is the conservative one and
        // the two are 2 * the inset apart.
        XCTAssertEqual(
            BoardBandBar.minimumUsableContainer(.pinnedOverlay)
                - BoardBandBar.minimumUsableContainer(.inlineRow),
            2 * geometry.cardHorizontalInset, accuracy: 0.01
        )
        // …and the real containers are comfortably above both, so the guard never fires
        // in the shape that ships.
        for container in [inlineContainer, pinnedContainer] {
            for placement in BoardBandBarPlacement.allCases {
                XCTAssertGreaterThan(
                    container, BoardBandBar.minimumUsableContainer(placement),
                    "container=\(container)/\(placement)"
                )
            }
        }
    }

    /// Layer 2: BOTH copies exist at all times and `drawsChips` decides which one is
    /// visible, so a pin crossing cannot destroy and re-create either.
    ///
    /// Exactly ONE copy draws in every pin state — the property that used to be
    /// guaranteed by conditional insertion, restated so the fix does not trade a stuck
    /// rail for two live copies of every `board.chip.*` id.
    func testExactlyOneCopyDrawsItsChipsInEveryPinState() {
        for pinned in [false, true] {
            let drawing = BoardBandBarPlacement.allCases.filter {
                BoardBandBar.drawsChips(
                    placement: $0, pinned: pinned, chipCount: tierChips.count)
            }
            XCTAssertEqual(
                drawing.count, 1,
                "pinned=\(pinned): \(drawing.count) copies draw — two would make every chip ambiguous to automation, zero is the bare card the user screenshotted"
            )
        }
        XCTAssertTrue(BoardBandBar.drawsChips(
            placement: .inlineRow, pinned: false, chipCount: tierChips.count))
        XCTAssertTrue(BoardBandBar.drawsChips(
            placement: .pinnedOverlay, pinned: true, chipCount: tierChips.count))
    }

    /// A bar with NO chips draws nothing at all, in either copy. That is the reported
    /// symptom stated as a rule: a card plus a filters button over a bare rail claims
    /// "this board has no bands" while five bands are drawn below it, so an empty rail
    /// must be no card rather than an empty one.
    ///
    /// On the board this branch is unreachable — `BoardModel.chips` always emits the
    /// leading `All` chip — which is exactly why it is written down instead of assumed.
    func testNoChipsMeansNoCardRatherThanAnEmptyRail() {
        XCTAssertEqual(BoardModel.chips([]).count, 1,
            "the All chip is always there, so the board never reaches the branch below")
        for placement in BoardBandBarPlacement.allCases {
            for pinned in [false, true] {
                XCTAssertFalse(
                    BoardBandBar.drawsChips(placement: placement, pinned: pinned, chipCount: 0),
                    "\(placement)/pinned=\(pinned): a chipless bar must not draw its card"
                )
            }
        }
    }

    /// Layer 3: a width that ARRIVES LATE still produces a usable rail. The view wires
    /// `reveal` to `layout.rail.width` for this; the arithmetic half is that the SAME
    /// geometry, re-evaluated once the real container lands, resolves to the full rail
    /// rather than staying at whatever the first pass measured.
    func testARailWidthThatArrivesLateResolvesToTheRealRail() {
        for placement in BoardBandBarPlacement.allCases {
            let container = placement == .inlineRow ? inlineContainer : pinnedContainer
            let degenerate = geometry.layout(
                container: 0, placement: placement, chips: tierChips)
            let arrived = geometry.layout(
                container: container, placement: placement, chips: tierChips)
            XCTAssertEqual(degenerate.rail.width, 0, "\(placement)")
            XCTAssertGreaterThan(
                arrived.rail.width, 0,
                "\(placement): the rail must come back once the container is real"
            )
            XCTAssertNotEqual(
                degenerate.rail.width, arrived.rail.width,
                "\(placement): the width CHANGES, which is the signal `reveal` is wired to"
            )
            // And the filters control moves with it, which is what proves the card was
            // framed correctly all along while only the rail stayed dead: the user's
            // screenshot had the button at its correct trailing x.
            XCTAssertGreaterThan(arrived.filters.minX, degenerate.filters.minX, "\(placement)")
        }
    }

    /// The board's pinned copy EXISTS for as long as the board does, and that is a
    /// filter-only question — `hasPinnedChips`. It used to be
    /// `showsPinnedChips(filter:pinned:)`, i.e. existence depended on the pin state,
    /// which is what made the overlay a conditional insertion.
    ///
    /// `showsPinnedChips` is now derived from it, so the two can never disagree about
    /// which filter has chips.
    func testExistenceOfThePinnedCopyIsAFilterQuestionNotAPinQuestion() {
        XCTAssertTrue(TasksChromeMetrics.hasPinnedChips(.sessions))
        for filter in TaskFilter.allCases where filter != .sessions {
            XCTAssertFalse(TasksChromeMetrics.hasPinnedChips(filter), "\(filter) has no chip row")
        }
        for filter in TaskFilter.allCases {
            for pinned in [false, true] {
                XCTAssertEqual(
                    TasksChromeMetrics.showsPinnedChips(filter: filter, pinned: pinned),
                    TasksChromeMetrics.hasPinnedChips(filter) && pinned,
                    "\(filter)/pinned=\(pinned): the composed rule drifted from the filter-only one"
                )
            }
        }
    }

    // MARK: - The VIEW, not just its arithmetic (the coverage gap that let this ship)

    @MainActor
    private func bar(
        latch: BoardChipsPinLatch, placement: BoardBandBarPlacement
    ) -> BoardBandBar {
        BoardBandBar(
            chips: tierChips, selected: nil,
            grouping: .constant(.tier), dateFilter: .constant(.all),
            onSelect: { _ in }, placement: placement, pinLatch: latch
        )
    }

    /// Every `UIScrollView` in a hosted hierarchy. The chip rail is the only scroll view
    /// the bar builds, so this is "did the rail get made, and does it hold anything".
    @MainActor
    private func rails(in view: UIView) -> [UIScrollView] {
        var found: [UIScrollView] = []
        if let scroll = view as? UIScrollView { found.append(scroll) }
        for sub in view.subviews { found.append(contentsOf: rails(in: sub)) }
        return found
    }

    /// Lay out, then let the next few frames settle — a `UIScrollView`'s `contentSize`
    /// is established by its content's own layout, which SwiftUI may finish on a later
    /// pass (the same reason `FirstPaintFreezeTests` spins the runloop after mounting).
    @MainActor
    private func settle(_ view: UIView) {
        view.setNeedsLayout()
        view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        view.layoutIfNeeded()
    }

    /// THE regression test for the empty pinned bar, and the first one in this file that
    /// renders the real `BoardBandBar` instead of driving `BoardBandRailGeometry` as a
    /// value.
    ///
    /// Why the old coverage could not reach the defect: the arithmetic was RIGHT
    /// (`railWidth(cardWidth: 0)` really is 0), and the bug was that a `UIScrollView`
    /// laid out into that viewport was never re-established — `reveal()` was wired to
    /// selection, grouping and appear, and to no width. So the card and the filters
    /// button recovered on the next pass (plain frames) while the rail stayed dead for
    /// the life of that instance: 316pt of flat card material, measured on the user's
    /// screenshot at mean 250.0 / std 0.84.
    ///
    /// The assertion is a UIKit fact rather than an accessibility query: below the usable
    /// width NO scroll view may be built at all, and once the real width arrives there
    /// must be exactly one, holding content. A chipless rail is precisely a scroll view
    /// whose `contentSize.width` is 0.
    @MainActor
    func testTheBarBuildsARealRailAfterAZeroWidthFirstMeasurement() {
        let latch = BoardChipsPinLatch()   // unpinned, so the inline copy is the live one
        let host = UIHostingController(rootView: bar(latch: latch, placement: .inlineRow))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: pinnedContainer, height: 240))
        window.isHidden = false
        // A SUBVIEW rather than the root: the window would re-impose its own bounds on a
        // root view, and the width is the whole variable here.
        window.addSubview(host.view)

        // Pass 1: a measurement the arithmetic cannot use.
        host.view.frame = CGRect(x: 0, y: 0, width: 0, height: TasksChromeMetrics.bandBar)
        settle(host.view)
        XCTAssertTrue(
            rails(in: host.view).isEmpty,
            "a rail was laid out into a zero-width viewport — the stuck state the user screenshotted is reachable again"
        )

        // Pass 2: the real container arrives (402pt, the pinned copy's; the inline copy's
        // 370 is inside it either way).
        host.view.frame = CGRect(
            x: 0, y: 0, width: pinnedContainer, height: TasksChromeMetrics.bandBar)
        settle(host.view)
        let built = rails(in: host.view)
        XCTAssertEqual(
            built.count, 1,
            "\(built.count) rails: zero is the bare card, two would put every board.chip.* id on screen twice"
        )
        let content = built.first?.contentSize.width ?? 0
        XCTAssertGreaterThan(
            content, 0,
            "the rail holds \(content)pt of content — the bar is drawing its card and its filters button over a dead scroll view"
        )
        // And the chips it holds are wider than one chip, i.e. it really is the rail and
        // not an empty container that happens to exist.
        XCTAssertGreaterThan(content, geometry.minimumChipWidth, "content \(content)pt")

        host.view.removeFromSuperview()
        window.isHidden = true
    }

    /// The same view, in the PINNED copy, at the container it is really handed — and with
    /// the latch flipped, because that is the copy whose chips the user found missing.
    ///
    /// It also pins the fix's other half: the two copies are constructed unconditionally
    /// now, so a crossing cannot destroy and re-create either. Flipping the latch on a
    /// LIVE instance and finding the same single rail is what that looks like from
    /// outside.
    @MainActor
    func testThePinnedCopyKeepsItsRailAcrossAPinCrossing() {
        let latch = BoardChipsPinLatch()
        let host = UIHostingController(rootView: bar(latch: latch, placement: .pinnedOverlay))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: pinnedContainer, height: 240))
        window.isHidden = false
        window.addSubview(host.view)
        host.view.frame = CGRect(
            x: 0, y: 0, width: pinnedContainer, height: TasksChromeMetrics.bandBar)

        settle(host.view)
        let before = rails(in: host.view)
        XCTAssertEqual(before.count, 1, "the pinned copy exists while unpinned, just hidden")
        let widthWhileHidden = before.first?.contentSize.width ?? 0

        // The crossing.
        latch.isPinned = true
        settle(host.view)
        let after = rails(in: host.view)
        XCTAssertEqual(after.count, 1, "the crossing built a second rail — the copies are conditional again")
        XCTAssertTrue(
            after.first === before.first,
            "the crossing replaced the rail's scroll view; a fresh one is what could come up zero-width and stay empty"
        )
        XCTAssertGreaterThan(
            after.first?.contentSize.width ?? 0, 0,
            "the pinned copy is showing a rail with no content — this IS the reported defect"
        )
        XCTAssertEqual(
            after.first?.contentSize.width ?? 0, widthWhileHidden, accuracy: 0.5,
            "the rail's content changed size at the crossing, which is a bar that lays out differently in the two states"
        )

        host.view.removeFromSuperview()
        window.isHidden = true
    }
}
