import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// `BoardBandRailGeometry` / `BoardBandBarLayout` — the band bar's card, the rail beside
/// the detached filters control, the scroll affordance, the ink on a chip, and (R27) the
/// card's own surface plus which container the two filters are presented in.
///
/// # Why this file was rewritten (R26)
///
/// R25 asserted "both copies of the bar are built from ONE configuration" and shipped a
/// visible jump anyway, because the two copies are handed DIFFERENT CONTAINERS: the
/// inline List row lays out in 370pt (x 16..386 of a 402pt screen, the inset-grouped
/// card) while the pinned overlay lays out edge-to-edge in 402pt. One configuration
/// applied to two containers is two layouts — measured, the rails were 338 and 354, every
/// chip jumped 16pt left at the flip, and the PINNED copy's rail still ran under
/// `board.filters`.
///
/// So every case here goes through `layout(container:placement:…)`, which is the function
/// the body places from, and the two REAL containers are fed through it side by side.
///
/// # And why the a11y-rect criterion is gone
///
/// A chip inside a horizontal `ScrollView` ALWAYS reports its unclipped virtual frame, so
/// "no accessibility rect intersects the button" is physically unsatisfiable — the R25
/// cases that asserted it were asserting something the platform will not do. What is
/// checkable, and what the review asked for, is PIXELS and TAPS: the rail's viewport and
/// the filters control are disjoint with a real gap, the rail is clipped and hit-clipped
/// to that viewport, and a chip's activation point lands inside it.
final class TasksBoardChipRowTests: XCTestCase {

    private let rail = BoardBandRailGeometry.standard

    /// Screen widths worth checking: the small phone, the reviewer's iPhone 16 Pro, and
    /// the plus sizes. iPhone-only target, so no iPad column.
    private let screenWidths: [CGFloat] = [320, 375, 390, 402, 430]

    /// The reviewed build's iPhone 16 Pro.
    private let screen: CGFloat = 402
    /// What the INLINE copy is handed: the inset-grouped row, measured x 16..386.
    private let inlineContainer: CGFloat = 370
    /// What the PINNED copy is handed: the List's own bounds.
    private let pinnedContainer: CGFloat = 402

    /// The container each copy is handed on a screen of `width`.
    private func container(_ placement: BoardBandBarPlacement, screen width: CGFloat) -> CGFloat {
        switch placement {
        case .inlineRow: return width - 2 * rail.cardHorizontalInset
        case .pinnedOverlay: return width
        }
    }

    /// Where the container itself starts on screen.
    private func containerMinX(
        _ placement: BoardBandBarPlacement, screen width: CGFloat
    ) -> CGFloat {
        switch placement {
        case .inlineRow: return rail.cardHorizontalInset
        case .pinnedOverlay: return 0
        }
    }

    /// The layout each copy resolves to on a screen of `width`.
    private func layout(
        _ placement: BoardBandBarPlacement, screen width: CGFloat,
        chips: [BoardModel.BandChip] = [], typeScale: CGFloat = 1
    ) -> BoardBandBarLayout {
        rail.layout(
            container: container(placement, screen: width), placement: placement,
            chips: chips, typeScale: typeScale
        )
    }

    /// The board's real tier chips, with counts, as `BoardModel.chips` builds them.
    private var tierChips: [BoardModel.BandChip] {
        [
            .init(bandId: nil, label: "All", count: 92),
            .init(bandId: "focus", label: "Focus", count: 12),
            .init(bandId: "satellite", label: "Satellite", count: 8),
            .init(bandId: "backlog", label: "Backlog", count: 23),
            // A CUSTOM tier, which is the widest band label the board can really
            // produce now that the "Everything else" tail band is gone. Deliberately the
            // same 15 characters that label was, so every width this file pins is
            // unchanged: the estimate reads `label.count`, and re-baselining a geometry
            // suite because a fixture's wording changed is how a gate stops meaning
            // anything.
            .init(bandId: "ct_deepwork", label: "Deep Work Later", count: 49),
        ]
    }

    /// The LONG rail, which is the worst case this bar has to lay out: ~30 named chips.
    ///
    /// The ids are custom tiers, because that is now the only way the rail gets long — it
    /// is always the TIER rail, under every grouping, so it can never hold `proj:` or
    /// `folder:` chips. The LABELS are unchanged ("Project N"), deliberately: every width
    /// this file pins reads `label.count`, and re-baselining a geometry suite because a
    /// fixture's ids changed is how a gate stops meaning anything.
    private var longRailChips: [BoardModel.BandChip] {
        var chips: [BoardModel.BandChip] = [.init(bandId: nil, label: "All", count: 92)]
        for index in 0..<30 {
            chips.append(.init(bandId: "ct_p\(index)", label: "Project \(index)", count: 3))
        }
        return chips
    }

    /// Two chips: genuinely nothing to scroll to.
    private var shortChips: [BoardModel.BandChip] {
        [
            .init(bandId: nil, label: "All", count: 4),
            .init(bandId: "focus", label: "Focus", count: 4),
        ]
    }

    private func overlap(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        max(0, min(lhs.maxX, rhs.maxX) - max(lhs.minX, rhs.minX))
    }

    // MARK: - ONE GEOMETRY FOR BOTH COPIES (review item 1)

    /// The measured containers, side by side, through the real entry point: the two
    /// copies resolve to the same card, the same rail, the same everything.
    func testTheTwoRealContainersResolveToOneIdenticalLayout() {
        let inline = rail.layout(
            container: inlineContainer, placement: .inlineRow, chips: tierChips)
        let pinned = rail.layout(
            container: pinnedContainer, placement: .pinnedOverlay, chips: tierChips)

        XCTAssertEqual(inline.card.width, pinned.card.width, accuracy: 0.01,
            "the inline row's card and the pinned copy's are different widths")
        XCTAssertEqual(inline.rail, pinned.rail, "the rails differ, so every chip moves at the flip")
        XCTAssertEqual(inline.filters, pinned.filters)
        XCTAssertEqual(inline.hairline, pinned.hairline)
        XCTAssertEqual(inline.chipMaxWidth, pinned.chipMaxWidth, accuracy: 0.01)
        XCTAssertEqual(inline.fadeWidth, pinned.fadeWidth, accuracy: 0.01)
        XCTAssertEqual(inline.railTrailingContentInset, pinned.railTrailingContentInset,
                       accuracy: 0.01)

        // The card lands on the same SCREEN x, which is the half the inset carries.
        XCTAssertEqual(
            containerMinX(.inlineRow, screen: screen) + inline.card.minX,
            containerMinX(.pinnedOverlay, screen: screen) + pinned.card.minX,
            accuracy: 0.01,
            "the two cards start at different screen x, so the bar jumps sideways at the flip"
        )
        XCTAssertEqual(inline.card.width, 370, accuracy: 0.01, "the measured inset-grouped card")
    }

    /// The same invariant across every shipping width, so it is a property rather than
    /// one lucky screen.
    func testThePinFlipIsPixelInvariantAtEveryWidth() {
        for width in screenWidths {
            let inline = layout(.inlineRow, screen: width, chips: tierChips)
            let pinned = layout(.pinnedOverlay, screen: width, chips: tierChips)
            // `drawnInCardSpace`, not the whole layout: `card.minX` is the ONE value
            // `placement` reaches, so it differs by the inset on purpose and the next
            // assertion is the one that pins it (via the container's own origin).
            XCTAssertEqual(inline.drawnInCardSpace, pinned.drawnInCardSpace,
                "screen=\(width): the two copies are laid out differently")
            XCTAssertEqual(
                containerMinX(.inlineRow, screen: width) + inline.card.minX,
                containerMinX(.pinnedOverlay, screen: width) + pinned.card.minX,
                accuracy: 0.01, "screen=\(width): the card starts at a different screen x"
            )
        }
    }

    /// The defect, restated so the fix is measured against it: under the old rule (the
    /// bar laid out in whatever container it was handed, with no card of its own) the
    /// pinned copy's chips started 16pt left of the inline row's and its rail was 16pt
    /// wider. If this stops reproducing, the fixture is wrong.
    func testTheMeasuredSixteenPointJumpIsGone() {
        // OLD: rail = container - column - spacing, card = container, inset = 0 always.
        let oldInlineChipMinX = containerMinX(.inlineRow, screen: screen) + rail.contentLeadingInset
        let oldPinnedChipMinX = containerMinX(.pinnedOverlay, screen: screen) + rail.contentLeadingInset
        XCTAssertEqual(
            oldInlineChipMinX - oldPinnedChipMinX, rail.cardHorizontalInset, accuracy: 0.01,
            "the reported 16pt leftward jump"
        )

        // NEW: both copies' first chip starts at the same screen x.
        let inline = rail.layout(container: inlineContainer, placement: .inlineRow)
        let pinned = rail.layout(container: pinnedContainer, placement: .pinnedOverlay)
        let inlineChipMinX = containerMinX(.inlineRow, screen: screen)
            + inline.card.minX + inline.rail.minX + rail.contentLeadingInset
        let pinnedChipMinX = containerMinX(.pinnedOverlay, screen: screen)
            + pinned.card.minX + pinned.rail.minX + rail.contentLeadingInset
        XCTAssertEqual(inlineChipMinX, pinnedChipMinX, accuracy: 0.01)
        XCTAssertEqual(inlineChipMinX, 26, accuracy: 0.01, "16pt card + 10pt gutter")
    }

    /// Only ONE thing may depend on which copy this is.
    func testPlacementDecidesTheCardInsetAndNothingElse() {
        XCTAssertEqual(BoardBandBarPlacement.allCases.count, 2, "inline row + pinned overlay")
        XCTAssertEqual(rail.cardInset(placement: .inlineRow), 0,
            "the List already inset the row; insetting again would double it")
        XCTAssertEqual(rail.cardInset(placement: .pinnedOverlay), rail.cardHorizontalInset)
        // Fed the SAME container, the only difference is the inset — which is exactly
        // what makes feeding them their own real containers land on one layout.
        let sameContainer: CGFloat = 402
        let asInline = rail.layout(container: sameContainer, placement: .inlineRow)
        let asPinned = rail.layout(container: sameContainer, placement: .pinnedOverlay)
        XCTAssertEqual(asInline.card.width - asPinned.card.width,
                       2 * rail.cardHorizontalInset, accuracy: 0.01)
    }

    // MARK: - A DETACHED filters control (review item 2)

    /// The card is partitioned exactly: rail + gap + column = the card. Nothing is left
    /// to a negotiation between a flexible `ScrollView` and a fixed button, which is how
    /// the rail's content ended up underneath the button.
    func testTheCardIsPartitionedIntoARailAndTheFiltersColumn() {
        for width in screenWidths {
            for placement in BoardBandBarPlacement.allCases {
                let l = layout(placement, screen: width)
                XCTAssertEqual(
                    l.rail.width + rail.railSpacing + rail.filtersColumnWidth, l.card.width,
                    accuracy: 0.01, "screen=\(width) \(placement)"
                )
                XCTAssertEqual(
                    l.filters.maxX + rail.filtersTrailingInset, l.card.width, accuracy: 0.01,
                    "screen=\(width) \(placement): the control must sit off the card's edge"
                )
            }
        }
    }

    /// The gap the review asked for, as a number: at least 8pt of real card material
    /// between the last pixel the rail can show and the control. The R25 value was 4,
    /// which is why a chip cut flat at the clip edge read as part of the button.
    func testTheFiltersControlIsAtLeastEightPointsClearOfTheRail() {
        XCTAssertGreaterThanOrEqual(rail.railSpacing, 8, "the detachment is the fix, not a hairline")
        for width in screenWidths {
            for placement in BoardBandBarPlacement.allCases {
                let l = layout(placement, screen: width, chips: longRailChips)
                XCTAssertGreaterThanOrEqual(
                    l.filters.minX - l.rail.maxX, 8 - 0.01,
                    "screen=\(width) \(placement): only \(l.filters.minX - l.rail.maxX)pt of gap"
                )
                XCTAssertEqual(
                    overlap(l.rail, l.filters), 0, accuracy: 0.01,
                    "screen=\(width) \(placement): the rail's viewport reaches into the control"
                )
            }
        }
    }

    /// The rail keeps the overwhelming majority of the card: the constant-use control
    /// keeps the width, the rare one keeps its 44pt column.
    func testTheRailKeepsMostOfTheCard() {
        for width in screenWidths {
            let l = layout(.inlineRow, screen: width)
            XCTAssertGreaterThan(l.rail.width / l.card.width, 0.8,
                "screen=\(width): the rail lost its width")
        }
    }

    /// The clip is what makes "no chip pixel under the control" true for a chip whose
    /// own frame runs past the rail — the accessibility-XXXL case, where a single capsule
    /// measured 209pt. Stated in what the rail can SHOW, because that is the only thing
    /// the platform lets us bound.
    func testNothingTheRailCanShowReachesTheControlAtAnyChipPosition() {
        for width in screenWidths {
            let l = layout(.pinnedOverlay, screen: width, chips: longRailChips)
            for chipMinX in stride(from: CGFloat(0), through: l.card.width, by: 7) {
                for chipWidth in [CGFloat(40), 102, 157, 209, 400] {
                    // What the viewport can reveal of a chip that starts there.
                    let shown = CGRect(
                        x: chipMinX, y: 0,
                        width: min(chipWidth, rail.peek(chipMinX: chipMinX, cardWidth: l.card.width)),
                        height: l.rail.height
                    )
                    guard shown.width > 0 else { continue }
                    XCTAssertEqual(
                        overlap(shown, l.filters), 0, accuracy: 0.01,
                        "screen=\(width) chip=[\(chipMinX),\(chipMinX + chipWidth)]"
                    )
                    XCTAssertLessThanOrEqual(shown.maxX, l.filters.minX - 8,
                        "screen=\(width): a visible chip pixel is within 8pt of the control")
                }
            }
        }
    }

    /// The other half of the reported defect, and the half that is about TAPS: a chip
    /// partly scrolled out keeps its full reported frame, so a tap aimed at the CENTRE of
    /// `board.chip.backlog` [318,420] went to x=369 — past a 316pt rail. The activation
    /// point moves the delivered tap into the part of the chip the rail is showing.
    func testAChipsTapLandsInsideTheRailAndNotOnTheControl() {
        let l = rail.layout(container: inlineContainer, placement: .inlineRow, chips: tierChips)
        // Rail-space fixture: a 102pt chip straddling the trailing edge.
        let chipMinX = l.rail.width - 12
        let chipWidth: CGFloat = 102

        let centre = chipMinX + chipWidth / 2
        XCTAssertGreaterThan(centre, l.rail.maxX, "the reported centre-tap defect")

        let delivered = chipMinX + chipWidth * rail.chipActivationX
        XCTAssertGreaterThan(delivered, chipMinX, "the tap has to stay on the chip")
        XCTAssertLessThan(delivered, l.rail.maxX,
            "the delivered tap is outside the viewport, i.e. not on a visible chip pixel")
        XCTAssertLessThan(delivered, l.filters.minX)
    }

    func testTheActivationFractionIsInsideTheLeadingSliverOfAnyOrdinaryChip() {
        XCTAssertGreaterThan(rail.chipActivationX, 0.05, "on the capsule's edge is not on the chip")
        let ordinaryChipWidth: CGFloat = 100
        XCTAssertLessThan(
            ordinaryChipWidth * rail.chipActivationX, rail.trailingFadeWidth,
            "a chip with only its fade showing must still take the tap on the visible part"
        )
    }

    // MARK: - AN HONEST SCROLL AFFORDANCE (review item 3)

    /// The worst case from the review: "By project" at default type, where the rail
    /// simply stopped flat with no hint that ~30 bands followed. The fade has to be there
    /// in every grouping and at every type size the chips can render at.
    func testTheFadeAppearsWheneverTheChipsOverflowTheRail() {
        let scales: [CGFloat] = [
            BoardBandBar.chipTypeScale(.large),
            BoardBandBar.chipTypeScale(.xxLarge),
            BoardBandBar.chipTypeScale(.accessibility5),
        ]
        for width in screenWidths {
            for placement in BoardBandBarPlacement.allCases {
                for scale in scales {
                    for (name, chips) in [("tier", tierChips), ("longRail", longRailChips)] {
                        let l = layout(placement, screen: width, chips: chips, typeScale: scale)
                        XCTAssertGreaterThan(
                            l.fadeWidth, 0,
                            "screen=\(width) \(placement) \(name) scale=\(scale): the rail stops flat"
                        )
                        XCTAssertEqual(l.fadeWidth, rail.trailingFadeWidth, accuracy: 0.01)
                        XCTAssertEqual(l.fadeMinX, l.rail.width - l.fadeWidth, accuracy: 0.01,
                            "the fade has to end exactly at the clip edge")
                    }
                }
            }
        }
    }

    /// And it is honest in the other direction, which the always-on mask was not: with
    /// two chips there is nothing after them, so dimming the tail of the row would say
    /// "there is more" about nothing — and a fully visible last chip would be dimmed for
    /// no reason if it happened to end inside the fade.
    func testAChipRowThatFitsGetsNoFadeAndNoTrailingInset() {
        for scale in [BoardBandBar.chipTypeScale(.large), BoardBandBar.chipTypeScale(.xxLarge)] {
            let l = rail.layout(
                container: inlineContainer, placement: .inlineRow,
                chips: shortChips, typeScale: scale
            )
            XCTAssertEqual(l.fadeWidth, 0, "scale=\(scale): a fade over empty rail")
            XCTAssertEqual(l.railTrailingContentInset, 0)
            XCTAssertEqual(l.fadeMinX, l.rail.width, accuracy: 0.01)
        }
        // No chips at all (a board with nothing on it) is the same answer.
        XCTAssertEqual(
            rail.layout(container: inlineContainer, placement: .inlineRow).fadeWidth, 0)
    }

    /// `overflows` is `peek` asked from the other end, which is what gives the peek
    /// arithmetic a live call site instead of a documented one: the rail reveals nothing
    /// past the content's own end exactly when the content is wider than the rail.
    func testOverflowIsThePeekPastTheContentsEnd() {
        let cardWidth: CGFloat = 370
        let railWidth = rail.railWidth(cardWidth: cardWidth)
        XCTAssertEqual(railWidth, 316, accuracy: 0.01)
        XCTAssertFalse(rail.overflows(contentWidth: railWidth - 1, cardWidth: cardWidth))
        XCTAssertTrue(rail.overflows(contentWidth: railWidth + 1, cardWidth: cardWidth))
        XCTAssertEqual(rail.peek(chipMinX: railWidth - 30, cardWidth: cardWidth), 30, accuracy: 0.01)
        XCTAssertEqual(rail.peek(chipMinX: railWidth + 30, cardWidth: cardWidth), 0,
            "a negative peek is not a peek")
        // An empty row does not "overflow into" a zero-width rail.
        XCTAssertFalse(rail.overflows(contentWidth: 0, cardWidth: cardWidth))
    }

    /// The trailing inset is what keeps the fade from being permanent: scrolled to the
    /// end, the last chip sits clear of the gradient instead of living under it.
    func testTheTrailingInsetLetsTheLastChipClearTheFade() {
        let l = rail.layout(
            container: inlineContainer, placement: .inlineRow, chips: longRailChips)
        XCTAssertGreaterThan(l.railTrailingContentInset, l.fadeWidth,
            "the last chip can never leave the gradient")
        XCTAssertEqual(l.railTrailingContentInset, l.fadeWidth + rail.chipSpacing, accuracy: 0.01)
    }

    /// The chip cap is where `minimumReadablePeek` is WIRED: no band name may be so wide
    /// that the chip after it could only ever show a dot.
    func testTheChipCapLeavesRoomForAReadablePeek() {
        for width in screenWidths {
            let l = layout(.inlineRow, screen: width)
            let showable = l.rail.width - rail.contentLeadingInset - rail.trailingFadeWidth
            XCTAssertLessThanOrEqual(
                l.chipMaxWidth,
                max(rail.minimumChipWidth, showable - rail.minimumReadablePeek) + 0.01,
                "screen=\(width): a chip this wide leaves the next one a sliver"
            )
            XCTAssertGreaterThanOrEqual(l.chipMaxWidth, rail.minimumChipWidth, "screen=\(width)")
            XCTAssertLessThan(l.chipMaxWidth, l.rail.width - rail.trailingFadeWidth,
                "screen=\(width): a chip that fills the rail leaves nothing to peek at")
        }
        XCTAssertGreaterThan(
            rail.layout(container: inlineContainer, placement: .inlineRow).chipMaxWidth, 120,
            "the cap must not truncate an ordinary band name at default type"
        )
    }

    /// The affordance has to be visible and small. The shipped 12pt at a 0.4 floor was
    /// judged absent on the real screen; a fade wider than the peek would hide the label
    /// it advertises.
    func testTheTrailingFadeIsVisibleButSmallerThanThePeek() {
        XCTAssertGreaterThan(rail.trailingFadeWidth, 12,
            "12pt at a 0.4 floor is the fade the review could not see")
        XCTAssertLessThan(rail.trailingFadeWidth, rail.minimumReadablePeek,
            "a fade wider than the peek erases the label it is advertising")
        XCTAssertLessThan(
            rail.trailingFadeWidth, rail.railWidth(cardWidth: 370) / 4,
            "the fade must not eat a quarter of the rail"
        )
    }

    /// The fade DIMS. Reaching zero alpha is what deleted "Backlog" and left a dot.
    func testTheFadeDimsThePeekingLabelInsteadOfErasingIt() {
        XCTAssertGreaterThanOrEqual(rail.trailingFadeFloor, 0.3,
            "at this alpha the peeking word is gone, which is the reported defect")
        XCTAssertLessThan(rail.trailingFadeFloor, 0.8,
            "a fade this solid stops reading as 'there is more' at all")
    }

    /// ...and then it runs OUT, which is the R27 half. Dimming to the floor and stopping
    /// there is still a hard cut: the mask ended at 0.35 and the next pixel was bare card,
    /// measured as an 18-lum vertical edge at x=331. The floor still owns most of the
    /// gradient (that is the readable fragment); only the tail goes to nothing.
    func testTheFadeRunsOutToNothingInsteadOfEndingOnAHardEdge() {
        XCTAssertGreaterThan(rail.trailingFadeTailWidth, 0,
            "a mask that stops at the floor is the hard edge the frame audit measured")
        XCTAssertLessThan(rail.trailingFadeTailWidth, rail.trailingFadeWidth / 2,
            "the dimmed-readable stretch has to stay the majority of the fade")

        let l = rail.layout(
            container: inlineContainer, placement: .inlineRow, chips: longRailChips)
        XCTAssertGreaterThan(l.fadeWidth, 0, "the fixture has to be a rail that overflows")
        XCTAssertEqual(
            l.fadeFloorLocation,
            Double((l.fadeWidth - rail.trailingFadeTailWidth) / l.fadeWidth),
            accuracy: 0.0001
        )
        XCTAssertGreaterThan(l.fadeFloorLocation, 0.5, "the floor must hold for most of the fade")
        XCTAssertLessThan(l.fadeFloorLocation, 1, "location 1 IS the hard cut this replaces")

        // No fade, no gradient: there is no floor to place, and 1 is the answer that keeps
        // the mask a plain solid rectangle.
        let fits = rail.layout(
            container: inlineContainer, placement: .inlineRow, chips: shortChips)
        XCTAssertEqual(fits.fadeWidth, 0)
        XCTAssertEqual(fits.fadeFloorLocation, 1, accuracy: 0.0001)
        // A fade narrower than its own tail degrades to a plain ramp, never a negative stop
        // (a gradient stop outside 0...1 is a rendering crash class).
        XCTAssertEqual(rail.fadeFloorLocation(fadeWidth: 2), 0, accuracy: 0.0001)
        XCTAssertEqual(rail.fadeFloorLocation(fadeWidth: 0), 1, accuracy: 0.0001)
    }

    // MARK: - The estimate the affordance is decided from

    /// The estimate is only useful if it does not UNDERSTATE a real chip: understating is
    /// how a rail that scrolls loses its fade. Checked against the one chip the review
    /// measured — `board.chip.backlog` [318,420], i.e. 102pt of dot + "Backlog" + count.
    ///
    /// # Asserted ONE-SIDEDLY, because the property is one-sided
    ///
    /// `chipLabelAdvance` is a GENEROUS estimate on purpose (see its own comment): the two
    /// ways to be wrong are not symmetric. Falling short hides the fade on a rail that
    /// really does scroll, which is the reported defect; running long can only dim a
    /// trailing strip that is empty anyway, and the fits-case is guarded by a real fixture
    /// (`testAChipRowThatFitsGetsNoFadeAndNoTrailingInset`) rather than by a number here.
    ///
    /// So this asserts a FLOOR and no ceiling. The `accuracy:` window it replaces was a
    /// symmetric claim the estimate never made — it failed a SAFER (wider) estimate exactly
    /// as loudly as an unsafe one, which is how a tolerance ends up getting tuned in place
    /// of a rule being stated. (The floor is not zero-slack: at default type this estimate
    /// comes out a few points UNDER the measured capsule, which is worth knowing and worth
    /// bounding, not worth hiding inside a ±20% window.)
    func testTheChipEstimateNeverFallsMeaningfullyShortOfTheMeasuredChip() {
        let measured: CGFloat = 102
        let estimate = rail.estimatedChipWidth(
            label: "Backlog", count: 23, hasDot: true, typeScale: 1, cardWidth: 370)
        XCTAssertGreaterThanOrEqual(
            estimate, measured * 0.9,
            "the estimate is \(estimate)pt against a measured \(measured)pt chip — this far short and a scrolling rail loses its fade"
        )
        // The `All` chip has no dot, so it must come out narrower than a band chip with
        // the same label length.
        XCTAssertLessThan(
            rail.estimatedChipWidth(
                label: "Backlog", count: 23, hasDot: false, typeScale: 1, cardWidth: 370),
            estimate
        )
        // And no estimate may exceed the cap the view actually applies.
        let cap = rail.chipMaxWidth(cardWidth: 370)
        XCTAssertEqual(
            rail.estimatedChipWidth(
                label: String(repeating: "wide band name ", count: 6), count: 1234,
                hasDot: true, typeScale: 1.31, cardWidth: 370),
            cap, accuracy: 0.01, "the estimate has to respect the chip cap"
        )
    }

    /// The estimate scales with type, and it is clamped where the CHIPS are clamped —
    /// otherwise the affordance would be decided at a size nothing renders at.
    func testTheTypeScaleClampsAtTheChipCap() {
        XCTAssertEqual(BoardBandBar.chipTypeScale(.large), 1.0, accuracy: 0.001)
        XCTAssertGreaterThan(BoardBandBar.chipTypeScale(.xxLarge), 1.0)
        for size in DynamicTypeSize.allCases where size >= BoardBandBar.chipTypeCap {
            XCTAssertEqual(
                BoardBandBar.chipTypeScale(size),
                BoardBandBar.chipTypeScale(BoardBandBar.chipTypeCap), accuracy: 0.001,
                "\(size) is drawn at the cap, so it must be estimated at the cap"
            )
        }
        var previous: CGFloat = 0
        for size in DynamicTypeSize.allCases {
            let scale = BoardBandBar.chipTypeScale(size)
            XCTAssertGreaterThanOrEqual(scale, previous, "\(size) shrank the chips")
            previous = scale
        }
        XCTAssertEqual(BoardBandBar.chipTypeCap, DynamicTypeSize.xxLarge)
        XCTAssertLessThan(BoardBandBar.chipTypeCap, DynamicTypeSize.accessibility3,
            "the cap is what keeps a 65pt chip out of a 44pt bar")
    }

    // MARK: - The hairline (review item 4)

    /// It stopped 11.7pt short of the card on each side, because it was drawn as a row
    /// CONTENT sibling and took the row's insets. It is inside the card's own background
    /// bounds now, so its width IS the card's.
    func testTheHairlineSpansTheWholeCardOnBothCopies() {
        for width in screenWidths {
            for placement in BoardBandBarPlacement.allCases {
                let l = layout(placement, screen: width)
                XCTAssertEqual(l.hairline.minX, 0, accuracy: 0.01,
                    "the hairline is stated in the card's own space, so it starts at its edge")
                XCTAssertEqual(l.hairline.width, l.card.width, accuracy: 0.01,
                    "screen=\(width) \(placement): the hairline stops short of the card")
                XCTAssertEqual(l.hairline.maxY, l.card.height, accuracy: 0.01, "it is the BOTTOM edge")
                XCTAssertEqual(l.hairline.height, rail.separatorHeight, accuracy: 0.01)
            }
        }
        // The measured defect: 11.7pt short on each side of the 370pt card.
        let shipped = inlineContainer - 2 * 11.7
        let l = rail.layout(container: inlineContainer, placement: .inlineRow)
        XCTAssertGreaterThan(l.hairline.width, shipped,
            "if this passes, the hairline is still row content")
    }

    func testTheHairlineIsAHairlineAndNotARule() {
        XCTAssertGreaterThan(rail.separatorHeight, 0, "an invisible separator is not a separator")
        XCTAssertLessThanOrEqual(rail.separatorHeight, 1,
            "anything thicker than a hairline is the stray vertical rule's cousin")
        XCTAssertLessThan(rail.separatorHeight, TasksChromeMetrics.bandBar / 4)
    }

    // MARK: - Degenerate widths

    func testAVeryNarrowContainerDegradesToEmptyRatherThanNegative() {
        for placement in BoardBandBarPlacement.allCases {
            let l = rail.layout(container: 10, placement: placement, chips: tierChips)
            for rect in [l.card, l.rail, l.filters, l.hairline] {
                XCTAssertGreaterThanOrEqual(rect.width, 0, "\(placement): a negative frame is a crash class")
                XCTAssertGreaterThanOrEqual(rect.height, 0, "\(placement)")
            }
            XCTAssertGreaterThanOrEqual(l.chipMaxWidth, rail.minimumChipWidth, "\(placement)")
            XCTAssertGreaterThanOrEqual(l.fadeWidth, 0, "\(placement)")
            XCTAssertLessThanOrEqual(l.fadeWidth, l.rail.width,
                "\(placement): the fade cannot be wider than the rail it masks")
            XCTAssertGreaterThanOrEqual(l.railTrailingContentInset, 0, "\(placement)")
            // A gradient stop outside 0...1 is a rendering crash class, and a 10pt
            // container is exactly where the fade gets narrower than its own tail.
            XCTAssertGreaterThanOrEqual(l.fadeFloorLocation, 0, "\(placement)")
            XCTAssertLessThanOrEqual(l.fadeFloorLocation, 1, "\(placement)")
        }
    }

    // MARK: - Chip label contrast (WCAG, over the measured capsule)

    /// WCAG relative luminance of a neutral grey given as 0-255.
    private func luminance(gray: Double) -> Double {
        let channel = gray / 255
        return channel <= 0.03928
            ? channel / 12.92
            : pow((channel + 0.055) / 1.055, 2.4)
    }

    private func contrast(_ foregroundGray: Double, _ backgroundGray: Double) -> Double {
        let a = luminance(gray: foregroundGray) + 0.05
        let b = luminance(gray: backgroundGray) + 0.05
        return max(a, b) / min(a, b)
    }

    /// Black ink at `alpha` composited over the capsule.
    private func ink(alpha: Double, over backgroundGray: Double) -> Double {
        backgroundGray * (1 - alpha)
    }

    /// The capsule an unselected chip's label actually sits on, in light mode, taken from the
    /// app's own colour rather than typed once.
    ///
    /// R30 replaced `.quaternary` here with an explicit opaque fill, because a material is a
    /// function of its backdrop and the two copies of this bar therefore drew the same chip
    /// with different pixels (209 inline against 222 pinned). The WCAG math below has to
    /// follow that fill: derived, a taste change to the capsule RE-RUNS the contrast check;
    /// hard-coded, it would quietly go on checking a colour the app no longer draws.
    private var capsuleGray: Double {
        resolvedGray(BoardBandBar.unselectedChipFillColor, dark: false)
    }

    /// The `.quaternary` capsule as it MEASURED when the unreadable label was reported (202
    /// in light mode). This one stays a literal on purpose: it is the historical backdrop the
    /// report reproduces against, and it no longer exists in the app to be read from.
    private let reportedQuaternaryGray: Double = 202

    /// The defect: `Color.secondary` on that capsule measured (112,114,110) — a 3.0:1
    /// ratio for a label whose whole job is to be read at a glance, with the count taking
    /// a further 0.7 opacity on top of it.
    func testTheShippedUnselectedChipInkReallyWasBelowTheFloor() {
        let capsuleGray = reportedQuaternaryGray
        let shippedAlpha = 1 - (113.0 / capsuleGray)     // the measured composite
        let ratio = contrast(ink(alpha: shippedAlpha, over: capsuleGray), capsuleGray)
        XCTAssertEqual(ratio, 3.0, accuracy: 0.25, "the fixture no longer reproduces the report")
        XCTAssertLessThan(ratio, 4.5)
    }

    func testUnselectedChipLabelAndCountBothClearFourAndAHalf() {
        let label = contrast(
            ink(alpha: BoardBandBar.chipLabelOpacity, over: capsuleGray), capsuleGray)
        XCTAssertGreaterThanOrEqual(label, 4.5, "unselected chip label at \(label):1")

        let count = contrast(
            ink(alpha: BoardBandBar.chipCountOpacity, over: capsuleGray), capsuleGray)
        XCTAssertGreaterThanOrEqual(count, 4.5, "unselected chip count at \(count):1")
    }

    /// The hierarchy survives the fix: the count stays quieter than the label, and
    /// neither is the full-strength ink the SELECTED chip uses.
    func testTheChipsInkKeepsItsHierarchy() {
        XCTAssertLessThan(BoardBandBar.chipCountOpacity, BoardBandBar.chipLabelOpacity,
            "the count must stay the quieter of the two")
        XCTAssertLessThan(BoardBandBar.chipLabelOpacity, 1.0,
            "full-strength ink is the selected chip's, and the difference is the hierarchy")
        XCTAssertGreaterThan(BoardBandBar.chipCountOpacity, 0.6,
            "this is where the old 0.7 multiplier used to land the digits")
    }

    // MARK: - The card's surface, per colour scheme (R27)

    /// 0-255 grey of a dynamic colour resolved for one scheme. The bar's surfaces are all
    /// neutral, so the channel average is the whole story — and it asserts OPACITY on the
    /// way past, which is the actual defect for both of them.
    private func resolvedGray(_ color: UIColor, dark: Bool) -> Double {
        let resolved = color.resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&r, green: &g, blue: &b, alpha: &a),
            "dark=\(dark): the surface must be a plain RGB colour")
        XCTAssertEqual(Double(a), 1, accuracy: 0.001,
            "dark=\(dark): a surface under a MATERIAL has to be opaque, or the material is still see-through")
        return Double(r + g + b) / 3 * 255
    }

    /// The card reads as a surface against the board's page in BOTH schemes now (R29).
    ///
    /// This test used to be one-sided — light mode got a card that stepped DOWN from the
    /// white board sheet (measured: bare material 247.6 against a 253.0 page, a 5.4 delta
    /// that read as nothing, fixed by dropping to 242) and dark mode was deliberately left
    /// at the page colour itself, because a material over black already read at 26.1.
    ///
    /// R29 moved the OTHER half of the pair: the board's page is `systemGroupedBackground`,
    /// so the old light base (242) became the page's own colour and the old dark base
    /// (black) already was. Keeping either would have re-created the 2026-08-30 defect from
    /// the opposite direction. The bar takes the band cards' colour instead, which steps UP
    /// from the page in both schemes — so the assertion is symmetric, and the DIRECTION is
    /// pinned too: a card darker than its page reads as a hole.
    func testTheCardBaseReadsAsASurfaceAgainstTheGroupedPageInBothSchemes() {
        for dark in [false, true] {
            let page = resolvedGray(BoardBandCard.pageColor, dark: dark)
            let card = resolvedGray(BoardBandBar.cardBaseColor, dark: dark)
            XCTAssertGreaterThan(
                card - page, 5.4,
                "dark=\(dark): the card is \(card - page) grey from the page — the measured delta that read as nothing was 5.4"
            )
            XCTAssertLessThan(
                card - page, 60,
                "dark=\(dark): a card this far from the page stops being chrome and becomes a banner"
            )
        }
        // And it is the BAND cards' colour, not a second one that happens to pass the delta
        // above: the bar sits in that stack, so a private value would drift out of it.
        XCTAssertEqual(BoardBandBar.cardBaseColor, BoardBandCard.surfaceColor)
    }

    /// The FILTERS control's own base, which is the other half of "opaque": the
    /// `.thickMaterial` it used to wear is not opaque in light mode and chips ghosted
    /// through the button that is supposed to be detached from them. It also has to differ
    /// from the card in EVERY scheme, or the control stops reading as its own object
    /// sitting ON the card — which is why this is a loop now: R29 made the card white in
    /// light mode, and the control's old `systemBackground` was white too.
    func testTheFiltersControlHasAnOpaqueBaseThatStillReadsAgainstTheCard() {
        for dark in [false, true] {
            // `resolvedGray` asserts opacity; this is the call that makes it about the
            // control rather than the card.
            let control = resolvedGray(BoardBandBar.filtersControlBaseColor, dark: dark)
            let card = resolvedGray(BoardBandBar.cardBaseColor, dark: dark)
            XCTAssertGreaterThan(
                abs(control - card), 5.4,
                "dark=\(dark): the control is \(abs(control - card)) grey from the card it sits on — the same flat surface"
            )
        }
    }

    // MARK: - Reaching both filters at every type size (R27)

    /// A `Menu` does not scroll. At accessibility-XXL the two grouping rows filled the
    /// screen and pushed the Dates section off it, so `board.date.now` was absent from the
    /// hierarchy entirely at XXXL — a control that exists and cannot be reached. Above the
    /// accessibility sizes the same values are presented as a sheet, whose `List` scrolls.
    func testTheFiltersArePresentedInSomethingThatScrollsAtAccessibilitySizes() {
        for size in DynamicTypeSize.allCases {
            let presentation = BoardBandBar.filtersPresentation(size)
            if size.isAccessibilitySize {
                XCTAssertEqual(
                    presentation, .sheet,
                    "\(size): a menu cannot scroll, so a value below the fold is unreachable"
                )
            } else {
                XCTAssertEqual(
                    presentation, .menu,
                    "\(size): everything fits, and a modal sheet for a two-value filter is a worse answer"
                )
            }
        }
        // The values, and the identifiers shipped flows tap, are the SAME either way —
        // the presentation is the only thing the type size is allowed to change.
        XCTAssertEqual(BoardGrouping.allCases.map(\.rawValue), ["tier", "project"])
        XCTAssertEqual(BoardDateFilter.allCases.map(\.rawValue), ["all", "now"])
        // And the chips are capped BELOW the switch, so the sheet's own rows are the only
        // place an accessibility size is rendered at full size in this bar.
        XCTAssertFalse(
            BoardBandBar.chipTypeCap.isAccessibilitySize,
            "if the chip cap were an accessibility size, the menu would have to serve them too"
        )
    }
}
