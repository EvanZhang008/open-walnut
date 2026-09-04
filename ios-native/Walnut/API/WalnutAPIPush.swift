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

    /// What `GET /api/push/status` says about the box that SENDS.
    ///
    /// Every field is optional on purpose. An older primary answers this route
    /// without `registeredThisDevice` (and older ones still without `tokens`), and
    /// a decode failure there would read as "the server disagrees" — the one
    /// conclusion the app must never draw from a missing field.
    struct PushStatus: Decodable {
        /// True/false for the CALLING device by its bearer-key NAME (`ownedBy` in
        /// core/push/registry.ts); nil means the server never reported it. Only a
        /// fallback now: a name is not an identity for an anonymous LAN caller.
        let registeredThisDevice: Bool?
        /// Whether ANY device is registered on the sending box.
        let registered: Bool?
        let count: Int?
        let apns: APNsStatus?
        /// The rows the sending box holds. Present since the relay landed; this is
        /// what lets the phone recognise its OWN row rather than trusting a name.
        let tokens: [PushTokenRow]?
    }

    struct APNsStatus: Decodable {
        /// False = the row can be stored but nothing can be delivered (no key).
        let configured: Bool?
    }

    /// One stored row, reduced to the only field that identifies a device.
    ///
    /// The server never ships a full token (it is a send capability), so the row
    /// carries the first 12 characters plus a literal `"..."` (`tokenPrefix()` in
    /// core/push/send.ts, decorated in `pushRegistrationStatus`). The other fields
    /// are a human diagnostic and are deliberately left undecoded.
    struct PushTokenRow: Decodable {
        let tokenPrefix: String?

        enum CodingKeys: String, CodingKey {
            case tokenPrefix = "token_prefix"
        }
    }

    /// Ask the sending box what it holds for this device.
    ///
    /// On a replica the route is relayed to the primary, so the answer describes
    /// the primary's store, not the replica's.
    func pushStatus() async throws -> PushStatus {
        try await sendAbsolute("GET", "/api/push/status", body: nil as [String: String]?)
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
