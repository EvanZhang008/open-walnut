import Foundation

extension WalnutAPI {
    /// `GET /api/v1/routes` (Bearer): every origin at which THIS token is valid.
    /// A server older than the endpoint answers 404 (`APIError.server`). The
    /// Mac also says whether it has Tailscale (`tailscale`, optional).
    func routes() async throws -> ServerRoutesResponse {
        try await get("/routes")
    }

    /// `POST /api/v1/connect/register` (Bearer): this phone's Walnut Connect network id, which
    /// the Mac's walnut-net then lets in. Answered by the Mac only (404 on a replica).
    func registerConnect(endpoint: String) async throws {
        struct Body: Encodable { let endpoint: String }
        struct Answer: Decodable { let registered: Bool? }
        let _: Answer = try await send("POST", "/connect/register", body: Body(endpoint: endpoint), retrySafe: true)
    }
}

/// Identity before credential: asks `<origin>/api/v1/instance` who is there,
/// WITHOUT the device token. A stranger's box that happens to sit at the same
/// LAN address must never be handed the token, so a route is only used once the
/// box at it has named itself as the paired Walnut.
///
/// Deliberately not WalnutAPI: that client adds the Authorization header, logs
/// every miss as an error (the upload trigger) and turns a 401 into the app-wide
/// unauthorized notification. A probe miss is routine and none of those.
enum InstanceProbe {
    static let timeout: TimeInterval = 2.5
    /// A Walnut Connect route dials the Mac on its first request (through a relay, about a
    /// second; a new connection after the app was in the background, a little more).
    static let connectTimeout: TimeInterval = 8

    private struct Body: Decodable {
        let instance: String?
        let mode: String?
    }

    /// Never follows a redirect (a captive portal answering for the LAN address
    /// is not our server), never stores cookies or cached answers.
    static let session: URLSession = makeSession(timeout: timeout)
    static let connectSession: URLSession = makeSession(timeout: connectTimeout)

    private static func makeSession(timeout: TimeInterval) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: DemoMode.configured(config.keepingNoHTTPCache()), delegate: RefuseRedirects(), delegateQueue: nil)
    }

    /// The probe request. Pure and internal for WalnutTests: it must carry no
    /// Authorization header.
    static func request(origin: String, timeout: TimeInterval = timeout) -> URLRequest? {
        guard let url = URL(string: AppConfig.normalize(origin) + "/api/v1/instance") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.markTestRun()
        return request
    }

    /// Pure mapping from an HTTP answer to an outcome. Internal for WalnutTests.
    static func outcome(status: Int, data: Data, latencyMs: Int) -> ProbeOutcome {
        switch status {
        case 200:
            guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return .unreachable }
            let instance = (body.instance?.isEmpty ?? true) ? nil : body.instance
            return .ok(instance: instance, latencyMs: latencyMs)
        case 404:
            // A Walnut older than the endpoint (it would not have a route list
            // either). Reachable, identity unknown: it only ever qualifies for
            // a route that names no instance, i.e. the origin the user typed.
            return .ok(instance: nil, latencyMs: latencyMs)
        case 401, 403:
            return .rejected401
        default:
            return .unreachable
        }
    }

    static func probe(_ route: ServerRoute) async -> ProbeOutcome {
        // Walnut Connect: this phone's port answers only while the connector runs.
        var session = session
        var wait = timeout
        if route.kind == .connect {
            guard let peer = route.connect, await WalnutConnect.shared.ensureRunning(peer) != nil else { return .unreachable }
            session = connectSession
            wait = connectTimeout
        }
        guard let request = request(origin: route.origin, timeout: wait) else { return .unreachable }
        let started = Date()
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            return outcome(status: status, data: data, latencyMs: Int(Date().timeIntervalSince(started) * 1_000))
        } catch {
            return .unreachable
        }
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
