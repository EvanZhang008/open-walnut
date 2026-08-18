import Foundation
@testable import Walnut

/// Scripted WalnutTaskTransport for store-level tests: every endpoint answers
/// from a queue/closure the test controls, records its calls, and can be told
/// to fail or to suspend (so tests can assert the UI state MID-flight —
/// the "instant apply" half of optimistic-first).
final class MockTaskTransport: WalnutTaskTransport, @unchecked Sendable {
    struct Call: Equatable {
        let name: String
        let args: [String]
    }

    private let lock = NSLock()
    private(set) var calls: [Call] = []

    // Per-endpoint scripting. `error` non-nil → the endpoint throws.
    var error: Error?
    /// Errors keyed by endpoint name — more precise than the global `error`.
    var errorsByEndpoint: [String: Error] = [:]
    /// When set, endpoints await this before answering (test-controlled
    /// suspension: assert optimistic state, then resume).
    var gate: CheckedContinuationGate?

    var tasksResponse = TasksResponse(tasks: [], syncedAt: "2026-08-16T00:00:00Z")
    /// updateTask answer builder — defaults to echoing the patch as a row.
    var updateTaskResult: ((String) -> WalnutTask)?
    var batchPhaseResult = BatchPhaseResult(changed: [], failed: [], syncFailed: nil)
    var batchDeleteResult = BatchDeleteResult(deleted: [], failed: [])
    var taskDetailResult: TaskDetail?
    var starResult = true
    var pinnedTasksResult: [String] = []
    var tierSplitResult = FocusTierResult(
        pinnedTasks: [], focusTasks: [], satelliteTasks: [],
        backlogTasks: [], waitTasks: [], customTierTasks: [:]
    )
    var customTiersResult: [FocusTierInfo] = []

    private func record(_ name: String, _ args: [String]) {
        lock.lock(); calls.append(Call(name: name, args: args)); lock.unlock()
    }

    func callCount(_ name: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return calls.filter { $0.name == name }.count
    }

    private func checkpoint(_ name: String, _ args: [String]) async throws {
        record(name, args)
        if let gate { await gate.wait() }
        if let err = errorsByEndpoint[name] { throw err }
        if let error { throw error }
    }

    // MARK: - WalnutTaskTransport

    func tasks() async throws -> TasksResponse {
        try await checkpoint("tasks", [])
        return tasksResponse
    }

    func updateTask(
        id: String, status: String?, priority: String?, dueDate: String?,
        startDate: String?, endDate: String?,
        project: String?, title: String?, description: String?
    ) async throws -> WalnutTask {
        // The calendar dates join the recorded args so a test can assert WHAT a
        // reschedule sent, not just that a PATCH happened.
        try await checkpoint("updateTask", [
            id, status ?? "-", priority ?? "-", title ?? "-",
            startDate ?? "-", endDate ?? "-",
        ])
        if let updateTaskResult { return updateTaskResult(id) }
        return WalnutTask(
            id: id, title: title ?? "t", status: status ?? "todo", phase: "TODO",
            priority: priority ?? "none", project: project ?? "", dueDate: dueDate,
            createdAt: "2026-08-16T00:00:00Z", updatedAt: "2026-08-16T00:00:01Z",
            completedAt: status == "done" ? "2026-08-16T00:00:01Z" : nil,
            starred: nil, pinned: nil, tags: nil, summary: nil,
            startDate: (startDate?.isEmpty ?? true) ? nil : startDate,
            endDate: (endDate?.isEmpty ?? true) ? nil : endDate
        )
    }

    func batchSetPhase(taskIds: [String], phase: String) async throws -> BatchPhaseResult {
        try await checkpoint("batchSetPhase", taskIds + [phase])
        return batchPhaseResult
    }

    func batchDeleteTasks(taskIds: [String], force: Bool) async throws -> BatchDeleteResult {
        try await checkpoint("batchDeleteTasks", taskIds + [force ? "force" : "-"])
        return batchDeleteResult
    }

    func taskDetail(id: String) async throws -> TaskDetail {
        try await checkpoint("taskDetail", [id])
        if let taskDetailResult { return taskDetailResult }
        throw APIError.badResponse
    }

    func deleteTask(id: String, force: Bool) async throws {
        try await checkpoint("deleteTask", [id, force ? "force" : "-"])
    }

    func toggleTaskStar(id: String) async throws -> Bool {
        try await checkpoint("toggleTaskStar", [id])
        return starResult
    }

    func setTaskField(id: String, field: String, content: String) async throws {
        try await checkpoint("setTaskField", [id, field, content])
    }

    func pinTask(id: String) async throws -> [String] {
        try await checkpoint("pinTask", [id])
        return pinnedTasksResult
    }

    func unpinTask(id: String) async throws -> [String] {
        try await checkpoint("unpinTask", [id])
        return pinnedTasksResult
    }

    func setTaskFocusTier(id: String, tier: String) async throws -> FocusTierResult {
        try await checkpoint("setTaskFocusTier", [id, tier])
        return tierSplitResult
    }

    func focusTasks() async throws -> FocusTierResult {
        try await checkpoint("focusTasks", [])
        return tierSplitResult
    }

    func focusTiers() async throws -> [FocusTierInfo] {
        try await checkpoint("focusTiers", [])
        return customTiersResult
    }

    func patchSession(id: String, title: String?, archived: Bool?, mode: String?) async throws -> SessionPatched {
        try await checkpoint("patchSession", [id, title ?? "-", archived.map(String.init) ?? "-"])
        return SessionPatched(session: SessionDetail.Record(
            claudeSessionId: id, processStatus: "idle", title: title,
            mode: mode, archived: archived
        ))
    }
}

/// Simple async gate: endpoints suspend on `wait()` until the test `open()`s.
/// Lets tests assert the optimistic (mid-flight) UI state deterministically.
final class CheckedContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if isOpen {
                lock.unlock()
                cont.resume()
            } else {
                waiters.append(cont)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.resume() }
    }
}
