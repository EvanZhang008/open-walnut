import Foundation

/// REST client for the frozen /api/v1 contract (docs/reference/api-v1.md).
/// Every request carries `Authorization: Bearer <token>`.
struct WalnutAPI {
    /// Posted when any request gets a 401 — the app returns to setup.
    static let unauthorizedNotification = Notification.Name("WalnutAPI.unauthorized")

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: - Endpoints

    func status() async throws -> ServerStatus {
        try await get("/status")
    }

    /// Setup-flow probe against an explicit URL + token, before anything is saved.
    func testStatus(serverURL: String, token: String?) async throws -> ServerStatus {
        guard let base = URL(string: AppConfig.normalize(serverURL)) else { throw APIError.notConfigured }
        var request = URLRequest(url: base.appendingPathComponent("api/v1/status"))
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await perform(request)
        return try Self.decode(ServerStatus.self, data: data, response: response)
    }

    /// Report this device's model/OS/app version so the console can label it.
    /// Fire-and-forget at the call site — the server identifies the device from
    /// the Bearer token, so no identifiers are sent in the body beyond identity.
    func reportDeviceInfo(model: String, os: String, deviceName: String, appVersion: String) async throws {
        struct Report: Encodable {
            let model: String
            let os: String
            let deviceName: String
            let appVersion: String
        }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await send(
            "POST", "/devices/self",
            body: Report(model: model, os: os, deviceName: deviceName, appVersion: appVersion)
        )
    }

    /// Console agents available for chat (additive endpoint).
    func agents() async throws -> [AgentSummary] {
        try await get("/agents")
    }

    func conversations(agentID: String = "general", limit: Int = 50) async throws -> [ConversationSummary] {
        try await get("/conversations?limit=\(limit)&agentId=\(escape(agentID))")
    }

    func createConversation(agentID: String = "general", title: String? = nil) async throws -> String {
        struct Created: Codable { let id: String }
        var body: [String: String] = ["agentId": agentID]
        if let title { body["title"] = title }
        let created: Created = try await send("POST", "/conversations", body: body)
        return created.id
    }

    func messages(conversationID: String, agentID: String = "general", limit: Int = 50, before: String? = nil) async throws -> [ChatMessage] {
        var path = "/conversations/\(escape(conversationID))/messages?limit=\(limit)&agentId=\(escape(agentID))"
        if let before {
            path += "&before=\(escape(before))"
        }
        return try await get(path)
    }

    /// POST a message; returns the turnId from the 202 response. `images` is an
    /// additive field (≤5 base64 JPEG/PNG) — omitted when empty so older servers
    /// and image-free sends behave exactly as before.
    /// Throws APIError.server(code: "turn_active") when a turn is already running.
    func sendMessage(conversationID: String, agentID: String = "general", text: String, images: [ImagePayload] = []) async throws -> String {
        struct Body: Encodable { let text: String; let agentId: String; let images: [ImagePayload]? }
        struct Accepted: Codable { let turnId: String }
        let accepted: Accepted = try await send(
            "POST", "/conversations/\(escape(conversationID))/messages",
            body: Body(text: text, agentId: agentID, images: images.isEmpty ? nil : images),
            timeout: images.isEmpty ? nil : 180
        )
        return accepted.turnId
    }

    /// Read-only task projection. Fetches ALL tasks (no status query) so the
    /// smart-list filters can slice client-side. Throws APIError.server with
    /// code "unavailable" (503) when the companion hasn't synced yet.
    func tasks() async throws -> TasksResponse {
        try await get("/tasks")
    }

    /// Read-only session projection — same semantics as tasks() (503 =
    /// projection not synced yet on a fresh companion).
    func sessions() async throws -> SessionsResponse {
        try await get("/sessions")
    }

    /// Create a task (additive endpoint). Same semantics as the web quick-add:
    /// nil/empty project = the server default (Inbox); a new project name is
    /// auto-created. Throws APIError.server code "not_supported_cloud" (503)
    /// on a REPLICA — task writes run on the primary box only.
    func createTask(
        title: String, project: String? = nil, priority: String? = nil,
        dueDate: String? = nil, description: String? = nil
    ) async throws -> WalnutTask {
        struct Body: Encodable {
            let title: String
            let project: String?
            let priority: String?
            let due_date: String?
            let description: String?
        }
        let created: TaskCreated = try await send(
            "POST", "/tasks",
            body: Body(
                title: title,
                project: (project?.isEmpty ?? true) ? nil : project,
                priority: priority,
                due_date: dueDate,
                description: (description?.isEmpty ?? true) ? nil : description
            )
        )
        return created.task
    }

    /// PATCH /api/v1/tasks/:id — update task fields (additive endpoint, works
    /// on BOTH server modes: a REPLICA applies locally and outbox-syncs back).
    /// Only non-nil fields ride the wire; `dueDate` "" = explicit clear.
    /// Answers the updated task in the same slim shape GET /tasks serves.
    func updateTask(
        id: String, status: String? = nil, priority: String? = nil,
        dueDate: String? = nil, project: String? = nil, title: String? = nil,
        description: String? = nil
    ) async throws -> WalnutTask {
        struct Body: Encodable {
            let status: String?
            let priority: String?
            let due_date: String?
            let project: String?
            let title: String?
            let description: String?
        }
        let updated: TaskCreated = try await send(
            "PATCH", "/tasks/\(escape(id))",
            body: Body(
                status: status, priority: priority, due_date: dueDate,
                project: project, title: title, description: description
            )
        )
        return updated.task
    }

    // MARK: - Session control (model / effort / fork — additive, 2026-08)

    /// Picker data for the model sheet: selectable models + current model/effort.
    func sessionModelOptions(id: String) async throws -> SessionModelOptions {
        try await get("/sessions/\(escape(id))/model-options")
    }

    /// Switch the session's model. `appliedLive` false = persisted only (the
    /// next --resume spawn picks it up). Long timeout: a live CLI apply waits
    /// out a control_request round trip (~15s server-side), and the cloud
    /// relay adds a bridge hop on top.
    func setSessionModel(id: String, model: String) async throws -> SessionModelChange {
        try await send("POST", "/sessions/\(escape(id))/model", body: ["model": model], timeout: 45)
    }

    /// Switch the session's reasoning effort. Unsupported level → 409 conflict.
    func setSessionEffort(id: String, effort: String) async throws -> SessionEffortChange {
        try await send("POST", "/sessions/\(escape(id))/effort", body: ["effort": effort], timeout: 45)
    }

    /// Fork the session into a sibling child task (+ optional first message).
    /// 201 = accepted, not spawned — the returned sessionId already resolves
    /// on the transcript/stream endpoints, same contract as POST /sessions.
    func forkSession(id: String, message: String?) async throws -> SessionForked {
        struct Body: Encodable {
            let create_child_task: Bool
            let message: String?
        }
        return try await send(
            "POST", "/sessions/\(escape(id))/fork",
            body: Body(
                create_child_task: true,
                message: (message?.isEmpty ?? true) ? nil : message
            ),
            timeout: 45
        )
    }

    /// Hosts + frequent working dirs for the New Session sheet. Throws
    /// APIError.server with code "not_supported_cloud" (503) on a REPLICA —
    /// creation is a primary-box capability.
    func sessionLaunchOptions() async throws -> SessionLaunchOptions {
        try await get("/sessions/launch-options")
    }

    /// Create a Claude Code session on the chosen host + path. `host` "" or
    /// nil = the primary box (Mac). `taskId` links the session to an existing
    /// task instead of creating a new one. Empty `message` = spawn idle.
    /// `mode` = permission mode (bypass/accept/default/plan); nil = server
    /// default (bypass — same as the web launcher).
    func createSession(
        cwd: String, host: String? = nil, message: String = "",
        taskId: String? = nil, mode: String? = nil
    ) async throws -> SessionCreated {
        struct Body: Encodable {
            let cwd: String
            let host: String?
            let message: String
            let taskId: String?
            let mode: String?
        }
        return try await send(
            "POST", "/sessions",
            body: Body(
                cwd: cwd,
                host: (host?.isEmpty ?? true) ? nil : host,
                message: message,
                taskId: taskId,
                mode: mode
            ),
            timeout: 60
        )
    }

    /// Transcript tail for one session (404 = no tail exported yet).
    /// `fresh: true` asks the primary to read the session's history right now
    /// (live view polling) instead of the 60s-throttled sweep file.
    func sessionTranscript(id: String, fresh: Bool = false) async throws -> SessionTranscript {
        try await get("/sessions/\(escape(id))/transcript\(fresh ? "?fresh=1" : "")")
    }

    /// Send text INTO a live session; returns the queued messageId (202).
    /// Distinct error codes callers act on: 404 not_found, 503 bridge_offline
    /// (no live bridge to the session's host), 409 session_dead (CLI gone),
    /// 400 images_not_supported_cloud (attached images can't reach a CLI that
    /// runs on another machine — only the Mac-online path accepts them).
    /// `images` is additive (≤5 base64 JPEG/PNG), omitted when empty.
    func sendSessionMessage(id: String, text: String, images: [ImagePayload] = []) async throws -> String {
        struct Body: Encodable { let text: String; let images: [ImagePayload]? }
        struct Accepted: Codable { let messageId: String }
        let accepted: Accepted = try await send(
            "POST", "/sessions/\(escape(id))/messages",
            body: Body(text: text, images: images.isEmpty ? nil : images),
            timeout: images.isEmpty ? nil : 180
        )
        return accepted.messageId
    }

    /// Voice input: upload recorded audio, get the recognized text back.
    /// The server picks the engine (local whisper on the primary box, bridge
    /// relay to it from the cloud, or OpenAI fallback). Long timeout — a cold
    /// whisper model load plus a 60s clip can take a while.
    func transcribe(audio: Data, format: String, language: String? = nil) async throws -> String {
        struct Result: Codable { let text: String }
        // Base64 of up to 90s of audio off the MainActor (same rule as image
        // payloads): the caller is a @MainActor recorder, so encoding inline
        // blocked the UI for the whole encode of a multi-MB buffer.
        let encoded = await Task.detached(priority: .userInitiated) {
            audio.base64EncodedString()
        }.value
        var body: [String: String] = ["audio": encoded, "format": format]
        if let language { body["language"] = language }
        let result: Result = try await sendAbsolute(
            "POST", "/api/v1/stt/transcribe", body: body, timeout: 120
        )
        return result.text
    }

    /// Authenticated SSE URL for the live task+session events feed (nil if unpaired).
    static func eventsFeedURL() -> URL? {
        guard let base = AppConfig.serverURL else { return nil }
        return URL(string: "\(base.absoluteString)/api/v1/events")
    }

    /// Authenticated SSE URL for a session's live turn stream (nil if unpaired).
    static func sessionStreamURL(id: String) -> URL? {
        guard let base = AppConfig.serverURL else { return nil }
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return URL(string: "\(base.absoluteString)/api/v1/sessions/\(escaped)/stream")
    }

    func notesTree() async throws -> [NoteTreeNode] {
        struct Tree: Codable { let tree: [NoteTreeNode] }
        let wrapper: Tree = try await get("/notes")
        return wrapper.tree
    }

    func noteContent(path: String) async throws -> NoteContent {
        try await get("/notes/content/\(escapePath(path))")
    }

    func saveNote(path: String, content: String, expectedHash: String?) async throws -> NoteWriteResult {
        var body: [String: String] = ["content": content]
        if let expectedHash { body["expectedHash"] = expectedHash }
        return try await send("PUT", "/notes/content/\(escapePath(path))", body: body)
    }

    func createNote(path: String, content: String? = nil) async throws -> NoteWriteResult {
        var body: [String: String] = ["path": path]
        if let content { body["content"] = content }
        return try await send("POST", "/notes", body: body)
    }

    func deleteNote(path: String) async throws {
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send("DELETE", "/notes/\(escapePath(path))", body: nil as [String: String]?)
    }

    // MARK: - Notes search + favorites (non-v1 endpoints, same Bearer auth)

    /// Hybrid string+semantic search. The semantic leg can stall on a cold
    /// server, so callers pass a short timeout and fall back to string mode.
    func searchNotes(query: String, limit: Int = 30, mode: String = "hybrid", timeout: TimeInterval? = nil) async throws -> NoteSearchResponse {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await sendAbsolute(
            "GET", "/api/notes-v2/search?q=\(q)&limit=\(limit)&mode=\(mode)",
            body: nil as [String: String]?, timeout: timeout
        )
    }

    func favoriteNotes() async throws -> [String] {
        let response: FavoritesResponse = try await sendAbsolute("GET", "/api/favorites", body: nil as [String: String]?)
        return response.notes
    }

    /// Returns the updated pinned list.
    func addFavoriteNote(path: String) async throws -> [String] {
        let response: FavoritesResponse = try await sendAbsolute("POST", "/api/favorites/notes", body: ["path": path])
        return response.notes
    }

    /// Returns the updated pinned list.
    func removeFavoriteNote(path: String) async throws -> [String] {
        let response: FavoritesResponse = try await sendAbsolute("DELETE", "/api/favorites/notes", body: ["path": path])
        return response.notes
    }

    /// Uploads pasted/picked image bytes into the vault's `_attachment/`
    /// folder. Unlike every other endpoint here, errors come back as a FLAT
    /// `{error: string}` — not the v1 envelope — so this bypasses `decode()`.
    func uploadAttachment(notePath: String, data: Data, mediaType: String) async throws -> AttachmentUploadResult {
        guard let base = AppConfig.serverURL, let token = AppConfig.token else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/notes-v2/attachment") else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Base64 + JSON encode off the MainActor — callers are editor views.
        request.httpBody = try await Task.detached(priority: .userInitiated) {
            let body = AttachmentUploadBody(
                notePath: notePath, data: data.base64EncodedString(), mediaType: mediaType
            )
            return try JSONEncoder().encode(body)
        }.value

        let (responseData, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        switch http.statusCode {
        case 200...299:
            guard let result = try? JSONDecoder().decode(AttachmentUploadResult.self, from: responseData) else {
                throw APIError.badResponse
            }
            return result
        case 401:
            NotificationCenter.default.post(name: Self.unauthorizedNotification, object: nil)
            throw APIError.unauthorized
        case 429:
            throw APIError.rateLimited
        default:
            let message = (try? JSONDecoder().decode(FlatErrorEnvelope.self, from: responseData))?.error
                ?? "Upload failed (\(http.statusCode))"
            throw APIError.server(status: http.statusCode, code: "upload_error", message: message, serverHash: nil, serverContent: nil)
        }
    }

    /// Authenticated URL for a note attachment. `raw` is the inner text of an
    /// Obsidian `![[...]]` embed or a relative markdown image path — the server
    /// resolves either. Callers must attach the Bearer header themselves.
    static func attachmentURL(rawPath: String) -> URL? {
        guard let base = AppConfig.serverURL else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = "/api/notes-v2/attachment"
        components?.queryItems = [URLQueryItem(name: "path", value: rawPath)]
        return components?.url
    }

    /// Authenticated URL for an absolute-path image (chat/session pictures,
    /// screenshots the agent saved). GET /api/v1/media serves it from local
    /// disk, the session's exec host (daemon), or over the cloud bridge.
    /// Callers must attach the Bearer header themselves.
    static func mediaURL(absolutePath: String, sessionID: String? = nil) -> URL? {
        guard let base = AppConfig.serverURL else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = "/api/v1/media"
        var items = [URLQueryItem(name: "path", value: absolutePath)]
        if let sessionID, !sessionID.isEmpty {
            items.append(URLQueryItem(name: "session", value: sessionID))
        }
        components?.queryItems = items
        return components?.url
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: nil as [String: String]?)
    }

    private func send<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, body: B?, timeout: TimeInterval? = nil
    ) async throws -> T {
        try await sendAbsolute(method, "/api/v1" + path, body: body, timeout: timeout)
    }

    private func sendAbsolute<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, body: B?, timeout: TimeInterval? = nil
    ) async throws -> T {
        guard let base = AppConfig.serverURL, let token = AppConfig.token else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + path) else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await perform(request)
        return try Self.decode(T.self, data: data, response: response)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let started = Date()
        do {
            let result = try await session.data(for: request)
            // Single funnel for HTTP outcomes — every endpoint in this client
            // goes through here, so no per-call-site instrumentation is needed.
            // AppLog's own uploader uses URLSession.shared directly, so this
            // cannot recurse into log traffic about log traffic.
            Self.logOutcome(
                status: (result.1 as? HTTPURLResponse)?.statusCode ?? -1,
                path: Self.sanitizedPath(request.url),
                method: request.httpMethod ?? "GET",
                latencyMs: Int(Date().timeIntervalSince(started) * 1_000)
            )
            return result
        } catch {
            let nsError = error as NSError
            // Classify BEFORE logging: view-lifecycle cancellations are normal
            // behavior — error-logging them pollutes the connectivity dump and
            // (via AppLog's error-debounce) schedules pointless uploads.
            if error is CancellationError
                || (error as? URLError)?.code == .cancelled
                || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) {
                throw APIError.cancelled
            }
            let latency = Int(Date().timeIntervalSince(started) * 1_000)
            AppLog.error("network", "request failed", [
                "path": Self.sanitizedPath(request.url),
                "method": request.httpMethod ?? "GET",
                "errorDomain": nsError.domain,
                "errorCode": String(nsError.code),
                "latencyMs": String(latency),
            ])
            throw APIError.network(underlying: error)
        }
    }

    /// HTTP-level outcome of every request, logged from `decode` (the single
    /// point every response funnels through). Transport failures are covered by
    /// `perform` above; this covers the other half — a 4xx/5xx the app quietly
    /// turned into an error state was previously invisible in a field log, so
    /// "it just showed an error" was unanswerable.
    ///
    /// Success is `debug` (full-dump keeps it: latency-by-endpoint over a day is
    /// how a slow server shows up), failure is `error` so it also triggers the
    /// upload debounce.
    private static func logOutcome(status: Int, path: String, method: String, latencyMs: Int) {
        let meta = [
            "path": path, "method": method,
            "status": String(status), "latencyMs": String(latencyMs),
        ]
        if (200...299).contains(status) {
            AppLog.debug("network", "request ok", meta)
        } else {
            AppLog.error("network", "request rejected", meta)
        }
    }

    /// Keep only a coarse endpoint template; note paths and record ids never
    /// enter client diagnostics uploaded to the server.
    private static func sanitizedPath(_ url: URL?) -> String {
        guard let url else { return "/" }
        let segments = url.path.split(separator: "/")
        return "/" + segments.prefix(2).joined(separator: "/")
    }

    static func decode<T: Decodable>(_ type: T.Type, data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        switch http.statusCode {
        case 200...299:
            do {
                return try JSONDecoder().decode(type, from: data)
            } catch {
                throw APIError.badResponse
            }
        case 401:
            NotificationCenter.default.post(name: unauthorizedNotification, object: nil)
            throw APIError.unauthorized
        case 429:
            throw APIError.rateLimited
        default:
            if let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data) {
                throw APIError.server(
                    status: http.statusCode,
                    code: envelope.error.code,
                    message: envelope.error.message,
                    serverHash: envelope.serverHash,
                    serverContent: envelope.serverContent
                )
            }
            // Non-JSON error body (proxy 502 page etc.)
            throw APIError.server(
                status: http.statusCode,
                code: "http_error",
                message: "Server returned \(http.statusCode)",
                serverHash: nil,
                serverContent: nil
            )
        }
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    /// Note paths contain slashes as separators — encode each segment only.
    private func escapePath(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true)
            .map { escape(String($0)) }
            .joined(separator: "/")
    }
}
