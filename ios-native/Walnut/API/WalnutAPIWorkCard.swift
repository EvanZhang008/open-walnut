import Foundation

/// The lock-screen work card's two routes (src/web/routes/push.ts): what the card shows now,
/// and the card's own push token. Under `/api/push`, like the other push routes.
extension WalnutAPI {
    /// `GET /api/push/work-card` (src/core/push/work-card.ts WorkCardView).
    struct WorkCardView: Decodable, Equatable {
        struct Lists: Decodable, Equatable {
            var working: [String]
            var needs: [String]
            var completed: [String]

            func ids(_ list: WorkCardList) -> [String] {
                switch list {
                case .working: return working
                case .needs: return needs
                case .completed: return completed
                }
            }
        }
        var state: WorkCardAttributes.ContentState
        var lists: Lists
        /// A card should show: something works, or the last stopped a moment ago.
        var active: Bool
        /// The stretch's id: one card per stretch, and a card the user removed stays removed
        /// until the next stretch.
        var stretch: String?
        /// The server can keep the card current while the app is closed (it holds an APNs
        /// key). Absent from an older server: unknown.
        var pushes: Bool?
    }

    func workCard() async throws -> WorkCardView {
        try await sendAbsolute("GET", "/api/push/work-card", body: nil as [String: String]?, retrySafe: true)
    }

    struct WorkCardAck: Decodable { let ok: Bool?; let stored: Bool? }

    /// `POST /api/push/work-card`: the card's push token, or nil when the card ended here.
    @discardableResult
    func registerWorkCard(activityId: String, token: String?) async throws -> WorkCardAck {
        struct Body: Encodable {
            let activityId: String
            let token: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(activityId, forKey: .activityId)
                // `null` is the "ended" signal, so it is written out, never left off.
                try c.encode(token, forKey: .token)
            }
            enum CodingKeys: String, CodingKey { case activityId, token }
        }
        return try await sendAbsolute("POST", "/api/push/work-card", body: Body(activityId: activityId, token: token))
    }
}
