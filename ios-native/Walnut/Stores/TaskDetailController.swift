import Foundation
import Observation

/// Detail-plane state for one task — the FULL row from GET /v1/tasks/:id
/// (description/note readback the slim list omits) plus the Wave-1 actions:
/// star toggle, focus pin/unpin, delete (with the active-session force
/// ladder), and description/note editing. Kept out of TasksStore on purpose:
/// the list store stays a thin projection cache; this controller is scoped to
/// one open detail sheet.
@Observable
@MainActor
final class TaskDetailController {
    private let api = WalnutAPI()
    let taskId: String

    /// Full server row (nil until the first fetch lands).
    private(set) var detail: TaskDetail?
    private(set) var loading = false
    /// True while any mutation runs (buttons disable).
    private(set) var acting = false
    var errorMessage: String?
    /// Delete hit 409 with active sessions — confirm, then force.
    var deleteNeedsForce: [String]?

    init(taskId: String) {
        self.taskId = taskId
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            detail = try await api.taskDetail(id: taskId)
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            // Detail is an enhancement layer — the sheet's projection data
            // still renders; only the extra sections show the error.
            errorMessage = Self.friendlyError(error)
        }
    }

    /// Toggle star; returns the new state (nil on failure).
    func toggleStar() async -> Bool? {
        await runAction {
            let starred = try await self.api.toggleTaskStar(id: self.taskId)
            await self.load()
            return starred
        }
    }

    /// Pin/unpin via the focus endpoints. Pinning a completed task → 409.
    func setPinned(_ pinned: Bool) async -> Bool? {
        await runAction {
            _ = pinned
                ? try await self.api.pinTask(id: self.taskId)
                : try await self.api.unpinTask(id: self.taskId)
            return pinned
        }
    }

    /// Replace the description (PUT /tasks/:id/description).
    func saveDescription(_ content: String) async -> Bool {
        await runAction {
            try await self.api.setTaskField(id: self.taskId, field: "description", content: content)
            await self.load()
            return true
        } ?? false
    }

    /// Replace the whole note (PUT /tasks/:id/note).
    func saveNote(_ content: String) async -> Bool {
        await runAction {
            try await self.api.setTaskField(id: self.taskId, field: "note", content: content)
            await self.load()
            return true
        } ?? false
    }

    /// Delete. Returns true when the task is gone (caller dismisses). A 409
    /// with active sessions sets `deleteNeedsForce` for the confirm dialog.
    func delete(force: Bool = false) async -> Bool {
        guard !acting else { return false }
        acting = true
        errorMessage = nil
        defer { acting = false }
        do {
            try await api.deleteTask(id: taskId, force: force)
            return true
        } catch let error as APIError where error.isConflict {
            // The envelope's active_session_ids extra isn't decoded (frozen
            // decode path) — the message names the sessions; count is enough.
            deleteNeedsForce = [error.localizedDescription]
            return false
        } catch {
            errorMessage = Self.friendlyError(error)
            return false
        }
    }

    private func runAction<T>(_ operation: @MainActor () async throws -> T) async -> T? {
        guard !acting else { return nil }
        acting = true
        errorMessage = nil
        defer { acting = false }
        do {
            return try await operation()
        } catch {
            errorMessage = Self.friendlyError(error)
            return nil
        }
    }

    static func friendlyError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "not_found": return "This task no longer exists on the server."
        case "conflict": return apiError.localizedDescription
        default: return apiError.localizedDescription
        }
    }
}
