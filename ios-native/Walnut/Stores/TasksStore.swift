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

    var tasks: [WalnutTask] = []
    var syncedAt: Date?
    var loading = false
    var errorMessage: String?
    /// true when the server returned 503 (fresh companion, projection not
    /// synced yet) — drives the friendly "Tasks not synced yet" state.
    var notSyncedYet = false

    /// Instant render from cache, then a network refresh.
    func initialize() async {
        if let cached: [WalnutTask] = DiskCache.load([WalnutTask].self, key: "tasks-list") {
            tasks = cached
        }
        if let cachedSynced: String = DiskCache.load(String.self, key: "tasks-syncedAt") {
            syncedAt = WalnutTask.parseISO(cachedSynced)
        }
        await loadTasks()
    }

    func loadTasks() async {
        loading = true
        defer { loading = false }
        do {
            let response = try await api.tasks()
            tasks = response.tasks
            syncedAt = WalnutTask.parseISO(response.syncedAt)
            notSyncedYet = false
            errorMessage = nil
            connection?.reportReachability(true)
            DiskCache.save(response.tasks, key: "tasks-list")
            DiskCache.save(response.syncedAt, key: "tasks-syncedAt")
        } catch let error as APIError where error.isUnavailable {
            // 503 — projection hasn't synced; keep any cached tasks but flag it.
            notSyncedYet = true
            if tasks.isEmpty { errorMessage = nil }
        } catch {
            reportIfNetwork(error)
            if tasks.isEmpty { errorMessage = error.localizedDescription }
        }
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
    func tasks(for filter: TaskFilter) -> [WalnutTask] {
        switch filter {
        case .today: return todayTasks.sorted(by: WalnutTask.openSort)
        case .inProgress: return inProgressTasks.sorted(by: WalnutTask.openSort)
        case .allOpen: return openTasks.sorted(by: WalnutTask.openSort)
        case .done: return doneTasks.sorted(by: WalnutTask.doneSort)
        }
    }

    func count(for filter: TaskFilter) -> Int {
        switch filter {
        case .today: return todayTasks.count
        case .inProgress: return inProgressTasks.count
        case .allOpen: return openTasks.count
        case .done: return doneTasks.count
        }
    }

    private func reportIfNetwork(_ error: Error) {
        if let apiError = error as? APIError, case .network = apiError {
            connection?.reportReachability(false)
        }
    }
}

/// The four Reminders-style smart lists.
enum TaskFilter: String, CaseIterable, Identifiable {
    case today, inProgress, allOpen, done
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .inProgress: return "In Progress"
        case .allOpen: return "All Open"
        case .done: return "Done"
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "calendar"
        case .inProgress: return "arrow.triangle.2.circlepath"
        case .allOpen: return "tray.full"
        case .done: return "checkmark"
        }
    }

    /// accessibilityIdentifier suffix ("today"/"inprogress"/"all"/"done").
    var identifierKey: String {
        switch self {
        case .today: return "today"
        case .inProgress: return "inprogress"
        case .allOpen: return "all"
        case .done: return "done"
        }
    }
}
