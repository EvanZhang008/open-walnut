import Foundation

// MARK: - Wave 1 endpoints (additive /api/v1, docs/reference/api-v1.md)
//
// Session lifecycle, butler conversation management, task detail + batch +
// focus pins, and global search. All ride WalnutAPI's shared request/decode
// funnel so auth, logging, and the frozen error envelope apply uniformly.

extension WalnutAPI {
    // MARK: - Session lifecycle

    /// Full session detail + live pending permission prompts.
    func sessionDetail(id: String) async throws -> SessionDetail {
        try await get("/sessions/\(escape(id))")
    }

    /// PATCH title/archived/mode — at least one field required server-side.
    func patchSession(
        id: String, title: String? = nil, archived: Bool? = nil, mode: String? = nil
    ) async throws -> SessionPatched {
        struct Body: Encodable {
            let title: String?
            let archived: Bool?
            let mode: String?
        }
        return try await send(
            "PATCH", "/sessions/\(escape(id))",
            body: Body(title: title, archived: archived, mode: mode)
        )
    }

    /// Kill the CLI process (no respawn). 409 cron_owner unless force —
    /// callers confirm with the user, then retry with force=true.
    func terminateSession(id: String, force: Bool = false) async throws -> SessionTerminated {
        struct Body: Encodable { let force: Bool? }
        return try await send(
            "POST", "/sessions/\(escape(id))/terminate",
            body: Body(force: force ? true : nil),
            timeout: 45
        )
    }

    /// Respawn a fresh CLI — how the phone wakes an idle-reaped/dead session.
    /// Long timeout: the respawn is a full `--resume` spawn (slower over SSH).
    func restartSession(id: String) async throws -> SessionRestarted {
        try await send("POST", "/sessions/\(escape(id))/restart", body: nil as [String: String]?, timeout: 60)
    }

    /// Retry a failed/stopped session (reconnect / resume / restart-on-task).
    func retrySession(id: String) async throws -> SessionRetried {
        try await send("POST", "/sessions/\(escape(id))/retry", body: nil as [String: String]?, timeout: 60)
    }

    /// Answer a live CLI tool-permission prompt. `message` = deny reason.
    func respondSessionPermission(
        id: String, requestId: String, allow: Bool, message: String? = nil
    ) async throws -> PermissionResolved {
        struct Body: Encodable {
            let requestId: String
            let allow: Bool
            let message: String?
        }
        return try await send(
            "POST", "/sessions/\(escape(id))/permission",
            body: Body(requestId: requestId, allow: allow, message: message)
        )
    }

    // MARK: - Butler conversation management

    /// Rename and/or pin a butler conversation.
    func patchConversation(
        id: String, agentID: String = "general", title: String? = nil, pinned: Bool? = nil
    ) async throws -> ConversationPatched {
        struct Body: Encodable {
            let agentId: String
            let title: String?
            let pinned: Bool?
        }
        return try await send(
            "PATCH", "/conversations/\(escape(id))",
            body: Body(agentId: agentID, title: title, pinned: pinned)
        )
    }

    /// Delete a conversation. The MAIN conversation answers 409 conflict.
    func deleteConversation(id: String, agentID: String = "general") async throws {
        struct Empty: Codable {}
        // 204 has an empty body; decode() would fail on it — use a raw call.
        try await sendExpectingNoContent("DELETE", "/conversations/\(escape(id))?agentId=\(escape(agentID))")
    }

    /// Stop the butler's active turn(s) + cancel any pending question.
    func stopConversation(id: String, agentID: String = "general") async throws -> ConversationStopped {
        struct Body: Encodable { let agentId: String }
        return try await send(
            "POST", "/conversations/\(escape(id))/stop",
            body: Body(agentId: agentID)
        )
    }

    /// Answer a pending structured question (user_ask tool).
    func answerConversationQuestion(
        id: String, agentID: String = "general", answers: [String: String]
    ) async throws {
        struct Body: Encodable {
            let agentId: String
            let answers: [String: String]
        }
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send(
            "POST", "/conversations/\(escape(id))/answer",
            body: Body(agentId: agentID, answers: answers)
        )
    }

    // MARK: - Task detail / delete / star / setters / batch

    /// Full task detail — description/note readback + relations.
    func taskDetail(id: String) async throws -> TaskDetail {
        let envelope: TaskDetailEnvelope = try await get("/tasks/\(escape(id))")
        return envelope.task
    }

    /// Delete a task. 409 conflict + active_session_ids unless force (which
    /// stops the sessions first).
    func deleteTask(id: String, force: Bool = false) async throws {
        try await sendExpectingNoContent("DELETE", "/tasks/\(escape(id))\(force ? "?force=true" : "")")
    }

    /// Toggle star. Returns the new starred state.
    func toggleTaskStar(id: String) async throws -> Bool {
        let result: TaskStarred = try await send("POST", "/tasks/\(escape(id))/star", body: nil as [String: String]?)
        return result.starred
    }

    /// Replace one long-text field: "note" | "description" | "summary".
    func setTaskField(id: String, field: String, content: String) async throws {
        struct Ack: Codable {}
        let _: Ack = try await send("PUT", "/tasks/\(escape(id))/\(field)", body: ["content": content])
    }

    /// Batch phase set — partial success ({ changed, failed }) by design.
    func batchSetPhase(taskIds: [String], phase: String) async throws -> BatchPhaseResult {
        struct Body: Encodable {
            let task_ids: [String]
            let phase: String
        }
        return try await send("POST", "/tasks/batch/phase", body: Body(task_ids: taskIds, phase: phase))
    }

    /// Batch delete — partial success ({ deleted, failed }) by design.
    func batchDeleteTasks(taskIds: [String], force: Bool = false) async throws -> BatchDeleteResult {
        struct Body: Encodable {
            let task_ids: [String]
            let force: Bool?
        }
        return try await send("POST", "/tasks/batch/delete", body: Body(task_ids: taskIds, force: force ? true : nil))
    }

    // MARK: - Focus pins

    /// Current tier split (pinned ids + per-tier buckets).
    func focusTasks() async throws -> FocusTierResult {
        try await get("/focus/tasks")
    }

    /// Pin a task (idempotent; pinning a completed task → 409 conflict).
    func pinTask(id: String) async throws -> [String] {
        let result: FocusPinResult = try await send("POST", "/focus/tasks/\(escape(id))", body: nil as [String: String]?)
        return result.pinnedTasks
    }

    /// Unpin a task (idempotent).
    func unpinTask(id: String) async throws -> [String] {
        let result: FocusPinResult = try await send("DELETE", "/focus/tasks/\(escape(id))", body: nil as [String: String]?)
        return result.pinnedTasks
    }

    // MARK: - Global search

    /// Console global search (tasks/memory/sessions). REPLICA → 501
    /// not_supported_cloud — callers show the "needs your Mac online" state.
    func globalSearch(query: String, limit: Int = 30) async throws -> [GlobalSearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let response: GlobalSearchResponse = try await get("/search?q=\(q)&limit=\(limit)")
        return response.results
    }

    // MARK: - No-content plumbing

    /// DELETE-style call where success is 2xx with an empty body (204).
    private func sendExpectingNoContent(_ method: String, _ path: String) async throws {
        guard let base = AppConfig.serverURL, let token = AppConfig.token else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/v1" + path) else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if (200...299).contains(http.statusCode) { return }
        // Reuse the shared error mapping (401 broadcast, envelope decode).
        _ = try Self.decode(EmptyDecodable.self, data: data, response: response)
    }
}

/// Placeholder for the error path of no-content calls (never decoded on 2xx).
private struct EmptyDecodable: Decodable {}
