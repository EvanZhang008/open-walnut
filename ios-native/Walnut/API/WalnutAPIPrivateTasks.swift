import Foundation

// MARK: - Private tasks (server `src/core/private-tasks/`, routes `private-tasks-v1.ts`)
//
// A task can be local inside a project that syncs to an outside service (a tracker plugin): its
// `source` is local and its `sync_hold` says why. The phone reads which projects sync from
// `GET /v1/projects` and moves a task between Local and that service with the same routes the web
// task menu uses. Every write answers 501 `not_supported_cloud` on the cloud companion.

/// One row of `GET /v1/projects`, only what the Local / <service> choice needs.
struct WalnutProjectSource: Codable, Equatable {
    let name: String
    /// "local" or the outside service's plugin id.
    let source: String
    /// The service's name (additive, 2026-11-01); nil from an older server, then the id is shown.
    var sourceName: String? = nil

    private enum CodingKeys: String, CodingKey {
        case name, source
        case sourceName = "source_name"
    }
}

/// What happens to the copy in the outside service when a synced task turns local.
enum OutsideCopyChoice: String, CaseIterable, Equatable {
    /// Kept as it is, no longer updated.
    case keep
    /// Closed there.
    case archive
    /// Title and text replaced by nothing of the task, then closed.
    case neutralize
}

/// The answer of make-local, sync-to-project and outside-copy: the task as it is now, and the
/// server's own sentence about what happened (make-local only).
struct SyncChangeAnswer: Decodable, Equatable {
    let task: WalnutTask
    var outcome: String? = nil
    var service: String? = nil
    /// sync-to-project: the push to the service failed (the task is linked; a later push retries).
    var syncError: String? = nil

    private enum CodingKeys: String, CodingKey {
        case task, outcome, service
        case syncError = "sync_error"
    }
}

extension WalnutAPI {
    /// GET /api/v1/projects → `{ projects: [{ name, source, source_name? }] }`.
    func projectSources() async throws -> [WalnutProjectSource] {
        struct Wrapper: Decodable { let projects: [WalnutProjectSource] }
        let wrapper: Wrapper = try await get("/projects")
        return wrapper.projects
    }

    /// POST /api/v1/tasks/:id/make-local { outside }.
    func makeTaskLocal(id: String, outside: OutsideCopyChoice) async throws -> SyncChangeAnswer {
        try await send("POST", "/tasks/\(escape(id))/make-local", body: ["outside": outside.rawValue], timeout: 60)
    }

    /// POST /api/v1/tasks/:id/sync-to-project. A person's tap: no `user_words` (only a session
    /// caller must quote the user).
    func syncTaskToProject(id: String) async throws -> SyncChangeAnswer {
        try await send("POST", "/tasks/\(escape(id))/sync-to-project", body: [String: String](), timeout: 60)
    }

    /// POST /api/v1/tasks/:id/outside-copy { action }: archive or neutralize the copy it left.
    func changeOutsideCopy(id: String, action: OutsideCopyChoice) async throws -> SyncChangeAnswer {
        try await send("POST", "/tasks/\(escape(id))/outside-copy", body: ["action": action.rawValue], timeout: 60)
    }
}
