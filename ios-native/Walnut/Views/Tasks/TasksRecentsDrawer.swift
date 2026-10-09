import SwiftUI

/// Where a "Recently opened" row goes.
enum RecentDestination: Equatable {
    case session(WalnutSession)
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

    /// A tap goes back to the conversation when one was opened, the way a board row's
    /// tap does, and to the task's details otherwise.
    var primary: RecentDestination? {
        if let session { return .session(session) }
        if let task { return .task(task) }
        return nil
    }

    /// Build the rows. ONE walk over each list, whatever the history length: the task
    /// projection can hold thousands of rows and this runs on every store update while
    /// the drawer is mounted.
    static func rows(
        _ entries: [RecentOpen], tasks: [WalnutTask], sessions: [WalnutSession], now: Date = .now
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

/// The Tasks tab's left-edge drawer: everything opened from this phone, newest first.
///
/// Same shape as the Chat drawer on purpose (the user's own reference for it): a title,
/// then a plain list of rows, each a title over one quiet meta line. Nothing else lives
/// here. The board is already the busy screen; this one answers one question, "what
/// was I just looking at".
struct TasksRecentsDrawer: View {
    @Environment(TasksStore.self) private var tasks
    let model: LeadingDrawerModel
    let open: (RecentDestination) -> Void

    @State private var confirmClear = false

    private static let inset: CGFloat = 20

    var body: some View {
        let rows = RecentRow.rows(
            tasks.recents.entries, tasks: tasks.tasks, sessions: tasks.sessions
        )
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(hasRows: !rows.isEmpty)
                if rows.isEmpty {
                    emptyState
                } else {
                    ForEach(rows) { row in
                        Button {
                            guard !model.suppressTaps, let destination = row.primary else { return }
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        // A scrolled row passes behind the status bar over something, not bare
        // background (the Chat drawer's zero-height trick, same reason).
        .safeAreaInset(edge: .top, spacing: 0) {
            Color.clear
                .frame(height: 0)
                .background(.bar, ignoresSafeAreaEdges: .top)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.recents.drawer")
        .confirmationDialog(
            "Clear recently opened?", isPresented: $confirmClear, titleVisibility: .visible
        ) {
            Button("Clear", role: .destructive) { tasks.recents.clear() }
        } message: {
            Text("This only clears the list on this iPhone.")
        }
    }

    private func header(hasRows: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Recently opened")
                .font(.title2.bold())
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if hasRows {
                Button("Clear") {
                    guard !model.suppressTaps else { return }
                    confirmClear = true
                }
                .font(.subheadline)
                .accessibilityIdentifier("tasks.recents.clear")
            }
        }
        .padding(.horizontal, Self.inset)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Nothing opened yet")
                .font(.subheadline)
            Text("Tasks and sessions you open will appear here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, Self.inset)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.recents.empty")
    }

    /// Title over one meta line, the Chat drawer's row. A finished task reads quieter,
    /// and says so in words too, since colour alone is not a status.
    private func rowView(_ row: RecentRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: row.title)
                .font(.subheadline)
                .foregroundStyle(row.isDone ? .secondary : .primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            // Secondary, not the Chat drawer's tertiary: this line carries the project
            // and the Done state, and tertiary caption text is too faint to read them.
            Text(verbatim: row.meta)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    /// Long-press: the other destination, and taking a row off the list.
    @ViewBuilder
    private func menu(_ row: RecentRow) -> some View {
        if let session = row.session {
            Button { open(.session(session)) } label: {
                Label("Open Session", systemImage: "bubble.left.and.text.bubble.right")
            }
        }
        if let task = row.task {
            Button { open(.task(task)) } label: {
                Label("Task Details", systemImage: "info.circle")
            }
        }
        Divider()
        Button(role: .destructive) {
            tasks.recents.remove(id: row.id)
        } label: {
            Label("Remove from List", systemImage: "minus.circle")
        }
    }
}
