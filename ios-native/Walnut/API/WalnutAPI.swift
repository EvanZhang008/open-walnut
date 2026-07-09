import Foundation

/// REST client for the frozen /api/v1 contract (docs/api-v1.md).
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

    func conversations(limit: Int = 50) async throws -> [ConversationSummary] {
        try await get("/conversations?limit=\(limit)")
    }

    func createConversation(title: String? = nil) async throws -> String {
        struct Created: Codable { let id: String }
        let body: [String: String] = title.map { ["title": $0] } ?? [:]
        let created: Created = try await send("POST", "/conversations", body: body)
        return created.id
    }

    func messages(conversationID: String, limit: Int = 50, before: String? = nil) async throws -> [ChatMessage] {
        var path = "/conversations/\(escape(conversationID))/messages?limit=\(limit)"
        if let before {
            path += "&before=\(escape(before))"
        }
        return try await get(path)
    }

    /// POST a message; returns the turnId from the 202 response.
    /// Throws APIError.server(code: "turn_active") when a turn is already running.
    func sendMessage(conversationID: String, text: String) async throws -> String {
        struct Accepted: Codable { let turnId: String }
        let accepted: Accepted = try await send(
            "POST", "/conversations/\(escape(conversationID))/messages", body: ["text": text]
        )
        return accepted.turnId
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

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: nil as [String: String]?)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        try await sendAbsolute(method, "/api/v1" + path, body: body)
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
        do {
            return try await session.data(for: request)
        } catch {
            throw APIError.network(underlying: error)
        }
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
