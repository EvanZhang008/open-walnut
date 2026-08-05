import SwiftUI

/// Tasks tab — read-only, Apple Reminders-style. A horizontally scrollable
/// grid of smart-list cards sits above the task list for the active filter,
/// grouped by project ("" = Inbox). v1 is read-only: rows and circles are NOT
/// tappable to mutate; tapping a row opens a detail sheet.
struct TasksView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(TasksStore.self) private var tasks

    @State private var activeFilter: TaskFilter = .sessions
    @State private var selected: WalnutTask?
    /// Explicit path so a freshly created session can push programmatically.
    @State private var navPath: [WalnutSession] = []
    @State private var showNewSession = false
    @State private var showNewTask = false
    /// Local search — filters tasks (title/project) and sessions
    /// (title/task/host/cwd) in place; no server round-trip.
    @State private var searchText = ""

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if tasks.notSyncedYet && tasks.tasks.isEmpty {
                    notSyncedState
                } else {
                    list
                }
            }
            .navigationTitle("Tasks")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search tasks & sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { StatusBadge() }
                // Creation is a primary-box capability (a REPLICA has no spawn
                // path) — hide the entry point entirely on the cloud companion.
                if connection.status?.mode != .replica {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                showNewTask = true
                            } label: {
                                Label("New Task", systemImage: "checkmark.circle")
                            }
                            .accessibilityIdentifier("tasks.create")
                            Button {
                                showNewSession = true
                            } label: {
                                Label("New Session", systemImage: "terminal")
                            }
                            .accessibilityIdentifier("sessions.create")
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(Theme.tint)
                        }
                        // Automation compat: the collapsed Menu renders as ONE
                        // accessibility element (a button), and SwiftUI surfaces
                        // the identifier applied to the Menu itself — not one on
                        // the label view. Existing Maestro flows tap "sessions.new"
                        // to start session creation, so the menu container keeps
                        // that id (tap → menu opens → tap "sessions.create").
                        // The menu ITEMS carry distinct ids ("tasks.create" /
                        // "sessions.create") so open-menu taps are unambiguous.
                        .accessibilityIdentifier("sessions.new")
                    }
                }
            }
            .sheet(item: $selected) { task in
                TaskDetailSheet(task: task)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showNewSession) {
                NewSessionSheet { session in
                    navPath.append(session)
                }
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showNewTask) {
                // No onCreated action: the store's optimistic insert makes the
                // new task appear in the list the moment the sheet dismisses.
                NewTaskSheet()
                    .presentationDetents([.medium, .large])
            }
            // Session rows push a full-screen conversation page instead of a sheet.
            .navigationDestination(for: WalnutSession.self) { session in
                SessionConversationView(session: session)
            }
        }
    }

    // MARK: - Search

    /// Case-insensitive substring match across task title + project.
    /// (The v1 projection has no separate category field — project is the
    /// grouping layer, so title/project covers what the list shows.)
    private func taskMatchesSearch(_ task: WalnutTask) -> Bool {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return true }
        return task.title.localizedCaseInsensitiveContains(q)
            || task.project.localizedCaseInsensitiveContains(q)
    }

    /// Case-insensitive substring match across session title, owning-task
    /// title, host, and cwd.
    private func sessionMatchesSearch(_ session: WalnutSession) -> Bool {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return true }
        if session.title?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.taskTitle?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.host.localizedCaseInsensitiveContains(q) { return true }
        if session.cwd?.localizedCaseInsensitiveContains(q) == true { return true }
        return false
    }

    // MARK: - List

    private var sections: [(project: String, tasks: [WalnutTask])] {
        let filtered = tasks.tasks(for: activeFilter).filter(taskMatchesSearch)
        let grouped = Dictionary(grouping: filtered) { task in
            task.project.isEmpty ? "Inbox" : task.project
        }
        // Preserve each group's already-sorted order; sort the headers A→Z.
        return grouped
            .map { (project: $0.key, tasks: $0.value) }
            .sorted { $0.project.localizedCaseInsensitiveCompare($1.project) == .orderedAscending }
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
                ForEach(sections, id: \.project) { section in
                    Section(section.project) {
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
        .refreshable {
            async let t: Void = tasks.loadTasks()
            async let se: Void = tasks.loadSessions()
            _ = await (t, se)
        }
        // Gated: on a background/prewarm launch the tab's `.task` would fire
        // network fetches before the app is ever in front of the user (P0-2).
        .task {
            LaunchGate.shared.whenActive {
                async let t: Void = tasks.loadTasks()
                async let se: Void = tasks.loadSessions()
                _ = await (t, se)
            }
        }
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
        let rows = Array(source.filter(sessionMatchesSearch).prefix(5))
        if !rows.isEmpty {
            Section("Active Sessions") {
                ForEach(rows) { session in sessionRow(session) }
            }
        }
    }

    // MARK: - Sessions tab

    /// Sub-scope within the Sessions filter — mirrors the desktop panel's
    /// Pinned / Recent split plus an everything view.
    enum SessionScope: String, CaseIterable, Identifiable {
        case pinned = "Pinned", recent = "Recent", all = "All"
        var id: String { rawValue }
    }
    @State private var sessionScope: SessionScope = .pinned

    /// Pinned = ONE row per CURRENTLY pinned open task (its latest session).
    /// The session projection's own `pinned` flag is too broad — done tasks
    /// keep their pin bit, so 160+ sessions carry pinned=true while the
    /// desktop's Pinned list holds ~44 open tasks. Cross-reference the TASKS
    /// projection (fresh pin + status) instead; fall back to the session flag
    /// only when the tasks list hasn't loaded.
    private var pinnedScopeSessions: [WalnutSession] {
        let pinnedOpenTaskIds = Set(
            tasks.tasks.filter { $0.pinned == true && $0.statusKind != .done }.map(\.id)
        )
        var latest: [String: WalnutSession] = [:]
        for s in tasks.sessions {
            let isPinnedNow = pinnedOpenTaskIds.isEmpty
                ? s.isPinned
                : (s.taskId.map { pinnedOpenTaskIds.contains($0) } ?? false)
            guard isPinnedNow else { continue }
            let key = s.taskId ?? s.id
            if let current = latest[key], WalnutSession.recencySort(current, s) { continue }
            latest[key] = s
        }
        return latest.values.sorted { a, b in
            if a.statusKind.isAlive != b.statusKind.isAlive { return a.statusKind.isAlive }
            return WalnutSession.recencySort(a, b)
        }
    }

    private var scopedSessions: [WalnutSession] {
        let scoped: [WalnutSession]
        switch sessionScope {
        case .pinned: scoped = pinnedScopeSessions
        // Recent caps AFTER filtering so a search can surface older sessions.
        case .recent: scoped = Array(tasks.sessions.sorted(by: WalnutSession.recencySort).filter(sessionMatchesSearch).prefix(50))
        case .all: scoped = tasks.sessions.sorted(by: WalnutSession.recencySort)
        }
        return sessionScope == .recent ? scoped : scoped.filter(sessionMatchesSearch)
    }

    /// The Pinned scope mirrors the desktop focus bar's built-in tiers. Each pinned
    /// task carries a focus_tier: `focus`, `backlog`, `wait`, or (default/absent/
    /// unrecognized — incl. custom ct_* tiers, per api-v1) satellite.
    /// Ordered Focus → Satellite → Backlog → Wait to match the desktop reading order.
    private enum FocusTier: String, CaseIterable {
        case focus, satellite, backlog, wait
        var title: String {
            switch self {
            case .focus: return "Focus"
            case .satellite: return "Satellite"
            case .backlog: return "Backlog"
            case .wait: return "Wait"
            }
        }
    }

    private func tier(of session: WalnutSession) -> FocusTier {
        switch session.focusTier {
        case "focus": return .focus
        case "backlog": return .backlog
        case "wait": return .wait
        default: return .satellite
        }
    }

    /// Pinned sessions grouped by focus tier, in Focus → Satellite → Backlog → Wait
    /// order, dropping empty tiers.
    private var pinnedTierGroups: [(tier: FocusTier, sessions: [WalnutSession])] {
        let grouped = Dictionary(grouping: pinnedScopeSessions.filter(sessionMatchesSearch), by: tier)
        return FocusTier.allCases.compactMap { t in
            guard let rows = grouped[t], !rows.isEmpty else { return nil }
            return (t, rows)
        }
    }

    @ViewBuilder
    private var sessionSections: some View {
        Section {
            Picker("Scope", selection: $sessionScope) {
                ForEach(SessionScope.allCases) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 4, trailing: 12))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("sessions.scope")
        }

        if tasks.sessionsNotSyncedYet && tasks.sessions.isEmpty {
            Section {
                Text("Sessions not synced yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else if scopedSessions.isEmpty {
            Section {
                Text(emptyText)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else if sessionScope == .pinned {
            // Pinned mirrors the desktop focus bar: split into Focus / Satellite /
            // Backlog / Wait sub-sections (a session's tier comes from its owning task).
            ForEach(pinnedTierGroups, id: \.tier) { group in
                Section {
                    ForEach(group.sessions) { session in sessionRow(session) }
                } header: {
                    Text("\(group.tier.title) · \(group.sessions.count)")
                }
            }
            .id(sessionScope)
        } else {
            // Count in the HEADER: instant feedback that the scope switch did
            // something — the top rows of all three scopes can be identical
            // (recent sessions are usually pinned), so a bottom footer read
            // as "the buttons do nothing".
            Section {
                ForEach(scopedSessions) { session in sessionRow(session) }
            } header: {
                Text(scopeHeader)
            }
            .id(sessionScope) // force a fresh section render per scope
        }
    }

    private var scopeHeader: String {
        switch sessionScope {
        case .pinned: return "\(scopedSessions.count) pinned — one per task"
        case .recent: return "Last \(scopedSessions.count) by activity"
        case .all: return "All \(scopedSessions.count) sessions"
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
