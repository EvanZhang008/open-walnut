import SwiftUI

/// An Org node's Tasks on the phone: its teams' work by status or by pin group, one short row per
/// task (its title and one line of what it does now), as the web side bar's Tasks. A row opens the
/// task's session.
struct OrgNodeTasksView: View {
    let nodeId: String
    let isMain: Bool

    @Environment(TasksStore.self) private var tasks
    @AppStorage("org.node.tasksMode") private var modeRaw = OrgNodeTasksModel.Mode.status.rawValue
    @State private var tree: OrgTreeWire?
    @State private var loaded = false
    @State private var error: String?
    /// Sections the user opened or closed on this visit; the rest follow their default.
    @State private var flipped: Set<String> = []
    @State private var target: TaskOpenTarget?

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
        .refreshable { await load() }
        .task(id: nodeId) { await load() }
        .sheet(item: $target) { target in
            TaskSessionSheet(target: target)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .accessibilityIdentifier("org.tasks")
    }

    private func isOpen(_ s: OrgNodeTasksModel.Section) -> Bool {
        s.openByDefault != flipped.contains(s.id)
    }

    private func sectionView(_ s: OrgNodeTasksModel.Section) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) {
                    if flipped.contains(s.id) { flipped.remove(s.id) } else { flipped.insert(s.id) }
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
                        Button { target = TaskOpenTarget(id: t.id, title: t.title) } label: { OrgTaskRow(task: t) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("org.tasks.row")
                        if t.id != s.rows.last?.id { Divider().padding(.leading, 30) }
                    }
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func load() async {
        do {
            tree = try await WalnutAPI().orgTree()
            error = nil
        } catch {
            if let api = error as? APIError, api.isCancelled { return }
            self.error = "Couldn't load this team's work. Pull to try again."
        }
        loaded = true
    }
}

/// One task of a node's work: its status dot, its title, one line of what it does now, and when.
struct OrgTaskRow: View {
    let task: WalnutTask

    var body: some View {
        let state = TeamStatusModel.state(of: task)
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(UserStatePill.color(state))
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let line = OrgNodeTasksModel.line(task) {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(state == .needs ? Theme.needsText : .secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if let at = WalnutTask.parseISO(task.userStatus?.at ?? task.updatedAt) {
                Text(RelativeTime.short(date: at))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
