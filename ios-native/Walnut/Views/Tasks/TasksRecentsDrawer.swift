import SwiftUI

/// Where a "Recently opened" row goes.
enum RecentDestination: Equatable {
    /// The conversation, as it was opened.
    case session(WalnutSession)
    /// The task, which opens its newest session (or its attached draft).
    case task(WalnutTask)
}

/// One row of the Tasks drawer, already resolved against the live stores.
struct RecentRow: Identifiable, Equatable {
    let id: String
    let title: String
    /// "5m ago · Marina", plus "Done" for a finished task.
    let meta: String
    let isDone: Bool
    /// The conversation last opened for this task, live copy when the list has it.
    let session: WalnutSession?
    /// The task, live copy when the list has it.
    let task: WalnutTask?

    /// A tap goes back to the conversation when one was opened, and to the task's
    /// session otherwise: a task tap is a session tap everywhere on the Tasks tab.
    var primary: RecentDestination? {
        if let session { return .session(session) }
        if let task { return .task(task) }
        return nil
    }

    /// Build the rows. ONE walk over each list, whatever the history length: the task
    /// projection can hold thousands of rows and this runs on every store update while
    /// the drawer is mounted.
    static func rows(
        _ entries: [RecentOpen], tasks: [WalnutTask], sessions: [WalnutSession], now: Date = AppClock.now()
    ) -> [RecentRow] {
        guard !entries.isEmpty else { return [] }
        let wantedTasks = Set(entries.compactMap(\.taskId))
        let wantedSessions = Set(entries.compactMap { $0.session?.id })
        var liveTasks: [String: WalnutTask] = [:]
        for task in tasks where wantedTasks.contains(task.id) { liveTasks[task.id] = task }
        var liveSessions: [String: WalnutSession] = [:]
        for session in sessions where wantedSessions.contains(session.id) {
            liveSessions[session.id] = session
        }
        return entries.map { entry in
            let session = entry.session.map { liveSessions[$0.id] ?? $0 }
            var task = entry.taskId.flatMap { liveTasks[$0] } ?? entry.task
            if task == nil, let taskId = entry.taskId {
                // Opened only through its session, and the list does not carry it: the
                // detail sheet loads the full record from this id.
                task = SessionTaskRow.placeholder(id: taskId, title: session?.taskTitle)
            }
            // The live task first, then the session's own copy of the task's name (kept
            // fresh by the session list), then the snapshot: a snapshot can be the detail
            // sheet's placeholder, whose title is just "Task".
            let sessionTaskTitle = session?.taskTitle.flatMap { $0.isEmpty ? nil : $0 }
            let title = entry.taskId.flatMap { liveTasks[$0]?.title }
                ?? sessionTaskTitle
                ?? entry.task?.title
                ?? session?.rowTitle
                ?? "Untitled"
            let isDone = task?.isDone ?? false
            var parts = [RelativeTime.short(date: entry.openedAt, relativeTo: now)]
            let project = task?.project.isEmpty == false ? task?.project : session?.project
            if let project, !project.isEmpty {
                parts.append(project)
            } else if entry.taskId != nil {
                parts.append("Inbox")
            }
            if isDone { parts.append("Done") }
            return RecentRow(
                id: entry.id, title: title, meta: parts.joined(separator: " · "),
                isDone: isDone, session: session, task: entry.taskId == nil ? nil : task
            )
        }
    }
}

/// Recently opened: everything opened from this phone, newest first. A page of the Tasks
/// drawer, pushed from the board's clock button, so Back returns to the board with its
/// scroll and search intact.
///
/// Same rows as the Chat drawer on purpose (the user's own reference for it): a title over
/// one quiet meta line. The board is already the busy screen; this one answers one
/// question, "what was I just looking at".
struct TasksRecentsPage: View {
    @Environment(TasksStore.self) private var tasks
    /// The drawer the page is in: a close drag that ends on a row must not also open it.
    @Environment(\.leadingDrawer) private var drawer
    let open: (RecentDestination) -> Void
    /// The task's page, from a row's long-press menu.
    let details: (WalnutTask) -> Void

    @State private var confirmClear = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let rows = RecentRow.rows(
            tasks.recents.entries, tasks: tasks.tasks, sessions: tasks.sessions
        )
        List {
            if rows.isEmpty {
                emptyState
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(rows) { row in
                    Button {
                        guard drawer?.suppressTaps != true, let destination = row.primary else { return }
                        open(destination)
                    } label: {
                        rowView(row)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { menu(row) }
                    .accessibilityIdentifier("tasks.recents.row.\(row.id)")
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Recently opened")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            if !rows.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear") {
                        guard drawer?.suppressTaps != true else { return }
                        confirmClear = true
                    }
                    .accessibilityIdentifier("tasks.recents.clear")
                }
            }
        }
        .accessibilityIdentifier("tasks.recents.page")
        .confirmationDialog(
            "Clear recently opened?", isPresented: $confirmClear, titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) { tasks.recents.clear() }
        } message: {
            Text("This only clears the list on this iPhone.")
        }
    }

    /// A row's line limits, title then meta. At the accessibility sizes both wrap in
    /// full: the drawer is no wider there, and two lines of title and one of meta cut
    /// "Fix the shared albu..." and the project after "2m ago" (App Store r7 gate,
    /// finding 14). The list scrolls, so a taller row costs nothing.
    static func rowLineLimits(_ size: DynamicTypeSize) -> (title: Int?, meta: Int?) {
        size.isAccessibilitySize ? (nil, nil) : (2, 1)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Nothing opened yet")
                .font(.subheadline)
            Text("Tasks and sessions you open will appear here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.recents.empty")
    }

    /// Title over one meta line, the Chat drawer's row. A finished task reads quieter,
    /// and says so in words too, since colour alone is not a status.
    private func rowView(_ row: RecentRow) -> some View {
        let limits = Self.rowLineLimits(dynamicTypeSize)
        return VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: row.title)
                .font(.subheadline)
                .foregroundStyle(row.isDone ? .secondary : .primary)
                .lineLimit(limits.title)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            // Secondary, not the Chat drawer's tertiary: this line carries the project
            // and the Done state, and tertiary caption text is too faint to read them.
            Text(verbatim: row.meta)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(limits.meta)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Long-press: the task's page, and taking a row off the list.
    @ViewBuilder
    private func menu(_ row: RecentRow) -> some View {
        if let task = row.task {
            Button { details(task) } label: {
                Label("Task Details", systemImage: "info.circle")
            }
            Divider()
        }
        Button(role: .destructive) {
            tasks.recents.remove(id: row.id)
        } label: {
            Label("Remove from List", systemImage: "minus.circle")
        }
    }
}
