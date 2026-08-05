import Foundation
import Observation

/// Read-only task state — the frozen /api/v1/tasks projection. Loads a disk-
/// cached snapshot instantly, then refreshes from the network (same stale-
/// while-revalidate pattern as NotesStore). v1 is strictly read-only: no
/// mutations, no checkbox toggling.
@Observable
@MainActor
final class TasksStore {
    private let api = WalnutAPI()
    weak var connection: ConnectionStore?

    /// False while backgrounded — every completion re-checks it before touching
    /// observed state, so a fetch that lands during suspension cannot drive
    /// SwiftUI updates from a non-active process (P0-3).
    private var isActive = true

    /// Monotonic request sequence — a slow stale list fetch must not overwrite
    /// a newer one (same pattern as the web SessionSearchPanel requestSeq).
    /// MainActor-confined, so increment/compare are race-free.
    private var taskLoadSeq = 0
    private var sessionLoadSeq = 0

    var tasks: [WalnutTask] = []
    var syncedAt: Date?
    var loading = false
    var errorMessage: String?
    /// true when the server returned 503 (fresh companion, projection not
    /// synced yet) — drives the friendly "Tasks not synced yet" state.
    var notSyncedYet = false

    // Sessions ride the same panel as a smart-list tab (read-only projection).
    var sessions: [WalnutSession] = []
    var sessionsSyncedAt: Date?
    var sessionsNotSyncedYet = false

    init() {
        LifecycleHub.shared.register(self)
    }

    /// Render from cache, then refresh. The cache reads are OFF-MAIN (P0-1): a
    /// synchronous decode here was cold-start work that could get a
    /// background / prewarm launch killed for blowing the scene-update budget.
    /// Each adoption is guarded on "nothing canonical landed yet" because the
    /// network refresh can win the race.
    func initialize() async {
        isActive = true
        if let cached = await DiskCache.loadAsync([WalnutTask].self, key: "tasks-list"),
           isActive, tasks.isEmpty {
            tasks = cached
        }
        if let cachedSynced = await DiskCache.loadAsync(String.self, key: "tasks-syncedAt"),
           isActive, syncedAt == nil {
            syncedAt = WalnutTask.parseISO(cachedSynced)
        }
        if let cachedSessions = await DiskCache.loadAsync([WalnutSession].self, key: "sessions-list"),
           isActive, sessions.isEmpty {
            sessions = cachedSessions
        }
        async let t: Void = loadTasks()
        async let s: Void = loadSessions()
        _ = await (t, s)
    }

    func loadTasks() async {
        guard isActive else { return }
        taskLoadSeq += 1
        let seq = taskLoadSeq
        loading = true
        defer { loading = false }
        do {
            let response = try await api.tasks()
            guard isActive, !Task.isCancelled, seq == taskLoadSeq else { return }
            tasks = response.tasks
            syncedAt = WalnutTask.parseISO(response.syncedAt)
            notSyncedYet = false
            errorMessage = nil
            connection?.reportReachability(true, source: "tasks-rest")
            DiskCache.save(response.tasks, key: "tasks-list")
            DiskCache.save(response.syncedAt, key: "tasks-syncedAt")
        } catch let error as APIError where error.isUnavailable {
            // 503 — projection hasn't synced; keep any cached tasks but flag it.
            guard isActive, seq == taskLoadSeq else { return }
            notSyncedYet = true
            if tasks.isEmpty { errorMessage = nil }
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive, seq == taskLoadSeq else { return }
            reportIfNetwork(error)
            if tasks.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    func loadSessions() async {
        guard isActive else { return }
        sessionLoadSeq += 1
        let seq = sessionLoadSeq
        do {
            let response = try await api.sessions()
            guard isActive, !Task.isCancelled, seq == sessionLoadSeq else { return }
            sessions = response.sessions
            sessionsSyncedAt = WalnutTask.parseISO(response.syncedAt)
            sessionsNotSyncedYet = false
            connection?.reportReachability(true, source: "tasks-rest")
            DiskCache.save(response.sessions, key: "sessions-list")
        } catch let error as APIError where error.isUnavailable {
            guard isActive, seq == sessionLoadSeq else { return }
            sessionsNotSyncedYet = true
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            guard isActive, seq == sessionLoadSeq else { return }
            reportIfNetwork(error)
        }
    }

    /// Create a task on the primary box. Optimistic: the server's created task
    /// is inserted into the local list immediately (so the Tasks list shows it
    /// without waiting for the next projection export), then a background
    /// refresh reconciles. Throws on failure — the sheet surfaces the error.
    @discardableResult
    func createTask(
        title: String, project: String? = nil, priority: String? = nil,
        dueDate: String? = nil, description: String? = nil
    ) async throws -> WalnutTask {
        let created = try await api.createTask(
            title: title, project: project, priority: priority,
            dueDate: dueDate, description: description
        )
        if isActive, !tasks.contains(where: { $0.id == created.id }) {
            tasks.insert(created, at: 0)
            DiskCache.save(tasks, key: "tasks-list")
        }
        // Reconcile with the projection in the background (it may lag a few
        // seconds behind the SQLite write; loadTasks keeps whichever is newer).
        Task { await self.loadTasks() }
        return created
    }

    // MARK: - Derived session slices

    /// Sessions with a live CLI process (running or idle), pinned first.
    var activeSessions: [WalnutSession] {
        sessions.filter { $0.statusKind.isAlive }.sorted(by: sessionOrder)
    }

    var pinnedSessions: [WalnutSession] {
        sessions.filter { $0.isPinned }.sorted(by: sessionOrder)
    }

    /// Pinned first (focus tier before the rest), then most recently active.
    private func sessionOrder(_ a: WalnutSession, _ b: WalnutSession) -> Bool {
        if a.isPinned != b.isPinned { return a.isPinned }
        let af = a.focusTier == "focus", bf = b.focusTier == "focus"
        if af != bf { return af }
        return WalnutSession.recencySort(a, b)
    }

    // MARK: - Derived slices (smart lists)

    var openTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .todo || $0.statusKind == .inProgress }
    }

    var inProgressTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .inProgress }
    }

    var todayTasks: [WalnutTask] {
        openTasks.filter { $0.isDueToday || $0.isOverdue }
    }

    var doneTasks: [WalnutTask] {
        tasks.filter { $0.statusKind == .done }
    }

    /// Tasks for a smart-list filter, already sorted for section rendering.
    /// (.sessions renders its own list — returns [] here.)
    func tasks(for filter: TaskFilter) -> [WalnutTask] {
        switch filter {
        case .today: return todayTasks.sorted(by: WalnutTask.openSort)
        case .inProgress: return inProgressTasks.sorted(by: WalnutTask.openSort)
        case .sessions: return []
        case .allOpen: return openTasks.sorted(by: WalnutTask.openSort)
        case .done: return doneTasks.sorted(by: WalnutTask.doneSort)
        }
    }

    func count(for filter: TaskFilter) -> Int {
        switch filter {
        case .today: return todayTasks.count
        case .inProgress: return inProgressTasks.count
        case .sessions: return sessions.count
        case .allOpen: return openTasks.count
        case .done: return doneTasks.count
        }
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError {
            if apiError.isCancelled { return }
            if case .network = apiError {
                connection?.reportReachability(false, source: "tasks-rest", error: error)
            }
        }
    }
}

extension TasksStore: LifecycleSuspendable {
    /// Read-only store — nothing to tear down, the contract is only "stop
    /// mutating observed state while not active" (see `isActive`).
    func suspendForBackground() { isActive = false }
    func resumeForForeground() { isActive = true }
}

/// The Reminders-style smart lists (+ the Sessions tab).
enum TaskFilter: String, CaseIterable, Identifiable {
    // Declaration order IS the card order: Sessions leads — live agent work
    // is the primary daily surface, task lists follow.
    case sessions, today, inProgress, allOpen, done
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .inProgress: return "In Progress"
        case .sessions: return "Sessions"
        case .allOpen: return "All Open"
        case .done: return "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "calendar"
        case .inProgress: return "arrow.triangle.2.circlepath"
        case .sessions: return "terminal"
        case .allOpen: return "tray.full"
        case .done: return "checkmark"
        }
    }

    /// accessibilityIdentifier suffix ("today"/"inprogress"/"sessions"/"all"/"done").
    var identifierKey: String {
        switch self {
        case .today: return "today"
        case .inProgress: return "inprogress"
        case .sessions: return "sessions"
        case .allOpen: return "all"
        case .done: return "done"
        }
    }
}
