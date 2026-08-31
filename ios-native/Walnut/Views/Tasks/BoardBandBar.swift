import SwiftUI

/// Which of the two places the band bar is drawn in.
///
/// It decides EXACTLY ONE thing: whether the card has to inset itself from the
/// container it was handed. Everything else — rail width, chip positions, the fade,
/// the hairline, the corner radius, the surface under the material — is computed from
/// the resulting CARD width or is flatly the same in both copies, so the two cannot
/// disagree about anything the user can see. See `BoardBandRailGeometry.cardInset`.
enum BoardBandBarPlacement: CaseIterable {
    /// An ordinary List row. The inset-grouped List has ALREADY inset the row
    /// (measured 2026-08-30: x 16..386 of a 402pt screen, i.e. a 370pt container).
    case inlineRow
    /// An overlay on the List's own bounds, so it is handed the full width (402pt)
    /// and applies the card inset itself.
    case pinnedOverlay
}

/// The band bar's geometry, as ONE value shared by both copies.
///
/// # The defect this shape exists to make impossible (R26)
///
/// "Both copies are built from one configuration" was true and still shipped a
/// visible jump, because the two copies are handed DIFFERENT CONTAINERS: the inline
/// List row lays out in 370pt (x 16..386, the inset-grouped card) while the pinned
/// overlay lays out edge-to-edge in 402pt. One configuration applied to two
/// containers is two layouts — measured, the rails differed (338 vs 354), every chip
/// jumped 16pt left at the pin flip, and the PINNED copy's rail still ran under
/// `board.filters`.
///
/// So the entry point is `layout(container:placement:chips:typeScale:)`, and the
/// container is an INPUT. Both copies resolve to the same 370pt card at the same
/// screen x, which is what makes the flip pixel-invariant instead of a promise.
///
/// # The two axes R26 did not cover, and R27 did
///
/// The horizontal fix held (the frame audit walked 983 fling frames and 993 slow-drag
/// frames with the chip leading x constant), and the same audit then measured the flip
/// on the OTHER two axes:
///
///  - Y: the pin fired `TasksChromeMetrics.listHeaderPadding` short of the offset where
///    the inline row's top reaches the pinned copy's resting y, so the bar hopped 10.66pt
///    up between two frames. Fixed where it belongs — the threshold is now DERIVED from
///    the layout numbers (`TasksChromeMetrics.chipsPinThreshold`), not tuned.
///  - STYLE: the inline row is clipped by its inset-grouped section to a 10pt rounded
///    rect while the pinned copy drew a square one, and the pinned copy's translucent
///    material picked up whatever was behind it, which moved the capsule-vs-background
///    contrast from 43.5 to 17.1 lum at the flip. So the radius is a LAYOUT FIELD (the
///    flip tests compare it) and the card carries its own opaque base under the material.
///
/// # What the accessibility rects can and cannot say
///
/// A chip inside a horizontal `ScrollView` ALWAYS reports its unclipped, virtual
/// frame, so "no a11y rect intersects the button" is physically unsatisfiable and is
/// NOT the criterion any more. The two criteria that are real:
///
///  - PIXELS: the rail's viewport (`layout.rail`) and the filters control
///    (`layout.filters`) are disjoint with a stated gap, and the rail is clipped to
///    its viewport, so no chip pixel can render under or beside the button.
///  - TAPS: the rail also carries `contentShape` on the clipped bounds, so a touch
///    outside the viewport is not the rail's to answer, and `chipActivationX` puts an
///    assistive activation inside the part of the chip the rail is showing.
struct BoardBandRailGeometry: Hashable {

    // MARK: - The card

    /// Inset the PINNED copy applies so its card matches the inline row's.
    ///
    /// Measured, not guessed: the inline row reported x 16..386 on a 402pt screen. The
    /// app ships iPhone-only (`TARGETED_DEVICE_FAMILY = 1`), where the inset-grouped
    /// card inset is this constant on every width.
    var cardHorizontalInset: CGFloat = 16

    /// Corner radius of the card, in BOTH copies.
    ///
    /// Measured, not chosen: the INLINE row is clipped by its inset-grouped section
    /// whether it asks to be or not, so a pinned copy that draws a square card pops its
    /// corners at the flip (measured 2026-08-30: rounded → square). The card clips itself
    /// to this radius, which makes the two agree by construction and makes the radius a
    /// field of `BoardBandBarLayout` — so a future "the pinned one should be square" fails
    /// the flip tests instead of shipping.
    ///
    /// The VALUE comes from `BoardBandCard` now (R29), because it is no longer only about
    /// these two copies agreeing with each other: the bar sits in a stack of band cards
    /// that the OS rounds, and 10pt among 20pt cards is the "not one system" look this
    /// restyle exists to remove. Still a `var`, so a test can square it off and prove the
    /// flip assertions would catch that.
    var cardCornerRadius: CGFloat = BoardBandCard.cornerRadius

    // MARK: - The trailing column the filters control owns

    /// Diameter of the control's own circular background.
    var filtersControlWidth: CGFloat = 34
    /// Height of that circle (the TAP target is the bar's full height).
    var filtersControlHeight: CGFloat = 34
    /// Gap between the control and the card's trailing edge.
    var filtersTrailingInset: CGFloat = 10
    /// REAL gap between what the chip rail can show and the control.
    ///
    /// The R25 value was 4, which is why a chip cut flat by the clip edge still read as
    /// part of the button's cluster and why a thumb aimed at the last chip caught the
    /// menu. 10 is above the 8pt floor `TasksBoardChipRowTests` pins, and it is empty
    /// card material: nothing draws in it.
    var railSpacing: CGFloat = 10

    // MARK: - The chip rail's own metrics

    /// Leading gutter of the scroll content.
    var contentLeadingInset: CGFloat = 10
    /// Gap between chips.
    var chipSpacing: CGFloat = 5
    /// A chip's horizontal padding.
    var chipPaddingH: CGFloat = 8
    /// A chip's vertical padding.
    var chipPaddingV: CGFloat = 6
    /// Space between a chip's dot, label and count.
    var chipInnerSpacing: CGFloat = 4
    /// The band-colour dot on a band chip (the `All` chip has none).
    var chipDotDiameter: CGFloat = 6

    /// Width of the trailing fade that says "there are more chips".
    ///
    /// 20, up from 12. At 12 with a 0.4 floor the affordance was invisible on the
    /// build: under "By project" (~30 bands) the rail simply stopped flat, with no hint
    /// that anything followed. It still has to stay under `minimumReadablePeek` or the
    /// fade covers the whole fragment it is advertising.
    var trailingFadeWidth: CGFloat = 20

    /// The fade DIMS, it does not erase. A mask that reaches zero alpha deletes the
    /// peeking chip's label, which is how "Backlog" became an anonymous sliver.
    var trailingFadeFloor: Double = 0.35

    /// The last few points of the fade, where the mask runs from `trailingFadeFloor`
    /// to nothing.
    ///
    /// Dimming to a floor and then STOPPING is still a hard edge: the mask ended at 0.35
    /// and the next pixel was bare card, which the frame audit measured as an 18-lum
    /// vertical edge at x=331. This tail is what makes the dimmed fragment meet the card
    /// material instead of being cut off against it. Deliberately a small fraction of
    /// `trailingFadeWidth`: the fragment has to stay READABLE, so the floor still owns
    /// most of the gradient.
    var trailingFadeTailWidth: CGFloat = 4

    /// How much of the next chip the rail must be able to reveal for the affordance to
    /// be a readable partial label rather than a dot.
    ///
    /// WIRED, not documented: `chipMaxWidth` subtracts it, so no single band name can
    /// be wide enough to leave the following chip a sliver.
    var minimumReadablePeek: CGFloat = 28

    /// No single chip may take more than this share of what the rail can show.
    var chipWidthFraction: CGFloat = 0.55

    /// Floor under that cap, so a narrow bar still draws a chip rather than a sliver.
    var minimumChipWidth: CGFloat = 72

    /// Where a tap on a chip is DELIVERED, as a fraction of the capsule's width.
    ///
    /// The leading tenth, not the middle: a chip partly scrolled out of the rail still
    /// reports its full frame, so the centre of `board.chip.backlog` [318,420] was
    /// x=369 — past the rail. Assistive technology and XCUITest activate an element at
    /// its activation point, so pinning that point near the capsule's leading edge
    /// lands the tap on the part of the chip that IS inside the rail.
    var chipActivationX: CGFloat = 0.1

    /// The bar's bottom hairline. Same 0.5pt the board's row separators use.
    var separatorHeight: CGFloat = 0.5

    // MARK: - Estimating the content width (the honest scroll affordance)

    /// Per-character advance of a chip label at default type, footnote/semibold.
    ///
    /// Deliberately generous. The affordance is decided from this estimate, and the two
    /// ways to be wrong are not symmetric: understating the content hides the fade on a
    /// rail that really does scroll (the reported defect), while overstating it can only
    /// dim a trailing strip that is empty anyway.
    var chipLabelAdvance: CGFloat = 7.6
    /// Per-digit advance of the monospaced count.
    var chipCountAdvance: CGFloat = 6.8

    /// The one configuration in the app. Both copies read it.
    static let standard = BoardBandRailGeometry()

    // MARK: - Layout arithmetic (all of it called by the body)

    /// How far in from its container the card starts.
    func cardInset(placement: BoardBandBarPlacement) -> CGFloat {
        switch placement {
        case .inlineRow: return 0
        case .pinnedOverlay: return cardHorizontalInset
        }
    }

    /// The whole trailing column the filters control reserves for itself.
    var filtersColumnWidth: CGFloat { filtersControlWidth + filtersTrailingInset }

    /// Width of the scrollable chip rail inside a card of `cardWidth`.
    func railWidth(cardWidth: CGFloat) -> CGFloat {
        max(0, cardWidth - filtersColumnWidth - railSpacing)
    }

    /// Leading x of the filters control inside a card of `cardWidth`.
    func filtersColumnMinX(cardWidth: CGFloat) -> CGFloat {
        max(0, cardWidth - filtersColumnWidth)
    }

    /// How much of the rail is left past `chipMinX` — i.e. how much of a chip starting
    /// there the rail can reveal. Zero is an honest answer: nothing shows.
    func peek(chipMinX: CGFloat, cardWidth: CGFloat) -> CGFloat {
        max(0, railWidth(cardWidth: cardWidth) - chipMinX)
    }

    /// Does the chip row overflow the rail?
    ///
    /// Stated through `peek`, because "is there anything to scroll to" is the same
    /// question as "does the rail reveal anything past the content's own end".
    func overflows(contentWidth: CGFloat, cardWidth: CGFloat) -> Bool {
        contentWidth > 0 && peek(chipMinX: contentWidth, cardWidth: cardWidth) <= 0
    }

    /// The widest a single chip may draw inside a card of `cardWidth`.
    ///
    /// Two bounds, and the second is what wires `minimumReadablePeek`: a chip may not
    /// be so wide that the chip after it could only ever show a dot.
    func chipMaxWidth(cardWidth: CGFloat) -> CGFloat {
        let showable = railWidth(cardWidth: cardWidth) - contentLeadingInset - trailingFadeWidth
        return max(minimumChipWidth, min(showable * chipWidthFraction, showable - minimumReadablePeek))
    }

    /// Rough width of one chip's capsule at `typeScale`, capped the way the view caps it.
    func estimatedChipWidth(
        label: String, count: Int, hasDot: Bool, typeScale: CGFloat, cardWidth: CGFloat
    ) -> CGFloat {
        var width = 2 * chipPaddingH
        if hasDot { width += chipDotDiameter + chipInnerSpacing }
        width += CGFloat(label.count) * chipLabelAdvance * typeScale
        width += chipInnerSpacing
            + CGFloat(max(1, String(count).count)) * chipCountAdvance * typeScale
        return min(chipMaxWidth(cardWidth: cardWidth), width)
    }

    /// Rough width of the whole chip row, WITHOUT the trailing inset the affordance
    /// adds — so switching the affordance on can never be what makes it overflow.
    func estimatedContentWidth(
        chips: [BoardModel.BandChip], typeScale: CGFloat, cardWidth: CGFloat
    ) -> CGFloat {
        guard !chips.isEmpty else { return 0 }
        var total = contentLeadingInset
        for (index, chip) in chips.enumerated() {
            if index > 0 { total += chipSpacing }
            total += estimatedChipWidth(
                label: chip.label, count: chip.count, hasDot: chip.bandId != nil,
                typeScale: typeScale, cardWidth: cardWidth
            )
        }
        return total
    }

    /// THE layout entry point. Every rect the body places from comes from here, so a
    /// test can feed the two real containers (370 inline, 402 pinned) and compare.
    ///
    /// `card` is stated in the CONTAINER's space; `rail`, `filters` and `hairline` are
    /// stated in the CARD's space, which is the space their views live in.
    func layout(
        container: CGFloat,
        placement: BoardBandBarPlacement,
        chips: [BoardModel.BandChip] = [],
        typeScale: CGFloat = 1
    ) -> BoardBandBarLayout {
        let inset = cardInset(placement: placement)
        let cardWidth = max(0, container - 2 * inset)
        let height = TasksChromeMetrics.bandBar
        let rail = railWidth(cardWidth: cardWidth)
        let content = estimatedContentWidth(
            chips: chips, typeScale: typeScale, cardWidth: cardWidth
        )
        let fade = overflows(contentWidth: content, cardWidth: cardWidth)
            ? min(trailingFadeWidth, rail)
            : 0
        return BoardBandBarLayout(
            card: CGRect(x: inset, y: 0, width: cardWidth, height: height),
            cardCornerRadius: cardCornerRadius,
            rail: CGRect(x: 0, y: 0, width: rail, height: height),
            filters: CGRect(
                x: filtersColumnMinX(cardWidth: cardWidth), y: 0,
                width: filtersControlWidth, height: height
            ),
            hairline: CGRect(
                x: 0, y: height - separatorHeight,
                width: cardWidth, height: separatorHeight
            ),
            chipMaxWidth: chipMaxWidth(cardWidth: cardWidth),
            // The last chip has to be able to scroll CLEAR of the fade, or the
            // affordance permanently eats the end of the row it advertises.
            railTrailingContentInset: fade > 0 ? fade + chipSpacing : 0,
            fadeWidth: fade,
            fadeFloorLocation: fadeFloorLocation(fadeWidth: fade)
        )
    }

    /// Where in the fade the mask reaches `trailingFadeFloor`, as a unit fraction of the
    /// gradient. Everything past it is the tail that runs to nothing.
    ///
    /// 1 when there is no fade (a mask with no gradient has no floor to place), and
    /// clamped so a fade narrower than its own tail degrades to a plain ramp rather than
    /// a negative stop.
    func fadeFloorLocation(fadeWidth: CGFloat) -> Double {
        guard fadeWidth > 0 else { return 1 }
        return Double(max(0, fadeWidth - trailingFadeTailWidth) / fadeWidth)
    }
}

/// Every rect and cap the bar draws with, for one container and one placement.
///
/// A value rather than a pile of call sites so the pin flip is checkable: two
/// placements, two containers, ONE of these.
struct BoardBandBarLayout: Equatable {
    /// The card, in the container's space. `minX` is the inset the placement owes.
    let card: CGRect
    /// Corner radius the card clips itself to. A FIELD rather than a constant read at the
    /// draw site, because that is what puts it inside `drawnInCardSpace` and therefore
    /// inside the flip tests: the pinned copy drew a square card against the inline row's
    /// 10pt rounded one, and nothing failed.
    let cardCornerRadius: CGFloat
    /// The chip rail's viewport, in the card's space. Also the clip AND hit-test bounds.
    let rail: CGRect
    /// The filters control's tap target, in the card's space.
    let filters: CGRect
    /// The bottom hairline, in the card's space — full card width, because it is drawn
    /// inside the card's own background rather than as a List row sibling.
    let hairline: CGRect
    /// Widest a single chip may draw.
    let chipMaxWidth: CGFloat
    /// Trailing padding on the scroll CONTENT (not the viewport).
    let railTrailingContentInset: CGFloat
    /// Width of the trailing fade. ZERO when the chips fit: dimming the tail of a row
    /// that has nothing after it says "there is more" about nothing.
    let fadeWidth: CGFloat
    /// Unit fraction of the fade at which the mask reaches `trailingFadeFloor`; past it
    /// the mask runs to nothing so the strip meets the card material instead of ending on
    /// a hard edge. See `BoardBandRailGeometry.trailingFadeTailWidth`.
    let fadeFloorLocation: Double

    /// Where the fade starts inside the rail.
    var fadeMinX: CGFloat { max(0, rail.width - fadeWidth) }

    /// This layout with `card.minX` normalised away: everything the bar DRAWS, none of
    /// where its container happens to sit.
    ///
    /// The pin-flip invariant needs exactly this, because it is two claims and only one
    /// of them is equality: the drawn layout must be IDENTICAL between the copies, while
    /// `card.minX` must DIFFER by the inset (0 inline, 16 pinned) — that is the single
    /// number `placement` is allowed to reach, and it is what lands both cards on the
    /// same screen x from two different containers. Comparing whole layouts states the
    /// invariant wrong (it fails on the one field that is per-copy on purpose);
    /// re-listing the other six fields test by test states it in a way a newly added
    /// field silently escapes. So the projection is named here, once, and stays a
    /// whole-value `Equatable` compare: add a field to this struct and the flip tests
    /// pick it up for free.
    var drawnInCardSpace: BoardBandBarLayout {
        BoardBandBarLayout(
            card: CGRect(x: 0, y: card.minY, width: card.width, height: card.height),
            cardCornerRadius: cardCornerRadius,
            rail: rail,
            filters: filters,
            hairline: hairline,
            chipMaxWidth: chipMaxWidth,
            railTrailingContentInset: railTrailingContentInset,
            fadeWidth: fadeWidth,
            fadeFloorLocation: fadeFloorLocation
        )
    }
}

/// The board's band bar: one chip per band with its count, plus the grouping/date
/// filters in a detached control at its trailing edge.
///
/// # Why it exists, in the user's words
///
/// "Focus Satellite 应该做一个在最上面的,不应该是一个侧面的,在上面我可以直接选" —
/// the band switcher belongs across the TOP where it can be picked directly. It
/// replaced the right-edge letter rail (deleted; see the tombstone in
/// `TaskBoardList.swift`) and the old `BoardFilterBar` row, whose segmented controls
/// scrolled away with the content.
///
/// # It is row TWO, drawn in two places, and the two are now ONE CARD
///
/// The header order is: nav pills (row 1, scrolls away), then this bar (row 2, the
/// only row that pins). `TasksView` renders this view TWICE — as an ordinary content
/// row, and as a pinned overlay that stands in for that row once it reaches the top
/// edge (`TasksChromeMetrics.chipsPinThreshold`).
///
/// The two are still mutually EXCLUSIVE on screen, and that is now decided inside this
/// view (`drawsChips`) rather than by which copy `TasksView` chose to construct. Both
/// exist at all times; one is hidden. Two reasons, and the first is a shipped defect:
/// a conditionally inserted copy is a NEW view identity on every pin crossing, so each
/// crossing built a fresh `ScrollView` for the rail — and one that came up measured at
/// zero width stayed empty for the life of that instance, which is the "card and filter
/// button, no chips" bar the user screenshotted. The second is the hitch: the decision
/// reads `BoardChipsPinLatch` HERE, so a crossing re-renders 44pt of chrome instead of
/// invalidating `TasksView.body` and re-deriving the whole board.
///
/// The copies differ ONLY in the container they are handed, and that difference is the
/// whole R26 fix: the inline row gets the inset-grouped card's 370pt, the overlay gets
/// the List's 402pt, and `placement` tells the geometry which, so both resolve to the
/// same 370pt card starting at the same screen x. Before this the overlay laid out
/// edge-to-edge and the flip shifted every chip 16pt left.
///
/// Nothing else is per-copy — and "nothing else" is now three axes deep, because the
/// frame audit found the other two after R26 closed the first:
///
///  - same X (R26): `placement` → `cardInset`.
///  - same Y at the crossing (R27): `TasksChromeMetrics.chipsPinThreshold` is derived
///    from where this row actually sits in the content, so the hand-off happens on the
///    one frame where the two cards occupy the same screen rect.
///  - same STYLE (R27): one `cardCornerRadius`, one opaque `cardSurface`, one hairline,
///    and NO shadow on the pinned one (a shadow would be the one property that still
///    popped at the crossing).
///
/// The pinned copy stays an OVERLAY, never a `safeAreaInset`: this app has shipped the
/// scroll-jump bug, where something appearing in the layout flow changes the List's
/// visible rect and yanks the content offset.
///
/// It used to draw bare `.bar` material "so a row sliding under it stays legible", and
/// that legibility was the defect: the material took its colour from whatever happened to
/// be behind it, so the capsule-vs-background contrast measured 43.5 lum inline and 17.1
/// pinned — the chips visibly changed weight at the flip. R27 put an opaque base under the
/// material; R29 dropped the material entirely and left the base (`cardSurface`, which is
/// the BAND CARDS' own colour), so the bar is one card among cards, a row cannot read
/// through it, and the chips read the same in both copies. A pinned header that a row
/// shows through was never worth a chip that changes contrast when you scroll.
///
/// # Merge point: the two filters live at the trailing edge, one tap deeper
///
/// Grouping (Tier | By project) and dates (All | Now) hold two values each and are set
/// once in a session; the band chips are tapped constantly. Rendering all four values
/// inline as capsules measured ~230pt of a 390pt screen, so the constant-use control
/// got the width and the rare one got a 34pt control.
///
/// `board.group.*` and `board.date.*` all still exist, verbatim, one tap deeper — and
/// that claim now covers EVERY TYPE SIZE, which is what it did not do when it was
/// written. A `Menu` does not scroll: at accessibility-XXL the two grouping rows filled
/// the screen and pushed the Dates section off it, so `board.date.now` was simply absent
/// from the hierarchy (measured at XXXL) with no gesture that could bring it back. At
/// every accessibility size the same values are presented as a SHEET instead, whose
/// `List` scrolls natively — same identifiers, same order, same checkmark. See
/// `filtersPresentation`.
struct BoardBandBar: View {
    /// Chips for the WHOLE board, including bands a selection is hiding: the counts
    /// have to keep saying what the board holds.
    let chips: [BoardModel.BandChip]
    /// The selected band id, or nil for `All`.
    let selected: String?
    @Binding var grouping: BoardGrouping
    @Binding var dateFilter: BoardDateFilter
    /// Band id to filter to, or nil for the whole board.
    let onSelect: (String?) -> Void
    /// Which copy this is. Read by `cardInset` and by `drawsChips`, and nothing else.
    let placement: BoardBandBarPlacement
    /// Whether row 2 has reached the top edge.
    ///
    /// READ HERE rather than in `TasksView.body`, on purpose: a pin crossing then
    /// invalidates the two bars instead of the whole List. See `BoardChipsPinLatch`.
    let pinLatch: BoardChipsPinLatch

    /// The ambient type size, read so the content-width estimate (and therefore the
    /// scroll affordance) tracks it. Clamped to `chipTypeCap`, which is what the chips
    /// themselves render at.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The widest type size the chips are allowed to grow to.
    ///
    /// The bar has a FIXED height in both places it is drawn, so the height is not free
    /// to grow. At accessibility-XXXL the chips measured 65pt against 44pt of material
    /// and painted onto the rows beneath. Of the two honest fixes (grow the bar, or cap
    /// the chip text) this is the cap: a band name survives at ~19pt, while an
    /// overflowing bar hides task rows. Everything the chip carries is still read at
    /// full size by VoiceOver.
    static let chipTypeCap: DynamicTypeSize = .xxLarge

    /// The bar's whole geometry. Deliberately not a parameter: a copy that could be
    /// configured differently is a copy that will be.
    static let rail = BoardBandRailGeometry.standard

    // MARK: - Which copy is showing (and the two ways of being empty)

    /// Does THIS copy show its chips right now?
    ///
    /// The two copies are mutually exclusive because they draw the same
    /// `board.chip.*` identifiers and two live copies make every chip ambiguous to
    /// automation. What changed is HOW: `TasksView` used to construct one copy or the
    /// other per pin state, and both are now always constructed while this decides
    /// which one is VISIBLE. That is the empty-pinned-bar fix — see `body`.
    ///
    /// `chipCount == 0` is the second half, and it is the reported symptom stated as
    /// a rule: a card with a filter button and a bare 316pt rail is worse than no
    /// card, because it says "this board has no bands" while the board below it has
    /// five. `BoardModel.chips` always emits the leading `All` chip, so on the board
    /// this branch is unreachable — which is exactly why it is written down instead of
    /// assumed (`TasksBoardChipRowTests` pins both halves).
    static func drawsChips(
        placement: BoardBandBarPlacement, pinned: Bool, chipCount: Int
    ) -> Bool {
        guard chipCount > 0 else { return false }
        switch placement {
        case .inlineRow: return !pinned
        case .pinnedOverlay: return pinned
        }
    }

    /// The narrowest container this bar will lay a scroll view into.
    ///
    /// A `GeometryReader` can report 0 on its first pass, and the rail's arithmetic is
    /// honest about that: `railWidth(cardWidth: 0)` is 0. The card and the filters
    /// control recover on the next pass because they are plain frames recomputed from
    /// `layout` every time; a `UIScrollView` born into a zero-width viewport does NOT
    /// — nothing in the old file re-established the rail's content afterwards, so the
    /// bar drew its card and its button with a mathematically flat, chipless rail
    /// (measured on the user's screenshot: rail region mean 250.0, std 0.84, i.e. bare
    /// card material) for the whole life of that instance.
    ///
    /// So a degenerate measurement is made UNRENDERABLE rather than unrecoverable: no
    /// scroll view is constructed until the width can hold one. The floor is the
    /// filters column plus the rail's spacing plus whatever the CARD's own side insets
    /// eat first, which is the width below which there is no rail to speak of anyway.
    ///
    /// It is per-placement because the card inset is: `layout` derives its card as
    /// `container - 2 * cardInset(placement:)`, so the inline copy (inset 0, the List
    /// already paid it) still has a real rail at a width where the pinned copy (inset
    /// 16 a side) has none. Writing one placement-agnostic floor made the two disagree
    /// with the arithmetic — the pinned number said "no rail below 86pt" while the
    /// inline copy at 85.5pt had 31.5pt of perfectly usable rail.
    static func minimumUsableContainer(_ placement: BoardBandBarPlacement) -> CGFloat {
        2 * rail.cardInset(placement: placement)
            + rail.filtersColumnWidth + rail.railSpacing
    }

    // MARK: - How the two filters are presented

    /// The two containers the filter VALUES can be shown in.
    enum FiltersPresentation {
        /// A `Menu`: one tap, no navigation, and no scrolling of any kind.
        case menu
        /// A sheet with a `List`: it scrolls, which is the entire reason it exists.
        case sheet
    }

    /// Menu or sheet, decided by the type size and nothing else.
    ///
    /// A `Menu` lays out every row and then shows whatever fits: at accessibility-XXL the
    /// two grouping rows filled the screen and the Dates section was pushed off it, so
    /// `board.date.now` was absent from the hierarchy entirely (measured at XXXL) with no
    /// gesture that could reach it. Folding two controls into one menu is what made that
    /// possible, and the honest fix is not "fold less" but "present it in something that
    /// scrolls".
    ///
    /// The switch is at `isAccessibilitySize` rather than at the exact size the defect was
    /// measured on: those sizes are where the rows get tall enough for the question to
    /// arise at all, and a sheet is a perfectly good answer at every one of them.
    static func filtersPresentation(_ size: DynamicTypeSize) -> FiltersPresentation {
        size.isAccessibilitySize ? .sheet : .menu
    }

    /// Open state of the accessibility-size sheet. Only ever true in the copy the user
    /// tapped, and the two copies are mutually exclusive, so there is never a second one.
    @State private var showFiltersSheet = false

    /// Text-scale factor for the chip metrics, clamped at the cap so an accessibility
    /// size estimates the same width the chips actually draw at. Footnote's own ramp
    /// (13 → 15 → 17pt).
    static func chipTypeScale(_ size: DynamicTypeSize) -> CGFloat {
        switch min(size, chipTypeCap) {
        case .xSmall, .small: return 0.85
        case .medium: return 0.92
        case .large: return 1.0
        case .xLarge: return 1.15
        default: return 1.31          // xxLarge and everything the cap folds into it
        }
    }

    // MARK: - Chip ink (contrast)

    /// Alpha of an unselected chip's label over the capsule's own fill
    /// (`unselectedChipFillColor`).
    ///
    /// `Color.secondary` measured (112,114,110) on (202,203,202) — 3.0:1, below the
    /// 4.5:1 a body-size label owes anyone reading it in daylight, and the count then
    /// took a further 0.7 opacity on top. Alpha on the label colour rather than a
    /// hand-picked grey, so the same number works in dark mode.
    static let chipLabelOpacity: Double = 0.78

    /// The count is quieter than the label but still legible.
    static let chipCountOpacity: Double = 0.70

    static var unselectedChipLabel: Color { Color(.label).opacity(chipLabelOpacity) }
    static var unselectedChipCount: Color { Color(.label).opacity(chipCountOpacity) }

    /// Ink strength of an UNSELECTED chip's capsule over the card, per scheme — the two
    /// numbers behind `unselectedChipFillColor`.
    ///
    /// Light is `label` (near-black) over the card's white, dark is `label` (near-white)
    /// over the card's near-black, so the same alpha does not mean the same step: 0.18 over
    /// white lands at 209 grey, while 0.18 over 28 lands at 69 — a far bigger PERCEIVED
    /// jump on a dark card. Dark takes 0.14 so both schemes read as "a quiet capsule on the
    /// card" rather than as one quiet and one bright.
    static let chipFillAlpha: (light: CGFloat, dark: CGFloat) = (0.18, 0.14)

    /// The unselected chip capsule's fill: ONE opaque colour, and the third fix of this
    /// exact defect class on this exact bar.
    ///
    /// It was `.quaternary`, a MATERIAL, and a material's rendered value depends on what is
    /// behind it — so the same chip measured (209,209,209) in the inline copy and
    /// (222,222,222) in the pinned overlay, i.e. the capsules visibly changed weight at the
    /// pin flip. That is the same defect the card's `.bar` material had (R27: 43.5 vs 17.1
    /// lum of capsule contrast) and the same one the row tint had inside a card (R29), which
    /// is why this one is not fixed with a different material: `.quaternary` →
    /// `.tertiary` → `.fill` are all values that resolve against a backdrop, so any of them
    /// would ship the same bug with a different number.
    ///
    /// An OPAQUE colour cannot: `label` at `chipFillAlpha` flattened onto the card
    /// (`BoardBandCard.flatten`) is one RGB value per scheme, identical in both copies by
    /// construction, and `TasksBoardChipRowTests` resolves it and asserts exactly that.
    /// It is composited off the CARD's colour rather than hand-picked, so when the card
    /// moves (it did, R29) the capsule follows instead of drifting.
    static let unselectedChipFillColor = UIColor { traits in
        BoardBandCard.flatten(
            UIColor.label.withAlphaComponent(
                traits.userInterfaceStyle == .dark ? chipFillAlpha.dark : chipFillAlpha.light
            ),
            over: cardBaseColor,
            traits: traits
        )
    }

    /// `unselectedChipFillColor` as the colour the capsule fills with.
    static let unselectedChipFill = Color(unselectedChipFillColor)

    // MARK: - The card's surface

    /// The OPAQUE base the card paints under its material, per colour scheme.
    ///
    /// Two defects, one fix. (1) The pinned copy's `.bar` material took its colour from
    /// whatever was behind it, so the same chips measured 43.5 lum of capsule contrast
    /// inline and 17.1 pinned — the flip changed the chips' weight. (2) In LIGHT mode the
    /// bare material measured 247.6 against the board's 253.0 page, a 5.4 delta: the card
    /// barely read as a surface at all.
    ///
    /// R29 REVERSES THE DIRECTION OF THE STEP, and it had to. The fix above stepped DOWN
    /// from a white page (`secondarySystemBackground`, 242) because the board's page was
    /// white. The board's page is `systemGroupedBackground` now — which in light mode is
    /// that very same 242 — so keeping the old base would have made the bar's card
    /// invisible, the exact defect it was written to fix, arrived at from the other side.
    /// Dark mode is the same story: the old base was `systemBackground` (black) and the
    /// page is black too.
    ///
    /// So the bar takes the BAND CARDS' own surface, and the delta comes for free in both
    /// schemes (+11.3 light, +28.7 dark, measured): one card colour on the board means the
    /// chips bar reads as another card in the same stack instead of as a bespoke panel.
    ///
    /// It also loses its `dark:` parameter in the move, and that is not tidying: a
    /// per-scheme FUNCTION was how the light/dark asymmetry above was expressed, and
    /// keeping one that ignored its argument would leave a knob that looks like it decides
    /// something. One dynamic colour answers both schemes; a test resolves it per scheme.
    static let cardBaseColor: UIColor = BoardBandCard.surfaceColor

    /// `cardBaseColor` as the dynamic colour the card actually fills with.
    static let cardSurface = Color(cardBaseColor)

    /// The FILTERS control's own circle, and the whole of it (the `.thickMaterial` that
    /// used to ride over this base went with the card's material, R29).
    ///
    /// Opaque, because the material was not in light mode and chips ghosted through the
    /// button that is supposed to be detached from them. And it has to differ from
    /// `cardBaseColor`, or the control stops reading as its own object sitting ON the card.
    ///
    /// R29 flips which way it differs. It was `systemBackground` (white) because the card
    /// stepped DOWN from a white page; the card IS white in light mode now, so white would
    /// dissolve the control into it. `tertiarySystemGroupedBackground` is the platform's
    /// next step in the grouped family: 242 on a 255 card in light, 44 on a 28 card in
    /// dark — a visible step in both, and in the same direction as every other recessed
    /// control the OS draws inside a grouped card.
    static let filtersControlBaseColor: UIColor = .tertiarySystemGroupedBackground

    /// `filtersControlBaseColor` as the colour the circle fills with.
    static let filtersControlSurface = Color(filtersControlBaseColor)

    var body: some View {
        // The pin state is read HERE, in the bar's own body, and NOT inside the
        // `GeometryReader` below. Two reasons, and the second one is a bug that would
        // have been invisible:
        //
        //  - It is what registers the Observation dependency in THIS view rather than in
        //    `TasksView.body`, which is the whole point of the latch (a crossing costs
        //    44pt of chrome, not a board derive plus a List diff).
        //  - A `GeometryReader`'s content closure is evaluated during LAYOUT, in its own
        //    subgraph. Reading an observable there is betting that the dependency is
        //    registered for a body that has already returned — and if that bet is wrong
        //    the bar simply never swaps, which looks exactly like the empty-bar defect
        //    this round is fixing. Reading it up here needs no bet.
        let pinned = pinLatch.isPinned
        // The bar measures its CONTAINER once and hands the width to the arithmetic. A
        // `GeometryReader` is safe here precisely because the height is fixed: it fills
        // the proposal and never asks its content how tall to be, so there is no layout
        // feedback to converge.
        return GeometryReader { geo in
            // The EMPTY PINNED BAR fix, in two halves.
            //
            // (1) A degenerate width builds no scroll view at all
            //     (`minimumUsableContainer`).
            //
            // (2) Once built, this instance is never thrown away by a pin crossing.
            //     `TasksView` constructs BOTH copies unconditionally now and this
            //     decides which is visible, so each copy holds exactly ONE
            //     `UIScrollView` whose content is established once. The old shape
            //     inserted the pinned copy conditionally, so every crossing
            //     constructed a brand-new `ScrollViewReader`/`ScrollView` — and
            //     `reveal()`, the only thing that touches the rail's content
            //     position, was wired to selection/grouping/appear and nothing else,
            //     so a scroll view that came up wrong stayed wrong until the overlay
            //     was destroyed again.
            //
            // Hidden rather than absent: `.opacity(0)` keeps the frame (this row's
            // height is fixed on purpose — a row that changed height mid-scroll moves
            // every row under it) and `allowsHitTesting(false)` keeps the invisible copy
            // from eating taps meant for the rows beneath the overlay.
            //
            // Keeping it out of the ACCESSIBILITY TREE takes both halves, and R29 shipped
            // only one of them: `.accessibilityHidden(!drawing)` on the outside of a
            // subtree whose own root says `.accessibilityElement(children: .contain)` does
            // NOT remove the contained descendants — the hierarchy dump had two
            // `board.bandBar`s and two `board.filters` at rest, the hidden copy sitting at
            // [16,0]. A container that CONTAINS re-publishes its children whatever the
            // wrapper says. So the fold is decided inside `card`, by the same `drawing`
            // flag: `.contain` while it is the live copy, `.ignore` while it is not, which
            // collapses the whole subtree into one element that `accessibilityHidden` can
            // then actually remove.
            //
            // Note what is NOT done here: the copy is not removed from the hierarchy.
            // `if drawing { bar }` would destroy and rebuild a `ScrollView` on every pin
            // crossing, which is the empty-pinned-bar defect this shape exists to prevent.
            // Both branches run the same modifier chain with different VALUES, so the
            // view's identity never changes.
            let floor = Self.minimumUsableContainer(placement)
            let drawing = geo.size.width >= floor
                && Self.drawsChips(
                    placement: placement, pinned: pinned, chipCount: chips.count
                )
            if geo.size.width >= floor {
                let layout = Self.rail.layout(
                    container: geo.size.width, placement: placement,
                    chips: chips, typeScale: Self.chipTypeScale(typeSize)
                )
                card(layout, drawing: drawing)
                    // The card's own inset — 0 inline (the List already did it), 16
                    // pinned. Real layout, not `.offset`: an offset moves pixels while
                    // the reported frame lags behind them.
                    .padding(.leading, layout.card.minX)
                    .frame(width: geo.size.width, alignment: .leading)
                    // The PINNED copy carries the board's own paper behind it, full
                    // width, for the 44pt strip it occupies. The card is opaque already;
                    // what this covers is the card's 16pt side margins, where rows used
                    // to be visible level with the floating bar — the last place board
                    // content could appear inside the chrome band once the navigation bar
                    // itself went opaque (`TasksView`'s `toolbarBackground`).
                    //
                    // It is the SAME colour that sits behind the inline copy at rest
                    // (`BoardBandCard.page`, the board's grouped backdrop — it was the
                    // board's white sheet before R29), which is what keeps "the two copies
                    // land on the same pixels" true through the hand-off instead of
                    // trading a ghost for a visible seam. Inline gets nothing: it IS in
                    // the content flow, and painting there would draw the page over the
                    // page.
                    .background(placement == .pinnedOverlay
                        ? BoardBandCard.page : Color.clear)
                    .opacity(drawing ? 1 : 0)
                    .allowsHitTesting(drawing)
                    .accessibilityHidden(!drawing)
            }
        }
        .dynamicTypeSize(...Self.chipTypeCap)
        .frame(height: TasksChromeMetrics.bandBar)
    }

    /// The card: one opaque surface, rounded to `cardCornerRadius`, holding the rail, the
    /// detached filters control and the hairline.
    ///
    /// Identical in both copies, by construction — nothing here reads `placement`, which is
    /// what makes "same style at the flip" a property of the code rather than a promise in
    /// a comment (it was the latter until R27, and the audit found the corners and the
    /// contrast both popping).
    private func card(_ layout: BoardBandBarLayout, drawing: Bool) -> some View {
        // A ZStack whose children are PLACED from the arithmetic, not an HStack whose
        // flexible child negotiates for what is left. The negotiated version is what
        // shipped, and it is why the rail's content ran under the button.
        ZStack(alignment: .topLeading) {
            chipRail(layout)
                .frame(width: layout.rail.width, height: layout.rail.height)
                .padding(.leading, layout.rail.minX)
            filtersControl(drawing: drawing)
                .frame(width: layout.filters.width, height: layout.filters.height)
                .padding(.leading, layout.filters.minX)
        }
        .frame(width: layout.card.width, height: layout.card.height, alignment: .topLeading)
        // The card's paper, OPAQUE and nothing else — the `.bar` material that used to sit
        // over this base is gone (R29).
        //
        // The base was introduced to stop the pinned copy's contrast depending on the rows
        // behind it (43.5 → 17.1 lum of capsule contrast at the flip) and to make the card
        // read as a surface in light mode at all; the material was what made a FLOATING
        // panel look like iOS chrome. The bar is not a floating panel any more, it is one
        // card in a stack of band cards, and an inset-grouped card is opaque colour. Left
        // in, the material would also darken this card off the band cards' white by ~8
        // grey — a visible mismatch between two things that are supposed to be the same
        // object — and it is the last thing in the bar whose result depended on what was
        // behind it, which is the defect class this whole surface exists to close.
        .background(Self.cardSurface)
        // INSIDE the card's own bounds, which is the R26 hairline fix: as a List row
        // sibling it was subject to the row's content insets and stopped 11.7pt short
        // of the card on each side.
        .overlay(alignment: .bottomLeading) {
            Rectangle()
                .fill(Color(.separator))
                .frame(width: layout.hairline.width, height: layout.hairline.height)
                // Decoration: never intercepts a chip tap, never an element automation
                // has to step past.
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        // Clip to the CARD, with the radius BOTH copies share.
        //
        // Two jobs, and only the first one is real. PIXELS: nothing the bar draws escapes
        // the card, and the card's corners are rounded to `cardCornerRadius` — which the
        // inline row got for free from its inset-grouped section and the pinned copy did
        // not, so the flip popped square corners until R27.
        //
        // What it does NOT do is fix the bar's ACCESSIBILITY GEOMETRY, which is what the
        // comment here used to claim. A clip is a rendering bound: the container element
        // still reports the union of its descendants' UNCLIPPED frames, so the pinned
        // copy's `board.bandBar` was measured at 160pt tall for a 44pt bar (and, with a
        // long chip row, wider than the card). That is not fixable from here — a chip
        // inside a horizontal `ScrollView` always reports its virtual frame — so the
        // criteria that hold are the two in the geometry's header: PIXELS (clip) and TAPS
        // (`contentShape` + `chipActivationX`). Anything reasoning about this bar from an
        // a11y frame is reasoning from the wrong number.
        .clipShape(RoundedRectangle(cornerRadius: layout.cardCornerRadius, style: .continuous))
        // `children:` BEFORE the container identifier. A container id REPLACES every
        // descendant's, which is how the deleted letter rail shipped three elements all
        // called `board.rail`. Every chip and filter value here is something automation
        // taps by id, so the LIVE copy must CONTAIN them.
        //
        // THREE modifiers say "and the other copy is not here", because one was not enough
        // and the audit proved it twice:
        //
        //  - `.ignore` folds the non-drawing subtree into this single element, so the
        //    chips and `board.filters` stop being published as their own elements.
        //  - `.accessibilityHidden(!drawing)` (here AND on the outside, in `body`) asks for
        //    the element itself to go.
        //  - the IDENTIFIER is dropped, which is the one that always works. R29 shipped
        //    hidden-only and the hierarchy still listed two `board.bandBar`s and two
        //    `board.filters` at rest (the hidden copy at [0,0][402,280]); an element that
        //    survives `hidden` but carries no id can no longer be matched by automation or
        //    named by VoiceOver, so the DUPLICATE — which is the actual defect — is gone
        //    whether the platform honours `hidden` or not.
        //
        // Not `if drawing { … }`: a structural branch would destroy and rebuild the rail's
        // `ScrollView` on every pin crossing, which is the empty-pinned-bar defect. Same
        // chain, different values.
        .accessibilityElement(children: drawing ? .contain : .ignore)
        .accessibilityHidden(!drawing)
        .accessibilityIdentifier(drawing ? "board.bandBar" : "")
    }

    // MARK: - The chip rail

    /// The horizontally scrollable chips, framed, clipped AND hit-clipped to their own
    /// viewport.
    ///
    /// A scroll that only the FINGER can drive is half a control, which is what shipped:
    /// with 30-odd project bands the selected chip was routinely off screen, so the bar
    /// answered "which band am I in" with a blank. `reveal` scrolls the lit chip into
    /// view on selection, on a grouping switch, and when the bar appears.
    private func chipRail(_ layout: BoardBandBarLayout) -> some View {
        ScrollViewReader { reader in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Self.rail.chipSpacing) {
                    ForEach(chips) { chip in
                        chipButton(chip, maxWidth: layout.chipMaxWidth)
                    }
                }
                .padding(.leading, Self.rail.contentLeadingInset)
                .padding(.trailing, layout.railTrailingContentInset)
                .frame(height: layout.rail.height)
            }
            // The rail is exactly the card minus the reserved column, so the filters
            // control is not "beside" the chips by negotiation — it is outside a frame
            // the chips were never given.
            .frame(width: layout.rail.width, height: layout.rail.height, alignment: .leading)
            // PIXELS: nothing the scroll content draws escapes the viewport.
            .clipShape(Rectangle())
            // TAPS: and nothing OUTSIDE the viewport is the rail's to answer. `clipped`
            // alone leaves hit testing where it was, which is how a thumb aimed at the
            // last chip's sliver opened the filters menu.
            .contentShape(Rectangle())
            // The scroll affordance, and the reason a clipped chip no longer looks like
            // a bug: the trailing edge fades instead of slicing a capsule flat mid-word.
            // A mask, not an overlay: fading the chips reveals the real card surface
            // underneath, where an overlaid gradient would be a second guess at that
            // colour and would have to be re-guessed every time the card's own colour
            // moves (it just did, R29). Masks don't change hit testing, so a half-faded
            // chip stays tappable.
            //
            // It is honest in both directions now: `fadeWidth` is ZERO when the chips
            // fit (the old always-on mask dimmed the tail of a row that had nothing
            // after it), and when they don't fit the content carries a trailing inset so
            // the last chip can scroll clear of the fade rather than living under it.
            //
            // THREE stops, not two, and the third is the R27 fix. Dimming to
            // `trailingFadeFloor` and stopping there is still a hard cut: the mask ended
            // at 0.35 and the pixel after it was bare card, which the frame audit measured
            // as an 18-lum vertical edge at x=331. So the floor holds for most of the
            // gradient (that is what keeps the peeking word READABLE — reaching zero early
            // is what once deleted "Backlog" and left a dot), and only the last
            // `trailingFadeTailWidth` points run out to nothing, so the fragment meets the
            // card material instead of being sliced against it.
            .mask(alignment: .leading) {
                HStack(spacing: 0) {
                    Rectangle().fill(.black)
                        .frame(width: layout.fadeMinX)
                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(
                                color: .black.opacity(Self.rail.trailingFadeFloor),
                                location: layout.fadeFloorLocation
                            ),
                            .init(color: .black.opacity(0), location: 1),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: layout.fadeWidth)
                }
            }
            // Selection moved (a tap here, or `TasksView` clearing it because the band
            // went away): follow it.
            .onChange(of: selected) { _, _ in reveal(in: reader, animated: true) }
            // A rail width that ARRIVES LATE, which is the third layer of the
            // empty-pinned-bar fix and the only one that can still save an instance
            // whose scroll view was laid out into a viewport it cannot use. The other
            // two prevent that from happening (`minimumUsableContainer` and one
            // instance per copy); this one makes it recoverable if it does, because
            // `reveal` is the ONLY thing in this file that touches the rail's content
            // position and it was wired exclusively to selection, grouping and appear.
            .onChange(of: layout.rail.width) { _, _ in reveal(in: reader, animated: false) }
            // A grouping switch replaces every chip at once (`focus` → `proj:marina`)
            // and resets the selection to nil. When the selection was ALREADY nil,
            // `onChange(of: selected)` never fires, so without this the row would stay
            // parked in the old id space with the freshly lit `All` chip off screen.
            .onChange(of: grouping) { _, _ in reveal(in: reader, animated: false) }
            // Appearing counts too: the board is rebuilt whenever the Tasks tab comes
            // back, and a restored selection deep in the row would be invisible.
            .onAppear {
                // Next runloop: the chips have to exist before `scrollTo` can target one.
                DispatchQueue.main.async { reveal(in: reader, animated: false) }
            }
        }
    }

    /// Scroll the lit chip into view, or the `All` chip when nothing is selected.
    ///
    /// `.center` rather than `.leading`: a chip revealed flush against the leading edge
    /// hides the fact that there are chips before it.
    private func reveal(in reader: ScrollViewProxy, animated: Bool) {
        let target = chips.first(where: { $0.bandId == selected })?.id ?? chips.first?.id
        guard let target else { return }
        if animated {
            withAnimation(.snappy(duration: 0.2)) { reader.scrollTo(target, anchor: .center) }
        } else {
            reader.scrollTo(target, anchor: .center)
        }
    }

    // MARK: - Chips

    private func chipButton(_ chip: BoardModel.BandChip, maxWidth: CGFloat) -> some View {
        // Both nil = the All chip is the selected one, which is what makes "no
        // selection" a visible state rather than a bar with nothing lit.
        let isSelected = chip.bandId == selected
        return Button {
            // A tap on the chip already in force costs nothing but a haptic.
            guard !isSelected else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onSelect(chip.bandId)
        } label: {
            HStack(spacing: Self.rail.chipInnerSpacing) {
                if let bandId = chip.bandId {
                    // Same accent the band's heading carries, so the chip and the
                    // heading read as the same object.
                    Circle()
                        .fill(TaskBoardList.bandColor(bandId))
                        .frame(width: Self.rail.chipDotDiameter, height: Self.rail.chipDotDiameter)
                }
                Text(chip.label)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    // A capped chip loses its tail, never its head.
                    .truncationMode(.tail)
                Text(chip.count.formatted(.number))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(isSelected ? Theme.onTint : Self.unselectedChipCount)
            }
            .padding(.horizontal, Self.rail.chipPaddingH)
            .padding(.vertical, Self.rail.chipPaddingV)
            // No chip may hog the rail, and the cap also guarantees the NEXT chip a
            // readable peek (`minimumReadablePeek`).
            .frame(maxWidth: maxWidth, alignment: .leading)
            .foregroundStyle(isSelected ? Theme.onTint : Self.unselectedChipLabel)
            // Both fills are CONCRETE colours: the lit chip's tint, and one opaque grey
            // for the rest (`unselectedChipFillColor` — never a material, see its header).
            .background(
                isSelected ? AnyShapeStyle(Theme.tint) : AnyShapeStyle(Self.unselectedChipFill),
                in: Capsule()
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // Deliver the tap near the capsule's LEADING edge; see `chipActivationX`.
        .accessibilityActivationPoint(UnitPoint(x: Self.rail.chipActivationX, y: 0.5))
        .accessibilityIdentifier(TaskBoardList.chipId(chip.bandId))
        // A HINT, not a label: a label REPLACES the visible text for matchers, and a
        // flow asserting the band's own name would then find nothing.
        .accessibilityHint(chip.bandId == nil
            ? "Show every band"
            : "Show only \(chip.label)")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : [.isButton])
    }

    // MARK: - The two filters, folded into their own control

    /// The filters control, which is now its OWN object rather than a glyph floating at
    /// the end of the chip row.
    ///
    /// Three things make it detached, and all three were review findings: its own opaque
    /// circular background (a bare glyph 4pt from a grey capsule read as part of the
    /// row), `railSpacing` of real card material between it and the rail's clip edge,
    /// and a tap target the full height of the bar while the circle stays 34pt.
    ///
    /// The VALUES behind it are a menu at ordinary type sizes and a sheet at accessibility
    /// sizes, because a menu cannot scroll — see `filtersPresentation`. The control itself
    /// is one view either way (`filtersLabel`), so nothing about the bar changes with the
    /// type size except what opening it presents.
    ///
    /// It takes `drawing` for one reason only: its identifier. A `Menu` is UIKit-backed, and
    /// the copy that is not drawing published `board.filters` from inside a subtree the
    /// outer `accessibilityHidden` had already been asked to remove. Dropping the id is what
    /// makes the duplicate unmatchable (see `card`).
    private func filtersControl(drawing: Bool) -> some View {
        Group {
            switch Self.filtersPresentation(typeSize) {
            case .sheet:
                Button { showFiltersSheet = true } label: { filtersLabel }
                    .buttonStyle(.plain)
            case .menu:
                Menu {
                    Section("Group") {
                        filterValues($grouping, identifierPrefix: "board.group", in: .menu)
                    }
                    Section("Dates") {
                        filterValues($dateFilter, identifierPrefix: "board.date", in: .menu)
                    }
                } label: {
                    filtersLabel
                }
            }
        }
        .accessibilityIdentifier(drawing ? "board.filters" : "")
        .accessibilityHidden(!drawing)
        // A real name for the glyph, and the current values as its VALUE, so VoiceOver
        // says what the filters are set to without opening the menu — and NOTHING in the
        // copy that is not drawing, for the same reason its identifier is empty: a
        // hierarchy dump proved the platform keeps publishing this UIKit-backed subtree,
        // so a flow (or VoiceOver) matching the WORD "Filters" would otherwise find two.
        .accessibilityLabel(drawing ? "Filters" : "")
        .accessibilityValue(drawing ? "\(grouping.label), \(dateFilter.label)" : "")
        .sheet(isPresented: $showFiltersSheet) { filtersSheet }
    }

    /// The 34pt circle, identical in both presentations.
    private var filtersLabel: some View {
        Image(systemName: "line.3.horizontal.decrease")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.tint)
            .frame(
                width: Self.rail.filtersControlWidth,
                height: Self.rail.filtersControlHeight
            )
            // ONE opaque fill. `.thickMaterial` used to ride over this base and is gone
            // with the card's (R29): the material is not opaque in light mode (measured:
            // chips ghosted through the control that is supposed to be detached from them)
            // and "thick" is easy to misread as "solid", so all it added was a colour that
            // depended on what was behind it — inside a card, that is the chips.
            .background { Circle().fill(Self.filtersControlSurface) }
            .overlay(Circle().strokeBorder(Color(.separator), lineWidth: 0.5))
            // The circle is 34pt; the TOUCH is the bar's full height.
            .frame(width: Self.rail.filtersControlWidth, height: TasksChromeMetrics.bandBar)
            .contentShape(Rectangle())
    }

    /// The same two filters as a scrolling sheet, which is the only presentation that can
    /// reach every value at an accessibility type size.
    private var filtersSheet: some View {
        NavigationStack {
            List {
                Section("Group") {
                    filterValues($grouping, identifierPrefix: "board.group", in: .sheet)
                }
                Section("Dates") {
                    filterValues($dateFilter, identifierPrefix: "board.date", in: .sheet)
                }
            }
            .navigationTitle("Filters")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showFiltersSheet = false }
                        .accessibilityIdentifier("board.filtersDone")
                }
            }
        }
        // The bar CLAMPS type size for its own chips (a 65pt capsule does not fit a 44pt
        // bar), and a sheet presented from inside that clamp inherits it. Clamping the one
        // presentation that exists BECAUSE the user reads large would be the joke version
        // of this fix, so the real ambient size is re-asserted here.
        .dynamicTypeSize(typeSize)
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("board.filtersSheet")
    }

    /// One filter's values, with the current one checked.
    ///
    /// Generic over `BoardFilterChoice` so grouping and dates share one builder: the two
    /// enums already agree on `rawValue` (the id suffix) and `label` (the desktop's
    /// word), and a second copy of this would be where they drift. Generic over the
    /// PRESENTATION for the same reason — the sheet is a different container, not a
    /// different set of values, and the identifiers must be the ones shipped flows tap.
    @ViewBuilder
    private func filterValues<Option: BoardFilterChoice>(
        _ selection: Binding<Option>, identifierPrefix: String,
        in presentation: FiltersPresentation
    ) -> some View {
        ForEach(Array(Option.allCases), id: \.rawValue) { option in
            let isCurrent = option == selection.wrappedValue
            Button {
                guard !isCurrent else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                selection.wrappedValue = option
            } label: {
                switch presentation {
                case .menu:
                    // A menu turns this Label into its own checkmark row.
                    if isCurrent {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                case .sheet:
                    // A List row has to DRAW the check: the menu's automatic one is not on
                    // offer here, and a value list with nothing marked cannot say what is
                    // in force — which was the second half of the accessibility-size
                    // defect (the values were unreachable, and unmarked once reached).
                    HStack {
                        Text(option.label)
                        Spacer(minLength: 8)
                        if isCurrent {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Theme.tint)
                                // The trait below says "selected"; a second announcement
                                // of the glyph would say it twice.
                                .accessibilityHidden(true)
                        }
                    }
                    .contentShape(Rectangle())
                }
            }
            .accessibilityIdentifier("\(identifierPrefix).\(option.rawValue)")
            .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
        }
    }
}
