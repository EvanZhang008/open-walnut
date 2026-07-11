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
            // Session rows push a full-screen conversation page instead of a sheet.
            .navigationDestination(for: WalnutSession.self) { session in
                SessionConversationView(session: session)
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

            // Live sessions ride the top of every task filter (except the
            // Sessions filter, which shows the full Pinned/Active/Recent list).
            if activeFilter != .sessions {
                activeSessionsSection
            }

            if activeFilter == .sessions {
                sessionSections
            } else if sections.isEmpty {
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
        case .sessions: return "No agent sessions."
        case .allOpen: return "No open tasks."
        case .done: return "No recent completions."
        }
    }

    // MARK: - Active sessions (pinned on top of every non-Sessions filter)

    /// Up to 5 alive sessions surfaced above the task list. Prefers pinned-and-
    /// alive; falls back to the most-recently-active alive sessions when nothing
    /// pinned is currently running. Hidden entirely when nothing is alive.
    @ViewBuilder
    private var activeSessionsSection: some View {
        let pinnedAlive = tasks.pinnedSessions.filter { $0.statusKind.isAlive }
        let source = pinnedAlive.isEmpty ? tasks.activeSessions : pinnedAlive
        let rows = Array(source.prefix(5))
        if !rows.isEmpty {
            Section("Active Sessions") {
                ForEach(rows) { session in sessionRow(session) }
            }
        }
    }

    // MARK: - Sessions tab

    /// PINNED on top, then ACTIVE (live process), then RECENT (stopped) —
    /// mirrors the desktop Task panel's session tab structure. Pin state is
    /// inherited from the owning task, so MANY old stopped sessions carry
    /// pinned=true; the Pinned section only surfaces the ones still alive,
    /// everything dead sorts into Recent by recency.
    @ViewBuilder
    private var sessionSections: some View {
        let pinned = tasks.pinnedSessions.filter { $0.statusKind.isAlive }
        let pinnedIds = Set(pinned.map(\.id))
        let active = tasks.activeSessions.filter { !pinnedIds.contains($0.id) }
        let recent = tasks.sessions
            .filter { !$0.statusKind.isAlive }
            .sorted(by: WalnutSession.recencySort)

        if tasks.sessionsNotSyncedYet && tasks.sessions.isEmpty {
            Section {
                Text("Sessions not synced yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else if pinned.isEmpty && active.isEmpty && recent.isEmpty {
            Section {
                Text(emptyText)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else {
            if !pinned.isEmpty {
                Section("Pinned") {
                    ForEach(pinned) { session in sessionRow(session) }
                }
            }
            if !active.isEmpty {
                Section("Active") {
                    ForEach(active) { session in sessionRow(session) }
                }
            }
            if !recent.isEmpty {
                Section("Recent") {
                    ForEach(recent) { session in sessionRow(session) }
                }
            }
        }
    }

    private func sessionRow(_ session: WalnutSession) -> some View {
        NavigationLink(value: session) {
            SessionRowView(session: session)
        }
        .accessibilityIdentifier("sessions.row.\(session.id)")
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
        case .sessions: return .indigo
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
