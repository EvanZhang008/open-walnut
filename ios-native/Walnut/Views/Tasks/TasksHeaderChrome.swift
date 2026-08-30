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
    // the real store: the quick-add row spans ~48pt and the offline banner ~44pt.
    // Section gaps are the `listSectionSpacing(2)` the chrome sections carry.

    /// The three-entry nav row (Pin | All Tasks | Calendar) — **row 1** of the
    /// header, and the FIRST thing in the scrollable content on every filter.
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
    static let bandBar: CGFloat = 44

    static let quickAdd: CGFloat = 48
    static let offlineBanner: CGFloat = 44
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

    /// The one question the board asks: draw the pinned chip row, or leave the
    /// inline one to do the job. Only the board has chips at all.
    static func showsPinnedChips(filter: TaskFilter, pinned: Bool) -> Bool {
        filter == .sessions && pinned
    }

    /// Total scrollable header height for a filter.
    ///
    /// The BOARD (the `.sessions` filter) is still the LEANEST. It drops the top
    /// quick add (every band ends in its own create ring) and pays for its chip row
    /// instead, which is 4pt cheaper — so its chrome leaves soonest, which is the
    /// point on the screen whose whole job is showing rows.
    ///
    /// Everything above row 2 comes from `rowTwoContentTop` rather than being re-added
    /// here: the pin threshold reads the same function, and two copies of "what rides
    /// above the chips" is how the two answers drifted by `listHeaderPadding` in the
    /// first place.
    static func chromeHeight(filter: TaskFilter, offline: Bool) -> CGFloat {
        let rowTwo = filter == .sessions ? bandBar : quickAdd
        return rowTwoContentTop(offline: offline) + rowTwo + sectionGap
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
    /// - Parameter scrolled: points scrolled down from the top of the content
    ///   (`contentOffset.y + contentInsets.top`; 0 at rest, negative while
    ///   rubber-banding past the top).
    static func isCollapsed(
        scrolled: CGFloat, wasCollapsed: Bool, filter: TaskFilter, offline: Bool
    ) -> Bool {
        if wasCollapsed {
            return scrolled > expandThreshold(filter: filter, offline: offline)
        }
        return scrolled > collapseThreshold(filter: filter, offline: offline)
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

/// The compact header that replaces the scrolled-away chrome: every HEADER ENTRY
/// as a one-tap chip with its count, plus a one-tap add. Floats over the top of
/// the list on `.bar` material, the way iOS floating headers do.
///
/// It iterates `TasksNavEntry`, not `TaskFilter.allCases`, and that is load-bearing
/// rather than tidy: the header now offers three destinations, so a bar offering
/// six would be the one place a user could reach a filter the header cannot show —
/// they would land on Today with no chip selected and no way back except the
/// fallback. The bar and the nav row read from the same entry set, so the two can
/// never disagree about what exists.
///
/// The chip identifiers stay keyed by `TaskFilter.identifierKey`
/// (`tasks.compactChip.sessions` / `.all` / `.calendarview`) because shipped flows
/// tap them.
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
