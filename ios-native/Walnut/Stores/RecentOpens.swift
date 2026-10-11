import Foundation
import Observation

/// One thing the user opened, as the Tasks drawer's "Recently opened" lists it.
///
/// ONE ENTRY PER TASK, not one per screen: a task is the unit the board shows, and
/// opening a task's session and then its details is one visit to one piece of work.
/// Two rows for it would be the "which one do I tap" clutter the board was rebuilt to
/// remove. The entry remembers the last SESSION opened for the task (if any) and the
/// task itself, so a tap can go back to the conversation the way a board row does.
///
/// A session no task owns is keyed by its own id (`session:<id>`).
///
/// The snapshots are what make an old entry still openable: a session that aged out
/// of the session list, or a task outside the list projection, still has the row the
/// user saw. The drawer prefers the LIVE copy from `TasksStore` whenever there is one.
struct RecentOpen: Codable, Equatable, Identifiable {
    /// The owning task id, or `session:<id>` for a session with no task.
    let id: String
    var taskId: String?
    var task: WalnutTask?
    var session: WalnutSession?
    var openedAt: Date

    static func key(taskId: String?) -> String? {
        guard let taskId, !taskId.isEmpty else { return nil }
        return taskId
    }

    static func key(session: WalnutSession) -> String {
        key(taskId: session.taskId) ?? "session:\(session.id)"
    }
}

/// The history behind the Tasks drawer, newest first, kept on this phone only.
///
/// Recorded where a thing is actually SEEN, not where it is tapped:
/// `SessionConversationView` and `TaskDetailSheet` record themselves on appear, so
/// every route that opens one (a board row, a search hit, the detail sheet's own
/// session list, a fork, an Inbox letter) lands here without each caller having to
/// remember to.
///
/// Persisted through `DiskCache` (one small JSON file). Losing it to a cache purge
/// costs a history list, never work, which is the bar `DiskCache` is for. Only a
/// store that has been HYDRATED writes, so a test that builds a `TasksStore` and
/// never initializes it cannot touch the app's file.
@Observable
@MainActor
final class RecentOpens {
    /// Enough to cover a working day of hopping between tasks, small enough that
    /// the whole list is one short scroll.
    static let cap = 40
    static let cacheKey = "tasks-recent-opens"

    private(set) var entries: [RecentOpen] = []

    @ObservationIgnored private var persists = false
    /// Bumped by `eraseAll`, so a hydrate that was reading the old file when a
    /// disconnect happened cannot put the old server's history back.
    @ObservationIgnored private var generation = 0

    /// Load the saved history. Anything recorded before the file was read stays on
    /// top: it is newer than everything in the file by construction.
    func hydrate() async {
        guard !persists else { return }
        let started = generation
        let file = await DiskCache.loadAsync([RecentOpen].self, key: Self.cacheKey)
        guard started == generation else { return }
        let cached = file ?? []
        // Nothing saved yet: in the demo the list starts from its sample history
        // (`DemoEntry.sampleRecentOpens`), and outside it from nothing.
        let saved = file ?? DemoEntry.sampleRecentOpens()
        let merged = Self.merged(newer: entries, older: saved, cap: Self.cap)
        persists = true
        if merged != entries { entries = merged }
        // Also when nothing was on disk: visits made before the read are only in memory.
        if merged != cached { persist() }
    }

    func recordSession(_ session: WalnutSession, at now: Date = AppClock.now()) {
        apply(Self.recordingSession(session, at: now, into: entries, cap: Self.cap))
    }

    func recordTask(_ task: WalnutTask, at now: Date = AppClock.now()) {
        apply(Self.recordingTask(task, at: now, into: entries, cap: Self.cap))
    }

    func remove(id: String) {
        apply(entries.filter { $0.id != id })
    }

    func clear() {
        apply([])
    }

    /// Disconnect: forget it in memory. The file goes with `DiskCache.clearAll()`.
    func eraseAll() {
        generation += 1
        persists = false
        entries = []
    }

    private func apply(_ next: [RecentOpen]) {
        guard next != entries else { return }
        entries = next
        persist()
    }

    private func persist() {
        guard persists else { return }
        DiskCache.save(entries, key: Self.cacheKey)
    }

    // MARK: - The rules (pure, tested)

    static func recordingSession(
        _ session: WalnutSession, at now: Date, into entries: [RecentOpen], cap: Int
    ) -> [RecentOpen] {
        let key = RecentOpen.key(session: session)
        // A session first opened while it had no task, and now opened with one, is the
        // same work: its old `session:` row folds into the task's row.
        let rest = entries.filter { $0.id != "session:\(session.id)" || $0.id == key }
        return recording(
            RecentOpen(id: key, taskId: RecentOpen.key(taskId: session.taskId), task: nil,
                       session: session, openedAt: now),
            into: rest, cap: cap
        )
    }

    static func recordingTask(
        _ task: WalnutTask, at now: Date, into entries: [RecentOpen], cap: Int
    ) -> [RecentOpen] {
        recording(
            RecentOpen(id: task.id, taskId: task.id, task: task, session: nil, openedAt: now),
            into: entries, cap: cap
        )
    }

    /// Move-to-top with a merge: what this visit saw replaces the snapshot of the same
    /// kind, and the other kind is kept (opening the details must not forget which
    /// session the user was in).
    static func recording(_ visit: RecentOpen, into entries: [RecentOpen], cap: Int) -> [RecentOpen] {
        var out = entries
        var entry = visit
        if let index = out.firstIndex(where: { $0.id == visit.id }) {
            let old = out.remove(at: index)
            entry.task = visit.task ?? old.task
            entry.session = visit.session ?? old.session
            entry.taskId = visit.taskId ?? old.taskId
        }
        out.insert(entry, at: 0)
        if out.count > cap { out.removeLast(out.count - cap) }
        return out
    }

    /// `newer` on top, then whatever of `older` it does not already name.
    static func merged(newer: [RecentOpen], older: [RecentOpen], cap: Int) -> [RecentOpen] {
        var seen = Set(newer.map(\.id))
        var out = newer
        for entry in older where seen.insert(entry.id).inserted {
            out.append(entry)
        }
        if out.count > cap { out.removeLast(out.count - cap) }
        return out
    }
}
