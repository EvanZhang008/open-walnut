import Foundation

/// Push registration + notification-preference calls.
///
/// A new file rather than an addition to the Wave files, matching the
/// one-file-per-feature-slice convention (`WalnutAPIInbox.swift`).
///
/// These routes live under `/api/push`, NOT `/api/v1`, so they use
/// `sendAbsolute` — they predate the frozen v1 contract and are not part of it.
extension WalnutAPI {
    struct PushRegisterAck: Decodable {
        let ok: Bool
        /// The kind the server inferred from the token: `apns` or `expo`.
        let kind: String?
        let mode: String?
        /// False when the server accepted the token but has no APNs credential —
        /// the difference between "not registered" and "registered but the
        /// server can't send", which is otherwise invisible.
        let deliverable: Bool?
    }

    /// Register this device's APNs token.
    @discardableResult
    func registerPushToken(
        token: String,
        environment: String,
        mode: String
    ) async throws -> PushRegisterAck {
        struct Body: Encodable {
            let token: String
            let platform: String
            let environment: String
            let mode: String
        }
        return try await sendAbsolute(
            "POST", "/api/push/register",
            body: Body(token: token, platform: "ios", environment: environment, mode: mode)
        )
    }

    /// Set this device's letter-notification mode (`always` / `when-inactive`).
    func setPushPreferences(mode: String, letterTypes: [String]? = nil) async throws {
        struct Body: Encodable {
            let mode: String
            let letterTypes: [String]?
        }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await sendAbsolute(
            "POST", "/api/push/preferences",
            body: Body(mode: mode, letterTypes: letterTypes)
        )
    }

    /// Report whether this app is on screen. Only read by the server in
    /// `when-inactive` mode, and treated there as a short lease.
    func reportPushActive(_ active: Bool) async throws {
        struct Body: Encodable { let active: Bool }
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await sendAbsolute("POST", "/api/push/active", body: Body(active: active))
    }
}
