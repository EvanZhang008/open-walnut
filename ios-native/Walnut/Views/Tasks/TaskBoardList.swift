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
    /// Rows currently expanded, by row id.
    let expandedIds: Set<String>
    /// Bands whose `hide done` is on.
    let hiddenDoneTiers: Set<String>
    /// Which band's create row is open (nil = none).
    let openCreateTier: String?
    /// Just-created row id — keeps a green edge so its landing place is visible.
    let newRowId: String?
    /// taskId → tier id, for the token selection state.
    let tierOf: [String: String]

    let onToggleExpanded: (BoardRow) -> Void
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
                        expanded: expandedIds.contains(row.id),
                        currentTier: row.task.flatMap { tierOf[$0.id] },
                        tierChoices: tierChoices,
                        isNew: row.id == newRowId,
                        onToggleExpanded: { onToggleExpanded(row) },
                        onToggleDone: { onToggleDone(row) },
                        onPickTier: { onPickTier(row, $0) },
                        onOpenSession: { onOpenSession(row) },
                        onOpenDetail: { onOpenDetail(row) }
                    )
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 12))
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
