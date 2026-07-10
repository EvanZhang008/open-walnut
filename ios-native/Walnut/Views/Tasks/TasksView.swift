import SwiftUI

/// Tasks tab — read-only, Apple Reminders-style. A horizontally scrollable
/// grid of smart-list cards sits above the task list for the active filter,
/// grouped by category. v1 is read-only: rows and circles are NOT tappable to
/// mutate; tapping a row opens a detail sheet.
struct TasksView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(TasksStore.self) private var tasks

    @State private var activeFilter: TaskFilter = .today
    @State private var selected: WalnutTask?

    var body: some View {
        NavigationStack {
            Group {
                if tasks.notSyncedYet && tasks.tasks.isEmpty {
                    notSyncedState
                } else {
                    list
                }
            }
            .navigationTitle("Tasks")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { StatusBadge() }
            }
            .sheet(item: $selected) { task in
                TaskDetailSheet(task: task)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: - List

    private var sections: [(category: String, tasks: [WalnutTask])] {
        let filtered = tasks.tasks(for: activeFilter)
        let grouped = Dictionary(grouping: filtered) { task in
            task.category.isEmpty ? "Uncategorized" : task.category
        }
        // Preserve each group's already-sorted order; sort the headers A→Z.
        return grouped
            .map { (category: $0.key, tasks: $0.value) }
            .sorted { $0.category.localizedCaseInsensitiveCompare($1.category) == .orderedAscending }
    }

    private var list: some View {
        List {
            if !connection.online {
                OfflineBanner(text: "Offline — tasks are read-only from cache")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                SmartListCards(activeFilter: $activeFilter)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 8, trailing: 12))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if sections.isEmpty {
                Section {
                    Text(emptyText)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 24)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(sections, id: \.category) { section in
                    Section(section.category) {
                        ForEach(section.tasks) { task in
                            Button { selected = task } label: {
                                TaskRow(task: task)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("tasks.row.\(task.id)")
                        }
                    }
                }
            }

            if let synced = tasks.syncedAt {
                Section {
                    Text("Synced \(synced.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("tasks.list")
        .refreshable { await tasks.loadTasks() }
        .task { await tasks.loadTasks() }
        .animation(.snappy(duration: 0.25), value: activeFilter)
    }

    private var emptyText: String {
        switch activeFilter {
        case .today: return "Nothing due today."
        case .inProgress: return "No tasks in progress."
        case .allOpen: return "No open tasks."
        case .done: return "No recent completions."
        }
    }

    // MARK: - 503 not-synced state

    private var notSyncedState: some View {
        ContentUnavailableView {
            Label("Tasks not synced yet", systemImage: "arrow.triangle.2.circlepath")
        } description: {
            Text("This companion hasn't received its first task sync. Check back in a moment.")
        } actions: {
            Button("Retry") { Task { await tasks.loadTasks() } }
                .buttonStyle(.borderedProminent)
                .tint(Theme.tint)
        }
    }
}

// MARK: - Smart-list cards

/// Horizontally scrollable row of Reminders-style summary cards. Tapping a card
/// sets the active filter.
struct SmartListCards: View {
    @Binding var activeFilter: TaskFilter
    @Environment(TasksStore.self) private var tasks

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(TaskFilter.allCases) { filter in
                    SmartListCard(
                        filter: filter,
                        count: tasks.count(for: filter),
                        selected: activeFilter == filter
                    )
                    .onTapGesture {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        activeFilter = filter
                    }
                    .accessibilityIdentifier("tasks.card.\(filter.identifierKey)")
                }
            }
            .padding(.horizontal, 2)
        }
    }
}

struct SmartListCard: View {
    let filter: TaskFilter
    let count: Int
    let selected: Bool

    private var accent: Color {
        switch filter {
        case .today: return Theme.tint
        case .inProgress: return Theme.warning
        case .allOpen: return .secondary
        case .done: return Theme.success
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: filter.systemImage)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(accent, in: Circle())
                Spacer()
                Text("\(count)")
                    .font(.title.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
            }
            Text(filter.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(width: 130, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(selected ? accent : Color.clear, lineWidth: 2)
        }
    }
}
