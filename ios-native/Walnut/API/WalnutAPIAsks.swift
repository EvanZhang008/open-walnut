import Foundation

/// `GET /api/v1/asks` (additive, 2026-09): one agent's asks, as the Mac's drawer
/// lists them. See `AskList` for why the phone renders the order it is given.
extension WalnutAPI {
    /// The list, or nil when the endpoint is not available on this server yet:
    /// an older cloud companion answers an unknown route with a plain 404 (not the
    /// v1 error shape), and a new companion in front of an older Mac answers
    /// `400 session_control_needs_upgrade`. nil means "keep showing what you had";
    /// any other error (an unknown agent's `not_found`, `bridge_offline` while the
    /// Mac is unreachable) throws.
    func asks(agentID: String = "general", query: String? = nil, limit: Int? = nil) async throws -> AskList? {
        do {
            return try await get(Self.asksPath(agentID: agentID, query: query, limit: limit))
        } catch let error as APIError where Self.isMissingEndpoint(error) {
            return nil
        }
    }

    /// The request path. `q` is encoded as a query VALUE (a title search can hold
    /// `&`, `+`, `=` or any script), which the path escaper would pass through.
    static func asksPath(agentID: String, query: String?, limit: Int?) -> String {
        var parts = ["agentId=\(queryValue(agentID))"]
        if let query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("q=\(queryValue(query))")
        }
        if let limit { parts.append("limit=\(limit)") }
        return "/asks?" + parts.joined(separator: "&")
    }

    /// The endpoint is not available here yet: a 404 whose body is not the v1
    /// error envelope (the route does not exist on this server), or the replica's
    /// `session_control_needs_upgrade` (the Mac behind it predates the relayed
    /// action). A v1 `not_found` (an agent the server does not offer) is a real
    /// answer and is not this.
    static func isMissingEndpoint(_ error: APIError) -> Bool {
        if case .server(let status, let code, _, _, _) = error {
            return (status == 404 && code == "http_error")
                || (status == 400 && code == "session_control_needs_upgrade")
        }
        return false
    }

    /// A query parameter value with `&`, `+`, `=`, `?` and `#` encoded, so they stay part of it.
    static func queryValue(_ raw: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?#")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }
}
