import SwiftUI

/// The Tasks tab's header chrome, and the two rules that decide what stands in for
/// it once it has scrolled away.
///
/// Why this exists: the nav row / quick add are already List rows, so
/// they scroll away on their own — but that leaves NO way to switch filters or add
/// a task without scrolling all the way back up. The survivor is a compact bar on
/// the list filters (`showsCompactBar`), and on the BOARD it is the header's own
/// second row, the tier chips, pinned in place (`showsPinnedChips`).
///
/// Both are drawn as OVERLAYS (never a `safeAreaInset`): an inset that appears
/// mid-scroll changes the List's visible rect and yanks the content offset, which
/// is exactly the scroll-jump class of bug this app has been bitten by before.
/// An overlay costs zero layout and can never move a row.
///
/// The two are mutually exclusive per filter, on purpose — one floating row, never
/// two (`TasksChromeCollapseTests.testNoFilterEverFloatsTwoBarsAtOnce`).
enum TasksChromeMetrics {

    // Measured on an iPhone 16 Pro (402x874pt) from a `maestro hierarchy` dump of
    // the real store: the quick-add row spans 52pt and the offline banner ~44pt.
    //
    // `sectionGap` is the exception: it is what the chrome sections ASK for, and the
    // platform does not resolve it to that. Two measurements say so and they agree with
    // each other — read `sectionGap`'s own note before citing any number here as measured.

    /// The nav row (Pin | Calendar) — **row 1** of the header, and the FIRST thing in
    /// the scrollable content on every filter.
    ///
    /// The HEIGHT is unchanged by dropping the "All Tasks" pill, and that is why the
    /// collapse arithmetic below did not move: the row is as tall as one chip, not as
    /// wide as its chips, and it scrolls horizontally rather than wrapping
    /// (`TasksNavRow`). One fewer destination is a shorter row, never a shorter header.
    ///
    /// It replaced a 104pt strip of six summary cards (T84). The chip is a
    /// subheadline with 7pt of vertical padding (~32pt) inside a row with 4/8pt
    /// insets, so ~44pt — which is also a List row's own minimum height, the thing
    /// the chip row below it leans on.
    static let navRow: CGFloat = 44

    /// The board's tier chip row — **row 2**, and the ONLY row on the board that
    /// pins.
    ///
    /// # Row 1 above row 2, which is not how it shipped
    ///
    /// The user's order is nav pills first, chips second, chips pinned. The build
    /// reviewed on 2026-08-29 had it upside down at scroll-top (chips measured
    /// y 236..264, the nav row y 290..322) because the board's content began with a
    /// CLEAR RESERVE row and the chips were a permanently floating overlay pinned
    /// over it: the overlay is at the top of the list area by definition, so the
    /// chips could only ever draw ABOVE the nav row.
    ///
    /// So the reserve is gone. The chips are now an ordinary content row in second
    /// place, and the overlay is a stand-in that appears only once that row reaches
    /// the top edge (`chipsPinThreshold`). Both draw at `bandBar` height — the same
    /// number for the inline row and its pinned copy, necessarily: they are one bar
    /// drawn in two places.
    ///
    /// Equal heights are ONE of the three things that hand-off needs, and R26/R27 each
    /// found the audit measuring one of the other two. The full list, so nobody has to
    /// re-derive it: same screen X (R26 — `BoardBandBarPlacement` insets the pinned
    /// card), same screen Y at the crossing (R27 — `chipsPinThreshold` is derived from
    /// `rowTwoContentTop`, not from the rows alone), and the same CARD STYLE (R27 — one
    /// corner radius and one opaque surface, both fields the flip tests compare).
    ///
    /// # 52, and the 8pt is a CORNER measurement (R30)
    ///
    /// It was 44 (a List row's own minimum). The board's cards all round to
    /// `BoardBandCard.cornerRadius` = 26 on iOS 26, and a rounded rectangle cannot round a
    /// corner deeper than half its height: at 44 the platform clamped the bar's 26 to 22, so
    /// the one hand-drawn card in the stack measured a 12.5pt inset 2pt below its top edge
    /// where the OS-drawn cards measured 15.9pt — a visibly tighter corner, which is the Z8
    /// finding. At 52 the radius fits (26 + 26 = 52) and the two profiles agree to 0.1pt.
    ///
    /// 52 is not a free number either: it is what the reference screen's own short card (the
    /// quick-add capsule, `quickAdd`) measures, and that card now sits directly BELOW this
    /// bar on the board. Two adjacent short cards of the same height with the same radius
    /// are the same object; two that differ by 8pt are two guesses at one idea.
    static let bandBar: CGFloat = 52

    /// The board's VIEW BAR — **row 3**: the grouping and date decisions as two inline
    /// toggle chips (`BoardViewBar`). Board only; every other filter goes straight from
    /// row 1 to its quick add.
    ///
    /// 36, and it is the smallest number that holds its content rather than a round one:
    /// the chips cap their type at `BoardBandBar.chipTypeCap` (footnote at xxLarge ≈ 17pt),
    /// which with the capsule's 5pt vertical padding is a 28pt control, and 4pt of air
    /// either side is what keeps it from touching the card above and the card below.
    ///
    /// It is NOT a card, deliberately: it is a control strip on the page, the same way a
    /// band heading is, and it aligns with the headings' own content inset
    /// (`BoardBandCard.headingContentInset`). A third 52pt card between the band bar and
    /// the quick add would put three stacked cards above the first task row.
    ///
    /// # Why it is a CONSTANT
    ///
    /// Not because an arithmetic term needs it: the only live threshold on this screen is
    /// `chipsPinThreshold`, and that counts what rides ABOVE row 2, so nothing about this row
    /// can move it (`chromeHeight` does count it, and for the board nothing reads that — see
    /// there). The real reason is the row itself: `BoardViewBar` draws at exactly this height,
    /// and a header row that grew with the content size category would push every task row
    /// below it down at accessibility sizes, on the screen whose job is showing rows. That is
    /// also why the chips cap their type instead of the row growing to fit them.
    static let viewBar: CGFloat = 36

    /// The quick-add row's height — MEASURED (2026-08-30: the card runs y 336..388 on the
    /// board at scroll-top), not the 48 this used to estimate. It feeds the collapse
    /// arithmetic, and the board now renders this row too, so an estimate 4pt short would
    /// put the compact bar's threshold 4pt early on every filter that has one.
    static let quickAdd: CGFloat = 52
    static let offlineBanner: CGFloat = 44

    /// What one chrome section boundary is ASKED to be (`listSectionSpacing(2)`) — and NOT
    /// what the platform resolves it to.
    ///
    /// Two independent measurements on the built binary (2026-09-02 review) put the real
    /// boundary at ~9pt, and they agree with each other: on the board at scroll-top the band
    /// bar's card ends at y 331 and the view bar starts at y 340 (9pt), and turning the
    /// offline banner on shifts the rows below it by 53pt where these constants predict
    /// 44 + 2 = 46 (also 9pt). So the error is in THIS constant, not in `offlineBanner`, and
    /// it is per boundary — the board crosses four of them, i.e. the arithmetic below
    /// understates the real chrome by ~28pt and every threshold derived from it fires that
    /// much early. Same class as `listHeaderPadding`, which exists because the List's own
    /// padding above its first section was missing from this arithmetic too.
    ///
    /// Deliberately NOT re-tuned here. These constants also place the board's pin hand-off,
    /// and its correctness was established by a FRAME CAPTURE of the crossing (R27, see
    /// `chipsPinThreshold`) — with a 9pt gap that hand-off is currently ~7pt early, which is
    /// a candidate cause of the chip clipping reported at the transition. Fixing it is a
    /// re-derivation against a fresh capture of the flip, not a nudge of one number: raising
    /// this to 9 moves `rowTwoContentTop`, `chipsPinThreshold` and `chromeHeight` at once and
    /// would have to be verified on the device, frame by frame, in the same way.
    static let sectionGap: CGFloat = 2

    /// Height the List puts above its content that the ROWS do not account for: the
    /// inset-grouped style's own padding above its first section, plus however much
    /// `listSectionSpacing(2)` really resolves to beyond the 2 it is asked for.
    ///
    /// Measured 2026-08-30, and measured as the DEFECT it caused rather than guessed:
    /// the pin flip moved the bar 10.66pt UP with no frame in between on a slow drag,
    /// and 8.66pt on a fling. Both are the same number seen twice — the offset the pin
    /// fired at was this much short of the offset where the inline row's top actually
    /// reaches the pinned copy's resting y — and the slow drag is the honest one,
    /// because a fling's next sample lands past the crossing and so UNDERSTATES the hop.
    ///
    /// It is a layout number, not a tuning knob: `rowTwoContentTop` adds it once, and
    /// both the pin threshold and `chromeHeight` are derived from that. Nothing should
    /// ever nudge this to make a hand-off look right — re-measure the hop instead.
    static let listHeaderPadding: CGFloat = 10.66

    /// The compact bar's own height. Kept slim: it floats over the rows, so every
    /// point here is a point of a task row the user can't read.
    static let compactBarHeight: CGFloat = 44

    /// Does this filter get a compact bar at all?
    ///
    /// TWO filters say no, for two different reasons:
    ///
    ///  - The BOARD (`.sessions`): it already HAS a floating row, and the user
    ///    asked for exactly one. Its second header row is the tier chips, which pin
    ///    themselves (`showsPinnedChips`) and carry "switch what you are looking
    ///    at" — a `TasksCompactBar` here would be a second bar stacked on that one,
    ///    offering a third copy of the same three nav destinations. This is the line
    ///    that keeps the board's floating chrome at one row.
    ///  - CALENDAR: there is no bar to draw. That surface is full-bleed
    ///    (`TasksView.calendarSurface`), not the shared `List`, so it has no
    ///    scroll-geometry observer, never collapses, and never hosts the overlay this
    ///    answer feeds. Saying `true` for it was a lie with a shape: any reader would
    ///    conclude the calendar had a compact bar, and a test asserting "every filter
    ///    except the board keeps one" happily agreed (2026-08-29 review). Its nav row
    ///    stays permanently on top instead, which is what makes switching back out one
    ///    tap.
    static func hasCompactBar(_ filter: TaskFilter) -> Bool {
        filter != .sessions && filter != .calendar
    }

    /// The one question the view asks: draw the bar, or not.
    static func showsCompactBar(filter: TaskFilter, collapsed: Bool) -> Bool {
        collapsed && hasCompactBar(filter)
    }

    // MARK: - The board's pinned chip row (row 2)

    /// Content y of the top of header ROW TWO — the chip row on the board, the quick
    /// add on every other filter. Everything above it, in the order the List draws it.
    ///
    /// This is the one place that answer is written down, and both readers need the
    /// same one: `chipsPinThreshold` (the offset where row 2 reaches the top edge) and
    /// `chromeHeight` (which is this plus row 2 itself and its gap).
    static func rowTwoContentTop(offline: Bool) -> CGFloat {
        var total = listHeaderPadding + navRow + sectionGap
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
    /// `rowTwoContentTop - scrolled`. The pinned copy is an overlay resting at
    /// `pinnedChipsTopInset`. There is exactly ONE offset where those agree, and handing
    /// off anywhere else teleports the bar by the difference — measured on the built
    /// binary as a 10.66pt hop UP with no frame in between, because the threshold then
    /// counted only the rows above the chips (`navRow + sectionGap`) and the List puts
    /// `listHeaderPadding` above them as well.
    ///
    /// So it is DERIVED from the same layout numbers the row is placed from, never
    /// hand-tuned until the flip looks smooth:
    /// `TasksBoardChipRowPinTests.testThePinFiresExactlyWhereTheTwoCardsCoincide` feeds
    /// both real containers through `BoardBandRailGeometry.layout` and compares the two
    /// cards as SCREEN RECTS at this offset.
    ///
    /// Still deliberately NOT `chromeHeight`, which includes the chip row itself:
    /// pinning a row-2 header only after row 2 has fully left is a chip row that scrolls
    /// away, and the 22pt in between would be spent watching the capsules get sliced by
    /// the top edge.
    static func chipsPinThreshold(offline: Bool) -> CGFloat {
        rowTwoContentTop(offline: offline) - pinnedChipsTopInset
    }

    /// Dead band under the pin point.
    ///
    /// Small on purpose, and it must NOT be `hysteresisBand`. Two separate ceilings:
    ///
    ///  - A wide (sticky-to-the-top) band would keep the pinned bar over the top 44pt of
    ///    the list while the NAV ROW is back on screen underneath it — re-creating, on
    ///    the way up, exactly the covered-nav-row defect this rebuild removes.
    ///  - The band IS the residual hop. `chipsPinThreshold` is the only offset where the
    ///    two cards coincide, so unpinning one band EARLY brings the inline row back
    ///    `chipsPinBand` points below where the pinned copy just was. Down-scroll is
    ///    continuous to the point; up-scroll owes this much, and 4pt is what the frame
    ///    audit's own bar (a hop over 8pt reads as a jump) leaves room for. Zero is not
    ///    the answer either: a single threshold makes a touch-slop wobble at rest flip
    ///    the state, and each flip is a publish.
    ///
    /// This used to say the flip is invisible "because the pinned copy and the inline
    /// row are the same bar at the same place", which was WRONG on all three axes at once
    /// and is a good example of a comment asserting an invariant nothing enforced. R26
    /// fixed the
    /// X (the copies are handed different containers, so the pinned one laid out
    /// edge-to-edge and the crossing shifted every chip 16pt left); R27 fixed the Y and
    /// the STYLE (the pin fired 10.66pt early, and the pinned card drew square over a
    /// different backing where the inline one draws a 10pt rounded card on its own
    /// opaque surface). All three are enforced now: `BoardBandRailGeometry.layout`
    /// carries the inset AND the radius, `chipsPinThreshold` is derived from
    /// `rowTwoContentTop`, and `TasksBoardChipRowPinTests` feeds both real containers
    /// through them.
    static let chipsPinBand: CGFloat = 4

    static func chipsUnpinThreshold(offline: Bool) -> CGFloat {
        max(0, chipsPinThreshold(offline: offline) - chipsPinBand)
    }

    /// Pinned now? Same sticky shape as `isCollapsed`, one band narrower.
    static func areChipsPinned(scrolled: CGFloat, wasPinned: Bool, offline: Bool) -> Bool {
        if wasPinned { return scrolled > chipsUnpinThreshold(offline: offline) }
        return scrolled > chipsPinThreshold(offline: offline)
    }

    /// Does this filter have a chip row that CAN pin? Only the board does.
    ///
    /// Filter-only, and that is deliberate: it is the question `TasksView` asks to
    /// decide whether the pinned copy EXISTS, and existence must not depend on the pin
    /// state. It used to (`showsPinnedChips`), which made the overlay a conditional
    /// insertion — so every crossing destroyed one `BoardBandBar` and built another,
    /// and a rail `ScrollView` that came up measured at zero width stayed chipless for
    /// the life of that instance. Both copies are permanent now and
    /// `BoardBandBar.drawsChips` decides which one draws.
    static func hasPinnedChips(_ filter: TaskFilter) -> Bool {
        filter == .sessions
    }

    /// Whether the pinned copy is the one showing right now — the composed rule, kept
    /// because it states the whole answer in one place (and the flip tests pin it).
    ///
    /// DERIVED from `hasPinnedChips` rather than repeating `filter == .sessions`: two
    /// copies of "which filter has chips" is exactly the kind of pair that drifts, and
    /// this one is now read by a view (existence) and by tests (visibility).
    static func showsPinnedChips(filter: TaskFilter, pinned: Bool) -> Bool {
        hasPinnedChips(filter) && pinned
    }

    /// Total scrollable header height for a filter — every row this filter puts above its
    /// first task row, which is what the COMPACT BAR has to stand in for.
    ///
    /// # Who reads it, and who does not (2026-09-02 review)
    ///
    /// Only the compact bar's machine: `collapseThreshold` → `expandThreshold` →
    /// `isCollapsed`. The BOARD has no compact bar (`hasCompactBar` is false for it, and
    /// `isCollapsed` now refuses to run at all for such a filter), so the board branch below
    /// answers nobody in the app; the board's own live threshold is `chipsPinThreshold`,
    /// which counts what rides ABOVE row 2 and is therefore untouched by anything under the
    /// chips.
    ///
    /// The board's rows are still counted, deliberately. This function is documented as the
    /// filter's header height and it is the one place that arithmetic is written down, so a
    /// branch that quietly omitted two rows the board really renders would be a wrong answer
    /// for the next reader rather than a saving. What was removed is the CLAIM that counting
    /// them protects the collapse threshold on the board: nothing there collapses, and a
    /// justification that names a path nobody walks is how a number survives a review it
    /// should not have.
    ///
    /// Everything above row 2 comes from `rowTwoContentTop` rather than being re-added
    /// here: the pin threshold reads the same function, and two copies of "what rides
    /// above the chips" is how the two answers drifted by `listHeaderPadding` in the
    /// first place.
    static func chromeHeight(filter: TaskFilter, offline: Bool) -> CGFloat {
        // The board: chips in row 2, the view bar (grouping + date chips) in row 3, then
        // the quick add. Every other filter: the quick add IS row 2.
        let rowsBelowTheTop = filter == .sessions
            ? bandBar + sectionGap + viewBar + sectionGap + quickAdd
            : quickAdd
        return rowTwoContentTop(offline: offline) + rowsBelowTheTop + sectionGap
    }

    /// Scroll distance past which the chrome is gone and the bar takes over.
    /// Sits a hair BEFORE the chrome fully clears so the bar is already there
    /// when the last chip leaves, rather than blinking in afterwards.
    ///
    /// The lower bound is `collapseLead`, and it used to be `hysteresisBand` (96),
    /// named `collapseFloor`. That floor was derived when the leanest chrome was
    /// 106pt, so it never actually bound; the header rebuild took every filter to
    /// 92-96pt and it began binding on ALL of them, at which point it inverted the
    /// invariant it was written to protect. A threshold of 96 against 96pt of
    /// chrome means the bar arrives only once the chrome is completely gone, so the
    /// crossing is spent with no filter switcher on screen at all. (With
    /// `listHeaderPadding` counted the filters now measure 103-107pt, so a 96 floor
    /// would still bind — it would just eat most of the lead instead of all of it.
    /// A bound that only holds while a number nobody is watching stays large enough
    /// is not a bound.) Preserving a
    /// full-width dead band was never worth that, and a dead band that CLAMPS (see
    /// `expandThreshold`) still cannot strobe: the collapsed state is sticky until
    /// the list is back at the very top.
    ///
    /// What the bound still buys: a threshold under the lead itself would let one
    /// touch-slop wobble at rest collapse the chrome.
    static func collapseThreshold(filter: TaskFilter, offline: Bool) -> CGFloat {
        max(collapseLead, chromeHeight(filter: filter, offline: offline) - collapseLead)
    }

    /// Scroll distance below which the real chrome is back on screen and the bar
    /// must go away. Deliberately far below `collapseThreshold`: a single
    /// threshold flickers the bar in and out during a rubber-band bounce.
    ///
    /// It clamps at 0, and with the header rebuild's 103-107pt of chrome the clamp is
    /// now the normal case rather than the corner one, so the dead band is
    /// `min(hysteresisBand, collapseThreshold)` wide. That is still a guard and not
    /// a hole: once collapsed the bar stays until the list is at the very top, so
    /// no wobble at the collapse threshold can flip it back, and the only place a
    /// clamped band can be re-crossed is a rubber-band bounce at 0 — where the real
    /// chrome is on screen and the bar SHOULD be gone.
    static func expandThreshold(filter: TaskFilter, offline: Bool) -> CGFloat {
        max(0, collapseThreshold(filter: filter, offline: offline) - hysteresisBand)
    }

    /// The dead band a filter actually gets, which is what the tests pin: the full
    /// `hysteresisBand` when the chrome is tall enough to afford it, and the whole
    /// travel to the top when it is not.
    static func deadBand(filter: TaskFilter, offline: Bool) -> CGFloat {
        collapseThreshold(filter: filter, offline: offline)
            - expandThreshold(filter: filter, offline: offline)
    }

    /// How far before the chrome fully clears the bar appears. Doubles as the floor
    /// under `collapseThreshold` — see there for why that replaced `collapseFloor`.
    static let collapseLead: CGFloat = 24
    /// Widest dead band between collapse and expand. Wider than any rubber-band
    /// wobble and wider than one task row, so a slow drag can't strobe the bar.
    /// A filter with less chrome than this gets a proportionally narrower one
    /// (`deadBand`), never a delayed bar.
    static let hysteresisBand: CGFloat = 96

    /// The state machine: given how far the list is scrolled and whether the bar
    /// is currently showing, should it show now? Pure so it can be tested without
    /// a running app.
    ///
    /// # A filter with nothing to collapse INTO never collapses
    ///
    /// The guard is not a shortcut, it is what keeps this answer from having a cost with no
    /// effect (2026-09-02 review). `TasksView` publishes the result into `@State` inside a
    /// `withAnimation`, and `@State` on that view is read by its whole body — so on the BOARD,
    /// which draws no compact bar, crossing this threshold used to invalidate the board
    /// derive, the chips and the List diff to toggle a flag nothing draws. That is precisely
    /// the hitch `BoardChipsPinLatch` was built to keep off the scroll path, arriving through
    /// the other threshold on the same handler.
    ///
    /// It also makes the rule ONE rule: `hasCompactBar` decides whether a filter has a bar,
    /// and now decides whether it has a collapse as well, instead of the second half being an
    /// accident of `showsCompactBar` discarding a true.
    ///
    /// - Parameter scrolled: points scrolled down from the top of the content
    ///   (`contentOffset.y + contentInsets.top`; 0 at rest, negative while
    ///   rubber-banding past the top).
    static func isCollapsed(
        scrolled: CGFloat, wasCollapsed: Bool, filter: TaskFilter, offline: Bool
    ) -> Bool {
        guard hasCompactBar(filter) else { return false }
        if wasCollapsed {
            return scrolled > expandThreshold(filter: filter, offline: offline)
        }
        return scrolled > collapseThreshold(filter: filter, offline: offline)
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
    /// this screen's hysteresis machines have their crossing inside the first ~57pt of
    /// travel (`chipsPinThreshold` is 56.66) and their dead bands are 4pt and 96pt, so a
    /// ~52pt step in ONE sample crosses whatever it is nearest — and then crosses back as
    /// the drag continues. Two spurious flips per machine, each one a publish, all of them
    /// inside the frame the drawer is re-laying the header out on. Frames:
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

/// Coalescing gate between the scroll-geometry stream and the ONE `@State` write
/// a threshold crossing needs.
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

/// Where the board's "row 2 has reached the top edge" flag LIVES, and the reason it
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
    /// True once the board's chip row (header row 2) has reached the top edge, so the
    /// pinned copy stands in for it.
    ///
    /// Starts false and is reset to false on a filter switch: unpinned is always safe
    /// to be wrong about (the inline row simply draws the chips where its own content
    /// position puts them, and the next geometry sample re-pins), while a stale true
    /// would draw the floating copy over the nav pills.
    var isPinned = false
}

/// The compact header that replaces the scrolled-away chrome: every HEADER ENTRY
/// as a one-tap chip with its count, plus a one-tap add. Floats over the top of
/// the list on `.bar` material, the way iOS floating headers do.
///
/// It iterates `TasksNavEntry`, not `TaskFilter.allCases`, and that is load-bearing
/// rather than tidy: the header now offers TWO destinations, so a bar offering six
/// would be the one place a user could reach a filter the header cannot show — they
/// would land on Today (or, since this round, on All Tasks) with no chip selected and
/// no way back except the fallback. The bar and the nav row read from the same entry
/// set, so the two can never disagree about what exists, and dropping an entry drops
/// it from both at once.
///
/// The chip identifiers stay keyed by `TaskFilter.identifierKey`
/// (`tasks.compactChip.sessions` / `.calendarview`) because shipped flows tap them.
/// `tasks.compactChip.all` goes away with its entry, exactly as `tasks.nav.all` does:
/// an id that still resolves but drives a different destination is worse than one that
/// resolves to nothing.
struct TasksCompactBar: View {
    @Binding var activeFilter: TaskFilter
    /// Bring the real header back (chip taps scroll to the top, which is also how
    /// the user gets the search field and quick add back).
    let scrollToTop: () -> Void
    /// One-tap add that survives the collapse — the full form, seeded empty.
    let addTask: () -> Void

    @Environment(TasksStore.self) private var tasks

    var body: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(TasksNavEntry.allCases) { entry in
                        chip(entry)
                    }
                }
                .padding(.horizontal, 12)
            }
            Button {
                addTask()
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Theme.tint)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 12)
            .accessibilityLabel("New Task")
            .accessibilityIdentifier("tasks.compactAdd")
        }
        .frame(height: TasksChromeMetrics.compactBarHeight)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityIdentifier("tasks.compactBar")
    }

    private func chip(_ entry: TasksNavEntry) -> some View {
        let selected = TasksNavEntry.entry(for: activeFilter) == entry
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            activeFilter = entry.filter
            // Switching filters shows the top of the NEW list — which also
            // restores the full header, so the bar is never a one-way door.
            scrollToTop()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: entry.systemImage)
                    .font(.caption2.weight(.bold))
                Text(entry.title)
                    .font(.footnote.weight(.semibold))
                // Calendar has no meaningful count (it's a grid, not a list), and
                // a "0" there reads as "nothing on your calendar".
                if entry != .calendar {
                    Text(tasks.count(for: entry.filter).formatted(.number))
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .opacity(0.7)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(selected ? Color.white : Color.secondary)
            .background(
                selected ? AnyShapeStyle(Theme.tint) : AnyShapeStyle(.quaternary),
                in: Capsule()
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tasks.compactChip.\(entry.filter.identifierKey)")
    }
}
