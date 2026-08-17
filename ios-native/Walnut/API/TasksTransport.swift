import Foundation

// MARK: - Task mutation transport (mock seam for WalnutTests)
//
// The stores drive every task/session mutation through this narrow protocol
// instead of concrete WalnutAPI calls, so WalnutTests can exercise the REAL
// optimistic apply/rollback state machines against a scripted transport
// (success, failure → revert, slow round trip, partial batch failure) without
// a network. WalnutAPI is the live implementation — the requirements match
// its existing endpoint methods 1:1, so conformance is an empty extension.

protocol WalnutTaskTransport {
    // Task list + edits
    func tasks() async throws -> TasksResponse
    func updateTask(
        id: String, status: String?, priority: String?, dueDate: String?,
        project: String?, title: String?, description: String?
    ) async throws -> WalnutTask
    func batchSetPhase(taskIds: [String], phase: String) async throws -> BatchPhaseResult
    func batchDeleteTasks(taskIds: [String], force: Bool) async throws -> BatchDeleteResult

    // Detail plane (star / delete / long-text fields)
    func taskDetail(id: String) async throws -> TaskDetail
    func deleteTask(id: String, force: Bool) async throws
    func toggleTaskStar(id: String) async throws -> Bool
    func setTaskField(id: String, field: String, content: String) async throws

    // Focus pins + tiers
    func pinTask(id: String) async throws -> [String]
    func unpinTask(id: String) async throws -> [String]
    func setTaskFocusTier(id: String, tier: String) async throws -> FocusTierResult
    func focusTasks() async throws -> FocusTierResult
    func focusTiers() async throws -> [FocusTierInfo]

    // Session metadata (rename / archive)
    func patchSession(id: String, title: String?, archived: Bool?, mode: String?) async throws -> SessionPatched
}

/// One custom tier from `GET /v1/focus/tiers` → `{ "tiers": [ { id, label } ] }`.
/// `id` is a `ct_*` stable id; tasks reference it via `focus_tier`.
struct FocusTierInfo: Codable, Equatable, Identifiable {
    let id: String
    let label: String
}

extension WalnutAPI {
    /// GET /api/v1/focus/tiers — the custom tier registry (ordered). Built-in
    /// tiers (focus/satellite/backlog/wait) are implicit and never listed here.
    func focusTiers() async throws -> [FocusTierInfo] {
        struct Wrapper: Codable { let tiers: [FocusTierInfo] }
        let wrapper: Wrapper = try await get("/focus/tiers")
        return wrapper.tiers
    }
}

extension WalnutAPI: WalnutTaskTransport {}
