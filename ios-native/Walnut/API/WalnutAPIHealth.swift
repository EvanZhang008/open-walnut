import Foundation

// Apple Health: the phone's half of `/api/v1/health/*` (docs/reference/api-v1.md,
// "Apple Health"). Every call carries the device token, as every other v1 call
// does; the server answers health only to this Mac and a paired phone.

/// `GET /api/v1/health/status`. Every field optional: the phone must keep
/// working against a server that adds fields or predates one.
struct HealthStatusResponse: Decodable, Sendable {
    struct Coverage: Decodable, Sendable {
        let from: String?
        let to: String?
    }

    /// Present only on a server that understands `q.` / `c.` / `x.` names.
    /// Decoded leniently: its mere presence is what matters.
    struct Generic: Decodable, Sendable {
        let prefixes: [String]?
        let covered: [String]?

        private enum CodingKeys: String, CodingKey { case prefixes, covered }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            prefixes = try? container?.decodeIfPresent([String].self, forKey: .prefixes)
            covered = try? container?.decodeIfPresent([String].self, forKey: .covered)
        }
    }

    struct Supported: Decodable, Sendable {
        let raw: [String]?
        let buckets: [String]?
        let generic: Generic?
    }

    struct TypeState: Decodable, Sendable {
        let type: String
        let category: String?
        let enabled: Bool?
    }

    let connected: Bool?
    let paused: Bool?
    let storeId: String?
    let lastUploadAt: String?
    let coverage: Coverage?
    let types: [TypeState]?
    /// Categories switched on at the Mac; generic types belong to `other`.
    let categories: [String]?
    let supported: Supported?
}

/// `200` from `POST /api/v1/health/sync`.
struct HealthSyncResult: Decodable, Sendable {
    let accepted: Int?
    let inserted: Int?
    let deleted: Int?
    let rejected: Int?
    let storeId: String?
    let paused: Bool?
    let unsupported: Bool?
    let categoryDisabled: Bool?
    /// An object naming the pinned unit or agg: nothing was stored.
    let unitMismatch: HealthPresence?
    /// A generic call without a valid unit or agg: nothing was stored.
    let refused: HealthPresence?

    /// Whether the Mac took this call. Anything else keeps the anchor.
    var stored: Bool {
        paused != true && unsupported != true && categoryDisabled != true && unitMismatch == nil && refused == nil
    }
}

/// Decodes any JSON value that is not null; only its presence is read.
struct HealthPresence: Decodable, Sendable, Equatable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// What one sync call came back with, the cases the engine acts on.
enum HealthSyncReply: Sendable {
    case ok(HealthSyncResult)
    /// 409: the Mac's copy was deleted and re-created under this id.
    case storeMismatch(storeId: String?)
    /// 413: split the batch.
    case tooLarge
    /// 503 (or any 5xx): nothing stored, try again later.
    case unavailable
}

struct HealthSettingsResponse: Decodable, Sendable {
    let paused: Bool?
}

struct HealthDeleteResponse: Decodable, Sendable {
    let storeId: String?
    let paused: Bool?
    let removed: Int?
}

/// The four endpoints, as a seam the engine tests can fake.
protocol HealthSyncTransport: Sendable {
    func healthStatus(timeout: TimeInterval) async throws -> HealthStatusResponse
    func healthSync(body: Data, timeout: TimeInterval) async throws -> HealthSyncReply
    func healthSetPaused(_ paused: Bool) async throws -> HealthSettingsResponse
    func healthDeleteData() async throws -> HealthDeleteResponse
}

/// The real transport. Its own type because `HealthSyncTransport` is Sendable,
/// and a Sendable conformance has to be declared in the file of the type itself
/// (WalnutAPI holds only a URLSession, so sharing it across actors is safe).
struct WalnutHealthTransport: HealthSyncTransport {
    private let api: WalnutAPI

    init(api: WalnutAPI = WalnutAPI()) {
        self.api = api
    }

    func healthStatus(timeout: TimeInterval) async throws -> HealthStatusResponse {
        try await api.healthStatus(timeout: timeout)
    }

    func healthSync(body: Data, timeout: TimeInterval) async throws -> HealthSyncReply {
        try await api.healthSync(body: body, timeout: timeout)
    }

    func healthSetPaused(_ paused: Bool) async throws -> HealthSettingsResponse {
        try await api.healthSetPaused(paused)
    }

    func healthDeleteData() async throws -> HealthDeleteResponse {
        try await api.healthDeleteData()
    }
}

extension WalnutAPI {
    func healthStatus(timeout: TimeInterval = 30) async throws -> HealthStatusResponse {
        try await send("GET", "/health/status", body: nil as [String: String]?, timeout: timeout)
    }

    /// One batch. The body is built by `HealthBatcher` (already measured), so
    /// it is sent as bytes rather than re-encoded.
    ///
    /// retrySafe is false: not because a resend is unsafe (raw rows dedupe by
    /// uuid, buckets replace by key) but because the ENGINE is the retry owner
    /// and keeps the anchor until a 200; a transport retry would only stack a
    /// second slow request inside a background budget of seconds.
    func healthSync(body: Data, timeout: TimeInterval = 30) async throws -> HealthSyncReply {
        guard let base = AppConfig.serverURL, let token = AppConfig.token,
              let url = URL(string: base.absoluteString + "/api/v1/health/sync") else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await perform(request, retrySafe: false)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        switch http.statusCode {
        case 200...299:
            return .ok(try Self.decode(HealthSyncResult.self, data: data, response: response))
        case 409:
            struct Mismatch: Decodable { let storeId: String? }
            return .storeMismatch(storeId: (try? JSONDecoder().decode(Mismatch.self, from: data))?.storeId)
        case 413:
            return .tooLarge
        case 500...599:
            return .unavailable
        default:
            // 401 broadcast and the v1 error envelope, as every other call.
            _ = try Self.decode(HealthSyncResult.self, data: data, response: response)
            throw APIError.badResponse
        }
    }

    func healthSetPaused(_ paused: Bool) async throws -> HealthSettingsResponse {
        try await send("PUT", "/health/settings", body: ["paused": paused], timeout: 30)
    }

    /// Delete every health record on the Mac. The server rotates its store id
    /// and pauses syncing, so a phone that still has anchors gets a 409.
    func healthDeleteData() async throws -> HealthDeleteResponse {
        try await send("DELETE", "/health/data", body: [String: String](), timeout: 30)
    }
}
