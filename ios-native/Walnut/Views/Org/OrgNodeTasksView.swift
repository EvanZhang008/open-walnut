import SwiftUI

/// An Org node's Tasks on the phone: its teams' work by status or by pin group, one short row per
/// task (its status circle and its name, as a Home row; a Needs you row also says what it asks), as
/// the web side bar's Tasks. A row opens the task's session.
struct OrgNodeTasksView: View {
    let nodeId: String
    let isMain: Bool
    /// A row was tapped: the node's page opens the task's session over itself (it owns what is
    /// over it, so a request it takes can take it down).
    let onOpenTask: (TaskOpenTarget) -> Void
    /// The org tree to show instead of reading it (a test's own); nil reads `GET /org` as always.
    var givenTree: OrgTreeWire? = nil

    @Environment(TasksStore.self) private var tasks
    @AppStorage("org.node.tasksMode", store: AppPrefs.defaults) private var modeRaw = OrgNodeTasksModel.Mode.status.rawValue
    /// The org's one copy (`OrgTreeStore`): the drawer's Org list reads the same one.
    @State private var org = OrgTreeStore.shared
    private var tree: OrgTreeWire? { givenTree ?? org.tree }
    private var loaded: Bool { givenTree != nil || org.tree != nil || org.answered }
    private var error: String? { givenTree != nil || org.failure == nil ? nil : "Couldn't load this team's work. Pull to try again." }
    /// Sections the user opened or closed, kept per node ("nodeId/section" keys); the rest
    /// follow their default. A new key since Working folds by default (2026-11-23): a flip kept
    /// against the old default would now open Working, so every node starts from the new one.
    @AppStorage("org.node.tasksFlipped2", store: AppPrefs.defaults) private var flippedRaw = ""
    private var flipped: Set<String> {
        Set(flippedRaw.split(separator: " ").compactMap { key in
            let parts = key.split(separator: "/", maxSplits: 1)
            return parts.count == 2 && parts[0] == Substring(nodeId) ? String(parts[1]) : nil
        })
    }
    private func flip(_ section: String) {
        let key = "\(nodeId)/\(section)"
        var keys = flippedRaw.split(separator: " ").map(String.init)
        if let i = keys.firstIndex(of: key) { keys.remove(at: i) } else { keys.append(key) }
        flippedRaw = keys.suffix(60).joined(separator: " ")
    }
    private var mode: OrgNodeTasksModel.Mode { OrgNodeTasksModel.Mode(rawValue: modeRaw) ?? .status }

    var body: some View {
        let mine = OrgNodeTasksModel.tasks(nodeId: nodeId, isMain: isMain, tree: tree, all: tasks.tasks)
        let sections = mode == .status
            ? OrgNodeTasksModel.statusSections(mine)
            : OrgNodeTasksModel.pinSections(mine, tiers: tasks.allTierChoices, tierOf: { tasks.tierId(for: $0.id) })
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // A small grouping menu, not a second segmented bar under Threads | Tasks | Brief,
                // so the page keeps one main switch.
                HStack {
                    Spacer()
                    Menu {
                        Picker("Group by", selection: $modeRaw) {
                            ForEach(OrgNodeTasksModel.Mode.allCases) { Text($0.label).tag($0.rawValue) }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text("Group: \(mode.label)")
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Group by \(mode.label)")
                    .accessibilityIdentifier("org.tasks.mode")
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(Theme.needsText)
                }
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if sections.isEmpty {
                    Text(mode == .status ? "No work under this team right now." : "No open work under this team.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 24)
                        .accessibilityIdentifier("org.tasks.empty")
                }
                ForEach(sections) { section in
                    sectionView(section)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { if givenTree == nil { await org.load() } }
        .task(id: nodeId) { if givenTree == nil { await org.load() } }
        // On screen, the work's statuses follow the feed.
        .onAppear { org.viewerAppeared() }
        .onDisappear { org.viewerLeft() }
        .accessibilityIdentifier("org.tasks")
    }

    private func isOpen(_ s: OrgNodeTasksModel.Section) -> Bool {
        s.openByDefault != flipped.contains(s.id)
    }

    private func sectionView(_ s: OrgNodeTasksModel.Section) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) {
                    flip(s.id)
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isOpen(s) ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(s.title).font(.subheadline.weight(.semibold))
                    Text("\(s.rows.count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(s.id == "needs" ? Theme.needsText : .secondary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isOpen(s) ? "Open" : "Folded")
            .accessibilityIdentifier("org.tasks.section.\(s.id)")
            if isOpen(s) {
                VStack(spacing: 0) {
                    ForEach(s.rows) { t in
                        Button { onOpenTask(TaskOpenTarget(id: t.id, title: t.title)) } label: { OrgTaskRow(task: t) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("org.tasks.row")
                        if t.id != s.rows.last?.id { Divider().padding(.leading, 44) }
                    }
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

}

/// One task of a node's work, as a Home row (`TaskRow`): its status circle and its name, nothing
/// else (2026-11-23, the user: "就显示一个名字", "remve the time also"). A Needs you row also says
/// what it asks, since that is what he answers; the web draws those as their ask cards.
struct OrgTaskRow: View {
    let task: WalnutTask
    /// The circle's slot; the row's text starts 12 + this + 12 points in.
    static let circleWidth: CGFloat = 20

    var body: some View {
        let state = TeamStatusModel.state(of: task)
        HStack(alignment: .top, spacing: 12) {
            // A fixed slot, so every row's name starts at one edge (and a test can find its line).
            StatusCircle(status: task.statusKind)
                .frame(width: OrgTaskRow.circleWidth)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(AskProjectName.displayTitle(task.title, project: task.project, orgRole: task.orgRole))
                    .foregroundStyle(task.isDone ? .secondary : .primary)
                    .strikethrough(task.isDone, color: .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if state == .needs, let line = OrgNodeTasksModel.line(task) {
                    Text(MarkdownParser.inline(line))
                        .font(.footnote)
                        .foregroundStyle(Theme.needsText)
                        // After the colour: a sheet reads the style of the view it hangs on, so a viewer or
                        // letter opened from this line would come up in the line's own tint.
                        .handlingFilePathLinks(source: OrgNodeTasksModel.lineSource(task))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
