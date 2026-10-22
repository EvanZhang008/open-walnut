import Foundation

protocol InboxItemTransport {
    func prepareInboxItem(letterId: String, itemId: String, request: InboxItemPrepareRequest) async throws -> InboxItemPrepareResponse
    func executeInboxItem(letterId: String, itemId: String, request: InboxItemExecuteRequest) async throws -> InboxItemExecutionResponse
    func inboxItemExecution(letterId: String, itemId: String) async throws -> InboxItemExecutionResponse
    func inboxItemTasks(letterId: String, itemId: String, query: String, offset: Int) async throws -> InboxTaskPage
    func inboxItemTask(letterId: String, itemId: String, taskId: String) async throws -> InboxTaskPreview
}
extension WalnutAPI: InboxItemTransport {
    func inboxItemRequest<T: Decodable, B: Encodable>(_ method: String, _ path: String,
        body: B?, timeout: TimeInterval, session suppliedSession: URLSession? = nil) async throws -> T {
        guard let base = AppConfig.serverURL, let token = AppConfig.token,
              let url = URL(string: base.absoluteString + "/api/v1" + path) else { throw APIError.notConfigured }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // A simulator happens to share the Mac's loopback. It is still a phone, not its console.
        request.setValue("remote-http", forHTTPHeaderField: "x-walnut-origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let config = URLSessionConfiguration.ephemeral; config.waitsForConnectivity = false
        let session = suppliedSession ?? URLSession(configuration: DemoMode.configured(config))
        defer { if suppliedSession == nil { session.invalidateAndCancel() } }
        let (data, response) = try await session.data(for: request)
        return try Self.decode(T.self, data: data, response: response)
    }
    private func inboxItemEscape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? component
    }
    private func inboxItemRoot(_ letter: String, _ item: String) -> String {
        "/human-inbox/\(inboxItemEscape(letter))/items/\(inboxItemEscape(item))"
    }
    func prepareInboxItem(letterId: String, itemId: String, request: InboxItemPrepareRequest) async throws -> InboxItemPrepareResponse {
        try await inboxItemRequest("POST", inboxItemRoot(letterId, itemId) + "/prepare", body: request, timeout: 15)
    }
    func executeInboxItem(letterId: String, itemId: String, request: InboxItemExecuteRequest) async throws -> InboxItemExecutionResponse {
        // Never opt into transient replay: unknown outcomes are recovered by GET only.
        try await inboxItemRequest("POST", inboxItemRoot(letterId, itemId) + "/execute", body: request, timeout: 15)
    }
    func inboxItemExecution(letterId: String, itemId: String) async throws -> InboxItemExecutionResponse {
        try await inboxItemRequest("GET", inboxItemRoot(letterId, itemId) + "/execution", body: nil as [String: String]?, timeout: 10)
    }
    func inboxItemTasks(letterId: String, itemId: String, query: String, offset: Int) async throws -> InboxTaskPage {
        try await inboxItemRequest("GET", inboxItemRoot(letterId, itemId) + "/tasks?query=\(inboxItemEscape(query))&offset=\(offset)&limit=25",
                       body: nil as [String: String]?, timeout: 10)
    }
    func inboxItemTask(letterId: String, itemId: String, taskId: String) async throws -> InboxTaskPreview {
        try await inboxItemRequest("GET", inboxItemRoot(letterId, itemId) + "/tasks/\(inboxItemEscape(taskId))", body: nil as [String: String]?, timeout: 10)
    }
}
