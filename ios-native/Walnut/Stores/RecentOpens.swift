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

/// Where the synced list is read and written (`WalnutAPI`; a stub in tests).
protocol RecentOpenedTransport: Sendable {
    func recentOpened() async throws -> [RecentOpenedEntry]
    func recordRecentOpened(_ entries: [RecentOpenedEntry]) async throws
}

/// The history behind the Tasks drawer, newest first.
///
/// What the drawer LISTS is the person's one synced list (`walnut-todo-recent-opened`, the
/// web's and the Mac app's Recent too: 2026-11-09, "Recent is one list on every surface"):
/// task ids with when they were opened, on any device. This phone's own entries are the
/// snapshots that make a row openable (the session last opened for the task, the task as
/// seen), and the list itself while the synced one cannot be read (offline, an older server,
/// the demo).
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
    /// The synced list as last read, with this phone's own opens on top; nil until read once.
    private(set) var synced: [RecentOpenedEntry]?
    /// Where the synced list lives; nil = this phone's list only (the demo, a test).
    @ObservationIgnored var transport: (any RecentOpenedTransport)?
    /// Opens the server has not taken yet (it was away): sent again at the next read.
    @ObservationIgnored private var unsent: [RecentOpenedEntry] = []
    /// The phone's own list from before the synced one was handed over once (`handOver`).
    static let handedOverKey = "tasks.recents.syncedHandedOver"
    /// The synced list's size on the server.
    static let syncedCap = 50

    /// What the drawer shows: the synced list (each row with this phone's snapshot of it,
    /// when it has one), else this phone's own list.
    var shownEntries: [RecentOpen] {
        guard let synced else { return entries }
        return Self.shown(synced: synced, local: entries)
    }

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
        if transport == nil, !DemoMode.isActive { transport = WalnutAPI() }
        if merged != entries { entries = merged }
        // Also when nothing was on disk: visits made before the read are only in memory.
        if merged != cached { persist() }
    }

    func recordSession(_ session: WalnutSession, at now: Date = AppClock.now()) {
        apply(Self.recordingSession(session, at: now, into: entries, cap: Self.cap))
        // Only a task's open is on the synced list: a session with no task is this phone's.
        if let taskId = RecentOpen.key(taskId: session.taskId) { share(taskId, at: now) }
    }

    func recordTask(_ task: WalnutTask, at now: Date = AppClock.now()) {
        apply(Self.recordingTask(task, at: now, into: entries, cap: Self.cap))
        share(task.id, at: now)
    }

    /// Read the synced list (the drawer opening, the app coming back): send what the server
    /// missed first, hand this phone's old list over once, then show the server's list with
    /// anything still unsent on top.
    func refreshSynced() async {
        guard persists, let transport else { return }
        if !unsent.isEmpty {
            let pending = unsent
            if (try? await transport.recordRecentOpened(pending)) != nil {
                unsent.removeAll { pending.contains($0) }
            }
        }
        if !AppPrefs.defaults.bool(forKey: Self.handedOverKey) {
            let old = entries.compactMap { entry in
                entry.taskId.map { RecentOpenedEntry(id: $0, at: Self.iso(entry.openedAt)) }
            }
            var handed = old.isEmpty
            if !handed { handed = (try? await transport.recordRecentOpened(old)) != nil }
            if handed { AppPrefs.defaults.set(true, forKey: Self.handedOverKey) }
        }
        guard let read = try? await transport.recentOpened() else { return }
        let next = Self.union(read, unsent, cap: Self.syncedCap)
        if next != synced { synced = next }
    }

    /// One open onto the synced list: on top here at once, and sent (the server merges it).
    private func share(_ taskId: String, at now: Date) {
        guard persists, let transport else { return }
        let entry = RecentOpenedEntry(id: taskId, at: Self.iso(now))
        if let synced { self.synced = Self.union([entry], synced, cap: Self.syncedCap) }
        Task { [weak self] in
            do { try await transport.recordRecentOpened([entry]) } catch { self?.unsent.append(entry) }
        }
    }

    /// Disconnect: forget it in memory. The file goes with `DiskCache.clearAll()`.
    func eraseAll() {
        generation += 1
        persists = false
        entries = []
        synced = nil
        unsent = []
        // Another server's list is another person's list: its own phone list is handed over.
        AppPrefs.defaults.removeObject(forKey: Self.handedOverKey)
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

    /// Each task once, with its newest time, newest first, at most `cap`.
    static func union(_ a: [RecentOpenedEntry], _ b: [RecentOpenedEntry], cap: Int) -> [RecentOpenedEntry] {
        var newest: [String: (entry: RecentOpenedEntry, at: Date)] = [:]
        let both: [RecentOpenedEntry] = a + b
        for entry in both {
            let at = date(entry.at) ?? .distantPast
            if let kept = newest[entry.id], kept.at >= at { continue }
            newest[entry.id] = (entry, at)
        }
        return newest.values.sorted { $0.at == $1.at ? $0.entry.id < $1.entry.id : $0.at > $1.at }
            .prefix(cap).map(\.entry)
    }

    /// The synced list as rows: each with this phone's snapshot of the task when it has one,
    /// at the time the synced list gives.
    static func shown(synced: [RecentOpenedEntry], local: [RecentOpen]) -> [RecentOpen] {
        var byId: [String: RecentOpen] = [:]
        for entry in local where byId[entry.id] == nil { byId[entry.id] = entry }
        return synced.map { item in
            let at = date(item.at) ?? .distantPast
            guard var entry = byId[item.id] else {
                return RecentOpen(id: item.id, taskId: item.id, task: nil, session: nil, openedAt: at)
            }
            entry.openedAt = at
            return entry
        }
    }

    static func iso(_ date: Date) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: date)
    }

    static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

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
