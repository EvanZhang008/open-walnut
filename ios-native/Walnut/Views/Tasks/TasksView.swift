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
    /// Sentence carried from the quick-add row into the full NewTaskSheet
    /// (the expand affordance) — parsed there into the form fields.
    @State private var newTaskSeedText = ""
    /// Local search — filters tasks (title/project) and sessions
    /// (title/task/host/cwd) in place; no server round-trip.
    @State private var searchText = ""
    /// Locate-me flash for a just-created task (scroll target + row tint).
    @State private var highlightedTaskId: String?
    /// True while the inline add row's field is focused — rapid consecutive
    /// adds must not yank the scroll position / filter out from under the
    /// keyboard (Reminders keeps you anchored on the field).
    @State private var inlineAddActive = false
    /// Multi-select edit mode (Wave 1): batch complete / delete over the
    /// partial-success batch endpoints.
    @State private var editMode: EditMode = .inactive
    @State private var selectedIds = Set<String>()
    @State private var batchBusy = false
    @State private var batchError: String?
    @State private var confirmBatchDelete = false

    private var isEditing: Bool { editMode == .active }

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if tasks.notSyncedYet && tasks.tasks.isEmpty {
                    notSyncedState
                } else if activeFilter == .calendar {
                    // Full-bleed: the calendar's own views scroll and page
                    // (hour timelines, day list), which a List row can't host —
                    // a pager inside a List row has no intrinsic height.
                    calendarSurface
                } else {
                    list
                }
            }
            .navigationTitle("Tasks")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search tasks & sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { StatusBadge() }
                // Multi-select entry — task LIST filters only (sessions aren't
                // batch-actionable, and the calendar has no rows to select).
                // "Select" → edit mode with a bottom bar.
                if activeFilter != .sessions && activeFilter != .calendar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(isEditing ? "Done" : "Select") {
                            let entering = !isEditing
                            withAnimation {
                                editMode = entering ? .active : .inactive
                                if entering { selectedIds.removeAll() }
                            }
                        }
                        .accessibilityIdentifier("tasks.select")
                    }
                }
                // BOTH create entries show on BOTH server modes (2026-08).
                // TASK creation: the replica writes its local store and the
                // task outbox syncs it back to the primary. SESSION creation:
                // the replica relays over the bridge to the primary box
                // (narrow session.launch command → quick-start there); an
                // old cloud server / old daemon degrades to a clear error in
                // the sheet (not_supported_cloud / session_launch_needs_upgrade).
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
            .sheet(isPresented: $showNewTask, onDismiss: { newTaskSeedText = "" }) {
                // No onCreated action: the store's optimistic insert makes the
                // new task appear in the list the moment the sheet dismisses.
                NewTaskSheet(seedText: newTaskSeedText)
                    .presentationDetents([.medium, .large])
            }
            // Session rows push a full-screen conversation page instead of a sheet.
            .navigationDestination(for: WalnutSession.self) { session in
                SessionConversationView(session: session)
            }
        }
    }

    // MARK: - Search
    //
    // Derived-collection discipline (audit MAIN-5, 2026-08-08): every helper
    // below is a STATIC PURE function over (rows, query) so (a) the perf gate
    // in TasksDerivedPerfTests can drive the exact production code, and
    // (b) body passes can bind the result ONCE instead of recomputing per
    // reference. The store memoizes its slices per data generation; these
    // helpers are the remaining O(visible rows) per body pass.

    /// Trimmed search query ("" = match everything).
    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespaces)
    }

    /// Case-insensitive substring match across task title + project.
    /// (The v1 projection has no separate category field — project is the
    /// grouping layer, so title/project covers what the list shows.)
    static func taskMatches(_ task: WalnutTask, query q: String) -> Bool {
        guard !q.isEmpty else { return true }
        return task.title.localizedCaseInsensitiveContains(q)
            || task.project.localizedCaseInsensitiveContains(q)
    }

    /// Case-insensitive substring match across session title, owning-task
    /// title, host, and cwd.
    static func sessionMatches(_ session: WalnutSession, query q: String) -> Bool {
        guard !q.isEmpty else { return true }
        if session.title?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.taskTitle?.localizedCaseInsensitiveContains(q) == true { return true }
        if session.host.localizedCaseInsensitiveContains(q) { return true }
        if session.cwd?.localizedCaseInsensitiveContains(q) == true { return true }
        return false
    }

    private func sessionMatchesSearch(_ session: WalnutSession) -> Bool {
        Self.sessionMatches(session, query: trimmedQuery)
    }

    // MARK: - List

    /// Group already-sorted task rows by project, headers A→Z.
    static func sections(
        from rows: [WalnutTask], query: String
    ) -> [(project: String, tasks: [WalnutTask])] {
        let filtered = rows.filter { taskMatches($0, query: query) }
        let grouped = Dictionary(grouping: filtered) { task in
            task.project.isEmpty ? "Inbox" : task.project
        }
        // Preserve each group's already-sorted order; sort the headers A→Z.
        return grouped
            .map { (project: $0.key, tasks: $0.value) }
            .sorted { $0.project.localizedCaseInsensitiveCompare($1.project) == .orderedAscending }
    }

    private var sections: [(project: String, tasks: [WalnutTask])] {
        // The field promises "Search tasks & sessions", but the default
        // (Sessions) filter slices tasks to [] — a task the user KNOWS exists
        // showed "No local matches" until they discovered the All segment
        // (dogfood R17). While a query is typed, search open tasks too.
        let filter = (activeFilter == .sessions && !trimmedQuery.isEmpty) ? TaskFilter.allOpen : activeFilter
        return Self.sections(from: tasks.tasks(for: filter), query: trimmedQuery)
    }

    // MARK: - Calendar surface

    /// The Calendar filter renders FULL-BLEED, not as a List row: its four views
    /// (hour timelines, day list, month grid) own their own scrolling and
    /// horizontal paging, and a pager nested in a List row has no intrinsic
    /// height. The smart-list cards stay on top so switching back out is one tap.
    private var calendarSurface: some View {
        VStack(spacing: 0) {
            if !connection.online {
                OfflineBanner(text: "Offline — tasks are read-only from cache")
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
            }
            SmartListCards(activeFilter: $activeFilter)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            Divider()
            CalendarTabView()
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            // Bind the derived sections ONCE per body pass — the old computed-
            // property form was evaluated at every reference (isEmpty check +
            // ForEach = 2 full filter+group+sort walks per pass).
            let sections = self.sections
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

                // Todoist-grade quick add rides the TOP of EVERY filter (the
                // Sessions tab included — it's the default filter, and "add a
                // todo" must always be one tap away): type a sentence, hit
                // return, task appears instantly (the AI parse upgrades it in
                // place; on the Sessions filter the locate-me handler switches
                // to All Open so the new row is visible). The expand icon
                // opens the full form sheet seeded with the sentence.
                Section {
                    QuickAddRow(identifier: "tasks.quickAdd") { seed in
                        newTaskSeedText = seed
                        showNewTask = true
                    }
                }

                // Live sessions ride the top of every task filter (except the
                // Sessions filter, which shows the full Pinned/Active/Recent
                // list, and Calendar, which is a full-bleed month grid).
                if activeFilter != .sessions && activeFilter != .calendar {
                    activeSessionsSection
                    // Pinned tasks float above the project sections (mirrors
                    // the desktop focus bar). Rows keep full swipe/menu/detail
                    // behavior; hidden while searching (results replace it).
                    if trimmedQuery.isEmpty {
                        pinnedTasksSection
                    }
                }

                if activeFilter == .sessions {
                    sessionSections
                    // Searching on the Sessions filter: matching TASKS render
                    // below the session results (the sections slice switches
                    // to All Open while a query is live — see `sections`).
                    if !trimmedQuery.isEmpty {
                        ForEach(sections, id: \.project) { section in
                            Section(section.project) {
                                ForEach(section.tasks) { task in
                                    taskRowButton(task)
                                }
                            }
                        }
                    }
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
                                taskRowButton(task)
                            }
                        }
                    }
                }

                // Apple Reminders-style inline add — a persistent row at the
                // BOTTOM of every task list (not the Sessions tab): tap →
                // inline TextField, Return creates + keeps typing for rapid
                // consecutive adds. Goes to Inbox; the toolbar "+" menu keeps
                // the full sheet for project/priority/due picks.
                if activeFilter != .sessions {
                    Section {
                        InlineAddTaskRow(isActive: $inlineAddActive)
                    }
                }

                // Server-side global search augments the local matches while
                // a query is typed (tasks/memory/sessions; 501 on cloud →
                // a degradation notice).
                if !trimmedQuery.isEmpty {
                    GlobalSearchSection(query: trimmedQuery) { taskId in
                        if let hit = tasks.tasks.first(where: { $0.id == taskId || $0.id.hasPrefix(taskId) }) {
                            selected = hit
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
            // Batch action bar rides the bottom while selecting.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if isEditing { batchActionBar }
            }
            // Failed quick-toggle: the optimistic row already rolled back —
            // tell the user why (sync-source conflict, offline, …).
            .alert("Couldn't update task", isPresented: Binding(
                get: { toggleError != nil },
                set: { if !$0 { toggleError = nil } }
            )) {
                Button("OK", role: .cancel) { toggleError = nil }
            } message: {
                Text(toggleError ?? "")
            }
            // Batch results: partial failures surface with counts + reason.
            .alert("Batch action incomplete", isPresented: Binding(
                get: { batchError != nil },
                set: { if !$0 { batchError = nil } }
            )) {
                Button("OK", role: .cancel) { batchError = nil }
            } message: {
                Text(batchError ?? "")
            }
            .confirmationDialog(
                "Delete \(selectedIds.count) task(s)?",
                isPresented: $confirmBatchDelete, titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    runBatch { await tasks.batchDelete(Array(selectedIds)) }
                }
            }
            .refreshable {
                async let t: Void = tasks.loadTasks()
                async let se: Void = tasks.loadSessions()
                async let f: Void = tasks.loadFocusTiers()
                _ = await (t, se, f)
            }
            // Gated: on a background/prewarm launch the tab's `.task` would fire
            // network fetches before the app is ever in front of the user (P0-2).
            .task {
                LaunchGate.shared.whenActive {
                    async let t: Void = tasks.loadTasks()
                    async let se: Void = tasks.loadSessions()
                    async let f: Void = tasks.loadFocusTiers()
                    _ = await (t, se, f)
                }
            }
            // Store-level toast surface (fire-and-forget mutations): a small
            // auto-dismissing line at the bottom — never a modal.
            .overlay(alignment: .bottom) {
                if let notice = tasks.transientNotice ?? tasks.transientError {
                    TransientToast(
                        text: notice,
                        isError: tasks.transientError != nil
                    ) {
                        tasks.transientNotice = nil
                        tasks.transientError = nil
                    }
                    .padding(.bottom, 12)
                }
            }
            .animation(.snappy(duration: 0.25), value: activeFilter)
            // Locate a just-created task: switch to a filter that shows it,
            // scroll to it, and flash its row — "created but can't find it"
            // was a real complaint. Skipped while the inline add row is
            // focused (rapid consecutive adds must not yank the scroll away
            // from the keyboard — the row appears in place instead).
            .onChange(of: tasks.lastCreatedTaskId) { _, newId in
                guard let newId else { return }
                if inlineAddActive {
                    flashHighlight(newId)
                    return
                }
                if activeFilter == .sessions || !tasks.tasks(for: activeFilter).contains(where: { $0.id == newId }) {
                    activeFilter = .allOpen
                }
                flashHighlight(newId)
                // Next runloop: the (possibly) new filter's rows must exist
                // before scrollTo can target one.
                DispatchQueue.main.async {
                    withAnimation(.snappy(duration: 0.35)) {
                        proxy.scrollTo("task-\(newId)", anchor: .center)
                    }
                }
            }
        }
    }

    /// One row of the task list: edit mode = selection toggle; normal = detail
    /// sheet + swipe/context quick actions.
    @ViewBuilder
    private func taskRowButton(_ task: WalnutTask) -> some View {
        Button {
            if isEditing {
                if selectedIds.contains(task.id) { selectedIds.remove(task.id) }
                else { selectedIds.insert(task.id) }
            } else {
                selected = task
            }
        } label: {
            HStack(spacing: 10) {
                if isEditing {
                    Image(systemName: selectedIds.contains(task.id) ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selectedIds.contains(task.id) ? Theme.tint : Color(.systemGray3))
                }
                TaskRow(task: task, tierBadge: tasks.tierBadge(for: task))
            }
        }
        .buttonStyle(.plain)
        .id("task-\(task.id)")
        // Locate-me flash for a just-created task; selection tint in edit mode.
        .listRowBackground(
            isEditing && selectedIds.contains(task.id)
                ? Theme.tintSoft
                : (task.id == highlightedTaskId ? Theme.tintSoft : nil)
        )
        .accessibilityIdentifier("tasks.row.\(task.id)")
        // Quick status toggle without opening the sheet: leading swipe =
        // todo↔done (Reminders muscle memory); long-press menu mirrors it.
        .swipeActions(edge: .leading, allowsFullSwipe: !isEditing) {
            if !isEditing {
                Button {
                    toggleDone(task)
                } label: {
                    Label(
                        task.isDone ? "Reopen" : "Done",
                        systemImage: task.isDone ? "arrow.uturn.backward.circle" : "checkmark.circle.fill"
                    )
                }
                .tint(task.isDone ? .secondary : Theme.success)
            }
        }
        // Trailing swipe: pin/unpin (focus endpoints, optimistic + rollback).
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !isEditing {
                Button {
                    togglePin(task)
                } label: {
                    Label(task.pinned == true ? "Unpin" : "Pin",
                          systemImage: task.pinned == true ? "pin.slash" : "pin")
                }
                .tint(Theme.tint)
            }
        }
        .contextMenu {
            if !isEditing {
                Button {
                    toggleDone(task)
                } label: {
                    Label(
                        task.isDone ? "Mark as To Do" : "Mark as Done",
                        systemImage: task.isDone ? "circle" : "checkmark.circle.fill"
                    )
                }
                Button {
                    togglePin(task)
                } label: {
                    Label(task.pinned == true ? "Unpin" : "Pin",
                          systemImage: task.pinned == true ? "pin.slash" : "pin")
                }
                // Tier mover (pinned rows only): mirrors the desktop focus
                // bar's tier set — built-ins + custom tiers, optimistic.
                if task.pinned == true {
                    Menu {
                        let currentTier = tasks.tierId(for: task.id) ?? "satellite"
                        ForEach(tasks.allTierChoices, id: \.id) { choice in
                            Button {
                                moveTier(task, tier: choice.id)
                            } label: {
                                if choice.id == currentTier {
                                    Label(choice.label, systemImage: "checkmark")
                                } else {
                                    Text(choice.label)
                                }
                            }
                        }
                    } label: {
                        Label("Move to Tier", systemImage: "square.stack.3d.up")
                    }
                }
                Button {
                    selected = task
                } label: {
                    Label("Details", systemImage: "info.circle")
                }
            }
        }
    }

    /// Tier move from a row's context menu. Optimistic via the store.
    private func moveTier(_ task: WalnutTask, tier: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.setTier(taskId: task.id, tier: tier) {
                toggleError = error
            }
        }
    }

    /// Pin/unpin from a row (swipe / context menu). Optimistic via the store.
    private func togglePin(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.setPinned(task, pinned: !(task.pinned == true)) {
                toggleError = error
            }
        }
    }

    /// One-tap todo↔done from a row (swipe / context menu). Optimistic via the
    /// store; a failure surfaces as a transient alert-style banner row is
    /// overkill here — reuse the store's error line on next refresh instead.
    @State private var toggleError: String?
    private func toggleDone(_ task: WalnutTask) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let error = await tasks.toggleDone(task) {
                toggleError = error
            }
        }
    }

    /// Bottom bar in edit mode: Complete / Delete over the selection.
    private var batchActionBar: some View {
        HStack(spacing: 12) {
            Text("\(selectedIds.count) selected")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                runBatch { await tasks.batchSetDone(Array(selectedIds), done: true) }
            } label: {
                Label("Complete", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
            }
            .accessibilityIdentifier("tasks.batchComplete")
            Button(role: .destructive) {
                confirmBatchDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
                    .font(.subheadline.weight(.semibold))
            }
            .accessibilityIdentifier("tasks.batchDelete")
        }
        .disabled(selectedIds.isEmpty || batchBusy)
        .overlay(alignment: .center) {
            if batchBusy { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// Shared batch runner: busy-gate, run, exit edit mode, surface failures.
    private func runBatch(_ operation: @escaping () async -> String?) {
        guard !batchBusy, !selectedIds.isEmpty else { return }
        batchBusy = true
        Task {
            defer { batchBusy = false }
            let failure = await operation()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            withAnimation {
                editMode = .inactive
                selectedIds.removeAll()
            }
            if let failure { batchError = failure }
        }
    }

    /// Tint the row for a few seconds, then fade the highlight out.
    private func flashHighlight(_ taskId: String) {
        withAnimation(.easeIn(duration: 0.2)) { highlightedTaskId = taskId }
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if highlightedTaskId == taskId {
                withAnimation(.easeOut(duration: 0.6)) { highlightedTaskId = nil }
            }
        }
    }

    private var emptyText: String {
        Self.emptyPlaceholder(filter: activeFilter, query: trimmedQuery)
    }

    /// Empty-state copy for a filter, search-aware. With a query active the
    /// filter wording ("No agent sessions.", "No open tasks.") reads as "your
    /// search found nothing" while the real hits sit BELOW in Server Search —
    /// a user could bail before scrolling (2026-08-23 dogfood R11). Say what
    /// actually happened and point at where the results are.
    static func emptyPlaceholder(filter: TaskFilter, query: String) -> String {
        if !query.isEmpty {
            return "No local matches — see Server Search below."
        }
        switch filter {
        case .today: return "Nothing due today."
        case .inProgress: return "No tasks in progress."
        case .sessions: return "No agent sessions."
        case .calendar: return "" // calendar renders its own grid, never this
        case .allOpen: return "No open tasks."
        case .done: return "No recent completions."
        }
    }

    // MARK: - Pinned tasks (top of every task filter)

    /// Open pinned tasks, capped at 8 — the phone mirror of the desktop
    /// focus bar. Uses the projection's pinned flag (live via the feed).
    /// The section's quick-add row creates a task PRE-PINNED (satellite
    /// tier default) — add straight into the working set from anywhere.
    @ViewBuilder
    private var pinnedTasksSection: some View {
        let pinned = tasks.tasks(for: activeFilter == .done ? .done : .allOpen)
            .filter { $0.pinned == true && !$0.isDone }
        if activeFilter != .done {
            Section("Pinned") {
                ForEach(Array(pinned.prefix(8))) { task in
                    taskRowButton(task)
                }
                QuickAddRow(pinSeed: true, identifier: "focus.quickAdd")
            }
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
    static func pinnedScopeSessions(
        tasks: [WalnutTask], sessions: [WalnutSession]
    ) -> [WalnutSession] {
        let pinnedOpenTaskIds = Set(
            tasks.filter { $0.pinned == true && $0.statusKind != .done }.map(\.id)
        )
        var latest: [String: WalnutSession] = [:]
        for s in sessions {
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

    private var pinnedScopeSessions: [WalnutSession] {
        Self.pinnedScopeSessions(tasks: tasks.tasks, sessions: tasks.sessions)
    }

    private var scopedSessions: [WalnutSession] {
        let scoped: [WalnutSession]
        switch sessionScope {
        case .pinned: scoped = pinnedScopeSessions
        // Recent caps AFTER filtering so a search can surface older sessions.
        case .recent: scoped = Array(WalnutSession.recencySorted(tasks.sessions).filter(sessionMatchesSearch).prefix(50))
        case .all: scoped = WalnutSession.recencySorted(tasks.sessions)
        }
        return sessionScope == .recent ? scoped : scoped.filter(sessionMatchesSearch)
    }

    /// The Pinned scope mirrors the desktop focus bar's built-in tiers. Each pinned
    /// task carries a focus_tier: `focus`, `backlog`, `wait`, or (default/absent/
    /// unrecognized — incl. custom ct_* tiers, per api-v1) satellite.
    /// Ordered Focus → Satellite → Backlog → Wait to match the desktop reading order.
    enum FocusTier: String, CaseIterable {
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

    private static func tier(of session: WalnutSession) -> FocusTier {
        switch session.focusTier {
        case "focus": return .focus
        case "backlog": return .backlog
        case "wait": return .wait
        default: return .satellite
        }
    }

    /// Pinned sessions grouped by focus tier, in Focus → Satellite → Backlog → Wait
    /// order, dropping empty tiers.
    static func pinnedTierGroups(
        pinned: [WalnutSession], query: String
    ) -> [(tier: FocusTier, sessions: [WalnutSession])] {
        let grouped = Dictionary(
            grouping: pinned.filter { sessionMatches($0, query: query) }, by: tier(of:)
        )
        return FocusTier.allCases.compactMap { t in
            guard let rows = grouped[t], !rows.isEmpty else { return nil }
            return (t, rows)
        }
    }

    private var pinnedTierGroups: [(tier: FocusTier, sessions: [WalnutSession])] {
        Self.pinnedTierGroups(pinned: pinnedScopeSessions, query: trimmedQuery)
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

        // Bind ONCE per body pass (each reference used to recompute the full
        // filter+sort walk — isEmpty check, ForEach, and the count header
        // were three separate evaluations).
        let scoped = self.scopedSessions
        if tasks.sessionsNotSyncedYet && tasks.sessions.isEmpty {
            Section {
                Text("Sessions not synced yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        } else if scoped.isEmpty {
            Section {
                // With a live query, matching TASKS may render right below
                // this session list — "No local matches" would be a lie then.
                Text(!trimmedQuery.isEmpty && !sections.isEmpty
                    ? "No session matches — matching tasks below."
                    : emptyText)
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
                ForEach(scoped) { session in sessionRow(session) }
            } header: {
                Text(scopeHeader(count: scoped.count))
            }
            .id(sessionScope) // force a fresh section render per scope
        }
    }

    private func scopeHeader(count: Int) -> String {
        switch sessionScope {
        case .pinned: return "\(count) pinned — one per task"
        case .recent: return "Last \(count) by activity"
        case .all: return "All \(count) sessions"
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

// MARK: - Inline add row (Apple Reminders behavior)

/// Persistent "+ New Task" row at the bottom of the task list. Tap → becomes
/// an inline TextField; Return creates immediately (Inbox, no project) and
/// KEEPS the field active for rapid consecutive adds — exactly Reminders'
/// behavior. Tap-away/dismiss with an empty field collapses back to the
/// button. Creation goes through the same TasksStore.createTask path as the
/// sheet, so the optimistic insert + pending overlay + locate-me flash all
/// apply.
struct InlineAddTaskRow: View {
    /// Bubbles focus state up so the list can suppress its scroll-to-created
    /// behavior while the user is chain-adding.
    @Binding var isActive: Bool

    @Environment(TasksStore.self) private var tasks

    @State private var title = ""
    @State private var editing = false
    @State private var submitting = false
    @State private var errorMessage: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        Group {
            if editing {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 10) {
                        Image(systemName: "circle")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                        TextField("New task", text: $title)
                            .focused($fieldFocused)
                            .submitLabel(.done)
                            .onSubmit { submit() }
                            .disabled(submitting)
                            .accessibilityIdentifier("tasks.inlineAdd.field")
                        if submitting {
                            ProgressView().controlSize(.small)
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(Theme.danger)
                    }
                }
                .onChange(of: fieldFocused) { _, focused in
                    isActive = focused
                    // Tap-away with nothing typed = cancel (Reminders behavior).
                    // Mid-submit blur (keyboard dropped by the async create)
                    // must not collapse the row before the task lands.
                    if !focused && !submitting && title.trimmingCharacters(in: .whitespaces).isEmpty {
                        collapse()
                    }
                }
            } else {
                Button {
                    editing = true
                    errorMessage = nil
                    // Next runloop: the TextField must exist before focusing.
                    DispatchQueue.main.async { fieldFocused = true }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus.circle.fill")
                            .font(.body)
                            .foregroundStyle(Theme.tint)
                        Text("New Task")
                            .foregroundStyle(Theme.tint)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tasks.inlineAdd")
            }
        }
    }

    private func collapse() {
        editing = false
        title = ""
        errorMessage = nil
        isActive = false
    }

    private func submit() {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        // Return on an empty field = done adding (Reminders behavior).
        guard !trimmed.isEmpty else { collapse(); return }
        guard !submitting else { return }
        submitting = true
        errorMessage = nil
        Task {
            defer { submitting = false }
            do {
                _ = try await tasks.createTask(title: trimmed)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                // Stay active for the next one — clear the text, keep focus.
                title = ""
                fieldFocused = true
            } catch let APIError.server(_, _, msg, _, _) {
                errorMessage = msg
                fieldFocused = true
            } catch {
                errorMessage = error.localizedDescription
                fieldFocused = true
            }
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
        case .calendar: return .teal
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

// MARK: - Transient toast (fire-and-forget mutation feedback)

/// Small bottom toast for optimistic mutations: info ("Pinned · Focus") or a
/// subtle failure line after a revert. Auto-dismisses; tap to dismiss early.
/// Deliberately NOT a modal/alert — instant-first mutations never block.
struct TransientToast: View {
    let text: String
    let isError: Bool
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.caption)
            Text(text)
                .font(.caption.weight(.medium))
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: Capsule())
        .foregroundStyle(isError ? Theme.danger : Theme.tint)
        .onTapGesture(perform: dismiss)
        .task {
            try? await Task.sleep(for: .seconds(isError ? 5 : 2.5))
            dismiss()
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityIdentifier("tasks.toast")
    }
}
