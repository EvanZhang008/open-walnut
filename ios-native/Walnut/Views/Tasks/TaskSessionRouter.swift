import SwiftUI

/// Opens a task's SESSION, from anywhere on the Tasks tab: a board row, a search hit,
/// a calendar item. A task and its session are one thing, so a tap never stops on a
/// task page first; the task's own page is a tap away from the session (its title, or
/// its menu).
///
/// The DECISION is `BoardModel.tapRoute` (pure, tested); this performs it. It used to be
/// `if let session = row.session { push } else { showNewSession }`, which read "the
/// session list has no row for this task" as "this task has never had a session": two
/// different facts, and the difference shipped as a bug when the server's session
/// projection silently dropped older sessions, so a tap on a pinned task that HAS a
/// session opened a New Session draft.
///
/// One object for the whole tab, because the spinner it drives and the draft it opens
/// belong to the tab: the board (in the drawer) and the calendar (on the page) both
/// route through it.
@Observable
@MainActor
final class TaskSessionRouter {
    /// The row whose tap is asking the server where to go (nil = none). Drives that
    /// row's spinner; a second tap supersedes it.
    var resolvingRowId: String?
    /// The New Session draft, and WHICH TASK it is about (nil = no sheet). An item, not
    /// a Bool beside a task: two values that must agree about one sheet is how a draft
    /// opens with the previous row's task attached.
    var draftSeed: BoardModel.BoardDraftSeed?

    /// Bumped by every tap and by every page change made elsewhere: a lookup that comes
    /// back after it acts on nothing. A tap that waited 12 s on a slow server used to
    /// land after the user had opened something else, replace that page and close the
    /// drawer, or pop a draft over it.
    @ObservationIgnored private var generation = 0
    /// Counts the sessions put on the page. The board ends its search on each: kept up,
    /// the search bar owns the drawer's navigation bar, so it would reopen with no
    /// calendar and no `+`.
    private(set) var shownCount = 0

    /// Something else took the page (another session, the calendar, Back): any lookup
    /// still out is no longer the user's request.
    func supersede() {
        generation += 1
        if resolvingRowId != nil { resolvingRowId = nil }
    }

    /// A session went on the page, by whatever path.
    func didShow() {
        supersede()
        shownCount += 1
    }

    /// Route a board row. `show` puts a resolved session on screen.
    func open(_ row: BoardRow, tasks: TasksStore, show: @escaping (WalnutSession) -> Void) {
        // A newer tap wins: it is what the user asked for last.
        supersede()
        // Opening a task marks it read, whichever destination the tap resolves to
        // (the web's rule; a draft for a sessionless handed-back task counts too).
        if let taskId = row.owningTaskId { tasks.markRead(taskId: taskId) }
        route(row, tasks: tasks, show: show)
    }

    private func route(_ row: BoardRow, tasks: TasksStore, show: @escaping (WalnutSession) -> Void) {
        switch BoardModel.tapRoute(row) {
        case .open(let session):
            show(session)
        case .resolve(let sessionId, let fallback):
            resolveThenOpen(sessionId: sessionId, row: row, fallback: fallback, tasks: tasks, show: show)
        case .probe(let taskId, let fallback):
            probeThenOpen(taskId: taskId, row: row, fallback: fallback, tasks: tasks, show: show)
        case .draft(let seed):
            openDraft(seed, for: row, tasks: tasks)
        }
    }

    /// The task's attached draft: the task's page while it has no session, so it counts
    /// as opening the task (Recently opened), as its session would.
    private func openDraft(_ seed: BoardModel.BoardDraftSeed, for row: BoardRow, tasks: TasksStore) {
        if let task = row.task { tasks.recents.recordTask(task) }
        draftSeed = seed
    }

    /// Route a task that is not a board row (a search hit, a calendar item).
    func open(task: WalnutTask, tasks: TasksStore, show: @escaping (WalnutSession) -> Void) {
        open(
            BoardModel.row(
                for: task, sessions: tasks.sessions,
                knownSessionIds: tasks.knownSessionIds(for: task.id)
            ),
            tasks: tasks, show: show
        )
    }

    /// Open one named session (a search hit in its transcript): that conversation, not
    /// the task's newest. One the session list does not carry is looked up by id, and a
    /// failed lookup routes the task as a task tap would.
    func open(sessionId: String, task: WalnutTask, tasks: TasksStore, show: @escaping (WalnutSession) -> Void) {
        supersede()
        tasks.markRead(taskId: task.id)
        if let live = tasks.sessions.first(where: { $0.id == sessionId }) {
            show(live)
            return
        }
        let row = BoardModel.row(for: task, sessions: tasks.sessions, knownSessionIds: tasks.knownSessionIds(for: task.id))
        let gen = generation
        resolvingRowId = row.id
        Task {
            let resolved = await tasks.resolveSession(id: sessionId, task: task)
            guard gen == generation else { return }
            resolvingRowId = nil
            guard let resolved else {
                route(row, tasks: tasks, show: show)
                return
            }
            show(resolved)
        }
    }

    /// Open a session the session LIST does not carry, by id.
    ///
    /// The failure branch is the point: a 404 (the record really is gone), an offline
    /// phone or the lookup deadline all land in the draft ATTACHED to the task, never
    /// in a dead end and never in an unlinked draft. The toast says why, because a tap
    /// that quietly produces a different destination than the row promised is worse
    /// than the wait.
    private func resolveThenOpen(
        sessionId: String, row: BoardRow, fallback: BoardModel.BoardDraftSeed,
        tasks: TasksStore, show: @escaping (WalnutSession) -> Void
    ) {
        let gen = generation
        resolvingRowId = row.id
        Task {
            let resolved = await tasks.resolveSession(id: sessionId, task: row.task)
            guard gen == generation else { return }
            resolvingRowId = nil
            guard let resolved else {
                tasks.transientError = "Couldn't open that session. Starting a new one for this task."
                openDraft(fallback, for: row, tasks: tasks)
                return
            }
            show(resolved)
        }
    }

    /// Nothing knows yet whether this task has sessions, so ask before routing.
    ///
    /// The slim list projection carries no `session_ids`, so a cold board cannot tell a
    /// task that never had a session from one whose session aged out of the session
    /// list. ONE `GET /v1/tasks/:id` settles it, the answer is cached
    /// (`TasksStore.sessionIdsByTask`) so the next tap on that row spends nothing, and
    /// the row spins while it runs. A tap on a genuinely sessionless task waits one
    /// round trip (deadline `TasksStore.boardLookupDeadline`) before its draft opens:
    /// the price of never opening a draft on top of a real session, paid once per task
    /// per app run.
    private func probeThenOpen(
        taskId: String, row: BoardRow, fallback: BoardModel.BoardDraftSeed,
        tasks: TasksStore, show: @escaping (WalnutSession) -> Void
    ) {
        let gen = generation
        resolvingRowId = row.id
        Task {
            let ids = await tasks.fetchSessionIds(for: taskId)
            guard gen == generation else { return }
            resolvingRowId = nil
            // A failed probe must not invent an answer: fall through to the draft
            // (attached), exactly as this row behaved before the probe existed.
            guard let sessionId = BoardModel.newestSessionId(ids) else {
                openDraft(fallback, for: row, tasks: tasks)
                return
            }
            resolveThenOpen(sessionId: sessionId, row: row, fallback: fallback, tasks: tasks, show: show)
        }
    }
}
