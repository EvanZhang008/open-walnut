import Foundation

// MARK: - Wave 2 endpoints (additive /api/v1, docs/reference/api-v1.md)
//
// Routines management, provider-neutral session controls, queue management,
// plan/side-question reads, NL quick-parse, config projection, chat stats,
// and session file browsing. All ride WalnutAPI's shared request/decode
// funnel so auth, logging, and the frozen error envelope apply uniformly.

extension WalnutAPI {
    // MARK: - Routines

    /// All routines. includeDisabled defaults true — the management page shows
    /// disabled rows with their toggle off (that's the point of the page).
    func routines(includeDisabled: Bool = true) async throws -> [RoutineJob] {
        let response: RoutinesResponse = try await get(
            "/routines\(includeDisabled ? "?includeDisabled=true" : "")"
        )
        return response.jobs
    }

    /// Flip enabled. Returns the updated job (adopt it — server truth).
    func toggleRoutine(id: String) async throws -> RoutineJob {
        let envelope: RoutineEnvelope = try await send(
            "POST", "/routines/\(escape(id))/toggle", body: nil as [String: String]?
        )
        return envelope.job
    }

    /// Run now (forced). Long timeout: a run can spawn a session / agent turn;
    /// the server replies when the trigger is accepted, but a cloud relay adds
    /// a bridge hop.
    func runRoutineNow(id: String) async throws {
        struct AnyResult: Codable {}
        let _: AnyResult = try await send(
            "POST", "/routines/\(escape(id))/run", body: nil as [String: String]?, timeout: 60
        )
    }

    /// Delete a routine — 204; 404 not_found for an unknown id.
    func deleteRoutine(id: String) async throws {
        try await sendNoContent("DELETE", "/routines/\(escape(id))")
    }

    // MARK: - Session controls (provider-neutral) + queue

    /// Selectable controls for the session (mode select for Claude sessions;
    /// the native control set for Codex/ACP sessions).
    func sessionControls(id: String) async throws -> SessionControlsPayload {
        try await get("/sessions/\(escape(id))/controls")
    }

    /// Apply one control value; returns the refreshed control set. A live CLI
    /// rejecting the switch → 409 conflict. Long timeout: live applies wait
    /// out a control_request round trip (+ bridge hop on cloud).
    func applySessionControl(id: String, controlId: String, value: String) async throws -> SessionControlsPayload {
        try await send(
            "POST", "/sessions/\(escape(id))/controls",
            body: ["id": controlId, "value": value],
            timeout: 45
        )
    }

    /// Queued (undelivered) messages for a session.
    func sessionQueue(id: String) async throws -> [SessionQueuedMessage] {
        let response: SessionQueueResponse = try await get("/sessions/\(escape(id))/queue")
        return response.messages
    }

    /// Delete a still-pending queued message (409 = already processing/gone).
    func deleteQueuedMessage(sessionId: String, messageId: String) async throws {
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send(
            "DELETE", "/sessions/\(escape(sessionId))/queue/\(escape(messageId))",
            body: nil as [String: String]?
        )
    }

    /// Edit a still-pending queued message's text (409 = already processing/gone).
    func editQueuedMessage(sessionId: String, messageId: String, text: String) async throws {
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send(
            "PATCH", "/sessions/\(escape(sessionId))/queue/\(escape(messageId))",
            body: ["text": text]
        )
    }

    // MARK: - Plan + side questions

    /// Plan content for a plan session (404 not_found when no plan exists).
    func sessionPlan(id: String) async throws -> SessionPlanPayload {
        try await get("/sessions/\(escape(id))/plan")
    }

    /// Side-question Q&A history.
    func sessionSideQuestions(id: String) async throws -> [SideQuestion] {
        let response: SideQuestionsResponse = try await get("/sessions/\(escape(id))/side-questions")
        return response.sideQuestions
    }

    /// Ask the live CLI a side question WITHOUT touching its main conversation.
    /// SYNCHRONOUS — the response carries the answer and can take tens of
    /// seconds, hence the long timeout. Dead/unreachable CLI → 502.
    func askSideQuestion(sessionId: String, question: String) async throws -> SideQuestion {
        let envelope: SideQuestionEnvelope = try await send(
            "POST", "/sessions/\(escape(sessionId))/side-question",
            body: ["question": question],
            timeout: 120
        )
        return envelope.sideQuestion
    }

    // MARK: - NL quick-parse

    /// Parse a natural-language task note ("remind me to file the report at
    /// 9am tomorrow") into structured task metadata. Stateless; works on both
    /// server modes. Relative dates resolve against the submitted timezone.
    func quickParseTask(text: String, timeZone: String = TimeZone.current.identifier) async throws -> QuickParsedTask {
        try await send(
            "POST", "/tasks/quick-parse",
            body: ["text": text, "timeZone": timeZone],
            timeout: 30
        )
    }

    // MARK: - Console reads

    /// Read-only whitelist config projection + box diagnostics.
    func serverConfig() async throws -> ServerConfigInfo {
        try await get("/config")
    }

    /// Personal AI conversation size stats (no conversationId = the active one).
    func chatStats(agentID: String = "general") async throws -> ChatStats {
        try await get("/chat/stats?agentId=\(escape(agentID))")
    }

    /// Which engine answers a chat conversation + (lane engine) its session id,
    /// so the main-agent composer can show and switch the model. Read-only: it
    /// never mints a lane session. No conversationID = the active conversation.
    func chatEngine(agentID: String = "general", conversationID: String? = nil) async throws -> ChatEngineInfo {
        var query = "agentId=\(escape(agentID))"
        if let conversationID, !conversationID.isEmpty {
            query += "&conversationId=\(escape(conversationID))"
        }
        return try await get("/chat/engine?\(query)")
    }

    /// Mint this conversation's lane session if it has none yet, and return it.
    ///
    /// The pair to `chatEngine`: the GET stays read-only (a poll must never spawn
    /// a CLI), and this is the explicit ask. Without it the model pill was
    /// permanently read-only on any conversation that had not been sent to —
    /// "Send a message first" where the desktop offers a picker, because the web
    /// console mints eagerly on mount and the phone had no way to.
    ///
    /// Throws `APIError` 409 when the box is not on the lane engine.
    func chatEngineSession(agentID: String = "general", conversationID: String? = nil) async throws -> ChatEngineInfo {
        var query = "agentId=\(escape(agentID))"
        if let conversationID, !conversationID.isEmpty {
            query += "&conversationId=\(escape(conversationID))"
        }
        // `getOrCreateLaneSession` is idempotent — a second call returns the same
        // session — so a transient retry cannot mint two CLIs.
        return try await send("POST", "/chat/engine/session?\(query)",
                             body: [String: String](), retrySafe: true)
    }

    /// One directory level for the session path picker. `host` "" / nil = the
    /// primary box. `prefix` may be partial (the server lists its parent and
    /// reports the resolved `parent` back) and may start with `~`.
    func listDirs(prefix: String, host: String? = nil) async throws -> DirListing {
        var query = "prefix=\(escapeQuery(prefix))"
        if let host, !host.isEmpty { query += "&host=\(escapeQuery(host))" }
        return try await get("/sessions/list-dirs?\(query)")
    }

    // MARK: - Session file browsing

    /// One directory level of a session-host file tree. `host` "" / nil = the
    /// primary box. Cloud REPLICA relays metadata over the bridge.
    func listFiles(path: String, host: String? = nil) async throws -> SessionFileListResponse {
        var query = "path=\(escapeQuery(path))"
        if let host, !host.isEmpty { query += "&host=\(escapeQuery(host))" }
        return try await get("/files/list?\(query)")
    }

    /// Text file payload for the viewer. A missing file is a 200 with `error`
    /// set. On a cloud REPLICA a `host=` read answers 501 not_supported_cloud
    /// (file content never rides the bridge).
    func fileContent(path: String, host: String? = nil) async throws -> SessionFileContent {
        var query = "path=\(escapeQuery(path))"
        if let host, !host.isEmpty { query += "&host=\(escapeQuery(host))" }
        return try await get("/file-content?\(query)")
    }

    // MARK: - Plumbing

    private func escapeQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~/"))) ?? value
    }

    /// DELETE-style call where success is 2xx with an empty body (204).
    /// (Twin of Wave 1's private sendExpectingNoContent — extensions can't
    /// share private members across files.)
    private func sendNoContent(_ method: String, _ path: String) async throws {
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
        struct Empty: Decodable {}
        _ = try Self.decode(Empty.self, data: data, response: response)
    }
}
