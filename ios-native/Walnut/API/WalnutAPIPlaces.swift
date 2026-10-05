import Foundation

// Places: the phone's half of `/api/v1/places/*` (docs/reference/api-v1.md,
// "Places"). Every call carries the device token; the server answers places
// only to this Mac and a paired phone.

/// What the phone tells the Mac about Places here: on or off, and how far iOS
/// lets Walnut use location (`always` is the only access iOS records visits with).
struct PlacesPhoneState: Codable, Equatable, Sendable {
    enum Access: String, Codable, Sendable {
        case always, whenInUse = "when_in_use", denied, notDetermined = "not_determined", restricted
    }

    var enabled: Bool
    var access: Access
}

/// `GET /api/v1/places/status`. Every field optional.
struct PlacesStatusResponse: Decodable, Sendable {
    let recording: Bool?
    let visitCount: Int?
    let firstVisitAt: String?
    let lastVisitAt: String?
    let lastUploadAt: String?
}

struct PlacesSyncResult: Decodable, Sendable {
    let accepted: Int?
    let inserted: Int?
    let updated: Int?
    let rejected: Int?
}

enum PlacesSyncReply: Sendable {
    case ok(PlacesSyncResult)
    /// 413: split the batch.
    case tooLarge
    /// 5xx: nothing stored, try again later.
    case unavailable
    /// 404: a Mac running a Walnut from before Places. Keep everything queued.
    case notSupported
}

struct PlacesDeleteResponse: Decodable, Sendable {
    let removed: Int?
}

protocol PlacesTransport: Sendable {
    func placesStatus(timeout: TimeInterval) async throws -> PlacesStatusResponse
    func placesSync(body: Data, timeout: TimeInterval) async throws -> PlacesSyncReply
    func placesDeleteData() async throws -> PlacesDeleteResponse
}

struct WalnutPlacesTransport: PlacesTransport {
    private let api: WalnutAPI

    init(api: WalnutAPI = WalnutAPI()) {
        self.api = api
    }

    func placesStatus(timeout: TimeInterval) async throws -> PlacesStatusResponse {
        try await api.send("GET", "/places/status", body: nil as [String: String]?, timeout: timeout)
    }

    /// retrySafe is false: the sync engine owns the retry and keeps the visits
    /// queued until a 200 (the Mac upserts by id, so a resend is harmless).
    func placesSync(body: Data, timeout: TimeInterval) async throws -> PlacesSyncReply {
        guard let base = AppConfig.serverURL, let token = AppConfig.token,
              let url = URL(string: base.absoluteString + "/api/v1/places/sync") else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await api.perform(request, retrySafe: false)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        switch http.statusCode {
        case 200...299:
            return .ok(try WalnutAPI.decode(PlacesSyncResult.self, data: data, response: response))
        case 404:
            return .notSupported
        case 413:
            return .tooLarge
        case 500...599:
            return .unavailable
        default:
            // 401 broadcast and the v1 error envelope, as every other call.
            _ = try WalnutAPI.decode(PlacesSyncResult.self, data: data, response: response)
            throw APIError.badResponse
        }
    }

    func placesDeleteData() async throws -> PlacesDeleteResponse {
        try await api.send("DELETE", "/places/data", body: [String: String](), timeout: 30)
    }
}
