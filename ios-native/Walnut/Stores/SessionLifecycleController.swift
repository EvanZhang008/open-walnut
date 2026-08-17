import Foundation
import Observation

/// Lifecycle state + actions for one session — pending permission prompts,
/// restart/terminate/retry, rename/archive. Deliberately SEPARATE from
/// SessionConversationStore: the conversation store owns the (recently
/// stabilized) transcript/stream rendering path, and lifecycle is a control
/// plane over the additive Wave-1 endpoints — keeping it here means zero risk
/// to the timeline.
///
/// Permission prompts: GET /v1/sessions/:id detail carries pendingPermissions.
/// There is no dedicated SSE event for them, so the controller polls the
/// detail while the page is open (12s — prompts block the CLI turn, so they
/// wait) and refetches immediately after answering.
@Observable
@MainActor
final class SessionLifecycleController {
    private let api = WalnutAPI()
    let sessionId: String

    /// Live tool-permission prompts (empty = no card).
    private(set) var pendingPermissions: [PendingPermission] = []
    /// requestIds with an answer POST in flight (buttons disable per card).
    private(set) var answeringIds: Set<String> = []
    /// True while a lifecycle action (restart/terminate/retry/patch) runs.
    private(set) var acting = false
    /// Human-readable failure for the caller's banner.
    var errorMessage: String?
    /// Transient success line ("Session restarted — 2 messages re-queued").
    var confirmation: String?
    /// Server truth from the last detail fetch (title/archived prefill).
    private(set) var detail: SessionDetail?

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    private static let pollSeconds: Double = 12

    init(sessionId: String) {
        self.sessionId = sessionId
    }

    // MARK: - Permission polling

    /// Start polling the session detail (idempotent). Called from the page's
    /// .task; stop() from onDisappear.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshDetail()
                try? await Task.sleep(for: .seconds(Self.pollSeconds))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refreshDetail() async {
        do {
            let next = try await api.sessionDetail(id: sessionId)
            detail = next
            // Equality-gated: detail polls at 12s and this drives the card's
            // visibility — a same-value write must not invalidate the page.
            if next.pendingPermissions != pendingPermissions {
                pendingPermissions = next.pendingPermissions
            }
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            // Detail polling is best-effort (old server → 404); never banner it.
            AppLog.debug("session-lifecycle", "detail poll failed", [
                "sessionId": sessionId, "error": error.localizedDescription,
            ])
        }
    }

    /// Answer one prompt. Optimistic removal + rollback: the card disappears
    /// instantly; a failure puts it back with the error line.
    func respondPermission(_ request: PendingPermission, allow: Bool) async {
        guard !answeringIds.contains(request.requestId) else { return }
        answeringIds.insert(request.requestId)
        let original = pendingPermissions
        pendingPermissions.removeAll { $0.requestId == request.requestId }
        defer { answeringIds.remove(request.requestId) }
        do {
            _ = try await api.respondSessionPermission(
                id: sessionId, requestId: request.requestId, allow: allow
            )
            AppLog.info("session-lifecycle", "permission answered", [
                "sessionId": sessionId, "requestId": request.requestId, "allow": String(allow),
            ])
            await refreshDetail()
        } catch {
            // "Gone/already resolved" is success-shaped: the prompt no longer
            // exists server-side, so keep it dismissed.
            if let apiError = error as? APIError, apiError.code == "not_found" { return }
            pendingPermissions = original
            errorMessage = Self.friendlyError(error)
        }
    }

    // MARK: - Lifecycle actions

    /// Restart (respawn --resume) — how the phone wakes a dead session.
    /// Returns true on success so callers can refresh their conversation.
    @discardableResult
    func restart() async -> Bool {
        await run {
            let result = try await self.api.restartSession(id: self.sessionId)
            self.confirmation = result.pendingMessages > 0
                ? "Session restarted — \(result.pendingMessages) queued message(s) will re-deliver."
                : "Session restarted."
            return true
        }
    }

    /// Retry a failed/stopped session.
    @discardableResult
    func retry() async -> Bool {
        await run {
            let result = try await self.api.retrySession(id: self.sessionId)
            switch result.status {
            case "reconnected": self.confirmation = "Reconnected — the process was still alive."
            case "resuming": self.confirmation = "Resuming the session…"
            case "pending": self.confirmation = "A fresh session is starting on this task."
            default: self.confirmation = "Retry accepted."
            }
            return true
        }
    }

    /// Terminate. Returns .done, .needsForce (armed crons — confirm with the
    /// user, then call again with force: true), or .failed.
    enum TerminateOutcome { case done, needsForce(String), failed }

    func terminate(force: Bool = false) async -> TerminateOutcome {
        guard !acting else { return .failed }
        acting = true
        errorMessage = nil
        confirmation = nil
        defer { acting = false }
        do {
            _ = try await api.terminateSession(id: sessionId, force: force)
            confirmation = "Session terminated."
            return .done
        } catch let error as APIError where error.isCronOwner {
            return .needsForce(error.localizedDescription)
        } catch {
            errorMessage = Self.friendlyError(error)
            return .failed
        }
    }

    /// Rename the session — optimistic-first: the list row (TasksStore) flips
    /// instantly and reverts on failure; no `acting` spinner window for a
    /// simple field write. Falls back to a plain awaited PATCH when no list
    /// store exists (unit tests, detached pages).
    @discardableResult
    func rename(_ title: String) async -> Bool {
        errorMessage = nil
        confirmation = nil
        if let store = TasksStore.shared,
           store.sessions.contains(where: { $0.id == sessionId }) {
            if let failure = await store.renameSession(id: sessionId, title: title) {
                errorMessage = failure
                return false
            }
            confirmation = "Session renamed."
            return true
        }
        return await run {
            _ = try await self.api.patchSession(id: self.sessionId, title: title)
            self.confirmation = "Session renamed."
            return true
        }
    }

    /// Archive/unarchive the session — optimistic through the list store
    /// (archive removes the row immediately; failure restores it).
    @discardableResult
    func setArchived(_ archived: Bool) async -> Bool {
        errorMessage = nil
        confirmation = nil
        if let store = TasksStore.shared,
           archived, store.sessions.contains(where: { $0.id == sessionId }) {
            if let failure = await store.setSessionArchived(id: sessionId, archived: archived) {
                errorMessage = failure
                return false
            }
            confirmation = "Session archived."
            return true
        }
        return await run {
            _ = try await self.api.patchSession(id: self.sessionId, archived: archived)
            self.confirmation = archived ? "Session archived." : "Session unarchived."
            return true
        }
    }

    private func run(_ operation: @MainActor () async throws -> Bool) async -> Bool {
        guard !acting else { return false }
        acting = true
        errorMessage = nil
        confirmation = nil
        defer { acting = false }
        do {
            return try await operation()
        } catch {
            errorMessage = Self.friendlyError(error)
            return false
        }
    }

    /// Honest copy for the Wave-1 failure ladder (mirrors SessionControlsSheet).
    static func friendlyError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "session_control_needs_upgrade":
            return "Your primary box is upgrading for mobile session control — try again in a minute."
        case "bridge_offline":
            return "The primary box isn't reachable right now — try again when it reconnects."
        case "cron_owner":
            return "This session owns scheduled routines — force-terminate to kill it anyway."
        case "not_found":
            return "This session no longer exists on the server."
        default:
            return apiError.localizedDescription
        }
    }
}
