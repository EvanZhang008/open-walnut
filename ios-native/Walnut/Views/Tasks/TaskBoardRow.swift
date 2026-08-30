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
/// A row whose task is waiting on a human is marked with a saturated 3pt CAPSULE at
/// its leading edge — the desktop's rule for WHEN (`taskNeedsAction`: phase
/// AGENT_COMPLETE and not done), a phone's answer for HOW. It is a mark and not a
/// whole-row wash: the wash was the first version and it turned 8 of 11 visible rows
/// pink, so the list read as broken instead of the rows reading as urgent (the full
/// account is on `edgeAccent`'s overlay below). Either way the point is to be
/// findable while scrolling past, not to be readable once you stop.
struct TaskBoardRow: View {
    let row: BoardRow
    let state: BoardRowState
    /// Flash tint for a just-created row ("where did it land?").
    let isNew: Bool

    let onToggleDone: () -> Void
    /// The row's tap: open the session, or start one when the task has none.
    let onOpenSession: () -> Void

    /// Where the V1 hairline starts: at the TITLE, so the done-ring's gutter stays
    /// clear (mockup V1: `.row + .row::before { left: 48px }` against a 16px page
    /// margin, i.e. 32pt into the row's own content).
    ///
    /// Derived from the arithmetic below rather than eyeballed, because the two
    /// numbers it is made of live in this file and a separator that drifts off the
    /// title reads as a mistake: the ring's frame is 34pt wide with `-6` leading
    /// padding, so it occupies 28pt of layout, and the HStack spacing is 11pt.
    /// 28 + 11 = the title's leading edge. Change either and change this.
    ///
    /// Only the LEADING end is inset. The trailing end runs to the sheet's edge (see
    /// the trailing alignment guide in `TaskBoardList`), so the hairline is deliberate
    /// at both ends rather than inset 55pt on one side and 32pt short on the other.
    static let separatorLeadingInset: CGFloat = 39

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
        // ONE accent, at the row's leading edge: red for a row that wants a
        // human, green for a just-created row (the answer to "where did it
        // land?" is a place on screen, not a toast). Red wins — a task handed
        // back matters more than a task that was just made.
        //
        // It is a BAR and not a background wash on purpose. The first version
        // flooded the whole row with `rgba(255,59,48,0.08)`, ported from the
        // desktop's `.todo-panel-item-needs-action`. That recipe works on a
        // dense desktop table where a tinted row is one line among many; on a
        // phone's insetGrouped list every row is already its own white card, so
        // tinting the card turned 8 of 11 visible rows pink and the LIST read
        // as broken rather than the rows reading as urgent. A saturated 3pt
        // capsule against white is both calmer and easier to spot while
        // scrolling — the colour is the mark, not the paper.
        //
        // The container has since changed (V1: no cards, one sheet — see
        // TaskBoardList's header) and the conclusion is unchanged, which is why
        // the row was the one thing that restyle did not touch: a wash would tint
        // the same 8 of 11 rows, and on ONE continuous sheet it would read even
        // worse, as an unexplained gradient rather than as urgent rows.
        .overlay(alignment: .leading) {
            if let edge = edgeAccent {
                Capsule()
                    .fill(edge)
                    .frame(width: 3)
                    .padding(.vertical, 3)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - The leading red capsule: the task wants a human

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

    /// The single leading-edge colour, or nil for an ordinary row. Red beats
    /// green: two accents on one row would be two claims about the same 3pt.
    private var edgeAccent: Color? {
        if needsAction { return Theme.danger }
        if isNew { return Theme.success }
        return nil
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

    /// Colour for the state word on the second line.
    ///
    /// A needs-a-human row reads it GREY: the leading bar already says "red"
    /// louder than 11pt text can, so colouring the word too was the third copy
    /// of one message on a single row (bar, dot, word). The word still carries
    /// the information — it literally says "handed back" — it just doesn't
    /// compete for the alarm.
    private var stateColor: Color {
        if needsAction { return .secondary }
        switch state {
        case .running: return Theme.success
        case .handedBack: return Theme.danger
        case .waiting: return Theme.warning
        case .failed: return Theme.danger
        case .ended, .none: return .secondary
        }
    }

    /// The dot on the right edge says "this task has a session" on a scanning
    /// pass, which is what lets the row stay a row.
    ///
    /// It goes QUIET when the leading bar is already carrying the same message:
    /// a red bar on the left plus a red dot on the right is one fact stated
    /// twice, and doubling it is what made the list look alarmed instead of
    /// informative. A needs-a-human row keeps a small grey dot (there IS still a
    /// session, and the right edge is where that reads) while the bar owns the
    /// urgency.
    @ViewBuilder
    private var indicator: some View {
        if state != .none {
            Circle()
                .fill(needsAction ? Color.secondary.opacity(0.4) : stateColor)
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
