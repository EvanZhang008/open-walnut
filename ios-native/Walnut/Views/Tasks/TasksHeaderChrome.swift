import SwiftUI

/// The board's header chrome, and the one rule that decides what stands in for it once it
/// has scrolled away: the tier chip row (header row 1) PINS at the top edge.
///
/// The pinned copy is an OVERLAY (never a `safeAreaInset`): an inset that appears
/// mid-scroll changes the List's visible rect and yanks the content offset, which is
/// exactly the scroll-jump class of bug this app has been bitten by before. An overlay
/// costs zero layout and can never move a row.
///
/// The header used to start with a nav row (Pin | Calendar) and a quick-add row, and the
/// list filters had a compact bar standing in for both once they scrolled away. The
/// board now lives in the Tasks tab's drawer: the calendar is a toolbar button, the one
/// `+` is a toolbar button, and the list filters are gone, so all of that went with them.
enum TasksChromeMetrics {

    // Measured on an iPhone 16 Pro (402x874pt) from a `maestro hierarchy` dump of
    // the real store: the offline banner ~44pt.
    //
    // `sectionGap` is the exception: it is what the chrome sections ASK for, and the
    // platform does not resolve it to that. Read its own note before citing any number
    // here as measured.

    /// The board's tier chip row: **row 1**, and the ONLY row on the board that pins.
    ///
    /// The chips are an ordinary content row, and the pinned overlay is a stand-in that
    /// appears only once that row reaches the top edge (`chipsPinThreshold`). Both draw at
    /// `bandBar` height — the same number for the inline row and its pinned copy,
    /// necessarily: they are one bar drawn in two places.
    ///
    /// Equal heights are ONE of the three things that hand-off needs. The full list: same
    /// screen X (R26 — `BoardBandBarPlacement` insets the pinned card), same screen Y at the
    /// crossing (R27 — `chipsPinThreshold` is derived from `chipRowContentTop`), and the
    /// same CARD STYLE (R27 — one corner radius and one opaque surface).
    ///
    /// 52, and the 8pt over a List row's minimum is a CORNER measurement (R30): the board's
    /// cards round to `BoardBandCard.cornerRadius` = 26 on iOS 26, and a rounded rectangle
    /// cannot round a corner deeper than half its height. At 44 the platform clamped the
    /// bar's 26 to 22, a visibly tighter corner than the band cards below it.
    static let bandBar: CGFloat = 52

    /// The board's VIEW BAR — **row 2**: the grouping, date and collapse-all chips
    /// (`BoardViewBar`).
    ///
    /// 36, the smallest number that holds its content: the chips cap their type at
    /// `BoardBandBar.chipTypeCap` (footnote at xxLarge ≈ 17pt), which with the capsule's 5pt
    /// vertical padding is a 28pt control, and 4pt of air either side.
    ///
    /// A CONSTANT because a header row that grew with the content size category would push
    /// every task row below it down at accessibility sizes, on the screen whose job is
    /// showing rows. Nothing about this row can move `chipsPinThreshold`, which counts only
    /// what rides ABOVE the chips.
    static let viewBar: CGFloat = 36

    static let offlineBanner: CGFloat = 44

    /// What one chrome section boundary is ASKED to be (`listSectionSpacing(2)`) — and NOT
    /// what the platform resolves it to.
    ///
    /// Two independent measurements on the built binary (2026-09-02 review) put the real
    /// boundary at ~9pt: turning the offline banner on shifted the rows below it by 53pt
    /// where these constants predict 44 + 2 = 46. The pin hand-off is placed from these
    /// constants and its correctness is established by a FRAME CAPTURE of the crossing (R27,
    /// see `chipsPinThreshold`), so it is never nudged here to make the flip look right:
    /// re-measure the hop instead.
    static let sectionGap: CGFloat = 2

    /// Height the List puts above its content that the ROWS do not account for: the
    /// inset-grouped style's own padding above its first section.
    ///
    /// Measured 2026-08-30 as the DEFECT it caused rather than guessed: the pin flip moved
    /// the bar 10.66pt UP with no frame in between on a slow drag. It is a layout number,
    /// not a tuning knob: `chipRowContentTop` adds it once, and the pin threshold is derived
    /// from that.
    static let listHeaderPadding: CGFloat = 10.66

    // MARK: - The board's pinned chip row

    /// Content y of the top of the chip row: everything above it, in the order the List
    /// draws it. Only the offline banner rides above the chips now.
    static func chipRowContentTop(offline: Bool) -> CGFloat {
        var total = listHeaderPadding
        if offline { total += offlineBanner + sectionGap }
        return total
    }

    /// Padding the PINNED copy puts above its card, i.e. the screen y it comes to rest
    /// at, in the same origin `scrolled` is measured in (the top of the List's content
    /// area — the overlay honours the safe area, so the two origins are the same point).
    ///
    /// Zero, and wired rather than assumed: `TasksView` applies it to the overlay and
    /// `chipsPinThreshold` subtracts it, so a future inset moves the hand-off with it
    /// instead of re-opening the vertical hop below.
    static let pinnedChipsTopInset: CGFloat = 0

    /// Scroll distance at which the board's chip row reaches the top edge, so the
    /// pinned copy has to take over.
    ///
    /// # It is the Y-COINCIDENCE offset, and that is the whole point (R27)
    ///
    /// The inline row RIDES THE CONTENT: its card's top sits at
    /// `chipRowContentTop - scrolled`. The pinned copy is an overlay resting at
    /// `pinnedChipsTopInset`. There is exactly ONE offset where those agree, and handing
    /// off anywhere else teleports the bar by the difference — measured on the built
    /// binary as a 10.66pt hop UP with no frame in between, when the threshold counted
    /// only the rows above the chips and the List put `listHeaderPadding` above them too.
    ///
    /// So it is DERIVED from the same layout numbers the row is placed from, never
    /// hand-tuned until the flip looks smooth:
    /// `TasksBoardChipRowPinTests.testThePinFiresExactlyWhereTheTwoCardsCoincide` feeds
    /// both real containers through `BoardBandRailGeometry.layout` and compares the two
    /// cards as SCREEN RECTS at this offset.
    static func chipsPinThreshold(offline: Bool) -> CGFloat {
        chipRowContentTop(offline: offline) - pinnedChipsTopInset
    }

    /// Dead band under the pin point.
    ///
    /// The band IS the residual hop: `chipsPinThreshold` is the only offset where the two
    /// cards coincide, so unpinning one band EARLY brings the inline row back
    /// `chipsPinBand` points below where the pinned copy just was. 4pt is what the frame
    /// audit's own bar (a hop over 8pt reads as a jump) leaves room for. Zero is not the
    /// answer either: a single threshold makes a touch-slop wobble at rest flip the state,
    /// and each flip is a publish.
    static let chipsPinBand: CGFloat = 4

    static func chipsUnpinThreshold(offline: Bool) -> CGFloat {
        max(0, chipsPinThreshold(offline: offline) - chipsPinBand)
    }

    /// Pinned now? Sticky: once pinned it holds until the list is `chipsPinBand` back
    /// above the pin point.
    static func areChipsPinned(scrolled: CGFloat, wasPinned: Bool, offline: Bool) -> Bool {
        if wasPinned { return scrolled > chipsUnpinThreshold(offline: offline) }
        return scrolled > chipsPinThreshold(offline: offline)
    }

    // MARK: - What "scrolled" is, and why the search drawer must not fake it

    /// How far the content has travelled from rest, given ONE geometry sample.
    ///
    /// # The defect this replaces
    ///
    /// `scrolled` used to be `geo.contentOffset.y + geo.contentInsets.top`, read straight
    /// out of the sample. That sum is 0 at rest and grows as the content moves up, which
    /// is the right measure — but `contentInsets.top` is not a constant on this screen:
    /// the `.searchable` drawer (`displayMode: .automatic`) RETRACTS as soon as a drag
    /// starts, and the whole drawer height leaves the inset in a single sample. Both of
    /// the pin's crossing sits inside the first few points of travel and its dead band is
    /// 4pt, so a ~52pt step in ONE sample crosses it — and then crosses back as the drag
    /// continues. Two spurious flips, each one a publish, inside the frame the drawer is
    /// re-laying the header out on. Frames:
    /// `frames/m1.png` — the field present at t=19.00s, gone at 19.20s, everything above
    /// the chips shifted up in one frame.
    ///
    /// # The rule: a sample whose INSET moved reports no travel of its own
    ///
    /// `offset + insetTop` stays the measure, because it is the honest one — at rest it is
    /// 0 whatever the inset is, and that is a property nothing here may trade away (a
    /// measure that could read non-zero at the top would leave the chrome collapsed on a
    /// list nobody scrolled, which is worse than the frames this is protecting).
    ///
    /// What changes is the samples in which the INSET itself moved: those report the
    /// PREVIOUS travel, i.e. they contribute nothing. The origin moved, not the content,
    /// and the whole drawer animation (it takes several frames, not one) is absorbed that
    /// way — so no threshold can flip on the frame the drawer is re-laying the header out
    /// on, which is the coincidence that made the top of the gesture expensive. As soon as
    /// the inset settles the measure is honest again, so this can defer a crossing by a
    /// few frames and can never lose one.
    ///
    /// Deliberately NOT a frozen inset baseline. That was the first attempt and it is
    /// wrong in a way worth recording: freezing the origin for the duration of a gesture
    /// makes `offset + frozenInset` non-zero at the new rest once the drawer really is
    /// gone (52pt of "travel" that never goes away), which is exactly the stuck state the
    /// paragraph above rules out.
    ///
    /// Pure, taking the previous sample and the previous answer, so the whole rule is
    /// testable as a sequence (`BoardScrollTravelTests`) instead of only being observable
    /// as a dropped frame.
    static func travel(
        sample: BoardScrollSample, previous: BoardScrollSample?, lastTravel: CGFloat
    ) -> CGFloat {
        let measured = sample.offset + sample.insetTop
        guard let previous else { return measured }
        // Sub-point inset wobble (a rounding difference between passes) is not a drawer;
        // treating it as one would hold travel forever on a noisy stream.
        if abs(sample.insetTop - previous.insetTop) > insetStepEpsilon { return lastTravel }
        return measured
    }

    /// Smallest inset change that counts as the header changing shape rather than
    /// arithmetic noise. Half a point: the drawer is ~52pt and the collapsing bar tens of
    /// points, so nothing real lives below this.
    static let insetStepEpsilon: CGFloat = 0.5
}

/// One scroll-geometry sample, as the two numbers the decision needs.
///
/// A struct rather than the pre-added `CGFloat` the observer used to emit, and that is
/// the point: `onScrollGeometryChange` compares its value to decide whether to call the
/// action, so a sum hides WHICH half moved — an inset that shrank by the drawer's height
/// looked exactly like the content travelling that far. See `TasksChromeMetrics.travel`.
struct BoardScrollSample: Equatable {
    /// `contentOffset.y` — negative at rest by the size of the top inset.
    let offset: CGFloat
    /// `contentInsets.top` — the collapsing nav bar plus the search drawer when it is
    /// out, so it CHANGES mid-gesture.
    let insetTop: CGFloat
}

/// The tiny bit of state `TasksChromeMetrics.travel` needs between samples.
///
/// Same shape and the same reason as `ChromeCollapseTracker`: geometry callbacks run
/// inside the scroll view's layout pass, so this state lives in a reference box OFF the
/// view graph and is deliberately not `@Observable` — nothing observes it, and a publish
/// from here would re-invalidate the subtree being measured.
@MainActor
final class BoardScrollTravelTracker {
    private var previous: BoardScrollSample?
    private var last: CGFloat = 0

    /// Travel for this sample. The memory is the previous sample and the previous
    /// answer — see `TasksChromeMetrics.travel` for what they are for.
    func travel(_ sample: BoardScrollSample) -> CGFloat {
        let travelled = TasksChromeMetrics.travel(
            sample: sample, previous: previous, lastTravel: last)
        previous = sample
        last = travelled
        return travelled
    }

    /// Forget the previous sample — for a filter switch, where the next list has its own
    /// chrome and its own inset, so "the inset changed" would be true for a reason that
    /// has nothing to do with a drawer.
    func reset() {
        previous = nil
        last = 0
    }
}

/// Coalescing gate between the scroll-geometry stream and the ONE write a threshold
/// crossing needs (the board's chip pin). The name is older than its one remaining user:
/// it first gated the list filters' compact bar, which left with those filters.
///
/// Why a reference box and not a plain `@State` write in the handler: the action
/// of `onScrollGeometryChange` runs INSIDE the scroll view's layout pass, so
/// publishing from it re-invalidates the subtree being measured. On a tall list of
/// variable-height rows that feedback does not converge — see the long-form
/// account in `ScrollBottomTracking` (P0-2: the chat timeline went permanently
/// blank and the main thread spun at 100%). Deliberately NOT `@Observable`: this
/// state is written from geometry callbacks and nothing observes it.
///
/// Contract: **N threshold crossings produce at most N publishes.** A geometry
/// stream that never crosses one publishes nothing at all.
@MainActor
final class ChromeCollapseTracker {
    /// A publish is already queued for the next runloop.
    private var queued = false
    /// The value that queued publish will apply. A crossing that arrives while one
    /// is in flight REPLACES this rather than queueing a second hop, so a fast
    /// flick across the band costs one publish, not one per sample.
    private var pending = false
    /// Publishes performed (test observable).
    private(set) var publishes = 0
    /// Samples seen (test observable) — the ratio is the whole point.
    private(set) var samples = 0

    /// Ask for `want`, given what the view currently shows. Applies nothing when
    /// they already agree, so a steady stream inside a band is free.
    func request(_ want: Bool, current: Bool, apply: @escaping (Bool) -> Void) {
        samples += 1
        guard want != current else {
            // Settled back on its own (a bounce that re-crossed): drop the queued
            // hop instead of publishing a value that is already on screen.
            if queued { pending = current }
            return
        }
        pending = want
        guard !queued else { return }
        queued = true
        // Next runloop: OUT of the layout pass that produced this sample.
        DispatchQueue.main.async { [self] in
            queued = false
            guard pending != current else { return }
            publishes += 1
            apply(pending)
        }
    }
}

/// Where the board's "the chip row has reached the top edge" flag LIVES, and the reason it
/// is a reference object instead of a `@State Bool` on `TasksView`.
///
/// # The defect: one publish, a whole List body
///
/// The coalescing gate above already guarantees at most ONE publish per threshold
/// crossing, and that was measured and correct. What it could not bound was the COST
/// of that one publish: `boardChipsPinned` was `@State` on `TasksView`, both copies
/// of the bar read it from `TasksView.body`, so a crossing invalidated the entire
/// body — the board derive (`BoardModel.assemble`, which builds the rail and the bands
/// together) and a `List` diff — to swap a 44pt strip. Both thresholds on this screen land inside the first
/// ~57pt of travel, and the search drawer retracts in the same window, so those
/// passes stacked at the top of the gesture: measured 460-515ms of dropped frames on
/// a board scroll, against 170ms worst-case on a 762-row Notes list under the same
/// machine load.
///
/// # Why this shape fixes it
///
/// `TasksView` WRITES `isPinned` and never reads it; the two `BoardBandBar` copies
/// read it and nothing else does. Under Observation a dependency is registered by the
/// body that performs the read, so a crossing now invalidates the two bars and leaves
/// `TasksView.body` (and therefore the board derive and the List) alone.
///
/// That is a contract, not an implementation detail: **nothing in `TasksView.body`
/// may read `isPinned`.** A single `if latch.isPinned` there puts the whole List back
/// on the scroll path and the hitch comes back with it, silently, because the
/// coalescing gate will still report one publish per crossing.
@Observable
@MainActor
final class BoardChipsPinLatch {
    /// True once the board's chip row (header row 1) has reached the top edge, so the
    /// pinned copy stands in for it.
    ///
    /// Starts false: unpinned is always safe to be wrong about (the inline row simply
    /// draws the chips where its own content position puts them, and the next geometry
    /// sample re-pins).
    var isPinned = false
}
