import SwiftUI

/// A task to open by id: a task pill or link in a conversation, a letter's task, an inbox
/// item's task, a team row. `title` labels the page while the task loads.
struct TaskOpenTarget: Identifiable, Equatable {
    let id: String
    let title: String?
}

/// Where a tapped task goes, decided from what the phone already knows (pure, tested).
///
/// A task and its session are one thing (2026-11-04, the user: "always jump straight to the
/// session"), so every task tap outside the Tasks tab opens the task's conversation; only a
/// task that has never had a session opens its task page. The Tasks tab routes the same way
/// (`TaskSessionRouter`), and its sessionless task opens this sheet too.
enum TaskOpenModel {
    enum Step: Equatable {
        /// The session list carries the task's session: open it now.
        case session(WalnutSession)
        /// Ask the task's own detail which session is its current one.
        case lookUp
    }

    static func firstStep(taskId: String, sessions: [WalnutSession]) -> Step {
        let own = sessions.filter { $0.taskId == taskId }
        if let listed = BoardModel.latestSessionByTask(own)[taskId] { return .session(listed) }
        return .lookUp
    }

    /// After the detail answered: the session to fetch by id, or nil for the task page.
    static func sessionId(after detail: TaskDetail) -> String? {
        detail.currentSessionId
    }
}

/// The one destination of a task tapped by id. Every task entry outside the Tasks tab
/// presents this sheet (`tests/core/ios-task-tap-opens-session.test.ts` fails on a new one
/// that opens the task page instead): the task's session, or its task page when it has none.
struct TaskSessionSheet: View {
    let target: TaskOpenTarget
    @Environment(TasksStore.self) private var tasks
    @Environment(\.dismiss) private var dismiss

    private enum Phase {
        case loading
        case session(WalnutSession)
        case details(TaskDetail)
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var attempt = 0

    var body: some View {
        Group {
            switch phase {
            case .session(let session):
                NavigationStack {
                    SessionConversationView(session: session)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Done") { dismiss() }
                                    .accessibilityIdentifier("task.open.done")
                            }
                        }
                }
                .accessibilityIdentifier("task.open.session")
            case .details(let detail):
                TaskDetailSheet(task: WalnutTask(detail: detail), detail: detail)
            case .loading, .failed:
                NavigationStack {
                    placeholder
                        .navigationTitle(target.title ?? "Task")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { dismiss() }
                            }
                        }
                }
            }
        }
        .task(id: attempt) { await open() }
    }

    @ViewBuilder
    private var placeholder: some View {
        if case .failed(let message) = phase {
            ContentUnavailableView {
                Label("Can't open this task", systemImage: "checklist")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { attempt += 1 }
                    .accessibilityIdentifier("inbox.task.retry")
            }
        } else {
            ProgressView("Opening…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("task.open.loading")
        }
    }

    private func open() async {
        // Opening a task marks it read, whichever page it lands on (the web's rule).
        tasks.markRead(taskId: target.id)
        if case .session(let listed) = TaskOpenModel.firstStep(taskId: target.id, sessions: tasks.sessions) {
            show(listed)
            return
        }
        phase = .loading
        let detail: TaskDetail
        do {
            detail = try await WalnutAPI().taskDetail(id: target.id)
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            phase = .failed(TaskDetailSheet.friendlyEditError(error))
            return
        }
        tasks.noteSessionIds(taskId: target.id, ids: detail.sessionIds ?? [])
        guard let sessionId = TaskOpenModel.sessionId(after: detail) else {
            phase = .details(detail)
            return
        }
        let task = tasks.tasks.first { $0.id == target.id } ?? WalnutTask(detail: detail)
        if let listed = tasks.sessions.first(where: { $0.id == sessionId }) {
            show(listed)
        } else if let resolved = await tasks.resolveSession(id: sessionId, task: task) {
            show(resolved)
        } else {
            // The session record is gone or unreachable: the task page still opens, and it
            // lists the task's sessions.
            tasks.transientError = "Couldn't open this task's session. Showing the task."
            phase = .details(detail)
        }
    }

    /// The session page records itself in Recently opened when it appears.
    private func show(_ session: WalnutSession) {
        phase = .session(session)
    }
}
