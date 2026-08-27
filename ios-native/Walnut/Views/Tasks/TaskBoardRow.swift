import SwiftUI

/// One board row: a Reminders row until you tap it, and then it BECOMES the
/// session — last message, work state, and the tier picker, inline. Nothing
/// navigates and no card is created; the session is not a separate object here.
///
/// Row anatomy comes from V1 (the Reminders mock): leading ring, title, ONE grey
/// second line, and a small indicator on the right edge. What V4 adds is the
/// expansion, and one deliberate deviation from V1: the title clamps to two
/// lines while collapsed and shows in full when expanded. A 227-character title
/// is only truncated while you are scanning past it, which is the moment
/// truncation is a feature rather than a lie.
struct TaskBoardRow: View {
    let row: BoardRow
    let state: BoardRowState
    let expanded: Bool
    /// Tier the task is currently in (nil = not pinned) — drives which token
    /// reads as selected.
    let currentTier: String?
    let tierChoices: [(id: String, label: String)]
    /// Flash tint for a just-created row ("where did it land?").
    let isNew: Bool

    let onToggleExpanded: () -> Void
    let onToggleDone: () -> Void
    let onPickTier: (BoardModel.TierToken) -> Void
    /// Open the session's conversation page — the one thing on this row that
    /// genuinely IS somewhere else.
    let onOpenSession: () -> Void
    /// Full task detail (dates, priority, description) — still one tap away.
    let onOpenDetail: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary
            if expanded {
                expansion
                    // Only the row's OWN height changes, and the row you tapped
                    // is by definition on screen — so no row above the viewport
                    // moves and the scroll offset is untouched.
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 2)
        .background(isNew ? Theme.tintSoft : Color.clear)
        // A green leading edge on a just-created row: the answer to "where did
        // it land?" is a place on screen, not a toast.
        .overlay(alignment: .leading) {
            if isNew {
                Rectangle().fill(Theme.success).frame(width: 3)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Collapsed row (V1 anatomy)

    /// NOTE the shape here: the ring is a SIBLING of the tap target, not inside
    /// it, and the tap target is `children: .combine`.
    ///
    /// Both halves are load-bearing and were found by driving the real UI. An
    /// identifier on the enclosing HStack propagates to every descendant, so the
    /// hierarchy carried THREE elements called `board.row.<id>` (ring, title,
    /// second line) and none called `board.ring.<id>` — the container id had
    /// overwritten the ring's own. Automation taps the first match, which was the
    /// ring's 34x30 box, so "tap the row" toggled the task DONE instead of
    /// expanding it. `.combine` collapses the text column into ONE element that
    /// owns the id, and keeping the ring outside it leaves the ring addressable.
    private var summary: some View {
        HStack(alignment: .top, spacing: 11) {
            ring
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body)
                    .fontWeight(expanded ? .semibold : .regular)
                    .foregroundStyle(row.isDone ? .secondary : .primary)
                    .strikethrough(row.isDone, color: .secondary)
                    // The clamp IS the design: two lines scanning, everything
                    // when you have stopped to look.
                    .lineLimit(expanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                secondLine
            }
            // Spans to the indicator so the whole width right of the ring is a
            // tap target, not just the glyph-width of the text.
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: onToggleExpanded)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("board.row.\(row.id)")
            .accessibilityLabel(row.title)
            // `.combine` folds the second line into the row's label, so the state
            // word stays assertable ("running · 2m") without its own element.
            .accessibilityHint(expanded ? "Collapse" : "Expand to the session")
            .accessibilityAddTraits(.isButton)
            indicator
        }
    }

    /// V1's one glyph, reused: an open ring, or a filled ring with a tick when
    /// done. It is the done TOGGLE (Reminders muscle memory) — the row's tap
    /// belongs to the expansion, so the ring needs its own hit shape.
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

    /// ONE grey line, exactly as V1 has it: the work state (coloured when it
    /// wants a human), then the project. Never a second sentence — the point of
    /// the collapsed row is that it is a row.
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

    /// The session indicator when collapsed — the dot on the right edge is the
    /// ONLY thing that says "this task has a session" on a scanning pass, which
    /// is what lets the row stay a row.
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

    // MARK: - Expansion (the row BECOMES the session)

    private var expansion: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text("SESSION")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.tertiary)
                Text(stateText)
                    .font(.caption)
                    .foregroundStyle(stateColor)
                Spacer(minLength: 8)
                Button(row.session == nil ? "Start ›" : "Open ›", action: onOpenSession)
                    .font(.caption.weight(.bold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.tint)
                    .accessibilityIdentifier("board.open.\(row.id)")
            }
            sessionFacts
            if row.canRetier { tokens }
            Button("Details, dates & priority", action: onOpenDetail)
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(Theme.tint)
                .accessibilityIdentifier("board.detail.\(row.id)")
        }
        .padding(.top, 8)
        .padding(.leading, 34)
        // Wide enough to clear the letter rail. The rail is an OVERLAY, so the
        // layout system does not know it is there and will happily lay tokens
        // underneath it — measured on a 402pt iPhone, the rail's F/S/B glyphs sat
        // directly on top of the last token. `TaskBoardRail` is 19pt of glyph plus
        // 2pt of trailing padding, so this is that plus a hair of breathing room.
        .padding(.trailing, TaskBoardRail.reservedWidth)
        .padding(.bottom, 4)
        // `children: .contain` is REQUIRED before the container identifier: a
        // container id otherwise overwrites every descendant's, and the tier
        // tokens / Open / facts inside here would all report as
        // `board.expanded.<id>` and become unaddressable. (Measured on the real
        // hierarchy: without it, `board.facts.<id>` did not exist at all.)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.expanded.\(row.id)")
    }

    /// What the SESSION LIST payload actually knows about this session.
    ///
    /// The mock shows a "last message" quote here. The slim projection
    /// (`ProjectedSession`) carries no message text, and fetching one transcript
    /// per expanded row would be an N-per-row fan-out — the thing this codebase
    /// bans. So this degrades honestly: the facts it does have (machine, model,
    /// message count, when) instead of a quote it would have to invent. The
    /// `description` field is the closest thing to a summary the payload ships,
    /// so it is shown when present.
    @ViewBuilder
    private var sessionFacts: some View {
        if let session = row.session {
            VStack(alignment: .leading, spacing: 5) {
                if let description = session.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                HStack(spacing: 6) {
                    fact(session.isLocal ? "Mac" : session.host)
                    if let model = session.model {
                        fact(WalnutSession.shortModelName(model))
                    }
                    fact("\(session.messageCount) msg")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("board.facts.\(row.id)")
        } else {
            Text("No session has run for this task yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("board.facts.\(row.id)")
        }
    }

    private func fact(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .foregroundStyle(.secondary)
    }

    /// Move tier = tap a token. Two taps total (expand, pick) and no drag —
    /// a drag on a list this long means picking up a row and hunting for a
    /// heading that may be several screens away.
    /// WRAPS onto as many lines as it needs; deliberately NOT a horizontal
    /// ScrollView. This is a closed set of five-ish choices, and a scroller both
    /// hides some of them behind a gesture and clips the last one mid-word at the
    /// edge — which reads as a broken layout, not as "swipe for more". Measured on
    /// a 402pt-wide iPhone: `Unpin` was sliced in half and the letter rail sat on
    /// top of it. Wrapping costs one extra line and shows every option at once,
    /// which is the whole point of a two-tap move.
    private var tokens: some View {
        WrappingTokenRow(spacing: 6, lineSpacing: 6) {
            ForEach(BoardModel.tokens(current: currentTier, choices: tierChoices)) { token in
                Button {
                    onPickTier(token)
                } label: {
                    Text(token.label)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .foregroundStyle(token.selected ? Theme.onTint : Color.primary)
                        .background(
                            token.selected
                                ? AnyShapeStyle(Theme.tint)
                                : AnyShapeStyle(.quaternary),
                            in: Capsule()
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("board.tier.\(row.id).\(token.id)")
            }
        }
        .padding(.vertical, 1)
    }
}
