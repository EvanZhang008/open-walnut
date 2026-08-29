import SwiftUI

/// The board: one scroll of task rows grouped into sticky tier bands, with a
/// letter rail to teleport between them and a create affordance at the foot of
/// each band.
///
/// Why a `List` with `Section` headers rather than a hand-rolled `LazyVStack` +
/// pinned headers: `insetGrouped`'s section headers already stick, already float
/// on the right material, and cost nothing extra. A hand-rolled sticky header
/// needs its own scroll-geometry observation, and publishing `@State` from a
/// scroll callback is the P0-2 class of bug this app has already shipped once
/// (see `ScrollBottomTracking`). The rail uses `ScrollViewReader` — an id-based
/// jump, no geometry at all — for the same reason.
struct TaskBoardList: View {
    let bands: [BoardBand]
    let tierChoices: [(id: String, label: String)]
    /// Bands whose `hide done` is on.
    let hiddenDoneTiers: Set<String>
    /// Which band's create row is open (nil = none).
    let openCreateTier: String?
    /// Just-created row id — keeps a green edge so its landing place is visible.
    let newRowId: String?
    /// taskId → tier id, for the tier menu's checkmark.
    let tierOf: [String: String]

    let onToggleHideDone: (String) -> Void
    let onToggleCreate: (String) -> Void
    let onToggleDone: (BoardRow) -> Void
    let onPickTier: (BoardRow, BoardModel.TierToken) -> Void
    let onOpenSession: (BoardRow) -> Void
    let onOpenDetail: (BoardRow) -> Void
    /// The band's create row, rendered by the owner (it needs the store).
    let createRow: (String) -> AnyView

    /// A band's heading id, so the rail can scroll to it.
    static func anchorId(_ tierId: String) -> String { "board.band.\(tierId)" }

    var body: some View {
        ForEach(bands) { band in
            Section {
                ForEach(band.rows) { row in
                    TaskBoardRow(
                        row: row,
                        state: BoardModel.state(task: row.task, session: row.session),
                        isNew: row.id == newRowId,
                        onToggleDone: { onToggleDone(row) },
                        onOpenSession: { onOpenSession(row) }
                    )
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 12))
                    .modifier(BoardRowGestures(
                        row: row,
                        tierChoices: tierChoices,
                        currentTier: row.task.flatMap { tierOf[$0.id] },
                        onToggleDone: { onToggleDone(row) },
                        onPickTier: { onPickTier(row, $0) },
                        onOpenSession: { onOpenSession(row) },
                        onOpenDetail: { onOpenDetail(row) }
                    ))
                }
                // Create at the FOOT of the band — where the just-created row
                // then stays put, because a new pin's pin_order is max+1. The
                // affordance and the outcome are in the same place, which is
                // what the Reminders behaviour is actually about.
                if band.tierId != BoardModel.activeTierId {
                    createFoot(band)
                }
            } header: {
                heading(band)
            }
            .listSectionSpacing(2)
        }
    }

    // MARK: - Sticky heading

    private func heading(_ band: BoardBand) -> some View {
        HStack(spacing: 7) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Self.tierColor(band.tierId))
                .frame(width: 3, height: 13)
            Text(band.label.uppercased())
                .font(.system(size: 11, weight: .bold))
                .kerning(0.6)
                .foregroundStyle(.secondary)
            // The done toggle lives on the heading it affects — a global switch
            // would hide completions in bands the user isn't looking at.
            if band.tierId != BoardModel.activeTierId {
                Button {
                    onToggleHideDone(band.tierId)
                } label: {
                    Text(hiddenDoneTiers.contains(band.tierId)
                        ? "show done\(band.hiddenDone > 0 ? " (\(band.hiddenDone))" : "")"
                        : "hide done")
                        .font(.system(size: 10.5, weight: .semibold))
                        .textCase(nil)
                        .foregroundStyle(Theme.tint)
                        .frame(height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("board.hideDone.\(Self.slug(band.tierId))")
            }
            Spacer(minLength: 6)
            Text(band.count.formatted(.number))
                .font(.system(size: 11, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .accessibilityIdentifier("board.count.\(Self.slug(band.tierId))")
        }
        .id(Self.anchorId(band.tierId))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.heading.\(Self.slug(band.tierId))")
    }

    // MARK: - Create at the foot

    @ViewBuilder
    private func createFoot(_ band: BoardBand) -> some View {
        if openCreateTier == band.tierId {
            createRow(band.tierId)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 12))
        } else {
            Button {
                onToggleCreate(band.tierId)
            } label: {
                HStack(spacing: 11) {
                    Circle()
                        .strokeBorder(Theme.tint, style: StrokeStyle(lineWidth: 1.4, dash: [3, 2.5]))
                        .frame(width: 21, height: 21)
                    Text("New task in \(band.label)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.tint)
                    Spacer(minLength: 0)
                }
                .frame(height: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 12))
            .accessibilityIdentifier("board.create.\(Self.slug(band.tierId))")
        }
    }

    // MARK: - Ids and colours

    /// Automation matches accessibility ids as REGEXES, so a raw tier id (a
    /// custom `ct_*` is fine, but a label-derived one would not be) is folded to
    /// `[a-z0-9_]`. Never contains `|`, which would read as an alternation.
    static func slug(_ raw: String) -> String {
        String(raw.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "_" })
    }

    /// Band accent. Built-ins get the desktop's colours so the two surfaces read
    /// as the same board; a custom tier gets the app tint rather than a random
    /// hue nobody chose.
    static func tierColor(_ tierId: String) -> Color {
        switch tierId {
        case "focus": return Color(red: 0.0, green: 0.48, blue: 1.0)
        case "satellite": return Color(red: 0.35, green: 0.34, blue: 0.84)
        case "backlog": return Color(red: 0.19, green: 0.69, blue: 0.78)
        case "wait": return Theme.warning
        case BoardModel.activeTierId: return Theme.success
        default: return Theme.tint
        }
    }
}

/// The row's SECOND affordance: everything about the task that isn't "open the
/// session".
///
/// This exists because the row's tap was spent on the session, on purpose. The
/// rejected design put all of this inline — a tier picker, a Details button, an
/// Open button — so one tap produced a menu and the user did the routing. Here
/// the tap is a destination and the settings live where iOS already puts row
/// settings: swipe for the two frequent toggles, long-press for the rest.
///
/// It is a ViewModifier rather than lines inside `TaskBoardRow` because
/// `swipeActions` only works on a direct child of a `List` row — applied inside
/// the row's own body it silently does nothing.
private struct BoardRowGestures: ViewModifier {
    let row: BoardRow
    let tierChoices: [(id: String, label: String)]
    let currentTier: String?
    let onToggleDone: () -> Void
    let onPickTier: (BoardModel.TierToken) -> Void
    let onOpenSession: () -> Void
    let onOpenDetail: () -> Void

    func body(content: Content) -> some View {
        content
            // Leading swipe = done↔reopen, matching Reminders and the other task
            // list in this app (TasksView's own rows do exactly this).
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(action: onToggleDone) {
                    Label(row.isDone ? "Reopen" : "Done",
                          systemImage: row.isDone ? "arrow.uturn.backward.circle" : "checkmark.circle.fill")
                }
                .tint(row.isDone ? .secondary : Theme.success)
            }
            // Trailing swipe = the task's own page. The row's tap opens the
            // SESSION, so this is the other half of the pair the user asked for:
            // "one is tapping the session, one is going into the task".
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(action: onOpenDetail) {
                    Label("Task", systemImage: "info.circle")
                }
                .tint(Theme.tint)
            }
            .contextMenu {
                Button(action: onOpenSession) {
                    Label(row.session == nil ? "Start Session" : "Open Session",
                          systemImage: row.session == nil ? "play.circle" : "bubble.left.and.text.bubble.right")
                }
                Button(action: onToggleDone) {
                    Label(row.isDone ? "Mark as To Do" : "Mark as Done",
                          systemImage: row.isDone ? "circle" : "checkmark.circle.fill")
                }
                // Tier move — this is where the wrapping token row went. A menu
                // shows the same closed set without spending any row height, and
                // it can't be clipped by the letter rail (which is what forced
                // the inline version to wrap in the first place).
                if row.canRetier {
                    Menu {
                        ForEach(BoardModel.tokens(current: currentTier, choices: tierChoices)) { token in
                            Button {
                                onPickTier(token)
                            } label: {
                                if token.selected {
                                    Label(token.label, systemImage: "checkmark")
                                } else {
                                    Text(token.label)
                                }
                            }
                        }
                    } label: {
                        Label("Move to Tier", systemImage: "square.stack.3d.up")
                    }
                }
                Button(action: onOpenDetail) {
                    Label("Details, dates & priority", systemImage: "slider.horizontal.3")
                }
            }
    }
}

/// The letter rail: one glyph per band, tapped to teleport to that heading.
///
/// Deliberately position-free. It does NOT track which band is on screen,
/// because that would need scroll geometry and a `@State` publish per sample —
/// the coalescing gate exists for the ONE bar that genuinely needs it, and
/// paying that cost again for decoration would be the wrong trade. A jump is
/// `scrollTo(anchor)`, which needs no measurement at all.
struct TaskBoardRail: View {
    /// Horizontal space a row must keep clear on its trailing edge so the rail
    /// never lands on top of row content. The rail is an overlay, so nothing in
    /// the layout flow knows it exists — every row that draws close to the
    /// trailing edge has to reserve this itself. `glyph + trailing padding + 4pt`.
    static let reservedWidth: CGFloat = 25

    let bands: [BoardBand]
    let onJump: (String) -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(bands) { band in
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onJump(band.tierId)
                } label: {
                    Text(band.letter)
                        .font(.system(size: 9.5, weight: .heavy))
                        .foregroundStyle(.secondary)
                        .frame(width: 19, height: 19)
                        .background(Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("board.rail.\(band.letter)")
                .accessibilityLabel("Jump to \(band.label)")
            }
        }
        .padding(.trailing, 2)
        // `children: .contain` before the container id, for the third time in this
        // feature: a container identifier REPLACES every descendant's, so the
        // hierarchy carried three elements all called `board.rail` and none called
        // `board.rail.F/S/B` — the glyphs were unaddressable and untappable by id.
        // (Measured: `[381,479][400,498] board.rail "Jump to Focus"` x3.) Any
        // wrapper that wants both its own id AND addressable children needs this.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.rail")
    }
}
