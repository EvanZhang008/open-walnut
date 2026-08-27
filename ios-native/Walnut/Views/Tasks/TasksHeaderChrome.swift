import SwiftUI

/// The Tasks tab's header chrome, and the rule that decides when it has scrolled
/// far enough off screen to be replaced by a compact bar.
///
/// Why this exists: the cards / quick add / scope picker are already List rows, so
/// they scroll away on their own — but that leaves NO way to switch filters or add
/// a task without scrolling all the way back up. The compact bar is the survivor.
/// It is drawn as an OVERLAY (never a `safeAreaInset`): an inset that appears
/// mid-scroll changes the List's visible rect and yanks the content offset, which
/// is exactly the scroll-jump class of bug this app has been bitten by before.
/// An overlay costs zero layout and can never move a row.
enum TasksChromeMetrics {

    // Measured on an iPhone 16 Pro (402x874pt) from a `maestro hierarchy` dump of
    // the real store: the card strip's row spans ~104pt, the quick-add row ~48pt,
    // the segmented scope picker ~44pt, and the offline banner ~44pt. Section gaps
    // are the `listSectionSpacing(2)` the chrome sections carry.
    static let cardStrip: CGFloat = 104
    static let quickAdd: CGFloat = 48
    static let scopePicker: CGFloat = 44
    static let offlineBanner: CGFloat = 44
    static let sectionGap: CGFloat = 2

    /// The compact bar's own height. Kept slim: it floats over the rows, so every
    /// point here is a point of a task row the user can't read.
    static let compactBarHeight: CGFloat = 44

    /// Total scrollable header height for a filter. The scope picker only renders
    /// on the Sessions filter; the offline banner only when the server is away.
    static func chromeHeight(filter: TaskFilter, offline: Bool) -> CGFloat {
        var total = cardStrip + sectionGap + quickAdd + sectionGap
        if filter == .sessions { total += scopePicker + sectionGap }
        if offline { total += offlineBanner + sectionGap }
        return total
    }

    /// Scroll distance past which the chrome is gone and the bar takes over.
    /// Sits a hair BEFORE the chrome fully clears so the bar is already there
    /// when the last card leaves, rather than blinking in afterwards.
    static func collapseThreshold(filter: TaskFilter, offline: Bool) -> CGFloat {
        max(collapseFloor, chromeHeight(filter: filter, offline: offline) - collapseLead)
    }

    /// Scroll distance below which the real chrome is back on screen and the bar
    /// must go away. Deliberately far below `collapseThreshold`: a single
    /// threshold flickers the bar in and out during a rubber-band bounce.
    static func expandThreshold(filter: TaskFilter, offline: Bool) -> CGFloat {
        max(0, collapseThreshold(filter: filter, offline: offline) - hysteresisBand)
    }

    /// How far before the chrome fully clears the bar appears.
    static let collapseLead: CGFloat = 24
    /// Dead band between collapse and expand. Wider than any rubber-band wobble
    /// and wider than one task row, so a slow drag can't strobe the bar.
    static let hysteresisBand: CGFloat = 96
    /// Never collapse within the first screenful-of-nothing: with the chrome
    /// hidden (a filter that somehow renders none of it) the thresholds would
    /// collapse at ~0 and the bar would cover the very first row at rest.
    static let collapseFloor: CGFloat = 120

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

/// The compact header that replaces the scrolled-away chrome: every filter as a
/// one-tap chip with its count, plus a one-tap add. Floats over the top of the
/// list on `.bar` material, the way iOS floating headers do.
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
                    ForEach(TaskFilter.allCases) { filter in
                        chip(filter)
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

    private func chip(_ filter: TaskFilter) -> some View {
        let selected = activeFilter == filter
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            activeFilter = filter
            // Switching filters shows the top of the NEW list — which also
            // restores the full header, so the bar is never a one-way door.
            scrollToTop()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: filter.systemImage)
                    .font(.caption2.weight(.bold))
                Text(filter.title)
                    .font(.footnote.weight(.semibold))
                // The Calendar card has no meaningful count (it's a grid, not a
                // list), and a "0" there reads as "nothing on your calendar".
                if filter != .calendar {
                    Text(tasks.count(for: filter).formatted(.number))
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
        .accessibilityIdentifier("tasks.compactChip.\(filter.identifierKey)")
    }
}
