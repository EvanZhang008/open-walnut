import SwiftUI

/// One board row. A row, and nothing else: leading ring, title, ONE grey second
/// line, a state dot on the right edge.
///
/// TAP GOES STRAIGHT INTO THE SESSION. There is no expansion. The first version
/// of this row grew an inline panel on tap (session header, host/model/count
/// capsules, a wrapping tier picker, an Open button, a Details button) and it was
/// rejected on sight: a tap that yields a menu of six choices is a tap that made
/// the user do the routing. One tap, one destination.
///
/// Everything the panel held is still reachable, through the gestures iOS
/// already spends on rows: swipe for done and pin, long-press for the task's own
/// settings (tier, details). Those cost no row height and no scanning attention,
/// which is why a Reminders row can afford them and an inline panel cannot.
///
/// A row whose task is waiting on a human turns RED, whole-row — the same rule
/// the desktop applies (`taskNeedsAction`: phase AGENT_COMPLETE and not done).
/// The colour is on the row background rather than on a badge because the point
/// is to be findable while scrolling past, not to be readable once you stop.
struct TaskBoardRow: View {
    let row: BoardRow
    let state: BoardRowState
    /// Flash tint for a just-created row ("where did it land?").
    let isNew: Bool

    let onToggleDone: () -> Void
    /// The row's tap: open the session, or start one when the task has none.
    let onOpenSession: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            ring
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body)
                    .foregroundStyle(row.isDone ? .secondary : .primary)
                    .strikethrough(row.isDone, color: .secondary)
                    // Two lines while scanning. The row never expands now, so
                    // this clamp is permanent — a title long enough to need a
                    // third line is a title to read on the task's own page.
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                secondLine
            }
            // Spans to the indicator so the whole width right of the ring opens
            // the session, not just the glyph-width of the text.
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpenSession)
            // NOTE the shape here: the ring is a SIBLING of this tap target, not
            // inside it, and the target is `children: .combine`.
            //
            // Both halves are load-bearing and were found by driving the real UI.
            // An identifier on the enclosing HStack propagates to every
            // descendant, so the hierarchy carried THREE elements called
            // `board.row.<id>` (ring, title, second line) and none called
            // `board.ring.<id>` — the container id had overwritten the ring's
            // own. Automation taps the first match, which was the ring's 34x30
            // box, so "tap the row" toggled the task DONE. `.combine` collapses
            // the text column into ONE element that owns the id, and keeping the
            // ring outside it leaves the ring addressable.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("board.row.\(row.id)")
            .accessibilityLabel(row.title)
            .accessibilityHint(row.session == nil ? "Start a session" : "Open the session")
            .accessibilityAddTraits(.isButton)
            indicator
        }
        .padding(.vertical, 2)
        .background(rowTint)
        // A leading edge bar: green for a just-created row (the answer to "where
        // did it land?" is a place on screen, not a toast), red for a row that
        // wants a human. Red wins — a task handed back matters more than a task
        // that was just made.
        .overlay(alignment: .leading) {
            if needsAction {
                Rectangle().fill(Theme.danger).frame(width: 3)
            } else if isNew {
                Rectangle().fill(Theme.success).frame(width: 3)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Whole-row red: the task wants a human

    /// The desktop's rule, verbatim (`web/src/utils/session-status.ts`
    /// `taskNeedsAction`): AGENT_COMPLETE and not done. Both surfaces have to
    /// agree about what red means, so this is a port and not a reinterpretation.
    ///
    /// It covers more than "the agent finished": a session error drives the phase
    /// to AGENT_COMPLETE, and so does a permission prompt or a question waiting
    /// for an answer. All three are the same thing to the person scrolling — work
    /// stopped and it is your turn.
    private var needsAction: Bool {
        guard let task = row.task else { return false }
        if task.isDone || task.phase == "COMPLETE" { return false }
        return task.phase == "AGENT_COMPLETE"
    }

    private var rowTint: Color {
        if needsAction { return Theme.dangerSoft }
        if isNew { return Theme.tintSoft }
        return .clear
    }

    // MARK: - Row parts

    /// One glyph: an open ring, or a filled ring with a tick when done. It is the
    /// done TOGGLE (Reminders muscle memory) — the row's tap belongs to the
    /// session, so the ring needs its own hit shape.
    private var ring: some View {
        Button(action: onToggleDone) {
            ZStack {
                Circle()
                    .strokeBorder(row.isDone ? Color.secondary : Color(.systemGray3), lineWidth: 1.6)
                    .background(row.isDone ? Circle().fill(Color.secondary) : Circle().fill(Color.clear))
                    .frame(width: 21, height: 21)
                if row.isDone {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color(.systemBackground))
                }
            }
            .frame(width: 34, height: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, -6)
        .accessibilityIdentifier("board.ring.\(row.id)")
        .accessibilityLabel(row.isDone ? "Reopen" : "Mark done")
    }

    /// ONE grey line: the work state (coloured when it wants a human), then the
    /// project. Never a second sentence — the point of the row is that it is a row.
    private var secondLine: some View {
        HStack(spacing: 5) {
            if state != .none {
                Text(stateText)
                    .foregroundStyle(stateColor)
                    .fontWeight(state == .running || state == .waiting || state == .handedBack ? .semibold : .regular)
                    .lineLimit(1)
                Text("·").foregroundStyle(.tertiary)
            }
            Text(row.project.isEmpty ? "Inbox" : row.project)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .font(.caption)
        // No identifier of its own: the parent combines this subtree into one
        // element, so an id here would be discarded anyway. The state IS readable
        // in automation — it is part of the combined row's label.
    }

    private var stateText: String {
        guard let age = ageText else { return state.word }
        return "\(state.word) · \(age)"
    }

    private var ageText: String? {
        guard let at = row.session?.lastActiveValue else { return nil }
        return BoardModel.shortAge(Date().timeIntervalSince(at))
    }

    private var stateColor: Color {
        switch state {
        case .running: return Theme.success
        case .handedBack: return Theme.danger
        case .waiting: return Theme.warning
        case .failed: return Theme.danger
        case .ended, .none: return .secondary
        }
    }

    /// The dot on the right edge is the ONLY thing that says "this task has a
    /// session" on a scanning pass, which is what lets the row stay a row.
    @ViewBuilder
    private var indicator: some View {
        if state != .none {
            Circle()
                .fill(stateColor)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
                .accessibilityHidden(true)
        } else {
            // Keep the title's right edge in the same place with or without a
            // session, so a band of mixed rows doesn't look ragged.
            Color.clear.frame(width: 9, height: 9)
        }
    }
}
