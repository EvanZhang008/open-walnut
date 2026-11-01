import SwiftUI

/// The callbacks a board row needs, wherever it is drawn (a band, or a status section).
struct BoardRowActions {
    let onToggleDone: (BoardRow) -> Void
    let onPickTier: (BoardRow, BoardModel.TierToken) -> Void
    let onOpenSession: (BoardRow) -> Void
    let onOpenDetail: (BoardRow) -> Void
    /// Watch or stop watching the row's task. nil = the menu offers no Watch item.
    var onToggleWatch: ((BoardRow) -> Void)? = nil
}

/// A status section's heading: icon, label, count and chevron, the whole line one tap that
/// opens or folds the section (the web's `StatusSectionHeading`). Drawn as a grouped-list
/// section header, on the page colour like the band headings below it.
struct BoardStatusHeading: View {
    let section: BoardStatusSection
    let count: Int
    let open: Bool
    let onToggle: () -> Void
    @Environment(\.leadingDrawer) private var drawer
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: section.systemImage)
                .font(.system(BoardHeadingType.label, weight: .semibold))
                .foregroundStyle(Self.tint(section))
                .accessibilityHidden(true)
            Text(section.label)
                .font(.system(BoardHeadingType.label, weight: .bold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(2)
            Text(count.formatted(.number))
                .font(.system(BoardHeadingType.count, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(BoardHeadingType.countInk)
                .accessibilityIdentifier("board.section.\(section.rawValue).count")
            Spacer(minLength: 6)
            Image(systemName: "chevron.down")
                .font(.system(BoardHeadingType.count, weight: .semibold))
                .foregroundStyle(BoardHeadingType.countInk)
                .rotationEffect(.degrees(open ? 0 : -90))
                .accessibilityHidden(true)
        }
        .padding(.top, TaskBoardList.headingTopGap + 4)
        .padding(.bottom, open ? 6 : TaskBoardList.collapsedHeadingBottom + 4)
        .contentShape(Rectangle())
        .onTapGesture {
            // A drawer close drag that started on a heading must not also fold it.
            guard drawer?.suppressTaps != true else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onToggle()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(section.label), \(count)")
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityHint(open ? "Hides \(section.label)" : "Shows \(section.label)")
        .accessibilityAction { onToggle() }
        .accessibilityIdentifier("board.section.\(section.rawValue)")
    }

    /// The icon's colour: the same meaning the row dots and the web's headings carry.
    static func tint(_ section: BoardStatusSection) -> Color {
        switch section {
        case .watching: return Theme.tint
        case .needs: return Theme.danger
        case .working: return BoardHeadingType.ink
        case .waiting: return Theme.warning
        case .done: return Theme.success
        }
    }
}

/// One status section that draws its own rows (Watching, Needs you, Waiting / snoozed,
/// Completed): the heading, then the rows run by project, a small project label above each
/// run when the section spans two or more projects, then a "Show N more" row past 30.
///
/// Emits List `Section`s, like `TaskBoardList`: one per project run, the status heading in the
/// first one's header. Its rows are the board's own rows (`TaskBoardRow`), with the same tap,
/// swipe and long-press menu, so a task acts the same in a section as in a band.
struct BoardStatusSectionList: View {
    let section: BoardStatusSection
    let rows: [BoardRow]
    let open: Bool
    /// How many rows the section may draw now (`BoardStatusSectionModel.batch` and up).
    let shown: Int
    let onToggle: () -> Void
    let onShowMore: () -> Void
    let actions: BoardRowActions
    let tierChoices: [(id: String, label: String)]
    let tierOf: [String: String]
    var newRowId: String? = nil
    var resolvingRowId: String? = nil

    var body: some View {
        let runs = BoardStatusSectionModel.projectRuns(rows)
        let visible = open ? BoardStatusSectionModel.visibleRuns(runs, shown: shown) : []
        // A lone project label separates nothing: labels only for two or more projects.
        let labelled = runs.count > 1
        if visible.isEmpty {
            Section {
                EmptyView()
            } header: {
                heading
            }
            .listSectionSpacing(0)
        } else {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, run in
                Section {
                    ForEach(run.rows) { row in
                        cell(row, run: run, showsProject: !labelled)
                    }
                    if index == visible.count - 1,
                       let more = BoardStatusSectionModel.showMoreLabel(total: rows.count, shown: shown) {
                        Button(action: onShowMore) {
                            Text(more)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Theme.tint)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("board.section.\(section.rawValue).more")
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 0) {
                        if index == 0 { heading }
                        if labelled { projectLabel(run.label, first: index == 0) }
                    }
                    .textCase(nil)
                    .padding(.horizontal, BoardBandCard.headingContentInset)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(BoardBandCard.page)
                    .listRowInsets(EdgeInsets())
                }
                .listSectionSpacing(0)
            }
        }
    }

    private var heading: some View {
        BoardStatusHeading(section: section, count: rows.count, open: open, onToggle: onToggle)
            .textCase(nil)
            .padding(.horizontal, BoardBandCard.headingContentInset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(BoardBandCard.page)
            .listRowInsets(EdgeInsets())
    }

    private func projectLabel(_ label: String, first: Bool) -> some View {
        Text(label)
            .font(.system(BoardHeadingType.folderLabel, weight: .semibold))
            .foregroundStyle(BoardHeadingType.ink)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.top, first ? 2 : 12)
            .padding(.bottom, 6)
            .accessibilityIdentifier("board.section.\(section.rawValue).project.\(TaskBoardList.slug(label))")
    }

    /// The board's row, with the same chrome `TaskBoardList` gives a band row. Modifiers stay
    /// here, on the ForEach's direct child, because `swipeActions` only works there.
    private func cell(_ row: BoardRow, run: BoardSectionRun, showsProject: Bool) -> some View {
        TaskBoardRow(
            row: row,
            showsProject: showsProject,
            isResolving: row.id == resolvingRowId,
            onToggleDone: { actions.onToggleDone(row) },
            onOpenSession: { actions.onOpenSession(row) }
        )
        .id(TaskBoardList.rowAnchorId(row.id))
        .listRowBackground(TaskBoardList.rowSurface(row, newRowId: newRowId))
        .alignmentGuide(.listRowSeparatorLeading) { _ in TaskBoardRow.separatorLeadingInset }
        .listRowSeparator(row.id == run.rows.last?.id ? .hidden : .visible, edges: .bottom)
        .listRowSeparator(row.id == run.rows.first?.id ? .hidden : .automatic, edges: .top)
        .modifier(BoardRowGestures(
            row: row,
            tierChoices: tierChoices,
            currentTier: row.task.flatMap { tierOf[$0.id] },
            onToggleDone: { actions.onToggleDone(row) },
            onPickTier: { actions.onPickTier(row, $0) },
            onOpenSession: { actions.onOpenSession(row) },
            onOpenDetail: { actions.onOpenDetail(row) },
            onToggleWatch: actions.onToggleWatch.map { toggle in { toggle(row) } }
        ))
    }
}

/// The Working heading, a header-only section above the bands (which are Working's rows).
struct BoardWorkingHeading: View {
    let count: Int
    let open: Bool
    let onToggle: () -> Void

    var body: some View {
        Section {
            EmptyView()
        } header: {
            BoardStatusHeading(section: .working, count: count, open: open, onToggle: onToggle)
                .textCase(nil)
                .padding(.horizontal, BoardBandCard.headingContentInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(BoardBandCard.page)
                .listRowInsets(EdgeInsets())
        }
        .listSectionSpacing(0)
    }
}

/// The long-press menu's Watch item, one place for its words and glyph.
enum BoardWatchItem {
    static func label(watched: Bool) -> String { watched ? "Stop watching" : "Watch" }
    static func systemImage(watched: Bool) -> String { watched ? "eye.slash" : "eye" }
}
