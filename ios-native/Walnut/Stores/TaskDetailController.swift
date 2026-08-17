import Foundation
import Observation

/// Detail-plane state for one task — the FULL row from GET /v1/tasks/:id
/// (description/note readback the slim list omits) plus the Wave-1 actions:
/// star toggle, focus pin/unpin, delete (with the active-session force
/// ladder), and description/note editing. Kept out of TasksStore on purpose:
/// the list store stays a thin projection cache; this controller is scoped to
/// one open detail sheet.
///
/// Instant-first (2026-08): star and description/note writes apply to the
/// local `detail` snapshot synchronously, call the API behind, and revert
/// with an error line on failure — no spinner windows. `acting` still gates
/// only the destructive delete ladder.
@Observable
@MainActor
final class TaskDetailController {
    /// Injectable transport (WalnutTests) — production uses the live client.
    private let api: WalnutTaskTransport
    let taskId: String

    /// Full server row (nil until the first fetch lands).
    private(set) var detail: TaskDetail?
    private(set) var loading = false
    /// True while a destructive action (delete) runs — buttons disable.
    private(set) var acting = false
    var errorMessage: String?
    /// Delete hit 409 with active sessions — confirm, then force.
    var deleteNeedsForce: [String]?

    init(taskId: String, transport: WalnutTaskTransport? = nil) {
        self.taskId = taskId
        self.api = transport ?? WalnutAPI()
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

    /// Rebuild the immutable TaskDetail with one changed field. Static + pure
    /// so WalnutTests can gate the optimistic projection directly.
    static func withField(
        _ d: TaskDetail, starred: Bool? = nil, description: String? = nil, note: String? = nil
    ) -> TaskDetail {
        TaskDetail(
            id: d.id, title: d.title, status: d.status, phase: d.phase,
            priority: d.priority, project: d.project,
            description: description ?? d.description,
            summary: d.summary, note: note ?? d.note, tags: d.tags,
            starred: starred ?? d.starred, pinned: d.pinned,
            dependsOn: d.dependsOn, isBlocked: d.isBlocked,
            resolvedDependencies: d.resolvedDependencies,
            dependents: d.dependents, children: d.children, parent: d.parent,
            sessionIds: d.sessionIds
        )
    }

    /// Toggle star — optimistic: the chip flips instantly; revert on failure.
    func toggleStar() async {
        let original = detail
        let next = !(detail?.starred == true)
        if let d = detail { detail = Self.withField(d, starred: next) }
        errorMessage = nil
        do {
            let confirmed = try await api.toggleTaskStar(id: taskId)
            // Adopt the server's answer if it disagrees (idempotency races).
            if let d = detail, d.starred != confirmed {
                detail = Self.withField(d, starred: confirmed)
            }
        } catch {
            detail = original
            errorMessage = Self.friendlyError(error)
        }
    }

    /// Pin/unpin via the focus endpoints — FALLBACK path for rows outside the
    /// list projection (TaskDetailExtras prefers TasksStore.setPinned, which
    /// is optimistic against the live row). Returns the new state, nil on
    /// failure.
    func setPinned(_ pinned: Bool) async -> Bool? {
        errorMessage = nil
        do {
            _ = pinned
                ? try await api.pinTask(id: taskId)
                : try await api.unpinTask(id: taskId)
            return pinned
        } catch {
            errorMessage = Self.friendlyError(error)
            return nil
        }
    }

    /// Replace the description — optimistic (readback text swaps instantly,
    /// editor closes immediately; failure reverts + error line).
    func saveDescription(_ content: String) {
        saveFieldInstant(field: "description", content: content)
    }

    /// Replace the whole note — same optimistic contract.
    func saveNote(_ content: String) {
        saveFieldInstant(field: "note", content: content)
    }

    private func saveFieldInstant(field: String, content: String) {
        let original = detail
        if let d = detail {
            detail = field == "description"
                ? Self.withField(d, description: content)
                : Self.withField(d, note: content)
        }
        errorMessage = nil
        Task {
            do {
                try await api.setTaskField(id: taskId, field: field, content: content)
            } catch {
                detail = original
                errorMessage = Self.friendlyError(error)
            }
        }
    }

    /// Delete. Returns true when the task is gone (caller dismisses). A 409
    /// with active sessions sets `deleteNeedsForce` for the confirm dialog.
    /// (TaskDetailExtras prefers TasksStore.deleteTask — optimistic against
    /// the live list; this stays as the out-of-projection fallback.)
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

    static func friendlyError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "not_found": return "This task no longer exists on the server."
        case "conflict": return apiError.localizedDescription
        default: return apiError.localizedDescription
        }
    }
}
